// Two deterministic fuzzers over the decode+apply path, checking one
// property: however malformed or hostile the bytes, the receiver either
// applies them or throws an `Error` — and never damages the DOM the
// embedder owns around the mount root (docs/design.md "Policy": a throwing
// sink aborts the stream, and "Partial-batch DOM state at that point is
// the embedder's to tear down").
//
// Field numbers below are transcribed from proto/stream-dom.proto (the
// normative file) rather than imported from the source under test, as
// policy_test.ts does.

import { assert } from "@std/assert";
import { parseHTML } from "linkedom";
import { FrameDecoder, MAX_FRAME_BYTES } from "../src/frames.ts";
import { NativeDomReceiver } from "../src/native.ts";
import { Writer } from "../src/proto.ts";

// -- deterministic PRNG ---------------------------------------------------

/** mulberry32: 32-bit state, no dependencies, reproducible from a seed —
 * every failure below is replayable by re-running with the same seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// -- harness --------------------------------------------------------------

/** See native_test.ts: linkedom does not enforce the DOM's tree-acyclicity
 * invariant, which the receiver relies on the browser for. The shim
 * reproduces the browser's `HierarchyRequestError`; without it a cyclic
 * tree built by a hostile stream hangs the first traversal, and a fuzzer
 * that hangs reports nothing. */
const guarded = new WeakSet<object>();
function installHierarchyGuard(doc: Document): void {
  let proto: object | null = Object.getPrototypeOf(doc.createElement("div"));
  for (; proto !== null; proto = Object.getPrototypeOf(proto)) {
    if (guarded.has(proto)) continue;
    guarded.add(proto);
    const target = proto as unknown as Record<string, unknown>;
    for (const name of ["insertBefore", "appendChild", "moveBefore"]) {
      if (!Object.getOwnPropertyDescriptor(proto, name)) continue;
      const orig = target[name];
      if (typeof orig !== "function") continue;
      const call = orig as (this: Node, ...args: unknown[]) => unknown;
      target[name] = function (this: Node, node: Node, ...rest: unknown[]) {
        for (let p: Node | null = this; p !== null; p = p.parentNode) {
          if (p === node) {
            throw new DOMException(
              `${name}: the node is an ancestor of the parent`,
              "HierarchyRequestError",
            );
          }
        }
        return call.call(this, node, ...rest);
      };
    }
  }
}

const SENTINEL_HTML = `<span id="sentinel">untouched</span>`;

interface Harness {
  root: Element;
  container: Element;
  sentinel: Element;
  recv: NativeDomReceiver;
  decoder: FrameDecoder;
}

function harness(): Harness {
  const win = parseHTML(
    `<!doctype html><html><body><section id="container"><div id="root"></div>${SENTINEL_HTML}</section></body></html>`,
  );
  const doc = win.document as unknown as Document;
  installHierarchyGuard(doc);
  const root = doc.getElementById("root")!;
  const recv = new NativeDomReceiver(root);
  return {
    root,
    container: doc.getElementById("container")!,
    sentinel: doc.getElementById("sentinel")!,
    recv,
    decoder: new FrameDecoder(recv.sink),
  };
}

/** The embedder's DOM around the mount is intact and the mount root is
 * still addressable as id 0. Checked after every `push` and after every
 * throw. */
function assertMountIntact(h: Harness, where: string): void {
  // Identity comparisons use `assert`, not `assertStrictEquals`: on
  // failure the latter formats both DOM nodes into a diff, and stringifying
  // a linkedom node graph is slow enough to look like a hang — which would
  // hide exactly the failure this fuzzer exists to report.
  assert(h.recv.resolveNode(0) === h.root, `${where}: root is no longer id 0`);
  assert(h.root.parentNode === h.container, `${where}: root left its parent`);
  assert(h.container.childNodes[0] === h.root, `${where}: root moved`);
  assert(h.container.childNodes[1] === h.sentinel, `${where}: sentinel moved`);
  assert(
    h.sentinel.outerHTML === SENTINEL_HTML,
    `${where}: sentinel mutated: ${h.sentinel.outerHTML}`,
  );
}

// -- frame encoding -------------------------------------------------------

/** One length-delimited `Frame`, as the stream layout specifies (varint
 * byte length, then the message). */
function frame(build: (w: Writer) => void): Uint8Array {
  const body = (() => {
    const w = new Writer();
    build(w);
    return w.finish();
  })();
  const lp = new Writer();
  lp.writeVarint32(body.length);
  const prefix = lp.finish();
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix, 0);
  out.set(body, prefix.length);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// Frame.op field numbers (proto/stream-dom.proto).
const F_COMMIT = 1,
  F_INSERT_BEFORE = 2,
  F_SET_TEXT = 3,
  F_SET_ATTRIBUTE = 4,
  F_SET_PROPERTY = 5,
  F_CREATE_ELEMENT = 6,
  F_CREATE_TEXT = 7,
  F_REMOVE = 8,
  F_CLONE_TEMPLATE = 9,
  F_BIND_PATH = 10,
  F_CREATE_PLACEHOLDER = 11,
  F_ADD_LISTENER = 12,
  F_REMOVE_LISTENER = 13,
  F_INTERN = 14,
  F_REGISTER_TEMPLATE = 15,
  F_INSERT_AFTER = 16,
  F_BIND_MARKER = 17;

// -- structured fuzz ------------------------------------------------------

const STRUCTURED_RUNS = 3000;
const OPS_PER_RUN = 40;

Deno.test("hostile: random op sequences never damage the embedder's DOM", () => {
  const rand = prng(0x5eed_1234);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const int = (n: number) => Math.floor(rand() * n);

  // Interned refs the generator defines up front (1..4), plus refs it
  // never defines and the always-absent slot 0.
  const goodRefs = [1, 2, 3, 4] as const;
  const badRefs = [0, 90, 91, 4096] as const;
  // The generator keeps an approximate model of which ids are live so that
  // a run gets DEEP before it trips: a purely random target would make
  // almost every first op an unknown id, and a run stops at the first
  // throw (the mount would have aborted the stream). Hostile targets — the
  // mount root, never-created ids, ids just removed — are mixed in at
  // `HOSTILE_RATE`, which is what the fuzzer is actually probing.
  const HOSTILE_RATE = 0.15;
  const badIds = [0, 700, 900, 65_535] as const;
  /** Distinct rejection messages seen (digits normalized away). A floor on
   * its size below is the guard against the generator silently
   * degenerating into "every run dies the same way on op 1" — a fuzzer
   * that stops reaching the rules would otherwise still pass. */
  const rejections = new Map<string, number>();

  for (let run = 0; run < STRUCTURED_RUNS; run++) {
    const h = harness();
    // The model tracks live ids, and separately those that are ELEMENTS,
    // so a generated `parent` is usually something that can hold children.
    // It is deliberately approximate (a removed subtree's descendants stay
    // in it, for instance): its job is to keep runs deep enough to reach
    // interesting states, not to predict the receiver.
    const live: number[] = [];
    const liveElements: number[] = [0];
    let nextId = 1;
    const some = (xs: readonly number[]) => xs[Math.floor(rand() * xs.length)];
    /** An existing node: usually a live one, sometimes hostile (the mount
     * root, a never-created id, one just removed). */
    const target = () =>
      rand() < HOSTILE_RATE || live.length === 0 ? pick(badIds) : some(live);
    /** Something to insert into. Element-valued far more often than not. */
    const parent = () =>
      rand() < HOSTILE_RATE ? pick(badIds) : some(liveElements);
    /** A fresh id for a create/clone/bind op — sometimes a duplicate
     * registration or the mount root instead. */
    const newId = (isElement: boolean) => {
      if (rand() < HOSTILE_RATE) return pick(badIds);
      const id = nextId++;
      live.push(id);
      if (isElement) liveElements.push(id);
      return id;
    };
    const ref = () => rand() < HOSTILE_RATE ? pick(badRefs) : pick(goodRefs);
    const frames: Uint8Array[] = [
      frame((w) =>
        w.writeMessage(F_INTERN, (m) => {
          m.writeUint32(1, 1);
          m.writeString(2, "div");
        })
      ),
      frame((w) =>
        w.writeMessage(F_INTERN, (m) => {
          m.writeUint32(1, 2);
          m.writeString(2, "span");
        })
      ),
      frame((w) =>
        w.writeMessage(F_INTERN, (m) => {
          m.writeUint32(1, 3);
          m.writeString(2, "class");
        })
      ),
      frame((w) =>
        w.writeMessage(F_INTERN, (m) => {
          m.writeUint32(1, 4);
          m.writeString(2, "click");
        })
      ),
    ];
    // Seed a small live tree so the generated ops below have something
    // real to address from op 1: with an empty model every early op names
    // an unknown id and the run dies before it explores anything.
    for (let k = 0; k < 3; k++) {
      const id = newId(true);
      frames.push(frame((w) =>
        w.writeMessage(F_CREATE_ELEMENT, (m) => {
          m.writeUint32(1, id);
          m.writeUint32(2, 1);
        })
      ));
      frames.push(frame((w) =>
        w.writeMessage(F_INSERT_BEFORE, (m) => {
          m.writeUint32(1, k === 0 ? 0 : k);
          m.writeUint32(2, id);
        })
      ));
    }

    for (let i = 0; i < OPS_PER_RUN; i++) {
      switch (int(15)) {
        case 0:
          frames.push(frame((w) =>
            w.writeMessage(F_CREATE_ELEMENT, (m) => {
              m.writeUint32(1, newId(true));
              m.writeUint32(2, ref());
              if (rand() < 0.3) m.writeUint32(3, ref());
            })
          ));
          break;
        case 1:
          frames.push(frame((w) =>
            w.writeMessage(F_CREATE_TEXT, (m) => {
              m.writeUint32(1, newId(false));
              m.writeString(2, "t" + i);
            })
          ));
          break;
        case 2:
          frames.push(
            frame((w) =>
              w.writeMessage(
                F_CREATE_PLACEHOLDER,
                (m) => m.writeUint32(1, newId(false)),
              )
            ),
          );
          break;
        case 3:
          frames.push(frame((w) =>
            w.writeMessage(F_INSERT_BEFORE, (m) => {
              if (rand() < 0.75) m.writeUint32(1, parent());
              m.writeUint32(2, target());
              if (rand() < 0.25) m.writeUint32(3, target());
            })
          ));
          break;
        case 4:
          frames.push(frame((w) =>
            w.writeMessage(F_INSERT_AFTER, (m) => {
              if (rand() < 0.75) m.writeUint32(1, parent());
              m.writeUint32(2, target());
              m.writeUint32(3, target());
            })
          ));
          break;
        case 5: {
          const gone = target();
          const at = live.indexOf(gone);
          if (at >= 0) live.splice(at, 1);
          frames.push(
            frame((w) =>
              w.writeMessage(F_REMOVE, (m) => m.writeUint32(1, gone))
            ),
          );
          break;
        }
        case 6:
          frames.push(frame((w) =>
            w.writeMessage(F_SET_TEXT, (m) => {
              m.writeUint32(1, target());
              m.writeString(2, "x" + i);
            })
          ));
          break;
        case 7:
          frames.push(frame((w) =>
            w.writeMessage(F_SET_ATTRIBUTE, (m) => {
              m.writeUint32(1, target());
              m.writeUint32(2, ref());
              if (rand() < 0.3) m.writeUint32(3, ref());
              if (rand() < 0.7) m.writeString(4, "v" + i);
            })
          ));
          break;
        case 8:
          frames.push(frame((w) =>
            w.writeMessage(F_SET_PROPERTY, (m) => {
              m.writeUint32(1, target());
              m.writeUint32(2, ref());
              if (rand() < 0.5) m.writeString(3, "v" + i);
              else m.writeBool(6, rand() < 0.5);
            })
          ));
          break;
        case 9:
          frames.push(frame((w) =>
            w.writeMessage(
              rand() < 0.5 ? F_ADD_LISTENER : F_REMOVE_LISTENER,
              (m) =>
                m.writeMessage(1, (l) => {
                  if (rand() < 0.8) l.writeUint32(1, target());
                  else l.writeUint32(8, int(3)); // Global, sometimes unknown
                  l.writeUint32(2, ref());
                  l.writeBool(3, rand() < 0.5);
                }),
            )
          ));
          break;
        case 10:
          // A template arena with random (often out-of-range or cyclic)
          // child indices.
          frames.push(frame((w) =>
            w.writeMessage(F_REGISTER_TEMPLATE, (m) => {
              m.writeUint32(1, int(3));
              const n = 1 + int(4);
              for (let k = 0; k < n; k++) {
                m.writeMessage(2, (tn) => {
                  if (rand() < 0.6) {
                    tn.writeMessage(1, (el) => {
                      el.writeUint32(1, ref());
                      if (rand() < 0.5) {
                        el.writeMessage(3, (at) => {
                          at.writeUint32(1, ref());
                          at.writeString(3, "a");
                        });
                      }
                      for (let c = 0; c < int(3); c++) {
                        el.writeUint32(4, int(6));
                      }
                    });
                  } else if (rand() < 0.5) tn.writeString(2, "t");
                  else tn.writeMessage(3, () => {});
                });
              }
              m.writeUint32(3, int(4));
            })
          ));
          break;
        case 11:
          frames.push(frame((w) =>
            w.writeMessage(F_CLONE_TEMPLATE, (m) => {
              m.writeUint32(1, int(4));
              m.writeUint32(2, int(4));
              m.writeUint32(3, newId(true));
            })
          ));
          break;
        case 12:
          frames.push(frame((w) =>
            w.writeMessage(F_BIND_PATH, (m) => {
              m.writeUint32(1, target());
              // BindPath.path is `bytes`; each step is written as a
              // one-byte varint, which is byte-identical to the raw byte
              // for values < 128 — the only range used here.
              m.writeMessage(2, (p) => {
                for (let s = 0; s < int(4); s++) p.writeVarint32(int(4));
              });
              m.writeUint32(3, newId(true));
            })
          ));
          break;
        case 13:
          frames.push(frame((w) =>
            w.writeMessage(F_BIND_MARKER, (m) => {
              m.writeUint32(1, int(4));
              m.writeUint32(2, newId(false));
            })
          ));
          break;
        default:
          frames.push(frame((w) => w.writeBool(F_COMMIT, true)));
      }
    }

    // Feed the whole stream in chunks split at random byte boundaries: a
    // frame straddling a chunk must behave exactly as one that does not.
    const bytes = concat(frames);
    let at = 0;
    let threw = false;
    while (at < bytes.length && !threw) {
      const next = Math.min(bytes.length, at + 1 + int(24));
      try {
        h.decoder.push(bytes.subarray(at, next));
      } catch (err) {
        // A throw aborts the stream (mount.ts drops the read end), so the
        // run stops here — exactly as production would.
        assert(
          err instanceof Error,
          `run ${run}: thrown value is not an Error`,
        );
        threw = true;
        const kind = err.message.replace(/[0-9]+/g, "N");
        rejections.set(kind, (rejections.get(kind) ?? 0) + 1);
      }
      assertMountIntact(h, `run ${run} @${at}`);
      at = next;
    }
  }
  assert(
    rejections.size >= 10,
    `generator degenerated: only ${rejections.size} distinct rejections ` +
      `(${[...rejections.keys()].join(" | ")})`,
  );
});

// -- byte-mutation fuzz ---------------------------------------------------

const MUTATION_RUNS = 20_000;
/** A single mutated fixture is a few hundred bytes; anything near a second
 * means the decoder or the receiver is looping, which is the failure this
 * fuzzer exists to catch. */
const PER_ITERATION_BUDGET_MS = 1000;

const fixtureBytes = await Deno.readFile(
  new URL("../../crates/stream-dom-guest/fixtures/basic.pb", import.meta.url),
);

Deno.test("hostile: byte mutations of basic.pb neither hang nor damage the mount", () => {
  const rand = prng(0xf1ee_2024);
  const int = (n: number) => Math.floor(rand() * n);

  for (let run = 0; run < MUTATION_RUNS; run++) {
    let bytes: Uint8Array<ArrayBufferLike> = Uint8Array.from(fixtureBytes);
    switch (int(4)) {
      case 0: { // flip bits in a few bytes
        for (let k = 0; k < 1 + int(4); k++) {
          const at = int(bytes.length);
          bytes[at] ^= 1 << int(8);
        }
        break;
      }
      case 1: // truncate
        bytes = bytes.subarray(0, int(bytes.length));
        break;
      case 2: { // insert junk
        const at = int(bytes.length);
        const junk = new Uint8Array(1 + int(8));
        for (let k = 0; k < junk.length; k++) junk[k] = int(256);
        bytes = concat([bytes.subarray(0, at), junk, bytes.subarray(at)]);
        break;
      }
      default: { // replace a byte outright (hits length prefixes hardest)
        bytes[int(bytes.length)] = int(256);
        break;
      }
    }

    const h = harness();
    const started = performance.now();
    let at = 0;
    let threw = false;
    while (at < bytes.length && !threw) {
      const next = Math.min(bytes.length, at + 1 + int(32));
      try {
        h.decoder.push(bytes.subarray(at, next));
      } catch (err) {
        assert(
          err instanceof Error,
          `run ${run}: thrown value is not an Error`,
        );
        threw = true;
      }
      assertMountIntact(h, `mutation run ${run} @${at}`);
      at = next;
    }
    const elapsed = performance.now() - started;
    assert(
      elapsed < PER_ITERATION_BUDGET_MS,
      `mutation run ${run} took ${
        elapsed.toFixed(0)
      }ms (budget ${PER_ITERATION_BUDGET_MS}ms)`,
    );
  }
});

// -- decoder length bound -------------------------------------------------

Deno.test("FrameDecoder: a length prefix over MAX_FRAME_BYTES throws instead of buffering forever", () => {
  const h = harness();
  const lp = new Writer();
  lp.writeVarint32(MAX_FRAME_BYTES + 1);
  let caught: unknown;
  try {
    h.decoder.push(lp.finish());
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof Error, "expected an Error");
  assert(
    caught.message.includes("MAX_FRAME_BYTES"),
    `unexpected message: ${caught.message}`,
  );
  // A length just under the bound is still "wait for more bytes", not an
  // error — the bound is a ceiling, not a size limit on real frames.
  const ok = new Writer();
  ok.writeVarint32(MAX_FRAME_BYTES);
  harness().decoder.push(ok.finish());
});

Deno.test("FrameDecoder: a truncated sub-message inside a COMPLETE frame is an error, not a wait", () => {
  const h = harness();
  // Frame { create_text: <length says 20 bytes, only 2 follow> }, wrapped
  // in a frame length prefix that is itself correct. Only the length probe
  // in `#drain` may treat a truncation as "wait for more"; inside a frame
  // whose bytes are all present, it is a malformed frame.
  const body = Uint8Array.of((F_CREATE_TEXT << 3) | 2, 20, 0x08, 0x01);
  const lp = new Writer();
  lp.writeVarint32(body.length);
  let caught: unknown;
  try {
    h.decoder.push(concat([lp.finish(), body]));
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof Error, "expected an Error, got " + String(caught));
  assertMountIntact(h, "truncated sub-message");
});
