//! The `polymorph:stream-dom` producer: a shadow DOM whose every mutation
//! also emits a `Frame`.
//!
//! Invariants this module is responsible for (proto/stream-dom.proto file
//! header, docs/design.md "Every op is addressable and self-contained"):
//!
//! - Node ids are allocated here, monotonically, and never reused. `0` is
//!   the mount root, which is not created by any frame.
//! - Interned slots are defined before first use, because every name goes
//!   through [`Interner::intern`], which pushes its `Intern` frame into
//!   the same batch immediately before the op that uses it.
//! - A batch is closed by [`Batch::finish`], which sets `commit` on the
//!   last frame and only there (docs/design.md "Batches are framed by a
//!   `commit` flag").
//! - Moving an attached node is a bare `insert-before`, no `remove`: the
//!   DOM's own `insertBefore` semantics, which the protocol adopts.

use std::cell::RefCell;
use std::rc::Rc;
use std::task::Waker;

use stream_dom_guest::proto::set_property::Value as PropValue;
use stream_dom_guest::{proto, Batch, Ids, Interner, NodeId, StrRef};
use wasm_bindgen::JsValue;

use crate::node::{NodeData, NodeKind};

/// Imperative host actions a mutation cannot express. Queued during a
/// batch and run by the driver *after* the batch is sent, so the host has
/// the nodes the action names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Effect {
    /// `HTMLElement.focus()` / `.blur()`, answered by the WIT
    /// `queries.set-focus` import.
    Focus(NodeId, bool),
}

pub struct Dom {
    ids: Ids,
    interner: Interner,
    batch: Batch,
    root: Rc<NodeData>,
    document: Rc<NodeData>,
    window: Rc<NodeData>,
    effects: Vec<Effect>,
    /// Set by every mutation; cleared when the driver takes the batch.
    dirty: bool,
    /// The flusher task's waker, parked between batches.
    waker: Option<Waker>,
}

impl Dom {
    fn new() -> Dom {
        let mut ids = Ids::new();
        // The mount root is id 0 by protocol and is never created by a
        // frame: the receiver already has it. It is element-like so that
        // `append_child` works on it, with no tag of its own.
        let root = NodeData::element(0, "", None);
        // `document` and `window` are event targets and factories, never
        // addressed on the wire. They still need ids the allocator will
        // not hand to a real node, so they take ordinary allocations that
        // simply never appear in a frame.
        let document = NodeData::document(ids.alloc());
        let window = NodeData::window(ids.alloc());
        Dom {
            ids,
            interner: Interner::new(),
            batch: Batch::new(),
            root,
            document,
            window,
            effects: Vec::new(),
            dirty: false,
            waker: None,
        }
    }
}

thread_local! {
    static DOM: RefCell<Option<Dom>> = const { RefCell::new(None) };
}

/// Borrow the singleton, creating it on first touch.
///
/// Lazy rather than explicitly installed so that each `cargo test` thread
/// gets its own fresh DOM without a fixture, and so the driver's `run`
/// does not have to sequence installation against the app's first call.
fn with_dom<R>(f: impl FnOnce(&mut Dom) -> R) -> R {
    DOM.with(|d| {
        let mut d = d.borrow_mut();
        f(d.get_or_insert_with(Dom::new))
    })
}

// --- Singletons -------------------------------------------------------

pub fn mount_root() -> JsValue {
    with_dom(|d| d.root.value())
}

pub fn document() -> JsValue {
    with_dom(|d| d.document.value())
}

pub fn window() -> JsValue {
    with_dom(|d| d.window.value())
}

// --- Batch plumbing ---------------------------------------------------

/// Mark the batch dirty and wake the flusher task. Every mutation below
/// ends with this.
pub fn request_flush() {
    let waker = with_dom(|d| {
        d.dirty = true;
        d.waker.take()
    });
    if let Some(w) = waker {
        w.wake();
    }
}

/// Park the flusher task until a mutation happens. Returns `true` when
/// there is a batch to send.
pub fn take_dirty(waker: &Waker) -> bool {
    with_dom(|d| {
        if d.dirty {
            d.dirty = false;
            true
        } else {
            d.waker = Some(waker.clone());
            false
        }
    })
}

/// Close the current batch: the last frame carries `commit`. `None` when
/// nothing was mutated (there is no op-less commit frame to emit — see
/// `stream_dom_guest::Batch::finish`).
pub fn take_batch() -> Option<Vec<u8>> {
    with_dom(|d| {
        d.dirty = false;
        d.batch.finish()
    })
}

pub fn take_effects() -> Vec<Effect> {
    with_dom(|d| std::mem::take(&mut d.effects))
}

/// Resolve an event name slot back to its string, for `handle-event`.
pub fn resolve_name(slot: StrRef) -> Option<String> {
    with_dom(|d| d.interner.resolve(slot).map(str::to_string))
}

/// The node an incoming event names, or `None` if it is gone. Ids are
/// never reused, so an unknown id is a removed node racing an event
/// already in flight on the unordered reverse channel — the protocol says
/// drop it (proto/stream-dom.proto file header).
///
/// A walk of the live tree rather than an id map: a map would have to be
/// pruned on `remove` to avoid resurrecting detached nodes, and the tree
/// is the authority on what is still attached.
pub fn node_by_id(id: NodeId) -> Option<Rc<NodeData>> {
    fn walk(n: &Rc<NodeData>, id: NodeId) -> Option<Rc<NodeData>> {
        if n.id == id {
            return Some(n.clone());
        }
        n.children().iter().find_map(|c| walk(c, id))
    }
    let root = with_dom(|d| d.root.clone());
    walk(&root, id)
}

// --- Node construction ------------------------------------------------

pub fn create_element(tag: &str, ns: Option<&str>) -> JsValue {
    let node = with_dom(|d| {
        let id = d.ids.alloc();
        let tag_ref = d.interner.intern(tag, &mut d.batch);
        let ns_ref = ns.map(|ns| d.interner.intern(ns, &mut d.batch));
        d.batch.create_element(id, tag_ref, ns_ref);
        NodeData::element(id, tag, ns)
    });
    request_flush();
    JsValue::from_object(node)
}

pub fn create_text(data: &str) -> JsValue {
    let node = with_dom(|d| {
        let id = d.ids.alloc();
        d.batch.create_text(id, data);
        NodeData::text(id, data)
    });
    request_flush();
    JsValue::from_object(node)
}

/// A comment node. On the wire this is `CreatePlaceholder`, which carries
/// no text: see [`crate::node::NodeKind::Comment`].
pub fn create_comment() -> JsValue {
    let node = with_dom(|d| {
        let id = d.ids.alloc();
        d.batch.create_placeholder(id);
        NodeData::comment(id)
    });
    request_flush();
    JsValue::from_object(node)
}

// --- Tree mutation ----------------------------------------------------

/// `parent.insertBefore(child, anchor)`. If `child` is already attached
/// this is a move, and the protocol expresses it as a bare `insert-before`
/// with no preceding `remove` — see docs/design.md "Tree ops are
/// `insert-before(parent, id, anchor?)`".
pub fn insert_before(parent: &NodeData, child: &NodeData, anchor: Option<&NodeData>) {
    // Detach in the shadow first, so an intra-parent move computes its
    // anchor against the post-detach child list, exactly as the DOM does.
    detach_from_parent(child);

    let child_rc = child.rc();
    let index = match anchor {
        Some(a) => parent.index_of_child(a).unwrap_or_else(|| {
            panic!("fakedom: insertBefore anchor is not a child of the given parent")
        }),
        None => parent.children().len(),
    };
    parent.children_mut().insert(index, child_rc);
    child.set_parent(Some(&parent.rc()));

    with_dom(|d| {
        d.batch
            .insert_before(parent.id, child.id, anchor.map(|a| a.id))
    });
    request_flush();
}

pub fn remove_child(parent: &NodeData, child: &NodeData) {
    assert!(
        parent.index_of_child(child).is_some(),
        "fakedom: removeChild called with a node that is not a child of the given parent"
    );
    detach_from_parent(child);
    // `Remove` frees the whole subtree on the receiver; the producer knows
    // the tree, so nothing else is emitted for the descendants. Their ids
    // are simply never used again.
    with_dom(|d| d.batch.remove(child.id));
    request_flush();
}

/// `parent.replaceChild(new, old)`: insert before `old`, then remove it.
pub fn replace_child(parent: &NodeData, new: &NodeData, old: &NodeData) {
    insert_before(parent, new, Some(old));
    remove_child(parent, old);
}

fn detach_from_parent(child: &NodeData) {
    if let Some(parent) = child.parent() {
        if let Some(i) = parent.index_of_child(child) {
            parent.children_mut().remove(i);
        }
        child.set_parent(None);
    }
}

// --- Character data ---------------------------------------------------

pub fn set_data(node: &NodeData, data: &str) {
    node.set_text_data(data);
    with_dom(|d| d.batch.set_text(node.id, data));
    request_flush();
}

/// `Node.textContent = ...`. On a text node it is the text; on an element
/// the DOM replaces every child with a single text node, which the
/// protocol expresses as the `textContent` property (docs/design.md
/// "`set-attribute` and `set-property` are distinct": the producer decides,
/// and a framework asking for `textContent` is asking for the property).
pub fn set_text_content(node: &NodeData, data: Option<&str>) {
    match node.kind {
        NodeKind::Text { .. } => set_data(node, data.unwrap_or("")),
        NodeKind::Element { .. } => {
            // The DOM discards the old children, so the receiver must be
            // told: without a `remove` per child its shadow keeps nodes
            // whose ids are never freed again. `Remove` frees each
            // subtree, so only the direct children are named.
            let old: Vec<Rc<NodeData>> = node.children_mut().drain(..).collect();
            for child in old {
                child.set_parent(None);
                with_dom(|d| d.batch.remove(child.id));
            }
            set_property(
                node,
                "textContent",
                PropValue::Text(data.unwrap_or("").into()),
            );
        }
        _ => panic!("fakedom: textContent is not settable on this node kind"),
    }
}

// --- Attributes -------------------------------------------------------

pub fn set_attribute(node: &NodeData, name: &str, ns: Option<&str>, value: &str) {
    let NodeKind::Element { attrs, .. } = &node.kind else {
        panic!("fakedom: setAttribute on a non-element node");
    };
    {
        let mut attrs = attrs.borrow_mut();
        match attrs
            .iter_mut()
            .find(|(n, a_ns, _)| n == name && a_ns.as_deref() == ns)
        {
            Some(slot) => slot.2 = value.to_string(),
            None => attrs.push((name.to_string(), ns.map(str::to_string), value.to_string())),
        }
    }
    emit_attribute(node, name, ns, Some(value));
}

pub fn remove_attribute(node: &NodeData, name: &str, ns: Option<&str>) {
    let NodeKind::Element { attrs, .. } = &node.kind else {
        panic!("fakedom: removeAttribute on a non-element node");
    };
    attrs
        .borrow_mut()
        .retain(|(n, a_ns, _)| !(n == name && a_ns.as_deref() == ns));
    emit_attribute(node, name, ns, None);
}

fn emit_attribute(node: &NodeData, name: &str, ns: Option<&str>, value: Option<&str>) {
    with_dom(|d| {
        let name_ref = d.interner.intern(name, &mut d.batch);
        let ns_ref = ns.map(|ns| d.interner.intern(ns, &mut d.batch));
        d.batch.set_attribute(node.id, name_ref, ns_ref, value);
    });
    request_flush();
}

// --- classList --------------------------------------------------------

fn classes_of(node: &NodeData) -> &RefCell<Vec<String>> {
    match &node.kind {
        NodeKind::Element { classes, .. } => classes,
        _ => panic!("fakedom: classList on a non-element node"),
    }
}

/// The `class` attribute is rewritten wholesale from the ordered class
/// list: the protocol has no token-list op, and `set-attribute` is
/// last-write-wins, which is exactly what a coalescer wants.
fn rewrite_class(node: &NodeData) {
    let joined = classes_of(node).borrow().join(" ");
    set_attribute(node, "class", None, &joined);
}

pub fn class_add(node: &NodeData, value: &str) {
    {
        let classes = classes_of(node);
        let mut classes = classes.borrow_mut();
        if classes.iter().any(|c| c == value) {
            return;
        }
        classes.push(value.to_string());
    }
    rewrite_class(node);
}

pub fn class_remove(node: &NodeData, value: &str) {
    {
        let classes = classes_of(node);
        let mut classes = classes.borrow_mut();
        let before = classes.len();
        classes.retain(|c| c != value);
        if classes.len() == before {
            return;
        }
    }
    rewrite_class(node);
}

// --- style ------------------------------------------------------------

fn style_of(node: &NodeData) -> &RefCell<Vec<(String, String)>> {
    match &node.kind {
        NodeKind::Element { style, .. } => style,
        _ => panic!("fakedom: style on a non-element node"),
    }
}

/// Same reasoning as [`rewrite_class`]: the `style` attribute is rebuilt
/// from the ordered declaration list on every change.
fn rewrite_style(node: &NodeData) {
    let text = style_of(node)
        .borrow()
        .iter()
        .map(|(n, v)| format!("{n}: {v};"))
        .collect::<Vec<_>>()
        .join(" ");
    set_attribute(node, "style", None, &text);
}

pub fn style_get(node: &NodeData, name: &str) -> String {
    style_of(node)
        .borrow()
        .iter()
        .find(|(n, _)| n == name)
        .map(|(_, v)| v.clone())
        .unwrap_or_default()
}

/// `important` is dropped: the protocol's `set-attribute` carries the
/// whole `style` string, and `!important` inside it round-trips through
/// the receiver's own CSS parser, so it is written into the value.
pub fn style_set(node: &NodeData, name: &str, value: &str, important: bool) {
    let value = if important {
        format!("{value} !important")
    } else {
        value.to_string()
    };
    {
        let style = style_of(node);
        let mut style = style.borrow_mut();
        match style.iter_mut().find(|(n, _)| n == name) {
            Some(slot) => slot.1 = value,
            None => style.push((name.to_string(), value)),
        }
    }
    rewrite_style(node);
}

pub fn style_remove(node: &NodeData, name: &str) -> String {
    let old = style_get(node, name);
    style_of(node).borrow_mut().retain(|(n, _)| n != name);
    rewrite_style(node);
    old
}

// --- Properties -------------------------------------------------------

pub fn set_property(node: &NodeData, name: &str, value: PropValue) {
    node.set_prop_local(name, prop_to_js(&value));
    with_dom(|d| {
        let name_ref = d.interner.intern(name, &mut d.batch);
        d.batch.set_property(node.id, name_ref, Some(value));
    });
    request_flush();
}

/// `Reflect.set(node, name, value)` — how dominator writes DOM properties
/// (`.prop(...)`, via dominator-0.5.38/src/bindings.rs:12).
///
/// CONTRACT: every name goes out as `SetProperty`, not just a known
/// subset. docs/design.md "`set-attribute` and `set-property` are
/// distinct" makes this the producer adapter's call, and a framework
/// reaching for `Reflect.set` on a node has already made it: it asked for
/// a property. Keeping unrecognised names producer-local would silently
/// drop `.prop("customThing", ...)`.
pub fn reflect_set(node: &NodeData, name: &str, value: JsValue) {
    match js_to_prop(&value) {
        Some(v) => set_property(node, name, v),
        None => {
            // No `value` case set means "delete / set undefined"
            // (proto/stream-dom.proto, `SetProperty`).
            node.remove_prop_local(name);
            with_dom(|d| {
                let name_ref = d.interner.intern(name, &mut d.batch);
                d.batch.set_property(node.id, name_ref, None);
            });
            request_flush();
        }
    }
}

fn js_to_prop(value: &JsValue) -> Option<PropValue> {
    if let Some(s) = value.as_string() {
        return Some(PropValue::Text(s));
    }
    if let Some(b) = value.as_bool() {
        return Some(PropValue::Boolean(b));
    }
    if let Some(n) = value.as_f64() {
        return Some(PropValue::Float(n));
    }
    if value.is_undefined() || value.is_null() {
        return None;
    }
    panic!("fakedom: cannot set a DOM property to a non-primitive value ({value:?})");
}

fn prop_to_js(value: &PropValue) -> JsValue {
    match value {
        PropValue::Text(s) => JsValue::from_str(s),
        PropValue::Int(i) => JsValue::from_f64(*i as f64),
        PropValue::Float(f) => JsValue::from_f64(*f),
        PropValue::Boolean(b) => JsValue::from_bool(*b),
    }
}

// --- Listeners --------------------------------------------------------

/// Which event names bubble. The receiver needs the producer's verdict so
/// it can delegate bubbling events at the mount root and attach
/// non-bubbling ones per element (proto/stream-dom.proto, `Listener`;
/// docs/design.md "Events"). The list follows the DOM: the events below
/// are the non-bubbling ones, everything else bubbles.
pub fn name_bubbles(name: &str) -> bool {
    !matches!(
        name,
        "focus"
            | "blur"
            | "mouseenter"
            | "mouseleave"
            | "pointerenter"
            | "pointerleave"
            | "load"
            | "error"
            | "scroll"
            | "scrollend"
    )
}

/// The protocol addresses nodes under the mount root and nothing above it
/// (proto/stream-dom.proto: "`0` is the mount root"), so `window` and
/// `document` have no id a receiver could resolve. A listener on either
/// would emit a frame naming a node the receiver never saw, breaking
/// define-before-use — so it is refused here rather than silently
/// mis-addressed. Reached by `dominator::routing` (a `popstate` listener
/// on `window`) and by its media-query support; neither is used by the
/// TodoMVC port. See the report: this is a genuine gap in the protocol,
/// not just in this shim.
fn assert_addressable(node: &NodeData, what: &str) {
    assert!(
        !matches!(node.kind, NodeKind::Window | NodeKind::Document),
        "fakedom: {what} on window/document has no addressable target in \
         polymorph:stream-dom; the receiver owns everything above the mount root"
    );
}

pub fn add_listener(node: &NodeData, name: &str, capture: bool, passive: bool, callback: JsValue) {
    assert_addressable(node, "addEventListener");

    // One `AddListener` per (node, name) however many callbacks are
    // registered: the receiver dispatches once per event and this shim
    // fans out to all of them.
    let first = !node.has_listener_named(name);
    node.listeners_mut().push(crate::node::Listener {
        name: name.to_string(),
        capture,
        passive,
        callback,
    });
    if first {
        with_dom(|d| {
            let name_ref = d.interner.intern(name, &mut d.batch);
            d.batch
                .add_listener(listener_msg(node.id, name_ref, name, capture, passive));
        });
        request_flush();
    }
}

pub fn remove_listener(node: &NodeData, name: &str, callback: &JsValue, capture: bool) {
    assert_addressable(node, "removeEventListener");
    {
        let mut listeners = node.listeners_mut();
        if let Some(i) = listeners
            .iter()
            .position(|l| l.name == name && l.capture == capture && &l.callback == callback)
        {
            listeners.remove(i);
        }
    }
    if !node.has_listener_named(name) {
        with_dom(|d| {
            let name_ref = d.interner.intern(name, &mut d.batch);
            d.batch
                .remove_listener(listener_msg(node.id, name_ref, name, capture, false));
        });
        request_flush();
    }
}

fn listener_msg(
    id: NodeId,
    name_ref: StrRef,
    name: &str,
    capture: bool,
    passive: bool,
) -> proto::Listener {
    proto::Listener {
        id,
        name: name_ref,
        bubbles: name_bubbles(name),
        capture,
        passive,
        // The declarative flags are the remote-receiver path
        // (docs/design.md "Events", option C). This producer takes the
        // in-process path: handlers call `prevent_default()` imperatively
        // and the driver forwards it on the live `dom-event` before
        // `handle-event` returns.
        prevent_default: false,
        stop_propagation: false,
    }
}

// --- Effects ----------------------------------------------------------

pub fn queue_focus(node: &NodeData, focus: bool) {
    with_dom(|d| d.effects.push(Effect::Focus(node.id, focus)));
    request_flush();
}
