import assert from "node:assert/strict";
import { proveCompletionSupersession } from "./completion-supersession.mjs";
import { proveSourceAuthorityAcknowledgementRecovery } from "./source-authority-ack-recovery.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  ExactReviewQueue,
  MemoryDurableStorage,
  leasedExactReviewQueueItem,
} from "../../../test/dashboard-worker-harness.ts";

const root = resolve(import.meta.dirname, "../../..");
const output = resolve(process.env.TERMINAL_REVIEW_PROOF_OUTPUT || join(root, ".artifacts/terminal-review-explanations/result.json"));
mkdirSync(dirname(output), { recursive: true });
const scratch = mkdtempSync(join(dirname(output), "fixture-"));
const bin = join(scratch, "bin");
mkdirSync(bin);
const ghPath = join(bin, "gh");
copyFileSync(join(import.meta.dirname, "github-fixture.mjs"), ghPath);
chmodSync(ghPath, 0o700);
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const calls = (path) => readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const post = (queue, endpoint, body) => queue.fetch(new Request("https://clawsweeper-exact-review-queue/" + endpoint, {
  method: "POST", body: JSON.stringify(body),
}));
const scenarios = [];

for (const [index, reason] of ["findings", "incomplete_source", "source_incompatible", "delivery_failure", "receipt_mismatch"].entries()) {
  const item = leasedExactReviewQueueItem(800 + index, String(9800 + index));
  item.decision = {
    ...item.decision, targetRepo: "proof/terminal-review", itemKind: "pull_request",
    sourceEvent: "pull_request", sourceHeadSha: "a".repeat(40),
  };
  item.key = "proof/terminal-review#" + item.decision.itemNumber;
  item.leaseDecision = { ...item.decision };
  const commentId = 80000 + index;
  const commentPath = join(scratch, reason + ".json");
  const callsPath = join(scratch, reason + "-calls.jsonl");
  const outputsPath = join(scratch, reason + "-outputs.txt");
  writeFileSync(commentPath, JSON.stringify({
    id: commentId, user: { login: "clawsweeper" },
    issue_url: "https://api.github.com/repos/proof/terminal-review/issues/" + item.decision.itemNumber,
    updated_at: "2026-09-03T00:00:00.000Z",
    body: "<!-- clawsweeper-pr-ack:opened item=" + item.decision.itemNumber + " -->\nClawSweeper picked this up.",
  }));
  writeFileSync(callsPath, "");
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  let queue = new ExactReviewQueue({ storage }, {});
  const tuple = {
    item_key: item.key, lease_id: item.leaseId, lease_revision: 1,
    run_id: item.claimedRunId, run_attempt: 1, claim_generation: 1,
    source_head_sha: item.decision.sourceHeadSha,
  };
  const heartbeat = (phase) => post(queue, "heartbeat", {
    ...tuple, phase, ...(phase === "status" ? { review_acknowledgement_comment_id: commentId } : {}),
  });
  const update = (state, failureReason, mode = "ok") => {
    writeFileSync(outputsPath, "");
    const args = [join(root, "dist/repair/update-review-status.js"),
      "--repo", "proof/terminal-review", "--item-number", String(item.decision.itemNumber),
      "--status-comment-id", String(commentId), "--state", state,
      "--run-url", "https://github.com/proof/terminal-review/actions/runs/" + item.claimedRunId,
      ...(failureReason ? ["--failure-reason", failureReason] : []),
    ];
    return spawnSync(process.execPath, args, {
      cwd: root, encoding: "utf8", timeout: 30_000,
      env: {
        PATH: bin + ":" + dirname(process.execPath) + ":/usr/bin:/bin",
        HOME: scratch, GITHUB_OUTPUT: outputsPath,
        PROOF_COMMENT: commentPath, PROOF_CALLS: callsPath, PROOF_MODE: mode,
      },
    });
  };

  assert.equal((await heartbeat("status")).status, 200);
  const started = update("reviewing");
  assert.equal(started.status, 0, started.stderr);
  assert.equal((await heartbeat("review")).status, 200);
  assert.match(readJson(commentPath).body, /review in progress/);
  assert.equal((await heartbeat("status")).status, 200);
  const mode = reason === "delivery_failure" ? "fail" : reason === "receipt_mismatch" ? "mismatch" : "ok";
  const failureReason = mode === "ok" ? reason : "findings";
  const mutation = update("blocked", failureReason, mode);
  let receipt;
  if (mode === "ok") {
    assert.equal(mutation.status, 0, mutation.stderr);
    const fields = Object.fromEntries(readFileSync(outputsPath, "utf8").trim().split("\n").map((line) => line.split("=")));
    assert.equal(fields.review_status_verified, "true");
    receipt = { outcome: "observed", comment_id: Number(fields.review_status_comment_id), completed_at: fields.review_status_completed_at };
    const body = readJson(commentPath).body;
    assert.match(body, /no review verdict was produced/);
    assert.match(body, /will not retry this unchanged revision/);
    assert.equal(body.split("clawsweeper-review-progress:start").length - 1, 1);
    assert.doesNotMatch(body, /review in progress/);
    if (reason === "findings") assert.match(body, /remove and rotate.*intentional test fixture/s);
    if (reason === "incomplete_source") assert.match(body, /No contributor action/);
    if (reason === "source_incompatible") assert.match(body, /Update or rebase/);
    const beforeReplay = calls(callsPath).filter((call) => call.method === "PATCH").length;
    assert.equal(update("blocked", failureReason).status, 0);
    assert.equal(calls(callsPath).filter((call) => call.method === "PATCH").length, beforeReplay);
  } else {
    assert.notEqual(mutation.status, 0);
    assert.equal(mutation.error, undefined);
    assert.equal(readFileSync(outputsPath, "utf8"), "");
    receipt = { outcome: "failed", comment_id: commentId };
  }
  assert.equal((await heartbeat("finalizing")).status, 200);
  const completed = await post(queue, "complete", {
    ...tuple, outcome: "failure", review_failure_reason: failureReason,
    review_failure_status: receipt,
  });
  assert.equal(completed.status, 200);
  assert.deepEqual(await completed.json(), { ok: true, requeued: false });
  assert.equal((await storage.get("exact-review-queue")).items[item.key], undefined);
  queue = new ExactReviewQueue({ storage }, {});
  const inventory = await (await post(queue, "review-failures/list", { limit: 10 })).json();
  assert.equal(inventory.attempts[0].terminal_status.outcome, receipt.outcome);
  const stats = await (await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))).json();
  assert.equal(stats.review_failure_health.terminal_status_failed, mode !== "ok" ? 1 : 0);
  if (mode !== "ok") assert.ok(stats.review_failure_health.reasons.includes("terminal_status_delivery_failed"));
  const stale = await heartbeat("status");
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { error: "lease_not_active" });
  const trace = calls(callsPath);
  assert.ok(trace.every((call) => call.comment_id === commentId && ["GET", "PATCH"].includes(call.method)));
  scenarios.push({ reason, receipt: receipt.outcome, requeued: false, persisted_after_queue_restart: true,
    stale_heartbeat_status: stale.status, patch_attempts: trace.filter((call) => call.method === "PATCH").length,
    new_comments: 0, operator_delivery_alert: mode !== "ok" });
}

const completionSupersession = await proveCompletionSupersession();
const sourceAuthorityAcknowledgementRecovery = await proveSourceAuthorityAcknowledgementRecovery();
const result = {
  proof: "terminal-review-explanations-v3",
  source_head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  dirty: execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8" }).trim() !== "",
  runtime: { node: process.version, webhook: "production dashboard worker", queue: "production ExactReviewQueue", updater: "compiled production CLI", persistence: "SQLite-backed Durable Storage harness" },
  scenarios,
  completion_supersession: completionSupersession,
  source_authority_acknowledgement_recovery: sourceAuthorityAcknowledgementRecovery,
  limits: ["Controlled local GitHub CLI and Request/Response fixtures; no GitHub or live queue mutation.", "Runs webhook/queue Request/Response and updater subprocesses, not deployed workerd or a full GitHub Actions job."],
};
writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result));
