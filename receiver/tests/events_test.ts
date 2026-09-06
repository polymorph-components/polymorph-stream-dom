import { assertEquals } from "@std/assert";
import { encodePayload } from "../src/events.ts";
import { Reader } from "../src/proto.ts";

// proto/stream-dom-events.proto: EventPayload.navigation = 14,
// NavigationData.href = 1.
const EVENT_PAYLOAD_NAVIGATION = 14;
const NAVIGATION_HREF = 1;

Deno.test("encodePayload('hashchange') yields a navigation payload with the current location.href", () => {
  const bytes = encodePayload("hashchange", new Event("hashchange"));
  const r = new Reader(bytes);
  const [field] = r.readTag();
  assertEquals(field, EVENT_PAYLOAD_NAVIGATION);
  const sub = r.readMessage();
  const [hrefField] = sub.readTag();
  assertEquals(hrefField, NAVIGATION_HREF);
  const href = sub.readString();
  // `deno test` runs with no `--location`, so `globalThis.location` is
  // typically `undefined` here — assert against whatever the runtime
  // actually reports rather than a hardcoded string, so this test stays
  // meaningful under `--location` too.
  assertEquals(href, globalThis.location?.href ?? "");
  assertEquals(sub.finished(), true);
  assertEquals(r.finished(), true);
});

Deno.test("encodePayload('popstate') also yields the navigation family", () => {
  const bytes = encodePayload("popstate", new Event("popstate"));
  const r = new Reader(bytes);
  const [field] = r.readTag();
  assertEquals(field, EVENT_PAYLOAD_NAVIGATION);
});

Deno.test("encodePayload for an unrecognized name yields the empty payload (zero bytes)", () => {
  const bytes = encodePayload("focus", new Event("focus"));
  assertEquals(bytes.length, 0);
});
