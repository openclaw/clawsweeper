import assert from "node:assert/strict";
import test from "node:test";

import { readText } from "../helpers.ts";

test("comment router records receipts after durable command boundaries", () => {
  const source = readText("src/repair/comment-router.ts");

  assert.match(source, /rawCommands\.push\(command\);\s+recordCommandReceived\(command\);/);
  assert.match(
    source,
    /writeLedger\(ledgerPath\(\), ledger\);\s+for \(const command of claimedCommands\) recordCommandClaimed\(command\);/,
  );
  assert.match(
    source,
    /writeLedger\(ledgerPath\(\), ledger\);\s+for \(const key of dispatchClaimLookupKeys\(claim\)\) priorDispatchClaims\.set\(key, claim\);\s+recordCommandClaimRefreshed\(claim\);/,
  );
  assert.match(
    source,
    /function executeCommandWithReceipt[\s\S]*executeCommand\(command\);\s+recordCommandOutcome\(command\);[\s\S]*recordCommandFailure\(command, error\);/,
  );
  assert.match(source, /await flushCommandActionEvents\(\);/);
});

test("comment router wraps every GitHub mutation at the request boundary", () => {
  const source = readText("src/repair/comment-router.ts");

  assert.equal(source.match(/\bghText\(/g)?.length, 2);
  assert.equal(source.match(/\bghSpawn\(/g)?.length, 1);
  assert.doesNotMatch(source, /\bghBestEffort\b/);
  assert.doesNotMatch(source, /ghTextWithRetry as ghText/);
  assert.match(source, /function runGitHubTextMutation[\s\S]*runCommandMutationWithRetry/);
  assert.match(source, /function runGitHubBestEffortMutation[\s\S]*runGitHubTextMutationOnce/);
  assert.match(source, /function runGitHubSpawnMutation[\s\S]*runCommandMutation/);
  for (const kind of [
    "label_create",
    "label_add",
    "label_remove",
    "description_update",
    "reaction_add",
    "reaction_delete",
    "ack_comment_update",
    "ack_comment_delete",
    "comment_create",
    "comment_update",
    "pull_request_close",
    "issue_close",
    "pull_request_merge",
    "review_dispatch",
    "assist_dispatch",
    "repair_dispatch",
  ]) {
    assert.match(source, new RegExp(`"${kind}"`), kind);
  }
});

test("trusted verdict mutations refresh reviewed PR activity before dispatch", () => {
  const source = readText("src/repair/comment-router.ts");
  const executeCommand = source.slice(
    source.indexOf("function executeCommand("),
    source.indexOf("function executeCommandWithReceipt("),
  );
  const executeAutomerge = source.slice(
    source.indexOf("function executeAutomerge("),
    source.indexOf("function latestAutomergeTarget("),
  );
  const commandPreflight = executeCommand.indexOf(
    "const trustedAutomationActivityBlock = trustedAutomationReviewActivityBlockReason(command)",
  );
  const labelMutation = executeCommand.indexOf("applyLabelActions(command)");
  const waitLoop = executeAutomerge.indexOf("while (block && isTransientAutomergeBlock(block)");
  const initialReviewActivity = executeAutomerge.indexOf(
    "const initialReviewActivityBlock = trustedAutomationReviewActivityBlockReason(command)",
  );
  const reviewLease = executeAutomerge.indexOf(
    "const reviewLeaseBlock = trustedAutomationReviewLeaseBlockReason(command)",
  );
  const reviewActivity = executeAutomerge.indexOf(
    "const reviewActivityBlock = trustedAutomationReviewActivityBlockReason(command)",
  );
  const merge = executeAutomerge.indexOf("const result = runGitHubSpawnMutation(");

  assert.ok(commandPreflight >= 0);
  assert.ok(labelMutation > commandPreflight);
  assert.ok(initialReviewActivity >= 0);
  assert.ok(waitLoop > initialReviewActivity);
  assert.ok(waitLoop >= 0);
  assert.ok(reviewLease > waitLoop);
  assert.ok(reviewActivity > reviewLease);
  assert.ok(merge > reviewActivity);
  assert.match(
    source,
    /expected_review_activity_cursor: parsed\.expected_review_activity_cursor \?\? null/,
  );
  assert.match(
    source,
    /function trustedAutomationReviewActivityCursorOnce[\s\S]*pulls\/\$\{number\}\/reviews[\s\S]*pulls\/\$\{number\}\/comments[\s\S]*function trustedAutomationReviewActivityCursor[\s\S]*readStableReviewedPrActivityCursor[\s\S]*function trustedAutomationReviewActivityBlockReason[\s\S]*clawsweeper_auto_repair[\s\S]*isReviewedPrActivityCursor\(expected\)/,
  );
  assert.match(
    source,
    /inlineComments\.length === 0 \? \[\] : trustedAutomationReviewThreads\(number, remaining \+ 1\)/,
  );
  for (const wrapper of [
    "runGitHubTextMutation",
    "runGitHubTextMutationOnce",
    "runGitHubSpawnMutation",
  ]) {
    const start = source.indexOf(`function ${wrapper}(`);
    const end = source.indexOf("\nfunction ", start + 1);
    const implementation = source.slice(start, end);
    assert.match(implementation, /runReviewedPrActivityGuardedMutation/);
    assert.match(
      implementation,
      /refresh: \(\) => trustedAutomationReviewActivityBlockReason\(command\)/,
    );
  }
  assert.match(
    source,
    /function runGitHubBestEffortMutation[\s\S]*error instanceof ReviewedPrActivityGuardError[\s\S]*throw error/,
  );
  assert.match(
    readText("src/repair/comment-router-core.ts"),
    /function trustedRepair[\s\S]*expected_review_activity_cursor: marker\?\.attrs\?\.review_activity_cursor \?\? null/,
  );
  assert.match(
    readText("src/repair/comment-router-core.ts"),
    /function trustedClose[\s\S]*expected_review_activity_cursor: marker\?\.attrs\?\.review_activity_cursor \?\? null/,
  );
  assert.match(
    source,
    /function trustedAutomationReviewActivityBlockReason[\s\S]*!command\.trusted_bot[\s\S]*"autoclose"[\s\S]*"clawsweeper_needs_human"[\s\S]*intent === "autoclose" && command\.target\?\.kind !== "pull_request"/,
  );
});

test("exact comment convergence classifies a missing comment as no mutation", () => {
  const source = readText("src/repair/comment-router.ts");
  const fastPath = source.slice(source.indexOf("function convergeExactCommentVersionFastPathAck"));

  assert.match(source, /function githubNotFoundNoMutation[\s\S]*isGitHubNotFoundError\(error\)/);
  assert.match(
    fastPath,
    /"ack_comment_update"[\s\S]*githubNotFoundNoMutation[\s\S]*return "already_converged"/,
  );
});

test("forced replay attempt identity flows through the production workflow", () => {
  const source = readText("src/repair/comment-router.ts");
  const workflow = readText(".github/workflows/repair-comment-router.yml");

  assert.match(source, /forcedReplayCommandFields\(\{ forceReprocess, attemptId \}\)/);
  assert.match(workflow, /attempt_id:/);
  assert.match(workflow, /attempt_id="forced-replay-\$\{GITHUB_RUN_ID\}"/);
  assert.equal(workflow.match(/args\+=\(--attempt-id "\$attempt_id"\)/g)?.length, 2);
});

test("command receipt identity excludes list position and binds command attempts", () => {
  const source = readText("src/repair/command-action-ledger.ts");

  assert.match(source, /idempotencyKey: String\(command\.idempotency_key/);
  assert.match(source, /commentBodySha256: sha256OrNull\(command\.comment_body_sha256\)/);
  assert.match(source, /const attemptId = commandDurableAttemptId\(command\)/);
  assert.match(source, /\.\.\.\(attemptId \? \{ attemptId \} : \{\}\)/);
  assert.match(source, /durableAttemptId: commandDurableAttemptId\(command\)/);
  assert.match(source, /invocation: String\(process\.env\.CLAWSWEEPER_ACTION_LEDGER_INVOCATION/);
  assert.doesNotMatch(source, /\bindex\b/);
});
