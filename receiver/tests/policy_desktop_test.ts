// desktopPolicy (policy-desktop.ts): the untrusted-producer vocabulary for
// a Tauri-style embedding. One positive + one negative per deny category,
// budget exhaustion, and a whole-stream test through `createDriver`.
// Governing docs: docs/design.md "Policy", "Events" (per-event-type
// default preventDefault), "Assets are handles, not bytes and not URLs",
// "Refs are ids; third-party DOM libraries need islands".

import { assertEquals, assertMatch, assertThrows } from "@std/assert";
import { parseHTML } from "linkedom";
import { createDriver } from "../src/driver.ts";
import { PolicyError } from "../src/policy.ts";
import { desktopPolicy } from "../src/policy-desktop.ts";
import { Writer } from "../src/proto.ts";

// -- unit harness ----------------------------------------------------------

function allow(reason: string | undefined, msg: string): void {
  assertEquals(reason, undefined, msg);
}

function deny(reason: string | undefined, needle: string, msg: string): void {
  if (reason === undefined) throw new Error(`${msg}: expected a rejection`);
  assertMatch(reason, new RegExp(needle), msg);
}

// -- createElement: tag allowlist / namespace / islands --------------------

Deno.test("desktopPolicy.createElement: allows a plain <div>, denies <script>", () => {
  const p = desktopPolicy();
  allow(
    p.check({ op: "createElement", tag: "div", ns: undefined }),
    "div",
  );
  deny(
    p.check({ op: "createElement", tag: "script", ns: undefined }),
    "script",
    "script",
  );
});

Deno.test("desktopPolicy.createElement: every explicitly denied tag is rejected, with the vocabulary rule phrase", () => {
  const p = desktopPolicy();
  for (
    const tag of [
      "script",
      "noscript",
      "iframe",
      "frame",
      "frameset",
      "object",
      "embed",
      "applet",
      "base",
      "meta",
      "link",
      "style",
      "template",
      "slot",
      "portal",
      "html",
      "head",
      "body",
      "title",
      "math",
    ]
  ) {
    deny(
      p.check({ op: "createElement", tag, ns: undefined }),
      "is not in the host vocabulary",
      `denied tag ${tag}`,
    );
  }
});

Deno.test("desktopPolicy.createElement: 'SCRIPT' (case) is denied like 'script'", () => {
  const p = desktopPolicy();
  deny(
    p.check({ op: "createElement", tag: "SCRIPT", ns: undefined }),
    "is not in the host vocabulary",
    "SCRIPT",
  );
});

Deno.test("desktopPolicy.createElement: a long-s '\u017Fcript' tag is denied (but NOT because it collides with 'script')", () => {
  // `.toLowerCase()` does not fold U+017F LATIN SMALL LETTER LONG S to
  // "s" — it is already its own lowercase form, and the ONLY direction
  // that pair folds is "S".toLowerCase() -> "s" (never the reverse). So
  // "\u017Fcript" never becomes the string "script" here; it is denied
  // for the ordinary reason that it is simply not a name in
  // ELEMENT_TAGS, which is the safe outcome either way.
  const p = desktopPolicy();
  const reason = p.check({
    op: "createElement",
    tag: "\u017Fcript",
    ns: undefined,
  });
  deny(reason, "is not in the host vocabulary", "long-s script look-alike");
});

Deno.test("desktopPolicy.createElement: SVG namespace allowed, an unknown namespace denied", () => {
  const p = desktopPolicy();
  allow(
    p.check({
      op: "createElement",
      tag: "svg",
      ns: "http://www.w3.org/2000/svg",
    }),
    "svg ns",
  );
  deny(
    p.check({
      op: "createElement",
      tag: "div",
      ns: "http://example.com/weird",
    }),
    "namespace",
    "unknown ns",
  );
});

Deno.test("desktopPolicy.createElement: a hyphenated tag is denied unless it is a registered island", () => {
  const plain = desktopPolicy();
  deny(
    plain.check({ op: "createElement", tag: "my-widget", ns: undefined }),
    "island",
    "no islands configured",
  );

  const withIslands = desktopPolicy({ islands: ["my-widget"] });
  allow(
    withIslands.check({ op: "createElement", tag: "my-widget", ns: undefined }),
    "registered island",
  );
});

Deno.test("desktopPolicy.createElement: islands are lowercased at construction", () => {
  const p = desktopPolicy({ islands: ["My-Widget"] });
  allow(
    p.check({ op: "createElement", tag: "my-widget", ns: undefined }),
    "lowercase tag matches an uppercase-registered island",
  );
  allow(
    p.check({ op: "createElement", tag: "MY-WIDGET", ns: undefined }),
    "uppercase tag also matches (both sides lowercased)",
  );
});

// -- setAttribute -----------------------------------------------------------

Deno.test("desktopPolicy.setAttribute: allows class text, denies on* handlers (including ONclick, case-insensitively)", () => {
  const p = desktopPolicy();
  allow(
    p.check({
      op: "setAttribute",
      tag: "div",
      name: "class",
      ns: undefined,
      value: { kind: "text", value: "row" },
    }),
    "class",
  );
  for (const name of ["onclick", "ONclick", "OnClick"]) {
    deny(
      p.check({
        op: "setAttribute",
        tag: "div",
        name,
        ns: undefined,
        value: { kind: "text", value: "alert(1)" },
      }),
      "looks like an event handler",
      name,
    );
  }
});

Deno.test("desktopPolicy.setAttribute: every dangerous non-allowlisted attribute name is rejected, with the allowlist rule phrase", () => {
  const p = desktopPolicy();
  for (
    const name of [
      "srcdoc",
      "sandbox",
      "allow",
      "formaction",
      "form",
      "target",
      "ping",
      "http-equiv",
      "content",
      "is",
      "slot",
      "nonce",
      "integrity",
      "popovertarget",
      "popovertargetaction",
      "commandfor",
      "command",
      "formtarget",
      "formmethod",
      "formenctype",
      "download",
    ]
  ) {
    deny(
      p.check({
        op: "setAttribute",
        tag: "div",
        name,
        ns: undefined,
        value: { kind: "text", value: "x" },
      }),
      "is not in the desktop attribute allowlist",
      `denied attribute ${name}`,
    );
  }
  // `rel` is explicitly allowlisted.
  allow(
    p.check({
      op: "setAttribute",
      tag: "a",
      name: "rel",
      ns: undefined,
      value: { kind: "text", value: "noopener" },
    }),
    "rel",
  );
});

Deno.test("desktopPolicy.setAttribute: 'name' is allowed only on the form-control tag set", () => {
  const p = desktopPolicy();
  allow(
    p.check({
      op: "setAttribute",
      tag: "input",
      name: "name",
      ns: undefined,
      value: { kind: "text", value: "email" },
    }),
    "name on <input>",
  );
  for (const tag of ["form", "img", "div"]) {
    deny(
      p.check({
        op: "setAttribute",
        tag,
        name: "name",
        ns: undefined,
        value: { kind: "text", value: "x" },
      }),
      "DOM clobbering",
      `name on <${tag}>`,
    );
  }
});

Deno.test("desktopPolicy.setAttribute: aria-* and data-* pass through", () => {
  const p = desktopPolicy();
  allow(
    p.check({
      op: "setAttribute",
      tag: "div",
      name: "aria-label",
      ns: undefined,
      value: { kind: "text", value: "close" },
    }),
    "aria-label",
  );
  allow(
    p.check({
      op: "setAttribute",
      tag: "div",
      name: "data-testid",
      ns: undefined,
      value: { kind: "text", value: "x" },
    }),
    "data-testid",
  );
});

Deno.test("desktopPolicy.setAttribute: style is denied by default, allowed with opts.inlineStyle", () => {
  const denied = desktopPolicy();
  deny(
    denied.check({
      op: "setAttribute",
      tag: "div",
      name: "style",
      ns: undefined,
      value: { kind: "text", value: "color:red" },
    }),
    "style",
    "style denied by default",
  );
  const allowed = desktopPolicy({ inlineStyle: true });
  allow(
    allowed.check({
      op: "setAttribute",
      tag: "div",
      name: "style",
      ns: undefined,
      value: { kind: "text", value: "color:red" },
    }),
    "style allowed with opt-in",
  );
});

Deno.test("desktopPolicy.setAttribute: a javascript: href as text is rejected; the same handle as an asset is allowed", () => {
  const p = desktopPolicy();
  deny(
    p.check({
      op: "setAttribute",
      tag: "a",
      name: "href",
      ns: undefined,
      value: { kind: "text", value: "javascript:alert(1)" },
    }),
    "asset handle",
    "text href",
  );
  allow(
    p.check({
      op: "setAttribute",
      tag: "a",
      name: "href",
      ns: undefined,
      value: { kind: "asset", handle: Uint8Array.of(1) },
    }),
    "asset href",
  );
});

Deno.test("desktopPolicy.setAttribute: relativeHref allows # and same-origin / text hrefs on <a>, never protocol-relative or backslash-disguised ones", () => {
  const p = desktopPolicy({ relativeHref: true });
  allow(
    p.check({
      op: "setAttribute",
      tag: "a",
      name: "href",
      ns: undefined,
      value: { kind: "text", value: "#section" },
    }),
    "#section",
  );
  allow(
    p.check({
      op: "setAttribute",
      tag: "a",
      name: "href",
      ns: undefined,
      value: { kind: "text", value: "/path" },
    }),
    "/path",
  );
  for (
    const [label, value] of [
      ["protocol-relative //", "//evil.example"],
      ["backslash-disguised //", "/\\evil.example/x"],
      ["tab control char", "/\t/evil.example"],
      ["newline + backslash", "/\n\\evil.example"],
    ] as const
  ) {
    deny(
      p.check({
        op: "setAttribute",
        tag: "a",
        name: "href",
        ns: undefined,
        value: { kind: "text", value },
      }),
      "asset handle",
      label,
    );
  }
});

Deno.test("desktopPolicy.setAttribute: externalLinks allows an https:// text href on <a>", () => {
  const p = desktopPolicy({ externalLinks: true });
  allow(
    p.check({
      op: "setAttribute",
      tag: "a",
      name: "href",
      ns: undefined,
      value: { kind: "text", value: "https://example.com" },
    }),
    "https://",
  );
  allow(
    p.check({
      op: "setAttribute",
      tag: "a",
      name: "href",
      ns: undefined,
      value: { kind: "text", value: "HTTP://example.com" },
    }),
    "HTTP:// (case-insensitive scheme)",
  );
});

Deno.test("desktopPolicy.setAttribute: without externalLinks an https:// text href on <a> is still rejected", () => {
  const p = desktopPolicy();
  deny(
    p.check({
      op: "setAttribute",
      tag: "a",
      name: "href",
      ns: undefined,
      value: { kind: "text", value: "https://example.com" },
    }),
    "asset handle",
    "externalLinks not enabled",
  );
});

Deno.test("desktopPolicy.setAttribute: a namespaced attribute name other than xlink:href/xml:lang/xml:space is denied", () => {
  const p = desktopPolicy();
  deny(
    p.check({
      op: "setAttribute",
      tag: "svg",
      name: "evil:thing",
      ns: undefined,
      value: { kind: "text", value: "x" },
    }),
    "namespace prefix",
    "evil:thing",
  );
  allow(
    p.check({
      op: "setAttribute",
      tag: "use",
      name: "xlink:href",
      ns: "http://www.w3.org/1999/xlink",
      value: { kind: "asset", handle: Uint8Array.of(1) },
    }),
    "xlink:href",
  );
});

Deno.test("desktopPolicy.setAttribute: an unprefixed name carrying a namespace is denied even when the name itself is allowlisted", () => {
  // `href` with no colon in the name but a foreign (or even the CORRECT
  // xlink) namespace attached is still not `xlink:href`, so it must not
  // slip through under the "op.ns !== undefined" general rule.
  const p = desktopPolicy();
  deny(
    p.check({
      op: "setAttribute",
      tag: "a",
      name: "href",
      ns: "http://www.w3.org/1999/xlink",
      value: { kind: "asset", handle: Uint8Array.of(1) },
    }),
    "unrecognized namespace",
    "href with xlink ns but no xlink: prefix",
  );
  deny(
    p.check({
      op: "setAttribute",
      tag: "div",
      name: "class",
      ns: "http://example.com/weird",
      value: { kind: "text", value: "x" },
    }),
    "unrecognized namespace",
    "class with an arbitrary namespace",
  );
});

Deno.test("desktopPolicy.setAttribute: 'formaction' is denied even on <input type=image>, regardless of value kind", () => {
  const p = desktopPolicy();
  deny(
    p.check({
      op: "setAttribute",
      tag: "input",
      name: "formaction",
      ns: undefined,
      value: { kind: "text", value: "/submit" },
    }),
    "is not in the desktop attribute allowlist",
    "formaction text",
  );
  deny(
    p.check({
      op: "setAttribute",
      tag: "input",
      name: "formaction",
      ns: undefined,
      value: { kind: "asset", handle: Uint8Array.of(1) },
    }),
    "is not in the desktop attribute allowlist",
    "formaction asset",
  );
});

Deno.test("desktopPolicy.setAttribute: a text 'href' on <use> (not <a>) requires an asset handle", () => {
  const p = desktopPolicy({ relativeHref: true, externalLinks: true });
  deny(
    p.check({
      op: "setAttribute",
      tag: "use",
      name: "href",
      ns: undefined,
      value: { kind: "text", value: "#icon-check" },
    }),
    "asset handle",
    "<use href> text, even one that would pass relativeHref on <a>",
  );
});

Deno.test("desktopPolicy.setAttribute: a text 'srcset' is denied (URL-kind, asset-only, no <a>-only exception applies)", () => {
  const p = desktopPolicy({ relativeHref: true, externalLinks: true });
  deny(
    p.check({
      op: "setAttribute",
      tag: "img",
      name: "srcset",
      ns: undefined,
      value: { kind: "text", value: "/a.png 1x, /b.png 2x" },
    }),
    "asset handle",
    "srcset text",
  );
});

Deno.test("desktopPolicy.setAttribute: maxStringBytes rejects an oversized text value", () => {
  const p = desktopPolicy({ maxStringBytes: 4 });
  allow(
    p.check({
      op: "setAttribute",
      tag: "div",
      name: "class",
      ns: undefined,
      value: { kind: "text", value: "ab" },
    }),
    "small value",
  );
  deny(
    p.check({
      op: "setAttribute",
      tag: "div",
      name: "class",
      ns: undefined,
      value: { kind: "text", value: "abcdefgh" },
    }),
    "maxStringBytes",
    "oversized value",
  );
});

Deno.test("desktopPolicy.setProperty: maxStringBytes also applies to a string property value", () => {
  const p = desktopPolicy({ maxStringBytes: 4 });
  allow(
    p.check({
      op: "setProperty",
      tag: "div",
      name: "textContent",
      value: { kind: "text", value: "ab" },
    }),
    "small value",
  );
  deny(
    p.check({
      op: "setProperty",
      tag: "div",
      name: "textContent",
      value: { kind: "text", value: "abcdefgh" },
    }),
    "maxStringBytes",
    "oversized value",
  );
});

// -- setProperty --------------------------------------------------------

Deno.test("desktopPolicy.setProperty: allows 'value', denies 'innerHTML'", () => {
  const p = desktopPolicy();
  allow(
    p.check({
      op: "setProperty",
      tag: "input",
      name: "value",
      value: { kind: "text", value: "x" },
    }),
    "value",
  );
  deny(
    p.check({
      op: "setProperty",
      tag: "div",
      name: "innerHTML",
      value: { kind: "text", value: "<img onerror=alert(1)>" },
    }),
    "innerHTML",
    "innerHTML",
  );
});

Deno.test("desktopPolicy.setProperty: __proto__/constructor/prototype are denied", () => {
  const p = desktopPolicy();
  for (const name of ["__proto__", "constructor", "prototype"]) {
    deny(
      p.check({
        op: "setProperty",
        tag: "div",
        name,
        value: { kind: "text", value: "x" },
      }),
      name === "__proto__" ? "proto" : name,
      name,
    );
  }
});

// -- addListener ----------------------------------------------------------

Deno.test("desktopPolicy.addListener: allows 'click' on a node, denies an out-of-vocabulary node event", () => {
  const p = desktopPolicy();
  allow(
    p.check({
      op: "addListener",
      target: "node",
      name: "click",
      capture: false,
      passive: false,
      preventDefault: false,
      stopPropagation: false,
    }),
    "click",
  );
  deny(
    p.check({
      op: "addListener",
      target: "node",
      name: "devicemotion",
      capture: false,
      passive: false,
      preventDefault: false,
      stopPropagation: false,
    }),
    "devicemotion",
    "devicemotion",
  );
});

Deno.test("desktopPolicy.addListener: window allows 'resize', denies 'keydown'", () => {
  const p = desktopPolicy();
  allow(
    p.check({
      op: "addListener",
      target: "window",
      name: "resize",
      capture: false,
      passive: false,
      preventDefault: false,
      stopPropagation: false,
    }),
    "window resize",
  );
  deny(
    p.check({
      op: "addListener",
      target: "window",
      name: "keydown",
      capture: false,
      passive: false,
      preventDefault: false,
      stopPropagation: false,
    }),
    "keydown",
    "window keydown",
  );
});

Deno.test("desktopPolicy.addListener: document allows only 'visibilitychange' — NOT 'keydown' (document-wide keylogging)", () => {
  const p = desktopPolicy();
  allow(
    p.check({
      op: "addListener",
      target: "document",
      name: "visibilitychange",
      capture: false,
      passive: false,
      preventDefault: false,
      stopPropagation: false,
    }),
    "document visibilitychange",
  );
  for (const name of ["keydown", "keyup", "resize"]) {
    deny(
      p.check({
        op: "addListener",
        target: "document",
        name,
        capture: false,
        passive: false,
        preventDefault: false,
        stopPropagation: false,
      }),
      name,
      `document ${name}`,
    );
  }
});

// -- bindMarker -------------------------------------------------------------

Deno.test("desktopPolicy.bindMarker: always denied", () => {
  const p = desktopPolicy();
  deny(p.check({ op: "bindMarker" }), "not supported", "bindMarker");
});

// -- query ------------------------------------------------------------------

Deno.test("desktopPolicy.query: allowed by default, disabled entirely by opts.queries=false", () => {
  const p = desktopPolicy();
  assertEquals(p.query?.("get-client-rect"), true);
  assertEquals(p.query?.("set-focus"), true);

  const noQueries = desktopPolicy({ queries: false });
  assertEquals(noQueries.query?.("get-client-rect"), false);
});

// -- budgets ------------------------------------------------------------

Deno.test("desktopPolicy: maxNodes exhausts after that many createElement checks", () => {
  const p = desktopPolicy({ maxNodes: 2 });
  allow(p.check({ op: "createElement", tag: "div", ns: undefined }), "1st");
  allow(p.check({ op: "createElement", tag: "div", ns: undefined }), "2nd");
  deny(
    p.check({ op: "createElement", tag: "div", ns: undefined }),
    "node budget",
    "3rd exceeds maxNodes",
  );
});

Deno.test("desktopPolicy: maxListeners exhausts after that many addListener checks", () => {
  const p = desktopPolicy({ maxListeners: 1 });
  const op = {
    op: "addListener" as const,
    target: "node" as const,
    name: "click",
    capture: false,
    passive: false,
    preventDefault: false,
    stopPropagation: false,
  };
  allow(p.check(op), "1st");
  deny(p.check(op), "listener budget", "2nd exceeds maxListeners");
});

// -- whole-stream, through createDriver + linkedom --------------------------
//
// Reuses the frame-encoder pattern from policy_test.ts / driver_test.ts:
// a `Writer`-backed length-delimited `Frame` builder, rather than a new
// encoder.

const FRAME_SET_ATTRIBUTE = 4;
const FRAME_CREATE_ELEMENT = 6;
const FRAME_INSERT_BEFORE = 2;
const FRAME_ADD_LISTENER = 12;
const FRAME_INTERN = 14;
const FRAME_COMMIT = 1;

const INTERN_ID = 1;
const INTERN_S = 2;
const CREATE_ELEMENT_ID = 1;
const CREATE_ELEMENT_TAG = 2;
const INSERT_BEFORE_PARENT = 1;
const INSERT_BEFORE_ID = 2;
const SET_ATTRIBUTE_ID = 1;
const SET_ATTRIBUTE_NAME = 2;
const SET_ATTRIBUTE_TEXT = 4;
const LISTENER_ID = 1;
const LISTENER_NAME = 2;
const LISTENER_BUBBLES = 3;
const ADD_LISTENER_LISTENER = 1;

function frame(commit: boolean, build?: (w: Writer) => void): Uint8Array {
  const inner = new Writer();
  if (commit) inner.writeBool(FRAME_COMMIT, true);
  build?.(inner);
  const body = inner.finish();
  const lenW = new Writer();
  lenW.writeVarint32(body.length);
  const lenBytes = lenW.finish();
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

function internFrame(id: number, s: string): Uint8Array {
  return frame(false, (w) => {
    w.writeMessage(FRAME_INTERN, (m) => {
      m.writeUint32(INTERN_ID, id);
      m.writeString(INTERN_S, s);
    });
  });
}

function createElementFrame(id: number, tagRef: number): Uint8Array {
  return frame(false, (w) => {
    w.writeMessage(FRAME_CREATE_ELEMENT, (m) => {
      m.writeUint32(CREATE_ELEMENT_ID, id);
      m.writeUint32(CREATE_ELEMENT_TAG, tagRef);
    });
  });
}

function insertBeforeFrame(parent: number, id: number): Uint8Array {
  return frame(false, (w) => {
    w.writeMessage(FRAME_INSERT_BEFORE, (m) => {
      m.writeUint32(INSERT_BEFORE_PARENT, parent);
      m.writeUint32(INSERT_BEFORE_ID, id);
    });
  });
}

function setAttributeTextFrame(
  id: number,
  nameRef: number,
  text: string,
): Uint8Array {
  return frame(false, (w) => {
    w.writeMessage(FRAME_SET_ATTRIBUTE, (m) => {
      m.writeUint32(SET_ATTRIBUTE_ID, id);
      m.writeUint32(SET_ATTRIBUTE_NAME, nameRef);
      m.writeString(SET_ATTRIBUTE_TEXT, text);
    });
  });
}

function addListenerFrame(id: number, nameRef: number): Uint8Array {
  return frame(true, (w) => {
    w.writeMessage(FRAME_ADD_LISTENER, (m) => {
      m.writeMessage(ADD_LISTENER_LISTENER, (l) => {
        l.writeUint32(LISTENER_ID, id);
        l.writeUint32(LISTENER_NAME, nameRef);
        l.writeBool(LISTENER_BUBBLES, true);
      });
    });
  });
}

function fixture() {
  const win = parseHTML(
    `<!doctype html><html><body><div id="root"></div></body></html>`,
  );
  const doc = win.document as unknown as Document;
  const root = doc.getElementById("root")!;
  return { win, root };
}

const DIV = 1, FORM = 2, INPUT = 3, BUTTON = 4, SUBMIT = 5, A = 6, HREF = 7;

Deno.test("desktopPolicy: a div > form > input + button stream with a submit listener applies", () => {
  const { root } = fixture();
  const driver = createDriver({
    root,
    policy: desktopPolicy(),
    handleEvent: () => {},
  });

  driver.push(concat([
    internFrame(DIV, "div"),
    internFrame(FORM, "form"),
    internFrame(INPUT, "input"),
    internFrame(BUTTON, "button"),
    internFrame(SUBMIT, "submit"),
    createElementFrame(10, DIV),
    insertBeforeFrame(0, 10),
    createElementFrame(11, FORM),
    insertBeforeFrame(10, 11),
    createElementFrame(12, INPUT),
    insertBeforeFrame(11, 12),
    createElementFrame(13, BUTTON),
    insertBeforeFrame(11, 13),
    addListenerFrame(11, SUBMIT),
  ]));

  assertEquals(
    root.innerHTML,
    "<div><form><input><button></button></form></div>",
  );
});

Deno.test("desktopPolicy: an <a href> with a javascript: text value is rejected with a PolicyError", () => {
  const { root } = fixture();
  const driver = createDriver({
    root,
    policy: desktopPolicy(),
    handleEvent: () => {},
  });

  assertThrows(
    () =>
      driver.push(concat([
        internFrame(A, "a"),
        internFrame(HREF, "href"),
        createElementFrame(20, A),
        insertBeforeFrame(0, 20),
        setAttributeTextFrame(20, HREF, "javascript:alert(1)"),
      ])),
    PolicyError,
    "asset handle",
  );
});
