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

// Matrix: both demos x both receiver backends (transport stays "direct" —
// mount()'s default — since the transports differ only in how bytes reach
// the decoder, not in anything this test could observe). Same assertions
// for every cell: the native and remote-dom receivers are meant to be
// behaviorally indistinguishable from the DOM's perspective.
const receivers = ["native", "remote"] as const;

Deno.test("TodoMVC demos", async (t) => {
  const { url, shutdown } = await startServer();
  console.log(`served dist/ at ${url} (commit ${stamp.commit})`);
  const browser = await chromium.launch();
  try {
    for (const demo of demos) {
      for (const receiver of receivers) {
        await t.step(`${demo.name} (receiver=${receiver})`, async () => {
          const page = await browser.newPage();
          const consoleErrors: string[] = [];
          const pageErrors: string[] = [];
          page.on("console", (msg) => {
            if (msg.type() === "error") consoleErrors.push(msg.text());
          });
          page.on("pageerror", (err) => pageErrors.push(String(err)));

          page.setDefaultTimeout(30_000);
          const plain = demo.name === "dioxus-todomvc"
            ? "&jspi=false&transport=chunked"
            : "";
          await page.goto(`${url}/${demo.page}?receiver=${receiver}${plain}`);
          await page.evaluate(() => globalThis.__streamDom!.ready);
          assert(
            await page.evaluate(() => globalThis.__streamDom!.mounted),
            `${demo.page} (receiver=${receiver}) failed to mount`,
          );

          const newTodo = page.locator(".new-todo");
          await newTodo.waitFor({ state: "visible" });

          if (demo.name === "dioxus-todomvc") {
            // Eight real component export entries (input/keydown pairs) issued
            // from one browser task. Four distinguishable results prove FIFO
            // delivery without relying on an intermediate DOM observation.
            await newTodo.evaluate((node) => {
              const input = node as HTMLInputElement;
              for (
                const text of ["queued-a", "queued-b", "queued-c", "queued-d"]
              ) {
                input.value = text;
                input.dispatchEvent(new InputEvent("input", { bubbles: true }));
                input.dispatchEvent(
                  new KeyboardEvent("keydown", {
                    bubbles: true,
                    key: "Enter",
                    code: "Enter",
                  }),
                );
              }
            });
            const queuedLabels = page.locator(".todo-list li label");
            await assertVisibleCount(queuedLabels, 4);
            assertEquals(await queuedLabels.allTextContents(), [
              "queued-a",
              "queued-b",
              "queued-c",
              "queued-d",
            ]);
            for (const _ of [0, 1, 2, 3]) {
              await page.locator(".todo-list li").first().hover();
              await page.locator(".todo-list li .destroy").first().click();
            }
            await assertVisibleCount(page.locator(".todo-list li"), 0);
            assertEquals(consoleErrors, [], "queued export console errors");
            assertEquals(pageErrors, [], "queued export page errors");

            // A real keyboard selection-only change carries the unchanged
            // value and UTF-16 range to Rust. On a later task, a synthetic
            // button click changes both value and range atomically without
            // moving focus.
            const selectionProbe = page.getByRole("textbox", {
              name: "Selection probe",
            });
            await selectionProbe.focus();
            await selectionProbe.press("Home");
            await selectionProbe.press("Shift+ArrowRight");
            await assertText(
              page.getByRole("status", { name: "Observed selection" }),
              "0:1",
            );
            await selectionProbe.evaluate((node) => {
              (node as HTMLTextAreaElement).setSelectionRange(5, 5, "none");
            });
            await page.getByRole("button", { name: "Restore selection" })
              .evaluate((button) => {
                button.dispatchEvent(
                  new MouseEvent("click", { bubbles: true }),
                );
              });
            const expectedSelection = {
              value: "A💡BC!",
              start: 0,
              end: 6,
              direction: "backward",
              focused: true,
            };
            let actualSelection: typeof expectedSelection;
            const deadline = Date.now() + 5_000;
            do {
              actualSelection = await selectionProbe.evaluate((node) => {
                const input = node as HTMLTextAreaElement;
                return {
                  value: input.value,
                  start: input.selectionStart,
                  end: input.selectionEnd,
                  direction: input.selectionDirection,
                  focused: document.activeElement === input,
                };
              });
              if (
                JSON.stringify(actualSelection) ===
                  JSON.stringify(expectedSelection)
              ) break;
              await page.waitForTimeout(20);
            } while (Date.now() < deadline);
            assertEquals(actualSelection, expectedSelection);
          }

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

          assertEquals(
            consoleErrors,
            [],
            `console errors on ${demo.page} (receiver=${receiver})`,
          );
          assertEquals(
            pageErrors,
            [],
            `page errors on ${demo.page} (receiver=${receiver})`,
          );

          await page.screenshot({
            path: `/tmp/opencode/e2e/${demo.name}-${receiver}.png`,
          });
          await page.close();
        });
      }
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
