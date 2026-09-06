# `polymorph:stream-dom`

A framework-neutral protocol for streaming DOM mutations from a renderer
(Leptos, Dioxus, Svelte, Solid, React, Vue, anything written against
remote-dom, ...) to something that owns a DOM, across a wasm component
edge, a worker, an iframe, or a network — one op vocabulary, one byte
encoding on every tier, with transformers (coalescing, recording,
template expansion) written once for every framework. Frameworks compiled
to wasm are the first audience: a component has no `web_sys`, so for them
this is the only route to a DOM.

Nearest relative: Shopify's [remote-dom]. This protocol keeps its own
wire (streaming with backpressure, templates, anchor addressing,
hydration) and interoperates with remote-dom at both of its boundaries,
so remote-dom UIs are producers and remote-dom hosts and host elements
are receivers and islands. See the design record.

**Status: first spike.** Two producers run as wasm components on
[polyengine] in the page and render TodoMVC through a receiver that drives
Shopify's `DOMRemoteReceiver`: Dioxus via a `WriteMutations` adapter, and
[Dominator](https://github.com/Pauan/rust-dominator) unmodified via fake
`wasm-bindgen`/`web-sys` crates over a Rust shadow DOM. Live demos:
<https://polymorph-components.github.io/polymorph-stream-dom/>. Start with
[`docs/design.md`](docs/design.md), which records the decisions and their
reasons, and its "Spike" section for what the implementation found. The
schema is in three files by layer:
[`proto/stream-dom.proto`](proto/stream-dom.proto) defines every byte on
the mutation stream, [`proto/stream-dom-events.proto`](proto/stream-dom-events.proto)
every event payload (`protoc` parses both), and
[`wit/stream-dom.wit`](wit/stream-dom.wit) defines what only the component
model can carry — the stream, the event export, the query imports, the
`dom-event` resource (`wasm-tools component wit wit/` parses it).

Layout: `crates/` (proto types, the shared guest crate, the Dioxus
adapter), `guests/dioxus` and `guests/web-sys` (the demo components; the
latter is its own cargo workspace because it `[patch]`es wasm-bindgen),
`receiver/` (TypeScript receiver + polyengine host glue), `web/` (demo
site and browser test). `just --list` for the build and test recipes.

The immediate predecessor is
[polyengine-dioxus](https://github.com/lannbot/polyengine-dioxus), a
Dioxus-specific mutation stream for [polyengine]. Several of its ideas are
carried over and credited in the design record; its Dioxus-shaped parts
(the stack machine in particular) are deliberately not.

[polyengine]: https://github.com/polymorph-components/polyengine
[remote-dom]: https://github.com/Shopify/remote-dom
