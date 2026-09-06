// The DOM-side driver: everything a `polymorph:stream-dom` receiver needs
// that does NOT require a wasm component instance — backend selection,
// the policy seam, frame decoding, dispatch-gate bracketing of byte
// application, event listener delegation/attach/detach, synthetic
// navigation, event payload encoding, and the policy-gated `queries`
// implementations. `mount.ts` is a thin component-glue layer over this:
// it builds a `Driver`, wires its `handleEvent` callback to the guest's
// `handle-event` export, and feeds it bytes off the mutation stream.
//
// Governing docs: docs/design.md "Architecture" ("a receiver running
// outside any component ... is a first-class implementation of the
// protocol, not an emulation" — this module is what makes that true),
// "Events" (delegation, declarative flags, synthetic navigation), "Policy"
// (the seam; abort semantics). wit/stream-dom.wit for the `queries` shapes.

import { DispatchGate } from "./dispatch.ts";
import { encodePayload } from "./events.ts";
import { FrameDecoder } from "./frames.ts";
import type { Listener, ListenerTarget } from "./frames.ts";
import { NativeDomReceiver } from "./native.ts";
import { assertPolicyVersion, PolicySink } from "./policy.ts";
import type { Policy } from "./policy.ts";
import { createRemoteReceiver } from "./remote.ts";
import type { Receiver } from "./receiver.ts";

/** WIT `queries.point`. */
export interface Point {
  x: number;
  y: number;
}
/** WIT `queries.size`. */
export interface Size {
  width: number;
  height: number;
}
/** WIT `queries.rect` — nested record, `{ origin: point, size: size }`. */
export interface Rect {
  origin: Point;
  size: Size;
}

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

/** wit `event-target` (wit/stream-dom.wit `types.event-target`), the shape
 * `handle-event`'s `target` param lowers as (embedder-api.md "Value
 * mapping": a payload-carrying variant case is `{ kind, value }`, a
 * payload-less one is `{ kind }` with `value` absent). Built from a
 * `ListenerTarget` (frames.ts's own decode of `Listener.target`) at
 * dispatch time. Named `ProducerEventTarget` (not `EventTarget`) because
 * the DOM already has a global `EventTarget`. */
export type ProducerEventTarget =
  | { kind: "node"; value: number }
  | { kind: "window" }
  | { kind: "document" };

function witTarget(target: ListenerTarget): ProducerEventTarget {
  return target.kind === "node"
    ? { kind: "node", value: target.id }
    : { kind: target.kind };
}

export interface DriverOptions {
  root: Element;
  /** Which DOM backend applies frames (docs/design.md "Spike"): `"native"`
   * (default) writes straight to real nodes; `"remote"` replays into
   * Shopify remote-dom's `DOMRemoteReceiver` (the original bring-up
   * receiver — kept for comparison and for hosts that already speak
   * remote-dom). */
  receiver?: "native" | "remote";
  /** Host vocabulary policy (policy.ts): it sees each vocabulary-bearing
   * op with interned strings resolved and may reject it. Present also
   * means STRICT decoding — wire content this receiver does not know is
   * rejected instead of skipped, so the protocol growing cannot widen
   * what a policy never reviewed. `createDriver` throws synchronously if
   * the policy pins a different `PROTOCOL_VERSION`. */
  policy?: Policy;
  /** Asset handle -> URL, for `SetAttribute`/`TemplateAttr` asset values
   * (proto: the producer never names a URL itself). Required if the stream
   * ever carries one; absent + an asset value is an error on the normal
   * abort path. */
  resolveAsset?(handle: Uint8Array): string;
  /** Asynchronous failure after mount: a dispatch-gate error (a
   * `handleEvent` call rejecting or throwing synchronously). Policy
   * rejections and strict-decode errors surface synchronously out of
   * `push` instead — see `Driver.push`. */
  onError?(err: unknown): void;
  /** Refuse real navigation out of the mount by default: every `submit`
   * is `preventDefault()`-ed, and every `click` on an `<a href>` whose
   * `href` is not a same-document fragment (`#...`) is too — installed
   * as two root-level, capture-phase, non-passive listeners regardless
   * of whether the producer registered anything at all (docs/design.md
   * "Events", option C: "a per-event-type default policy at the
   * receiver ... a registered `submit` listener implies preventDefault;
   * a `click` listener on `<a href>` likewise"). This is deliberately
   * BROADER than that phrasing: an unlistened `<form>`/`<a href>` is the
   * dangerous case (real submit, real navigation, with no producer
   * listener in the way to have its declarative flag inspected at all),
   * so the receiver refuses by default rather than only when a listener
   * happens to be registered. Off by default: the in-page polyengine
   * mount uses option A (imperative `prevent-default`) and must keep
   * today's behavior; a desktop/remote embedding with no imperative path
   * sets this true so a `Dioxus`-style producer emitting no declarative
   * flags at all (docs/design.md "Spike") does not submit every form and
   * navigate every link for real. */
  defaultPreventDefault?: boolean;
  /** Deliver one event to the producer. `target`/`nameRef`/`payload` are
   * exactly what `handle-event` takes; `ev` is the live native Event, lent
   * for the synchronous prefix (the component glue wraps it in the WIT
   * `dom-event` resource; a port-based consumer cannot forward it and
   * relies on the declarative flags). Runs inside the dispatch gate. */
  handleEvent(
    target: ProducerEventTarget,
    nameRef: number,
    payload: Uint8Array,
    ev: Event,
  ): unknown;
}

export interface Driver {
  /** Apply stream bytes: gate-bracketed decode; counts stats. Throws on
   * protocol violation, on a strict-decode rejection, and on a
   * `PolicyError` — the caller must then stop feeding and dispose. A
   * no-op after `dispose()`. */
  push(bytes: Uint8Array): void;
  /** WIT `queries` implementations, policy-gated. */
  readonly queries: {
    getClientRect(target: number): Rect | undefined;
    getScrollOffset(target: number): Point | undefined;
    getScrollSize(target: number): Size | undefined;
    setFocus(target: number, focus: boolean): boolean;
  };
  readonly stats: { batches: number; frames: number; bytes: number };
  /** Resolves after the NEXT `onCommit` finishes — including this
   * module's own listener attach/detach bookkeeping, not just the
   * backend's own op application. */
  nextCommit(): Promise<void>;
  /** Listeners torn down, receiver disposed. Idempotent. */
  dispose(): void;
}

/**
 * Build a `Driver` over `opts.root`: the requested `Receiver` backend, the
 * policy seam, and delegated event dispatch — with no dependency on a wasm
 * component instance.
 */
export function createDriver(opts: DriverOptions): Driver {
  // Before anything else: a policy written against another protocol
  // version has not reviewed what this receiver would now accept.
  const policy = opts.policy;
  if (policy) assertPolicyVersion(policy);

  let disposed = false;
  const onError = opts.onError ?? (() => {});
  const gate = new DispatchGate(onError);

  const receiver: Receiver = opts.receiver === "remote"
    ? createRemoteReceiver(opts.root, opts.resolveAsset)
    : new NativeDomReceiver(opts.root, opts.resolveAsset);

  const stats = { batches: 0, frames: 0, bytes: 0 };
  let commitWaiters: Array<() => void> = [];
  function nextCommit(): Promise<void> {
    return new Promise((resolve) => commitWaiters.push(resolve));
  }

  /** Real DOM node -> producer node id, for walking a native event's
   * bubble path back to a registered listener. Populated only when a
   * listener is actually attached to a node (`receiver.onCommit` below) —
   * there is no minting fallback: a node with no entry here can hold no
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
    if (policy?.query && !policy.query("get-client-rect")) return undefined;
    const node = receiver.resolveNode(target) as ElementLike | undefined;
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
    if (policy?.query && !policy.query("get-scroll-offset")) return undefined;
    const node = receiver.resolveNode(target) as ElementLike | undefined;
    if (!node || !isNum(node.scrollLeft) || !isNum(node.scrollTop)) {
      return undefined;
    }
    return { x: node.scrollLeft, y: node.scrollTop };
  }

  function getScrollSize(target: number): Size | undefined {
    if (policy?.query && !policy.query("get-scroll-size")) return undefined;
    const node = receiver.resolveNode(target) as ElementLike | undefined;
    if (!node || !isNum(node.scrollWidth) || !isNum(node.scrollHeight)) {
      return undefined;
    }
    return { width: node.scrollWidth, height: node.scrollHeight };
  }

  function setFocus(target: number, focus: boolean): boolean {
    if (policy?.query && !policy.query("set-focus")) return false;
    const node = receiver.resolveNode(target) as ElementLike | undefined;
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

  // -- default preventDefault (docs/design.md "Events", option C's
  // per-event-type default; see `DriverOptions.defaultPreventDefault`'s
  // doc for why this is two unconditional root-level listeners rather
  // than a check inside `fire`) -------------------------------------------
  //
  // Capture phase and explicitly non-passive: registered once, at
  // construction, on `opts.root` itself, so neither the passive-listener
  // "preventDefault is a no-op" hazard nor the delegated-listener refcount
  // bookkeeping above ever comes into it — this fires (and can call
  // `preventDefault`) before ANY producer-registered listener, delegated
  // or direct, sees the event at all.

  function defaultSubmitHandler(e: Event): void {
    e.preventDefault();
  }

  function defaultClickHandler(e: Event): void {
    let node: Node | null = e.target as Node | null;
    while (node) {
      if (node.nodeType === 1) {
        const el = node as Element;
        if (el.tagName.toUpperCase() === "A" && el.hasAttribute("href")) {
          if (!(el.getAttribute("href") ?? "").startsWith("#")) {
            e.preventDefault();
          }
          break;
        }
      }
      if (node === opts.root) break;
      node = node.parentNode;
    }
  }

  if (opts.defaultPreventDefault) {
    opts.root.addEventListener("submit", defaultSubmitHandler, {
      capture: true,
      passive: false,
    });
    opts.root.addEventListener("click", defaultClickHandler, {
      capture: true,
      passive: false,
    });
  }

  // -- event delegation -------------------------------------------------------
  //
  // Bubbling listeners are delegated at `root`: one native listener per
  // event name, refcounted across registrations. Non-bubbling listeners
  // attach directly to the element (docs/design.md "Events": "Delegation:
  // bubbling events are delegated at the mount root; non-bubbling ones are
  // attached per element").

  function fire(
    target: ProducerEventTarget,
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
    if (disposed) return;
    const payload = encodePayload(name, ev);
    gate.dispatch(() => opts.handleEvent(target, nameRef, payload, ev));
  }

  function dispatchDelegated(name: string, ev: Event): void {
    const nameRef = receiver.listeners.refFor(name);
    if (nameRef === undefined) return;
    let node: Node | null = ev.target as Node | null;
    while (node) {
      const id = nodeToId.get(node);
      if (id !== undefined) {
        const listener = receiver.listeners.listenerFor(id, nameRef);
        if (listener) {
          fire({ kind: "node", value: id }, nameRef, name, ev, listener);
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
     * `passive: false`. */
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
    const name = receiver.listeners.stringFor(listener.name);
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
    const name = receiver.listeners.stringFor(listener.name);
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
  /** Non-delegated listeners: per-node ones (non-bubbling `Listener`s) and
   * global ones (`window`/`document` — "always attached directly,
   * regardless of `bubbles`", docs/design.md "Global listeners"), keyed by
   * the real `EventTarget` — `Node`, `Window` and `Document` all satisfy
   * that interface uniformly, so one map and one pair of functions serve
   * both. */
  const directListeners = new Map<EventTarget, Map<number, DirectEntry>>();

  function attachDirectListener(
    target: EventTarget,
    witTgt: ProducerEventTarget,
    name: string,
    listener: Listener,
  ): void {
    let byName = directListeners.get(target);
    if (!byName) {
      byName = new Map();
      directListeners.set(target, byName);
    }
    if (byName.has(listener.name)) return;
    const handler = (e: Event) =>
      fire(witTgt, listener.name, name, e, listener);
    byName.set(listener.name, { handler, capture: listener.capture });
    target.addEventListener(name, handler, {
      capture: listener.capture,
      passive: listener.passive,
    });
  }

  function detachDirectListener(target: EventTarget, listener: Listener): void {
    const byName = directListeners.get(target);
    const entry = byName?.get(listener.name);
    if (!entry) return;
    const name = receiver.listeners.stringFor(listener.name);
    target.removeEventListener(name, entry.handler, {
      capture: entry.capture,
    });
    byName!.delete(listener.name);
  }

  /** Dispatch the synthetic initial-navigation event (docs/design.md
   * "Global listeners" territory): a `window` listener for
   * `hashchange`/`popstate` fires once, right after it is attached, with
   * the CURRENT `location.href` — the producer has no `location` to read
   * at mount, so without this a deep link renders the default route until
   * the first real navigation. Mirrors the synthetic `mounted` event's
   * "once per registration" contract. */
  function dispatchSyntheticNavigation(name: string, listener: Listener): void {
    fire({ kind: "window" }, listener.name, name, new Event(name), listener);
  }

  // Nodes only exist for `resolveNode` once the backend has applied the
  // batch, so listener attach/detach happens in the `onCommit` hook,
  // after (both backends fire it at the same point — see receiver.ts).
  receiver.onCommit = () => {
    // An entry whose node does not resolve yet (e.g. a listener add-op
    // that landed in the same batch as the insert, ordered before it, or
    // a node briefly unreachable via the receiver's `call`) is carried
    // over to the NEXT `onCommit` rather than dropped — dropping it would
    // permanently lose that registration even once the node exists. Only
    // node targets can miss this way; `window`/`document` always resolve.
    const stillPending: Array<{ target: ListenerTarget; listener: Listener }> =
      [];
    for (const entry of receiver.listeners.pendingAttach) {
      const { target, listener } = entry;
      if (target.kind === "node") {
        const node = receiver.resolveNode(target.id);
        if (!node) {
          stillPending.push(entry);
          continue;
        }
        nodeToId.set(node, target.id);
        if (listener.bubbles) {
          ensureRootListener(listener);
        } else {
          const name = receiver.listeners.stringFor(listener.name);
          attachDirectListener(node, witTarget(target), name, listener);
        }
        continue;
      }
      // Global: always attached directly, regardless of `bubbles`
      // (proto/stream-dom.proto Listener doc, docs/design.md "Global
      // listeners").
      const globalObj = target.kind === "window" ? window : document;
      const name = receiver.listeners.stringFor(listener.name);
      attachDirectListener(globalObj, witTarget(target), name, listener);
      if (
        target.kind === "window" &&
        (name === "hashchange" || name === "popstate")
      ) {
        dispatchSyntheticNavigation(name, listener);
      }
    }
    receiver.listeners.pendingAttach.length = 0;
    receiver.listeners.pendingAttach.push(...stillPending);

    for (const { target, listener } of receiver.listeners.pendingDetach) {
      if (target.kind === "node") {
        if (listener.bubbles) {
          releaseRootListener(listener);
        } else {
          const node = receiver.resolveNode(target.id);
          if (node) detachDirectListener(node, listener);
        }
        continue;
      }
      const globalObj = target.kind === "window" ? window : document;
      detachDirectListener(globalObj, listener);
    }
    receiver.listeners.pendingDetach.length = 0;

    stats.batches++;
    const waiters = commitWaiters;
    commitWaiters = [];
    for (const w of waiters) w();
  };

  // -- bytes in ---------------------------------------------------------------

  // With a policy: ops reach the backend only if `PolicySink` forwards
  // them, and the decoder rejects unknown wire content rather than
  // skipping it (a wrapper alone would fail OPEN as the protocol grows —
  // docs/design.md "Policy").
  const decoder = policy
    ? new FrameDecoder(new PolicySink(receiver.sink, policy), { strict: true })
    : new FrameDecoder(receiver.sink);

  function push(bytes: Uint8Array): void {
    if (disposed) return; // no-op after dispose — see `Driver.push`'s doc.
    gate.beginApply();
    try {
      stats.bytes += bytes.length;
      decoder.push(bytes);
      stats.frames = decoder.frameCount;
    } finally {
      gate.endApply();
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    gate.dispose();
    if (opts.defaultPreventDefault) {
      opts.root.removeEventListener("submit", defaultSubmitHandler, {
        capture: true,
      });
      opts.root.removeEventListener("click", defaultClickHandler, {
        capture: true,
      });
    }
    for (const entry of rootListeners.values()) {
      opts.root.removeEventListener(entry.name, entry.handler, {
        capture: entry.capture,
      });
    }
    rootListeners.clear();
    // Global listeners (window/document) are never delegated, so they need
    // their own teardown here — unlike per-node direct listeners, which
    // die with their (already-detached-or-GC'd) nodes.
    for (const globalObj of [window, document] as const) {
      const byName = directListeners.get(globalObj);
      if (!byName) continue;
      for (const [nameRef, entry] of byName) {
        globalObj.removeEventListener(
          receiver.listeners.stringFor(nameRef),
          entry.handler,
          { capture: entry.capture },
        );
      }
      directListeners.delete(globalObj);
    }
    receiver.dispose();
  }

  return {
    push,
    queries: { getClientRect, getScrollOffset, getScrollSize, setFocus },
    stats,
    nextCommit,
    dispose,
  };
}
