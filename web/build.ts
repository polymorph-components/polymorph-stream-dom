// Assembles the GitHub Pages site into `dist/` (dispatch: track E).
// Requires `just components` to have already produced
// `build/<name>.component.{wasm,plan.json}` for each demo.
//
//   deno run --allow-read --allow-write --allow-env --allow-net --allow-run \
//     web/build.ts

import { copy, ensureDir } from "@std/fs";
import { fromFileUrl, join } from "@std/path";

const webDir = fromFileUrl(new URL(".", import.meta.url));
const root = join(webDir, "..");
const buildDir = join(root, "build");
const distDir = join(root, "dist");

const components = ["dioxus-todomvc", "dominator-todomvc"];

for (const name of components) {
  const wasm = join(buildDir, `${name}.component.wasm`);
  const plan = join(buildDir, `${name}.component.plan.json`);
  for (const path of [wasm, plan]) {
    try {
      await Deno.stat(path);
    } catch {
      console.error(
        `missing ${path} — run \`just components\` before \`just site\`.`,
      );
      Deno.exit(1);
    }
  }
}

await Deno.remove(distDir, { recursive: true }).catch(() => {});
await ensureDir(distDir);

// Bundle the browser entry.
const bundle = new Deno.Command(Deno.execPath(), {
  args: [
    "bundle",
    "--platform",
    "browser",
    "--minify",
    join(webDir, "entry.ts"),
    "-o",
    join(distDir, "entry.js"),
  ],
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
const bundleResult = await bundle.output();
if (!bundleResult.success) {
  console.error("deno bundle failed");
  Deno.exit(1);
}

// HTML pages.
for (const html of ["index.html", "dioxus.html", "dominator.html"]) {
  await copy(join(webDir, html), join(distDir, html), { overwrite: true });
}

// Vendored CSS.
await ensureDir(join(distDir, "vendor"));
for await (const entry of Deno.readDir(join(webDir, "vendor"))) {
  if (entry.isFile && entry.name.endsWith(".css")) {
    await copy(
      join(webDir, "vendor", entry.name),
      join(distDir, "vendor", entry.name),
      { overwrite: true },
    );
  }
}

// Components + envelopes.
for (const name of components) {
  await copy(
    join(buildDir, `${name}.component.wasm`),
    join(distDir, `${name}.component.wasm`),
    { overwrite: true },
  );
  await copy(
    join(buildDir, `${name}.component.plan.json`),
    join(distDir, `${name}.component.plan.json`),
    { overwrite: true },
  );
}

// Build stamp + Pages housekeeping.
const commit = await new Deno.Command("git", {
  args: ["rev-parse", "HEAD"],
  cwd: root,
  stdout: "piped",
}).output().then((r) => new TextDecoder().decode(r.stdout).trim());

await Deno.writeTextFile(
  join(distDir, "build-stamp.json"),
  JSON.stringify({ commit, builtAt: new Date().toISOString() }, null, 2),
);
await Deno.writeTextFile(join(distDir, ".nojekyll"), "");

console.log(`dist/ assembled at commit ${commit}`);
