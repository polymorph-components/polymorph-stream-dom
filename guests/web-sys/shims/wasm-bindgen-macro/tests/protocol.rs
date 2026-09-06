//! What the generated bindings actually do, observed through the
//! [`JsObject`] protocol rather than by matching emitted tokens.
//!
//! The point of every assertion here is the *exact* `js_name` a binding
//! sends and the *exact* protocol call it picks: a fake DOM dispatches on
//! those strings, so `"textContent"` arriving as `"text_content"` is a
//! silently-dead property, which is the failure mode this whole shim
//! exists to avoid.

use std::cell::RefCell;
use std::panic::AssertUnwindSafe;
use std::rc::Rc;

use wasm_bindgen::prelude::*;
use wasm_bindgen::{JsObject, JsValue};

// ---------------------------------------------------------------------
// A recording object
// ---------------------------------------------------------------------

#[derive(Default)]
struct Recorder {
    log: RefCell<Vec<String>>,
    /// Canned answers, keyed by property name or method name.
    replies: RefCell<Vec<(String, JsValue)>>,
    /// Names that throw instead of answering.
    throws: RefCell<Vec<String>>,
}

impl Recorder {
    fn new() -> Rc<Recorder> {
        Rc::new(Recorder::default())
    }

    fn reply(&self, key: &str, v: JsValue) {
        let mut replies = self.replies.borrow_mut();
        match replies.iter_mut().find(|(k, _)| k == key) {
            Some(slot) => slot.1 = v,
            None => replies.push((key.to_string(), v)),
        }
    }

    fn throw(&self, key: &str) {
        self.throws.borrow_mut().push(key.to_string());
    }

    fn answer(&self, key: &str) -> Result<JsValue, JsValue> {
        if self.throws.borrow().iter().any(|k| k == key) {
            return Err(JsValue::from_str(&format!("thrown by {key}")));
        }
        Ok(self
            .replies
            .borrow()
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
            .unwrap_or(JsValue::UNDEFINED))
    }

    fn record(&self, entry: String) {
        self.log.borrow_mut().push(entry);
    }

    fn log(&self) -> Vec<String> {
        self.log.borrow().clone()
    }
}

impl JsObject for Recorder {
    fn class_chain(&self) -> &[&'static str] {
        &["Widget", "Base", "Object"]
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn get(&self, key: &str) -> Result<JsValue, JsValue> {
        self.record(format!("get {key}"));
        self.answer(key)
    }

    fn set(&self, key: &str, value: JsValue) -> Result<(), JsValue> {
        self.record(format!("set {key} = {value:?}"));
        self.answer(key).map(|_| ())
    }

    fn invoke(&self, method: &str, args: &[JsValue]) -> Result<JsValue, JsValue> {
        self.record(format!("invoke {method}{args:?}"));
        self.answer(method)
    }
}

/// A callable that records what it was constructed with, installed on the
/// global so `__rt::construct` can find it.
struct Ctor(Rc<Recorder>);

impl JsObject for Ctor {
    fn class_chain(&self) -> &[&'static str] {
        &["Function", "Object"]
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
    fn call(&self, _this: &JsValue, args: &[JsValue]) -> Result<JsValue, JsValue> {
        self.0.record(format!("new Widget{args:?}"));
        Ok(JsValue::from_object(self.0.clone()))
    }
    fn invoke(&self, method: &str, args: &[JsValue]) -> Result<JsValue, JsValue> {
        self.0.record(format!("static Widget.{method}{args:?}"));
        Ok(JsValue::from_str("static"))
    }
}

/// Install a global carrying `Widget` (as both constructor and static
/// namespace) and a `console` namespace, and hand back the recorder both
/// share.
fn install() -> Rc<Recorder> {
    let rec = Recorder::new();
    let global = wasm_bindgen::__rt::PlainObject::new();
    let ctor = JsValue::from_object(Rc::new(Ctor(rec.clone())));
    global.set_prop("Widget", ctor.clone()).unwrap();
    global.set_prop("console", ctor).unwrap();
    wasm_bindgen::__rt::install_global(global);
    rec
}

fn widget(rec: &Rc<Recorder>) -> Widget {
    JsCast::unchecked_from_js(JsValue::from_object(rec.clone()))
}

// ---------------------------------------------------------------------
// The bindings under test, in the shapes web-sys 0.3.105 emits
// ---------------------------------------------------------------------

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_name = "Base")]
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub type Base;

    #[wasm_bindgen(method, js_name = "describe")]
    pub fn describe(this: &Base) -> String;

    #[wasm_bindgen(extends = Base, js_name = "Widget", typescript_type = "Widget")]
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub type Widget;

    /// `getter = "X"`: the property is X, whatever the Rust name is.
    #[wasm_bindgen(method, getter = "textContent", js_class = "Widget")]
    pub fn text_content(this: &Widget) -> Option<String>;

    /// A bare `getter` with a `js_name`: the property is the `js_name`.
    #[wasm_bindgen(method, getter, js_name = "tagName")]
    pub fn tag_name(this: &Widget) -> String;

    /// A bare `getter` with no `js_name`: the property is the Rust
    /// identifier *verbatim* — no lowerCamelCase conversion.
    #[wasm_bindgen(method, getter)]
    pub fn some_width(this: &Widget) -> u32;

    /// A bare `setter` with a `js_name`: the property is the `js_name`.
    #[wasm_bindgen(method, setter, js_name = "textContent")]
    pub fn set_text_content(this: &Widget, value: Option<&str>);

    /// A bare `setter` with no `js_name`: the Rust name minus `set_`.
    #[wasm_bindgen(method, setter)]
    pub fn set_some_width(this: &Widget, value: u32);

    #[wasm_bindgen(method, js_name = "setAttribute", is_type_of = |_| false)]
    pub fn set_attribute(this: &Widget, name: &str, value: &str);

    #[wasm_bindgen(catch, method, js_name = "query")]
    pub fn query(this: &Widget, selector: &str) -> Result<Option<Widget>, JsValue>;

    #[wasm_bindgen(method, js_name = "query")]
    pub fn query_uncaught(this: &Widget, selector: &str) -> Option<Widget>;

    #[wasm_bindgen(method, indexing_getter)]
    pub fn get(this: &Widget, index: u32) -> Option<String>;

    #[wasm_bindgen(method, indexing_setter)]
    pub fn set(this: &Widget, index: u32, value: &str);

    #[wasm_bindgen(method, indexing_deleter)]
    pub fn delete(this: &Widget, index: u32);

    #[wasm_bindgen(catch, constructor, js_class = "Widget")]
    pub fn new(kind: &str) -> Result<Widget, JsValue>;

    #[wasm_bindgen(static_method_of = Widget, js_class = "Widget", js_name = "isSupported")]
    pub fn is_supported(kind: &str) -> String;

    #[wasm_bindgen(js_namespace = "console", js_name = "log")]
    pub fn console_log(message: &str) -> String;
}

/// An `extern` block behind a JS module: declared, but not callable.
#[wasm_bindgen(module = "/js/helpers.js")]
extern "C" {
    #[wasm_bindgen(js_name = "helper")]
    pub fn helper(x: u32) -> u32;
}

/// A string enum, as `gen_ScrollBehavior.rs:9`.
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Behavior {
    Auto = "auto",
    Smooth = "smooth",
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(method, getter = "behavior")]
    pub fn behavior(this: &Widget) -> Option<Behavior>;

    #[wasm_bindgen(method, setter = "behavior")]
    pub fn set_behavior(this: &Widget, value: Behavior);
}

/// A `#[wasm_bindgen]` on anything that is not an extern block or an enum
/// describes an export to JS, which means nothing here: the item must
/// survive unchanged with the attribute gone.
#[wasm_bindgen]
pub struct Exported {
    #[wasm_bindgen(readonly)]
    pub field: u32,
}

#[wasm_bindgen]
impl Exported {
    #[wasm_bindgen(constructor)]
    pub fn make(field: u32) -> Exported {
        Exported { field }
    }
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

#[test]
fn getters_read_the_js_name_the_real_parser_would_pick() {
    let rec = install();
    rec.reply("textContent", JsValue::from_str("hi"));
    rec.reply("tagName", JsValue::from_str("DIV"));
    rec.reply("some_width", JsValue::from_f64(7.0));
    let w = widget(&rec);

    assert_eq!(w.text_content(), Some("hi".to_string()));
    assert_eq!(w.tag_name(), "DIV");
    assert_eq!(w.some_width(), 7);
    assert_eq!(
        rec.log(),
        ["get textContent", "get tagName", "get some_width"]
    );
}

#[test]
fn an_absent_getter_is_undefined_and_option_absorbs_it() {
    let rec = install();
    let w = widget(&rec);
    assert_eq!(w.text_content(), None);
    // ...but a non-`Option` primitive lift is strict, so the same
    // `undefined` is a panic naming the type rather than a zero.
    let err = std::panic::catch_unwind(AssertUnwindSafe(|| widget(&rec).some_width()))
        .expect_err("undefined must not lift as u32");
    let msg = err.downcast_ref::<String>().expect("String payload");
    assert!(msg.contains("expected a number (u32)"), "{msg}");
}

#[test]
fn setters_write_the_js_name_the_real_parser_would_pick() {
    let rec = install();
    let w = widget(&rec);
    w.set_text_content(Some("x"));
    w.set_text_content(None);
    w.set_some_width(3);
    assert_eq!(
        rec.log(),
        [
            r#"set textContent = "x""#,
            "set textContent = undefined",
            "set some_width = 3",
        ]
    );
}

#[test]
fn methods_invoke_with_lowered_arguments() {
    let rec = install();
    let w = widget(&rec);
    w.set_attribute("class", "big");
    assert_eq!(rec.log(), [r#"invoke setAttribute["class", "big"]"#]);
}

#[test]
fn indexing_bindings_use_the_stringified_index() {
    let rec = install();
    rec.reply("2", JsValue::from_str("third"));
    let w = widget(&rec);

    assert_eq!(w.get(2), Some("third".to_string()));
    w.set(5, "fifth");
    w.delete(5);
    assert_eq!(
        rec.log(),
        ["get 2", r#"set 5 = "fifth""#, "set 5 = undefined"]
    );
}

#[test]
fn catch_surfaces_a_throw_and_its_absence_panics() {
    let rec = install();
    rec.throw("query");
    let w = widget(&rec);

    assert_eq!(w.query("a"), Err(JsValue::from_str("thrown by query")));

    let err = std::panic::catch_unwind(AssertUnwindSafe(|| widget(&rec).query_uncaught("a")))
        .expect_err("an uncaught throw must panic");
    let msg = err.downcast_ref::<String>().expect("String payload");
    assert_eq!(msg, "uncaught exception: thrown by query");
}

#[test]
fn a_wrapper_return_lifts_through_the_protocol() {
    let rec = install();
    rec.reply("query", JsValue::from_object(rec.clone()));
    let w = widget(&rec);
    let found = w.query("a").unwrap().expect("an object is Some");
    assert_eq!(
        AsRef::<JsValue>::as_ref(&found),
        AsRef::<JsValue>::as_ref(&w)
    );
}

#[test]
fn a_constructor_calls_the_global_of_that_class() {
    let rec = install();
    let w = Widget::new("button").expect("constructed");
    assert_eq!(rec.log(), [r#"new Widget["button"]"#]);
    // The constructor's return value is what the class function returned.
    assert_eq!(
        AsRef::<JsValue>::as_ref(&w),
        &JsValue::from_object(rec.clone())
    );
}

#[test]
fn statics_and_namespaced_free_functions_walk_the_global() {
    let rec = install();
    assert_eq!(Widget::is_supported("button"), "static");
    assert_eq!(console_log("hello"), "static");
    assert_eq!(
        rec.log(),
        [
            r#"static Widget.isSupported["button"]"#,
            r#"static Widget.log["hello"]"#,
        ]
    );
}

#[test]
fn a_string_enum_crosses_the_protocol_as_its_string() {
    let rec = install();
    rec.reply("behavior", JsValue::from_str("smooth"));
    let w = widget(&rec);

    assert_eq!(w.behavior(), Some(Behavior::Smooth));
    w.set_behavior(Behavior::Auto);
    assert_eq!(rec.log(), ["get behavior", r#"set behavior = "auto""#]);
    assert_eq!(JsValue::from(Behavior::Auto), JsValue::from_str("auto"));

    rec.reply("behavior", JsValue::from_str("nope"));
    let err = std::panic::catch_unwind(AssertUnwindSafe(|| widget(&rec).behavior()))
        .expect_err("an unknown variant must panic");
    let msg = err.downcast_ref::<String>().expect("String payload");
    assert!(msg.contains("not a Behavior value: nope"), "{msg}");
}

#[test]
fn extends_gives_deref_and_asref_up_the_chain() {
    let rec = install();
    rec.reply("describe", JsValue::from_str("a widget"));
    let w = widget(&rec);

    // `Deref` to the first `extends`: a `Base` method on a `Widget`.
    assert_eq!(w.describe(), "a widget");
    let _: &Base = w.as_ref();
    // `instanceof` is the class chain, and `js_name` names the class.
    let v = AsRef::<JsValue>::as_ref(&w);
    assert!(<Widget as JsCast>::instanceof(v));
    assert!(<Base as JsCast>::instanceof(v));
    assert_eq!(rec.log(), ["invoke describe[]"]);
}

#[test]
fn a_module_backed_binding_panics_naming_the_module() {
    let err = std::panic::catch_unwind(|| helper(1)).expect_err("no JS module is loadable");
    let msg = err.downcast_ref::<&str>().expect("&str payload");
    assert!(msg.contains("/js/helpers.js"), "{msg}");
    assert!(msg.contains("helper"), "{msg}");
}

#[test]
fn non_extern_items_pass_through_with_the_attribute_stripped() {
    assert_eq!(Exported::make(4).field, 4);
}
