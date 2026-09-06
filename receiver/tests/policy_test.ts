// Policy: the fail-safe property, tested field by field.
//
// The central test is per-field gating: for EVERY name in
// `ALL_STREAM_FIELDS`, the same bytes decode under the full snapshot and
// are rejected under the snapshot minus that one name. Field numbers below
// are transcribed independently from proto/stream-dom.proto and
// proto/stream-dom-events.proto (the normative files) rather than imported
// from the source under test, so a wrong number in src/ shows up here.

import { assertEquals, assertThrows } from "@std/assert";
import { FrameDecoder } from "../src/frames.ts";
import type {
  FrameSink,
  Listener,
  PropertyValue,
  TemplateNode,
} from "../src/frames.ts";
import { encodePayload } from "../src/events.ts";
import { Reader, Writer } from "../src/proto.ts";
import {
  ALL_EVENT_FIELDS,
  ALL_QUERIES,
  ALL_STREAM_FIELDS,
  compilePolicy,
  PolicyError,
  queryAllowed,
  SURFACE_V1,
} from "../src/policy.ts";
import type { EventField, Policy, Query, StreamField } from "../src/policy.ts";

// -- harness --------------------------------------------------------------

class RecordingSink implements FrameSink {
  calls: string[] = [];
  #rec(op: string, ...args: unknown[]): void {
    this.calls.push(op + " " + JSON.stringify(args));
  }
  internString(id: number, s: string) {
    this.#rec("internString", id, s);
  }
  createElement(id: number, tag: number, ns: number | undefined) {
    this.#rec("createElement", id, tag, ns);
  }
  createText(id: number, text: string) {
    this.#rec("createText", id, text);
  }
  createPlaceholder(id: number) {
    this.#rec("createPlaceholder", id);
  }
  insertBefore(
    parent: number | undefined,
    id: number,
    anchor: number | undefined,
  ) {
    this.#rec("insertBefore", parent, id, anchor);
  }
  insertAfter(parent: number | undefined, id: number, anchor: number) {
    this.#rec("insertAfter", parent, id, anchor);
  }
  remove(id: number) {
    this.#rec("remove", id);
  }
  setText(id: number, text: string) {
    this.#rec("setText", id, text);
  }
  setAttribute(
    id: number,
    name: number,
    ns: number | undefined,
    value: string | undefined,
  ) {
    this.#rec("setAttribute", id, name, ns, value);
  }
  setProperty(id: number, name: number, value: PropertyValue) {
    this.#rec("setProperty", id, name, value);
  }
  addListener(l: Listener) {
    this.#rec("addListener", l);
  }
  removeListener(l: Listener) {
    this.#rec("removeListener", l);
  }
  registerTemplate(id: number, nodes: TemplateNode[], roots: number[]) {
    this.#rec("registerTemplate", id, nodes, roots);
  }
  cloneTemplate(tmpl: number, root: number, id: number) {
    this.#rec("cloneTemplate", tmpl, root, id);
  }
  bindPath(root: number, path: Uint8Array, id: number) {
    this.#rec("bindPath", root, Array.from(path), id);
  }
  bindMarker(key: number, id: number) {
    this.#rec("bindMarker", key, id);
  }
  commit() {
    this.#rec("commit");
  }
}

/** One length-delimited `Frame` on the wire. */
function frame(build: (w: Writer) => void): Uint8Array {
  const body = new Writer();
  build(body);
  const bytes = body.finish();
  const out = new Writer();
  out.writeVarint32(bytes.length);
  const prefix = out.finish();
  const framed = new Uint8Array(prefix.length + bytes.length);
  framed.set(prefix, 0);
  framed.set(bytes, prefix.length);
  return framed;
}

/** A frame carrying one op (`Frame`'s oneof case `field`). */
function op(field: number, build: (w: Writer) => void): Uint8Array {
  return frame((w) => w.writeMessage(field, build));
}

function policyWithout(name: StreamField): Policy {
  return {
    accept: SURFACE_V1.accept.filter((n) => n !== name),
    events: SURFACE_V1.events,
    queries: SURFACE_V1.queries,
  };
}

function decodeStrict(bytes: Uint8Array, p: Policy): RecordingSink {
  const sink = new RecordingSink();
  const decoder = new FrameDecoder(sink, { accept: compilePolicy(p).accept });
  decoder.push(bytes);
  return sink;
}

// -- stream fixtures ------------------------------------------------------
//
// One fixture per name in `ALL_STREAM_FIELDS`: bytes that set exactly that
// field (plus whatever context the field needs to be reachable — the op
// wrapper, and a `Listener` target where the proto requires one).

// Frame's oneof `op` case numbers (proto/stream-dom.proto).
const F_COMMIT = 1;
const F_INSERT_BEFORE = 2;
const F_SET_TEXT = 3;
const F_SET_ATTRIBUTE = 4;
const F_SET_PROPERTY = 5;
const F_CREATE_ELEMENT = 6;
const F_CREATE_TEXT = 7;
const F_REMOVE = 8;
const F_CLONE_TEMPLATE = 9;
const F_BIND_PATH = 10;
const F_CREATE_PLACEHOLDER = 11;
const F_ADD_LISTENER = 12;
const F_REMOVE_LISTENER = 13;
const F_INTERN = 14;
const F_REGISTER_TEMPLATE = 15;
const F_INSERT_AFTER = 16;
const F_BIND_MARKER = 17;

/** `AddListener.listener` -> `Listener`, built by `build`. */
function listenerFrame(
  opField: number,
  build: (l: Writer) => void,
): Uint8Array {
  return op(opField, (w) => w.writeMessage(1, build));
}

/** `RegisterTemplate.nodes[0]` -> `TemplateNode`, built by `build`. */
function templateNodeFrame(build: (n: Writer) => void): Uint8Array {
  return op(F_REGISTER_TEMPLATE, (rt) => rt.writeMessage(2, build));
}

/** ...-> `TemplateNode.element` -> `TemplateElement`. */
function templateElementFrame(build: (e: Writer) => void): Uint8Array {
  return templateNodeFrame((n) => n.writeMessage(1, build));
}

/** ...-> `TemplateElement.attrs[0]` -> `TemplateAttr`. */
function templateAttrFrame(build: (a: Writer) => void): Uint8Array {
  return templateElementFrame((e) => e.writeMessage(3, build));
}

const FIXTURES: { [K in StreamField]: () => Uint8Array } = {
  "Frame.commit": () => frame((w) => w.writeBool(F_COMMIT, true)),
  "Frame.insert_before": () => op(F_INSERT_BEFORE, () => {}),
  "Frame.set_text": () => op(F_SET_TEXT, () => {}),
  "Frame.set_attribute": () => op(F_SET_ATTRIBUTE, () => {}),
  "Frame.set_property": () => op(F_SET_PROPERTY, () => {}),
  "Frame.create_element": () => op(F_CREATE_ELEMENT, () => {}),
  "Frame.create_text": () => op(F_CREATE_TEXT, () => {}),
  "Frame.remove": () => op(F_REMOVE, () => {}),
  "Frame.clone_template": () => op(F_CLONE_TEMPLATE, () => {}),
  "Frame.bind_path": () => op(F_BIND_PATH, () => {}),
  "Frame.create_placeholder": () => op(F_CREATE_PLACEHOLDER, () => {}),
  "Frame.add_listener": () => op(F_ADD_LISTENER, () => {}),
  "Frame.remove_listener": () => op(F_REMOVE_LISTENER, () => {}),
  "Frame.intern": () => op(F_INTERN, () => {}),
  "Frame.register_template": () => op(F_REGISTER_TEMPLATE, () => {}),
  "Frame.insert_after": () => op(F_INSERT_AFTER, () => {}),
  "Frame.bind_marker": () => op(F_BIND_MARKER, () => {}),

  "Intern.id": () => op(F_INTERN, (m) => m.writeUint32(1, 7)),
  "Intern.s": () => op(F_INTERN, (m) => m.writeString(2, "div")),

  "CreateElement.id": () => op(F_CREATE_ELEMENT, (m) => m.writeUint32(1, 1)),
  "CreateElement.tag": () => op(F_CREATE_ELEMENT, (m) => m.writeUint32(2, 1)),
  "CreateElement.ns": () => op(F_CREATE_ELEMENT, (m) => m.writeUint32(3, 2)),

  "CreateText.id": () => op(F_CREATE_TEXT, (m) => m.writeUint32(1, 1)),
  "CreateText.text": () => op(F_CREATE_TEXT, (m) => m.writeString(2, "hi")),

  "CreatePlaceholder.id": () =>
    op(F_CREATE_PLACEHOLDER, (m) => m.writeUint32(1, 1)),

  "InsertBefore.parent": () => op(F_INSERT_BEFORE, (m) => m.writeUint32(1, 0)),
  "InsertBefore.id": () => op(F_INSERT_BEFORE, (m) => m.writeUint32(2, 1)),
  "InsertBefore.anchor": () => op(F_INSERT_BEFORE, (m) => m.writeUint32(3, 2)),

  "InsertAfter.parent": () => op(F_INSERT_AFTER, (m) => m.writeUint32(1, 0)),
  "InsertAfter.id": () => op(F_INSERT_AFTER, (m) => m.writeUint32(2, 1)),
  "InsertAfter.anchor": () => op(F_INSERT_AFTER, (m) => m.writeUint32(3, 2)),

  "Remove.id": () => op(F_REMOVE, (m) => m.writeUint32(1, 1)),

  "SetText.id": () => op(F_SET_TEXT, (m) => m.writeUint32(1, 1)),
  "SetText.text": () => op(F_SET_TEXT, (m) => m.writeString(2, "hi")),

  "SetAttribute.id": () => op(F_SET_ATTRIBUTE, (m) => m.writeUint32(1, 1)),
  "SetAttribute.name": () => op(F_SET_ATTRIBUTE, (m) => m.writeUint32(2, 3)),
  "SetAttribute.ns": () => op(F_SET_ATTRIBUTE, (m) => m.writeUint32(3, 4)),
  "SetAttribute.value": () =>
    op(F_SET_ATTRIBUTE, (m) => m.writeString(4, "greeting")),

  "SetProperty.id": () => op(F_SET_PROPERTY, (m) => m.writeUint32(1, 1)),
  "SetProperty.name": () => op(F_SET_PROPERTY, (m) => m.writeUint32(2, 3)),
  "SetProperty.text": () => op(F_SET_PROPERTY, (m) => m.writeString(3, "v")),
  "SetProperty.int": () => op(F_SET_PROPERTY, (m) => m.writeSInt32Field(4, -3)),
  "SetProperty.float": () => op(F_SET_PROPERTY, (m) => m.writeDouble(5, 1.5)),
  "SetProperty.boolean": () => op(F_SET_PROPERTY, (m) => m.writeBool(6, true)),

  "Listener.id": () =>
    listenerFrame(F_ADD_LISTENER, (l) => l.writeUint32(1, 5)),
  "Listener.name": () =>
    listenerFrame(F_ADD_LISTENER, (l) => {
      l.writeUint32(1, 5);
      l.writeUint32(2, 9);
    }),
  "Listener.bubbles": () =>
    listenerFrame(F_ADD_LISTENER, (l) => {
      l.writeUint32(1, 5);
      l.writeBool(3, true);
    }),
  "Listener.capture": () =>
    listenerFrame(F_ADD_LISTENER, (l) => {
      l.writeUint32(1, 5);
      l.writeBool(4, true);
    }),
  "Listener.passive": () =>
    listenerFrame(F_ADD_LISTENER, (l) => {
      l.writeUint32(1, 5);
      l.writeBool(5, true);
    }),
  "Listener.prevent_default": () =>
    listenerFrame(F_ADD_LISTENER, (l) => {
      l.writeUint32(1, 5);
      l.writeBool(6, true);
    }),
  "Listener.stop_propagation": () =>
    listenerFrame(F_ADD_LISTENER, (l) => {
      l.writeUint32(1, 5);
      l.writeBool(7, true);
    }),
  "Listener.global": () =>
    listenerFrame(F_ADD_LISTENER, (l) => l.writeUint32(8, 0)),

  "AddListener.listener": () =>
    listenerFrame(F_ADD_LISTENER, (l) => l.writeUint32(1, 5)),
  "RemoveListener.listener": () =>
    listenerFrame(F_REMOVE_LISTENER, (l) => l.writeUint32(1, 5)),

  "TemplateAttr.name": () => templateAttrFrame((a) => a.writeUint32(1, 3)),
  "TemplateAttr.ns": () => templateAttrFrame((a) => a.writeUint32(2, 4)),
  "TemplateAttr.value": () => templateAttrFrame((a) => a.writeString(3, "x")),

  "TemplateElement.tag": () => templateElementFrame((e) => e.writeUint32(1, 1)),
  "TemplateElement.ns": () => templateElementFrame((e) => e.writeUint32(2, 2)),
  "TemplateElement.attrs": () =>
    templateElementFrame((e) => e.writeMessage(3, () => {})),
  "TemplateElement.children": () =>
    templateElementFrame((e) => e.writeUint32(4, 0)),

  "TemplateNode.element": () =>
    templateNodeFrame((n) => n.writeMessage(1, () => {})),
  "TemplateNode.text": () => templateNodeFrame((n) => n.writeString(2, "t")),
  "TemplateNode.dynamic": () =>
    templateNodeFrame((n) => n.writeMessage(3, () => {})),

  "RegisterTemplate.id": () =>
    op(F_REGISTER_TEMPLATE, (m) => m.writeUint32(1, 1)),
  "RegisterTemplate.nodes": () =>
    op(F_REGISTER_TEMPLATE, (m) => m.writeMessage(2, () => {})),
  "RegisterTemplate.roots": () =>
    op(F_REGISTER_TEMPLATE, (m) => m.writeUint32(3, 0)),

  "CloneTemplate.tmpl": () => op(F_CLONE_TEMPLATE, (m) => m.writeUint32(1, 1)),
  "CloneTemplate.root": () => op(F_CLONE_TEMPLATE, (m) => m.writeUint32(2, 0)),
  "CloneTemplate.id": () => op(F_CLONE_TEMPLATE, (m) => m.writeUint32(3, 9)),

  "BindPath.root": () => op(F_BIND_PATH, (m) => m.writeUint32(1, 1)),
  "BindPath.path": () => op(F_BIND_PATH, (m) => m.writeString(2, "ab")),
  "BindPath.id": () => op(F_BIND_PATH, (m) => m.writeUint32(3, 9)),

  "BindMarker.key": () => op(F_BIND_MARKER, (m) => m.writeUint32(1, 1)),
  "BindMarker.id": () => op(F_BIND_MARKER, (m) => m.writeUint32(2, 9)),

  // Enum VALUES: the fixture is a `Listener` naming that singleton.
  "Global.WINDOW": () =>
    listenerFrame(F_ADD_LISTENER, (l) => l.writeUint32(8, 0)),
  "Global.DOCUMENT": () =>
    listenerFrame(F_ADD_LISTENER, (l) => l.writeUint32(8, 1)),
};

Deno.test("the fixture table covers ALL_STREAM_FIELDS exactly", () => {
  assertEquals(
    Object.keys(FIXTURES).sort(),
    [...ALL_STREAM_FIELDS].sort(),
  );
});

Deno.test("per-field gating: every stream field decodes when declared and is rejected when not", () => {
  const full = compilePolicy({ ...SURFACE_V1 });
  for (const name of ALL_STREAM_FIELDS) {
    const bytes = FIXTURES[name]();

    // Declared: decodes.
    const sink = new RecordingSink();
    new FrameDecoder(sink, { accept: full.accept }).push(bytes);

    // The SAME bytes with just that one name removed: rejected, and the
    // error names the offending field.
    const err = assertThrows(
      () => decodeStrict(bytes, policyWithout(name)),
      PolicyError,
      undefined,
      `expected ${name} to be rejected when undeclared`,
    ) as PolicyError;
    assertEquals(err.field, name);
  }
});

// -- unknown tags ---------------------------------------------------------

Deno.test("strict: an unknown Frame op field number is Frame.<n>", () => {
  // Field 99 with a `commit` alongside: today's decoder skips the op and
  // still honors the flag; a policy has no name for it, so it is rejected.
  const bytes = frame((w) => {
    w.writeBool(F_COMMIT, true);
    w.writeMessage(99, () => {});
  });
  const err = assertThrows(
    () => decodeStrict(bytes, { ...SURFACE_V1 }),
    PolicyError,
  ) as PolicyError;
  assertEquals(err.field, "Frame.99");
});

Deno.test("strict: an unknown sub-message field number is Message.<n>", () => {
  const bytes = op(F_SET_ATTRIBUTE, (m) => {
    m.writeUint32(1, 1);
    m.writeUint32(9, 123);
  });
  const err = assertThrows(
    () => decodeStrict(bytes, { ...SURFACE_V1 }),
    PolicyError,
  ) as PolicyError;
  assertEquals(err.field, "SetAttribute.9");
});

Deno.test("non-strict: the same unknown tags are skipped as today", () => {
  const frameBytes = frame((w) => {
    w.writeBool(F_COMMIT, true);
    w.writeMessage(99, () => {});
  });
  const s1 = new RecordingSink();
  new FrameDecoder(s1).push(frameBytes);
  assertEquals(s1.calls, ["commit []"]);

  const attrBytes = op(F_SET_ATTRIBUTE, (m) => {
    m.writeUint32(1, 1);
    m.writeUint32(9, 123);
  });
  const s2 = new RecordingSink();
  new FrameDecoder(s2).push(attrBytes);
  assertEquals(s2.calls, ["setAttribute [1,0,null,null]"]);
});

Deno.test("strict: an unknown Global enum value is Global.<n>", () => {
  const bytes = listenerFrame(F_ADD_LISTENER, (l) => l.writeUint32(8, 7));
  const err = assertThrows(
    () => decodeStrict(bytes, { ...SURFACE_V1 }),
    PolicyError,
  ) as PolicyError;
  assertEquals(err.field, "Global.7");
});

// -- non-strict is byte-for-byte today's behaviour -------------------------

Deno.test("non-strict: basic.pb decodes identically with and without an options object", async () => {
  const bytes = await Deno.readFile(
    new URL("../../crates/stream-dom-guest/fixtures/basic.pb", import.meta.url),
  );
  const a = new RecordingSink();
  new FrameDecoder(a).push(bytes);
  const b = new RecordingSink();
  new FrameDecoder(b, {}).push(bytes);
  assertEquals(a.calls, b.calls);
  assertEquals(a.calls.length, 18);
});

// -- event payload filtering ----------------------------------------------
//
// (message, field number) transcribed independently from
// proto/stream-dom-events.proto, plus which fixture event populates each.

type Fam = "mouse" | "keyboard" | "form" | "submit" | "navigation";

const EVENT_LAYOUT: {
  [K in EventField]: readonly [string, number, Fam];
} = {
  "EventPayload.mouse": ["EventPayload", 1, "mouse"],
  "EventPayload.keyboard": ["EventPayload", 2, "keyboard"],
  "EventPayload.form": ["EventPayload", 3, "form"],
  "EventPayload.navigation": ["EventPayload", 14, "navigation"],
  "MouseData.client_x": ["MouseData", 1, "mouse"],
  "MouseData.client_y": ["MouseData", 2, "mouse"],
  "MouseData.page_x": ["MouseData", 3, "mouse"],
  "MouseData.page_y": ["MouseData", 4, "mouse"],
  "MouseData.screen_x": ["MouseData", 5, "mouse"],
  "MouseData.screen_y": ["MouseData", 6, "mouse"],
  "MouseData.offset_x": ["MouseData", 7, "mouse"],
  "MouseData.offset_y": ["MouseData", 8, "mouse"],
  "MouseData.button": ["MouseData", 9, "mouse"],
  "MouseData.primary": ["MouseData", 10, "mouse"],
  "MouseData.secondary": ["MouseData", 11, "mouse"],
  "MouseData.auxiliary": ["MouseData", 12, "mouse"],
  "MouseData.back": ["MouseData", 13, "mouse"],
  "MouseData.forward": ["MouseData", 14, "mouse"],
  "MouseData.modifiers": ["MouseData", 15, "mouse"],
  "Modifiers.alt": ["Modifiers", 1, "mouse"],
  "Modifiers.ctrl": ["Modifiers", 2, "mouse"],
  "Modifiers.meta": ["Modifiers", 3, "mouse"],
  "Modifiers.shift": ["Modifiers", 4, "mouse"],
  "KeyboardData.key": ["KeyboardData", 1, "keyboard"],
  "KeyboardData.code": ["KeyboardData", 2, "keyboard"],
  "KeyboardData.location": ["KeyboardData", 3, "keyboard"],
  "KeyboardData.repeat": ["KeyboardData", 4, "keyboard"],
  "KeyboardData.is_composing": ["KeyboardData", 5, "keyboard"],
  "KeyboardData.modifiers": ["KeyboardData", 6, "keyboard"],
  "FormData.value": ["FormData", 1, "form"],
  "FormData.checked": ["FormData", 2, "form"],
  "FormData.fields": ["FormData", 3, "submit"],
  "FormField.name": ["FormField", 1, "submit"],
  "FormField.value": ["FormField", 2, "submit"],
  "NavigationData.href": ["NavigationData", 1, "navigation"],
};

/** Which sub-message each length-delimited field opens, for the walk. */
const EVENT_CHILDREN: Record<string, Record<number, string>> = {
  EventPayload: {
    1: "MouseData",
    2: "KeyboardData",
    3: "FormData",
    14: "NavigationData",
  },
  MouseData: { 15: "Modifiers" },
  KeyboardData: { 6: "Modifiers" },
  FormData: { 3: "FormField" },
};

/** Every `Message.<number>` present in an encoded payload. */
function tagsPresent(bytes: Uint8Array): Set<string> {
  const found = new Set<string>();
  const walk = (r: Reader, msg: string) => {
    while (!r.finished()) {
      const [field, wireType] = r.readTag();
      found.add(`${msg}.${field}`);
      const child = EVENT_CHILDREN[msg]?.[field];
      if (child !== undefined && wireType === 2) walk(r.readMessage(), child);
      else r.skip(wireType);
    }
  };
  walk(new Reader(bytes), "EventPayload");
  return found;
}

const MOUSE_FIXTURE = {
  clientX: 1,
  clientY: 2,
  pageX: 3,
  pageY: 4,
  screenX: 5,
  screenY: 6,
  offsetX: 7,
  offsetY: 8,
  button: 1,
  // All five `buttons` bits, so every held-button field is populated.
  buttons: 31,
  altKey: true,
  ctrlKey: true,
  metaKey: true,
  shiftKey: true,
} as unknown as Event;

const KEYBOARD_FIXTURE = {
  key: "a",
  code: "KeyA",
  location: 1,
  repeat: true,
  isComposing: true,
  altKey: true,
  ctrlKey: true,
  metaKey: true,
  shiftKey: true,
} as unknown as Event;

const FORM_FIXTURE = {
  target: { value: "v", type: "checkbox", checked: true },
} as unknown as Event;

/** `FormData.fields` is only populated on `submit` against a real
 * `HTMLFormElement` whose entries `FormData(form)` enumerates — neither
 * global exists under `deno test`, so both are stubbed for the duration of
 * `fn`. Without this the three `FormData.fields` / `FormField.*` names
 * would be untestable in the positive direction. */
function withFormGlobals<T>(fn: (ev: Event) => T): T {
  const g = globalThis as unknown as Record<string, unknown>;
  const savedForm = g.HTMLFormElement;
  const savedData = g.FormData;
  class StubFormElement {
    value = "v";
    type = "text";
  }
  class StubFormData {
    #form: StubFormElement;
    constructor(form: StubFormElement) {
      this.#form = form;
    }
    entries(): Array<[string, string]> {
      return [["field", this.#form.value]];
    }
  }
  g.HTMLFormElement = StubFormElement;
  g.FormData = StubFormData;
  try {
    return fn({ target: new StubFormElement() } as unknown as Event);
  } finally {
    g.HTMLFormElement = savedForm;
    g.FormData = savedData;
  }
}

function encodeFixture(
  fam: Fam,
  events: ReturnType<typeof compilePolicy>["events"],
): Uint8Array {
  switch (fam) {
    case "mouse":
      return encodePayload("click", MOUSE_FIXTURE, events);
    case "keyboard":
      return encodePayload("keydown", KEYBOARD_FIXTURE, events);
    case "form":
      return encodePayload("change", FORM_FIXTURE, events);
    case "submit":
      return withFormGlobals((ev) => encodePayload("submit", ev, events));
    case "navigation":
      return encodePayload("hashchange", new Event("hashchange"), events);
  }
}

Deno.test("the event layout table covers ALL_EVENT_FIELDS exactly", () => {
  assertEquals(
    Object.keys(EVENT_LAYOUT).sort(),
    [...ALL_EVENT_FIELDS].sort(),
  );
});

Deno.test("per-field drop: every event field is emitted when declared and absent when not", () => {
  const full = compilePolicy({ ...SURFACE_V1 });
  for (const name of ALL_EVENT_FIELDS) {
    const [msg, num, fam] = EVENT_LAYOUT[name];
    const tag = `${msg}.${num}`;

    const present = tagsPresent(encodeFixture(fam, full.events));
    assertEquals(present.has(tag), true, `${name} missing with full filter`);

    const without = compilePolicy({
      accept: SURFACE_V1.accept,
      events: SURFACE_V1.events.filter((n) => n !== name),
      queries: SURFACE_V1.queries,
    });
    const bytes = encodeFixture(fam, without.events);
    assertEquals(
      tagsPresent(bytes).has(tag),
      false,
      `${name} still emitted when undeclared`,
    );
    // An undeclared family omits the whole payload.
    if (msg === "EventPayload") assertEquals(bytes.length, 0);
  }
});

Deno.test("no filter: encodePayload is unchanged by the full filter", () => {
  const full = compilePolicy({ ...SURFACE_V1 });
  assertEquals(
    encodePayload("click", MOUSE_FIXTURE, full.events),
    encodePayload("click", MOUSE_FIXTURE),
  );
  assertEquals(
    encodePayload("keydown", KEYBOARD_FIXTURE, full.events),
    encodePayload("keydown", KEYBOARD_FIXTURE),
  );
  assertEquals(
    encodePayload("change", FORM_FIXTURE, full.events),
    encodePayload("change", FORM_FIXTURE),
  );
  assertEquals(
    encodePayload("hashchange", new Event("hashchange"), full.events),
    encodePayload("hashchange", new Event("hashchange")),
  );
});

// -- queries --------------------------------------------------------------

Deno.test("queries: undeclared refuses, declared allows, no policy allows all", () => {
  const none = compilePolicy({ accept: [], events: [], queries: [] });
  for (const q of ALL_QUERIES) {
    assertEquals(queryAllowed(none, q), false);
    assertEquals(queryAllowed(undefined, q), true);
  }
  const readOnly = compilePolicy({
    accept: [],
    events: [],
    queries: ["get-client-rect"],
  });
  assertEquals(queryAllowed(readOnly, "get-client-rect"), true);
  assertEquals(queryAllowed(readOnly, "set-focus"), false);
});

// -- compilePolicy --------------------------------------------------------

Deno.test("compilePolicy rejects an unknown name, by name", () => {
  assertThrows(
    () =>
      compilePolicy({
        accept: ["Frame.nope" as StreamField],
        events: [],
        queries: [],
      }),
    Error,
    "Frame.nope",
  );
  assertThrows(
    () =>
      compilePolicy({
        accept: [],
        events: ["MouseData.related_target" as EventField],
        queries: [],
      }),
    Error,
    "MouseData.related_target",
  );
  assertThrows(
    () =>
      compilePolicy({ accept: [], events: [], queries: ["evaluate" as Query] }),
    Error,
    "evaluate",
  );
  // Names that index Object.prototype must not be mistaken for entries.
  for (const name of ["constructor", "__proto__", "toString"]) {
    assertThrows(
      () =>
        compilePolicy({
          accept: [name as StreamField],
          events: [],
          queries: [],
        }),
      Error,
      name,
    );
    assertThrows(
      () =>
        compilePolicy({
          accept: [],
          events: [name as EventField],
          queries: [],
        }),
      Error,
      name,
    );
  }
});

Deno.test("compilePolicy tolerates duplicates", () => {
  const c = compilePolicy({
    accept: ["Frame.commit", "Frame.commit"],
    events: ["EventPayload.mouse", "EventPayload.mouse"],
    queries: ["set-focus", "set-focus"],
  });
  assertEquals(c.queries.size, 1);
  const bytes = frame((w) => w.writeBool(F_COMMIT, true));
  const sink = new RecordingSink();
  new FrameDecoder(sink, { accept: c.accept }).push(bytes);
  assertEquals(sink.calls, ["commit []"]);
});

Deno.test("SURFACE_V1 is a subset of the current surface (a removal breaks loudly)", () => {
  // If this fails, something was REMOVED from the protocol: the snapshot
  // now names surface that no longer exists, and `compilePolicy` throws
  // for every embedder still spreading V1. That is the intended failure —
  // fix by shipping a new snapshot, not by editing V1.
  for (const n of SURFACE_V1.accept) {
    assertEquals(ALL_STREAM_FIELDS.includes(n), true, `stale: ${n}`);
  }
  for (const n of SURFACE_V1.events) {
    assertEquals(ALL_EVENT_FIELDS.includes(n), true, `stale: ${n}`);
  }
  for (const q of SURFACE_V1.queries) {
    assertEquals(ALL_QUERIES.includes(q), true, `stale: ${q}`);
  }
  // And it compiles.
  compilePolicy({ ...SURFACE_V1 });
});

Deno.test("SURFACE_V1 is frozen at its published sizes", () => {
  // A change to these numbers means the snapshot was edited, which is
  // forbidden: new protocol surface gets a NEW snapshot (V2). See the
  // FROZEN section in policy.ts.
  assertEquals(SURFACE_V1.accept.length, 77);
  assertEquals(SURFACE_V1.events.length, 35);
  assertEquals(SURFACE_V1.queries.length, 4);
});
