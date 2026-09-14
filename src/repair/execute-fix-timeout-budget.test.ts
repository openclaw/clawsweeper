import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_FIX_CODEX_TIMEOUT_MS,
  DEFAULT_FIX_LATE_WORKER_RESERVE_MS,
  DEFAULT_FIX_STEP_TIMEOUT_MS,
  remainingRepairBudgetMs,
  repairTimeoutBudgetFromEnv,
  repairWorkerTimeoutMs,
  repairTargetValidationTimeoutMs,
} from "./execute-fix-timeout-budget.js";
import { resolveTargetRepoToolchain } from "./target-toolchain-config.js";

test("repair validation budget defaults to eight minutes with an OpenClaw-only pilot", () => {
  for (const repo of ["openclaw/clawsweeper", "openclaw/clawhub", "steipete/example"]) {
    assert.equal(
      repairTargetValidationTimeoutMs({}, resolveTargetRepoToolchain(repo).validationTimeoutMs),
      480_000,
    );
  }
  const configured = resolveTargetRepoToolchain("openclaw/openclaw").validationTimeoutMs;
  assert.equal(configured, 1_200_000);
  assert.equal(repairTargetValidationTimeoutMs({}, configured), 1_200_000);
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
      1_200_000,
    );
    assert.equal(
      repairTargetValidationTimeoutMs({ CLAWSWEEPER_FIX_TARGET_VALIDATION_TIMEOUT_MS: value }),
      480_000,
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
      fixStepTimeoutMs: 70 * 60_000,
      lateWorkerReserveMs: 60 * 60_000,
    },
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
