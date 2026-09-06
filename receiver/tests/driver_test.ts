// `Driver` (driver.ts) under a real-ish DOM (linkedom): bytes-in/DOM-out
// with no component involved, event delegation back out, declarative
// flags, policy-gated queries, and abort/dispose semantics. See
// receiver/tests/native_test.ts for the DOM-setup style this borrows
// (hierarchy guard is not needed here — nothing here builds cycles).

import { assertEquals, assertThrows } from "@std/assert";
import { parseHTML } from "linkedom";
import { createDriver } from "../src/driver.ts";
import type { ProducerEventTarget } from "../src/driver.ts";
import { PolicyError } from "../src/policy.ts";
import type { Policy } from "../src/policy.ts";
import { Writer } from "../src/proto.ts";
import { SURFACE_V1 } from "../src/policy.ts";

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

// Frame field numbers, transcribed from proto/stream-dom.proto (see
// policy_test.ts's header comment for why these are independent literals
// rather than imports from src/).
const FRAME_COMMIT = 1;
const FRAME_INSERT_BEFORE = 2;
const FRAME_SET_TEXT = 3;
const FRAME_CREATE_ELEMENT = 6;
const FRAME_CREATE_TEXT = 7;
const FRAME_ADD_LISTENER = 12;
const FRAME_INTERN = 14;

const INTERN_ID = 1;
const INTERN_S = 2;
const CREATE_ELEMENT_ID = 1;
const CREATE_ELEMENT_TAG = 2;
const CREATE_TEXT_ID = 1;
const CREATE_TEXT_TEXT = 2;
const INSERT_BEFORE_PARENT = 1;
const INSERT_BEFORE_ID = 2;
const SET_TEXT_ID = 1;
const SET_TEXT_TEXT = 2;
const LISTENER_ID = 1;
const LISTENER_NAME = 2;
const LISTENER_BUBBLES = 3;
const LISTENER_PREVENT_DEFAULT = 6;
const ADD_LISTENER_LISTENER = 1;

/** One length-delimited `Frame` message. `build` writes the op field(s);
 * `commit` sets `Frame.commit`. */
function frame(commit: boolean, build?: (w: Writer) => void): Uint8Array {
  const inner = new Writer();
  if (commit) inner.writeBool(FRAME_COMMIT, true);
  build?.(inner);
  const body = inner.finish();
  const framed = new Writer();
  framed.writeVarint32(body.length);
  const lenBytes = framed.finish();
  const out = new Uint8Array(lenBytes.length + body.length);
  out.set(lenBytes, 0);
  out.set(body, lenBytes.length);
  return out;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

const DIV = 1, CLICK = 2;

/** intern(div), create-element(10, div), insert(root, 10), create-text(11,
 * "hi"), insert(10, 11), set-text(11, "hi there"), commit. */
function basicFrames(): Uint8Array[] {
  return [
    frame(false, (w) => {
      w.writeMessage(FRAME_INTERN, (m) => {
        m.writeUint32(INTERN_ID, DIV);
        m.writeString(INTERN_S, "div");
      });
    }),
    frame(false, (w) => {
      w.writeMessage(FRAME_INTERN, (m) => {
        m.writeUint32(INTERN_ID, CLICK);
        m.writeString(INTERN_S, "click");
      });
    }),
    frame(false, (w) => {
      w.writeMessage(FRAME_CREATE_ELEMENT, (m) => {
        m.writeUint32(CREATE_ELEMENT_ID, 10);
        m.writeUint32(CREATE_ELEMENT_TAG, DIV);
      });
    }),
    frame(false, (w) => {
      w.writeMessage(FRAME_INSERT_BEFORE, (m) => {
        m.writeUint32(INSERT_BEFORE_PARENT, 0);
        m.writeUint32(INSERT_BEFORE_ID, 10);
      });
    }),
    frame(false, (w) => {
      w.writeMessage(FRAME_CREATE_TEXT, (m) => {
        m.writeUint32(CREATE_TEXT_ID, 11);
        m.writeString(CREATE_TEXT_TEXT, "hi");
      });
    }),
    frame(false, (w) => {
      w.writeMessage(FRAME_INSERT_BEFORE, (m) => {
        m.writeUint32(INSERT_BEFORE_PARENT, 10);
        m.writeUint32(INSERT_BEFORE_ID, 11);
      });
    }),
    frame(true, (w) => {
      w.writeMessage(FRAME_SET_TEXT, (m) => {
        m.writeUint32(SET_TEXT_ID, 11);
        m.writeString(SET_TEXT_TEXT, "hi there");
      });
    }),
  ];
}

/** A bubbling `click` listener on node 10, in its own commit. */
function addClickListenerFrame(
  opts?: { preventDefault?: boolean },
): Uint8Array {
  return frame(true, (w) => {
    w.writeMessage(FRAME_ADD_LISTENER, (m) => {
      m.writeMessage(ADD_LISTENER_LISTENER, (l) => {
        l.writeUint32(LISTENER_ID, 10);
        l.writeUint32(LISTENER_NAME, CLICK);
        l.writeBool(LISTENER_BUBBLES, true);
        if (opts?.preventDefault) l.writeBool(LISTENER_PREVENT_DEFAULT, true);
      });
    });
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

  const all = concat(basicFrames());
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
  await pushAndAwaitCommit(driver, concat(basicFrames()));
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
  assertEquals(payload.length > 0, true); // full policy: mouse payload encoded

  withGlobalWindow(win, () => driver.dispose());
});

Deno.test("Driver: a policy whose events omit EventPayload.mouse encodes an empty payload", async () => {
  const { win, root } = fixture();
  const calls: Uint8Array[] = [];
  const policy: Policy = {
    accept: SURFACE_V1.accept,
    events: SURFACE_V1.events.filter((f) => f !== "EventPayload.mouse"),
    queries: SURFACE_V1.queries,
  };
  const driver = createDriver({
    root,
    policy,
    handleEvent: (_t, _n, payload) => {
      calls.push(payload);
    },
  });
  await pushAndAwaitCommit(driver, concat(basicFrames()));
  await pushAndAwaitCommit(driver, addClickListenerFrame());

  const div = root.querySelector("div")!;
  div.dispatchEvent(
    new (win as unknown as { Event: typeof Event }).Event(
      "click",
      { bubbles: true },
    ),
  );

  assertEquals(calls.length, 1);
  assertEquals(calls[0].length, 0);

  withGlobalWindow(win, () => driver.dispose());
});

// -- 3. declarative flags -----------------------------------------------------

Deno.test("Driver: prevent_default is honored even though handleEvent does nothing", async () => {
  const { win, root } = fixture();
  const driver = createDriver({
    root,
    handleEvent: () => {}, // does nothing — flag must still land
  });
  await pushAndAwaitCommit(driver, concat(basicFrames()));
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

Deno.test("Driver: getClientRect refuses under a policy that omits it and answers with it declared", async () => {
  // No policy at all means "no policy" allows everything (policy.ts
  // `queryAllowed`'s "undeclared -> allow"), so refusal needs an EXPLICIT
  // policy whose `queries` omits `get-client-rect`.
  const { win, root } = fixture();
  const refusing: Policy = {
    accept: SURFACE_V1.accept,
    events: SURFACE_V1.events,
    queries: [],
  };
  const noPolicy = createDriver({
    root,
    policy: refusing,
    handleEvent: () => {},
  });
  await pushAndAwaitCommit(noPolicy, concat(basicFrames()));
  assertEquals(noPolicy.queries.getClientRect(10), undefined);
  withGlobalWindow(win, () => noPolicy.dispose());

  const { win: win2, root: root2 } = fixture();
  const policy: Policy = {
    accept: SURFACE_V1.accept,
    events: SURFACE_V1.events,
    queries: ["get-client-rect"],
  };
  const withPolicy = createDriver({
    root: root2,
    policy,
    handleEvent: () => {},
  });
  await pushAndAwaitCommit(withPolicy, concat(basicFrames()));
  const rect = withPolicy.queries.getClientRect(10);
  assertEquals(rect, { origin: { x: 0, y: 0 }, size: { width: 0, height: 0 } });
  withGlobalWindow(win2, () => withPolicy.dispose());
});

Deno.test("Driver: setFocus refuses under a policy that omits it and answers with it declared", async () => {
  const { win, root } = fixture();
  const refusing: Policy = {
    accept: SURFACE_V1.accept,
    events: SURFACE_V1.events,
    queries: [],
  };
  const noPolicy = createDriver({
    root,
    policy: refusing,
    handleEvent: () => {},
  });
  await pushAndAwaitCommit(noPolicy, concat(basicFrames()));
  assertEquals(noPolicy.queries.setFocus(10, true), false);
  withGlobalWindow(win, () => noPolicy.dispose());

  const { win: win2, root: root2 } = fixture();
  const policy: Policy = {
    accept: SURFACE_V1.accept,
    events: SURFACE_V1.events,
    queries: ["set-focus"],
  };
  const withPolicy = createDriver({
    root: root2,
    policy,
    handleEvent: () => {},
  });
  await pushAndAwaitCommit(withPolicy, concat(basicFrames()));
  assertEquals(withPolicy.queries.setFocus(10, true), true);
  withGlobalWindow(win2, () => withPolicy.dispose());
});

// -- 5. abort semantics ---------------------------------------------------------

Deno.test("Driver: a policy violation (undeclared field) throws PolicyError", () => {
  const { win, root } = fixture();
  const policy: Policy = {
    // Missing "Frame.create_element" — the frame sequence below uses it.
    accept: SURFACE_V1.accept.filter((f) => f !== "Frame.create_element"),
    events: SURFACE_V1.events,
    queries: SURFACE_V1.queries,
  };
  const driver = createDriver({ root, policy, handleEvent: () => {} });
  assertThrows(
    () => driver.push(concat(basicFrames())),
    PolicyError,
  );
  withGlobalWindow(win, () => driver.dispose());
});

Deno.test("Driver: an unknown node id throws", () => {
  const { win, root } = fixture();
  const driver = createDriver({ root, handleEvent: () => {} });
  const bad = frame(true, (w) => {
    w.writeMessage(FRAME_SET_TEXT, (m) => {
      m.writeUint32(SET_TEXT_ID, 999);
      m.writeString(SET_TEXT_TEXT, "x");
    });
  });
  assertThrows(() => driver.push(bad), Error, "unknown node id 999");
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
  await pushAndAwaitCommit(driver, concat(basicFrames()));
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
  driver.push(concat(basicFrames()));
});
