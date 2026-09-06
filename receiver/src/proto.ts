// Minimal protobuf (proto3) wire codec — no dependencies, no generated
// code. proto/stream-dom.proto and proto/stream-dom-events.proto are
// normative for every field number and type; this module only knows the
// wire format (docs/design.md "Encoding: protobuf, and why not a
// hand-rolled layout").
//
// Deliberately thin: `frames.ts` and `events.ts` decode field-by-field with
// a switch on tag (the "pbf hybrid decode" the design record names), so
// there is no generated-message layer here at all — just varint/fixed/
// length-delimited primitives plus wire-type skip.

/** Protobuf wire types (varint tag = (fieldNumber << 3) | wireType). */
export const enum WireType {
  Varint = 0,
  Fixed64 = 1,
  LengthDelimited = 2,
  Fixed32 = 5,
}

/** Thrown only when a `Reader` ran out of bytes before it could finish
 * decoding a value — as opposed to a value that IS fully present but
 * malformed (e.g. a varint whose continuation bit stays set past the
 * widest legal encoding). `FrameDecoder`'s straddling-frame buffering
 * depends on telling these apart: a truncation means "wait for more
 * bytes"; a malformed value is a real protocol error and must not be
 * swallowed as if more bytes would fix it. */
export class TruncatedError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "TruncatedError";
  }
}

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

/** Reads one message (or a length-delimited slice of one) from a
 * `Uint8Array`. Proto3 semantics: a field absent from the wire has its
 * type's default value; the caller (frames.ts) is responsible for
 * presence-tracking `optional` scalars by noting which field numbers it
 * saw. */
export class Reader {
  #buf: Uint8Array;
  #pos: number;
  #end: number;

  constructor(buf: Uint8Array, pos = 0, end = buf.length) {
    this.#buf = buf;
    this.#pos = pos;
    this.#end = end;
  }

  get pos(): number {
    return this.#pos;
  }

  /** Bytes remaining before `end`. */
  get remaining(): number {
    return this.#end - this.#pos;
  }

  finished(): boolean {
    return this.#pos >= this.#end;
  }

  #need(n: number): void {
    if (this.#pos + n > this.#end) {
      throw new TruncatedError(
        `proto.Reader: truncated (need ${n} bytes, have ${this.remaining})`,
      );
    }
  }

  /** Unsigned varint, up to 32 significant bits (field tags, node ids,
   * str-refs, `uint32` fields — everything in stream-dom.proto except the
   * `sint64` case). Throws a plain `RangeError` (NOT `TruncatedError`) if
   * the encoded value does not fit a u32 — that is a malformed varint,
   * fully present on the wire, not a buffering situation. */
  readVarint32(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      this.#need(1);
      const b = this.#buf[this.#pos++];
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 35) {
        throw new RangeError("proto.Reader: varint too long for u32");
      }
    }
    return result >>> 0;
  }

  /** Unsigned varint as a bigint, for fields wider than 32 bits (`sint64`).
   */
  readVarint64(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      this.#need(1);
      const b = this.#buf[this.#pos++];
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7n;
    }
    return result;
  }

  /** Zigzag-decoded `sint32`. */
  readSInt32(): number {
    const u = this.readVarint32();
    return (u >>> 1) ^ -(u & 1);
  }

  /** Zigzag-decoded `sint64`, narrowed to `number` (`Number(bigint)`):
   * every `sint64` on this wire (`SetProperty.int`) carries ordinary DOM
   * property integers, never a value outside `Number.isSafeInteger`
   * range, so bigint precision is not worth the API friction of a mixed
   * number/bigint value type in `frames.ts`'s `FrameSink`. */
  readSInt64(): number {
    const u = this.readVarint64();
    const doubled = u & 1n ? -(u + 1n) / 2n : u / 2n;
    return Number(doubled);
  }

  readBool(): boolean {
    return this.readVarint32() !== 0;
  }

  readFixed32(): number {
    this.#need(4);
    const v = new DataView(
      this.#buf.buffer,
      this.#buf.byteOffset + this.#pos,
      4,
    )
      .getUint32(0, true);
    this.#pos += 4;
    return v;
  }

  readDouble(): number {
    this.#need(8);
    const v = new DataView(
      this.#buf.buffer,
      this.#buf.byteOffset + this.#pos,
      8,
    )
      .getFloat64(0, true);
    this.#pos += 8;
    return v;
  }

  readFloat(): number {
    this.#need(4);
    const v = new DataView(
      this.#buf.buffer,
      this.#buf.byteOffset + this.#pos,
      4,
    )
      .getFloat32(0, true);
    this.#pos += 4;
    return v;
  }

  /** Length-delimited bytes, copied out (a view would alias a chunk buffer
   * a caller may not retain — see FrameDecoder's straddling-frame
   * handling). */
  readBytes(): Uint8Array {
    const len = this.readVarint32();
    this.#need(len);
    const out = this.#buf.slice(this.#pos, this.#pos + len);
    this.#pos += len;
    return out;
  }

  readString(): string {
    const len = this.readVarint32();
    this.#need(len);
    const s = textDecoder.decode(
      this.#buf.subarray(this.#pos, this.#pos + len),
    );
    this.#pos += len;
    return s;
  }

  /** A length-delimited sub-message, as a `Reader` scoped to its bytes. */
  readMessage(): Reader {
    const len = this.readVarint32();
    this.#need(len);
    const r = new Reader(this.#buf, this.#pos, this.#pos + len);
    this.#pos += len;
    return r;
  }

  /** Read a field tag, returning `[fieldNumber, wireType]`. */
  readTag(): [number, WireType] {
    const tag = this.readVarint32();
    return [tag >>> 3, (tag & 0x7) as WireType];
  }

  /** Skip a field's value given its wire type (unknown-field / unknown-op
   * tolerance — docs/design.md: "receivers skip what they do not know"). */
  skip(wireType: WireType): void {
    switch (wireType) {
      case WireType.Varint:
        this.readVarint64();
        break;
      case WireType.Fixed64:
        this.#need(8);
        this.#pos += 8;
        break;
      case WireType.LengthDelimited: {
        const len = this.readVarint32();
        this.#need(len);
        this.#pos += len;
        break;
      }
      case WireType.Fixed32:
        this.#need(4);
        this.#pos += 4;
        break;
      default:
        throw new RangeError(`proto.Reader: unknown wire type ${wireType}`);
    }
  }
}

/** Writes one message into a growable byte buffer. Used by remote.ts's
 * template validation error messages? No — by the receiver-side event
 * re-encoder is not needed; this is here for `events.ts`'s `encodePayload`
 * (an `EventPayload` the receiver sends back is decoded on the guest side,
 * so this Writer needs only the cases stream-dom-events.proto's messages
 * use: varint, bool, double, string, embedded messages). */
export class Writer {
  #chunks: number[] = [];

  #byte(b: number): void {
    this.#chunks.push(b & 0xff);
  }

  writeVarint32(value: number): void {
    let v = value >>> 0;
    for (;;) {
      if ((v & ~0x7f) === 0) {
        this.#byte(v);
        return;
      }
      this.#byte((v & 0x7f) | 0x80);
      v >>>= 7;
    }
  }

  writeSInt32(value: number): void {
    this.writeVarint32(((value << 1) ^ (value >> 31)) >>> 0);
  }

  writeTag(fieldNumber: number, wireType: WireType): void {
    this.writeVarint32((fieldNumber << 3) | wireType);
  }

  writeBool(fieldNumber: number, value: boolean): void {
    this.writeTag(fieldNumber, WireType.Varint);
    this.writeVarint32(value ? 1 : 0);
  }

  writeUint32(fieldNumber: number, value: number): void {
    this.writeTag(fieldNumber, WireType.Varint);
    this.writeVarint32(value);
  }

  writeSInt32Field(fieldNumber: number, value: number): void {
    this.writeTag(fieldNumber, WireType.Varint);
    this.writeSInt32(value);
  }

  writeDouble(fieldNumber: number, value: number): void {
    this.writeTag(fieldNumber, WireType.Fixed64);
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setFloat64(0, value, true);
    for (const b of buf) this.#byte(b);
  }

  writeFloat(fieldNumber: number, value: number): void {
    this.writeTag(fieldNumber, WireType.Fixed32);
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setFloat32(0, value, true);
    for (const b of buf) this.#byte(b);
  }

  writeString(fieldNumber: number, value: string): void {
    const bytes = textEncoder.encode(value);
    this.writeTag(fieldNumber, WireType.LengthDelimited);
    this.writeVarint32(bytes.length);
    for (const b of bytes) this.#byte(b);
  }

  /** Embedded message with a length prefix: builds `build` into a fresh
   * `Writer`, then writes its bytes behind a length-delimited tag. */
  writeMessage(fieldNumber: number, build: (w: Writer) => void): void {
    const sub = new Writer();
    build(sub);
    const bytes = sub.finish();
    this.writeTag(fieldNumber, WireType.LengthDelimited);
    this.writeVarint32(bytes.length);
    for (const b of bytes) this.#byte(b);
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.#chunks);
  }
}
