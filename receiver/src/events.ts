// `handle-event` payload family selection and encoding.
// proto/stream-dom-events.proto is normative; the generated writers in
// `src/gen/stream-dom-events.ts` carry every field number, so this module
// only decides which family an event name belongs to and which DOM
// properties fill it. Only the families this bring-up receiver's mount
// layer wires up are implemented (docs/design.md "Events": the family the
// receiver chooses by event name) — mouse, keyboard, form, navigation.
// Every other name gets the empty payload (`EventPayload` with no `family`
// case set), which is legal per the proto's header comment ("No case set
// is the empty payload — focus, selection, ... the event name ... already
// says everything those carry").

import {
  EventPayload,
  type FormData as FormDataMessage,
  type FormField,
  type KeyboardData,
  type Modifiers,
  type MouseData,
  type NavigationData,
} from "./gen/stream-dom-events.ts";

// `MouseData.related_target` (16) is not populated: mapping a native
// `relatedTarget` Node to a producer node id needs the transcoder's
// reverse lookup (`RemoteDomTranscoder.producerIdForRid`/`remoteId`),
// which this module's `(name, ev)` signature has no access to. Left
// absent — a real gap, flagged in the track report rather than plumbed
// through here speculatively.

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

function modifiers(ev: MouseEvent | KeyboardEvent): Modifiers {
  return {
    alt: ev.altKey,
    ctrl: ev.ctrlKey,
    meta: ev.metaKey,
    shift: ev.shiftKey,
  };
}

function mouseData(name: string, ev: MouseEvent): MouseData {
  const buttons = ev.buttons;
  return {
    clientX: ev.clientX,
    clientY: ev.clientY,
    pageX: ev.pageX,
    pageY: ev.pageY,
    screenX: ev.screenX,
    screenY: ev.screenY,
    offsetX: (ev as MouseEvent & { offsetX?: number }).offsetX ?? 0,
    offsetY: (ev as MouseEvent & { offsetY?: number }).offsetY ?? 0,
    // MouseButton's case values (PRIMARY=0, AUXILIARY=1, SECONDARY=2,
    // BACK=3, FORWARD=4) coincide numerically with MouseEvent.button's
    // own encoding, so the raw DOM value is the wire value with no
    // remapping.
    button: BUTTON_EVENTS.has(name) ? ev.button : undefined,
    primary: (buttons & 1) !== 0,
    secondary: (buttons & 2) !== 0,
    auxiliary: (buttons & 4) !== 0,
    back: (buttons & 8) !== 0,
    forward: (buttons & 16) !== 0,
    modifiers: modifiers(ev),
  };
}

function keyboardData(ev: KeyboardEvent): KeyboardData {
  return {
    key: ev.key ?? "",
    code: ev.code ?? "",
    location: ev.location ?? 0,
    repeat: ev.repeat === true,
    isComposing: ev.isComposing === true,
    modifiers: modifiers(ev),
  };
}

interface FormControlLike {
  value?: string;
  checked?: boolean;
  type?: string;
}

function formData(name: string, ev: Event): FormDataMessage {
  const target = ev.target as (EventTarget & FormControlLike) | null;
  const fields: FormField[] = [];
  if (name === "submit" && target instanceof HTMLFormElement) {
    // FormData(form).entries() on submit only — proto comment: "dioxus-web
    // populates them on every event inside a form, which serializes the
    // whole form per keystroke"; this receiver follows the proto's
    // narrower contract instead.
    for (const [fieldName, value] of new FormData(target).entries()) {
      fields.push({ name: fieldName, value: String(value) });
    }
  }
  return {
    value: target?.value ?? "",
    checked: target?.type === "checkbox" || target?.type === "radio"
      ? target.checked === true
      : undefined,
    fields,
  };
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
function navigationData(): NavigationData {
  let href = "";
  try {
    href = globalThis.location?.href ?? "";
  } catch {
    // Accessing `location` can throw under exotic embeddings (sandboxed
    // iframes, some SSR shims); "" degrades the same as "we don't know".
  }
  return { href };
}

/** Encode `ev` as an `EventPayload` for `name`'s family. Names outside
 * mouse/keyboard/form/navigation (including focus/blur and every family
 * this receiver does not yet implement) get the empty payload — zero
 * bytes, which is a valid `EventPayload` with no `family` case (proto3
 * default). */
export function encodePayload(name: string, ev: Event): Uint8Array {
  const family = familyFor(name);
  let payload: EventPayload;
  if (family === "mouse") {
    payload = {
      family: { $case: "mouse", value: mouseData(name, ev as MouseEvent) },
    };
  } else if (family === "keyboard") {
    payload = {
      family: { $case: "keyboard", value: keyboardData(ev as KeyboardEvent) },
    };
  } else if (family === "form") {
    payload = { family: { $case: "form", value: formData(name, ev) } };
  } else if (family === "navigation") {
    payload = {
      family: { $case: "navigation", value: navigationData() },
    };
  } else {
    payload = { family: undefined };
  }
  return EventPayload.encode(payload).finish();
}
