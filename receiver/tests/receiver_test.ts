import { assertEquals } from "@std/assert";
import { ListenerRegistry } from "../src/receiver.ts";
import type { Listener } from "../src/frames.ts";

Deno.test("ListenerRegistry: add/remove bookkeeping and pending queues (node target)", () => {
  const registry = new ListenerRegistry();

  const listener: Listener = {
    target: { kind: "node", id: 10 },
    name: 5,
    bubbles: true,
    capture: false,
    passive: false,
    preventDefault: false,
    stopPropagation: false,
  };
  registry.add(listener);
  assertEquals(registry.listenerFor(10, 5), listener);
  assertEquals(registry.pendingAttach, [{ target: listener.target, listener }]);

  registry.remove(listener);
  assertEquals(registry.listenerFor(10, 5), undefined);
  assertEquals(registry.pendingDetach, [{ target: listener.target, listener }]);
});

Deno.test("ListenerRegistry: global (window/document) add/remove is tracked separately from node listeners", () => {
  const registry = new ListenerRegistry();

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
  registry.add(winListener);
  registry.add(docListener);
  assertEquals(registry.pendingAttach, [
    { target: winListener.target, listener: winListener },
    { target: docListener.target, listener: docListener },
  ]);

  registry.remove(winListener);
  assertEquals(registry.pendingDetach, [{
    target: winListener.target,
    listener: winListener,
  }]);
  // The document listener is untouched by removing the window one — they
  // are not stored in the same bucket.
});

Deno.test("ListenerRegistry: string interning (internString/stringFor/refFor)", () => {
  const registry = new ListenerRegistry();
  registry.internString(1, "click");
  registry.internString(2, "hashchange");
  assertEquals(registry.stringFor(1), "click");
  assertEquals(registry.stringFor(2), "hashchange");
  assertEquals(registry.stringFor(99), ""); // unknown ref -> empty string
  assertEquals(registry.refFor("hashchange"), 2);
  assertEquals(registry.refFor("nope"), undefined);
});
