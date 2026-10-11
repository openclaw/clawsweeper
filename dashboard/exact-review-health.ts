export type ExactReviewPhase = "pending" | "dispatching" | "leased";
export type ExactReviewReviewRecoveryReason =
  | "claim_timeout"
  | "execution_timeout"
  | "workflow_cancelled"
  | "workflow_failed";

export type ExactReviewHealthItem = {
  key?: string;
  state: ExactReviewPhase;
  createdAt: number;
  updatedAt: number;
  leaseExpiresAt?: number;
  dispatchedAt?: number;
  claimedAt?: number;
  reviewRecoveryReason?: ExactReviewReviewRecoveryReason;
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

export type ExactReviewHandoffPhaseCensus = {
  count: number;
  oldestAt: number | null;
  oldestKey: string | null;
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
  recovery_reasons: Record<ExactReviewReviewRecoveryReason, number>;
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

export type ExactReviewPublicationHealth = {
  status?: "idle" | "healthy" | "degraded" | "critical";
};

export type ExactReviewPublicationLaneSummary = {
  pending: number;
  active: number;
  parked: number;
  oldest_pending_age_seconds: number | null;
  parked_reasons?: Record<string, number>;
  // Age of the oldest retained stale-revision row counted in `parked`.
  oldest_stale_revision_age_seconds?: number | null;
};

const PHASES: ExactReviewPhase[] = ["pending", "dispatching", "leased"];

export function projectExactReviewHandoff({
  itemCount,
  phaseCensus,
  recoveryReasons,
  dispatcher,
  now,
  capacity,
  dispatchLeaseMs,
  shedSinceReset = 0,
}: {
  itemCount: number;
  phaseCensus: Record<ExactReviewPhase, ExactReviewHandoffPhaseCensus>;
  recoveryReasons: Record<ExactReviewReviewRecoveryReason, number>;
  dispatcher?: ExactReviewHealthDispatcher | undefined;
  now: number;
  capacity: number;
  dispatchLeaseMs: number;
  shedSinceReset?: number;
}): ExactReviewHandoffHealth {
  const safeCapacity = Math.max(0, Math.floor(finiteNumber(capacity, 0)));
  const safeShedSinceReset = Math.max(0, Math.floor(finiteNumber(shedSinceReset, 0)));
  const safeLeaseMs = Math.max(1_000, finiteNumber(dispatchLeaseMs, 10 * 60_000));
  const warningMs = Math.min(2 * 60_000, Math.max(30_000, Math.floor(safeLeaseMs / 3)));
  const stalledMs = Math.min(
    5 * 60_000,
    Math.max(warningMs + 1_000, Math.floor((safeLeaseMs * 2) / 3)),
  );
  const phases = Object.fromEntries(
    PHASES.map((phase) => {
      const { count, oldestAt, oldestKey } = phaseCensus[phase];
      return [
        phase,
        {
          count,
          oldest_at: oldestAt === null ? null : new Date(oldestAt).toISOString(),
          oldest_age_seconds:
            oldestAt === null ? null : Math.max(0, Math.floor((now - oldestAt) / 1_000)),
          oldest_key: oldestKey,
        },
      ];
    }),
  ) as Record<ExactReviewPhase, ExactReviewPhaseSummary>;

  const active = phases.dispatching.count + phases.leased.count;
  const common = {
    observed_at: new Date(now).toISOString(),
    warning_after_seconds: Math.floor(warningMs / 1_000),
    stalled_after_seconds: Math.floor(stalledMs / 1_000),
    capacity: safeCapacity,
    active,
    available_slots: Math.max(0, safeCapacity - active),
    pending_depth: phases.pending.count,
    shed_since_reset: safeShedSinceReset,
    recovery_reasons: recoveryReasons,
    phases,
  };
  if (itemCount === 0) {
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

export function summarizeExactReviewPublicationHealth(
  lane: ExactReviewPublicationLaneSummary,
  flow: { last_15_minutes: { net_drain_rate_per_hour: number } },
): ExactReviewPublicationHealth & { reason: string | null } {
  const pending = nonNegativeInteger(lane.pending);
  const active = nonNegativeInteger(lane.active);
  const parked = nonNegativeInteger(lane.parked);
  const oldestAge = nonNegativeInteger(lane.oldest_pending_age_seconds);
  // Retained stale revisions are parked for observation only. They keep the
  // age-based severity they had while counted as pending, not dead-letter severity.
  const staleRevisions = Math.min(parked, nonNegativeInteger(lane.parked_reasons?.stale_revision));
  const deadLetters = parked - staleRevisions;
  const staleAge = staleRevisions ? nonNegativeInteger(lane.oldest_stale_revision_age_seconds) : 0;

  // Dead letters and retired state-writer history are reported independently.
  // Neither is current publication demand, so an empty lane must stay idle.
  if (pending === 0 && active === 0 && parked === 0) {
    return { status: "idle", reason: null };
  }
  if (deadLetters > 0 || oldestAge >= 6 * 60 * 60 || staleAge >= 6 * 60 * 60) {
    return {
      status: "critical",
      reason:
        deadLetters > 0
          ? "dead_letter_capacity"
          : oldestAge >= 6 * 60 * 60
            ? "oldest_pending_over_6h"
            : "stale_revision_over_6h",
    };
  }
  if (
    oldestAge >= 60 * 60 ||
    staleAge >= 60 * 60 ||
    (pending >= 100 && flow.last_15_minutes.net_drain_rate_per_hour <= 0)
  ) {
    return {
      status: "degraded",
      reason:
        oldestAge >= 60 * 60
          ? "oldest_pending_over_1h"
          : staleAge >= 60 * 60
            ? "stale_revision_over_1h"
            : "not_draining",
    };
  }
  return { status: "healthy", reason: null };
}

function finiteNumber(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nonNegativeInteger(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}
