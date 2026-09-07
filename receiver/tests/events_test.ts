import { assertEquals } from "@std/assert";
import { encodePayload } from "../src/events.ts";
import { EventPayload } from "../src/gen/stream-dom-events.ts";

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
