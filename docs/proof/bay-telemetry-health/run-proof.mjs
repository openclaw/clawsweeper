import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { publicStatusProjection } from "../../../dashboard/worker.ts";
import {
  ExactReviewLifecycleProjectionStore,
  ExactReviewQueue,
  MemoryDurableNamespace,
  MemoryDurableStorage,
  worker,
} from "../../../test/dashboard-worker-harness.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const outputDir = path.resolve(
  process.env.BAY_TELEMETRY_PROOF_OUTPUT || ".artifacts/bay-telemetry-health",
);
const port = Number(process.env.BAY_TELEMETRY_PROOF_PORT || 8787);
const origin = `http://bay-telemetry-proof.test:${port}`;
const fixedNow = new Date().toISOString();
const minutesAgo = (minutes) => new Date(Date.parse(fixedNow) - minutes * 60_000).toISOString();
const stageCounts = {
  arriving: 3,
  "setting-up": 0,
  reviewing: 1,
  publishing: 0,
  applying: 0,
  repairing: 0,
};
const emptyStages = Object.fromEntries(Object.keys(stageCounts).map((stage) => [stage, 0]));

await mkdir(outputDir, { recursive: true });

const lane = (pending, active) => ({
  pending,
  capacity: 128,
  active,
  ready: pending,
  backoff: 0,
  dispatching: 0,
  leased: active,
  enqueued_total: 100,
  completed_total: 97,
});

const status = {
  schema_version: 1,
  generated_at: fixedNow,
  public_projection_complete: true,
  source: { target_repository_count: 2 },
  fleet: {},
  workers: [],
  automatic_work: [],
  pipeline: [],
  diagnostics: { error_count: 0, errors: [] },
  health: { sampled_runs: 3 },
  exact_review_queue: {
    collection: { state: "complete" },
    bay_projection: {
      complete: true,
      sample_limit: 24,
      total: 4,
      stages: stageCounts,
      legacy_batch_stages: emptyStages,
      activity: {
        complete: true,
        queue_stages: { ...emptyStages, arriving: 3 },
        live_stages: { ...emptyStages, reviewing: 1 },
        queue_legacy_batch_stages: emptyStages,
        live_legacy_batch_stages: emptyStages,
        total: 4,
        items: [
          {
            repository: "openclaw/openclaw",
            item_number: 140001,
            stage: "arriving",
            source: "queue",
            legacy_batch_path: false,
            timing: { kind: "queue", started_at: minutesAgo(18) },
          },
          {
            repository: "openclaw/openclaw",
            item_number: 140002,
            stage: "arriving",
            source: "queue",
            legacy_batch_path: false,
            timing: { kind: "queue", started_at: minutesAgo(5) },
          },
          {
            repository: "openclaw/clawsweeper",
            item_number: 140003,
            stage: "reviewing",
            source: "live",
            legacy_batch_path: false,
            timing: { kind: "run", started_at: minutesAgo(7) },
            action: {
              repository: "openclaw/clawsweeper",
              run_id: 9001,
              job_id: 9002,
              status: "in_progress",
              started_at: minutesAgo(7),
              steps_complete: true,
              steps: [
                { sequence: 1, kind: "setup", status: "completed", conclusion: "success" },
                { sequence: 2, kind: "review", status: "in_progress", conclusion: null },
              ],
            },
          },
          {
            repository: "openclaw/openclaw",
            item_number: 140004,
            stage: "arriving",
            source: "queue",
            legacy_batch_path: false,
          },
        ],
      },
    },
    lanes: { review: lane(2, 1), publication: lane(0, 0) },
    handoff_health: {
      status: "healthy",
      reason: "handoff_current",
      phases: {
        pending: { count: 2, oldest_age_seconds: 1080 },
        dispatching: { count: 0, oldest_age_seconds: null },
        leased: { count: 1, oldest_age_seconds: 420 },
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
    metrics_state: "complete",
    timing_coverage_complete: true,
    tide_generation: 0,
    tide_threshold: 20,
    terminal_count: 0,
    terminal_buffer: [],
    recently_washed: [],
    active_stages: { ...emptyStages, reviewing: 1 },
    active_census_complete: true,
    timings: {
      window_minutes: 60,
      overall: { average_ms: 600000, median_ms: 590000, samples: 3 },
      history: { bucket_minutes: 5, points: [] },
      including_legacy_batch: {
        overall: { average_ms: 600000, median_ms: 590000, samples: 3 },
        history: { bucket_minutes: 5, points: [] },
      },
    },
    last_tide_at: null,
    washed_at: null,
  },
  recent: {},
};

const projectedStatus = publicStatusProjection(
  status,
  new Set(["openclaw/openclaw", "openclaw/clawsweeper"]),
);
if (
  projectedStatus.public_projection_complete !== true ||
  projectedStatus.exact_review_queue?.bay_projection?.activity?.items?.length !== 4 ||
  projectedStatus.exact_review_queue.bay_projection.activity.items[0]?.timing?.kind !== "queue" ||
  projectedStatus.exact_review_queue.bay_projection.activity.items[2]?.timing?.kind !== "run"
) {
  throw new Error("production status projector rejected the proof fixture");
}
const lifecycleStorage = new MemoryDurableStorage();
const lifecycleStore = new ExactReviewLifecycleProjectionStore(lifecycleStorage);
for (let index = 1; index <= 10_001; index += 1) {
  lifecycleStore.recordAdmission({
    canonicalTargetKey: `openclaw/openclaw#${140_000 + index}`,
    fenceKey: `proof-fence-${index}`,
    revision: 1,
    deliveryId: `proof-delivery-${index}`,
    sourceAction: "re_review",
    commandOriginated: false,
    statusMarker: null,
    statusCommentId: null,
    observedAt: Date.parse(fixedNow) - index,
  });
}
const lifecycleEnv = {
  EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(
    new ExactReviewQueue({ storage: lifecycleStorage }, {}),
  ),
  PUBLIC_BAY_REPOS: "openclaw/openclaw",
};
const lifecycleResponse = await worker.fetch(
  new Request("https://clawsweeper.openclaw.ai/api/durable-lifecycle-bay"),
  lifecycleEnv,
);
if (!lifecycleResponse.ok)
  throw new Error(`seeded lifecycle route returned ${lifecycleResponse.status}`);
const lifecycleBody = await lifecycleResponse.text();
let statusResponse = status;

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--no-proxy-server",
    "--host-resolver-rules=MAP bay-telemetry-proof.test 127.0.0.1",
  ],
});
const context = await browser.newContext({ viewport: { width: 1900, height: 1000 } });
await context.addInitScript((now) => {
  Date.now = () => Date.parse(now);
  Math.random = () => 0;
}, fixedNow);
const page = await context.newPage();
const requests = [];
page.on("request", (request) => requests.push({ method: request.method(), url: request.url() }));
await page.route("**/*", async (route) => {
  const url = new URL(route.request().url());
  if (url.pathname === "/api/status") {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(statusResponse),
    });
  } else if (url.pathname === "/api/durable-lifecycle-bay") {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: lifecycleBody,
    });
  } else if (
    url.pathname === "/api/health-history" ||
    url.pathname === "/api/github-egress-observability"
  ) {
    await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
  } else if (url.origin === origin) {
    await route.continue();
  } else {
    await route.abort("blockedbyclient");
  }
});

const response = await page.goto(`${origin}/bay`, { waitUntil: "networkidle" });
await page.locator("#loading").waitFor({ state: "hidden" });
await page.locator("#stage-grid .critter").first().waitFor({ state: "visible" });
await page.locator("#durable-lifecycle-kanban .durable-card").first().waitFor({ state: "visible" });
await page.locator('[data-number="140004"]').evaluate((node) => node.classList.add("ready"));

const systemDetails = page.locator("#bay-system-details");
const results = {
  route_status: response?.status(),
  system_details_initially_open: await systemDetails.evaluate((node) => node.open),
  crab_lane_count: await page.locator("#stage-grid .stage").count(),
  active_labels: await page.locator(".stage-grid .active-duration").allTextContents(),
  overdue_count: await page.locator(".stage-grid .age-over-target").count(),
  lifecycle_inventory: await page.locator(".durable-summary-note").innerText(),
};

await page.waitForFunction(
  () => document.querySelectorAll("#chat-overlay .overlay-speech").length === 2,
);
results.chat_answer = await page.locator("#chat-overlay .overlay-speech.answer").innerText();
results.chat_question = await page.locator("#chat-overlay .overlay-speech.question").innerText();
await page.locator("#stage-grid .critter").evaluateAll((nodes) => {
  for (const node of nodes) {
    node.classList.remove("ready");
    node.removeAttribute("data-age-kind");
    node.removeAttribute("data-age-started-at");
  }
});
await page.waitForFunction(
  (previous) => {
    const answer =
      document.querySelector("#chat-overlay .overlay-speech.answer")?.textContent || "";
    return (
      answer !== previous && /trustworthy|verified queue or run clock|timing source/i.test(answer)
    );
  },
  results.chat_answer,
  { timeout: 20_000 },
);
results.missing_timing_answer = await page
  .locator("#chat-overlay .overlay-speech.answer")
  .innerText();
results.missing_timing_question = await page
  .locator("#chat-overlay .overlay-speech.question")
  .innerText();

await systemDetails.locator("summary").click();
await page.locator("#bay-control-board .bay-control-card").first().waitFor({ state: "visible" });
results.system_details_after_click = await systemDetails.evaluate((node) => node.open);
results.system_detail_cards = await page.locator("#bay-control-board .bay-control-card").count();
await page.screenshot({ path: path.join(outputDir, "bay.png"), fullPage: true });
await page.locator('[data-brush="change"]').click();
await page.waitForFunction(() => document.querySelector("#master")?.dataset.phase === "resting");

statusResponse = JSON.parse(JSON.stringify(status));
statusResponse.exact_review_queue.bay_projection.items =
  statusResponse.exact_review_queue.bay_projection.activity.items.slice(0, 2);
statusResponse.exact_review_queue.bay_projection.items.forEach((item) => {
  item.stage = "reviewing";
});
statusResponse.exact_review_queue.bay_projection.activity = {
  complete: false,
  queue_stages: null,
  live_stages: null,
  queue_legacy_batch_stages: null,
  live_legacy_batch_stages: null,
  total: null,
};
await page.waitForResponse((response) => new URL(response.url()).pathname === "/api/status", {
  timeout: 30_000,
});
await page.waitForFunction(() => {
  const moved = document.querySelector('.stage[data-stage="reviewing"] [data-number="140001"]');
  return (
    moved &&
    !moved.hasAttribute("data-age-kind") &&
    document.querySelectorAll(".stage-grid .active-duration").length === 0
  );
});
results.incomplete_active_labels = await page.locator(".stage-grid .active-duration").count();
results.incomplete_age_attributes = await page.locator(".stage-grid [data-age-kind]").count();
results.incomplete_overdue_count = await page.locator(".stage-grid .age-over-target").count();
results.incomplete_transition_markers = await page
  .locator(".stage-grid .ready, .stage-grid .being-swept, .stage-grid .tunneling")
  .count();
await page.waitForFunction(
  () => document.querySelectorAll("#chat-overlay .overlay-speech").length === 2,
);
results.incomplete_chat_answer = await page
  .locator("#chat-overlay .overlay-speech.answer")
  .innerText();
results.incomplete_chat_question = await page
  .locator("#chat-overlay .overlay-speech.question")
  .innerText();
await page.screenshot({ path: path.join(outputDir, "bay-incomplete.png"), fullPage: true });

await page.evaluate(() => {
  const observed = { card: false, master: false };
  const inspect = () => {
    const master = document.querySelector("#master");
    if (master && master.dataset.phase !== "resting") observed.master = true;
    if (
      document.querySelector(
        ".stage-grid .ready, .stage-grid .being-swept, .stage-grid .tunneling, .stage-grid .retriggered",
      )
    )
      observed.card = true;
  };
  new MutationObserver(inspect).observe(document.body, {
    attributes: true,
    childList: true,
    subtree: true,
  });
  window.__bayRecoveryAnimationObserved = observed;
  inspect();
});
statusResponse = JSON.parse(JSON.stringify(status));
await page.waitForResponse((response) => new URL(response.url()).pathname === "/api/status", {
  timeout: 30_000,
});
await page.waitForFunction(() => {
  const restored = document.querySelector(
    '.stage[data-stage="arriving"] [data-number="140001"][data-age-kind="queue"]',
  );
  return restored && document.querySelectorAll(".stage-grid .active-duration").length === 3;
});
results.recovery_transition_markers = await page
  .locator(".stage-grid .ready, .stage-grid .being-swept, .stage-grid .tunneling")
  .count();
results.recovery_animation_observed = await page.evaluate(
  () => window.__bayRecoveryAnimationObserved,
);
await page.screenshot({ path: path.join(outputDir, "bay-recovered.png"), fullPage: true });

const checks = {
  real_worker_route: results.route_status === 200,
  diagnostics_demoted: results.system_details_initially_open === false,
  diagnostics_expand:
    results.system_details_after_click === true && results.system_detail_cards >= 3,
  crab_lanes_preserved: results.crab_lane_count === 6,
  queue_and_run_clocks:
    results.active_labels.includes("Queued 18m") && results.active_labels.includes("Run 7m"),
  overdue_visible: results.overdue_count === 1,
  restored_queue_speech: /queue record has been waiting about/i.test(results.chat_answer),
  queue_question_matches_clock: /queued|queue clock|waiting for review/i.test(
    results.chat_question,
  ),
  missing_timing_speech:
    /no verified queue or run clock|timing source is unavailable|do not have a trustworthy active clock|no trustworthy in-progress timing/i.test(
      results.missing_timing_answer,
    ),
  missing_timing_question_is_neutral:
    /trustworthy clock|verified timing update|timing source/i.test(results.missing_timing_question),
  incomplete_activity_suppresses_age:
    results.incomplete_active_labels === 0 &&
    results.incomplete_age_attributes === 0 &&
    results.incomplete_overdue_count === 0 &&
    results.incomplete_transition_markers === 0,
  incomplete_activity_speech_is_neutral:
    /trustworthy clock|verified timing update|timing source/i.test(
      results.incomplete_chat_question,
    ) &&
    /no verified queue or run clock|timing source is unavailable|do not have a trustworthy active clock|no trustworthy in-progress timing/i.test(
      results.incomplete_chat_answer,
    ),
  recovery_resets_transition_baseline:
    results.recovery_transition_markers === 0 &&
    results.recovery_animation_observed?.card === false &&
    results.recovery_animation_observed?.master === false,
  lifecycle_over_10000:
    /10,?001 lifecycle records/i.test(results.lifecycle_inventory) ||
    /10001 lifecycle records/i.test(results.lifecycle_inventory),
  no_mutations: requests.every((request) => ["GET", "HEAD"].includes(request.method)),
  no_github_api: requests.every((request) => new URL(request.url).hostname !== "api.github.com"),
};
for (const [name, passed] of Object.entries(checks)) {
  if (!passed) throw new Error(`proof assertion failed: ${name} ${JSON.stringify(results)}`);
}

const summary = {
  proof: "OpenClaw Bay telemetry health",
  source_sha: process.env.BAY_TELEMETRY_PROOF_SOURCE_SHA || "unknown",
  generated_at: new Date().toISOString(),
  fixture: "synthetic public aggregate; no production reads or mutations",
  results,
  checks,
};
await writeFile(
  path.join(outputDir, "proof-summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
await context.close();
await browser.close();
process.stdout.write(`${JSON.stringify(summary)}\n`);
