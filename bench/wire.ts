// Wire-shape regression gate (dispatch: "bench" track). For each
// producer x op, loads `bench.html?...&receiver=native&transport=direct`
// (the wire baseline is a single fixed configuration — the point is
// catching accidental frame/byte/batch drift in the producers or the
// encoder, not comparing receivers/transports, which don't change what
// goes *on the wire*), reads `window.__benchResult.wire`, and compares it
// field-for-field against `bench/wire-baseline.json`.
//
//   deno run -A bench/wire.ts            # compare against the baseline
//   UPDATE_BASELINE=1 deno run -A bench/wire.ts   # rewrite the baseline
//
// Ephemeral port, as web/e2e/todomvc_test.ts: parallel worktrees must not
// collide on a fixed port.

import { serveDir } from "@std/http/file-server";
import { chromium } from "playwright";
import { fromFileUrl, join } from "@std/path";

const distDir = join(
  fromFileUrl(new URL(".", import.meta.url)),
  "..",
  "dist",
);
const baselinePath = join(
  fromFileUrl(new URL(".", import.meta.url)),
  "wire-baseline.json",
);

const PRODUCERS = ["dioxus-bench", "dominator-bench"];
const OPS = [
  "create-1k",
  "replace-1k",
  "create-10k",
  "append-1k",
  "update-every-10th",
  "select-row",
  "swap-rows",
  "remove-row",
  "clear",
];

interface WireStats {
  frames: number;
  bytes: number;
  batches: number;
}
type Baseline = Record<string, WireStats>;

async function startServer(): Promise<
  { url: string; shutdown: () => Promise<void> }
> {
  const abort = new AbortController();
  let url = "";
  const ready = new Promise<void>((resolve) => {
    const server = Deno.serve(
      {
        port: 0,
        signal: abort.signal,
        onListen: ({ port }) => {
          url = `http://localhost:${port}`;
          resolve();
        },
      },
      (req) => serveDir(req, { fsRoot: distDir, quiet: true }),
    );
    (globalThis as { __server?: Deno.HttpServer }).__server = server;
  });
  await ready;
  return {
    url,
    shutdown: async () => {
      abort.abort();
      await (globalThis as { __server?: Deno.HttpServer }).__server
        ?.finished;
    },
  };
}

declare global {
  var __benchResult:
    | { ms: number; wire: WireStats; producer: string; op: string }
    | { error: string }
    | undefined;
}

async function measure(
  url: string,
  producer: string,
  op: string,
): Promise<WireStats> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(String(err)));
    await page.goto(
      `${url}/bench.html?app=${producer}&receiver=native&transport=direct&op=${op}`,
    );
    await page.waitForFunction(() => globalThis.__benchResult !== undefined, {
      timeout: 30_000,
    });
    const result = await page.evaluate(() => globalThis.__benchResult);
    await page.close();
    if (pageErrors.length > 0) {
      throw new Error(
        `${producer}/${op}: page errors: ${pageErrors.join("; ")}`,
      );
    }
    if (!result || "error" in result) {
      throw new Error(
        `${producer}/${op}: bench error: ${
          result && "error" in result ? result.error : "no result"
        }`,
      );
    }
    return result.wire;
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const { url, shutdown } = await startServer();
  console.log(`serving dist/ at ${url} for the wire gate`);

  const measured: Baseline = {};
  try {
    for (const producer of PRODUCERS) {
      for (const op of OPS) {
        const wire = await measure(url, producer, op);
        measured[`${producer}/${op}`] = wire;
      }
    }
  } finally {
    await shutdown();
  }

  if (Deno.env.get("UPDATE_BASELINE") === "1") {
    await Deno.writeTextFile(
      baselinePath,
      JSON.stringify(measured, null, 2) + "\n",
    );
    console.log(`wrote ${baselinePath}`);
    printTable(measured);
    return;
  }

  let baseline: Baseline;
  try {
    baseline = JSON.parse(await Deno.readTextFile(baselinePath));
  } catch {
    console.error(
      `no baseline at ${baselinePath} — run with UPDATE_BASELINE=1 first`,
    );
    Deno.exit(1);
  }

  printTable(measured);

  let mismatch = false;
  const keys = new Set([...Object.keys(baseline), ...Object.keys(measured)]);
  for (const key of [...keys].sort()) {
    const b = baseline[key];
    const m = measured[key];
    if (!b || !m) {
      mismatch = true;
      console.error(
        `${key}: ${b ? "measured missing" : "baseline missing"}`,
      );
      continue;
    }
    for (const field of ["frames", "bytes", "batches"] as const) {
      if (b[field] !== m[field]) {
        mismatch = true;
        console.error(
          `${key} ${field}: baseline ${b[field]} != measured ${m[field]}`,
        );
      }
    }
  }

  if (mismatch) {
    console.error(
      "wire gate FAILED — frame/byte/batch counts drifted from the baseline. " +
        "If this is an intended producer/encoder change, rerun with UPDATE_BASELINE=1.",
    );
    Deno.exit(1);
  }
  console.log("wire gate: all producer/op wire shapes match the baseline.");
}

function printTable(stats: Baseline): void {
  console.log(
    "producer/op".padEnd(28),
    "frames".padStart(8),
    "bytes".padStart(10),
    "batches".padStart(9),
  );
  for (const key of Object.keys(stats).sort()) {
    const s = stats[key];
    console.log(
      key.padEnd(28),
      String(s.frames).padStart(8),
      String(s.bytes).padStart(10),
      String(s.batches).padStart(9),
    );
  }
}

await main();
