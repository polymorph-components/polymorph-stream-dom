// Generates `bench/tachometer.json` — the full producers x receivers x
// transports x ops matrix — for tachometer@0.7.1 (dispatch: "bench"
// track). Sampling/statistics belong to tachometer; this only enumerates
// benchmark URLs and measurement config.
//
// `measurement: "global"` polls `window.tachometerResult`, a plain
// assigned number — the one mode a page served from a plain static server
// can support (`"callback"` needs tachometer's own injected `/bench.js`).
// Verified against tachometer@0.7.1's config.schema.json and README
// "Measurement modes" > "Global result".

export const PRODUCERS = ["dioxus-bench", "dominator-bench"] as const;
export const RECEIVERS = ["native", "remote"] as const;
export const TRANSPORTS = ["direct", "chunked"] as const;
export const OPS = [
  "create-1k",
  "replace-1k",
  "create-10k",
  "append-1k",
  "update-every-10th",
  "select-row",
  "swap-rows",
  "remove-row",
  "clear",
] as const;

export interface TachometerBenchmark {
  name: string;
  url: string;
  measurement: "global";
  browser: { name: "chrome"; headless: true; binary?: string };
}

export interface TachometerConfig {
  sampleSize?: number;
  benchmarks: TachometerBenchmark[];
}

export interface GenerateOptions {
  /** Origin of a server already serving `dist/`, e.g. `http://127.0.0.1:41234`.
   * The benchmarks are REMOTE urls on purpose: tachometer's own static
   * server (used for local `root`-relative urls) reads every response as
   * text when its cache is on — which it always is outside manual mode —
   * and re-encodes it, so a `.wasm` grows from 533,697 to 644,034 bytes
   * and never instantiates. It also reserves `/bench.js` for its
   * callback-mode helper and rewrites served JS through koa-node-resolve.
   * Serving `dist/` ourselves (bench/run.ts) avoids all three. */
  baseUrl: string;
  /** Substring filter against a benchmark's `name`
   * (`<producer>/<receiver>/<transport>/<op>`). */
  filter?: string;
  sampleSize?: number;
  /** `browser.binary` passthrough — a local Chrome/Chromium binary path. */
  chromeBinary?: string;
  /** Include the `chunked` transport. Off by default: it is a diagnostic
   * knob, not a shipped path, and it doubles a run that is dominated by
   * per-sample page loads (the full 72-variant matrix at 25 samples took
   * 45 minutes on a GitHub runner). */
  full?: boolean;
}

export function generateConfig(opts: GenerateOptions): TachometerConfig {
  const benchmarks: TachometerBenchmark[] = [];
  for (const producer of PRODUCERS) {
    for (const receiver of RECEIVERS) {
      for (const transport of TRANSPORTS) {
        if (transport === "chunked" && !opts.full) continue;
        for (const op of OPS) {
          const name = `${producer}/${receiver}/${transport}/${op}`;
          if (opts.filter && !name.includes(opts.filter)) continue;
          benchmarks.push({
            name,
            url:
              `${opts.baseUrl}/bench.html?app=${producer}&receiver=${receiver}&transport=${transport}&op=${op}`,
            measurement: "global",
            browser: {
              name: "chrome",
              headless: true,
              ...(opts.chromeBinary ? { binary: opts.chromeBinary } : {}),
            },
          });
        }
      }
    }
  }
  return {
    ...(opts.sampleSize ? { sampleSize: opts.sampleSize } : {}),
    benchmarks,
  };
}

if (import.meta.main) {
  const config = generateConfig({
    baseUrl: Deno.args[0] ?? "http://127.0.0.1:8000",
  });
  await Deno.writeTextFile(
    new URL("./tachometer.json", import.meta.url),
    JSON.stringify(config, null, 2) + "\n",
  );
  console.log(`bench/tachometer.json: ${config.benchmarks.length} benchmarks`);
}
