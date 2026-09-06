//! The five IPC commands `main.ts` calls: pull with implicit ack (see
//! `docs/design.md` "Transports", the native host column).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use anyhow::{anyhow, Result};
use stream_dom_host::{EventTarget, Producer};
use tauri::ipc::{Channel, InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, State};
use tokio::sync::{mpsc, oneshot};

use crate::bridge::{Bridge, HostMessage, PendingChunk};
use crate::{valid_component_name, AppState};

struct ProducerEntry {
    producer: Producer,
    bridge: std::sync::Arc<Bridge>,
    chunks: tokio::sync::Mutex<mpsc::UnboundedReceiver<PendingChunk>>,
    /// The ack for the last chunk handed out by `read_chunk`, fired the
    /// next time `read_chunk` is called (or on `kill_producer`/drop) — see
    /// `bridge.rs`'s `PendingChunk` doc for why this is where the ack
    /// lives rather than in a matching explicit-ack command.
    pending_ack: Mutex<Option<oneshot::Sender<()>>>,
}

#[derive(Default)]
pub(crate) struct Producers {
    next_id: AtomicU32,
    entries: Mutex<HashMap<u32, std::sync::Arc<ProducerEntry>>>,
}

#[tauri::command]
pub(crate) async fn spawn_producer(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    events: Channel<HostMessage>,
) -> Result<u32, String> {
    spawn_producer_inner(app, state, name, events)
        .await
        .map_err(|e| format!("{e:#}"))
}

async fn spawn_producer_inner(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    events: Channel<HostMessage>,
) -> Result<u32> {
    if !valid_component_name(&name) {
        return Err(anyhow!("invalid component name {name:?}"));
    }

    let component = {
        let cached = state.components.lock().unwrap().get(&name).cloned();
        match cached {
            Some(c) => c,
            None => {
                let rel = format!("components/{name}.component.wasm");
                let path = app
                    .path()
                    .resolve(&rel, tauri::path::BaseDirectory::Resource)?;
                let wasm = std::fs::read(&path)
                    .map_err(|e| anyhow!("reading bundled component {path:?}: {e}"))?;
                let compiled = state.host.compile(&wasm)?;
                state
                    .components
                    .lock()
                    .unwrap()
                    .insert(name.clone(), compiled.clone());
                compiled
            }
        }
    };

    let (bridge, chunks) = Bridge::new(events);
    let bridge = std::sync::Arc::new(bridge);
    let producer = Producer::spawn(&state.host, &component, bridge.clone()).await?;

    let id = state.producers.next_id.fetch_add(1, Ordering::Relaxed);
    let entry = std::sync::Arc::new(ProducerEntry {
        producer,
        bridge: bridge.clone(),
        chunks: tokio::sync::Mutex::new(chunks),
        pending_ack: Mutex::new(None),
    });
    state
        .producers
        .entries
        .lock()
        .unwrap()
        .insert(id, entry.clone());

    // Reports the death cause to the webview whether the producer traps,
    // exhausts a limit, or is torn down in an orderly way by
    // `kill_producer` (in which case `closed()` still resolves `Ok`, and
    // the message is send-and-ignored: by then the webview's read loop
    // has already stopped itself on `kill_producer`'s own call).
    tauri::async_runtime::spawn(async move {
        let outcome = entry.producer.closed().await;
        let error = outcome.err().map(|e| format!("{e:#}"));
        entry.bridge.closed(error);
    });

    Ok(id)
}

#[tauri::command]
pub(crate) async fn read_chunk(
    state: State<'_, AppState>,
    producer: u32,
) -> Result<Response, String> {
    read_chunk_inner(state, producer)
        .await
        .map_err(|e| format!("{e:#}"))
}

async fn read_chunk_inner(state: State<'_, AppState>, producer: u32) -> Result<Response> {
    let entry = lookup(&state, producer)?;

    // Firing the PREVIOUS chunk's ack here — before awaiting the next one
    // — is the implicit ack: this call happening at all means the webview
    // finished `driver.push`ing what `read_chunk` returned last time (a
    // `push` that throws must not be followed by another `read_chunk`; the
    // webview kills the producer instead, see `main.ts`).
    if let Some(ack) = entry.pending_ack.lock().unwrap().take() {
        let _ = ack.send(());
    }

    let mut chunks = entry.chunks.lock().await;
    // Raced against `closed()`: the chunk sender lives in the `Bridge`,
    // which this entry keeps alive, so a dead producer never closes the
    // channel by itself — without this arm a read parked here would hang
    // after a trap or `kill_producer`.
    let next = tokio::select! {
        next = chunks.recv() => next,
        _ = entry.producer.closed() => None,
    }
    .ok_or_else(|| anyhow!("producer {producer} is dead"))?;
    *entry.pending_ack.lock().unwrap() = Some(next.ack);
    Ok(Response::new(next.chunk))
}

#[tauri::command]
pub(crate) async fn send_event(
    state: State<'_, AppState>,
    request: Request<'_>,
) -> Result<(), String> {
    send_event_inner(state, request)
        .await
        .map_err(|e| format!("{e:#}"))
}

async fn send_event_inner(state: State<'_, AppState>, request: Request<'_>) -> Result<()> {
    let headers = request.headers();
    let header = |name: &str| -> Result<&str> {
        headers
            .get(name)
            .ok_or_else(|| anyhow!("send_event: missing {name} header"))?
            .to_str()
            .map_err(|e| anyhow!("send_event: {name} header is not ASCII: {e}"))
    };
    let producer_id: u32 = header("producer")?
        .parse()
        .map_err(|e| anyhow!("send_event: bad producer header: {e}"))?;
    let target_kind = header("target-kind")?;
    let name: u32 = header("name")?
        .parse()
        .map_err(|e| anyhow!("send_event: bad name header: {e}"))?;
    let target = match target_kind {
        "window" => EventTarget::Window,
        "document" => EventTarget::Document,
        "node" => {
            let id: u32 = header("target-id")?
                .parse()
                .map_err(|e| anyhow!("send_event: bad target-id header: {e}"))?;
            EventTarget::Node(id)
        }
        other => return Err(anyhow!("send_event: unknown target-kind {other:?}")),
    };
    let payload = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        InvokeBody::Json(_) => return Err(anyhow!("send_event: expected a raw body")),
    };

    let entry = lookup(&state, producer_id)?;
    entry.producer.handle_event(target, name, payload).await?;
    Ok(())
}

#[tauri::command]
pub(crate) fn answer_query(
    state: State<'_, AppState>,
    producer: u32,
    id: u64,
    result: serde_json::Value,
) -> Result<(), String> {
    let entry = lookup(&state, producer).map_err(|e| format!("{e:#}"))?;
    entry.bridge.answer(id, result);
    Ok(())
}

#[tauri::command]
pub(crate) async fn kill_producer(state: State<'_, AppState>, producer: u32) -> Result<(), String> {
    let entry = state.producers.entries.lock().unwrap().remove(&producer);
    if let Some(entry) = entry {
        // Let the guest's parked write complete before the store goes; it
        // makes no difference to the guest (the store is dropped next) but
        // keeps the bridge's `apply` from reporting a spurious drop.
        if let Some(ack) = entry.pending_ack.lock().unwrap().take() {
            let _ = ack.send(());
        }
        entry.producer.shutdown().await;
    }
    Ok(())
}

fn lookup(state: &State<'_, AppState>, producer: u32) -> Result<std::sync::Arc<ProducerEntry>> {
    state
        .producers
        .entries
        .lock()
        .unwrap()
        .get(&producer)
        .cloned()
        .ok_or_else(|| anyhow!("no such producer {producer}"))
}
