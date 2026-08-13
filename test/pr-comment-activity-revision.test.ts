import assert from "node:assert/strict";
import test from "node:test";

import {
  createReviewPlanningInventory,
  PR_ACTIVITY_REVISION_CONNECTION_LIMIT,
  PR_ACTIVITY_REVISION_QUERY_PAGE_SIZE,
} from "../dist/clawsweeper-review-planning-inventory.js";
import { fetchPrCommentActivityRevision } from "../dist/pr-comment-activity-revision.js";

function emptyPullRequest() {
  return {
    reviews: { totalCount: 0 },
    reviewThreads: {
      totalCount: 0,
      pageInfo: { hasNextPage: false },
      nodes: [],
    },
  };
}

function activityPullRequest(updatedAt = "2026-08-13T06:08:04Z") {
  return {
    reviews: { totalCount: 1 },
    reviewThreads: {
      totalCount: 1,
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: "thread-1",
          comments: {
            totalCount: 1,
            pageInfo: { hasNextPage: false },
            nodes: [{ id: "comment-1", updatedAt }],
          },
        },
      ],
    },
  };
}

function inventory(ghJson: (args: string[]) => unknown) {
  return createReviewPlanningInventory({
    targetRepo: () => "openclaw/clawsweeper",
    ghJson,
  } as never);
}

function queryFrom(args: string[]) {
  return args.find((arg) => arg.startsWith("query="))?.slice("query=".length) ?? "";
}

test("planning batches PR activity validation and revisions move on add, edit, and delete", () => {
  let current = emptyPullRequest();
  const calls: string[][] = [];
  const planner = inventory((args) => {
    calls.push(args);
    return { data: { repository: { pr_1153: current } } };
  });
  const items = [
    { kind: "pull_request" as const, number: 1153 },
    { kind: "issue" as const, number: 99 },
  ];

  const before = planner.fetchPlannedPrActivityRevisions(items);
  current = activityPullRequest();
  const added = planner.fetchPlannedPrActivityRevisions(items);
  current = activityPullRequest("2026-08-13T06:08:22Z");
  const edited = planner.fetchPlannedPrActivityRevisions(items);
  current = emptyPullRequest();
  const deleted = planner.fetchPlannedPrActivityRevisions(items);

  assert.equal(calls.length, 4, "each planning cycle makes one batched query, not one per item");
  assert.match(queryFrom(calls[0]!), /pr_1153: pullRequest\(number: 1153\)/);
  assert.doesNotMatch(queryFrom(calls[0]!), /pr_99:/);
  assert.match(queryFrom(calls[0]!), /reviews \{ totalCount \}/);
  assert.match(queryFrom(calls[0]!), /nodes \{ id updatedAt \}/);
  assert.notEqual(before.revisions["1153"], added.revisions["1153"], "ADD must move");
  assert.notEqual(added.revisions["1153"], edited.revisions["1153"], "EDIT must move");
  assert.notEqual(edited.revisions["1153"], deleted.revisions["1153"], "DELETE must move");
});

test("large plans use bounded GraphQL pages and report their request count", () => {
  const queries: string[] = [];
  const planner = inventory((args) => {
    const query = queryFrom(args);
    queries.push(query);
    const repository: Record<string, unknown> = {};
    for (const match of query.matchAll(/pr_(\d+): pullRequest/g)) {
      repository[`pr_${match[1]}`] = emptyPullRequest();
    }
    return { data: { repository } };
  });
  const count = PR_ACTIVITY_REVISION_QUERY_PAGE_SIZE * 2 + 5;
  const result = planner.fetchPlannedPrActivityRevisions(
    Array.from({ length: count }, (_, index) => ({
      kind: "pull_request" as const,
      number: index + 1,
    })),
  );

  assert.equal(result.requestCount, 3);
  assert.equal(result.pageSize, PR_ACTIVITY_REVISION_QUERY_PAGE_SIZE);
  assert.equal(result.connectionLimit, PR_ACTIVITY_REVISION_CONNECTION_LIMIT);
  assert.deepEqual(
    queries.map((query) => [...query.matchAll(/pr_(\d+): pullRequest/g)].length),
    [PR_ACTIVITY_REVISION_QUERY_PAGE_SIZE, PR_ACTIVITY_REVISION_QUERY_PAGE_SIZE, 5],
  );
  assert.equal(Object.values(result.revisions).filter(Boolean).length, count);
});

test("GraphQL errors and incomplete connections fail closed", () => {
  const failed = inventory(() => {
    throw new Error("GraphQL unavailable");
  }).fetchPlannedPrActivityRevisions([{ kind: "pull_request", number: 1153 }]);
  assert.equal(failed.revisions["1153"], null);
  assert.equal(failed.requestCount, 1);

  const incomplete = inventory(() => ({
    data: {
      repository: {
        pr_1153: {
          ...activityPullRequest(),
          reviewThreads: {
            ...activityPullRequest().reviewThreads,
            pageInfo: { hasNextPage: true },
          },
        },
      },
    },
  })).fetchPlannedPrActivityRevisions([{ kind: "pull_request", number: 1153 }]);
  assert.equal(incomplete.revisions["1153"], null);
});

test("hydration-time checks reuse the planning query and revision decoder", () => {
  const calls: string[][] = [];
  const revision = fetchPrCommentActivityRevision({
    repo: "openclaw/clawsweeper",
    number: 1153,
    ghJson: (args) => {
      calls.push(args);
      return { data: { repository: { pr_1153: activityPullRequest() } } };
    },
  });
  const planned = inventory(() => ({
    data: { repository: { pr_1153: activityPullRequest() } },
  })).fetchPlannedPrActivityRevisions([{ kind: "pull_request", number: 1153 }]);

  assert.equal(calls.length, 1);
  assert.match(queryFrom(calls[0]!), /pr_1153: pullRequest\(number: 1153\)/);
  assert.equal(revision, planned.revisions["1153"]);
  assert.throws(
    () =>
      fetchPrCommentActivityRevision({
        repo: "openclaw/clawsweeper",
        number: 1153,
        ghJson: () => ({ errors: [{ message: "unavailable" }] }),
      }),
    /GraphQL returned errors/,
  );
});
