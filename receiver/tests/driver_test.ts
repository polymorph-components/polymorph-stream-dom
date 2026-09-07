// `Driver` (driver.ts) under a real-ish DOM (linkedom): bytes-in/DOM-out
// with no component involved, event delegation back out, declarative
// flags, policy-gated queries, and abort/dispose semantics. See
// receiver/tests/native_test.ts for the DOM-setup style this borrows
// (hierarchy guard is not needed here — nothing here builds cycles).

import { assertEquals, assertThrows } from "@std/assert";
import { parseHTML } from "linkedom";
import { createDriver } from "../src/driver.ts";
import type { ProducerEventTarget } from "../src/driver.ts";
import { PROTOCOL_VERSION } from "../src/frames.ts";
import { PolicyError } from "../src/policy.ts";
import type { Policy } from "../src/policy.ts";
import { Frame } from "../src/gen/stream-dom.ts";
import { frame as framed, stream } from "./wire.ts";

/** A policy that allows every op — the baseline these tests vary from. */
function allowAll(extra?: Partial<Policy>): Policy {
  return { version: PROTOCOL_VERSION, check: () => undefined, ...extra };
}

// -- harness ----------------------------------------------------------------

function fixture() {
  const win = parseHTML(
    `<!doctype html><html><body><section id="container"><div id="root"></div></section></body></html>`,
  );
  const doc = win.document as unknown as Document;
  const root = doc.getElementById("root")!;
  return { win, doc, root };
}

/** `driver.dispose()` unconditionally touches the bare `window`/`document`
 * globals (global-listener teardown) even when nothing registered one, and
 * Deno has neither — referencing them is a `ReferenceError`, not merely
 * `undefined`. Tests that call `dispose()` (or register a window/document
 * listener) install linkedom's window/document as `globalThis.window`/
 * `globalThis.document` for their duration and restore afterward; no test
 * here exercises delegated GLOBAL listeners themselves (only root-
 * delegated node listeners), so this is purely to make `dispose()` safe to
 * call, not a claim about global-listener behaviour under test.
 */
function withGlobalWindow<T>(win: unknown, fn: () => T): T {
  const hadWindow = "window" in globalThis;
  const hadDocument = "document" in globalThis;
  const prevWindow = (globalThis as Record<string, unknown>).window;
  const prevDocument = (globalThis as Record<string, unknown>).document;
  (globalThis as Record<string, unknown>).window = win;
  (globalThis as Record<string, unknown>).document =
    (win as { document: unknown }).document;
  try {
    return fn();
  } finally {
    if (hadWindow) (globalThis as Record<string, unknown>).window = prevWindow;
    else delete (globalThis as Record<string, unknown>).window;
    if (hadDocument) {
      (globalThis as Record<string, unknown>).document = prevDocument;
    } else delete (globalThis as Record<string, unknown>).document;
  }
}

/** `driver.push` can synchronously trigger `onCommit` (a whole batch,
 * including its `commit` frame, in one push); calling `nextCommit()`
 * AFTER that push is too late, the promise never resolves (the earlier
 * commit already drained). This captures the promise first. */
async function pushAndAwaitCommit(
  driver: { push(b: Uint8Array): void; nextCommit(): Promise<void> },
  bytes: Uint8Array,
): Promise<void> {
  const p = driver.nextCommit();
  driver.push(bytes);
  await p;
}

/** One length-delimited `Frame` message, built with the generated
 * writer; `commit` sets `Frame.commit`. */
function frame(commit: boolean, op?: Frame["op"]): Uint8Array {
  return framed(Frame.encode({ commit, op }).finish());
}

const DIV = 1, CLICK = 2;

/** intern(div), create-element(10, div), insert(root, 10), create-text(11,
 * "hi"), insert(10, 11), set-text(11, "hi there"), commit. */
function basicFrames(): Uint8Array[] {
  return [
    frame(false, { $case: "intern", value: { id: DIV, s: "div" } }),
    frame(false, { $case: "intern", value: { id: CLICK, s: "click" } }),
    frame(false, {
      $case: "createElement",
      value: { id: 10, tag: DIV, ns: undefined },
    }),
    frame(false, {
      $case: "insertBefore",
      value: { parent: 0, id: 10, anchor: undefined },
    }),
    frame(false, { $case: "createText", value: { id: 11, text: "hi" } }),
    frame(false, {
      $case: "insertBefore",
      value: { parent: 10, id: 11, anchor: undefined },
    }),
    frame(true, { $case: "setText", value: { id: 11, text: "hi there" } }),
  ];
}

/** A bubbling `click` listener on node 10, in its own commit. */
function addClickListenerFrame(
  opts?: { preventDefault?: boolean },
): Uint8Array {
  return frame(true, {
    $case: "addListener",
    value: {
      listener: {
        target: { $case: "id", value: 10 },
        name: CLICK,
        bubbles: true,
        capture: false,
        passive: false,
        preventDefault: opts?.preventDefault === true,
        stopPropagation: false,
      },
    },
  });
}

// -- 1. bytes in, DOM out, no component --------------------------------------

Deno.test("Driver: bytes in, DOM out, split mid-frame, no component", async () => {
  const { win, root } = fixture();
  const calls: unknown[] = [];
  const driver = createDriver({
    root,
    handleEvent: (...a) => {
      calls.push(a);
    },
  });

  const all = stream(...basicFrames());
  // Split mid-frame: partway through the fixed-point of the sequence,
  // well inside a frame's body rather than on a frame boundary.
  const mid = Math.floor(all.length / 2);
  const committed = driver.nextCommit();
  driver.push(all.slice(0, mid));
  driver.push(all.slice(mid));
  await committed;

  assertEquals(root.innerHTML, "<div>hi there</div>");
  assertEquals(driver.stats.batches, 1);
  assertEquals(driver.stats.frames, 7);
  assertEquals(driver.stats.bytes, all.length);
  assertEquals(calls.length, 0);

  withGlobalWindow(win, () => driver.dispose());
});

// -- 2. events out ------------------------------------------------------------

Deno.test("Driver: a bubbling click listener fires handleEvent with the right target/nameRef/payload", async () => {
  const { win, root } = fixture();
  const calls: Array<
    [ProducerEventTarget, number, Uint8Array]
  > = [];
  const driver = createDriver({
    root,
    handleEvent: (target, nameRef, payload) => {
      calls.push([target, nameRef, payload]);
    },
  });
  await pushAndAwaitCommit(driver, stream(...basicFrames()));
  await pushAndAwaitCommit(driver, addClickListenerFrame());

  const div = root.querySelector("div")!;
  div.dispatchEvent(
    new (win as unknown as { Event: typeof Event }).Event(
      "click",
      { bubbles: true },
    ),
  );

  assertEquals(calls.length, 1);
  const [target, nameRef, payload] = calls[0];
  assertEquals(target, { kind: "node", value: 10 });
  assertEquals(nameRef, CLICK);
  assertEquals(payload.length > 0, true); // click -> mouse payload

  withGlobalWindow(win, () => driver.dispose());
});

// -- 3. declarative flags -----------------------------------------------------

Deno.test("Driver: prevent_default is honored even though handleEvent does nothing", async () => {
  const { win, root } = fixture();
  const driver = createDriver({
    root,
    handleEvent: () => {}, // does nothing — flag must still land
  });
  await pushAndAwaitCommit(driver, stream(...basicFrames()));
  await pushAndAwaitCommit(
    driver,
    addClickListenerFrame({ preventDefault: true }),
  );

  const div = root.querySelector("div")!;
  const ev = new (win as unknown as { Event: typeof Event }).Event("click", {
    bubbles: true,
    cancelable: true,
  });
  div.dispatchEvent(ev);

  assertEquals(ev.defaultPrevented, true);

  withGlobalWindow(win, () => driver.dispose());
});

// -- 4. queries gated ----------------------------------------------------------

Deno.test("Driver: policy.query gates individual queries; absent means allow", async () => {
  // A policy with no `query` method allows every import (policy.ts:
  // "Absent means allow"), so a refusal needs an EXPLICIT refusing hook.
  const { win, root } = fixture();
  const gated = createDriver({
    root,
    policy: allowAll({ query: (name) => name !== "set-focus" }),
    handleEvent: () => {},
  });
  await pushAndAwaitCommit(gated, stream(...basicFrames()));
  assertEquals(gated.queries.setFocus(10, true), false);
  // ...while a query the same policy does not refuse still answers.
  assertEquals(gated.queries.getClientRect(10), {
    origin: { x: 0, y: 0 },
    size: { width: 0, height: 0 },
  });
  withGlobalWindow(win, () => gated.dispose());

  const { win: win2, root: root2 } = fixture();
  const open = createDriver({
    root: root2,
    policy: allowAll(),
    handleEvent: () => {},
  });
  await pushAndAwaitCommit(open, stream(...basicFrames()));
  assertEquals(open.queries.setFocus(10, true), true);
  assertEquals(open.queries.getClientRect(10), {
    origin: { x: 0, y: 0 },
    size: { width: 0, height: 0 },
  });
  withGlobalWindow(win2, () => open.dispose());
});

// -- 5. abort semantics ---------------------------------------------------------

Deno.test("Driver: a policy rejection throws PolicyError out of push", () => {
  const { win, root } = fixture();
  const policy = allowAll({
    check: (op) =>
      op.op === "createElement"
        ? "div is not in the host vocabulary"
        : undefined,
  });
  const driver = createDriver({ root, policy, handleEvent: () => {} });
  assertThrows(
    () => driver.push(stream(...basicFrames())),
    PolicyError,
    "div is not in the host vocabulary",
  );
  withGlobalWindow(win, () => driver.dispose());
});

Deno.test("Driver: a policy pinning another protocol version is refused at construction", () => {
  const { root } = fixture();
  assertThrows(
    () =>
      createDriver({
        root,
        policy: { version: PROTOCOL_VERSION + 1, check: () => undefined },
        handleEvent: () => {},
      }),
    Error,
    `policy pins protocol version ${PROTOCOL_VERSION + 1}`,
  );
});

Deno.test("Driver: an unknown node id throws", () => {
  const { win, root } = fixture();
  const driver = createDriver({ root, handleEvent: () => {} });
  const bad = frame(true, {
    $case: "setText",
    value: { id: 999, text: "x" },
  });
  assertThrows(() => driver.push(bad), Error, "unknown node id 999");
  withGlobalWindow(win, () => driver.dispose());
});

// -- 3b. defaultPreventDefault (docs/design.md "Events", option C; see
// driver.ts's doc on `DriverOptions.defaultPreventDefault` for why this
// is unconditional — no producer listener is registered in ANY of these
// tests, on purpose: the whole point is that an unlistened `<form>`/
// `<a href>` is the dangerous case). ---------------------------------------

Deno.test("Driver: defaultPreventDefault prevents a submit with NO producer listener at all, when on; not when off", async () => {
  for (const on of [true, false]) {
    const { win, root } = fixture();
    const driver = createDriver({
      root,
      defaultPreventDefault: on,
      handleEvent: () => {},
    });
    await pushAndAwaitCommit(driver, stream(...basicFrames()));

    const div = root.querySelector("div")!;
    const ev = new (win as unknown as { Event: typeof Event }).Event(
      "submit",
      { bubbles: true, cancelable: true },
    );
    // events.ts's form-data encoder does a bare `instanceof
    // HTMLFormElement` (as it would against the real global in a page);
    // linkedom's per-window class isn't the bare global, so patch it in
    // for this dispatch alongside `withGlobalWindow`'s window/document.
    const hadCtor = "HTMLFormElement" in globalThis;
    const prevCtor = (globalThis as Record<string, unknown>).HTMLFormElement;
    (globalThis as Record<string, unknown>).HTMLFormElement =
      (win as unknown as { HTMLFormElement: unknown }).HTMLFormElement;
    try {
      withGlobalWindow(win, () => div.dispatchEvent(ev));
    } finally {
      if (hadCtor) {
        (globalThis as Record<string, unknown>).HTMLFormElement = prevCtor;
      } else delete (globalThis as Record<string, unknown>).HTMLFormElement;
    }
    assertEquals(ev.defaultPrevented, on);

    withGlobalWindow(win, () => driver.dispose());
  }
});

/** Build a driver over a fresh `<tag href=...?>` under `root` (node id
 * 10, no producer listener registered), with `defaultPreventDefault` on. */
async function fixtureWithLeaf(
  tag: string,
  href?: string,
): Promise<
  { win: unknown; root: Element; driver: ReturnType<typeof createDriver> }
> {
  const { win, root } = fixture();
  const driver = createDriver({
    root,
    defaultPreventDefault: true,
    handleEvent: () => {},
  });
  await pushAndAwaitCommit(
    driver,
    stream(
      frame(false, { $case: "intern", value: { id: DIV, s: tag } }),
      frame(false, {
        $case: "createElement",
        value: { id: 10, tag: DIV, ns: undefined },
      }),
      frame(true, {
        $case: "insertBefore",
        value: { parent: 0, id: 10, anchor: undefined },
      }),
    ),
  );
  if (href !== undefined) {
    root.querySelector(tag)!.setAttribute("href", href);
  }
  return { win, root, driver };
}

Deno.test("Driver: defaultPreventDefault prevents a click on <a href='http://x'> with NO producer listener", async () => {
  const { win, root, driver } = await fixtureWithLeaf("a", "http://x");
  const ev = new (win as unknown as { Event: typeof Event }).Event("click", {
    bubbles: true,
    cancelable: true,
  });
  root.querySelector("a")!.dispatchEvent(ev);
  assertEquals(ev.defaultPrevented, true);
  withGlobalWindow(win, () => driver.dispose());
});

Deno.test("Driver: defaultPreventDefault does NOT prevent a click on <a href='#/active'> (same-document fragment)", async () => {
  const { win, root, driver } = await fixtureWithLeaf("a", "#/active");
  const ev = new (win as unknown as { Event: typeof Event }).Event("click", {
    bubbles: true,
    cancelable: true,
  });
  root.querySelector("a")!.dispatchEvent(ev);
  assertEquals(ev.defaultPrevented, false);
  withGlobalWindow(win, () => driver.dispose());
});

Deno.test("Driver: defaultPreventDefault does not touch a click on <button>", async () => {
  const { win, root, driver } = await fixtureWithLeaf("button");
  const ev = new (win as unknown as { Event: typeof Event }).Event("click", {
    bubbles: true,
    cancelable: true,
  });
  root.querySelector("button")!.dispatchEvent(ev);
  assertEquals(ev.defaultPrevented, false);
  withGlobalWindow(win, () => driver.dispose());
});

Deno.test("Driver: defaultPreventDefault off means nothing is prevented, even a plain submit/click on <a href>", async () => {
  const { win, root } = fixture();
  const driver = createDriver({
    root,
    defaultPreventDefault: false,
    handleEvent: () => {},
  });
  await pushAndAwaitCommit(
    driver,
    stream(
      frame(false, { $case: "intern", value: { id: DIV, s: "a" } }),
      frame(false, {
        $case: "createElement",
        value: { id: 10, tag: DIV, ns: undefined },
      }),
      frame(true, {
        $case: "insertBefore",
        value: { parent: 0, id: 10, anchor: undefined },
      }),
    ),
  );
  root.querySelector("a")!.setAttribute("href", "http://x");
  const ev = new (win as unknown as { Event: typeof Event }).Event("click", {
    bubbles: true,
    cancelable: true,
  });
  root.querySelector("a")!.dispatchEvent(ev);
  assertEquals(ev.defaultPrevented, false);
  withGlobalWindow(win, () => driver.dispose());
});

Deno.test("Driver: after dispose, root listeners are gone (dispatch no longer calls handleEvent)", async () => {
  const { win, root } = fixture();
  const calls: unknown[] = [];
  const driver = createDriver({
    root,
    handleEvent: (...a) => {
      calls.push(a);
    },
  });
  await pushAndAwaitCommit(driver, stream(...basicFrames()));
  await pushAndAwaitCommit(driver, addClickListenerFrame());

  withGlobalWindow(win, () => driver.dispose());

  const div = root.querySelector("div")!;
  div.dispatchEvent(
    new (win as unknown as { Event: typeof Event }).Event(
      "click",
      { bubbles: true },
    ),
  );
  assertEquals(calls.length, 0);

  // push is a no-op after dispose (Driver.push's documented contract).
  driver.push(stream(...basicFrames()));
});
