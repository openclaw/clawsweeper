import assert from "node:assert/strict";
import test from "node:test";

import { createApplyGuards } from "../dist/clawsweeper-apply-guards.js";
import { LiveReadGeneration } from "../dist/live-read-generation.js";

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

test("apply policy guards share canonical full-object reads", () => {
  const calls = [];
  const guards = createGuards({
    ghJson: (args) => {
      calls.push(args);
      const path = args[1];
      if (path?.endsWith("/issues/42")) return { assignees: [] };
      if (path?.endsWith("/pulls/42"))
        return {
          created_at: "2025-01-01T00:00:00Z",
          mergeable: false,
          mergeable_state: "dirty",
          requested_reviewers: [],
          requested_teams: [],
          user: { login: "contributor" },
          head: {},
        };
      return {};
    },
  });
  const item = { createdAt: "2025-01-01T00:00:00Z", labels: [] };

  guards.unconfirmedProductDirectionApplyBlockReasonSafe(42, item, undefined, undefined);
  guards.lowSignalUnmergeablePrApplyBlockReasonSafe(42, 30);

  const pullCalls = calls.filter((args) => args[1] === "repos/openclaw/openclaw/pulls/42");
  assert.equal(pullCalls.length, 1);
  assert.equal(pullCalls[0]?.includes("--jq"), false);
});

test("apply guards follow generation invalidation and explicit bypass", () => {
  let calls = 0;
  const guards = createGuards({
    ghPaged: () => {
      calls += 1;
      return [];
    },
  });
  const generation = new LiveReadGeneration();
  guards.setGuardReadGeneration(generation);

  guards.issueRecentHumanCommentBlockReasonSafe(42, 30);
  guards.issueRecentHumanCommentBlockReasonSafe(42, 30);
  assert.equal(calls, 1);

  generation.invalidate();
  guards.issueRecentHumanCommentBlockReasonSafe(42, 30);
  assert.equal(calls, 2);

  guards.withGuardReadOptions({ bypassGenerationCache: true }, () =>
    guards.issueRecentHumanCommentBlockReasonSafe(42, 30),
  );
  assert.equal(calls, 3);
});
