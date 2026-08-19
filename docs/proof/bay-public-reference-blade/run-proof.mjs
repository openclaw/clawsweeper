import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const playwrightModule = process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium } = await import(playwrightModule);

const outputDir = path.resolve(
  process.env.BLADE_PROOF_OUTPUT || ".artifacts/bay-public-reference-blade",
);
const sourceSha = process.env.SOURCE_SHA || "dirty";
const port = Number(process.env.BLADE_PROOF_PORT || 8787);
const origin = `http://blade-proof.test:${port}`;
const privateMarker = "SYNTHETIC_PRIVATE_BLADE_FIELD";
const stages = ["arriving", "setting-up", "reviewing", "publishing", "applying", "repairing"];
const emptyStages = () => Object.fromEntries(stages.map((stage) => [stage, 0]));

await mkdir(outputDir, { recursive: true });

let referenceStage = "reviewing";
let referenceSource = "queue";

function statusFixture() {
  const queueStages = emptyStages();
  const liveStages = emptyStages();
  (referenceSource === "queue" ? queueStages : liveStages)[referenceStage] = 1;
  return {
    schema_version: 1,
    public_projection_complete: true,
    generated_at: "2026-08-16T16:00:00.000Z",
    source: { target_repository_count: 2 },
    diagnostics: { errors: [], error_count: 0 },
    health: {
      attempts: 0,
      error_rate_percent: 0,
      failed_attempts: 0,
      failures: [],
      recovered_failures: 0,
      recovery_rate_percent: 100,
      sampled_runs: 0,
      unresolved_failures: 0,
    },
    fleet: {
      active_codex_jobs: 0,
      active_workflow_runs: 0,
      budget_used_percent: 0,
      queued_workflow_runs: 0,
      support_queued_workflow_runs: 0,
      support_workflow_runs: 0,
      worker_budget: 128,
    },
    workers: [],
    automatic_work: [],
    pipeline: [],
    operational_health: null,
    exact_review_queue: {
      collection: { state: "complete" },
      pending: referenceSource === "queue" ? 1 : 0,
      ready_pending: referenceSource === "queue" ? 1 : 0,
      admissible_pending: referenceSource === "queue" ? 1 : 0,
      lanes: {
        review: {
          pending: referenceSource === "queue" ? 1 : 0,
          capacity: 64,
          active: 0,
          ready: referenceSource === "queue" ? 1 : 0,
          backoff: 0,
          dispatching: 0,
          leased: 0,
          enqueued_total: 1,
          completed_total: 0,
        },
        publication: {
          pending: 0,
          capacity: 24,
          active: 0,
          ready: 0,
          backoff: 0,
          dispatching: 0,
          leased: 0,
          enqueued_total: 0,
          completed_total: 0,
        },
      },
      pressure: {
        status: "healthy",
        reason: "within_capacity",
        capacity: 88,
        active: 0,
        pending: referenceSource === "queue" ? 1 : 0,
        ready_pending: referenceSource === "queue" ? 1 : 0,
        admissible_pending: referenceSource === "queue" ? 1 : 0,
      },
      handoff_health: {
        status: "healthy",
        reason: "handoff_current",
        phases: {
          pending: { count: referenceSource === "queue" ? 1 : 0, oldest_age_seconds: 15 },
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
      bay_projection: {
        complete: true,
        sample_limit: 24,
        total: 1,
        stages: { ...emptyStages(), [referenceStage]: 1 },
        activity: {
          complete: true,
          total: 1,
          queue_stages: queueStages,
          live_stages: liveStages,
          items: [
            {
              repository: "openclaw/openclaw",
              item_number: 123,
              stage: referenceStage,
              source: referenceSource,
              title: privateMarker,
              item_url: `https://invalid.example/private?token=${privateMarker}`,
              failure_key: privateMarker,
            },
          ],
        },
      },
    },
    bay: {
      tide_generation: 0,
      tide_threshold: 20,
      terminal_count: 1,
      terminal_buffer: [
        {
          outcome: "success",
          repository: "openclaw/clawhub",
          item_number: 456,
          title: privateMarker,
          run_url: `https://invalid.example/run/${privateMarker}`,
        },
      ],
      recently_washed: [],
      active_stages: liveStages,
      active_census_complete: true,
      timings: {
        sample_kind: "completed_review_journeys",
        window_minutes: 60,
        overall: { samples: 0, average_ms: null, median_ms: null },
      },
      last_tide_at: null,
      washed_at: null,
    },
    recent: {
      apply_health: { attention_count: 0, items: [] },
      automerge: [],
      automerge_reliability: null,
      closed_items: [],
      closed_stats: { issues: 0, prs: 0, total: 0, window_hours: 24 },
      cluster_repair: null,
      events: [],
      operation_counts: {},
    },
  };
}

const requests = [];
const consoleErrors = [];
const pageErrors = [];
const assertions = [];

function assertProof(name, condition, details = {}) {
  if (!condition) throw new Error(`Proof assertion failed: ${name} ${JSON.stringify(details)}`);
  assertions.push({ name, status: "PASS", ...details });
}

const browserPath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
  "/ms-playwright/chromium-1223/chrome-linux64/chrome";
const browser = await chromium.launch({
  headless: true,
  executablePath: browserPath,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--no-proxy-server",
    "--host-resolver-rules=MAP blade-proof.test 127.0.0.1",
  ],
});
const context = await browser.newContext({
  viewport: { width: 1600, height: 950 },
  deviceScaleFactor: 1,
  colorScheme: "light",
  reducedMotion: "reduce",
});

await context.addInitScript(() => {
  const nativeSetInterval = window.setInterval.bind(window);
  const pollers = [];
  window.setInterval = (callback, delay, ...args) => {
    if (Number(delay) === 20000) {
      pollers.push(callback);
      window.__bladeProofPoll = () => Promise.all(pollers.map((poller) => poller()));
      return 9000 + pollers.length;
    }
    return nativeSetInterval(callback, delay, ...args);
  };
});

context.on("request", (request) => {
  const url = new URL(request.url());
  requests.push({ method: request.method(), host: url.host, path: url.pathname });
});

await context.route("**/*", async (route) => {
  const url = new URL(route.request().url());
  if (url.pathname === "/api/status") {
    await route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      headers: { "cache-control": "no-store", "x-clawsweeper-cache": "proof" },
      body: JSON.stringify(statusFixture()),
    });
    return;
  }
  if (url.pathname === "/api/health-history") {
    await route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({
        schema_version: 1,
        range: url.searchParams.get("range") || "6h",
        retention_days: 7,
        samples: [],
      }),
    });
    return;
  }
  if (url.pathname === "/api/github-egress-observability") {
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    return;
  }
  if (url.pathname === "/api/durable-lifecycle-bay") {
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    return;
  }
  if (url.origin !== origin) {
    await route.abort("blockedbyclient");
    return;
  }
  await route.continue();
});

await context.tracing.start({ screenshots: true, snapshots: true, sources: false });

function watch(page) {
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(String(error.message || error)));
}

let proofError;
try {
  const overview = await context.newPage();
  watch(overview);
  await overview.goto(`${origin}/`, { waitUntil: "networkidle" });
  const overviewCard = overview.locator('[data-public-reference-key="openclaw/openclaw#123"]');
  await overviewCard.waitFor({ state: "visible" });
  await overview.locator("#public-reference-input").fill("#123");
  await overview
    .locator("#public-reference-search")
    .evaluate((form) =>
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
  assertProof(
    "Overview search finds the verified public reference",
    await overviewCard.isVisible(),
  );
  await overview.locator("#public-reference-input").focus();
  for (let index = 0; index < 3; index += 1) await overview.keyboard.press("Tab");
  assertProof(
    "Keyboard navigation reaches the Overview public-reference card",
    await overviewCard.evaluate((node) => node === document.activeElement),
  );
  const focusStyle = await overviewCard.evaluate((node) => {
    const style = getComputedStyle(node);
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
  });
  assertProof(
    "Overview public-reference card has a visible keyboard focus indicator",
    focusStyle.outlineStyle !== "none" && Number.parseFloat(focusStyle.outlineWidth) >= 2,
    focusStyle,
  );
  await overviewCard.click();
  const overviewDialog = overview.locator("#worker-dialog");
  await overviewDialog.waitFor({ state: "visible" });
  const overviewItemHref = await overviewDialog
    .getByRole("link", { name: "Open issue or pull request" })
    .getAttribute("href");
  const overviewRepoHref = await overviewDialog
    .getByRole("link", { name: "Open repository" })
    .getAttribute("href");
  assertProof(
    "Overview blade contains only canonical public GitHub links",
    overviewItemHref === "https://github.com/openclaw/openclaw/issues/123" &&
      overviewRepoHref === "https://github.com/openclaw/openclaw",
    { item_link: overviewItemHref, repository_link: overviewRepoHref },
  );
  assertProof(
    "Overview blade excludes injected private fields",
    !(await overview.locator("body").innerText()).includes(privateMarker),
  );
  await overview.screenshot({ path: path.join(outputDir, "overview-blade.png"), fullPage: true });
  await overview.evaluate(() => {
    location.hash = "#public-reference-%";
  });
  await overview.waitForTimeout(50);
  assertProof(
    "Overview ignores malformed public-reference deep links without a page error",
    !(await overviewDialog.isVisible()),
  );
  await overview.close();

  referenceStage = "reviewing";
  referenceSource = "queue";
  const bay = await context.newPage();
  watch(bay);
  await bay.goto(`${origin}/bay`, { waitUntil: "networkidle" });
  await bay.locator("#loading").waitFor({ state: "hidden" });
  const bayCard = bay.locator('[data-item="queue:openclaw/openclaw#123"]');
  await bayCard.waitFor({ state: "visible" });
  await bay.locator("#finder-input").fill("openclaw/openclaw#123");
  await bay
    .locator("#finder")
    .evaluate((form) =>
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
  assertProof(
    "OpenClaw Bay search locates the verified public reference",
    await bayCard.isVisible(),
  );
  await bayCard.click();
  const bayDialog = bay.locator("#drawer");
  await bayDialog.waitFor({ state: "visible" });
  const bayItemHref = await bayDialog
    .getByRole("link", { name: "Open issue or pull request" })
    .getAttribute("href");
  const bayRepoHref = await bayDialog
    .getByRole("link", { name: "Open repository" })
    .getAttribute("href");
  assertProof(
    "OpenClaw Bay blade contains only canonical public GitHub links",
    bayItemHref === "https://github.com/openclaw/openclaw/issues/123" &&
      bayRepoHref === "https://github.com/openclaw/openclaw",
    { item_link: bayItemHref, repository_link: bayRepoHref },
  );
  assertProof(
    "OpenClaw Bay blade excludes injected private fields",
    !(await bay.locator("body").innerText()).includes(privateMarker),
  );
  referenceStage = "publishing";
  referenceSource = "live";
  const pollHookAvailable = await bay.evaluate(() => typeof window.__bladeProofPoll === "function");
  assertProof("OpenClaw Bay exposes the deterministic status poll hook", pollHookAvailable);
  await bay.evaluate(() => window.__bladeProofPoll());
  await bay.waitForTimeout(250);
  const refreshedBladeText = await bay.locator("#drawer-body").innerText();
  const refreshedCardCount = await bay.locator('[data-item="live:openclaw/openclaw#123"]').count();
  assertProof(
    "An open OpenClaw Bay blade refreshes to the current bounded stage and source",
    refreshedBladeText.includes("Publishing") && refreshedBladeText.includes("Bounded live sample"),
    {
      publishing_visible: refreshedBladeText.includes("Publishing"),
      live_source_visible: refreshedBladeText.includes("Bounded live sample"),
      refreshed_card_count: refreshedCardCount,
    },
  );
  await bay.screenshot({ path: path.join(outputDir, "bay-blade.png"), fullPage: true });
  await bay.evaluate(() => {
    location.hash = "#item-%";
  });
  await bay.waitForTimeout(50);
  assertProof(
    "OpenClaw Bay ignores malformed item deep links without a page error",
    !(await bayDialog.isVisible()),
  );
  await bay.close();
} catch (error) {
  proofError = error;
} finally {
  await context.tracing.stop({ path: path.join(outputDir, "trace.zip") });
  await context.close();
  await browser.close();
}

if (proofError) throw proofError;

const mutatingRequests = requests.filter((request) => !["GET", "HEAD"].includes(request.method));
const githubApiRequests = requests.filter((request) => request.host === "api.github.com");
assertProof("Browser proof sends no mutation", mutatingRequests.length === 0, {
  mutation_count: 0,
});
assertProof("Browser proof sends no direct GitHub API request", githubApiRequests.length === 0, {
  github_api_request_count: 0,
});
assertProof("Browser proof has no console errors", consoleErrors.length === 0, {
  console_error_count: consoleErrors.length,
});
assertProof("Browser proof has no uncaught page errors", pageErrors.length === 0, {
  page_error_count: pageErrors.length,
});

const artifacts = {};
for (const file of ["overview-blade.png", "bay-blade.png", "trace.zip"]) {
  const bytes = await readFile(path.join(outputDir, file));
  artifacts[file] = {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
const summary = {
  proof: "Bay public-reference blades",
  source_sha: sourceSha,
  provider_contract: "Docker-backed Crabbox local-container",
  fixture: "synthetic verified public references with injected private fields",
  assertions,
  assertion_count: assertions.length,
  requests: {
    total: requests.length,
    mutations: 0,
    direct_github_api: 0,
  },
  errors: { console: 0, page: 0 },
  artifacts,
  limits: [
    "Synthetic public-reference state; this proof does not claim live operational freshness.",
    "Canonical GitHub links are inspected but not opened, so no external request is made.",
  ],
};
await writeFile(
  path.join(outputDir, "proof-summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.log(JSON.stringify({ ok: true, assertions: assertions.length, source_sha: sourceSha }));
