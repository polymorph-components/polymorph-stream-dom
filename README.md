# `polymorph:vdom`

A framework-neutral protocol for streaming DOM mutations from a renderer
(React, Vue, Solid, Dioxus, Preact, ...) to something that owns a DOM,
across a wasm component edge, a worker, an iframe, or a network — one op
vocabulary, one stream shape, with transformers (coalescing, recording,
wire encoding) written once for every framework.

**Status: design stage.** There is no code. Start with
[`docs/design.md`](docs/design.md), which records the decisions and their
reasons; [`wit/vdom.wit`](wit/vdom.wit) is the same decisions as a draft
schema (parses with `wasm-tools component wit wit/`).

The immediate predecessor is
[polyengine-dioxus](https://github.com/lannbot/polyengine-dioxus), a
Dioxus-specific mutation stream for [polyengine]. Several of its ideas are
carried over and credited in the design record; its Dioxus-shaped parts
(the stack machine in particular) are deliberately not.

[polyengine]: https://github.com/polymorph-components/polyengine
