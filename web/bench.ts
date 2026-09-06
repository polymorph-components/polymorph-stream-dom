// In-page benchmark runner (dispatch: track "bench"), bundled to
// `dist/bench.js`. Loaded as `bench.html?app=<name>&receiver=&transport=&op=<op>`.
// Mounts the named producer, runs exactly one `op` per page load — repeat
// sampling and statistics are tachometer's job (`bench/run.ts`), not this
// file's (dispatch: "Sampling/statistics are NOT ours: tachometer owns
// them").
//
// Methodology ported from polyengine-dioxus's bench/README.md
// "Methodology": fresh-state discipline per rep (untimed setup restores
// the operation's real precondition every time — never an already-done
// no-op a naive count check would miss) and hard postcondition sentinels
// that must be FALSE before the timed click and TRUE after, else this
// throws `FATAL bench bug` — a harness defect, not a data point.
//
// Wire contract: `bench/wire.ts` reads `window.__benchResult.wire` with
// `?receiver=native&transport=direct` and compares it to
// `bench/wire-baseline.json`; that is the only consumer of the `wire`
// field, so it must be the delta across the timed click ONLY (snapshot
// `mounted.stats` immediately before dispatch, again immediately after
// settling — see `timedClick`).
//
// CONTRACT: the dispatch's prose says measurement mode "callback" calls
// `window.tachometerResult(ms)`. tachometer@0.7.1's actual behaviour
// (README.md "Measurement modes" > "Global result", config.schema.json's
// `CallbackMeasurement`/`ExpressionMeasurement` defs) is the opposite:
// "callback" mode requires the bundled `/bench.js` module's `start()`/
// `stop()`, which only exists under tachometer's own dev server, not our
// static `dist/`; the mode that fits a plain static page is "global",
// which polls the `window.tachometerResult` global as a plain **assigned
// value**, not a call. This file follows the verified tool behaviour
// (`bench/tachometer.ts` sets `measurement: "global"`), not the dispatch's
// literal wording — flagged per house rules ("implement the most
// conservative reading... flag it prominently").

import { artifactsFromEnvelope } from "@polyengine/runtime/embedder";
import { mount } from "@polymorph/stream-dom-receiver";
import type { Mounted } from "@polymorph/stream-dom-receiver";

declare global {
  var tachometerResult: number | undefined;
  var __benchResult:
    | { ms: number; wire: WireStats; producer: string; op: string }
    | { error: string }
    | undefined;
}

interface WireStats {
  frames: number;
  bytes: number;
  batches: number;
}

function queryParam(name: string): string | undefined {
  return new URLSearchParams(location.search).get(name) ?? undefined;
}

function fatal(msg: string): never {
  throw new Error(`FATAL bench bug: ${msg}`);
}

function rowsEl(): Element {
  const el = document.getElementById("rows");
  if (!el) fatal("no #rows — #bench did not render");
  return el;
}

function rowCount(): number {
  const el = document.getElementById("row-count");
  return parseInt(el?.textContent ?? "", 10) || 0;
}

function updateRunCount(): number {
  const el = document.getElementById("update-run-count");
  return parseInt(el?.textContent ?? "", 10) || 0;
}

function dataIdAt(i: number): string | null {
  return rowsEl().children[i]?.getAttribute("data-id") ?? null;
}

function selectedDataId(): string | null {
  return rowsEl().querySelector("tr.selected")?.getAttribute("data-id") ??
    null;
}

async function waitForBenchRoot(): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!document.getElementById("bench")) {
    if (performance.now() > deadline) fatal("timed out waiting for #bench");
    await new Promise((r) => setTimeout(r, 16));
  }
}

async function clickId(mounted: Mounted, id: string): Promise<void> {
  const el = document.getElementById(id);
  if (!el) fatal(`no #${id} to click`);
  el.click();
  await mounted.nextCommit();
}

/** Untimed setup: restore the operation's real precondition every rep
 * (methodology: "fresh-state discipline per rep"). */
async function ensureRows(mounted: Mounted, n: 1000 | 10000): Promise<void> {
  if (rowCount() === n) return;
  if (rowCount() !== 0) await clickId(mounted, "clear");
  await clickId(mounted, n === 1000 ? "create-1k" : "create-10k");
}

/** Times exactly one dispatch: click -> batch applied, and takes the wire
 * delta across that same window from `mounted.stats` (cumulative counters
 * since mount — see receiver/src/mount.ts's `Mounted.stats` doc).
 *
 * Deliberately NOT extended to the next animation frame: the final DOM is
 * identical across producers, receivers and transports, so paint is not a
 * differentiator, and `requestAnimationFrame` does not fire at all in some
 * headless windows (tachometer opens each sample in a `window.open`
 * popup), which stalled every sample on the first CI run. */
async function timedClick(
  mounted: Mounted,
  fire: () => void,
): Promise<{ ms: number; wire: WireStats }> {
  const before = { ...mounted.stats };
  const t0 = performance.now();
  fire();
  await mounted.nextCommit();
  const t1 = performance.now();
  const after = mounted.stats;
  return {
    ms: t1 - t0,
    wire: {
      frames: after.frames - before.frames,
      bytes: after.bytes - before.bytes,
      batches: after.batches - before.batches,
    },
  };
}

type OpResult = { ms: number; wire: WireStats };
type Op = (mounted: Mounted) => Promise<OpResult>;

const ops: Record<string, Op> = {
  "create-1k": async (m) => {
    if (rowCount() !== 0) await clickId(m, "clear");
    if (rowCount() === 1000) fatal("create-1k: already 1000 before dispatch");
    const r = await timedClick(
      m,
      () => document.getElementById("create-1k")!.click(),
    );
    if (rowCount() !== 1000) fatal("create-1k: row count not 1000 after");
    return r;
  },

  // Same button as create-1k, but 1k rows are already present: measures
  // the keyed diff (or replace_cloned/clear+rebuild) path instead of a
  // 0 -> N build. See guests/dioxus/bench and guests/web-sys/dominator-bench
  // module docs for why the two producers diverge here on purpose.
  "replace-1k": async (m) => {
    await ensureRows(m, 1000);
    const prevFirst = dataIdAt(0);
    const r = await timedClick(
      m,
      () => document.getElementById("create-1k")!.click(),
    );
    if (dataIdAt(0) === prevFirst) {
      fatal("replace-1k: first row's data-id did not change");
    }
    if (rowCount() !== 1000) fatal("replace-1k: row count drifted from 1000");
    return r;
  },

  "create-10k": async (m) => {
    if (rowCount() !== 0) await clickId(m, "clear");
    if (rowCount() === 10000) {
      fatal("create-10k: already 10000 before dispatch");
    }
    const r = await timedClick(
      m,
      () => document.getElementById("create-10k")!.click(),
    );
    if (rowCount() !== 10000) fatal("create-10k: row count not 10000 after");
    return r;
  },

  "append-1k": async (m) => {
    await ensureRows(m, 1000);
    const before = rowCount();
    const r = await timedClick(
      m,
      () => document.getElementById("append-1k")!.click(),
    );
    if (rowCount() !== before + 1000) {
      fatal("append-1k: row count did not grow by 1000");
    }
    return r;
  },

  "update-every-10th": async (m) => {
    await ensureRows(m, 1000);
    const before = updateRunCount();
    const r = await timedClick(
      m,
      () => document.getElementById("update-every-10th")!.click(),
    );
    if (updateRunCount() !== before + 1) {
      fatal("update-every-10th: #update-run-count did not advance");
    }
    return r;
  },

  "select-row": async (m) => {
    await ensureRows(m, 1000);
    const target = dataIdAt(1);
    if (target === null) fatal("select-row: no row at index 1");
    if (selectedDataId() === target) {
      fatal("select-row: row already selected before dispatch");
    }
    const label = rowsEl().children[1]?.querySelector("td.label a");
    if (!label) fatal("select-row: no label anchor at index 1");
    const r = await timedClick(m, () => (label as HTMLElement).click());
    if (selectedDataId() !== target) {
      fatal("select-row: selection did not move to the target row");
    }
    return r;
  },

  "swap-rows": async (m) => {
    await ensureRows(m, 1000);
    const prevAt1 = dataIdAt(1);
    const r = await timedClick(
      m,
      () => document.getElementById("swap-rows")!.click(),
    );
    if (dataIdAt(1) === prevAt1) {
      fatal("swap-rows: row at position 1 did not change");
    }
    return r;
  },

  "remove-row": async (m) => {
    await ensureRows(m, 1000);
    const prevAt1 = dataIdAt(1);
    const button = rowsEl().children[1]?.querySelector(
      "td.remove button.remove",
    );
    if (!button) fatal("remove-row: no remove button at index 1");
    const r = await timedClick(m, () => (button as HTMLElement).click());
    if (dataIdAt(1) === prevAt1) {
      fatal("remove-row: row at position 1 did not change after removal");
    }
    return r;
  },

  "clear": async (m) => {
    await ensureRows(m, 10000);
    if (rowCount() === 0) fatal("clear: already empty before dispatch");
    const r = await timedClick(
      m,
      () => document.getElementById("clear")!.click(),
    );
    if (rowCount() !== 0) fatal("clear: rows remain after clear");
    return r;
  },
};

async function run(): Promise<void> {
  const app = queryParam("app");
  if (!app) throw new Error("missing ?app=");
  const op = queryParam("op");
  if (!op || !(op in ops)) {
    throw new Error(`missing or unknown ?op= (got ${op ?? "<none>"})`);
  }
  const receiver = queryParam("receiver");
  if (
    receiver !== undefined && receiver !== "native" && receiver !== "remote"
  ) {
    throw new Error(`unknown ?receiver=${receiver}`);
  }
  const transport = queryParam("transport");
  if (
    transport !== undefined && transport !== "direct" &&
    transport !== "chunked"
  ) {
    throw new Error(`unknown ?transport=${transport}`);
  }

  const root = document.getElementById("app");
  if (!root) throw new Error("#app not found");

  const [envelope, componentBuf] = await Promise.all([
    fetch(`./${app}.component.plan.json`).then((r) => r.text()),
    fetch(`./${app}.component.wasm`).then((r) => r.arrayBuffer()),
  ]);
  const source = artifactsFromEnvelope(envelope, new Uint8Array(componentBuf));

  const mounted = await mount({
    source,
    root,
    receiver,
    transport,
    onError: (err) => {
      globalThis.__benchResult = {
        error: err instanceof Error ? err.message : String(err),
      };
      throw err;
    },
  });
  await waitForBenchRoot();

  const { ms, wire } = await ops[op](mounted);
  globalThis.__benchResult = { ms, wire, producer: app, op };
  globalThis.tachometerResult = ms;
}

run().catch((err) => {
  console.error(err);
  globalThis.__benchResult = {
    error: err instanceof Error ? err.message : String(err),
  };
  throw err;
});
