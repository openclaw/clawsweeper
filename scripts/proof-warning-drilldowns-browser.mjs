import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright-core";

const out = resolve(process.argv[2] ?? ".artifacts/warning-proof");
const base = process.argv[3] ?? "5577656d79ed491486b5e9ab9853df481f9aa8f1";
mkdirSync(out, { recursive: true });
const snapshot = JSON.parse(readFileSync(join(out, "dashboard.json"), "utf8"));
const dataPath = resolve("dashboard-site/src/data/dashboard.json");
const originalData = existsSync(dataPath) ? readFileSync(dataPath) : null;
const beforeRoot = join(out, "baseline");
mkdirSync(beforeRoot, { recursive: true });
// An explicit archive is produced from the pinned base by the caller when manifest sync
// does not carry Git history. Its bytes are hashed in the trace for independent comparison.
const baselineArchive = process.argv[4]
  ? readFileSync(process.argv[4])
  : execFileSync("git", ["archive", base, "dashboard-site"]);
const baselineArchiveSha256 = createHash("sha256").update(baselineArchive).digest("hex");
execFileSync("tar", ["-xf", "-", "-C", beforeRoot], { input: baselineArchive });
const beforeSite = join(beforeRoot, "dashboard-site");
if (!existsSync(join(beforeSite, "node_modules")))
  symlinkSync(resolve("dashboard-site/node_modules"), join(beforeSite, "node_modules"), "dir");
mkdirSync(join(beforeSite, "src/data"), { recursive: true });
writeFileSync(join(beforeSite, "src/data/dashboard.json"), JSON.stringify(snapshot));
execFileSync("pnpm", ["--dir", beforeSite, "run", "build"], { stdio: "pipe" });
const variants = { before: join(beforeSite, "dist") };
for (const variant of ["after", "empty", "unavailable", "excluded"]) {
  const data =
    variant === "after" ? snapshot : JSON.parse(readFileSync(join(out, variant + ".json"), "utf8"));
  mkdirSync(resolve("dashboard-site/src/data"), { recursive: true });
  writeFileSync(dataPath, JSON.stringify(data));
  execFileSync("pnpm", ["--dir", "dashboard-site", "run", "build"], { stdio: "pipe" });
  variants[variant] = join(out, "sites", variant);
  cpSync("dashboard-site/dist", variants[variant], { recursive: true });
}
if (originalData) writeFileSync(dataPath, originalData);
let root = variants.before;
const server = createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const file = resolve(root, "." + pathname, pathname.endsWith("/") ? "index.html" : "");
  if (!file.startsWith(root + "/")) {
    res.writeHead(403).end();
    return;
  }
  try {
    const mime =
      {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".woff2": "font/woff2",
        ".svg": "image/svg+xml",
      }[extname(file)] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime });
    res.end(readFileSync(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
const binary =
  process.env.CHROMIUM_BIN ??
  [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/snap/bin/chromium",
  ].find(existsSync);
assert.ok(binary, "A real Chromium binary is required");
const browser = await chromium.launch({
  executablePath: binary,
  headless: true,
  args: ["--no-sandbox"],
});
const checks = [],
  requests = [],
  navigations = [];
try {
  for (const variant of Object.keys(variants)) {
    root = variants[variant];
    for (const width of variant === "after" ? [320, 390, 768, 1280] : [1280]) {
      for (const theme of variant === "after" ? ["dark", "light"] : ["dark"]) {
        const context = await browser.newContext({
          viewport: { width, height: 960 },
          colorScheme: theme,
        });
        await context.addInitScript((theme) => {
          localStorage.setItem("clawsweeper-theme", theme);
        }, theme);
        const page = await context.newPage();
        let observingDashboard = true;
        page.on("request", (request) => {
          if (observingDashboard) requests.push({ method: request.method(), url: request.url() });
        });
        for (const route of ["queue", "agent"]) {
          await page.goto(origin + "/" + route + "/");
          await page.evaluate(() => document.fonts.ready);
          assert.equal(
            await page.locator("html").evaluate((el) => el.classList.contains("dark")),
            theme === "dark",
          );
          assert.doesNotMatch(
            await page.locator("body").innerText(),
            /private-owner|secret-input|controlled-publication/,
          );
          const scope = page.locator(
            route === "queue" ? "[data-warning-evidence]" : "[data-claim-evidence]",
          );
          if (variant === "after") {
            // Shared shell integration: the warning owner must preserve the current mobile
            // navigation, repository jump, freshness disclosure and existing tooltip behavior.
            const freshness = page.locator(".snapshot-freshness");
            await freshness.locator("summary").click();
            assert.match(await freshness.innerText(), /Queue:.*UTC/);
            assert.match(await freshness.innerText(), /Workflow runs through:/);
            await freshness.locator("summary").click();
            const nav = width < 768 ? page.locator(".mobile-sections") : page.locator("aside");
            if (width < 768) await nav.locator("summary").click();
            const active = nav.locator('nav a[aria-current="page"]');
            assert.equal(await active.getAttribute("href"), "/" + route + "/");
            assert.ok(await active.isVisible());
            if (width < 768) await nav.locator("summary").click();
            const jump = page.locator("[data-cmd]:visible");
            await jump.click();
            assert.ok(await page.getByRole("dialog", { name: "Jump to repository" }).isVisible());
            await page.getByRole("textbox", { name: "Search repositories" }).fill("clawsweeper");
            const result = page.locator("#cmd-list a").first();
            assert.equal(await result.getAttribute("href"), "/repos/openclaw-clawsweeper/");
            await page.keyboard.press("Escape");
            assert.equal(await page.locator("#cmd").evaluate((el) => el.open), false);
            await jump.click();
            await page.getByRole("textbox", { name: "Search repositories" }).fill("clawsweeper");
            await page.keyboard.press("Enter");
            await page.waitForURL(origin + "/repos/openclaw-clawsweeper/");
            await page.goto(origin + "/" + route + "/");
            await page.getByRole("button", { name: "Toggle theme" }).click();
            assert.equal(
              await page.locator("html").evaluate((el) => el.classList.contains("dark")),
              theme !== "dark",
            );
            await page.getByRole("button", { name: "Toggle theme" }).click();
            assert.equal(
              await page.locator("html").evaluate((el) => el.classList.contains("dark")),
              theme === "dark",
            );
            if (route === "queue") {
              const link = page.locator('a[href="#warning-scanner_refused"]');
              await link.focus();
              await page.keyboard.press("Enter");
              await page.waitForFunction(
                () => document.querySelector("#warning-scanner_refused")?.open,
              );
              await page.locator("#warning-scanner_refused > summary").click();
              await link.click(); // Reopening the same hash must not depend on another hashchange event.
              await page.waitForFunction(
                () => document.querySelector("#warning-scanner_refused")?.open,
              );
              assert.equal(
                await page.locator("#warning-scanner_refused").evaluate((el) => el.open),
                true,
              );
              assert.match(await scope.innerText(), /Showing 10 of 25 records/);
              await page.locator("#warning-review_retry_exhausted > summary").click();
              await page.locator("#warning-stale_revision > summary").click();
              assert.match(await scope.innerText(), /not claimable backlog/);
              assert.equal(
                await page
                  .locator(
                    '#warning-stale_revision a[href="https://github.com/openclaw/clawsweeper/pull/2130"]',
                  )
                  .count(),
                1,
              );
            } else {
              assert.match(await scope.innerText(), /Showing 7 of 8 flagged targets/);
              assert.equal(await scope.locator("li > a").count(), 7);
              await scope.locator("summary").first().click();
              assert.equal(await scope.locator("ol").first().locator("li").count(), 5);
              assert.match(await scope.innerText(), /6 claims/);
            }
            const overflow = await scope.evaluate((el) => {
              const box = el.getBoundingClientRect();
              return {
                scroll: el.scrollWidth,
                client: el.clientWidth,
                left: box.left,
                right: box.right,
              };
            });
            assert.ok(
              overflow.scroll <= overflow.client + 1 &&
                overflow.left >= 0 &&
                overflow.right <= width,
              JSON.stringify({ width, route, overflow }),
            );
            const pageOverflow = await page.evaluate(
              () => document.documentElement.scrollWidth > innerWidth,
            );
            assert.equal(pageOverflow, false, "No page-wide overflow at " + width);
            checks.push({
              variant,
              width,
              theme,
              route,
              evidence_overflow: false,
              page_overflow: pageOverflow,
              shell_search_navigation_freshness_theme: "passed",
            });
            const links = await scope
              .locator("a")
              .evaluateAll((links) => links.map((link) => link.href));
            for (const href of links)
              assert.match(
                href,
                /^https:\/\/github\.com\/openclaw\/clawsweeper\/(issues|pull)\/[1-9]\d*$/,
              );
            assert.equal(await scope.locator("button,form,input").count(), 0);
          }
          if (variant === "empty" && route === "queue") {
            await scope.locator("summary").first().click();
            assert.match(await scope.innerText(), /No records in this warning class/);
          }
          if (variant === "excluded" && route === "queue") {
            await scope.locator("summary").first().click();
            assert.match(await scope.innerText(), /No eligible public records/);
            assert.doesNotMatch(await scope.innerText(), /No records in this warning class/);
          }
          if (variant === "unavailable" && route === "queue")
            assert.match(await page.locator("body").innerText(), /Warning evidence unavailable/);
          if (variant === "before" || (variant === "after" && width === 1280 && theme === "dark")) {
            if (variant === "after" && route === "queue") {
              await page.locator("#warning-scanner_refused").evaluate((el) => {
                el.open = false;
              });
              await page.locator("#warning-stale_revision").evaluate((el) => {
                el.open = false;
              });
            }
            const anchor =
              route === "queue"
                ? page.getByText("Parked · review", { exact: true })
                : page.getByText("Repeatedly claimed items", { exact: true });
            await anchor.evaluate((el) =>
              window.scrollTo(0, scrollY + el.getBoundingClientRect().top - 96),
            );
            await page.screenshot({
              path: join(out, route + "-" + variant + ".png"),
              animations: "disabled",
            });
          }
          if (variant === "after" && route === "queue" && width === 390 && theme === "dark") {
            await page
              .locator("#warning-review_retry_exhausted")
              .evaluate((el) => window.scrollTo(0, scrollY + el.getBoundingClientRect().top - 72));
            await page.screenshot({
              path: join(out, "queue-mobile-after.png"),
              animations: "disabled",
            });
          }
        }
        if (variant === "after") {
          await page.goto(origin + "/coverage/");
          const info = page.getByRole("button", { name: "About Stale", exact: true });
          await info.focus();
          await page.waitForFunction(() =>
            document.querySelector("#tip")?.classList.contains("on"),
          );
          assert.match(await page.locator("#tip").innerText(), /marked stale/);
          await page.keyboard.press("Escape");
          assert.equal(
            await page.locator("#tip").evaluate((el) => el.classList.contains("on")),
            false,
          );
          await info.click();
          await page.waitForFunction(() =>
            document.querySelector("#tip")?.classList.contains("on"),
          );
          await info.click();
          assert.equal(
            await page.locator("#tip").evaluate((el) => el.classList.contains("on")),
            false,
          );
        }
        if (variant === "after" && width === 1280 && theme === "dark") {
          await page.goto(origin + "/queue/#warning-stale_revision");
          const href = await page.locator("#warning-stale_revision a").getAttribute("href");
          const navigation = page.waitForURL("https://github.com/**");
          // Navigate the actual href; network is bounded to a canonical public GET via Playwright's verified TLS client.
          observingDashboard = false;
          await page.route("**/*", async (route) => {
            if (route.request().method() !== "GET") {
              await route.abort();
              return;
            }
            if (!route.request().isNavigationRequest()) {
              await route.abort();
              return;
            }
            const response = await route.fetch();
            assert.equal(response.ok(), true);
            navigations.push({ href, method: route.request().method(), status: response.status() });
            await route.fulfill({ response });
          });
          await page.locator("#warning-stale_revision a").click();
          await navigation;
          await context.unrouteAll({ behavior: "wait" });
        }
        await context.close();
      }
    }
  }
  assert.ok(
    !requests.some(
      (request) =>
        request.method !== "GET" ||
        new URL(request.url).hostname === "api.github.com" ||
        /\/(dispatches|enqueue|claim|complete|recover|apply)(\/|\?|$)/.test(request.url),
    ),
    "Observer-only requests",
  );
  writeFileSync(
    join(out, "browser-trace.json"),
    JSON.stringify(
      {
        base,
        baseline_archive_sha256: baselineArchiveSha256,
        checks,
        canonical_navigations: navigations,
        request_count: requests.length,
        github_api_requests: 0,
        mutation_requests: 0,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      result: "built-site browser flow verified",
      checks: checks.length,
      canonical_navigations: navigations,
    }),
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
