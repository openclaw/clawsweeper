import {
  EXACT_REVIEW_LIFECYCLE_TELEMETRY_BATCH_TABLE,
  EXACT_REVIEW_LIFECYCLE_TELEMETRY_DIRECT_TABLE,
} from "./exact-review-lifecycle-telemetry.ts";

export const RECENT_DURABLE_PUBLICATION_EVENT_WINDOWS = {
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
} as const;
export const RECENT_DURABLE_PUBLICATION_EVENT_BUCKETS = 24;
export const RECENT_DURABLE_PUBLICATION_EVENT_SCAN_LIMIT = 10_000;

type WindowId = keyof typeof RECENT_DURABLE_PUBLICATION_EVENT_WINDOWS;
type SqlStorage = {
  exec: (query: string, ...bindings: unknown[]) => Iterable<Record<string, unknown>>;
};
type DurableStorage = { sql: SqlStorage };

export type RecentDurablePublicationEvents = ReturnType<typeof recentDurablePublicationEvents>;

export function recentDurablePublicationEvents(options: {
  storage: DurableStorage;
  window: string;
  now?: number;
}) {
  const now = options.now ?? Date.now();
  const window = options.window as WindowId;
  if (!Object.hasOwn(RECENT_DURABLE_PUBLICATION_EVENT_WINDOWS, window)) return null;
  const rangeMs = RECENT_DURABLE_PUBLICATION_EVENT_WINDOWS[window];
  const from = now - rangeMs;
  const bucketMs = rangeMs / RECENT_DURABLE_PUBLICATION_EVENT_BUCKETS;
  const direct = source({
    storage: options.storage.sql,
    table: EXACT_REVIEW_LIFECYCLE_TELEMETRY_DIRECT_TABLE,
    outcomes: ["accepted", "deduped", "superseded", "fallback"],
    from,
    now,
    bucketMs,
  });
  const batch = source({
    storage: options.storage.sql,
    table: EXACT_REVIEW_LIFECYCLE_TELEMETRY_BATCH_TABLE,
    outcomes: ["superseded", "retryable", "permanent"],
    from,
    now,
    bucketMs,
  });
  const complete = direct.complete && batch.complete;
  const observed =
    complete && direct.rows !== null && batch.rows !== null && direct.rows + batch.rows > 0;
  return {
    version: 1,
    captured_at: new Date(now).toISOString(),
    window: {
      id: window,
      start_at: new Date(from).toISOString(),
      end_at: new Date(now).toISOString(),
      bucket_seconds: bucketMs / 1000,
      bucket_count: RECENT_DURABLE_PUBLICATION_EVENT_BUCKETS,
    },
    collection: {
      state: complete ? "complete" : direct.complete || batch.complete ? "mixed" : "unknown",
      complete,
      scan_limit: RECENT_DURABLE_PUBLICATION_EVENT_SCAN_LIMIT,
    },
    activity: { state: complete ? (observed ? "observed" : "idle") : "unknown" },
    direct,
    batch,
    provenance: {
      durable_server_observed: true,
      public_aggregate_only: true,
      retention_seconds: RECENT_DURABLE_PUBLICATION_EVENT_WINDOWS["7d"] / 1000,
      omitted: ["canonical_target_key", "fence_key", "revision", "claim_generation", "event_id"],
    },
  };
}

function source(options: {
  storage: SqlStorage;
  table: string;
  outcomes: string[];
  from: number;
  now: number;
  bucketMs: number;
}) {
  const empty = () => Object.fromEntries(options.outcomes.map((outcome) => [outcome, 0]));
  const blankBuckets = () =>
    Array.from({ length: RECENT_DURABLE_PUBLICATION_EVENT_BUCKETS }, (_, index) => ({
      index,
      counts: empty(),
    }));
  try {
    const rows = Array.from(
      options.storage.exec(
        `SELECT outcome, observed_at FROM ${options.table}
          WHERE observed_at >= ? AND observed_at <= ?
          ORDER BY observed_at, event_id LIMIT ?`,
        options.from,
        options.now,
        RECENT_DURABLE_PUBLICATION_EVENT_SCAN_LIMIT + 1,
      ),
    );
    // The approved public contract deliberately fails closed rather than
    // returning a partial aggregate when a raw retained-event window is over cap.
    if (rows.length > RECENT_DURABLE_PUBLICATION_EVENT_SCAN_LIMIT) return unknown(options.outcomes);
    const counts: Record<string, number> = empty();
    const buckets = blankBuckets();
    let latest: number | null = null;
    for (const row of rows) {
      const outcome = String(row.outcome || "");
      const observedAt = row.observed_at;
      if (
        !options.outcomes.includes(outcome) ||
        typeof observedAt !== "number" ||
        !validTimestamp(observedAt)
      )
        return unknown(options.outcomes);
      counts[outcome] = (counts[outcome] ?? 0) + 1;
      const bucket =
        buckets[
          Math.min(23, Math.max(0, Math.floor((observedAt - options.from) / options.bucketMs)))
        ];
      if (!bucket) return unknown(options.outcomes);
      bucket.counts[outcome] = (bucket.counts[outcome] ?? 0) + 1;
      latest = Math.max(latest ?? observedAt, observedAt);
    }
    return {
      complete: true,
      rows: rows.length,
      latest_observed_at: latest === null ? null : new Date(latest).toISOString(),
      counts,
      buckets,
    };
  } catch {
    return unknown(options.outcomes);
  }
}

function validTimestamp(value: number) {
  return Number.isSafeInteger(value) && Math.abs(value) <= 8_640_000_000_000_000;
}

function unknown(outcomes: string[]) {
  return {
    complete: false,
    rows: null,
    latest_observed_at: null,
    counts: Object.fromEntries(outcomes.map((outcome) => [outcome, null])),
    buckets: Array.from({ length: RECENT_DURABLE_PUBLICATION_EVENT_BUCKETS }, (_, index) => ({
      index,
      counts: Object.fromEntries(outcomes.map((outcome) => [outcome, null])),
    })),
  };
}
