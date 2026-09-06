//! `stream-dom-fakedom` — a recording fake DOM that is a
//! `polymorph:stream-dom` producer.
//!
//! This crate is the substance of the "recording fake `web_sys` layer"
//! producer strategy (docs/design.md "Producer seams" -> "Wasm-native
//! producers", the Dominator row). The `web-sys` shim next door is a thin
//! translation of the browser API onto the model here; this crate holds
//! the shadow DOM, the frame emission, and the world's `run` /
//! `handle-event` implementation.
//!
//! # Layout
//!
//! - [`node`]: nodes, identity, class chains.
//! - [`dom`]: the singleton, every mutation, and the frames each emits.
//! - [`css`]: `classList`, element `style`, and the slice of CSSOM
//!   dominator's `class!` macro needs.
//! - [`event`]: event objects, propagation, and the imperative verdict.
//! - [`driver`] (component target only): `run` and `handle-event` over
//!   [`stream_dom_guest::channel`].
//!
//! Everything but [`driver`] is target-independent, so `cargo test`
//! exercises the DOM model and the frames it produces natively. Same
//! split, and same reason, as `crates/stream-dom-dioxus/src/lib.rs`.

pub mod css;
pub mod dom;
pub mod event;
pub mod node;

#[cfg(target_arch = "wasm32")]
pub mod driver;

pub use dom::{document, mount_root, window};

/// The generated `producer`-world bindings, re-exported so an app crate
/// reaches `Guest` / `export!` through [`launch!`] without depending on
/// `stream-dom-guest` itself.
#[cfg(target_arch = "wasm32")]
pub use stream_dom_guest::bindings;

/// Wire an app crate's mount function into the `polymorph:stream-dom`
/// `producer` world.
///
/// ```ignore
/// stream_dom_fakedom::launch!(mount);
/// fn mount() { /* build the DOM under `mount_root_node()` */ }
/// ```
#[cfg(target_arch = "wasm32")]
#[macro_export]
macro_rules! launch {
    ($mount:path) => {
        #[doc(hidden)]
        struct __App;

        impl $crate::bindings::Guest for __App {
            async fn run(hydrate: bool) -> $crate::driver::MutationStream {
                $crate::driver::run($mount, hydrate).await
            }

            async fn handle_event(
                target: u32,
                name: u32,
                payload: ::std::vec::Vec<u8>,
                ev: &$crate::bindings::DomEvent,
            ) {
                $crate::driver::handle_event(target, name, payload, ev).await
            }
        }

        $crate::bindings::export!(__App with_types_in $crate::bindings);
    };
}

/// Off the component target there is no world to export into; keep the
/// mount function reachable so a native `clippy -D warnings` type-checks
/// the app rather than dead-coding it away. Same shape, same reason, as
/// `stream_dom_dioxus::launch!`.
#[cfg(not(target_arch = "wasm32"))]
#[macro_export]
macro_rules! launch {
    ($mount:path) => {
        #[doc(hidden)]
        pub fn __launch_mount() {
            let _: fn() = $mount;
        }
    };
}
