export const QUEUE_PRESSURE_SOFT_PENDING = 150;
export const QUEUE_PRESSURE_HARD_PENDING = 400;
export const QUEUE_PRESSURE_SOFT_AGE_MS = 30 * 60 * 1_000;
export const QUEUE_PRESSURE_HARD_AGE_MS = 2 * 60 * 60 * 1_000;
export const QUEUE_PRESSURE_FETCH_TIMEOUT_MS = 5_000;

export type QueuePressureLevel = "none" | "soft" | "hard";

export type ExactReviewQueuePressure =
  | {
      ok: true;
      pendingCount: number;
      oldestPendingAgeMs: number;
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(
      new URL("/api/exact-review-queue", `${queueUrl.replace(/\/+$/, "")}/`),
      { signal: controller.signal },
    );
    if (!response.ok) return { ok: false, reason: `http_${response.status}` };

    const body: unknown = await response.json();
    if (!isRecord(body)) return malformedPressure();
    const pendingCount = body.pending;
    const oldestPendingAgeSeconds = body.oldest_pending_age_seconds;
    if (!isNonNegativeInteger(pendingCount)) return malformedPressure();
    if (pendingCount === 0 && oldestPendingAgeSeconds === null) {
      return { ok: true, pendingCount, oldestPendingAgeMs: 0 };
    }
    if (!isNonNegativeNumber(oldestPendingAgeSeconds)) return malformedPressure();
    const oldestPendingAgeMs = oldestPendingAgeSeconds * 1_000;
    if (!Number.isFinite(oldestPendingAgeMs)) return malformedPressure();
    return {
      ok: true,
      pendingCount,
      oldestPendingAgeMs,
    };
  } catch (error) {
    return {
      ok: false,
      reason: controller.signal.aborted ? "timeout" : errorReason(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function queuePressureLevel(pressure: ExactReviewQueuePressure): QueuePressureLevel {
  if (!pressure.ok) return "none";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return isNonNegativeNumber(value) && Number.isInteger(value);
}
