import assert from "node:assert/strict";
import test from "node:test";

import {
  eventApplyAction,
  eventRecordActionTaken,
  exactEventApplyProof,
  exactEventPublishDisposition,
} from "../../src/repair/event-apply-proof.ts";

test("exact event publish dispositions require the current tuple and prefer terminal closure", () => {
  assert.deepEqual(
    exactEventPublishDisposition({
      candidateMatchesCurrentTuple: true,
      candidateTupleState: "closed",
      terminalClosedExpected: true,
      guardedOpenAction: "skipped_protected_label",
    }),
    { terminalClosed: true, guardedOpenAction: null },
  );
  assert.deepEqual(
    exactEventPublishDisposition({
      candidateMatchesCurrentTuple: false,
      candidateTupleState: "closed",
      terminalClosedExpected: true,
      guardedOpenAction: null,
    }),
    { terminalClosed: false, guardedOpenAction: null },
  );
  assert.deepEqual(
    exactEventPublishDisposition({
      candidateMatchesCurrentTuple: true,
      candidateTupleState: "open",
      terminalClosedExpected: false,
      guardedOpenAction: "skipped_locked_conversation",
    }),
    { terminalClosed: false, guardedOpenAction: "skipped_locked_conversation" },
  );
  assert.deepEqual(
    exactEventPublishDisposition({
      candidateMatchesCurrentTuple: true,
      candidateTupleState: "open",
      terminalClosedExpected: true,
      guardedOpenAction: null,
    }),
    { terminalClosed: false, guardedOpenAction: null },
  );
});

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
    null,
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
    null,
  );

  assert.equal(proof.syncedCount, 0);
  assert.equal(proof.terminalCount, 1);
  assert.equal(proof.exactActions.length, 2);
});

test("exact event proof completes live-shaped deterministic guarded-open results", () => {
  for (const action of [
    "skipped_same_author_pair",
    "skipped_open_closing_pr",
    "skipped_protected_label",
    "skipped_maintainer_authored",
    "skipped_locked_conversation",
  ]) {
    const snapshot = `---\nrepository: openclaw/openclaw\nnumber: 91668\naction_taken: ${action}\n---\n`;
    const proof = exactEventApplyProof(
      [eventApplyAction({ number: 91668, action, guardedOpenStateVerified: true })],
      91668,
      eventRecordActionTaken(snapshot),
    );

    assert.equal(proof.guardedOpenAction, action);
    assert.equal(proof.latestRevisionRequeueRequired, false);
  }
});

test("exact event proof keeps changed-since-review on the latest-revision requeue path", () => {
  const action = "skipped_changed_since_review";
  const snapshot = `---\nrepository: openclaw/openclaw\nnumber: 91668\naction_taken: ${action}\n---\n`;
  const proof = exactEventApplyProof(
    [eventApplyAction({ number: 91668, action })],
    91668,
    eventRecordActionTaken(snapshot),
  );

  assert.equal(proof.guardedOpenAction, null);
  assert.equal(proof.latestRevisionRequeueRequired, true);
});

test("guarded-open proof rejects mismatches, extra results, and transient skips", () => {
  const snapshotAction = "skipped_same_author_pair";
  const transientActions = [
    "skipped_changed_since_review",
    "skipped_runtime_budget",
    "skipped_stale_review_comment_sync",
    "skipped_pr_close_coverage_proof",
    "skipped_comment_auth",
    "skipped_invalid_decision",
    "skipped_missing_record",
    "retry_pr_close_coverage_proof",
    "retry_stale_canonical_comment_sync",
  ];

  for (const action of transientActions) {
    const proof = exactEventApplyProof([eventApplyAction({ number: 42, action })], 42, action);
    assert.equal(proof.guardedOpenAction, null, action);
  }

  assert.equal(
    exactEventApplyProof(
      [eventApplyAction({ number: 43, action: snapshotAction })],
      42,
      snapshotAction,
    ).guardedOpenAction,
    null,
  );
  assert.equal(
    exactEventApplyProof(
      [eventApplyAction({ number: 42, action: snapshotAction })],
      42,
      snapshotAction,
    ).guardedOpenAction,
    null,
  );
  assert.equal(
    exactEventApplyProof(
      [eventApplyAction({ number: 42, action: "skipped_protected_label" })],
      42,
      snapshotAction,
    ).guardedOpenAction,
    null,
  );
  assert.equal(
    exactEventApplyProof(
      [
        eventApplyAction({ number: 42, action: snapshotAction }),
        eventApplyAction({ number: 0, action: "skipped_runtime_budget" }),
      ],
      42,
      snapshotAction,
    ).guardedOpenAction,
    null,
  );
});

test("event record action parsing ignores body lookalikes", () => {
  assert.equal(eventRecordActionTaken("action_taken: skipped_same_author_pair"), null);
  assert.equal(
    eventRecordActionTaken(
      "---\nrepository: openclaw/openclaw\n---\naction_taken: skipped_same_author_pair\n",
    ),
    null,
  );
});
