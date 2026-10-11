import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parse as parseYaml } from "yaml";

import {
  sourceSparseCheckoutEntries,
  sparseEntriesCover,
} from "./workflow-sparse-checkout-helpers.ts";

test("comment router defers GitHub throttles without advancing its cursor", async () => {
  const result = await runNode("scripts/e2e/comment-router-throttle-loopback.mjs");
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const receipt = JSON.parse(result.stdout);
  assert.deepEqual(receipt.assertions, {
    throttle_exit_zero: true,
    abuse_403_exit_zero: true,
    throttle_429_exit_zero: true,
    structured_skip: true,
    routable_data_completed: true,
    cursor_unchanged: true,
    cursor_resumed_incrementally: true,
    real_error_nonzero: true,
    stale_report_retired: true,
    undiscovered_explicit_comment_not_counted: true,
    empty_finalization_succeeded: true,
    partial_receipts_finalized: true,
    throttled_write_stops_command: true,
    deleted_ack_converges_without_write: true,
    forced_replay_attempt_routed: true,
    review_uses_canonical_queue: true,
    multiline_review_context_preserved: true,
    retired_commands_reply_once: true,
  });
  assert.equal(receipt.transport, "loopback HTTP via GITHUB_API_URL");
});

test("comment router workflow publishes only successfully advanced scan cursors", (t) => {
  const entries = sourceSparseCheckoutEntries(".github/workflows/repair-comment-router.yml");
  for (const script of ["scripts/comment-router-runner.mjs", "scripts/operator-skip-reasons.mjs"]) {
    assert.ok(sparseEntriesCover(entries, script), script);
  }

  const workflow = parseYaml(
    readFileSync(".github/workflows/repair-comment-router.yml", "utf8"),
  ) as { jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }> };
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
  const directory = mkdtempSync(path.join(tmpdir(), "clawsweeper-router-cursor-publish-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const run = steps.find((step) => step.name === "Commit comment router ledger")?.run;
  assert.ok(run);
  assert.deepEqual(publishArgs(path.join(directory, "unchanged"), run, false), []);
  const publish = publishArgs(path.join(directory, "changed"), run, true);
  assert.deepEqual(publish.slice(0, 2), ["run", "repair:publish-main"]);
  assert.deepEqual(publish.slice(-2), [
    "--path",
    "results/comment-router-cursors/openclaw-openclaw.json",
  ]);
});

// Run the publish step with an unchanged ledger, and return the publish call.
function publishArgs(cwd: string, run: string, cursorChanged: boolean): string[] {
  mkdirSync(path.join(cwd, "results"), { recursive: true });
  writeFileSync(
    path.join(cwd, "results", "comment-router-latest.json"),
    JSON.stringify({ routing_cursor_changed: cursorChanged, ledger_claimed: 0, ledger_changed: 0 }),
  );
  const script = run.replaceAll("${{ steps.target.outputs.target_slug }}", "openclaw-openclaw");
  const output = execFileSync("bash", ["-eu", "-c", `pnpm() { printf '%s\\n' "$@"; }\n${script}`], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  return output.includes("skipping state publication") ? [] : output.trim().split("\n");
}

function runNode(script: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [script], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
