import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import { readText } from "../helpers.ts";

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
  });
  assert.equal(receipt.transport, "loopback HTTP via GITHUB_API_URL");
});

test("comment router workflow publishes only successfully advanced scan cursors", () => {
  const workflow = readText(".github/workflows/repair-comment-router.yml");
  assert.equal(workflow.match(/scripts\/comment-router-runner\.mjs/g)?.length, 1);
  assert.equal(workflow.match(/scripts\/operator-skip-reasons\.mjs/g)?.length, 1);
  assert.equal(
    workflow.match(
      /publish_args\+=\(--path "results\/comment-router-cursors\/\$\{\{ steps\.target\.outputs\.target_slug \}\}\.json"\)/g,
    )?.length,
    2,
  );
  assert.equal(workflow.match(/\[ "\$cursor_changed" != "true" \]/g)?.length, 2);
});

test("broad comment scans are oldest-first, bounded, and resume from a watermark", () => {
  const source = readText("src/repair/comment-router.ts");
  const listRecent = source.slice(
    source.indexOf("function listRecentComments"),
    source.indexOf("function listCandidateComments"),
  );
  assert.match(listRecent, /issues\/comments\?since=/);
  assert.match(listRecent, /sort=updated&direction=asc/);
  assert.match(listRecent, /ghPagedLimit<LooseRecord>/);
  assert.match(listRecent, /maxComments \+ sinceCommentIds\.size/);
  assert.match(listRecent, /recentCommentCursorCandidate/);
});

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
