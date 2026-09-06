// Browser entry for the desktop app (dispatch: track "host/desktop").
// Bundled with `deno bundle --platform browser` (build.ts). No fetch/env of
// its own component + protocol version negotiation like web/entry.ts: the
// desktop shell hosts exactly one producer, named by the Rust side's
// `spawn_producer` resource lookup.

import { Channel, invoke } from "@tauri-apps/api/core";
import { createDriver, desktopPolicy } from "@polymorph/stream-dom-receiver";
import type { ProducerEventTarget } from "@polymorph/stream-dom-receiver";

// -- Rust -> JS messages on the per-producer Channel -------------------------
//
// Mirrors `host/desktop/src/bridge.rs`'s `HostMessage` (serde tagged enum,
// `#[serde(rename_all = "kebab-case")]` on both the outer tag and the
// `QueryKind` variants).

type QueryKind = "client-rect" | "scroll-offset" | "scroll-size" | "focus";

type HostMessage =
  | {
    type: "query";
    id: number;
    kind: QueryKind;
    target: number;
    focus?: boolean;
  }
  | { type: "closed"; error?: string };

interface DesktopStreamDom {
  mounted: boolean;
  ready: Promise<void>;
  stats: { batches: number; frames: number; bytes: number };
  latency: {
    reads: number;
    lastReadMs: number;
    maxPushMs: number;
    totalPushMs: number;
  };
}

declare global {
  var __streamDomDesktop: DesktopStreamDom | undefined;
}

function showError(err: unknown): void {
  console.error(err);
  const pre = document.getElementById("error");
  if (pre) {
    pre.textContent = err instanceof Error
      ? `${err.name}: ${err.message}`
      : String(err);
  }
}

function targetHeaders(target: ProducerEventTarget): Record<string, string> {
  return target.kind === "node"
    ? { "target-kind": "node", "target-id": String(target.value) }
    : { "target-kind": target.kind };
}

let currentProducer: number | undefined;

async function run(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) throw new Error("#app not found");

  const events = new Channel<HostMessage>();
  const producer = await invoke<number>("spawn_producer", {
    name: "dioxus-todomvc",
    events,
  });
  currentProducer = producer;

  const driver = createDriver({
    root,
    // `externalLinks: true` because the TodoMVC footer links out to real
    // http(s) URLs; safe here specifically because `main.rs`'s
    // `on_navigation` refuses to follow any of them — the producer only
    // ever *names* a link, the host decides whether to honor it.
    policy: desktopPolicy({ relativeHref: true, externalLinks: true }),
    defaultPreventDefault: true,
    onError: showError,
    handleEvent(target, nameRef, payload) {
      return invoke("send_event", payload, {
        headers: {
          producer: String(producer),
          name: String(nameRef),
          ...targetHeaders(target),
        },
      });
    },
  });

  events.onmessage = (msg) => {
    if (msg.type === "closed") {
      if (msg.error) showError(new Error(msg.error));
      return;
    }
    const target = msg.target;
    let result: unknown = null;
    switch (msg.kind) {
      case "client-rect":
        result = driver.queries.getClientRect(target) ?? null;
        break;
      case "scroll-offset":
        result = driver.queries.getScrollOffset(target) ?? null;
        break;
      case "scroll-size":
        result = driver.queries.getScrollSize(target) ?? null;
        break;
      case "focus":
        result = driver.queries.setFocus(target, msg.focus ?? false);
        break;
    }
    invoke("answer_query", { producer, id: msg.id, result }).catch(showError);
  };

  const latency: DesktopStreamDom["latency"] = {
    reads: 0,
    lastReadMs: 0,
    maxPushMs: 0,
    totalPushMs: 0,
  };
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  globalThis.__streamDomDesktop = {
    mounted: false,
    ready,
    stats: driver.stats,
    latency,
  };

  for (;;) {
    let buf: ArrayBuffer;
    const t0 = performance.now();
    try {
      buf = await invoke<ArrayBuffer>("read_chunk", { producer });
    } catch (err) {
      // The producer died (trap, limit, or `kill_producer` already
      // called elsewhere) — nothing more to read.
      showError(err);
      break;
    }
    latency.reads++;
    latency.lastReadMs = performance.now() - t0;
    const pushStart = performance.now();
    try {
      driver.push(new Uint8Array(buf));
    } catch (err) {
      // `push` throws on a protocol/policy violation: stop feeding,
      // dispose, and tell the host side to tear the producer down — a
      // `read_chunk` after this would wait on an ack that will never
      // come (see bridge.rs's `PendingChunk` doc).
      showError(err);
      driver.dispose();
      await invoke("kill_producer", { producer }).catch(() => {});
      break;
    }
    const pushMs = performance.now() - pushStart;
    latency.totalPushMs += pushMs;
    if (pushMs > latency.maxPushMs) latency.maxPushMs = pushMs;
    if (!globalThis.__streamDomDesktop!.mounted) {
      globalThis.__streamDomDesktop!.mounted = true;
      resolveReady();
    }
  }
}

addEventListener("beforeunload", () => {
  // Best-effort: nothing awaits this, the page is going away regardless.
  if (currentProducer !== undefined) {
    invoke("kill_producer", { producer: currentProducer }).catch(() => {});
  }
});

run().catch(showError);
