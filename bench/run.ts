// Runs the tachometer benchmark matrix against `dist/` and converts its
// results into github-action-benchmark's `customSmallerIsBetter` format
// (dispatch: "bench" track).
//
//   deno run -A bench/run.ts [--sample-size N] [--filter substring]
//     [--chrome-binary path]
//
// Requires `just site` first (this does not build `dist/` itself, unlike
// `just bench`, which runs `site` before this).

import { fromFileUrl, join } from "@std/path";
import { generateConfig } from "./tachometer.ts";

const benchDir = fromFileUrl(new URL(".", import.meta.url));
const resultsDir = join(benchDir, "results");

interface Args {
  sampleSize?: number;
  filter?: string;
  chromeBinary?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  const rest = [...argv];
  while (rest.length) {
    const a = rest.shift()!;
    if (a === "--sample-size") args.sampleSize = Number(rest.shift());
    else if (a === "--filter") args.filter = rest.shift();
    else if (a === "--chrome-binary") args.chromeBinary = rest.shift();
    else {
      console.error(`unknown argument: ${a}`);
      Deno.exit(2);
    }
  }
  return args;
}

const args = parseArgs(Deno.args);

const config = generateConfig({
  filter: args.filter,
  sampleSize: args.sampleSize,
  chromeBinary: args.chromeBinary,
});
const configPath = join(benchDir, "tachometer.json");
await Deno.writeTextFile(configPath, JSON.stringify(config, null, 2) + "\n");
console.log(`${configPath}: ${config.benchmarks.length} benchmarks`);

await Deno.mkdir(resultsDir, { recursive: true });
const tachometerJsonPath = join(resultsDir, "tachometer.json");

const proc = new Deno.Command("npx", {
  args: [
    "-y",
    "tachometer@0.7.1",
    "--config",
    configPath,
    "--json-file",
    tachometerJsonPath,
  ],
  stdout: "inherit",
  stderr: "inherit",
});
const result = await proc.output();
if (!result.success) {
  console.error("tachometer run failed");
  Deno.exit(1);
}

interface TachometerResult {
  benchmarks: Array<{
    name: string;
    mean: { low: number; high: number };
  }>;
}

const tachometerResults: TachometerResult = JSON.parse(
  await Deno.readTextFile(tachometerJsonPath),
);

interface CustomSmallerIsBetterEntry {
  name: string;
  unit: string;
  value: number;
  range: string;
}

const benchmarkJson: CustomSmallerIsBetterEntry[] = tachometerResults
  .benchmarks.map((b) => {
    const value = (b.mean.low + b.mean.high) / 2;
    const half = (b.mean.high - b.mean.low) / 2;
    return {
      name: b.name,
      unit: "ms",
      value,
      range: `± ${half.toFixed(3)}`,
    };
  });

const benchmarkJsonPath = join(resultsDir, "benchmark.json");
await Deno.writeTextFile(
  benchmarkJsonPath,
  JSON.stringify(benchmarkJson, null, 2) + "\n",
);
console.log(`${benchmarkJsonPath}: ${benchmarkJson.length} entries`);
