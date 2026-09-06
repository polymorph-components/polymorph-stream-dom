//! Dioxus as a `polymorph:stream-dom` producer.
//!
//! - [`writer`]: the `dioxus_core::WriteMutations` sink that turns Dioxus's
//!   stack-machine mutation vocabulary into addressable, self-contained
//!   stream-dom frames.
//! - [`events`]: the `dioxus_html::HtmlEventConverter` over the protocol's
//!   `EventPayload` families.
//! - [`driver`] (wasm32 only): the world's `run` / `handle-event`
//!   implementation over [`stream_dom_guest::channel`].
//!
//! `writer` and `events` deliberately name no WIT bindings, so `cargo test`
//! exercises them natively against a real `VirtualDom`
//! (`tests/writer_stream.rs`); only [`driver`] is `target_arch = "wasm32"`.
//! Same split, and same reason, as polyengine-dioxus's `src/lib.rs`.
//!
//! An application crate wires itself up with [`launch!`].

pub mod events;
pub mod writer;

#[cfg(target_arch = "wasm32")]
pub mod driver;

/// The generated `producer`-world bindings, re-exported from the shared guest
/// crate so an app crate reaches `Guest` / `export!` through [`launch!`]
/// without depending on `stream-dom-guest` itself.
#[cfg(target_arch = "wasm32")]
pub use stream_dom_guest::bindings;

/// Wire an app crate's root component into the `polymorph:stream-dom`
/// `producer` world.
///
/// ```ignore
/// stream_dom_dioxus::launch!(App);
/// ```
///
/// Expands to a unit type implementing the generated `Guest` trait plus the
/// generated `export!` invocation, so the app crate never names the bindings.
///
/// Off the component target it expands to nothing but a keep-alive for the
/// root component: [`driver`] and [`bindings`] do not exist there, and an app
/// crate still has to type-check under a plain `cargo clippy --workspace`.
#[cfg(target_arch = "wasm32")]
#[macro_export]
macro_rules! launch {
    ($root:path) => {
        #[doc(hidden)]
        struct __App;

        impl $crate::bindings::Guest for __App {
            async fn run(hydrate: bool) -> $crate::driver::MutationStream {
                $crate::driver::run($root, hydrate).await
            }

            async fn handle_event(
                target: $crate::bindings::EventTarget,
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

#[cfg(not(target_arch = "wasm32"))]
#[macro_export]
macro_rules! launch {
    ($root:path) => {
        /// Keeps the root component (and everything it reaches) reachable
        /// off the component target, so a native `clippy -D warnings` still
        /// type-checks the app rather than dead-coding it away.
        #[doc(hidden)]
        pub fn __launch_root() {
            let _ = $root;
        }
    };
}
