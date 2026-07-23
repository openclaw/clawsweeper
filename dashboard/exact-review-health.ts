export type ExactReviewPhase = "pending" | "dispatching" | "leased";

export type ExactReviewHealthItem = {
  key?: string;
  state: ExactReviewPhase;
  createdAt: number;
  updatedAt: number;
  leaseExpiresAt?: number;
  dispatchedAt?: number;
  claimedAt?: number;
};

export type ExactReviewHealthDispatcher = {
  state?: "active" | "paused" | "blocked" | "unknown";
};

export type ExactReviewPhaseSummary = {
  count: number;
  oldest_at: string | null;
  oldest_age_seconds: number | null;
  oldest_key: string | null;
};

export type ExactReviewHandoffHealth = {
  status: "idle" | "healthy" | "degraded" | "stalled";
  reason:
    | "queue_empty"
    | "handoff_current"
    | "claim_delayed"
    | "claim_stalled"
    | "dispatcher_paused"
    | "dispatcher_blocked";
  message: string;
  observed_at: string;
  warning_after_seconds: number;
  stalled_after_seconds: number;
  capacity: number;
  active: number;
  available_slots: number;
  pending_depth: number;
  shed_since_reset: number;
  phases: Record<ExactReviewPhase, ExactReviewPhaseSummary>;
};

export type ExactReviewPressureStatus = "idle" | "congested" | "saturated" | "unknown";

export type ExactReviewPressureSummary = {
  status: ExactReviewPressureStatus;
  reason:
    | "capacity_unavailable"
    | "capacity_available"
    | "no_ready_backlog"
    | "no_admissible_backlog"
    | "dispatcher_inactive"
    | "handoff_unknown"
    | "capacity_full_with_backlog";
  capacity: number;
  active: number;
  pending: number;
  ready_pending: number;
  admissible_pending: number;
};

const PHASES: ExactReviewPhase[] = ["pending", "dispatching", "leased"];

export function summarizeExactReviewHandoff({
  items,
  dispatcher,
  now = Date.now(),
  capacity,
  dispatchLeaseMs,
  executionLeaseMs,
  shedSinceReset = 0,
}: {
  items: ExactReviewHealthItem[];
  dispatcher?: ExactReviewHealthDispatcher;
  now?: number;
  capacity: number;
  dispatchLeaseMs: number;
  executionLeaseMs: number;
  shedSinceReset?: number;
}): ExactReviewHandoffHealth {
  const safeNow = finiteTimestamp(now, Date.now());
  const safeCapacity = Math.max(0, Math.floor(finiteNumber(capacity, 0)));
  const safeShedSinceReset = Math.max(0, Math.floor(finiteNumber(shedSinceReset, 0)));
  const safeLeaseMs = Math.max(1_000, finiteNumber(dispatchLeaseMs, 10 * 60_000));
  const safeExecutionLeaseMs = Math.max(1_000, finiteNumber(executionLeaseMs, 130 * 60_000));
  const warningMs = Math.min(2 * 60_000, Math.max(30_000, Math.floor(safeLeaseMs / 3)));
  const stalledMs = Math.min(
    5 * 60_000,
    Math.max(warningMs + 1_000, Math.floor((safeLeaseMs * 2) / 3)),
  );
  const phaseValues: Record<
    ExactReviewPhase,
    { count: number; oldestAt: number | null; oldestKey: string | null }
  > = {
    pending: { count: 0, oldestAt: null, oldestKey: null },
    dispatching: { count: 0, oldestAt: null, oldestKey: null },
    leased: { count: 0, oldestAt: null, oldestKey: null },
  };

  for (const item of items) {
    const startedAt = exactReviewPhaseStartedAt(item, safeNow, safeLeaseMs, safeExecutionLeaseMs);
    const phase = phaseValues[item.state];
    if (!phase) continue;
    phase.count += 1;
    const key = item.key?.trim() || null;
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

  const phases = Object.fromEntries(
    PHASES.map((phase) => {
      const { count, oldestAt, oldestKey } = phaseValues[phase];
      return [
        phase,
        {
          count,
          oldest_at: oldestAt === null ? null : new Date(oldestAt).toISOString(),
          oldest_age_seconds:
            oldestAt === null ? null : Math.max(0, Math.floor((safeNow - oldestAt) / 1_000)),
          oldest_key: oldestKey,
        },
      ];
    }),
  ) as Record<ExactReviewPhase, ExactReviewPhaseSummary>;

  const active = phases.dispatching.count + phases.leased.count;
  const common = {
    observed_at: new Date(safeNow).toISOString(),
    warning_after_seconds: Math.floor(warningMs / 1_000),
    stalled_after_seconds: Math.floor(stalledMs / 1_000),
    capacity: safeCapacity,
    active,
    available_slots: Math.max(0, safeCapacity - active),
    pending_depth: phases.pending.count,
    shed_since_reset: safeShedSinceReset,
    phases,
  };
  if (items.length === 0) {
    return {
      status: "idle",
      reason: "queue_empty",
      message: "No exact-review work is queued or active.",
      ...common,
    };
  }

  const dispatchingAgeMs = (phases.dispatching.oldest_age_seconds || 0) * 1_000;
  if (dispatchingAgeMs >= stalledMs) {
    return {
      status: "stalled",
      reason: "claim_stalled",
      message: "A dispatched review has not been claimed within the expected handoff window.",
      ...common,
    };
  }
  if (dispatcher?.state === "blocked" && phases.pending.count > 0) {
    return {
      status: "stalled",
      reason: "dispatcher_blocked",
      message: "The dispatcher cannot verify workflow availability while reviews are pending.",
      ...common,
    };
  }
  if (dispatcher?.state === "paused" && phases.pending.count > 0) {
    return {
      status: "degraded",
      reason: "dispatcher_paused",
      message: "The exact-review workflow is paused while reviews are pending.",
      ...common,
    };
  }
  if (dispatchingAgeMs >= warningMs) {
    return {
      status: "degraded",
      reason: "claim_delayed",
      message: "A dispatched review is taking longer than expected to claim.",
      ...common,
    };
  }
  return {
    status: "healthy",
    reason: "handoff_current",
    message: "Dispatch-to-claim handoffs are within the expected window.",
    ...common,
  };
}

export function summarizeExactReviewPressure({
  pending,
  readyPending,
  admissiblePending,
  dispatching,
  leased,
  capacity,
  dispatcherState,
  handoffStatus,
}: {
  pending: number;
  readyPending: number;
  admissiblePending: number;
  dispatching: number;
  leased: number;
  capacity: number;
  dispatcherState?: string;
  handoffStatus?: string;
}): ExactReviewPressureSummary {
  const safePending = nonNegativeInteger(pending);
  const safeReadyPending = Math.min(safePending, nonNegativeInteger(readyPending));
  const safeAdmissiblePending = Math.min(safeReadyPending, nonNegativeInteger(admissiblePending));
  const safeCapacity = nonNegativeInteger(capacity);
  const active = nonNegativeInteger(dispatching) + nonNegativeInteger(leased);
  const common = {
    capacity: safeCapacity,
    active,
    pending: safePending,
    ready_pending: safeReadyPending,
    admissible_pending: safeAdmissiblePending,
  };

  if (safeCapacity < 1) return { status: "unknown", reason: "capacity_unavailable", ...common };
  if (safeReadyPending < 1) return { status: "idle", reason: "no_ready_backlog", ...common };
  if (safeAdmissiblePending < 1) {
    return { status: "idle", reason: "no_admissible_backlog", ...common };
  }
  if (active < safeCapacity) return { status: "idle", reason: "capacity_available", ...common };
  if (dispatcherState !== "active") {
    return { status: "unknown", reason: "dispatcher_inactive", ...common };
  }
  if (!["healthy", "degraded", "stalled"].includes(String(handoffStatus || ""))) {
    return { status: "unknown", reason: "handoff_unknown", ...common };
  }
  return {
    status: safeAdmissiblePending >= safeCapacity ? "saturated" : "congested",
    reason: "capacity_full_with_backlog",
    ...common,
  };
}

function exactReviewPhaseStartedAt(
  item: ExactReviewHealthItem,
  now: number,
  dispatchLeaseMs: number,
  executionLeaseMs: number,
) {
  if (item.state === "dispatching") {
    const dispatchedAt = validTimestamp(item.dispatchedAt);
    const leaseExpiresAt = validTimestamp(item.leaseExpiresAt);
    const leaseStartedAt =
      leaseExpiresAt === null ? null : timestampAtOrBefore(leaseExpiresAt - dispatchLeaseMs, now);
    // Rolling deploys can expose rows created before dispatchedAt existed, while a rollback can
    // leave an old dispatchedAt behind. The current lease start is the reliable compatibility
    // marker; prefer the newest plausible transition and keep an unknown age non-alarming.
    return newestTimestamp(dispatchedAt, leaseStartedAt) ?? now;
  }
  if (item.state === "leased") {
    const claimedAt = validTimestamp(item.claimedAt);
    const leaseExpiresAt = validTimestamp(item.leaseExpiresAt);
    const leaseStartedAt =
      leaseExpiresAt === null ? null : validTimestamp(leaseExpiresAt - executionLeaseMs);
    return newestTimestamp(claimedAt, leaseStartedAt) ?? now;
  }
  return finiteTimestamp(item.createdAt, finiteTimestamp(item.updatedAt, now));
}

function newestTimestamp(...values: Array<number | null>) {
  let newest: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    newest = newest === null ? value : Math.max(newest, value);
  }
  return newest;
}

function validTimestamp(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= 8_640_000_000_000_000 ? number : null;
}

function timestampAtOrBefore(value: unknown, maximum: number): number | null {
  const timestamp = validTimestamp(value);
  return timestamp !== null && timestamp <= maximum ? timestamp : null;
}

function finiteTimestamp(value: unknown, fallback: number) {
  return validTimestamp(value) ?? fallback;
}

function finiteNumber(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nonNegativeInteger(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}
