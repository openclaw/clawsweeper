import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  promotionGhMock,
  reportWithSyncedReviewComment,
  runApplyDecisionsForTest,
  tmpPrefix,
  withMockGh,
  workPlanCandidateReport,
} from "./helpers.ts";

function obsoleteFixReport(headSha = "head-sha") {
  const base = workPlanCandidateReport({
    number: 321,
    repository: "openclaw/openclaw",
    type: "pull_request",
    title: "Fix old CI bootstrap",
    author: "reporter",
    author_association: "CONTRIBUTOR",
    labels: "[]",
    decision: "close",
    action_taken: "proposed_close",
    close_reason: "obsolete_fix_pr",
    confidence: "high",
    work_candidate: "none",
    work_status: "none",
    item_snapshot_hash: "reviewed-snapshot",
    item_created_at: "2026-01-01T00:00:00Z",
    item_updated_at: "2026-01-01T00:00:00Z",
    pull_head_sha: headSha,
    pr_rating_overall: "A",
    pr_rating_proof: "A",
    pr_rating_patch: "A",
  }).replace(
    "The dashboard has queue_fix_pr candidates but no generated coding plan.",
    "This was a careful, well-proven contribution, but `src/runtime.ts` and `test/runtime.test.ts` were rewritten on main after its head commit.",
  );
  return `${base}

## Real Behavior Proof

Status: sufficient
Evidence kind: terminal
Needs contributor action: false
Summary: The original patch was well proven before the target workflow was replaced.

## PR Rating

Overall tier: A
Proof tier: A
Patch tier: A
Summary: Strong contribution made obsolete by later main-branch work.
Next rank-up steps:
- none

## Evidence

- **main rewrite:** Current main rewrote src/runtime.ts and test/runtime.test.ts after this PR's head commit.

## Close Comment

Thank you for the careful fix. \`src/runtime.ts\` and \`test/runtime.test.ts\` were rewritten on main after this contribution, so the original patch is now moot. If the problem still reproduces, a fresh PR against current main is welcome.
`;
}

type RunOptions = Parameters<typeof promotionGhMock>[0] & {
  enabled?: boolean;
  maintainerComment?: boolean;
};

function runObsoleteFixApply(overrides: Partial<RunOptions> = {}) {
  const root = mkdtempSync(tmpPrefix);
  const previous = process.env.CLAWSWEEPER_OBSOLETE_FIX_PR_CLOSE_ENABLED;
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const synced = reportWithSyncedReviewComment(
      obsoleteFixReport(overrides.headSha ?? "head-sha"),
      321,
      "obsolete_fix_pr",
    );
    writeFileSync(join(itemsDir, "321.md"), synced.report, "utf8");
    if (overrides.enabled === false) delete process.env.CLAWSWEEPER_OBSOLETE_FIX_PR_CLOSE_ENABLED;
    else process.env.CLAWSWEEPER_OBSOLETE_FIX_PR_CLOSE_ENABLED = "true";

    const options: RunOptions = {
      number: 321,
      title: "Fix old CI bootstrap",
      comment: synced.comment,
      labels: [],
      itemCreatedAt: "2026-01-01T00:00:00Z",
      itemUpdatedAt: "2026-01-01T00:00:00Z",
      headActivityAt: "2026-01-01T01:00:00Z",
      headCommittedAt: "2026-01-01T00:00:00Z",
      changedFiles: 2,
      sourceFiles: ["src/runtime.ts", "test/runtime.test.ts"],
      postHeadPathChanges: {
        "src/runtime.ts": "2026-06-01T00:00:00Z",
        "test/runtime.test.ts": "2026-06-02T00:00:00Z",
      },
      mergeable: true,
      mergeableState: "clean",
      ...overrides,
    };
    if (overrides.maintainerComment) {
      options.comments = [
        {
          id: 9321,
          created_at: "2026-01-01T01:00:00Z",
          updated_at: "2026-01-01T01:00:00Z",
          user: { login: "clawsweeper[bot]", type: "Bot" },
          body: synced.comment,
        },
        {
          id: 9322,
          created_at: "2026-01-02T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
          author_association: "MEMBER",
          user: { login: "maintainer", type: "User" },
          body: "I am reviewing this.",
        },
      ];
    }
    withMockGh(root, promotionGhMock(options), () => {
      runApplyDecisionsForTest({
        targetRepo: "openclaw/openclaw",
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: [
          "--dry-run",
          "--apply-kind",
          "pull_request",
          "--apply-close-reasons",
          "obsolete_fix_pr",
          "--item-number",
          "321",
        ],
      });
    });
    return {
      entries: JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
        action: string;
        reason: string;
      }>,
      comment: synced.comment,
      closed: existsSync(join(closedDir, "321.md")),
    };
  } finally {
    if (previous === undefined) delete process.env.CLAWSWEEPER_OBSOLETE_FIX_PR_CLOSE_ENABLED;
    else process.env.CLAWSWEEPER_OBSOLETE_FIX_PR_CLOSE_ENABLED = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test("obsolete-fix PR apply is default-off", () => {
  const result = runObsoleteFixApply({ enabled: false });
  assert.equal(result.entries[0]?.action, "kept_open");
  assert.match(result.entries[0]?.reason ?? "", /policy is disabled/);
});

test("obsolete-fix PR apply closes a small fully rewritten patch", () => {
  const result = runObsoleteFixApply();
  assert.equal(result.entries[0]?.action, "closed");
  assert.match(result.entries[0]?.reason ?? "", /fix made obsolete/);
  assert.match(result.comment, /src\/runtime\.ts/);
  assert.match(result.comment, /Current main rewrote src\/runtime\.ts/);
  assert.match(result.comment, /fresh PR against the current code/);
});

test("obsolete-fix PR apply closes a deleted workflow fix", () => {
  const workflow = ".github/workflows/legacy-ci.yml";
  const result = runObsoleteFixApply({
    changedFiles: 1,
    sourceFiles: [workflow],
    deletedMainPaths: [workflow],
    postHeadPathChanges: { [workflow]: null },
  });
  assert.equal(result.entries[0]?.action, "closed");
});

test("obsolete-fix PR apply blocks a renamed workflow destination missing on main", () => {
  const workflow = ".github/workflows/renamed-ci.yml";
  const result = runObsoleteFixApply({
    changedFiles: 1,
    sourceFiles: [{ filename: workflow, status: "renamed" }],
    deletedMainPaths: [workflow],
    postHeadPathChanges: { [workflow]: null },
  });
  assert.equal(result.entries[0]?.action, "kept_open");
  assert.match(result.entries[0]?.reason ?? "", /touched path unchanged on main/);
});

test("obsolete-fix PR apply blocks a workflow file the PR itself adds", () => {
  const workflow = ".github/workflows/new-ci.yml";
  const result = runObsoleteFixApply({
    changedFiles: 1,
    sourceFiles: [{ filename: workflow, status: "added" }],
    deletedMainPaths: [workflow],
    postHeadPathChanges: { [workflow]: null },
  });
  assert.equal(result.entries[0]?.action, "kept_open");
  assert.match(result.entries[0]?.reason ?? "", /touched path unchanged on main/);
});

test("obsolete-fix PR apply blocks a path unchanged on main", () => {
  const result = runObsoleteFixApply({
    changedFiles: 1,
    sourceFiles: ["src/runtime.ts"],
    postHeadPathChanges: { "src/runtime.ts": null },
  });
  assert.equal(result.entries[0]?.action, "kept_open");
  assert.match(result.entries[0]?.reason ?? "", /touched path unchanged on main/);
});

test("obsolete-fix PR apply blocks more than five changed files", () => {
  const result = runObsoleteFixApply({ changedFiles: 6 });
  assert.equal(result.entries[0]?.action, "kept_open");
  assert.match(result.entries[0]?.reason ?? "", /between 1 and 5 live changed files/);
});

for (const [name, options, message] of [
  ["missing head SHA", { headSha: "" }, /head changed|live PR head SHA/],
  ["missing head committer date", { headCommittedAt: "" }, /dated current-head committer/],
  ["live age", { itemCreatedAt: "2026-07-01T00:00:00Z" }, /older than 90 days/],
  ["recent check activity", { checkActivityAt: new Date().toISOString() }, /30 days without/],
  ["assignee", { assignees: [{ login: "maintainer" }] }, /assigned PR/],
  ["requested reviewer", { requestedReviewers: [{ login: "reviewer" }] }, /requested reviewers/],
  ["maintainer comment", { maintainerComment: true }, /maintainer issue comment/],
] as const) {
  test(`obsolete-fix PR apply blocks ${name}`, () => {
    const result = runObsoleteFixApply(options);
    assert.equal(result.entries[0]?.action, "kept_open");
    assert.match(result.entries[0]?.reason ?? "", message);
    assert.equal(result.closed, false);
  });
}

test("obsolete-fix PR apply fails closed on path lookup errors", () => {
  const result = runObsoleteFixApply({ pathLookupError: "gh: Forbidden (HTTP 403)" });
  assert.equal(result.entries[0]?.action, "kept_open");
  assert.match(result.entries[0]?.reason ?? "", /obsolete-fix PR live check failed/);
});
