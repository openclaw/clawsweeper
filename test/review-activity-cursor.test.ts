import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_REVIEWED_PR_ACTIVITY,
  createReviewedPrActivityCursor,
  isReviewedPrActivityCursor,
} from "../dist/review-activity-cursor.js";

test("review activity cursors bind same-second reviews and inline comments", () => {
  const baseline = createReviewedPrActivityCursor({
    reviews: [
      {
        id: 1,
        user: { login: "reviewer" },
        state: "COMMENTED",
        submitted_at: "2026-07-13T08:00:00Z",
        body: "looks close",
      },
    ],
    inlineComments: [],
  });
  const changed = createReviewedPrActivityCursor({
    reviews: [
      {
        id: 1,
        user: { login: "reviewer" },
        state: "COMMENTED",
        submitted_at: "2026-07-13T08:00:00Z",
        body: "looks close",
      },
    ],
    inlineComments: [
      {
        id: 2,
        user: { login: "reviewer" },
        created_at: "2026-07-13T08:00:00Z",
        updated_at: "2026-07-13T08:00:00Z",
        path: "src/example.ts",
        line: 10,
        body: "please fix this",
      },
    ],
  });

  assert.ok(isReviewedPrActivityCursor(baseline));
  assert.ok(isReviewedPrActivityCursor(changed));
  assert.notEqual(changed, baseline);
});

test("review activity cursors are order-independent and edit-sensitive", () => {
  const first = {
    id: 10,
    user: { login: "reviewer" },
    created_at: "2026-07-13T08:00:00Z",
    updated_at: "2026-07-13T08:00:00Z",
    path: "src/a.ts",
    body: "first",
  };
  const second = {
    id: 11,
    user: { login: "reviewer" },
    created_at: "2026-07-13T08:00:00Z",
    updated_at: "2026-07-13T08:00:00Z",
    path: "src/b.ts",
    body: "second",
  };
  const forward = createReviewedPrActivityCursor({
    reviews: [],
    inlineComments: [first, second],
  });
  const reverse = createReviewedPrActivityCursor({
    reviews: [],
    inlineComments: [second, first],
  });
  const edited = createReviewedPrActivityCursor({
    reviews: [],
    inlineComments: [first, { ...second, body: "edited" }],
  });

  assert.equal(reverse, forward);
  assert.notEqual(edited, forward);
});

test("review activity cursors fail closed beyond the bounded history", () => {
  const inlineComments = Array.from({ length: MAX_REVIEWED_PR_ACTIVITY + 1 }, (_, id) => ({ id }));

  assert.equal(createReviewedPrActivityCursor({ reviews: [], inlineComments }), null);
  assert.equal(isReviewedPrActivityCursor({ toString: () => `v1:0:${"a".repeat(64)}` }), false);
  assert.equal(
    isReviewedPrActivityCursor(`v1:${MAX_REVIEWED_PR_ACTIVITY + 1}:${"a".repeat(64)}`),
    false,
  );
});
