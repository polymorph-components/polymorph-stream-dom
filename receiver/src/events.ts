// `handle-event` payload family selection and encoding.
// proto/stream-dom-events.proto is normative for every field number below;
// only the families this bring-up receiver's mount layer wires up are
// implemented (docs/design.md "Events": the family the receiver chooses by
// event name) — mouse, keyboard, form, navigation. Every other name gets the empty
// payload (`EventPayload` with no `family` case set), which is legal per
// the proto's header comment ("No case set is the empty payload — focus,
// selection, ... the event name ... already says everything those
// carry").

import { Writer } from "./proto.ts";
import type { EventFieldSet } from "./policy.ts";

const EVENT_PAYLOAD_MOUSE = 1;
const EVENT_PAYLOAD_KEYBOARD = 2;
const EVENT_PAYLOAD_FORM = 3;
const EVENT_PAYLOAD_NAVIGATION = 14;

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

const NAVIGATION_HREF = 1;

/** Every field number above, for policy.ts's `Message.field` name table —
 * same reason as frames.ts's `STREAM_FIELD_NUMBERS`. */
export const EVENT_FIELD_NUMBERS = {
  EVENT_PAYLOAD_MOUSE,
  EVENT_PAYLOAD_KEYBOARD,
  EVENT_PAYLOAD_FORM,
  EVENT_PAYLOAD_NAVIGATION,
  MOUSE_CLIENT_X,
  MOUSE_CLIENT_Y,
  MOUSE_PAGE_X,
  MOUSE_PAGE_Y,
  MOUSE_SCREEN_X,
  MOUSE_SCREEN_Y,
  MOUSE_OFFSET_X,
  MOUSE_OFFSET_Y,
  MOUSE_BUTTON,
  MOUSE_PRIMARY,
  MOUSE_SECONDARY,
  MOUSE_AUXILIARY,
  MOUSE_BACK,
  MOUSE_FORWARD,
  MOUSE_MODIFIERS,
  MODIFIERS_ALT,
  MODIFIERS_CTRL,
  MODIFIERS_META,
  MODIFIERS_SHIFT,
  KEYBOARD_KEY,
  KEYBOARD_CODE,
  KEYBOARD_LOCATION,
  KEYBOARD_REPEAT,
  KEYBOARD_IS_COMPOSING,
  KEYBOARD_MODIFIERS,
  FORM_VALUE,
  FORM_CHECKED,
  FORM_FIELDS,
  FORM_FIELD_NAME,
  FORM_FIELD_VALUE,
  NAVIGATION_HREF,
} as const;

/** No filter: every field declared. Keeps the write sites uniform, so
 * unfiltered encoding is bit-identical to what this module emitted before
 * policies existed. */
const ALL_DECLARED: EventFieldSet = {
  EventPayload: -1,
  MouseData: -1,
  Modifiers: -1,
  KeyboardData: -1,
  FormData: -1,
  FormField: -1,
  NavigationData: -1,
};

/** Undeclared -> DROP, silently: the receiver authors payloads, so there
 * is no violator to report (policy.ts header). */
function on(mask: number, field: number): boolean {
  return (mask & (1 << field)) !== 0;
}

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

/** `window` listeners only (docs/design.md "Global listeners": "the only
 * reason to listen to either is to learn where the document now is").
 * `familyFor` doesn't know a listener's target, so it can't restrict on
 * that here — a producer that somehow registered these on a node or on
 * `document` still gets a sensible payload. */
const NAVIGATION_EVENTS = new Set(["hashchange", "popstate"]);

export type Family = "mouse" | "keyboard" | "form" | "navigation" | "none";

export function familyFor(name: string): Family {
  if (MOUSE_EVENTS.has(name)) return "mouse";
  if (KEYBOARD_EVENTS.has(name)) return "keyboard";
  if (FORM_EVENTS.has(name)) return "form";
  if (NAVIGATION_EVENTS.has(name)) return "navigation";
  return "none";
}

function writeModifiers(
  w: Writer,
  fieldNumber: number,
  ev: MouseEvent | KeyboardEvent,
  mods: number,
): void {
  w.writeMessage(fieldNumber, (m) => {
    if (ev.altKey && on(mods, MODIFIERS_ALT)) m.writeBool(MODIFIERS_ALT, true);
    if (ev.ctrlKey && on(mods, MODIFIERS_CTRL)) {
      m.writeBool(MODIFIERS_CTRL, true);
    }
    if (ev.metaKey && on(mods, MODIFIERS_META)) {
      m.writeBool(MODIFIERS_META, true);
    }
    if (ev.shiftKey && on(mods, MODIFIERS_SHIFT)) {
      m.writeBool(MODIFIERS_SHIFT, true);
    }
  });
}

function writeMouseData(
  w: Writer,
  name: string,
  ev: MouseEvent,
  ef: EventFieldSet,
): void {
  const m = ef.MouseData;
  if (on(m, MOUSE_CLIENT_X)) w.writeDouble(MOUSE_CLIENT_X, ev.clientX);
  if (on(m, MOUSE_CLIENT_Y)) w.writeDouble(MOUSE_CLIENT_Y, ev.clientY);
  if (on(m, MOUSE_PAGE_X)) w.writeDouble(MOUSE_PAGE_X, ev.pageX);
  if (on(m, MOUSE_PAGE_Y)) w.writeDouble(MOUSE_PAGE_Y, ev.pageY);
  if (on(m, MOUSE_SCREEN_X)) w.writeDouble(MOUSE_SCREEN_X, ev.screenX);
  if (on(m, MOUSE_SCREEN_Y)) w.writeDouble(MOUSE_SCREEN_Y, ev.screenY);
  if (on(m, MOUSE_OFFSET_X)) {
    w.writeDouble(
      MOUSE_OFFSET_X,
      (ev as MouseEvent & { offsetX?: number }).offsetX ?? 0,
    );
  }
  if (on(m, MOUSE_OFFSET_Y)) {
    w.writeDouble(
      MOUSE_OFFSET_Y,
      (ev as MouseEvent & { offsetY?: number }).offsetY ?? 0,
    );
  }
  if (BUTTON_EVENTS.has(name) && on(m, MOUSE_BUTTON)) {
    // MouseButton's case values (PRIMARY=0, AUXILIARY=1, SECONDARY=2,
    // BACK=3, FORWARD=4) coincide numerically with MouseEvent.button's
    // own encoding, so the raw DOM value is the wire value with no
    // remapping.
    w.writeUint32(MOUSE_BUTTON, ev.button);
  }
  const buttons = ev.buttons;
  if (buttons & 1 && on(m, MOUSE_PRIMARY)) w.writeBool(MOUSE_PRIMARY, true);
  if (buttons & 2 && on(m, MOUSE_SECONDARY)) {
    w.writeBool(MOUSE_SECONDARY, true);
  }
  if (buttons & 4 && on(m, MOUSE_AUXILIARY)) {
    w.writeBool(MOUSE_AUXILIARY, true);
  }
  if (buttons & 8 && on(m, MOUSE_BACK)) w.writeBool(MOUSE_BACK, true);
  if (buttons & 16 && on(m, MOUSE_FORWARD)) w.writeBool(MOUSE_FORWARD, true);
  if (on(m, MOUSE_MODIFIERS)) {
    writeModifiers(w, MOUSE_MODIFIERS, ev, ef.Modifiers);
  }
}

function writeKeyboardData(
  w: Writer,
  ev: KeyboardEvent,
  ef: EventFieldSet,
): void {
  const k = ef.KeyboardData;
  if (on(k, KEYBOARD_KEY)) w.writeString(KEYBOARD_KEY, ev.key ?? "");
  if (on(k, KEYBOARD_CODE)) w.writeString(KEYBOARD_CODE, ev.code ?? "");
  if (on(k, KEYBOARD_LOCATION)) {
    w.writeUint32(KEYBOARD_LOCATION, ev.location ?? 0);
  }
  if (ev.repeat && on(k, KEYBOARD_REPEAT)) w.writeBool(KEYBOARD_REPEAT, true);
  if (ev.isComposing && on(k, KEYBOARD_IS_COMPOSING)) {
    w.writeBool(KEYBOARD_IS_COMPOSING, true);
  }
  if (on(k, KEYBOARD_MODIFIERS)) {
    writeModifiers(w, KEYBOARD_MODIFIERS, ev, ef.Modifiers);
  }
}

interface FormControlLike {
  value?: string;
  checked?: boolean;
  type?: string;
}

function writeFormData(
  w: Writer,
  name: string,
  ev: Event,
  ef: EventFieldSet,
): void {
  const fd = ef.FormData;
  const target = ev.target as (EventTarget & FormControlLike) | null;
  if (on(fd, FORM_VALUE)) w.writeString(FORM_VALUE, target?.value ?? "");
  if (
    on(fd, FORM_CHECKED) &&
    (target?.type === "checkbox" || target?.type === "radio")
  ) {
    w.writeBool(FORM_CHECKED, target.checked === true);
  }
  if (
    on(fd, FORM_FIELDS) && name === "submit" &&
    target instanceof HTMLFormElement
  ) {
    // FormData(form).entries() on submit only — proto comment: "dioxus-web
    // populates them on every event inside a form, which serializes the
    // whole form per keystroke"; this receiver follows the proto's
    // narrower contract instead.
    for (const [fieldName, value] of new FormData(target).entries()) {
      w.writeMessage(FORM_FIELDS, (f) => {
        if (on(ef.FormField, FORM_FIELD_NAME)) {
          f.writeString(FORM_FIELD_NAME, fieldName);
        }
        if (on(ef.FormField, FORM_FIELD_VALUE)) {
          f.writeString(FORM_FIELD_VALUE, String(value));
        }
      });
    }
  }
}

/** `popstate`/`hashchange`: a producer has no `location` to read
 * (proto comment on `NavigationData`), so the receiver snapshots
 * `location.href` at dispatch time — uniformly for both event kinds, even
 * though `HashChangeEvent` itself carries `newURL`, since `PopStateEvent`
 * doesn't and one field set beats a per-event-type split. Read
 * defensively: `globalThis.location` is real in Deno too (so this compiles
 * and behaves sanely under `deno test`), but a non-browser embedding of
 * this module is still conceivable, and a `TypeError` here would be a
 * strange way to lose an otherwise-fine event. */
function writeNavigationData(w: Writer, ef: EventFieldSet): void {
  if (!on(ef.NavigationData, NAVIGATION_HREF)) return;
  let href = "";
  try {
    href = globalThis.location?.href ?? "";
  } catch {
    // Accessing `location` can throw under exotic embeddings (sandboxed
    // iframes, some SSR shims); "" degrades the same as "we don't know".
  }
  w.writeString(NAVIGATION_HREF, href);
}

/** Encode `ev` as an `EventPayload` for `name`'s family. Names outside
 * mouse/keyboard/form (including focus/blur and every family this receiver
 * does not yet implement) get the empty payload — zero bytes, which is a
 * valid `EventPayload` with no `family` case (proto3 default). */
export function encodePayload(
  name: string,
  ev: Event,
  events?: EventFieldSet,
): Uint8Array {
  const ef = events ?? ALL_DECLARED;
  const p = ef.EventPayload;
  const w = new Writer();
  const family = familyFor(name);
  // An undeclared family omits the whole family message — the empty
  // payload, which is a legal `EventPayload` (proto header: "No case set
  // is the empty payload").
  if (family === "mouse" && on(p, EVENT_PAYLOAD_MOUSE)) {
    w.writeMessage(
      EVENT_PAYLOAD_MOUSE,
      (m) => writeMouseData(m, name, ev as MouseEvent, ef),
    );
  } else if (family === "keyboard" && on(p, EVENT_PAYLOAD_KEYBOARD)) {
    w.writeMessage(
      EVENT_PAYLOAD_KEYBOARD,
      (m) => writeKeyboardData(m, ev as KeyboardEvent, ef),
    );
  } else if (family === "form" && on(p, EVENT_PAYLOAD_FORM)) {
    w.writeMessage(EVENT_PAYLOAD_FORM, (m) => writeFormData(m, name, ev, ef));
  } else if (family === "navigation" && on(p, EVENT_PAYLOAD_NAVIGATION)) {
    w.writeMessage(
      EVENT_PAYLOAD_NAVIGATION,
      (m) => writeNavigationData(m, ef),
    );
  }
  return w.finish();
}
