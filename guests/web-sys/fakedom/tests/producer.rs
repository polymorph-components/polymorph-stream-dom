//! What the producer puts on the wire, and what it does with an event
//! coming back — driven through the same `web_sys` API a framework uses,
//! so the shim's translation is under test alongside the DOM model.
//!
//! The frames are checked against the invariants
//! proto/stream-dom.proto's file header states, not against a golden
//! byte string: those invariants (define-before-use, one commit on the
//! last frame, a move is a bare `insert-before`) are the contract a
//! receiver relies on.
//!
//! The DOM singleton is a thread-local and libtest gives each test its own
//! thread, so every test here starts from an empty tree.

use prost::Message;
use std::cell::RefCell;
use std::rc::Rc;
use stream_dom_fakedom::dom;
use stream_dom_fakedom::event::{dispatch, Verdict};
use stream_dom_guest::proto::{self, frame::Op};
use wasm_bindgen::closure::Closure;
use wasm_bindgen::{JsCast, JsValue};
use web_sys::{Element, Event, HtmlElement, HtmlInputElement, Node};

fn decode_all(bytes: &[u8]) -> Vec<proto::Frame> {
    let mut buf = bytes;
    let mut frames = Vec::new();
    while !buf.is_empty() {
        frames.push(proto::Frame::decode_length_delimited(&mut buf).unwrap());
    }
    frames
}

/// Close the batch and decode it.
fn frames() -> Vec<proto::Frame> {
    decode_all(&dom::take_batch().expect("a non-empty batch"))
}

/// `web_sys::window()` is `js_sys::global().dyn_into::<Window>()`, so the
/// fake DOM has to have installed `globalThis` before the first call. The
/// driver does this in `run`; a test fixture has to do it itself.
fn document() -> web_sys::Document {
    stream_dom_fakedom::install();
    web_sys::window().unwrap().document().unwrap()
}

/// The protocol's mount root (node id 0) as a `Node`. `document.body` is
/// the same node -- see `stream_dom_fakedom::protocol`.
fn mount_root() -> Node {
    Node::from(dom::mount_root())
}

fn element(tag: &str) -> Element {
    document().create_element(tag).unwrap()
}

/// Register a listener and leak the closure, as `gloo_events` does.
fn listen(target: &web_sys::EventTarget, name: &str, f: impl FnMut(&Event) + 'static) {
    let cb = Closure::wrap(Box::new(f) as Box<dyn FnMut(&Event)>);
    target
        .add_event_listener_with_callback(name, cb.as_ref().unchecked_ref())
        .unwrap();
    cb.forget();
}

/// Every node id an op names must have been created earlier in the same
/// stream (or be `0`, the mount root), and every `str_ref` must have been
/// defined by an earlier `Intern`. proto/stream-dom.proto file header.
fn assert_define_before_use(frames: &[proto::Frame]) {
    let mut nodes: Vec<u32> = vec![0];
    let mut slots: Vec<u32> = Vec::new();

    let mut used_node = |nodes: &[u32], id: u32, what: &str| {
        assert!(nodes.contains(&id), "{what} names uncreated node id {id}");
    };
    let mut used_slot = |slots: &[u32], r: u32, what: &str| {
        assert!(slots.contains(&r), "{what} names undefined str-ref {r}");
    };

    for f in frames {
        match f.op.as_ref().expect("no op-less frames in these batches") {
            Op::Intern(i) => {
                assert!(!slots.contains(&i.id), "slot {} defined twice", i.id);
                slots.push(i.id);
            }
            Op::CreateElement(c) => {
                used_slot(&slots, c.tag, "create-element tag");
                if let Some(ns) = c.ns {
                    used_slot(&slots, ns, "create-element ns");
                }
                nodes.push(c.id);
            }
            Op::CreateText(c) => nodes.push(c.id),
            Op::CreatePlaceholder(c) => nodes.push(c.id),
            Op::InsertBefore(i) => {
                used_node(&nodes, i.parent, "insert-before parent");
                used_node(&nodes, i.id, "insert-before id");
                if let Some(a) = i.anchor {
                    used_node(&nodes, a, "insert-before anchor");
                }
            }
            Op::Remove(r) => used_node(&nodes, r.id, "remove"),
            Op::SetText(t) => used_node(&nodes, t.id, "set-text"),
            Op::SetAttribute(a) => {
                used_node(&nodes, a.id, "set-attribute");
                used_slot(&slots, a.name, "set-attribute name");
                if let Some(ns) = a.ns {
                    used_slot(&slots, ns, "set-attribute ns");
                }
            }
            Op::SetProperty(p) => {
                used_node(&nodes, p.id, "set-property");
                used_slot(&slots, p.name, "set-property name");
            }
            Op::AddListener(proto::AddListener { listener })
            | Op::RemoveListener(proto::RemoveListener { listener }) => {
                let l = listener.as_ref().unwrap();
                used_node(&nodes, l.id, "listener");
                used_slot(&slots, l.name, "listener name");
            }
            other => panic!("unexpected op in these batches: {other:?}"),
        }
    }
}

/// `commit` marks the last frame of a batch and only that one
/// (docs/design.md "Batches are framed by a `commit` flag").
fn assert_single_trailing_commit(frames: &[proto::Frame]) {
    let (last, rest) = frames.split_last().expect("a non-empty batch");
    assert!(last.commit, "the last frame must commit");
    for f in rest {
        assert!(!f.commit, "only the last frame commits");
    }
}

fn attribute_writes<'a>(frames: &'a [proto::Frame], name_slot: u32) -> Vec<Option<&'a str>> {
    frames
        .iter()
        .filter_map(|f| match &f.op {
            Some(Op::SetAttribute(a)) if a.name == name_slot => Some(a.value.as_deref()),
            _ => None,
        })
        .collect()
}

fn slot_of(frames: &[proto::Frame], s: &str) -> u32 {
    frames
        .iter()
        .find_map(|f| match &f.op {
            Some(Op::Intern(i)) if i.s == s => Some(i.id),
            _ => None,
        })
        .unwrap_or_else(|| panic!("{s:?} was never interned"))
}

#[test]
fn a_small_tree_produces_a_well_formed_batch() {
    let root = mount_root();
    let div = element("div");
    root.append_child(div.as_ref()).unwrap();

    div.set_attribute("id", "x").unwrap();

    let classes = div.class_list();
    classes.add_1("a").unwrap();
    classes.add_1("b").unwrap();
    classes.remove_1("a").unwrap();

    let html: &HtmlElement = div.unchecked_ref();
    html.style().set_property("color", "red").unwrap();
    html.style().set_property("display", "block").unwrap();

    let text = document().create_text_node("hi");
    div.append_child(text.as_ref()).unwrap();
    text.set_data("bye");

    listen(div.as_ref(), "click", |_| {});

    let frames = frames();
    assert_define_before_use(&frames);
    assert_single_trailing_commit(&frames);

    // classList rewrites the whole `class` attribute, in list order.
    assert_eq!(
        attribute_writes(&frames, slot_of(&frames, "class")),
        vec![Some("a"), Some("a b"), Some("b")]
    );

    // ... and the style declarations rewrite the whole `style` attribute.
    assert_eq!(
        attribute_writes(&frames, slot_of(&frames, "style")),
        vec![Some("color: red;"), Some("color: red; display: block;")]
    );

    // The text node's update is a `set-text`, not a recreate.
    let set_texts: Vec<&str> = frames
        .iter()
        .filter_map(|f| match &f.op {
            Some(Op::SetText(t)) => Some(t.text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(set_texts, vec!["bye"]);

    // The listener carries the producer's `bubbles` verdict for `click`.
    let listener = frames
        .iter()
        .find_map(|f| match &f.op {
            Some(Op::AddListener(l)) => l.listener.clone(),
            _ => None,
        })
        .expect("an add-listener frame");
    assert!(listener.bubbles);
    assert!(!listener.capture);
}

#[test]
fn removing_an_attribute_sends_set_attribute_with_no_value() {
    let div = element("div");
    div.set_attribute("title", "t").unwrap();
    div.remove_attribute("title").unwrap();

    let frames = frames();
    let title = slot_of(&frames, "title");
    assert_eq!(
        attribute_writes(&frames, title),
        vec![Some("t"), None],
        "an absent value is how the protocol removes an attribute"
    );
}

#[test]
fn moving_an_attached_node_is_one_insert_before_and_no_remove() {
    let root = mount_root();
    let a = element("a");
    let b = element("b");
    let c = element("c");
    for n in [&a, &b, &c] {
        root.append_child(n.as_ref()).unwrap();
    }
    let _ = dom::take_batch();

    // Move `c` to the front. The DOM's own `insertBefore` semantics, which
    // the protocol adopts: no `remove` precedes the move.
    root.insert_before(c.as_ref(), Some(a.as_ref())).unwrap();

    let frames = frames();
    let ops: Vec<&Op> = frames.iter().filter_map(|f| f.op.as_ref()).collect();
    assert_eq!(ops.len(), 1, "a move is exactly one frame: {ops:?}");
    let Op::InsertBefore(i) = ops[0] else {
        panic!("expected insert-before, got {:?}", ops[0])
    };
    assert_eq!(i.parent, 0);
    assert_eq!(i.anchor, Some(node_id(&a)));
    assert_eq!(i.id, node_id(&c));

    // And the shadow tree agrees, so subsequent anchors are computed right.
    assert_eq!(
        root.first_child().map(|n| node_id_of(&n)),
        Some(node_id(&c))
    );
}

#[test]
fn replace_child_is_insert_before_then_remove() {
    let root = mount_root();
    let old = element("old");
    root.append_child(old.as_ref()).unwrap();
    let _ = dom::take_batch();

    let new = element("new");
    root.replace_child(new.as_ref(), old.as_ref()).unwrap();

    let frames = frames();
    let ops: Vec<&Op> = frames.iter().filter_map(|f| f.op.as_ref()).collect();
    // intern("new"), create-element, insert-before, remove
    assert!(matches!(ops[ops.len() - 2], Op::InsertBefore(_)));
    let Op::Remove(r) = ops[ops.len() - 1] else {
        panic!("expected a trailing remove, got {:?}", ops[ops.len() - 1])
    };
    assert_eq!(r.id, node_id(&old));
    assert_single_trailing_commit(&frames);
}

fn node_id(e: &Element) -> u32 {
    node_id_of(e.as_ref())
}

fn node_id_of(n: &Node) -> u32 {
    stream_dom_fakedom::node::node_of(<Node as AsRef<JsValue>>::as_ref(n)).id
}

// --- Events -----------------------------------------------------------

fn form_payload(value: &str, checked: Option<bool>) -> proto::EventPayload {
    proto::EventPayload {
        family: Some(proto::event_payload::Family::Form(proto::FormData {
            value: value.to_string(),
            checked,
            fields: Vec::new(),
        })),
    }
}

fn key_payload(key: &str) -> proto::EventPayload {
    proto::EventPayload {
        family: Some(proto::event_payload::Family::Keyboard(
            proto::KeyboardData {
                key: key.to_string(),
                ..Default::default()
            },
        )),
    }
}

fn mouse_payload() -> proto::EventPayload {
    proto::EventPayload {
        family: Some(proto::event_payload::Family::Mouse(
            proto::MouseData::default(),
        )),
    }
}

#[test]
fn a_form_event_updates_the_control_before_the_handlers_run() {
    let root = mount_root();
    let input = element("input");
    root.append_child(input.as_ref()).unwrap();
    let id = node_id(&input);

    let seen: Rc<RefCell<Vec<String>>> = Rc::default();

    {
        let seen = seen.clone();
        let input: HtmlInputElement = input.clone().unchecked_into();
        listen(input.clone().as_ref(), "input", move |_| {
            seen.borrow_mut().push(format!("input:{}", input.value()));
        });
    }
    {
        let seen = seen.clone();
        let input: HtmlInputElement = input.clone().unchecked_into();
        listen(input.clone().as_ref(), "keydown", move |e| {
            let key: &web_sys::KeyboardEvent = e.unchecked_ref();
            // The whole point: a `keydown` handler reads the text the
            // preceding `input` events delivered.
            seen.borrow_mut()
                .push(format!("keydown:{}:{}", key.key(), input.value()));
            if key.key() == "Enter" {
                e.prevent_default();
            }
        });
    }

    let verdict = Rc::new(Verdict::default());
    assert!(dispatch(
        id,
        "input",
        form_payload("abc", None),
        verdict.clone()
    ));
    assert!(!verdict.default_prevented());

    let verdict = Rc::new(Verdict::default());
    assert!(dispatch(
        id,
        "keydown",
        key_payload("Enter"),
        verdict.clone()
    ));
    assert!(
        verdict.default_prevented(),
        "the handler's prevent_default must reach the driver"
    );

    assert_eq!(*seen.borrow(), ["input:abc", "keydown:Enter:abc"]);

    // The delivered value is readable through the ordinary property API.
    let input: HtmlInputElement = input.unchecked_into();
    assert_eq!(input.value(), "abc");
}

#[test]
fn a_checkbox_change_delivers_checked() {
    let root = mount_root();
    let input = element("input");
    input.set_attribute("type", "checkbox").unwrap();
    root.append_child(input.as_ref()).unwrap();
    let id = node_id(&input);

    let got = Rc::new(RefCell::new(None));
    {
        let got = got.clone();
        let input: HtmlInputElement = input.clone().unchecked_into();
        listen(input.clone().as_ref(), "change", move |_| {
            *got.borrow_mut() = Some(input.checked());
        });
    }

    dispatch(
        id,
        "change",
        form_payload("on", Some(true)),
        Rc::new(Verdict::default()),
    );
    assert_eq!(*got.borrow(), Some(true));
}

/// What each of the two stops means, which the DOM distinguishes and a
/// naive implementation does not: `stopPropagation` ends the walk before
/// the *next* node but lets the current node's other listeners run;
/// `stopImmediatePropagation` also skips those.
#[test]
fn propagation_stops_at_the_node_boundary_not_mid_node() {
    let root = mount_root();
    let outer = element("div");
    let inner = element("span");
    root.append_child(outer.as_ref()).unwrap();
    outer.append_child(inner.as_ref()).unwrap();
    let inner_id = node_id(&inner);

    let seen: Rc<RefCell<Vec<&'static str>>> = Rc::default();
    /// What the first listener on `inner` does this round.
    #[derive(Clone, Copy, PartialEq)]
    enum Stop {
        None,
        Propagation,
        Immediate,
    }
    let stop = Rc::new(std::cell::Cell::new(Stop::None));

    {
        let (seen, stop) = (seen.clone(), stop.clone());
        listen(inner.as_ref(), "click", move |e| {
            seen.borrow_mut().push("inner-1");
            match stop.get() {
                Stop::None => {}
                Stop::Propagation => e.stop_propagation(),
                Stop::Immediate => e.stop_immediate_propagation(),
            }
        });
    }
    {
        let seen = seen.clone();
        listen(inner.as_ref(), "click", move |_| {
            seen.borrow_mut().push("inner-2");
        });
    }
    {
        let seen = seen.clone();
        listen(outer.as_ref(), "click", move |_| {
            seen.borrow_mut().push("outer");
        });
    }

    let click = |stop_kind: Stop| -> Rc<Verdict> {
        seen.borrow_mut().clear();
        stop.set(stop_kind);
        let verdict = Rc::new(Verdict::default());
        dispatch(inner_id, "click", mouse_payload(), verdict.clone());
        verdict
    };

    let verdict = click(Stop::None);
    assert_eq!(*seen.borrow(), ["inner-1", "inner-2", "outer"]);
    assert!(!verdict.propagation_stopped());

    // The one the review caught: `inner-2` is on the same node as the
    // listener that stopped, so it still runs. Only `outer` is cut off.
    let verdict = click(Stop::Propagation);
    assert_eq!(*seen.borrow(), ["inner-1", "inner-2"]);
    assert!(
        verdict.propagation_stopped(),
        "the receiver is told too: only it can stop propagation past the mount root"
    );

    // `stopImmediatePropagation` additionally skips `inner-2`.
    let verdict = click(Stop::Immediate);
    assert_eq!(*seen.borrow(), ["inner-1"]);
    assert!(verdict.propagation_stopped());
}

#[test]
fn an_event_for_an_unknown_node_is_dropped() {
    // Ids are never reused, so an id the tree does not hold is a removed
    // node racing an event already in flight (proto/stream-dom.proto file
    // header: "An event for an unknown id is dropped").
    assert!(!dispatch(
        9999,
        "click",
        mouse_payload(),
        Rc::new(Verdict::default())
    ));
}

// --- The CSSOM path -----------------------------------------------------

/// The exact sequence `dominator::class!` walks to realise `HIDDEN_CLASS`,
/// which `DomBuilder::visible_signal` — used on every TodoMVC row — depends
/// on (dominator-0.5.38/src/dom.rs:85, :1422 and src/bindings.rs
/// `create_stylesheet` / `make_rule`). It is the most intricate path
/// through the shim, so it is walked here directly rather than reached
/// only through the app.
#[test]
fn a_dominator_stylesheet_becomes_a_style_element_in_the_mount() {
    let document = document();

    let style: web_sys::HtmlStyleElement =
        document.create_element("style").unwrap().unchecked_into();
    style.set_type("text/css");
    let head = document.head().unwrap();
    <web_sys::HtmlHeadElement as AsRef<Node>>::as_ref(&head)
        .append_child(style.as_ref())
        .unwrap();

    let sheet: web_sys::CssStyleSheet = style.sheet().unwrap().unchecked_into();
    let rules = sheet.css_rules().unwrap();
    let length = rules.length();
    sheet.insert_rule_with_index(".hidden {}", length).unwrap();
    let rule: web_sys::CssStyleRule = rules.get(length).unwrap().unchecked_into();

    rule.style()
        .set_property_with_priority("display", "none", "important")
        .unwrap();

    let frames = frames();
    assert_define_before_use(&frames);
    assert_single_trailing_commit(&frames);

    // The sheet's text reaches the receiver as the `<style>` element's
    // `textContent`, rewritten in full on every rule change.
    let css: Vec<&str> = frames
        .iter()
        .filter_map(|f| match &f.op {
            Some(Op::SetProperty(p)) => match &p.value {
                Some(proto::set_property::Value::Text(t)) => Some(t.as_str()),
                _ => None,
            },
            _ => None,
        })
        .collect();
    assert_eq!(
        css.last(),
        Some(&".hidden { display: none !important; }"),
        "got {css:?}"
    );

    // And the `<style>` element really is inside the mount root, so the
    // receiver applies it.
    assert!(mount_root()
        .first_child()
        .is_some_and(|n| node_id_of(&n) == node_id_of(style.as_ref())));
}

/// `focus()` / `blur()` are not mutations: they are queued as effects the
/// driver runs, via `queries.set-focus`, after the batch is committed.
#[test]
fn focus_is_an_effect_not_a_frame() {
    let root = mount_root();
    let input = element("input");
    root.append_child(input.as_ref()).unwrap();
    let id = node_id(&input);

    let html: &HtmlElement = input.unchecked_ref();
    html.focus().unwrap();
    html.blur().unwrap();

    let frames = frames();
    assert!(
        !frames
            .iter()
            .any(|f| matches!(f.op, Some(Op::SetProperty(_)) | Some(Op::SetAttribute(_)))),
        "focus must not turn into a mutation: {frames:?}"
    );
    assert_eq!(
        dom::take_effects(),
        vec![dom::Effect::Focus(id, true), dom::Effect::Focus(id, false)]
    );
}
