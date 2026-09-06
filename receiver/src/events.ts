// `handle-event` payload family selection and encoding.
// proto/stream-dom-events.proto is normative for every field number below;
// only the families this bring-up receiver's mount layer wires up are
// implemented (docs/design.md "Events": the family the receiver chooses by
// event name) — mouse, keyboard, form. Every other name gets the empty
// payload (`EventPayload` with no `family` case set), which is legal per
// the proto's header comment ("No case set is the empty payload — focus,
// selection, ... the event name ... already says everything those
// carry").

import { Writer } from "./proto.ts";

const EVENT_PAYLOAD_MOUSE = 1;
const EVENT_PAYLOAD_KEYBOARD = 2;
const EVENT_PAYLOAD_FORM = 3;

const MOUSE_CLIENT_X = 1;
const MOUSE_CLIENT_Y = 2;
const MOUSE_PAGE_X = 3;
const MOUSE_PAGE_Y = 4;
const MOUSE_SCREEN_X = 5;
const MOUSE_SCREEN_Y = 6;
const MOUSE_OFFSET_X = 7;
const MOUSE_OFFSET_Y = 8;
const MOUSE_BUTTON = 9;
const MOUSE_PRIMARY = 10;
const MOUSE_SECONDARY = 11;
const MOUSE_AUXILIARY = 12;
const MOUSE_BACK = 13;
const MOUSE_FORWARD = 14;
const MOUSE_MODIFIERS = 15;
// MOUSE_RELATED_TARGET (16) is not populated: mapping a native
// `relatedTarget` Node to a producer node id needs the transcoder's
// reverse lookup (`RemoteDomTranscoder.producerIdForRid`/`remoteId`),
// which this module's `(name, ev)` signature has no access to. Left
// absent — a real gap, flagged in the track report rather than plumbed
// through here speculatively.

const MODIFIERS_ALT = 1;
const MODIFIERS_CTRL = 2;
const MODIFIERS_META = 3;
const MODIFIERS_SHIFT = 4;

const KEYBOARD_KEY = 1;
const KEYBOARD_CODE = 2;
const KEYBOARD_LOCATION = 3;
const KEYBOARD_REPEAT = 4;
const KEYBOARD_IS_COMPOSING = 5;
const KEYBOARD_MODIFIERS = 6;

const FORM_VALUE = 1;
const FORM_CHECKED = 2;
const FORM_FIELDS = 3;
const FORM_FIELD_NAME = 1;
const FORM_FIELD_VALUE = 2;

const MOUSE_EVENTS = new Set([
  "click",
  "dblclick",
  "mousedown",
  "mouseup",
  "mousemove",
  "mouseenter",
  "mouseleave",
  "mouseover",
  "mouseout",
  "contextmenu",
  "auxclick",
]);

/** Events on which the DOM reports a meaningful `button` (proto comment on
 * `MouseData.button`): "set only on events a press or release caused". */
const BUTTON_EVENTS = new Set([
  "click",
  "dblclick",
  "mousedown",
  "mouseup",
  "auxclick",
  "contextmenu",
]);

const KEYBOARD_EVENTS = new Set(["keydown", "keyup", "keypress"]);

const FORM_EVENTS = new Set([
  "input",
  "change",
  "submit",
  "beforeinput",
  "invalid",
  "reset",
]);

export type Family = "mouse" | "keyboard" | "form" | "none";

export function familyFor(name: string): Family {
  if (MOUSE_EVENTS.has(name)) return "mouse";
  if (KEYBOARD_EVENTS.has(name)) return "keyboard";
  if (FORM_EVENTS.has(name)) return "form";
  return "none";
}

function writeModifiers(
  w: Writer,
  fieldNumber: number,
  ev: MouseEvent | KeyboardEvent,
): void {
  w.writeMessage(fieldNumber, (m) => {
    if (ev.altKey) m.writeBool(MODIFIERS_ALT, true);
    if (ev.ctrlKey) m.writeBool(MODIFIERS_CTRL, true);
    if (ev.metaKey) m.writeBool(MODIFIERS_META, true);
    if (ev.shiftKey) m.writeBool(MODIFIERS_SHIFT, true);
  });
}

function writeMouseData(w: Writer, name: string, ev: MouseEvent): void {
  w.writeDouble(MOUSE_CLIENT_X, ev.clientX);
  w.writeDouble(MOUSE_CLIENT_Y, ev.clientY);
  w.writeDouble(MOUSE_PAGE_X, ev.pageX);
  w.writeDouble(MOUSE_PAGE_Y, ev.pageY);
  w.writeDouble(MOUSE_SCREEN_X, ev.screenX);
  w.writeDouble(MOUSE_SCREEN_Y, ev.screenY);
  w.writeDouble(
    MOUSE_OFFSET_X,
    (ev as MouseEvent & { offsetX?: number }).offsetX ?? 0,
  );
  w.writeDouble(
    MOUSE_OFFSET_Y,
    (ev as MouseEvent & { offsetY?: number }).offsetY ?? 0,
  );
  if (BUTTON_EVENTS.has(name)) {
    // MouseButton's case values (PRIMARY=0, AUXILIARY=1, SECONDARY=2,
    // BACK=3, FORWARD=4) coincide numerically with MouseEvent.button's
    // own encoding, so the raw DOM value is the wire value with no
    // remapping.
    w.writeUint32(MOUSE_BUTTON, ev.button);
  }
  const buttons = ev.buttons;
  if (buttons & 1) w.writeBool(MOUSE_PRIMARY, true);
  if (buttons & 2) w.writeBool(MOUSE_SECONDARY, true);
  if (buttons & 4) w.writeBool(MOUSE_AUXILIARY, true);
  if (buttons & 8) w.writeBool(MOUSE_BACK, true);
  if (buttons & 16) w.writeBool(MOUSE_FORWARD, true);
  writeModifiers(w, MOUSE_MODIFIERS, ev);
}

function writeKeyboardData(w: Writer, ev: KeyboardEvent): void {
  w.writeString(KEYBOARD_KEY, ev.key ?? "");
  w.writeString(KEYBOARD_CODE, ev.code ?? "");
  w.writeUint32(KEYBOARD_LOCATION, ev.location ?? 0);
  if (ev.repeat) w.writeBool(KEYBOARD_REPEAT, true);
  if (ev.isComposing) w.writeBool(KEYBOARD_IS_COMPOSING, true);
  writeModifiers(w, KEYBOARD_MODIFIERS, ev);
}

interface FormControlLike {
  value?: string;
  checked?: boolean;
  type?: string;
}

function writeFormData(w: Writer, name: string, ev: Event): void {
  const target = ev.target as (EventTarget & FormControlLike) | null;
  w.writeString(FORM_VALUE, target?.value ?? "");
  if (target?.type === "checkbox" || target?.type === "radio") {
    w.writeBool(FORM_CHECKED, target.checked === true);
  }
  if (name === "submit" && target instanceof HTMLFormElement) {
    // FormData(form).entries() on submit only — proto comment: "dioxus-web
    // populates them on every event inside a form, which serializes the
    // whole form per keystroke"; this receiver follows the proto's
    // narrower contract instead.
    for (const [fieldName, value] of new FormData(target).entries()) {
      w.writeMessage(FORM_FIELDS, (f) => {
        f.writeString(FORM_FIELD_NAME, fieldName);
        f.writeString(FORM_FIELD_VALUE, String(value));
      });
    }
  }
}

/** Encode `ev` as an `EventPayload` for `name`'s family. Names outside
 * mouse/keyboard/form (including focus/blur and every family this receiver
 * does not yet implement) get the empty payload — zero bytes, which is a
 * valid `EventPayload` with no `family` case (proto3 default). */
export function encodePayload(name: string, ev: Event): Uint8Array {
  const w = new Writer();
  const family = familyFor(name);
  if (family === "mouse") {
    w.writeMessage(
      EVENT_PAYLOAD_MOUSE,
      (m) => writeMouseData(m, name, ev as MouseEvent),
    );
  } else if (family === "keyboard") {
    w.writeMessage(
      EVENT_PAYLOAD_KEYBOARD,
      (m) => writeKeyboardData(m, ev as KeyboardEvent),
    );
  } else if (family === "form") {
    w.writeMessage(EVENT_PAYLOAD_FORM, (m) => writeFormData(m, name, ev));
  }
  return w.finish();
}
