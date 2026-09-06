//! The `polymorph:stream-dom` `producer` world implementation: mount the app,
//! pump the Dioxus scheduler, and dispatch DOM events back into it.
//!
//! Ported from polyengine-dioxus's `src/driver.rs`; its module doc is the
//! long-form version of everything below and still applies verbatim except
//! where the transport changed. What is different here: the outgoing channel
//! is `stream<u8>` of encoded `Frame`s rather than a typed operation stream,
//! so the staged-write bookkeeping lives in
//! [`stream_dom_guest::channel`] instead of in this module, and [`flush`] is
//! two lines. Dropped entirely: hydration, and the `document` / `history` /
//! `eval` providers.
//!
//! # Why the VirtualDom lives in a thread-local
//!
//! The scheduler task `run` spawns and every `handle-event` export task live
//! in the same single-threaded component instance, and both need the
//! VirtualDom: the scheduler to wait for and render scheduler work,
//! `handle-event` to dispatch and then flush the render the handler just
//! caused. So neither task may hold a borrow of the VirtualDom across an
//! await. The scheduler's wait is therefore a `poll_fn` that constructs a
//! fresh `wait_for_work()` future on every poll and drops the borrow before
//! returning `Pending`; dioxus documents `wait_for_work` as cancel-safe
//! ("you're fine to discard the future in a select block",
//! dioxus-core-0.7.10/src/virtual_dom.rs:433), which is exactly the property
//! this needs.
//!
//! # Why `run` returns immediately and spawns the scheduler
//!
//! `run` is `async func(hydrate: bool) -> stream<u8>`: the receiver awaits
//! its promise to obtain the read end, then reads from it. Under the
//! component-model async ABI, an async export's Rust body *returning* is
//! task.return followed by task exit — so the scheduler cannot live in
//! `run`'s own body. Instead `run` opens the channel, spawns the
//! mount-and-serve task, and returns the reader.
//!
//! Ordering is safe by rendezvous: the spawned task's first write parks until
//! the receiver actually reads, so nothing is lost if it runs before the
//! receiver is reading. The converse would deadlock, which is why `run`'s own
//! body must not write anything before returning the reader.
//!
//! All driver state is installed before `run` returns, so a `handle-event`
//! arriving immediately after the return finds consistent state.
//!
//! # Why the scheduler may park forever
//!
//! The scheduler task's wait between renders is a plain Rust future woken
//! cross-task, with no WIT waitable pending. It is legal because the receiver
//! retains the readable end of the mutation stream for the instance's
//! lifetime (wit/stream-dom.wit, `run`'s doc: "a parked scheduler is then a
//! documented idle state, not a deadlock").

use std::cell::RefCell;
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::task::Context;

use dioxus_core::{Element, Event, Runtime, VirtualDom};
use dioxus_core_types::event_bubbles;
use dioxus_html::PlatformEventData;
use stream_dom_guest::{channel, Interner, NodeId, StrRef};
use wit_bindgen::rt::async_support::{spawn_local, StreamReader};

use crate::events::{StreamEventConverter, StreamEventData};
use crate::writer::MutationWriter;
use stream_dom_guest::bindings::DomEvent;

/// The read end of the mutation channel: what `run` hands back. Named here so
/// [`crate::launch!`] can spell the export's return type without the app
/// crate naming wit-bindgen's runtime module.
pub type MutationStream = StreamReader<u8>;

thread_local! {
    static VDOM: RefCell<Option<VirtualDom>> = const { RefCell::new(None) };
    static WRITER: RefCell<Option<MutationWriter>> = const { RefCell::new(None) };
    /// Kept separately from `VDOM` so event dispatch never has to borrow the
    /// VirtualDom itself (`Runtime::handle_event` only needs the runtime).
    static RUNTIME: RefCell<Option<Rc<Runtime>>> = const { RefCell::new(None) };
    /// Reverse `str-ref -> &str` lookup for `handle-event` names. Shares
    /// storage with the writer's forward map.
    static INTERNER: RefCell<Option<Rc<RefCell<Interner>>>> = const { RefCell::new(None) };
}

/// Push the current batch, if any, to the receiver: one batch is one
/// `channel::send`.
async fn flush() {
    let bytes = WRITER.with_borrow_mut(|w| {
        w.as_mut()
            .expect("driver: writer not initialized")
            .batch
            .finish()
    });
    if let Some(bytes) = bytes {
        channel::send(bytes).await;
    }
}

/// Await the next scheduler wakeup without holding a borrow of the VirtualDom
/// across the await point. See the module doc for why this is sound.
fn wait_for_work() -> impl Future<Output = ()> {
    std::future::poll_fn(|cx: &mut Context<'_>| {
        VDOM.with_borrow_mut(|dom| {
            let dom = dom.as_mut().expect("driver: vdom not initialized");
            let fut = dom.wait_for_work();
            let mut fut = std::pin::pin!(fut);
            Pin::new(&mut fut).poll(cx)
        })
    })
}

/// Run one render step with both thread-locals borrowed, and nothing awaited
/// in between.
fn render(step: impl FnOnce(&mut VirtualDom, &mut MutationWriter)) {
    VDOM.with_borrow_mut(|dom| {
        WRITER.with_borrow_mut(|w| {
            let dom = dom.as_mut().expect("driver: vdom not initialized");
            let w = w.as_mut().expect("driver: writer not initialized");
            step(dom, w);
        })
    })
}

/// Implementation of the world's `run` export.
///
/// Installs the event converter, builds the VirtualDom, opens the channel,
/// spawns the mount-and-serve task (`rebuild` → one batch, then the scheduler
/// forever), and returns the stream's read end.
pub async fn run(root: fn() -> Element, hydrate: bool) -> MutationStream {
    assert!(!hydrate, "hydration not supported in this spike");

    // dioxus-html's converter slot is global and write-once per process; a
    // component instance is a fresh process image, so this runs exactly once.
    dioxus_html::set_event_converter(Box::new(StreamEventConverter));

    let dom = VirtualDom::new(root);
    let interner = Rc::new(RefCell::new(Interner::new()));
    RUNTIME.set(Some(dom.runtime()));
    INTERNER.set(Some(interner.clone()));
    VDOM.set(Some(dom));
    WRITER.set(Some(MutationWriter::new(interner)));

    let reader = channel::open();

    spawn_local(async move {
        render(|dom, w| dom.rebuild(w));
        flush().await;

        // The persistent park here is legal because the receiver retains the
        // readable end of this stream — see the module doc.
        loop {
            wait_for_work().await;
            render(|dom, w| dom.render_immediate(w));
            flush().await;
        }
    });

    reader
}

/// Implementation of the world's `handle-event` export.
///
/// Dispatch is synchronous (Dioxus's synthetic bubbling included). Afterwards
/// we render and flush whatever the handlers dirtied, then — still before
/// returning, i.e. still inside the receiver's DOM listener frame — call
/// `ev.prevent-default()` if a handler asked for it.
pub async fn handle_event(target: NodeId, name: StrRef, payload: Vec<u8>, ev: &DomEvent) {
    if channel::is_dead() {
        return;
    }
    // The receiver cannot have a listener registration before `run` mounted
    // the app, but a defensive early return beats a trap if it ever races.
    let Some(interner) = INTERNER.with_borrow(|i| i.clone()) else {
        return;
    };
    let Some(runtime) = RUNTIME.with_borrow(|r| r.clone()) else {
        return;
    };

    let Some(name) = interner.borrow().resolve(name).map(str::to_string) else {
        // A slot we never interned. The receiver only ever echoes back slots
        // we sent, so this is a bug signal in debug and a dropped event in
        // release.
        debug_assert!(
            false,
            "handle-event: unknown interned event name slot {name}"
        );
        return;
    };

    // Node ids are never reused, so an id we no longer know is a node that
    // was removed — proto/stream-dom.proto's file header: "An event for an
    // unknown id is dropped." This is ordinary operation, not a bug signal,
    // and it is reachable without any worker or network in between: removing
    // a focused `<input>` fires `blur`, which the receiver's dispatch gate
    // queues and delivers after the `Remove` has been applied. Dropping
    // silently is the whole point of never reusing ids.
    let Some(element) = WRITER.with_borrow(|w| w.as_ref().and_then(|w| w.element_of(target)))
    else {
        return;
    };

    let Ok(payload) = stream_dom_guest::decode_event(&payload) else {
        debug_assert!(false, "handle-event: undecodable payload");
        return;
    };

    // `Event`'s metadata is shared by `Rc` through `into_any`, so the clone we
    // keep observes `prevent_default()` calls made on the copy the handlers
    // saw.
    let event = Event::new(
        Rc::new(PlatformEventData::new(Box::new(StreamEventData::new(
            payload,
        )))),
        event_bubbles(&name),
    );
    runtime.handle_event(&name, event.clone().into_any(), element);

    // Dioxus requires prevent_default to be observed before the handler's
    // first await; the borrow of `ev` never crosses one either (this call is
    // synchronous and the flush below is what may yield).
    if !event.default_action_enabled() {
        ev.prevent_default();
    }

    render(|dom, w| dom.render_immediate(w));
    flush().await;
}
