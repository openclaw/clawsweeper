import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const outputDir = path.resolve(process.env.CSW_098_PROOF_OUTPUT || "docs/proof/csw-098/artifacts");
const port = Number(process.env.CSW_098_PROOF_PORT || 8798);
const origin = `http://127.0.0.1:${port}`;
const now = Date.now();
await mkdir(outputDir, { recursive: true });

function durableSnapshot() {
  const card = {
    target: {
      repository: "openclaw/openclaw",
      number: 12098,
      url: "https://github.com/openclaw/openclaw/issues/12098",
    },
    revision: 2,
    state: "completed",
    lane: "completed",
    terminal_label: null,
    terminal_history: ["review_completed_routed"],
    current_revision: true,
    facts: {
      admission: "recorded",
      claim_count: 1,
      review_result: "completed",
      github_effect_recorded: true,
      canonical_receipts: ["accepted"],
      router_receipt: "durable",
      acknowledgement: "observed",
    },
    updated_at: new Date(now).toISOString(),
    age_ms: 0,
    provenance: "exact-review-lifecycle-projection-v1",
  };
  return {
    version: 1,
    source: "exact-review-lifecycle-projection-v1",
    generated_at: new Date(now).toISOString(),
    freshness: { maximum_age_ms: 60_000 },
    collection: { state: "complete" },
    inventory: { lifecycle_records: 1, target_revisions: 1, unique_targets: 1 },
    lanes: {
      pending: 0,
      acknowledgement_pending: 0,
      completed: 1,
      superseded: 0,
      requeued: 0,
      terminal_attention: 0,
    },
    sample: { limit: 24, returned: 1, omitted: 0, cards: [card] },
  };
}

function liveSnapshot(mode) {
  if (mode === "unknown")
    return {
      version: 1,
      source: "dashboard-status-v1",
      generated_at: new Date(now - 61_000).toISOString(),
      freshness: { maximum_age_ms: 60_000, expires_at: new Date(now - 1_000).toISOString() },
      collection: { state: "unknown", reason: "stale" },
      activity: null,
    };
  return {
    version: 1,
    source: "dashboard-status-v1",
    generated_at: new Date(now).toISOString(),
    freshness: { maximum_age_ms: 60_000, expires_at: new Date(now + 60_000).toISOString() },
    collection: { state: "complete" },
    activity: {
      limit: 16,
      returned: 4,
      omitted: 0,
      signals: [
        {
          kind: "worker",
          label: "worker active",
          source: "github-actions",
          observed_at: new Date(now).toISOString(),
        },
        {
          kind: "repair",
          label: "repair worker active",
          source: "github-actions",
          observed_at: new Date(now).toISOString(),
        },
        {
          kind: "scheduler",
          label: "comment router active",
          source: "github-actions",
          observed_at: new Date(now).toISOString(),
        },
        {
          kind: "reconciliation",
          label: "lease reconciler active",
          source: "github-actions",
          observed_at: new Date(now).toISOString(),
        },
      ],
    },
  };
}

const statusFixture = {
  generated_at: new Date(now).toISOString(),
  workers: [],
  diagnostics: { errors: [] },
  bay: {
    terminal_buffer: [],
    recently_washed: [],
    terminal_count: 0,
    tide_threshold: 20,
    tide_generation: 0,
    last_tide_at: null,
    washed_at: null,
  },
  health: { sampled_runs: 0 },
  recent: { closed_items: [], failed_runs: [] },
};
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
});
const context = await browser.newContext({
  viewport: { width: 1560, height: 1050 },
  deviceScaleFactor: 1,
});
const page = await context.newPage();
const assertions = [];
const requests = [];
let mode = "active";
const assertProof = (name, condition, details = {}) => {
  if (!condition) throw new Error(`proof failed: ${name}`);
  assertions.push({ name, ...details });
};
context.on("request", (request) => requests.push({ method: request.method(), url: request.url() }));
await page.route("**/api/status", (route) =>
  route.fulfill({ contentType: "application/json", body: JSON.stringify(statusFixture) }),
);
await page.route("**/api/health-history**", (route) =>
  route.fulfill({ contentType: "application/json", body: JSON.stringify({ samples: [] }) }),
);
await page.route("**/api/durable-lifecycle-bay", (route) =>
  route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ durable_lifecycle_bay: durableSnapshot() }),
  }),
);
await page.route("**/api/live-activity-bay", (route) =>
  route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ live_activity_bay: liveSnapshot(mode) }),
  }),
);

try {
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  await page.goto(`${origin}/bay-demo`, { waitUntil: "networkidle" });
  const live = page.locator("#live-activity-panel");
  const kanban = page.locator("#durable-lifecycle-kanban");
  await live.getByText("repair worker active").waitFor({ state: "visible" });
  assertProof(
    "active transient signals render outside the durable Kanban",
    (await live.locator(".live-activity-signal").count()) === 4 &&
      (await kanban.locator(".durable-card").count()) === 1,
  );
  const activeText = await live.textContent();
  assertProof(
    "active panel exposes observed source and expiry while redacting operational identities",
    /github-actions/.test(activeText || "") &&
      /Expires at/.test(activeText || "") &&
      !/run|repository|claim|receipt|token|12098/i.test(activeText || ""),
  );
  await live.screenshot({
    path: path.join(outputDir, "live-activity-active.jpg"),
    type: "jpeg",
    quality: 88,
  });

  mode = "unknown";
  await page.reload({ waitUntil: "networkidle" });
  await live.getByText("Unknown live activity.").waitFor({ state: "visible" });
  assertProof(
    "expired signal becomes Unknown and leaves the durable completed card unchanged",
    (await live.locator(".live-activity-signal").count()) === 0 &&
      (await kanban.locator(".durable-card").count()) === 1 &&
      (await kanban.textContent()).includes("Completed"),
  );
  await live.screenshot({
    path: path.join(outputDir, "live-activity-unknown.jpg"),
    type: "jpeg",
    quality: 88,
  });
  assertProof(
    "Bay reads do not invoke mutating routes",
    requests.every((request) => request.method === "GET"),
  );
} finally {
  await context.tracing.stop({ path: path.join(outputDir, "trace.zip") });
  await context.close();
  await browser.close();
}

const workerActivity = JSON.parse(
  await readFile(path.join(outputDir, "actual-worker-live-activity.json"), "utf8"),
);
const summary = {
  schema_version: 1,
  source_sha: process.env.SOURCE_SHA || "unknown",
  source_tree_sha: process.env.SOURCE_TREE_SHA || "unknown",
  worker_endpoint_status: Number(process.env.CSW_098_WORKER_ACTIVITY_STATUS),
  assertions,
  worker_activity_collection: workerActivity.live_activity_bay?.collection ?? null,
  mutating_requests: requests.filter((request) => request.method !== "GET"),
};
await writeFile(
  path.join(outputDir, "proof-summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
await writeFile(
  path.join(outputDir, "runtime-transcript.md"),
  `# CSW-098 controlled runtime transcript\n\n- Worker endpoint: \`GET /api/live-activity-bay\` -> HTTP ${summary.worker_endpoint_status}; local unauthenticated source returned \`${summary.worker_activity_collection?.state}\` with \`activity: null\`.\n- Built Bay page: rendered four redacted transient signals from controlled current input, then rendered stale input as Unknown.\n- Durable Kanban: retained its one completed durable card across both activity cases.\n- Browser requests: ${requests.length} total, ${summary.mutating_requests.length} mutating.\n`,
);
