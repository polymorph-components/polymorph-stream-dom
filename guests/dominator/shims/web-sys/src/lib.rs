//! A fake `web-sys`: the browser API, translated onto the shadow DOM in
//! `stream-dom-fakedom`.
//!
//! Every type and method here exists because something in the graph
//! (dominator 0.5.38, gloo-events 0.1.2, or the TodoMVC port) names it.
//! Nothing is here speculatively. Methods that are named but cannot be
//! honoured -- layout reads, storage, navigation -- **panic** with a
//! message saying so; a fake DOM that silently answers `0` or `""` is the
//! failure mode this shim is built to avoid.
//!
//! Signatures mirror web-sys 0.3.105 for the subset used, so the framework
//! compiles unchanged. Dictionary types (`AddEventListenerOptions`,
//! `ScrollIntoViewOptions`, `ShadowRootInit`) are plain Rust structs here
//! rather than `JsValue` wrappers: nothing casts them, and the constructor
//! plus setters are the whole of their used surface.

use std::rc::Rc;

use js_sys::Function;
use stream_dom_fakedom::css::{
    DomTokenListObj, StyleDeclObj, StyleRuleObj, StyleSheetObj, StyleTarget,
};
use stream_dom_fakedom::dom;
use stream_dom_fakedom::event::EventData;
use stream_dom_fakedom::node::{node_of, NodeData};
use wasm_bindgen::{wrapper_type, JsValue};

// --- Type declarations ------------------------------------------------
//
// The inheritance chains follow the DOM's, because `instanceof` here is
// "is this class name in the object's chain" and dominator relies on it
// (`create_element::<A>` ends in `dyn_into`, dominator-0.5.38/src/dom.rs:576).

wrapper_type!(EventTarget, "EventTarget", extends: js_sys::Object);
wrapper_type!(Node, "Node", extends: EventTarget, js_sys::Object);
wrapper_type!(Element, "Element", extends: Node, EventTarget, js_sys::Object);
wrapper_type!(HtmlElement, "HTMLElement", extends: Element, Node, EventTarget, js_sys::Object);
wrapper_type!(SvgElement, "SVGElement", extends: Element, Node, EventTarget, js_sys::Object);
wrapper_type!(HtmlInputElement, "HTMLInputElement", extends: HtmlElement, Element, Node, EventTarget, js_sys::Object);
wrapper_type!(HtmlTextAreaElement, "HTMLTextAreaElement", extends: HtmlElement, Element, Node, EventTarget, js_sys::Object);
wrapper_type!(HtmlStyleElement, "HTMLStyleElement", extends: HtmlElement, Element, Node, EventTarget, js_sys::Object);
wrapper_type!(HtmlHeadElement, "HTMLHeadElement", extends: HtmlElement, Element, Node, EventTarget, js_sys::Object);
wrapper_type!(CharacterData, "CharacterData", extends: Node, EventTarget, js_sys::Object);
wrapper_type!(Text, "Text", extends: CharacterData, Node, EventTarget, js_sys::Object);
wrapper_type!(Comment, "Comment", extends: CharacterData, Node, EventTarget, js_sys::Object);
wrapper_type!(Document, "Document", extends: Node, EventTarget, js_sys::Object);
wrapper_type!(ShadowRoot, "ShadowRoot", extends: Node, EventTarget, js_sys::Object);
wrapper_type!(Window, "Window", extends: EventTarget, js_sys::Object);

wrapper_type!(DomTokenList, "DOMTokenList", extends: js_sys::Object);
wrapper_type!(CssStyleDeclaration, "CSSStyleDeclaration", extends: js_sys::Object);
wrapper_type!(StyleSheet, "StyleSheet", extends: js_sys::Object);
wrapper_type!(CssStyleSheet, "CSSStyleSheet", extends: StyleSheet, js_sys::Object);
wrapper_type!(CssRuleList, "CSSRuleList", extends: js_sys::Object);
wrapper_type!(CssRule, "CSSRule", extends: js_sys::Object);
wrapper_type!(CssStyleRule, "CSSStyleRule", extends: CssRule, js_sys::Object);

wrapper_type!(Event, "Event", extends: js_sys::Object);
wrapper_type!(UiEvent, "UIEvent", extends: Event, js_sys::Object);
wrapper_type!(MouseEvent, "MouseEvent", extends: UiEvent, Event, js_sys::Object);
wrapper_type!(PointerEvent, "PointerEvent", extends: MouseEvent, UiEvent, Event, js_sys::Object);
wrapper_type!(WheelEvent, "WheelEvent", extends: MouseEvent, UiEvent, Event, js_sys::Object);
wrapper_type!(DragEvent, "DragEvent", extends: MouseEvent, UiEvent, Event, js_sys::Object);
wrapper_type!(KeyboardEvent, "KeyboardEvent", extends: UiEvent, Event, js_sys::Object);
wrapper_type!(InputEvent, "InputEvent", extends: UiEvent, Event, js_sys::Object);
wrapper_type!(FocusEvent, "FocusEvent", extends: UiEvent, Event, js_sys::Object);
wrapper_type!(TouchEvent, "TouchEvent", extends: UiEvent, Event, js_sys::Object);
wrapper_type!(AnimationEvent, "AnimationEvent", extends: Event, js_sys::Object);

wrapper_type!(TouchList, "TouchList", extends: js_sys::Object);
wrapper_type!(Touch, "Touch", extends: js_sys::Object);
wrapper_type!(DataTransfer, "DataTransfer", extends: js_sys::Object);
wrapper_type!(MediaQueryList, "MediaQueryList", extends: EventTarget, js_sys::Object);
wrapper_type!(History, "History", extends: js_sys::Object);
wrapper_type!(Location, "Location", extends: js_sys::Object);
wrapper_type!(Storage, "Storage", extends: js_sys::Object);

// --- Enums ------------------------------------------------------------
//
// Real web-sys lowers these to JS strings via `#[wasm_bindgen]`. There is
// no JS here, so they are plain Rust enums; nothing in the graph does more
// than construct and pass them.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScrollBehavior {
    Auto,
    Instant,
    Smooth,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScrollLogicalPosition {
    Start,
    Center,
    End,
    Nearest,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShadowRootMode {
    Open,
    Closed,
}

// --- Dictionaries -----------------------------------------------------

/// gloo-events builds one of these per listener
/// (gloo-events-0.1.2/src/lib.rs:158), using the pre-0.3.71 mutating
/// setters.
#[derive(Debug, Default, Clone, Copy)]
pub struct AddEventListenerOptions {
    capture: bool,
    once: bool,
    passive: bool,
}

impl AddEventListenerOptions {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn capture(&mut self, val: bool) -> &mut Self {
        self.capture = val;
        self
    }

    pub fn once(&mut self, val: bool) -> &mut Self {
        self.once = val;
        self
    }

    pub fn passive(&mut self, val: bool) -> &mut Self {
        self.passive = val;
        self
    }
}

/// Write-only: `scroll_into_view_with_scroll_into_view_options` panics, so
/// nothing ever reads these back.
#[derive(Debug, Default, Clone, Copy)]
pub struct ScrollIntoViewOptions;

impl ScrollIntoViewOptions {
    pub fn new() -> Self {
        ScrollIntoViewOptions
    }

    pub fn set_behavior(&self, _val: ScrollBehavior) {
        // Interior-mutating setters in web-sys 0.3.105 take `&self`
        // because the receiver is a JS object. Nothing reads these back:
        // `scroll_into_view_with_scroll_into_view_options` panics.
    }

    pub fn set_block(&self, _val: ScrollLogicalPosition) {}

    pub fn set_inline(&self, _val: ScrollLogicalPosition) {}
}

/// Write-only, like [`ScrollIntoViewOptions`]: `attach_shadow` panics.
#[derive(Debug, Clone, Copy)]
pub struct ShadowRootInit;

impl ShadowRootInit {
    pub fn new(_mode: ShadowRootMode) -> Self {
        ShadowRootInit
    }
}

// --- Globals ----------------------------------------------------------

pub fn window() -> Option<Window> {
    Some(Window::from(dom::window()))
}

/// The mount root as a `Node`, for an app crate's mount function. Lives
/// here rather than in `stream-dom-fakedom` because `web_sys::Node` is a
/// type of *this* crate, and fakedom must not depend on it.
pub fn mount_root_node() -> Node {
    Node::from(dom::mount_root())
}

// --- Helpers ----------------------------------------------------------

/// Disambiguate `AsRef`: every wrapper type has several.
fn js<T: AsRef<JsValue>>(v: &T) -> &JsValue {
    v.as_ref()
}

fn node<T: AsRef<JsValue>>(v: &T) -> Rc<NodeData> {
    node_of(js(v))
}

fn ok<T>(v: T) -> Result<T, JsValue> {
    Ok(v)
}

fn unsupported(what: &str) -> ! {
    panic!("web-sys fake: {what} is not supported in this spike")
}

/// Layout is the receiver's, not the producer's. Reading it needs the WIT
/// `queries` imports (docs/design.md "Reads are `async`-typed host
/// imports"), which are `async` and so cannot answer a synchronous
/// `web_sys` getter at all.
fn layout_read(what: &str) -> ! {
    panic!("fakedom: {what} requires a query import; not in the spike")
}

// --- EventTarget ------------------------------------------------------

impl EventTarget {
    pub fn add_event_listener_with_callback(
        &self,
        ty: &str,
        listener: &Function,
    ) -> Result<(), JsValue> {
        dom::add_listener(
            &node(self),
            ty,
            false,
            false,
            AsRef::<JsValue>::as_ref(listener).clone(),
        );
        ok(())
    }

    pub fn add_event_listener_with_callback_and_bool(
        &self,
        ty: &str,
        listener: &Function,
        capture: bool,
    ) -> Result<(), JsValue> {
        dom::add_listener(
            &node(self),
            ty,
            capture,
            false,
            AsRef::<JsValue>::as_ref(listener).clone(),
        );
        ok(())
    }

    pub fn add_event_listener_with_callback_and_add_event_listener_options(
        &self,
        ty: &str,
        listener: &Function,
        options: &AddEventListenerOptions,
    ) -> Result<(), JsValue> {
        // `once` is not modelled: nothing in the graph registers a
        // one-shot listener whose auto-removal is observable, and the
        // protocol has no "once" bit for the receiver to honour.
        dom::add_listener(
            &node(self),
            ty,
            options.capture,
            options.passive,
            AsRef::<JsValue>::as_ref(listener).clone(),
        );
        ok(())
    }

    pub fn remove_event_listener_with_callback(
        &self,
        ty: &str,
        listener: &Function,
    ) -> Result<(), JsValue> {
        dom::remove_listener(&node(self), ty, AsRef::<JsValue>::as_ref(listener), false);
        ok(())
    }

    pub fn remove_event_listener_with_callback_and_bool(
        &self,
        ty: &str,
        listener: &Function,
        capture: bool,
    ) -> Result<(), JsValue> {
        dom::remove_listener(&node(self), ty, AsRef::<JsValue>::as_ref(listener), capture);
        ok(())
    }
}

// --- Node -------------------------------------------------------------

impl Node {
    pub fn append_child(&self, child: &Node) -> Result<Node, JsValue> {
        dom::insert_before(&node(self), &node(child), None);
        ok(child.clone())
    }

    pub fn insert_before(&self, child: &Node, anchor: Option<&Node>) -> Result<Node, JsValue> {
        let anchor = anchor.map(node);
        dom::insert_before(&node(self), &node(child), anchor.as_deref());
        ok(child.clone())
    }

    pub fn remove_child(&self, child: &Node) -> Result<Node, JsValue> {
        dom::remove_child(&node(self), &node(child));
        ok(child.clone())
    }

    pub fn replace_child(&self, new: &Node, old: &Node) -> Result<Node, JsValue> {
        dom::replace_child(&node(self), &node(new), &node(old));
        ok(old.clone())
    }

    pub fn set_text_content(&self, value: Option<&str>) {
        dom::set_text_content(&node(self), value);
    }

    pub fn parent_node(&self) -> Option<Node> {
        node(self).parent().map(|p| Node::from(p.value()))
    }

    pub fn first_child(&self) -> Option<Node> {
        node(self).children().first().map(|c| Node::from(c.value()))
    }
}

// --- CharacterData / Text ---------------------------------------------

impl CharacterData {
    pub fn set_data(&self, value: &str) {
        dom::set_data(&node(self), value);
    }
}

// --- Element ----------------------------------------------------------

impl Element {
    pub fn set_attribute(&self, name: &str, value: &str) -> Result<(), JsValue> {
        dom::set_attribute(&node(self), name, None, value);
        ok(())
    }

    pub fn set_attribute_ns(
        &self,
        namespace: Option<&str>,
        name: &str,
        value: &str,
    ) -> Result<(), JsValue> {
        dom::set_attribute(&node(self), name, namespace, value);
        ok(())
    }

    pub fn remove_attribute(&self, name: &str) -> Result<(), JsValue> {
        dom::remove_attribute(&node(self), name, None);
        ok(())
    }

    pub fn remove_attribute_ns(&self, namespace: Option<&str>, name: &str) -> Result<(), JsValue> {
        dom::remove_attribute(&node(self), name, namespace);
        ok(())
    }

    pub fn class_list(&self) -> DomTokenList {
        DomTokenList::from(JsValue::from_object(Rc::new(DomTokenListObj {
            node: node(self),
        })))
    }

    pub fn set_scroll_top(&self, _v: i32) {
        unsupported("Element.scrollTop assignment")
    }

    pub fn set_scroll_left(&self, _v: i32) {
        unsupported("Element.scrollLeft assignment")
    }

    pub fn attach_shadow(&self, _init: &ShadowRootInit) -> Result<ShadowRoot, JsValue> {
        unsupported("Element.attachShadow")
    }

    pub fn scroll_into_view_with_scroll_into_view_options(&self, _o: &ScrollIntoViewOptions) {
        unsupported("Element.scrollIntoView")
    }
}

// --- HtmlElement ------------------------------------------------------

fn style_decl(target: StyleTarget) -> CssStyleDeclaration {
    CssStyleDeclaration::from(JsValue::from_object(Rc::new(StyleDeclObj { target })))
}

impl HtmlElement {
    pub fn style(&self) -> CssStyleDeclaration {
        style_decl(StyleTarget::Element(node(self)))
    }

    /// Focus is a host action, not a mutation: it is queued and answered
    /// by the WIT `queries.set-focus` import after the batch is committed
    /// (wit/stream-dom.wit `queries`).
    pub fn focus(&self) -> Result<(), JsValue> {
        dom::queue_focus(&node(self), true);
        ok(())
    }

    pub fn blur(&self) -> Result<(), JsValue> {
        dom::queue_focus(&node(self), false);
        ok(())
    }
}

impl SvgElement {
    pub fn style(&self) -> CssStyleDeclaration {
        style_decl(StyleTarget::Element(node(self)))
    }

    pub fn focus(&self) -> Result<(), JsValue> {
        dom::queue_focus(&node(self), true);
        ok(())
    }

    pub fn blur(&self) -> Result<(), JsValue> {
        dom::queue_focus(&node(self), false);
        ok(())
    }
}

// --- Form controls ----------------------------------------------------
//
// `value` and `checked` are DOM *properties*: reads answer the last value
// written by the producer or delivered with an event, which is what makes
// `element.value()` inside a handler see the user's text (see
// `stream_dom_fakedom::event::dispatch`).

impl HtmlInputElement {
    /// `HTMLInputElement.type`, which reflects the `type` attribute and
    /// defaults to `"text"`.
    pub fn type_(&self) -> String {
        node(self)
            .attr("type")
            .unwrap_or_else(|| "text".to_string())
    }

    pub fn value(&self) -> String {
        node(self).prop("value").as_string().unwrap_or_default()
    }

    pub fn checked(&self) -> bool {
        node(self).prop("checked").as_bool().unwrap_or(false)
    }
}

impl HtmlTextAreaElement {
    pub fn value(&self) -> String {
        node(self).prop("value").as_string().unwrap_or_default()
    }
}

impl HtmlStyleElement {
    pub fn set_type(&self, value: &str) {
        dom::set_attribute(&node(self), "type", None, value);
    }

    pub fn sheet(&self) -> Option<StyleSheet> {
        Some(StyleSheet::from(JsValue::from_object(StyleSheetObj::new(
            node(self),
        ))))
    }
}

// --- CSSOM ------------------------------------------------------------

fn sheet_of<T: AsRef<JsValue>>(v: &T) -> Rc<StyleSheetObj> {
    js(v)
        .downcast_ref::<StyleSheetObj>()
        .expect("web-sys fake: expected a CSSStyleSheet")
        .rc()
}

impl CssStyleSheet {
    pub fn css_rules(&self) -> Result<CssRuleList, JsValue> {
        // The sheet is its own rule list here; see `StyleSheetObj`.
        ok(CssRuleList::from(js(self).clone()))
    }

    pub fn insert_rule_with_index(&self, rule: &str, index: u32) -> Result<u32, JsValue> {
        sheet_of(self).insert_rule(rule, index)
    }
}

impl CssRuleList {
    pub fn length(&self) -> u32 {
        sheet_of(self).len()
    }

    pub fn get(&self, index: u32) -> Option<CssRule> {
        sheet_of(self)
            .rule(index)
            .map(|r| CssRule::from(JsValue::from_object(r)))
    }
}

impl CssStyleRule {
    pub fn style(&self) -> CssStyleDeclaration {
        let rule = js(self)
            .downcast_ref::<StyleRuleObj>()
            .expect("web-sys fake: expected a CSSStyleRule")
            .rc();
        style_decl(StyleTarget::Rule(rule))
    }
}

fn decl_of(v: &CssStyleDeclaration) -> &StyleDeclObj {
    js(v)
        .downcast_ref::<StyleDeclObj>()
        .expect("web-sys fake: expected a CSSStyleDeclaration")
}

impl CssStyleDeclaration {
    pub fn get_property_value(&self, name: &str) -> Result<String, JsValue> {
        ok(decl_of(self).get(name))
    }

    pub fn set_property(&self, name: &str, value: &str) -> Result<(), JsValue> {
        decl_of(self).set(name, value, false);
        ok(())
    }

    pub fn set_property_with_priority(
        &self,
        name: &str,
        value: &str,
        priority: &str,
    ) -> Result<(), JsValue> {
        decl_of(self).set(name, value, priority == "important");
        ok(())
    }

    pub fn remove_property(&self, name: &str) -> Result<String, JsValue> {
        ok(decl_of(self).remove(name))
    }

    /// Serialising a whole declaration block back out would mean a CSS
    /// parser on the read side; `dominator::stylesheet!`'s `raw` escape
    /// hatch is the only caller and nothing here uses it.
    pub fn css_text(&self) -> String {
        unsupported("CSSStyleDeclaration.cssText")
    }

    pub fn set_css_text(&self, _value: &str) {
        unsupported("CSSStyleDeclaration.cssText assignment")
    }
}

// --- DOMTokenList -----------------------------------------------------

fn token_node(v: &DomTokenList) -> Rc<NodeData> {
    js(v)
        .downcast_ref::<DomTokenListObj>()
        .expect("web-sys fake: expected a DOMTokenList")
        .node
        .clone()
}

impl DomTokenList {
    pub fn add_1(&self, value: &str) -> Result<(), JsValue> {
        dom::class_add(&token_node(self), value);
        ok(())
    }

    pub fn remove_1(&self, value: &str) -> Result<(), JsValue> {
        dom::class_remove(&token_node(self), value);
        ok(())
    }
}

// --- Document / Window ------------------------------------------------

impl Document {
    pub fn create_element(&self, tag: &str) -> Result<Element, JsValue> {
        ok(Element::from(dom::create_element(tag, None)))
    }

    pub fn create_element_ns(
        &self,
        namespace: Option<&str>,
        tag: &str,
    ) -> Result<Element, JsValue> {
        ok(Element::from(dom::create_element(tag, namespace)))
    }

    pub fn create_text_node(&self, data: &str) -> Text {
        Text::from(dom::create_text(data))
    }

    /// The protocol's comment node is a bare insertion anchor and carries
    /// no text (proto/stream-dom.proto, `CreatePlaceholder`), so `data` is
    /// dropped. Dominator only ever creates empty comments
    /// (dominator-0.5.38/src/bindings.rs:100).
    pub fn create_comment(&self, _data: &str) -> Comment {
        Comment::from(dom::create_comment())
    }

    /// Any id resolves to the mount root. A producer has no document: the
    /// receiver owns everything above the mount, so the only element this
    /// side can name by id is the root the receiver gave it. `dominator::
    /// get_id("app")` is exactly this call, and the root is what it means.
    pub fn get_element_by_id(&self, _id: &str) -> Option<Element> {
        Some(Element::from(dom::mount_root()))
    }

    pub fn body(&self) -> Option<HtmlElement> {
        Some(HtmlElement::from(dom::mount_root()))
    }

    /// The mount root, so dominator's generated `<style>` element lands
    /// inside the mount and its CSS actually reaches the receiver. See
    /// `stream_dom_fakedom::css` for why there is a stylesheet at all.
    pub fn head(&self) -> Option<HtmlHeadElement> {
        Some(HtmlHeadElement::from(dom::mount_root()))
    }

    pub fn ready_state(&self) -> String {
        // The producer's tree is always ready: there is no parser here.
        "complete".to_string()
    }
}

impl Window {
    pub fn document(&self) -> Option<Document> {
        Some(Document::from(dom::document()))
    }

    pub fn history(&self) -> Result<History, JsValue> {
        unsupported("Window.history")
    }

    pub fn location(&self) -> Location {
        unsupported("Window.location")
    }

    pub fn local_storage(&self) -> Result<Option<Storage>, JsValue> {
        unsupported("Window.localStorage")
    }

    pub fn match_media(&self, _query: &str) -> Result<Option<MediaQueryList>, JsValue> {
        unsupported("Window.matchMedia")
    }

    /// A producer has no frame clock of its own: the protocol's answer is
    /// the synthetic `frame` event, subscribed at the mount root
    /// (docs/design.md "Events"). Dominator's animation module is the only
    /// caller and the TodoMVC port does not animate.
    pub fn request_animation_frame(&self, _cb: &Function) -> Result<i32, JsValue> {
        unsupported("Window.requestAnimationFrame (use the synthetic `frame` event)")
    }

    pub fn cancel_animation_frame(&self, _handle: i32) -> Result<(), JsValue> {
        unsupported("Window.cancelAnimationFrame")
    }

    pub fn inner_width(&self) -> Result<JsValue, JsValue> {
        layout_read("Window.innerWidth")
    }

    pub fn inner_height(&self) -> Result<JsValue, JsValue> {
        layout_read("Window.innerHeight")
    }
}

impl MediaQueryList {
    pub fn matches(&self) -> bool {
        unsupported("MediaQueryList.matches")
    }
}

impl History {
    pub fn push_state_with_url(
        &self,
        _data: &JsValue,
        _title: &str,
        _url: Option<&str>,
    ) -> Result<(), JsValue> {
        unsupported("History.pushState")
    }

    pub fn replace_state_with_url(
        &self,
        _data: &JsValue,
        _title: &str,
        _url: Option<&str>,
    ) -> Result<(), JsValue> {
        unsupported("History.replaceState")
    }
}

impl Location {
    pub fn href(&self) -> Result<String, JsValue> {
        unsupported("Location.href")
    }
}

impl Storage {
    pub fn get_item(&self, _key: &str) -> Result<Option<String>, JsValue> {
        unsupported("Storage.getItem")
    }

    pub fn set_item(&self, _key: &str, _value: &str) -> Result<(), JsValue> {
        unsupported("Storage.setItem")
    }
}

// --- Events -----------------------------------------------------------

fn event_of<T: AsRef<JsValue>>(v: &T) -> &EventData {
    js(v)
        .downcast_ref::<EventData>()
        .expect("web-sys fake: expected an Event")
}

impl Event {
    pub fn type_(&self) -> String {
        event_of(self).name.clone()
    }

    pub fn target(&self) -> Option<EventTarget> {
        Some(EventTarget::from(event_of(self).target.value()))
    }

    pub fn prevent_default(&self) {
        event_of(self).prevent_default();
    }

    pub fn stop_propagation(&self) {
        event_of(self).stop_propagation();
    }

    pub fn stop_immediate_propagation(&self) {
        event_of(self).stop_immediate_propagation();
    }
}

macro_rules! mouse_getters {
    ($($t:ty),* $(,)?) => {$(
        impl $t {
            pub fn client_x(&self) -> i32 { event_of(self).mouse().client_x as i32 }
            pub fn client_y(&self) -> i32 { event_of(self).mouse().client_y as i32 }
            pub fn page_x(&self) -> i32 { event_of(self).mouse().page_x as i32 }
            pub fn page_y(&self) -> i32 { event_of(self).mouse().page_y as i32 }
            pub fn screen_x(&self) -> i32 { event_of(self).mouse().screen_x as i32 }
            pub fn screen_y(&self) -> i32 { event_of(self).mouse().screen_y as i32 }
            pub fn offset_x(&self) -> i32 { event_of(self).mouse().offset_x as i32 }
            pub fn offset_y(&self) -> i32 { event_of(self).mouse().offset_y as i32 }

            /// `MouseEvent.movementX/Y` has no field in
            /// proto/stream-dom-events.proto's `MouseData`: it is a
            /// pointer-lock delta, not a snapshot a receiver can produce
            /// from a single event.
            pub fn movement_x(&self) -> i32 { unsupported("MouseEvent.movementX") }
            pub fn movement_y(&self) -> i32 { unsupported("MouseEvent.movementY") }

            pub fn button(&self) -> i16 {
                event_of(self).mouse().button.unwrap_or(0) as i16
            }

            pub fn buttons(&self) -> u16 {
                // The bit order of `MouseEvent.buttons`, which differs from
                // `button`'s numbering (proto/stream-dom-events.proto,
                // `MouseButton`).
                let m = event_of(self).mouse();
                (m.primary as u16)
                    | (m.secondary as u16) << 1
                    | (m.auxiliary as u16) << 2
                    | (m.back as u16) << 3
                    | (m.forward as u16) << 4
            }

            pub fn alt_key(&self) -> bool { event_of(self).modifiers().alt }
            pub fn ctrl_key(&self) -> bool { event_of(self).modifiers().ctrl }
            pub fn meta_key(&self) -> bool { event_of(self).modifiers().meta }
            pub fn shift_key(&self) -> bool { event_of(self).modifiers().shift }

            pub fn related_target(&self) -> Option<EventTarget> {
                event_of(self)
                    .mouse()
                    .related_target
                    .and_then(dom::node_by_id)
                    .map(|n| EventTarget::from(n.value()))
            }
        }
    )*};
}

mouse_getters!(MouseEvent, PointerEvent, WheelEvent, DragEvent);

impl KeyboardEvent {
    pub fn key(&self) -> String {
        event_of(self).keyboard().key.clone()
    }

    pub fn code(&self) -> String {
        event_of(self).keyboard().code.clone()
    }

    pub fn repeat(&self) -> bool {
        event_of(self).keyboard().repeat
    }

    pub fn is_composing(&self) -> bool {
        event_of(self).keyboard().is_composing
    }

    pub fn location(&self) -> u32 {
        event_of(self).keyboard().location as u32
    }

    pub fn alt_key(&self) -> bool {
        event_of(self).modifiers().alt
    }

    pub fn ctrl_key(&self) -> bool {
        event_of(self).modifiers().ctrl
    }

    pub fn meta_key(&self) -> bool {
        event_of(self).modifiers().meta
    }

    pub fn shift_key(&self) -> bool {
        event_of(self).modifiers().shift
    }
}

impl InputEvent {
    /// `InputEvent.data` (the inserted characters) has no field in the
    /// `form` family: it carries the control's whole value instead, which
    /// is what handlers actually read.
    pub fn data(&self) -> Option<String> {
        unsupported("InputEvent.data (read the target's value instead)")
    }
}

impl FocusEvent {
    pub fn related_target(&self) -> Option<EventTarget> {
        // The `focus` family carries no payload at all
        // (proto/stream-dom-events.proto file header).
        None
    }
}

impl DragEvent {
    pub fn data_transfer(&self) -> Option<DataTransfer> {
        // A live object, not a snapshot: the protocol's answer is a WIT
        // resource, which `handle-event` cannot yet hand over
        // (docs/design.md "Events").
        unsupported("DragEvent.dataTransfer")
    }
}

impl AnimationEvent {
    pub fn animation_name(&self) -> String {
        match &event_of(self).payload.family {
            Some(stream_dom_guest::proto::event_payload::Family::Animation(a)) => {
                a.animation_name.clone()
            }
            _ => unsupported("AnimationEvent without an animation payload"),
        }
    }

    pub fn elapsed_time(&self) -> f32 {
        match &event_of(self).payload.family {
            Some(stream_dom_guest::proto::event_payload::Family::Animation(a)) => {
                a.elapsed_time as f32
            }
            _ => unsupported("AnimationEvent without an animation payload"),
        }
    }

    pub fn pseudo_element(&self) -> String {
        match &event_of(self).payload.family {
            Some(stream_dom_guest::proto::event_payload::Family::Animation(a)) => {
                a.pseudo_element.clone()
            }
            _ => unsupported("AnimationEvent without an animation payload"),
        }
    }
}

impl WheelEvent {
    pub fn delta_x(&self) -> f64 {
        wheel(self).delta_x
    }

    pub fn delta_y(&self) -> f64 {
        wheel(self).delta_y
    }

    pub fn delta_z(&self) -> f64 {
        wheel(self).delta_z
    }

    pub fn delta_mode(&self) -> u32 {
        wheel(self).delta_mode as u32
    }
}

fn wheel(e: &WheelEvent) -> &stream_dom_guest::proto::WheelData {
    match &event_of(e).payload.family {
        Some(stream_dom_guest::proto::event_payload::Family::Wheel(w)) => w,
        _ => unsupported("WheelEvent without a wheel payload"),
    }
}

fn pointer(e: &PointerEvent) -> &stream_dom_guest::proto::PointerData {
    match &event_of(e).payload.family {
        Some(stream_dom_guest::proto::event_payload::Family::Pointer(p)) => p,
        _ => unsupported("PointerEvent without a pointer payload"),
    }
}

impl PointerEvent {
    pub fn pointer_id(&self) -> i32 {
        pointer(self).pointer_id
    }

    pub fn width(&self) -> i32 {
        pointer(self).width as i32
    }

    pub fn height(&self) -> i32 {
        pointer(self).height as i32
    }

    pub fn pressure(&self) -> f32 {
        pointer(self).pressure
    }

    pub fn tangential_pressure(&self) -> f32 {
        pointer(self).tangential_pressure
    }

    pub fn tilt_x(&self) -> i32 {
        pointer(self).tilt_x
    }

    pub fn tilt_y(&self) -> i32 {
        pointer(self).tilt_y
    }

    pub fn twist(&self) -> i32 {
        pointer(self).twist
    }

    pub fn pointer_type(&self) -> String {
        pointer(self).pointer_type.clone()
    }

    pub fn is_primary(&self) -> bool {
        pointer(self).is_primary
    }
}

fn touch_data(e: &TouchEvent) -> &stream_dom_guest::proto::TouchData {
    match &event_of(e).payload.family {
        Some(stream_dom_guest::proto::event_payload::Family::Touch(t)) => t,
        _ => unsupported("TouchEvent without a touch payload"),
    }
}

impl TouchEvent {
    // `TouchPoint`s would have to become standalone JS objects to be
    // reachable through a `TouchList`, and nothing on the graph's
    // reachable paths reads them.
    pub fn touches(&self) -> TouchList {
        unsupported("TouchEvent.touches")
    }

    pub fn changed_touches(&self) -> TouchList {
        unsupported("TouchEvent.changedTouches")
    }

    pub fn target_touches(&self) -> TouchList {
        unsupported("TouchEvent.targetTouches")
    }

    pub fn alt_key(&self) -> bool {
        touch_data(self).modifiers.unwrap_or_default().alt
    }

    pub fn ctrl_key(&self) -> bool {
        touch_data(self).modifiers.unwrap_or_default().ctrl
    }

    pub fn meta_key(&self) -> bool {
        touch_data(self).modifiers.unwrap_or_default().meta
    }

    pub fn shift_key(&self) -> bool {
        touch_data(self).modifiers.unwrap_or_default().shift
    }
}

impl TouchList {
    pub fn length(&self) -> u32 {
        unsupported("TouchList.length")
    }

    pub fn get(&self, _index: u32) -> Option<Touch> {
        unsupported("TouchList.item")
    }
}

// --- console ----------------------------------------------------------

pub mod console {
    //! Routed to stderr: a component's `wasi:cli/stderr` is the nearest
    //! thing to a devtools console.
    use wasm_bindgen::JsValue;

    pub fn log_1(a: &JsValue) {
        eprintln!("[console.log] {a:?}");
    }

    pub fn warn_1(a: &JsValue) {
        eprintln!("[console.warn] {a:?}");
    }

    pub fn error_1(a: &JsValue) {
        eprintln!("[console.error] {a:?}");
    }
}
