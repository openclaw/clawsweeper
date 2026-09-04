import { isRecord } from "./value-coerce.js";
export const QUEUE_PRESSURE_SOFT_PENDING = 150;
export const QUEUE_PRESSURE_HARD_PENDING = 400;
export const QUEUE_PRESSURE_SOFT_AGE_MS = 30 * 60 * 1_000;
export const QUEUE_PRESSURE_HARD_AGE_MS = 2 * 60 * 60 * 1_000;
export const QUEUE_PRESSURE_FETCH_TIMEOUT_MS = 5_000;

export type QueuePressureLevel = "none" | "soft" | "hard" | "unknown";

export type ExactReviewQueuePressure =
  | {
      ok: true;
      pendingCount: number;
      oldestPendingAgeMs: number;
      activeCount?: number;
      capacity?: number;
      availableCandidateCapacity?: number;
    }
  | {
      ok: false;
      reason: string;
    };

type FetchExactReviewQueuePressureOptions = {
  queueUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export async function fetchExactReviewQueuePressure({
  queueUrl,
  fetchImpl = fetch,
  timeoutMs = QUEUE_PRESSURE_FETCH_TIMEOUT_MS,
}: FetchExactReviewQueuePressureOptions): Promise<ExactReviewQueuePressure> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetchImpl(
      new URL("/api/exact-review-queue", `${queueUrl.replace(/\/+$/, "")}/`),
      { signal },
    );
    if (!response.ok) return { ok: false, reason: `http_${response.status}` };

    const body: unknown = await response.json();
    if (!isRecord(body)) return malformedPressure();
    // Review and publication have independent capacity and durable ownership.
    // Only review backlog may throttle review producers.
    const reviewLane =
      isRecord(body.lanes) && isRecord(body.lanes.review) ? body.lanes.review : null;
    const pendingCount =
      reviewLane && isNonNegativeInteger(reviewLane.pending) ? reviewLane.pending : body.pending;
    const oldestPendingAgeSeconds =
      reviewLane && isNonNegativeInteger(reviewLane.pending)
        ? reviewLane.oldest_pending_age_seconds
        : body.oldest_pending_age_seconds;
    if (!isNonNegativeInteger(pendingCount)) return malformedPressure();
    const capacityFields =
      reviewLane &&
      isNonNegativeInteger(reviewLane.active) &&
      isNonNegativeInteger(reviewLane.capacity)
        ? {
            activeCount: reviewLane.active,
            capacity: reviewLane.capacity,
            availableCandidateCapacity: Math.max(
              0,
              reviewLane.capacity - reviewLane.active - pendingCount,
            ),
          }
        : {};
    if (pendingCount === 0) {
      return {
        ok: true,
        pendingCount,
        oldestPendingAgeMs: 0,
        ...capacityFields,
      };
    }
    // A null age with a positive backlog is inconsistent data — fail open
    // rather than fabricating a zero-age backlog.
    if (oldestPendingAgeSeconds === null) return malformedPressure();
    if (!isNonNegativeNumber(oldestPendingAgeSeconds)) return malformedPressure();
    const oldestPendingAgeMs = oldestPendingAgeSeconds * 1_000;
    if (!Number.isFinite(oldestPendingAgeMs)) return malformedPressure();
    return {
      ok: true,
      pendingCount,
      oldestPendingAgeMs,
      ...capacityFields,
    };
  } catch (error) {
    return {
      ok: false,
      reason: signal.aborted ? "timeout" : errorReason(error),
    };
  }
}

export function queuePressureLevel(pressure: ExactReviewQueuePressure): QueuePressureLevel {
  // An unavailable control-plane signal is not evidence that the queue is empty.
  // Background admission must retain a bounded capacity until the next healthy
  // probe, while exact-item work keeps its independent interactive reservation.
  if (!pressure.ok) return "unknown";
  const hardPending = envThreshold(
    "CLAWSWEEPER_QUEUE_PRESSURE_HARD_PENDING",
    QUEUE_PRESSURE_HARD_PENDING,
  );
  const hardAgeMs = envThreshold(
    "CLAWSWEEPER_QUEUE_PRESSURE_HARD_AGE_MS",
    QUEUE_PRESSURE_HARD_AGE_MS,
  );
  if (pressure.pendingCount >= hardPending || pressure.oldestPendingAgeMs >= hardAgeMs) {
    return "hard";
  }
  const softPending = envThreshold(
    "CLAWSWEEPER_QUEUE_PRESSURE_SOFT_PENDING",
    QUEUE_PRESSURE_SOFT_PENDING,
  );
  const softAgeMs = envThreshold(
    "CLAWSWEEPER_QUEUE_PRESSURE_SOFT_AGE_MS",
    QUEUE_PRESSURE_SOFT_AGE_MS,
  );
  if (pressure.pendingCount >= softPending || pressure.oldestPendingAgeMs >= softAgeMs) {
    return "soft";
  }
  return "none";
}

function envThreshold(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function malformedPressure(): ExactReviewQueuePressure {
  return { ok: false, reason: "malformed_response" };
}

function errorReason(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return "fetch_failed";
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return isNonNegativeNumber(value) && Number.isInteger(value);
}
