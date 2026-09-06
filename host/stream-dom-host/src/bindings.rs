//! `bindgen!` output for the `polymorph:stream-dom` `producer` world.
//!
//! The world's imports (`queries`, the `dom-event` resource) become host
//! traits implemented in [`crate::state`]; its exports (`run`,
//! `handle-event`) become typed concurrent calls used by
//! [`crate::producer`].
//!
//! Both directions are bound `async`: every function in the world is an
//! `async func` in WIT except the two `dom-event` methods, and the
//! component-model async ABI is what `run`'s `stream<u8>` return and
//! `handle-event`'s concurrency with the live stream require.

#[allow(missing_docs, reason = "generated code")]
mod generated {
    wasmtime::component::bindgen!({
        path: "../../wit",
        world: "producer",
        imports: {
            // `async` for the component-model async ABI, `store` for
            // `Accessor` access to the store data (the bridge and the
            // `ResourceTable`), `trappable` so a host error surfaces as a
            // trap and kills the producer rather than being swallowed.
            default: async | store | trappable,
            // `prevent-default` / `stop-propagation` are plain `func`s and
            // are no-ops here (see `crate::DomEvent`); binding them
            // synchronously keeps them callable from the handler's
            // synchronous prefix without an ABI round trip.
            "polymorph:stream-dom/events@0.1.0.[method]dom-event.prevent-default": trappable,
            "polymorph:stream-dom/events@0.1.0.[method]dom-event.stop-propagation": trappable,
        },
        exports: { default: async },
        with: {
            "polymorph:stream-dom/events@0.1.0.dom-event": crate::DomEvent,
        },
    });
}

pub use self::generated::{polymorph::stream_dom, Producer as ProducerBindings};
