// Transcodes stream-dom frames into Shopify remote-dom `RemoteMutationRecord`s
// — the receiver-side interop shim docs/design.md's "Interop with
// remote-dom" describes ("A `frames -> RemoteMutationRecord[]` shim ...
// lets a wasm-native producer render into any host that already speaks
// remote-dom. It is also the bring-up receiver"). Field/record shapes are
// `@remote-dom/core`'s (constants.ts, types.ts), read directly rather than
// re-declared.

import {
  MUTATION_TYPE_INSERT_CHILD,
  MUTATION_TYPE_REMOVE_CHILD,
  MUTATION_TYPE_UPDATE_PROPERTY,
  MUTATION_TYPE_UPDATE_TEXT,
  NODE_TYPE_COMMENT,
  NODE_TYPE_ELEMENT,
  NODE_TYPE_TEXT,
  ROOT_ID,
  UPDATE_PROPERTY_TYPE_ATTRIBUTE,
  UPDATE_PROPERTY_TYPE_PROPERTY,
} from "@remote-dom/core";
import type {
  RemoteConnection,
  RemoteMutationRecord,
  RemoteNodeSerialization,
} from "@remote-dom/core";

import type {
  FrameSink,
  Listener,
  ListenerTarget,
  PropertyValue,
  TemplateNode,
} from "./frames.ts";

/** A node in the producer's shadow tree — this transcoder's own bookkeeping,
 * independent of remote-dom's id space. Every shadow node gets a `rid`
 * (remote id) at creation; the producer's node id only ever maps IN to a
 * shadow node (`RemoteDomTranscoder`'s `#byProducerId`), never the other
 * way, since several producer ids can share no shadow node but a shadow
 * node has exactly one rid. */
interface ShadowNode {
  rid: string;
  kind: "element" | "text" | "comment";
  tag: string;
  ns: string | undefined;
  attrs: Map<string, string>;
  props: Map<string, unknown>;
  text: string;
  parent: ShadowNode | null;
  children: ShadowNode[];
  attached: boolean;
}

/** Registered listeners for one target (a node, or a global singleton),
 * keyed by the interned event-name ref (`Listener.name`) so add/remove
 * find the same entry. */
type ListenerMap = Map<number, Listener>;

/** `ListenerTarget` narrowed to its two global cases, and the key
 * `#globalListeners` uses for them — the two are not the "global" oneof
 * case number, just this class's own bookkeeping key. */
type GlobalKind = "window" | "document";

/** A registered template: the flat arena plus its declared root indices,
 * as `register-template` sent them (docs/design.md "Templates are core,
 * not an extension": "an arena, not HTML"). */
interface Template {
  nodes: TemplateNode[];
  roots: number[];
}

function rootShadow(): ShadowNode {
  return {
    rid: ROOT_ID,
    kind: "element",
    tag: "",
    ns: undefined,
    attrs: new Map(),
    props: new Map(),
    text: "",
    parent: null,
    children: [],
    attached: true,
  };
}

/** Turns `FrameSink` calls into `RemoteMutationRecord[]`, committed to a
 * `RemoteConnection` at `commit()`. See docs/design.md "Interop with
 * remote-dom" for the shim's job and the two acknowledged gaps
 * (function-valued properties, open-ended `call`) that do not apply on the
 * receiver side.
 *
 * Listeners are deliberately NOT remote-dom event-listener properties: read
 * `DOMRemoteReceiver.ts`'s `updateRemoteProperty`
 * (UPDATE_PROPERTY_TYPE_EVENT_LISTENER case) — its handler drops any event
 * whose `event.target !== element`, on the assumption that remote-dom's own
 * *producer* re-dispatches per-target in its sandboxed document. This
 * protocol has no such producer-side redispatch (`docs/design.md`
 * "Events": "bubbling events are delegated at the mount root"), so a
 * listener registered on an ancestor would never fire for a descendant's
 * event under that handler. Instead `add-listener`/`remove-listener`
 * populate a listener registry below, and `mount.ts` does real delegation
 * once nodes exist (`pendingAttach`/`pendingDetach`, resolved after
 * `commit`).
 */
export class RemoteDomTranscoder implements FrameSink {
  #connection: RemoteConnection;
  #strings = new Map<number, string>();
  #byProducerId = new Map<number, ShadowNode>();
  #templates = new Map<number, Template>();
  #ridCounter = 0;
  #records: RemoteMutationRecord[] = [];
  #nodeListeners = new Map<number, ListenerMap>();
  #globalListeners = new Map<GlobalKind, ListenerMap>();
  /** Listener adds/removes captured this batch, drained by `mount.ts`'s
   * `onCommit` hook after `commit()`'s `mutate` call (nodes only exist in
   * the real DOM once `mutate` has run — globals need no such wait, but
   * are queued the same way for one code path). */
  pendingAttach: Array<{ target: ListenerTarget; listener: Listener }> = [];
  pendingDetach: Array<{ target: ListenerTarget; listener: Listener }> = [];
  onCommit: (() => void) | undefined;

  constructor(connection: RemoteConnection) {
    this.#connection = connection;
    const root = rootShadow();
    this.#byProducerId.set(0, root);
  }

  #nextRid(): string {
    return String(this.#ridCounter++);
  }

  #resolve(id: number): ShadowNode {
    const node = this.#byProducerId.get(id);
    if (!node) throw new Error(`stream-dom: unknown node id ${id}`);
    return node;
  }

  #str(ref: number): string {
    return this.#strings.get(ref) ?? "";
  }

  /** The remote id (`RemoteMutationRecord`/`DOMRemoteReceiver` id space)
   * for a producer node id, for `mount.ts`'s `resolveNode` (looked up via
   * the receiver's `call` option — see class doc). */
  ridFor(id: number): string | undefined {
    return this.#byProducerId.get(id)?.rid;
  }

  // -- interning / creation (shadow-only; nothing to emit yet) -----------

  internString(id: number, s: string): void {
    this.#strings.set(id, s);
  }

  createElement(id: number, tag: number, ns: number | undefined): void {
    this.#byProducerId.set(id, {
      rid: this.#nextRid(),
      kind: "element",
      tag: this.#str(tag),
      ns: ns === undefined ? undefined : this.#str(ns),
      attrs: new Map(),
      props: new Map(),
      text: "",
      parent: null,
      children: [],
      attached: false,
    });
  }

  createText(id: number, text: string): void {
    this.#byProducerId.set(id, {
      rid: this.#nextRid(),
      kind: "text",
      tag: "",
      ns: undefined,
      attrs: new Map(),
      props: new Map(),
      text,
      parent: null,
      children: [],
      attached: false,
    });
  }

  createPlaceholder(id: number): void {
    this.#byProducerId.set(id, {
      rid: this.#nextRid(),
      kind: "comment",
      tag: "",
      ns: undefined,
      attrs: new Map(),
      props: new Map(),
      text: "",
      parent: null,
      children: [],
      attached: false,
    });
  }

  // -- serialization (subtree -> RemoteNodeSerialization) ----------------

  #serialize(node: ShadowNode): RemoteNodeSerialization {
    if (node.kind === "text") {
      return { id: node.rid, type: NODE_TYPE_TEXT, data: node.text };
    }
    if (node.kind === "comment") {
      return { id: node.rid, type: NODE_TYPE_COMMENT, data: node.text };
    }
    const attributes: Record<string, string> = {};
    for (const [k, v] of node.attrs) attributes[k] = v;
    const properties: Record<string, unknown> = {};
    for (const [k, v] of node.props) properties[k] = v;
    return {
      id: node.rid,
      type: NODE_TYPE_ELEMENT,
      element: node.tag,
      attributes,
      properties,
      children: node.children.map((c) => this.#serialize(c)),
    };
  }

  /** Mark `node` and its whole shadow subtree attached (after an
   * INSERT_CHILD that made `node` reachable from an attached ancestor). */
  #markAttached(node: ShadowNode): void {
    node.attached = true;
    for (const c of node.children) this.#markAttached(c);
  }

  /** Mark `node` and its whole shadow subtree detached (after it was moved
   * out from under an attached ancestor to a detached one — see
   * `insertBefore`). The real DOM node is gone (a `REMOVE_CHILD` was
   * emitted for it); if this subtree attaches again later it must
   * re-serialize in full rather than being treated as already known. */
  #markDetached(node: ShadowNode): void {
    node.attached = false;
    for (const c of node.children) this.#markDetached(c);
  }

  // -- tree ops -----------------------------------------------------------

  /** Resolve the parent for `insertBefore`/`insertAfter`, per the proto's
   * presence rule (proto/stream-dom.proto `InsertBefore`/`InsertAfter`
   * doc): `parent` is required without an `anchor` and optional with one
   * (the anchor's CURRENT shadow parent is then implied, as in the DOM);
   * a frame with neither is a protocol error. When both are given and the
   * anchor already has a shadow parent that differs from the explicit
   * one, that is a producer bug — thrown, not silently resolved either
   * way. */
  #resolveInsertParent(
    opName: string,
    parentId: number | undefined,
    anchorId: number | undefined,
  ): ShadowNode {
    if (parentId === undefined && anchorId === undefined) {
      throw new Error(`stream-dom: ${opName} has neither parent nor anchor`);
    }
    if (parentId !== undefined) {
      const explicit = this.#resolve(parentId);
      if (anchorId !== undefined) {
        const anchor = this.#resolve(anchorId);
        if (anchor.parent && anchor.parent !== explicit) {
          throw new Error(
            `stream-dom: ${opName} parent ${parentId} disagrees with anchor ${anchorId}'s current parent`,
          );
        }
      }
      return explicit;
    }
    // `parentId` is undefined here, so the first check guarantees
    // `anchorId` is defined.
    const anchor = this.#resolve(anchorId!);
    if (!anchor.parent) {
      throw new Error(
        `stream-dom: ${opName} anchor ${anchorId} has no parent to imply (parent was omitted)`,
      );
    }
    return anchor.parent;
  }

  /** Shared move/attach/detach bookkeeping for `insertBefore` and
   * `insertAfter` — the ~40 lines both ops need beyond computing WHERE the
   * node lands, which is the only thing that differs between them.
   *
   * `recordIndex` is the position for the wire record, computed by the
   * caller BEFORE any detaching (matches DOMRemoteReceiver reading
   * `parent.childNodes[index]` before the move happens, i.e. against the
   * CURRENT pre-move DOM). `shadowIndexOf` is called AFTER `node` has been
   * spliced out of its old shadow parent (if any) and must recompute the
   * insertion point from whatever anchor the caller cares about: a same-
   * parent move shifts every later index down by one once the moved node
   * is removed, so reusing `recordIndex` for the shadow (rather than
   * re-deriving it post-detach) would land the shadow one slot off from
   * what the emitted record actually does to the real DOM (this is what
   * B1 fixed for insert-before; insert-after's same-parent move needs the
   * identical treatment). */
  #insertAt(
    parent: ShadowNode,
    node: ShadowNode,
    recordIndex: number,
    shadowIndexOf: () => number,
  ): void {
    const wasAttached = node.attached;
    const oldParent = node.parent;
    // The old parent's index for a REMOVE_CHILD, if this move detaches an
    // attached node from an attached old parent (see below) — captured
    // before splicing the node out.
    let oldIndexIfAttached = -1;
    if (oldParent) {
      const siblings = oldParent.children;
      const oldIdx = siblings.indexOf(node);
      if (wasAttached && oldParent.attached) oldIndexIfAttached = oldIdx;
      siblings.splice(oldIdx, 1);
    }
    node.parent = parent;

    const shadowIndex = shadowIndexOf();
    parent.children.splice(shadowIndex, 0, node);

    if (!parent.attached) {
      // The new parent is detached. If the node was attached under its
      // OLD (necessarily attached, by the attached-implies-ancestor-
      // attached invariant) parent, it just left the real DOM: tell the
      // receiver, and mark the whole subtree detached so it re-serializes
      // in full if it is ever attached again.
      if (wasAttached && oldParent && oldIndexIfAttached !== -1) {
        this.#records.push([
          MUTATION_TYPE_REMOVE_CHILD,
          oldParent.rid,
          oldIndexIfAttached,
        ]);
        this.#markDetached(node);
      }
      return;
    }

    if (wasAttached) {
      // A move: INSERT_CHILD with an already-known id is exactly
      // DOMRemoteReceiver's move path (`attach` returns the existing node).
      this.#records.push([
        MUTATION_TYPE_INSERT_CHILD,
        parent.rid,
        { id: node.rid } as unknown as RemoteNodeSerialization,
        recordIndex,
      ]);
    } else {
      this.#markAttached(node);
      this.#records.push([
        MUTATION_TYPE_INSERT_CHILD,
        parent.rid,
        this.#serialize(node),
        recordIndex,
      ]);
    }
  }

  insertBefore(
    parentId: number | undefined,
    id: number,
    anchorId: number | undefined,
  ): void {
    // "anchor === id stays a no-op" — inserting a node before itself names
    // no real change of position.
    if (anchorId === id) return;

    const parent = this.#resolveInsertParent(
      "insert-before",
      parentId,
      anchorId,
    );
    const node = this.#resolve(id);

    // Index against the shadow BEFORE detaching — matches
    // DOMRemoteReceiver's `parent.insertBefore(attach(child),
    // parent.childNodes[index] || null)`, which reads `childNodes[index]`
    // before the move happens, i.e. against the CURRENT (pre-move) DOM.
    const anchorIndexBeforeDetach = (aid: number): number => {
      const idx = parent.children.indexOf(this.#resolve(aid));
      if (idx === -1) {
        throw new Error(
          `stream-dom: insert-before anchor ${aid} is not a child of the resolved parent`,
        );
      }
      return idx;
    };
    const recordIndex = anchorId === undefined
      ? parent.children.length
      : anchorIndexBeforeDetach(anchorId);

    this.#insertAt(
      parent,
      node,
      recordIndex,
      () =>
        anchorId === undefined
          ? parent.children.length
          : parent.children.indexOf(this.#resolve(anchorId)),
    );
  }

  insertAfter(
    parentId: number | undefined,
    id: number,
    anchorId: number,
  ): void {
    // Symmetric with insert-before's "anchor === id" no-op: inserting a
    // node after itself names no real change of position.
    if (anchorId === id) return;

    const parent = this.#resolveInsertParent(
      "insert-after",
      parentId,
      anchorId,
    );
    const node = this.#resolve(id);
    const anchor = this.#resolve(anchorId);

    const anchorIndexBeforeDetach = parent.children.indexOf(anchor);
    if (anchorIndexBeforeDetach === -1) {
      throw new Error(
        `stream-dom: insert-after anchor ${anchorId} is not a child of the resolved parent`,
      );
    }
    const recordIndex = anchorIndexBeforeDetach + 1;

    this.#insertAt(
      parent,
      node,
      recordIndex,
      () => parent.children.indexOf(anchor) + 1,
    );
  }

  remove(id: number): void {
    const node = this.#resolve(id);
    const parent = node.parent;
    if (parent && node.attached) {
      const index = parent.children.indexOf(node);
      this.#records.push([MUTATION_TYPE_REMOVE_CHILD, parent.rid, index]);
    }
    if (parent) parent.children.splice(parent.children.indexOf(node), 1);
    node.parent = null;
    this.#forgetSubtree(node);
  }

  /** Drop `node` and its descendants from the id map — ids are never
   * reused (docs/design.md), so forgetting is safe. */
  #forgetSubtree(node: ShadowNode): void {
    for (const [pid, n] of this.#byProducerId) {
      if (n === node) this.#byProducerId.delete(pid);
    }
    for (const c of node.children) this.#forgetSubtree(c);
  }

  // -- leaf ops -------------------------------------------------------------

  setText(id: number, text: string): void {
    const node = this.#resolve(id);
    node.text = text;
    if (node.attached) {
      this.#records.push([MUTATION_TYPE_UPDATE_TEXT, node.rid, text]);
    }
  }

  setAttribute(
    id: number,
    name: number,
    ns: number | undefined,
    value: string | undefined,
  ): void {
    // remote-dom has no setAttributeNS equivalent (UPDATE_PROPERTY_TYPE_ATTRIBUTE
    // -> plain `setAttribute`/`removeAttribute` in DOMRemoteReceiver.ts).
    // Applied as a plain attribute; SVG/XML-namespaced attributes will not
    // render correctly through this bring-up receiver. Known remote-dom
    // gap (docs/design.md open question 9 territory), not fixed here.
    void ns;
    const attrName = this.#str(name);
    const node = this.#resolve(id);
    if (value === undefined) node.attrs.delete(attrName);
    else node.attrs.set(attrName, value);
    if (node.attached) {
      this.#records.push([
        MUTATION_TYPE_UPDATE_PROPERTY,
        node.rid,
        attrName,
        value ?? null,
        UPDATE_PROPERTY_TYPE_ATTRIBUTE,
      ]);
    }
  }

  setProperty(id: number, name: number, value: PropertyValue): void {
    const propName = this.#str(name);
    const node = this.#resolve(id);
    // An absent value "deletes / sets undefined" (proto SetProperty). On
    // the DOM that must be `null`, not `undefined`: the string-typed
    // properties a producer resets this way (`value`, `innerHTML`) are
    // [LegacyNullToEmptyString], so `null` yields "" while `undefined`
    // yields the string "undefined"; booleans coerce `null` to false.
    if (value.kind === "none") node.props.delete(propName);
    else node.props.set(propName, value.value);
    if (node.attached) {
      this.#records.push([
        MUTATION_TYPE_UPDATE_PROPERTY,
        node.rid,
        propName,
        value.kind === "none" ? null : value.value,
        UPDATE_PROPERTY_TYPE_PROPERTY,
      ]);
    }
  }

  // -- listeners: recorded, not remote-dom properties (see class doc) -----

  addListener(listener: Listener): void {
    const map = this.#listenersFor(listener.target);
    map.set(listener.name, listener);
    this.pendingAttach.push({ target: listener.target, listener });
  }

  removeListener(listener: Listener): void {
    const map = this.#existingListenersFor(listener.target);
    map?.delete(listener.name);
    this.pendingDetach.push({ target: listener.target, listener });
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

  // -- templates ------------------------------------------------------------

  registerTemplate(id: number, nodes: TemplateNode[], roots: number[]): void {
    // Validate the arena before storing it: range and acyclicity, since a
    // receiver "validates the index graph (range, acyclicity) rather than
    // trust it" (docs/design.md "Templates are core, not an extension").
    const referenced = new Set<number>();
    for (const n of nodes) {
      if (n.kind !== "element") continue;
      for (const c of n.element.children) {
        if (c < 0 || c >= nodes.length) {
          throw new Error(
            `stream-dom: template ${id} child index ${c} out of range`,
          );
        }
        if (referenced.has(c)) {
          throw new Error(
            `stream-dom: template ${id} node ${c} referenced more than once`,
          );
        }
        referenced.add(c);
      }
    }
    for (const r of roots) {
      if (r < 0 || r >= nodes.length) {
        throw new Error(
          `stream-dom: template ${id} root index ${r} out of range`,
        );
      }
    }
    // Acyclicity: walk from EVERY node index, not just the declared roots —
    // a cycle in a subgraph unreachable from any root would otherwise pass
    // validation here and then loop forever the moment anything (a future
    // op, a bug in a later root's subtree) reaches it. `visited` is global
    // across the whole scan so a node already found acyclic via one
    // starting point does not get walked again from another.
    const visiting = new Set<number>();
    const visited = new Set<number>();
    const visit = (idx: number): void => {
      if (visiting.has(idx)) {
        throw new Error(`stream-dom: template ${id} is cyclic at node ${idx}`);
      }
      if (visited.has(idx)) return;
      visiting.add(idx);
      const n = nodes[idx];
      if (n.kind === "element") {
        for (const c of n.element.children) {
          visit(c);
        }
      }
      visiting.delete(idx);
      visited.add(idx);
    };
    for (let idx = 0; idx < nodes.length; idx++) visit(idx);

    this.#templates.set(id, { nodes, roots });
  }

  cloneTemplate(tmpl: number, root: number, id: number): void {
    const template = this.#templates.get(tmpl);
    if (!template) {
      throw new Error(`stream-dom: clone-template of unknown template ${tmpl}`);
    }
    // `root` is the ORDINAL into `RegisterTemplate.roots` (proto:
    // "Deep-clone template `tmpl`'s root NUMBER `root`" — the Dioxus
    // adapter passes its own `root_idx`), not a direct index into `nodes`.
    // `roots[root]` was already range-checked against `nodes` at
    // `registerTemplate` time.
    if (root < 0 || root >= template.roots.length) {
      throw new Error(
        `stream-dom: clone-template root ordinal ${root} out of range for template ${tmpl} (has ${template.roots.length} root(s))`,
      );
    }
    const rootNodeIndex = template.roots[root];
    const clone = (idx: number): ShadowNode => {
      const n = template.nodes[idx];
      if (n.kind === "text") {
        return {
          rid: this.#nextRid(),
          kind: "text",
          tag: "",
          ns: undefined,
          attrs: new Map(),
          props: new Map(),
          text: n.text,
          parent: null,
          children: [],
          attached: false,
        };
      }
      if (n.kind === "dynamic") {
        // Clones as a placeholder to insert-before against (docs/design.md
        // "Templates are core, not an extension": "clones as a placeholder
        // to InsertBefore against").
        return {
          rid: this.#nextRid(),
          kind: "comment",
          tag: "",
          ns: undefined,
          attrs: new Map(),
          props: new Map(),
          text: "",
          parent: null,
          children: [],
          attached: false,
        };
      }
      const attrs = new Map<string, string>();
      for (const a of n.element.attrs) attrs.set(this.#str(a.name), a.value);
      const shadow: ShadowNode = {
        rid: this.#nextRid(),
        kind: "element",
        tag: this.#str(n.element.tag),
        ns: n.element.ns === undefined ? undefined : this.#str(n.element.ns),
        attrs,
        props: new Map(),
        text: "",
        parent: null,
        children: [],
        attached: false,
      };
      for (const childIdx of n.element.children) {
        const child = clone(childIdx);
        child.parent = shadow;
        shadow.children.push(child);
      }
      return shadow;
    };
    this.#byProducerId.set(id, clone(rootNodeIndex));
  }

  bindPath(root: number, path: Uint8Array, id: number): void {
    let node = this.#resolve(root);
    for (const step of path) {
      const next = node.children[step];
      if (!next) {
        throw new Error(
          `stream-dom: bind-path from root ${root} walked off the template at step ${step}`,
        );
      }
      node = next;
    }
    this.#byProducerId.set(id, node);
  }

  bindMarker(_key: number, _id: number): void {
    throw new Error("hydration is not supported by this receiver");
  }

  /** The interned string for a `str-ref`, for `mount.ts`'s delegation
   * bookkeeping (native DOM listener names, which are strings, keyed by
   * the same interned refs `Listener.name` carries). */
  stringFor(ref: number): string {
    return this.#str(ref);
  }

  /** The reverse of `internString`: the ref a string was interned under,
   * for resolving a native event name back to the ref a `Listener`
   * registered with (`mount.ts`'s delegated dispatch). A linear scan —
   * called once per dispatched native event, not on any per-op hot path. */
  refFor(s: string): number | undefined {
    for (const [ref, str] of this.#strings) if (str === s) return ref;
    return undefined;
  }

  /** Whether `id` has a registered listener for `nameRef`, and the
   * `Listener` itself (its declarative flags) — `mount.ts`'s delegated
   * dispatch walk uses this to find the nearest ancestor with a
   * registration. */
  listenerFor(id: number, nameRef: number): Listener | undefined {
    return this.#nodeListeners.get(id)?.get(nameRef);
  }

  // -- commit ---------------------------------------------------------------

  commit(): void {
    if (this.#records.length > 0) {
      this.#connection.mutate(this.#records);
      this.#records = [];
    }
    this.onCommit?.();
  }
}
