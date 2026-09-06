//! One component instance: a store, a tokio task owning it, and the handle
//! the embedder drives it through.

use std::sync::Arc;

use anyhow::{anyhow, Result};
use tokio::sync::{mpsc, oneshot, watch};
use wasmtime::component::{Component, Resource};
use wasmtime::Store;

use crate::bindings::{stream_dom, ProducerBindings};
use crate::consumer::AckConsumer;
use crate::{Ctx, DomEvent, Host, HostBridge};

/// What a listener was registered on. Mirrors the WIT `event-target`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventTarget {
    Node(u32),
    Window,
    Document,
}

impl From<EventTarget> for stream_dom::types::EventTarget {
    fn from(t: EventTarget) -> Self {
        match t {
            EventTarget::Node(id) => Self::Node(id),
            EventTarget::Window => Self::Window,
            EventTarget::Document => Self::Document,
        }
    }
}

/// A command to the actor. `Shutdown` is explicit rather than "drop the
/// sender" because [`Producer::shutdown`] must be callable through a shared
/// handle and must be able to wait for the teardown it asked for.
enum Cmd {
    Dispatch(Dispatch),
    Shutdown,
}

/// One event dispatch, with the channel its completion is reported on.
struct Dispatch {
    target: EventTarget,
    name: u32,
    payload: Vec<u8>,
    done: oneshot::Sender<Result<(), Arc<anyhow::Error>>>,
}

/// A live producer.
///
/// The instance itself lives on a tokio task — a `Store` is `Send` but not
/// `Sync`, and the store must stay available to the event loop between
/// calls, so it is owned by an actor rather than shared behind a lock.
pub struct Producer {
    events: mpsc::UnboundedSender<Cmd>,
    /// `None` until the actor finishes; then the outcome, once.
    death: watch::Receiver<Option<Result<(), Arc<anyhow::Error>>>>,
}

impl Producer {
    /// Instantiate `component` and call `run(false)`, piping the returned
    /// stream to `bridge`.
    ///
    /// Returns once `run` has returned its stream — that is, as soon as the
    /// channel exists, which is strictly before the first
    /// [`HostBridge::apply`] resolves and usually before the first one
    /// starts. A caller may therefore dispatch events immediately; they
    /// queue behind the instance lock like any other export call.
    pub async fn spawn(
        host: &Host,
        component: &Component,
        bridge: Arc<dyn HostBridge>,
    ) -> Result<Self> {
        let (events, event_rx) = mpsc::unbounded_channel();
        let (ready_tx, ready_rx) = oneshot::channel();
        let (death_tx, death) = watch::channel(None);

        let engine = host.engine.clone();
        let linker = host.linker.clone();
        let component = component.clone();
        let limits = host.limits;

        tokio::spawn(async move {
            let mut store = Store::new(&engine, Ctx::new(bridge, &limits));
            store.limiter(Ctx::limiter);
            // Yield to the executor on every epoch tick rather than trap:
            // a producer that renders for a long time is doing its job, it
            // just must not monopolize the runtime while doing it.
            store.set_epoch_deadline(1);
            store.epoch_deadline_async_yield_and_update(1);

            let outcome = run_instance(&mut store, &linker, &component, event_rx, ready_tx).await;
            let _ = death_tx.send(Some(outcome.map_err(Arc::new)));
        });

        match ready_rx.await {
            Ok(()) => Ok(Self { events, death }),
            // The actor died before `run` returned; report why rather than
            // "the channel closed".
            Err(_) => {
                let mut death = death;
                let cause = wait_death(&mut death).await;
                Err(match cause {
                    Err(e) => anyhow!("producer failed to start: {e:#}"),
                    Ok(()) => anyhow!("producer stopped before `run` returned"),
                })
            }
        }
    }

    /// Dispatch one event and resolve when the guest's handler has
    /// returned.
    ///
    /// Dispatches are serialized: the actor awaits each `handle-event`
    /// before taking the next. The instance's exclusive lock would serialize
    /// them at the backpressure gate anyway, and doing it here keeps them in
    /// the order the receiver observed them.
    pub async fn handle_event(
        &self,
        target: EventTarget,
        name: u32,
        payload: Vec<u8>,
    ) -> Result<()> {
        let (done, wait) = oneshot::channel();
        self.events
            .send(Cmd::Dispatch(Dispatch {
                target,
                name,
                payload,
                done,
            }))
            .map_err(|_| anyhow!("producer is dead"))?;
        match wait.await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => Err(anyhow!("{e:#}")),
            Err(_) => Err(anyhow!("producer died during dispatch")),
        }
    }

    /// Tear the producer down, returning once it has stopped. Idempotent:
    /// on an already-dead producer the send fails and the recorded outcome
    /// is already there.
    ///
    /// Ending the actor's loop returns from the store's concurrent scope and
    /// drops the store, which is the only way wasmtime 47 offers to cancel
    /// guest tasks still in flight (`Func::call_concurrent`, "Cancellation").
    pub async fn shutdown(&self) {
        let _ = self.events.send(Cmd::Shutdown);
        let mut death = self.death.clone();
        let _ = wait_death(&mut death).await;
    }

    /// Resolve when the producer stops: `Ok` for an orderly shutdown, `Err`
    /// with the cause for a trap, a failed `apply`, or an exhausted memory
    /// limit. The embedder reports the cause to its receiver.
    pub async fn closed(&self) -> Result<(), Arc<anyhow::Error>> {
        let mut death = self.death.clone();
        wait_death(&mut death).await
    }
}

async fn wait_death(
    death: &mut watch::Receiver<Option<Result<(), Arc<anyhow::Error>>>>,
) -> Result<(), Arc<anyhow::Error>> {
    loop {
        if let Some(outcome) = death.borrow_and_update().clone() {
            return outcome;
        }
        if death.changed().await.is_err() {
            // The actor task was cancelled without recording an outcome.
            return Err(Arc::new(anyhow!("producer task ended unexpectedly")));
        }
    }
}

/// The actor body: instantiate, start the stream, then serve dispatches
/// until the handle goes away.
async fn run_instance(
    store: &mut Store<Ctx>,
    linker: &wasmtime::component::Linker<Ctx>,
    component: &Component,
    mut events: mpsc::UnboundedReceiver<Cmd>,
    ready: oneshot::Sender<()>,
) -> Result<()> {
    // Instantiation is outside the concurrent scope because it needs the
    // store itself, and `Accessor` only lends it a synchronous view.
    let bindings = ProducerBindings::instantiate_async(&mut *store, component, linker).await?;

    store
        .run_concurrent(async move |accessor| -> Result<()> {
            // `hydrate: false` — this tier mounts into an empty root; a
            // prerendered one would be the embedder's choice to expose.
            let stream = bindings.call_run(accessor, false).await?;
            let bridge = accessor.with(|mut access| access.get().bridge.clone());
            accessor.with(|access| stream.pipe(access, AckConsumer::new(bridge)))?;

            // From here the stream is live: the event loop polls the
            // consumer while this task waits on dispatches.
            let _ = ready.send(());

            // Ends on `Shutdown` or when the last handle drops: either way
            // the scope returns and the store is dropped by the caller.
            while let Some(cmd) = events.recv().await {
                let dispatch = match cmd {
                    Cmd::Dispatch(d) => d,
                    Cmd::Shutdown => break,
                };
                let result = dispatch_event(accessor, &bindings, &dispatch).await;
                match result {
                    Ok(()) => {
                        let _ = dispatch.done.send(Ok(()));
                    }
                    Err(e) => {
                        // A trapped handler kills the instance; the caller
                        // waiting on this dispatch and `closed()` both get
                        // the same cause.
                        let e = Arc::new(e);
                        let _ = dispatch.done.send(Err(e.clone()));
                        return Err(anyhow!("{e:#}"));
                    }
                }
            }
            Ok(())
        })
        .await?
}

async fn dispatch_event(
    accessor: &wasmtime::component::Accessor<Ctx>,
    bindings: &ProducerBindings,
    dispatch: &Dispatch,
) -> Result<()> {
    // The resource exists for exactly one dispatch: the WIT lends it to the
    // handler's synchronous prefix, and nothing may name it afterwards.
    let owned = accessor.with(|mut access| access.get().table.push(DomEvent))?;
    let borrow = Resource::new_borrow(owned.rep());

    let result = bindings
        .call_handle_event(
            accessor,
            dispatch.target.into(),
            dispatch.name,
            dispatch.payload.clone(),
            borrow,
        )
        .await;

    // Deleted whether or not the call succeeded: a trap leaves the table
    // entry behind otherwise, and the store may outlive the failed call.
    let deleted = accessor.with(|mut access| access.get().table.delete(owned));
    result?;
    deleted?;
    Ok(())
}
