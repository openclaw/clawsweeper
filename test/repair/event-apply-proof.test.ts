import assert from "node:assert/strict";
import test from "node:test";

import { eventApplyAction, exactEventApplyProof } from "../../src/repair/event-apply-proof.ts";

test("exact event proof accepts durable sync independently of the apply action name", () => {
  const proof = exactEventApplyProof(
    [
      eventApplyAction({
        number: 42,
        action: "skipped_pr_close_coverage_proof",
        durableReviewSynced: true,
      }),
    ],
    42,
  );

  assert.equal(proof.syncedCount, 1);
  assert.equal(proof.terminalCount, 0);
});

test("exact event proof accepts verified terminal state and rejects action names alone", () => {
  const proof = exactEventApplyProof(
    [
      eventApplyAction({
        number: 42,
        action: "skipped_already_closed",
        terminalStateVerified: true,
      }),
      eventApplyAction({ number: 42, action: "review_comment_synced" }),
      eventApplyAction({ number: 43, action: "closed", terminalStateVerified: true }),
    ],
    42,
  );

  assert.equal(proof.syncedCount, 0);
  assert.equal(proof.terminalCount, 1);
  assert.equal(proof.exactActions.length, 2);
});
