//! The read end of a producer's mutation stream, gated on the receiver's ack.

use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use wasmtime::component::{Source, StreamConsumer, StreamResult};
use wasmtime::StoreContextMut;

use crate::{Ctx, HostBridge};

/// Forwards each guest write to [`HostBridge::apply`] and withholds the
/// write's completion until the receiver has applied it.
///
/// The mechanism is the one `StreamConsumer::poll_consume` documents under
/// "Backpressure": take the items, then return `Poll::Pending`, which tells
/// wasmtime to delay the `COMPLETED` event to the writer. The guest's
/// `stream.write` therefore does not resolve until `apply` does — the strict
/// rendezvous [`HostBridge::apply`] promises.
pub(crate) struct AckConsumer {
    bridge: Arc<dyn HostBridge>,
    /// The `apply` call for the bytes already taken out of `source`. Held
    /// across polls: once taken, bytes cannot be put back, so the only
    /// correct thing to do is finish delivering them.
    inflight: Option<crate::BoxFuture<'static, anyhow::Result<()>>>,
}

impl AckConsumer {
    pub(crate) fn new(bridge: Arc<dyn HostBridge>) -> Self {
        Self {
            bridge,
            inflight: None,
        }
    }
}

impl StreamConsumer<Ctx> for AckConsumer {
    type Item = u8;

    fn poll_consume(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        store: StoreContextMut<Ctx>,
        source: Source<'_, u8>,
        finish: bool,
    ) -> Poll<wasmtime::Result<StreamResult>> {
        let this = self.get_mut(); // safe: AckConsumer is Unpin

        // An apply from a previous poll is still running. Finish it before
        // looking at `source` — the bytes it carries are already taken, and
        // `finish` does not change that: with no out-of-band channel to
        // report a partial application, interrupting delivery would leave
        // the receiver's DOM in a state no one can describe. `poll_consume`'s
        // docs name this the usually-preferable choice.
        if let Some(fut) = this.inflight.as_mut() {
            return match fut.as_mut().poll(cx) {
                Poll::Pending => Poll::Pending,
                Poll::Ready(result) => {
                    this.inflight = None;
                    // An apply error is unrecoverable at this level: there
                    // is no `future` in the WIT to report it on, so trap.
                    Poll::Ready(trap(result))
                }
            };
        }

        let mut direct = source.as_direct(store);
        // One `poll_consume` call is one guest write, and `remaining` is
        // that whole write's buffer: taking all of it keeps the guest's
        // one-write-per-batch framing intact end to end. Splitting would
        // hand the receiver a partial batch; merging is impossible here
        // anyway, since a second write cannot start until this one
        // completes.
        let chunk = direct.remaining().to_vec();
        if chunk.is_empty() {
            return if finish {
                // Nothing taken and the writer is cancelling: the only
                // result allowed without taking an item.
                Poll::Ready(Ok(StreamResult::Cancelled))
            } else {
                // A zero-length write is a legal readiness probe. Reporting
                // it consumed is correct because the next call can always
                // accept an item; returning `Pending` would park forever,
                // as nothing external would ever wake this task.
                Poll::Ready(Ok(StreamResult::Completed))
            };
        }
        direct.mark_read(chunk.len());

        let mut fut = this.bridge_apply(chunk);
        match fut.as_mut().poll(cx) {
            Poll::Pending => {
                this.inflight = Some(fut);
                Poll::Pending
            }
            Poll::Ready(result) => Poll::Ready(trap(result)),
        }
    }
}

/// A failed `apply` becomes a wasmtime trap: the guest's DOM and the
/// receiver's have diverged, and no WIT signature can carry the news back.
fn trap(result: anyhow::Result<()>) -> wasmtime::Result<StreamResult> {
    result
        .map(|()| StreamResult::Completed)
        .map_err(wasmtime::Error::from_anyhow)
}

impl AckConsumer {
    fn bridge_apply(&self, chunk: Vec<u8>) -> crate::BoxFuture<'static, anyhow::Result<()>> {
        let bridge = self.bridge.clone();
        Box::pin(async move { bridge.apply(chunk).await })
    }
}
