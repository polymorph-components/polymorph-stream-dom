// Browser entry for the demo pages (dispatch: track E). Bundled with
// `deno bundle --platform browser` (web/build.ts). Reads which demo to
// mount from `data-component` on `#app` (or a `?app=` query override, for
// the e2e test to probe both demos independent of which HTML shipped
// them), and which receiver/transport to use from `?receiver=`/
// `?transport=` (both optional; `mount`'s own defaults apply when
// absent), fetches the component + its build-time translation envelope,
// and mounts through the receiver (receiver/src/mount.ts).

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

function queryParam<T extends string>(
  name: string,
  allowed: readonly T[],
): T | undefined {
  const v = new URLSearchParams(location.search).get(name);
  return (allowed as readonly string[]).includes(v ?? "")
    ? (v as T)
    : undefined;
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

  const receiver = queryParam("receiver", ["native", "remote"] as const);
  const transport = queryParam("transport", ["direct", "chunked"] as const);
  const jspi = queryParam("jspi", ["true", "false"] as const);

  await mount({
    source,
    root,
    onError: showError,
    receiver,
    transport,
    jspi: jspi === undefined ? undefined : jspi === "true",
  });
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
