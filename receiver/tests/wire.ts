// Length-prefixed framing for test fixtures: the stream layout
// proto/stream-dom.proto's header describes (varint byte length, then one
// Frame, repeated). Frame bodies come from the generated writers
// (`Frame.encode(...).finish()`) for well-formed fixtures and from
// `BinaryWriter` directly for the malformed ones.

import { BinaryWriter } from "@bufbuild/protobuf/wire";

/** Prepend `bytes`'s length as a varint32 — one frame on the wire. */
export function frame(bytes: Uint8Array): Uint8Array {
  return new BinaryWriter().uint32(bytes.length).raw(bytes).finish();
}

/** Concatenate already-framed byte runs. */
export function stream(...frames: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const f of frames) total += f.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const f of frames) {
    out.set(f, at);
    at += f.length;
  }
  return out;
}
