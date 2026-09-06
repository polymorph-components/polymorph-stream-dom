# polymorph:vdom — design record

Status: design stage. Nothing here is implemented. This document records
decisions and their reasons so that later work argues with the reasons
rather than re-deriving them; it is not a specification. The WIT under
`wit/` is a draft of the same decisions in schema form.

## Purpose

A framework-neutral protocol for streaming DOM mutations from a renderer
(a "producer": React, Vue, Solid, Dioxus, Preact, ...) to something that
owns a DOM (a "receiver": a browser page, a server-side renderer, a test
recorder), across a boundary that may be a wasm component edge, a worker,
an iframe, or a network.

It is a write-side command protocol, not an observer. The web
`MutationObserver` reports what already happened to a DOM; this stream is
the receiver's *only* way to learn what to render. The close analogs are
Dioxus's `WriteMutations`, React Native's Fabric mount transactions, and
worker-dom's transferable mutations — not `MutationRecord`.

## Non-goals

- Not a native-widget protocol. The vocabulary is DOM-shaped on purpose;
  generalizing the receiver side to non-DOM trees is a different project.
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
elements, not batches. A zero-length write is a readiness probe (allowed,
not guaranteed, to wait for a pending read).

**Exclusive lock.** With sync or stackless lifting, an export call
arriving while another task holds the instance waits at the backpressure
gate, in order. A renderer's commit must not be reentered, so this is the
behavior we want for event exports; a long-lived scheduler task can be
stackful to stay out of the way.

## Architecture

```
producer adapter ──▶ stream<operation> ──▶ [transformers]* ──▶ receiver
(one per framework)                        coalesce, record,      (browser DOM,
                                           encode-for-wire,       SSR, test
                                           multiplex              recorder)
```

- Every hop carries the same element type, `operation`.
- Transformers have the shape `func(in: stream<operation>) ->
  stream<operation>` and are written once for all frameworks. Coalescing
  is the canonical one; a remote-hop encoder (`stream<operation> ->
  stream<u8>`) is another.
- The Component Model embedding is the *reference semantics*. A JS-native
  adapter (for a framework running outside any component) emulates the
  rendezvous stream — `read(n)` / `write(buf)` returning promises with the
  min-copy rule — so the conformance corpus runs unchanged against it.

## Protocol decisions

### Element type is `operation`, never `list<operation>`

A `list` element is lifted and lowered atomically: the receiver must have
room for the whole batch before the rendezvous completes, cannot accept
part of it, and — for a wasm receiver — `realloc`s the entire batch into
linear memory or OOM-traps. It also forbids any transformer from working
across batch boundaries without holding several whole batches. With
`stream<operation>`, receiver memory is a tuning knob (read buffer of K
elements), backpressure is per element, and processing may start before
production finishes.

Elements are small but not fixed-size: any op carrying a `string` lowers
through `realloc` on a wasm receiver. Interning bounds the static names;
dynamic text (`set-text`, `create-text`) is inherently variable. If
byte-bounded receiving turns out to matter, that is the argument for a
`stream<u8>` encoding as a *transformer output*, not as the core element
type — typed elements are what let anything sit in the middle.

### Batches are framed by a `commit` op, not by the transport

`commit` is a boundary signal, not a buffering instruction. Its uses:

1. After-commit work that must see the whole batch applied — synthetic
   `mounted`, refs, host-side islands.
2. Ack/coalescing granularity on a remote hop.
3. Recording and replay.

A receiver *may* buffer until `commit` to guarantee no half-applied frame;
that is receiver policy. It is only needed when the producer is slower
than a frame *and* streams as it renders. Every framework's mutation phase
is synchronous once it starts, so a producer that finishes rendering before
its first write and then drains never leaves the receiver's read parked
mid-batch. Whether a same-thread receiver can drain a whole batch inside
one browser task depends on the runtime resuming the writer's fiber
synchronously when its partial write completes. Verify in the embedding
before relying on it.

A transformer that merges batches emits one `commit`; intermediate states
that never reached the receiver never existed for it, which matches what
frameworks do internally when they batch state updates.

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
  resolving its stack). `anchor = none` is append.
- **No stack machine.** Dioxus-style `push-root` / `append-children(m)` /
  path ops relative to a stack top mean nothing without replaying the
  stack; a coalescer would have to be an interpreter. Dioxus's adapter
  resolves its stack producer-side, which is trivial.
- **Producer allocates ids** (`u32`; `0` is the mount root). Reuse after
  `remove` is safe under stream ordering. `remove` frees the whole
  subtree's ids; the producer knows the tree.
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
already has. `set-property` carries a typed value; `none` deletes.

### Interning

`intern(id: u16, s: string)` defines a slot; tags, namespaces, attribute
names, event names are `str-ref`s. Definitions precede first use in the
same stream; each definition is emitted once per producer instance. Event
names cross back on `handle-event` as the same `u16`, so steady-state event
dispatch transfers no string data. (Borrowed from polyengine-dioxus.)

### Templates are an extension, and path binding is one op

Dioxus, Solid, Svelte, Vue (`insertStaticContent`) all have static
templates; React does not. `register-template` / `clone-template` are
optional ops a producer may never emit.

WIT forbids recursive types, so a template is an arena: a flat pre-order
`list<template-node>` with `u32` indices for roots and children. The arena
admits malformed index graphs a recursive type could not express;
receivers validate rather than trust. (Borrowed from polyengine-dioxus.)

Interior nodes of a cloned template get ids via `bind-path(root, path,
id)`, a child-index walk from an explicit root. Positions are reliable
here because the producer built the tree itself. Self-contained (the root
is named, not implied by a stack), so a transformer can treat it as opaque
bookkeeping.

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
components. Shape TBD; listed under open questions.

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

Dispatch: `handle-event(target, name, payload, ev)` export. `payload` is a
typed snapshot, family chosen host-side by event name (mouse, keyboard,
form, ...), carrying everything a handler commonly reads (`target.value`,
`checked`, key, coordinates, form data on submit, `relatedTarget` as an
id). Files and drag data are resources, not copies. Two families are
synthesized by the receiver from observers rather than DOM events
(`resize`, `visible`), and `mounted` is synthetic: fired once per
registered element after the batch that created it is fully applied.
(Families and synthetics borrowed from polyengine-dioxus; contents to be
ported.)

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
Leaning A + C: A for in-process receivers, C everywhere. B is recorded in
case A's backpressure hazard proves real in practice.

## Producer seams

| Framework | Seam | Reads the DOM? | Adapter strategy |
|---|---|---|---|
| Dioxus | `WriteMutations` trait | no | direct; resolve stack ops producer-side |
| React | `react-reconciler` HostConfig | barely (hydration aside); instances opaque → return ids | direct; commit = batch; experimental API, expect churn |
| Vue | `@vue/runtime-core` `createRenderer` | `parentNode`, `nextSibling` | direct + producer-side shadow tree for structural reads |
| Solid | `solid-js/universal` `createRenderer` | `getParentNode`, `getFirstChild`, `getNextSibling` | direct + shadow tree; loses compiled-template fast path |
| Angular | `Renderer2` | `parentNode`, `nextSibling` | direct + shadow tree |
| Preact, Svelte, Lit | none — compiled/direct `document` calls | freely (`name in dom`, `.value`, `innerHTML`, `TreeWalker`) | recording fake DOM (undom/linkedom shape); documented holes |

Two strategies, both needed: *seam adapters* where a seam exists,
*recording fake DOM* where none does. The fake DOM is one adapter for
every remaining framework plus vanilla JS, and is leaky in known ways
(prop-vs-attr `in` checks need per-tag tables; template `innerHTML` needs
an HTML parser; layout reads hit a wall). worker-dom is the prior art and
its stall is informative.

Fine-grained producers (Solid) emit one op per signal. That is a good fit
for the stream and a poor fit for per-batch overhead; the coalescing
transformer, driven by backpressure and the zero-length readiness probe,
is the answer rather than a producer-side policy.

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
everywhere. Network is the one tier that differs semantically (no
synchronous verdict possible), hence option C above and a resync path.

Where frameworks run: Rust/Go/etc. producers compile natively to
components. JS frameworks either run inside a component (componentize-js;
the component-model semantics then apply uniformly) or as plain JS with
the emulated stream — for most JS frameworks the worker is the natural
home, so the JS-native path is a first-class implementation of the
protocol, not a shim.

## Prior measurements worth knowing

From polyengine-dioxus's bench (one runtime, Dioxus's op mix; treat as
order-of-magnitude):

- Typed WIT ops vs a hand-rolled byte protocol: after runtime lift caching
  landed upstream, ~0.7–0.8 µs/op overhead on string-heavy ops, ~0.15 µs/op
  on single-field variants; 1.1–1.8x on the channel, which is itself a
  small fraction of DOM work. Earlier figures (5 µs/op) were an interpreter
  bug, not the component model.
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
3. **Islands.** Shape of `mount-foreign(id, kind, props)` or equivalent;
   who owns the node's lifecycle; how events cross back.
4. **Coalescer window and index.** K and the key shape; interaction with
   `bind-path`, `bind-marker` and template ops (treat as opaque, never
   drop unless the root is removed?).
5. **Resync.** `reset` semantics and whether a full snapshot is a special
   batch or the normal initial-mount batch replayed.
6. **Byte encoding.** Whether a `stream<u8>` transformer output is needed at
   all, and if so whether its framing survives chunk boundaries cheaply.
7. **Conformance corpus format.** Recorded op streams as the shared test
   vector across adapters × transports × encodings; first thing to build.
