import { assertEquals } from "@std/assert";
import { encodePayload } from "../src/events.ts";
import {
  EventPayload,
  SelectionDirection,
} from "../src/gen/stream-dom-events.ts";

Deno.test("encodePayload('hashchange') yields a navigation payload with the current location.href", () => {
  const payload = EventPayload.decode(
    encodePayload("hashchange", new Event("hashchange")),
  );
  assertEquals(payload.family?.$case, "navigation");
  const href = payload.family?.$case === "navigation"
    ? payload.family.value.href
    : undefined;
  // `deno test` runs with no `--location`, so `globalThis.location` is
  // typically `undefined` here — assert against whatever the runtime
  // actually reports rather than a hardcoded string, so this test stays
  // meaningful under `--location` too.
  assertEquals(href, globalThis.location?.href ?? "");
});

Deno.test("encodePayload('popstate') also yields the navigation family", () => {
  const payload = EventPayload.decode(
    encodePayload("popstate", new Event("popstate")),
  );
  assertEquals(payload.family?.$case, "navigation");
});

Deno.test("encodePayload for an unrecognized name yields the empty payload (zero bytes)", () => {
  const bytes = encodePayload("focus", new Event("focus"));
  assertEquals(bytes.length, 0);
});

Deno.test("input carries text-control value, UTF-16 selection, direction, and composition", () => {
  const target = new EventTarget() as EventTarget & {
    value: string;
    selectionStart: number;
    selectionEnd: number;
    selectionDirection: string;
  };
  Object.assign(target, {
    value: "A💡B",
    selectionStart: 1,
    selectionEnd: 3,
    selectionDirection: "backward",
  });
  const event = new Event("input") as InputEvent;
  Object.defineProperties(event, {
    target: { value: target },
    isComposing: { value: true },
  });

  const decoded = EventPayload.decode(encodePayload("input", event, true));
  assertEquals(decoded.textControl, {
    value: "A💡B",
    selectionStart: 1,
    selectionEnd: 3,
    direction: SelectionDirection.SELECTION_DIRECTION_BACKWARD,
    isComposing: true,
    _unknownFields: {},
  });
});

Deno.test("selectionchange carries a selection-only text-control snapshot", () => {
  const target = new EventTarget() as EventTarget & {
    value: string;
    selectionStart: number;
    selectionEnd: number;
    selectionDirection: string;
  };
  Object.assign(target, {
    value: "same value",
    selectionStart: 2,
    selectionEnd: 7,
    selectionDirection: "forward",
  });
  const event = new Event("selectionchange");
  Object.defineProperty(event, "target", { value: target });

  const decoded = EventPayload.decode(encodePayload("selectionchange", event));
  assertEquals(decoded.family, undefined);
  assertEquals(decoded.textControl?.value, "same value");
  assertEquals(decoded.textControl?.selectionStart, 2);
  assertEquals(decoded.textControl?.selectionEnd, 7);
  assertEquals(
    decoded.textControl?.direction,
    SelectionDirection.SELECTION_DIRECTION_FORWARD,
  );
});

Deno.test("composition lifecycle supplies explicit composing state", () => {
  const target = new EventTarget() as EventTarget & {
    value: string;
    selectionStart: number;
    selectionEnd: number;
    selectionDirection: string;
  };
  Object.assign(target, {
    value: "文",
    selectionStart: 1,
    selectionEnd: 1,
    selectionDirection: "none",
  });
  const event = new Event("compositionend") as CompositionEvent;
  Object.defineProperties(event, {
    target: { value: target },
    data: { value: "文" },
  });

  const decoded = EventPayload.decode(
    encodePayload("compositionend", event, false),
  );
  assertEquals(decoded.family, {
    $case: "composition",
    value: { data: "文", _unknownFields: {} },
  });
  assertEquals(decoded.textControl?.isComposing, false);
});
