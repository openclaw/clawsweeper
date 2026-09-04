import { stableJson } from "../src/stable-json.ts";
import { parseAuditWaveState, type AuditWaveState } from "../src/audit-wave-state.ts";
import {
  HOSTED_TARGET_ELIGIBILITY_HEADER,
  hostedTargetRetryAfterSeconds,
  hostedTargetRetryableAdmission,
  normalizeHostedTargetAdmission,
  probeHostedPublicTarget,
  resolveHostedTargetEligibility,
  type HostedTargetEligibility,
  type HostedTargetAdmission,
} from "../src/hosted-target-admission.ts";
import {
  clawSweeperCommandAckMarker,
  renderClawSweeperQueuedAcknowledgement,
} from "../src/repair/comment-command-text.ts";
import { planCommandAckConvergence } from "../src/repair/command-ack-convergence.ts";
import type { DirectReReviewDecision } from "../src/repair/direct-re-review-admission.ts";
import {
  normalizeStateWriterOperation,
  normalizeStateWriterProgress,
  payloadHash,
  type StateWriterOperation,
} from "../src/state-writer-telemetry.ts";
import { summarizeExactReviewPublicationHealth } from "./exact-review-health.ts";
import {
  ExactReviewFailureTelemetryStore,
  EXACT_REVIEW_FAILURE_HEALTH_WINDOW_MS,
  exactReviewFailureDetail,
  exactReviewFailureSource,
  exactReviewFailureSourceFingerprint,
  normalizeExactReviewFailureDetail,
  stableExactReviewFailureFingerprint,
  type ExactReviewFailureDetail,
} from "./exact-review-failure-telemetry.ts";
import {
  ExactReviewPublicationBatchStore,
  type PublicationBatchCompletion,
  type PublicationBatchFence,
  type PublicationBatchObservationStage,
} from "./exact-review-publication-batches.ts";
import {
  exactReviewPublicationRetryDelayMs,
  exactReviewPublicationRetryExhausted,
} from "./exact-review-publication-retry.ts";
import {
  CanonicalRecordTupleConflictError,
  EXACT_REVIEW_DIRECT_PUBLICATION_MAX_FILE_BYTES,
  EXACT_REVIEW_DIRECT_PUBLICATION_MAX_POST_BYTES,
  REVIEW_COVERAGE_INVENTORY_KEY,
  ExactReviewDirectPublicationStore,
  RecordExportConsistencyError,
  directPublicationRejectionDetail,
  normalizeReviewCoverageInventory,
  sha256Hex,
  validateCanonicalRecordTupleMutation,
  validateDirectPublicationPlan,
  validateRecordId,
  validateRecordSection,
  validateRepoSlug,
  validateTupleRecordSection,
  type CanonicalDirectPublicationPlan,
  type DirectPublicationPlan,
  type CanonicalRecordTupleMutation,
  type CanonicalCommitRecordInput,
  type RecordSection,
  type ReviewCoverageSummary,
} from "./exact-review-direct-publication.ts";
import {
  EXACT_REVIEW_QUEUE_TRACE_HEADER,
  exactReviewQueueEndpointTemplate,
  exactReviewQueueTraceId,
} from "./exact-review-queue-observability.ts";
import {
  REVIEW_OBSERVABILITY_RANGES,
  summarizeReviewObservability,
} from "./review-observability.ts";
import { StateWriterCoordinator, type StateWriterTicketInput } from "./state-writer-coordinator.ts";
import {
  type DurableReviewRunTelemetry,
  normalizeReviewRunTelemetry,
} from "./review-run-telemetry.ts";
import {
  ExactReviewRecordSnapshotStore,
  RECORD_SNAPSHOT_DOWNLOAD_MAX_BYTES,
  SnapshotRegistrationError,
  SnapshotStoreUnavailableError,
  type RecordSnapshot,
} from "./record-snapshots.ts";
import {
  commandAcknowledgementState,
  EXACT_REVIEW_ACKNOWLEDGEMENT_ATTEMPT_LEASE_MS,
  ExactReviewLifecycleProjectionStore,
  lifecycleState,
  parseDurableLifecycleAuditCursor,
  type ExactReviewLifecycleProjection,
  type LifecycleTerminalDisposition,
} from "./exact-review-lifecycle.ts";
import {
  ExactReviewLifecycleTelemetryStore,
  unknownBaySnapshot,
} from "./exact-review-lifecycle-telemetry.ts";
import { GithubEgressTelemetryStore } from "./github-egress-telemetry.ts";
import {
  ExactReviewCommandIntakeStore,
  type ExactReviewCommandIntakeRecord,
} from "./exact-review-command-intake.ts";
import { recentDurablePublicationEvents } from "./recent-durable-publication-events.ts";
import { sanitizedServerError } from "./error-safety.ts";
import { GithubEtagResponseStore } from "./github-etag-cache.ts";
import { GithubWebhookReadModelStore } from "./github-webhook-read-model.ts";
import { githubEtagCacheKeyFromValue } from "../src/github-etag-cache-contract.ts";
import {
  ExactReviewArtifactReceiptStore,
  exactReviewArtifactReceiptTuple,
} from "./exact-review-artifact-cache.ts";
import {
  GitHubRequestError,
  createGithubAppTokenFor,
  githubApiUrl,
  githubAppCredentials,
  githubAppInstallationId,
  githubResponseRateLimitHint,
  githubResponseRateLimited,
  githubResponseValidationDetail,
  signGithubAppJwt,
  type GitHubRateLimitHint,
  type GitHubRequestValidationDetail,
} from "./github-api.ts";

import {
  EXACT_REVIEW_ARTIFACT_PUBLISH_SOURCE_ACTION,
  EXACT_REVIEW_ARTIFACT_RETENTION_RECOVERY_SOURCE_ACTION,
  EXACT_REVIEW_BRANCH_AUTHORITY_RESERVATION_PREFIX,
  EXACT_REVIEW_SOURCE_AUTHORITY_RESERVATION_PREFIX,
  EXACT_REVIEW_SOURCE_AUTHORITY_RETRY_LIMIT,
  EXACT_REVIEW_SOURCE_DRIFT_REQUEUE_SOURCE_ACTION,
  FAILED_REVIEW_SHARD_RECOVERY_SOURCE_ACTION,
  advanceExactReviewSourceAuthorityWatermark,
  exactReviewBranchAuthorityDecisionFrom,
  exactReviewBranchAuthorityReservationFrom,
  exactReviewBranchAuthorityReservationKey,
  exactReviewDecisionAtLiveHead,
  exactReviewDecisionCanSupersedeReview,
  exactReviewDecisionHasCommandContext,
  exactReviewCommandObligationSurvives,
  exactReviewCommandVersionIsOlder,
  exactReviewDecisionFrom,
  exactReviewDecisionWithoutSourceAuthority,
  exactReviewEditedSemanticInput,
  exactReviewIngressCanPromoteFallback,
  exactReviewIngressFrom,
  exactReviewItemKey,
  exactReviewPublicationLineage,
  exactReviewPublicationLineageKey,
  exactReviewPublicationProducerIsNewer,
  exactReviewPublicationRevision,
  exactReviewQueueHasCommandContext,
  exactReviewQueueHasStaleLiveHead,
  exactReviewQueueIsBatchablePublication,
  exactReviewQueueIsPublication,
  exactReviewSourceAuthorityReservationFrom,
  exactReviewSourceAuthorityReservationKey,
  exactReviewSourceAuthorityWatermark,
  exactReviewTerminalFinalizationSharesCommandStatus,
  isExactReviewQueueTargetEnabled,
  isImmediateExactReviewDecision,
  isLowPriorityExactReviewDecision,
  mergePendingExactReviewDecision,
  type ExactReviewBranchAuthorityReservation,
  type ExactReviewDecision,
  type ExactReviewEditedSemanticInput,
  type ExactReviewIngress,
  type ExactReviewPublication,
  type ExactReviewPublicationLineage,
  type ExactReviewSourceAuthorityReservation,
  type ExactReviewTargetItemState,
} from "./exact-review-decision.ts";
import {
  exactReviewScheduledLane,
  numberFrom,
  objectValue,
  type ExactReviewScheduledLane,
} from "./exact-review-queue-shared.ts";

export type {
  ExactReviewBaseDecision,
  ExactReviewDecision,
  ExactReviewIngress,
  ExactReviewPublication,
} from "./exact-review-decision.ts";
export {
  HOSTED_TARGET_ELIGIBILITY_HEADER,
  hostedTargetRetryableAdmission,
  normalizeHostedTargetAdmission,
  probeHostedPublicTarget,
  resolveHostedTargetEligibility,
  type HostedPublicTargetProbe,
  type HostedTargetAdmission,
  type HostedTargetEligibility,
} from "../src/hosted-target-admission.ts";

import {
  DEFAULT_EXACT_REVIEW_DISPATCH_LEASE_MS,
  DEFAULT_EXACT_REVIEW_EXECUTION_LEASE_MS,
  DEFAULT_EXACT_REVIEW_HEARTBEAT_GRACE_MS,
  DEFAULT_EXACT_REVIEW_PUBLICATION_DISPATCH_LEASE_MS,
  DEFAULT_EXACT_REVIEW_RETRY_MS,
  exactReviewDispatchFailureDetailJson,
  exactReviewEffectiveLeaseExpiresAt,
  exactReviewGithubCredentialCircuits,
  exactReviewGithubTargetAppCircuitRetryAt,
  exactReviewParkedOperatorEligible,
  exactReviewParkedRecoveryAt,
  exactReviewParkedRecoveryAttempts,
  exactReviewParkedRecoveryDelayMs,
  exactReviewParkedTerminalCheckAt,
  exactReviewParkedTerminalGlobalCheckAt,
  exactReviewPrioritizePublicationItems,
  exactReviewQueueActivePublicationCount,
  exactReviewQueueActiveReviewCount,
  exactReviewQueueAdmittedItems,
  exactReviewQueueBackoffReason,
  exactReviewQueueBayActiveKeys,
  exactReviewQueueBayProjectionFromStats,
  exactReviewQueueBayPriorityKeys,
  exactReviewQueueCapacity as exactReviewQueueCapacityFromReadModel,
  exactReviewQueueLane,
  exactReviewQueueNextWakeAt,
  exactReviewQueueStats,
  exactReviewShedSinceReset,
  percentileFor,
  sumFor,
  type ExactReviewBayBatchOwner,
} from "./exact-review-read-model.ts";

export {
  exactReviewEffectiveLeaseExpiresAt,
  exactReviewQueueAdmittedItems,
  exactReviewQueueNextWakeAt,
} from "./exact-review-read-model.ts";

const RECENT_DURABLE_PUBLICATION_EVENTS_CACHE_MS = 60_000;

const GITHUB_TIMEOUT_MS = 4500;
const CLAWSWEEPER_REVIEW_REPO = "openclaw/clawsweeper";

type ExactReviewBackoffReason =
  | "dispatch_debounce"
  | "dispatcher_backoff"
  | "admission_retry"
  | "coordination_retry"
  | "throttle_retry"
  | "review_retry"
  | "publication_retry";
type ExactReviewParkedReason =
  | "dead_letter_capacity"
  | "dispatch_rejected"
  | "review_retry_exhausted"
  | "direct_publication";
type ExactReviewLifecycleProjectionIdentity = {
  canonicalTargetKey: string;
  fenceKey: string;
  revision: number;
};
type ExactReviewTerminalFinalization = {
  disposition: Exclude<LifecycleTerminalDisposition, "requeue">;
  statusState: "Complete" | "Failed";
  statusDetail: string;
  /**
   * A concurrent successor can replace the mutable queue item before this
   * acknowledgement runs. Retain the original immutable lifecycle tuple.
   */
  projection?: ExactReviewLifecycleProjectionIdentity;
};
export type ExactReviewQueueItem = {
  key: string;
  decision: ExactReviewDecision;
  admissionDeliveryId?: string;
  ingressFingerprint?: string;
  leaseDecision?: ExactReviewDecision;
  sourceAuthorityWatermark?: { sequence: number; updatedAt?: string };
  state: "pending" | "dispatching" | "leased" | "parked";
  revision: number;
  createdAt: number;
  updatedAt: number;
  nextAttemptAt: number;
  backoffReason?: ExactReviewBackoffReason;
  attempts: number;
  leaseId?: string;
  leaseRevision?: number;
  leaseExpiresAt?: number;
  leaseHeartbeatAt?: number;
  leasePhase?: "review" | "finalizing";
  claimedRunId?: string;
  claimedRunAttempt?: number;
  claimGeneration?: number;
  claimProtocolVersion?: 1 | 2;
  dispatchedAt?: number;
  claimedAt?: number;
  parkedReason?: ExactReviewParkedReason;
  parkedRecoveryAttempts?: number;
  parkedRecoveryAt?: number;
  parkedTerminalCheckedAt?: number;
  dispatchFailureStatus?: number;
  dispatchFailureClass?: ExactReviewDispatchFailureClass;
  dispatchFailureAt?: number;
  dispatchFailureFingerprint?: string;
  dispatchFailureDetail?: ExactReviewDispatchFailureDetail;
  lastFailureReason?: ExactReviewPublicationReasonCode;
  firstFailureAt?: number;
  publicationFailureAttempts?: number;
  reviewFailureAttempts?: number;
  reviewRetryPolicyEpoch?: string;
  reviewRecoveryReason?: ExactReviewReviewRecoveryReason;
  reviewRecoveryAt?: number;
  /**
   * A terminal outcome already committed for this revision. This retains only
   * the status acknowledgement retry driver; it never re-enters publication.
   */
  terminalFinalization?: ExactReviewTerminalFinalization;
};
export type ExactReviewCompletionOutcome = "success" | "failure" | "cancelled";
export type ExactReviewReviewRecoveryReason =
  | "claim_timeout"
  | "execution_timeout"
  | "workflow_cancelled"
  | "workflow_failed";
type ExactReviewRetryKind = "coordination" | "throttle";
type ExactReviewFailureReason = "findings" | "incomplete_source" | "source_incompatible";
type ExactReviewPublicationFailureKind = "github_rate_limit" | "github_transient";
type ExactReviewDispatchFailureClass =
  | "permanent_rejection"
  | "validation_unknown"
  | "authentication"
  | "rate_limit"
  | "github_outage"
  | "timeout"
  | "network";
const ORDINARY_LOG_COUNT_MAX = 100_000;

function ordinaryLogCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, ORDINARY_LOG_COUNT_MAX)
    : 0;
}

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
  attempted?: boolean;
  poolClass?: "repository_actions" | "target_app";
};
type ExactReviewPublicationBatchCompletion = PublicationBatchCompletion & {
  publicationCompletion?: ExactReviewPublicationCompletion;
  requestedRetryAt?: number;
};
type ExactReviewGithubCredentialScope = "repository_actions" | "target_app";
type HostedTargetMetadataToken = () => Promise<string>;
type ExactReviewGithubRateLimitProvenance =
  | "retry_after"
  | "rate_limit_reset"
  | "rate_limit_status"
  | "fallback";
type ExactReviewGithubRateLimitObservation = {
  scope: ExactReviewGithubCredentialScope;
  targetOwner?: string;
  observedAt: number;
  retryAt: number;
  provenance: ExactReviewGithubRateLimitProvenance;
  authoritative: boolean;
};
export type ExactReviewGithubCredentialCircuit = ExactReviewGithubRateLimitObservation & {
  poolKey: string;
};
type ExactReviewGithubRequestMetric = {
  scope: ExactReviewGithubCredentialScope;
  category:
    | "artifact_download"
    | "rate_status"
    | "comments"
    | "labels"
    | "reviews"
    | "workflow_dispatch"
    | "item_metadata"
    | "other";
  mode: "read" | "mutation_or_private_read";
  outcome: "success" | "throttle" | "transient" | "error" | "skipped_by_circuit";
  repeatRevision: boolean;
  count: number;
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
  githubFeedbackReceipts: Record<string, number>;
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
    reason?:
      | "workflow_not_active"
      | "workflow_status_unavailable"
      | "dispatch_authentication"
      | "dispatch_rate_limit"
      | "dispatch_github_outage"
      | "dispatch_timeout"
      | "dispatch_validation"
      | "dispatch_network";
    workflowState?: string;
    checkedAt: number;
    retryAt?: number;
    dispatchFailureStatus?: number;
    dispatchFailureClass?: ExactReviewDispatchFailureClass;
    dispatchFailureAt?: number;
    dispatchFailureFingerprint?: string;
    dispatchFailureDetail?: ExactReviewDispatchFailureDetail;
    dispatchConsecutiveFailures?: number;
    publicationBatchDispatchId?: string;
    reviewAdmissionNextAt?: number;
    publicationBatchDispatchedAt?: number;
    publicationBatchDispatchSucceeded?: boolean;
    publicationBatchDispatchPendingUntil?: number;
    // A batch workflow may only claim the exact selection that the dispatcher
    // terminal-probed immediately before its dispatch. The marker is cleared
    // when that departure is consumed, fails, or expires.
    publicationBatchTerminalProbe?: string;
    githubCredentialCircuits?: Record<string, ExactReviewGithubCredentialCircuit>;
    githubRequestMetrics?: {
      updatedAt: number;
      counters: Record<string, number>;
    };
    parkedTerminalCheckedAt?: number;
  };
};
type LegacyExactReviewQueueState = ExactReviewQueueState & {
  deliveries?: Record<string, number>;
};
type ExactReviewQueueBaseline = {
  items: Map<string, string>;
  dispatcherJson: string | null;
  unreadItems?: Map<string, () => ExactReviewQueueItem>;
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
  review: {
    enqueued: number;
    completed: number;
    superseded: number;
    semanticDeduped: number;
    shed: number;
    shedBackpressure: number;
    shedScheduledRate: number;
  };
  publication: {
    enqueued: number;
    completed: number;
    published: number;
    superseded: number;
    semanticDeduped: number;
    retried: number;
    deadLettered: number;
    refreshed: number;
  };
};
type ExactReviewQueueMetricDelta = {
  reviewEnqueued?: number;
  reviewCompleted?: number;
  reviewSuperseded?: number;
  reviewSemanticDeduped?: number;
  reviewRetried?: number;
  reviewShed?: number;
  reviewShedBackpressure?: number;
  reviewShedScheduledRate?: number;
  publicationEnqueued?: number;
  publicationCompleted?: number;
  publicationPublished?: number;
  publicationSuperseded?: number;
  publicationSemanticDeduped?: number;
  publicationRetried?: number;
  publicationDeadLettered?: number;
  publicationRefreshed?: number;
  publicationTransitions?: ExactReviewPublicationTransitionFact[];
};
type ExactReviewPublicationTransitionFact = {
  transition:
    | "published"
    | "superseded"
    | "deferred"
    | "semantic_deduped"
    | "backoff"
    | "retried"
    | "refreshed"
    | "dead_lettered";
  stage:
    | "publication_prepare"
    | "publication_apply"
    | "publication_router"
    | "state_commit"
    | "workflow"
    | "unknown";
  completionKind: ExactReviewPublicationCompletionKind | "none";
  reasonCode: ExactReviewPublicationReasonCode | "semantic_duplicate" | "unattributed";
  revisionRelation:
    | "same_revision"
    | "newer_local_revision"
    | "newer_remote_revision"
    | "semantic_duplicate"
    | "unknown";
  poolClass: "repository_actions" | "target_app" | "not_applicable" | "unknown";
  recoveryCause:
    | "none"
    | "credential_circuit"
    | "retry_budget_exhausted"
    | "transient_retry"
    | "state_retry"
    | "lease_retry"
    | "workflow_retry"
    | "artifact_refresh"
    | "coverage_retry"
    | "validation_failure"
    | "newer_revision"
    | "remote_revision"
    | "semantic_deduplication"
    | "unattributed";
  backoffReason: ExactReviewBackoffReason | "none" | "unknown";
  attemptBucket: "0" | "1" | "2" | "3_5" | "6_13" | "14_plus" | "unknown";
  count: number;
};
type ExactReviewSupersessionAudit = {
  auditId: string;
  itemKey: string;
  priorRevision: number;
  nextRevision: number;
  supersededLeaseId: string | null;
  supersededRunId: string | null;
  supersededRunAttempt: number | null;
  supersededClaimGeneration: number | null;
  supersededProtocolVersion: 1 | 2 | null;
  sourceAction: string;
  reasonCode: "newer_source_event" | "live_head_advanced";
  supersededAt: number;
};
export type DurableObjectStub = { fetch: (request: Request) => Promise<Response> };
export type DurableObjectNamespace = {
  idFromName: (name: string) => unknown;
  get: (id: unknown) => DurableObjectStub;
};

const DEFAULT_EXACT_REVIEW_TARGET_MAX_CONCURRENT = 120;
const DEFAULT_EXACT_REVIEW_ACTIONS_BUDGET = 194;
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
// Exact publications have a dedicated bounded lane. Bound the unclaimed handoff so a run that
// never reaches its claim step is re-dispatched; stale runs lose the lease tuple safely.
const DEFAULT_EXACT_REVIEW_WORKFLOW_PAUSED_RETRY_MS = 60_000;
const DEFAULT_EXACT_REVIEW_DISPATCH_DEBOUNCE_MS = 90_000;
const DEFAULT_EXACT_REVIEW_DISPATCH_DEBOUNCE_MAX_MS = 3 * 60_000;
const DEFAULT_EXACT_REVIEW_PENDING_SOFT_LIMIT = 300;
const DEFAULT_EXACT_REVIEW_TARGET_RATE_PER_HOUR = 200;
const DEFAULT_EXACT_REVIEW_TARGET_BURST = 50;
const EXACT_REVIEW_GITHUB_THROTTLE_ADMISSION_COOLDOWN_MS = 15 * 60 * 1000;
const EXACT_REVIEW_SCHEDULED_FEED_KEY_PREFIX = "exact-review-scheduled-feed:v1";
type ExactReviewScheduledBucket = ExactReviewScheduledLane | "global";
type ExactReviewScheduledDisposition =
  | {
      ok: true;
      queued: true;
      item_key: string;
      superseded_publications: number;
    }
  | {
      ok: true;
      deduped: true;
      item_key: string;
      dedupe_scope: "scheduled_queue_item";
      dedupe_reason: "item_already_pending_or_active";
    }
  | {
      ok: true;
      shed: true;
      reason: "backpressure" | "scheduled_rate";
    };
const EXACT_REVIEW_COMPLETION_RETRY_MAX_MS = 2 * 60 * 60 * 1000;
const EXACT_REVIEW_ARTIFACT_RETRY_MAX_MS = 80 * 24 * 60 * 60 * 1000;
const EXACT_REVIEW_PUBLICATION_ARTIFACT_RETRY_LIMIT = 3;
const EXACT_REVIEW_RETRY_LIMIT = 8;
const DEFAULT_EXACT_REVIEW_RETRY_POLICY_EPOCH = "1";
const EXACT_REVIEW_RECONCILE_RUN_LIMIT = 128;
const EXACT_REVIEW_RECONCILE_CLAIM_MATCH_LIMIT = EXACT_REVIEW_RECONCILE_RUN_LIMIT * 2;
export const EXACT_REVIEW_RECONCILE_CONCURRENCY = 8;
const EXACT_REVIEW_ADMISSION_LIVE_CHECK_CONCURRENCY = 4;
const EXACT_REVIEW_ADMISSION_LIVE_CHECK_MAX_ITEMS = 4;
const EXACT_REVIEW_ADMISSION_INTERVAL_MS = 5_000;
const EXACT_REVIEW_COMMAND_TARGET_ADMISSION_ATTEMPT_LIMIT = 16;
const EXACT_REVIEW_RECONCILE_LIST_PAGE_LIMIT = 3;
const EXACT_REVIEW_PUBLICATION_ENQUEUE_SUPERSEDE_LIMIT = 100;
const EXACT_REVIEW_PUBLICATION_RECONCILE_LIMIT = 100;
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
const EXACT_REVIEW_SOURCE_AUTHORITY_SEQUENCE_KEY = "exact-review-source-authority-sequence:v1";
// Preserve the original key prefix so existing fanout cursors survive the
// broader operational-cursor contract introduced for bounded recovery lanes.
const OPERATIONAL_CURSOR_KEY_PREFIX = "target-fanout-cursor:v1:";
type OperationalCursorMode =
  | "hot-intake"
  | "normal-review"
  | "audit"
  | `review-placeholder-${string}-${"open" | "closed"}`;
type OperationalCursor = {
  mode: OperationalCursorMode;
  nextCursor: number;
  revision: number;
  updatedAt: number;
  auditBatch?: AuditWaveState | null;
};
const EXACT_REVIEW_SOURCE_AUTHORITY_RETRY_BASE_MS = 15_000;
const EXACT_REVIEW_SOURCE_AUTHORITY_RETRY_MAX_MS = 15 * 60_000;
const EXACT_REVIEW_QUEUE_META_TABLE = "exact_review_queue_meta";
const EXACT_REVIEW_QUEUE_ITEM_TABLE = "exact_review_queue_items";
const EXACT_REVIEW_QUEUE_DELIVERY_TABLE = "exact_review_queue_deliveries";
export const EXACT_REVIEW_AUTHENTICATED_BODY_FINGERPRINT_HEADER =
  "x-clawsweeper-exact-review-body-sha256";
const EXACT_REVIEW_QUEUE_INGRESS_TABLE = "exact_review_queue_ingress";
const EXACT_REVIEW_QUEUE_EDIT_SEMANTIC_TABLE = "exact_review_queue_edit_semantic";
const EXACT_REVIEW_QUEUE_METRICS_TABLE = "exact_review_queue_metrics";
const EXACT_REVIEW_QUEUE_METRIC_BUCKET_TABLE = "exact_review_queue_metric_buckets";
const EXACT_REVIEW_PUBLICATION_CAUSE_BUCKET_TABLE = "exact_review_publication_cause_buckets_v1";
const EXACT_REVIEW_QUEUE_SUPERSESSION_TABLE = "exact_review_queue_supersessions";
const EXACT_REVIEW_QUEUE_DEAD_LETTER_TABLE = "exact_review_queue_dead_letters";
const EXACT_REVIEW_QUEUE_PARKED_ACTION_TABLE = "exact_review_queue_parked_actions";
const EXACT_REVIEW_PUBLICATION_HEAD_TABLE = "exact_review_publication_heads";
const EXACT_REVIEW_RUN_TELEMETRY_TABLE = "exact_review_run_telemetry";
const EXACT_REVIEW_GITHUB_TELEMETRY_RECEIPT_TABLE = "exact_review_github_telemetry_receipts";
const REVIEW_RUN_TELEMETRY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const EXACT_REVIEW_GITHUB_TELEMETRY_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const EXACT_REVIEW_STATE_WRITER_OPERATION_TABLE = "exact_review_state_writer_operations";
const EXACT_REVIEW_STATE_WRITER_LIVE_TABLE = "exact_review_state_writer_live";
const EXACT_REVIEW_STATE_WRITER_DIAGNOSTICS_TABLE = "exact_review_state_writer_diagnostics";
const EXACT_REVIEW_STATE_WRITER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const EXACT_REVIEW_STATE_WRITER_LIVE_MS = 90 * 1000;
const REVIEW_OBSERVABILITY_SCAN_LIMIT = 10_000;
const EXACT_REVIEW_QUEUE_DEAD_LETTER_LIMIT = 5_000;
const EXACT_REVIEW_QUEUE_DEAD_LETTER_RESOLVED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const EXACT_REVIEW_QUEUE_PARKED_ACTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const EXACT_REVIEW_PARKED_LIST_MAX_LIMIT = 50;
const EXACT_REVIEW_PARKED_RESOLVE_MAX_ITEMS = 20;
const EXACT_REVIEW_PARKED_RECOVER_MAX_ITEMS = 5;
const EXACT_REVIEW_QUEUE_METRIC_BUCKET_MS = 5 * 60 * 1000;
const EXACT_REVIEW_QUEUE_METRIC_BUCKET_TTL_MS = 48 * 60 * 60 * 1000;
const EXACT_REVIEW_PUBLICATION_CAUSE_PUBLIC_LIMIT = 256;
const EXACT_REVIEW_QUEUE_SUPERSESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const EXACT_REVIEW_PUBLICATION_CONTROL_KEY = "exact-review-publication-control:v1";
export const EXACT_REVIEW_QUEUE_NAME = "global";
const DEFAULT_EXACT_REVIEW_PUBLICATION_BATCH_SIZE = 8;
const MAX_EXACT_REVIEW_PUBLICATION_BATCH_SIZE = 32;
const MAX_EXACT_REVIEW_PUBLICATION_BATCH_SCAN_SIZE = 50;
const DEFAULT_EXACT_REVIEW_PUBLICATION_BATCH_LEASE_MS = 30 * 60 * 1000;
const DEFAULT_EXACT_REVIEW_PUBLICATION_BATCH_WAIT_MS = 60_000;
const DEFAULT_EXACT_REVIEW_PUBLICATION_BATCH_DISPATCH_COOLDOWN_MS = 30_000;
const DEFAULT_EXACT_REVIEW_PUBLICATION_BATCH_DISPATCH_RESERVATION_MS = 10 * 60_000;
const DEFAULT_EXACT_REVIEW_PUBLICATION_FRESH_LANE_MAX_ITEMS = 2;
const DEFAULT_EXACT_REVIEW_PUBLICATION_FRESH_LANE_MAX_AGE_MS = 15 * 60_000;
const DEFAULT_STATE_WRITER_COORDINATOR_LEASE_MS = 2 * 60_000;
const DEFAULT_STATE_WRITER_COORDINATOR_QUEUED_STALE_MS = 2 * 60_000;
const EXACT_REVIEW_ALARM_SAMPLE_WINDOW_MS = 60_000;
const EXACT_REVIEW_ALARM_SAMPLE_THRESHOLD = 10;
type AlarmWakeReason =
  | `batch_${"lease" | "departure"}`
  | `${"queue" | "source_authority" | "command_intake" | "credential_circuit" | "bay_recovery"}`;
type AlarmScheduleDecision = readonly [AlarmWakeReason, number, number, boolean | null, boolean];
// A watchdog may keep a synchronous Git operation alive, but it cannot turn a
// hung runner into a permanent queue owner. The Git fence blocks any in-flight
// push that outlives this absolute coordinator horizon.
const DEFAULT_STATE_WRITER_COORDINATOR_MAX_LEASE_AGE_MS = 30 * 60_000;
const RECORD_EXPORT_DEFAULT_LIMIT = 200;
const RECORD_EXPORT_MAX_LIMIT = 200;
const RECORD_EXPORT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const RECORD_EXPORT_MAX_SOURCE_BYTES = EXACT_REVIEW_DIRECT_PUBLICATION_MAX_FILE_BYTES;
const RECORD_EXPORT_MAX_RECONSTRUCTION_RECORDS = 200;
const RECORD_INGEST_MAX_RECORDS = 100;
const RECORD_INGEST_MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const RECORD_INGEST_MAX_FILE_BYTES = 2 * 1024 * 1024;
const RECORD_EXPORT_SECTIONS: readonly RecordSection[] = [
  "items",
  "closed",
  "plans",
  "decision-packets",
  "commits",
];

export function exactReviewQueueCapacity(env) {
  return exactReviewQueueCapacityFromReadModel(env, DEFAULT_EXACT_REVIEW_ACTIONS_BUDGET);
}

function exactReviewPublicBayRepositories(env): Set<string> {
  const repositories = String(env?.PUBLIC_BAY_REPOS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (
    repositories.length > 32 ||
    repositories.some((repository) => !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository))
  ) {
    return new Set();
  }
  return new Set(repositories);
}

function rethrowQueueFailure(
  error: unknown,
  phase: "initialize" | "fetch",
  request?: Request,
): never {
  const stack = objectValue(error).stack;
  // Remote error text may contain private data; retain only deployed source coordinates.
  const frame =
    typeof stack === "string"
      ? /^[ \t]+at (?:[^\r\n]*[/ (])?worker\.js:([1-9]\d{0,5}):([1-9]\d{0,5})\)?[ \t]*\r?$/m.exec(
          stack,
        )
      : null;
  const traceId = request
    ? exactReviewQueueTraceId(request.headers.get(EXACT_REVIEW_QUEUE_TRACE_HEADER))
    : null;
  const endpoint = request
    ? exactReviewQueueEndpointTemplate(new URL(request.url).pathname)
    : "initialization";
  console.error("exact_review_queue_handler_failed", {
    phase,
    trace_id: traceId,
    endpoint,
    failure_category:
      error instanceof RecordExportConsistencyError
        ? "record_export_consistency"
        : "handler_exception",
    location: frame ? [Number(frame[1]), Number(frame[2])] : null,
  });
  throw error;
}

export class ExactReviewQueue {
  private state;
  private storage;
  private env;
  private ready: Promise<void> | null = null;
  private lifecycleProjectionReady: Promise<void>;
  private migratedAt = 0;
  private legacyMirrorDisabled = false;
  private legacyMirrorWarningReported = false;
  private batchStore;
  private directPublicationStore;
  private recordSnapshotStore;
  private stateWriterCoordinator;
  private lifecycleProjectionStore;
  private lifecycleTelemetryStore;
  private reviewFailureTelemetryStore;
  private reviewFailureTelemetryDropAt = 0;
  private githubEgressTelemetryStore;
  private commandIntakeStore;
  private artifactReceiptStore;
  private githubEtagResponseStore;
  private githubWebhookReadModelStore;
  private readonly random: () => number;
  private readonly baselines = new WeakMap<ExactReviewQueueState, ExactReviewQueueBaseline>();
  private statsCache: {
    key: string;
    expiresAt: number;
    body: string;
    changes: number;
  } | null = null;
  private statsMutationGeneration = 0;
  private statsComputation: {
    key: string;
    body: Promise<string>;
    changes: number;
    generation: number;
  } | null = null;

  private lifecycleBayCache: { key: string; expiresAt: number; body: string } | null = null;
  private readonly lifecycleBayComputations = new Map<string, Promise<string>>();

  private invalidateReadCaches() {
    this.statsMutationGeneration++;
    this.statsCache = null;
    this.statsComputation = null;
  }

  private reviewCoverageCache: { at: number; summary: ReviewCoverageSummary } | null = null;
  // Back off a wedged Bay row without adding durable queue state. Any durable
  // progress clears this single-slot deadline so the one-second drain resumes.
  private bayTelemetryNoProgressDeadline: number | null = null;
  private alarmSampleWindowStartedAt = Number.NEGATIVE_INFINITY;
  private alarmSampleCount = 0;
  private alarmSampleLoggedAt = -1;
  private scheduledAlarmDecision: AlarmScheduleDecision | null = null;
  private recentDurablePublicationEventsCache = new Map<
    string,
    { expiresAt: number; value: NonNullable<ReturnType<typeof recentDurablePublicationEvents>> }
  >();

  constructor(state, env, random: () => number = Math.random) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;
    this.random = random;
    this.batchStore = new ExactReviewPublicationBatchStore(this.storage);
    this.directPublicationStore = new ExactReviewDirectPublicationStore(this.storage);
    this.recordSnapshotStore = new ExactReviewRecordSnapshotStore(
      this.storage,
      this.directPublicationStore,
      env.STATE_SNAPSHOTS,
    );
    this.stateWriterCoordinator = new StateWriterCoordinator(this.storage);
    this.lifecycleProjectionStore = new ExactReviewLifecycleProjectionStore(this.storage);
    this.lifecycleTelemetryStore = new ExactReviewLifecycleTelemetryStore(this.storage);
    this.reviewFailureTelemetryStore = new ExactReviewFailureTelemetryStore(this.storage);
    this.githubEgressTelemetryStore = new GithubEgressTelemetryStore(this.storage);
    this.commandIntakeStore = new ExactReviewCommandIntakeStore(this.storage);
    this.artifactReceiptStore = new ExactReviewArtifactReceiptStore(
      this.storage,
      env.STATE_SNAPSHOTS,
    );
    this.githubEtagResponseStore = new GithubEtagResponseStore(this.storage);
    this.githubWebhookReadModelStore = new GithubWebhookReadModelStore(this.storage);
    // The public lifecycle reader remains side-effect free. Its bounded read
    // schema and public Bay repository coverage scope are established
    // in this constructor barrier; full queue initialization and migration
    // stay deferred until an ordinary request.
    if (typeof state.blockConcurrencyWhile === "function") {
      this.lifecycleProjectionReady = Promise.resolve(
        state.blockConcurrencyWhile(async () => {
          try {
            this.lifecycleProjectionStore.ensureSchemaSync();
            this.lifecycleTelemetryStore.ensureSchemaSync();
            this.lifecycleTelemetryStore.syncBayRepositoryScope(
              exactReviewPublicBayRepositories(this.env),
            );
          } catch (error) {
            rethrowQueueFailure(error, "initialize");
          }
        }),
      );
    } else {
      this.ready = this.initializeStorage().catch((error) =>
        rethrowQueueFailure(error, "initialize"),
      );
      this.lifecycleProjectionReady = this.ready;
    }
  }

  async fetch(
    request: Request,
    hostedTargetMetadataToken = exactReviewHostedTargetMetadataTokenSource(this.env),
  ) {
    const mutating = request.method !== "GET";
    if (mutating) this.invalidateReadCaches();
    try {
      return await this.handleFetch(request, hostedTargetMetadataToken);
    } catch (error) {
      rethrowQueueFailure(error, "fetch", request);
    } finally {
      // Mutators can yield to a dashboard poll while awaiting external work.
      if (mutating) this.invalidateReadCaches();
    }
  }

  private async handleFetch(
    request: Request,
    hostedTargetMetadataToken: HostedTargetMetadataToken,
  ) {
    const url = new URL(request.url);
    // This is deliberately the only route that may observe lifecycle rows
    // before full queue initialization. Its constructor-managed schema barrier
    // is already complete; the handler itself performs no schema creation,
    // cleanup, queue reclamation, alarm scheduling, or GitHub work.
    if (request.method === "GET" && url.pathname === "/lifecycle-bay") {
      await this.lifecycleProjectionReady.catch(() => undefined);
      return this.lifecycleBayResponse(url);
    }
    if (request.method === "GET" && url.pathname === "/bay-lifecycle-metrics") {
      await this.lifecycleProjectionReady.catch(() => undefined);
      const publicRepositories = url.searchParams
        .getAll("public_repo")
        .map((value) => value.trim().toLowerCase());
      const validPublicRepositories =
        publicRepositories.length <= 32 &&
        publicRepositories.every((value) => /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(value));
      const recoveryPending = this.bayTelemetryRecoveryPendingSync();
      return json({
        bay_lifecycle_metrics: recoveryPending
          ? unknownBaySnapshot("unavailable")
          : !url.searchParams.has("public_repo")
            ? this.lifecycleTelemetryStore.baySnapshot()
            : validPublicRepositories
              ? this.lifecycleTelemetryStore.baySnapshot(Date.now(), new Set(publicRepositories))
              : this.lifecycleTelemetryStore.baySnapshot(Date.now(), new Set()),
      });
    }
    if (request.method === "POST" && url.pathname === "/lifecycle-audit/inventory") {
      return this.readLifecycleAuditInventory(await request.json().catch(() => null));
    }
    if (request.method === "POST" && url.pathname === "/telemetry-reconciliation") {
      await this.lifecycleProjectionReady.catch(() => undefined);
      const publicRepositories = url.searchParams
        .getAll("public_repo")
        .map((value) => value.trim().toLowerCase());
      const validPublicRepositories =
        publicRepositories.length <= 32 &&
        publicRepositories.every((value) => /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(value));
      const publicRepositoryScope = validPublicRepositories ? new Set(publicRepositories) : null;
      const recoveryPending = this.bayTelemetryRecoveryPendingSync();
      return json({
        exact_review_telemetry_reconciliation:
          publicRepositoryScope && !recoveryPending
            ? this.lifecycleTelemetryStore.reconcileBaySnapshot(Date.now(), publicRepositoryScope)
            : {
                version: 1,
                source: "canonical-lifecycle-projection-v1",
                generated_at: new Date().toISOString(),
                scope: { repository_count: publicRepositoryScope?.size ?? 0 },
                collection: { state: "unknown", reason: "unavailable" },
                window: null,
                comparison: null,
              },
      });
    }
    await this.ensureReady();
    this.cleanupLegacyCompatibilitySync();
    if (request.method === "POST" && url.pathname === "/github-egress-telemetry") {
      const now = Date.now();
      const result = this.githubEgressTelemetryStore.ingest(
        await request.json().catch(() => null),
        now,
      );
      if (!result.ok) return json({ error: result.error }, 400);
      let telemetryApplied = false;
      if (result.credentialCircuits.length) {
        telemetryApplied = this.applyGithubTelemetrySync(
          this.readStateSync(),
          `egress-v2:${result.receiptId}`,
          result.credentialCircuits,
          [],
          now,
        );
      }
      if (telemetryApplied) await this.scheduleNext(this.readStateSync(), now);
      return json({ ok: true, accepted: result.accepted, deduped: result.deduped }, 202);
    }
    if (request.method === "GET" && url.pathname === "/github-egress-observability") {
      const result = this.githubEgressTelemetryStore.publicObservability(
        Number(url.searchParams.get("hours") || "6"),
      );
      return result ? json(result) : json({ error: "invalid_github_egress_window" }, 400);
    }
    if (request.method === "POST" && url.pathname === "/review-coverage/inventory") {
      const inventory = normalizeReviewCoverageInventory(await request.json().catch(() => null));
      if (!inventory) return json({ error: "invalid_review_coverage_inventory" }, 400);
      const stored = normalizeReviewCoverageInventory(
        this.storage.kv.get(REVIEW_COVERAGE_INVENTORY_KEY),
      );
      if (stored && Date.parse(stored.generated_at) > Date.parse(inventory.generated_at)) {
        return json({ ok: true, accepted: false, stale: true }, 202);
      }
      this.storage.kv.put(REVIEW_COVERAGE_INVENTORY_KEY, inventory);
      this.reviewCoverageCache = null;
      return json({ ok: true, accepted: true }, 202);
    }
    const operationalCursorMode = operationalCursorModeFromPath(url.pathname);
    if (operationalCursorMode && request.method === "GET") {
      return this.readOperationalCursor(operationalCursorMode);
    }
    if (operationalCursorMode && request.method === "PUT") {
      return this.writeOperationalCursor(
        operationalCursorMode,
        await request.json().catch(() => null),
      );
    }
    if (request.method === "GET" && url.pathname === "/recent-durable-publication-events") {
      const events = this.recentDurablePublicationEvents(
        String(url.searchParams.get("window") || "24h"),
      );
      return events
        ? json({ recent_durable_publication_events: events })
        : json({ error: "invalid_window" }, 400);
    }
    if (request.method === "POST" && url.pathname === "/command-intake") {
      const value = await request.json().catch(() => null);
      const targetRepo = String(objectValue(objectValue(value).decision).targetRepo || "");
      if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(targetRepo)) {
        const admission = await this.hostedTargetAdmission(
          targetRepo,
          hostedTargetMetadataToken,
          this.hasPreparedHostedTargetEligibility(request, targetRepo),
          true,
        );
        if (admission.outcome !== "public") {
          return hostedTargetProbeResponse(admission);
        }
      }
      const now = Date.now();
      const admitted = this.commandIntakeStore.admit(value, now);
      if (!admitted) return json({ error: "invalid_command_intake" }, 400);
      if (admitted.accepted) await this.scheduleSourceAuthorityVerification(now, "command_intake");
      return json(
        {
          ok: true,
          accepted: admitted.accepted,
          ...(admitted.accepted ? { deduped: admitted.deduped } : { reason: admitted.reason }),
          command_version_id: admitted.commandVersionId,
          ...(admitted.accepted && admitted.bayJourneyDeliveryId
            ? { bay_journey_delivery_id: admitted.bayJourneyDeliveryId }
            : {}),
        },
        202,
      );
    }
    if (request.method === "POST" && url.pathname === "/branch-authority") {
      const body = objectValue(await request.json().catch(() => null));
      const deliveryId = String(body.delivery_id || "").trim();
      const decision = exactReviewBranchAuthorityDecisionFrom(body.decision);
      const ingress = body.ingress === undefined ? undefined : exactReviewIngressFrom(body.ingress);
      const installationId =
        body.installation_id === undefined ? undefined : Number(body.installation_id);
      const sourceAuthorityRequired = body.source_authority_required === true;
      if (
        !deliveryId ||
        deliveryId.length > 200 ||
        !decision ||
        (body.ingress !== undefined && !ingress) ||
        (installationId !== undefined &&
          (!Number.isInteger(installationId) || installationId <= 0)) ||
        (sourceAuthorityRequired &&
          (decision.itemKind !== "pull_request" ||
            installationId === undefined ||
            ingress?.route === "target_dispatcher"))
      ) {
        return json({ error: "invalid_branch_authority_reservation" }, 400);
      }
      const admission = await this.hostedTargetAdmission(
        decision.targetRepo,
        hostedTargetMetadataToken,
        this.hasPreparedHostedTargetEligibility(request, decision.targetRepo),
        true,
      );
      if (admission.outcome !== "public") {
        return hostedTargetProbeResponse(admission);
      }
      const reservationKey = exactReviewBranchAuthorityReservationKey(deliveryId);
      const now = Date.now();
      try {
        const reserved = this.storage.transactionSync(() => {
          const completed = Array.from(
            this.storage.sql.exec(
              `SELECT delivery_id FROM ${EXACT_REVIEW_QUEUE_DELIVERY_TABLE}
                WHERE delivery_id = ?`,
              deliveryId,
            ),
          ).length;
          if (completed) return { deduped: true as const };
          const existing = exactReviewBranchAuthorityReservationFrom(
            this.storage.kv.get(reservationKey),
          );
          if (existing) {
            if (
              stableJson(existing.decision) !== stableJson(decision) ||
              stableJson(existing.ingress || null) !== stableJson(ingress || null) ||
              existing.installationId !== installationId ||
              existing.sourceAuthorityRequired !== sourceAuthorityRequired
            ) {
              throw new Error("conflicting exact-review branch authority reservation");
            }
            return { deduped: false as const, reservation: existing };
          }
          const created: ExactReviewBranchAuthorityReservation = {
            deliveryId,
            decision,
            ...(ingress ? { ingress } : {}),
            ...(installationId === undefined ? {} : { installationId }),
            sourceAuthorityRequired,
            attempts: 0,
            nextAttemptAt: now,
          };
          this.storage.kv.put(reservationKey, created);
          return { deduped: false as const, reservation: created };
        });
        if (reserved.deduped) return json({ ok: true, deduped: true });
        await this.scheduleSourceAuthorityVerification(reserved.reservation.nextAttemptAt);
        return json({ ok: true, branch_authority_pending: true }, 202);
      } catch {
        return json({ error: "branch_authority_unavailable" }, 409);
      }
    }
    if (request.method === "POST" && url.pathname === "/source-authority") {
      const body = objectValue(await request.json().catch(() => null));
      const deliveryId = String(body.delivery_id || "").trim();
      const decision = exactReviewDecisionFrom(body.decision);
      const ingress = body.ingress === undefined ? undefined : exactReviewIngressFrom(body.ingress);
      const installationId = Number(body.installation_id);
      if (
        !deliveryId ||
        deliveryId.length > 200 ||
        !decision ||
        decision.itemKind !== "pull_request" ||
        decision.publication ||
        (body.ingress !== undefined && (!ingress || ingress.route !== "direct_webhook")) ||
        !Number.isInteger(installationId) ||
        installationId <= 0
      ) {
        return json({ error: "invalid_source_authority_reservation" }, 400);
      }
      const admission = await this.hostedTargetAdmission(
        decision.targetRepo,
        hostedTargetMetadataToken,
        this.hasPreparedHostedTargetEligibility(request, decision.targetRepo),
        true,
      );
      if (admission.outcome !== "public") {
        return hostedTargetProbeResponse(admission);
      }
      const reservationKey = exactReviewSourceAuthorityReservationKey(deliveryId);
      const now = Date.now();
      try {
        const reserved = this.storage.transactionSync(() => {
          const completed = Array.from(
            this.storage.sql.exec(
              `SELECT delivery_id FROM ${EXACT_REVIEW_QUEUE_DELIVERY_TABLE}
                WHERE delivery_id = ?`,
              deliveryId,
            ),
          ).length;
          if (completed) return { deduped: true as const };
          const existing = exactReviewSourceAuthorityReservationFrom(
            this.storage.kv.get(reservationKey),
          );
          if (existing) {
            if (
              existing.deliveryId !== deliveryId ||
              existing.installationId !== installationId ||
              stableJson(exactReviewDecisionWithoutSourceAuthority(existing.decision)) !==
                stableJson(exactReviewDecisionWithoutSourceAuthority(decision)) ||
              stableJson(existing.ingress || null) !== stableJson(ingress || null)
            ) {
              throw new Error("conflicting exact-review source authority reservation");
            }
            return { deduped: false as const, reservation: existing };
          }
          const stored = this.storage.kv.get(EXACT_REVIEW_SOURCE_AUTHORITY_SEQUENCE_KEY);
          const current = stored === undefined ? 0 : Number(stored);
          if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) {
            throw new Error("invalid exact-review source authority sequence");
          }
          const next = current + 1;
          this.storage.kv.put(EXACT_REVIEW_SOURCE_AUTHORITY_SEQUENCE_KEY, next);
          const created: ExactReviewSourceAuthorityReservation = {
            deliveryId,
            decision: { ...decision, sourceAuthoritySeq: next },
            ...(ingress ? { ingress } : {}),
            installationId,
            sourceAuthoritySeq: next,
            attempts: 0,
            nextAttemptAt: now,
          };
          this.storage.kv.put(reservationKey, created);
          return { deduped: false as const, reservation: created };
        });
        if (reserved.deduped) return json({ ok: true, deduped: true });
        await this.scheduleSourceAuthorityVerification(reserved.reservation.nextAttemptAt);
        return json({
          ok: true,
          source_authority_seq: reserved.reservation.sourceAuthoritySeq,
        });
      } catch {
        return json({ error: "source_authority_unavailable" }, 409);
      }
    }
    if (request.method === "POST" && url.pathname === "/source-authority/complete") {
      const body = objectValue(await request.json().catch(() => null));
      const deliveryId = String(body.delivery_id || "").trim();
      const sourceAuthoritySeq = Number(body.source_authority_seq);
      const disposition = String(body.disposition || "");
      if (
        !deliveryId ||
        !Number.isSafeInteger(sourceAuthoritySeq) ||
        sourceAuthoritySeq <= 0 ||
        (disposition !== "enqueued" && disposition !== "mismatch")
      ) {
        return json({ error: "invalid_source_authority_completion" }, 400);
      }
      const result = this.storage.transactionSync(() => {
        const reservationKey = exactReviewSourceAuthorityReservationKey(deliveryId);
        const reservation = exactReviewSourceAuthorityReservationFrom(
          this.storage.kv.get(reservationKey),
        );
        if (!reservation) return "missing" as const;
        if (reservation.sourceAuthoritySeq !== sourceAuthoritySeq) return "conflict" as const;
        if (disposition === "mismatch") {
          this.storage.sql.exec(
            `INSERT OR IGNORE INTO ${EXACT_REVIEW_QUEUE_DELIVERY_TABLE}
             (delivery_id, received_at) VALUES (?, ?)`,
            deliveryId,
            Date.now(),
          );
        }
        this.storage.kv.delete(reservationKey);
        return "completed" as const;
      });
      if (result === "conflict") return json({ error: "source_authority_conflict" }, 409);
      await this.scheduleNext(this.readStateSync(), Date.now());
      return json({ ok: true, completed: result === "completed" });
    }
    if (request.method === "POST" && url.pathname === "/state-writer/acquire") {
      const input = stateWriterTicketInput(await request.json().catch(() => null));
      if (!input) return json({ error: "invalid_state_writer_ticket" }, 400);
      const ticket = this.stateWriterCoordinator.acquire(
        input,
        Date.now(),
        stateWriterCoordinatorLeaseMs(this.env),
        stateWriterCoordinatorQueuedStaleMs(this.env),
        stateWriterCoordinatorMaxLeaseAgeMs(this.env),
      );
      if (ticket.state === "completed" || ticket.state === "expired") {
        return json({ error: `state_writer_ticket_${ticket.state}`, ticket }, 409);
      }
      return json({ ok: true, ticket });
    }

    if (request.method === "POST" && url.pathname === "/state-writer/heartbeat") {
      const body = objectValue(await request.json().catch(() => null));
      const ticketId = boundedStateWriterIdentity(body.ticket_id);
      const owner = boundedStateWriterIdentity(body.owner);
      const leaseToken = boundedStateWriterIdentity(body.lease_token);
      if (!ticketId || !owner || !leaseToken) {
        return json({ error: "invalid_state_writer_heartbeat" }, 400);
      }
      const ticket = this.stateWriterCoordinator.heartbeat(
        ticketId,
        owner,
        leaseToken,
        Date.now(),
        stateWriterCoordinatorLeaseMs(this.env),
        stateWriterCoordinatorQueuedStaleMs(this.env),
      );
      return ticket
        ? json({ ok: true, ticket })
        : json({ error: "state_writer_ticket_not_active" }, 409);
    }

    if (request.method === "POST" && url.pathname === "/state-writer/release") {
      const body = objectValue(await request.json().catch(() => null));
      const ticketId = boundedStateWriterIdentity(body.ticket_id);
      const owner = boundedStateWriterIdentity(body.owner);
      const leaseToken = boundedStateWriterIdentity(body.lease_token);
      if (!ticketId || !owner || !leaseToken) {
        return json({ error: "invalid_state_writer_release" }, 400);
      }
      const released = this.stateWriterCoordinator.release(
        ticketId,
        owner,
        leaseToken,
        Date.now(),
        stateWriterCoordinatorQueuedStaleMs(this.env),
      );
      return released
        ? json({ ok: true, released: true })
        : json({ error: "state_writer_ticket_not_active" }, 409);
    }

    if (request.method === "POST" && url.pathname === "/enqueue") {
      const body = objectValue(await request.json().catch(() => null));
      const deliveryId = String(body.delivery_id || "").trim();
      const decision = exactReviewDecisionFrom(body.decision);
      const ingress = body.ingress === undefined ? undefined : exactReviewIngressFrom(body.ingress);
      if (!deliveryId) return json({ error: "missing_delivery_id" }, 400);
      if (deliveryId.startsWith(EXACT_REVIEW_QUEUE_LEGACY_GENERATION_PREFIX)) {
        return json({ error: "reserved_delivery_id" }, 400);
      }
      if (!decision) return json({ error: "invalid_exact_review_item" }, 400);
      const scheduledLane = exactReviewScheduledLane(decision);
      const bodyFingerprintHeader = request.headers.get(
        EXACT_REVIEW_AUTHENTICATED_BODY_FINGERPRINT_HEADER,
      );
      if (scheduledLane && bodyFingerprintHeader && !/^[a-f0-9]{64}$/.test(bodyFingerprintHeader)) {
        return json({ error: "invalid_authenticated_body_fingerprint" }, 400);
      }
      const authenticatedBodyFingerprint =
        scheduledLane && bodyFingerprintHeader ? bodyFingerprintHeader : null;
      if (body.ingress !== undefined && !ingress) {
        return json({ error: "invalid_exact_review_ingress" }, 400);
      }
      if (
        ingress &&
        (decision.itemKind !== "pull_request" || decision.sourceEvent !== "pull_request")
      ) {
        return json({ error: "invalid_exact_review_ingress" }, 400);
      }
      if (!isExactReviewQueueTargetEnabled(decision, this.env)) {
        return json({ ok: true, accepted: false, reason: "target not enabled" }, 202);
      }
      const admission = await this.hostedTargetAdmission(
        decision.targetRepo,
        hostedTargetMetadataToken,
        this.hasPreparedHostedTargetEligibility(request, decision.targetRepo),
        true,
      );
      if (admission.outcome !== "public") return hostedTargetProbeResponse(admission);

      const now = Date.now();
      const semanticEdited = await exactReviewEditedSemanticInput(decision);
      const incomingPublicationRevision = exactReviewPublicationRevision(decision);
      const activeBatchItemKeys = incomingPublicationRevision
        ? new Set(this.batchStore.activeLeaseSnapshot(now).itemKeys)
        : new Set<string>();
      // Command revisions write their terminal lifecycle source row while this
      // enqueue transaction is open. Materialize its Bay aggregate only after
      // that transaction commits: Durable Objects reject nested transactions.
      let deferredBayLifecycle: ExactReviewLifecycleProjection | null = null;
      const accepted = this.storage.transactionSync(() => {
        this.pruneDeliveryReceiptsSync(now);
        this.pruneIngressReceiptsSync(now);
        this.pruneEditedSemanticInputsSync(now);
        this.storage.sql.exec(
          `DELETE FROM ${EXACT_REVIEW_QUEUE_DELIVERY_TABLE}
            WHERE delivery_id = ? AND received_at <= ?`,
          deliveryId,
          now - EXACT_REVIEW_QUEUE_DELIVERY_TTL_MS,
        );
        const existingReceipt = Array.from(
          this.storage.sql.exec(
            `SELECT authenticated_body_fingerprint, scheduled_disposition_json
               FROM ${EXACT_REVIEW_QUEUE_DELIVERY_TABLE}
              WHERE delivery_id = ?`,
            deliveryId,
          ),
        )[0] as
          | {
              authenticated_body_fingerprint?: string | null;
              scheduled_disposition_json?: string | null;
            }
          | undefined;
        if (existingReceipt) {
          this.syncLegacyCompatibilitySync(this.readStateSync());
          const storedFingerprint = existingReceipt.authenticated_body_fingerprint;
          const storedDispositionJson = existingReceipt.scheduled_disposition_json;
          if (!storedFingerprint) return { deduped: true as const };
          if (storedFingerprint !== authenticatedBodyFingerprint) {
            return { conflict: true as const };
          }
          if (!storedDispositionJson) return { deduped: true as const };
          const disposition = exactReviewScheduledDispositionFromJson(storedDispositionJson);
          if (!disposition) return { deduped: true as const };
          return {
            replayed: true as const,
            disposition,
            dispositionJson: storedDispositionJson,
          };
        }
        this.storage.sql.exec(
          `INSERT INTO ${EXACT_REVIEW_QUEUE_DELIVERY_TABLE}
             (delivery_id, received_at, authenticated_body_fingerprint)
           VALUES (?, ?, ?)`,
          deliveryId,
          now,
          authenticatedBodyFingerprint,
        );
        const counterpartIngress = ingress
          ? this.recordIngressSync(ingress, decision.targetBranch, now)
          : null;

        if (semanticEdited && this.isDuplicateEditedSemanticInputSync(semanticEdited, now)) {
          const state = this.readStateSync();
          const current =
            state.items[semanticEdited.queueKey] ??
            Object.values(state.items).find(
              (item) =>
                !exactReviewQueueIsPublication(item) &&
                item.key.toLowerCase() === semanticEdited.storageKey,
            );
          if (
            current &&
            !exactReviewQueueIsPublication(current) &&
            exactReviewDecisionCanSupersedeReview(current, decision)
          ) {
            advanceExactReviewSourceAuthorityWatermark(current, decision);
            this.writeStateSync(state);
          } else {
            this.syncLegacyCompatibilitySync(state);
          }
          this.incrementQueueMetricsSync({ reviewSemanticDeduped: 1 });
          return {
            deduped: true as const,
            semanticEdited: true as const,
            key: current?.key || semanticEdited.queueKey,
            state,
          };
        }

        const state = this.readStateSync();
        // A delayed or lost alarm must not let an expired one-shot recovery
        // suppress the next failed shard's recovery delivery.
        reclaimExpiredExactReviewLeases(
          state,
          now,
          exactReviewPublicationDispatchLeaseMs(this.env),
          exactReviewHeartbeatGraceMs(this.env),
          this.env,
        );
        const key = exactReviewItemKey(decision);
        const currentIngressItem = state.items[key];
        // A counterpart receipt is conclusive only after its own route reached
        // queue state. Preserve the one live fallback-first item for a verified
        // direct promotion; otherwise, suppress the old event instead of
        // replacing a newer queue revision.
        if (
          counterpartIngress?.admitted &&
          !(
            currentIngressItem?.ingressFingerprint === ingress?.fingerprint &&
            exactReviewIngressCanPromoteFallback(ingress, decision)
          )
        ) {
          this.writeStateSync(state);
          return { deduped: true as const, crossRoute: true as const, key, state };
        }
        let supersededPublications = 0;
        if (incomingPublicationRevision) {
          const incomingLineage = exactReviewPublicationLineage(decision);
          const matching = Object.values(state.items)
            .filter((item) => !item.terminalFinalization)
            .map((item) => ({
              item,
              revision: exactReviewPublicationRevision(item.decision),
              lineage: exactReviewPublicationLineage(item.decision),
            }))
            .filter(
              (
                entry,
              ): entry is {
                item: ExactReviewQueueItem;
                revision: { targetKey: string; sourceRevision: number };
                lineage: ReturnType<typeof exactReviewPublicationLineage>;
              } => entry.revision?.targetKey === incomingPublicationRevision.targetKey,
            );
          const newestSourceRevision = matching.reduce(
            (latest, entry) => Math.max(latest, entry.revision.sourceRevision),
            Math.max(
              incomingPublicationRevision.sourceRevision,
              this.publicationHeadRevisionSync(incomingPublicationRevision.targetKey),
            ),
          );
          this.recordPublicationHeadSync(
            incomingPublicationRevision.targetKey,
            newestSourceRevision,
            now,
          );
          if (incomingPublicationRevision.sourceRevision < newestSourceRevision) {
            this.writeStateSync(state);
            return {
              deduped: true as const,
              superseded: true as const,
              ...(counterpartIngress ? { crossRoute: true as const } : {}),
              publicationRevision: incomingPublicationRevision.sourceRevision,
              supersededByRevision: newestSourceRevision,
              state,
            };
          }

          if (incomingLineage) {
            const sameLineage = matching.filter(
              (entry) =>
                entry.lineage?.sourceRevision === incomingLineage.sourceRevision &&
                entry.lineage.claimGeneration === incomingLineage.claimGeneration,
            );
            const activeLineage = sameLineage
              .filter(
                ({ item }) =>
                  activeBatchItemKeys.has(item.key) ||
                  item.state === "dispatching" ||
                  item.state === "leased",
              )
              .sort((left, right) => left.item.key.localeCompare(right.item.key));
            const retained =
              activeLineage[0] ||
              sameLineage
                .filter(({ item }) => item.state === "pending" || item.state === "parked")
                .sort(
                  (left, right) =>
                    left.item.createdAt - right.item.createdAt ||
                    left.item.key.localeCompare(right.item.key),
                )[0];
            const retainedPublication = retained?.item.decision.publication;
            const producerChanged =
              retainedPublication?.producerRunId !== decision.publication?.producerRunId ||
              retainedPublication?.producerRunAttempt !== decision.publication?.producerRunAttempt;
            const retainedUsesIncomingKey = retained?.item.key === exactReviewItemKey(decision);
            const newestPendingDecision = activeLineage.length
              ? null
              : sameLineage
                  .filter(({ item }) => item.state === "pending" || item.state === "parked")
                  .map(({ item }) => item.decision)
                  .concat(decision)
                  .reduce<ExactReviewDecision | null>((newest, candidate) => {
                    if (!newest?.publication) return candidate;
                    return exactReviewPublicationProducerIsNewer(
                      candidate.publication!,
                      newest.publication,
                    )
                      ? candidate
                      : newest;
                  }, null);
            const incomingIsOlderThanPendingLineage = Boolean(
              newestPendingDecision?.publication &&
              decision.publication &&
              exactReviewPublicationProducerIsNewer(
                newestPendingDecision.publication,
                decision.publication,
              ),
            );
            const semanticIngress =
              producerChanged || !retainedUsesIncomingKey || incomingIsOlderThanPendingLineage;
            const hasRemovableDuplicate =
              Boolean(retained) &&
              sameLineage.some(
                ({ item }) =>
                  item.key !== retained?.item.key &&
                  !activeBatchItemKeys.has(item.key) &&
                  (item.state === "pending" || item.state === "parked"),
              );
            // Refreshing provenance deliberately preserves the existing queue
            // key, so a redelivery from that refreshed producer must still
            // collapse into it. Same-key redeliveries retain revision handoff.
            if (retained && (semanticIngress || hasRemovableDuplicate)) {
              let semanticDuplicatesRemoved = 0;
              for (const entry of sameLineage) {
                if (
                  entry.item.key === retained.item.key ||
                  activeBatchItemKeys.has(entry.item.key) ||
                  (entry.item.state !== "pending" && entry.item.state !== "parked")
                ) {
                  continue;
                }
                delete state.items[entry.item.key];
                semanticDuplicatesRemoved += 1;
              }
              if (
                !activeLineage.length &&
                retainedPublication &&
                newestPendingDecision?.publication &&
                exactReviewPublicationProducerIsNewer(
                  newestPendingDecision.publication,
                  retainedPublication,
                )
              ) {
                // Keep the queue slot and its retry history, but refresh the
                // producer provenance from the freshest known artifact.
                retained.item.decision = newestPendingDecision;
                retained.item.updatedAt = now;
              }
              if (semanticIngress) {
                this.writeStateSync(state);
                this.incrementQueueMetricsSync({
                  publicationCompleted: semanticDuplicatesRemoved,
                  publicationSuperseded: semanticDuplicatesRemoved,
                  publicationSemanticDeduped: semanticDuplicatesRemoved + 1,
                });
                return {
                  deduped: true as const,
                  semantic: true as const,
                  ...(counterpartIngress ? { crossRoute: true as const } : {}),
                  key: retained.item.key,
                  semanticDuplicatesRemoved,
                  state,
                };
              }
              if (semanticDuplicatesRemoved) {
                this.incrementQueueMetricsSync({
                  publicationCompleted: semanticDuplicatesRemoved,
                  publicationSuperseded: semanticDuplicatesRemoved,
                  publicationSemanticDeduped: semanticDuplicatesRemoved,
                });
              }
            }
          }
          for (const entry of matching
            .filter(
              ({ item, revision }) =>
                revision.sourceRevision < incomingPublicationRevision.sourceRevision &&
                (item.state === "pending" || item.state === "parked") &&
                (!item.terminalFinalization ||
                  exactReviewTerminalFinalizationSharesCommandStatus(item, decision)) &&
                !activeBatchItemKeys.has(item.key),
            )
            .sort((left, right) => left.item.key.localeCompare(right.item.key))
            .slice(0, EXACT_REVIEW_PUBLICATION_ENQUEUE_SUPERSEDE_LIMIT)) {
            delete state.items[entry.item.key];
            supersededPublications += 1;
          }
        }
        const current = state.items[key];
        if (current && scheduledLane) {
          this.writeStateSync(state);
          const disposition: ExactReviewScheduledDisposition = {
            ok: true,
            deduped: true,
            item_key: key,
            dedupe_scope: "scheduled_queue_item",
            dedupe_reason: "item_already_pending_or_active",
          };
          return {
            deduped: true as const,
            scheduled: true as const,
            key,
            state,
            scheduledDispositionJson: this.recordScheduledDispositionSync(
              deliveryId,
              authenticatedBodyFingerprint,
              disposition,
            ),
          };
        }
        let supersededRunId: string | null = null;
        let supersessionAudit: ExactReviewSupersessionAudit | null = null;
        let ingressAdmitted = false;
        if (current) {
          const ignoredRecovery = isLowPriorityExactReviewDecision(decision);
          // A recovery is only a one-shot repair of a failed shard. It may create a queue item,
          // but must never supersede an existing pending, dispatching, or leased decision: doing
          // so can leave either ordinary work or another recovery as a stale follow-up revision.
          // Ordinary source events retain normal replacement behavior, including the
          // command-context merge for pending items.
          if (!ignoredRecovery) {
            if (exactReviewIssueSourceVersionIsOlder(current, decision)) {
              this.writeStateSync(state);
              return {
                deduped: true as const,
                staleSource: true as const,
                ...(counterpartIngress ? { crossRoute: true as const } : {}),
                key,
                state,
              };
            }
            if (
              exactReviewCommandVersionIsOlder(current.leaseDecision || current.decision, decision)
            ) {
              this.storage.sql.exec(
                `DELETE FROM ${EXACT_REVIEW_QUEUE_DELIVERY_TABLE} WHERE delivery_id = ?`,
                deliveryId,
              );
              this.writeStateSync(state);
              return {
                deduped: true as const,
                staleCommand: true as const,
                key,
                state,
              };
            }
            const pendingTerminalFinalizer =
              Boolean(current.terminalFinalization) &&
              (current.state === "pending" || current.state === "parked");
            if (pendingTerminalFinalizer) {
              const identity = exactReviewTerminalFinalizationProjection(current, current.revision);
              const projection = this.lifecycleProjectionStore.read(
                identity.canonicalTargetKey,
                identity.fenceKey,
                identity.revision,
              );
              this.ensureTerminalFinalizationDriver({
                state,
                item: current,
                sourceDecision: current.leaseDecision ?? current.decision,
                projection,
                terminalFinalization: current.terminalFinalization,
                now,
              });
              // A terminal acknowledgement is not review work. Once its
              // immutable driver is retained separately (or the projection
              // says acknowledgement is no longer required), this canonical
              // key may safely accept the successor without inheriting the
              // old publication or command marker.
              current.terminalFinalization = undefined;
            }
            const nextRevision =
              exactReviewDecisionHasCommandContext(current.decision) ||
              exactReviewDecisionHasCommandContext(decision)
                ? this.nextExactReviewCommandRevisionSync(key, current.revision + 1)
                : this.nextExactReviewItemRevisionSync(key, current.revision + 1);
            // Explicit commands arrive through repository_dispatch without a webhook authority
            // tuple. Bind them to the current verified decision via the merge below. An active
            // review keeps its lease and exposes the command as a follow-up revision on completion.
            const bindsCommandToCurrentAuthority =
              decision.itemKind === "pull_request" &&
              (current.leaseDecision || current.decision).itemKind === "pull_request" &&
              Boolean(decision.commandStatusMarker) &&
              !Object.hasOwn(decision, "sourceHeadSha") &&
              !Object.hasOwn(decision, "sourceAuthoritySeq");
            const queuesCommandFollowUp =
              bindsCommandToCurrentAuthority &&
              (current.state === "dispatching" || current.state === "leased");
            const followUpLeaseDecision = queuesCommandFollowUp ? current.leaseDecision : undefined;
            const followUpLeaseRevision = queuesCommandFollowUp ? current.leaseRevision : undefined;
            const attemptsReviewSupersession =
              !exactReviewQueueIsPublication(current) &&
              decision.itemKind === "pull_request" &&
              !bindsCommandToCurrentAuthority;
            const sourceAuthorityIsNewer =
              !attemptsReviewSupersession ||
              exactReviewDecisionCanSupersedeReview(current, decision);
            if (attemptsReviewSupersession && !sourceAuthorityIsNewer) {
              if (decision.sourceCommentId) {
                this.storage.sql.exec(
                  `DELETE FROM ${EXACT_REVIEW_QUEUE_DELIVERY_TABLE} WHERE delivery_id = ?`,
                  deliveryId,
                );
              }
              this.writeStateSync(state);
              return {
                deduped: true as const,
                staleSource: true as const,
                ...(counterpartIngress ? { crossRoute: true as const } : {}),
                key,
                state,
              };
            }
            const supersedesActiveReview =
              !bindsCommandToCurrentAuthority &&
              sourceAuthorityIsNewer &&
              decision.supersedesInProgress &&
              (current.state === "dispatching" || current.state === "leased");
            if (supersedesActiveReview) {
              const priorRevision = current.revision;
              supersededRunId = current.claimedRunId || null;
              supersessionAudit = {
                auditId: crypto.randomUUID(),
                itemKey: key,
                priorRevision,
                nextRevision,
                supersededLeaseId: current.leaseId || null,
                supersededRunId,
                supersededRunAttempt: current.claimedRunAttempt ?? null,
                supersededClaimGeneration: current.claimGeneration ?? null,
                supersededProtocolVersion: current.claimProtocolVersion ?? null,
                sourceAction: decision.sourceAction,
                reasonCode: "newer_source_event",
                supersededAt: now,
              };
              clearExactReviewLease(current);
              current.state = "pending";
              current.createdAt = now;
              current.parkedReason = undefined;
            }
            const mergeable = current.state === "pending" || current.state === "parked";
            const priorParkedRecoveryAt = exactReviewParkedRecoveryAt(current);
            // A command that follows an active direct-publication lease starts a
            // new review revision. Keep that old receipt only in leaseDecision:
            // carrying publication/directLifecycle into the successor would make
            // the successor look like it owns the old fenced finalization.
            const followUpMergeBase =
              (queuesCommandFollowUp || pendingTerminalFinalizer) &&
              exactReviewQueueIsPublication(current)
                ? (current.decision.publication?.producerDecision ?? current.decision)
                : current.decision;
            const nextDecision = supersedesActiveReview
              ? decision
              : mergeable || queuesCommandFollowUp
                ? mergePendingExactReviewDecision(followUpMergeBase, decision)
                : decision;
            const preserveReviewRetryBudget =
              mergeable &&
              !exactReviewQueueIsPublication(current) &&
              !exactReviewDecisionHasCommandContext(decision) &&
              !exactReviewRetryIdentityChanged(current, current.decision, nextDecision, this.env);
            if (
              exactReviewDecisionHasCommandContext(current.decision) ||
              exactReviewDecisionHasCommandContext(nextDecision)
            ) {
              const transition = this.transitionCommandRevision(state, current, nextDecision, now, {
                allocatedRevision: nextRevision,
                admissionDeliveryId: deliveryId,
                retainPriorLifecycle:
                  queuesCommandFollowUp && current.revision === current.leaseRevision,
              });
              deferredBayLifecycle = transition.terminal;
            } else {
              current.decision = nextDecision;
              current.revision = nextRevision;
              current.admissionDeliveryId = deliveryId;
              current.updatedAt = now;
            }
            if (preserveReviewRetryBudget && priorParkedRecoveryAt !== null) {
              // Advancing updatedAt must not invalidate an already-due recovery
              // timestamp and restart the parked ladder's delay.
              current.parkedRecoveryAt = Math.max(priorParkedRecoveryAt, now);
            }
            // Immediacy must come from the merged decision: a pending explicit command
            // keeps its command marker through the merge, and a later plain webhook
            // event must not re-debounce it.
            if (!preserveReviewRetryBudget) {
              Object.assign(
                current,
                mergeable
                  ? exactReviewQueueDebouncedAttempt(
                      state,
                      current.decision,
                      now,
                      current.createdAt,
                      this.env,
                    )
                  : exactReviewQueueEnqueueAttempt(state, now),
              );
            }
            if (mergeable) {
              if (!preserveReviewRetryBudget) {
                current.state = "pending";
                current.parkedReason = undefined;
                current.parkedRecoveryAttempts = 0;
                clearExactReviewDispatchFailure(current);
                current.attempts = 0;
                current.publicationFailureAttempts = 0;
                current.reviewFailureAttempts = 0;
                current.reviewRetryPolicyEpoch = exactReviewRetryPolicyEpoch(this.env);
                current.firstFailureAt = undefined;
                current.lastFailureReason = undefined;
                clearExactReviewReviewRecovery(current);
              }
            }
            advanceExactReviewSourceAuthorityWatermark(current, decision);
            if (followUpLeaseDecision && Number.isSafeInteger(followUpLeaseRevision)) {
              const projection = this.lifecycleProjectionStore.read(
                `${followUpLeaseDecision.targetRepo}#${followUpLeaseDecision.itemNumber}`,
                key,
                followUpLeaseRevision,
              );
              if (projection) {
                this.ensureLifecycleTerminalFinalizationDriver({
                  state,
                  projection,
                  now,
                });
              }
            }
            ingressAdmitted = true;
          }
        } else {
          if (
            !decision.publication &&
            (isLowPriorityExactReviewDecision(decision) || scheduledLane) &&
            exactReviewQueuePendingReviewCount(state) >= exactReviewPendingSoftLimit(this.env)
          ) {
            state.shedSinceReset = exactReviewShedSinceReset(state) + 1;
            this.writeStateSync(state);
            this.incrementQueueMetricsSync({ reviewShed: 1, reviewShedBackpressure: 1 });
            console.warn("exact-review admission shed", {
              event: "admission_shed",
              category: "backpressure",
              pending_count: ordinaryLogCount(exactReviewQueuePendingReviewCount(state)),
              configured_limit: ordinaryLogCount(exactReviewPendingSoftLimit(this.env)),
            });
            const disposition: ExactReviewScheduledDisposition = {
              ok: true,
              shed: true,
              reason: "backpressure",
            };
            return {
              shed: true as const,
              reason: "backpressure" as const,
              scheduledDispositionJson: scheduledLane
                ? this.recordScheduledDispositionSync(
                    deliveryId,
                    authenticatedBodyFingerprint,
                    disposition,
                  )
                : null,
            };
          }
          if (!this.takeScheduledReviewTokenSync(decision, now)) {
            state.shedSinceReset = exactReviewShedSinceReset(state) + 1;
            this.writeStateSync(state);
            this.incrementQueueMetricsSync({ reviewShed: 1, reviewShedScheduledRate: 1 });
            console.warn("exact-review admission shed", {
              event: "admission_shed",
              category: "scheduled_rate",
              lane: exactReviewScheduledLane(decision) || "background",
            });
            const disposition: ExactReviewScheduledDisposition = {
              ok: true,
              shed: true,
              reason: "scheduled_rate",
            };
            return {
              shed: true as const,
              reason: "scheduled_rate" as const,
              scheduledDispositionJson: this.recordScheduledDispositionSync(
                deliveryId,
                authenticatedBodyFingerprint,
                disposition,
              ),
            };
          }
          if (!decision.publication && !scheduledLane) {
            this.consumeScheduledReviewCapacitySync(now);
          }
          state.items[key] = {
            key,
            decision,
            admissionDeliveryId: deliveryId,
            ...(ingress ? { ingressFingerprint: ingress.fingerprint } : {}),
            state: "pending",
            revision: exactReviewDecisionHasCommandContext(decision)
              ? this.nextExactReviewCommandRevisionSync(key, 1)
              : this.nextExactReviewItemRevisionSync(key),
            createdAt: now,
            updatedAt: now,
            ...exactReviewQueueDebouncedAttempt(state, decision, now, now, this.env, true),
            attempts: 0,
            reviewRetryPolicyEpoch: exactReviewRetryPolicyEpoch(this.env),
            ...(exactReviewSourceAuthorityWatermark(decision)
              ? { sourceAuthorityWatermark: exactReviewSourceAuthorityWatermark(decision)! }
              : {}),
          };
          this.recordLifecycleAdmission(state.items[key], decision, now);
          ingressAdmitted = true;
        }
        if (
          ingressAdmitted &&
          decision.itemKind === "pull_request" &&
          decision.sourceEvent === "pull_request"
        ) {
          if (ingress) {
            state.items[key].ingressFingerprint = ingress.fingerprint;
            this.markIngressAdmittedSync(ingress, now);
          } else {
            // A later legacy-only update must not retain the older event's
            // cross-route identity: a delayed verified direct delivery for
            // that older event is not a safe promotion of this revision.
            delete state.items[key].ingressFingerprint;
          }
        }
        if (ingressAdmitted && state.items[key]) {
          this.recordLifecycleAdmission(state.items[key], state.items[key].decision, now);
        }
        if (semanticEdited) this.recordEditedSemanticInputSync(semanticEdited, now);
        this.writeStateSync(state);
        if (supersededPublications) {
          this.incrementQueueMetricsSync({
            publicationCompleted: supersededPublications,
            publicationSuperseded: supersededPublications,
          });
        }
        if (supersessionAudit) {
          this.insertSupersessionAuditSync(supersessionAudit);
          this.incrementQueueMetricsSync({ reviewSuperseded: 1 });
        }
        const scheduledDispositionJson = scheduledLane
          ? this.recordScheduledDispositionSync(deliveryId, authenticatedBodyFingerprint, {
              ok: true,
              queued: true,
              item_key: key,
              superseded_publications: supersededPublications,
            })
          : null;
        return {
          deduped: false as const,
          key,
          state,
          supersededPublications,
          supersededRunId,
          scheduledDispositionJson,
        };
      });
      if (deferredBayLifecycle) this.syncBayLifecycle(deferredBayLifecycle);
      if ("conflict" in accepted && accepted.conflict) {
        return json({ error: "exact_review_delivery_conflict" }, 409);
      }
      if ("replayed" in accepted && accepted.replayed) {
        if (accepted.disposition.queued || accepted.disposition.deduped) {
          await this.scheduleNext(this.readStateSync(), now);
        }
        return jsonText(accepted.dispositionJson, 202);
      }
      if (accepted.deduped) {
        if ("state" in accepted) await this.scheduleNext(accepted.state, now);
        if (
          "scheduledDispositionJson" in accepted &&
          typeof accepted.scheduledDispositionJson === "string"
        ) {
          return jsonText(accepted.scheduledDispositionJson, 202);
        }
        return json(
          {
            ok: true,
            deduped: true,
            item_key:
              "semantic" in accepted && accepted.semantic
                ? accepted.key
                : "semanticEdited" in accepted && accepted.semanticEdited
                  ? accepted.key
                  : exactReviewItemKey(decision),
            ...("semantic" in accepted && accepted.semantic
              ? {
                  semantic_deduped: true,
                  semantic_duplicates_removed: accepted.semanticDuplicatesRemoved,
                }
              : {}),
            ...("semanticEdited" in accepted && accepted.semanticEdited
              ? {
                  dedupe_scope: "semantic_edited",
                  dedupe_reason: "unchanged_pull_request_edit",
                }
              : {}),
            ...("scheduled" in accepted && accepted.scheduled
              ? {
                  dedupe_scope: "scheduled_queue_item",
                  dedupe_reason: "item_already_pending_or_active",
                }
              : {}),
            ...("staleSource" in accepted && accepted.staleSource ? { stale_source: true } : {}),
            ...("staleCommand" in accepted && accepted.staleCommand ? { stale_command: true } : {}),
            ...(accepted.superseded
              ? {
                  superseded: true,
                  publication_revision: accepted.publicationRevision,
                  superseded_by_revision: accepted.supersededByRevision,
                }
              : {}),
            ...("crossRoute" in accepted && accepted.crossRoute
              ? { dedupe_scope: "cross_route" }
              : {}),
          },
          202,
        );
      }
      if (accepted.shed) {
        if (typeof accepted.scheduledDispositionJson === "string") {
          return jsonText(accepted.scheduledDispositionJson, 202);
        }
        return json({ ok: true, shed: true, reason: accepted.reason }, 202);
      }
      await this.scheduleNext(accepted.state, now);
      if (typeof accepted.scheduledDispositionJson === "string") {
        return jsonText(accepted.scheduledDispositionJson, 202);
      }
      return json(
        {
          ok: true,
          queued: true,
          item_key: accepted.key,
          superseded_publications: accepted.supersededPublications,
        },
        202,
      );
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

      let now = Date.now();
      let state = this.readStateSync();
      let item = tupleClaim ? state.items[itemKey] : exactReviewItemForLease(state, leaseId);
      if (
        item &&
        reclaimExpiredExactReviewLease(
          state,
          item.key,
          item,
          now,
          exactReviewPublicationDispatchLeaseMs(this.env),
          exactReviewHeartbeatGraceMs(this.env),
          this.env,
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

      const admission = await this.hostedTargetAdmission(
        item.decision.targetRepo,
        hostedTargetMetadataToken,
      );
      now = Date.now();
      state = this.readStateSync();
      item = tupleClaim ? state.items[itemKey] : exactReviewItemForLease(state, leaseId);
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
      if (admission.outcome === "terminal") {
        delete state.items[item.key];
        this.recordHostedTargetTerminal(item, now);
        this.writeStateSync(state);
        this.incrementQueueMetricsSync(
          exactReviewQueueIsPublication(item)
            ? { publicationCompleted: 1, publicationSuperseded: 1 }
            : { reviewCompleted: 1 },
        );
        await this.scheduleNext(state, now);
        return hostedTargetProbeResponse(admission);
      }
      if (admission.outcome === "retryable") return hostedTargetProbeResponse(admission);

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
          this.recordLifecycleClaim(item, now);
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
        this.recordLifecycleClaim(item, now);
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
      this.recordLifecycleClaim(item, now);
      await this.scheduleNext(state, now);
      return json(exactReviewClaimResponse(item, claimProtocolVersion, item.claimGeneration));
    }

    if (request.method === "POST" && url.pathname === "/heartbeat") {
      const body = objectValue(await request.json().catch(() => null));
      const itemKey = String(body.item_key || "").trim();
      const leaseId = String(body.lease_id || "").trim();
      const leaseRevision = Number(body.lease_revision);
      const runId = String(body.run_id || "").trim();
      const hasRunAttempt = body.run_attempt !== undefined;
      const runAttempt = hasRunAttempt ? exactReviewRunAttempt(body.run_attempt) : null;
      const hasClaimGeneration = body.claim_generation !== undefined;
      const claimGeneration = hasClaimGeneration ? Number(body.claim_generation) : null;
      const hasSourceHeadSha = body.source_head_sha !== undefined;
      const phase = body.phase === undefined ? "review" : String(body.phase);
      const sourceHeadSha = hasSourceHeadSha
        ? String(body.source_head_sha || "")
            .trim()
            .toLowerCase()
        : null;
      if (!itemKey || !leaseId || !runId) return json({ error: "missing_lease_tuple" }, 400);
      if (!Number.isInteger(leaseRevision) || leaseRevision < 1) {
        return json({ error: "invalid_lease_revision" }, 400);
      }
      if (!/^\d+$/.test(runId)) return json({ error: "invalid_run_id" }, 400);
      if (hasRunAttempt && runAttempt === null) return json({ error: "invalid_run_attempt" }, 400);
      if (hasClaimGeneration && (!Number.isInteger(claimGeneration) || claimGeneration < 1)) {
        return json({ error: "invalid_claim_generation" }, 400);
      }
      if (hasSourceHeadSha && !/^[0-9a-f]{40}$/.test(sourceHeadSha || "")) {
        return json({ error: "invalid_source_head_sha" }, 400);
      }
      if (phase !== "review" && phase !== "finalizing") {
        return json({ error: "invalid_lease_phase" }, 400);
      }

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
          this.env,
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
        (hasRunAttempt && item.claimedRunAttempt !== runAttempt) ||
        (hasClaimGeneration &&
          exactReviewClaimGeneration(item.claimGeneration) !== claimGeneration) ||
        (item.leaseDecision?.sourceHeadSha &&
          (!hasSourceHeadSha ||
            item.leaseDecision.sourceHeadSha.toLowerCase() !== sourceHeadSha)) ||
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
      item.leasePhase = phase;
      item.updatedAt = now;
      await this.writeState(state);
      await this.scheduleNext(state, now);
      return json({ ok: true, phase, lease_heartbeat_at: new Date(now).toISOString() });
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
      const reviewFailureReason =
        body.review_failure_reason === undefined
          ? undefined
          : body.review_failure_reason === "findings" ||
              body.review_failure_reason === "incomplete_source" ||
              body.review_failure_reason === "source_incompatible"
            ? (body.review_failure_reason as ExactReviewFailureReason)
            : null;
      if (body.review_failure_reason !== undefined && !reviewFailureReason) {
        return json({ error: "invalid_review_failure_reason" }, 400);
      }
      if (reviewFailureReason && outcome !== "failure") {
        return json({ error: "review_failure_reason_without_failure" }, 400);
      }
      const suppliedReviewFailure =
        body.review_failure === undefined
          ? undefined
          : normalizeExactReviewFailureDetail(body.review_failure);
      if (body.review_failure !== undefined && !suppliedReviewFailure) {
        return json({ error: "invalid_review_failure" }, 400);
      }
      if (suppliedReviewFailure && outcome === "success") {
        return json({ error: "review_failure_without_failure" }, 400);
      }
      if (
        suppliedReviewFailure &&
        reviewFailureReason !== undefined &&
        (suppliedReviewFailure.retryable ||
          suppliedReviewFailure.reasonCode !== reviewFailureReason)
      ) {
        return json({ error: "review_failure_retryability_mismatch" }, 400);
      }
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
        body.error_fingerprint !== undefined ||
        body.pool_class !== undefined ||
        body.attempted !== undefined;
      const publicationCompletion = hasStructuredCompletion
        ? exactReviewPublicationCompletion(
            body.completion_kind,
            body.reason_code,
            body.error_fingerprint,
            body.pool_class,
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
      const directLifecycleRequeue = body.direct_lifecycle_requeue === true;
      if (
        body.direct_lifecycle_requeue !== undefined &&
        typeof body.direct_lifecycle_requeue !== "boolean"
      ) {
        return json({ error: "invalid_direct_lifecycle_requeue" }, 400);
      }
      const lifecycleTerminal =
        body.lifecycle_terminal_disposition === undefined
          ? undefined
          : exactReviewLifecycleTerminalDisposition(body.lifecycle_terminal_disposition);
      if (body.lifecycle_terminal_disposition !== undefined && !lifecycleTerminal) {
        return json({ error: "invalid_lifecycle_terminal_disposition" }, 400);
      }
      if (requeueLatest && outcome !== "success") {
        return json({ error: "invalid_requeue_latest_outcome" }, 400);
      }

      const now = Date.now();
      const requestedRetryAt = exactReviewCompletionRetryAt(body.retry_at, now);
      if (body.retry_at !== undefined && requestedRetryAt === null) {
        return json({ error: "invalid_retry_at" }, 400);
      }
      const attempted = body.attempted === undefined ? undefined : body.attempted === true;
      if (body.attempted !== undefined && typeof body.attempted !== "boolean") {
        return json({ error: "invalid_publication_attempted" }, 400);
      }
      if (
        attempted === false &&
        (publicationCompletion?.reasonCode !== "github_rate_limit" || requestedRetryAt === null)
      ) {
        return json({ error: "invalid_publication_attempted" }, 400);
      }
      if (publicationCompletion && attempted !== undefined) {
        publicationCompletion.attempted = attempted;
      }
      const retryKind =
        body.retry_kind === undefined ? undefined : exactReviewRetryKind(body.retry_kind);
      if (body.retry_kind !== undefined && !retryKind) {
        return json({ error: "invalid_retry_kind" }, 400);
      }
      if (retryKind && outcome !== "failure") {
        return json({ error: "retry_kind_without_failure" }, 400);
      }
      if (retryKind && requestedRetryAt === null) {
        return json({ error: "retry_kind_without_retry_at" }, 400);
      }
      if (reviewFailureReason && retryKind) {
        return json({ error: "review_failure_reason_with_retry" }, 400);
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
        // A superseded active review has no completion left to record, but only
        // acknowledge it when the durable audit proves this exact v2 claimant
        // was fenced by a newer source revision. All ordinary ownership misses
        // remain conflicts so callers cannot mistake malformed tuples for a
        // completed or superseded review.
        const supersededByRevision =
          tupleCompletion && completionProtocolVersion === 2 && runAttempt !== null
            ? this.supersededCompletionRevisionSync({
                itemKey,
                leaseId,
                leaseRevision,
                claimGeneration,
                runId,
                runAttempt,
              })
            : null;
        if (supersededByRevision !== null) {
          return json(
            { error: "lease_superseded", superseded_by_revision: supersededByRevision },
            409,
          );
        }
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
      if (retryKind && publicationItem) {
        return json({ error: "retry_kind_outside_regular_review" }, 400);
      }
      if (reviewFailureReason && publicationItem) {
        return json({ error: "review_failure_reason_for_publication" }, 400);
      }
      const leasedDirectLifecycle = exactReviewSavedDirectLifecycle(item);
      // A non-superseding command may replace the current decision while this
      // old lease is still publishing. Its saved direct plan, not the newer
      // decision, establishes that this completion owns the old revision.
      const directLifecyclePublicationCompletion =
        Boolean(leasedDirectLifecycle) &&
        outcome === "success" &&
        (publicationCompletion?.kind === "published" ||
          publicationCompletion?.kind === "superseded");
      const exactDirectLifecycleRequeue =
        directLifecyclePublicationCompletion &&
        leasedDirectLifecycle?.owedRequeue &&
        publicationCompletion?.kind === "published";
      const publicationCompletionOwnedByLease =
        publicationItem || directLifecyclePublicationCompletion;
      if (publicationCompletion && !publicationCompletionOwnedByLease) {
        return json({ error: "completion_kind_outside_publication" }, 400);
      }
      if (directLifecycleRequeue && (!exactDirectLifecycleRequeue || requeueLatest)) {
        return json({ error: "invalid_direct_lifecycle_requeue" }, 400);
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
      const lifecycleItem =
        directLifecyclePublicationCompletion || directLifecycleRequeue
          ? {
              ...item,
              // The final completion belongs to the original direct receipt. A
              // non-superseding ingress may already have installed a newer
              // follow-up decision on this same queue key.
              decision: item.leaseDecision ?? item.decision,
              leaseDecision: item.leaseDecision,
            }
          : item;
      const lifecycleRevision =
        tupleCompletion || directLifecycleRequeue
          ? leaseRevision
          : (item.leaseRevision ?? item.revision);
      const lifecycleClaimGeneration =
        tupleCompletion || directLifecycleRequeue
          ? claimGeneration
          : exactReviewClaimGeneration(item.claimGeneration);
      if (!publicationItem && outcome !== "success" && !retryKind && runAttempt !== null) {
        this.recordReviewFailureAttemptSafely({
          item: lifecycleItem,
          revision: lifecycleRevision,
          claimGeneration: lifecycleClaimGeneration,
          runId,
          runAttempt,
          outcome,
          ...(reviewFailureReason ? { terminalReason: reviewFailureReason } : {}),
          ...(suppliedReviewFailure ? { supplied: suppliedReviewFailure } : {}),
          observedAt: now,
        });
      }
      const publicationAttempt =
        publicationCompletionOwnedByLease && publicationCompletion
          ? publicationCompletion.attempted === false ||
            publicationCompletion.kind === "published" ||
            publicationCompletion.kind === "superseded" ||
            publicationCompletion.kind === "deferred"
            ? Number(item.publicationFailureAttempts || 0)
            : Number(item.publicationFailureAttempts || 0) + 1
          : 0;
      const completionResult = directLifecycleRequeue
        ? item.revision > leaseRevision
          ? finishExactReviewPublicationQueueItem({
              state,
              item,
              now,
              completion: publicationCompletion!,
              ownedRevision: leaseRevision,
              requestedRetryAt: requestedRetryAt ?? undefined,
              deadLetterCapacityAvailable: this.deadLetterCapacityAvailableSync(
                exactReviewDeadLetterId(item),
              ),
              env: this.env,
            })
          : this.requeueDirectLifecyclePublicationSync(state, item, now)
        : publicationCompletionOwnedByLease && publicationCompletion
          ? finishExactReviewPublicationQueueItem({
              state,
              item,
              now,
              completion: publicationCompletion,
              ...(directLifecyclePublicationCompletion ? { ownedRevision: leaseRevision } : {}),
              requestedRetryAt: requestedRetryAt ?? undefined,
              requeueLatest,
              deadLetterCapacityAvailable: this.deadLetterCapacityAvailableSync(
                exactReviewDeadLetterId(item),
              ),
              env: this.env,
            })
          : {
              ...finishExactReviewQueueItem(
                state,
                item,
                now,
                outcome,
                requestedRetryAt ?? undefined,
                requeueLatest,
                retryKind,
                reviewFailureReason,
                this.random,
                this.env,
              ),
              retried: outcome !== "success" && reviewFailureReason === undefined,
              refreshed: false,
              deadLetter: undefined,
            };
      // A newer command revision may retain the current queue slot while this
      // direct receipt completes. Its queue requeue is not a requeue fact for
      // the older fenced lifecycle projection.
      const lifecycleRequeued =
        directLifecyclePublicationCompletion &&
        !directLifecycleRequeue &&
        item.revision > leaseRevision
          ? false
          : completionResult.requeued;
      const lifecycleIdentity: ExactReviewLifecycleProjectionIdentity = {
        canonicalTargetKey: `${lifecycleItem.decision.targetRepo}#${lifecycleItem.decision.itemNumber}`,
        fenceKey: lifecycleItem.key,
        revision: lifecycleRevision,
      };
      const projectionBeforeTerminalCommit = publicationCompletionOwnedByLease
        ? this.lifecycleProjectionStore.read(
            lifecycleIdentity.canonicalTargetKey,
            lifecycleIdentity.fenceKey,
            lifecycleIdentity.revision,
          )
        : null;
      const terminalDisposition = exactReviewLifecycleCompletionDisposition({
        projection: projectionBeforeTerminalCommit,
        outcome,
        publicationCompletion,
        requeued: lifecycleRequeued,
        parked: Boolean(completionResult.parked),
        deadLetter: Boolean(completionResult.deadLetter),
        lifecycleTerminal,
      });
      const terminalFinalization =
        publicationCompletionOwnedByLease &&
        !lifecycleRequeued &&
        !completionResult.parked &&
        exactReviewQueueHasCommandContext(lifecycleItem) &&
        terminalDisposition &&
        terminalDisposition !== "requeue"
          ? exactReviewTerminalFinalization(terminalDisposition, lifecycleIdentity)
          : null;
      const projectionTerminalFinalization =
        terminalFinalization && projectionBeforeTerminalCommit ? terminalFinalization : null;
      if (projectionTerminalFinalization) {
        if (!projectionBeforeTerminalCommit) {
          throw new Error("missing lifecycle projection for terminal finalization");
        }
        this.ensureLifecycleTerminalFinalizationDriver({
          state,
          projection: projectionBeforeTerminalCommit,
          terminalDisposition: projectionTerminalFinalization.disposition,
          now,
        });
      } else if (terminalFinalization) {
        // Persist the terminal decision's acknowledgement driver in the same
        // queue transition that consumed the publishing lease. The next run is
        // a finalizer-only dispatch, so retries cannot publish the review again.
        state.items[item.key] = item;
        clearExactReviewLease(item);
        item.state = "pending";
        item.terminalFinalization = terminalFinalization;
        item.nextAttemptAt = now;
        item.backoffReason = undefined;
        item.updatedAt = now;
      }
      const { requeued } = completionResult;
      const publicationTransition =
        publicationCompletionOwnedByLease && publicationCompletion
          ? exactReviewPublicationTransitionFact({
              completion: publicationCompletion,
              result: completionResult,
              itemRevision: item.revision,
              ownedRevision: lifecycleRevision,
              requeueLatest,
              defaultPoolClass: "target_app",
              backoffReason:
                completionResult.requeued || completionResult.parked
                  ? item.backoffReason
                  : undefined,
              attempt: publicationAttempt,
            })
          : null;
      if (!publicationItem && retryKind === "throttle") {
        this.deferScheduledReviewAdmissionForThrottleSync(now, requestedRetryAt ?? 0);
      }
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
          ...(publicationTransition ? { publicationTransitions: [publicationTransition] } : {}),
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
      try {
        const projectionAfterCompletion = this.recordLifecycleCompletion({
          item: lifecycleItem,
          revision: lifecycleRevision,
          claimGeneration: lifecycleClaimGeneration,
          runId,
          runAttempt,
          outcome,
          publicationCompletion,
          requeued: lifecycleRequeued,
          parked: Boolean(completionResult.parked),
          deadLetter: Boolean(completionResult.deadLetter),
          lifecycleTerminal,
          now,
        });
        if (publicationItem && publicationCompletion) {
          this.recordLifecycleTelemetryNonBatchPublication({
            identity: lifecycleIdentity,
            claimGeneration: lifecycleClaimGeneration,
            completion: publicationCompletion,
            projection: projectionBeforeTerminalCommit,
            observedAt: now,
          });
        }
        if (projectionAfterCompletion?.terminalDisposition?.kind === "requeue") {
          if (this.cancelTerminalFinalizationDrivers(state, lifecycleIdentity)) {
            await this.writeState(state);
          }
        }
      } finally {
        // The queue transition is durable even when its lifecycle update fails.
        await this.scheduleNext(state, now);
      }
      return json({
        ok: true,
        requeued,
        ...(terminalFinalization ? { terminal_finalization: true } : {}),
      });
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
      const matchesByRunId = new Map<
        string,
        Array<{ run_id: string; run_attempt: number | null; claim_generation: number }>
      >();
      // Extract only lease identity fields. Reading the full state would parse
      // every pending item's decision and retained publication payload too.
      for (const row of this.storage.sql.exec(
        `SELECT item_key,
                json_extract(item_json, '$.key', '$.claimedRunId',
                             '$.claimedRunAttempt', '$.claimGeneration') AS claim_json
           FROM ${EXACT_REVIEW_QUEUE_ITEM_TABLE}
          WHERE json_extract(item_json, '$.state') = 'leased'
            ${includeAllClaimed ? "" : "AND json_extract(item_json, '$.claimedRunId') IN (SELECT value FROM json_each(?))"}
          ORDER BY rowid`,
        ...(includeAllClaimed ? [] : [JSON.stringify([...requestedRunIds])]),
      ) as Iterable<{ item_key: string; claim_json: string }>) {
        const [key, runId, runAttempt, generation] = JSON.parse(row.claim_json) as [
          string,
          string | null,
          number | null,
          number | null,
        ];
        if (key !== row.item_key) throw new Error("invalid exact-review queue claim item");
        if (!runId || (!includeAllClaimed && !requestedRunIds.has(runId))) continue;
        const matches = matchesByRunId.get(runId) || [];
        if (matches.length < 2)
          matches.push({
            run_id: String(runId),
            run_attempt: runAttempt ?? null,
            claim_generation: exactReviewClaimGeneration(generation),
          });
        matchesByRunId.set(runId, matches);
      }
      const runs = [...matchesByRunId.values()].flat().slice(0, EXACT_REVIEW_RECONCILE_RUN_LIMIT);
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

    if (request.method === "POST" && url.pathname === "/parked-reviews/list") {
      return this.listParkedReviews(await request.json().catch(() => null));
    }

    if (request.method === "POST" && url.pathname === "/parked-reviews/resolve") {
      return this.resolveParkedReviews(await request.json().catch(() => null));
    }

    if (request.method === "POST" && url.pathname === "/parked-reviews/recover-fresh") {
      return this.recoverParkedReviewsFresh(await request.json().catch(() => null));
    }

    if (request.method === "POST" && url.pathname === "/publications/list") {
      return this.listPublicationCandidates(await request.json().catch(() => null));
    }

    if (request.method === "POST" && url.pathname === "/publications/supersede") {
      return this.supersedePublicationCandidates(await request.json().catch(() => null));
    }

    if (request.method === "POST" && url.pathname === "/publications/reconcile") {
      return this.reconcilePublicationCandidates(
        await request.json().catch(() => null),
        hostedTargetMetadataToken,
      );
    }

    const canonicalRecordMatch =
      request.method === "GET"
        ? /^\/records\/([^/]+)\/(items|closed|plans|decision-packets)\/([1-9]\d*)$/.exec(
            url.pathname,
          )
        : null;
    if (canonicalRecordMatch) {
      const repoSlug = validateRepoSlug(canonicalRecordMatch[1]);
      const section = validateTupleRecordSection(canonicalRecordMatch[2]);
      const itemId = Number(canonicalRecordMatch[3]);
      if (!repoSlug || !section || !Number.isSafeInteger(itemId)) {
        return json({ error: "invalid_canonical_record_identity" }, 400);
      }
      const record = this.directPublicationStore.readCanonical(repoSlug, section, itemId);
      if (!record || record.deleted) {
        return json(
          {
            error: "record_not_found",
            ...(record
              ? {
                  digest: null,
                  revision: record.revision,
                  updatedAt: new Date(record.updatedAt).toISOString(),
                  deleted: true,
                }
              : {}),
          },
          404,
        );
      }
      return json({
        content: record.content,
        digest: record.digest,
        revision: record.revision,
        updatedAt: new Date(record.updatedAt).toISOString(),
      });
    }

    if (request.method === "POST" && url.pathname === "/records/slugs") {
      return json({ ok: true, repositories: this.directPublicationStore.listRecordRepoSlugs() });
    }

    if (request.method === "POST" && url.pathname === "/records/list") {
      const body = objectValue(await request.json().catch(() => null));
      const repoSlug = validateRepoSlug(body.repoSlug);
      const section = validateTupleRecordSection(body.section);
      const cursor = body.cursor === undefined || body.cursor === null ? 0 : Number(body.cursor);
      const limit = body.limit === undefined ? 100 : Number(body.limit);
      if (
        !repoSlug ||
        !section ||
        !Number.isSafeInteger(cursor) ||
        cursor < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 500
      ) {
        return json({ error: "invalid_canonical_record_listing" }, 400);
      }
      const records = this.directPublicationStore.listCanonical({
        repoSlug,
        section,
        cursor,
        limit,
      });
      return json({
        repoSlug,
        section,
        cursor,
        limit,
        records: records.map((record) => ({
          id: record.id,
          digest: record.digest,
          revision: record.revision,
          updatedAt: new Date(record.updatedAt).toISOString(),
        })),
        nextCursor: records.length === limit ? (records.at(-1)?.id ?? null) : null,
      });
    }

    if (request.method === "POST" && url.pathname === "/records/export") {
      const body = objectValue(await request.json().catch(() => null));
      const repoSlug = validateRepoSlug(body.repoSlug);
      const rawSections = body.sections === undefined ? RECORD_EXPORT_SECTIONS : body.sections;
      const sections = Array.isArray(rawSections)
        ? [...new Set(rawSections.map(validateRecordSection).filter(Boolean))]
        : [];
      const sinceRevision = body.sinceRevision === undefined ? 0 : Number(body.sinceRevision);
      const cursor = body.cursor === undefined || body.cursor === null ? 0 : Number(body.cursor);
      const limit = body.limit === undefined ? RECORD_EXPORT_DEFAULT_LIMIT : Number(body.limit);
      if (
        !repoSlug ||
        !Array.isArray(rawSections) ||
        !sections.length ||
        sections.length !== rawSections.length ||
        !Number.isSafeInteger(sinceRevision) ||
        sinceRevision < 0 ||
        !Number.isSafeInteger(cursor) ||
        cursor < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > RECORD_EXPORT_MAX_LIMIT
      ) {
        return json({ error: "invalid_canonical_record_export" }, 400);
      }
      const exported = this.directPublicationStore.exportRecords({
        repoSlug,
        sections: sections as RecordSection[],
        sinceRevision,
        cursor,
        limit,
        maxBytes: RECORD_EXPORT_MAX_RESPONSE_BYTES,
        maxSourceBytes: RECORD_EXPORT_MAX_SOURCE_BYTES,
        maxRecords: RECORD_EXPORT_MAX_RECONSTRUCTION_RECORDS,
      });
      return json({
        repoSlug,
        sections,
        sinceRevision,
        cursor,
        limit,
        revision: exported.watermark,
        records: exported.records.map((record) => ({
          section: record.section,
          id: record.id,
          content: record.content,
          digest: record.digest,
          revision: record.revision,
          storeRevision: record.storeRevision,
          updatedAt: new Date(record.updatedAt).toISOString(),
          deleted: record.deleted,
        })),
        nextCursor: exported.nextCursor,
      });
    }

    if (request.method === "POST" && url.pathname === "/records/snapshots/latest") {
      const body = objectValue(await request.json().catch(() => null));
      const repoSlug = validateRepoSlug(body.repoSlug);
      if (!repoSlug) return json({ error: "invalid_snapshot_repository" }, 400);
      try {
        const snapshot = await this.recordSnapshotStore.latest(repoSlug);
        if (!snapshot) {
          return json({ error: "snapshot_not_found", snapshotStoreAvailable: true, repoSlug }, 404);
        }
        return json({ ok: true, snapshotStoreAvailable: true, snapshot: snapshotJson(snapshot) });
      } catch (error) {
        return snapshotErrorResponse(error);
      }
    }

    if (request.method === "POST" && url.pathname === "/records/snapshots/discard") {
      try {
        await this.recordSnapshotStore.discardUnregistered(objectValue(await request.json()));
        return json({ ok: true });
      } catch (error) {
        return snapshotErrorResponse(error);
      }
    }

    if (request.method === "POST" && url.pathname === "/records/snapshots/register") {
      const body = objectValue(await request.json().catch(() => null));
      try {
        const snapshot = await this.recordSnapshotStore.register(body);
        return json(
          { ok: true, snapshotStoreAvailable: true, snapshot: snapshotJson(snapshot) },
          201,
        );
      } catch (error) {
        return snapshotErrorResponse(error);
      }
    }

    if (request.method === "POST" && url.pathname === "/records/snapshots/trigger") {
      const body = objectValue(await request.json().catch(() => null));
      const repoSlug = validateRepoSlug(body.repoSlug);
      if (!repoSlug) return json({ error: "invalid_snapshot_repository" }, 400);
      try {
        const snapshot = await this.recordSnapshotStore.produce(repoSlug);
        return json(
          { ok: true, snapshotStoreAvailable: true, snapshot: snapshotJson(snapshot) },
          201,
        );
      } catch (error) {
        return snapshotErrorResponse(error);
      }
    }

    if (request.method === "POST" && url.pathname === "/records/snapshots/chunk") {
      const body = objectValue(await request.json().catch(() => null));
      const repoSlug = validateRepoSlug(body.repoSlug);
      if (!repoSlug) return json({ error: "invalid_snapshot_repository" }, 400);
      try {
        const result = await this.recordSnapshotStore.readRange(
          repoSlug,
          Number(body.revisionWatermark),
          Number(body.offset),
          Number(body.length),
        );
        return new Response(result.object.body, {
          status: 206,
          headers: {
            "accept-ranges": "bytes",
            "content-length": String(result.length),
            "content-range": `bytes ${Number(body.offset)}-${Number(body.offset) + result.length - 1}/${result.snapshot.bytes}`,
            "content-type": "application/gzip",
            "x-clawsweeper-snapshot-revision": String(result.snapshot.revisionWatermark),
          },
        });
      } catch (error) {
        return snapshotErrorResponse(error);
      }
    }

    if (request.method === "POST" && url.pathname === "/records/commits") {
      const bodyText = await request.text();
      if (new TextEncoder().encode(bodyText).byteLength > RECORD_INGEST_MAX_REQUEST_BYTES) {
        return json(
          {
            error: "canonical_commit_records_too_large",
            maxBytes: RECORD_INGEST_MAX_REQUEST_BYTES,
          },
          413,
        );
      }
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(bodyText || "null");
      } catch {
        return json({ error: "invalid_canonical_commit_records" }, 400);
      }
      const body = objectValue(parsedBody);
      const repoSlug = validateRepoSlug(body.repo_slug);
      if (
        !repoSlug ||
        !Array.isArray(body.records) ||
        body.records.length < 1 ||
        body.records.length > RECORD_INGEST_MAX_RECORDS
      ) {
        return json({ error: "invalid_canonical_commit_records" }, 400);
      }
      const records: CanonicalCommitRecordInput[] = [];
      for (const value of body.records) {
        const record = objectValue(value);
        const section = "commits" as const;
        const id = validateRecordId(section, record.sha);
        const content = typeof record.content === "string" ? record.content : null;
        const digest = String(record.digest || "").toLowerCase();
        if (!section || !id || content === null || !/^[0-9a-f]{64}$/.test(digest)) {
          return json({ error: "invalid_canonical_commit_records" }, 400);
        }
        const bytes = new TextEncoder().encode(content);
        if (bytes.byteLength > RECORD_INGEST_MAX_FILE_BYTES) {
          return json(
            {
              error: "canonical_record_too_large",
              section,
              id,
              maxBytes: RECORD_INGEST_MAX_FILE_BYTES,
            },
            413,
          );
        }
        if ((await sha256Hex(bytes)) !== digest) {
          return json({ error: "canonical_record_digest_mismatch", section, id }, 400);
        }
        records.push({ section, id, content, digest, bytes: bytes.byteLength });
      }
      try {
        const published = this.directPublicationStore.publishCanonicalCommits(
          repoSlug,
          records,
          Date.now(),
        );
        return json({ ok: true, repo_slug: repoSlug, ...published }, 202);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith("conflicting canonical commit record")
        ) {
          return json({ error: "canonical_commit_record_conflict" }, 409);
        }
        throw error;
      }
    }

    if (request.method === "POST" && url.pathname === "/records/tuples") {
      const bodyText = await request.text();
      if (
        new TextEncoder().encode(bodyText).byteLength >
        EXACT_REVIEW_DIRECT_PUBLICATION_MAX_POST_BYTES
      ) {
        return json({ error: "canonical_record_tuple_too_large" }, 413);
      }
      let mutation: CanonicalRecordTupleMutation;
      try {
        mutation = JSON.parse(bodyText) as CanonicalRecordTupleMutation;
      } catch {
        return json({ error: "invalid_canonical_record_tuple_json" }, 400);
      }
      try {
        const validated = await validateCanonicalRecordTupleMutation(mutation);
        const accepted = this.directPublicationStore.acceptCanonicalTupleMutation(
          validated,
          Date.now(),
        );
        return json(
          {
            ok: true,
            accepted: accepted.outcome === "accepted",
            deduped: accepted.outcome === "deduped",
            revision: accepted.revision,
          },
          202,
        );
      } catch (error) {
        if (error instanceof CanonicalRecordTupleConflictError) {
          console.warn("canonical_record_tuple_conflict");
          return json(
            {
              error: "canonical_record_tuple_conflict",
              ...(error.current ? { current: error.current } : {}),
            },
            409,
          );
        }
        console.warn("canonical_record_tuple_rejected");
        return json({ error: "invalid_canonical_record_tuple" }, 400);
      }
    }

    if (
      request.method === "POST" &&
      (url.pathname === "/publication-results" || url.pathname === "/publication-batch-results")
    ) {
      const deferredBatchCompletion = url.pathname === "/publication-batch-results";
      if (!exactReviewDirectPublicationEnabled(this.env)) {
        return json({ error: "direct_publication_disabled", fallback_required: true }, 409);
      }
      const bodyText = await request.text();
      if (
        new TextEncoder().encode(bodyText).byteLength >
        EXACT_REVIEW_DIRECT_PUBLICATION_MAX_POST_BYTES
      ) {
        console.warn("direct_publication_payload_rejected");
        return json(
          {
            error: "direct_publication_payload_too_large",
            max_bytes: EXACT_REVIEW_DIRECT_PUBLICATION_MAX_POST_BYTES,
            fallback_required: true,
          },
          413,
        );
      }
      let plan: DirectPublicationPlan;
      try {
        plan = JSON.parse(bodyText) as DirectPublicationPlan;
      } catch {
        return json({ error: "invalid_direct_publication_json" }, 400);
      }
      try {
        const validated = await validateDirectPublicationPlan(plan);
        let now = Date.now();
        let ownership = this.directPublicationFenceSnapshot(
          validated,
          deferredBatchCompletion,
          now,
        );
        let { state, owned, existing, batchOwned, validFence, staleBatchFence } = ownership;
        if (staleBatchFence) {
          return directPublicationSupersededResponse(validated);
        }
        if (!validFence && !existing) {
          if (!deferredBatchCompletion) {
            this.recordLifecycleTelemetryDirect({
              validated,
              outcome: "fallback",
              observedAt: now,
            });
          }
          return json(
            { error: "direct_publication_fence_not_owned", fallback_required: true },
            409,
          );
        }
        if (!deferredBatchCompletion && !validated.sourceSha) {
          this.recordLifecycleTelemetryDirect({
            validated,
            outcome: "fallback",
            observedAt: now,
          });
          return json(
            { error: "direct_publication_source_sha_required", fallback_required: true },
            400,
          );
        }
        const targetRepo = validated.canonicalTargetKey.slice(
          0,
          validated.canonicalTargetKey.lastIndexOf("#"),
        );
        const admission = await this.hostedTargetAdmission(targetRepo, hostedTargetMetadataToken);
        now = Date.now();
        ownership = this.directPublicationFenceSnapshot(validated, deferredBatchCompletion, now);
        ({ state, owned, existing, batchOwned, validFence, staleBatchFence } = ownership);
        if (staleBatchFence) {
          return directPublicationSupersededResponse(validated);
        }
        if (!validFence && !existing) {
          if (!deferredBatchCompletion) {
            this.recordLifecycleTelemetryDirect({
              validated,
              outcome: "fallback",
              observedAt: now,
            });
          }
          return json(
            { error: "direct_publication_fence_not_owned", fallback_required: true },
            409,
          );
        }
        if (admission.outcome === "terminal") {
          return directPublicationSupersededResponse(validated);
        }
        if (admission.outcome === "retryable") return hostedTargetProbeResponse(admission);
        // Batch publication retries rerun guarded GitHub apply before they reach
        // this endpoint. That can refresh apply-only report fields after the
        // canonical tuple was already accepted, so the regenerated bytes are
        // not an immutable retry of the first plan. The exact active batch
        // fence still proves ownership: resume from its terminal canonical
        // receipt and let the batch finish post-effects. Direct producers keep
        // the strict same-plan retry check in accept().
        const accepted =
          deferredBatchCompletion &&
          batchOwned &&
          existing &&
          (existing.state === "published" || existing.state === "superseded")
            ? {
                outcome:
                  existing.state === "superseded" ? ("superseded" as const) : ("deduped" as const),
                row: existing,
                supersededRevisions: [],
              }
            : this.directPublicationStore.accept(validated, now);
        this.recordLifecycleDirectPublication({
          validated,
          owned,
          accepted,
          now,
          publicationPath: deferredBatchCompletion ? "batch" : "direct",
        });
        if (!deferredBatchCompletion) {
          this.recordLifecycleTelemetryDirect({
            validated,
            outcome: accepted.outcome,
            observedAt: now,
          });
        }
        if (owned && validFence && !deferredBatchCompletion && !owned.decision.publication) {
          const producerDecision = owned.decision.publication
            ? owned.decision.publication.producerDecision
            : (owned.leaseDecision ?? owned.decision);
          const producerRunId = String(owned.claimedRunId || "");
          const producerRunAttempt = Number(owned.claimedRunAttempt || 0);
          if (
            !/^\d+$/.test(producerRunId) ||
            !Number.isSafeInteger(producerRunAttempt) ||
            producerRunAttempt < 1
          ) {
            throw new Error("direct publication source run identity is unavailable");
          }
          if (!validated.sourceSha) {
            throw new Error("direct publication source SHA is unavailable");
          }
          const publication: ExactReviewPublication = {
            artifactName: `exact-review-${producerRunId}-${producerRunAttempt}`,
            producerRunId,
            producerRunAttempt,
            sourceSha: validated.sourceSha,
            itemKey: validated.fenceKey,
            protocolVersion: 2,
            leaseRevision: validated.revision,
            claimGeneration: validated.identity.claimGeneration,
            liveProceeded: true,
            liveTerminalNoop: false,
            liveTerminalMissing: false,
            liveGuardedOpen: false,
            producerDecision,
            ...(accepted.row.lifecycle
              ? {
                  directLifecycle: {
                    plan: accepted.row.lifecycle,
                    receiptOutcome: accepted.outcome,
                  },
                }
              : {}),
          };
          const publicationDecision: ExactReviewDecision = {
            ...producerDecision,
            sourceAction: EXACT_REVIEW_ARTIFACT_PUBLISH_SOURCE_ACTION,
            supersedesInProgress: false,
            publication,
          };
          owned.decision = publicationDecision;
          owned.leaseDecision = publicationDecision;
          // The canonical record is durable, but its router handoff and guarded
          // command-status edit are separate lifecycle post-effects. Keep this
          // converted publication lease recoverable until that finalizer reports
          // a structured publication completion.
          await this.writeState(state, {
            reviewCompleted: 1,
            publicationEnqueued: 1,
          });
        }
        await this.scheduleNext(this.readStateSync(), Date.now());
        return json(
          {
            ok: true,
            accepted: accepted.outcome === "accepted",
            deduped: accepted.outcome === "deduped",
            superseded: accepted.outcome === "superseded",
            superseded_revisions: accepted.supersededRevisions,
            canonical_target_key: accepted.row.canonicalTargetKey,
            fence_key: accepted.row.fenceKey,
            state_commit_sha: accepted.row.commitSha,
          },
          202,
        );
      } catch (error) {
        const detail = directPublicationRejectionDetail(error);
        console.warn("direct_publication_plan_rejected");
        return json(
          {
            error: "invalid_direct_publication_plan",
            fallback_required: true,
            detail,
          },
          400,
        );
      }
    }

    if (request.method === "POST" && url.pathname === "/lifecycle/canonical-receipt") {
      return this.recordLifecycleCanonicalReceipt(await request.json().catch(() => null));
    }

    if (request.method === "POST" && url.pathname === "/lifecycle/router-receipt") {
      return this.recordLifecycleRouterReceipt(await request.json().catch(() => null));
    }

    if (request.method === "POST" && url.pathname === "/lifecycle/terminal-disposition") {
      return this.recordLifecycleTerminalDisposition(await request.json().catch(() => null));
    }

    if (request.method === "POST" && url.pathname === "/lifecycle/command-ack/attempt") {
      return this.authorizeLifecycleCommandAcknowledgement(await request.json().catch(() => null));
    }

    if (request.method === "POST" && url.pathname === "/terminal-finalization/attempt") {
      return this.beginTerminalFinalizationAcknowledgement(await request.json().catch(() => null));
    }

    if (request.method === "POST" && url.pathname === "/terminal-finalization/retry") {
      return this.retryTerminalFinalization(await request.json().catch(() => null));
    }

    if (request.method === "POST" && url.pathname === "/terminal-finalization/skip") {
      return this.skipTerminalFinalization(await request.json().catch(() => null));
    }

    if (request.method === "POST" && url.pathname === "/lifecycle/command-ack/observed") {
      return this.observeLifecycleCommandAcknowledgement(
        await request.json().catch(() => null),
        request,
        hostedTargetMetadataToken,
      );
    }

    if (request.method === "POST" && url.pathname === "/lifecycle/command-ack/failed") {
      return this.releaseLifecycleCommandAcknowledgement(await request.json().catch(() => null));
    }

    if (request.method === "POST" && url.pathname === "/review-run-telemetry") {
      return this.recordReviewRunTelemetry(await request.json().catch(() => null));
    }

    if (request.method === "GET" && url.pathname === "/review-observability") {
      return this.reviewObservability(url.searchParams);
    }

    if (request.method === "POST" && url.pathname === "/review-failures/list") {
      const body = objectValue(await request.json().catch(() => null));
      const limit = body.limit === undefined ? 100 : Number(body.limit);
      const cursor = body.cursor === undefined ? undefined : String(body.cursor || "");
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        (cursor !== undefined && !/^\d{1,16}:[0-9a-f]{64}$/.test(cursor))
      ) {
        return json({ error: "invalid_review_failure_inventory_request" }, 400);
      }
      return json({
        ok: true,
        ...this.reviewFailureTelemetryStore.listSync({
          limit,
          ...(cursor ? { cursor } : {}),
        }),
      });
    }

    if (request.method === "GET" && url.pathname === "/review-coverage") {
      // The dashboard polls this with the status refresh; cache the bounded
      // canonical-record scan so polling stays cheap.
      const now = Date.now();
      if (!this.reviewCoverageCache || now - this.reviewCoverageCache.at > 60_000) {
        this.reviewCoverageCache = {
          at: now,
          summary: this.directPublicationStore.reviewCoverageSync(
            now,
            undefined,
            normalizeReviewCoverageInventory(this.storage.kv.get(REVIEW_COVERAGE_INVENTORY_KEY)),
          ),
        };
      }
      return json({
        ok: true,
        generated_at: new Date(this.reviewCoverageCache.at).toISOString(),
        ...this.reviewCoverageCache.summary,
      });
    }

    if (request.method === "POST" && url.pathname === "/publication-batches/claim") {
      return this.claimPublicationBatch(
        await request.json().catch(() => null),
        hostedTargetMetadataToken,
      );
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

    if (request.method === "POST" && url.pathname === "/artifact-cache/receipt/lookup") {
      const body = await request.json().catch(() => null);
      if (!exactReviewArtifactReceiptTuple(body)) {
        return json({ error: "invalid_artifact_receipt_tuple" }, 400);
      }
      const now = Date.now();
      const receipt = this.artifactReceiptStore.lookup(body, now);
      await this.artifactReceiptStore.prune(now).catch(() => {
        console.warn("artifact_cache_prune_failed");
      });
      return json({ ok: true, hit: Boolean(receipt), receipt });
    }

    if (request.method === "POST" && url.pathname === "/github-etag-cache/lookup") {
      const body = await request.json().catch(() => null);
      if (!githubEtagCacheKeyFromValue(body)) {
        return json({ error: "invalid_github_etag_cache_key" }, 400);
      }
      const entry = this.githubEtagResponseStore.lookup(body, Date.now());
      return json({ ok: true, hit: Boolean(entry), entry });
    }

    if (request.method === "POST" && url.pathname === "/github-etag-cache/store") {
      const body = await request.json().catch(() => null);
      try {
        const result = await this.githubEtagResponseStore.store200(body, Date.now());
        if (!result.ok) return json({ error: result.error }, result.status);
        return json(result, result.stored ? 201 : 200);
      } catch {
        console.warn("github_etag_cache_store_failed");
        return json({ error: "github_etag_cache_unavailable" }, 503);
      }
    }

    if (request.method === "POST" && url.pathname === "/github-etag-cache/confirm") {
      const body = await request.json().catch(() => null);
      const result = this.githubEtagResponseStore.confirm304(body, Date.now());
      if (!result.ok) return json({ error: result.error }, result.status);
      return json(result);
    }

    if (request.method === "POST" && url.pathname === "/github-read-model/ingest") {
      try {
        return json(
          this.githubWebhookReadModelStore.ingest(await request.json().catch(() => null)),
          202,
        );
      } catch {
        return json({ error: "invalid_github_webhook_read_model_delivery" }, 400);
      }
    }

    if (request.method === "POST" && url.pathname === "/github-read-model/lease-item") {
      const body = objectValue(await request.json().catch(() => null));
      const itemKey = String(body.item_key || "").trim();
      const leaseId = String(body.lease_id || "").trim();
      const leaseRevision = Number(body.lease_revision);
      const claimGeneration = Number(body.claim_generation);
      const runId = String(body.run_id || "").trim();
      const runAttempt = exactReviewRunAttempt(body.run_attempt);
      const sourceHeadSha = String(body.source_head_sha || "")
        .trim()
        .toLowerCase();
      const repository = String(body.repository || "")
        .trim()
        .toLowerCase();
      const number = Number(body.number);
      if (
        !itemKey ||
        !leaseId ||
        !/^\d+$/.test(runId) ||
        !Number.isInteger(leaseRevision) ||
        leaseRevision < 1 ||
        !Number.isInteger(claimGeneration) ||
        claimGeneration < 1 ||
        runAttempt === null ||
        !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository) ||
        !Number.isSafeInteger(number) ||
        number < 1 ||
        (sourceHeadSha && !/^[0-9a-f]{40}$/.test(sourceHeadSha))
      ) {
        return json({ error: "invalid_lease_read_tuple" }, 400);
      }
      const item = this.readStateSync().items[itemKey];
      const now = Date.now();
      if (
        !item ||
        item.state !== "leased" ||
        item.leaseId !== leaseId ||
        item.leaseRevision !== leaseRevision ||
        exactReviewClaimGeneration(item.claimGeneration) !== claimGeneration ||
        item.claimedRunId !== runId ||
        item.claimedRunAttempt !== runAttempt ||
        item.decision.targetRepo.toLowerCase() !== repository ||
        item.decision.itemNumber !== number ||
        (item.leaseDecision?.sourceHeadSha &&
          item.leaseDecision.sourceHeadSha.toLowerCase() !== sourceHeadSha) ||
        !isLiveExactReviewLease(
          item,
          now,
          exactReviewPublicationDispatchLeaseMs(this.env),
          exactReviewHeartbeatGraceMs(this.env),
        )
      ) {
        return json({ error: "lease_not_active" }, 409);
      }
      return json({
        ...(await this.githubWebhookReadModelStore.readItem({ repository, number }, now)),
        lease_authorized: true,
      });
    }

    if (request.method === "POST" && url.pathname === "/github-read-model/repair") {
      try {
        return json(
          this.githubWebhookReadModelStore.repair(await request.json().catch(() => null)),
          202,
        );
      } catch {
        return json({ error: "invalid_github_webhook_read_model_repair" }, 400);
      }
    }

    if (request.method === "POST" && url.pathname === "/github-read-model/item") {
      try {
        return json(
          await this.githubWebhookReadModelStore.readItem(await request.json().catch(() => null)),
        );
      } catch {
        return json({ error: "invalid_github_webhook_read_model_item_request" }, 400);
      }
    }

    if (request.method === "POST" && url.pathname === "/github-read-model/comments") {
      try {
        return json(
          await this.githubWebhookReadModelStore.readComments(
            await request.json().catch(() => null),
          ),
        );
      } catch {
        return json({ error: "invalid_github_webhook_read_model_comments_request" }, 400);
      }
    }

    if (request.method === "POST" && url.pathname === "/github-read-model/activity") {
      try {
        return json(
          await this.githubWebhookReadModelStore.readActivity(
            await request.json().catch(() => null),
          ),
        );
      } catch {
        return json({ error: "invalid_github_webhook_read_model_activity_request" }, 400);
      }
    }

    if (request.method === "POST" && url.pathname === "/github-read-model/workflows") {
      try {
        return json(
          await this.githubWebhookReadModelStore.readWorkflows(
            await request.json().catch(() => null),
          ),
        );
      } catch {
        return json({ error: "invalid_github_webhook_read_model_workflows_request" }, 400);
      }
    }

    if (request.method === "POST" && url.pathname === "/github-read-model/placeholders") {
      try {
        return json(
          await this.githubWebhookReadModelStore.readPlaceholders(
            await request.json().catch(() => null),
          ),
        );
      } catch {
        return json({ error: "invalid_github_webhook_read_model_placeholders_request" }, 400);
      }
    }

    if (request.method === "POST" && url.pathname === "/artifact-cache/receipt/store") {
      const body = await request.json().catch(() => null);
      const now = Date.now();
      try {
        const result = await this.artifactReceiptStore.store(body, now);
        if (!result.ok) return json({ error: result.error }, result.status);
        await this.artifactReceiptStore.prune(now).catch(() => {
          console.warn("artifact_cache_prune_failed");
        });
        return json({ ok: true, deduped: result.deduped, receipt: result.receipt }, 201);
      } catch {
        console.warn("artifact_cache_receipt_store_failed");
        return json({ error: "artifact_cache_unavailable" }, 503);
      }
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
      const now = Date.now();
      const state = this.readStateSync();
      const matches = Object.values(state.items).filter(
        (item) =>
          item.decision.targetRepo === targetRepo && item.decision.itemNumber === itemNumber,
      );
      const items = matches.map((item) => ({
        lane: exactReviewQueueLane(item),
        state: item.state,
        parked_reason: item.parkedReason ?? null,
        parked_recovery_attempts: item.parkedRecoveryAttempts ?? 0,
        backoff_reason:
          item.state === "pending" && item.nextAttemptAt > now
            ? exactReviewQueueBackoffReason(item, state, now)
            : null,
        revision: item.revision,
        attempts: item.attempts,
        dispatch_failure_status: item.dispatchFailureStatus ?? null,
        dispatch_failure_class: item.dispatchFailureClass || null,
        dispatch_failure_at: item.dispatchFailureAt
          ? new Date(item.dispatchFailureAt).toISOString()
          : null,
        dispatch_failure_fingerprint: item.dispatchFailureFingerprint || null,
        dispatch_failure_detail: exactReviewDispatchFailureDetailJson(item.dispatchFailureDetail),
        created_at: new Date(item.createdAt).toISOString(),
        next_attempt_at:
          item.state === "pending" ? new Date(item.nextAttemptAt).toISOString() : null,
        older_ready_count: Object.values(state.items).filter(
          (candidate) =>
            exactReviewQueueLane(candidate) === exactReviewQueueLane(item) &&
            candidate.state === "pending" &&
            candidate.nextAttemptAt <= now &&
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
        const leaseRevision = Number(item.leaseRevision || 0);
        const directLifecycle = exactReviewSavedDirectLifecycle(item);
        const owedDirectLifecycleRequeue =
          run.outcome === "success" &&
          item.revision <= leaseRevision &&
          directLifecycle?.owedRequeue;
        if (owedDirectLifecycleRequeue) {
          this.recordLifecycleTerminal(
            {
              canonicalTargetKey: directLifecycle.canonicalTargetKey,
              fenceKey: item.key,
              revision: leaseRevision,
              kind: "requeue",
            },
            now,
          );
        }
        if (!exactReviewQueueIsPublication(item) && run.outcome !== "success") {
          this.recordReviewFailureAttemptSafely({
            item,
            revision: leaseRevision,
            claimGeneration: run.claimGeneration,
            runId: run.runId,
            runAttempt: run.runAttempt,
            outcome: run.outcome,
            observedAt: now,
          });
        }
        const { requeued: didRequeue, parked } = owedDirectLifecycleRequeue
          ? this.requeueDirectLifecyclePublicationSync(state, item, now)
          : finishExactReviewQueueItem(
              state,
              item,
              now,
              run.outcome,
              0,
              false,
              undefined,
              undefined,
              this.random,
              this.env,
            );
        reconciled += 1;
        if (parked) continue;
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
      return this.statsResponse(url);
    }

    return new Response("not found", { status: 404 });
  }

  private storageChangeCountSync(): number {
    return Number(
      Array.from(
        this.storage.sql.exec("SELECT total_changes() AS changes") as Iterable<{ changes: number }>,
      )[0]?.changes,
    );
  }

  private computeLifecycleBayBody(repositories?: ReadonlySet<string>) {
    return JSON.stringify(
      {
        durable_lifecycle_bay: this.lifecycleProjectionStore.readBaySnapshot(
          Date.now(),
          repositories,
        ),
      },
      null,
      2,
    );
  }

  private async lifecycleBayResponse(url: URL) {
    return cors(
      new Response(await this.lifecycleBayBody(url), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      }),
    );
  }

  private async lifecycleBayBody(url: URL): Promise<string> {
    const publicRepositories = url.searchParams
      .getAll("public_repo")
      .map((value) => value.trim().toLowerCase());
    const valid =
      publicRepositories.length <= 32 &&
      publicRepositories.every((value) => /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(value));
    const repositories = !url.searchParams.has("public_repo")
      ? undefined
      : new Set(valid ? publicRepositories.sort() : []);
    const configured = Number(this.env.EXACT_REVIEW_LIFECYCLE_BAY_CACHE_MS ?? 30_000);
    const ttl = Number.isFinite(configured) && configured >= 0 ? configured : 30_000;
    if (!ttl) {
      this.lifecycleBayCache = null;
      this.lifecycleBayComputations.clear();
      return this.computeLifecycleBayBody(repositories);
    }
    const key = JSON.stringify(repositories ? [...repositories] : null);
    const cached = this.lifecycleBayCache;
    if (cached?.key === key && cached.expiresAt > Date.now()) return cached.body;
    const pending = this.lifecycleBayComputations.get(key);
    if (pending) return pending;

    // Bay accepts TTL-bounded staleness across writes; stats still invalidate.
    const startedAt = Date.now();
    const computation = Promise.resolve().then(() => this.computeLifecycleBayBody(repositories));
    this.lifecycleBayComputations.set(key, computation);
    try {
      const body = await computation;
      // Disabling the memo resets in-flight work without letting it repopulate.
      if (this.lifecycleBayComputations.get(key) === computation)
        this.lifecycleBayCache = { key, expiresAt: startedAt + ttl, body };
      return body;
    } finally {
      if (this.lifecycleBayComputations.get(key) === computation)
        this.lifecycleBayComputations.delete(key);
    }
  }

  private async statsResponse(url: URL) {
    return cors(
      new Response(await this.statsBody(url), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      }),
    );
  }

  private async statsBody(url: URL): Promise<string> {
    const configured = Number(this.env.EXACT_REVIEW_STATS_CACHE_MS ?? 10_000);
    const ttl = Number.isFinite(configured) && configured >= 0 ? configured : 10_000;
    if (!ttl) return this.computeStatsBody(url);
    // These parameters change the private Bay sample, so never share their responses.
    const key = JSON.stringify([
      exactReviewQueueBayPriorityKeys(url.searchParams.getAll("bay_priority_key")),
      exactReviewQueueBayActiveKeys(url.searchParams.getAll("bay_active_key")),
      exactReviewQueueBayActiveKeys(url.searchParams.getAll("bay_active_legacy_key")),
    ]);
    for (;;) {
      const now = Date.now();
      if (this.statsCache) {
        const alarm = await this.storage.getAlarm();
        // Re-read after yielding: another poll may have renewed the memo.
        const cached = this.statsCache;
        if (
          cached &&
          cached.key === key &&
          cached.expiresAt > now &&
          cached.changes === this.storageChangeCountSync() &&
          (alarm === null || alarm > now) &&
          (alarm !== null || this.scheduledAlarmDecision === null)
        )
          return cached.body;
      }
      const changes = this.storageChangeCountSync();
      const generation = this.statsMutationGeneration;
      const pending = this.statsComputation;
      if (
        pending?.key === key &&
        pending.changes === changes &&
        pending.generation === generation
      ) {
        // Wait only to coalesce work; never serve an unvalidated pending body.
        await pending.body;
        continue;
      }
      const computation = {
        key,
        changes,
        generation,
        // Publish the pending slot before computation can invalidate it.
        body: Promise.resolve().then(() => this.computeStatsBody(url)),
      };
      this.statsComputation = computation;
      try {
        const body = await computation.body;
        if (
          this.statsComputation === computation &&
          this.statsMutationGeneration === generation &&
          this.storageChangeCountSync() === changes
        )
          this.statsCache = { key, expiresAt: now + ttl, body, changes };
        return body;
      } finally {
        if (this.statsComputation === computation) this.statsComputation = null;
      }
    }
  }

  private async computeStatsBody(url: URL) {
    const bayPriorityKeys = exactReviewQueueBayPriorityKeys(
      url.searchParams.getAll("bay_priority_key"),
    );
    const bayActiveKeys = exactReviewQueueBayActiveKeys(url.searchParams.getAll("bay_active_key"));
    const bayActiveLegacyKeys = exactReviewQueueBayActiveKeys(
      url.searchParams.getAll("bay_active_legacy_key"),
    );
    const now = Date.now();
    const snapshot = this.storage.transactionSync(() => {
      this.pruneDeliveryReceiptsSync(now);
      this.pruneEditedSemanticInputsSync(now);
      this.pruneQueueTelemetrySync(now);
      this.pruneReviewRunTelemetrySync(now);
      const current = this.readStateSync();
      // Dashboard reads are also the operational heartbeat. Reclaim leases and
      // restore the alarm here so a deploy or lost alarm cannot strand backlog.
      const changed = reclaimExpiredExactReviewLeases(
        current,
        now,
        exactReviewPublicationDispatchLeaseMs(this.env),
        exactReviewHeartbeatGraceMs(this.env),
        this.env,
      );
      if (changed) this.writeStateSync(current);
      else this.syncLegacyCompatibilitySync(current);
      return {
        state: current,
        metrics: this.queueMetricTotalsSync(),
        reviewFlow: this.reviewFlowSummarySync(now),
        reviewFailureHealth: this.reviewFailureHealthSafely(now),
        publicationFlow: this.publicationFlowSummarySync(now),
        deadLetters: this.deadLetterStatsSync(),
        // Full review observability scans up to 10k durable records. Keep it on
        // the diagnostic endpoint so the frequently-polled status path stays bounded.
        stateWriter: this.stateWriterSummarySync(now),
      };
    });
    const {
      state,
      metrics,
      reviewFlow,
      reviewFailureHealth,
      publicationFlow,
      deadLetters,
      stateWriter,
    } = snapshot;
    // Coordinator methods own their SQLite transaction. Keep this adjacent to
    // the queue snapshot without nesting transactionSync calls.
    const stateWriterCoordinator = this.stateWriterCoordinator.stats(
      now,
      stateWriterCoordinatorQueuedStaleMs(this.env),
    );
    const publicationBatches = this.batchStore.stats(now);
    const directPublicationCount = this.directPublicationStore.count();
    const sourceAuthorityReservations = await this.sourceAuthorityReservations();
    const branchAuthorityReservations = await this.branchAuthorityReservations();
    const authorityPendingByOwner = exactReviewAuthorityPendingByOwner([
      ...sourceAuthorityReservations,
      ...branchAuthorityReservations,
    ]);
    const batchByItemKey = new Map<string, ExactReviewBayBatchOwner>(
      publicationBatches.activeItemBatches.map((batch) => [batch.itemKey, batch] as const),
    );
    const batchOwnedItemKeys = new Set<string>(batchByItemKey.keys());
    const freshPublicationItemKeys = this.freshPublicationItemKeysSync(state, now);
    const legacyExcludedItemKeys = new Set(batchOwnedItemKeys);
    if (exactReviewPublicationBatchingEnabled(this.env)) {
      for (const item of Object.values(state.items) as ExactReviewQueueItem[]) {
        if (
          item.state === "pending" &&
          exactReviewQueueIsBatchablePublication(item) &&
          !item.terminalFinalization
        ) {
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
    const publicationHealth = summarizeExactReviewPublicationHealth(
      stats.lanes.publication,
      publicationFlow,
    );
    const reservationClaimObservability = exactReviewReservationClaimObservability({
      now,
      dispatcher: state.dispatcher,
      publication: stats.lanes.publication,
      batches: this.batchStore.observability(now).batches,
      directPublicationEnabled: exactReviewDirectPublicationEnabled(this.env),
      legacyStateRepoBatchEnabled: exactReviewPublicationBatchingEnabled(this.env),
      maxConcurrentBatches: exactReviewPublicationBatchMaxConcurrent(this.env),
    });
    const bayProjection = exactReviewQueueBayProjectionFromStats(
      stats,
      bayPriorityKeys,
      batchByItemKey,
      bayActiveKeys,
      bayActiveLegacyKeys,
    );
    const body = {
      ...stats,
      bay_projection: bayProjection,
      review_failure_health: reviewFailureHealth,
      lanes: {
        review: {
          ...stats.lanes.review,
          enqueued_total: metrics.review.enqueued,
          completed_total: metrics.review.completed,
          superseded_total: metrics.review.superseded,
          semantic_deduped_total: metrics.review.semanticDeduped,
          shed_reasons_since_reset: {
            backpressure: metrics.review.shedBackpressure,
            scheduled_rate: metrics.review.shedScheduledRate,
            unattributed: Math.max(0, exactReviewShedSinceReset(state) - metrics.review.shed),
          },
          authority_pending: {
            total: sourceAuthorityReservations.length + branchAuthorityReservations.length,
            branch_resolution: branchAuthorityReservations.length,
            source_verification: sourceAuthorityReservations.length,
          },
          flow: reviewFlow,
        },
        publication: {
          ...stats.lanes.publication,
          pending: stats.lanes.publication.pending,
          enqueued_total: metrics.publication.enqueued,
          completed_total: metrics.publication.completed,
          published_total: metrics.publication.published,
          superseded_total: metrics.publication.superseded,
          semantic_deduped_total: metrics.publication.semanticDeduped,
          retried_total: metrics.publication.retried,
          dead_lettered_total: metrics.publication.deadLettered,
          refreshed_total: metrics.publication.refreshed,
          flow: publicationFlow,
          dead_letters: deadLetters,
          health: publicationHealth,
          capacity_control: exactReviewPublicationControlStatus(this.env, publicationControl),
          credential_circuits: exactReviewGithubCredentialCircuitStatus(
            state,
            now,
            authorityPendingByOwner,
          ),
          github_request_metrics: {
            updated_at: state.dispatcher?.githubRequestMetrics?.updatedAt
              ? new Date(state.dispatcher.githubRequestMetrics.updatedAt).toISOString()
              : null,
            counters: state.dispatcher?.githubRequestMetrics?.counters || {},
          },
          github_egress_metrics_v2: this.githubEgressTelemetryStore.publicSummary(now),
          batches: {
            enabled: exactReviewPublicationBatchingEnabled(this.env),
            max_items: exactReviewPublicationBatchSize(this.env),
            max_concurrent: exactReviewPublicationBatchMaxConcurrent(this.env),
            max_wait_seconds: exactReviewPublicationBatchWaitMs(this.env) / 1_000,
            fresh_lane: {
              enabled: exactReviewPublicationFreshLaneMaxItems(this.env) > 0,
              reserved_items: exactReviewPublicationFreshLaneMaxItems(this.env),
              max_age_seconds: exactReviewPublicationFreshLaneMaxAgeMs(this.env) / 1_000,
              ready_items: freshPublicationItemKeys.size,
              historical_ready_items: Math.max(
                0,
                stats.lanes.publication.ready - freshPublicationItemKeys.size,
              ),
            },
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
          direct: {
            enabled: exactReviewDirectPublicationEnabled(this.env),
            health: { status: "healthy", store: "durable_object_sqlite" },
            pending: 0,
            retryable: 0,
            failed: 0,
            retained_receipts: directPublicationCount,
            oldest_pending_at: null,
          },
        },
      },
      delivery_receipts: this.deliveryReceiptCountSync(),
      scheduled_feed: this.scheduledReviewFeedStatusSync(now),
      reservation_claim_observability: reservationClaimObservability,
      state_writer: { ...stateWriter, coordinator: stateWriterCoordinator },
      storage_schema_version: EXACT_REVIEW_QUEUE_STORAGE_SCHEMA_VERSION,
      legacy_rollback_available:
        !this.legacyMirrorDisabled && now < this.migratedAt + EXACT_REVIEW_QUEUE_LEGACY_ROLLBACK_MS,
    };
    return JSON.stringify(body, null, 2);
  }

  private readLifecycleAuditInventory(input: unknown) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return json({ error: "invalid_lifecycle_audit_request" }, 400);
    }
    const body = input as Record<string, unknown>;
    const pageSize = body.page_size === undefined ? 50 : Number(body.page_size);
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      return json({ error: "invalid_lifecycle_audit_page_size" }, 400);
    }
    if (body.cursor === undefined) {
      return json({
        exact_review_lifecycle_audit_inventory:
          this.lifecycleProjectionStore.createAuditInventorySnapshot(pageSize),
      });
    }
    const cursor = parseDurableLifecycleAuditCursor(body.cursor);
    if (!cursor) return json({ error: "invalid_lifecycle_audit_cursor" }, 400);
    return json({
      exact_review_lifecycle_audit_inventory: this.lifecycleProjectionStore.readAuditInventoryPage(
        cursor,
        pageSize,
      ),
    });
  }

  private recentDurablePublicationEvents(window: string) {
    const now = Date.now();
    const cached = this.recentDurablePublicationEventsCache.get(window);
    if (cached && cached.expiresAt > now) return cached.value;
    const value = recentDurablePublicationEvents({ storage: this.storage, window, now });
    if (!value) return null;
    // This deliberately has no write-path invalidation: it is a short-lived,
    // best-effort shield for the optional public aggregate, not lifecycle state.
    this.recentDurablePublicationEventsCache.set(window, {
      value,
      expiresAt: now + RECENT_DURABLE_PUBLICATION_EVENTS_CACHE_MS,
    });
    return value;
  }

  private readOperationalCursor(mode: OperationalCursorMode) {
    const stored = readOperationalCursor(this.storage.kv.get(operationalCursorKey(mode)), mode);
    if (stored === "invalid") return json({ error: "fanout_cursor_store_invalid" }, 500);
    return json(operationalCursorJson(stored ?? emptyOperationalCursor(mode)));
  }

  private writeOperationalCursor(mode: OperationalCursorMode, value: unknown) {
    const body = objectValue(value);
    let auditBatch: AuditWaveState | null | undefined;
    try {
      if (body.audit_batch !== undefined) {
        if (mode !== "audit") throw new Error("audit batch requires audit cursor");
        auditBatch = parseAuditWaveState(body.audit_batch);
      }
    } catch {
      return json({ error: "invalid_audit_batch" }, 400);
    }
    const nextCursor = Number(body.next_cursor);
    const expectedRevision = Number(body.expected_revision);
    if (
      !Number.isSafeInteger(nextCursor) ||
      nextCursor < 0 ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0
    ) {
      return json({ error: "invalid_fanout_cursor" }, 400);
    }
    try {
      const result = this.storage.transactionSync(() => {
        const stored = readOperationalCursor(this.storage.kv.get(operationalCursorKey(mode)), mode);
        if (stored === "invalid") return { kind: "invalid" as const };
        const current = stored ?? emptyOperationalCursor(mode);
        if (current.revision !== expectedRevision) {
          return { kind: "conflict" as const, current };
        }
        if (current.revision >= Number.MAX_SAFE_INTEGER) {
          return { kind: "invalid" as const };
        }
        const next: OperationalCursor = {
          mode,
          nextCursor,
          revision: current.revision + 1,
          updatedAt: Date.now(),
          ...(mode === "audit"
            ? { auditBatch: auditBatch === undefined ? (current.auditBatch ?? null) : auditBatch }
            : {}),
        };
        this.storage.kv.put(operationalCursorKey(mode), next);
        return { kind: "written" as const, cursor: next };
      });
      if (result.kind === "invalid") return json({ error: "fanout_cursor_store_invalid" }, 500);
      if (result.kind === "conflict") {
        return json(
          {
            error: "fanout_cursor_revision_conflict",
            current: operationalCursorJson(result.current),
          },
          409,
        );
      }
      return json(operationalCursorJson(result.cursor), 202);
    } catch {
      console.error("fanout_cursor_write_failed");
      return json({ error: "fanout_cursor_store_unavailable" }, 503);
    }
  }

  async alarm() {
    this.invalidateReadCaches();
    try {
      await this.handleAlarm();
    } finally {
      this.invalidateReadCaches();
    }
  }

  private async handleAlarm() {
    await this.ensureReady();
    this.cleanupLegacyCompatibilitySync();
    const startedAt = Date.now();
    const hostedTargetMetadataToken = exactReviewHostedTargetMetadataTokenSource(this.env);
    const newSampleWindow =
      startedAt - this.alarmSampleWindowStartedAt >= EXACT_REVIEW_ALARM_SAMPLE_WINDOW_MS;
    if (newSampleWindow) this.alarmSampleWindowStartedAt = startedAt;
    this.alarmSampleCount = newSampleWindow ? 1 : this.alarmSampleCount + 1;
    if (
      this.alarmSampleCount >= EXACT_REVIEW_ALARM_SAMPLE_THRESHOLD &&
      this.alarmSampleLoggedAt < this.alarmSampleWindowStartedAt
    ) {
      const decision = this.scheduledAlarmDecision;
      console.warn("exact_review_queue_alarm_schedule_sample", {
        alarm_count: this.alarmSampleCount,
        wake_reason: decision?.[0] ?? "unknown",
        scheduled_delay_ms: decision ? Math.max(0, decision[1] - decision[2]) : null,
        alarm_lag_ms: decision ? Math.max(0, startedAt - decision[1]) : null,
        decision_age_ms: decision ? Math.max(0, startedAt - decision[2]) : null,
        bay_pending: decision ? decision[3] : null,
        bay_backoff: decision?.[4] ?? false,
      });
      this.alarmSampleLoggedAt = startedAt;
    }
    await this.storage.deleteAlarm();
    this.scheduledAlarmDecision = null;
    this.reconcileBayTelemetryInternalSync(startedAt);
    await this.processBranchAuthorityReservations(startedAt, hostedTargetMetadataToken);
    await this.processSourceAuthorityReservations(startedAt, hostedTargetMetadataToken);
    await this.processCommandIntakes(startedAt, hostedTargetMetadataToken);
    const pruneBatchItemKeys = new Set<string>(
      this.batchStore.activeLeaseSnapshot(startedAt).itemKeys,
    );
    let snapshot = this.storage.transactionSync(() => {
      this.pruneDeliveryReceiptsSync(startedAt);
      this.commandIntakeStore.pruneTerminalReceipts(startedAt);
      this.directPublicationStore.pruneTerminalSync(startedAt);
      const current = this.readStateSync();
      this.syncLegacyCompatibilitySync(current);
      this.pruneStalePublicationsSync(current, pruneBatchItemKeys);
      return current;
    });
    let snapshotBatchOwnership = this.batchStore.activeLeaseSnapshot(startedAt);
    const reclaimedSnapshot = reclaimExpiredExactReviewLeases(
      snapshot,
      startedAt,
      exactReviewPublicationDispatchLeaseMs(this.env),
      exactReviewHeartbeatGraceMs(this.env),
      this.env,
    );
    const recoveredParkedSnapshot = recoverParkedExactReviewItems(snapshot, startedAt, this.env);
    const expiredSnapshot = expireExactReviewPublicationItems(snapshot, startedAt, this.env);
    let snapshotChanged = reclaimedSnapshot || recoveredParkedSnapshot > 0 || expiredSnapshot;
    if (
      snapshot.dispatcher?.publicationBatchTerminalProbe &&
      Number(snapshot.dispatcher.publicationBatchDispatchPendingUntil || 0) <= startedAt
    ) {
      const dispatcher = { ...snapshot.dispatcher };
      delete dispatcher.publicationBatchTerminalProbe;
      snapshot.dispatcher = dispatcher;
      snapshotChanged = true;
    }
    // Persist early housekeeping and an expired preflight fence before target
    // reads release the input gate. A later workflow must never consume an old
    // terminal probe as though it belonged to its new departure.
    if (snapshotChanged) {
      await this.writeState(snapshot);
    }
    const capacity = exactReviewQueueCapacity(this.env);
    const targetCapacity = exactReviewTargetCapacity(this.env);
    let snapshotPublicationControl = this.refreshPublicationControlSync(snapshot, startedAt);
    let snapshotPublicationCapacity = exactReviewPublicationCapacityForState(
      this.env,
      snapshot,
      startedAt,
      snapshotPublicationControl.capacityCeiling,
      true,
      snapshotPublicationControl.demandCapacity,
    );
    let snapshotHeads = this.publicationHeadsSync(snapshot);
    let snapshotAdmission = exactReviewQueueAdmittedItems(
      snapshot,
      startedAt,
      capacity,
      targetCapacity,
      snapshotPublicationCapacity,
      new Set<string>(snapshotBatchOwnership.itemKeys),
      exactReviewPublicationBatchingEnabled(this.env) || snapshotBatchOwnership.itemKeys.length > 0,
    );
    let snapshotBatchDeparture = exactReviewPublicationBatchDeparture(
      this.env,
      snapshot,
      startedAt,
      new Set(snapshotBatchOwnership.itemKeys),
      snapshotBatchOwnership.activeBatches,
      this.freshPublicationItemKeysSync(snapshot, startedAt, snapshotHeads),
      this.supersededPublicationItemKeysSync(snapshot, snapshotHeads),
    );
    let snapshotBatchCandidates = snapshotBatchDeparture?.due
      ? this.publicationBatchCandidates(
          snapshot,
          startedAt,
          snapshotBatchOwnership,
          snapshotPublicationCapacity,
          MAX_EXACT_REVIEW_PUBLICATION_BATCH_SCAN_SIZE,
          Math.min(
            MAX_EXACT_REVIEW_PUBLICATION_BATCH_SCAN_SIZE,
            exactReviewPublicationBatchSize(this.env),
          ),
        )
      : [];
    let snapshotDispatcherBackoffActive =
      (snapshot.dispatcher?.state === "paused" || snapshot.dispatcher?.state === "blocked") &&
      Number(snapshot.dispatcher?.retryAt || 0) > startedAt;
    let batchTerminalPreflightReady = false;
    if (
      snapshotBatchDeparture?.due &&
      snapshotBatchCandidates.length > 0 &&
      !snapshotDispatcherBackoffActive
    ) {
      const batchTerminalProbe = exactReviewPublicationBatchCandidateProbe(snapshotBatchCandidates);
      await this.terminalizePublicationCandidates(
        snapshotBatchCandidates.map((item) => ({
          key: item.key,
          revision: item.revision,
          decision: item.decision,
        })),
        {},
        hostedTargetMetadataToken,
      );

      // Target reads release the Durable Object input gate. Recompute the
      // departure and admit a workflow only when its exact eventual claim is
      // the selection that was just checked. A concurrent fresh item or owner
      // change gets a new departure and therefore a new probe.
      const recheckedAt = Date.now();
      snapshot = this.readStateSync();
      snapshotHeads = this.publicationHeadsSync(snapshot);
      snapshotBatchOwnership = this.batchStore.activeLeaseSnapshot(recheckedAt);
      snapshotPublicationControl = this.refreshPublicationControlSync(snapshot, recheckedAt);
      snapshotPublicationCapacity = exactReviewPublicationCapacityForState(
        this.env,
        snapshot,
        recheckedAt,
        snapshotPublicationControl.capacityCeiling,
        true,
        snapshotPublicationControl.demandCapacity,
      );
      snapshotAdmission = exactReviewQueueAdmittedItems(
        snapshot,
        recheckedAt,
        capacity,
        targetCapacity,
        snapshotPublicationCapacity,
        new Set<string>(snapshotBatchOwnership.itemKeys),
        exactReviewPublicationBatchingEnabled(this.env) ||
          snapshotBatchOwnership.itemKeys.length > 0,
      );
      snapshotBatchDeparture = exactReviewPublicationBatchDeparture(
        this.env,
        snapshot,
        recheckedAt,
        new Set(snapshotBatchOwnership.itemKeys),
        snapshotBatchOwnership.activeBatches,
        this.freshPublicationItemKeysSync(snapshot, recheckedAt, snapshotHeads),
        this.supersededPublicationItemKeysSync(snapshot, snapshotHeads),
      );
      snapshotBatchCandidates = snapshotBatchDeparture?.due
        ? this.publicationBatchCandidates(
            snapshot,
            recheckedAt,
            snapshotBatchOwnership,
            snapshotPublicationCapacity,
            MAX_EXACT_REVIEW_PUBLICATION_BATCH_SCAN_SIZE,
            Math.min(
              MAX_EXACT_REVIEW_PUBLICATION_BATCH_SCAN_SIZE,
              exactReviewPublicationBatchSize(this.env),
            ),
          )
        : [];
      snapshotDispatcherBackoffActive =
        (snapshot.dispatcher?.state === "paused" || snapshot.dispatcher?.state === "blocked") &&
        Number(snapshot.dispatcher?.retryAt || 0) > recheckedAt;
      batchTerminalPreflightReady =
        snapshotBatchDeparture?.due === true &&
        snapshotBatchCandidates.length > 0 &&
        !snapshotDispatcherBackoffActive &&
        exactReviewPublicationBatchCandidateProbe(snapshotBatchCandidates) === batchTerminalProbe;
    }
    let batchDispatchAttempted = false;
    let batchDispatchSucceeded = false;
    let batchDispatchRecordedAt: number | undefined;
    let batchDispatchId: string | undefined;
    if (snapshotBatchDeparture?.due && batchTerminalPreflightReady) {
      batchDispatchAttempted = true;
      batchDispatchRecordedAt = Date.now();
      batchDispatchId = `publication-batch-dispatch:${crypto.randomUUID()}`;
      const reserved = snapshot;
      const reservedDispatcher = reserved.dispatcher ?? {
        state: "unknown",
        checkedAt: startedAt,
      };
      reserved.dispatcher = {
        ...reservedDispatcher,
        publicationBatchDispatchId: batchDispatchId,
        publicationBatchDispatchedAt: batchDispatchRecordedAt,
        publicationBatchDispatchSucceeded: undefined,
        publicationBatchDispatchPendingUntil:
          batchDispatchRecordedAt + exactReviewPublicationBatchDispatchReservationMs(this.env),
        publicationBatchTerminalProbe:
          exactReviewPublicationBatchCandidateProbe(snapshotBatchCandidates),
      };
      await this.writeState(reserved);
      try {
        const token = await exactReviewDispatchToken(this.env);
        await dispatchExactReviewBatchWorkflow({
          env: this.env,
          token,
          dispatchId: batchDispatchId,
          dispatchedAt: new Date(batchDispatchRecordedAt).toISOString(),
        });
        batchDispatchSucceeded = true;
      } catch (error) {
        console.warn("exact-review batch workflow dispatch failed", {
          event: "batch_workflow_dispatch_failed",
          category: exactReviewDispatchFailure(error).failureClass,
        });
      }
      // The dispatch await releases the input gate. Update only our attempt and
      // preserve a claim that already consumed its pending reservation.
      const current = this.readStateSync();
      if (current.dispatcher?.publicationBatchDispatchedAt === batchDispatchRecordedAt) {
        const dispatcher = { ...current.dispatcher };
        dispatcher.publicationBatchDispatchSucceeded = batchDispatchSucceeded;
        if (!batchDispatchSucceeded) {
          delete dispatcher.publicationBatchDispatchPendingUntil;
          delete dispatcher.publicationBatchTerminalProbe;
        }
        current.dispatcher = dispatcher;
        reclaimExpiredExactReviewLeases(
          current,
          Date.now(),
          exactReviewPublicationDispatchLeaseMs(this.env),
          exactReviewHeartbeatGraceMs(this.env),
          this.env,
        );
        expireExactReviewPublicationItems(current, Date.now(), this.env);
        await this.writeState(current);
      }
    }
    if (!snapshotAdmission.length && !exactReviewDueParkedTerminalItem(snapshot, startedAt)) {
      const current = batchDispatchAttempted ? this.readStateSync() : snapshot;
      await this.scheduleNext(current, Date.now());
      return;
    }
    const snapshotReviewAdmissionNextAt = Number(snapshot.dispatcher?.reviewAdmissionNextAt || 0);
    if (
      snapshotReviewAdmissionNextAt > startedAt &&
      snapshotAdmission.some((item) => !exactReviewQueueIsPublication(item)) &&
      !snapshotAdmission.some(exactReviewQueueIsPublication)
    ) {
      await this.scheduleNext(batchDispatchAttempted ? this.readStateSync() : snapshot, startedAt);
      return;
    }

    let preflight: { ok: true; token: string; workflowState: string } | { ok: false } = {
      ok: false,
    };
    try {
      const token = await exactReviewDispatchToken(this.env);
      preflight = {
        ok: true,
        token,
        workflowState: await exactReviewWorkflowState(token, this.env),
      };
    } catch {
      preflight = { ok: false };
    }

    // External fetches release the Durable Object input gate. Re-read before any
    // write so concurrent enqueue, claim, or complete requests cannot be lost.
    const now = Date.now();
    const state = this.readStateSync();
    // Do not rely on reading back the marker written before preflight. Carry the
    // current alarm's dispatch result only while it still owns that marker: a
    // batch claim may clear its pending reservation while later external reads
    // release the Durable Object input gate.
    const batchDispatcherFieldsFor = (dispatcher: ExactReviewQueueState["dispatcher"]) => {
      const persisted = exactReviewBatchDispatcherFields(dispatcher);
      return batchDispatchRecordedAt !== undefined &&
        dispatcher?.publicationBatchDispatchedAt === batchDispatchRecordedAt
        ? {
            ...persisted,
            publicationBatchDispatchId: batchDispatchId,
            publicationBatchDispatchedAt: batchDispatchRecordedAt,
            publicationBatchDispatchSucceeded: batchDispatchSucceeded,
          }
        : persisted;
    };
    const batchDispatcherFields = batchDispatcherFieldsFor(state.dispatcher);
    const batchOwnership = this.batchStore.activeLeaseSnapshot(now);
    const reclaimed = reclaimExpiredExactReviewLeases(
      state,
      now,
      exactReviewPublicationDispatchLeaseMs(this.env),
      exactReviewHeartbeatGraceMs(this.env),
      this.env,
    );
    const expired = expireExactReviewPublicationItems(state, now, this.env);
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
      false,
      this.freshPublicationItemKeysSync(state, now),
      exactReviewPublicationFreshLaneMaxItems(this.env),
    );
    const reviewAdmissionNextAt = Number(state.dispatcher?.reviewAdmissionNextAt || 0);
    const admission =
      reviewAdmissionNextAt > now ? admitted.filter(exactReviewQueueIsPublication) : admitted;
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

    // Keep any local lease reclamation or publication recovery before the
    // live lookup: its awaits release the input gate, so the re-read below
    // must start from this alarm's housekeeping result.
    if (reclaimed || expired) await this.writeState(state);

    // A queued review can become terminal before it has a worker. Probe only
    // the bounded admission set, then revalidate the exact pending revision
    // after the external reads release the Durable Object input gate.
    // Keep a short durable admission interval as well as a bounded pass. This
    // prevents a ready backlog from turning the one-second alarm wake-up into
    // repeated App-token, item-read, and workflow-dispatch bursts.
    const reviewCandidates = admission
      .filter((item) => !exactReviewQueueIsPublication(item))
      .map((item) => ({
        key: item.key,
        revision: item.revision,
        decision: item.decision,
        queueState: "pending" as const,
      }));
    const parkedCandidate = exactReviewDueParkedTerminalItem(state, now);
    const parkedCandidates = parkedCandidate
      ? [
          {
            key: parkedCandidate.key,
            revision: parkedCandidate.revision,
            decision: parkedCandidate.decision,
            queueState: "parked" as const,
          },
        ]
      : [];
    const parkedTerminalCheckedAt = parkedCandidates.length
      ? now
      : state.dispatcher?.parkedTerminalCheckedAt;
    const pendingLiveLimit = Math.max(
      0,
      EXACT_REVIEW_ADMISSION_LIVE_CHECK_MAX_ITEMS - parkedCandidates.length,
    );
    const liveCandidates = [...reviewCandidates.slice(0, pendingLiveLimit), ...parkedCandidates];
    // The legacy lane can admit more publications than the bounded review
    // probe. Check its entire dispatch set, not a prefix, so neither ordinary
    // work nor a finalizer can bypass a target visibility transition.
    const publicationCandidates = admission.filter(exactReviewQueueIsPublication).map((item) => ({
      key: item.key,
      revision: item.revision,
      decision: item.decision,
      terminalFinalization: Boolean(item.terminalFinalization),
    }));
    const initialTargetAdmissions = await this.hostedTargetAdmissions(
      [...liveCandidates, ...publicationCandidates].map((item) => item.decision.targetRepo),
      hostedTargetMetadataToken,
    );
    const targetTokens = new Map<string, Promise<string>>();
    const targetTokenFor = (targetRepo: string) => {
      let token = targetTokens.get(targetRepo);
      if (!token) {
        token = exactReviewTargetReadToken(this.env, targetRepo);
        targetTokens.set(targetRepo, token);
      }
      return token;
    };
    const liveStates = await mapWithConcurrency(
      liveCandidates,
      EXACT_REVIEW_ADMISSION_LIVE_CHECK_CONCURRENCY,
      async (candidate) => {
        if (initialTargetAdmissions.get(candidate.decision.targetRepo)?.outcome !== "public") {
          return { ...candidate, state: { state: "unavailable" as const } };
        }
        try {
          const token = await targetTokenFor(candidate.decision.targetRepo);
          return {
            ...candidate,
            state: await exactReviewTargetItemState(token, candidate.decision, this.env),
          };
        } catch (error) {
          const failure = exactReviewAdmissionFailure(error);
          console.warn("exact-review admission target check failed", {
            event: "admission_target_check_failed",
            category: failure.failureClass,
          });
          return { ...candidate, state: { state: "unavailable" as const }, failure };
        }
      },
    );
    const livePublicationStates = await mapWithConcurrency(
      publicationCandidates,
      EXACT_REVIEW_ADMISSION_LIVE_CHECK_CONCURRENCY,
      async (candidate) => {
        if (initialTargetAdmissions.get(candidate.decision.targetRepo)?.outcome !== "public") {
          return { ...candidate, state: { state: "unavailable" as const } };
        }
        // Finalizers carry no target work. Their second public admission is
        // sufficient until the fenced workflow mints its write credential.
        if (candidate.terminalFinalization) {
          return { ...candidate, state: { state: "unavailable" as const } };
        }
        try {
          const token = await targetTokenFor(candidate.decision.targetRepo);
          return {
            ...candidate,
            state: await exactReviewTargetItemState(token, candidate.decision, this.env),
          };
        } catch (error) {
          // Do not convert a target-read failure into a terminal result or a
          // new retry class. Publication delivery retains its established path.
          console.warn("exact-review publication terminal check failed", {
            event: "publication_terminal_check_failed",
            category: exactReviewDispatchFailure(error).failureClass,
          });
          return { ...candidate, state: { state: "unavailable" as const } };
        }
      },
    );
    const dispatchTargetAdmissions = await this.hostedTargetAdmissions(
      [...initialTargetAdmissions]
        .filter(([, result]) => result.outcome === "public")
        .map(([targetRepo]) => targetRepo),
      hostedTargetMetadataToken,
    );

    const checkedAt = Date.now();
    const liveStateByCandidate = new Map(liveStates.map((candidate) => [candidate.key, candidate]));
    const livePublicationStateByCandidate = new Map(
      livePublicationStates.map((candidate) => [candidate.key, candidate]),
    );
    const checkedState = this.readStateSync();
    const checkedBatchOwnership = this.batchStore.activeLeaseSnapshot(checkedAt);
    const checkedBatchDispatcherFields = batchDispatcherFieldsFor(checkedState.dispatcher);
    const priorDispatchConsecutiveFailures = Number(
      checkedState.dispatcher?.dispatchConsecutiveFailures || 0,
    );
    // Parked reconciliation is optional maintenance. Its target-read failure
    // must not block otherwise healthy pending review admission.
    let globalAdmissionFailure: ExactReviewDispatchFailure | null = null;
    for (const candidate of liveStates) {
      if (
        candidate.queueState !== "pending" ||
        candidate.state.state !== "unavailable" ||
        !("failure" in candidate) ||
        dispatchTargetAdmissions.get(candidate.decision.targetRepo)?.outcome !== "public" ||
        candidate.failure.scope !== "global"
      ) {
        continue;
      }
      globalAdmissionFailure = candidate.failure;
      break;
    }
    let terminalCompleted = 0;
    const supersessionAudits: ExactReviewSupersessionAudit[] = [];
    for (const candidate of liveStates) {
      const item = checkedState.items[candidate.key];
      if (
        !item ||
        item.revision !== candidate.revision ||
        item.state !== candidate.queueState ||
        exactReviewQueueIsPublication(item)
      ) {
        continue;
      }
      const targetAdmission =
        initialTargetAdmissions.get(item.decision.targetRepo)?.outcome === "public"
          ? dispatchTargetAdmissions.get(item.decision.targetRepo)
          : initialTargetAdmissions.get(item.decision.targetRepo);
      if (targetAdmission?.outcome === "terminal") {
        this.terminalizeHostedTargetQueueItem(checkedState, item, checkedAt);
        terminalCompleted += 1;
        continue;
      }
      if (targetAdmission?.outcome === "retryable") {
        if (item.state === "parked") {
          item.parkedTerminalCheckedAt = checkedAt;
        } else {
          item.nextAttemptAt = Math.max(
            item.nextAttemptAt,
            targetAdmission.retryAt ?? checkedAt + EXACT_REVIEW_ADMISSION_INTERVAL_MS,
          );
          item.backoffReason = "admission_retry";
        }
        item.updatedAt = checkedAt;
        continue;
      }
      if (candidate.state.state === "terminal" && !exactReviewQueueHasCommandContext(item)) {
        delete checkedState.items[item.key];
        terminalCompleted += 1;
        continue;
      }
      if (exactReviewQueueHasStaleLiveHead(item, candidate.state)) {
        const audit: ExactReviewSupersessionAudit = {
          auditId: crypto.randomUUID(),
          itemKey: item.key,
          priorRevision: item.revision,
          nextRevision: item.revision + 1,
          supersededLeaseId: null,
          supersededRunId: null,
          supersededRunAttempt: null,
          supersededClaimGeneration: null,
          supersededProtocolVersion: null,
          sourceAction: item.decision.sourceAction,
          reasonCode: "live_head_advanced",
          supersededAt: checkedAt,
        };
        if (exactReviewQueueHasCommandContext(item)) {
          // A command/status receipt is independently meaningful. Advance it to
          // the authoritative current head rather than dispatching its stale
          // source tuple or dropping the acknowledgement lifecycle.
          item.decision = exactReviewDecisionAtLiveHead(item.decision, candidate.state.headSha);
          item.revision += 1;
          item.updatedAt = checkedAt;
          Object.assign(item, exactReviewQueueEnqueueAttempt(checkedState, checkedAt));
          item.parkedReason = undefined;
          item.parkedRecoveryAttempts = 0;
          item.attempts = 0;
          item.publicationFailureAttempts = 0;
          item.reviewFailureAttempts = 0;
          item.reviewRetryPolicyEpoch = exactReviewRetryPolicyEpoch(this.env);
          item.firstFailureAt = undefined;
          item.lastFailureReason = undefined;
          clearExactReviewDispatchFailure(item);
          clearExactReviewReviewRecovery(item);
        } else {
          delete checkedState.items[item.key];
          terminalCompleted += 1;
        }
        supersessionAudits.push(audit);
        continue;
      }
      if (candidate.state.state === "unavailable") {
        if (item.state === "parked") {
          // A permanently exhausted item is only being checked for terminal
          // cleanup. A failed read must neither revive it nor spend another
          // review retry budget; defer the next bounded observation instead.
          item.parkedTerminalCheckedAt = checkedAt;
          item.updatedAt = checkedAt;
          continue;
        }
        // A shared GitHub or credential failure must not consume each item's
        // retry budget. The dispatcher backoff below holds the whole admission
        // pass until that dependency recovers.
        if (globalAdmissionFailure) continue;
        const activeRetryPolicyEpoch = exactReviewRetryPolicyEpoch(this.env);
        if (
          (item.reviewRetryPolicyEpoch || DEFAULT_EXACT_REVIEW_RETRY_POLICY_EPOCH) !==
          activeRetryPolicyEpoch
        ) {
          item.attempts = 0;
          item.reviewFailureAttempts = 0;
          item.parkedRecoveryAttempts = 0;
          clearExactReviewReviewRecovery(item);
        }
        item.attempts += 1;
        const failureAttempts = Number(item.reviewFailureAttempts || 0) + 1;
        item.reviewFailureAttempts = failureAttempts;
        item.reviewRetryPolicyEpoch = activeRetryPolicyEpoch;
        if (failureAttempts >= EXACT_REVIEW_RETRY_LIMIT) {
          parkRecoverableExactReviewItem(item, "review_retry_exhausted", checkedAt, this.random);
          continue;
        }
        item.nextAttemptAt = Math.max(
          exactReviewQueueEnqueueAttemptAt(checkedState, checkedAt),
          checkedAt + exactReviewRetryDelayMs(item.attempts),
        );
        item.backoffReason =
          exactReviewQueueEnqueueAttemptAt(checkedState, checkedAt) >= item.nextAttemptAt
            ? "dispatcher_backoff"
            : "admission_retry";
        item.updatedAt = checkedAt;
        continue;
      }
      if (item.state === "parked") {
        item.parkedTerminalCheckedAt = checkedAt;
        item.updatedAt = checkedAt;
      }
    }
    let terminalPublications = 0;
    for (const candidate of livePublicationStates) {
      const item = checkedState.items[candidate.key];
      if (
        !item ||
        item.revision !== candidate.revision ||
        item.state !== "pending" ||
        !exactReviewQueueIsPublication(item) ||
        checkedBatchOwnership.itemKeys.includes(item.key)
      ) {
        continue;
      }
      const targetAdmission =
        initialTargetAdmissions.get(item.decision.targetRepo)?.outcome === "public"
          ? dispatchTargetAdmissions.get(item.decision.targetRepo)
          : initialTargetAdmissions.get(item.decision.targetRepo);
      if (targetAdmission?.outcome === "terminal") {
        this.terminalizeHostedTargetQueueItem(checkedState, item, checkedAt);
        terminalPublications += 1;
        continue;
      }
      if (targetAdmission?.outcome === "retryable") {
        item.nextAttemptAt = Math.max(
          item.nextAttemptAt,
          targetAdmission.retryAt ?? checkedAt + EXACT_REVIEW_ADMISSION_INTERVAL_MS,
        );
        item.backoffReason = "admission_retry";
        item.updatedAt = checkedAt;
        continue;
      }
      if (candidate.state.state === "terminal") {
        delete checkedState.items[item.key];
        terminalPublications += 1;
      }
    }
    if (globalAdmissionFailure) {
      const consecutiveFailures = priorDispatchConsecutiveFailures + 1;
      const retryAt =
        checkedAt +
        exactReviewDispatchGlobalRetryDelayMs(consecutiveFailures, globalAdmissionFailure);
      checkedState.dispatcher = {
        state: "blocked",
        reason: exactReviewDispatchDispatcherReason(globalAdmissionFailure.failureClass),
        workflowState: preflight.workflowState,
        checkedAt,
        retryAt,
        dispatchFailureStatus: globalAdmissionFailure.status,
        dispatchFailureClass: globalAdmissionFailure.failureClass,
        dispatchFailureAt: checkedAt,
        dispatchFailureFingerprint: globalAdmissionFailure.fingerprint,
        dispatchConsecutiveFailures: consecutiveFailures,
        ...checkedBatchDispatcherFields,
        ...(parkedTerminalCheckedAt ? { parkedTerminalCheckedAt } : {}),
      };
      await this.writeState(
        checkedState,
        terminalCompleted || terminalPublications || supersessionAudits.length
          ? {
              reviewCompleted: terminalCompleted,
              reviewSuperseded: supersessionAudits.length,
              publicationCompleted: terminalPublications,
              publicationSuperseded: terminalPublications,
            }
          : undefined,
        undefined,
        undefined,
        supersessionAudits,
      );
      await this.scheduleNext(checkedState, checkedAt);
      return;
    }
    const dispatchable = admission.flatMap((candidate) => {
      const item = checkedState.items[candidate.key];
      if (!item || item.revision !== candidate.revision || item.state !== "pending") return [];
      if (exactReviewQueueIsPublication(item)) {
        // A committed finalizer holds no review/publication work, but it still
        // requires the same current public admission before target credentials.
        if (item.terminalFinalization) {
          return dispatchTargetAdmissions.get(item.decision.targetRepo)?.outcome === "public"
            ? [item]
            : [];
        }
        if (checkedBatchOwnership.itemKeys.includes(item.key)) return [];
        if (dispatchTargetAdmissions.get(item.decision.targetRepo)?.outcome !== "public") {
          return [];
        }
        const livePublication = livePublicationStateByCandidate.get(candidate.key);
        return !livePublication || livePublication.state.state !== "terminal" ? [item] : [];
      }
      const live = liveStateByCandidate.get(candidate.key);
      // A command acknowledgement needs the workflow's terminal completion
      // path even when the target is already closed. Unprobed reviews wait for
      // a later bounded admission pass instead of bypassing the live check.
      return dispatchTargetAdmissions.get(item.decision.targetRepo)?.outcome === "public" &&
        (live?.state.state === "open" ||
          (live?.state.state === "terminal" && exactReviewQueueHasCommandContext(item)))
        ? [item]
        : [];
    });

    const hasReadyPendingReview = Object.values(checkedState.items).some(
      (item) =>
        !exactReviewQueueIsPublication(item) &&
        item.state === "pending" &&
        item.nextAttemptAt <= checkedAt,
    );
    const shouldThrottleReviewAdmission =
      liveCandidates.length === EXACT_REVIEW_ADMISSION_LIVE_CHECK_MAX_ITEMS ||
      (terminalCompleted > 0 && hasReadyPendingReview);
    const nextReviewAdmissionAt = shouldThrottleReviewAdmission
      ? checkedAt + EXACT_REVIEW_ADMISSION_INTERVAL_MS
      : Number(checkedState.dispatcher?.reviewAdmissionNextAt || 0);
    checkedState.dispatcher = {
      state: "active",
      workflowState: preflight.workflowState,
      checkedAt,
      ...(nextReviewAdmissionAt > checkedAt
        ? { reviewAdmissionNextAt: nextReviewAdmissionAt }
        : {}),
      ...checkedBatchDispatcherFields,
      ...(parkedTerminalCheckedAt ? { parkedTerminalCheckedAt } : {}),
    };
    for (const item of dispatchable) {
      item.state = "dispatching";
      item.leaseId = crypto.randomUUID();
      item.leaseRevision = item.revision;
      item.leaseDecision = { ...item.decision };
      item.leaseExpiresAt =
        checkedAt +
        (item.decision.sourceAction === EXACT_REVIEW_ARTIFACT_PUBLISH_SOURCE_ACTION
          ? exactReviewPublicationDispatchLeaseMs(this.env)
          : exactReviewDispatchLeaseMs(this.env));
      item.claimedRunId = undefined;
      item.claimedRunAttempt = undefined;
      item.claimGeneration = undefined;
      item.dispatchedAt = checkedAt;
      item.claimedAt = undefined;
      item.updatedAt = checkedAt;
    }
    await this.writeState(
      checkedState,
      terminalCompleted || terminalPublications || supersessionAudits.length
        ? {
            reviewCompleted: terminalCompleted,
            reviewSuperseded: supersessionAudits.length,
            publicationCompleted: terminalPublications,
            publicationSuperseded: terminalPublications,
          }
        : undefined,
      undefined,
      undefined,
      supersessionAudits,
    );
    if (!dispatchable.length) {
      await this.scheduleNext(checkedState, checkedAt);
      return;
    }

    const failures: Array<{
      key: string;
      leaseId: string;
      failure: ExactReviewDispatchFailure;
      attempted: boolean;
    }> = [];
    let globalFailure: ExactReviewDispatchFailure | null = null;
    for (const item of dispatchable) {
      if (globalFailure) {
        failures.push({
          key: item.key,
          leaseId: String(item.leaseId || ""),
          failure: globalFailure,
          attempted: false,
        });
        continue;
      }
      try {
        await dispatchClawsweeperItem({
          env: this.env,
          token: preflight.token,
          decision: item.leaseDecision || item.decision,
          itemKey: item.key,
          leaseId: item.leaseId,
          leaseRevision: item.leaseRevision,
          terminalFinalization: item.terminalFinalization,
        });
      } catch (error) {
        const failure = exactReviewDispatchFailure(error);
        failures.push({
          key: item.key,
          leaseId: String(item.leaseId || ""),
          failure,
          attempted: true,
        });
        if (failure.scope === "global") globalFailure = failure;
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
      if (failure.attempted) {
        item.dispatchFailureStatus = failure.failure.status;
        item.dispatchFailureClass = failure.failure.failureClass;
        item.dispatchFailureAt = completedAt;
        item.dispatchFailureFingerprint = failure.failure.fingerprint;
        item.dispatchFailureDetail = failure.failure.detail;
      }
      if (item.terminalFinalization) {
        // Finalizer-only dispatches must never be parked or sent through the
        // ordinary publication recovery/dead-letter machinery: their sole
        // durable job is the already-committed fenced acknowledgement.
        item.state = "pending";
        item.parkedReason = undefined;
        item.nextAttemptAt =
          completedAt +
          exactReviewDispatchGlobalRetryDelayMs(
            Math.max(1, Number(item.attempts || 0) + 1),
            failure.failure,
          );
        item.backoffReason = "publication_retry";
        item.attempts = Number(item.attempts || 0) + 1;
      } else if (failure.attempted && failure.failure.scope === "item") {
        item.reviewRetryPolicyEpoch = exactReviewRetryPolicyEpoch(this.env);
        parkRecoverableExactReviewItem(item, "dispatch_rejected", completedAt, this.random);
      } else {
        item.state = "pending";
        item.nextAttemptAt = completedAt;
        item.backoffReason = undefined;
      }
      item.updatedAt = completedAt;
      currentChanged = true;
    }
    if (globalFailure) {
      const currentBatchDispatcherFields = batchDispatcherFieldsFor(current.dispatcher);
      const consecutiveFailures = priorDispatchConsecutiveFailures + 1;
      const retryAt =
        completedAt + exactReviewDispatchGlobalRetryDelayMs(consecutiveFailures, globalFailure);
      current.dispatcher = {
        state: "blocked",
        reason: exactReviewDispatchDispatcherReason(globalFailure.failureClass),
        workflowState: preflight.workflowState,
        checkedAt: completedAt,
        retryAt,
        dispatchFailureStatus: globalFailure.status,
        dispatchFailureClass: globalFailure.failureClass,
        dispatchFailureAt: completedAt,
        dispatchFailureFingerprint: globalFailure.fingerprint,
        dispatchFailureDetail: globalFailure.detail,
        dispatchConsecutiveFailures: consecutiveFailures,
        ...currentBatchDispatcherFields,
      };
      currentChanged = true;
    }
    if (currentChanged) await this.writeState(current);
    await this.scheduleNext(current, completedAt);
  }

  private ensureReady() {
    if (this.ready) return this.ready;
    const initialize = () =>
      this.initializeStorage().catch((error) => rethrowQueueFailure(error, "initialize"));
    this.ready =
      typeof this.state.blockConcurrencyWhile === "function"
        ? Promise.resolve(this.state.blockConcurrencyWhile(initialize))
        : initialize();
    return this.ready;
  }

  private async terminalizePublicationCandidates(
    candidates: Array<Pick<ExactReviewQueueItem, "key" | "revision" | "decision">>,
    options: { apply?: boolean; legacyReconciliation?: "v1" | "state_batch_v2" } = {},
    hostedTargetMetadataToken = exactReviewHostedTargetMetadataTokenSource(this.env),
  ) {
    const ordinaryCandidates = candidates.filter(
      (item) => !exactReviewQueueHasCommandContext(item),
    );
    if (!ordinaryCandidates.length) return [];

    const targetAdmissions = await this.hostedTargetAdmissions(
      ordinaryCandidates.map((item) => item.decision.targetRepo),
      hostedTargetMetadataToken,
    );
    const targetTokens = new Map<string, Promise<string>>();
    const targetTokenFor = (targetRepo: string) => {
      let token = targetTokens.get(targetRepo);
      if (!token) {
        token = exactReviewTargetReadToken(this.env, targetRepo);
        targetTokens.set(targetRepo, token);
      }
      return token;
    };
    const liveStates = await mapWithConcurrency(
      ordinaryCandidates,
      EXACT_REVIEW_ADMISSION_LIVE_CHECK_CONCURRENCY,
      async (candidate) => {
        const hostedAdmission = targetAdmissions.get(candidate.decision.targetRepo);
        if (hostedAdmission?.outcome !== "public") {
          return {
            ...candidate,
            hostedAdmission,
            state: { state: "unavailable" as const },
          };
        }
        try {
          const token = await targetTokenFor(candidate.decision.targetRepo);
          return {
            ...candidate,
            hostedAdmission,
            state: await exactReviewTargetItemState(token, candidate.decision, this.env),
          };
        } catch (error) {
          // Keep the established publication behavior on a target-read failure:
          // retain the item for its normal delivery/retry path rather than
          // treating a temporary lookup problem as a terminal result.
          console.warn("exact-review publication terminal check failed", {
            event: "publication_terminal_check_failed",
            category: exactReviewDispatchFailure(error).failureClass,
          });
          return { ...candidate, hostedAdmission, state: { state: "unavailable" as const } };
        }
      },
    );

    const checkedAt = Date.now();
    const checkedState = this.readStateSync();
    const batchOwnership = this.batchStore.activeLeaseSnapshot(checkedAt);
    const checkedBatchItemKeys = new Set<string>(batchOwnership.itemKeys);
    if (options.legacyReconciliation) {
      for (const candidate of liveStates) {
        if (candidate.state.state !== "terminal") continue;
        const item = checkedState.items[candidate.key];
        if (!item) continue;
        reclaimExpiredExactReviewLease(
          checkedState,
          item.key,
          item,
          checkedAt,
          exactReviewPublicationDispatchLeaseMs(this.env),
          exactReviewHeartbeatGraceMs(this.env),
          this.env,
        );
      }
    }
    const legacyAuthorityByTarget =
      options.legacyReconciliation === "v1"
        ? exactReviewLegacyPublicationAuthorityIndex(checkedState, checkedBatchItemKeys)
        : null;
    const legacyStateBatchAuthorityByTarget =
      options.legacyReconciliation === "state_batch_v2"
        ? exactReviewLegacyStateBatchPublicationAuthorityIndex(checkedState, checkedBatchItemKeys)
        : null;
    const completedKeys: string[] = [];
    for (const candidate of liveStates) {
      const item = checkedState.items[candidate.key];
      if (
        !item ||
        item.revision !== candidate.revision ||
        (item.state !== "pending" && (!options.legacyReconciliation || item.state !== "parked")) ||
        !exactReviewQueueIsPublication(item) ||
        item.terminalFinalization ||
        exactReviewQueueHasCommandContext(item) ||
        batchOwnership.itemKeys.includes(item.key) ||
        (options.legacyReconciliation === "v1" &&
          !exactReviewLegacyTerminalPublicationCandidate(item, legacyAuthorityByTarget!)) ||
        (options.legacyReconciliation === "state_batch_v2" &&
          !exactReviewLegacyStateBatchTerminalPublicationCandidate(
            item,
            legacyStateBatchAuthorityByTarget!,
            this.publicationHeadRevisionSync(item.decision.publication!.itemKey.toLowerCase()),
          )) ||
        (candidate.hostedAdmission?.outcome !== "terminal" && candidate.state.state !== "terminal")
      ) {
        continue;
      }
      if (candidate.hostedAdmission?.outcome === "terminal") {
        this.recordHostedTargetTerminal(item, checkedAt);
      }
      delete checkedState.items[item.key];
      completedKeys.push(item.key);
    }
    if (options.apply !== false && completedKeys.length) {
      await this.writeState(checkedState, {
        publicationCompleted: completedKeys.length,
        publicationSuperseded: completedKeys.length,
      });
    }
    return completedKeys;
  }

  private async completedLegacyStateBatchPublicationCandidates<
    T extends Pick<ExactReviewQueueItem, "key" | "revision" | "decision">,
  >(candidates: T[]): Promise<T[]> {
    if (!candidates.length) return [];
    let token: string;
    try {
      token = await exactReviewActionsReadToken(this.env);
    } catch (error) {
      console.warn("exact-review legacy state-batch reconciliation could not read producer runs", {
        event: "legacy_state_batch_token_read_failed",
        category: exactReviewDispatchFailure(error).failureClass,
      });
      return [];
    }
    const checked = await mapWithConcurrency(
      candidates,
      EXACT_REVIEW_RECONCILE_CONCURRENCY,
      async (candidate) => {
        const publication = candidate.decision.publication;
        if (!publication) return null;
        try {
          const terminal = await exactReviewTerminalRun(
            token,
            {
              runId: publication.producerRunId,
              runAttempt: publication.producerRunAttempt,
              claimGeneration: publication.claimGeneration ?? 0,
            },
            this.env,
          );
          // A terminal target makes this ordinary delivery unnecessary, but do
          // not race an in-flight or failed producer lifecycle. A later bounded
          // pass can retry a temporarily unavailable run lookup.
          return terminal?.outcome === "success" ? candidate : null;
        } catch (error) {
          console.warn("exact-review legacy state-batch producer check failed", {
            event: "legacy_state_batch_producer_check_failed",
            category: exactReviewDispatchFailure(error).failureClass,
          });
          return null;
        }
      },
    );
    return checked.filter((candidate): candidate is T => candidate !== null);
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
        item.parkedRecoveryAttempts = 0;
        item.backoffReason = undefined;
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
    const guarded =
      body.inventory_fingerprint !== undefined ||
      body.recovery_aliases !== undefined ||
      body.recovery_targets !== undefined;
    const expectedInventory = String(body.inventory_fingerprint || "");
    const recoveryAliases = exactReviewRecoveryAliases(body.recovery_aliases, ids);
    const recoveryTargets = exactReviewRecoveryTargets(body.recovery_targets, ids);
    if (
      guarded &&
      (!/^\d+:[0-9a-f]{8}$/.test(expectedInventory) || !recoveryAliases || !recoveryTargets)
    ) {
      return json({ error: "invalid_recovery_guard" }, 400);
    }
    const now = Date.now();
    const result = this.storage.transactionSync(() => {
      const state = this.readStateSync();
      if (guarded) {
        const previous = ids.map(
          (id) =>
            Array.from(
              this.storage.sql.exec(
                `SELECT status, replay_key, resolution_note
                   FROM ${EXACT_REVIEW_QUEUE_DEAD_LETTER_TABLE}
                  WHERE dead_letter_id = ?`,
                id,
              ),
            )[0] as { status?: string; replay_key?: string; resolution_note?: string } | undefined,
        );
        if (
          previous.every(
            (row) =>
              row?.status === "resolved" &&
              row.replay_key === recoveryKey &&
              row.resolution_note === "recovered_fresh",
          )
        ) {
          return { state, recovered: 0, deduped: ids.length, skipped: 0, unparked: 0 };
        }
        const currentIds = Array.from(
          this.storage.sql.exec(
            `SELECT dead_letter_id FROM ${EXACT_REVIEW_QUEUE_DEAD_LETTER_TABLE}
              WHERE status = 'open' ORDER BY dead_letter_id`,
          ),
        ).map((row: { dead_letter_id?: unknown }) => String(row.dead_letter_id || ""));
        if (exactReviewDeadLetterInventoryFingerprint(currentIds) !== expectedInventory) {
          return { state, recovered: 0, deduped: 0, skipped: ids.length, unparked: 0, stale: true };
        }
      }
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
        const aliases = recoveryAliases?.get(id);
        const canonicalTarget = recoveryTargets?.get(id);
        const canonicalDecision =
          recovery && canonicalTarget
            ? exactReviewDecisionFrom({
                ...recovery.decision,
                targetRepo: canonicalTarget.repo,
                itemNumber: canonicalTarget.number,
                ...(canonicalTarget.sourceHeadSha
                  ? { sourceHeadSha: canonicalTarget.sourceHeadSha }
                  : {}),
              })
            : recovery?.decision;
        const canonicalKey = canonicalDecision ? exactReviewItemKey(canonicalDecision) : null;
        const aliasConflict = aliases
          ? Object.values(state.items).some((active) =>
              aliases.has(
                `${active.decision.targetRepo}#${active.decision.itemNumber}`.toLowerCase(),
              ),
            )
          : false;
        if (
          !item ||
          !recovery ||
          !canonicalDecision ||
          !canonicalKey ||
          (guarded &&
            (!canonicalTarget ||
              !aliases?.has(recovery.key.toLowerCase()) ||
              !aliases.has(canonicalKey.toLowerCase()) ||
              (Boolean(recovery.decision.sourceHeadSha) &&
                canonicalTarget.sourceHeadSha !== recovery.decision.sourceHeadSha) ||
              aliasConflict)) ||
          (guarded &&
            exactReviewQueueActiveReviewCount(state) + recovered >=
              exactReviewQueueCapacity(this.env)) ||
          !isExactReviewQueueTargetEnabled(canonicalDecision, this.env) ||
          state.items[item.key] ||
          state.items[recovery.key] ||
          state.items[canonicalKey]
        ) {
          skipped += 1;
          continue;
        }
        // Never replay the immutable publisher artifact. Create exactly one new ordinary
        // review item so the current workflow can gather a new artifact and proof. Existing
        // pending, dispatching, and leased items are all skipped above rather than replaced.
        state.items[canonicalKey] = {
          key: canonicalKey,
          decision: canonicalDecision,
          state: "pending",
          revision: exactReviewDecisionHasCommandContext(canonicalDecision)
            ? this.nextExactReviewCommandRevisionSync(canonicalKey, 1)
            : this.nextExactReviewItemRevisionSync(canonicalKey),
          createdAt: now,
          updatedAt: now,
          ...exactReviewQueueDebouncedAttempt(state, canonicalDecision, now, now, this.env),
          attempts: 0,
          reviewRetryPolicyEpoch: exactReviewRetryPolicyEpoch(this.env),
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
      ...("stale" in result && result.stale ? { stale_inventory: true } : {}),
    });
  }

  private resolveDeadLetters(value: unknown) {
    const body = objectValue(value);
    const ids = exactReviewDeadLetterIds(body.ids);
    const note = String(body.note || "").trim();
    const resolutionOutcome =
      body.resolution_outcome === undefined ? null : String(body.resolution_outcome || "");
    if (!ids) return json({ error: "invalid_dead_letter_ids" }, 400);
    if (!note || note.length > 500) return json({ error: "invalid_resolution_note" }, 400);
    if (resolutionOutcome !== null && resolutionOutcome !== "superseded") {
      return json({ error: "invalid_resolution_outcome" }, 400);
    }
    const guarded = body.resolution_aliases !== undefined;
    if (resolutionOutcome === "superseded" && !guarded) {
      return json({ error: "invalid_resolution_guard" }, 400);
    }
    const resolutionAliases = exactReviewRecoveryAliases(body.resolution_aliases, ids, {
      maxIds: 20,
      allowEmpty: true,
    });
    if (guarded && !resolutionAliases) return json({ error: "invalid_resolution_guard" }, 400);
    const now = Date.now();
    let resolved = 0;
    let unparked = 0;
    this.storage.transactionSync(() => {
      if (guarded) {
        const state = this.readStateSync();
        const unsafe = ids.some((id) => {
          const row = Array.from(
            this.storage.sql.exec(
              `SELECT status, item_json
                 FROM ${EXACT_REVIEW_QUEUE_DEAD_LETTER_TABLE}
                WHERE dead_letter_id = ?`,
              id,
            ),
          )[0] as { status?: string; item_json?: string } | undefined;
          if (row?.status !== "open") return true;
          const item = row.item_json ? exactReviewDeadLetterItem(row.item_json) : null;
          const recovery = item ? exactReviewFreshRecoveryFromPublicationItem(item) : null;
          const aliases = resolutionAliases!.get(id)!;
          if (recovery && !aliases.has(recovery.key.toLowerCase())) return true;
          return (
            Boolean(item && state.items[item.key]) ||
            Object.values(state.items).some((active) =>
              aliases.has(
                `${active.decision.targetRepo}#${active.decision.itemNumber}`.toLowerCase(),
              ),
            )
          );
        });
        if (unsafe) return;
      }
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
        if (resolutionOutcome === "superseded") {
          this.incrementQueueMetricsSync({
            publicationCompleted: resolved,
            publicationSuperseded: resolved,
          });
        }
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

  private listParkedReviews(value: unknown) {
    const body = objectValue(value);
    const limit = body.limit === undefined ? 20 : Number(body.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > EXACT_REVIEW_PARKED_LIST_MAX_LIMIT) {
      return json({ error: "invalid_limit" }, 400);
    }
    const cursor = String(body.cursor || "");
    if (cursor && cursor.length > 500) return json({ error: "invalid_cursor" }, 400);
    const scanSeed = String(body.scan_seed || "").trim();
    if (scanSeed && !/^[A-Za-z0-9._:-]{1,200}$/.test(scanSeed)) {
      return json({ error: "invalid_scan_seed" }, 400);
    }
    const activeRetryPolicyEpoch = exactReviewRetryPolicyEpoch(this.env);
    const eligible = Object.values(this.readStateSync().items)
      .filter((item) => exactReviewParkedOperatorEligible(item))
      .map((item) => ({
        item,
        sortKey: scanSeed
          ? stableExactReviewFailureFingerprint(`${scanSeed}\0${item.key}`)
          : item.key,
      }))
      .sort(
        (left, right) =>
          left.sortKey.localeCompare(right.sortKey) || left.item.key.localeCompare(right.item.key),
      );
    const seededCursor = scanSeed && cursor ? exactReviewSeededParkedCursor(cursor) : null;
    if (scanSeed && cursor && !seededCursor) return json({ error: "invalid_cursor" }, 400);
    const rows = eligible
      .filter(({ item, sortKey }) =>
        !cursor
          ? true
          : seededCursor
            ? sortKey.localeCompare(seededCursor.sortKey) > 0 ||
              (sortKey === seededCursor.sortKey && item.key.localeCompare(seededCursor.itemKey) > 0)
            : item.key.localeCompare(cursor) > 0,
      )
      .slice(0, limit + 1);
    const page = rows.slice(0, limit);
    return json({
      ok: true,
      parked_reviews: page.map(({ item }) => ({
        item_key: item.key,
        revision: item.revision,
        target_repo: item.decision.targetRepo,
        item_number: item.decision.itemNumber,
        item_kind: item.decision.itemKind,
        ...(exactReviewQueueHasCommandContext(item) ? { excluded_reason: "command_context" } : {}),
        parked_reason: item.parkedReason || null,
        parked_recovery_attempts: exactReviewParkedRecoveryAttempts(item.parkedRecoveryAttempts),
        first_failed_at: item.firstFailureAt
          ? new Date(item.firstFailureAt).toISOString()
          : item.dispatchFailureAt
            ? new Date(item.dispatchFailureAt).toISOString()
            : null,
        last_failure_reason:
          item.lastFailureReason || item.dispatchFailureClass || item.parkedReason || null,
        source_head_sha: item.decision.sourceHeadSha || null,
        source_base_sha: item.decision.sourceBaseSha || null,
        source_is_draft:
          typeof item.decision.sourceIsDraft === "boolean" ? item.decision.sourceIsDraft : null,
        source_content_revision: item.decision.sourceContentRevision || null,
        source_updated_at: item.decision.sourceUpdatedAt || null,
        retry_policy_epoch: item.reviewRetryPolicyEpoch || DEFAULT_EXACT_REVIEW_RETRY_POLICY_EPOCH,
        retry_policy_changed:
          (item.reviewRetryPolicyEpoch || DEFAULT_EXACT_REVIEW_RETRY_POLICY_EPOCH) !==
          activeRetryPolicyEpoch,
        updated_at: new Date(item.updatedAt).toISOString(),
        updated_at_ms: item.updatedAt,
      })),
      next_cursor:
        rows.length > limit
          ? scanSeed
            ? `${page.at(-1)?.sortKey}:${page.at(-1)?.item.key}`
            : page.at(-1)?.item.key || null
          : null,
    });
  }

  private resolveParkedReviews(value: unknown) {
    const body = objectValue(value);
    const items = exactReviewParkedOperatorItems(body.items, EXACT_REVIEW_PARKED_RESOLVE_MAX_ITEMS);
    const note = String(body.note || "").trim();
    if (!items) return json({ error: "invalid_parked_review_items" }, 400);
    if (!note || note.length > 500) return json({ error: "invalid_resolution_note" }, 400);
    const now = Date.now();
    const result = this.storage.transactionSync(() => {
      this.pruneParkedReviewActionsSync(now);
      const state = this.readStateSync();
      let resolved = 0;
      let skipped = 0;
      for (const expected of items) {
        const item = state.items[expected.itemKey];
        if (
          !item ||
          !exactReviewParkedOperatorEligible(item) ||
          exactReviewQueueHasCommandContext(item) ||
          item.revision !== expected.revision
        ) {
          skipped += 1;
          continue;
        }
        delete state.items[item.key];
        this.recordParkedReviewActionSync({
          itemKey: item.key,
          action: "resolved",
          actionKey: null,
          note,
          sourceUpdatedAt: expected.updatedAt,
          actedAt: now,
        });
        resolved += 1;
      }
      if (resolved) this.writeStateSync(state);
      else this.syncLegacyCompatibilitySync(state);
      return { resolved, skipped };
    });
    return json({ ok: true, ...result });
  }

  private async recoverParkedReviewsFresh(value: unknown) {
    const body = objectValue(value);
    const items = exactReviewParkedOperatorItems(body.items, EXACT_REVIEW_PARKED_RECOVER_MAX_ITEMS);
    const recoveryKey = String(body.idempotency_key || "").trim();
    const overrideRetryBudget = body.override_retry_budget === true;
    if (!items) return json({ error: "invalid_parked_review_items" }, 400);
    if (
      body.override_retry_budget !== undefined &&
      typeof body.override_retry_budget !== "boolean"
    ) {
      return json({ error: "invalid_retry_budget_override" }, 400);
    }
    if (!/^[A-Za-z0-9:._-]{1,200}$/.test(recoveryKey)) {
      return json({ error: "invalid_idempotency_key" }, 400);
    }
    const now = Date.now();
    const result = this.storage.transactionSync(() => {
      this.pruneParkedReviewActionsSync(now);
      const state = this.readStateSync();
      let recovered = 0;
      let deduped = 0;
      let skipped = 0;
      let unchanged = 0;
      const activeRetryPolicyEpoch = exactReviewRetryPolicyEpoch(this.env);
      for (const expected of items) {
        const previous = Array.from(
          this.storage.sql.exec(
            `SELECT action, action_key, source_updated_at
               FROM ${EXACT_REVIEW_QUEUE_PARKED_ACTION_TABLE}
              WHERE item_key = ?`,
            expected.itemKey,
          ),
        )[0] as { action?: string; action_key?: string; source_updated_at?: number } | undefined;
        if (
          previous?.action === "recovered_fresh" &&
          previous.action_key === recoveryKey &&
          Number(previous.source_updated_at) === expected.updatedAt
        ) {
          deduped += 1;
          continue;
        }
        const item = state.items[expected.itemKey];
        const refreshedDecision = item
          ? exactReviewDecisionFrom({
              ...item.decision,
              ...(expected.sourceHeadSha
                ? { sourceHeadSha: expected.sourceHeadSha, sourceHeadVerified: true }
                : {}),
              ...(expected.sourceBaseSha ? { sourceBaseSha: expected.sourceBaseSha } : {}),
              ...(expected.sourceIsDraft === null ? {} : { sourceIsDraft: expected.sourceIsDraft }),
              ...(expected.sourceContentRevision
                ? { sourceContentRevision: expected.sourceContentRevision }
                : {}),
              ...(expected.sourceUpdatedAt
                ? { sourceUpdatedAt: new Date(Date.parse(expected.sourceUpdatedAt)).toISOString() }
                : {}),
            })
          : null;
        const retryIdentityChanged = Boolean(
          item &&
          refreshedDecision &&
          exactReviewRetryIdentityChanged(item, item.decision, refreshedDecision, this.env),
        );
        if (
          !item ||
          !refreshedDecision ||
          !exactReviewParkedOperatorEligible(item) ||
          exactReviewQueueHasCommandContext(item) ||
          item.revision !== expected.revision ||
          exactReviewQueueActiveReviewCount(state) >= exactReviewQueueCapacity(this.env)
        ) {
          skipped += 1;
          continue;
        }
        if (!overrideRetryBudget && !retryIdentityChanged) {
          unchanged += 1;
          skipped += 1;
          continue;
        }
        clearExactReviewLease(item);
        item.decision = refreshedDecision;
        const refreshedWatermark = exactReviewSourceAuthorityWatermark(refreshedDecision);
        if (refreshedWatermark) item.sourceAuthorityWatermark = refreshedWatermark;
        else delete item.sourceAuthorityWatermark;
        item.state = "pending";
        item.revision = this.nextExactReviewItemRevisionSync(item.key, item.revision + 1);
        item.admissionDeliveryId = `parked-recovery:${recoveryKey}:${item.key}`;
        item.createdAt = now;
        item.updatedAt = now;
        item.parkedReason = undefined;
        item.parkedRecoveryAttempts = 0;
        item.parkedRecoveryAt = undefined;
        item.attempts = 0;
        item.publicationFailureAttempts = 0;
        item.reviewFailureAttempts = 0;
        item.reviewRetryPolicyEpoch = activeRetryPolicyEpoch;
        item.firstFailureAt = undefined;
        item.lastFailureReason = undefined;
        clearExactReviewDispatchFailure(item);
        clearExactReviewReviewRecovery(item);
        Object.assign(
          item,
          exactReviewQueueDebouncedAttempt(state, item.decision, now, now, this.env),
        );
        this.recordParkedReviewActionSync({
          itemKey: item.key,
          action: "recovered_fresh",
          actionKey: recoveryKey,
          note: overrideRetryBudget ? "recovered_fresh_override" : "recovered_fresh",
          sourceUpdatedAt: expected.updatedAt,
          actedAt: now,
        });
        recovered += 1;
      }
      if (recovered) this.writeStateSync(state);
      else this.syncLegacyCompatibilitySync(state);
      return { state, recovered, deduped, skipped, unchanged };
    });
    if (result.recovered) await this.scheduleNext(result.state, now);
    return json({
      ok: true,
      recovered: result.recovered,
      deduped: result.deduped,
      skipped: result.skipped,
      unchanged: result.unchanged,
    });
  }

  private recordParkedReviewActionSync(input: {
    itemKey: string;
    action: "resolved" | "recovered_fresh";
    actionKey: string | null;
    note: string;
    sourceUpdatedAt: number;
    actedAt: number;
  }) {
    this.storage.sql.exec(
      `INSERT INTO ${EXACT_REVIEW_QUEUE_PARKED_ACTION_TABLE}
       (item_key, action, action_key, note, source_updated_at, acted_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(item_key) DO UPDATE SET
         action = excluded.action,
         action_key = excluded.action_key,
         note = excluded.note,
         source_updated_at = excluded.source_updated_at,
         acted_at = excluded.acted_at`,
      input.itemKey,
      input.action,
      input.actionKey,
      input.note,
      input.sourceUpdatedAt,
      input.actedAt,
    );
  }

  private pruneParkedReviewActionsSync(now: number) {
    this.storage.sql.exec(
      `DELETE FROM ${EXACT_REVIEW_QUEUE_PARKED_ACTION_TABLE} WHERE acted_at <= ?`,
      now - EXACT_REVIEW_QUEUE_PARKED_ACTION_TTL_MS,
    );
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
          !item.terminalFinalization &&
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

  private async recordReviewRunTelemetry(value: unknown) {
    const record = normalizeReviewRunTelemetry(value);
    if (!record) return json({ error: "invalid_review_run_telemetry" }, 400);
    const completedAt = Date.parse(record.completed_at);
    this.storage.transactionSync(() => {
      this.pruneReviewRunTelemetrySync(Date.now());
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
    });
    await this.scheduleNext(this.readStateSync(), Date.now());
    return json({ ok: true });
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

  private recordReviewFailureAttemptSafely(options: {
    item: ExactReviewQueueItem;
    revision: number;
    claimGeneration: number;
    runId: string;
    runAttempt: number;
    outcome: Exclude<ExactReviewCompletionOutcome, "success">;
    terminalReason?: ExactReviewFailureReason;
    supplied?: ExactReviewFailureDetail;
    observedAt: number;
  }) {
    try {
      const failure = exactReviewFailureDetail({
        outcome: options.outcome,
        ...(options.terminalReason ? { terminalReason: options.terminalReason } : {}),
        ...(options.supplied ? { supplied: options.supplied } : {}),
      });
      const sourceDecision = options.item.leaseDecision ?? options.item.decision;
      const source = exactReviewFailureSource(sourceDecision);
      const sourceFingerprint = exactReviewFailureSourceFingerprint(sourceDecision);
      const failureFingerprint = stableExactReviewFailureFingerprint(
        stableJson({
          version: 1,
          stage: failure.stage,
          reason_code: failure.reasonCode,
          retryable: failure.retryable,
        }),
      );
      const attemptId = stableExactReviewFailureFingerprint(
        stableJson({
          version: 1,
          fence_key: options.item.key,
          revision: options.revision,
          claim_generation: options.claimGeneration,
          run_id: options.runId,
          run_attempt: options.runAttempt,
        }),
      );
      this.reviewFailureTelemetryStore.recordSync({
        attemptId,
        canonicalTargetKey: `${sourceDecision.targetRepo}#${sourceDecision.itemNumber}`,
        fenceKey: options.item.key,
        revision: options.revision,
        claimGeneration: options.claimGeneration,
        runId: options.runId,
        runAttempt: options.runAttempt,
        sourceFingerprint,
        failureFingerprint,
        ...source,
        ...failure,
        observedAt: options.observedAt,
      });
    } catch {
      console.warn("review_failure_telemetry_not_recorded");
      this.reviewFailureTelemetryDropAt = Math.max(
        this.reviewFailureTelemetryDropAt,
        options.observedAt,
      );
      try {
        this.reviewFailureTelemetryStore.recordDropSync(options.observedAt);
      } catch {
        // Preserve the same-instance marker when durable telemetry storage is unavailable.
      }
    }
  }

  private reviewFailureHealthSafely(now: number) {
    try {
      const summary = this.reviewFailureTelemetryStore.summarySync(now);
      return this.reviewFailureTelemetryDropAt >= now - EXACT_REVIEW_FAILURE_HEALTH_WINDOW_MS
        ? { ...summary, status: "unknown", reasons: ["telemetry_unavailable"] }
        : summary;
    } catch {
      console.warn("review_failure_telemetry_unavailable");
      return {
        status: "unknown",
        reasons: ["telemetry_unavailable"],
        window_minutes: 60,
        attempts: 0,
        affected_targets: 0,
        retryable_attempts: 0,
        terminal_attempts: 0,
        repeated_identities: 0,
        first_seen_at: null,
        last_seen_at: null,
        by_stage: {
          agent_input_scan: 0,
          source_preparation: 0,
          provider_or_model: 0,
          workflow: 0,
        },
      };
    }
  }

  private reviewObservabilitySync(options: {
    range: keyof typeof REVIEW_OBSERVABILITY_RANGES;
    repo: string | null;
    now: number;
  }) {
    const from = options.now - REVIEW_OBSERVABILITY_RANGES[options.range];
    const runs = this.reviewRunTelemetryRowsSync({
      ...(options.repo ? { repo: options.repo } : {}),
      from,
      limit: REVIEW_OBSERVABILITY_SCAN_LIMIT + 1,
    });
    const telemetryComplete = runs.length <= REVIEW_OBSERVABILITY_SCAN_LIMIT;
    const requiredSinceRaw = Date.parse(String(this.env.REVIEW_OBSERVABILITY_REQUIRED_SINCE || ""));
    return summarizeReviewObservability({
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

  private pruneReviewRunTelemetrySync(now: number) {
    this.storage.sql.exec(
      `DELETE FROM ${EXACT_REVIEW_RUN_TELEMETRY_TABLE} WHERE completed_at <= ?`,
      now - REVIEW_RUN_TELEMETRY_RETENTION_MS,
    );
  }

  private async supersedePublicationCandidates(value: unknown) {
    const body = objectValue(value);
    const candidates = exactReviewPublicationCandidates(body.items);
    if (!candidates) return json({ error: "invalid_publication_candidates" }, 400);
    const activeBatchItemKeys = new Set(this.batchStore.activeLeaseSnapshot(Date.now()).itemKeys);
    const state = this.readStateSync();
    let superseded = 0;
    for (const candidate of candidates) {
      const item = state.items[candidate.itemKey];
      if (
        !item ||
        item.revision !== candidate.revision ||
        !exactReviewQueueIsPublication(item) ||
        item.terminalFinalization ||
        (item.state !== "pending" && item.state !== "parked") ||
        activeBatchItemKeys.has(item.key)
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

  private stalePublicationCandidatesSync(
    state: ExactReviewQueueState,
    activeBatchItemKeys: ReadonlySet<string>,
    heads = this.publicationHeadsSync(state),
  ) {
    const newestByTarget = new Map<string, number>();
    const versioned = Object.values(state.items).flatMap((item) => {
      if (item.terminalFinalization || !exactReviewQueueIsPublication(item)) return [];
      const revision = exactReviewPublicationRevision(item.decision);
      if (!revision) return [];
      newestByTarget.set(
        revision.targetKey,
        Math.max(
          newestByTarget.get(revision.targetKey) ?? heads.get(revision.targetKey) ?? 0,
          revision.sourceRevision,
        ),
      );
      return [{ item, revision, lineage: exactReviewPublicationLineage(item.decision) }];
    });
    const stale = versioned
      .filter(
        ({ item, revision }) =>
          revision.sourceRevision < (newestByTarget.get(revision.targetKey) ?? 0) &&
          (item.state === "pending" || item.state === "parked") &&
          !activeBatchItemKeys.has(item.key),
      )
      .sort(
        (left, right) =>
          left.item.createdAt - right.item.createdAt || left.item.key.localeCompare(right.item.key),
      );
    return { versioned, newestByTarget, stale };
  }

  private pruneStalePublicationsSync(
    state: ExactReviewQueueState,
    activeBatchItemKeys: ReadonlySet<string>,
  ) {
    const { stale, newestByTarget } = this.stalePublicationCandidatesSync(
      state,
      activeBatchItemKeys,
    );
    const limit = Math.max(
      0,
      Math.floor(numberFrom(this.env.EXACT_REVIEW_STALE_PUBLICATION_PRUNE_LIMIT, 100)),
    );
    let changed = 0;
    for (const { item, revision } of stale
      .filter(({ item }) => !exactReviewQueueHasCommandContext(item))
      .slice(0, limit)) {
      const current = state.items[item.key];
      const currentRevision = current ? exactReviewPublicationRevision(current.decision) : null;
      if (
        !current ||
        current.terminalFinalization ||
        exactReviewQueueHasCommandContext(current) ||
        current.revision !== item.revision ||
        !currentRevision ||
        currentRevision.sourceRevision !== revision.sourceRevision ||
        (current.state !== "pending" && current.state !== "parked") ||
        activeBatchItemKeys.has(current.key) ||
        currentRevision.sourceRevision >=
          (newestByTarget.get(currentRevision.targetKey) ?? currentRevision.sourceRevision)
      ) {
        continue;
      }
      delete state.items[current.key];
      changed += 1;
    }
    if (changed) {
      this.writeStateSync(state);
      this.incrementQueueMetricsSync({
        publicationCompleted: changed,
        publicationSuperseded: changed,
      });
    }
  }

  private async reconcilePublicationCandidates(
    value: unknown,
    hostedTargetMetadataToken: HostedTargetMetadataToken,
  ) {
    const body = objectValue(value);
    const apply = body.apply === true;
    if (body.apply !== undefined && typeof body.apply !== "boolean") {
      return json({ error: "invalid_apply" }, 400);
    }
    const limit =
      body.max_items === undefined
        ? EXACT_REVIEW_PUBLICATION_RECONCILE_LIMIT
        : Number(body.max_items);
    if (!Number.isInteger(limit) || limit < 1 || limit > EXACT_REVIEW_PUBLICATION_RECONCILE_LIMIT) {
      return json({ error: "invalid_max_items" }, 400);
    }

    const now = Date.now();
    let activeBatchItemKeys = new Set<string>(this.batchStore.activeLeaseSnapshot(now).itemKeys);
    let state = this.readStateSync();
    const reclaimed = reclaimExpiredExactReviewLeases(
      state,
      now,
      exactReviewPublicationDispatchLeaseMs(this.env),
      exactReviewHeartbeatGraceMs(this.env),
      this.env,
    );
    if (apply && reclaimed) {
      // Persist expiry recovery before the bounded target reads release the
      // Durable Object input gate, so a later alarm cannot revive this stale
      // owner while reconciliation is validating it.
      await this.writeState(state);
      await this.scheduleNext(state, now);
      state = this.readStateSync();
      activeBatchItemKeys = new Set<string>(this.batchStore.activeLeaseSnapshot(now).itemKeys);
    }
    const legacyTerminalScanned = Object.values(state.items).length;
    const legacyAuthorityByTarget = exactReviewLegacyPublicationAuthorityIndex(
      state,
      activeBatchItemKeys,
    );
    const legacyTerminalCandidates = Object.values(state.items)
      .filter(
        (item) =>
          !item.terminalFinalization &&
          exactReviewLegacyTerminalPublicationCandidate(item, legacyAuthorityByTarget),
      )
      .sort((left, right) => left.createdAt - right.createdAt || left.key.localeCompare(right.key));
    const { versioned, newestByTarget, stale } = this.stalePublicationCandidatesSync(
      state,
      activeBatchItemKeys,
    );
    const legacyStateBatchAuthorityByTarget = exactReviewLegacyStateBatchPublicationAuthorityIndex(
      state,
      activeBatchItemKeys,
    );
    const legacyStateBatchTerminalCandidates = versioned
      .filter(({ item, revision }) =>
        exactReviewLegacyStateBatchTerminalPublicationCandidate(
          item,
          legacyStateBatchAuthorityByTarget,
          newestByTarget.get(revision.targetKey) ?? revision.sourceRevision,
        ),
      )
      .map(({ item }) => item)
      .sort((left, right) => left.createdAt - right.createdAt || left.key.localeCompare(right.key));

    type ReconcileCandidate = {
      item: ExactReviewQueueItem;
      revision: { targetKey: string; sourceRevision: number };
      reason: "stale_revision" | "duplicate_lineage";
      lineage: ExactReviewPublicationLineage | null;
      lineageKey?: string;
      retainedKey?: string;
    };
    const candidatesByKey = new Map<string, ReconcileCandidate>();
    for (const entry of stale) {
      candidatesByKey.set(entry.item.key, { ...entry, reason: "stale_revision" });
    }

    const lineageGroups = new Map<string, typeof versioned>();
    for (const entry of versioned) {
      if (
        !entry.lineage ||
        entry.revision.sourceRevision < (newestByTarget.get(entry.revision.targetKey) ?? 0)
      ) {
        continue;
      }
      const lineageKey = exactReviewPublicationLineageKey(entry.lineage);
      const group = lineageGroups.get(lineageKey) ?? [];
      group.push(entry);
      lineageGroups.set(lineageKey, group);
    }

    const lineageRefreshes = new Map<
      string,
      { retainedKey: string; decision: ExactReviewDecision }
    >();
    let protectedLineageItems = 0;
    for (const [lineageKey, entries] of lineageGroups) {
      if (entries.length < 2) continue;
      const active = entries
        .filter(
          ({ item }) =>
            activeBatchItemKeys.has(item.key) ||
            item.state === "dispatching" ||
            item.state === "leased",
        )
        .sort((left, right) => left.item.key.localeCompare(right.item.key));
      const pending = entries
        .filter(
          ({ item }) =>
            !activeBatchItemKeys.has(item.key) &&
            (item.state === "pending" || item.state === "parked"),
        )
        .sort(
          (left, right) =>
            left.item.createdAt - right.item.createdAt ||
            left.item.key.localeCompare(right.item.key),
        );
      if (active.length) {
        // An active owner may still publish its captured decision. Preserve the
        // whole lineage until ownership expires so newer provenance is not lost.
        protectedLineageItems += entries.length;
        continue;
      }
      const retained = pending[0];
      if (!retained) continue;

      if (pending.length > 1) {
        const freshest = pending.reduce((latest, candidate) => {
          const latestPublication = latest.item.decision.publication;
          const candidatePublication = candidate.item.decision.publication;
          return latestPublication &&
            candidatePublication &&
            exactReviewPublicationProducerIsNewer(candidatePublication, latestPublication)
            ? candidate
            : latest;
        });
        lineageRefreshes.set(lineageKey, {
          retainedKey: retained.item.key,
          decision: freshest.item.decision,
        });
      }

      for (const entry of pending) {
        if (entry.item.key === retained.item.key || candidatesByKey.has(entry.item.key)) continue;
        candidatesByKey.set(entry.item.key, {
          ...entry,
          reason: "duplicate_lineage",
          lineageKey,
          retainedKey: retained.item.key,
        });
      }
    }

    const candidates = [...candidatesByKey.values()].sort(
      (left, right) =>
        left.item.createdAt - right.item.createdAt || left.item.key.localeCompare(right.item.key),
    );
    const selected = candidates.slice(0, limit);
    const selectedLegacyTerminal = legacyTerminalCandidates.slice(
      0,
      Math.max(0, limit - selected.length),
    );
    const selectedLegacyStateBatchTerminal = legacyStateBatchTerminalCandidates.slice(
      0,
      Math.max(0, limit - selected.length - selectedLegacyTerminal.length),
    );
    const changedKeys = new Set<string>();
    const changedLineages = new Set<string>();
    let staleRevisionChanged = 0;
    let lineageDuplicateChanged = 0;
    let lineageRefreshed = 0;
    if (apply && selected.length) {
      this.storage.transactionSync(() => {
        for (const candidate of selected) {
          const { item, revision } = candidate;
          const current = state.items[item.key];
          const currentRevision = current ? exactReviewPublicationRevision(current.decision) : null;
          if (
            !current ||
            current.revision !== item.revision ||
            !currentRevision ||
            currentRevision.sourceRevision !== revision.sourceRevision ||
            (current.state !== "pending" && current.state !== "parked") ||
            activeBatchItemKeys.has(current.key)
          ) {
            continue;
          }
          if (
            candidate.reason === "stale_revision" &&
            currentRevision.sourceRevision >=
              (newestByTarget.get(currentRevision.targetKey) ?? currentRevision.sourceRevision)
          ) {
            continue;
          }
          if (candidate.reason === "duplicate_lineage") {
            const currentLineage = exactReviewPublicationLineage(current.decision);
            const retained = candidate.retainedKey ? state.items[candidate.retainedKey] : null;
            const retainedLineage = retained
              ? exactReviewPublicationLineage(retained.decision)
              : null;
            if (
              !currentLineage ||
              !retainedLineage ||
              !candidate.lineageKey ||
              exactReviewPublicationLineageKey(currentLineage) !== candidate.lineageKey ||
              exactReviewPublicationLineageKey(retainedLineage) !== candidate.lineageKey
            ) {
              continue;
            }
          }
          delete state.items[current.key];
          changedKeys.add(current.key);
          if (candidate.reason === "stale_revision") staleRevisionChanged += 1;
          else {
            lineageDuplicateChanged += 1;
            if (candidate.lineageKey) changedLineages.add(candidate.lineageKey);
          }
        }

        for (const lineageKey of changedLineages) {
          const refresh = lineageRefreshes.get(lineageKey);
          if (!refresh) continue;
          const retained = state.items[refresh.retainedKey];
          const retainedLineage = retained
            ? exactReviewPublicationLineage(retained.decision)
            : null;
          const retainedPublication = retained?.decision.publication;
          const freshestPublication = refresh.decision.publication;
          if (
            !retained ||
            !retainedLineage ||
            exactReviewPublicationLineageKey(retainedLineage) !== lineageKey ||
            (retained.state !== "pending" && retained.state !== "parked") ||
            activeBatchItemKeys.has(retained.key) ||
            !retainedPublication ||
            !freshestPublication ||
            !exactReviewPublicationProducerIsNewer(freshestPublication, retainedPublication)
          ) {
            continue;
          }
          retained.decision = refresh.decision;
          retained.revision += 1;
          retained.updatedAt = now;
          lineageRefreshed += 1;
        }
        if (changedKeys.size) {
          this.writeStateSync(state);
          this.incrementQueueMetricsSync({
            publicationCompleted: changedKeys.size,
            publicationSuperseded: changedKeys.size,
            publicationSemanticDeduped: lineageDuplicateChanged,
          });
        }
      });
      if (changedKeys.size) await this.scheduleNext(state, now);
    }

    const legacyTerminalEligibleKeys = await this.terminalizePublicationCandidates(
      selectedLegacyTerminal,
      {
        apply,
        legacyReconciliation: "v1",
      },
      hostedTargetMetadataToken,
    );
    const legacyTerminalEligibleKeySet = new Set(legacyTerminalEligibleKeys);
    const legacyTerminalEligible = selectedLegacyTerminal.filter((item) =>
      legacyTerminalEligibleKeySet.has(item.key),
    );
    const legacyTerminalChanged = apply ? legacyTerminalEligibleKeys : [];
    if (legacyTerminalChanged.length) {
      await this.scheduleNext(this.readStateSync(), Date.now());
    }

    const successfulLegacyStateBatchTerminal =
      await this.completedLegacyStateBatchPublicationCandidates(selectedLegacyStateBatchTerminal);
    const legacyStateBatchTerminalEligibleKeys = await this.terminalizePublicationCandidates(
      successfulLegacyStateBatchTerminal,
      {
        apply,
        legacyReconciliation: "state_batch_v2",
      },
      hostedTargetMetadataToken,
    );
    const legacyStateBatchTerminalEligibleKeySet = new Set(legacyStateBatchTerminalEligibleKeys);
    const legacyStateBatchTerminalEligible = successfulLegacyStateBatchTerminal.filter((item) =>
      legacyStateBatchTerminalEligibleKeySet.has(item.key),
    );
    const legacyStateBatchTerminalChanged = apply ? legacyStateBatchTerminalEligibleKeys : [];
    if (legacyStateBatchTerminalChanged.length) {
      await this.scheduleNext(this.readStateSync(), Date.now());
    }

    const remaining = apply
      ? candidates.filter(({ item }) => !changedKeys.has(item.key))
      : candidates;
    const remainingLegacyTerminal = apply ? [] : legacyTerminalEligible;
    const remainingLegacyStateBatchTerminal = apply ? [] : legacyStateBatchTerminalEligible;
    const oldestAgeSeconds = (entries: Array<{ item: ExactReviewQueueItem }>) =>
      entries.length
        ? Math.floor(
            Math.max(0, now - Math.min(...entries.map(({ item }) => item.createdAt))) / 1000,
          )
        : null;
    const staleRevisionEligible = candidates.filter(
      ({ reason }) => reason === "stale_revision",
    ).length;
    const lineageDuplicateEligible = candidates.length - staleRevisionEligible;
    return json({
      ok: true,
      apply,
      scanned: versioned.length,
      legacy_terminal_scanned: legacyTerminalScanned,
      eligible:
        candidates.length + legacyTerminalEligible.length + legacyStateBatchTerminalEligible.length,
      changed:
        changedKeys.size + legacyTerminalChanged.length + legacyStateBatchTerminalChanged.length,
      eligible_remaining:
        remaining.length +
        remainingLegacyTerminal.length +
        remainingLegacyStateBatchTerminal.length,
      stale_revision_eligible: staleRevisionEligible,
      stale_revision_changed: staleRevisionChanged,
      lineage_duplicate_eligible: lineageDuplicateEligible,
      lineage_duplicate_changed: lineageDuplicateChanged,
      lineage_refreshed: lineageRefreshed,
      legacy_terminal_candidates: legacyTerminalCandidates.length,
      legacy_terminal_selected: selectedLegacyTerminal.length,
      legacy_terminal_eligible: legacyTerminalEligible.length,
      legacy_terminal_changed: legacyTerminalChanged.length,
      legacy_state_batch_terminal_candidates: legacyStateBatchTerminalCandidates.length,
      legacy_state_batch_terminal_selected: selectedLegacyStateBatchTerminal.length,
      legacy_state_batch_terminal_producer_succeeded: successfulLegacyStateBatchTerminal.length,
      legacy_state_batch_terminal_eligible: legacyStateBatchTerminalEligible.length,
      legacy_state_batch_terminal_changed: legacyStateBatchTerminalChanged.length,
      protected_batch_items: activeBatchItemKeys.size,
      protected_lineage_items: protectedLineageItems,
      oldest_eligible_age_seconds: oldestAgeSeconds([
        ...candidates,
        ...legacyTerminalEligible.map((item) => ({ item })),
        ...legacyStateBatchTerminalEligible.map((item) => ({ item })),
      ]),
      oldest_remaining_age_seconds: oldestAgeSeconds([
        ...remaining,
        ...remainingLegacyTerminal.map((item) => ({ item })),
        ...remainingLegacyStateBatchTerminal.map((item) => ({ item })),
      ]),
      sample: [
        ...selected.map(({ item, revision, reason, lineage, retainedKey }) => ({
          item_key: item.key,
          queue_revision: item.revision,
          reason,
          target_key: revision.targetKey,
          publication_revision: revision.sourceRevision,
          superseded_by_revision: newestByTarget.get(revision.targetKey),
          lineage_claim_generation: lineage?.claimGeneration ?? null,
          retained_item_key: retainedKey ?? null,
        })),
        ...legacyTerminalEligible.map((item) => ({
          item_key: item.key,
          queue_revision: item.revision,
          reason: "legacy_terminal" as const,
          target_key: item.decision.publication!.itemKey.toLowerCase(),
          publication_revision: null,
          superseded_by_revision: null,
          lineage_claim_generation: null,
          retained_item_key: null,
        })),
        ...legacyStateBatchTerminalEligible.map((item) => ({
          item_key: item.key,
          queue_revision: item.revision,
          reason: "legacy_state_batch_terminal" as const,
          target_key: item.decision.publication!.itemKey.toLowerCase(),
          publication_revision: item.decision.publication!.leaseRevision,
          superseded_by_revision: this.publicationHeadRevisionSync(
            item.decision.publication!.itemKey.toLowerCase(),
          ),
          lineage_claim_generation: item.decision.publication!.claimGeneration,
          retained_item_key: null,
          producer_run_id: item.decision.publication!.producerRunId,
          producer_run_attempt: item.decision.publication!.producerRunAttempt,
        })),
      ].slice(0, 20),
    });
  }

  private publicationBatchCandidates(
    state: ExactReviewQueueState,
    now: number,
    batchOwnership: { itemKeys: string[] },
    publicationCapacity: number,
    requestedSize: number,
    leaseSize: number,
    probedPairs: ReadonlySet<string> | null = null,
  ) {
    // The outer comparison charges one publisher slot for the whole batch. The
    // shared helper counts candidate rows, so widen only its scan window by
    // requestedSize; passing +1 here would silently collapse every batch to one.
    const activePublishers = exactReviewQueueActivePublicationCount(state);
    const excludedItemKeys = new Set<string>([
      ...batchOwnership.itemKeys,
      ...this.supersededPublicationItemKeysSync(state),
    ]);
    for (const item of Object.values(state.items)) {
      // Apply the departure fence before admission consumes its bounded scan.
      if (
        probedPairs &&
        item.state === "pending" &&
        exactReviewQueueIsPublication(item) &&
        !probedPairs.has(JSON.stringify([item.key, item.revision]))
      ) {
        excludedItemKeys.add(item.key);
      }
      // Direct receipts and terminal acknowledgement drivers must remain on
      // the normal publisher. Exclude them before admission so they cannot
      // consume a bounded batch scan slot and starve an ordinary publication.
      if (exactReviewQueueIsPublication(item) && !exactReviewQueueIsBatchablePublication(item)) {
        excludedItemKeys.add(item.key);
      }
      if (exactReviewGithubCircuitBlocksItem(state, item, now)) {
        excludedItemKeys.add(item.key);
      }
    }
    const freshItemKeys = this.freshPublicationItemKeysSync(state, now);
    const readyCandidates =
      activePublishers >= publicationCapacity
        ? []
        : exactReviewQueueAdmittedItems(
            state,
            now,
            exactReviewQueueCapacity(this.env),
            exactReviewTargetCapacity(this.env),
            activePublishers + requestedSize,
            excludedItemKeys,
            false, // batching replaces legacy publication blocking at this admission point
            true, // one durable item path per commit; later events remain FIFO candidates
            freshItemKeys,
            exactReviewPublicationFreshLaneMaxItems(this.env),
          )
            // A direct receipt has already committed its GitHub effect. Its
            // immutable lifecycle plan must return through the fenced legacy
            // publisher, which is the only path that replays that plan.
            .filter(exactReviewQueueIsBatchablePublication)
            .filter((item) => !item.terminalFinalization);
    const selection = exactReviewPublicationBatchSelection(
      readyCandidates,
      freshItemKeys,
      exactReviewPublicationBatchSize(this.env),
      exactReviewPublicationBatchWaitMs(this.env),
      now,
    );
    // One GitHub App installation token is scoped to one owner. Keeping a batch
    // owner-homogeneous lets the workflow retain least privilege without serially
    // minting and exporting a different credential for every item.
    return selection?.candidates.slice(0, leaseSize) ?? [];
  }

  private async claimPublicationBatch(
    value: unknown,
    hostedTargetMetadataToken: HostedTargetMetadataToken,
  ) {
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
    const dispatch = exactReviewPublicationBatchDispatchMetadata(body);
    if ((body.dispatch_id !== undefined || body.dispatched_at !== undefined) && !dispatch) {
      return json({ error: "invalid_batch_dispatch_metadata" }, 400);
    }
    const runner = exactReviewPublicationBatchRunnerMetadata(body);
    if (
      (body.runner_run_id !== undefined ||
        body.runner_run_attempt !== undefined ||
        body.runner_started_at !== undefined) &&
      !runner
    ) {
      return json({ error: "invalid_batch_runner_metadata" }, 400);
    }
    const configuredSize = exactReviewPublicationBatchSize(this.env);
    const requestedSize = body.max_items === undefined ? configuredSize : Number(body.max_items);
    if (
      !Number.isInteger(requestedSize) ||
      requestedSize < 1 ||
      requestedSize > MAX_EXACT_REVIEW_PUBLICATION_BATCH_SCAN_SIZE
    ) {
      return json({ error: "invalid_max_items" }, 400);
    }
    // The workflow may ask to scan farther than the deployed lease size so an
    // owner-homogeneous batch can be filled through interleaved repositories.
    // Keep the configured size as the hard mutation/lease boundary.
    const leaseSize = Math.min(requestedSize, configuredSize);
    let now = Date.now();
    let state = this.readStateSync();
    // A workflow retry keeps its original claim id and owner, but target
    // visibility can change while the lease is active. Re-probe each unfinished
    // repository before returning any credential-bearing work.
    let existingBatch = this.batchStore.fetch(claimId, leaseOwner, now);
    const claimedResponse = async (
      batch: NonNullable<typeof existingBatch>,
      lifecycleBatch = batch,
    ) => {
      if (batch.items.length && lifecycleBatch.state === "leased") {
        this.recordLifecycleBatchClaim(lifecycleBatch, state, now);
      }
      await this.scheduleNext(state, now);
      const oldestCandidateAt = batch.items.reduce(
        (oldest, membership) =>
          Math.min(oldest, state.items[membership.itemKey]?.createdAt ?? batch.createdAt),
        batch.createdAt,
      );
      return json({
        ok: true,
        claimed: true,
        batch: exactReviewPublicationBatchJson(batch),
        configured_batch_size: batch.configuredBatchSize,
        batch_wait_ms: Math.max(0, now - oldestCandidateAt),
        requested_max_items: requestedSize,
        effective_max_items: leaseSize,
      });
    };
    const replayExistingBatch = async (batch: NonNullable<typeof existingBatch>) => {
      const unfinished = batch.items.filter((item) => item.terminalOutcome === null);
      const unfinishedRepos = new Map<string, string>(
        unfinished.flatMap((membership) => {
          const item = state.items[membership.itemKey];
          return item &&
            item.revision === membership.revision &&
            exactReviewQueueIsPublication(item)
            ? [[membership.itemKey, item.decision.targetRepo] as const]
            : [];
        }),
      );
      const admissions = new Map(
        await Promise.all(
          [...new Set(unfinishedRepos.values())].map(
            async (repo) =>
              [repo, await this.hostedTargetAdmission(repo, hostedTargetMetadataToken)] as const,
          ),
        ),
      );
      now = Date.now();
      state = this.readStateSync();
      batch = this.batchStore.fetch(claimId, leaseOwner, now)!;
      if (!batch || batch.state !== "leased") {
        return json({ error: "batch_lease_not_active" }, 409);
      }
      const completions = batch.items.flatMap((membership) => {
        if (membership.terminalOutcome !== null) return [];
        const item = state.items[membership.itemKey];
        if (
          !item ||
          item.revision !== membership.revision ||
          !exactReviewQueueIsPublication(item)
        ) {
          return [];
        }
        const admission = admissions.get(item.decision.targetRepo);
        if (admission?.outcome === "terminal") {
          return [
            {
              item_key: membership.itemKey,
              revision: membership.revision,
              claim_generation: membership.claimGeneration,
              terminal_outcome: "superseded",
            },
          ];
        }
        if (admission?.outcome === "retryable") {
          return [
            {
              item_key: membership.itemKey,
              revision: membership.revision,
              claim_generation: membership.claimGeneration,
              terminal_outcome: "retryable_failure",
              reason_code: "github_transient",
              attempted: false,
              retry_at: new Date(
                admission.retryAt ?? now + EXACT_REVIEW_ADMISSION_INTERVAL_MS,
              ).toISOString(),
            },
          ];
        }
        return [];
      });
      if (completions.length) {
        await this.completePublicationBatch({
          batch_id: claimId,
          lease_owner: leaseOwner,
          items: completions,
        });
        now = Date.now();
        state = this.readStateSync();
        batch = this.batchStore.fetch(claimId, leaseOwner, now)!;
        if (!batch) {
          return json({ error: "batch_lease_not_active" }, 409);
        }
      }
      const publicBatch = {
        ...batch,
        items: batch.items.filter((membership) => {
          if (membership.terminalOutcome !== null) return false;
          const item = state.items[membership.itemKey];
          return (
            item?.revision === membership.revision &&
            exactReviewQueueIsPublication(item) &&
            admissions.get(item.decision.targetRepo)?.outcome === "public"
          );
        }),
      };
      return claimedResponse(publicBatch, batch);
    };
    if (existingBatch?.state === "leased") return replayExistingBatch(existingBatch);
    let probedPairs = exactReviewPublicationBatchReservedProbe(state, now, dispatch?.id);
    let candidates = this.publicationBatchClaimCandidates(
      state,
      now,
      requestedSize,
      leaseSize,
      probedPairs,
    );
    const admissions = new Map(
      await Promise.all(
        [...new Set(candidates.map((item) => item.decision.targetRepo))].map(
          async (repo) =>
            [repo, await this.hostedTargetAdmission(repo, hostedTargetMetadataToken)] as const,
        ),
      ),
    );
    now = Date.now();
    state = this.readStateSync();
    existingBatch = this.batchStore.fetch(claimId, leaseOwner, now);
    if (existingBatch?.state === "leased") return replayExistingBatch(existingBatch);
    probedPairs = exactReviewPublicationBatchReservedProbe(state, now, dispatch?.id);
    candidates = this.publicationBatchClaimCandidates(
      state,
      now,
      requestedSize,
      leaseSize,
      probedPairs,
    );
    if (candidates.some((item) => !admissions.has(item.decision.targetRepo))) {
      return unclaimedPublicationBatch(requestedSize, leaseSize, { preflight_required: true });
    }
    const retryableAdmission = candidates.some(
      (item) => admissions.get(item.decision.targetRepo)?.outcome === "retryable",
    );
    const terminalCandidates = candidates.filter(
      (item) => admissions.get(item.decision.targetRepo)?.outcome === "terminal",
    );
    if (terminalCandidates.length) {
      for (const candidate of terminalCandidates) {
        delete state.items[candidate.key];
        this.recordHostedTargetTerminal(candidate, now);
      }
      this.writeStateSync(state);
      this.incrementQueueMetricsSync({
        publicationCompleted: terminalCandidates.length,
        publicationSuperseded: terminalCandidates.length,
      });
      await this.scheduleNext(state, now);
    }
    if (retryableAdmission || terminalCandidates.length) {
      const response = unclaimedPublicationBatch(requestedSize, leaseSize, {
        reason: retryableAdmission ? "target_visibility_unverified" : "private_target_unsupported",
        ...(retryableAdmission ? { retryable: true } : {}),
      });
      const retryAt = candidates.reduce(
        (latest, item) => Math.max(latest, admissions.get(item.decision.targetRepo)?.retryAt ?? 0),
        0,
      );
      const retryAfterSeconds = hostedTargetRetryAfterSeconds(retryAt);
      if (retryAfterSeconds !== null) {
        response.headers.set("retry-after", String(retryAfterSeconds));
      }
      return response;
    }
    const candidateProbe = exactReviewPublicationBatchCandidateProbe(candidates);
    const dispatchReservationActive =
      Number(state.dispatcher?.publicationBatchDispatchPendingUntil || 0) > now;
    // Before the dispatcher has ever launched a workflow, retain the existing
    // direct-claim compatibility. Once it has, every subsequent workflow claim
    // must carry a live terminal probe; an old delayed workflow cannot erase a
    // newer departure's fence and fall back to an unprobed claim.
    const terminalProbeRequired = state.dispatcher?.publicationBatchDispatchedAt !== undefined;
    // A dispatch reservation written by the previous queue version predates
    // the probe marker. Let that already-in-flight workflow finish during a
    // rolling deployment; new departures always persist a probe.
    const legacyDispatchReservation =
      dispatchReservationActive && state.dispatcher?.publicationBatchTerminalProbe === undefined;
    // Older workflow definitions have no dispatch metadata and must remain
    // claim-compatible. A telemetry-bearing workflow, however, must consume
    // the reservation that issued its immutable dispatch id; otherwise a late
    // workflow could erase a newer departure and corrupt its handoff trace.
    const dispatchMatchesReservation =
      !dispatch ||
      !dispatchReservationActive ||
      dispatch.id === state.dispatcher?.publicationBatchDispatchId;
    const probeMatches =
      !terminalProbeRequired ||
      legacyDispatchReservation ||
      (dispatchReservationActive &&
        (probedPairs
          ? candidates.length > 0
          : state.dispatcher.publicationBatchTerminalProbe === candidateProbe) &&
        dispatchMatchesReservation);
    if (!probeMatches) {
      // Only the workflow holding this exact departure may retire its stale
      // probe. A newer item can change the selection before that workflow
      // starts; otherwise the stale reservation blocks every publisher for
      // its full ten-minute lifetime even though no batch was claimed.
      if (
        dispatch &&
        dispatchReservationActive &&
        dispatch.id === state.dispatcher?.publicationBatchDispatchId
      ) {
        const dispatcher = { ...state.dispatcher };
        delete dispatcher.publicationBatchDispatchPendingUntil;
        delete dispatcher.publicationBatchTerminalProbe;
        state.dispatcher = dispatcher;
        this.writeStateSync(state);
      }
      await this.scheduleNext(state, now);
      return json({
        ok: true,
        claimed: false,
        batch: null,
        requested_max_items: requestedSize,
        effective_max_items: leaseSize,
        preflight_required: true,
      });
    }
    const batch = this.batchStore.claim({
      batchId: claimId,
      leaseOwner,
      leaseExpiresAt: now + exactReviewPublicationBatchLeaseMs(this.env),
      now,
      maxItems: leaseSize,
      maxConcurrentBatches: exactReviewPublicationBatchMaxConcurrent(this.env),
      ...(dispatch ? { dispatch } : {}),
      ...(runner ? { runner } : {}),
      candidates: candidates.map((item) => ({
        itemKey: item.key,
        revision: item.revision,
        producerRunId: item.decision.publication?.producerRunId,
        producerRunAttempt: item.decision.publication?.producerRunAttempt,
        enqueuedAt: item.createdAt,
      })),
    });
    if (
      state.dispatcher?.publicationBatchDispatchPendingUntil ||
      state.dispatcher?.publicationBatchTerminalProbe
    ) {
      const dispatcher = { ...state.dispatcher };
      delete dispatcher.publicationBatchDispatchPendingUntil;
      delete dispatcher.publicationBatchTerminalProbe;
      state.dispatcher = dispatcher;
      this.writeStateSync(state);
    }
    if (!batch) {
      await this.scheduleNext(state, now);
      return json({
        ok: true,
        claimed: false,
        batch: null,
        requested_max_items: requestedSize,
        effective_max_items: leaseSize,
      });
    }
    this.recordLifecycleBatchClaim(batch, state, now);
    await this.scheduleNext(state, now);
    const oldestCandidateAt = batch.items.reduce(
      (oldest, membership) =>
        Math.min(oldest, state.items[membership.itemKey]?.createdAt ?? batch.createdAt),
      batch.createdAt,
    );
    return json({
      ok: true,
      claimed: true,
      batch: exactReviewPublicationBatchJson(batch),
      configured_batch_size: batch.configuredBatchSize,
      batch_wait_ms: Math.max(0, now - oldestCandidateAt),
      requested_max_items: requestedSize,
      effective_max_items: leaseSize,
    });
  }

  private async fetchPublicationBatch(value: unknown) {
    const body = objectValue(value);
    const batchId = exactReviewPublicationBatchId(body.batch_id);
    const leaseOwner = exactReviewPublicationBatchOwner(body.lease_owner);
    if (!batchId || !leaseOwner) return json({ error: "invalid_batch_identity" }, 400);
    const now = Date.now();
    let batch = this.batchStore.fetch(batchId, leaseOwner, now);
    if (!batch) return json({ error: "batch_lease_not_active" }, 409);
    let state = this.readStateSync();
    const stale: PublicationBatchCompletion[] = batch.items
      .filter((membership) => {
        if (membership.terminalOutcome !== null) return false;
        const item = state.items[membership.itemKey];
        const publicationRevision = item ? exactReviewPublicationRevision(item.decision) : null;
        return (
          !item ||
          item.revision !== membership.revision ||
          !exactReviewQueueIsPublication(item) ||
          (publicationRevision !== null &&
            publicationRevision.sourceRevision <
              this.publicationHeadRevisionSync(publicationRevision.targetKey))
        );
      })
      .map((membership) => ({
        itemKey: membership.itemKey,
        revision: membership.revision,
        claimGeneration: membership.claimGeneration,
        terminalOutcome: "superseded",
      }));
    if (stale.length) {
      const lifecycleTerminals: Array<{
        canonicalTargetKey: string;
        fenceKey: string;
        revision: number;
        kind: LifecycleTerminalDisposition;
      }> = [];
      const lifecycleTelemetryBatchOutcomes: Array<{
        canonicalTargetKey: string;
        fenceKey: string;
        revision: number;
        claimGeneration: number;
        outcome: "superseded";
      }> = [];
      batch = this.batchStore.complete(batchId, leaseOwner, stale, now, {}, (accepted) => {
        const current = this.readStateSync();
        let superseded = 0;
        for (const completion of accepted) {
          const item = current.items[completion.itemKey];
          if (item) {
            const canonicalTargetKey = `${item.decision.targetRepo}#${item.decision.itemNumber}`;
            const projection = this.lifecycleProjectionStore.read(
              canonicalTargetKey,
              completion.itemKey,
              completion.revision,
            );
            if (
              !projection?.canonicalReceipts.some((receipt) => receipt.outcome === "superseded")
            ) {
              lifecycleTelemetryBatchOutcomes.push({
                canonicalTargetKey,
                fenceKey: completion.itemKey,
                revision: completion.revision,
                claimGeneration: completion.claimGeneration,
                outcome: "superseded",
              });
            }
            lifecycleTerminals.push({
              canonicalTargetKey,
              fenceKey: completion.itemKey,
              revision: completion.revision,
              kind: "superseded",
            });
          }
          const publicationRevision = item ? exactReviewPublicationRevision(item.decision) : null;
          if (
            !item ||
            item.revision !== completion.revision ||
            !exactReviewQueueIsPublication(item) ||
            !publicationRevision ||
            publicationRevision.sourceRevision >=
              this.publicationHeadRevisionSync(publicationRevision.targetKey)
          ) {
            continue;
          }
          const result = finishExactReviewPublicationQueueItem({
            state: current,
            item,
            now,
            completion: { kind: "superseded", reasonCode: "remote_newer_tuple" },
            ownedRevision: completion.revision,
            deadLetterCapacityAvailable: true,
            env: this.env,
          });
          if (!result.requeued && !result.parked) superseded += 1;
        }
        if (!superseded) return;
        this.writeStateSync(current);
        this.incrementQueueMetricsSync({
          publicationCompleted: superseded,
          publicationSuperseded: superseded,
        });
      });
      if (!batch) return json({ error: "batch_lease_not_active" }, 409);
      for (const terminal of lifecycleTerminals) {
        this.recordLifecycleTerminal(terminal, now);
      }
      for (const outcome of lifecycleTelemetryBatchOutcomes) {
        this.recordLifecycleTelemetryBatch({ batchId, ...outcome, observedAt: now });
      }
      state = this.readStateSync();
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
          repeat_revision: Number(item.publicationFailureAttempts || 0) > 0,
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
    const progress =
      body.state_writer_progress === undefined
        ? undefined
        : normalizeStateWriterProgress(body.state_writer_progress);
    const observation = exactReviewPublicationBatchObservation(body);
    if (!batchId || !leaseOwner) return json({ error: "invalid_batch_identity" }, 400);
    if (!members?.length) return json({ error: "invalid_batch_members" }, 400);
    if ((body.timeline_stage !== undefined || body.observed_at !== undefined) && !observation) {
      return json({ error: "invalid_batch_timeline_observation" }, 400);
    }
    if (body.state_writer_progress !== undefined && !progress) {
      this.incrementStateWriterDiagnosticSafely("rejected_progress_total");
      return json({ error: "invalid_state_writer_progress" }, 400);
    }
    const now = Date.now();
    const batch = this.batchStore.heartbeat(
      batchId,
      leaseOwner,
      members,
      now + exactReviewPublicationBatchLeaseMs(this.env),
      now,
    );
    if (!batch) return json({ error: "batch_lease_not_active" }, 409);
    if (progress) {
      const expectedOperationId = `batch:${batchId}`;
      if (progress.mode !== "batch" || progress.operation_id !== expectedOperationId) {
        this.incrementStateWriterDiagnosticSafely("rejected_progress_total");
        return json({ error: "invalid_batch_state_writer_progress" }, 400);
      }
      this.recordStateWriterProgressSafely(progress, now);
      if (progress.phase === "waiting") {
        this.batchStore.recordObservation(
          batchId,
          leaseOwner,
          "state_writer_wait",
          Date.parse(progress.observed_at),
        );
      }
    }
    if (observation) {
      this.batchStore.recordObservation(
        batchId,
        leaseOwner,
        observation.stage,
        observation.observedAt,
      );
    }
    return json({ ok: true, batch: exactReviewPublicationBatchJson(batch) });
  }

  private async completePublicationBatch(value: unknown) {
    const body = objectValue(value);
    const batchId = exactReviewPublicationBatchId(body.batch_id);
    const leaseOwner = exactReviewPublicationBatchOwner(body.lease_owner);
    const completions = exactReviewPublicationBatchCompletions(body.items);
    const rateLimitObservations = exactReviewGithubRateLimitObservations(
      body.github_rate_limit_observations,
    );
    const requestMetrics = exactReviewGithubRequestMetrics(body.github_request_metrics);
    const telemetryId = String(body.github_telemetry_id || "").trim();
    const stateWriter =
      body.state_writer === undefined
        ? undefined
        : normalizeStateWriterOperation(body.state_writer);
    if (!batchId || !leaseOwner) return json({ error: "invalid_batch_identity" }, 400);
    if (!completions) return json({ error: "invalid_batch_completions" }, 400);
    if (body.github_rate_limit_observations !== undefined && !rateLimitObservations) {
      return json({ error: "invalid_github_rate_limit_observations" }, 400);
    }
    if (body.github_request_metrics !== undefined && !requestMetrics) {
      return json({ error: "invalid_github_request_metrics" }, 400);
    }
    if (body.github_telemetry_id !== undefined && !/^[0-9a-f]{64}$/i.test(telemetryId)) {
      return json({ error: "invalid_github_telemetry_id" }, 400);
    }
    if (body.state_writer !== undefined && !stateWriter) {
      this.incrementStateWriterDiagnosticSafely("rejected_terminal_total");
      return json({ error: "invalid_batch_state_writer" }, 400);
    }
    if (
      stateWriter &&
      (stateWriter.mode !== "batch" || stateWriter.operation_id !== `batch:${batchId}`)
    ) {
      this.incrementStateWriterDiagnosticSafely("rejected_terminal_total");
      return json({ error: "invalid_batch_state_writer_identity" }, 400);
    }
    const stateCommitSha = String(body.state_commit_sha || "").trim();
    if (stateCommitSha && !/^[0-9a-f]{40}$/i.test(stateCommitSha)) {
      return json({ error: "invalid_state_commit_sha" }, 400);
    }
    const failureFingerprint = String(body.failure_fingerprint || "").trim();
    if (failureFingerprint.length > 500) {
      return json({ error: "invalid_failure_fingerprint" }, 400);
    }
    let acceptedCount = 0;
    let completedState: ExactReviewQueueState | undefined;
    const requestedByFence = new Map(
      completions.map(
        (completion) =>
          [
            `${completion.itemKey}:${completion.revision}:${completion.claimGeneration}`,
            completion,
          ] as const,
      ),
    );
    const now = Date.now();
    const lifecycleTerminals: Array<{
      canonicalTargetKey: string;
      fenceKey: string;
      revision: number;
      kind: LifecycleTerminalDisposition;
    }> = [];
    const lifecycleTelemetryBatchOutcomes: Array<{
      canonicalTargetKey: string;
      fenceKey: string;
      revision: number;
      claimGeneration: number;
      outcome: "superseded" | "retryable" | "permanent";
    }> = [];
    let batch = this.batchStore.complete(
      batchId,
      leaseOwner,
      completions.map(({ itemKey, revision, claimGeneration, terminalOutcome }) => ({
        itemKey,
        revision,
        claimGeneration,
        terminalOutcome,
      })),
      now,
      {
        ...(stateCommitSha ? { stateCommitSha } : {}),
        ...(failureFingerprint ? { failureFingerprint } : {}),
      },
      (accepted) => {
        acceptedCount = accepted.length;
        if (!accepted.length) return;
        const state = this.readStateSync();
        completedState = state;
        let published = 0;
        let superseded = 0;
        let completed = 0;
        let retried = 0;
        let deadLettered = 0;
        let refreshed = 0;
        const publicationTransitions: ExactReviewPublicationTransitionFact[] = [];
        for (const completion of accepted) {
          const requested = requestedByFence.get(
            `${completion.itemKey}:${completion.revision}:${completion.claimGeneration}`,
          );
          if (!requested) continue;
          const item = state.items[completion.itemKey];
          // A newer source revision may arrive while the batch store still owns
          // the original fenced membership. The store validated that immutable
          // tuple before this callback; requiring the mutable current revision
          // to match would bypass the newer-revision requeue path below.
          if (
            !item ||
            !exactReviewQueueIsPublication(item) ||
            item.revision < completion.revision
          ) {
            continue;
          }
          if (completion.terminalOutcome === "superseded") {
            const canonicalTargetKey = `${item.decision.targetRepo}#${item.decision.itemNumber}`;
            const projection = this.lifecycleProjectionStore.read(
              canonicalTargetKey,
              completion.itemKey,
              completion.revision,
            );
            if (
              !projection?.canonicalReceipts.some((receipt) => receipt.outcome === "superseded")
            ) {
              lifecycleTelemetryBatchOutcomes.push({
                canonicalTargetKey,
                fenceKey: completion.itemKey,
                revision: completion.revision,
                claimGeneration: completion.claimGeneration,
                outcome: "superseded",
              });
            }
            lifecycleTerminals.push({
              canonicalTargetKey,
              fenceKey: completion.itemKey,
              revision: completion.revision,
              kind: "superseded",
            });
          }
          if (requested.publicationCompletion) {
            const publicationAttempt =
              requested.publicationCompletion.attempted === false ||
              requested.publicationCompletion.kind === "published" ||
              requested.publicationCompletion.kind === "superseded" ||
              requested.publicationCompletion.kind === "deferred"
                ? Number(item.publicationFailureAttempts || 0)
                : Number(item.publicationFailureAttempts || 0) + 1;
            const projectionBeforeTerminalCommit = this.lifecycleProjectionStore.read(
              `${item.decision.targetRepo}#${item.decision.itemNumber}`,
              item.key,
              completion.revision,
            );
            const result = finishExactReviewPublicationQueueItem({
              state,
              item,
              now,
              completion: requested.publicationCompletion,
              ownedRevision: completion.revision,
              requestedRetryAt: requested.requestedRetryAt,
              deadLetterCapacityAvailable: this.deadLetterCapacityAvailableSync(
                exactReviewDeadLetterId(item, completion.revision),
              ),
              env: this.env,
            });
            const terminalDisposition = exactReviewLifecycleCompletionDisposition({
              projection: projectionBeforeTerminalCommit,
              outcome: "success",
              publicationCompletion: requested.publicationCompletion,
              requeued: result.requeued,
              parked: result.parked,
              deadLetter: Boolean(result.deadLetter),
            });
            const terminalFinalization =
              !result.requeued &&
              !result.parked &&
              exactReviewQueueHasCommandContext(item) &&
              terminalDisposition &&
              terminalDisposition !== "requeue"
                ? exactReviewTerminalFinalization(terminalDisposition, {
                    canonicalTargetKey: `${item.decision.targetRepo}#${item.decision.itemNumber}`,
                    fenceKey: completion.itemKey,
                    revision: completion.revision,
                  })
                : null;
            if (terminalFinalization) {
              // Batch completion consumes membership rather than an item lease.
              // Retain only this terminal acknowledgement driver so batching
              // cannot publish the revision again.
              state.items[item.key] = item;
              clearExactReviewLease(item);
              item.state = "pending";
              item.terminalFinalization = terminalFinalization;
              item.nextAttemptAt = now;
              item.backoffReason = undefined;
              item.updatedAt = now;
            }
            if (result.deadLetter) {
              this.insertDeadLetterSync(result.deadLetter);
              deadLettered += 1;
            }
            publicationTransitions.push(
              exactReviewPublicationTransitionFact({
                completion: requested.publicationCompletion,
                result,
                itemRevision: item.revision,
                ownedRevision: completion.revision,
                requeueLatest: false,
                defaultPoolClass: "repository_actions",
                backoffReason: result.requeued || result.parked ? item.backoffReason : undefined,
                attempt: publicationAttempt,
              }),
            );
            const telemetryOutcome = exactReviewLifecycleTelemetryPublicationOutcome(
              requested.publicationCompletion,
            );
            if (telemetryOutcome) {
              lifecycleTelemetryBatchOutcomes.push({
                canonicalTargetKey: `${item.decision.targetRepo}#${item.decision.itemNumber}`,
                fenceKey: completion.itemKey,
                revision: completion.revision,
                claimGeneration: completion.claimGeneration,
                outcome: telemetryOutcome,
              });
            }
            const lifecycleTerminal = result.deadLetter
              ? "dead_letter"
              : result.requeued || result.parked || result.refreshed
                ? "requeue"
                : null;
            if (lifecycleTerminal) {
              lifecycleTerminals.push({
                canonicalTargetKey: `${item.decision.targetRepo}#${item.decision.itemNumber}`,
                fenceKey: completion.itemKey,
                revision: completion.revision,
                kind: lifecycleTerminal,
              });
            }
            if (!result.requeued && !result.parked) completed += 1;
            if (result.retried) retried += 1;
            if (result.refreshed) refreshed += 1;
            continue;
          }
          const publicationCompletion =
            completion.terminalOutcome === "published"
              ? ({ kind: "published", reasonCode: "publication_applied" } as const)
              : ({ kind: "superseded", reasonCode: "remote_newer_tuple" } as const);
          const projectionBeforeTerminalCommit = this.lifecycleProjectionStore.read(
            `${item.decision.targetRepo}#${item.decision.itemNumber}`,
            item.key,
            completion.revision,
          );
          const result = finishExactReviewPublicationQueueItem({
            state,
            item,
            now,
            completion: publicationCompletion,
            ownedRevision: completion.revision,
            requestedRetryAt: requested.requestedRetryAt,
            deadLetterCapacityAvailable: true,
            env: this.env,
          });
          const publicationTransitionInput = {
            completion: publicationCompletion,
            itemRevision: item.revision,
            ownedRevision: completion.revision,
            requeueLatest: false,
            defaultPoolClass: "repository_actions" as const,
            attempt: Number(item.publicationFailureAttempts || 0),
          };
          publicationTransitions.push(
            exactReviewPublicationTransitionFact({
              ...publicationTransitionInput,
              // The batch publisher already completed this owned revision.
              // Preserve that primary flow fact even when the queue must also
              // retain a newer local revision for another publication.
              result: { ...result, requeued: false, parked: false },
            }),
          );
          if (result.requeued || result.parked) {
            publicationTransitions.push(
              exactReviewPublicationTransitionFact({
                ...publicationTransitionInput,
                result,
                backoffReason: item.backoffReason,
              }),
            );
          }
          const terminalDisposition = exactReviewLifecycleCompletionDisposition({
            projection: projectionBeforeTerminalCommit,
            outcome: "success",
            publicationCompletion,
            requeued: result.requeued,
            parked: result.parked,
            deadLetter: Boolean(result.deadLetter),
          });
          const terminalFinalization =
            !result.requeued &&
            !result.parked &&
            exactReviewQueueHasCommandContext(item) &&
            terminalDisposition &&
            terminalDisposition !== "requeue"
              ? exactReviewTerminalFinalization(terminalDisposition, {
                  canonicalTargetKey: `${item.decision.targetRepo}#${item.decision.itemNumber}`,
                  fenceKey: completion.itemKey,
                  revision: completion.revision,
                })
              : null;
          if (terminalFinalization) {
            // Batch completion consumes membership rather than an item lease.
            // Retain only this terminal acknowledgement driver so batching
            // cannot publish the revision again.
            state.items[item.key] = item;
            clearExactReviewLease(item);
            item.state = "pending";
            item.terminalFinalization = terminalFinalization;
            item.nextAttemptAt = now;
            item.backoffReason = undefined;
            item.updatedAt = now;
          }
          if (!result.requeued) completed += 1;
          if (completion.terminalOutcome === "published") published += 1;
          else if (completion.terminalOutcome === "superseded") superseded += 1;
        }
        this.writeStateSync(state);
        this.incrementQueueMetricsSync({
          publicationCompleted: completed,
          publicationPublished: published,
          publicationSuperseded: superseded,
          publicationRetried: retried,
          publicationDeadLettered: deadLettered,
          publicationRefreshed: refreshed,
          publicationTransitions,
        });
      },
    );
    if (!batch) return json({ error: "batch_lease_not_active" }, 409);
    for (const terminal of lifecycleTerminals) {
      this.recordLifecycleTerminal(terminal, now);
    }
    for (const outcome of lifecycleTelemetryBatchOutcomes) {
      this.recordLifecycleTelemetryBatch({ batchId, ...outcome, observedAt: now });
    }
    if (stateWriter?.commit_count === 1) {
      batch =
        this.batchStore.recordObservation(
          batchId,
          leaseOwner,
          "state_writer_committed",
          Date.parse(stateWriter.finished_at),
        ) ?? batch;
    }
    const telemetrySubmitted = Boolean(rateLimitObservations?.length || requestMetrics?.length);
    let telemetryApplied = false;
    if (telemetrySubmitted) {
      const state = this.readStateSync();
      const telemetryReceipt =
        telemetryId ||
        (await sha256Hex(
          new TextEncoder().encode(
            stableJson({ batchId, leaseOwner, rateLimitObservations, requestMetrics }),
          ),
        ));
      telemetryApplied = this.applyGithubTelemetrySync(
        state,
        telemetryReceipt,
        rateLimitObservations || [],
        requestMetrics || [],
        now,
      );
      if (rateLimitObservations?.length) {
        const control = this.publicationControlSync();
        const feedbackAt = Math.max(
          ...rateLimitObservations.map((observation) => observation.observedAt),
        );
        this.applyPublicationFeedbackSync(
          {
            at: feedbackAt,
            capacity: control.capacityCeiling,
            outcome: "failure",
            failureKind: "github_rate_limit",
          },
          telemetryReceipt,
        );
      }
    }
    if (
      (acceptedCount || telemetryApplied) &&
      (rateLimitObservations?.length ||
        completions.some(
          (completion) => completion.publicationCompletion?.reasonCode === "github_rate_limit",
        ))
    ) {
      batch = this.batchStore.recordGithubThrottle(batchId, leaseOwner, now) ?? batch;
    }
    this.recordStateWriterOperationSafely(stateWriter, false, now);
    if (acceptedCount || telemetryApplied)
      await this.scheduleNext(
        !telemetrySubmitted && completedState ? completedState : this.readSchedulingStateSync(),
        now,
      );
    return json({
      ok: true,
      accepted: acceptedCount,
      skipped: completions.length - acceptedCount,
      ...(telemetrySubmitted ? { telemetry_accepted: true } : {}),
      batch: exactReviewPublicationBatchJson(batch),
    });
  }

  private recordLifecycleAdmission(
    item: ExactReviewQueueItem,
    decision: ExactReviewDecision,
    now: number,
    revision = item.revision,
  ) {
    const sourceDecision = decision.publication?.producerDecision ?? decision;
    const canonicalTargetKey = `${sourceDecision.targetRepo}#${sourceDecision.itemNumber}`;
    // A command is itself the lifecycle trigger. Command verification can add
    // the current PR timestamp for authority checks, but that must not turn an
    // older or unrelated PR edit into the timing origin for @review/@re-review.
    // Scheduled review candidates preserve their source update time for review
    // policy, but their lifecycle begins only when this queue admits them.
    // Otherwise an old backfill candidate can produce a valid completion whose
    // duration is outside the bounded Bay metric domain.
    const sourceTriggeredAt = Date.parse(
      String(
        exactReviewScheduledLane(sourceDecision)
          ? new Date(now).toISOString()
          : exactReviewDecisionHasCommandContext(sourceDecision)
            ? sourceDecision.sourceCommentUpdatedAt || sourceDecision.sourceUpdatedAt || ""
            : sourceDecision.sourceUpdatedAt || sourceDecision.sourceCommentUpdatedAt || "",
      ),
    );
    const existing = this.lifecycleProjectionStore.read(canonicalTargetKey, item.key, revision);
    if (existing) return existing;
    return this.lifecycleProjectionStore.recordAdmissionSync({
      canonicalTargetKey,
      fenceKey: item.key,
      revision,
      deliveryId:
        sourceDecision.sourceDeliveryId ||
        item.admissionDeliveryId ||
        `admission:${item.key}:${revision}`,
      sourceAction: sourceDecision.sourceAction,
      commandOriginated: exactReviewDecisionHasCommandContext(sourceDecision),
      statusMarker: sourceDecision.commandStatusMarker ?? null,
      statusCommentId: sourceDecision.statusCommentId ?? null,
      ...(sourceDecision.sourceDeliveryId
        ? { sourceDeliveryId: sourceDecision.sourceDeliveryId }
        : {}),
      ...(sourceDecision.bayJourneyDeliveryId
        ? { bayJourneyDeliveryId: sourceDecision.bayJourneyDeliveryId }
        : {}),
      ...(Number.isFinite(sourceTriggeredAt) && sourceTriggeredAt <= now
        ? { triggeredAt: sourceTriggeredAt }
        : {}),
      observedAt: now,
    });
  }

  private transitionCommandRevision(
    state: ExactReviewQueueState,
    item: ExactReviewQueueItem,
    decision: ExactReviewDecision,
    now: number,
    options: {
      newItem?: boolean;
      minimumRevision?: number;
      allocatedRevision?: number;
      admissionDeliveryId?: string;
      retainPriorLifecycle?: boolean;
    } = {},
  ) {
    let terminal: ExactReviewLifecycleProjection | null = null;
    if (!options.newItem) {
      const prior = this.recordLifecycleAdmission(item, item.decision, now);
      if (prior && !options.retainPriorLifecycle) {
        const requestedKind = exactReviewCommandObligationSurvives(item.decision, decision)
          ? "requeue"
          : "superseded";
        const committedKind = prior.terminalDisposition?.kind;
        terminal =
          committedKind && committedKind !== "requeue"
            ? prior
            : this.lifecycleProjectionStore.recordTerminalDispositionSync({
                canonicalTargetKey: prior.canonicalTargetKey,
                fenceKey: prior.fenceKey,
                revision: prior.revision,
                kind: requestedKind,
                observedAt: now,
              }).projection;
        const terminalKind = terminal.terminalDisposition?.kind;
        if (terminalKind && terminalKind !== "requeue") {
          this.ensureLifecycleTerminalFinalizationDriver({
            state,
            projection: terminal,
            terminalDisposition: terminalKind,
            now,
          });
        }
      }
    }
    item.revision =
      options.allocatedRevision ??
      this.nextExactReviewCommandRevisionSync(
        item.key,
        Math.max(options.minimumRevision || 1, options.newItem ? 1 : item.revision + 1),
      );
    if (options.admissionDeliveryId) item.admissionDeliveryId = options.admissionDeliveryId;
    item.decision = decision;
    item.updatedAt = now;
    state.items[item.key] = item;
    this.recordLifecycleAdmission(item, decision, now);
    return { item, terminal };
  }

  private recordLifecycleClaim(item: ExactReviewQueueItem, now: number) {
    if (!exactReviewQueueIsPublication(item) || item.terminalFinalization || !item.claimedRunId) {
      return;
    }
    const revision = item.leaseRevision ?? item.revision;
    const sourceDecision =
      item.decision.publication?.producerDecision ?? item.leaseDecision ?? item.decision;
    const identity = {
      canonicalTargetKey: `${item.decision.targetRepo}#${item.decision.itemNumber}`,
      fenceKey: item.key,
      revision,
    };
    const existing = this.recordLifecycleAdmission(item, sourceDecision, now, revision);
    if (existing && existing.fenceKey !== identity.fenceKey) {
      throw new Error("conflicting lifecycle projection identity");
    }
    this.lifecycleProjectionStore.recordClaim({
      ...identity,
      claimGeneration: exactReviewClaimGeneration(item.claimGeneration),
      runId: item.claimedRunId,
      runAttempt: exactReviewRunAttempt(item.claimedRunAttempt),
      observedAt: now,
    });
  }

  private recordLifecycleBatchClaim(batch, state: ExactReviewQueueState, now: number) {
    // A batch lease can predate runner telemetry during a rolling deployment.
    // Its immutable admission still authorizes subsequent terminal handling,
    // but we must not manufacture a claim or review-result fact without the
    // runner tuple that identifies it.
    const hasRunner =
      Boolean(batch.runnerRunId) &&
      Number.isSafeInteger(batch.runnerRunAttempt) &&
      batch.runnerRunAttempt >= 1;
    for (const membership of batch.items) {
      const item = state.items[membership.itemKey];
      if (!item || !exactReviewQueueIsPublication(item) || item.revision !== membership.revision) {
        continue;
      }
      const sourceDecision =
        item.decision.publication?.producerDecision ?? item.leaseDecision ?? item.decision;
      const identity = {
        canonicalTargetKey: `${item.decision.targetRepo}#${item.decision.itemNumber}`,
        fenceKey: item.key,
        revision: membership.revision,
      };
      this.recordLifecycleAdmission(item, sourceDecision, now, membership.revision);
      if (!hasRunner) continue;
      this.lifecycleProjectionStore.recordClaim({
        ...identity,
        claimGeneration: membership.claimGeneration,
        runId: batch.runnerRunId,
        runAttempt: batch.runnerRunAttempt,
        observedAt: now,
      });
      // Batch publication begins only after the source review is materialized;
      // keep that immutable result even if this publication is later superseded.
      this.lifecycleProjectionStore.recordReviewResult({
        ...identity,
        claimGeneration: membership.claimGeneration,
        runId: batch.runnerRunId,
        runAttempt: batch.runnerRunAttempt,
        outcome: "completed",
        observedAt: now,
      });
    }
  }

  private recordLifecycleTerminal(
    identity: {
      canonicalTargetKey: string;
      fenceKey: string;
      revision: number;
      kind: LifecycleTerminalDisposition;
    },
    now: number,
  ) {
    const projection = this.lifecycleProjectionStore.read(
      identity.canonicalTargetKey,
      identity.fenceKey,
      identity.revision,
    );
    if (!projection) return;
    const terminal = this.lifecycleProjectionStore.recordTerminalDisposition({
      ...identity,
      kind: completionTerminalDisposition(projection, identity.kind) ?? identity.kind,
      observedAt: now,
    });
    this.syncBayLifecycle(terminal);
  }

  private recordHostedTargetTerminal(item: ExactReviewQueueItem, now: number) {
    this.recordLifecycleTerminal(
      { ...exactReviewTerminalFinalizationProjection(item, item.revision), kind: "superseded" },
      now,
    );
  }

  private directPublicationFenceSnapshot(
    validated: CanonicalDirectPublicationPlan,
    deferredBatchCompletion: boolean,
    now: number,
  ) {
    const state = this.readStateSync();
    const owned = state.items[validated.fenceKey];
    const existing = this.directPublicationStore.get(validated.fenceKey, validated.revision);
    const targetMatchesFence =
      owned &&
      `${owned.decision.targetRepo}#${owned.decision.itemNumber}` === validated.canonicalTargetKey;
    const directlyOwned =
      targetMatchesFence &&
      owned.revision === validated.revision &&
      exactReviewClaimGeneration(owned.claimGeneration) === validated.identity.claimGeneration &&
      validated.identity.canonicalTargetKey === validated.canonicalTargetKey &&
      validated.identity.fenceKey === validated.fenceKey &&
      validated.identity.revision === validated.revision &&
      (owned.state === "leased" ||
        (owned.state === "parked" && owned.parkedReason === "direct_publication"));
    const batchOwned =
      deferredBatchCompletion &&
      targetMatchesFence &&
      owned.revision === validated.revision &&
      this.batchStore.ownsActiveFence(
        {
          itemKey: validated.fenceKey,
          revision: validated.revision,
          claimGeneration: validated.identity.claimGeneration,
        },
        now,
      );
    const publicationRevision = owned && exactReviewPublicationRevision(owned.decision);
    const staleBatchFence =
      batchOwned &&
      publicationRevision &&
      publicationRevision.sourceRevision <
        this.publicationHeadRevisionSync(publicationRevision.targetKey);
    return {
      state,
      owned,
      existing,
      batchOwned,
      validFence: Boolean(directlyOwned || batchOwned),
      staleBatchFence: Boolean(staleBatchFence),
    };
  }

  private terminalizeHostedTargetQueueItem(
    state: ExactReviewQueueState,
    item: ExactReviewQueueItem,
    now: number,
  ) {
    // The target is no longer hosted-public. Commit the local terminal fact and
    // remove all target work; an acknowledgement driver would mint a write token.
    this.recordHostedTargetTerminal(item, now);
    delete state.items[item.key];
  }

  private publicationBatchClaimCandidates(
    state: ExactReviewQueueState,
    now: number,
    requestedSize: number,
    leaseSize: number,
    probedPairs: ReadonlySet<string> | null = null,
  ) {
    const control = this.refreshPublicationControlSync(state, now);
    return this.publicationBatchCandidates(
      state,
      now,
      this.batchStore.activeLeaseSnapshot(now),
      exactReviewPublicationCapacityForState(
        this.env,
        state,
        now,
        control.capacityCeiling,
        true,
        control.demandCapacity,
      ),
      requestedSize,
      leaseSize,
      probedPairs,
    );
  }

  private async hostedTargetAdmission(
    targetRepo: string,
    hostedTargetMetadataToken: HostedTargetMetadataToken,
    eligibilityPrepared = false,
    // Credential-bearing paths must probe live; only intake can consume the cache.
    intake = false,
  ): Promise<HostedTargetAdmission> {
    const normalizedRepo = targetRepo.trim().toLowerCase();
    const cacheKey = `hosted-target-admission:${normalizedRepo}`;
    const revocationKey = `hosted-target-admission-revoked:${normalizedRepo}`;
    const maxStaleMs = Math.max(
      0,
      numberFrom(this.env.EXACT_REVIEW_HOSTED_TARGET_ADMISSION_MAX_STALE_MS, 30 * 60_000),
    );
    const revocationRetentionMs = Math.max(maxStaleMs, 30 * 60_000);
    // Unique tokens fence probes across same-millisecond revocations and tombstone expiry.
    const revocation = objectValue(this.storage.kv.get(revocationKey));
    if (typeof revocation.at === "number" && Date.now() - revocation.at >= revocationRetentionMs) {
      this.storage.kv.delete(revocationKey);
    }
    const revocationToken = () => {
      const token = objectValue(this.storage.kv.get(revocationKey)).token;
      return typeof token === "string" ? token : null;
    };
    const revoke = () => {
      this.storage.kv.delete(cacheKey);
      this.storage.kv.put(revocationKey, { at: Date.now(), token: crypto.randomUUID() });
    };
    if (!eligibilityPrepared) {
      const eligibility = await this.hostedTargetEligibility(targetRepo);
      if (eligibility.outcome !== "eligible") {
        if (eligibility.outcome === "terminal") revoke();
        return eligibility.outcome === "terminal"
          ? { outcome: "terminal" }
          : {
              outcome: "retryable",
              ...(eligibility.retryAt ? { retryAt: eligibility.retryAt } : {}),
            };
      }
    }
    const cachedPublicAge = () => {
      const cached = objectValue(this.storage.kv.get(cacheKey));
      const age = Date.now() - Number(cached.observedAt);
      if (
        cached.outcome === "public" &&
        typeof cached.observedAt === "number" &&
        age >= 0 &&
        age < maxStaleMs
      ) {
        return age;
      }
      this.storage.kv.delete(cacheKey);
      return null;
    };
    const age = cachedPublicAge();
    if (intake && age !== null && age < exactReviewHostedTargetAdmissionFreshMs(this.env)) {
      return { outcome: "public" };
    }
    const injected = this.env.hostedPublicTargetProbe;
    const probeStartedAt = Date.now();
    const probeRevocationToken = revocationToken();
    let admission: HostedTargetAdmission;
    if (typeof injected === "function") {
      admission = normalizeHostedTargetAdmission(await injected(targetRepo));
    } else {
      try {
        admission = await probeHostedPublicTarget(
          targetRepo,
          await hostedTargetMetadataToken(),
          (input, init) => fetch(input, init),
          { apiUrl: (path) => githubApiUrl(this.env, path) },
        );
      } catch (error) {
        admission = hostedTargetRetryableAdmission(error);
      }
    }
    if (admission.outcome === "public") {
      // A tombstone that merely expired during the probe is not a new
      // observation; any token the probe did not start with is.
      const currentRevocationToken = revocationToken();
      if (currentRevocationToken !== null && currentRevocationToken !== probeRevocationToken) {
        return { outcome: "terminal" };
      }
      // A longer probe could miss both a revocation and its later expiry.
      if (Date.now() - probeStartedAt >= revocationRetentionMs) return { outcome: "retryable" };
      if (maxStaleMs > 0) {
        this.storage.kv.put(cacheKey, { outcome: "public", observedAt: Date.now() });
      }
    } else if (admission.outcome === "terminal") {
      revoke();
    } else if (admission.outcome === "retryable") {
      // Re-read after the probe: a concurrent terminal observation revokes fallback.
      if (cachedPublicAge() !== null && intake) return { outcome: "public" };
    }
    return admission;
  }

  private async hostedTargetEligibility(targetRepo: string): Promise<HostedTargetEligibility> {
    const configuredRepositories = Array.isArray(this.env.hostedTargetConfiguredRepositories)
      ? this.env.hostedTargetConfiguredRepositories.filter(
          (value): value is string => typeof value === "string",
        )
      : undefined;
    return resolveHostedTargetEligibility(targetRepo, (input, init) => fetch(input, init), {
      ...(configuredRepositories ? { configuredRepositories } : {}),
      ...(typeof this.env.hostedTargetPredicate === "function"
        ? {
            predicate: this.env.hostedTargetPredicate as (
              targetRepo: string,
            ) => boolean | Promise<boolean>,
          }
        : {}),
    });
  }

  private hasPreparedHostedTargetEligibility(request: Request, targetRepo: string): boolean {
    return (
      request.headers.get(HOSTED_TARGET_ELIGIBILITY_HEADER)?.trim().toLowerCase() ===
      targetRepo.trim().toLowerCase()
    );
  }

  private async hostedTargetAdmissions(
    targetRepos: Iterable<string>,
    hostedTargetMetadataToken: HostedTargetMetadataToken,
  ) {
    return new Map(
      await mapWithConcurrency(
        [...new Set(targetRepos)],
        EXACT_REVIEW_ADMISSION_LIVE_CHECK_CONCURRENCY,
        async (targetRepo) =>
          [
            targetRepo,
            await this.hostedTargetAdmission(targetRepo, hostedTargetMetadataToken),
          ] as const,
      ),
    );
  }

  private recordLifecycleDirectPublication({ validated, owned, accepted, now, publicationPath }) {
    const sourceDecision = owned?.decision.publication
      ? owned.decision.publication.producerDecision
      : (owned?.leaseDecision ?? owned?.decision);
    const commandOriginated = Boolean(
      sourceDecision?.commandStatusMarker || sourceDecision?.statusCommentId,
    );
    const identity = {
      canonicalTargetKey: validated.canonicalTargetKey,
      fenceKey: validated.fenceKey,
      revision: validated.revision,
    };
    const existingProjection = this.lifecycleProjectionStore.read(
      identity.canonicalTargetKey,
      identity.fenceKey,
      identity.revision,
    );
    if (existingProjection && existingProjection.fenceKey !== identity.fenceKey) {
      throw new Error("conflicting lifecycle projection identity");
    }
    const statusMarker = sourceDecision?.commandStatusMarker ?? null;
    const statusCommentId = sourceDecision?.statusCommentId ?? null;
    if (!existingProjection) {
      this.lifecycleProjectionStore.recordAdmission({
        ...identity,
        deliveryId:
          owned?.admissionDeliveryId ?? `publication:${validated.fenceKey}:${validated.revision}`,
        sourceAction: sourceDecision?.sourceAction ?? "exact_review_publication",
        commandOriginated,
        statusMarker,
        statusCommentId,
        ...(sourceDecision?.sourceDeliveryId
          ? { sourceDeliveryId: sourceDecision.sourceDeliveryId }
          : {}),
        observedAt: now,
      });
    }
    const recordedClaim = existingProjection?.claims.find(
      (claim) => claim.claimGeneration === validated.identity.claimGeneration,
    );
    const runId = recordedClaim?.runId ?? String(owned?.claimedRunId || "");
    const runAttempt = recordedClaim?.runAttempt ?? exactReviewRunAttempt(owned?.claimedRunAttempt);
    if (/^\d+$/.test(runId)) {
      const claimGeneration = recordedClaim?.claimGeneration ?? validated.identity.claimGeneration;
      this.lifecycleProjectionStore.recordClaim({
        ...identity,
        claimGeneration,
        runId,
        runAttempt,
        observedAt: now,
      });
      this.lifecycleProjectionStore.recordReviewResult({
        ...identity,
        claimGeneration,
        runId,
        runAttempt,
        outcome: "completed",
        observedAt: now,
      });
    }
    const effect = exactReviewGithubEffect(validated.operations);
    if (effect)
      this.lifecycleProjectionStore.recordGithubEffect({ ...identity, ...effect, observedAt: now });
    this.lifecycleProjectionStore.recordCanonicalReceipt({
      ...identity,
      outcome: accepted.outcome,
      receiptId: `${publicationPath === "batch" ? "batch" : "direct-v2"}:${validated.fenceKey}:${validated.revision}:${accepted.outcome}`,
      observedAt: now,
    });
    if (accepted.outcome === "superseded") {
      const terminal = this.lifecycleProjectionStore.recordTerminalDisposition({
        ...identity,
        kind: "superseded",
        observedAt: now,
      });
      this.syncBayLifecycle(terminal);
    }
  }

  private syncBayLifecycle(projection: ExactReviewLifecycleProjection) {
    try {
      if (!this.lifecycleTelemetryStore.syncBayLifecycle(projection)) return false;
      return true;
    } catch {
      return false;
    }
  }

  private bayTelemetryRecoveryPendingSync() {
    return this.lifecycleTelemetryStore.hasBayLifecyclePending(true);
  }

  private reconcileBayTelemetryInternalSync(now = Date.now()) {
    if (this.bayTelemetryNoProgressDeadline && now < this.bayTelemetryNoProgressDeadline)
      return false;
    let progressed = false;
    try {
      const source = this.lifecycleProjectionStore.reconcileBayTelemetryPending((projection) =>
        this.lifecycleTelemetryStore.syncBayLifecycle(projection),
      );
      progressed = source.progressed;
      const outbox = this.lifecycleTelemetryStore.reconcileBayLifecyclePending();
      const pending = source.pending || outbox.pending;
      this.bayTelemetryNoProgressDeadline =
        pending && !(progressed || outbox.progressed) ? now + 60_000 : null;
      return !pending;
    } catch {
      this.bayTelemetryNoProgressDeadline = progressed ? null : now + 60_000;
      return false;
    }
  }

  private recordLifecycleTelemetryDirect({ validated, outcome, observedAt }) {
    try {
      this.lifecycleTelemetryStore.recordDirectOutcome({
        canonicalTargetKey: validated.canonicalTargetKey,
        fenceKey: validated.fenceKey,
        revision: validated.revision,
        claimGeneration: validated.identity.claimGeneration,
        outcome,
        observedAt,
      });
    } catch {
      console.warn("lifecycle_telemetry_direct_outcome_not_recorded");
    }
  }

  private recordLifecycleTelemetryBatch({
    batchId,
    canonicalTargetKey,
    fenceKey,
    revision,
    claimGeneration,
    outcome,
    observedAt,
  }) {
    try {
      this.lifecycleTelemetryStore.recordBatchOutcome({
        batchId,
        canonicalTargetKey,
        fenceKey,
        revision,
        claimGeneration,
        outcome,
        observedAt,
      });
    } catch {
      console.warn("lifecycle_telemetry_batch_outcome_not_recorded");
    }
  }

  private recordLifecycleTelemetryNonBatchPublication({
    identity,
    claimGeneration,
    completion,
    projection,
    observedAt,
  }: {
    identity: ExactReviewLifecycleProjectionIdentity;
    claimGeneration: number;
    completion: ExactReviewPublicationCompletion;
    projection: ExactReviewLifecycleProjection | null;
    observedAt: number;
  }) {
    const outcome = exactReviewLifecycleTelemetryPublicationOutcome(completion);
    if (!outcome) return;
    if (
      outcome === "superseded" &&
      projection?.canonicalReceipts.some((receipt) => receipt.outcome === "superseded")
    ) {
      return;
    }
    this.recordLifecycleTelemetryBatch({
      // The table retains a batch identifier for replay-safe event keys. This
      // established completion route has no batch lease, so a fixed source
      // label preserves that distinction without inventing one.
      batchId: "non-batch-completion",
      ...identity,
      claimGeneration,
      outcome,
      observedAt,
    });
  }

  private recordLifecycleCompletion({
    item,
    revision,
    claimGeneration,
    runId,
    runAttempt,
    outcome,
    publicationCompletion,
    requeued,
    parked,
    deadLetter,
    lifecycleTerminal,
    now,
  }) {
    const identity = {
      canonicalTargetKey: `${item.decision.targetRepo}#${item.decision.itemNumber}`,
      fenceKey: item.key,
      revision,
    };
    const reviewed = this.lifecycleProjectionStore.recordReviewResultIfPresent({
      ...identity,
      claimGeneration,
      runId,
      runAttempt,
      outcome: outcome === "success" ? "completed" : outcome === "failure" ? "failed" : outcome,
      observedAt: now,
    });
    if (!reviewed) return;
    const disposition = exactReviewLifecycleCompletionDisposition({
      projection: reviewed,
      outcome,
      publicationCompletion,
      requeued,
      parked,
      deadLetter,
      lifecycleTerminal,
    });
    if (disposition) {
      const terminal = this.lifecycleProjectionStore.recordTerminalDisposition({
        ...identity,
        kind: disposition,
        observedAt: now,
      });
      this.syncBayLifecycle(terminal);
      return terminal;
    }
    return reviewed;
  }

  private recordLifecycleCanonicalReceipt(value: unknown) {
    const body = objectValue(value);
    const identity = exactReviewLifecycleIdentity(body);
    const receiptId = typeof body.receipt_id === "string" ? body.receipt_id : "";
    const outcome = body.outcome;
    if (
      !identity ||
      !receiptId ||
      (outcome !== "accepted" && outcome !== "deduped" && outcome !== "superseded")
    ) {
      return json({ error: "invalid_lifecycle_canonical_receipt" }, 400);
    }
    try {
      const projection = this.lifecycleProjectionStore.recordCanonicalReceipt({
        ...identity,
        outcome,
        receiptId,
        observedAt: Date.now(),
      });
      return json({
        ok: true,
        lifecycle_state: lifecycleState(projection),
        version: projection.version,
      });
    } catch {
      console.warn("lifecycle_canonical_receipt_rejected");
      return json({ error: "invalid_lifecycle_canonical_receipt" }, 409);
    }
  }

  private async recordLifecycleRouterReceipt(value: unknown) {
    const body = objectValue(value);
    const identity = exactReviewLifecycleIdentity(body);
    const receiptId = typeof body.receipt_id === "string" ? body.receipt_id : "";
    const outcome = body.outcome === undefined ? "durable" : body.outcome;
    if (!identity || !receiptId || (outcome !== "durable" && outcome !== "not_required")) {
      return json({ error: "invalid_lifecycle_router_receipt" }, 400);
    }
    try {
      const now = Date.now();
      let state: ExactReviewQueueState | undefined;
      const result = this.storage.transactionSync(() => {
        const existing = this.lifecycleProjectionStore.read(
          identity.canonicalTargetKey,
          identity.fenceKey,
          identity.revision,
        );
        const receipt = existing?.routerReceipts.find((entry) => entry.receiptId === receiptId);
        const terminal = existing?.terminalDisposition;
        const result = this.lifecycleProjectionStore.recordRouterReceiptSync({
          ...identity,
          outcome,
          receiptId,
          observedAt: now,
          operationComplete: true,
        });
        // Preserve a committed requeue without a receipt, plus f7's ordering
        // rule for a matching receipt followed by a later terminal outcome.
        if (
          result.duplicate ||
          terminal?.kind === "requeue" ||
          (receipt &&
            terminal &&
            terminal.kind !== "review_completed_routed" &&
            terminal.observedAt >= receipt.observedAt)
        ) {
          return result;
        }
        const projection = this.lifecycleProjectionStore.recordTerminalDispositionSync({
          ...identity,
          kind: "review_completed_routed",
          observedAt: now,
        }).projection;
        state = this.readStateSync();
        const driverChanged = this.ensureLifecycleTerminalFinalizationDriver({
          state,
          projection,
          now,
        });
        const receiptRemoved = this.removeTerminalizedLifecycleQueueItem(state, identity);
        // Commit the replay marker and all durable effects together.
        if (driverChanged || receiptRemoved) this.writeStateSync(state);
        return { projection, duplicate: false };
      });
      this.syncBayLifecycle(result.projection);
      await this.scheduleNext(state ?? this.readSchedulingStateSync(), now);
      return json({
        ok: true,
        lifecycle_state: lifecycleState(result.projection),
        version: result.projection.version,
      });
    } catch {
      console.warn("lifecycle_router_receipt_rejected");
      return json({ error: "invalid_lifecycle_router_receipt" }, 409);
    }
  }

  private ensureLifecycleTerminalFinalizationDriver({
    state,
    projection,
    terminalDisposition,
    now,
  }: {
    state: ExactReviewQueueState;
    projection: ExactReviewLifecycleProjection;
    terminalDisposition?: Exclude<LifecycleTerminalDisposition, "requeue"> | null;
    now: number;
  }) {
    const identity: ExactReviewLifecycleProjectionIdentity = {
      canonicalTargetKey: projection.canonicalTargetKey,
      fenceKey: projection.fenceKey,
      revision: projection.revision,
    };
    const disposition = terminalDisposition ?? projection.terminalDisposition?.kind;
    const acknowledgementPending =
      commandAcknowledgementState(projection) === "pending" ||
      (Boolean(terminalDisposition) &&
        projection.admission.commandOriginated &&
        !projection.acknowledgement.observed &&
        commandAcknowledgementState(projection) !== "skipped_locked" &&
        commandAcknowledgementState(projection) !== "skipped_missing_comment");
    if (
      !disposition ||
      disposition === "requeue" ||
      !projection.admission.commandOriginated ||
      !acknowledgementPending
    ) {
      return false;
    }
    const driverKey = exactReviewTerminalFinalizationDriverKey(identity);
    const existing = state.items[driverKey];
    if (existing) {
      const existingIdentity = exactReviewTerminalFinalizationProjection(
        existing,
        existing.revision,
      );
      if (
        !existing.terminalFinalization ||
        existingIdentity.canonicalTargetKey !== identity.canonicalTargetKey ||
        existingIdentity.fenceKey !== identity.fenceKey ||
        existingIdentity.revision !== identity.revision
      ) {
        throw new Error("conflicting direct lifecycle terminal finalization driver");
      }
      return false;
    }
    const decision = exactReviewTerminalFinalizationDecision(projection);
    state.items[driverKey] = {
      key: driverKey,
      decision,
      admissionDeliveryId: `terminal-finalization:${identity.fenceKey}:${identity.revision}`,
      state: "pending",
      revision: identity.revision,
      createdAt: now,
      updatedAt: now,
      nextAttemptAt: now,
      attempts: 0,
      terminalFinalization: exactReviewTerminalFinalization(disposition, identity),
    };
    return true;
  }

  private ensureTerminalFinalizationDriver({
    state,
    item,
    sourceDecision,
    projection,
    terminalFinalization,
    now,
  }: {
    state: ExactReviewQueueState;
    item: ExactReviewQueueItem;
    sourceDecision?: ExactReviewDecision;
    projection: ExactReviewLifecycleProjection | null;
    terminalFinalization: ExactReviewTerminalFinalization;
    now: number;
  }) {
    if (projection) {
      return this.ensureLifecycleTerminalFinalizationDriver({
        state,
        projection,
        terminalDisposition: terminalFinalization.disposition,
        now,
      });
    }
    const identity = exactReviewTerminalFinalizationProjection(item, item.revision);
    const driverKey = exactReviewTerminalFinalizationDriverKey(identity);
    const existing = state.items[driverKey];
    if (existing) {
      const existingIdentity = exactReviewTerminalFinalizationProjection(
        existing,
        existing.revision,
      );
      if (
        !existing.terminalFinalization ||
        existingIdentity.canonicalTargetKey !== identity.canonicalTargetKey ||
        existingIdentity.fenceKey !== identity.fenceKey ||
        existingIdentity.revision !== identity.revision
      ) {
        throw new Error("conflicting terminal finalization driver");
      }
      return false;
    }
    state.items[driverKey] = {
      key: driverKey,
      decision: sourceDecision ?? item.leaseDecision ?? item.decision,
      admissionDeliveryId: `terminal-finalization:${identity.fenceKey}:${identity.revision}`,
      state: "pending",
      revision: identity.revision,
      createdAt: now,
      updatedAt: now,
      nextAttemptAt: now,
      attempts: 0,
      terminalFinalization: exactReviewTerminalFinalization(
        terminalFinalization.disposition,
        identity,
      ),
    };
    return true;
  }

  private removeTerminalizedLifecycleQueueItem(
    state: ExactReviewQueueState,
    identity: ExactReviewLifecycleProjectionIdentity,
  ) {
    const item = state.items[identity.fenceKey];
    const driverKey = exactReviewTerminalFinalizationDriverKey(identity);
    if (
      !item ||
      !state.items[driverKey]?.terminalFinalization ||
      item.revision !== identity.revision ||
      item.terminalFinalization ||
      (item.state !== "pending" && item.state !== "parked") ||
      item.decision.sourceAction !== EXACT_REVIEW_ARTIFACT_PUBLISH_SOURCE_ACTION
    ) {
      return false;
    }
    delete state.items[item.key];
    return true;
  }

  private cancelTerminalFinalizationDrivers(
    state: ExactReviewQueueState,
    identity: ExactReviewLifecycleProjectionIdentity,
  ) {
    let cancelled = false;
    for (const item of Object.values(state.items)) {
      if (!item.terminalFinalization) continue;
      const driverIdentity = exactReviewTerminalFinalizationProjection(item, item.revision);
      if (
        driverIdentity.canonicalTargetKey !== identity.canonicalTargetKey ||
        driverIdentity.fenceKey !== identity.fenceKey ||
        driverIdentity.revision !== identity.revision
      ) {
        continue;
      }
      delete state.items[item.key];
      cancelled = true;
    }
    return cancelled;
  }

  private authorizeLifecycleCommandAcknowledgement(value: unknown) {
    const body = objectValue(value);
    const identity = exactReviewLifecycleIdentity(body);
    const statusMarker =
      body.status_marker === undefined || body.status_marker === null
        ? null
        : typeof body.status_marker === "string"
          ? body.status_marker
          : "";
    const statusCommentId =
      body.status_comment_id === undefined || body.status_comment_id === null
        ? null
        : Number(body.status_comment_id);
    if (
      !identity ||
      (statusMarker !== null && !statusMarker) ||
      (statusCommentId !== null && (!Number.isSafeInteger(statusCommentId) || statusCommentId < 1))
    ) {
      return json({ error: "invalid_lifecycle_acknowledgement_attempt" }, 400);
    }
    try {
      const result = this.lifecycleProjectionStore.authorizeCommandAcknowledgement({
        ...identity,
        statusMarker,
        statusCommentId,
        observedAt: Date.now(),
      });
      return json({
        ok: true,
        allowed: result.allowed,
        lifecycle_state: result.lifecycle,
        acknowledgement_state: result.acknowledgement,
        ...(result.attemptId ? { attempt_id: result.attemptId } : {}),
        version: result.projection.version,
      });
    } catch {
      console.warn("lifecycle_acknowledgement_rejected");
      return json({ error: "invalid_lifecycle_acknowledgement_attempt" }, 409);
    }
  }

  private async beginTerminalFinalizationAcknowledgement(value: unknown) {
    const tuple = exactReviewTerminalFinalizationTuple(value);
    const body = objectValue(value);
    const statusMarker =
      body.status_marker === undefined || body.status_marker === null
        ? null
        : typeof body.status_marker === "string"
          ? body.status_marker
          : "";
    const statusCommentId =
      body.status_comment_id === undefined || body.status_comment_id === null
        ? null
        : Number(body.status_comment_id);
    if (
      !tuple ||
      (statusMarker !== null && !statusMarker) ||
      (statusCommentId !== null && (!Number.isSafeInteger(statusCommentId) || statusCommentId < 1))
    ) {
      return json({ error: "invalid_terminal_finalization_acknowledgement" }, 400);
    }
    const now = Date.now();
    const state = this.readStateSync();
    const item = state.items[tuple.itemKey];
    if (!exactReviewTerminalFinalizationLeaseActive(item, tuple, now, this.env)) {
      return json({ error: "lease_not_active" }, 409);
    }
    const finalization = item.terminalFinalization!;
    const identity = exactReviewTerminalFinalizationProjection(item, tuple.leaseRevision);
    try {
      const terminal = this.lifecycleProjectionStore.recordTerminalDisposition({
        ...identity,
        kind: finalization.disposition,
        observedAt: now,
      });
      this.syncBayLifecycle(terminal);
      const result = this.lifecycleProjectionStore.authorizeCommandAcknowledgement({
        ...identity,
        statusMarker,
        statusCommentId,
        observedAt: now,
      });
      await this.scheduleNext(this.readSchedulingStateSync(), now);
      return json({
        ok: true,
        allowed: result.allowed,
        lifecycle_state: result.lifecycle,
        acknowledgement_state: result.acknowledgement,
        terminal_disposition: finalization.disposition,
        status_state: finalization.statusState,
        status_detail: finalization.statusDetail,
        ...(result.attemptId ? { attempt_id: result.attemptId } : {}),
        version: result.projection.version,
      });
    } catch {
      console.warn("terminal_finalization_acknowledgement_rejected");
      return json({ error: "invalid_terminal_finalization_acknowledgement" }, 409);
    }
  }

  private async retryTerminalFinalization(value: unknown) {
    const tuple = exactReviewTerminalFinalizationTuple(value);
    if (!tuple) return json({ error: "invalid_terminal_finalization_retry" }, 400);
    const now = Date.now();
    const state = this.readStateSync();
    const item = state.items[tuple.itemKey];
    if (!exactReviewTerminalFinalizationLeaseActive(item, tuple, now, this.env)) {
      return json({ error: "lease_not_active" }, 409);
    }
    const identity = exactReviewTerminalFinalizationProjection(item, tuple.leaseRevision);
    const projection = this.lifecycleProjectionStore.read(
      identity.canonicalTargetKey,
      identity.fenceKey,
      identity.revision,
    );
    if (projection?.acknowledgement.observed) {
      delete state.items[item.key];
      await this.writeState(state);
      await this.scheduleNext(state, now);
      return json({ ok: true, completed: true });
    }
    clearExactReviewLease(item);
    item.state = "pending";
    item.nextAttemptAt = now + EXACT_REVIEW_ACKNOWLEDGEMENT_ATTEMPT_LEASE_MS;
    item.backoffReason = "publication_retry";
    item.updatedAt = now;
    await this.writeState(state);
    await this.scheduleNext(state, now);
    return json({ ok: true, requeued: true });
  }

  private async skipTerminalFinalization(value: unknown) {
    const tuple = exactReviewTerminalFinalizationTuple(value);
    const body = objectValue(value);
    const attemptId = typeof body.attempt_id === "string" ? body.attempt_id : "";
    const statusMarker =
      body.status_marker === undefined || body.status_marker === null
        ? null
        : typeof body.status_marker === "string"
          ? body.status_marker
          : "";
    const statusCommentId =
      body.status_comment_id === undefined || body.status_comment_id === null
        ? null
        : Number(body.status_comment_id);
    const reason = body.reason;
    if (
      !tuple ||
      !/^ack:[1-9]\d*$/.test(attemptId) ||
      (reason !== "locked_conversation" && reason !== "missing_status_comment") ||
      (statusMarker !== null && !statusMarker) ||
      (statusCommentId !== null && (!Number.isSafeInteger(statusCommentId) || statusCommentId < 1))
    ) {
      return json({ error: "invalid_terminal_finalization_skip" }, 400);
    }
    const now = Date.now();
    const state = this.readStateSync();
    const item = state.items[tuple.itemKey];
    if (!exactReviewTerminalFinalizationLeaseActive(item, tuple, now, this.env)) {
      return json({ error: "lease_not_active" }, 409);
    }
    const identity = exactReviewTerminalFinalizationProjection(item, tuple.leaseRevision);
    try {
      const result = this.lifecycleProjectionStore.recordCommandAcknowledgementTerminalSkip({
        ...identity,
        attemptId,
        statusMarker,
        statusCommentId,
        reason,
        observedAt: now,
      });
      if (!result.skipped) {
        return json({ error: "acknowledgement_not_active" }, 409);
      }
      delete state.items[item.key];
      await this.writeState(state);
      await this.scheduleNext(state, now);
      return json({
        ok: true,
        completed: true,
        lifecycle_state: lifecycleState(result.projection),
        acknowledgement_state: commandAcknowledgementState(result.projection),
        version: result.projection.version,
      });
    } catch {
      console.warn("terminal_finalization_skip_rejected");
      return json({ error: "invalid_terminal_finalization_skip" }, 409);
    }
  }

  private async observeLifecycleCommandAcknowledgement(
    value: unknown,
    request: Request,
    hostedTargetMetadataToken: HostedTargetMetadataToken,
  ) {
    const body = objectValue(value);
    const canonicalTargetKey =
      typeof body.canonical_target_key === "string" ? body.canonical_target_key : "";
    const canonicalTarget = canonicalTargetKey.match(
      /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#[1-9]\d*$/,
    );
    const fenceKey = body.fence_key;
    const revision = body.revision;
    const statusMarker =
      body.status_marker === undefined || body.status_marker === null
        ? null
        : typeof body.status_marker === "string"
          ? body.status_marker
          : "";
    const commandCommentId = Number(body.command_comment_id);
    const completionCommentId = Number(body.completion_comment_id);
    const statusCommentId = body.status_comment_id;
    const includeDeliveryIdentity = body.include_delivery_identity;
    const requireExactStatusComment = body.require_exact_status_comment;
    const observedAt = Number(body.observed_at);
    const receivedAt = Date.now();
    const recordedAt = Math.min(observedAt, receivedAt);
    if (
      !canonicalTargetKey ||
      (fenceKey === undefined) !== (revision === undefined) ||
      (fenceKey !== undefined && (typeof fenceKey !== "string" || !fenceKey)) ||
      (revision !== undefined && (!Number.isSafeInteger(revision) || Number(revision) < 1)) ||
      (statusMarker !== null && !statusMarker) ||
      !Number.isSafeInteger(commandCommentId) ||
      commandCommentId < 1 ||
      !Number.isSafeInteger(completionCommentId) ||
      completionCommentId < 1 ||
      (statusCommentId !== undefined &&
        (!Number.isSafeInteger(statusCommentId) || Number(statusCommentId) < 1)) ||
      (includeDeliveryIdentity !== undefined && typeof includeDeliveryIdentity !== "boolean") ||
      (requireExactStatusComment !== undefined && typeof requireExactStatusComment !== "boolean") ||
      !Number.isSafeInteger(observedAt) ||
      observedAt < 1
    ) {
      return json({ error: "invalid_lifecycle_acknowledgement_receipt" }, 400);
    }
    if (!canonicalTarget) {
      return json({ error: "invalid_lifecycle_acknowledgement_receipt" }, 400);
    }
    const targetRepo = canonicalTarget[1]!;
    // Re-probe at the persistence owner so a Worker-level public check cannot
    // race a private transition before the synchronous lifecycle write.
    const admission = await this.hostedTargetAdmission(
      targetRepo,
      hostedTargetMetadataToken,
      this.hasPreparedHostedTargetEligibility(request, targetRepo),
    );
    if (admission.outcome !== "public") {
      if (admission.outcome === "terminal") {
        const state = this.readStateSync();
        if (this.removeTerminalFinalizationDriversForTarget(state, canonicalTargetKey)) {
          await this.writeState(state);
          await this.scheduleNext(state, receivedAt);
        }
      }
      return hostedTargetProbeResponse(admission);
    }
    try {
      const result = this.lifecycleProjectionStore.observeCommandAcknowledgement({
        canonicalTargetKey,
        ...(fenceKey === undefined
          ? {}
          : { fenceKey: String(fenceKey), revision: Number(revision) }),
        statusMarker,
        commandCommentId,
        completionCommentId,
        ...(statusCommentId === undefined ? {} : { statusCommentId: Number(statusCommentId) }),
        ...(requireExactStatusComment ? { requireExactStatusComment: true } : {}),
        observedAt: recordedAt,
      });
      // The final command-status receipt is the end-to-end Bay boundary. The
      // routing terminal was recorded earlier and must not publish a duration
      // until this correlated receipt has arrived.
      if (result.accepted && result.projection) {
        // observeCommandAcknowledgement persists the observed receipt and its
        // outbox marker atomically. Materialization may then fail and replay
        // safely, but it cannot lose this timing boundary between writes.
        this.syncBayLifecycle(result.projection);
      }
      if (result.accepted && result.projection) {
        const state = this.readStateSync();
        const drivers = Object.values(state.items).filter((item) => {
          if (!item.terminalFinalization) return false;
          const identity = exactReviewTerminalFinalizationProjection(item, item.revision);
          return (
            identity.canonicalTargetKey === result.projection?.canonicalTargetKey &&
            identity.fenceKey === result.projection?.fenceKey &&
            identity.revision === result.projection?.revision
          );
        });
        if (drivers.length) {
          for (const driver of drivers) delete state.items[driver.key];
          await this.writeState(state);
          await this.scheduleNext(state, recordedAt);
        }
      }
      return json({
        ok: true,
        accepted: result.accepted,
        lifecycle_state: result.state,
        acknowledgement_state: result.acknowledgement,
        ...(result.projection ? { version: result.projection.version } : {}),
        ...((fenceKey !== undefined || includeDeliveryIdentity === true) &&
        result.projection?.admission.sourceDeliveryId
          ? { source_delivery_id: result.projection.admission.sourceDeliveryId }
          : {}),
        ...((fenceKey !== undefined || includeDeliveryIdentity === true) &&
        result.projection?.admission.bayJourneyDeliveryId
          ? { bay_journey_delivery_id: result.projection.admission.bayJourneyDeliveryId }
          : {}),
      });
    } catch {
      console.warn("lifecycle_acknowledgement_receipt_rejected");
      return json({ error: "invalid_lifecycle_acknowledgement_receipt" }, 409);
    }
  }

  private removeTerminalFinalizationDriversForTarget(
    state: ExactReviewQueueState,
    canonicalTargetKey: string,
  ) {
    let removed = false;
    for (const item of Object.values(state.items)) {
      if (
        item.terminalFinalization &&
        exactReviewTerminalFinalizationProjection(item, item.revision).canonicalTargetKey ===
          canonicalTargetKey
      ) {
        delete state.items[item.key];
        removed = true;
      }
    }
    return removed;
  }

  private releaseLifecycleCommandAcknowledgement(value: unknown) {
    const body = objectValue(value);
    const identity = exactReviewLifecycleIdentity(body);
    const attemptId = typeof body.attempt_id === "string" ? body.attempt_id : "";
    const statusMarker =
      body.status_marker === undefined || body.status_marker === null
        ? null
        : typeof body.status_marker === "string"
          ? body.status_marker
          : "";
    const statusCommentId =
      body.status_comment_id === undefined || body.status_comment_id === null
        ? null
        : Number(body.status_comment_id);
    if (
      !identity ||
      !/^ack:[1-9]\d*$/.test(attemptId) ||
      (statusMarker !== null && !statusMarker) ||
      (statusCommentId !== null && (!Number.isSafeInteger(statusCommentId) || statusCommentId < 1))
    ) {
      return json({ error: "invalid_lifecycle_acknowledgement_failure" }, 400);
    }
    try {
      const result = this.lifecycleProjectionStore.recordCommandAcknowledgementFailure({
        ...identity,
        attemptId,
        statusMarker,
        statusCommentId,
        observedAt: Date.now(),
      });
      return json({
        ok: true,
        released: result.released,
        lifecycle_state: lifecycleState(result.projection),
        acknowledgement_state: commandAcknowledgementState(result.projection),
        version: result.projection.version,
      });
    } catch {
      console.warn("lifecycle_acknowledgement_release_rejected");
      return json({ error: "invalid_lifecycle_acknowledgement_failure" }, 409);
    }
  }

  private async recordLifecycleTerminalDisposition(value: unknown) {
    const body = objectValue(value);
    const identity = exactReviewLifecycleIdentity(body);
    const kind = exactReviewLifecycleTerminalDisposition(body.kind);
    const operationId = body.operation_id;
    if (
      !identity ||
      !kind ||
      (operationId !== undefined &&
        (typeof operationId !== "string" ||
          !operationId.length ||
          operationId.length > 300 ||
          /[\r\n]/.test(operationId)))
    ) {
      return json({ error: "invalid_lifecycle_terminal_disposition" }, 400);
    }
    try {
      const now = Date.now();
      const result = this.storage.transactionSync(() => {
        const result = this.lifecycleProjectionStore.recordTerminalDispositionSync({
          ...identity,
          kind,
          operationId,
          observedAt: now,
        });
        if (result.duplicate) return result;
        const state = this.readStateSync();
        const driverCancelled =
          kind === "requeue" ? this.cancelTerminalFinalizationDrivers(state, identity) : false;
        const driverChanged =
          kind === "requeue"
            ? false
            : this.ensureLifecycleTerminalFinalizationDriver({
                state,
                projection: result.projection,
                terminalDisposition: kind,
                now,
              });
        const receiptRemoved = this.removeTerminalizedLifecycleQueueItem(state, identity);
        if (driverChanged || driverCancelled || receiptRemoved) this.writeStateSync(state);
        return result;
      });
      this.syncBayLifecycle(result.projection);
      await this.scheduleNext(this.readStateSync(), now);
      return json({
        ok: true,
        lifecycle_state: lifecycleState(result.projection),
        acknowledgement_state: commandAcknowledgementState(result.projection),
        version: result.projection.version,
      });
    } catch (error) {
      console.warn("lifecycle_terminal_disposition_rejected");
      if (error instanceof Error && error.message === "conflicting lifecycle terminal operation") {
        return json({ error: "conflicting_lifecycle_terminal_operation" }, 409);
      }
      return json({ error: "invalid_lifecycle_terminal_disposition" }, 409);
    }
  }

  private requeueDirectLifecyclePublicationSync(
    state: ExactReviewQueueState,
    item: ExactReviewQueueItem,
    now: number,
  ) {
    const publication = item.leaseDecision?.publication;
    if (publication?.directLifecycle?.plan.kind !== "requeue") {
      throw new Error("direct lifecycle requeue requires an exact direct receipt");
    }
    const completedRevision = item.revision;
    const decision: ExactReviewDecision = {
      ...publication.producerDecision,
      sourceAction:
        publication.producerDecision.sourceAction === FAILED_REVIEW_SHARD_RECOVERY_SOURCE_ACTION
          ? FAILED_REVIEW_SHARD_RECOVERY_SOURCE_ACTION
          : EXACT_REVIEW_SOURCE_DRIFT_REQUEUE_SOURCE_ACTION,
      supersedesInProgress: true,
    };
    // This is a new review revision, not a replay of the direct receipt. The
    // old fenced projection retains its requeue terminal fact while the new
    // item receives fresh admission and claim facts when it is dispatched.
    clearExactReviewLease(item);
    item.decision = decision;
    item.admissionDeliveryId = `direct-lifecycle-requeue:${item.key}:${completedRevision}`;
    item.ingressFingerprint = undefined;
    item.state = "pending";
    item.revision = exactReviewDecisionHasCommandContext(decision)
      ? this.nextExactReviewCommandRevisionSync(item.key, item.revision + 1)
      : this.nextExactReviewItemRevisionSync(item.key, item.revision + 1);
    item.createdAt = now;
    item.updatedAt = now;
    item.parkedReason = undefined;
    item.parkedRecoveryAttempts = 0;
    item.terminalFinalization = undefined;
    item.attempts = 0;
    item.publicationFailureAttempts = 0;
    item.reviewFailureAttempts = 0;
    item.reviewRetryPolicyEpoch = exactReviewRetryPolicyEpoch(this.env);
    item.firstFailureAt = undefined;
    item.lastFailureReason = undefined;
    clearExactReviewDispatchFailure(item);
    clearExactReviewReviewRecovery(item);
    Object.assign(item, exactReviewQueueDebouncedAttempt(state, decision, now, now, this.env));
    advanceExactReviewSourceAuthorityWatermark(item, decision);
    return {
      requeued: true,
      retried: false,
      refreshed: false,
      parked: false,
      deadLetter: undefined,
    };
  }

  private publicationHeadRevisionSync(targetKey: string): number {
    const row = Array.from(
      this.storage.sql.exec(
        `SELECT source_revision FROM ${EXACT_REVIEW_PUBLICATION_HEAD_TABLE} WHERE target_key = ?`,
        targetKey,
      ),
    )[0] as { source_revision?: number } | undefined;
    return Number(row?.source_revision || 0);
  }

  private publicationHeadsSync(state: ExactReviewQueueState): ReadonlyMap<string, number> {
    const targets = [
      ...new Set(
        Object.values(state.items).flatMap((item) => {
          const revision = exactReviewPublicationRevision(item.decision);
          return revision ? [revision.targetKey] : [];
        }),
      ),
    ];
    if (!targets.length) return new Map();
    return new Map(
      Array.from(
        this.storage.sql.exec(
          `SELECT target_key, source_revision FROM ${EXACT_REVIEW_PUBLICATION_HEAD_TABLE}
       WHERE target_key IN (SELECT value FROM json_each(?))`,
          JSON.stringify(targets),
        ) as Iterable<{ target_key: string; source_revision: number }>,
        (row) => [row.target_key, Number(row.source_revision)],
      ),
    );
  }

  private supersededPublicationItemKeysSync(
    state: ExactReviewQueueState,
    heads = this.publicationHeadsSync(state),
  ) {
    // Active batch ownership can preserve an older row after a newer head lands.
    // Departure and claim must exclude that same row when ownership expires.
    return new Set(
      Object.values(state.items).flatMap((item) => {
        const revision = exactReviewPublicationRevision(item.decision);
        return revision && revision.sourceRevision < (heads.get(revision.targetKey) ?? 0)
          ? [item.key]
          : [];
      }),
    );
  }

  private nextExactReviewItemRevisionSync(itemKey: string, minimumRevision = 1): number {
    return Math.max(minimumRevision, this.publicationHeadRevisionSync(itemKey.toLowerCase()) + 1);
  }

  private nextExactReviewCommandRevisionSync(itemKey: string, minimumRevision: number): number {
    const canonicalKey = itemKey.split("@publish:")[0]!.toLowerCase();
    return this.commandIntakeStore.allocateItemRevision(
      canonicalKey,
      minimumRevision,
      this.lifecycleProjectionStore.maxRevision(canonicalKey),
      this.publicationHeadRevisionSync(canonicalKey),
    );
  }

  private freshPublicationItemKeysSync(
    state: ExactReviewQueueState,
    now: number,
    heads = this.publicationHeadsSync(state),
  ) {
    const reserve = exactReviewPublicationFreshLaneMaxItems(this.env);
    if (!reserve) return new Set<string>();
    const cutoff = now - exactReviewPublicationFreshLaneMaxAgeMs(this.env);
    return new Set(
      Object.values(state.items).flatMap((item) => {
        if (
          item.state !== "pending" ||
          item.nextAttemptAt > now ||
          item.createdAt < cutoff ||
          !exactReviewQueueIsPublication(item) ||
          item.terminalFinalization
        ) {
          return [];
        }
        const revision = exactReviewPublicationRevision(item.decision);
        return revision && revision.sourceRevision >= (heads.get(revision.targetKey) ?? 0)
          ? [item.key]
          : [];
      }),
    );
  }

  private recordPublicationHeadSync(targetKey: string, sourceRevision: number, now: number) {
    this.storage.sql.exec(
      `INSERT INTO ${EXACT_REVIEW_PUBLICATION_HEAD_TABLE}
         (target_key, source_revision, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(target_key) DO UPDATE SET
         source_revision = MAX(source_revision, excluded.source_revision),
         updated_at = CASE
           WHEN excluded.source_revision >= source_revision THEN excluded.updated_at
           ELSE updated_at
         END`,
      targetKey,
      sourceRevision,
      now,
    );
  }

  private backfillPublicationHeadsSync(state: ExactReviewQueueState, now: number) {
    for (const item of Object.values(state.items)) {
      const revision = exactReviewPublicationRevision(item.decision);
      if (revision)
        this.recordPublicationHeadSync(revision.targetKey, revision.sourceRevision, now);
    }
  }

  private async initializeStorage() {
    this.ensureStorageSchemaSync();
    this.commandIntakeStore.ensureSchemaSync();
    this.batchStore.ensureSchemaSync();
    this.directPublicationStore.ensureSchemaSync();
    this.recordSnapshotStore.ensureSchemaSync();
    this.stateWriterCoordinator.ensureSchemaSync();
    this.lifecycleProjectionStore.ensureSchemaSync();
    this.lifecycleTelemetryStore.ensureSchemaSync();
    this.lifecycleTelemetryStore.syncBayRepositoryScope(exactReviewPublicBayRepositories(this.env));
    this.githubEgressTelemetryStore.ensureSchemaSync();
    this.artifactReceiptStore.ensureSchemaSync();
    this.githubEtagResponseStore.ensureSchemaSync();
    this.githubWebhookReadModelStore.ensureSchemaSync();
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
    this.storage.transactionSync(() => {
      this.backfillPublicationHeadsSync(this.readStateSync(), Date.now());
    });
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
         received_at INTEGER NOT NULL,
         authenticated_body_fingerprint TEXT,
         scheduled_disposition_json TEXT
       ) STRICT`,
    );
    const deliveryColumns = new Set(
      Array.from(
        this.storage.sql.exec(
          `SELECT name FROM pragma_table_info('${EXACT_REVIEW_QUEUE_DELIVERY_TABLE}')`,
        ) as Iterable<{ name: string }>,
      ).map((row) => row.name),
    );
    for (const column of ["authenticated_body_fingerprint", "scheduled_disposition_json"]) {
      if (!deliveryColumns.has(column)) {
        this.storage.sql.exec(
          `ALTER TABLE ${EXACT_REVIEW_QUEUE_DELIVERY_TABLE} ADD COLUMN ${column} TEXT`,
        );
      }
    }
    // Store only the current SHA-256 tuple for a PR. That lets a later genuine
    // change back to an older tuple enqueue normally, while duplicate webhook
    // deliveries of the current edit stay idempotent even after queue handoff.
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_QUEUE_EDIT_SEMANTIC_TABLE} (
         item_key TEXT PRIMARY KEY,
         fingerprint TEXT NOT NULL,
         observed_at INTEGER NOT NULL
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_queue_edit_semantic_observed_at
         ON ${EXACT_REVIEW_QUEUE_EDIT_SEMANTIC_TABLE} (observed_at, item_key)`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_PUBLICATION_HEAD_TABLE} (
         target_key TEXT PRIMARY KEY,
         source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
         updated_at INTEGER NOT NULL
       ) STRICT`,
    );
    // Retired tables have no producers or readers, so drop them outright on
    // upgrade instead of carrying inert compatibility schema.
    for (const retiredTable of [
      "state_append_window",
      "state_append_receipts",
      "state_append_drains",
      "state_append_meta",
      "state_append_dead_letters",
      "exact_review_review_telemetry",
    ]) {
      this.storage.sql.exec(`DROP TABLE IF EXISTS ${retiredTable}`);
    }
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_QUEUE_INGRESS_TABLE} (
         fingerprint TEXT NOT NULL,
         route TEXT NOT NULL CHECK (route IN ('direct_webhook', 'target_dispatcher')),
         target_branch TEXT NOT NULL,
         received_at INTEGER NOT NULL,
         admitted_at INTEGER,
         PRIMARY KEY (fingerprint, route)
        ) STRICT`,
    );
    const hasIngressAdmission = Array.from(
      this.storage.sql.exec(
        `SELECT name FROM pragma_table_info('${EXACT_REVIEW_QUEUE_INGRESS_TABLE}')
          WHERE name = 'admitted_at'`,
      ),
    ).length;
    if (!hasIngressAdmission) {
      this.storage.sql.exec(
        `ALTER TABLE ${EXACT_REVIEW_QUEUE_INGRESS_TABLE} ADD COLUMN admitted_at INTEGER`,
      );
    }
    // Before admission state was explicit, direct-route receipts were the
    // canonical durable ingress record. Preserve that completed-delivery
    // meaning on the rolling schema upgrade and on a later re-upgrade after a
    // rollback. Current code records an unadmitted direct receipt as zero, so
    // NULL remains exclusive to the pre-admission-schema worker; legacy
    // fallback receipts stay NULL until this queue admits them.
    this.storage.sql.exec(
      `UPDATE ${EXACT_REVIEW_QUEUE_INGRESS_TABLE}
          SET admitted_at = received_at
        WHERE route = 'direct_webhook' AND admitted_at IS NULL`,
    );
    // Flow telemetry is independent of queue rollback compatibility. A
    // separate singleton keeps cumulative lane counters monotonic without
    // changing the normalized queue schema or its legacy shadow contract.
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_QUEUE_METRICS_TABLE} (
         singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
         review_enqueued_total INTEGER NOT NULL DEFAULT 0 CHECK (review_enqueued_total >= 0),
         review_completed_total INTEGER NOT NULL DEFAULT 0 CHECK (review_completed_total >= 0),
         review_superseded_total INTEGER NOT NULL DEFAULT 0
           CHECK (review_superseded_total >= 0),
         review_semantic_deduped_total INTEGER NOT NULL DEFAULT 0
           CHECK (review_semantic_deduped_total >= 0),
         review_shed_total INTEGER NOT NULL DEFAULT 0 CHECK (review_shed_total >= 0),
         review_shed_backpressure_total INTEGER NOT NULL DEFAULT 0
           CHECK (review_shed_backpressure_total >= 0),
         review_shed_scheduled_rate_total INTEGER NOT NULL DEFAULT 0
           CHECK (review_shed_scheduled_rate_total >= 0),
         publication_enqueued_total INTEGER NOT NULL DEFAULT 0
           CHECK (publication_enqueued_total >= 0),
         publication_completed_total INTEGER NOT NULL CHECK (publication_completed_total >= 0)
       ) STRICT`,
    );
    for (const column of [
      "review_enqueued_total",
      "review_completed_total",
      "review_superseded_total",
      "review_semantic_deduped_total",
      "review_shed_total",
      "review_shed_backpressure_total",
      "review_shed_scheduled_rate_total",
      "publication_enqueued_total",
      "publication_published_total",
      "publication_superseded_total",
      "publication_semantic_deduped_total",
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
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_QUEUE_SUPERSESSION_TABLE} (
         audit_id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
         item_key TEXT NOT NULL,
         prior_revision INTEGER NOT NULL CHECK (prior_revision >= 1),
         next_revision INTEGER NOT NULL CHECK (next_revision > prior_revision),
         superseded_lease_id TEXT,
         superseded_run_id TEXT,
         superseded_run_attempt INTEGER
           CHECK (superseded_run_attempt IS NULL OR superseded_run_attempt >= 1),
         superseded_claim_generation INTEGER
           CHECK (superseded_claim_generation IS NULL OR superseded_claim_generation >= 1),
         superseded_protocol_version INTEGER
           CHECK (superseded_protocol_version IS NULL OR superseded_protocol_version IN (1, 2)),
         source_action TEXT NOT NULL,
         reason_code TEXT NOT NULL DEFAULT 'newer_source_event',
         superseded_at INTEGER NOT NULL
        ) STRICT`,
    );
    const hasSupersessionAuditId = Array.from(
      this.storage.sql.exec(
        `SELECT name FROM pragma_table_info('${EXACT_REVIEW_QUEUE_SUPERSESSION_TABLE}')
          WHERE name = 'audit_id'`,
      ),
    ).length;
    const hasSupersessionReason = Array.from(
      this.storage.sql.exec(
        `SELECT name FROM pragma_table_info('${EXACT_REVIEW_QUEUE_SUPERSESSION_TABLE}')
          WHERE name = 'reason_code'`,
      ),
    ).length;
    if (!hasSupersessionReason) {
      this.storage.sql.exec(
        `ALTER TABLE ${EXACT_REVIEW_QUEUE_SUPERSESSION_TABLE}
           ADD COLUMN reason_code TEXT NOT NULL DEFAULT 'newer_source_event'`,
      );
    }
    if (!hasSupersessionAuditId) {
      const replacement = `${EXACT_REVIEW_QUEUE_SUPERSESSION_TABLE}_replacement`;
      this.storage.transactionSync(() => {
        this.storage.sql.exec(
          `CREATE TABLE ${replacement} (
             audit_id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
             item_key TEXT NOT NULL,
             prior_revision INTEGER NOT NULL CHECK (prior_revision >= 1),
             next_revision INTEGER NOT NULL CHECK (next_revision > prior_revision),
             superseded_lease_id TEXT,
             superseded_run_id TEXT,
             superseded_run_attempt INTEGER
               CHECK (superseded_run_attempt IS NULL OR superseded_run_attempt >= 1),
             superseded_claim_generation INTEGER
               CHECK (superseded_claim_generation IS NULL OR superseded_claim_generation >= 1),
             superseded_protocol_version INTEGER
               CHECK (superseded_protocol_version IS NULL OR superseded_protocol_version IN (1, 2)),
             source_action TEXT NOT NULL,
             reason_code TEXT NOT NULL DEFAULT 'newer_source_event',
             superseded_at INTEGER NOT NULL
           ) STRICT`,
        );
        this.storage.sql.exec(
          `INSERT INTO ${replacement}
             (audit_id, item_key, prior_revision, next_revision, superseded_run_id,
              source_action, reason_code, superseded_at)
           SELECT printf('legacy:%s:%d:%d', item_key, prior_revision, next_revision),
                  item_key, prior_revision, next_revision, superseded_run_id,
                  source_action, reason_code, superseded_at
             FROM ${EXACT_REVIEW_QUEUE_SUPERSESSION_TABLE}`,
        );
        this.storage.sql.exec(`DROP TABLE ${EXACT_REVIEW_QUEUE_SUPERSESSION_TABLE}`);
        this.storage.sql.exec(
          `ALTER TABLE ${replacement} RENAME TO ${EXACT_REVIEW_QUEUE_SUPERSESSION_TABLE}`,
        );
      });
    }
    for (const [column, definition] of [
      ["superseded_lease_id", "TEXT"],
      [
        "superseded_run_attempt",
        "INTEGER CHECK (superseded_run_attempt IS NULL OR superseded_run_attempt >= 1)",
      ],
      [
        "superseded_claim_generation",
        "INTEGER CHECK (superseded_claim_generation IS NULL OR superseded_claim_generation >= 1)",
      ],
      [
        "superseded_protocol_version",
        "INTEGER CHECK (superseded_protocol_version IS NULL OR superseded_protocol_version IN (1, 2))",
      ],
    ]) {
      const present = Array.from(
        this.storage.sql.exec(
          `SELECT name FROM pragma_table_info('${EXACT_REVIEW_QUEUE_SUPERSESSION_TABLE}')
            WHERE name = ?`,
          column,
        ),
      ).length;
      if (!present) {
        this.storage.sql.exec(
          `ALTER TABLE ${EXACT_REVIEW_QUEUE_SUPERSESSION_TABLE}
             ADD COLUMN ${column} ${definition}`,
        );
      }
    }
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_queue_supersessions_at
         ON ${EXACT_REVIEW_QUEUE_SUPERSESSION_TABLE} (superseded_at, item_key)`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_queue_ingress_received_at
         ON ${EXACT_REVIEW_QUEUE_INGRESS_TABLE} (received_at, fingerprint)`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_QUEUE_METRIC_BUCKET_TABLE} (
         bucket_start INTEGER PRIMARY KEY,
         review_enqueued INTEGER NOT NULL DEFAULT 0 CHECK (review_enqueued >= 0),
         review_completed INTEGER NOT NULL DEFAULT 0 CHECK (review_completed >= 0),
         review_superseded INTEGER NOT NULL DEFAULT 0 CHECK (review_superseded >= 0),
         review_retried INTEGER NOT NULL DEFAULT 0 CHECK (review_retried >= 0),
         review_shed INTEGER NOT NULL DEFAULT 0 CHECK (review_shed >= 0),
         review_shed_backpressure INTEGER NOT NULL DEFAULT 0
           CHECK (review_shed_backpressure >= 0),
         review_shed_scheduled_rate INTEGER NOT NULL DEFAULT 0
           CHECK (review_shed_scheduled_rate >= 0),
         publication_enqueued INTEGER NOT NULL DEFAULT 0 CHECK (publication_enqueued >= 0),
         publication_resolved INTEGER NOT NULL DEFAULT 0 CHECK (publication_resolved >= 0),
         publication_published INTEGER NOT NULL DEFAULT 0 CHECK (publication_published >= 0),
         publication_superseded INTEGER NOT NULL DEFAULT 0 CHECK (publication_superseded >= 0),
         publication_semantic_deduped INTEGER NOT NULL DEFAULT 0
           CHECK (publication_semantic_deduped >= 0),
         publication_retried INTEGER NOT NULL DEFAULT 0 CHECK (publication_retried >= 0),
         publication_dead_lettered INTEGER NOT NULL DEFAULT 0
           CHECK (publication_dead_lettered >= 0),
         publication_refreshed INTEGER NOT NULL DEFAULT 0 CHECK (publication_refreshed >= 0)
       ) STRICT`,
    );
    for (const column of [
      "review_enqueued",
      "review_completed",
      "review_superseded",
      "review_retried",
      "review_shed",
      "review_shed_backpressure",
      "review_shed_scheduled_rate",
      "publication_semantic_deduped",
      "publication_refreshed",
    ]) {
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
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_PUBLICATION_CAUSE_BUCKET_TABLE} (
         bucket_start INTEGER NOT NULL,
         transition TEXT NOT NULL CHECK (transition IN (
           'published', 'superseded', 'deferred', 'semantic_deduped', 'backoff',
           'retried', 'refreshed', 'dead_lettered'
         )),
         stage TEXT NOT NULL CHECK (stage IN (
           'publication_prepare', 'publication_apply', 'publication_router',
           'state_commit', 'workflow', 'unknown'
         )),
         completion_kind TEXT NOT NULL CHECK (completion_kind IN (
           'published', 'superseded', 'retryable_failure', 'refresh_required',
           'deferred', 'permanent_failure', 'none'
         )),
         reason_code TEXT NOT NULL CHECK (reason_code IN (
           'publication_applied', 'remote_newer_tuple', 'remote_closed', 'live_terminal',
           'github_rate_limit', 'github_transient', 'state_contention',
           'review_lease_active', 'workflow_cancelled', 'artifact_unavailable',
           'artifact_expired', 'close_coverage_retry', 'close_coverage_deferred',
           'invalid_artifact', 'missing_record_tuple', 'tuple_protocol_invalid',
           'policy_invariant', 'unknown_failure', 'retry_exhausted',
           'semantic_duplicate', 'unattributed'
         )),
         revision_relation TEXT NOT NULL CHECK (revision_relation IN (
           'same_revision', 'newer_local_revision', 'newer_remote_revision',
           'semantic_duplicate', 'unknown'
         )),
         pool_class TEXT NOT NULL CHECK (pool_class IN (
           'repository_actions', 'target_app', 'not_applicable', 'unknown'
         )),
         recovery_cause TEXT NOT NULL CHECK (recovery_cause IN (
           'none', 'credential_circuit', 'retry_budget_exhausted', 'transient_retry',
           'state_retry', 'lease_retry', 'workflow_retry', 'artifact_refresh',
           'coverage_retry', 'validation_failure', 'newer_revision',
           'remote_revision', 'semantic_deduplication', 'unattributed'
         )),
         backoff_reason TEXT NOT NULL CHECK (backoff_reason IN (
           'dispatch_debounce', 'dispatcher_backoff', 'admission_retry',
           'coordination_retry', 'throttle_retry', 'review_retry',
           'publication_retry', 'none', 'unknown'
         )),
         attempt_bucket TEXT NOT NULL CHECK (attempt_bucket IN (
           '0', '1', '2', '3_5', '6_13', '14_plus', 'unknown'
         )),
         count INTEGER NOT NULL CHECK (count >= 1),
         PRIMARY KEY (
           bucket_start, transition, stage, completion_kind, reason_code,
           revision_relation, pool_class, recovery_cause, backoff_reason,
           attempt_bucket
         )
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_publication_causes_window_v1
         ON ${EXACT_REVIEW_PUBLICATION_CAUSE_BUCKET_TABLE}
         (bucket_start, transition, reason_code)`,
    );
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
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_QUEUE_PARKED_ACTION_TABLE} (
         item_key TEXT PRIMARY KEY,
         action TEXT NOT NULL CHECK (action IN ('resolved', 'recovered_fresh')),
         action_key TEXT,
         note TEXT NOT NULL,
         source_updated_at INTEGER NOT NULL,
         acted_at INTEGER NOT NULL
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_queue_parked_actions_acted
         ON ${EXACT_REVIEW_QUEUE_PARKED_ACTION_TABLE} (acted_at, item_key)`,
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
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_GITHUB_TELEMETRY_RECEIPT_TABLE} (
         receipt TEXT PRIMARY KEY,
         observed_at INTEGER NOT NULL
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_github_telemetry_receipts_observed
         ON ${EXACT_REVIEW_GITHUB_TELEMETRY_RECEIPT_TABLE} (observed_at)`,
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

  private readonly schedulingStates = new WeakSet<ExactReviewQueueState>();

  private readSchedulingStateSync(): ExactReviewQueueState {
    const meta = this.readStorageMetaSync();
    if (!meta || Number(meta.schema_version) !== EXACT_REVIEW_QUEUE_STORAGE_SCHEMA_VERSION) {
      throw new Error("exact-review queue storage is not initialized");
    }
    const items: Record<string, ExactReviewQueueItem> = {};
    for (const row of this.storage.sql.exec(
      `SELECT item_key, json_remove(item_json,
        '$.leaseDecision', '$.decision.additionalPrompt',
        '$.decision.publication.producerDecision.additionalPrompt') AS census_json
       FROM ${EXACT_REVIEW_QUEUE_ITEM_TABLE}`,
    ) as Iterable<{ item_key: string; census_json: string }>) {
      const item = JSON.parse(row.census_json) as ExactReviewQueueItem;
      if (!item || typeof item !== "object" || item.key !== row.item_key) {
        throw new Error(`invalid exact-review queue item for ${row.item_key}`);
      }
      items[row.item_key] = item;
    }
    const state: ExactReviewQueueState = {
      items,
      dispatcher: meta.dispatcher_json ? JSON.parse(meta.dispatcher_json) : undefined,
      shedSinceReset: Math.max(0, Number(meta.shed_since_reset || 0)),
    };
    this.schedulingStates.add(state);
    return state;
  }

  private readStateSync(): ExactReviewQueueState {
    const meta = this.readStorageMetaSync();
    if (!meta || Number(meta.schema_version) !== EXACT_REVIEW_QUEUE_STORAGE_SCHEMA_VERSION) {
      throw new Error("exact-review queue storage is not initialized");
    }

    const items: Record<string, ExactReviewQueueItem> = {};
    const baselineItems = new Map<string, string>();
    const unreadItems = new Map<string, () => ExactReviewQueueItem>();
    for (const row of this.storage.sql.exec(
      `SELECT item_key, item_json FROM ${EXACT_REVIEW_QUEUE_ITEM_TABLE}`,
    ) as Iterable<{ item_key: string; item_json: string }>) {
      let loaded = false;
      let item: ExactReviewQueueItem;
      const read = () => {
        if (loaded) return item;
        try {
          item = JSON.parse(row.item_json) as ExactReviewQueueItem;
        } catch {
          throw new Error(`invalid exact-review queue item JSON for ${row.item_key}`);
        }
        if (!item || typeof item !== "object" || item.key !== row.item_key) {
          throw new Error(`invalid exact-review queue item for ${row.item_key}`);
        }
        loaded = true;
        unreadItems.delete(row.item_key);
        return item;
      };
      // Keep property descriptors stable during census enumeration. Redefining
      // getters inside Object.values makes large snapshots quadratic in V8.
      Object.defineProperty(items, row.item_key, {
        get: read,
        set: (next: ExactReviewQueueItem) => {
          item = next;
          loaded = true;
          unreadItems.delete(row.item_key);
        },
        enumerable: true,
        configurable: true,
      });
      unreadItems.set(row.item_key, read);
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
      unreadItems,
      dispatcherJson: meta.dispatcher_json,
    });
    return state;
  }

  private writeState(
    state: ExactReviewQueueState,
    metricDelta: ExactReviewQueueMetricDelta = {},
    publicationFeedback?: ExactReviewPublicationFeedback,
    deadLetter?: ExactReviewDeadLetterInsert,
    supersessionAudits: ExactReviewSupersessionAudit[] = [],
  ) {
    this.storage.transactionSync(() => {
      this.writeStateSync(state);
      this.incrementQueueMetricsSync(metricDelta);
      if (publicationFeedback) this.applyPublicationFeedbackSync(publicationFeedback);
      if (deadLetter) this.insertDeadLetterSync(deadLetter);
      for (const audit of supersessionAudits) this.insertSupersessionAuditSync(audit);
    });
  }

  private publicationControlSync() {
    return exactReviewPublicationControl(
      this.env,
      this.storage.kv.get(EXACT_REVIEW_PUBLICATION_CONTROL_KEY),
    );
  }

  private takeScheduledReviewTokenSync(decision: ExactReviewDecision, now: number) {
    const lane = exactReviewScheduledLane(decision);
    const lowPriority = isLowPriorityExactReviewDecision(decision);
    if (!lane && !lowPriority) return true;
    const global = this.scheduledReviewBucketSync("global", now);
    const bucket = lane ? this.scheduledReviewBucketSync(lane, now) : null;
    const admitted =
      Number(global.throttleUntil || 0) <= now &&
      (lowPriority || (global.tokens >= 1 && Number(bucket?.tokens || 0) >= 1));
    this.storage.kv.put(exactReviewScheduledFeedKey("global"), {
      tokens: admitted && lane ? global.tokens - 1 : global.tokens,
      updatedAt: now,
      ...(global.throttleObservedAt
        ? {
            throttleObservedAt: global.throttleObservedAt,
            throttleUntil: global.throttleUntil,
            throttleSource: global.throttleSource,
          }
        : {}),
    });
    if (lane && bucket) {
      this.storage.kv.put(exactReviewScheduledFeedKey(lane), {
        tokens: admitted ? bucket.tokens - 1 : bucket.tokens,
        updatedAt: now,
      });
    }
    return admitted;
  }

  private consumeScheduledReviewCapacitySync(now: number) {
    const global = this.scheduledReviewBucketSync("global", now);
    this.storage.kv.put(exactReviewScheduledFeedKey("global"), {
      tokens: Math.max(-global.burst, global.tokens - 1),
      updatedAt: now,
      ...(global.throttleObservedAt
        ? {
            throttleObservedAt: global.throttleObservedAt,
            throttleUntil: global.throttleUntil,
            throttleSource: global.throttleSource,
          }
        : {}),
    });
  }

  private deferScheduledReviewAdmissionForThrottleSync(now: number, requestedRetryAt: number) {
    const global = this.scheduledReviewBucketSync("global", now);
    const throttleUntil = Math.max(
      now + EXACT_REVIEW_GITHUB_THROTTLE_ADMISSION_COOLDOWN_MS,
      requestedRetryAt,
      Number(global.throttleUntil || 0),
    );
    this.storage.kv.put(exactReviewScheduledFeedKey("global"), {
      tokens: global.tokens,
      updatedAt: now,
      throttleObservedAt: now,
      throttleUntil,
      throttleSource: "review_completion",
    });
  }

  private scheduledReviewBucketSync(lane: ExactReviewScheduledBucket, now: number) {
    const ratePerHour = exactReviewScheduledRatePerHour(this.env, lane);
    const burst = exactReviewScheduledBurst(this.env, lane);
    const stored = objectValue(this.storage.kv.get(exactReviewScheduledFeedKey(lane)));
    const updatedAt = Number(stored.updatedAt);
    const storedTokens = Number(stored.tokens);
    const throttleObservedAt = Number(stored.throttleObservedAt);
    const throttleUntil = Number(stored.throttleUntil);
    if (!Number.isFinite(updatedAt) || !Number.isFinite(storedTokens)) {
      return { tokens: burst, updatedAt: now, ratePerHour, burst };
    }
    const elapsedMs = Math.max(0, now - updatedAt);
    return {
      tokens: Math.min(burst, Math.max(0, storedTokens) + (elapsedMs * ratePerHour) / 3_600_000),
      updatedAt: now,
      ratePerHour,
      burst,
      ...(Number.isFinite(throttleObservedAt) &&
      throttleObservedAt > 0 &&
      Number.isFinite(throttleUntil) &&
      throttleUntil > now
        ? {
            throttleObservedAt,
            throttleUntil,
            throttleSource: String(stored.throttleSource || "unknown"),
          }
        : {}),
    };
  }

  private scheduledReviewFeedStatusSync(now: number) {
    const global = this.scheduledReviewBucketSync("global", now);
    const hot = this.scheduledReviewBucketSync("hot_intake", now);
    const normal = this.scheduledReviewBucketSync("normal_backfill", now);
    return {
      target_rate_per_hour: global.ratePerHour,
      enqueue_replay: "scheduled_disposition_v1",
      burst: global.burst,
      token_balance: Math.floor(global.tokens),
      ...(global.throttleObservedAt
        ? {
            throttle_source: global.throttleSource,
            throttle_observed_at: new Date(global.throttleObservedAt).toISOString(),
            throttle_recovery_at: new Date(global.throttleUntil || 0).toISOString(),
          }
        : {}),
      lanes: {
        hot_intake: {
          target_rate_per_hour: hot.ratePerHour,
          burst: hot.burst,
          token_balance: Math.floor(hot.tokens),
        },
        normal_backfill: {
          target_rate_per_hour: normal.ratePerHour,
          burst: normal.burst,
          token_balance: Math.floor(normal.tokens),
        },
      },
    };
  }

  private refreshPublicationControlSync(state: ExactReviewQueueState, now: number) {
    const stored = this.storage.kv.get(EXACT_REVIEW_PUBLICATION_CONTROL_KEY);
    const current = exactReviewPublicationControl(this.env, stored);
    const publications = Object.values(state.items).filter(exactReviewQueueIsPublication);
    const pending = publications.filter((item) => item.state === "pending");
    const oldestPendingAt = pending.reduce<number | null>(
      (oldest, item) => (oldest === null ? item.createdAt : Math.min(oldest, item.createdAt)),
      null,
    );
    // Admission needs only the drain rate, not the diagnostic cause inventory
    // or the longer observation window.
    const flow = Array.from(
      this.storage.sql.exec(
        `SELECT COALESCE(SUM(publication_enqueued), 0) AS enqueued,
              COALESCE(SUM(publication_resolved), 0) AS resolved
         FROM ${EXACT_REVIEW_QUEUE_METRIC_BUCKET_TABLE}
        WHERE bucket_start >= ?`,
        now - 15 * 60_000,
      ),
    )[0] as { enqueued: number; resolved: number } | undefined;
    const next = exactReviewPublicationControlAfterDemand(this.env, current, {
      at: now,
      backlog: pending.length,
      oldestPendingAgeMs: oldestPendingAt === null ? 0 : Math.max(0, now - oldestPendingAt),
      netDrainRatePerHour:
        Math.round((Number(flow?.resolved || 0) - Number(flow?.enqueued || 0)) * 4 * 10) / 10,
    });
    if (stableJson(next) !== stableJson(objectValue(stored))) {
      this.storage.kv.put(EXACT_REVIEW_PUBLICATION_CONTROL_KEY, next);
    }
    return next;
  }

  private applyPublicationFeedbackSync(feedback: ExactReviewPublicationFeedback, receipt?: string) {
    const current = this.publicationControlSync();
    if (receipt && Object.hasOwn(current.githubFeedbackReceipts, receipt)) return;
    const next = exactReviewPublicationControlAfterFeedback(this.env, current, feedback);
    this.storage.kv.put(EXACT_REVIEW_PUBLICATION_CONTROL_KEY, {
      ...next,
      githubFeedbackReceipts: receipt
        ? { ...current.githubFeedbackReceipts, [receipt]: Date.now() }
        : current.githubFeedbackReceipts,
    });
  }

  private queueMetricTotalsSync(): ExactReviewQueueMetricTotals {
    const row = Array.from(
      this.storage.sql.exec(
        `SELECT review_enqueued_total, review_completed_total, review_superseded_total,
                review_semantic_deduped_total, review_shed_total,
                review_shed_backpressure_total, review_shed_scheduled_rate_total,
                publication_enqueued_total, publication_completed_total,
                publication_published_total, publication_superseded_total,
                publication_semantic_deduped_total,
                publication_retried_total, publication_dead_lettered_total,
                publication_refreshed_total
           FROM ${EXACT_REVIEW_QUEUE_METRICS_TABLE}
          WHERE singleton_id = 1`,
      ),
    )[0] as
      | {
          review_enqueued_total?: number;
          review_completed_total?: number;
          review_superseded_total?: number;
          review_semantic_deduped_total?: number;
          review_shed_total?: number;
          review_shed_backpressure_total?: number;
          review_shed_scheduled_rate_total?: number;
          publication_enqueued_total?: number;
          publication_completed_total?: number;
          publication_published_total?: number;
          publication_superseded_total?: number;
          publication_semantic_deduped_total?: number;
          publication_retried_total?: number;
          publication_dead_lettered_total?: number;
          publication_refreshed_total?: number;
        }
      | undefined;
    return {
      review: {
        enqueued: exactReviewMetricTotal(row?.review_enqueued_total),
        completed: exactReviewMetricTotal(row?.review_completed_total),
        superseded: exactReviewMetricTotal(row?.review_superseded_total),
        semanticDeduped: exactReviewMetricTotal(row?.review_semantic_deduped_total),
        shed: exactReviewMetricTotal(row?.review_shed_total),
        shedBackpressure: exactReviewMetricTotal(row?.review_shed_backpressure_total),
        shedScheduledRate: exactReviewMetricTotal(row?.review_shed_scheduled_rate_total),
      },
      publication: {
        enqueued: exactReviewMetricTotal(row?.publication_enqueued_total),
        completed: exactReviewMetricTotal(row?.publication_completed_total),
        published: exactReviewMetricTotal(row?.publication_published_total),
        superseded: exactReviewMetricTotal(row?.publication_superseded_total),
        semanticDeduped: exactReviewMetricTotal(row?.publication_semantic_deduped_total),
        retried: exactReviewMetricTotal(row?.publication_retried_total),
        deadLettered: exactReviewMetricTotal(row?.publication_dead_lettered_total),
        refreshed: exactReviewMetricTotal(row?.publication_refreshed_total),
      },
    };
  }

  private incrementQueueMetricsSync(delta: ExactReviewQueueMetricDelta) {
    const reviewEnqueued = exactReviewMetricDelta(delta.reviewEnqueued);
    const reviewCompleted = exactReviewMetricDelta(delta.reviewCompleted);
    const reviewSuperseded = exactReviewMetricDelta(delta.reviewSuperseded);
    const reviewSemanticDeduped = exactReviewMetricDelta(delta.reviewSemanticDeduped);
    const reviewRetried = exactReviewMetricDelta(delta.reviewRetried);
    const reviewShed = exactReviewMetricDelta(delta.reviewShed);
    const reviewShedBackpressure = exactReviewMetricDelta(delta.reviewShedBackpressure);
    const reviewShedScheduledRate = exactReviewMetricDelta(delta.reviewShedScheduledRate);
    const publicationEnqueued = exactReviewMetricDelta(delta.publicationEnqueued);
    const publicationCompleted = exactReviewMetricDelta(delta.publicationCompleted);
    const publicationPublished = exactReviewMetricDelta(delta.publicationPublished);
    const publicationSuperseded = exactReviewMetricDelta(delta.publicationSuperseded);
    const publicationSemanticDeduped = exactReviewMetricDelta(delta.publicationSemanticDeduped);
    const publicationRetried = exactReviewMetricDelta(delta.publicationRetried);
    const publicationDeadLettered = exactReviewMetricDelta(delta.publicationDeadLettered);
    const publicationRefreshed = exactReviewMetricDelta(delta.publicationRefreshed);
    const publicationTransitions = reconciledPublicationTransitionFacts(
      delta.publicationTransitions || [],
      {
        published: publicationPublished,
        superseded: publicationSuperseded,
        semantic_deduped: publicationSemanticDeduped,
        retried: publicationRetried,
        dead_lettered: publicationDeadLettered,
        refreshed: publicationRefreshed,
      },
    );
    for (const transition of publicationTransitions) {
      this.incrementPublicationCauseBucketSync(transition);
    }
    if (
      !reviewEnqueued &&
      !reviewCompleted &&
      !reviewSuperseded &&
      !reviewSemanticDeduped &&
      !reviewRetried &&
      !reviewShed &&
      !reviewShedBackpressure &&
      !reviewShedScheduledRate &&
      !publicationEnqueued &&
      !publicationCompleted &&
      !publicationPublished &&
      !publicationSuperseded &&
      !publicationSemanticDeduped &&
      !publicationRetried &&
      !publicationDeadLettered &&
      !publicationRefreshed
    ) {
      return;
    }
    // Review retry has a time bucket but no cumulative total column.
    if (
      !(
        reviewRetried &&
        !reviewEnqueued &&
        !reviewCompleted &&
        !reviewSuperseded &&
        !reviewSemanticDeduped &&
        !reviewShed &&
        !reviewShedBackpressure &&
        !reviewShedScheduledRate &&
        !publicationEnqueued &&
        !publicationCompleted &&
        !publicationPublished &&
        !publicationSuperseded &&
        !publicationSemanticDeduped &&
        !publicationRetried &&
        !publicationDeadLettered &&
        !publicationRefreshed
      )
    ) {
      this.storage.sql.exec(
        `UPDATE ${EXACT_REVIEW_QUEUE_METRICS_TABLE}
          SET review_enqueued_total = review_enqueued_total + ?,
              review_completed_total = review_completed_total + ?,
              review_superseded_total = review_superseded_total + ?,
              review_semantic_deduped_total = review_semantic_deduped_total + ?,
              review_shed_total = review_shed_total + ?,
              review_shed_backpressure_total = review_shed_backpressure_total + ?,
              review_shed_scheduled_rate_total = review_shed_scheduled_rate_total + ?,
              publication_enqueued_total = publication_enqueued_total + ?,
              publication_completed_total = publication_completed_total + ?,
              publication_published_total = publication_published_total + ?,
              publication_superseded_total = publication_superseded_total + ?,
              publication_semantic_deduped_total = publication_semantic_deduped_total + ?,
              publication_retried_total = publication_retried_total + ?,
              publication_dead_lettered_total = publication_dead_lettered_total + ?,
              publication_refreshed_total = publication_refreshed_total + ?
        WHERE singleton_id = 1`,
        reviewEnqueued,
        reviewCompleted,
        reviewSuperseded,
        reviewSemanticDeduped,
        reviewShed,
        reviewShedBackpressure,
        reviewShedScheduledRate,
        publicationEnqueued,
        publicationCompleted,
        publicationPublished,
        publicationSuperseded,
        publicationSemanticDeduped,
        publicationRetried,
        publicationDeadLettered,
        publicationRefreshed,
      );
    }
    this.incrementQueueMetricBucketSync({
      reviewEnqueued,
      reviewCompleted,
      reviewSuperseded,
      reviewRetried,
      reviewShed,
      reviewShedBackpressure,
      reviewShedScheduledRate,
      publicationEnqueued,
      publicationCompleted,
      publicationPublished,
      publicationSuperseded,
      publicationSemanticDeduped,
      publicationRetried,
      publicationDeadLettered,
      publicationRefreshed,
    });
  }

  private incrementPublicationCauseBucketSync(fact: ExactReviewPublicationTransitionFact) {
    const bucketStart =
      Math.floor(Date.now() / EXACT_REVIEW_QUEUE_METRIC_BUCKET_MS) *
      EXACT_REVIEW_QUEUE_METRIC_BUCKET_MS;
    this.storage.sql.exec(
      `INSERT INTO ${EXACT_REVIEW_PUBLICATION_CAUSE_BUCKET_TABLE}
         (bucket_start, transition, stage, completion_kind, reason_code,
          revision_relation, pool_class, recovery_cause, backoff_reason,
          attempt_bucket, count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO UPDATE SET count = count + excluded.count`,
      bucketStart,
      fact.transition,
      fact.stage,
      fact.completionKind,
      fact.reasonCode,
      fact.revisionRelation,
      fact.poolClass,
      fact.recoveryCause,
      fact.backoffReason,
      fact.attemptBucket,
      fact.count,
    );
  }

  private incrementQueueMetricBucketSync({
    reviewEnqueued,
    reviewCompleted,
    reviewSuperseded,
    reviewRetried,
    reviewShed,
    reviewShedBackpressure,
    reviewShedScheduledRate,
    publicationEnqueued,
    publicationCompleted,
    publicationPublished,
    publicationSuperseded,
    publicationSemanticDeduped,
    publicationRetried,
    publicationDeadLettered,
    publicationRefreshed,
  }: {
    reviewEnqueued: number;
    reviewCompleted: number;
    reviewSuperseded: number;
    reviewRetried: number;
    reviewShed: number;
    reviewShedBackpressure: number;
    reviewShedScheduledRate: number;
    publicationEnqueued: number;
    publicationCompleted: number;
    publicationPublished: number;
    publicationSuperseded: number;
    publicationSemanticDeduped: number;
    publicationRetried: number;
    publicationDeadLettered: number;
    publicationRefreshed: number;
  }) {
    if (
      !reviewEnqueued &&
      !reviewCompleted &&
      !reviewSuperseded &&
      !reviewRetried &&
      !reviewShed &&
      !reviewShedBackpressure &&
      !reviewShedScheduledRate &&
      !publicationEnqueued &&
      !publicationCompleted &&
      !publicationPublished &&
      !publicationSuperseded &&
      !publicationSemanticDeduped &&
      !publicationRetried &&
      !publicationDeadLettered &&
      !publicationRefreshed
    ) {
      return;
    }
    const bucketStart =
      Math.floor(Date.now() / EXACT_REVIEW_QUEUE_METRIC_BUCKET_MS) *
      EXACT_REVIEW_QUEUE_METRIC_BUCKET_MS;
    this.storage.sql.exec(
      `INSERT INTO ${EXACT_REVIEW_QUEUE_METRIC_BUCKET_TABLE}
         (bucket_start, review_enqueued, review_completed, review_superseded, review_retried,
          review_shed, review_shed_backpressure, review_shed_scheduled_rate,
           publication_enqueued, publication_resolved, publication_published,
           publication_superseded, publication_semantic_deduped,
           publication_retried, publication_dead_lettered, publication_refreshed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(bucket_start) DO UPDATE SET
         review_enqueued = review_enqueued + excluded.review_enqueued,
         review_completed = review_completed + excluded.review_completed,
         review_superseded = review_superseded + excluded.review_superseded,
         review_retried = review_retried + excluded.review_retried,
         review_shed = review_shed + excluded.review_shed,
         review_shed_backpressure =
           review_shed_backpressure + excluded.review_shed_backpressure,
         review_shed_scheduled_rate =
           review_shed_scheduled_rate + excluded.review_shed_scheduled_rate,
         publication_enqueued = publication_enqueued + excluded.publication_enqueued,
         publication_resolved = publication_resolved + excluded.publication_resolved,
         publication_published = publication_published + excluded.publication_published,
         publication_superseded = publication_superseded + excluded.publication_superseded,
         publication_semantic_deduped =
           publication_semantic_deduped + excluded.publication_semantic_deduped,
         publication_retried = publication_retried + excluded.publication_retried,
         publication_dead_lettered =
           publication_dead_lettered + excluded.publication_dead_lettered,
         publication_refreshed = publication_refreshed + excluded.publication_refreshed`,
      bucketStart,
      reviewEnqueued,
      reviewCompleted,
      reviewSuperseded,
      reviewRetried,
      reviewShed,
      reviewShedBackpressure,
      reviewShedScheduledRate,
      publicationEnqueued,
      publicationCompleted,
      publicationPublished,
      publicationSuperseded,
      publicationSemanticDeduped,
      publicationRetried,
      publicationDeadLettered,
      publicationRefreshed,
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

  private supersededCompletionRevisionSync({
    itemKey,
    leaseId,
    leaseRevision,
    claimGeneration,
    runId,
    runAttempt,
  }: {
    itemKey: string;
    leaseId: string;
    leaseRevision: number;
    claimGeneration: number;
    runId: string;
    runAttempt: number;
  }) {
    const row = Array.from(
      this.storage.sql.exec(
        `SELECT next_revision
           FROM ${EXACT_REVIEW_QUEUE_SUPERSESSION_TABLE}
          WHERE item_key = ?
            AND prior_revision = ?
            AND superseded_lease_id = ?
            AND superseded_run_id = ?
            AND superseded_run_attempt = ?
            AND superseded_claim_generation = ?
            AND superseded_protocol_version = 2
            AND reason_code = 'newer_source_event'
          ORDER BY superseded_at DESC, audit_id DESC
          LIMIT 1`,
        itemKey,
        leaseRevision,
        leaseId,
        runId,
        runAttempt,
        claimGeneration,
      ),
    )[0] as { next_revision?: unknown } | undefined;
    const nextRevision = Number(row?.next_revision);
    return Number.isInteger(nextRevision) && nextRevision > leaseRevision ? nextRevision : null;
  }

  private insertSupersessionAuditSync(audit: ExactReviewSupersessionAudit) {
    this.storage.sql.exec(
      `INSERT OR IGNORE INTO ${EXACT_REVIEW_QUEUE_SUPERSESSION_TABLE}
          (audit_id, item_key, prior_revision, next_revision, superseded_lease_id,
           superseded_run_id, superseded_run_attempt, superseded_claim_generation,
           superseded_protocol_version, source_action, reason_code, superseded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      audit.auditId,
      audit.itemKey,
      audit.priorRevision,
      audit.nextRevision,
      audit.supersededLeaseId,
      audit.supersededRunId,
      audit.supersededRunAttempt,
      audit.supersededClaimGeneration,
      audit.supersededProtocolVersion,
      audit.sourceAction,
      audit.reasonCode,
      audit.supersededAt,
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
      if (
        !available ||
        item.state !== "parked" ||
        !exactReviewQueueIsPublication(item) ||
        item.terminalFinalization
      ) {
        continue;
      }
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
                COALESCE(SUM(review_shed), 0) AS shed,
                COALESCE(SUM(review_shed_backpressure), 0) AS shed_backpressure,
                COALESCE(SUM(review_shed_scheduled_rate), 0) AS shed_scheduled_rate
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
    const shedBackpressure = Number(row?.shed_backpressure || 0);
    const shedScheduledRate = Number(row?.shed_scheduled_rate || 0);
    const arrival = enqueued + shed;
    return {
      last_15_minutes: {
        window_minutes: windowMs / 60_000,
        arrival,
        successful,
        retried,
        shed,
        shed_reasons: {
          backpressure: shedBackpressure,
          scheduled_rate: shedScheduledRate,
        },
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
      `DELETE FROM ${EXACT_REVIEW_PUBLICATION_CAUSE_BUCKET_TABLE} WHERE bucket_start < ?`,
      now - EXACT_REVIEW_QUEUE_METRIC_BUCKET_TTL_MS,
    );
    this.storage.sql.exec(
      `DELETE FROM ${EXACT_REVIEW_QUEUE_DEAD_LETTER_TABLE}
        WHERE status != 'open' AND resolved_at < ?`,
      now - EXACT_REVIEW_QUEUE_DEAD_LETTER_RESOLVED_TTL_MS,
    );
    this.storage.sql.exec(
      `DELETE FROM ${EXACT_REVIEW_QUEUE_SUPERSESSION_TABLE} WHERE superseded_at < ?`,
      now - EXACT_REVIEW_QUEUE_SUPERSESSION_RETENTION_MS,
    );
    this.storage.sql.exec(
      `DELETE FROM ${EXACT_REVIEW_STATE_WRITER_OPERATION_TABLE} WHERE observed_at < ?`,
      now - EXACT_REVIEW_STATE_WRITER_RETENTION_MS,
    );
    this.storage.sql.exec(
      `DELETE FROM ${EXACT_REVIEW_STATE_WRITER_LIVE_TABLE} WHERE observed_at < ?`,
      now - EXACT_REVIEW_STATE_WRITER_LIVE_MS,
    );
    this.storage.sql.exec(
      `DELETE FROM ${EXACT_REVIEW_GITHUB_TELEMETRY_RECEIPT_TABLE} WHERE observed_at < ?`,
      now - EXACT_REVIEW_GITHUB_TELEMETRY_RECEIPT_RETENTION_MS,
    );
  }

  private applyGithubTelemetrySync(
    state: ExactReviewQueueState,
    receipt: string,
    rateLimitObservations: readonly ExactReviewGithubRateLimitObservation[],
    requestMetrics: readonly ExactReviewGithubRequestMetric[],
    now: number,
  ): boolean {
    return this.storage.transactionSync(() => {
      const existing = Array.from(
        this.storage.sql.exec(
          `SELECT 1 FROM ${EXACT_REVIEW_GITHUB_TELEMETRY_RECEIPT_TABLE} WHERE receipt = ? LIMIT 1`,
          receipt,
        ),
      );
      if (existing.length) return false;
      if (rateLimitObservations.length) {
        applyExactReviewGithubCredentialCircuits(state, rateLimitObservations);
      }
      if (requestMetrics.length) {
        applyExactReviewGithubRequestMetrics(state, requestMetrics, now);
      }
      this.writeStateSync(state);
      this.storage.sql.exec(
        `INSERT INTO ${EXACT_REVIEW_GITHUB_TELEMETRY_RECEIPT_TABLE} (receipt, observed_at) VALUES (?, ?)`,
        receipt,
        now,
      );
      return true;
    });
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
                  COALESCE(SUM(publication_semantic_deduped), 0) AS semantic_deduped,
                  COALESCE(SUM(publication_retried), 0) AS retried,
                  COALESCE(SUM(publication_dead_lettered), 0) AS dead_lettered,
                  COALESCE(SUM(publication_refreshed), 0) AS refreshed
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
      const semanticDeduped = Number(row?.semantic_deduped || 0);
      const deadLettered = Number(row?.dead_lettered || 0);
      const refreshed = Number(row?.refreshed || 0);
      const causes = this.publicationCauseSummarySync(now - windowMs, {
        published,
        superseded,
        semantic_deduped: semanticDeduped,
        retried,
        dead_lettered: deadLettered,
        refreshed,
      });
      return {
        window_minutes: windowMs / 60_000,
        enqueued,
        resolved,
        published,
        superseded,
        semantic_deduped: semanticDeduped,
        retried,
        dead_lettered: deadLettered,
        refreshed,
        arrival_rate_per_hour: Math.round(enqueued * multiplier * 10) / 10,
        resolved_rate_per_hour: Math.round(resolved * multiplier * 10) / 10,
        published_rate_per_hour: Math.round(published * multiplier * 10) / 10,
        superseded_rate_per_hour: Math.round(superseded * multiplier * 10) / 10,
        semantic_deduped_rate_per_hour: Math.round(semanticDeduped * multiplier * 10) / 10,
        retried_rate_per_hour: Math.round(retried * multiplier * 10) / 10,
        dead_lettered_rate_per_hour: Math.round(deadLettered * multiplier * 10) / 10,
        refreshed_rate_per_hour: Math.round(refreshed * multiplier * 10) / 10,
        net_drain_rate_per_hour: Math.round((resolved - enqueued) * multiplier * 10) / 10,
        retry_amplification: resolved > 0 ? Math.round((retried / resolved) * 100) / 100 : null,
        causes,
      };
    };
    return { last_15_minutes: summarize(15 * 60_000), last_60_minutes: summarize(60 * 60_000) };
  }

  private publicationCauseSummarySync(
    windowStart: number,
    expected: Record<
      "published" | "superseded" | "semantic_deduped" | "retried" | "dead_lettered" | "refreshed",
      number
    >,
  ) {
    const rows = Array.from(
      this.storage.sql.exec(
        `SELECT transition, stage, completion_kind, reason_code, revision_relation,
                pool_class, recovery_cause, backoff_reason, attempt_bucket,
                SUM(count) AS count
           FROM ${EXACT_REVIEW_PUBLICATION_CAUSE_BUCKET_TABLE}
          WHERE bucket_start >= ?
          GROUP BY transition, stage, completion_kind, reason_code, revision_relation,
                   pool_class, recovery_cause, backoff_reason, attempt_bucket
          ORDER BY transition, stage, completion_kind, reason_code, revision_relation,
                   pool_class, recovery_cause, backoff_reason, attempt_bucket
          LIMIT ?`,
        windowStart,
        EXACT_REVIEW_PUBLICATION_CAUSE_PUBLIC_LIMIT + 1,
      ),
    ) as Array<Record<string, unknown>>;
    const rowsTruncated = rows.length > EXACT_REVIEW_PUBLICATION_CAUSE_PUBLIC_LIMIT;
    const publicRows = rows.slice(0, EXACT_REVIEW_PUBLICATION_CAUSE_PUBLIC_LIMIT).map((row) => ({
      transition: String(row.transition || "unknown"),
      stage: String(row.stage || "unknown"),
      completion_kind: String(row.completion_kind || "none"),
      reason_code: String(row.reason_code || "unattributed"),
      revision_relation: String(row.revision_relation || "unknown"),
      pool_class: String(row.pool_class || "unknown"),
      recovery_cause: String(row.recovery_cause || "unattributed"),
      backoff_reason: String(row.backoff_reason || "unknown"),
      attempt_bucket: String(row.attempt_bucket || "unknown"),
      count: Number(row.count || 0),
    }));
    const observed = Object.fromEntries(
      Object.keys(expected).map((transition) => [
        transition,
        publicRows
          .filter((row) => row.transition === transition)
          .reduce((total, row) => total + row.count, 0),
      ]),
    ) as Record<keyof typeof expected, number>;
    const reconciliation = Object.fromEntries(
      Object.entries(expected).map(([transition, count]) => [
        transition,
        {
          flow_count: count,
          cause_count: observed[transition as keyof typeof expected],
          complete:
            !rowsTruncated && observed[transition as keyof typeof expected] === Number(count),
        },
      ]),
    );
    const unattributed = publicRows
      .filter(
        (row) =>
          row.reason_code === "unattributed" ||
          row.recovery_cause === "unattributed" ||
          row.stage === "unknown" ||
          row.revision_relation === "unknown" ||
          row.pool_class === "unknown",
      )
      .reduce((total, row) => total + row.count, 0);
    return {
      rows: publicRows,
      rows_truncated: rowsTruncated,
      unattributed,
      attribution_complete:
        !rowsTruncated &&
        unattributed === 0 &&
        Object.values(reconciliation).every((entry) => entry.complete),
      reconciliation,
      privacy: {
        raw_identifiers: false,
        closed_dimensions: true,
      },
    };
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
    if (this.schedulingStates.has(state)) throw new Error("cannot persist a queue census");
    this.invalidateReadCaches();
    const baseline = this.baselines.get(state) || this.readStateBaselineSync();
    const nextItems = new Map<string, string>();
    let reviewEnqueued = 0;
    let publicationEnqueued = 0;
    for (const itemKey of Object.keys(state.items)) {
      const unread = baseline.unreadItems?.get(itemKey);
      if (unread && Object.getOwnPropertyDescriptor(state.items, itemKey)?.get === unread) {
        nextItems.set(itemKey, baseline.items.get(itemKey)!);
        continue;
      }
      const item = state.items[itemKey]!;
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
      unreadItems: baseline.unreadItems,
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

  private pruneIngressReceiptsSync(now: number) {
    const cutoff = now - EXACT_REVIEW_QUEUE_DELIVERY_TTL_MS;
    for (let batch = 0; batch < EXACT_REVIEW_QUEUE_DELIVERY_PRUNE_MAX_BATCHES; batch += 1) {
      const deleted = Array.from(
        this.storage.sql.exec(
          `DELETE FROM ${EXACT_REVIEW_QUEUE_INGRESS_TABLE}
          WHERE (fingerprint, route) IN (
            SELECT fingerprint, route
              FROM ${EXACT_REVIEW_QUEUE_INGRESS_TABLE}
             WHERE received_at <= ?
             ORDER BY received_at, fingerprint, route
             LIMIT ${EXACT_REVIEW_QUEUE_DELIVERY_PRUNE_BATCH}
          )
        RETURNING fingerprint`,
          cutoff,
        ),
      );
      if (deleted.length < EXACT_REVIEW_QUEUE_DELIVERY_PRUNE_BATCH) break;
    }
  }

  private pruneEditedSemanticInputsSync(now: number) {
    const cutoff = now - EXACT_REVIEW_QUEUE_DELIVERY_TTL_MS;
    for (let batch = 0; batch < EXACT_REVIEW_QUEUE_DELIVERY_PRUNE_MAX_BATCHES; batch += 1) {
      const deleted = Array.from(
        this.storage.sql.exec(
          `DELETE FROM ${EXACT_REVIEW_QUEUE_EDIT_SEMANTIC_TABLE}
            WHERE item_key IN (
              SELECT item_key
                FROM ${EXACT_REVIEW_QUEUE_EDIT_SEMANTIC_TABLE}
               WHERE observed_at <= ?
               ORDER BY observed_at, item_key
               LIMIT ${EXACT_REVIEW_QUEUE_DELIVERY_PRUNE_BATCH}
            )
           RETURNING item_key`,
          cutoff,
        ),
      );
      if (deleted.length < EXACT_REVIEW_QUEUE_DELIVERY_PRUNE_BATCH) break;
    }
  }

  private recordIngressSync(ingress: ExactReviewIngress, targetBranch: string, now: number) {
    const counterpart = ingress.route === "direct_webhook" ? "target_dispatcher" : "direct_webhook";
    const matched = Array.from(
      this.storage.sql.exec(
        `SELECT admitted_at FROM ${EXACT_REVIEW_QUEUE_INGRESS_TABLE}
          WHERE fingerprint = ? AND route = ? AND target_branch = ?
          LIMIT 1`,
        ingress.fingerprint,
        counterpart,
        targetBranch,
      ),
    )[0] as { admitted_at?: number | null } | undefined;
    this.storage.sql.exec(
      `INSERT INTO ${EXACT_REVIEW_QUEUE_INGRESS_TABLE}
       (fingerprint, route, target_branch, received_at, admitted_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(fingerprint, route) DO UPDATE SET
         target_branch = excluded.target_branch,
         received_at = excluded.received_at`,
      ingress.fingerprint,
      ingress.route,
      targetBranch,
      now,
      ingress.route === "direct_webhook" ? 0 : null,
    );
    return matched ? { admitted: Number(matched.admitted_at) > 0 } : null;
  }

  private markIngressAdmittedSync(ingress: ExactReviewIngress, now: number) {
    this.storage.sql.exec(
      `UPDATE ${EXACT_REVIEW_QUEUE_INGRESS_TABLE}
           SET admitted_at = CASE WHEN admitted_at IS NULL OR admitted_at = 0 THEN ? ELSE admitted_at END
        WHERE fingerprint = ? AND route = ?`,
      now,
      ingress.fingerprint,
      ingress.route,
    );
  }

  private isDuplicateEditedSemanticInputSync(input: ExactReviewEditedSemanticInput, now: number) {
    const previous = Array.from(
      this.storage.sql.exec(
        `SELECT fingerprint FROM ${EXACT_REVIEW_QUEUE_EDIT_SEMANTIC_TABLE}
          WHERE item_key = ?`,
        input.storageKey,
      ),
    )[0] as { fingerprint?: string } | undefined;
    if (previous?.fingerprint !== input.fingerprint) return false;
    this.storage.sql.exec(
      `UPDATE ${EXACT_REVIEW_QUEUE_EDIT_SEMANTIC_TABLE}
          SET observed_at = ?
        WHERE item_key = ?`,
      now,
      input.storageKey,
    );
    return true;
  }

  private recordEditedSemanticInputSync(input: ExactReviewEditedSemanticInput, now: number) {
    this.storage.sql.exec(
      `INSERT INTO ${EXACT_REVIEW_QUEUE_EDIT_SEMANTIC_TABLE} (item_key, fingerprint, observed_at)
       VALUES (?, ?, ?)
       ON CONFLICT(item_key) DO UPDATE SET
         fingerprint = excluded.fingerprint,
         observed_at = excluded.observed_at`,
      input.storageKey,
      input.fingerprint,
      now,
    );
  }

  private deliveryReceiptCountSync() {
    const row = Array.from(
      this.storage.sql.exec(
        `SELECT COUNT(*) AS receipt_count FROM ${EXACT_REVIEW_QUEUE_DELIVERY_TABLE}`,
      ),
    )[0] as { receipt_count?: number } | undefined;
    return Number(row?.receipt_count || 0);
  }

  private recordScheduledDispositionSync(
    deliveryId: string,
    authenticatedBodyFingerprint: string | null,
    disposition: ExactReviewScheduledDisposition,
  ) {
    if (!authenticatedBodyFingerprint) return null;
    // Persist the exact response with admission so response-loss retries replay
    // it without consuming queue capacity or scheduled-feed tokens twice.
    const dispositionJson = JSON.stringify(disposition, null, 2);
    const updated = Array.from(
      this.storage.sql.exec(
        `UPDATE ${EXACT_REVIEW_QUEUE_DELIVERY_TABLE}
            SET scheduled_disposition_json = ?
          WHERE delivery_id = ? AND authenticated_body_fingerprint = ?
        RETURNING delivery_id`,
        dispositionJson,
        deliveryId,
        authenticatedBodyFingerprint,
      ),
    );
    if (updated.length !== 1) {
      throw new Error("scheduled exact-review disposition receipt is unavailable");
    }
    return dispositionJson;
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
      this.disableLegacyMirrorSync();
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
      this.disableLegacyMirrorSync();
      return;
    }
    try {
      this.storage.kv.put(EXACT_REVIEW_QUEUE_STATE_KEY, shadow);
      this.legacyMirrorDisabled = false;
    } catch {
      this.disableLegacyMirrorSync();
    }
  }

  private disableLegacyMirrorSync() {
    try {
      // A failed refresh must not leave a stale generation that becomes
      // indistinguishable from rollback-era mutations on the next upgrade.
      this.storage.kv.delete(EXACT_REVIEW_QUEUE_STATE_KEY);
    } catch {
      console.warn("exact_review_legacy_rollback_shadow_cleanup_failed");
      throw new Error("exact-review legacy rollback shadow cleanup failed");
    }
    this.reportLegacyMirrorUnavailable();
  }

  private reportLegacyMirrorUnavailable() {
    this.legacyMirrorDisabled = true;
    if (this.legacyMirrorWarningReported) return;
    this.legacyMirrorWarningReported = true;
    console.warn("exact_review_legacy_rollback_shadow_unavailable");
  }

  private cleanupLegacyCompatibilitySync() {
    if (!this.migratedAt || Date.now() < this.migratedAt + EXACT_REVIEW_QUEUE_LEGACY_ROLLBACK_MS) {
      return;
    }
    this.storage.kv.delete(EXACT_REVIEW_QUEUE_STATE_KEY);
  }

  private async processCommandIntakes(
    now: number,
    hostedTargetMetadataToken: HostedTargetMetadataToken,
  ) {
    for (const record of this.commandIntakeStore.due(now)) {
      if (!this.commandIntakeStore.isCurrent(record)) {
        this.commandIntakeStore.finish(
          record.intake.commandVersionId,
          "superseded",
          Date.now(),
          "newer_comment_version",
        );
        continue;
      }
      const admission = await this.hostedTargetAdmission(
        record.intake.decision.targetRepo,
        hostedTargetMetadataToken,
      );
      const observedAt = Date.now();
      if (!this.commandIntakeStore.isCurrent(record)) {
        this.commandIntakeStore.finish(
          record.intake.commandVersionId,
          "superseded",
          observedAt,
          "newer_comment_version",
        );
        continue;
      }
      if (admission.outcome === "terminal") {
        this.commandIntakeStore.finish(
          record.intake.commandVersionId,
          "rejected",
          observedAt,
          "private_target_unsupported",
        );
        continue;
      }
      if (admission.outcome === "retryable") {
        if (record.attempts + 1 >= EXACT_REVIEW_COMMAND_TARGET_ADMISSION_ATTEMPT_LIMIT) {
          this.commandIntakeStore.finish(
            record.intake.commandVersionId,
            "rejected",
            observedAt,
            "target_visibility_unverified_exhausted",
          );
        } else {
          this.commandIntakeStore.defer(
            record,
            observedAt,
            "target_visibility_unverified",
            admission.retryAt,
          );
        }
        continue;
      }
      const circuitRetryAt = exactReviewGithubTargetAppCircuitRetryAt(
        this.readStateSync(),
        record.intake.decision.targetRepo,
        observedAt,
      );
      if (circuitRetryAt > observedAt) {
        this.commandIntakeStore.defer(
          record,
          observedAt,
          "target GitHub credential circuit is open",
          circuitRetryAt + exactReviewCredentialRecoveryJitterMs(record.intake.commandVersionId),
          false,
        );
        continue;
      }
      let tokenPromise: Promise<string> | null = null;
      const token = () => (tokenPromise ??= exactReviewCommandTargetToken(this.env, record.intake));
      try {
        let current = record;
        if (current.stage === "verify_pending") {
          const decision = await this.verifyCommandIntake(current, token());
          if (!decision) continue;
          if (!this.commandIntakeStore.markVerified(current, Date.now())) {
            this.commandIntakeStore.finish(
              current.intake.commandVersionId,
              "superseded",
              Date.now(),
              "newer_comment_version",
            );
            continue;
          }
          this.commandIntakeStore.advance(
            current.intake.commandVersionId,
            "enqueue_pending",
            Date.now(),
            decision,
          );
          current = { ...current, stage: "enqueue_pending", verifiedDecision: decision };
        }
        if (current.stage === "enqueue_pending") {
          if (!this.commandIntakeStore.isCurrent(current)) {
            this.commandIntakeStore.finish(
              current.intake.commandVersionId,
              "superseded",
              Date.now(),
              "newer_comment_version",
            );
            continue;
          }
          const decision = current.verifiedDecision;
          if (!decision) throw new Error("verified command decision is missing");
          const response = await this.fetch(
            new Request("https://clawsweeper-exact-review-queue/enqueue", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                delivery_id: current.intake.commandVersionId,
                decision,
              }),
            }),
            hostedTargetMetadataToken,
          );
          const result = objectValue(await response.json().catch(() => null));
          if (!response.ok) {
            throw new Error(`command queue admission failed: ${response.status}`);
          }
          if (result.stale_source === true || result.stale_command === true) {
            this.commandIntakeStore.retryVerification(
              current,
              Date.now(),
              result.stale_command === true ? "older_command_version" : "stale_source_authority",
            );
            continue;
          }
          if (result.queued !== true && result.deduped !== true) {
            this.commandIntakeStore.finish(
              current.intake.commandVersionId,
              "rejected",
              Date.now(),
              String(result.reason || result.error || "queue_rejected"),
            );
            continue;
          }
          this.commandIntakeStore.advance(
            current.intake.commandVersionId,
            "effects_pending",
            Date.now(),
            decision,
          );
          current = { ...current, stage: "effects_pending" };
        }
        if (current.stage === "effects_pending") {
          if (!this.commandIntakeStore.isCurrent(current)) {
            this.commandIntakeStore.finish(
              current.intake.commandVersionId,
              "superseded",
              Date.now(),
              "newer_comment_version",
            );
            continue;
          }
          const decision = current.verifiedDecision;
          if (!decision) throw new Error("command effects decision is missing");
          await Promise.all([
            convergeCommandAcknowledgement({
              env: this.env,
              token: token(),
              decision,
              sourceCommentId: current.intake.sourceCommentId,
            }),
            addCommandReaction({
              env: this.env,
              token: token(),
              repo: decision.targetRepo,
              commentId: current.intake.sourceCommentId,
            }),
          ]);
          this.commandIntakeStore.finish(
            current.intake.commandVersionId,
            "completed",
            Date.now(),
            null,
          );
        }
      } catch (error) {
        const observedAt = Date.now();
        const observation = exactReviewGithubTargetAppObservation(
          error,
          record.intake.decision.targetRepo,
          observedAt,
        );
        this.recordAuthorityGithubOutcomeSync(
          record.attempts > 0,
          observation ? "throttle" : "error",
          observedAt,
          observation,
        );
        this.commandIntakeStore.defer(
          record,
          observedAt,
          sanitizedServerError(error),
          observation
            ? observation.retryAt +
                exactReviewCredentialRecoveryJitterMs(record.intake.commandVersionId)
            : undefined,
        );
      }
    }
  }

  private async verifyCommandIntake(
    record: ExactReviewCommandIntakeRecord,
    token: Promise<string>,
  ): Promise<DirectReReviewDecision | null> {
    const intake = record.intake;
    let sourceComment: Record<string, unknown>;
    try {
      sourceComment = objectValue(
        await githubTokenJson({
          env: this.env,
          token: await token,
          path: `/repos/${intake.decision.targetRepo}/issues/comments/${intake.sourceCommentId}`,
          method: "GET",
          body: undefined,
          errorLabel: "direct re-review source comment",
        }),
      );
    } catch (error) {
      if (error instanceof GitHubRequestError && (error.status === 404 || error.status === 410)) {
        this.commandIntakeStore.finish(
          intake.commandVersionId,
          "rejected",
          Date.now(),
          "source_comment_missing",
        );
        return null;
      }
      throw error;
    }
    const sourceIssueUrl = String(sourceComment.issue_url || "");
    if (
      !sourceIssueUrl.endsWith(
        `/repos/${intake.decision.targetRepo}/issues/${intake.decision.itemNumber}`,
      )
    ) {
      this.commandIntakeStore.finish(
        intake.commandVersionId,
        "rejected",
        Date.now(),
        "source_comment_item_mismatch",
      );
      return null;
    }
    const liveCommentUpdatedAt = Date.parse(String(sourceComment.updated_at || ""));
    const admittedCommentUpdatedAt = Date.parse(intake.sourceCommentUpdatedAt);
    const liveCommentDigest = await sha256Hex(
      new TextEncoder().encode(String(sourceComment.body || "")),
    );
    if (!Number.isFinite(liveCommentUpdatedAt) || liveCommentUpdatedAt < admittedCommentUpdatedAt) {
      throw new Error("live source comment version is not yet authoritative");
    }
    if (
      liveCommentUpdatedAt > admittedCommentUpdatedAt ||
      liveCommentDigest !== intake.commandBodyDigest
    ) {
      this.commandIntakeStore.finish(
        intake.commandVersionId,
        "rejected",
        Date.now(),
        "source_comment_changed",
      );
      return null;
    }

    let decision: DirectReReviewDecision = {
      ...intake.decision,
      sourceCommentVerified: true,
    };
    const itemPath = decision.itemKind === "pull_request" ? "pulls" : "issues";
    const item = objectValue(
      await githubTokenJson({
        env: this.env,
        token: await token,
        path: `/repos/${decision.targetRepo}/${itemPath}/${decision.itemNumber}`,
        method: "GET",
        body: undefined,
        errorLabel: "direct re-review item",
      }),
    );
    if (String(item.state || "").toLowerCase() !== "open") {
      this.commandIntakeStore.finish(
        intake.commandVersionId,
        "rejected",
        Date.now(),
        "target_not_open",
      );
      return null;
    }
    if (decision.itemKind === "pull_request") {
      const headSha = String(objectValue(item.head).sha || "")
        .trim()
        .toLowerCase();
      const sourceUpdatedAt = String(item.updated_at || "").trim();
      if (!/^[0-9a-f]{40}$/.test(headSha)) {
        throw new Error("live pull request head is invalid");
      }
      const sourceAuthoritySeq = this.storage.transactionSync(() => {
        const stored = this.storage.kv.get(EXACT_REVIEW_SOURCE_AUTHORITY_SEQUENCE_KEY);
        const current = stored === undefined ? 0 : Number(stored);
        if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) {
          throw new Error("invalid exact-review source authority sequence");
        }
        const next = current + 1;
        this.storage.kv.put(EXACT_REVIEW_SOURCE_AUTHORITY_SEQUENCE_KEY, next);
        return next;
      });
      decision = {
        ...decision,
        sourceHeadSha: headSha,
        sourceHeadVerified: true,
        sourceAuthoritySeq,
        ...(Number.isFinite(Date.parse(sourceUpdatedAt)) ? { sourceUpdatedAt } : {}),
      };
    }
    return decision;
  }

  private async processSourceAuthorityReservations(
    now: number,
    hostedTargetMetadataToken: HostedTargetMetadataToken,
  ) {
    const reservations = (await this.sourceAuthorityReservations())
      .filter((reservation) => reservation.nextAttemptAt <= now)
      .sort(
        (left, right) =>
          left.nextAttemptAt - right.nextAttemptAt ||
          left.sourceAuthoritySeq - right.sourceAuthoritySeq,
      )
      .slice(0, 8);
    for (const reservation of reservations) {
      const admission = await this.hostedTargetAdmission(
        reservation.decision.targetRepo,
        hostedTargetMetadataToken,
      );
      const observedAt = Date.now();
      const current = exactReviewSourceAuthorityReservationFrom(
        this.storage.kv.get(exactReviewSourceAuthorityReservationKey(reservation.deliveryId)),
      );
      if (current?.sourceAuthoritySeq !== reservation.sourceAuthoritySeq) continue;
      if (admission.outcome === "terminal") {
        this.completeSourceAuthorityReservationSync(current, "mismatch");
        continue;
      }
      if (admission.outcome === "retryable") {
        this.deferSourceAuthorityReservationSync(current, observedAt, admission.retryAt, false);
        continue;
      }
      const circuitRetryAt = exactReviewGithubTargetAppCircuitRetryAt(
        this.readStateSync(),
        current.decision.targetRepo,
        observedAt,
      );
      if (circuitRetryAt > observedAt) {
        this.recordAuthorityGithubOutcomeSync(
          current.attempts > 0,
          "skipped_by_circuit",
          observedAt,
        );
        this.deferSourceAuthorityReservationSync(
          current,
          observedAt,
          circuitRetryAt + exactReviewCredentialRecoveryJitterMs(current.deliveryId),
          false,
        );
        continue;
      }
      try {
        const liveHeadSha = await exactReviewSourceAuthorityLiveHead(this.env, current);
        this.recordAuthorityGithubOutcomeSync(current.attempts > 0, "success", Date.now());
        const reservedHeadSha = String(current.decision.sourceHeadSha || "").toLowerCase();
        if (liveHeadSha !== reservedHeadSha) {
          this.completeSourceAuthorityReservationSync(current, "mismatch");
          continue;
        }
        const response = await this.fetch(
          new Request("https://clawsweeper-exact-review-queue/enqueue", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              delivery_id: current.deliveryId,
              ...(current.ingress ? { ingress: current.ingress } : {}),
              decision: {
                ...current.decision,
                sourceHeadVerified: true,
              },
            }),
          }),
          hostedTargetMetadataToken,
        );
        if (!response.ok) throw new Error(`source authority enqueue failed: ${response.status}`);
        this.completeSourceAuthorityReservationSync(current, "enqueued");
      } catch (error) {
        const failedAt = Date.now();
        const observation = exactReviewGithubTargetAppObservation(
          error,
          current.decision.targetRepo,
          failedAt,
        );
        this.recordAuthorityGithubOutcomeSync(
          current.attempts > 0,
          observation ? "throttle" : "error",
          failedAt,
          observation,
        );
        console.warn("exact-review source authority verification deferred", {
          event: "source_authority_verification_deferred",
          category: exactReviewDispatchFailure(error).failureClass,
        });
        this.deferSourceAuthorityReservationSync(
          current,
          failedAt,
          observation
            ? observation.retryAt + exactReviewCredentialRecoveryJitterMs(current.deliveryId)
            : undefined,
        );
      }
    }
  }

  private async processBranchAuthorityReservations(
    now: number,
    hostedTargetMetadataToken: HostedTargetMetadataToken,
  ) {
    const reservations = (await this.branchAuthorityReservations())
      .filter((reservation) => reservation.nextAttemptAt <= now)
      .sort(
        (left, right) =>
          left.nextAttemptAt - right.nextAttemptAt ||
          left.deliveryId.localeCompare(right.deliveryId),
      )
      .slice(0, 8);
    for (const reservation of reservations) {
      const admission = await this.hostedTargetAdmission(
        reservation.decision.targetRepo,
        hostedTargetMetadataToken,
      );
      const observedAt = Date.now();
      const current = exactReviewBranchAuthorityReservationFrom(
        this.storage.kv.get(exactReviewBranchAuthorityReservationKey(reservation.deliveryId)),
      );
      if (!current || stableJson(current) !== stableJson(reservation)) continue;
      if (admission.outcome === "terminal") {
        this.completeBranchAuthorityReservationSync(current, true);
        continue;
      }
      if (admission.outcome === "retryable") {
        this.deferBranchAuthorityReservationSync(current, observedAt, admission.retryAt, false);
        continue;
      }
      const circuitRetryAt = exactReviewGithubTargetAppCircuitRetryAt(
        this.readStateSync(),
        current.decision.targetRepo,
        observedAt,
      );
      if (circuitRetryAt > observedAt) {
        this.recordAuthorityGithubOutcomeSync(
          current.attempts > 0,
          "skipped_by_circuit",
          observedAt,
        );
        this.deferBranchAuthorityReservationSync(
          current,
          observedAt,
          circuitRetryAt + exactReviewCredentialRecoveryJitterMs(current.deliveryId),
          false,
        );
        continue;
      }
      try {
        const targetBranch = await exactReviewTargetDefaultBranch(
          this.env,
          current.decision.targetRepo,
          current.installationId,
        );
        this.recordAuthorityGithubOutcomeSync(current.attempts > 0, "success", Date.now());
        const forwardPath = current.sourceAuthorityRequired ? "/source-authority" : "/enqueue";
        const response = await this.fetch(
          new Request(`https://clawsweeper-exact-review-queue${forwardPath}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              delivery_id: current.deliveryId,
              ...(current.ingress ? { ingress: current.ingress } : {}),
              ...(current.sourceAuthorityRequired
                ? { installation_id: current.installationId }
                : {}),
              decision: { ...current.decision, targetBranch },
            }),
          }),
          hostedTargetMetadataToken,
        );
        if (!response.ok) throw new Error(`branch authority forward failed: ${response.status}`);
        this.completeBranchAuthorityReservationSync(current);
      } catch (error) {
        const failedAt = Date.now();
        const observation = exactReviewGithubTargetAppObservation(
          error,
          current.decision.targetRepo,
          failedAt,
        );
        this.recordAuthorityGithubOutcomeSync(
          current.attempts > 0,
          observation ? "throttle" : "error",
          failedAt,
          observation,
        );
        console.warn("exact-review branch authority resolution deferred", {
          event: "branch_authority_resolution_deferred",
          category: exactReviewDispatchFailure(error).failureClass,
        });
        this.deferBranchAuthorityReservationSync(
          current,
          failedAt,
          observation
            ? observation.retryAt + exactReviewCredentialRecoveryJitterMs(current.deliveryId)
            : undefined,
        );
      }
    }
  }

  private recordAuthorityGithubOutcomeSync(
    repeatRevision: boolean,
    outcome: ExactReviewGithubRequestMetric["outcome"],
    now: number,
    observation?: ExactReviewGithubRateLimitObservation,
  ) {
    this.storage.transactionSync(() => {
      const state = this.readStateSync();
      if (observation) applyExactReviewGithubCredentialCircuits(state, [observation]);
      applyExactReviewGithubRequestMetrics(
        state,
        [
          {
            scope: "target_app",
            category: "item_metadata",
            mode: "read",
            outcome,
            repeatRevision,
            count: 1,
          },
        ],
        now,
      );
      this.writeStateSync(state);
    });
  }

  private completeSourceAuthorityReservationSync(
    expected: ExactReviewSourceAuthorityReservation,
    disposition: "enqueued" | "mismatch",
  ) {
    this.storage.transactionSync(() => {
      const key = exactReviewSourceAuthorityReservationKey(expected.deliveryId);
      const current = exactReviewSourceAuthorityReservationFrom(this.storage.kv.get(key));
      if (current?.sourceAuthoritySeq === expected.sourceAuthoritySeq) {
        if (disposition === "mismatch") {
          this.storage.sql.exec(
            `INSERT OR IGNORE INTO ${EXACT_REVIEW_QUEUE_DELIVERY_TABLE}
             (delivery_id, received_at) VALUES (?, ?)`,
            expected.deliveryId,
            Date.now(),
          );
        }
        this.storage.kv.delete(key);
      }
    });
  }

  private deferSourceAuthorityReservationSync(
    expected: ExactReviewSourceAuthorityReservation,
    now: number,
    requestedRetryAt?: number,
    incrementAttempts = true,
  ) {
    this.storage.transactionSync(() => {
      const key = exactReviewSourceAuthorityReservationKey(expected.deliveryId);
      const current = exactReviewSourceAuthorityReservationFrom(this.storage.kv.get(key));
      if (current?.sourceAuthoritySeq !== expected.sourceAuthoritySeq) return;
      const attempts = incrementAttempts
        ? Math.min(EXACT_REVIEW_SOURCE_AUTHORITY_RETRY_LIMIT, current.attempts + 1)
        : current.attempts;
      const backoffMs = Math.min(
        EXACT_REVIEW_SOURCE_AUTHORITY_RETRY_MAX_MS,
        EXACT_REVIEW_SOURCE_AUTHORITY_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1),
      );
      this.storage.kv.put(key, {
        ...current,
        attempts,
        nextAttemptAt: Math.max(now + 1_000, requestedRetryAt || now + backoffMs),
      });
    });
  }

  private completeBranchAuthorityReservationSync(
    expected: ExactReviewBranchAuthorityReservation,
    rejected = false,
  ) {
    this.storage.transactionSync(() => {
      const key = exactReviewBranchAuthorityReservationKey(expected.deliveryId);
      const current = exactReviewBranchAuthorityReservationFrom(this.storage.kv.get(key));
      if (!current || stableJson(current) !== stableJson(expected)) return;
      if (rejected) {
        this.storage.sql.exec(
          `INSERT OR IGNORE INTO ${EXACT_REVIEW_QUEUE_DELIVERY_TABLE}
           (delivery_id, received_at) VALUES (?, ?)`,
          expected.deliveryId,
          Date.now(),
        );
      }
      this.storage.kv.delete(key);
    });
  }

  private deferBranchAuthorityReservationSync(
    expected: ExactReviewBranchAuthorityReservation,
    now: number,
    requestedRetryAt?: number,
    incrementAttempts = true,
  ) {
    this.storage.transactionSync(() => {
      const key = exactReviewBranchAuthorityReservationKey(expected.deliveryId);
      const current = exactReviewBranchAuthorityReservationFrom(this.storage.kv.get(key));
      if (!current || stableJson(current) !== stableJson(expected)) return;
      const attempts = incrementAttempts
        ? Math.min(EXACT_REVIEW_SOURCE_AUTHORITY_RETRY_LIMIT, current.attempts + 1)
        : current.attempts;
      const backoffMs = Math.min(
        EXACT_REVIEW_SOURCE_AUTHORITY_RETRY_MAX_MS,
        EXACT_REVIEW_SOURCE_AUTHORITY_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1),
      );
      this.storage.kv.put(key, {
        ...current,
        attempts,
        nextAttemptAt: Math.max(now + 1_000, requestedRetryAt || now + backoffMs),
      });
    });
  }

  private async sourceAuthorityReservations() {
    const values = await this.storage.list({
      prefix: EXACT_REVIEW_SOURCE_AUTHORITY_RESERVATION_PREFIX,
    });
    return Array.from(values.values())
      .map(exactReviewSourceAuthorityReservationFrom)
      .filter(
        (reservation): reservation is ExactReviewSourceAuthorityReservation => reservation !== null,
      );
  }

  private async branchAuthorityReservations() {
    const values = await this.storage.list({
      prefix: EXACT_REVIEW_BRANCH_AUTHORITY_RESERVATION_PREFIX,
    });
    return Array.from(values.values())
      .map(exactReviewBranchAuthorityReservationFrom)
      .filter(
        (reservation): reservation is ExactReviewBranchAuthorityReservation => reservation !== null,
      );
  }

  private async nextSourceAuthorityVerificationAt() {
    const reservations = [
      ...(await this.sourceAuthorityReservations()),
      ...(await this.branchAuthorityReservations()),
    ];
    return reservations.reduce<number | null>(
      (next, reservation) =>
        next === null ? reservation.nextAttemptAt : Math.min(next, reservation.nextAttemptAt),
      null,
    );
  }

  private async scheduleSourceAuthorityVerification(
    next: number,
    reason: "source_authority" | "command_intake" = "source_authority",
  ) {
    const scheduled = await this.storage.getAlarm();
    const now = Date.now();
    if (scheduled === null || scheduled <= now || next < scheduled) {
      await this.storage.setAlarm(next);
      const backoff = (this.bayTelemetryNoProgressDeadline ?? 0) > now;
      this.scheduledAlarmDecision = [reason, next, now, null, backoff];
    }
  }

  private scheduleNext(state: ExactReviewQueueState, now: number, forceScan = false) {
    return this.scheduleNextFromState(state, now, forceScan);
  }

  private async scheduleNextFromState(
    state: ExactReviewQueueState,
    now: number,
    forceScan: boolean,
  ) {
    // Materialize the lazy properties once; repeated Object.values over their
    // accessor dictionary is substantially more expensive than a plain census.
    state = { ...state, items: { ...state.items } };
    const publicationControl = this.refreshPublicationControlSync(state, now);
    const batchOwnership = this.batchStore.activeLeaseSnapshot(now);
    const preservedWakeAt = this.scheduledAlarmDecision?.[1];
    // With every pending item delayed past the alarm and every active lease
    // still valid then, neither admission nor batch departure can wake earlier.
    // Parked/unknown states use the full path. Auxiliary wake-ups are always
    // read below, and the actual alarm is checked again after the awaits.
    const preserveQueueWake =
      !forceScan &&
      preservedWakeAt !== undefined &&
      preservedWakeAt > now &&
      state.dispatcher?.state !== "paused" &&
      state.dispatcher?.state !== "blocked" &&
      Object.keys(state.items).length > 0 &&
      Object.values(state.items).every((item) =>
        item.state === "pending"
          ? item.nextAttemptAt >= preservedWakeAt
          : (item.state === "leased" || item.state === "dispatching") &&
            exactReviewEffectiveLeaseExpiresAt(
              item,
              exactReviewPublicationDispatchLeaseMs(this.env),
              exactReviewHeartbeatGraceMs(this.env),
            ) >= preservedWakeAt,
      );
    const legacyExcludedItemKeys = new Set<string>(batchOwnership.itemKeys);
    if (!preserveQueueWake && exactReviewPublicationBatchingEnabled(this.env)) {
      for (const item of Object.values(state.items)) {
        // Block only new legacy admission. In-flight legacy publications must
        // retain their dispatch/lease expiry wake-ups while the rollout drains.
        if (
          item.state === "pending" &&
          exactReviewQueueIsBatchablePublication(item) &&
          !item.terminalFinalization
        ) {
          legacyExcludedItemKeys.add(item.key);
        }
      }
    }
    const queueNext = preserveQueueWake
      ? preservedWakeAt
      : exactReviewQueueNextWakeAt(
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
          Number(state.dispatcher?.reviewAdmissionNextAt || 0) > now
            ? Number(state.dispatcher?.reviewAdmissionNextAt)
            : null,
        );
    const heads = preserveQueueWake ? new Map<string, number>() : this.publicationHeadsSync(state);
    const batchDeparture = preserveQueueWake
      ? null
      : exactReviewPublicationBatchDeparture(
          this.env,
          state,
          now,
          new Set(batchOwnership.itemKeys),
          batchOwnership.activeBatches,
          this.freshPublicationItemKeysSync(state, now, heads),
          this.supersededPublicationItemKeysSync(state, heads),
        );
    const sourceAuthorityNext = await this.nextSourceAuthorityVerificationAt();
    const commandIntakeNext = this.commandIntakeStore.nextAttemptAt();
    const credentialCircuitNext = exactReviewGithubCircuitNextWakeAt(state, now);
    const bayTelemetryRecoveryPending = this.bayTelemetryRecoveryPendingSync();
    if (!bayTelemetryRecoveryPending) this.bayTelemetryNoProgressDeadline = null;
    const bayTelemetryRecoveryNext = bayTelemetryRecoveryPending
      ? Math.max(now + 1_000, this.bayTelemetryNoProgressDeadline ?? 0)
      : null;
    const candidates: Array<readonly [AlarmWakeReason, number | null]> = [
      ["queue", queueNext],
      ["batch_lease", batchOwnership.nextLeaseExpiresAt],
      ["batch_departure", batchDeparture?.dueAt ?? null],
      ["source_authority", sourceAuthorityNext],
      ["command_intake", commandIntakeNext],
      ["credential_circuit", credentialCircuitNext],
      ["bay_recovery", bayTelemetryRecoveryNext],
    ];
    const selected = candidates.reduce(
      (a, b) => (b[1] !== null && b[1] < (a?.[1] ?? Infinity) ? b : a),
      null as (typeof candidates)[number] | null,
    );
    if (selected === null) {
      await this.storage.deleteAlarm();
      this.scheduledAlarmDecision = null;
      return;
    }
    const next = selected[1]!;
    const scheduled = await this.storage.getAlarm();
    if (
      preserveQueueWake &&
      (scheduled === null || scheduled <= now || scheduled > preservedWakeAt)
    ) {
      // An alarm was consumed/replaced while we awaited another authority.
      // Re-read durable state instead of reusing the earlier request snapshot.
      await this.scheduleNextFromState(this.readSchedulingStateSync(), Date.now(), true);
      return;
    }
    if (scheduled === null || scheduled <= now || next < scheduled) {
      await this.storage.setAlarm(next);
      this.scheduledAlarmDecision = [
        selected[0],
        next,
        now,
        bayTelemetryRecoveryPending,
        (this.bayTelemetryNoProgressDeadline ?? 0) > now,
      ];
    }
  }
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
    ...(protocolVersion === 2
      ? { repeat_revision: Number(item.publicationFailureAttempts || 0) > 0 }
      : {}),
    decision: item.leaseDecision,
    ...(item.terminalFinalization
      ? {
          terminal_finalization: item.terminalFinalization,
          lifecycle_projection: exactReviewTerminalFinalizationProjection(
            item,
            item.leaseRevision ?? item.revision,
          ),
        }
      : {}),
  };
}

type ExactReviewTerminalFinalizationTuple = {
  leaseId: string;
  itemKey: string;
  leaseRevision: number;
  claimGeneration: number;
  runId: string;
  runAttempt: number;
};

function exactReviewTerminalFinalizationTuple(
  value: unknown,
): ExactReviewTerminalFinalizationTuple | null {
  const body = objectValue(value);
  const leaseId = String(body.lease_id || "").trim();
  const itemKey = String(body.item_key || "").trim();
  const leaseRevision = Number(body.lease_revision);
  const claimGeneration = Number(body.claim_generation);
  const runId = String(body.run_id || "").trim();
  const runAttempt = exactReviewRunAttempt(body.run_attempt);
  if (
    !leaseId ||
    !itemKey ||
    !/^\d+$/.test(runId) ||
    !Number.isInteger(leaseRevision) ||
    leaseRevision < 1 ||
    !Number.isInteger(claimGeneration) ||
    claimGeneration < 1 ||
    runAttempt === null
  ) {
    return null;
  }
  return { leaseId, itemKey, leaseRevision, claimGeneration, runId, runAttempt };
}

function exactReviewTerminalFinalizationLeaseActive(
  item: ExactReviewQueueItem | undefined,
  tuple: ExactReviewTerminalFinalizationTuple,
  now: number,
  env: unknown,
) {
  return Boolean(
    item &&
    item.terminalFinalization &&
    exactReviewQueueIsPublication(item) &&
    item.state === "leased" &&
    item.leaseId === tuple.leaseId &&
    item.leaseRevision === tuple.leaseRevision &&
    exactReviewClaimGeneration(item.claimGeneration) === tuple.claimGeneration &&
    item.claimedRunId === tuple.runId &&
    item.claimedRunAttempt === tuple.runAttempt &&
    isLiveExactReviewLease(
      item,
      now,
      exactReviewPublicationDispatchLeaseMs(env),
      exactReviewHeartbeatGraceMs(env),
    ),
  );
}

function exactReviewTerminalFinalization(
  disposition: Exclude<LifecycleTerminalDisposition, "requeue">,
  projection?: ExactReviewLifecycleProjectionIdentity,
): ExactReviewTerminalFinalization {
  const withProjection = (finalization: Omit<ExactReviewTerminalFinalization, "projection">) => ({
    ...finalization,
    ...(projection ? { projection } : {}),
  });
  switch (disposition) {
    case "dead_letter":
      return withProjection({
        disposition,
        statusState: "Failed",
        statusDetail:
          "Durable publication exhausted its retry budget and was retained for operator dead-letter recovery.",
      });
    case "failure":
      return withProjection({
        disposition,
        statusState: "Failed",
        statusDetail:
          "The exact review reached a durable terminal failure and needs operator attention.",
      });
    case "review_completed_routed":
      return withProjection({
        disposition,
        statusState: "Complete",
        statusDetail: "The durable review result and its route handoff completed.",
      });
    case "superseded":
      return withProjection({
        disposition,
        statusState: "Complete",
        statusDetail: "A newer review tuple already exists; this stale result was superseded.",
      });
    case "target_closed":
      return withProjection({
        disposition,
        statusState: "Complete",
        statusDetail: "The item is closed; no stale verdict was published.",
      });
    case "target_missing":
      return withProjection({
        disposition,
        statusState: "Complete",
        statusDetail:
          "The repository is accessible but the item is missing; no stale verdict was published.",
      });
    case "policy_noop":
      return withProjection({
        disposition,
        statusState: "Complete",
        statusDetail: "The exact review reached a deterministic policy veto; no action was taken.",
      });
    case "guarded_open":
      return withProjection({
        disposition,
        statusState: "Complete",
        statusDetail:
          "A deterministic remain-open guard blocked publication of a stale close verdict.",
      });
  }
}

function exactReviewTerminalFinalizationProjection(
  item: Pick<ExactReviewQueueItem, "key" | "decision" | "terminalFinalization">,
  revision: number,
): ExactReviewLifecycleProjectionIdentity {
  return (
    item.terminalFinalization?.projection ?? {
      canonicalTargetKey: `${item.decision.targetRepo}#${item.decision.itemNumber}`,
      fenceKey: item.key,
      revision,
    }
  );
}

function exactReviewTerminalFinalizationDriverKey(
  identity: ExactReviewLifecycleProjectionIdentity,
) {
  return `terminal-finalization:${identity.fenceKey}:${identity.revision}`;
}

function exactReviewTerminalFinalizationDecision(
  projection: ExactReviewLifecycleProjection,
): ExactReviewDecision {
  const separator = projection.canonicalTargetKey.lastIndexOf("#");
  const targetRepo = projection.canonicalTargetKey.slice(0, separator);
  const itemNumber = Number(projection.canonicalTargetKey.slice(separator + 1));
  if (!targetRepo || !Number.isSafeInteger(itemNumber) || itemNumber < 1) {
    throw new Error("invalid terminal finalization projection identity");
  }
  return {
    targetRepo,
    targetBranch: "main",
    itemNumber,
    itemKind: "issue",
    sourceEvent: "issues",
    sourceAction: EXACT_REVIEW_ARTIFACT_PUBLISH_SOURCE_ACTION,
    supersedesInProgress: false,
    ...(projection.admission.statusMarker === null
      ? {}
      : { commandStatusMarker: projection.admission.statusMarker }),
    ...(projection.admission.statusCommentId === null
      ? {}
      : { statusCommentId: projection.admission.statusCommentId }),
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

function exactReviewLifecycleTelemetryPublicationOutcome(
  completion: ExactReviewPublicationCompletion,
): "superseded" | "retryable" | "permanent" | null {
  if (completion.kind === "superseded") return "superseded";
  if (completion.kind === "retryable_failure" || completion.kind === "refresh_required") {
    return "retryable";
  }
  return completion.kind === "permanent_failure" ? "permanent" : null;
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
  poolClassValue?: unknown,
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
    refresh_required: new Set([
      "artifact_unavailable",
      "artifact_expired",
      "close_coverage_retry",
      "invalid_artifact",
    ]),
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
  const poolClass =
    poolClassValue === undefined || poolClassValue === ""
      ? undefined
      : poolClassValue === "repository_actions" || poolClassValue === "target_app"
        ? poolClassValue
        : null;
  if (poolClass === null) return null;
  return {
    kind,
    reasonCode,
    ...(errorFingerprint ? { errorFingerprint } : {}),
    ...(poolClass ? { poolClass } : {}),
  };
}

function exactReviewRunAttempt(value): number | null {
  const runAttempt = Number(value);
  return Number.isInteger(runAttempt) && runAttempt > 0 ? runAttempt : null;
}

function exactReviewLifecycleIdentity(value: Record<string, unknown>) {
  const canonicalTargetKey = value.canonical_target_key;
  const fenceKey = value.fence_key;
  const revision = Number(value.revision);
  if (
    typeof canonicalTargetKey !== "string" ||
    typeof fenceKey !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*$/.test(canonicalTargetKey) ||
    !fenceKey ||
    fenceKey.length > 512 ||
    /[\r\n]/.test(fenceKey) ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  ) {
    return null;
  }
  return { canonicalTargetKey, fenceKey, revision };
}

function exactReviewGithubEffect(
  operations: ReadonlyArray<{ section: string; content: string | null }>,
) {
  for (const operation of operations) {
    if (operation.section !== "items" || operation.content === null) continue;
    const commentId = /^review_comment_id:\s*([1-9]\d*)\s*$/m.exec(operation.content)?.[1];
    const digest = /^review_comment_sha256:\s*([0-9a-f]{64})\s*$/m.exec(operation.content)?.[1];
    if (!commentId || !digest) continue;
    const parsedCommentId = Number(commentId);
    if (Number.isSafeInteger(parsedCommentId) && parsedCommentId > 0) {
      return { commentId: parsedCommentId, digest };
    }
  }
  return null;
}

function exactReviewLifecycleTerminalDisposition(
  value: unknown,
): LifecycleTerminalDisposition | null {
  return [
    "review_completed_routed",
    "superseded",
    "requeue",
    "dead_letter",
    "target_closed",
    "target_missing",
    "policy_noop",
    "guarded_open",
    "failure",
  ].includes(value as LifecycleTerminalDisposition)
    ? (value as LifecycleTerminalDisposition)
    : null;
}

function exactReviewDeadLetterIds(value): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) return null;
  const ids = value.map((entry) => String(entry || "").trim());
  if (ids.some((id) => !id || id.length > 500) || new Set(ids).size !== ids.length) return null;
  return ids;
}

function exactReviewSeededParkedCursor(value: string) {
  const match = /^([0-9a-f]{64}):([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*)$/.exec(value);
  return match ? { sortKey: match[1], itemKey: match[2] } : null;
}

function exactReviewParkedOperatorItems(
  value: unknown,
  maximum: number,
): Array<{
  itemKey: string;
  revision: number;
  updatedAt: number;
  sourceHeadSha: string | null;
  sourceBaseSha: string | null;
  sourceIsDraft: boolean | null;
  sourceContentRevision: string | null;
  sourceUpdatedAt: string | null;
}> | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) return null;
  const items: Array<{
    itemKey: string;
    revision: number;
    updatedAt: number;
    sourceHeadSha: string | null;
    sourceBaseSha: string | null;
    sourceIsDraft: boolean | null;
    sourceContentRevision: string | null;
    sourceUpdatedAt: string | null;
  }> = [];
  const keys = new Set<string>();
  for (const raw of value) {
    const item = objectValue(raw);
    const itemKey = String(item.item_key || "").trim();
    const revision = Number(item.revision);
    const updatedAt = Number(item.updated_at_ms);
    const sourceHeadSha = item.source_head_sha ? String(item.source_head_sha).toLowerCase() : null;
    const sourceBaseSha = item.source_base_sha ? String(item.source_base_sha).toLowerCase() : null;
    const hasSourceIsDraft = item.source_is_draft !== null && item.source_is_draft !== undefined;
    const sourceIsDraft =
      hasSourceIsDraft && typeof item.source_is_draft === "boolean" ? item.source_is_draft : null;
    const sourceContentRevision = item.source_content_revision
      ? String(item.source_content_revision).toLowerCase()
      : null;
    const sourceUpdatedAt = item.source_updated_at ? String(item.source_updated_at).trim() : null;
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*$/.test(itemKey) ||
      keys.has(itemKey.toLowerCase()) ||
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      !Number.isSafeInteger(updatedAt) ||
      updatedAt < 1 ||
      (sourceHeadSha !== null && !/^[0-9a-f]{40}$/.test(sourceHeadSha)) ||
      (sourceBaseSha !== null && !/^[0-9a-f]{40}$/.test(sourceBaseSha)) ||
      (hasSourceIsDraft && typeof item.source_is_draft !== "boolean") ||
      (sourceContentRevision !== null && !/^[0-9a-f]{64}$/.test(sourceContentRevision)) ||
      (sourceUpdatedAt !== null && !Number.isFinite(Date.parse(sourceUpdatedAt)))
    ) {
      return null;
    }
    keys.add(itemKey.toLowerCase());
    items.push({
      itemKey,
      revision,
      updatedAt,
      sourceHeadSha,
      sourceBaseSha,
      sourceIsDraft,
      sourceContentRevision,
      sourceUpdatedAt,
    });
  }
  return items;
}

function exactReviewRecoveryAliases(
  value,
  ids: string[],
  options: { maxIds?: number; allowEmpty?: boolean } = {},
): Map<string, Set<string>> | null {
  if (value === undefined) return null;
  if (
    !Array.isArray(value) ||
    value.length !== ids.length ||
    value.length > (options.maxIds ?? 10)
  ) {
    return null;
  }
  const guards = new Map<string, Set<string>>();
  for (const raw of value) {
    const guard = objectValue(raw);
    const id = String(guard.id || "");
    if (!ids.includes(id) || guards.has(id) || !Array.isArray(guard.aliases)) return null;
    if (guard.aliases.length < (options.allowEmpty ? 0 : 1) || guard.aliases.length > 100) {
      return null;
    }
    const aliases = new Set<string>();
    for (const alias of guard.aliases) {
      if (typeof alias !== "string" || !/^[^/#\s]+\/[^/#\s]+#[1-9]\d*$/.test(alias)) {
        return null;
      }
      aliases.add(alias.toLowerCase());
    }
    guards.set(id, aliases);
  }
  return guards;
}

function exactReviewRecoveryTargets(
  value,
  ids: string[],
): Map<string, { repo: string; number: number; sourceHeadSha: string | null }> | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length !== ids.length || value.length > 10) return null;
  const targets = new Map<string, { repo: string; number: number; sourceHeadSha: string | null }>();
  for (const raw of value) {
    const target = objectValue(raw);
    const id = String(target.id || "");
    const match = /^([^/#\s]+\/[^/#\s]+)#([1-9]\d*)$/.exec(String(target.target || ""));
    const sourceHeadSha = target.source_head_sha;
    if (
      !ids.includes(id) ||
      targets.has(id) ||
      !match ||
      (sourceHeadSha !== undefined &&
        (typeof sourceHeadSha !== "string" || !/^[0-9a-f]{40}$/i.test(sourceHeadSha)))
    ) {
      return null;
    }
    const number = Number(match[2]);
    if (!Number.isSafeInteger(number)) return null;
    targets.set(id, {
      repo: match[1].toLowerCase(),
      number,
      sourceHeadSha: typeof sourceHeadSha === "string" ? sourceHeadSha.toLowerCase() : null,
    });
  }
  return targets;
}

function exactReviewDeadLetterInventoryFingerprint(ids: string[]): string {
  let fingerprint = 2_166_136_261;
  for (const id of [...ids].sort()) {
    for (const character of `${id}\n`) {
      fingerprint = Math.imul(fingerprint ^ character.charCodeAt(0), 16_777_619) >>> 0;
    }
  }
  return `${ids.length}:${fingerprint.toString(16).padStart(8, "0")}`;
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

function exactReviewLifecycleCompletionDisposition({
  projection,
  outcome,
  publicationCompletion,
  requeued,
  parked,
  deadLetter,
  lifecycleTerminal,
}: {
  projection: ExactReviewLifecycleProjection | null;
  outcome: ExactReviewCompletionOutcome;
  publicationCompletion?: ExactReviewPublicationCompletion;
  requeued: boolean;
  parked: boolean;
  deadLetter: boolean;
  lifecycleTerminal?: LifecycleTerminalDisposition;
}): LifecycleTerminalDisposition | null {
  let disposition: LifecycleTerminalDisposition | null;
  if (deadLetter) disposition = "dead_letter";
  else if (requeued || parked) disposition = "requeue";
  else if (lifecycleTerminal) disposition = lifecycleTerminal;
  else if (publicationCompletion?.kind === "superseded") {
    disposition =
      publicationCompletion.reasonCode === "remote_closed" ? "target_closed" : "superseded";
  } else if (publicationCompletion?.kind === "permanent_failure") disposition = "failure";
  else if (
    publicationCompletion?.kind === "deferred" &&
    publicationCompletion.reasonCode === "close_coverage_deferred" &&
    projection?.routerReceipt?.outcome === "durable"
  ) {
    disposition = "review_completed_routed";
  } else if (
    publicationCompletion?.kind === "retryable_failure" ||
    publicationCompletion?.kind === "refresh_required" ||
    publicationCompletion?.kind === "deferred"
  ) {
    disposition = "requeue";
  } else {
    disposition = outcome === "failure" || outcome === "cancelled" ? "failure" : null;
  }
  return completionTerminalDisposition(projection, disposition);
}

function completionTerminalDisposition(
  projection: ExactReviewLifecycleProjection | null,
  requested: LifecycleTerminalDisposition | null,
): LifecycleTerminalDisposition | null {
  const committed = projection?.terminalDisposition?.kind;
  // Completion observes an existing final outcome; only requeue can transition it.
  return committed && committed !== "requeue" && requested !== "requeue"
    ? committed
    : (requested ?? committed ?? null);
}

function finishExactReviewPublicationQueueItem({
  state,
  item,
  now,
  completion,
  ownedRevision,
  requestedRetryAt = 0,
  requeueLatest = false,
  deadLetterCapacityAvailable,
  env,
}: {
  state: ExactReviewQueueState;
  item: ExactReviewQueueItem;
  now: number;
  completion: ExactReviewPublicationCompletion;
  ownedRevision?: number;
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
  const completionRevision = ownedRevision ?? Number(item.leaseRevision || 0);
  const hasNewerRevision = item.revision > completionRevision;
  if (hasNewerRevision || requeueLatest) {
    // Batch membership is stored separately from the queue lease fields. Reset
    // this item directly from the explicit owned revision instead of asking the
    // generic lease finalizer to infer ownership from item.leaseRevision.
    clearExactReviewLease(item);
    item.state = "pending";
    item.parkedReason = undefined;
    item.attempts = 0;
    item.publicationFailureAttempts = 0;
    item.firstFailureAt = undefined;
    item.lastFailureReason = undefined;
    item.nextAttemptAt = Math.max(exactReviewQueueEnqueueAttemptAt(state, now), requestedRetryAt);
    item.backoffReason =
      item.nextAttemptAt > now
        ? requestedRetryAt >= item.nextAttemptAt
          ? "publication_retry"
          : "dispatcher_backoff"
        : undefined;
    item.parkedRecoveryAttempts = 0;
    item.updatedAt = now;
    return {
      requeued: true,
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
    delete state.items[item.key];
    return {
      requeued: false,
      retried: false,
      refreshed: false,
      parked: false,
    };
  }

  if (
    completion.kind === "retryable_failure" &&
    (completion.reasonCode === "github_rate_limit" ||
      completion.reasonCode === "github_transient") &&
    completion.attempted === false
  ) {
    clearExactReviewLease(item);
    item.state = "pending";
    item.parkedReason = undefined;
    item.nextAttemptAt = Math.max(
      exactReviewQueueEnqueueAttemptAt(state, now),
      requestedRetryAt + exactReviewCredentialRecoveryJitterMs(item.key),
    );
    item.backoffReason = "publication_retry";
    item.lastFailureReason = completion.reasonCode;
    item.updatedAt = now;
    return {
      requeued: true,
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
      completionRevision,
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
    item.backoffReason = undefined;
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
  item.backoffReason =
    exactReviewQueueEnqueueAttemptAt(state, now) >= item.nextAttemptAt
      ? "dispatcher_backoff"
      : "publication_retry";
  item.updatedAt = now;
  return { requeued: true, retried: true, refreshed: false, parked: false };
}

function reconciledPublicationTransitionFacts(
  facts: ExactReviewPublicationTransitionFact[],
  expected: Record<
    "published" | "superseded" | "semantic_deduped" | "retried" | "dead_lettered" | "refreshed",
    number
  >,
): ExactReviewPublicationTransitionFact[] {
  const reconciled = facts.filter((fact) => Number.isSafeInteger(fact.count) && fact.count > 0);
  for (const [transition, expectedCount] of Object.entries(expected)) {
    const attributed = reconciled
      .filter((fact) => fact.transition === transition)
      .reduce((total, fact) => total + fact.count, 0);
    const missing = Math.max(0, Number(expectedCount) - attributed);
    if (!missing) continue;
    if (transition === "semantic_deduped") {
      reconciled.push({
        transition,
        stage: "publication_apply",
        completionKind: "none",
        reasonCode: "semantic_duplicate",
        revisionRelation: "semantic_duplicate",
        poolClass: "not_applicable",
        recoveryCause: "semantic_deduplication",
        backoffReason: "none",
        attemptBucket: "0",
        count: missing,
      });
      continue;
    }
    reconciled.push({
      transition: transition as ExactReviewPublicationTransitionFact["transition"],
      stage: "unknown",
      completionKind: "none",
      reasonCode: "unattributed",
      revisionRelation: "unknown",
      poolClass: "unknown",
      recoveryCause: "unattributed",
      backoffReason: "unknown",
      attemptBucket: "unknown",
      count: missing,
    });
  }
  return reconciled;
}

function exactReviewPublicationTransitionFact({
  completion,
  result,
  itemRevision,
  ownedRevision,
  requeueLatest,
  defaultPoolClass,
  backoffReason,
  attempt,
}: {
  completion: ExactReviewPublicationCompletion;
  result: {
    requeued: boolean;
    retried: boolean;
    refreshed: boolean;
    parked: boolean;
    deadLetter?: ExactReviewDeadLetterInsert;
  };
  itemRevision: number;
  ownedRevision: number;
  requeueLatest: boolean;
  defaultPoolClass: "repository_actions" | "target_app";
  backoffReason?: ExactReviewBackoffReason;
  attempt: number;
}): ExactReviewPublicationTransitionFact {
  const revisionRelation =
    itemRevision > ownedRevision || requeueLatest
      ? "newer_local_revision"
      : completion.reasonCode === "remote_newer_tuple"
        ? "newer_remote_revision"
        : "same_revision";
  const transition = result.deadLetter
    ? "dead_lettered"
    : result.retried
      ? "retried"
      : result.refreshed
        ? "refreshed"
        : result.requeued || result.parked
          ? "backoff"
          : completion.kind === "superseded"
            ? "superseded"
            : completion.kind === "deferred"
              ? "deferred"
              : "published";
  return {
    transition,
    stage: exactReviewPublicationCauseStage(completion.reasonCode),
    completionKind: completion.kind,
    reasonCode: completion.reasonCode,
    revisionRelation,
    poolClass: completion.poolClass || defaultPoolClass,
    recoveryCause: exactReviewPublicationRecoveryCause(completion, result, revisionRelation),
    backoffReason: backoffReason || "none",
    attemptBucket: exactReviewPublicationAttemptBucket(attempt),
    count: 1,
  };
}

function exactReviewPublicationCauseStage(
  reasonCode: ExactReviewPublicationReasonCode,
): ExactReviewPublicationTransitionFact["stage"] {
  if (
    [
      "artifact_unavailable",
      "artifact_expired",
      "invalid_artifact",
      "missing_record_tuple",
      "tuple_protocol_invalid",
    ].includes(reasonCode)
  ) {
    return "publication_prepare";
  }
  if (reasonCode === "state_contention") return "state_commit";
  if (reasonCode === "workflow_cancelled") return "workflow";
  if (reasonCode === "close_coverage_deferred") return "publication_router";
  return "publication_apply";
}

function exactReviewPublicationRecoveryCause(
  completion: ExactReviewPublicationCompletion,
  result: { deadLetter?: ExactReviewDeadLetterInsert },
  revisionRelation: ExactReviewPublicationTransitionFact["revisionRelation"],
): ExactReviewPublicationTransitionFact["recoveryCause"] {
  if (result.deadLetter) return "retry_budget_exhausted";
  if (revisionRelation === "newer_local_revision") return "newer_revision";
  if (revisionRelation === "newer_remote_revision") return "remote_revision";
  if (completion.reasonCode === "github_rate_limit" && completion.attempted === false) {
    return "credential_circuit";
  }
  if (["github_rate_limit", "github_transient"].includes(completion.reasonCode)) {
    return "transient_retry";
  }
  if (completion.reasonCode === "state_contention") return "state_retry";
  if (completion.reasonCode === "review_lease_active") return "lease_retry";
  if (completion.reasonCode === "workflow_cancelled") return "workflow_retry";
  if (["artifact_unavailable", "artifact_expired"].includes(completion.reasonCode)) {
    return "artifact_refresh";
  }
  if (["close_coverage_retry", "close_coverage_deferred"].includes(completion.reasonCode)) {
    return "coverage_retry";
  }
  if (
    [
      "invalid_artifact",
      "missing_record_tuple",
      "tuple_protocol_invalid",
      "policy_invariant",
    ].includes(completion.reasonCode)
  ) {
    return "validation_failure";
  }
  return completion.reasonCode === "unknown_failure" ? "unattributed" : "none";
}

function exactReviewPublicationAttemptBucket(
  attempt: number,
): ExactReviewPublicationTransitionFact["attemptBucket"] {
  if (!Number.isSafeInteger(attempt) || attempt < 0) return "unknown";
  if (attempt <= 2) return String(attempt) as "0" | "1" | "2";
  if (attempt <= 5) return "3_5";
  if (attempt <= 13) return "6_13";
  return "14_plus";
}

function exactReviewCredentialRecoveryJitterMs(itemKey: string): number {
  let hash = 2166136261;
  for (let index = 0; index < itemKey.length; index += 1) {
    hash ^= itemKey.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return 1_000 + (Math.abs(hash >>> 0) % 29_001);
}

function exactReviewDeadLetterId(item: ExactReviewQueueItem, ownedRevision?: number) {
  return `${item.key}@revision:${ownedRevision || item.leaseRevision || item.revision}`;
}

function exactReviewDeadLetterInsert(
  item: ExactReviewQueueItem,
  reasonCode: ExactReviewPublicationReasonCode,
  attempts: number,
  firstFailedAt: number,
  lastFailedAt: number,
  errorFingerprint?: string,
  ownedRevision?: number,
): ExactReviewDeadLetterInsert {
  const publication = item.decision.publication;
  if (!publication) throw new Error(`publication metadata missing for ${item.key}`);
  return {
    id: exactReviewDeadLetterId(item, ownedRevision),
    itemKey: item.key,
    revision: Number(ownedRevision || item.leaseRevision || item.revision),
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

function exactReviewSavedDirectLifecycle(item: ExactReviewQueueItem) {
  const decision = item.leaseDecision;
  const lifecycle = decision?.publication?.directLifecycle;
  if (decision?.sourceAction !== EXACT_REVIEW_ARTIFACT_PUBLISH_SOURCE_ACTION || !lifecycle) {
    return undefined;
  }
  return {
    canonicalTargetKey: `${decision.targetRepo}#${decision.itemNumber}`,
    owedRequeue:
      lifecycle.plan.kind === "requeue" &&
      (lifecycle.receiptOutcome === "accepted" || lifecycle.receiptOutcome === "deduped"),
  };
}

function exactReviewRetryPolicyEpoch(env: unknown) {
  const configured = String(
    objectValue(env).EXACT_REVIEW_RETRY_POLICY_EPOCH || DEFAULT_EXACT_REVIEW_RETRY_POLICY_EPOCH,
  ).trim();
  return /^[A-Za-z0-9._-]{1,64}$/.test(configured)
    ? configured
    : DEFAULT_EXACT_REVIEW_RETRY_POLICY_EPOCH;
}

function exactReviewIssueSourceVersionIsOlder(
  current: ExactReviewQueueItem,
  incoming: ExactReviewDecision,
) {
  if (current.decision.itemKind !== "issue" || incoming.itemKind !== "issue") return false;
  const currentUpdatedAt = Date.parse(String(current.decision.sourceUpdatedAt || ""));
  const incomingUpdatedAt = Date.parse(String(incoming.sourceUpdatedAt || ""));
  if (!Number.isFinite(currentUpdatedAt) || !Number.isFinite(incomingUpdatedAt)) return false;
  if (incomingUpdatedAt !== currentUpdatedAt) return incomingUpdatedAt < currentUpdatedAt;
  if (current.state !== "parked" || current.parkedReason !== "review_retry_exhausted") {
    return false;
  }
  const currentContentRevision = String(current.decision.sourceContentRevision || "").toLowerCase();
  // Same-second issue edits have no trustworthy ordering signal. Keep the
  // durable exhausted row; the five-minute signed parked-review reconciler
  // compares it with live GitHub content and recovers only the authoritative
  // digest when the live source actually differs.
  return /^[0-9a-f]{64}$/.test(currentContentRevision);
}

function exactReviewInputIdentityChanged(
  priorDecision: ExactReviewDecision,
  nextDecision: ExactReviewDecision,
) {
  const commandIdentity = (decision: ExactReviewDecision) =>
    exactReviewDecisionHasCommandContext(decision)
      ? stableJson({
          commandStatusMarker: decision.commandStatusMarker ?? null,
          statusCommentId: decision.statusCommentId ?? null,
          additionalPrompt: decision.additionalPrompt ?? null,
          sourceCommentId: decision.sourceCommentId ?? null,
          sourceCommentUpdatedAt: decision.sourceCommentUpdatedAt ?? null,
          commandBodyDigest: decision.commandBodyDigest ?? null,
          commandOrigin: decision.commandOrigin ?? null,
        })
      : null;
  return (
    exactReviewFailureSourceFingerprint(priorDecision) !==
      exactReviewFailureSourceFingerprint(nextDecision) ||
    (priorDecision.additionalPrompt ?? null) !== (nextDecision.additionalPrompt ?? null) ||
    commandIdentity(priorDecision) !== commandIdentity(nextDecision)
  );
}

function exactReviewRetryIdentityChanged(
  item: ExactReviewQueueItem,
  priorDecision: ExactReviewDecision,
  nextDecision: ExactReviewDecision,
  env: unknown,
) {
  const activeEpoch = exactReviewRetryPolicyEpoch(env);
  const priorEpoch = item.reviewRetryPolicyEpoch || DEFAULT_EXACT_REVIEW_RETRY_POLICY_EPOCH;
  return priorEpoch !== activeEpoch || exactReviewInputIdentityChanged(priorDecision, nextDecision);
}

function finishExactReviewQueueItem(
  state: ExactReviewQueueState,
  item: ExactReviewQueueItem,
  now: number,
  outcome: ExactReviewCompletionOutcome,
  requestedRetryAt = 0,
  requeueLatest = false,
  retryKind?: ExactReviewRetryKind,
  reviewFailureReason?: ExactReviewFailureReason,
  random: () => number = Math.random,
  env: unknown = {},
) {
  const retryingFailure = outcome !== "success" && reviewFailureReason === undefined;
  const hasNewerRevision = item.revision > Number(item.leaseRevision || 0);
  const activeRetryPolicyEpoch = exactReviewRetryPolicyEpoch(env);
  const retryPolicyChanged =
    (item.reviewRetryPolicyEpoch || DEFAULT_EXACT_REVIEW_RETRY_POLICY_EPOCH) !==
    activeRetryPolicyEpoch;
  const sourceIdentityChanged =
    hasNewerRevision &&
    exactReviewInputIdentityChanged(item.leaseDecision ?? item.decision, item.decision);
  const retryIdentityChanged = retryPolicyChanged || sourceIdentityChanged;
  const hasNewerReviewIdentity = hasNewerRevision && sourceIdentityChanged;
  if (
    !exactReviewQueueIsPublication(item) &&
    retryingFailure &&
    retryKind === undefined &&
    !retryIdentityChanged &&
    !requeueLatest
  ) {
    item.reviewRecoveryReason = outcome === "cancelled" ? "workflow_cancelled" : "workflow_failed";
    item.reviewRecoveryAt = now;
  }
  const typedDeferral = retryKind !== undefined && !sourceIdentityChanged && !requeueLatest;
  // A regular queue item may back off and retry after a failed lease. Failed
  // sweep shards already consumed their one recovery attempt before reaching
  // the queue, so only a newer source revision may supersede that recovery.
  const oneShotRecovery =
    item.leaseDecision?.sourceAction === FAILED_REVIEW_SHARD_RECOVERY_SOURCE_ACTION;
  const requeued =
    typedDeferral ||
    (!oneShotRecovery && retryingFailure) ||
    hasNewerReviewIdentity ||
    (retryingFailure && retryPolicyChanged) ||
    requeueLatest;
  if (!requeued) {
    delete state.items[item.key];
    return { requeued: false, parked: false };
  }
  clearExactReviewLease(item);
  item.state = "pending";
  if (typedDeferral) {
    const dispatcherAttemptAt = exactReviewQueueEnqueueAttemptAt(state, now);
    const deferredAttemptAt = hasNewerRevision
      ? now
      : retryKind === "throttle"
        ? now + exactReviewJitteredDelayMs(Math.max(0, requestedRetryAt - now), random)
        : requestedRetryAt;
    item.nextAttemptAt = Math.max(dispatcherAttemptAt, deferredAttemptAt);
    item.backoffReason =
      dispatcherAttemptAt >= item.nextAttemptAt
        ? "dispatcher_backoff"
        : retryKind === "coordination"
          ? "coordination_retry"
          : "throttle_retry";
    item.parkedReason = undefined;
  } else if (retryingFailure && !retryIdentityChanged) {
    item.attempts += 1;
    if (!exactReviewQueueIsPublication(item)) {
      const failureAttempts = Number(item.reviewFailureAttempts || 0) + 1;
      item.reviewFailureAttempts = failureAttempts;
      item.reviewRetryPolicyEpoch = activeRetryPolicyEpoch;
      if (failureAttempts >= EXACT_REVIEW_RETRY_LIMIT) {
        parkRecoverableExactReviewItem(item, "review_retry_exhausted", now, random);
        return { requeued: false, parked: true };
      }
    }
    item.nextAttemptAt = Math.max(
      exactReviewQueueEnqueueAttemptAt(state, now),
      now + exactReviewRetryDelayMs(item.attempts),
      hasNewerReviewIdentity ? 0 : requestedRetryAt,
    );
    item.backoffReason =
      exactReviewQueueEnqueueAttemptAt(state, now) >= item.nextAttemptAt
        ? "dispatcher_backoff"
        : "review_retry";
  } else {
    Object.assign(item, exactReviewQueueEnqueueAttempt(state, now));
    item.attempts = 0;
    item.reviewFailureAttempts = 0;
    item.reviewRetryPolicyEpoch = activeRetryPolicyEpoch;
    item.parkedReason = undefined;
    item.parkedRecoveryAttempts = 0;
    clearExactReviewReviewRecovery(item);
  }
  item.updatedAt = now;
  return { requeued: true, parked: false };
}

function exactReviewCompletionRetryAt(value, now: number): number | null {
  if (value === undefined || value === null || value === "") return null;
  const retryAt = Date.parse(String(value));
  if (!Number.isFinite(retryAt)) return null;
  if (retryAt > now + EXACT_REVIEW_COMPLETION_RETRY_MAX_MS) return null;
  return Math.max(now, retryAt);
}

function exactReviewRetryKind(value): ExactReviewRetryKind | null {
  const normalized = String(value || "");
  return normalized === "coordination" || normalized === "throttle" ? normalized : null;
}

function clearExactReviewLease(item: ExactReviewQueueItem) {
  item.leaseId = undefined;
  item.leaseRevision = undefined;
  item.leaseDecision = undefined;
  item.leaseExpiresAt = undefined;
  item.leaseHeartbeatAt = undefined;
  item.leasePhase = undefined;
  item.claimedRunId = undefined;
  item.claimedRunAttempt = undefined;
  item.claimGeneration = undefined;
  item.claimProtocolVersion = undefined;
  item.dispatchedAt = undefined;
  item.claimedAt = undefined;
}

function clearExactReviewDispatchFailure(item: ExactReviewQueueItem) {
  item.dispatchFailureStatus = undefined;
  item.dispatchFailureClass = undefined;
  item.dispatchFailureAt = undefined;
  item.dispatchFailureFingerprint = undefined;
  item.dispatchFailureDetail = undefined;
}

function clearExactReviewReviewRecovery(item: ExactReviewQueueItem) {
  item.reviewRecoveryReason = undefined;
  item.reviewRecoveryAt = undefined;
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
  env: unknown = {},
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
        env,
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
  env: unknown = {},
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
  const retryIdentityChanged =
    !exactReviewQueueIsPublication(item) &&
    exactReviewRetryIdentityChanged(item, item.leaseDecision ?? item.decision, item.decision, env);
  const hasNewerWorkIdentity = exactReviewQueueIsPublication(item)
    ? hasNewerRevision
    : retryIdentityChanged;
  if (oneShotRecovery && !hasNewerWorkIdentity) {
    delete state.items[key];
    return true;
  }
  const expiredState = item.state;
  clearExactReviewLease(item);
  item.state = "pending";
  item.nextAttemptAt = now;
  item.backoffReason = undefined;
  if (hasNewerWorkIdentity) {
    item.attempts = 0;
    item.publicationFailureAttempts = 0;
    item.reviewFailureAttempts = 0;
    item.reviewRetryPolicyEpoch = exactReviewRetryPolicyEpoch(env);
    item.firstFailureAt = undefined;
    item.lastFailureReason = undefined;
    clearExactReviewReviewRecovery(item);
  } else if (!exactReviewQueueIsPublication(item)) {
    item.reviewRecoveryReason =
      expiredState === "dispatching" ? "claim_timeout" : "execution_timeout";
    item.reviewRecoveryAt = now;
  }
  item.updatedAt = now;
  return true;
}

function parkRecoverableExactReviewItem(
  item: ExactReviewQueueItem,
  reason: Extract<ExactReviewParkedReason, "dispatch_rejected" | "review_retry_exhausted">,
  now: number,
  random: () => number,
) {
  item.state = "parked";
  item.parkedReason = reason;
  item.backoffReason = undefined;
  item.updatedAt = now;
  const delay = exactReviewParkedRecoveryDelayMs(item);
  item.parkedRecoveryAt =
    delay === null ? undefined : now + exactReviewJitteredDelayMs(delay, random);
}

function recoverParkedExactReviewItems(
  state: ExactReviewQueueState,
  now: number,
  env: unknown = {},
) {
  let recovered = 0;
  for (const item of Object.values(state.items)) {
    const retryAt = exactReviewParkedRecoveryAt(item);
    if (retryAt === null || retryAt > now) continue;
    const activeRetryPolicyEpoch = exactReviewRetryPolicyEpoch(env);
    const retryPolicyChanged =
      (item.reviewRetryPolicyEpoch || DEFAULT_EXACT_REVIEW_RETRY_POLICY_EPOCH) !==
      activeRetryPolicyEpoch;
    item.state = "pending";
    item.parkedReason = undefined;
    item.parkedRecoveryAt = undefined;
    item.parkedRecoveryAttempts = retryPolicyChanged
      ? 0
      : exactReviewParkedRecoveryAttempts(item.parkedRecoveryAttempts) + 1;
    item.nextAttemptAt = now;
    item.backoffReason = undefined;
    item.attempts = 0;
    item.reviewFailureAttempts = 0;
    item.reviewRetryPolicyEpoch = activeRetryPolicyEpoch;
    item.updatedAt = now;
    clearExactReviewDispatchFailure(item);
    clearExactReviewReviewRecovery(item);
    recovered += 1;
  }
  return recovered;
}

function exactReviewDueParkedTerminalItem(state: ExactReviewQueueState, now: number) {
  if (exactReviewParkedTerminalGlobalCheckAt(state) > now) return undefined;
  return Object.values(state.items)
    .filter((item) => {
      const checkAt = exactReviewParkedTerminalCheckAt(item);
      return checkAt !== null && checkAt <= now;
    })
    .sort(
      (left, right) =>
        Number(left.parkedTerminalCheckedAt || 0) - Number(right.parkedTerminalCheckedAt || 0) ||
        left.createdAt - right.createdAt ||
        left.key.localeCompare(right.key),
    )[0];
}

export function exactReviewJitteredDelayMs(delayMs: number, random: () => number = Math.random) {
  const delay = Math.max(0, delayMs);
  const sample = random();
  const unit = Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 0.5;
  const minimum = Math.ceil(delay * 0.75);
  const maximum = Math.floor(delay * 1.5);
  return Math.max(minimum, Math.min(maximum, Math.round(delay * (0.75 + 0.75 * unit))));
}

function expireExactReviewPublicationItems(state: ExactReviewQueueState, now: number, env) {
  let changed = false;
  for (const item of Object.values(state.items)) {
    const publication = item.decision.publication;
    if (
      item.state !== "pending" ||
      item.terminalFinalization ||
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
      current.parkedRecoveryAttempts = 0;
    } else {
      return;
    }
    current.revision += 1;
    current.updatedAt = now;
    Object.assign(
      current,
      exactReviewQueueDebouncedAttempt(state, current.decision, now, current.createdAt, env),
    );
    current.attempts = 0;
    current.publicationFailureAttempts = 0;
    current.reviewFailureAttempts = 0;
    current.reviewRetryPolicyEpoch = exactReviewRetryPolicyEpoch(env);
    current.firstFailureAt = undefined;
    current.lastFailureReason = undefined;
    clearExactReviewReviewRecovery(current);
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
    ...exactReviewQueueDebouncedAttempt(state, decision, now, now, env),
    attempts: 0,
    reviewRetryPolicyEpoch: exactReviewRetryPolicyEpoch(env),
  };
}

function exactReviewQueueEnqueueAttempt(state: ExactReviewQueueState, now: number) {
  const nextAttemptAt = exactReviewQueueEnqueueAttemptAt(state, now);
  return {
    nextAttemptAt,
    backoffReason:
      nextAttemptAt > now ? ("dispatcher_backoff" as ExactReviewBackoffReason) : undefined,
  };
}

function exactReviewQueueEnqueueAttemptAt(state: ExactReviewQueueState, now: number) {
  const retryAt = Number(state.dispatcher?.retryAt || 0);
  return (state.dispatcher?.state === "paused" || state.dispatcher?.state === "blocked") &&
    retryAt > now
    ? retryAt
    : now;
}

function exactReviewQueueDebouncedAttempt(
  state: ExactReviewQueueState,
  decision: ExactReviewDecision,
  now: number,
  firstEnqueuedAt: number,
  env,
  isFirstEvent = false,
) {
  const baseAttemptAt = exactReviewQueueEnqueueAttemptAt(state, now);
  if (isImmediateExactReviewDecision(decision, isFirstEvent)) {
    return exactReviewQueueEnqueueAttempt(state, now);
  }
  const debounceAt = Math.min(
    now + exactReviewDispatchDebounceMs(env),
    firstEnqueuedAt + exactReviewDispatchDebounceMaxMs(env),
  );
  const nextAttemptAt = Math.max(baseAttemptAt, debounceAt);
  return {
    nextAttemptAt,
    backoffReason:
      nextAttemptAt > now
        ? ((baseAttemptAt >= debounceAt
            ? "dispatcher_backoff"
            : "dispatch_debounce") as ExactReviewBackoffReason)
        : undefined,
  };
}

function exactReviewQueuePendingReviewCount(state: ExactReviewQueueState) {
  return Object.values(state.items).filter(
    (item) => item.state === "pending" && !exactReviewQueueIsPublication(item),
  ).length;
}

function exactReviewMetricTotal(value: unknown) {
  const total = Number(value);
  return Number.isSafeInteger(total) && total >= 0 ? total : 0;
}

function exactReviewMetricDelta(value: unknown) {
  const delta = Number(value || 0);
  return Number.isSafeInteger(delta) && delta > 0 ? delta : 0;
}

type ExactReviewLegacyPublicationAuthority = {
  hasBaseAuthority: boolean;
  hasActiveOwner: boolean;
  hasVersionedPublication: boolean;
  newestLegacyPublication: ExactReviewPublication | null;
};

function exactReviewLegacyPublicationAuthorityIndex(
  state: ExactReviewQueueState,
  activeBatchItemKeys: Set<string>,
) {
  const byTarget = new Map<string, ExactReviewLegacyPublicationAuthority>();
  const authorityFor = (targetKey: string) => {
    const existing = byTarget.get(targetKey);
    if (existing) return existing;
    const authority: ExactReviewLegacyPublicationAuthority = {
      hasBaseAuthority: false,
      hasActiveOwner: false,
      hasVersionedPublication: false,
      newestLegacyPublication: null,
    };
    byTarget.set(targetKey, authority);
    return authority;
  };

  for (const item of Object.values(state.items)) {
    if (item.terminalFinalization) continue;
    const publication = item.decision.publication;
    const targetKey = (publication?.itemKey || item.key).toLowerCase();
    const authority = authorityFor(targetKey);
    if (!publication) {
      authority.hasBaseAuthority = true;
      continue;
    }
    if (
      activeBatchItemKeys.has(item.key) ||
      item.state === "dispatching" ||
      item.state === "leased"
    ) {
      authority.hasActiveOwner = true;
    }
    if (publication.protocolVersion === 2) {
      authority.hasVersionedPublication = true;
      continue;
    }
    if (
      !authority.newestLegacyPublication ||
      exactReviewPublicationProducerIsNewer(publication, authority.newestLegacyPublication)
    ) {
      authority.newestLegacyPublication = publication;
    }
  }
  return byTarget;
}

function exactReviewLegacyTerminalPublicationCandidate(
  item: ExactReviewQueueItem,
  authorityByTarget: Map<string, ExactReviewLegacyPublicationAuthority>,
) {
  // Protocol-v1 rows have no durable terminal receipt. Reconcile only the
  // ordinary delivery path after an explicit target-terminal read; command
  // status rows keep their acknowledgement/completion workflow intact.
  const publication = item.decision.publication;
  if (
    !publication ||
    publication.protocolVersion !== 1 ||
    !publication.liveProceeded ||
    !exactReviewQueueIsPublication(item) ||
    exactReviewQueueHasCommandContext(item) ||
    (item.state !== "pending" && item.state !== "parked")
  ) {
    return false;
  }

  const authority = authorityByTarget.get(publication.itemKey.toLowerCase());
  const newerLegacyPublication =
    authority?.newestLegacyPublication &&
    exactReviewPublicationProducerIsNewer(authority.newestLegacyPublication, publication);
  return Boolean(
    authority &&
    !authority.hasBaseAuthority &&
    !authority.hasActiveOwner &&
    !authority.hasVersionedPublication &&
    !newerLegacyPublication,
  );
}

type ExactReviewLegacyStateBatchPublicationAuthority = {
  hasBaseAuthority: boolean;
  hasActiveOwner: boolean;
  newestVersionedPublication: ExactReviewPublication | null;
};

function exactReviewLegacyStateBatchPublicationAuthorityIndex(
  state: ExactReviewQueueState,
  activeBatchItemKeys: Set<string>,
) {
  const byTarget = new Map<string, ExactReviewLegacyStateBatchPublicationAuthority>();
  const authorityFor = (targetKey: string) => {
    const existing = byTarget.get(targetKey);
    if (existing) return existing;
    const authority: ExactReviewLegacyStateBatchPublicationAuthority = {
      hasBaseAuthority: false,
      hasActiveOwner: false,
      newestVersionedPublication: null,
    };
    byTarget.set(targetKey, authority);
    return authority;
  };

  for (const item of Object.values(state.items)) {
    if (item.terminalFinalization) continue;
    const publication = item.decision.publication;
    const targetKey = (publication?.itemKey || item.key).toLowerCase();
    const authority = authorityFor(targetKey);
    if (!publication) {
      authority.hasBaseAuthority = true;
      continue;
    }
    if (
      activeBatchItemKeys.has(item.key) ||
      item.state === "dispatching" ||
      item.state === "leased"
    ) {
      authority.hasActiveOwner = true;
    }
    if (
      publication.protocolVersion === 2 &&
      (!authority.newestVersionedPublication ||
        exactReviewPublicationProducerIsNewer(publication, authority.newestVersionedPublication))
    ) {
      authority.newestVersionedPublication = publication;
    }
  }
  return byTarget;
}

function exactReviewLegacyStateBatchTerminalPublicationCandidate(
  item: ExactReviewQueueItem,
  authorityByTarget: Map<string, ExactReviewLegacyStateBatchPublicationAuthority>,
  newestRevision: number,
) {
  const publication = item.decision.publication;
  const revision = exactReviewPublicationRevision(item.decision);
  if (
    !publication ||
    publication.protocolVersion !== 2 ||
    item.key === publication.itemKey ||
    !publication.liveProceeded ||
    !revision ||
    !exactReviewQueueIsPublication(item) ||
    exactReviewQueueHasCommandContext(item) ||
    (item.state !== "pending" && item.state !== "parked")
  ) {
    return false;
  }
  const authority = authorityByTarget.get(revision.targetKey);
  const newerPublication =
    authority?.newestVersionedPublication &&
    exactReviewPublicationProducerIsNewer(authority.newestVersionedPublication, publication);
  return Boolean(
    authority &&
    !authority.hasBaseAuthority &&
    !authority.hasActiveOwner &&
    !newerPublication &&
    revision.sourceRevision >= newestRevision,
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
  const base = exactReviewPublicationBase(env, maximum);
  const rawCeiling = Number(control.capacityCeiling);
  const rawDemandCapacity = Number(control.demandCapacity);
  const rawCooldown = Number(control.cooldownUntil);
  const rawRecoverySuccesses = Number(control.recoverySuccesses);
  const rawLastFailureAt = Number(control.lastFailureAt);
  const lastFailureKind = exactReviewPublicationFailureKind(control.lastFailureKind);
  const feedbackReceiptCutoff = Date.now() - EXACT_REVIEW_GITHUB_TELEMETRY_RECEIPT_RETENTION_MS;
  const githubFeedbackReceipts = Object.fromEntries(
    Object.entries(objectValue(control.githubFeedbackReceipts))
      .filter(
        ([receipt, recordedAt]) =>
          /^[0-9a-f]{64}$/i.test(receipt) &&
          Number.isFinite(Number(recordedAt)) &&
          Number(recordedAt) >= feedbackReceiptCutoff,
      )
      .map(([receipt, recordedAt]) => [receipt, Number(recordedAt)] as const),
  );
  // A fixed higher-capacity policy persists both values above a later policy's
  // maximum (for example the temporary 50/50/50 override). On downgrade, the
  // ceiling may retain the new maximum, but demand must restart at the new base
  // instead of turning the old fixed target into a permanent maximum target.
  const fixedPolicyDowngrade =
    Number.isSafeInteger(rawCeiling) &&
    Number.isSafeInteger(rawDemandCapacity) &&
    rawCeiling > maximum &&
    rawDemandCapacity > maximum;
  return {
    capacityCeiling: Number.isSafeInteger(rawCeiling)
      ? Math.max(minimum, Math.min(maximum, rawCeiling))
      : maximum,
    demandCapacity: fixedPolicyDowngrade
      ? base
      : Number.isSafeInteger(rawDemandCapacity)
        ? Math.max(minimum, Math.min(maximum, rawDemandCapacity))
        : base,
    cooldownUntil: Number.isSafeInteger(rawCooldown) && rawCooldown > 0 ? rawCooldown : 0,
    recoverySuccesses:
      Number.isSafeInteger(rawRecoverySuccesses) && rawRecoverySuccesses > 0
        ? rawRecoverySuccesses
        : 0,
    demandSamples: Math.max(0, Number(control.demandSamples) || 0),
    demandTier: Math.max(0, Number(control.demandTier) || 0),
    lastDemandSampleAt: Math.max(0, Number(control.lastDemandSampleAt) || 0),
    lastScaleAt: Math.max(0, Number(control.lastScaleAt) || 0),
    githubFeedbackReceipts,
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

export function exactReviewPublicationCapacityForState(
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
  const workerBudget = Math.max(
    1,
    numberFrom(env.EXACT_REVIEW_ACTIONS_BUDGET, DEFAULT_EXACT_REVIEW_ACTIONS_BUDGET),
  );
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

function exactReviewDirectPublicationEnabled(env) {
  return String(env.EXACT_REVIEW_DIRECT_PUBLICATION_ENABLED ?? "1").trim() === "1";
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

function exactReviewPublicationBatchMaxConcurrent(env) {
  return Math.max(1, Math.min(8, numberFrom(env.EXACT_REVIEW_PUBLICATION_BATCH_MAX_CONCURRENT, 1)));
}

function exactReviewPublicationFreshLaneMaxItems(env) {
  if (String(env.EXACT_REVIEW_PUBLICATION_FRESH_LANE_ENABLED || "").trim() !== "1") return 0;
  const batchSize = exactReviewPublicationBatchSize(env);
  if (batchSize <= 1) return 0;
  return Math.max(
    1,
    Math.min(
      batchSize - 1,
      numberFrom(
        env.EXACT_REVIEW_PUBLICATION_FRESH_LANE_MAX_ITEMS,
        DEFAULT_EXACT_REVIEW_PUBLICATION_FRESH_LANE_MAX_ITEMS,
      ),
    ),
  );
}

function exactReviewPublicationFreshLaneMaxAgeMs(env) {
  return Math.max(
    60_000,
    Math.min(
      60 * 60_000,
      numberFrom(
        env.EXACT_REVIEW_PUBLICATION_FRESH_LANE_MAX_AGE_MS,
        DEFAULT_EXACT_REVIEW_PUBLICATION_FRESH_LANE_MAX_AGE_MS,
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
  activeBatchCount: number,
  freshItemKeys: ReadonlySet<string> = new Set(),
  supersededItemKeys: ReadonlySet<string> = new Set(),
) {
  if (
    !exactReviewPublicationBatchingEnabled(env) ||
    activeBatchCount >= exactReviewPublicationBatchMaxConcurrent(env)
  ) {
    return null;
  }
  const pending = exactReviewPrioritizePublicationItems(
    Object.values(state.items)
      .filter(
        (item) =>
          exactReviewQueueIsBatchablePublication(item) &&
          item.state === "pending" &&
          !item.terminalFinalization &&
          !ownedItemKeys.has(item.key) &&
          !supersededItemKeys.has(item.key) &&
          !exactReviewGithubCircuitBlocksItem(state, item, now),
      )
      .sort((left, right) => left.createdAt - right.createdAt || left.key.localeCompare(right.key)),
    freshItemKeys,
    exactReviewPublicationFreshLaneMaxItems(env),
  );
  const maxItems = exactReviewPublicationBatchSize(env);
  const waitMs = exactReviewPublicationBatchWaitMs(env);
  const nextEligibilityAt = pending.reduce(
    (earliest, item) =>
      item.nextAttemptAt > now ? Math.min(earliest, item.nextAttemptAt) : earliest,
    Number.POSITIVE_INFINITY,
  );
  const candidates = pending.filter((item) => item.nextAttemptAt <= now);
  const selection = exactReviewPublicationBatchSelection(
    candidates,
    freshItemKeys,
    maxItems,
    waitMs,
    now,
  );
  if (!selection) {
    return Number.isFinite(nextEligibilityAt)
      ? { candidateCount: 0, maxItems, dueAt: nextEligibilityAt, due: false }
      : null;
  }
  const fullAt = selection.candidates.length >= maxItems ? now : Number.POSITIVE_INFINITY;
  const ageAt = selection.oldestAt + waitMs;
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
    candidateCount: selection.candidates.length,
    maxItems,
    dueAt,
    due: dueAt <= now,
  };
}

function exactReviewPublicationBatchSelection(
  candidates: ExactReviewQueueItem[],
  freshItemKeys: ReadonlySet<string>,
  maxItems: number,
  waitMs: number,
  now: number,
) {
  const candidatesByOwner = new Map<string, ExactReviewQueueItem[]>();
  let oldest: ExactReviewQueueItem | undefined;
  let oldestAged: ExactReviewQueueItem | undefined;
  for (const item of candidates) {
    const owner = item.decision.targetRepo.split("/", 1)[0]?.toLowerCase();
    if (!owner) continue;
    const group = candidatesByOwner.get(owner) ?? [];
    group.push(item);
    candidatesByOwner.set(owner, group);
    if (
      !oldest ||
      item.createdAt < oldest.createdAt ||
      (item.createdAt === oldest.createdAt && item.key.localeCompare(oldest.key) < 0)
    ) {
      oldest = item;
    }
    if (
      item.createdAt + waitMs <= now &&
      (!oldestAged ||
        item.createdAt < oldestAged.createdAt ||
        (item.createdAt === oldestAged.createdAt && item.key.localeCompare(oldestAged.key) < 0))
    ) {
      oldestAged = item;
    }
  }
  const ownerFor = (item: ExactReviewQueueItem | undefined) =>
    item?.decision.targetRepo.split("/", 1)[0]?.toLowerCase();
  // Departure and claim must choose the same installation owner. Once an
  // owner's oldest work has waited a full batch window, cross-owner fresh/full
  // optimization yields to that owner; ordering within the owner stays intact.
  const selectedOwner =
    ownerFor(oldestAged) ??
    ownerFor(candidates.find((item) => freshItemKeys.has(item.key))) ??
    [...candidatesByOwner].find(([, group]) => group.length >= maxItems)?.[0] ??
    ownerFor(oldest);
  const selected = selectedOwner ? candidatesByOwner.get(selectedOwner) : undefined;
  if (!selected?.length) return null;
  return {
    candidates: selected,
    oldestAt: oldest!.createdAt,
  };
}

function exactReviewBatchDispatcherFields(dispatcher: ExactReviewQueueState["dispatcher"]) {
  return {
    ...(dispatcher?.githubCredentialCircuits
      ? { githubCredentialCircuits: dispatcher.githubCredentialCircuits }
      : {}),
    ...(dispatcher?.githubRequestMetrics
      ? { githubRequestMetrics: dispatcher.githubRequestMetrics }
      : {}),
    ...(dispatcher?.parkedTerminalCheckedAt
      ? { parkedTerminalCheckedAt: dispatcher.parkedTerminalCheckedAt }
      : {}),
    ...(dispatcher?.publicationBatchDispatchId
      ? { publicationBatchDispatchId: dispatcher.publicationBatchDispatchId }
      : {}),
    ...(dispatcher?.publicationBatchDispatchedAt
      ? { publicationBatchDispatchedAt: dispatcher.publicationBatchDispatchedAt }
      : {}),
    ...(dispatcher?.publicationBatchDispatchSucceeded !== undefined
      ? { publicationBatchDispatchSucceeded: dispatcher.publicationBatchDispatchSucceeded }
      : {}),
    ...(dispatcher?.publicationBatchDispatchPendingUntil
      ? { publicationBatchDispatchPendingUntil: dispatcher.publicationBatchDispatchPendingUntil }
      : {}),
    ...(dispatcher?.publicationBatchTerminalProbe
      ? { publicationBatchTerminalProbe: dispatcher.publicationBatchTerminalProbe }
      : {}),
  };
}

function exactReviewPublicationBatchCandidateProbe(
  candidates: ReadonlyArray<Pick<ExactReviewQueueItem, "key" | "revision">>,
) {
  return JSON.stringify(candidates.map((candidate) => [candidate.key, candidate.revision]));
}

function exactReviewPublicationBatchReservedProbe(
  state: ExactReviewQueueState,
  now: number,
  dispatchId: string | undefined,
): Set<string> | null {
  const dispatcher = state.dispatcher;
  if (
    !dispatchId ||
    dispatcher?.publicationBatchDispatchedAt === undefined ||
    dispatchId !== dispatcher.publicationBatchDispatchId ||
    Number(dispatcher.publicationBatchDispatchPendingUntil || 0) <= now
  )
    return null;
  try {
    const pairs: unknown = JSON.parse(dispatcher.publicationBatchTerminalProbe ?? "");
    if (!Array.isArray(pairs)) return null;
    const probed = new Set<string>();
    for (const pair of pairs) {
      if (!Array.isArray(pair) || pair.length !== 2) return null;
      const [key, revision] = pair;
      if (typeof key !== "string" || !key || !Number.isSafeInteger(revision) || revision <= 0)
        return null;
      probed.add(JSON.stringify(pair));
    }
    return probed;
  } catch {
    return null;
  }
}

function exactReviewHostedTargetAdmissionFreshMs(env) {
  return Math.max(0, numberFrom(env.EXACT_REVIEW_HOSTED_TARGET_ADMISSION_FRESH_MS, 60_000));
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
  // Keep a conservative floor above the one-minute worker heartbeat so scheduler
  // or network stalls cannot reclaim a healthy lease between beats.
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

function exactReviewScheduledDispositionFromJson(
  value: string,
): ExactReviewScheduledDisposition | null {
  try {
    const parsed: unknown = JSON.parse(value);
    const body = objectValue(parsed);
    let disposition: ExactReviewScheduledDisposition | null = null;
    if (
      body.ok === true &&
      body.queued === true &&
      typeof body.item_key === "string" &&
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*$/.test(body.item_key) &&
      Number.isSafeInteger(body.superseded_publications) &&
      Number(body.superseded_publications) >= 0
    ) {
      disposition = {
        ok: true,
        queued: true,
        item_key: body.item_key,
        superseded_publications: Number(body.superseded_publications),
      };
    } else if (
      body.ok === true &&
      body.deduped === true &&
      typeof body.item_key === "string" &&
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*$/.test(body.item_key) &&
      body.dedupe_scope === "scheduled_queue_item" &&
      body.dedupe_reason === "item_already_pending_or_active"
    ) {
      disposition = {
        ok: true,
        deduped: true,
        item_key: body.item_key,
        dedupe_scope: "scheduled_queue_item",
        dedupe_reason: "item_already_pending_or_active",
      };
    } else if (
      body.ok === true &&
      body.shed === true &&
      (body.reason === "backpressure" || body.reason === "scheduled_rate")
    ) {
      disposition = { ok: true, shed: true, reason: body.reason };
    }
    return disposition && stableJson(parsed) === stableJson(disposition) ? disposition : null;
  } catch {
    return null;
  }
}

function exactReviewScheduledFeedKey(lane: ExactReviewScheduledBucket) {
  return `${EXACT_REVIEW_SCHEDULED_FEED_KEY_PREFIX}:${lane}`;
}

function exactReviewScheduledRatePerHour(env, lane: ExactReviewScheduledBucket) {
  const total = Math.max(
    2,
    Math.min(
      2_000,
      Math.floor(
        numberFrom(
          env.EXACT_REVIEW_TARGET_RATE_PER_HOUR,
          DEFAULT_EXACT_REVIEW_TARGET_RATE_PER_HOUR,
        ),
      ),
    ),
  );
  if (lane === "global") return total;
  const hot = Math.max(1, Math.floor(total * 0.35));
  return lane === "hot_intake" ? hot : total - hot;
}

function exactReviewScheduledBurst(env, lane: ExactReviewScheduledBucket) {
  const total = Math.max(
    2,
    Math.min(
      exactReviewScheduledRatePerHour(env, "hot_intake") +
        exactReviewScheduledRatePerHour(env, "normal_backfill"),
      Math.floor(numberFrom(env.EXACT_REVIEW_TARGET_BURST, DEFAULT_EXACT_REVIEW_TARGET_BURST)),
    ),
  );
  if (lane === "global") return total;
  const hot = Math.max(1, Math.floor(total * 0.35));
  return lane === "hot_intake" ? hot : total - hot;
}

function stateWriterCoordinatorLeaseMs(env) {
  return Math.max(
    30_000,
    Math.min(
      10 * 60_000,
      Math.floor(
        numberFrom(
          env.STATE_WRITER_COORDINATOR_LEASE_MS,
          DEFAULT_STATE_WRITER_COORDINATOR_LEASE_MS,
        ),
      ),
    ),
  );
}

function stateWriterCoordinatorQueuedStaleMs(env) {
  return Math.max(
    30_000,
    Math.min(
      10 * 60_000,
      Math.floor(
        numberFrom(
          env.STATE_WRITER_COORDINATOR_QUEUED_STALE_MS,
          DEFAULT_STATE_WRITER_COORDINATOR_QUEUED_STALE_MS,
        ),
      ),
    ),
  );
}

function stateWriterCoordinatorMaxLeaseAgeMs(env) {
  return Math.max(
    5 * 60_000,
    Math.min(
      60 * 60_000,
      Math.floor(
        numberFrom(
          env.STATE_WRITER_COORDINATOR_MAX_LEASE_AGE_MS,
          DEFAULT_STATE_WRITER_COORDINATOR_MAX_LEASE_AGE_MS,
        ),
      ),
    ),
  );
}

function stateWriterTicketInput(value: unknown): StateWriterTicketInput | null {
  const body = objectValue(value);
  const ticketId = boundedStateWriterIdentity(body.ticket_id);
  const owner = boundedStateWriterIdentity(body.owner);
  const branch = boundedStateWriterIdentity(body.branch);
  const repository = boundedStateWriterIdentity(body.repository);
  const workflow = boundedStateWriterMetadata(body.workflow);
  const job = boundedStateWriterMetadata(body.job);
  const runId = boundedStateWriterIdentity(body.run_id);
  const runAttempt = Number(body.run_attempt);
  const writerClass =
    body.writer_class === "publication_batch" || body.writer_class === "cluster_intake"
      ? body.writer_class
      : body.writer_class === "ordinary" || body.writer_class === undefined
        ? "ordinary"
        : null;
  if (
    !ticketId ||
    !owner ||
    !branch ||
    !repository ||
    !workflow ||
    !job ||
    !runId ||
    !Number.isSafeInteger(runAttempt) ||
    runAttempt < 1 ||
    !writerClass
  ) {
    return null;
  }
  return { ticketId, owner, branch, repository, workflow, job, runId, runAttempt, writerClass };
}

function boundedStateWriterIdentity(value: unknown): string | null {
  const normalized = String(value || "").trim();
  return normalized && normalized.length <= 200 && /^[A-Za-z0-9._:/@-]+$/.test(normalized)
    ? normalized
    : null;
}

function boundedStateWriterMetadata(value: unknown): string | null {
  const normalized = String(value || "").trim();
  return normalized &&
    normalized.length <= 500 &&
    !/[\r\n]/.test(normalized) &&
    !normalized.includes("\u0000")
    ? normalized
    : null;
}

async function exactReviewDispatchToken(env) {
  return exactReviewRepositoryToken(env, { actions: "write", contents: "write" });
}

async function exactReviewSourceAuthorityLiveHead(
  env,
  reservation: ExactReviewSourceAuthorityReservation,
) {
  const credentials = githubAppCredentials(env);
  if (!credentials) throw new Error("github app is not configured");
  const appJwt = await signGithubAppJwt(credentials.issuer, credentials.privateKey);
  const token = await createGithubAppTokenFor({
    env,
    appJwt,
    installationId: reservation.installationId,
    label: reservation.decision.targetRepo,
    repositories: [repoName(reservation.decision.targetRepo)],
    permissions: { pull_requests: "read" },
  });
  const pull = await githubTokenJson({
    env,
    token,
    path: `/repos/${reservation.decision.targetRepo}/pulls/${reservation.decision.itemNumber}`,
    method: "GET",
    body: undefined,
    errorLabel: "live pull request head",
  });
  return String(objectValue(objectValue(pull).head).sha || "")
    .trim()
    .toLowerCase();
}

async function exactReviewCommandTargetToken(
  env,
  intake: ExactReviewCommandIntakeRecord["intake"],
) {
  const credentials = githubAppCredentials(env);
  if (!credentials) throw new Error("github app is not configured");
  const appJwt = await signGithubAppJwt(credentials.issuer, credentials.privateKey);
  return createGithubAppTokenFor({
    env,
    appJwt,
    installationId: intake.installationId,
    label: intake.decision.targetRepo,
    repositories: [repoName(intake.decision.targetRepo)],
    permissions: { issues: "write", pull_requests: "write" },
  });
}

export async function convergeCommandAcknowledgement(options: {
  env: Record<string, unknown>;
  token: Promise<string>;
  decision: DirectReReviewDecision;
  sourceCommentId: number;
}) {
  const token = await options.token;
  const ackMarker = clawSweeperCommandAckMarker(options.sourceCommentId);
  const statusMarker = options.decision.commandStatusMarker;
  const trustedBotLogins = exactReviewCommandBotLogins(options.env);
  const trustedAcknowledgement = (comment: Record<string, unknown>) =>
    trustedBotLogins.has(
      String(objectValue(comment.user).login || "")
        .trim()
        .toLowerCase(),
    );
  const list = async () => {
    const matching: Record<string, unknown>[] = [];
    for (let page = 1; page <= 5; page += 1) {
      const comments = await githubTokenJson({
        env: options.env,
        token,
        path: `/repos/${options.decision.targetRepo}/issues/${options.decision.itemNumber}/comments?per_page=100&page=${page}`,
        method: "GET",
        body: undefined,
        errorLabel: "direct command acknowledgement list",
      });
      if (!Array.isArray(comments)) break;
      const records = comments.map((comment) => objectValue(comment));
      matching.push(
        ...records.filter(
          (comment) =>
            trustedAcknowledgement(comment) && String(comment.body || "").includes(ackMarker),
        ),
      );
      if (records.length < 100) break;
    }
    return matching;
  };
  let comments = await list();
  const suppliedStatusCommentId = Number(options.decision.statusCommentId) || null;
  if (
    suppliedStatusCommentId &&
    !comments.some((comment) => Number(comment.id) === suppliedStatusCommentId)
  ) {
    const supplied = objectValue(
      await githubTokenJson({
        env: options.env,
        token,
        path: `/repos/${options.decision.targetRepo}/issues/comments/${suppliedStatusCommentId}`,
        method: "GET",
        body: undefined,
        errorLabel: "direct command supplied acknowledgement",
      }).catch((error) => {
        if (error instanceof GitHubRequestError && error.status === 404) return null;
        throw error;
      }),
    );
    if (
      Number(supplied.id) === suppliedStatusCommentId &&
      trustedAcknowledgement(supplied) &&
      String(supplied.body || "").includes(ackMarker) &&
      String(supplied.issue_url || "").endsWith(
        `/repos/${options.decision.targetRepo}/issues/${options.decision.itemNumber}`,
      )
    ) {
      comments.push(supplied);
    }
  }
  let exact = comments.find((comment) => String(comment.body || "").includes(statusMarker));
  if (!exact) {
    const bare = comments.find(
      (comment) => !String(comment.body || "").includes("clawsweeper-command-status:"),
    );
    const bareId = Number(bare?.id) || null;
    const body = renderClawSweeperQueuedAcknowledgement(options.sourceCommentId, statusMarker);
    exact = objectValue(
      await githubTokenJson({
        env: options.env,
        token,
        path: bareId
          ? `/repos/${options.decision.targetRepo}/issues/comments/${bareId}`
          : `/repos/${options.decision.targetRepo}/issues/${options.decision.itemNumber}/comments`,
        method: bareId ? "PATCH" : "POST",
        body: { body },
        errorLabel: "direct command acknowledgement",
      }),
    );
    comments = [
      ...(await list()),
      { ...exact, body, id: Number(exact.id || bareId), created_at: exact.created_at || "" },
    ];
  }
  const convergence = planCommandAckConvergence(comments, statusMarker);
  for (const duplicate of convergence.prunable.slice(0, 20)) {
    const id = Number(duplicate.id);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    await githubTokenJson({
      env: options.env,
      token,
      path: `/repos/${options.decision.targetRepo}/issues/comments/${id}`,
      method: "DELETE",
      body: undefined,
      errorLabel: "duplicate command acknowledgement cleanup",
    }).catch((error) => {
      if (!(error instanceof GitHubRequestError && error.status === 404)) throw error;
    });
  }
  return Number(convergence.keep?.id || exact.id) || null;
}

function exactReviewCommandBotLogins(env: Record<string, unknown>) {
  const configured = String(env.CLAWSWEEPER_BOT_LOGINS || "")
    .split(",")
    .map((login) => login.trim().toLowerCase())
    .filter(Boolean);
  return new Set(
    configured.length ? configured : ["clawsweeper[bot]", "openclaw-clawsweeper[bot]"],
  );
}

async function addCommandReaction(options: {
  env: Record<string, unknown>;
  token: Promise<string>;
  repo: string;
  commentId: number;
}) {
  await githubTokenJson({
    env: options.env,
    token: await options.token,
    path: `/repos/${options.repo}/issues/comments/${options.commentId}/reactions`,
    method: "POST",
    body: { content: "eyes" },
    errorLabel: "direct command reaction",
  }).catch((error) => {
    if (!(error instanceof GitHubRequestError && error.status === 422)) throw error;
  });
}

async function exactReviewTargetReadToken(env, targetRepo: string, knownInstallationId?: number) {
  const credentials = githubAppCredentials(env);
  if (!credentials) throw new Error("github app is not configured");
  const appJwt = await signGithubAppJwt(credentials.issuer, credentials.privateKey);
  const installationId =
    knownInstallationId ?? (await githubAppInstallationId(appJwt, targetRepo, env));
  return createGithubAppTokenFor({
    env,
    appJwt,
    installationId,
    label: targetRepo,
    repositories: [repoName(targetRepo)],
    permissions: { issues: "read", pull_requests: "read" },
  });
}

async function exactReviewTargetDefaultBranch(
  env,
  targetRepo: string,
  knownInstallationId?: number,
) {
  const token = await exactReviewTargetReadToken(env, targetRepo, knownInstallationId);
  const repository = await githubTokenJson({
    env,
    token,
    path: `/repos/${targetRepo}`,
    method: "GET",
    body: undefined,
    errorLabel: "target repository default branch",
  });
  const targetBranch = String(objectValue(repository).default_branch || "").trim();
  if (!/^[A-Za-z0-9_./-]+$/.test(targetBranch)) {
    throw new Error("target repository response missing valid default branch");
  }
  return targetBranch;
}

async function exactReviewTargetItemState(
  token: string,
  decision: ExactReviewDecision,
  env = {},
): Promise<Exclude<ExactReviewTargetItemState, { state: "unavailable" }>> {
  try {
    const isPullRequest = decision.itemKind === "pull_request";
    const queuedHeadSha = String(decision.sourceHeadSha || "").toLowerCase();
    const readPullHead = isPullRequest && /^[0-9a-f]{40}$/.test(queuedHeadSha);
    const item = await githubTokenJson({
      env,
      token,
      path: `/repos/${decision.targetRepo}/${readPullHead ? "pulls" : "issues"}/${decision.itemNumber}`,
      method: "GET",
      body: undefined,
      errorLabel: "live review item state",
    });
    const state = String(item.state || "").trim();
    if (state === "open") {
      if (!readPullHead) return { state: "open" };
      const headSha = String(objectValue(objectValue(item).head).sha || "")
        .trim()
        .toLowerCase();
      if (!/^[0-9a-f]{40}$/.test(headSha)) {
        throw new Error("live pull request response missing head SHA");
      }
      return { state: "open", headSha };
    }
    if (state === "closed") return { state: "terminal" };
    throw new Error("live review item state response missing state");
  } catch (error) {
    if (error instanceof GitHubRequestError && error.status === 410) return { state: "terminal" };
    if (error instanceof GitHubRequestError && error.status === 404) {
      // GitHub masks inaccessible private repositories as 404. Treat the item
      // as missing only when this token can still read its repository.
      await githubTokenJson({
        env,
        token,
        path: `/repos/${decision.targetRepo}`,
        method: "GET",
        body: undefined,
        errorLabel: "live review target repository",
      });
      return { state: "terminal" };
    }
    throw error;
  }
}

export async function exactReviewActionsReadToken(env) {
  return exactReviewRepositoryToken(env, { actions: "read" });
}

export async function exactReviewRepositoryToken(env, permissions) {
  const credentials = githubAppCredentials(env);
  if (!credentials) throw new Error("github app is not configured");
  const appJwt = await signGithubAppJwt(credentials.issuer, credentials.privateKey);
  const installationId = await githubAppInstallationId(appJwt, CLAWSWEEPER_REVIEW_REPO, env);
  return createGithubAppTokenFor({
    env,
    appJwt,
    installationId,
    label: CLAWSWEEPER_REVIEW_REPO,
    repositories: [repoName(CLAWSWEEPER_REVIEW_REPO)],
    permissions,
  });
}

function exactReviewHostedTargetMetadataTokenSource(
  env: Record<string, unknown>,
): HostedTargetMetadataToken {
  let token: Promise<string> | null = null;
  return () => (token ??= exactReviewRepositoryToken(env, { metadata: "read" }));
}

async function exactReviewWorkflowState(token: string, env = {}) {
  const payload = await githubTokenJson({
    env,
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
  env = {},
) {
  const latest = await githubTokenJson({
    env,
    token,
    path: `/repos/${CLAWSWEEPER_REVIEW_REPO}/actions/runs/${candidate.runId}`,
    method: "GET",
    body: undefined,
    errorLabel: "ClawSweeper run status",
  });
  return exactReviewTerminalRunFromSummary(token, candidate, latest, env);
}

export async function exactReviewTerminalRunsFromBatch(
  token: string,
  candidates: Array<ExactReviewClaimedRun & { requestedRunAttempt?: number }>,
  env = {},
) {
  const runsById = new Map<string, Record<string, unknown>>();
  const unresolved = new Set(candidates.map((candidate) => candidate.runId));
  for (let page = 1; page <= EXACT_REVIEW_RECONCILE_LIST_PAGE_LIMIT; page += 1) {
    let payload;
    try {
      payload = await githubTokenJson({
        env,
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
        ? await exactReviewTerminalRunFromSummary(token, candidate, summary, env)
        : await exactReviewTerminalRun(token, candidate, env);
    } catch {
      return undefined;
    }
  });
}

async function exactReviewTerminalRunFromSummary(
  token: string,
  candidate: ExactReviewClaimedRun & { requestedRunAttempt?: number },
  latest: Record<string, unknown>,
  env = {},
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
    env,
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

async function dispatchClawsweeperItem({
  env,
  token,
  decision,
  itemKey,
  leaseId,
  leaseRevision,
  terminalFinalization,
}: {
  env: Record<string, unknown>;
  token: string;
  decision: ExactReviewDecision;
  itemKey: string;
  leaseId: string;
  leaseRevision: number;
  terminalFinalization?: ExactReviewTerminalFinalization;
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
    env,
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
          ...(decision.sourceHeadSha ? { source_head_sha: decision.sourceHeadSha } : {}),
        },
        target_repo: decision.targetRepo,
        target_branch: decision.targetBranch,
        item_number: decision.itemNumber,
        item_kind: decision.itemKind,
        source_event: decision.sourceEvent,
        source_action: terminalFinalization
          ? "exact_review_command_acknowledgement"
          : decision.sourceAction,
        supersedes_in_progress: decision.supersedesInProgress,
        ...(Object.keys(reviewOptions).length > 0 ? { review_options: reviewOptions } : {}),
      },
    },
    errorLabel: "ClawSweeper item dispatch",
  });
}

type ExactReviewDispatchFailure = {
  scope: "item" | "global";
  failureClass: ExactReviewDispatchFailureClass;
  status?: number;
  fingerprint: string;
  detail?: ExactReviewDispatchFailureDetail;
};

export type ExactReviewDispatchFailureDetail = GitHubRequestValidationDetail;

function exactReviewDispatchFailure(error: unknown): ExactReviewDispatchFailure {
  const requestError = error instanceof GitHubRequestError ? error : null;
  const status = requestError?.status;
  const detail = requestError?.validationDetail;
  const failureClass: ExactReviewDispatchFailureClass = requestError?.timedOut
    ? "timeout"
    : requestError?.rateLimited || status === 429
      ? "rate_limit"
      : status === 422 && !exactReviewPermanentDispatchValidation(detail)
        ? "validation_unknown"
        : status === 400 || status === 404 || status === 422
          ? "permanent_rejection"
          : status === 401 || status === 403
            ? "authentication"
            : status !== undefined && status >= 500
              ? "github_outage"
              : "network";
  return {
    scope: failureClass === "permanent_rejection" ? "item" : "global",
    failureClass,
    ...(status === undefined ? {} : { status }),
    ...(detail ? { detail } : {}),
    fingerprint: exactReviewDispatchFailureFingerprint(failureClass, status, detail),
  };
}

function exactReviewPermanentDispatchValidation(detail?: ExactReviewDispatchFailureDetail) {
  return detail?.validationFields.length === 1 && detail.validationFields[0] === "client_payload";
}

function exactReviewAdmissionFailure(error: unknown): ExactReviewDispatchFailure {
  const failure = exactReviewDispatchFailure(error);
  // Admission reads one target item. Its validation response cannot describe
  // the shared repository_dispatch contract, so it must not hold other items.
  if (error instanceof GitHubRequestError && error.status === 422) {
    return { ...failure, scope: "item" };
  }
  // This error arose while checking one specific target. A target installation
  // may lack issue-read access even though other target installations are
  // healthy, so a 403 must not hold the whole queue.
  if (error instanceof GitHubRequestError && error.status === 403 && !error.rateLimited) {
    return { ...failure, scope: "item" };
  }
  return failure;
}

function exactReviewDispatchFailureFingerprint(
  failureClass: ExactReviewDispatchFailureClass,
  status?: number,
  detail?: ExactReviewDispatchFailureDetail,
) {
  const value = `${failureClass}:${status ?? "none"}:${detail?.validationFields.join(",") || "none"}:${detail?.validationCodes.join(",") || "none"}`;
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `dispatch-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function exactReviewDispatchDispatcherReason(
  failureClass: ExactReviewDispatchFailureClass,
): NonNullable<ExactReviewQueueState["dispatcher"]>["reason"] {
  if (failureClass === "authentication") return "dispatch_authentication";
  if (failureClass === "rate_limit") return "dispatch_rate_limit";
  if (failureClass === "github_outage") return "dispatch_github_outage";
  if (failureClass === "timeout") return "dispatch_timeout";
  if (failureClass === "validation_unknown") return "dispatch_validation";
  return "dispatch_network";
}

function exactReviewDispatchGlobalRetryDelayMs(
  consecutiveFailures: number,
  failure: ExactReviewDispatchFailure,
) {
  const base = failure.failureClass === "authentication" ? 5 * 60_000 : 30_000;
  return Math.min(15 * 60_000, base * 2 ** Math.min(Math.max(0, consecutiveFailures - 1), 5));
}

async function dispatchExactReviewBatchWorkflow({
  env,
  token,
  dispatchId,
  dispatchedAt,
}: {
  env: Record<string, unknown>;
  token: string;
  dispatchId: string;
  dispatchedAt: string;
}) {
  await githubTokenJson({
    env,
    token,
    path: `/repos/${CLAWSWEEPER_REVIEW_REPO}/actions/workflows/exact-review-batch-publish.yml/dispatches`,
    method: "POST",
    body: {
      ref: "main",
      inputs: { execute: "true", dispatch_id: dispatchId, dispatched_at: dispatchedAt },
    },
    errorLabel: "Exact-review batch workflow dispatch",
  });
}

async function githubTokenJson({ env = {}, token, path, method = "GET", body, errorLabel }) {
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
  let response: Response;
  try {
    response = await fetch(githubApiUrl(env, path), init);
  } catch (error) {
    const timedOut =
      controller.signal.aborted ||
      (error instanceof Error && (error.name === "AbortError" || error.message === "timeout"));
    throw new GitHubRequestError(
      `${errorLabel || "GitHub"} ${timedOut ? "timed out" : "network failure"}`,
      undefined,
      timedOut,
    );
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const rateLimited = githubResponseRateLimited(response, text);
    throw new GitHubRequestError(
      `${errorLabel || "GitHub"} ${response.status}`,
      response.status,
      false,
      rateLimited,
      githubResponseValidationDetail(response.status, text),
      rateLimited ? githubResponseRateLimitHint(response, Date.now()) : undefined,
    );
  }
  if (response.status === 204) return {};
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

function exactReviewPublicationBatchId(value) {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9._:-]{1,200}$/.test(text) ? text : "";
}

function exactReviewPublicationBatchOwner(value) {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9._:@/-]{1,200}$/.test(text) ? text : "";
}

function exactReviewGithubCredentialPoolKey(
  scope: ExactReviewGithubCredentialScope,
  targetOwner?: string,
) {
  return scope === "repository_actions"
    ? "actions:openclaw/clawsweeper"
    : `target_app:${String(targetOwner || "").toLowerCase()}`;
}

function exactReviewGithubRateLimitObservations(
  value,
): ExactReviewGithubRateLimitObservation[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) return null;
  const now = Date.now();
  const observations: ExactReviewGithubRateLimitObservation[] = [];
  for (const raw of value) {
    const item = objectValue(raw);
    const scope = String(item.scope || "");
    const targetOwner = String(item.target_owner || "")
      .trim()
      .toLowerCase();
    const observedAt = Date.parse(String(item.observed_at || ""));
    const retryAt = Date.parse(String(item.retry_at || ""));
    const provenance = String(item.provenance || "");
    if (
      (scope !== "repository_actions" && scope !== "target_app") ||
      (scope === "target_app" && !/^[a-z0-9_.-]{1,100}$/.test(targetOwner)) ||
      !Number.isFinite(observedAt) ||
      observedAt < now - 24 * 60 * 60 * 1000 ||
      observedAt > now + 5 * 60_000 ||
      !Number.isFinite(retryAt) ||
      retryAt < observedAt ||
      retryAt > now + EXACT_REVIEW_COMPLETION_RETRY_MAX_MS ||
      !["retry_after", "rate_limit_reset", "rate_limit_status", "fallback"].includes(provenance) ||
      typeof item.authoritative !== "boolean"
    ) {
      return null;
    }
    observations.push({
      scope,
      ...(targetOwner ? { targetOwner } : {}),
      observedAt,
      retryAt,
      provenance: provenance as ExactReviewGithubRateLimitProvenance,
      authoritative: item.authoritative,
    });
  }
  return observations;
}

function exactReviewGithubRequestMetrics(value): ExactReviewGithubRequestMetric[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 128) return null;
  const metrics: ExactReviewGithubRequestMetric[] = [];
  for (const raw of value) {
    const item = objectValue(raw);
    const scope = String(item.scope || "");
    const category = String(item.category || "");
    const mode = String(item.mode || "");
    const outcome = String(item.outcome || "");
    const count = Number(item.count);
    if (
      !["repository_actions", "target_app"].includes(scope) ||
      ![
        "artifact_download",
        "rate_status",
        "comments",
        "labels",
        "reviews",
        "workflow_dispatch",
        "item_metadata",
        "other",
      ].includes(category) ||
      !["read", "mutation_or_private_read"].includes(mode) ||
      !["success", "throttle", "transient", "error", "skipped_by_circuit"].includes(outcome) ||
      typeof item.repeat_revision !== "boolean" ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > 10_000
    ) {
      return null;
    }
    metrics.push({
      scope: scope as ExactReviewGithubCredentialScope,
      category: category as ExactReviewGithubRequestMetric["category"],
      mode: mode as ExactReviewGithubRequestMetric["mode"],
      outcome: outcome as ExactReviewGithubRequestMetric["outcome"],
      repeatRevision: item.repeat_revision,
      count,
    });
  }
  return metrics;
}

function applyExactReviewGithubCredentialCircuits(
  state: ExactReviewQueueState,
  observations: readonly ExactReviewGithubRateLimitObservation[],
) {
  const dispatcher = state.dispatcher ?? { state: "unknown" as const, checkedAt: Date.now() };
  const circuits = { ...dispatcher.githubCredentialCircuits };
  for (const observation of observations) {
    const poolKey = exactReviewGithubCredentialPoolKey(observation.scope, observation.targetOwner);
    const previous = circuits[poolKey];
    if (!previous || observation.retryAt > previous.retryAt) {
      circuits[poolKey] = { ...observation, poolKey };
    }
  }
  state.dispatcher = { ...dispatcher, githubCredentialCircuits: circuits };
}

function applyExactReviewGithubRequestMetrics(
  state: ExactReviewQueueState,
  metrics: readonly ExactReviewGithubRequestMetric[],
  now: number,
) {
  const dispatcher = state.dispatcher ?? { state: "unknown" as const, checkedAt: now };
  const counters = { ...dispatcher.githubRequestMetrics?.counters };
  for (const metric of metrics) {
    const key = [
      metric.scope,
      metric.category,
      metric.mode,
      metric.outcome,
      metric.repeatRevision ? "repeat" : "first",
    ].join(":");
    counters[key] = Math.max(0, Number(counters[key] || 0)) + metric.count;
  }
  state.dispatcher = {
    ...dispatcher,
    githubRequestMetrics: { updatedAt: now, counters },
  };
}

function exactReviewGithubCircuitBlocksItem(
  state: ExactReviewQueueState,
  item: ExactReviewQueueItem,
  now: number,
) {
  return exactReviewGithubCredentialCircuits(state).some(
    (circuit) =>
      exactReviewGithubCircuitMatchesItem(circuit, item) &&
      exactReviewGithubCircuitRecoveryAt(circuit, item) > now,
  );
}

function exactReviewGithubCircuitNextWakeAt(state: ExactReviewQueueState, now: number) {
  let next: number | null = null;
  for (const item of Object.values(state.items)) {
    if (!exactReviewQueueIsBatchablePublication(item) || item.state !== "pending") continue;
    for (const circuit of exactReviewGithubCredentialCircuits(state)) {
      if (!exactReviewGithubCircuitMatchesItem(circuit, item)) continue;
      const recoveryAt = exactReviewGithubCircuitRecoveryAt(circuit, item);
      if (recoveryAt <= now) continue;
      next = next === null ? recoveryAt : Math.min(next, recoveryAt);
    }
  }
  return next;
}

function exactReviewGithubCircuitMatchesItem(
  circuit: ExactReviewGithubCredentialCircuit,
  item: ExactReviewQueueItem,
) {
  const owner = item.decision.targetRepo.split("/", 1)[0]?.toLowerCase();
  return circuit.scope === "repository_actions" || circuit.targetOwner === owner;
}

function exactReviewGithubCircuitRecoveryAt(
  circuit: ExactReviewGithubCredentialCircuit,
  item: ExactReviewQueueItem,
) {
  return circuit.retryAt + exactReviewCredentialRecoveryJitterMs(item.key);
}

function exactReviewAuthorityPendingByOwner(
  reservations: Array<
    ExactReviewSourceAuthorityReservation | ExactReviewBranchAuthorityReservation
  >,
) {
  const pending = new Map<string, string[]>();
  for (const reservation of reservations) {
    const owner = reservation.decision.targetRepo.split("/", 1)[0]?.toLowerCase();
    if (!owner) continue;
    const deliveryIds = pending.get(owner) || [];
    deliveryIds.push(reservation.deliveryId);
    pending.set(owner, deliveryIds);
  }
  return pending;
}

function exactReviewGithubCredentialCircuitStatus(
  state: ExactReviewQueueState,
  now: number,
  authorityPendingByOwner = new Map<string, string[]>(),
) {
  return exactReviewGithubCredentialCircuits(state)
    .map((circuit) => {
      const matchingItems = Object.values(state.items).filter((item) => {
        if (!exactReviewQueueIsBatchablePublication(item) || item.state !== "pending") return false;
        return exactReviewGithubCircuitMatchesItem(circuit, item);
      });
      const affectedItems = matchingItems.filter(
        (item) => exactReviewGithubCircuitRecoveryAt(circuit, item) > now,
      );
      const authorityDeliveryIds =
        circuit.scope === "target_app" && circuit.targetOwner
          ? authorityPendingByOwner.get(circuit.targetOwner) || []
          : [];
      let affectedPending = affectedItems.length;
      affectedPending += authorityDeliveryIds.length;
      let recoveryAt = matchingItems.reduce(
        (latest, item) => Math.max(latest, exactReviewGithubCircuitRecoveryAt(circuit, item)),
        circuit.retryAt,
      );
      recoveryAt = authorityDeliveryIds.reduce(
        (latest, deliveryId) =>
          Math.max(latest, circuit.retryAt + exactReviewCredentialRecoveryJitterMs(deliveryId)),
        recoveryAt,
      );
      return {
        pool: circuit.poolKey,
        scope: circuit.scope,
        target_owner: circuit.targetOwner || null,
        observed_at: new Date(circuit.observedAt).toISOString(),
        blocked_until: new Date(circuit.retryAt).toISOString(),
        recovery_until: new Date(recoveryAt).toISOString(),
        reset_source: circuit.provenance,
        authoritative: circuit.authoritative,
        active: recoveryAt > now,
        affected_pending: affectedPending,
      };
    })
    .sort(
      (left, right) =>
        Number(right.active) - Number(left.active) || left.pool.localeCompare(right.pool),
    );
}

function exactReviewPublicationBatchCompletions(
  value,
): ExactReviewPublicationBatchCompletion[] | null {
  if (!Array.isArray(value) || value.length > MAX_EXACT_REVIEW_PUBLICATION_BATCH_SIZE) return null;
  const seen = new Set<string>();
  const completions: ExactReviewPublicationBatchCompletion[] = [];
  for (const raw of value) {
    const item = objectValue(raw);
    const itemKey = String(item.item_key || "").trim();
    const revision = Number(item.revision);
    const claimGeneration = Number(item.claim_generation);
    const terminalOutcome = String(item.terminal_outcome || "").trim();
    const publicationCompletion =
      terminalOutcome === "published" || terminalOutcome === "superseded"
        ? null
        : exactReviewPublicationCompletion(
            terminalOutcome,
            item.reason_code,
            item.error_fingerprint,
            item.pool_class,
          );
    const requestedRetryAt = exactReviewCompletionRetryAt(item.retry_at, Date.now());
    const attempted = item.attempted === undefined ? undefined : item.attempted === true;
    if (publicationCompletion && attempted !== undefined) {
      publicationCompletion.attempted = attempted;
    }
    if (
      !itemKey ||
      itemKey.length > 500 ||
      seen.has(itemKey) ||
      !Number.isInteger(revision) ||
      revision < 1 ||
      !Number.isInteger(claimGeneration) ||
      claimGeneration < 1 ||
      (terminalOutcome !== "published" &&
        terminalOutcome !== "superseded" &&
        !publicationCompletion) ||
      publicationCompletion?.kind === "published" ||
      publicationCompletion?.kind === "superseded" ||
      publicationCompletion?.kind === "deferred" ||
      (item.retry_at !== undefined && requestedRetryAt === null) ||
      (item.attempted !== undefined && typeof item.attempted !== "boolean") ||
      (attempted === false &&
        (!["github_rate_limit", "github_transient"].includes(
          publicationCompletion?.reasonCode ?? "",
        ) ||
          requestedRetryAt === null))
    ) {
      return null;
    }
    seen.add(itemKey);
    completions.push({
      itemKey,
      revision,
      claimGeneration,
      terminalOutcome:
        terminalOutcome === "published" || terminalOutcome === "superseded"
          ? terminalOutcome
          : "lease_expired",
      ...(publicationCompletion ? { publicationCompletion } : {}),
      ...(requestedRetryAt !== null ? { requestedRetryAt } : {}),
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
    server_time: new Date(Date.now()).toISOString(),
    configured_batch_size: batch.configuredBatchSize,
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

const RESERVATION_TO_CLAIM_DELAY_BUCKET_MS = 10 * 60_000;
const RUNNER_HANDOFF_ALERT_MS = 10 * 60_000;
const STATE_WRITER_ALERT_MS = 20 * 60_000;
const GITHUB_THROTTLE_ALERT_MS = 15 * 60_000;

function exactReviewReservationClaimObservability({
  now,
  dispatcher,
  publication,
  batches,
  directPublicationEnabled,
  legacyStateRepoBatchEnabled,
  maxConcurrentBatches,
}) {
  const reservationToClaimDelays = batches.flatMap((batch) =>
    batch.dispatchedAt === null ? [] : [Math.max(0, batch.createdAt - batch.dispatchedAt)],
  );
  const alerts = [];
  const activeBatches = batches.filter((batch) => batch.state === "leased");
  const pending = Number(publication?.pending || 0);
  const activeItems = activeBatches.reduce(
    (total, batch) => total + batch.items.filter((item) => item.terminalOutcome === null).length,
    0,
  );
  const unassignedPending = Math.max(0, pending - activeItems);
  if (unassignedPending > 0 && activeBatches.length >= maxConcurrentBatches) {
    alerts.push({
      kind: "no_capacity",
      status: "active",
      detail:
        "All configured publication batch slots are leased while durable publication work remains pending.",
    });
  }
  const dispatchAt = Number(dispatcher?.publicationBatchDispatchedAt || 0);
  const dispatchId = String(dispatcher?.publicationBatchDispatchId || "");
  const dispatchPendingUntil = Number(dispatcher?.publicationBatchDispatchPendingUntil || 0);
  // Alert halfway through the actual reservation window. This keeps the alert
  // actionable for deployments configured below the ten-minute default.
  const dispatchHandoffAlertMs = Math.max(
    1_000,
    Math.floor((dispatchPendingUntil - dispatchAt) / 2),
  );
  const dispatchedBatch = dispatchId
    ? batches.find((batch) => batch.dispatchId === dispatchId)
    : undefined;
  if (
    dispatchAt &&
    dispatchPendingUntil > now &&
    !dispatchedBatch &&
    now - dispatchAt >= dispatchHandoffAlertMs &&
    dispatcher?.publicationBatchDispatchSucceeded !== false
  ) {
    alerts.push({
      kind: "dispatcher_handoff_stalled",
      status: "active",
      dispatch_id: dispatchId || null,
      since: new Date(dispatchAt).toISOString(),
      detail:
        "A batch workflow dispatch has not produced a durable batch claim within the handoff threshold.",
    });
  }
  for (const batch of activeBatches) {
    if (
      batch.dispatchedAt !== null &&
      batch.runnerStartedAt === null &&
      now - batch.dispatchedAt >= RUNNER_HANDOFF_ALERT_MS
    ) {
      alerts.push({
        kind: "runner_stalled",
        status: "active",
        batch_id: batch.batchId,
        dispatch_id: batch.dispatchId,
        since: new Date(batch.dispatchedAt).toISOString(),
        detail:
          "The workflow was dispatched and the batch was claimed, but no runner-start timestamp was recorded.",
      });
    }
    const stateWriterBlockedAt = batch.stateWriterWaitAt ?? batch.preparationFinishedAt;
    if (
      stateWriterBlockedAt !== null &&
      batch.stateWriterCommittedAt === null &&
      now - stateWriterBlockedAt >= STATE_WRITER_ALERT_MS
    ) {
      alerts.push({
        kind: "state_writer_stalled",
        status: "active",
        batch_id: batch.batchId,
        since: new Date(stateWriterBlockedAt).toISOString(),
        detail:
          "Preparation completed but the state-writer commit timestamp has not arrived within the threshold.",
      });
    }
  }
  for (const batch of batches) {
    if (
      batch.githubThrottleAt !== null &&
      now - batch.githubThrottleAt < GITHUB_THROTTLE_ALERT_MS
    ) {
      alerts.push({
        kind: "github_throttle",
        status: "active",
        batch_id: batch.batchId,
        since: new Date(batch.githubThrottleAt).toISOString(),
        detail: "A batch completion reported a GitHub rate-limit outcome.",
      });
    }
  }
  return {
    schema_version: 1,
    generated_at: new Date(now).toISOString(),
    // Direct publication never enters a publication batch unless it falls back.
    // Keep its canonical Durable Object path distinct from the batch-only
    // timestamps below so dashboards do not infer state-writer latency for a
    // direct publication.
    publication_paths: {
      cloudflare_canonical_direct: {
        enabled: directPublicationEnabled,
        reservation_to_claim: "not_applicable",
        state_writer_timing: "not_applicable",
      },
      legacy_state_repo_batch: {
        enabled: legacyStateRepoBatchEnabled,
        reservation_to_claim: "tracked",
        state_writer_timing: "tracked",
      },
    },
    queue_slots: {
      pending,
      unassigned_pending: unassignedPending,
      active_items: activeItems,
      active_batches: activeBatches.length,
      max_concurrent_batches: maxConcurrentBatches,
      available_batches: Math.max(0, maxConcurrentBatches - activeBatches.length),
    },
    delay_buckets: exactReviewReservationClaimDelayBuckets(reservationToClaimDelays),
    alerts,
    batches: batches.map((batch) => ({
      batch_id: batch.batchId,
      publication_path: "legacy_state_repo_batch",
      state: batch.state,
      configured_batch_size: batch.configuredBatchSize,
      claimed_at: new Date(batch.createdAt).toISOString(),
      batch_age_seconds: Math.max(0, Math.floor((now - batch.createdAt) / 1000)),
      dispatch: {
        id: batch.dispatchId,
        at: exactReviewReservationClaimTimestamp(batch.dispatchedAt),
      },
      workflow: {
        run_id: batch.runnerRunId,
        run_attempt: batch.runnerRunAttempt,
        runner_started_at: exactReviewReservationClaimTimestamp(batch.runnerStartedAt),
      },
      timeline: {
        preparation_started_at: exactReviewReservationClaimTimestamp(batch.preparationStartedAt),
        preparation_finished_at: exactReviewReservationClaimTimestamp(batch.preparationFinishedAt),
        state_writer_wait_at: exactReviewReservationClaimTimestamp(batch.stateWriterWaitAt),
        state_writer_committed_at: exactReviewReservationClaimTimestamp(
          batch.stateWriterCommittedAt,
        ),
        final_github_apply_at: exactReviewReservationClaimTimestamp(batch.finalGithubApplyAt),
        github_throttle_at: exactReviewReservationClaimTimestamp(batch.githubThrottleAt),
      },
      items: batch.items.map((item) => ({
        item_key: item.itemKey,
        revision: item.revision,
        claim_generation: item.claimGeneration,
        producer_run_id: item.producerRunId ?? null,
        producer_run_attempt: item.producerRunAttempt ?? null,
        enqueued_at:
          item.enqueuedAt === undefined
            ? null
            : exactReviewReservationClaimTimestamp(item.enqueuedAt),
        reservation_to_claim_ms:
          batch.dispatchedAt === null ? null : Math.max(0, batch.createdAt - batch.dispatchedAt),
        enqueue_to_claim_ms:
          item.enqueuedAt === undefined ? null : Math.max(0, batch.createdAt - item.enqueuedAt),
        terminal_outcome: item.terminalOutcome,
      })),
    })),
  };
}

function exactReviewReservationClaimDelayBuckets(delays) {
  const buckets = [
    { id: "under_1m", max_ms: 60_000 },
    { id: "1m_to_5m", max_ms: 5 * 60_000 },
    { id: "5m_to_10m", max_ms: RESERVATION_TO_CLAIM_DELAY_BUCKET_MS },
    { id: "over_10m", max_ms: Number.POSITIVE_INFINITY },
  ].map((bucket) => ({
    id: bucket.id,
    count: delays.filter(
      (delay) =>
        delay <= bucket.max_ms &&
        (bucket.id === "under_1m" || delay > previousReservationClaimBucketMax(bucket.id)),
    ).length,
  }));
  return { metric: "reservation_to_claim_ms", buckets };
}

function previousReservationClaimBucketMax(id) {
  if (id === "1m_to_5m") return 60_000;
  if (id === "5m_to_10m") return 5 * 60_000;
  return RESERVATION_TO_CLAIM_DELAY_BUCKET_MS;
}

function exactReviewReservationClaimTimestamp(value) {
  return value === null || value === undefined ? null : new Date(value).toISOString();
}

function exactReviewPublicationBatchDispatchMetadata(value) {
  const id = String(value.dispatch_id || "").trim();
  const at = exactReviewPublicationBatchTimestamp(value.dispatched_at);
  if (!id || !at || !/^[A-Za-z0-9:._-]{1,200}$/.test(id)) return null;
  return { id, at };
}

function exactReviewPublicationBatchRunnerMetadata(value) {
  const runId = String(value.runner_run_id || "").trim();
  const runAttempt = Number(value.runner_run_attempt);
  const startedAt = exactReviewPublicationBatchTimestamp(value.runner_started_at);
  if (
    !/^[0-9]{1,30}$/.test(runId) ||
    !Number.isSafeInteger(runAttempt) ||
    runAttempt < 1 ||
    !startedAt
  ) {
    return null;
  }
  return { runId, runAttempt, startedAt };
}

function exactReviewPublicationBatchObservation(
  value,
): { stage: PublicationBatchObservationStage; observedAt: number } | null {
  const stage = String(value.timeline_stage || "");
  const observedAt = exactReviewPublicationBatchTimestamp(value.observed_at);
  if (
    ![
      "preparation_started",
      "preparation_finished",
      "state_writer_wait",
      "state_writer_committed",
      "final_github_apply",
      "github_throttle",
    ].includes(stage) ||
    !observedAt
  ) {
    return null;
  }
  return { stage: stage as PublicationBatchObservationStage, observedAt };
}

function exactReviewPublicationBatchTimestamp(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function operationalCursorModeFromPath(path: string): OperationalCursorMode | null {
  const match =
    /^\/cursors\/(hot-intake|normal-review|audit|review-placeholder-[a-f0-9]{16}-(?:open|closed))$/.exec(
      path,
    );
  return (match?.[1] as OperationalCursorMode | undefined) ?? null;
}

function operationalCursorKey(mode: OperationalCursorMode): string {
  return `${OPERATIONAL_CURSOR_KEY_PREFIX}${mode}`;
}

function emptyOperationalCursor(mode: OperationalCursorMode): OperationalCursor {
  return { mode, nextCursor: 0, revision: 0, updatedAt: 0 };
}

function readOperationalCursor(
  value: unknown,
  mode: OperationalCursorMode,
): OperationalCursor | "invalid" | null {
  if (value === undefined) return null;
  const cursor = objectValue(value);
  const nextCursor = Number(cursor.nextCursor);
  const revision = Number(cursor.revision);
  const updatedAt = Number(cursor.updatedAt);
  if (
    cursor.mode !== mode ||
    !Number.isSafeInteger(nextCursor) ||
    nextCursor < 0 ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    !Number.isSafeInteger(updatedAt) ||
    updatedAt < 1
  ) {
    return "invalid";
  }
  try {
    return {
      mode,
      nextCursor,
      revision,
      updatedAt,
      ...(mode === "audit" ? { auditBatch: parseAuditWaveState(cursor.auditBatch ?? null) } : {}),
    };
  } catch {
    return "invalid";
  }
}

function operationalCursorJson(cursor: OperationalCursor) {
  return {
    ok: true,
    mode: cursor.mode,
    next_cursor: cursor.nextCursor,
    revision: cursor.revision,
    updated_at: cursor.updatedAt > 0 ? new Date(cursor.updatedAt).toISOString() : null,
    ...(cursor.mode === "audit" ? { audit_batch: cursor.auditBatch ?? null } : {}),
  };
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

function exactReviewGithubTargetAppObservation(
  error: unknown,
  targetRepo: string,
  observedAt: number,
): ExactReviewGithubRateLimitObservation | undefined {
  if (!(error instanceof GitHubRequestError) || !error.rateLimited) return undefined;
  const targetOwner = targetRepo.split("/", 1)[0]?.trim().toLowerCase();
  if (!targetOwner) return undefined;
  const hint =
    error.rateLimitHint ||
    ({
      observedAt,
      retryAt: observedAt + EXACT_REVIEW_GITHUB_THROTTLE_ADMISSION_COOLDOWN_MS,
      provenance: "fallback",
      authoritative: false,
    } satisfies GitHubRateLimitHint);
  return {
    scope: "target_app",
    targetOwner,
    observedAt: hint.observedAt,
    retryAt: hint.retryAt,
    provenance: hint.provenance,
    authoritative: hint.authoritative,
  };
}

function snapshotJson(snapshot: RecordSnapshot) {
  return {
    repoSlug: snapshot.repoSlug,
    revisionWatermark: snapshot.revisionWatermark,
    objectKey: snapshot.objectKey,
    bytes: snapshot.bytes,
    uncompressedBytes: snapshot.uncompressedBytes,
    fileCount: snapshot.fileCount,
    createdAt: new Date(snapshot.createdAt).toISOString(),
    access: {
      mode: "worker_range_proxy",
      maxChunkBytes: RECORD_SNAPSHOT_DOWNLOAD_MAX_BYTES,
    },
  };
}

function snapshotErrorResponse(error: unknown) {
  if (error instanceof SnapshotRegistrationError) {
    return json({ error: error.message, snapshotStoreAvailable: true }, error.status);
  }
  if (error instanceof SnapshotStoreUnavailableError) {
    console.error("snapshot_store_unavailable");
    return json(
      {
        error: "snapshot_store_unavailable",
        snapshotStoreAvailable: false,
        detail: "STATE_SNAPSHOTS is not available",
      },
      503,
    );
  }
  if (error instanceof RangeError) {
    const notFound = error.message === "snapshot not found";
    return json(
      {
        error: notFound ? "snapshot_not_found" : "invalid_snapshot_range",
        snapshotStoreAvailable: true,
      },
      notFound ? 404 : 400,
    );
  }
  console.error("snapshot_request_failed");
  return json({ error: "snapshot_request_failed", snapshotStoreAvailable: true }, 500);
}

function jsonText(value: string, status = 200) {
  return cors(
    new Response(value, {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    }),
  );
}

function json(value, status = 200) {
  return jsonText(JSON.stringify(value, null, 2), status);
}

export function hostedTargetProbeResponse(admission: HostedTargetAdmission) {
  if (admission.outcome === "terminal") {
    return json({ error: "private_target_unsupported" }, 422);
  }
  const response = json({ error: "target_visibility_unverified", retryable: true }, 503);
  const retryAfterSeconds = hostedTargetRetryAfterSeconds(admission.retryAt);
  if (retryAfterSeconds !== null) {
    response.headers.set("retry-after", String(retryAfterSeconds));
  }
  return response;
}

function directPublicationSupersededResponse(
  validated: Pick<CanonicalDirectPublicationPlan, "canonicalTargetKey" | "fenceKey">,
) {
  return json(
    {
      ok: true,
      accepted: false,
      deduped: false,
      superseded: true,
      superseded_revisions: [],
      canonical_target_key: validated.canonicalTargetKey,
      fence_key: validated.fenceKey,
      state_commit_sha: null,
    },
    202,
  );
}

function unclaimedPublicationBatch(
  requestedSize: number,
  leaseSize: number,
  extra: Record<string, unknown> = {},
) {
  return json({
    ok: true,
    claimed: false,
    batch: null,
    requested_max_items: requestedSize,
    effective_max_items: leaseSize,
    ...extra,
  });
}

function cors(response) {
  response.headers.set("access-control-allow-origin", "*");
  response.headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  response.headers.set("access-control-allow-headers", "authorization,content-type");
  return response;
}
