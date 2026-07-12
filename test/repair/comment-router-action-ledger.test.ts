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

test("command receipt identity excludes list position and binds immutable command versions", () => {
  const source = readText("src/repair/command-action-ledger.ts");

  assert.match(source, /idempotencyKey: String\(command\.idempotency_key/);
  assert.match(source, /commentBodySha256: sha256OrNull\(command\.comment_body_sha256\)/);
  assert.match(source, /invocation: String\(process\.env\.CLAWSWEEPER_ACTION_LEDGER_INVOCATION/);
  assert.doesNotMatch(source, /\bindex\b/);
});
