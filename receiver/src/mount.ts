// Host glue: instantiates a `polymorph:stream-dom` producer component and
// wires it to a `Driver` (driver.ts), which owns everything that does NOT
// need a component instance — backend selection, policy, frame decoding,
// event delegation, `queries`. This module is only the component-specific
// remainder: `instantiate`, the `wasi()` imports, the WIT `dom-event`
// resource, calling the `run` export to get the mutation stream, the two
// read transports, calling `handle-event`, and `stream.drop()`. Governing
// docs: wit/stream-dom.wit (world `producer`), docs/design.md "Events"
// (delegation, declarative flags) and contracts/embedder-api.md "Module
// wiring and instantiation" / "Streams and futures" (cited inline as
// `contract:<section>`).

import { instantiate } from "@polyengine/runtime/embedder";
import type { InstantiateSource } from "@polyengine/runtime/embedder";
import type { Stream } from "@polyengine/protocol";
import { wasi } from "@polyengine/wasi";

import { createDriver } from "./driver.ts";
import type { Policy } from "./policy.ts";

export interface MountOptions {
  /** Component artifacts, passed through verbatim to `instantiate`
   * (contract:"Module wiring and instantiation"). */
  source: InstantiateSource;
  root: Element;
  /** Asynchronous failure after mount: the mutation stream's read session
   * rejecting, or a `handle-event` call rejecting. */
  onError?(err: unknown): void;
  /** Which DOM backend applies frames (docs/design.md "Spike"): `"native"`
   * (default) writes straight to real nodes; `"remote"` replays into
   * Shopify remote-dom's `DOMRemoteReceiver` (the original bring-up
   * receiver — kept for comparison and for hosts that already speak
   * remote-dom). */
  receiver?: "native" | "remote";
  /** How the mutation stream is read (contract:"Streams and futures"):
   * `"direct"` (default) uses `stream.readDirect`, decoding straight out
   * of a view over guest memory with no intermediate copy; `"chunked"`
   * uses the `stream.read(max)` chunk-copy loop instead (ported from
   * polyengine-dioxus host.ts:540-565) — a benchmark harness comparing
   * the two transports' overhead wants both available behind one flag. */
  transport?: "direct" | "chunked";
  /** Recording tap: called with a COPY of each chunk of stream bytes
   * consumed, in order, from the very first byte. A copy in both
   * transports — `readDirect`'s view aliases guest memory and is invalid
   * once its callback returns, so retaining it without copying would be
   * corrupt-by-construction; `chunked`'s `read()` result is already an
   * owned chunk, but copying it too keeps this callback's contract
   * uniform across transports rather than aliasing-safe in one and not
   * the other. */
  onChunk?(bytes: Uint8Array): void;
  /** Host vocabulary policy (policy.ts). Present => strict decoding plus
   * a `PolicySink` in front of the backend: the policy sees each
   * vocabulary-bearing op with interned strings resolved and may reject
   * it, and wire content this receiver does not know is rejected rather
   * than skipped. `mount` rejects synchronously if the policy pins a
   * different `PROTOCOL_VERSION`. */
  policy?: Policy;
  /** Asset handle -> URL. Required if the stream ever carries an asset
   * attribute value; absent + an asset value is an error through the
   * normal error path. */
  resolveAsset?(handle: Uint8Array): string;
}

export interface Mounted {
  dispose(): void;
  /** Running counts since mount: `batches` (commits applied — one
   * `onCommit` firing each), `frames` (Frame messages decoded, whether or
   * not they carried an op), `bytes` (stream bytes consumed, from the
   * very first byte read). */
  stats: { batches: number; frames: number; bytes: number };
  /** Resolves after the NEXT `onCommit` finishes — including this
   * module's own listener attach/detach bookkeeping, not just the
   * backend's own op application. A benchmark harness awaits this instead
   * of polling the DOM for "did the batch land yet". */
  nextCommit(): Promise<void>;
}

/** Host-implemented `events.dom-event` resource (wit/stream-dom.wit
 * `interface events`): lent to the guest for its synchronous prefix inside
 * `handle-event`. */
class DomEvent {
  #native: Event;
  constructor(native: Event) {
    this.#native = native;
  }
  preventDefault(): void {
    this.#native.preventDefault();
  }
  stopPropagation(): void {
    this.#native.stopPropagation();
  }
}

/**
 * Mount a `polymorph:stream-dom` producer component into `opts.root`.
 *
 * Builds a `Driver` over `opts.root` (driver.ts), instantiates the
 * component with `queries`/`events` imports wired per
 * contracts/embedder-api.md "Module wiring and instantiation" (imports
 * keyed by the verbatim interface id), reads the mutation stream `run`
 * returns into the driver, and delegates DOM events back into
 * `handle-event`.
 */
export async function mount(opts: MountOptions): Promise<Mounted> {
  let disposed = false;
  const onError = opts.onError ?? (() => {});

  // Populated once, after `instantiate()` below; a mutable field on a
  // `const` holder (rather than a reassigned `let`) so the driver's
  // `handleEvent` callback can close over it before it exists. `handle-
  // event` may be invoked (by a synthetic navigation dispatch during
  // `onCommit`, itself driven by the FIRST batch of stream bytes) before
  // `run`'s export even resolves — dropping the event in that case (and
  // after `dispose()`) is today's behaviour, preserved here.
  const exports_: { handleEvent?: (...a: unknown[]) => unknown } = {};

  const driver = createDriver({
    root: opts.root,
    receiver: opts.receiver,
    policy: opts.policy,
    resolveAsset: opts.resolveAsset,
    onError,
    handleEvent: (target, nameRef, payload, ev) => {
      if (!exports_.handleEvent || disposed) return;
      return exports_.handleEvent(target, nameRef, payload, new DomEvent(ev));
    },
  });

  const imports = {
    // wasip2 components import wasi:cli/io/clocks/random/filesystem
    // whether or not the app calls them.
    ...wasi(),
    "polymorph:stream-dom/queries@0.1.0": driver.queries,
    "polymorph:stream-dom/events@0.1.0": { DomEvent },
  };

  const instance = await instantiate(opts.source, imports);
  exports_.handleEvent = instance.exports.handleEvent as (
    ...a: unknown[]
  ) => unknown;

  const stream = await (instance.exports.run as (
    hydrate: boolean,
  ) => Promise<Stream<number>>)(false);

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    stream.drop();
    driver.dispose();
  }

  /** Feed `bytes` to the driver; called from both transports so the
   * tap/copy behaviour is identical either way. */
  function consume(bytes: Uint8Array): void {
    opts.onChunk?.(bytes.slice()); // a COPY — see MountOptions.onChunk's doc.
    driver.push(bytes);
  }

  if (opts.transport === "chunked") {
    // Ported from polyengine-dioxus host.ts:540-565: `stream.read(max)`
    // copies a chunk out instead of aliasing guest memory. `driver.push`
    // brackets application with the dispatch gate itself — DOM mutation
    // can still fire synchronous events (a removed, focused input firing
    // `blur`).
    const MAX_READ = 1 << 22;
    (async () => {
      while (!disposed) {
        // `Chunk<u8>` is a `Uint8Array` at runtime (embedder-api.md "Value
        // mapping": "Chunk<u8> = Uint8Array, else T[]"); the `Stream<number>`
        // type import doesn't distinguish that from any other numeric
        // stream, so the cast is just recovering what's already true.
        const chunk = await stream.read(MAX_READ) as Uint8Array;
        if (chunk.length === 0) break; // end of stream
        consume(chunk);
      }
    })().catch((err: unknown) => {
      if (disposed) return;
      onError(err);
      dispose();
    });
  } else {
    // Direct-access byte edge (contract:"Streams and futures", "Direct-
    // access byte edges"): `consume` runs synchronously inside the
    // rendezvous with a view over the writer's unread bytes; pushing it
    // into the driver copies what it keeps before `markRead` releases the
    // view. One producer write is normally one whole batch, so this
    // callback normally applies one batch; `driver.push` wraps its body in
    // the dispatch gate because DOM mutation can fire synchronous events
    // (e.g. a removed, focused input firing `blur`).
    const readLoop = stream.readDirect((src) => {
      const view = src.remaining();
      consume(view);
      src.markRead(view.length);
      return "more";
    });
    readLoop.catch((err: unknown) => {
      if (disposed) return;
      onError(err);
      // A thrown/rejected `consume` leaves the guest's write parked
      // forever if nothing ever drops the stream's read end — dispose so
      // the guest observes reader-gone on its next write instead of
      // hanging.
      dispose();
    });
  }

  return { dispose, stats: driver.stats, nextCommit: driver.nextCommit };
}
