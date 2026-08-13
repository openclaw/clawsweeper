import assert from "node:assert/strict";
import test from "node:test";

import { createStatusContext } from "../dist/clawsweeper-status-context.js";
import { closeDecision, item, reportFrontMatter } from "./helpers.ts";

function statusContextWithCalls() {
  const calls: string[] = [];
  const recentPulls = [
    pull(701, "cold-list-a", 101),
    {
      ...pull(702, "merge-cold-list-b", 102),
      head: { sha: "cold-list-b" },
    },
  ];
  const fallbackPulls = new Map([
    [
      "cold-list-b",
      [
        recentPulls[1],
        {
          ...pull(704, "other-merge-for-shared-head", 102),
          head: { sha: "cold-list-b" },
        },
      ],
    ],
    ["cold-fallback", [pull(703, "cold-fallback", 103)]],
  ]);
  const ghJson = <T>(args: string[]): T => {
    const path = args[1] ?? "";
    calls.push(path);
    if (path === "repos/openclaw/openclaw") return { default_branch: "main" } as T;
    if (path.startsWith("repos/openclaw/openclaw/pulls?")) return recentPulls as T;
    const fallback = path.match(/^repos\/openclaw\/openclaw\/commits\/([^/]+)\/pulls$/);
    if (fallback?.[1]) return (fallbackPulls.get(fallback[1]) ?? []) as T;
    const commit = path.match(/^repos\/openclaw\/openclaw\/commits\/([^/]+)$/);
    if (commit?.[1]) return { commit: { message: `Fixes #${issueForSha(commit[1])}` } } as T;
    throw new Error(`Unexpected GitHub path: ${path}`);
  };
  const context = createStatusContext({
    targetProfile: () => ({}) as never,
    targetRepo: () => "openclaw/openclaw",
    markdownLink: (label) => label,
    repoUrlFor: () => "",
    linkedRelease: (tag) => tag,
    linkedSha: (sha) => sha,
    profileStatusStart: () => "",
    profileStatusEnd: () => "",
    sweepStatusPath: () => "",
    markdownRepository: () => "openclaw/openclaw",
    ghJson,
    asRecord: (value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {},
    frontMatterValue: (markdown, key) => {
      const value = markdown.match(new RegExp(`^${key}: (.*)$`, "m"))?.[1];
      return value?.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
    },
    stringOrUndefined: (value) => (typeof value === "string" ? value : undefined),
    numberOrUndefined: (value) => (typeof value === "number" ? value : undefined),
    recordOrUndefined: (value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined,
  });
  return { calls, context };
}

function issueForSha(sha: string): number {
  return sha === "cold-list-a" ? 101 : sha === "cold-list-b" ? 102 : 103;
}

function pull(number: number, sha: string, issueNumber: number) {
  return {
    number,
    html_url: `https://github.com/openclaw/openclaw/pull/${number}`,
    title: `fix: issue ${issueNumber}`,
    merged_at: `2026-08-${String(number - 690).padStart(2, "0")}T12:00:00Z`,
    merge_commit_sha: sha,
    head: { sha: `head-${sha}` },
    body: `Fixes #${issueNumber}`,
    base: { ref: "main" },
  };
}

function persistedReview(issueNumber: number, fixedSha: string, pullNumber: number): string {
  return reportFrontMatter({
    repository: "openclaw/openclaw",
    number: String(issueNumber),
    fixed_sha: fixedSha,
    fixed_pr_url: `https://github.com/openclaw/openclaw/pull/${pullNumber}`,
    fixed_pr_number: String(pullNumber),
    fixed_pr_title: JSON.stringify(`fix: issue ${issueNumber}`),
    fixed_pr_merged_at: "2026-08-01T12:00:00Z",
    fixed_pr_sha: fixedSha,
    fixed_pr_confidence: "high",
    fixed_pr_source: JSON.stringify("GitHub commit PR lookup"),
  });
}

test("fixed-SHA issue enrichment reuses repeats and batches cold resolutions", () => {
  const { calls, context } = statusContextWithCalls();
  const repeatFixtures = [
    [91, "repeat-a", 691],
    [92, "repeat-b", 692],
    [93, "repeat-c", 693],
    [94, "repeat-d", 694],
  ] as const;
  const coldFixtures = [
    [101, "cold-list-a", 701],
    [102, "cold-list-b", 704],
    [103, "cold-fallback", 703],
  ] as const;

  for (const [issueNumber, fixedSha, pullNumber] of repeatFixtures) {
    const resolved = context.attachFixedPullRequest(
      closeDecision({ fixedSha }),
      item({ number: issueNumber, kind: "issue" }),
      {},
      persistedReview(issueNumber, fixedSha, pullNumber),
    );
    assert.equal(resolved.fixedPullRequest?.number, pullNumber);
    assert.equal(resolved.fixedPullRequest?.source, "GitHub commit PR lookup");
  }
  assert.deepEqual(calls, [], "persisted repeat associations cost zero GitHub calls");

  for (const [issueNumber, fixedSha, pullNumber] of coldFixtures) {
    const resolved = context.attachFixedPullRequest(
      closeDecision({ fixedSha }),
      item({ number: issueNumber, kind: "issue" }),
      {},
    );
    assert.equal(resolved.fixedPullRequest?.number, pullNumber);
  }

  const pullLists = calls.filter((path) => path.includes("/pulls?state=all"));
  const commitPulls = calls.filter((path) => /\/commits\/[^/]+\/pulls$/.test(path));
  const before = {
    commitPulls: repeatFixtures.length + coldFixtures.length,
    pullLists: 0,
  };
  assert.deepEqual(before, { commitPulls: 7, pullLists: 0 });
  assert.equal(pullLists.length, 1, "one cold pull-list request per repository cycle");
  assert.deepEqual(commitPulls, [
    "repos/openclaw/openclaw/commits/cold-list-b/pulls",
    "repos/openclaw/openclaw/commits/cold-fallback/pulls",
  ]);
  assert.deepEqual(
    { commitPulls: commitPulls.length, pullLists: pullLists.length },
    { commitPulls: 2, pullLists: 1 },
  );
});

test("a shared head SHA preserves exact association ordering", () => {
  const { calls, context } = statusContextWithCalls();
  const resolved = context.attachFixedPullRequest(
    closeDecision({ fixedSha: "cold-list-b" }),
    item({ number: 102, kind: "issue" }),
    {},
  );

  assert.equal(resolved.fixedPullRequest?.number, 704);
  assert.deepEqual(
    calls.filter((path) => /\/commits\/[^/]+\/pulls$/.test(path)),
    ["repos/openclaw/openclaw/commits/cold-list-b/pulls"],
  );
});

test("a changed fixed SHA does not reuse a prior association", () => {
  const { calls, context } = statusContextWithCalls();
  const resolved = context.attachFixedPullRequest(
    closeDecision({ fixedSha: "cold-list-a" }),
    item({ number: 101, kind: "issue" }),
    {},
    persistedReview(101, "old-fixed-sha", 999),
  );

  assert.equal(resolved.fixedPullRequest?.number, 701);
  assert.equal(calls.filter((path) => path.includes("/pulls?state=all")).length, 1);
});
