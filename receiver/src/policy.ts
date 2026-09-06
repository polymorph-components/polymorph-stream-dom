// Policy declaration: the embedder names, by string, every piece of
// protocol surface it accepts. Nothing it has not named crosses the
// boundary.
//
// Why declaration rather than a `FrameSink` wrapper: a wrapper fails OPEN
// when the protocol grows. The decoder skips unknown fields and forwards
// records whole, so a new op, a new field on an existing message
// (`Listener.once`) or a new enum value reaches a wrapper's `inner`
// unchecked — the wrapper has no case for what it has never seen. A
// declared list fails CLOSED: surface absent from the list is rejected
// whether or not this receiver understood it.
//
// This is not a backward-compatibility guarantee. An embedder updates its
// policy when it updates this dependency; the mechanism only guarantees
// that the update cannot silently widen exposure.
//
// Three directions, two behaviours:
// - Mutation stream (producer -> receiver): undeclared -> REJECT
//   (`PolicyError`; the mount aborts). There is a violator to name.
// - Event payloads (receiver -> producer): undeclared -> DROP (not
//   encoded). The receiver authors payloads, so there is no violator.
// - `queries` host imports (producer asks receiver): undeclared -> REFUSE
//   (`undefined` / `false`), never throw — the WIT signatures already
//   carry "no answer".
//
// Names are proto names verbatim: `Message.field` in snake_case exactly as
// in proto/stream-dom.proto and proto/stream-dom-events.proto, `Enum.VALUE`
// for enum values, and the WIT function names of wit/stream-dom.wit's
// `queries` interface for queries.

import { STREAM_FIELD_NUMBERS as S } from "./frames.ts";
import type { FrameSink } from "./frames.ts";
import { EVENT_FIELD_NUMBERS as E } from "./events.ts";

// -- errors ---------------------------------------------------------------

/** Thrown by strict decoding when the stream carries surface the policy did
 * not declare. `field` is the offending `Message.field` or `Enum.VALUE`,
 * or `Message.<number>` for a field number this decoder has no name for. */
export class PolicyError extends Error {
  readonly field: string;
  constructor(field: string) {
    super(`stream-dom: policy rejected undeclared ${field}`);
    this.name = "PolicyError";
    this.field = field;
  }
}

// -- declared surface -----------------------------------------------------

/** Every field the frames.ts decoder knows how to decode, plus both
 * `Global` enum values. A name here is a name an embedder may declare; a
 * name not here is a construction error (`compilePolicy`). */
export const ALL_STREAM_FIELDS = [
  // Frame: `commit` plus all 16 `op` oneof cases.
  "Frame.commit",
  "Frame.insert_before",
  "Frame.set_text",
  "Frame.set_attribute",
  "Frame.set_property",
  "Frame.create_element",
  "Frame.create_text",
  "Frame.remove",
  "Frame.clone_template",
  "Frame.bind_path",
  "Frame.create_placeholder",
  "Frame.add_listener",
  "Frame.remove_listener",
  "Frame.intern",
  "Frame.register_template",
  "Frame.insert_after",
  "Frame.bind_marker",
  "Intern.id",
  "Intern.s",
  "CreateElement.id",
  "CreateElement.tag",
  "CreateElement.ns",
  "CreateText.id",
  "CreateText.text",
  "CreatePlaceholder.id",
  "InsertBefore.parent",
  "InsertBefore.id",
  "InsertBefore.anchor",
  "InsertAfter.parent",
  "InsertAfter.id",
  "InsertAfter.anchor",
  "Remove.id",
  "SetText.id",
  "SetText.text",
  "SetAttribute.id",
  "SetAttribute.name",
  "SetAttribute.ns",
  "SetAttribute.value",
  "SetProperty.id",
  "SetProperty.name",
  "SetProperty.text",
  "SetProperty.int",
  "SetProperty.float",
  "SetProperty.boolean",
  "Listener.id",
  "Listener.name",
  "Listener.bubbles",
  "Listener.capture",
  "Listener.passive",
  "Listener.prevent_default",
  "Listener.stop_propagation",
  "Listener.global",
  "AddListener.listener",
  "RemoveListener.listener",
  "TemplateAttr.name",
  "TemplateAttr.ns",
  "TemplateAttr.value",
  "TemplateElement.tag",
  "TemplateElement.ns",
  "TemplateElement.attrs",
  "TemplateElement.children",
  // `Dynamic` has no fields; `TemplateNode.dynamic` is the whole of it.
  "TemplateNode.element",
  "TemplateNode.text",
  "TemplateNode.dynamic",
  "RegisterTemplate.id",
  "RegisterTemplate.nodes",
  "RegisterTemplate.roots",
  "CloneTemplate.tmpl",
  "CloneTemplate.root",
  "CloneTemplate.id",
  "BindPath.root",
  "BindPath.path",
  "BindPath.id",
  "BindMarker.key",
  "BindMarker.id",
  // Enum VALUES, not fields: `Listener.global` being declared says nothing
  // about which singletons the producer may name.
  "Global.WINDOW",
  "Global.DOCUMENT",
] as const;

export type StreamField = (typeof ALL_STREAM_FIELDS)[number];

/** Every event payload field the events.ts encoder can currently EMIT.
 * `MouseData.related_target` is absent: the encoder never populates it (see
 * events.ts), so declaring it would name surface that cannot exist. */
export const ALL_EVENT_FIELDS = [
  "EventPayload.mouse",
  "EventPayload.keyboard",
  "EventPayload.form",
  "EventPayload.navigation",
  "MouseData.client_x",
  "MouseData.client_y",
  "MouseData.page_x",
  "MouseData.page_y",
  "MouseData.screen_x",
  "MouseData.screen_y",
  "MouseData.offset_x",
  "MouseData.offset_y",
  "MouseData.button",
  "MouseData.primary",
  "MouseData.secondary",
  "MouseData.auxiliary",
  "MouseData.back",
  "MouseData.forward",
  "MouseData.modifiers",
  "Modifiers.alt",
  "Modifiers.ctrl",
  "Modifiers.meta",
  "Modifiers.shift",
  "KeyboardData.key",
  "KeyboardData.code",
  "KeyboardData.location",
  "KeyboardData.repeat",
  "KeyboardData.is_composing",
  "KeyboardData.modifiers",
  "FormData.value",
  "FormData.checked",
  "FormData.fields",
  "FormField.name",
  "FormField.value",
  "NavigationData.href",
] as const;

export type EventField = (typeof ALL_EVENT_FIELDS)[number];

/** wit/stream-dom.wit `interface queries`. */
export const ALL_QUERIES = [
  "get-client-rect",
  "get-scroll-offset",
  "get-scroll-size",
  "set-focus",
] as const;

export type Query = (typeof ALL_QUERIES)[number];

// -- the policy -----------------------------------------------------------

export interface Policy {
  /** Mutation-stream surface. Anything else on the stream is a
   * `PolicyError` and aborts the mount. */
  accept: readonly StreamField[];
  /** Event payload fields the receiver may encode. Anything else is
   * silently not written. */
  events: readonly EventField[];
  /** `queries` imports the producer may call. Others answer "no". */
  queries: readonly Query[];
  /** The embedder's own semantic checks over the ops that survived
   * `accept`: vocabulary (which tags/attributes), values, budgets. Ops
   * reach `inner` only if this wrapper forwards them. Optional — the
   * declared lists above are the fail-safe part; this is the part that
   * needs to know what the ops MEAN. */
  sink?(inner: FrameSink): FrameSink;
}

// == FROZEN SNAPSHOT ======================================================
//
// SURFACE_V1: today's full protocol surface, written out literally.
//
// FROZEN — never add to this list. New protocol surface gets a NEW
// snapshot (SURFACE_V2) and embedders opt in by naming the new fields.
// That is the whole mechanism: an embedder that spreads V1 and updates
// this dependency keeps exactly the exposure it reviewed.
//
// Deliberately NOT aliased to `ALL_STREAM_FIELDS` / `ALL_EVENT_FIELDS` /
// `ALL_QUERIES`: those grow with the protocol, and this must not move.
// (A field REMOVED from the protocol makes `compilePolicy` throw here,
// loudly, which is the intended failure.)
//
// Usage: `{ ...SURFACE_V1, sink }`.

export const SURFACE_V1: {
  readonly accept: readonly StreamField[];
  readonly events: readonly EventField[];
  readonly queries: readonly Query[];
} = Object.freeze({
  accept: Object.freeze(
    [
      "Frame.commit",
      "Frame.insert_before",
      "Frame.set_text",
      "Frame.set_attribute",
      "Frame.set_property",
      "Frame.create_element",
      "Frame.create_text",
      "Frame.remove",
      "Frame.clone_template",
      "Frame.bind_path",
      "Frame.create_placeholder",
      "Frame.add_listener",
      "Frame.remove_listener",
      "Frame.intern",
      "Frame.register_template",
      "Frame.insert_after",
      "Frame.bind_marker",
      "Intern.id",
      "Intern.s",
      "CreateElement.id",
      "CreateElement.tag",
      "CreateElement.ns",
      "CreateText.id",
      "CreateText.text",
      "CreatePlaceholder.id",
      "InsertBefore.parent",
      "InsertBefore.id",
      "InsertBefore.anchor",
      "InsertAfter.parent",
      "InsertAfter.id",
      "InsertAfter.anchor",
      "Remove.id",
      "SetText.id",
      "SetText.text",
      "SetAttribute.id",
      "SetAttribute.name",
      "SetAttribute.ns",
      "SetAttribute.value",
      "SetProperty.id",
      "SetProperty.name",
      "SetProperty.text",
      "SetProperty.int",
      "SetProperty.float",
      "SetProperty.boolean",
      "Listener.id",
      "Listener.name",
      "Listener.bubbles",
      "Listener.capture",
      "Listener.passive",
      "Listener.prevent_default",
      "Listener.stop_propagation",
      "Listener.global",
      "AddListener.listener",
      "RemoveListener.listener",
      "TemplateAttr.name",
      "TemplateAttr.ns",
      "TemplateAttr.value",
      "TemplateElement.tag",
      "TemplateElement.ns",
      "TemplateElement.attrs",
      "TemplateElement.children",
      "TemplateNode.element",
      "TemplateNode.text",
      "TemplateNode.dynamic",
      "RegisterTemplate.id",
      "RegisterTemplate.nodes",
      "RegisterTemplate.roots",
      "CloneTemplate.tmpl",
      "CloneTemplate.root",
      "CloneTemplate.id",
      "BindPath.root",
      "BindPath.path",
      "BindPath.id",
      "BindMarker.key",
      "BindMarker.id",
      "Global.WINDOW",
      "Global.DOCUMENT",
    ] as const satisfies readonly StreamField[],
  ),
  events: Object.freeze(
    [
      "EventPayload.mouse",
      "EventPayload.keyboard",
      "EventPayload.form",
      "EventPayload.navigation",
      "MouseData.client_x",
      "MouseData.client_y",
      "MouseData.page_x",
      "MouseData.page_y",
      "MouseData.screen_x",
      "MouseData.screen_y",
      "MouseData.offset_x",
      "MouseData.offset_y",
      "MouseData.button",
      "MouseData.primary",
      "MouseData.secondary",
      "MouseData.auxiliary",
      "MouseData.back",
      "MouseData.forward",
      "MouseData.modifiers",
      "Modifiers.alt",
      "Modifiers.ctrl",
      "Modifiers.meta",
      "Modifiers.shift",
      "KeyboardData.key",
      "KeyboardData.code",
      "KeyboardData.location",
      "KeyboardData.repeat",
      "KeyboardData.is_composing",
      "KeyboardData.modifiers",
      "FormData.value",
      "FormData.checked",
      "FormData.fields",
      "FormField.name",
      "FormField.value",
      "NavigationData.href",
    ] as const satisfies readonly EventField[],
  ),
  queries: Object.freeze(
    [
      "get-client-rect",
      "get-scroll-offset",
      "get-scroll-size",
      "set-focus",
    ] as const satisfies readonly Query[],
  ),
});

// == end FROZEN SNAPSHOT ==================================================

// -- compiled form --------------------------------------------------------

/** Messages the strict decoder gates. `Global` is an enum, gated by VALUE
 * rather than by field number, and rides in the same structure. */
export type StreamMessage =
  | "Frame"
  | "Intern"
  | "CreateElement"
  | "CreateText"
  | "CreatePlaceholder"
  | "InsertBefore"
  | "InsertAfter"
  | "Remove"
  | "SetText"
  | "SetAttribute"
  | "SetProperty"
  | "Listener"
  | "AddListener"
  | "RemoveListener"
  | "TemplateAttr"
  | "TemplateElement"
  | "TemplateNode"
  | "RegisterTemplate"
  | "CloneTemplate"
  | "BindPath"
  | "BindMarker"
  | "Global";

/** One message's declared field numbers as a bitmask (every field number
 * on this wire is <= 31; a number above that is undeclared by
 * construction). `reject` builds the error message — off the hot path, so
 * the decoder's cost per field is one bit test. */
export interface MessageAccept {
  readonly mask: number;
  reject(field: number): never;
}

export type AcceptSet = { readonly [M in StreamMessage]: MessageAccept };

/** Messages the event encoder gates, by field-number bitmask. */
export type EventMessage =
  | "EventPayload"
  | "MouseData"
  | "Modifiers"
  | "KeyboardData"
  | "FormData"
  | "FormField"
  | "NavigationData";

export type EventFieldSet = { readonly [M in EventMessage]: number };

export interface CompiledPolicy {
  accept: AcceptSet;
  events: EventFieldSet;
  queries: ReadonlySet<Query>;
}

// -- name tables ----------------------------------------------------------
//
// Field numbers come from frames.ts / events.ts rather than being repeated
// as literals here: a new constant without an entry in these tables is
// visible in the same diff.

const STREAM_TABLE: { [K in StreamField]: readonly [StreamMessage, number] } = {
  "Frame.commit": ["Frame", S.FRAME_COMMIT],
  "Frame.insert_before": ["Frame", S.FRAME_INSERT_BEFORE],
  "Frame.set_text": ["Frame", S.FRAME_SET_TEXT],
  "Frame.set_attribute": ["Frame", S.FRAME_SET_ATTRIBUTE],
  "Frame.set_property": ["Frame", S.FRAME_SET_PROPERTY],
  "Frame.create_element": ["Frame", S.FRAME_CREATE_ELEMENT],
  "Frame.create_text": ["Frame", S.FRAME_CREATE_TEXT],
  "Frame.remove": ["Frame", S.FRAME_REMOVE],
  "Frame.clone_template": ["Frame", S.FRAME_CLONE_TEMPLATE],
  "Frame.bind_path": ["Frame", S.FRAME_BIND_PATH],
  "Frame.create_placeholder": ["Frame", S.FRAME_CREATE_PLACEHOLDER],
  "Frame.add_listener": ["Frame", S.FRAME_ADD_LISTENER],
  "Frame.remove_listener": ["Frame", S.FRAME_REMOVE_LISTENER],
  "Frame.intern": ["Frame", S.FRAME_INTERN],
  "Frame.register_template": ["Frame", S.FRAME_REGISTER_TEMPLATE],
  "Frame.insert_after": ["Frame", S.FRAME_INSERT_AFTER],
  "Frame.bind_marker": ["Frame", S.FRAME_BIND_MARKER],
  "Intern.id": ["Intern", S.INTERN_ID],
  "Intern.s": ["Intern", S.INTERN_S],
  "CreateElement.id": ["CreateElement", S.CREATE_ELEMENT_ID],
  "CreateElement.tag": ["CreateElement", S.CREATE_ELEMENT_TAG],
  "CreateElement.ns": ["CreateElement", S.CREATE_ELEMENT_NS],
  "CreateText.id": ["CreateText", S.CREATE_TEXT_ID],
  "CreateText.text": ["CreateText", S.CREATE_TEXT_TEXT],
  "CreatePlaceholder.id": ["CreatePlaceholder", S.CREATE_PLACEHOLDER_ID],
  "InsertBefore.parent": ["InsertBefore", S.INSERT_BEFORE_PARENT],
  "InsertBefore.id": ["InsertBefore", S.INSERT_BEFORE_ID],
  "InsertBefore.anchor": ["InsertBefore", S.INSERT_BEFORE_ANCHOR],
  "InsertAfter.parent": ["InsertAfter", S.INSERT_AFTER_PARENT],
  "InsertAfter.id": ["InsertAfter", S.INSERT_AFTER_ID],
  "InsertAfter.anchor": ["InsertAfter", S.INSERT_AFTER_ANCHOR],
  "Remove.id": ["Remove", S.REMOVE_ID],
  "SetText.id": ["SetText", S.SET_TEXT_ID],
  "SetText.text": ["SetText", S.SET_TEXT_TEXT],
  "SetAttribute.id": ["SetAttribute", S.SET_ATTRIBUTE_ID],
  "SetAttribute.name": ["SetAttribute", S.SET_ATTRIBUTE_NAME],
  "SetAttribute.ns": ["SetAttribute", S.SET_ATTRIBUTE_NS],
  "SetAttribute.value": ["SetAttribute", S.SET_ATTRIBUTE_VALUE],
  "SetProperty.id": ["SetProperty", S.SET_PROPERTY_ID],
  "SetProperty.name": ["SetProperty", S.SET_PROPERTY_NAME],
  "SetProperty.text": ["SetProperty", S.SET_PROPERTY_TEXT],
  "SetProperty.int": ["SetProperty", S.SET_PROPERTY_INT],
  "SetProperty.float": ["SetProperty", S.SET_PROPERTY_FLOAT],
  "SetProperty.boolean": ["SetProperty", S.SET_PROPERTY_BOOLEAN],
  "Listener.id": ["Listener", S.LISTENER_ID],
  "Listener.name": ["Listener", S.LISTENER_NAME],
  "Listener.bubbles": ["Listener", S.LISTENER_BUBBLES],
  "Listener.capture": ["Listener", S.LISTENER_CAPTURE],
  "Listener.passive": ["Listener", S.LISTENER_PASSIVE],
  "Listener.prevent_default": ["Listener", S.LISTENER_PREVENT_DEFAULT],
  "Listener.stop_propagation": ["Listener", S.LISTENER_STOP_PROPAGATION],
  "Listener.global": ["Listener", S.LISTENER_GLOBAL],
  "AddListener.listener": ["AddListener", S.ADD_LISTENER_LISTENER],
  "RemoveListener.listener": ["RemoveListener", S.REMOVE_LISTENER_LISTENER],
  "TemplateAttr.name": ["TemplateAttr", S.TEMPLATE_ATTR_NAME],
  "TemplateAttr.ns": ["TemplateAttr", S.TEMPLATE_ATTR_NS],
  "TemplateAttr.value": ["TemplateAttr", S.TEMPLATE_ATTR_VALUE],
  "TemplateElement.tag": ["TemplateElement", S.TEMPLATE_ELEMENT_TAG],
  "TemplateElement.ns": ["TemplateElement", S.TEMPLATE_ELEMENT_NS],
  "TemplateElement.attrs": ["TemplateElement", S.TEMPLATE_ELEMENT_ATTRS],
  "TemplateElement.children": ["TemplateElement", S.TEMPLATE_ELEMENT_CHILDREN],
  "TemplateNode.element": ["TemplateNode", S.TEMPLATE_NODE_ELEMENT],
  "TemplateNode.text": ["TemplateNode", S.TEMPLATE_NODE_TEXT],
  "TemplateNode.dynamic": ["TemplateNode", S.TEMPLATE_NODE_DYNAMIC],
  "RegisterTemplate.id": ["RegisterTemplate", S.REGISTER_TEMPLATE_ID],
  "RegisterTemplate.nodes": ["RegisterTemplate", S.REGISTER_TEMPLATE_NODES],
  "RegisterTemplate.roots": ["RegisterTemplate", S.REGISTER_TEMPLATE_ROOTS],
  "CloneTemplate.tmpl": ["CloneTemplate", S.CLONE_TEMPLATE_TMPL],
  "CloneTemplate.root": ["CloneTemplate", S.CLONE_TEMPLATE_ROOT],
  "CloneTemplate.id": ["CloneTemplate", S.CLONE_TEMPLATE_ID],
  "BindPath.root": ["BindPath", S.BIND_PATH_ROOT],
  "BindPath.path": ["BindPath", S.BIND_PATH_PATH],
  "BindPath.id": ["BindPath", S.BIND_PATH_ID],
  "BindMarker.key": ["BindMarker", S.BIND_MARKER_KEY],
  "BindMarker.id": ["BindMarker", S.BIND_MARKER_ID],
  // Enum values: the "field number" is the enum VALUE.
  "Global.WINDOW": ["Global", S.GLOBAL_WINDOW],
  "Global.DOCUMENT": ["Global", S.GLOBAL_DOCUMENT],
};

const EVENT_TABLE: { [K in EventField]: readonly [EventMessage, number] } = {
  "EventPayload.mouse": ["EventPayload", E.EVENT_PAYLOAD_MOUSE],
  "EventPayload.keyboard": ["EventPayload", E.EVENT_PAYLOAD_KEYBOARD],
  "EventPayload.form": ["EventPayload", E.EVENT_PAYLOAD_FORM],
  "EventPayload.navigation": ["EventPayload", E.EVENT_PAYLOAD_NAVIGATION],
  "MouseData.client_x": ["MouseData", E.MOUSE_CLIENT_X],
  "MouseData.client_y": ["MouseData", E.MOUSE_CLIENT_Y],
  "MouseData.page_x": ["MouseData", E.MOUSE_PAGE_X],
  "MouseData.page_y": ["MouseData", E.MOUSE_PAGE_Y],
  "MouseData.screen_x": ["MouseData", E.MOUSE_SCREEN_X],
  "MouseData.screen_y": ["MouseData", E.MOUSE_SCREEN_Y],
  "MouseData.offset_x": ["MouseData", E.MOUSE_OFFSET_X],
  "MouseData.offset_y": ["MouseData", E.MOUSE_OFFSET_Y],
  "MouseData.button": ["MouseData", E.MOUSE_BUTTON],
  "MouseData.primary": ["MouseData", E.MOUSE_PRIMARY],
  "MouseData.secondary": ["MouseData", E.MOUSE_SECONDARY],
  "MouseData.auxiliary": ["MouseData", E.MOUSE_AUXILIARY],
  "MouseData.back": ["MouseData", E.MOUSE_BACK],
  "MouseData.forward": ["MouseData", E.MOUSE_FORWARD],
  "MouseData.modifiers": ["MouseData", E.MOUSE_MODIFIERS],
  "Modifiers.alt": ["Modifiers", E.MODIFIERS_ALT],
  "Modifiers.ctrl": ["Modifiers", E.MODIFIERS_CTRL],
  "Modifiers.meta": ["Modifiers", E.MODIFIERS_META],
  "Modifiers.shift": ["Modifiers", E.MODIFIERS_SHIFT],
  "KeyboardData.key": ["KeyboardData", E.KEYBOARD_KEY],
  "KeyboardData.code": ["KeyboardData", E.KEYBOARD_CODE],
  "KeyboardData.location": ["KeyboardData", E.KEYBOARD_LOCATION],
  "KeyboardData.repeat": ["KeyboardData", E.KEYBOARD_REPEAT],
  "KeyboardData.is_composing": ["KeyboardData", E.KEYBOARD_IS_COMPOSING],
  "KeyboardData.modifiers": ["KeyboardData", E.KEYBOARD_MODIFIERS],
  "FormData.value": ["FormData", E.FORM_VALUE],
  "FormData.checked": ["FormData", E.FORM_CHECKED],
  "FormData.fields": ["FormData", E.FORM_FIELDS],
  "FormField.name": ["FormField", E.FORM_FIELD_NAME],
  "FormField.value": ["FormField", E.FORM_FIELD_VALUE],
  "NavigationData.href": ["NavigationData", E.NAVIGATION_HREF],
};

const STREAM_MESSAGES = Object.keys(
  ALL_STREAM_FIELDS.reduce<Record<string, true>>((acc, name) => {
    acc[STREAM_TABLE[name][0]] = true;
    return acc;
  }, {}),
) as StreamMessage[];

const EVENT_MESSAGES = Object.keys(
  ALL_EVENT_FIELDS.reduce<Record<string, true>>((acc, name) => {
    acc[EVENT_TABLE[name][0]] = true;
    return acc;
  }, {}),
) as EventMessage[];

/** `Message` -> field number -> full name, for `PolicyError`'s message.
 * Static: every KNOWN field, declared or not. */
const STREAM_NAMES: Record<string, (string | undefined)[]> = {};
for (const name of ALL_STREAM_FIELDS) {
  const [msg, num] = STREAM_TABLE[name];
  (STREAM_NAMES[msg] ??= [])[num] = name;
}

// -- compilation ----------------------------------------------------------

function makeAccept(msg: StreamMessage, mask: number): MessageAccept {
  return {
    mask,
    reject(field: number): never {
      throw new PolicyError(STREAM_NAMES[msg]?.[field] ?? `${msg}.${field}`);
    },
  };
}

/**
 * Validate and compile a policy.
 *
 * Every name is checked against the tables above and an unknown one throws
 * a plain `Error` naming it: JS consumers get no type check, and a field
 * REMOVED from the protocol must fail at construction rather than quietly
 * narrowing what the embedder believed it had declared. Duplicates are
 * tolerated (spreading two snapshots is a normal thing to do).
 */
export function compilePolicy(p: Policy): CompiledPolicy {
  const accept: Record<string, MessageAccept> = {};
  const events: Record<string, number> = {};

  const streamMasks: Record<string, number> = {};
  for (const msg of STREAM_MESSAGES) streamMasks[msg] = 0;
  // `Object.hasOwn`, not indexing: a JS caller passing "constructor" or
  // "__proto__" would otherwise find Object.prototype and not throw.
  for (const name of p.accept) {
    if (!Object.hasOwn(STREAM_TABLE, name)) {
      throw new Error(`stream-dom: policy names unknown stream field ${name}`);
    }
    const entry = STREAM_TABLE[name];
    streamMasks[entry[0]] |= 1 << entry[1];
  }
  for (const msg of STREAM_MESSAGES) {
    accept[msg] = makeAccept(msg, streamMasks[msg]);
  }

  for (const msg of EVENT_MESSAGES) events[msg] = 0;
  for (const name of p.events) {
    if (!Object.hasOwn(EVENT_TABLE, name)) {
      throw new Error(`stream-dom: policy names unknown event field ${name}`);
    }
    const entry = EVENT_TABLE[name];
    events[entry[0]] |= 1 << entry[1];
  }

  const queries = new Set<Query>();
  for (const q of p.queries) {
    if (!ALL_QUERIES.includes(q)) {
      throw new Error(`stream-dom: policy names unknown query ${q}`);
    }
    queries.add(q);
  }

  return {
    accept: accept as AcceptSet,
    events: events as EventFieldSet,
    queries,
  };
}

/** Query gate: undeclared -> refuse. `undefined` means "no policy", which
 * is the unrestricted default (`mount` without `policy`). */
export function queryAllowed(
  compiled: CompiledPolicy | undefined,
  query: Query,
): boolean {
  return compiled === undefined || compiled.queries.has(query);
}
