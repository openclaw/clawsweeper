const MINUTE_MS = 60_000;

export const DEFAULT_FIX_CODEX_TIMEOUT_MS = 30 * MINUTE_MS;
export const DEFAULT_FIX_STEP_TIMEOUT_MS = 70 * MINUTE_MS;
export const DEFAULT_FIX_LATE_WORKER_RESERVE_MS = 30 * MINUTE_MS;

const MIN_CODEX_TIMEOUT_MS = 5 * MINUTE_MS;
const MAX_CODEX_TIMEOUT_MS = 60 * MINUTE_MS;
const MIN_FIX_STEP_TIMEOUT_MS = 15 * MINUTE_MS;
const MAX_FIX_STEP_TIMEOUT_MS = 70 * MINUTE_MS;

type RepairTimeoutEnvironment = Record<string, string | undefined>;

export type RepairTimeoutBudget = {
  codexTimeoutMs: number;
  fixStepTimeoutMs: number;
  lateWorkerReserveMs: number;
};

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

export function repairTimeoutBudgetFromEnv(
  environment: RepairTimeoutEnvironment,
): RepairTimeoutBudget {
  const fixStepTimeoutMs = boundedInteger(
    environment.CLAWSWEEPER_FIX_STEP_TIMEOUT_MS,
    DEFAULT_FIX_STEP_TIMEOUT_MS,
    MIN_FIX_STEP_TIMEOUT_MS,
    MAX_FIX_STEP_TIMEOUT_MS,
  );
  const requestedCodexTimeoutMs = boundedInteger(
    environment.CLAWSWEEPER_FIX_CODEX_TIMEOUT_MS,
    DEFAULT_FIX_CODEX_TIMEOUT_MS,
    MIN_CODEX_TIMEOUT_MS,
    MAX_CODEX_TIMEOUT_MS,
  );
  const codexTimeoutMs = Math.min(requestedCodexTimeoutMs, fixStepTimeoutMs - MIN_CODEX_TIMEOUT_MS);
  const requestedReserveMs = boundedInteger(
    environment.CLAWSWEEPER_FIX_TIMEOUT_RESERVE_MS,
    DEFAULT_FIX_LATE_WORKER_RESERVE_MS,
    MIN_CODEX_TIMEOUT_MS,
    MAX_CODEX_TIMEOUT_MS,
  );
  const lateWorkerReserveMs = Math.min(
    Math.max(requestedReserveMs, codexTimeoutMs),
    fixStepTimeoutMs - MIN_CODEX_TIMEOUT_MS,
  );

  return { codexTimeoutMs, fixStepTimeoutMs, lateWorkerReserveMs };
}

export function remainingRepairBudgetMs({
  elapsedMs,
  fixStepTimeoutMs,
  reportReserveMs,
  minimumTimeoutMs,
}: {
  elapsedMs: number;
  fixStepTimeoutMs: number;
  reportReserveMs: number;
  minimumTimeoutMs: number;
}) {
  return Math.max(minimumTimeoutMs, fixStepTimeoutMs - elapsedMs - reportReserveMs);
}

export function repairWorkerTimeoutMs({
  requestedTimeoutMs,
  remainingBudgetMs,
  minimumTimeoutMs,
  preserveMs = 0,
}: {
  requestedTimeoutMs: number;
  remainingBudgetMs: number;
  minimumTimeoutMs: number;
  preserveMs?: number;
}) {
  const availableMs = Math.max(minimumTimeoutMs, remainingBudgetMs - Math.max(0, preserveMs));
  const requestedMs =
    Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
      ? requestedTimeoutMs
      : availableMs;
  return Math.max(minimumTimeoutMs, Math.min(requestedMs, availableMs));
}
