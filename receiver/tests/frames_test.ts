import { assertEquals, assertThrows } from "@std/assert";
import { FrameDecoder } from "../src/frames.ts";
import { Frame, Global } from "../src/gen/stream-dom.ts";
import { frame } from "./wire.ts";
import type {
  AttrValue,
  FrameSink,
  Listener,
  PropertyValue,
  TemplateNode,
} from "../src/frames.ts";

type Call =
  | { op: "internString"; id: number; s: string }
  | { op: "createElement"; id: number; tag: number; ns: number | undefined }
  | { op: "createText"; id: number; text: string }
  | { op: "createPlaceholder"; id: number }
  | {
    op: "insertBefore";
    parent: number | undefined;
    id: number;
    anchor: number | undefined;
  }
  | {
    op: "insertAfter";
    parent: number | undefined;
    id: number;
    anchor: number;
  }
  | { op: "remove"; id: number }
  | { op: "setText"; id: number; text: string }
  | {
    op: "setAttribute";
    id: number;
    name: number;
    ns: number | undefined;
    value: AttrValue | undefined;
  }
  | { op: "setProperty"; id: number; name: number; value: PropertyValue }
  | { op: "addListener"; listener: Listener }
  | { op: "removeListener"; listener: Listener }
  | {
    op: "registerTemplate";
    id: number;
    nodes: TemplateNode[];
    roots: number[];
  }
  | { op: "cloneTemplate"; tmpl: number; root: number; id: number }
  | { op: "bindPath"; root: number; path: Uint8Array; id: number }
  | { op: "bindMarker"; key: number; id: number }
  | { op: "commit" };

class RecordingSink implements FrameSink {
  calls: Call[] = [];
  internString(id: number, s: string): void {
    this.calls.push({ op: "internString", id, s });
  }
  createElement(id: number, tag: number, ns: number | undefined): void {
    this.calls.push({ op: "createElement", id, tag, ns });
  }
  createText(id: number, text: string): void {
    this.calls.push({ op: "createText", id, text });
  }
  createPlaceholder(id: number): void {
    this.calls.push({ op: "createPlaceholder", id });
  }
  insertBefore(
    parent: number | undefined,
    id: number,
    anchor: number | undefined,
  ): void {
    this.calls.push({ op: "insertBefore", parent, id, anchor });
  }
  insertAfter(parent: number | undefined, id: number, anchor: number): void {
    this.calls.push({ op: "insertAfter", parent, id, anchor });
  }
  remove(id: number): void {
    this.calls.push({ op: "remove", id });
  }
  setText(id: number, text: string): void {
    this.calls.push({ op: "setText", id, text });
  }
  setAttribute(
    id: number,
    name: number,
    ns: number | undefined,
    value: AttrValue | undefined,
  ): void {
    this.calls.push({ op: "setAttribute", id, name, ns, value });
  }
  setProperty(id: number, name: number, value: PropertyValue): void {
    this.calls.push({ op: "setProperty", id, name, value });
  }
  setTextControlState(): void {}
  addListener(listener: Listener): void {
    this.calls.push({ op: "addListener", listener });
  }
  removeListener(listener: Listener): void {
    this.calls.push({ op: "removeListener", listener });
  }
  registerTemplate(id: number, nodes: TemplateNode[], roots: number[]): void {
    this.calls.push({ op: "registerTemplate", id, nodes, roots });
  }
  cloneTemplate(tmpl: number, root: number, id: number): void {
    this.calls.push({ op: "cloneTemplate", tmpl, root, id });
  }
  bindPath(root: number, path: Uint8Array, id: number): void {
    this.calls.push({ op: "bindPath", root, path, id });
  }
  bindMarker(key: number, id: number): void {
    this.calls.push({ op: "bindMarker", key, id });
  }
  commit(): void {
    this.calls.push({ op: "commit" });
  }
}

// crates/stream-dom-guest/fixtures/basic.pb + basic.txt: the cross-check
// corpus from the Rust producer side (docs/design.md open question 7,
// "Conformance corpus"). basic.txt's 17 `Frame { ... }` lines are the
// expected decode. prost prints `Listener.target` LAST regardless of the
// proto's field order (`target` is field 1/8, `name` is field 2, etc.) —
// decode is keyed on field number, not textual position, so this is a
// non-issue for the decoder; noted because it looks surprising reading
// basic.txt side by side with the .proto.
const fixtureDir = new URL(
  "../../crates/stream-dom-guest/fixtures/",
  import.meta.url,
);

async function loadFixture(): Promise<Uint8Array> {
  return await Deno.readFile(new URL("basic.pb", fixtureDir));
}

Deno.test("FrameDecoder decodes basic.pb into basic.txt's 17 frames", async () => {
  const bytes = await loadFixture();
  const sink = new RecordingSink();
  const decoder = new FrameDecoder(sink);
  decoder.push(bytes);

  const calls = sink.calls;
  assertEquals(calls.length, 18); // 17 frames' ops, plus the trailing commit()

  assertEquals(calls[0], { op: "internString", id: 1, s: "div" });
  assertEquals(calls[1], { op: "internString", id: 2, s: "click" });
  assertEquals(calls[2], { op: "internString", id: 3, s: "class" });
  assertEquals(calls[3], { op: "internString", id: 4, s: "hashchange" });
  assertEquals(calls[4], { op: "createElement", id: 1, tag: 1, ns: undefined });
  assertEquals(calls[5], { op: "createText", id: 2, text: "hello" });
  assertEquals(calls[6], {
    op: "insertBefore",
    parent: 0,
    id: 1,
    anchor: undefined,
  });
  assertEquals(calls[7], {
    op: "insertBefore",
    parent: 1,
    id: 2,
    anchor: undefined,
  });
  assertEquals(calls[8], { op: "createText", id: 3, text: "!" });
  // InsertAfter { parent: None, id: 3, anchor: 2 } — parent implied from
  // anchor 2's current shadow parent (node 1).
  assertEquals(calls[9], {
    op: "insertAfter",
    parent: undefined,
    id: 3,
    anchor: 2,
  });
  assertEquals(calls[10], { op: "createText", id: 4, text: "?" });
  // InsertBefore { parent: None, id: 4, anchor: Some(3) } — parent implied
  // from anchor 3's current shadow parent, likewise node 1.
  assertEquals(calls[11], {
    op: "insertBefore",
    parent: undefined,
    id: 4,
    anchor: 3,
  });
  assertEquals(calls[12], {
    op: "setAttribute",
    id: 1,
    name: 3,
    ns: undefined,
    value: { kind: "text", value: "greeting" },
  });
  assertEquals(calls[13], {
    op: "addListener",
    listener: {
      target: { kind: "node", id: 1 },
      name: 2,
      bubbles: true,
      capture: false,
      passive: false,
      preventDefault: false,
      stopPropagation: false,
    },
  });
  // Listener { name: 4 ("hashchange"), target: Global(Window) }.
  assertEquals(calls[14], {
    op: "addListener",
    listener: {
      target: { kind: "window" },
      name: 4,
      bubbles: false,
      capture: false,
      passive: false,
      preventDefault: false,
      stopPropagation: false,
    },
  });
  assertEquals(calls[15], { op: "setText", id: 2, text: "hello, world" });
  // Frame 17: commit=true, op=Remove{id:2} — op applied before commit is
  // honored (docs/design.md "Batches are framed by a `commit` flag").
  assertEquals(calls[16], { op: "remove", id: 2 });
  assertEquals(calls[17], { op: "commit" });
});

Deno.test("FrameDecoder handles a frame straddling arbitrary chunk boundaries (byte-by-byte)", async () => {
  const bytes = await loadFixture();
  const sink = new RecordingSink();
  const decoder = new FrameDecoder(sink);
  for (const byte of bytes) decoder.push(Uint8Array.of(byte));

  assertEquals(sink.calls.length, 18); // 17 ops + the trailing commit
  assertEquals(sink.calls[0], { op: "internString", id: 1, s: "div" });
  assertEquals(sink.calls[9], {
    op: "insertAfter",
    parent: undefined,
    id: 3,
    anchor: 2,
  });
  assertEquals(sink.calls[14], {
    op: "addListener",
    listener: {
      target: { kind: "window" },
      name: 4,
      bubbles: false,
      capture: false,
      passive: false,
      preventDefault: false,
      stopPropagation: false,
    },
  });
  assertEquals(sink.calls[16], { op: "remove", id: 2 });
  assertEquals(sink.calls[17], { op: "commit" });
});

Deno.test("FrameDecoder throws (does not silently wait forever) on a malformed length varint", () => {
  const sink = new RecordingSink();
  const decoder = new FrameDecoder(sink);
  // A length-prefix varint that never terminates within the legal width —
  // fully present on the wire, not a truncation, so it must not be
  // swallowed as "wait for more bytes" (that would hang forever, since no
  // amount of additional bytes fixes a malformed value already buffered).
  const malformed = Uint8Array.of(0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00);
  assertThrows(() => decoder.push(malformed));
});

Deno.test("FrameDecoder throws on a continuation-only length prefix past the legal width", () => {
  const sink = new RecordingSink();
  const decoder = new FrameDecoder(sink);
  // Six continuation bytes and no terminator: a u32 varint is at most
  // five, so this can never become a valid length however many bytes
  // follow. `BinaryReader.uint32()` reports it the same way it reports a
  // genuine truncation, so the decoder's five-byte probe window — not the
  // reader — is what tells the two apart.
  assertThrows(() =>
    decoder.push(Uint8Array.of(0x80, 0x80, 0x80, 0x80, 0x80, 0x80))
  );
});

// Global.DOCUMENT (value 1) isn't exercised by basic.pb (which only uses
// WINDOW), so build a frame for it with the generated writer.
Deno.test("FrameDecoder decodes Listener.target = Global(DOCUMENT)", () => {
  const framed = frame(
    Frame.encode({
      commit: false,
      op: {
        $case: "addListener",
        value: {
          listener: {
            target: { $case: "global", value: Global.DOCUMENT },
            name: 42,
            bubbles: false,
            capture: false,
            passive: false,
            preventDefault: false,
            stopPropagation: false,
          },
        },
      },
    }).finish(),
  );

  const sink = new RecordingSink();
  const decoder = new FrameDecoder(sink);
  decoder.push(framed);

  assertEquals(sink.calls, [
    {
      op: "addListener",
      listener: {
        target: { kind: "document" },
        name: 42,
        bubbles: false,
        capture: false,
        passive: false,
        preventDefault: false,
        stopPropagation: false,
      },
    },
  ]);
});
