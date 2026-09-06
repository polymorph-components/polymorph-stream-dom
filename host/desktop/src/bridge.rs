//! The `HostBridge` implementation: one per spawned producer, forwarding
//! `apply`/query calls to the webview over IPC (`commands.rs`) instead of
//! touching a DOM directly — the receiver lives in the webview, one hop
//! further out than `stream-dom-host`'s `HostBridge` doc assumes.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use anyhow::{anyhow, Result};
use serde::Serialize;
use stream_dom_host::{BoxFuture, Point, Rect, Size};
use tauri::ipc::Channel;
use tokio::sync::{mpsc, oneshot};

/// One `apply`d chunk, paired with the ack this bridge is blocked on.
///
/// The ack is fired by `read_chunk`'s *next* call, not by anything on this
/// side: the webview calling `read_chunk` again is proof it finished
/// `driver.push`ing the previous chunk (see `commands::read_chunk`), which
/// is the whole "pull with implicit ack" scheme this crate uses instead of
/// a matching explicit-ack command.
pub(crate) struct PendingChunk {
    pub chunk: Vec<u8>,
    pub ack: oneshot::Sender<()>,
}

/// Messages a producer's bridge sends to the webview over its per-producer
/// `Channel`. Serialized as a tagged enum (`serde`'s default, `{"type":
/// ...}`) — `main.ts` matches on it directly.
#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum HostMessage {
    Query {
        id: u64,
        kind: QueryKind,
        target: u32,
        /// Only present for `focus`; the `set-focus` argument.
        #[serde(skip_serializing_if = "Option::is_none")]
        focus: Option<bool>,
    },
    Closed {
        error: Option<String>,
    },
}

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "kebab-case")]
pub enum QueryKind {
    ClientRect,
    ScrollOffset,
    ScrollSize,
    Focus,
}

pub(crate) struct Bridge {
    channel: Channel<HostMessage>,
    chunks_tx: mpsc::UnboundedSender<PendingChunk>,
    next_query: AtomicU64,
    pending_queries: Mutex<HashMap<u64, oneshot::Sender<serde_json::Value>>>,
}

impl Bridge {
    pub fn new(channel: Channel<HostMessage>) -> (Self, mpsc::UnboundedReceiver<PendingChunk>) {
        let (chunks_tx, chunks_rx) = mpsc::unbounded_channel();
        (
            Self {
                channel,
                chunks_tx,
                next_query: AtomicU64::new(0),
                pending_queries: Mutex::new(HashMap::new()),
            },
            chunks_rx,
        )
    }

    /// Complete a query started by `query`, called from the `answer_query`
    /// command. `None` deserializes to whichever "absent" value the
    /// caller's `serde_json::from_value` expects (`null` -> `None`/`false`).
    pub fn answer(&self, id: u64, result: serde_json::Value) {
        let tx = self.pending_queries.lock().unwrap().remove(&id);
        if let Some(tx) = tx {
            let _ = tx.send(result);
        }
    }

    pub fn closed(&self, error: Option<String>) {
        let _ = self.channel.send(HostMessage::Closed { error });
    }

    async fn query(&self, kind: QueryKind, target: u32, focus: Option<bool>) -> serde_json::Value {
        let id = self.next_query.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending_queries.lock().unwrap().insert(id, tx);
        if self
            .channel
            .send(HostMessage::Query {
                id,
                kind,
                target,
                focus,
            })
            .is_err()
        {
            self.pending_queries.lock().unwrap().remove(&id);
            return serde_json::Value::Null;
        }
        rx.await.unwrap_or(serde_json::Value::Null)
    }
}

impl stream_dom_host::HostBridge for Bridge {
    fn apply(&self, chunk: Vec<u8>) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            let (ack, wait) = oneshot::channel();
            self.chunks_tx
                .send(PendingChunk { chunk, ack })
                .map_err(|_| anyhow!("read_chunk side is gone"))?;
            wait.await
                .map_err(|_| anyhow!("chunk was dropped before the webview acked it"))
        })
    }

    fn get_client_rect(&self, target: u32) -> BoxFuture<'_, Option<Rect>> {
        Box::pin(async move {
            let v = self.query(QueryKind::ClientRect, target, None).await;
            serde_json::from_value::<Option<WireRect>>(v)
                .ok()
                .flatten()
                .map(Into::into)
        })
    }

    fn get_scroll_offset(&self, target: u32) -> BoxFuture<'_, Option<Point>> {
        Box::pin(async move {
            let v = self.query(QueryKind::ScrollOffset, target, None).await;
            serde_json::from_value::<Option<WirePoint>>(v)
                .ok()
                .flatten()
                .map(Into::into)
        })
    }

    fn get_scroll_size(&self, target: u32) -> BoxFuture<'_, Option<Size>> {
        Box::pin(async move {
            let v = self.query(QueryKind::ScrollSize, target, None).await;
            serde_json::from_value::<Option<WireSize>>(v)
                .ok()
                .flatten()
                .map(Into::into)
        })
    }

    fn set_focus(&self, target: u32, focus: bool) -> BoxFuture<'_, bool> {
        Box::pin(async move {
            let v = self.query(QueryKind::Focus, target, Some(focus)).await;
            serde_json::from_value::<Option<bool>>(v)
                .ok()
                .flatten()
                .unwrap_or(false)
        })
    }
}

/// JSON shapes `answer_query` sends back for the three read queries — kept
/// separate from `stream_dom_host`'s `Rect`/`Point`/`Size` (which have no
/// `Deserialize`) rather than adding a dependency's-worth of derive to that
/// crate for three structs only this bridge needs.
#[derive(serde::Deserialize)]
struct WireRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}
impl From<WireRect> for Rect {
    fn from(r: WireRect) -> Self {
        Rect {
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
        }
    }
}

#[derive(serde::Deserialize)]
struct WirePoint {
    x: f64,
    y: f64,
}
impl From<WirePoint> for Point {
    fn from(p: WirePoint) -> Self {
        Point { x: p.x, y: p.y }
    }
}

#[derive(serde::Deserialize)]
struct WireSize {
    width: f64,
    height: f64,
}
impl From<WireSize> for Size {
    fn from(s: WireSize) -> Self {
        Size {
            width: s.width,
            height: s.height,
        }
    }
}
