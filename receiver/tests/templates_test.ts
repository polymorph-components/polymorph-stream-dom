import { assertThrows } from "@std/assert";
import { validateTemplateArena } from "../src/templates.ts";
import type { TemplateNode } from "../src/frames.ts";

Deno.test("invalid template throws: out-of-range child index", () => {
  const nodes: TemplateNode[] = [
    {
      kind: "element",
      element: { tag: 0, ns: undefined, attrs: [], children: [5] },
    },
  ];
  assertThrows(() => validateTemplateArena(1, nodes, [0]));
});

Deno.test("invalid template throws: a node referenced more than once", () => {
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
  assertThrows(() => validateTemplateArena(1, nodes, [0]));
});

Deno.test("invalid template throws: cyclic", () => {
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
  assertThrows(() => validateTemplateArena(1, nodes, [0]));
});

// Acyclicity must be checked across every node in the arena, not just the
// subtrees reachable from a declared root — an orphaned cyclic subgraph
// would otherwise pass validation and loop forever the moment anything
// ever reached it.
Deno.test("invalid template throws: cyclic subgraph unreachable from any root", () => {
  const nodes: TemplateNode[] = [
    { kind: "text", text: "a" }, // the only declared root
    {
      kind: "element",
      element: { tag: 0, ns: undefined, attrs: [], children: [1] }, // self-cycle
    },
  ];
  assertThrows(() => validateTemplateArena(1, nodes, [0]));
});

Deno.test("valid template arena does not throw", () => {
  const nodes: TemplateNode[] = [
    {
      kind: "element",
      element: { tag: 0, ns: undefined, attrs: [], children: [1, 2] },
    },
    { kind: "text", text: "a" },
    { kind: "dynamic" },
  ];
  validateTemplateArena(1, nodes, [0]);
});

Deno.test("invalid template throws: out-of-range root index", () => {
  const nodes: TemplateNode[] = [
    { kind: "text", text: "a" },
  ];
  assertThrows(() => validateTemplateArena(1, nodes, [1]));
});
