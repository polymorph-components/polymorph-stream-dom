// `NativeDomReceiver` under a real-ish DOM (linkedom), covering the happy
// path of every op and each fail-closed rule the receiver owns
// (docs/design.md "Policy", "What the receiver does not yet guarantee").
//
// Everything here throws a plain `Error`, which is the whole contract:
// anything the sink throws propagates out of `FrameDecoder.push` and the
// mount aborts the stream (docs/design.md "Policy", "The seam").

import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import { parseHTML } from "linkedom";
import { NativeDomReceiver } from "../src/native.ts";
import type { TemplateNode } from "../src/frames.ts";

// -- harness --------------------------------------------------------------

/** A real browser DOM enforces tree acyclicity itself: `insertBefore` /
 * `appendChild` / `moveBefore` throw `HierarchyRequestError` when the node
 * being inserted IS the parent or an ancestor of it. The receiver relies
 * on that guarantee and deliberately does not re-walk ancestors on the
 * insert hot path. linkedom only rejects the self-append case and will
 * happily build a cycle out of a node and its own parent, after which any
 * traversal hangs — so the test DOM gets a shim that reproduces the
 * browser's guarantee. This is emulating a browser invariant, not testing
 * receiver code.
 */
/** Is `node` `parent` itself, or one of its ancestors? Takes `parent` as
 * an argument rather than walking from `this` inside the patched method:
 * `deno lint`'s no-this-alias forbids binding `this` to a local. */
function containsOrIs(parent: Node, node: Node): boolean {
  for (let p: Node | null = parent; p !== null; p = p.parentNode) {
    if (p === node) return true;
  }
  return false;
}

const guarded = new WeakSet<object>();
function installHierarchyGuard(doc: Document): void {
  // linkedom mixes `insertBefore`/`appendChild` into several prototypes in
  // the chain (its ParentNode mixin lands on `Element.prototype`, shadowing
  // `Node.prototype`), so patch every own definition along the chain of a
  // sample element rather than assuming one home.
  let proto: object | null = Object.getPrototypeOf(doc.createElement("div"));
  for (; proto !== null; proto = Object.getPrototypeOf(proto)) {
    if (guarded.has(proto)) continue;
    guarded.add(proto);
    const target = proto as unknown as Record<string, unknown>;
    for (const name of ["insertBefore", "appendChild", "moveBefore"]) {
      if (!Object.getOwnPropertyDescriptor(proto, name)) continue;
      const orig = target[name];
      if (typeof orig !== "function") continue;
      const call = orig as (this: Node, ...args: unknown[]) => unknown;
      target[name] = function (this: Node, node: Node, ...rest: unknown[]) {
        if (containsOrIs(this, node)) {
          throw new DOMException(
            `${name}: the node is an ancestor of the parent`,
            "HierarchyRequestError",
          );
        }
        return call.call(this, node, ...rest);
      };
    }
  }
}

interface Fixture {
  doc: Document;
  /** The mount root — producer id 0. */
  root: Element;
  /** The root's parent, owned by the embedder. */
  container: Element;
  /** A sibling of the root that no op may ever touch. */
  sentinel: Element;
  recv: NativeDomReceiver;
}

export function fixture(): Fixture {
  const win = parseHTML(
    `<!doctype html><html><body><section id="container"><div id="root"></div><span id="sentinel">untouched</span></section></body></html>`,
  );
  const doc = win.document as unknown as Document;
  installHierarchyGuard(doc);
  const container = doc.getElementById("container")!;
  const root = doc.getElementById("root")!;
  const sentinel = doc.getElementById("sentinel")!;
  return { doc, root, container, sentinel, recv: new NativeDomReceiver(root) };
}

/** Intern refs used across the tests below. */
const DIV = 1, SPAN = 2, CLASS = 3, CLICK = 4, SVG_NS = 5;

function interned(recv: NativeDomReceiver): void {
  recv.internString(DIV, "div");
  recv.internString(SPAN, "span");
  recv.internString(CLASS, "class");
  recv.internString(CLICK, "click");
  recv.internString(SVG_NS, "http://www.w3.org/2000/svg");
}

// -- happy path -----------------------------------------------------------

Deno.test("NativeDomReceiver: every op on the happy path", () => {
  const { recv, root } = fixture();
  interned(recv);

  recv.createElement(1, DIV, undefined);
  recv.createText(2, "hello");
  recv.createPlaceholder(3);
  recv.insertBefore(0, 1, undefined); // append to the mount root
  recv.insertBefore(1, 2, undefined);
  recv.insertAfter(1, 3, 2);
  recv.setText(2, "hello, world");
  recv.setAttribute(1, CLASS, undefined, { kind: "text", value: "greeting" });
  recv.setProperty(1, CLASS, { kind: "text", value: "prop" });
  recv.addListener({
    target: { kind: "node", id: 1 },
    name: CLICK,
    bubbles: true,
    capture: false,
    passive: false,
    preventDefault: false,
    stopPropagation: false,
  });
  assertEquals(recv.listeners.listenerFor(1, CLICK)?.name, CLICK);

  // A namespaced element: the reason this receiver exists beside the
  // remote-dom one.
  recv.createElement(4, SPAN, SVG_NS);
  recv.insertBefore(0, 4, undefined);
  assertEquals(
    (recv.resolveNode(4) as Element).namespaceURI,
    "http://www.w3.org/2000/svg",
  );

  // register-template / clone-template / bind-path.
  const nodes: TemplateNode[] = [
    {
      kind: "element",
      element: {
        tag: DIV,
        ns: undefined,
        attrs: [{
          name: CLASS,
          ns: undefined,
          value: { kind: "text", value: "row" },
        }],
        children: [1, 2],
      },
    },
    { kind: "text", text: "cell" },
    { kind: "dynamic" },
  ];
  recv.registerTemplate(7, nodes, [0]);
  recv.cloneTemplate(7, 0, 10);
  recv.bindPath(10, Uint8Array.of(0), 11); // the "cell" text node
  recv.setText(11, "bound");
  recv.insertBefore(0, 10, undefined);

  assertEquals(
    root.innerHTML,
    `<div class="greeting">hello, world<!----></div>` +
      `<span />` + // linkedom self-closes a foreign (SVG) element
      `<div class="row">bound<!----></div>`,
  );

  recv.removeListener({
    target: { kind: "node", id: 1 },
    name: CLICK,
    bubbles: true,
    capture: false,
    passive: false,
    preventDefault: false,
    stopPropagation: false,
  });
  assertEquals(recv.listeners.listenerFor(1, CLICK), undefined);

  let commits = 0;
  recv.onCommit = () => commits++;
  recv.commit();
  assertEquals(commits, 1);

  recv.remove(1);
  assertEquals(recv.resolveNode(1), undefined);
  assertEquals(recv.resolveNode(2), undefined); // freed with the subtree
  recv.dispose();
});

// -- 1. the mount root is structurally inviolable -------------------------

Deno.test("NativeDomReceiver: no op may create, re-register or alias id 0", () => {
  const { recv, root } = fixture();
  interned(recv);
  recv.registerTemplate(7, [{ kind: "text", text: "t" }], [0]);
  recv.createElement(1, DIV, undefined);

  assertThrows(
    () => recv.createElement(0, DIV, undefined),
    Error,
    "mount root",
  );
  assertThrows(() => recv.createText(0, "x"), Error, "mount root");
  assertThrows(() => recv.createPlaceholder(0), Error, "mount root");
  assertThrows(() => recv.cloneTemplate(7, 0, 0), Error, "mount root");
  assertThrows(
    () => recv.bindPath(1, new Uint8Array(0), 0),
    Error,
    "mount root",
  );
  // Aliasing the root under a second id: bind-path with an empty path.
  assertThrows(() => recv.bindPath(0, new Uint8Array(0), 99), Error, "alias");

  assertStrictEquals(recv.resolveNode(0), root);
});

Deno.test("NativeDomReceiver: no op may move or remove id 0", () => {
  const { recv, root, container, sentinel } = fixture();
  interned(recv);
  recv.createElement(1, DIV, undefined);
  recv.insertBefore(0, 1, undefined);

  assertThrows(() => recv.insertBefore(1, 0, undefined), Error, "mount root");
  assertThrows(() => recv.insertAfter(1, 0, 1), Error, "mount root");
  assertThrows(() => recv.remove(0), Error, "mount root");

  assertStrictEquals(root.parentNode, container);
  assertStrictEquals(container.firstElementChild, root);
  assertEquals(sentinel.outerHTML, `<span id="sentinel">untouched</span>`);
});

Deno.test("NativeDomReceiver: the mount root may not be used as an insert anchor", () => {
  const { recv, root, container, sentinel } = fixture();
  interned(recv);
  recv.createElement(1, DIV, undefined);

  // With `parent` omitted the parent is implied from the anchor, so anchor
  // 0 would resolve to the EMBEDDER's container and drop a producer node
  // beside the mount root, outside the mount entirely.
  assertThrows(() => recv.insertBefore(undefined, 1, 0), Error, "anchor");
  assertThrows(() => recv.insertAfter(undefined, 1, 0), Error, "anchor");
  // Naming a parent does not rehabilitate it.
  assertThrows(() => recv.insertBefore(0, 1, 0), Error, "anchor");
  assertThrows(() => recv.insertAfter(0, 1, 0), Error, "anchor");

  assertEquals(container.childNodes.length, 2);
  assertStrictEquals(container.childNodes[0], root);
  assertEquals(sentinel.outerHTML, `<span id="sentinel">untouched</span>`);
  assertEquals(root.innerHTML, "");
});

Deno.test("NativeDomReceiver: leaf ops on the root stay legal", () => {
  const { recv, root } = fixture();
  interned(recv);
  recv.setAttribute(0, CLASS, undefined, { kind: "text", value: "mounted" });
  assertEquals(root.getAttribute("class"), "mounted");
  recv.setProperty(0, CLASS, { kind: "boolean", value: true });
  recv.setAttribute(0, CLASS, undefined, undefined);
  assertEquals(root.hasAttribute("class"), false);
  // ...and the root is still the root; a leaf op registers nothing.
  assertStrictEquals(recv.resolveNode(0), root);
});

// -- 2. ids are not reused ------------------------------------------------

Deno.test("NativeDomReceiver: a currently-registered id cannot be re-registered", () => {
  const { recv } = fixture();
  interned(recv);
  recv.createElement(1, DIV, undefined);
  const first = recv.resolveNode(1);

  assertThrows(
    () => recv.createElement(1, SPAN, undefined),
    Error,
    "already registered",
  );
  assertThrows(() => recv.createText(1, "x"), Error, "already registered");
  assertThrows(() => recv.createPlaceholder(1), Error, "already registered");
  assertStrictEquals(recv.resolveNode(1), first);
});

Deno.test("NativeDomReceiver: remove frees the id, and a fresh create may take it", () => {
  const { recv, root } = fixture();
  interned(recv);
  recv.createElement(1, DIV, undefined);
  recv.insertBefore(0, 1, undefined);
  recv.remove(1);
  assertEquals(recv.resolveNode(1), undefined);
  // Only CURRENTLY registered ids are rejected: this receiver keeps no
  // record of ids a `remove` forgot, so the proto's "never reused" rule is
  // only half-enforceable (see `#register`'s doc). Re-creating id 1 here
  // is a protocol violation the receiver cannot see, and it must not
  // corrupt anything.
  recv.createElement(2, SPAN, undefined);
  recv.insertBefore(0, 2, undefined);
  assertEquals(root.innerHTML, "<span></span>");
});

Deno.test("NativeDomReceiver: bind-path may not alias an already-registered node", () => {
  const { recv } = fixture();
  interned(recv);
  recv.registerTemplate(7, [{
    kind: "element",
    element: { tag: DIV, ns: undefined, attrs: [], children: [1] },
  }, { kind: "text", text: "t" }], [0]);
  recv.cloneTemplate(7, 0, 10);
  recv.bindPath(10, Uint8Array.of(0), 11);

  assertThrows(() => recv.bindPath(10, Uint8Array.of(0), 12), Error, "alias");
  assertThrows(() => recv.bindPath(10, new Uint8Array(0), 13), Error, "alias");
  assertEquals(recv.resolveNode(12), undefined);
});

// -- 3. node-type checks --------------------------------------------------

Deno.test("NativeDomReceiver: set-text requires a character-data node", () => {
  const { recv } = fixture();
  interned(recv);
  recv.createElement(1, DIV, undefined);
  recv.createText(2, "a");
  recv.createPlaceholder(3);

  assertThrows(() => recv.setText(1, "x"), Error, "not a text or comment");
  assertThrows(() => recv.setText(0, "x"), Error, "not a text or comment");
  // The element gained no expando from the rejected op.
  assertEquals(
    (recv.resolveNode(1) as unknown as { data?: unknown }).data,
    undefined,
  );
  recv.setText(2, "b");
  recv.setText(3, "c"); // comment nodes are character data too
  assertEquals((recv.resolveNode(2) as CharacterData).data, "b");
  assertEquals((recv.resolveNode(3) as CharacterData).data, "c");
});

Deno.test("NativeDomReceiver: set-attribute / set-property require an element", () => {
  const { recv } = fixture();
  interned(recv);
  recv.createText(2, "a");

  assertThrows(
    () => recv.setAttribute(2, CLASS, undefined, { kind: "text", value: "x" }),
    Error,
    "set-attribute target 2 is not an element",
  );
  assertThrows(
    () => recv.setAttribute(2, CLASS, undefined, undefined),
    Error,
    "not an element",
  );
  assertThrows(
    () => recv.setProperty(2, CLASS, { kind: "text", value: "x" }),
    Error,
    "set-property target 2 is not an element",
  );
});

Deno.test("NativeDomReceiver: text-control state ignores invalid ranges before changing value", () => {
  const { recv, root } = fixture();
  recv.internString(1, "textarea");
  recv.createElement(10, 1, undefined);
  recv.insertBefore(0, 10, undefined);
  recv.commit();
  const textarea = root.querySelector("textarea") as HTMLTextAreaElement;
  textarea.value = "keep";

  recv.setTextControlState(10, {
    value: "new",
    selectionStart: 0,
    selectionEnd: 4,
    direction: "forward",
  });
  assertEquals(textarea.value, "keep");
});

Deno.test("NativeDomReceiver: input type property controls text-state eligibility", () => {
  const { recv, root } = fixture();
  recv.internString(1, "input");
  recv.internString(2, "type");
  recv.createElement(10, 1, undefined);
  recv.setAttribute(10, 2, undefined, { kind: "text", value: "number" });
  recv.setProperty(10, 2, { kind: "text", value: "text" });
  recv.insertBefore(0, 10, undefined);
  recv.commit();

  const input = root.querySelector("input") as HTMLInputElement;
  Object.defineProperty(input, "type", {
    value: "number",
    writable: true,
    configurable: true,
  });
  input.setSelectionRange = function (start, end, direction) {
    Object.defineProperties(this, {
      selectionStart: { value: start, writable: true, configurable: true },
      selectionEnd: { value: end, writable: true, configurable: true },
      selectionDirection: {
        value: direction,
        writable: true,
        configurable: true,
      },
    });
  };
  recv.setProperty(10, 2, { kind: "text", value: "text" });
  recv.setTextControlState(10, {
    value: "supported",
    selectionStart: 2,
    selectionEnd: 4,
    direction: "forward",
  });
  assertEquals(input.value, "supported");
  assertEquals([input.selectionStart, input.selectionEnd], [2, 4]);
});

// -- 4. interned refs must resolve ----------------------------------------

Deno.test("NativeDomReceiver: an unresolved string ref throws", () => {
  const { recv } = fixture();
  recv.internString(DIV, "div");

  assertThrows(
    () => recv.createElement(1, 77, undefined),
    Error,
    "string ref 77",
  );
  assertThrows(
    () => recv.createElement(1, DIV, 77),
    Error,
    "string ref 77",
  );
  assertThrows(
    () => recv.setAttribute(0, 77, undefined, { kind: "text", value: "x" }),
    Error,
    "string ref 77",
  );
  assertThrows(
    () => recv.setProperty(0, 77, { kind: "none" }),
    Error,
    "string ref 77",
  );
  assertThrows(
    () =>
      recv.registerTemplate(
        7,
        [{
          kind: "element",
          element: { tag: 77, ns: undefined, attrs: [], children: [] },
        }],
        [0],
      ),
    Error,
    "string ref 77",
  );
  // The failed create registered nothing.
  assertEquals(recv.resolveNode(1), undefined);
});

Deno.test("NativeDomReceiver: re-interning a live slot is legal (proto Intern: 'define or overwrite')", () => {
  const { recv, root } = fixture();
  recv.internString(DIV, "div");
  recv.createElement(1, DIV, undefined);
  recv.internString(DIV, "span");
  recv.createElement(2, DIV, undefined);
  recv.insertBefore(0, 1, undefined);
  recv.insertBefore(0, 2, undefined);
  assertEquals(root.innerHTML, "<div></div><span></span>");
});

// -- 5. asset attribute values --------------------------------------------

/** Like `fixture()`, but with a `resolveAsset` hook — the receiver turns
 * an opaque asset handle into a URL through it (proto `SetAttribute.asset`:
 * "the producer never names a URL"). */
function assetFixture(resolveAsset?: (handle: Uint8Array) => string) {
  const win = parseHTML(
    `<!doctype html><html><body><div id="root"></div></body></html>`,
  );
  const doc = win.document as unknown as Document;
  const root = doc.getElementById("root")!;
  return { root, recv: new NativeDomReceiver(root, resolveAsset) };
}

Deno.test("NativeDomReceiver: an asset attribute value is resolved through the hook", () => {
  const seen: Uint8Array[] = [];
  const { root, recv } = assetFixture((handle) => {
    seen.push(handle);
    return `/assets/${handle.join("-")}`;
  });
  recv.internString(DIV, "div");
  recv.internString(CLASS, "src");
  recv.createElement(1, DIV, undefined);
  recv.insertBefore(0, 1, undefined);
  recv.setAttribute(1, CLASS, undefined, {
    kind: "asset",
    handle: Uint8Array.of(1, 2),
  });

  assertEquals(seen, [Uint8Array.of(1, 2)]);
  assertEquals(
    (recv.resolveNode(1) as Element).getAttribute("src"),
    "/assets/1-2",
  );
  assertEquals(root.children.length, 1);
});

Deno.test("NativeDomReceiver: a template attr asset resolves at registration", () => {
  const { recv } = assetFixture((handle) => `/assets/${handle.join("-")}`);
  recv.internString(DIV, "div");
  recv.internString(CLASS, "src");
  recv.registerTemplate(7, [{
    kind: "element",
    element: {
      tag: DIV,
      ns: undefined,
      attrs: [{
        name: CLASS,
        ns: undefined,
        value: { kind: "asset", handle: Uint8Array.of(9) },
      }],
      children: [],
    },
  }], [0]);
  recv.cloneTemplate(7, 0, 20);
  assertEquals(
    (recv.resolveNode(20) as Element).getAttribute("src"),
    "/assets/9",
  );
});

Deno.test("NativeDomReceiver: an asset value with no resolveAsset configured throws", () => {
  const { recv } = assetFixture();
  recv.internString(DIV, "div");
  recv.internString(CLASS, "src");
  recv.createElement(1, DIV, undefined);
  const message =
    "stream-dom: asset attribute value but no resolveAsset configured";

  assertThrows(
    () =>
      recv.setAttribute(1, CLASS, undefined, {
        kind: "asset",
        handle: Uint8Array.of(7),
      }),
    Error,
    message,
  );
  // Template attrs resolve at registration, so the same error lands there.
  assertThrows(
    () =>
      recv.registerTemplate(8, [{
        kind: "element",
        element: {
          tag: DIV,
          ns: undefined,
          attrs: [{
            name: CLASS,
            ns: undefined,
            value: { kind: "asset", handle: Uint8Array.of(7) },
          }],
          children: [],
        },
      }], [0]),
    Error,
    message,
  );
});

// -- 6. insert / remove sanity --------------------------------------------

Deno.test("NativeDomReceiver: a node cannot be inserted into itself or its own subtree", () => {
  const { recv, root, sentinel } = fixture();
  interned(recv);
  recv.createElement(1, DIV, undefined);
  recv.createElement(2, DIV, undefined);
  recv.insertBefore(0, 1, undefined);
  recv.insertBefore(1, 2, undefined);

  // The DOM itself is the authority here (HierarchyRequestError); the
  // receiver does not re-walk ancestors on the insert path.
  assertThrows(() => recv.insertBefore(1, 1, undefined));
  assertThrows(() => recv.insertBefore(2, 1, undefined));
  assertEquals(root.innerHTML, "<div><div></div></div>");
  assertEquals(sentinel.outerHTML, `<span id="sentinel">untouched</span>`);
});

Deno.test("NativeDomReceiver: unknown ids and bad anchors throw", () => {
  const { recv, root } = fixture();
  interned(recv);
  recv.createElement(1, DIV, undefined);
  recv.createElement(2, DIV, undefined);
  recv.createElement(3, DIV, undefined);
  recv.insertBefore(0, 1, undefined);
  recv.insertBefore(0, 2, undefined);

  assertThrows(
    () => recv.insertBefore(0, 99, undefined),
    Error,
    "unknown node id 99",
  );
  assertThrows(() => recv.remove(99), Error, "unknown node id 99");
  assertThrows(() => recv.setText(99, "x"), Error, "unknown node id 99");
  // An anchor that is not a child of the named parent.
  assertThrows(
    () => recv.insertBefore(1, 3, 2),
    Error,
    "disagrees with anchor",
  );
  assertThrows(() => recv.insertAfter(1, 3, 2), Error, "disagrees with anchor");
  // Neither parent nor anchor.
  assertThrows(
    () => recv.insertBefore(undefined, 3, undefined),
    Error,
    "neither parent nor anchor",
  );
  // An anchor with no parent to imply.
  assertThrows(
    () => recv.insertBefore(undefined, 1, 3),
    Error,
    "no parent to imply",
  );
  // A bad template ordinal.
  recv.registerTemplate(7, [{ kind: "text", text: "t" }], [0]);
  assertThrows(() => recv.cloneTemplate(7, 1, 20), Error, "out of range");
  assertThrows(() => recv.cloneTemplate(8, 0, 20), Error, "unknown template 8");
  // bind-path walking off the end.
  recv.cloneTemplate(7, 0, 20);
  assertThrows(
    () => recv.bindPath(20, Uint8Array.of(5), 21),
    Error,
    "walked off",
  );

  assertEquals(root.innerHTML, "<div></div><div></div>");
});

Deno.test("NativeDomReceiver: insert-after with anchor === id is a no-op; remove of a detached node is fine", () => {
  const { recv, root } = fixture();
  interned(recv);
  recv.createElement(1, DIV, undefined);
  recv.insertBefore(0, 1, undefined);
  recv.insertAfter(0, 1, 1);
  recv.insertBefore(0, 1, 1);
  assertEquals(root.innerHTML, "<div></div>");

  recv.createElement(2, SPAN, undefined); // never inserted
  recv.remove(2);
  assertEquals(recv.resolveNode(2), undefined);
  assertEquals(root.innerHTML, "<div></div>");
});

Deno.test("NativeDomReceiver: moving a node between two producer-owned parents", () => {
  const { recv, root } = fixture();
  interned(recv);
  recv.createElement(1, DIV, undefined);
  recv.createElement(2, DIV, undefined);
  recv.createText(3, "x");
  recv.insertBefore(0, 1, undefined);
  recv.insertBefore(0, 2, undefined);
  recv.insertBefore(1, 3, undefined);
  assertEquals(root.innerHTML, "<div>x</div><div></div>");
  recv.insertBefore(2, 3, undefined);
  assertEquals(root.innerHTML, "<div></div><div>x</div>");
  assertStrictEquals(recv.resolveNode(3)?.parentNode, recv.resolveNode(2));
});

Deno.test("NativeDomReceiver: removing a 50k-deep chain does not overflow the stack", () => {
  const { recv, root } = fixture();
  interned(recv);
  const depth = 50_000;
  recv.createElement(1, DIV, undefined);
  recv.insertBefore(0, 1, undefined);
  for (let i = 2; i <= depth; i++) {
    recv.createElement(i, DIV, undefined);
    recv.insertBefore(i - 1, i, undefined);
  }
  recv.remove(1);
  assertEquals(root.childNodes.length, 0);
  assertEquals(recv.resolveNode(1), undefined);
  assertEquals(recv.resolveNode(depth), undefined);
});

Deno.test("NativeDomReceiver: bind-marker is unsupported (hydration is not implemented here)", () => {
  const { recv } = fixture();
  assertThrows(() => recv.bindMarker(1, 2), Error, "hydration");
});
