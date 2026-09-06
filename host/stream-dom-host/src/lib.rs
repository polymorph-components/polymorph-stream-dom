//! Wasmtime host for `polymorph:stream-dom` producers.
//!
//! One [`Host`] per process owns the engine and a linker that satisfies the
//! `producer` world (`queries`, the `dom-event` resource) plus WASI p2. Each
//! [`Producer`] is one component instance in its own [`Store`], running on
//! its own tokio task, whose mutation stream is forwarded chunk by chunk to
//! a [`HostBridge`] — the receiver as the host sees it, implemented by an
//! embedder (a Tauri layer talking to a webview) and by tests.
//!
//! See `docs/design.md` for the protocol; this crate is the "in-process
//! (component)" column of its Transports table, with the receiver one hop
//! further out than the table assumes.

mod bindings;
mod consumer;
mod producer;

use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use wasmtime::component::{Accessor, HasData, Linker, ResourceTable};
use wasmtime::{Config, Engine, StoreLimits, StoreLimitsBuilder};
use wasmtime_wasi::{WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};

pub use producer::{EventTarget, Producer};
pub use wasmtime::component::Component;

/// A DOM rect, flattened from the WIT's `rect { origin, size }`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

/// The receiver side, as the host sees it.
///
/// Every method is a host import the guest may sync-lower and block on, so
/// an implementation is free to take as long as a round trip to a webview
/// costs — see `docs/design.md` "Reads are `async`-typed host imports".
///
/// Boxed futures rather than `async fn` in trait: this is used as
/// `Arc<dyn HostBridge>`, and async-fn-in-trait is not object safe.
pub trait HostBridge: Send + Sync + 'static {
    /// Deliver one chunk of stream bytes — one guest write, normally one
    /// batch — and return once the receiver has **applied** it.
    ///
    /// This is a strict rendezvous: the guest's `stream.write` does not
    /// complete until this future resolves, so the guest can never run
    /// ahead of the DOM. `docs/design.md` "Batches are framed by a `commit`
    /// flag" makes this an invariant rather than a nicety — queries observe
    /// every committed batch, which is only true if application is ordered
    /// before the write that follows it.
    ///
    /// An `Err` traps the guest: the producer dies and [`Producer::closed`]
    /// resolves with the cause.
    fn apply(&self, chunk: Vec<u8>) -> BoxFuture<'_, Result<()>>;

    fn get_client_rect(&self, target: u32) -> BoxFuture<'_, Option<Rect>>;
    fn get_scroll_offset(&self, target: u32) -> BoxFuture<'_, Option<Point>>;
    fn get_scroll_size(&self, target: u32) -> BoxFuture<'_, Option<Size>>;
    fn set_focus(&self, target: u32, focus: bool) -> BoxFuture<'_, bool>;
}

/// The future type [`HostBridge`] methods return. `Send` because a
/// producer's store runs on a tokio task.
pub type BoxFuture<'a, T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;

/// Per-producer resource bounds.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// Cap on a producer's linear memory. Exceeding it traps the guest,
    /// which surfaces through [`Producer::closed`].
    pub memory_bytes: usize,
    /// How often the engine's epoch advances. Each tick makes a running
    /// guest yield to the tokio executor once, so one producer spinning in
    /// a render loop cannot starve the others sharing the runtime.
    pub epoch_tick: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            memory_bytes: 64 * 1024 * 1024,
            epoch_tick: Duration::from_millis(10),
        }
    }
}

/// The host-defined `dom-event` resource.
///
/// Deliberately stateless: `prevent-default` and `stop-propagation` are
/// no-ops here. This tier's receiver is a webview one hop away, so the
/// guest's synchronous prefix cannot land an imperative verdict inside the
/// browser's listener — only the declarative flags on `add-listener` can
/// cross that boundary (`docs/design.md` "Events", option C). Accepting the
/// calls and ignoring them is what keeps a producer written against option
/// A running unmodified.
pub struct DomEvent;

/// Engine, linker and limits shared by every producer in the process.
///
/// Compilation is expensive and per-process; instantiation is per-producer.
pub struct Host {
    engine: Engine,
    linker: Arc<Linker<Ctx>>,
    limits: Limits,
    /// Aborts the epoch ticker when the host goes away.
    ticker: tokio::task::JoinHandle<()>,
}

impl Drop for Host {
    fn drop(&mut self) {
        self.ticker.abort();
    }
}

impl Host {
    /// Build the engine and linker.
    ///
    /// Must be called from within a tokio runtime: the epoch ticker is a
    /// spawned task, tied to this host's lifetime.
    pub fn new(limits: Limits) -> Result<Self> {
        let mut config = Config::new();
        // The producer world is async through and through: `run` returns a
        // `stream<u8>` and `handle-event` runs concurrently with it.
        // (`Config::async_support` is deprecated and a no-op in wasmtime 47:
        // async is implied by the `async` cargo feature.)
        config.wasm_component_model_async(true);
        // Required by `run_concurrent`, `call_concurrent` and `StreamReader`.
        config.concurrency_support(true);
        // Preemption for the cooperative scheduler: see `Limits::epoch_tick`.
        config.epoch_interruption(true);

        let engine = Engine::new(&config)?;

        let mut linker = Linker::new(&engine);
        wasmtime_wasi::p2::add_to_linker_async(&mut linker)?;
        // Defines `queries` whether or not a given component imports it: a
        // component that never calls a read has the import stripped, and a
        // linker definition nothing imports is simply unused.
        bindings::ProducerBindings::add_to_linker::<Ctx, HasCtx>(&mut linker, |ctx| ctx)?;

        let ticker = {
            let engine = engine.clone();
            let tick = limits.epoch_tick;
            tokio::spawn(async move {
                let mut interval = tokio::time::interval(tick);
                loop {
                    interval.tick().await;
                    engine.increment_epoch();
                }
            })
        };

        Ok(Self {
            engine,
            linker: Arc::new(linker),
            limits,
            ticker,
        })
    }

    /// Compile a component. The result is `Send + Sync` and may be
    /// instantiated into any number of producers.
    pub fn compile(&self, wasm: &[u8]) -> Result<Component> {
        Ok(Component::new(&self.engine, wasm)?)
    }
}

/// Per-store state: WASI, the resource table the `dom-event` resources live
/// in, the bridge every host import forwards to, and the memory limiter.
pub(crate) struct Ctx {
    wasi: WasiCtx,
    table: ResourceTable,
    bridge: Arc<dyn HostBridge>,
    limits: StoreLimits,
}

impl Ctx {
    fn new(bridge: Arc<dyn HostBridge>, limits: &Limits) -> Self {
        Self {
            // No preopens, no network, no env, no args: a producer needs a
            // clock and randomness, nothing else.
            wasi: WasiCtxBuilder::new()
                .stdout(LogSink::new("stdout"))
                .stderr(LogSink::new("stderr"))
                .build(),
            table: ResourceTable::new(),
            bridge,
            limits: StoreLimitsBuilder::new()
                .memory_size(limits.memory_bytes)
                // A component is many core module instances (the adapter,
                // the guest, wit-bindgen's shims); these are headroom
                // against a pathological one, not a tuned figure.
                .instances(64)
                .tables(64)
                .build(),
        }
    }

    /// The store's memory limiter. `Store::limiter` wants a trait object.
    pub(crate) fn limiter(&mut self) -> &mut dyn wasmtime::ResourceLimiter {
        &mut self.limits
    }
}

impl WasiView for Ctx {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

/// `HasData` marker tying the generated host traits to [`Ctx`].
pub(crate) struct HasCtx;

impl HasData for HasCtx {
    type Data<'a> = &'a mut Ctx;
}

/// Pull the bridge out of the store so the await happens without holding
/// store access — a query may block for a webview round trip, and the store
/// must stay available to the rest of the instance meanwhile.
fn bridge(accessor: &Accessor<Ctx, HasCtx>) -> Arc<dyn HostBridge> {
    accessor.with(|mut access| access.get().bridge.clone())
}

impl bindings::stream_dom::types::Host for Ctx {}

impl bindings::stream_dom::queries::HostWithStore<Ctx> for HasCtx {
    async fn get_client_rect(
        accessor: &Accessor<Ctx, Self>,
        target: u32,
    ) -> wasmtime::Result<Option<bindings::stream_dom::queries::Rect>> {
        Ok(bridge(accessor).get_client_rect(target).await.map(|r| {
            bindings::stream_dom::queries::Rect {
                origin: bindings::stream_dom::queries::Point { x: r.x, y: r.y },
                size: bindings::stream_dom::queries::Size {
                    width: r.width,
                    height: r.height,
                },
            }
        }))
    }

    async fn get_scroll_offset(
        accessor: &Accessor<Ctx, Self>,
        target: u32,
    ) -> wasmtime::Result<Option<bindings::stream_dom::queries::Point>> {
        Ok(bridge(accessor)
            .get_scroll_offset(target)
            .await
            .map(|p| bindings::stream_dom::queries::Point { x: p.x, y: p.y }))
    }

    async fn get_scroll_size(
        accessor: &Accessor<Ctx, Self>,
        target: u32,
    ) -> wasmtime::Result<Option<bindings::stream_dom::queries::Size>> {
        Ok(bridge(accessor).get_scroll_size(target).await.map(|s| {
            bindings::stream_dom::queries::Size {
                width: s.width,
                height: s.height,
            }
        }))
    }

    async fn set_focus(
        accessor: &Accessor<Ctx, Self>,
        target: u32,
        focus: bool,
    ) -> wasmtime::Result<bool> {
        Ok(bridge(accessor).set_focus(target, focus).await)
    }
}

impl bindings::stream_dom::queries::Host for Ctx {}

impl bindings::stream_dom::events::Host for Ctx {}

impl bindings::stream_dom::events::HostDomEvent for Ctx {
    /// No-op; see [`DomEvent`].
    fn prevent_default(
        &mut self,
        _self_: wasmtime::component::Resource<DomEvent>,
    ) -> wasmtime::Result<()> {
        Ok(())
    }

    /// No-op; see [`DomEvent`].
    fn stop_propagation(
        &mut self,
        _self_: wasmtime::component::Resource<DomEvent>,
    ) -> wasmtime::Result<()> {
        Ok(())
    }
}

impl bindings::stream_dom::events::HostDomEventWithStore<Ctx> for HasCtx {
    async fn drop(
        accessor: &Accessor<Ctx, Self>,
        rep: wasmtime::component::Resource<DomEvent>,
    ) -> wasmtime::Result<()> {
        accessor.with(|mut access| access.get().table.delete(rep))?;
        Ok(())
    }
}

/// A WASI stdio sink that forwards whole lines to `log`.
///
/// A producer's stdout is a diagnostic channel, not a data one; capturing it
/// keeps a panicking guest's message visible without giving the component a
/// real file descriptor.
struct LogSink {
    which: &'static str,
}

impl LogSink {
    fn new(which: &'static str) -> Self {
        Self { which }
    }
}

impl wasmtime_wasi::cli::IsTerminal for LogSink {
    fn is_terminal(&self) -> bool {
        false
    }
}

impl wasmtime_wasi::cli::StdoutStream for LogSink {
    fn async_stream(&self) -> Box<dyn tokio::io::AsyncWrite + Send + Sync> {
        Box::new(LogWriter {
            which: self.which,
            line: Vec::new(),
        })
    }
}

/// Buffers until a newline so one guest `write` of a partial line does not
/// become one log record.
struct LogWriter {
    which: &'static str,
    line: Vec<u8>,
}

impl LogWriter {
    fn flush_lines(&mut self) {
        while let Some(nl) = self.line.iter().position(|&b| b == b'\n') {
            let rest = self.line.split_off(nl + 1);
            let line = std::mem::replace(&mut self.line, rest);
            let line = String::from_utf8_lossy(&line[..line.len() - 1]);
            log::warn!("producer {}: {line}", self.which);
        }
    }
}

impl tokio::io::AsyncWrite for LogWriter {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        let this = self.get_mut();
        this.line.extend_from_slice(buf);
        this.flush_lines();
        std::task::Poll::Ready(Ok(buf.len()))
    }

    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::task::Poll::Ready(Ok(()))
    }

    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        let this = self.get_mut();
        if !this.line.is_empty() {
            let line = String::from_utf8_lossy(&this.line);
            log::warn!("producer {}: {line}", this.which);
            this.line.clear();
        }
        std::task::Poll::Ready(Ok(()))
    }
}
