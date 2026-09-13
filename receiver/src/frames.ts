// Frame decoder: `proto/stream-dom.proto`'s `Frame` message, decoded by the
// ts-proto generated reader in `src/gen/stream-dom.ts` over
// `@bufbuild/protobuf/wire`'s `BinaryReader`, then adapted to `FrameSink`'s
// calls at the dispatch site below. No hand-written wire code — docs/design.md
// "Encoding: protobuf, and why not a hand-rolled layout" records the
// measurement that chose generated readers over the hand-rolled decoder this
// replaces.

import { BinaryReader } from "@bufbuild/protobuf/wire";
import {
  type AddListener,
  Frame,
  Global,
  type Listener as WireListener,
  type RegisterTemplate,
  type RemoveListener,
  type SetAttribute,
  type SetTextControlState as WireTextControlState,
  type TemplateAttr as WireTemplateAttr,
  type TemplateElement as WireTemplateElement,
  type TemplateNode as WireTemplateNode,
} from "./gen/stream-dom.ts";

/** The wire protocol version this receiver implements — the number on
 * proto/stream-dom.proto's `// PROTOCOL VERSION: 2` header line, which is
 * normative (a receiver test re-reads it from the .proto). An additive
 * change (new oneof case, field or enum value) bumps it there and here. */
export const PROTOCOL_VERSION = 2;

/** Strict-mode rejection of wire content this receiver does not know: an
 * open receiver skips it, a receiver enforcing a policy must not
 * (proto/stream-dom.proto header, docs/design.md "Policy"). Off the hot
 * path — the strict walk runs only when strict mode is on. */
function unknownField(field: number, message: string): never {
  throw new Error(
    `stream-dom: unknown field ${field} in ${message} (receiver PROTOCOL_VERSION ${PROTOCOL_VERSION})`,
  );
}

/** Lowest oneof `op` field number in `Frame` — an unknown field at or above
 * it is an op case from a future schema version, so it counts as "some op
 * field was present" for the no-op/no-commit check below. */
const FRAME_OP_FIELD_MIN = 2;

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

/** `SetAttribute.value` / `TemplateAttr.value`'s oneof
 * (proto/stream-dom.proto): a literal string, or an opaque asset handle
 * the receiver materializes into a URL through its `resolveAsset` hook —
 * the producer never names a URL through it. */
export type AttrValue =
  | { kind: "text"; value: string }
  | { kind: "asset"; handle: Uint8Array };

export type PropertyValue =
  | { kind: "text"; value: string }
  | { kind: "int"; value: number }
  | { kind: "float"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "none" };

export interface TextControlState {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  direction: "none" | "forward" | "backward";
}

export interface TemplateAttr {
  name: number;
  ns: number | undefined;
  value: AttrValue;
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
    value: AttrValue | undefined,
  ): void;
  setProperty(id: number, name: number, value: PropertyValue): void;
  setTextControlState(id: number, state: TextControlState): void;
  addListener(listener: Listener): void;
  removeListener(listener: Listener): void;
  registerTemplate(id: number, nodes: TemplateNode[], roots: number[]): void;
  cloneTemplate(tmpl: number, root: number, id: number): void;
  bindPath(root: number, path: Uint8Array, id: number): void;
  bindMarker(key: number, id: number): void;
  commit(): void;
}

// -- generated message -> FrameSink shapes --------------------------------

/** `SetAttribute.value` / `TemplateAttr.value`. `BinaryReader.bytes()`
 * returns a VIEW over the decode buffer, while this decoder's buffer is
 * reused across `push` calls (and, under the direct transport, aliases
 * guest memory that is invalid once the read callback returns), so an
 * asset handle retained past this call must own its bytes: `.slice()`. */
function attrValue(m: SetAttribute | WireTemplateAttr): AttrValue | undefined {
  const v = m.value;
  if (v === undefined) return undefined;
  if (v.$case === "text") return { kind: "text", value: v.value };
  return { kind: "asset", handle: v.value.slice() };
}

function listener(m: WireListener): Listener {
  const t = m.target;
  let target: ListenerTarget;
  if (t === undefined) {
    // Proto3 `oneof` has no default case: neither field set is a genuine
    // absence, not "id 0" (which IS the mount root and a legal target).
    throw new Error(
      "stream-dom: Listener has no target (neither id nor global set)",
    );
  } else if (t.$case === "id") {
    target = { kind: "node", id: t.value };
  } else if (t.value === Global.WINDOW) {
    target = { kind: "window" };
  } else if (t.value === Global.DOCUMENT) {
    target = { kind: "document" };
  } else {
    throw new Error(`stream-dom: Listener.global unknown value ${t.value}`);
  }
  return {
    target,
    name: m.name,
    bubbles: m.bubbles,
    capture: m.capture,
    passive: m.passive,
    preventDefault: m.preventDefault,
    stopPropagation: m.stopPropagation,
  };
}

function templateAttrs(ms: WireTemplateAttr[]): TemplateAttr[] {
  const out: TemplateAttr[] = [];
  for (const a of ms) {
    // No `value` case set keeps the proto3 default, an empty text value.
    out.push({
      name: a.name,
      ns: a.ns,
      value: attrValue(a) ?? { kind: "text", value: "" },
    });
  }
  return out;
}

function templateElement(e: WireTemplateElement): TemplateElement {
  return {
    tag: e.tag,
    ns: e.ns,
    attrs: templateAttrs(e.attrs),
    children: e.children,
  };
}

function templateNodes(
  ms: WireTemplateNode[],
  strict: boolean,
): TemplateNode[] {
  const out: TemplateNode[] = [];
  for (const n of ms) {
    const kind = n.kind;
    if (kind === undefined) {
      // A `TemplateNode` naming no kind is wire content this receiver
      // cannot act on, so strict mode rejects it — with its own message,
      // since an absent oneof has no field number to report. Non-strict
      // keeps the proto3 default (an empty text node).
      if (strict) {
        throw new Error(
          `stream-dom: TemplateNode has no kind set (receiver PROTOCOL_VERSION ${PROTOCOL_VERSION})`,
        );
      }
      out.push({ kind: "text", text: "" });
    } else if (kind.$case === "text") {
      out.push({ kind: "text", text: kind.value });
    } else if (kind.$case === "dynamic") {
      out.push({ kind: "dynamic" });
    } else {
      out.push({ kind: "element", element: templateElement(kind.value) });
    }
  }
  return out;
}

// -- strict-mode unknown-field walk ---------------------------------------

/** Every generated message carries `_unknownFields` (`unknownFields=true`),
 * keyed by the full tag; the field number is `tag >>> 3`. Empty (`{}`) when
 * the message had none. */
interface MaybeUnknown {
  _unknownFields?: { [key: number]: Uint8Array[] } | undefined;
}

function checkUnknown(m: MaybeUnknown, name: string): void {
  const u = m._unknownFields;
  if (u === undefined) return;
  for (const tag in u) {
    unknownField(Number(tag) >>> 3, name);
  }
}

/** Does `frame` carry an unknown field whose number is an `op` field
 * number — an op case from a future schema version? Reproduces the old
 * decoder's `sawAnyOpField` for cases it cannot decode. */
function sawUnknownOpField(frame: Frame): boolean {
  const u = frame._unknownFields;
  if (u === undefined) return false;
  for (const tag in u) {
    if ((Number(tag) >>> 3) >= FRAME_OP_FIELD_MIN) return true;
  }
  return false;
}

function checkListenerUnknown(m: AddListener | RemoveListener): void {
  const l = m.listener;
  if (l !== undefined) checkUnknown(l, "Listener");
}

function checkTemplateUnknown(m: RegisterTemplate): void {
  for (const n of m.nodes) {
    checkUnknown(n, "TemplateNode");
    const kind = n.kind;
    if (kind !== undefined && kind.$case === "element") {
      checkUnknown(kind.value, "TemplateElement");
      for (const a of kind.value.attrs) checkUnknown(a, "TemplateAttr");
    }
  }
}

function textControlState(m: WireTextControlState): TextControlState {
  const direction = m.direction;
  return {
    value: m.value,
    selectionStart: m.selectionStart,
    selectionEnd: m.selectionEnd,
    direction: direction === 1
      ? "forward"
      : direction === 2
      ? "backward"
      : "none",
  };
}

/** Reject anything on the wire this receiver does not know, in the same
 * message-name vocabulary the hand-rolled decoder used. Runs only in
 * strict mode; the non-strict path never touches `_unknownFields`. */
function checkFrameStrict(frame: Frame): void {
  checkUnknown(frame, "Frame");
  const op = frame.op;
  if (op === undefined) return;
  switch (op.$case) {
    case "intern":
      checkUnknown(op.value, "Intern");
      break;
    case "createElement":
      checkUnknown(op.value, "CreateElement");
      break;
    case "createText":
      checkUnknown(op.value, "CreateText");
      break;
    case "createPlaceholder":
      checkUnknown(op.value, "CreatePlaceholder");
      break;
    case "insertBefore":
      checkUnknown(op.value, "InsertBefore");
      break;
    case "insertAfter":
      checkUnknown(op.value, "InsertAfter");
      break;
    case "remove":
      checkUnknown(op.value, "Remove");
      break;
    case "setText":
      checkUnknown(op.value, "SetText");
      break;
    case "setAttribute":
      checkUnknown(op.value, "SetAttribute");
      break;
    case "setProperty":
      checkUnknown(op.value, "SetProperty");
      break;
    case "setTextControlState":
      checkUnknown(op.value, "SetTextControlState");
      if (op.value.direction < 0 || op.value.direction > 2) {
        throw new Error(
          `stream-dom: SetTextControlState.direction unknown value ${op.value.direction}`,
        );
      }
      break;
    case "addListener":
      checkUnknown(op.value, "AddListener");
      checkListenerUnknown(op.value);
      break;
    case "removeListener":
      checkUnknown(op.value, "RemoveListener");
      checkListenerUnknown(op.value);
      break;
    case "registerTemplate":
      checkUnknown(op.value, "RegisterTemplate");
      checkTemplateUnknown(op.value);
      break;
    case "cloneTemplate":
      checkUnknown(op.value, "CloneTemplate");
      break;
    case "bindPath":
      checkUnknown(op.value, "BindPath");
      break;
    case "bindMarker":
      checkUnknown(op.value, "BindMarker");
      break;
  }
}

/** Hard ceiling on one frame's length prefix. A `uint32` varint can
 * announce up to 4 GiB, and `#drain` would otherwise buffer every
 * subsequent chunk forever waiting for bytes a hostile (or broken)
 * producer never sends — an unbounded-memory hang rather than an abort.
 * 16 MiB is far above any frame a real producer emits (the largest is a
 * `RegisterTemplate` arena) and far below a memory problem; over it the
 * decoder throws immediately, which aborts the stream
 * (docs/design.md "Policy", "The seam"). */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** A `uint32` varint is at most 5 bytes. `BinaryReader.uint32()` does not
 * enforce that — it keeps consuming continuation bytes and wraps — and it
 * reports "ran out of bytes" and "never terminated" the same way, so the
 * length probe below bounds the width itself. */
const MAX_VARINT32_BYTES = 5;

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
  /** Reject wire content this receiver does not know instead of skipping
   * it — see `unknownField`. `createDriver` turns this on whenever a
   * policy is configured; the default `false` is exactly the tolerant
   * proto3 behaviour docs/design.md describes ("receivers skip what they
   * do not know"), which is what an open receiver wants. */
  #strict: boolean;

  constructor(sink: FrameSink, options?: { strict?: boolean }) {
    this.#sink = sink;
    this.#strict = options?.strict ?? false;
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
    // One reader for the whole pending buffer: the length probe and the
    // frame bodies share it (`Frame.decode(reader, len)` decodes in place),
    // so a frame costs no allocation beyond the message objects. The
    // reader's own bound is therefore the whole buffer, not the frame —
    // the per-frame bound is the position check after each decode below.
    const reader = new BinaryReader(buf);
    for (;;) {
      const lenStart = offset;
      let len: number;
      let malformedPrefix = false;
      try {
        reader.pos = lenStart;
        len = reader.uint32();
        // Terminated, but only past the legal width for a u32: the value
        // read is meaningless (`varint32read` keeps consuming continuation
        // bytes and wraps), so it is as malformed as one that never
        // terminated at all.
        malformedPrefix = reader.pos - lenStart > MAX_VARINT32_BYTES;
      } catch (err) {
        // A genuine truncation (fewer bytes buffered than the varint
        // needs) means "wait for more". The same `RangeError("premature
        // EOF")` raised with all five legal bytes present means the varint
        // is malformed, not incomplete — a real protocol error, which must
        // not be treated as a buffering situation forever.
        if (!(err instanceof RangeError)) throw err;
        if (buf.length - lenStart < MAX_VARINT32_BYTES) break;
        len = 0;
        malformedPrefix = true;
      }
      if (malformedPrefix) {
        throw new RangeError(
          "stream-dom: frame length prefix is not a valid u32 varint",
        );
      }
      const bodyStart = reader.pos;
      if (len > MAX_FRAME_BYTES) {
        throw new Error(
          `stream-dom: frame length ${len} exceeds MAX_FRAME_BYTES (${MAX_FRAME_BYTES})`,
        );
      }
      if (bodyStart + len > buf.length) {
        offset = lenStart; // Frame body straddles the buffer — wait for more.
        break;
      }
      // Only the length probe above may treat a premature EOF as "wait for
      // more" — it is deliberately outside this decode.
      const frameEnd = bodyStart + len;
      const frame = Frame.decode(reader, len);
      if (reader.pos !== frameEnd) {
        // The frame's own length is the only bound the shared reader has:
        // a sub-message whose length runs past the frame end reads into
        // the NEXT frame's bytes (over-consumption), and the generated
        // decoder stops early — without throwing — on a zero tag or an
        // end-group tag (under-consumption). Both are malformed frames in
        // BOTH modes: a zero tag is invalid protobuf (field number 0 does
        // not exist), and this receiver does not guess where a frame that
        // does not fill its own length was meant to end.
        throw new Error(
          `stream-dom: malformed frame: decoder consumed ${
            reader.pos - bodyStart
          } of ${len} bytes`,
        );
      }
      offset = frameEnd;
      this.#decodeFrame(frame);
    }
    this.#pending = buf.subarray(offset);
  }

  #decodeFrame(frame: Frame): void {
    this.#frameCount++;
    if (this.#strict) checkFrameStrict(frame);

    const op = frame.op;
    if (op === undefined) {
      // An unknown field at an op field number is an op case this receiver
      // does not know (a future schema version): the frame is skipped, but
      // it did carry an op.
      if (!frame.commit && !sawUnknownOpField(frame)) {
        throw new Error("stream-dom: frame has no op and commit=false");
      }
    } else {
      const sink = this.#sink;
      switch (op.$case) {
        case "intern":
          sink.internString(op.value.id, op.value.s);
          break;
        case "createElement":
          sink.createElement(op.value.id, op.value.tag, op.value.ns);
          break;
        case "createText":
          sink.createText(op.value.id, op.value.text);
          break;
        case "createPlaceholder":
          sink.createPlaceholder(op.value.id);
          break;
        case "insertBefore":
          sink.insertBefore(op.value.parent, op.value.id, op.value.anchor);
          break;
        case "insertAfter":
          sink.insertAfter(op.value.parent, op.value.id, op.value.anchor);
          break;
        case "remove":
          sink.remove(op.value.id);
          break;
        case "setText":
          sink.setText(op.value.id, op.value.text);
          break;
        case "setAttribute":
          sink.setAttribute(
            op.value.id,
            op.value.name,
            op.value.ns,
            attrValue(op.value),
          );
          break;
        case "setProperty": {
          const v = op.value.value;
          let value: PropertyValue;
          if (v === undefined) value = { kind: "none" };
          else if (v.$case === "text") value = { kind: "text", value: v.value };
          else if (v.$case === "int") value = { kind: "int", value: v.value };
          else if (v.$case === "float") {
            value = { kind: "float", value: v.value };
          } else value = { kind: "boolean", value: v.value };
          sink.setProperty(op.value.id, op.value.name, value);
          break;
        }
        case "setTextControlState":
          sink.setTextControlState(op.value.id, textControlState(op.value));
          break;
        case "addListener": {
          // A present `AddListener` with no `Listener` set names no
          // registration to make: the op field was there, so the frame is
          // not "no op", but there is nothing to dispatch.
          const l = op.value.listener;
          if (l !== undefined) sink.addListener(listener(l));
          break;
        }
        case "removeListener": {
          const l = op.value.listener;
          if (l !== undefined) sink.removeListener(listener(l));
          break;
        }
        case "registerTemplate":
          sink.registerTemplate(
            op.value.id,
            templateNodes(op.value.nodes, this.#strict),
            op.value.roots,
          );
          break;
        case "cloneTemplate":
          sink.cloneTemplate(op.value.tmpl, op.value.root, op.value.id);
          break;
        case "bindPath":
          // Copied, not aliased — see `attrValue`.
          sink.bindPath(op.value.root, op.value.path.slice(), op.value.id);
          break;
        case "bindMarker":
          sink.bindMarker(op.value.key, op.value.id);
          break;
      }
    }

    if (frame.commit) this.#sink.commit();
  }
}
