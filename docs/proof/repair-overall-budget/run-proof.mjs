import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildFixPrompt, renderWorkerValidationGuidance } from "../../../dist/repair/fix-prompt-builder.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repair-overall-budget-proof-"));
const trace = { platform: process.platform, node: process.version, scenarios: [] };
try {
  const job = path.join(dir, "job.md");
  fs.writeFileSync(job, "---\nrepo: openclaw/openclaw\n---\nSynthetic budget fixture.\n");
  for (const [validation, step, expected] of [
    ["", "", 102], ["1200000", "", 92], ["9007199254740991", "", 112],
    ["", "4200000", 72], ["invalid", "invalid", 102],
  ]) {
    const output = path.join(dir, `output-${trace.scenarios.length}`);
    const stdout = execFileSync(process.execPath, ["scripts/resolve-repair-timeout-budget.mjs", job], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: output,
        CLAWSWEEPER_FIX_TARGET_VALIDATION_TIMEOUT_MS: validation,
        CLAWSWEEPER_FIX_STEP_TIMEOUT_MS: step,
        CLAWSWEEPER_FIX_CODEX_TIMEOUT_MS: "1800000",
        CLAWSWEEPER_FIX_TIMEOUT_RESERVE_MS: "1800000" },
    });
    assert.equal(fs.readFileSync(output, "utf8"), `timeout_minutes=${expected}\n`);
    trace.scenarios.push(JSON.parse(stdout));
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
