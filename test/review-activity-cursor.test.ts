import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  MAX_REVIEWED_PR_ACTIVITY,
  MAX_REVIEWED_PR_ACTIVITY_CURSOR_BYTES,
  ReviewedPrActivityGuardError,
  createReviewedPrActivityCursor,
  isReviewedPrActivityCursor,
  readStableReviewedPrActivityCursor,
  reviewedPrActivityThreadsPageFromGraphql,
  runReviewedPrActivityGuardedMutation,
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
    reviewThreads: [],
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
    reviewThreads: [],
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
    reviewThreads: [],
  });
  const reverse = createReviewedPrActivityCursor({
    reviews: [],
    inlineComments: [second, first],
    reviewThreads: [],
  });
  const edited = createReviewedPrActivityCursor({
    reviews: [],
    inlineComments: [first, { ...second, body: "edited" }],
    reviewThreads: [],
  });

  assert.equal(reverse, forward);
  assert.notEqual(edited, forward);
});

test("review activity cursor ordering is locale-independent", () => {
  const moduleUrl = new URL("../dist/review-activity-cursor.js", import.meta.url).href;
  const script = `
    const { createReviewedPrActivityCursor } = await import(${JSON.stringify(moduleUrl)});
    const cursor = createReviewedPrActivityCursor({
      reviews: [],
      inlineComments: [],
      reviewThreads: [
        { id: "I", isResolved: false },
        { id: "\\u0131", isResolved: false },
        { id: "i", isResolved: false },
        { id: "\\u0130", isResolved: false },
      ],
    });
    console.log(JSON.stringify({
      locale: Intl.Collator().resolvedOptions().locale,
      cursor,
    }));
  `;
  const run = (locale: string) => {
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      encoding: "utf8",
      env: { ...process.env, LANG: locale, LC_ALL: locale },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim()) as { locale: string; cursor: string };
  };

  const english = run("en_US.UTF-8");
  const turkish = run("tr_TR.UTF-8");
  assert.match(english.locale, /^en(?:-|$)/i);
  assert.match(turkish.locale, /^tr(?:-|$)/i);
  assert.equal(turkish.cursor, english.cursor);
});

test("review activity cursors fail closed beyond the bounded history", () => {
  const inlineComments = Array.from({ length: MAX_REVIEWED_PR_ACTIVITY + 1 }, (_, id) => ({ id }));

  assert.equal(
    createReviewedPrActivityCursor({ reviews: [], inlineComments, reviewThreads: [] }),
    null,
  );
  assert.equal(isReviewedPrActivityCursor({ toString: () => `v1:0:${"a".repeat(64)}` }), false);
  assert.equal(
    isReviewedPrActivityCursor(`v2:${MAX_REVIEWED_PR_ACTIVITY + 1}:${"a".repeat(64)}`),
    false,
  );
});

test("review activity cursors bind review thread resolution", () => {
  const open = createReviewedPrActivityCursor({
    reviews: [],
    inlineComments: [],
    reviewThreads: [{ id: "thread-1", isResolved: false }],
  });
  const resolved = createReviewedPrActivityCursor({
    reviews: [],
    inlineComments: [],
    reviewThreads: [{ id: "thread-1", isResolved: true }],
  });

  assert.ok(isReviewedPrActivityCursor(open));
  assert.ok(isReviewedPrActivityCursor(resolved));
  assert.notEqual(resolved, open);
});

test("review activity cursors digest bodies and bound canonical metadata", () => {
  const largeBody = "x".repeat(MAX_REVIEWED_PR_ACTIVITY_CURSOR_BYTES * 2);
  assert.ok(
    createReviewedPrActivityCursor({
      reviews: [{ id: 1, body: largeBody }],
      inlineComments: [],
      reviewThreads: [],
    }),
  );

  const oversizedMetadata = Array.from({ length: MAX_REVIEWED_PR_ACTIVITY }, (_, id) => ({
    id,
    path: `src/${"x".repeat(2_000)}/${id}.ts`,
  }));
  assert.equal(
    createReviewedPrActivityCursor({
      reviews: [],
      inlineComments: oversizedMetadata,
      reviewThreads: [],
    }),
    null,
  );
});

test("review thread GraphQL pages are parsed fail-closed", () => {
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

test("review activity cursor refresh rejects an interleaved review", () => {
  const cursors = [
    createReviewedPrActivityCursor({
      reviews: [],
      inlineComments: [],
      reviewThreads: [],
    }),
    createReviewedPrActivityCursor({
      reviews: [{ id: 1, user: { login: "reviewer" }, state: "COMMENTED" }],
      inlineComments: [],
      reviewThreads: [],
    }),
  ];
  let reads = 0;

  assert.throws(
    () => readStableReviewedPrActivityCursor(() => cursors[reads++] ?? null),
    /review activity changed while refreshing/,
  );
  assert.equal(reads, 2);
});

test("review activity cursor refresh accepts two matching complete scans", () => {
  const cursor = createReviewedPrActivityCursor({
    reviews: [{ id: 1, user: { login: "reviewer" }, state: "APPROVED" }],
    inlineComments: [],
    reviewThreads: [],
  });
  let reads = 0;

  assert.equal(
    readStableReviewedPrActivityCursor(() => {
      reads += 1;
      return cursor;
    }),
    cursor,
  );
  assert.equal(reads, 2);
});

test("trusted review activity is revalidated at the mutation boundary", () => {
  let operationCalls = 0;
  const preflight = () => null;
  const changedAtMutation = () => ({
    reason: "pull request review activity changed since the trusted ClawSweeper verdict",
    retryable: false,
  });

  assert.equal(preflight(), null);
  for (const intent of ["clawsweeper_auto_merge", "clawsweeper_auto_repair"]) {
    for (const mutationKind of [
      "description_update",
      "label_add",
      "label_create",
      "label_remove",
      "pull_request_merge",
      "repair_dispatch",
      "review_dispatch",
    ]) {
      assert.throws(
        () =>
          runReviewedPrActivityGuardedMutation({
            intent,
            mutationKind,
            refresh: changedAtMutation,
            operation: () => {
              operationCalls += 1;
            },
          }),
        (error) =>
          error instanceof ReviewedPrActivityGuardError &&
          error.mutationKind === mutationKind &&
          error.block.retryable === false,
      );
    }
  }
  assert.equal(operationCalls, 0);

  for (const [intent, mutationKind] of [
    ["autoclose", "issue_close"],
    ["autoclose", "pull_request_close"],
    ["clawsweeper_needs_human", "label_add"],
  ]) {
    assert.throws(
      () =>
        runReviewedPrActivityGuardedMutation({
          intent,
          mutationKind,
          refresh: changedAtMutation,
          operation: () => {
            operationCalls += 1;
          },
        }),
      (error) =>
        error instanceof ReviewedPrActivityGuardError &&
        error.mutationKind === mutationKind &&
        error.block.retryable === false,
    );
  }
  assert.equal(operationCalls, 0);

  runReviewedPrActivityGuardedMutation({
    intent: "clawsweeper_auto_merge",
    mutationKind: "comment_update",
    refresh: changedAtMutation,
    operation: () => {
      operationCalls += 1;
    },
  });
  assert.equal(operationCalls, 1);
});
