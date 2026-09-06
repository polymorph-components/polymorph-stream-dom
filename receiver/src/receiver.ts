// The receiver seam: what `mount.ts` needs from either DOM backend
// (`remote.ts`'s `RemoteDomTranscoder`, `native.ts`'s `NativeDomReceiver`),
// and the listener bookkeeping the two share verbatim. Splitting this out
// is what lets `mount.ts` be backend-agnostic: it drives a `Receiver`
// through `sink`/`resolveNode`/`listeners`/`onCommit`/`dispose` and never
// touches `RemoteDomTranscoder` or `NativeDomReceiver` by name.

import type { FrameSink, Listener, ListenerTarget } from "./frames.ts";

/** One receiver backend: a `FrameSink` to feed decoded frames into, a way
 * to resolve a producer node id to the real DOM `Node` it landed on, the
 * shared listener registry, and an `onCommit` hook `mount.ts` uses to
 * attach/detach native listeners once nodes exist (both backends fire it
 * at the same point: after a frame's `commit` flag is honored — see
 * `FrameSink.commit`'s doc). */
export interface Receiver {
  /** Frames decode straight into this. */
  readonly sink: FrameSink;
  /** Producer node id -> real DOM node. Only guaranteed populated for a
   * given id once the commit that created it has run (both backends
   * populate it at op-application time in practice, which is at or before
   * that point — never later). */
  resolveNode(id: number): Node | undefined;
  readonly listeners: ListenerRegistry;
  onCommit: (() => void) | null;
  /** Tear down whatever this backend owns (a wrapped connection, cached
   * DOM references). Rendered DOM is left in place. */
  dispose(): void;
}

/** Registered listeners for one target (a node, or a global singleton),
 * keyed by the interned event-name ref (`Listener.name`) so add/remove
 * find the same entry. */
type ListenerMap = Map<number, Listener>;

/** `ListenerTarget` narrowed to its two global cases, and the key
 * `#globalListeners` uses for them — the two are not the `Global` oneof
 * case's own numeric value, just this class's own bookkeeping key. */
type GlobalKind = "window" | "document";

/**
 * Listener add/remove bookkeeping, plus the interned string table: both
 * backends need `str-ref -> string` for HAND-NAMED event names, and the
 * ONLY consumer of interned strings that crosses back out to `mount.ts`
 * (which is backend-agnostic and cannot reach into either transcoder's
 * private tag/attribute tables) is listener-name resolution — so the
 * string table lives here rather than as a second copy per backend.
 * `internString` on each `FrameSink` implementation delegates to this
 * class's, and each backend's OWN string lookups (tag names, attribute
 * names) go through the same table via their own private helpers.
 *
 * `pendingAttach`/`pendingDetach` are drained by `mount.ts`'s `onCommit`
 * hook after the backend has applied the batch (nodes only exist for
 * `resolveNode` once that has happened).
 */
export class ListenerRegistry {
  #strings = new Map<number, string>();
  #nodeListeners = new Map<number, ListenerMap>();
  #globalListeners = new Map<GlobalKind, ListenerMap>();
  pendingAttach: Array<{ target: ListenerTarget; listener: Listener }> = [];
  pendingDetach: Array<{ target: ListenerTarget; listener: Listener }> = [];

  internString(id: number, s: string): void {
    this.#strings.set(id, s);
  }

  /** Resolve an interned slot. Throws on an unknown ref rather than
   * returning `""`: interning is define-before-use
   * (proto/stream-dom.proto: "An Intern precedes the first use of its slot
   * in the same stream"), so an unresolved ref is a malformed stream, and
   * an empty string would silently become an element with no tag name or
   * an attribute called "". Re-defining a live slot IS legal and is not
   * checked here — the proto's `Intern` reads "Define (or overwrite)
   * interned slot `id`". */
  stringFor(ref: number): string {
    const s = this.#strings.get(ref);
    if (s === undefined) {
      throw new Error(`stream-dom: unknown string ref ${ref}`);
    }
    return s;
  }

  /** The reverse of `internString`: the ref a string was interned under,
   * for resolving a native event name back to the ref a `Listener`
   * registered with (`mount.ts`'s delegated dispatch). A linear scan —
   * called once per dispatched native event, not on any per-op hot path. */
  refFor(s: string): number | undefined {
    for (const [ref, str] of this.#strings) if (str === s) return ref;
    return undefined;
  }

  add(listener: Listener): void {
    const map = this.#listenersFor(listener.target);
    map.set(listener.name, listener);
    this.pendingAttach.push({ target: listener.target, listener });
  }

  remove(listener: Listener): void {
    const map = this.#existingListenersFor(listener.target);
    map?.delete(listener.name);
    this.pendingDetach.push({ target: listener.target, listener });
  }

  /** Whether `id` has a registered listener for `nameRef`, and the
   * `Listener` itself (its declarative flags) — `mount.ts`'s delegated
   * dispatch walk uses this to find the nearest ancestor with a
   * registration. Node targets only: globals are never delegated (see
   * `mount.ts`), so nothing ever needs to look one up by walking. */
  listenerFor(id: number, nameRef: number): Listener | undefined {
    return this.#nodeListeners.get(id)?.get(nameRef);
  }

  #listenersFor(target: ListenerTarget): ListenerMap {
    if (target.kind === "node") {
      let map = this.#nodeListeners.get(target.id);
      if (!map) {
        map = new Map();
        this.#nodeListeners.set(target.id, map);
      }
      return map;
    }
    let map = this.#globalListeners.get(target.kind);
    if (!map) {
      map = new Map();
      this.#globalListeners.set(target.kind, map);
    }
    return map;
  }

  #existingListenersFor(target: ListenerTarget): ListenerMap | undefined {
    return target.kind === "node"
      ? this.#nodeListeners.get(target.id)
      : this.#globalListeners.get(target.kind);
  }
}
