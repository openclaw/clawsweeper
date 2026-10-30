// Run against an actual built dashboard with the public-safe mobile-triage fixture.
// node scripts/dashboard-mobile-proof.mjs <site-directory> <artifact-directory>
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join, extname } from "node:path";
import { chromium } from "playwright-core";

const site = resolve(process.argv[2] ?? "dashboard-site");
const out = resolve(process.argv[3] ?? ".artifacts/mobile-triage");
const fixture = JSON.parse(await readFile(join(site, "src/data/dashboard.json"), "utf8"));
const unknownReview = !fixture.corpus.lists.maintainer[0].reviewedAt;
await mkdir(out, { recursive: true });
const server = createServer(async (req, res) => {
  let file = join(site, "dist", new URL(req.url, "http://localhost").pathname);
  if (!extname(file)) file = join(file, "index.html");
  try {
    const data = await readFile(file);
    const mime = {
      ".html": "text/html",
      ".css": "text/css",
      ".js": "text/javascript",
      ".woff2": "font/woff2",
      ".png": "image/png",
    };
    res.setHeader("Content-Type", mime[extname(file)] ?? "application/octet-stream");
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.end("Not found");
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
const results = [];
const noOverflow = async (page) =>
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    "no page-wide overflow: " + page.url(),
  );
try {
  for (const width of [320, 390, 768, 1024, 1440])
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        isMobile: width < 768,
        hasTouch: width < 768,
        colorScheme: theme,
      });
      await context.addInitScript(
        ({ theme }) => {
          if (localStorage.getItem("clawsweeper-theme") === null)
            localStorage.setItem("clawsweeper-theme", theme);
          Date.now = () => Date.parse("2026-10-12T07:32:00Z");
        },
        { theme },
      );
      await context.tracing.start({ snapshots: true, screenshots: true });
      const page = await context.newPage();
      const errors = [],
        externalRequests = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      page.on("request", (request) => {
        if (!request.url().startsWith(origin)) externalRequests.push(request.url());
      });
      await page.goto(origin + "/quality/");
      await page.evaluate(() => document.fonts.ready);
      await noOverflow(page);
      await page.screenshot({
        path: join(out, width + "-" + theme + "-shell.png"),
        animations: "disabled",
      });
      const freshness = page.locator(".snapshot-freshness summary");
      assert.match(await freshness.innerText(), /Snapshot.*Reviews/s);
      await freshness.click();
      assert.equal(await page.locator(".snapshot-freshness[open]").count(), 1);
      assert.ok(
        await page.locator(".snapshot-freshness").getByText("Workflow runs through:").isVisible(),
      );
      await freshness.click();
      const rows = page.locator("#maintainer .item-table tbody tr");
      await rows.first().scrollIntoViewIfNeeded();
      const geometry = await rows.first().evaluate((row) => {
        const title = row.querySelector(".item-title");
        const box = title.getBoundingClientRect();
        return {
          titleWidth: box.width,
          titleHeight: box.height,
          titleFits: title.scrollWidth <= title.clientWidth + 1,
          identityFits:
            row.querySelector(".item-identity").scrollWidth <=
            row.querySelector(".item-identity").clientWidth + 1,
          assessment: row.querySelector(".item-assessment").textContent,
          review: row.querySelector(".item-review").textContent,
          rowDisplay: getComputedStyle(row).display,
        };
      });
      assert.ok(geometry.titleWidth >= 100 && geometry.titleFits, "readable full title");
      assert.match(geometry.assessment, /Product/);
      assert.match(geometry.review, /ago|Unknown/);
      assert.equal(
        geometry.review.includes("Unknown"),
        unknownReview,
        "unknown review date is explicit",
      );
      assert.ok(geometry.identityFits, "long repository identity wraps without clipping");
      if (width === 1024)
        assert.equal(geometry.rowDisplay, "table-row", "wide cards retain table layout");
      assert.ok(await rows.first().locator(".item-assessment").isVisible());
      const link = rows.first().locator("a");
      await link.focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      assert.equal(
        await link.evaluate(
          (node) => node === document.activeElement && node.matches(":focus-visible"),
        ),
        true,
        "keyboard focus returns to canonical item link",
      );
      assert.equal(await link.evaluate((node) => getComputedStyle(node).outlineStyle), "solid");
      assert.equal(new URL(await link.getAttribute("href")).origin, "https://github.com");
      await page.screenshot({
        path: join(out, width + "-" + theme + "-rows.png"),
        animations: "disabled",
      });
      // Preserve the existing ordinary KPI tooltip path, including touch pointerover -> pointerdown.
      const kpi = page.locator("main [data-tip]").first();
      await kpi.scrollIntoViewIfNeeded();
      if (width < 768) await kpi.tap();
      else await kpi.hover();
      assert.ok(await page.locator("#tip.on").isVisible(), "ordinary tooltip still opens");
      const tipBox = await page.locator("#tip").boundingBox();
      assert.ok(tipBox.x >= 0 && tipBox.x + tipBox.width <= width + 1, "tooltip stays in viewport");
      await page.evaluate(() => scrollTo(0, 0));
      const search = page.locator("[data-cmd]:visible").first();
      await search.click();
      assert.ok(await page.locator("#cmd[open]").isVisible());
      assert.equal(
        await page.locator("#cmd-q").evaluate((node) => node === document.activeElement),
        true,
      );
      await page.locator("#cmd-q").fill("long-public-repository");
      assert.equal(await page.locator("#cmd-list a").count(), 1);
      await noOverflow(page);
      await page.screenshot({
        path: join(out, width + "-" + theme + "-search.png"),
        animations: "disabled",
      });
      await page.keyboard.press("Escape");
      await page.locator("#cmd").waitFor({ state: "hidden" });
      assert.equal(await page.locator("#cmd[open]").count(), 0);
      assert.equal(
        await search.evaluate((node) => node === document.activeElement),
        true,
        "Escape restores trigger focus",
      );
      await search.click();
      await page.locator("#cmd-q").fill("no-such-repository");
      assert.match(await page.locator("#cmd-list").innerText(), /No repositories match/);
      await page.locator("#cmd-q").fill("long-public-repository");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowUp");
      await Promise.all([
        page.waitForURL("**/repos/example-long-public-repository-name-for-responsive-triage/"),
        page.keyboard.press("Enter"),
      ]);
      await noOverflow(page);
      if (width < 768) {
        const summary = page.locator(".mobile-sections summary");
        assert.match(await summary.innerText(), /Repositories/);
        await summary.focus();
        await page.keyboard.press("Enter");
        const current = page.locator(".mobile-sections [aria-current=page]");
        assert.ok(await current.isVisible());
        const box = await current.boundingBox();
        assert.ok(
          box.x >= 0 && box.x + box.width <= width && box.height >= 44,
          JSON.stringify({ width, box }),
        );
        await page.locator(".mobile-sections a[href='/coverage/']").click();
        assert.match(await page.locator(".mobile-sections summary").innerText(), /Coverage/);
        await page.screenshot({
          path: join(out, width + "-" + theme + "-navigation.png"),
          animations: "disabled",
        });
      } else {
        assert.ok(await page.locator("aside [aria-current=page]").isVisible());
      }
      if (width >= 768) await page.locator("aside a[href='/coverage/']").click();
      const info = page.locator("[data-info-tip]").first();
      assert.equal(
        await page.locator("[data-info-tip]").count(),
        5,
        "all landed Coverage explanations remain present",
      );
      await info.focus();
      assert.ok(await page.locator("#tip.on").isVisible(), "landed info tooltip opens on focus");
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("#tip.on").count(), 0);
      if (width < 768) await info.tap();
      else await info.click();
      assert.ok(await page.locator("#tip.on").isVisible(), "info tooltip pins on tap/click");
      if (width < 768) await info.tap();
      else await info.click();
      assert.equal(await page.locator("#tip.on").count(), 0, "second activation dismisses");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      assert.ok(await page.locator("#tip.on").isVisible());
      // Event-only compatibility check for the existing inner repository scroller.
      // Real touch and keyboard activation above remains separate from this capture-phase check.
      await page.locator("#cmd-list").evaluate((node) => node.dispatchEvent(new Event("scroll")));
      assert.equal(
        await page.locator("#tip.on").count(),
        0,
        "inner non-bubbling scroll is captured and dismisses the tip",
      );
      const darkBefore = await page
        .locator("html")
        .evaluate((node) => node.classList.contains("dark"));
      await page.getByRole("button", { name: "Toggle theme" }).click();
      assert.notEqual(
        await page.locator("html").evaluate((node) => node.classList.contains("dark")),
        darkBefore,
      );
      await page.reload();
      assert.notEqual(
        await page.locator("html").evaluate((node) => node.classList.contains("dark")),
        darkBefore,
        "theme persists",
      );
      await page.goto(origin + "/");
      await noOverflow(page);
      assert.deepEqual(errors, []);
      assert.deepEqual(externalRequests, [], "observer-only browser makes no GitHub/API requests");
      results.push({ width, theme, geometry, result: "passed", errors, externalRequests });
      await context.tracing.stop({ path: join(out, width + "-" + theme + "-trace.zip") });
      await context.close();
    }
  await writeFile(
    join(out, "results.json"),
    JSON.stringify({ browser: browser.version(), results }, null, 2) + "\n",
  );
  console.log("Mobile triage browser checks: " + results.length + " scenarios passed");
} finally {
  await browser.close();
  server.close();
}
