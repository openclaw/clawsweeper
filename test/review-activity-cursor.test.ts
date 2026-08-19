import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { createApplyReviewActivityGuard } from "../dist/clawsweeper-apply-review-activity.js";
import {
  MAX_REVIEWED_PR_ACTIVITY,
  ReviewedPrActivityChangedDuringReadError,
  compareReviewedPrActivityCursors,
  createReviewedPrActivityCursor,
  isReviewedPrActivityCursor,
  readStableReviewedPrActivityCursor,
  readStableReviewedPrActivityCursors,
  reviewedPrActivityCursorV2Query,
  reviewedPrActivityCursorsV2FromGraphql,
  reviewedPrActivityThreadsPageFromGraphql,
} from "../dist/review-activity-cursor.js";

function v1Cursor(options: {
  reviewState?: string;
  inlineBody?: string;
  inlineUpdatedAt?: string;
  threadResolved?: boolean;
}) {
  return createReviewedPrActivityCursor({
    reviews: [
      {
        id: 11,
        user: { login: "reviewer" },
        state: options.reviewState ?? "APPROVED",
        body: "review body",
        submitted_at: "2026-08-13T10:00:00Z",
        commit_id: "a".repeat(40),
      },
    ],
    inlineComments: [
      {
        id: 21,
        pull_request_review_id: 11,
        in_reply_to_id: null,
        user: { login: "reviewer" },
        body: options.inlineBody ?? "inline body",
        created_at: "2026-08-13T10:01:00Z",
        updated_at: options.inlineUpdatedAt ?? "2026-08-13T10:01:00Z",
        path: "src/example.ts",
        line: 12,
        side: "RIGHT",
        start_line: null,
        start_side: null,
        original_line: 12,
        original_commit_id: "a".repeat(40),
        commit_id: "a".repeat(40),
      },
    ],
    reviewThreads: [{ id: "thread-1", isResolved: options.threadResolved ?? false }],
  });
}

function v2Response(
  options: {
    reviewState?: string;
    inlineBody?: string;
    inlineUpdatedAt?: string;
    threadResolved?: boolean;
  } = {},
) {
  return {
    data: {
      repository: {
        pr_42: {
          reviews: {
            totalCount: 1,
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                fullDatabaseId: "11",
                author: { login: "reviewer" },
                state: options.reviewState ?? "APPROVED",
                body: "review body",
                submittedAt: "2026-08-13T10:00:00Z",
                commit: { oid: "a".repeat(40) },
              },
            ],
          },
          reviewThreads: {
            totalCount: 1,
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                id: "thread-1",
                isResolved: options.threadResolved ?? false,
                comments: {
                  totalCount: 1,
                  pageInfo: { hasNextPage: false },
                  nodes: [
                    {
                      fullDatabaseId: "21",
                      pullRequestReview: { fullDatabaseId: "11" },
                      replyTo: null,
                      author: { login: "reviewer" },
                      body: options.inlineBody ?? "inline body",
                      createdAt: "2026-08-13T10:01:00Z",
                      updatedAt: options.inlineUpdatedAt ?? "2026-08-13T10:01:00Z",
                      path: "src/example.ts",
                      line: 12,
                      startLine: null,
                      originalLine: 12,
                      originalCommit: { oid: "a".repeat(40) },
                      commit: { oid: "a".repeat(40) },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    },
  };
}

function v2Cursor(options: Parameters<typeof v2Response>[0] = {}) {
  const decoded = reviewedPrActivityCursorsV2FromGraphql(v2Response(options), [42]);
  assert.deepEqual(decoded.failures, {});
  return decoded.cursors["42"] ?? null;
}

test("review activity cursor binds reviews, inline comments, and thread state", () => {
  const baseline = createReviewedPrActivityCursor({
    reviews: [{ id: 1, state: "COMMENTED", body: "looks close" }],
    inlineComments: [],
    reviewThreads: [{ id: "thread-1", isResolved: false }],
  });
  const changed = createReviewedPrActivityCursor({
    reviews: [{ id: 1, state: "COMMENTED", body: "looks close" }],
    inlineComments: [{ id: 2, path: "src/example.ts", line: 10, body: "please fix" }],
    reviewThreads: [{ id: "thread-1", isResolved: true }],
  });

  assert.ok(isReviewedPrActivityCursor(baseline));
  assert.ok(isReviewedPrActivityCursor(changed));
  assert.notEqual(changed, baseline);
});

test("review activity cursor is order-independent and bounded", () => {
  const first = { id: "I", isResolved: false };
  const second = { id: "\u0131", isResolved: true };
  const forward = createReviewedPrActivityCursor({
    reviews: [],
    inlineComments: [],
    reviewThreads: [first, second],
  });
  const reverse = createReviewedPrActivityCursor({
    reviews: [],
    inlineComments: [],
    reviewThreads: [second, first],
  });

  assert.equal(reverse, forward);
  assert.equal(
    createReviewedPrActivityCursor({
      reviews: Array.from({ length: MAX_REVIEWED_PR_ACTIVITY + 1 }, (_, id) => ({ id })),
      inlineComments: [],
      reviewThreads: [],
    }),
    null,
  );
});

test("stable refresh rejects interleaved activity", () => {
  const cursors = [
    createReviewedPrActivityCursor({ reviews: [], inlineComments: [], reviewThreads: [] }),
    createReviewedPrActivityCursor({
      reviews: [{ id: 1, state: "APPROVED" }],
      inlineComments: [],
      reviewThreads: [],
    }),
  ];
  let reads = 0;

  assert.throws(
    () => readStableReviewedPrActivityCursor(() => cursors[reads++] ?? null),
    ReviewedPrActivityChangedDuringReadError,
  );
});

test("v1 and v2 agree on activity and stability decisions", () => {
  const v1Baseline = v1Cursor({});
  const v2Baseline = v2Cursor();
  assert.ok(v1Baseline);
  assert.ok(v2Baseline);

  for (const changed of [
    { inlineBody: "edited inline body", inlineUpdatedAt: "2026-08-13T10:02:00Z" },
    { reviewState: "DISMISSED" },
    { threadResolved: true },
  ]) {
    assert.notEqual(v1Cursor(changed), v1Baseline);
    assert.notEqual(v2Cursor(changed), v2Baseline);
  }

  const changedHead = "b".repeat(40);
  const v1ForcePushChanged = v1Cursor({}) !== v1Baseline || changedHead !== "a".repeat(40);
  const v2ForcePushChanged = v2Cursor() !== v2Baseline || changedHead !== "a".repeat(40);
  assert.equal(v1ForcePushChanged, true);
  assert.equal(v2ForcePushChanged, v1ForcePushChanged);

  for (const cursors of [
    [v1Baseline, v1Cursor({ reviewState: "DISMISSED" })],
    [v2Baseline, v2Cursor({ reviewState: "DISMISSED" })],
  ]) {
    let reads = 0;
    assert.throws(
      () => readStableReviewedPrActivityCursor(() => cursors[reads++] ?? null),
      ReviewedPrActivityChangedDuringReadError,
    );
  }
});

test("v1 to v2 migration explicitly re-baselines instead of reporting activity change", () => {
  assert.equal(compareReviewedPrActivityCursors(v1Cursor({}), v2Cursor()), "rebaseline");
  assert.equal(compareReviewedPrActivityCursors(v1Cursor({}), v1Cursor({})), "equal");
  assert.equal(compareReviewedPrActivityCursors(v2Cursor(), v2Cursor()), "equal");

  const guard = createApplyReviewActivityGuard(
    {
      fetchReviewedPrActivityCursor: () => v2Cursor(),
      GitHubRuntimeBudgetError: class GitHubRuntimeBudgetError extends Error {
        readonly reason = "test";
      },
    },
    { expectedCursor: v1Cursor({}) ?? undefined, itemKind: "pull_request", number: 42 },
  );
  assert.equal(
    guard(),
    "stored pull request review activity cursor version requires a fresh review",
  );
});

test("v2 query aliases a bounded PR batch and decoder fails closed", () => {
  const query = reviewedPrActivityCursorV2Query(
    "openclaw",
    "clawsweeper",
    Array.from({ length: 8 }, (_, index) => index + 1),
  );
  assert.equal([...query.matchAll(/pr_(\d+): pullRequest/g)].length, 8);
  assert.match(query, /reviews\(first: 100\)/);
  assert.match(query, /reviewThreads\(first: 100\)/);
  assert.match(query, /comments\(first: 100\)/);
  assert.throws(
    () =>
      reviewedPrActivityCursorV2Query(
        "openclaw",
        "clawsweeper",
        Array.from({ length: 9 }, (_, index) => index + 1),
      ),
    /exceeds 8/,
  );

  const truncated = v2Response();
  truncated.data.repository.pr_42.reviews.pageInfo.hasNextPage = true;
  assert.equal(
    reviewedPrActivityCursorsV2FromGraphql(truncated, [42]).failures["42"],
    "reviews_truncated",
  );
  const partial = v2Response();
  delete (
    partial.data.repository.pr_42.reviewThreads.nodes[0]!.comments.nodes[0] as Record<
      string,
      unknown
    >
  ).updatedAt;
  assert.equal(
    reviewedPrActivityCursorsV2FromGraphql(partial, [42]).failures["42"],
    "invalid_review_comment_node",
  );
});

test("batched stability keeps the two-read invariant", () => {
  const stable = v2Cursor();
  let reads = 0;
  assert.deepEqual(
    readStableReviewedPrActivityCursors(() => {
      reads += 1;
      return { "42": stable };
    }),
    { "42": stable },
  );
  assert.equal(reads, 2);
});

test("review thread pages parse fail-closed", () => {
  assert.deepEqual(
    reviewedPrActivityThreadsPageFromGraphql({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [{ id: "thread-1", isResolved: false }],
              pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
            },
          },
        },
      },
    }),
    {
      threads: [{ id: "thread-1", isResolved: false }],
      hasNextPage: true,
      endCursor: "cursor-1",
    },
  );
  assert.equal(
    reviewedPrActivityThreadsPageFromGraphql({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [{ id: "thread-1", isResolved: "false" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    }),
    null,
  );
});

test("review and apply paths persist and revalidate the cursor", () => {
  const source = [
    fs.readFileSync("src/clawsweeper-report-orchestration.ts", "utf8"),
    fs.readFileSync("src/clawsweeper-report-rendering.ts", "utf8"),
    fs.readFileSync("src/clawsweeper-report-document.ts", "utf8"),
    fs.readFileSync("src/clawsweeper-apply-decision-workflow.ts", "utf8"),
    fs.readFileSync("src/clawsweeper-apply-review-activity.ts", "utf8"),
  ].join("\n");

  assert.match(source, /review_activity_cursor: \$\{options\.context\.pullReviewActivityCursor/);
  assert.match(source, /pull request review activity changed since review/);
  assert.match(source, /currentReviewActivityBlock\(\)/);
});
