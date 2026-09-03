import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import worker, {
  activeBayItemKeys,
  composePublicBayActivityForTest,
  publicBayActiveTargetsForTest,
  publicExactReviewQueueProjection,
  publicStatusFreshness,
  publicStatusProjection as strictPublicStatusProjection,
  publicWorkerLegacyBatchPathForTest,
} from "../dashboard/worker.ts";

const STATUS_NOW = "2026-08-15T12:00:00.000Z";
const publicStatusProjection = (value: Record<string, unknown>) =>
  strictPublicStatusProjection({
    schema_version: 1,
    generated_at: STATUS_NOW,
    source: { target_repository_count: 0 },
    fleet: {},
    workers: [],
    automatic_work: [],
    pipeline: [],
    bay: {},
    recent: {},
    diagnostics: { errors: [], error_count: 0 },
    ...value,
  });
const UNAVAILABLE_PUBLIC_STATUS = {
  schema_version: 1,
  generated_at: "2020-01-01T00:00:00.000Z",
  public_projection_complete: false,
  source: { target_repository_count: 0 },
  fleet: {
    active_codex_jobs: 0,
    active_workflow_runs: 0,
    worker_budget: 0,
    budget_used_percent: 0,
  },
  workers: [],
  automatic_work: [],
  pipeline: [],
  bay: {},
  recent: {},
  operational_health: { status: "unknown" },
  diagnostics: { errors: ["telemetry_unavailable"], error_count: 1 },
  dashboard_health: { conclusion: "needs_attention", severity: "amber" },
};

test("status cache generation changes with the Bay comparison schema", () => {
  const source = readFileSync("dashboard/worker.ts", "utf8");
  assert.match(source, /\/api\/status-cache\/v7\//);
  assert.doesNotMatch(source, /\/api\/status-cache\/v6\//);
});

test("public status projection is fail-closed for nested identity-bearing metadata", () => {
  const input = {
    schema_version: 1,
    generated_at: "2026-08-15T12:00:00.000Z",
    fleet: {
      active_codex_jobs: 2,
      worker_detail_runs: 3,
    },
    workers: [
      {
        id: 42,
        name: "synthetic worker title",
        repository: "synthetic-owner/synthetic-repository",
        item_number: 42,
        workflow_title: "synthetic workflow title",
        failure_key: "synthetic failure key",
        run_url: "https://example.invalid/private?token=synthetic",
        token: "synthetic-token-value",
        status: "in_progress",
        mode: "assist",
        work_kind: "other",
        stage: "reviewing",
        current_step: "synthetic step title",
        progress: { completed: 1, total: 2 },
        steps: [
          {
            name: "synthetic nested step title",
            status: "in_progress",
            conclusion: null,
          },
        ],
      },
    ],
    bay: {
      timings: { sample_kind: "completed_review_journeys" },
      terminal_count: 3,
      terminal_buffer: [
        {
          item_key: "synthetic-owner/synthetic-repository#42",
          workflow_title: "synthetic nested workflow title",
          outcome: "failure",
        },
        { outcome: "cancelled" },
        { outcome: "success" },
      ],
    },
    diagnostics: {
      errors: ["synthetic error containing a private URL https://example.invalid/private"],
    },
  };

  const projected = publicStatusProjection(input);
  const serialized = JSON.stringify(projected);

  for (const forbidden of [
    "synthetic worker title",
    "synthetic-owner/synthetic-repository",
    "synthetic workflow title",
    "synthetic failure key",
    "example.invalid/private",
    "synthetic-token-value",
    "synthetic nested step title",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.deepEqual(projected.workers, [
    {
      status: "in_progress",
      mode: "assist",
      work_kind: "other",
      stage: "reviewing",
      progress: { completed: 1, total: 2 },
      steps: [{ status: "in_progress", conclusion: null }],
    },
  ]);
  assert.equal(projected.fleet.active_codex_jobs, 2);
  assert.equal(projected.fleet.worker_detail_runs, 3);
  assert.equal(projected.bay.terminal_count, 3);
  assert.deepEqual(projected.bay.terminal_buffer, [
    { outcome: "failure" },
    { outcome: "cancelled" },
    { outcome: "success" },
  ]);
  assert.equal(projected.bay.timings.sample_kind, "completed_review_journeys");
  assert.deepEqual(projected.diagnostics, {
    errors: ["telemetry_unavailable"],
    error_count: 1,
  });
});

test("public status projection drops over-depth values and retains closed health enums", () => {
  const overDepth = { token: "synthetic-over-depth-token" };
  let nested = overDepth;
  for (let index = 0; index < 13; index += 1) nested = { nested };

  const projected = publicStatusProjection({
    schema_version: 1,
    dashboard_health: { conclusion: "needs_attention", severity: "red" },
    nested,
  });

  assert.deepEqual(projected.dashboard_health, {
    conclusion: "needs_attention",
    severity: "red",
  });
  assert.equal(JSON.stringify(projected).includes("synthetic-over-depth-token"), false);
});

test("public status projection drops fully sanitized array placeholders", () => {
  const projected = publicStatusProjection({
    recent: {
      closed_items: [
        {
          repository: "synthetic-owner/synthetic-repository",
          number: 42,
          title: "synthetic private title",
          closed_at: "2026-08-15T11:59:00.000Z",
        },
      ],
    },
  });

  assert.deepEqual(projected.recent.closed_items, []);
  assert.equal(JSON.stringify(projected).includes("synthetic"), false);
});

test("public status projection retains wedged rerun aggregates without run identities", () => {
  const projected = publicStatusProjection({
    operational_health: {
      status: "healthy",
      telemetry_complete: true,
      wedged_rerun_runs: 1,
      oldest_wedged_rerun_minutes: 90,
      wedged_rerun_run_ids: [31910632853],
      diagnostic_url: "https://example.invalid/actions/runs/31910632853",
    },
  });

  assert.deepEqual(projected.operational_health, {
    status: "healthy",
    telemetry_complete: true,
    wedged_rerun_runs: 1,
    oldest_wedged_rerun_minutes: 90,
  });
  assert.equal(JSON.stringify(projected).includes("31910632853"), false);
});

test("public status projection retains every closed Bay stage count", () => {
  const projected = publicStatusProjection({
    exact_review_queue: {
      bay_projection: {
        complete: true,
        sample_limit: 24,
        total: 21,
        stages: {
          arriving: 1,
          "setting-up": 2,
          reviewing: 3,
          publishing: 4,
          applying: 5,
          repairing: 6,
        },
      },
    },
  });
  assert.deepEqual(projected.exact_review_queue.bay_projection.stages, {
    arriving: 1,
    "setting-up": 2,
    reviewing: 3,
    publishing: 4,
    applying: 5,
    repairing: 6,
  });
});

test("public status projects publisher stages and a deduplicated aggregate without identity", () => {
  const input = {
    workers: [
      {
        id: 1,
        name: "Publish review artifacts",
        repository: "synthetic-owner/synthetic-repository",
        item_number: 41,
        item_numbers: [41],
        status: "in_progress",
        stage: "running",
        current_step: "Validate exact review artifact bundle",
        steps: [{ name: "Apply review artifacts", status: "completed" }],
        started_at: "2026-08-15T12:00:00Z",
      },
      {
        id: 2,
        name: "publish",
        repository: "synthetic-owner/synthetic-repository",
        item_number: 42,
        item_numbers: [42],
        status: "in_progress",
        stage: "running",
        current_step: "Sync selected review comments",
        steps: [{ name: "Claim one durable publication batch", status: "completed" }],
        started_at: "2026-08-15T12:01:00Z",
      },
      {
        id: 3,
        name: "Review shard",
        repository: "synthetic-owner/synthetic-repository",
        item_number: 41,
        item_numbers: [41],
        status: "in_progress",
        stage: "reviewing",
        current_step: "Review shard",
        started_at: "2026-08-15T11:59:00Z",
      },
    ],
    bay: {
      active_census_complete: true,
      timings: { sample_kind: "completed_review_journeys" },
    },
  };

  const projected = publicStatusProjection(input);
  assert.deepEqual(
    projected.workers.map((worker) => worker.stage),
    ["publishing", "applying", "reviewing"],
  );
  assert.deepEqual(projected.bay.active_stages, {
    arriving: 0,
    "setting-up": 0,
    reviewing: 0,
    publishing: 1,
    applying: 1,
    repairing: 0,
  });
  const serialized = JSON.stringify(projected);
  assert.equal(serialized.includes("synthetic-owner"), false);
  assert.equal(serialized.includes("Publish review artifacts"), false);
  assert.deepEqual(publicStatusProjection(projected), projected);
});

test("public Bay classifies scheduled batches without hiding direct recovery", () => {
  assert.equal(
    publicWorkerLegacyBatchPathForTest({
      name: "Review shard 0 · openclaw/openclaw#41",
    }),
    true,
  );
  assert.equal(publicWorkerLegacyBatchPathForTest({ name: "Publish review artifacts" }), true);
  assert.equal(
    publicWorkerLegacyBatchPathForTest({ workflow_title: "Publish exact review batch" }),
    true,
  );
  assert.equal(
    publicWorkerLegacyBatchPathForTest({
      name: "Publish exact review artifact",
      current_step: "Replay committed direct lifecycle handoff",
      steps: [
        {
          name: "Replay committed direct lifecycle handoff",
          status: "in_progress",
        },
      ],
    }),
    true,
  );
  assert.equal(
    publicWorkerLegacyBatchPathForTest({
      name: "Publish exact review artifact",
      steps: [
        {
          name: "Replay committed direct lifecycle handoff",
          status: "completed",
          conclusion: "failure",
        },
      ],
    }),
    true,
  );
  assert.equal(
    publicWorkerLegacyBatchPathForTest({
      name: "Publish exact review artifact",
      steps: [
        {
          name: "Replay committed direct lifecycle handoff",
          status: "completed",
          conclusion: "success",
        },
      ],
    }),
    false,
  );
  assert.equal(
    publicWorkerLegacyBatchPathForTest({
      name: "Publish exact review artifact",
      current_step: "Replay committed direct lifecycle handoff",
      steps: [
        {
          name: "Replay committed direct lifecycle handoff",
          status: "queued",
        },
      ],
    }),
    true,
  );
  assert.equal(
    publicWorkerLegacyBatchPathForTest({
      name: "Publish exact review artifact",
      current_step: "Set up job",
    }),
    true,
  );
  assert.equal(
    publicWorkerLegacyBatchPathForTest({
      name: "Publish exact review artifact",
      steps: [
        {
          name: "Fold exact live proof into the review artifact",
          status: "completed",
          conclusion: "success",
        },
      ],
    }),
    true,
  );
});

test("public Bay keeps opposite-path direct queue work beside an active legacy worker", () => {
  const emptyStages = {
    arriving: 0,
    "setting-up": 0,
    reviewing: 0,
    publishing: 0,
    applying: 0,
    repairing: 0,
  };
  const activity = composePublicBayActivityForTest(
    {
      complete: true,
      stages: { ...emptyStages, "setting-up": 1 },
      legacy_batch_stages: emptyStages,
      active_overlaps: emptyStages,
      legacy_batch_active_overlaps: emptyStages,
      items: [
        {
          repository: "openclaw/openclaw",
          item_number: 41,
          stage: "setting-up",
          legacy_batch_path: false,
        },
      ],
    },
    {
      complete: true,
      keys: [],
      legacyKeys: ["openclaw/openclaw#41"],
      stages: { ...emptyStages, publishing: 1 },
      legacyBatchStages: { ...emptyStages, publishing: 1 },
      items: [
        {
          repository: "openclaw/openclaw",
          item_number: 41,
          stage: "publishing",
          source: "live",
          legacy_batch_path: true,
        },
      ],
    },
  );

  assert.equal(activity.complete, true);
  assert.equal(activity.queue_stages["setting-up"], 1);
  assert.equal(activity.live_legacy_batch_stages.publishing, 1);
  assert.deepEqual(
    activity.items?.map((item) => [item.source, item.legacy_batch_path]),
    [
      ["queue", false],
      ["live", true],
    ],
  );
});

test("public Bay retains simultaneous direct and legacy workers for one target", () => {
  const active = publicBayActiveTargetsForTest([
    {
      name: "Review exact item openclaw/openclaw#41",
      repository: "openclaw/openclaw",
      item_number: 41,
      started_at: "2026-08-15T11:58:00.000Z",
      current_step: "Review exact event item",
      status: "in_progress",
    },
    {
      name: "Publish exact review artifact",
      repository: "openclaw/openclaw",
      item_number: 41,
      started_at: "2026-08-15T11:59:00.000Z",
      current_step: "Set up job",
      status: "in_progress",
    },
  ]);

  assert.equal(active.complete, true);
  assert.deepEqual(active.keys, ["openclaw/openclaw#41"]);
  assert.deepEqual(active.legacyKeys, ["openclaw/openclaw#41"]);
  assert.equal(active.stages.reviewing, 1);
  assert.equal(active.stages.publishing, 1);
  assert.equal(active.legacyBatchStages.publishing, 1);
  assert.deepEqual(
    active.items.map((item) => item.legacy_batch_path),
    [false, true],
  );
});

test("private active-key protection stays complete while public over-cap activity fails closed", () => {
  const manyWorkers = Array.from({ length: 101 }, (_, index) => ({
    repository: "synthetic-owner/synthetic-repository",
    item_number: index + 1,
    item_numbers: [index + 1],
    stage: "reviewing",
    started_at: "2026-08-15T12:00:00Z",
  }));
  const manyItems = {
    repository: "synthetic-owner/synthetic-repository",
    item_numbers: Array.from({ length: 101 }, (_, index) => index + 1),
    stage: "reviewing",
    started_at: "2026-08-15T12:00:00Z",
  };

  assert.equal(activeBayItemKeys(manyWorkers).length, 101);
  assert.equal(activeBayItemKeys([manyItems]).length, 101);
  for (const source of [{ workers: manyWorkers }, { workers: [manyItems] }]) {
    const projected = publicStatusProjection(source);
    assert.equal(projected.workers.length, Math.min(source.workers.length, 100));
    assert.deepEqual(projected.bay.active_stages, {
      arriving: 0,
      "setting-up": 0,
      reviewing: 0,
      publishing: 0,
      applying: 0,
      repairing: 0,
    });
  }
});

test("public status canonicalizes the disjoint Bay activity contract", () => {
  const stages = {
    arriving: 1,
    "setting-up": 2,
    reviewing: 3,
    publishing: 4,
    applying: 5,
    repairing: 6,
  };
  const liveStages = {
    arriving: 1,
    "setting-up": 0,
    reviewing: 1,
    publishing: 0,
    applying: 1,
    repairing: 0,
  };
  const emptyStages = Object.fromEntries(Object.keys(stages).map((stage) => [stage, 0]));
  const projected = publicStatusProjection({
    exact_review_queue: {
      bay_projection: {
        complete: true,
        sample_limit: 24,
        total: 21,
        stages,
        active_overlaps: { ...liveStages, private_key: 1 },
        items: [
          {
            item_key: "synthetic-owner/synthetic-repository#7",
            stage: "arriving",
            created_at: "2026-08-15T12:00:00Z",
          },
        ],
        activity: {
          complete: true,
          queue_stages: stages,
          live_stages: { ...liveStages, private_key: 1 },
          total: 24,
          private_key: "synthetic private value",
        },
      },
    },
  });

  assert.deepEqual(projected.exact_review_queue.bay_projection.activity, {
    complete: true,
    queue_stages: stages,
    live_stages: liveStages,
    queue_legacy_batch_stages: emptyStages,
    live_legacy_batch_stages: emptyStages,
    total: 24,
  });
  assert.equal("active_overlaps" in projected.exact_review_queue.bay_projection, false);
  assert.equal("items" in projected.exact_review_queue.bay_projection, false);
  assert.equal(JSON.stringify(projected).includes("synthetic private value"), false);

  for (const activity of [
    { complete: true, queue_stages: stages, live_stages: liveStages, total: 23 },
    { complete: true, queue_stages: { arriving: 1 }, live_stages: liveStages, total: 4 },
    {
      complete: true,
      queue_stages: { ...stages, arriving: "1" },
      live_stages: liveStages,
      total: "24",
    },
    { complete: false, queue_stages: stages, live_stages: liveStages, total: 24 },
  ]) {
    const malformed = publicStatusProjection({
      exact_review_queue: {
        bay_projection: { complete: true, sample_limit: 24, total: 21, stages, activity },
      },
    });
    assert.deepEqual(malformed.exact_review_queue.bay_projection.activity, {
      complete: false,
      queue_stages: null,
      live_stages: null,
      queue_legacy_batch_stages: null,
      live_legacy_batch_stages: null,
      total: null,
    });
  }

  const incompleteOuter = publicStatusProjection({
    exact_review_queue: {
      bay_projection: {
        complete: false,
        activity: { complete: true, queue_stages: stages, live_stages: liveStages, total: 24 },
      },
    },
  });
  assert.deepEqual(incompleteOuter.exact_review_queue.bay_projection.activity, {
    complete: false,
    queue_stages: null,
    live_stages: null,
    queue_legacy_batch_stages: null,
    live_legacy_batch_stages: null,
    total: null,
  });

  for (const bayProjection of [
    { complete: true, sample_limit: 24, total: 21, stages: null },
    { complete: true, sample_limit: 24, total: 20, stages },
    { complete: true, sample_limit: 7, total: 21, stages },
  ]) {
    const malformed = publicStatusProjection({
      exact_review_queue: { bay_projection: bayProjection },
    });
    assert.deepEqual(malformed.exact_review_queue.bay_projection, {
      complete: false,
      activity: {
        complete: false,
        queue_stages: null,
        live_stages: null,
        queue_legacy_batch_stages: null,
        live_legacy_batch_stages: null,
        total: null,
      },
    });
  }
});

test("public Bay references retain only allowlisted canonical GitHub coordinates", () => {
  const marker = "generated-untrusted-detail";
  const stages = {
    arriving: 1,
    "setting-up": 0,
    reviewing: 0,
    publishing: 0,
    applying: 0,
    repairing: 0,
  };
  const projected = strictPublicStatusProjection(
    {
      schema_version: 1,
      generated_at: STATUS_NOW,
      source: { target_repository_count: 1 },
      fleet: {},
      workers: [],
      automatic_work: [],
      pipeline: [],
      exact_review_queue: {
        bay_projection: {
          complete: true,
          sample_limit: 24,
          total: 1,
          stages,
          items: [
            {
              item_key: marker,
              repository: "OpenClaw/OpenClaw",
              item_number: 41,
              stage: "arriving",
              created_at: STATUS_NOW,
              title: marker,
              url: `https://example.invalid/private?token=${marker}`,
              action: {
                repository: "OpenClaw/ClawSweeper",
                run_id: 7001,
                job_id: 8001,
                status: "in_progress",
                started_at: STATUS_NOW,
                steps_complete: true,
                steps: [
                  {
                    sequence: 1,
                    kind: "setup",
                    status: "completed",
                    conclusion: "success",
                    name: marker,
                    url: `https://example.invalid/private?token=${marker}`,
                  },
                  {
                    sequence: 2,
                    kind: "review",
                    status: "in_progress",
                    conclusion: null,
                    name: marker,
                  },
                  {
                    sequence: 3,
                    name: "Apply review artifacts",
                    status: "queued",
                    conclusion: null,
                  },
                ],
                title: marker,
                run_url: `https://example.invalid/private?token=${marker}`,
              },
            },
            {
              repository: "private-owner/private-repo",
              item_number: 42,
              stage: "arriving",
              failure_key: marker,
            },
          ],
          activity: {
            complete: true,
            queue_stages: stages,
            live_stages: { ...stages, arriving: 0, reviewing: 1 },
            total: 2,
            items: [
              {
                repository: "OPENCLAW/OPENCLAW",
                item_number: 43,
                stage: "reviewing",
                source: "live",
                timing: { kind: "run", started_at: STATUS_NOW },
                workflow_title: marker,
              },
              {
                repository: "private-owner/private-repo",
                item_number: 44,
                stage: "arriving",
                source: "queue",
              },
            ],
          },
        },
      },
      bay: {
        terminal_buffer: [
          {
            outcome: "success",
            repository: "OpenClaw/OpenClaw",
            number: 45,
            title: marker,
            job_url: "https://github.com/OpenClaw/ClawSweeper/actions/runs/7002/job/8002",
            run_id: 7002,
            job_id: 8002,
            journey_duration_ms: 1_000,
            started_at: STATUS_NOW,
            steps: [
              {
                number: 1,
                name: "Publish result",
                status: "completed",
                conclusion: "success",
                detail: marker,
              },
            ],
          },
          {
            outcome: "failure",
            repository: "private-owner/private-repo",
            number: 46,
          },
        ],
        recently_washed: [],
      },
      recent: {},
      diagnostics: { errors: [], error_count: 0 },
    },
    new Set(["openclaw/openclaw", "openclaw/clawsweeper"]),
  );

  assert.deepEqual(projected.exact_review_queue.bay_projection.items, [
    {
      repository: "openclaw/openclaw",
      item_number: 41,
      stage: "arriving",
      source: "queue",
      legacy_batch_path: false,
      timing: { kind: "queue", started_at: STATUS_NOW },
      action: {
        repository: "openclaw/clawsweeper",
        run_id: 7001,
        job_id: 8001,
        status: "in_progress",
        started_at: STATUS_NOW,
        steps_complete: true,
        steps: [
          { sequence: 1, kind: "setup", status: "completed", conclusion: "success" },
          { sequence: 2, kind: "review", status: "in_progress", conclusion: null },
          { sequence: 3, kind: "apply", status: "queued", conclusion: null },
        ],
      },
    },
  ]);
  assert.deepEqual(projected.exact_review_queue.bay_projection.activity.items, [
    {
      repository: "openclaw/openclaw",
      item_number: 43,
      stage: "reviewing",
      source: "live",
      legacy_batch_path: false,
      timing: { kind: "run", started_at: STATUS_NOW },
    },
  ]);
  assert.deepEqual(projected.bay.terminal_buffer, [
    {
      repository: "openclaw/openclaw",
      item_number: 45,
      outcome: "success",
      journey_duration_ms: 1_000,
      legacy_batch_path: false,
      action: {
        repository: "openclaw/clawsweeper",
        run_id: 7002,
        job_id: 8002,
        status: "completed",
        started_at: STATUS_NOW,
        steps_complete: true,
        steps: [{ sequence: 1, kind: "publish", status: "completed", conclusion: "success" }],
      },
    },
    { outcome: "failure" },
  ]);
  const serialized = JSON.stringify(projected);
  assert.equal(serialized.includes("private-owner"), false);
  assert.equal(serialized.includes(marker), false);
  assert.equal(serialized.includes("example.invalid"), false);
  assert.deepEqual(
    strictPublicStatusProjection(projected, new Set(["openclaw/openclaw", "openclaw/clawsweeper"])),
    projected,
  );
  const noAllowlist = strictPublicStatusProjection(projected);
  assert.equal("items" in noAllowlist.exact_review_queue.bay_projection, false);
  assert.equal("items" in noAllowlist.exact_review_queue.bay_projection.activity, false);
  assert.deepEqual(noAllowlist.bay.terminal_buffer, [
    { outcome: "success" },
    { outcome: "failure" },
  ]);

  const malformed = strictPublicStatusProjection(
    {
      schema_version: 1,
      generated_at: STATUS_NOW,
      source: { target_repository_count: 1 },
      fleet: {},
      workers: [],
      automatic_work: [],
      pipeline: [],
      exact_review_queue: {
        bay_projection: {
          complete: true,
          sample_limit: 24,
          total: 1,
          stages,
          items: [
            {
              repository: "openclaw/openclaw",
              item_number: "41",
              stage: "arriving",
            },
          ],
        },
      },
      bay: {},
      recent: {},
      diagnostics: { errors: [], error_count: 0 },
    },
    new Set(["openclaw/openclaw"]),
  );
  assert.equal("items" in malformed.exact_review_queue.bay_projection, false);
});

test("public Bay actions fail closed for malformed, private, and over-cap shapes", () => {
  const marker = "synthetic-action-private-marker";
  const stages = {
    arriving: 1,
    "setting-up": 0,
    reviewing: 0,
    publishing: 0,
    applying: 0,
    repairing: 0,
  };
  const safeAction = {
    repository: "openclaw/clawsweeper",
    run_id: 7001,
    job_id: 8001,
    status: "in_progress",
    started_at: STATUS_NOW,
    steps_complete: true,
    steps: [{ sequence: 1, kind: "review", status: "in_progress", conclusion: null }],
  };
  const project = (action: Record<string, unknown>) =>
    strictPublicStatusProjection(
      {
        schema_version: 1,
        generated_at: STATUS_NOW,
        source: { target_repository_count: 1 },
        fleet: {},
        workers: [],
        automatic_work: [],
        pipeline: [],
        exact_review_queue: {
          bay_projection: {
            complete: true,
            sample_limit: 24,
            total: 1,
            stages,
            items: [
              {
                repository: "openclaw/openclaw",
                item_number: 41,
                stage: "arriving",
                action,
              },
            ],
          },
        },
        bay: {},
        recent: {},
        diagnostics: { errors: [], error_count: 0 },
      },
      new Set(["openclaw/openclaw", "openclaw/clawsweeper"]),
    );

  const malformedActions = [
    { ...safeAction, repository: "private-owner/private-repo" },
    { ...safeAction, run_id: "7001" },
    { ...safeAction, started_at: marker },
    { ...safeAction, steps: [{ ...safeAction.steps[0], kind: marker }] },
    {
      ...safeAction,
      steps: [safeAction.steps[0], { ...safeAction.steps[0], conclusion: marker }],
    },
    {
      ...safeAction,
      steps: Array.from({ length: 101 }, (_, index) => ({
        sequence: index + 1,
        kind: "review",
        status: "queued",
        conclusion: null,
      })),
    },
    { ...safeAction, steps_complete: false },
    { ...safeAction, nested: { token: marker, url: `https://example.invalid/?token=${marker}` } },
  ];

  for (const [index, action] of malformedActions.entries()) {
    const item = project(action).exact_review_queue.bay_projection.items[0];
    if (index === malformedActions.length - 1) {
      assert.deepEqual(item.action, safeAction);
    } else {
      assert.equal("action" in item, false);
    }
    assert.equal(JSON.stringify(item).includes(marker), false);
    assert.equal(JSON.stringify(item).includes("private-owner"), false);
    assert.equal(JSON.stringify(item).includes("example.invalid"), false);
  }
});

test("public status rejects supplied live counts from incomplete worker censuses", () => {
  const projected = publicStatusProjection({
    workers: Array.from({ length: 101 }, () => ({ stage: "reviewing" })),
    bay: {
      active_census_complete: true,
      active_stages: {
        arriving: 7,
        "setting-up": 0,
        reviewing: 0,
        publishing: 0,
        applying: 0,
        repairing: 0,
      },
    },
  });
  assert.deepEqual(projected.bay.active_stages, {
    arriving: 0,
    "setting-up": 0,
    reviewing: 0,
    publishing: 0,
    applying: 0,
    repairing: 0,
  });
  assert.equal(projected.bay.active_census_complete, false);
});

test("public status retains closed workflow categories and bounded tide counters", () => {
  const projected = publicStatusProjection({
    pipeline: [
      { mode: "background-review", stage: "running" },
      { mode: "exact-review", stage: "reviewing" },
      { mode: "hot-review", stage: "reviewing" },
      { mode: "automerge", stage: "repairing" },
      { mode: "apply", stage: "closing" },
    ],
    bay: {
      tide_generation: 7,
      tide_threshold: 20,
      last_tide_at: "2026-08-15T12:00:00Z",
      washed_at: "2026-08-15T12:01:00Z",
      timings: { window_minutes: 60 },
    },
  });

  assert.deepEqual(projected.pipeline, [
    { mode: "background-review", stage: "running" },
    { mode: "exact-review", stage: "reviewing" },
    { mode: "hot-review", stage: "reviewing" },
    { mode: "automerge", stage: "repairing" },
    { mode: "apply", stage: "closing" },
  ]);
  assert.deepEqual(projected.bay, {
    tide_generation: 7,
    tide_threshold: 20,
    last_tide_at: "2026-08-15T12:00:00.000Z",
    washed_at: "2026-08-15T12:01:00.000Z",
    timings: { window_minutes: 60 },
    active_census_complete: false,
    active_stages: {
      arriving: 0,
      "setting-up": 0,
      reviewing: 0,
      publishing: 0,
      applying: 0,
      repairing: 0,
    },
  });

  const malformed = publicStatusProjection({
    bay: { last_tide_at: "not-a-timestamp", washed_at: "also-invalid" },
  });
  assert.equal(malformed.public_projection_complete, true);
  assert.equal(Object.hasOwn(malformed.bay, "last_tide_at"), false);
  assert.equal(Object.hasOwn(malformed.bay, "washed_at"), false);
  assert.equal(malformed.bay.active_census_complete, false);
  assert.deepEqual(malformed.bay.active_stages, {
    arriving: 0,
    "setting-up": 0,
    reviewing: 0,
    publishing: 0,
    applying: 0,
    repairing: 0,
  });
});

test("public status projection drops malformed and unrecognized text while retaining bounded counts", () => {
  const projected = publicStatusProjection({
    schema_version: 1,
    workers: [
      {
        status: "unexpected-free-text",
        mode: "unknown-mode",
        progress: { completed: 3, total: 5 },
        nested: { opaque_value: "must not escape" },
      },
    ],
  });

  assert.deepEqual(projected.workers, [{ progress: { completed: 3, total: 5 } }]);
});

test("public status conservatively canonicalizes under-reported diagnostics", () => {
  const projected = publicStatusProjection({
    diagnostics: {
      error_count: 0,
      errors: ["synthetic unbounded diagnostic", "synthetic second diagnostic"],
    },
  });
  assert.deepEqual(projected.diagnostics, {
    errors: ["telemetry_unavailable", "telemetry_unavailable"],
    error_count: 2,
  });
  assert.equal(JSON.stringify(projected).includes("synthetic unbounded diagnostic"), false);
  assert.deepEqual(strictPublicStatusProjection(projected), projected);
});

test("public status rejects unknown scalar namespaces and unbounded recognized numbers", () => {
  const projected = publicStatusProjection({
    schema_version: 1,
    fleet: {
      active_codex_jobs: 2,
      arbitrary_count: 987_654_321,
      arbitrary_boolean: true,
      worker_budget: Number.MAX_SAFE_INTEGER,
      available_slots: -1,
      budget_used_percent: 101,
    },
    arbitrary_namespace: {
      active_codex_jobs: 9,
      complete: true,
    },
    diagnostics: { errors: [], error_count: Number.MAX_SAFE_INTEGER },
  });

  assert.equal(projected.schema_version, 1);
  assert.equal(projected.public_projection_complete, true);
  assert.deepEqual(projected.fleet, { active_codex_jobs: 2 });
  assert.deepEqual(projected.diagnostics, { errors: [], error_count: 0 });
  assert.equal(projected.arbitrary_namespace, undefined);
  assert.equal(projected.fleet.arbitrary_count, undefined);
  assert.equal(projected.fleet.arbitrary_boolean, undefined);
});

test("public status marks invalid roots and timestamp channels incomplete", () => {
  for (const malformed of [
    null,
    [],
    { schema_version: 1 },
    { schema_version: 1, generated_at: "1171" },
    { schema_version: 1, generated_at: "https://example.invalid/private?timestamp=1" },
    { schema_version: 1, generated_at: STATUS_NOW.repeat(3) },
  ]) {
    assert.deepEqual(strictPublicStatusProjection(malformed), UNAVAILABLE_PUBLIC_STATUS);
  }
  assert.deepEqual(
    strictPublicStatusProjection(UNAVAILABLE_PUBLIC_STATUS),
    UNAVAILABLE_PUBLIC_STATUS,
  );
  for (const diagnostics of [
    {},
    { errors: "synthetic malformed error", error_count: 0 },
    { errors: { nested: "synthetic malformed error" }, error_count: 0 },
  ]) {
    assert.deepEqual(publicStatusProjection({ diagnostics }), UNAVAILABLE_PUBLIC_STATUS);
  }
});

test("public status freshness rejects a future generated timestamp", () => {
  const now = Date.parse(STATUS_NOW);
  assert.deepEqual(
    publicStatusFreshness({ generated_at: new Date(now + 1).toISOString() }, "fresh", 60_000, now),
    {
      state: "unavailable",
      cache_state: "fresh",
      generated_at: null,
      age_ms: null,
      maximum_age_ms: 60_000,
    },
  );
});

test("public status filters a legacy cached body before it can be served", async () => {
  const originalCaches = globalThis.caches;
  const entries = new Map<string, Response>();
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        async match(request: Request) {
          return entries.get(request.url)?.clone();
        },
        async put(request: Request, response: Response) {
          entries.set(request.url, response.clone());
        },
      },
    },
  });

  try {
    await globalThis.caches.default.put(
      new Request("https://clawsweeper.openclaw.ai/api/status-cache/v7/_/fresh"),
      new Response(
        JSON.stringify({
          schema_version: 1,
          generated_at: STATUS_NOW,
          fleet: {},
          automatic_work: [],
          pipeline: [],
          recent: {},
          workers: [
            {
              workflow_title: "synthetic cache title",
              failure_key: "synthetic cache failure key",
              run_url: "https://example.invalid/cache?credential=synthetic",
              status: "queued",
              progress: { completed: 0, total: 1 },
            },
          ],
          diagnostics: { errors: ["synthetic cache error"] },
          bay: {
            terminal_count: 3,
            terminal_buffer: [
              { outcome: "success", workflow_title: "synthetic cache title" },
              { outcome: "failure", item_key: "synthetic cache item" },
              { outcome: "cancelled", run_url: "https://example.invalid/cache" },
            ],
          },
        }),
        {
          status: 307,
          headers: {
            location: "https://example.invalid/private?marker=synthetic",
            "set-cookie": "private_marker=synthetic",
            "x-private-marker": "synthetic-cache-header",
          },
        },
      ),
    );

    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {},
    );
    const body = await response.json();
    const serialized = JSON.stringify(body);

    assert.equal(response.headers.get("x-clawsweeper-cache"), "fresh");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("x-private-marker"), null);
    assert.equal(serialized.includes("synthetic cache title"), false);
    assert.equal(serialized.includes("synthetic cache failure key"), false);
    assert.equal(serialized.includes("example.invalid/cache"), false);
    assert.deepEqual(body.workers, [
      { status: "queued", progress: { completed: 0, total: 1 }, stage: "arriving" },
    ]);
    assert.deepEqual(body.bay, {
      terminal_count: 3,
      terminal_buffer: [{ outcome: "success" }, { outcome: "failure" }, { outcome: "cancelled" }],
      active_census_complete: false,
      active_stages: {
        arriving: 0,
        "setting-up": 0,
        reviewing: 0,
        publishing: 0,
        applying: 0,
        repairing: 0,
      },
    });
    assert.deepEqual(body.diagnostics, {
      errors: ["telemetry_unavailable"],
      error_count: 1,
    });

    entries.delete("https://clawsweeper.openclaw.ai/api/status-cache/v7/_/fresh");
    await globalThis.caches.default.put(
      new Request("https://clawsweeper.openclaw.ai/api/status-cache/v7/_/stale"),
      new Response(
        JSON.stringify({
          schema_version: 1,
          generated_at: STATUS_NOW,
          fleet: { active_codex_jobs: 1 },
          workers: [],
          automatic_work: [],
          pipeline: [],
          bay: {},
          recent: {},
          diagnostics: { errors: [], error_count: 0 },
        }),
        {
          status: 302,
          headers: {
            location: "https://example.invalid/private?marker=synthetic",
            "set-cookie": "private_marker=synthetic",
            "x-private-marker": "synthetic-stale-header",
          },
        },
      ),
    );
    const staleResponse = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {},
      { waitUntil: () => undefined },
    );
    assert.equal(staleResponse.status, 200);
    assert.equal(staleResponse.headers.get("x-clawsweeper-cache"), "stale");
    assert.equal(staleResponse.headers.get("location"), null);
    assert.equal(staleResponse.headers.get("set-cookie"), null);
    assert.equal(staleResponse.headers.get("x-private-marker"), null);

    entries.delete("https://clawsweeper.openclaw.ai/api/status-cache/v7/_/stale");
    await globalThis.caches.default.put(
      new Request("https://clawsweeper.openclaw.ai/api/status-cache/v7/_/fresh"),
      new Response(
        JSON.stringify({
          schema_version: 1,
          generated_at: new Date().toISOString(),
          fleet: { active_codex_jobs: 1 },
        }),
      ),
    );
    const rejectedResponse = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {},
    );
    assert.deepEqual(await rejectedResponse.json(), {
      ...UNAVAILABLE_PUBLIC_STATUS,
      freshness: {
        state: "unavailable",
        cache_state: "fresh",
        generated_at: null,
        age_ms: null,
        maximum_age_ms: 60_000,
      },
    });

    entries.delete("https://clawsweeper.openclaw.ai/api/status-cache/v7/_/fresh");
    await globalThis.caches.default.put(
      new Request("https://clawsweeper.openclaw.ai/api/status-cache/v7/_/fresh"),
      new Response('{"schema_version":1,"generated_at":', {
        headers: { "x-private-marker": "synthetic-malformed-header" },
      }),
    );
    const malformedResponse = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {},
    );
    assert.deepEqual(await malformedResponse.json(), {
      ...UNAVAILABLE_PUBLIC_STATUS,
      freshness: {
        state: "unavailable",
        cache_state: "fresh",
        generated_at: null,
        age_ms: null,
        maximum_age_ms: 60_000,
      },
    });
    assert.equal(malformedResponse.headers.get("x-private-marker"), null);
  } finally {
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("public queue projection retains only closed operational aggregates", () => {
  const sentinel = "generated-private-marker";
  const source = {
    generated_at: "2026-08-15T12:00:00.000Z",
    pending: 7,
    ready_pending: 5,
    admissible_pending: 4,
    shed_since_reset: 0,
    dispatching: 2,
    leased: 1,
    oldest_pending_key: sentinel,
    target_stats: [{ target_repo: sentinel, pending: 7 }],
    arbitrary_count: 999,
    dispatcher: {
      dispatch_failure_fingerprint: sentinel,
      dispatch_failure_detail: { workflow_title: sentinel },
    },
    scheduled_feed: {
      target_rate_per_hour: 300,
      enqueue_replay: "scheduled_disposition_v1",
      burst: 50,
      token_balance: 42,
      throttle_source: sentinel,
      lanes: { normal_backfill: { target_rate_per_hour: 200 } },
      sentinel,
    },
    lanes: {
      review: {
        pending: 7,
        pending_depth: 7,
        shed_since_reset: 0,
        ready: 5,
        backoff: 2,
        dispatching: 2,
        leased: 1,
        parked: 1,
        capacity: 12,
        active: 3,
        available_slots: 9,
        oldest_pending_key: sentinel,
        backoff_reasons: { retry_backoff: 2 },
        parked_reasons: { [sentinel]: 1 },
      },
      publication: {
        pending: 1,
        pending_depth: 1,
        shed_since_reset: 0,
        ready: 1,
        backoff: 0,
        dispatching: 0,
        leased: 1,
        parked: 0,
        capacity: 4,
        active: 1,
        available_slots: 3,
        backoff_reasons: {},
        parked_reasons: {},
      },
    },
    handoff_health: {
      status: "healthy",
      reason: "handoff_current",
      message: sentinel,
      observed_at: "2026-08-15T12:00:00.000Z",
      warning_after_seconds: 60,
      stalled_after_seconds: 300,
      capacity: 12,
      active: 3,
      available_slots: 9,
      pending_depth: 7,
      shed_since_reset: 0,
      recovery_reasons: {},
      phases: {
        pending: { count: 7, oldest_key: sentinel },
        dispatching: { count: 2 },
        leased: { count: 1 },
      },
    },
    pressure: {
      status: "congested",
      reason: "capacity_full_with_backlog",
      capacity: 12,
      active: 3,
      pending: 7,
      ready_pending: 5,
      admissible_pending: 4,
    },
    review_failure_health: {
      status: "critical",
      reasons: ["repeated_failure_identity", "terminal_review_failure", sentinel],
      window_minutes: 60,
      attempts: 3,
      affected_targets: 2,
      retryable_attempts: 1,
      terminal_attempts: 2,
      terminal_status_observed: 0,
      terminal_status_failed: 0,
      repeated_identities: 1,
      first_seen_at: "2026-08-15T11:30:00.000Z",
      last_seen_at: "2026-08-15T11:55:00.000Z",
      by_stage: {
        agent_input_scan: 2,
        source_preparation: 0,
        provider_or_model: 0,
        workflow: 1,
        [sentinel]: 99,
      },
      private_attempts: [{ target: sentinel }],
    },
    bay_projection: {
      complete: true,
      sample_limit: 24,
      total: 7,
      stages: {
        arriving: 1,
        "setting-up": 1,
        reviewing: 2,
        publishing: 1,
        applying: 1,
        repairing: 1,
        arbitrary_count: 99,
      },
      active_overlaps: {
        arriving: 0,
        "setting-up": 0,
        reviewing: 1,
        publishing: 0,
        applying: 0,
        repairing: 0,
      },
      items: [{ item_key: sentinel, workflow_title: sentinel }],
    },
  };
  const projected = publicExactReviewQueueProjection(source);
  const serialized = JSON.stringify(projected);

  assert.equal(serialized.includes(sentinel), false);
  assert.equal("target_stats" in projected, false);
  assert.equal("dispatcher" in projected, false);
  assert.equal("arbitrary_count" in projected, false);
  assert.equal(projected.pending, 7);
  assert.equal(projected.collection.state, "complete");
  assert.equal(projected.lanes.review.capacity, 12);
  assert.equal(projected.lanes.review.backoff_reasons.review_retry, 2);
  assert.equal(projected.lanes.review.parked_reasons.unknown, 1);
  assert.equal(projected.handoff_health.status, "healthy");
  assert.equal(projected.pressure.status, "congested");
  assert.deepEqual(projected.review_failure_health, {
    status: "critical",
    reasons: ["repeated_failure_identity", "terminal_review_failure"],
    window_minutes: 60,
    attempts: 3,
    affected_targets: 2,
    retryable_attempts: 1,
    terminal_attempts: 2,
    terminal_status_observed: 0,
    terminal_status_failed: 0,
    repeated_identities: 1,
    first_seen_at: "2026-08-15T11:30:00.000Z",
    last_seen_at: "2026-08-15T11:55:00.000Z",
    by_stage: {
      agent_input_scan: 2,
      source_preparation: 0,
      provider_or_model: 0,
      workflow: 1,
    },
  });
  assert.deepEqual(projected.scheduled_feed, {
    target_rate_per_hour: 300,
    enqueue_replay: "scheduled_disposition_v1",
  });
  assert.deepEqual(projected.bay_projection.activity, {
    complete: false,
    queue_stages: null,
    live_stages: null,
    queue_legacy_batch_stages: null,
    live_legacy_batch_stages: null,
    total: null,
  });
  assert.deepEqual(publicExactReviewQueueProjection(projected), projected);

  const statusProjected = strictPublicStatusProjection({
    schema_version: 1,
    generated_at: STATUS_NOW,
    source: { target_repository_count: 0 },
    fleet: {},
    workers: [],
    automatic_work: [],
    pipeline: [],
    bay: {},
    recent: {
      closed_items: [
        {
          repository: sentinel,
          title: sentinel,
          closed_at: "2026-08-15T11:59:00.000Z",
        },
      ],
    },
    diagnostics: { errors: [], error_count: 0 },
    dashboard_health: {
      conclusion: "needs_attention",
      severity: "red",
      reasons: ["review_failures_repeated", sentinel],
    },
    exact_review_queue: projected,
  });
  assert.equal(statusProjected.public_projection_complete, true);
  assert.equal(JSON.stringify(statusProjected).includes(sentinel), false);
  assert.deepEqual(statusProjected.recent.closed_items, []);
  assert.deepEqual(statusProjected.exact_review_queue.collection, { state: "complete" });
  assert.deepEqual(statusProjected.dashboard_health, {
    conclusion: "needs_attention",
    severity: "red",
    reasons: ["review_failures_repeated"],
  });
  assert.deepEqual(
    statusProjected.exact_review_queue.review_failure_health,
    projected.review_failure_health,
  );
  assert.deepEqual(statusProjected.exact_review_queue.scheduled_feed, {
    target_rate_per_hour: 300,
    enqueue_replay: "scheduled_disposition_v1",
  });
  assert.deepEqual(statusProjected.exact_review_queue.handoff_health.phases, {
    pending: { count: 7, oldest_at: null, oldest_age_seconds: null },
    dispatching: { count: 2, oldest_at: null, oldest_age_seconds: null },
    leased: { count: 1, oldest_at: null, oldest_age_seconds: null },
  });
  assert.deepEqual(
    strictPublicStatusProjection(statusProjected).exact_review_queue.scheduled_feed,
    statusProjected.exact_review_queue.scheduled_feed,
  );

  const highTotals = publicExactReviewQueueProjection({
    ...projected,
    lanes: {
      ...projected.lanes,
      review: {
        ...projected.lanes.review,
        enqueued_total: 1_120_211,
        completed_total: 1_120_299,
      },
    },
  });
  assert.equal(highTotals.lanes.review.enqueued_total, 1_120_211);
  assert.equal(highTotals.lanes.review.completed_total, 1_120_299);

  for (const scheduled_feed of [
    undefined,
    null,
    {},
    { target_rate_per_hour: 0 },
    { target_rate_per_hour: 1.5 },
    { target_rate_per_hour: 2_001 },
    { target_rate_per_hour: "300" },
    { target_rate_per_hour: 300 },
    { target_rate_per_hour: 300, enqueue_replay: "future_contract" },
  ]) {
    assert.equal(
      publicExactReviewQueueProjection({ ...source, scheduled_feed }).scheduled_feed,
      null,
    );
  }

  const mismatches = [
    (value) => {
      value.lanes.review.active = 4;
    },
    (value) => {
      value.lanes.review.available_slots = 8;
    },
    (value) => {
      value.handoff_health.phases.dispatching.count = 1;
    },
    (value) => {
      value.pressure.ready_pending = 4;
    },
    (value) => {
      value.handoff_health.observed_at = "2026-08-15T12:00:01.000Z";
    },
    (value) => {
      value.handoff_health.pending_depth = 6;
    },
    (value) => {
      value.handoff_health.shed_since_reset = 1;
    },
    (value) => {
      value.lanes.review.backoff_reasons = { dispatch_debounce: 1 };
    },
  ];
  for (const mutate of mismatches) {
    const malformed = structuredClone(source);
    mutate(malformed);
    assert.deepEqual(publicExactReviewQueueProjection(malformed).collection, {
      state: "unknown",
      reason: "malformed",
    });
  }

  for (const timestamp of [1_723_700_000_000, "Sat, 15 Aug 2026 12:00:00 GMT"]) {
    const malformedTimestamp = publicExactReviewQueueProjection({
      generated_at: timestamp,
      oldest_pending_at: timestamp,
      pending: 0,
      ready_pending: 0,
      admissible_pending: 0,
      dispatching: 0,
      leased: 0,
      lanes: {
        review: { pending: 0, capacity: 1, active: 0 },
        publication: { pending: 0, capacity: 1, active: 0 },
      },
      handoff_health: { status: "idle", phases: {} },
    });
    assert.equal(malformedTimestamp.generated_at, null);
    assert.equal(malformedTimestamp.oldest_pending_at, null);
  }
});

test("public per-item queue routes are input-independent and never call private storage", async () => {
  let queueReads = 0;
  const env = {
    EXACT_REVIEW_QUEUE: {
      idFromName() {
        return "global";
      },
      get() {
        return {
          async fetch() {
            queueReads += 1;
            throw new Error("private queue must not be queried");
          },
        };
      },
    },
  };
  const first = await worker.fetch(
    new Request(
      "https://clawsweeper.openclaw.ai/api/exact-review-queue/item?repo=generated-owner%2Fgenerated-repo&item_number=41",
    ),
    env,
  );
  const second = await worker.fetch(
    new Request(
      "https://clawsweeper.openclaw.ai/api/exact-review-queue/item?repo=unrelated-owner%2Funrelated-repo&item_number=99",
    ),
    env,
  );
  const reviews = await worker.fetch(
    new Request(
      "https://clawsweeper.openclaw.ai/api/exact-review-queue/reviews?repo=generated-owner%2Fgenerated-repo&item_number=41",
    ),
    env,
  );

  assert.equal(first.status, 410);
  assert.equal(second.status, 410);
  assert.equal(await first.text(), await second.text());
  assert.equal((await reviews.text()).includes("generated-owner"), false);
  assert.equal(queueReads, 0);
});

test("public queue HTTP route applies the closed projector before serialization", async () => {
  const marker = "generated-private-queue-marker";
  const queue = {
    async fetch() {
      return new Response(
        JSON.stringify({
          generated_at: "2026-08-15T12:00:00.000Z",
          pending: 3,
          ready_pending: 2,
          admissible_pending: 1,
          shed_since_reset: 0,
          dispatching: 1,
          leased: 0,
          oldest_pending_key: marker,
          target_stats: [{ target_repo: marker }],
          arbitrary_count: 91,
          dispatcher: { dispatch_failure_detail: marker },
          lanes: {
            review: {
              pending: 3,
              pending_depth: 3,
              shed_since_reset: 0,
              ready: 2,
              backoff: 1,
              dispatching: 1,
              leased: 0,
              parked: 0,
              capacity: 8,
              active: 1,
              available_slots: 7,
              backoff_reasons: { dispatch_debounce: 1 },
              parked_reasons: {},
              oldest_pending_key: marker,
            },
            publication: {
              pending: 0,
              pending_depth: 0,
              shed_since_reset: 0,
              ready: 0,
              backoff: 0,
              dispatching: 0,
              leased: 0,
              parked: 0,
              capacity: 4,
              active: 0,
              available_slots: 4,
              backoff_reasons: {},
              parked_reasons: {},
            },
          },
          handoff_health: {
            status: "healthy",
            reason: "handoff_current",
            message: marker,
            observed_at: "2026-08-15T12:00:00.000Z",
            warning_after_seconds: 60,
            stalled_after_seconds: 300,
            capacity: 8,
            active: 1,
            available_slots: 7,
            pending_depth: 3,
            shed_since_reset: 0,
            recovery_reasons: {},
            phases: {
              pending: { count: 3, oldest_key: marker },
              dispatching: { count: 1 },
              leased: { count: 0 },
            },
          },
          pressure: {
            status: "idle",
            reason: "capacity_available",
            capacity: 8,
            active: 1,
            pending: 3,
            ready_pending: 2,
            admissible_pending: 1,
          },
          review_failure_health: {
            status: "healthy",
            reasons: [],
            window_minutes: 60,
            attempts: 0,
            affected_targets: 0,
            retryable_attempts: 0,
            terminal_attempts: 0,
            terminal_status_observed: 0,
            terminal_status_failed: 0,
            repeated_identities: 0,
            first_seen_at: null,
            last_seen_at: null,
            by_stage: {
              agent_input_scan: 0,
              source_preparation: 0,
              provider_or_model: 0,
              workflow: 0,
            },
          },
          bay_projection: {
            complete: true,
            sample_limit: 24,
            total: 1,
            stages: {
              arriving: 1,
              "setting-up": 0,
              reviewing: 0,
              publishing: 0,
              applying: 0,
              repairing: 0,
            },
            active_overlaps: {
              arriving: 1,
              "setting-up": 0,
              reviewing: 0,
              publishing: 0,
              applying: 0,
              repairing: 0,
            },
            items: [
              {
                item_key: marker,
                repository: "openclaw/openclaw",
                item_number: 47,
                stage: "arriving",
                title: marker,
              },
              {
                repository: "private-owner/private-repo",
                item_number: 48,
                stage: "arriving",
              },
            ],
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  };
  const response = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/exact-review-queue"),
    {
      EXACT_REVIEW_QUEUE: {
        idFromName() {
          return "global";
        },
        get() {
          return queue;
        },
      },
      PUBLIC_BAY_REPOS: "openclaw/openclaw",
    },
  );
  const body = await response.json();
  const serialized = JSON.stringify(body);

  assert.equal(response.status, 200);
  assert.equal(body.pending, 3);
  assert.equal(body.lanes.review.capacity, 8);
  assert.equal(serialized.includes(marker), false);
  assert.equal(serialized.includes("target_stats"), false);
  assert.equal(serialized.includes("arbitrary_count"), false);
  assert.equal(serialized.includes("active_overlaps"), false);
  assert.deepEqual(body.bay_projection.items, [
    {
      repository: "openclaw/openclaw",
      item_number: 47,
      stage: "arriving",
      source: "queue",
      legacy_batch_path: false,
    },
  ]);
  assert.equal(serialized.includes("private-owner"), false);
});
