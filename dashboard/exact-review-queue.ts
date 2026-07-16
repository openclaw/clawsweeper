import { stableJson } from "../src/stable-json.ts";
import { summarizeExactReviewHandoff } from "./exact-review-health.ts";

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
  state: "pending" | "dispatching" | "leased";
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
};
export type ExactReviewCompletionOutcome = "success" | "failure" | "cancelled";
type ExactReviewPublicationFailureKind = "github_rate_limit" | "github_transient";
type ExactReviewPublicationFeedback = {
  at: number;
  capacity: number;
  outcome: "success" | "failure";
  failureKind?: ExactReviewPublicationFailureKind;
};
type ExactReviewPublicationControl = {
  capacityCeiling: number;
  cooldownUntil: number;
  recoverySuccesses: number;
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
  };
};
type LegacyExactReviewQueueState = ExactReviewQueueState & {
  deliveries?: Record<string, number>;
};
type ExactReviewQueueBaseline = {
  items: Map<string, string>;
  dispatcherJson: string | null;
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
  publication: { enqueued: number; completed: number };
};
type ExactReviewQueueMetricDelta = {
  reviewEnqueued?: number;
  reviewCompleted?: number;
  publicationEnqueued?: number;
  publicationCompleted?: number;
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
const EXACT_REVIEW_PUBLICATION_READY_PER_SCALE_STEP = 250;
const EXACT_REVIEW_PUBLICATION_CONCURRENT_SCALE_STEP = 8;
const EXACT_REVIEW_PUBLICATION_RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000;
const EXACT_REVIEW_PUBLICATION_TRANSIENT_COOLDOWN_MS = 5 * 60 * 1000;
const EXACT_REVIEW_PUBLICATION_RECOVERY_SUCCESSES = 50;
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
const EXACT_REVIEW_PUBLICATION_CONTROL_KEY = "exact-review-publication-control:v1";
export const EXACT_REVIEW_QUEUE_NAME = "global";
const EXACT_REVIEW_COMMAND_STATUS_MARKER_PATTERN =
  /^<!-- clawsweeper-command-status:[^<>\r\n]{1,200} -->$/;
const EXACT_REVIEW_ADDITIONAL_PROMPT_MAX_CHARS = 5000;

export class ExactReviewQueue {
  private storage;
  private env;
  private ready: Promise<void>;
  private migratedAt = 0;
  private legacyMirrorDisabled = false;
  private legacyMirrorWarningReported = false;
  private readonly baselines = new WeakMap<ExactReviewQueueState, ExactReviewQueueBaseline>();

  constructor(state, env) {
    this.storage = state.storage;
    this.env = env;
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
            current.decision =
              current.state === "pending"
                ? mergePendingExactReviewDecision(current.decision, decision)
                : decision;
            current.revision += 1;
            current.updatedAt = now;
            // Immediacy must come from the merged decision: a pending explicit command
            // keeps its command marker through the merge, and a later plain webhook
            // event must not re-debounce it.
            current.nextAttemptAt =
              current.state === "pending"
                ? exactReviewQueueDebouncedAttemptAt(
                    state,
                    current.decision,
                    now,
                    current.createdAt,
                    this.env,
                  )
                : exactReviewQueueEnqueueAttemptAt(state, now);
            if (current.state === "pending") {
              current.attempts = 0;
            }
          }
        } else {
          if (
            isLowPriorityExactReviewDecision(decision) &&
            exactReviewQueuePendingCount(state) >= exactReviewPendingSoftLimit(this.env)
          ) {
            state.shedSinceReset = exactReviewShedSinceReset(state) + 1;
            this.writeStateSync(state);
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
      if (failureKind && !publicationItem) {
        return json({ error: "failure_kind_outside_publication" }, 400);
      }
      const publicationDesiredCapacity = publicationItem
        ? exactReviewPublicationCapacityForState(
            this.env,
            state,
            now,
            this.publicationControlSync().capacityCeiling,
            false,
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
      const requeued = finishExactReviewQueueItem(
        state,
        item,
        now,
        outcome,
        requestedRetryAt ?? undefined,
        requeueLatest,
      );
      // A successful workflow can still request requeue_latest after source
      // drift. That work did not leave its lane, so it must not improve the
      // operator-facing net speed until a later revision actually completes.
      const completedLane = outcome === "success" && !requeued ? exactReviewQueueLane(item) : null;
      await this.writeState(
        state,
        {
          ...(completedLane === "review" ? { reviewCompleted: 1 } : {}),
          ...(completedLane === "publication" ? { publicationCompleted: 1 } : {}),
        },
        publicationItem && ((outcome === "success" && !requeued) || failureKind)
          ? {
              at: now,
              capacity: publicationDesiredCapacity,
              outcome: outcome === "success" ? "success" : "failure",
              ...(failureKind ? { failureKind } : {}),
            }
          : undefined,
      );
      await this.scheduleNext(state, now);
      return json({ ok: true, requeued });
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
        if (didRequeue) requeued += 1;
        else {
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
          publicationCompleted: completedPublications,
        });
        await this.scheduleNext(state, now);
      }
      return json({ ok: true, reconciled, requeued, completed });
    }

    if (request.method === "GET" && url.pathname === "/stats") {
      const now = Date.now();
      const snapshot = this.storage.transactionSync(() => {
        this.pruneDeliveryReceiptsSync(now);
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
        return { state: current, metrics: this.queueMetricTotalsSync() };
      });
      const { state, metrics } = snapshot;
      await this.scheduleNext(state, now);
      const publicationControl = this.publicationControlSync();
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
        ),
        exactReviewDispatchLeaseMs(this.env),
        exactReviewExecutionLeaseMs(this.env),
        exactReviewPublicationDispatchLeaseMs(this.env),
        exactReviewHeartbeatGraceMs(this.env),
      );
      return json({
        ...stats,
        lanes: {
          review: {
            ...stats.lanes.review,
            enqueued_total: metrics.review.enqueued,
            completed_total: metrics.review.completed,
          },
          publication: {
            ...stats.lanes.publication,
            enqueued_total: metrics.publication.enqueued,
            completed_total: metrics.publication.completed,
            capacity_control: exactReviewPublicationControlStatus(this.env, publicationControl),
          },
        },
        delivery_receipts: this.deliveryReceiptCountSync(),
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
      this.syncLegacyCompatibilitySync(this.readStateSync());
    });
    const snapshot = this.readStateSync();
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
    const snapshotPublicationCapacity = exactReviewPublicationCapacityForState(
      this.env,
      snapshot,
      startedAt,
      this.publicationControlSync().capacityCeiling,
    );
    const snapshotAdmission = exactReviewQueueAdmittedItems(
      snapshot,
      startedAt,
      capacity,
      targetCapacity,
      snapshotPublicationCapacity,
    );
    if (!snapshotAdmission.length) {
      if (snapshotChanged) await this.writeState(snapshot);
      await this.scheduleNext(snapshot, startedAt);
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
    reclaimExpiredExactReviewLeases(
      state,
      now,
      exactReviewPublicationDispatchLeaseMs(this.env),
      exactReviewHeartbeatGraceMs(this.env),
    );
    expireExactReviewPublicationItems(state, now, this.env);
    // The preflight fetch releases the input gate, so publication demand may
    // have crossed a scale boundary while the workflow state was checked.
    const publicationCapacity = exactReviewPublicationCapacityForState(
      this.env,
      state,
      now,
      this.publicationControlSync().capacityCeiling,
    );
    const admitted = exactReviewQueueAdmittedItems(
      state,
      now,
      capacity,
      targetCapacity,
      publicationCapacity,
    );
    if (!preflight.ok) {
      const retryAt = now + exactReviewWorkflowPausedRetryMs(this.env);
      state.dispatcher = {
        state: "blocked",
        reason: "workflow_status_unavailable",
        checkedAt: now,
        retryAt,
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
      };
      await this.writeState(state);
      await this.scheduleNext(state, now);
      return;
    }

    state.dispatcher = {
      state: "active",
      workflowState: preflight.workflowState,
      checkedAt: now,
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

  private async initializeStorage() {
    this.ensureStorageSchemaSync();
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
    ]) {
      const present = Array.from(
        this.storage.sql.exec(
          `SELECT name FROM pragma_table_info('${EXACT_REVIEW_QUEUE_METRICS_TABLE}')
            WHERE name = ?`,
          column,
        ),
      ).length;
      if (!present) {
        this.storage.sql.exec(
          `ALTER TABLE ${EXACT_REVIEW_QUEUE_METRICS_TABLE}
             ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0 CHECK (${column} >= 0)`,
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
  ) {
    this.storage.transactionSync(() => {
      this.writeStateSync(state);
      this.incrementQueueMetricsSync(metricDelta);
      if (publicationFeedback) this.applyPublicationFeedbackSync(publicationFeedback);
    });
  }

  private publicationControlSync() {
    return exactReviewPublicationControl(
      this.env,
      this.storage.kv.get(EXACT_REVIEW_PUBLICATION_CONTROL_KEY),
    );
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
                publication_enqueued_total, publication_completed_total
           FROM ${EXACT_REVIEW_QUEUE_METRICS_TABLE}
          WHERE singleton_id = 1`,
      ),
    )[0] as
      | {
          review_enqueued_total?: number;
          review_completed_total?: number;
          publication_enqueued_total?: number;
          publication_completed_total?: number;
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
      },
    };
  }

  private incrementQueueMetricsSync(delta: ExactReviewQueueMetricDelta) {
    const reviewEnqueued = exactReviewMetricDelta(delta.reviewEnqueued);
    const reviewCompleted = exactReviewMetricDelta(delta.reviewCompleted);
    const publicationEnqueued = exactReviewMetricDelta(delta.publicationEnqueued);
    const publicationCompleted = exactReviewMetricDelta(delta.publicationCompleted);
    if (!reviewEnqueued && !reviewCompleted && !publicationEnqueued && !publicationCompleted) {
      return;
    }
    this.storage.sql.exec(
      `UPDATE ${EXACT_REVIEW_QUEUE_METRICS_TABLE}
          SET review_enqueued_total = review_enqueued_total + ?,
              review_completed_total = review_completed_total + ?,
              publication_enqueued_total = publication_enqueued_total + ?,
              publication_completed_total = publication_completed_total + ?
        WHERE singleton_id = 1`,
      reviewEnqueued,
      reviewCompleted,
      publicationEnqueued,
      publicationCompleted,
    );
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
    const next = exactReviewQueueNextWakeAt(
      state,
      now,
      exactReviewQueueCapacity(this.env),
      exactReviewTargetCapacity(this.env),
      exactReviewPublicationCapacityForState(
        this.env,
        state,
        now,
        this.publicationControlSync().capacityCeiling,
      ),
      exactReviewPublicationDispatchLeaseMs(this.env),
      exactReviewHeartbeatGraceMs(this.env),
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

function exactReviewRunAttempt(value): number | null {
  const runAttempt = Number(value);
  return Number.isInteger(runAttempt) && runAttempt > 0 ? runAttempt : null;
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
  if (hasNewerRevision) item.attempts = 0;
  item.updatedAt = now;
  return true;
}

function expireExactReviewPublicationItems(state: ExactReviewQueueState, now: number, env) {
  let changed = false;
  for (const [key, item] of Object.entries(state.items)) {
    const publication = item.decision.publication;
    if (
      item.state !== "pending" ||
      !publication ||
      now < item.createdAt + EXACT_REVIEW_ARTIFACT_RETRY_MAX_MS
    ) {
      continue;
    }
    delete state.items[key];
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
    if (current?.state === "pending") {
      current.decision = mergePendingExactReviewDecision(current.decision, decision);
      current.revision += 1;
      current.updatedAt = now;
      // Merged decision, not the raw recovery: a pending explicit command must
      // keep its immediate attempt time (same rule as the enqueue merge path).
      current.nextAttemptAt = exactReviewQueueDebouncedAttemptAt(
        state,
        current.decision,
        now,
        current.createdAt,
        env,
      );
      current.attempts = 0;
    } else if (!current) {
      // The expired publication was already deleted above; shedding here only
      // suppresses creation of its replacement recovery item.
      if (exactReviewQueuePendingCount(state) >= exactReviewPendingSoftLimit(env)) {
        state.shedSinceReset = exactReviewShedSinceReset(state) + 1;
        changed = true;
        continue;
      }
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
    changed = true;
  }
  return changed;
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

function exactReviewQueueIsPublication(item: ExactReviewQueueItem) {
  return item.decision.sourceAction === EXACT_REVIEW_ARTIFACT_PUBLISH_SOURCE_ACTION;
}

function exactReviewQueueLane(item: ExactReviewQueueItem) {
  return exactReviewQueueIsPublication(item) ? "publication" : "review";
}

function exactReviewQueueActiveReviewCount(state: ExactReviewQueueState) {
  return Object.values(state.items).filter(
    (item) =>
      !exactReviewQueueIsPublication(item) &&
      (item.state === "dispatching" || item.state === "leased"),
  ).length;
}

export function exactReviewQueueAdmittedItems(
  state: ExactReviewQueueState,
  now: number,
  capacity: number,
  targetCapacity: number,
  publicationCapacity: number,
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
    .filter((item) => item.state === "pending" && item.nextAttemptAt <= now)
    .sort((left, right) => left.createdAt - right.createdAt || left.key.localeCompare(right.key));
  for (const item of pending) {
    const publication = exactReviewQueueIsPublication(item);
    if (publication) {
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
) {
  const items = Object.values(state.items);
  const handoffHealth = summarizeExactReviewHandoff({
    items,
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
    } else {
      current.leased += 1;
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
  return {
    pending: handoffHealth.phases.pending.count,
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
  const dispatchingItems = items.filter((item) => item.state === "dispatching");
  const leasedItems = items.filter((item) => item.state === "leased");
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
  const nextAttemptAt = pendingItems.reduce<number | null>(
    (next, item) => (next === null ? item.nextAttemptAt : Math.min(next, item.nextAttemptAt)),
    null,
  );
  return {
    pending: pendingItems.length,
    pending_depth: pendingItems.length,
    shed_since_reset: shedSinceReset,
    ready: pendingItems.filter((item) => item.nextAttemptAt <= now).length,
    backoff: pendingItems.filter((item) => item.nextAttemptAt > now).length,
    dispatching: dispatchingItems.length,
    leased: leasedItems.length,
    capacity,
    active,
    available_slots: Math.max(0, capacity - active),
    oldest_pending_at: oldestPendingAt === null ? null : new Date(oldestPendingAt).toISOString(),
    oldest_pending_age_seconds:
      oldestPendingAt === null ? null : Math.max(0, Math.floor((now - oldestPendingAt) / 1_000)),
    oldest_pending_key: oldestPendingKey ?? null,
    next_attempt_at: nextAttemptAt === null ? null : new Date(nextAttemptAt).toISOString(),
  };
}

export function exactReviewQueueNextWakeAt(
  state: ExactReviewQueueState,
  now: number,
  capacity = Number.POSITIVE_INFINITY,
  targetCapacity = Number.POSITIVE_INFINITY,
  publicationCapacity = Number.POSITIVE_INFINITY,
  publicationDispatchLeaseMs = DEFAULT_EXACT_REVIEW_PUBLICATION_DISPATCH_LEASE_MS,
  heartbeatGraceMs = DEFAULT_EXACT_REVIEW_HEARTBEAT_GRACE_MS,
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
      if (dispatcherPaused) return [dispatcherRetryAt];
      if (exactReviewQueueIsPublication(item)) {
        const blockedUntil =
          activePublishers.length >= publicationCapacity && activePublisherWakeAt.length
            ? Math.min(...activePublisherWakeAt)
            : item.nextAttemptAt;
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
  if (!times.length) return now + DEFAULT_EXACT_REVIEW_RETRY_MS;
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
  readyBacklog = 0,
  activePublishers = 0,
  capacityCeiling = Number.POSITIVE_INFINITY,
) {
  const maximum = exactReviewPublicationMaximum(env);
  const minimum = exactReviewPublicationMinimum(env, maximum);
  const base = exactReviewPublicationBase(env, maximum);
  const adaptiveMaximum = Math.max(
    minimum,
    Math.min(maximum, Number.isFinite(Number(capacityCeiling)) ? Number(capacityCeiling) : maximum),
  );
  const scaleSteps = Math.floor(
    Math.max(0, Number(readyBacklog) || 0) / EXACT_REVIEW_PUBLICATION_READY_PER_SCALE_STEP,
  );
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

function exactReviewPublicationControl(env, value: unknown): ExactReviewPublicationControl {
  const control = objectValue(value);
  const maximum = exactReviewPublicationMaximum(env);
  const minimum = exactReviewPublicationMinimum(env, maximum);
  const rawCeiling = Number(control.capacityCeiling);
  const rawCooldown = Number(control.cooldownUntil);
  const rawRecoverySuccesses = Number(control.recoverySuccesses);
  const rawLastFailureAt = Number(control.lastFailureAt);
  const lastFailureKind = exactReviewPublicationFailureKind(control.lastFailureKind);
  return {
    capacityCeiling: Number.isSafeInteger(rawCeiling)
      ? Math.max(minimum, Math.min(maximum, rawCeiling))
      : maximum,
    cooldownUntil: Number.isSafeInteger(rawCooldown) && rawCooldown > 0 ? rawCooldown : 0,
    recoverySuccesses:
      Number.isSafeInteger(rawRecoverySuccesses) && rawRecoverySuccesses > 0
        ? rawRecoverySuccesses
        : 0,
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
  if (recoverySuccesses < EXACT_REVIEW_PUBLICATION_RECOVERY_SUCCESSES) {
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

function exactReviewPublicationControlStatus(env, control: ExactReviewPublicationControl) {
  const maximum = exactReviewPublicationMaximum(env);
  return {
    mode: control.capacityCeiling < maximum ? "throttled" : "adaptive",
    minimum: exactReviewPublicationMinimum(env, maximum),
    base: exactReviewPublicationBase(env, maximum),
    maximum,
    ceiling: control.capacityCeiling,
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
) {
  let readyBacklog = 0;
  let activePublishers = 0;
  for (const item of Object.values(state.items)) {
    if (!exactReviewQueueIsPublication(item)) continue;
    if (item.state === "pending" && item.nextAttemptAt <= now) readyBacklog += 1;
    else if (item.state === "dispatching" || item.state === "leased") activePublishers += 1;
  }
  return exactReviewPublicationCapacity(
    env,
    readyBacklog,
    preserveActive ? activePublishers : 0,
    capacityCeiling,
  );
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

async function exactReviewDispatchToken(env) {
  return exactReviewRepositoryToken(env, { actions: "read", contents: "write" });
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
