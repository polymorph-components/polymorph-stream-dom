//! End-to-end: the real TodoMVC producer component, hosted on wasmtime,
//! driven through a fake receiver.
//!
//! What this pins down is the semantics the crate exists for — the ack
//! rendezvous, event dispatch reaching a real handler, teardown, and limit
//! failures surfacing rather than hanging — against a component nobody
//! wrote for this host.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Result;
use prost::Message as _;
use stream_dom_host::{
    BoxFuture, EventTarget, Host, HostBridge, Limits, Point, Producer, Rect, Size,
};
use stream_dom_proto as proto;

const COMPONENT: &str = "build/dioxus-todomvc.component.wasm";

fn component_bytes() -> Vec<u8> {
    // CARGO_MANIFEST_DIR is host/stream-dom-host; the component lives in the
    // repo's build/ directory.
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(COMPONENT);
    std::fs::read(&path).unwrap_or_else(|e| {
        panic!("{COMPONENT} is missing ({e}); build it with `just host-component`")
    })
}

/// One recorded `apply`: the bytes, and when the call started, so the ack
/// gate can be observed in time rather than only in order.
///
/// Recorded when the call *starts*, not when it finishes: a test that
/// stalls an apply still needs to read the chunk it stalled on.
struct Applied {
    chunk: Vec<u8>,
    started: Instant,
}

/// A receiver that records everything and can be told to stall.
#[derive(Default)]
struct Recorder {
    applied: Vec<Applied>,
    /// How long the *next* `apply` (by index) should hold before returning.
    stall_first: Option<Duration>,
    /// Number of `apply` calls that have started but not finished.
    in_flight: usize,
    /// Set if two applies were ever in flight at once — the property the
    /// rendezvous forbids.
    overlapped: bool,
}

#[derive(Default)]
struct FakeBridge {
    state: Mutex<Recorder>,
    notify: tokio::sync::Notify,
}

impl FakeBridge {
    fn stalling(first: Duration) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(Recorder {
                stall_first: Some(first),
                ..Recorder::default()
            }),
            notify: tokio::sync::Notify::new(),
        })
    }

    fn chunks(&self) -> Vec<Vec<u8>> {
        self.state
            .lock()
            .unwrap()
            .applied
            .iter()
            .map(|a| a.chunk.clone())
            .collect()
    }

    fn applied_count(&self) -> usize {
        self.state.lock().unwrap().applied.len()
    }

    /// Every frame delivered so far, in order, across all chunks.
    fn frames(&self) -> Vec<proto::Frame> {
        self.chunks()
            .iter()
            .flat_map(|c| decode_frames(c))
            .collect()
    }

    /// Wait until at least `n` applies have *started*, or time out.
    async fn wait_for_applies(&self, n: usize, timeout: Duration) -> bool {
        tokio::time::timeout(timeout, async {
            loop {
                if self.applied_count() >= n {
                    return;
                }
                self.notify.notified().await;
            }
        })
        .await
        .is_ok()
    }
}

impl HostBridge for FakeBridge {
    fn apply(&self, chunk: Vec<u8>) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            let stall = {
                let mut state = self.state.lock().unwrap();
                if state.in_flight > 0 {
                    state.overlapped = true;
                }
                state.in_flight += 1;
                state.applied.push(Applied {
                    chunk,
                    started: Instant::now(),
                });
                state.stall_first.take()
            };
            self.notify.notify_waiters();
            if let Some(stall) = stall {
                tokio::time::sleep(stall).await;
            }
            self.state.lock().unwrap().in_flight -= 1;
            Ok(())
        })
    }

    fn get_client_rect(&self, _target: u32) -> BoxFuture<'_, Option<Rect>> {
        Box::pin(async { None })
    }
    fn get_scroll_offset(&self, _target: u32) -> BoxFuture<'_, Option<Point>> {
        Box::pin(async { None })
    }
    fn get_scroll_size(&self, _target: u32) -> BoxFuture<'_, Option<Size>> {
        Box::pin(async { None })
    }
    fn set_focus(&self, _target: u32, _focus: bool) -> BoxFuture<'_, bool> {
        Box::pin(async { false })
    }
}

/// Split a chunk into `Frame`s: varint byte length, then one `Frame`,
/// repeated (proto/stream-dom.proto, "Stream layout"). A frame may straddle
/// a chunk in general; this asserts it does not, which holds because the
/// guest writes whole batches.
fn decode_frames(mut buf: &[u8]) -> Vec<proto::Frame> {
    let mut frames = Vec::new();
    while !buf.is_empty() {
        let len = prost::encoding::decode_varint(&mut buf).expect("frame length varint") as usize;
        assert!(len <= buf.len(), "frame straddles a chunk boundary");
        let (frame, rest) = buf.split_at(len);
        frames.push(proto::Frame::decode(frame).expect("decode Frame"));
        buf = rest;
    }
    frames
}

/// The interned string table built from the `Intern` frames seen so far.
fn interns(frames: &[proto::Frame]) -> std::collections::HashMap<u32, String> {
    frames
        .iter()
        .filter_map(|f| match &f.op {
            Some(proto::frame::Op::Intern(i)) => Some((i.id, i.s.clone())),
            _ => None,
        })
        .collect()
}

fn listeners(frames: &[proto::Frame]) -> Vec<proto::Listener> {
    frames
        .iter()
        .filter_map(|f| match &f.op {
            Some(proto::frame::Op::AddListener(a)) => a.listener,
            _ => None,
        })
        .collect()
}

async fn host() -> Host {
    Host::new(Limits::default()).expect("host")
}

/// The new-todo input, as `(node, input str-ref, keydown str-ref)`.
///
/// Identified as the node carrying both an `input` and a `keydown`
/// listener — TodoMVC's `TodoHeader` is the only place that pairs them —
/// rather than by class, which would depend on which template hole it
/// landed in.
fn new_todo_input(frames: &[proto::Frame]) -> (u32, u32, u32) {
    let names = interns(frames);
    let name_of = |slot: u32| names.get(&slot).cloned().unwrap_or_default();
    let ls = listeners(frames);
    let node_of = |l: &proto::Listener| match l.target {
        Some(proto::listener::Target::Id(id)) => Some(id),
        _ => None,
    };
    let keydown_nodes: Vec<u32> = ls
        .iter()
        .filter(|l| name_of(l.name) == "keydown")
        .filter_map(node_of)
        .collect();
    ls.iter()
        .filter(|l| name_of(l.name) == "input")
        .find_map(|l| {
            let id = node_of(l)?;
            keydown_nodes.contains(&id).then(|| {
                let keydown = ls
                    .iter()
                    .find(|k| name_of(k.name) == "keydown" && node_of(k) == Some(id))
                    .expect("keydown listener");
                (id, l.name, keydown.name)
            })
        })
        .expect("no node carries both an `input` and a `keydown` listener")
}

/// The `input` event the draft-text handler reads (`evt.value()`).
fn form_payload(value: &str) -> Vec<u8> {
    proto::EventPayload {
        family: Some(proto::event_payload::Family::Form(proto::FormData {
            value: value.to_string(),
            ..Default::default()
        })),
        text_control: None,
    }
    .encode_to_vec()
}

/// The `keydown` the handler tests with `evt.key() == Key::Enter`.
fn enter_payload() -> Vec<u8> {
    proto::EventPayload {
        family: Some(proto::event_payload::Family::Keyboard(
            proto::KeyboardData {
                key: "Enter".to_string(),
                code: "Enter".to_string(),
                ..Default::default()
            },
        )),
        text_control: None,
    }
    .encode_to_vec()
}

/// Type a draft and press Enter on the new-todo input.
async fn add_todo(producer: &Producer, frames: &[proto::Frame], text: &str) -> Result<()> {
    let (node, input_name, keydown_name) = new_todo_input(frames);
    producer
        .handle_event(EventTarget::Node(node), input_name, form_payload(text))
        .await?;
    producer
        .handle_event(EventTarget::Node(node), keydown_name, enter_payload())
        .await?;
    Ok(())
}

/// The first chunks are a well-formed mount: at least one batch ends in
/// `commit`, nodes are created (directly or by cloning a template), and the
/// producer registers listeners.
#[tokio::test(flavor = "multi_thread")]
async fn mount_produces_a_committed_batch_with_listeners() {
    let host = host().await;
    let component = host.compile(&component_bytes()).expect("compile");
    let bridge = Arc::new(FakeBridge::default());

    let producer = Producer::spawn(&host, &component, bridge.clone())
        .await
        .expect("spawn");
    assert!(
        bridge.wait_for_applies(1, Duration::from_secs(10)).await,
        "no batch arrived from the mount"
    );

    let frames = bridge.frames();
    assert!(
        frames.iter().any(|f| f.commit),
        "no batch was committed: {} frames",
        frames.len()
    );
    assert!(
        frames.iter().any(|f| matches!(
            f.op,
            Some(proto::frame::Op::CreateElement(_)) | Some(proto::frame::Op::CloneTemplate(_))
        )),
        "no create_element / clone_template op in the mount"
    );
    assert!(
        !listeners(&frames).is_empty(),
        "the mount registered no listeners"
    );

    producer.shutdown().await;
}

/// The rendezvous: a receiver that holds one `apply` holds the guest's
/// write, so a second `apply` cannot start until the first returns.
///
/// TodoMVC writes its whole mount in one write and then parks (the WIT's
/// "a parked scheduler is a documented idle state"), so a second write has
/// to be provoked: an event is dispatched while the mount's apply is still
/// stalled.
///
/// `spawn` itself must not be gated on the ack: it returns once `run` has
/// returned the stream, which is before the first `apply` resolves.
#[tokio::test(flavor = "multi_thread")]
async fn a_stalled_apply_blocks_the_next_one_but_not_spawn() {
    let host = host().await;
    let component = host.compile(&component_bytes()).expect("compile");
    let stall = Duration::from_millis(200);
    let bridge = FakeBridge::stalling(stall);

    let before_spawn = Instant::now();
    let producer = Producer::spawn(&host, &component, bridge.clone())
        .await
        .expect("spawn");
    let spawn_took = before_spawn.elapsed();
    // `run` returns its stream before any batch is applied, so spawn cannot
    // have waited out the stall.
    assert!(
        spawn_took < stall,
        "spawn took {spawn_took:?}, so it waited on the first apply"
    );

    assert!(
        bridge.wait_for_applies(1, Duration::from_secs(10)).await,
        "no batch arrived from the mount"
    );
    // The mount's apply is stalling right now; this event's batch is the
    // write that must queue behind it.
    add_todo(&producer, &bridge.frames(), "write a host")
        .await
        .expect("dispatch");

    assert!(
        bridge.wait_for_applies(2, Duration::from_secs(10)).await,
        "the event produced no second batch"
    );
    producer.shutdown().await;

    let state = bridge.state.lock().unwrap();
    assert!(
        !state.overlapped,
        "two applies were in flight at once: the write was not gated on the ack"
    );
    let gap = state.applied[1]
        .started
        .duration_since(state.applied[0].started);
    assert!(
        gap >= stall,
        "the second apply started {gap:?} after the first, less than the {stall:?} stall"
    );
}

/// Dispatch the two events TodoMVC's `TodoHeader` needs to add a row: an
/// `input` carrying the draft text (the handler reads `evt.value()`), then
/// a `keydown` with `key = "Enter"` — the same pair `web/e2e/todomvc_test.ts`
/// performs through a browser. A new todo row must then reach the receiver.
#[tokio::test(flavor = "multi_thread")]
async fn dispatching_input_then_enter_adds_a_todo() {
    let host = host().await;
    let component = host.compile(&component_bytes()).expect("compile");
    let bridge = Arc::new(FakeBridge::default());

    let producer = Producer::spawn(&host, &component, bridge.clone())
        .await
        .expect("spawn");
    assert!(bridge.wait_for_applies(1, Duration::from_secs(10)).await);

    let before = bridge.applied_count();
    add_todo(&producer, &bridge.frames(), "write a host")
        .await
        .expect("dispatch");

    // The handler runs on the guest's scheduler task, so the resulting
    // batch arrives after `handle-event` has already returned.
    assert!(
        bridge
            .wait_for_applies(before + 1, Duration::from_secs(10))
            .await,
        "no batch followed the Enter keydown"
    );

    let after: Vec<proto::Frame> = bridge.chunks()[before..]
        .iter()
        .flat_map(|c| decode_frames(c))
        .collect();
    assert!(
        after.iter().any(|f| matches!(
            f.op,
            Some(proto::frame::Op::CreateElement(_))
                | Some(proto::frame::Op::CloneTemplate(_))
                | Some(proto::frame::Op::CreateText(_))
        )),
        "the batch after Enter created no nodes"
    );
    // The draft text itself must have crossed: either as a text node or as
    // an interned string the row's ops refer to.
    assert!(
        interns(&bridge.frames())
            .values()
            .any(|s| s == "write a host")
            || after.iter().any(|f| matches!(
                &f.op,
                Some(proto::frame::Op::CreateText(t)) if t.text == "write a host"
            ))
            || after.iter().any(|f| matches!(
                &f.op,
                Some(proto::frame::Op::SetText(t)) if t.text == "write a host"
            )),
        "the todo's text never reached the receiver"
    );

    // The producer survived the round trip.
    assert!(
        tokio::time::timeout(Duration::from_millis(50), producer.closed())
            .await
            .is_err(),
        "the producer died during dispatch"
    );

    producer.shutdown().await;
}

/// `shutdown` stops the producer and `closed` reports the orderly stop.
#[tokio::test(flavor = "multi_thread")]
async fn shutdown_resolves_closed() {
    let host = host().await;
    let component = host.compile(&component_bytes()).expect("compile");
    let bridge = Arc::new(FakeBridge::default());

    let producer = Producer::spawn(&host, &component, bridge.clone())
        .await
        .expect("spawn");
    assert!(bridge.wait_for_applies(1, Duration::from_secs(10)).await);

    producer.shutdown().await;
    let closed = tokio::time::timeout(Duration::from_secs(5), producer.closed())
        .await
        .expect("closed() did not resolve after shutdown");
    assert!(closed.is_ok(), "orderly shutdown reported {closed:?}");

    // Idempotent.
    producer.shutdown().await;
}

/// A memory limit the guest cannot fit in must fail loudly — not panic, not
/// hang. Whether it fails at instantiation (`spawn` returns the error) or
/// once running (`closed` carries it) is not something the limit lets us
/// choose, so either is accepted.
#[tokio::test(flavor = "multi_thread")]
async fn an_impossible_memory_limit_fails_rather_than_hangs() {
    let host = Host::new(Limits {
        memory_bytes: 1024 * 1024,
        ..Limits::default()
    })
    .expect("host");
    let component = host.compile(&component_bytes()).expect("compile");
    let bridge = Arc::new(FakeBridge::default());

    let spawned = tokio::time::timeout(
        Duration::from_secs(30),
        Producer::spawn(&host, &component, bridge.clone()),
    )
    .await
    .expect("spawn neither returned nor failed within 30s");

    match spawned {
        Err(e) => {
            let msg = format!("{e:#}");
            assert!(
                msg.contains("memory") || msg.contains("limit") || msg.contains("grow"),
                "expected a memory-limit failure, got: {msg}"
            );
        }
        Ok(producer) => {
            let closed = tokio::time::timeout(Duration::from_secs(30), producer.closed())
                .await
                .expect("producer neither died nor reported within 30s");
            assert!(
                closed.is_err(),
                "a 1 MiB producer ran to an orderly stop; the limit did nothing"
            );
        }
    }
}
