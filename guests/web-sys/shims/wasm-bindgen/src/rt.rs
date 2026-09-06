//! Runtime support for the fake `#[wasm_bindgen]` proc macro.
//!
//! The real `wasm-bindgen` generates, for each `extern "C"` function in a
//! `web_sys` binding, a call across the ABI boundary with `IntoWasmAbi` /
//! `FromWasmAbi` conversions on each side. Here there is no boundary: the
//! macro instead lowers arguments to [`JsValue`] with [`IntoJs`], performs
//! the call through the [`JsObject`](crate::JsObject) protocol, and lifts
//! the result back with [`FromJs`].
//!
//! Everything here is called by macro-generated code. It is `pub` because
//! the generated code lives in other crates, not because it is API.

use std::cell::RefCell;
use std::rc::Rc;

use crate::{JsObject, JsValue};

/// Re-exported for macro-generated code only. `web_sys` is `#![no_std]`,
/// so the bodies the macro emits cannot name `std`, and reaching for
/// `::alloc` would require every crate using the macro to have declared
/// `extern crate alloc`. An indexing binding's `index.to_string()` and a
/// string enum's `String` lift therefore go through these.
#[doc(hidden)]
pub use std::string::{String, ToString};

// ---------------------------------------------------------------------
// Lowering: Rust -> JsValue
// ---------------------------------------------------------------------

/// Lower a Rust argument to a [`JsValue`], as the generated bindings do
/// for every argument of an `extern "C"` function.
///
/// The conversions are total — lowering never fails and never panics:
///
/// | Rust                                           | `JsValue`            |
/// |------------------------------------------------|----------------------|
/// | every integer and float type                   | Number (`as f64`)    |
/// | `&str`, `String`, `&String`                    | String               |
/// | `bool`                                         | Bool                 |
/// | `Option<T>`: `None`                            | `undefined`          |
/// | `Option<T>`: `Some(v)`                         | `v.into_js()`        |
/// | `JsValue`, `&JsValue`, and wrapper types       | the value unchanged  |
///
/// Wrapper types (`&Element`, `&js_sys::Function`, ...) are
/// `#[repr(transparent)]` over a `JsValue`; their impls are emitted by
/// [`wrapper_type!`](crate::wrapper_type), which the proc macro uses for
/// every `extern` type it declares. Do not add a blanket
/// `impl<T: JsCast> IntoJs for T` — it would conflict with the primitive
/// impls below.
///
/// Note the lossiness that mirrors JS itself: `i64`/`u64`/`usize` become
/// f64 Numbers, so values above 2^53 lose precision. The real crate would
/// produce a `BigInt`; nothing in this graph passes such a value.
pub trait IntoJs {
    fn into_js(self) -> JsValue;
}

impl IntoJs for JsValue {
    fn into_js(self) -> JsValue {
        self
    }
}

impl IntoJs for &JsValue {
    fn into_js(self) -> JsValue {
        self.clone()
    }
}

impl IntoJs for bool {
    fn into_js(self) -> JsValue {
        JsValue::from_bool(self)
    }
}

impl IntoJs for &str {
    fn into_js(self) -> JsValue {
        JsValue::from_str(self)
    }
}

impl IntoJs for String {
    fn into_js(self) -> JsValue {
        JsValue::from_str(&self)
    }
}

impl IntoJs for &String {
    fn into_js(self) -> JsValue {
        JsValue::from_str(self)
    }
}

macro_rules! into_js_number {
    ($($t:ty),*) => {$(
        impl IntoJs for $t {
            fn into_js(self) -> JsValue {
                JsValue::from_f64(self as f64)
            }
        }
    )*};
}
into_js_number!(f32, f64, i8, i16, i32, i64, isize, u8, u16, u32, u64, usize);

/// `None` lowers to `undefined` (not `null`): that is what the real
/// bindings pass for an absent optional argument.
impl<T: IntoJs> IntoJs for Option<T> {
    fn into_js(self) -> JsValue {
        match self {
            Some(v) => v.into_js(),
            None => JsValue::UNDEFINED,
        }
    }
}

// ---------------------------------------------------------------------
// Lifting: JsValue -> Rust
// ---------------------------------------------------------------------

/// Lift a [`JsValue`] into the Rust return type a binding declares.
///
/// **Primitive lifts are strict.** A `String` return must be a String
/// `JsValue`, `bool` must be a Bool, every numeric type must be a Number;
/// anything else panics with a message naming the expected type and
/// showing the actual value. A fake DOM that quietly coerces (`undefined`
/// read as `""`, a String read as `0`) turns a missing dispatch entry into
/// a plausible wrong answer, which is the failure mode this whole shim
/// exists to avoid.
///
/// Integer targets additionally require the Number to be integral and
/// within the target's range; the value is then converted with `as`.
///
/// `Option<T>` treats **both** `undefined` and `null` as `None` — web-sys
/// declares `Option` returns for both "absent" idioms (`Node::parent_node`
/// returns `null`, an unset getter returns `undefined`) and the binding
/// does not distinguish them.
///
/// `()` accepts any value and discards it: a `-> ()` binding is a
/// statement, and the dispatch table is free to return whatever it likes.
///
/// Wrapper types lift **unchecked**: the value is wrapped without checking
/// its `class_chain`, exactly as the real generated bindings do (they
/// trust the IDL). A wrong class surfaces later at the first method call.
pub trait FromJs: Sized {
    fn from_js(v: JsValue) -> Self;
}

/// The panic every strict lift raises. One function so the wording is
/// identical everywhere; the message always contains `expected`.
fn mismatch(expected: &str, v: &JsValue) -> ! {
    panic!("wasm-bindgen fake: expected {expected}, got {v:?}");
}

impl FromJs for () {
    fn from_js(_v: JsValue) {}
}

impl FromJs for JsValue {
    fn from_js(v: JsValue) -> JsValue {
        v
    }
}

impl FromJs for bool {
    fn from_js(v: JsValue) -> bool {
        match v.as_bool() {
            Some(b) => b,
            None => mismatch("a bool", &v),
        }
    }
}

impl FromJs for String {
    fn from_js(v: JsValue) -> String {
        match v.as_string() {
            Some(s) => s,
            None => mismatch("a string", &v),
        }
    }
}

macro_rules! from_js_float {
    ($($t:ty),*) => {$(
        impl FromJs for $t {
            fn from_js(v: JsValue) -> $t {
                match v.as_f64() {
                    Some(n) => n as $t,
                    None => mismatch(concat!("a number (", stringify!($t), ")"), &v),
                }
            }
        }
    )*};
}
from_js_float!(f32, f64);

macro_rules! from_js_int {
    ($($t:ty),*) => {$(
        impl FromJs for $t {
            fn from_js(v: JsValue) -> $t {
                let Some(n) = v.as_f64() else {
                    mismatch(concat!("a number (", stringify!($t), ")"), &v);
                };
                if n.fract() != 0.0 || !(n >= <$t>::MIN as f64 && n <= <$t>::MAX as f64) {
                    panic!(
                        "wasm-bindgen fake: expected an integral number in {}'s range, got {n}",
                        stringify!($t),
                    );
                }
                n as $t
            }
        }
    )*};
}
from_js_int!(i8, i16, i32, i64, isize, u8, u16, u32, u64, usize);

/// `undefined` and `null` are both `None`; anything else is lifted by `T`
/// and so inherits `T`'s strictness.
impl<T: FromJs> FromJs for Option<T> {
    fn from_js(v: JsValue) -> Option<T> {
        if v.is_undefined() || v.is_null() {
            None
        } else {
            Some(T::from_js(v))
        }
    }
}

// ---------------------------------------------------------------------
// Exceptions
// ---------------------------------------------------------------------

/// What a call site that is **not** declared `catch` does with a thrown
/// value.
///
/// A binding declared `#[wasm_bindgen(catch)]` returns
/// `Result<T, JsValue>` and hands the `Err` to its caller. Every other
/// binding has nowhere to put it: real wasm-bindgen would let the
/// exception propagate into the JS caller and tear the instance down, so
/// the faithful analogue here is an abort.
pub fn uncaught(err: JsValue) -> ! {
    panic!("uncaught exception: {err}");
}

// ---------------------------------------------------------------------
// The global object
// ---------------------------------------------------------------------

thread_local! {
    static GLOBAL: RefCell<Option<JsValue>> = const { RefCell::new(None) };
}

/// Install the object that stands in for `globalThis`. The fake DOM calls
/// this once at init (native tests included); nothing works before it.
pub fn install_global(v: JsValue) {
    GLOBAL.with(|g| *g.borrow_mut() = Some(v));
}

/// `globalThis`. Panics if [`install_global`] has not run on this thread.
pub fn global() -> JsValue {
    GLOBAL.with(|g| {
        g.borrow()
            .clone()
            .expect("wasm-bindgen fake: no global object installed")
    })
}

/// `new <js_class>(...args)`.
///
/// Resolved as `globalThis[js_class]`, then that value is called. The
/// constructor is therefore an ordinary function object hanging off the
/// global; the fake DOM installs one only for the classes a framework
/// actually constructs (there is no `new` protocol distinct from a call —
/// the constructor function returns the new object).
pub fn construct(js_class: &str, args: &[JsValue]) -> Result<JsValue, JsValue> {
    let ctor = global().get_prop(js_class)?;
    ctor.call_with(&JsValue::UNDEFINED, args)
}

/// A static (namespaced) call: `globalThis.<ns...>.<method>(...args)`.
///
/// `namespace` is walked with `get`, so `call_static(&["console"], "log",
/// ..)` reads `globalThis.console` and invokes `log` on it. An empty
/// `namespace` invokes the method on the global itself.
pub fn call_static(namespace: &[&str], method: &str, args: &[JsValue]) -> Result<JsValue, JsValue> {
    let mut recv = global();
    for step in namespace {
        recv = recv.get_prop(step)?;
    }
    recv.invoke(method, args)
}

// ---------------------------------------------------------------------
// PlainObject
// ---------------------------------------------------------------------

/// A JS `{}`: what `js_sys::Object::new()` returns.
///
/// An insertion-ordered property bag with no prototype behaviour beyond
/// `class_chain = ["Object"]`. Reads of absent keys are `undefined`;
/// writes always succeed.
pub struct PlainObject {
    props: RefCell<Vec<(String, JsValue)>>,
}

impl PlainObject {
    /// A fresh `{}` as a [`JsValue`].
    #[allow(clippy::new_ret_no_self)]
    pub fn new() -> JsValue {
        JsValue::from_object(Rc::new(PlainObject {
            props: RefCell::new(Vec::new()),
        }))
    }
}

impl JsObject for PlainObject {
    fn class_chain(&self) -> &[&'static str] {
        &["Object"]
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn get(&self, key: &str) -> Result<JsValue, JsValue> {
        Ok(self
            .props
            .borrow()
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
            .unwrap_or(JsValue::UNDEFINED))
    }

    fn set(&self, key: &str, value: JsValue) -> Result<(), JsValue> {
        let mut props = self.props.borrow_mut();
        match props.iter_mut().find(|(k, _)| k == key) {
            Some(slot) => slot.1 = value,
            None => props.push((key.to_string(), value)),
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::JsCast;

    /// A callable object that reports what it was called with, standing
    /// in for the constructors and namespace methods the fake DOM will
    /// install on the global.
    struct Echo(&'static str);

    impl JsObject for Echo {
        fn class_chain(&self) -> &[&'static str] {
            &["Function", "Object"]
        }
        fn as_any(&self) -> &dyn std::any::Any {
            self
        }
        fn call(&self, _this: &JsValue, args: &[JsValue]) -> Result<JsValue, JsValue> {
            Ok(JsValue::from_str(&format!("{}({args:?})", self.0)))
        }
        fn invoke(&self, method: &str, args: &[JsValue]) -> Result<JsValue, JsValue> {
            Ok(JsValue::from_str(&format!("{}.{method}({args:?})", self.0)))
        }
    }

    fn echo(name: &'static str) -> JsValue {
        JsValue::from_object(Rc::new(Echo(name)))
    }

    #[test]
    fn from_js_is_strict_about_strings() {
        let panic = std::panic::catch_unwind(|| String::from_js(JsValue::from_f64(1.0)))
            .expect_err("a Number must not lift as a String");
        let msg = panic
            .downcast_ref::<String>()
            .expect("panic payload is a String");
        assert!(msg.contains("expected"), "{msg}");
        assert!(msg.contains("a string"), "{msg}");
        assert!(msg.contains('1'), "{msg}");
    }

    #[test]
    fn from_js_is_strict_about_bools_and_numbers() {
        assert!(std::panic::catch_unwind(|| bool::from_js(JsValue::from_f64(1.0))).is_err());
        assert!(std::panic::catch_unwind(|| f64::from_js(JsValue::from_str("1"))).is_err());
        assert!(std::panic::catch_unwind(|| u32::from_js(JsValue::UNDEFINED)).is_err());
        assert!(bool::from_js(JsValue::TRUE));
        assert_eq!(f64::from_js(JsValue::from_f64(1.5)), 1.5);
    }

    #[test]
    fn integer_lifts_reject_fractions_and_overflow() {
        assert_eq!(i32::from_js(JsValue::from_f64(-7.0)), -7);
        assert!(std::panic::catch_unwind(|| i32::from_js(JsValue::from_f64(1.5))).is_err());
        assert!(std::panic::catch_unwind(|| u8::from_js(JsValue::from_f64(256.0))).is_err());
        assert!(std::panic::catch_unwind(|| u8::from_js(JsValue::from_f64(-1.0))).is_err());
    }

    #[test]
    fn option_lifts_treat_null_and_undefined_alike() {
        assert_eq!(Option::<String>::from_js(JsValue::UNDEFINED), None);
        assert_eq!(Option::<String>::from_js(JsValue::NULL), None);
        assert_eq!(
            Option::<String>::from_js(JsValue::from_str("x")),
            Some("x".to_string())
        );
        // Strictness survives the Option wrapper.
        assert!(std::panic::catch_unwind(|| Option::<String>::from_js(JsValue::TRUE)).is_err());
        // And `None` lowers back to `undefined`, not `null`.
        assert!(None::<&str>.into_js().is_undefined());
    }

    #[test]
    fn unit_lift_accepts_anything() {
        FromJs::from_js(JsValue::from_str("ignored"))
    }

    #[test]
    fn plain_object_round_trips_through_get_and_set() {
        let obj = PlainObject::new();
        assert!(obj.get_prop("a").unwrap().is_undefined());
        obj.set_prop("a", JsValue::from_f64(1.0)).unwrap();
        obj.set_prop("b", JsValue::from_str("two")).unwrap();
        obj.set_prop("a", JsValue::from_f64(3.0)).unwrap();
        assert_eq!(obj.get_prop("a").unwrap(), JsValue::from_f64(3.0));
        assert_eq!(obj.get_prop("b").unwrap(), JsValue::from_str("two"));
        assert!(obj.is_object() && !obj.is_function());
    }

    #[test]
    fn global_must_be_installed() {
        let err = std::panic::catch_unwind(global).expect_err("global() before install_global");
        let msg = err.downcast_ref::<String>().expect("String payload");
        assert!(msg.contains("no global object installed"), "{msg}");
    }

    #[test]
    fn construct_and_call_static_walk_the_global() {
        let g = PlainObject::new();
        g.set_prop("Widget", echo("Widget")).unwrap();
        g.set_prop("console", echo("console")).unwrap();
        install_global(g);

        assert_eq!(
            construct("Widget", &[JsValue::from_f64(1.0)]).unwrap(),
            JsValue::from_str("Widget([1])")
        );
        assert_eq!(
            call_static(&[], "toString", &[]).unwrap_err(),
            JsValue::from_str("TypeError: Object.toString is not a function")
        );
        assert_eq!(
            call_static(&["console"], "log", &[JsValue::from_str("hi")]).unwrap(),
            JsValue::from_str("console.log([\"hi\"])")
        );
        // A missing constructor is `undefined`, which is not callable.
        assert_eq!(
            construct("Nope", &[]).unwrap_err(),
            JsValue::from_str("TypeError: not a function")
        );
    }

    #[test]
    fn uncaught_panics_with_the_thrown_value() {
        let err = std::panic::catch_unwind(|| uncaught(JsValue::from_str("boom")))
            .expect_err("uncaught must panic");
        let msg = err.downcast_ref::<String>().expect("String payload");
        assert_eq!(msg, "uncaught exception: boom");
    }

    #[test]
    fn wrapper_types_lower_and_lift_unchecked() {
        let obj = PlainObject::new();
        let f = js_fn_wrapper(obj.clone());
        assert_eq!((&f).into_js(), obj);
        assert_eq!(f.into_js(), obj);
    }

    /// Uses the `wrapper_type!`-generated impls through `js-sys`-shaped
    /// code without depending on `js-sys` (which depends on this crate).
    fn js_fn_wrapper(v: JsValue) -> Wrapped {
        Wrapped::unchecked_from_js(v)
    }

    crate::wrapper_type!(pub Wrapped, "Object");
}
