import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  reportWithSyncedReviewComment,
  runApplyDecisionsForTest,
  tmpPrefix,
  withMockGh,
  workPlanCandidateReport,
} from "./helpers.ts";

function stalledUnprovenCloseReport(overrides = {}) {
  return `${workPlanCandidateReport({
    repository: "openclaw/openclaw",
    type: "pull_request",
    decision: "close",
    action_taken: "proposed_close",
    close_reason: "stalled_unproven_pr",
    confidence: "high",
    work_candidate: "none",
    work_status: "none",
    item_snapshot_hash: "reviewed-snapshot",
    item_created_at: "2026-05-01T00:00:00Z",
    item_updated_at: "2026-05-01T00:00:00Z",
    author_association: "CONTRIBUTOR",
    item_category: "bug",
    ...overrides,
  })}

## Evidence

- **proof status:** The review comment asked for real behavior proof and the PR still has none

## Real Behavior Proof

Status: missing
Evidence kind: not_applicable
Needs contributor action: true
Summary: The review asked for real behavior proof and none was supplied.

## PR Rating

Overall tier: F
Proof tier: F
Patch tier: D
Summary: The patch is low quality and carries no real behavior proof.
Next rank-up steps:
- Provide a live run, logs, or a reproducible validation transcript.

## Close Comment

ClawSweeper proposes closing this PR because the requested real-behavior proof never arrived.
`;
}

function abandonedCloseReport(overrides = {}) {
  return `${workPlanCandidateReport({
    repository: "openclaw/openclaw",
    type: "pull_request",
    decision: "close",
    action_taken: "proposed_close",
    close_reason: "abandoned_pr",
    confidence: "high",
    work_candidate: "none",
    work_status: "none",
    item_snapshot_hash: "reviewed-snapshot",
    item_created_at: "2026-05-01T00:00:00Z",
    item_updated_at: "2026-05-01T00:00:00Z",
    author_association: "CONTRIBUTOR",
    item_category: "bug",
    ...overrides,
  })}

## Evidence

- **inactivity:** The branch has no new commits and checks are failing on the live head

## Real Behavior Proof

Status: missing
Evidence kind: not_applicable
Needs contributor action: true
Summary: The branch stalled before proof or fixes arrived.

## PR Rating

Overall tier: D
Proof tier: F
Patch tier: D
Summary: The patch is stalled with failing checks and no author activity.
Next rank-up steps:
- Rebase the branch and get checks green.

## Close Comment

ClawSweeper proposes closing this PR as abandoned after a long inactivity window.
`;
}

function stalledPrApplyGhMock(
  reviewComment: string,
  options: {
    draft?: boolean;
    headCommittedAt?: string;
    combinedStatusState?: string;
    checkRunConclusion?: string | null;
    maintainerComment?: boolean;
    proofRequestedAt?: string;
  } = {},
): string {
  const draft = options.draft === true;
  const headCommittedAt = options.headCommittedAt ?? "2026-05-01T00:00:00Z";
  const proofRequestedAt = options.proofRequestedAt ?? "2026-05-10T00:00:00Z";
  const combinedStatusState = options.combinedStatusState ?? "failure";
  const checkRunConclusion =
    options.checkRunConclusion === undefined ? "failure" : options.checkRunConclusion;
  const maintainerComment = options.maintainerComment
    ? `,{
      id: 9901,
      html_url: "https://github.com/openclaw/openclaw/pull/321#issuecomment-9901",
      created_at: "2026-05-11T00:00:00Z",
      updated_at: "2026-05-11T00:00:00Z",
      author_association: "MEMBER",
      user: { login: "maintainer" },
      body: "Taking a look at this branch."
    }`
    : "";
  return `
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const path = args[1] || "";
if (args[0] === "api" && args[1] === "-i" && /\\/issues\\/321\\/timeline(?:\\?|$)/.test(args[2] || "")) {
  console.log("HTTP/2 200\\n\\n[]");
} else if (args[0] === "api" && /\\/issues\\/321\\/comments(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[{
    id: 9321,
    html_url: "https://github.com/openclaw/openclaw/pull/321#issuecomment-9321",
    created_at: "2026-05-10T00:00:00Z",
    updated_at: "2026-05-10T00:00:00Z",
    author_association: "NONE",
    user: { login: "clawsweeper[bot]" },
    body: ${JSON.stringify(reviewComment)}
  }${maintainerComment}]]));
} else if (args[0] === "api" && /\\/issues\\/321\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[{
    event: "labeled",
    label: { name: "triage: needs-real-behavior-proof" },
    created_at: ${JSON.stringify(proofRequestedAt)}
  }]]));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "External stalled PR",
    html_url: "https://github.com/openclaw/openclaw/pull/321",
    body: "Fixes a small bug.",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    assignees: [],
    comments: ${options.maintainerComment ? 2 : 1},
    pull_request: { url: "https://api.github.com/repos/openclaw/openclaw/pulls/321" }
  }));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "api" && /\\/pulls\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "External stalled PR",
    html_url: "https://github.com/openclaw/openclaw/pull/321",
    state: "open",
    draft: ${draft},
    changed_files: 1,
    commits: 1,
    review_comments: 0,
    requested_reviewers: [],
    requested_teams: [],
    body: "Fixes a small bug.",
    head: { sha: "head-sha", ref: "branch", repo: { full_name: "fork/openclaw" } },
    base: { sha: "base-sha", ref: "main", repo: { full_name: "openclaw/openclaw" } },
    user: { login: "reporter" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/321\\/(files|commits|comments|reviews)(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/commits\\/head-sha\\/status(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify({ state: ${JSON.stringify(combinedStatusState)}, statuses: [] }));
} else if (args[0] === "api" && /\\/commits\\/head-sha\\/check-runs(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify({
    total_count: ${checkRunConclusion === null ? 0 : 1},
    check_runs: ${checkRunConclusion === null ? "[]" : `[{ conclusion: ${JSON.stringify(checkRunConclusion)} }]`}
  }));
} else if (args[0] === "api" && /\\/commits\\/head-sha(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify({
    sha: "head-sha",
    commit: { committer: { date: ${JSON.stringify(headCommittedAt)} } }
  }));
} else if (args[0] === "label" || args[0] === "issue") {
  console.error("unexpected GitHub write", JSON.stringify(args));
  process.exit(1);
} else if (args[0] === "api" && args.includes("--method")) {
  console.error("unexpected GitHub write", JSON.stringify(args));
  process.exit(1);
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
}

interface ApplyReportEntry {
  number: number;
  action: string;
  reason: string;
}

function runStalledPrApply(options: {
  report: string;
  closeReason: string;
  ghOptions?: Parameters<typeof stalledPrApplyGhMock>[1];
  dryRun?: boolean;
}): { entries: ApplyReportEntry[]; itemMarkdown: string; closedExists: boolean } {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const itemPath = join(itemsDir, "321.md");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const synced = reportWithSyncedReviewComment(options.report, 321, options.closeReason);
    writeFileSync(itemPath, synced.report, "utf8");

    withMockGh(root, stalledPrApplyGhMock(synced.comment, options.ghOptions), () => {
      runApplyDecisionsForTest({
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: [
          "--target-repo",
          "openclaw/openclaw",
          "--apply-kind",
          "pull_request",
          "--item-number",
          "321",
          "--processed-limit",
          "1",
          "--skip-dashboard",
          ...(options.dryRun === false ? [] : ["--dry-run"]),
        ],
      });
    });

    return {
      entries: JSON.parse(readFileSync(reportPath, "utf8")) as ApplyReportEntry[],
      itemMarkdown: existsSync(itemPath) ? readFileSync(itemPath, "utf8") : "",
      closedExists: existsSync(join(closedDir, "321.md")),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("apply dry-run closes an idle unproven low-rated PR", () => {
  const result = runStalledPrApply({
    report: stalledUnprovenCloseReport(),
    closeReason: "stalled_unproven_pr",
  });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0]?.action, "closed");
  assert.match(
    result.entries[0]?.reason ?? "",
    /would close as stalled PR without requested real-behavior proof/,
  );
});

test("stalled-unproven apply keeps a draft PR open for the abandoned policy", () => {
  const result = runStalledPrApply({
    report: stalledUnprovenCloseReport(),
    closeReason: "stalled_unproven_pr",
    ghOptions: { draft: true },
  });
  assert.deepEqual(result.entries, [
    {
      number: 321,
      action: "kept_open",
      reason: "draft PR is handled by the abandoned-PR policy, not stalled-unproven",
    },
  ]);
  assert.equal(result.closedExists, false);
});

test("stalled-unproven apply keeps a PR open when head commits are recent", () => {
  const result = runStalledPrApply({
    report: stalledUnprovenCloseReport(),
    closeReason: "stalled_unproven_pr",
    ghOptions: { headCommittedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString() },
  });
  assert.deepEqual(result.entries, [
    {
      number: 321,
      action: "kept_open",
      reason: "stalled_unproven_pr requires 14 days without new head commit or check activity",
    },
  ]);
  assert.equal(result.closedExists, false);
});

test("stalled-unproven apply keeps a PR open when the proof request is too fresh", () => {
  const result = runStalledPrApply({
    report: stalledUnprovenCloseReport(),
    closeReason: "stalled_unproven_pr",
    ghOptions: {
      proofRequestedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    },
  });
  assert.deepEqual(result.entries, [
    {
      number: 321,
      action: "kept_open",
      reason: "stalled_unproven_pr requires the proof request to be visible for 14 days",
    },
  ]);
  assert.equal(result.closedExists, false);
});

test("stalled-unproven apply keeps a PR open when a maintainer commented", () => {
  const result = runStalledPrApply({
    report: stalledUnprovenCloseReport(),
    closeReason: "stalled_unproven_pr",
    ghOptions: { maintainerComment: true },
  });
  assert.deepEqual(result.entries, [
    {
      number: 321,
      action: "kept_open",
      reason: "maintainer issue comment blocks inactivity auto-close",
    },
  ]);
  assert.equal(result.closedExists, false);
});

test("apply dry-run closes an abandoned PR with failing checks", () => {
  const result = runStalledPrApply({
    report: abandonedCloseReport(),
    closeReason: "abandoned_pr",
  });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0]?.action, "closed");
  assert.match(result.entries[0]?.reason ?? "", /would close as abandoned inactive PR/);
});

test("abandoned apply keeps a PR open when head commits are recent", () => {
  const result = runStalledPrApply({
    report: abandonedCloseReport(),
    closeReason: "abandoned_pr",
    ghOptions: { headCommittedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString() },
  });
  assert.deepEqual(result.entries, [
    {
      number: 321,
      action: "kept_open",
      reason: "abandoned_pr requires 30 days without new head commit or check activity",
    },
  ]);
  assert.equal(result.closedExists, false);
});

test("abandoned apply keeps a live healthy PR open", () => {
  const result = runStalledPrApply({
    report: abandonedCloseReport(),
    closeReason: "abandoned_pr",
    ghOptions: { combinedStatusState: "success", checkRunConclusion: "success" },
  });
  assert.deepEqual(result.entries, [
    {
      number: 321,
      action: "kept_open",
      reason:
        "live PR is not draft, waiting-on-author, or failing checks; abandonment is not confirmed",
    },
  ]);
  assert.equal(result.closedExists, false);
});
