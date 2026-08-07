import assert from "node:assert/strict";
import test from "node:test";

import { createApplyGuards } from "../dist/clawsweeper-apply-guards.js";

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function createGuards({ ghJson = () => ({}), ghPaged = () => [] } = {}) {
  return createApplyGuards({
    asRecord,
    authorPrBudget: () => 10,
    authorPrBudgetAgeSkipReason: () => null,
    authorPrBudgetCloseEnabled: () => true,
    ghJson,
    ghPaged,
    isMaintainerAuthorAssociation: (value) => ["MEMBER", "OWNER", "COLLABORATOR"].includes(value),
    isMaintainerAuthored: () => false,
    isOlderThanDays: () => true,
    labelNames: (value) =>
      Array.isArray(value)
        ? value.flatMap((label) => {
            if (typeof label === "string") return [label];
            const name = asRecord(label).name;
            return typeof name === "string" ? [name] : [];
          })
        : [],
    login: (value) => {
      const login = asRecord(value).login;
      return typeof login === "string" ? login : undefined;
    },
    normalizeLabelName: (label) => label.trim().toLowerCase(),
    obsoleteFixPrAgeSkipReason: () => null,
    obsoleteFixPrCloseEnabled: () => true,
    protectedLabels: () => [],
    quoteGitHubSearchTerm: (term) => term,
    reportPrRating: () => ({
      proofTier: "F",
      patchTier: "F",
      overallTier: "F",
      summary: "",
      nextSteps: [],
    }),
    reportRealBehaviorProof: () => ({
      status: "missing",
      summary: "",
      evidenceKind: "not_applicable",
      needsContributorAction: true,
    }),
    staleVersionBugAgeSkipReason: () => null,
    staleVersionBugCloseEnabled: () => true,
    stringOrUndefined: (value) => (typeof value === "string" ? value : undefined),
    targetRepo: () => "openclaw/openclaw",
    unconfirmedProductDirectionAgeSkipReason: () => null,
    unconfirmedProductDirectionCloseEnabled: () => true,
    unsponsoredFeatureAgeSkipReason: () => null,
    unsponsoredFeatureCloseEnabled: () => true,
  });
}

test("apply guard reads share a paged endpoint across guard functions", () => {
  const calls = [];
  const guards = createGuards({
    ghPaged: (path) => {
      calls.push(path);
      return [];
    },
  });

  guards.issueRecentHumanCommentBlockReasonSafe(42, 30);
  guards.stalledUnprovenProofRequestBlockReason(42);

  assert.equal(
    calls.filter((path) => path === "repos/openclaw/openclaw/issues/42/comments").length,
    1,
  );
  assert.equal(
    calls.filter((path) => path === "repos/openclaw/openclaw/issues/42/timeline").length,
    1,
  );
});

test("apply guard reads share a JSON endpoint across guard functions", () => {
  const calls = [];
  const guards = createGuards({
    ghJson: (args) => {
      calls.push(args);
      return {
        state: "open",
        created_at: "2025-01-01T00:00:00Z",
        labels: [],
        assignees: [],
        milestone: null,
        reactions: { total_count: 0 },
      };
    },
  });
  const item = { createdAt: "2025-01-01T00:00:00Z" };

  guards.unsponsoredFeatureApplyBlockReasonSafe(42, item);
  guards.staleVersionBugApplyBlockReasonSafe(42, item);

  assert.equal(
    calls.filter(
      (args) =>
        JSON.stringify(args) === JSON.stringify(["api", "repos/openclaw/openclaw/issues/42"]),
    ).length,
    1,
  );
});

test("apply guard read cache resets between items", () => {
  const calls = [];
  const guards = createGuards({
    ghPaged: (path) => {
      calls.push(path);
      return [];
    },
  });

  guards.issueRecentHumanCommentBlockReasonSafe(1, 30);
  guards.issueRecentHumanCommentBlockReasonSafe(1, 30);
  assert.equal(calls.length, 1);

  guards.resetGuardReadCache();
  guards.issueRecentHumanCommentBlockReasonSafe(1, 30);
  guards.issueRecentHumanCommentBlockReasonSafe(2, 30);

  assert.deepEqual(calls, [
    "repos/openclaw/openclaw/issues/1/comments",
    "repos/openclaw/openclaw/issues/1/comments",
    "repos/openclaw/openclaw/issues/2/comments",
  ]);
});

test("apply guard read cache distinguishes full request arguments", () => {
  const calls = [];
  const guards = createGuards({
    ghJson: (args) => {
      calls.push(args);
      const path = args[1];
      if (path?.endsWith("/issues/42")) return { assignees: [] };
      if (path?.endsWith("/pulls/42")) {
        return args.includes("--jq")
          ? { requested_reviewers: [], requested_teams: [] }
          : {
              created_at: "2025-01-01T00:00:00Z",
              mergeable: false,
              mergeable_state: "dirty",
              requested_reviewers: [],
              requested_teams: [],
              user: { login: "contributor" },
              head: {},
            };
      }
      return {};
    },
  });
  const item = { createdAt: "2025-01-01T00:00:00Z", labels: [] };

  guards.unconfirmedProductDirectionApplyBlockReasonSafe(42, item, undefined, undefined);
  guards.lowSignalUnmergeablePrApplyBlockReasonSafe(42, 30);

  const pullCalls = calls.filter((args) => args[1] === "repos/openclaw/openclaw/pulls/42");
  assert.equal(pullCalls.length, 2);
  assert.equal(
    pullCalls.some((args) => args.includes("--jq")),
    true,
  );
  assert.equal(
    pullCalls.some((args) => !args.includes("--jq")),
    true,
  );
});
