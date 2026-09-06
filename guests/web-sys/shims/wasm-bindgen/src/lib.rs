//! A fake `wasm-bindgen`: `JsValue` as a real Rust value.
//!
//! This crate replaces the real `wasm-bindgen` through the workspace
//! `[patch.crates-io]` so that a framework written against `web_sys`
//! (here: Dominator 0.5.38) compiles and runs inside a wasm *component*,
//! which has no JS engine and no `wasm-bindgen` glue. See
//! `../../Cargo.toml` and docs/design.md "Producer seams" ->
//! "Wasm-native producers".
//!
//! # What a `JsValue` is here
//!
//! A tagged Rust enum. Objects are `Rc<dyn JsObject>`, and the object
//! protocol is deliberately tiny: `class_chain`, `get`, `set`, `invoke`,
//! `call`. There are no prototype chains beyond `class_chain`, no
//! property descriptors and no coercion tables. This is a shim, not a JS
//! engine.
//!
//! # How bindings reach it
//!
//! The real `web_sys` crate is compiled against a fake `#[wasm_bindgen]`
//! proc macro that rewrites its `extern "C"` blocks into calls on this
//! protocol, with argument lowering and return lifting from
//! [`__rt::IntoJs`] / [`__rt::FromJs`]. [`JsObject`]'s doc comment is the
//! contract between that macro and the fake DOM that implements the
//! objects.
//!
//! Anything a framework reaches that cannot be honoured **panics with a
//! named message** rather than quietly returning `undefined`: a silent
//! wrong answer in a fake DOM is the failure mode that costs days.

use std::any::Any;
use std::fmt;
use std::rc::Rc;

#[path = "rt.rs"]
#[doc(hidden)]
pub mod __rt;
pub mod closure;

pub use closure::Closure;
/// The fake `#[wasm_bindgen]` proc macro. See `../../wasm-bindgen-macro`.
pub use wasm_bindgen_macro::wasm_bindgen;

/// The object protocol. Everything an object can do in this shim.
///
/// Implementors: the fake DOM's nodes (`stream-dom-fakedom`), event
/// objects, [`__rt::PlainObject`], and the function objects a [`Closure`]
/// lowers to.
///
/// # What the proc macro emits
///
/// Each `web_sys` binding attribute maps to exactly one protocol call on
/// the receiver, with the `js_name` (defaulting to the Rust identifier
/// verbatim, as the real macro does -- there is no case conversion; see
/// `wasm-bindgen-macro/src/externs.rs::op`) as the key:
///
/// | binding attribute                     | protocol call                |
/// |---------------------------------------|------------------------------|
/// | `method, getter, js_name = X`         | `get("X")`                   |
/// | `method, setter, js_name = X`         | `set("X", v)`                |
/// | `method, js_name = X`                 | `invoke("X", args)`          |
/// | `method, indexing_getter`             | `get(&index.to_string())`    |
/// | `method, indexing_setter`             | `set(&index.to_string(), v)` |
/// | `constructor`                         | [`__rt::construct`]          |
/// | `static_method_of` / `js_namespace`   | [`__rt::call_static`]        |
///
/// Arguments arrive lowered by [`__rt::IntoJs`] and results are lifted by
/// [`__rt::FromJs`]; read both, they define what an implementor may
/// return. In short: every numeric type is a Number, strings are Strings,
/// `None` is `undefined`, wrapper types pass through unchanged; and a
/// primitive return is checked strictly, so returning `undefined` where
/// the binding declares `String` is a panic, not an empty string.
///
/// # Exceptions
///
/// `Err` is a thrown exception. A call site declared
/// `#[wasm_bindgen(catch)]` in web-sys surfaces it as
/// `Result<_, JsValue>`; every other call site hands it to
/// [`__rt::uncaught`], which panics. So an implementor should return `Err`
/// only where a real DOM would genuinely throw — "I do not implement
/// this" is also an `Err`, deliberately, because the defaults below make
/// unimplemented members loud.
pub trait JsObject: Any {
    /// The class and every class it inherits from, most derived first,
    /// e.g. `["HTMLInputElement", "HTMLElement", "Element", "Node",
    /// "EventTarget", "Object"]`. This is the whole of `instanceof`:
    /// [`JsCast::instanceof`] asks whether the type's class name appears
    /// here.
    fn class_chain(&self) -> &[&'static str];

    /// For downcasting back to the concrete Rust type via
    /// [`JsValue::downcast_ref`]. Implementors write `self`.
    fn as_any(&self) -> &dyn Any;

    /// Property read: a `getter` binding, an `indexing_getter`, or
    /// `Reflect.get`. `Err` is a thrown exception.
    ///
    /// The default reads `undefined` for every key, matching JS: an
    /// absent property is not an error. A getter whose value the fake DOM
    /// does not model therefore reaches the caller as `undefined`, which
    /// the strict [`__rt::FromJs`] lift turns into a panic naming the key
    /// at the point of use.
    fn get(&self, _key: &str) -> Result<JsValue, JsValue> {
        Ok(JsValue::UNDEFINED)
    }

    /// Property write: a `setter` binding, an `indexing_setter`, or
    /// `Reflect.set`. `Err` is a thrown exception.
    ///
    /// The default refuses, because a dropped write is silent damage: an
    /// object that accepts arbitrary properties opts in by overriding.
    fn set(&self, key: &str, _value: JsValue) -> Result<(), JsValue> {
        Err(JsValue::from_str(&format!(
            "TypeError: cannot set property '{}' of [object {}]",
            key,
            self.class_chain().first().unwrap_or(&"Object"),
        )))
    }

    /// Method call: `obj.method(...args)`. `Err` is a thrown exception.
    ///
    /// The default is the `TypeError` a JS engine raises for a missing
    /// method, which for a non-`catch` call site becomes a panic naming
    /// the class and method — the intended signal for "the dispatch table
    /// is missing an entry".
    fn invoke(&self, method: &str, _args: &[JsValue]) -> Result<JsValue, JsValue> {
        Err(JsValue::from_str(&format!(
            "TypeError: {}.{} is not a function",
            self.class_chain().first().unwrap_or(&"Object"),
            method,
        )))
    }

    /// Call THIS object as a function: `f.call(this, ...args)`. Only
    /// function objects — what a [`Closure`] lowers to, and the
    /// constructors [`__rt::construct`] looks up on the global —
    /// implement it; everything else reports the `TypeError` a JS engine
    /// would throw.
    fn call(&self, _this: &JsValue, _args: &[JsValue]) -> Result<JsValue, JsValue> {
        Err(JsValue::from_str("TypeError: not a function"))
    }
}

#[derive(Clone)]
enum Inner {
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    String(Rc<str>),
    Object(Rc<dyn JsObject>),
}

/// A JavaScript value, as a plain Rust value.
#[derive(Clone)]
#[repr(transparent)]
pub struct JsValue(Inner);

impl JsValue {
    pub const UNDEFINED: JsValue = JsValue(Inner::Undefined);
    pub const NULL: JsValue = JsValue(Inner::Null);
    pub const TRUE: JsValue = JsValue(Inner::Bool(true));
    pub const FALSE: JsValue = JsValue(Inner::Bool(false));

    // The real crate's name; changing it would break every caller.
    #[allow(clippy::should_implement_trait)]
    pub fn from_str(s: &str) -> JsValue {
        JsValue(Inner::String(s.into()))
    }

    pub fn from_f64(n: f64) -> JsValue {
        JsValue(Inner::Number(n))
    }

    pub fn from_bool(b: bool) -> JsValue {
        JsValue(Inner::Bool(b))
    }

    /// Wrap an object. The `Rc<T> -> Rc<dyn JsObject>` unsizing coercion
    /// keeps the same allocation, so a `Weak<T>` taken before the wrap
    /// stays live for as long as this `JsValue` does — which is how the
    /// fake DOM gets from a `&NodeData` back to its `Rc<NodeData>`.
    pub fn from_object(obj: Rc<dyn JsObject>) -> JsValue {
        JsValue(Inner::Object(obj))
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self.0 {
            Inner::Number(n) => Some(n),
            _ => None,
        }
    }

    pub fn as_string(&self) -> Option<String> {
        match &self.0 {
            Inner::String(s) => Some(s.to_string()),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self.0 {
            Inner::Bool(b) => Some(b),
            _ => None,
        }
    }

    pub fn is_undefined(&self) -> bool {
        matches!(self.0, Inner::Undefined)
    }

    pub fn is_null(&self) -> bool {
        matches!(self.0, Inner::Null)
    }

    pub fn is_object(&self) -> bool {
        matches!(self.0, Inner::Object(_))
    }

    pub fn is_string(&self) -> bool {
        matches!(self.0, Inner::String(_))
    }

    /// An object whose `class_chain` names `"Function"` — the shim's
    /// whole notion of callability.
    pub fn is_function(&self) -> bool {
        match &self.0 {
            Inner::Object(o) => o.class_chain().contains(&"Function"),
            _ => false,
        }
    }

    #[doc(hidden)]
    pub fn class_chain(&self) -> Option<&[&'static str]> {
        match &self.0 {
            Inner::Object(o) => Some(o.class_chain()),
            _ => None,
        }
    }

    /// Downcast to the concrete Rust type behind an object. The seam the
    /// other shims (`js-sys`, `web-sys`) use to reach the fake DOM's
    /// nodes; not part of the real `wasm-bindgen` API.
    #[doc(hidden)]
    pub fn downcast_ref<T: JsObject + 'static>(&self) -> Option<&T> {
        match &self.0 {
            Inner::Object(o) => o.as_any().downcast_ref::<T>(),
            _ => None,
        }
    }

    /// `Reflect.get` / `Reflect.set` / a method call /
    /// `Function.prototype.call`, routed to [`JsObject`].
    ///
    /// Non-objects behave as JS does for property reads (`undefined`) and
    /// refuse everything else with a `TypeError`. `Err` is a thrown
    /// exception throughout.
    #[doc(hidden)]
    pub fn get_prop(&self, key: &str) -> Result<JsValue, JsValue> {
        match &self.0 {
            Inner::Object(o) => o.get(key),
            _ => Ok(JsValue::UNDEFINED),
        }
    }

    #[doc(hidden)]
    pub fn set_prop(&self, key: &str, value: JsValue) -> Result<(), JsValue> {
        match &self.0 {
            Inner::Object(o) => o.set(key, value),
            _ => Err(JsValue::from_str(&format!(
                "TypeError: cannot set property '{key}' of {self:?}"
            ))),
        }
    }

    #[doc(hidden)]
    pub fn invoke(&self, method: &str, args: &[JsValue]) -> Result<JsValue, JsValue> {
        match &self.0 {
            Inner::Object(o) => o.invoke(method, args),
            _ => Err(JsValue::from_str(&format!(
                "TypeError: not an object, cannot call '{method}' on {self:?}"
            ))),
        }
    }

    #[doc(hidden)]
    pub fn call_with(&self, this: &JsValue, args: &[JsValue]) -> Result<JsValue, JsValue> {
        match &self.0 {
            Inner::Object(o) => o.call(this, args),
            _ => Err(JsValue::from_str("TypeError: not a function")),
        }
    }
}

impl Default for JsValue {
    fn default() -> Self {
        JsValue::UNDEFINED
    }
}

impl AsRef<JsValue> for JsValue {
    fn as_ref(&self) -> &JsValue {
        self
    }
}

impl From<&str> for JsValue {
    fn from(s: &str) -> JsValue {
        JsValue::from_str(s)
    }
}

impl From<String> for JsValue {
    fn from(s: String) -> JsValue {
        JsValue::from_str(&s)
    }
}

impl From<&String> for JsValue {
    fn from(s: &String) -> JsValue {
        JsValue::from_str(s)
    }
}

impl From<bool> for JsValue {
    fn from(b: bool) -> JsValue {
        JsValue::from_bool(b)
    }
}

macro_rules! number_from {
    ($($t:ty),*) => {$(
        impl From<$t> for JsValue {
            fn from(n: $t) -> JsValue {
                JsValue::from_f64(n as f64)
            }
        }
    )*};
}
number_from!(f32, f64, i8, i16, i32, i64, isize, u8, u16, u32, u64, usize);

impl<T> From<Option<T>> for JsValue
where
    JsValue: From<T>,
{
    fn from(v: Option<T>) -> JsValue {
        match v {
            Some(v) => JsValue::from(v),
            None => JsValue::UNDEFINED,
        }
    }
}

/// Object identity is `Rc` pointer identity — which is exactly what DOM
/// node identity is in the fake DOM.
impl PartialEq for JsValue {
    fn eq(&self, other: &JsValue) -> bool {
        match (&self.0, &other.0) {
            (Inner::Undefined, Inner::Undefined) => true,
            (Inner::Null, Inner::Null) => true,
            (Inner::Bool(a), Inner::Bool(b)) => a == b,
            (Inner::Number(a), Inner::Number(b)) => a == b,
            (Inner::String(a), Inner::String(b)) => a == b,
            (Inner::Object(a), Inner::Object(b)) => Rc::ptr_eq(a, b),
            _ => false,
        }
    }
}

/// `web_sys` derives `Eq` on every extern type (see
/// `web-sys-0.3.105/src/features/gen_Element.rs`), so `JsValue` must be
/// `Eq` for the generated bindings to compile. It is not truly
/// reflexive — `NaN != NaN`, since Numbers compare with `f64::eq` — which
/// is the same unsoundness the real crate ships with, for the same
/// reason.
impl Eq for JsValue {}

impl fmt::Debug for JsValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.0 {
            Inner::Undefined => f.write_str("undefined"),
            Inner::Null => f.write_str("null"),
            Inner::Bool(b) => write!(f, "{b}"),
            Inner::Number(n) => write!(f, "{n}"),
            Inner::String(s) => write!(f, "{s:?}"),
            Inner::Object(o) => write!(f, "[object {}]", o.class_chain().first().unwrap_or(&"?")),
        }
    }
}

impl fmt::Display for JsValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.0 {
            Inner::String(s) => f.write_str(s),
            _ => fmt::Debug::fmt(self, f),
        }
    }
}

/// Checked and unchecked casting between JS wrapper types. Mirrors the
/// real trait (wasm-bindgen-0.2.128/src/cast.rs:19) method for method, so
/// framework code that calls `dyn_into` / `dyn_ref` / `unchecked_into` /
/// `unchecked_ref` compiles unchanged.
///
/// `unchecked_ref` is a pointer cast, as in the real crate: every wrapper
/// type is `#[repr(transparent)]` around a `JsValue`.
pub trait JsCast
where
    Self: AsRef<JsValue> + Into<JsValue>,
{
    fn has_type<T>(&self) -> bool
    where
        T: JsCast,
    {
        T::is_type_of(self.as_ref())
    }

    fn dyn_into<T>(self) -> Result<T, Self>
    where
        T: JsCast,
        Self: Sized,
    {
        if self.has_type::<T>() {
            Ok(self.unchecked_into())
        } else {
            Err(self)
        }
    }

    fn dyn_ref<T>(&self) -> Option<&T>
    where
        T: JsCast,
    {
        if self.has_type::<T>() {
            Some(self.unchecked_ref())
        } else {
            None
        }
    }

    fn unchecked_into<T>(self) -> T
    where
        T: JsCast,
        Self: Sized,
    {
        T::unchecked_from_js(self.into())
    }

    fn unchecked_ref<T>(&self) -> &T
    where
        T: JsCast,
    {
        T::unchecked_from_js_ref(self.as_ref())
    }

    fn instanceof(val: &JsValue) -> bool;

    fn is_type_of(val: &JsValue) -> bool {
        Self::instanceof(val)
    }

    fn unchecked_from_js(val: JsValue) -> Self;

    fn unchecked_from_js_ref(val: &JsValue) -> &Self;
}

impl JsCast for JsValue {
    fn instanceof(_val: &JsValue) -> bool {
        true
    }

    fn unchecked_from_js(val: JsValue) -> Self {
        val
    }

    fn unchecked_from_js_ref(val: &JsValue) -> &Self {
        val
    }
}

/// Declare a JS wrapper type: `#[repr(transparent)]` around a `JsValue`,
/// `instanceof` by class name, `Deref`/`AsRef` up the inheritance chain.
///
/// ```ignore
/// wrapper_type!(HtmlInputElement, "HTMLInputElement",
///               extends: HtmlElement, Element, Node, EventTarget, js_sys::Object);
/// ```
///
/// Emits exactly the impls the real generated bindings carry for the
/// subset used here: `JsCast`, `AsRef<JsValue>`, `AsRef<Self>`,
/// `AsRef<Ancestor>` for every ancestor, `From<Self> for JsValue`,
/// `From<JsValue> for Self` (unchecked, as web-sys generates),
/// `From<Self> for Ancestor`, `Deref` to the immediate parent (or to
/// `JsValue` for a root type), `__rt::IntoJs` for `Self` and `&Self`,
/// `__rt::FromJs` for `Self` (unchecked), plus
/// `Clone`/`Debug`/`PartialEq`/`Eq`.
///
/// The proc macro emits one invocation of this per `extern` type, so any
/// impl every wrapper type needs belongs here rather than in the macro.
/// It passes the declaration's visibility and its surviving attributes
/// (`#[doc]`, `#[cfg]`, `#[deprecated]`) straight through -- but not its
/// `#[derive]`, since the derives above are already exactly the set
/// web-sys asks for.
#[doc(hidden)]
#[macro_export]
macro_rules! wrapper_type {
    // A type with no JS parent: derefs straight to `JsValue`, as
    // `js_sys::Object` does in the real crate.
    ($(#[$attr:meta])* $vis:vis $name:ident, $class:literal $(,)?) => {
        $crate::wrapper_type!(@common $(#[$attr])* $vis $name, $class);

        impl ::core::ops::Deref for $name {
            type Target = $crate::JsValue;
            fn deref(&self) -> &$crate::JsValue {
                &self.obj
            }
        }
    };

    ($(#[$attr:meta])* $vis:vis $name:ident, $class:literal, extends: $parent:ty $(, $ancestor:ty)* $(,)?) => {
        $crate::wrapper_type!(@common $(#[$attr])* $vis $name, $class);

        impl ::core::ops::Deref for $name {
            type Target = $parent;
            fn deref(&self) -> &$parent {
                <$parent as $crate::JsCast>::unchecked_from_js_ref(&self.obj)
            }
        }

        $crate::wrapper_type!(@up $name, $parent $(, $ancestor)*);
    };

    (@up $name:ident $(, $ancestor:ty)*) => {$(
        impl AsRef<$ancestor> for $name {
            fn as_ref(&self) -> &$ancestor {
                <$ancestor as $crate::JsCast>::unchecked_from_js_ref(&self.obj)
            }
        }

        impl From<$name> for $ancestor {
            fn from(v: $name) -> $ancestor {
                <$ancestor as $crate::JsCast>::unchecked_from_js(v.obj)
            }
        }
    )*};

    (@common $(#[$attr:meta])* $vis:vis $name:ident, $class:literal) => {
        $(#[$attr])*
        #[derive(Clone, PartialEq, Eq)]
        #[repr(transparent)]
        $vis struct $name {
            obj: $crate::JsValue,
        }

        /// Lowering is the identity: the wrapper *is* the `JsValue`.
        impl $crate::__rt::IntoJs for $name {
            fn into_js(self) -> $crate::JsValue {
                self.obj
            }
        }

        impl $crate::__rt::IntoJs for &$name {
            fn into_js(self) -> $crate::JsValue {
                self.obj.clone()
            }
        }

        /// Unchecked lift, as the real generated bindings do: the
        /// `class_chain` is not consulted.
        impl $crate::__rt::FromJs for $name {
            fn from_js(v: $crate::JsValue) -> $name {
                $name { obj: v }
            }
        }

        impl $name {
            /// The `class_chain` entry `instanceof` looks for.
            #[doc(hidden)]
            pub const CLASS: &'static str = $class;
        }

        impl $crate::JsCast for $name {
            fn instanceof(val: &$crate::JsValue) -> bool {
                val.class_chain()
                    .is_some_and(|chain| chain.contains(&$class))
            }

            fn unchecked_from_js(val: $crate::JsValue) -> Self {
                $name { obj: val }
            }

            fn unchecked_from_js_ref(val: &$crate::JsValue) -> &Self {
                // Sound: `#[repr(transparent)]` over `JsValue`. Same
                // trick, same reason, as the real crate.
                unsafe { &*(val as *const $crate::JsValue as *const $name) }
            }
        }

        impl AsRef<$crate::JsValue> for $name {
            fn as_ref(&self) -> &$crate::JsValue {
                &self.obj
            }
        }

        /// Reflexive, so a generic bound like dominator's
        /// `DomBuilder<A> where A: AsRef<Node>` accepts `Node` itself.
        impl AsRef<$name> for $name {
            fn as_ref(&self) -> &$name {
                self
            }
        }

        impl From<$name> for $crate::JsValue {
            fn from(v: $name) -> $crate::JsValue {
                v.obj
            }
        }

        impl From<$crate::JsValue> for $name {
            fn from(obj: $crate::JsValue) -> $name {
                $name { obj }
            }
        }

        impl ::core::fmt::Debug for $name {
            fn fmt(&self, f: &mut ::core::fmt::Formatter<'_>) -> ::core::fmt::Result {
                ::core::fmt::Debug::fmt(&self.obj, f)
            }
        }
    };
}

/// `Option`/`Result` unwrapping that panics rather than unwinding into JS.
/// Here it is a plain panic; a component has no JS to throw into.
pub trait UnwrapThrowExt<T>: Sized {
    fn unwrap_throw(self) -> T {
        self.expect_throw("`unwrap_throw` failed")
    }

    fn expect_throw(self, message: &str) -> T;
}

impl<T> UnwrapThrowExt<T> for Option<T> {
    fn expect_throw(self, message: &str) -> T {
        match self {
            Some(v) => v,
            None => panic!("{message}"),
        }
    }
}

impl<T, E: fmt::Debug> UnwrapThrowExt<T> for Result<T, E> {
    fn expect_throw(self, message: &str) -> T {
        match self {
            Ok(v) => v,
            Err(e) => panic!("{message}: {e:?}"),
        }
    }
}

/// Interning is a no-op: the real one caches a JS string per Rust `&str`
/// to avoid re-encoding it across the wasm/JS boundary, and there is no
/// such boundary here. The protocol's own interning (`Intern` frames,
/// `stream_dom_guest::Interner`) is a different mechanism and is where
/// string deduplication actually happens for this producer.
#[inline]
pub fn intern(s: &str) -> &str {
    s
}

/// A JS `throw` of a value. A component cannot throw, so this panics.
pub fn throw_val(v: JsValue) -> ! {
    panic!("{v:?}");
}

pub mod prelude {
    //! What `use wasm_bindgen::prelude::*;` brings in.
    pub use crate::closure::Closure;
    pub use crate::{JsCast, JsValue, UnwrapThrowExt};
    pub use wasm_bindgen_macro::wasm_bindgen;
}
