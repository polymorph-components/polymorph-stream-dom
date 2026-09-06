import { assertEquals, assertThrows } from "@std/assert";
import { Reader, TruncatedError, WireType, Writer } from "../src/proto.ts";

Deno.test("varint round trip", () => {
  for (const v of [0, 1, 127, 128, 300, 16384, 0xffffffff >>> 0]) {
    const w = new Writer();
    w.writeVarint32(v);
    const r = new Reader(w.finish());
    assertEquals(r.readVarint32(), v);
  }
});

Deno.test("sint32 zigzag round trip", () => {
  for (const v of [0, 1, -1, 2, -2, 2147483647, -2147483648]) {
    const w = new Writer();
    w.writeSInt32(v);
    const r = new Reader(w.finish());
    assertEquals(r.readSInt32(), v);
  }
});

Deno.test("bool, double, string round trip", () => {
  const w = new Writer();
  w.writeBool(1, true);
  w.writeDouble(2, 3.5);
  w.writeString(3, "hello, world");
  const r = new Reader(w.finish());
  const [f1, wt1] = r.readTag();
  assertEquals(f1, 1);
  assertEquals(wt1, WireType.Varint);
  assertEquals(r.readBool(), true);
  const [f2, wt2] = r.readTag();
  assertEquals(f2, 2);
  assertEquals(wt2, WireType.Fixed64);
  assertEquals(r.readDouble(), 3.5);
  const [f3, wt3] = r.readTag();
  assertEquals(f3, 3);
  assertEquals(wt3, WireType.LengthDelimited);
  assertEquals(r.readString(), "hello, world");
  assertEquals(r.finished(), true);
});

Deno.test("embedded message with length prefix", () => {
  const w = new Writer();
  w.writeMessage(1, (m) => {
    m.writeUint32(1, 42);
    m.writeString(2, "inner");
  });
  const r = new Reader(w.finish());
  const [field, wireType] = r.readTag();
  assertEquals(field, 1);
  assertEquals(wireType, WireType.LengthDelimited);
  const sub = r.readMessage();
  const [f1] = sub.readTag();
  assertEquals(f1, 1);
  assertEquals(sub.readVarint32(), 42);
  const [f2] = sub.readTag();
  assertEquals(f2, 2);
  assertEquals(sub.readString(), "inner");
  assertEquals(sub.finished(), true);
  assertEquals(r.finished(), true);
});

Deno.test("skip by wire type: varint, fixed64, length-delimited, fixed32", () => {
  const w = new Writer();
  w.writeUint32(1, 999); // varint
  w.writeDouble(2, 1.25); // fixed64
  w.writeString(3, "skip me"); // length-delimited
  w.writeFloat(4, 2.5); // fixed32
  w.writeUint32(5, 7); // a field we actually read, to prove skip advanced correctly
  const r = new Reader(w.finish());
  for (let i = 0; i < 4; i++) {
    const [, wt] = r.readTag();
    r.skip(wt);
  }
  const [field] = r.readTag();
  assertEquals(field, 5);
  assertEquals(r.readVarint32(), 7);
  assertEquals(r.finished(), true);
});

Deno.test("readVarint32 rejects truncated input", () => {
  const buf = Uint8Array.of(0x80); // continuation bit set, no follow-up byte
  const r = new Reader(buf);
  assertThrows(() => r.readVarint32());
});

Deno.test("readVarint32 throws TruncatedError specifically when bytes run out", () => {
  const buf = Uint8Array.of(0x80, 0x80); // still continuing, buffer just ends
  const r = new Reader(buf);
  assertThrows(() => r.readVarint32(), TruncatedError);
});

Deno.test("readVarint32 throws a plain (non-Truncated) error for a malformed varint that is fully present", () => {
  // Every byte present, continuation bit set throughout — never
  // terminates within the legal width for a u32. This is NOT a buffering
  // situation (the bytes are all there); FrameDecoder must not treat it
  // as "wait for more".
  const buf = Uint8Array.of(0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00);
  const r = new Reader(buf);
  let threw: unknown;
  try {
    r.readVarint32();
  } catch (e) {
    threw = e;
  }
  if (!(threw instanceof RangeError) || threw instanceof TruncatedError) {
    throw new Error(`expected a plain RangeError, got ${String(threw)}`);
  }
});

Deno.test("sint64 zigzag round trip via SetProperty-shaped field", () => {
  for (const v of [0, 1, -1, 1000000, -1000000]) {
    const w = new Writer();
    w.writeTag(4, WireType.Varint);
    // sint64 has no dedicated Writer method (not needed by encodePayload),
    // so round-trip it through the sint32 zigzag encoding for values that
    // fit — readSInt64 must decode the same zigzag scheme regardless of
    // width.
    w.writeSInt32(v);
    const r = new Reader(w.finish());
    r.readTag();
    assertEquals(r.readSInt64(), v);
  }
});
