//! Generated WIT bindings for the `polymorph:stream-dom` `producer` world.
//!
//! The `generate!` invocation pulls in everything the world needs: the
//! `queries` import, the `events.dom-event` resource `run`/`handle-event`
//! borrow, and the `Guest` trait/`export!` macro for the two exports. No
//! `generate_all` — the world's own `use`/`import` clauses already name
//! every interface a producer needs; nothing else in the package
//! (`transformer`) is relevant to a producer guest. `Guest`, `export!`,
//! `DomEvent`, `NodeId` and `StrRef` all land at this module's top level
//! (wit-bindgen puts a world's own exports and `use`d types there); only
//! `queries`, an *imported* interface, needs a re-export below to be
//! reachable without spelling the generated `polymorph::stream_dom` path.
wit_bindgen::generate!({
    path: "../../wit",
    world: "producer",
    pub_export_macro: true,
    default_bindings_module: "stream_dom_guest::bindings",
});

pub use polymorph::stream_dom::queries;
