import { projectExactReviewHandoff, summarizeExactReviewPressure } from "./exact-review-health.ts";
import {
  exactReviewQueueHasCommandContext,
  exactReviewQueueIsBatchablePublication,
  exactReviewQueueIsPublication,
  exactReviewQueueUsesLegacyBatchPath,
  isLowPriorityExactReviewDecision,
} from "./exact-review-decision.ts";
import { exactReviewScheduledLane, numberFrom } from "./exact-review-queue-shared.ts";
import type {
  ExactReviewDispatchFailureDetail,
  ExactReviewGithubCredentialCircuit,
  ExactReviewQueueItem,
  ExactReviewQueueState,
  ExactReviewReviewRecoveryReason,
} from "./exact-review-queue.ts";

const DEFAULT_EXACT_REVIEW_QUEUE_MAX_CONCURRENT = 32;
export const DEFAULT_EXACT_REVIEW_DISPATCH_LEASE_MS = 6 * 60 * 1000;
export const DEFAULT_EXACT_REVIEW_PUBLICATION_DISPATCH_LEASE_MS = 15 * 60 * 1000;
export const DEFAULT_EXACT_REVIEW_EXECUTION_LEASE_MS = 130 * 60 * 1000;
export const DEFAULT_EXACT_REVIEW_HEARTBEAT_GRACE_MS = 20 * 60 * 1000;
export const DEFAULT_EXACT_REVIEW_RETRY_MS = 30_000;
export const EXACT_REVIEW_PARKED_RECOVERY_LIMIT = 3;
export const EXACT_REVIEW_PARKED_RECOVERY_BASE_MS = 5 * 60_000;
export const EXACT_REVIEW_PARKED_RECOVERY_MAX_MS = 30 * 60_000;
export const EXACT_REVIEW_PARKED_TERMINAL_CHECK_INTERVAL_MS = 5 * 60_000;

export function exactReviewDispatchFailureDetailJson(detail?: ExactReviewDispatchFailureDetail) {
  if (!detail) return null;
  return {
    validation_fields: detail.validationFields,
    validation_codes: detail.validationCodes,
  };
}

export function exactReviewEffectiveLeaseExpiresAt(
  item: ExactReviewQueueItem,
  publicationDispatchLeaseMs: number,
  heartbeatGraceMs = DEFAULT_EXACT_REVIEW_HEARTBEAT_GRACE_MS,
) {
  const leaseExpiresAt = Number(item.leaseExpiresAt || 0);
  const leaseHeartbeatAt = Number(item.leaseHeartbeatAt || 0);
  if (
    leaseExpiresAt &&
    item.state === "leased" &&
    leaseHeartbeatAt &&
    item.leasePhase !== "finalizing"
  ) {
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

export function exactReviewParkedRecoveryDelayMs(item: ExactReviewQueueItem) {
  if (
    item.state !== "parked" ||
    exactReviewQueueIsPublication(item) ||
    (item.parkedReason !== "dispatch_rejected" && item.parkedReason !== "review_retry_exhausted")
  ) {
    return null;
  }
  const recoveries = exactReviewParkedRecoveryAttempts(item.parkedRecoveryAttempts);
  if (recoveries >= EXACT_REVIEW_PARKED_RECOVERY_LIMIT) return null;
  return Math.min(
    EXACT_REVIEW_PARKED_RECOVERY_MAX_MS,
    EXACT_REVIEW_PARKED_RECOVERY_BASE_MS * 2 ** recoveries,
  );
}

export function exactReviewParkedRecoveryAt(item: ExactReviewQueueItem) {
  const delay = exactReviewParkedRecoveryDelayMs(item);
  if (delay === null) return null;
  const scheduled = Number(item.parkedRecoveryAt);
  // Pre-jitter records did not persist their recovery timestamp. Preserve their
  // established ladder for one final cycle instead of resampling on every read.
  return Number.isSafeInteger(scheduled) && scheduled >= item.updatedAt
    ? scheduled
    : item.updatedAt + delay;
}

export function exactReviewParkedRecoveryAttempts(value: unknown) {
  const attempts = Number(value || 0);
  return Number.isSafeInteger(attempts) && attempts > 0 ? attempts : 0;
}

export function exactReviewParkedOperatorEligible(item: ExactReviewQueueItem) {
  return (
    item.state === "parked" &&
    !exactReviewQueueIsPublication(item) &&
    (item.parkedReason === "dispatch_rejected" || item.parkedReason === "review_retry_exhausted") &&
    exactReviewParkedRecoveryAttempts(item.parkedRecoveryAttempts) >=
      EXACT_REVIEW_PARKED_RECOVERY_LIMIT
  );
}

export function exactReviewParkedTerminalCheckAt(item: ExactReviewQueueItem) {
  if (!exactReviewParkedOperatorEligible(item) || exactReviewQueueHasCommandContext(item)) {
    return null;
  }
  return Number(item.parkedTerminalCheckedAt || 0) + EXACT_REVIEW_PARKED_TERMINAL_CHECK_INTERVAL_MS;
}

export function exactReviewParkedTerminalGlobalCheckAt(state: ExactReviewQueueState) {
  const lastCheckedAt = Object.values(state.items).reduce(
    (latest, item) => Math.max(latest, Number(item.parkedTerminalCheckedAt || 0)),
    Number(state.dispatcher?.parkedTerminalCheckedAt || 0),
  );
  return lastCheckedAt + EXACT_REVIEW_PARKED_TERMINAL_CHECK_INTERVAL_MS;
}

export function exactReviewShedSinceReset(state: Pick<ExactReviewQueueState, "shedSinceReset">) {
  const value = Number(state.shedSinceReset || 0);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export function exactReviewGithubCredentialCircuits(
  state: ExactReviewQueueState,
): ExactReviewGithubCredentialCircuit[] {
  return Object.values(state.dispatcher?.githubCredentialCircuits || {}).filter(
    (circuit) =>
      circuit &&
      (circuit.scope === "repository_actions" || circuit.scope === "target_app") &&
      Number.isFinite(circuit.retryAt),
  );
}

export function exactReviewGithubTargetAppCircuitRetryAt(
  state: ExactReviewQueueState,
  targetRepo: string,
  now: number,
) {
  const owner = targetRepo.split("/", 1)[0]?.toLowerCase();
  return exactReviewGithubCredentialCircuits(state).reduce(
    (retryAt, circuit) =>
      circuit.scope === "target_app" && circuit.targetOwner === owner && circuit.retryAt > now
        ? Math.max(retryAt, circuit.retryAt)
        : retryAt,
    0,
  );
}

export function exactReviewQueueLane(item: ExactReviewQueueItem) {
  return exactReviewQueueIsPublication(item) ? "publication" : "review";
}

// The Bay is a deliberately lightweight visual projection of durable queue
// state. Keep this representation bounded and scrubbed: it is public dashboard
// data, not a queue-inspection API. Live workers remain the authority for the
// reviewing stage; these records only make the otherwise invisible admission,
// setup, publication, and recovery phases visible. Publication is distinct
// from the publisher workflow's deterministic follow-up, which the Bay shows
// from the live worker as Applying.
const EXACT_REVIEW_BAY_SAMPLE_LIMIT = 24;
// The dashboard can retain both a terminal-buffer card and its washed card
// while their live queue retry is pending. Accept all bounded Bay candidates
// first, then apply the public sample limit only after resolving live rows.
const EXACT_REVIEW_BAY_PRIORITY_INPUT_LIMIT = 40;
const EXACT_REVIEW_BAY_ACTIVE_INPUT_LIMIT = 100;
const EXACT_REVIEW_BAY_TARGET_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const EXACT_REVIEW_BAY_ITEM_KEY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+$/;
const EXACT_REVIEW_BAY_MAX_TIMESTAMP = 8_640_000_000_000_000;
const EXACT_REVIEW_QUEUE_STATES = new Set(["pending", "dispatching", "leased", "parked"]);
const EXACT_REVIEW_BAY_STAGES = [
  "arriving",
  "setting-up",
  "reviewing",
  "publishing",
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
  legacy_batch_path: boolean;
  batch_id?: string;
  batch_created_at?: string;
};

type ExactReviewQueueLaneCensus = {
  pending: number;
  ready: number;
  backoff: number;
  dispatching: number;
  leased: number;
  parked: number;
  oldestPendingAt: number | null;
  oldestPendingKey: string | null;
  oldestReadyAt: number | null;
  oldestBackoffAt: number | null;
  nextAttemptAt: number | null;
  backoffReasons: Record<string, number>;
  parkedReasons: Record<string, number>;
};

type ExactReviewHandoffPhaseCensus = {
  count: number;
  oldestAt: number | null;
  oldestKey: string | null;
};

type ExactReviewBayCensusCandidate = {
  item: ExactReviewQueueItem;
  itemKey: string;
  repository: string;
  itemNumber: number;
  updatedAt: number;
};

type ExactReviewQueueCensus = {
  items: ExactReviewQueueItem[];
  review: ExactReviewQueueLaneCensus;
  publication: ExactReviewQueueLaneCensus;
  all: ExactReviewQueueLaneCensus;
  activeReviews: number;
  activeScheduledReviews: number;
  activePublishers: number;
  activeReviewWakeAt: number[];
  activeScheduledReviewWakeAt: number[];
  activePublisherWakeAt: number[];
  activeTargetCounts: Map<string, number>;
  activeTargetWakeAt: Map<string, number>;
  activeWithoutLeaseOrExpired: boolean;
  dispatcherAdmissionPaused: boolean;
  pendingReviews: ExactReviewQueueItem[];
  pendingPublications: ExactReviewQueueItem[];
  readyReviews: ExactReviewQueueItem[];
  readyPublications: ExactReviewQueueItem[];
  parkedWakeCandidates: Array<{ recoveryAt: number | null; terminalCheckAt: number | null }>;
  parkedTerminalLastCheckedAt: number;
  targetAppRetryAtByOwner: Map<string, number>;
  targets: Map<
    string,
    {
      target_repo: string;
      pending: number;
      dispatching: number;
      leased: number;
      parked: number;
      oldest_pending_at: number | null;
    }
  >;
  handoffItemCount: number;
  handoffPhases: Record<"pending" | "dispatching" | "leased", ExactReviewHandoffPhaseCensus>;
  reviewRecoveryReasons: Record<ExactReviewReviewRecoveryReason, number>;
  bayComplete: boolean;
  bayCandidates: Map<string, ExactReviewBayCensusCandidate[]>;
};

const EXACT_REVIEW_STATS_CENSUS = Symbol("exact-review-stats-census");

type ExactReviewQueueStatsWithCensus = ReturnType<typeof exactReviewQueueStats> & {
  [EXACT_REVIEW_STATS_CENSUS]?: ExactReviewQueueCensus;
};

export type ExactReviewBayBatchOwner = {
  batchId: string;
};

export function exactReviewQueueBayStage(
  item: ExactReviewQueueItem,
  batchByItemKey: ReadonlyMap<string, ExactReviewBayBatchOwner> = new Map(),
): ExactReviewBayStage {
  // A parked item is deliberately no longer making normal queue progress. This
  // includes bounded review-retry exhaustion, permanent dispatch rejection,
  // and a publication that needs its dead-letter/recovery path. Keep it in the
  // exception cove instead of making it look like an active setup or publisher.
  if (item.state === "parked") return "repairing";
  // The batch publisher's GitHub job is intentionally targetless. Its durable
  // batch membership is the authoritative bounded source for the individual
  // items it is currently applying, without another GitHub lookup.
  if (batchByItemKey.has(item.key)) return "applying";
  if (exactReviewQueueIsPublication(item)) return "publishing";
  if (isLowPriorityExactReviewDecision(item.decision)) return "repairing";
  return item.state === "pending" ? "arriving" : "setting-up";
}

export function exactReviewQueueBayStagePriority(stage: ExactReviewBayStage) {
  return EXACT_REVIEW_BAY_STAGES.indexOf(stage);
}

function exactReviewQueueBayItemKeys(values: string[], limit: number) {
  const unique = new Set<string>();
  for (const value of values) {
    const itemKey = String(value || "").trim();
    if (!EXACT_REVIEW_BAY_ITEM_KEY_PATTERN.test(itemKey)) continue;
    unique.add(itemKey.toLowerCase());
    if (unique.size === limit) break;
  }
  return [...unique];
}

export function exactReviewQueueBayPriorityKeys(values: string[]) {
  return exactReviewQueueBayItemKeys(values, EXACT_REVIEW_BAY_PRIORITY_INPUT_LIMIT);
}

export function exactReviewQueueBayActiveKeys(values: string[]) {
  return exactReviewQueueBayItemKeys(values, EXACT_REVIEW_BAY_ACTIVE_INPUT_LIMIT);
}

function emptyExactReviewQueueLaneCensus(): ExactReviewQueueLaneCensus {
  return {
    pending: 0,
    ready: 0,
    backoff: 0,
    dispatching: 0,
    leased: 0,
    parked: 0,
    oldestPendingAt: null,
    oldestPendingKey: null,
    oldestReadyAt: null,
    oldestBackoffAt: null,
    nextAttemptAt: null,
    backoffReasons: {},
    parkedReasons: {},
  };
}

function observeExactReviewQueueLane(
  lane: ExactReviewQueueLaneCensus,
  item: ExactReviewQueueItem,
  state: ExactReviewQueueState,
  now: number,
) {
  if (item.state === "pending") {
    lane.pending += 1;
    if (
      lane.oldestPendingAt === null ||
      item.createdAt < lane.oldestPendingAt ||
      (item.createdAt === lane.oldestPendingAt &&
        (lane.oldestPendingKey === null || item.key.localeCompare(lane.oldestPendingKey) < 0))
    ) {
      lane.oldestPendingAt = item.createdAt;
      lane.oldestPendingKey = item.key;
    }
    lane.nextAttemptAt =
      lane.nextAttemptAt === null
        ? item.nextAttemptAt
        : Math.min(lane.nextAttemptAt, item.nextAttemptAt);
    if (item.nextAttemptAt <= now) {
      lane.ready += 1;
      lane.oldestReadyAt =
        lane.oldestReadyAt === null ? item.createdAt : Math.min(lane.oldestReadyAt, item.createdAt);
    } else {
      lane.backoff += 1;
      lane.oldestBackoffAt =
        lane.oldestBackoffAt === null
          ? item.createdAt
          : Math.min(lane.oldestBackoffAt, item.createdAt);
      incrementExactReviewReason(
        lane.backoffReasons,
        exactReviewQueueBackoffReason(item, state, now),
      );
    }
    return;
  }
  if (item.state === "dispatching") {
    lane.dispatching += 1;
    return;
  }
  if (item.state === "leased") {
    lane.leased += 1;
    return;
  }
  lane.parked += 1;
  incrementExactReviewReason(lane.parkedReasons, item.parkedReason || "unknown");
}

function incrementExactReviewReason(counts: Record<string, number>, reason: string) {
  counts[reason] = (counts[reason] || 0) + 1;
}

function exactReviewQueueItemOrder(left: ExactReviewQueueItem, right: ExactReviewQueueItem) {
  return left.createdAt - right.createdAt || left.key.localeCompare(right.key);
}

function exactReviewTargetAppRetryAtByOwner(state: ExactReviewQueueState, now: number) {
  const retryAtByOwner = new Map<string, number>();
  for (const circuit of exactReviewGithubCredentialCircuits(state)) {
    const targetOwner = circuit.targetOwner;
    if (circuit.scope !== "target_app" || !targetOwner || circuit.retryAt <= now) continue;
    const current = retryAtByOwner.get(targetOwner) || 0;
    retryAtByOwner.set(targetOwner, Math.max(current, circuit.retryAt));
  }
  return retryAtByOwner;
}

function exactReviewTargetAppRetryAt(census: ExactReviewQueueCensus, targetRepo: string) {
  if (typeof targetRepo !== "string") return 0;
  const [owner] = targetRepo.split("/", 1);
  return owner ? census.targetAppRetryAtByOwner.get(owner.toLowerCase()) || 0 : 0;
}

function exactReviewQueueDecision(item: ExactReviewQueueItem) {
  const decision = item?.decision;
  return decision && typeof decision === "object" && !Array.isArray(decision) ? decision : null;
}

function exactReviewQueueStateIsValid(value: unknown): value is ExactReviewQueueItem["state"] {
  return typeof value === "string" && EXACT_REVIEW_QUEUE_STATES.has(value);
}

function exactReviewQueueTargetRepository(item: ExactReviewQueueItem) {
  const repository = exactReviewQueueDecision(item)?.targetRepo;
  return typeof repository === "string" && EXACT_REVIEW_BAY_TARGET_PATTERN.test(repository)
    ? repository
    : null;
}

function buildExactReviewQueueCensus(
  items: ExactReviewQueueItem[],
  {
    state,
    now,
    dispatchLeaseMs = DEFAULT_EXACT_REVIEW_DISPATCH_LEASE_MS,
    executionLeaseMs = DEFAULT_EXACT_REVIEW_EXECUTION_LEASE_MS,
    publicationDispatchLeaseMs = DEFAULT_EXACT_REVIEW_PUBLICATION_DISPATCH_LEASE_MS,
    heartbeatGraceMs = DEFAULT_EXACT_REVIEW_HEARTBEAT_GRACE_MS,
    excludedItemKeys = new Set<string>(),
    collectBay = true,
  }: {
    state: ExactReviewQueueState;
    now: number;
    dispatchLeaseMs?: number;
    executionLeaseMs?: number;
    publicationDispatchLeaseMs?: number;
    heartbeatGraceMs?: number;
    excludedItemKeys?: ReadonlySet<string>;
    collectBay?: boolean;
  },
): ExactReviewQueueCensus {
  const review = emptyExactReviewQueueLaneCensus();
  const publication = emptyExactReviewQueueLaneCensus();
  const all = emptyExactReviewQueueLaneCensus();
  const census: ExactReviewQueueCensus = {
    items,
    review,
    publication,
    all,
    activeReviews: 0,
    activeScheduledReviews: 0,
    activePublishers: 0,
    activeReviewWakeAt: [],
    activeScheduledReviewWakeAt: [],
    activePublisherWakeAt: [],
    activeTargetCounts: new Map(),
    activeTargetWakeAt: new Map(),
    activeWithoutLeaseOrExpired: false,
    dispatcherAdmissionPaused:
      (state.dispatcher?.state === "paused" || state.dispatcher?.state === "blocked") &&
      Number(state.dispatcher?.retryAt || 0) > now,
    pendingReviews: [],
    pendingPublications: [],
    readyReviews: [],
    readyPublications: [],
    parkedWakeCandidates: [],
    parkedTerminalLastCheckedAt: Number(state.dispatcher?.parkedTerminalCheckedAt || 0),
    targetAppRetryAtByOwner: exactReviewTargetAppRetryAtByOwner(state, now),
    targets: new Map(),
    handoffItemCount: 0,
    handoffPhases: {
      pending: { count: 0, oldestAt: null, oldestKey: null },
      dispatching: { count: 0, oldestAt: null, oldestKey: null },
      leased: { count: 0, oldestAt: null, oldestKey: null },
    },
    reviewRecoveryReasons: {
      claim_timeout: 0,
      execution_timeout: 0,
      workflow_cancelled: 0,
      workflow_failed: 0,
    },
    bayComplete: true,
    bayCandidates: new Map(),
  };

  const handoffNow = finiteExactReviewTimestamp(now, Date.now());
  const safeDispatchLeaseMs = Math.max(
    1_000,
    finiteExactReviewNumber(dispatchLeaseMs, 10 * 60_000),
  );
  const safeExecutionLeaseMs = Math.max(
    1_000,
    finiteExactReviewNumber(executionLeaseMs, 130 * 60_000),
  );

  for (const item of items) {
    const decision = exactReviewQueueDecision(item);
    const targetRepo = exactReviewQueueTargetRepository(item);
    const stateValid = exactReviewQueueStateIsValid(item.state);
    const isPublication = exactReviewQueueIsPublication(item);
    const lane = isPublication ? publication : review;
    observeExactReviewQueueLane(lane, item, state, now);
    observeExactReviewQueueLane(all, item, state, now);

    if (targetRepo !== null) {
      const target = census.targets.get(targetRepo) ?? {
        target_repo: targetRepo,
        pending: 0,
        dispatching: 0,
        leased: 0,
        parked: 0,
        oldest_pending_at: null,
      };
      if (item.state === "pending") {
        target.pending += 1;
        target.oldest_pending_at =
          target.oldest_pending_at === null
            ? item.createdAt
            : Math.min(target.oldest_pending_at, item.createdAt);
      } else if (item.state === "dispatching") {
        target.dispatching += 1;
      } else if (item.state === "leased") {
        target.leased += 1;
      } else {
        target.parked += 1;
      }
      census.targets.set(targetRepo, target);
    }
    if (
      item.state === "pending" &&
      decision &&
      targetRepo !== null &&
      !excludedItemKeys.has(item.key) &&
      stateValid
    ) {
      const pendingItems = isPublication ? census.pendingPublications : census.pendingReviews;
      pendingItems.push(item);
      if (item.nextAttemptAt <= now) {
        const readyItems = isPublication ? census.readyPublications : census.readyReviews;
        readyItems.push(item);
      }
    }
    if (item.state === "parked" && decision) {
      census.parkedWakeCandidates.push({
        recoveryAt: exactReviewParkedRecoveryAt(item),
        terminalCheckAt: exactReviewParkedTerminalCheckAt(item),
      });
    }
    census.parkedTerminalLastCheckedAt = Math.max(
      census.parkedTerminalLastCheckedAt,
      Number(item.parkedTerminalCheckedAt || 0),
    );

    if (item.state === "dispatching" || item.state === "leased") {
      const leaseExpiresAt = exactReviewEffectiveLeaseExpiresAt(
        item,
        publicationDispatchLeaseMs,
        heartbeatGraceMs,
      );
      if (!item.leaseExpiresAt || leaseExpiresAt <= now) census.activeWithoutLeaseOrExpired = true;
      if (isPublication) {
        census.activePublishers += 1;
        if (leaseExpiresAt && leaseExpiresAt > now) {
          census.activePublisherWakeAt.push(leaseExpiresAt);
        }
      } else {
        census.activeReviews += 1;
        if (leaseExpiresAt && leaseExpiresAt > now) census.activeReviewWakeAt.push(leaseExpiresAt);
        // A superseding request does not change the running lease's budget owner.
        const ownerDecision = item.leaseDecision ?? decision;
        if (ownerDecision && exactReviewScheduledLane(ownerDecision)) {
          census.activeScheduledReviews += 1;
          if (leaseExpiresAt && leaseExpiresAt > now) {
            census.activeScheduledReviewWakeAt.push(leaseExpiresAt);
          }
        }
        if (targetRepo !== null) {
          const targetCount = census.activeTargetCounts.get(targetRepo) || 0;
          census.activeTargetCounts.set(targetRepo, targetCount + 1);
        }
        if (targetRepo !== null && leaseExpiresAt > now) {
          const targetWakeAt = census.activeTargetWakeAt.get(targetRepo);
          census.activeTargetWakeAt.set(
            targetRepo,
            targetWakeAt === undefined ? leaseExpiresAt : Math.min(targetWakeAt, leaseExpiresAt),
          );
        }
      }
    }

    if (!isPublication && stateValid && item.state !== "parked") {
      census.handoffItemCount += 1;
      const recoveryReason = String(item.reviewRecoveryReason || "");
      if (recoveryReason in census.reviewRecoveryReasons) {
        census.reviewRecoveryReasons[recoveryReason as ExactReviewReviewRecoveryReason] += 1;
      }
      const phase = census.handoffPhases[item.state];
      const startedAt = exactReviewHandoffPhaseStartedAt(
        item,
        handoffNow,
        safeDispatchLeaseMs,
        safeExecutionLeaseMs,
      );
      const key = item.key?.trim() || null;
      phase.count += 1;
      if (
        phase.oldestAt === null ||
        startedAt < phase.oldestAt ||
        (startedAt === phase.oldestAt &&
          key !== null &&
          (phase.oldestKey === null || key < phase.oldestKey))
      ) {
        phase.oldestAt = startedAt;
        phase.oldestKey = key;
      }
    }

    if (collectBay && !observeExactReviewBayCandidate(census.bayCandidates, item)) {
      census.bayComplete = false;
    }
  }

  census.pendingReviews.sort(exactReviewQueueItemOrder);
  census.pendingPublications.sort(exactReviewQueueItemOrder);
  census.readyReviews.sort(exactReviewQueueItemOrder);
  census.readyPublications.sort(exactReviewQueueItemOrder);
  return census;
}

function observeExactReviewBayCandidate(
  projected: Map<string, ExactReviewBayCensusCandidate[]>,
  item: ExactReviewQueueItem,
) {
  const decision = exactReviewQueueDecision(item);
  const repository = decision?.targetRepo;
  const itemNumber = decision?.itemNumber;
  if (
    !decision ||
    !exactReviewQueueStateIsValid(item.state) ||
    typeof repository !== "string" ||
    !EXACT_REVIEW_BAY_TARGET_PATTERN.test(repository) ||
    typeof itemNumber !== "number" ||
    !Number.isSafeInteger(itemNumber) ||
    itemNumber <= 0 ||
    !exactReviewQueueBayTimestamp(item.createdAt) ||
    !exactReviewQueueBayTimestamp(item.updatedAt) ||
    !exactReviewQueueBayTimestamp(item.nextAttemptAt)
  ) {
    return false;
  }
  const canonicalRepository = repository.toLowerCase();
  const itemKey = `${canonicalRepository}#${itemNumber}`;
  const updatedAt = item.updatedAt;
  const candidate = {
    item,
    itemKey,
    repository: canonicalRepository,
    itemNumber,
    updatedAt,
  };
  const previous = projected.get(itemKey);
  if (!previous) {
    projected.set(itemKey, [candidate]);
    return true;
  }
  const legacyBatchPath = exactReviewQueueUsesLegacyBatchPath(item);
  const samePath = previous.filter(
    (existing) => exactReviewQueueUsesLegacyBatchPath(existing.item) === legacyBatchPath,
  );
  const latest = samePath[0];
  if (!latest) {
    previous.push(candidate);
  } else if (updatedAt > latest.updatedAt) {
    projected.set(itemKey, [
      ...previous.filter(
        (existing) => exactReviewQueueUsesLegacyBatchPath(existing.item) !== legacyBatchPath,
      ),
      candidate,
    ]);
  } else if (updatedAt === latest.updatedAt) {
    previous.push(candidate);
  }
  return true;
}

function exactReviewQueueBayTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= EXACT_REVIEW_BAY_MAX_TIMESTAMP
  );
}

export function exactReviewQueueBayProjection(
  items: ExactReviewQueueItem[],
  priorityItemKeys: string[] = [],
  batchByItemKey: ReadonlyMap<string, ExactReviewBayBatchOwner> = new Map(),
  activeItemKeys: string[] = [],
  activeLegacyItemKeys: string[] = [],
) {
  const census = buildExactReviewQueueCensus(items, {
    state: { items: {} },
    now: 0,
  });
  return exactReviewQueueBayProjectionFromCensus(
    census,
    priorityItemKeys,
    batchByItemKey,
    activeItemKeys,
    activeLegacyItemKeys,
  );
}

function exactReviewQueueBayProjectionFromCensus(
  census: ExactReviewQueueCensus,
  priorityItemKeys: string[] = [],
  batchByItemKey: ReadonlyMap<string, ExactReviewBayBatchOwner> = new Map(),
  activeItemKeys: string[] = [],
  activeLegacyItemKeys: string[] = [],
) {
  if (!census.bayComplete) {
    return {
      complete: false as const,
      sample_limit: EXACT_REVIEW_BAY_SAMPLE_LIMIT,
      total: null,
      stages: null,
      legacy_batch_stages: null,
      active_overlaps: null,
      legacy_batch_active_overlaps: null,
      items: [],
    };
  }
  const projected = new Map<string, ExactReviewBayProjectionItem>();
  const stages = Object.fromEntries(EXACT_REVIEW_BAY_STAGES.map((stage) => [stage, 0])) as Record<
    ExactReviewBayStage,
    number
  >;
  const legacyBatchStages = Object.fromEntries(
    EXACT_REVIEW_BAY_STAGES.map((stage) => [stage, 0]),
  ) as Record<ExactReviewBayStage, number>;
  const rowsByStage: Record<ExactReviewBayStage, ExactReviewBayProjectionItem[]> = {
    arriving: [],
    "setting-up": [],
    reviewing: [],
    publishing: [],
    applying: [],
    repairing: [],
  };
  for (const candidates of census.bayCandidates.values()) {
    const directCandidates = candidates.filter(
      (candidate) => !exactReviewQueueUsesLegacyBatchPath(candidate.item),
    );
    const [first, ...remaining] = directCandidates.length > 0 ? directCandidates : candidates;
    if (!first) continue;
    let selected = first;
    let selectedStage = exactReviewQueueBayStage(selected.item, batchByItemKey);
    for (const candidate of remaining) {
      const stage = exactReviewQueueBayStage(candidate.item, batchByItemKey);
      if (
        exactReviewQueueBayStagePriority(stage) > exactReviewQueueBayStagePriority(selectedStage)
      ) {
        selected = candidate;
        selectedStage = stage;
      }
    }
    const batch = batchByItemKey.get(selected.item.key);
    const row: ExactReviewBayProjectionItem = {
      item_key: selected.itemKey,
      repository: selected.repository,
      item_number: selected.itemNumber,
      stage: selectedStage,
      queue_state: selected.item.state,
      created_at: new Date(selected.item.createdAt).toISOString(),
      updated_at: new Date(selected.item.updatedAt).toISOString(),
      next_attempt_at: new Date(selected.item.nextAttemptAt).toISOString(),
      legacy_batch_path: exactReviewQueueUsesLegacyBatchPath(selected.item),
      ...(batch ? { batch_id: batch.batchId } : {}),
    };
    projected.set(row.item_key, row);
    stages[row.stage] += 1;
    if (row.legacy_batch_path) legacyBatchStages[row.stage] += 1;
    rowsByStage[row.stage].push(row);
  }
  for (const stage of EXACT_REVIEW_BAY_STAGES) {
    rowsByStage[stage].sort(
      (left, right) =>
        Date.parse(left.created_at) - Date.parse(right.created_at) ||
        left.item_key.localeCompare(right.item_key),
    );
  }
  const activeOverlaps = Object.fromEntries(
    EXACT_REVIEW_BAY_STAGES.map((stage) => [stage, 0]),
  ) as Record<ExactReviewBayStage, number>;
  const legacyBatchActiveOverlaps = Object.fromEntries(
    EXACT_REVIEW_BAY_STAGES.map((stage) => [stage, 0]),
  ) as Record<ExactReviewBayStage, number>;
  for (const [itemKeys, legacyBatchPath] of [
    [activeItemKeys, false],
    [activeLegacyItemKeys, true],
  ] as const) {
    for (const itemKey of exactReviewQueueBayActiveKeys(itemKeys)) {
      const item = projected.get(itemKey);
      if (item && item.legacy_batch_path === legacyBatchPath) {
        activeOverlaps[item.stage] += 1;
        if (legacyBatchPath) legacyBatchActiveOverlaps[item.stage] += 1;
      }
    }
  }
  const priorityRows = exactReviewQueueBayPriorityKeys(priorityItemKeys)
    .map((itemKey) => projected.get(itemKey))
    .filter((item): item is ExactReviewBayProjectionItem => Boolean(item));
  const sampledKeys = new Set<string>();
  const sample: ExactReviewBayProjectionItem[] = [];
  const append = (item: ExactReviewBayProjectionItem | undefined, legacyBatchPath: boolean) => {
    if (
      !item ||
      item.legacy_batch_path !== legacyBatchPath ||
      sampledKeys.has(item.item_key) ||
      sample.length >= EXACT_REVIEW_BAY_SAMPLE_LIMIT
    ) {
      return;
    }
    sampledKeys.add(item.item_key);
    sample.push(item);
  };
  // The default Bay view hides legacy proof/batch journeys. Sample every
  // available normal direct journey before legacy rows so hidden records
  // cannot consume the bounded public-reference budget.
  for (const legacyBatchPath of [false, true]) {
    const categoryRowsByStage = Object.fromEntries(
      EXACT_REVIEW_BAY_STAGES.map((stage) => [
        stage,
        rowsByStage[stage].filter((item) => item.legacy_batch_path === legacyBatchPath),
      ]),
    ) as Record<ExactReviewBayStage, ExactReviewBayProjectionItem[]>;
    const longestCategoryStage = Math.max(
      ...EXACT_REVIEW_BAY_STAGES.map((stage) => categoryRowsByStage[stage].length),
    );
    for (const item of priorityRows) append(item, legacyBatchPath);
    for (
      let index = 0;
      sample.length < EXACT_REVIEW_BAY_SAMPLE_LIMIT && index < longestCategoryStage;
      index += 1
    ) {
      for (const stage of EXACT_REVIEW_BAY_STAGES) {
        append(categoryRowsByStage[stage][index], legacyBatchPath);
        if (sample.length === EXACT_REVIEW_BAY_SAMPLE_LIMIT) break;
      }
    }
  }
  return {
    complete: true as const,
    sample_limit: EXACT_REVIEW_BAY_SAMPLE_LIMIT,
    total: projected.size,
    stages,
    legacy_batch_stages: legacyBatchStages,
    active_overlaps: activeOverlaps,
    legacy_batch_active_overlaps: legacyBatchActiveOverlaps,
    items: sample,
  };
}

export function exactReviewQueueActiveReviewCount(state: ExactReviewQueueState) {
  return exactReviewQueueActiveCounts(state).review;
}

export function exactReviewQueueActivePublicationCount(state: ExactReviewQueueState) {
  return exactReviewQueueActiveCounts(state).publication;
}

function exactReviewQueueActiveCounts(state: ExactReviewQueueState) {
  let review = 0;
  let publication = 0;
  for (const item of Object.values(state.items)) {
    if (item.state !== "dispatching" && item.state !== "leased") continue;
    if (exactReviewQueueIsPublication(item)) publication += 1;
    else review += 1;
  }
  return { review, publication };
}

export function exactReviewPrioritizePublicationItems(
  items: ExactReviewQueueItem[],
  freshItemKeys: ReadonlySet<string>,
  freshReserve: number,
) {
  if (!freshReserve || !freshItemKeys.size) return items;
  const fresh: ExactReviewQueueItem[] = [];
  const historical: ExactReviewQueueItem[] = [];
  for (const item of items) {
    (freshItemKeys.has(item.key) ? fresh : historical).push(item);
  }
  if (!fresh.length) return items;
  if (!historical.length) return items;
  const reservedFresh = fresh.slice(0, freshReserve);
  return [...reservedFresh, ...historical, ...fresh.slice(reservedFresh.length)];
}

export function exactReviewQueueAdmittedItems(
  state: ExactReviewQueueState,
  now: number,
  capacity: number,
  targetCapacity: number,
  publicationCapacity: number,
  excludedItemKeys: ReadonlySet<string> = new Set(),
  publicationAdmissionBlocked = false,
  uniquePublicationItems = false,
  freshPublicationItemKeys: ReadonlySet<string> = new Set(),
  freshPublicationReserve = 0,
  scheduledCapacity = Number.POSITIVE_INFINITY,
) {
  const dispatcherRetryAt = Number(state.dispatcher?.retryAt || 0);
  if (
    (state.dispatcher?.state === "paused" || state.dispatcher?.state === "blocked") &&
    dispatcherRetryAt > now
  ) {
    return [];
  }
  const census = buildExactReviewQueueCensus(Object.values(state.items), {
    state,
    now,
    excludedItemKeys,
    collectBay: false,
  });
  return exactReviewQueueAdmittedItemsFromCensus(
    census,
    now,
    capacity,
    targetCapacity,
    publicationCapacity,
    publicationAdmissionBlocked,
    uniquePublicationItems,
    freshPublicationItemKeys,
    freshPublicationReserve,
    scheduledCapacity,
  );
}

function exactReviewQueueAdmittedItemsFromCensus(
  census: ExactReviewQueueCensus,
  now: number,
  capacity: number,
  targetCapacity: number,
  publicationCapacity: number,
  publicationAdmissionBlocked: boolean,
  uniquePublicationItems: boolean,
  freshPublicationItemKeys: ReadonlySet<string>,
  freshPublicationReserve: number,
  scheduledCapacity: number,
) {
  if (census.dispatcherAdmissionPaused) return [];
  const reviewSlots = Math.max(0, capacity - census.activeReviews);
  const activeTargets = new Map(census.activeTargetCounts);
  let activePublishers = census.activePublishers;
  const pendingPublications = exactReviewPrioritizePublicationItems(
    census.readyPublications,
    freshPublicationItemKeys,
    freshPublicationReserve,
  );
  const admittedReviews: ExactReviewQueueItem[] = [];
  let activeScheduledReviews = census.activeScheduledReviews;
  for (const item of census.readyReviews) {
    if (admittedReviews.length >= reviewSlots) break;
    const scheduled = exactReviewScheduledLane(item.decision) !== null;
    if (scheduled && activeScheduledReviews >= scheduledCapacity) continue;
    const target = item.decision.targetRepo;
    if (exactReviewTargetAppRetryAt(census, target) > now) continue;
    const active = activeTargets.get(target) || 0;
    if (active >= targetCapacity) continue;
    activeTargets.set(target, active + 1);
    if (scheduled) activeScheduledReviews += 1;
    admittedReviews.push(item);
  }

  const admittedPublications: ExactReviewQueueItem[] = [];
  const admittedPublicationItems = new Set<string>();
  for (const item of pendingPublications) {
    // Batching owns publication work, but a committed terminal driver owns no
    // publication. It must use the normal dispatcher to reach the dedicated
    // fenced acknowledgement finalizer.
    if (
      publicationAdmissionBlocked &&
      !item.terminalFinalization &&
      exactReviewQueueIsBatchablePublication(item)
    ) {
      continue;
    }
    if (activePublishers >= publicationCapacity) break;
    // Distinct publication events may target the same durable record path. A batch
    // must serialize those events across commits or their prepared mutations can
    // disagree even though their queue keys and fencing revisions are independent.
    const publicationItem = uniquePublicationItems
      ? `${item.decision.targetRepo.toLowerCase()}#${item.decision.itemNumber}`
      : "";
    if (uniquePublicationItems && admittedPublicationItems.has(publicationItem)) continue;
    activePublishers += 1;
    if (uniquePublicationItems) admittedPublicationItems.add(publicationItem);
    admittedPublications.push(item);
  }

  // Review admission owns its capacity and is intentionally ordered first.
  // A blocked or slow publication key cannot delay an available review slot.
  return [...admittedReviews, ...admittedPublications];
}

export function sumFor(rows: Array<Record<string, number | string | null>>, field: string) {
  return rows.reduce(
    (total, row) => total + (typeof row[field] === "number" ? Number(row[field]) : 0),
    0,
  );
}

export function percentileFor(rows: Array<Record<string, number | string | null>>, field: string) {
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

export function exactReviewQueueStats(
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
  scheduledCapacity = Number.POSITIVE_INFINITY,
) {
  const items = Object.values(state.items);
  const census = buildExactReviewQueueCensus(items, {
    state,
    now,
    dispatchLeaseMs,
    executionLeaseMs,
    publicationDispatchLeaseMs,
    heartbeatGraceMs,
    excludedItemKeys,
  });
  const safeNow = finiteExactReviewTimestamp(now, Date.now());
  const handoffHealth = projectExactReviewHandoff({
    itemCount: census.handoffItemCount,
    phaseCensus: census.handoffPhases,
    recoveryReasons: census.reviewRecoveryReasons,
    dispatcher: state.dispatcher,
    now: safeNow,
    capacity,
    dispatchLeaseMs,
    shedSinceReset: exactReviewShedSinceReset(state),
  });
  const targetStats = [...census.targets.values()]
    .map((target) => ({
      target_repo: target.target_repo,
      pending: target.pending,
      dispatching: target.dispatching,
      leased: target.leased,
      oldest_pending_at:
        target.oldest_pending_at === null
          ? null
          : exactReviewQueueIsoTimestamp(target.oldest_pending_at),
    }))
    .sort(
      (left, right) =>
        right.pending - left.pending ||
        right.dispatching + right.leased - (left.dispatching + left.leased) ||
        left.target_repo.localeCompare(right.target_repo),
    );
  const nextWakeAt = exactReviewQueueNextWakeAtFromCensus(
    census,
    state,
    now,
    capacity,
    targetCapacity,
    publicationCapacity,
    publicationBlockedUntil,
    Number(state.dispatcher?.reviewAdmissionNextAt || 0) > now
      ? Number(state.dispatcher?.reviewAdmissionNextAt)
      : null,
    scheduledCapacity,
  );
  const lanes = {
    review: exactReviewQueueLaneStatsFromCensus(
      census.review,
      now,
      capacity,
      exactReviewShedSinceReset(state),
    ),
    publication: exactReviewQueueLaneStatsFromCensus(
      census.publication,
      now,
      publicationCapacity,
      0,
    ),
  };
  const admissibleItems = exactReviewQueueAdmittedItemsFromCensus(
    census,
    now,
    Number.MAX_SAFE_INTEGER,
    targetCapacity,
    publicationCapacity,
    publicationBlockedUntil !== null && publicationBlockedUntil > now,
    false,
    new Set(),
    0,
    scheduledCapacity,
  );
  let reviewAdmissiblePending = 0;
  for (const item of admissibleItems) {
    if (!exactReviewQueueIsPublication(item)) reviewAdmissiblePending += 1;
  }
  const pressure = summarizeExactReviewPressure({
    pending: lanes.review.pending,
    readyPending: lanes.review.ready,
    admissiblePending: reviewAdmissiblePending,
    dispatching: lanes.review.dispatching,
    leased: lanes.review.leased,
    capacity: lanes.review.capacity,
    ...(state.dispatcher?.state ? { dispatcherState: state.dispatcher.state } : {}),
    ...(handoffHealth.status ? { handoffStatus: handoffHealth.status } : {}),
  });
  const stats = {
    generated_at: handoffHealth.observed_at,
    ...(Number.isFinite(scheduledCapacity)
      ? {
          scheduled_feed: {
            max_concurrent: scheduledCapacity,
            active: census.activeScheduledReviews,
          },
        }
      : {}),
    pending: lanes.review.pending,
    ready_pending: lanes.review.ready,
    admissible_pending: reviewAdmissiblePending,
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
    bay_projection: undefined as unknown as ReturnType<
      typeof exactReviewQueueBayProjectionFromCensus
    >,
    next_wake_at: nextWakeAt === null ? null : exactReviewQueueIsoTimestamp(nextWakeAt),
    dispatcher: {
      state: state.dispatcher?.state || "unknown",
      reason: state.dispatcher?.reason || null,
      workflow_state: state.dispatcher?.workflowState || null,
      checked_at: state.dispatcher?.checkedAt
        ? new Date(state.dispatcher.checkedAt).toISOString()
        : null,
      retry_at: state.dispatcher?.retryAt ? new Date(state.dispatcher.retryAt).toISOString() : null,
      dispatch_failure_status: state.dispatcher?.dispatchFailureStatus ?? null,
      dispatch_failure_class: state.dispatcher?.dispatchFailureClass || null,
      dispatch_failure_at: state.dispatcher?.dispatchFailureAt
        ? new Date(state.dispatcher.dispatchFailureAt).toISOString()
        : null,
      dispatch_failure_fingerprint: state.dispatcher?.dispatchFailureFingerprint || null,
      dispatch_failure_detail: exactReviewDispatchFailureDetailJson(
        state.dispatcher?.dispatchFailureDetail,
      ),
      dispatch_consecutive_failures: state.dispatcher?.dispatchConsecutiveFailures || 0,
    },
    target_stats: targetStats,
  };
  let bayProjection: ReturnType<typeof exactReviewQueueBayProjectionFromCensus> | undefined;
  Object.defineProperty(stats, "bay_projection", {
    enumerable: true,
    configurable: true,
    get() {
      bayProjection ??= exactReviewQueueBayProjectionFromCensus(census);
      return bayProjection;
    },
  });
  Object.defineProperty(stats, EXACT_REVIEW_STATS_CENSUS, { value: census });
  return stats;
}

export function exactReviewQueueBayProjectionFromStats(
  stats: ExactReviewQueueStatsWithCensus,
  priorityItemKeys: string[] = [],
  batchByItemKey: ReadonlyMap<string, ExactReviewBayBatchOwner> = new Map(),
  activeItemKeys: string[] = [],
  activeLegacyItemKeys: string[] = [],
) {
  const census = stats[EXACT_REVIEW_STATS_CENSUS];
  if (!census) throw new Error("exact-review queue stats are missing their census");
  const projection = exactReviewQueueBayProjectionFromCensus(
    census,
    priorityItemKeys,
    batchByItemKey,
    activeItemKeys,
    activeLegacyItemKeys,
  );
  Object.defineProperty(stats, "bay_projection", {
    value: projection,
    enumerable: true,
    configurable: true,
  });
  return projection;
}

export function exactReviewQueueLaneStats(
  items: ExactReviewQueueItem[],
  now: number,
  capacity: number,
  shedSinceReset = 0,
  state: ExactReviewQueueState = { items: {} },
) {
  const census = buildExactReviewQueueCensus(items, { state, now, collectBay: false });
  return exactReviewQueueLaneStatsFromCensus(census.all, now, capacity, shedSinceReset);
}

function exactReviewQueueLaneStatsFromCensus(
  lane: ExactReviewQueueLaneCensus,
  now: number,
  capacity: number,
  shedSinceReset = 0,
) {
  const active = lane.dispatching + lane.leased;
  return {
    pending: lane.pending,
    pending_depth: lane.pending,
    shed_since_reset: shedSinceReset,
    ready: lane.ready,
    backoff: lane.backoff,
    backoff_reasons: lane.backoffReasons,
    dispatching: lane.dispatching,
    leased: lane.leased,
    parked: lane.parked,
    parked_reasons: lane.parkedReasons,
    capacity,
    active,
    available_slots: Math.max(0, capacity - active),
    oldest_pending_at:
      lane.oldestPendingAt === null ? null : exactReviewQueueIsoTimestamp(lane.oldestPendingAt),
    oldest_pending_age_seconds:
      lane.oldestPendingAt === null
        ? null
        : Math.max(0, Math.floor((now - lane.oldestPendingAt) / 1_000)),
    oldest_pending_key: lane.oldestPendingKey,
    oldest_ready_at:
      lane.oldestReadyAt === null ? null : exactReviewQueueIsoTimestamp(lane.oldestReadyAt),
    oldest_ready_age_seconds:
      lane.oldestReadyAt === null
        ? null
        : Math.max(0, Math.floor((now - lane.oldestReadyAt) / 1_000)),
    oldest_backoff_at:
      lane.oldestBackoffAt === null ? null : exactReviewQueueIsoTimestamp(lane.oldestBackoffAt),
    oldest_backoff_age_seconds:
      lane.oldestBackoffAt === null
        ? null
        : Math.max(0, Math.floor((now - lane.oldestBackoffAt) / 1_000)),
    next_attempt_at:
      lane.nextAttemptAt === null ? null : exactReviewQueueIsoTimestamp(lane.nextAttemptAt),
  };
}

export function exactReviewQueueBackoffReason(
  item: ExactReviewQueueItem,
  state: ExactReviewQueueState,
  now: number,
) {
  if (item.backoffReason) return item.backoffReason;
  if (item.publicationFailureAttempts || (exactReviewQueueIsPublication(item) && item.attempts)) {
    return "publication_retry";
  }
  if (item.reviewFailureAttempts || item.attempts) return "retry_backoff";
  const retryAt = Number(state.dispatcher?.retryAt || 0);
  if (
    (state.dispatcher?.state === "paused" || state.dispatcher?.state === "blocked") &&
    retryAt > now &&
    item.nextAttemptAt >= retryAt
  ) {
    return "dispatcher_backoff";
  }
  return "dispatch_debounce";
}

export function exactReviewQueueReasonCounts(reasons: string[]) {
  return reasons.reduce<Record<string, number>>((counts, reason) => {
    counts[reason] = (counts[reason] || 0) + 1;
    return counts;
  }, {});
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
  reviewAdmissionBlockedUntil: number | null = null,
  scheduledCapacity = Number.POSITIVE_INFINITY,
) {
  const items = Object.values(state.items);
  const census = buildExactReviewQueueCensus(items, {
    state,
    now,
    publicationDispatchLeaseMs,
    heartbeatGraceMs,
    excludedItemKeys,
    collectBay: false,
  });
  return exactReviewQueueNextWakeAtFromCensus(
    census,
    state,
    now,
    capacity,
    targetCapacity,
    publicationCapacity,
    publicationBlockedUntil,
    reviewAdmissionBlockedUntil,
    scheduledCapacity,
  );
}

function exactReviewQueueNextWakeAtFromCensus(
  census: ExactReviewQueueCensus,
  state: ExactReviewQueueState,
  now: number,
  capacity: number,
  targetCapacity: number,
  publicationCapacity: number,
  publicationBlockedUntil: number | null,
  reviewAdmissionBlockedUntil: number | null,
  scheduledCapacity: number,
) {
  if (!census.items.length) return null;
  const dispatcherRetryAt = Number(state.dispatcher?.retryAt || 0);
  if (census.activeWithoutLeaseOrExpired) return now + 1_000;
  let earliest: number | null = null;
  const include = (candidate: number) => {
    earliest = earliest === null ? candidate : Math.min(earliest, candidate);
  };

  if (census.dispatcherAdmissionPaused) {
    if (census.pendingReviews.length || census.pendingPublications.length)
      include(dispatcherRetryAt);
  } else {
    let publicationCapacityWakeAt: number | null = null;
    if (census.activePublishers >= publicationCapacity) {
      const capacityWakeAt =
        publicationCapacity <= 0
          ? [...census.activePublisherWakeAt, ...census.activeReviewWakeAt]
          : census.activePublisherWakeAt;
      publicationCapacityWakeAt = capacityWakeAt.length
        ? Math.min(...capacityWakeAt)
        : now + DEFAULT_EXACT_REVIEW_RETRY_MS;
    }
    for (const item of census.pendingPublications) {
      if (publicationBlockedUntil !== null && publicationBlockedUntil > now) {
        include(Math.max(item.nextAttemptAt, publicationBlockedUntil));
      } else {
        include(
          Math.max(
            item.nextAttemptAt,
            publicationCapacityWakeAt === null ? item.nextAttemptAt : publicationCapacityWakeAt,
          ),
        );
      }
    }

    const reviewCapacityWakeAt =
      census.activeReviews >= capacity && census.activeReviewWakeAt.length
        ? Math.min(...census.activeReviewWakeAt)
        : null;
    const scheduledCapacityWakeAt =
      census.activeScheduledReviews >= scheduledCapacity &&
      census.activeScheduledReviewWakeAt.length
        ? Math.min(...census.activeScheduledReviewWakeAt)
        : null;
    for (const item of census.pendingReviews) {
      const target = item.decision.targetRepo;
      const targetCapacityWakeAt =
        (census.activeTargetCounts.get(target) || 0) >= targetCapacity &&
        census.activeTargetWakeAt.has(target)
          ? (census.activeTargetWakeAt.get(target) as number)
          : null;
      const capacityWakeAt =
        reviewCapacityWakeAt === null
          ? targetCapacityWakeAt
          : targetCapacityWakeAt === null
            ? reviewCapacityWakeAt
            : Math.min(reviewCapacityWakeAt, targetCapacityWakeAt);
      include(
        Math.max(
          item.nextAttemptAt,
          reviewAdmissionBlockedUntil ?? item.nextAttemptAt,
          exactReviewTargetAppRetryAt(census, target),
          capacityWakeAt ?? item.nextAttemptAt,
          exactReviewScheduledLane(item.decision) !== null
            ? (scheduledCapacityWakeAt ?? item.nextAttemptAt)
            : item.nextAttemptAt,
        ),
      );
    }
  }

  const parkedTerminalGlobalCheckAt =
    census.parkedTerminalLastCheckedAt + EXACT_REVIEW_PARKED_TERMINAL_CHECK_INTERVAL_MS;
  for (const candidate of census.parkedWakeCandidates) {
    if (candidate.recoveryAt !== null) include(candidate.recoveryAt);
    if (candidate.terminalCheckAt !== null) {
      include(
        Math.max(
          candidate.terminalCheckAt,
          parkedTerminalGlobalCheckAt,
          census.dispatcherAdmissionPaused ? dispatcherRetryAt : 0,
        ),
      );
    }
  }
  for (const candidate of census.activeReviewWakeAt) include(candidate);
  for (const candidate of census.activePublisherWakeAt) include(candidate);
  return earliest === null ? null : Math.max(now + 1_000, earliest);
}

function exactReviewHandoffPhaseStartedAt(
  item: ExactReviewQueueItem,
  now: number,
  dispatchLeaseMs: number,
  executionLeaseMs: number,
) {
  if (item.state === "dispatching") {
    const dispatchedAt = validExactReviewTimestamp(item.dispatchedAt);
    const leaseExpiresAt = validExactReviewTimestamp(item.leaseExpiresAt);
    const leaseStartedAt =
      leaseExpiresAt === null ? null : timestampAtOrBefore(leaseExpiresAt - dispatchLeaseMs, now);
    return newestExactReviewTimestamp(dispatchedAt, leaseStartedAt) ?? now;
  }
  if (item.state === "leased") {
    const claimedAt = validExactReviewTimestamp(item.claimedAt);
    const leaseExpiresAt = validExactReviewTimestamp(item.leaseExpiresAt);
    const leaseStartedAt =
      leaseExpiresAt === null ? null : validExactReviewTimestamp(leaseExpiresAt - executionLeaseMs);
    return newestExactReviewTimestamp(claimedAt, leaseStartedAt) ?? now;
  }
  return finiteExactReviewTimestamp(
    item.createdAt,
    finiteExactReviewTimestamp(item.updatedAt, now),
  );
}

function newestExactReviewTimestamp(...values: Array<number | null>) {
  let newest: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    newest = newest === null ? value : Math.max(newest, value);
  }
  return newest;
}

function validExactReviewTimestamp(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= 8_640_000_000_000_000 ? number : null;
}

function timestampAtOrBefore(value: unknown, maximum: number): number | null {
  const timestamp = validExactReviewTimestamp(value);
  return timestamp !== null && timestamp <= maximum ? timestamp : null;
}

function finiteExactReviewTimestamp(value: unknown, fallback: number) {
  return validExactReviewTimestamp(value) ?? fallback;
}

function exactReviewQueueIsoTimestamp(value: unknown) {
  const timestamp = validExactReviewTimestamp(value);
  return timestamp === null ? null : new Date(timestamp).toISOString();
}

function finiteExactReviewNumber(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function exactReviewQueueCapacity(
  env: Record<string, unknown>,
  DEFAULT_EXACT_REVIEW_ACTIONS_BUDGET: number,
) {
  return Math.max(
    1,
    Math.min(
      numberFrom(env.EXACT_REVIEW_ACTIONS_BUDGET, DEFAULT_EXACT_REVIEW_ACTIONS_BUDGET),
      numberFrom(env.EXACT_REVIEW_QUEUE_MAX_CONCURRENT, DEFAULT_EXACT_REVIEW_QUEUE_MAX_CONCURRENT),
    ),
  );
}
