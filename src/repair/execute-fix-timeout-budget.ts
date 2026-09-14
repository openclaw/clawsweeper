const MINUTE_MS = 60_000;

export const DEFAULT_FIX_CODEX_TIMEOUT_MS = 30 * MINUTE_MS;
export const DEFAULT_FIX_STEP_TIMEOUT_MS = 70 * MINUTE_MS;
export const DEFAULT_FIX_TARGET_VALIDATION_TIMEOUT_MS = 8 * MINUTE_MS;
export const DEFAULT_FIX_LATE_WORKER_RESERVE_MS = 30 * MINUTE_MS;

const MIN_CODEX_TIMEOUT_MS = 5 * MINUTE_MS;
const MAX_CODEX_TIMEOUT_MS = 60 * MINUTE_MS;
const MIN_FIX_STEP_TIMEOUT_MS = 15 * MINUTE_MS;
export const MAX_FIX_STEP_TIMEOUT_MS = 110 * MINUTE_MS;
const FIX_SETUP_ALLOWANCE_MS = 10 * MINUTE_MS;
const FIX_REVIEW_REPORT_MARGIN_MS = 10 * MINUTE_MS;

type RepairTimeoutEnvironment = Record<string, string | undefined>;

export function repairTargetValidationTimeoutMs(
  environment: RepairTimeoutEnvironment,
  repositoryTimeoutMs?: number,
): number {
  const requested = Number(environment.CLAWSWEEPER_FIX_TARGET_VALIDATION_TIMEOUT_MS);
  if (Number.isSafeInteger(requested) && requested > 0) return requested;
  return repositoryTimeoutMs ?? DEFAULT_FIX_TARGET_VALIDATION_TIMEOUT_MS;
}

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
  repositoryValidationTimeoutMs?: number,
): RepairTimeoutBudget {
  const validationTimeoutMs = repairTargetValidationTimeoutMs(
    environment,
    repositoryValidationTimeoutMs,
  );
  const requestedCodexTimeoutMs = boundedInteger(
    environment.CLAWSWEEPER_FIX_CODEX_TIMEOUT_MS,
    DEFAULT_FIX_CODEX_TIMEOUT_MS,
    MIN_CODEX_TIMEOUT_MS,
    MAX_CODEX_TIMEOUT_MS,
  );
  const derivedStepTimeoutMs = Math.min(
    MAX_FIX_STEP_TIMEOUT_MS,
    Math.max(
      DEFAULT_FIX_STEP_TIMEOUT_MS,
      FIX_SETUP_ALLOWANCE_MS +
        requestedCodexTimeoutMs +
        2 * validationTimeoutMs +
        FIX_REVIEW_REPORT_MARGIN_MS,
    ),
  );
  const fixStepTimeoutMs = boundedInteger(
    environment.CLAWSWEEPER_FIX_STEP_TIMEOUT_MS,
    derivedStepTimeoutMs,
    MIN_FIX_STEP_TIMEOUT_MS,
    MAX_FIX_STEP_TIMEOUT_MS,
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

export function repairActionsStepTimeoutMinutes(budget: RepairTimeoutBudget): number {
  // Allow the executor to finish its report before Actions terminates the step.
  return Math.ceil(budget.fixStepTimeoutMs / MINUTE_MS) + 2;
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
