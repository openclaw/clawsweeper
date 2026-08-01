import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const outputDir = path.resolve(process.env.CSW_093_PROOF_OUTPUT || "docs/proof/csw-093/artifacts");
const port = Number(process.env.CSW_093_PROOF_PORT || 8793);
const sourceSha = process.env.SOURCE_SHA || "unknown";
const sourceTreeSha = process.env.SOURCE_TREE_SHA || "unknown";
const origin = `http://127.0.0.1:${port}`;

await mkdir(outputDir, { recursive: true });

const lanes = [
  "pending",
  "acknowledgement_pending",
  "completed",
  "superseded",
  "requeued",
  "terminal_attention",
];
const laneStates = {
  pending: { state: "pending", terminal_label: null, history: [] },
  acknowledgement_pending: {
    state: "acknowledgement_pending",
    terminal_label: null,
    history: ["review_completed_routed"],
  },
  completed: { state: "completed", terminal_label: null, history: ["review_completed_routed"] },
  superseded: { state: "superseded", terminal_label: null, history: ["superseded"] },
  requeued: { state: "requeue", terminal_label: null, history: ["requeue"] },
  terminal_attention: {
    state: "dead_letter",
    terminal_label: "dead_letter",
    history: ["dead_letter"],
  },
};

function lifecycleCard(index, lane, now) {
  const number = 12000 + index;
  const classification = laneStates[lane];
  const repository = index === 1 ? "openclaw/fence-tools" : "openclaw/openclaw";
  return {
    target: {
      repository,
      number,
      url: `https://github.com/${repository}/issues/${number}`,
    },
    revision: lane === "superseded" || lane === "requeued" ? 1 : 2,
    state: classification.state,
    lane,
    terminal_label: classification.terminal_label,
    terminal_history: classification.history,
    current_revision: lane !== "superseded" && lane !== "requeued",
    facts: {
      admission: "recorded",
      claim_count: index % 3,
      review_result: lane === "pending" ? null : "completed",
      github_effect_recorded: lane === "completed" || lane === "acknowledgement_pending",
      canonical_receipts:
        lane === "completed" || lane === "acknowledgement_pending" ? ["accepted"] : [],
      router_receipt: lane === "completed" || lane === "acknowledgement_pending" ? "durable" : null,
      acknowledgement:
        lane === "acknowledgement_pending"
          ? "pending"
          : lane === "completed"
            ? "observed"
            : "not_required",
    },
    updated_at: new Date(now - index * 1000).toISOString(),
    age_ms: index * 1000,
    provenance: "exact-review-lifecycle-projection-v1",
  };
}

function completeSnapshot(now = Date.now()) {
  const cards = lanes.flatMap((lane, laneIndex) =>
    Array.from({ length: 4 }, (_, cardIndex) =>
      lifecycleCard(laneIndex * 4 + cardIndex + 1, lane, now),
    ),
  );
  return {
    version: 1,
    source: "exact-review-lifecycle-projection-v1",
    generated_at: new Date(now).toISOString(),
    freshness: { maximum_age_ms: 60_000 },
    collection: { state: "complete" },
    inventory: { lifecycle_records: 25, target_revisions: 25, unique_targets: 25 },
    lanes: {
      pending: 5,
      acknowledgement_pending: 4,
      completed: 4,
      superseded: 4,
      requeued: 4,
      terminal_attention: 4,
    },
    sample: { limit: 24, returned: cards.length, omitted: 1, cards },
  };
}

function unknownSnapshot(now = Date.now()) {
  return {
    version: 1,
    source: "exact-review-lifecycle-projection-v1",
    generated_at: new Date(now).toISOString(),
    freshness: { maximum_age_ms: 60_000 },
    collection: { state: "unknown", reason: "mixed" },
    inventory: null,
    lanes: null,
    sample: null,
  };
}

const statusFixture = {
  generated_at: new Date().toISOString(),
  workers: [],
  health: { sampled_runs: 0 },
  recent: { closed_items: [], failed_runs: [] },
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
};

function assertProof(name, condition, details = {}) {
  if (!condition) throw new Error(`proof failed: ${name}`);
  assertions.push({ name, ...details });
}

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
let snapshotMode = "complete";

const pureWorkerDoRead = JSON.parse(
  await readFile(path.join(outputDir, "actual-worker-do-read.json"), "utf8"),
);
const ordinaryQueueAfterPureRead = JSON.parse(
  await readFile(path.join(outputDir, "ordinary-queue-after-pure-read.json"), "utf8"),
);
const pureBay = pureWorkerDoRead?.durable_lifecycle_bay;
const ordinaryEvents = ordinaryQueueAfterPureRead?.recent_durable_publication_events;
const workerDoInitialization = {
  pure_uninitialized_read: {
    worker_api: "GET /api/durable-lifecycle-bay",
    durable_object_route: "GET /lifecycle-bay",
    http_status: Number(process.env.CSW_093_PURE_READ_STATUS),
    collection: pureBay?.collection ?? null,
    inventory: pureBay?.inventory ?? null,
    lanes: pureBay?.lanes ?? null,
    sample: pureBay?.sample ?? null,
  },
  ordinary_initialized_queue_read: {
    worker_api: "GET /api/recent-durable-publication-events?window=24h",
    durable_object_route: "GET /recent-durable-publication-events?window=24h",
    http_status: Number(process.env.CSW_093_ORDINARY_QUEUE_STATUS),
    collection: ordinaryEvents?.collection ?? null,
    activity: ordinaryEvents?.activity ?? null,
  },
};
assertProof(
  "pure uninitialized Worker to DO lifecycle read fail-closes without cards or counts",
  workerDoInitialization.pure_uninitialized_read.http_status === 200 &&
    workerDoInitialization.pure_uninitialized_read.collection?.state === "unknown" &&
    workerDoInitialization.pure_uninitialized_read.inventory === null &&
    workerDoInitialization.pure_uninitialized_read.lanes === null &&
    workerDoInitialization.pure_uninitialized_read.sample === null,
);
assertProof(
  "ordinary queue request succeeds after the pure lifecycle read",
  workerDoInitialization.ordinary_initialized_queue_read.http_status === 200 &&
    workerDoInitialization.ordinary_initialized_queue_read.collection?.state === "complete" &&
    workerDoInitialization.ordinary_initialized_queue_read.collection?.complete === true,
);

context.on("request", (request) => {
  requests.push({ method: request.method(), url: request.url() });
});
await page.route("**/api/status", async (route) => {
  await route.fulfill({ contentType: "application/json", body: JSON.stringify(statusFixture) });
});
await page.route("**/api/health-history**", async (route) => {
  await route.fulfill({ contentType: "application/json", body: JSON.stringify({ samples: [] }) });
});
await page.route("**/api/durable-lifecycle-bay", async (route) => {
  const durable_lifecycle_bay =
    snapshotMode === "complete" ? completeSnapshot() : unknownSnapshot();
  await route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ durable_lifecycle_bay }),
  });
});

try {
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  await page.goto(`${origin}/bay-demo`, { waitUntil: "networkidle" });
  const kanban = page.locator("#durable-lifecycle-kanban");
  await kanban.locator(".durable-card").first().waitFor({ state: "visible" });
  assertProof(
    "complete renderer shows exactly the bounded 24-card sample",
    (await kanban.locator(".durable-card").count()) === 24,
    {
      sample_cards: 24,
    },
  );
  assertProof(
    "complete renderer shows durable lanes including terminal attention",
    (await kanban.textContent()).includes("Terminal attention") &&
      (await kanban.textContent()).includes("dead letter") &&
      (await kanban.textContent()).includes("24 of 25 target-revision cards shown"),
  );
  const completeText = await kanban.textContent();
  assertProof(
    "renderer accepts public repository names containing lifecycle-sensitive words",
    (completeText || "").includes("openclaw/fence-tools"),
  );
  assertProof(
    "renderer exposes no operational identifiers",
    !/(?:fence[-_](?:secret|key)|run id|claim id|delivery id|receipt id|comment id|digest)/i.test(
      completeText || "",
    ),
  );
  await kanban.screenshot({
    path: path.join(outputDir, "complete-lifecycle-kanban.jpg"),
    type: "jpeg",
    quality: 88,
  });

  snapshotMode = "unknown";
  await page.reload({ waitUntil: "networkidle" });
  await page.getByText("Unknown lifecycle snapshot.").waitFor({ state: "visible" });
  assertProof(
    "mixed snapshot renders Unknown with no partial cards",
    (await kanban.locator(".durable-card").count()) === 0 &&
      (await kanban.textContent()).includes("No counts or cards are shown"),
  );
  await kanban.screenshot({
    path: path.join(outputDir, "unknown-lifecycle-kanban.jpg"),
    type: "jpeg",
    quality: 88,
  });
} finally {
  await context.tracing.stop({ path: path.join(outputDir, "trace.zip") });
  await context.close();
  await browser.close();
}

const externalRequests = requests.filter(
  (request) => new URL(request.url).hostname !== "127.0.0.1",
);
const mutatingRequests = requests.filter((request) => !["GET", "HEAD"].includes(request.method));
assertProof("browser proof makes no external request", externalRequests.length === 0, {
  external_requests: externalRequests,
});
assertProof("browser proof makes no mutation request", mutatingRequests.length === 0, {
  mutating_requests: mutatingRequests,
});

const summary = {
  proof: "CSW-093 controlled durable lifecycle Bay proof",
  source_sha: sourceSha,
  source_tree_sha256: sourceTreeSha,
  worker_do_read: "actual local Wrangler-built GET /api/durable-lifecycle-bay captured separately",
  worker_do_initialization_sequence: workerDoInitialization,
  ui: "actual local Wrangler-built /bay-demo with synthetic, contract-validated lifecycle fixtures",
  fixture: { lifecycle_records: 25, sample_cards: 24, unknown_reason: "mixed" },
  assertions,
  network: {
    request_count: requests.length,
    external_requests: externalRequests,
    mutating_requests: mutatingRequests,
  },
  screenshots: ["complete-lifecycle-kanban.jpg", "unknown-lifecycle-kanban.jpg"],
  artifacts: {
    pure_worker_do_response: "actual-worker-do-read.json",
    worker_do_initialization_sequence: "worker-do-initialization-sequence.json",
    worker_do_initialization_transcript: "worker-do-initialization-transcript.txt",
    runtime_transcript: "runtime-transcript.md",
    machine_summary: "proof-summary.json",
    screenshots: ["complete-lifecycle-kanban.jpg", "unknown-lifecycle-kanban.jpg"],
  },
  generated_at: new Date().toISOString(),
};
await writeFile(
  path.join(outputDir, "proof-summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
await writeFile(
  path.join(outputDir, "runtime-transcript.md"),
  `# CSW-093 controlled runtime proof\n\n- Source: \`${sourceSha}\`\n- Pure initialization-safe read: local Wrangler Worker \`GET /api/durable-lifecycle-bay\` called the uninitialized local DO \`GET /lifecycle-bay\`; it returned fail-closed Unknown with null counts and cards.\n- Ordinary queue request after the pure read: local Wrangler Worker \`GET /api/recent-durable-publication-events?window=24h\` called the same local DO and returned a complete aggregate response. This demonstrates the pure read did not prevent normal local queue initialization.\n- Reducer route: the focused Worker-to-DO fixture test proves the populated, 512+1-bounded read uses one SELECT and performs no initialization, write, alarm, queue reclaim, or GitHub request.\n- Browser: the real local Wrangler-built \`/bay-demo\` rendered a 25-record synthetic projection as the fixed 24-card sample, then a mixed snapshot as Unknown with no partial cards or counts.\n- Network: ${requests.length} browser requests, ${externalRequests.length} external requests, ${mutatingRequests.length} mutation requests.\n\nThis is controlled synthetic evidence only. The ordinary request initializes only the disposable local proof DO. It makes no production, external, queue, lifecycle, GitHub, R2, deployment, gate, or merge mutation. Fixture data is synthetic and redacted; no operational identifiers are printed.\n`,
);
await writeFile(
  path.join(outputDir, "worker-do-initialization-sequence.json"),
  `${JSON.stringify(
    {
      proof: "CSW-093 Worker/DO initialization safety sequence",
      source_sha: sourceSha,
      sequence: workerDoInitialization,
      redaction: {
        exposed_operational_identifiers: false,
        note: "Records only routes, status, aggregate state, and null/non-null public fields.",
      },
    },
    null,
    2,
  )}\n`,
);
await writeFile(
  path.join(outputDir, "worker-do-initialization-transcript.txt"),
  `CSW-093 controlled Worker/DO initialization transcript\nsource: ${sourceSha}\nenvironment: local Wrangler Worker and Durable Object inside Linux Docker Crabbox\n\n1. PURE UNINITIALIZED READ\n   Worker route: ${workerDoInitialization.pure_uninitialized_read.worker_api}\n   Durable Object route: ${workerDoInitialization.pure_uninitialized_read.durable_object_route}\n   HTTP: ${workerDoInitialization.pure_uninitialized_read.http_status}\n   Result: collection=${workerDoInitialization.pure_uninitialized_read.collection?.state ?? "null"}; inventory=${workerDoInitialization.pure_uninitialized_read.inventory === null ? "null" : "present"}; lanes=${workerDoInitialization.pure_uninitialized_read.lanes === null ? "null" : "present"}; sample=${workerDoInitialization.pure_uninitialized_read.sample === null ? "null" : "present"}\n   Observation: uninitialized pure lifecycle read failed closed without cards or counts.\n\n2. ORDINARY INITIALIZED QUEUE READ AFTER PURE READ\n   Worker route: ${workerDoInitialization.ordinary_initialized_queue_read.worker_api}\n   Durable Object route: ${workerDoInitialization.ordinary_initialized_queue_read.durable_object_route}\n   HTTP: ${workerDoInitialization.ordinary_initialized_queue_read.http_status}\n   Result: collection=${workerDoInitialization.ordinary_initialized_queue_read.collection?.state ?? "null"}; complete=${workerDoInitialization.ordinary_initialized_queue_read.collection?.complete ?? "null"}\n   Observation: the normal aggregate-only queue endpoint still succeeded after the pure read.\n\nFixture boundary: this disposable local proof DO is the only state initialized by the ordinary request. No production or external endpoint was contacted. This transcript intentionally excludes fence, run, claim, delivery, receipt, comment, and digest identifiers.\n`,
);

console.log(
  JSON.stringify({ ok: true, assertions: assertions.length, output_dir: outputDir }, null, 2),
);
