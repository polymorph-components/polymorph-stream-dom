// Policy MVP: the protocol version constant, strict decoding, the
// `PolicySink` vocabulary seam, and the asset attribute-value arm.
// Governing docs: proto/stream-dom.proto (field numbers, the
// `// PROTOCOL VERSION` header line), docs/design.md "Policy".

import { assertEquals, assertThrows } from "@std/assert";
import { FrameDecoder, PROTOCOL_VERSION } from "../src/frames.ts";
import type {
  AttrValue,
  FrameSink,
  Listener,
  PropertyValue,
  TemplateNode,
} from "../src/frames.ts";
import { assertPolicyVersion, PolicyError, PolicySink } from "../src/policy.ts";
import type { Policy, PolicyOp } from "../src/policy.ts";
import { BinaryWriter } from "@bufbuild/protobuf/wire";
import { Frame } from "../src/gen/stream-dom.ts";
import { frame } from "./wire.ts";
import { RemoteDomTranscoder } from "../src/remote.ts";
import type { RemoteConnection, RemoteMutationRecord } from "@remote-dom/core";

// -- harness -------------------------------------------------------------

type Call =
  | { op: "internString"; id: number; s: string }
  | { op: "createElement"; id: number; tag: number; ns: number | undefined }
  | { op: "createText"; id: number; text: string }
  | { op: "createPlaceholder"; id: number }
  | {
    op: "setAttribute";
    id: number;
    name: number;
    ns: number | undefined;
    value: AttrValue | undefined;
  }
  | { op: "setProperty"; id: number; name: number; value: PropertyValue }
  | { op: "addListener"; listener: Listener }
  | {
    op: "registerTemplate";
    id: number;
    nodes: TemplateNode[];
    roots: number[];
  }
  | { op: "cloneTemplate"; tmpl: number; root: number; id: number }
  | { op: "bindPath"; root: number; path: Uint8Array; id: number }
  | { op: "bindMarker"; key: number; id: number }
  | { op: "commit" };

/** Records the calls that reach the INNER sink — same pattern as
 * frames_test.ts's, trimmed to the ops these tests drive. */
class RecordingSink implements FrameSink {
  calls: Call[] = [];
  internString(id: number, s: string): void {
    this.calls.push({ op: "internString", id, s });
  }
  createElement(id: number, tag: number, ns: number | undefined): void {
    this.calls.push({ op: "createElement", id, tag, ns });
  }
  createText(id: number, text: string): void {
    this.calls.push({ op: "createText", id, text });
  }
  createPlaceholder(id: number): void {
    this.calls.push({ op: "createPlaceholder", id });
  }
  insertBefore(): void {}
  insertAfter(): void {}
  remove(): void {}
  setText(): void {}
  setAttribute(
    id: number,
    name: number,
    ns: number | undefined,
    value: AttrValue | undefined,
  ): void {
    this.calls.push({ op: "setAttribute", id, name, ns, value });
  }
  setProperty(id: number, name: number, value: PropertyValue): void {
    this.calls.push({ op: "setProperty", id, name, value });
  }
  setTextControlState(): void {}
  addListener(listener: Listener): void {
    this.calls.push({ op: "addListener", listener });
  }
  removeListener(): void {}
  registerTemplate(id: number, nodes: TemplateNode[], roots: number[]): void {
    this.calls.push({ op: "registerTemplate", id, nodes, roots });
  }
  cloneTemplate(tmpl: number, root: number, id: number): void {
    this.calls.push({ op: "cloneTemplate", tmpl, root, id });
  }
  bindPath(root: number, path: Uint8Array, id: number): void {
    this.calls.push({ op: "bindPath", root, path, id });
  }
  bindMarker(key: number, id: number): void {
    this.calls.push({ op: "bindMarker", key, id });
  }
  commit(): void {
    this.calls.push({ op: "commit" });
  }
}

/** One length-delimited `Frame` on the wire, from a generated-writer
 * body. */
function wellFormed(op: Frame["op"], commit = false): Uint8Array {
  return frame(Frame.encode({ commit, op }).finish());
}

/** A policy that records what it saw and rejects whatever `reject` says. */
function recordingPolicy(
  reject: (op: PolicyOp) => string | undefined = () => undefined,
): { policy: Policy; seen: PolicyOp[] } {
  const seen: PolicyOp[] = [];
  return {
    seen,
    policy: {
      version: PROTOCOL_VERSION,
      check(op) {
        seen.push(op);
        return reject(op);
      },
    },
  };
}

const listener = (name: number, target: Listener["target"]): Listener => ({
  target,
  name,
  bubbles: true,
  capture: true,
  passive: false,
  preventDefault: true,
  stopPropagation: false,
});

// -- PROTOCOL_VERSION ----------------------------------------------------

Deno.test("PROTOCOL_VERSION matches proto/stream-dom.proto's header line", async () => {
  const proto = await Deno.readTextFile(
    new URL("../../proto/stream-dom.proto", import.meta.url),
  );
  const matches = [...proto.matchAll(/^\/\/ PROTOCOL VERSION: (\d+)$/gm)];
  assertEquals(matches.length, 1); // machine-read: exactly one, exact form
  assertEquals(Number(matches[0][1]), PROTOCOL_VERSION);
});

// -- strict decoding -----------------------------------------------------

Deno.test("strict decoder rejects an unknown Frame op field; open decoder skips it", () => {
  // Field 30 is not an op this receiver knows (Frame's ops stop at 17).
  const body = new BinaryWriter();
  body.uint32((1 << 3) | 0).bool(true); // Frame.commit
  body.uint32((30 << 3) | 2).fork().uint32((1 << 3) | 0).uint32(5).join();
  const bytes = frame(body.finish());

  const open = new RecordingSink();
  new FrameDecoder(open).push(bytes);
  assertEquals(open.calls, [{ op: "commit" }]);

  const strict = new RecordingSink();
  assertThrows(
    () => new FrameDecoder(strict, { strict: true }).push(bytes),
    Error,
    `stream-dom: unknown field 30 in Frame (receiver PROTOCOL_VERSION ${PROTOCOL_VERSION})`,
  );
});

Deno.test("strict decoder rejects an unknown sub-message field; open decoder skips it", () => {
  // CreateElement { id: 7, tag: 1, <unknown field 9> }.
  const body = new BinaryWriter();
  body.uint32((6 << 3) | 2).fork()
    .uint32((1 << 3) | 0).uint32(7)
    .uint32((2 << 3) | 0).uint32(1)
    .uint32((9 << 3) | 0).uint32(123)
    .join();
  const bytes = frame(body.finish());

  const open = new RecordingSink();
  new FrameDecoder(open).push(bytes);
  assertEquals(open.calls, [
    { op: "createElement", id: 7, tag: 1, ns: undefined },
  ]);

  const strict = new RecordingSink();
  assertThrows(
    () => new FrameDecoder(strict, { strict: true }).push(bytes),
    Error,
    `stream-dom: unknown field 9 in CreateElement (receiver PROTOCOL_VERSION ${PROTOCOL_VERSION})`,
  );
});

Deno.test("strict decoder checks SetTextControlState fields", () => {
  const body = new BinaryWriter();
  body.uint32((18 << 3) | 2).fork()
    .uint32((1 << 3) | 0).uint32(7)
    .uint32((2 << 3) | 2).string("abc")
    .uint32((6 << 3) | 0).uint32(1)
    .join();
  const bytes = frame(body.finish());
  new FrameDecoder(new RecordingSink()).push(bytes);
  assertThrows(
    () => new FrameDecoder(new RecordingSink(), { strict: true }).push(bytes),
    Error,
    `stream-dom: unknown field 6 in SetTextControlState (receiver PROTOCOL_VERSION ${PROTOCOL_VERSION})`,
  );
});

Deno.test("strict decoder rejects an unknown text-control selection direction", () => {
  const body = new BinaryWriter();
  body.uint32((18 << 3) | 2).fork()
    .uint32((1 << 3) | 0).uint32(7)
    .uint32((2 << 3) | 2).string("abc")
    .uint32((5 << 3) | 0).int32(99)
    .join();
  const bytes = frame(body.finish());
  new FrameDecoder(new RecordingSink()).push(bytes);
  assertThrows(
    () => new FrameDecoder(new RecordingSink(), { strict: true }).push(bytes),
    Error,
    "stream-dom: SetTextControlState.direction unknown value 99",
  );
});

Deno.test("an unknown Global enum value is rejected in both modes", () => {
  // Listener.global = 99, a value outside the `Global` enum: built by hand
  // because the generated writer's `Global` type admits only the two.
  const body = new BinaryWriter();
  body.uint32((12 << 3) | 2).fork()
    .uint32((1 << 3) | 2).fork()
    .uint32((8 << 3) | 0).int32(99)
    .join()
    .join();
  const bytes = frame(body.finish());
  for (const strict of [false, true]) {
    assertThrows(
      () => new FrameDecoder(new RecordingSink(), { strict }).push(bytes),
      Error,
      "stream-dom: Listener.global unknown value 99",
    );
  }
});

// -- asset attribute values ----------------------------------------------

Deno.test("SetAttribute's asset arm (field 5) decodes to an asset handle", () => {
  const handle = Uint8Array.of(0, 1, 2, 3);
  const bytes = wellFormed({
    $case: "setAttribute",
    value: {
      id: 10,
      name: 3,
      ns: undefined,
      value: { $case: "asset", value: handle },
    },
  });
  const sink = new RecordingSink();
  new FrameDecoder(sink).push(bytes);
  assertEquals(sink.calls, [{
    op: "setAttribute",
    id: 10,
    name: 3,
    ns: undefined,
    value: { kind: "asset", handle },
  }]);
});

Deno.test("TemplateAttr's asset arm (field 4) decodes to an asset handle", () => {
  const handle = Uint8Array.of(9, 8);
  const bytes = wellFormed({
    $case: "registerTemplate",
    value: {
      id: 1,
      nodes: [{
        kind: {
          $case: "element",
          value: {
            tag: 1,
            ns: undefined,
            attrs: [{
              name: 3,
              ns: undefined,
              value: { $case: "asset", value: handle },
            }],
            children: [],
          },
        },
      }],
      roots: [0],
    },
  });
  const sink = new RecordingSink();
  new FrameDecoder(sink).push(bytes);
  const call = sink.calls[0];
  if (call.op !== "registerTemplate") throw new Error("expected a template");
  const node = call.nodes[0];
  if (node.kind !== "element") throw new Error("expected an element node");
  assertEquals(node.element.attrs[0].value, { kind: "asset", handle });
});

// -- assertPolicyVersion --------------------------------------------------

Deno.test("assertPolicyVersion passes on a match and throws on a mismatch", () => {
  assertPolicyVersion({ version: PROTOCOL_VERSION, check: () => undefined });
  assertThrows(
    () =>
      assertPolicyVersion({
        version: PROTOCOL_VERSION + 1,
        check: () => undefined,
      }),
    Error,
    `stream-dom: policy pins protocol version ${
      PROTOCOL_VERSION + 1
    }, receiver is ${PROTOCOL_VERSION}`,
  );
});

// -- PolicySink -----------------------------------------------------------

Deno.test("PolicySink resolves interned strings and the element tag by id", () => {
  const inner = new RecordingSink();
  const { policy, seen } = recordingPolicy();
  const sink = new PolicySink(inner, policy);

  sink.internString(1, "div");
  sink.internString(2, "class");
  sink.internString(3, "http://www.w3.org/2000/svg");
  sink.internString(4, "click");
  sink.createElement(10, 1, 3);
  sink.setAttribute(10, 2, 3, { kind: "text", value: "row" });
  sink.setProperty(10, 2, { kind: "boolean", value: true });
  sink.addListener(listener(4, { kind: "node", id: 10 }));

  assertEquals(seen, [
    { op: "createElement", tag: "div", ns: "http://www.w3.org/2000/svg" },
    {
      op: "setAttribute",
      tag: "div",
      name: "class",
      ns: "http://www.w3.org/2000/svg",
      value: { kind: "text", value: "row" },
    },
    {
      op: "setProperty",
      tag: "div",
      name: "class",
      value: { kind: "boolean", value: true },
    },
    {
      op: "addListener",
      target: "node",
      name: "click",
      capture: true,
      passive: false,
      preventDefault: true,
      stopPropagation: false,
    },
  ]);
  // Allowed ops forward with identical arguments.
  assertEquals(inner.calls, [
    { op: "internString", id: 1, s: "div" },
    { op: "internString", id: 2, s: "class" },
    { op: "internString", id: 3, s: "http://www.w3.org/2000/svg" },
    { op: "internString", id: 4, s: "click" },
    { op: "createElement", id: 10, tag: 1, ns: 3 },
    {
      op: "setAttribute",
      id: 10,
      name: 2,
      ns: 3,
      value: { kind: "text", value: "row" },
    },
    {
      op: "setProperty",
      id: 10,
      name: 2,
      value: { kind: "boolean", value: true },
    },
    { op: "addListener", listener: listener(4, { kind: "node", id: 10 }) },
  ]);
});

Deno.test("PolicySink maps window and document listener targets", () => {
  const { policy, seen } = recordingPolicy();
  const sink = new PolicySink(new RecordingSink(), policy);
  sink.internString(1, "popstate");
  sink.addListener(listener(1, { kind: "window" }));
  sink.addListener(listener(1, { kind: "document" }));
  assertEquals(seen.map((op) => op.op === "addListener" && op.target), [
    "window",
    "document",
  ]);
});

/** Arena: div[class] > (text, span, dynamic hole) — a path step to the
 * span crosses a non-element child, which is exactly what makes the
 * arena walk have to mirror `childNodes` rather than "elements only". */
const arena: TemplateNode[] = [
  {
    kind: "element",
    element: {
      tag: 1,
      ns: undefined,
      attrs: [{
        name: 2,
        ns: undefined,
        value: { kind: "text", value: "row" },
      }],
      children: [1, 2, 3],
    },
  },
  { kind: "text", text: "x" },
  {
    kind: "element",
    element: { tag: 5, ns: undefined, attrs: [], children: [] },
  },
  { kind: "dynamic" },
];

function templateSink(): {
  sink: PolicySink;
  inner: RecordingSink;
  seen: PolicyOp[];
} {
  const inner = new RecordingSink();
  const { policy, seen } = recordingPolicy();
  const sink = new PolicySink(inner, policy);
  sink.internString(1, "div");
  sink.internString(2, "class");
  sink.internString(5, "span");
  return { sink, inner, seen };
}

Deno.test("PolicySink flattens registerTemplate into per-element/per-attr checks, then forwards", () => {
  const { sink, inner, seen } = templateSink();
  sink.registerTemplate(7, arena, [0]);

  assertEquals(seen, [
    { op: "createElement", tag: "div", ns: undefined },
    {
      op: "setAttribute",
      tag: "div",
      name: "class",
      ns: undefined,
      value: { kind: "text", value: "row" },
    },
    { op: "createElement", tag: "span", ns: undefined },
  ]);
  // ... and only THEN forwards, once.
  assertEquals(inner.calls.slice(3), [
    { op: "registerTemplate", id: 7, nodes: arena, roots: [0] },
  ]);
});

Deno.test("PolicySink tracks tags through cloneTemplate and bindPath, undefined for a text node", () => {
  const { sink, seen } = templateSink();
  sink.registerTemplate(7, arena, [0]);
  const before = seen.length;

  sink.cloneTemplate(7, 0, 100);
  sink.bindPath(100, Uint8Array.of(0), 101); // child 0: the text node
  // Child 1 is the span — the step counts the text node before it, as a
  // `childNodes` walk does, not "elements only".
  sink.bindPath(100, Uint8Array.of(1), 102);
  assertEquals(seen.length, before); // neither op is shown to the policy

  sink.setAttribute(100, 2, undefined, undefined);
  sink.setAttribute(101, 2, undefined, undefined);
  sink.setAttribute(102, 2, undefined, undefined);
  sink.setAttribute(999, 2, undefined, undefined); // never-seen id
  assertEquals(
    seen.slice(before).map((op) => op.op === "setAttribute" && op.tag),
    ["div", undefined, "span", undefined],
  );
});

Deno.test("PolicySink takes template tags from registration, not from a later re-intern", () => {
  const inner = new RecordingSink();
  const { policy, seen } = recordingPolicy();
  const sink = new PolicySink(inner, policy);

  sink.internString(9, "a");
  sink.registerTemplate(7, [{
    kind: "element",
    element: { tag: 9, ns: undefined, attrs: [], children: [] },
  }], [0]);
  // The producer overwrites the slot (proto `Intern`: "Define (or
  // overwrite) interned slot"). The backend's prototype is still an <a> —
  // it was built at registration — so the policy must keep judging this
  // node's attributes as an <a>.
  sink.internString(9, "div");
  sink.cloneTemplate(7, 0, 100);
  sink.internString(2, "href");
  sink.setAttribute(100, 2, undefined, { kind: "text", value: "/x" });

  assertEquals(seen.at(-1), {
    op: "setAttribute",
    tag: "a",
    name: "href",
    ns: undefined,
    value: { kind: "text", value: "/x" },
  });
});

Deno.test("PolicySink throws PolicyError with the op index and does not forward the op", () => {
  const inner = new RecordingSink();
  const { policy } = recordingPolicy((op) =>
    op.op === "createElement" && op.tag === "script"
      ? "script elements are not in the host vocabulary"
      : undefined
  );
  const sink = new PolicySink(inner, policy);

  sink.internString(1, "div"); // op 0
  sink.internString(2, "script"); // op 1
  sink.createElement(10, 1, undefined); // op 2 — allowed
  sink.createText(11, "hi"); // op 3 — never shown, but counted
  sink.commit(); // NOT counted

  const err = assertThrows(
    () => sink.createElement(12, 2, undefined), // op 4 — rejected
    PolicyError,
    "stream-dom: policy rejected createElement #4: script elements are not in the host vocabulary",
  ) as PolicyError;
  assertEquals(err.opIndex, 4);
  assertEquals(err.op, {
    op: "createElement",
    tag: "script",
    ns: undefined,
  });
  assertEquals(err.reason, "script elements are not in the host vocabulary");

  // The rejected op never reached the inner sink.
  assertEquals(inner.calls.filter((c) => c.op === "createElement"), [
    { op: "createElement", id: 10, tag: 1, ns: undefined },
  ]);
});

// -- backend asset resolution --------------------------------------------
//
// The remote backend, over a fake `RemoteConnection` — the same harness
// remote_test.ts uses. The native backend's asset path is in
// native_test.ts, which has a real-ish DOM (linkedom) to assert against.

class FakeConnection implements RemoteConnection {
  batches: RemoteMutationRecord[][] = [];
  mutate(records: readonly RemoteMutationRecord[]): void {
    this.batches.push([...records]);
  }
  call(): unknown {
    throw new Error("not used by these tests");
  }
}

Deno.test("RemoteDomTranscoder resolves an asset attribute value through the hook", () => {
  const conn = new FakeConnection();
  const seen: Uint8Array[] = [];
  const t = new RemoteDomTranscoder(conn, null, (handle) => {
    seen.push(handle);
    return `/assets/${handle.join("-")}`;
  });
  t.internString(1, "img");
  t.internString(2, "src");
  t.createElement(10, 1, undefined);
  t.insertBefore(0, 10, undefined);
  t.setAttribute(10, 2, undefined, {
    kind: "asset",
    handle: Uint8Array.of(1, 2),
  });
  t.commit();

  assertEquals(seen, [Uint8Array.of(1, 2)]);
  const record = conn.batches[0].at(-1)!;
  assertEquals(record[3], "/assets/1-2");
});

Deno.test("an asset value with no resolveAsset configured is an error", () => {
  const t = new RemoteDomTranscoder(new FakeConnection());
  t.internString(1, "img");
  t.internString(2, "src");
  t.createElement(10, 1, undefined);
  assertThrows(
    () =>
      t.setAttribute(10, 2, undefined, {
        kind: "asset",
        handle: Uint8Array.of(7),
      }),
    Error,
    "stream-dom: asset attribute value but no resolveAsset configured",
  );
  // Template attrs resolve at registerTemplate time, same error.
  assertThrows(
    () =>
      t.registerTemplate(1, [{
        kind: "element",
        element: {
          tag: 1,
          ns: undefined,
          attrs: [{
            name: 2,
            ns: undefined,
            value: { kind: "asset", handle: Uint8Array.of(7) },
          }],
          children: [],
        },
      }], [0]),
    Error,
    "stream-dom: asset attribute value but no resolveAsset configured",
  );
});
