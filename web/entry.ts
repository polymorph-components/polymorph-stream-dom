// Browser entry for the demo pages (dispatch: track E). Bundled with
// `deno bundle --platform browser` (web/build.ts). Reads which demo to
// mount from `data-component` on `#app` (or a `?app=` query override, for
// the e2e test to probe both demos independent of which HTML shipped
// them), fetches the component + its build-time translation envelope, and
// mounts through the receiver (receiver/src/mount.ts).

import { artifactsFromEnvelope } from "@polyengine/runtime/embedder";
import { mount } from "@polymorph/stream-dom-receiver";

interface StreamDomGlobal {
  mounted: boolean;
  ready: Promise<void>;
}

declare global {
  var __streamDom: StreamDomGlobal | undefined;
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

async function run(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) throw new Error("#app not found");
  const override = new URLSearchParams(location.search).get("app");
  const name = override ?? root.dataset.component;
  if (!name) throw new Error("#app has no data-component and no ?app=");

  const [envelope, componentBuf] = await Promise.all([
    fetch(`./${name}.component.plan.json`).then((r) => r.text()),
    fetch(`./${name}.component.wasm`).then((r) => r.arrayBuffer()),
  ]);
  const source = artifactsFromEnvelope(envelope, new Uint8Array(componentBuf));

  await mount({ source, root, onError: showError });
  globalThis.__streamDom!.mounted = true;
}

let resolveReady!: () => void;
const ready = new Promise<void>((resolve) => {
  resolveReady = resolve;
});
globalThis.__streamDom = { mounted: false, ready };

run().then(resolveReady, (err) => {
  showError(err);
  resolveReady();
});
