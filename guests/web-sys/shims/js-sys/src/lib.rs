//! A fake `js-sys`: exactly the JS builtins dominator, gloo-events and the
//! todomvc port name, and nothing else.
//!
//! Every method that cannot be honoured panics with a message naming the
//! type and method. Silently returning `undefined` for something a
//! framework depends on is the failure mode this shim exists to avoid.

use std::fmt;

use wasm_bindgen::{wrapper_type, JsValue};

/// Disambiguate `AsRef`: every wrapper type has several.
fn js<T: AsRef<JsValue>>(v: &T) -> &JsValue {
    v.as_ref()
}

wrapper_type!(pub Object, "Object");

impl Object {
    /// `{}` — a fresh empty property bag.
    pub fn new() -> Object {
        Object::from(wasm_bindgen::__rt::PlainObject::new())
    }
}

impl Default for Object {
    fn default() -> Object {
        Object::new()
    }
}

wrapper_type!(pub Function, "Function", extends: Object);

/// `globalThis`. The seam `web_sys::window()` goes through
/// (`web-sys-0.3.105/src/lib.rs:38`), and so the entry point to the whole
/// fake DOM: whatever object was passed to
/// `wasm_bindgen::__rt::install_global` is what `Window` is cast from.
pub fn global() -> Object {
    Object::from(wasm_bindgen::__rt::global())
}

// Named only in `web_sys` signatures the enabled features happen to
// declare -- `Element::get_animations`, `Window::fetch_with_str`,
// `Node::get_root_node`, `Document::last_modified` and friends. None of
// them is called by dominator, gloo-events or the todomvc port, so these
// carry no methods: the types have to exist for `web_sys` to compile, and
// nothing more.
wrapper_type!(pub Array, "Array", extends: Object);
wrapper_type!(pub Date, "Date", extends: Object);
wrapper_type!(pub Iterator, "Iterator", extends: Object);
wrapper_type!(pub Promise, "Promise", extends: Object);

wrapper_type!(pub JsString, "String", extends: Object);

impl fmt::Display for JsString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match js(self).as_string() {
            Some(s) => f.write_str(&s),
            None => write!(f, "{:?}", js(self)),
        }
    }
}

wrapper_type!(pub Error, "Error", extends: Object);

impl Error {
    /// The real one reads the `message` property. Errors produced by this
    /// shim are plain strings, so fall back to the value itself.
    pub fn message(&self) -> JsString {
        let v = js(self);
        let m = v.get_prop("message").unwrap_or(JsValue::UNDEFINED);
        JsString::from(if m.is_undefined() { v.clone() } else { m })
    }
}

/// `Reflect`, routed straight to the object protocol
/// (`wasm_bindgen::JsObject`).
///
/// This is the seam dominator uses to write DOM properties:
/// `bindings::set_property` is `Reflect::set`
/// (dominator-0.5.38/src/bindings.rs:12), so `.prop("checked", true)` on a
/// fake DOM node lands in [`Reflect::set`] and from there in the node's
/// property store and a `SetProperty` frame.
pub struct Reflect;

impl Reflect {
    pub fn set(target: &JsValue, key: &JsValue, value: &JsValue) -> Result<bool, JsValue> {
        target.set_prop(&key_str(key), value.clone())?;
        Ok(true)
    }
}

/// JS property keys are strings (symbols excluded, none appear here).
fn key_str(key: &JsValue) -> String {
    key.as_string()
        .unwrap_or_else(|| panic!("js-sys fake: Reflect key must be a string, got {key:?}"))
}
