// Frame decoder: `proto/stream-dom.proto`'s `Frame` message, decoded
// field-by-field with a switch on tag straight into `FrameSink` calls — the
// "pbf hybrid decode" docs/design.md's Encoding section describes, with no
// intermediate object for the hot structural ops. Field numbers below are
// copied from the .proto (which is normative and not owned by this
// track); each constant is named after its proto message and field.

import { Reader, TruncatedError, WireType } from "./proto.ts";
import type { AcceptSet, MessageAccept } from "./policy.ts";

// -- Frame --------------------------------------------------------------

const FRAME_COMMIT = 1;
const FRAME_INSERT_BEFORE = 2;
const FRAME_SET_TEXT = 3;
const FRAME_SET_ATTRIBUTE = 4;
const FRAME_SET_PROPERTY = 5;
const FRAME_CREATE_ELEMENT = 6;
const FRAME_CREATE_TEXT = 7;
const FRAME_REMOVE = 8;
const FRAME_CLONE_TEMPLATE = 9;
const FRAME_BIND_PATH = 10;
const FRAME_CREATE_PLACEHOLDER = 11;
const FRAME_ADD_LISTENER = 12;
const FRAME_REMOVE_LISTENER = 13;
const FRAME_INTERN = 14;
const FRAME_REGISTER_TEMPLATE = 15;
const FRAME_INSERT_AFTER = 16;
const FRAME_BIND_MARKER = 17;
/** Lowest oneof `op` field number — used to recognize "some op field was
 * present, even one this decoder does not know" for the no-op/no-commit
 * check below. */
const FRAME_OP_FIELD_MIN = 2;

const INTERN_ID = 1;
const INTERN_S = 2;

const CREATE_ELEMENT_ID = 1;
const CREATE_ELEMENT_TAG = 2;
const CREATE_ELEMENT_NS = 3;

const CREATE_TEXT_ID = 1;
const CREATE_TEXT_TEXT = 2;

const CREATE_PLACEHOLDER_ID = 1;

const INSERT_BEFORE_PARENT = 1;
const INSERT_BEFORE_ID = 2;
const INSERT_BEFORE_ANCHOR = 3;

const INSERT_AFTER_PARENT = 1;
const INSERT_AFTER_ID = 2;
const INSERT_AFTER_ANCHOR = 3;

const REMOVE_ID = 1;

const SET_TEXT_ID = 1;
const SET_TEXT_TEXT = 2;

const SET_ATTRIBUTE_ID = 1;
const SET_ATTRIBUTE_NAME = 2;
const SET_ATTRIBUTE_NS = 3;
const SET_ATTRIBUTE_VALUE = 4;

const SET_PROPERTY_ID = 1;
const SET_PROPERTY_NAME = 2;
const SET_PROPERTY_TEXT = 3;
const SET_PROPERTY_INT = 4;
const SET_PROPERTY_FLOAT = 5;
const SET_PROPERTY_BOOLEAN = 6;

const LISTENER_ID = 1;
const LISTENER_NAME = 2;
const LISTENER_BUBBLES = 3;
const LISTENER_CAPTURE = 4;
const LISTENER_PASSIVE = 5;
const LISTENER_PREVENT_DEFAULT = 6;
const LISTENER_STOP_PROPAGATION = 7;
const LISTENER_GLOBAL = 8;

/** `Global` enum values (proto/stream-dom.proto). */
const GLOBAL_WINDOW = 0;
const GLOBAL_DOCUMENT = 1;

const ADD_LISTENER_LISTENER = 1;
const REMOVE_LISTENER_LISTENER = 1;

const TEMPLATE_ATTR_NAME = 1;
const TEMPLATE_ATTR_NS = 2;
const TEMPLATE_ATTR_VALUE = 3;

const TEMPLATE_ELEMENT_TAG = 1;
const TEMPLATE_ELEMENT_NS = 2;
const TEMPLATE_ELEMENT_ATTRS = 3;
const TEMPLATE_ELEMENT_CHILDREN = 4;

const TEMPLATE_NODE_ELEMENT = 1;
const TEMPLATE_NODE_TEXT = 2;
const TEMPLATE_NODE_DYNAMIC = 3;

const REGISTER_TEMPLATE_ID = 1;
const REGISTER_TEMPLATE_NODES = 2;
const REGISTER_TEMPLATE_ROOTS = 3;

const CLONE_TEMPLATE_TMPL = 1;
const CLONE_TEMPLATE_ROOT = 2;
const CLONE_TEMPLATE_ID = 3;

const BIND_PATH_ROOT = 1;
const BIND_PATH_PATH = 2;
const BIND_PATH_ID = 3;

const BIND_MARKER_KEY = 1;
const BIND_MARKER_ID = 2;

/** Every field number above, keyed by constant name, for policy.ts's
 * `Message.field` name table. Exported so that table can reference these
 * rather than repeat the literals: a new constant with no table entry is
 * then visible in the same diff. */
export const STREAM_FIELD_NUMBERS = {
  FRAME_COMMIT,
  FRAME_INSERT_BEFORE,
  FRAME_SET_TEXT,
  FRAME_SET_ATTRIBUTE,
  FRAME_SET_PROPERTY,
  FRAME_CREATE_ELEMENT,
  FRAME_CREATE_TEXT,
  FRAME_REMOVE,
  FRAME_CLONE_TEMPLATE,
  FRAME_BIND_PATH,
  FRAME_CREATE_PLACEHOLDER,
  FRAME_ADD_LISTENER,
  FRAME_REMOVE_LISTENER,
  FRAME_INTERN,
  FRAME_REGISTER_TEMPLATE,
  FRAME_INSERT_AFTER,
  FRAME_BIND_MARKER,
  INTERN_ID,
  INTERN_S,
  CREATE_ELEMENT_ID,
  CREATE_ELEMENT_TAG,
  CREATE_ELEMENT_NS,
  CREATE_TEXT_ID,
  CREATE_TEXT_TEXT,
  CREATE_PLACEHOLDER_ID,
  INSERT_BEFORE_PARENT,
  INSERT_BEFORE_ID,
  INSERT_BEFORE_ANCHOR,
  INSERT_AFTER_PARENT,
  INSERT_AFTER_ID,
  INSERT_AFTER_ANCHOR,
  REMOVE_ID,
  SET_TEXT_ID,
  SET_TEXT_TEXT,
  SET_ATTRIBUTE_ID,
  SET_ATTRIBUTE_NAME,
  SET_ATTRIBUTE_NS,
  SET_ATTRIBUTE_VALUE,
  SET_PROPERTY_ID,
  SET_PROPERTY_NAME,
  SET_PROPERTY_TEXT,
  SET_PROPERTY_INT,
  SET_PROPERTY_FLOAT,
  SET_PROPERTY_BOOLEAN,
  LISTENER_ID,
  LISTENER_NAME,
  LISTENER_BUBBLES,
  LISTENER_CAPTURE,
  LISTENER_PASSIVE,
  LISTENER_PREVENT_DEFAULT,
  LISTENER_STOP_PROPAGATION,
  LISTENER_GLOBAL,
  GLOBAL_WINDOW,
  GLOBAL_DOCUMENT,
  ADD_LISTENER_LISTENER,
  REMOVE_LISTENER_LISTENER,
  TEMPLATE_ATTR_NAME,
  TEMPLATE_ATTR_NS,
  TEMPLATE_ATTR_VALUE,
  TEMPLATE_ELEMENT_TAG,
  TEMPLATE_ELEMENT_NS,
  TEMPLATE_ELEMENT_ATTRS,
  TEMPLATE_ELEMENT_CHILDREN,
  TEMPLATE_NODE_ELEMENT,
  TEMPLATE_NODE_TEXT,
  TEMPLATE_NODE_DYNAMIC,
  REGISTER_TEMPLATE_ID,
  REGISTER_TEMPLATE_NODES,
  REGISTER_TEMPLATE_ROOTS,
  CLONE_TEMPLATE_TMPL,
  CLONE_TEMPLATE_ROOT,
  CLONE_TEMPLATE_ID,
  BIND_PATH_ROOT,
  BIND_PATH_PATH,
  BIND_PATH_ID,
  BIND_MARKER_KEY,
  BIND_MARKER_ID,
} as const;

/** Strict-mode gate: one bit test per field, on the hot path. A field
 * number above 31 does not fit the mask and is undeclared by construction
 * (policy.ts `MessageAccept`); `reject` builds the message and throws. */
function check(m: MessageAccept, field: number): void {
  if (field > 31 || (m.mask & (1 << field)) === 0) m.reject(field);
}

// -- decoded shapes -------------------------------------------------------

/** `Listener.target`'s oneof (proto/stream-dom.proto): a node id, or one
 * of the two receiver-side singletons (`Global`). Mirrors the shape
 * `mount.ts` builds for the WIT `event-target` variant, though the two
 * are not the same type — this one is this decoder's own, `id`-named
 * rather than `value`-named for readability at call sites. */
export type ListenerTarget =
  | { kind: "node"; id: number }
  | { kind: "window" }
  | { kind: "document" };

/** `proto/stream-dom.proto`'s `Listener` message. */
export interface Listener {
  target: ListenerTarget;
  name: number;
  bubbles: boolean;
  capture: boolean;
  passive: boolean;
  preventDefault: boolean;
  stopPropagation: boolean;
}

export type PropertyValue =
  | { kind: "text"; value: string }
  | { kind: "int"; value: number }
  | { kind: "float"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "none" };

export interface TemplateAttr {
  name: number;
  ns: number | undefined;
  value: string;
}

export interface TemplateElement {
  tag: number;
  ns: number | undefined;
  attrs: TemplateAttr[];
  children: number[];
}

export type TemplateNode =
  | { kind: "element"; element: TemplateElement }
  | { kind: "text"; text: string }
  | { kind: "dynamic" };

/** One method per op, called when a `Frame`'s op is decoded; `commit()` is
 * called AFTER the frame's op (if any) when `Frame.commit` is set —
 * docs/design.md "Batches are framed by a `commit` flag": "Ops are applied
 * before the flag is honored, whatever the field order inside the frame". */
export interface FrameSink {
  internString(id: number, s: string): void;
  createElement(id: number, tag: number, ns: number | undefined): void;
  createText(id: number, text: string): void;
  createPlaceholder(id: number): void;
  /** `parent` is presence-tracked: `undefined` (NOT `0`, which is the mount
   * root) means "no parent named — use `anchor`'s current shadow parent",
   * legal only when `anchor` is present (proto: "`parent` is required
   * without an `anchor` and optional with one"). */
  insertBefore(
    parent: number | undefined,
    id: number,
    anchor: number | undefined,
  ): void;
  /** Insert `id` immediately after `anchor`. `parent`, same presence rule
   * as `insertBefore`'s; `anchor` itself is always present (proto:
   * `InsertAfter.anchor` is a plain `uint32`, not `optional`). */
  insertAfter(parent: number | undefined, id: number, anchor: number): void;
  remove(id: number): void;
  setText(id: number, text: string): void;
  setAttribute(
    id: number,
    name: number,
    ns: number | undefined,
    value: string | undefined,
  ): void;
  setProperty(id: number, name: number, value: PropertyValue): void;
  addListener(listener: Listener): void;
  removeListener(listener: Listener): void;
  registerTemplate(id: number, nodes: TemplateNode[], roots: number[]): void;
  cloneTemplate(tmpl: number, root: number, id: number): void;
  bindPath(root: number, path: Uint8Array, id: number): void;
  bindMarker(key: number, id: number): void;
  commit(): void;
}

function decodeListener(r: Reader, a: AcceptSet | undefined): Listener {
  let target: ListenerTarget | undefined;
  let name = 0;
  let bubbles = false;
  let capture = false;
  let passive = false;
  let preventDefault = false;
  let stopPropagation = false;
  while (!r.finished()) {
    const [field, wireType] = r.readTag();
    if (a) check(a.Listener, field);
    switch (field) {
      case LISTENER_ID:
        target = { kind: "node", id: r.readVarint32() };
        break;
      case LISTENER_GLOBAL: {
        const g = r.readVarint32();
        // Gated by enum VALUE: declaring `Listener.global` says nothing
        // about which singletons the producer may name. An unknown value
        // is a mask miss too, so strict mode reports `Global.<n>`.
        if (a) check(a.Global, g);
        if (g === GLOBAL_WINDOW) target = { kind: "window" };
        else if (g === GLOBAL_DOCUMENT) target = { kind: "document" };
        else throw new Error(`stream-dom: Listener.global unknown value ${g}`);
        break;
      }
      case LISTENER_NAME:
        name = r.readVarint32();
        break;
      case LISTENER_BUBBLES:
        bubbles = r.readBool();
        break;
      case LISTENER_CAPTURE:
        capture = r.readBool();
        break;
      case LISTENER_PASSIVE:
        passive = r.readBool();
        break;
      case LISTENER_PREVENT_DEFAULT:
        preventDefault = r.readBool();
        break;
      case LISTENER_STOP_PROPAGATION:
        stopPropagation = r.readBool();
        break;
      default:
        r.skip(wireType);
    }
  }
  // Proto3 `oneof` has no default case: neither field set is a genuine
  // absence, not "id 0" (which IS the mount root and a legal target).
  if (!target) {
    throw new Error(
      "stream-dom: Listener has no target (neither id nor global set)",
    );
  }
  return {
    target,
    name,
    bubbles,
    capture,
    passive,
    preventDefault,
    stopPropagation,
  };
}

/** A `repeated uint32` field: proto3 packs scalar-numeric repeated fields
 * by default (length-delimited, consecutive varints with no per-element
 * tag), but an unpacked encoder emitting one tag/varint pair per element
 * is equally valid wire; both are accepted here. */
function readPackedOrRepeatedUint32(
  r: Reader,
  wireType: WireType,
  into: number[],
): void {
  if (wireType === WireType.LengthDelimited) {
    const sub = r.readMessage();
    while (!sub.finished()) into.push(sub.readVarint32());
  } else {
    into.push(r.readVarint32());
  }
}

function decodeTemplateAttr(
  r: Reader,
  acc: AcceptSet | undefined,
): TemplateAttr {
  const a: TemplateAttr = { name: 0, ns: undefined, value: "" };
  while (!r.finished()) {
    const [field, wireType] = r.readTag();
    if (acc) check(acc.TemplateAttr, field);
    switch (field) {
      case TEMPLATE_ATTR_NAME:
        a.name = r.readVarint32();
        break;
      case TEMPLATE_ATTR_NS:
        a.ns = r.readVarint32();
        break;
      case TEMPLATE_ATTR_VALUE:
        a.value = r.readString();
        break;
      default:
        r.skip(wireType);
    }
  }
  return a;
}

function decodeTemplateElement(
  r: Reader,
  acc: AcceptSet | undefined,
): TemplateElement {
  const e: TemplateElement = { tag: 0, ns: undefined, attrs: [], children: [] };
  while (!r.finished()) {
    const [field, wireType] = r.readTag();
    if (acc) check(acc.TemplateElement, field);
    switch (field) {
      case TEMPLATE_ELEMENT_TAG:
        e.tag = r.readVarint32();
        break;
      case TEMPLATE_ELEMENT_NS:
        e.ns = r.readVarint32();
        break;
      case TEMPLATE_ELEMENT_ATTRS:
        e.attrs.push(decodeTemplateAttr(r.readMessage(), acc));
        break;
      case TEMPLATE_ELEMENT_CHILDREN:
        readPackedOrRepeatedUint32(r, wireType, e.children);
        break;
      default:
        r.skip(wireType);
    }
  }
  return e;
}

function decodeTemplateNode(
  r: Reader,
  acc: AcceptSet | undefined,
): TemplateNode {
  let node: TemplateNode = { kind: "text", text: "" };
  while (!r.finished()) {
    const [field, wireType] = r.readTag();
    if (acc) check(acc.TemplateNode, field);
    switch (field) {
      case TEMPLATE_NODE_ELEMENT:
        node = {
          kind: "element",
          element: decodeTemplateElement(r.readMessage(), acc),
        };
        break;
      case TEMPLATE_NODE_TEXT:
        node = { kind: "text", text: r.readString() };
        break;
      case TEMPLATE_NODE_DYNAMIC:
        r.readMessage(); // Dynamic {} — no fields to read.
        node = { kind: "dynamic" };
        break;
      default:
        r.skip(wireType);
    }
  }
  return node;
}

/**
 * Feeds arbitrary byte chunks (a frame may straddle chunks per
 * docs/design.md: "Rendezvous copies split at byte granularity") and
 * dispatches each decoded `Frame` to a `FrameSink`. Keeps only the
 * undecoded tail between calls.
 */
export class FrameDecoder {
  #sink: FrameSink;
  #pending: Uint8Array = new Uint8Array(0);
  /** Frame messages decoded so far, whether or not they carried an op —
   * a benchmark harness's `Mounted.stats.frames` (mount.ts). */
  #frameCount = 0;
  /** Strict mode when present: every field tag in every message is checked
   * against its message's declared mask BEFORE its value is consumed, and
   * an undeclared or unknown one throws a `PolicyError` (policy.ts).
   * Absent (the default) is exactly the tolerant proto3 behaviour
   * docs/design.md describes: "receivers skip what they do not know". */
  #accept: AcceptSet | undefined;

  constructor(sink: FrameSink, options?: { accept?: AcceptSet }) {
    this.#sink = sink;
    this.#accept = options?.accept;
  }

  get frameCount(): number {
    return this.#frameCount;
  }

  /** Append a chunk and decode every complete frame now available. The
   * decoder copies what it keeps (the concatenation below), so the caller
   * may reuse or discard `chunk` immediately after this returns. */
  push(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.#pending.length + chunk.length);
    merged.set(this.#pending, 0);
    merged.set(chunk, this.#pending.length);
    this.#pending = merged;
    this.#drain();
  }

  #drain(): void {
    let offset = 0;
    const buf = this.#pending;
    for (;;) {
      const lenStart = offset;
      let len: number;
      try {
        const probe = new Reader(buf, lenStart, buf.length);
        len = probe.readVarint32();
        offset = probe.pos;
      } catch (err) {
        // A genuine truncation (fewer bytes buffered than the varint
        // needs) means "wait for more"; anything else (a malformed
        // varint that is fully present but never terminates within the
        // legal width) is a real protocol error and must not be treated
        // as a buffering situation forever.
        if (err instanceof TruncatedError) break;
        throw err;
      }
      if (offset + len > buf.length) {
        offset = lenStart; // Frame body straddles the buffer — wait for more.
        break;
      }
      const frame = new Reader(buf, offset, offset + len);
      offset += len;
      this.#decodeFrame(frame);
    }
    this.#pending = buf.subarray(offset);
  }

  #decodeFrame(r: Reader): void {
    this.#frameCount++;
    const A = this.#accept;
    let commit = false;
    let sawAnyOpField = false;
    let dispatch: (() => void) | undefined;

    while (!r.finished()) {
      const [field, wireType] = r.readTag();
      // Covers `commit`, every op case, the sub-`FRAME_OP_FIELD_MIN` skip
      // below and the `default` branch in one test: a tag not in the mask
      // is undeclared whether or not this decoder knows it.
      if (A) check(A.Frame, field);
      if (field === FRAME_COMMIT) {
        commit = r.readBool();
        continue;
      }
      if (field < FRAME_OP_FIELD_MIN) {
        r.skip(wireType);
        continue;
      }
      sawAnyOpField = true;
      switch (field) {
        case FRAME_INTERN: {
          const sub = r.readMessage();
          let id = 0, s = "";
          while (!sub.finished()) {
            const [f, wt] = sub.readTag();
            if (A) check(A.Intern, f);
            if (f === INTERN_ID) id = sub.readVarint32();
            else if (f === INTERN_S) s = sub.readString();
            else sub.skip(wt);
          }
          dispatch = () => this.#sink.internString(id, s);
          break;
        }
        case FRAME_CREATE_ELEMENT: {
          const sub = r.readMessage();
          let id = 0, tag = 0, ns: number | undefined;
          while (!sub.finished()) {
            const [f, wt] = sub.readTag();
            if (A) check(A.CreateElement, f);
            if (f === CREATE_ELEMENT_ID) id = sub.readVarint32();
            else if (f === CREATE_ELEMENT_TAG) tag = sub.readVarint32();
            else if (f === CREATE_ELEMENT_NS) ns = sub.readVarint32();
            else sub.skip(wt);
          }
          dispatch = () => this.#sink.createElement(id, tag, ns);
          break;
        }
        case FRAME_CREATE_TEXT: {
          const sub = r.readMessage();
          let id = 0, text = "";
          while (!sub.finished()) {
            const [f, wt] = sub.readTag();
            if (A) check(A.CreateText, f);
            if (f === CREATE_TEXT_ID) id = sub.readVarint32();
            else if (f === CREATE_TEXT_TEXT) text = sub.readString();
            else sub.skip(wt);
          }
          dispatch = () => this.#sink.createText(id, text);
          break;
        }
        case FRAME_CREATE_PLACEHOLDER: {
          const sub = r.readMessage();
          let id = 0;
          while (!sub.finished()) {
            const [f, wt] = sub.readTag();
            if (A) check(A.CreatePlaceholder, f);
            if (f === CREATE_PLACEHOLDER_ID) id = sub.readVarint32();
            else sub.skip(wt);
          }
          dispatch = () => this.#sink.createPlaceholder(id);
          break;
        }
        case FRAME_INSERT_BEFORE: {
          const sub = r.readMessage();
          let parent: number | undefined, id = 0, anchor: number | undefined;
          while (!sub.finished()) {
            const [f, wt] = sub.readTag();
            if (A) check(A.InsertBefore, f);
            if (f === INSERT_BEFORE_PARENT) parent = sub.readVarint32();
            else if (f === INSERT_BEFORE_ID) id = sub.readVarint32();
            else if (f === INSERT_BEFORE_ANCHOR) anchor = sub.readVarint32();
            else sub.skip(wt);
          }
          dispatch = () => this.#sink.insertBefore(parent, id, anchor);
          break;
        }
        case FRAME_INSERT_AFTER: {
          const sub = r.readMessage();
          let parent: number | undefined, id = 0, anchor = 0;
          while (!sub.finished()) {
            const [f, wt] = sub.readTag();
            if (A) check(A.InsertAfter, f);
            if (f === INSERT_AFTER_PARENT) parent = sub.readVarint32();
            else if (f === INSERT_AFTER_ID) id = sub.readVarint32();
            else if (f === INSERT_AFTER_ANCHOR) anchor = sub.readVarint32();
            else sub.skip(wt);
          }
          dispatch = () => this.#sink.insertAfter(parent, id, anchor);
          break;
        }
        case FRAME_REMOVE: {
          const sub = r.readMessage();
          let id = 0;
          while (!sub.finished()) {
            const [f, wt] = sub.readTag();
            if (A) check(A.Remove, f);
            if (f === REMOVE_ID) id = sub.readVarint32();
            else sub.skip(wt);
          }
          dispatch = () => this.#sink.remove(id);
          break;
        }
        case FRAME_SET_TEXT: {
          const sub = r.readMessage();
          let id = 0, text = "";
          while (!sub.finished()) {
            const [f, wt] = sub.readTag();
            if (A) check(A.SetText, f);
            if (f === SET_TEXT_ID) id = sub.readVarint32();
            else if (f === SET_TEXT_TEXT) text = sub.readString();
            else sub.skip(wt);
          }
          dispatch = () => this.#sink.setText(id, text);
          break;
        }
        case FRAME_SET_ATTRIBUTE: {
          const sub = r.readMessage();
          let id = 0,
            name = 0,
            ns: number | undefined,
            value: string | undefined;
          while (!sub.finished()) {
            const [f, wt] = sub.readTag();
            if (A) check(A.SetAttribute, f);
            if (f === SET_ATTRIBUTE_ID) id = sub.readVarint32();
            else if (f === SET_ATTRIBUTE_NAME) name = sub.readVarint32();
            else if (f === SET_ATTRIBUTE_NS) ns = sub.readVarint32();
            else if (f === SET_ATTRIBUTE_VALUE) value = sub.readString();
            else sub.skip(wt);
          }
          dispatch = () => this.#sink.setAttribute(id, name, ns, value);
          break;
        }
        case FRAME_SET_PROPERTY: {
          const sub = r.readMessage();
          let id = 0, name = 0;
          let value: PropertyValue = { kind: "none" };
          while (!sub.finished()) {
            const [f, wt] = sub.readTag();
            if (A) check(A.SetProperty, f);
            if (f === SET_PROPERTY_ID) id = sub.readVarint32();
            else if (f === SET_PROPERTY_NAME) name = sub.readVarint32();
            else if (f === SET_PROPERTY_TEXT) {
              value = { kind: "text", value: sub.readString() };
            } else if (f === SET_PROPERTY_INT) {
              value = { kind: "int", value: sub.readSInt64() };
            } else if (f === SET_PROPERTY_FLOAT) {
              value = { kind: "float", value: sub.readDouble() };
            } else if (f === SET_PROPERTY_BOOLEAN) {
              value = { kind: "boolean", value: sub.readBool() };
            } else sub.skip(wt);
          }
          dispatch = () => this.#sink.setProperty(id, name, value);
          break;
        }
        case FRAME_ADD_LISTENER: {
          const sub = r.readMessage();
          let listener: Listener | undefined;
          while (!sub.finished()) {
            const [f, wt] = sub.readTag();
            if (A) check(A.AddListener, f);
            if (f === ADD_LISTENER_LISTENER) {
              listener = decodeListener(sub.readMessage(), A);
            } else sub.skip(wt);
          }
          if (listener) {
            const l = listener;
            dispatch = () => this.#sink.addListener(l);
          }
          break;
        }
        case FRAME_REMOVE_LISTENER: {
          const sub = r.readMessage();
          let listener: Listener | undefined;
          while (!sub.finished()) {
            const [f, wt] = sub.readTag();
            if (A) check(A.RemoveListener, f);
            if (f === REMOVE_LISTENER_LISTENER) {
              listener = decodeListener(sub.readMessage(), A);
            } else sub.skip(wt);
          }
          if (listener) {
            const l = listener;
            dispatch = () => this.#sink.removeListener(l);
          }
          break;
        }
        case FRAME_REGISTER_TEMPLATE: {
          const sub = r.readMessage();
          let id = 0;
          const nodes: TemplateNode[] = [];
          const roots: number[] = [];
          while (!sub.finished()) {
            const [f, wt] = sub.readTag();
            if (A) check(A.RegisterTemplate, f);
            if (f === REGISTER_TEMPLATE_ID) id = sub.readVarint32();
            else if (f === REGISTER_TEMPLATE_NODES) {
              nodes.push(decodeTemplateNode(sub.readMessage(), A));
            } else if (f === REGISTER_TEMPLATE_ROOTS) {
              readPackedOrRepeatedUint32(sub, wt, roots);
            } else sub.skip(wt);
          }
          dispatch = () => this.#sink.registerTemplate(id, nodes, roots);
          break;
        }
        case FRAME_CLONE_TEMPLATE: {
          const sub = r.readMessage();
          let tmpl = 0, root = 0, id = 0;
          while (!sub.finished()) {
            const [f, wt] = sub.readTag();
            if (A) check(A.CloneTemplate, f);
            if (f === CLONE_TEMPLATE_TMPL) tmpl = sub.readVarint32();
            else if (f === CLONE_TEMPLATE_ROOT) root = sub.readVarint32();
            else if (f === CLONE_TEMPLATE_ID) id = sub.readVarint32();
            else sub.skip(wt);
          }
          dispatch = () => this.#sink.cloneTemplate(tmpl, root, id);
          break;
        }
        case FRAME_BIND_PATH: {
          const sub = r.readMessage();
          let root = 0, id = 0;
          let path: Uint8Array = new Uint8Array(0);
          while (!sub.finished()) {
            const [f, wt] = sub.readTag();
            if (A) check(A.BindPath, f);
            if (f === BIND_PATH_ROOT) root = sub.readVarint32();
            else if (f === BIND_PATH_PATH) path = sub.readBytes();
            else if (f === BIND_PATH_ID) id = sub.readVarint32();
            else sub.skip(wt);
          }
          dispatch = () => this.#sink.bindPath(root, path, id);
          break;
        }
        case FRAME_BIND_MARKER: {
          const sub = r.readMessage();
          let key = 0, id = 0;
          while (!sub.finished()) {
            const [f, wt] = sub.readTag();
            if (A) check(A.BindMarker, f);
            if (f === BIND_MARKER_KEY) key = sub.readVarint32();
            else if (f === BIND_MARKER_ID) id = sub.readVarint32();
            else sub.skip(wt);
          }
          dispatch = () => this.#sink.bindMarker(key, id);
          break;
        }
        default:
          // Unknown op field: skip the frame's bytes, still honor commit.
          r.skip(wireType);
      }
    }

    if (!commit && !sawAnyOpField) {
      throw new Error("stream-dom: frame has no op and commit=false");
    }
    if (dispatch) dispatch();
    if (commit) this.#sink.commit();
  }
}
