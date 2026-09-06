// Playwright end-to-end run against the assembled `dist/` site (dispatch:
// track E). `just e2e` runs `just site` first, so this test always exercises
// a freshly built `dist/`.
//
//   deno test -A web/e2e/

import { assert, assertEquals } from "@std/assert";
import { serveDir } from "@std/http/file-server";
import { chromium } from "playwright";
import { fromFileUrl, join } from "@std/path";

declare global {
  var __streamDom: { mounted: boolean; ready: Promise<void> } | undefined;
}

const distDir = join(
  fromFileUrl(new URL(".", import.meta.url)),
  "..",
  "..",
  "dist",
);

const stamp = JSON.parse(
  await Deno.readTextFile(join(distDir, "build-stamp.json")),
) as { commit: string; builtAt: string };
const headCommit = await new Deno.Command("git", {
  args: ["rev-parse", "HEAD"],
  cwd: join(distDir, ".."),
  stdout: "piped",
}).output().then((r) => new TextDecoder().decode(r.stdout).trim());
assertEquals(
  stamp.commit,
  headCommit,
  "dist/build-stamp.json commit must match the current HEAD — stale dist/?",
);

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
      (req) => serveDir(req, { fsRoot: distDir }),
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

const demos: Array<{ name: string; page: string }> = [
  { name: "dioxus-todomvc", page: "dioxus.html" },
  { name: "dominator-todomvc", page: "dominator.html" },
];

Deno.test("TodoMVC demos", async (t) => {
  const { url, shutdown } = await startServer();
  console.log(`served dist/ at ${url} (commit ${stamp.commit})`);
  const browser = await chromium.launch();
  try {
    for (const demo of demos) {
      await t.step(demo.name, async () => {
        const page = await browser.newPage();
        const consoleErrors: string[] = [];
        const pageErrors: string[] = [];
        page.on("console", (msg) => {
          if (msg.type() === "error") consoleErrors.push(msg.text());
        });
        page.on("pageerror", (err) => pageErrors.push(String(err)));

        page.setDefaultTimeout(30_000);
        await page.goto(`${url}/${demo.page}`);
        await page.evaluate(() => globalThis.__streamDom!.ready);
        assert(
          await page.evaluate(() => globalThis.__streamDom!.mounted),
          `${demo.page} failed to mount`,
        );

        const newTodo = page.locator(".new-todo");
        await newTodo.waitFor({ state: "visible" });

        // Add "buy milk".
        await newTodo.fill("buy milk");
        await newTodo.press("Enter");
        const items = page.locator(".todo-list li");
        await assertVisibleCount(items, 1);
        await assertText(items.first().locator("label"), "buy milk");
        await assertText(page.locator(".todo-count"), "1 item left");

        // Toggle it complete.
        await items.first().locator(".toggle").click();
        await assertHasClass(items.first(), "completed");
        await assertText(page.locator(".todo-count"), "0 items left");

        // Add a second todo, then filter to Completed.
        await newTodo.fill("walk dog");
        await newTodo.press("Enter");
        await assertVisibleCount(items, 2);
        await page.locator(".filters a", { hasText: "Completed" }).click();
        await assertVisibleCount(page.locator(".todo-list li:visible"), 1);
        await assertText(
          page.locator(".todo-list li:visible label"),
          "buy milk",
        );

        // Back to All to keep editing/destroy interactions simple.
        await page.locator(".filters a", { hasText: "All" }).click();
        await assertVisibleCount(items, 2);

        // Edit "walk dog" -> "walk the dog".
        const second = items.nth(1);
        await second.locator("label").dblclick();
        const editInput = second.locator(".edit");
        await editInput.fill("walk the dog");
        await editInput.press("Enter");
        await assertText(second.locator("label"), "walk the dog");

        // Destroy both.
        for (const _ of [0, 1]) {
          await items.first().hover();
          await items.first().locator(".destroy").click({ force: true });
        }
        await assertVisibleCount(items, 0);

        assertEquals(consoleErrors, [], `console errors on ${demo.page}`);
        assertEquals(pageErrors, [], `page errors on ${demo.page}`);

        await page.screenshot({
          path: `/tmp/opencode/e2e/${demo.name}.png`,
        });
        await page.close();
      });
    }
  } finally {
    await browser.close();
    await shutdown();
  }
});

// Polls `locator.count()` for up to 5s (no `@playwright/test` `expect`
// available under bare `playwright`, so this substitutes for its
// auto-retrying assertions).
// deno-lint-ignore no-explicit-any
async function assertVisibleCount(locator: any, n: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  let count = await locator.count();
  while (count !== n && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    count = await locator.count();
  }
  assertEquals(count, n);
}

// deno-lint-ignore no-explicit-any
async function assertText(locator: any, text: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  let actual = (await locator.first().textContent())?.trim();
  while (!actual?.includes(text) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    actual = (await locator.first().textContent())?.trim();
  }
  assert(
    actual?.includes(text),
    `expected text to include "${text}", got "${actual}"`,
  );
}

// deno-lint-ignore no-explicit-any
async function assertHasClass(locator: any, cls: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  let classAttr = await locator.first().getAttribute("class");
  while (
    !classAttr?.split(/\s+/).includes(cls) && Date.now() < deadline
  ) {
    await new Promise((r) => setTimeout(r, 100));
    classAttr = await locator.first().getAttribute("class");
  }
  assert(
    classAttr?.split(/\s+/).includes(cls),
    `expected class "${cls}" in "${classAttr}"`,
  );
}
