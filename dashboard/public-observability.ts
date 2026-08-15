import {
  GITHUB_EGRESS_CLAIM_GENERATION_BUCKETS,
  GITHUB_EGRESS_LATENCY_BUCKETS,
  GITHUB_EGRESS_METHODS,
  GITHUB_EGRESS_OPERATIONS,
  GITHUB_EGRESS_OUTCOMES,
  GITHUB_EGRESS_PAGE_BUCKETS,
  GITHUB_EGRESS_POOL_CLASSES,
  GITHUB_EGRESS_ROUTE_TEMPLATES,
  GITHUB_EGRESS_SOURCE_ACTIONS,
  GITHUB_EGRESS_STAGES,
  GITHUB_EGRESS_STATUS_BUCKETS,
  GITHUB_EGRESS_UNITS,
} from "../src/github-egress-telemetry-contract.ts";

const MAX_PUBLIC_COUNT = 10_000_000;
const MAX_GITHUB_COUNT = 10_000_000_000;
const MAX_DURATION_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_GITHUB_ROLLUP_ROWS = 2_000;
const MAX_GITHUB_RATE_LIMIT_ROWS = 256;
const MAX_GITHUB_THROTTLE_ROWS = 7 * 24 * GITHUB_EGRESS_POOL_CLASSES.length * 2;

const REVIEW_RANGES = ["6h", "24h", "7d"] as const;
const REVIEW_LANES = ["exact_event", "hot_intake", "normal_backfill", "recovery"] as const;
const REVIEW_MODES = ["passive", "warmup", "required"] as const;
const REVIEW_HEALTH = ["passive", "healthy", "degraded", "critical"] as const;
const REVIEW_LANE_STATUS = [
  "passive",
  "disabled",
  "idle",
  "healthy",
  "degraded",
  "critical",
] as const;
const REVIEW_REASONS = [
  "telemetry_unavailable",
  ...REVIEW_LANES.flatMap((lane) => [`${lane}_missed_cadence`, `${lane}_degraded`]),
] as const;

const APPLY_FAILURE_KINDS = [
  "state_lease_timeout",
  "state_lease_contention",
  "action_ledger_failure",
  "state_publication_failure",
  "safe_close_blocked",
  "safe_close_failure",
  "workflow_failure",
] as const;
const APPLY_QUEUE_FIELDS = [
  "active",
  "capacity",
  "ready",
  "backoff",
  "dispatching",
  "leased",
  "oldest_ready_age_seconds",
  "oldest_backoff_age_seconds",
  "oldest_lease_age_seconds",
] as const;
const APPLY_RESULT_FIELDS = [
  "arrivals",
  "applied",
  "closed",
  "superseded",
  "retried",
  "dead_lettered",
] as const;
const APPLY_FAILURE_COUNT_FIELDS = [
  "state_lease_timeout",
  "state_lease_contention",
  "action_ledger",
  "state_publication",
  "safe_close_blocked",
  "safe_close_failure",
] as const;

const AUTOMERGE_OUTCOMES = [
  "merged",
  "repair_failed",
  "maintainer_stopped",
  "repair_cap_exhausted",
  "pr_closed",
  "automerge_disabled",
] as const;
const AUTOMERGE_BUCKET_COUNTS = { "6h": 12, "24h": 12, "7d": 14 } as const;
const AUTOMERGE_RANGE_MS = {
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
} as const;

const GITHUB_FIRST_REPEAT = ["first", "repeat", "unknown"] as const;
const GITHUB_RESET_AUTHORITIES = ["retry_after", "rate_limit_reset", "absent", "invalid"] as const;
const GITHUB_RATE_LIMIT_RESOURCES = [
  "core",
  "graphql",
  "search",
  "integration_manifest",
  "unknown",
] as const;
const GITHUB_UNIT_FIELDS = [
  "invocation",
  "wire_attempt",
  "member",
  "broker_lookup",
  "conditional_response",
] as const;

const DIRECT_PUBLICATION_OUTCOMES = ["accepted", "deduped", "superseded", "fallback"] as const;
const BATCH_PUBLICATION_OUTCOMES = ["superseded", "retryable", "permanent"] as const;
const PUBLICATION_WINDOW_SECONDS = { "6h": 900, "24h": 3600, "7d": 25_200 } as const;
const PUBLIC_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const PUBLIC_TIMESTAMP_MIN_MS = Date.UTC(2020, 0, 1);
const PUBLIC_TIMESTAMP_MAX_MS = Date.UTC(2100, 0, 1);

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function member<const Value>(values: readonly Value[], value: unknown): value is Value {
  return values.some((candidate) => candidate === value);
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 35 || !PUBLIC_TIMESTAMP_PATTERN.test(value)) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) &&
    parsed >= PUBLIC_TIMESTAMP_MIN_MS &&
    parsed < PUBLIC_TIMESTAMP_MAX_MS
    ? new Date(parsed).toISOString()
    : null;
}

function nullableTimestamp(value: unknown): string | null | undefined {
  if (value === null) return null;
  return timestamp(value) ?? undefined;
}

function count(value: unknown, maximum = MAX_PUBLIC_COUNT): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum
    ? Number(value)
    : null;
}

function positiveCount(value: unknown, maximum = MAX_PUBLIC_COUNT): number | null {
  const parsed = count(value, maximum);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function nullableCount(value: unknown, maximum = MAX_PUBLIC_COUNT): number | null | undefined {
  if (value === null) return null;
  return count(value, maximum) ?? undefined;
}

function nullableSignedCount(value: unknown): number | null | undefined {
  if (value === null) return null;
  return Number.isSafeInteger(value) && Math.abs(Number(value)) <= MAX_PUBLIC_COUNT
    ? Number(value)
    : undefined;
}

function nullableNumber(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : undefined;
}

function nullableCountObject(value: unknown, fields: readonly string[]) {
  const source = objectValue(value);
  if (!source) return null;
  const result: Record<string, number | null> = {};
  for (const field of fields) {
    const parsed = nullableCount(source[field]);
    if (parsed === undefined) return null;
    result[field] = parsed;
  }
  return result;
}

function countObject(value: unknown, fields: readonly string[]) {
  const source = objectValue(value);
  if (!source) return null;
  const result: Record<string, number> = {};
  for (const field of fields) {
    const parsed = count(source[field]);
    if (parsed === null) return null;
    result[field] = parsed;
  }
  return result;
}

export function publicReviewObservabilityProjection(value: unknown) {
  const source = objectValue(value);
  if (!source) return null;
  const generatedAt = timestamp(source.generated_at);
  if (
    !member(REVIEW_MODES, source.mode) ||
    !member(REVIEW_HEALTH, source.health) ||
    !member(REVIEW_RANGES, source.range) ||
    (source.repo !== undefined && source.repo !== "all") ||
    !generatedAt ||
    typeof source.telemetry_complete !== "boolean" ||
    !Array.isArray(source.reasons) ||
    source.reasons.length > REVIEW_REASONS.length ||
    !Array.isArray(source.sources) ||
    source.sources.length !== REVIEW_LANES.length
  ) {
    return null;
  }
  const reasons = source.reasons.map(String);
  if (
    new Set(reasons).size !== reasons.length ||
    reasons.some((reason) => !member(REVIEW_REASONS, reason))
  ) {
    return null;
  }
  const lanes = new Map<string, JsonObject>();
  for (const value of source.sources) {
    const lane = objectValue(value);
    if (!lane || !member(REVIEW_LANES, lane.lane) || lanes.has(lane.lane)) return null;
    lanes.set(lane.lane, lane);
  }
  const sources = [];
  for (const laneName of REVIEW_LANES) {
    const lane = lanes.get(laneName);
    if (
      !lane ||
      !member(REVIEW_LANE_STATUS, lane.status) ||
      !member(["available", "unavailable"], lane.attribution)
    ) {
      return null;
    }
    const lastRunAt = nullableTimestamp(lane.last_run_at);
    const lastSuccessAt = nullableTimestamp(lane.last_success_at);
    const itemCount = count(lane.item_count);
    const runCount = count(lane.run_count);
    if (
      lastRunAt === undefined ||
      lastSuccessAt === undefined ||
      itemCount === null ||
      runCount === null
    ) {
      return null;
    }
    sources.push({
      lane: laneName,
      status: lane.status,
      last_run_at: lastRunAt,
      last_success_at: lastSuccessAt,
      item_count: itemCount,
      run_count: runCount,
      attribution: lane.attribution,
    });
  }
  return {
    mode: source.mode,
    health: source.health,
    reasons,
    range: source.range,
    generated_at: generatedAt,
    telemetry_complete: source.telemetry_complete,
    sources,
  };
}

const REVIEW_COVERAGE_TOTAL_FIELDS = [
  "open_records",
  "reviewable_records",
  "tracked_records",
  "reviewed_recent",
  "stale",
  "failed",
  "expired",
  "unreviewed_records",
  "untracked_open",
  "pending",
  "excluded",
  "unschedulable_records",
  "record_drift",
] as const;

export function publicReviewCoverageProjection(value: unknown) {
  const source = objectValue(value);
  const totalsSource = objectValue(source?.totals);
  if (!source || source.ok !== true || !totalsSource) return null;
  const generatedAt = timestamp(source.generated_at);
  const inventoryGeneratedAt = nullableTimestamp(source.inventory_generated_at);
  const windowDays = count(source.window_days, 90);
  if (
    !generatedAt ||
    inventoryGeneratedAt === undefined ||
    windowDays === null ||
    windowDays < 1 ||
    !member(["missing", "stale", "current"], source.inventory_status) ||
    (source.inventory_status === "missing") !== (inventoryGeneratedAt === null)
  ) {
    return null;
  }
  const totals: Record<string, number | null> = {};
  for (const field of REVIEW_COVERAGE_TOTAL_FIELDS) {
    const parsed = count(totalsSource[field]);
    if (parsed === null) return null;
    totals[field] = parsed;
  }
  const coveragePercent = nullableNumber(totalsSource.coverage_percent, 0, 100);
  if (coveragePercent === undefined) return null;
  const reviewable = totals.reviewable_records ?? 0;
  const reviewed = totals.reviewed_recent ?? 0;
  const expectedCoverage = reviewable ? Math.round((reviewed / reviewable) * 1000) / 10 : null;
  if (reviewed > reviewable || coveragePercent !== expectedCoverage) return null;
  return {
    ok: true,
    generated_at: generatedAt,
    window_days: windowDays,
    inventory_generated_at: inventoryGeneratedAt,
    inventory_status: source.inventory_status,
    totals: { ...totals, coverage_percent: coveragePercent },
  };
}

function publicApplyAggregate(value: unknown): Record<string, number | null> | null {
  const source = objectValue(value);
  if (!source) return null;
  const result: Record<string, number | null> = {};
  for (const field of APPLY_RESULT_FIELDS) {
    const parsed = nullableCount(source[field]);
    if (parsed === undefined) return null;
    result[field] = parsed;
  }
  const netDrain = nullableSignedCount(source.net_drain);
  const expectedNetDrain =
    result.arrivals === null || result.applied === null ? null : result.applied - result.arrivals;
  if (netDrain === undefined || netDrain !== expectedNetDrain) return null;
  return { ...result, net_drain: expectedNetDrain };
}

export function publicApplyObservabilityProjection(value: unknown) {
  const source = objectValue(value);
  if (!source) return null;
  const generatedAt = timestamp(source.generated_at);
  const eventCount = count(source.event_count);
  const queue = nullableCountObject(source.queue, APPLY_QUEUE_FIELDS);
  const last15Minutes = publicApplyAggregate(source.last_15_minutes);
  const last60Minutes = publicApplyAggregate(source.last_60_minutes);
  const totals = publicApplyAggregate(source.totals);
  const lease = nullableCountObject(source.lease, ["wait_ms", "hold_ms"]);
  const failuresSource = objectValue(source.failures);
  const retryAmplification = nullableNumber(source.retry_amplification, 0, MAX_PUBLIC_COUNT);
  const totalRetried = totals?.["retried"];
  const totalApplied = totals?.["applied"];
  const expectedRetryAmplification =
    !totals || totalRetried === undefined || totalApplied === undefined
      ? undefined
      : totalRetried === null || totalApplied === null || totalApplied === 0
        ? null
        : Math.round((totalRetried / totalApplied) * 100) / 100;
  if (
    source.schema_version !== 1 ||
    !member(REVIEW_RANGES, source.range) ||
    (source.repo !== undefined && source.repo !== "all") ||
    !generatedAt ||
    typeof source.telemetry_complete !== "boolean" ||
    eventCount === null ||
    !queue ||
    !last15Minutes ||
    !last60Minutes ||
    !totals ||
    !lease ||
    !failuresSource ||
    retryAmplification === undefined ||
    expectedRetryAmplification === undefined ||
    retryAmplification !== expectedRetryAmplification
  ) {
    return null;
  }
  const failures: Record<string, unknown> = {};
  for (const field of APPLY_FAILURE_COUNT_FIELDS) {
    const parsed = nullableCount(failuresSource[field]);
    if (parsed === undefined) return null;
    failures[field] = parsed;
  }
  const lastFailureKind = failuresSource.last_failure_kind;
  const lastFailureAt = nullableTimestamp(failuresSource.last_failure_at);
  if (
    (lastFailureKind !== null && !member(APPLY_FAILURE_KINDS, lastFailureKind)) ||
    lastFailureAt === undefined ||
    (lastFailureKind === null) !== (lastFailureAt === null)
  ) {
    return null;
  }
  failures.last_failure_kind = lastFailureKind;
  failures.last_failure_at = lastFailureAt;
  return {
    schema_version: 1,
    range: source.range,
    generated_at: generatedAt,
    telemetry_complete: source.telemetry_complete,
    event_count: eventCount,
    queue,
    last_15_minutes: last15Minutes,
    last_60_minutes: last60Minutes,
    totals,
    retry_amplification: expectedRetryAmplification,
    lease,
    failures,
  };
}

function automergeSummary(value: unknown) {
  const source = objectValue(value);
  if (!source) return null;
  const terminalSessions = count(source.terminal_sessions);
  const mergedSessions = count(source.merged_sessions);
  const activeSessions = count(source.active_sessions);
  const successRate = nullableNumber(source.merge_success_rate_percent, 0, 100);
  const latencyP50 = nullableCount(source.command_to_merge_p50_ms, MAX_DURATION_MS);
  const latencyP90 = nullableCount(source.command_to_merge_p90_ms, MAX_DURATION_MS);
  const baseSyncP50 = nullableCount(source.base_sync_p50);
  const baseSyncP90 = nullableCount(source.base_sync_p90);
  const multiRebaseRate = nullableNumber(source.multi_rebase_rate_percent, 0, 100);
  if (
    terminalSessions === null ||
    mergedSessions === null ||
    activeSessions === null ||
    successRate === undefined ||
    latencyP50 === undefined ||
    latencyP90 === undefined ||
    baseSyncP50 === undefined ||
    baseSyncP90 === undefined ||
    multiRebaseRate === undefined ||
    mergedSessions > terminalSessions
  ) {
    return null;
  }
  const expectedSuccessRate = terminalSessions
    ? Math.round((mergedSessions / terminalSessions) * 1000) / 10
    : null;
  const latencyPairValid =
    (latencyP50 === null) === (latencyP90 === null) &&
    (latencyP50 === null || latencyP50 <= Number(latencyP90)) &&
    (mergedSessions > 0 || latencyP50 === null);
  const baseSyncPairValid = terminalSessions
    ? baseSyncP50 !== null && baseSyncP90 !== null && baseSyncP50 <= baseSyncP90
    : baseSyncP50 === null && baseSyncP90 === null;
  if (successRate !== expectedSuccessRate || !latencyPairValid || !baseSyncPairValid) return null;
  return {
    terminal_sessions: terminalSessions,
    merged_sessions: mergedSessions,
    merge_success_rate_percent: successRate,
    command_to_merge_p50_ms: latencyP50,
    command_to_merge_p90_ms: latencyP90,
    base_sync_p50: baseSyncP50,
    base_sync_p90: baseSyncP90,
    multi_rebase_rate_percent: multiRebaseRate,
    active_sessions: activeSessions,
  };
}

function automergeBuckets(value: unknown, range: (typeof REVIEW_RANGES)[number]) {
  if (!Array.isArray(value) || value.length !== AUTOMERGE_BUCKET_COUNTS[range]) return null;
  const result = [];
  let priorEnd: string | null = null;
  for (const entry of value) {
    const source = objectValue(entry);
    if (!source) return null;
    const start = timestamp(source.start);
    const end = timestamp(source.end);
    const terminalCount = count(source.terminal_count);
    const mergedCount = count(source.merged_count);
    const successRate = nullableNumber(source.success_rate_percent, 0, 100);
    const latencyP50 = nullableCount(source.command_to_merge_p50_ms, MAX_DURATION_MS);
    const latencyP90 = nullableCount(source.command_to_merge_p90_ms, MAX_DURATION_MS);
    const latencyPairValid =
      (latencyP50 === null) === (latencyP90 === null) &&
      (latencyP50 === null || latencyP50 <= Number(latencyP90)) &&
      (mergedCount === 0 ? latencyP50 === null : true);
    if (
      !start ||
      !end ||
      Date.parse(start) >= Date.parse(end) ||
      (priorEnd !== null && start !== priorEnd) ||
      terminalCount === null ||
      mergedCount === null ||
      mergedCount > terminalCount ||
      successRate === undefined ||
      latencyP50 === undefined ||
      latencyP90 === undefined ||
      !latencyPairValid ||
      typeof source.low_sample !== "boolean" ||
      successRate !==
        (terminalCount ? Math.round((mergedCount / terminalCount) * 1000) / 10 : null) ||
      source.low_sample !== (terminalCount > 0 && terminalCount < 5)
    ) {
      return null;
    }
    result.push({
      start,
      end,
      terminal_count: terminalCount,
      merged_count: mergedCount,
      success_rate_percent: successRate,
      command_to_merge_p50_ms: latencyP50,
      command_to_merge_p90_ms: latencyP90,
      low_sample: source.low_sample,
    });
    priorEnd = end;
  }
  return result;
}

function automergeOutcomes(value: unknown): Record<string, number> | null {
  const source = objectValue(value);
  if (!source || Object.keys(source).length > 32) return null;
  const result = Object.fromEntries(AUTOMERGE_OUTCOMES.map((outcome) => [outcome, 0])) as Record<
    string,
    number
  >;
  let unknown = 0;
  for (const [outcome, value] of Object.entries(source)) {
    const parsed = count(value);
    if (parsed === null) return null;
    if (member(AUTOMERGE_OUTCOMES, outcome)) result[outcome] = parsed;
    else unknown += parsed;
    if (unknown > MAX_PUBLIC_COUNT) return null;
  }
  return { ...result, unknown };
}

export function publicAutomergeMetricsProjection(value: unknown) {
  const source = objectValue(value);
  const filters = objectValue(source?.filters);
  if (!source || !member(REVIEW_RANGES, source.range)) return null;
  // A public aggregate must not become a repository, policy, or session oracle.
  if (filters && (filters.repo !== null || filters.policy_version !== null)) return null;
  const generatedAt = timestamp(source.generated_at);
  const rangeStart = timestamp(source.range_start);
  const telemetrySince = nullableTimestamp(source.telemetry_since);
  const coveragePercent = nullableNumber(source.coverage_percent, 0, 100);
  const summary = automergeSummary(source.summary);
  const buckets = automergeBuckets(source.buckets, source.range);
  const outcomes = automergeOutcomes(source.terminal_outcomes);
  const efficiency = countObject(source.repair_efficiency, [
    "zero_base_sync",
    "one_base_sync",
    "multiple_base_sync",
  ]);
  const generatedAtMs = generatedAt ? Date.parse(generatedAt) : Number.NaN;
  const rangeStartMs = rangeStart ? Date.parse(rangeStart) : Number.NaN;
  const expectedCoveragePercent =
    telemetrySince === null
      ? 0
      : Math.max(
          0,
          Math.min(
            100,
            Math.round(
              ((generatedAtMs - Math.max(rangeStartMs, Date.parse(String(telemetrySince)))) /
                AUTOMERGE_RANGE_MS[source.range]) *
                100,
            ),
          ),
        );
  if (
    !generatedAt ||
    !rangeStart ||
    telemetrySince === undefined ||
    coveragePercent === undefined ||
    !summary ||
    !buckets ||
    !outcomes ||
    !efficiency ||
    Date.parse(generatedAt) - Date.parse(rangeStart) !== AUTOMERGE_RANGE_MS[source.range] ||
    coveragePercent !== expectedCoveragePercent ||
    buckets[0]?.start !== rangeStart ||
    buckets.at(-1)?.end !== generatedAt
  ) {
    return null;
  }
  const outcomeTotal = Object.values(outcomes).reduce((total, item) => total + item, 0);
  const bucketTerminalTotal = buckets.reduce((total, bucket) => total + bucket.terminal_count, 0);
  const bucketMergedTotal = buckets.reduce((total, bucket) => total + bucket.merged_count, 0);
  const efficiencyTotal = Object.values(efficiency).reduce((total, item) => total + (item ?? 0), 0);
  const expectedMultiRebaseRate = summary.terminal_sessions
    ? Math.round(((efficiency.multiple_base_sync ?? 0) / summary.terminal_sessions) * 1000) / 10
    : null;
  if (
    outcomeTotal !== summary.terminal_sessions ||
    outcomes.merged !== summary.merged_sessions ||
    bucketTerminalTotal !== summary.terminal_sessions ||
    bucketMergedTotal !== summary.merged_sessions ||
    efficiencyTotal !== summary.terminal_sessions ||
    summary.multi_rebase_rate_percent !== expectedMultiRebaseRate
  ) {
    return null;
  }
  return {
    generated_at: generatedAt,
    range: source.range,
    range_start: rangeStart,
    telemetry_since: telemetrySince,
    coverage_percent: expectedCoveragePercent,
    summary: { ...summary, multi_rebase_rate_percent: expectedMultiRebaseRate },
    buckets,
    terminal_outcomes: outcomes,
    repair_efficiency: efficiency,
  };
}

function closedGithubRollup(value: unknown, revisionsRequired = true) {
  const source = objectValue(value);
  if (!source) return null;
  const bucketStart = timestamp(source.bucket_start);
  const rowCount = positiveCount(source.count, MAX_GITHUB_COUNT);
  if (
    !bucketStart ||
    (revisionsRequired &&
      (typeof source.deployment_revision !== "string" ||
        !/^[0-9a-f]{16}$/.test(source.deployment_revision) ||
        typeof source.config_revision !== "string" ||
        !/^[0-9a-f]{16}$/.test(source.config_revision))) ||
    !member(GITHUB_EGRESS_POOL_CLASSES, source.pool_class) ||
    !member(GITHUB_EGRESS_STAGES, source.stage) ||
    !member(GITHUB_EGRESS_SOURCE_ACTIONS, source.source_action) ||
    !member(GITHUB_EGRESS_OPERATIONS, source.operation) ||
    !member(GITHUB_EGRESS_METHODS, source.method) ||
    !member(GITHUB_EGRESS_ROUTE_TEMPLATES, source.route_template) ||
    !member(GITHUB_EGRESS_PAGE_BUCKETS, source.page_bucket) ||
    !member(GITHUB_EGRESS_UNITS, source.unit) ||
    !member(GITHUB_EGRESS_OUTCOMES, source.outcome) ||
    !member(GITHUB_EGRESS_STATUS_BUCKETS, source.status_bucket) ||
    !member(GITHUB_EGRESS_LATENCY_BUCKETS, source.latency_bucket) ||
    !member(GITHUB_EGRESS_CLAIM_GENERATION_BUCKETS, source.claim_generation_bucket) ||
    !member(GITHUB_FIRST_REPEAT, source.first_repeat) ||
    typeof source.attempted !== "boolean" ||
    typeof source.telemetry_complete !== "boolean" ||
    rowCount === null
  ) {
    return null;
  }
  return {
    bucket_start: bucketStart,
    pool_class: source.pool_class,
    stage: source.stage,
    source_action: source.source_action,
    operation: source.operation,
    method: source.method,
    route_template: source.route_template,
    page_bucket: source.page_bucket,
    unit: source.unit,
    outcome: source.outcome,
    status_bucket: source.status_bucket,
    latency_bucket: source.latency_bucket,
    claim_generation_bucket: source.claim_generation_bucket,
    first_repeat: source.first_repeat,
    attempted: source.attempted,
    telemetry_complete: source.telemetry_complete,
    count: rowCount,
  };
}

function githubRollups(value: unknown, revisionsRequired = true) {
  if (!Array.isArray(value) || value.length > MAX_GITHUB_ROLLUP_ROWS) return null;
  const grouped = new Map<string, ReturnType<typeof closedGithubRollup>>();
  for (const entry of value) {
    const row = closedGithubRollup(entry, revisionsRequired);
    if (!row) return null;
    const key = JSON.stringify({ ...row, count: undefined });
    const existing = grouped.get(key);
    const combined = (existing?.count ?? 0) + row.count;
    if (combined > MAX_GITHUB_COUNT) return null;
    grouped.set(key, { ...row, count: combined });
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, row]) => row);
}

function githubRateLimits(value: unknown) {
  if (!Array.isArray(value) || value.length > MAX_GITHUB_RATE_LIMIT_ROWS) return null;
  const entries = value;
  const byStatus = { "403": 0, "429": 0 };
  const byPoolClass = Object.fromEntries(GITHUB_EGRESS_POOL_CLASSES.map((item) => [item, 0]));
  const byOperation = Object.fromEntries(GITHUB_EGRESS_OPERATIONS.map((item) => [item, 0]));
  const byResetAuthority = Object.fromEntries(GITHUB_RESET_AUTHORITIES.map((item) => [item, 0]));
  const byResource = Object.fromEntries([
    ...GITHUB_RATE_LIMIT_RESOURCES.map((item) => [item, 0] as const),
    ["absent", 0] as const,
  ]);
  const headerPresence = {
    retry_after: 0,
    limit: 0,
    remaining: 0,
    used: 0,
    reset: 0,
    resource: 0,
  };
  let latestObservedAt: string | null = null;
  let complete = true;
  for (const entry of entries) {
    const source = objectValue(entry);
    const headers = objectValue(source?.headers);
    const observedAt = timestamp(source?.observed_at);
    if (
      !source ||
      !headers ||
      !observedAt ||
      typeof source.deployment_revision !== "string" ||
      !/^[0-9a-f]{16}$/.test(source.deployment_revision) ||
      typeof source.config_revision !== "string" ||
      !/^[0-9a-f]{16}$/.test(source.config_revision) ||
      !member(GITHUB_EGRESS_POOL_CLASSES, source.pool_class) ||
      !member(GITHUB_EGRESS_STAGES, source.stage) ||
      !member(GITHUB_EGRESS_SOURCE_ACTIONS, source.source_action) ||
      !member(GITHUB_EGRESS_OPERATIONS, source.operation) ||
      !member(GITHUB_EGRESS_METHODS, source.method) ||
      !member(GITHUB_EGRESS_ROUTE_TEMPLATES, source.route_template) ||
      !member(GITHUB_EGRESS_PAGE_BUCKETS, source.page_bucket) ||
      !member([403, 429], source.status) ||
      !member(GITHUB_RESET_AUTHORITIES, source.reset_authority_candidate) ||
      typeof source.telemetry_complete !== "boolean"
    ) {
      return null;
    }
    const resource = headers.resource;
    const headerValues = [
      ["retry_after_present", "retry_after_seconds"],
      ["limit_present", "limit"],
      ["remaining_present", "remaining"],
      ["used_present", "used"],
      ["reset_present", "reset_epoch_seconds"],
    ] as const;
    for (const [presentField, valueField] of headerValues) {
      if (typeof headers[presentField] !== "boolean") return null;
      const parsed = nullableCount(headers[valueField], MAX_GITHUB_COUNT);
      if (parsed === undefined || (!headers[presentField] && parsed !== null)) return null;
    }
    if (typeof headers.resource_present !== "boolean") return null;
    let resourceKey: (typeof GITHUB_RATE_LIMIT_RESOURCES)[number] | "absent";
    if (headers.resource_present) {
      if (!member(GITHUB_RATE_LIMIT_RESOURCES, resource)) return null;
      resourceKey = resource;
    } else {
      if (resource !== null) return null;
      resourceKey = "absent";
    }
    byStatus[String(source.status) as "403" | "429"] += 1;
    byPoolClass[source.pool_class] += 1;
    byOperation[source.operation] += 1;
    byResetAuthority[source.reset_authority_candidate] += 1;
    byResource[resourceKey] += 1;
    headerPresence.retry_after += headers.retry_after_present ? 1 : 0;
    headerPresence.limit += headers.limit_present ? 1 : 0;
    headerPresence.remaining += headers.remaining_present ? 1 : 0;
    headerPresence.used += headers.used_present ? 1 : 0;
    headerPresence.reset += headers.reset_present ? 1 : 0;
    headerPresence.resource += headers.resource_present ? 1 : 0;
    if (latestObservedAt === null || observedAt > latestObservedAt) latestObservedAt = observedAt;
    if (!source.telemetry_complete) complete = false;
  }
  return {
    total: entries.length,
    latest_observed_at: latestObservedAt,
    telemetry_complete: entries.length > 0 && complete,
    by_status: byStatus,
    by_pool_class: byPoolClass,
    by_operation: byOperation,
    by_reset_authority: byResetAuthority,
    by_resource: byResource,
    header_presence: headerPresence,
  };
}

function githubRateLimitCountMap(value: unknown, fields: readonly string[], maximum: number) {
  const source = objectValue(value);
  if (!source) return null;
  const result: Record<string, number> = {};
  for (const field of fields) {
    const parsed = count(source[field], maximum);
    if (parsed === null) return null;
    result[field] = parsed;
  }
  return result;
}

function publicGithubRateLimits(value: unknown) {
  const source = objectValue(value);
  if (!source) return null;
  const total = count(source.total, MAX_GITHUB_RATE_LIMIT_ROWS);
  const latestObservedAt = nullableTimestamp(source.latest_observed_at);
  const byStatus = githubRateLimitCountMap(source.by_status, ["403", "429"], total ?? 0);
  const byPoolClass = githubRateLimitCountMap(
    source.by_pool_class,
    GITHUB_EGRESS_POOL_CLASSES,
    total ?? 0,
  );
  const byOperation = githubRateLimitCountMap(
    source.by_operation,
    GITHUB_EGRESS_OPERATIONS,
    total ?? 0,
  );
  const byResetAuthority = githubRateLimitCountMap(
    source.by_reset_authority,
    GITHUB_RESET_AUTHORITIES,
    total ?? 0,
  );
  const byResource = githubRateLimitCountMap(
    source.by_resource,
    [...GITHUB_RATE_LIMIT_RESOURCES, "absent"],
    total ?? 0,
  );
  const headerPresence = githubRateLimitCountMap(
    source.header_presence,
    ["retry_after", "limit", "remaining", "used", "reset", "resource"],
    total ?? 0,
  );
  const sum = (values: Record<string, number> | null) =>
    values ? Object.values(values).reduce((result, item) => result + item, 0) : -1;
  if (
    total === null ||
    latestObservedAt === undefined ||
    typeof source.telemetry_complete !== "boolean" ||
    !byStatus ||
    !byPoolClass ||
    !byOperation ||
    !byResetAuthority ||
    !byResource ||
    !headerPresence ||
    (total === 0) !== (latestObservedAt === null) ||
    (total === 0 && source.telemetry_complete) ||
    sum(byStatus) !== total ||
    sum(byPoolClass) !== total ||
    sum(byOperation) !== total ||
    sum(byResetAuthority) !== total ||
    sum(byResource) !== total ||
    Object.values(headerPresence).some((item) => item > total)
  ) {
    return null;
  }
  return {
    total,
    latest_observed_at: latestObservedAt,
    telemetry_complete: source.telemetry_complete,
    by_status: byStatus,
    by_pool_class: byPoolClass,
    by_operation: byOperation,
    by_reset_authority: byResetAuthority,
    by_resource: byResource,
    header_presence: headerPresence,
  };
}

function publicGithubThrottleSeries(
  value: unknown,
  hours: number,
  bucketMinutes: number,
  generatedAt: string,
  rollupWindowComplete: boolean,
  wireAttemptTotal: number,
  incompleteTotal: number,
) {
  if (value === undefined) return undefined;
  const source = objectValue(value);
  const rawRows = Array.isArray(source?.rows) ? source.rows : null;
  const closedThrough = timestamp(source?.closed_through);
  const firstAvailableBucketStart = nullableTimestamp(source?.first_available_bucket_start);
  const excludedIncompleteCount = count(source?.excluded_incomplete_count, MAX_GITHUB_COUNT);
  if (
    !source ||
    source.unit !== "wire_attempt" ||
    !rawRows ||
    rawRows.length > MAX_GITHUB_THROTTLE_ROWS ||
    !closedThrough ||
    firstAvailableBucketStart === undefined ||
    excludedIncompleteCount === null ||
    excludedIncompleteCount > incompleteTotal ||
    typeof source.rows_truncated !== "boolean" ||
    typeof source.coverage_complete !== "boolean" ||
    typeof source.complete !== "boolean" ||
    (source.rows_truncated && rawRows.length !== MAX_GITHUB_THROTTLE_ROWS)
  ) {
    return null;
  }
  const bucketMs = bucketMinutes * 60_000;
  const generatedMs = Date.parse(generatedAt);
  const closedMs = Date.parse(closedThrough);
  const firstAvailableMs =
    firstAvailableBucketStart === null ? null : Date.parse(firstAvailableBucketStart);
  const windowStart = Math.floor((generatedMs - hours * 3_600_000) / bucketMs) * bucketMs;
  if (
    closedMs !== Math.floor(generatedMs / bucketMs) * bucketMs ||
    (firstAvailableMs !== null &&
      (firstAvailableMs % bucketMs !== 0 || firstAvailableMs > closedMs))
  ) {
    return null;
  }
  const rows = [];
  const seen = new Set<string>();
  let total = 0;
  let earliestRow = Number.POSITIVE_INFINITY;
  for (const entry of rawRows) {
    const row = objectValue(entry);
    const bucketStart = timestamp(row?.bucket_start);
    const rowCount = positiveCount(row?.count, MAX_GITHUB_COUNT);
    if (
      !row ||
      !bucketStart ||
      !member(GITHUB_EGRESS_POOL_CLASSES, row.pool_class) ||
      !member(["403", "429"], row.status_bucket) ||
      rowCount === null
    ) {
      return null;
    }
    const bucketStartMs = Date.parse(bucketStart);
    const key = `${bucketStart}|${row.pool_class}|${row.status_bucket}`;
    total += rowCount;
    if (
      bucketStartMs % bucketMs !== 0 ||
      bucketStartMs < windowStart ||
      bucketStartMs >= closedMs ||
      seen.has(key) ||
      total > wireAttemptTotal
    ) {
      return null;
    }
    seen.add(key);
    earliestRow = Math.min(earliestRow, bucketStartMs);
    rows.push({
      bucket_start: bucketStart,
      pool_class: row.pool_class,
      status_bucket: row.status_bucket,
      count: rowCount,
    });
  }
  if (
    (rows.length > 0 && firstAvailableMs === null) ||
    (firstAvailableMs !== null && firstAvailableMs > earliestRow)
  ) {
    return null;
  }
  const coverageComplete = firstAvailableMs !== null && firstAvailableMs < windowStart;
  const complete =
    !source.rows_truncated &&
    excludedIncompleteCount === 0 &&
    rollupWindowComplete &&
    coverageComplete;
  if (source.coverage_complete !== coverageComplete || source.complete !== complete) return null;
  rows.sort((left, right) =>
    `${left.bucket_start}|${left.pool_class}|${left.status_bucket}`.localeCompare(
      `${right.bucket_start}|${right.pool_class}|${right.status_bucket}`,
    ),
  );
  return {
    unit: "wire_attempt",
    closed_through: closedThrough,
    first_available_bucket_start: firstAvailableBucketStart,
    rows,
    rows_truncated: source.rows_truncated,
    excluded_incomplete_count: excludedIncompleteCount,
    coverage_complete: coverageComplete,
    complete,
  };
}

export function publicGithubEgressObservabilityProjection(value: unknown) {
  const source = objectValue(value);
  const privacySource = objectValue(source?.privacy);
  const alreadyPublic =
    privacySource?.pool_identity === "withheld" &&
    privacySource.revision_digests === "withheld" &&
    privacySource.raw_identifiers === false &&
    privacySource.closed_dimensions === true;
  const window = objectValue(source?.window);
  const unitsSource = objectValue(source?.units);
  const retentionSource = objectValue(source?.retention);
  const completenessSource = objectValue(source?.completeness);
  const rawRows = Array.isArray(source?.rows) ? source.rows : null;
  const rawRateLimits = Array.isArray(source?.rate_limit_observations)
    ? source.rate_limit_observations
    : null;
  if (
    !source ||
    !window ||
    !unitsSource ||
    !retentionSource ||
    !completenessSource ||
    !rawRows ||
    (!alreadyPublic && !rawRateLimits)
  ) {
    return null;
  }
  const generatedAt = timestamp(source.generated_at);
  const hours = window.hours;
  if (
    source.version !== 2 ||
    !generatedAt ||
    !member([0.25, 1, 6, 24, 168], hours) ||
    window.bucket_minutes !== (Number(hours) <= 6 ? 5 : 60)
  ) {
    return null;
  }
  const units: Record<string, number> = {};
  for (const field of GITHUB_UNIT_FIELDS) {
    const parsed = count(unitsSource[field], MAX_GITHUB_COUNT);
    if (parsed === null) return null;
    units[field] = parsed;
  }
  const rows = githubRollups(source.rows, !alreadyPublic);
  const rateLimits = alreadyPublic
    ? publicGithubRateLimits(source.rate_limits)
    : githubRateLimits(source.rate_limit_observations);
  if (!rows || !rateLimits) return null;
  const rollupEvictedRows = count(retentionSource.rollup_evicted_rows_total, MAX_GITHUB_COUNT);
  const rateLimitEvictedRows = count(
    retentionSource.rate_limit_evicted_rows_total,
    MAX_GITHUB_COUNT,
  );
  const lastRollupEvictedAt = nullableTimestamp(retentionSource.last_rollup_evicted_bucket_start);
  const lastRateLimitEvictedAt = nullableTimestamp(
    retentionSource.last_rate_limit_evicted_observed_at,
  );
  const completeCount = count(completenessSource.complete, MAX_GITHUB_COUNT);
  const incompleteCount = count(completenessSource.incomplete, MAX_GITHUB_COUNT);
  if (
    rollupEvictedRows === null ||
    rateLimitEvictedRows === null ||
    lastRollupEvictedAt === undefined ||
    lastRateLimitEvictedAt === undefined ||
    typeof retentionSource.rollup_eviction_count_exact !== "boolean" ||
    completeCount === null ||
    incompleteCount === null ||
    typeof completenessSource.observed !== "boolean" ||
    typeof completenessSource.telemetry_complete !== "boolean" ||
    typeof completenessSource.rows_truncated !== "boolean" ||
    typeof completenessSource.rate_limit_rows_truncated !== "boolean" ||
    typeof completenessSource.rollup_window_complete !== "boolean" ||
    typeof completenessSource.rate_limit_window_complete !== "boolean" ||
    typeof completenessSource.query_complete !== "boolean"
  ) {
    return null;
  }
  const expectedObserved = completeCount + incompleteCount > 0;
  const expectedTelemetryComplete = completeCount > 0 && incompleteCount === 0;
  const expectedQueryComplete =
    !completenessSource.rows_truncated &&
    !completenessSource.rate_limit_rows_truncated &&
    completenessSource.rollup_window_complete &&
    completenessSource.rate_limit_window_complete;
  const completenessTotal = completeCount + incompleteCount;
  const unitTotal = Object.values(units).reduce((total, item) => total + item, 0);
  let completeRowTotal = 0;
  let incompleteRowTotal = 0;
  for (const row of rows) {
    if (!row) return null;
    if (row.telemetry_complete) completeRowTotal += row.count;
    else incompleteRowTotal += row.count;
  }
  const rowsConserved = completenessSource.rows_truncated
    ? (alreadyPublic || rawRows.length === MAX_GITHUB_ROLLUP_ROWS) &&
      completeRowTotal <= completeCount &&
      incompleteRowTotal <= incompleteCount
    : completeRowTotal === completeCount && incompleteRowTotal === incompleteCount;
  const rateLimitTruncationValid =
    !completenessSource.rate_limit_rows_truncated ||
    (alreadyPublic
      ? rateLimits.total === MAX_GITHUB_RATE_LIMIT_ROWS
      : rawRateLimits?.length === MAX_GITHUB_RATE_LIMIT_ROWS);
  const throttleSeries = publicGithubThrottleSeries(
    source.throttle_series,
    Number(hours),
    Number(window.bucket_minutes),
    generatedAt,
    completenessSource.rollup_window_complete,
    units.wire_attempt,
    incompleteCount,
  );
  const rateLimitDetailHours = retentionSource.rate_limit_detail_hours;
  if (
    completenessSource.observed !== expectedObserved ||
    completenessSource.telemetry_complete !== expectedTelemetryComplete ||
    completenessSource.query_complete !== expectedQueryComplete ||
    unitTotal !== completenessTotal ||
    !rowsConserved ||
    !rateLimitTruncationValid ||
    throttleSeries === null ||
    (rateLimitDetailHours !== undefined && rateLimitDetailHours !== 24)
  ) {
    return null;
  }
  return {
    version: 2,
    generated_at: generatedAt,
    window: { hours, bucket_minutes: window.bucket_minutes },
    units,
    rows,
    rate_limits: rateLimits,
    ...(throttleSeries === undefined ? {} : { throttle_series: throttleSeries }),
    retention: {
      ...(rateLimitDetailHours === undefined ? {} : { rate_limit_detail_hours: 24 }),
      rollup_evicted_rows_total: rollupEvictedRows,
      rollup_eviction_count_exact: retentionSource.rollup_eviction_count_exact,
      rate_limit_evicted_rows_total: rateLimitEvictedRows,
      last_rollup_evicted_bucket_start: lastRollupEvictedAt,
      last_rate_limit_evicted_observed_at: lastRateLimitEvictedAt,
    },
    completeness: {
      complete: completeCount,
      incomplete: incompleteCount,
      observed: completenessSource.observed,
      telemetry_complete: completenessSource.telemetry_complete,
      rows_truncated: completenessSource.rows_truncated,
      rate_limit_rows_truncated: completenessSource.rate_limit_rows_truncated,
      rollup_window_complete: completenessSource.rollup_window_complete,
      rate_limit_window_complete: completenessSource.rate_limit_window_complete,
      query_complete: completenessSource.query_complete,
    },
    privacy: {
      pool_identity: "withheld",
      revision_digests: "withheld",
      raw_identifiers: false,
      closed_dimensions: true,
    },
  };
}

function publicationSource(value: unknown, outcomes: readonly string[]) {
  const source = objectValue(value);
  const countsSource = objectValue(source?.counts);
  if (!source || !countsSource || typeof source.complete !== "boolean") return null;
  const rows = nullableCount(source.rows, 10_000);
  const latestObservedAt = nullableTimestamp(source.latest_observed_at);
  if (rows === undefined || latestObservedAt === undefined) return null;
  const counts: Record<string, number | null> = {};
  for (const outcome of outcomes) {
    const parsed = nullableCount(countsSource[outcome], 10_000);
    if (parsed === undefined) return null;
    counts[outcome] = parsed;
  }
  if (!Array.isArray(source.buckets) || source.buckets.length !== 24) return null;
  const buckets = [];
  for (let index = 0; index < 24; index += 1) {
    const bucket = objectValue(source.buckets[index]);
    const bucketCountsSource = objectValue(bucket?.counts);
    if (!bucket || !bucketCountsSource || bucket.index !== index) return null;
    const bucketCounts: Record<string, number | null> = {};
    for (const outcome of outcomes) {
      const parsed = nullableCount(bucketCountsSource[outcome], 10_000);
      if (parsed === undefined) return null;
      bucketCounts[outcome] = parsed;
    }
    buckets.push({ index, counts: bucketCounts });
  }
  if (source.complete) {
    if (rows === null || Object.values(counts).some((value) => value === null)) return null;
    const countTotal = Object.values(counts).reduce((total, item) => total + Number(item), 0);
    if (countTotal !== rows || (rows === 0) !== (latestObservedAt === null)) return null;
    for (const outcome of outcomes) {
      const bucketTotal = buckets.reduce(
        (total, bucket) => total + Number(bucket.counts[outcome]),
        0,
      );
      if (bucketTotal !== counts[outcome]) return null;
    }
  } else if (
    rows !== null ||
    latestObservedAt !== null ||
    Object.values(counts).some((item) => item !== null) ||
    buckets.some((bucket) => Object.values(bucket.counts).some((item) => item !== null))
  ) {
    return null;
  }
  return { complete: source.complete, rows, latest_observed_at: latestObservedAt, counts, buckets };
}

export function publicRecentDurablePublicationEventsProjection(value: unknown) {
  const source = objectValue(value);
  const window = objectValue(source?.window);
  const collection = objectValue(source?.collection);
  const activity = objectValue(source?.activity);
  if (!source || !window || !collection || !activity || !member(REVIEW_RANGES, window.id)) {
    return null;
  }
  const capturedAt = timestamp(source.captured_at);
  const startAt = timestamp(window.start_at);
  const endAt = timestamp(window.end_at);
  const direct = publicationSource(source.direct, DIRECT_PUBLICATION_OUTCOMES);
  const batch = publicationSource(source.batch, BATCH_PUBLICATION_OUTCOMES);
  if (
    source.version !== 1 ||
    !capturedAt ||
    !startAt ||
    !endAt ||
    capturedAt !== endAt ||
    Date.parse(endAt) - Date.parse(startAt) !== PUBLICATION_WINDOW_SECONDS[window.id] * 24 * 1000 ||
    window.bucket_seconds !== PUBLICATION_WINDOW_SECONDS[window.id] ||
    window.bucket_count !== 24 ||
    !member(["complete", "mixed", "unknown"], collection.state) ||
    typeof collection.complete !== "boolean" ||
    collection.scan_limit !== 10_000 ||
    !member(["observed", "idle", "unknown"], activity.state) ||
    !direct ||
    !batch
  ) {
    return null;
  }
  for (const latest of [direct.latest_observed_at, batch.latest_observed_at]) {
    if (
      latest !== null &&
      (Date.parse(latest) < Date.parse(startAt) || Date.parse(latest) > Date.parse(endAt))
    ) {
      return null;
    }
  }
  const expectedCollectionComplete = direct.complete && batch.complete;
  const expectedCollectionState = expectedCollectionComplete
    ? "complete"
    : direct.complete || batch.complete
      ? "mixed"
      : "unknown";
  const observedRows = (direct.rows ?? 0) + (batch.rows ?? 0);
  const expectedActivity = expectedCollectionComplete
    ? observedRows > 0
      ? "observed"
      : "idle"
    : "unknown";
  if (
    collection.complete !== expectedCollectionComplete ||
    collection.state !== expectedCollectionState ||
    activity.state !== expectedActivity
  ) {
    return null;
  }
  return {
    version: 1,
    captured_at: capturedAt,
    window: {
      id: window.id,
      start_at: startAt,
      end_at: endAt,
      bucket_seconds: window.bucket_seconds,
      bucket_count: 24,
    },
    collection: {
      state: collection.state,
      complete: collection.complete,
      scan_limit: 10_000,
    },
    activity: { state: activity.state },
    direct,
    batch,
    provenance: {
      durable_server_observed: true,
      public_aggregate_only: true,
      retention_seconds: 7 * 24 * 60 * 60,
    },
  };
}
