import { stableJson } from "../src/stable-json.ts";
import {
  normalizeStateWriterOperation,
  normalizeStateWriterProgress,
  payloadHash,
  type StateWriterOperation,
} from "../src/state-writer-telemetry.ts";
import {
  summarizeExactReviewHandoff,
  summarizeExactReviewPressure,
} from "./exact-review-health.ts";
import {
  ExactReviewPublicationBatchStore,
  type PublicationBatchCompletion,
  type PublicationBatchFence,
} from "./exact-review-publication-batches.ts";
import {
  REVIEW_TELEMETRY_DEGRADED_MS,
  REVIEW_TELEMETRY_ORPHAN_MS,
  REVIEW_TELEMETRY_RETENTION_MS,
  type DurableReviewTelemetry,
  type ReviewTelemetryHealth,
  normalizeReviewTelemetry,
} from "./review-telemetry.ts";
import {
  REVIEW_OBSERVABILITY_RANGES,
  summarizeReviewObservability,
} from "./review-observability.ts";
import {
  type DurableReviewRunTelemetry,
  normalizeReviewRunTelemetry,
} from "./review-run-telemetry.ts";

type GithubAppJsonOptions = { method?: string; body?: BodyInit; errorLabel?: string };
const GITHUB_TIMEOUT_MS = 4500;
const CLAWSWEEPER_REVIEW_REPO = "openclaw/clawsweeper";

const FAILED_REVIEW_SHARD_RECOVERY_SOURCE_ACTION = "failed_review_shard_recovery";
const EXACT_REVIEW_ARTIFACT_PUBLISH_SOURCE_ACTION = "exact_review_artifact_publish";
const EXACT_REVIEW_ARTIFACT_RETENTION_RECOVERY_SOURCE_ACTION = "artifact_retention_recovery";
const EXACT_REVIEW_SOURCE_DRIFT_REQUEUE_SOURCE_ACTION = "source_drift_requeue";
const EXACT_REVIEW_LOW_PRIORITY_SOURCE_ACTIONS = new Set([
  FAILED_REVIEW_SHARD_RECOVERY_SOURCE_ACTION,
  EXACT_REVIEW_ARTIFACT_RETENTION_RECOVERY_SOURCE_ACTION,
  EXACT_REVIEW_SOURCE_DRIFT_REQUEUE_SOURCE_ACTION,
]);

export type ExactReviewBaseDecision = {
  targetRepo: string;
  targetBranch: string;
  itemNumber: number;
  itemKind: "issue" | "pull_request";
  sourceEvent: "issues" | "pull_request";
  sourceAction: string;
  supersedesInProgress: boolean;
  codexTimeoutMs?: number;
  mediaProofTimeoutMs?: number;
  commandStatusMarker?: string;
  statusCommentId?: number;
  additionalPrompt?: string;
};
export type ExactReviewPublication = {
  artifactName: string;
  producerRunId: string;
  producerRunAttempt: number;
  sourceSha: string;
  itemKey: string;
  protocolVersion: 1 | 2;
  leaseRevision: number | null;
  claimGeneration: number | null;
  liveProceeded: boolean;
  liveTerminalNoop: boolean;
  liveTerminalMissing: boolean;
  liveGuardedOpen: boolean;
  producerDecision: ExactReviewBaseDecision;
};
export type ExactReviewDecision = ExactReviewBaseDecision & {
  publication?: ExactReviewPublication;
};
export type ExactReviewQueueItem = {
  key: string;
  decision: ExactReviewDecision;
  leaseDecision?: ExactReviewDecision;
  state: "pending" | "dispatching" | "leased" | "parked";
  revision: number;
  createdAt: number;
  updatedAt: number;
  nextAttemptAt: number;
  attempts: number;
  leaseId?: string;
  leaseRevision?: number;
  leaseExpiresAt?: number;
  leaseHeartbeatAt?: number;
  claimedRunId?: string;
  claimedRunAttempt?: number;
  claimGeneration?: number;
  claimProtocolVersion?: 1 | 2;
  dispatchedAt?: number;
  claimedAt?: number;
  parkedReason?: "dead_letter_capacity";
  lastFailureReason?: ExactReviewPublicationReasonCode;
  firstFailureAt?: number;
  publicationFailureAttempts?: number;
};
export type ExactReviewCompletionOutcome = "success" | "failure" | "cancelled";
type ExactReviewPublicationFailureKind = "github_rate_limit" | "github_transient";
export type ExactReviewPublicationCompletionKind =
  | "published"
  | "superseded"
  | "deferred"
  | "retryable_failure"
  | "refresh_required"
  | "permanent_failure";
type ExactReviewPublicationReasonCode =
  | "publication_applied"
  | "remote_newer_tuple"
  | "remote_closed"
  | "live_terminal"
  | "github_rate_limit"
  | "github_transient"
  | "state_contention"
  | "review_lease_active"
  | "workflow_cancelled"
  | "artifact_unavailable"
  | "artifact_expired"
  | "close_coverage_retry"
  | "close_coverage_deferred"
  | "invalid_artifact"
  | "missing_record_tuple"
  | "tuple_protocol_invalid"
  | "policy_invariant"
  | "unknown_failure"
  | "retry_exhausted";
type ExactReviewPublicationCompletion = {
  kind: ExactReviewPublicationCompletionKind;
  reasonCode: ExactReviewPublicationReasonCode;
  errorFingerprint?: string;
};
type ExactReviewPublicationFeedback = {
  at: number;
  capacity: number;
  outcome: "success" | "failure";
  failureKind?: ExactReviewPublicationFailureKind;
};
type ExactReviewPublicationControl = {
  capacityCeiling: number;
  demandCapacity: number;
  cooldownUntil: number;
  recoverySuccesses: number;
  demandSamples: number;
  demandTier: number;
  lastDemandSampleAt: number;
  lastScaleAt: number;
  lastFailureAt?: number;
  lastFailureKind?: ExactReviewPublicationFailureKind;
};
export type ExactReviewClaimedRun = {
  runId: string;
  runAttempt?: number;
  claimGeneration: number;
};
export type ExactReviewQueueState = {
  items: Record<string, ExactReviewQueueItem>;
  shedSinceReset?: number;
  dispatcher?: {
    state: "active" | "paused" | "blocked" | "unknown";
    reason?: "workflow_not_active" | "workflow_status_unavailable";
    workflowState?: string;
    checkedAt: number;
    retryAt?: number;
    publicationBatchDispatchedAt?: number;
    publicationBatchDispatchSucceeded?: boolean;
    publicationBatchDispatchPendingUntil?: number;
  };
};
type LegacyExactReviewQueueState = ExactReviewQueueState & {
  deliveries?: Record<string, number>;
};
type ExactReviewQueueBaseline = {
  items: Map<string, string>;
  dispatcherJson: string | null;
};
type ExactReviewDeadLetterInsert = {
  id: string;
  itemKey: string;
  revision: number;
  targetRepo: string;
  itemNumber: number;
  producerRunId: string;
  producerRunAttempt: number;
  artifactName: string;
  reasonCode: ExactReviewPublicationReasonCode;
  attempts: number;
  firstFailedAt: number;
  lastFailedAt: number;
  itemJson: string;
  errorFingerprint?: string;
};
type ExactReviewQueueStorageMeta = {
  schema_version: number;
  migrated_at: number;
  storage_generation: number;
  dispatcher_json: string | null;
  shed_since_reset?: number;
};
type ExactReviewQueueMetricTotals = {
  review: { enqueued: number; completed: number };
  publication: {
    enqueued: number;
    completed: number;
    published: number;
    superseded: number;
    retried: number;
    deadLettered: number;
    refreshed: number;
  };
};
type ExactReviewQueueMetricDelta = {
  reviewEnqueued?: number;
  reviewCompleted?: number;
  reviewRetried?: number;
  reviewShed?: number;
  publicationEnqueued?: number;
  publicationCompleted?: number;
  publicationPublished?: number;
  publicationSuperseded?: number;
  publicationRetried?: number;
  publicationDeadLettered?: number;
  publicationRefreshed?: number;
};
type StateAppendKind = "sweep_status" | "comment_router" | "apply_proof";
type StateAppendRecord = {
  kind: StateAppendKind;
  key: string;
  payloadJson: string;
  payloadBytes: number;
  producedAt: string;
};
type StateAppendWindowRow = {
  seq: number;
  kind: StateAppendKind;
  record_key: string;
  payload_json: string;
  payload_bytes: number;
  produced_at: string;
  delivery_id: string;
};
export type DurableObjectStub = { fetch: (request: Request) => Promise<Response> };
export type DurableObjectNamespace = {
  idFromName: (name: string) => unknown;
  get: (id: unknown) => DurableObjectStub;
};

const DEFAULT_EXACT_REVIEW_QUEUE_MAX_CONCURRENT = 64;
const DEFAULT_EXACT_REVIEW_TARGET_MAX_CONCURRENT = 60;
const DEFAULT_EXACT_REVIEW_PUBLICATION_MIN_CONCURRENT = 4;
const DEFAULT_EXACT_REVIEW_PUBLICATION_BASE_CONCURRENT = 24;
const DEFAULT_EXACT_REVIEW_PUBLICATION_MAX_CONCURRENT = 48;
const EXACT_REVIEW_PUBLICATION_CONCURRENT_SCALE_STEP = 8;
const EXACT_REVIEW_PUBLICATION_RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000;
const EXACT_REVIEW_PUBLICATION_TRANSIENT_COOLDOWN_MS = 5 * 60 * 1000;
// One ceiling step up requires this many consecutive clean publications. The
// former value of 50 mathematically pinned the lane at minimum under hourly
// rate-limit bursts (each burst resets the counter and halves the ceiling; 50
// clean runs never fit between bursts at 4-way concurrency — observed
// 2026-07-17: 408 pending, ceiling stuck at 4 for hours).
const DEFAULT_EXACT_REVIEW_PUBLICATION_RECOVERY_SUCCESSES = 10;
const EXACT_REVIEW_PUBLICATION_DEMAND_SAMPLE_MS = 5 * 60 * 1000;
const EXACT_REVIEW_PUBLICATION_SCALE_UP_MS = 10 * 60 * 1000;
const EXACT_REVIEW_PUBLICATION_SCALE_DOWN_MS = 15 * 60 * 1000;
const EXACT_REVIEW_PUBLICATION_ACTIONS_RESERVE = 16;
const DEFAULT_EXACT_REVIEW_DISPATCH_LEASE_MS = 6 * 60 * 1000;
// Exact publications have a dedicated bounded lane. Bound the unclaimed handoff so a run that
// never reaches its claim step is re-dispatched; stale runs lose the lease tuple safely.
const DEFAULT_EXACT_REVIEW_PUBLICATION_DISPATCH_LEASE_MS = 15 * 60 * 1000;
const DEFAULT_EXACT_REVIEW_EXECUTION_LEASE_MS = 130 * 60 * 1000;
const DEFAULT_EXACT_REVIEW_HEARTBEAT_GRACE_MS = 20 * 60 * 1000;
const DEFAULT_EXACT_REVIEW_RETRY_MS = 30_000;
const DEFAULT_EXACT_REVIEW_WORKFLOW_PAUSED_RETRY_MS = 60_000;
const DEFAULT_EXACT_REVIEW_DISPATCH_DEBOUNCE_MS = 45_000;
const DEFAULT_EXACT_REVIEW_DISPATCH_DEBOUNCE_MAX_MS = 3 * 60_000;
const DEFAULT_EXACT_REVIEW_PENDING_SOFT_LIMIT = 300;
const EXACT_REVIEW_COMPLETION_RETRY_MAX_MS = 2 * 60 * 60 * 1000;
const EXACT_REVIEW_ARTIFACT_RETRY_MAX_MS = 80 * 24 * 60 * 60 * 1000;
const EXACT_REVIEW_PUBLICATION_TRANSIENT_RETRY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const EXACT_REVIEW_PUBLICATION_UNKNOWN_RETRY_MAX_AGE_MS = 60 * 60 * 1000;
const EXACT_REVIEW_PUBLICATION_TRANSIENT_RETRY_LIMIT = 12;
const EXACT_REVIEW_PUBLICATION_PERMANENT_RETRY_LIMIT = 3;
const EXACT_REVIEW_PUBLICATION_UNKNOWN_RETRY_LIMIT = 5;
const EXACT_REVIEW_PUBLICATION_ARTIFACT_RETRY_LIMIT = 3;
const EXACT_REVIEW_RECONCILE_RUN_LIMIT = 128;
const EXACT_REVIEW_RECONCILE_CLAIM_MATCH_LIMIT = EXACT_REVIEW_RECONCILE_RUN_LIMIT * 2;
export const EXACT_REVIEW_RECONCILE_CONCURRENCY = 8;
const EXACT_REVIEW_RECONCILE_LIST_PAGE_LIMIT = 3;
// This is an idempotency policy, not a storage-size control. Receipts live in
// individual indexed SQLite rows and are pruned in bounded batches.
const EXACT_REVIEW_QUEUE_DELIVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EXACT_REVIEW_QUEUE_DELIVERY_PRUNE_BATCH = 1_000;
const EXACT_REVIEW_QUEUE_DELIVERY_PRUNE_MAX_BATCHES = 5;
const EXACT_REVIEW_QUEUE_SQL_BINDING_ROW_BATCH = 50;
const EXACT_REVIEW_QUEUE_STORAGE_SCHEMA_VERSION = 1;
const EXACT_REVIEW_QUEUE_LEGACY_ROLLBACK_MS = 24 * 60 * 60 * 1000;
const EXACT_REVIEW_QUEUE_LEGACY_SHADOW_MAX_BYTES = 1 * 1024 * 1024;
const EXACT_REVIEW_QUEUE_LEGACY_RECEIPT_ROW_LIMIT = 20_000;
const EXACT_REVIEW_QUEUE_LEGACY_RECEIPT_SHIFT_MS = 2 * 24 * 60 * 60 * 1000;
const EXACT_REVIEW_QUEUE_ROLLBACK_CLOCK_SKEW_MS = 5 * 60 * 1000;
const EXACT_REVIEW_QUEUE_LEGACY_GENERATION_PREFIX = "__clawsweeper_sql_generation:";
const EXACT_REVIEW_QUEUE_STATE_KEY = "exact-review-queue";
const EXACT_REVIEW_QUEUE_META_TABLE = "exact_review_queue_meta";
const EXACT_REVIEW_QUEUE_ITEM_TABLE = "exact_review_queue_items";
const EXACT_REVIEW_QUEUE_DELIVERY_TABLE = "exact_review_queue_deliveries";
const EXACT_REVIEW_QUEUE_METRICS_TABLE = "exact_review_queue_metrics";
const EXACT_REVIEW_QUEUE_METRIC_BUCKET_TABLE = "exact_review_queue_metric_buckets";
const EXACT_REVIEW_QUEUE_DEAD_LETTER_TABLE = "exact_review_queue_dead_letters";
const STATE_APPEND_WINDOW_TABLE = "state_append_window";
const STATE_APPEND_RECEIPT_TABLE = "state_append_receipts";
const STATE_APPEND_DRAIN_TABLE = "state_append_drains";
const STATE_APPEND_META_TABLE = "state_append_meta";
const STATE_APPEND_KINDS = new Set<StateAppendKind>([
  "sweep_status",
  "comment_router",
  "apply_proof",
]);
const DEFAULT_STATE_APPEND_MAX_PENDING_ROWS = 50_000;
const DEFAULT_STATE_APPEND_MAX_PENDING_BYTES = 100 * 1024 * 1024;
const DEFAULT_STATE_APPEND_MAX_RECORD_BYTES = 256 * 1024;
// Must outlast a worst-case materializer publish (observed 17 min under
// residual lease contention during the #738 transition).
const DEFAULT_STATE_APPEND_DRAIN_LEASE_MS = 30 * 60 * 1000;
const EXACT_REVIEW_REVIEW_TELEMETRY_TABLE = "exact_review_review_telemetry";
const EXACT_REVIEW_RUN_TELEMETRY_TABLE = "exact_review_run_telemetry";
const EXACT_REVIEW_STATE_WRITER_OPERATION_TABLE = "exact_review_state_writer_operations";
const EXACT_REVIEW_STATE_WRITER_LIVE_TABLE = "exact_review_state_writer_live";
const EXACT_REVIEW_STATE_WRITER_DIAGNOSTICS_TABLE = "exact_review_state_writer_diagnostics";
const EXACT_REVIEW_STATE_WRITER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const EXACT_REVIEW_STATE_WRITER_LIVE_MS = 90 * 1000;
const REVIEW_OBSERVABILITY_SCAN_LIMIT = 10_000;
const EXACT_REVIEW_QUEUE_DEAD_LETTER_LIMIT = 5_000;
const EXACT_REVIEW_QUEUE_DEAD_LETTER_RESOLVED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const EXACT_REVIEW_QUEUE_METRIC_BUCKET_MS = 5 * 60 * 1000;
const EXACT_REVIEW_QUEUE_METRIC_BUCKET_TTL_MS = 48 * 60 * 60 * 1000;
const EXACT_REVIEW_PUBLICATION_CONTROL_KEY = "exact-review-publication-control:v1";
export const EXACT_REVIEW_QUEUE_NAME = "global";
const EXACT_REVIEW_COMMAND_STATUS_MARKER_PATTERN =
  /^<!-- clawsweeper-command-status:[^<>\r\n]{1,200} -->$/;
const EXACT_REVIEW_ADDITIONAL_PROMPT_MAX_CHARS = 5000;
const DEFAULT_EXACT_REVIEW_PUBLICATION_BATCH_SIZE = 8;
const MAX_EXACT_REVIEW_PUBLICATION_BATCH_SIZE = 32;
const DEFAULT_EXACT_REVIEW_PUBLICATION_BATCH_LEASE_MS = 30 * 60 * 1000;
const DEFAULT_EXACT_REVIEW_PUBLICATION_BATCH_WAIT_MS = 60_000;
const DEFAULT_EXACT_REVIEW_PUBLICATION_BATCH_DISPATCH_COOLDOWN_MS = 30_000;
const DEFAULT_EXACT_REVIEW_PUBLICATION_BATCH_DISPATCH_RESERVATION_MS = 10 * 60_000;

export class ExactReviewQueue {
  private storage;
  private env;
  private ready: Promise<void>;
  private migratedAt = 0;
  private legacyMirrorDisabled = false;
  private legacyMirrorWarningReported = false;
  private batchStore;
  private readonly baselines = new WeakMap<ExactReviewQueueState, ExactReviewQueueBaseline>();

  constructor(state, env) {
    this.storage = state.storage;
    this.env = env;
    this.batchStore = new ExactReviewPublicationBatchStore(this.storage);
    const initialize = () => this.initializeStorage();
    this.ready =
      typeof state.blockConcurrencyWhile === "function"
        ? Promise.resolve(state.blockConcurrencyWhile(initialize))
        : initialize();
  }

  async fetch(request: Request) {
    await this.ready;
    this.cleanupLegacyCompatibilitySync();
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/state/append") {
      const body = objectValue(await request.json().catch(() => null));
      const deliveryId = String(body.delivery_id || "").trim();
      if (!deliveryId) return json({ error: "missing_delivery_id" }, 400);
      const normalized = stateAppendRecords(body.records, stateAppendMaxRecordBytes(this.env));
      if (!normalized.ok) return json({ error: normalized.error }, 400);

      const now = Date.now();
      const appended = this.storage.transactionSync(() => {
        this.pruneStateAppendReceiptsSync(now);
        this.storage.sql.exec(
          `DELETE FROM ${STATE_APPEND_RECEIPT_TABLE}
            WHERE delivery_id = ? AND received_at <= ?`,
          deliveryId,
          now - EXACT_REVIEW_QUEUE_DELIVERY_TTL_MS,
        );
        const existingReceipt = Array.from(
          this.storage.sql.exec(
            `SELECT delivery_id FROM ${STATE_APPEND_RECEIPT_TABLE} WHERE delivery_id = ?`,
            deliveryId,
          ),
        ).length;
        if (existingReceipt) return { kind: "deduped" as const };

        const window = this.stateAppendWindowTotalsSync();
        const appendedBytes = normalized.records.reduce(
          (sum, record) => sum + record.payloadBytes,
          0,
        );
        if (
          window.pendingRows + normalized.records.length > stateAppendMaxPendingRows(this.env) ||
          window.pendingBytes + appendedBytes > stateAppendMaxPendingBytes(this.env)
        ) {
          this.storage.sql.exec(
            `UPDATE ${STATE_APPEND_META_TABLE}
                SET shed_since_reset = shed_since_reset + 1
              WHERE singleton_id = 1`,
          );
          return { kind: "shed" as const };
        }

        this.storage.sql.exec(
          `INSERT INTO ${STATE_APPEND_RECEIPT_TABLE} (delivery_id, received_at) VALUES (?, ?)`,
          deliveryId,
          now,
        );
        let firstSeq: number | null = null;
        let lastSeq: number | null = null;
        for (const record of normalized.records) {
          const inserted = Array.from(
            this.storage.sql.exec(
              `INSERT INTO ${STATE_APPEND_WINDOW_TABLE}
                 (kind, record_key, payload_json, payload_bytes, produced_at, delivery_id)
               VALUES (?, ?, ?, ?, ?, ?)
               RETURNING seq`,
              record.kind,
              record.key,
              record.payloadJson,
              record.payloadBytes,
              record.producedAt,
              deliveryId,
            ) as Iterable<{ seq: number }>,
          )[0];
          const seq = Number(inserted?.seq);
          if (!Number.isSafeInteger(seq) || seq < 1) {
            throw new Error("state append failed to allocate a sequence");
          }
          if (firstSeq === null) firstSeq = seq;
          lastSeq = seq;
        }
        return {
          kind: "appended" as const,
          appended: normalized.records.length,
          firstSeq,
          lastSeq,
        };
      });
      if (appended.kind === "deduped") return json({ ok: true, deduped: true }, 202);
      if (appended.kind === "shed") {
        return json({ ok: false, shed: true, reason: "capacity" }, 429);
      }
      return json(
        {
          ok: true,
          appended: appended.appended,
          first_seq: appended.firstSeq,
          last_seq: appended.lastSeq,
        },
        202,
      );
    }

    if (request.method === "POST" && url.pathname === "/state/drain") {
      const body = objectValue(await request.json().catch(() => null));
      const maxRows = stateAppendDrainLimit(body.max_rows);
      const maxBytes = stateAppendDrainLimit(body.max_bytes);
      if (maxRows === null || maxBytes === null) {
        return json({ error: "invalid_drain_limits" }, 400);
      }
      const drain = this.storage.transactionSync(() =>
        this.drainStateAppendWindowSync(
          Math.min(maxRows, stateAppendMaxPendingRows(this.env)),
          Math.min(maxBytes, stateAppendMaxPendingBytes(this.env)),
          Date.now(),
        ),
      );
      return json({
        ok: true,
        drain_token: drain.token,
        lease_expires_at: drain.expiresAt === null ? null : new Date(drain.expiresAt).toISOString(),
        records: drain.rows.map(stateAppendWindowRowJson),
      });
    }

    if (request.method === "POST" && url.pathname === "/state/ack") {
      const body = objectValue(await request.json().catch(() => null));
      const drainToken = String(body.drain_token || "").trim();
      if (!drainToken) return json({ error: "missing_drain_token" }, 400);
      const acked = this.storage.transactionSync(() => {
        const now = Date.now();
        this.reclaimExpiredStateAppendDrainsSync(now);
        const active = Array.from(
          this.storage.sql.exec(
            `SELECT drain_token FROM ${STATE_APPEND_DRAIN_TABLE} WHERE drain_token = ?`,
            drainToken,
          ),
        ).length;
        if (!active) return 0;
        const deleted = Array.from(
          this.storage.sql.exec(
            `DELETE FROM ${STATE_APPEND_WINDOW_TABLE}
              WHERE drain_token = ?
            RETURNING seq`,
            drainToken,
          ),
        ).length;
        this.storage.sql.exec(
          `DELETE FROM ${STATE_APPEND_DRAIN_TABLE} WHERE drain_token = ?`,
          drainToken,
        );
        return deleted;
      });
      return json({ ok: true, acked });
    }

    if (request.method === "POST" && url.pathname === "/enqueue") {
      const body = objectValue(await request.json().catch(() => null));
      const deliveryId = String(body.delivery_id || "").trim();
      const decision = exactReviewDecisionFrom(body.decision);
      if (!deliveryId) return json({ error: "missing_delivery_id" }, 400);
      if (deliveryId.startsWith(EXACT_REVIEW_QUEUE_LEGACY_GENERATION_PREFIX)) {
        return json({ error: "reserved_delivery_id" }, 400);
      }
      if (!decision) return json({ error: "invalid_exact_review_item" }, 400);
      if (!isExactReviewQueueTargetEnabled(decision, this.env)) {
        return json({ ok: true, accepted: false, reason: "target not enabled" }, 202);
      }

      const now = Date.now();
      const accepted = this.storage.transactionSync(() => {
        this.pruneDeliveryReceiptsSync(now);
        this.storage.sql.exec(
          `DELETE FROM ${EXACT_REVIEW_QUEUE_DELIVERY_TABLE}
            WHERE delivery_id = ? AND received_at <= ?`,
          deliveryId,
          now - EXACT_REVIEW_QUEUE_DELIVERY_TTL_MS,
        );
        const insertedReceipts = Array.from(
          this.storage.sql.exec(
            `INSERT OR IGNORE INTO ${EXACT_REVIEW_QUEUE_DELIVERY_TABLE}
             (delivery_id, received_at) VALUES (?, ?)
           RETURNING delivery_id`,
            deliveryId,
            now,
          ),
        );
        if (insertedReceipts.length !== 1) {
          this.syncLegacyCompatibilitySync(this.readStateSync());
          return { deduped: true as const };
        }

        const state = this.readStateSync();
        // A delayed or lost alarm must not let an expired one-shot recovery
        // suppress the next failed shard's recovery delivery.
        reclaimExpiredExactReviewLeases(
          state,
          now,
          exactReviewPublicationDispatchLeaseMs(this.env),
          exactReviewHeartbeatGraceMs(this.env),
        );
        const key = exactReviewItemKey(decision);
        const current = state.items[key];
        if (current) {
          const ignoredRecovery =
            decision.sourceAction === FAILED_REVIEW_SHARD_RECOVERY_SOURCE_ACTION;
          // A recovery is only a one-shot repair of a failed shard. It may create a queue item,
          // but must never supersede an existing pending, dispatching, or leased decision: doing
          // so can leave either ordinary work or another recovery as a stale follow-up revision.
          // Ordinary source events retain normal replacement behavior, including the
          // command-context merge for pending items.
          if (!ignoredRecovery) {
            const mergeable = current.state === "pending" || current.state === "parked";
            current.decision = mergeable
              ? mergePendingExactReviewDecision(current.decision, decision)
              : decision;
            current.revision += 1;
            current.updatedAt = now;
            // Immediacy must come from the merged decision: a pending explicit command
            // keeps its command marker through the merge, and a later plain webhook
            // event must not re-debounce it.
            current.nextAttemptAt = mergeable
              ? exactReviewQueueDebouncedAttemptAt(
                  state,
                  current.decision,
                  now,
                  current.createdAt,
                  this.env,
                )
              : exactReviewQueueEnqueueAttemptAt(state, now);
            if (mergeable) {
              current.state = "pending";
              current.parkedReason = undefined;
              current.attempts = 0;
              current.publicationFailureAttempts = 0;
              current.firstFailureAt = undefined;
              current.lastFailureReason = undefined;
            }
          }
        } else {
          if (
            isLowPriorityExactReviewDecision(decision) &&
            exactReviewQueuePendingCount(state) >= exactReviewPendingSoftLimit(this.env)
          ) {
            state.shedSinceReset = exactReviewShedSinceReset(state) + 1;
            this.writeStateSync(state);
            this.incrementQueueMetricsSync({ reviewShed: 1 });
            return { shed: true as const };
          }
          state.items[key] = {
            key,
            decision,
            state: "pending",
            revision: 1,
            createdAt: now,
            updatedAt: now,
            nextAttemptAt: exactReviewQueueDebouncedAttemptAt(state, decision, now, now, this.env),
            attempts: 0,
          };
        }
        this.writeStateSync(state);
        return { deduped: false as const, key, state };
      });
      if (accepted.deduped) {
        return json({ ok: true, deduped: true, item_key: exactReviewItemKey(decision) }, 202);
      }
      if (accepted.shed) {
        return json({ ok: true, shed: true, reason: "backpressure" }, 202);
      }
      await this.scheduleNext(accepted.state, now);
      return json({ ok: true, queued: true, item_key: accepted.key }, 202);
    }

    if (request.method === "POST" && url.pathname === "/claim") {
      const body = objectValue(await request.json().catch(() => null));
      const leaseId = String(body.lease_id || "").trim();
      const itemKey = String(body.item_key || "").trim();
      const leaseRevision = Number(body.lease_revision);
      const runId = String(body.run_id || "").trim();
      if (!leaseId || !runId) return json({ error: "missing_lease_or_run" }, 400);
      if (!/^\d+$/.test(runId)) return json({ error: "invalid_run_id" }, 400);
      const tupleClaim = Boolean(itemKey) || body.lease_revision !== undefined;
      if (tupleClaim && (!itemKey || !Number.isInteger(leaseRevision) || leaseRevision < 1)) {
        return json({ error: "invalid_lease_revision" }, 400);
      }
      const claimProtocolVersion: 1 | 2 = tupleClaim ? 2 : 1;
      const runAttempt = exactReviewRunAttempt(body.run_attempt);
      if (body.run_attempt !== undefined && runAttempt === null) {
        return json({ error: "invalid_run_attempt" }, 400);
      }

      const now = Date.now();
      const state = this.readStateSync();
      const item = tupleClaim ? state.items[itemKey] : exactReviewItemForLease(state, leaseId);
      if (
        item &&
        reclaimExpiredExactReviewLease(
          state,
          item.key,
          item,
          now,
          exactReviewPublicationDispatchLeaseMs(this.env),
          exactReviewHeartbeatGraceMs(this.env),
        )
      ) {
        this.writeStateSync(state);
        await this.scheduleNext(state, now);
        return json({ error: "lease_not_active" }, 409);
      }
      if (
        !item ||
        item.leaseId !== leaseId ||
        (tupleClaim && item.leaseRevision !== leaseRevision) ||
        !isLiveExactReviewLease(
          item,
          now,
          exactReviewPublicationDispatchLeaseMs(this.env),
          exactReviewHeartbeatGraceMs(this.env),
        )
      ) {
        return json({ error: "lease_not_active" }, 409);
      }
      if (item.claimedRunId && item.claimedRunId !== runId) {
        return json({ error: "lease_already_claimed" }, 409);
      }

      // Deploys can observe a pre-snapshot lease. Recover it only when no newer
      // enqueue has replaced the decision that was dispatched for this revision.
      if (!item.leaseDecision) {
        if (item.revision !== item.leaseRevision) {
          return json({ error: "lease_decision_unavailable" }, 409);
        }
        item.leaseDecision = { ...item.decision };
      }

      const claimedRunAttempt = item.claimedRunAttempt;
      if (item.claimedRunId && claimedRunAttempt !== undefined) {
        if (runAttempt === null) return json({ error: "missing_run_attempt" }, 409);
        if (runAttempt < claimedRunAttempt) {
          return json({ error: "stale_run_attempt" }, 409);
        }
        if (runAttempt === claimedRunAttempt) {
          if (
            item.claimProtocolVersion !== undefined &&
            item.claimProtocolVersion !== claimProtocolVersion
          ) {
            return json({ error: "claim_protocol_mismatch" }, 409);
          }
          const claimGeneration = Math.max(1, exactReviewClaimGeneration(item.claimGeneration));
          item.claimGeneration = claimGeneration;
          item.claimProtocolVersion = claimProtocolVersion;
          item.leaseExpiresAt = now + exactReviewExecutionLeaseMs(this.env);
          item.updatedAt = now;
          await this.writeState(state);
          await this.scheduleNext(state, now);
          return json(exactReviewClaimResponse(item, claimProtocolVersion, claimGeneration));
        }
      } else if (item.claimedRunId && runAttempt === null) {
        if (
          item.claimProtocolVersion !== undefined &&
          item.claimProtocolVersion !== claimProtocolVersion
        ) {
          return json({ error: "claim_protocol_mismatch" }, 409);
        }
        const claimGeneration = Math.max(1, exactReviewClaimGeneration(item.claimGeneration));
        if (
          item.claimGeneration !== claimGeneration ||
          item.claimProtocolVersion !== claimProtocolVersion
        ) {
          item.claimGeneration = claimGeneration;
          item.claimProtocolVersion = claimProtocolVersion;
          await this.writeState(state);
        }
        return json(exactReviewClaimResponse(item, claimProtocolVersion, claimGeneration));
      }

      item.state = "leased";
      item.claimedRunId = runId;
      item.claimedRunAttempt = runAttempt ?? undefined;
      item.claimGeneration = exactReviewClaimGeneration(item.claimGeneration) + 1;
      item.claimProtocolVersion = claimProtocolVersion;
      item.leaseExpiresAt = now + exactReviewExecutionLeaseMs(this.env);
      item.leaseHeartbeatAt = undefined;
      item.claimedAt = now;
      item.updatedAt = now;
      await this.writeState(state);
      await this.scheduleNext(state, now);
      return json(exactReviewClaimResponse(item, claimProtocolVersion, item.claimGeneration));
    }

    if (request.method === "POST" && url.pathname === "/heartbeat") {
      const body = objectValue(await request.json().catch(() => null));
      const itemKey = String(body.item_key || "").trim();
      const leaseId = String(body.lease_id || "").trim();
      const leaseRevision = Number(body.lease_revision);
      const runId = String(body.run_id || "").trim();
      if (!itemKey || !leaseId || !runId) return json({ error: "missing_lease_tuple" }, 400);
      if (!Number.isInteger(leaseRevision) || leaseRevision < 1) {
        return json({ error: "invalid_lease_revision" }, 400);
      }
      if (!/^\d+$/.test(runId)) return json({ error: "invalid_run_id" }, 400);

      const now = Date.now();
      const state = this.readStateSync();
      const item = state.items[itemKey];
      if (
        item &&
        reclaimExpiredExactReviewLease(
          state,
          itemKey,
          item,
          now,
          exactReviewPublicationDispatchLeaseMs(this.env),
          exactReviewHeartbeatGraceMs(this.env),
        )
      ) {
        await this.writeState(state);
        await this.scheduleNext(state, now);
        return json({ error: "lease_not_active" }, 409);
      }
      if (
        !item ||
        item.state !== "leased" ||
        item.leaseId !== leaseId ||
        item.leaseRevision !== leaseRevision ||
        item.claimedRunId !== runId ||
        !isLiveExactReviewLease(
          item,
          now,
          exactReviewPublicationDispatchLeaseMs(this.env),
          exactReviewHeartbeatGraceMs(this.env),
        )
      ) {
        return json({ error: "lease_not_active" }, 409);
      }
      item.leaseHeartbeatAt = now;
      item.updatedAt = now;
      await this.writeState(state);
      await this.scheduleNext(state, now);
      return json({ ok: true, lease_heartbeat_at: new Date(now).toISOString() });
    }

    if (request.method === "POST" && url.pathname === "/complete") {
      const body = objectValue(await request.json().catch(() => null));
      const stateWriter =
        body.state_writer === undefined
          ? undefined
          : normalizeStateWriterOperation(body.state_writer);
      const leaseId = String(body.lease_id || "").trim();
      const itemKey = String(body.item_key || "").trim();
      const leaseRevision = Number(body.lease_revision);
      const claimGeneration = Number(body.claim_generation);
      const runId = String(body.run_id || "").trim();
      if (!leaseId || !runId) return json({ error: "missing_lease_or_run" }, 400);
      if (!/^\d+$/.test(runId)) return json({ error: "invalid_run_id" }, 400);
      const tupleCompletion =
        Boolean(itemKey) ||
        body.lease_revision !== undefined ||
        body.claim_generation !== undefined;
      if (tupleCompletion) {
        if (!itemKey || !Number.isInteger(leaseRevision) || leaseRevision < 1) {
          return json({ error: "invalid_lease_revision" }, 400);
        }
        if (!Number.isInteger(claimGeneration) || claimGeneration < 1) {
          return json({ error: "invalid_claim_generation" }, 400);
        }
      }
      const completionProtocolVersion: 1 | 2 = tupleCompletion ? 2 : 1;
      const runAttempt = exactReviewRunAttempt(body.run_attempt);
      if (body.run_attempt !== undefined && runAttempt === null) {
        return json({ error: "invalid_run_attempt" }, 400);
      }
      const outcome = exactReviewCompletionOutcome(body.outcome, "success");
      if (!outcome) return json({ error: "invalid_outcome" }, 400);
      const failureKind =
        body.failure_kind === undefined
          ? undefined
          : exactReviewPublicationFailureKind(body.failure_kind);
      if (body.failure_kind !== undefined && !failureKind) {
        return json({ error: "invalid_failure_kind" }, 400);
      }
      if (failureKind && outcome !== "failure") {
        return json({ error: "failure_kind_without_failure" }, 400);
      }
      const hasStructuredCompletion =
        body.completion_kind !== undefined ||
        body.reason_code !== undefined ||
        body.error_fingerprint !== undefined;
      const publicationCompletion = hasStructuredCompletion
        ? exactReviewPublicationCompletion(
            body.completion_kind,
            body.reason_code,
            body.error_fingerprint,
          )
        : undefined;
      if (hasStructuredCompletion && !publicationCompletion) {
        return json({ error: "invalid_publication_completion" }, 400);
      }
      const completionSucceeds =
        publicationCompletion &&
        (publicationCompletion.kind === "published" ||
          publicationCompletion.kind === "superseded" ||
          publicationCompletion.kind === "refresh_required" ||
          publicationCompletion.kind === "deferred" ||
          (publicationCompletion.kind === "retryable_failure" &&
            publicationCompletion.reasonCode === "review_lease_active"));
      if (publicationCompletion && completionSucceeds !== (outcome === "success")) {
        return json({ error: "completion_outcome_mismatch" }, 400);
      }
      if (
        failureKind &&
        publicationCompletion &&
        (publicationCompletion.kind !== "retryable_failure" ||
          publicationCompletion.reasonCode !== failureKind)
      ) {
        return json({ error: "failure_kind_mismatch" }, 400);
      }
      const requeueLatest = body.requeue_latest === true;
      if (body.requeue_latest !== undefined && typeof body.requeue_latest !== "boolean") {
        return json({ error: "invalid_requeue_latest" }, 400);
      }
      if (requeueLatest && outcome !== "success") {
        return json({ error: "invalid_requeue_latest_outcome" }, 400);
      }

      const now = Date.now();
      const requestedRetryAt = exactReviewCompletionRetryAt(body.retry_at, now);
      if (body.retry_at !== undefined && requestedRetryAt === null) {
        return json({ error: "invalid_retry_at" }, 400);
      }
      const state = this.readStateSync();
      const item = tupleCompletion ? state.items[itemKey] : exactReviewItemForLease(state, leaseId);
      if (
        !item ||
        item.leaseId !== leaseId ||
        (tupleCompletion && item.leaseRevision !== leaseRevision) ||
        (tupleCompletion && exactReviewClaimGeneration(item.claimGeneration) !== claimGeneration) ||
        item.claimedRunId !== runId
      ) {
        return json({ error: "lease_not_claimed" }, 409);
      }
      if ((item.claimProtocolVersion ?? 1) !== completionProtocolVersion) {
        return json({ error: "lease_protocol_not_claimed" }, 409);
      }
      const publicationItem = exactReviewQueueIsPublication(item);
      // Optional observability cannot alter a valid publication completion.
      // Accept writer telemetry only from currently claimed publication items.
      if (publicationItem) {
        this.recordStateWriterOperationSafely(
          body.state_writer === undefined ? undefined : stateWriter,
          body.state_writer !== undefined && !stateWriter,
          now,
        );
      } else if (body.state_writer !== undefined) {
        this.incrementStateWriterDiagnosticSafely("rejected_terminal_total");
      }
      if (failureKind && !publicationItem) {
        return json({ error: "failure_kind_outside_publication" }, 400);
      }
      if (publicationCompletion && !publicationItem) {
        return json({ error: "completion_kind_outside_publication" }, 400);
      }
      const publicationControl = this.publicationControlSync();
      const publicationDesiredCapacity = publicationItem
        ? exactReviewPublicationCapacityForState(
            this.env,
            state,
            now,
            publicationControl.capacityCeiling,
            false,
            publicationControl.demandCapacity,
          )
        : 0;
      if (
        item.claimedRunAttempt !== undefined &&
        (runAttempt === null || runAttempt !== item.claimedRunAttempt)
      ) {
        return json({ error: "lease_attempt_not_claimed" }, 409);
      }

      // The workflow reports success only after every primary review mutation has settled.
      // Complete that revision now so a later auxiliary-step failure cannot make the
      // workflow_run reconciler requeue review work that already succeeded.
      const completionResult =
        publicationItem && publicationCompletion
          ? finishExactReviewPublicationQueueItem({
              state,
              item,
              now,
              completion: publicationCompletion,
              requestedRetryAt: requestedRetryAt ?? undefined,
              requeueLatest,
              deadLetterCapacityAvailable: this.deadLetterCapacityAvailableSync(
                exactReviewDeadLetterId(item),
              ),
              env: this.env,
            })
          : {
              requeued: finishExactReviewQueueItem(
                state,
                item,
                now,
                outcome,
                requestedRetryAt ?? undefined,
                requeueLatest,
              ),
              retried: outcome !== "success",
              refreshed: false,
              parked: false,
              deadLetter: undefined,
            };
      const { requeued } = completionResult;
      // A successful workflow can still request requeue_latest after source
      // drift. That work did not leave its lane, so it must not improve the
      // operator-facing net speed until a later revision actually completes.
      const completedLane =
        !requeued && !completionResult.parked ? exactReviewQueueLane(item) : null;
      const structuredTerminal = publicationCompletion && !requeued && !completionResult.parked;
      await this.writeState(
        state,
        {
          ...(completedLane === "review" && outcome === "success" ? { reviewCompleted: 1 } : {}),
          ...(!publicationItem && outcome !== "success" && requeued ? { reviewRetried: 1 } : {}),
          ...(completedLane === "publication" ? { publicationCompleted: 1 } : {}),
          ...(structuredTerminal && publicationCompletion.kind === "published"
            ? { publicationPublished: 1 }
            : {}),
          ...(structuredTerminal && publicationCompletion.kind === "superseded"
            ? { publicationSuperseded: 1 }
            : {}),
          ...(publicationItem && completionResult.retried ? { publicationRetried: 1 } : {}),
          ...(completionResult.deadLetter ? { publicationDeadLettered: 1 } : {}),
          ...(completionResult.refreshed ? { publicationRefreshed: 1 } : {}),
        },
        publicationItem &&
          ((publicationCompletion
            ? publicationCompletion.kind === "published" && !requeued
            : outcome === "success" && !requeued) ||
            failureKind)
          ? {
              at: now,
              capacity: publicationDesiredCapacity,
              outcome:
                (publicationCompletion
                  ? publicationCompletion.kind === "published"
                  : outcome === "success") && !requeued
                  ? "success"
                  : "failure",
              ...(failureKind ? { failureKind } : {}),
            }
          : undefined,
        completionResult.deadLetter,
      );
      await this.scheduleNext(state, now);
      return json({ ok: true, requeued });
    }

    if (request.method === "POST" && url.pathname === "/state-writer-progress") {
      const body = objectValue(await request.json().catch(() => null));
      const progress = normalizeStateWriterProgress(body);
      const itemKey = String(body.item_key || "").trim();
      const leaseId = String(body.lease_id || "").trim();
      const leaseRevision = Number(body.lease_revision);
      const claimGeneration = Number(body.claim_generation);
      const runId = String(body.run_id || "").trim();
      const runAttempt = exactReviewRunAttempt(body.run_attempt);
      const now = Date.now();
      const item = this.readStateSync().items[itemKey];
      const valid =
        progress &&
        item &&
        exactReviewQueueIsPublication(item) &&
        item.state === "leased" &&
        item.leaseId === leaseId &&
        item.leaseRevision === leaseRevision &&
        exactReviewClaimGeneration(item.claimGeneration) === claimGeneration &&
        item.claimedRunId === runId &&
        (item.claimedRunAttempt ?? null) === runAttempt &&
        isLiveExactReviewLease(
          item,
          now,
          exactReviewPublicationDispatchLeaseMs(this.env),
          exactReviewHeartbeatGraceMs(this.env),
        );
      if (!valid) {
        this.incrementStateWriterDiagnosticSafely("rejected_progress_total");
        return json({ ok: false, accepted: false }, 202);
      }
      this.recordStateWriterProgressSafely(progress, now);
      return json({ ok: true, accepted: true }, 202);
    }

    if (request.method === "POST" && url.pathname === "/claimed-runs") {
      const body = objectValue(await request.json().catch(() => null));
      const includeAllClaimed = body.include_all_claimed === true;
      const requestedRuns =
        includeAllClaimed && Array.isArray(body.runs) && body.runs.length === 0
          ? []
          : exactReviewRequestedRuns(body.runs);
      if (!requestedRuns) return json({ error: "invalid_requested_runs" }, 400);
      if (body.include_all_claimed !== undefined && typeof body.include_all_claimed !== "boolean") {
        return json({ error: "invalid_include_all_claimed" }, 400);
      }

      // A coalesced workflow_run backstop can scan every live claim. Keep two matches per run
      // so corrupt duplicates remain ambiguous, and bound the snapshot to the global worker
      // budget so one reconciliation never becomes an unbounded GitHub API fan-out.
      const requestedRunIds = new Set(requestedRuns.map((run) => run.runId));
      const matchesByRunId = new Map<string, ExactReviewQueueItem[]>();
      const state = this.readStateSync();
      for (const item of Object.values(state.items)) {
        if (
          item.state !== "leased" ||
          !item.claimedRunId ||
          (!includeAllClaimed && !requestedRunIds.has(item.claimedRunId))
        ) {
          continue;
        }
        const matches = matchesByRunId.get(item.claimedRunId) || [];
        if (matches.length < 2) matches.push(item);
        matchesByRunId.set(item.claimedRunId, matches);
      }
      const runs = [...matchesByRunId.values()]
        .flatMap((matches) =>
          matches.map((item) => ({
            run_id: String(item.claimedRunId),
            run_attempt: item.claimedRunAttempt ?? null,
            claim_generation: exactReviewClaimGeneration(item.claimGeneration),
          })),
        )
        .slice(0, EXACT_REVIEW_RECONCILE_RUN_LIMIT);
      return json({ runs });
    }

    if (request.method === "POST" && url.pathname === "/dead-letters/list") {
      return this.listDeadLetters(await request.json().catch(() => null));
    }

    if (request.method === "POST" && url.pathname === "/dead-letters/replay") {
      return this.replayDeadLetters(await request.json().catch(() => null));
    }

    if (request.method === "POST" && url.pathname === "/dead-letters/recover-fresh") {
      return this.recoverDeadLettersFresh(await request.json().catch(() => null));
    }

    if (request.method === "POST" && url.pathname === "/dead-letters/resolve") {
      return this.resolveDeadLetters(await request.json().catch(() => null));
    }

    if (request.method === "POST" && url.pathname === "/publications/list") {
      return this.listPublicationCandidates(await request.json().catch(() => null));
    }

    if (request.method === "POST" && url.pathname === "/publications/supersede") {
      return this.supersedePublicationCandidates(await request.json().catch(() => null));
    }

    if (request.method === "POST" && url.pathname === "/review-telemetry") {
      return this.recordReviewTelemetry(await request.json().catch(() => null));
    }

    if (request.method === "POST" && url.pathname === "/review-run-telemetry") {
      return this.recordReviewRunTelemetry(await request.json().catch(() => null));
    }

    if (request.method === "GET" && url.pathname === "/review-telemetry") {
      return this.listReviewTelemetry(url.searchParams);
    }

    if (request.method === "GET" && url.pathname === "/review-observability") {
      return this.reviewObservability(url.searchParams);
    }

    if (request.method === "POST" && url.pathname === "/publication-batches/claim") {
      return this.claimPublicationBatch(await request.json().catch(() => null));
    }

    if (request.method === "POST" && url.pathname === "/publication-batches/fetch") {
      return this.fetchPublicationBatch(await request.json().catch(() => null));
    }

    if (request.method === "POST" && url.pathname === "/publication-batches/heartbeat") {
      return this.heartbeatPublicationBatch(await request.json().catch(() => null));
    }

    if (request.method === "POST" && url.pathname === "/publication-batches/complete") {
      return this.completePublicationBatch(await request.json().catch(() => null));
    }

    if (request.method === "GET" && url.pathname === "/item-status") {
      const targetRepo = String(url.searchParams.get("target_repo") || "").trim();
      const itemNumber = Number(url.searchParams.get("item_number"));
      if (
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(targetRepo) ||
        !Number.isInteger(itemNumber) ||
        itemNumber < 1
      ) {
        return json({ error: "invalid_item_identity" }, 400);
      }
      const state = this.readStateSync();
      const matches = Object.values(state.items).filter(
        (item) =>
          item.decision.targetRepo === targetRepo && item.decision.itemNumber === itemNumber,
      );
      const items = matches.map((item) => ({
        lane: exactReviewQueueLane(item),
        state: item.state,
        revision: item.revision,
        attempts: item.attempts,
        created_at: new Date(item.createdAt).toISOString(),
        next_attempt_at:
          item.state === "pending" ? new Date(item.nextAttemptAt).toISOString() : null,
        older_ready_count: Object.values(state.items).filter(
          (candidate) =>
            exactReviewQueueLane(candidate) === exactReviewQueueLane(item) &&
            candidate.state === "pending" &&
            candidate.nextAttemptAt <= Date.now() &&
            (candidate.createdAt < item.createdAt ||
              (candidate.createdAt === item.createdAt && candidate.key < item.key)),
        ).length,
      }));
      const deadLetters = Array.from(
        this.storage.sql.exec(
          `SELECT reason_code, first_failed_at, last_failed_at
             FROM ${EXACT_REVIEW_QUEUE_DEAD_LETTER_TABLE}
            WHERE target_repo = ? AND item_number = ? AND status = 'open'
            ORDER BY last_failed_at DESC`,
          targetRepo,
          itemNumber,
        ),
      );
      return json({
        ok: true,
        target_repo: targetRepo,
        item_number: itemNumber,
        items,
        dead_letters: deadLetters,
        position_is_approximate: true,
      });
    }

    if (request.method === "POST" && url.pathname === "/reconcile") {
      const body = objectValue(await request.json().catch(() => null));
      const runs = exactReviewTerminalRuns(body.runs);
      if (!runs) return json({ error: "invalid_terminal_runs" }, 400);

      const now = Date.now();
      const state = this.readStateSync();
      let reconciled = 0;
      let requeued = 0;
      let completed = 0;
      let completedReviews = 0;
      let retriedReviews = 0;
      let completedPublications = 0;
      for (const run of runs) {
        const matches = Object.values(state.items).filter(
          (item) =>
            item.state === "leased" &&
            item.claimedRunId === run.runId &&
            exactReviewClaimGeneration(item.claimGeneration) === run.claimGeneration &&
            (item.claimedRunAttempt ?? null) === (run.claimedRunAttempt ?? null),
        );
        if (matches.length !== 1) continue;
        const item = matches[0];
        const didRequeue = finishExactReviewQueueItem(state, item, now, run.outcome);
        reconciled += 1;
        if (didRequeue) {
          requeued += 1;
          if (!exactReviewQueueIsPublication(item) && run.outcome !== "success") {
            retriedReviews += 1;
          }
        } else {
          completed += 1;
          if (run.outcome === "success") {
            if (exactReviewQueueIsPublication(item)) completedPublications += 1;
            else completedReviews += 1;
          }
        }
      }
      if (reconciled) {
        await this.writeState(state, {
          reviewCompleted: completedReviews,
          reviewRetried: retriedReviews,
          publicationCompleted: completedPublications,
        });
        await this.scheduleNext(state, now);
      }
      return json({ ok: true, reconciled, requeued, completed });
    }

    if (request.method === "GET" && url.pathname === "/stats") {
      const bayPriorityKeys = exactReviewQueueBayPriorityKeys(
        url.searchParams.getAll("bay_priority_key"),
      );
      const now = Date.now();
      const snapshot = this.storage.transactionSync(() => {
        this.pruneDeliveryReceiptsSync(now);
        this.pruneStateAppendReceiptsSync(now);
        this.reclaimExpiredStateAppendDrainsSync(now);
        this.pruneQueueTelemetrySync(now);
        this.pruneReviewTelemetrySync(now);
        this.reconcileStoredReviewRunsSync(now);
        const current = this.readStateSync();
        // Dashboard reads are also the operational heartbeat. Reclaim leases and
        // restore the alarm here so a deploy or lost alarm cannot strand backlog.
        const changed = reclaimExpiredExactReviewLeases(
          current,
          now,
          exactReviewPublicationDispatchLeaseMs(this.env),
          exactReviewHeartbeatGraceMs(this.env),
        );
        if (changed) this.writeStateSync(current);
        else this.syncLegacyCompatibilitySync(current);
        return {
          state: current,
          metrics: this.queueMetricTotalsSync(),
          reviewFlow: this.reviewFlowSummarySync(now),
          publicationFlow: this.publicationFlowSummarySync(now),
          deadLetters: this.deadLetterStatsSync(),
          reviewTelemetryHealth: this.reviewTelemetryHealthSync(now),
          reviewExecutionHealth: this.reviewObservabilitySync({
            range: "24h",
            repo: null,
            now,
          }),
          stateWriter: this.stateWriterSummarySync(now),
          stateAppend: this.stateAppendStatsSync(),
        };
      });
      const {
        state,
        metrics,
        reviewFlow,
        publicationFlow,
        deadLetters,
        reviewTelemetryHealth,
        reviewExecutionHealth,
        stateWriter,
        stateAppend,
      } = snapshot;
      const publicationBatches = this.batchStore.stats(now);
      const batchOwnedItemKeys = new Set<string>(publicationBatches.activeItemKeys);
      const legacyExcludedItemKeys = new Set(batchOwnedItemKeys);
      if (exactReviewPublicationBatchingEnabled(this.env)) {
        for (const item of Object.values(state.items) as ExactReviewQueueItem[]) {
          if (item.state === "pending" && exactReviewQueueIsPublication(item)) {
            legacyExcludedItemKeys.add(item.key);
          }
        }
      }
      const publicationControl = this.refreshPublicationControlSync(state, now);
      await this.scheduleNext(state, now);
      const stats = exactReviewQueueStats(
        state,
        now,
        exactReviewQueueCapacity(this.env),
        exactReviewTargetCapacity(this.env),
        exactReviewPublicationCapacityForState(
          this.env,
          state,
          now,
          publicationControl.capacityCeiling,
          true,
          publicationControl.demandCapacity,
        ),
        exactReviewDispatchLeaseMs(this.env),
        exactReviewExecutionLeaseMs(this.env),
        exactReviewPublicationDispatchLeaseMs(this.env),
        exactReviewHeartbeatGraceMs(this.env),
        legacyExcludedItemKeys,
        publicationBatches.nextLeaseExpiresAt,
      );
      return json({
        ...stats,
        bay_projection: exactReviewQueueBayProjection(Object.values(state.items), bayPriorityKeys),
        lanes: {
          review: {
            ...stats.lanes.review,
            enqueued_total: metrics.review.enqueued,
            completed_total: metrics.review.completed,
            flow: reviewFlow,
          },
          publication: {
            ...stats.lanes.publication,
            enqueued_total: metrics.publication.enqueued,
            completed_total: metrics.publication.completed,
            published_total: metrics.publication.published,
            superseded_total: metrics.publication.superseded,
            retried_total: metrics.publication.retried,
            dead_lettered_total: metrics.publication.deadLettered,
            refreshed_total: metrics.publication.refreshed,
            flow: publicationFlow,
            dead_letters: deadLetters,
            health: exactReviewPublicationHealth(
              stats.lanes.publication,
              publicationFlow,
              deadLetters,
            ),
            capacity_control: exactReviewPublicationControlStatus(this.env, publicationControl),
            batches: {
              enabled: exactReviewPublicationBatchingEnabled(this.env),
              max_items: exactReviewPublicationBatchSize(this.env),
              max_wait_seconds: exactReviewPublicationBatchWaitMs(this.env) / 1_000,
              last_dispatch_at: state.dispatcher?.publicationBatchDispatchedAt
                ? new Date(state.dispatcher.publicationBatchDispatchedAt).toISOString()
                : null,
              last_dispatch_succeeded: state.dispatcher?.publicationBatchDispatchSucceeded ?? null,
              dispatch_pending_until: state.dispatcher?.publicationBatchDispatchPendingUntil
                ? new Date(state.dispatcher.publicationBatchDispatchPendingUntil).toISOString()
                : null,
              leased: publicationBatches.leased,
              completed: publicationBatches.completed,
              expired: publicationBatches.expired,
              active_items: publicationBatches.activeItems,
              oldest_active_at:
                publicationBatches.oldestActiveAt === null
                  ? null
                  : new Date(publicationBatches.oldestActiveAt).toISOString(),
              oldest_active_age_seconds:
                publicationBatches.oldestActiveAt === null
                  ? null
                  : Math.max(0, Math.floor((now - publicationBatches.oldestActiveAt) / 1000)),
              reclaimed_items_retained: publicationBatches.reclaimedItemsRetained,
              cleanup: {
                deleted_this_pass: publicationBatches.cleanup.deletedThisPass,
                eligible_remaining: publicationBatches.cleanup.eligibleRemaining,
                limit: publicationBatches.cleanup.limit,
              },
            },
          },
        },
        delivery_receipts: this.deliveryReceiptCountSync(),
        review_telemetry_health: reviewTelemetryHealth,
        review_execution_health: reviewExecutionHealth,
        state_writer: stateWriter,
        state_append: {
          ...stateAppend,
          max_pending_rows: stateAppendMaxPendingRows(this.env),
          max_pending_bytes: stateAppendMaxPendingBytes(this.env),
        },
        storage_schema_version: EXACT_REVIEW_QUEUE_STORAGE_SCHEMA_VERSION,
        legacy_rollback_available:
          !this.legacyMirrorDisabled &&
          now < this.migratedAt + EXACT_REVIEW_QUEUE_LEGACY_ROLLBACK_MS,
      });
    }

    return new Response("not found", { status: 404 });
  }

  async alarm() {
    await this.ready;
    this.cleanupLegacyCompatibilitySync();
    const startedAt = Date.now();
    await this.storage.deleteAlarm();
    this.storage.transactionSync(() => {
      this.pruneDeliveryReceiptsSync(startedAt);
      this.pruneStateAppendReceiptsSync(startedAt);
      this.reclaimExpiredStateAppendDrainsSync(startedAt);
      this.reconcileStoredReviewRunsSync(startedAt);
      this.syncLegacyCompatibilitySync(this.readStateSync());
    });
    const snapshot = this.readStateSync();
    const snapshotBatchOwnership = this.batchStore.activeLeaseSnapshot(startedAt);
    const reclaimedSnapshot = reclaimExpiredExactReviewLeases(
      snapshot,
      startedAt,
      exactReviewPublicationDispatchLeaseMs(this.env),
      exactReviewHeartbeatGraceMs(this.env),
    );
    const expiredSnapshot = expireExactReviewPublicationItems(snapshot, startedAt, this.env);
    const snapshotChanged = reclaimedSnapshot || expiredSnapshot;
    const capacity = exactReviewQueueCapacity(this.env);
    const targetCapacity = exactReviewTargetCapacity(this.env);
    const snapshotPublicationControl = this.refreshPublicationControlSync(snapshot, startedAt);
    const snapshotPublicationCapacity = exactReviewPublicationCapacityForState(
      this.env,
      snapshot,
      startedAt,
      snapshotPublicationControl.capacityCeiling,
      true,
      snapshotPublicationControl.demandCapacity,
    );
    const snapshotAdmission = exactReviewQueueAdmittedItems(
      snapshot,
      startedAt,
      capacity,
      targetCapacity,
      snapshotPublicationCapacity,
      new Set<string>(snapshotBatchOwnership.itemKeys),
      exactReviewPublicationBatchingEnabled(this.env) || snapshotBatchOwnership.itemKeys.length > 0,
    );
    const snapshotBatchDeparture = exactReviewPublicationBatchDeparture(
      this.env,
      snapshot,
      startedAt,
      new Set(snapshotBatchOwnership.itemKeys),
    );
    let batchDispatchAttempted = false;
    let batchDispatchSucceeded = false;
    let batchDispatchRecordedAt: number | undefined;
    if (snapshotBatchDeparture?.due) {
      batchDispatchAttempted = true;
      batchDispatchRecordedAt = Date.now();
      const reserved = this.readStateSync();
      const reservedDispatcher = reserved.dispatcher ?? {
        state: "unknown",
        checkedAt: startedAt,
      };
      reserved.dispatcher = {
        ...reservedDispatcher,
        publicationBatchDispatchedAt: batchDispatchRecordedAt,
        publicationBatchDispatchSucceeded: undefined,
        publicationBatchDispatchPendingUntil:
          batchDispatchRecordedAt + exactReviewPublicationBatchDispatchReservationMs(this.env),
      };
      await this.writeState(reserved);
      try {
        const token = await exactReviewDispatchToken(this.env);
        await dispatchExactReviewBatchWorkflow({ token });
        batchDispatchSucceeded = true;
      } catch (error) {
        console.warn(
          "exact-review batch workflow dispatch failed",
          error instanceof Error ? error.message : String(error),
        );
      }
      // The dispatch await releases the input gate. Update only our attempt and
      // preserve a claim that already consumed its pending reservation.
      const current = this.readStateSync();
      if (current.dispatcher?.publicationBatchDispatchedAt === batchDispatchRecordedAt) {
        const dispatcher = { ...current.dispatcher };
        dispatcher.publicationBatchDispatchSucceeded = batchDispatchSucceeded;
        if (!batchDispatchSucceeded) delete dispatcher.publicationBatchDispatchPendingUntil;
        current.dispatcher = dispatcher;
        reclaimExpiredExactReviewLeases(
          current,
          Date.now(),
          exactReviewPublicationDispatchLeaseMs(this.env),
          exactReviewHeartbeatGraceMs(this.env),
        );
        expireExactReviewPublicationItems(current, Date.now(), this.env);
        await this.writeState(current);
      }
    }
    if (!snapshotAdmission.length) {
      const current = batchDispatchAttempted ? this.readStateSync() : snapshot;
      if (snapshotChanged && !batchDispatchAttempted) await this.writeState(snapshot);
      await this.scheduleNext(current, Date.now());
      return;
    }

    let preflight: { ok: true; token: string; workflowState: string } | { ok: false } = {
      ok: false,
    };
    try {
      const token = await exactReviewDispatchToken(this.env);
      preflight = { ok: true, token, workflowState: await exactReviewWorkflowState(token) };
    } catch {
      preflight = { ok: false };
    }

    // External fetches release the Durable Object input gate. Re-read before any
    // write so concurrent enqueue, claim, or complete requests cannot be lost.
    const now = Date.now();
    const state = this.readStateSync();
    // Do not rely on reading back the marker written before preflight. Carry the
    // current alarm's dispatch result through every later dispatcher write.
    const persistedBatchDispatcherFields = exactReviewBatchDispatcherFields(state.dispatcher);
    const batchDispatcherFields = batchDispatchRecordedAt
      ? {
          ...persistedBatchDispatcherFields,
          publicationBatchDispatchedAt: batchDispatchRecordedAt,
          publicationBatchDispatchSucceeded: batchDispatchSucceeded,
        }
      : persistedBatchDispatcherFields;
    const batchOwnership = this.batchStore.activeLeaseSnapshot(now);
    reclaimExpiredExactReviewLeases(
      state,
      now,
      exactReviewPublicationDispatchLeaseMs(this.env),
      exactReviewHeartbeatGraceMs(this.env),
    );
    expireExactReviewPublicationItems(state, now, this.env);
    // The preflight fetch releases the input gate, so publication demand may
    // have crossed a scale boundary while the workflow state was checked.
    const publicationControl = this.refreshPublicationControlSync(state, now);
    const publicationCapacity = exactReviewPublicationCapacityForState(
      this.env,
      state,
      now,
      publicationControl.capacityCeiling,
      true,
      publicationControl.demandCapacity,
    );
    const admitted = exactReviewQueueAdmittedItems(
      state,
      now,
      capacity,
      targetCapacity,
      publicationCapacity,
      new Set<string>(batchOwnership.itemKeys),
      exactReviewPublicationBatchingEnabled(this.env) || batchOwnership.itemKeys.length > 0,
    );
    if (!preflight.ok) {
      const retryAt = now + exactReviewWorkflowPausedRetryMs(this.env);
      state.dispatcher = {
        state: "blocked",
        reason: "workflow_status_unavailable",
        checkedAt: now,
        retryAt,
        ...batchDispatcherFields,
      };
      await this.writeState(state);
      await this.scheduleNext(state, now);
      return;
    }
    if (preflight.workflowState !== "active") {
      const retryAt = now + exactReviewWorkflowPausedRetryMs(this.env);
      state.dispatcher = {
        state: "paused",
        reason: "workflow_not_active",
        workflowState: preflight.workflowState,
        checkedAt: now,
        retryAt,
        ...batchDispatcherFields,
      };
      await this.writeState(state);
      await this.scheduleNext(state, now);
      return;
    }

    state.dispatcher = {
      state: "active",
      workflowState: preflight.workflowState,
      checkedAt: now,
      ...batchDispatcherFields,
    };
    for (const item of admitted) {
      item.state = "dispatching";
      item.leaseId = crypto.randomUUID();
      item.leaseRevision = item.revision;
      item.leaseDecision = { ...item.decision };
      item.leaseExpiresAt =
        now +
        (item.decision.sourceAction === EXACT_REVIEW_ARTIFACT_PUBLISH_SOURCE_ACTION
          ? exactReviewPublicationDispatchLeaseMs(this.env)
          : exactReviewDispatchLeaseMs(this.env));
      item.claimedRunId = undefined;
      item.claimedRunAttempt = undefined;
      item.claimGeneration = undefined;
      item.dispatchedAt = now;
      item.claimedAt = undefined;
      item.updatedAt = now;
    }
    await this.writeState(state);
    if (!admitted.length) {
      await this.scheduleNext(state, now);
      return;
    }

    const failures: Array<{ key: string; leaseId: string }> = [];
    for (const item of admitted) {
      try {
        await dispatchClawsweeperItem({
          token: preflight.token,
          decision: item.leaseDecision || item.decision,
          itemKey: item.key,
          leaseId: item.leaseId,
          leaseRevision: item.leaseRevision,
        });
      } catch {
        failures.push({ key: item.key, leaseId: String(item.leaseId || "") });
      }
    }

    // Dispatch calls also release the input gate. Merge failures into current
    // state only when the exact lease still owns the item.
    const completedAt = Date.now();
    const current = this.readStateSync();
    let currentChanged = false;
    for (const failure of failures) {
      const item = current.items[failure.key];
      if (
        !item ||
        !failure.leaseId ||
        item.leaseId !== failure.leaseId ||
        item.state !== "dispatching" ||
        item.claimedRunId
      ) {
        continue;
      }
      clearExactReviewLease(item);
      item.state = "pending";
      item.attempts += 1;
      item.nextAttemptAt = completedAt + exactReviewRetryDelayMs(item.attempts);
      item.updatedAt = completedAt;
      currentChanged = true;
    }
    if (currentChanged) await this.writeState(current);
    await this.scheduleNext(current, completedAt);
  }

  private listDeadLetters(value: unknown) {
    const body = objectValue(value);
    const status = String(body.status || "open");
    if (!["open", "replayed", "resolved", "all"].includes(status)) {
      return json({ error: "invalid_dead_letter_status" }, 400);
    }
    const limit = body.limit === undefined ? 20 : Number(body.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      return json({ error: "invalid_limit" }, 400);
    }
    const cursor = String(body.cursor || "");
    if (cursor && cursor.length > 500) return json({ error: "invalid_cursor" }, 400);
    this.pruneQueueTelemetrySync(Date.now());
    const rows = Array.from(
      this.storage.sql.exec(
        `SELECT dead_letter_id, item_key, revision, target_repo, item_number,
                producer_run_id, producer_run_attempt, artifact_name, reason_code,
                attempts, first_failed_at, last_failed_at, item_json, error_fingerprint,
                status, replay_key, resolution_note, resolved_at
           FROM ${EXACT_REVIEW_QUEUE_DEAD_LETTER_TABLE}
          WHERE dead_letter_id > ? ${status === "all" ? "" : "AND status = ?"}
          ORDER BY dead_letter_id
          LIMIT ?`,
        cursor,
        ...(status === "all" ? [limit + 1] : [status, limit + 1]),
      ) as Iterable<Record<string, unknown>>,
    );
    const page = rows.slice(0, limit);
    const state = this.readStateSync();
    return json({
      ok: true,
      dead_letters: page.map((row) => {
        const item = exactReviewDeadLetterItem(String(row.item_json || ""));
        const recovery = item ? exactReviewFreshRecoveryFromPublicationItem(item) : null;
        const activePublication = item ? state.items[item.key] : undefined;
        const activeRecovery = recovery ? state.items[recovery.key] : undefined;
        const recoveryReason = !item
          ? "invalid_dead_letter_item"
          : !recovery
            ? "not_an_exact_publication"
            : activePublication
              ? "publication_item_active"
              : activeRecovery
                ? "fresh_review_already_active"
                : !isExactReviewQueueTargetEnabled(recovery.decision, this.env)
                  ? "target_not_enabled"
                  : "eligible";
        return {
          ...row,
          item,
          item_json: undefined,
          diagnostic: {
            reason_code: String(row.reason_code || "unknown_failure"),
            attempts: Number(row.attempts || 0),
            first_failed_at: Number(row.first_failed_at || 0)
              ? new Date(Number(row.first_failed_at)).toISOString()
              : null,
            last_failed_at: Number(row.last_failed_at || 0)
              ? new Date(Number(row.last_failed_at)).toISOString()
              : null,
            error_fingerprint: String(row.error_fingerprint || "") || null,
          },
          fresh_recovery: {
            mode: "fresh_review_only",
            eligible: recoveryReason === "eligible",
            reason: recoveryReason,
            item_key: recovery?.key ?? null,
          },
        };
      }),
      next_cursor: rows.length > limit ? String(page.at(-1)?.dead_letter_id || "") || null : null,
    });
  }

  private async replayDeadLetters(value: unknown) {
    const body = objectValue(value);
    const ids = exactReviewDeadLetterIds(body.ids);
    const replayKey = String(body.idempotency_key || "").trim();
    if (!ids) return json({ error: "invalid_dead_letter_ids" }, 400);
    if (!/^[A-Za-z0-9:._-]{1,200}$/.test(replayKey)) {
      return json({ error: "invalid_idempotency_key" }, 400);
    }
    const now = Date.now();
    const result = this.storage.transactionSync(() => {
      const state = this.readStateSync();
      let replayed = 0;
      let deduped = 0;
      let skipped = 0;
      for (const id of ids) {
        const row = Array.from(
          this.storage.sql.exec(
            `SELECT status, replay_key, item_json
               FROM ${EXACT_REVIEW_QUEUE_DEAD_LETTER_TABLE}
              WHERE dead_letter_id = ?`,
            id,
          ),
        )[0] as { status?: string; replay_key?: string; item_json?: string } | undefined;
        if (row?.status === "replayed" && row.replay_key === replayKey) {
          deduped += 1;
          continue;
        }
        if (row?.status !== "open" || !row.item_json) {
          skipped += 1;
          continue;
        }
        const item = JSON.parse(row.item_json) as ExactReviewQueueItem;
        if (!item?.key || state.items[item.key]) {
          skipped += 1;
          continue;
        }
        clearExactReviewLease(item);
        item.state = "pending";
        item.parkedReason = undefined;
        item.attempts = 0;
        item.publicationFailureAttempts = 0;
        item.firstFailureAt = undefined;
        item.lastFailureReason = undefined;
        item.createdAt = now;
        item.updatedAt = now;
        item.nextAttemptAt = now;
        state.items[item.key] = item;
        this.storage.sql.exec(
          `UPDATE ${EXACT_REVIEW_QUEUE_DEAD_LETTER_TABLE}
              SET status = 'replayed', replay_key = ?, resolution_note = 'replayed', resolved_at = ?
            WHERE dead_letter_id = ? AND status = 'open'`,
          replayKey,
          now,
          id,
        );
        replayed += 1;
      }
      const unparked = this.drainParkedDeadLettersSync(state, now);
      if (replayed) this.writeStateSync(state);
      else if (unparked) this.writeStateSync(state);
      else this.syncLegacyCompatibilitySync(state);
      if (unparked) {
        this.incrementQueueMetricsSync({
          publicationCompleted: unparked,
          publicationDeadLettered: unparked,
        });
      }
      return { state, replayed, deduped, skipped, unparked };
    });
    if (result.replayed) await this.scheduleNext(result.state, now);
    return json({
      ok: true,
      replayed: result.replayed,
      deduped: result.deduped,
      skipped: result.skipped,
    });
  }

  private async recoverDeadLettersFresh(value: unknown) {
    const body = objectValue(value);
    const ids = exactReviewDeadLetterIds(body.ids);
    const recoveryKey = String(body.idempotency_key || "").trim();
    if (!ids || ids.length > 10) return json({ error: "invalid_dead_letter_ids" }, 400);
    if (!/^[A-Za-z0-9:._-]{1,200}$/.test(recoveryKey)) {
      return json({ error: "invalid_idempotency_key" }, 400);
    }
    const now = Date.now();
    const result = this.storage.transactionSync(() => {
      const state = this.readStateSync();
      let recovered = 0;
      let deduped = 0;
      let skipped = 0;
      for (const id of ids) {
        const row = Array.from(
          this.storage.sql.exec(
            `SELECT status, replay_key, resolution_note, item_json
               FROM ${EXACT_REVIEW_QUEUE_DEAD_LETTER_TABLE}
              WHERE dead_letter_id = ?`,
            id,
          ),
        )[0] as
          | {
              status?: string;
              replay_key?: string;
              resolution_note?: string;
              item_json?: string;
            }
          | undefined;
        if (
          row?.status === "resolved" &&
          row.replay_key === recoveryKey &&
          row.resolution_note === "recovered_fresh"
        ) {
          deduped += 1;
          continue;
        }
        if (row?.status !== "open" || !row.item_json) {
          skipped += 1;
          continue;
        }
        const item = exactReviewDeadLetterItem(row.item_json);
        const recovery = item ? exactReviewFreshRecoveryFromPublicationItem(item) : null;
        if (
          !item ||
          !recovery ||
          !isExactReviewQueueTargetEnabled(recovery.decision, this.env) ||
          state.items[item.key] ||
          state.items[recovery.key]
        ) {
          skipped += 1;
          continue;
        }
        // Never replay the immutable publisher artifact. Create exactly one new ordinary
        // review item so the current workflow can gather a new artifact and proof. Existing
        // pending, dispatching, and leased items are all skipped above rather than replaced.
        state.items[recovery.key] = {
          key: recovery.key,
          decision: recovery.decision,
          state: "pending",
          revision: 1,
          createdAt: now,
          updatedAt: now,
          nextAttemptAt: exactReviewQueueDebouncedAttemptAt(
            state,
            recovery.decision,
            now,
            now,
            this.env,
          ),
          attempts: 0,
        };
        this.storage.sql.exec(
          `UPDATE ${EXACT_REVIEW_QUEUE_DEAD_LETTER_TABLE}
              SET status = 'resolved', replay_key = ?, resolution_note = 'recovered_fresh',
                  resolved_at = ?
            WHERE dead_letter_id = ? AND status = 'open'`,
          recoveryKey,
          now,
          id,
        );
        recovered += 1;
      }
      const unparked = recovered ? this.drainParkedDeadLettersSync(state, now) : 0;
      if (recovered || unparked) {
        this.writeStateSync(state);
        if (unparked) {
          this.incrementQueueMetricsSync({
            publicationCompleted: unparked,
            publicationDeadLettered: unparked,
          });
        }
      } else {
        this.syncLegacyCompatibilitySync(state);
      }
      return { state, recovered, deduped, skipped, unparked };
    });
    if (result.recovered || result.unparked) await this.scheduleNext(result.state, now);
    return json({
      ok: true,
      recovered: result.recovered,
      deduped: result.deduped,
      skipped: result.skipped,
      unparked: result.unparked,
    });
  }

  private resolveDeadLetters(value: unknown) {
    const body = objectValue(value);
    const ids = exactReviewDeadLetterIds(body.ids);
    const note = String(body.note || "").trim();
    if (!ids) return json({ error: "invalid_dead_letter_ids" }, 400);
    if (!note || note.length > 500) return json({ error: "invalid_resolution_note" }, 400);
    const now = Date.now();
    let resolved = 0;
    let unparked = 0;
    this.storage.transactionSync(() => {
      for (const id of ids) {
        const changed = Array.from(
          this.storage.sql.exec(
            `UPDATE ${EXACT_REVIEW_QUEUE_DEAD_LETTER_TABLE}
                SET status = 'resolved', resolution_note = ?, resolved_at = ?
              WHERE dead_letter_id = ? AND status = 'open'
            RETURNING dead_letter_id`,
            note,
            now,
            id,
          ),
        );
        if (changed.length) resolved += 1;
      }
      if (resolved) {
        const state = this.readStateSync();
        unparked = this.drainParkedDeadLettersSync(state, now);
        if (unparked) {
          this.writeStateSync(state);
          this.incrementQueueMetricsSync({
            publicationCompleted: unparked,
            publicationDeadLettered: unparked,
          });
        }
      }
    });
    return json({ ok: true, resolved, skipped: ids.length - resolved, unparked });
  }

  private listPublicationCandidates(value: unknown) {
    const body = objectValue(value);
    const cursor = String(body.cursor || "");
    const limit = body.limit === undefined ? 100 : Number(body.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return json({ error: "invalid_limit" }, 400);
    }
    const state = this.readStateSync();
    const candidates = Object.values(state.items)
      .filter(
        (item) =>
          item.key > cursor &&
          exactReviewQueueIsPublication(item) &&
          (item.state === "pending" || item.state === "parked"),
      )
      .sort((left, right) => left.key.localeCompare(right.key));
    const page = candidates.slice(0, limit);
    return json({
      ok: true,
      publications: page.map((item) => ({
        item_key: item.key,
        revision: item.revision,
        state: item.state,
        created_at: new Date(item.createdAt).toISOString(),
        attempts: item.attempts,
        decision: item.decision,
      })),
      next_cursor: candidates.length > limit ? page.at(-1)?.key || null : null,
    });
  }

  private async recordReviewTelemetry(value: unknown) {
    const record = normalizeReviewTelemetry(value);
    if (!record) return json({ error: "invalid_review_telemetry" }, 400);
    const now = Date.now();
    const updatedAt = Date.parse(record.updated_at);
    this.storage.transactionSync(() => {
      this.pruneReviewTelemetrySync(now);
      // Terminal truth is first-writer immutable. Retries may replay the same
      // payload, but neither a heartbeat nor a conflicting terminal delivery
      // may make durable observations depend on arrival order.
      this.storage.sql.exec(
        `INSERT INTO ${EXACT_REVIEW_REVIEW_TELEMETRY_TABLE}
           (repo, item_number, run_id, run_attempt, status, outcome, trigger_lane,
            trigger_origin, terminal_at, updated_at, lease_expires_at, generation,
            operation_id, queue_ms, claim_ms, review_ms, publication_ms, total_ms, record_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo, item_number, run_id, run_attempt) DO UPDATE SET
           status = excluded.status,
           outcome = excluded.outcome,
           trigger_lane = excluded.trigger_lane,
           trigger_origin = excluded.trigger_origin,
           terminal_at = excluded.terminal_at,
           updated_at = excluded.updated_at,
           lease_expires_at = excluded.lease_expires_at,
           generation = excluded.generation,
           operation_id = excluded.operation_id,
           queue_ms = excluded.queue_ms,
           claim_ms = excluded.claim_ms,
           review_ms = excluded.review_ms,
           publication_ms = excluded.publication_ms,
           total_ms = excluded.total_ms,
           record_json = excluded.record_json
         WHERE ${EXACT_REVIEW_REVIEW_TELEMETRY_TABLE}.status != 'completed'
           AND (excluded.status = 'completed'
                OR excluded.updated_at >= ${EXACT_REVIEW_REVIEW_TELEMETRY_TABLE}.updated_at)`,
        record.repo,
        record.item_number,
        record.run_id,
        record.run_attempt,
        record.status,
        record.outcome,
        record.trigger_lane ?? null,
        record.trigger_origin ?? null,
        record.terminal_at ? Date.parse(record.terminal_at) : null,
        updatedAt,
        record.lease_expires_at === null ? null : Date.parse(record.lease_expires_at),
        record.generation ?? null,
        record.operation_id ?? null,
        record.phase_durations_ms.queue ?? null,
        record.phase_durations_ms.claim ?? null,
        record.phase_durations_ms.review ?? null,
        record.phase_durations_ms.publication ?? null,
        record.phase_durations_ms.total ?? null,
        JSON.stringify(record),
      );
      // workflow_run can arrive before a delayed producer write. Re-check the
      // durable terminal evidence here so delivery order cannot strand a row.
      this.reconcileStoredReviewRunsSync(now);
    });
    await this.scheduleNext(this.readStateSync(), now);
    return json({ ok: true });
  }

  private async recordReviewRunTelemetry(value: unknown) {
    const record = normalizeReviewRunTelemetry(value);
    if (!record) return json({ error: "invalid_review_run_telemetry" }, 400);
    const completedAt = Date.parse(record.completed_at);
    this.storage.transactionSync(() => {
      this.pruneReviewTelemetrySync(Date.now());
      // workflow_run deliveries can be replayed, but GitHub's first terminal tuple is immutable.
      this.storage.sql.exec(
        `INSERT OR IGNORE INTO ${EXACT_REVIEW_RUN_TELEMETRY_TABLE}
           (run_id, run_attempt, workflow_outcome, trigger_lane, trigger_origin, target_repo,
            completed_at, record_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        record.run_id,
        record.run_attempt,
        record.workflow_outcome,
        record.trigger_lane,
        record.trigger_origin,
        record.target_repo,
        completedAt,
        JSON.stringify(record),
      );
      const storedRow = Array.from(
        this.storage.sql.exec(
          `SELECT record_json FROM ${EXACT_REVIEW_RUN_TELEMETRY_TABLE}
            WHERE run_id = ? AND run_attempt = ?`,
          record.run_id,
          record.run_attempt,
        ),
      )[0] as { record_json?: unknown } | undefined;
      const storedRecord = normalizeReviewRunTelemetry(
        JSON.parse(String(storedRow?.record_json || "null")),
      );
      if (storedRecord) this.reconcileReviewTelemetryFromRunSync(storedRecord, Date.now());
    });
    await this.scheduleNext(this.readStateSync(), Date.now());
    return json({ ok: true });
  }

  private reconcileReviewTelemetryFromRunSync(run: DurableReviewRunTelemetry, now: number) {
    const rows = this.reviewTelemetryRowsSync({
      runId: run.run_id,
      runAttempt: run.run_attempt,
      status: "refreshing",
    });
    for (const record of rows) {
      if (record.lease_expires_at !== null && Date.parse(record.lease_expires_at) > now) {
        continue;
      }
      const repoAttributed = run.target_repo === record.repo;
      const itemJob = repoAttributed
        ? run.review_jobs?.find((job) => job.item_number === record.item_number)
        : undefined;
      const onlyJob = run.review_jobs?.length === 1 ? run.review_jobs[0] : undefined;
      // A generic matrix job is item evidence only when the entire wave has one
      // item. Applying one arbitrary shard conclusion to siblings is less safe
      // than falling back to the immutable workflow conclusion.
      const attributableJob =
        itemJob ??
        (repoAttributed && run.item_count === 1 && onlyJob?.item_number === null
          ? onlyJob
          : undefined);
      const outcome = attributableJob
        ? attributableJob.conclusion === "success"
          ? "succeeded"
          : attributableJob.conclusion === "cancelled"
            ? "cancelled"
            : "interrupted"
        : null;
      // A workflow terminal proves wave health, not which unattributed matrix
      // item succeeded or failed. Keep that row visible to the watchdog.
      if (outcome === null) continue;
      const terminal: DurableReviewTelemetry = {
        ...record,
        status: "completed",
        outcome,
        updated_at: run.completed_at,
        lease_expires_at: null,
        terminal_at: run.completed_at,
        terminal_reason:
          outcome === "succeeded"
            ? "workflow_job_succeeded"
            : outcome === "cancelled"
              ? "workflow_cancelled"
              : "workflow_terminal",
      };
      this.recordReviewTelemetrySync(terminal);
    }
  }

  private reconcileStoredReviewRunsSync(now: number) {
    const rows = this.storage.sql.exec(
      `SELECT DISTINCT runs.record_json
         FROM ${EXACT_REVIEW_RUN_TELEMETRY_TABLE} AS runs
         JOIN ${EXACT_REVIEW_REVIEW_TELEMETRY_TABLE} AS reviews
           ON reviews.run_id = runs.run_id AND reviews.run_attempt = runs.run_attempt
        WHERE reviews.status = 'refreshing'
          AND (reviews.lease_expires_at IS NULL OR reviews.lease_expires_at <= ?)`,
      now,
    ) as Iterable<{ record_json?: unknown }>;
    for (const row of rows) {
      const run = normalizeReviewRunTelemetry(JSON.parse(String(row.record_json || "null")));
      if (run) this.reconcileReviewTelemetryFromRunSync(run, now);
    }
  }

  private nextReviewReconcileAtSync(now: number) {
    const row = Array.from(
      this.storage.sql.exec(
        `SELECT MIN(reviews.lease_expires_at) AS next_at
           FROM ${EXACT_REVIEW_REVIEW_TELEMETRY_TABLE} AS reviews
           JOIN ${EXACT_REVIEW_RUN_TELEMETRY_TABLE} AS runs
             ON runs.run_id = reviews.run_id AND runs.run_attempt = reviews.run_attempt
          WHERE reviews.status = 'refreshing'
            AND reviews.lease_expires_at > ?`,
        now,
      ),
    )[0] as { next_at?: number } | undefined;
    const next = Number(row?.next_at || 0);
    return next > 0 ? next : null;
  }

  private recordReviewTelemetrySync(record: DurableReviewTelemetry) {
    this.storage.sql.exec(
      `UPDATE ${EXACT_REVIEW_REVIEW_TELEMETRY_TABLE}
          SET status = 'completed', outcome = ?, terminal_at = ?, updated_at = ?,
              lease_expires_at = NULL, record_json = ?
        WHERE repo = ? AND item_number = ? AND run_id = ? AND run_attempt = ?
          AND status != 'completed'`,
      record.outcome,
      Date.parse(record.terminal_at ?? record.updated_at),
      Date.parse(record.updated_at),
      JSON.stringify(record),
      record.repo,
      record.item_number,
      record.run_id,
      record.run_attempt,
    );
  }

  private listReviewTelemetry(search: URLSearchParams) {
    const repo = String(search.get("repo") || "").trim();
    const itemNumber = Number(search.get("item_number"));
    const limit = search.has("limit") ? Number(search.get("limit")) : 20;
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
      !Number.isInteger(itemNumber) ||
      itemNumber < 1 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      return json({ error: "invalid_review_telemetry_query" }, 400);
    }
    this.pruneReviewTelemetrySync(Date.now());
    return json({
      ok: true,
      repo,
      item_number: itemNumber,
      reviews: this.reviewTelemetryRowsSync({ repo, itemNumber, limit }),
    });
  }

  private reviewTelemetryRowsSync(options: {
    repo?: string;
    itemNumber?: number;
    runId?: string;
    runAttempt?: number;
    status?: DurableReviewTelemetry["status"];
    limit?: number;
  }) {
    const predicates: string[] = [];
    const bindings: unknown[] = [];
    if (options.repo !== undefined) {
      predicates.push("repo = ?");
      bindings.push(options.repo);
    }
    if (options.itemNumber !== undefined) {
      predicates.push("item_number = ?");
      bindings.push(options.itemNumber);
    }
    if (options.runId !== undefined) {
      predicates.push("run_id = ?");
      bindings.push(options.runId);
    }
    if (options.runAttempt !== undefined) {
      predicates.push("run_attempt = ?");
      bindings.push(options.runAttempt);
    }
    if (options.status !== undefined) {
      predicates.push("status = ?");
      bindings.push(options.status);
    }
    const rows = this.storage.sql.exec(
      `SELECT record_json
         FROM ${EXACT_REVIEW_REVIEW_TELEMETRY_TABLE}
        ${predicates.length ? `WHERE ${predicates.join(" AND ")}` : ""}
        ORDER BY updated_at DESC, repo, item_number, run_id, run_attempt
        LIMIT ?`,
      ...bindings,
      options.limit ?? 100,
    ) as Iterable<{ record_json?: unknown }>;
    return Array.from(rows)
      .map((row) => normalizeReviewTelemetry(JSON.parse(String(row.record_json || "null"))))
      .filter((record): record is DurableReviewTelemetry => record !== null);
  }

  private reviewRunTelemetryRowsSync(options: { repo?: string; from: number; limit?: number }) {
    const predicates = ["completed_at >= ?"];
    const bindings: unknown[] = [options.from];
    if (options.repo !== undefined) {
      predicates.push("(target_repo = ? OR target_repo IS NULL)");
      bindings.push(options.repo);
    }
    const rows = this.storage.sql.exec(
      `SELECT record_json FROM ${EXACT_REVIEW_RUN_TELEMETRY_TABLE}
        WHERE ${predicates.join(" AND ")}
        ORDER BY CASE WHEN workflow_outcome IN ('failure', 'cancelled') THEN 0 ELSE 1 END,
                 completed_at DESC, run_id, run_attempt LIMIT ?`,
      ...bindings,
      options.limit ?? 10_000,
    ) as Iterable<{ record_json?: unknown }>;
    return Array.from(rows)
      .map((row) => normalizeReviewRunTelemetry(JSON.parse(String(row.record_json || "null"))))
      .filter((record): record is DurableReviewRunTelemetry => record !== null);
  }

  private reviewObservabilityTelemetryRowsSync(options: { repo?: string; from: number }) {
    const predicates = ["(status = 'refreshing' OR COALESCE(terminal_at, updated_at) >= ?)"];
    const bindings: unknown[] = [options.from];
    if (options.repo !== undefined) {
      predicates.push("repo = ?");
      bindings.push(options.repo);
    }
    const rows = this.storage.sql.exec(
      `SELECT record_json FROM ${EXACT_REVIEW_REVIEW_TELEMETRY_TABLE}
        WHERE ${predicates.join(" AND ")}
        ORDER BY CASE WHEN status = 'refreshing' THEN 0 ELSE 1 END,
                 CASE WHEN status = 'refreshing' THEN updated_at END ASC,
                 CASE WHEN status = 'completed' THEN COALESCE(terminal_at, updated_at) END DESC
        LIMIT ?`,
      ...bindings,
      REVIEW_OBSERVABILITY_SCAN_LIMIT + 1,
    ) as Iterable<{ record_json?: unknown }>;
    return Array.from(rows)
      .map((row) => normalizeReviewTelemetry(JSON.parse(String(row.record_json || "null"))))
      .filter((record): record is DurableReviewTelemetry => record !== null);
  }

  private reviewObservability(search: URLSearchParams) {
    const range = String(search.get("range") || "24h") as keyof typeof REVIEW_OBSERVABILITY_RANGES;
    const repoValue = String(search.get("repo") || "all").trim();
    if (
      !Object.hasOwn(REVIEW_OBSERVABILITY_RANGES, range) ||
      (repoValue !== "all" && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoValue))
    ) {
      return json({ error: "invalid_review_observability_query" }, 400);
    }
    return json(
      this.reviewObservabilitySync({
        range,
        repo: repoValue === "all" ? null : repoValue,
        now: Date.now(),
      }),
    );
  }

  private reviewObservabilitySync(options: {
    range: keyof typeof REVIEW_OBSERVABILITY_RANGES;
    repo: string | null;
    now: number;
  }) {
    const from = options.now - REVIEW_OBSERVABILITY_RANGES[options.range];
    const records = this.reviewObservabilityTelemetryRowsSync({
      ...(options.repo ? { repo: options.repo } : {}),
      from,
    });
    const runs = this.reviewRunTelemetryRowsSync({
      ...(options.repo ? { repo: options.repo } : {}),
      from,
      limit: REVIEW_OBSERVABILITY_SCAN_LIMIT + 1,
    });
    const telemetryComplete =
      records.length <= REVIEW_OBSERVABILITY_SCAN_LIMIT &&
      runs.length <= REVIEW_OBSERVABILITY_SCAN_LIMIT;
    const requiredSinceRaw = Date.parse(String(this.env.REVIEW_OBSERVABILITY_REQUIRED_SINCE || ""));
    return summarizeReviewObservability({
      records: records.slice(0, REVIEW_OBSERVABILITY_SCAN_LIMIT),
      runs: runs.slice(0, REVIEW_OBSERVABILITY_SCAN_LIMIT),
      range: options.range,
      repo: options.repo,
      required: String(this.env.REVIEW_OBSERVABILITY_REQUIRED || "") === "1",
      ...(Number.isFinite(requiredSinceRaw) ? { requiredSince: requiredSinceRaw } : {}),
      recoveryEnabled: String(this.env.REVIEW_RECOVERY_ENABLED || "") === "1",
      telemetryComplete,
      now: options.now,
    });
  }

  private reviewTelemetryHealthSync(now: number): ReviewTelemetryHealth {
    const counts = Array.from(
      this.storage.sql.exec(
        `SELECT COUNT(*) AS refreshing,
                COALESCE(SUM(CASE WHEN updated_at <= ? THEN 1 ELSE 0 END), 0)
                  AS slow_refreshing,
                COALESCE(SUM(CASE
                  WHEN updated_at <= ?
                   AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
                  THEN 1 ELSE 0 END), 0) AS orphan_refreshing
           FROM ${EXACT_REVIEW_REVIEW_TELEMETRY_TABLE}
          WHERE status = 'refreshing'`,
        now - REVIEW_TELEMETRY_DEGRADED_MS,
        now - REVIEW_TELEMETRY_ORPHAN_MS,
        now,
      ),
    )[0] as Record<string, unknown> | undefined;
    const orphanCount = Number(counts?.orphan_refreshing || 0);
    const orphanRows = this.storage.sql.exec(
      `SELECT record_json
         FROM ${EXACT_REVIEW_REVIEW_TELEMETRY_TABLE}
        WHERE status = 'refreshing'
          AND updated_at <= ?
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        ORDER BY updated_at, repo, item_number, run_id, run_attempt
        LIMIT 20`,
      now - REVIEW_TELEMETRY_ORPHAN_MS,
      now,
    ) as Iterable<{ record_json?: unknown }>;
    const orphans = Array.from(orphanRows)
      .map((row) => normalizeReviewTelemetry(JSON.parse(String(row.record_json || "null")), now))
      .filter((record): record is DurableReviewTelemetry => record !== null)
      .map((record) => ({
        repo: record.repo,
        item_number: record.item_number,
        run_id: record.run_id,
        run_attempt: record.run_attempt,
        updated_at: record.updated_at,
        age_seconds: Math.floor(Math.max(0, now - Date.parse(record.updated_at)) / 1000),
        lease_expires_at: record.lease_expires_at,
      }));
    const slowCount = Number(counts?.slow_refreshing || 0);
    return {
      status: orphanCount ? "critical" : slowCount ? "degraded" : "healthy",
      refreshing: Number(counts?.refreshing || 0),
      slow_refreshing: slowCount,
      orphan_refreshing: orphanCount,
      degraded_after_seconds: REVIEW_TELEMETRY_DEGRADED_MS / 1000,
      orphan_after_seconds: REVIEW_TELEMETRY_ORPHAN_MS / 1000,
      orphans,
    };
  }

  private pruneReviewTelemetrySync(now: number) {
    this.storage.sql.exec(
      `DELETE FROM ${EXACT_REVIEW_REVIEW_TELEMETRY_TABLE}
        WHERE status = 'completed' AND updated_at <= ?`,
      now - REVIEW_TELEMETRY_RETENTION_MS,
    );
    this.storage.sql.exec(
      `DELETE FROM ${EXACT_REVIEW_RUN_TELEMETRY_TABLE} WHERE completed_at <= ?`,
      now - REVIEW_TELEMETRY_RETENTION_MS,
    );
  }

  private async supersedePublicationCandidates(value: unknown) {
    const body = objectValue(value);
    const candidates = exactReviewPublicationCandidates(body.items);
    if (!candidates) return json({ error: "invalid_publication_candidates" }, 400);
    const state = this.readStateSync();
    let superseded = 0;
    for (const candidate of candidates) {
      const item = state.items[candidate.itemKey];
      if (
        !item ||
        item.revision !== candidate.revision ||
        !exactReviewQueueIsPublication(item) ||
        (item.state !== "pending" && item.state !== "parked")
      ) {
        continue;
      }
      delete state.items[item.key];
      superseded += 1;
    }
    if (superseded) {
      await this.writeState(state, {
        publicationCompleted: superseded,
        publicationSuperseded: superseded,
      });
      await this.scheduleNext(state, Date.now());
    }
    return json({ ok: true, superseded, skipped: candidates.length - superseded });
  }

  private claimPublicationBatch(value: unknown) {
    // The rollout switch closes only new admission. Fetch and complete stay available so
    // disabling the flag cannot strand ownership that was leased before the config change.
    if (!exactReviewPublicationBatchingEnabled(this.env)) {
      return json({ error: "publication_batching_disabled" }, 409);
    }
    const body = objectValue(value);
    const leaseOwner = exactReviewPublicationBatchOwner(body.lease_owner);
    const claimId = exactReviewPublicationBatchId(body.claim_id);
    if (!leaseOwner) return json({ error: "invalid_lease_owner" }, 400);
    if (!claimId) return json({ error: "invalid_claim_id" }, 400);
    const requestedSize =
      body.max_items === undefined
        ? exactReviewPublicationBatchSize(this.env)
        : Number(body.max_items);
    if (
      !Number.isInteger(requestedSize) ||
      requestedSize < 1 ||
      requestedSize > MAX_EXACT_REVIEW_PUBLICATION_BATCH_SIZE
    ) {
      return json({ error: "invalid_max_items" }, 400);
    }
    const now = Date.now();
    const state = this.readStateSync();
    const batchOwnership = this.batchStore.activeLeaseSnapshot(now);
    const publicationControl = this.refreshPublicationControlSync(state, now);
    const publicationCapacity = exactReviewPublicationCapacityForState(
      this.env,
      state,
      now,
      publicationControl.capacityCeiling,
      true,
      publicationControl.demandCapacity,
    );
    // The outer comparison charges one publisher slot for the whole batch. The
    // shared helper counts candidate rows, so widen only its scan window by
    // requestedSize; passing +1 here would silently collapse every batch to one.
    const activePublishers = exactReviewQueueActivePublicationCount(state);
    const readyCandidates =
      activePublishers >= publicationCapacity
        ? []
        : exactReviewQueueAdmittedItems(
            state,
            now,
            exactReviewQueueCapacity(this.env),
            exactReviewTargetCapacity(this.env),
            activePublishers + requestedSize,
            new Set<string>(batchOwnership.itemKeys),
          ).filter(exactReviewQueueIsPublication);
    const firstOwner = readyCandidates[0]?.decision.targetRepo.split("/", 1)[0]?.toLowerCase();
    // One GitHub App installation token is scoped to one owner. Keeping a batch
    // owner-homogeneous lets the workflow retain least privilege without serially
    // minting and exporting a different credential for every item.
    const candidates = readyCandidates
      .filter((item) => item.decision.targetRepo.split("/", 1)[0]?.toLowerCase() === firstOwner)
      .slice(0, requestedSize)
      .map((item) => ({ itemKey: item.key, revision: item.revision }));
    const batch = this.batchStore.claim({
      batchId: claimId,
      leaseOwner,
      leaseExpiresAt: now + exactReviewPublicationBatchLeaseMs(this.env),
      now,
      maxItems: requestedSize,
      candidates,
    });
    if (state.dispatcher?.publicationBatchDispatchPendingUntil) {
      const dispatcher = { ...state.dispatcher };
      delete dispatcher.publicationBatchDispatchPendingUntil;
      state.dispatcher = dispatcher;
      this.writeStateSync(state);
    }
    if (!batch) return json({ ok: true, claimed: false, batch: null });
    return json({ ok: true, claimed: true, batch: exactReviewPublicationBatchJson(batch) });
  }

  private async fetchPublicationBatch(value: unknown) {
    const body = objectValue(value);
    const batchId = exactReviewPublicationBatchId(body.batch_id);
    const leaseOwner = exactReviewPublicationBatchOwner(body.lease_owner);
    if (!batchId || !leaseOwner) return json({ error: "invalid_batch_identity" }, 400);
    const now = Date.now();
    let batch = this.batchStore.fetch(batchId, leaseOwner, now);
    if (!batch) return json({ error: "batch_lease_not_active" }, 409);
    const state = this.readStateSync();
    const stale: PublicationBatchCompletion[] = batch.items
      .filter((membership) => {
        if (membership.terminalOutcome !== null) return false;
        const item = state.items[membership.itemKey];
        return (
          !item || item.revision !== membership.revision || !exactReviewQueueIsPublication(item)
        );
      })
      .map((membership) => ({
        itemKey: membership.itemKey,
        revision: membership.revision,
        claimGeneration: membership.claimGeneration,
        terminalOutcome: "superseded",
      }));
    if (stale.length) {
      batch = this.batchStore.complete(batchId, leaseOwner, stale, now);
      if (!batch) return json({ error: "batch_lease_not_active" }, 409);
      await this.scheduleNext(state, now);
    }
    const items = batch.items.flatMap((membership) => {
      if (membership.terminalOutcome !== null) return [];
      const item = state.items[membership.itemKey];
      if (!item || item.revision !== membership.revision) return [];
      return [
        {
          item_key: membership.itemKey,
          revision: membership.revision,
          claim_generation: membership.claimGeneration,
          decision: item.decision,
        },
      ];
    });
    return json({
      ok: true,
      batch: exactReviewPublicationBatchJson(batch),
      items,
      superseded: batch.items.filter((item) => item.terminalOutcome === "superseded").length,
    });
  }

  private heartbeatPublicationBatch(value: unknown) {
    const body = objectValue(value);
    const batchId = exactReviewPublicationBatchId(body.batch_id);
    const leaseOwner = exactReviewPublicationBatchOwner(body.lease_owner);
    const members = exactReviewPublicationBatchMembers(body.items);
    if (!batchId || !leaseOwner) return json({ error: "invalid_batch_identity" }, 400);
    if (!members?.length) return json({ error: "invalid_batch_members" }, 400);
    const now = Date.now();
    const batch = this.batchStore.heartbeat(
      batchId,
      leaseOwner,
      members,
      now + exactReviewPublicationBatchLeaseMs(this.env),
      now,
    );
    if (!batch) return json({ error: "batch_lease_not_active" }, 409);
    return json({ ok: true, batch: exactReviewPublicationBatchJson(batch) });
  }

  private async completePublicationBatch(value: unknown) {
    const body = objectValue(value);
    const batchId = exactReviewPublicationBatchId(body.batch_id);
    const leaseOwner = exactReviewPublicationBatchOwner(body.lease_owner);
    const completions = exactReviewPublicationBatchCompletions(body.items);
    if (!batchId || !leaseOwner) return json({ error: "invalid_batch_identity" }, 400);
    if (!completions) return json({ error: "invalid_batch_completions" }, 400);
    const stateCommitSha = String(body.state_commit_sha || "").trim();
    if (stateCommitSha && !/^[0-9a-f]{40}$/i.test(stateCommitSha)) {
      return json({ error: "invalid_state_commit_sha" }, 400);
    }
    const failureFingerprint = String(body.failure_fingerprint || "").trim();
    if (failureFingerprint.length > 500) {
      return json({ error: "invalid_failure_fingerprint" }, 400);
    }
    let acceptedCount = 0;
    const batch = this.batchStore.complete(
      batchId,
      leaseOwner,
      completions,
      Date.now(),
      {
        ...(stateCommitSha ? { stateCommitSha } : {}),
        ...(failureFingerprint ? { failureFingerprint } : {}),
      },
      (accepted) => {
        acceptedCount = accepted.length;
        if (!accepted.length) return;
        const state = this.readStateSync();
        let published = 0;
        let superseded = 0;
        for (const completion of accepted) {
          if (
            completion.terminalOutcome !== "published" &&
            completion.terminalOutcome !== "superseded"
          ) {
            continue;
          }
          const item = state.items[completion.itemKey];
          if (
            !item ||
            item.revision !== completion.revision ||
            !exactReviewQueueIsPublication(item)
          ) {
            continue;
          }
          delete state.items[completion.itemKey];
          if (completion.terminalOutcome === "published") published += 1;
          else superseded += 1;
        }
        if (!published && !superseded) return;
        this.writeStateSync(state);
        this.incrementQueueMetricsSync({
          publicationCompleted: published + superseded,
          publicationPublished: published,
          publicationSuperseded: superseded,
        });
      },
    );
    if (!batch) return json({ error: "batch_lease_not_active" }, 409);
    if (acceptedCount) await this.scheduleNext(this.readStateSync(), Date.now());
    return json({
      ok: true,
      accepted: acceptedCount,
      skipped: completions.length - acceptedCount,
      batch: exactReviewPublicationBatchJson(batch),
    });
  }

  private async initializeStorage() {
    this.ensureStorageSchemaSync();
    this.batchStore.ensureSchemaSync();
    let meta = this.readStorageMetaSync();
    let migratedLegacy = false;
    const legacy = this.storage.kv.get(EXACT_REVIEW_QUEUE_STATE_KEY) as
      | LegacyExactReviewQueueState
      | undefined;
    if (!meta) {
      const migratedAt = Date.now();
      this.migratedAt = migratedAt;
      this.storage.transactionSync(() => {
        if (this.readStorageMetaSync()) return;

        const itemRows = Object.entries(
          legacy?.items && typeof legacy.items === "object" ? legacy.items : {},
        ).map(([itemKey, item]) => [itemKey, JSON.stringify({ ...item, key: itemKey })]);
        this.insertMigrationRowsSync(
          EXACT_REVIEW_QUEUE_ITEM_TABLE,
          ["item_key", "item_json"],
          itemRows,
        );

        const receiptCutoff = migratedAt - EXACT_REVIEW_QUEUE_DELIVERY_TTL_MS;
        const receiptRows = Object.entries(
          legacy?.deliveries && typeof legacy.deliveries === "object" ? legacy.deliveries : {},
        )
          .filter(
            ([deliveryId, receivedAt]) =>
              !deliveryId.startsWith(EXACT_REVIEW_QUEUE_LEGACY_GENERATION_PREFIX) &&
              Number.isSafeInteger(receivedAt) &&
              receivedAt > receiptCutoff,
          )
          .map(([deliveryId, receivedAt]) => [deliveryId, receivedAt]);
        this.insertMigrationRowsSync(
          EXACT_REVIEW_QUEUE_DELIVERY_TABLE,
          ["delivery_id", "received_at"],
          receiptRows,
        );

        const dispatcherJson =
          legacy?.dispatcher && typeof legacy.dispatcher === "object"
            ? JSON.stringify(legacy.dispatcher)
            : null;
        this.storage.sql.exec(
          `INSERT INTO ${EXACT_REVIEW_QUEUE_META_TABLE}
             (singleton_id, schema_version, migrated_at, storage_generation, dispatcher_json,
              shed_since_reset)
           VALUES (1, ?, ?, 1, ?, ?)`,
          EXACT_REVIEW_QUEUE_STORAGE_SCHEMA_VERSION,
          migratedAt,
          dispatcherJson,
          exactReviewShedSinceReset(legacy || { items: {} }),
        );
        migratedLegacy = true;
        this.syncLegacyCompatibilitySync(this.readStateSync());
      });
      meta = this.readStorageMetaSync();
    }
    if (!meta || Number(meta.schema_version) !== EXACT_REVIEW_QUEUE_STORAGE_SCHEMA_VERSION) {
      throw new Error(`unsupported exact-review queue storage schema ${meta?.schema_version}`);
    }
    if (!Number.isSafeInteger(meta.storage_generation) || meta.storage_generation < 1) {
      throw new Error("invalid exact-review queue storage generation");
    }
    if (!Number.isSafeInteger(meta.migrated_at) || meta.migrated_at < 1) {
      throw new Error("invalid exact-review queue migration time");
    }
    this.migratedAt = Number(meta.migrated_at);
    // Reconcile a surviving generation even after the ordinary shadow window:
    // an actual rollback can keep mutating it while the new Worker is absent.
    if (!migratedLegacy) {
      this.storage.transactionSync(() => {
        if (legacy) this.reconcileLegacyRollbackSync(legacy, meta);
        this.syncLegacyCompatibilitySync(this.readStateSync());
      });
    }
  }

  private ensureStorageSchemaSync() {
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_QUEUE_META_TABLE} (
         singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
         schema_version INTEGER NOT NULL,
         migrated_at INTEGER NOT NULL,
         storage_generation INTEGER NOT NULL,
         dispatcher_json TEXT,
         shed_since_reset INTEGER NOT NULL DEFAULT 0
       ) STRICT`,
    );
    const hasShedCounter = Array.from(
      this.storage.sql.exec(
        `SELECT name FROM pragma_table_info('${EXACT_REVIEW_QUEUE_META_TABLE}')
          WHERE name = 'shed_since_reset'`,
      ),
    ).length;
    if (!hasShedCounter) {
      this.storage.sql.exec(
        `ALTER TABLE ${EXACT_REVIEW_QUEUE_META_TABLE}
           ADD COLUMN shed_since_reset INTEGER NOT NULL DEFAULT 0`,
      );
    }
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_QUEUE_ITEM_TABLE} (
         item_key TEXT PRIMARY KEY,
         item_json TEXT NOT NULL
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_QUEUE_DELIVERY_TABLE} (
         delivery_id TEXT PRIMARY KEY,
         received_at INTEGER NOT NULL
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${STATE_APPEND_WINDOW_TABLE} (
         seq INTEGER PRIMARY KEY AUTOINCREMENT,
         kind TEXT NOT NULL CHECK (kind IN ('sweep_status', 'comment_router', 'apply_proof')),
         record_key TEXT NOT NULL,
         payload_json TEXT NOT NULL,
         payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
         produced_at TEXT NOT NULL,
         delivery_id TEXT NOT NULL,
         drain_token TEXT
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS state_append_window_drain_seq
         ON ${STATE_APPEND_WINDOW_TABLE} (drain_token, seq)`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${STATE_APPEND_RECEIPT_TABLE} (
         delivery_id TEXT PRIMARY KEY,
         received_at INTEGER NOT NULL
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS state_append_receipts_received_at
         ON ${STATE_APPEND_RECEIPT_TABLE} (received_at, delivery_id)`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${STATE_APPEND_DRAIN_TABLE} (
         drain_token TEXT PRIMARY KEY,
         leased_at INTEGER NOT NULL,
         expires_at INTEGER NOT NULL
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS state_append_drains_expiry
         ON ${STATE_APPEND_DRAIN_TABLE} (expires_at, drain_token)`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${STATE_APPEND_META_TABLE} (
         singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
         shed_since_reset INTEGER NOT NULL DEFAULT 0 CHECK (shed_since_reset >= 0)
       ) STRICT`,
    );
    this.storage.sql.exec(
      `INSERT OR IGNORE INTO ${STATE_APPEND_META_TABLE} (singleton_id) VALUES (1)`,
    );
    // Flow telemetry is independent of queue rollback compatibility. A
    // separate singleton keeps cumulative lane counters monotonic without
    // changing the normalized queue schema or its legacy shadow contract.
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_QUEUE_METRICS_TABLE} (
         singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
         review_enqueued_total INTEGER NOT NULL DEFAULT 0 CHECK (review_enqueued_total >= 0),
         review_completed_total INTEGER NOT NULL DEFAULT 0 CHECK (review_completed_total >= 0),
         publication_enqueued_total INTEGER NOT NULL DEFAULT 0
           CHECK (publication_enqueued_total >= 0),
         publication_completed_total INTEGER NOT NULL CHECK (publication_completed_total >= 0)
       ) STRICT`,
    );
    for (const column of [
      "review_enqueued_total",
      "review_completed_total",
      "publication_enqueued_total",
      "publication_published_total",
      "publication_superseded_total",
      "publication_retried_total",
      "publication_dead_lettered_total",
      "publication_refreshed_total",
    ]) {
      const present = Array.from(
        this.storage.sql.exec(
          `SELECT name FROM pragma_table_info('${EXACT_REVIEW_QUEUE_METRICS_TABLE}')
            WHERE name = ?`,
          column,
        ),
      ).length;
      if (!present) {
        const definition = `${column} INTEGER NOT NULL DEFAULT 0 CHECK (${column} >= 0)`;
        this.storage.sql.exec(
          `ALTER TABLE ${EXACT_REVIEW_QUEUE_METRICS_TABLE}
             ADD COLUMN ${definition}`,
        );
      }
    }
    this.storage.sql.exec(
      `INSERT OR IGNORE INTO ${EXACT_REVIEW_QUEUE_METRICS_TABLE}
         (singleton_id, publication_completed_total) VALUES (1, 0)`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_queue_deliveries_received_at
         ON ${EXACT_REVIEW_QUEUE_DELIVERY_TABLE} (received_at, delivery_id)`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_QUEUE_METRIC_BUCKET_TABLE} (
         bucket_start INTEGER PRIMARY KEY,
         review_enqueued INTEGER NOT NULL DEFAULT 0 CHECK (review_enqueued >= 0),
         review_completed INTEGER NOT NULL DEFAULT 0 CHECK (review_completed >= 0),
         review_retried INTEGER NOT NULL DEFAULT 0 CHECK (review_retried >= 0),
         review_shed INTEGER NOT NULL DEFAULT 0 CHECK (review_shed >= 0),
         publication_enqueued INTEGER NOT NULL DEFAULT 0 CHECK (publication_enqueued >= 0),
         publication_resolved INTEGER NOT NULL DEFAULT 0 CHECK (publication_resolved >= 0),
         publication_published INTEGER NOT NULL DEFAULT 0 CHECK (publication_published >= 0),
         publication_superseded INTEGER NOT NULL DEFAULT 0 CHECK (publication_superseded >= 0),
         publication_retried INTEGER NOT NULL DEFAULT 0 CHECK (publication_retried >= 0),
         publication_dead_lettered INTEGER NOT NULL DEFAULT 0
           CHECK (publication_dead_lettered >= 0)
       ) STRICT`,
    );
    for (const column of ["review_enqueued", "review_completed", "review_retried", "review_shed"]) {
      const present = Array.from(
        this.storage.sql.exec(
          `SELECT name FROM pragma_table_info('${EXACT_REVIEW_QUEUE_METRIC_BUCKET_TABLE}')
            WHERE name = ?`,
          column,
        ),
      ).length;
      if (!present) {
        const definition = `${column} INTEGER NOT NULL DEFAULT 0 CHECK (${column} >= 0)`;
        this.storage.sql.exec(
          `ALTER TABLE ${EXACT_REVIEW_QUEUE_METRIC_BUCKET_TABLE}
             ADD COLUMN ${definition}`,
        );
      }
    }
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_QUEUE_DEAD_LETTER_TABLE} (
         dead_letter_id TEXT PRIMARY KEY,
         item_key TEXT NOT NULL,
         revision INTEGER NOT NULL CHECK (revision >= 1),
         target_repo TEXT NOT NULL,
         item_number INTEGER NOT NULL CHECK (item_number >= 1),
         producer_run_id TEXT NOT NULL,
         producer_run_attempt INTEGER NOT NULL CHECK (producer_run_attempt >= 1),
         artifact_name TEXT NOT NULL,
         reason_code TEXT NOT NULL,
         attempts INTEGER NOT NULL CHECK (attempts >= 1),
         first_failed_at INTEGER NOT NULL,
         last_failed_at INTEGER NOT NULL,
         item_json TEXT NOT NULL,
         error_fingerprint TEXT,
         status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'replayed', 'resolved')),
         replay_key TEXT,
         resolution_note TEXT,
         resolved_at INTEGER
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_queue_dead_letters_status
         ON ${EXACT_REVIEW_QUEUE_DEAD_LETTER_TABLE}
         (status, last_failed_at, dead_letter_id)`,
    );
    // Review telemetry is intentionally additive to the v1 queue protocol.
    // PR 674 can populate generation and operation_id inside record_json
    // without coupling this observation schema to its queue tuple rollout.
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_REVIEW_TELEMETRY_TABLE} (
         repo TEXT NOT NULL,
         item_number INTEGER NOT NULL CHECK (item_number >= 1),
         run_id TEXT NOT NULL,
         run_attempt INTEGER NOT NULL CHECK (run_attempt >= 1),
         status TEXT NOT NULL CHECK (status IN ('refreshing', 'completed')),
         outcome TEXT,
         trigger_lane TEXT,
         trigger_origin TEXT,
         terminal_at INTEGER,
         updated_at INTEGER NOT NULL,
         lease_expires_at INTEGER,
         generation INTEGER,
         operation_id TEXT,
         queue_ms INTEGER,
         claim_ms INTEGER,
         review_ms INTEGER,
         publication_ms INTEGER,
         total_ms INTEGER,
         record_json TEXT NOT NULL,
         PRIMARY KEY (repo, item_number, run_id, run_attempt)
       ) STRICT`,
    );
    for (const [column, definition] of [
      ["lease_expires_at", "INTEGER"],
      ["outcome", "TEXT"],
      ["trigger_lane", "TEXT"],
      ["trigger_origin", "TEXT"],
      ["terminal_at", "INTEGER"],
      ["generation", "INTEGER"],
      ["operation_id", "TEXT"],
      ["queue_ms", "INTEGER"],
      ["claim_ms", "INTEGER"],
      ["review_ms", "INTEGER"],
      ["publication_ms", "INTEGER"],
      ["total_ms", "INTEGER"],
    ]) {
      const present = Array.from(
        this.storage.sql.exec(
          `SELECT name FROM pragma_table_info('${EXACT_REVIEW_REVIEW_TELEMETRY_TABLE}') WHERE name = ?`,
          column,
        ),
      ).length;
      if (!present) {
        this.storage.sql.exec(
          `ALTER TABLE ${EXACT_REVIEW_REVIEW_TELEMETRY_TABLE} ADD COLUMN ${column} ${definition}`,
        );
      }
    }
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_review_telemetry_status
         ON ${EXACT_REVIEW_REVIEW_TELEMETRY_TABLE} (status, updated_at)`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_review_telemetry_aggregate
         ON ${EXACT_REVIEW_REVIEW_TELEMETRY_TABLE}
         (trigger_lane, repo, terminal_at, outcome)`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_review_telemetry_operation
         ON ${EXACT_REVIEW_REVIEW_TELEMETRY_TABLE} (operation_id, terminal_at)`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_RUN_TELEMETRY_TABLE} (
         run_id TEXT NOT NULL,
         run_attempt INTEGER NOT NULL CHECK (run_attempt >= 1),
         workflow_outcome TEXT NOT NULL,
         trigger_lane TEXT NOT NULL,
         trigger_origin TEXT NOT NULL,
         target_repo TEXT,
         completed_at INTEGER NOT NULL,
         record_json TEXT NOT NULL,
         PRIMARY KEY (run_id, run_attempt)
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_run_telemetry_aggregate
         ON ${EXACT_REVIEW_RUN_TELEMETRY_TABLE}
         (trigger_lane, target_repo, completed_at, workflow_outcome)`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_STATE_WRITER_OPERATION_TABLE} (
         operation_id TEXT PRIMARY KEY,
         observed_at INTEGER NOT NULL,
         mode TEXT NOT NULL CHECK (mode IN ('single_item', 'batch')),
         started_at INTEGER NOT NULL,
         finished_at INTEGER NOT NULL,
         wait_ms INTEGER NOT NULL,
         acquire_attempts INTEGER NOT NULL,
         acquired INTEGER NOT NULL,
         hold_ms INTEGER,
         renewals INTEGER NOT NULL,
         released INTEGER,
         git_duration_ms INTEGER NOT NULL,
         git_processes INTEGER NOT NULL,
         commit_count INTEGER NOT NULL,
         materialized_items INTEGER NOT NULL,
         configured_batch_size INTEGER NOT NULL,
         actual_batch_size INTEGER NOT NULL,
         batch_wait_ms INTEGER,
         outcome TEXT NOT NULL,
         payload_hash TEXT NOT NULL
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_state_writer_operations_finished
         ON ${EXACT_REVIEW_STATE_WRITER_OPERATION_TABLE} (finished_at, mode)`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_STATE_WRITER_LIVE_TABLE} (
         operation_id TEXT PRIMARY KEY,
         mode TEXT NOT NULL,
         phase TEXT NOT NULL,
         sequence INTEGER NOT NULL,
         observed_at INTEGER NOT NULL,
         configured_batch_size INTEGER NOT NULL,
         actual_batch_size INTEGER NOT NULL
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_state_writer_live_observed
         ON ${EXACT_REVIEW_STATE_WRITER_LIVE_TABLE} (observed_at)`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_STATE_WRITER_DIAGNOSTICS_TABLE} (
         singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
         accepted_terminal_total INTEGER NOT NULL DEFAULT 0,
         duplicate_terminal_total INTEGER NOT NULL DEFAULT 0,
         rejected_terminal_total INTEGER NOT NULL DEFAULT 0,
         conflicted_terminal_total INTEGER NOT NULL DEFAULT 0,
         accepted_progress_total INTEGER NOT NULL DEFAULT 0,
         rejected_progress_total INTEGER NOT NULL DEFAULT 0,
         state_commits_total INTEGER NOT NULL DEFAULT 0,
         materialized_items_total INTEGER NOT NULL DEFAULT 0,
         contention_timeouts_total INTEGER NOT NULL DEFAULT 0,
         last_observed_at INTEGER
       ) STRICT`,
    );
    this.ensureStateWriterDiagnosticColumnsSync();
    this.storage.sql.exec(
      `INSERT OR IGNORE INTO ${EXACT_REVIEW_STATE_WRITER_DIAGNOSTICS_TABLE} (singleton_id) VALUES (1)`,
    );
  }

  private ensureStateWriterDiagnosticColumnsSync() {
    const columns = new Set(
      Array.from(
        this.storage.sql.exec(
          `SELECT name FROM pragma_table_info('${EXACT_REVIEW_STATE_WRITER_DIAGNOSTICS_TABLE}')`,
        ),
      ).map((row) => String((row as { name?: string }).name || "")),
    );
    for (const column of [
      "state_commits_total",
      "materialized_items_total",
      "contention_timeouts_total",
    ]) {
      if (!columns.has(column)) {
        this.storage.sql.exec(
          `ALTER TABLE ${EXACT_REVIEW_STATE_WRITER_DIAGNOSTICS_TABLE}
             ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`,
        );
      }
    }
  }

  private readStorageMetaSync() {
    return Array.from(
      this.storage.sql.exec(
        `SELECT schema_version, migrated_at, storage_generation, dispatcher_json,
                shed_since_reset
           FROM ${EXACT_REVIEW_QUEUE_META_TABLE}
          WHERE singleton_id = 1`,
      ),
    )[0] as ExactReviewQueueStorageMeta | undefined;
  }

  private insertMigrationRowsSync(table: string, columns: string[], rows: unknown[][]) {
    for (let offset = 0; offset < rows.length; offset += EXACT_REVIEW_QUEUE_SQL_BINDING_ROW_BATCH) {
      const batch = rows.slice(offset, offset + EXACT_REVIEW_QUEUE_SQL_BINDING_ROW_BATCH);
      const placeholders = batch.map(() => `(${columns.map(() => "?").join(", ")})`).join(", ");
      this.storage.sql.exec(
        `INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES ${placeholders}`,
        ...batch.flat(),
      );
    }
  }

  private readDeliveryReceiptsByIdSync(deliveryIds: string[]) {
    const receipts = new Map<string, number>();
    for (
      let offset = 0;
      offset < deliveryIds.length;
      offset += EXACT_REVIEW_QUEUE_SQL_BINDING_ROW_BATCH
    ) {
      const batch = deliveryIds.slice(offset, offset + EXACT_REVIEW_QUEUE_SQL_BINDING_ROW_BATCH);
      const placeholders = batch.map(() => "?").join(", ");
      for (const row of this.storage.sql.exec(
        `SELECT delivery_id, received_at
           FROM ${EXACT_REVIEW_QUEUE_DELIVERY_TABLE}
          WHERE delivery_id IN (${placeholders})`,
        ...batch,
      ) as Iterable<{ delivery_id: string; received_at: number }>) {
        receipts.set(row.delivery_id, row.received_at);
      }
    }
    return receipts;
  }

  private reconcileLegacyRollbackSync(
    legacy: LegacyExactReviewQueueState,
    meta: ExactReviewQueueStorageMeta,
  ) {
    const legacyState = this.normalizeLegacyState(legacy);
    const sqlState = this.readStateSync();
    const stateMatches = stableJson(legacyState) === stableJson(sqlState);
    const { generation: legacyGeneration, receipts } = this.readLegacyBridge(legacy);
    const sqlGeneration = Number(meta.storage_generation);

    if (legacyGeneration !== undefined && legacyGeneration > sqlGeneration) {
      throw new Error(
        `invalid exact-review legacy rollback generation ${legacyGeneration} > ${sqlGeneration}`,
      );
    }
    if (legacyGeneration !== undefined && legacyGeneration < sqlGeneration && !stateMatches) {
      // A stale shadow can mean either a failed mirror write by this version or
      // rollback-era mutations by the old version. Neither side is safe to discard.
      throw new Error(
        `ambiguous exact-review legacy rollback state at generations ${legacyGeneration} and ${sqlGeneration}`,
      );
    }
    if (legacyGeneration === undefined && !stateMatches) {
      throw new Error("ambiguous exact-review legacy rollback state without a generation marker");
    }

    const replaceState = legacyGeneration === sqlGeneration && !stateMatches;
    const sqlReceipts = this.readDeliveryReceiptsByIdSync(
      receipts.map(([deliveryId]) => String(deliveryId)),
    );
    const receiptChanges: unknown[][] = [];
    if (legacyGeneration === sqlGeneration) {
      const latestRollbackTime = Date.now() + EXACT_REVIEW_QUEUE_ROLLBACK_CLOCK_SKEW_MS;
      for (const [deliveryId, receivedAt] of receipts) {
        const sqlReceivedAt = sqlReceipts.get(String(deliveryId));
        if (
          sqlReceivedAt !== undefined &&
          Number(receivedAt) === this.legacyReceiptTimestamp(sqlReceivedAt)
        ) {
          continue;
        }
        if (!Number.isSafeInteger(receivedAt) || Number(receivedAt) > latestRollbackTime) {
          throw new Error(`invalid exact-review rollback receipt ${deliveryId}`);
        }
        receiptChanges.push([deliveryId, receivedAt]);
      }
    } else if (legacyGeneration !== undefined) {
      for (const [deliveryId, receivedAt] of receipts) {
        const sqlReceivedAt = sqlReceipts.get(String(deliveryId));
        if (
          sqlReceivedAt === undefined ||
          Number(receivedAt) !== this.legacyReceiptTimestamp(sqlReceivedAt)
        ) {
          throw new Error(
            `ambiguous exact-review legacy rollback receipt at generations ${legacyGeneration} and ${sqlGeneration}`,
          );
        }
      }
    }

    if (replaceState) {
      this.storage.sql.exec(`DELETE FROM ${EXACT_REVIEW_QUEUE_ITEM_TABLE}`);
      this.insertMigrationRowsSync(
        EXACT_REVIEW_QUEUE_ITEM_TABLE,
        ["item_key", "item_json"],
        Object.entries(legacyState.items).map(([itemKey, item]) => [itemKey, JSON.stringify(item)]),
      );
    }
    this.insertMigrationRowsSync(
      EXACT_REVIEW_QUEUE_DELIVERY_TABLE,
      ["delivery_id", "received_at"],
      receiptChanges,
    );
    if (!replaceState && receiptChanges.length === 0) return;
    this.storage.sql.exec(
      `UPDATE ${EXACT_REVIEW_QUEUE_META_TABLE}
          SET dispatcher_json = ?, shed_since_reset = ?,
              storage_generation = storage_generation + 1
        WHERE singleton_id = 1 AND storage_generation = ?`,
      replaceState && legacyState.dispatcher
        ? JSON.stringify(legacyState.dispatcher)
        : replaceState
          ? null
          : meta.dispatcher_json,
      replaceState ? exactReviewShedSinceReset(legacyState) : Number(meta.shed_since_reset || 0),
      sqlGeneration,
    );
    const reconciledGeneration = this.readStorageMetaSync()?.storage_generation;
    if (reconciledGeneration !== sqlGeneration + 1) {
      throw new Error("exact-review legacy rollback reconciliation lost its generation race");
    }
  }

  private normalizeLegacyState(legacy: LegacyExactReviewQueueState): ExactReviewQueueState {
    const items = Object.fromEntries(
      Object.entries(legacy.items && typeof legacy.items === "object" ? legacy.items : {}).map(
        ([itemKey, item]) => [itemKey, { ...item, key: itemKey }],
      ),
    ) as Record<string, ExactReviewQueueItem>;
    return {
      items,
      shedSinceReset: exactReviewShedSinceReset(legacy),
      ...(legacy.dispatcher && typeof legacy.dispatcher === "object"
        ? { dispatcher: legacy.dispatcher }
        : {}),
    };
  }

  private readLegacyBridge(legacy: LegacyExactReviewQueueState) {
    const deliveries =
      legacy.deliveries && typeof legacy.deliveries === "object" ? legacy.deliveries : {};
    const generationMarkers = Object.entries(deliveries).filter(([deliveryId]) =>
      deliveryId.startsWith(EXACT_REVIEW_QUEUE_LEGACY_GENERATION_PREFIX),
    );
    if (generationMarkers.length > 1) {
      throw new Error("invalid exact-review legacy rollback generation markers");
    }

    let generation: number | undefined;
    if (generationMarkers.length === 1) {
      const [deliveryId, markedAt] = generationMarkers[0];
      const rawGeneration = deliveryId.slice(EXACT_REVIEW_QUEUE_LEGACY_GENERATION_PREFIX.length);
      generation = Number(rawGeneration);
      if (
        !/^\d+$/.test(rawGeneration) ||
        !Number.isSafeInteger(generation) ||
        generation < 1 ||
        markedAt !== Number.MAX_SAFE_INTEGER
      ) {
        throw new Error("invalid exact-review legacy rollback generation marker");
      }
    }

    const receiptCutoff = Date.now() - EXACT_REVIEW_QUEUE_DELIVERY_TTL_MS;
    const receipts = Object.entries(deliveries)
      .filter(
        ([deliveryId, receivedAt]) =>
          !deliveryId.startsWith(EXACT_REVIEW_QUEUE_LEGACY_GENERATION_PREFIX) &&
          Number.isSafeInteger(receivedAt) &&
          receivedAt > receiptCutoff,
      )
      .map(([deliveryId, receivedAt]) => [deliveryId, receivedAt]);
    return { generation, receipts };
  }

  private readStateSync(): ExactReviewQueueState {
    const meta = this.readStorageMetaSync();
    if (!meta || Number(meta.schema_version) !== EXACT_REVIEW_QUEUE_STORAGE_SCHEMA_VERSION) {
      throw new Error("exact-review queue storage is not initialized");
    }

    const items: Record<string, ExactReviewQueueItem> = {};
    const baselineItems = new Map<string, string>();
    for (const row of this.storage.sql.exec(
      `SELECT item_key, item_json FROM ${EXACT_REVIEW_QUEUE_ITEM_TABLE}`,
    ) as Iterable<{ item_key: string; item_json: string }>) {
      let item: ExactReviewQueueItem;
      try {
        item = JSON.parse(row.item_json) as ExactReviewQueueItem;
      } catch {
        throw new Error(`invalid exact-review queue item JSON for ${row.item_key}`);
      }
      if (!item || typeof item !== "object" || item.key !== row.item_key) {
        throw new Error(`invalid exact-review queue item for ${row.item_key}`);
      }
      items[row.item_key] = item;
      baselineItems.set(row.item_key, row.item_json);
    }

    let dispatcher: ExactReviewQueueState["dispatcher"];
    if (meta.dispatcher_json) {
      try {
        dispatcher = JSON.parse(meta.dispatcher_json) as ExactReviewQueueState["dispatcher"];
      } catch {
        throw new Error("invalid exact-review queue dispatcher JSON");
      }
    }
    const state = {
      items,
      dispatcher,
      shedSinceReset: Math.max(0, Number(meta.shed_since_reset || 0)),
    };
    this.baselines.set(state, {
      items: baselineItems,
      dispatcherJson: meta.dispatcher_json,
    });
    return state;
  }

  private writeState(
    state: ExactReviewQueueState,
    metricDelta: ExactReviewQueueMetricDelta = {},
    publicationFeedback?: ExactReviewPublicationFeedback,
    deadLetter?: ExactReviewDeadLetterInsert,
  ) {
    this.storage.transactionSync(() => {
      this.writeStateSync(state);
      this.incrementQueueMetricsSync(metricDelta);
      if (publicationFeedback) this.applyPublicationFeedbackSync(publicationFeedback);
      if (deadLetter) this.insertDeadLetterSync(deadLetter);
    });
  }

  private publicationControlSync() {
    return exactReviewPublicationControl(
      this.env,
      this.storage.kv.get(EXACT_REVIEW_PUBLICATION_CONTROL_KEY),
    );
  }

  private refreshPublicationControlSync(state: ExactReviewQueueState, now: number) {
    const current = this.publicationControlSync();
    const publications = Object.values(state.items).filter(exactReviewQueueIsPublication);
    const pending = publications.filter((item) => item.state === "pending");
    const oldestPendingAt = pending.reduce<number | null>(
      (oldest, item) => (oldest === null ? item.createdAt : Math.min(oldest, item.createdAt)),
      null,
    );
    const flow = this.publicationFlowSummarySync(now).last_15_minutes;
    const next = exactReviewPublicationControlAfterDemand(this.env, current, {
      at: now,
      backlog: pending.length,
      oldestPendingAgeMs: oldestPendingAt === null ? 0 : Math.max(0, now - oldestPendingAt),
      netDrainRatePerHour: flow.net_drain_rate_per_hour,
    });
    if (stableJson(next) !== stableJson(current)) {
      this.storage.kv.put(EXACT_REVIEW_PUBLICATION_CONTROL_KEY, next);
    }
    return next;
  }

  private applyPublicationFeedbackSync(feedback: ExactReviewPublicationFeedback) {
    const current = this.publicationControlSync();
    const next = exactReviewPublicationControlAfterFeedback(this.env, current, feedback);
    this.storage.kv.put(EXACT_REVIEW_PUBLICATION_CONTROL_KEY, next);
  }

  private queueMetricTotalsSync(): ExactReviewQueueMetricTotals {
    const row = Array.from(
      this.storage.sql.exec(
        `SELECT review_enqueued_total, review_completed_total,
                publication_enqueued_total, publication_completed_total,
                publication_published_total, publication_superseded_total,
                publication_retried_total, publication_dead_lettered_total,
                publication_refreshed_total
           FROM ${EXACT_REVIEW_QUEUE_METRICS_TABLE}
          WHERE singleton_id = 1`,
      ),
    )[0] as
      | {
          review_enqueued_total?: number;
          review_completed_total?: number;
          publication_enqueued_total?: number;
          publication_completed_total?: number;
          publication_published_total?: number;
          publication_superseded_total?: number;
          publication_retried_total?: number;
          publication_dead_lettered_total?: number;
          publication_refreshed_total?: number;
        }
      | undefined;
    return {
      review: {
        enqueued: exactReviewMetricTotal(row?.review_enqueued_total),
        completed: exactReviewMetricTotal(row?.review_completed_total),
      },
      publication: {
        enqueued: exactReviewMetricTotal(row?.publication_enqueued_total),
        completed: exactReviewMetricTotal(row?.publication_completed_total),
        published: exactReviewMetricTotal(row?.publication_published_total),
        superseded: exactReviewMetricTotal(row?.publication_superseded_total),
        retried: exactReviewMetricTotal(row?.publication_retried_total),
        deadLettered: exactReviewMetricTotal(row?.publication_dead_lettered_total),
        refreshed: exactReviewMetricTotal(row?.publication_refreshed_total),
      },
    };
  }

  private incrementQueueMetricsSync(delta: ExactReviewQueueMetricDelta) {
    const reviewEnqueued = exactReviewMetricDelta(delta.reviewEnqueued);
    const reviewCompleted = exactReviewMetricDelta(delta.reviewCompleted);
    const reviewRetried = exactReviewMetricDelta(delta.reviewRetried);
    const reviewShed = exactReviewMetricDelta(delta.reviewShed);
    const publicationEnqueued = exactReviewMetricDelta(delta.publicationEnqueued);
    const publicationCompleted = exactReviewMetricDelta(delta.publicationCompleted);
    const publicationPublished = exactReviewMetricDelta(delta.publicationPublished);
    const publicationSuperseded = exactReviewMetricDelta(delta.publicationSuperseded);
    const publicationRetried = exactReviewMetricDelta(delta.publicationRetried);
    const publicationDeadLettered = exactReviewMetricDelta(delta.publicationDeadLettered);
    const publicationRefreshed = exactReviewMetricDelta(delta.publicationRefreshed);
    if (
      !reviewEnqueued &&
      !reviewCompleted &&
      !reviewRetried &&
      !reviewShed &&
      !publicationEnqueued &&
      !publicationCompleted &&
      !publicationPublished &&
      !publicationSuperseded &&
      !publicationRetried &&
      !publicationDeadLettered &&
      !publicationRefreshed
    ) {
      return;
    }
    this.storage.sql.exec(
      `UPDATE ${EXACT_REVIEW_QUEUE_METRICS_TABLE}
          SET review_enqueued_total = review_enqueued_total + ?,
              review_completed_total = review_completed_total + ?,
              publication_enqueued_total = publication_enqueued_total + ?,
              publication_completed_total = publication_completed_total + ?,
              publication_published_total = publication_published_total + ?,
              publication_superseded_total = publication_superseded_total + ?,
              publication_retried_total = publication_retried_total + ?,
              publication_dead_lettered_total = publication_dead_lettered_total + ?,
              publication_refreshed_total = publication_refreshed_total + ?
        WHERE singleton_id = 1`,
      reviewEnqueued,
      reviewCompleted,
      publicationEnqueued,
      publicationCompleted,
      publicationPublished,
      publicationSuperseded,
      publicationRetried,
      publicationDeadLettered,
      publicationRefreshed,
    );
    this.incrementQueueMetricBucketSync({
      reviewEnqueued,
      reviewCompleted,
      reviewRetried,
      reviewShed,
      publicationEnqueued,
      publicationCompleted,
      publicationPublished,
      publicationSuperseded,
      publicationRetried,
      publicationDeadLettered,
    });
  }

  private incrementQueueMetricBucketSync({
    reviewEnqueued,
    reviewCompleted,
    reviewRetried,
    reviewShed,
    publicationEnqueued,
    publicationCompleted,
    publicationPublished,
    publicationSuperseded,
    publicationRetried,
    publicationDeadLettered,
  }: {
    reviewEnqueued: number;
    reviewCompleted: number;
    reviewRetried: number;
    reviewShed: number;
    publicationEnqueued: number;
    publicationCompleted: number;
    publicationPublished: number;
    publicationSuperseded: number;
    publicationRetried: number;
    publicationDeadLettered: number;
  }) {
    if (
      !reviewEnqueued &&
      !reviewCompleted &&
      !reviewRetried &&
      !reviewShed &&
      !publicationEnqueued &&
      !publicationCompleted &&
      !publicationPublished &&
      !publicationSuperseded &&
      !publicationRetried &&
      !publicationDeadLettered
    ) {
      return;
    }
    const bucketStart =
      Math.floor(Date.now() / EXACT_REVIEW_QUEUE_METRIC_BUCKET_MS) *
      EXACT_REVIEW_QUEUE_METRIC_BUCKET_MS;
    this.storage.sql.exec(
      `INSERT INTO ${EXACT_REVIEW_QUEUE_METRIC_BUCKET_TABLE}
         (bucket_start, review_enqueued, review_completed, review_retried, review_shed,
          publication_enqueued, publication_resolved, publication_published,
          publication_superseded, publication_retried, publication_dead_lettered)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(bucket_start) DO UPDATE SET
         review_enqueued = review_enqueued + excluded.review_enqueued,
         review_completed = review_completed + excluded.review_completed,
         review_retried = review_retried + excluded.review_retried,
         review_shed = review_shed + excluded.review_shed,
         publication_enqueued = publication_enqueued + excluded.publication_enqueued,
         publication_resolved = publication_resolved + excluded.publication_resolved,
         publication_published = publication_published + excluded.publication_published,
         publication_superseded = publication_superseded + excluded.publication_superseded,
         publication_retried = publication_retried + excluded.publication_retried,
         publication_dead_lettered =
           publication_dead_lettered + excluded.publication_dead_lettered`,
      bucketStart,
      reviewEnqueued,
      reviewCompleted,
      reviewRetried,
      reviewShed,
      publicationEnqueued,
      publicationCompleted,
      publicationPublished,
      publicationSuperseded,
      publicationRetried,
      publicationDeadLettered,
    );
  }

  private deadLetterCapacityAvailableSync(deadLetterId: string) {
    const existing = Array.from(
      this.storage.sql.exec(
        `SELECT 1 AS present
           FROM ${EXACT_REVIEW_QUEUE_DEAD_LETTER_TABLE}
          WHERE dead_letter_id = ?`,
        deadLetterId,
      ),
    ).length;
    if (existing) return true;
    const row = Array.from(
      this.storage.sql.exec(
        `SELECT COUNT(*) AS open_count
           FROM ${EXACT_REVIEW_QUEUE_DEAD_LETTER_TABLE}
          WHERE status = 'open'`,
      ),
    )[0] as { open_count?: number } | undefined;
    return Number(row?.open_count || 0) < EXACT_REVIEW_QUEUE_DEAD_LETTER_LIMIT;
  }

  private insertDeadLetterSync(deadLetter: ExactReviewDeadLetterInsert) {
    this.storage.sql.exec(
      `INSERT INTO ${EXACT_REVIEW_QUEUE_DEAD_LETTER_TABLE}
         (dead_letter_id, item_key, revision, target_repo, item_number, producer_run_id,
          producer_run_attempt, artifact_name, reason_code, attempts, first_failed_at,
          last_failed_at, item_json, error_fingerprint, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
       ON CONFLICT(dead_letter_id) DO UPDATE SET
         reason_code = excluded.reason_code,
         attempts = excluded.attempts,
         last_failed_at = excluded.last_failed_at,
         error_fingerprint = excluded.error_fingerprint,
         status = 'open', replay_key = NULL, resolution_note = NULL, resolved_at = NULL`,
      deadLetter.id,
      deadLetter.itemKey,
      deadLetter.revision,
      deadLetter.targetRepo,
      deadLetter.itemNumber,
      deadLetter.producerRunId,
      deadLetter.producerRunAttempt,
      deadLetter.artifactName,
      deadLetter.reasonCode,
      deadLetter.attempts,
      deadLetter.firstFailedAt,
      deadLetter.lastFailedAt,
      deadLetter.itemJson,
      deadLetter.errorFingerprint || null,
    );
  }

  private drainParkedDeadLettersSync(state: ExactReviewQueueState, now: number) {
    const openRow = Array.from(
      this.storage.sql.exec(
        `SELECT COUNT(*) AS open_count
           FROM ${EXACT_REVIEW_QUEUE_DEAD_LETTER_TABLE}
          WHERE status = 'open'`,
      ),
    )[0] as { open_count?: number } | undefined;
    let available = Math.max(
      0,
      EXACT_REVIEW_QUEUE_DEAD_LETTER_LIMIT - Number(openRow?.open_count || 0),
    );
    let moved = 0;
    for (const item of Object.values(state.items).sort(
      (left, right) => left.updatedAt - right.updatedAt || left.key.localeCompare(right.key),
    )) {
      if (!available || item.state !== "parked" || !exactReviewQueueIsPublication(item)) continue;
      const deadLetter = exactReviewDeadLetterInsert(
        item,
        item.lastFailureReason || "retry_exhausted",
        Math.max(1, item.attempts),
        item.firstFailureAt || item.updatedAt,
        now,
      );
      this.insertDeadLetterSync(deadLetter);
      delete state.items[item.key];
      available -= 1;
      moved += 1;
    }
    return moved;
  }

  private reviewFlowSummarySync(now: number) {
    const windowMs = 15 * 60_000;
    const row = Array.from(
      this.storage.sql.exec(
        `SELECT COALESCE(SUM(review_enqueued), 0) AS enqueued,
                COALESCE(SUM(review_completed), 0) AS completed,
                COALESCE(SUM(review_retried), 0) AS retried,
                COALESCE(SUM(review_shed), 0) AS shed
           FROM ${EXACT_REVIEW_QUEUE_METRIC_BUCKET_TABLE}
          WHERE bucket_start >= ?`,
        now - windowMs,
      ),
    )[0] as Record<string, number> | undefined;
    const multiplier = (60 * 60 * 1000) / windowMs;
    const enqueued = Number(row?.enqueued || 0);
    const successful = Number(row?.completed || 0);
    const retried = Number(row?.retried || 0);
    const shed = Number(row?.shed || 0);
    const arrival = enqueued + shed;
    return {
      last_15_minutes: {
        window_minutes: windowMs / 60_000,
        arrival,
        successful,
        retried,
        shed,
        arrival_rate_per_hour: Math.round(arrival * multiplier * 10) / 10,
        successful_rate_per_hour: Math.round(successful * multiplier * 10) / 10,
        retried_rate_per_hour: Math.round(retried * multiplier * 10) / 10,
        shed_rate_per_hour: Math.round(shed * multiplier * 10) / 10,
        retry_amplification: successful > 0 ? Math.round((retried / successful) * 100) / 100 : null,
      },
    };
  }

  private pruneQueueTelemetrySync(now: number) {
    this.storage.sql.exec(
      `DELETE FROM ${EXACT_REVIEW_QUEUE_METRIC_BUCKET_TABLE} WHERE bucket_start < ?`,
      now - EXACT_REVIEW_QUEUE_METRIC_BUCKET_TTL_MS,
    );
    this.storage.sql.exec(
      `DELETE FROM ${EXACT_REVIEW_QUEUE_DEAD_LETTER_TABLE}
        WHERE status != 'open' AND resolved_at < ?`,
      now - EXACT_REVIEW_QUEUE_DEAD_LETTER_RESOLVED_TTL_MS,
    );
    this.storage.sql.exec(
      `DELETE FROM ${EXACT_REVIEW_STATE_WRITER_OPERATION_TABLE} WHERE observed_at < ?`,
      now - EXACT_REVIEW_STATE_WRITER_RETENTION_MS,
    );
    this.storage.sql.exec(
      `DELETE FROM ${EXACT_REVIEW_STATE_WRITER_LIVE_TABLE} WHERE observed_at < ?`,
      now - EXACT_REVIEW_STATE_WRITER_LIVE_MS,
    );
  }

  private recordStateWriterOperationSafely(
    operation: StateWriterOperation | undefined,
    rejected: boolean,
    now: number,
  ) {
    try {
      this.storage.transactionSync(() => {
        if (rejected) {
          this.incrementStateWriterDiagnosticSync("rejected_terminal_total");
          return;
        }
        if (!operation) return;
        const hash = payloadHash(operation);
        const inserted = Array.from(
          this.storage.sql.exec(
            `INSERT OR IGNORE INTO ${EXACT_REVIEW_STATE_WRITER_OPERATION_TABLE}
             (operation_id, observed_at, mode, started_at, finished_at, wait_ms, acquire_attempts,
              acquired, hold_ms, renewals, released, git_duration_ms, git_processes, commit_count,
              materialized_items, configured_batch_size, actual_batch_size, batch_wait_ms, outcome, payload_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             RETURNING operation_id`,
            operation.operation_id,
            now,
            operation.mode,
            Date.parse(operation.started_at),
            Date.parse(operation.finished_at),
            operation.wait_ms,
            operation.acquire_attempts,
            operation.acquired ? 1 : 0,
            operation.hold_ms,
            operation.renewals,
            operation.released === null ? null : operation.released ? 1 : 0,
            operation.git_duration_ms,
            operation.git_processes,
            operation.commit_count,
            operation.materialized_items,
            operation.configured_batch_size,
            operation.actual_batch_size,
            operation.batch_wait_ms,
            operation.outcome,
            hash,
          ),
        );
        if (inserted.length) {
          this.storage.sql.exec(
            `UPDATE ${EXACT_REVIEW_STATE_WRITER_DIAGNOSTICS_TABLE}
                SET accepted_terminal_total = accepted_terminal_total + 1,
                    state_commits_total = state_commits_total + ?,
                    materialized_items_total = materialized_items_total + ?,
                    contention_timeouts_total = contention_timeouts_total + ?,
                    last_observed_at = ?
              WHERE singleton_id = 1`,
            operation.commit_count,
            operation.materialized_items,
            operation.outcome === "contention_timeout" ? 1 : 0,
            now,
          );
          return;
        }
        const existing = Array.from(
          this.storage.sql.exec(
            `SELECT payload_hash FROM ${EXACT_REVIEW_STATE_WRITER_OPERATION_TABLE} WHERE operation_id = ?`,
            operation.operation_id,
          ),
        )[0] as { payload_hash?: string } | undefined;
        this.incrementStateWriterDiagnosticSync(
          existing?.payload_hash === hash
            ? "duplicate_terminal_total"
            : "conflicted_terminal_total",
        );
      });
    } catch {
      // Completion remains authoritative if telemetry storage is unavailable.
    }
  }

  private recordStateWriterProgressSafely(progress, now: number) {
    try {
      this.storage.transactionSync(() => {
        const existing = Array.from(
          this.storage.sql.exec(
            `SELECT phase, sequence, observed_at FROM ${EXACT_REVIEW_STATE_WRITER_LIVE_TABLE}
              WHERE operation_id = ?`,
            progress.operation_id,
          ),
        )[0] as { phase?: string; sequence?: number; observed_at?: number } | undefined;
        if (
          existing &&
          (Number(existing.sequence) >= progress.sequence ||
            (existing.phase === progress.phase && now - Number(existing.observed_at) < 30 * 1000))
        ) {
          return;
        }
        this.storage.sql.exec(
          `INSERT INTO ${EXACT_REVIEW_STATE_WRITER_LIVE_TABLE}
             (operation_id, mode, phase, sequence, observed_at, configured_batch_size, actual_batch_size)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(operation_id) DO UPDATE SET
             mode = excluded.mode, phase = excluded.phase, sequence = excluded.sequence,
             observed_at = excluded.observed_at, configured_batch_size = excluded.configured_batch_size,
             actual_batch_size = excluded.actual_batch_size`,
          progress.operation_id,
          progress.mode,
          progress.phase,
          progress.sequence,
          now,
          progress.configured_batch_size,
          progress.actual_batch_size,
        );
        this.incrementStateWriterDiagnosticSync("accepted_progress_total", now);
      });
    } catch {
      // Progress is deliberately best effort.
    }
  }

  private incrementStateWriterDiagnosticSafely(column: string) {
    try {
      this.storage.transactionSync(() => this.incrementStateWriterDiagnosticSync(column));
    } catch {
      // Diagnostics must not make an endpoint fail.
    }
  }

  private incrementStateWriterDiagnosticSync(column: string, observedAt?: number) {
    const allowed = new Set([
      "accepted_terminal_total",
      "duplicate_terminal_total",
      "rejected_terminal_total",
      "conflicted_terminal_total",
      "accepted_progress_total",
      "rejected_progress_total",
    ]);
    if (!allowed.has(column)) return;
    this.storage.sql.exec(
      `UPDATE ${EXACT_REVIEW_STATE_WRITER_DIAGNOSTICS_TABLE}
          SET ${column} = ${column} + 1,
              last_observed_at = COALESCE(?, last_observed_at)
        WHERE singleton_id = 1`,
      observedAt ?? null,
    );
  }

  private stateWriterSummarySync(now: number) {
    const diagnostics = (Array.from(
      this.storage.sql.exec(
        `SELECT * FROM ${EXACT_REVIEW_STATE_WRITER_DIAGNOSTICS_TABLE} WHERE singleton_id = 1`,
      ),
    )[0] || {}) as Record<string, unknown>;
    const liveRows = Array.from(
      this.storage.sql.exec(
        `SELECT mode, phase, observed_at FROM ${EXACT_REVIEW_STATE_WRITER_LIVE_TABLE}
          WHERE observed_at >= ?`,
        now - EXACT_REVIEW_STATE_WRITER_LIVE_MS,
      ),
    ) as Array<{ mode: string; phase: string; observed_at: number }>;
    const summarize = (windowMs: number) => {
      const rows = Array.from(
        this.storage.sql.exec(
          `SELECT * FROM ${EXACT_REVIEW_STATE_WRITER_OPERATION_TABLE} WHERE finished_at >= ?`,
          now - windowMs,
        ),
      ) as Array<Record<string, number | string | null>>;
      const values = (field: string) =>
        rows
          .map((row) => row[field])
          .filter((value): value is number => typeof value === "number")
          .sort((left, right) => left - right);
      const percentile = (field: string) => {
        const sample = values(field);
        const at = (ratio: number) =>
          sample.length
            ? sample[Math.min(sample.length - 1, Math.ceil(sample.length * ratio) - 1)]
            : null;
        return { p50: at(0.5), p95: at(0.95), samples: sample.length };
      };
      const sum = (field: string) =>
        rows.reduce(
          (total, row) => total + (typeof row[field] === "number" ? Number(row[field]) : 0),
          0,
        );
      const commits = sum("commit_count");
      const batch = rows.filter((row) => row.mode === "batch");
      return {
        operations: rows.length,
        acquired: rows.filter((row) => row.acquired === 1).length,
        contention_timeouts: rows.filter((row) => row.outcome === "contention_timeout").length,
        state_commits: commits,
        materialized_items: sum("materialized_items"),
        items_per_commit: commits ? sum("materialized_items") / commits : null,
        wait_ms: percentile("wait_ms"),
        hold_ms: percentile("hold_ms"),
        git_duration_ms: percentile("git_duration_ms"),
        actual_batch_size: {
          average: batch.length ? sumFor(batch, "actual_batch_size") / batch.length : null,
          ...percentileFor(batch, "actual_batch_size"),
        },
        batch_wait_ms: percentileFor(batch, "batch_wait_ms"),
        batch_fullness: batch.length
          ? sumFor(batch, "actual_batch_size") / sumFor(batch, "configured_batch_size")
          : null,
      };
    };
    const recent = summarize(15 * 60 * 1000);
    const modes = new Set([
      ...liveRows.map((row) => row.mode),
      ...(
        Array.from(
          this.storage.sql.exec(
            `SELECT DISTINCT mode FROM ${EXACT_REVIEW_STATE_WRITER_OPERATION_TABLE} WHERE finished_at >= ?`,
            now - 15 * 60 * 1000,
          ),
        ) as Array<{ mode: string }>
      ).map((row) => row.mode),
    ]);
    const lastObserved = Number(diagnostics.last_observed_at || 0);
    const lastSuccessful = Array.from(
      this.storage.sql.exec(
        `SELECT MAX(finished_at) AS finished_at
           FROM ${EXACT_REVIEW_STATE_WRITER_OPERATION_TABLE}
          WHERE outcome = 'materialized'`,
      ),
    )[0] as { finished_at?: number } | undefined;
    const lastSuccessfulAt = Number(lastSuccessful?.finished_at || 0);
    return {
      schema_version: 1,
      collection: {
        status: lastObserved
          ? now - lastObserved <= 15 * 60 * 1000
            ? "fresh"
            : "stale"
          : "unknown",
        last_observed_at: lastObserved ? new Date(lastObserved).toISOString() : null,
        rejected_total: Number(diagnostics.rejected_terminal_total || 0),
        conflicted_total: Number(diagnostics.conflicted_terminal_total || 0),
      },
      mode: modes.size === 0 ? "unknown" : modes.size === 1 ? [...modes][0] : "mixed",
      live: {
        tracked_holding: liveRows.filter((row) => row.phase === "holding").length,
        tracked_waiting: liveRows.filter((row) => row.phase === "waiting").length,
        tracked_releasing: liveRows.filter((row) => row.phase === "releasing").length,
        freshness_seconds: liveRows.length
          ? Math.max(
              0,
              Math.round((now - Math.max(...liveRows.map((row) => row.observed_at))) / 1000),
            )
          : null,
      },
      last_15_minutes: recent,
      last_60_minutes: summarize(60 * 60 * 1000),
      last_successful_materialization_at: lastSuccessfulAt
        ? new Date(lastSuccessfulAt).toISOString()
        : null,
      diagnostics: {
        accepted_terminal_total: Number(diagnostics.accepted_terminal_total || 0),
        duplicate_terminal_total: Number(diagnostics.duplicate_terminal_total || 0),
        rejected_terminal_total: Number(diagnostics.rejected_terminal_total || 0),
        conflicted_terminal_total: Number(diagnostics.conflicted_terminal_total || 0),
        accepted_progress_total: Number(diagnostics.accepted_progress_total || 0),
        rejected_progress_total: Number(diagnostics.rejected_progress_total || 0),
        state_commits_total: Number(diagnostics.state_commits_total || 0),
        materialized_items_total: Number(diagnostics.materialized_items_total || 0),
        contention_timeouts_total: Number(diagnostics.contention_timeouts_total || 0),
      },
    };
  }

  private publicationFlowSummarySync(now: number) {
    const summarize = (windowMs: number) => {
      const row = Array.from(
        this.storage.sql.exec(
          `SELECT COALESCE(SUM(publication_enqueued), 0) AS enqueued,
                  COALESCE(SUM(publication_resolved), 0) AS resolved,
                  COALESCE(SUM(publication_published), 0) AS published,
                  COALESCE(SUM(publication_superseded), 0) AS superseded,
                  COALESCE(SUM(publication_retried), 0) AS retried,
                  COALESCE(SUM(publication_dead_lettered), 0) AS dead_lettered
             FROM ${EXACT_REVIEW_QUEUE_METRIC_BUCKET_TABLE}
            WHERE bucket_start >= ?`,
          now - windowMs,
        ),
      )[0] as Record<string, number> | undefined;
      const multiplier = (60 * 60 * 1000) / windowMs;
      const enqueued = Number(row?.enqueued || 0);
      const resolved = Number(row?.resolved || 0);
      const retried = Number(row?.retried || 0);
      const published = Number(row?.published || 0);
      const superseded = Number(row?.superseded || 0);
      const deadLettered = Number(row?.dead_lettered || 0);
      return {
        window_minutes: windowMs / 60_000,
        enqueued,
        resolved,
        published,
        superseded,
        retried,
        dead_lettered: deadLettered,
        arrival_rate_per_hour: Math.round(enqueued * multiplier * 10) / 10,
        resolved_rate_per_hour: Math.round(resolved * multiplier * 10) / 10,
        published_rate_per_hour: Math.round(published * multiplier * 10) / 10,
        superseded_rate_per_hour: Math.round(superseded * multiplier * 10) / 10,
        retried_rate_per_hour: Math.round(retried * multiplier * 10) / 10,
        dead_lettered_rate_per_hour: Math.round(deadLettered * multiplier * 10) / 10,
        net_drain_rate_per_hour: Math.round((resolved - enqueued) * multiplier * 10) / 10,
        retry_amplification: resolved > 0 ? Math.round((retried / resolved) * 100) / 100 : null,
      };
    };
    return { last_15_minutes: summarize(15 * 60_000), last_60_minutes: summarize(60 * 60_000) };
  }

  private deadLetterStatsSync() {
    const totals = Array.from(
      this.storage.sql.exec(
        `SELECT COUNT(*) AS open_count, MIN(first_failed_at) AS oldest_failed_at
           FROM ${EXACT_REVIEW_QUEUE_DEAD_LETTER_TABLE}
          WHERE status = 'open'`,
      ),
    )[0] as { open_count?: number; oldest_failed_at?: number } | undefined;
    const reasons = Object.fromEntries(
      Array.from(
        this.storage.sql.exec(
          `SELECT reason_code, COUNT(*) AS reason_count
             FROM ${EXACT_REVIEW_QUEUE_DEAD_LETTER_TABLE}
            WHERE status = 'open'
            GROUP BY reason_code
            ORDER BY reason_code`,
        ) as Iterable<{ reason_code: string; reason_count: number }>,
      ).map((row) => [row.reason_code, Number(row.reason_count)]),
    );
    const oldest = Number(totals?.oldest_failed_at || 0);
    return {
      open: Number(totals?.open_count || 0),
      limit: EXACT_REVIEW_QUEUE_DEAD_LETTER_LIMIT,
      oldest_failed_at: oldest ? new Date(oldest).toISOString() : null,
      reasons,
    };
  }

  private writeStateSync(state: ExactReviewQueueState) {
    const baseline = this.baselines.get(state) || this.readStateBaselineSync();
    const nextItems = new Map<string, string>();
    let reviewEnqueued = 0;
    let publicationEnqueued = 0;
    for (const [itemKey, item] of Object.entries(state.items)) {
      const itemJson = JSON.stringify(item);
      nextItems.set(itemKey, itemJson);
      if (baseline.items.get(itemKey) === itemJson) continue;
      if (!baseline.items.has(itemKey)) {
        if (exactReviewQueueIsPublication(item)) publicationEnqueued += 1;
        else reviewEnqueued += 1;
      }
      this.storage.sql.exec(
        `INSERT INTO ${EXACT_REVIEW_QUEUE_ITEM_TABLE} (item_key, item_json)
         VALUES (?, ?)
         ON CONFLICT(item_key) DO UPDATE SET item_json = excluded.item_json`,
        itemKey,
        itemJson,
      );
    }
    for (const itemKey of baseline.items.keys()) {
      if (!nextItems.has(itemKey)) {
        this.storage.sql.exec(
          `DELETE FROM ${EXACT_REVIEW_QUEUE_ITEM_TABLE} WHERE item_key = ?`,
          itemKey,
        );
      }
    }
    // Count queue work, not webhook volume. A new key creates one unit of
    // operator-visible demand; dedupes and merged revisions retain an existing
    // key and therefore cannot inflate the speed calculation.
    this.incrementQueueMetricsSync({ reviewEnqueued, publicationEnqueued });

    const dispatcherJson = state.dispatcher ? JSON.stringify(state.dispatcher) : null;
    this.storage.sql.exec(
      `UPDATE ${EXACT_REVIEW_QUEUE_META_TABLE}
          SET dispatcher_json = ?, shed_since_reset = ?,
              storage_generation = storage_generation + 1
        WHERE singleton_id = 1`,
      dispatcherJson,
      exactReviewShedSinceReset(state),
    );
    this.syncLegacyCompatibilitySync(state);
    this.baselines.set(state, {
      items: nextItems,
      dispatcherJson,
    });
  }

  private readStateBaselineSync(): ExactReviewQueueBaseline {
    const items = new Map<string, string>();
    for (const row of this.storage.sql.exec(
      `SELECT item_key, item_json FROM ${EXACT_REVIEW_QUEUE_ITEM_TABLE}`,
    ) as Iterable<{ item_key: string; item_json: string }>) {
      items.set(row.item_key, row.item_json);
    }
    return {
      items,
      dispatcherJson: this.readStorageMetaSync()?.dispatcher_json ?? null,
    };
  }

  private stateAppendWindowTotalsSync() {
    const row = Array.from(
      this.storage.sql.exec(
        `SELECT COUNT(*) AS pending_rows,
                COALESCE(SUM(payload_bytes), 0) AS pending_bytes
           FROM ${STATE_APPEND_WINDOW_TABLE}`,
      ),
    )[0] as { pending_rows?: number; pending_bytes?: number } | undefined;
    return {
      pendingRows: Number(row?.pending_rows || 0),
      pendingBytes: Number(row?.pending_bytes || 0),
    };
  }

  private stateAppendStatsSync() {
    const totals = this.stateAppendWindowTotalsSync();
    const oldest = Array.from(
      this.storage.sql.exec(
        `SELECT produced_at
           FROM ${STATE_APPEND_WINDOW_TABLE}
          ORDER BY seq
          LIMIT 1`,
      ),
    )[0] as { produced_at?: string } | undefined;
    const meta = Array.from(
      this.storage.sql.exec(
        `SELECT shed_since_reset FROM ${STATE_APPEND_META_TABLE} WHERE singleton_id = 1`,
      ),
    )[0] as { shed_since_reset?: number } | undefined;
    const receipts = Array.from(
      this.storage.sql.exec(`SELECT COUNT(*) AS receipt_count FROM ${STATE_APPEND_RECEIPT_TABLE}`),
    )[0] as { receipt_count?: number } | undefined;
    return {
      pending_rows: totals.pendingRows,
      pending_bytes: totals.pendingBytes,
      oldest_produced_at: oldest?.produced_at || null,
      sheds_since_reset: Number(meta?.shed_since_reset || 0),
      delivery_receipts: Number(receipts?.receipt_count || 0),
    };
  }

  private reclaimExpiredStateAppendDrainsSync(now: number) {
    this.storage.sql.exec(
      `UPDATE ${STATE_APPEND_WINDOW_TABLE}
          SET drain_token = NULL
        WHERE drain_token IN (
          SELECT drain_token
            FROM ${STATE_APPEND_DRAIN_TABLE}
           WHERE expires_at <= ?
        )`,
      now,
    );
    this.storage.sql.exec(`DELETE FROM ${STATE_APPEND_DRAIN_TABLE} WHERE expires_at <= ?`, now);
  }

  private drainStateAppendWindowSync(maxRows: number, maxBytes: number, now: number) {
    this.reclaimExpiredStateAppendDrainsSync(now);
    const active = Array.from(
      this.storage.sql.exec(
        `SELECT drain_token, expires_at
           FROM ${STATE_APPEND_DRAIN_TABLE}
          ORDER BY leased_at, drain_token
          LIMIT 1`,
      ),
    )[0] as { drain_token?: string; expires_at?: number } | undefined;
    if (active?.drain_token) {
      return {
        token: active.drain_token,
        expiresAt: Number(active.expires_at),
        rows: this.stateAppendRowsForDrainSync(active.drain_token),
      };
    }

    const candidates = Array.from(
      this.storage.sql.exec(
        `SELECT seq, kind, record_key, payload_json, payload_bytes, produced_at, delivery_id
           FROM ${STATE_APPEND_WINDOW_TABLE}
          WHERE drain_token IS NULL
          ORDER BY seq
          LIMIT ?`,
        maxRows,
      ) as Iterable<StateAppendWindowRow>,
    );
    const rows: StateAppendWindowRow[] = [];
    let bytes = 0;
    for (const row of candidates) {
      if (bytes + Number(row.payload_bytes) > maxBytes) break;
      rows.push(row);
      bytes += Number(row.payload_bytes);
    }
    if (!rows.length) return { token: null, expiresAt: null, rows };

    const token = crypto.randomUUID();
    const expiresAt = now + stateAppendDrainLeaseMs(this.env);
    this.storage.sql.exec(
      `INSERT INTO ${STATE_APPEND_DRAIN_TABLE}
         (drain_token, leased_at, expires_at) VALUES (?, ?, ?)`,
      token,
      now,
      expiresAt,
    );
    this.storage.sql.exec(
      `UPDATE ${STATE_APPEND_WINDOW_TABLE}
          SET drain_token = ?
        WHERE drain_token IS NULL AND seq <= ?`,
      token,
      rows.at(-1)?.seq,
    );
    return { token, expiresAt, rows };
  }

  private stateAppendRowsForDrainSync(drainToken: string) {
    return Array.from(
      this.storage.sql.exec(
        `SELECT seq, kind, record_key, payload_json, payload_bytes, produced_at, delivery_id
           FROM ${STATE_APPEND_WINDOW_TABLE}
          WHERE drain_token = ?
          ORDER BY seq`,
        drainToken,
      ) as Iterable<StateAppendWindowRow>,
    );
  }

  private pruneStateAppendReceiptsSync(now: number) {
    const cutoff = now - EXACT_REVIEW_QUEUE_DELIVERY_TTL_MS;
    for (let batch = 0; batch < EXACT_REVIEW_QUEUE_DELIVERY_PRUNE_MAX_BATCHES; batch += 1) {
      const deleted = Array.from(
        this.storage.sql.exec(
          `DELETE FROM ${STATE_APPEND_RECEIPT_TABLE}
            WHERE delivery_id IN (
              SELECT delivery_id
                FROM ${STATE_APPEND_RECEIPT_TABLE}
               WHERE received_at <= ?
               ORDER BY received_at, delivery_id
               LIMIT ${EXACT_REVIEW_QUEUE_DELIVERY_PRUNE_BATCH}
            )
          RETURNING delivery_id`,
          cutoff,
        ),
      );
      if (deleted.length < EXACT_REVIEW_QUEUE_DELIVERY_PRUNE_BATCH) break;
    }
  }

  private pruneDeliveryReceiptsSync(now: number) {
    const cutoff = now - EXACT_REVIEW_QUEUE_DELIVERY_TTL_MS;
    for (let batch = 0; batch < EXACT_REVIEW_QUEUE_DELIVERY_PRUNE_MAX_BATCHES; batch += 1) {
      const deleted = Array.from(
        this.storage.sql.exec(
          `DELETE FROM ${EXACT_REVIEW_QUEUE_DELIVERY_TABLE}
          WHERE delivery_id IN (
            SELECT delivery_id
              FROM ${EXACT_REVIEW_QUEUE_DELIVERY_TABLE}
             WHERE received_at <= ?
             ORDER BY received_at, delivery_id
             LIMIT ${EXACT_REVIEW_QUEUE_DELIVERY_PRUNE_BATCH}
          )
        RETURNING delivery_id`,
          cutoff,
        ),
      );
      if (deleted.length < EXACT_REVIEW_QUEUE_DELIVERY_PRUNE_BATCH) break;
    }
  }

  private deliveryReceiptCountSync() {
    const row = Array.from(
      this.storage.sql.exec(
        `SELECT COUNT(*) AS receipt_count FROM ${EXACT_REVIEW_QUEUE_DELIVERY_TABLE}`,
      ),
    )[0] as { receipt_count?: number } | undefined;
    return Number(row?.receipt_count || 0);
  }

  private legacyReceiptTimestamp(receivedAt: number) {
    return Math.min(
      Number.MAX_SAFE_INTEGER,
      receivedAt + EXACT_REVIEW_QUEUE_LEGACY_RECEIPT_SHIFT_MS,
    );
  }

  private legacyDeliverySnapshotSync(now: number) {
    const rows = Array.from(
      this.storage.sql.exec(
        `SELECT delivery_id, received_at
           FROM ${EXACT_REVIEW_QUEUE_DELIVERY_TABLE}
          WHERE received_at > ?
          ORDER BY delivery_id
          LIMIT ${EXACT_REVIEW_QUEUE_LEGACY_RECEIPT_ROW_LIMIT + 1}`,
        now - EXACT_REVIEW_QUEUE_DELIVERY_TTL_MS,
      ) as Iterable<{ delivery_id: string; received_at: number }>,
    );
    if (rows.length > EXACT_REVIEW_QUEUE_LEGACY_RECEIPT_ROW_LIMIT) return undefined;
    return Object.fromEntries(
      rows.map((row) => [row.delivery_id, this.legacyReceiptTimestamp(row.received_at)]),
    );
  }

  private syncLegacyCompatibilitySync(state: ExactReviewQueueState) {
    const now = Date.now();
    if (now >= this.migratedAt + EXACT_REVIEW_QUEUE_LEGACY_ROLLBACK_MS) {
      this.cleanupLegacyCompatibilitySync();
      return;
    }
    const generation = this.readStorageMetaSync()?.storage_generation;
    if (!Number.isSafeInteger(generation) || Number(generation) < 1) {
      throw new Error("invalid exact-review queue storage generation");
    }
    const deliveries = this.legacyDeliverySnapshotSync(now);
    if (!deliveries) {
      this.disableLegacyMirrorSync(
        `active receipt count exceeds ${EXACT_REVIEW_QUEUE_LEGACY_RECEIPT_ROW_LIMIT}`,
      );
      return;
    }
    // Old Worker code preserves the marker as an inert receipt. If it mutates
    // this shadow after a rollback, the next upgrade can reconcile that exact
    // generation instead of silently choosing one side. Its five-day receipt
    // pruner sees timestamps shifted by two days, preserving the restored
    // seven-day contract without changing the normalized SQL timestamps.
    const shadow = {
      deliveries: {
        ...deliveries,
        [`${EXACT_REVIEW_QUEUE_LEGACY_GENERATION_PREFIX}${generation}`]: Number.MAX_SAFE_INTEGER,
      },
      items: state.items,
      dispatcher: state.dispatcher,
      shedSinceReset: exactReviewShedSinceReset(state),
    };
    const shadowBytes = new TextEncoder().encode(JSON.stringify(shadow)).byteLength;
    if (shadowBytes > EXACT_REVIEW_QUEUE_LEGACY_SHADOW_MAX_BYTES) {
      this.disableLegacyMirrorSync(`shadow is ${shadowBytes} bytes`);
      return;
    }
    try {
      this.storage.kv.put(EXACT_REVIEW_QUEUE_STATE_KEY, shadow);
      this.legacyMirrorDisabled = false;
    } catch (error) {
      this.disableLegacyMirrorSync(error instanceof Error ? error.message : String(error));
    }
  }

  private disableLegacyMirrorSync(reason: string) {
    try {
      // A failed refresh must not leave a stale generation that becomes
      // indistinguishable from rollback-era mutations on the next upgrade.
      this.storage.kv.delete(EXACT_REVIEW_QUEUE_STATE_KEY);
    } catch (error) {
      console.warn(
        "exact-review stale legacy rollback shadow could not be removed",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
    this.reportLegacyMirrorUnavailable(reason);
  }

  private reportLegacyMirrorUnavailable(reason: string) {
    this.legacyMirrorDisabled = true;
    if (this.legacyMirrorWarningReported) return;
    this.legacyMirrorWarningReported = true;
    console.warn("exact-review legacy rollback shadow unavailable", reason);
  }

  private cleanupLegacyCompatibilitySync() {
    if (!this.migratedAt || Date.now() < this.migratedAt + EXACT_REVIEW_QUEUE_LEGACY_ROLLBACK_MS) {
      return;
    }
    this.storage.kv.delete(EXACT_REVIEW_QUEUE_STATE_KEY);
  }

  private async scheduleNext(state: ExactReviewQueueState, now: number) {
    const publicationControl = this.refreshPublicationControlSync(state, now);
    const batchOwnership = this.batchStore.activeLeaseSnapshot(now);
    const legacyExcludedItemKeys = new Set<string>(batchOwnership.itemKeys);
    if (exactReviewPublicationBatchingEnabled(this.env)) {
      for (const item of Object.values(state.items)) {
        // Block only new legacy admission. In-flight legacy publications must
        // retain their dispatch/lease expiry wake-ups while the rollout drains.
        if (item.state === "pending" && exactReviewQueueIsPublication(item)) {
          legacyExcludedItemKeys.add(item.key);
        }
      }
    }
    const queueNext = exactReviewQueueNextWakeAt(
      state,
      now,
      exactReviewQueueCapacity(this.env),
      exactReviewTargetCapacity(this.env),
      exactReviewPublicationCapacityForState(
        this.env,
        state,
        now,
        publicationControl.capacityCeiling,
        true,
        publicationControl.demandCapacity,
      ),
      exactReviewPublicationDispatchLeaseMs(this.env),
      exactReviewHeartbeatGraceMs(this.env),
      legacyExcludedItemKeys,
      batchOwnership.nextLeaseExpiresAt,
    );
    const reviewNext = this.nextReviewReconcileAtSync(now);
    const batchDeparture = exactReviewPublicationBatchDeparture(
      this.env,
      state,
      now,
      new Set(batchOwnership.itemKeys),
    );
    const next = [
      queueNext,
      reviewNext,
      batchOwnership.nextLeaseExpiresAt,
      batchDeparture?.dueAt ?? null,
    ]
      .filter((candidate): candidate is number => candidate !== null)
      .reduce<number | null>(
        (earliest, candidate) => (earliest === null ? candidate : Math.min(earliest, candidate)),
        null,
      );
    if (next === null) {
      await this.storage.deleteAlarm();
      return;
    }
    const scheduled = await this.storage.getAlarm();
    if (scheduled === null || scheduled <= now || next < scheduled) {
      await this.storage.setAlarm(next);
    }
  }
}

function exactReviewDecisionFrom(value): ExactReviewDecision | null {
  const base = exactReviewBaseDecisionFrom(value);
  if (!base) return null;
  const decision = objectValue(value);
  const hasPublication = Object.hasOwn(decision, "publication");
  const publication = hasPublication ? exactReviewPublicationFrom(decision.publication) : undefined;
  if (hasPublication && !publication) return null;
  if (publication) {
    if (base.sourceAction !== EXACT_REVIEW_ARTIFACT_PUBLISH_SOURCE_ACTION) return null;
    if (
      publication.producerDecision.sourceAction === EXACT_REVIEW_ARTIFACT_PUBLISH_SOURCE_ACTION ||
      publication.producerDecision.targetRepo !== base.targetRepo ||
      publication.producerDecision.targetBranch !== base.targetBranch ||
      publication.producerDecision.itemNumber !== base.itemNumber ||
      publication.producerDecision.itemKind !== base.itemKind ||
      publication.producerDecision.sourceEvent !== base.sourceEvent ||
      publication.itemKey !== `${base.targetRepo}#${base.itemNumber}`
    ) {
      return null;
    }
  } else if (base.sourceAction === EXACT_REVIEW_ARTIFACT_PUBLISH_SOURCE_ACTION) {
    return null;
  }
  return { ...base, ...(publication ? { publication } : {}) };
}

function exactReviewBaseDecisionFrom(value): ExactReviewBaseDecision | null {
  const decision = objectValue(value);
  const targetRepo = String(decision.targetRepo || "").trim();
  const targetBranch = String(decision.targetBranch || "").trim();
  const itemNumber = Number(decision.itemNumber);
  const itemKind = String(decision.itemKind || "");
  const sourceEvent = String(decision.sourceEvent || "");
  const sourceAction = String(decision.sourceAction || "");
  const hasCommandStatusMarker = Object.hasOwn(decision, "commandStatusMarker");
  const commandStatusMarker = hasCommandStatusMarker ? decision.commandStatusMarker : undefined;
  const hasStatusCommentId = Object.hasOwn(decision, "statusCommentId");
  const statusCommentId = hasStatusCommentId ? Number(decision.statusCommentId) : undefined;
  const hasAdditionalPrompt = Object.hasOwn(decision, "additionalPrompt");
  const additionalPrompt = hasAdditionalPrompt ? decision.additionalPrompt : undefined;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(targetRepo)) return null;
  if (!/^[A-Za-z0-9_./-]+$/.test(targetBranch)) return null;
  if (!Number.isInteger(itemNumber) || itemNumber <= 0) return null;
  if (itemKind !== "issue" && itemKind !== "pull_request") return null;
  if (sourceEvent !== "issues" && sourceEvent !== "pull_request") return null;
  if (!sourceAction) return null;
  if (
    hasCommandStatusMarker &&
    (typeof commandStatusMarker !== "string" ||
      !EXACT_REVIEW_COMMAND_STATUS_MARKER_PATTERN.test(commandStatusMarker))
  ) {
    return null;
  }
  if (
    hasStatusCommentId &&
    (!Number.isSafeInteger(statusCommentId) || Number(statusCommentId) <= 0)
  ) {
    return null;
  }
  if (
    hasAdditionalPrompt &&
    (typeof additionalPrompt !== "string" ||
      additionalPrompt.length > EXACT_REVIEW_ADDITIONAL_PROMPT_MAX_CHARS ||
      additionalPrompt.includes("\0"))
  ) {
    return null;
  }
  return {
    targetRepo,
    targetBranch,
    itemNumber,
    itemKind,
    sourceEvent,
    sourceAction,
    supersedesInProgress: Boolean(decision.supersedesInProgress),
    ...(Number.isFinite(Number(decision.codexTimeoutMs))
      ? { codexTimeoutMs: Number(decision.codexTimeoutMs) }
      : {}),
    ...(Number.isFinite(Number(decision.mediaProofTimeoutMs))
      ? { mediaProofTimeoutMs: Number(decision.mediaProofTimeoutMs) }
      : {}),
    ...(hasCommandStatusMarker ? { commandStatusMarker } : {}),
    ...(hasStatusCommentId ? { statusCommentId } : {}),
    ...(hasAdditionalPrompt ? { additionalPrompt } : {}),
  };
}

function exactReviewPublicationFrom(value): ExactReviewPublication | null {
  const publication = objectValue(value);
  const artifactName = String(publication.artifactName || "").trim();
  const producerRunId = String(publication.producerRunId || "").trim();
  const producerRunAttempt = Number(publication.producerRunAttempt);
  const sourceSha = String(publication.sourceSha || "").trim();
  const itemKey = String(publication.itemKey || "").trim();
  const protocolVersion = Number(publication.protocolVersion);
  const leaseRevision =
    publication.leaseRevision === null ? null : Number(publication.leaseRevision);
  const claimGeneration =
    publication.claimGeneration === null ? null : Number(publication.claimGeneration);
  const producerDecision = exactReviewBaseDecisionFrom(publication.producerDecision);
  const liveProceeded = publication.liveProceeded;
  const liveTerminalNoop = publication.liveTerminalNoop;
  const liveTerminalMissing = publication.liveTerminalMissing;
  const liveGuardedOpen = publication.liveGuardedOpen;
  if (!/^exact-review-\d{1,30}-[1-9]\d*$/.test(artifactName)) return null;
  if (!/^\d{1,30}$/.test(producerRunId)) return null;
  if (!Number.isSafeInteger(producerRunAttempt) || producerRunAttempt < 1) return null;
  if (artifactName !== `exact-review-${producerRunId}-${producerRunAttempt}`) return null;
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) return null;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*$/.test(itemKey)) return null;
  if (protocolVersion !== 1 && protocolVersion !== 2) return null;
  if (
    (leaseRevision !== null && (!Number.isSafeInteger(leaseRevision) || leaseRevision < 1)) ||
    (claimGeneration !== null && (!Number.isSafeInteger(claimGeneration) || claimGeneration < 1))
  ) {
    return null;
  }
  if (protocolVersion === 2 && (leaseRevision === null || claimGeneration === null)) return null;
  if (!producerDecision) return null;
  const liveOutcomes = [liveProceeded, liveTerminalNoop, liveTerminalMissing, liveGuardedOpen];
  if (liveOutcomes.some((outcome) => typeof outcome !== "boolean")) return null;
  if (liveOutcomes.filter(Boolean).length !== 1) return null;
  return {
    artifactName,
    producerRunId,
    producerRunAttempt,
    sourceSha,
    itemKey,
    protocolVersion,
    leaseRevision,
    claimGeneration,
    liveProceeded,
    liveTerminalNoop,
    liveTerminalMissing,
    liveGuardedOpen,
    producerDecision,
  };
}

function mergePendingExactReviewDecision(
  current: ExactReviewDecision,
  next: ExactReviewDecision,
): ExactReviewDecision {
  const merged = { ...current, ...next };
  if (
    Object.hasOwn(next, "commandStatusMarker") &&
    next.commandStatusMarker !== current.commandStatusMarker &&
    !Object.hasOwn(next, "statusCommentId")
  ) {
    delete merged.statusCommentId;
  }
  return merged;
}

function exactReviewItemKey(decision: ExactReviewDecision) {
  const base = `${decision.targetRepo}#${decision.itemNumber}`;
  return decision.publication
    ? `${base}@publish:${decision.publication.producerRunId}:${decision.publication.producerRunAttempt}`
    : base;
}

function isExactReviewQueueTargetEnabled(decision: ExactReviewDecision, env) {
  return (
    decision.targetRepo !== "openclaw/clawhub" ||
    String(env.CLAWSWEEPER_ENABLE_CLAWHUB || "") === "1"
  );
}

function exactReviewItemForLease(state: ExactReviewQueueState, leaseId: string) {
  return Object.values(state.items).find((item) => item.leaseId === leaseId) || null;
}

function exactReviewClaimResponse(
  item: ExactReviewQueueItem,
  protocolVersion: 1 | 2,
  claimGeneration: number,
) {
  return {
    ok: true,
    claimed: true,
    protocol_version: protocolVersion,
    item_key: item.key,
    ...(protocolVersion === 1 ? { revision: item.leaseRevision } : {}),
    lease_revision: item.leaseRevision,
    claim_generation: claimGeneration,
    decision: item.leaseDecision,
  };
}

function exactReviewCompletionOutcome(
  value,
  fallback?: ExactReviewCompletionOutcome,
): ExactReviewCompletionOutcome | null {
  const normalized =
    value === undefined || value === null || value === "" ? fallback : String(value);
  return normalized === "success" || normalized === "failure" || normalized === "cancelled"
    ? normalized
    : null;
}

function exactReviewPublicationFailureKind(value): ExactReviewPublicationFailureKind | null {
  const normalized = String(value || "");
  return normalized === "github_rate_limit" || normalized === "github_transient"
    ? normalized
    : null;
}

function exactReviewPublicationCompletionKind(value): ExactReviewPublicationCompletionKind | null {
  const normalized = String(value || "");
  return normalized === "published" ||
    normalized === "superseded" ||
    normalized === "deferred" ||
    normalized === "retryable_failure" ||
    normalized === "refresh_required" ||
    normalized === "permanent_failure"
    ? normalized
    : null;
}

function exactReviewPublicationReasonCode(value): ExactReviewPublicationReasonCode | null {
  const normalized = String(value || "");
  return [
    "publication_applied",
    "remote_newer_tuple",
    "remote_closed",
    "live_terminal",
    "github_rate_limit",
    "github_transient",
    "state_contention",
    "review_lease_active",
    "workflow_cancelled",
    "artifact_unavailable",
    "artifact_expired",
    "close_coverage_retry",
    "close_coverage_deferred",
    "invalid_artifact",
    "missing_record_tuple",
    "tuple_protocol_invalid",
    "policy_invariant",
    "unknown_failure",
    "retry_exhausted",
  ].includes(normalized)
    ? (normalized as ExactReviewPublicationReasonCode)
    : null;
}

function exactReviewPublicationCompletion(
  kindValue,
  reasonValue,
  errorFingerprintValue,
): ExactReviewPublicationCompletion | null {
  const kind = exactReviewPublicationCompletionKind(kindValue);
  const reasonCode = exactReviewPublicationReasonCode(reasonValue);
  if (!kind || !reasonCode) return null;
  const allowedReasons: Record<
    ExactReviewPublicationCompletionKind,
    ReadonlySet<ExactReviewPublicationReasonCode>
  > = {
    published: new Set(["publication_applied"]),
    superseded: new Set(["remote_newer_tuple", "remote_closed", "live_terminal"]),
    retryable_failure: new Set([
      "github_rate_limit",
      "github_transient",
      "state_contention",
      "review_lease_active",
      "workflow_cancelled",
      "artifact_unavailable",
      "unknown_failure",
    ]),
    // Accept the pre-deployment tuple while an old publisher can still finish.
    // New publishers use deferred/close_coverage_deferred instead.
    refresh_required: new Set(["artifact_unavailable", "artifact_expired", "close_coverage_retry"]),
    deferred: new Set(["close_coverage_deferred"]),
    permanent_failure: new Set([
      "invalid_artifact",
      "missing_record_tuple",
      "tuple_protocol_invalid",
      "policy_invariant",
      "unknown_failure",
      "retry_exhausted",
    ]),
  };
  if (!allowedReasons[kind].has(reasonCode)) return null;
  const errorFingerprint = String(errorFingerprintValue || "").trim();
  if (errorFingerprint && !/^[A-Za-z0-9:._-]{1,200}$/.test(errorFingerprint)) return null;
  return { kind, reasonCode, ...(errorFingerprint ? { errorFingerprint } : {}) };
}

function exactReviewRunAttempt(value): number | null {
  const runAttempt = Number(value);
  return Number.isInteger(runAttempt) && runAttempt > 0 ? runAttempt : null;
}

function exactReviewDeadLetterIds(value): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) return null;
  const ids = value.map((entry) => String(entry || "").trim());
  if (ids.some((id) => !id || id.length > 500) || new Set(ids).size !== ids.length) return null;
  return ids;
}

type ExactReviewDeadLetterItem = Pick<ExactReviewQueueItem, "key" | "decision">;

function exactReviewDeadLetterItem(value: string): ExactReviewDeadLetterItem | null {
  try {
    const record = objectValue(JSON.parse(value));
    const key = String(record.key || "").trim();
    const decision = exactReviewDecisionFrom(record.decision);
    if (!key || !decision || key !== exactReviewItemKey(decision)) return null;
    return { key, decision };
  } catch {
    return null;
  }
}

function exactReviewFreshRecoveryFromPublicationItem(
  item: ExactReviewDeadLetterItem,
): { decision: ExactReviewDecision; key: string } | null {
  if (!exactReviewQueueIsPublication(item) || !item.decision.publication) return null;
  const decision = exactReviewDecisionFrom({
    ...item.decision.publication.producerDecision,
    sourceAction:
      item.decision.publication.producerDecision.sourceAction ===
      FAILED_REVIEW_SHARD_RECOVERY_SOURCE_ACTION
        ? FAILED_REVIEW_SHARD_RECOVERY_SOURCE_ACTION
        : EXACT_REVIEW_ARTIFACT_RETENTION_RECOVERY_SOURCE_ACTION,
    supersedesInProgress: true,
  });
  return decision ? { decision, key: exactReviewItemKey(decision) } : null;
}

function exactReviewPublicationCandidates(
  value,
): Array<{ itemKey: string; revision: number }> | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 25) return null;
  const candidates: Array<{ itemKey: string; revision: number }> = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const candidate = objectValue(entry);
    const itemKey = String(candidate.item_key || "").trim();
    const revision = Number(candidate.revision);
    if (!itemKey || itemKey.length > 500 || !Number.isInteger(revision) || revision < 1) {
      return null;
    }
    const identity = `${itemKey}:${revision}`;
    if (seen.has(identity)) return null;
    seen.add(identity);
    candidates.push({ itemKey, revision });
  }
  return candidates;
}

function exactReviewClaimGeneration(value) {
  const generation = Number(value);
  return Number.isInteger(generation) && generation >= 0 ? generation : 0;
}

export function exactReviewTerminalRuns(value) {
  if (!Array.isArray(value) || value.length > EXACT_REVIEW_RECONCILE_RUN_LIMIT) return null;
  const runs: Array<
    ExactReviewClaimedRun & {
      runAttempt: number;
      claimedRunAttempt?: number;
      outcome: ExactReviewCompletionOutcome;
    }
  > = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const record = objectValue(entry);
    const runId = String(record.run_id || "").trim();
    const runAttempt = exactReviewRunAttempt(record.run_attempt);
    const claimedRunAttempt =
      record.claimed_run_attempt === null || record.claimed_run_attempt === undefined
        ? undefined
        : exactReviewRunAttempt(record.claimed_run_attempt);
    const claimGeneration = Number(record.claim_generation);
    const outcome = exactReviewCompletionOutcome(record.outcome);
    if (
      !/^\d+$/.test(runId) ||
      !runAttempt ||
      claimedRunAttempt === null ||
      !Number.isInteger(claimGeneration) ||
      claimGeneration < 0 ||
      !outcome
    ) {
      return null;
    }
    const key = `${runId}:${runAttempt}:${claimGeneration}`;
    if (seen.has(key)) continue;
    seen.add(key);
    runs.push({ runId, runAttempt, claimedRunAttempt, claimGeneration, outcome });
  }
  return runs;
}

export function exactReviewRequestedRuns(value) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > EXACT_REVIEW_RECONCILE_RUN_LIMIT
  ) {
    return null;
  }
  const runs: Array<{ runId: string; runAttempt?: number }> = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const record = objectValue(entry);
    const runId = String(record.run_id || (typeof entry !== "object" ? entry : "")).trim();
    if (!/^\d+$/.test(runId)) return null;
    const hasRunAttempt = Object.hasOwn(record, "run_attempt");
    const runAttempt = hasRunAttempt ? exactReviewRunAttempt(record.run_attempt) : null;
    if (hasRunAttempt && !runAttempt) return null;
    const key = `${runId}:${runAttempt || "latest"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    runs.push({ runId, ...(runAttempt ? { runAttempt } : {}) });
  }
  return runs;
}

export function exactReviewClaimedRuns(value): ExactReviewClaimedRun[] | null {
  if (!Array.isArray(value) || value.length > EXACT_REVIEW_RECONCILE_CLAIM_MATCH_LIMIT) {
    return null;
  }
  const runs: ExactReviewClaimedRun[] = [];
  for (const entry of value) {
    const record = objectValue(entry);
    const runId = String(record.run_id || "").trim();
    const runAttempt =
      record.run_attempt === null || record.run_attempt === undefined
        ? undefined
        : exactReviewRunAttempt(record.run_attempt);
    const claimGeneration = Number(record.claim_generation);
    if (
      !/^\d+$/.test(runId) ||
      runAttempt === null ||
      !Number.isInteger(claimGeneration) ||
      claimGeneration < 0
    ) {
      return null;
    }
    runs.push({ runId, runAttempt, claimGeneration });
  }
  return runs;
}

function finishExactReviewPublicationQueueItem({
  state,
  item,
  now,
  completion,
  requestedRetryAt = 0,
  requeueLatest = false,
  deadLetterCapacityAvailable,
  env,
}: {
  state: ExactReviewQueueState;
  item: ExactReviewQueueItem;
  now: number;
  completion: ExactReviewPublicationCompletion;
  requestedRetryAt?: number;
  requeueLatest?: boolean;
  deadLetterCapacityAvailable: boolean;
  env: unknown;
}): {
  requeued: boolean;
  retried: boolean;
  refreshed: boolean;
  parked: boolean;
  deadLetter?: ExactReviewDeadLetterInsert;
} {
  const hasNewerRevision = item.revision > Number(item.leaseRevision || 0);
  if (hasNewerRevision || requeueLatest) {
    const requeued = finishExactReviewQueueItem(
      state,
      item,
      now,
      "success",
      requestedRetryAt,
      requeueLatest,
    );
    if (requeued) {
      item.publicationFailureAttempts = 0;
      item.firstFailureAt = undefined;
      item.lastFailureReason = undefined;
    }
    return {
      requeued,
      retried: false,
      refreshed: false,
      parked: false,
    };
  }

  if (
    completion.kind === "published" ||
    completion.kind === "superseded" ||
    completion.kind === "deferred"
  ) {
    return {
      requeued: finishExactReviewQueueItem(state, item, now, "success"),
      retried: false,
      refreshed: false,
      parked: false,
    };
  }

  // Dispatch failures and publisher results have independent budgets. A runner
  // handoff failure must not make the first deterministic artifact failure look
  // like its third confirmation attempt.
  const attempt = Number(item.publicationFailureAttempts || 0) + 1;
  const firstFailureAt = item.firstFailureAt || now;
  const artifactRefresh =
    completion.kind === "refresh_required" ||
    (completion.reasonCode === "artifact_unavailable" &&
      attempt >= EXACT_REVIEW_PUBLICATION_ARTIFACT_RETRY_LIMIT);
  if (artifactRefresh) {
    refreshExactReviewPublicationItem(state, item, now, env);
    return { requeued: false, retried: false, refreshed: true, parked: false };
  }

  const retryExhausted = exactReviewPublicationRetryExhausted(
    completion,
    attempt,
    firstFailureAt,
    now,
  );
  if (retryExhausted) {
    const deadLetter = exactReviewDeadLetterInsert(
      item,
      completion.reasonCode === "unknown_failure" ? "retry_exhausted" : completion.reasonCode,
      attempt,
      firstFailureAt,
      now,
      completion.errorFingerprint,
    );
    if (deadLetterCapacityAvailable) {
      delete state.items[item.key];
      return { requeued: false, retried: false, refreshed: false, parked: false, deadLetter };
    }
    // A full dead-letter store is an operator-visible circuit breaker. Park the
    // poison item instead of silently dropping replay context or dispatching it forever.
    clearExactReviewLease(item);
    item.state = "parked";
    item.parkedReason = "dead_letter_capacity";
    item.attempts = attempt;
    item.publicationFailureAttempts = attempt;
    item.firstFailureAt = firstFailureAt;
    item.lastFailureReason = completion.reasonCode;
    item.updatedAt = now;
    return { requeued: false, retried: false, refreshed: false, parked: true };
  }

  clearExactReviewLease(item);
  item.state = "pending";
  item.parkedReason = undefined;
  item.attempts = attempt;
  item.publicationFailureAttempts = attempt;
  item.firstFailureAt = firstFailureAt;
  item.lastFailureReason = completion.reasonCode;
  item.nextAttemptAt = Math.max(
    exactReviewQueueEnqueueAttemptAt(state, now),
    now + exactReviewPublicationRetryDelayMs(item.key, completion, attempt),
    requestedRetryAt,
  );
  item.updatedAt = now;
  return { requeued: true, retried: true, refreshed: false, parked: false };
}

function exactReviewPublicationRetryExhausted(
  completion: ExactReviewPublicationCompletion,
  attempt: number,
  firstFailureAt: number,
  now: number,
) {
  if (completion.kind === "retryable_failure") {
    if (completion.reasonCode === "artifact_unavailable") return false;
    if (completion.reasonCode === "unknown_failure") {
      return (
        attempt >= EXACT_REVIEW_PUBLICATION_UNKNOWN_RETRY_LIMIT ||
        now >= firstFailureAt + EXACT_REVIEW_PUBLICATION_UNKNOWN_RETRY_MAX_AGE_MS
      );
    }
    return (
      attempt >= EXACT_REVIEW_PUBLICATION_TRANSIENT_RETRY_LIMIT ||
      now >= firstFailureAt + EXACT_REVIEW_PUBLICATION_TRANSIENT_RETRY_MAX_AGE_MS
    );
  }
  if (completion.kind === "permanent_failure") {
    const limit =
      completion.reasonCode === "unknown_failure"
        ? EXACT_REVIEW_PUBLICATION_UNKNOWN_RETRY_LIMIT
        : EXACT_REVIEW_PUBLICATION_PERMANENT_RETRY_LIMIT;
    return (
      attempt >= limit ||
      (completion.reasonCode === "unknown_failure" &&
        now >= firstFailureAt + EXACT_REVIEW_PUBLICATION_UNKNOWN_RETRY_MAX_AGE_MS)
    );
  }
  return false;
}

function exactReviewPublicationRetryDelayMs(
  itemKey: string,
  completion: ExactReviewPublicationCompletion,
  attempt: number,
) {
  let delay: number;
  if (completion.kind === "permanent_failure" || completion.reasonCode === "unknown_failure") {
    const steps = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000];
    delay = steps[Math.min(attempt - 1, steps.length - 1)];
  } else {
    const maximum = completion.reasonCode === "github_rate_limit" ? 60 * 60_000 : 30 * 60_000;
    delay = Math.min(maximum, 60_000 * 2 ** Math.min(attempt - 1, 6));
  }
  const hash = [...`${itemKey}:${attempt}`].reduce(
    (current, character) => (current * 33 + character.charCodeAt(0)) >>> 0,
    5381,
  );
  return delay + Math.floor(delay * ((hash % 21) / 100));
}

function exactReviewDeadLetterId(item: ExactReviewQueueItem) {
  return `${item.key}@revision:${item.leaseRevision || item.revision}`;
}

function exactReviewDeadLetterInsert(
  item: ExactReviewQueueItem,
  reasonCode: ExactReviewPublicationReasonCode,
  attempts: number,
  firstFailedAt: number,
  lastFailedAt: number,
  errorFingerprint?: string,
): ExactReviewDeadLetterInsert {
  const publication = item.decision.publication;
  if (!publication) throw new Error(`publication metadata missing for ${item.key}`);
  return {
    id: exactReviewDeadLetterId(item),
    itemKey: item.key,
    revision: Number(item.leaseRevision || item.revision),
    targetRepo: item.decision.targetRepo,
    itemNumber: item.decision.itemNumber,
    producerRunId: publication.producerRunId,
    producerRunAttempt: publication.producerRunAttempt,
    artifactName: publication.artifactName,
    reasonCode,
    attempts,
    firstFailedAt,
    lastFailedAt,
    itemJson: JSON.stringify(item),
    ...(errorFingerprint ? { errorFingerprint } : {}),
  };
}

function finishExactReviewQueueItem(
  state: ExactReviewQueueState,
  item: ExactReviewQueueItem,
  now: number,
  outcome: ExactReviewCompletionOutcome,
  requestedRetryAt = 0,
  requeueLatest = false,
) {
  const retryingFailure = outcome !== "success";
  const hasNewerRevision = item.revision > Number(item.leaseRevision || 0);
  // A regular queue item may back off and retry after a failed lease. Failed
  // sweep shards already consumed their one recovery attempt before reaching
  // the queue, so only a newer source revision may supersede that recovery.
  const oneShotRecovery =
    item.leaseDecision?.sourceAction === FAILED_REVIEW_SHARD_RECOVERY_SOURCE_ACTION;
  const requeued = (!oneShotRecovery && retryingFailure) || hasNewerRevision || requeueLatest;
  if (requeued) {
    clearExactReviewLease(item);
    item.state = "pending";
    if (retryingFailure && !hasNewerRevision && !requeueLatest) {
      item.attempts += 1;
      item.nextAttemptAt = Math.max(
        exactReviewQueueEnqueueAttemptAt(state, now),
        now + exactReviewRetryDelayMs(item.attempts),
        hasNewerRevision ? 0 : requestedRetryAt,
      );
    } else {
      item.nextAttemptAt = exactReviewQueueEnqueueAttemptAt(state, now);
      item.attempts = 0;
    }
    item.updatedAt = now;
  } else {
    delete state.items[item.key];
  }
  return requeued;
}

function exactReviewCompletionRetryAt(value, now: number): number | null {
  if (value === undefined || value === null || value === "") return null;
  const retryAt = Date.parse(String(value));
  if (!Number.isFinite(retryAt)) return null;
  if (retryAt > now + EXACT_REVIEW_COMPLETION_RETRY_MAX_MS) return null;
  return Math.max(now, retryAt);
}

function clearExactReviewLease(item: ExactReviewQueueItem) {
  item.leaseId = undefined;
  item.leaseRevision = undefined;
  item.leaseDecision = undefined;
  item.leaseExpiresAt = undefined;
  item.leaseHeartbeatAt = undefined;
  item.claimedRunId = undefined;
  item.claimedRunAttempt = undefined;
  item.claimGeneration = undefined;
  item.claimProtocolVersion = undefined;
  item.dispatchedAt = undefined;
  item.claimedAt = undefined;
}

export function exactReviewEffectiveLeaseExpiresAt(
  item: ExactReviewQueueItem,
  publicationDispatchLeaseMs: number,
  heartbeatGraceMs = DEFAULT_EXACT_REVIEW_HEARTBEAT_GRACE_MS,
) {
  const leaseExpiresAt = Number(item.leaseExpiresAt || 0);
  const leaseHeartbeatAt = Number(item.leaseHeartbeatAt || 0);
  if (leaseExpiresAt && item.state === "leased" && leaseHeartbeatAt) {
    return Math.min(leaseExpiresAt, leaseHeartbeatAt + heartbeatGraceMs);
  }
  if (
    !leaseExpiresAt ||
    item.state !== "dispatching" ||
    !exactReviewQueueIsPublication(item) ||
    item.claimedRunId ||
    !item.dispatchedAt
  ) {
    return leaseExpiresAt;
  }
  return Math.min(leaseExpiresAt, item.dispatchedAt + publicationDispatchLeaseMs);
}

function isLiveExactReviewLease(
  item: ExactReviewQueueItem,
  now: number,
  publicationDispatchLeaseMs = DEFAULT_EXACT_REVIEW_PUBLICATION_DISPATCH_LEASE_MS,
  heartbeatGraceMs = DEFAULT_EXACT_REVIEW_HEARTBEAT_GRACE_MS,
) {
  return Boolean(
    item.leaseId &&
    exactReviewEffectiveLeaseExpiresAt(item, publicationDispatchLeaseMs, heartbeatGraceMs) > now,
  );
}

function reclaimExpiredExactReviewLeases(
  state: ExactReviewQueueState,
  now: number,
  publicationDispatchLeaseMs = DEFAULT_EXACT_REVIEW_PUBLICATION_DISPATCH_LEASE_MS,
  heartbeatGraceMs = DEFAULT_EXACT_REVIEW_HEARTBEAT_GRACE_MS,
) {
  let changed = false;
  for (const [key, item] of Object.entries(state.items)) {
    if (
      reclaimExpiredExactReviewLease(
        state,
        key,
        item,
        now,
        publicationDispatchLeaseMs,
        heartbeatGraceMs,
      )
    ) {
      changed = true;
    }
  }
  return changed;
}

function reclaimExpiredExactReviewLease(
  state: ExactReviewQueueState,
  key: string,
  item: ExactReviewQueueItem,
  now: number,
  publicationDispatchLeaseMs: number,
  heartbeatGraceMs = DEFAULT_EXACT_REVIEW_HEARTBEAT_GRACE_MS,
) {
  if (
    (item.state !== "dispatching" && item.state !== "leased") ||
    isLiveExactReviewLease(item, now, publicationDispatchLeaseMs, heartbeatGraceMs)
  ) {
    return false;
  }
  const oneShotRecovery =
    (item.leaseDecision || item.decision).sourceAction ===
    FAILED_REVIEW_SHARD_RECOVERY_SOURCE_ACTION;
  const hasNewerRevision = item.revision > Number(item.leaseRevision || 0);
  if (oneShotRecovery && !hasNewerRevision) {
    delete state.items[key];
    return true;
  }
  clearExactReviewLease(item);
  item.state = "pending";
  item.nextAttemptAt = now;
  if (hasNewerRevision) {
    item.attempts = 0;
    item.publicationFailureAttempts = 0;
    item.firstFailureAt = undefined;
    item.lastFailureReason = undefined;
  }
  item.updatedAt = now;
  return true;
}

function expireExactReviewPublicationItems(state: ExactReviewQueueState, now: number, env) {
  let changed = false;
  for (const item of Object.values(state.items)) {
    const publication = item.decision.publication;
    if (
      item.state !== "pending" ||
      !publication ||
      now < item.createdAt + EXACT_REVIEW_ARTIFACT_RETRY_MAX_MS
    ) {
      continue;
    }
    refreshExactReviewPublicationItem(state, item, now, env);
    changed = true;
  }
  return changed;
}

function refreshExactReviewPublicationItem(
  state: ExactReviewQueueState,
  item: ExactReviewQueueItem,
  now: number,
  env,
) {
  const publication = item.decision.publication;
  if (!publication) throw new Error(`publication metadata missing for ${item.key}`);
  delete state.items[item.key];
  const decision: ExactReviewDecision = {
    ...publication.producerDecision,
    sourceAction:
      publication.producerDecision.sourceAction === FAILED_REVIEW_SHARD_RECOVERY_SOURCE_ACTION
        ? FAILED_REVIEW_SHARD_RECOVERY_SOURCE_ACTION
        : EXACT_REVIEW_ARTIFACT_RETENTION_RECOVERY_SOURCE_ACTION,
    supersedesInProgress: true,
  };
  const recoveryKey = exactReviewItemKey(decision);
  const current = state.items[recoveryKey];
  if (current) {
    if (current.state === "pending" || current.state === "parked") {
      current.decision = mergePendingExactReviewDecision(current.decision, decision);
      current.state = "pending";
      current.parkedReason = undefined;
    } else {
      return;
    }
    current.revision += 1;
    current.updatedAt = now;
    current.nextAttemptAt = exactReviewQueueDebouncedAttemptAt(
      state,
      current.decision,
      now,
      current.createdAt,
      env,
    );
    current.attempts = 0;
    current.publicationFailureAttempts = 0;
    current.firstFailureAt = undefined;
    current.lastFailureReason = undefined;
    return;
  }
  // Refresh is the terminal recovery for an unusable artifact. It must not be
  // shed after deleting the only durable publication reference.
  state.items[recoveryKey] = {
    key: recoveryKey,
    decision,
    state: "pending",
    revision: 1,
    createdAt: now,
    updatedAt: now,
    nextAttemptAt: exactReviewQueueDebouncedAttemptAt(state, decision, now, now, env),
    attempts: 0,
  };
}

function exactReviewQueueEnqueueAttemptAt(state: ExactReviewQueueState, now: number) {
  const retryAt = Number(state.dispatcher?.retryAt || 0);
  return (state.dispatcher?.state === "paused" || state.dispatcher?.state === "blocked") &&
    retryAt > now
    ? retryAt
    : now;
}

function exactReviewQueueDebouncedAttemptAt(
  state: ExactReviewQueueState,
  decision: ExactReviewDecision,
  now: number,
  firstEnqueuedAt: number,
  env,
) {
  const baseAttemptAt = exactReviewQueueEnqueueAttemptAt(state, now);
  if (isImmediateExactReviewDecision(decision)) return baseAttemptAt;
  const debounceAt = Math.min(
    now + exactReviewDispatchDebounceMs(env),
    firstEnqueuedAt + exactReviewDispatchDebounceMaxMs(env),
  );
  return Math.max(baseAttemptAt, debounceAt);
}

function isImmediateExactReviewDecision(decision: ExactReviewDecision) {
  return Boolean(decision.commandStatusMarker || decision.publication);
}

function isLowPriorityExactReviewDecision(decision: ExactReviewDecision) {
  return EXACT_REVIEW_LOW_PRIORITY_SOURCE_ACTIONS.has(decision.sourceAction);
}

function exactReviewQueuePendingCount(state: ExactReviewQueueState) {
  return Object.values(state.items).filter((item) => item.state === "pending").length;
}

function exactReviewShedSinceReset(state: Pick<ExactReviewQueueState, "shedSinceReset">) {
  const value = Number(state.shedSinceReset || 0);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function exactReviewMetricTotal(value: unknown) {
  const total = Number(value);
  return Number.isSafeInteger(total) && total >= 0 ? total : 0;
}

function exactReviewMetricDelta(value: unknown) {
  const delta = Number(value || 0);
  return Number.isSafeInteger(delta) && delta > 0 ? delta : 0;
}

function exactReviewQueueIsPublication(item: Pick<ExactReviewQueueItem, "decision">) {
  return item.decision.sourceAction === EXACT_REVIEW_ARTIFACT_PUBLISH_SOURCE_ACTION;
}

function exactReviewQueueLane(item: ExactReviewQueueItem) {
  return exactReviewQueueIsPublication(item) ? "publication" : "review";
}

// The Bay is a deliberately lightweight visual projection of durable queue
// state. Keep this representation bounded and scrubbed: it is public dashboard
// data, not a queue-inspection API. Live workers remain the authority for the
// reviewing stage; these records only make the otherwise invisible admission,
// setup, publication, and recovery phases visible.
const EXACT_REVIEW_BAY_SAMPLE_LIMIT = 24;
// The dashboard can retain both a terminal-buffer card and its washed card
// while their live queue retry is pending. Accept all bounded Bay candidates
// first, then apply the public sample limit only after resolving live rows.
const EXACT_REVIEW_BAY_PRIORITY_INPUT_LIMIT = 40;
const EXACT_REVIEW_BAY_STAGES = [
  "arriving",
  "setting-up",
  "reviewing",
  "applying",
  "repairing",
] as const;
type ExactReviewBayStage = (typeof EXACT_REVIEW_BAY_STAGES)[number];
type ExactReviewBayProjectionItem = {
  item_key: string;
  repository: string;
  item_number: number;
  stage: ExactReviewBayStage;
  queue_state: ExactReviewQueueItem["state"];
  created_at: string;
  updated_at: string;
  next_attempt_at: string;
};

function exactReviewQueueBayStage(item: ExactReviewQueueItem): ExactReviewBayStage {
  if (exactReviewQueueIsPublication(item)) return "applying";
  if (isLowPriorityExactReviewDecision(item.decision)) return "repairing";
  return item.state === "pending" ? "arriving" : "setting-up";
}

function exactReviewQueueBayStagePriority(stage: ExactReviewBayStage) {
  return EXACT_REVIEW_BAY_STAGES.indexOf(stage);
}

function exactReviewQueueBayPriorityKeys(values: string[]) {
  const unique = new Set<string>();
  for (const value of values) {
    const itemKey = String(value || "").trim();
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+$/.test(itemKey)) continue;
    unique.add(itemKey);
    if (unique.size === EXACT_REVIEW_BAY_PRIORITY_INPUT_LIMIT) break;
  }
  return [...unique];
}

function exactReviewQueueBayProjection(
  items: ExactReviewQueueItem[],
  priorityItemKeys: string[] = [],
) {
  const projected = new Map<string, ExactReviewBayProjectionItem>();
  for (const item of items) {
    if (item.state === "parked") continue;
    const repository = String(item.decision.targetRepo || "").trim();
    const itemNumber = Number(item.decision.itemNumber);
    if (!repository || !Number.isSafeInteger(itemNumber) || itemNumber <= 0) continue;
    const candidate: ExactReviewBayProjectionItem = {
      item_key: `${repository}#${itemNumber}`,
      repository,
      item_number: itemNumber,
      stage: exactReviewQueueBayStage(item),
      queue_state: item.state,
      created_at: new Date(item.createdAt).toISOString(),
      updated_at: new Date(item.updatedAt).toISOString(),
      next_attempt_at: new Date(item.nextAttemptAt).toISOString(),
    };
    const previous = projected.get(candidate.item_key);
    const candidateUpdatedAt = Date.parse(candidate.updated_at);
    const previousUpdatedAt = previous ? Date.parse(previous.updated_at) : Number.NEGATIVE_INFINITY;
    if (
      !previous ||
      candidateUpdatedAt > previousUpdatedAt ||
      (candidateUpdatedAt === previousUpdatedAt &&
        exactReviewQueueBayStagePriority(candidate.stage) >
          exactReviewQueueBayStagePriority(previous.stage))
    ) {
      projected.set(candidate.item_key, candidate);
    }
  }
  const rows = [...projected.values()];
  const stages = Object.fromEntries(
    EXACT_REVIEW_BAY_STAGES.map((stage) => [
      stage,
      rows.filter((item) => item.stage === stage).length,
    ]),
  ) as Record<ExactReviewBayStage, number>;
  const rowsByStage = Object.fromEntries(
    EXACT_REVIEW_BAY_STAGES.map((stage) => [
      stage,
      rows
        .filter((item) => item.stage === stage)
        .sort(
          (left, right) =>
            Date.parse(left.created_at) - Date.parse(right.created_at) ||
            left.item_key.localeCompare(right.item_key),
        ),
    ]),
  ) as Record<ExactReviewBayStage, ExactReviewBayProjectionItem[]>;
  const priorityRows = exactReviewQueueBayPriorityKeys(priorityItemKeys)
    .map((itemKey) => projected.get(itemKey))
    .filter((item): item is ExactReviewBayProjectionItem => Boolean(item))
    .slice(0, EXACT_REVIEW_BAY_SAMPLE_LIMIT);
  const priorityKeys = new Set(priorityRows.map((item) => item.item_key));
  const sample = [...priorityRows];
  const longestStage = Math.max(
    ...EXACT_REVIEW_BAY_STAGES.map((stage) => rowsByStage[stage].length),
  );
  for (
    let index = 0;
    sample.length < EXACT_REVIEW_BAY_SAMPLE_LIMIT && index < longestStage;
    index += 1
  ) {
    for (const stage of EXACT_REVIEW_BAY_STAGES) {
      const item = rowsByStage[stage][index];
      if (!item || priorityKeys.has(item.item_key)) continue;
      sample.push(item);
      if (sample.length === EXACT_REVIEW_BAY_SAMPLE_LIMIT) break;
    }
  }
  return {
    sample_limit: EXACT_REVIEW_BAY_SAMPLE_LIMIT,
    total: rows.length,
    stages,
    items: sample,
  };
}

function exactReviewQueueActiveReviewCount(state: ExactReviewQueueState) {
  return Object.values(state.items).filter(
    (item) =>
      !exactReviewQueueIsPublication(item) &&
      (item.state === "dispatching" || item.state === "leased"),
  ).length;
}

function exactReviewQueueActivePublicationCount(state: ExactReviewQueueState) {
  return Object.values(state.items).filter(
    (item) =>
      exactReviewQueueIsPublication(item) &&
      (item.state === "dispatching" || item.state === "leased"),
  ).length;
}

export function exactReviewQueueAdmittedItems(
  state: ExactReviewQueueState,
  now: number,
  capacity: number,
  targetCapacity: number,
  publicationCapacity: number,
  excludedItemKeys: ReadonlySet<string> = new Set(),
  publicationAdmissionBlocked = false,
) {
  const dispatcherRetryAt = Number(state.dispatcher?.retryAt || 0);
  if (
    (state.dispatcher?.state === "paused" || state.dispatcher?.state === "blocked") &&
    dispatcherRetryAt > now
  ) {
    return [];
  }
  const reviewSlots = Math.max(0, capacity - exactReviewQueueActiveReviewCount(state));
  const activeTargets = new Map<string, number>();
  let activePublishers = 0;
  for (const item of Object.values(state.items)) {
    if (item.state !== "dispatching" && item.state !== "leased") continue;
    if (exactReviewQueueIsPublication(item)) {
      activePublishers += 1;
      continue;
    }
    const target = item.decision.targetRepo;
    activeTargets.set(target, (activeTargets.get(target) || 0) + 1);
  }
  const admitted: ExactReviewQueueItem[] = [];
  let admittedReviews = 0;
  const pending = Object.values(state.items)
    .filter(
      (item) =>
        item.state === "pending" && item.nextAttemptAt <= now && !excludedItemKeys.has(item.key),
    )
    .sort((left, right) => left.createdAt - right.createdAt || left.key.localeCompare(right.key));
  for (const item of pending) {
    const publication = exactReviewQueueIsPublication(item);
    if (publication) {
      if (publicationAdmissionBlocked) continue;
      if (activePublishers >= publicationCapacity) continue;
      activePublishers += 1;
      admitted.push(item);
      continue;
    }
    if (admittedReviews >= reviewSlots) continue;
    const target = item.decision.targetRepo;
    const active = activeTargets.get(target) || 0;
    if (active >= targetCapacity) continue;
    activeTargets.set(target, active + 1);
    admittedReviews += 1;
    admitted.push(item);
  }
  return admitted;
}

function sumFor(rows: Array<Record<string, number | string | null>>, field: string) {
  return rows.reduce(
    (total, row) => total + (typeof row[field] === "number" ? Number(row[field]) : 0),
    0,
  );
}

function percentileFor(rows: Array<Record<string, number | string | null>>, field: string) {
  const values = rows
    .map((row) => row[field])
    .filter((value): value is number => typeof value === "number")
    .sort((left, right) => left - right);
  const at = (ratio: number) =>
    values.length
      ? values[Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1)]
      : null;
  return { p50: at(0.5), p95: at(0.95), samples: values.length };
}

function exactReviewQueueStats(
  state: ExactReviewQueueState,
  now = Date.now(),
  capacity = Number.POSITIVE_INFINITY,
  targetCapacity = Number.POSITIVE_INFINITY,
  publicationCapacity = Number.POSITIVE_INFINITY,
  dispatchLeaseMs = DEFAULT_EXACT_REVIEW_DISPATCH_LEASE_MS,
  executionLeaseMs = DEFAULT_EXACT_REVIEW_EXECUTION_LEASE_MS,
  publicationDispatchLeaseMs = DEFAULT_EXACT_REVIEW_PUBLICATION_DISPATCH_LEASE_MS,
  heartbeatGraceMs = DEFAULT_EXACT_REVIEW_HEARTBEAT_GRACE_MS,
  excludedItemKeys: ReadonlySet<string> = new Set(),
  publicationBlockedUntil: number | null = null,
) {
  const items = Object.values(state.items);
  const handoffItems = items.filter(
    (item): item is ExactReviewQueueItem & { state: "pending" | "dispatching" | "leased" } =>
      item.state !== "parked",
  );
  const handoffHealth = summarizeExactReviewHandoff({
    // Parked poison items are reported by publication health and cannot take a
    // handoff lease, so they must not be mislabeled as an unknown handoff phase.
    items: handoffItems,
    dispatcher: state.dispatcher,
    shedSinceReset: exactReviewShedSinceReset(state),
    now,
    capacity,
    dispatchLeaseMs,
    executionLeaseMs,
  });
  const targets = new Map<
    string,
    {
      target_repo: string;
      pending: number;
      dispatching: number;
      leased: number;
      parked: number;
      oldest_pending_at: number | null;
    }
  >();
  for (const item of items) {
    const targetRepo = item.decision.targetRepo;
    const current = targets.get(targetRepo) ?? {
      target_repo: targetRepo,
      pending: 0,
      dispatching: 0,
      leased: 0,
      parked: 0,
      oldest_pending_at: null,
    };
    if (item.state === "pending") {
      current.pending += 1;
      current.oldest_pending_at =
        current.oldest_pending_at === null
          ? item.createdAt
          : Math.min(current.oldest_pending_at, item.createdAt);
    } else if (item.state === "dispatching") {
      current.dispatching += 1;
    } else if (item.state === "leased") {
      current.leased += 1;
    } else {
      current.parked += 1;
    }
    targets.set(targetRepo, current);
  }
  const targetStats = [...targets.values()]
    .map((target) => ({
      target_repo: target.target_repo,
      pending: target.pending,
      dispatching: target.dispatching,
      leased: target.leased,
      oldest_pending_at:
        target.oldest_pending_at === null ? null : new Date(target.oldest_pending_at).toISOString(),
    }))
    .sort(
      (left, right) =>
        right.pending - left.pending ||
        right.dispatching + right.leased - (left.dispatching + left.leased) ||
        left.target_repo.localeCompare(right.target_repo),
    );
  const nextWakeAt = exactReviewQueueNextWakeAt(
    state,
    now,
    capacity,
    targetCapacity,
    publicationCapacity,
    publicationDispatchLeaseMs,
    heartbeatGraceMs,
    excludedItemKeys,
    publicationBlockedUntil,
  );
  const lanes = {
    review: exactReviewQueueLaneStats(
      items.filter((item) => !exactReviewQueueIsPublication(item)),
      now,
      capacity,
      exactReviewShedSinceReset(state),
    ),
    publication: exactReviewQueueLaneStats(
      items.filter(exactReviewQueueIsPublication),
      now,
      publicationCapacity,
    ),
  };
  const readyPending = items.filter(
    (item) => item.state === "pending" && item.nextAttemptAt <= now,
  ).length;
  const admissibleItems = exactReviewQueueAdmittedItems(
    state,
    now,
    Number.MAX_SAFE_INTEGER,
    targetCapacity,
    publicationCapacity,
    excludedItemKeys,
    publicationBlockedUntil !== null && publicationBlockedUntil > now,
  );
  const admissiblePending = admissibleItems.length;
  const reviewAdmissiblePending = admissibleItems.filter(
    (item) => !exactReviewQueueIsPublication(item),
  ).length;
  const pressure = summarizeExactReviewPressure({
    pending: lanes.review.pending,
    readyPending: lanes.review.ready,
    admissiblePending: reviewAdmissiblePending,
    dispatching: lanes.review.dispatching,
    leased: lanes.review.leased,
    capacity: lanes.review.capacity,
    dispatcherState: state.dispatcher?.state,
    handoffStatus: handoffHealth.status,
  });
  return {
    generated_at: handoffHealth.observed_at,
    pending: handoffHealth.phases.pending.count,
    ready_pending: readyPending,
    admissible_pending: admissiblePending,
    shed_since_reset: exactReviewShedSinceReset(state),
    dispatching: handoffHealth.phases.dispatching.count,
    leased: handoffHealth.phases.leased.count,
    oldest_pending_at: handoffHealth.phases.pending.oldest_at,
    oldest_pending_age_seconds: handoffHealth.phases.pending.oldest_age_seconds,
    oldest_pending_key: handoffHealth.phases.pending.oldest_key,
    oldest_dispatching_at: handoffHealth.phases.dispatching.oldest_at,
    oldest_dispatching_age_seconds: handoffHealth.phases.dispatching.oldest_age_seconds,
    oldest_leased_at: handoffHealth.phases.leased.oldest_at,
    oldest_leased_age_seconds: handoffHealth.phases.leased.oldest_age_seconds,
    handoff_health: handoffHealth,
    lanes,
    pressure,
    bay_projection: exactReviewQueueBayProjection(items),
    next_wake_at: nextWakeAt === null ? null : new Date(nextWakeAt).toISOString(),
    dispatcher: {
      state: state.dispatcher?.state || "unknown",
      reason: state.dispatcher?.reason || null,
      workflow_state: state.dispatcher?.workflowState || null,
      checked_at: state.dispatcher?.checkedAt
        ? new Date(state.dispatcher.checkedAt).toISOString()
        : null,
      retry_at: state.dispatcher?.retryAt ? new Date(state.dispatcher.retryAt).toISOString() : null,
    },
    target_stats: targetStats,
  };
}

function exactReviewQueueLaneStats(
  items: ExactReviewQueueItem[],
  now: number,
  capacity: number,
  shedSinceReset = 0,
) {
  const pendingItems = items.filter((item) => item.state === "pending");
  const readyItems = pendingItems.filter((item) => item.nextAttemptAt <= now);
  const backoffItems = pendingItems.filter((item) => item.nextAttemptAt > now);
  const dispatchingItems = items.filter((item) => item.state === "dispatching");
  const leasedItems = items.filter((item) => item.state === "leased");
  const parkedItems = items.filter((item) => item.state === "parked");
  const active = dispatchingItems.length + leasedItems.length;
  const oldestPendingAt = pendingItems.reduce<number | null>(
    (oldest, item) => (oldest === null ? item.createdAt : Math.min(oldest, item.createdAt)),
    null,
  );
  const oldestPendingKey = pendingItems
    .slice()
    .sort(
      (left, right) => left.createdAt - right.createdAt || left.key.localeCompare(right.key),
    )[0]?.key;
  const oldestReadyAt = readyItems.reduce<number | null>(
    (oldest, item) => (oldest === null ? item.createdAt : Math.min(oldest, item.createdAt)),
    null,
  );
  const oldestBackoffAt = backoffItems.reduce<number | null>(
    (oldest, item) => (oldest === null ? item.createdAt : Math.min(oldest, item.createdAt)),
    null,
  );
  const nextAttemptAt = pendingItems.reduce<number | null>(
    (next, item) => (next === null ? item.nextAttemptAt : Math.min(next, item.nextAttemptAt)),
    null,
  );
  return {
    pending: pendingItems.length,
    pending_depth: pendingItems.length,
    shed_since_reset: shedSinceReset,
    ready: readyItems.length,
    backoff: backoffItems.length,
    dispatching: dispatchingItems.length,
    leased: leasedItems.length,
    parked: parkedItems.length,
    capacity,
    active,
    available_slots: Math.max(0, capacity - active),
    oldest_pending_at: oldestPendingAt === null ? null : new Date(oldestPendingAt).toISOString(),
    oldest_pending_age_seconds:
      oldestPendingAt === null ? null : Math.max(0, Math.floor((now - oldestPendingAt) / 1_000)),
    oldest_pending_key: oldestPendingKey ?? null,
    oldest_ready_at: oldestReadyAt === null ? null : new Date(oldestReadyAt).toISOString(),
    oldest_ready_age_seconds:
      oldestReadyAt === null ? null : Math.max(0, Math.floor((now - oldestReadyAt) / 1_000)),
    oldest_backoff_at: oldestBackoffAt === null ? null : new Date(oldestBackoffAt).toISOString(),
    oldest_backoff_age_seconds:
      oldestBackoffAt === null ? null : Math.max(0, Math.floor((now - oldestBackoffAt) / 1_000)),
    next_attempt_at: nextAttemptAt === null ? null : new Date(nextAttemptAt).toISOString(),
  };
}

function exactReviewPublicationHealth(
  lane: ReturnType<typeof exactReviewQueueLaneStats>,
  flow: { last_15_minutes: { net_drain_rate_per_hour: number } },
  deadLetters: { open: number },
) {
  const oldestAge = Number(lane.oldest_pending_age_seconds || 0);
  if (lane.parked > 0 || oldestAge >= 6 * 60 * 60) {
    return {
      status: "critical",
      reason: lane.parked > 0 ? "dead_letter_capacity" : "oldest_pending_over_6h",
    };
  }
  if (
    deadLetters.open > 0 ||
    oldestAge >= 60 * 60 ||
    (lane.pending >= 100 && flow.last_15_minutes.net_drain_rate_per_hour <= 0)
  ) {
    return {
      status: "degraded",
      reason:
        deadLetters.open > 0
          ? "open_dead_letters"
          : oldestAge >= 60 * 60
            ? "oldest_pending_over_1h"
            : "not_draining",
    };
  }
  return { status: lane.pending || lane.active ? "healthy" : "idle", reason: null };
}

export function exactReviewQueueNextWakeAt(
  state: ExactReviewQueueState,
  now: number,
  capacity = Number.POSITIVE_INFINITY,
  targetCapacity = Number.POSITIVE_INFINITY,
  publicationCapacity = Number.POSITIVE_INFINITY,
  publicationDispatchLeaseMs = DEFAULT_EXACT_REVIEW_PUBLICATION_DISPATCH_LEASE_MS,
  heartbeatGraceMs = DEFAULT_EXACT_REVIEW_HEARTBEAT_GRACE_MS,
  excludedItemKeys: ReadonlySet<string> = new Set(),
  publicationBlockedUntil: number | null = null,
) {
  const items = Object.values(state.items);
  if (!items.length) return null;
  const dispatcherRetryAt = Number(state.dispatcher?.retryAt || 0);
  const dispatcherPaused =
    (state.dispatcher?.state === "paused" || state.dispatcher?.state === "blocked") &&
    dispatcherRetryAt > now;
  const activeItems = items.filter(
    (item) => item.state === "dispatching" || item.state === "leased",
  );
  if (
    activeItems.some(
      (item) =>
        !item.leaseExpiresAt ||
        exactReviewEffectiveLeaseExpiresAt(item, publicationDispatchLeaseMs, heartbeatGraceMs) <=
          now,
    )
  ) {
    return now + 1_000;
  }
  const activeReviews = activeItems.filter((item) => !exactReviewQueueIsPublication(item));
  const activePublishers = activeItems.filter(exactReviewQueueIsPublication);
  const activeReviewWakeAt = activeReviews
    .map((item) =>
      exactReviewEffectiveLeaseExpiresAt(item, publicationDispatchLeaseMs, heartbeatGraceMs),
    )
    .filter((value): value is number => Boolean(value && value > now));
  const activePublisherWakeAt = activePublishers
    .map((item) =>
      exactReviewEffectiveLeaseExpiresAt(item, publicationDispatchLeaseMs, heartbeatGraceMs),
    )
    .filter((value): value is number => Boolean(value && value > now));
  const activeTargetWakeAt = new Map<string, number>();
  const activeTargetCounts = new Map<string, number>();
  for (const item of activeReviews) {
    const leaseExpiresAt = exactReviewEffectiveLeaseExpiresAt(
      item,
      publicationDispatchLeaseMs,
      heartbeatGraceMs,
    );
    if (leaseExpiresAt > now) {
      const target = item.decision.targetRepo;
      activeTargetCounts.set(target, (activeTargetCounts.get(target) || 0) + 1);
      const current = activeTargetWakeAt.get(item.decision.targetRepo);
      activeTargetWakeAt.set(
        target,
        current === undefined ? leaseExpiresAt : Math.min(current, leaseExpiresAt),
      );
    }
  }
  const times = items.flatMap((item) => {
    if (item.state === "pending") {
      if (excludedItemKeys.has(item.key)) return [];
      if (dispatcherPaused) return [dispatcherRetryAt];
      if (exactReviewQueueIsPublication(item)) {
        if (publicationBlockedUntil !== null && publicationBlockedUntil > now) {
          return [Math.max(item.nextAttemptAt, publicationBlockedUntil)];
        }
        let blockedUntil = item.nextAttemptAt;
        if (activePublishers.length >= publicationCapacity) {
          const capacityWakeAt = [...activePublisherWakeAt];
          if (publicationCapacity <= 0) {
            // A zero publication budget is normally caused by active reviews
            // consuming the shared worker budget. Their leases, rather than a
            // one-second alarm loop, determine when a slot can become available.
            capacityWakeAt.push(...activeReviewWakeAt);
          }
          blockedUntil = capacityWakeAt.length
            ? Math.min(...capacityWakeAt)
            : now + DEFAULT_EXACT_REVIEW_RETRY_MS;
        }
        return [Math.max(item.nextAttemptAt, blockedUntil)];
      }
      const target = item.decision.targetRepo;
      const blockedUntil = [
        ...(activeReviews.length >= capacity && activeReviewWakeAt.length
          ? [Math.min(...activeReviewWakeAt)]
          : []),
        ...((activeTargetCounts.get(target) || 0) >= targetCapacity &&
        activeTargetWakeAt.has(target)
          ? [activeTargetWakeAt.get(target) as number]
          : []),
      ];
      return [
        Math.max(
          item.nextAttemptAt,
          blockedUntil.length ? Math.min(...blockedUntil) : item.nextAttemptAt,
        ),
      ];
    }
    const leaseExpiresAt = exactReviewEffectiveLeaseExpiresAt(
      item,
      publicationDispatchLeaseMs,
      heartbeatGraceMs,
    );
    return leaseExpiresAt ? [leaseExpiresAt] : [];
  });
  if (!times.length) return null;
  return Math.max(now + 1_000, Math.min(...times));
}

export function exactReviewQueueCapacity(env) {
  return Math.max(
    1,
    Math.min(
      numberFrom(env.WORKER_BUDGET, 128),
      numberFrom(env.EXACT_REVIEW_QUEUE_MAX_CONCURRENT, DEFAULT_EXACT_REVIEW_QUEUE_MAX_CONCURRENT),
    ),
  );
}

export function exactReviewPublicationCapacity(
  env,
  outstandingBacklog = 0,
  activePublishers = 0,
  capacityCeiling = Number.POSITIVE_INFINITY,
  oldestPendingAgeMs = 0,
  netDrainRatePerHour = Number.POSITIVE_INFINITY,
) {
  const maximum = exactReviewPublicationMaximum(env);
  const minimum = exactReviewPublicationMinimum(env, maximum);
  const base = exactReviewPublicationBase(env, maximum);
  const adaptiveMaximum = Math.max(
    minimum,
    Math.min(maximum, Number.isFinite(Number(capacityCeiling)) ? Number(capacityCeiling) : maximum),
  );
  const backlog = Math.max(0, Number(outstandingBacklog) || 0);
  const oldestAge = Math.max(0, Number(oldestPendingAgeMs) || 0);
  let scaleSteps = 0;
  if (
    backlog >= 100 ||
    oldestAge >= 60 * 60 * 1000 ||
    (backlog >= 50 && Number(netDrainRatePerHour) <= 0)
  ) {
    scaleSteps += 1;
  }
  if (backlog >= 250 || oldestAge >= 4 * 60 * 60 * 1000) scaleSteps += 1;
  if (backlog >= 400 || oldestAge >= 8 * 60 * 60 * 1000) scaleSteps += 1;
  const desired = Math.min(
    adaptiveMaximum,
    base + scaleSteps * EXACT_REVIEW_PUBLICATION_CONCURRENT_SCALE_STEP,
  );
  // Scaling down is admission-only. Keep the reported capacity at the active
  // publisher count so a drained backlog does not look over capacity while
  // already-running publication jobs finish naturally.
  return Math.min(maximum, Math.max(desired, Math.max(0, Number(activePublishers) || 0)));
}

function exactReviewPublicationMaximum(env) {
  return Math.max(
    1,
    Math.min(
      exactReviewQueueCapacity(env),
      numberFrom(
        env.EXACT_REVIEW_PUBLICATION_MAX_CONCURRENT,
        DEFAULT_EXACT_REVIEW_PUBLICATION_MAX_CONCURRENT,
      ),
    ),
  );
}

function exactReviewPublicationBase(env, maximum = exactReviewPublicationMaximum(env)) {
  return Math.max(
    exactReviewPublicationMinimum(env, maximum),
    Math.min(
      maximum,
      numberFrom(
        env.EXACT_REVIEW_PUBLICATION_BASE_CONCURRENT,
        DEFAULT_EXACT_REVIEW_PUBLICATION_BASE_CONCURRENT,
      ),
    ),
  );
}

function exactReviewPublicationMinimum(env, maximum = exactReviewPublicationMaximum(env)) {
  return Math.min(
    maximum,
    Math.max(
      1,
      numberFrom(
        env.EXACT_REVIEW_PUBLICATION_MIN_CONCURRENT,
        DEFAULT_EXACT_REVIEW_PUBLICATION_MIN_CONCURRENT,
      ),
    ),
  );
}

function exactReviewPublicationRecoverySuccesses(env) {
  return Math.max(
    1,
    Math.min(
      1_000,
      numberFrom(
        env.EXACT_REVIEW_PUBLICATION_RECOVERY_SUCCESSES,
        DEFAULT_EXACT_REVIEW_PUBLICATION_RECOVERY_SUCCESSES,
      ),
    ),
  );
}

function exactReviewPublicationControl(env, value: unknown): ExactReviewPublicationControl {
  const control = objectValue(value);
  const maximum = exactReviewPublicationMaximum(env);
  const minimum = exactReviewPublicationMinimum(env, maximum);
  const rawCeiling = Number(control.capacityCeiling);
  const rawDemandCapacity = Number(control.demandCapacity);
  const rawCooldown = Number(control.cooldownUntil);
  const rawRecoverySuccesses = Number(control.recoverySuccesses);
  const rawLastFailureAt = Number(control.lastFailureAt);
  const lastFailureKind = exactReviewPublicationFailureKind(control.lastFailureKind);
  return {
    capacityCeiling: Number.isSafeInteger(rawCeiling)
      ? Math.max(minimum, Math.min(maximum, rawCeiling))
      : maximum,
    demandCapacity: Number.isSafeInteger(rawDemandCapacity)
      ? Math.max(minimum, Math.min(maximum, rawDemandCapacity))
      : exactReviewPublicationBase(env, maximum),
    cooldownUntil: Number.isSafeInteger(rawCooldown) && rawCooldown > 0 ? rawCooldown : 0,
    recoverySuccesses:
      Number.isSafeInteger(rawRecoverySuccesses) && rawRecoverySuccesses > 0
        ? rawRecoverySuccesses
        : 0,
    demandSamples: Math.max(0, Number(control.demandSamples) || 0),
    demandTier: Math.max(0, Number(control.demandTier) || 0),
    lastDemandSampleAt: Math.max(0, Number(control.lastDemandSampleAt) || 0),
    lastScaleAt: Math.max(0, Number(control.lastScaleAt) || 0),
    ...(Number.isSafeInteger(rawLastFailureAt) && rawLastFailureAt > 0
      ? { lastFailureAt: rawLastFailureAt }
      : {}),
    ...(lastFailureKind ? { lastFailureKind } : {}),
  };
}

function exactReviewPublicationControlAfterFeedback(
  env,
  control: ExactReviewPublicationControl,
  feedback: ExactReviewPublicationFeedback,
) {
  const maximum = exactReviewPublicationMaximum(env);
  const minimum = exactReviewPublicationMinimum(env, maximum);
  if (feedback.outcome === "failure") {
    const failureKind = feedback.failureKind || "github_transient";
    const rateLimited = failureKind === "github_rate_limit";
    const currentCapacity = Math.max(minimum, Math.min(control.capacityCeiling, feedback.capacity));
    const ceiling = rateLimited
      ? Math.max(minimum, Math.floor(currentCapacity / 2))
      : Math.max(minimum, currentCapacity - EXACT_REVIEW_PUBLICATION_CONCURRENT_SCALE_STEP);
    return {
      ...control,
      capacityCeiling: ceiling,
      cooldownUntil: Math.max(
        control.cooldownUntil,
        feedback.at +
          (rateLimited
            ? EXACT_REVIEW_PUBLICATION_RATE_LIMIT_COOLDOWN_MS
            : EXACT_REVIEW_PUBLICATION_TRANSIENT_COOLDOWN_MS),
      ),
      recoverySuccesses: 0,
      lastFailureAt: feedback.at,
      lastFailureKind: failureKind,
    };
  }
  if (feedback.at < control.cooldownUntil || control.capacityCeiling >= maximum) {
    return { ...control, recoverySuccesses: 0 };
  }
  const recoverySuccesses = control.recoverySuccesses + 1;
  if (recoverySuccesses < exactReviewPublicationRecoverySuccesses(env)) {
    return { ...control, recoverySuccesses };
  }
  return {
    ...control,
    capacityCeiling: Math.min(
      maximum,
      control.capacityCeiling + EXACT_REVIEW_PUBLICATION_CONCURRENT_SCALE_STEP,
    ),
    recoverySuccesses: 0,
  };
}

function exactReviewPublicationControlAfterDemand(
  env,
  control: ExactReviewPublicationControl,
  sample: {
    at: number;
    backlog: number;
    oldestPendingAgeMs: number;
    netDrainRatePerHour: number;
  },
) {
  if (sample.at < control.lastDemandSampleAt + EXACT_REVIEW_PUBLICATION_DEMAND_SAMPLE_MS) {
    return control;
  }
  const maximum = exactReviewPublicationMaximum(env);
  const base = exactReviewPublicationBase(env, maximum);
  const desired = exactReviewPublicationCapacity(
    env,
    sample.backlog,
    0,
    maximum,
    sample.oldestPendingAgeMs,
    sample.netDrainRatePerHour,
  );
  const desiredTier = Math.max(
    0,
    Math.ceil((desired - base) / EXACT_REVIEW_PUBLICATION_CONCURRENT_SCALE_STEP),
  );
  const sameDirection = control.demandTier === desiredTier;
  const demandSamples = sameDirection ? control.demandSamples + 1 : 1;
  const next = {
    ...control,
    demandSamples,
    demandTier: desiredTier,
    lastDemandSampleAt: sample.at,
  };
  if (
    desired > control.demandCapacity &&
    demandSamples >= 2 &&
    sample.at >= control.lastScaleAt + EXACT_REVIEW_PUBLICATION_SCALE_UP_MS
  ) {
    return {
      ...next,
      demandCapacity: Math.min(
        desired,
        control.demandCapacity + EXACT_REVIEW_PUBLICATION_CONCURRENT_SCALE_STEP,
      ),
      demandSamples: 0,
      lastScaleAt: sample.at,
    };
  }
  const healthyDrain =
    sample.backlog < 80 &&
    sample.oldestPendingAgeMs < 30 * 60 * 1000 &&
    sample.netDrainRatePerHour > 0;
  if (
    desired < control.demandCapacity &&
    healthyDrain &&
    demandSamples >= 6 &&
    sample.at >= control.lastScaleAt + EXACT_REVIEW_PUBLICATION_SCALE_DOWN_MS
  ) {
    return {
      ...next,
      demandCapacity: Math.max(
        base,
        control.demandCapacity - EXACT_REVIEW_PUBLICATION_CONCURRENT_SCALE_STEP,
      ),
      demandSamples: 0,
      lastScaleAt: sample.at,
    };
  }
  return next;
}

function exactReviewPublicationControlStatus(env, control: ExactReviewPublicationControl) {
  const maximum = exactReviewPublicationMaximum(env);
  return {
    mode: control.capacityCeiling < maximum ? "throttled" : "adaptive",
    minimum: exactReviewPublicationMinimum(env, maximum),
    base: exactReviewPublicationBase(env, maximum),
    maximum,
    ceiling: control.capacityCeiling,
    demand_capacity: control.demandCapacity,
    demand_samples: control.demandSamples,
    demand_tier: control.demandTier,
    last_scale_at: control.lastScaleAt ? new Date(control.lastScaleAt).toISOString() : null,
    cooldown_until:
      control.cooldownUntil > 0 ? new Date(control.cooldownUntil).toISOString() : null,
    recovery_successes: control.recoverySuccesses,
    last_failure_at:
      control.lastFailureAt && control.lastFailureAt > 0
        ? new Date(control.lastFailureAt).toISOString()
        : null,
    last_failure_kind: control.lastFailureKind || null,
  };
}

function exactReviewPublicationCapacityForState(
  env,
  state: ExactReviewQueueState,
  now: number,
  capacityCeiling = Number.POSITIVE_INFINITY,
  preserveActive = true,
  demandCapacity?: number,
) {
  let outstandingBacklog = 0;
  let activePublishers = 0;
  let activeReviews = 0;
  let oldestPendingAt = Number.POSITIVE_INFINITY;
  for (const item of Object.values(state.items)) {
    if (!exactReviewQueueIsPublication(item)) {
      if (item.state === "dispatching" || item.state === "leased") activeReviews += 1;
      continue;
    }
    if (item.state === "pending") {
      outstandingBacklog += 1;
      oldestPendingAt = Math.min(oldestPendingAt, item.createdAt);
    } else if (item.state === "dispatching" || item.state === "leased") activePublishers += 1;
  }
  // Once the hysteresis controller has sampled demand, its target is the
  // admission decision. Recomputing from backlog alone here would discard the
  // controller's net-drain signal for the 50-99 item pressure tier.
  const requested =
    demandCapacity === undefined
      ? exactReviewPublicationCapacity(
          env,
          outstandingBacklog,
          preserveActive ? activePublishers : 0,
          capacityCeiling,
          Number.isFinite(oldestPendingAt) ? now - oldestPendingAt : 0,
        )
      : Math.min(capacityCeiling, demandCapacity);
  const workerBudget = Math.max(1, numberFrom(env.WORKER_BUDGET, 128));
  const budgeted = Math.max(
    0,
    workerBudget - activeReviews - EXACT_REVIEW_PUBLICATION_ACTIONS_RESERVE,
  );
  return Math.max(preserveActive ? activePublishers : 0, Math.min(requested, budgeted));
}

function exactReviewTargetCapacity(env) {
  return Math.max(
    1,
    Math.min(
      exactReviewQueueCapacity(env),
      numberFrom(
        env.EXACT_REVIEW_TARGET_MAX_CONCURRENT,
        DEFAULT_EXACT_REVIEW_TARGET_MAX_CONCURRENT,
      ),
    ),
  );
}

function exactReviewDispatchLeaseMs(env) {
  return Math.max(
    60_000,
    numberFrom(env.EXACT_REVIEW_DISPATCH_LEASE_MS, DEFAULT_EXACT_REVIEW_DISPATCH_LEASE_MS),
  );
}

function exactReviewPublicationDispatchLeaseMs(env) {
  return Math.max(
    exactReviewDispatchLeaseMs(env),
    DEFAULT_EXACT_REVIEW_PUBLICATION_DISPATCH_LEASE_MS,
  );
}

function exactReviewPublicationBatchingEnabled(env) {
  return String(env.EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED || "").trim() === "1";
}

function exactReviewPublicationBatchSize(env) {
  return Math.max(
    1,
    Math.min(
      MAX_EXACT_REVIEW_PUBLICATION_BATCH_SIZE,
      numberFrom(
        env.EXACT_REVIEW_PUBLICATION_BATCH_SIZE,
        DEFAULT_EXACT_REVIEW_PUBLICATION_BATCH_SIZE,
      ),
    ),
  );
}

function exactReviewPublicationBatchWaitMs(env) {
  return Math.max(
    1_000,
    Math.min(
      5 * 60_000,
      numberFrom(
        env.EXACT_REVIEW_PUBLICATION_BATCH_WAIT_MS,
        DEFAULT_EXACT_REVIEW_PUBLICATION_BATCH_WAIT_MS,
      ),
    ),
  );
}

function exactReviewPublicationBatchDispatchCooldownMs(env) {
  return Math.max(
    1_000,
    Math.min(
      30_000,
      numberFrom(
        env.EXACT_REVIEW_PUBLICATION_BATCH_DISPATCH_COOLDOWN_MS,
        DEFAULT_EXACT_REVIEW_PUBLICATION_BATCH_DISPATCH_COOLDOWN_MS,
      ),
    ),
  );
}

function exactReviewPublicationBatchDispatchReservationMs(env) {
  return Math.max(
    60_000,
    Math.min(
      30 * 60_000,
      numberFrom(
        env.EXACT_REVIEW_PUBLICATION_BATCH_DISPATCH_RESERVATION_MS,
        DEFAULT_EXACT_REVIEW_PUBLICATION_BATCH_DISPATCH_RESERVATION_MS,
      ),
    ),
  );
}

function exactReviewPublicationBatchDeparture(
  env,
  state: ExactReviewQueueState,
  now: number,
  ownedItemKeys: ReadonlySet<string>,
) {
  if (!exactReviewPublicationBatchingEnabled(env) || ownedItemKeys.size > 0) return null;
  const pending = Object.values(state.items)
    .filter(
      (item) =>
        exactReviewQueueIsPublication(item) &&
        item.state === "pending" &&
        !ownedItemKeys.has(item.key),
    )
    .sort((left, right) => left.createdAt - right.createdAt || left.key.localeCompare(right.key));
  const maxItems = exactReviewPublicationBatchSize(env);
  const nextEligibilityAt = pending.reduce(
    (earliest, item) =>
      item.nextAttemptAt > now ? Math.min(earliest, item.nextAttemptAt) : earliest,
    Number.POSITIVE_INFINITY,
  );
  const candidates = pending.filter((item) => item.nextAttemptAt <= now);
  const owner = candidates[0]?.decision.targetRepo.split("/", 1)[0]?.toLowerCase();
  if (!owner) {
    return Number.isFinite(nextEligibilityAt)
      ? { candidateCount: 0, maxItems, dueAt: nextEligibilityAt, due: false }
      : null;
  }
  const candidatesByOwner = new Map<string, ExactReviewQueueItem[]>();
  for (const item of candidates) {
    const candidateOwner = item.decision.targetRepo.split("/", 1)[0]?.toLowerCase();
    if (!candidateOwner) continue;
    const group = candidatesByOwner.get(candidateOwner) ?? [];
    group.push(item);
    candidatesByOwner.set(candidateOwner, group);
  }
  // A full owner can leave immediately; only fall back to the globally oldest
  // partial owner when no owner can fill the configured batch.
  const selectedOwner =
    [...candidatesByOwner].find(([, group]) => group.length >= maxItems)?.[0] ?? owner;
  const ownerCandidates = candidatesByOwner.get(selectedOwner)!;
  const oldestAt = ownerCandidates[0]!.createdAt;
  const fullAt = ownerCandidates.length >= maxItems ? now : Number.POSITIVE_INFINITY;
  const ageAt = oldestAt + exactReviewPublicationBatchWaitMs(env);
  const lastAttemptAt = Number(state.dispatcher?.publicationBatchDispatchedAt || 0);
  const dispatchRetryMs = state.dispatcher?.publicationBatchDispatchSucceeded
    ? exactReviewPublicationBatchDispatchCooldownMs(env)
    : exactReviewPublicationBatchWaitMs(env);
  const retryAt = Math.max(
    lastAttemptAt ? lastAttemptAt + dispatchRetryMs : Number.NEGATIVE_INFINITY,
    Number(state.dispatcher?.publicationBatchDispatchPendingUntil || Number.NEGATIVE_INFINITY),
  );
  const dispatchDueAt = Math.max(Math.min(fullAt, ageAt), retryAt);
  // Future retries remain excluded from the legacy lane while batching is on,
  // so they must retain their own wake-up even when today's partial batch is older.
  const dueAt = Math.min(dispatchDueAt, nextEligibilityAt);
  return {
    candidateCount: ownerCandidates.length,
    maxItems,
    dueAt,
    due: dueAt <= now,
  };
}

function exactReviewBatchDispatcherFields(dispatcher: ExactReviewQueueState["dispatcher"]) {
  return {
    ...(dispatcher?.publicationBatchDispatchedAt
      ? { publicationBatchDispatchedAt: dispatcher.publicationBatchDispatchedAt }
      : {}),
    ...(dispatcher?.publicationBatchDispatchSucceeded !== undefined
      ? { publicationBatchDispatchSucceeded: dispatcher.publicationBatchDispatchSucceeded }
      : {}),
    ...(dispatcher?.publicationBatchDispatchPendingUntil
      ? { publicationBatchDispatchPendingUntil: dispatcher.publicationBatchDispatchPendingUntil }
      : {}),
  };
}

function exactReviewPublicationBatchLeaseMs(env) {
  return Math.max(
    60_000,
    Math.min(
      2 * 60 * 60 * 1000,
      numberFrom(
        env.EXACT_REVIEW_PUBLICATION_BATCH_LEASE_MS,
        DEFAULT_EXACT_REVIEW_PUBLICATION_BATCH_LEASE_MS,
      ),
    ),
  );
}

function exactReviewExecutionLeaseMs(env) {
  return Math.max(
    60_000,
    numberFrom(env.EXACT_REVIEW_EXECUTION_LEASE_MS, DEFAULT_EXACT_REVIEW_EXECUTION_LEASE_MS),
  );
}

function exactReviewHeartbeatGraceMs(env) {
  // Floor must stay above the 5-minute worker heartbeat interval (plus request time and
  // scheduling jitter) or a configured grace would reclaim healthy leases between beats.
  return Math.max(
    420_000,
    numberFrom(env.EXACT_REVIEW_HEARTBEAT_GRACE_MS, DEFAULT_EXACT_REVIEW_HEARTBEAT_GRACE_MS),
  );
}

function exactReviewRetryDelayMs(attempt: number) {
  return Math.min(5 * 60_000, DEFAULT_EXACT_REVIEW_RETRY_MS * 2 ** Math.min(attempt - 1, 4));
}

function exactReviewWorkflowPausedRetryMs(env) {
  return Math.max(
    30_000,
    Math.min(
      15 * 60_000,
      numberFrom(
        env.EXACT_REVIEW_WORKFLOW_PAUSED_RETRY_MS,
        DEFAULT_EXACT_REVIEW_WORKFLOW_PAUSED_RETRY_MS,
      ),
    ),
  );
}

function exactReviewDispatchDebounceMs(env) {
  return Math.max(
    0,
    Math.min(
      15 * 60_000,
      numberFrom(env.EXACT_REVIEW_DISPATCH_DEBOUNCE_MS, DEFAULT_EXACT_REVIEW_DISPATCH_DEBOUNCE_MS),
    ),
  );
}

function exactReviewDispatchDebounceMaxMs(env) {
  return Math.max(
    0,
    Math.min(
      60 * 60_000,
      numberFrom(
        env.EXACT_REVIEW_DISPATCH_DEBOUNCE_MAX_MS,
        DEFAULT_EXACT_REVIEW_DISPATCH_DEBOUNCE_MAX_MS,
      ),
    ),
  );
}

function exactReviewPendingSoftLimit(env) {
  return Math.max(
    1,
    Math.min(
      100_000,
      numberFrom(env.EXACT_REVIEW_PENDING_SOFT_LIMIT, DEFAULT_EXACT_REVIEW_PENDING_SOFT_LIMIT),
    ),
  );
}

function stateAppendMaxPendingRows(env) {
  return Math.max(
    1,
    Math.min(
      1_000_000,
      Math.floor(
        numberFrom(env.STATE_APPEND_MAX_PENDING_ROWS, DEFAULT_STATE_APPEND_MAX_PENDING_ROWS),
      ),
    ),
  );
}

function stateAppendMaxPendingBytes(env) {
  return Math.max(
    1,
    Math.min(
      512 * 1024 * 1024,
      Math.floor(
        numberFrom(env.STATE_APPEND_MAX_PENDING_BYTES, DEFAULT_STATE_APPEND_MAX_PENDING_BYTES),
      ),
    ),
  );
}

function stateAppendMaxRecordBytes(env) {
  return Math.max(
    1,
    Math.min(
      10 * 1024 * 1024,
      Math.floor(
        numberFrom(env.STATE_APPEND_MAX_RECORD_BYTES, DEFAULT_STATE_APPEND_MAX_RECORD_BYTES),
      ),
    ),
  );
}

function stateAppendDrainLeaseMs(env) {
  return Math.max(
    1_000,
    Math.min(
      24 * 60 * 60 * 1000,
      Math.floor(numberFrom(env.STATE_APPEND_DRAIN_LEASE_MS, DEFAULT_STATE_APPEND_DRAIN_LEASE_MS)),
    ),
  );
}

function stateAppendDrainLimit(value: unknown) {
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit > 0 ? limit : null;
}

function stateAppendRecords(value: unknown, maxRecordBytes: number) {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false as const, error: "invalid_state_append_records" };
  }
  const records: StateAppendRecord[] = [];
  for (const valueRecord of value) {
    const record = objectValue(valueRecord);
    const kind = String(record.kind || "").trim() as StateAppendKind;
    if (!STATE_APPEND_KINDS.has(kind)) {
      return { ok: false as const, error: "invalid_state_append_kind" };
    }
    const key = String(record.key || "").trim();
    if (!key || key.length > 2_048) {
      return { ok: false as const, error: "invalid_state_append_key" };
    }
    const producedAt = String(record.produced_at || "").trim();
    if (!producedAt || !Number.isFinite(Date.parse(producedAt))) {
      return { ok: false as const, error: "invalid_state_append_produced_at" };
    }
    if (!Object.hasOwn(record, "payload")) {
      return { ok: false as const, error: "missing_state_append_payload" };
    }
    let payloadJson: string;
    try {
      payloadJson = JSON.stringify(record.payload);
    } catch {
      return { ok: false as const, error: "invalid_state_append_payload" };
    }
    if (payloadJson === undefined) {
      return { ok: false as const, error: "invalid_state_append_payload" };
    }
    const payloadBytes = new TextEncoder().encode(payloadJson).byteLength;
    if (payloadBytes > maxRecordBytes) {
      return { ok: false as const, error: "state_append_payload_too_large" };
    }
    records.push({ kind, key, payloadJson, payloadBytes, producedAt });
  }
  return { ok: true as const, records };
}

function stateAppendWindowRowJson(row: StateAppendWindowRow) {
  return {
    seq: Number(row.seq),
    kind: row.kind,
    key: row.record_key,
    payload: JSON.parse(row.payload_json),
    produced_at: row.produced_at,
    delivery_id: row.delivery_id,
  };
}

async function exactReviewDispatchToken(env) {
  return exactReviewRepositoryToken(env, { actions: "write", contents: "write" });
}

export async function exactReviewActionsReadToken(env) {
  return exactReviewRepositoryToken(env, { actions: "read" });
}

async function exactReviewRepositoryToken(env, permissions) {
  const credentials = githubAppCredentials(env);
  if (!credentials) throw new Error("github app is not configured");
  const appJwt = await signGithubAppJwt(credentials.issuer, credentials.privateKey);
  const installationId = await githubAppInstallationId(appJwt, CLAWSWEEPER_REVIEW_REPO);
  return createGithubAppTokenFor({
    appJwt,
    installationId,
    label: CLAWSWEEPER_REVIEW_REPO,
    repositories: [repoName(CLAWSWEEPER_REVIEW_REPO)],
    permissions,
  });
}

async function exactReviewWorkflowState(token: string) {
  const payload = await githubTokenJson({
    token,
    path: `/repos/${CLAWSWEEPER_REVIEW_REPO}/actions/workflows/sweep.yml`,
    method: "GET",
    body: undefined,
    errorLabel: "ClawSweeper workflow status",
  });
  const state = String(payload.state || "").trim();
  if (!state) throw new Error("ClawSweeper workflow status response missing state");
  return state;
}

export async function exactReviewTerminalRun(
  token: string,
  candidate: ExactReviewClaimedRun & { requestedRunAttempt?: number },
) {
  const latest = await githubTokenJson({
    token,
    path: `/repos/${CLAWSWEEPER_REVIEW_REPO}/actions/runs/${candidate.runId}`,
    method: "GET",
    body: undefined,
    errorLabel: "ClawSweeper run status",
  });
  return exactReviewTerminalRunFromSummary(token, candidate, latest);
}

export async function exactReviewTerminalRunsFromBatch(
  token: string,
  candidates: Array<ExactReviewClaimedRun & { requestedRunAttempt?: number }>,
) {
  const runsById = new Map<string, Record<string, unknown>>();
  const unresolved = new Set(candidates.map((candidate) => candidate.runId));
  for (let page = 1; page <= EXACT_REVIEW_RECONCILE_LIST_PAGE_LIMIT; page += 1) {
    let payload;
    try {
      payload = await githubTokenJson({
        token,
        path: `/repos/${CLAWSWEEPER_REVIEW_REPO}/actions/workflows/sweep.yml/runs?event=repository_dispatch&per_page=100&page=${page}`,
        method: "GET",
        body: undefined,
        errorLabel: "ClawSweeper run batch",
      });
    } catch {
      break;
    }
    const workflowRuns = Array.isArray(payload.workflow_runs) ? payload.workflow_runs : [];
    for (const entry of workflowRuns) {
      const summary = objectValue(entry);
      const runId = String(summary.id || "").trim();
      if (!unresolved.has(runId)) continue;
      runsById.set(runId, summary);
      unresolved.delete(runId);
    }
    if (!unresolved.size || workflowRuns.length < 100) break;
  }
  return mapWithConcurrency(candidates, EXACT_REVIEW_RECONCILE_CONCURRENCY, async (candidate) => {
    const summary = runsById.get(candidate.runId);
    try {
      return summary
        ? await exactReviewTerminalRunFromSummary(token, candidate, summary)
        : await exactReviewTerminalRun(token, candidate);
    } catch {
      return undefined;
    }
  });
}

async function exactReviewTerminalRunFromSummary(
  token: string,
  candidate: ExactReviewClaimedRun & { requestedRunAttempt?: number },
  latest: Record<string, unknown>,
) {
  const expectedRunAttempt = candidate.requestedRunAttempt ?? candidate.runAttempt;
  if (String(latest.id || "") !== candidate.runId) {
    throw new Error("ClawSweeper run status response id mismatch");
  }
  const latestRunAttempt = exactReviewRunAttempt(latest.run_attempt);
  if (!latestRunAttempt) {
    throw new Error("ClawSweeper run status response attempt mismatch");
  }
  if (expectedRunAttempt && latestRunAttempt !== expectedRunAttempt) return null;
  if (String(latest.status || "") !== "completed") return null;

  const payload = await githubTokenJson({
    token,
    path: `/repos/${CLAWSWEEPER_REVIEW_REPO}/actions/runs/${candidate.runId}/attempts/${latestRunAttempt}`,
    method: "GET",
    body: undefined,
    errorLabel: "ClawSweeper run attempt status",
  });
  if (
    String(payload.id || "") !== candidate.runId ||
    exactReviewRunAttempt(payload.run_attempt) !== latestRunAttempt ||
    String(payload.status || "") !== "completed"
  ) {
    throw new Error("ClawSweeper run attempt status response mismatch");
  }
  const conclusion = String(payload.conclusion || "").trim();
  if (!conclusion) throw new Error("ClawSweeper completed run missing conclusion");
  return {
    run_id: candidate.runId,
    run_attempt: latestRunAttempt,
    claimed_run_attempt: candidate.runAttempt ?? null,
    claim_generation: candidate.claimGeneration,
    outcome:
      conclusion === "success" ? "success" : conclusion === "cancelled" ? "cancelled" : "failure",
  } satisfies {
    run_id: string;
    run_attempt: number;
    claimed_run_attempt: number | null;
    claim_generation: number;
    outcome: ExactReviewCompletionOutcome;
  };
}

export async function createGithubAppTokenFor({
  appJwt,
  installationId,
  label,
  repositories,
  permissions,
}) {
  const payload = await githubAppJson(
    `/app/installations/${installationId}/access_tokens`,
    appJwt,
    {
      method: "POST",
      body: JSON.stringify({
        repository_names: repositories.filter(Boolean),
        permissions,
      }),
      errorLabel: `GitHub App token for ${label}`,
    },
  );
  const token = String(payload.token || "");
  if (!token) throw new Error(`GitHub App token response missing token for ${label}`);
  return token;
}

async function dispatchClawsweeperItem({
  token,
  decision,
  itemKey,
  leaseId,
  leaseRevision,
}: {
  token: string;
  decision: ExactReviewDecision;
  itemKey: string;
  leaseId: string;
  leaseRevision: number;
}) {
  // Keep the v1 fields during the rolling-upgrade window. Old workflows consume
  // this immutable dispatch snapshot, while v2 workflows ignore it after claim
  // and consume the Worker's leaseDecision response instead.
  const reviewOptions = {
    ...(decision.codexTimeoutMs ? { codex_timeout_ms: decision.codexTimeoutMs } : {}),
    ...(decision.mediaProofTimeoutMs
      ? { media_proof_timeout_ms: decision.mediaProofTimeoutMs }
      : {}),
    ...(decision.commandStatusMarker
      ? { command_status_marker: decision.commandStatusMarker }
      : {}),
    ...(decision.statusCommentId ? { status_comment_id: decision.statusCommentId } : {}),
    ...(decision.additionalPrompt ? { additional_prompt: decision.additionalPrompt } : {}),
    ...(decision.publication ? { publication: decision.publication } : {}),
  };
  await githubTokenJson({
    token,
    path: `/repos/${CLAWSWEEPER_REVIEW_REPO}/dispatches`,
    method: "POST",
    body: {
      event_type: "clawsweeper_item",
      client_payload: {
        queue_lease_id: leaseId,
        queue_claim: {
          protocol_version: 2,
          item_key: itemKey,
          lease_revision: leaseRevision,
        },
        target_repo: decision.targetRepo,
        target_branch: decision.targetBranch,
        item_number: decision.itemNumber,
        item_kind: decision.itemKind,
        source_event: decision.sourceEvent,
        source_action: decision.sourceAction,
        supersedes_in_progress: decision.supersedesInProgress,
        ...(Object.keys(reviewOptions).length > 0 ? { review_options: reviewOptions } : {}),
      },
    },
    errorLabel: "ClawSweeper item dispatch",
  });
}

async function dispatchExactReviewBatchWorkflow({ token }: { token: string }) {
  await githubTokenJson({
    token,
    path: `/repos/${CLAWSWEEPER_REVIEW_REPO}/actions/workflows/exact-review-batch-publish.yml/dispatches`,
    method: "POST",
    body: {
      ref: "main",
      inputs: { execute: "true" },
    },
    errorLabel: "Exact-review batch workflow dispatch",
  });
}

async function githubTokenJson({ token, path, method = "GET", body, errorLabel }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), GITHUB_TIMEOUT_MS);
  const init: RequestInit = {
    method,
    signal: controller.signal,
    headers: {
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "openclaw-clawsweeper-webhook",
      Authorization: `Bearer ${token}`,
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(`https://api.github.com${path}`, init).finally(() =>
    clearTimeout(timeout),
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `${errorLabel || "GitHub"} ${response.status}${text ? `: ${text.slice(0, 240)}` : ""}`,
    );
  }
  if (response.status === 204) return {};
  return response.json();
}

function exactReviewPublicationBatchId(value) {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9._:-]{1,200}$/.test(text) ? text : "";
}

function exactReviewPublicationBatchOwner(value) {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9._:@/-]{1,200}$/.test(text) ? text : "";
}

function exactReviewPublicationBatchCompletions(value): PublicationBatchCompletion[] | null {
  if (!Array.isArray(value) || value.length > MAX_EXACT_REVIEW_PUBLICATION_BATCH_SIZE) return null;
  // PR1 only exposes outcomes whose existing queue terminal semantics are complete.
  // Retry and dead-letter classifications stay on the legacy path until PR3 wires
  // per-item batch failures through finishExactReviewPublicationQueueItem.
  const outcomes = new Set(["published", "superseded"]);
  const seen = new Set<string>();
  const completions: PublicationBatchCompletion[] = [];
  for (const raw of value) {
    const item = objectValue(raw);
    const itemKey = String(item.item_key || "").trim();
    const revision = Number(item.revision);
    const claimGeneration = Number(item.claim_generation);
    const terminalOutcome = String(item.terminal_outcome || "").trim();
    if (
      !itemKey ||
      itemKey.length > 500 ||
      seen.has(itemKey) ||
      !Number.isInteger(revision) ||
      revision < 1 ||
      !Number.isInteger(claimGeneration) ||
      claimGeneration < 1 ||
      !outcomes.has(terminalOutcome)
    ) {
      return null;
    }
    seen.add(itemKey);
    completions.push({
      itemKey,
      revision,
      claimGeneration,
      terminalOutcome: terminalOutcome as PublicationBatchCompletion["terminalOutcome"],
    });
  }
  return completions;
}

function exactReviewPublicationBatchMembers(value): PublicationBatchFence[] | null {
  if (!Array.isArray(value) || value.length > MAX_EXACT_REVIEW_PUBLICATION_BATCH_SIZE) return null;
  const seen = new Set<string>();
  const members: PublicationBatchFence[] = [];
  for (const raw of value) {
    const item = objectValue(raw);
    const itemKey = String(item.item_key || "").trim();
    const revision = Number(item.revision);
    const claimGeneration = Number(item.claim_generation);
    if (
      !itemKey ||
      itemKey.length > 500 ||
      seen.has(itemKey) ||
      !Number.isInteger(revision) ||
      revision < 1 ||
      !Number.isInteger(claimGeneration) ||
      claimGeneration < 1
    ) {
      return null;
    }
    seen.add(itemKey);
    members.push({ itemKey, revision, claimGeneration });
  }
  return members;
}

function exactReviewPublicationBatchJson(batch) {
  return {
    batch_id: batch.batchId,
    state: batch.state,
    lease_owner: batch.leaseOwner,
    lease_expires_at: new Date(batch.leaseExpiresAt).toISOString(),
    attempt: batch.attempt,
    created_at: new Date(batch.createdAt).toISOString(),
    completed_at: batch.completedAt === null ? null : new Date(batch.completedAt).toISOString(),
    state_commit_sha: batch.stateCommitSha,
    failure_fingerprint: batch.failureFingerprint,
    items: batch.items.map((item) => ({
      item_key: item.itemKey,
      revision: item.revision,
      claim_generation: item.claimGeneration,
      terminal_outcome: item.terminalOutcome,
    })),
  };
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function repoName(repo) {
  return String(repo || "").split("/")[1] || "";
}

async function mapWithConcurrency<Item, Result>(
  items: Item[],
  concurrency: number,
  mapper: (item: Item, index: number) => Promise<Result>,
): Promise<Result[]> {
  if (!items.length) return [];
  const results = Array.from({ length: items.length }) as Result[];
  let nextIndex = 0;
  const workerCount = Math.min(items.length, concurrency);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index], index);
      }
    }),
  );
  return results;
}

function githubAppCredentials(env) {
  const issuer = stringEnv(env.CLAWSWEEPER_APP_ID) || stringEnv(env.CLAWSWEEPER_APP_CLIENT_ID);
  const privateKey = normalizePrivateKey(env.CLAWSWEEPER_APP_PRIVATE_KEY);
  if (!issuer || !privateKey) return null;
  return {
    issuer,
    privateKey,
    installationId: stringEnv(env.CLAWSWEEPER_APP_INSTALLATION_ID),
  };
}

async function githubAppInstallationId(appJwt, repo) {
  if (!repo || !repo.includes("/")) throw new Error("GitHub App installation repo is required");
  const payload = await githubAppJson(`/repos/${repo}/installation`, appJwt, {
    errorLabel: "GitHub App installation",
  });
  const installationId = Number(payload.id);
  if (!Number.isInteger(installationId) || installationId <= 0) {
    throw new Error(`GitHub App installation response missing id for ${repo}`);
  }
  return String(installationId);
}

async function githubAppJson(path, appJwt, options: GithubAppJsonOptions = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), GITHUB_TIMEOUT_MS);
  const response = await fetch(`https://api.github.com${path}`, {
    method: options.method || "GET",
    signal: controller.signal,
    headers: {
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "openclaw-clawsweeper-status",
      Authorization: `Bearer ${appJwt}`,
    },
    body: options.body,
  }).finally(() => clearTimeout(timeout));
  if (!response.ok) throw new Error(`${options.errorLabel || "GitHub App"} ${response.status}`);
  return response.json();
}

async function signGithubAppJwt(issuer, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64UrlEncode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: issuer }));
  const input = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(input),
  );
  return `${input}.${base64UrlEncode(new Uint8Array(signature))}`;
}

function normalizePrivateKey(value) {
  return stringEnv(value)?.replace(/\\n/g, "\n") || "";
}

function pemToPkcs8(pem) {
  const pkcs8 = pemBody(pem, "PRIVATE KEY");
  if (pkcs8) return pkcs8;
  const pkcs1 = pemBody(pem, "RSA PRIVATE KEY");
  if (!pkcs1) throw new Error("GitHub App private key must be PEM encoded");
  return wrapPkcs1PrivateKey(pkcs1);
}

function pemBody(pem, label) {
  const pattern = new RegExp(`-----BEGIN ${label}-----([\\s\\S]+?)-----END ${label}-----`, "m");
  const match = String(pem).match(pattern);
  if (!match) return null;
  const binary = atob(match[1].replace(/\s+/g, ""));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function wrapPkcs1PrivateKey(pkcs1) {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const algorithm = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]);
  const octetString = derElement(0x04, pkcs1);
  return derElement(0x30, concatBytes(version, algorithm, octetString));
}

function derElement(tag, value) {
  return concatBytes(new Uint8Array([tag]), derLength(value.length), value);
}

function derLength(length) {
  if (length < 0x80) return new Uint8Array([length]);
  const bytes = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function concatBytes(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function base64UrlEncode(value) {
  const bytes =
    typeof value === "string"
      ? new TextEncoder().encode(value)
      : value instanceof Uint8Array
        ? value
        : new Uint8Array(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function stringEnv(value) {
  const text = String(value || "").trim();
  return text ? text : "";
}

function numberFrom(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function json(value, status = 200) {
  return cors(
    new Response(JSON.stringify(value, null, 2), {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    }),
  );
}

function cors(response) {
  response.headers.set("access-control-allow-origin", "*");
  response.headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  response.headers.set("access-control-allow-headers", "authorization,content-type");
  return response;
}
