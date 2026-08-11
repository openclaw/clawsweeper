import {
  summarizeExactReviewHandoff,
  summarizeExactReviewPressure,
} from "./exact-review-health.ts";
import {
  exactReviewQueueHasCommandContext,
  exactReviewQueueIsBatchablePublication,
  exactReviewQueueIsPublication,
  isLowPriorityExactReviewDecision,
} from "./exact-review-decision.ts";
import { numberFrom } from "./exact-review-queue-shared.ts";
import type {
  ExactReviewDispatchFailureDetail,
  ExactReviewGithubCredentialCircuit,
  ExactReviewQueueItem,
  ExactReviewQueueState,
} from "./exact-review-queue.ts";

const DEFAULT_EXACT_REVIEW_QUEUE_MAX_CONCURRENT = 128;
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
  batch_id?: string;
  batch_created_at?: string;
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

export function exactReviewQueueBayPriorityKeys(values: string[]) {
  const unique = new Set<string>();
  for (const value of values) {
    const itemKey = String(value || "").trim();
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+$/.test(itemKey)) continue;
    unique.add(itemKey);
    if (unique.size === EXACT_REVIEW_BAY_PRIORITY_INPUT_LIMIT) break;
  }
  return [...unique];
}

export function exactReviewQueueBayProjection(
  items: ExactReviewQueueItem[],
  priorityItemKeys: string[] = [],
  batchByItemKey: ReadonlyMap<string, ExactReviewBayBatchOwner> = new Map(),
) {
  const projected = new Map<string, ExactReviewBayProjectionItem>();
  for (const item of items) {
    // Parked records are not terminal outcomes: they remain bounded durable
    // queue work that needs recovery. Keep their already-scrubbed identity in
    // the projection so Bay shows the exception rather than a false empty lane.
    const repository = String(item.decision.targetRepo || "").trim();
    const itemNumber = Number(item.decision.itemNumber);
    if (!repository || !Number.isSafeInteger(itemNumber) || itemNumber <= 0) continue;
    const batch = batchByItemKey.get(item.key);
    const candidate: ExactReviewBayProjectionItem = {
      item_key: `${repository}#${itemNumber}`,
      repository,
      item_number: itemNumber,
      stage: exactReviewQueueBayStage(item, batchByItemKey),
      queue_state: item.state,
      created_at: new Date(item.createdAt).toISOString(),
      updated_at: new Date(item.updatedAt).toISOString(),
      next_attempt_at: new Date(item.nextAttemptAt).toISOString(),
      ...(batch
        ? {
            batch_id: batch.batchId,
          }
        : {}),
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

export function exactReviewQueueActiveReviewCount(state: ExactReviewQueueState) {
  return Object.values(state.items).filter(
    (item) =>
      !exactReviewQueueIsPublication(item) &&
      (item.state === "dispatching" || item.state === "leased"),
  ).length;
}

export function exactReviewQueueActivePublicationCount(state: ExactReviewQueueState) {
  return Object.values(state.items).filter(
    (item) =>
      exactReviewQueueIsPublication(item) &&
      (item.state === "dispatching" || item.state === "leased"),
  ).length;
}

export function exactReviewPrioritizePublicationItems(
  items: ExactReviewQueueItem[],
  freshItemKeys: ReadonlySet<string>,
  freshReserve: number,
) {
  if (!freshReserve || !freshItemKeys.size) return items;
  const fresh = items.filter((item) => freshItemKeys.has(item.key));
  if (!fresh.length) return items;
  const historical = items.filter((item) => !freshItemKeys.has(item.key));
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
  const pending = Object.values(state.items)
    .filter(
      (item) =>
        item.state === "pending" && item.nextAttemptAt <= now && !excludedItemKeys.has(item.key),
    )
    .sort((left, right) => left.createdAt - right.createdAt || left.key.localeCompare(right.key));
  const pendingReviews = pending.filter((item) => !exactReviewQueueIsPublication(item));
  const pendingPublications = exactReviewPrioritizePublicationItems(
    pending.filter(exactReviewQueueIsPublication),
    freshPublicationItemKeys,
    freshPublicationReserve,
  );
  const admittedReviews: ExactReviewQueueItem[] = [];
  for (const item of pendingReviews) {
    if (admittedReviews.length >= reviewSlots) break;
    const target = item.decision.targetRepo;
    if (exactReviewGithubTargetAppCircuitRetryAt(state, target, now) > now) continue;
    const active = activeTargets.get(target) || 0;
    if (active >= targetCapacity) continue;
    activeTargets.set(target, active + 1);
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
) {
  const items = Object.values(state.items);
  const handoffItems = items.filter(
    (item): item is ExactReviewQueueItem & { state: "pending" | "dispatching" | "leased" } =>
      item.state !== "parked" && !exactReviewQueueIsPublication(item),
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
    Number(state.dispatcher?.reviewAdmissionNextAt || 0) > now
      ? Number(state.dispatcher?.reviewAdmissionNextAt)
      : null,
  );
  const lanes = {
    review: exactReviewQueueLaneStats(
      items.filter((item) => !exactReviewQueueIsPublication(item)),
      now,
      capacity,
      exactReviewShedSinceReset(state),
      state,
    ),
    publication: exactReviewQueueLaneStats(
      items.filter(exactReviewQueueIsPublication),
      now,
      publicationCapacity,
      0,
      state,
    ),
  };
  const admissibleItems = exactReviewQueueAdmittedItems(
    state,
    now,
    Number.MAX_SAFE_INTEGER,
    targetCapacity,
    publicationCapacity,
    excludedItemKeys,
    publicationBlockedUntil !== null && publicationBlockedUntil > now,
  );
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
}

export function exactReviewQueueLaneStats(
  items: ExactReviewQueueItem[],
  now: number,
  capacity: number,
  shedSinceReset = 0,
  state: ExactReviewQueueState = { items: {} },
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
    backoff_reasons: exactReviewQueueReasonCounts(
      backoffItems.map((item) => exactReviewQueueBackoffReason(item, state, now)),
    ),
    dispatching: dispatchingItems.length,
    leased: leasedItems.length,
    parked: parkedItems.length,
    parked_reasons: exactReviewQueueReasonCounts(
      parkedItems.map((item) => item.parkedReason || "unknown"),
    ),
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
  const parkedTerminalGlobalCheckAt = exactReviewParkedTerminalGlobalCheckAt(state);
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
      const credentialBlockedUntil = exactReviewGithubTargetAppCircuitRetryAt(state, target, now);
      const capacityBlockedUntil = [
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
          reviewAdmissionBlockedUntil ?? item.nextAttemptAt,
          credentialBlockedUntil,
          capacityBlockedUntil.length ? Math.min(...capacityBlockedUntil) : item.nextAttemptAt,
        ),
      ];
    }
    if (item.state === "parked") {
      const recoveryAt = exactReviewParkedRecoveryAt(item);
      const terminalCheckAt = exactReviewParkedTerminalCheckAt(item);
      return [
        recoveryAt,
        terminalCheckAt === null
          ? null
          : Math.max(
              terminalCheckAt,
              parkedTerminalGlobalCheckAt,
              dispatcherPaused ? dispatcherRetryAt : 0,
            ),
      ].filter((value): value is number => value !== null);
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

export function exactReviewQueueCapacity(env, DEFAULT_EXACT_REVIEW_ACTIONS_BUDGET: number) {
  return Math.max(
    1,
    Math.min(
      numberFrom(env.EXACT_REVIEW_ACTIONS_BUDGET, DEFAULT_EXACT_REVIEW_ACTIONS_BUDGET),
      numberFrom(env.EXACT_REVIEW_QUEUE_MAX_CONCURRENT, DEFAULT_EXACT_REVIEW_QUEUE_MAX_CONCURRENT),
    ),
  );
}
