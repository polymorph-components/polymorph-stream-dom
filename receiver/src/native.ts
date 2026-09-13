// A native DOM receiver: applies stream-dom frames straight to real DOM
// nodes, with no shadow tree and no remote-dom in between. Lives beside
// `remote.ts`'s `RemoteDomTranscoder` (docs/design.md "Spike": "The
// remote-dom bring-up receiver works, with two receiver-side choices" —
// this is the "native" one that bring-up postponed) for what that shim
// structurally cannot do:
//
// - **Namespaces.** remote-dom's `UPDATE_PROPERTY_TYPE_ATTRIBUTE` always
//   calls plain `setAttribute`; there is no `setAttributeNS` path, so SVG
//   (and any other namespaced content) never renders correctly through
//   it. This receiver calls `createElementNS`/`setAttributeNS` directly.
// - **No string-id map.** remote-dom addresses every node by a `string`
//   id and reconstructs it host-side; this receiver's producer-id map
//   points straight at the real `Node`, so there is no id<->id
//   translation layer and no serialized-subtree object to build per
//   insert.
// - **No subtree re-serialization on attach.** `RemoteDomTranscoder` must
//   walk and serialize a whole detached subtree the moment its root
//   attaches (`RemoteMutationRecord`'s `INSERT_CHILD` carries the full
//   tree). A native node is already a real, fully-built DOM subtree the
//   instant it is created — attaching it is one `insertBefore` regardless
//   of how large the subtree is.
// - **`Node.moveBefore()`.** Available here because there is a real
//   `Node` to call it on; remote-dom's wire has no equivalent operation to
//   carry that preference across (docs/design.md "Every op is
//   addressable": "a receiver should use `Node.moveBefore()` ... where
//   available, which preserves iframe state, focus, selection and running
//   animations that `insertBefore` resets").

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

/** One compiled template: the validated arena plus one PROTOTYPE DOM
 * subtree per declared root, built once at `register-template` time.
 * `clone-template` is then `cloneNode(true)` of the matching prototype —
 * the whole point of a template being "compile the shape once, stamp it
 * out cheaply". */
interface CompiledTemplate {
  prototypes: Node[];
}

/** The mount root's producer id (proto/stream-dom.proto: "0 is the mount
 * root"). The embedder owns that node, not the producer: it is registered
 * once by the constructor and is structurally inviolable thereafter — no
 * op may create, re-register, alias, move or remove it. Leaf ops
 * (attributes, properties, text) on it stay legal protocol; denying those
 * is a policy's job, not this receiver's. */
const ROOT_ID = 0;

/** `Node.nodeType` values used for the op-target type checks below.
 * Compared numerically rather than with `instanceof Element` /
 * `instanceof CharacterData` because those constructors are not global in
 * every realm this receiver runs in (Deno's test runtime has no DOM
 * globals), and a `Node` handed in by the embedder may come from another
 * document anyway. */
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const COMMENT_NODE = 8;

/** A duck-typed `Node.moveBefore` (Chrome 133+, 2025): preserves iframe
 * state, focus, selection and running animations that `insertBefore`
 * resets, but throws under conditions `insertBefore` tolerates (crossing
 * documents, either endpoint not connected) — this receiver only calls it
 * when both endpoints are connected, matching the browser's own
 * precondition, and falls back to `insertBefore` everywhere else
 * (including "the method doesn't exist yet"). */
type MoveCapableParent = Node & {
  moveBefore?(node: Node, ref: Node | null): void;
};

/**
 * Applies `FrameSink` calls straight to a real DOM subtree rooted at
 * `root` (producer id `0`). No shadow tree: `resolveNode` is the identity
 * lookup `#nodes.get(id)`, valid immediately at creation (not just after
 * `commit`, unlike the remote-dom receiver — a native node exists for
 * real the moment it is created, attached or not).
 */
export class NativeDomReceiver implements Receiver, FrameSink {
  #doc: Document;
  #resolveAsset: ((handle: Uint8Array) => string) | undefined;
  #nodes = new Map<number, Node>();
  #ids = new WeakMap<Node, number>();
  #templates = new Map<number, CompiledTemplate>();
  readonly listeners: ListenerRegistry = new ListenerRegistry();
  onCommit: (() => void) | null = null;

  /** `resolveAsset` materializes an `AttrValue` asset handle into a URL
   * (proto `SetAttribute.asset`); without it, a stream carrying an asset
   * value is an error. */
  constructor(root: Element, resolveAsset?: (handle: Uint8Array) => string) {
    this.#doc = root.ownerDocument;
    this.#resolveAsset = resolveAsset;
    // The one binding of `ROOT_ID` that ever happens: `#register` rejects
    // it from here on.
    this.#bind(ROOT_ID, root);
  }

  get sink(): FrameSink {
    return this;
  }

  resolveNode(id: number): Node | undefined {
    return this.#nodes.get(id);
  }

  /** Nothing to tear down structurally — there is no wrapped connection,
   * just direct references into the real DOM. Rendered DOM is left in
   * place, per every `Receiver`'s contract; `mount.ts` removes the
   * listeners it attached separately. */
  dispose(): void {}

  #bind(id: number, node: Node): void {
    this.#nodes.set(id, node);
    this.#ids.set(node, id);
  }

  /** Bind a producer-allocated id to a node, rejecting everything the
   * proto's id rules forbid:
   *
   * - `ROOT_ID` — the mount root is the embedder's node, never one the
   *   producer may (re-)name.
   * - an id that is CURRENTLY registered. The proto says ids are "never
   *   reused" within a stream, but `remove` frees the subtree's nodes and
   *   this receiver keeps no record of ids it has forgotten (and ids are
   *   not required to be monotonic, so a high-water mark would reject
   *   legal streams). So the detectable half of the rule is enforced and
   *   the other half is not: re-registering a live id throws; reusing an
   *   id freed by an earlier `remove` is a protocol violation this
   *   receiver cannot see.
   * - a node that already carries an id (aliasing). Two ids for one node
   *   would make `remove` free only one of them and leave the other
   *   pointing into a detached tree; `bind-path` with an empty path onto
   *   an already-registered node is the way to ask for it.
   */
  #register(id: number, node: Node): void {
    if (id === ROOT_ID) {
      throw new Error(`stream-dom: id ${ROOT_ID} is the mount root`);
    }
    if (this.#nodes.has(id)) {
      throw new Error(`stream-dom: node id ${id} is already registered`);
    }
    const existing = this.#ids.get(node);
    if (existing !== undefined) {
      throw new Error(
        `stream-dom: node id ${id} would alias node ${existing}`,
      );
    }
    this.#bind(id, node);
  }

  #resolve(id: number): Node {
    const node = this.#nodes.get(id);
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

  /** `#resolve` plus the op's node-type precondition. Without it
   * `setAttribute` would fail with an incidental `TypeError` on a text
   * node and `setProperty` would quietly install an expando. */
  #element(opName: string, id: number): Element {
    const node = this.#resolve(id);
    if (node.nodeType !== ELEMENT_NODE) {
      throw new Error(`stream-dom: ${opName} target ${id} is not an element`);
    }
    return node as Element;
  }

  /** The mount root is not a valid target for a structural op — see
   * `ROOT_ID`. */
  #rejectRoot(opName: string, id: number): void {
    if (id === ROOT_ID) {
      throw new Error(`stream-dom: ${opName} may not target the mount root`);
    }
  }

  // -- interning / creation -------------------------------------------------

  internString(id: number, s: string): void {
    this.listeners.internString(id, s);
  }

  createElement(id: number, tag: number, ns: number | undefined): void {
    const tagName = this.#str(tag);
    const el = ns === undefined
      ? this.#doc.createElement(tagName)
      : this.#doc.createElementNS(this.#str(ns), tagName);
    this.#register(id, el);
  }

  createText(id: number, text: string): void {
    this.#register(id, this.#doc.createTextNode(text));
  }

  createPlaceholder(id: number): void {
    this.#register(id, this.#doc.createComment(""));
  }

  // -- tree ops -----------------------------------------------------------

  /** Resolve the parent for `insertBefore`/`insertAfter`, per the proto's
   * presence rule — identical contract to `RemoteDomTranscoder`'s (see
   * its doc), just checked against the LIVE DOM (`Node.parentNode`)
   * instead of a shadow tree, since there is nothing else to check
   * against here. */
  #resolveInsertParent(
    opName: string,
    parentId: number | undefined,
    anchorId: number | undefined,
  ): Node {
    // The mount root is nobody's sibling. An anchor names the node the
    // insert lands beside, so an anchor of 0 addresses the EMBEDDER's
    // container — and with `parent` omitted the container becomes the
    // implied parent silently, putting a producer node outside the mount.
    // See ROOT_ID. (With `parent` named this is already caught below as a
    // parent/anchor disagreement; rejecting it here says why.)
    if (anchorId === ROOT_ID) {
      throw new Error(
        `stream-dom: ${opName} may not use the mount root as an anchor`,
      );
    }
    if (parentId === undefined && anchorId === undefined) {
      throw new Error(`stream-dom: ${opName} has neither parent nor anchor`);
    }
    if (parentId !== undefined) {
      const explicit = this.#resolve(parentId);
      if (anchorId !== undefined) {
        const anchor = this.#resolve(anchorId);
        if (anchor.parentNode && anchor.parentNode !== explicit) {
          throw new Error(
            `stream-dom: ${opName} parent ${parentId} disagrees with anchor ${anchorId}'s current parent`,
          );
        }
      }
      return explicit;
    }
    const anchor = this.#resolve(anchorId!);
    if (!anchor.parentNode) {
      throw new Error(
        `stream-dom: ${opName} anchor ${anchorId} has no parent to imply (parent was omitted)`,
      );
    }
    return anchor.parentNode;
  }

  /** `parent.moveBefore(node, ref)` when it exists and both endpoints are
   * connected (the browser throws otherwise); plain `insertBefore`
   * everywhere else. Unlike the remote-dom transcoder, there is no
   * pre/post-detach index bookkeeping to get right here: a real `Node`
   * reference stays valid and self-consistent across the move (the
   * browser reparents it atomically), so there is nothing to recompute —
   * one divergence from `RemoteDomTranscoder`'s semantics this receiver
   * does not need. */
  #insertOrMove(parent: Node, node: Node, ref: Node | null): void {
    const p = parent as MoveCapableParent;
    if (
      typeof p.moveBefore === "function" && node.isConnected &&
      parent.isConnected
    ) {
      p.moveBefore(node, ref);
      return;
    }
    parent.insertBefore(node, ref);
  }

  insertBefore(
    parentId: number | undefined,
    id: number,
    anchorId: number | undefined,
  ): void {
    this.#rejectRoot("insert-before", id);
    if (anchorId === id) return; // no-op — see RemoteDomTranscoder's doc.
    const parent = this.#resolveInsertParent(
      "insert-before",
      parentId,
      anchorId,
    );
    const node = this.#resolve(id);
    const anchor = anchorId === undefined ? null : this.#resolve(anchorId);
    if (anchor !== null && anchor.parentNode !== parent) {
      throw new Error(
        `stream-dom: insert-before anchor ${anchorId} is not a child of the resolved parent`,
      );
    }
    this.#insertOrMove(parent, node, anchor);
  }

  insertAfter(
    parentId: number | undefined,
    id: number,
    anchorId: number,
  ): void {
    this.#rejectRoot("insert-after", id);
    if (anchorId === id) return; // no-op — see RemoteDomTranscoder's doc.
    const parent = this.#resolveInsertParent(
      "insert-after",
      parentId,
      anchorId,
    );
    const node = this.#resolve(id);
    const anchor = this.#resolve(anchorId);
    if (anchor.parentNode !== parent) {
      throw new Error(
        `stream-dom: insert-after anchor ${anchorId} is not a child of the resolved parent`,
      );
    }
    this.#insertOrMove(parent, node, anchor.nextSibling);
  }

  remove(id: number): void {
    this.#rejectRoot("remove", id);
    const node = this.#resolve(id);
    node.parentNode?.removeChild(node);
    this.#forgetSubtree(node);
  }

  /** Forget `node` and its descendants by walking the REMOVED subtree,
   * never by scanning the id map: a 10k-row clear removes one subtree of
   * ~10k nodes, and the id map can hold many unrelated ids, so scanning it
   * per removed node would be O(ids × nodes) instead of O(nodes). The
   * reverse map (`#ids`) makes each node's own forgetting O(1). The walk
   * is an explicit stack rather than recursion: a legal-but-deep tree
   * (tens of thousands of nested nodes, which no rule forbids a producer
   * from building) would otherwise overflow the JS stack on removal. */
  #forgetSubtree(root: Node): void {
    const stack: Node[] = [root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      const id = this.#ids.get(node);
      if (id !== undefined) {
        this.#nodes.delete(id);
        this.#ids.delete(node);
      }
      for (const child of node.childNodes) stack.push(child);
    }
  }

  // -- leaf ops -------------------------------------------------------------

  setText(id: number, text: string): void {
    const node = this.#resolve(id);
    // proto SetText: "Set a text node's content". `CharacterData` is the
    // only thing with a `data` property; on an `Element` the assignment
    // this used to do unconditionally installed a silent expando instead
    // of rendering anything. Text and comment nodes are the two this
    // receiver ever creates (`create-text`, `create-placeholder`) and the
    // two a template arena can produce.
    if (node.nodeType !== TEXT_NODE && node.nodeType !== COMMENT_NODE) {
      throw new Error(
        `stream-dom: set-text target ${id} is not a text or comment node`,
      );
    }
    (node as CharacterData).data = text;
  }

  setAttribute(
    id: number,
    name: number,
    ns: number | undefined,
    value: AttrValue | undefined,
  ): void {
    const el = this.#element("set-attribute", id);
    const attrName = this.#str(name);
    if (value === undefined) {
      if (ns === undefined) el.removeAttribute(attrName);
      else el.removeAttributeNS(this.#str(ns), attrName);
    } else {
      const text = this.#attrText(value);
      if (ns === undefined) el.setAttribute(attrName, text);
      else el.setAttributeNS(this.#str(ns), attrName, text);
    }
  }

  setProperty(id: number, name: number, value: PropertyValue): void {
    const el = this.#element("set-property", id) as unknown as Record<
      string,
      unknown
    >;
    const propName = this.#str(name);
    // An absent value "deletes / sets undefined" (proto SetProperty). On
    // the DOM that must be `null`, not `undefined`: the string-typed
    // properties a producer resets this way (`value`, `innerHTML`) are
    // [LegacyNullToEmptyString], so `null` yields "" while `undefined`
    // yields the string "undefined"; booleans coerce `null` to false.
    // (Same coercion remote.ts documents — it is a WebIDL rule on the
    // property assignment itself, not a remote-dom behavior, so it
    // applies here unchanged.)
    el[propName] = value.kind === "none" ? null : value.value;
  }

  setTextControlState(id: number, state: TextControlState): void {
    const el = this.#element("set-text-control-state", id) as
      | HTMLInputElement
      | HTMLTextAreaElement;
    if (
      el.tagName !== "TEXTAREA" &&
      !(el.tagName === "INPUT" &&
        ["text", "search", "tel", "url", "password"].includes(
          (el as HTMLInputElement).type,
        ))
    ) return;
    if (
      state.selectionStart > state.selectionEnd ||
      state.selectionEnd > state.value.length
    ) return;
    const previous = el.value;
    try {
      el.value = state.value;
      el.setSelectionRange(
        state.selectionStart,
        state.selectionEnd,
        state.direction,
      );
    } catch {
      el.value = previous;
    }
  }

  // -- listeners ------------------------------------------------------------

  addListener(listener: Listener): void {
    this.listeners.add(listener);
  }

  removeListener(listener: Listener): void {
    this.listeners.remove(listener);
  }

  // -- templates ------------------------------------------------------------

  registerTemplate(id: number, nodes: TemplateNode[], roots: number[]): void {
    validateTemplateArena(id, nodes, roots);
    const build = (idx: number): Node => {
      const n = nodes[idx];
      if (n.kind === "text") return this.#doc.createTextNode(n.text);
      if (n.kind === "dynamic") return this.#doc.createComment("");
      const el = n.element.ns === undefined
        ? this.#doc.createElement(this.#str(n.element.tag))
        : this.#doc.createElementNS(
          this.#str(n.element.ns),
          this.#str(n.element.tag),
        );
      for (const a of n.element.attrs) {
        // Asset handles resolve HERE, at registration: the prototype is
        // built once and cloned, so a later re-intern (or a later hook)
        // cannot make a clone diverge from what was registered.
        const text = this.#attrText(a.value);
        if (a.ns === undefined) el.setAttribute(this.#str(a.name), text);
        else el.setAttributeNS(this.#str(a.ns), this.#str(a.name), text);
      }
      for (const childIdx of n.element.children) {
        el.appendChild(build(childIdx));
      }
      return el;
    };
    const prototypes = roots.map((rootIdx) => build(rootIdx));
    this.#templates.set(id, { prototypes });
  }

  cloneTemplate(tmpl: number, root: number, id: number): void {
    const template = this.#templates.get(tmpl);
    if (!template) {
      throw new Error(`stream-dom: clone-template of unknown template ${tmpl}`);
    }
    // `root` is the ORDINAL into the declared roots (see
    // RemoteDomTranscoder.cloneTemplate's doc — same proto rule).
    if (root < 0 || root >= template.prototypes.length) {
      throw new Error(
        `stream-dom: clone-template root ordinal ${root} out of range for template ${tmpl} (has ${template.prototypes.length} root(s))`,
      );
    }
    this.#register(id, template.prototypes[root].cloneNode(true));
  }

  bindPath(root: number, path: Uint8Array, id: number): void {
    let node = this.#resolve(root);
    for (const step of path) {
      const next = node.childNodes[step];
      if (!next) {
        throw new Error(
          `stream-dom: bind-path from root ${root} walked off the template at step ${step}`,
        );
      }
      node = next;
    }
    // `#register` is what rejects `id == 0` and the aliasing case here: an
    // empty `path` (or one that walks back onto an already-bound interior
    // node) resolves to a node that already carries an id.
    this.#register(id, node);
  }

  bindMarker(_key: number, _id: number): void {
    throw new Error("hydration is not supported by this receiver");
  }

  // -- commit ---------------------------------------------------------------

  commit(): void {
    // Ops already applied directly as they decoded — there is no batched
    // `mutate()` call to make here, unlike the remote-dom receiver. The
    // hook still fires so `mount.ts`'s listener attach/detach (shared
    // between both receivers) runs at the same point either way.
    this.onCommit?.();
  }
}
