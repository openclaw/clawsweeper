import {
  assert,
  generateKeyPairSync,
  test,
  worker,
  workflowJobsForRunSnapshot,
  ExactReviewQueue,
  MemoryKv,
  MemoryCache,
  MemoryDurableStorage,
  MemoryDurableNamespace,
  isoAgo,
  completedReviewRun,
  activePrFetch,
  triageIssue,
  jsonResponse,
  buildExactReviewQueueRequest,
} from "./dashboard-worker-harness.ts";
import { STATUS_REFRESH_TIMEOUT_MS, githubJsonForTest } from "../dashboard/worker.ts";
import { publicationStatusFixture } from "./helpers/publication-status-fixture.ts";

const ISSUE_TRIAGE_VIEW_IDS = [
  "clawsweeper",
  "ready-candidates",
  "queueable-blocked",
  "already-has-pr",
  "needs-info",
  "needs-maintainer-review",
  "product-security",
  "needs-live-repro",
];

const PROOF_TRIAGE_VIEW_IDS = [
  "proof-triage",
  "needs-proof",
  "missing-proof",
  "sufficient-proof",
  "mock-only-proof",
  "telegram-proof",
  "sufficient-with-need-label",
];

function legacyTriageSnapshot(viewIds: string[], marker: string) {
  const views = viewIds.map((id, index) => ({
    id,
    title: marker,
    description: marker,
    total_count: index + 1,
    item_limit: 100,
    query: marker,
    github_url: `https://invalid.example/${marker}?q=${marker}`,
    items: [
      {
        repository: marker,
        number: index + 1,
        title: marker,
        url: `https://invalid.example/${marker}/${index + 1}`,
        author: marker,
        assignees: [marker],
        labels: [{ name: marker }],
      },
    ],
  }));
  return {
    schema_version: 1,
    generated_at: "2026-08-15T12:00:00.000Z",
    source: { target_repositories: [marker], labels: [marker] },
    counts: Object.fromEntries(views.map((view) => [view.id, view.total_count])),
    views,
    diagnostics: { errors: [] },
  };
}

function assertAggregateTriageSnapshot(snapshot: any, viewIds: string[], marker: string) {
  assert.equal(snapshot.schema_version, 2);
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.error_count, 0);
  assert.deepEqual(
    snapshot.views.map((view: { id: string }) => view.id),
    viewIds,
  );
  assert.deepEqual(
    snapshot.views.map((view: { items: unknown[] }) => view.items),
    viewIds.map(() => []),
  );
  assert.deepEqual(
    viewIds.map((id, index) => snapshot.counts[id] === index + 1),
    viewIds.map(() => true),
  );
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, new RegExp(marker, "i"));
  for (const field of [
    "repository",
    "number",
    "query",
    "github_url",
    "author",
    "assignees",
    "labels",
    "diagnostics",
    "source",
  ]) {
    assert.equal(serialized.includes(`"${field}"`), false, field);
  }
}

test("dashboard polling ignores workflow snapshots without disabling other durable reads", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const warnings: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => warnings.push(args));
  t.after(() => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  });
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: { match: async () => undefined, put: async () => undefined } },
  });

  for (const usable of [true, false]) {
    const completed = completedReviewRun(41, 100, "success", 60_000);
    const active = {
      ...completedReviewRun(42, 101, "success", 30_000),
      status: "in_progress",
      conclusion: null,
    };
    const phantom = {
      ...completedReviewRun(999, 999, "success", 60 * 60_000),
      status: "queued",
      conclusion: null,
    };
    const paths: string[] = [];
    const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
    const namespace = new MemoryDurableNamespace({
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        paths.push(pathname);
        if (pathname === "/github-read-model/workflows") {
          return jsonResponse({
            usable,
            runs: [phantom],
            jobs_usable: true,
            jobs: [],
            job_coverage_run_ids: [42],
            class_state: { reason: "never_observed" },
          });
        }
        return queue.fetch(request);
      },
    });
    let runReads = 0;
    let jobReads = 0;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
        runReads += 1;
        const status = url.searchParams.get("status");
        return jsonResponse({
          workflow_runs: !status
            ? [active, completed]
            : status === "completed"
              ? [completed]
              : status === "in_progress"
                ? [active]
                : [],
        });
      }
      const jobMatch = /\/actions\/runs\/(41|42)\/jobs$/.exec(url.pathname);
      if (jobMatch) {
        jobReads += 1;
        const run = jobMatch[1] === "42" ? active : completed;
        return jsonResponse({
          total_count: 1,
          jobs: [
            {
              id: run.id * 10,
              run_id: run.id,
              name: "Review shard",
              status: run.status,
              conclusion: run.conclusion,
              started_at: run.created_at,
              completed_at: run.status === "completed" ? run.updated_at : null,
              updated_at: run.updated_at,
              steps: [
                {
                  number: 1,
                  name: "Review shard",
                  status: run.status,
                  conclusion: run.conclusion,
                  started_at: run.created_at,
                  completed_at: run.status === "completed" ? run.updated_at : null,
                },
              ],
            },
          ],
        });
      }
      if (url.pathname.includes("/actions/workflows/")) {
        return jsonResponse({ workflow_runs: [] });
      }
      if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
      if (url.pathname.includes("/issues")) return jsonResponse([]);
      throw new Error(`unexpected fetch ${url}`);
    };
    const env = {
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CLAWSWEEPER_WEBHOOK_SECRET: "synthetic-polling-secret",
      EXACT_REVIEW_QUEUE: namespace,
      STATUS_STORE: new MemoryKv(),
      CACHE_TTL_SECONDS: "-1",
    };
    const request = new Request("https://clawsweeper.openclaw.ai/api/status");
    const first = await worker.fetch(request, env);
    const snapshot = await first.json();
    assert.equal(first.status, 200);
    assert.equal(snapshot.fleet.active_workflow_runs, 1);
    assert.equal(snapshot.fleet.active_codex_jobs, 1);
    assert.equal(snapshot.operational_health.status, "healthy");
    assert.equal(snapshot.operational_health.queued_over_threshold, 0);
    assert.equal(snapshot.health.attempts, 1);
    assert.equal(snapshot.health.successful_attempts, 1);
    assert.equal(runReads, 7);
    assert.equal(jobReads, 2);
    assert.ok(paths.some((pathname) => !pathname.startsWith("/github-read-model/")));
    assert.equal(
      paths.some((pathname) => pathname.startsWith("/github-read-model/")),
      false,
    );
    const generatedAt = snapshot.generated_at;
    await new Promise((resolve) => setTimeout(resolve, 2));
    const refreshed = await (await worker.fetch(request, env)).json();
    assert.ok(Date.parse(refreshed.generated_at) > Date.parse(generatedAt));
    assert.equal(runReads, 14);
    assert.equal(jobReads, 2, "normal job caches remain enabled in poll mode");
    assert.equal(
      paths.some((pathname) => pathname.startsWith("/github-read-model/")),
      false,
    );
  }
  assert.equal(JSON.stringify(warnings).includes("github_read_model_degraded"), false);
});

test("polling job censuses preserve versioned caches, incomplete pages, and errors", async () => {
  for (const totalCount of [1, 2]) {
    const store = new MemoryKv();
    let queueReads = 0;
    const env = {
      CLAWSWEEPER_WEBHOOK_SECRET: "synthetic-polling-secret",
      STATUS_STORE: store,
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace({
        async fetch() {
          queueReads += 1;
          return jsonResponse({ ok: true });
        },
      }),
    };
    const github = async () => ({
      total_count: totalCount,
      jobs: [{ id: 2, run_id: 41, updated_at: isoAgo(1_000) }],
    });
    const first = await workflowJobsForRunSnapshot(
      env,
      "generated-owner/generated-repo",
      41,
      github,
    );
    assert.equal(first.complete, totalCount === 1);
    assert.equal(first.jobs.length, 1);
    const record = JSON.parse(
      String(await store.get("workflow-jobs:generated-owner/generated-repo:41")),
    );
    assert.equal(record.schema_version, 2);
    assert.equal(record.complete, totalCount === 1);
    const cached = await workflowJobsForRunSnapshot(
      env,
      "generated-owner/generated-repo",
      41,
      async () => {
        throw new Error("polling must retain the normal job cache");
      },
    );
    assert.deepEqual(cached, first);
    assert.equal(queueReads, 0);
    await assert.rejects(
      workflowJobsForRunSnapshot(env, "generated-owner/generated-repo", 42, async () => {
        throw new Error("synthetic GitHub failure");
      }),
      /synthetic GitHub failure/,
    );
    assert.equal(queueReads, 0);
  }
});

test("worker job pagination marks a capped census incomplete across cache reuse", async () => {
  const statusStore = new MemoryKv();
  let reads = 0;
  const github = async () => {
    reads += 1;
    return {
      total_count: 301,
      jobs: Array.from({ length: 100 }, (_, index) => ({
        id: reads * 1_000 + index,
        run_id: 41,
      })),
    };
  };
  const first = await workflowJobsForRunSnapshot(
    { STATUS_STORE: statusStore },
    "generated-owner/generated-repo",
    41,
    github,
  );
  assert.equal(first.jobs.length, 300);
  assert.equal(first.complete, false);
  assert.equal(reads, 3);

  const restarted = await workflowJobsForRunSnapshot(
    { STATUS_STORE: statusStore },
    "generated-owner/generated-repo",
    41,
    async () => {
      throw new Error("cached incomplete census should not fetch");
    },
  );
  assert.equal(restarted.jobs.length, 300);
  assert.equal(restarted.complete, false);
});

test("worker job cache cannot claim a complete malformed or cross-run census", async () => {
  const statusStore = new MemoryKv();
  await statusStore.put(
    "workflow-jobs:generated-owner/generated-repo:41",
    JSON.stringify({
      schema_version: 1,
      complete: true,
      jobs: [
        null,
        { id: 1, run_id: 99, name: "synthetic unrelated job" },
        { id: 2, run_id: 41, name: "synthetic matching job" },
      ],
    }),
  );
  const cached = await workflowJobsForRunSnapshot(
    { STATUS_STORE: statusStore },
    "generated-owner/generated-repo",
    41,
    async () => {
      throw new Error("malformed cached census should fail closed without a source read");
    },
  );
  assert.equal(cached.complete, false);
  assert.equal(cached.jobs.length, 1);
});

test("worker job cache requires an exact versioned total before claiming completion", async () => {
  const job = { id: 2, run_id: 41, name: "synthetic matching job" };
  for (const [record, expectedComplete] of [
    [{ schema_version: 1, complete: true, jobs: [job] }, false],
    [{ schema_version: 2, complete: true, total_count: 1, jobs: [job] }, true],
    [{ schema_version: 2, complete: true, total_count: 2, jobs: [job] }, false],
    [{ schema_version: 2, complete: true, total_count: "1", jobs: [job] }, false],
  ]) {
    const statusStore = new MemoryKv();
    await statusStore.put(
      "workflow-jobs:generated-owner/generated-repo:41",
      JSON.stringify(record),
    );
    const cached = await workflowJobsForRunSnapshot(
      { STATUS_STORE: statusStore },
      "generated-owner/generated-repo",
      41,
      async () => {
        throw new Error("cached census should not fetch");
      },
    );
    assert.equal(cached.complete, expectedComplete);
    assert.equal(cached.jobs.length, 1);
  }
});

test("live worker job fetch versions its complete cache without repairing webhook state", async () => {
  const statusStore = new MemoryKv();
  let repairBody = null;
  const live = await workflowJobsForRunSnapshot(
    {
      STATUS_STORE: statusStore,
      CLAWSWEEPER_WEBHOOK_SECRET: "synthetic-secret",
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace({
        async fetch(request) {
          repairBody = await request.json();
          return jsonResponse({ ok: true });
        },
      }),
    },
    "generated-owner/generated-repo",
    41,
    async () => ({
      total_count: 1,
      jobs: [
        {
          id: 2,
          run_id: 41,
          updated_at: "2026-08-15T12:00:00Z",
        },
      ],
    }),
  );
  assert.equal(live.complete, true);
  const stored = JSON.parse(
    String(await statusStore.get("workflow-jobs:generated-owner/generated-repo:41")),
  );
  assert.equal(stored.schema_version, 2);
  assert.equal(stored.complete, true);
  assert.equal(stored.total_count, 1);
  assert.equal(repairBody, null);
  const restarted = await workflowJobsForRunSnapshot(
    { STATUS_STORE: statusStore },
    "generated-owner/generated-repo",
    41,
    async () => {
      throw new Error("versioned complete census should survive restart");
    },
  );
  assert.equal(restarted.complete, true);
  assert.equal(restarted.jobs.length, 1);
});

test("live worker job fetch cannot claim a complete malformed or cross-run census", async () => {
  const statusStore = new MemoryKv();
  let repairBody = null;
  const exactReviewQueue = new MemoryDurableNamespace({
    async fetch(request) {
      assert.equal(new URL(request.url).pathname, "/github-read-model/repair");
      repairBody = await request.json();
      return jsonResponse({ ok: true });
    },
  });
  const live = await workflowJobsForRunSnapshot(
    {
      STATUS_STORE: statusStore,
      EXACT_REVIEW_QUEUE: exactReviewQueue,
      CLAWSWEEPER_WEBHOOK_SECRET: "synthetic-secret",
    },
    "generated-owner/generated-repo",
    41,
    async () => ({
      total_count: 3,
      jobs: [
        null,
        {
          id: 1,
          run_id: 99,
          name: "synthetic unrelated job",
          updated_at: "2026-08-15T12:00:00Z",
        },
        {
          id: 2,
          run_id: 41,
          name: "synthetic matching job",
          updated_at: "2026-08-15T12:00:00Z",
        },
      ],
    }),
  );
  assert.equal(live.complete, false);
  assert.deepEqual(
    live.jobs.map((job) => job.id),
    [2],
  );

  const stored = JSON.parse(
    String(await statusStore.get("workflow-jobs:generated-owner/generated-repo:41")),
  );
  assert.equal(stored.complete, false);
  assert.deepEqual(
    stored.jobs.map((job) => job.id),
    [2],
  );
  assert.equal(repairBody, null);
});

test("live worker job fetch rejects malformed pages and ambiguous job identities", async () => {
  const cases = [
    { payload: { jobs: null, total_count: 0 }, retained: 0 },
    { payload: { jobs: [{ id: "2", run_id: 41 }], total_count: 1 }, retained: 0 },
    {
      payload: {
        jobs: [
          { id: 2, run_id: 41 },
          { id: 2, run_id: 41 },
        ],
        total_count: 2,
      },
      retained: 1,
    },
  ];
  for (const { payload, retained } of cases) {
    const statusStore = new MemoryKv();
    const live = await workflowJobsForRunSnapshot(
      { STATUS_STORE: statusStore },
      "generated-owner/generated-repo",
      41,
      async () => payload,
    );
    assert.equal(live.complete, false);
    assert.equal(live.jobs.length, retained);
    const stored = JSON.parse(
      String(await statusStore.get("workflow-jobs:generated-owner/generated-repo:41")),
    );
    assert.equal(stored.complete, false);
    assert.equal(stored.jobs.length, retained);
  }
});

test("live worker job fetch requires a strict stable total before completion", async () => {
  const oneJob = {
    id: 2,
    run_id: 41,
    updated_at: "2026-08-15T12:00:00Z",
  };
  for (const payload of [
    { jobs: [oneJob], total_count: 2 },
    { jobs: [oneJob], total_count: 0 },
    { jobs: [oneJob], total_count: "1" },
  ]) {
    const statusStore = new MemoryKv();
    const repairBodies = [];
    const live = await workflowJobsForRunSnapshot(
      {
        STATUS_STORE: statusStore,
        CLAWSWEEPER_WEBHOOK_SECRET: "synthetic-secret",
        EXACT_REVIEW_QUEUE: new MemoryDurableNamespace({
          async fetch(request) {
            repairBodies.push(await request.json());
            return jsonResponse({ ok: true });
          },
        }),
      },
      "generated-owner/generated-repo",
      41,
      async () => payload,
    );
    assert.equal(live.complete, false);
    const stored = JSON.parse(
      String(await statusStore.get("workflow-jobs:generated-owner/generated-repo:41")),
    );
    assert.equal(stored.complete, false);
    assert.deepEqual(repairBodies, []);
  }

  const statusStore = new MemoryKv();
  let page = 0;
  const changedTotal = await workflowJobsForRunSnapshot(
    { STATUS_STORE: statusStore },
    "generated-owner/generated-repo",
    41,
    async () => {
      page += 1;
      return page === 1
        ? {
            total_count: 101,
            jobs: Array.from({ length: 100 }, (_, index) => ({
              id: index + 1,
              run_id: 41,
            })),
          }
        : { total_count: 102, jobs: [{ id: 101, run_id: 41 }] };
    },
  );
  assert.equal(page, 2);
  assert.equal(changedTotal.complete, false);
  assert.equal(changedTotal.jobs.length, 100);
  const stored = JSON.parse(
    String(await statusStore.get("workflow-jobs:generated-owner/generated-repo:41")),
  );
  assert.equal(stored.complete, false);
  assert.equal(stored.jobs.length, 100);
});

test("dashboard exposes active worker jobs and their current steps", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const cache = new MemoryCache();
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: cache,
    },
  });
  const run = {
    id: 42,
    name: "Review ClawSweeper items",
    display_title: "Review event item openclaw/openclaw#92521",
    status: "in_progress",
    conclusion: null,
    html_url: "https://github.com/openclaw/clawsweeper/actions/runs/42",
    created_at: isoAgo(120_000),
    updated_at: isoAgo(10_000),
  };
  const queuedRun = {
    id: 43,
    name: "Review ClawSweeper items",
    display_title: "Review event item openclaw/openclaw#92523",
    status: "queued",
    conclusion: null,
    html_url: "https://github.com/openclaw/clawsweeper/actions/runs/43",
    created_at: isoAgo(30_000),
    updated_at: isoAgo(5_000),
  };
  const queuedBatchRun = {
    id: 44,
    name: "Publish exact review batch",
    display_title: "Publish exact review batch",
    status: "queued",
    conclusion: null,
    html_url: "https://github.com/openclaw/clawsweeper/actions/runs/44",
    created_at: isoAgo(20_000),
    updated_at: isoAgo(2_000),
  };
  let graphqlRequests = 0;
  const queueStorage = new MemoryDurableStorage();
  const exactReviewQueue = new ExactReviewQueue(
    { storage: queueStorage },
    { EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0" },
  );
  await exactReviewQueue.fetch(
    buildExactReviewQueueRequest(
      "aggregate-bay-overlap",
      92521,
      "opened",
      "issue",
      "openclaw/openclaw",
    ),
  );
  const exactReviewQueueNamespace = new MemoryDurableNamespace(exactReviewQueue);
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      const status = url.searchParams.get("status");
      return jsonResponse({
        workflow_runs: !status
          ? [run, queuedRun, queuedBatchRun]
          : status === "in_progress"
            ? [run]
            : status === "queued"
              ? [queuedRun, queuedBatchRun]
              : [],
      });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/42/jobs") {
      return jsonResponse({
        total_count: 3,
        jobs: [
          {
            id: 4201,
            run_id: 42,
            name: "Review shard 0 · openclaw/openclaw#92521,92522",
            status: "in_progress",
            conclusion: null,
            html_url: "https://github.com/openclaw/clawsweeper/actions/runs/42/job/4201",
            started_at: isoAgo(90_000),
            steps: [
              {
                number: 1,
                name: "Set up job",
                status: "completed",
                conclusion: "success",
              },
              {
                number: 2,
                name: "Run ./clawsweeper/.github/actions/setup-codex",
                status: "completed",
                conclusion: "success",
              },
              {
                number: 3,
                name: "Review shard",
                status: "in_progress",
                conclusion: null,
              },
            ],
          },
          {
            id: 4202,
            run_id: 42,
            name: "Publish review artifacts",
            status: "in_progress",
            conclusion: null,
            html_url: "https://github.com/openclaw/clawsweeper/actions/runs/42/job/4202",
            started_at: isoAgo(60_000),
            steps: [
              {
                number: 1,
                name: "Apply review artifacts",
                status: "completed",
                conclusion: "success",
              },
              {
                number: 2,
                name: "Publish review artifact action ledger",
                status: "in_progress",
                conclusion: null,
              },
            ],
          },
          {
            id: 4203,
            run_id: 42,
            name: "publish",
            status: "in_progress",
            conclusion: null,
            html_url: "https://github.com/openclaw/clawsweeper/actions/runs/42/job/4203",
            started_at: isoAgo(55_000),
            steps: [
              {
                number: 1,
                name: "Claim one durable publication batch",
                status: "completed",
                conclusion: "success",
              },
              {
                number: 2,
                name: "Finalize healthy members under a fenced heartbeat",
                status: "in_progress",
                conclusion: null,
              },
            ],
          },
        ],
      });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/43/jobs") {
      return jsonResponse({ total_count: 0, jobs: [] });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/44/jobs") {
      return jsonResponse({
        total_count: 1,
        jobs: [
          {
            id: 4401,
            run_id: 44,
            name: "publish",
            status: "queued",
            conclusion: null,
            html_url: "https://github.com/openclaw/clawsweeper/actions/runs/44/job/4401",
            started_at: null,
            steps: [],
          },
        ],
      });
    }
    if (url.pathname === "/graphql") {
      graphqlRequests += 1;
      return jsonResponse({
        data: {
          repository: {
            target0: {
              __typename: "Issue",
              title: "Preserve terminal resize state",
              url: "https://github.com/openclaw/openclaw/issues/92521",
            },
            target1: {
              __typename: "PullRequest",
              title: "Repair terminal resize state",
              url: "https://github.com/openclaw/openclaw/pull/92522",
            },
            target2: {
              __typename: "Issue",
              title: "Queued terminal resize follow-up",
              url: "https://github.com/openclaw/openclaw/issues/92523",
            },
          },
        },
      });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-intake.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-worker.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        PUBLIC_BAY_REPOS: "openclaw/openclaw,openclaw/clawsweeper",
        CACHE_TTL_SECONDS: "0",
        GITHUB_TOKEN: "test-token",
        EXACT_REVIEW_QUEUE: exactReviewQueueNamespace,
      },
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    const serializedStatus = JSON.stringify(status);
    for (const privateField of [
      "workflow_title",
      "failure_key",
      "run_url",
      "job_url",
      "item_numbers",
      "target_items",
      "name",
    ]) {
      assert.equal(serializedStatus.includes(`"${privateField}"`), false);
    }
    assert.equal(status.workers[0].status, "in_progress");
    assert.equal("repository" in status.workers[0], false);
    assert.equal("item_number" in status.workers[0], false);
    assert.equal("id" in status.workers[0], false);
    assert.deepEqual(status.workers[0].progress, { completed: 2, total: 3 });
    assert.equal(status.fleet.active_codex_jobs, 2);
    assert.equal(status.fleet.worker_detail_runs, 3);
    assert.equal(status.fleet.worker_detail_fallbacks, 1);
    assert.equal(status.workers.length, 5);
    assert.deepEqual(
      status.workers.map((worker) => worker.stage),
      ["reviewing", "publishing", "applying", "arriving", "publishing"],
    );
    assert.equal(status.workers[0].status, "in_progress");
    assert.deepEqual(status.workers[0].progress, { completed: 2, total: 3 });
    assert.equal(status.workers[0].steps[2].status, "in_progress");
    assert.equal(status.workers[1].is_codex_worker, false);
    assert.equal(status.workers[3].source, "workflow-fallback");
    const activity = status.exact_review_queue.bay_projection.activity;
    const { items: publicItems, ...activityCounts } = activity;
    assert.deepEqual(activityCounts, {
      complete: true,
      queue_stages: {
        arriving: 0,
        "setting-up": 0,
        reviewing: 0,
        publishing: 0,
        applying: 0,
        repairing: 0,
      },
      live_stages: {
        arriving: 1,
        "setting-up": 0,
        reviewing: 1,
        publishing: 1,
        applying: 1,
        repairing: 0,
      },
      queue_legacy_batch_stages: {
        arriving: 0,
        "setting-up": 0,
        reviewing: 0,
        publishing: 0,
        applying: 0,
        repairing: 0,
      },
      live_legacy_batch_stages: {
        arriving: 0,
        "setting-up": 0,
        reviewing: 1,
        publishing: 1,
        applying: 0,
        repairing: 0,
      },
      total: 4,
    });
    assert.deepEqual(
      publicItems.map((item) => ({
        repository: item.repository,
        item_number: item.item_number,
        stage: item.stage,
        source: item.source,
        action_repository: item.action?.repository,
        run_id: item.action?.run_id,
        job_id: item.action?.job_id,
        status: item.action?.status,
        step_kinds: item.action?.steps.map((step) => step.kind),
        step_statuses: item.action?.steps.map((step) => step.status),
      })),
      [
        {
          repository: "openclaw/openclaw",
          item_number: 92521,
          stage: "applying",
          source: "live",
          action_repository: "openclaw/clawsweeper",
          run_id: 42,
          job_id: 4203,
          status: "in_progress",
          step_kinds: ["lease", "finalize"],
          step_statuses: ["completed", "in_progress"],
        },
        {
          repository: "openclaw/openclaw",
          item_number: 92523,
          stage: "arriving",
          source: "live",
          action_repository: "openclaw/clawsweeper",
          run_id: 43,
          job_id: undefined,
          status: "queued",
          step_kinds: [],
          step_statuses: [],
        },
        {
          repository: "openclaw/openclaw",
          item_number: 92521,
          stage: "publishing",
          source: "live",
          action_repository: "openclaw/clawsweeper",
          run_id: 42,
          job_id: 4202,
          status: "in_progress",
          step_kinds: ["apply", "publish"],
          step_statuses: ["completed", "in_progress"],
        },
        {
          repository: "openclaw/openclaw",
          item_number: 92522,
          stage: "reviewing",
          source: "live",
          action_repository: "openclaw/clawsweeper",
          run_id: 42,
          job_id: 4201,
          status: "in_progress",
          step_kinds: ["setup", "review", "review"],
          step_statuses: ["completed", "completed", "in_progress"],
        },
      ],
    );
    assert.equal(
      publicItems.every((item) => typeof item.action?.started_at === "string"),
      true,
    );
    assert.equal(serializedStatus.includes("Review shard"), false);
    assert.equal(serializedStatus.includes("setup-codex"), false);
    assert.equal("active_overlaps" in status.exact_review_queue.bay_projection, false);
    assert.equal(Array.isArray(status.exact_review_queue.bay_projection.items), true);
    assert.equal(
      JSON.stringify(status.exact_review_queue.bay_projection.items).includes(
        "aggregate-bay-overlap",
      ),
      false,
    );
    const privacyCachedResponse = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        PUBLIC_BAY_REPOS: "openclaw/openclaw,openclaw/clawsweeper",
        CACHE_TTL_SECONDS: "0",
        GITHUB_TOKEN: "test-token",
        EXACT_REVIEW_QUEUE: exactReviewQueueNamespace,
      },
      {
        waitUntil: () => undefined,
      },
    );
    const cachedStatus = await privacyCachedResponse.json();
    assert.equal(cachedStatus.workers[0].status, "in_progress");
    assert.deepEqual(
      cachedStatus.workers.map((worker) => worker.stage),
      ["reviewing", "publishing", "applying", "arriving", "publishing"],
    );
    assert.deepEqual(
      cachedStatus.exact_review_queue.bay_projection.activity,
      status.exact_review_queue.bay_projection.activity,
    );
    assert.equal("workflow_title" in cachedStatus.workers[0], false);
    assert.equal(graphqlRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard keeps control-plane workflow fallbacks out of Codex capacity", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: new MemoryCache() },
  });
  const runs = [
    [1, "ClawSweeper", "Review event item openclaw/openclaw#1", "in_progress"],
    [2, "repair cluster worker", "repair cluster jobs/openclaw/inbox/cluster-2.md", "queued"],
    [3, "Assist", "Assist openclaw/openclaw#3", "in_progress"],
    [4, "ClawSweeper", "Review event item openclaw/openclaw#4@publish:40:1", "in_progress"],
    [5, "repair comment router", "clawsweeper_comment", "queued"],
    [6, "Reconcile exact-review leases", "Reconcile exact-review leases", "in_progress"],
    [7, "ClawSweeper", "Sync Codex review comments for openclaw/openclaw", "queued"],
    [8, "ClawSweeper Review Plan", "Review ClawSweeper items", "in_progress"],
  ].map(([id, name, displayTitle, status]) => ({
    id,
    name,
    display_title: displayTitle,
    status,
    conclusion: null,
    html_url: `https://github.com/openclaw/clawsweeper/actions/runs/${id}`,
    created_at: isoAgo(Number(id) * 1_000),
    updated_at: isoAgo(500),
  }));
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      const status = url.searchParams.get("status");
      return jsonResponse({
        workflow_runs: !status ? runs : runs.filter((run) => run.status === status),
      });
    }
    if (/^\/repos\/openclaw\/clawsweeper\/actions\/runs\/\d+\/jobs$/.test(url.pathname)) {
      return jsonResponse({ jobs: [] });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-intake.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-worker.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
      },
      { waitUntil: () => undefined },
    );
    const status = await response.json();
    assert.equal(status.fleet.active_codex_jobs, 4);
    assert.equal(status.fleet.worker_detail_fallbacks, 4);
    assert.equal(status.workers.length, 4);
    assert.equal(
      status.workers.every((entry: Record<string, unknown>) => !("id" in entry)),
      true,
    );
    assert.deepEqual(status.control_plane, {
      publishers: { running: 1, waiting: 0 },
      comment_routers: { running: 0, waiting: 2 },
      reconcilers: { running: 1, waiting: 0 },
    });
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard bounds worker job detail request concurrency", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: new MemoryCache(),
    },
  });
  const runs = Array.from({ length: 12 }, (_, index) => ({
    id: 1000 + index,
    name: "Review ClawSweeper items",
    display_title: `Review event item openclaw/openclaw#${9000 + index}`,
    status: "in_progress",
    conclusion: null,
    html_url: `https://github.com/openclaw/clawsweeper/actions/runs/${1000 + index}`,
    created_at: isoAgo((index + 1) * 1000),
    updated_at: isoAgo(1000),
  }));
  let activeJobRequests = 0;
  let maxActiveJobRequests = 0;
  let pipelineRequestsWhileJobsActive = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      const status = url.searchParams.get("status");
      return jsonResponse({ workflow_runs: !status || status === "in_progress" ? runs : [] });
    }
    if (/^\/repos\/openclaw\/clawsweeper\/actions\/runs\/\d+\/jobs$/.test(url.pathname)) {
      const runId = Number(url.pathname.split("/").at(-2));
      activeJobRequests += 1;
      maxActiveJobRequests = Math.max(maxActiveJobRequests, activeJobRequests);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeJobRequests -= 1;
      return jsonResponse({
        total_count: 1,
        jobs: [
          {
            id: runId * 10,
            run_id: runId,
            name: `Review shard ${runId}`,
            status: "in_progress",
            conclusion: null,
            html_url: `https://github.com/openclaw/clawsweeper/actions/runs/${runId}/job/${
              runId * 10
            }`,
            started_at: isoAgo(1000),
            steps: [
              {
                number: 1,
                name: "Run ./clawsweeper/.github/actions/setup-codex",
                status: "completed",
                conclusion: "success",
              },
              {
                number: 2,
                name: "Review shard",
                status: "in_progress",
                conclusion: null,
              },
            ],
          },
        ],
      });
    }
    if (/^\/repos\/openclaw\/openclaw\/pulls\/\d+$/.test(url.pathname)) {
      if (activeJobRequests) pipelineRequestsWhileJobsActive += 1;
      return jsonResponse({ head: { sha: `head-${url.pathname.split("/").at(-1)}` } });
    }
    if (/^\/repos\/openclaw\/openclaw\/commits\/head-\d+\/check-runs$/.test(url.pathname)) {
      if (activeJobRequests) pipelineRequestsWhileJobsActive += 1;
      return jsonResponse({ check_runs: [] });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-intake.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-worker.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        WORKER_DETAIL_RUN_LIMIT: "12",
        WORKER_JOB_FETCH_CONCURRENCY: "3",
        CACHE_TTL_SECONDS: "0",
        INCLUDE_CI_STATUS: "1",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(response.status, 200);
    assert.equal(status.workers.length, 12);
    assert.equal(status.fleet.active_codex_jobs, 12);
    assert.equal(maxActiveJobRequests, 3);
    assert.equal(pipelineRequestsWhileJobsActive, 0);
    assert.deepEqual(status.diagnostics.errors, []);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard paginates worker jobs beyond GitHub's first page", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: new MemoryCache(),
    },
  });
  const run = {
    id: 500,
    name: "Review ClawSweeper items",
    display_title: "Review event item openclaw/openclaw#500",
    status: "in_progress",
    conclusion: null,
    html_url: "https://github.com/openclaw/clawsweeper/actions/runs/500",
    created_at: isoAgo(60_000),
    updated_at: isoAgo(5_000),
  };
  const requestedPages = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      const status = url.searchParams.get("status");
      return jsonResponse({
        workflow_runs: !status || status === "in_progress" ? [run] : [],
      });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/500/jobs") {
      const page = Number(url.searchParams.get("page") || "1");
      requestedPages.push(page);
      const count = page === 1 ? 100 : 28;
      const offset = page === 1 ? 0 : 100;
      return jsonResponse({
        total_count: 128,
        jobs: Array.from({ length: count }, (_, index) => ({
          id: 500_000 + offset + index,
          run_id: 500,
          name: `Review shard ${offset + index}`,
          status: "in_progress",
          conclusion: null,
          html_url: `https://github.com/openclaw/clawsweeper/actions/runs/500/job/${
            500_000 + offset + index
          }`,
          started_at: isoAgo(30_000),
          steps: [
            {
              number: 1,
              name: "Run ./clawsweeper/.github/actions/setup-codex",
              status: "completed",
              conclusion: "success",
            },
            {
              number: 2,
              name: "Review shard",
              status: "in_progress",
              conclusion: null,
            },
          ],
        })),
      });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-intake.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
      },
      { waitUntil: () => undefined },
    );
    const status = await response.json();
    assert.equal(status.fleet.active_codex_jobs, 128);
    assert.equal(status.workers.length, 100);
    assert.deepEqual(requestedPages, [1, 2]);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard reports worker health without treating worker jobs as lifecycle completions", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: new MemoryCache(),
    },
  });
  const runs = [
    completedReviewRun(4, 300, "success", 60_000),
    completedReviewRun(3, 200, "success", 120_000),
    completedReviewRun(2, 100, "success", 180_000),
    completedReviewRun(1, 100, "success", 240_000),
  ];
  let jobRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      return jsonResponse({
        workflow_runs:
          url.searchParams.get("status") === "completed"
            ? runs
            : url.searchParams.has("status")
              ? []
              : runs,
      });
    }
    const jobMatch = url.pathname.match(
      /^\/repos\/openclaw\/clawsweeper\/actions\/runs\/(\d+)\/jobs$/,
    );
    if (jobMatch) {
      jobRequests += 1;
      const runId = Number(jobMatch[1]);
      const itemNumber = runId === 1 || runId === 2 ? 100 : runId === 3 ? 200 : 300;
      const failed = runId === 1 || runId === 3;
      const run = runs.find((candidate) => candidate.id === runId);
      const runStartedAt = Date.parse(run?.created_at || "");
      const jobStartedAt = new Date(runStartedAt + 1_000).toISOString();
      const reviewStartedAt = new Date(runStartedAt + 3_000).toISOString();
      return jsonResponse({
        total_count: 1,
        jobs: [
          {
            id: runId * 10,
            run_id: runId,
            name: `Review shard 0 · openclaw/openclaw#${itemNumber}`,
            status: "completed",
            conclusion: runId === 4 ? "neutral" : "success",
            html_url: `https://github.com/openclaw/clawsweeper/actions/runs/${runId}/job/${
              runId * 10
            }`,
            started_at: jobStartedAt,
            completed_at: run?.updated_at,
            steps:
              runId === 4
                ? Array.from({ length: 101 }, (_, index) => ({
                    number: index + 1,
                    name: `Review shard ${index + 1}`,
                    status: "completed",
                    conclusion: "success",
                    started_at: jobStartedAt,
                    completed_at: run?.updated_at,
                  }))
                : [
                    {
                      number: 1,
                      name: "Run ./clawsweeper/.github/actions/setup-codex",
                      status: "completed",
                      conclusion: "success",
                      started_at: jobStartedAt,
                      completed_at: reviewStartedAt,
                    },
                    {
                      number: 2,
                      name: "Review shard",
                      status: "completed",
                      conclusion: failed ? "failure" : "success",
                      started_at: reviewStartedAt,
                      completed_at: run?.updated_at,
                    },
                  ],
          },
        ],
      });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-intake.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const env = {
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      PUBLIC_BAY_REPOS: "openclaw/openclaw,openclaw/clawsweeper",
      CACHE_TTL_SECONDS: "0",
      STATUS_STORE: new MemoryKv(),
    };
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      { waitUntil: () => undefined },
    );
    const status = await response.json();
    assert.equal(status.health.attempts, 4);
    assert.equal(status.health.successful_attempts, 2);
    assert.equal(status.health.failed_attempts, 2);
    assert.equal(status.health.recovered_failures, 1);
    assert.equal(status.health.unresolved_failures, 1);
    assert.equal(status.health.error_rate_percent, 50);
    assert.equal(status.health.recovery_rate_percent, 50);
    assert.equal(status.health.recent_attempts, undefined);
    assert.equal(status.health.failures.length, 2);
    assert.equal(status.health.failures[0].recovered, false);
    assert.equal(status.health.failures[1].recovered, true);
    assert.equal(jobRequests, 4);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard cold-cache status bounds a stalled forty-run worker-health refresh", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: new MemoryCache() },
  });
  const runs = Array.from({ length: 40 }, (_, index) =>
    completedReviewRun(index + 1, 50_000 + index, "success", (index + 1) * 1_000),
  );
  let stalledJobRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      return jsonResponse({
        workflow_runs:
          url.searchParams.get("status") === "completed"
            ? runs
            : url.searchParams.has("status")
              ? []
              : runs,
      });
    }
    if (/^\/repos\/openclaw\/clawsweeper\/actions\/runs\/\d+\/jobs$/.test(url.pathname)) {
      stalledJobRequests += 1;
      return new Promise<Response>(() => undefined);
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-intake.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const startedAt = Date.now();
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
        WORKER_HEALTH_FETCH_CONCURRENCY: "40",
        WORKER_HEALTH_SECTION_TIMEOUT_MS: "25",
      },
      { waitUntil: () => undefined },
    );
    const elapsedMs = Date.now() - startedAt;
    const status = await response.json();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-clawsweeper-cache"), "miss");
    assert.equal(status.health.sampled_runs, 0);
    assert.equal(stalledJobRequests, 20, "only one bounded concurrency wave may start");
    assert.ok(elapsedMs < 1_000, `cold status exceeded its bounded test budget: ${elapsedMs}ms`);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard exposes apply health from sweep status without broad scans", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  const sweepStatus = {
    target_repo: "openclaw/openclaw",
    state: "Apply finished",
    run_url: "https://github.com/openclaw/clawsweeper/actions/runs/99",
    updated_at: "2026-07-03T10:15:00Z",
    apply_health: {
      run_url: "https://github.com/openclaw/clawsweeper/actions/runs/98",
      mode: "close",
      status: "needs_attention",
      summary:
        "4 examined; 2/2 action records; 0 closed, 0 comments synced, 2 skipped; no cursor recorded.",
      examined: 4,
      action_records: 2,
      processed: 2,
      processed_limit: 2,
      close_limit: 5,
      closed: 0,
      comment_synced: 0,
      skipped: 2,
      cursor_required: true,
      skip_reasons: {
        skipped_changed_since_review: 2,
      },
      lanes: {
        closure: {
          processed: 2,
          closed: 0,
          comment_synced: 0,
          skipped: 2,
          skip_reasons: {
            skipped_changed_since_review: 2,
          },
        },
        comment_sync: {
          processed: 0,
          closed: 0,
          comment_synced: 0,
          skipped: 0,
          skip_reasons: {},
        },
      },
      next_actions: [
        {
          reason: "skipped_changed_since_review",
          count: 2,
          bucket: "review_refresh",
          owner: "clawsweeper",
          retryable: true,
          label: "Refresh review",
          summary: "The item changed after the review that proposed closing it.",
          next_step: "Queue a fresh ClawSweeper review before any close retry.",
        },
      ],
      next_action_buckets: {
        review_refresh: 2,
      },
      cycle: {
        basis: "scheduled_close_cursor",
        apply_ready_count: 1200,
        candidate_counts: {
          confirmed_proposal: 4,
          guarded_retry: 2,
          proof_required: 3,
          promotion_total: 1194,
          promotion_eligible: 1,
          promotion_cooldown_eligible: 420,
          cooldown_eligible_total: 427,
          inconsistent_or_stale: 1,
        },
        window_size: 300,
        estimated_full_cycle_windows: 4,
        estimated_full_cycle_minutes: null,
        scheduled_interval_minutes: null,
        label:
          "1200 close candidates (confirmed proposals plus live promotion probes) at 300 records per latest cursor advance: about 4 windows.",
      },
      attention_reasons: ["cursor_required_but_missing_after_full_window"],
      cursor: null,
    },
  };
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      return jsonResponse({ workflow_runs: [] });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-intake.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper-state/contents/results/sweep-status/openclaw-openclaw.json"
    ) {
      assert.equal(url.searchParams.get("ref"), "state");
      return jsonResponse({
        content: Buffer.from(JSON.stringify(sweepStatus)).toString("base64"),
      });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(new Request("https://clawsweeper.openclaw.ai/api/status"), {
      STATUS_STORE: new MemoryKv(),
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
    });
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.recent.apply_health.attention_count, 1);
    assert.equal(status.recent.apply_health.items[0].status, "needs_attention");
    assert.equal("run_url" in status.recent.apply_health.items[0], false);
    assert.equal(status.recent.apply_health.items[0].examined, 4);
    assert.equal(status.recent.apply_health.items[0].action_records, 2);
    assert.equal(status.recent.apply_health.items[0].processed, 2);
    assert.equal(status.recent.apply_health.items[0].cursor_required, true);
    assert.deepEqual(status.recent.apply_health.items[0].skip_reasons, {
      skipped_changed_since_review: 2,
    });
    assert.deepEqual(status.recent.apply_health.items[0].lanes.closure, {
      processed: 2,
      closed: 0,
      comment_synced: 0,
      skipped: 2,
      skip_reasons: {
        skipped_changed_since_review: 2,
      },
    });
    assert.equal(status.recent.apply_health.items[0].lanes.comment_sync.processed, 0);
    assert.deepEqual(status.recent.apply_health.items[0].next_action_buckets, {
      review_refresh: 2,
    });
    assert.equal("next_step" in status.recent.apply_health.items[0].next_actions[0], false);
    assert.equal(status.recent.apply_health.items[0].cycle.estimated_full_cycle_minutes, null);
    assert.equal(status.recent.apply_health.items[0].cycle.apply_ready_count, 1200);
    assert.deepEqual(status.recent.apply_health.items[0].cycle.candidate_counts, {
      confirmed_proposal: 4,
      guarded_retry: 2,
      proof_required: 3,
      promotion_total: 1194,
      promotion_eligible: 1,
      promotion_cooldown_eligible: 420,
      cooldown_eligible_total: 427,
      inconsistent_or_stale: 1,
    });
    assert.equal(status.recent.apply_health.items[0].cursor, null);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard reads stored CI status for active PR rows", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/repos/openclaw/clawsweeper/actions/runs")) {
      return jsonResponse({
        workflow_runs: [
          {
            id: 1,
            name: "ClawSweeper",
            display_title: "Review event item openclaw/openclaw#80609",
            status: "in_progress",
            conclusion: null,
            html_url: "https://github.com/openclaw/clawsweeper/actions/runs/1",
            created_at: new Date(Date.now() - 60_000).toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      });
    }
    if (url.includes("/search/issues")) return jsonResponse({ items: [] });
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const env = {
      INGEST_TOKEN: "test-token",
      STATUS_STORE: new MemoryKv(),
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
    };
    const ingest = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/events", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          event_type: "ci.status",
          repository: "openclaw/openclaw",
          item_number: 80609,
          status: "green",
          ci: {
            repository: "openclaw/openclaw",
            item_number: 80609,
            state: "green",
            source: "github-checks",
            total: 12,
            failing: 0,
            pending: 0,
          },
        }),
      }),
      env,
    );
    assert.equal(ingest.status, 200);

    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal("repository" in status.pipeline[0], false);
    assert.equal("item_number" in status.pipeline[0], false);
    assert.equal(status.pipeline[0].ci.state, "green");
    assert.equal(status.pipeline[0].ci.source, "github-checks");
    assert.equal(status.pipeline[0].ci.total, 12);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard skips raw event persistence when the private status store is not bound", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const marker = "synthetic-unbound-store-marker";
  const cached = new Map<string, Response>();
  const writes: Array<{ url: string; body: string }> = [];
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async (request: Request) => cached.get(request.url)?.clone(),
        put: async (request: Request, response: Response) => {
          writes.push({ url: request.url, body: await response.clone().text() });
          cached.set(request.url, response.clone());
        },
      },
    },
  });
  globalThis.fetch = activePrFetch;

  try {
    const env = {
      INGEST_TOKEN: "test-token",
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
    };
    const ingest = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/events", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          event_type: "ci.status",
          repository: `synthetic-owner/${marker}`,
          item_number: 80609,
          ci: {
            repository: `synthetic-owner/${marker}`,
            item_number: 80609,
            state: "pending",
            source: "github-checks",
            total: 12,
            failing: 0,
            pending: 2,
          },
        }),
      }),
      env,
    );
    assert.equal(ingest.status, 200);
    assert.deepEqual(writes, []);

    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(response.status, 200);
    assert.doesNotMatch(JSON.stringify(status), new RegExp(marker));
    assert.equal(
      writes.some(({ url }) => url.includes("clawsweeper.internal/store")),
      false,
    );
    assert.doesNotMatch(JSON.stringify(writes), new RegExp(marker));
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard stale refresh coalesces concurrent polling requests", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const cache = new MemoryCache();
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: cache },
  });
  await cache.put(
    new Request("https://clawsweeper.openclaw.ai/api/status-cache/v8/_/stale"),
    jsonResponse({
      schema_version: 1,
      generated_at: "2026-06-13T18:00:00Z",
      source: {
        clawsweeper_repo: "openclaw/clawsweeper",
        target_repositories: ["openclaw/openclaw"],
      },
      fleet: { active_workflow_runs: 1 },
      workers: [],
      automatic_work: [],
      pipeline: [{ id: "stale-row" }],
      bay: {},
      recent: {},
      exact_review_queue: {
        pending: 1,
        dispatching: 1,
        leased: 0,
        handoff_health: { status: "stalled" },
      },
      diagnostics: { errors: [], exact_review_queue_error: null },
    }),
  );

  const currentQueue = {
    pending: 7,
    dispatching: 0,
    leased: 28,
    storage_schema_version: 1,
    handoff_health: {
      status: "healthy",
      reason: "handoff_current",
      phases: {
        pending: { count: 7 },
        dispatching: { count: 0 },
        leased: { count: 28 },
      },
    },
  };
  let queueReads = 0;
  const exactReviewQueue = new MemoryDurableNamespace({
    fetch: async () => {
      queueReads += 1;
      return jsonResponse(currentQueue);
    },
  });

  let releaseFetch!: () => void;
  const fetchGate = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  let unfilteredRunRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    await fetchGate;
    if (url.pathname.includes("/actions/")) {
      if (url.pathname.endsWith("/actions/runs") && !url.searchParams.has("status")) {
        unfilteredRunRequests += 1;
      }
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  };

  try {
    const waitUntilPromises: Promise<unknown>[] = [];
    const env = {
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "20",
      EXACT_REVIEW_QUEUE: exactReviewQueue,
    };
    const context = {
      waitUntil(promise: Promise<unknown>) {
        waitUntilPromises.push(promise);
      },
    };
    const caller = new AbortController();
    const request = new Request("https://clawsweeper.openclaw.ai/api/status", {
      signal: caller.signal,
    });
    const [first, second] = await Promise.all([
      worker.fetch(request, env, context),
      worker.fetch(request, env, context),
    ]);

    assert.equal(first.headers.get("x-clawsweeper-cache"), "stale");
    assert.equal(second.headers.get("x-clawsweeper-cache"), "stale");
    const firstStatus = await first.json();
    const secondStatus = await second.json();
    assert.equal(firstStatus.pipeline[0].id, undefined);
    assert.equal(firstStatus.exact_review_queue.pending, 1);
    assert.equal(firstStatus.exact_review_queue.handoff_health.status, "stalled");
    assert.equal(firstStatus.freshness.state, "stale");
    assert.equal(firstStatus.freshness.cache_state, "stale");
    assert.equal(firstStatus.freshness.maximum_age_ms, 20_000);
    assert.equal(secondStatus.exact_review_queue.handoff_health.status, "stalled");
    assert.equal(queueReads, 0);
    const refreshes = 1;
    assert.equal(waitUntilPromises.length, refreshes, "each refresh owns its Worker lifetime");

    caller.abort();
    releaseFetch();
    await Promise.all(waitUntilPromises);
    assert.equal(unfilteredRunRequests, refreshes);
    assert.equal(queueReads, 2 * refreshes);

    const refreshed = await worker.fetch(request, env);
    assert.equal(refreshed.headers.get("x-clawsweeper-cache"), "fresh");
    const refreshedStatus = await refreshed.json();
    assert.deepEqual(refreshedStatus.pipeline, []);
    assert.equal(refreshedStatus.freshness.state, "fresh");
    assert.equal(refreshedStatus.freshness.cache_state, "fresh");
    assert.equal(refreshedStatus.exact_review_queue.pending, 7);
    assert.equal(refreshedStatus.exact_review_queue.handoff_health.status, "healthy");
    assert.equal(queueReads, 2 * refreshes);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard status survives cache persistence failures", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async (request: Request) => {
          if (request.url.includes("/api/status-cache/") || request.url.includes("recent-closed")) {
            throw new Error("cache unavailable");
          }
        },
      },
    },
  });
  globalThis.fetch = activePrFetch;

  try {
    const response = await worker.fetch(new Request("https://clawsweeper.openclaw.ai/api/status"), {
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-clawsweeper-cache"), "miss");
    const status = await response.json();
    assert.equal(status.fleet.active_workflow_runs, 1);
    assert.deepEqual(status.diagnostics.errors, []);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard caches historical closed-item telemetry across live status refreshes", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  let closedRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/actions/")) return jsonResponse({ workflow_runs: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") {
      closedRequests += 1;
      return jsonResponse([]);
    }
    return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  };

  try {
    const env = {
      STATUS_STORE: new MemoryKv(),
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "-1",
    };
    const request = new Request("https://clawsweeper.openclaw.ai/api/status");
    const first = await worker.fetch(request, env);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).recent.closed_stats.total, 0);
    assert.equal(closedRequests, 1);

    t.mock.timers.tick(2);
    const second = await worker.fetch(request, env);
    assert.equal(second.status, 200);
    assert.equal((await second.json()).recent.closed_stats.total, 0);
    assert.equal(closedRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard preserves repeated untargeted activity events", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  globalThis.fetch = activePrFetch;

  try {
    const env = {
      INGEST_TOKEN: "test-token",
      STATUS_STORE: new MemoryKv(),
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
    };
    for (const title of ["Probe one", "Probe two"]) {
      const ingest = await worker.fetch(
        new Request("https://clawsweeper.openclaw.ai/api/events", {
          method: "POST",
          headers: {
            Authorization: "Bearer test-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            event_type: "status.test",
            mode: "test",
            stage: "probe",
            status: "ok",
            title,
          }),
        }),
        env,
      );
      assert.equal(ingest.status, 200);
    }

    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(status.recent.events.length, 2);
    assert.ok(
      status.recent.events.every(
        (event: { event_type?: string; title?: string }) =>
          event.event_type === undefined && event.title === undefined,
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard counts review operations without retired repair counters", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  globalThis.fetch = activePrFetch;

  try {
    const env = {
      INGEST_TOKEN: "test-token",
      STATUS_STORE: new MemoryKv(),
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
    };
    const events = [
      { event_type: "clawsweeper.replacement_label_cleanup", stage: "executed" },
      { event_type: "clawsweeper.clawsweeper_self_rebase", stage: "dispatched" },
      { event_type: "clawsweeper.dispatched_failed_review_retry", stage: "dispatched" },
      { event_type: "clawsweeper.marked_failed_review_retry_exhausted", stage: "exhausted" },
      { event_type: "clawsweeper.bot_proof_decision_posted", stage: "posted" },
      { event_type: "clawsweeper.bot_proof_mantis_request_posted", stage: "posted" },
    ];
    for (const event of events) {
      const ingest = await worker.fetch(
        new Request("https://clawsweeper.openclaw.ai/api/events", {
          method: "POST",
          headers: {
            Authorization: "Bearer test-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            mode: "operation",
            status: "ok",
            ...event,
          }),
        }),
        env,
      );
      assert.equal(ingest.status, 200);
    }

    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.deepEqual(status.recent.operation_counts, {
      failed_review_retries: 1,
      failed_review_retry_exhaustions: 1,
      bot_owned_proof_decisions_requested: 1,
      bot_owned_proof_dispatches: 1,
    });
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard keeps workflow CI status when live PR checks fail", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/repos/openclaw/clawsweeper/actions/runs")) {
      return jsonResponse({
        workflow_runs: [
          {
            id: 1,
            name: "ClawSweeper",
            display_title: "Review event item openclaw/openclaw#80609",
            status: "in_progress",
            conclusion: null,
            html_url: "https://github.com/openclaw/clawsweeper/actions/runs/1",
            created_at: new Date(Date.now() - 60_000).toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      });
    }
    if (url.includes("/repos/openclaw/openclaw/pulls/80609")) {
      return new Response(JSON.stringify({ message: "rate limited" }), { status: 403 });
    }
    if (url.includes("/search/issues")) return jsonResponse({ items: [] });
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
        INCLUDE_CI_STATUS: "1",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(status.pipeline[0].ci.state, "pending");
    assert.equal(status.pipeline[0].ci.source, "workflow");
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard reuses live PR CI hydration within one status snapshot", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: new MemoryCache(),
    },
  });
  const runs = [
    {
      id: 8060901,
      name: "ClawSweeper",
      display_title: "Review event item openclaw/openclaw#80609",
      status: "in_progress",
      conclusion: null,
      html_url: "https://github.com/openclaw/clawsweeper/actions/runs/8060901",
      created_at: isoAgo(120_000),
      updated_at: isoAgo(10_000),
    },
    {
      id: 8060902,
      name: "ClawSweeper",
      display_title: "Review event item openclaw/openclaw#80609",
      status: "in_progress",
      conclusion: null,
      html_url: "https://github.com/openclaw/clawsweeper/actions/runs/8060902",
      created_at: isoAgo(90_000),
      updated_at: isoAgo(5_000),
    },
  ];
  let pullRequests = 0;
  let checkRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      const status = url.searchParams.get("status");
      return jsonResponse({ workflow_runs: !status || status === "in_progress" ? runs : [] });
    }
    if (/^\/repos\/openclaw\/clawsweeper\/actions\/runs\/\d+\/jobs$/.test(url.pathname)) {
      return jsonResponse({ jobs: [] });
    }
    if (url.pathname === "/repos/openclaw/openclaw/pulls/80609") {
      pullRequests += 1;
      return jsonResponse({ head: { sha: "head-80609" } });
    }
    if (url.pathname === "/repos/openclaw/openclaw/commits/head-80609/check-runs") {
      checkRequests += 1;
      return jsonResponse({
        check_runs: [
          {
            name: "test",
            status: "completed",
            conclusion: "success",
          },
        ],
      });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-intake.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
        INCLUDE_CI_STATUS: "1",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(response.status, 200);
    assert.equal(pullRequests, 1);
    assert.equal(checkRequests, 1);
    assert.deepEqual(
      status.pipeline.map((row: { ci: { source: string; state: string } }) => row.ci),
      [
        {
          state: "green",
          total: 1,
          failing: 0,
          pending: 0,
          source: "live",
        },
        {
          state: "green",
          total: 1,
          failing: 0,
          pending: 0,
          source: "live",
        },
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard counts active runs that are older than the latest unfiltered page", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      const status = url.searchParams.get("status");
      if (!status) {
        return jsonResponse({
          workflow_runs: [
            {
              id: 1,
              name: "recent completed run",
              display_title: "recent completed run",
              status: "completed",
              conclusion: "success",
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/1",
              created_at: "2026-05-14T06:40:00Z",
              updated_at: "2026-05-14T06:41:00Z",
            },
          ],
        });
      }
      if (status === "in_progress") {
        return jsonResponse({
          workflow_runs: [
            {
              id: 2,
              name: "Review event item openclaw/openclaw#81001",
              display_title: "Review event item openclaw/openclaw#81001",
              status: "in_progress",
              conclusion: null,
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/2",
              created_at: isoAgo(25 * 60_000),
              updated_at: isoAgo(20 * 60_000),
            },
            {
              id: 3,
              name: "Commit review openclaw/openclaw@abc123",
              display_title: "Commit review openclaw/openclaw@abc123",
              status: "in_progress",
              conclusion: null,
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/3",
              created_at: isoAgo(20 * 60_000),
              updated_at: isoAgo(15 * 60_000),
            },
            {
              id: 5,
              name: "spam comment intake",
              display_title: "github_activity",
              status: "in_progress",
              conclusion: null,
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/5",
              created_at: isoAgo(18 * 60_000),
              updated_at: isoAgo(16 * 60_000),
            },
            {
              id: 6,
              name: "ClawSweeper Live Dashboard CI Status",
              display_title: "ClawSweeper Live Dashboard CI Status",
              status: "in_progress",
              conclusion: null,
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/6",
              created_at: isoAgo(17 * 60_000),
              updated_at: isoAgo(15 * 60_000),
            },
          ],
        });
      }
      if (status === "queued") {
        return jsonResponse({
          workflow_runs: [
            {
              id: 4,
              name: "Review event item openclaw/openclaw#81002",
              display_title: "Review event item openclaw/openclaw#81002",
              status: "queued",
              conclusion: null,
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/4",
              created_at: isoAgo(30 * 60_000),
              updated_at: isoAgo(29 * 60_000),
            },
            {
              id: 7,
              name: "github activity to openclaw",
              display_title: "github_activity",
              status: "queued",
              conclusion: null,
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/7",
              created_at: isoAgo(31 * 60_000),
              updated_at: isoAgo(30 * 60_000),
            },
          ],
        });
      }
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(status.fleet.active_workflow_runs, 3);
    assert.equal(status.fleet.queued_workflow_runs, 1);
    assert.equal(status.fleet.support_workflow_runs, 3);
    assert.equal(status.fleet.support_queued_workflow_runs, 1);
    assert.equal(status.fleet.worker_budget, 32);
    assert.equal(status.pipeline.length, 3);
    assert.ok(status.pipeline.every((row: { id?: number }) => row.id === undefined));
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard surfaces stale queue ghosts as zombies without active cards", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      const status = url.searchParams.get("status");
      if (!status) return jsonResponse({ workflow_runs: [] });
      if (status === "queued") {
        return jsonResponse({
          workflow_runs: [
            {
              id: 1,
              name: "ClawSweeper Commit Review",
              display_title: "clawsweeper_commit_review",
              status: "queued",
              conclusion: null,
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/1",
              created_at: isoAgo(7 * 24 * 60 * 60_000),
              updated_at: isoAgo(7 * 24 * 60 * 60_000),
            },
            {
              id: 2,
              name: "Review event item openclaw/openclaw#81002",
              display_title: "Review event item openclaw/openclaw#81002",
              status: "queued",
              conclusion: null,
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/2",
              created_at: isoAgo(10 * 60_000),
              updated_at: isoAgo(9 * 60_000),
            },
          ],
        });
      }
      if (status === "pending") {
        return jsonResponse({
          workflow_runs: [
            {
              id: 3,
              run_attempt: 2,
              name: "repair publish cluster results",
              display_title: "repair publish cluster results",
              status: "pending",
              conclusion: null,
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/3",
              created_at: isoAgo(90 * 60_000),
              updated_at: isoAgo(90 * 60_000),
            },
          ],
        });
      }
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(status.fleet.active_workflow_runs, 2);
    assert.equal(status.fleet.queued_workflow_runs, 2);
    assert.equal(status.operational_health.queued_runs, 3);
    assert.equal(status.operational_health.queued_over_threshold, 0);
    assert.equal(status.operational_health.oldest_queued_minutes, 10);
    assert.equal(status.operational_health.zombie_queued_runs, 1);
    assert.equal(status.operational_health.oldest_zombie_queued_minutes, 7 * 24 * 60);
    assert.equal(status.operational_health.wedged_rerun_runs, 1);
    assert.equal(status.operational_health.oldest_wedged_rerun_minutes, 90);
    assert.equal(status.operational_health.status, "healthy");
    assert.equal(status.pipeline.length, 2);
    assert.equal(status.pipeline[0].id, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard health retains in-progress runs beyond the queued ghost window", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: { match: async () => undefined, put: async () => undefined } },
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      const status = url.searchParams.get("status");
      if (status === "in_progress") {
        return jsonResponse({
          workflow_runs: [
            {
              id: 8,
              name: "repair cluster worker",
              display_title: "repair cluster worker",
              status: "in_progress",
              created_at: isoAgo(8 * 60 * 60_000),
              run_started_at: isoAgo(7 * 60 * 60_000),
              updated_at: isoAgo(60_000),
            },
          ],
        });
      }
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
      },
      { waitUntil: () => undefined },
    );
    const status = await response.json();
    assert.equal(status.operational_health.status, "stalled");
    assert.equal(status.operational_health.running_over_threshold, 1);
    assert.equal(status.operational_health.oldest_running_minutes, 420);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard exposes ClawSweeper-owned recent closes and 24h stats", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  const issuePages: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const closedAt = new Date(Date.now() - 60_000).toISOString();
    const olderClosedAt = new Date(Date.now() - 120_000).toISOString();
    const oldestClosedAt = new Date(Date.now() - 180_000).toISOString();
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      return jsonResponse({ workflow_runs: [] });
    }
    if (
      url.pathname === "/repos/openclaw/openclaw/issues" &&
      url.searchParams.get("page") === "1"
    ) {
      issuePages.push(url.searchParams.get("page") || "");
      return jsonResponse([
        {
          number: 81,
          title: "Fix stale terminal resize state",
          html_url: "https://github.com/openclaw/openclaw/pull/81",
          closed_at: olderClosedAt,
          closed_by: { login: "clawsweeper[bot]" },
          pull_request: {},
        },
        {
          number: 82,
          title: "Alternate app closed issue",
          html_url: "https://github.com/openclaw/openclaw/issues/82",
          closed_at: oldestClosedAt,
          closed_by: { login: "openclaw-clawsweeper[bot]" },
        },
        {
          number: 80,
          title: "Remove old session warning",
          html_url: "https://github.com/openclaw/openclaw/issues/80",
          closed_at: closedAt,
          closed_by: { login: "clawsweeper[bot]" },
        },
        {
          number: 79,
          title: "Human closed issue",
          html_url: "https://github.com/openclaw/openclaw/issues/79",
          closed_at: closedAt,
          closed_by: { login: "steipete" },
        },
      ]);
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues") {
      issuePages.push(url.searchParams.get("page") || "");
      return jsonResponse([]);
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const env = {
      INGEST_TOKEN: "test-token",
      STATUS_STORE: new MemoryKv(),
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
    };
    const ingest = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/events", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          event_type: "clawsweeper.item_closed",
          mode: "item_closed",
          stage: "close_duplicate",
          status: "executed",
          repository: "openclaw/openclaw",
          item_url: "https://github.com/openclaw/openclaw/issues/80",
          title: "Real close event",
        }),
      }),
      env,
    );
    assert.equal(ingest.status, 200);
    const prClose = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/events", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          event_type: "clawsweeper.item_closed",
          mode: "item_closed",
          stage: "close_fixed_by_candidate",
          status: "executed",
          repository: "openclaw/openclaw",
          item_url: "https://github.com/openclaw/openclaw/issues/81",
          title: "Explicit PR close event",
        }),
      }),
      env,
    );
    assert.equal(prClose.status, 200);
    const blocked = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/events", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          event_type: "clawsweeper.close_blocked",
          mode: "close_blocked",
          stage: "close_duplicate",
          status: "blocked",
          repository: "openclaw/openclaw",
          item_url: "https://github.com/openclaw/openclaw/issues/82",
          title: "Blocked close event",
        }),
      }),
      env,
    );
    assert.equal(blocked.status, 200);

    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.deepEqual(status.recent.closed_items, []);
    assert.equal(status.recent.events.length, 4);
    assert.ok(
      status.recent.events.every(
        (event: { item_number?: number; source?: string; title?: string }) =>
          event.item_number === undefined &&
          event.source === undefined &&
          event.title === undefined,
      ),
    );
    assert.deepEqual(status.recent.closed_stats, {
      window_hours: 24,
      since: status.recent.closed_stats.since,
      total: 3,
      issues: 2,
      prs: 1,
    });
    assert.equal(status.recent.closed_stats.by_repository, undefined);
    assert.ok(new Date(status.recent.closed_stats.since).getTime() <= Date.now());
    assert.deepEqual(issuePages, ["1"]);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard fetches additional closed pages only when the first page is full", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  const issuePages: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const closedAt = new Date(Date.now() - 60_000).toISOString();
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues") {
      const page = url.searchParams.get("page") || "";
      issuePages.push(page);
      if (page === "1") {
        return jsonResponse(
          Array.from({ length: 100 }, (_, index) => ({
            number: index + 1,
            title: `Human closed issue ${index + 1}`,
            html_url: `https://github.com/openclaw/openclaw/issues/${index + 1}`,
            closed_at: closedAt,
            closed_by: { login: "steipete" },
          })),
        );
      }
      if (page === "2") {
        return jsonResponse([
          {
            number: 101,
            title: "ClawSweeper closed overflow page issue",
            html_url: "https://github.com/openclaw/openclaw/issues/101",
            closed_at: closedAt,
            closed_by: { login: "clawsweeper[bot]" },
          },
        ]);
      }
      return jsonResponse([]);
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.deepEqual(
      issuePages.sort((left, right) => Number(left) - Number(right)),
      ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
    );
    assert.deepEqual(status.recent.closed_stats, {
      window_hours: 24,
      since: status.recent.closed_stats.since,
      total: 1,
      issues: 1,
      prs: 0,
    });
    assert.equal(status.recent.closed_stats.by_repository, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

for (const scenario of [
  { name: "authenticated linked issue", authenticated: true, count: 1, searchFails: false },
  { name: "public linked issue without auth", authenticated: false, count: 1, searchFails: false },
  {
    name: "linked issues above the former enrichment cap",
    authenticated: true,
    count: 241,
    searchFails: false,
  },
  { name: "genuine Search failure", authenticated: true, count: 1, searchFails: true },
]) {
  test(`triage counts skip GraphQL for ${scenario.name}`, async () => {
    const originalFetch = globalThis.fetch;
    const originalCaches = globalThis.caches;
    Object.defineProperty(globalThis, "caches", {
      configurable: true,
      value: { default: new MemoryCache() },
    });
    const requests: string[] = [];
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      requests.push(url.pathname);
      if (url.pathname.endsWith("/labels")) {
        return jsonResponse([{ name: "clawsweeper:linked-pr-open" }]);
      }
      if (url.pathname === "/search/issues") {
        if (scenario.searchFails) return new Response("synthetic Search failure", { status: 503 });
        const perPage = Number(url.searchParams.get("per_page"));
        const offset = (Number(url.searchParams.get("page")) - 1) * perPage;
        return jsonResponse({
          total_count: scenario.count,
          items: Array.from({ length: scenario.count }, (_, index) =>
            triageIssue(index + 1, ["clawsweeper:linked-pr-open"]),
          ).slice(offset, offset + perPage),
        });
      }
      if (url.pathname === "/graphql")
        return new Response("synthetic GraphQL failure", { status: 503 });
      throw new Error(`unexpected fetch ${url.pathname}`);
    };
    try {
      const response = await worker.fetch(
        new Request("https://clawsweeper.openclaw.ai/api/triage"),
        {
          TARGET_REPOS: "openclaw/openclaw",
          TRIAGE_ITEMS_PER_VIEW: "500",
          ...(scenario.authenticated ? { GITHUB_TOKEN: "synthetic-fixture-only" } : {}),
        },
      );
      const snapshot = await response.json();
      assert.equal(response.status, 200);
      assert.equal(snapshot.schema_version, 2);
      assert.equal(snapshot.complete, !scenario.searchFails);
      assert.equal(snapshot.error_count, scenario.searchFails ? 1 : 0);
      assert.equal(snapshot.counts.clawsweeper, scenario.searchFails ? 0 : scenario.count);
      assert.equal(snapshot.counts["already-has-pr"], scenario.searchFails ? 0 : scenario.count);
      assert.ok(snapshot.views.every((view: { items: unknown[] }) => view.items.length === 0));
      assert.ok(requests.includes("/search/issues"));
      assert.equal(requests.filter((pathname) => pathname === "/graphql").length, 0);
    } finally {
      globalThis.fetch = originalFetch;
      Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
    }
  });
}

test("triage focused views use direct search when broad snapshot is capped", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  let readyPerPage = "";
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/openclaw/labels") {
      return jsonResponse([
        { name: "clawsweeper:queueable-fix", color: "0E8A16", description: "" },
        { name: "clawsweeper:no-new-fix-pr", color: "BFDADC", description: "" },
      ]);
    }
    if (url.pathname === "/search/issues") {
      const query = url.searchParams.get("q") || "";
      const page = url.searchParams.get("page") || "1";
      if (
        query.includes('label:"clawsweeper:queueable-fix"') &&
        query.includes('-label:"clawsweeper:no-new-fix-pr"')
      ) {
        readyPerPage = url.searchParams.get("per_page") || "";
        return jsonResponse({
          total_count: 2,
          items: [
            triageIssue(102, ["clawsweeper:queueable-fix", "impact:message-loss"]),
            triageIssue(100, ["clawsweeper:queueable-fix"]),
          ],
        });
      }
      if (query.includes('label:"clawsweeper:no-new-fix-pr","clawsweeper:queueable-fix"')) {
        return jsonResponse({
          total_count: 501,
          items:
            page === "1"
              ? [
                  triageIssue(102, ["clawsweeper:queueable-fix"]),
                  triageIssue(101, ["clawsweeper:queueable-fix", "clawsweeper:no-new-fix-pr"]),
                ]
              : [],
        });
      }
      return jsonResponse({ total_count: 0, items: [] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/triage"),
      {
        TARGET_REPOS: "openclaw/openclaw",
        TRIAGE_ITEMS_PER_VIEW: "500",
        TRIAGE_CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const snapshot = await response.json();
    const root = snapshot.views.find((view: { id: string }) => view.id === "clawsweeper");
    const ready = snapshot.views.find((view: { id: string }) => view.id === "ready-candidates");
    assert.equal(snapshot.schema_version, 2);
    assert.equal(snapshot.complete, true);
    assert.equal(snapshot.error_count, 0);
    assert.equal(root.item_limit, 500);
    assert.equal(ready.total_count, 2);
    assert.equal(ready.item_limit, 100);
    assert.equal(readyPerPage, "100");
    assert.deepEqual(ready.items, []);
    assert.equal(ready.title, "Ready candidates");
    assert.equal(snapshot.counts["ready-candidates"], 2);
    assert.equal(snapshot.source, undefined);
    assert.equal(snapshot.routing_groups, undefined);
    assert.equal(snapshot.diagnostics, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("triage focused fallbacks reserve search budget for later repos", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  let searchRequests = 0;
  let sawSecondRepoLastRootPage = false;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/labels")) {
      return jsonResponse([
        { name: "clawsweeper:queueable-fix", color: "0E8A16", description: "" },
        { name: "clawsweeper:no-new-fix-pr", color: "BFDADC", description: "" },
      ]);
    }
    if (url.pathname === "/search/issues") {
      searchRequests += 1;
      const query = url.searchParams.get("q") || "";
      const page = url.searchParams.get("page") || "1";
      const repo = query.includes("repo:openclaw/other") ? "openclaw/other" : "openclaw/openclaw";
      if (repo === "openclaw/other" && page === "4") {
        sawSecondRepoLastRootPage = true;
      }
      if (
        query.includes('label:"clawsweeper:queueable-fix"') &&
        query.includes('-label:"clawsweeper:no-new-fix-pr"')
      ) {
        return jsonResponse({
          total_count: 1,
          items: [triageIssue(repo, 200, ["clawsweeper:queueable-fix"])],
        });
      }
      if (query.includes('label:"clawsweeper:no-new-fix-pr","clawsweeper:queueable-fix"')) {
        return jsonResponse({
          total_count: 401,
          items: [triageIssue(repo, Number(page), ["clawsweeper:queueable-fix"])],
        });
      }
      return jsonResponse({ total_count: 0, items: [] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/triage"),
      {
        TRIAGE_TARGET_REPOS: "openclaw/openclaw,openclaw/other",
        TRIAGE_ITEMS_PER_VIEW: "500",
        TRIAGE_CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const snapshot = await response.json();
    assert.equal(searchRequests, 9);
    assert.equal(sawSecondRepoLastRootPage, true);
    assert.equal(snapshot.complete, false);
    assert.ok(snapshot.error_count > 0);
    assert.equal(snapshot.source, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("triage focused search errors fall back to loaded broad rows", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/labels")) {
      return jsonResponse([
        { name: "clawsweeper:queueable-fix", color: "0E8A16", description: "" },
        { name: "clawsweeper:no-new-fix-pr", color: "BFDADC", description: "" },
      ]);
    }
    if (url.pathname === "/search/issues") {
      const query = url.searchParams.get("q") || "";
      const page = url.searchParams.get("page") || "1";
      if (
        query.includes('label:"clawsweeper:queueable-fix"') &&
        query.includes('-label:"clawsweeper:no-new-fix-pr"')
      ) {
        throw new Error("focused search failed");
      }
      if (query.includes('label:"clawsweeper:no-new-fix-pr","clawsweeper:queueable-fix"')) {
        return jsonResponse({
          total_count: 501,
          items:
            page === "1"
              ? [
                  triageIssue(102, ["clawsweeper:queueable-fix"]),
                  triageIssue(101, ["clawsweeper:queueable-fix", "clawsweeper:no-new-fix-pr"]),
                ]
              : [],
        });
      }
      return jsonResponse({ total_count: 0, items: [] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/triage"),
      {
        TARGET_REPOS: "openclaw/openclaw",
        TRIAGE_ITEMS_PER_VIEW: "500",
        TRIAGE_CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const snapshot = await response.json();
    const ready = snapshot.views.find((view: { id: string }) => view.id === "ready-candidates");
    assert.equal(ready.total_count, 1);
    assert.deepEqual(ready.items, []);
    assert.equal(snapshot.complete, false);
    assert.equal(snapshot.error_count, 1);
    assert.equal(snapshot.diagnostics, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("triage skips repos after root search budget is exhausted", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  let searchRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/labels")) {
      return jsonResponse([
        { name: "clawsweeper:queueable-fix", color: "0E8A16", description: "" },
      ]);
    }
    if (url.pathname === "/search/issues") {
      searchRequests += 1;
      return jsonResponse({
        total_count: 1,
        items: [triageIssue(searchRequests, ["clawsweeper:queueable-fix"])],
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const repos = Array.from({ length: 10 }, (_, index) => `openclaw/repo-${index}`).join(",");
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/triage"),
      {
        TRIAGE_TARGET_REPOS: repos,
        TRIAGE_CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const snapshot = await response.json();
    assert.equal(searchRequests, 9);
    assert.equal(snapshot.complete, false);
    assert.ok(snapshot.error_count > 0);
    assert.equal(snapshot.source, undefined);
    assert.equal(snapshot.diagnostics, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("triage debits failed root searches from the search budget", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  let searchRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/labels")) {
      return jsonResponse([
        { name: "clawsweeper:queueable-fix", color: "0E8A16", description: "" },
      ]);
    }
    if (url.pathname === "/search/issues") {
      searchRequests += 1;
      throw new Error("root search failed");
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const repos = Array.from({ length: 10 }, (_, index) => `openclaw/repo-${index}`).join(",");
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/triage"),
      {
        TRIAGE_TARGET_REPOS: repos,
        TRIAGE_CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const snapshot = await response.json();
    assert.equal(searchRequests, 9);
    assert.equal(snapshot.complete, false);
    assert.ok(snapshot.error_count > 0);
    assert.equal(snapshot.source, undefined);
    assert.equal(snapshot.diagnostics, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("triage uses ClawSweeper GitHub App credentials when no static token is configured", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  let sawAppJwt = false;
  let sawInstallationToken = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = String(new Headers(init?.headers).get("authorization") || "");
    if (url.pathname === "/repos/openclaw/openclaw/installation") {
      sawAppJwt = authorization.startsWith("Bearer ");
      return jsonResponse({ id: 12345 });
    }
    if (url.pathname === "/app/installations/12345/access_tokens") {
      sawAppJwt = authorization.startsWith("Bearer ");
      return jsonResponse({
        token: "installation-token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    if (url.pathname === "/repos/openclaw/openclaw/labels") {
      sawInstallationToken = authorization === "Bearer installation-token";
      return jsonResponse([{ name: "clawsweeper:queueable-fix", color: "0E8A16" }]);
    }
    if (url.pathname === "/search/issues") {
      sawInstallationToken = authorization === "Bearer installation-token";
      return jsonResponse({
        total_count: 1,
        items: [triageIssue(101, ["clawsweeper:queueable-fix"])],
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/triage"),
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: String(privateKey),
        TARGET_REPOS: "openclaw/openclaw",
        TRIAGE_CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const snapshot = await response.json();
    assert.equal(response.status, 200);
    assert.equal(snapshot.complete, true);
    assert.equal(snapshot.error_count, 0);
    assert.equal(sawAppJwt, true);
    assert.equal(sawInstallationToken, true);
    assert.equal(snapshot.source, undefined);
    assert.equal(snapshot.diagnostics, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("triage writes and reprojects aggregate-only fresh cache bodies", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const cache = new MemoryCache();
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: cache },
  });
  const marker = "synthetic-fresh-identity-marker";
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/labels")) {
      return jsonResponse([{ name: "clawsweeper:queueable-fix", color: "0E8A16" }]);
    }
    if (url.pathname === "/search/issues") {
      return jsonResponse({
        total_count: 1,
        items: [
          {
            ...triageIssue(7, ["clawsweeper:queueable-fix"]),
            title: marker,
            html_url: `https://invalid.example/${marker}?item=7`,
            user: { login: marker },
          },
        ],
      });
    }
    throw new Error("unexpected synthetic request");
  };

  try {
    const writes: Promise<unknown>[] = [];
    const request = new Request("https://clawsweeper.openclaw.ai/api/triage");
    const first = await worker.fetch(
      request,
      { TARGET_REPOS: "synthetic/target" },
      { waitUntil: (write) => writes.push(write) },
    );
    const firstSnapshot = await first.json();
    assert.equal(firstSnapshot.counts.clawsweeper, 1);
    assert.equal(firstSnapshot.counts["ready-candidates"], 1);
    assert.deepEqual(firstSnapshot.views[0].items, []);
    assert.doesNotMatch(JSON.stringify(firstSnapshot), new RegExp(marker, "i"));
    await Promise.all(writes);

    const cached = await cache.match(
      new Request("https://clawsweeper.openclaw.ai/api/triage-cache/v3/fresh"),
    );
    assert.ok(cached);
    const cachedText = await cached.text();
    assert.doesNotMatch(cachedText, new RegExp(marker, "i"));
    assert.deepEqual(JSON.parse(cachedText), firstSnapshot);

    globalThis.fetch = async () => {
      throw new Error("fresh projected cache should avoid collection");
    };
    const replay = await worker.fetch(request, {}, { waitUntil: () => undefined });
    assert.deepEqual(await replay.json(), firstSnapshot);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("PR proof triage keeps legacy Telegram labels visible during migration", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const queries: string[] = [];
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: new MemoryCache() },
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/labels")) {
      return jsonResponse([
        { name: "mantis: telegram-visible-proof", color: "57606A" },
        { name: "proof: telegram-e2e", color: "57606A" },
      ]);
    }
    if (url.pathname === "/search/issues") {
      const query = url.searchParams.get("q") ?? "";
      queries.push(query);
      return jsonResponse({
        total_count:
          query.includes("mantis: telegram-visible-proof") && query.includes("proof: telegram-e2e")
            ? 1
            : 0,
        items: [],
      });
    }
    throw new Error(`unexpected synthetic request: ${url.pathname}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/pr-proof-triage"),
      { TARGET_REPOS: "synthetic/target", TRIAGE_CACHE_TTL_SECONDS: "0" },
      { waitUntil: () => undefined },
    );
    const snapshot = await response.json();
    assert.equal(response.status, 200);
    assert.equal(snapshot.counts["telegram-proof"], 1);
    assert.ok(
      queries.some(
        (query) =>
          query.includes("mantis: telegram-visible-proof") && query.includes("proof: telegram-e2e"),
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("triage routes reproject raw legacy fresh caches", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.fetch = async () => {
    throw new Error("valid legacy cache should avoid collection");
  };

  try {
    for (const fixture of [
      {
        endpoint: "/api/triage",
        cachePath: "/api/triage-cache/v2/fresh",
        viewIds: ISSUE_TRIAGE_VIEW_IDS,
      },
      {
        endpoint: "/api/pr-proof-triage",
        cachePath: "/api/pr-proof-triage-cache/v1/fresh",
        viewIds: PROOF_TRIAGE_VIEW_IDS,
      },
    ]) {
      const marker = `synthetic-legacy-marker-${fixture.viewIds.length}`;
      const cache = new MemoryCache();
      await cache.put(
        new Request(`https://clawsweeper.openclaw.ai${fixture.cachePath}`),
        jsonResponse(legacyTriageSnapshot(fixture.viewIds, marker)),
      );
      Object.defineProperty(globalThis, "caches", {
        configurable: true,
        value: { default: cache },
      });
      const response = await worker.fetch(
        new Request(`https://clawsweeper.openclaw.ai${fixture.endpoint}`),
        {},
        { waitUntil: () => undefined },
      );
      assert.equal(response.status, 200);
      assertAggregateTriageSnapshot(await response.json(), fixture.viewIds, marker);
    }
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("triage reprojects raw legacy stale cache after a failed refresh", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const marker = "synthetic-stale-identity-marker";
  const cache = new MemoryCache();
  await cache.put(
    new Request("https://clawsweeper.openclaw.ai/api/triage-cache/v2/stale"),
    jsonResponse(legacyTriageSnapshot(ISSUE_TRIAGE_VIEW_IDS, marker)),
  );
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: cache },
  });
  globalThis.fetch = async () => {
    throw new Error(marker);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/triage"),
      { TARGET_REPOS: "synthetic/target" },
      { waitUntil: () => undefined },
    );
    assertAggregateTriageSnapshot(await response.json(), ISSUE_TRIAGE_VIEW_IDS, marker);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("triage fails closed for malformed, nested, and over-cap cached input", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const marker = "synthetic-malformed-identity-marker";
  const mutations = [
    (snapshot: ReturnType<typeof legacyTriageSnapshot>) => {
      snapshot.generated_at = "1171";
    },
    (snapshot: ReturnType<typeof legacyTriageSnapshot>) => {
      snapshot.generated_at = `https://invalid.example/${marker}?timestamp=1`;
    },
    (snapshot: ReturnType<typeof legacyTriageSnapshot>) => {
      snapshot.views[0].total_count = { nested: { marker } } as unknown as number;
    },
    (snapshot: ReturnType<typeof legacyTriageSnapshot>) => {
      snapshot.views[0].item_limit = 100;
      snapshot.views[0].items = Array.from({ length: 101 }, () => ({
        repository: marker,
        number: 1,
        title: marker,
        url: marker,
        author: marker,
        assignees: [marker],
        labels: [{ name: marker }],
      }));
    },
    (snapshot: ReturnType<typeof legacyTriageSnapshot>) => {
      (snapshot.diagnostics as { errors: string[] }).errors = Array.from(
        { length: 21 },
        () => marker,
      );
    },
  ];

  try {
    for (const mutate of mutations) {
      const cache = new MemoryCache();
      const malformed = legacyTriageSnapshot(ISSUE_TRIAGE_VIEW_IDS, marker);
      mutate(malformed);
      await cache.put(
        new Request("https://clawsweeper.openclaw.ai/api/triage-cache/v3/fresh"),
        jsonResponse(malformed),
      );
      Object.defineProperty(globalThis, "caches", {
        configurable: true,
        value: { default: cache },
      });
      const env = {};
      Object.defineProperty(env, "TRIAGE_TARGET_REPOS", {
        get() {
          throw new Error(marker);
        },
      });
      const response = await worker.fetch(
        new Request("https://clawsweeper.openclaw.ai/api/triage"),
        env,
        { waitUntil: () => undefined },
      );
      const snapshot = await response.json();
      assert.equal(snapshot.schema_version, 2);
      assert.equal(snapshot.generated_at, null);
      assert.equal(snapshot.complete, false);
      assert.equal(snapshot.error_count, 1);
      assert.deepEqual(
        Object.values(snapshot.counts),
        ISSUE_TRIAGE_VIEW_IDS.map(() => null),
      );
      assert.deepEqual(
        snapshot.views.map((view: { items: unknown[] }) => view.items),
        ISSUE_TRIAGE_VIEW_IDS.map(() => []),
      );
      assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(marker, "i"));
    }
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

function statusTurn() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function statusGate<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

for (const stalled of ["cache-read", "cache-body"] as const) {
  test(`status deadline covers a stalled ${stalled} and permits the next refresh`, async (context) => {
    const originalFetch = globalThis.fetch;
    const originalCaches = globalThis.caches;
    const gate = statusGate<Response | undefined>();
    const bodyGate = statusGate<string>();
    let stalledNow = true;
    let reads = 0;
    const cache = {
      async match() {
        reads += 1;
        if (!stalledNow) return undefined;
        if (stalled === "cache-read") return gate.promise;
        return {
          clone: () => ({ json: async () => JSON.parse(await bodyGate.promise) }),
        } as unknown as Response;
      },
      put: async () => undefined,
    };
    Object.defineProperty(globalThis, "caches", { configurable: true, value: { default: cache } });
    globalThis.fetch = activePrFetch;
    context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    try {
      const request = new Request("https://clawsweeper.openclaw.ai/api/status");
      const env = Object.freeze({ CACHE_TTL_SECONDS: "0" });
      const pending = worker.fetch(request, env);
      await statusTurn();
      context.mock.timers.tick(STATUS_REFRESH_TIMEOUT_MS);
      const response = await pending;
      const status = await response.json();
      assert.equal(response.status, 200);
      assert.equal(status.public_projection_complete, false);
      assert.equal(status.freshness.state, "unavailable");
      assert.equal(reads, 1, "expired cache work must not admit a second read");
      stalledNow = false;
      gate.release(undefined);
      bodyGate.release("{}");
      await statusTurn();
      assert.equal(reads, 1);
      const healthy = await (await worker.fetch(request, env)).json();
      assert.equal(healthy.fleet.active_workflow_runs, 1);
      assert.equal(healthy.public_projection_complete, true);
    } finally {
      stalledNow = false;
      gate.release(undefined);
      bodyGate.release("{}");
      await statusTurn();
      context.mock.timers.reset();
      globalThis.fetch = originalFetch;
      Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
    }
  });
}

test("cold status deadline releases its owner and stops additional job waves and pages", async (context) => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const gates: Array<ReturnType<typeof statusGate<Response>>> = [];
  let jobRequests = 0;
  let abortedRequests = 0;
  let collecting = true;
  const background: Promise<unknown>[] = [];
  const runs = Array.from({ length: 13 }, (_, index) => ({
    id: 8000 + index,
    name: "Review ClawSweeper items",
    display_title: `Review event item openclaw/openclaw#${9000 + index}`,
    status: "in_progress",
    conclusion: null,
    created_at: isoAgo(1000),
    updated_at: isoAgo(1000),
  }));
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: new MemoryCache() },
  });
  globalThis.fetch = async (input, init) => {
    if (!collecting) return activePrFetch(input);
    const url = new URL(String(input));
    if (url.pathname.endsWith("/actions/runs")) {
      const status = url.searchParams.get("status");
      return jsonResponse({ workflow_runs: !status || status === "in_progress" ? runs : [] });
    }
    if (url.pathname.endsWith("/jobs")) {
      jobRequests += 1;
      init?.signal?.addEventListener(
        "abort",
        () => {
          abortedRequests += 1;
        },
        { once: true },
      );
      const gate = statusGate<Response>();
      gates.push(gate);
      return gate.promise;
    }
    return activePrFetch(input);
  };
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  try {
    const request = new Request("https://clawsweeper.openclaw.ai/api/status");
    const env = {
      CACHE_TTL_SECONDS: "0",
      WORKER_JOB_FETCH_CONCURRENCY: "12",
      WORKER_DETAIL_RUN_LIMIT: "128",
    };
    const ctx = { waitUntil: (promise: Promise<unknown>) => background.push(promise) };
    const pending = worker.fetch(request, env, ctx);
    const follower = worker.fetch(request, { ...env }, ctx);
    await statusTurn();
    assert.equal(jobRequests, 12);
    assert.equal(background.length, 1, "cold refresh cleanup belongs to the Worker context");
    context.mock.timers.tick(STATUS_REFRESH_TIMEOUT_MS);
    const status = await (await pending).json();
    assert.equal(status.public_projection_complete, false);
    assert.equal((await (await follower).json()).public_projection_complete, false);
    assert.equal(abortedRequests, 12);
    await Promise.all(background);
    for (const gate of gates)
      gate.release(
        jsonResponse({
          total_count: 101,
          jobs: Array.from({ length: 100 }, (_, index) => ({
            id: index + 1,
            name: "Review item",
            status: "in_progress",
            steps: [],
          })),
        }),
      );
    await statusTurn();
    assert.equal(jobRequests, 12, "neither another run nor another page may start after expiry");
    collecting = false;
    for (const callerEnv of [env, { ...env }]) {
      const healthy = await (await worker.fetch(request, callerEnv, ctx)).json();
      assert.equal(healthy.public_projection_complete, true);
      assert.equal(healthy.fleet.active_workflow_runs, 1);
    }
  } finally {
    for (const gate of gates) gate.release(jsonResponse({ total_count: 0, jobs: [] }));
    await statusTurn();
    context.mock.timers.reset();
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("stalled final publication cannot suppress a later healthy snapshot", async (context) => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const gate = statusGate<void>();
  let count = 17;
  let storeWrites = 0;
  let cacheWrites = 0;
  let published: any = null;
  let serveCache = false;
  const memoryCache = new MemoryCache();
  const pending: Promise<unknown>[] = [];
  const store = {
    async get(key: string) {
      assert.equal(this, store, "cloned status env must retain the binding object");
      if (!key.startsWith("snapshot:bay-scope:v2:")) return null;
      return JSON.stringify({
        ...publicationStatusFixture(),
        fleet: { active_workflow_runs: 1, active_codex_jobs: count },
      });
    },
    async put(key: string, body: string) {
      assert.equal(this, store);
      assert.equal(key, "snapshot:bay-scope:v2:_");
      storeWrites += 1;
      if (storeWrites === 1) await gate.promise;
      published = JSON.parse(body);
    },
  };
  const cache = {
    match: async (request: Request) => (serveCache ? memoryCache.match(request) : undefined),
    async put(request: Request, response: Response) {
      cacheWrites += 1;
      if (cacheWrites <= 2) await gate.promise;
      await memoryCache.put(request, response);
    },
  };
  Object.defineProperty(globalThis, "caches", { configurable: true, value: { default: cache } });
  globalThis.fetch = async () => {
    throw new Error("durable reuse must not call GitHub");
  };
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  try {
    const env = Object.freeze({ STATUS_STORE: store, CACHE_TTL_SECONDS: "60" });
    const ctx = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) };
    const request = new Request("https://clawsweeper.openclaw.ai/api/status");
    const first = await (await worker.fetch(request, env, ctx)).json();
    assert.equal(first.fleet.active_codex_jobs, 17);
    assert.equal(storeWrites, 1);
    assert.equal(cacheWrites, 2);
    context.mock.timers.tick(STATUS_REFRESH_TIMEOUT_MS + 60_000);
    count = 18;
    const second = await (await worker.fetch(request, { ...env }, ctx)).json();
    assert.equal(second.fleet.active_codex_jobs, 18);
    await statusTurn();
    assert.equal(storeWrites, 2, "a pending write must not suppress later publication");
    assert.equal(cacheWrites, 4);
    assert.equal(published.fleet.active_codex_jobs, 18);
    serveCache = true;
    assert.equal(
      (await (await worker.fetch(request, env, ctx)).json()).fleet.active_codex_jobs,
      18,
    );
    gate.release();
    await Promise.all(pending);
    assert.equal(
      published.fleet.active_codex_jobs,
      17,
      "accepted final write survives collection close",
    );
    const late = await (await worker.fetch(request, env, ctx)).json();
    assert.equal(late.fleet.active_codex_jobs, 17);
    assert.equal(late.generated_at, first.generated_at);
    assert.equal(late.freshness.state, "stale", "late complete writes retain their actual age");
  } finally {
    gate.release();
    await Promise.allSettled(pending);
    context.mock.timers.reset();
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("status timeout does not cancel shared GitHub App token acquisition", async (context) => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const tokenGate = statusGate<Response>();
  const tokenStarted = statusGate<void>();
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  let tokenRequests = 0;
  let tokenSignal: AbortSignal | null | undefined;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: { match: async () => undefined, put: async () => undefined } },
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/app/installations/456789/access_tokens") {
      tokenRequests += 1;
      tokenSignal = init?.signal;
      tokenStarted.release();
      return tokenGate.promise;
    }
    if (url.pathname === "/auth-probe") return jsonResponse({ ok: true });
    if (url.pathname.includes("/actions/")) return jsonResponse({ workflow_runs: [] });
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname.endsWith("/issues")) return jsonResponse([]);
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const env = Object.freeze({
    CLAWSWEEPER_APP_CLIENT_ID: "status-lifetime-test",
    CLAWSWEEPER_APP_INSTALLATION_ID: "456789",
    CLAWSWEEPER_APP_PRIVATE_KEY: String(privateKey),
    TARGET_REPOS: "openclaw/openclaw",
    CACHE_TTL_SECONDS: "0",
  });
  try {
    const statusRequest = worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
    );
    await tokenStarted.promise;
    const unscopedReader = githubJsonForTest(env, "/auth-probe");
    context.mock.timers.tick(STATUS_REFRESH_TIMEOUT_MS);
    const status = await (await statusRequest).json();
    assert.equal(status.public_projection_complete, false);
    assert.equal(tokenRequests, 1);
    assert.equal(tokenSignal?.aborted, false, "status owns the wait, not shared authentication");
    tokenGate.release(
      jsonResponse({
        token: "synthetic-status-token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
    assert.deepEqual(await unscopedReader, { ok: true });
    await worker.fetch(new Request("https://clawsweeper.openclaw.ai/api/status"), { ...env });
    assert.equal(tokenRequests, 1, "subsequent status reuses the same value-keyed token");
  } finally {
    tokenGate.release(jsonResponse({ token: "synthetic-status-token" }));
    await statusTurn();
    context.mock.timers.reset();
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});
