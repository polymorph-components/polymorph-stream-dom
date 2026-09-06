//! [`Closure`]: a Rust closure exposed as a callable `JsValue`.
//!
//! Semantics copied from the real crate: the function object stays valid
//! only while the `Closure` handle is alive. Dropping the handle
//! invalidates it, and calling it afterwards throws — here, returns the
//! `TypeError` a JS engine would throw. `forget` leaks the handle so the
//! function outlives it, which is exactly how `gloo_events::EventListener`
//! keeps a listener alive past its own `Drop`
//! (gloo-events-0.1.2/src/lib.rs:538).

use std::any::Any;
use std::cell::{Cell, RefCell};
use std::fmt;
use std::rc::Rc;

use crate::{JsCast, JsObject, JsValue};

/// The boxed closure, shared between the [`Closure`] handle and the
/// function object it lowered to.
#[doc(hidden)]
pub struct Slot<F: ?Sized> {
    f: RefCell<Option<Box<F>>>,
    /// Set when the handle is dropped. Distinguishes "dropped" from
    /// "temporarily taken for the duration of a call", so a call that
    /// re-enters, or a handle dropped from inside its own callback, does
    /// not resurrect a dead closure.
    dropped: Cell<bool>,
}

/// How a boxed closure of a particular shape is invoked from a `&[JsValue]`
/// argument list. Implemented for exactly the closure shapes this graph
/// uses; a shape with no impl is a compile error, not a runtime surprise.
pub trait WasmClosure: 'static {
    #[doc(hidden)]
    fn into_js_function(slot: Rc<Slot<Self>>) -> JsValue;
}

struct FnObject<F: ?Sized + 'static> {
    slot: Rc<Slot<F>>,
    invoke: fn(&mut F, &[JsValue]) -> JsValue,
}

impl<F: ?Sized + 'static> JsObject for FnObject<F> {
    fn class_chain(&self) -> &[&'static str] {
        &["Function", "Object"]
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn call(&self, _this: &JsValue, args: &[JsValue]) -> Result<JsValue, JsValue> {
        if self.slot.dropped.get() {
            return Err(JsValue::from_str("TypeError: closure has been dropped"));
        }
        // Take the box for the duration of the call so no `RefCell` borrow
        // is held across user code: a DOM handler that adds or drops
        // listeners re-enters this shim, and a live borrow would turn that
        // into a borrow panic.
        let Some(mut f) = self.slot.f.borrow_mut().take() else {
            return Err(JsValue::from_str(
                "TypeError: closure is already executing (re-entrant call)",
            ));
        };
        let out = (self.invoke)(&mut f, args);
        if !self.slot.dropped.get() {
            *self.slot.f.borrow_mut() = Some(f);
        }
        Ok(out)
    }
}

fn lower<F: ?Sized + 'static>(
    slot: Rc<Slot<F>>,
    invoke: fn(&mut F, &[JsValue]) -> JsValue,
) -> JsValue {
    JsValue::from_object(Rc::new(FnObject { slot, invoke }))
}

/// `dyn FnMut(&A)` for any wrapper type `A` — the shape
/// `gloo_events::EventListener` uses (`Closure<dyn FnMut(&Event)>`).
///
/// The argument is produced by `JsCast::unchecked_from_js_ref`, a pointer
/// cast through `#[repr(transparent)]`, so no allocation and no clone.
impl<A: JsCast + 'static> WasmClosure for dyn FnMut(&A) {
    fn into_js_function(slot: Rc<Slot<Self>>) -> JsValue {
        lower(slot, |f, args| {
            let arg = args.first().cloned().unwrap_or(JsValue::UNDEFINED);
            f(A::unchecked_from_js_ref(&arg));
            JsValue::UNDEFINED
        })
    }
}

/// `dyn FnMut(f64)` — dominator's `requestAnimationFrame` callback
/// (dominator-0.5.38/src/animation.rs:47).
impl WasmClosure for dyn FnMut(f64) {
    fn into_js_function(slot: Rc<Slot<Self>>) -> JsValue {
        lower(slot, |f, args| {
            let n = args
                .first()
                .and_then(JsValue::as_f64)
                .expect("wasm-bindgen fake: FnMut(f64) closure called without a number argument");
            f(n);
            JsValue::UNDEFINED
        })
    }
}

/// A Rust closure reachable from JS as a function value.
pub struct Closure<T: ?Sized + 'static> {
    js: JsValue,
    slot: Rc<Slot<T>>,
}

impl<T: ?Sized + WasmClosure> Closure<T> {
    /// Wrap an already-boxed closure.
    pub fn wrap(data: Box<T>) -> Closure<T> {
        let slot = Rc::new(Slot {
            f: RefCell::new(Some(data)),
            dropped: Cell::new(false),
        });
        let js = T::into_js_function(slot.clone());
        Closure { js, slot }
    }

    /// Keep the function alive forever, consuming the handle without
    /// invalidating it.
    pub fn forget(self) {
        // Leaks the slot on purpose: that is what "forget" means here, and
        // it is what keeps a `gloo_events` listener alive after its
        // `EventListener` is dropped.
        std::mem::forget(self);
    }

    /// Take the function value, keeping it alive (same leak as
    /// [`Closure::forget`]).
    pub fn into_js_value(self) -> JsValue {
        let js = self.js.clone();
        std::mem::forget(self);
        js
    }
}

/// A `FnOnce` adapted to a `FnMut` closure shape, mirroring the real
/// crate's `WasmClosureFnOnce` (wasm-bindgen-0.2.128/src/closure.rs:713).
pub trait WasmClosureFnOnce<FnMut: ?Sized, A, R>: 'static {
    #[doc(hidden)]
    fn into_fn_mut(self) -> Box<FnMut>;
}

impl<T, A, R> WasmClosureFnOnce<dyn FnMut(&A), (A,), R> for T
where
    T: 'static + FnOnce(&A) -> R,
    A: 'static,
    R: 'static,
{
    fn into_fn_mut(self) -> Box<dyn FnMut(&A)> {
        let mut once = Some(self);
        Box::new(move |arg| {
            let f = once
                .take()
                .expect("wasm-bindgen fake: `Closure::once` callback called twice");
            f(arg);
        })
    }
}

impl<T: ?Sized + WasmClosure> Closure<T> {
    /// Wrap a `FnOnce`. Calling the result more than once panics, matching
    /// the real crate's "this function has already been called" throw.
    pub fn once<F, A, R>(fn_once: F) -> Closure<T>
    where
        F: WasmClosureFnOnce<T, A, R>,
    {
        Closure::wrap(fn_once.into_fn_mut())
    }
}

impl<T: ?Sized> AsRef<JsValue> for Closure<T> {
    fn as_ref(&self) -> &JsValue {
        &self.js
    }
}

impl<T: ?Sized> Drop for Closure<T> {
    fn drop(&mut self) {
        self.slot.dropped.set(true);
        let _ = self.slot.f.borrow_mut().take();
    }
}

impl<T: ?Sized> fmt::Debug for Closure<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Closure { .. }")
    }
}
