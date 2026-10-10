import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DEFAULT_FIX_CODEX_TIMEOUT_MS,
  DEFAULT_FIX_LATE_WORKER_RESERVE_MS,
  DEFAULT_FIX_STEP_TIMEOUT_MS,
  DEFAULT_FIX_TARGET_VALIDATION_TIMEOUT_MS,
  MAX_FIX_STEP_TIMEOUT_MS,
  remainingRepairBudgetMs,
  repairTimeoutBudgetFromEnv,
  repairWorkerTimeoutMs,
  repairTargetValidationTimeoutMs,
  repairActionsStepTimeoutMinutes,
} from "./execute-fix-timeout-budget.js";
import { resolveTargetRepoToolchain } from "./target-toolchain-config.js";

test("repair validation budget uses the repository's configured budget before the repair default", () => {
  const config = JSON.parse(readFileSync("config/target-repositories.json", "utf8"));
  const configuredMs = config.core_target_overrides["openclaw/openclaw"].validation_timeout_ms;
  assert.ok(Number.isSafeInteger(configuredMs) && configuredMs > 0);
  const configured = resolveTargetRepoToolchain("openclaw/openclaw").validationTimeoutMs;
  assert.equal(configured, configuredMs);
  assert.equal(repairTargetValidationTimeoutMs({}, configured), configuredMs);
  assert.equal(
    repairTargetValidationTimeoutMs(
      {},
      resolveTargetRepoToolchain("unconfigured-owner/example").validationTimeoutMs,
    ),
    DEFAULT_FIX_TARGET_VALIDATION_TIMEOUT_MS,
  );
  assert.equal(
    repairTargetValidationTimeoutMs(
      { CLAWSWEEPER_FIX_TARGET_VALIDATION_TIMEOUT_MS: "900000" },
      configured,
    ),
    900_000,
  );
  for (const value of ["", "0", "-1", "NaN", "Infinity", "1.5", "9007199254740992"]) {
    assert.equal(
      repairTargetValidationTimeoutMs(
        { CLAWSWEEPER_FIX_TARGET_VALIDATION_TIMEOUT_MS: value },
        configured,
      ),
      configuredMs,
    );
    assert.equal(
      repairTargetValidationTimeoutMs({ CLAWSWEEPER_FIX_TARGET_VALIDATION_TIMEOUT_MS: value }),
      DEFAULT_FIX_TARGET_VALIDATION_TIMEOUT_MS,
    );
  }
});

test("repair timeout budget uses coherent production defaults", () => {
  assert.deepEqual(repairTimeoutBudgetFromEnv({}), {
    codexTimeoutMs: DEFAULT_FIX_CODEX_TIMEOUT_MS,
    fixStepTimeoutMs: DEFAULT_FIX_STEP_TIMEOUT_MS,
    lateWorkerReserveMs: DEFAULT_FIX_LATE_WORKER_RESERVE_MS,
  });
});

test("repair timeout budget falls back or clamps unsafe repository variables", () => {
  assert.deepEqual(
    repairTimeoutBudgetFromEnv({
      CLAWSWEEPER_FIX_CODEX_TIMEOUT_MS: "Infinity",
      CLAWSWEEPER_FIX_STEP_TIMEOUT_MS: "not-a-number",
      CLAWSWEEPER_FIX_TIMEOUT_RESERVE_MS: "-1",
    }),
    {
      codexTimeoutMs: DEFAULT_FIX_CODEX_TIMEOUT_MS,
      fixStepTimeoutMs: DEFAULT_FIX_STEP_TIMEOUT_MS,
      lateWorkerReserveMs: DEFAULT_FIX_CODEX_TIMEOUT_MS,
    },
  );

  assert.deepEqual(
    repairTimeoutBudgetFromEnv({
      CLAWSWEEPER_FIX_CODEX_TIMEOUT_MS: "999999999",
      CLAWSWEEPER_FIX_STEP_TIMEOUT_MS: "1",
      CLAWSWEEPER_FIX_TIMEOUT_RESERVE_MS: "999999999",
    }),
    {
      codexTimeoutMs: 10 * 60_000,
      fixStepTimeoutMs: 15 * 60_000,
      lateWorkerReserveMs: 10 * 60_000,
    },
  );

  assert.deepEqual(
    repairTimeoutBudgetFromEnv({
      CLAWSWEEPER_FIX_CODEX_TIMEOUT_MS: "999999999",
      CLAWSWEEPER_FIX_STEP_TIMEOUT_MS: "999999999",
      CLAWSWEEPER_FIX_TIMEOUT_RESERVE_MS: "999999999",
    }),
    {
      codexTimeoutMs: 60 * 60_000,
      fixStepTimeoutMs: 110 * 60_000,
      lateWorkerReserveMs: 60 * 60_000,
    },
  );
});

test("overall repair and Actions budgets follow validation configuration with a hard ceiling", () => {
  const configured = resolveTargetRepoToolchain("openclaw/openclaw").validationTimeoutMs;
  const configuredBudget = repairTimeoutBudgetFromEnv({}, configured);
  for (const environment of [
    { CLAWSWEEPER_FIX_TARGET_VALIDATION_TIMEOUT_MS: "invalid" },
    { CLAWSWEEPER_FIX_STEP_TIMEOUT_MS: "invalid" },
  ]) {
    assert.deepEqual(repairTimeoutBudgetFromEnv(environment, configured), configuredBudget);
  }

  let previousStepMs = 0;
  for (const validationMs of [
    60_000,
    20 * 60_000,
    configured ?? DEFAULT_FIX_TARGET_VALIDATION_TIMEOUT_MS,
    Number.MAX_SAFE_INTEGER,
  ].sort((left, right) => left - right)) {
    const budget = repairTimeoutBudgetFromEnv(
      { CLAWSWEEPER_FIX_TARGET_VALIDATION_TIMEOUT_MS: String(validationMs) },
      configured,
    );
    const label = String(validationMs);
    assert.ok(budget.fixStepTimeoutMs >= previousStepMs, label);
    assert.ok(budget.fixStepTimeoutMs >= DEFAULT_FIX_STEP_TIMEOUT_MS, label);
    assert.ok(budget.fixStepTimeoutMs <= MAX_FIX_STEP_TIMEOUT_MS, label);
    // Below the ceiling, the step fits the edit worker and two validation passes.
    assert.ok(
      budget.fixStepTimeoutMs === MAX_FIX_STEP_TIMEOUT_MS ||
        budget.fixStepTimeoutMs >= budget.codexTimeoutMs + 2 * validationMs,
      label,
    );
    // Actions must outlive the executor so it can write its report.
    assert.ok(repairActionsStepTimeoutMinutes(budget) * 60_000 > budget.fixStepTimeoutMs, label);
    previousStepMs = budget.fixStepTimeoutMs;
  }
  assert.equal(previousStepMs, MAX_FIX_STEP_TIMEOUT_MS);

  assert.equal(
    repairTimeoutBudgetFromEnv({ CLAWSWEEPER_FIX_STEP_TIMEOUT_MS: "4200000" }, configured)
      .fixStepTimeoutMs,
    4_200_000,
  );
});

test("repair timeout budget preserves one full later worker after a long edit", () => {
  const budget = repairTimeoutBudgetFromEnv({});
  const editTimeoutMs = repairWorkerTimeoutMs({
    requestedTimeoutMs: budget.codexTimeoutMs,
    remainingBudgetMs: remainingRepairBudgetMs({
      elapsedMs: 35 * 60_000,
      fixStepTimeoutMs: budget.fixStepTimeoutMs,
      reportReserveMs: 90_000,
      minimumTimeoutMs: 30_000,
    }),
    minimumTimeoutMs: 30_000,
    preserveMs: budget.lateWorkerReserveMs,
  });
  assert.equal(editTimeoutMs, 3.5 * 60_000);

  const lateWorkerTimeoutMs = repairWorkerTimeoutMs({
    requestedTimeoutMs: budget.codexTimeoutMs,
    remainingBudgetMs: remainingRepairBudgetMs({
      elapsedMs: 38.5 * 60_000,
      fixStepTimeoutMs: budget.fixStepTimeoutMs,
      reportReserveMs: 90_000,
      minimumTimeoutMs: 30_000,
    }),
    minimumTimeoutMs: 30_000,
  });
  assert.equal(lateWorkerTimeoutMs, budget.codexTimeoutMs);
});
