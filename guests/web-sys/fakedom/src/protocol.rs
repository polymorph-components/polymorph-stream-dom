//! The `JsObject` protocol for the fake DOM's nodes and events.
//!
//! The real `web_sys` compiles against a fake `#[wasm_bindgen]` proc macro
//! that rewrites every binding into one call on
//! [`wasm_bindgen::JsObject`]: `get(js_name)`, `set(js_name, v)`,
//! `invoke(js_name, args)`. This module is the other end of that wire —
//! the dispatch table that turns those calls back into the [`crate::dom`]
//! operations the protocol producer is built out of.
//!
//! It is a *translation layer*, not a model: the shadow DOM, the frames and
//! the event objects all live in the sibling modules, and every arm here
//! resolves to one call into them. Its inventory is exactly the members
//! dominator 0.5.38, gloo-events 0.1.2 and the TodoMVC port reach.
//!
//! # The keys
//!
//! Keys are JS names, taken verbatim from web-sys 0.3.105's binding
//! attributes — `js_name = "setAttribute"`, `getter = "classList"` — with
//! **no** case conversion (`wasm_bindgen::JsObject`'s doc comment, and
//! `wasm-bindgen-macro/src/externs.rs::op`). Overloads collapse: web-sys's
//! `set_property` and `set_property_with_priority` are both
//! `invoke("setProperty", ..)` and are told apart by argument count, as
//! they are in JS.
//!
//! # Unknown members are loud
//!
//! Every match here ends in a panic naming the class and the member. The
//! `JsObject` defaults (`get` -> `undefined`) must not be reached for a DOM
//! object: an unknown getter answering `undefined` is a plausible wrong
//! answer, which is the failure mode this whole shim exists to prevent.
//! The one deliberate exception is a node's property bag — see
//! [`NodeData::get`](crate::node::NodeData).
//!
//! Members that *are* named but cannot be honoured split two ways:
//!
//! - The binding is `#[wasm_bindgen(catch)]` and a locked-down browser
//!   would genuinely throw: return `Err`, a `DOMException`-shaped string.
//!   A framework's own `.ok()` / `unwrap_throw` then sees what it would see
//!   with the feature disabled. [`refused`].
//! - The binding is a plain synchronous getter with nowhere to put an
//!   exception: panic. Layout reads are the interesting case — they are
//!   answerable only by the WIT `queries` imports, which are `async` and so
//!   cannot answer a synchronous getter at all. [`layout_read`],
//!   [`unsupported`].

use std::rc::Rc;

use wasm_bindgen::{JsObject, JsValue};

use crate::css::{DomTokenListObj, StyleDeclObj, StyleRuleObj, StyleSheetObj, StyleTarget};
use crate::dom;
use crate::event::EventData;
use crate::node::{NodeData, NodeKind};

// --- Failure modes ----------------------------------------------------

/// The fallback arm of every match: the dispatch table has no entry.
fn missing(obj: &dyn JsObject, member: &str) -> ! {
    panic!(
        "fakedom: {}.{member} is not implemented",
        obj.class_chain().first().unwrap_or(&"Object"),
    )
}

/// A member a producer cannot have, reached through a *non*-`catch`
/// binding. There is nowhere to put an exception, so this aborts.
fn unsupported(what: &str) -> ! {
    panic!("fakedom: {what} is not supported in this spike")
}

/// Layout is the receiver's, not the producer's. Reading it needs the WIT
/// `queries` imports (docs/design.md "Reads are `async`-typed host
/// imports"), which are `async` and so cannot answer a synchronous
/// `web_sys` getter at all.
fn layout_read(what: &str) -> ! {
    panic!("fakedom: {what} requires a query import; not in the spike")
}

/// A member a producer cannot have, reached through a `catch` binding: a
/// thrown `DOMException`, which is exactly what a browser with the feature
/// switched off would raise. `name` is the DOMException name.
fn refused<T>(name: &str, member: &str) -> Result<T, JsValue> {
    Err(JsValue::from_str(&format!(
        "{name}: {member} is not available to a stream-dom producer"
    )))
}

// --- Argument helpers -------------------------------------------------
//
// Arguments arrive lowered by `wasm_bindgen::__rt::IntoJs`, so their shapes
// are exactly the ones that table produces: strings are Strings, `bool` is
// a Bool, every numeric type is a Number, `None` is `undefined`, and
// wrapper types are the object unchanged.

fn arg(args: &[JsValue], i: usize) -> JsValue {
    args.get(i).cloned().unwrap_or(JsValue::UNDEFINED)
}

fn str_arg(member: &str, args: &[JsValue], i: usize) -> String {
    let v = arg(args, i);
    v.as_string()
        .unwrap_or_else(|| panic!("fakedom: {member} argument {i} must be a string, got {v:?}"))
}

/// An `Option<&str>` argument: `undefined`/`null` is `None`.
fn opt_str_arg(member: &str, args: &[JsValue], i: usize) -> Option<String> {
    let v = arg(args, i);
    if v.is_undefined() || v.is_null() {
        None
    } else {
        Some(v.as_string().unwrap_or_else(|| {
            panic!("fakedom: {member} argument {i} must be a string or absent, got {v:?}")
        }))
    }
}

fn u32_arg(member: &str, args: &[JsValue], i: usize) -> u32 {
    let v = arg(args, i);
    v.as_f64()
        .filter(|n| n.fract() == 0.0 && *n >= 0.0)
        .map(|n| n as u32)
        .unwrap_or_else(|| panic!("fakedom: {member} argument {i} must be a u32, got {v:?}"))
}

fn node_arg(member: &str, args: &[JsValue], i: usize) -> Rc<NodeData> {
    let v = arg(args, i);
    v.downcast_ref::<NodeData>()
        .unwrap_or_else(|| panic!("fakedom: {member} argument {i} must be a node, got {v:?}"))
        .rc()
}

fn opt_node_arg(member: &str, args: &[JsValue], i: usize) -> Option<Rc<NodeData>> {
    let v = arg(args, i);
    if v.is_undefined() || v.is_null() {
        None
    } else {
        Some(node_arg(member, args, i))
    }
}

/// A `Node?`-returning member: the DOM's absent node is `null`.
fn node_or_null(node: Option<Rc<NodeData>>) -> JsValue {
    node.map_or(JsValue::NULL, |n| n.value())
}

/// `element.style` / `rule.style`.
fn style_decl(target: StyleTarget) -> JsValue {
    JsValue::from_object(Rc::new(StyleDeclObj { target }))
}

/// `addEventListener`'s third argument, which is either a `bool` (the
/// `capture` shorthand) or an `AddEventListenerOptions` dictionary — a
/// plain `{}` built by `js_sys::Object::new()`, since web-sys 0.3.105
/// constructs dictionaries that way (`gen_AddEventListenerOptions.rs:62`).
/// Returns `(capture, passive)`; an absent field is `false`, as in JS.
fn listener_options(v: &JsValue) -> (bool, bool) {
    if let Some(capture) = v.as_bool() {
        return (capture, false);
    }
    if v.is_undefined() || v.is_null() {
        return (false, false);
    }
    let flag = |k: &str| {
        v.get_prop(k)
            .ok()
            .and_then(|f| f.as_bool())
            .unwrap_or(false)
    };
    // `once` is deliberately not read: nothing in the graph registers a
    // one-shot listener whose auto-removal is observable, and the protocol
    // has no "once" bit for the receiver to honour.
    (flag("capture"), flag("passive"))
}

// --- Nodes ------------------------------------------------------------

impl JsObject for NodeData {
    fn class_chain(&self) -> &[&'static str] {
        self.chain()
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    /// An implemented DOM getter, else a property the producer itself set
    /// (`Reflect.set`, dominator's `.prop()`, or an event delivery), else a
    /// panic.
    ///
    /// The property-bag fallback is the one place a DOM object here answers
    /// a key it was never taught: `.prop("customThing", v)` must read back,
    /// and only the producer can have written it.
    fn get(&self, key: &str) -> Result<JsValue, JsValue> {
        if let Some(v) = self.dom_get(key)? {
            return Ok(v);
        }
        let local = self.prop(key);
        if local.is_undefined() {
            missing(self, key);
        }
        Ok(local)
    }

    /// A modelled DOM setter, else `Reflect.set`.
    ///
    /// CONTRACT: the fallback is deliberately total rather than a panic.
    /// docs/design.md "`set-attribute` and `set-property` are distinct"
    /// makes the mapping the producer adapter's call, and a framework
    /// writing a property on a node has already made it — see
    /// [`dom::reflect_set`], whose contract note this continues. The
    /// modelled setters still win, because `textContent` and `data` are
    /// *tree* operations (children are discarded; a text node emits
    /// `set-text`), not property writes.
    fn set(&self, key: &str, value: JsValue) -> Result<(), JsValue> {
        match key {
            "textContent" => {
                let text = if value.is_undefined() || value.is_null() {
                    None
                } else {
                    value.as_string()
                };
                dom::set_text_content(self, text.as_deref());
            }
            "data" => dom::set_data(self, &value.as_string().unwrap_or_default()),
            // Scrolling is the receiver's: the producer has no viewport.
            "scrollTop" => unsupported("Element.scrollTop assignment"),
            "scrollLeft" => unsupported("Element.scrollLeft assignment"),
            // `HTMLStyleElement.type` is a reflected content attribute, and
            // the receiver needs it as one for the `<style>` element to
            // parse: dominator sets it in `create_stylesheet`
            // (dominator-0.5.38/src/bindings.rs:57).
            "type" if self.chain().contains(&"HTMLStyleElement") => {
                dom::set_attribute(self, "type", None, &value.as_string().unwrap_or_default());
            }
            _ => dom::reflect_set(self, key, value),
        }
        Ok(())
    }

    fn invoke(&self, method: &str, args: &[JsValue]) -> Result<JsValue, JsValue> {
        // `EventTarget` is the root of every node's chain, `document` and
        // `window` included.
        match method {
            "addEventListener" => {
                let ty = str_arg(method, args, 0);
                let (capture, passive) = listener_options(&arg(args, 2));
                dom::add_listener(self, &ty, capture, passive, arg(args, 1));
                return Ok(JsValue::UNDEFINED);
            }
            "removeEventListener" => {
                let ty = str_arg(method, args, 0);
                let (capture, _) = listener_options(&arg(args, 2));
                dom::remove_listener(self, &ty, &arg(args, 1), capture);
                return Ok(JsValue::UNDEFINED);
            }
            _ => {}
        }

        match self.kind {
            NodeKind::Document => self.document_invoke(method, args),
            NodeKind::Window => match method {
                // All three are `catch` bindings, so refusing them is what a
                // framework would see in a browser with the feature off.
                "matchMedia" => refused("NotSupportedError", "Window.matchMedia"),
                // A producer has no frame clock of its own: the protocol's
                // answer is the synthetic `frame` event, subscribed at the
                // mount root (docs/design.md "Events").
                "requestAnimationFrame" => refused(
                    "NotSupportedError",
                    "Window.requestAnimationFrame (use the synthetic `frame` event)",
                ),
                "cancelAnimationFrame" => {
                    refused("NotSupportedError", "Window.cancelAnimationFrame")
                }
                _ => missing(self, method),
            },
            _ => self.node_invoke(method, args),
        }
    }
}

impl NodeData {
    /// The getters this fake models, by JS name. `None` means "no such DOM
    /// getter here", which sends [`NodeData::get`] to the property bag.
    fn dom_get(&self, key: &str) -> Result<Option<JsValue>, JsValue> {
        let chain = self.chain();
        let v = match self.kind {
            NodeKind::Window => match key {
                "document" => dom::document(),
                // Storage, history and the frame clock are the host page's.
                // All four bindings are `catch`, so a browser with them
                // switched off is exactly what a framework sees.
                "localStorage" => return refused("SecurityError", "Window.localStorage"),
                "sessionStorage" => return refused("SecurityError", "Window.sessionStorage"),
                "history" => return refused("SecurityError", "Window.history"),
                "innerWidth" => return refused("NotSupportedError", "Window.innerWidth"),
                "innerHeight" => return refused("NotSupportedError", "Window.innerHeight"),
                // Not `catch`: nowhere to put an exception. Routing belongs
                // to whatever owns the address bar, which is the receiver.
                "location" => unsupported("Window.location"),
                _ => missing(self, key),
            },

            NodeKind::Document => match key {
                // A producer has no document: the receiver owns everything
                // above the mount, so the only element this side can name
                // is the root the receiver gave it. `document.head` too --
                // that is what puts dominator's generated `<style>` inside
                // the mount, where its CSS actually reaches the receiver
                // (see `crate::css`).
                "body" | "head" => dom::mount_root(),
                // There is no parser here, so the tree is always ready.
                "readyState" => JsValue::from_str("complete"),
                _ => missing(self, key),
            },

            _ => match key {
                // --- Node ---
                "parentNode" => node_or_null(self.parent()),
                "firstChild" => node_or_null(self.children().first().cloned()),

                // --- Element ---
                "classList" => JsValue::from_object(Rc::new(DomTokenListObj { node: self.rc() })),

                // --- HTMLElement / SVGElement ---
                "style" => style_decl(StyleTarget::Element(self.rc())),

                // --- HTMLStyleElement ---
                "sheet" if chain.contains(&"HTMLStyleElement") => {
                    JsValue::from_object(StyleSheetObj::new(self.rc()))
                }

                // --- Form controls ---
                //
                // `value` and `checked` are DOM *properties*: the read
                // answers the last value the producer wrote or an event
                // delivered, which is what makes `element.value()` inside
                // an `input` handler see the user's text (see
                // `crate::event::dispatch`).
                "value"
                    if chain.contains(&"HTMLInputElement")
                        || chain.contains(&"HTMLTextAreaElement") =>
                {
                    JsValue::from_str(&self.prop("value").as_string().unwrap_or_default())
                }
                "checked" if chain.contains(&"HTMLInputElement") => {
                    JsValue::from_bool(self.prop("checked").as_bool().unwrap_or(false))
                }
                // `HTMLInputElement.type` reflects the `type` attribute and
                // defaults to `"text"`.
                "type" if chain.contains(&"HTMLInputElement") => {
                    JsValue::from_str(&self.attr("type").unwrap_or_else(|| "text".to_string()))
                }

                // --- Layout ---
                "clientWidth" | "clientHeight" | "scrollTop" | "scrollLeft" | "scrollWidth"
                | "scrollHeight" => layout_read(&format!("Element.{key}")),

                // Not a modelled getter: the caller falls back to the
                // property bag.
                _ => return Ok(None),
            },
        };
        Ok(Some(v))
    }

    fn document_invoke(&self, method: &str, args: &[JsValue]) -> Result<JsValue, JsValue> {
        Ok(match method {
            "createElement" => dom::create_element(&str_arg(method, args, 0), None),
            "createElementNS" => {
                let ns = opt_str_arg(method, args, 0);
                dom::create_element(&str_arg(method, args, 1), ns.as_deref())
            }
            "createTextNode" => dom::create_text(&str_arg(method, args, 0)),
            // The protocol's comment node is a bare insertion anchor and
            // carries no text (proto/stream-dom.proto, `CreatePlaceholder`),
            // so `data` is dropped. Dominator only ever creates empty
            // comments (dominator-0.5.38/src/bindings.rs:100).
            "createComment" => dom::create_comment(),
            // Any id resolves to the mount root, for the same reason
            // `body` does: it is the only element this side can name.
            // `dominator::get_id("app")` is exactly this call.
            "getElementById" => dom::mount_root(),
            _ => missing(self, method),
        })
    }

    fn node_invoke(&self, method: &str, args: &[JsValue]) -> Result<JsValue, JsValue> {
        Ok(match method {
            // --- Node ---
            "appendChild" => {
                let child = node_arg(method, args, 0);
                dom::insert_before(self, &child, None);
                child.value()
            }
            "insertBefore" => {
                let child = node_arg(method, args, 0);
                let anchor = opt_node_arg(method, args, 1);
                dom::insert_before(self, &child, anchor.as_deref());
                child.value()
            }
            "removeChild" => {
                let child = node_arg(method, args, 0);
                dom::remove_child(self, &child);
                child.value()
            }
            "replaceChild" => {
                let new = node_arg(method, args, 0);
                let old = node_arg(method, args, 1);
                dom::replace_child(self, &new, &old);
                // `replaceChild` returns the node it removed.
                old.value()
            }

            // --- Element ---
            "setAttribute" => {
                dom::set_attribute(
                    self,
                    &str_arg(method, args, 0),
                    None,
                    &str_arg(method, args, 1),
                );
                JsValue::UNDEFINED
            }
            "setAttributeNS" => {
                let ns = opt_str_arg(method, args, 0);
                dom::set_attribute(
                    self,
                    &str_arg(method, args, 1),
                    ns.as_deref(),
                    &str_arg(method, args, 2),
                );
                JsValue::UNDEFINED
            }
            "removeAttribute" => {
                dom::remove_attribute(self, &str_arg(method, args, 0), None);
                JsValue::UNDEFINED
            }
            "removeAttributeNS" => {
                let ns = opt_str_arg(method, args, 0);
                dom::remove_attribute(self, &str_arg(method, args, 1), ns.as_deref());
                JsValue::UNDEFINED
            }
            // `catch`, and a browser raises exactly this for an element
            // that cannot host a shadow root.
            "attachShadow" => return refused("NotSupportedError", "Element.attachShadow"),
            // Not `catch`: scrolling is the receiver's viewport.
            "scrollIntoView" => unsupported("Element.scrollIntoView"),

            // --- HTMLElement / SVGElement ---
            //
            // Focus is a host action, not a mutation: it is queued and
            // answered by the WIT `queries.set-focus` import after the batch
            // is committed (wit/stream-dom.wit `queries`).
            "focus" => {
                dom::queue_focus(self, true);
                JsValue::UNDEFINED
            }
            "blur" => {
                dom::queue_focus(self, false);
                JsValue::UNDEFINED
            }

            _ => missing(self, method),
        })
    }
}

// --- classList --------------------------------------------------------

impl JsObject for DomTokenListObj {
    fn class_chain(&self) -> &[&'static str] {
        &["DOMTokenList", "Object"]
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    /// Nothing here is readable: `classList` is write-only in this fake,
    /// because the class list the receiver has is whatever the last
    /// `set-attribute` said. Overriding rather than inheriting the trait
    /// default matters -- `DomTokenList::value` / `length` / the indexing
    /// getter would otherwise answer `undefined`, which reaches the caller
    /// as a silent `None` or an unnamed lift panic.
    fn get(&self, key: &str) -> Result<JsValue, JsValue> {
        missing(self, key)
    }

    fn invoke(&self, method: &str, args: &[JsValue]) -> Result<JsValue, JsValue> {
        // `add` and `remove` are variadic in the DOM; web-sys spells each
        // arity as its own binding (`add_1`, `add_2`, ...) but they all
        // carry the same `js_name`.
        match method {
            "add" => {
                for i in 0..args.len() {
                    dom::class_add(&self.node, &str_arg(method, args, i));
                }
            }
            "remove" => {
                for i in 0..args.len() {
                    dom::class_remove(&self.node, &str_arg(method, args, i));
                }
            }
            _ => missing(self, method),
        }
        Ok(JsValue::UNDEFINED)
    }
}

// --- CSSOM ------------------------------------------------------------

impl JsObject for StyleDeclObj {
    fn class_chain(&self) -> &[&'static str] {
        &["CSSStyleDeclaration", "Object"]
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn get(&self, key: &str) -> Result<JsValue, JsValue> {
        match key {
            // Serialising a whole declaration block back out would mean a
            // CSS parser on the read side; `dominator::stylesheet!`'s `raw`
            // escape hatch is the only caller and nothing here uses it.
            "cssText" => unsupported("CSSStyleDeclaration.cssText"),
            _ => missing(self, key),
        }
    }

    fn set(&self, key: &str, _value: JsValue) -> Result<(), JsValue> {
        match key {
            "cssText" => unsupported("CSSStyleDeclaration.cssText assignment"),
            _ => missing(self, key),
        }
    }

    fn invoke(&self, method: &str, args: &[JsValue]) -> Result<JsValue, JsValue> {
        Ok(match method {
            "getPropertyValue" => JsValue::from_str(&self.property(&str_arg(method, args, 0))),
            // Two web-sys bindings, one JS method: `set_property` passes
            // two arguments, `set_property_with_priority` three.
            "setProperty" => {
                let priority = opt_str_arg(method, args, 2).unwrap_or_default();
                self.set_property(
                    &str_arg(method, args, 0),
                    &str_arg(method, args, 1),
                    priority == "important",
                );
                JsValue::UNDEFINED
            }
            "removeProperty" => JsValue::from_str(&self.remove_property(&str_arg(method, args, 0))),
            _ => missing(self, method),
        })
    }
}

impl JsObject for StyleSheetObj {
    fn class_chain(&self) -> &[&'static str] {
        &["CSSStyleSheet", "StyleSheet", "CSSRuleList", "Object"]
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn get(&self, key: &str) -> Result<JsValue, JsValue> {
        Ok(match key {
            // The sheet is its own rule list here; see `StyleSheetObj`.
            "cssRules" => JsValue::from_object(self.rc()),
            "length" => JsValue::from_f64(self.len() as f64),
            // `CSSRuleList`'s `indexing_getter`, whose key the macro renders
            // with `index.to_string()`.
            _ => match key.parse::<u32>() {
                Ok(i) => self
                    .rule(i)
                    .map_or(JsValue::NULL, |r| JsValue::from_object(r)),
                Err(_) => missing(self, key),
            },
        })
    }

    fn invoke(&self, method: &str, args: &[JsValue]) -> Result<JsValue, JsValue> {
        match method {
            // `insertRule(text)` defaults the index to 0, as in the DOM;
            // dominator always passes one (`make_rule`).
            "insertRule" => {
                let text = str_arg(method, args, 0);
                let index = if args.len() > 1 {
                    u32_arg(method, args, 1)
                } else {
                    0
                };
                self.insert_rule(&text, index)
                    .map(|i| JsValue::from_f64(i as f64))
            }
            _ => missing(self, method),
        }
    }
}

impl JsObject for StyleRuleObj {
    fn class_chain(&self) -> &[&'static str] {
        &["CSSStyleRule", "CSSRule", "Object"]
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn get(&self, key: &str) -> Result<JsValue, JsValue> {
        match key {
            "style" => Ok(style_decl(StyleTarget::Rule(self.rc()))),
            _ => missing(self, key),
        }
    }
}

// --- Events -----------------------------------------------------------

impl JsObject for EventData {
    fn class_chain(&self) -> &[&'static str] {
        self.chain()
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn get(&self, key: &str) -> Result<JsValue, JsValue> {
        let num = |n: f64| Ok(JsValue::from_f64(n));
        let int = |n: i64| Ok(JsValue::from_f64(n as f64));
        Ok(match key {
            // --- Event ---
            "type" => JsValue::from_str(&self.name),
            // web-sys lifts this unchecked as an `EventTarget`; identity is
            // what handlers use it for.
            "target" => self.target.value(),

            // --- MouseEvent and its subclasses ---
            //
            // Keyed on the payload family, not the class name: dominator
            // hands handlers an `Event` and `unchecked_into`s it
            // (dominator-0.5.38/src/events.rs:51), so the class the caller
            // believes in is not evidence. A family mismatch panics inside
            // `mouse()` naming the event.
            "clientX" => return int(self.mouse().client_x as i64),
            "clientY" => return int(self.mouse().client_y as i64),
            "pageX" => return int(self.mouse().page_x as i64),
            "pageY" => return int(self.mouse().page_y as i64),
            "screenX" => return int(self.mouse().screen_x as i64),
            "screenY" => return int(self.mouse().screen_y as i64),
            "offsetX" => return int(self.mouse().offset_x as i64),
            "offsetY" => return int(self.mouse().offset_y as i64),
            // `movementX/Y` has no field in
            // proto/stream-dom-events.proto's `MouseData`: it is a
            // pointer-lock delta, not a snapshot a receiver can produce
            // from a single event.
            "movementX" => unsupported("MouseEvent.movementX"),
            "movementY" => unsupported("MouseEvent.movementY"),
            "button" => return int(self.mouse().button.unwrap_or(0) as i64),
            "buttons" => {
                // The bit order of `MouseEvent.buttons`, which differs from
                // `button`'s numbering (proto/stream-dom-events.proto,
                // `MouseButton`).
                let m = self.mouse();
                let bits = (m.primary as u16)
                    | (m.secondary as u16) << 1
                    | (m.auxiliary as u16) << 2
                    | (m.back as u16) << 3
                    | (m.forward as u16) << 4;
                return int(bits as i64);
            }
            "relatedTarget" => {
                if self.chain().contains(&"MouseEvent") {
                    node_or_null(self.mouse().related_target.and_then(dom::node_by_id))
                } else {
                    // The `focus` family carries no payload at all
                    // (proto/stream-dom-events.proto file header).
                    JsValue::NULL
                }
            }

            // --- Modifiers, shared by the mouse, key and touch families ---
            "altKey" => JsValue::from_bool(self.modifiers().alt),
            "ctrlKey" => JsValue::from_bool(self.modifiers().ctrl),
            "metaKey" => JsValue::from_bool(self.modifiers().meta),
            "shiftKey" => JsValue::from_bool(self.modifiers().shift),

            // --- KeyboardEvent ---
            "key" => JsValue::from_str(&self.keyboard().key),
            "code" => JsValue::from_str(&self.keyboard().code),
            "repeat" => JsValue::from_bool(self.keyboard().repeat),
            "isComposing" => JsValue::from_bool(self.keyboard().is_composing),
            "location" => return int(self.keyboard().location as i64),

            // --- InputEvent ---
            //
            // The inserted characters have no field in the `form` family: it
            // carries the control's whole value instead, which is what
            // handlers actually read.
            "data" => unsupported("InputEvent.data (read the target's value instead)"),

            // --- DragEvent ---
            //
            // A live object, not a snapshot: the protocol's answer is a WIT
            // resource, which `handle-event` cannot yet hand over
            // (docs/design.md "Events").
            "dataTransfer" => unsupported("DragEvent.dataTransfer"),

            // --- WheelEvent ---
            "deltaX" => return num(self.wheel().delta_x),
            "deltaY" => return num(self.wheel().delta_y),
            "deltaZ" => return num(self.wheel().delta_z),
            "deltaMode" => return int(self.wheel().delta_mode as i64),

            // --- PointerEvent ---
            "pointerId" => return int(self.pointer().pointer_id as i64),
            "width" => return int(self.pointer().width as i64),
            "height" => return int(self.pointer().height as i64),
            "pressure" => return num(self.pointer().pressure as f64),
            "tangentialPressure" => return num(self.pointer().tangential_pressure as f64),
            "tiltX" => return int(self.pointer().tilt_x as i64),
            "tiltY" => return int(self.pointer().tilt_y as i64),
            "twist" => return int(self.pointer().twist as i64),
            "pointerType" => JsValue::from_str(&self.pointer().pointer_type),
            "isPrimary" => JsValue::from_bool(self.pointer().is_primary),

            // --- TouchEvent ---
            //
            // `TouchPoint`s would have to become standalone JS objects to be
            // reachable through a `TouchList`, and nothing on the graph's
            // reachable paths reads them.
            "touches" => unsupported("TouchEvent.touches"),
            "changedTouches" => unsupported("TouchEvent.changedTouches"),
            "targetTouches" => unsupported("TouchEvent.targetTouches"),

            // --- AnimationEvent ---
            "animationName" => JsValue::from_str(&self.animation().animation_name),
            "elapsedTime" => return num(self.animation().elapsed_time),
            "pseudoElement" => JsValue::from_str(&self.animation().pseudo_element),

            _ => missing(self, key),
        })
    }

    fn invoke(&self, method: &str, args: &[JsValue]) -> Result<JsValue, JsValue> {
        let _ = args;
        match method {
            "preventDefault" => self.prevent_default(),
            "stopPropagation" => self.stop_propagation(),
            "stopImmediatePropagation" => self.stop_immediate_propagation(),
            _ => missing(self, method),
        }
        Ok(JsValue::UNDEFINED)
    }
}
