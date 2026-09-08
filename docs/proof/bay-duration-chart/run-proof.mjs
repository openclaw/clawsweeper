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
  await check("fixed rolling hour, readable minute ticks and partial bucket", async () => {
    const chart = page.locator(".journey-chart");
    assert.equal(await chart.getAttribute("data-window-start"), "2026-09-07T17:12:32.000Z");
    assert.equal(await chart.getAttribute("data-window-end"), "2026-09-07T18:12:32.000Z");
    assert.deepEqual(await page.locator(".journey-y-axis span").allTextContents(), ["4", "2", "0"]);
    assert.equal(await page.locator(".journey-bucket").count(), 13);
    assert.equal(await page.locator(".journey-bucket.missing").count(), 9);
    assert.equal(
      (await page.locator(".journey-timing-chart .line").getAttribute("d")).match(/M/g).length,
      2,
    );
    assert.match(
      await page.locator(".journey-bucket").last().getAttribute("aria-label"),
      /18:10:00–18:12:32 UTC \(partial bucket\)/,
    );
  });
  const populated = page.locator(".journey-bucket:not(.missing)").first();
  await check(
    "pointer anywhere in the bucket reveals exact interval/median/mean/count",
    async () => {
      const box = await populated.boundingBox();
      for (const x of [box.x + 1, box.x + box.width - 1]) {
        await page.mouse.move(x, box.y + 3);
        assert.match(
          await page.locator("#journey-bucket-detail").textContent(),
          /17:15:00–17:20:00 UTC · median 2 min · mean 3 min · 3 samples/,
        );
      }
    },
  );
  await page.screenshot({ path: output + "/desktop.png", fullPage: true });
  await page.locator("#overall-average").screenshot({ path: output + "/chart-desktop.png" });
  await check(
    "keyboard focus and native activation preserve equivalent bucket detail",
    async () => {
      await populated.focus();
      await page.keyboard.press("Enter");
      assert.match(await page.locator("#journey-bucket-detail").textContent(), /median 2 min/);
      await page.keyboard.press("Tab");
      assert.match(await page.locator("#journey-bucket-detail").textContent(), /median 4 min/);
      const key = await page.locator(":focus").getAttribute("data-journey-bucket");
      await refresh();
      assert.equal(await page.locator(":focus").getAttribute("data-journey-bucket"), key);
    },
  );
  await check("missing data is not reported as zero and real zero stays a sample", async () => {
    await page.locator(".journey-bucket.missing").nth(2).click();
    assert.match(
      await page.locator("#journey-bucket-detail").textContent(),
      /No bucket data.*samples unavailable/,
    );
    await page.locator('.journey-bucket[aria-label*="median 0 min"]').click();
    assert.match(
      await page.locator("#journey-bucket-detail").textContent(),
      /median 0 min · mean 0.5 min · 3 samples/,
    );
  });
  await check(
    "lifecycle starts collapsed, opens with keyboard and keeps records distinct",
    async () => {
      const details = page.locator("#bay-lifecycle-details");
      assert.equal(await details.getAttribute("open"), null);
      await details.locator("summary").focus();
      await page.keyboard.press("Enter");
      await page.waitForSelector(".lane-summary");
      assert.equal(
        await page.locator(".lane-summary").textContent(),
        "100 records · 60 target revisions · 20 unique targets",
      );
      assert.deepEqual(await page.locator(".lane-count").allTextContents(), [
        "35",
        "1",
        "40",
        "10",
        "10",
        "4",
      ]);
      assert.equal(await page.locator(".lane-card").count(), 2);
      assert.equal(await page.locator(".tag.current").count(), 1);
      await page.screenshot({ path: output + "/lifecycle.png", fullPage: true });
    },
  );
  await check("legacy and repository filters do not alter lifecycle inventory", async () => {
    const before = await page.locator("#durable-lifecycle-kanban").innerHTML();
    await page.locator('[data-repo="openclaw/clawsweeper"]').click();
    await page.locator("#legacy-proof-toggle").click();
    assert.equal(await page.locator("#legacy-proof-toggle").getAttribute("aria-pressed"), "true");
    assert.match(
      await page.locator("#overall-average .stat-sub").textContent(),
      /incl. retired proof\/batch/,
    );
    assert.equal(await page.locator("#durable-lifecycle-kanban").innerHTML(), before);
    await page.locator("#legacy-proof-toggle").click();
    assert.equal(await page.locator("#legacy-proof-toggle").getAttribute("aria-pressed"), "false");
  });
  await check(
    "responsive plot/labels remain contained and touch activates whole bucket",
    async () => {
      await page.setViewportSize({ width: 360, height: 800 });
      await page.locator("#overall-average").scrollIntoViewIfNeeded();
      const geometry = await page.locator(".journey-chart").evaluate((chart) => {
        const outer = chart.getBoundingClientRect();
        return {
          right: outer.right,
          left: outer.left,
          overflow: [...chart.querySelectorAll(".journey-x-axis span,.journey-bucket")].some(
            (node) => {
              const r = node.getBoundingClientRect();
              return r.right > outer.right + 1 || r.left < outer.left - 1;
            },
          ),
        };
      });
      assert.ok(
        geometry.left >= 0 && geometry.right <= 360 && !geometry.overflow,
        JSON.stringify(geometry),
      );
      const picker = page.locator("#journey-interval-select");
      const pickerBox = await picker.boundingBox();
      assert.ok(pickerBox.width >= 44 && pickerBox.height >= 44);
      assert.equal(await picker.locator("option").count(), 14);
      await picker.tap();
      await page.keyboard.press("Escape");
      const missingKey = await page
        .locator(".journey-bucket.missing")
        .nth(2)
        .getAttribute("data-journey-bucket");
      await picker.selectOption(missingKey);
      assert.match(await page.locator("#journey-bucket-detail").textContent(), /No bucket data/);
      const populatedKey = await page
        .locator(".journey-bucket:not(.missing)")
        .first()
        .getAttribute("data-journey-bucket");
      await picker.selectOption(populatedKey);
      assert.match(await page.locator("#journey-bucket-detail").textContent(), /median 2 min/);
      await picker.focus();
      await picker.evaluate((node) => {
        window.proofPickerNode = node;
      });
      await refresh();
      assert.equal(await picker.evaluate((node) => node === window.proofPickerNode), true);
      metricsState = "unavailable";
      await refresh();
      assert.equal(await picker.evaluate((node) => node === window.proofPickerNode), true);
      assert.match(
        await page.locator("#overall-average .stat-label").textContent(),
        /Prior snapshot.*unavailable/,
      );
      await picker.press("Tab");
      await page.waitForTimeout(50);
      assert.equal(await page.locator(".journey-chart").count(), 0);
      assert.match(await page.locator("#overall-average .stat-value").textContent(), /Unavailable/);
      metricsState = "complete";
      await refresh();
      const button = page.locator(".journey-bucket:not(.missing)").first();
      await button.tap();
      assert.match(await page.locator("#journey-bucket-detail").textContent(), /median 2 min/);
      await page.screenshot({ path: output + "/mobile.png", fullPage: true });
      await page.locator("#overall-average").screenshot({ path: output + "/chart-mobile.png" });
      await page.locator("#bay-lifecycle-details summary").tap();
      assert.equal(await page.locator("#bay-lifecycle-details").getAttribute("open"), null);
    },
  );
  await check(
    "single and empty histories keep the full hour and no invented observations",
    async () => {
      points = [point("18:10:00")];
      await refresh();
      await page.waitForFunction(
        () => document.querySelectorAll(".journey-timing-chart .dot").length === 1,
      );
      points = [];
      await refresh();
      await page.waitForFunction(
        () => document.querySelectorAll(".journey-timing-chart .dot").length === 0,
      );
      assert.match(
        await page.locator("#overall-average .stat-value").textContent(),
        /No completed reviews/,
      );
      assert.equal(await page.locator(".journey-bucket").count(), 13);
      assert.equal(await page.locator(".journey-bucket.missing").count(), 13);
    },
  );
  await check("server snapshot anchors stale and browser-clock-skewed windows", async () => {
    freshnessState = "stale";
    await page.clock.setSystemTime(at + 2 * 3600000);
    await refresh();
    assert.equal(
      await page.locator(".journey-chart").getAttribute("data-window-end"),
      "2026-09-07T18:12:32.000Z",
    );
    assert.equal(
      await page.locator(".journey-chart").getAttribute("data-window-start"),
      "2026-09-07T17:12:32.000Z",
    );
    assert.match(await page.locator(".journey-chart-note").textContent(), /stale/);
    assert.match(await page.locator("#overall-average .stat-label").textContent(), /snapshot hour/);
  });
  await check(
    "timing announcements retain their live-region node and missing clock fails closed",
    async () => {
      await page.locator(".journey-summary").evaluate((node) => {
        window.proofSummaryNode = node;
      });
      freshnessState = "unavailable";
      timingEndedAt = null;
      await refresh();
      assert.equal(
        await page.locator(".journey-summary").evaluate((node) => node === window.proofSummaryNode),
        true,
      );
      assert.equal(await page.locator(".journey-summary").getAttribute("aria-live"), "polite");
      assert.equal(await page.locator(".journey-summary").getAttribute("aria-atomic"), "true");
      assert.equal(await page.locator(".journey-chart").count(), 0);
      assert.match(
        await page.locator(".journey-chart-note").textContent(),
        /snapshot time missing/,
      );
    },
  );
  await check("delayed status collection uses the later timing query boundary", async () => {
    freshnessState = "stale";
    snapshotAt = at - 5 * 60000;
    timingEndedAt = at;
    points = sparse;
    await refresh();
    assert.equal(
      await page.locator(".journey-chart").getAttribute("data-window-end"),
      new Date(at).toISOString(),
    );
    assert.equal(await page.locator(".journey-timing-chart .dot").count(), 4);
    assert.match(
      await page.locator(".journey-bucket").last().getAttribute("aria-label"),
      /18:10:00–18:12:32 UTC/,
    );
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
