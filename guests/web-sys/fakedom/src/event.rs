//! Event objects and dispatch.
//!
//! The receiver delegates bubbling events at the mount root and reports
//! the real event *target* (docs/design.md "Events": "bubbling events are
//! delegated at the mount root"), so the producer owns the propagation
//! walk. That is the same division of labour the sibling Dioxus adapter
//! uses, where `handle-event`'s `target` feeds
//! `Runtime::handle_event` and Dioxus does its own synthetic bubbling
//! (crates/stream-dom-dioxus/src/driver.rs).

use std::any::Any;
use std::cell::{Cell, RefCell};
use std::rc::Rc;

use stream_dom_guest::proto;
use wasm_bindgen::{JsObject, JsValue};

use crate::dom;
use crate::node::NodeData;

/// What the handlers asked for imperatively, recorded during dispatch.
///
/// Dispatch is entirely synchronous, so the driver reads this the instant
/// it returns — still inside the receiver's DOM listener frame, before
/// anything is awaited — and forwards it on the live WIT `dom-event`.
/// That is the same ordering the sibling Dioxus adapter uses
/// (crates/stream-dom-dioxus/src/driver.rs `handle_event`), and it is what
/// wit/stream-dom.wit's `dom-event` requires: "calls made after the
/// handler first blocks are too late".
///
/// It is also the seam the native tests observe, since the WIT resource
/// only exists on the component target.
#[derive(Default)]
pub struct Verdict {
    prevented: Cell<bool>,
    stopped: Cell<bool>,
}

impl Verdict {
    pub fn default_prevented(&self) -> bool {
        self.prevented.get()
    }

    pub fn propagation_stopped(&self) -> bool {
        self.stopped.get()
    }
}

pub struct EventData {
    pub name: String,
    pub payload: proto::EventPayload,
    pub target: Rc<NodeData>,
    pub bubbles: bool,
    current_target: RefCell<Option<Rc<NodeData>>>,
    class_chain: &'static [&'static str],
    default_prevented: Cell<bool>,
    /// Set by `stopPropagation`: the walk stops before the *next* node,
    /// but the current node's remaining listeners still run.
    stopped: Cell<bool>,
    /// Set by `stopImmediatePropagation`, which additionally skips the
    /// current node's remaining listeners.
    immediate_stopped: Cell<bool>,
    verdict: Rc<Verdict>,
}

/// The interface an event name is delivered as. This is the fake's whole
/// notion of an event class: dominator casts the `Event` it is handed with
/// `unchecked_into` (dominator-0.5.38/src/events.rs:51), but
/// `Event::dyn_target` and `dyn_ref::<MouseEvent>()` style checks go
/// through `instanceof`, so the chain has to be right.
fn class_chain_for(name: &str) -> &'static [&'static str] {
    const EVENT: &str = "Event";
    const UI: &str = "UIEvent";
    match name {
        "click" | "dblclick" | "auxclick" | "mousedown" | "mouseup" | "mousemove"
        | "mouseenter" | "mouseleave" | "mouseover" | "mouseout" | "contextmenu" => {
            &["MouseEvent", UI, EVENT, "Object"]
        }
        "wheel" => &["WheelEvent", "MouseEvent", UI, EVENT, "Object"],
        "dragstart" | "drag" | "dragenter" | "dragover" | "dragleave" | "drop" | "dragend" => {
            &["DragEvent", "MouseEvent", UI, EVENT, "Object"]
        }
        n if n.starts_with("pointer") => &["PointerEvent", "MouseEvent", UI, EVENT, "Object"],
        "keydown" | "keyup" | "keypress" => &["KeyboardEvent", UI, EVENT, "Object"],
        "input" | "beforeinput" => &["InputEvent", UI, EVENT, "Object"],
        "focus" | "blur" | "focusin" | "focusout" => &["FocusEvent", UI, EVENT, "Object"],
        n if n.starts_with("touch") => &["TouchEvent", UI, EVENT, "Object"],
        n if n.starts_with("animation") => &["AnimationEvent", EVENT, "Object"],
        "resize" => &[UI, EVENT, "Object"],
        _ => &[EVENT, "Object"],
    }
}

impl EventData {
    pub fn current_target(&self) -> Option<Rc<NodeData>> {
        self.current_target.borrow().clone()
    }

    pub fn default_prevented(&self) -> bool {
        self.default_prevented.get()
    }

    /// Records the verdict and forwards it on the live event, which is
    /// legal only in the handler's synchronous prefix — the same rule a
    /// browser applies after the first `await` (wit/stream-dom.wit,
    /// `dom-event`). Dispatch here is entirely synchronous, so every call
    /// a handler makes lands in time.
    pub fn prevent_default(&self) {
        self.default_prevented.set(true);
        self.verdict.prevented.set(true);
    }

    /// DOM `stopPropagation`: the event does not reach the next node in
    /// the path, but every other listener already registered on the
    /// *current* node still runs.
    pub fn stop_propagation(&self) {
        self.stopped.set(true);
        // Recorded for the receiver too: propagation past the mount root
        // is the host page's own DOM, which only the receiver can stop.
        self.verdict.stopped.set(true);
    }

    /// DOM `stopImmediatePropagation`: as above, and the current node's
    /// remaining listeners are skipped as well. The receiver cannot see
    /// the difference — it has one delegated listener — so it is told the
    /// same thing either way.
    pub fn stop_immediate_propagation(&self) {
        self.immediate_stopped.set(true);
        self.stop_propagation();
    }

    fn family_mismatch(&self, wanted: &str) -> ! {
        panic!(
            "fakedom: `{}` event carries no {wanted} payload (family {:?})",
            self.name,
            self.payload.family.as_ref().map(std::mem::discriminant)
        )
    }

    pub fn mouse(&self) -> &proto::MouseData {
        match &self.payload.family {
            Some(proto::event_payload::Family::Mouse(m)) => m,
            Some(proto::event_payload::Family::Pointer(p)) => p
                .mouse
                .as_ref()
                .unwrap_or_else(|| self.family_mismatch("mouse")),
            Some(proto::event_payload::Family::Wheel(w)) => w
                .mouse
                .as_ref()
                .unwrap_or_else(|| self.family_mismatch("mouse")),
            _ => self.family_mismatch("mouse"),
        }
    }

    pub fn keyboard(&self) -> &proto::KeyboardData {
        match &self.payload.family {
            Some(proto::event_payload::Family::Keyboard(k)) => k,
            _ => self.family_mismatch("keyboard"),
        }
    }

    pub fn modifiers(&self) -> proto::Modifiers {
        match &self.payload.family {
            Some(proto::event_payload::Family::Keyboard(k)) => k.modifiers.unwrap_or_default(),
            Some(proto::event_payload::Family::Mouse(_))
            | Some(proto::event_payload::Family::Pointer(_))
            | Some(proto::event_payload::Family::Wheel(_)) => {
                self.mouse().modifiers.unwrap_or_default()
            }
            _ => proto::Modifiers::default(),
        }
    }
}

impl JsObject for EventData {
    fn class_chain(&self) -> &[&'static str] {
        self.class_chain
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
}

/// Deliver one event, as `handle-event` received it.
///
/// Returns `false` when the event was dropped because its target id is
/// unknown — a node removed while the event was already in flight on the
/// reverse channel, which the protocol says to drop
/// (proto/stream-dom.proto file header).
pub fn dispatch(
    target: stream_dom_guest::NodeId,
    name: &str,
    payload: proto::EventPayload,
    verdict: Rc<Verdict>,
) -> bool {
    let Some(target_node) = dom::node_by_id(target) else {
        return false;
    };

    // The DOM updates a control's `value` / `checked` before firing the
    // event, so a handler reading `element.value()` sees the new text.
    // Mirror that from the form payload the receiver snapshotted, which is
    // what makes TodoMVC's `element.value()` inside an `input` handler
    // correct.
    if let Some(proto::event_payload::Family::Form(form)) = &payload.family {
        target_node.set_prop_local("value", JsValue::from_str(&form.value));
        if let Some(checked) = form.checked {
            target_node.set_prop_local("checked", JsValue::from_bool(checked));
        }
    }

    let bubbles = crate::dom::name_bubbles(name);
    let event = Rc::new(EventData {
        name: name.to_string(),
        payload,
        target: target_node.clone(),
        bubbles,
        current_target: RefCell::new(None),
        class_chain: class_chain_for(name),
        default_prevented: Cell::new(false),
        stopped: Cell::new(false),
        immediate_stopped: Cell::new(false),
        verdict,
    });
    let event_value = JsValue::from_object(event.clone());

    // Nearest-first, so the capture walk is this reversed.
    let path = target_node.ancestor_path();

    for node in path.iter().rev() {
        if event.stopped.get() {
            return true;
        }
        fire(node, name, true, &event, &event_value);
    }
    for node in path.iter() {
        if event.stopped.get() {
            return true;
        }
        fire(node, name, false, &event, &event_value);
        if !bubbles {
            break;
        }
    }
    true
}

fn fire(
    node: &Rc<NodeData>,
    name: &str,
    capture: bool,
    event: &Rc<EventData>,
    event_value: &JsValue,
) {
    // Snapshot the callbacks: a handler that adds or removes listeners
    // re-enters the shim, and a live borrow would turn that into a panic.
    let callbacks: Vec<JsValue> = node
        .listeners()
        .iter()
        .filter(|l| l.name == name && l.capture == capture)
        .map(|l| l.callback.clone())
        .collect();
    if callbacks.is_empty() {
        return;
    }

    *event.current_target.borrow_mut() = Some(node.clone());
    let this = node.value();
    for cb in callbacks {
        if let Err(e) = cb.call_with(&this, std::slice::from_ref(event_value)) {
            panic!("fakedom: `{name}` listener threw: {e:?}");
        }
        // Only `stopImmediatePropagation` cuts the current node's
        // remaining listeners short; plain `stopPropagation` lets them
        // run and is honoured by the caller, before the next node.
        if event.immediate_stopped.get() {
            break;
        }
    }
    *event.current_target.borrow_mut() = None;
}
