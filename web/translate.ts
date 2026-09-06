// Build-time translation CLI for the demo site (dispatch: track E). The
// site never ships the translator (~0.5 MB gzip) — each component is
// translated once here, producing an envelope that `artifactsFromEnvelope`
// (receiver/src/mount.ts's `source`) reconstitutes at load time. Governing
// doc: polyengine's tools/translate/README.md ("Translate" / "Deploy
// host"); this mirrors its `main.ts` shape but sources the translator from
// the published `@polyengine/translator` package (`defaultTranslator()`)
// rather than a repo-local shim path, per the dispatch.
//
// Usage:
//   deno run --allow-read --allow-write --allow-env --allow-net \
//     web/translate.ts <component.wasm> [-o <out.plan.json>]

import { defaultTranslator } from "@polyengine/translator";

function usage(): never {
  console.error(
    "usage: translate <component.wasm> [-o <out.plan.json>]",
  );
  Deno.exit(2);
}

let input: string | undefined;
let output: string | undefined;

const args = [...Deno.args];
while (args.length) {
  const a = args.shift()!;
  if (a === "-o") output = args.shift() ?? usage();
  else if (a.startsWith("-")) usage();
  else if (input === undefined) input = a;
  else usage();
}
if (input === undefined) usage();
output ??= input.replace(/\.wasm$/, "") + ".plan.json";

const componentBytes = await Deno.readFile(input);
const translator = await defaultTranslator();

const t0 = performance.now();
const envelope = translator.translateRaw(componentBytes);
const ms = (performance.now() - t0).toFixed(1);

await Deno.writeTextFile(output, envelope);
console.log(
  `${output}: ${envelope.length} bytes envelope from ` +
    `${componentBytes.length} bytes component in ${ms}ms`,
);
