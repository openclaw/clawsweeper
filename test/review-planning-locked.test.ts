import assert from "node:assert/strict";
import test from "node:test";

import { createReviewPlanning } from "../dist/clawsweeper-review-planning.js";

const repo = "openclaw/openclaw";

function listItem(number: number, locked: boolean, pullRequest = false) {
  return {
    number,
    title: `Item ${number}`,
    html_url: `https://github.com/${repo}/issues/${number}`,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-09-09T02:17:31Z",
    author_association: "NONE",
    user: { login: "reporter" },
    labels: [],
    pull_request: pullRequest ? { url: "pull" } : null,
    locked,
  };
}

function planning(listings: string[][]) {
  const page = [listItem(56312, true), listItem(56313, false), listItem(119055, true, true)];
  return createReviewPlanning({
    maxPlanShardCount: 8,
    targetRepo: () => repo,
    ghJson: () => {
      throw new Error("planning must not read single items");
    },
    ghJsonLines: (args: string[]) => {
      listings.push(args);
      return /[?&]page=1$/.test(String(args[1])) ? structuredClone(page) : [];
    },
    fetchReviewedPrActivityCursor: () => null,
    ghPaged: () => [],
    githubCount: () => null,
    itemSourceRevisionSha256: () => "",
    normalizeAuthorAssociation: (value: unknown) => String(value ?? "NONE"),
    shouldPlanItem: () => true,
    failedReviewRetryStatePath: () => "",
    readFailedReviewRetryState: () => null,
    failedReviewRetryMarkdownWithState: (markdown: string) => markdown,
    repoRelativePath: (path: string) => path,
    dashboardClosedAt: () => undefined,
  } as never);
}

test("scheduled planning never offers open-but-locked conversations", () => {
  for (const hotIntake of [false, true]) {
    const listings: string[][] = [];
    const plan = planning(listings).planCandidates({
      batchSize: 50,
      maxPages: 2,
      shardCount: 1,
      itemsDir: "/nonexistent",
      reviewPolicy: "policy",
      hotIntake,
      minimumActiveShards: 38,
    });
    assert.deepEqual(
      plan.candidates.map((item: { number: number }) => item.number),
      [56313],
      `${hotIntake ? "hot" : "normal"} planning skips locked items`,
    );
    assert.equal(plan.dueBacklog, 1);
    assert.ok(listings.length > 0);
    // The skip depends on the open-item projection carrying the lock bit.
    for (const args of listings) assert.match(String(args.at(-1)), /,locked\}$/);
  }

  const selected = planning([]).selectCandidates({
    batchSize: 50,
    maxPages: 2,
    shardIndex: 0,
    shardCount: 1,
    itemsDir: "/nonexistent",
    reviewPolicy: "policy",
  });
  assert.deepEqual(
    selected.candidates.map((item: { number: number }) => item.number),
    [56313],
  );
});
