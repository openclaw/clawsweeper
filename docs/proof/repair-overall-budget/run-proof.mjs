import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildFixPrompt, renderWorkerValidationGuidance } from "../../../dist/repair/fix-prompt-builder.js";
import { MAX_FIX_STEP_TIMEOUT_MS, repairActionsStepTimeoutMinutes, repairTimeoutBudgetFromEnv } from "../../../dist/repair/execute-fix-timeout-budget.js";
import { resolveTargetRepoToolchain } from "../../../dist/repair/target-toolchain-config.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repair-overall-budget-proof-"));
const trace = { platform: process.platform, node: process.version, scenarios: [] };
try {
  const job = path.join(dir, "job.md");
  fs.writeFileSync(job, "---\nrepo: openclaw/openclaw\n---\nSynthetic budget fixture.\n");
  // The resolver script must apply the configured budget for the job's repository; the expected
  // values come from the budget module and the config, not a copy of either.
  const configuredValidationMs = resolveTargetRepoToolchain("openclaw/openclaw").validationTimeoutMs;
  for (const [validation, step] of [
    ["", ""], ["1200000", ""], ["9007199254740991", ""],
    ["", "4200000"], ["invalid", "invalid"],
  ]) {
    const output = path.join(dir, `output-${trace.scenarios.length}`);
    const env = {
      CLAWSWEEPER_FIX_TARGET_VALIDATION_TIMEOUT_MS: validation,
      CLAWSWEEPER_FIX_STEP_TIMEOUT_MS: step,
      CLAWSWEEPER_FIX_CODEX_TIMEOUT_MS: "1800000",
      CLAWSWEEPER_FIX_TIMEOUT_RESERVE_MS: "1800000",
    };
    const stdout = execFileSync(process.execPath, ["scripts/resolve-repair-timeout-budget.mjs", job], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: output, ...env },
    });
    const budget = repairTimeoutBudgetFromEnv(env, configuredValidationMs);
    const expected = repairActionsStepTimeoutMinutes(budget);
    assert.equal(fs.readFileSync(output, "utf8"), `timeout_minutes=${expected}\n`);
    const scenario = JSON.parse(stdout);
    assert.deepEqual(scenario, { ...budget, actionsStepTimeoutMinutes: expected });
    assert.ok(scenario.fixStepTimeoutMs <= MAX_FIX_STEP_TIMEOUT_MS);
    assert.ok(expected * 60_000 > scenario.fixStepTimeoutMs, "Actions must outlive the executor");
    if (validation === "9007199254740991") assert.equal(scenario.fixStepTimeoutMs, MAX_FIX_STEP_TIMEOUT_MS);
    if (step === "4200000") assert.equal(scenario.fixStepTimeoutMs, 4_200_000);
    trace.scenarios.push(scenario);
  }
  for (const isAutomergeRepair of [false, true]) {
    const prompt = buildFixPrompt({ fixArtifact: { validation_commands: ["pnpm check:changed"] }, isAutomergeRepair });
    assert.ok(prompt.includes(renderWorkerValidationGuidance()));
    assert.match(prompt, /do not run `pnpm check:changed`, its full-gate aliases/);
    trace.scenarios.push({ isAutomergeRepair, acceptanceOwner: "executor" });
  }
  const json = `${JSON.stringify(trace, null, 2)}\n`;
  if (process.argv[2]) fs.writeFileSync(process.argv[2], json);
  process.stdout.write(json);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
