import assert from "node:assert/strict";
import test from "node:test";

import {
  createStatusContext,
  linkedIssueNumbersForPullRequestBody,
} from "../dist/clawsweeper-status-context.js";
import { GitHubRateLimitError } from "../dist/github-retry.js";
import { closeDecision, item, reportFrontMatter } from "./helpers.ts";

function statusContextWithCalls(
  defaultBranch = "main",
  options: {
    rateLimitOnApplyRead?: boolean;
    rateLimitOnIssueRead?: boolean;
    rateLimitOnContainmentRead?: boolean;
    freshApplyBody?: boolean;
    mergeCommitReachable?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const recentPulls = [
    pull(701, "cold-list-a", 101),
    {
      ...pull(702, "merge-cold-list-b", 102),
      head: { sha: "cold-list-b" },
    },
    {
      ...pull(705, "other-merge-for-list-a-head", 101),
      head: { sha: "cold-list-a" },
    },
  ];
  const fallbackPulls = new Map([
    ["cold-list-a", [recentPulls[0], recentPulls[2]]],
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
    if (path === "graphql") {
      if (options.rateLimitOnIssueRead) throw new GitHubRateLimitError("API rate limit exceeded");
      return {
        data: {
          repository: {
            issue: {
              state: "CLOSED",
              timelineItems: {
                nodes: [
                  {
                    __typename: "ClosedEvent",
                    createdAt: "2026-08-19T12:00:00Z",
                    closer: {
                      __typename: "PullRequest",
                      number: 900,
                      repository: { nameWithOwner: "openclaw/openclaw" },
                    },
                  },
                ],
              },
            },
          },
        },
      } as T;
    }
    if (path === "repos/openclaw/openclaw") return { default_branch: defaultBranch } as T;
    if (path.startsWith("repos/openclaw/openclaw/pulls?")) return recentPulls as T;
    if (path === "repos/openclaw/openclaw/pulls/123") {
      if (options.rateLimitOnApplyRead) throw new GitHubRateLimitError("API rate limit exceeded");
      return { body: options.freshApplyBody ? "Fixes #456" : "No longer linked" } as T;
    }
    if (path === "repos/openclaw/openclaw/pulls/900") {
      return { ...pull(900, "current", 456), base: { ref: defaultBranch } } as T;
    }
    if (path.startsWith("repos/openclaw/openclaw/compare/current...")) {
      if (options.rateLimitOnContainmentRead)
        throw new GitHubRateLimitError("API rate limit exceeded");
      return { status: options.mergeCommitReachable === false ? "diverged" : "ahead" } as T;
    }
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

test("implementation provenance ignores HTML-commented issue references", () => {
  assert.equal(
    linkedIssueNumbersForPullRequestBody("<!--\nFixes #456\n-->", "openclaw/openclaw"),
    null,
  );
  assert.deepEqual(
    linkedIssueNumbersForPullRequestBody(
      "<!-- template example -->\nFixes #456",
      "openclaw/openclaw",
    ),
    [456],
  );
  assert.deepEqual(
    linkedIssueNumbersForPullRequestBody("Fixes #456 <!-- template note -->", "openclaw/openclaw"),
    [456],
  );
  assert.deepEqual(
    linkedIssueNumbersForPullRequestBody(
      "```html\n<!-- intentionally unmatched example\n```\nFixes #456",
      "openclaw/openclaw",
    ),
    [456],
  );
});

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

test("a merge-commit match is authoritative even when another pull shares its head SHA", () => {
  const { calls, context } = statusContextWithCalls();
  const resolved = context.attachFixedPullRequest(
    closeDecision({ fixedSha: "cold-list-a" }),
    item({ number: 101, kind: "issue" }),
    {},
  );

  assert.equal(resolved.fixedPullRequest?.number, 701);
  assert.deepEqual(
    calls.filter((path) => /\/commits\/[^/]+\/pulls$/.test(path)),
    [],
    "an exact merge-commit match must not use the per-SHA fallback",
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

test("PR implementation closeout revalidates current issue linkage on the repository default branch", () => {
  const { calls, context } = statusContextWithCalls("master");
  const resolved = context.attachFixedPullRequest(
    closeDecision({ fixedSha: "same-sha" }),
    item({ number: 123, kind: "pull_request" }),
    { pullRequest: { body: "Fixes #456" } },
    persistedReview(123, "same-sha", 999),
  );

  assert.equal(resolved.fixedPullRequest?.number, 900);
  assert.equal(resolved.fixedPullRequest?.source, "GitHub linked-issue current closing PR");
  assert.deepEqual(calls, [
    "graphql",
    "repos/openclaw/openclaw",
    "repos/openclaw/openclaw/pulls/900",
    "repos/openclaw/openclaw/compare/current...master",
  ]);
});

test("PR implementation closeout rejects a fixing merge commit no longer on the default branch", () => {
  const { calls, context } = statusContextWithCalls("main", { mergeCommitReachable: false });
  const resolved = context.attachFixedPullRequest(
    closeDecision({ fixedSha: "same-sha" }),
    item({ number: 123, kind: "pull_request" }),
    { pullRequest: { body: "Fixes #456" } },
    persistedReview(123, "same-sha", 999),
  );

  assert.equal(resolved.fixedPullRequest, null);
  assert.deepEqual(calls, [
    "graphql",
    "repos/openclaw/openclaw",
    "repos/openclaw/openclaw/pulls/900",
    "repos/openclaw/openclaw/compare/current...main",
  ]);
});

test("apply-time PR closeout rejects stale issue linkage", () => {
  const { calls, context } = statusContextWithCalls();
  const block = context.implementedOnMainPullRequestProvenanceApplyBlock(
    reportFrontMatter({ fixed_pr_number: "900" }),
    item({ number: 123, kind: "pull_request" }),
    "implemented_on_main",
  );

  assert.equal(
    block,
    "implemented-on-main close no longer has a current explicit same-repository issue link",
  );
  assert.deepEqual(calls, ["repos/openclaw/openclaw/pulls/123"]);
});

test("apply-time PR closeout propagates GitHub rate limits", () => {
  const { context } = statusContextWithCalls("main", { rateLimitOnApplyRead: true });
  assert.throws(
    () =>
      context.implementedOnMainPullRequestProvenanceApplyBlock(
        reportFrontMatter({ fixed_pr_number: "900" }),
        item({ number: 123, kind: "pull_request" }),
        "implemented_on_main",
      ),
    GitHubRateLimitError,
  );
});

test("apply-time PR closeout propagates linked-issue GitHub rate limits", () => {
  const { context } = statusContextWithCalls("main", {
    freshApplyBody: true,
    rateLimitOnIssueRead: true,
  });
  assert.throws(
    () =>
      context.implementedOnMainPullRequestProvenanceApplyBlock(
        reportFrontMatter({ fixed_pr_number: "900" }),
        item({ number: 123, kind: "pull_request" }),
        "implemented_on_main",
      ),
    GitHubRateLimitError,
  );
});

test("apply-time PR closeout fails closed when the fixing merge commit left the default branch", () => {
  const { context } = statusContextWithCalls("main", {
    freshApplyBody: true,
    mergeCommitReachable: false,
  });
  assert.equal(
    context.implementedOnMainPullRequestProvenanceApplyBlock(
      reportFrontMatter({ fixed_pr_number: "900" }),
      item({ number: 123, kind: "pull_request" }),
      "implemented_on_main",
    ),
    "implemented-on-main close no longer has current GitHub-verified fixing pull request provenance",
  );
});

test("apply-time PR closeout propagates fixing-commit containment rate limits", () => {
  const { context } = statusContextWithCalls("main", {
    freshApplyBody: true,
    rateLimitOnContainmentRead: true,
  });
  assert.throws(
    () =>
      context.implementedOnMainPullRequestProvenanceApplyBlock(
        reportFrontMatter({ fixed_pr_number: "900" }),
        item({ number: 123, kind: "pull_request" }),
        "implemented_on_main",
      ),
    GitHubRateLimitError,
  );
});
