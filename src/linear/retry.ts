export type LinearRetryKind = "none" | "throttle" | "transient";

interface LinearRequestErrorOptions {
  status?: number;
  code?: string;
  resetAtMs?: number;
}

export class LinearRequestError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly resetAtMs: number | undefined;

  constructor(message: string, opts?: LinearRequestErrorOptions) {
    super(message);
    this.name = "LinearRequestError";
    // Assign only when defined to satisfy exactOptionalPropertyTypes.
    this.status = opts?.status;
    this.code = opts?.code;
    this.resetAtMs = opts?.resetAtMs;
  }
}

const TRANSIENT_PATTERNS = [
  /\bECONNRESET\b/i,
  /\bETIMEDOUT\b/i,
  /\bEAI_AGAIN\b/i,
  /socket hang up/i,
  /network timeout/i,
];

export function linearRetryKind(error: unknown): LinearRetryKind {
  if (error instanceof LinearRequestError) {
    if (error.code === "RATELIMITED") return "throttle";
    if (error.status === 400 && /RATELIMITED/i.test(error.message)) return "throttle";
    if (error.status === 429) return "throttle";
    if (error.status != null && [500, 502, 503, 504].includes(error.status)) return "transient";
  }
  const message = error instanceof Error ? error.message : String(error);
  if (TRANSIENT_PATTERNS.some((pattern) => pattern.test(message))) return "transient";
  return "none";
}

export function shouldRetryLinear(error: unknown): boolean {
  return linearRetryKind(error) !== "none";
}

export function linearRetryWaitMs(
  kind: LinearRetryKind,
  attempt: number,
  resetAtMs?: number,
  nowMs: number = Date.now(),
): number {
  if (kind === "throttle") {
    if (resetAtMs != null && resetAtMs > nowMs) {
      return Math.min(600_000, resetAtMs - nowMs);
    }
    return Math.min(600_000, 30_000 * 2 ** attempt);
  }
  if (kind === "transient") {
    return Math.min(60_000, 2_000 * 2 ** attempt);
  }
  return 0;
}
