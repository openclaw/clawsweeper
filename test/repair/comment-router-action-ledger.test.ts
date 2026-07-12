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

  assert.equal(source.match(/\bghText\(/g)?.length, 1);
  assert.equal(source.match(/\bghSpawn\(/g)?.length, 1);
  assert.doesNotMatch(source, /\bghBestEffort\b/);
  assert.match(source, /function runGitHubTextMutation[\s\S]*runCommandMutation/);
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
