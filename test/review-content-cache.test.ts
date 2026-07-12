import assert from "node:assert/strict";
import test from "node:test";

import { reviewContentCacheHit } from "../dist/scheduler-policy.js";
import {
  itemContentDigestForTest,
  reviewCommentContentRevisionForTest,
  reviewReportCanPromoteToCloseForTest,
} from "../dist/clawsweeper.js";
import { item } from "./helpers.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function pullContext(overrides = {}) {
  return {
    sourceRevision: "source-rev-1",
    timeline: [],
    counts: { comments: 0, timeline: 0 },
    pullRequest: { head: { sha: "head-sha-1" }, base: { sha: "base-sha-1" } },
    pullFiles: [{ filename: "src/a.ts", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new" }],
    ...overrides,
  };
}

function issueContext(overrides = {}) {
  return {
    sourceRevision: "source-rev-1",
    timeline: [],
    counts: { comments: 0, timeline: 0 },
    ...overrides,
  };
}

test("content digest is stable across bot-only context churn", () => {
  const pull = item({ kind: "pull_request", number: 200 });
  const a = itemContentDigestForTest(
    pull,
    pullContext({
      timeline: [{ id: 1, event: "labeled", actor: "ClawSweeper[bot]" }],
      counts: { comments: 3, timeline: 1 },
    }),
  );
  const b = itemContentDigestForTest(
    pull,
    pullContext({
      timeline: [
        { id: 2, event: "labeled", actor: "clawsweeper" },
        { id: 3, event: "commented", actor: "openclaw-clawsweeper[bot]" },
      ],
      counts: { comments: 9, timeline: 2 },
    }),
  );
  assert.equal(a, b);
});

test("content digest busts when a human timeline event appears", () => {
  const pull = item({ kind: "pull_request", number: 200 });
  const a = itemContentDigestForTest(pull, pullContext({ timeline: [] }));
  const b = itemContentDigestForTest(
    pull,
    pullContext({
      timeline: [{ id: 9, event: "reviewed", actor: "maintainer" }],
    }),
  );
  assert.notEqual(a, b);
});

test("content digest ignores advisory-label timeline churn", () => {
  const issue = item({ kind: "issue", number: 300 });
  const a = itemContentDigestForTest(issue, issueContext({ timeline: [] }));
  const b = itemContentDigestForTest(
    issue,
    issueContext({
      timeline: [{ id: 10, event: "labeled", actor: "github-actions[bot]", label: "P2" }],
    }),
  );
  assert.equal(a, b);
});

test("content digest busts when the source revision changes", () => {
  const pull = item({ kind: "pull_request", number: 200 });
  const a = itemContentDigestForTest(pull, pullContext());
  const b = itemContentDigestForTest(pull, pullContext({ sourceRevision: "source-rev-2" }));
  assert.notEqual(a, b);
});

test("content digest busts when a diff patch byte changes", () => {
  const pull = item({ kind: "pull_request", number: 200 });
  const a = itemContentDigestForTest(pull, pullContext());
  const b = itemContentDigestForTest(
    pull,
    pullContext({
      pullFiles: [{ filename: "src/a.ts", status: "modified", patch: "@@ -1 +1 @@\n-old\n+newer" }],
    }),
  );
  assert.notEqual(a, b);
});

test("content digest busts when the PR head sha changes", () => {
  const pull = item({ kind: "pull_request", number: 200 });
  const a = itemContentDigestForTest(pull, pullContext());
  const b = itemContentDigestForTest(
    pull,
    pullContext({ pullRequest: { head: { sha: "head-sha-2" }, base: { sha: "base-sha-1" } } }),
  );
  assert.notEqual(a, b);
});

test("content digest busts when the PR base sha changes", () => {
  const pull = item({ kind: "pull_request", number: 200 });
  const a = itemContentDigestForTest(pull, pullContext());
  const b = itemContentDigestForTest(
    pull,
    pullContext({ pullRequest: { head: { sha: "head-sha-1" }, base: { sha: "base-sha-2" } } }),
  );
  assert.notEqual(a, b);
});

test("issue digest ignores pull-request-only fields", () => {
  const issue = item({ kind: "issue", number: 300 });
  const a = itemContentDigestForTest(
    issue,
    issueContext({
      pullFiles: [{ filename: "x", patch: "one" }],
      pullRequest: { head: { sha: "h1" } },
    }),
  );
  const b = itemContentDigestForTest(
    issue,
    issueContext({
      pullFiles: [{ filename: "y", patch: "two" }],
      pullRequest: { head: { sha: "h2" } },
    }),
  );
  assert.equal(a, b);
});

test("issue digest busts when closing pull request context changes", () => {
  const issue = item({ kind: "issue", number: 300 });
  const a = itemContentDigestForTest(issue, issueContext({ closingPullRequests: [] }));
  const b = itemContentDigestForTest(
    issue,
    issueContext({
      closingPullRequests: [{ number: 301, state: "open", head: { sha: "head-1" } }],
    }),
  );
  assert.notEqual(a, b);
});

test("content digest busts when related item context changes", () => {
  const pull = item({ kind: "pull_request", number: 200 });
  const a = itemContentDigestForTest(pull, pullContext({ relatedItems: [] }));
  const b = itemContentDigestForTest(
    pull,
    pullContext({ relatedItems: [{ issue: { number: 199, state: "closed" } }] }),
  );
  assert.notEqual(a, b);
});

test("content digest busts when the latest release changes", () => {
  const issue = item({ kind: "issue", number: 300 });
  const context = issueContext();
  const a = itemContentDigestForTest(issue, context, {
    mainSha: "main-1",
    latestRelease: { tagName: "v1.0.0", sha: "release-1" },
  });
  const b = itemContentDigestForTest(issue, context, {
    mainSha: "main-2",
    latestRelease: { tagName: "v1.1.0", sha: "release-2" },
  });
  assert.notEqual(a, b);
});

test("content digest distinguishes complete and unknown release state", () => {
  const issue = item({ kind: "issue", number: 300 });
  const known = itemContentDigestForTest(issue, issueContext(), {
    mainSha: "main-sha",
    releaseStateComplete: true,
    latestRelease: null,
  });
  const unknown = itemContentDigestForTest(issue, issueContext(), {
    mainSha: "main-sha",
    releaseStateComplete: false,
    latestRelease: null,
  });

  assert.notEqual(known, unknown);
});

test("issue digest busts when target main changes", () => {
  const issue = item({ kind: "issue", number: 300 });
  const context = issueContext();
  const a = itemContentDigestForTest(issue, context, { mainSha: "main-1" });
  const b = itemContentDigestForTest(issue, context, { mainSha: "main-2" });
  assert.notEqual(a, b);
});

test("content digest busts when a human adds a PR review comment", () => {
  const pull = item({ kind: "pull_request", number: 200 });
  const a = itemContentDigestForTest(pull, pullContext({ pullReviewComments: [] }));
  const b = itemContentDigestForTest(
    pull,
    pullContext({
      pullReviewComments: [
        {
          author: "maintainer",
          authorAssociation: "MEMBER",
          body: "Please do not close; this still needs a fix.",
        },
      ],
    }),
  );
  assert.notEqual(a, b);
});

test("content digest ignores ClawSweeper's own PR review comments", () => {
  const pull = item({ kind: "pull_request", number: 200 });
  const a = itemContentDigestForTest(pull, pullContext({ pullReviewComments: [] }));
  const b = itemContentDigestForTest(
    pull,
    pullContext({
      pullReviewComments: [
        { author: "ClawSweeper[bot]", authorAssociation: "NONE", body: "Automated review note." },
      ],
    }),
  );
  assert.equal(a, b);
});

test("content digest ignores PR review comment timestamp churn", () => {
  const pull = item({ kind: "pull_request", number: 200 });
  const comment = { author: "maintainer", authorAssociation: "MEMBER", body: "Looks good to me." };
  const a = itemContentDigestForTest(
    pull,
    pullContext({
      pullReviewComments: [
        { ...comment, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
      ],
    }),
  );
  const b = itemContentDigestForTest(
    pull,
    pullContext({
      pullReviewComments: [
        { ...comment, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-05-05T00:00:00Z" },
      ],
    }),
  );
  assert.equal(a, b);
});

test("content digest busts when bounded PR check state changes", () => {
  const pull = item({ kind: "pull_request", number: 200 });
  const passing = itemContentDigestForTest(
    pull,
    pullContext({
      pullChecks: {
        complete: true,
        checkRuns: [{ name: "test", status: "completed", conclusion: "success" }],
        checkRunsTruncated: false,
        statuses: [],
        statusesTruncated: false,
      },
    }),
  );
  const failing = itemContentDigestForTest(
    pull,
    pullContext({
      pullChecks: {
        complete: true,
        checkRuns: [{ name: "test", status: "completed", conclusion: "failure" }],
        checkRunsTruncated: false,
        statuses: [],
        statusesTruncated: false,
      },
    }),
  );

  assert.notEqual(passing, failing);
});

test("review comment revision covers comments outside the bounded prompt window", () => {
  const comments = Array.from({ length: 81 }, (_, index) => ({
    id: index + 1,
    author: "maintainer",
    authorAssociation: "MEMBER",
    body: `comment ${index + 1}`,
  }));
  const changed = comments.map((comment, index) =>
    index === 40 ? { ...comment, body: "middle comment edited" } : comment,
  );
  assert.notEqual(
    reviewCommentContentRevisionForTest(comments),
    reviewCommentContentRevisionForTest(changed),
  );
});

test("content digest uses the full review-comment revision", () => {
  const pull = item({ kind: "pull_request", number: 200 });
  const a = itemContentDigestForTest(
    pull,
    pullContext({ pullReviewCommentsRevision: "review-comments-1" }),
  );
  const b = itemContentDigestForTest(
    pull,
    pullContext({ pullReviewCommentsRevision: "review-comments-2" }),
  );
  assert.notEqual(a, b);
});

const NOW = Date.parse("2026-07-01T00:00:00Z");

function freshReview(overrides = {}) {
  return {
    reviewStatus: "complete",
    reviewPolicy: "policy-1",
    decision: "keep_open",
    contentDigest: "digest-1",
    lastFullReviewAt: new Date(NOW - DAY_MS).toISOString(),
    lastFullReviewDecision: "keep_open",
    ...overrides,
  };
}

function cacheHit(overrides = {}) {
  return reviewContentCacheHit({
    review: freshReview(),
    reviewPolicy: "policy-1",
    contentDigest: "digest-1",
    now: NOW,
    explicitDispatch: false,
    maintainerRequest: false,
    ...overrides,
  });
}

test("cache hits when content is unchanged, fresh, complete, and policy matches", () => {
  assert.equal(cacheHit(), true);
});

test("cache misses when the content digest differs", () => {
  assert.equal(cacheHit({ contentDigest: "digest-2" }), false);
});

test("cache misses when the review policy changed", () => {
  assert.equal(cacheHit({ reviewPolicy: "policy-2" }), false);
});

test("cache misses past the staleness ceiling", () => {
  assert.equal(
    cacheHit({
      review: freshReview({ lastFullReviewAt: new Date(NOW - 15 * DAY_MS).toISOString() }),
    }),
    false,
  );
});

test("cache misses on an explicit re-review dispatch", () => {
  assert.equal(cacheHit({ explicitDispatch: true }), false);
});

test("cache misses on a maintainer request", () => {
  assert.equal(cacheHit({ maintainerRequest: true }), false);
});

test("cache misses when the prior review did not complete", () => {
  assert.equal(cacheHit({ review: freshReview({ reviewStatus: "failed" }) }), false);
});

test("cache misses on a first-ever review", () => {
  assert.equal(cacheHit({ review: null }), false);
});

test("cache misses when the prior review predates the digest field", () => {
  assert.equal(cacheHit({ review: freshReview({ contentDigest: undefined }) }), false);
});

test("keep-open verdict is cache eligible", () => {
  assert.equal(cacheHit({ review: freshReview({ decision: "keep_open" }) }), true);
});

test("close verdict is never cached", () => {
  assert.equal(cacheHit({ review: freshReview({ decision: "close" }) }), false);
});

test("apply-rewritten close verdicts are never cached", () => {
  assert.equal(
    cacheHit({
      review: freshReview({ decision: "keep_open", lastFullReviewDecision: "close" }),
    }),
    false,
  );
});

test("reports without original-verdict provenance refresh once", () => {
  assert.equal(cacheHit({ review: freshReview({ lastFullReviewDecision: undefined }) }), false);
});

test("verdict without a decision is never cached", () => {
  assert.equal(cacheHit({ review: freshReview({ decision: undefined }) }), false);
});

test("cache-carried reports cannot be promoted to close", () => {
  assert.equal(reviewReportCanPromoteToCloseForTest("---\nreview_cache_hit: true\n---\n"), false);
});

test("fresh and legacy reports retain existing close promotion behavior", () => {
  assert.equal(reviewReportCanPromoteToCloseForTest("---\nreview_cache_hit: false\n---\n"), true);
  assert.equal(reviewReportCanPromoteToCloseForTest("---\ndecision: keep_open\n---\n"), true);
});
