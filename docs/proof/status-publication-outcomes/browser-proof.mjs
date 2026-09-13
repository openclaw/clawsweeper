import assert from "node:assert/strict";
import path from "node:path";
import { chromium } from "playwright-core";

export async function proveBrowser(origin, revision, artifacts, now) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  try {
    for (const [viewportName, viewport] of [
      ["desktop", { width: 1440, height: 1000 }],
      ["mobile", { width: 390, height: 844 }],
    ]) {
      for (const kind of [
        "observed",
        "captured",
        "idle",
        "mixed",
        "mixed-batch",
        "unknown",
        "missing",
        "null",
        "lossy",
      ]) {
        for (const flow of kind === "observed"
          ? ["corrected-input", "worker-route"]
          : ["corrected-input"]) {
          await post("/__proof/seed", {
            mode: flow === "worker-route" ? "fresh" : "browser",
            kind,
            now,
          });
          const context = await browser.newContext({ viewport });
          const denied = [];
          const errors = [];
          await context.route("**/*", async (route) => {
            const request = route.request();
            if (new URL(request.url()).origin !== origin || request.method() !== "GET") {
              denied.push(new URL(request.url()).protocol);
              return route.abort();
            }
            return route.continue();
          });
          const page = await context.newPage();
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(origin, { waitUntil: "domcontentloaded" });
          const target = page.locator("#recent-durable-publication-events");
          await target.locator(".handoff-phase strong").first().waitFor();
          const beforeReload = await readDisplay(page);
          const isCandidate = revision === "candidate";
          const expected = expectedDisplay(kind);
          if (isCandidate)
            assert.deepEqual(beforeReload, expected, `${viewportName}/${kind}/${flow}`);
          else {
            assert.deepEqual(beforeReload.counts, ["unknown", "unknown"]);
            assert.equal(
              beforeReload.window,
              "Trailing unknown window; publication attempts only.",
            );
          }
          const stored = await page.evaluate(() => localStorage.getItem("clawsweeper:last-status"));
          assert.ok(stored, "successful status fetch must be persisted");
          assert.equal(stored.includes("withheld-publication-identity"), false);
          const storedProjection = JSON.parse(stored).recent_durable_publication_events;
          if (isCandidate) {
            assert.deepEqual(
              await page.evaluate(
                () =>
                  dashboardStatusSnapshot(
                    dashboardStatusSnapshot(
                      JSON.parse(localStorage.getItem("clawsweeper:last-status")),
                    ),
                  ).recent_durable_publication_events,
              ),
              storedProjection,
            );
          }
          await post("/__proof/status-offline");
          await page.reload({ waitUntil: "domcontentloaded" });
          await page.waitForFunction(() =>
            document.getElementById("updated").textContent.includes("showing last good status"),
          );
          assert.deepEqual(
            await readDisplay(page),
            beforeReload,
            "offline reload must retain display values",
          );
          assert.match(await page.locator("#updated").textContent(), /showing last good status/);
          assert.equal(
            (await page.evaluate(() => localStorage.getItem("clawsweeper:last-status"))).includes(
              "withheld-publication-identity",
            ),
            false,
          );
          assert.deepEqual(errors, [], "served scripts must execute without browser errors");
          let screenshot = null;
          if ((kind === "observed" && flow === "worker-route") || kind === "lossy") {
            await target.scrollIntoViewIfNeeded();
            screenshot = `${revision}-${viewportName}-${kind}.png`;
            await page.screenshot({ path: path.join(artifacts, screenshot) });
            const bounds = await target.boundingBox();
            assert.ok(bounds && bounds.width > 0 && bounds.height > 0);
            assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= viewport.width + 1);
          }
          results.push({
            revision,
            viewport: viewportName,
            kind,
            flow,
            display: beforeReload,
            offline_reload: "identical",
            script_errors: errors.length,
            external_browser_requests_denied: denied.length,
            screenshot,
          });
          await context.close();
        }
      }

      // Reproduce the observed legacy cache directly, before any repaired Worker response.
      await post("/__proof/seed", { mode: "browser", kind: "lossy", now, offline: true });
      const cached = await (await fetch(origin + "/__proof/browser-snapshot")).json();
      const context = await browser.newContext({ viewport });
      await context.route("**/*", (route) =>
        new URL(route.request().url()).origin === origin && route.request().method() === "GET"
          ? route.continue()
          : route.abort(),
      );
      await context.addInitScript((snapshot) => {
        localStorage.setItem("clawsweeper:last-status", JSON.stringify(snapshot));
      }, cached);
      const page = await context.newPage();
      await page.goto(origin, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() =>
        document.getElementById("updated").textContent.includes("showing last good status"),
      );
      const display = await readDisplay(page);
      if (revision === "candidate") assert.deepEqual(display, expectedDisplay("lossy"));
      else
        assert.equal(display.state, "complete", "baseline exposes the misleading complete badge");
      const stored = await page.evaluate(() => localStorage.getItem("clawsweeper:last-status"));
      assert.equal(stored.includes("withheld-publication-identity"), false);
      results.push({
        revision,
        viewport: viewportName,
        kind: "legacy-cache",
        flow: "offline-localStorage",
        display,
      });
      await context.close();
    }
    return { browser: browser.version(), results };
  } finally {
    await browser.close();
  }

  async function post(route, body) {
    const response = await fetch(origin + route, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    });
    assert.equal(response.status, 200);
  }
}

async function readDisplay(page) {
  const target = page.locator("#recent-durable-publication-events");
  return {
    counts: await target.locator(".handoff-phase strong").allTextContents(),
    state: await target.locator(".health-badge").textContent(),
    window: await target.locator(".exact-handoff-title span").textContent(),
  };
}

function expectedDisplay(kind) {
  if (kind === "captured")
    return {
      counts: ["584", "20"],
      state: "complete",
      window: "Trailing 6h window; publication attempts only.",
    };
  const missing = kind === "missing" || kind === "null";
  const unknown = missing || kind === "unknown" || kind === "lossy";
  return {
    counts: unknown
      ? ["unknown", "unknown"]
      : kind === "idle"
        ? ["0", "0"]
        : kind === "mixed"
          ? ["1", "unknown"]
          : kind === "mixed-batch"
            ? ["unknown", "1"]
            : ["1", "1"],
    state: unknown ? "unknown" : kind.startsWith("mixed") ? "mixed" : "complete",
    window: `Trailing ${missing ? "unknown" : "24h"} window; publication attempts only.`,
  };
}
