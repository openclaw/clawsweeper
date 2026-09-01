import assert from "node:assert/strict";
import test from "node:test";

import {
  publicApplyObservabilityProjection,
  publicAutomergeMetricsProjection,
  publicGithubEgressObservabilityProjection,
  publicRecentDurablePublicationEventsProjection,
  publicReviewCoverageProjection,
  publicReviewObservabilityProjection,
} from "../dashboard/public-observability.ts";

const NOW = "2026-08-15T12:00:00.000Z";
const PRIVATE_MARKERS = {
  repository: ["synthetic-owner", "synthetic-project"].join("/"),
  item: ["synthetic", "item", "74291"].join("-"),
  url: `https://example.invalid/${["synthetic", "object"].join("-")}?private=1`,
  query: ["private", "query", "marker"].join("_"),
  token: ["token", "synthetic", "marker"].join("_"),
  secret: ["secret", "synthetic", "marker"].join("_"),
};

function assertPrivateMarkersAbsent(value: unknown) {
  const serialized = JSON.stringify(value);
  for (const marker of Object.values(PRIVATE_MARKERS)) {
    assert.equal(serialized.includes(marker), false, `projected response retained ${marker}`);
  }
  const forbiddenKeys = new Set([
    "repo",
    "repository",
    "repositories",
    "repo_slug",
    "pr_url",
    "run_url",
    "session_id",
    "deployment_revision",
    "config_revision",
  ]);
  const visit = (item: unknown) => {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    for (const [key, nested] of Object.entries(item)) {
      assert.equal(forbiddenKeys.has(key), false, `projected response retained ${key}`);
      visit(nested);
    }
  };
  visit(value);
}

function reviewObservabilityFixture() {
  const lanes = ["exact_event", "hot_intake", "normal_backfill", "recovery"];
  return {
    mode: "required",
    health: "degraded",
    reasons: ["telemetry_unavailable", "hot_intake_degraded"],
    range: "24h",
    repo: "all",
    generated_at: NOW,
    telemetry_complete: false,
    sources: lanes.map((lane, index) => ({
      lane,
      label: `${PRIVATE_MARKERS.item}-${index}`,
      status: lane === "recovery" ? "disabled" : "healthy",
      last_run_at: index === 3 ? null : "2026-08-15T11:45:00Z",
      last_success_at: index === 3 ? null : "2026-08-15T11:40:00Z",
      item_count: index + 1,
      run_count: index + 2,
      attribution: "available",
      unexpected: { token: PRIVATE_MARKERS.token },
    })),
    nested: PRIVATE_MARKERS,
  };
}

test("review observability is global, closed, and aggregate-only", () => {
  const projected = publicReviewObservabilityProjection(reviewObservabilityFixture());
  assert.ok(projected);
  assert.equal(Object.hasOwn(projected, "repo"), false);
  assert.deepEqual(
    projected.sources.map((source) => source.lane),
    ["exact_event", "hot_intake", "normal_backfill", "recovery"],
  );
  assert.equal(Object.hasOwn(projected.sources[0]!, "label"), false);
  assertPrivateMarkersAbsent(projected);

  const filtered = reviewObservabilityFixture();
  filtered.repo = PRIVATE_MARKERS.repository;
  assert.equal(publicReviewObservabilityProjection(filtered), null);

  const malformed = reviewObservabilityFixture();
  malformed.sources[0]!.status = PRIVATE_MARKERS.item;
  assert.equal(publicReviewObservabilityProjection(malformed), null);
});

function reviewCoverageFixture() {
  return {
    ok: true,
    generated_at: NOW,
    window_days: 7,
    inventory_generated_at: "2026-08-15T11:55:00Z",
    inventory_status: "current",
    fleets: [
      {
        repo: PRIVATE_MARKERS.repository,
        repo_slug: PRIVATE_MARKERS.item,
        url: PRIVATE_MARKERS.url,
      },
    ],
    totals: {
      open_records: 12,
      reviewable_records: 10,
      tracked_records: 9,
      reviewed_recent: 8,
      stale: 1,
      failed: 0,
      expired: 0,
      unreviewed_records: 1,
      untracked_open: 1,
      pending: 1,
      excluded: 2,
      unschedulable_records: 0,
      record_drift: 0,
      coverage_percent: 80,
    },
    nested: PRIVATE_MARKERS,
  };
}

test("review coverage retains only fleet-wide aggregate counts", () => {
  const projected = publicReviewCoverageProjection(reviewCoverageFixture());
  assert.ok(projected);
  assert.equal(Object.hasOwn(projected, "fleets"), false);
  assert.equal(projected.totals.reviewed_recent, 8);
  assert.equal(projected.totals.coverage_percent, 80);
  assertPrivateMarkersAbsent(projected);

  const inconsistent = reviewCoverageFixture();
  inconsistent.totals.coverage_percent = 81;
  assert.equal(publicReviewCoverageProjection(inconsistent), null);

  const malformed = reviewCoverageFixture();
  malformed.totals.reviewed_recent = -1;
  assert.equal(publicReviewCoverageProjection(malformed), null);
});

function applyAggregate(arrivals: number) {
  return {
    arrivals,
    applied: arrivals + 1,
    closed: arrivals,
    superseded: 0,
    retried: 1,
    dead_lettered: 0,
    net_drain: 1,
  };
}

function applyObservabilityFixture() {
  return {
    schema_version: 1,
    range: "24h",
    repo: "all",
    generated_at: NOW,
    telemetry_complete: true,
    event_count: 4,
    repositories: [
      {
        repo: PRIVATE_MARKERS.repository,
        observed_at: "2026-08-15T11:45:00Z",
      },
    ],
    queue: {
      active: 2,
      capacity: 8,
      ready: 1,
      backoff: 0,
      dispatching: 1,
      leased: 1,
      oldest_ready_age_seconds: 10,
      oldest_backoff_age_seconds: null,
      oldest_lease_age_seconds: 5,
    },
    last_15_minutes: applyAggregate(1),
    last_60_minutes: applyAggregate(2),
    totals: applyAggregate(3),
    retry_amplification: 0.25,
    lease: { wait_ms: 30, hold_ms: 100 },
    failures: {
      state_lease_timeout: 0,
      state_lease_contention: 1,
      action_ledger: 0,
      state_publication: 0,
      safe_close_blocked: 0,
      safe_close_failure: 0,
      last_failure_kind: "state_lease_contention",
      last_failure_at: "2026-08-15T11:30:00Z",
      last_failure_run_url: PRIVATE_MARKERS.url,
    },
    nested: PRIVATE_MARKERS,
  };
}

test("apply observability omits repository inventory and failure links", () => {
  const projected = publicApplyObservabilityProjection(applyObservabilityFixture());
  assert.ok(projected);
  assert.equal(Object.hasOwn(projected, "repositories"), false);
  assert.equal(Object.hasOwn(projected.failures, "last_failure_run_url"), false);
  assert.equal(projected.queue.active, 2);
  assertPrivateMarkersAbsent(projected);

  const filtered = applyObservabilityFixture();
  filtered.repo = PRIVATE_MARKERS.repository;
  assert.equal(publicApplyObservabilityProjection(filtered), null);

  const malformed = applyObservabilityFixture();
  malformed.failures.last_failure_kind = PRIVATE_MARKERS.item;
  assert.equal(publicApplyObservabilityProjection(malformed), null);

  const inconsistentDrain = applyObservabilityFixture();
  inconsistentDrain.totals.net_drain = 7;
  assert.equal(publicApplyObservabilityProjection(inconsistentDrain), null);

  const inconsistentRetry = applyObservabilityFixture();
  inconsistentRetry.retry_amplification = 0.123456789;
  assert.equal(publicApplyObservabilityProjection(inconsistentRetry), null);

  const unknownDerived = applyObservabilityFixture();
  unknownDerived.last_15_minutes.arrivals = null as never;
  unknownDerived.last_15_minutes.net_drain = null as never;
  unknownDerived.totals.arrivals = 0;
  unknownDerived.totals.applied = 0;
  unknownDerived.totals.net_drain = 0;
  unknownDerived.retry_amplification = null as never;
  const unknownProjection = publicApplyObservabilityProjection(unknownDerived);
  assert.ok(unknownProjection);
  assert.equal(unknownProjection.last_15_minutes.net_drain, null);
  assert.equal(unknownProjection.retry_amplification, null);
});

function automergeBuckets() {
  const start = Date.parse("2026-08-15T06:00:00Z");
  return Array.from({ length: 12 }, (_, index) => {
    const bucketStart = start + index * 30 * 60_000;
    const populated = index === 0;
    return {
      start: new Date(bucketStart).toISOString(),
      end: new Date(bucketStart + 30 * 60_000).toISOString(),
      terminal_count: populated ? 3 : 0,
      merged_count: populated ? 1 : 0,
      success_rate_percent: populated ? 33.3 : null,
      command_to_merge_p50_ms: populated ? 1_000 : null,
      command_to_merge_p90_ms: populated ? 1_000 : null,
      low_sample: populated,
    };
  });
}

function automergeFixture() {
  return {
    generated_at: NOW,
    range: "6h",
    range_start: "2026-08-15T06:00:00Z",
    telemetry_since: "2026-08-15T06:00:00Z",
    coverage_percent: 100,
    filters: {
      repo: null,
      policy_version: null,
      repositories: [PRIVATE_MARKERS.repository],
      policy_versions: [PRIVATE_MARKERS.item],
    },
    summary: {
      terminal_sessions: 3,
      merged_sessions: 1,
      merge_success_rate_percent: 33.3,
      command_to_merge_p50_ms: 1_000,
      command_to_merge_p90_ms: 1_000,
      base_sync_p50: 1,
      base_sync_p90: 2,
      multi_rebase_rate_percent: 33.3,
      active_sessions: 2,
    },
    buckets: automergeBuckets(),
    terminal_outcomes: {
      merged: 1,
      repair_failed: 1,
      [PRIVATE_MARKERS.item]: 1,
    },
    repair_efficiency: {
      zero_base_sync: 1,
      one_base_sync: 1,
      multiple_base_sync: 1,
    },
    sessions: [
      {
        session_id: PRIVATE_MARKERS.token,
        repository: PRIVATE_MARKERS.repository,
        item_number: 74291,
        pr_url: PRIVATE_MARKERS.url,
        run_url: PRIVATE_MARKERS.url,
        last_reason: PRIVATE_MARKERS.secret,
      },
    ],
  };
}

test("automerge metrics collapse unknown outcomes and omit sessions and filters", () => {
  const projected = publicAutomergeMetricsProjection(automergeFixture());
  assert.ok(projected);
  assert.equal(Object.hasOwn(projected, "filters"), false);
  assert.equal(Object.hasOwn(projected, "sessions"), false);
  assert.equal(projected.terminal_outcomes.unknown, 1);
  assert.equal(Object.hasOwn(projected.terminal_outcomes, PRIVATE_MARKERS.item), false);
  assertPrivateMarkersAbsent(projected);

  const filtered = automergeFixture();
  filtered.filters.repo = PRIVATE_MARKERS.repository;
  assert.equal(publicAutomergeMetricsProjection(filtered), null);

  const malformed = automergeFixture();
  malformed.buckets[0]!.terminal_count = 4;
  assert.equal(publicAutomergeMetricsProjection(malformed), null);

  const inconsistentCoverage = automergeFixture();
  inconsistentCoverage.coverage_percent = 12.3456789;
  assert.equal(publicAutomergeMetricsProjection(inconsistentCoverage), null);

  const inconsistentMultiRebase = automergeFixture();
  inconsistentMultiRebase.summary.multi_rebase_rate_percent = 12.3456789;
  assert.equal(publicAutomergeMetricsProjection(inconsistentMultiRebase), null);

  const malformedSummaryLatency = automergeFixture();
  malformedSummaryLatency.summary.command_to_merge_p50_ms = null as never;
  assert.equal(publicAutomergeMetricsProjection(malformedSummaryLatency), null);

  const malformedBucketLatency = automergeFixture();
  malformedBucketLatency.buckets[0]!.command_to_merge_p50_ms = null as never;
  assert.equal(publicAutomergeMetricsProjection(malformedBucketLatency), null);

  const malformedBaseSync = automergeFixture();
  malformedBaseSync.summary.base_sync_p50 = null as never;
  assert.equal(publicAutomergeMetricsProjection(malformedBaseSync), null);

  const empty = automergeFixture();
  empty.telemetry_since = null as never;
  empty.coverage_percent = 0;
  empty.summary = {
    terminal_sessions: 0,
    merged_sessions: 0,
    merge_success_rate_percent: null as never,
    command_to_merge_p50_ms: null as never,
    command_to_merge_p90_ms: null as never,
    base_sync_p50: null as never,
    base_sync_p90: null as never,
    multi_rebase_rate_percent: null as never,
    active_sessions: 2,
  };
  empty.buckets = empty.buckets.map((bucket) => ({
    ...bucket,
    terminal_count: 0,
    merged_count: 0,
    success_rate_percent: null,
    command_to_merge_p50_ms: null,
    command_to_merge_p90_ms: null,
    low_sample: false,
  })) as typeof empty.buckets;
  empty.terminal_outcomes = {};
  empty.repair_efficiency = { zero_base_sync: 0, one_base_sync: 0, multiple_base_sync: 0 };
  const emptyProjection = publicAutomergeMetricsProjection(empty);
  assert.ok(emptyProjection);
  assert.equal(emptyProjection.coverage_percent, 0);
  assert.equal(emptyProjection.summary.multi_rebase_rate_percent, null);
});

function githubRollup(overrides: Record<string, unknown> = {}) {
  return {
    bucket_start: "2026-08-15T11:55:00Z",
    deployment_revision: "aaaaaaaaaaaaaaaa",
    config_revision: "bbbbbbbbbbbbbbbb",
    pool_class: "repository_actions",
    stage: "publication_apply",
    source_action: "exact_event",
    operation: "comments",
    method: "POST",
    route_template: "issue_comments",
    page_bucket: "none",
    unit: "invocation",
    outcome: "success",
    status_bucket: "2xx",
    latency_bucket: "100_249ms",
    claim_generation_bucket: "1",
    first_repeat: "first",
    attempted: true,
    telemetry_complete: true,
    count: 2,
    nested: PRIVATE_MARKERS,
    ...overrides,
  };
}

function githubEgressFixture() {
  return {
    version: 2,
    generated_at: NOW,
    window: { hours: 6, bucket_minutes: 5 },
    units: {
      invocation: 5,
      wire_attempt: 0,
      member: 0,
      broker_lookup: 0,
      conditional_response: 0,
    },
    rows: [
      githubRollup(),
      githubRollup({
        deployment_revision: "cccccccccccccccc",
        config_revision: "dddddddddddddddd",
        count: 3,
      }),
    ],
    rate_limit_observations: [
      {
        observed_at: "2026-08-15T11:58:00Z",
        deployment_revision: "aaaaaaaaaaaaaaaa",
        config_revision: "bbbbbbbbbbbbbbbb",
        pool_class: "repository_actions",
        stage: "publication_apply",
        source_action: "exact_event",
        operation: "comments",
        method: "POST",
        route_template: "issue_comments",
        page_bucket: "none",
        status: 429,
        headers: {
          retry_after_present: true,
          retry_after_seconds: 60,
          limit_present: true,
          limit: 5_000,
          remaining_present: true,
          remaining: 0,
          used_present: true,
          used: 5_000,
          reset_present: true,
          reset_epoch_seconds: 1_800_000_000,
          resource_present: true,
          resource: "core",
          unexpected: PRIVATE_MARKERS.secret,
        },
        reset_authority_candidate: "retry_after",
        telemetry_complete: true,
        url: PRIVATE_MARKERS.url,
      },
    ],
    retention: {
      rollup_evicted_rows_total: 0,
      rollup_eviction_count_exact: true,
      rate_limit_evicted_rows_total: 0,
      last_rollup_evicted_bucket_start: null,
      last_rate_limit_evicted_observed_at: null,
    },
    completeness: {
      complete: 5,
      incomplete: 0,
      observed: true,
      telemetry_complete: true,
      rows_truncated: false,
      rate_limit_rows_truncated: false,
      rollup_window_complete: true,
      rate_limit_window_complete: true,
      query_complete: true,
    },
    privacy: { raw_identifiers: false, nested: PRIVATE_MARKERS },
  };
}

function githubThrottleEgressFixture() {
  const fixture = githubEgressFixture();
  return {
    ...fixture,
    window: { hours: 168, bucket_minutes: 60 },
    units: { ...fixture.units, wire_attempt: 5 },
    rows: [
      ...fixture.rows,
      githubRollup({
        bucket_start: "2026-08-15T10:00:00.000Z",
        unit: "wire_attempt",
        outcome: "throttle",
        status_bucket: "403",
        count: 2,
      }),
      githubRollup({
        bucket_start: "2026-08-15T11:00:00.000Z",
        pool_class: "target_app",
        unit: "wire_attempt",
        outcome: "throttle",
        status_bucket: "429",
        count: 3,
      }),
    ],
    throttle_series: {
      unit: "wire_attempt",
      closed_through: NOW,
      first_available_bucket_start: "2026-08-08T11:00:00.000Z",
      rows: [
        {
          bucket_start: "2026-08-15T10:00:00.000Z",
          pool_class: "repository_actions",
          status_bucket: "403",
          count: 2,
          nested: PRIVATE_MARKERS,
        },
        {
          bucket_start: "2026-08-15T11:00:00.000Z",
          pool_class: "target_app",
          status_bucket: "429",
          count: 3,
        },
      ],
      rows_truncated: false,
      excluded_incomplete_count: 0,
      coverage_complete: true,
      complete: true,
      private_pool: PRIVATE_MARKERS.token,
    },
    retention: { ...fixture.retention, rate_limit_detail_hours: 24 },
    completeness: {
      ...fixture.completeness,
      complete: 10,
      rate_limit_window_complete: false,
      query_complete: false,
    },
  };
}

test("GitHub egress rollups aggregate across revisions and rate-limit rows", () => {
  const projected = publicGithubEgressObservabilityProjection(githubEgressFixture());
  assert.ok(projected);
  assert.equal(projected.rows.length, 1);
  assert.equal(projected.rows[0]!.count, 5);
  assert.equal(projected.rate_limits.total, 1);
  assert.equal(projected.rate_limits.by_status["429"], 1);
  assert.equal(projected.rate_limits.by_resource.core, 1);
  assert.equal(projected.privacy.revision_digests, "withheld");
  assertPrivateMarkersAbsent(projected);
  const serialized = JSON.stringify(projected);
  assert.equal(serialized.includes("aaaaaaaaaaaaaaaa"), false);
  assert.equal(serialized.includes("dddddddddddddddd"), false);

  const knownInvalidHeader = githubEgressFixture();
  knownInvalidHeader.rate_limit_observations[0]!.headers.retry_after_seconds = null;
  knownInvalidHeader.rate_limit_observations[0]!.reset_authority_candidate = "invalid";
  assert.ok(publicGithubEgressObservabilityProjection(knownInvalidHeader));

  const malformed = githubEgressFixture();
  malformed.rows[0]!.operation = PRIVATE_MARKERS.item;
  assert.equal(publicGithubEgressObservabilityProjection(malformed), null);

  const inconsistent = githubEgressFixture();
  inconsistent.completeness.query_complete = false;
  assert.equal(publicGithubEgressObservabilityProjection(inconsistent), null);

  const inconsistentUnits = githubEgressFixture();
  inconsistentUnits.units.invocation = 6;
  assert.equal(publicGithubEgressObservabilityProjection(inconsistentUnits), null);

  const inconsistentRows = githubEgressFixture();
  inconsistentRows.completeness.complete = 4;
  assert.equal(publicGithubEgressObservabilityProjection(inconsistentRows), null);

  const falseRollupTruncation = githubEgressFixture();
  falseRollupTruncation.completeness.rows_truncated = true;
  falseRollupTruncation.completeness.query_complete = false;
  assert.equal(publicGithubEgressObservabilityProjection(falseRollupTruncation), null);

  const falseRateLimitTruncation = githubEgressFixture();
  falseRateLimitTruncation.completeness.rate_limit_rows_truncated = true;
  falseRateLimitTruncation.completeness.query_complete = false;
  assert.equal(publicGithubEgressObservabilityProjection(falseRateLimitTruncation), null);

  const truncated = githubEgressFixture();
  truncated.rows = Array.from({ length: 2_000 }, (_, index) =>
    githubRollup({
      deployment_revision: index % 2 ? "cccccccccccccccc" : "aaaaaaaaaaaaaaaa",
      config_revision: index % 2 ? "dddddddddddddddd" : "bbbbbbbbbbbbbbbb",
      count: 1,
    }),
  );
  truncated.units.invocation = 2_001;
  truncated.completeness.complete = 2_001;
  truncated.completeness.rows_truncated = true;
  truncated.completeness.query_complete = false;
  const truncatedProjection = publicGithubEgressObservabilityProjection(truncated);
  assert.ok(truncatedProjection);
  assert.equal(
    truncatedProjection.rows.reduce((total, row) => total + row.count, 0),
    2_000,
  );
  assert.equal(truncatedProjection.completeness.query_complete, false);
});

test("GitHub throttle history survives the strict public projection as bounded closed aggregates", () => {
  const fixture = githubThrottleEgressFixture();
  const projected = publicGithubEgressObservabilityProjection(fixture);
  assert.ok(projected);
  assert.equal(projected.window.hours, 168);
  assert.equal(projected.retention.rate_limit_detail_hours, 24);
  assert.deepEqual(projected.throttle_series.rows, [
    {
      bucket_start: "2026-08-15T10:00:00.000Z",
      pool_class: "repository_actions",
      status_bucket: "403",
      count: 2,
    },
    {
      bucket_start: "2026-08-15T11:00:00.000Z",
      pool_class: "target_app",
      status_bucket: "429",
      count: 3,
    },
  ]);
  assert.equal(projected.throttle_series.complete, true);
  assertPrivateMarkersAbsent(projected);
  assert.deepEqual(publicGithubEgressObservabilityProjection(projected), projected);

  const partialFirstBucket = structuredClone(fixture);
  partialFirstBucket.throttle_series.first_available_bucket_start = "2026-08-08T12:00:00.000Z";
  partialFirstBucket.throttle_series.coverage_complete = false;
  partialFirstBucket.throttle_series.complete = false;
  const partialFirstBucketProjection =
    publicGithubEgressObservabilityProjection(partialFirstBucket);
  assert.ok(partialFirstBucketProjection);
  assert.equal(partialFirstBucketProjection.throttle_series.coverage_complete, false);
  assert.equal(partialFirstBucketProjection.throttle_series.complete, false);

  const duplicate = structuredClone(fixture);
  duplicate.throttle_series.rows.push({ ...duplicate.throttle_series.rows[0]! });
  assert.equal(publicGithubEgressObservabilityProjection(duplicate), null);

  const invalidPool = structuredClone(fixture);
  invalidPool.throttle_series.rows[0]!.pool_class = PRIVATE_MARKERS.token;
  assert.equal(publicGithubEgressObservabilityProjection(invalidPool), null);

  const overCap = structuredClone(fixture);
  overCap.throttle_series.rows = Array.from({ length: 1_345 }, () => ({
    ...fixture.throttle_series.rows[0]!,
  }));
  assert.equal(publicGithubEgressObservabilityProjection(overCap), null);

  const falseCompleteness = structuredClone(fixture);
  falseCompleteness.throttle_series.complete = false;
  assert.equal(publicGithubEgressObservabilityProjection(falseCompleteness), null);

  const impossibleExcludedCount = structuredClone(fixture);
  impossibleExcludedCount.throttle_series.excluded_incomplete_count = 1;
  impossibleExcludedCount.throttle_series.complete = false;
  assert.equal(publicGithubEgressObservabilityProjection(impossibleExcludedCount), null);
});

function publicationBuckets(outcomes: readonly string[], populated?: string) {
  return Array.from({ length: 24 }, (_, index) => ({
    index,
    counts: Object.fromEntries(
      outcomes.map((outcome) => [outcome, index === 0 && outcome === populated ? 1 : 0]),
    ),
    nested: PRIVATE_MARKERS,
  }));
}

function recentPublicationFixture() {
  return {
    version: 1,
    captured_at: NOW,
    window: {
      id: "24h",
      start_at: "2026-08-14T12:00:00Z",
      end_at: NOW,
      bucket_seconds: 3_600,
      bucket_count: 24,
    },
    collection: { state: "complete", complete: true, scan_limit: 10_000 },
    activity: { state: "observed" },
    direct: {
      complete: true,
      rows: 1,
      latest_observed_at: "2026-08-15T11:30:00Z",
      counts: { accepted: 1, deduped: 0, superseded: 0, fallback: 0 },
      buckets: publicationBuckets(["accepted", "deduped", "superseded", "fallback"], "accepted"),
      nested: PRIVATE_MARKERS,
    },
    batch: {
      complete: true,
      rows: 0,
      latest_observed_at: null,
      counts: { superseded: 0, retryable: 0, permanent: 0 },
      buckets: publicationBuckets(["superseded", "retryable", "permanent"]),
      nested: PRIVATE_MARKERS,
    },
    provenance: { omitted: Object.values(PRIVATE_MARKERS) },
  };
}

test("recent durable publication events are revalidated into a fixed aggregate schema", () => {
  const projected = publicRecentDurablePublicationEventsProjection(recentPublicationFixture());
  assert.ok(projected);
  assert.equal(projected.direct.counts.accepted, 1);
  assert.equal(projected.batch.rows, 0);
  assertPrivateMarkersAbsent(projected);

  const malformed = recentPublicationFixture();
  malformed.direct.buckets[0]!.counts.accepted = 2;
  assert.equal(publicRecentDurablePublicationEventsProjection(malformed), null);

  const inconsistent = recentPublicationFixture();
  inconsistent.activity.state = "idle";
  assert.equal(publicRecentDurablePublicationEventsProjection(inconsistent), null);
});

test("all public projectors fail closed for non-object and nested malformed inputs", () => {
  for (const projector of [
    publicReviewObservabilityProjection,
    publicReviewCoverageProjection,
    publicApplyObservabilityProjection,
    publicAutomergeMetricsProjection,
    publicGithubEgressObservabilityProjection,
    publicRecentDurablePublicationEventsProjection,
  ]) {
    assert.equal(projector(null), null);
    assert.equal(projector([]), null);
    assert.equal(projector({ value: { nested: PRIVATE_MARKERS } }), null);
  }
});

test("public observability projections are idempotent and reject non-ISO timestamp channels", () => {
  const cases = [
    [publicReviewObservabilityProjection, reviewObservabilityFixture, "generated_at"],
    [publicReviewCoverageProjection, reviewCoverageFixture, "generated_at"],
    [publicApplyObservabilityProjection, applyObservabilityFixture, "generated_at"],
    [publicAutomergeMetricsProjection, automergeFixture, "generated_at"],
    [publicGithubEgressObservabilityProjection, githubEgressFixture, "generated_at"],
    [publicRecentDurablePublicationEventsProjection, recentPublicationFixture, "captured_at"],
  ] as const;

  for (const [projector, fixture, timestampField] of cases) {
    const projected = projector(fixture());
    assert.ok(projected);
    assert.deepEqual(projector(projected), projected);
    for (const invalidTimestamp of [
      "1171",
      "https://example.invalid/private?timestamp=1",
      "2026-08-15T12:00:00.000Z".repeat(3),
    ]) {
      const malformed = fixture() as Record<string, unknown>;
      malformed[timestampField] = invalidTimestamp;
      assert.equal(projector(malformed), null);
    }
  }
});
