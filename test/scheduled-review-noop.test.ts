import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyScheduledReviewNoop,
  scheduledReviewSemanticSourceRevision,
} from "../scripts/classify-scheduled-review-noop.ts";
import { itemSourceRevisionSha256ForTest } from "../dist/clawsweeper.js";
import { runReadScopeProof } from "../scripts/e2e/exact-review-noop-read-scope.mjs";

const issue = {
  number: 41,
  title: "Unchanged issue",
  body: "Original body",
  state: "open",
  locked: false,
  updated_at: "2026-08-09T21:12:38Z",
  labels: [
    { name: "status: ready for maintainer look" },
    { name: "mantis: telegram-visible-proof" },
  ],
};
function fixture(overrides: Record<string, unknown> = {}) {
  const humanComments = [
    {
      id: 1,
      user: { login: "reporter" },
      body: "Human evidence",
      created_at: "2026-08-09T19:00:00Z",
      updated_at: "2026-08-09T19:00:00Z",
    },
  ];
  const revision = scheduledReviewSemanticSourceRevision(issue, humanComments);
  const botComment = {
    id: 2,
    user: { login: "clawsweeper[bot]" },
    body: `Review unchanged\n\n<!-- clawsweeper-review-version item=41 reviewed_at=2026-08-09T21:12:33Z sha=na source_revision=${revision} lease_owner=old lease_comment_id=2 v=1 -->`,
    created_at: "2026-08-09T20:00:00Z",
    updated_at: "2026-08-09T21:12:33Z",
  };
  return {
    decision: { sourceAction: "scheduled_hot_intake", sourceUpdatedAt: issue.updated_at },
    issue,
    comments: [...humanComments, botComment],
    ...overrides,
  };
}

test("claim-time classifier accepts trusted owned activity through timestamp settling", () => {
  assert.deepEqual(classifyScheduledReviewNoop(fixture()), {
    noop: true,
    reason: "trusted_owned_activity_only",
  });
  const boundaryIssue = { ...issue, updated_at: "2026-08-09T21:13:03Z" };
  const boundary = fixture({
    issue: boundaryIssue,
    decision: { sourceAction: "scheduled_hot_intake", sourceUpdatedAt: boundaryIssue.updated_at },
  });
  assert.equal(classifyScheduledReviewNoop(boundary).noop, true);
  const outsideIssue = { ...issue, updated_at: "2026-08-09T21:13:04Z" };
  const outside = fixture({
    issue: outsideIssue,
    decision: { sourceAction: "scheduled_hot_intake", sourceUpdatedAt: outsideIssue.updated_at },
  });
  assert.equal(classifyScheduledReviewNoop(outside).noop, false);
});
test("claim-time semantic identity matches the review runtime", () => {
  const current = fixture();
  assert.equal(
    scheduledReviewSemanticSourceRevision(current.issue, current.comments),
    itemSourceRevisionSha256ForTest(current.issue, current.comments),
  );
});
test("claim-time classifier preserves human and mixed source changes", () => {
  const current = fixture();
  assert.equal(
    classifyScheduledReviewNoop({
      ...current,
      comments: [
        ...current.comments,
        {
          id: 3,
          user: { login: "maintainer" },
          body: "New human evidence",
          updated_at: "2026-08-09T21:12:35Z",
        },
      ],
    }).noop,
    false,
  );
});
test("claim-time classifier preserves protected and human-owned label changes", () => {
  for (const label of [
    "proof: override",
    "clawsweeper:human-review",
    "clawsweeper:manual-only",
    "clawsweeper:bulk-filed",
    "release-blocker",
  ]) {
    const current = fixture();
    const changedIssue = { ...current.issue, labels: [...current.issue.labels, { name: label }] };
    assert.equal(
      classifyScheduledReviewNoop({ ...current, issue: changedIssue }).noop,
      false,
      label,
    );
  }
});
test("claim-time classifier is conservative for source drift and missing receipts", () => {
  const current = fixture();
  assert.equal(
    classifyScheduledReviewNoop({
      ...current,
      decision: { ...current.decision, sourceUpdatedAt: "2026-08-09T21:12:37Z" },
    }).noop,
    false,
  );
  assert.equal(
    classifyScheduledReviewNoop({ ...current, comments: current.comments.slice(0, 1) }).noop,
    false,
  );
});

test("claim-time classifier requires an exact durable pull request head", () => {
  const current = fixture();
  const pull = { ...current.issue, pull_request: { url: "https://api.github.test/pulls/41" } };
  const comments = current.comments.map((comment) =>
    comment.id === 2 ? { ...comment, body: comment.body.replace("sha=na", "sha=abc123") } : comment,
  );
  assert.equal(classifyScheduledReviewNoop({ ...current, issue: pull, comments }).noop, false);
  assert.equal(
    classifyScheduledReviewNoop({ ...current, issue: pull, comments, liveHeadSha: "def456" }).noop,
    false,
  );
  assert.equal(
    classifyScheduledReviewNoop({ ...current, issue: pull, comments, liveHeadSha: "abc123" }).noop,
    true,
  );
});

test("live admission skips inapplicable no-op reads while preserving hot and terminal paths", () => {
  runReadScopeProof();
});
