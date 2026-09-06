//! The shadow DOM: nodes, their identity, and their class chains.
//!
//! Node identity is `Rc` pointer identity. Every node carries a
//! `Weak<NodeData>` to itself so that a `&NodeData` recovered from a
//! `JsValue` by downcast can be turned back into an owning `Rc` — the
//! coercion `Rc<NodeData> -> Rc<dyn JsObject>` keeps one allocation, so
//! that `Weak` stays live for as long as any `JsValue` holds the node.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::{Rc, Weak};

use stream_dom_guest::NodeId;
use wasm_bindgen::JsValue;

pub const SVG_NS: &str = "http://www.w3.org/2000/svg";

/// One registered event listener. Several callbacks may share a `(node,
/// name)` pair; only the first emits an `AddListener` frame and only the
/// last to go emits `RemoveListener`, because the receiver dispatches once
/// per event and this shim fans out to all of them.
pub struct Listener {
    pub name: String,
    pub capture: bool,
    pub passive: bool,
    pub callback: JsValue,
}

pub enum NodeKind {
    Element {
        tag: String,
        ns: Option<String>,
        /// `(name, ns, value)`, in insertion order.
        attrs: RefCell<Vec<(String, Option<String>, String)>>,
        /// Ordered, because `style` is rewritten from it wholesale.
        style: RefCell<Vec<(String, String)>>,
        classes: RefCell<Vec<String>>,
    },
    Text {
        data: RefCell<String>,
    },
    /// A comment node. On the wire it is a `CreatePlaceholder`: the
    /// protocol's comment node exists only as an insertion anchor
    /// (proto/stream-dom.proto, `CreatePlaceholder`), so comment *data*
    /// has nowhere to go and is dropped. Dominator only ever creates
    /// comments as empty anchors (`create_empty_node`,
    /// dominator-0.5.38/src/bindings.rs:100).
    Comment,
    Document,
    Window,
}

pub struct NodeData {
    /// Producer-allocated, never reused. `0` is the mount root.
    pub id: NodeId,
    pub kind: NodeKind,
    class_chain: &'static [&'static str],
    me: RefCell<Weak<NodeData>>,
    parent: RefCell<Weak<NodeData>>,
    children: RefCell<Vec<Rc<NodeData>>>,
    listeners: RefCell<Vec<Listener>>,
    /// Last value written by `set-property` or delivered with an event, so
    /// `HtmlInputElement::value()` reads back what the DOM would report.
    props: RefCell<HashMap<String, JsValue>>,
}

const OBJECT: &str = "Object";
const EVENT_TARGET: &str = "EventTarget";
const NODE: &str = "Node";
const ELEMENT: &str = "Element";

macro_rules! chain {
    ($($c:literal),* $(,)?) => { &[$($c,)* ELEMENT, NODE, EVENT_TARGET, OBJECT] };
}

fn element_chain(tag: &str, ns: Option<&str>) -> &'static [&'static str] {
    if ns == Some(SVG_NS) {
        return match tag {
            "line" => chain!("SVGLineElement", "SVGGraphicsElement", "SVGElement"),
            _ => chain!("SVGElement"),
        };
    }
    match tag {
        "input" => chain!("HTMLInputElement", "HTMLElement"),
        "textarea" => chain!("HTMLTextAreaElement", "HTMLElement"),
        "style" => chain!("HTMLStyleElement", "HTMLElement"),
        "head" => chain!("HTMLHeadElement", "HTMLElement"),
        "canvas" => chain!("HTMLCanvasElement", "HTMLElement"),
        "div" => chain!("HTMLDivElement", "HTMLElement"),
        _ => chain!("HTMLElement"),
    }
}

impl NodeData {
    fn build(id: NodeId, kind: NodeKind, class_chain: &'static [&'static str]) -> Rc<NodeData> {
        let node = Rc::new(NodeData {
            id,
            kind,
            class_chain,
            me: RefCell::new(Weak::new()),
            parent: RefCell::new(Weak::new()),
            children: RefCell::new(Vec::new()),
            listeners: RefCell::new(Vec::new()),
            props: RefCell::new(HashMap::new()),
        });
        *node.me.borrow_mut() = Rc::downgrade(&node);
        node
    }

    pub fn element(id: NodeId, tag: &str, ns: Option<&str>) -> Rc<NodeData> {
        let class_chain = element_chain(tag, ns);
        NodeData::build(
            id,
            NodeKind::Element {
                tag: tag.to_string(),
                ns: ns.map(str::to_string),
                attrs: RefCell::new(Vec::new()),
                style: RefCell::new(Vec::new()),
                classes: RefCell::new(Vec::new()),
            },
            class_chain,
        )
    }

    pub fn text(id: NodeId, data: &str) -> Rc<NodeData> {
        NodeData::build(
            id,
            NodeKind::Text {
                data: RefCell::new(data.to_string()),
            },
            &["Text", "CharacterData", NODE, EVENT_TARGET, OBJECT],
        )
    }

    pub fn comment(id: NodeId) -> Rc<NodeData> {
        NodeData::build(
            id,
            NodeKind::Comment,
            &["Comment", "CharacterData", NODE, EVENT_TARGET, OBJECT],
        )
    }

    pub fn document(id: NodeId) -> Rc<NodeData> {
        NodeData::build(
            id,
            NodeKind::Document,
            &["Document", NODE, EVENT_TARGET, OBJECT],
        )
    }

    pub fn window(id: NodeId) -> Rc<NodeData> {
        NodeData::build(id, NodeKind::Window, &["Window", EVENT_TARGET, OBJECT])
    }

    /// The owning handle for this node. Never fails: the `Weak` is set at
    /// construction and the allocation is alive because `&self` is.
    pub fn rc(&self) -> Rc<NodeData> {
        self.me
            .borrow()
            .upgrade()
            .expect("fakedom: node self-reference outlived its allocation")
    }

    /// The class and every class it inherits from, most derived first.
    /// The `JsObject` impl (in [`crate::protocol`]) hands this out, and the
    /// protocol dispatch reads it to tell an `<input>` from a `<style>`.
    pub fn chain(&self) -> &'static [&'static str] {
        self.class_chain
    }

    pub fn value(&self) -> JsValue {
        JsValue::from_object(self.rc())
    }

    pub fn tag(&self) -> Option<&str> {
        match &self.kind {
            NodeKind::Element { tag, .. } => Some(tag),
            _ => None,
        }
    }

    pub fn parent(&self) -> Option<Rc<NodeData>> {
        self.parent.borrow().upgrade()
    }

    pub fn set_parent(&self, parent: Option<&Rc<NodeData>>) {
        *self.parent.borrow_mut() = parent.map_or_else(Weak::new, Rc::downgrade);
    }

    pub fn children(&self) -> std::cell::Ref<'_, Vec<Rc<NodeData>>> {
        self.children.borrow()
    }

    pub fn children_mut(&self) -> std::cell::RefMut<'_, Vec<Rc<NodeData>>> {
        self.children.borrow_mut()
    }

    pub fn index_of_child(&self, child: &NodeData) -> Option<usize> {
        self.children
            .borrow()
            .iter()
            .position(|c| std::ptr::eq(Rc::as_ptr(c), child))
    }

    pub fn listeners(&self) -> std::cell::Ref<'_, Vec<Listener>> {
        self.listeners.borrow()
    }

    pub fn listeners_mut(&self) -> std::cell::RefMut<'_, Vec<Listener>> {
        self.listeners.borrow_mut()
    }

    /// Whether any listener is registered for `name` — the bit that
    /// decides whether an `AddListener` / `RemoveListener` frame goes out.
    pub fn has_listener_named(&self, name: &str) -> bool {
        self.listeners.borrow().iter().any(|l| l.name == name)
    }

    pub fn prop(&self, name: &str) -> JsValue {
        self.props
            .borrow()
            .get(name)
            .cloned()
            .unwrap_or(JsValue::UNDEFINED)
    }

    pub fn set_prop_local(&self, name: &str, value: JsValue) {
        self.props.borrow_mut().insert(name.to_string(), value);
    }

    pub fn remove_prop_local(&self, name: &str) -> bool {
        self.props.borrow_mut().remove(name).is_some()
    }

    pub fn attr(&self, name: &str) -> Option<String> {
        match &self.kind {
            NodeKind::Element { attrs, .. } => attrs
                .borrow()
                .iter()
                .find(|(n, ns, _)| n == name && ns.is_none())
                .map(|(_, _, v)| v.clone()),
            _ => None,
        }
    }

    pub fn text_data(&self) -> Option<String> {
        match &self.kind {
            NodeKind::Text { data } => Some(data.borrow().clone()),
            _ => None,
        }
    }

    pub fn set_text_data(&self, s: &str) {
        match &self.kind {
            NodeKind::Text { data } => *data.borrow_mut() = s.to_string(),
            _ => panic!("fakedom: set_data on a non-text node"),
        }
    }

    /// This node and its ancestors, nearest first.
    pub fn ancestor_path(&self) -> Vec<Rc<NodeData>> {
        let mut out = vec![self.rc()];
        while let Some(p) = out.last().unwrap().parent() {
            out.push(p);
        }
        out
    }
}

/// Recover the node behind a `JsValue`. Panics rather than returning
/// `None`: every call site here has a `web_sys` type in hand, so a
/// non-node is a bug in the shim, not a runtime condition.
pub fn node_of(value: &JsValue) -> Rc<NodeData> {
    value
        .downcast_ref::<NodeData>()
        .unwrap_or_else(|| panic!("fakedom: expected a DOM node, got {value:?}"))
        .rc()
}
