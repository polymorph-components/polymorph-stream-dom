// Host vocabulary policy: a `FrameSink` wrapper that shows each
// vocabulary-bearing op to a host-supplied callback with interned strings
// resolved, and forwards it to the real backend only if the callback
// allows it (docs/design.md "Policy"). Confinement (node ids, template
// arena validity) is protocol and stays with the backends — this seam is
// only about WHAT vocabulary a producer may name.

import { PROTOCOL_VERSION } from "./frames.ts";
import type {
  AttrValue,
  FrameSink,
  Listener,
  PropertyValue,
  TemplateNode,
  TextControlState,
} from "./frames.ts";

export interface Policy {
  /** Pins the protocol version this policy was written against. `mount`
   * throws synchronously unless it equals the receiver's PROTOCOL_VERSION:
   * upgrading the receiver library must not silently widen what a policy
   * never reviewed. */
  readonly version: number;
  /** Return `undefined` to allow; a reason string rejects, which closes the
   * stream and reports a PolicyError through `onError`. */
  check(op: PolicyOp): string | undefined;
  /** May the producer call this `queries` import (wit/stream-dom.wit
   * `interface queries`)? Absent means allow. A refusal answers
   * `undefined`/`false` rather than throwing — the WIT signatures already
   * carry "no answer", and there is no violator to name: asking is legal,
   * it is the answer this host declines to give. */
  query?(
    name:
      | "get-client-rect"
      | "get-scroll-offset"
      | "get-scroll-size"
      | "set-focus",
  ): boolean;
}

export type PolicyOp =
  | { op: "createElement"; tag: string; ns: string | undefined }
  | {
    op: "setAttribute";
    tag: string | undefined;
    name: string;
    ns: string | undefined;
    value: AttrValue | undefined;
  }
  | {
    op: "setProperty";
    tag: string | undefined;
    name: string;
    value: PropertyValue;
  }
  | {
    op: "setTextControlState";
    tag: string | undefined;
    state: TextControlState;
  }
  | {
    op: "addListener";
    target: "node" | "window" | "document";
    name: string;
    capture: boolean;
    passive: boolean;
    preventDefault: boolean;
    stopPropagation: boolean;
  }
  | { op: "bindMarker" };

export class PolicyError extends Error {
  /** Ops the sink had seen before this one (`commit` not counted), 0-based. */
  readonly opIndex: number;
  readonly op: PolicyOp;
  readonly reason: string;

  constructor(opIndex: number, op: PolicyOp, reason: string) {
    super(`stream-dom: policy rejected ${op.op} #${opIndex}: ${reason}`);
    this.name = "PolicyError";
    this.opIndex = opIndex;
    this.op = op;
    this.reason = reason;
  }
}

/** Throws unless `policy.version` is this receiver's `PROTOCOL_VERSION` —
 * called by `mount` before anything else happens. */
export function assertPolicyVersion(policy: Policy): void {
  if (policy.version !== PROTOCOL_VERSION) {
    throw new Error(
      `stream-dom: policy pins protocol version ${policy.version}, receiver is ${PROTOCOL_VERSION}`,
    );
  }
}

/** Where a node id landed inside a registered template arena: which
 * template, and which node index within it. Recorded by `cloneTemplate`
 * for the clone's root and extended by `bindPath`, which walks the arena's
 * `children` in the same order the backends walk real `childNodes` — so a
 * path step crossing a text node or a dynamic hole lands on the same node
 * either way. */
interface ArenaSite {
  tmpl: number;
  index: number;
}

/** A registered template as this sink remembers it: the arena, its root
 * ordinals, and each node's tag resolved AT REGISTRATION. Intern slots can
 * be overwritten (proto `Intern`: "Define (or overwrite) interned slot"),
 * and the backends build their prototypes with the strings current at
 * `registerTemplate` — so re-resolving a tag ref later, when a clone or a
 * bind-path lands on the node, could name a different element than the one
 * actually in the DOM, and attributes would be judged against the wrong
 * tag. `tags[i]` is `undefined` for non-element nodes. */
interface RegisteredTemplate {
  nodes: TemplateNode[];
  roots: number[];
  tags: (string | undefined)[];
}

/**
 * FrameSink wrapper: resolves interned strings, tracks element tags by
 * node id (createElement, cloneTemplate, bindPath through the template
 * arena), flattens registerTemplate into synthetic createElement /
 * setAttribute checks (tag known, no id), calls policy.check, forwards to
 * the inner sink only on allow. Throws PolicyError on reject.
 */
export class PolicySink implements FrameSink {
  #inner: FrameSink;
  #policy: Policy;
  /** This sink's OWN copy of the intern table: it must resolve tag,
   * attribute, property and event-name refs before the backend has seen
   * the op, and the backends' tables are private to them. */
  #strings = new Map<number, string>();
  /** Node id -> tag name, for ids known to be elements. */
  #tags = new Map<number, string>();
  #templates = new Map<number, RegisteredTemplate>();
  #sites = new Map<number, ArenaSite>();
  #ops = 0;

  constructor(inner: FrameSink, policy: Policy) {
    this.#inner = inner;
    this.#policy = policy;
  }

  /** The index this call reports to the policy: every FrameSink call the
   * sink received before it, `commit` excluded. */
  #next(): number {
    return this.#ops++;
  }

  /** A ref this stream never interned resolves to `""` here: the policy
   * still gets a well-formed op to judge, and if it allows it the op
   * reaches the backend, whose own `stringFor` rejects the unknown ref
   * (receiver.ts) — so an un-interned ref aborts the stream through the
   * protocol error it already is, rather than through a TypeError raised
   * inside the policy seam. */
  #str(ref: number): string {
    return this.#strings.get(ref) ?? "";
  }

  #ns(ref: number | undefined): string | undefined {
    return ref === undefined ? undefined : this.#str(ref);
  }

  #check(opIndex: number, op: PolicyOp): void {
    const reason = this.#policy.check(op);
    if (reason !== undefined) throw new PolicyError(opIndex, op, reason);
  }

  // -- checked ops --------------------------------------------------------

  createElement(id: number, tag: number, ns: number | undefined): void {
    const opIndex = this.#next();
    const tagName = this.#str(tag);
    this.#check(opIndex, {
      op: "createElement",
      tag: tagName,
      ns: this.#ns(ns),
    });
    this.#tags.set(id, tagName);
    this.#inner.createElement(id, tag, ns);
  }

  setAttribute(
    id: number,
    name: number,
    ns: number | undefined,
    value: AttrValue | undefined,
  ): void {
    const opIndex = this.#next();
    this.#check(opIndex, {
      op: "setAttribute",
      tag: this.#tags.get(id),
      name: this.#str(name),
      ns: this.#ns(ns),
      value,
    });
    this.#inner.setAttribute(id, name, ns, value);
  }

  setProperty(id: number, name: number, value: PropertyValue): void {
    const opIndex = this.#next();
    this.#check(opIndex, {
      op: "setProperty",
      tag: this.#tags.get(id),
      name: this.#str(name),
      value,
    });
    this.#inner.setProperty(id, name, value);
  }

  setTextControlState(id: number, state: TextControlState): void {
    const opIndex = this.#next();
    this.#check(opIndex, {
      op: "setTextControlState",
      tag: this.#tags.get(id),
      state,
    });
    this.#inner.setTextControlState(id, state);
  }

  addListener(listener: Listener): void {
    const opIndex = this.#next();
    this.#check(opIndex, {
      op: "addListener",
      target: listener.target.kind,
      name: this.#str(listener.name),
      capture: listener.capture,
      passive: listener.passive,
      preventDefault: listener.preventDefault,
      stopPropagation: listener.stopPropagation,
    });
    this.#inner.addListener(listener);
  }

  bindMarker(key: number, id: number): void {
    const opIndex = this.#next();
    this.#check(opIndex, { op: "bindMarker" });
    this.#inner.bindMarker(key, id);
  }

  /** Every element and attribute a template can ever stamp out is named
   * ONCE here, at registration: the arena is flattened into synthetic
   * `createElement` / `setAttribute` checks (tag known, no id yet).
   * `cloneTemplate` therefore re-checks nothing. */
  registerTemplate(id: number, nodes: TemplateNode[], roots: number[]): void {
    const opIndex = this.#next();
    const tags: (string | undefined)[] = [];
    for (const node of nodes) {
      if (node.kind !== "element") {
        tags.push(undefined);
        continue;
      }
      const tag = this.#str(node.element.tag);
      tags.push(tag);
      this.#check(opIndex, {
        op: "createElement",
        tag,
        ns: this.#ns(node.element.ns),
      });
      for (const attr of node.element.attrs) {
        this.#check(opIndex, {
          op: "setAttribute",
          tag,
          name: this.#str(attr.name),
          ns: this.#ns(attr.ns),
          value: attr.value,
        });
      }
    }
    this.#templates.set(id, { nodes, roots, tags });
    this.#inner.registerTemplate(id, nodes, roots);
  }

  // -- unchecked ops (bookkeeping only, then forwarded) --------------------

  internString(id: number, s: string): void {
    this.#next();
    this.#strings.set(id, s);
    this.#inner.internString(id, s);
  }

  cloneTemplate(tmpl: number, root: number, id: number): void {
    this.#next();
    const template = this.#templates.get(tmpl);
    // An unknown template or out-of-range root ordinal is the backend's
    // error to raise (it does, with its own message); this sink just has
    // no site to record.
    const index = template?.roots[root];
    if (template && index !== undefined) {
      this.#record(id, { tmpl, index }, template);
    }
    this.#inner.cloneTemplate(tmpl, root, id);
  }

  bindPath(root: number, path: Uint8Array, id: number): void {
    this.#next();
    const site = this.#sites.get(root);
    const template = site && this.#templates.get(site.tmpl);
    if (site && template) {
      let index: number | undefined = site.index;
      for (const step of path) {
        const node: TemplateNode | undefined = template.nodes[index!];
        index = node?.kind === "element"
          ? node.element.children[step]
          : undefined;
        if (index === undefined) break;
      }
      if (index !== undefined) {
        this.#record(id, { tmpl: site.tmpl, index }, template);
      }
    }
    this.#inner.bindPath(root, path, id);
  }

  /** Bind `id` to an arena node, taking its tag from the template's
   * registration-time table (see `RegisteredTemplate.tags`) rather than
   * re-resolving the ref now. */
  #record(id: number, site: ArenaSite, template: RegisteredTemplate): void {
    this.#sites.set(id, site);
    const tag = template.tags[site.index];
    if (tag !== undefined) this.#tags.set(id, tag);
  }

  createText(id: number, text: string): void {
    this.#next();
    this.#inner.createText(id, text);
  }

  createPlaceholder(id: number): void {
    this.#next();
    this.#inner.createPlaceholder(id);
  }

  insertBefore(
    parent: number | undefined,
    id: number,
    anchor: number | undefined,
  ): void {
    this.#next();
    this.#inner.insertBefore(parent, id, anchor);
  }

  insertAfter(parent: number | undefined, id: number, anchor: number): void {
    this.#next();
    this.#inner.insertAfter(parent, id, anchor);
  }

  remove(id: number): void {
    this.#next();
    this.#inner.remove(id);
  }

  setText(id: number, text: string): void {
    this.#next();
    this.#inner.setText(id, text);
  }

  removeListener(listener: Listener): void {
    this.#next();
    this.#inner.removeListener(listener);
  }

  commit(): void {
    this.#inner.commit();
  }
}
