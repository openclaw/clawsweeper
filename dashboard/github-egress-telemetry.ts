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
import { sqlColumnNames, type DurableStorage } from "./durable-storage.ts";

const ROLLUP_TABLE = "exact_review_github_egress_rollups_v2";
const RATE_LIMIT_TABLE = "exact_review_github_rate_limits_v2";
const RECEIPT_TABLE = "exact_review_github_egress_receipts_v2";
const DIAGNOSTICS_TABLE = "exact_review_github_egress_diagnostics_v2";
const FIVE_MINUTE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const HOURLY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RATE_LIMIT_RETENTION_MS = 24 * 60 * 60 * 1000;
const RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ROLLUP_ROWS = 50_000;
const MAX_RATE_LIMIT_ROWS = 10_000;
const MAX_PUBLIC_ROWS = 2_000;
const MAX_PUBLIC_THROTTLE_ROWS = 7 * 24 * GITHUB_EGRESS_POOL_CLASSES.length * 2;
const MAX_METRICS_PER_SUBMISSION = 128;
const MAX_RATE_LIMITS_PER_SUBMISSION = 16;
const MAX_RATE_LIMIT_INTEGER = 10_000_000_000;
const MAX_CREDENTIAL_CIRCUIT_MS = 2 * 60 * 60 * 1000;

export type GithubEgressCredentialCircuitObservation = {
  scope: "repository_actions";
  observedAt: number;
  retryAt: number;
  provenance: "retry_after" | "rate_limit_reset";
  authoritative: true;
};

function alignedBucketStart(bucketKind: "five_minute" | "hour", timestamp: number) {
  const bucketMs = bucketKind === "five_minute" ? 300_000 : 3_600_000;
  return Math.floor(timestamp / bucketMs) * bucketMs;
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function finiteTimestamp(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null;
}

function publicTimestamp(value: unknown): string | null {
  const timestamp = finiteTimestamp(value);
  return timestamp === null ? null : new Date(timestamp).toISOString();
}

function evictionWatermark(
  rows: Array<Record<string, unknown>>,
  bucketKind: string,
): number | null {
  const row = rows.find((candidate) => String(candidate.bucket_kind || "") === bucketKind);
  return finiteTimestamp(row?.bucket_start);
}

function evictionCount(rows: Array<Record<string, unknown>>, bucketKind: string): number {
  const row = rows.find((candidate) => String(candidate.bucket_kind || "") === bucketKind);
  const count = Number(row?.count || 0);
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

function rollupWindowComplete(
  diagnostics: Record<string, unknown>,
  bucketKind: "five_minute" | "hour",
  windowStart: number,
): boolean {
  const countColumn =
    bucketKind === "five_minute" ? "evicted_five_minute_rollup_rows" : "evicted_hour_rollup_rows";
  if (Number(diagnostics[countColumn] || 0) === 0) return true;
  const column =
    bucketKind === "five_minute"
      ? "last_five_minute_evicted_bucket_start"
      : "last_hour_evicted_bucket_start";
  const watermark = finiteTimestamp(diagnostics[column]);
  return watermark !== null && watermark < windowStart;
}

function rateLimitWindowComplete(
  diagnostics: Record<string, unknown>,
  windowStart: number,
): boolean {
  if (Number(diagnostics.evicted_rate_limit_rows || 0) === 0) return true;
  const watermark = finiteTimestamp(diagnostics.last_rate_limit_evicted_observed_at);
  return watermark !== null && watermark < windowStart;
}

export class GithubEgressTelemetryStore {
  private readonly storage: DurableStorage;
  private readonly maxRollupRows: number;
  private readonly maxRateLimitRows: number;

  constructor(
    storage: DurableStorage,
    limits: { maxRollupRows?: number; maxRateLimitRows?: number } = {},
  ) {
    this.storage = storage;
    this.maxRollupRows = positiveLimit(limits.maxRollupRows, MAX_ROLLUP_ROWS);
    this.maxRateLimitRows = positiveLimit(limits.maxRateLimitRows, MAX_RATE_LIMIT_ROWS);
  }

  ensureSchemaSync() {
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${ROLLUP_TABLE} (
         bucket_kind TEXT NOT NULL CHECK (bucket_kind IN ('five_minute', 'hour')),
         bucket_start INTEGER NOT NULL,
         deployment_revision TEXT NOT NULL,
         config_revision TEXT NOT NULL,
         pool_class TEXT NOT NULL,
         pool_identity TEXT NOT NULL,
         stage TEXT NOT NULL,
         source_action TEXT NOT NULL,
         operation TEXT NOT NULL,
         method TEXT NOT NULL,
         route_template TEXT NOT NULL,
         page_bucket TEXT NOT NULL,
         unit TEXT NOT NULL,
         outcome TEXT NOT NULL,
         status_bucket TEXT NOT NULL,
         latency_bucket TEXT NOT NULL,
         claim_generation_bucket TEXT NOT NULL,
         first_repeat TEXT NOT NULL,
         attempted INTEGER NOT NULL CHECK (attempted IN (0, 1)),
         telemetry_complete INTEGER NOT NULL CHECK (telemetry_complete IN (0, 1)),
         count INTEGER NOT NULL CHECK (count >= 1),
         PRIMARY KEY (
           bucket_kind, bucket_start, deployment_revision, config_revision,
           pool_class, pool_identity, stage, source_action, operation, method,
           route_template, page_bucket, unit, outcome, status_bucket,
           latency_bucket, claim_generation_bucket, first_repeat, attempted,
           telemetry_complete
         )
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_github_egress_rollups_window_v2
         ON ${ROLLUP_TABLE} (bucket_kind, bucket_start, pool_class, operation)`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${RATE_LIMIT_TABLE} (
         event_id TEXT PRIMARY KEY,
         observed_at INTEGER NOT NULL,
         deployment_revision TEXT NOT NULL,
         config_revision TEXT NOT NULL,
         pool_class TEXT NOT NULL,
         pool_identity TEXT NOT NULL,
         stage TEXT NOT NULL,
         source_action TEXT NOT NULL,
         operation TEXT NOT NULL,
         method TEXT NOT NULL,
         route_template TEXT NOT NULL,
         page_bucket TEXT NOT NULL,
         status INTEGER NOT NULL CHECK (status IN (403, 429)),
         retry_after_present INTEGER NOT NULL CHECK (retry_after_present IN (0, 1)),
         retry_after_seconds INTEGER,
         limit_present INTEGER NOT NULL CHECK (limit_present IN (0, 1)),
         rate_limit INTEGER,
         remaining_present INTEGER NOT NULL CHECK (remaining_present IN (0, 1)),
         remaining INTEGER,
         used_present INTEGER NOT NULL CHECK (used_present IN (0, 1)),
         used INTEGER,
         reset_present INTEGER NOT NULL CHECK (reset_present IN (0, 1)),
         reset_epoch_seconds INTEGER,
         resource_present INTEGER NOT NULL CHECK (resource_present IN (0, 1)),
         resource TEXT,
         reset_authority_candidate TEXT NOT NULL,
         telemetry_complete INTEGER NOT NULL CHECK (telemetry_complete IN (0, 1))
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_github_rate_limits_observed_v2
         ON ${RATE_LIMIT_TABLE} (observed_at, pool_class, operation)`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${RECEIPT_TABLE} (
         receipt_id TEXT PRIMARY KEY,
         observed_at INTEGER NOT NULL,
         credential_circuits_json TEXT NOT NULL DEFAULT '[]'
       ) STRICT`,
    );
    const receiptColumns = sqlColumnNames(this.storage, RECEIPT_TABLE);
    if (!receiptColumns.has("credential_circuits_json")) {
      this.storage.sql.exec(
        `ALTER TABLE ${RECEIPT_TABLE}
           ADD COLUMN credential_circuits_json TEXT NOT NULL DEFAULT '[]'`,
      );
    }
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${DIAGNOSTICS_TABLE} (
         singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
         accepted_submissions INTEGER NOT NULL DEFAULT 0,
         deduped_submissions INTEGER NOT NULL DEFAULT 0,
         rejected_submissions INTEGER NOT NULL DEFAULT 0,
         accepted_metrics INTEGER NOT NULL DEFAULT 0,
         accepted_rate_limits INTEGER NOT NULL DEFAULT 0,
         incomplete_count INTEGER NOT NULL DEFAULT 0,
         evicted_rollup_rows INTEGER NOT NULL DEFAULT 0,
         evicted_five_minute_rollup_rows INTEGER NOT NULL DEFAULT 0,
         evicted_hour_rollup_rows INTEGER NOT NULL DEFAULT 0,
         rollup_eviction_counts_exact INTEGER NOT NULL DEFAULT 1
           CHECK (rollup_eviction_counts_exact IN (0, 1)),
         evicted_rate_limit_rows INTEGER NOT NULL DEFAULT 0,
         last_rollup_evicted_at INTEGER,
         last_rate_limit_evicted_at INTEGER,
         last_five_minute_evicted_bucket_start INTEGER,
         last_hour_evicted_bucket_start INTEGER,
         last_rate_limit_evicted_observed_at INTEGER,
         last_observed_at INTEGER
       ) STRICT`,
    );
    const diagnosticColumns = sqlColumnNames(this.storage, DIAGNOSTICS_TABLE);
    for (const [column, definition] of [
      ["evicted_five_minute_rollup_rows", "INTEGER NOT NULL DEFAULT 0"],
      ["evicted_hour_rollup_rows", "INTEGER NOT NULL DEFAULT 0"],
      [
        "rollup_eviction_counts_exact",
        "INTEGER NOT NULL DEFAULT 1 CHECK (rollup_eviction_counts_exact IN (0, 1))",
      ],
      ["last_five_minute_evicted_bucket_start", "INTEGER"],
      ["last_hour_evicted_bucket_start", "INTEGER"],
      ["last_rate_limit_evicted_observed_at", "INTEGER"],
    ] as const) {
      if (!diagnosticColumns.has(column)) {
        this.storage.sql.exec(
          `ALTER TABLE ${DIAGNOSTICS_TABLE} ADD COLUMN ${column} ${definition}`,
        );
      }
    }
    this.storage.sql.exec(`INSERT OR IGNORE INTO ${DIAGNOSTICS_TABLE} (singleton_id) VALUES (1)`);
    // Older workers recorded when a cap eviction ran, not which evidence was
    // removed. Cap eviction always deleted the oldest rows first, so the oldest
    // retained timestamp is a conservative upper bound for the legacy
    // watermark. If no retained row exists, leave the watermark unknown and
    // fail closed in public queries.
    this.storage.sql.exec(
      `UPDATE ${DIAGNOSTICS_TABLE}
          SET rollup_eviction_counts_exact = CASE
                WHEN evicted_rollup_rows > 0
                  AND evicted_five_minute_rollup_rows = 0
                  AND evicted_hour_rollup_rows = 0
                THEN 0
                ELSE rollup_eviction_counts_exact
              END,
              evicted_five_minute_rollup_rows = CASE
                WHEN evicted_rollup_rows > 0
                  AND evicted_five_minute_rollup_rows = 0
                  AND evicted_hour_rollup_rows = 0
                THEN evicted_rollup_rows
                ELSE evicted_five_minute_rollup_rows
              END,
              evicted_hour_rollup_rows = CASE
                WHEN evicted_rollup_rows > 0
                  AND evicted_five_minute_rollup_rows = 0
                  AND evicted_hour_rollup_rows = 0
                THEN evicted_rollup_rows
                ELSE evicted_hour_rollup_rows
              END,
              last_five_minute_evicted_bucket_start = CASE
                WHEN evicted_rollup_rows > 0
                  AND last_five_minute_evicted_bucket_start IS NULL
                THEN (
                  SELECT MIN(bucket_start) FROM ${ROLLUP_TABLE}
                   WHERE bucket_kind = 'five_minute'
                )
                ELSE last_five_minute_evicted_bucket_start
              END,
              last_hour_evicted_bucket_start = CASE
                WHEN evicted_rollup_rows > 0
                  AND last_hour_evicted_bucket_start IS NULL
                THEN (
                  SELECT MIN(bucket_start) FROM ${ROLLUP_TABLE}
                   WHERE bucket_kind = 'hour'
                )
                ELSE last_hour_evicted_bucket_start
              END,
              last_rate_limit_evicted_observed_at = CASE
                WHEN evicted_rate_limit_rows > 0
                  AND last_rate_limit_evicted_observed_at IS NULL
                THEN (SELECT MIN(observed_at) FROM ${RATE_LIMIT_TABLE})
                ELSE last_rate_limit_evicted_observed_at
              END
        WHERE singleton_id = 1`,
    );
  }

  ingest(value: unknown, now = Date.now()) {
    const submission = githubEgressSubmission(value, now);
    if (!submission) {
      this.storage.sql.exec(
        `UPDATE ${DIAGNOSTICS_TABLE}
            SET rejected_submissions = rejected_submissions + 1,
                last_observed_at = ?
          WHERE singleton_id = 1`,
        now,
      );
      return { ok: false as const, error: "invalid_github_egress_telemetry" };
    }
    const credentialCircuits = githubEgressCredentialCircuitObservations(submission, now);
    return this.storage.transactionSync(() => {
      const existing = Array.from(
        this.storage.sql.exec(
          `SELECT credential_circuits_json
             FROM ${RECEIPT_TABLE} WHERE receipt_id = ? LIMIT 1`,
          submission.receiptId,
        ),
      ) as Array<Record<string, unknown>>;
      if (existing.length) {
        this.storage.sql.exec(
          `UPDATE ${DIAGNOSTICS_TABLE}
              SET deduped_submissions = deduped_submissions + 1,
                  last_observed_at = ?
            WHERE singleton_id = 1`,
          now,
        );
        return {
          ok: true as const,
          accepted: false,
          deduped: true,
          receiptId: submission.receiptId,
          credentialCircuits: storedGithubEgressCredentialCircuitObservations(
            existing[0]?.credential_circuits_json,
          ),
        };
      }
      this.pruneSync(now);
      let incomplete = 0;
      for (const metric of submission.metrics) {
        this.upsertMetric("five_minute", metric.bucketStart, metric);
        this.upsertMetric("hour", Math.floor(metric.bucketStart / 3_600_000) * 3_600_000, metric);
        if (!metric.telemetryComplete) incomplete += metric.count;
      }
      for (const [index, observation] of submission.rateLimitObservations.entries()) {
        this.storage.sql.exec(
          `INSERT OR IGNORE INTO ${RATE_LIMIT_TABLE} (
             event_id, observed_at, deployment_revision, config_revision,
             pool_class, pool_identity, stage, source_action, operation, method,
             route_template, page_bucket, status, retry_after_present,
             retry_after_seconds, limit_present, rate_limit, remaining_present,
             remaining, used_present, used, reset_present, reset_epoch_seconds,
             resource_present, resource, reset_authority_candidate,
             telemetry_complete
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          `${submission.receiptId}:${index}`,
          observation.observedAt,
          observation.deploymentRevision,
          observation.configRevision,
          observation.poolClass,
          observation.poolIdentity,
          observation.stage,
          observation.sourceAction,
          observation.operation,
          observation.method,
          observation.routeTemplate,
          observation.pageBucket,
          observation.status,
          observation.headers.retryAfterPresent ? 1 : 0,
          observation.headers.retryAfterSeconds,
          observation.headers.limitPresent ? 1 : 0,
          observation.headers.limit,
          observation.headers.remainingPresent ? 1 : 0,
          observation.headers.remaining,
          observation.headers.usedPresent ? 1 : 0,
          observation.headers.used,
          observation.headers.resetPresent ? 1 : 0,
          observation.headers.resetEpochSeconds,
          observation.headers.resourcePresent ? 1 : 0,
          observation.headers.resource,
          observation.resetAuthorityCandidate,
          observation.telemetryComplete ? 1 : 0,
        );
        if (!observation.telemetryComplete) incomplete += 1;
      }
      this.storage.sql.exec(
        `INSERT INTO ${RECEIPT_TABLE} (
           receipt_id, observed_at, credential_circuits_json
         ) VALUES (?, ?, ?)`,
        submission.receiptId,
        now,
        JSON.stringify(credentialCircuits),
      );
      this.enforceCapsSync(now);
      this.storage.sql.exec(
        `UPDATE ${DIAGNOSTICS_TABLE}
            SET accepted_submissions = accepted_submissions + 1,
                accepted_metrics = accepted_metrics + ?,
                accepted_rate_limits = accepted_rate_limits + ?,
                incomplete_count = incomplete_count + ?,
                last_observed_at = ?
          WHERE singleton_id = 1`,
        submission.metrics.reduce((total, metric) => total + metric.count, 0),
        submission.rateLimitObservations.length,
        incomplete,
        now,
      );
      return {
        ok: true as const,
        accepted: true,
        deduped: false,
        receiptId: submission.receiptId,
        credentialCircuits,
      };
    });
  }

  publicSummary(now = Date.now()) {
    const windowStart = now - 6 * 60 * 60 * 1000;
    const bucketStart = alignedBucketStart("five_minute", windowStart);
    const completeness = this.completenessSince("five_minute", bucketStart);
    const diagnostics = this.diagnostics();
    return {
      version: 2,
      window: "6h",
      generated_at: new Date(now).toISOString(),
      units: completeness.byUnit,
      completeness: completeness.result,
      retention: {
        detail_hours: 24,
        five_minute_days: 7,
        hourly_days: 30,
        evicted_rollup_rows_total: Number(diagnostics.evicted_rollup_rows || 0),
        evicted_five_minute_rollup_rows_total: Number(
          diagnostics.evicted_five_minute_rollup_rows || 0,
        ),
        evicted_hour_rollup_rows_total: Number(diagnostics.evicted_hour_rollup_rows || 0),
        rollup_eviction_count_exact: Number(diagnostics.rollup_eviction_counts_exact) === 1,
        evicted_rate_limit_rows_total: Number(diagnostics.evicted_rate_limit_rows || 0),
        last_five_minute_evicted_bucket_start: publicTimestamp(
          diagnostics.last_five_minute_evicted_bucket_start,
        ),
        last_hour_evicted_bucket_start: publicTimestamp(diagnostics.last_hour_evicted_bucket_start),
        last_rate_limit_evicted_observed_at: publicTimestamp(
          diagnostics.last_rate_limit_evicted_observed_at,
        ),
        rollup_window_complete: rollupWindowComplete(diagnostics, "five_minute", bucketStart),
        rate_limit_window_complete: rateLimitWindowComplete(diagnostics, windowStart),
      },
    };
  }

  private completenessSince(bucketKind: "five_minute" | "hour", start: number) {
    const totals = Array.from(
      this.storage.sql.exec(
        `SELECT unit, telemetry_complete, SUM(count) AS count
           FROM ${ROLLUP_TABLE}
          WHERE bucket_kind = ? AND bucket_start >= ?
          GROUP BY unit, telemetry_complete`,
        bucketKind,
        start,
      ),
    ) as Array<Record<string, unknown>>;
    const byUnit = {
      invocation: 0,
      wire_attempt: 0,
      member: 0,
      broker_lookup: 0,
      conditional_response: 0,
    };
    let complete = 0;
    let incomplete = 0;
    for (const row of totals) {
      const count = Number(row.count || 0);
      const unit = String(row.unit || "");
      if (
        unit === "invocation" ||
        unit === "wire_attempt" ||
        unit === "member" ||
        unit === "broker_lookup" ||
        unit === "conditional_response"
      ) {
        byUnit[unit] += count;
      }
      if (Number(row.telemetry_complete) === 1) complete += count;
      else incomplete += count;
    }
    return {
      byUnit,
      result: {
        complete,
        incomplete,
        observed: complete + incomplete > 0,
        telemetry_complete: complete > 0 && incomplete === 0,
      },
    };
  }

  publicObservability(hours: number, now = Date.now()) {
    const boundedHours =
      hours === 0.25 || hours === 1 || hours === 6 || hours === 24 || hours === 168 ? hours : null;
    if (!boundedHours) return null;
    const bucketKind = boundedHours <= 6 ? "five_minute" : "hour";
    const windowStart = now - boundedHours * 60 * 60 * 1000;
    const bucketStart = alignedBucketStart(bucketKind, windowStart);
    const closedThrough = alignedBucketStart(bucketKind, now);
    const rows = Array.from(
      this.storage.sql.exec(
        `SELECT bucket_start, deployment_revision, config_revision, pool_class,
                stage, source_action, operation, method, route_template,
                page_bucket, unit, outcome, status_bucket, latency_bucket,
                claim_generation_bucket, first_repeat, attempted,
                telemetry_complete, SUM(count) AS count
           FROM ${ROLLUP_TABLE}
          WHERE bucket_kind = ? AND bucket_start >= ?
          GROUP BY bucket_start, deployment_revision, config_revision,
                   pool_class, stage, source_action, operation, method,
                   route_template, page_bucket, unit, outcome, status_bucket,
                   latency_bucket, claim_generation_bucket, first_repeat,
                   attempted, telemetry_complete
          ORDER BY bucket_start ASC, pool_class, stage, operation, unit
          LIMIT ?`,
        bucketKind,
        bucketStart,
        MAX_PUBLIC_ROWS + 1,
      ),
    ) as Array<Record<string, unknown>>;
    const truncated = rows.length > MAX_PUBLIC_ROWS;
    const publicRows = rows.slice(0, MAX_PUBLIC_ROWS).map((row) => ({
      bucket_start: new Date(Number(row.bucket_start)).toISOString(),
      deployment_revision: row.deployment_revision,
      config_revision: row.config_revision,
      pool_class: row.pool_class,
      stage: row.stage,
      source_action: row.source_action,
      operation: row.operation,
      method: row.method,
      route_template: row.route_template,
      page_bucket: row.page_bucket,
      unit: row.unit,
      outcome: row.outcome,
      status_bucket: row.status_bucket,
      latency_bucket: row.latency_bucket,
      claim_generation_bucket: row.claim_generation_bucket,
      first_repeat: row.first_repeat,
      attempted: Number(row.attempted) === 1,
      telemetry_complete: Number(row.telemetry_complete) === 1,
      count: Number(row.count),
    }));
    const rateLimitRows = Array.from(
      this.storage.sql.exec(
        `SELECT observed_at, deployment_revision, config_revision, pool_class,
                stage, source_action, operation, method, route_template,
                page_bucket, status, retry_after_present, retry_after_seconds,
                limit_present, rate_limit, remaining_present, remaining,
                used_present, used, reset_present, reset_epoch_seconds,
                resource_present, resource, reset_authority_candidate,
                telemetry_complete
           FROM ${RATE_LIMIT_TABLE}
          WHERE observed_at >= ?
          ORDER BY observed_at DESC
          LIMIT 257`,
        Math.max(windowStart, now - RATE_LIMIT_RETENTION_MS),
      ),
    ) as Array<Record<string, unknown>>;
    const rateLimitTruncated = rateLimitRows.length > 256;
    const rateLimits = rateLimitRows.slice(0, 256).map(publicRateLimitRow);
    const completeness = this.completenessSince(bucketKind, bucketStart);
    const diagnostics = this.diagnostics();
    const rollupWindowIsComplete = rollupWindowComplete(diagnostics, bucketKind, bucketStart);
    const rateLimitDetailCoversWindow = boundedHours <= RATE_LIMIT_RETENTION_MS / 3_600_000;
    const rateLimitWindowIsComplete =
      rateLimitDetailCoversWindow && rateLimitWindowComplete(diagnostics, windowStart);
    const firstAvailableRows = Array.from(
      this.storage.sql.exec(
        `SELECT MIN(bucket_start) AS bucket_start
           FROM ${ROLLUP_TABLE}
          WHERE bucket_kind = ?`,
        bucketKind,
      ),
    ) as Array<Record<string, unknown>>;
    const firstAvailableBucket = finiteTimestamp(firstAvailableRows[0]?.bucket_start);
    const throttleRows = Array.from(
      this.storage.sql.exec(
        `SELECT bucket_start, pool_class, status_bucket, SUM(count) AS count
           FROM ${ROLLUP_TABLE}
          WHERE bucket_kind = ? AND bucket_start >= ? AND bucket_start < ?
            AND unit = 'wire_attempt' AND outcome = 'throttle'
            AND attempted = 1 AND telemetry_complete = 1
            AND status_bucket IN ('403', '429')
          GROUP BY bucket_start, pool_class, status_bucket
          ORDER BY bucket_start ASC, pool_class, status_bucket
          LIMIT ?`,
        bucketKind,
        bucketStart,
        closedThrough,
        MAX_PUBLIC_THROTTLE_ROWS + 1,
      ),
    ) as Array<Record<string, unknown>>;
    const throttleRowsTruncated = throttleRows.length > MAX_PUBLIC_THROTTLE_ROWS;
    const incompleteEgressRows = Array.from(
      this.storage.sql.exec(
        `SELECT SUM(count) AS count
           FROM ${ROLLUP_TABLE}
          WHERE bucket_kind = ? AND bucket_start >= ? AND bucket_start < ?
            AND telemetry_complete = 0`,
        bucketKind,
        bucketStart,
        closedThrough,
      ),
    ) as Array<Record<string, unknown>>;
    const excludedIncompleteEgressCount = Number(incompleteEgressRows[0]?.count || 0);
    // A first observation only proves coverage from somewhere inside its rollup
    // bucket. Require an earlier bucket before zero-filling the requested edge.
    const throttleCoverageComplete =
      firstAvailableBucket !== null && firstAvailableBucket < bucketStart;
    const throttleSeriesComplete =
      !throttleRowsTruncated &&
      excludedIncompleteEgressCount === 0 &&
      rollupWindowIsComplete &&
      throttleCoverageComplete;
    return {
      version: 2,
      generated_at: new Date(now).toISOString(),
      window: { hours: boundedHours, bucket_minutes: bucketKind === "five_minute" ? 5 : 60 },
      units: completeness.byUnit,
      rows: publicRows,
      rate_limit_observations: rateLimits,
      throttle_series: {
        unit: "wire_attempt",
        closed_through: new Date(closedThrough).toISOString(),
        first_available_bucket_start:
          firstAvailableBucket === null ? null : new Date(firstAvailableBucket).toISOString(),
        rows: throttleRows.slice(0, MAX_PUBLIC_THROTTLE_ROWS).map((row) => ({
          bucket_start: new Date(Number(row.bucket_start)).toISOString(),
          pool_class: row.pool_class,
          status_bucket: row.status_bucket,
          count: Number(row.count),
        })),
        rows_truncated: throttleRowsTruncated,
        excluded_incomplete_count: excludedIncompleteEgressCount,
        coverage_complete: throttleCoverageComplete,
        complete: throttleSeriesComplete,
      },
      retention: {
        rate_limit_detail_hours: RATE_LIMIT_RETENTION_MS / 3_600_000,
        rollup_evicted_rows_total: Number(
          diagnostics[
            bucketKind === "five_minute"
              ? "evicted_five_minute_rollup_rows"
              : "evicted_hour_rollup_rows"
          ] || 0,
        ),
        rollup_eviction_count_exact: Number(diagnostics.rollup_eviction_counts_exact) === 1,
        rate_limit_evicted_rows_total: Number(diagnostics.evicted_rate_limit_rows || 0),
        last_rollup_evicted_bucket_start: publicTimestamp(
          diagnostics[
            bucketKind === "five_minute"
              ? "last_five_minute_evicted_bucket_start"
              : "last_hour_evicted_bucket_start"
          ],
        ),
        last_rate_limit_evicted_observed_at: publicTimestamp(
          diagnostics.last_rate_limit_evicted_observed_at,
        ),
      },
      completeness: {
        ...completeness.result,
        rows_truncated: truncated,
        rate_limit_rows_truncated: rateLimitTruncated,
        rollup_window_complete: rollupWindowIsComplete,
        rate_limit_window_complete: rateLimitWindowIsComplete,
        query_complete:
          !truncated && !rateLimitTruncated && rollupWindowIsComplete && rateLimitWindowIsComplete,
      },
      privacy: {
        pool_identity: "withheld",
        raw_identifiers: false,
        closed_dimensions: true,
      },
    };
  }

  private upsertMetric(
    bucketKind: "five_minute" | "hour",
    bucketStart: number,
    metric: NonNullable<ReturnType<typeof githubEgressMetric>>,
  ) {
    this.storage.sql.exec(
      `INSERT INTO ${ROLLUP_TABLE} (
         bucket_kind, bucket_start, deployment_revision, config_revision,
         pool_class, pool_identity, stage, source_action, operation, method,
         route_template, page_bucket, unit, outcome, status_bucket,
         latency_bucket, claim_generation_bucket, first_repeat, attempted,
         telemetry_complete, count
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO UPDATE SET count = count + excluded.count`,
      bucketKind,
      bucketStart,
      metric.deploymentRevision,
      metric.configRevision,
      metric.poolClass,
      metric.poolIdentity,
      metric.stage,
      metric.sourceAction,
      metric.operation,
      metric.method,
      metric.routeTemplate,
      metric.pageBucket,
      metric.unit,
      metric.outcome,
      metric.statusBucket,
      metric.latencyBucket,
      metric.claimGenerationBucket,
      metric.firstRepeat,
      metric.attempted ? 1 : 0,
      metric.telemetryComplete ? 1 : 0,
      metric.count,
    );
  }

  private pruneSync(now: number) {
    this.storage.sql.exec(
      `DELETE FROM ${ROLLUP_TABLE}
        WHERE (bucket_kind = 'five_minute' AND bucket_start < ?)
           OR (bucket_kind = 'hour' AND bucket_start < ?)`,
      now - FIVE_MINUTE_RETENTION_MS,
      now - HOURLY_RETENTION_MS,
    );
    this.storage.sql.exec(
      `DELETE FROM ${RATE_LIMIT_TABLE} WHERE observed_at < ?`,
      now - RATE_LIMIT_RETENTION_MS,
    );
    this.storage.sql.exec(
      `DELETE FROM ${RECEIPT_TABLE} WHERE observed_at < ?`,
      now - RECEIPT_RETENTION_MS,
    );
  }

  private enforceCapsSync(now: number) {
    const rollupRows = Array.from(
      this.storage.sql.exec(`SELECT COUNT(*) AS count FROM ${ROLLUP_TABLE}`),
    ) as Array<Record<string, unknown>>;
    const rollupCount = Number(rollupRows[0]?.count || 0);
    const rollupOverflow = Math.max(0, rollupCount - this.maxRollupRows);
    if (rollupOverflow) {
      const evicted = Array.from(
        this.storage.sql.exec(
          `SELECT bucket_kind, MAX(bucket_start) AS bucket_start, COUNT(*) AS count
             FROM (
               SELECT bucket_kind, bucket_start FROM ${ROLLUP_TABLE}
                ORDER BY bucket_start ASC, rowid ASC LIMIT ?
             )
            GROUP BY bucket_kind`,
          rollupOverflow,
        ),
      ) as Array<Record<string, unknown>>;
      const fiveMinuteWatermark = evictionWatermark(evicted, "five_minute");
      const hourWatermark = evictionWatermark(evicted, "hour");
      const fiveMinuteCount = evictionCount(evicted, "five_minute");
      const hourCount = evictionCount(evicted, "hour");
      this.storage.sql.exec(
        `DELETE FROM ${ROLLUP_TABLE}
          WHERE rowid IN (
            SELECT rowid FROM ${ROLLUP_TABLE}
             ORDER BY bucket_start ASC, rowid ASC LIMIT ?
          )`,
        rollupOverflow,
      );
      this.storage.sql.exec(
        `UPDATE ${DIAGNOSTICS_TABLE}
            SET evicted_rollup_rows = evicted_rollup_rows + ?,
                evicted_five_minute_rollup_rows =
                  evicted_five_minute_rollup_rows + ?,
                evicted_hour_rollup_rows = evicted_hour_rollup_rows + ?,
                last_rollup_evicted_at = ?,
                last_five_minute_evicted_bucket_start = CASE
                  WHEN ? IS NULL THEN last_five_minute_evicted_bucket_start
                  ELSE MAX(COALESCE(last_five_minute_evicted_bucket_start, ?), ?)
                END,
                last_hour_evicted_bucket_start = CASE
                  WHEN ? IS NULL THEN last_hour_evicted_bucket_start
                  ELSE MAX(COALESCE(last_hour_evicted_bucket_start, ?), ?)
                END
          WHERE singleton_id = 1`,
        rollupOverflow,
        fiveMinuteCount,
        hourCount,
        now,
        fiveMinuteWatermark,
        fiveMinuteWatermark,
        fiveMinuteWatermark,
        hourWatermark,
        hourWatermark,
        hourWatermark,
      );
    }
    const rateRows = Array.from(
      this.storage.sql.exec(`SELECT COUNT(*) AS count FROM ${RATE_LIMIT_TABLE}`),
    ) as Array<Record<string, unknown>>;
    const rateCount = Number(rateRows[0]?.count || 0);
    const rateOverflow = Math.max(0, rateCount - this.maxRateLimitRows);
    if (rateOverflow) {
      const evicted = Array.from(
        this.storage.sql.exec(
          `SELECT MAX(observed_at) AS observed_at
             FROM (
               SELECT observed_at FROM ${RATE_LIMIT_TABLE}
                ORDER BY observed_at ASC, event_id ASC LIMIT ?
             )`,
          rateOverflow,
        ),
      )[0] as Record<string, unknown> | undefined;
      const rateLimitWatermark = finiteTimestamp(evicted?.observed_at);
      this.storage.sql.exec(
        `DELETE FROM ${RATE_LIMIT_TABLE}
          WHERE event_id IN (
            SELECT event_id FROM ${RATE_LIMIT_TABLE}
             ORDER BY observed_at ASC, event_id ASC LIMIT ?
          )`,
        rateOverflow,
      );
      this.storage.sql.exec(
        `UPDATE ${DIAGNOSTICS_TABLE}
            SET evicted_rate_limit_rows = evicted_rate_limit_rows + ?,
                last_rate_limit_evicted_at = ?,
                last_rate_limit_evicted_observed_at = CASE
                  WHEN ? IS NULL THEN last_rate_limit_evicted_observed_at
                  ELSE MAX(COALESCE(last_rate_limit_evicted_observed_at, ?), ?)
                END
          WHERE singleton_id = 1`,
        rateOverflow,
        now,
        rateLimitWatermark,
        rateLimitWatermark,
        rateLimitWatermark,
      );
    }
  }

  private diagnostics(): Record<string, unknown> {
    const rows = Array.from(
      this.storage.sql.exec(`SELECT * FROM ${DIAGNOSTICS_TABLE} LIMIT 1`),
    ) as Array<Record<string, unknown>>;
    return rows[0] || {};
  }
}

function githubEgressSubmission(value: unknown, now: number) {
  const body = objectValue(value);
  const receiptId = String(body.receipt_id || "");
  if (
    body.version !== 2 ||
    !/^[0-9a-f]{64}$/.test(receiptId) ||
    !Array.isArray(body.metrics) ||
    body.metrics.length > MAX_METRICS_PER_SUBMISSION ||
    !Array.isArray(body.rate_limit_observations) ||
    body.rate_limit_observations.length > MAX_RATE_LIMITS_PER_SUBMISSION ||
    (!body.metrics.length && !body.rate_limit_observations.length)
  ) {
    return null;
  }
  const rawMetrics: unknown[] = body.metrics;
  const metrics: Array<NonNullable<ReturnType<typeof githubEgressMetric>>> = [];
  for (const rawMetric of rawMetrics) {
    const metric = githubEgressMetric(rawMetric, now);
    if (!metric) return null;
    metrics.push(metric);
  }
  const rawRateLimitObservations: unknown[] = body.rate_limit_observations;
  const rateLimitObservations: Array<NonNullable<ReturnType<typeof githubRateLimitObservation>>> =
    [];
  for (const rawObservation of rawRateLimitObservations) {
    const observation = githubRateLimitObservation(rawObservation, now);
    if (!observation) return null;
    rateLimitObservations.push(observation);
  }
  return { receiptId, metrics, rateLimitObservations };
}

function githubEgressCredentialCircuitObservations(
  submission: NonNullable<ReturnType<typeof githubEgressSubmission>>,
  now: number,
): GithubEgressCredentialCircuitObservation[] {
  const observations: GithubEgressCredentialCircuitObservation[] = [];
  for (const observation of submission.rateLimitObservations) {
    // public_read_fallback is the workflow GITHUB_TOKEN and therefore shares
    // the repository Actions quota. target_app telemetry intentionally omits
    // its owner, so it cannot safely update an owner-scoped circuit here.
    if (
      !observation.telemetryComplete ||
      (observation.poolClass !== "repository_actions" &&
        observation.poolClass !== "public_read_fallback")
    ) {
      continue;
    }
    let retryAt = 0;
    let provenance: GithubEgressCredentialCircuitObservation["provenance"] | null = null;
    if (
      observation.resetAuthorityCandidate === "retry_after" &&
      observation.headers.retryAfterPresent &&
      observation.headers.retryAfterSeconds !== null
    ) {
      retryAt = observation.observedAt + Number(observation.headers.retryAfterSeconds) * 1_000;
      provenance = "retry_after";
    } else if (
      observation.resetAuthorityCandidate === "rate_limit_reset" &&
      observation.headers.resetPresent &&
      observation.headers.resetEpochSeconds !== null &&
      observation.headers.remainingPresent &&
      observation.headers.remaining === 0
    ) {
      retryAt = Number(observation.headers.resetEpochSeconds) * 1_000;
      provenance = "rate_limit_reset";
    }
    if (
      !provenance ||
      retryAt <= now ||
      retryAt < observation.observedAt ||
      retryAt > now + MAX_CREDENTIAL_CIRCUIT_MS
    ) {
      continue;
    }
    observations.push({
      scope: "repository_actions",
      observedAt: observation.observedAt,
      retryAt,
      provenance,
      authoritative: true,
    });
  }
  return observations;
}

function storedGithubEgressCredentialCircuitObservations(
  value: unknown,
): GithubEgressCredentialCircuitObservation[] {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    if (!Array.isArray(parsed) || parsed.length > MAX_RATE_LIMITS_PER_SUBMISSION) return [];
    const observations: GithubEgressCredentialCircuitObservation[] = [];
    for (const raw of parsed) {
      const observation = objectValue(raw);
      if (
        observation.scope !== "repository_actions" ||
        !Number.isSafeInteger(observation.observedAt) ||
        !Number.isSafeInteger(observation.retryAt) ||
        Number(observation.retryAt) < Number(observation.observedAt) ||
        !member(["retry_after", "rate_limit_reset"], observation.provenance) ||
        observation.authoritative !== true
      ) {
        return [];
      }
      observations.push({
        scope: "repository_actions",
        observedAt: Number(observation.observedAt),
        retryAt: Number(observation.retryAt),
        provenance:
          observation.provenance as GithubEgressCredentialCircuitObservation["provenance"],
        authoritative: true,
      });
    }
    return observations;
  } catch {
    return [];
  }
}

function githubEgressMetric(value: unknown, now: number) {
  const metric = objectValue(value);
  const bucketStart = Date.parse(String(metric.bucket_start || ""));
  const count = Number(metric.count);
  if (
    !Number.isFinite(bucketStart) ||
    bucketStart % 300_000 !== 0 ||
    bucketStart < now - 24 * 60 * 60 * 1000 ||
    bucketStart > now + 5 * 60_000 ||
    !digest(metric.deployment_revision, 16) ||
    !digest(metric.config_revision, 16) ||
    !digest(metric.pool_identity, 24) ||
    !member(GITHUB_EGRESS_POOL_CLASSES, metric.pool_class) ||
    !member(GITHUB_EGRESS_STAGES, metric.stage) ||
    !member(GITHUB_EGRESS_SOURCE_ACTIONS, metric.source_action) ||
    !member(GITHUB_EGRESS_OPERATIONS, metric.operation) ||
    !member(GITHUB_EGRESS_METHODS, metric.method) ||
    !member(GITHUB_EGRESS_ROUTE_TEMPLATES, metric.route_template) ||
    !member(GITHUB_EGRESS_PAGE_BUCKETS, metric.page_bucket) ||
    !member(GITHUB_EGRESS_UNITS, metric.unit) ||
    !member(GITHUB_EGRESS_OUTCOMES, metric.outcome) ||
    !member(GITHUB_EGRESS_STATUS_BUCKETS, metric.status_bucket) ||
    !member(GITHUB_EGRESS_LATENCY_BUCKETS, metric.latency_bucket) ||
    !member(GITHUB_EGRESS_CLAIM_GENERATION_BUCKETS, metric.claim_generation_bucket) ||
    !member(["first", "repeat", "unknown"], metric.first_repeat) ||
    typeof metric.attempted !== "boolean" ||
    typeof metric.telemetry_complete !== "boolean" ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > 1_000_000
  ) {
    return null;
  }
  return {
    bucketStart,
    deploymentRevision: metric.deployment_revision,
    configRevision: metric.config_revision,
    poolClass: metric.pool_class,
    poolIdentity: metric.pool_identity,
    stage: metric.stage,
    sourceAction: metric.source_action,
    operation: metric.operation,
    method: metric.method,
    routeTemplate: metric.route_template,
    pageBucket: metric.page_bucket,
    unit: metric.unit,
    outcome: metric.outcome,
    statusBucket: metric.status_bucket,
    latencyBucket: metric.latency_bucket,
    claimGenerationBucket: metric.claim_generation_bucket,
    firstRepeat: metric.first_repeat,
    attempted: metric.attempted,
    telemetryComplete: metric.telemetry_complete,
    count,
  };
}

function githubRateLimitObservation(value: unknown, now: number) {
  const observation = objectValue(value);
  const headers = objectValue(observation.headers);
  const observedAt = Date.parse(String(observation.observed_at || ""));
  if (
    !Number.isFinite(observedAt) ||
    observedAt < now - 24 * 60 * 60 * 1000 ||
    observedAt > now + 5 * 60_000 ||
    !digest(observation.deployment_revision, 16) ||
    !digest(observation.config_revision, 16) ||
    !digest(observation.pool_identity, 24) ||
    !member(GITHUB_EGRESS_POOL_CLASSES, observation.pool_class) ||
    !member(GITHUB_EGRESS_STAGES, observation.stage) ||
    !member(GITHUB_EGRESS_SOURCE_ACTIONS, observation.source_action) ||
    !member(GITHUB_EGRESS_OPERATIONS, observation.operation) ||
    !member(GITHUB_EGRESS_METHODS, observation.method) ||
    !member(GITHUB_EGRESS_ROUTE_TEMPLATES, observation.route_template) ||
    !member(GITHUB_EGRESS_PAGE_BUCKETS, observation.page_bucket) ||
    ![403, 429].includes(Number(observation.status)) ||
    !headers ||
    !member(
      ["retry_after", "rate_limit_reset", "absent", "invalid"],
      observation.reset_authority_candidate,
    ) ||
    typeof observation.telemetry_complete !== "boolean"
  ) {
    return null;
  }
  const parsedHeaders = rateLimitHeaders(headers);
  if (!parsedHeaders) return null;
  if (observation.reset_authority_candidate !== resetAuthorityCandidate(parsedHeaders)) return null;
  return {
    observedAt,
    deploymentRevision: observation.deployment_revision,
    configRevision: observation.config_revision,
    poolClass: observation.pool_class,
    poolIdentity: observation.pool_identity,
    stage: observation.stage,
    sourceAction: observation.source_action,
    operation: observation.operation,
    method: observation.method,
    routeTemplate: observation.route_template,
    pageBucket: observation.page_bucket,
    status: Number(observation.status),
    headers: parsedHeaders,
    resetAuthorityCandidate: observation.reset_authority_candidate,
    telemetryComplete: observation.telemetry_complete,
  };
}

function rateLimitHeaders(headers: Record<string, unknown>) {
  const presence = [
    "retryAfterPresent",
    "limitPresent",
    "remainingPresent",
    "usedPresent",
    "resetPresent",
    "resourcePresent",
  ];
  if (presence.some((key) => typeof headers[key] !== "boolean")) return null;
  const numericKeys = ["retryAfterSeconds", "limit", "remaining", "used", "resetEpochSeconds"];
  if (
    numericKeys.some((key) => {
      const value = headers[key];
      return (
        value !== null &&
        (!Number.isSafeInteger(value) ||
          Number(value) < 0 ||
          Number(value) > MAX_RATE_LIMIT_INTEGER)
      );
    }) ||
    !member(
      ["core", "graphql", "search", "integration_manifest", "unknown", null],
      headers.resource,
    )
  ) {
    return null;
  }
  if (
    (!headers.retryAfterPresent && headers.retryAfterSeconds !== null) ||
    (!headers.limitPresent && headers.limit !== null) ||
    (!headers.remainingPresent && headers.remaining !== null) ||
    (!headers.usedPresent && headers.used !== null) ||
    (!headers.resetPresent && headers.resetEpochSeconds !== null) ||
    (!headers.resourcePresent && headers.resource !== null) ||
    (headers.resourcePresent && headers.resource === null)
  ) {
    return null;
  }
  return headers;
}

function resetAuthorityCandidate(headers: Record<string, unknown>) {
  if (headers.retryAfterPresent) {
    return headers.retryAfterSeconds === null ? "invalid" : "retry_after";
  }
  if (headers.resetPresent) {
    return headers.resetEpochSeconds === null ? "invalid" : "rate_limit_reset";
  }
  return "absent";
}

function publicRateLimitRow(row: Record<string, unknown>) {
  return {
    observed_at: new Date(Number(row.observed_at)).toISOString(),
    deployment_revision: row.deployment_revision,
    config_revision: row.config_revision,
    pool_class: row.pool_class,
    stage: row.stage,
    source_action: row.source_action,
    operation: row.operation,
    method: row.method,
    route_template: row.route_template,
    page_bucket: row.page_bucket,
    status: Number(row.status),
    headers: {
      retry_after_present: Number(row.retry_after_present) === 1,
      retry_after_seconds: nullableNumber(row.retry_after_seconds),
      limit_present: Number(row.limit_present) === 1,
      limit: nullableNumber(row.rate_limit),
      remaining_present: Number(row.remaining_present) === 1,
      remaining: nullableNumber(row.remaining),
      used_present: Number(row.used_present) === 1,
      used: nullableNumber(row.used),
      reset_present: Number(row.reset_present) === 1,
      reset_epoch_seconds: nullableNumber(row.reset_epoch_seconds),
      resource_present: Number(row.resource_present) === 1,
      resource: row.resource || null,
    },
    reset_authority_candidate: row.reset_authority_candidate,
    telemetry_complete: Number(row.telemetry_complete) === 1,
  };
}

function nullableNumber(value: unknown) {
  return value === null || value === undefined ? null : Number(value);
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function digest(value: unknown, length: number) {
  return typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`).test(value);
}

function member<const Member>(values: readonly Member[], value: unknown): value is Member {
  return values.some((candidate) => candidate === value);
}
