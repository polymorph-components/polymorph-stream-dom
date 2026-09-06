// WebDriver smoke test against the built desktop app, driven through
// `tauri-driver` (which itself launches `WebKitWebDriver`). No Playwright
// here: this is a native GTK/WebKit window, not a browser tab, so the
// W3C WebDriver wire protocol talked to directly over `fetch` is what
// `tauri-driver` actually speaks.
//
//   xvfb-run -a deno test -A host/desktop/e2e/
//
// Requires `just desktop` to have already built
// `host/target/release/stream-dom-desktop` with its component resource
// alongside it (see justfile's `desktop` recipe).

import { assert } from "@std/assert";
import { fromFileUrl, join } from "@std/path";

const desktopDir = fromFileUrl(new URL(".", import.meta.url));
const root = join(desktopDir, "..", "..", "..");
const appPath = join(root, "host", "target", "release", "stream-dom-desktop");

async function freePort(): Promise<number> {
  const listener = Deno.listen({ port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const conn = await Deno.connect({ port });
      conn.close();
      return;
    } catch {
      if (Date.now() > deadline) {
        throw new Error(`tauri-driver did not open port ${port} in time`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

class WebDriverSession {
  #base: string;
  #id = "";

  constructor(driverPort: number) {
    this.#base = `http://localhost:${driverPort}`;
  }

  async open(): Promise<void> {
    const res = await fetch(`${this.#base}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capabilities: {
          alwaysMatch: {
            "tauri:options": { application: appPath },
          },
        },
      }),
    });
    const body = await res.json();
    if (!res.ok) {
      throw new Error(`session open failed: ${JSON.stringify(body)}`);
    }
    this.#id = body.value.sessionId;
  }

  async #cmd(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.#base}/session/${this.#id}${path}`, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await res.json();
    if (!res.ok) {
      throw new Error(`${method} ${path} failed: ${JSON.stringify(json)}`);
    }
    return json.value;
  }

  executeScript(script: string, args: unknown[] = []): Promise<unknown> {
    return this.#cmd("POST", "/execute/sync", { script, args });
  }

  async findElement(cssSelector: string): Promise<string> {
    const v = await this.#cmd("POST", "/element", {
      using: "css selector",
      value: cssSelector,
    }) as Record<string, string>;
    return Object.values(v)[0];
  }

  sendKeys(elementId: string, text: string): Promise<unknown> {
    return this.#cmd("POST", `/element/${elementId}/value`, { text });
  }

  click(elementId: string): Promise<unknown> {
    return this.#cmd("POST", `/element/${elementId}/click`, {});
  }

  close(): Promise<unknown> {
    return this.#cmd("DELETE", "");
  }
}

async function pollUntil(
  session: WebDriverSession,
  script: string,
  timeoutMs: number,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await session.executeScript(script);
    if (v) return v;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for: ${script}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

Deno.test({
  name: "desktop smoke: mounts TodoMVC, adds and completes a todo",
  fn: async () => {
    // Fail, don't skip: `just desktop-smoke` builds the binary first, so a
    // missing one is a broken build, not an environment to be lenient about.
    await Deno.stat(appPath).catch(() => {
      throw new Error(`${appPath} missing — run \`just desktop\``);
    });
    const driverPort = await freePort();
    const nativePort = await freePort();
    const driver = new Deno.Command("tauri-driver", {
      args: ["--port", String(driverPort), "--native-port", String(nativePort)],
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    try {
      await waitForPort(driverPort, 15_000);
      const session = new WebDriverSession(driverPort);
      await session.open();
      try {
        await pollUntil(
          session,
          "return globalThis.__streamDomDesktop?.mounted === true",
          20_000,
        );

        const input = await session.findElement(".new-todo");
        // Character-by-character with a short pause between each: the
        // input is DOM-controlled (`value: "{draft}"`, reset from
        // confirmed producer state every render — guests/dioxus/todomvc's
        // `TodoHeader`), and each keystroke round-trips through
        // `oninput` -> `send_event` -> the producer -> the next
        // `read_chunk` before that state updates. Typing the whole
        // string in one WebDriver `value` call races that round trip
        // (observed: fast native typing overtakes the render and drops
        // characters). `\uE007` is the WebDriver-standard code for the
        // Enter key (a literal `"\n"` did not register as Enter with
        // WebKitWebDriver in this environment — the surprise the
        // dispatch's report section asked about).
        for (const ch of "Buy milk") {
          await session.sendKeys(input, ch);
          await new Promise((r) => setTimeout(r, 80));
        }
        await session.sendKeys(input, "\uE007");

        await pollUntil(
          session,
          `return Array.from(document.querySelectorAll('.todo-list li')).some(
            li => li.textContent.includes('Buy milk'));`,
          10_000,
        );

        const toggle = await session.findElement(".todo-list li .toggle");
        await session.click(toggle);

        await pollUntil(
          session,
          "return document.querySelector('.todo-list li.completed') !== null",
          10_000,
        );

        const batches = await session.executeScript(
          "return globalThis.__streamDomDesktop.stats.batches",
        );
        assert((batches as number) > 0, "expected at least one applied batch");

        const latency = await session.executeScript(
          "return globalThis.__streamDomDesktop.latency",
        ) as {
          reads: number;
          lastReadMs: number;
          maxPushMs: number;
          totalPushMs: number;
        };
        console.log(`desktop smoke: IPC latency ${JSON.stringify(latency)}`);
        assert(latency.reads > 0);
      } finally {
        await session.close().catch(() => {});
      }
    } finally {
      driver.kill();
      await driver.status;
    }
  },
});
