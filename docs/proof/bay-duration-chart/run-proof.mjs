import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { chromium } from "playwright-core";
import { bayHtml } from "../../../dashboard/bay-page.ts";

const output = ".artifacts/bay-duration-chart/browser";
await mkdir(output, { recursive: true });
const at = Date.parse("2026-09-07T18:12:32Z");
const stageNames = ["arriving", "setting-up", "reviewing", "publishing", "applying", "repairing"];
const zeroStages = Object.fromEntries(stageNames.map((stage) => [stage, 0]));
function point(time, median = 120000, average = 180000, samples = 3) {
  return { ended_at: "2026-09-07T" + time + "Z", median_ms: median, average_ms: average, samples };
}
const sparse = [
  point("17:20:00"),
  point("17:25:00", 240000),
  point("18:10:00", 0, 30000),
  point("18:15:00", 60000),
];
let points = sparse;
let freshnessState = "fresh";
let metricsState = "complete";
let snapshotAt = at;
let timingEndedAt = at;
let failStatusTransport = false;
function timing(rows, legacy = false) {
  return {
    overall: {
      samples: rows.reduce((sum, row) => sum + row.samples, 0),
      average_ms: rows.length ? (legacy ? 360000 : 180000) : null,
      median_ms: rows.length ? (legacy ? 300000 : 120000) : null,
    },
    history: { bucket_minutes: 5, points: rows },
  };
}
function status() {
  const legacy = points.map((p) => ({
    ...p,
    median_ms: p.median_ms + 120000,
    average_ms: p.average_ms + 120000,
  }));
  const lane = { pending: 0, capacity: 24, active: 0 };
  return {
    public_projection_complete: true,
    generated_at: new Date(snapshotAt).toISOString(),
    freshness: {
      state: freshnessState,
      generated_at: freshnessState === "unavailable" ? null : new Date(snapshotAt).toISOString(),
      age_ms: 0,
      maximum_age_ms: 60000,
      cache_state: "fresh",
    },
    health: { sampled_runs: 0 },
    diagnostics: { error_count: 0 },
    exact_review_queue: {
      collection: { state: "complete" },
      bay_projection: {
        complete: true,
        sample_limit: 24,
        total: 2,
        stages: { ...zeroStages, arriving: 2 },
        legacy_batch_stages: zeroStages,
        activity: {
          complete: true,
          queue_stages: { ...zeroStages, arriving: 2 },
          live_stages: zeroStages,
          queue_legacy_batch_stages: zeroStages,
          live_legacy_batch_stages: zeroStages,
          total: 2,
          items: ["openclaw/openclaw", "openclaw/clawsweeper"].map((repository, index) => ({
            repository,
            item_number: 100 + index,
            stage: "arriving",
            source: "queue",
            legacy_batch_path: false,
          })),
        },
      },
      lanes: { review: { ...lane, pending: 2 }, publication: lane },
      handoff_health: {
        status: "healthy",
        reason: "handoff_current",
        phases: {
          pending: { count: 2, oldest_age_seconds: 3 },
          dispatching: { count: 0, oldest_age_seconds: null },
          leased: { count: 0, oldest_age_seconds: null },
        },
        recovery_reasons: {
          claim_timeout: 0,
          execution_timeout: 0,
          workflow_cancelled: 0,
          workflow_failed: 0,
        },
      },
    },
    bay: {
      metrics_state: metricsState,
      timing_coverage_complete: metricsState === "complete",
      tide_generation: 0,
      tide_threshold: 20,
      terminal_count: 0,
      terminal_buffer: [],
      recently_washed: [],
      last_tide_at: null,
      washed_at: null,
      timings: {
        window_ended_at: timingEndedAt === null ? null : new Date(timingEndedAt).toISOString(),
        window_minutes: 60,
        ...timing(points),
        including_legacy_batch: timing(legacy, true),
      },
    },
  };
}
function lifecycle() {
  return {
    durable_lifecycle_bay: {
      version: 1,
      source: "exact-review-lifecycle-projection-v1",
      generated_at: new Date(at).toISOString(),
      freshness: { maximum_age_ms: 60000 },
      collection: { state: "complete" },
      inventory: { lifecycle_records: 100, target_revisions: 60, unique_targets: 20 },
      lanes: {
        pending: 35,
        acknowledgement_pending: 1,
        completed: 40,
        superseded: 10,
        requeued: 10,
        terminal_attention: 4,
      },
      sample: {
        limit: 24,
        returned: 2,
        omitted: 98,
        cards: [true, false].map((current_revision) => ({
          repository: "openclaw/openclaw",
          item_number: 100,
          lane: "pending",
          state: "pending",
          current_revision,
          updated_at: "2026-08-03T00:00:00.000Z",
        })),
      },
    },
  };
}
const html = bayHtml();
const requests = [];
let statusReads = 0;
const server = createServer((request, response) => {
  requests.push({ method: request.method, path: request.url });
  if (request.method !== "GET") {
    response.writeHead(405).end();
    return;
  }
  if (request.url === "/bay") {
    response.setHeader("content-type", "text/html");
    response.end(html);
    return;
  }
  response.setHeader("content-type", "application/json");
  if (request.url === "/api/status") {
    statusReads++;
    if (failStatusTransport) { response.destroy();return; }
    response.end(JSON.stringify(status()));
    return;
  }
  if (request.url === "/api/durable-lifecycle-bay") {
    response.end(JSON.stringify(lifecycle()));
    return;
  }
  // Other dashboard read surfaces are deliberately unavailable in this narrow proof.
  response.writeHead(404).end("{}");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  hasTouch: true,
  reducedMotion: "reduce",
  locale: "en-US",
});
await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
const blocked = [],
  errors = [],
  checks = [];
await context.route("**/*", (route) => {
  if (new URL(route.request().url()).origin !== origin) {
    blocked.push(route.request().url());
    return route.abort();
  }
  return route.continue();
});
const page = await context.newPage();
page.on("pageerror", (error) => errors.push(error.message));
await page.clock.install({ time: at });
await page.clock.pauseAt(at);
async function check(name, fn) {
  await fn();
  checks.push(name);
}
async function refresh() {
  const before = statusReads;
  const response = page.waitForResponse((response) => response.url() === origin + "/api/status");
  await page.clock.runFor(20000);
  await (await response).finished();
  for (let n = 0; n < 100 && statusReads <= before; n++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(statusReads > before);
  await page.waitForTimeout(50);
}
try {
  await page.goto(origin + "/bay");
  await page.waitForSelector(".journey-chart");
  const plot = page.locator(".journey-plot");
  const tooltip = page.locator("#journey-tooltip");
  async function hoverBucket(bucket, fraction = 0.5) {
    const r = await bucket.boundingBox();
    await page.mouse.move(r.x + Math.max(0.1, r.width * fraction), r.y + r.height / 2);
  }
  async function tapBucket(bucket) {
    const r = await bucket.boundingBox();
    await page.touchscreen.tap(r.x + r.width / 2, r.y + r.height / 2);
  }
  async function containedTooltip() {
    const r = await tooltip.boundingBox();
    const viewport = page.viewportSize();
    assert.ok(r && r.x >= 0 && r.y >= 0 && r.x + r.width <= viewport.width + 1 && r.y + r.height <= viewport.height + 1, JSON.stringify(r));
  }
  await check("fixed rolling hour, readable axes and partial/missing bucket geometry", async () => {
    assert.equal(await page.locator(".journey-chart").getAttribute("data-window-start"), "2026-09-07T17:12:32.000Z");
    assert.equal(await page.locator(".journey-chart").getAttribute("data-window-end"), "2026-09-07T18:12:32.000Z");
    assert.deepEqual(await page.locator(".journey-y-axis span").allTextContents(), ["4", "2", "0"]);
    assert.equal(await page.locator(".journey-bucket").count(), 13);
    assert.equal(await page.locator(".journey-bucket.missing").count(), 9);
    assert.equal((await page.locator(".journey-timing-chart .line").getAttribute("d")).match(/M/g).length, 2);
    assert.match(await page.locator(".journey-bucket").last().getAttribute("data-journey-description"), /18:10:00–18:12:32 UTC \(partial bucket\)/);
  });
  const populated = page.locator(".journey-bucket:not(.missing)").first();
  await check("chart dropdown and permanent detail row are gone; cohort selector remains", async () => {
    assert.equal(await page.locator("#journey-interval-select,.journey-interval-choice,#journey-bucket-detail,.journey-bucket-detail").count(), 0);
    assert.equal(await page.locator(".journey-chart select,.journey-bucket[tabindex],button.journey-bucket").count(), 0);
    assert.equal(await page.locator("#inline-proof-filter").count(), 1);
    assert.equal(await plot.getAttribute("role"), "slider");
    assert.equal(await plot.getAttribute("tabindex"), "0");
    assert.equal(await tooltip.isVisible(), false);
  });
  await check("hover and scrubbing expose compact equivalent details; tooltip is hoverable and Escape-dismissable", async () => {
    for (const fraction of [0.08, 0.92]) {
      await hoverBucket(populated, fraction);
      assert.match(await tooltip.textContent(), /17:15:00–17:20:00 UTC · median 2 min · mean 3 min · 3 samples/);
      assert.equal(await tooltip.isVisible(), true);
      assert.equal(await page.locator(".journey-bucket.selected").count(), 1);
    }
    await containedTooltip();
    const r = await tooltip.boundingBox();
    await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
    await page.clock.runFor(300);
    assert.equal(await tooltip.isVisible(), true);
    await page.keyboard.press("Escape");
    assert.equal(await tooltip.isVisible(), false);
    await page.mouse.move(1, 1);await hoverBucket(populated);
    assert.equal(await tooltip.isVisible(), true);
  });
  await page.screenshot({ path: output + "/desktop.png", fullPage: true });
  await page.screenshot({ path: output + "/chart-desktop.png" });
  await check("one large keyboard surface supports arrows/Home/End and preserves DOM focus and bucket identity on refresh", async () => {
    await plot.focus();await page.keyboard.press("Home");
    assert.equal(await plot.getAttribute("aria-valuenow"), "0");
    assert.match(await plot.getAttribute("aria-valuetext"), /partial bucket.*No bucket data/);
    await page.keyboard.press("ArrowRight");
    assert.match(await tooltip.textContent(), /median 2 min/);
    await page.keyboard.press("ArrowRight");
    assert.match(await tooltip.textContent(), /median 4 min/);
    await page.keyboard.press("ArrowLeft");
    const key = await plot.getAttribute("data-journey-bucket");
    await plot.evaluate((node) => { window.proofPlotNode = node; });
    await refresh();
    assert.equal(await plot.evaluate((node) => node === window.proofPlotNode && document.activeElement === node), true);
    assert.equal(await plot.getAttribute("data-journey-bucket"), key);
    assert.equal(await plot.getAttribute("aria-valuetext"), await tooltip.textContent());
    await page.keyboard.press("End");
    assert.equal(await plot.getAttribute("aria-valuenow"), "12");
    assert.match(await tooltip.textContent(), /18:10:00–18:12:32 UTC/);
    await page.keyboard.press("Escape");assert.equal(await tooltip.isVisible(), false);
    await refresh();assert.equal(await tooltip.isVisible(), false);
    assert.equal(await plot.evaluate((node) => document.activeElement === node), true);
  });
  await check("pending hover dismissal cannot hide keyboard details; leaving focus dismisses", async () => {
    await plot.press("Tab");await hoverBucket(populated);await page.mouse.move(1, 1);
    await plot.focus();await page.clock.runFor(250);
    assert.equal(await tooltip.isVisible(), true);
    await plot.press("Tab");await page.clock.runFor(250);
    assert.equal(await tooltip.isVisible(), false);
  });
  await check("missing data stays unavailable and a real zero stays a sample", async () => {
    await plot.press("Home");assert.match(await tooltip.textContent(), /No bucket data.*samples unavailable/);
    await hoverBucket(page.locator('.journey-bucket[data-journey-description*="median 0 min"]'));
    assert.match(await tooltip.textContent(), /median 0 min · mean 0.5 min · 3 samples/);
  });
  await page.clock.setSystemTime(at);
  await check("retained lifecycle remains collapsed and keeps records distinct", async () => {
    const details = page.locator("#bay-lifecycle-details");
    assert.equal(await details.getAttribute("open"), null);
    await details.locator("summary").focus();await page.keyboard.press("Enter");
    await page.waitForSelector(".lane-summary");
    assert.equal(await page.locator(".lane-summary").textContent(), "100 records · 60 target revisions · 20 unique targets");
    assert.deepEqual(await page.locator(".lane-count").allTextContents(), ["35", "1", "40", "10", "10", "4"]);
    assert.equal(await page.locator(".lane-card").count(), 2);
    assert.equal(await page.locator(".tag.current").count(), 1);
  });
  await check("legacy and repository filters remain independent from lifecycle inventory", async () => {
    const before = await page.locator("#durable-lifecycle-kanban").innerHTML();
    await page.locator('[data-repo="openclaw/clawsweeper"]').click();
    await page.locator("#legacy-proof-toggle").click();
    assert.equal(await page.locator("#legacy-proof-toggle").getAttribute("aria-pressed"), "true");
    assert.match(await page.locator("#overall-average .stat-sub").textContent(), /incl. retired proof\/batch/);
    assert.equal(await page.locator("#durable-lifecycle-kanban").innerHTML(), before);
    await page.locator("#legacy-proof-toggle").click();
  });
  await check("mobile touch target and floating tooltip fit; tap and drag scrub equivalent details", async () => {
    await page.setViewportSize({ width: 360, height: 800 });
    await plot.scrollIntoViewIfNeeded();
    const r = await plot.boundingBox();assert.ok(r.width >= 44 && r.height >= 44);
    assert.equal(await plot.evaluate((node) => getComputedStyle(node).touchAction), "pan-y");
    const cohortBox = await page.locator("#inline-proof-filter").boundingBox();
    assert.ok(cohortBox.height >= 44 && cohortBox.width >= 44 && cohortBox.x >= 0 && cohortBox.x + cohortBox.width <= 360, JSON.stringify(cohortBox));
    const geometry = await page.locator(".journey-chart").evaluate((chart) => {
      const outer = chart.getBoundingClientRect();
      return { left: outer.left, right: outer.right, overflow: [...chart.querySelectorAll(".journey-x-axis span,.journey-bucket")].some((node) => { const b = node.getBoundingClientRect();return b.left < outer.left - 1 || b.right > outer.right + 1; }) };
    });
    assert.ok(geometry.left >= 0 && geometry.right <= 360 && !geometry.overflow, JSON.stringify(geometry));
    await tapBucket(populated);assert.match(await tooltip.textContent(), /median 2 min/);await containedTooltip();
    const cdp = await context.newCDPSession(page);
    const first = await populated.boundingBox(), last = await page.locator(".journey-bucket").last().boundingBox();
    const y = first.y + first.height / 2, x = first.x + first.width / 2;
    await plot.evaluate((node) => { window.proofPlotNode = node;node.addEventListener("pointerdown", (event) => { window.proofPointer = event.pointerId; }, { once: true }); });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    const key = await plot.getAttribute("data-journey-bucket");
    points = sparse.map((p, i) => i === 0 ? { ...p, median_ms: 540000 } : p);
    await refresh();
    assert.equal(await plot.evaluate((node) => node === window.proofPlotNode && document.activeElement === node && node.hasPointerCapture(window.proofPointer)), true);
    assert.equal(await plot.getAttribute("data-journey-bucket"), key);
    assert.match(await tooltip.textContent(), /median 9 min/);
    for (let step = 1; step <= 5; step++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + (last.x + last.width / 2 - x) * step / 5, y }] });
      // Native pointer events may be frame-coalesced; inspect after their frame settles.
      await page.waitForTimeout(25);
    }
    assert.match(await tooltip.textContent(), /18:10:00–18:12:32 UTC/);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.detach();await containedTooltip();
    await page.screenshot({ path: output + "/mobile.png", fullPage: true });
    await page.screenshot({ path: output + "/chart-mobile.png" });
    await plot.press("Escape");assert.equal(await tooltip.isVisible(), false);
    await tapBucket(populated);assert.equal(await tooltip.isVisible(), true);
    points = sparse;
  });
  await check("rolling refresh preserves the navigation node and clamps an aged-out logical interval", async () => {
    await plot.focus();await plot.press("Home");
    const oldKey = await plot.getAttribute("data-journey-bucket");
    timingEndedAt = at + 5 * 60000;snapshotAt = timingEndedAt;
    await refresh();
    assert.equal(await plot.evaluate((node) => node === window.proofPlotNode && document.activeElement === node), true);
    assert.notEqual(await plot.getAttribute("data-journey-bucket"), oldKey);
    assert.equal(await plot.getAttribute("aria-valuenow"), "0");
    assert.match(await tooltip.textContent(), /17:17:32–17:20:00 UTC/);
    timingEndedAt = at;snapshotAt = at;
  });
  await check("unavailable refresh immediately removes stale interaction and moves focus to status", async () => {
    metricsState = "unavailable";await refresh();
    assert.equal(await page.locator(".journey-chart,#journey-tooltip").count(), 0);
    assert.equal(await page.locator(":focus").getAttribute("id"), "overall-average");
    assert.match(await page.locator("#overall-average .stat-value").textContent(), /Unavailable/);
    metricsState = "complete";await refresh();
    assert.equal(await page.locator("#inline-proof-filter").count(), 1);
  });
  await check("transport failure removes stale tooltip/chart and retains safe focus", async () => {
    await plot.focus();await plot.press("Home");
    failStatusTransport = true;
    const failedRequest = page.waitForEvent("requestfailed", (request) => request.url() === origin + "/api/status");
    await page.clock.runFor(20000);await failedRequest;await page.waitForTimeout(50);
    assert.equal(await page.locator(".journey-chart,#journey-tooltip").count(), 0);
    assert.equal(await page.locator(":focus").getAttribute("id"), "overall-average");
    assert.match(await page.locator("#overall-average .stat-value").textContent(), /Unavailable/);
    failStatusTransport = false;await refresh();
  });
  await check("single and empty histories retain the hour with no invented observations", async () => {
    points = [point("18:10:00")];await refresh();
    assert.equal(await page.locator(".journey-timing-chart .dot").count(), 1);
    points = [];await refresh();
    assert.equal(await page.locator(".journey-timing-chart .dot").count(), 0);
    assert.match(await page.locator("#overall-average .stat-value").textContent(), /No completed reviews/);
    assert.equal(await page.locator(".journey-bucket.missing").count(), 13);
    await plot.focus();await plot.press("Home");assert.match(await tooltip.textContent(), /samples unavailable/);
  });
  await check("stale and browser-clock-skewed windows remain bound to the query cutoff", async () => {
    freshnessState = "stale";await page.clock.setSystemTime(at + 2 * 3600000);await refresh();
    assert.equal(await page.locator(".journey-chart").getAttribute("data-window-end"), "2026-09-07T18:12:32.000Z");
    assert.equal(await page.locator(".journey-chart").getAttribute("data-window-start"), "2026-09-07T17:12:32.000Z");
    assert.match(await page.locator(".journey-chart-note").textContent(), /stale/);
    assert.match(await page.locator("#overall-average .stat-label").textContent(), /snapshot hour/);
    assert.match(await tooltip.textContent(), /Stale snapshot/);
  });
  await check("live-region identity survives refresh and missing source clock fails closed", async () => {
    await page.locator(".journey-summary").evaluate((node) => { window.proofSummaryNode = node; });
    freshnessState = "unavailable";timingEndedAt = null;await refresh();
    assert.equal(await page.locator(".journey-summary").evaluate((node) => node === window.proofSummaryNode), true);
    assert.equal(await page.locator(".journey-summary").getAttribute("aria-live"), "polite");
    assert.equal(await page.locator(".journey-summary").getAttribute("aria-atomic"), "true");
    assert.equal(await page.locator(".journey-chart,#journey-tooltip").count(), 0);
    assert.match(await page.locator(".journey-chart-note").textContent(), /snapshot time missing/);
  });
  await check("delayed status collection cannot replace the later timing query boundary", async () => {
    freshnessState = "stale";snapshotAt = at - 5 * 60000;timingEndedAt = at;points = sparse;await refresh();
    assert.equal(await page.locator(".journey-chart").getAttribute("data-window-end"), new Date(at).toISOString());
    assert.equal(await page.locator(".journey-timing-chart .dot").count(), 4);
    assert.match(await page.locator(".journey-bucket").last().getAttribute("data-journey-description"), /18:10:00–18:12:32 UTC/);
  });
  assert.deepEqual(errors, []);
  assert.ok(requests.every((request) => request.method === "GET"));
  assert.ok(!blocked.some((url) => /github\.com|api\.github/.test(url)));

} finally {
  await context.tracing.stop({ path: output + "/trace.zip" });
  await writeFile(
    output + "/summary.json",
    JSON.stringify(
      {
        checks,
        errors,
        requests,
        blockedExternalRequests: blocked,
        sourceSha: process.env.SOURCE_SHA || "unknown",
        pageSha256: createHash("sha256").update(html).digest("hex"),
        browser: browser.version(),
        node: process.version,
        limits:
          "Production HTML/CSS/script with controlled same-origin API data; unrelated APIs/assets return 404, external fonts blocked; no live backend or modern proof telemetry claim.",
      },
      null,
      2,
    ),
  );
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
console.log(JSON.stringify({ passed: checks.length, checks, output }));
