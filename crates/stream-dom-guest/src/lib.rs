//! `polymorph:stream-dom` shared guest support: what every Rust producer
//! needs to build batches of `Frame`s and route interned names, independent
//! of framework.
//!
//! Two proto sections named in the header comments matter here:
//! `proto/stream-dom.proto`'s `Frame` doc (the commit flag, field-order
//! independence) and its "Ids are never reused" note (design.md "Every op
//! is addressable and self-contained").

use prost::Message;
use rustc_hash::FxHashMap;
pub use stream_dom_proto as proto;

/// Producer-allocated node id. `0` is the mount root and is never handed
/// out by [`Ids::alloc`]; ids are never reused within a stream (see
/// proto/stream-dom.proto's file header and docs/design.md "Every op is
/// addressable and self-contained").
pub type NodeId = u32;

/// Interned string slot, defined by a prior `Intern` frame.
pub type StrRef = u32;

/// Producer-side node id allocator. Monotonic: no id is ever reused within
/// a stream, per the protocol invariant (proto/stream-dom.proto file
/// header).
pub struct Ids {
    next: NodeId,
}

impl Ids {
    /// `0` is reserved for the mount root, so the first allocated id is `1`.
    pub fn new() -> Self {
        Ids { next: 1 }
    }

    pub fn alloc(&mut self) -> NodeId {
        let id = self.next;
        self.next += 1;
        id
    }
}

impl Default for Ids {
    fn default() -> Self {
        Self::new()
    }
}

/// One batch of frames under construction.
///
/// `push` encodes each op as a length-delimited `Frame` with `commit =
/// false` as soon as the *next* op is pushed — the most recent op is held
/// back unencoded so [`Batch::finish`] can write it with `commit = true`.
/// This is the only legal way to produce a commit: proto/stream-dom.proto's
/// `Frame` doc allows an op-less commit frame only for an empty batch, and
/// `finish` on an empty batch returns `None` rather than emit one, since a
/// producer with nothing to commit has nothing to say.
pub struct Batch {
    /// Already-encoded, non-committing frames.
    buf: Vec<u8>,
    /// The most recently pushed op, not yet encoded, so it can carry
    /// `commit = true` if this turns out to be the batch's last op.
    pending: Option<proto::frame::Op>,
}

impl Batch {
    pub fn new() -> Self {
        Batch {
            buf: Vec::new(),
            pending: None,
        }
    }

    /// True iff no op has been pushed since the last `finish` (or ever).
    pub fn is_empty(&self) -> bool {
        self.pending.is_none()
    }

    fn encode(&mut self, op: proto::frame::Op, commit: bool) {
        let frame = proto::Frame {
            commit,
            op: Some(op),
        };
        frame
            .encode_length_delimited(&mut self.buf)
            .expect("Vec<u8> writer is infallible");
    }

    pub fn push(&mut self, op: proto::frame::Op) {
        if let Some(prev) = self.pending.take() {
            self.encode(prev, false);
        }
        self.pending = Some(op);
    }

    /// Encode the held-back op with `commit = true` and return the batch's
    /// bytes, leaving `self` empty. `None` for an empty batch (see the
    /// struct doc: there is no op-less commit frame to emit here).
    ///
    /// The returned `Vec` is the buffer that was accumulating frames; a
    /// fresh buffer of the same capacity replaces it, so repeated
    /// batch/finish cycles do not restart from a zero-capacity allocation.
    pub fn finish(&mut self) -> Option<Vec<u8>> {
        let op = self.pending.take()?;
        self.encode(op, true);
        let cap = self.buf.capacity();
        let out = std::mem::replace(&mut self.buf, Vec::with_capacity(cap));
        Some(out)
    }

    pub fn create_element(&mut self, id: NodeId, tag: StrRef, ns: Option<StrRef>) {
        self.push(proto::frame::Op::CreateElement(proto::CreateElement {
            id,
            tag,
            ns,
        }));
    }

    pub fn create_text(&mut self, id: NodeId, text: &str) {
        self.push(proto::frame::Op::CreateText(proto::CreateText {
            id,
            text: text.to_string(),
        }));
    }

    pub fn create_placeholder(&mut self, id: NodeId) {
        self.push(proto::frame::Op::CreatePlaceholder(
            proto::CreatePlaceholder { id },
        ));
    }

    /// Insert `id` before `anchor`, or append it to `parent` when there is
    /// no `anchor`. `parent` is required without an anchor and optional
    /// with one — the anchor's parent is implied, as in the DOM's
    /// `insertBefore` (proto/stream-dom.proto `InsertBefore`). A frame with
    /// neither is an error, asserted here in debug builds because on the
    /// wire it is a silently unapplicable op.
    pub fn insert_before(&mut self, parent: Option<NodeId>, id: NodeId, anchor: Option<NodeId>) {
        debug_assert!(
            parent.is_some() || anchor.is_some(),
            "insert-before needs a parent, an anchor, or both"
        );
        self.push(proto::frame::Op::InsertBefore(proto::InsertBefore {
            parent,
            id,
            anchor,
        }));
    }

    /// Insert `id` immediately after `anchor`. `parent` is optional and
    /// implied by the anchor (proto/stream-dom.proto `InsertAfter`); there
    /// is no append form, since appending is `insert_before` without an
    /// anchor.
    pub fn insert_after(&mut self, parent: Option<NodeId>, id: NodeId, anchor: NodeId) {
        self.push(proto::frame::Op::InsertAfter(proto::InsertAfter {
            parent,
            id,
            anchor,
        }));
    }

    pub fn remove(&mut self, id: NodeId) {
        self.push(proto::frame::Op::Remove(proto::Remove { id }));
    }

    pub fn set_text(&mut self, id: NodeId, text: &str) {
        self.push(proto::frame::Op::SetText(proto::SetText {
            id,
            text: text.to_string(),
        }));
    }

    pub fn set_attribute(
        &mut self,
        id: NodeId,
        name: StrRef,
        ns: Option<StrRef>,
        value: Option<&str>,
    ) {
        self.push(proto::frame::Op::SetAttribute(proto::SetAttribute {
            id,
            name,
            ns,
            value: value.map(|v| proto::set_attribute::Value::Text(v.to_owned())),
        }));
    }

    /// Set an attribute to an opaque asset handle (proto/stream-dom.proto
    /// `SetAttribute.asset`) rather than a text value.
    pub fn set_attribute_asset(
        &mut self,
        id: NodeId,
        name: StrRef,
        ns: Option<StrRef>,
        handle: &[u8],
    ) {
        self.push(proto::frame::Op::SetAttribute(proto::SetAttribute {
            id,
            name,
            ns,
            value: Some(proto::set_attribute::Value::Asset(handle.to_vec())),
        }));
    }

    pub fn set_property(
        &mut self,
        id: NodeId,
        name: StrRef,
        value: Option<proto::set_property::Value>,
    ) {
        self.push(proto::frame::Op::SetProperty(proto::SetProperty {
            id,
            name,
            value,
        }));
    }

    pub fn add_listener(&mut self, l: proto::Listener) {
        self.push(proto::frame::Op::AddListener(proto::AddListener {
            listener: Some(l),
        }));
    }

    pub fn remove_listener(&mut self, l: proto::Listener) {
        self.push(proto::frame::Op::RemoveListener(proto::RemoveListener {
            listener: Some(l),
        }));
    }

    pub fn intern(&mut self, id: StrRef, s: &str) {
        self.push(proto::frame::Op::Intern(proto::Intern {
            id,
            s: s.to_string(),
        }));
    }

    pub fn register_template(&mut self, t: proto::RegisterTemplate) {
        self.push(proto::frame::Op::RegisterTemplate(t));
    }

    pub fn clone_template(&mut self, tmpl: u32, root: u32, id: NodeId) {
        self.push(proto::frame::Op::CloneTemplate(proto::CloneTemplate {
            tmpl,
            root,
            id,
        }));
    }

    pub fn bind_path(&mut self, root: NodeId, path: &[u8], id: NodeId) {
        self.push(proto::frame::Op::BindPath(proto::BindPath {
            root,
            path: path.to_vec(),
            id,
        }));
    }
}

impl Default for Batch {
    fn default() -> Self {
        Self::new()
    }
}

/// Content-keyed string interner (tags, attribute/event names, namespaces).
///
/// Content-keyed rather than pointer-identity-keyed like
/// polyengine-dioxus's (`&'static str` producers there): a `stream-dom`
/// producer commonly builds names at runtime (e.g. from a template arena),
/// so there is no `'static` pointer to key on. Slots start at `1`; `0` is
/// never issued so it stays free for callers that want an "absent"
/// sentinel alongside `Option<StrRef>` (the schema already uses
/// `optional uint32`, so this crate does not reserve `0` itself, but the
/// first slot handed out is `1` regardless, matching `NodeId`'s reserved
/// `0`).
pub struct Interner {
    ids: FxHashMap<Box<str>, StrRef>,
    /// slot N is `names[N - 1]`.
    names: Vec<Box<str>>,
}

impl Interner {
    pub fn new() -> Self {
        Interner {
            ids: FxHashMap::default(),
            names: Vec::new(),
        }
    }

    /// Return `s`'s slot, emitting an `Intern` frame into `batch` on first
    /// sight (proto/stream-dom.proto: "An Intern precedes the first use of
    /// its slot ... emitted once per producer instance").
    pub fn intern(&mut self, s: &str, batch: &mut Batch) -> StrRef {
        if let Some(&slot) = self.ids.get(s) {
            return slot;
        }
        let slot = (self.names.len() + 1) as StrRef;
        self.ids.insert(s.into(), slot);
        self.names.push(s.into());
        batch.intern(slot, s);
        slot
    }

    /// Reverse lookup for `handle-event`, which receives event names back
    /// as the slot rather than the string.
    pub fn resolve(&self, slot: StrRef) -> Option<&str> {
        let idx = slot.checked_sub(1)?;
        self.names
            .get(idx as usize)
            .map(std::convert::AsRef::as_ref)
    }
}

impl Default for Interner {
    fn default() -> Self {
        Self::new()
    }
}

/// Decode a `handle-event` payload. Empty bytes decode to
/// `EventPayload::default()` (family `None`) rather than erroring: an
/// empty payload is legitimate for synthetic events (`mounted`, focus,
/// selection; see proto/stream-dom-events.proto's file header).
pub fn decode_event(bytes: &[u8]) -> Result<proto::EventPayload, prost::DecodeError> {
    proto::EventPayload::decode(bytes)
}

#[cfg(target_arch = "wasm32")]
pub mod bindings;

#[cfg(target_arch = "wasm32")]
pub mod channel;

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_all(bytes: &[u8]) -> Vec<proto::Frame> {
        let mut buf = bytes;
        let mut frames = Vec::new();
        while !buf.is_empty() {
            frames.push(proto::Frame::decode_length_delimited(&mut buf).unwrap());
        }
        frames
    }

    #[test]
    fn empty_batch_finish_is_none() {
        let mut b = Batch::new();
        assert!(b.is_empty());
        assert!(b.finish().is_none());
    }

    #[test]
    fn batch_frames_only_last_commits() {
        let mut b = Batch::new();
        b.create_element(1, 10, None);
        b.create_text(2, "hi");
        b.insert_before(Some(0), 1, None);
        let bytes = b.finish().expect("non-empty batch");

        let frames = decode_all(&bytes);
        assert_eq!(frames.len(), 3);
        for f in &frames[..frames.len() - 1] {
            assert!(!f.commit, "only the last frame commits");
        }
        assert!(frames.last().unwrap().commit);

        assert!(matches!(
            frames[0].op,
            Some(proto::frame::Op::CreateElement(_))
        ));
        assert!(matches!(
            frames[1].op,
            Some(proto::frame::Op::CreateText(_))
        ));
        assert!(matches!(
            frames[2].op,
            Some(proto::frame::Op::InsertBefore(_))
        ));
    }

    #[test]
    fn batch_reusable_after_finish() {
        let mut b = Batch::new();
        b.remove(1);
        let first = b.finish().unwrap();
        assert!(b.is_empty());

        b.remove(2);
        let second = b.finish().unwrap();

        let f1 = decode_all(&first);
        let f2 = decode_all(&second);
        assert_eq!(f1.len(), 1);
        assert_eq!(f2.len(), 1);
        assert!(matches!(&f1[0].op, Some(proto::frame::Op::Remove(r)) if r.id == 1));
        assert!(matches!(&f2[0].op, Some(proto::frame::Op::Remove(r)) if r.id == 2));
    }

    #[test]
    fn interner_intern_is_idempotent_and_resolves() {
        let mut interner = Interner::new();
        let mut b = Batch::new();

        let a = interner.intern("div", &mut b);
        let b_slot = interner.intern("div", &mut b);
        assert_eq!(a, b_slot, "same string, same slot");

        // Only the first sight defines the slot: exactly one Intern frame.
        let bytes = b.finish().unwrap();
        let frames = decode_all(&bytes);
        let intern_frames: Vec<_> = frames
            .iter()
            .filter(|f| matches!(f.op, Some(proto::frame::Op::Intern(_))))
            .collect();
        assert_eq!(intern_frames.len(), 1);

        assert_eq!(interner.resolve(a), Some("div"));
        assert_eq!(interner.resolve(a + 1000), None);
        assert_eq!(interner.resolve(0), None, "slot 0 is never issued");
    }

    #[test]
    fn decode_event_empty_bytes_is_default() {
        let payload = decode_event(&[]).unwrap();
        assert_eq!(payload, proto::EventPayload::default());
        assert!(payload.family.is_none());
    }

    /// Builds the fixture batch checked in at
    /// `fixtures/basic.pb`/`fixtures/basic.txt`. Regenerate both with
    /// `UPDATE_FIXTURES=1 cargo test -p stream-dom-guest basic_fixture`.
    #[test]
    fn basic_fixture() {
        let mut interner = Interner::new();
        let mut b = Batch::new();

        let div = interner.intern("div", &mut b);
        let click = interner.intern("click", &mut b);
        let class = interner.intern("class", &mut b);
        let hashchange = interner.intern("hashchange", &mut b);

        b.create_element(1, div, None);
        b.create_text(2, "hello");
        b.insert_before(Some(0), 1, None);
        // Append: parent, no anchor.
        b.insert_before(Some(1), 2, None);
        // The two anchored, parentless forms, so the TS decoder's
        // cross-check covers both: after an anchor, and before one.
        b.create_text(3, "!");
        b.insert_after(None, 3, 2);
        b.create_text(4, "?");
        b.insert_before(None, 4, Some(3));
        b.set_attribute(1, class, None, Some("greeting"));
        b.add_listener(proto::Listener {
            target: Some(proto::listener::Target::Id(1)),
            name: click,
            bubbles: true,
            capture: false,
            passive: false,
            prevent_default: false,
            stop_propagation: false,
        });
        // The other arm of `Listener.target`, so the TS decoder's
        // cross-check covers the oneof and not just node ids. Globals are
        // attached directly, hence `bubbles: false`.
        b.add_listener(proto::Listener {
            target: Some(proto::listener::Target::Global(
                proto::Global::Window as i32,
            )),
            name: hashchange,
            bubbles: false,
            capture: false,
            passive: false,
            prevent_default: false,
            stop_propagation: false,
        });
        b.set_text(2, "hello, world");
        b.remove(2);

        let bytes = b.finish().expect("non-empty batch");
        let frames = decode_all(&bytes);

        let dump: String = frames
            .iter()
            .map(|f| format!("{f:?}\n"))
            .collect::<Vec<_>>()
            .join("");

        let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let pb_path = manifest_dir.join("fixtures/basic.pb");
        let txt_path = manifest_dir.join("fixtures/basic.txt");

        if std::env::var_os("UPDATE_FIXTURES").is_some() {
            std::fs::write(&pb_path, &bytes).unwrap();
            std::fs::write(&txt_path, &dump).unwrap();
            return;
        }

        let expected_bytes =
            std::fs::read(&pb_path).unwrap_or_else(|e| panic!("read {}: {e}", pb_path.display()));
        assert_eq!(
            bytes, expected_bytes,
            "fixtures/basic.pb is stale; regenerate with UPDATE_FIXTURES=1"
        );

        let expected_dump = std::fs::read_to_string(&txt_path)
            .unwrap_or_else(|e| panic!("read {}: {e}", txt_path.display()));
        assert_eq!(
            dump, expected_dump,
            "fixtures/basic.txt is stale; regenerate with UPDATE_FIXTURES=1"
        );
    }

    #[test]
    fn set_attribute_asset_round_trips() {
        let mut interner = Interner::new();
        let mut b = Batch::new();
        let src = interner.intern("src", &mut b);

        b.set_attribute_asset(1, src, None, b"deadbeef");

        let bytes = b.finish().expect("non-empty batch");
        let frames = decode_all(&bytes);

        let set_attribute = frames
            .iter()
            .find_map(|f| match &f.op {
                Some(proto::frame::Op::SetAttribute(sa)) => Some(sa),
                _ => None,
            })
            .expect("a SetAttribute frame");

        assert_eq!(
            set_attribute.value,
            Some(proto::set_attribute::Value::Asset(b"deadbeef".to_vec()))
        );
    }
}
