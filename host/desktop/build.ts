// Bundles `ui/main.ts` and stages the desktop app's `dist/` (analogous to
// `web/build.ts`, but for the Tauri frontend — no components/envelope to
// assemble, since this app has exactly one hardcoded producer name that
// `main.rs` resolves from its own resource dir).
//
//   deno run -A host/desktop/build.ts

import { copy, ensureDir } from "@std/fs";
import { fromFileUrl, join } from "@std/path";

const desktopDir = fromFileUrl(new URL(".", import.meta.url));
const root = join(desktopDir, "..", "..");
const distDir = join(desktopDir, "dist");

await Deno.remove(distDir, { recursive: true }).catch(() => {});
await ensureDir(distDir);

const bundle = new Deno.Command(Deno.execPath(), {
  args: [
    "bundle",
    "--platform",
    "browser",
    join(desktopDir, "ui", "main.ts"),
    "-o",
    join(distDir, "main.js"),
  ],
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
const bundleResult = await bundle.output();
if (!bundleResult.success) {
  console.error("deno bundle failed for host/desktop/ui/main.ts");
  Deno.exit(1);
}

await copy(join(desktopDir, "ui", "index.html"), join(distDir, "index.html"));
// Copied at build time, not duplicated in git: the vendor CSS lives once,
// under web/vendor/.
await copy(
  join(root, "web", "vendor", "todomvc-common.css"),
  join(distDir, "todomvc-common.css"),
);
await copy(
  join(root, "web", "vendor", "todomvc-app.css"),
  join(distDir, "todomvc-app.css"),
);

console.log(`wrote ${distDir}`);
