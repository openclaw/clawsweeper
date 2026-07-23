import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  MAX_REVIEWED_PR_ACTIVITY,
  ReviewedPrActivityChangedDuringReadError,
  createReviewedPrActivityCursor,
  isReviewedPrActivityCursor,
  readStableReviewedPrActivityCursor,
  reviewedPrActivityThreadsPageFromGraphql,
} from "../dist/review-activity-cursor.js";

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
  const source = fs.readFileSync("src/clawsweeper.ts", "utf8");

  assert.match(source, /review_activity_cursor: \$\{options\.context\.pullReviewActivityCursor/);
  assert.match(source, /pull request review activity changed since review/);
  assert.match(source, /currentReviewActivityBlock\(\)/);
});
