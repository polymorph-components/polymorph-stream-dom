# polymorph:stream-dom — design record

Status: design stage. Nothing here is implemented. This document records
decisions and their reasons so that later work argues with the reasons
rather than re-deriving them; it is not a specification. The schema is
drafted in three files by layer: `proto/stream-dom.proto` for every byte on
the mutation stream, `proto/stream-dom-events.proto` for event payloads,
`wit/stream-dom.wit` for what only the component model carries.

## Purpose

A framework-neutral protocol for streaming DOM mutations from a renderer
(a "producer": Leptos, Dioxus, Svelte, Solid, React, Vue, ...) to something
that owns a DOM (a "receiver": a browser page, a server-side renderer, a
test recorder), across a boundary that may be a wasm component edge, a
worker, an iframe, or a network.

The producers that need this most are the ones compiled to wasm. A
component has no `web_sys`: every non-JS web framework today reaches the
DOM through per-call JS glue (wasm-bindgen, Scala.js, js_of_ocaml), one
untyped crossing per DOM operation, and none of that exists inside a
component. For them a typed mutation stream is the only path to a DOM,
not an optimization. JS frameworks are the second audience: they already
have a DOM and need an adapter to stop touching it.

This gap is deliberate on the platform's side. The 2019 WebIDL Bindings /
Interface Types proposal set out to make direct DOM calls from wasm cheap;
it was abandoned and its remains became the component model, which binds
no browser API at all. A mutation protocol is what is left once that road
is closed.

It is a write-side command protocol, not an observer. The web
`MutationObserver` reports what already happened to a DOM; this stream is
the receiver's *only* way to learn what to render. The close analogs are
Dioxus's `WriteMutations`, React Native's Fabric mount transactions, and
worker-dom's transferable mutations — not `MutationRecord`.

## Non-goals

- Not a native-widget protocol. The vocabulary is DOM-shaped on purpose;
  generalizing the receiver side to non-DOM trees is a different project.
- Not a canvas. Flutter web, Uno, Avalonia, Compose Multiplatform for web
  and egui are the dominant non-JS "wasm web app" story and they bypass
  the DOM entirely (own text layout, own accessibility tree). They are the
  alternative this protocol competes with — real text, real a11y, real
  SEO in exchange for a protocol — not a target.
- Not a JS framework runtime. Producer adapters plug into each framework's
  existing renderer seam; the frameworks themselves are unchanged.
- Not a fix for synchronous-layout-dependent application code. See
  "Reads" below for what is and isn't preserved.

## Component-model semantics that shape the design

These are facts about the Component Model async proposal (as of the
`Concurrency.md` / `CanonicalABI.md` explainers), checked against the spec
text, not inferred from Rust or JS habits.

**`async` in WIT means only "may block before returning."** Sync vs async
is chosen independently at each call site and each implementation:

- A caller may *sync-lower* (its thread suspends until the value arrives;
  the runtime runs whatever else is ready) or *async-lower* (receives a
  subtask handle and continues).
- A callee may *sync-lift* (ordinary run-to-completion code on its own
  fiber), *stackless async-lift* (callback event loop), or *stackful
  async-lift* (fibers; opts out of the instance lock).

All pairings compose. Consequence for us: guest code can always make a
blocking-looking call to a host import, regardless of how the host
implements it or which transport sits behind it. The only code that cannot
block is JS that is not inside a component. "Sync reads" is therefore not
a per-transport capability; what varies is latency and whether the read
observes a DOM undisturbed since the last batch.

**Non-`async` functions trap if they block.** This is a guarantee a host
may rely on from a synchronous JS context (e.g. inside a DOM event
listener). Non-`async` exports also ignore the instance's exclusive lock
("barge in"), which is hazardous if another guest task is suspended
mid-frame on the same linear-memory shadow stack. Mixing non-`async`
exports with sync-lowered blocking imports is the case to avoid.

**Streams are unbuffered rendezvous channels.** A `stream.write` of N
elements meeting a `stream.read` with room for M copies `min(N, M)`; both
operations complete with a partial count and the writer re-issues. One
read never spans two writes; one write may be split across many reads.
There is no message framing at the transport level: the stream knows
bytes, not frames or batches. A zero-length write is a readiness probe (allowed,
not guaranteed, to wait for a pending read).

**Exclusive lock.** With sync or stackless lifting, an export call
arriving while another task holds the instance waits at the backpressure
gate, in order. A renderer's commit must not be reentered, so this is the
behavior we want for event exports; a long-lived scheduler task can be
stackful to stay out of the way.

## Architecture

```
producer adapter ──▶ stream<u8> ──▶ [transformers]* ──▶ receiver
(one per framework)  (op frames)    coalesce, record,    (browser DOM,
                                    expand, multiplex    SSR, test
                                                         recorder)
```

- Every hop carries the same bytes: a sequence of length-prefixed op
  frames, one encoding on every tier (in-process `stream<u8>`,
  `postMessage` of a transferred buffer, a socket, a corpus file).
- Transformers have the shape `func(in: stream<u8>) -> stream<u8>` and are
  written once for all frameworks. Coalescing is the canonical one.
- The Component Model embedding is the *reference semantics* for
  backpressure and lifecycle. A producer or receiver running outside any
  component (a JS framework in a worker, a Node SSR receiver) speaks the
  same bytes with `read(n)` / `write(buf)` promises under the same
  min-copy rule; it is a first-class implementation of the protocol, not
  an emulation, and the conformance corpus runs unchanged against it.
- The vocabulary has two layers. *Definitional* ops (`intern`,
  `register-template`, `clone-template`, `bind-path`) can be compiled away
  by a transformer into the *structural core* (`create-*`,
  `insert-before`, `remove`, `set-*`, listeners, the `commit` flag). The core is
  isomorphic to a `MutationRecord` stream, so a minimal receiver is small,
  a recorder is a `MutationObserver`, and during bring-up an expand
  transformer plus a thin shim can drive an existing browser receiver
  (Shopify remote-dom's `DOMRemoteReceiver`, rrweb's `Replayer`) before a
  native one exists.

## Protocol decisions

### The channel is `stream<u8>` of op frames

The wire is length-delimited protobuf `Frame` messages, defined in
`proto/stream-dom.proto`. WIT carries what only the component model can
carry — functions, resources, the stream itself — and no data type is
defined in both places.

An earlier draft made the channel `stream<operation>`, typed end to end,
with a byte encoding as a transformer output for the remote hop. That was
two representations of one protocol: the network tier and the recorded
corpus need bytes regardless, so the typed hop only added a second form
and the converters between them. Once the encoding is unavoidable, the
question is whether the typed in-process hop earns its keep, and it does
not:

- **Cost.** The measured 0.15–0.8 µs/op was canonical-ABI lift of a
  variant with strings, plus one JS object per op on a JS receiver and one
  `realloc` per string on a wasm receiver. A `stream<u8>` write is a
  memcpy of the chunk; a receiver can decode field-by-field into DOM calls
  with no per-op allocation (see Encoding), and a wasm receiver reads
  strings as slices of the chunk buffer.
- **Evolution.** A WIT variant cannot gain a case compatibly; every new op
  is a version bump and a digest mismatch. Protobuf field numbers give
  additive change at both the op level and the field level.
- **Byte-bounded receiving.** Ops are variable-size; a read buffer of K
  elements bounds nothing. A read buffer of K bytes does.
- **Maturity.** `stream<u8>` is the most exercised path in the async
  proposal (`wasi:http` bodies, `wasi:io`); streams of complex variants
  are the least, in both wasmtime and jco.
- **Precedent.** worker-dom (typed arrays + string table), Blazor
  `RenderBatch`, Dioxus/sledgehammer and rrweb all ship bytes or JSON;
  none ships an IDL-typed element stream.

What typed elements gave up: canonical-ABI validation of UTF-8 and bounds
(now the decoder's job — which is where it belongs anyway if producers can
be untrusted, open question 10) and typed values in traces (stock protobuf
tooling reads the corpus instead).

**Never `list<u8>` per batch.** A `list` is lifted and lowered atomically:
the receiver must have room for the whole batch before the rendezvous
completes, cannot accept part of it, and a wasm receiver `realloc`s the
entire batch or OOM-traps. It also forbids a transformer from working
across batch boundaries without holding several whole batches. With the
stream, receiver memory is a tuning knob, backpressure is per chunk, and
processing may start before production finishes.

### Encoding: protobuf, and why not a hand-rolled layout

`proto/stream-dom.proto` (proto3) is normative for every byte on the
stream and in event payloads. The stream is the standard length-delimited form — varint byte
length, then one `Frame`, repeated. No header; the package version is
digest-checked at instantiation, and additive schema change (new `oneof`
cases, new fields) needs no version bump because receivers skip what they
do not know.

Chosen over a hand-rolled positional layout, which was the previous
draft, for four things it could not offer cheaply:

- **Field-level evolution.** A positional layout can skip an unknown *op*
  by its length but cannot add a field to an existing op without a version
  bump. Open questions 9 and 10 will touch existing ops.
- **Tooling.** `protoc --decode` and `buf` read the corpus; the
  frame-to-text decoder the corpus needs is stock.
- **Generated codecs** in every producer language (prost, pbf,
  protobuf-go, Kotlin) instead of ~20 hand-written layouts per language,
  forever.
- **Events in the same schema.** The remote tier needed a second
  hand-rolled encoding for event payloads; now it is the same file.

The cost is decode speed with *generated* readers, which build an object
per message — roughly the cost profile of the typed lift declined above.
pbf (mapbox) removes it: alongside `.proto`-generated readers it exposes
`readFields((tag, obj, pbf) => …)` with `readVarint` / `readString` /
`skip`, so the hot structural ops are decoded with a switch on field tag
straight into DOM calls, no intermediate object, while cold ops
(`register-template`, nested messages) use the generated readers. Same
`.proto`, same library, ~3 KB; built for Mapbox vector tiles, which is the
same shape of problem. Its writer side (`writeVarintField`,
`writeStringField`, `writeMessage`) gives the JS producer adapters and the
remote-dom transcoder an allocation-light encoder. protobuf.js has the
equivalent `Reader` / `pbjs` split and is the fallback if pbf's codegen
proves too thin; protobuf-es or ts-proto only if generated TypeScript
types are wanted, since pbf emits JS with JSDoc. Rust layers the same way:
prost generated code by default, `prost::encoding`'s public
`encode_varint` / `encode_key` for a hand-written hot encoder if a profile
asks for one.

Rejected: FlatBuffers and Cap'n Proto are zero-copy, attractive for a wasm
receiver, but vtables/offsets and 8-byte alignment roughly double frames
that are 6–20 bytes long — wrong tool for a stream of tiny messages. CBOR
is self-describing and universal but slower, larger and without codegen
worth the name. postcard/bincode are Rust-only in practice.

Size is a wash or a small win over the positional draft: varint node ids
and `str-ref`s beat fixed `u32`/`u16`; the `oneof` wrapper costs ~2 bytes
per frame. `str-ref` is therefore a `uint32` varint, not a `u16`.

Rendezvous copies split at byte granularity, so a frame may straddle two
reads; decoders keep the partial tail. Producers typically encode a whole
batch into one buffer and issue one write, but nothing depends on it.

### Batches are framed by a `commit` flag, not by the transport

`commit` is a boundary signal, not a buffering instruction. Its uses:

1. After-commit work that must see the whole batch applied — synthetic
   `mounted`, refs, host-side islands.
2. Ack/coalescing granularity on a remote hop.
3. Recording and replay.

It is a `bool` on `Frame`, set on the last frame of a batch, rather than
an op of its own. Fine-grained producers emit many one- or two-op batches
(a signal flush per microtask), where a separate commit frame would be a
third to a half of all frames; the flag costs two bytes and no dispatch.
An empty batch (after-commit work with nothing to mutate; an ack tick on a
remote hop) is a frame with `commit` set and no op — legal only in that
case, so there is one representation of a boundary, not two. Ops are
applied before the flag is honored, whatever the field order inside the
frame: proto parsers accept any order, so a receiver cannot assume
`commit` decodes last even though encoders write it that way.

A receiver *may* buffer until `commit` to guarantee no half-applied frame;
that is receiver policy. It is only needed when the producer is slower
than a frame *and* streams as it renders. Every framework's mutation phase
is synchronous once it starts, so a producer that finishes rendering before
its first write and then drains never leaves the receiver's read parked
mid-batch. Whether a same-thread receiver can drain a whole batch inside
one browser task depends on the runtime resuming the writer's fiber
synchronously when its partial write completes. Verify in the embedding
before relying on it.

There is one kind of commit. The browser already supplies the timing
distinctions frameworks expose (React `flushSync` vs batched, Svelte
`flushSync` vs microtask, Vue `flush: sync | pre | post`): nothing painted
mid-task is visible, so "apply now" and "apply at the end of the
microtask" are the same thing to the DOM, and a receiver's only real
timing choice is whether to hold a committed batch until the next
animation frame. That is allowed, under an invariant: **queries observe
every committed batch.** A receiver that defers application flushes before
answering `get-client-rect` or any other read, or a producer's
write-commit-measure sequence silently reads stale layout.

Two things that look like commit kinds are not:

- A full snapshot for resync (open question 5) is an ordinary batch after
  `reset`, as rrweb's periodic "checkout" is an ordinary full snapshot in
  the incremental stream.
- A batch to be applied as a `document.startViewTransition` is the one
  case a receiver cannot infer: it must know before the first mutation. It
  is a hint at the batch *start*, not a commit variant — see open
  question 11.

Transformers preserve the flag. One that drops the frame carrying it (a
`create … remove` pair whose `remove` ended the batch) re-emits it on the
batch's last surviving frame, or on an op-less frame if nothing survives.
One that merges batches sets it once, on the final frame; intermediate
states that never reached the receiver never existed for it, which matches
what frameworks do internally when they batch state updates.

### Every op is addressable and self-contained

This is what makes a bounded-window coalescer possible: `set-attribute(id,
name, v)` twice → keep the last; `insert-before` twice → keep the last;
`create(id) … remove(id)` within the window → drop both and everything
targeting `id` between; all decided per op with a small index keyed by
`(id, kind, name)`.

Consequences:

- **Tree ops are `insert-before(parent, id, anchor?)`.** Every seam bottoms
  out in `insertBefore`: react-reconciler, Vue's `createRenderer`, Solid's
  universal renderer, Angular's `Renderer2`, Preact, Dioxus (after
  resolving its stack). `anchor = none` is append. Inserting an attached
  node is a move; a receiver should use `Node.moveBefore()` (shipping
  since 2025) where available, which preserves iframe state, focus,
  selection and running animations that `insertBefore` resets. No
  protocol change — receiver behavior.
- **No stack machine.** Dioxus-style `push-root` / `append-children(m)` /
  path ops relative to a stack top mean nothing without replaying the
  stack; a coalescer would have to be an interpreter. Dioxus's adapter
  resolves its stack producer-side, which is trivial.
- **Producer allocates ids** (`u32`; `0` is the mount root): no round trip
  to learn a name. **Ids are never reused within a stream.** Reuse after
  `remove` would be safe on the forward channel (stream order), but the
  reverse channel is not ordered against it: across a worker or network,
  `handle-event(target=7)` for a node the producer has since removed can
  arrive after `7` was handed to a new node, and the event lands on the
  wrong handler with no way to tell. Blazor hit exactly this and answers
  with never-reused handler ids plus a disposal grace period. Monotonic
  allocation makes a stale event a simple "unknown id, drop". Exhausting
  `u32` in one session is a `reset` (open question 5), not a wrap.
  `remove` still frees the subtree's *nodes*; the producer knows the tree.
- **Interning definitions are never dropped** by a transformer, even when
  the op that used them was. Keeps the define-before-use invariant trivial.
- **Ids are per stream.** A host with several producers on one page maps
  `(stream, id) → Node`; no namespace field in the protocol.

### `set-attribute` and `set-property` are distinct

Frameworks disagree at the edges about which names are DOM properties
(`value`, `checked`, `className`, `style`, `innerHTML`, custom elements).
React, Preact, Vue each carry their own table; Dioxus's host port carries
dioxus-web's. Making the receiver decide couples every framework to one
policy. The producer adapter decides, using the table its framework
already has. `set-property` carries a typed value; an absent value deletes.

### Interning

`intern(id, s)` defines a slot; tags, namespaces, attribute
names, event names are `str-ref`s. Definitions precede first use in the
same stream; each definition is emitted once per producer instance. Event
names cross back on `handle-event` as the same small integer, so steady-state event
dispatch transfers no string data. (Borrowed from polyengine-dioxus.)

### Templates are core, not an extension

The frameworks with momentum do not diff. Svelte 5, Solid, Vue Vapor,
Angular, Lit, Marko, Leptos, Sycamore, Compose all share one idiom: clone
a compiled static template, bind its holes by walking it, then update
leaves individually as signals change. Structural ops only appear at
control-flow boundaries (keyed lists, conditionals). Dioxus has the same
template shape under its diff. React alone has no templates.

For these producers a mount without templates degrades to one
`create-element` per node — exactly the cost they were built to avoid,
and worse across a boundary than in-process. So `register-template` /
`clone-template` / `bind-path` are core vocabulary that a React adapter
happens never to emit, not an extension that everyone else opts into.
This corrects an earlier draft that inherited the wrong emphasis: Dioxus's
*addressing* (the stack machine) was the part to drop, not its templates.

Two things this buys beyond mount cost:

- **The producer-side structural walk disappears.** Compiled frameworks
  walk `firstChild`/`nextSibling` after cloning to find their holes; over
  this protocol the compiler already knows the template's shape, so paths
  are static and no read is needed. Fine-grained frameworks turn out to be
  the *least* read-hungry producers once templates are in the protocol.
  The residual reads are hydration markers, and hydration is push here.
- **Attribute and text holes need no new ops.** `bind-path` to the hole's
  node, then ordinary `set-attribute` / `set-text`. An element hole (a
  nested component, a control-flow site) is a `dynamic` template node,
  which clones as a placeholder to `insert-before` against.

Templates are an arena, not HTML. A template is a flat pre-order list of
nodes with integer indices for roots and children; receivers validate the
index graph (range, acyclicity) rather than trust it. (Borrowed from
polyengine-dioxus, where WIT's ban on recursive types forced it; protobuf
would allow nesting, and the arena is kept anyway: `bind-path` resolves
by index in O(depth) with no recursive decode, one template can carry
several roots, and validation is a bounds check rather than a depth
limit.) The alternative —
ship the template as an HTML string and let the receiver parse it into a
`<template>`, which is what Svelte and Solid do in-browser — was rejected
for the same reason positional hydration was: the HTML parser reshapes
trees (`<tbody>` insertion, `<p>` auto-close, adjacent-text merging), so
child-index paths into a parser-built tree are not the producer's paths.
The arena gives the producer the exact tree it asked for. A compiler that
has the HTML string parses it once, at build time, into the arena.

Interior nodes of a cloned template get ids via `bind-path(root, path,
id)`, a child-index walk from an explicit root. Positions are reliable
here because the producer built the tree. Self-contained (the root is
named, not implied by a stack), so a transformer can treat it as opaque
bookkeeping.

**Considered and not taken: a cursor.** Compose's `Applier` separates
*where* (`down(node)` / `up()` maintaining a current node) from *what*
(`insert(index, node)`, `remove`, `move`), and it is cheaper on the wire
than repeating a parent id per op when binding deep into a template. It
is also explicitly addressed — cursor moves name nodes — so it is not the
Dioxus stack machine. It still loses: every op's target then depends on
the cursor state, so a coalescer must track the cursor to know what an op
touches, which is the interpreter-not-filter failure in milder form. The
wire saving is marginal once `bind-path` names its root and `intern`
handles the strings; explicit addressing per op stays.

### Reads are `async`-typed host imports

`get-client-rect`, scroll geometry, focus, etc. are declared `async func`
because a host behind a worker or network must be allowed to park the
guest. A same-thread browser host answers without blocking, and a guest
that sync-lowers sees a plain blocking call on every host. What is *not*
preserved on a remote host is measure-then-mutate before paint
(`useLayoutEffect`-style); application code that depends on it is not
portable to that tier, and the protocol does not pretend otherwise.

Reentrancy: `set-focus` fires `focusin`/`focusout` synchronously, which
would dispatch events back into a guest still on the stack. The receiver
brackets such imports with a dispatch gate and drains queued dispatches
after the guest's turn unwinds. (polyengine-dioxus's `dispatch.ts` is the
worked example.)

### Refs are ids; third-party DOM libraries need islands

No tier reliably offers a `Node` handle to the producer, so `ref.current`
is an id. Libraries that grab DOM nodes (editors, charts, d3) do not work
inside the producer; the escape hatch is a host-side island — a node the
receiver hands to receiver-side code — analogous to React Native's native
components.

The likely shape is **no new op at all: an island is a custom element.**
The receiver registers tags (real `customElements.define`, or a private
tag → factory map); the producer emits ordinary `create-element(tag)`,
`set-property` for props, `add-listener` for callbacks; the island's code
gets the real node because it *is* receiver-side code, and
`connectedCallback` / `disconnectedCallback` are its lifecycle. This is
how Shopify remote-dom v2 exposes host UI to sandboxed producers, and how
server-driven-UI systems work generally. Two things it needs from the
protocol: a `custom` payload family carrying the `CustomEvent.detail`, and
a structured property value so props can be more than scalars —
`google.protobuf.Value` is the obvious candidate now that the wire is
protobuf. `innerHTML` and Selection/Range manipulation, which
the protocol otherwise lacks on purpose, live behind the same door.

### Hydration is push, and binds by marker

The server already sent HTML; on first render the producer must say "my id
7 *is* that existing node" instead of creating one. It emits no
node-creating ops for the initial render and asserts the bindings. A
mismatch is a receiver-side error, not silent repair. Pull-style hydration
(React's: read the DOM and compare) does not stream and is out of scope.

Bindings are by **marker**, not by position: `bind-marker(key, id)` binds
`id` to the node the server-side render stamped with `key` (an attribute
on elements, a comment beside text nodes and placeholders). Positional
binding from the mount root would require the browser's DOM to have
exactly the shape the producer rendered, and the HTML parser routinely
breaks that for reasons outside anyone's control: it inserts `<tbody>`
inside `<table>`, auto-closes `<p>` before block elements, and merges
adjacent text nodes, so `"Hello, " + name` is two nodes in the producer's
model and one in the DOM. Whitespace between server-emitted tags and
extension-injected nodes do the same. Any of these shifts every later
index onto the wrong node with no good error. Markers survive all of it
and make a missing node a precise report. This is why every shipping
framework uses at least comment markers (React `<!-- -->` between adjacent
text, Vue/Svelte `<!--[-->`…`<!--]-->`, Solid `data-hk`, Dioxus
`data-node-hydration` + `<!--node-idN-->`).

The marker syntax is an agreement between the SSR renderer and the
receiver, not part of the op stream; the op carries only the key.

## Events

Dispatch: `handle-event(target, name, payload: list<u8>, ev)` export.
`target` and `name` are plain scalars so the guest can route without
decoding; `payload` is a protobuf `EventPayload` — a typed snapshot whose
family the receiver chooses by event name (mouse, keyboard, form, ...),
carrying everything a handler commonly reads (`target.value`, `checked`,
key, coordinates, form data on submit, `relatedTarget` as an id). The
same bytes cross the worker and network tiers, so there is one definition
of every family and no in-process/remote split. A `list<u8>` here is fine
where a `list` per batch was not: one small message per call, not a
batch. Files and drag data are resources, not copies. Three families are
synthesized by the receiver rather than taken from DOM events: `resize`
and `visible` from observers, and `frame` from `requestAnimationFrame` —
a producer has no rAF of its own, and anything that animates needs the
receiver to say when the last commit reached the screen and the next one
is due. Subscribed on the mount root like any listener, so a producer
that is not animating pays nothing. `mounted` is synthetic too: fired once
per registered element after the batch that created it is fully applied.
Families and synthetics are borrowed from polyengine-dioxus with `frame`
added; field sets follow the DOM interfaces and were checked against what
dioxus-html's `Has*Data` traits read. Two of its families fold away: drag
events are the `mouse` family, since their only addition is the
`DataTransfer` resource; `load` / `error` carry nothing, since the event
name already distinguishes them. Timestamps in payloads are epoch
milliseconds: a producer has a wall clock but no `performance.timeOrigin`,
so a document-relative `DOMHighResTimeStamp` would be a number it cannot
relate to anything.

Files and `DataTransfer` are resources, not copies, and are not yet
declared in the WIT: `handle-event` has no way to hand them over. The
likely shape is methods on `dom-event` (`files() -> list<own<file>>`,
`data-transfer() -> option<own<data-transfer>>`), called in the handler's
synchronous prefix; polyengine-dioxus's `file` and `data-transfer`
resources are the model. Open.

`queries` keep typed WIT signatures: they are RPC with small fixed return
shapes (`rect`, `point`, `size`), typing the call is free in-process, and
they are not on the stream. Those three records are the only data typed
in WIT; a remote tier that forwards queries encodes them as part of its
own RPC, which is a transport concern rather than protocol.

Delegation: bubbling events are delegated at the mount root; non-bubbling
ones are attached per element. The listener op carries the `bubbles` bit
so removal can find the registration.

`preventDefault` is the one genuinely hard part across an async boundary,
because every framework lets the handler call it imperatively. Options:

- **A. `borrow<dom-event>` resource with `prevent-default` /
  `stop-propagation` methods**, `handle-event` declared `async`. The host
  calls the export from inside the listener; the guest's synchronous
  prefix runs before the export first blocks, and a call to
  `prevent-default` in that prefix lands in time. Matches browser
  semantics exactly (after the first `await` it is already too late in a
  browser today). Hazard: if the instance is under backpressure when the
  event arrives, *no* guest code runs inside the listener and the call is
  silently missed.
- **B. Non-`async` `handle-event` returning a verdict.** Guaranteed
  decision at return; the guest cannot block at all in the handler (it may
  spawn). Hazard: barge-in past the exclusive lock (see semantics above).
- **C. Declarative flags on `add-listener`** (`prevent-default`,
  `stop-propagation`, `passive`) plus a per-event-type default policy at
  the receiver (a registered `submit` listener implies preventDefault; a
  `click` listener on `<a href>` likewise).

C is required regardless as the only thing a remote receiver can honor.
Phoenix LiveView is the existence proof that C alone is livable: years of
production apps on a server-side producer with nothing but declarative
`phx-*` modifiers; worker-dom, facing the same boundary, also lands on a
receiver-side per-event-type default policy. Leaning A + C: A for
in-process receivers, C everywhere. B is recorded in case A's backpressure
hazard proves real in practice.

## Producer seams

Two audiences, with opposite problems. Frameworks compiled to wasm have no
DOM inside a component and need a seam to reach one *at all*; the question
is "can I swap what `web_sys` is." JS frameworks have a DOM and need a
seam to *stop* touching it; the question is "can I intercept `document`."

### Wasm-native producers (the first customers)

| Framework | Model | Seam | Adapter strategy |
|---|---|---|---|
| Leptos (tachys) | fine-grained | `Renderer` trait: create/insert/remove/set-attr, `first_child`/`next_sibling`/`get_parent`, `clone_node` | near-verbatim match to this vocabulary; structural reads answered by a producer-side shadow tree. Verify: 0.7 removed the generic renderer parameter from view types over `Dom` for compile time, so this may be a patch rather than a type-level plug |
| Sycamore | fine-grained | `GenericNode` trait, still generic | direct |
| Compose HTML (Kotlin) | snapshot state + slot table | Compose runtime `Applier` (`insertTopDown`/`insertBottomUp`/`remove`/`move`/`clear`) | direct; the best-designed seam on the list, the runtime already speaks tree edits. Under-invested upstream in favor of canvas Compose |
| Dioxus | VDOM | `WriteMutations` trait | direct; resolve stack ops producer-side |
| Reflex-DOM (Haskell) | FRP | `DomBuilder` typeclass | direct; niche |
| Dominator, Silkenweb, MoonZoon (Rust); Laminar (Scala.js); Deku (PureScript) | fine-grained / FRP | none — `web_sys` / `dom` direct | recording fake `web_sys` layer; viable because bound output reads little back |
| Yew, Sauron (Rust); Vugu, go-app, Vecty (Go); Elm; Miso; Halogen; Tokamak | VDOM | none | fake DOM layer, per language |

### JS producers

| Framework | Model | Seam | Reads the DOM? | Adapter strategy |
|---|---|---|---|---|
| React | VDOM | `react-reconciler` HostConfig | barely (hydration aside); instances opaque → return ids | direct; commit = batch; experimental API, expect churn |
| Vue (vnode) | VDOM | `@vue/runtime-core` `createRenderer` | `parentNode`, `nextSibling` | direct + shadow tree |
| Vue Vapor (3.6 alpha) | compiled, fine-grained | none yet | little | fake DOM; watch for a seam as it matures |
| Solid | compiled, fine-grained | `solid-js/universal` | `getParentNode`, `getFirstChild`, `getNextSibling` | universal loses the compiled-template fast path; a fake DOM under the *compiled* output keeps it and needs templates in the protocol |
| Svelte 5 | compiled, runes | none public; `svelte/internal/client/dom/operations` is a thin de facto seam, unstable | `$.template` (innerHTML), `$.child`/`$.sibling` walks | fake DOM; template HTML parsed to arena at build time; walks become static paths |
| Angular | template VM + signals | `Renderer2` (stable, public) | `parentNode`, `nextSibling` | direct + shadow tree |
| Lit | tagged templates, value compare | none | `<template>` innerHTML, `TreeWalker` | fake DOM |
| Preact | VDOM | none | freely (`name in dom`, `.value`) | fake DOM; per-tag property tables |
| Qwik, Marko, Ripple | fine-grained (Qwik keeps a light vnode mirror) | none | little | fake DOM |
| Anything written against remote-dom | any | `RemoteConnection` (`mutate`, `call`) | via its polyfill | transcoding adapter; see "Interop with remote-dom" |

Two strategies, both needed: *seam adapters* where a seam exists,
*recording fake DOM* where none does. The fake DOM is one adapter for
every remaining framework plus vanilla JS, and is leaky in known ways
(prop-vs-attr `in` checks need per-tag tables; template `innerHTML` needs
an HTML parser; layout reads hit a wall). worker-dom is the prior art and
its stall is informative. The fake DOM itself is not ours to write:
`@remote-dom/polyfill` is a maintained, deployed minimal DOM for workers
with mutation hooks at the node level, where `nextSibling` is available
and anchor-based frames fall out directly. The compiled fine-grained
frameworks are the *better* fake-DOM candidates, not the worse: their
output reads almost nothing back, and the template parse happens once per
template rather than per instance.

Fine-grained producers emit one op per signal and have a weaker batch
boundary than a VDOM commit — "whatever flushed in this microtask"
(Solid's `batch`, Svelte's effect scheduler, Vue's scheduler). `commit`
maps onto that flush; expect many small batches and lean on the coalescing
transformer, driven by backpressure and the zero-length readiness probe,
rather than a producer-side policy. Note that these frameworks already pay
a boundary crossing per DOM op today (JS glue), so a rendezvous stream is
an improvement before any host-side cleverness.

## Interop with remote-dom

Shopify's remote-dom is the nearest relative, and its ecosystem is worth
more than its wire. Interop happens at its two boundaries, in both
directions, with this protocol's frames in the middle and nothing of its
record format on the wire:

- **Producer side.** Everything remote-dom ships for the remote end
  (`@remote-dom/polyfill`, `RemoteRootElement`, `RemoteElement`, the
  React/Preact/Svelte/signals packages) talks to one object:
  `RemoteConnection { mutate(records), call(id, method, ...args) }`. An
  adapter implementing that interface makes every existing remote-dom UI
  a producer unmodified. It transcodes: shadow tree for `(parent, index)`
  → anchor, subtree-carrying `INSERT_CHILD` flattened to per-node frames,
  `UPDATE_PROPERTY` with the event-listener type → `add-listener`. Same
  shape as Dioxus's stack resolution, in the same place; the costs of
  their format apply only JS-to-JS inside the worker, before encoding.
- **Receiver side.** A `frames → RemoteMutationRecord[]` shim (expand
  templates, shadow tree for indices) lets a wasm-native producer render
  into any host that already speaks remote-dom. It is also the bring-up
  receiver: `DOMRemoteReceiver` works before a native receiver exists.
- **Host elements.** Custom elements built for remote-dom hosts are
  islands under this protocol's receiver as-is. No shim.

The split: Shopify maintains the polyfill, the framework packages, the
element kits and the record format's stability; this project maintains
two shims that track a four-record format.

Two gaps the shims cannot close:

- **Function-valued properties.** remote-dom lets a remote pass a callback
  as a property, proxied over `@quilted/threads`. A function cannot cross
  this wire. Their `remoteEvents` path is real listener registration and
  maps cleanly; legacy function-props are rejected by the adapter with a
  clear error rather than half-supported.
- **Open-ended `call(id, method, args)`.** Theirs is any method on a host
  element; `queries` here is a fixed set. Closing it is one addition — a
  generic `call-method(id, name, args)` async import returning a
  structured value — which islands want anyway (open question 3).

## Transports

Design to the weakest transport; the others buy latency, not semantics.

| | In-process (component) | Worker / iframe | Network |
|---|---|---|---|
| Guest blocking reads | yes | yes (host parks the guest across `postMessage`) | yes (slow) |
| Non-`async` export honored inside a DOM listener | yes | no (proxy) | no |
| Imperative `preventDefault` (option A) | yes | no | no |
| Backpressure | rendezvous | rendezvous (host paces reads) | rendezvous (host paces reads by remote ack) |
| Reconnect / resync | n/a | n/a | needs `reset` + full snapshot |

Because the stream is unbuffered, backpressure is uniform: the host decides
when to issue the next read and the guest sees identical semantics
everywhere. The bytes are identical too: the worker tier transfers the
chunk buffer with `postMessage` (zero-copy), the network tier writes it to
the socket. Network is the one tier that differs semantically (no
synchronous verdict possible), hence option C above and a resync path.

Where frameworks run: Rust/Go/etc. producers compile natively to
components and, as noted under Purpose, have no other route to a DOM there.
JS frameworks either run inside a component (componentize-js; the
component-model semantics then apply uniformly) or as plain JS writing the
same frames — for most JS frameworks the worker is the natural home.

## Prior art

Nothing existing can be adopted whole: no prior system runs as a
component-model stream with rendezvous backpressure, puts templates on the
wire as a reusable clone-and-bind primitive, or exposes its optimizer as a
composable transformer. Everything else here has an existing
implementation to compare against, and several are reusable as bring-up
receivers or as lists of edge cases.

### Closest: a DOM built elsewhere, mutations shipped to a real one

**Shopify remote-dom** (ex `remote-ui`). Untrusted extension code in a
worker or iframe builds a tree against a fake `document`; an id-addressed
mutation stream (`insertChild`, `removeChild`, `updateText`,
`updateProperty`) reaches a host receiver; events serialize back. In
production in Shopify checkout extensions. The nearest relative of this
design, and the one it interoperates with (see "Interop with remote-dom").
Not adoptable as the wire: inserts are `(parent, index)` and carry whole
serialized subtrees, `mutate(records)` is fire-and-forget with no
backpressure, there are no templates, no interning, no hydration, and
(verify) no namespaces. Its two design choices worth copying: host UI
exposed as custom elements (see islands), and an explicit refusal of
synchronous reads.

**AMP worker-dom.** Same shape, main thread ↔ worker, with a typed-array
encoding and a string table (this design's `intern`). Its answers to the
hard parts: reads are explicitly async (`getBoundingClientRect` returns a
promise); `preventDefault` is a receiver-side default policy. Its stall is
informative about the fake-DOM strategy's limits.

**rrweb** (Sentry, PostHog, LogRocket, OpenReplay replay). Records a full
DOM snapshot plus `MutationObserver`-derived deltas — `adds:
[{parentId, nextId, node}]`, `removes`, `texts`, `attributes` — with an
id mirror on both ends, and replays into another document. Anchor-based
insert-before with a producer-side id mirror, at very large deployed
scale. Its edge-case list is this protocol's to-do list: shadow roots,
`adoptedStyleSheets` and CSSOM `insertRule`, `<canvas>`, iframes,
`<input>` value-vs-attribute, `<textarea>` content, `<select>` selection.

**Partytown** is the opposite bet — third-party scripts in a worker with
*synchronous* DOM access faked via sync XHR to a service worker — and a
measured demonstration of what insisting on sync reads costs.

### Server-side widget trees synced to a browser

A twenty-year lineage of "the real tree lives on the server": **Vaadin
Flow** (server-side `Element` API mirroring the DOM node-for-node; a
`StateTree` ships `put` / `splice` / `attach` / `detach` by node id over
websocket), **Eclipse RAP** (`create` / `set` / `call` / `listen` /
`notify` / `destroy` on id-addressed remote objects — `listen` is this
design's subscribe-per-event), **Wt**, **ZK**, **Echo**, and lately
**Streamlit**'s `Delta` protobuf. Then the two already discussed:

**Blazor.** `RenderBatch` — an edit list plus a reference-frame table —
is applied by the same JS interop whether the producer is in-process wasm
(Blazor WebAssembly) or on a server over SignalR (Blazor Server). Its
internals diff a render tree, but the wire is a mutation batch, and the
"same protocol, two boundaries" claim has been true in production since
2019. Its failure modes are the ones to price in for the network tier:
Server mode's per-keystroke round trip, and per-connection ("circuit")
state on the server that has to be held for the client's lifetime — the
resync question here is its reconnect story. Its never-reused event
handler ids are the reason this design's node ids are not reused.

**Phoenix LiveView.** The wire is statics-plus-dynamics: a template's
static parts are sent once under a fingerprint, then only changed hole
values. That is `register-template` + `set-text` / `set-attribute` over a
socket, and it has carried real applications for years. It also
demonstrates that a network-tier producer manages without imperative
`preventDefault` (option C alone), and that a template-hole protocol
beats sending HTML fragments even when the client morphs HTML for other
paths.

**Hotwire Turbo Streams / Datastar / htmx out-of-band swaps** are the
same idea at HTML-fragment granularity: `append | prepend | replace |
update | remove | before | after` against a DOM id. Coarser, same verbs.

### DOM protocols that exist as protocols

**Chrome DevTools Protocol, `DOM` domain.** `nodeId` / `backendNodeId`,
`setAttributeValue`, `removeNode`, `setOuterHTML`, and
`childNodeInserted` / `attributeModified` events: a versioned,
schema-described, id-addressed DOM mutation protocol, read-dominant in
practice (Puppeteer, Playwright). Its node-id lifetime rules — ids
invalidated on navigation, children fetched lazily by depth — are the
reference for what a `reset` has to invalidate.

**WHATWG `MutationObserver`** defines the platform's own delta shape for
a DOM. This protocol is a command stream, not an observer, but its
structural core is kept isomorphic to `MutationRecord` (see
Architecture) so recording and replay are trivial.

### Ancestors outside the browser

Listed for shape only; this protocol's authority is the browser DOM.
**Wayland** (client-allocated ids, batched requests applied atomically at
`commit`, events on the same socket) is the same shape with a display
server in place of a DOM. **React Native's old bridge**
(`UIManager.createView` / `updateView` / `manageChildren`, batched, async)
and *why Fabric replaced it* — layout reads and event latency across an
async boundary — is the cautionary tale for the network tier; Blazor
Server hit the same wall. **Emscripten `PROXY_TO_PTHREAD`** and
OffscreenCanvas are the "wasm off the main thread queues its DOM calls"
precedent inside the wasm world itself.

## Prior measurements worth knowing

From polyengine-dioxus's bench (one runtime, Dioxus's op mix; treat as
order-of-magnitude):

- Typed WIT ops vs a hand-rolled byte protocol: after runtime lift caching
  landed upstream, ~0.7–0.8 µs/op overhead on string-heavy ops, ~0.15 µs/op
  on single-field variants; 1.1–1.8x on the channel, which is itself a
  small fraction of DOM work. Earlier figures (5 µs/op) were an interpreter
  bug, not the component model. A byte protocol is what this design now
  ships; the typed figures are what it declined to pay.
- Stream vs synchronous call transport: bulk-op deltas within noise. The
  call transport was retired for a semantic reason — no host-retained
  handle, so background guest work could not wake the instance between
  events — not for performance.

## Borrowed from polyengine-dioxus, and what stays behind

Kept (ideas, re-expressed): string interning; template arena with
receiver-side validation; typed event payload families chosen host-side;
synthetic `mounted` / `resize` / `visible`; `borrow<dom-event>` with
imperative `prevent-default`; the dispatch gate for reentrant host
imports; push hydration; digest-checked package versioning; returning the
stream from `run` so the channel's lifecycle is structural; the finding
that a host-retained stream end is what keeps a parked scheduler from
looking like a deadlock.

Left behind: the stack machine (`push-root`, `m` counts, path ops relative
to stack top); Dioxus `ElementId` slab semantics as protocol semantics;
host-decided attribute-vs-property; `hydrate` as an ordered id list whose
node lookup is implicit in the receiver's marker walk (replaced by explicit
per-node `bind-marker`); the `WriteMutations` trait as the vocabulary's
definition.

## Open questions

1. **Drain-within-one-task.** Does the embedding resume a writer's fiber
   synchronously on partial-write completion, so a same-thread receiver can
   apply a whole batch without a rendering opportunity? Decides whether
   receivers ever need to buffer until `commit`.
2. **Option A backpressure hazard.** How often is a producer instance under
   backpressure when a DOM event arrives, with a stackful scheduler? If
   "essentially never", A + C is settled.
3. **Islands.** Custom elements as sketched above; remaining: the
   `custom` payload family, a structured property value for props, and a
   generic `call-method` query (also what remote-dom interop needs).
4. **Coalescer window and index.** K and the key shape. Template and
   binding ops (`register-template`, `clone-template`, `bind-path`,
   `bind-marker`) are definitions, kept like `intern` unless the root they
   define under is removed inside the window.
5. **Resync.** `reset` semantics and whether a full snapshot is a special
   batch or the normal initial-mount batch replayed. Also the id-space
   exhaustion path, since ids are never reused.
6. **Codec tiers.** Whether the pbf hybrid decode is needed at all, or
   generated readers are fast enough: measure both on the corpus before
   writing the hand-switch. Whether generated TypeScript types (ts-proto,
   protobuf-es) are worth a second toolchain beside pbf.
7. **Conformance corpus.** Recorded length-delimited `Frame` streams
   (`.pb`) plus the event payloads that answer them, as the shared test
   vector across adapters × transports; readable with stock protobuf
   tooling; first thing to build. Seed the edge cases from rrweb's list
   (`<input>` value vs attribute, `<textarea>` content, `<select>`
   selection, adjacent text nodes, `<canvas>`, shadow roots).
8. **First producer.** Leptos (tachys `Renderer`) if its renderer is still
   pluggable in current releases, else Sycamore; Dioxus as the diffing
   counterpart. A fine-grained first producer exercises templates,
   `bind-path` and small-batch coalescing, which a VDOM producer would not.
9. **Shadow DOM and CSSOM.** No `attach-shadow`, no `adoptedStyleSheets`,
   no `insertRule`. Lit and every web-component framework need the first
   two; rrweb and remote-dom both added shadow-root support after
   shipping without it. Probably a shadow root as an insertable
   pseudo-node with its own id, and a stylesheet as a registered resource.
10. **Trust model.** The stream can create `<script>`, set `on*`
    attributes, `javascript:` hrefs and `innerHTML`. If a producer is ever
    third-party (a plugin), the receiver needs an allowlist — which is a
    transformer, and remote-dom's reason for existing. Decide whether the
    producer is trusted by definition or whether a `sanitize` transformer
    is part of the reference set.
11. **View-transition batches.** A receiver must call
    `document.startViewTransition` before the first mutation of a batch
    that should animate, so the producer has to say so at the batch start.
    Most batches are not transitions, so a rare `batch-hint` op emitted
    only for non-default batches costs nothing on the common path and does
    not reintroduce a per-batch frame. Producers will ask (React
    `<ViewTransition>`, Svelte and Vue navigation hooks); design it when
    one does.
12. **Measure remote-dom's wire before citing its cost.** The record says
    remote-dom's format (per-node JSON, subtree-atomic inserts, no
    templates or interning) is too slow for whole-app rendering. Nobody has
    measured it: run js-framework-benchmark's mount and update through
    `DOMRemoteReceiver` across a worker. If it holds up, the case for this
    protocol's own wire rests on hydration, streaming with backpressure,
    namespaces, imperative `preventDefault` and the wasm-native path —
    sufficient, but the record should then say so instead of leaning on
    mount cost.
