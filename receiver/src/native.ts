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
  FrameSink,
  Listener,
  PropertyValue,
  TemplateNode,
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
  #nodes = new Map<number, Node>();
  #ids = new WeakMap<Node, number>();
  #templates = new Map<number, CompiledTemplate>();
  readonly listeners: ListenerRegistry = new ListenerRegistry();
  onCommit: (() => void) | null = null;

  constructor(root: Element) {
    this.#doc = root.ownerDocument;
    this.#register(0, root);
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

  #register(id: number, node: Node): void {
    this.#nodes.set(id, node);
    this.#ids.set(node, id);
  }

  #resolve(id: number): Node {
    const node = this.#nodes.get(id);
    if (!node) throw new Error(`stream-dom: unknown node id ${id}`);
    return node;
  }

  #str(ref: number): string {
    return this.listeners.stringFor(ref);
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
    const node = this.#resolve(id);
    node.parentNode?.removeChild(node);
    this.#forgetSubtree(node);
  }

  /** Forget `node` and its descendants by walking the REMOVED subtree
   * (`node.childNodes` recursion), never by scanning the id map: a 10k-row
   * clear removes one subtree of ~10k nodes, and the id map can hold many
   * unrelated ids, so scanning it per removed node would be
   * O(ids × nodes) instead of O(nodes). The reverse map (`#ids`) makes
   * each node's own forgetting O(1). */
  #forgetSubtree(node: Node): void {
    const id = this.#ids.get(node);
    if (id !== undefined) {
      this.#nodes.delete(id);
      this.#ids.delete(node);
    }
    for (const child of node.childNodes) this.#forgetSubtree(child);
  }

  // -- leaf ops -------------------------------------------------------------

  setText(id: number, text: string): void {
    (this.#resolve(id) as CharacterData).data = text;
  }

  setAttribute(
    id: number,
    name: number,
    ns: number | undefined,
    value: string | undefined,
  ): void {
    const el = this.#resolve(id) as Element;
    const attrName = this.#str(name);
    if (value === undefined) {
      if (ns === undefined) el.removeAttribute(attrName);
      else el.removeAttributeNS(this.#str(ns), attrName);
    } else {
      if (ns === undefined) el.setAttribute(attrName, value);
      else el.setAttributeNS(this.#str(ns), attrName, value);
    }
  }

  setProperty(id: number, name: number, value: PropertyValue): void {
    const el = this.#resolve(id) as unknown as Record<string, unknown>;
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
        if (a.ns === undefined) el.setAttribute(this.#str(a.name), a.value);
        else el.setAttributeNS(this.#str(a.ns), this.#str(a.name), a.value);
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
