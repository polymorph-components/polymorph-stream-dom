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
import { DOMRemoteReceiver } from "@remote-dom/core/receivers";

import type {
  AttrValue,
  FrameSink,
  Listener,
  PropertyValue,
  TemplateNode,
  TextControlState,
} from "./frames.ts";
import type { Receiver } from "./receiver.ts";
import { ListenerRegistry } from "./receiver.ts";
import { validateTemplateArena } from "./templates.ts";

/** A node in the producer's shadow tree — this transcoder's own bookkeeping,
 * independent of remote-dom's id space. Every shadow node gets a `rid`
 * (remote id) at creation; the producer's node id only ever maps IN to a
 * shadow node (`RemoteDomTranscoder`'s `#byProducerId`), never the other
 * way, since several producer ids can share no shadow node but a shadow
 * node has exactly one rid. `ids` is the reverse of that map's entries
 * FOR THIS NODE — usually one id, but `bind-path` can alias a second (or
 * more) producer id onto the same interior template node — so that
 * `remove` can forget a whole subtree's ids in O(subtree size) by walking
 * `children`/`ids` directly, instead of scanning every entry in
 * `#byProducerId` per removed node (see `#forgetSubtree`). */
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
  ids: number[];
  textControlState?: TextControlState;
}

type PendingRecord =
  | { kind: "remote"; record: RemoteMutationRecord; applied?: () => void }
  | { kind: "text-control"; node: ShadowNode; state: TextControlState };

const SELECTION_INPUT_TYPES = new Set([
  "text",
  "search",
  "tel",
  "url",
  "password",
]);
const KNOWN_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "date",
  "datetime-local",
  "email",
  "file",
  "hidden",
  "image",
  "month",
  "number",
  "password",
  "radio",
  "range",
  "reset",
  "search",
  "submit",
  "tel",
  "text",
  "time",
  "url",
  "week",
]);

function effectiveInputType(node: ShadowNode): string {
  const raw = node.props.has("type")
    ? node.props.get("type")
    : node.attrs.get("type");
  const type = String(raw ?? "text").toLowerCase();
  return KNOWN_INPUT_TYPES.has(type) ? type : "text";
}

/** A registered template: the flat arena plus its declared root indices,
 * as `register-template` sent them (docs/design.md "Templates are core,
 * not an extension": "an arena, not HTML"). */
interface Template {
  nodes: TemplateNode[];
  roots: number[];
  /** Every string an element node in the arena names, resolved ONCE at
   * `registerTemplate` time, per arena node index (`undefined` for
   * non-element nodes). Interned slots can be overwritten (proto `Intern`:
   * "Define (or overwrite) interned slot"), so resolving these per clone
   * instead would let a re-intern between registration and clone stamp out
   * a different element than the one registered — and under a policy, a
   * different one than the policy approved (`PolicySink` judges templates
   * with the strings current at registration). Asset handles resolve here
   * too: once per template, not once per clone. */
  resolved: (ResolvedElement | undefined)[];
}

/** One arena element node with all of its refs already resolved. */
interface ResolvedElement {
  tag: string;
  ns: string | undefined;
  /** `[name, value]` in the node's own `attrs` order. */
  attrs: [string, string][];
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
    ids: [],
    textControlState: undefined,
  };
}

/** Sentinel method name for the `DOMRemoteReceiver` `call` trick
 * (`DOMRemoteReceiver`'s constructor `call` option — receivers/
 * DOMRemoteReceiver.ts — receives the real `Element` for an id and either
 * dispatches a method on it or, as used here, hands it straight back):
 * asking for this "method" returns the element itself rather than
 * invoking anything on it. Used by `resolveNode`. */
const NODE_CALL = "__stream_dom_node";

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
 * populate `this.listeners` (a `ListenerRegistry`, shared with
 * `NativeDomReceiver`), and `mount.ts` does real delegation once nodes
 * exist (`listeners.pendingAttach`/`pendingDetach`, resolved after
 * `commit`).
 *
 * Constructed two ways: `createRemoteReceiver(root)` (the production path
 * — owns a fresh `DOMRemoteReceiver` over `root`) or `new
 * RemoteDomTranscoder(connection)` directly with a bare `RemoteConnection`
 * (what the unit tests use: `DOMRemoteReceiver.attach()` calls
 * `document.createElement`, unavailable under bare Deno, so tests that
 * only care about the shadow-tree/record-emission logic supply a fake
 * `RemoteConnection` and never touch a real `DOMRemoteReceiver`).
 */
export class RemoteDomTranscoder implements Receiver, FrameSink {
  #connection: RemoteConnection;
  #domReceiver: DOMRemoteReceiver | null;
  #byProducerId = new Map<number, ShadowNode>();
  #templates = new Map<number, Template>();
  #ridCounter = 0;
  #resolveAsset: ((handle: Uint8Array) => string) | undefined;
  #pending: PendingRecord[] = [];
  readonly listeners: ListenerRegistry = new ListenerRegistry();
  onCommit: (() => void) | null = null;

  constructor(
    connection: RemoteConnection,
    domReceiver: DOMRemoteReceiver | null = null,
    resolveAsset?: (handle: Uint8Array) => string,
  ) {
    this.#connection = connection;
    this.#domReceiver = domReceiver;
    this.#resolveAsset = resolveAsset;
    this.#bind(0, rootShadow());
  }

  /** Register `id -> node` in `#byProducerId` AND record `id` on the node
   * itself (`ShadowNode.ids`), so `#forgetSubtree` can undo exactly this
   * later without scanning the whole map. Every place that binds a
   * producer id to a shadow node goes through this — `createElement`/
   * `createText`/`createPlaceholder`, `cloneTemplate`'s root, and
   * `bindPath` (which aliases a second id onto an already-bound node). */
  #bind(id: number, node: ShadowNode): void {
    this.#byProducerId.set(id, node);
    node.ids.push(id);
  }

  get sink(): FrameSink {
    return this;
  }

  resolveNode(id: number): Node | undefined {
    const rid = this.#byProducerId.get(id)?.rid;
    if (rid === undefined) return undefined;
    try {
      return this.#connection.call(rid, NODE_CALL) as Node;
    } catch {
      return undefined; // Not yet attached in the real DOM.
    }
  }

  dispose(): void {
    this.#domReceiver?.disconnect();
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
    return this.listeners.stringFor(ref);
  }

  /** The string an attribute value sets: a literal, or the URL the host's
   * `resolveAsset` hook returns for an asset handle. */
  #attrText(value: AttrValue): string {
    if (value.kind === "text") return value.value;
    if (!this.#resolveAsset) {
      throw new Error(
        "stream-dom: asset attribute value but no resolveAsset configured",
      );
    }
    return this.#resolveAsset(value.handle);
  }

  /** The remote id (`RemoteMutationRecord`/`DOMRemoteReceiver` id space)
   * for a producer node id — exposed for tests, which assert on it
   * directly rather than reaching into the real DOM. */
  ridFor(id: number): string | undefined {
    return this.#byProducerId.get(id)?.rid;
  }

  /** Total producer ids currently bound (including the mount root's `0`)
   * — exposed for tests asserting that `remove` actually released a whole
   * subtree's ids rather than merely detaching it (`#forgetSubtree`'s
   * O(subtree size) fix). */
  get idCount(): number {
    return this.#byProducerId.size;
  }

  // -- interning / creation (shadow-only; nothing to emit yet) -----------

  internString(id: number, s: string): void {
    this.listeners.internString(id, s);
  }

  createElement(id: number, tag: number, ns: number | undefined): void {
    this.#bind(id, {
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
      ids: [],
      textControlState: undefined,
    });
  }

  createText(id: number, text: string): void {
    this.#bind(id, {
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
      ids: [],
      textControlState: undefined,
    });
  }

  createPlaceholder(id: number): void {
    this.#bind(id, {
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
      ids: [],
      textControlState: undefined,
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

  #queueDetachedTextControlState(node: ShadowNode): void {
    if (node.textControlState) {
      this.#pending.push({
        kind: "text-control",
        node,
        state: node.textControlState,
      });
    }
    for (const child of node.children) {
      this.#queueDetachedTextControlState(child);
    }
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
        this.#pending.push({
          kind: "remote",
          record: [
            MUTATION_TYPE_REMOVE_CHILD,
            oldParent.rid,
            oldIndexIfAttached,
          ],
        });
        this.#markDetached(node);
      }
      return;
    }

    if (wasAttached) {
      // A move: INSERT_CHILD with an already-known id is exactly
      // DOMRemoteReceiver's move path (`attach` returns the existing node).
      this.#pending.push({
        kind: "remote",
        record: [
          MUTATION_TYPE_INSERT_CHILD,
          parent.rid,
          { id: node.rid } as unknown as RemoteNodeSerialization,
          recordIndex,
        ],
      });
    } else {
      this.#markAttached(node);
      this.#pending.push({
        kind: "remote",
        record: [
          MUTATION_TYPE_INSERT_CHILD,
          parent.rid,
          this.#serialize(node),
          recordIndex,
        ],
      });
      this.#queueDetachedTextControlState(node);
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
      this.#pending.push({
        kind: "remote",
        record: [MUTATION_TYPE_REMOVE_CHILD, parent.rid, index],
      });
    }
    if (parent) parent.children.splice(parent.children.indexOf(node), 1);
    node.parent = null;
    this.#forgetSubtree(node);
  }

  /** Drop `node` and its descendants from the id map — ids are never
   * reused (docs/design.md), so forgetting is safe. O(subtree size): each
   * node deletes exactly its own `ids` (usually one, occasionally more via
   * `bind-path` aliasing) instead of scanning `#byProducerId` for a
   * reference match — the previous version was O(ids-in-map) PER removed
   * node, i.e. O(ids × nodes) for a whole-subtree remove, which is the
   * quadratic a 10k-row clear hit. */
  #forgetSubtree(node: ShadowNode): void {
    for (const id of node.ids) this.#byProducerId.delete(id);
    node.ids.length = 0;
    for (const c of node.children) this.#forgetSubtree(c);
  }

  // -- leaf ops -------------------------------------------------------------

  setText(id: number, text: string): void {
    const node = this.#resolve(id);
    node.text = text;
    if (node.attached) {
      this.#pending.push({
        kind: "remote",
        record: [MUTATION_TYPE_UPDATE_TEXT, node.rid, text],
      });
    }
  }

  setAttribute(
    id: number,
    name: number,
    ns: number | undefined,
    value: AttrValue | undefined,
  ): void {
    // remote-dom has no setAttributeNS equivalent (UPDATE_PROPERTY_TYPE_ATTRIBUTE
    // -> plain `setAttribute`/`removeAttribute` in DOMRemoteReceiver.ts).
    // Applied as a plain attribute; SVG/XML-namespaced attributes will not
    // render correctly through this receiver — use the native receiver
    // (native.ts) for SVG.
    void ns;
    const attrName = this.#str(name);
    const node = this.#resolve(id);
    const text = value === undefined ? undefined : this.#attrText(value);
    if (text === undefined) node.attrs.delete(attrName);
    else node.attrs.set(attrName, text);
    if (node.attached) {
      this.#pending.push({
        kind: "remote",
        record: [
          MUTATION_TYPE_UPDATE_PROPERTY,
          node.rid,
          attrName,
          text ?? null,
          UPDATE_PROPERTY_TYPE_ATTRIBUTE,
        ],
      });
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
    if (!node.attached && (propName === "value" || propName === "type")) {
      node.textControlState = undefined;
    }
    if (node.attached) {
      this.#pending.push({
        kind: "remote",
        record: [
          MUTATION_TYPE_UPDATE_PROPERTY,
          node.rid,
          propName,
          value.kind === "none" ? null : value.value,
          UPDATE_PROPERTY_TYPE_PROPERTY,
        ],
        applied: propName === "value" || propName === "type"
          ? () => {
            // setTextControlState may have updated the retained value while
            // this property operation was waiting. Mirror the operation only
            // after its remote mutation applies so shadow serialization keeps
            // the same order as the DOM.
            if (value.kind === "none") node.props.delete(propName);
            else node.props.set(propName, value.value);
            node.textControlState = undefined;
          }
          : undefined,
      });
    }
  }

  setTextControlState(id: number, state: TextControlState): void {
    const shadow = this.#resolve(id);
    if (
      state.selectionStart > state.selectionEnd ||
      state.selectionEnd > state.value.length
    ) return;
    if (
      !shadow.attached && shadow.tag !== "textarea" &&
      !(shadow.tag === "input" &&
        SELECTION_INPUT_TYPES.has(effectiveInputType(shadow)))
    ) return;
    if (shadow.attached) {
      this.#pending.push({ kind: "text-control", node: shadow, state });
    } else {
      shadow.props.set("value", state.value);
      shadow.textControlState = state;
    }
  }

  // -- listeners: recorded, not remote-dom properties (see class doc) -----

  addListener(listener: Listener): void {
    this.listeners.add(listener);
  }

  removeListener(listener: Listener): void {
    this.listeners.remove(listener);
  }

  // -- templates ------------------------------------------------------------

  registerTemplate(id: number, nodes: TemplateNode[], roots: number[]): void {
    validateTemplateArena(id, nodes, roots);
    const resolved = nodes.map((n) =>
      n.kind === "element"
        ? {
          tag: this.#str(n.element.tag),
          ns: n.element.ns === undefined ? undefined : this.#str(n.element.ns),
          attrs: n.element.attrs.map((a) =>
            [this.#str(a.name), this.#attrText(a.value)] as [string, string]
          ),
        }
        : undefined
    );
    this.#templates.set(id, { nodes, roots, resolved });
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
          ids: [],
          textControlState: undefined,
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
          ids: [],
          textControlState: undefined,
        };
      }
      // Strings come from the registration-time table, never re-resolved
      // here — see `Template.resolved`.
      const el = template.resolved[idx]!;
      const shadow: ShadowNode = {
        rid: this.#nextRid(),
        kind: "element",
        tag: el.tag,
        ns: el.ns,
        attrs: new Map(el.attrs),
        props: new Map(),
        text: "",
        parent: null,
        children: [],
        attached: false,
        ids: [],
        textControlState: undefined,
      };
      for (const childIdx of n.element.children) {
        const child = clone(childIdx);
        child.parent = shadow;
        shadow.children.push(child);
      }
      return shadow;
    };
    this.#bind(id, clone(rootNodeIndex));
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
    this.#bind(id, node);
  }

  bindMarker(_key: number, _id: number): void {
    throw new Error("hydration is not supported by this receiver");
  }

  // -- commit ---------------------------------------------------------------

  commit(): void {
    const applyTextControlState = (
      shadow: ShadowNode,
      state: TextControlState,
    ) => {
      let node: HTMLInputElement | HTMLTextAreaElement | undefined;
      try {
        node = this.#connection.call(shadow.rid, NODE_CALL) as
          | HTMLInputElement
          | HTMLTextAreaElement;
      } catch {
        return;
      }
      if (
        !node ||
        (node.tagName !== "TEXTAREA" &&
          !(node.tagName === "INPUT" &&
            SELECTION_INPUT_TYPES.has((node as HTMLInputElement).type)))
      ) {
        return;
      }
      if (
        state.selectionStart > state.selectionEnd ||
        state.selectionEnd > state.value.length
      ) {
        return;
      }
      const previous = node.value;
      try {
        node.value = state.value;
        node.setSelectionRange(
          state.selectionStart,
          state.selectionEnd,
          state.direction,
        );
        shadow.props.set("value", state.value);
        shadow.textControlState = state;
      } catch {
        node.value = previous;
      }
    };
    let records: RemoteMutationRecord[] = [];
    const flushRecords = () => {
      if (records.length === 0) return;
      this.#connection.mutate(records);
      records = [];
    };
    for (const pending of this.#pending) {
      if (pending.kind === "remote") {
        records.push(pending.record);
        if (pending.applied) {
          flushRecords();
          pending.applied();
        }
      } else {
        flushRecords();
        applyTextControlState(pending.node, pending.state);
      }
    }
    flushRecords();
    this.#pending = [];
    this.onCommit?.();
  }
}

/** The production path: a `RemoteDomTranscoder` wired to a fresh
 * `DOMRemoteReceiver` over `root`. Unit tests construct
 * `RemoteDomTranscoder` directly with a fake `RemoteConnection` instead
 * (see the class doc) — this factory is what `mount.ts` calls. */
export function createRemoteReceiver(
  root: Element,
  resolveAsset?: (handle: Uint8Array) => string,
): RemoteDomTranscoder {
  const domReceiver = new DOMRemoteReceiver({
    root,
    call: (element, method, ...args) =>
      method === NODE_CALL
        ? element
        : (element as unknown as Record<string, (...a: unknown[]) => unknown>)
          [method](...args),
  });
  return new RemoteDomTranscoder(
    domReceiver.connection,
    domReceiver,
    resolveAsset,
  );
}
