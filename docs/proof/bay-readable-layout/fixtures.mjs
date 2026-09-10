// Local proof input only. Never imported by dashboard production code.
export const stages = [
  "arriving",
  "setting-up",
  "reviewing",
  "publishing",
  "applying",
  "repairing",
];
export const repositories = [
  "openclaw/openclaw",
  "openclaw/clawsweeper",
  "openclaw/a-very-long-public-repository-name-for-layout-proof",
];
export const scenarios = [
  "normal",
  "crowded",
  "mixed",
  "long",
  "empty",
  "stale",
  "partial",
  "unknown",
  "terminal",
  "batch",
  "missing",
  "partial-activity",
  "forward",
];
export const emptyStages = () => Object.fromEntries(stages.map((stage) => [stage, 0]));
const emptySet = () => ({
  overall: { samples: 0, median_ms: null, average_ms: null },
  history: { bucket_minutes: 5, points: [] },
});
function timingSet(now, durations) {
  if (!durations.length) return emptySet();
  const sorted = [...durations].sort((a, b) => a - b);
  const median =
    (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
  return {
    overall: {
      samples: durations.length,
      median_ms: median,
      average_ms: durations.reduce((a, b) => a + b, 0) / durations.length,
    },
    history: {
      bucket_minutes: 5,
      points: durations
        .map((duration, index) => ({
          ended_at: new Date(Math.floor(now / 300000) * 300000 - index * 300000).toISOString(),
          samples: 1,
          median_ms: duration,
          average_ms: duration,
        }))
        .reverse(),
    },
  };
}
export function statusFixture(scenario, epoch) {
  if (!scenarios.includes(scenario) || !Number.isSafeInteger(epoch))
    throw new Error("invalid proof fixture");
  const now = epoch - (scenario === "stale" ? 600000 : 0),
    generated = new Date(now).toISOString();
  const queue = emptyStages(),
    live = emptyStages(),
    legacyQueue = emptyStages(),
    legacyLive = emptyStages();
  const count =
    scenario === "empty" || scenario === "terminal"
      ? 0
      : ["normal", "forward"].includes(scenario)
        ? 2
        : 8;
  const items = [];
  for (const [stageIndex, stage] of stages.entries()) {
    for (let i = 0; i < count; i++) {
      const source = i % 3 === 0 ? "queue" : "live",
        legacy = stage === "publishing" && i % 2 === 0;
      (source === "queue" ? queue : live)[stage]++;
      if (legacy) (source === "queue" ? legacyQueue : legacyLive)[stage]++;
      items.push({
        repository:
          scenario === "long"
            ? repositories[2]
            : repositories[(stageIndex + i) % (scenario === "mixed" ? 3 : 2)],
        item_number:
          scenario === "long" ? 999999000 + stageIndex * 100 + i : 91000 + stageIndex * 100 + i,
        stage,
        source,
        legacy_batch_path: legacy,
        timing:
          scenario === "unknown"
            ? null
            : {
                kind: source === "queue" ? "queue" : "run",
                started_at: new Date(now - 60000 * (i + 1)).toISOString(),
              },
        title: "PRIVATE_UI_FIXTURE_SENTINEL",
        item_url: "https://invalid.example/PRIVATE_UI_FIXTURE_SENTINEL",
      });
    }
  }
  if (scenario === "forward") {
    const moved = items.find((item) => item.item_number === 91001);
    live[moved.stage]--;
    moved.stage = "reviewing";
    live.reviewing++;
  }
  // Unsampled aggregate work deliberately has no accessible invented identity.
  if (count > 2) queue.reviewing += 40;
  const terminals =
    scenario === "empty"
      ? []
      : Array.from({ length: scenario === "terminal" || count > 2 ? 12 : 3 }, (_, i) => ({
          outcome: i < 7 ? "success" : i % 2 ? "failure" : "cancelled",
          repository: repositories[i % 2],
          item_number: 97000 + i,
          legacy_batch_path: i === 0,
          journey_duration_ms: 60000 * (i + 1),
          title: "PRIVATE_UI_FIXTURE_SENTINEL",
        }));
  const requested = scenario === "empty" ? [] : [120000, 240000],
    notRequested = scenario === "empty" ? [] : [60000],
    unknown = scenario === "empty" ? [] : [600000];
  const direct = {
    ...timingSet(now, [...requested, ...notRequested, ...unknown]),
    inline_proof: {
      requested: timingSet(now, requested),
      not_requested: timingSet(now, notRequested),
      unknown: timingSet(now, unknown),
    },
  };
  const allUnknown = scenario === "empty" ? [] : [...unknown, 900000];
  const all = {
    ...timingSet(now, [...requested, ...notRequested, ...allUnknown]),
    inline_proof: {
      requested: timingSet(now, requested),
      not_requested: timingSet(now, notRequested),
      unknown: timingSet(now, allUnknown),
    },
  };
  if (scenario === "unknown") {
    delete direct.inline_proof;
    delete all.inline_proof;
  }
  const queueTotal = Object.values(queue).reduce((a, b) => a + b, 0),
    liveTotal = Object.values(live).reduce((a, b) => a + b, 0);
  // publicExactReviewQueueProjection validates collection from raw telemetry,
  // not the supplied collection.state label. Top-level counters describe the
  // review lane; publication has its own independently consistent counters.
  const telemetryLane = (pending, leased, capacity) => ({
    pending,
    pending_depth: pending,
    shed_since_reset: 0,
    ready: pending,
    backoff: 0,
    dispatching: 0,
    leased,
    parked: 0,
    capacity,
    active: leased,
    available_slots: Math.max(0, capacity - leased),
    enqueued_total: pending + leased,
    completed_total: 0,
    backoff_reasons: {},
    parked_reasons: {},
  });
  const reviewLane = telemetryLane(queueTotal - queue.publishing, liveTotal - live.publishing, 64);
  const publicationLane = telemetryLane(queue.publishing, live.publishing, 24);
  const snapshot = {
    schema_version: 1,
    public_projection_complete: true,
    generated_at: generated,
    source: { target_repository_count: repositories.length },
    fleet: {
      active_codex_jobs: liveTotal,
      active_workflow_runs: liveTotal,
      worker_budget: 128,
      budget_used_percent: 0,
    },
    workers: [],
    automatic_work: [],
    pipeline: [],
    diagnostics: {
      errors: scenario === "partial" ? ["PRIVATE_UI_FIXTURE_SENTINEL"] : [],
      error_count: scenario === "partial" ? 1 : 0,
    },
    health: { sampled_runs: terminals.length },
    exact_review_queue: {
      collection: { state: "complete" },
      generated_at: generated,
      pending: reviewLane.pending,
      ready_pending: reviewLane.ready,
      admissible_pending: reviewLane.ready,
      shed_since_reset: reviewLane.shed_since_reset,
      dispatching: reviewLane.dispatching,
      leased: reviewLane.leased,
      lanes: { review: reviewLane, publication: publicationLane },
      pressure: {
        status: reviewLane.ready ? "congested" : "idle",
        reason: reviewLane.ready ? "capacity_available" : "no_ready_backlog",
        capacity: reviewLane.capacity,
        active: reviewLane.active,
        pending: reviewLane.pending,
        ready_pending: reviewLane.ready,
        admissible_pending: reviewLane.ready,
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
        by_stage: { agent_input_scan: 0, source_preparation: 0, provider_or_model: 0, workflow: 0 },
      },
      handoff_health: {
        status: reviewLane.pending || reviewLane.active ? "healthy" : "idle",
        reason: reviewLane.pending || reviewLane.active ? "handoff_current" : "queue_empty",
        observed_at: generated,
        capacity: reviewLane.capacity,
        active: reviewLane.active,
        available_slots: reviewLane.available_slots,
        pending_depth: reviewLane.pending_depth,
        shed_since_reset: reviewLane.shed_since_reset,
        phases: {
          pending: {
            count: reviewLane.pending,
            oldest_age_seconds: reviewLane.pending ? 60 : null,
          },
          dispatching: { count: 0, oldest_age_seconds: null },
          leased: { count: reviewLane.leased, oldest_age_seconds: reviewLane.leased ? 60 : null },
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
        total: queueTotal,
        stages: queue,
        legacy_batch_stages: legacyQueue,
        items: items.filter((item) => item.source === "queue").slice(0, 24),
        activity: {
          complete: true,
          total: queueTotal + liveTotal,
          queue_stages: queue,
          live_stages: live,
          queue_legacy_batch_stages: legacyQueue,
          live_legacy_batch_stages: legacyLive,
          items,
        },
      },
    },
    bay: {
      metrics_state: "complete",
      timing_coverage_complete: true,
      timing_coverage_started_at: new Date(now - 7200000).toISOString(),
      tide_generation: 0,
      tide_threshold: 20,
      terminal_count: terminals.length,
      terminal_buffer: terminals,
      recently_washed: [],
      active_stages: live,
      active_census_complete: true,
      last_tide_at: null,
      washed_at: null,
      timings: {
        sample_kind: "completed_review_journeys",
        source: "durable_exact_review_lifecycles",
        completion_source: "verified_final_review_receipts",
        window_minutes: 60,
        window_ended_at: generated,
        ...direct,
        including_legacy_batch: all,
      },
    },
  };
  if (scenario === "unknown") for (const row of items) delete row.timing;
  if (scenario === "missing") {
    snapshot.bay.metrics_state = "unavailable";
    snapshot.bay.timing_coverage_complete = false;
    snapshot.bay.timings.window_ended_at = null;
  }
  if (scenario === "partial-activity") {
    snapshot.bay.active_census_complete = false;
    snapshot.exact_review_queue.bay_projection.activity = {
      complete: false,
      queue_stages: null,
      live_stages: null,
      queue_legacy_batch_stages: null,
      live_legacy_batch_stages: null,
      total: null,
    };
  }
  return snapshot;
}
