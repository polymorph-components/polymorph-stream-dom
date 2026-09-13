import { assertEquals, assertThrows } from "@std/assert";
import { DispatchGate } from "../src/dispatch.ts";

Deno.test("DispatchGate: queued events and reentrant additions drain FIFO in one microtask", async () => {
  const trace: string[] = [];
  const gate = new DispatchGate((error) => trace.push(`error:${error}`));
  gate.beginApply();
  gate.dispatch(() => {
    trace.push("first");
    gate.dispatch(() => trace.push("third"));
  });
  gate.dispatch(() => {
    trace.push("second");
    gate.dispatch(() => trace.push("fourth"));
  });
  gate.dispatch(() => trace.push("fifth"));
  gate.endApply();

  assertEquals(trace, []);
  await Promise.resolve();
  assertEquals(trace, ["first", "second", "fifth", "third", "fourth"]);
});

Deno.test("DispatchGate: a pending returned promise does not hold later events", () => {
  const trace: string[] = [];
  const gate = new DispatchGate((error) => trace.push(`error:${error}`));
  gate.dispatch(() => {
    trace.push("first");
    return new Promise(() => {});
  });
  gate.dispatch(() => trace.push("second"));
  assertEquals(trace, ["first", "second"]);
});

Deno.test("DispatchGate: reentrant idle dispatch schedules its queued work", async () => {
  const trace: string[] = [];
  const gate = new DispatchGate((error) => trace.push(`error:${error}`));
  gate.dispatch(() => {
    trace.push("outer");
    gate.dispatch(() => trace.push("inner"));
  });
  assertEquals(trace, ["outer"]);
  await Promise.resolve();
  assertEquals(trace, ["outer", "inner"]);
});

Deno.test("DispatchGate: a newly dispatched event cannot overtake a scheduled drain", async () => {
  const trace: string[] = [];
  const gate = new DispatchGate((error) => trace.push(`error:${error}`));
  gate.beginApply();
  gate.dispatch(() => trace.push("old"));
  gate.endApply();
  gate.dispatch(() => trace.push("new"));
  assertEquals(trace, []);
  await Promise.resolve();
  assertEquals(trace, ["old", "new"]);
});

Deno.test("DispatchGate: nested application windows drain only after the outer end", async () => {
  const trace: string[] = [];
  const gate = new DispatchGate((error) => trace.push(`error:${error}`));
  gate.beginApply();
  gate.beginApply();
  gate.dispatch(() => trace.push("event"));
  gate.endApply();
  await Promise.resolve();
  assertEquals(trace, []);
  gate.endApply();
  await Promise.resolve();
  assertEquals(trace, ["event"]);
  assertThrows(() => gate.endApply(), Error, "without matching beginApply");
});

Deno.test("DispatchGate: synchronous and asynchronous failures are reported without blocking", async () => {
  const errors: string[] = [];
  const trace: string[] = [];
  const gate = new DispatchGate((error) => errors.push(String(error)));
  gate.beginApply();
  gate.dispatch(() => {
    throw new Error("sync");
  });
  gate.dispatch(() => Promise.reject(new Error("async")));
  gate.dispatch(() => trace.push("after"));
  gate.endApply();

  await Promise.resolve();
  await Promise.resolve();
  assertEquals(trace, ["after"]);
  assertEquals(errors, ["Error: sync", "Error: async"]);
});

Deno.test("DispatchGate: disposal clears queued work", async () => {
  const trace: string[] = [];
  const gate = new DispatchGate((error) => trace.push(`error:${error}`));
  gate.beginApply();
  gate.dispatch(() => trace.push("queued"));
  gate.endApply();
  gate.dispose();
  gate.dispatch(() => trace.push("late"));
  await Promise.resolve();
  assertEquals(trace, []);
});
