//! The `polymorph:stream-dom` `producer` world implementation: mount the
//! app, coalesce the signal-driven mutations into batches, and dispatch
//! DOM events back into the fake DOM.
//!
//! # Why `run` returns before anything is written
//!
//! `run` is `async func(hydrate: bool) -> stream<u8>`: the receiver awaits
//! its promise to get the read end, then reads. Under the component-model
//! async ABI an async export's body *returning* is task.return followed by
//! task exit, so the producer cannot live in `run`'s body. `run` opens the
//! channel, spawns the mount-and-serve task, and returns the reader.
//!
//! Ordering is safe by rendezvous: the spawned task's first write parks
//! until the receiver actually reads. The converse would deadlock, which
//! is why nothing — not even the initial mount's flush — may be written
//! before `run` returns. This is the same rule, for the same reason, as
//! `crates/stream-dom-dioxus/src/driver.rs`; read its module doc for the
//! long form.
//!
//! # Why the flusher may park forever
//!
//! Between batches the flusher task waits on a plain Rust waker with no
//! WIT waitable pending. That is legal because the receiver retains the
//! readable end for the instance's lifetime (wit/stream-dom.wit, `run`:
//! "a parked scheduler is then a documented idle state, not a deadlock").
//!
//! # Batch boundaries
//!
//! Dominator is fine-grained: every signal writes straight to the DOM as
//! it fires. The flusher is what turns that into batches — one `commit`
//! per wakeup, i.e. per drained round of signal work, which is exactly the
//! "whatever flushed in this microtask" boundary docs/design.md
//! ("Fine-grained producers ...") predicts for this class of framework.

use std::future::poll_fn;
use std::rc::Rc;
use std::task::Poll;

use stream_dom_guest::bindings::{queries, DomEvent, EventTarget};
use stream_dom_guest::{channel, StrRef};
use wit_bindgen::rt::async_support::{spawn_local, StreamReader};

use crate::dom::{self, Effect};
use crate::event::{self, Target, Verdict};

/// The read end of the mutation channel: what `run` hands back. Named here
/// so [`crate::launch!`] can spell the export's return type without the
/// app crate naming wit-bindgen's runtime module.
pub type MutationStream = StreamReader<u8>;

/// Send the current batch, then run the effects it queued.
///
/// Effects go *after* the send because they name nodes the receiver only
/// has once the batch is applied — `set-focus` on an element created in
/// this very batch is the case.
async fn flush() {
    if let Some(bytes) = dom::take_batch() {
        channel::send(bytes).await;
    }
    for effect in dom::take_effects() {
        match effect {
            Effect::Focus(id, focus) => {
                queries::set_focus(id, focus).await;
            }
        }
    }
}

/// Park until some mutation calls `dom::request_flush`.
async fn wait_dirty() {
    poll_fn(|cx| {
        if dom::take_dirty(cx.waker()) {
            Poll::Ready(())
        } else {
            Poll::Pending
        }
    })
    .await;
}

/// Implementation of the world's `run` export.
pub async fn run(mount: fn(), hydrate: bool) -> MutationStream {
    assert!(!hydrate, "hydration not supported in this spike");

    let reader = channel::open();

    // Before anything else: `web_sys::window()` reads `globalThis`, and
    // the app's first line is normally exactly that.
    dom::install();

    spawn_local(async move {
        // The mount itself runs here, not in `run`'s body: it writes.
        mount();
        flush().await;

        loop {
            wait_dirty().await;
            flush().await;
        }
    });

    reader
}

/// Implementation of the world's `handle-event` export.
///
/// Dispatch (including the fake's own capture/bubble walk) is synchronous.
/// The imperative verdict is forwarded immediately afterwards — still
/// before the first await, i.e. still inside the receiver's DOM listener
/// frame — and only then are the handlers' mutations flushed.
pub async fn handle_event(target: EventTarget, name: StrRef, payload: Vec<u8>, ev: &DomEvent) {
    if channel::is_dead() {
        return;
    }

    let Some(name) = dom::resolve_name(name) else {
        // The receiver only echoes back slots this producer sent, so an
        // unknown slot is a bug signal in debug and a dropped event in
        // release.
        debug_assert!(false, "handle-event: unknown interned event name slot");
        return;
    };

    let Ok(payload) = stream_dom_guest::decode_event(&payload) else {
        debug_assert!(false, "handle-event: undecodable payload");
        return;
    };

    let target = match target {
        EventTarget::Node(id) => Target::Node(id),
        EventTarget::Window => Target::Window,
        EventTarget::Document => Target::Document,
    };

    let verdict = Rc::new(Verdict::default());
    if !event::dispatch(target, &name, payload, verdict.clone()) {
        // Unknown target: a removed node racing an event already in
        // flight. proto/stream-dom.proto: "An event for an unknown id is
        // dropped."
        return;
    }

    if verdict.default_prevented() {
        ev.prevent_default();
    }
    if verdict.propagation_stopped() {
        ev.stop_propagation();
    }

    flush().await;
}
