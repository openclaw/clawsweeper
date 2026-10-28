import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";

test(
  "stop preserves protection and retry across failed and uncertain label writes",
  { timeout: 120_000 },
  async (t) => {
    mkdirSync(".artifacts", { recursive: true });
    const output = mkdtempSync(path.resolve(".artifacts/stop-regression-"));
    t.after(() => rmSync(output, { recursive: true, force: true }));
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, ["scripts/e2e/comment-router-stop-loopback.mjs"], {
          env: { ...process.env, STOP_PROOF_OUTPUT: output, STOP_PROOF_BASELINE: "0" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        t.after(() => {
          if (child.exitCode === null) child.kill();
        });
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, stdout, stderr }));
      },
    );
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.baseline, false);
    assert.equal(receipt.scenarios.length, 10);
    assert.ok(
      receipt.scenarios.every(
        (scenario: { retryExit?: number }) =>
          scenario.retryExit === undefined || scenario.retryExit === 0,
      ),
    );
  },
);
