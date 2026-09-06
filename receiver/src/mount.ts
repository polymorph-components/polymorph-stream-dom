// Host glue: instantiates a `polymorph:stream-dom` producer component,
// reads its mutation stream through `RemoteDomTranscoder` into a
// `DOMRemoteReceiver`, and dispatches DOM events back through
// `handle-event`. Governing docs: wit/stream-dom.wit (world `producer`),
// docs/design.md "Events" (delegation, declarative flags) and
// contracts/embedder-api.md "Module wiring and instantiation" / "Streams
// and futures" (cited inline as `contract:<section>`).

import { instantiate } from "@polyengine/runtime/embedder";
import type { InstantiateSource } from "@polyengine/runtime/embedder";
import type { Stream } from "@polyengine/protocol";
import { wasi } from "@polyengine/wasi";
import { DOMRemoteReceiver } from "@remote-dom/core/receivers";

import { DispatchGate } from "./dispatch.ts";
import { encodePayload } from "./events.ts";
import { FrameDecoder } from "./frames.ts";
import type { Listener } from "./frames.ts";
import { RemoteDomTranscoder } from "./remote.ts";

export interface MountOptions {
  /** Component artifacts, passed through verbatim to `instantiate`
   * (contract:"Module wiring and instantiation"). */
  source: InstantiateSource;
  root: Element;
  /** Asynchronous failure after mount: the mutation stream's read session
   * rejecting, or a `handle-event` call rejecting. */
  onError?(err: unknown): void;
}

export interface Mounted {
  dispose(): void;
}

/** WIT `queries.point`. */
interface Point {
  x: number;
  y: number;
}
/** WIT `queries.size`. */
interface Size {
  width: number;
  height: number;
}
/** WIT `queries.rect` — nested record, `{ origin: point, size: size }`. */
interface Rect {
  origin: Point;
  size: Size;
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

/** Sentinel method name for the `DOMRemoteReceiver` `call` trick
 * (`DOMRemoteReceiver`'s constructor `call` option — receivers/
 * DOMRemoteReceiver.ts — receives the real `Element` for an id and either
 * dispatches a method on it or, as used here, hands it straight back):
 * asking for this "method" returns the element itself rather than
 * invoking anything on it. */
const NODE_CALL = "__stream_dom_node";

type ElementLike = Element & {
  scrollLeft?: number;
  scrollTop?: number;
  scrollWidth?: number;
  scrollHeight?: number;
  getBoundingClientRect?: () => {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  focus?: () => void;
  blur?: () => void;
};

function isNum(v: unknown): v is number {
  return typeof v === "number";
}

/**
 * Mount a `polymorph:stream-dom` producer component into `opts.root`.
 *
 * Builds a `DOMRemoteReceiver` over the root, a `RemoteDomTranscoder` as
 * the frame sink, instantiates the component with `queries`/`events`
 * imports wired per contracts/embedder-api.md "Module wiring and
 * instantiation" (imports keyed by the verbatim interface id), reads the
 * mutation stream `run` returns, and delegates DOM events back into
 * `handle-event`.
 */
export async function mount(opts: MountOptions): Promise<Mounted> {
  let disposed = false;
  const onError = opts.onError ?? (() => {});
  const gate = new DispatchGate(onError);

  const receiver = new DOMRemoteReceiver({
    root: opts.root,
    call: (element, method, ...args) =>
      method === NODE_CALL
        ? element
        : (element as unknown as Record<string, (...a: unknown[]) => unknown>)
          [method](...args),
  });

  const transcoder = new RemoteDomTranscoder(receiver.connection);

  function resolveNode(id: number): Node | undefined {
    const rid = transcoder.ridFor(id);
    if (rid === undefined) return undefined;
    try {
      return receiver.connection.call(rid, NODE_CALL) as Node;
    } catch {
      return undefined; // Not yet attached in the real DOM.
    }
  }

  /** Real DOM node -> producer node id, for walking a native event's
   * bubble path back to a registered listener. Populated only when a
   * listener is actually attached to a node (`transcoder.onCommit` below)
   * — there is no minting fallback: a node with no entry here can hold no
   * `listenerFor` match either, since every registration goes through the
   * same attach step. */
  const nodeToId = new WeakMap<Node, number>();

  // -- queries --------------------------------------------------------------
  //
  // `setFocus` fires focusin/focusout synchronously (wit doc,
  // docs/design.md "Reentrancy"), so its body is bracketed with the gate:
  // a dispatch raised from inside queues and drains once this call
  // (itself running inside the guest's turn — a host import invoked BY the
  // guest) unwinds. The read queries fire nothing and need no bracket.

  function getClientRect(target: number): Rect | undefined {
    const node = resolveNode(target) as ElementLike | undefined;
    if (!node || typeof node.getBoundingClientRect !== "function") {
      return undefined;
    }
    const r = node.getBoundingClientRect();
    return {
      origin: { x: r.x, y: r.y },
      size: { width: r.width, height: r.height },
    };
  }

  function getScrollOffset(target: number): Point | undefined {
    const node = resolveNode(target) as ElementLike | undefined;
    if (!node || !isNum(node.scrollLeft) || !isNum(node.scrollTop)) {
      return undefined;
    }
    return { x: node.scrollLeft, y: node.scrollTop };
  }

  function getScrollSize(target: number): Size | undefined {
    const node = resolveNode(target) as ElementLike | undefined;
    if (!node || !isNum(node.scrollWidth) || !isNum(node.scrollHeight)) {
      return undefined;
    }
    return { width: node.scrollWidth, height: node.scrollHeight };
  }

  function setFocus(target: number, focus: boolean): boolean {
    const node = resolveNode(target) as ElementLike | undefined;
    const fn = focus ? node?.focus : node?.blur;
    if (typeof fn !== "function") return false;
    gate.beginApply();
    try {
      fn.call(node);
      return true;
    } finally {
      gate.endApply();
    }
  }

  // -- event delegation -------------------------------------------------------
  //
  // Bubbling listeners are delegated at `root`: one native listener per
  // event name, refcounted across registrations. Non-bubbling listeners
  // attach directly to the element (docs/design.md "Events": "Delegation:
  // bubbling events are delegated at the mount root; non-bubbling ones are
  // attached per element").

  // Populated once, after `instantiate()` below; a mutable field on a
  // `const` holder (rather than a reassigned `let`) so `fire` can close
  // over it before it exists.
  const exports_: { handleEvent?: (...a: unknown[]) => unknown } = {};

  function fire(
    id: number,
    nameRef: number,
    name: string,
    ev: Event,
    listener: Listener,
  ): void {
    // Declarative flags (docs/design.md "Events", option C): honored
    // unconditionally, before the guest is entered, since a remote
    // receiver could not wait for a round trip either.
    if (listener.preventDefault) ev.preventDefault();
    if (listener.stopPropagation) ev.stopPropagation();
    if (!exports_.handleEvent || disposed) return;
    const payload = encodePayload(name, ev);
    const domEvent = new DomEvent(ev);
    gate.dispatch(() => exports_.handleEvent!(id, nameRef, payload, domEvent));
  }

  function dispatchDelegated(name: string, ev: Event): void {
    const nameRef = transcoder.refFor(name);
    if (nameRef === undefined) return;
    let node: Node | null = ev.target as Node | null;
    while (node) {
      const id = nodeToId.get(node);
      if (id !== undefined) {
        const listener = transcoder.listenerFor(id, nameRef);
        if (listener) {
          fire(id, nameRef, name, ev, listener);
          return;
        }
      }
      if (node === opts.root) return;
      node = node.parentNode;
    }
  }

  /** One entry per distinct `(name, capture)` pair currently delegated at
   * the root. Keyed by a compound string rather than a nested map: the
   * pair is what native `addEventListener`/`removeEventListener` actually
   * distinguish (two listeners for the same name differing only in
   * `capture` are NOT the same registration), so it is what has to be
   * refcounted and removed together. `capture` and the currently-
   * registered `passive` flag are stored on the entry (not re-derived from
   * whichever `Listener` happens to be passed to `release`/`dispose`), so
   * removal always targets the exact registration this module made. */
  interface RootEntry {
    name: string;
    refcount: number;
    /** How many current registrants for this key are NON-passive — used
     * to decide whether the native listener must be (or must become)
     * `passive: false` (see B7 below). */
    nonPassiveCount: number;
    capture: boolean;
    passive: boolean;
    handler: (e: Event) => void;
  }
  const rootListeners = new Map<string, RootEntry>();

  function rootKey(name: string, capture: boolean): string {
    return `${name}\u0000${capture}`;
  }

  function ensureRootListener(listener: Listener): void {
    const name = transcoder.stringFor(listener.name);
    const key = rootKey(name, listener.capture);
    let entry = rootListeners.get(key);
    if (!entry) {
      const handler = (e: Event) => dispatchDelegated(name, e);
      // The FIRST registrant for this (name, capture) pair decides the
      // initial `passive` value; a later non-passive registrant upgrades
      // it below rather than being silently ignored (a shared passive
      // native listener would make that registrant's `preventDefault()`
      // a no-op — the bug this entry-per-key, upgrade-on-demand scheme
      // exists to avoid).
      entry = {
        name,
        refcount: 0,
        nonPassiveCount: 0,
        capture: listener.capture,
        passive: listener.passive,
        handler,
      };
      rootListeners.set(key, entry);
      opts.root.addEventListener(name, handler, {
        capture: entry.capture,
        passive: entry.passive,
      });
    }
    entry.refcount++;
    if (!listener.passive) {
      entry.nonPassiveCount++;
      if (entry.passive) {
        // Crossing 0 -> 1 non-passive registrants while the native
        // listener is still registered passive: re-register non-passive
        // so this (and every other) registrant's `preventDefault()` is
        // honored by the browser.
        opts.root.removeEventListener(name, entry.handler, {
          capture: entry.capture,
        });
        entry.passive = false;
        opts.root.addEventListener(name, entry.handler, {
          capture: entry.capture,
          passive: false,
        });
      }
    }
  }

  function releaseRootListener(listener: Listener): void {
    const name = transcoder.stringFor(listener.name);
    const key = rootKey(name, listener.capture);
    const entry = rootListeners.get(key);
    if (!entry) return;
    entry.refcount--;
    if (!listener.passive) entry.nonPassiveCount--;
    if (entry.refcount <= 0) {
      opts.root.removeEventListener(name, entry.handler, {
        capture: entry.capture,
      });
      rootListeners.delete(key);
    }
  }

  interface DirectEntry {
    handler: (e: Event) => void;
    capture: boolean;
  }
  const directListeners = new Map<Node, Map<number, DirectEntry>>();

  function attachDirectListener(
    node: Node,
    id: number,
    listener: Listener,
  ): void {
    let byName = directListeners.get(node);
    if (!byName) {
      byName = new Map();
      directListeners.set(node, byName);
    }
    if (byName.has(listener.name)) return;
    const name = transcoder.stringFor(listener.name);
    const handler = (e: Event) => fire(id, listener.name, name, e, listener);
    byName.set(listener.name, { handler, capture: listener.capture });
    (node as Element).addEventListener(name, handler, {
      capture: listener.capture,
      passive: listener.passive,
    });
  }

  function detachDirectListener(node: Node, listener: Listener): void {
    const byName = directListeners.get(node);
    const entry = byName?.get(listener.name);
    if (!entry) return;
    const name = transcoder.stringFor(listener.name);
    (node as Element).removeEventListener(name, entry.handler, {
      capture: entry.capture,
    });
    byName!.delete(listener.name);
  }

  // Nodes only exist in the real DOM once `commit()`'s `mutate` call has
  // run, so listener attach/detach happens in the `onCommit` hook, after.
  transcoder.onCommit = () => {
    // An entry whose node does not resolve yet (e.g. a listener add-op
    // that landed in the same batch as the insert, ordered before it, or
    // a node briefly unreachable via the receiver's `call`) is carried
    // over to the NEXT `onCommit` rather than dropped — dropping it would
    // permanently lose that registration even once the node exists.
    const stillPending: Array<{ id: number; listener: Listener }> = [];
    for (const entry of transcoder.pendingAttach) {
      const { id, listener } = entry;
      const node = resolveNode(id);
      if (!node) {
        stillPending.push(entry);
        continue;
      }
      nodeToId.set(node, id);
      if (listener.bubbles) ensureRootListener(listener);
      else attachDirectListener(node, id, listener);
    }
    transcoder.pendingAttach.length = 0;
    transcoder.pendingAttach.push(...stillPending);

    for (const { id, listener } of transcoder.pendingDetach) {
      if (listener.bubbles) {
        releaseRootListener(listener);
      } else {
        const node = resolveNode(id);
        if (node) detachDirectListener(node, listener);
      }
    }
    transcoder.pendingDetach.length = 0;
  };

  // -- instantiation + mutation stream ----------------------------------------

  const imports = {
    // wasip2 components import wasi:cli/io/clocks/random/filesystem
    // whether or not the app calls them.
    ...wasi(),
    "polymorph:stream-dom/queries@0.1.0": {
      getClientRect,
      getScrollOffset,
      getScrollSize,
      setFocus,
    },
    "polymorph:stream-dom/events@0.1.0": { DomEvent },
  };

  const instance = await instantiate(opts.source, imports);
  exports_.handleEvent = instance.exports.handleEvent as (
    ...a: unknown[]
  ) => unknown;

  const stream = await (instance.exports.run as (
    hydrate: boolean,
  ) => Promise<Stream<number>>)(false);

  const decoder = new FrameDecoder(transcoder);

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    gate.dispose();
    for (const entry of rootListeners.values()) {
      opts.root.removeEventListener(entry.name, entry.handler, {
        capture: entry.capture,
      });
    }
    rootListeners.clear();
    stream.drop();
    receiver.disconnect();
  }

  // Direct-access byte edge (contract:"Streams and futures", "Direct-access
  // byte edges"): `consume` runs synchronously inside the rendezvous with a
  // view over the writer's unread bytes; `decoder.push` copies what it
  // keeps before `markRead` releases the view. One producer write is
  // normally one whole batch, so this callback normally applies one batch;
  // wrapped in the dispatch gate because DOM mutation can fire synchronous
  // events (e.g. a removed, focused input firing `blur`).
  const readLoop = stream.readDirect((src) => {
    gate.beginApply();
    try {
      const view = src.remaining();
      decoder.push(view);
      src.markRead(view.length);
    } finally {
      gate.endApply();
    }
    return "more";
  });
  readLoop.catch((err: unknown) => {
    if (disposed) return;
    onError(err);
    // A thrown/rejected `consume` leaves the guest's write parked forever
    // if nothing ever drops the stream's read end — dispose so the guest
    // observes reader-gone on its next write instead of hanging.
    dispose();
  });

  return { dispose };
}
