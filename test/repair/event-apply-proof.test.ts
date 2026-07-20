import assert from "node:assert/strict";
import test from "node:test";

import {
  eventApplyAction,
  eventApplyRequeueLatestExpected,
  eventRecordActionTaken,
  exactEventApplyProof,
  exactEventPublishDisposition,
  exactEventRoutingDeferred,
} from "../../src/repair/event-apply-proof.ts";

test("exact event publish dispositions require the current tuple and preserve terminal precedence", () => {
  assert.deepEqual(
    exactEventPublishDisposition({
      candidateMatchesCurrentTuple: true,
      candidateTupleState: "closed",
      terminalClosedExpected: true,
      terminalMissingExpected: false,
      guardedOpenAction: "skipped_protected_label",
    }),
    {
      terminalClosed: true,
      terminalMissing: false,
      routableSyncVerified: false,
      guardedOpenAction: null,
    },
  );
  assert.deepEqual(
    exactEventPublishDisposition({
      candidateMatchesCurrentTuple: false,
      candidateTupleState: "closed",
      terminalClosedExpected: true,
      terminalMissingExpected: false,
      guardedOpenAction: null,
    }),
    {
      terminalClosed: false,
      terminalMissing: false,
      routableSyncVerified: false,
      guardedOpenAction: null,
    },
  );
  assert.deepEqual(
    exactEventPublishDisposition({
      candidateMatchesCurrentTuple: true,
      candidateTupleState: "open",
      terminalClosedExpected: false,
      terminalMissingExpected: false,
      guardedOpenAction: "skipped_locked_conversation",
    }),
    {
      terminalClosed: false,
      terminalMissing: false,
      routableSyncVerified: false,
      guardedOpenAction: "skipped_locked_conversation",
    },
  );
  assert.deepEqual(
    exactEventPublishDisposition({
      candidateMatchesCurrentTuple: true,
      candidateTupleState: "open",
      terminalClosedExpected: true,
      terminalMissingExpected: false,
      guardedOpenAction: null,
    }),
    {
      terminalClosed: false,
      terminalMissing: false,
      routableSyncVerified: false,
      guardedOpenAction: null,
    },
  );
  assert.deepEqual(
    exactEventPublishDisposition({
      candidateMatchesCurrentTuple: true,
      candidateTupleState: "closed",
      terminalClosedExpected: false,
      terminalMissingExpected: true,
      guardedOpenAction: "skipped_locked_conversation",
    }),
    {
      terminalClosed: false,
      terminalMissing: true,
      routableSyncVerified: false,
      guardedOpenAction: null,
    },
  );
  for (const candidate of [
    { candidateMatchesCurrentTuple: false, candidateTupleState: "closed" as const },
    { candidateMatchesCurrentTuple: true, candidateTupleState: "open" as const },
  ]) {
    assert.deepEqual(
      exactEventPublishDisposition({
        ...candidate,
        terminalClosedExpected: false,
        terminalMissingExpected: true,
        guardedOpenAction: null,
      }),
      {
        terminalClosed: false,
        terminalMissing: false,
        routableSyncVerified: false,
        guardedOpenAction: null,
      },
    );
  }
});

test("exact event publish dispositions reject stale routable sync tuples", () => {
  assert.equal(
    exactEventPublishDisposition({
      candidateMatchesCurrentTuple: true,
      candidateTupleState: "open",
      terminalClosedExpected: false,
      terminalMissingExpected: false,
      guardedOpenAction: null,
      routableSyncExpected: true,
    }).routableSyncVerified,
    true,
  );
  for (const candidate of [
    { candidateMatchesCurrentTuple: false, candidateTupleState: "open" as const },
    { candidateMatchesCurrentTuple: false, candidateTupleState: "closed" as const },
    { candidateMatchesCurrentTuple: true, candidateTupleState: "invalid" as const },
  ]) {
    assert.equal(
      exactEventPublishDisposition({
        ...candidate,
        terminalClosedExpected: false,
        terminalMissingExpected: false,
        guardedOpenAction: null,
        routableSyncExpected: true,
      }).routableSyncVerified,
      false,
    );
  }
});

test("exact event routing defers only current nonterminal verdicts", () => {
  assert.equal(
    exactEventRoutingDeferred({
      candidateMatchesCurrentTuple: true,
      candidateTupleState: "open",
      guardedOpenAction: null,
      requeueLatestExpected: false,
    }),
    true,
  );
  for (const candidate of [
    {
      candidateMatchesCurrentTuple: false,
      candidateTupleState: "open" as const,
      guardedOpenAction: null,
      requeueLatestExpected: false,
    },
    {
      candidateMatchesCurrentTuple: true,
      candidateTupleState: "closed" as const,
      guardedOpenAction: null,
      requeueLatestExpected: false,
    },
    {
      candidateMatchesCurrentTuple: true,
      candidateTupleState: "open" as const,
      guardedOpenAction: "skipped_locked_conversation",
      requeueLatestExpected: false,
    },
    {
      candidateMatchesCurrentTuple: true,
      candidateTupleState: "open" as const,
      guardedOpenAction: null,
      requeueLatestExpected: true,
    },
  ]) {
    assert.equal(exactEventRoutingDeferred(candidate), false);
  }
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
  assert.equal(proof.terminalMissingCount, 0);
  assert.equal(proof.terminalCount, 0);
  assert.equal(proof.disposition, "applied");
});

test("ordinary kept-open sync cannot route after its live tuple changes", () => {
  const proof = exactEventApplyProof(
    [
      eventApplyAction({
        number: 42,
        action: "kept_open",
        durableReviewSynced: true,
      }),
    ],
    42,
    null,
  );
  assert.equal(proof.syncedCount, 1);
  assert.equal(proof.terminalCount, 0);
  assert.equal(proof.terminalMissingCount, 0);
  assert.equal(proof.guardedOpenAction, null);

  const disposition = exactEventPublishDisposition({
    candidateMatchesCurrentTuple: false,
    candidateTupleState: "open",
    terminalClosedExpected: false,
    terminalMissingExpected: false,
    guardedOpenAction: proof.guardedOpenAction,
    routableSyncExpected: proof.syncedCount > 0,
  });
  assert.equal(disposition.routableSyncVerified, false);
});

test("exact event proof distinguishes confirmed missing items from closed state", () => {
  const proof = exactEventApplyProof(
    [
      eventApplyAction({
        number: 42,
        action: "skipped_already_closed",
        terminalMissingVerified: true,
      }),
    ],
    42,
    null,
  );

  assert.equal(proof.terminalMissingCount, 1);
  assert.equal(proof.terminalCount, 0);
  assert.equal(
    exactEventApplyProof(
      [eventApplyAction({ number: 42, action: "skipped_already_closed" })],
      42,
      null,
    ).terminalMissingCount,
    0,
  );
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
  assert.equal(proof.disposition, "applied");
});

test("exact event proof accepts only explicit trusted no-action dispositions", () => {
  const terminalPolicy = exactEventApplyProof(
    [
      eventApplyAction({
        number: 42,
        action: "skipped_same_author_pair",
        terminalPolicyNoopVerified: true,
      }),
    ],
    42,
  );
  const sourceDrift = exactEventApplyProof(
    [
      eventApplyAction({
        number: 42,
        action: "skipped_changed_since_review",
        sourceDriftVerified: true,
      }),
    ],
    42,
  );
  const unproven = exactEventApplyProof(
    [eventApplyAction({ number: 42, action: "skipped_same_author_pair" })],
    42,
  );

  assert.equal(terminalPolicy.disposition, "terminal_policy_noop");
  assert.equal(sourceDrift.disposition, "source_drift");
  assert.equal(unproven.disposition, "unproven");
});

test("exact event proof defers a close-coverage retry to the proof-capable apply lane", () => {
  const proof = exactEventApplyProof(
    [eventApplyAction({ number: 42, action: "retry_pr_close_coverage_proof" })],
    42,
  );

  assert.equal(proof.disposition, "close_coverage_deferred");
  assert.equal(
    eventApplyRequeueLatestExpected({
      disposition: proof.disposition,
      exactEventPublication: true,
      legacyTuplelessReviewLease: proof.legacyTuplelessReviewLease,
    }),
    false,
  );
});

test("exact event proof defers only a verified active review lease until its expiry", () => {
  const snapshot =
    "---\nrepository: openclaw/openclaw\nnumber: 42\naction_taken: proposed_close\n---\n";
  const retryAt = "2026-07-20T08:44:43.900Z";
  const verified = exactEventApplyProof(
    [
      eventApplyAction({
        number: 42,
        action: "kept_open",
        activeReviewLeaseVerified: true,
        activeReviewLeaseExpiresAt: retryAt,
      }),
    ],
    42,
    eventRecordActionTaken(snapshot),
  );
  assert.equal(verified.activeReviewLeaseRetryAt, retryAt);

  for (const action of ["skipped_locked_conversation", "kept_open"]) {
    const proof = exactEventApplyProof(
      [
        eventApplyAction({
          number: 42,
          action,
          activeReviewLeaseVerified: action === "kept_open",
          activeReviewLeaseExpiresAt: "not-a-timestamp",
        }),
      ],
      42,
      eventRecordActionTaken(snapshot),
    );
    assert.equal(proof.activeReviewLeaseRetryAt, null, action);
  }

  const tooLong = exactEventApplyProof(
    [
      eventApplyAction({
        number: 42,
        action: "kept_open",
        activeReviewLeaseVerified: true,
        activeReviewLeaseExpiresAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
      }),
    ],
    42,
    eventRecordActionTaken(snapshot),
  ).activeReviewLeaseRetryAt;
  assert.ok(tooLong !== null);
  assert.ok(Date.parse(tooLong) <= Date.now() + 2 * 60 * 60 * 1000);
});
test("exact event proof completes live-shaped deterministic guarded-open results", () => {
  for (const action of [
    "skipped_same_author_pair",
    "skipped_open_closing_pr",
    "skipped_protected_label",
    "skipped_close_exempt_label",
    "skipped_maintainer_authored",
    "skipped_locked_conversation",
    "skipped_low_signal_live_guard",
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

test("exact event proof requeues only the guarded legacy tuple-less artifact path", () => {
  const legacy = exactEventApplyProof(
    [
      eventApplyAction({
        number: 42,
        action: "skipped_stale_review_comment_sync",
        reason:
          "live durable review tuple has lease comment 4979165844, but the local report has no durable lease identity",
      }),
    ],
    42,
  );
  const newerVerdict = exactEventApplyProof(
    [
      eventApplyAction({
        number: 42,
        action: "skipped_stale_review_comment_sync",
        reason: "live durable review comment is newer than the local report",
      }),
    ],
    42,
  );

  assert.equal(legacy.legacyTuplelessReviewLease, true);
  assert.equal(newerVerdict.legacyTuplelessReviewLease, false);
  assert.equal(
    eventApplyRequeueLatestExpected({
      disposition: legacy.disposition,
      exactEventPublication: true,
      legacyTuplelessReviewLease: legacy.legacyTuplelessReviewLease,
    }),
    true,
  );
  assert.equal(
    eventApplyRequeueLatestExpected({
      disposition: newerVerdict.disposition,
      exactEventPublication: true,
      legacyTuplelessReviewLease: newerVerdict.legacyTuplelessReviewLease,
    }),
    false,
  );
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

test("verified source drift overrides an earlier durable sync", () => {
  const verified = exactEventApplyProof(
    [
      eventApplyAction({
        number: 42,
        action: "review_comment_synced",
        durableReviewSynced: true,
      }),
      eventApplyAction({
        number: 42,
        action: "skipped_changed_since_review",
        sourceDriftVerified: true,
      }),
    ],
    42,
  );
  const unverified = exactEventApplyProof(
    [
      eventApplyAction({
        number: 42,
        action: "review_comment_synced",
        durableReviewSynced: true,
      }),
      eventApplyAction({ number: 42, action: "skipped_changed_since_review" }),
    ],
    42,
  );

  assert.equal(verified.disposition, "source_drift");
  assert.equal(unverified.disposition, "unproven");
});
