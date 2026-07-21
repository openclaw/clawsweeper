export const APPLY_OBSERVABILITY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const APPLY_OBSERVABILITY_RANGES = {
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": APPLY_OBSERVABILITY_RETENTION_MS,
} as const;

const OUTCOMES = new Set(["success", "failure", "cancelled", "skipped"]);
const FAILURE_KINDS = [
  "state_lease_timeout",
  "state_lease_contention",
  "action_ledger_failure",
  "state_publication_failure",
  "safe_close_blocked",
  "safe_close_failure",
  "workflow_failure",
] as const;
const FAILURE_KIND_SET = new Set<string>(FAILURE_KINDS);

type Count = number | null;
type FailureKind = (typeof FAILURE_KINDS)[number];
export type ApplyObservabilityEvent = {
  schema_version: 1;
  repo: string;
  run_id: string;
  run_attempt: number;
  occurred_at: string;
  started_at: string;
  outcome: "success" | "failure" | "cancelled" | "skipped";
  run_url: string;
  queue: {
    active: Count;
    capacity: Count;
    ready: Count;
    backoff: Count;
    dispatching: Count;
    leased: Count;
    oldest_ready_age_seconds: Count;
    oldest_backoff_age_seconds: Count;
    oldest_lease_age_seconds: Count;
  };
  arrivals: Count;
  results: {
    applied: Count;
    closed: Count;
    superseded: Count;
    retried: Count;
    dead_lettered: Count;
  };
  lease: { wait_ms: Count; hold_ms: Count };
  observed_failure_kinds: FailureKind[];
  failures: Array<{ kind: FailureKind; at: string }>;
};

export function normalizeApplyObservabilityEvent(
  value: unknown,
  now = Date.now(),
): ApplyObservabilityEvent | null {
  const input = object(value);
  const repo = String(input.repo || "").trim();
  const runId = String(input.run_id || "").trim();
  const runAttempt = Number(input.run_attempt);
  const occurredAt = timestamp(input.occurred_at);
  const startedAt = timestamp(input.started_at);
  const outcome = String(input.outcome || "");
  const runUrl = String(input.run_url || "").trim();
  if (
    input.schema_version !== 1 ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
    !/^\d+$/.test(runId) ||
    !Number.isSafeInteger(runAttempt) ||
    runAttempt < 1 ||
    !occurredAt ||
    !startedAt ||
    Date.parse(occurredAt) < Date.parse(startedAt) ||
    Date.parse(occurredAt) > now + 5 * 60_000 ||
    !OUTCOMES.has(outcome) ||
    !/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+$/.test(runUrl)
  )
    return null;
  const queue = counts(object(input.queue), [
    "active",
    "capacity",
    "ready",
    "backoff",
    "dispatching",
    "leased",
    "oldest_ready_age_seconds",
    "oldest_backoff_age_seconds",
    "oldest_lease_age_seconds",
  ]);
  const results = counts(object(input.results), [
    "applied",
    "closed",
    "superseded",
    "retried",
    "dead_lettered",
  ]);
  const lease = counts(object(input.lease), ["wait_ms", "hold_ms"]);
  const arrivals = nullableCount(input.arrivals);
  if (!queue || !results || !lease || arrivals === undefined) return null;
  const failures = normalizeFailures(input.failures, now);
  const observedFailureKinds = normalizeFailureKinds(input.observed_failure_kinds);
  if (!failures || !observedFailureKinds) return null;
  if (failures.some((failure) => !observedFailureKinds.includes(failure.kind))) return null;
  return {
    schema_version: 1,
    repo,
    run_id: runId,
    run_attempt: runAttempt,
    occurred_at: occurredAt,
    started_at: startedAt,
    outcome: outcome as ApplyObservabilityEvent["outcome"],
    run_url: runUrl,
    queue: queue as ApplyObservabilityEvent["queue"],
    results: results as ApplyObservabilityEvent["results"],
    arrivals,
    lease: lease as ApplyObservabilityEvent["lease"],
    observed_failure_kinds: observedFailureKinds,
    failures,
  };
}

export function summarizeApplyObservability(options: {
  events: readonly ApplyObservabilityEvent[];
  range: keyof typeof APPLY_OBSERVABILITY_RANGES;
  repo: string | null;
  repositories?: readonly string[];
  now?: number;
}) {
  const now = options.now ?? Date.now();
  const from = now - APPLY_OBSERVABILITY_RANGES[options.range];
  const expectedRepositories = options.repo
    ? [options.repo]
    : options.repositories?.length
      ? [...new Set(options.repositories)]
      : null;
  const events = options.events.filter(
    (event) =>
      Date.parse(event.occurred_at) >= from &&
      (!expectedRepositories || expectedRepositories.includes(event.repo)),
  );
  const observedRepositories = expectedRepositories ?? [
    ...new Set(events.map((event) => event.repo)),
  ];
  const latestByRepository = new Map<string, ApplyObservabilityEvent>();
  for (const event of [...events].sort(
    (left, right) => Date.parse(right.occurred_at) - Date.parse(left.occurred_at),
  )) {
    if (!latestByRepository.has(event.repo)) latestByRepository.set(event.repo, event);
  }
  const latest = observedRepositories.map((repo) => latestByRepository.get(repo) ?? null);
  const window = (ms: number) =>
    aggregate(events.filter((event) => Date.parse(event.occurred_at) >= now - ms));
  const aggregateRange = aggregate(events);
  const failures = events.flatMap((event) =>
    event.failures.map((failure) => ({ ...failure, repo: event.repo, run_url: event.run_url })),
  );
  const lastFailure = failures.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null;
  return {
    schema_version: 1,
    range: options.range,
    repo: options.repo ?? "all",
    generated_at: new Date(now).toISOString(),
    telemetry_complete: observedRepositories.length > 0 && latest.every(Boolean),
    event_count: events.length,
    repositories: observedRepositories.map((repo) => ({
      repo,
      observed_at: latestByRepository.get(repo)?.occurred_at ?? null,
    })),
    queue: aggregateQueue(latest),
    last_15_minutes: window(15 * 60_000),
    last_60_minutes: window(60 * 60_000),
    totals: aggregateRange,
    retry_amplification: retryAmplification(aggregateRange),
    lease: aggregateLease(latest),
    failures: {
      state_lease_timeout: failureCount(events, failures, "state_lease_timeout"),
      state_lease_contention: failureCount(events, failures, "state_lease_contention"),
      action_ledger: failureCount(events, failures, "action_ledger_failure"),
      state_publication: failureCount(events, failures, "state_publication_failure"),
      safe_close_blocked: failureCount(events, failures, "safe_close_blocked"),
      safe_close_failure: failureCount(events, failures, "safe_close_failure"),
      last_failure_kind: lastFailure?.kind ?? null,
      last_failure_at: lastFailure?.at ?? null,
      last_failure_run_url: lastFailure?.run_url ?? null,
    },
  };
}

function failureCount(
  events: readonly ApplyObservabilityEvent[],
  failures: ReadonlyArray<{ kind: FailureKind }>,
  kind: FailureKind,
) {
  if (!events.some((event) => event.observed_failure_kinds.includes(kind))) return null;
  return failures.filter((failure) => failure.kind === kind).length;
}

function aggregateQueue(events: readonly (ApplyObservabilityEvent | null)[]) {
  if (!events.length || events.some((event) => !event)) return unknownQueue();
  const observed = events as ApplyObservabilityEvent[];
  const sum = (field: keyof ApplyObservabilityEvent["queue"]) => {
    const values = observed.map((event) => event.queue[field]);
    return values.every((value): value is number => value !== null)
      ? values.reduce((total, value) => total + value, 0)
      : null;
  };
  const oldest = (field: keyof ApplyObservabilityEvent["queue"]) => {
    const values = observed.map((event) => event.queue[field]);
    return values.every((value): value is number => value !== null) ? Math.max(...values) : null;
  };
  return {
    active: sum("active"),
    capacity: sum("capacity"),
    ready: sum("ready"),
    backoff: sum("backoff"),
    dispatching: sum("dispatching"),
    leased: sum("leased"),
    oldest_ready_age_seconds: oldest("oldest_ready_age_seconds"),
    oldest_backoff_age_seconds: oldest("oldest_backoff_age_seconds"),
    oldest_lease_age_seconds: oldest("oldest_lease_age_seconds"),
  };
}

function aggregateLease(events: readonly (ApplyObservabilityEvent | null)[]) {
  if (!events.length || events.some((event) => !event)) return { wait_ms: null, hold_ms: null };
  const observed = events as ApplyObservabilityEvent[];
  const maximum = (field: keyof ApplyObservabilityEvent["lease"]) => {
    const values = observed.map((event) => event.lease[field]);
    return values.every((value): value is number => value !== null) ? Math.max(...values) : null;
  };
  return { wait_ms: maximum("wait_ms"), hold_ms: maximum("hold_ms") };
}

function aggregate(events: readonly ApplyObservabilityEvent[]) {
  const sum = (field: keyof ApplyObservabilityEvent["results"] | "arrivals") => {
    const values = events.map((event) =>
      field === "arrivals" ? event.arrivals : event.results[field],
    );
    if (!values.length || values.some((value) => value === null)) return null;
    return values.reduce((total, value) => total + value, 0);
  };
  const arrivals = sum("arrivals");
  const applied = sum("applied");
  const closed = sum("closed");
  return {
    arrivals,
    applied,
    closed,
    superseded: sum("superseded"),
    retried: sum("retried"),
    dead_lettered: sum("dead_lettered"),
    net_drain: arrivals === null || applied === null ? null : applied - arrivals,
  };
}

function retryAmplification(value: ReturnType<typeof aggregate>) {
  return value.retried === null || value.applied === null || value.applied === 0
    ? null
    : Math.round((value.retried / value.applied) * 100) / 100;
}

function unknownQueue() {
  return {
    active: null,
    capacity: null,
    ready: null,
    backoff: null,
    dispatching: null,
    leased: null,
    oldest_ready_age_seconds: null,
    oldest_backoff_age_seconds: null,
    oldest_lease_age_seconds: null,
  };
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function timestamp(value: unknown) {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
function nullableCount(value: unknown): Count | undefined {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}
function counts(input: Record<string, unknown>, fields: readonly string[]) {
  const result: Record<string, Count> = {};
  for (const field of fields) {
    const value = nullableCount(input[field]);
    if (value === undefined) return null;
    result[field] = value;
  }
  return result;
}
function normalizeFailures(
  value: unknown,
  now: number,
): Array<{ kind: FailureKind; at: string }> | null {
  if (!Array.isArray(value) || value.length > 50) return null;
  const result: Array<{ kind: FailureKind; at: string }> = [];
  for (const entry of value) {
    const item = object(entry);
    const kind = String(item.kind || "");
    const at = timestamp(item.at);
    if (!FAILURE_KIND_SET.has(kind) || !at || Date.parse(at) > now + 5 * 60_000) return null;
    result.push({ kind: kind as FailureKind, at });
  }
  return result;
}
function normalizeFailureKinds(value: unknown): FailureKind[] | null {
  if (!Array.isArray(value) || value.length > FAILURE_KINDS.length) return null;
  const kinds = value.map((kind) => String(kind));
  if (new Set(kinds).size !== kinds.length || kinds.some((kind) => !FAILURE_KIND_SET.has(kind)))
    return null;
  return kinds as FailureKind[];
}
