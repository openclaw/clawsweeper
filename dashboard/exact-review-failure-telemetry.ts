import type { ExactReviewDecision } from "./exact-review-decision.ts";
import { stableJson } from "../src/stable-json.ts";

export const EXACT_REVIEW_FAILURE_TELEMETRY_TABLE = "exact_review_failure_attempts_v1";
export const EXACT_REVIEW_FAILURE_TELEMETRY_STATE_TABLE = "exact_review_failure_telemetry_state_v1";
export const EXACT_REVIEW_FAILURE_TELEMETRY_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
export const EXACT_REVIEW_FAILURE_HEALTH_WINDOW_MS = 60 * 60 * 1000;

const FAILURE_STAGES = new Set([
  "agent_input_scan",
  "source_preparation",
  "provider_throttle",
  "transport_network",
  "content_or_output",
  "model_access",
  "timeout",
  "codex_execution",
  "workflow",
]);
const FAILURE_REASONS = new Set([
  "scanner_unavailable",
  "scanner_failed",
  "findings",
  "deadline",
  "staging_limit",
  "incomplete_source",
  "source_drift",
  "unsafe_path",
  "unsupported_content",
  "configuration_missing",
  "setup_script_failed",
  "source_incompatible",
  "review_commits_unavailable",
  "review_history_unavailable",
  "review_blob_metadata_unavailable",
  "review_blobs_unavailable",
  "review_checkout_unavailable",
  "review_commit_fetch_failed",
  "review_checkout_failed",
  "review_git_inspection_failed",
  "provider_throttle",
  "transport_network",
  "content_or_output",
  "model_access",
  "timeout",
  "codex_execution",
  "workflow_failed",
  "workflow_cancelled",
  "unknown",
]);
const PUBLIC_FAILURE_STAGES = [
  "agent_input_scan",
  "source_preparation",
  "provider_or_model",
  "workflow",
] as const;

type SqlStorage = {
  exec: (query: string, ...bindings: unknown[]) => Iterable<Record<string, unknown>>;
};

type DurableStorage = {
  sql: SqlStorage;
  transactionSync: <T>(callback: () => T) => T;
};

export type ExactReviewFailureDetail = {
  stage: string;
  reasonCode: string;
  retryable: boolean;
};

export type ExactReviewFailureAttempt = ExactReviewFailureDetail & {
  attemptId: string;
  canonicalTargetKey: string;
  fenceKey: string;
  revision: number;
  claimGeneration: number;
  runId: string;
  runAttempt: number;
  sourceFingerprint: string;
  failureFingerprint: string;
  sourceHeadSha: string | null;
  sourceContentRevision: string | null;
  sourceUpdatedAt: string | null;
  observedAt: number;
};

export function normalizeExactReviewFailureDetail(value: unknown): ExactReviewFailureDetail | null {
  const record = objectValue(value);
  const stage = String(record.stage || "").trim();
  const reasonCode = String(record.reason_code || "").trim();
  if (!FAILURE_STAGES.has(stage) || !FAILURE_REASONS.has(reasonCode)) return null;
  if (typeof record.retryable !== "boolean") return null;
  return { stage, reasonCode, retryable: record.retryable };
}

export function exactReviewFailureDetail(options: {
  outcome: "failure" | "cancelled";
  terminalReason?: "findings" | "incomplete_source" | "source_incompatible";
  supplied?: ExactReviewFailureDetail;
}): ExactReviewFailureDetail {
  if (options.supplied) return options.supplied;
  if (options.terminalReason === "source_incompatible") {
    return { stage: "source_preparation", reasonCode: "source_incompatible", retryable: false };
  }
  if (options.terminalReason) {
    return { stage: "agent_input_scan", reasonCode: options.terminalReason, retryable: false };
  }
  return {
    stage: "workflow",
    reasonCode: options.outcome === "cancelled" ? "workflow_cancelled" : "workflow_failed",
    retryable: true,
  };
}

export function stableExactReviewFailureFingerprint(value: string): string {
  const mask = (1n << 64n) - 1n;
  return ["source", "failure", "attempt", "telemetry"]
    .map((salt) => {
      let hash = 0xcbf29ce484222325n;
      for (const character of `${salt}\0${value}`) {
        hash ^= BigInt(character.charCodeAt(0));
        hash = (hash * 0x100000001b3n) & mask;
      }
      return hash.toString(16).padStart(16, "0");
    })
    .join("");
}

export function exactReviewFailureSource(decision: ExactReviewDecision) {
  return {
    sourceHeadSha: /^[0-9a-f]{40}$/.test(String(decision.sourceHeadSha || ""))
      ? String(decision.sourceHeadSha)
      : null,
    sourceContentRevision: /^[0-9a-f]{64}$/.test(String(decision.sourceContentRevision || ""))
      ? String(decision.sourceContentRevision)
      : null,
    sourceUpdatedAt: Number.isFinite(Date.parse(String(decision.sourceUpdatedAt || "")))
      ? new Date(Date.parse(String(decision.sourceUpdatedAt))).toISOString()
      : null,
  };
}

export function exactReviewFailureSourceFingerprint(decision: ExactReviewDecision) {
  const source = exactReviewFailureSource(decision);
  const sourceBaseSha = /^[0-9a-f]{40}$/.test(String(decision.sourceBaseSha || ""))
    ? String(decision.sourceBaseSha)
    : null;
  return stableExactReviewFailureFingerprint(
    stableJson({
      version: 1,
      target: `${decision.targetRepo}#${decision.itemNumber}`,
      target_branch: decision.targetBranch,
      source_action: decision.sourceAction,
      head_sha: source.sourceHeadSha,
      base_sha: sourceBaseSha,
      is_draft: typeof decision.sourceIsDraft === "boolean" ? decision.sourceIsDraft : null,
      content_revision: source.sourceContentRevision,
      updated_at: source.sourceContentRevision ? null : source.sourceUpdatedAt,
      comment_updated_at: decision.sourceCommentUpdatedAt || null,
      command_body_digest: decision.commandBodyDigest || null,
    }),
  );
}

export class ExactReviewFailureTelemetryStore {
  private readonly storage: DurableStorage;
  private schemaReady = false;

  constructor(storage: DurableStorage) {
    this.storage = storage;
  }

  ensureSchemaSync() {
    if (this.schemaReady) {
      try {
        // DDL can be invoked from a caller-owned SQLite transaction. If that
        // outer transaction rolls back after this method returns, the in-memory
        // readiness flag survives but the schema does not. Probe the table so
        // the next access can repair that rollback without a DO restart.
        this.storage.sql.exec(
          `SELECT attempt_id FROM ${EXACT_REVIEW_FAILURE_TELEMETRY_TABLE} LIMIT 0`,
        );
        return;
      } catch {
        this.schemaReady = false;
      }
    }
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_FAILURE_TELEMETRY_TABLE} (
         attempt_id TEXT PRIMARY KEY,
         canonical_target_key TEXT NOT NULL,
         fence_key TEXT NOT NULL,
         revision INTEGER NOT NULL CHECK (revision >= 1),
         claim_generation INTEGER NOT NULL CHECK (claim_generation >= 1),
         run_id TEXT NOT NULL,
         run_attempt INTEGER NOT NULL CHECK (run_attempt >= 1),
         source_fingerprint TEXT NOT NULL,
         failure_fingerprint TEXT NOT NULL,
         source_head_sha TEXT,
         source_content_revision TEXT,
         source_updated_at TEXT,
         stage TEXT NOT NULL,
         reason_code TEXT NOT NULL,
         retryable INTEGER NOT NULL CHECK (retryable IN (0, 1)),
         observed_at INTEGER NOT NULL,
         UNIQUE (fence_key, revision, claim_generation, run_id, run_attempt)
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_failure_attempts_window_v1
         ON ${EXACT_REVIEW_FAILURE_TELEMETRY_TABLE}
         (observed_at, stage, reason_code)`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_failure_attempts_identity_v1
         ON ${EXACT_REVIEW_FAILURE_TELEMETRY_TABLE}
         (canonical_target_key, source_fingerprint, failure_fingerprint, observed_at)`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_FAILURE_TELEMETRY_STATE_TABLE} (
         singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
         dropped_attempts INTEGER NOT NULL CHECK (dropped_attempts >= 0),
         last_drop_at INTEGER NOT NULL
       ) STRICT`,
    );
    this.schemaReady = true;
  }

  recordSync(attempt: ExactReviewFailureAttempt) {
    validateAttempt(attempt);
    this.ensureSchemaSync();
    this.pruneSync(attempt.observedAt);
    this.storage.sql.exec(
      `INSERT OR IGNORE INTO ${EXACT_REVIEW_FAILURE_TELEMETRY_TABLE}
       (attempt_id, canonical_target_key, fence_key, revision, claim_generation,
        run_id, run_attempt, source_fingerprint, failure_fingerprint, source_head_sha,
        source_content_revision, source_updated_at, stage, reason_code, retryable, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      attempt.attemptId,
      attempt.canonicalTargetKey,
      attempt.fenceKey,
      attempt.revision,
      attempt.claimGeneration,
      attempt.runId,
      attempt.runAttempt,
      attempt.sourceFingerprint,
      attempt.failureFingerprint,
      attempt.sourceHeadSha,
      attempt.sourceContentRevision,
      attempt.sourceUpdatedAt,
      attempt.stage,
      attempt.reasonCode,
      attempt.retryable ? 1 : 0,
      attempt.observedAt,
    );
  }

  recordDropSync(observedAt: number) {
    if (!Number.isFinite(observedAt) || observedAt < 1) {
      throw new Error("invalid review failure telemetry drop timestamp");
    }
    this.ensureSchemaSync();
    this.storage.sql.exec(
      `INSERT INTO ${EXACT_REVIEW_FAILURE_TELEMETRY_STATE_TABLE}
         (singleton_id, dropped_attempts, last_drop_at)
       VALUES (1, 1, ?)
       ON CONFLICT(singleton_id) DO UPDATE SET
         dropped_attempts = MIN(1000000000, dropped_attempts + 1),
         last_drop_at = MAX(last_drop_at, excluded.last_drop_at)`,
      observedAt,
    );
  }

  summarySync(now = Date.now(), windowMs = EXACT_REVIEW_FAILURE_HEALTH_WINDOW_MS) {
    this.ensureSchemaSync();
    this.pruneSync(now);
    const from = now - windowMs;
    const row = Array.from(
      this.storage.sql.exec(
        `SELECT COUNT(*) AS attempts,
                COUNT(DISTINCT canonical_target_key) AS affected_targets,
                COALESCE(SUM(retryable), 0) AS retryable_attempts,
                COALESCE(SUM(CASE WHEN retryable = 0 THEN 1 ELSE 0 END), 0) AS terminal_attempts,
                MIN(observed_at) AS first_seen_at,
                MAX(observed_at) AS last_seen_at
           FROM ${EXACT_REVIEW_FAILURE_TELEMETRY_TABLE}
          WHERE observed_at >= ?`,
        from,
      ),
    )[0] as Record<string, unknown> | undefined;
    const repeated = Array.from(
      this.storage.sql.exec(
        `SELECT COUNT(*) AS repeated_identities FROM (
           SELECT 1 FROM ${EXACT_REVIEW_FAILURE_TELEMETRY_TABLE}
            WHERE observed_at >= ?
            GROUP BY canonical_target_key, source_fingerprint, failure_fingerprint
           HAVING COUNT(*) >= 2
         )`,
        from,
      ),
    )[0] as Record<string, unknown> | undefined;
    const telemetryState = Array.from(
      this.storage.sql.exec(
        `SELECT dropped_attempts, last_drop_at
           FROM ${EXACT_REVIEW_FAILURE_TELEMETRY_STATE_TABLE}
          WHERE singleton_id = 1`,
      ),
    )[0] as Record<string, unknown> | undefined;
    const stageCounts = Object.fromEntries(PUBLIC_FAILURE_STAGES.map((stage) => [stage, 0]));
    for (const stageRow of this.storage.sql.exec(
      `SELECT stage, COUNT(*) AS attempts FROM ${EXACT_REVIEW_FAILURE_TELEMETRY_TABLE}
        WHERE observed_at >= ? GROUP BY stage`,
      from,
    )) {
      const stage = publicStage(String(stageRow.stage || ""));
      stageCounts[stage] += Number(stageRow.attempts || 0);
    }
    const attempts = Number(row?.attempts || 0);
    const repeatedIdentities = Number(repeated?.repeated_identities || 0);
    const telemetryIncomplete = Number(telemetryState?.last_drop_at || 0) >= from;
    const status = telemetryIncomplete
      ? "unknown"
      : repeatedIdentities > 0
        ? "critical"
        : attempts > 0
          ? "degraded"
          : "healthy";
    return {
      status,
      reasons: telemetryIncomplete
        ? ["telemetry_unavailable"]
        : [
            ...(repeatedIdentities > 0 ? ["repeated_failure_identity"] : []),
            ...(Number(row?.terminal_attempts || 0) > 0 ? ["terminal_review_failure"] : []),
            ...(Number(row?.retryable_attempts || 0) > 0 ? ["retryable_review_failure"] : []),
          ],
      window_minutes: Math.floor(windowMs / 60_000),
      attempts,
      affected_targets: Number(row?.affected_targets || 0),
      retryable_attempts: Number(row?.retryable_attempts || 0),
      terminal_attempts: Number(row?.terminal_attempts || 0),
      repeated_identities: repeatedIdentities,
      first_seen_at: timestamp(row?.first_seen_at),
      last_seen_at: timestamp(row?.last_seen_at),
      by_stage: stageCounts,
    };
  }

  listSync(options: { limit: number; cursor?: string; now?: number }) {
    this.ensureSchemaSync();
    this.pruneSync(options.now ?? Date.now());
    const cursor = /^(\d{1,16}):([0-9a-f]{64})$/.exec(options.cursor || "");
    const cursorAt = cursor ? Number(cursor[1]) : Number.MAX_SAFE_INTEGER;
    const cursorId = cursor?.[2] || "~";
    const rows = Array.from(
      this.storage.sql.exec(
        `SELECT attempt_id, canonical_target_key, revision, claim_generation, run_id, run_attempt,
                source_fingerprint, failure_fingerprint, source_head_sha, source_content_revision,
                source_updated_at, stage, reason_code, retryable, observed_at
           FROM ${EXACT_REVIEW_FAILURE_TELEMETRY_TABLE}
          WHERE observed_at < ? OR (observed_at = ? AND attempt_id < ?)
          ORDER BY observed_at DESC, attempt_id DESC LIMIT ?`,
        cursorAt,
        cursorAt,
        cursorId,
        options.limit + 1,
      ),
    );
    const page = rows.slice(0, options.limit);
    return {
      attempts: page.map((row) => ({
        attempt_id: String(row.attempt_id),
        target: String(row.canonical_target_key),
        revision: Number(row.revision),
        claim_generation: Number(row.claim_generation),
        run_id: String(row.run_id),
        run_attempt: Number(row.run_attempt),
        source_fingerprint: String(row.source_fingerprint),
        failure_fingerprint: String(row.failure_fingerprint),
        source_head_sha: row.source_head_sha === null ? null : String(row.source_head_sha),
        source_content_revision:
          row.source_content_revision === null ? null : String(row.source_content_revision),
        source_updated_at: row.source_updated_at === null ? null : String(row.source_updated_at),
        stage: String(row.stage),
        reason_code: String(row.reason_code),
        retryable: Number(row.retryable) === 1,
        observed_at: timestamp(row.observed_at),
      })),
      next_cursor:
        rows.length > options.limit
          ? `${Number(page.at(-1)?.observed_at)}:${String(page.at(-1)?.attempt_id || "")}`
          : null,
    };
  }

  private pruneSync(now: number) {
    this.storage.sql.exec(
      `DELETE FROM ${EXACT_REVIEW_FAILURE_TELEMETRY_TABLE} WHERE observed_at <= ?`,
      now - EXACT_REVIEW_FAILURE_TELEMETRY_RETENTION_MS,
    );
  }
}

function validateAttempt(attempt: ExactReviewFailureAttempt) {
  if (
    !/^[0-9a-f]{64}$/.test(attempt.attemptId) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*$/.test(attempt.canonicalTargetKey) ||
    !attempt.fenceKey ||
    attempt.fenceKey.length > 512 ||
    /[\r\n]/.test(attempt.fenceKey) ||
    !Number.isSafeInteger(attempt.revision) ||
    attempt.revision < 1 ||
    !Number.isSafeInteger(attempt.claimGeneration) ||
    attempt.claimGeneration < 1 ||
    !/^\d+$/.test(attempt.runId) ||
    !Number.isSafeInteger(attempt.runAttempt) ||
    attempt.runAttempt < 1 ||
    !/^[0-9a-f]{64}$/.test(attempt.sourceFingerprint) ||
    !/^[0-9a-f]{64}$/.test(attempt.failureFingerprint) ||
    (attempt.sourceHeadSha !== null && !/^[0-9a-f]{40}$/.test(attempt.sourceHeadSha)) ||
    (attempt.sourceContentRevision !== null &&
      !/^[0-9a-f]{64}$/.test(attempt.sourceContentRevision)) ||
    (attempt.sourceUpdatedAt !== null && !Number.isFinite(Date.parse(attempt.sourceUpdatedAt))) ||
    !FAILURE_STAGES.has(attempt.stage) ||
    !FAILURE_REASONS.has(attempt.reasonCode) ||
    !Number.isFinite(attempt.observedAt)
  ) {
    throw new Error("invalid exact-review failure attempt");
  }
}

function publicStage(stage: string): (typeof PUBLIC_FAILURE_STAGES)[number] {
  if (stage === "agent_input_scan" || stage === "source_preparation" || stage === "workflow") {
    return stage;
  }
  return "provider_or_model";
}

function timestamp(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? new Date(parsed).toISOString() : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
