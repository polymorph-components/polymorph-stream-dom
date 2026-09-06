//! Drives a real `VirtualDom` through [`MutationWriter`] and checks the
//! resulting byte stream against the protocol's invariants
//! (proto/stream-dom.proto's file header):
//!
//! - every node id a frame *references* was defined by an earlier frame
//!   (`create-*` / `clone-template` / `bind-path`), or is `0`, the mount root;
//! - an `Intern` precedes the first use of every `str-ref`;
//! - exactly one frame carries `commit`, and it is the last;
//! - an `insert-before` without an anchor names a parent (`0` or previously
//!   defined); with an anchor it may omit the parent, which the anchor
//!   implies (proto/stream-dom.proto `InsertBefore`);
//! - every `insert-after` names a defined anchor.
//!
//! Native, not wasm: `writer.rs` names no WIT bindings precisely so this can
//! run under `cargo test`.

use std::cell::RefCell;
use std::rc::Rc;

use dioxus::prelude::*;
use dioxus_core::{ElementId, Runtime};
use prost::Message;
use stream_dom_dioxus::events::{StreamEventConverter, StreamEventData};
use stream_dom_dioxus::writer::MutationWriter;
use stream_dom_guest::proto;
use stream_dom_guest::{Interner, NodeId, StrRef};

/// Ids and slots a stream has defined so far. Carried across batches, since
/// the invariants are per *stream*, not per batch.
#[derive(Default)]
struct Known {
    nodes: std::collections::HashSet<NodeId>,
    slots: std::collections::HashSet<StrRef>,
    templates: std::collections::HashSet<u32>,
}

impl Known {
    fn new() -> Self {
        let mut k = Known::default();
        // `0` is the mount root and is never created by a frame.
        k.nodes.insert(0);
        k
    }

    fn node(&self, id: NodeId, what: &str) {
        assert!(
            self.nodes.contains(&id),
            "{what}: node id {id} used before any frame defined it"
        );
    }

    fn slot(&self, s: StrRef, what: &str) {
        assert!(
            self.slots.contains(&s),
            "{what}: str-ref {s} used before its Intern"
        );
    }
}

/// The node a listener was registered on.
///
/// `Listener.target` is a oneof: a node id, or a `Global` (`window` /
/// `document`). A Dioxus producer only ever reaches the first case —
/// `WriteMutations` names an `ElementId` and nothing else — so a `Global`
/// here means the writer invented a registration Dioxus never asked for.
fn listener_node(l: &proto::Listener, what: &str) -> NodeId {
    match l.target {
        Some(proto::listener::Target::Id(id)) => id,
        Some(proto::listener::Target::Global(g)) => {
            panic!("{what}: Dioxus has no global listeners, but one targets Global({g})")
        }
        None => panic!("{what}: listener frame with no target set"),
    }
}

fn decode_all(bytes: &[u8]) -> Vec<proto::Frame> {
    let mut buf = bytes;
    let mut frames = Vec::new();
    while !buf.is_empty() {
        frames.push(proto::Frame::decode_length_delimited(&mut buf).unwrap());
    }
    frames
}

/// Walk one batch, asserting the define-before-use invariants and updating
/// `known`. Returns the frames for further inspection.
fn check_batch(bytes: &[u8], known: &mut Known) -> Vec<proto::Frame> {
    let frames = decode_all(bytes);
    assert!(!frames.is_empty(), "a finished batch is never empty");

    let commits: Vec<usize> = frames
        .iter()
        .enumerate()
        .filter(|(_, f)| f.commit)
        .map(|(i, _)| i)
        .collect();
    assert_eq!(commits, vec![frames.len() - 1], "exactly one commit, last");

    for frame in &frames {
        let Some(op) = &frame.op else {
            panic!("an op-less frame is legal only for an empty batch");
        };
        use proto::frame::Op;
        match op {
            Op::Intern(i) => {
                known.slots.insert(i.id);
            }
            Op::CreateElement(c) => {
                known.slot(c.tag, "create-element tag");
                if let Some(ns) = c.ns {
                    known.slot(ns, "create-element ns");
                }
                known.nodes.insert(c.id);
            }
            Op::CreateText(c) => {
                known.nodes.insert(c.id);
            }
            Op::CreatePlaceholder(c) => {
                known.nodes.insert(c.id);
            }
            Op::RegisterTemplate(t) => {
                for node in &t.nodes {
                    if let Some(proto::template_node::Kind::Element(e)) = &node.kind {
                        known.slot(e.tag, "template element tag");
                        if let Some(ns) = e.ns {
                            known.slot(ns, "template element ns");
                        }
                        for a in &e.attrs {
                            known.slot(a.name, "template attr name");
                            if let Some(ns) = a.ns {
                                known.slot(ns, "template attr ns");
                            }
                        }
                        for &c in &e.children {
                            assert!(
                                (c as usize) < t.nodes.len(),
                                "template child index out of range"
                            );
                        }
                    }
                }
                for &r in &t.roots {
                    assert!((r as usize) < t.nodes.len(), "template root out of range");
                }
                known.templates.insert(t.id);
            }
            Op::CloneTemplate(c) => {
                assert!(
                    known.templates.contains(&c.tmpl),
                    "clone-template names unregistered template {}",
                    c.tmpl
                );
                known.nodes.insert(c.id);
            }
            Op::BindPath(b) => {
                known.node(b.root, "bind-path root");
                known.nodes.insert(b.id);
            }
            Op::InsertBefore(i) => {
                known.node(i.id, "insert-before id");
                if let Some(p) = i.parent {
                    known.node(p, "insert-before parent");
                }
                match i.anchor {
                    Some(a) => known.node(a, "insert-before anchor"),
                    // An append has no anchor to imply the parent, so the
                    // parent is required there and only there.
                    None => assert!(
                        i.parent.is_some(),
                        "insert-before with no anchor must name a parent"
                    ),
                }
            }
            Op::InsertAfter(i) => {
                known.node(i.id, "insert-after id");
                if let Some(p) = i.parent {
                    known.node(p, "insert-after parent");
                }
                known.node(i.anchor, "insert-after anchor");
            }
            Op::Remove(r) => known.node(r.id, "remove"),
            Op::SetText(s) => known.node(s.id, "set-text"),
            Op::SetAttribute(s) => {
                known.node(s.id, "set-attribute");
                known.slot(s.name, "set-attribute name");
                if let Some(ns) = s.ns {
                    known.slot(ns, "set-attribute ns");
                }
            }
            Op::SetProperty(s) => {
                known.node(s.id, "set-property");
                known.slot(s.name, "set-property name");
            }
            Op::AddListener(l) => {
                let l = l.listener.as_ref().unwrap();
                known.node(listener_node(l, "add-listener"), "add-listener");
                known.slot(l.name, "add-listener name");
            }
            Op::RemoveListener(l) => {
                let l = l.listener.as_ref().unwrap();
                known.node(listener_node(l, "remove-listener"), "remove-listener");
                known.slot(l.name, "remove-listener name");
            }
            Op::BindMarker(_) => panic!("bind-marker is hydration-only; this spike emits none"),
        }
    }

    frames
}

fn app() -> Element {
    let mut items = use_signal(|| vec![0u32, 1, 2]);
    rsx! {
        div { class: "list",
            h1 { "items" }
            ul {
                for id in items() {
                    li { key: "{id}", class: "item", "item {id}" }
                }
            }
            button {
                onclick: move |_| {
                    let next = items.read().len() as u32;
                    items.write().push(next);
                },
                "add"
            }
        }
    }
}

/// Dispatch a synthetic `click` at `element` and return the batch the
/// resulting re-render produced.
fn click(
    dom: &mut VirtualDom,
    runtime: &Rc<Runtime>,
    writer: &mut MutationWriter,
    element: ElementId,
) -> Option<Vec<u8>> {
    let event = dioxus_core::Event::new(
        Rc::new(dioxus_html::PlatformEventData::new(Box::new(
            StreamEventData::new(proto::EventPayload {
                family: Some(proto::event_payload::Family::Mouse(proto::MouseData {
                    button: Some(proto::MouseButton::Primary as i32),
                    primary: true,
                    ..Default::default()
                })),
            }),
        ))),
        true,
    );
    runtime.handle_event("click", event.into_any(), element);
    dom.render_immediate(writer);
    writer.batch.finish()
}

#[test]
fn rebuild_and_update_uphold_stream_invariants() {
    dioxus_html::set_event_converter(Box::new(StreamEventConverter));

    let interner = Rc::new(RefCell::new(Interner::new()));
    let mut writer = MutationWriter::new(interner.clone());
    let mut dom = VirtualDom::new(app);
    let runtime = dom.runtime();

    dom.rebuild(&mut writer);
    let first = writer.batch.finish().expect("mount produces a batch");

    let mut known = Known::new();
    let frames = check_batch(&first, &mut known);

    // Templates are core vocabulary, not an extension: a Dioxus mount clones
    // rather than creating node by node (docs/design.md "Templates are
    // core").
    assert!(
        frames
            .iter()
            .any(|f| matches!(f.op, Some(proto::frame::Op::RegisterTemplate(_)))),
        "mount registers at least one template"
    );
    assert!(
        frames
            .iter()
            .any(|f| matches!(f.op, Some(proto::frame::Op::CloneTemplate(_)))),
        "mount clones templates"
    );
    // No stack machine reaches the wire: the mount's append names the mount
    // root explicitly.
    assert!(
        frames.iter().any(
            |f| matches!(&f.op, Some(proto::frame::Op::InsertBefore(i)) if i.parent == Some(0))
        ),
        "the mount attaches something to the mount root"
    );

    // Find the button's listener so the state change can be driven through a
    // real dispatch.
    let click_node = frames
        .iter()
        .find_map(|f| match &f.op {
            Some(proto::frame::Op::AddListener(l)) => {
                let l = l.listener.as_ref().unwrap();
                (interner.borrow().resolve(l.name) == Some("click"))
                    .then(|| listener_node(l, "add-listener"))
            }
            _ => None,
        })
        .expect("the button registers a click listener");
    let click_el = writer
        .element_of(click_node)
        .expect("the listener's node is a live ElementId");

    let second = click(&mut dom, &runtime, &mut writer, click_el)
        .expect("appending an item produces a batch");
    let frames2 = check_batch(&second, &mut known);

    // The appended `li` has to reach the DOM somehow, and every route is an
    // explicit insert-before.
    assert!(
        frames2
            .iter()
            .any(|f| matches!(f.op, Some(proto::frame::Op::InsertBefore(_)))),
        "the update inserts the new row"
    );

    // Did the update go through `insert_nodes_after`? With `insert-after` on
    // the wire that path is now one op per node, chained anchor-to-anchor,
    // and the old move-back trick (insert the new nodes *before* the anchor,
    // then move the anchor back in front of them) is gone. A move-back shows
    // up as an insert-before whose `id` was defined in an *earlier* batch and
    // whose anchor is one of the just-inserted nodes.
    let mut defined_here = std::collections::HashSet::new();
    let mut saw_move_back = false;
    let mut saw_insert_after = false;
    for f in &frames2 {
        match &f.op {
            Some(proto::frame::Op::CloneTemplate(c)) => {
                defined_here.insert(c.id);
            }
            Some(proto::frame::Op::CreateText(c)) => {
                defined_here.insert(c.id);
            }
            Some(proto::frame::Op::CreatePlaceholder(c)) => {
                defined_here.insert(c.id);
            }
            Some(proto::frame::Op::CreateElement(c)) => {
                defined_here.insert(c.id);
            }
            Some(proto::frame::Op::InsertBefore(i)) => {
                if !defined_here.contains(&i.id)
                    && i.anchor.is_some_and(|a| defined_here.contains(&a))
                {
                    saw_move_back = true;
                }
            }
            Some(proto::frame::Op::InsertAfter(_)) => saw_insert_after = true,
            _ => {}
        }
    }
    // Appending to the end of a keyed list is dioxus-core 0.7.10's
    // `insert_nodes_after` (src/diff/iterator.rs:467). Asserted rather than
    // merely recorded because the dependency is pinned `=0.7.10`: if a Dioxus
    // upgrade changes the diffing decision, this should say so loudly rather
    // than silently stop covering the path.
    assert!(
        saw_insert_after,
        "the keyed-list append should reach the wire as insert-after"
    );
    assert!(
        !saw_move_back,
        "insert-after replaced the move-back op; nothing should move an \
         existing node in front of the nodes just inserted"
    );

    // The lazy-interior symptom: the old writer bound template interiors it
    // never otherwise named, purely so `insert-before` could state a parent.
    // Every `bind-path` must now be a node something else refers to.
    let mut bound = Vec::new();
    let mut referenced = std::collections::HashSet::new();
    for f in frames.iter().chain(frames2.iter()) {
        use proto::frame::Op;
        match &f.op {
            Some(Op::BindPath(b)) => {
                bound.push(b.id);
                referenced.insert(b.root);
            }
            Some(Op::InsertBefore(i)) => {
                referenced.extend(i.parent);
                referenced.insert(i.id);
                referenced.extend(i.anchor);
            }
            Some(Op::InsertAfter(i)) => {
                referenced.extend(i.parent);
                referenced.insert(i.id);
                referenced.insert(i.anchor);
            }
            Some(Op::Remove(r)) => {
                referenced.insert(r.id);
            }
            Some(Op::SetText(t)) => {
                referenced.insert(t.id);
            }
            Some(Op::SetAttribute(a)) => {
                referenced.insert(a.id);
            }
            Some(Op::SetProperty(p)) => {
                referenced.insert(p.id);
            }
            Some(Op::AddListener(l)) => {
                let l = l.listener.as_ref().unwrap();
                referenced.insert(listener_node(l, "add-listener"));
            }
            Some(Op::RemoveListener(l)) => {
                let l = l.listener.as_ref().unwrap();
                referenced.insert(listener_node(l, "remove-listener"));
            }
            _ => {}
        }
    }
    assert!(!bound.is_empty(), "this app does bind template interiors");
    for id in bound {
        assert!(
            referenced.contains(&id),
            "bind-path defined node {id} that no other frame references"
        );
    }
}

#[test]
fn removed_nodes_stop_resolving_to_elements() {
    // Ids are never reused and `remove` drops the forward/reverse pair, so an
    // event arriving late for a removed node finds nothing — the protocol's
    // "an event for an unknown id is dropped" (proto/stream-dom.proto header).
    let interner = Rc::new(RefCell::new(Interner::new()));
    let mut writer = MutationWriter::new(interner);
    let mut dom = VirtualDom::new(app);
    dom.rebuild(&mut writer);
    let bytes = writer.batch.finish().unwrap();

    let live: Vec<NodeId> = decode_all(&bytes)
        .iter()
        .filter_map(|f| match &f.op {
            Some(proto::frame::Op::CloneTemplate(c)) => Some(c.id),
            _ => None,
        })
        .collect();
    assert!(!live.is_empty());
    for n in live {
        // Every cloned root is a live ElementId right after the mount.
        assert!(writer.element_of(n).is_some(), "node {n} should be live");
    }
    // A node id that was never handed out resolves to nothing.
    assert!(writer.element_of(u32::MAX).is_none());
}

/// The attribute-vs-property table, which is dioxus-web's
/// (dioxus-interpreter-js-0.7.10 src/js/set_attribute.js `setAttributeInner`)
/// re-expressed as protocol ops.
///
/// The coercion is the whole point: `checked` reaches a renderer as
/// `AttributeValue::Text("true"|"false")` whenever the app writes
/// `checked: "{signal}"` — which Dioxus's own TodoMVC does — and forwarding
/// that string as a property makes the receiver assign `el.checked = "false"`,
/// a truthy value. `truthy(value)` has to happen producer-side, here.
fn attrs_app() -> Element {
    let flag = use_signal(|| false);
    let text = use_signal(|| "x".to_string());
    rsx! {
        input { r#type: "checkbox", checked: "{flag}" }
        input { r#type: "checkbox", checked: true }
        // Dynamic, not literal: a literal would be folded into the template
        // arena and never reach `set_attribute` at all.
        input { disabled: flag() }
        input { value: "{text}" }
    }
}

#[test]
fn attribute_property_table_matches_dioxus_web() {
    let interner = Rc::new(RefCell::new(Interner::new()));
    let mut writer = MutationWriter::new(interner.clone());
    let mut dom = VirtualDom::new(attrs_app);
    dom.rebuild(&mut writer);
    let bytes = writer.batch.finish().expect("mount produces a batch");

    let mut props: Vec<(String, Option<proto::set_property::Value>)> = Vec::new();
    let mut attrs: Vec<(String, Option<String>)> = Vec::new();
    for f in decode_all(&bytes) {
        match f.op {
            Some(proto::frame::Op::SetProperty(p)) => props.push((
                interner.borrow().resolve(p.name).unwrap().to_string(),
                p.value,
            )),
            Some(proto::frame::Op::SetAttribute(a)) => attrs.push((
                interner.borrow().resolve(a.name).unwrap().to_string(),
                a.value,
            )),
            _ => {}
        }
    }

    // `checked: "{flag}"` — a *string* "false" — must become Boolean(false),
    // not Text("false").
    assert!(
        props.contains(&(
            "checked".to_string(),
            Some(proto::set_property::Value::Boolean(false))
        )),
        "checked: \"{{false}}\" must coerce to Boolean(false); got {props:?}"
    );
    // `checked: true` — a real bool — is the same property, Boolean(true).
    assert!(
        props.contains(&(
            "checked".to_string(),
            Some(proto::set_property::Value::Boolean(true))
        )),
        "checked: true must be Boolean(true); got {props:?}"
    );
    // `value` is assigned as-is, no coercion.
    assert!(
        props.contains(&(
            "value".to_string(),
            Some(proto::set_property::Value::Text("x".to_string()))
        )),
        "value must pass through as Text; got {props:?}"
    );
    // `disabled: false` is a falsy value on an `isBoolAttr` name: an
    // attribute *removal*, not `disabled="false"`.
    assert!(
        attrs.contains(&("disabled".to_string(), None)),
        "disabled: false must remove the attribute; got {attrs:?}"
    );
    // Nothing in this table routes a boolean-attribute name to a property.
    for (name, _) in &props {
        assert!(
            !matches!(name.as_str(), "disabled" | "muted" | "multiple"),
            "{name} is a boolean attribute in dioxus-web, not a property"
        );
    }
}

/// Each row's `button` is a template interior with its own node id, so
/// removing a row must forget the button too.
fn removable_list() -> Element {
    let mut items = use_signal(|| vec![0u32, 1, 2]);
    rsx! {
        ul {
            for id in items() {
                li { key: "{id}",
                    button {
                        class: "del-{id}",
                        onclick: move |_| items.write().retain(|&i| i != id),
                        "x"
                    }
                }
            }
        }
    }
}

#[test]
fn removing_a_node_forgets_its_descendants() {
    // A `Remove` frees the whole subtree receiver-side. If the producer keeps
    // a descendant in its reverse map, that descendant's `ElementId` — which
    // Dioxus has already freed back into its slab — will be handed to
    // `runtime.handle_event` for any late event naming the dead node id, and
    // once the slab reuses the slot that lands on an unrelated live node.
    // Never-reused ids only prevent that misroute if the producer forgets the
    // subtree, so this asserts it does.
    dioxus_html::set_event_converter(Box::new(StreamEventConverter));

    let interner = Rc::new(RefCell::new(Interner::new()));
    let mut writer = MutationWriter::new(interner.clone());
    let mut dom = VirtualDom::new(removable_list);
    let runtime = dom.runtime();
    dom.rebuild(&mut writer);
    let bytes = writer.batch.finish().expect("mount produces a batch");

    // The row buttons, identified by their dynamic `class`. These are
    // `bind-path`'d interiors of each row's template clone — descendants, not
    // the ids the `Remove` will name.
    let mut buttons: Vec<(String, NodeId)> = Vec::new();
    for f in decode_all(&bytes) {
        if let Some(proto::frame::Op::SetAttribute(a)) = f.op {
            if interner.borrow().resolve(a.name) == Some("class") {
                if let Some(v) = a.value {
                    buttons.push((v, a.id));
                }
            }
        }
    }
    assert_eq!(buttons.len(), 3, "one button per row; got {buttons:?}");
    let victim = buttons
        .iter()
        .find(|(c, _)| c == "del-0")
        .expect("row 0's button")
        .1;
    let survivor = buttons
        .iter()
        .find(|(c, _)| c == "del-1")
        .expect("row 1's button")
        .1;

    let victim_el = writer.element_of(victim).expect("button is live at mount");
    click(&mut dom, &runtime, &mut writer, victim_el).expect("removing a row produces a batch");

    assert!(
        writer.element_of(victim).is_none(),
        "the removed row's button (node {victim}) still resolves to an ElementId"
    );
    assert!(
        writer.element_of(survivor).is_some(),
        "an untouched row's button (node {survivor}) must stay live"
    );
}
