import assert from "node:assert/strict";
import test from "node:test";

import {
  appendFloorBackfillCandidates,
  hotIntakeRecencyMs,
  reviewPriority,
  selectDueCandidates,
  shouldReviewItem,
} from "../dist/scheduler-policy.js";
import { item } from "./helpers.ts";

function schedulerCandidate(candidate) {
  return {
    item: candidate.item,
    review: candidate.review ?? null,
    priority: candidate.priority ?? reviewPriority(candidate.item, null),
    reviewedAt: candidate.reviewedAt ?? 0,
    nextDueAt: candidate.nextDueAt ?? 0,
    bucket: candidate.bucket,
  };
}

function selectedNumbers(due, limit, now) {
  return selectDueCandidates(due.map(schedulerCandidate), limit, undefined, now).map(
    (candidate) => candidate.item.number,
  );
}

function backfilledNumbers(selected, backfill, activeFloor, capacity) {
  return appendFloorBackfillCandidates(
    selected.map(schedulerCandidate),
    backfill.map(schedulerCandidate),
    { activeFloor, capacity },
  ).map((candidate) => candidate.item.number);
}

test("review policy changes force fresh complete reports back into planning", () => {
  const reviewedAt = new Date().toISOString();
  const review = {
    path: "items/123.md",
    markdown: "",
    reviewedAt,
    itemUpdatedAt: "2026-01-01T00:00:00Z",
    decision: "keep_open",
    reviewStatus: "complete",
    reviewPolicy: "old-policy",
  };
  const now = Date.parse(reviewedAt) + 60_000;

  assert.equal(shouldReviewItem(item(), review, now, "new-policy"), true);
  assert.equal(shouldReviewItem(item(), review, now, "old-policy"), false);
});

test("hot new items review daily unless target-side activity requires hourly cadence", () => {
  const now = Date.parse("2026-04-26T12:00:00Z");
  const review = (reviewedAt, itemUpdatedAt) => ({
    path: "items/123.md",
    markdown: "",
    reviewedAt,
    itemUpdatedAt,
    decision: "keep_open",
    reviewStatus: "complete",
    reviewPolicy: "current",
  });

  assert.equal(
    shouldReviewItem(
      item({
        createdAt: "2026-04-24T00:00:00Z",
        updatedAt: "2026-04-24T00:00:00Z",
      }),
      review("2026-04-26T10:00:00Z", "2026-04-24T00:00:00Z"),
      now,
      "current",
    ),
    false,
  );
  assert.equal(
    shouldReviewItem(
      item({
        createdAt: "2026-04-24T00:00:00Z",
        updatedAt: "2026-04-24T00:00:00Z",
      }),
      review("2026-04-25T10:00:00Z", "2026-04-24T00:00:00Z"),
      now,
      "current",
    ),
    true,
  );
  assert.equal(
    shouldReviewItem(
      item({
        createdAt: "2026-04-24T00:00:00Z",
        updatedAt: "2026-04-26T11:10:00Z",
      }),
      review("2026-04-26T10:00:00Z", "2026-04-24T00:00:00Z"),
      now,
      "current",
    ),
    true,
  );
  assert.equal(
    shouldReviewItem(
      item({
        createdAt: "2026-03-01T00:00:00Z",
        updatedAt: "2026-03-01T00:00:00Z",
      }),
      review("2026-04-24T12:00:00Z", "2026-03-01T00:00:00Z"),
      now,
      "current",
    ),
    false,
  );
  assert.equal(
    shouldReviewItem(
      item({
        kind: "pull_request",
        createdAt: "2026-03-01T00:00:00Z",
        updatedAt: "2026-03-01T00:00:00Z",
      }),
      review("2026-04-25T10:00:00Z", "2026-03-01T00:00:00Z"),
      now,
      "current",
    ),
    true,
  );
});

test("weekly coverage becomes due at six days to preserve deadline headroom", () => {
  const reviewedAt = Date.parse("2026-07-01T12:00:00Z");
  const review = {
    reviewedAt: new Date(reviewedAt).toISOString(),
    itemUpdatedAt: "2026-01-01T00:00:00Z",
    reviewStatus: "complete",
    reviewPolicy: "current",
  };
  const oldIssue = item({
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  });

  assert.equal(
    shouldReviewItem(oldIssue, review, reviewedAt + 6 * 86_400_000 - 1, "current"),
    false,
  );
  assert.equal(shouldReviewItem(oldIssue, review, reviewedAt + 6 * 86_400_000, "current"), true);
});

test("never-reviewed items are due while fresh tracked items stay excluded", () => {
  const now = Date.parse("2026-07-30T12:00:00Z");
  const candidate = item({
    createdAt: "2026-07-29T12:00:00Z",
    updatedAt: "2026-07-29T12:00:00Z",
  });
  const freshReview = {
    reviewedAt: "2026-07-30T11:00:00Z",
    itemUpdatedAt: "2026-07-29T12:00:00Z",
    reviewStatus: "complete",
    reviewPolicy: "current",
  };

  assert.equal(shouldReviewItem(candidate, null, now, "current"), true);
  assert.equal(shouldReviewItem(candidate, freshReview, now, "current"), false);
});

test("scheduler keeps ambiguous post-sync activity due after review", () => {
  const reviewedAt = "2026-04-30T12:52:57Z";
  const review = {
    path: "items/123.md",
    markdown: "",
    reviewedAt,
    itemUpdatedAt: "2026-04-30T11:17:05Z",
    decision: "keep_open",
    reviewStatus: "complete",
    reviewPolicy: "current",
  };
  const now = Date.parse("2026-04-30T14:10:00Z");

  assert.equal(
    shouldReviewItem(
      item({
        createdAt: "2026-03-01T11:12:04Z",
        updatedAt: "2026-04-30T12:52:56Z",
      }),
      review,
      now,
      "current",
    ),
    false,
  );
  const syncedAt = Date.parse("2026-04-30T13:04:59Z");
  for (const syncField of ["reviewCommentSyncedAt", "labelsSyncedAt"]) {
    assert.equal(
      shouldReviewItem(
        item({
          createdAt: "2026-03-01T11:12:04Z",
          updatedAt: "2026-04-30T13:04:58Z",
        }),
        { ...review, [syncField]: "2026-04-30T13:04:59Z" },
        now,
        "current",
      ),
      false,
    );
    for (let lagSeconds = 1; lagSeconds <= 5; lagSeconds += 1) {
      assert.equal(
        shouldReviewItem(
          item({
            createdAt: "2026-03-01T11:12:04Z",
            updatedAt: new Date(syncedAt + lagSeconds * 1000).toISOString(),
          }),
          { ...review, [syncField]: "2026-04-30T13:04:59Z" },
          now,
          "current",
        ),
        true,
        `${syncField} update ${lagSeconds}s after synchronization remains due`,
      );
    }
  }
});

test("hot new item priority is protected from older activity churn", () => {
  const now = Date.parse("2026-04-30T12:00:00Z");
  const review = (reviewedAt, itemUpdatedAt) => ({
    path: "items/123.md",
    markdown: "",
    reviewedAt,
    itemUpdatedAt,
    decision: "keep_open",
    reviewStatus: "complete",
    reviewPolicy: "current",
  });

  const hotIssue = item({
    createdAt: "2026-04-28T13:38:22Z",
    updatedAt: "2026-04-29T05:46:35Z",
  });
  const olderActiveIssue = item({
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-04-30T11:00:00Z",
  });

  assert.equal(
    reviewPriority(
      hotIssue,
      review("2026-04-29T07:24:53Z", "2026-04-29T05:46:35Z"),
      now,
      "current",
    ) <
      reviewPriority(
        olderActiveIssue,
        review("2026-04-30T10:00:00Z", "2026-04-29T00:00:00Z"),
        now,
        "current",
      ),
    true,
  );
});

test("hot issue priority is protected from hot PR backlog", () => {
  const now = Date.parse("2026-04-30T12:00:00Z");
  const review = {
    path: "items/123.md",
    markdown: "",
    reviewedAt: "2026-04-29T07:24:53Z",
    itemUpdatedAt: "2026-04-29T05:46:35Z",
    decision: "keep_open",
    reviewStatus: "complete",
    reviewPolicy: "current",
  };

  assert.equal(
    reviewPriority(
      item({
        kind: "issue",
        createdAt: "2026-04-28T13:38:22Z",
        updatedAt: "2026-04-29T05:46:35Z",
      }),
      review,
      now,
      "current",
    ) <
      reviewPriority(
        item({
          kind: "pull_request",
          createdAt: "2026-04-28T13:38:22Z",
          updatedAt: "2026-04-29T05:46:35Z",
        }),
        review,
        now,
        "current",
      ),
    true,
  );
});

test("hot issue priority is protected from policy mismatch backlog", () => {
  const now = Date.parse("2026-04-30T12:00:00Z");
  const review = (reviewPolicy) => ({
    path: "items/123.md",
    markdown: "",
    reviewedAt: "2026-04-29T07:24:53Z",
    itemUpdatedAt: "2026-04-29T05:46:35Z",
    decision: "keep_open",
    reviewStatus: "complete",
    reviewPolicy,
  });

  assert.equal(
    reviewPriority(
      item({
        kind: "issue",
        createdAt: "2026-04-28T13:38:22Z",
        updatedAt: "2026-04-29T05:46:35Z",
      }),
      review("old-policy"),
      now,
      "current",
    ) <
      reviewPriority(
        item({
          kind: "issue",
          createdAt: "2026-03-01T00:00:00Z",
          updatedAt: "2026-03-01T00:00:00Z",
        }),
        review("old-policy"),
        now,
        "current",
      ),
    true,
  );
});

test("normal scheduler reserves throughput for PR and older buckets", () => {
  const now = Date.parse("2026-04-30T12:00:00Z");
  const due = [];
  for (let number = 1; number <= 12; number += 1) {
    due.push({
      item: item({ number, kind: "issue", createdAt: "2026-04-30T00:00:00Z" }),
      bucket: "hot_issue",
      priority: 0,
      nextDueAt: number,
    });
  }
  due.push(
    {
      item: item({
        number: 101,
        kind: "pull_request",
        createdAt: "2026-04-30T00:00:00Z",
      }),
      bucket: "hot_pull_request",
      priority: 1,
      nextDueAt: 1,
    },
    {
      item: item({
        number: 201,
        kind: "pull_request",
        createdAt: "2026-04-25T00:00:00Z",
      }),
      bucket: "daily_pull_request",
      priority: 3,
      nextDueAt: 1,
    },
    {
      item: item({ number: 301, kind: "issue", createdAt: "2026-04-25T00:00:00Z" }),
      bucket: "weekly_issue",
      priority: 6,
      nextDueAt: 1,
    },
  );

  assert.deepEqual(selectedNumbers(due, 8, now), [1, 2, 3, 4, 101, 201, 301, 5]);
});

test("bulk-filed issues sort last while scheduler bucket priority stays intact", () => {
  const now = Date.parse("2026-07-16T12:00:00Z");
  const due = [
    {
      item: item({
        number: 1,
        kind: "issue",
        createdAt: "2026-07-15T00:00:00Z",
        labels: ["clawsweeper:bulk-filed"],
      }),
      bucket: "hot_issue",
      priority: 0,
      nextDueAt: 0,
    },
    {
      item: item({ number: 2, kind: "issue", createdAt: "2026-07-15T00:00:00Z" }),
      bucket: "hot_issue",
      priority: 0,
      nextDueAt: 100,
    },
    {
      item: item({
        number: 3,
        kind: "pull_request",
        createdAt: "2026-07-15T00:00:00Z",
      }),
      bucket: "hot_pull_request",
      priority: 1,
      nextDueAt: 0,
    },
  ];

  assert.deepEqual(selectedNumbers(due, 3, now), [2, 1, 3]);
  assert.deepEqual(selectedNumbers(due, 1, now), [2]);

  const onlyBulkHotIssue = due.filter((candidate) => candidate.item.number !== 2);
  assert.deepEqual(selectedNumbers(onlyBulkHotIssue, 1, now), [1]);

  const overdueWeeklyIssues = [
    {
      item: item({
        number: 10,
        createdAt: "2026-04-01T00:00:00Z",
        labels: ["clawsweeper:bulk-filed"],
      }),
      bucket: "weekly_issue",
      priority: 6,
      nextDueAt: 0,
    },
    {
      item: item({ number: 11, createdAt: "2026-05-01T00:00:00Z" }),
      bucket: "weekly_issue",
      priority: 6,
      nextDueAt: 100,
    },
  ];
  assert.deepEqual(selectedNumbers(overdueWeeklyIssues, 1, now), [11]);
});

test("mixed-bucket weekly-overdue ordering is transitive and globally bulk-last", () => {
  const now = Date.parse("2026-07-16T12:00:00Z");
  const due = [
    {
      item: item({
        number: 21,
        createdAt: "2026-04-01T00:00:00Z",
        labels: ["clawsweeper:bulk-filed"],
      }),
      bucket: "hot_issue",
      priority: 0,
    },
    {
      item: item({
        number: 22,
        createdAt: "2026-05-01T00:00:00Z",
        labels: ["clawsweeper:bulk-filed"],
      }),
      bucket: "weekly_issue",
      priority: 6,
    },
    {
      item: item({ number: 23, createdAt: "2026-06-01T00:00:00Z" }),
      bucket: "hot_issue",
      priority: 0,
    },
    {
      item: item({
        number: 24,
        kind: "pull_request",
        createdAt: "2026-07-01T00:00:00Z",
      }),
      bucket: "daily_pull_request",
      priority: 3,
    },
  ];

  assert.deepEqual(selectedNumbers(due, due.length, now), [23, 24, 21, 22]);
});

test("normal scheduler prioritizes oldest weekly-coverage timestamps before hot churn", () => {
  const now = Date.parse("2026-06-14T12:00:00Z");
  const due = [
    {
      item: item({
        number: 1,
        kind: "issue",
        createdAt: "2026-06-13T00:00:00Z",
      }),
      review: { reviewStatus: "complete", reviewedAt: "2026-06-08T11:00:00Z" },
      bucket: "hot_issue",
      priority: 0,
      reviewedAt: Date.parse("2026-06-08T11:00:00Z"),
      nextDueAt: 0,
    },
    {
      item: item({
        number: 2,
        kind: "pull_request",
        createdAt: "2026-06-01T00:00:00Z",
      }),
      review: { reviewStatus: "complete", reviewedAt: "2026-06-07T12:00:00Z" },
      bucket: "daily_pull_request",
      priority: 3,
      reviewedAt: Date.parse("2026-06-07T12:00:00Z"),
      nextDueAt: 0,
    },
    {
      item: item({
        number: 3,
        kind: "issue",
        createdAt: "2026-05-01T00:00:00Z",
      }),
      review: { reviewStatus: "complete", reviewedAt: "2026-06-06T12:00:00Z" },
      bucket: "weekly_issue",
      priority: 6,
      reviewedAt: Date.parse("2026-06-06T12:00:00Z"),
      nextDueAt: 0,
    },
  ];

  assert.deepEqual(selectedNumbers(due, 3, now), [3, 2, 1]);
});

test("normal scheduling ranks untracked items above stale records, then oldest review first", () => {
  const now = Date.parse("2026-06-14T12:00:00Z");
  const due = [
    {
      item: item({ number: 1, createdAt: "2026-06-13T00:00:00Z" }),
      bucket: "hot_issue",
      priority: 0,
      reviewedAt: 0,
      nextDueAt: 0,
    },
    {
      item: item({ number: 2, createdAt: "2026-01-01T00:00:00Z" }),
      review: { reviewStatus: "complete", reviewedAt: "2026-06-07T12:00:00Z" },
      bucket: "weekly_issue",
      priority: 6,
      reviewedAt: Date.parse("2026-06-07T12:00:00Z"),
      nextDueAt: 0,
    },
    {
      item: item({ number: 3, createdAt: "2026-01-01T00:00:00Z" }),
      review: { reviewStatus: "complete", reviewedAt: "2026-06-06T12:00:00Z" },
      bucket: "weekly_issue",
      priority: 6,
      reviewedAt: Date.parse("2026-06-06T12:00:00Z"),
      nextDueAt: 0,
    },
  ];

  assert.deepEqual(selectedNumbers(due, 3, now), [1, 3, 2]);
});

test("one repository's untracked backlog fills the queue-sized candidate limit", () => {
  const now = Date.parse("2026-07-30T12:00:00Z");
  const due = Array.from({ length: 3_084 }, (_, index) => ({
    item: item({
      number: index + 1,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }),
    bucket: "weekly_issue",
    priority: 6,
    reviewedAt: 0,
    nextDueAt: 0,
  }));

  const selected = selectedNumbers(due, 128, now);
  assert.equal(selected.length, 128);
  assert.equal(new Set(selected).size, 128);
});

test("weekly freshness preselection still fills remaining scheduler capacity", () => {
  const now = Date.parse("2026-06-14T12:00:00Z");
  const due = Array.from({ length: 5 }, (_, index) => ({
    item: item({
      number: index + 1,
      kind: "issue",
      createdAt: "2026-05-01T00:00:00Z",
    }),
    bucket: "hot_issue",
    priority: 0,
    nextDueAt: 0,
  }));
  due.push(
    {
      item: item({
        number: 6,
        kind: "pull_request",
        createdAt: "2026-06-13T00:00:00Z",
      }),
      bucket: "hot_pull_request",
      priority: 1,
      nextDueAt: 0,
    },
    {
      item: item({
        number: 7,
        kind: "issue",
        createdAt: "2026-06-13T00:00:00Z",
      }),
      bucket: "hot_issue",
      priority: 0,
      nextDueAt: 0,
    },
  );

  assert.deepEqual(selectedNumbers(due, 7, now), [1, 2, 3, 4, 5, 7, 6]);
});

test("normal scheduler can fill active floor from stale current reviews", () => {
  const selected = [
    {
      item: item({ number: 1, kind: "issue", createdAt: "2026-04-30T00:00:00Z" }),
      bucket: "hot_issue",
      priority: 0,
      nextDueAt: 1,
    },
  ];
  const backfill = [
    {
      item: item({ number: 10, kind: "pull_request", createdAt: "2026-03-01T00:00:00Z" }),
      bucket: "daily_pull_request",
      priority: 3,
      reviewedAt: 100,
      nextDueAt: 1000,
    },
    {
      item: item({ number: 11, kind: "issue", createdAt: "2026-03-01T00:00:00Z" }),
      bucket: "weekly_issue",
      priority: 6,
      reviewedAt: 50,
      nextDueAt: 2000,
    },
    {
      item: item({ number: 1, kind: "issue", createdAt: "2026-04-30T00:00:00Z" }),
      bucket: "hot_issue",
      priority: 0,
      reviewedAt: 25,
      nextDueAt: 3000,
    },
  ];

  assert.deepEqual(backfilledNumbers(selected, backfill, 3, 10), [1, 10, 11]);
  assert.deepEqual(backfilledNumbers(selected, backfill, 3, 2), [1, 10]);
});

test("hot intake recency prefers newly updated or created issues", () => {
  assert.equal(
    hotIntakeRecencyMs(
      item({
        createdAt: "2026-04-29T21:28:12Z",
        updatedAt: "2026-04-29T21:28:12Z",
      }),
    ) >
      hotIntakeRecencyMs(
        item({
          createdAt: "2026-04-27T02:40:44Z",
          updatedAt: "2026-04-27T02:40:44Z",
        }),
      ),
    true,
  );
  assert.equal(
    hotIntakeRecencyMs(
      item({
        createdAt: "2026-04-27T02:40:44Z",
        updatedAt: "2026-04-29T22:30:00Z",
      }),
    ),
    Date.parse("2026-04-29T22:30:00Z"),
  );
});
