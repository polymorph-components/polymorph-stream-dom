import { assertEquals, assertThrows } from "@std/assert";
import {
  MUTATION_TYPE_INSERT_CHILD,
  MUTATION_TYPE_REMOVE_CHILD,
  MUTATION_TYPE_UPDATE_PROPERTY,
  MUTATION_TYPE_UPDATE_TEXT,
  NODE_TYPE_ELEMENT,
  ROOT_ID,
} from "@remote-dom/core";
import type { RemoteConnection, RemoteMutationRecord } from "@remote-dom/core";
import { RemoteDomTranscoder } from "../src/remote.ts";
import type { Listener, TemplateNode } from "../src/frames.ts";

class FakeConnection implements RemoteConnection {
  batches: RemoteMutationRecord[][] = [];
  mutate(records: readonly RemoteMutationRecord[]): void {
    this.batches.push([...records]);
  }
  call(): unknown {
    throw new Error("not used by these tests");
  }
}

function transcoder(): { t: RemoteDomTranscoder; conn: FakeConnection } {
  const conn = new FakeConnection();
  return { t: new RemoteDomTranscoder(conn), conn };
}

Deno.test("mount: one INSERT_CHILD with nested children", () => {
  const { t, conn } = transcoder();
  t.internString(1, "div");
  t.internString(2, "span");
  t.createElement(10, 1, undefined); // <div id=10>
  t.createElement(11, 2, undefined); // <span id=11>
  t.createText(12, "hi");
  t.insertBefore(11, 12, undefined); // span gets text child (still detached)
  t.insertBefore(10, 11, undefined); // div gets span child (still detached)
  t.insertBefore(0, 10, undefined); // div attaches under root -> ONE record
  t.commit();

  assertEquals(conn.batches.length, 1);
  const [record] = conn.batches[0];
  assertEquals(record[0], MUTATION_TYPE_INSERT_CHILD);
  assertEquals(record[1], ROOT_ID);
  const child = record[2] as unknown as {
    type: number;
    element: string;
    children: unknown[];
  };
  assertEquals(child.type, NODE_TYPE_ELEMENT);
  assertEquals(child.element, "div");
  assertEquals(child.children.length, 1);
  const span = child.children[0] as { element: string; children: unknown[] };
  assertEquals(span.element, "span");
  assertEquals(span.children.length, 1);
  assertEquals(record[3], 0); // index
});

Deno.test("attribute update on an attached node", () => {
  const { t, conn } = transcoder();
  t.internString(1, "div");
  t.internString(2, "class");
  t.createElement(10, 1, undefined);
  t.insertBefore(0, 10, undefined);
  t.commit();
  conn.batches.length = 0;

  t.setAttribute(10, 2, undefined, "greeting");
  t.commit();

  assertEquals(conn.batches.length, 1);
  assertEquals(conn.batches[0][0], [
    MUTATION_TYPE_UPDATE_PROPERTY,
    t.ridFor(10) as string,
    "class",
    "greeting",
    2, // UPDATE_PROPERTY_TYPE_ATTRIBUTE
  ]);

  t.setAttribute(10, 2, undefined, undefined); // remove
  t.commit();
  assertEquals(conn.batches[1][0][3], null);
});

Deno.test("move via insert-before on an already-attached node (backward move)", () => {
  const { t, conn } = transcoder();
  t.internString(1, "div");
  t.createElement(10, 1, undefined);
  t.createElement(11, 1, undefined);
  t.createElement(12, 1, undefined);
  t.insertBefore(0, 10, undefined);
  t.insertBefore(0, 11, undefined);
  t.insertBefore(0, 12, undefined);
  t.commit();
  conn.batches.length = 0;

  // Move 12 before 10 (to the front).
  t.insertBefore(0, 12, 10);
  t.commit();

  assertEquals(conn.batches.length, 1);
  const [record] = conn.batches[0];
  assertEquals(record[0], MUTATION_TYPE_INSERT_CHILD);
  assertEquals(record[1], ROOT_ID);
  assertEquals((record[2] as { id: string }).id, t.ridFor(12));
  assertEquals(record[3], 0); // index computed against the shadow BEFORE the move
});

// B1 regression: a FORWARD move (the moved node sits BEFORE the anchor in
// the pre-move order) used to reuse the pre-detach record index for the
// shadow's post-detach splice too, landing the shadow one slot late
// relative to what the emitted record actually does to the real DOM.
Deno.test("move via insert-before on an already-attached node (forward move)", () => {
  const { t, conn } = transcoder();
  t.internString(1, "div");
  t.createElement(10, 1, undefined);
  t.createElement(11, 1, undefined);
  t.createElement(12, 1, undefined);
  t.createElement(13, 1, undefined);
  t.insertBefore(0, 10, undefined);
  t.insertBefore(0, 11, undefined);
  t.insertBefore(0, 12, undefined);
  t.insertBefore(0, 13, undefined);
  t.commit();
  conn.batches.length = 0;

  // children: [10, 11, 12, 13]. Move 10 before 13 (a forward move: 10 sits
  // before 13 already). DOMRemoteReceiver reads `childNodes[3]` (== 13)
  // BEFORE moving 10, so the real DOM ends up [11, 12, 10, 13].
  t.insertBefore(0, 10, 13);
  t.commit();

  assertEquals(conn.batches.length, 1);
  const [record] = conn.batches[0];
  assertEquals(record[0], MUTATION_TYPE_INSERT_CHILD);
  assertEquals(record[1], ROOT_ID);
  assertEquals((record[2] as { id: string }).id, t.ridFor(10));
  assertEquals(record[3], 3); // pre-move index of anchor 13

  // The shadow must agree with the real DOM's new order — a follow-up
  // insert-before against the moved node's new neighbors proves the
  // shadow's internal child array (not just the emitted record) is
  // correct: appending a new node after 10 should land right before 13.
  conn.batches.length = 0;
  t.createElement(14, 1, undefined);
  t.insertBefore(0, 14, 13);
  t.commit();
  assertEquals(conn.batches.length, 1);
  const [insertRecord] = conn.batches[0];
  assertEquals(insertRecord[3], 3); // shadow order is [11, 12, 10, 13] -> index of 13 is 3
});

Deno.test("insert-before throws when the anchor is not a child of the parent", () => {
  const { t } = transcoder();
  t.internString(1, "div");
  t.createElement(10, 1, undefined);
  t.createElement(11, 1, undefined);
  t.createElement(12, 1, undefined); // never inserted anywhere
  t.insertBefore(0, 10, undefined);
  t.insertBefore(0, 11, undefined);
  assertThrows(
    () => t.insertBefore(0, 10, 12),
    Error,
    "is not a child of the resolved parent",
  );
});

Deno.test("insert-before(parent, id, anchor) is a no-op when anchor === id", () => {
  const { t, conn } = transcoder();
  t.internString(1, "div");
  t.createElement(10, 1, undefined);
  t.insertBefore(0, 10, undefined);
  t.commit();
  conn.batches.length = 0;

  t.insertBefore(0, 10, 10);
  t.commit();
  assertEquals(conn.batches.length, 0); // truly nothing happened
});

// -- parent presence (insert-before/insert-after protocol change) --------

Deno.test("insert-before with no parent (implied from an attached anchor) produces the right parent rid and index", () => {
  const { t, conn } = transcoder();
  t.internString(1, "div");
  t.createElement(10, 1, undefined); // parent, attached
  t.createElement(11, 1, undefined); // anchor, attached under 10
  t.createElement(12, 1, undefined); // to be inserted before 11, parentless
  t.insertBefore(0, 10, undefined);
  t.insertBefore(10, 11, undefined);
  t.commit();
  conn.batches.length = 0;

  t.insertBefore(undefined, 12, 11); // parent implied: 10
  t.commit();

  assertEquals(conn.batches.length, 1);
  const [record] = conn.batches[0];
  assertEquals(record[0], MUTATION_TYPE_INSERT_CHILD);
  assertEquals(record[1], t.ridFor(10));
  assertEquals(record[3], 0); // 12 lands before 11, which was at index 0
});

Deno.test("insert-before throws when neither parent nor anchor is given", () => {
  const { t } = transcoder();
  t.internString(1, "div");
  t.createElement(10, 1, undefined);
  assertThrows(
    () => t.insertBefore(undefined, 10, undefined),
    Error,
    "has neither parent nor anchor",
  );
});

Deno.test("insert-before throws when an explicit parent disagrees with the anchor's current parent", () => {
  const { t } = transcoder();
  t.internString(1, "div");
  t.createElement(10, 1, undefined); // parent A
  t.createElement(20, 1, undefined); // parent B
  t.createElement(11, 1, undefined); // anchor, attached under A (10)
  t.insertBefore(0, 10, undefined);
  t.insertBefore(0, 20, undefined);
  t.insertBefore(10, 11, undefined);
  t.createElement(12, 1, undefined);
  assertThrows(
    () => t.insertBefore(20, 12, 11), // 11's parent is 10, not 20
    Error,
    "disagrees with anchor",
  );
});

Deno.test("insert-after appends right after the anchor (attached)", () => {
  const { t, conn } = transcoder();
  t.internString(1, "div");
  t.createElement(10, 1, undefined);
  t.createElement(11, 1, undefined); // anchor
  t.createElement(12, 1, undefined); // will land right after 11
  t.insertBefore(0, 10, undefined);
  t.insertBefore(10, 11, undefined);
  t.commit();
  conn.batches.length = 0;

  t.insertAfter(undefined, 12, 11); // parent implied: 10
  t.commit();

  assertEquals(conn.batches.length, 1);
  const [record] = conn.batches[0];
  assertEquals(record[0], MUTATION_TYPE_INSERT_CHILD);
  assertEquals(record[1], t.ridFor(10));
  assertEquals(record[3], 1); // right after anchor 11, which is at index 0
});

Deno.test("insert-after is shadow-only when both nodes are detached", () => {
  const { t, conn } = transcoder();
  t.internString(1, "div");
  t.createElement(10, 1, undefined); // detached parent
  t.createElement(11, 1, undefined); // anchor, detached, under 10
  t.createElement(12, 1, undefined);
  t.insertBefore(10, 11, undefined);
  t.insertAfter(undefined, 12, 11);
  assertEquals(conn.batches.length, 0);

  // Attaching the parent now serializes the whole subtree, in the right
  // order: [11, 12].
  t.insertBefore(0, 10, undefined);
  t.commit();
  assertEquals(conn.batches.length, 1);
  const [record] = conn.batches[0];
  const div = record[2] as unknown as { children: Array<{ id: string }> };
  assertEquals(div.children.length, 2);
  assertEquals(div.children[0].id, t.ridFor(11));
  assertEquals(div.children[1].id, t.ridFor(12));
});

Deno.test("insert-after same-parent move (forward): shadow order matches the real DOM", () => {
  const { t, conn } = transcoder();
  t.internString(1, "div");
  t.createElement(10, 1, undefined);
  t.createElement(11, 1, undefined);
  t.createElement(12, 1, undefined);
  t.createElement(13, 1, undefined);
  t.insertBefore(0, 10, undefined);
  t.insertBefore(0, 11, undefined);
  t.insertBefore(0, 12, undefined);
  t.insertBefore(0, 13, undefined);
  t.commit();
  conn.batches.length = 0;

  // children: [10, 11, 12, 13]. Move 10 (which sits before 13) to right
  // after 13 — DOMRemoteReceiver reads `childNodes[3 + 1] || null` (i.e.
  // null: append) BEFORE moving 10, against the pre-move DOM [10,11,12,13],
  // so the real DOM ends up [11, 12, 13, 10].
  t.insertAfter(0, 10, 13);
  t.commit();

  assertEquals(conn.batches.length, 1);
  const [record] = conn.batches[0];
  assertEquals((record[2] as unknown as { id: string }).id, t.ridFor(10));
  assertEquals(record[3], 4); // pre-move index of anchor 13 (3) + 1

  // Prove the SHADOW order (not just the emitted record) is [11,12,13,10]:
  // appending after 10 now should not need to go anywhere else — insert a
  // new node after 10 and confirm it lands at the end.
  conn.batches.length = 0;
  t.createElement(14, 1, undefined);
  t.insertAfter(0, 14, 10);
  t.commit();
  assertEquals(conn.batches.length, 1);
  assertEquals(conn.batches[0][0][3], 4); // shadow is [11,12,13,10], 10 is at index 3
});

Deno.test("insert-after same-parent move (backward): shadow order matches the real DOM", () => {
  const { t, conn } = transcoder();
  t.internString(1, "div");
  t.createElement(10, 1, undefined);
  t.createElement(11, 1, undefined);
  t.createElement(12, 1, undefined);
  t.createElement(13, 1, undefined);
  t.insertBefore(0, 10, undefined);
  t.insertBefore(0, 11, undefined);
  t.insertBefore(0, 12, undefined);
  t.insertBefore(0, 13, undefined);
  t.commit();
  conn.batches.length = 0;

  // children: [10, 11, 12, 13]. Move 13 to right after 10 (backward move —
  // 13 sits after 10 already). Pre-move DOM childNodes[0 + 1] = 11, so the
  // real DOM becomes [10, 13, 11, 12].
  t.insertAfter(0, 13, 10);
  t.commit();

  assertEquals(conn.batches.length, 1);
  const [record] = conn.batches[0];
  assertEquals((record[2] as unknown as { id: string }).id, t.ridFor(13));
  assertEquals(record[3], 1); // pre-move index of anchor 10 (0) + 1

  // Shadow should now be [10, 13, 11, 12]: inserting after 13 should land
  // at index 2 (right before 11).
  conn.batches.length = 0;
  t.createElement(14, 1, undefined);
  t.insertAfter(0, 14, 13);
  t.commit();
  assertEquals(conn.batches.length, 1);
  assertEquals(conn.batches[0][0][3], 2);
});

Deno.test("moving an attached node under a detached parent detaches it", () => {
  const { t, conn } = transcoder();
  t.internString(1, "div");
  t.createElement(10, 1, undefined); // will stay detached (the new parent)
  t.createElement(11, 1, undefined); // will be attached, then moved off
  t.insertBefore(0, 11, undefined);
  t.commit();
  conn.batches.length = 0;

  t.insertBefore(10, 11, undefined); // 10 is detached: 11 leaves the real DOM
  t.commit();

  assertEquals(conn.batches.length, 1);
  assertEquals(conn.batches[0][0], [MUTATION_TYPE_REMOVE_CHILD, ROOT_ID, 0]);

  // Re-attaching the (now detached) subtree must re-serialize it in full,
  // not treat it as already known to the receiver.
  conn.batches.length = 0;
  t.insertBefore(0, 10, undefined);
  t.commit();
  assertEquals(conn.batches.length, 1);
  const [record] = conn.batches[0];
  assertEquals(record[0], MUTATION_TYPE_INSERT_CHILD);
  const div10 = record[2] as unknown as { children: unknown[] };
  assertEquals(div10.children.length, 1); // 11 is serialized as 10's child again
});

Deno.test("remove detaches and forgets the subtree", () => {
  const { t, conn } = transcoder();
  t.internString(1, "div");
  t.createElement(10, 1, undefined);
  t.createElement(11, 1, undefined);
  t.insertBefore(0, 10, undefined);
  t.insertBefore(10, 11, undefined); // 11 attaches too, as part of 10's subtree — but
  // 10 was already attached when 11 was inserted, so this emits its own record.
  t.commit();
  conn.batches.length = 0;

  t.remove(10);
  t.commit();

  assertEquals(conn.batches.length, 1);
  assertEquals(conn.batches[0][0], [MUTATION_TYPE_REMOVE_CHILD, ROOT_ID, 0]);

  // The subtree's ids are forgotten: further ops against them are errors.
  assertThrows(() => t.setText(11, "x"));
});

Deno.test("register-template, clone, bind-path, then set-text on the bound interior node", () => {
  const { t, conn } = transcoder();
  t.internString(1, "div");
  t.internString(2, "span");

  // Arena: [0]=div(children=[1]), [1]=span(children=[2]), [2]="placeholder text"
  const nodes: TemplateNode[] = [
    {
      kind: "element",
      element: { tag: 1, ns: undefined, attrs: [], children: [1] },
    },
    {
      kind: "element",
      element: { tag: 2, ns: undefined, attrs: [], children: [2] },
    },
    { kind: "text", text: "placeholder" },
  ];
  t.registerTemplate(100, nodes, [0]);
  t.cloneTemplate(100, 0, 20); // clone root -> producer id 20 (detached)
  t.bindPath(20, Uint8Array.of(0, 0), 21); // div -> span -> text

  t.insertBefore(0, 20, undefined); // attach the whole clone
  t.commit();

  assertEquals(conn.batches.length, 1);
  const [record] = conn.batches[0];
  const div = record[2] as unknown as { element: string; children: unknown[] };
  assertEquals(div.element, "div");
  const span = div.children[0] as { element: string; children: unknown[] };
  assertEquals(span.element, "span");
  const text = span.children[0] as { data: string };
  assertEquals(text.data, "placeholder");
  conn.batches.length = 0;

  t.setText(21, "bound");
  t.commit();
  assertEquals(conn.batches.length, 1);
  assertEquals(conn.batches[0][0], [
    MUTATION_TYPE_UPDATE_TEXT,
    t.ridFor(21) as string,
    "bound",
  ]);
});

Deno.test("invalid template throws: out-of-range child index", () => {
  const { t } = transcoder();
  const nodes: TemplateNode[] = [
    {
      kind: "element",
      element: { tag: 0, ns: undefined, attrs: [], children: [5] },
    },
  ];
  assertThrows(() => t.registerTemplate(1, nodes, [0]));
});

Deno.test("invalid template throws: a node referenced more than once", () => {
  const { t } = transcoder();
  const nodes: TemplateNode[] = [
    {
      kind: "element",
      element: { tag: 0, ns: undefined, attrs: [], children: [1, 2] },
    },
    { kind: "text", text: "a" },
    {
      kind: "element",
      element: { tag: 0, ns: undefined, attrs: [], children: [1] },
    },
  ];
  assertThrows(() => t.registerTemplate(1, nodes, [0]));
});

Deno.test("invalid template throws: cyclic", () => {
  const { t } = transcoder();
  // Node 0 is its own root and its own child — this is only reachable if a
  // node is referenced by more than one parent's children, which the
  // "referenced more than once" check above already forbids for a node
  // that is ALSO a child; a self-referential ROOT (never listed as
  // anyone's child) still slips past that check, so acyclicity needs its
  // own walk.
  const nodes: TemplateNode[] = [
    {
      kind: "element",
      element: { tag: 0, ns: undefined, attrs: [], children: [0] },
    },
  ];
  assertThrows(() => t.registerTemplate(1, nodes, [0]));
});

// B3: acyclicity must be checked across every node in the arena, not just
// the subtrees reachable from a declared root — an orphaned cyclic
// subgraph would otherwise pass validation and loop forever the moment
// anything ever reached it.
Deno.test("invalid template throws: cyclic subgraph unreachable from any root", () => {
  const { t } = transcoder();
  const nodes: TemplateNode[] = [
    { kind: "text", text: "a" }, // the only declared root
    {
      kind: "element",
      element: { tag: 0, ns: undefined, attrs: [], children: [1] }, // self-cycle
    },
  ];
  assertThrows(() => t.registerTemplate(1, nodes, [0]));
});

Deno.test("clone-template's root is an ordinal into RegisterTemplate.roots, not a node index", () => {
  const { t, conn } = transcoder();
  t.internString(1, "div");
  t.internString(2, "span");
  // Arena: [0] = span (leaf), [1] = div (leaf). Declared roots, in an
  // order that DIFFERS from node-index order, so a root-ordinal-as-node-
  // index bug would clone the wrong element.
  const nodes: TemplateNode[] = [
    {
      kind: "element",
      element: { tag: 2, ns: undefined, attrs: [], children: [] },
    },
    {
      kind: "element",
      element: { tag: 1, ns: undefined, attrs: [], children: [] },
    },
  ];
  t.registerTemplate(100, nodes, [1, 0]); // roots[0] -> node 1 (div), roots[1] -> node 0 (span)

  t.cloneTemplate(100, 0, 20); // root ordinal 0 -> roots[0] -> node 1 -> div
  t.cloneTemplate(100, 1, 21); // root ordinal 1 -> roots[1] -> node 0 -> span

  t.insertBefore(0, 20, undefined);
  t.insertBefore(0, 21, undefined);
  t.commit();

  assertEquals(conn.batches.length, 1);
  const [divRecord, spanRecord] = conn.batches[0];
  assertEquals((divRecord[2] as unknown as { element: string }).element, "div");
  assertEquals(
    (spanRecord[2] as unknown as { element: string }).element,
    "span",
  );
});

Deno.test("clone-template throws when the root ordinal is out of range", () => {
  const { t } = transcoder();
  const nodes: TemplateNode[] = [
    {
      kind: "element",
      element: { tag: 0, ns: undefined, attrs: [], children: [] },
    },
  ];
  t.registerTemplate(100, nodes, [0]); // one declared root
  assertThrows(() => t.cloneTemplate(100, 1, 20), Error, "out of range");
});

Deno.test("bind-marker is unsupported", () => {
  const { t } = transcoder();
  assertThrows(() => t.bindMarker(1, 2), Error, "hydration is not supported");
});

Deno.test("listener registry: add/remove bookkeeping and pending queues", () => {
  const { t } = transcoder();
  t.internString(1, "div");
  t.createElement(10, 1, undefined);

  const listener: Listener = {
    target: { kind: "node", id: 10 },
    name: 5,
    bubbles: true,
    capture: false,
    passive: false,
    preventDefault: false,
    stopPropagation: false,
  };
  t.addListener(listener);
  assertEquals(t.listenerFor(10, 5), listener);
  assertEquals(t.pendingAttach, [{ target: listener.target, listener }]);

  t.removeListener(listener);
  assertEquals(t.listenerFor(10, 5), undefined);
  assertEquals(t.pendingDetach, [{ target: listener.target, listener }]);
});

Deno.test("listener registry: global (window/document) add/remove is tracked separately from node listeners", () => {
  const { t } = transcoder();

  const winListener: Listener = {
    target: { kind: "window" },
    name: 4,
    bubbles: false,
    capture: false,
    passive: false,
    preventDefault: false,
    stopPropagation: false,
  };
  const docListener: Listener = {
    ...winListener,
    target: { kind: "document" },
    name: 6,
  };
  t.addListener(winListener);
  t.addListener(docListener);
  assertEquals(t.pendingAttach, [
    { target: winListener.target, listener: winListener },
    { target: docListener.target, listener: docListener },
  ]);

  t.removeListener(winListener);
  assertEquals(t.pendingDetach, [{
    target: winListener.target,
    listener: winListener,
  }]);
  // The document listener is untouched by removing the window one — they
  // are not stored in the same bucket.
});

Deno.test("onCommit runs after mutate, and only when there is something to mutate or always?", () => {
  const { t, conn } = transcoder();
  let commits = 0;
  t.onCommit = () => commits++;
  t.internString(1, "div");
  t.createElement(10, 1, undefined);
  t.insertBefore(0, 10, undefined);
  t.commit();
  assertEquals(conn.batches.length, 1);
  assertEquals(commits, 1);

  // A commit with nothing to mutate still runs onCommit (empty batch is
  // legal per docs/design.md; onCommit still needs to drain any pending
  // listener attach/detach queued this batch).
  t.commit();
  assertEquals(conn.batches.length, 1); // no new mutate() call
  assertEquals(commits, 2);
});
