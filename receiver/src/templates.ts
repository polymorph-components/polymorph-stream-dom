// Shared template-arena validation, used by every `FrameSink` that
// implements `register-template` (docs/design.md "Templates are core, not
// an extension"): "a receiver validates the index graph (range,
// acyclicity) rather than trust it." Extracted so `RemoteDomTranscoder`
// and `NativeDomReceiver` share one check and one set of error messages
// instead of two copies drifting apart.

import type { TemplateNode } from "./frames.ts";

/**
 * Validate a `register-template` arena: every child index in range, no
 * node referenced as a child more than once, and no cycle anywhere in
 * `nodes` — not just in the subtrees reachable from a declared root (a
 * cycle in an orphaned subgraph would otherwise pass and then loop
 * forever the moment anything ever reached it). Throws
 * `stream-dom: template ${templateId} ...` on the first violation found;
 * returns nothing on success.
 */
export function validateTemplateArena(
  templateId: number,
  nodes: TemplateNode[],
  roots: number[],
): void {
  const referenced = new Set<number>();
  for (const n of nodes) {
    if (n.kind !== "element") continue;
    for (const c of n.element.children) {
      if (c < 0 || c >= nodes.length) {
        throw new Error(
          `stream-dom: template ${templateId} child index ${c} out of range`,
        );
      }
      if (referenced.has(c)) {
        throw new Error(
          `stream-dom: template ${templateId} node ${c} referenced more than once`,
        );
      }
      referenced.add(c);
    }
  }
  for (const r of roots) {
    if (r < 0 || r >= nodes.length) {
      throw new Error(
        `stream-dom: template ${templateId} root index ${r} out of range`,
      );
    }
  }
  // Acyclicity: walk from EVERY node index, not just the declared roots.
  // `visited` is global across the whole scan so a node already found
  // acyclic via one starting point does not get walked again from
  // another.
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const visit = (idx: number): void => {
    if (visiting.has(idx)) {
      throw new Error(
        `stream-dom: template ${templateId} is cyclic at node ${idx}`,
      );
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
}
