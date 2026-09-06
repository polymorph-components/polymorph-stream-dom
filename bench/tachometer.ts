// Generates `bench/tachometer.json` — the full producers x receivers x
// transports x ops matrix — for tachometer@0.7.1 (dispatch: "bench"
// track). Sampling/statistics belong to tachometer; this only enumerates
// benchmark URLs and measurement config.
//
// CONTRACT (see web/bench.ts's header comment for the full account):
// `measurement: "global"` polls `window.tachometerResult` (a plain
// assigned number), which is what a static `dist/` page can support —
// not the `{mode: "callback"}` object form the dispatch's prose
// describes, which needs tachometer's own dev-server-injected
// `/bench.js` `start()`/`stop()` module. Verified against
// tachometer@0.7.1's config.schema.json and README.md "Measurement
// modes" > "Global result".

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
  root: string;
  sampleSize?: number;
  benchmarks: TachometerBenchmark[];
}

export interface GenerateOptions {
  /** Substring filter against a benchmark's `name`
   * (`<producer>/<receiver>/<transport>/<op>`). */
  filter?: string;
  sampleSize?: number;
  /** `browser.binary` passthrough — a local Chrome/Chromium binary path
   * (dispatch: "support `--chrome-binary` passthrough"). */
  chromeBinary?: string;
}

export function generateConfig(opts: GenerateOptions = {}): TachometerConfig {
  const benchmarks: TachometerBenchmark[] = [];
  for (const producer of PRODUCERS) {
    for (const receiver of RECEIVERS) {
      for (const transport of TRANSPORTS) {
        for (const op of OPS) {
          const name = `${producer}/${receiver}/${transport}/${op}`;
          if (opts.filter && !name.includes(opts.filter)) continue;
          benchmarks.push({
            name,
            // Resolved by tachometer relative to *this config file's own
            // directory* (bench/), not `root` — config.ts's
            // `urlFromLocalPath`/`parseBenchmark` compute
            // `path.resolve(dirname(configFilePath), urlPath)` and then
            // check the result falls under `root` (itself resolved the
            // same way). `root` below is `../dist` for the same reason:
            // both must land on the same `dist/` directory from bench/'s
            // perspective.
            url:
              `../dist/bench.html?app=${producer}&receiver=${receiver}&transport=${transport}&op=${op}`,
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
    root: "../dist",
    ...(opts.sampleSize ? { sampleSize: opts.sampleSize } : {}),
    benchmarks,
  };
}

if (import.meta.main) {
  const config = generateConfig();
  await Deno.writeTextFile(
    new URL("./tachometer.json", import.meta.url),
    JSON.stringify(config, null, 2) + "\n",
  );
  console.log(`bench/tachometer.json: ${config.benchmarks.length} benchmarks`);
}
