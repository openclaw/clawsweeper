export const AUTOMERGE_METRICS_EVENT_TYPE = "clawsweeper.automerge_metric";
export const AUTOMERGE_METRICS_STORE_KEY = "automerge-product-metrics:v1";
export const AUTOMERGE_METRICS_EVENT_KEY_PREFIX = `${AUTOMERGE_METRICS_STORE_KEY}:time:`;
export const AUTOMERGE_METRICS_EVENT_ID_KEY_PREFIX = `${AUTOMERGE_METRICS_STORE_KEY}:id:`;
export const AUTOMERGE_METRICS_TTL_SECONDS = 90 * 24 * 60 * 60;
export const AUTOMERGE_METRICS_EVENT_LIMIT = 20_000;

const RANGE_CONFIG = {
  "6h": { durationMs: 6 * 60 * 60 * 1000, bucketMs: 30 * 60 * 1000 },
  "24h": { durationMs: 24 * 60 * 60 * 1000, bucketMs: 2 * 60 * 60 * 1000 },
  "7d": { durationMs: 7 * 24 * 60 * 60 * 1000, bucketMs: 12 * 60 * 60 * 1000 },
} as const;

export type AutomergeMetricRange = keyof typeof RANGE_CONFIG;
export type AutomergeMetricPhase =
  | "activated"
  | "repair_dispatched"
  | "repair_completed"
  | "state_changed"
  | "terminal";

export type AutomergeMetricEvent = {
  event_id: string;
  session_id: string;
  phase: AutomergeMetricPhase;
  occurred_at: string;
  repository: string;
  item_number: number;
  policy_version: string;
  state?: string | null;
  outcome?: string | null;
  reason?: string | null;
  pr_url?: string | null;
  run_url?: string | null;
  base_sync?: boolean;
};

export type AutomergeMetricLedger = {
  version: 1;
  telemetry_since: string | null;
  events: AutomergeMetricEvent[];
};

export function normalizeAutomergeMetricEvent(value: unknown): AutomergeMetricEvent | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const phase = String(row.phase ?? "") as AutomergeMetricPhase;
  if (
    !(
      [
        "activated",
        "repair_dispatched",
        "repair_completed",
        "state_changed",
        "terminal",
      ] as string[]
    ).includes(phase)
  )
    return null;
  const occurredAt = String(row.occurred_at ?? "");
  const itemNumber = Number(row.item_number);
  const repository = String(row.repository ?? "").trim();
  const sessionId = String(row.session_id ?? "").trim();
  if (
    !sessionId ||
    !repository ||
    !Number.isInteger(itemNumber) ||
    itemNumber <= 0 ||
    !Number.isFinite(Date.parse(occurredAt))
  )
    return null;
  const eventId = String(row.event_id ?? "").trim() || `${sessionId}:${phase}:${occurredAt}`;
  return {
    event_id: eventId,
    session_id: sessionId,
    phase,
    occurred_at: new Date(occurredAt).toISOString(),
    repository,
    item_number: itemNumber,
    policy_version: String(row.policy_version ?? "immediate-v1").trim() || "immediate-v1",
    state: nullableText(row.state),
    outcome: nullableText(row.outcome),
    reason: nullableText(row.reason),
    pr_url: nullableText(row.pr_url) ?? `https://github.com/${repository}/pull/${itemNumber}`,
    run_url: nullableText(row.run_url),
    base_sync: row.base_sync === true,
  };
}

export function mergeAutomergeMetricLedger(
  current: unknown,
  incoming: AutomergeMetricEvent,
  now = Date.now(),
): AutomergeMetricLedger {
  const currentEvents = Array.isArray((current as AutomergeMetricLedger | null)?.events)
    ? (current as AutomergeMetricLedger).events
    : [];
  const cutoff = now - AUTOMERGE_METRICS_TTL_SECONDS * 1000;
  const byId = new Map<string, AutomergeMetricEvent>();
  for (const event of [...currentEvents, incoming]) {
    const normalized = normalizeAutomergeMetricEvent(event);
    if (normalized && Date.parse(normalized.occurred_at) >= cutoff)
      byId.set(normalized.event_id, normalized);
  }
  const events = [...byId.values()]
    .sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at))
    .slice(-20_000);
  return { version: 1, telemetry_since: events[0]?.occurred_at ?? null, events };
}

export function summarizeAutomergeMetrics(
  ledger: unknown,
  options: {
    range?: string;
    repo?: string | null;
    policyVersion?: string | null;
    now?: string;
    activeOnly?: boolean;
    sessionLimit?: number;
  } = {},
) {
  const range = isRange(options.range) ? options.range : "7d";
  const nowMs = Date.parse(options.now ?? new Date().toISOString());
  const config = RANGE_CONFIG[range];
  const rangeStart = nowMs - config.durationMs;
  const allEvents = Array.isArray((ledger as AutomergeMetricLedger | null)?.events)
    ? ((ledger as AutomergeMetricLedger).events
        .map(normalizeAutomergeMetricEvent)
        .filter(Boolean) as AutomergeMetricEvent[])
    : [];
  const filtered = allEvents.filter(
    (event) =>
      (!options.repo || event.repository === options.repo) &&
      (!options.policyVersion || event.policy_version === options.policyVersion),
  );
  const sessions = projectSessions(filtered);
  const terminal = sessions.filter(
    (session) =>
      session.terminal_at &&
      Date.parse(session.terminal_at) >= rangeStart &&
      Date.parse(session.terminal_at) <= nowMs,
  );
  const merged = terminal.filter((session) => session.outcome === "merged");
  const latencies = merged
    .map((session) => Date.parse(session.terminal_at!) - Date.parse(session.activated_at ?? ""))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const syncCounts = terminal.map((session) => session.base_sync_count);
  const buckets = [];
  for (let start = rangeStart; start < nowMs; start += config.bucketMs) {
    const end = Math.min(start + config.bucketMs, nowMs);
    const bucketSessions = terminal.filter((session) => {
      const at = Date.parse(session.terminal_at!);
      return at >= start && (at < end || (end === nowMs && at === end));
    });
    const bucketMerged = bucketSessions.filter((session) => session.outcome === "merged");
    const bucketLatencies = bucketMerged
      .map((session) => Date.parse(session.terminal_at!) - Date.parse(session.activated_at ?? ""))
      .filter((value) => Number.isFinite(value) && value >= 0);
    buckets.push({
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      terminal_count: bucketSessions.length,
      merged_count: bucketMerged.length,
      success_rate_percent: bucketSessions.length
        ? percent(bucketMerged.length, bucketSessions.length)
        : null,
      command_to_merge_p50_ms: percentile(bucketLatencies, 0.5),
      command_to_merge_p90_ms: percentile(bucketLatencies, 0.9),
      low_sample: bucketSessions.length > 0 && bucketSessions.length < 5,
    });
  }
  const outcomes: Record<string, number> = {};
  for (const session of terminal)
    outcomes[session.outcome ?? "unknown"] = (outcomes[session.outcome ?? "unknown"] ?? 0) + 1;
  const active = sessions.filter((session) => {
    const lastEventAt = Date.parse(session.last_event_at);
    return !session.terminal_at && lastEventAt >= rangeStart && lastEventAt <= nowMs;
  });
  const sessionLimit = boundedSessionLimit(options.sessionLimit);
  const recentSessions = (
    options.activeOnly
      ? active
      : sessions.filter(
          (session) => Date.parse(session.terminal_at ?? session.last_event_at) >= rangeStart,
        )
  )
    .sort((a, b) => {
      const left = Date.parse(a.terminal_at ?? a.last_event_at);
      const right = Date.parse(b.terminal_at ?? b.last_event_at);
      // Reconciliation requests oldest active sessions first so a noisy repository
      // cannot indefinitely starve an earlier lost terminal delivery.
      return options.activeOnly ? left - right : right - left;
    })
    .slice(0, sessionLimit);
  const filtersActive = Boolean(options.repo || options.policyVersion);
  const telemetrySince = filtersActive
    ? (filtered[0]?.occurred_at ?? null)
    : ((ledger as AutomergeMetricLedger | null)?.telemetry_since ??
      allEvents[0]?.occurred_at ??
      null);
  return {
    generated_at: new Date(nowMs).toISOString(),
    range,
    range_start: new Date(rangeStart).toISOString(),
    telemetry_since: telemetrySince,
    coverage_percent: telemetrySince
      ? Math.max(
          0,
          Math.min(
            100,
            Math.round(
              ((nowMs - Math.max(rangeStart, Date.parse(telemetrySince))) / config.durationMs) *
                100,
            ),
          ),
        )
      : 0,
    filters: {
      repo: options.repo ?? null,
      policy_version: options.policyVersion ?? null,
      repositories: [...new Set(allEvents.map((event) => event.repository))].sort(),
      policy_versions: [...new Set(allEvents.map((event) => event.policy_version))].sort(),
    },
    summary: {
      terminal_sessions: terminal.length,
      merged_sessions: merged.length,
      merge_success_rate_percent: terminal.length ? percent(merged.length, terminal.length) : null,
      command_to_merge_p50_ms: percentile(latencies, 0.5),
      command_to_merge_p90_ms: percentile(latencies, 0.9),
      base_sync_p50: percentile(syncCounts, 0.5),
      base_sync_p90: percentile(syncCounts, 0.9),
      multi_rebase_rate_percent: terminal.length
        ? percent(
            terminal.filter((session) => session.base_sync_count >= 2).length,
            terminal.length,
          )
        : null,
      active_sessions: active.length,
    },
    buckets,
    terminal_outcomes: outcomes,
    repair_efficiency: {
      zero_base_sync: terminal.filter((session) => session.base_sync_count === 0).length,
      one_base_sync: terminal.filter((session) => session.base_sync_count === 1).length,
      multiple_base_sync: terminal.filter((session) => session.base_sync_count >= 2).length,
    },
    sessions: recentSessions,
  };
}

function projectSessions(events: AutomergeMetricEvent[]) {
  const grouped = new Map<string, AutomergeMetricEvent[]>();
  for (const event of events)
    grouped.set(event.session_id, [...(grouped.get(event.session_id) ?? []), event]);
  return [...grouped.entries()].map(([sessionId, rows]) => {
    rows.sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
    const first = rows[0]!;
    const activation = rows.find((row) => row.phase === "activated");
    // A session's first terminal event is authoritative. Delivery is asynchronous, and a
    // later observer can report a lower-fidelity outcome (for example, pr_closed after merged).
    // Keeping the first terminal makes completed product metrics immutable.
    const terminal = rows.find((row) => row.phase === "terminal");
    const last = rows.at(-1)!;
    return {
      session_id: sessionId,
      repository: first.repository,
      item_number: first.item_number,
      pr_url: last.pr_url ?? first.pr_url,
      run_url: [...rows].reverse().find((row) => row.run_url)?.run_url ?? null,
      policy_version: activation?.policy_version ?? first.policy_version,
      activated_at: activation?.occurred_at ?? null,
      terminal_at: terminal?.occurred_at ?? null,
      outcome: terminal?.outcome ?? null,
      state: terminal?.outcome ?? last.state ?? phaseState(last.phase),
      last_reason: last.reason ?? null,
      last_event_at: last.occurred_at,
      repairs: rows.filter((row) => row.phase === "repair_completed").length,
      base_sync_count: rows.filter((row) => row.phase === "repair_completed" && row.base_sync)
        .length,
      activation_missing: !activation,
    };
  });
}

export function percentile(values: number[], quantile: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)] ?? null;
}

function phaseState(phase: AutomergeMetricPhase) {
  if (phase === "repair_dispatched" || phase === "repair_completed") return "repairing";
  return phase;
}

function percent(part: number, total: number) {
  return Math.round((part / total) * 1000) / 10;
}

function nullableText(value: unknown) {
  const text = String(value ?? "").trim();
  return text || null;
}

function isRange(value: unknown): value is AutomergeMetricRange {
  return value === "6h" || value === "24h" || value === "7d";
}

function boundedSessionLimit(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 30) : 30;
}
