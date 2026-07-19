import assert from "node:assert/strict";
import test from "node:test";

import { decideReviewDispatchCoordination } from "../../src/repair/review-dispatch-coordination.ts";

const head = "a".repeat(40);

function decision(overrides: Partial<Parameters<typeof decideReviewDispatchCoordination>[0]> = {}) {
  return decideReviewDispatchCoordination({
    stateBefore: "OPEN",
    stateAfter: "OPEN",
    headBefore: head,
    headAfter: head,
    activeLeaseExpiresAt: null,
    completedReviewAt: null,
    completedReviewCommentId: null,
    ...overrides,
  });
}

test("dispatches when the open PR head is stable and has no reusable review", () => {
  assert.deepEqual(decision(), { action: "dispatch" });
});

test("stops when the target closes between observations", () => {
  assert.deepEqual(decision({ stateAfter: "CLOSED" }), {
    action: "stop",
    reason: "target is no longer an open PR",
  });
});

test("retries when the PR head changes between observations", () => {
  assert.equal(decision({ headAfter: "b".repeat(40) }).action, "retry");
});

test("waits for an active exact-head review", () => {
  const result = decision({ activeLeaseExpiresAt: "2026-07-17T14:13:17.000Z" });
  assert.equal(result.action, "wait_for_active_review");
  assert.match(result.reason, /active until 2026-07-17T14:13:17\.000Z/);
});

test("reuses a same-head review completed since the command", () => {
  const result = decision({
    completedReviewAt: "2026-07-17T14:10:00.000Z",
    completedReviewCommentId: 1234,
  });
  assert.equal(result.action, "reuse_completed_review");
  assert.equal(result.commentId, 1234);
  assert.match(result.reason, /result will be reused/);
});

test("an active lease wins over a completed marker", () => {
  assert.equal(
    decision({
      activeLeaseExpiresAt: "2026-07-17T14:13:17.000Z",
      completedReviewAt: "2026-07-17T14:10:00.000Z",
      completedReviewCommentId: 1234,
    }).action,
    "wait_for_active_review",
  );
});
