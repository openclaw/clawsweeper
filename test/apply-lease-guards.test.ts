import assert from "node:assert/strict";
import test from "node:test";

import { createApplyLeaseGuards } from "../dist/clawsweeper-apply-lease-guards.js";
import { renderReviewStartStatusComment } from "../dist/clawsweeper.js";

const headSha = "a".repeat(40);
const leaseOwner = "exact-pr-42";
const lease = { owner: leaseOwner, commentId: 700042, headSha };
const startedAt = new Date().toISOString();
const leaseComment = {
  id: lease.commentId,
  user: { login: "clawsweeper[bot]" },
  created_at: startedAt,
  updated_at: startedAt,
  body: renderReviewStartStatusComment({
    number: 42,
    kind: "pull_request",
    title: "Lease guard proof",
    headSha,
    startedAt,
    leaseExpiresAt: new Date(Date.parse(startedAt) + 10 * 60_000).toISOString(),
    leaseOwner,
    purpose: "apply",
  }),
};

function leaseGuards(calls: string[], activityBlock: string | null = null) {
  return createApplyLeaseGuards({
    canonicalBoundStaleReviewReason: () => {
      calls.push("canonical");
      return null;
    },
    closeDelayMs: 0,
    currentReviewActivityBlock: () => {
      calls.push("activity");
      return activityBlock;
    },
    dryRun: false,
    frontMatterValue: () => undefined,
    getActiveApplyMutationLease: () => ({ itemNumber: 42, lease }),
    ghJson: () => {
      calls.push("pull");
      return { head: { sha: headSha } };
    },
    GitHubRuntimeBudgetError: class extends Error {},
    initialReviewHeadSha: headSha,
    issueReviewCommentState: () => {
      calls.push("comments");
      return { comments: [leaseComment], leaseComments: [leaseComment] };
    },
    item: { kind: "pull_request" },
    liveIssueSourceRevision: () => headSha,
    markdownBeforeApplyDecisionMutations: "",
    number: 42,
    PATCHABLE_REVIEW_COMMENT_AUTHORS: new Set(["clawsweeper[bot]"]),
    postReviewStartStatusComment: () => ({ status: "posted", lease }),
    reportReviewRevision: headSha,
    requiresApplyMutationLease: true,
    reviewLeaseRevisionFromReport: () => headSha,
    setActiveApplyMutationLease: () => undefined,
    shouldPreserveReviewStartLease: () => false,
    targetRepo: () => "openclaw/openclaw",
  } as unknown as Parameters<typeof createApplyLeaseGuards>[0]);
}

test("held-lease mutation boundaries run the review-activity barrier once", () => {
  const calls: string[] = [];
  assert.equal(leaseGuards(calls).currentApplyMutationLeaseBlockReason(), null);
  // One two-read activity barrier, then the head/comment/head lease sandwich and
  // the canonical freshness check. The barrier used to run twice back to back.
  assert.deepEqual(calls, ["activity", "pull", "comments", "pull", "canonical"]);
});

test("review-activity drift still blocks before any lease read", () => {
  const calls: string[] = [];
  assert.equal(
    leaseGuards(
      calls,
      "pull request review activity changed since review",
    ).currentApplyMutationLeaseBlockReason(),
    "pull request review activity changed since review",
  );
  assert.deepEqual(calls, ["activity"]);
});

test("lease acquisition keeps its own review-activity barrier", () => {
  const calls: string[] = [];
  const guards = leaseGuards(calls);
  assert.equal(
    guards.acquireApplyMutationLease({
      comment: undefined,
      comments: [leaseComment],
      leaseComments: [leaseComment],
      headSha,
      lease: { ...lease, startedAt, expiresAt: startedAt },
      preserve: false,
      blockReason: null,
    }),
    null,
  );
  assert.deepEqual(calls, ["activity", "pull", "comments", "pull", "canonical"]);
});
