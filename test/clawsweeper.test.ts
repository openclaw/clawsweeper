import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  applyDecisionPriority,
  auditFromSnapshot,
  auditHasStrictFailures,
  auditHealthSection,
  closingPullRequestReferenceTarget,
  codexEnv,
  codexLoginConfig,
  codexLoginMethod,
  dashboardClosedAt,
  formatRecentClosedRows,
  ghRetryKind,
  ghRetryWaitMs,
  isGitHubNotFoundError,
  isGitHubRequiresAuthenticationError,
  isLockedConversationCommentError,
  itemNumbersArg,
  lockedConversationApplyReason,
  parseDecision,
  relatedGitHubIssueSearchQueryForTest,
  relatedTitleSearchTerms,
  renderReviewStartStatusComment,
  reviewArtifactDestination,
  reviewCodexForcedLoginMethodForTest,
  runtimeBudgetExceeded,
  safeOutputTail,
  shardItemNumbers,
  shouldSyncReviewComment,
  shouldRetryGh,
} from "../dist/clawsweeper.js";
import { parseArgs as parseClawsweeperArgs } from "../dist/clawsweeper-args.js";
import { AUTOMATION_LIMITS } from "../dist/limits.js";
import {
  auditRecord,
  closeDecision,
  implementedCloseReport,
  item,
  lowSignalCloseReport,
  promotionGhMock,
  reportFrontMatter,
  reportWithSyncedReviewComment,
  runApplyDecisionsForTest,
  stalePullRequestReport,
  tmpPrefix,
  withMockCodexProof,
  withMockGh,
  workPlanCandidateReport,
} from "./helpers.ts";

function unconfirmedProductDirectionCloseReport(overrides = {}) {
  return `${workPlanCandidateReport({
    repository: "openclaw/openclaw",
    type: "pull_request",
    decision: "close",
    action_taken: "proposed_close",
    close_reason: "unconfirmed_product_direction",
    confidence: "high",
    work_candidate: "none",
    work_status: "none",
    item_snapshot_hash: "reviewed-snapshot",
    item_created_at: "2026-05-01T00:00:00Z",
    item_updated_at: "2026-05-01T00:00:00Z",
    author_association: "CONTRIBUTOR",
    item_category: "feature",
    requires_new_feature: "true",
    requires_product_decision: "true",
    ...overrides,
  })}

## Review Findings

Overall correctness: patch is correct
Overall confidence: 0.95

## Security Review

Status: cleared
Summary: No security-sensitive behavior is involved.

## Real Behavior Proof

Status: sufficient
Evidence kind: terminal
Needs contributor action: false
Summary: A real terminal transcript demonstrates the added behavior.

## PR Rating

Overall tier: B
Proof tier: A
Patch tier: B
Summary: The patch is technically ready but product direction is unconfirmed.
Next rank-up steps:
- Obtain maintainer product sponsorship.

## Close Comment

ClawSweeper proposes closing this PR because product direction is unconfirmed.
`;
}

function unconfirmedProductDirectionApplyGhMock(
  reviewComment: string,
  options: { maintainerComment?: boolean } = {},
): string {
  const maintainerComment = options.maintainerComment
    ? `,{
      id: 9901,
      html_url: "https://github.com/openclaw/openclaw/pull/321#issuecomment-9901",
      created_at: "2026-05-11T00:00:00Z",
      updated_at: "2026-05-11T00:00:00Z",
      author_association: "MEMBER",
      user: { login: "maintainer" },
      body: "Please keep this direction open for product review."
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
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "External feature PR",
    html_url: "https://github.com/openclaw/openclaw/pull/321",
    body: "Adds a new optional feature.",
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
    title: "External feature PR",
    html_url: "https://github.com/openclaw/openclaw/pull/321",
    state: "open",
    changed_files: 1,
    commits: 1,
    review_comments: 0,
    requested_reviewers: [],
    requested_teams: [],
    body: "Adds a new optional feature.",
    head: { sha: "head-sha", ref: "branch", repo: { full_name: "fork/openclaw" } },
    base: { sha: "base-sha", ref: "main", repo: { full_name: "openclaw/openclaw" } },
    user: { login: "reporter" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/321\\/(files|commits|comments|reviews)(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
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

test("apply-decisions does not promote PRs superseded by PRs already proposed for close", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const synced = reportWithSyncedReviewComment(
      stalePullRequestReport({
        number: 337,
        title: "Old activity PR",
        pr_rating_overall: "D",
        pr_rating_proof: "D",
        work_cluster_refs: JSON.stringify([
          "Superseded by https://github.com/openclaw/openclaw/pull/400",
        ]),
      }),
      337,
      "none",
    );
    writeFileSync(join(itemsDir, "337.md"), synced.report, "utf8");
    writeFileSync(
      join(itemsDir, "400.md"),
      lowSignalCloseReport({
        number: 400,
        title: "Canonical PR proposed for close",
      }),
      "utf8",
    );

    withMockGh(
      root,
      promotionGhMock({
        number: 337,
        title: "Old activity PR",
        comment: synced.comment,
        linkedPulls: {
          400: {
            number: 400,
            title: "Canonical PR proposed for close",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "open",
            merged_at: null,
            mergeable_state: "clean",
            labels: [],
          },
        },
      }),
      () => {
        runApplyDecisionsForTest({
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
          extraArgs: [
            "--target-repo",
            "openclaw/openclaw",
            "--dry-run",
            "--apply-kind",
            "all",
            "--item-numbers",
            "337",
            "--processed-limit",
            "3",
          ],
        });
      },
    );

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{ action: string }>;
    assert.equal(
      report.some((entry) => entry.action === "closed"),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions does not promote PRs superseded by skipped close proposal PRs", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const sourceReport = stalePullRequestReport({
      number: 339,
      title: "Old activity PR",
      labels: JSON.stringify([]),
      pr_rating_overall: "D",
      pr_rating_proof: "D",
      pr_rating_patch: "D",
      work_cluster_refs: JSON.stringify([
        "Superseded by https://github.com/openclaw/openclaw/pull/400",
      ]),
    })
      .replace("Status: missing", "Status: sufficient")
      .replace(
        "Overall tier: F\nProof tier: F\nPatch tier: F",
        "Overall tier: D\nProof tier: D\nPatch tier: D",
      );
    const synced = reportWithSyncedReviewComment(sourceReport, 339, "none");
    writeFileSync(join(itemsDir, "339.md"), synced.report, "utf8");
    writeFileSync(
      join(itemsDir, "400.md"),
      lowSignalCloseReport({
        number: 400,
        title: "Canonical PR blocked from close",
        action_taken: "skipped_changed_since_review",
      }),
      "utf8",
    );

    withMockGh(
      root,
      promotionGhMock({
        number: 339,
        title: "Old activity PR",
        comment: synced.comment,
        linkedPulls: {
          400: {
            number: 400,
            title: "Canonical PR blocked from close",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "open",
            merged_at: null,
            mergeable_state: "clean",
            labels: [],
          },
        },
      }),
      () => {
        runApplyDecisionsForTest({
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
          extraArgs: [
            "--target-repo",
            "openclaw/openclaw",
            "--dry-run",
            "--apply-kind",
            "all",
            "--item-numbers",
            "339",
            "--processed-limit",
            "3",
          ],
        });
      },
    );

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{ action: string }>;
    assert.equal(
      report.some((entry) => entry.action === "closed"),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions does not promote unrelated linked open PRs", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const synced = reportWithSyncedReviewComment(
      stalePullRequestReport({
        number: 333,
        title: "Related activity PR",
        pr_rating_overall: "D",
        pr_rating_proof: "D",
        work_cluster_refs: JSON.stringify(["https://github.com/openclaw/openclaw/pull/401"]),
      }),
      333,
      "none",
    );
    writeFileSync(join(itemsDir, "333.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 333,
        title: "Related activity PR",
        itemCreatedAt: "2026-05-20T00:00:00Z",
        comment: synced.comment,
        linkedPulls: {
          401: {
            number: 401,
            title: "Related activity PR",
            html_url: "https://github.com/openclaw/openclaw/pull/401",
            state: "open",
            merged_at: null,
          },
        },
      }),
      () => {
        runApplyDecisionsForTest({
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
          extraArgs: [
            "--target-repo",
            "openclaw/openclaw",
            "--dry-run",
            "--apply-kind",
            "all",
            "--processed-limit",
            "3",
          ],
        });
      },
    );

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{ action: string }>;
    assert.equal(
      report.some((entry) => entry.action === "closed"),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions does not promote unrelated linked merged PRs", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const synced = reportWithSyncedReviewComment(
      stalePullRequestReport({
        number: 334,
        title: "Related merged activity PR",
        pr_rating_overall: "D",
        pr_rating_proof: "D",
        work_cluster_refs: JSON.stringify(["https://github.com/openclaw/openclaw/pull/402"]),
      }),
      334,
      "none",
    );
    writeFileSync(join(itemsDir, "334.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 334,
        title: "Related merged activity PR",
        itemCreatedAt: "2026-05-20T00:00:00Z",
        comment: synced.comment,
        linkedPulls: {
          402: {
            number: 402,
            title: "Related merged PR",
            html_url: "https://github.com/openclaw/openclaw/pull/402",
            state: "closed",
            merged_at: "2026-05-21T00:00:00Z",
          },
        },
      }),
      () => {
        runApplyDecisionsForTest({
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
          extraArgs: [
            "--target-repo",
            "openclaw/openclaw",
            "--dry-run",
            "--apply-kind",
            "all",
            "--processed-limit",
            "3",
          ],
        });
      },
    );

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{ action: string }>;
    assert.equal(
      report.some((entry) => entry.action === "closed"),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions starts same-author pair closes from the PR side", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const issueSynced = reportWithSyncedReviewComment(
      implementedCloseReport({
        repository: "openclaw/openclaw",
        number: 320,
        type: "issue",
        title: "Paired issue",
        author: "reporter",
        action_taken: "skipped_same_author_pair",
      }),
      320,
      "implemented_on_main",
    );
    const pullSynced = reportWithSyncedReviewComment(
      implementedCloseReport({
        repository: "openclaw/openclaw",
        number: 321,
        type: "pull_request",
        title: "Paired PR",
        author: "reporter",
        action_taken: "skipped_same_author_pair",
      }),
      321,
      "implemented_on_main",
    );
    writeFileSync(join(itemsDir, "320.md"), issueSynced.report, "utf8");
    writeFileSync(join(itemsDir, "321.md"), pullSynced.report, "utf8");

    const ghMock = `
const comments = {
  320: ${JSON.stringify(issueSynced.comment)},
  321: ${JSON.stringify(pullSynced.comment)}
};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const path = args[1] || "";
const issueNumber = (path.match(/\\/issues\\/(\\d+)/) || [])[1];
if (args[0] === "api" && args[1] === "-i" && /\\/issues\\/(320|321)\\/timeline(?:\\?|$)/.test(args[2] || "")) {
  console.log("HTTP/2 200\\n\\n[]");
} else if (args[0] === "api" && /\\/issues\\/(320|321)\\/comments(?:\\?|$)/.test(path)) {
  const number = Number(issueNumber);
  console.log(JSON.stringify([[{
    id: 9000 + number,
    html_url: "https://github.com/openclaw/openclaw/issues/" + number + "#issuecomment-" + (9000 + number),
    created_at: "2026-05-01T01:00:00Z",
    updated_at: "2026-05-01T01:00:00Z",
    user: { login: "clawsweeper[bot]" },
    body: comments[number]
  }]]));
} else if (args[0] === "api" && /\\/issues\\/(320|321)\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/320$/.test(path)) {
  console.log(JSON.stringify({
    number: 320,
    title: "Paired issue",
    html_url: "https://github.com/openclaw/openclaw/issues/320",
    body: "See #321.",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    comments: 1,
    pull_request: null
  }));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Paired PR",
    html_url: "https://github.com/openclaw/openclaw/pull/321",
    body: "Fixes #320.",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    comments: 1,
    pull_request: { url: "https://api.github.com/repos/openclaw/openclaw/pulls/321" }
  }));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "api" && /\\/pulls\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Paired PR",
    html_url: "https://github.com/openclaw/openclaw/pull/321",
    state: "open",
    changed_files: 0,
    commits: 0,
    review_comments: 0,
    body: "Fixes #320.",
    head: { sha: "head-sha", ref: "branch", repo: { full_name: "fork/openclaw" } },
    base: { sha: "base-sha", ref: "main", repo: { full_name: "openclaw/openclaw" } },
    user: { login: "reporter" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/321\\/(files|commits|comments)(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "label" || args[0] === "issue") {
  console.log("");
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: [
          "--target-repo",
          "openclaw/openclaw",
          "--dry-run",
          "--apply-kind",
          "all",
          "--processed-limit",
          "4",
        ],
      });
    });

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
      number: number;
      action: string;
    }>;
    assert.deepEqual(
      report.filter((entry) => entry.action === "closed").map((entry) => entry.number),
      [321, 320],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions does not pair-close an issue when product-direction apply is disabled", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const issueSynced = reportWithSyncedReviewComment(
      implementedCloseReport({
        repository: "openclaw/openclaw",
        number: 320,
        type: "issue",
        title: "Paired issue",
        author: "reporter",
        action_taken: "skipped_same_author_pair",
      }),
      320,
      "implemented_on_main",
    );
    const pullSynced = reportWithSyncedReviewComment(
      unconfirmedProductDirectionCloseReport({
        number: 321,
        title: "Paired feature PR",
        author: "reporter",
        action_taken: "skipped_same_author_pair",
      }),
      321,
      "unconfirmed_product_direction",
    );
    writeFileSync(join(itemsDir, "320.md"), issueSynced.report, "utf8");
    writeFileSync(join(itemsDir, "321.md"), pullSynced.report, "utf8");

    const ghMock = `
const comments = {
  320: ${JSON.stringify(issueSynced.comment)},
  321: ${JSON.stringify(pullSynced.comment)}
};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const path = args[1] || "";
const issueNumber = (path.match(/\\/issues\\/(\\d+)/) || [])[1];
if (args[0] === "api" && args[1] === "-i" && /\\/issues\\/(320|321)\\/timeline(?:\\?|$)/.test(args[2] || "")) {
  console.log("HTTP/2 200\\n\\n[]");
} else if (args[0] === "api" && /\\/issues\\/(320|321)\\/comments(?:\\?|$)/.test(path)) {
  const number = Number(issueNumber);
  console.log(JSON.stringify([[{
    id: 9000 + number,
    html_url: "https://github.com/openclaw/openclaw/issues/" + number + "#issuecomment-" + (9000 + number),
    created_at: "2026-05-01T01:00:00Z",
    updated_at: "2026-05-01T01:00:00Z",
    user: { login: "clawsweeper[bot]" },
    body: comments[number]
  }]]));
} else if (args[0] === "api" && /\\/issues\\/(320|321)\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/320$/.test(path)) {
  console.log(JSON.stringify({
    number: 320,
    title: "Paired issue",
    html_url: "https://github.com/openclaw/openclaw/issues/320",
    body: "See #321.",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    comments: 1,
    pull_request: null
  }));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Paired feature PR",
    html_url: "https://github.com/openclaw/openclaw/pull/321",
    body: "Fixes #320.",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    comments: 1,
    pull_request: { url: "https://api.github.com/repos/openclaw/openclaw/pulls/321" }
  }));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "api" && /\\/pulls\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Paired feature PR",
    html_url: "https://github.com/openclaw/openclaw/pull/321",
    state: "open",
    changed_files: 1,
    commits: 1,
    review_comments: 0,
    body: "Fixes #320.",
    head: { sha: "head-sha", ref: "branch", repo: { full_name: "fork/openclaw" } },
    base: { sha: "base-sha", ref: "main", repo: { full_name: "openclaw/openclaw" } },
    user: { login: "reporter" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/321\\/(files|commits|comments)(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "label" || args[0] === "issue") {
  console.log("");
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    const originalPolicy = process.env.CLAWSWEEPER_UNCONFIRMED_PRODUCT_DIRECTION_CLOSE_ENABLED;
    delete process.env.CLAWSWEEPER_UNCONFIRMED_PRODUCT_DIRECTION_CLOSE_ENABLED;
    try {
      withMockGh(root, ghMock, () => {
        runApplyDecisionsForTest({
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
          extraArgs: [
            "--target-repo",
            "openclaw/openclaw",
            "--dry-run",
            "--apply-kind",
            "all",
            "--processed-limit",
            "4",
          ],
        });
      });
    } finally {
      if (originalPolicy === undefined) {
        delete process.env.CLAWSWEEPER_UNCONFIRMED_PRODUCT_DIRECTION_CLOSE_ENABLED;
      } else {
        process.env.CLAWSWEEPER_UNCONFIRMED_PRODUCT_DIRECTION_CLOSE_ENABLED = originalPolicy;
      }
    }

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
      number: number;
      action: string;
      reason: string;
    }>;
    assert.equal(
      report.some((entry) => entry.action === "closed"),
      false,
    );
    assert.deepEqual(
      report.map((entry) => [entry.number, entry.action]).sort(([left], [right]) => left - right),
      [
        [320, "skipped_same_author_pair"],
        [321, "kept_open"],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("default-off product-direction apply preserves the durable close proposal", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const itemPath = join(itemsDir, "321.md");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const synced = reportWithSyncedReviewComment(
      unconfirmedProductDirectionCloseReport({
        number: 321,
        title: "External feature PR",
        author: "reporter",
        reviewed_at: "2026-05-10T00:00:01Z",
      }),
      321,
      "unconfirmed_product_direction",
    );
    writeFileSync(
      itemPath,
      synced.report.replace(/^review_comment_sha256:.*$/m, "review_comment_sha256: stale"),
      "utf8",
    );

    const originalPolicy = process.env.CLAWSWEEPER_UNCONFIRMED_PRODUCT_DIRECTION_CLOSE_ENABLED;
    delete process.env.CLAWSWEEPER_UNCONFIRMED_PRODUCT_DIRECTION_CLOSE_ENABLED;
    try {
      withMockGh(root, unconfirmedProductDirectionApplyGhMock(synced.comment), () => {
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
          ],
        });
      });
    } finally {
      if (originalPolicy === undefined) {
        delete process.env.CLAWSWEEPER_UNCONFIRMED_PRODUCT_DIRECTION_CLOSE_ENABLED;
      } else {
        process.env.CLAWSWEEPER_UNCONFIRMED_PRODUCT_DIRECTION_CLOSE_ENABLED = originalPolicy;
      }
    }

    const result = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
      action: string;
      reason: string;
    }>;
    assert.deepEqual(result, [
      {
        number: 321,
        action: "kept_open",
        reason: "unconfirmed product-direction apply policy is disabled",
      },
    ]);
    assert.match(readFileSync(itemPath, "utf8"), /^action_taken: proposed_close$/m);
    assert.equal(existsSync(join(closedDir, "321.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("product-direction apply keeps a PR open when a maintainer comment calibrates direction", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const itemPath = join(itemsDir, "321.md");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const synced = reportWithSyncedReviewComment(
      unconfirmedProductDirectionCloseReport({
        number: 321,
        title: "External feature PR",
        author: "reporter",
        reviewed_at: "2026-05-10T00:00:01Z",
      }),
      321,
      "unconfirmed_product_direction",
    );
    writeFileSync(
      itemPath,
      synced.report.replace(/^review_comment_sha256:.*$/m, "review_comment_sha256: stale"),
      "utf8",
    );

    const originalPolicy = process.env.CLAWSWEEPER_UNCONFIRMED_PRODUCT_DIRECTION_CLOSE_ENABLED;
    process.env.CLAWSWEEPER_UNCONFIRMED_PRODUCT_DIRECTION_CLOSE_ENABLED = "true";
    try {
      withMockGh(
        root,
        unconfirmedProductDirectionApplyGhMock(synced.comment, { maintainerComment: true }),
        () => {
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
            ],
          });
        },
      );
    } finally {
      if (originalPolicy === undefined) {
        delete process.env.CLAWSWEEPER_UNCONFIRMED_PRODUCT_DIRECTION_CLOSE_ENABLED;
      } else {
        process.env.CLAWSWEEPER_UNCONFIRMED_PRODUCT_DIRECTION_CLOSE_ENABLED = originalPolicy;
      }
    }

    const result = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
      action: string;
      reason: string;
    }>;
    assert.deepEqual(result, [
      {
        number: 321,
        action: "kept_open",
        reason: "maintainer issue comment calibrates product direction",
      },
    ]);
    assert.match(readFileSync(itemPath, "utf8"), /^action_taken: kept_open$/m);
    assert.equal(existsSync(join(closedDir, "321.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions does not start same-author pair close when PR supersession is unsafe", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const issueSynced = reportWithSyncedReviewComment(
      implementedCloseReport({
        repository: "openclaw/openclaw",
        number: 320,
        type: "issue",
        title: "Paired issue",
        author: "reporter",
        action_taken: "skipped_same_author_pair",
      }),
      320,
      "implemented_on_main",
    );
    const pullSynced = reportWithSyncedReviewComment(
      lowSignalCloseReport({
        repository: "openclaw/openclaw",
        number: 321,
        title: "Paired PR",
        author: "reporter",
        close_reason: "duplicate_or_superseded",
        action_taken: "skipped_same_author_pair",
        work_cluster_refs: JSON.stringify([
          "Superseded by https://github.com/openclaw/openclaw/pull/400",
        ]),
      }),
      321,
      "duplicate_or_superseded",
    );
    writeFileSync(join(itemsDir, "320.md"), issueSynced.report, "utf8");
    writeFileSync(join(itemsDir, "321.md"), pullSynced.report, "utf8");

    const ghMock = `
const comments = {
  320: ${JSON.stringify(issueSynced.comment)},
  321: ${JSON.stringify(pullSynced.comment)}
};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const path = args[1] || "";
const issueNumber = (path.match(/\\/issues\\/(\\d+)/) || [])[1];
if (args[0] === "api" && args[1] === "-i" && /\\/issues\\/(320|321)\\/timeline(?:\\?|$)/.test(args[2] || "")) {
  console.log("HTTP/2 200\\n\\n[]");
} else if (args[0] === "api" && /\\/issues\\/(320|321)\\/comments(?:\\?|$)/.test(path)) {
  const number = Number(issueNumber);
  console.log(JSON.stringify([[{
    id: 9000 + number,
    html_url: "https://github.com/openclaw/openclaw/issues/" + number + "#issuecomment-" + (9000 + number),
    created_at: "2026-05-01T01:00:00Z",
    updated_at: "2026-05-01T01:00:00Z",
    user: { login: "clawsweeper[bot]" },
    body: comments[number]
  }]]));
} else if (args[0] === "api" && /\\/issues\\/(320|321)\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/320$/.test(path)) {
  console.log(JSON.stringify({
    number: 320,
    title: "Paired issue",
    html_url: "https://github.com/openclaw/openclaw/issues/320",
    body: "Fixed by #321.",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    comments: 1,
    pull_request: null
  }));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Paired PR",
    html_url: "https://github.com/openclaw/openclaw/pull/321",
    body: "Fixes #320.",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    comments: 1,
    pull_request: { url: "https://api.github.com/repos/openclaw/openclaw/pulls/321" }
  }));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "api" && /\\/pulls\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Paired PR",
    html_url: "https://github.com/openclaw/openclaw/pull/321",
    state: "open",
    changed_files: 1,
    commits: 1,
    review_comments: 0,
    body: "Fixes #320.",
    head: { sha: "head-sha", ref: "branch", repo: { full_name: "fork/openclaw" } },
    base: { sha: "base-sha", ref: "main", repo: { full_name: "openclaw/openclaw" } },
    user: { login: "reporter" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/400$/.test(path)) {
  console.log(JSON.stringify({
    number: 400,
    title: "Closed unmerged canonical PR",
    html_url: "https://github.com/openclaw/openclaw/pull/400",
    state: "closed",
    merged_at: null,
    labels: [{ name: "bug" }]
  }));
} else if (args[0] === "api" && /\\/pulls\\/321\\/(files|commits|comments)(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "label" || args[0] === "issue") {
  console.log("");
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: [
          "--target-repo",
          "openclaw/openclaw",
          "--dry-run",
          "--apply-kind",
          "all",
          "--processed-limit",
          "4",
        ],
      });
    });

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
      number: number;
      action: string;
    }>;
    assert.equal(
      report.some((entry) => entry.action === "closed"),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions records PR coverage proof retry before same-author pair skip", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const pullSynced = reportWithSyncedReviewComment(
      lowSignalCloseReport({
        repository: "openclaw/openclaw",
        number: 321,
        title: "Paired PR",
        author: "reporter",
        close_reason: "duplicate_or_superseded",
        action_taken: "proposed_close",
        work_cluster_refs: JSON.stringify([
          "Superseded by https://github.com/openclaw/openclaw/pull/400",
        ]),
      }),
      321,
      "duplicate_or_superseded",
    );
    writeFileSync(join(itemsDir, "321.md"), pullSynced.report, "utf8");

    const ghMock = `
const comments = {
  321: ${JSON.stringify(pullSynced.comment)}
};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const path = args[1] || "";
const issueNumber = (path.match(/\\/issues\\/(\\d+)/) || [])[1];
if (args[0] === "api" && args[1] === "-i" && /\\/issues\\/321\\/timeline(?:\\?|$)/.test(args[2] || "")) {
  console.log("HTTP/2 200\\n\\n[]");
} else if (args[0] === "api" && /\\/issues\\/321\\/comments(?:\\?|$)/.test(path)) {
  const number = Number(issueNumber);
  console.log(JSON.stringify([[{
    id: 9000 + number,
    html_url: "https://github.com/openclaw/openclaw/issues/" + number + "#issuecomment-" + (9000 + number),
    created_at: "2026-05-01T01:00:00Z",
    updated_at: "2026-05-01T01:00:00Z",
    user: { login: "clawsweeper[bot]" },
    body: comments[number]
  }]]));
} else if (args[0] === "api" && /\\/issues\\/321\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/320$/.test(path)) {
  console.log(JSON.stringify({
    number: 320,
    title: "Paired issue",
    html_url: "https://github.com/openclaw/openclaw/issues/320",
    body: "Tracked by #321.",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    comments: 0,
    pull_request: null
  }));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Paired PR",
    html_url: "https://github.com/openclaw/openclaw/pull/321",
    body: "Fixes #320.",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    comments: 1,
    pull_request: { url: "https://api.github.com/repos/openclaw/openclaw/pulls/321" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Paired PR",
    html_url: "https://github.com/openclaw/openclaw/pull/321",
    state: "open",
    changed_files: 1,
    commits: 1,
    review_comments: 0,
    body: "Fixes #320.",
    head: { sha: "head-sha", ref: "branch", repo: { full_name: "fork/openclaw" } },
    base: { sha: "base-sha", ref: "main", repo: { full_name: "openclaw/openclaw" } },
    user: { login: "reporter" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/400$/.test(path)) {
  console.log(JSON.stringify({
    number: 400,
    title: "Canonical provider cleanup",
    html_url: "https://github.com/openclaw/openclaw/pull/400",
    state: "open",
    merged_at: null,
    mergeable_state: "clean",
    draft: false,
    labels: [{ name: "proof: sufficient" }],
    body: "Carries the provider cleanup."
  }));
} else if (args[0] === "api" && /\\/issues\\/400$/.test(path)) {
  console.log(JSON.stringify({
    number: 400,
    title: "Canonical provider cleanup",
    html_url: "https://github.com/openclaw/openclaw/pull/400",
    body: "Carries the provider cleanup.",
    state: "open",
    labels: [{ name: "proof: sufficient" }],
    comments: 0,
    pull_request: { url: "https://api.github.com/repos/openclaw/openclaw/pulls/400" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/321\\/(files|commits|comments)(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "label" || args[0] === "issue") {
  console.log("");
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    withMockGh(root, ghMock, () => {
      withMockCodexProof(root, { type: "failure", message: "temporary model outage" }, () => {
        runApplyDecisionsForTest({
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
          extraArgs: [
            "--target-repo",
            "openclaw/openclaw",
            "--apply-kind",
            "all",
            "--processed-limit",
            "3",
          ],
        });
      });
    });

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
      number: number;
      action: string;
      reason: string;
    }>;
    assert.equal(
      report.find((entry) => entry.number === 321)?.action,
      "retry_pr_close_coverage_proof",
    );
    assert.equal(
      report.some((entry) => entry.action === "skipped_same_author_pair"),
      false,
    );
    assert.match(
      readFileSync(join(itemsDir, "321.md"), "utf8"),
      /^action_taken: retry_pr_close_coverage_proof$/m,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions keeps same-author PR blocked when counterpart drifted", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const issueSynced = reportWithSyncedReviewComment(
      implementedCloseReport({
        repository: "openclaw/openclaw",
        number: 320,
        type: "issue",
        title: "Paired issue",
        author: "reporter",
        action_taken: "skipped_same_author_pair",
      }),
      320,
      "implemented_on_main",
    );
    const pullSynced = reportWithSyncedReviewComment(
      implementedCloseReport({
        repository: "openclaw/openclaw",
        number: 321,
        type: "pull_request",
        title: "Paired PR",
        author: "reporter",
        action_taken: "skipped_same_author_pair",
      }),
      321,
      "implemented_on_main",
    );
    writeFileSync(join(itemsDir, "320.md"), issueSynced.report, "utf8");
    writeFileSync(join(itemsDir, "321.md"), pullSynced.report, "utf8");

    const ghMock = `
const comments = {
  320: ${JSON.stringify(issueSynced.comment)},
  321: ${JSON.stringify(pullSynced.comment)}
};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const path = args[1] || "";
const issueNumber = (path.match(/\\/issues\\/(\\d+)/) || [])[1];
if (args[0] === "api" && args[1] === "-i" && /\\/issues\\/(320|321)\\/timeline(?:\\?|$)/.test(args[2] || "")) {
  console.log("HTTP/2 200\\n\\n[]");
} else if (args[0] === "api" && /\\/issues\\/(320|321)\\/comments(?:\\?|$)/.test(path)) {
  const number = Number(issueNumber);
  console.log(JSON.stringify([[{
    id: 9000 + number,
    html_url: "https://github.com/openclaw/openclaw/issues/" + number + "#issuecomment-" + (9000 + number),
    created_at: "2026-05-01T01:00:00Z",
    updated_at: "2026-05-01T01:00:00Z",
    user: { login: "clawsweeper[bot]" },
    body: comments[number]
  }]]));
} else if (args[0] === "api" && /\\/issues\\/(320|321)\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/320$/.test(path)) {
  console.log(JSON.stringify({
    number: 320,
    title: "Paired issue",
    html_url: "https://github.com/openclaw/openclaw/issues/320",
    body: "See #321.",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-02T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    comments: 1,
    pull_request: null
  }));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Paired PR",
    html_url: "https://github.com/openclaw/openclaw/pull/321",
    body: "Fixes #320.",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    comments: 1,
    pull_request: { url: "https://api.github.com/repos/openclaw/openclaw/pulls/321" }
  }));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "api" && /\\/pulls\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Paired PR",
    html_url: "https://github.com/openclaw/openclaw/pull/321",
    state: "open",
    changed_files: 0,
    commits: 0,
    review_comments: 0,
    body: "Fixes #320.",
    head: { sha: "head-sha", ref: "branch", repo: { full_name: "fork/openclaw" } },
    base: { sha: "base-sha", ref: "main", repo: { full_name: "openclaw/openclaw" } },
    user: { login: "reporter" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/321\\/(files|commits|comments)(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "label" || args[0] === "issue") {
  console.log("");
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: [
          "--target-repo",
          "openclaw/openclaw",
          "--dry-run",
          "--apply-kind",
          "all",
          "--processed-limit",
          "1",
        ],
      });
    });

    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 321,
        action: "skipped_same_author_pair",
        reason: "open issue #320 (Paired issue) by the same author is paired with this PR",
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions keeps same-author PR blocked when counterpart comment needs sync", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const issueSynced = reportWithSyncedReviewComment(
      implementedCloseReport({
        repository: "openclaw/openclaw",
        number: 320,
        type: "issue",
        title: "Paired issue",
        author: "reporter",
        action_taken: "skipped_same_author_pair",
      }),
      320,
      "implemented_on_main",
    );
    const pullSynced = reportWithSyncedReviewComment(
      implementedCloseReport({
        repository: "openclaw/openclaw",
        number: 321,
        type: "pull_request",
        title: "Paired PR",
        author: "reporter",
        action_taken: "skipped_same_author_pair",
      }),
      321,
      "implemented_on_main",
    );
    writeFileSync(join(itemsDir, "320.md"), issueSynced.report, "utf8");
    writeFileSync(join(itemsDir, "321.md"), pullSynced.report, "utf8");

    const ghMock = `
const pullComment = ${JSON.stringify(pullSynced.comment)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const path = args[1] || "";
if (args[0] === "api" && args[1] === "-i" && /\\/issues\\/(320|321)\\/timeline(?:\\?|$)/.test(args[2] || "")) {
  console.log("HTTP/2 200\\n\\n[]");
} else if (args[0] === "api" && /\\/issues\\/320\\/comments(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/321\\/comments(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[{
    id: 9321,
    html_url: "https://github.com/openclaw/openclaw/issues/321#issuecomment-9321",
    created_at: "2026-05-01T01:00:00Z",
    updated_at: "2026-05-01T01:00:00Z",
    user: { login: "clawsweeper[bot]" },
    body: pullComment
  }]]));
} else if (args[0] === "api" && /\\/issues\\/(320|321)\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/320$/.test(path)) {
  console.log(JSON.stringify({
    number: 320,
    title: "Paired issue",
    html_url: "https://github.com/openclaw/openclaw/issues/320",
    body: "See #321.",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    comments: 0,
    pull_request: null
  }));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Paired PR",
    html_url: "https://github.com/openclaw/openclaw/pull/321",
    body: "Fixes #320.",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    comments: 1,
    pull_request: { url: "https://api.github.com/repos/openclaw/openclaw/pulls/321" }
  }));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "api" && /\\/pulls\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Paired PR",
    html_url: "https://github.com/openclaw/openclaw/pull/321",
    state: "open",
    changed_files: 0,
    commits: 0,
    review_comments: 0,
    body: "Fixes #320.",
    head: { sha: "head-sha", ref: "branch", repo: { full_name: "fork/openclaw" } },
    base: { sha: "base-sha", ref: "main", repo: { full_name: "openclaw/openclaw" } },
    user: { login: "reporter" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/321\\/(files|commits|comments)(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "label" || args[0] === "issue") {
  console.log("");
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: [
          "--target-repo",
          "openclaw/openclaw",
          "--dry-run",
          "--apply-kind",
          "all",
          "--processed-limit",
          "1",
        ],
      });
    });

    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 321,
        action: "skipped_same_author_pair",
        reason: "open issue #320 (Paired issue) by the same author is paired with this PR",
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions keeps same-author PR blocked when counterpart reason is disabled", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const issueSynced = reportWithSyncedReviewComment(
      implementedCloseReport({
        repository: "openclaw/openclaw",
        number: 320,
        type: "issue",
        title: "Paired issue",
        author: "reporter",
        action_taken: "skipped_same_author_pair",
      }),
      320,
      "implemented_on_main",
    );
    const pullSynced = reportWithSyncedReviewComment(
      implementedCloseReport({
        repository: "openclaw/openclaw",
        number: 321,
        type: "pull_request",
        title: "Paired duplicate PR",
        author: "reporter",
        action_taken: "skipped_same_author_pair",
        close_reason: "duplicate_or_superseded",
      }),
      321,
      "duplicate_or_superseded",
    );
    writeFileSync(join(itemsDir, "320.md"), issueSynced.report, "utf8");
    writeFileSync(join(itemsDir, "321.md"), pullSynced.report, "utf8");

    const ghMock = `
const comments = {
  320: ${JSON.stringify(issueSynced.comment)},
  321: ${JSON.stringify(pullSynced.comment)}
};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const path = args[1] || "";
const issueNumber = (path.match(/\\/issues\\/(\\d+)/) || [])[1];
if (args[0] === "api" && args[1] === "-i" && /\\/issues\\/321\\/timeline(?:\\?|$)/.test(args[2] || "")) {
  console.log("HTTP/2 200\\n\\n[]");
} else if (args[0] === "api" && /\\/issues\\/(320|321)\\/comments(?:\\?|$)/.test(path)) {
  const number = Number(issueNumber);
  console.log(JSON.stringify([[{
    id: 9000 + number,
    html_url: "https://github.com/openclaw/openclaw/issues/" + number + "#issuecomment-" + (9000 + number),
    created_at: "2026-05-01T01:00:00Z",
    updated_at: "2026-05-01T01:00:00Z",
    user: { login: "clawsweeper[bot]" },
    body: comments[number]
  }]]));
} else if (args[0] === "api" && /\\/issues\\/321\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/320$/.test(path)) {
  console.log(JSON.stringify({
    number: 320,
    title: "Paired issue",
    html_url: "https://github.com/openclaw/openclaw/issues/320",
    body: "See #321.",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    comments: 1,
    pull_request: null
  }));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Paired duplicate PR",
    html_url: "https://github.com/openclaw/openclaw/pull/321",
    body: "Fixes #320.",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    comments: 1,
    pull_request: { url: "https://api.github.com/repos/openclaw/openclaw/pulls/321" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Paired duplicate PR",
    html_url: "https://github.com/openclaw/openclaw/pull/321",
    state: "open",
    changed_files: 0,
    commits: 0,
    review_comments: 0,
    body: "Fixes #320.",
    head: { sha: "head-sha", ref: "branch", repo: { full_name: "fork/openclaw" } },
    base: { sha: "base-sha", ref: "main", repo: { full_name: "openclaw/openclaw" } },
    user: { login: "reporter" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/321\\/(files|commits|comments)(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "label" || args[0] === "issue") {
  console.log("");
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: [
          "--target-repo",
          "openclaw/openclaw",
          "--dry-run",
          "--apply-kind",
          "all",
          "--apply-close-reasons",
          "duplicate_or_superseded",
          "--processed-limit",
          "1",
        ],
      });
    });

    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 321,
        action: "skipped_same_author_pair",
        reason: "open issue #320 (Paired issue) by the same author is paired with this PR",
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions archives live-closed skipped records without reopening close gates", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const logPath = join(root, "gh.log");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const skippedReport = implementedCloseReport({
      action_taken: "skipped_open_closing_pr",
      close_reason: "duplicate_or_superseded",
    }).replace(/^local_checkout_access: verified\n/m, "");
    writeFileSync(join(itemsDir, "321.md"), skippedReport, "utf8");

    const ghMock = `
const { appendFileSync } = require("fs");
const logPath = ${JSON.stringify(logPath)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const path = args[1] || "";
if (args[0] === "api" && /\\/issues\\/321\\/comments(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Render work plans",
    html_url: "https://github.com/openclaw/clawsweeper/issues/321",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: "2026-05-02T00:00:00Z",
    state: "closed",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    comments: 0,
    pull_request: null
  }));
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({ itemsDir, closedDir, plansDir, reportPath });
    });

    assert.equal(existsSync(join(itemsDir, "321.md")), false);
    assert.ok(existsSync(join(closedDir, "321.md")));
    assert.match(
      readFileSync(join(closedDir, "321.md"), "utf8"),
      /^action_taken: skipped_already_closed$/m,
    );
    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 321,
        action: "skipped_already_closed",
        reason: "state is closed",
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions skips advisory labels for failed or stale kept-open reports", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const logPath = join(root, "gh.log");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });

    const failed = reportWithSyncedReviewComment(
      workPlanCandidateReport({
        number: 321,
        review_status: "failed",
        item_snapshot_hash: "reviewed-snapshot-321",
        item_updated_at: "2026-05-01T00:00:00Z",
        reproduction_status: "unclear",
        reproduction_confidence: "low",
        work_candidate: "none",
        work_status: "none",
        work_confidence: "low",
      }),
      321,
    );
    const stale = reportWithSyncedReviewComment(
      workPlanCandidateReport({
        number: 322,
        item_snapshot_hash: "reviewed-snapshot-322",
        item_updated_at: "2026-05-01T00:00:00Z",
        triage_priority: "P1",
        reproduction_status: "reproduced",
        reproduction_confidence: "high",
      }),
      322,
    );
    writeFileSync(join(itemsDir, "321.md"), failed.report, "utf8");
    writeFileSync(join(itemsDir, "322.md"), stale.report, "utf8");

    const ghMock = `
const { appendFileSync } = require("fs");
const logPath = ${JSON.stringify(logPath)};
const comments = ${JSON.stringify({ 321: failed.comment, 322: stale.comment })};
const updatedAt = { 321: "2026-05-01T00:00:00Z", 322: "2026-05-02T00:00:00Z" };
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const path = args[1] || "";
const commentMatch = path.match(/\\/issues\\/(\\d+)\\/comments(?:\\?|$)/);
const issueMatch = path.match(/\\/issues\\/(\\d+)$/);
if (args[0] === "api" && commentMatch) {
  const number = Number(commentMatch[1]);
  console.log(JSON.stringify([[{
    id: 9000 + number,
    html_url: "https://github.com/openclaw/clawsweeper/issues/" + number + "#issuecomment-" + (9000 + number),
    created_at: "2026-05-01T01:00:00Z",
    updated_at: "2026-05-01T01:00:00Z",
    user: { login: "clawsweeper[bot]" },
    body: comments[number]
  }]]));
} else if (args[0] === "api" && issueMatch) {
  const number = Number(issueMatch[1]);
  console.log(JSON.stringify({
    number,
    title: "Render work plans",
    html_url: "https://github.com/openclaw/clawsweeper/issues/" + number,
    created_at: "2026-05-01T00:00:00Z",
    updated_at: updatedAt[number],
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    pull_request: null
  }));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "label" || args[0] === "issue") {
  console.log("");
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({ itemsDir, closedDir, plansDir, reportPath });
    });

    const calls = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(
      calls.some((args) => args[0] === "issue" && args[1] === "edit"),
      false,
    );
    assert.equal(
      calls.some((args) => args[0] === "label" && args[1] === "create"),
      false,
    );
    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions counts unverified local-checkout reports against the processed limit", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const logPath = join(root, "gh.log");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });

    const unverified = workPlanCandidateReport({ number: 321 }).replace(
      /^local_checkout_access: verified\n/m,
      "",
    );
    const secondUnverified = workPlanCandidateReport({ number: 322 }).replace(
      /^local_checkout_access: verified\n/m,
      "",
    );
    writeFileSync(join(itemsDir, "321.md"), unverified, "utf8");
    writeFileSync(join(itemsDir, "322.md"), secondUnverified, "utf8");

    const ghMock = `
const { appendFileSync } = require("fs");
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");
console.error("unexpected gh call");
process.exit(1);
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({ itemsDir, closedDir, plansDir, reportPath });
    });

    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 321,
        action: "kept_open",
        reason: "review lacks verified local checkout access",
      },
    ]);
    assert.equal(existsSync(logPath), false);
    assert.match(readFileSync(join(itemsDir, "321.md"), "utf8"), /^apply_checked_at: /m);
    assert.doesNotMatch(readFileSync(join(itemsDir, "322.md"), "utf8"), /^apply_checked_at: /m);

    runApplyDecisionsForTest({ itemsDir, closedDir, plansDir, reportPath });

    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 322,
        action: "kept_open",
        reason: "review lacks verified local checkout access",
      },
    ]);
    assert.match(readFileSync(join(itemsDir, "322.md"), "utf8"), /^apply_checked_at: /m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions counts advisory label-only syncs against the processed limit", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const logPath = join(root, "gh.log");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });

    const first = reportWithSyncedReviewComment(
      workPlanCandidateReport({
        number: 321,
        reviewed_at: "2026-05-01T00:00:00Z",
        item_snapshot_hash: "reviewed-snapshot-321",
        item_updated_at: "2026-05-01T00:00:00Z",
        labels: JSON.stringify(["stale"]),
      }),
      321,
    );
    const second = reportWithSyncedReviewComment(
      workPlanCandidateReport({
        number: 322,
        reviewed_at: "2026-05-01T00:00:00Z",
        item_snapshot_hash: "reviewed-snapshot-322",
        item_updated_at: "2026-05-01T00:00:00Z",
      }),
      322,
    );
    writeFileSync(join(itemsDir, "321.md"), first.report, "utf8");
    writeFileSync(join(itemsDir, "322.md"), second.report, "utf8");

    const ghMock = `
const { appendFileSync } = require("fs");
const { readFileSync } = require("fs");
const logPath = ${JSON.stringify(logPath)};
const comments = ${JSON.stringify({ 321: first.comment, 322: second.comment })};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const path = args[1] || "";
const commentMatch = path.match(/\\/issues\\/(\\d+)\\/comments(?:\\?|$)/);
const issueMatch = path.match(/\\/issues\\/(\\d+)$/);
if (args[0] === "api" && /\\/issues\\/comments\\/\\d+$/.test(path)) {
  const inputPath = args[args.indexOf("--input") + 1];
  const body = JSON.parse(readFileSync(inputPath, "utf8")).body;
  appendFileSync(logPath, JSON.stringify(["comment-patch", body]) + "\\n");
  console.log(JSON.stringify({ id: 9000 + 321, html_url: "https://github.com/openclaw/clawsweeper/issues/321#issuecomment-9321", updated_at: "2026-05-01T01:02:00Z", body }));
} else if (args[0] === "api" && commentMatch) {
  const number = Number(commentMatch[1]);
  const body = comments[number];
  console.log(JSON.stringify([[{
    id: 9000 + number,
    html_url: "https://github.com/openclaw/clawsweeper/issues/" + number + "#issuecomment-" + (9000 + number),
    created_at: "2026-05-01T01:00:00Z",
    updated_at: "2026-05-01T01:00:00Z",
    user: { login: "clawsweeper[bot]" },
    body
  }]]));
} else if (args[0] === "api" && issueMatch) {
  const number = Number(issueMatch[1]);
  console.log(JSON.stringify({
    number,
    title: "Render work plans",
    html_url: "https://github.com/openclaw/clawsweeper/issues/" + number,
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: number === 321 ? ["stale"] : [],
    pull_request: null
  }));
} else if (args[0] === "api" && /\\/pulls\\/87691$/.test(path)) {
  console.log(JSON.stringify({
    number: 87691,
    title: "fix(auto-reply): preserve post-compaction failure context",
    html_url: "https://github.com/openclaw/clawsweeper/pull/87691",
    state: "open",
    merged: false,
    merged_at: null,
    head: { ref: "fix/67750-compaction-embedded-timeout", sha: "head-sha" },
    base: { ref: "main", sha: "base-sha" },
    user: { login: "contributor" }
  }));
} else if (args[0] === "issue" && args[1] === "view" && args[2] === "321") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [{ number: 87691 }] }));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "label" && args[1] === "create") {
  console.log("");
} else if (args[0] === "issue" && args[1] === "edit") {
  console.log("");
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({ itemsDir, closedDir, plansDir, reportPath });
    });

    const calls = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    const editCalls = calls.filter((args) => args[0] === "issue" && args[1] === "edit");
    assert.ok(editCalls.length > 0);
    assert.deepEqual([...new Set(editCalls.map((args) => args[2]))], ["321"]);
    assert.ok(
      calls.some((args) => args[0] === "label" && args[1] === "create" && args[2] === "no-stale"),
    );
    assert.ok(editCalls.some((args) => args.includes("--add-label") && args.includes("no-stale")));
    assert.ok(
      editCalls.some(
        (args) => args.includes("--add-label") && args.includes("clawsweeper:linked-pr-open"),
      ),
    );
    assert.ok(
      editCalls.some(
        (args) => args.includes("--add-label") && args.includes("clawsweeper:no-new-fix-pr"),
      ),
    );
    assert.ok(
      editCalls.some((args) => args.includes("--remove-label") && args.includes("stale")),
      JSON.stringify(editCalls),
    );
    assert.equal(
      calls.some((args) => args.some((arg) => arg.includes("/issues/322"))),
      false,
    );
    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 321,
        action: "review_comment_synced",
        reason: "updated durable Codex review comment",
      },
    ]);
    const patchedComment = calls.find((args) => args[0] === "comment-patch")?.[1] ?? "";
    assert.match(
      patchedComment,
      /- add `clawsweeper:linked-pr-open`: Current issue advisory state selects this label\./,
    );
    assert.match(
      patchedComment,
      /- add `clawsweeper:no-new-fix-pr`: Current issue advisory state selects this label\./,
    );
    assert.doesNotMatch(patchedComment, /remove `clawsweeper:linked-pr-open`/);
    assert.doesNotMatch(patchedComment, /remove `clawsweeper:no-new-fix-pr`/);
    assert.match(readFileSync(join(itemsDir, "321.md"), "utf8"), /^labels_synced_at: /m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions syncs labels when first review placeholder advanced issue updated_at", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const logPath = join(root, "gh.log");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });

    const report = workPlanCandidateReport({
      number: 321,
      reviewed_at: "2026-05-01T00:05:00Z",
      item_snapshot_hash: "reviewed-snapshot-321",
      item_updated_at: "2026-05-01T00:00:00Z",
      triage_priority: "P1",
      impact_labels: JSON.stringify(["impact:message-loss"]),
      reproduction_status: "source_reproducible",
      reproduction_confidence: "high",
    });
    writeFileSync(join(itemsDir, "321.md"), report, "utf8");
    const placeholder = renderReviewStartStatusComment({
      number: 321,
      kind: "issue",
      title: "Render work plans",
    });

    const ghMock = `
const { appendFileSync, readFileSync } = require("fs");
const logPath = ${JSON.stringify(logPath)};
const placeholder = ${JSON.stringify(placeholder)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const path = args.includes("-i") ? args[args.indexOf("-i") + 1] : args[1] || "";
const commentMatch = path.match(/\\/issues\\/(\\d+)\\/comments(?:\\?|$)/);
const issueMatch = path.match(/\\/issues\\/(\\d+)$/);
if (args[0] === "api" && /\\/issues\\/comments\\/\\d+$/.test(path)) {
  const inputPath = args[args.indexOf("--input") + 1];
  const body = JSON.parse(readFileSync(inputPath, "utf8")).body;
  appendFileSync(logPath, JSON.stringify(["comment-patch", body]) + "\\n");
  console.log(JSON.stringify({
    id: 9321,
    html_url: "https://github.com/openclaw/clawsweeper/issues/321#issuecomment-9321",
    created_at: "2026-05-01T00:01:00Z",
    updated_at: "2026-05-01T00:06:00Z",
    user: { login: "clawsweeper[bot]" },
    body
  }));
} else if (args[0] === "api" && commentMatch) {
  console.log(JSON.stringify([[{
    id: 9321,
    html_url: "https://github.com/openclaw/clawsweeper/issues/321#issuecomment-9321",
    created_at: "2026-05-01T00:01:00Z",
    updated_at: "2026-05-01T00:01:00Z",
    user: { login: "clawsweeper[bot]" },
    body: placeholder
  }]]));
} else if (args[0] === "api" && /\\/issues\\/321\\/timeline/.test(path)) {
  console.log(JSON.stringify([{
    id: 1,
    event: "commented",
    created_at: "2026-05-01T00:01:00Z",
    actor: { login: "clawsweeper[bot]" }
  }]));
} else if (args[0] === "api" && issueMatch) {
  console.log(JSON.stringify({
    number: 321,
    title: "Render work plans",
    html_url: "https://github.com/openclaw/clawsweeper/issues/321",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:01:01Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    comments: 1,
    pull_request: null
  }));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "label" && args[1] === "create") {
  console.log("");
} else if (args[0] === "issue" && args[1] === "edit") {
  console.log("");
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({ itemsDir, closedDir, plansDir, reportPath });
    });

    const calls = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    const editCalls = calls.filter((args) => args[0] === "issue" && args[1] === "edit");
    assert.ok(editCalls.some((args) => args.includes("--add-label") && args.includes("P1")));
    assert.ok(
      editCalls.some(
        (args) => args.includes("--add-label") && args.includes("impact:message-loss"),
      ),
    );
    assert.ok(
      editCalls.some(
        (args) => args.includes("--add-label") && args.includes("clawsweeper:source-repro"),
      ),
    );
    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 321,
        action: "review_comment_synced",
        reason: "updated durable Codex review comment",
      },
    ]);
    const updatedReport = readFileSync(join(itemsDir, "321.md"), "utf8");
    assert.match(updatedReport, /^labels: .*"P1"/m);
    assert.match(updatedReport, /^labels: .*"impact:message-loss"/m);
    assert.match(updatedReport, /^labels_synced_at: /m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions dry-run computes advisory labels without mutating GitHub labels", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const logPath = join(root, "gh.log");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });

    const synced = reportWithSyncedReviewComment(
      workPlanCandidateReport({
        number: 321,
        reviewed_at: "2026-05-01T00:00:00Z",
        item_snapshot_hash: "reviewed-snapshot-321",
        item_updated_at: "2026-05-01T00:00:00Z",
      }),
      321,
    );
    const itemPath = join(itemsDir, "321.md");
    writeFileSync(itemPath, synced.report, "utf8");

    const ghMock = `
const { appendFileSync } = require("fs");
const logPath = ${JSON.stringify(logPath)};
const comment = ${JSON.stringify(synced.comment)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const path = args[1] || "";
if (args[0] === "api" && /\\/issues\\/321\\/comments(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[{
    id: 9321,
    html_url: "https://github.com/openclaw/clawsweeper/issues/321#issuecomment-9321",
    created_at: "2026-05-01T01:00:00Z",
    updated_at: "2026-05-01T01:00:00Z",
    user: { login: "clawsweeper[bot]" },
    body: comment
  }]]));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Render work plans",
    html_url: "https://github.com/openclaw/clawsweeper/issues/321",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    pull_request: null
  }));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "label" || args[0] === "issue") {
  console.log("");
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: ["--dry-run"],
      });
    });

    const calls = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(
      calls.some((args) => args[0] === "issue" && args[1] === "edit"),
      false,
    );
    assert.equal(
      calls.some((args) => args[0] === "label" && args[1] === "create"),
      false,
    );
    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 321,
        action: "kept_open",
        reason: "dry-run: would sync advisory issue labels",
      },
    ]);
    assert.doesNotMatch(readFileSync(itemPath, "utf8"), /clawsweeper:queueable-fix/);
    assert.doesNotMatch(readFileSync(itemPath, "utf8"), /^labels_synced_at: /m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions skips cleanly when ClawSweeper label sync loses authentication", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const logPath = join(root, "gh.log");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });

    const synced = reportWithSyncedReviewComment(
      workPlanCandidateReport({
        number: 321,
        reviewed_at: "2026-05-01T00:00:00Z",
        item_snapshot_hash: "reviewed-snapshot-321",
        item_updated_at: "2026-05-01T00:00:00Z",
        impact_labels: JSON.stringify(["impact:message-loss"]),
      }),
      321,
    );
    const itemPath = join(itemsDir, "321.md");
    writeFileSync(itemPath, synced.report, "utf8");

    const ghMock = `
const { appendFileSync } = require("fs");
const logPath = ${JSON.stringify(logPath)};
const comment = ${JSON.stringify(synced.comment)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const path = args[1] || "";
if (args[0] === "api" && /\\/issues\\/321\\/comments(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[{
    id: 9321,
    html_url: "https://github.com/openclaw/clawsweeper/issues/321#issuecomment-9321",
    created_at: "2026-05-01T01:00:00Z",
    updated_at: "2026-05-01T01:00:00Z",
    user: { login: "clawsweeper[bot]" },
    body: comment
  }]]));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Render work plans",
    html_url: "https://github.com/openclaw/clawsweeper/issues/321",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    pull_request: null
  }));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "label" && args[1] === "create") {
  console.log("");
} else if (args[0] === "issue" && args[1] === "edit" && args.includes("impact:message-loss")) {
  console.error('error fetching labels: non-200 OK status code: 401 Unauthorized body: "{\\n  \\"message\\": \\"Requires authentication\\",\\n  \\"status\\": \\"401\\"\\n}"');
  process.exit(1);
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
      });
    });

    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 321,
        action: "kept_open",
        reason: "GitHub rejected ClawSweeper label sync with Requires authentication",
      },
    ]);
    const report = readFileSync(itemPath, "utf8");
    assert.match(report, /^apply_checked_at: /m);
    assert.doesNotMatch(report, /^labels_synced_at: /m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("item number args merge and sort workflow inputs", () => {
  assert.deepEqual(itemNumbersArg("42, 7, nope, 42", "5"), [5, 7, 42]);
  assert.deepEqual(itemNumbersArg("", undefined), []);
});

test("explicit item numbers shard targeted review runs", () => {
  assert.deepEqual(shardItemNumbers([5, 7, 42, 99], 2), [
    { shard: 0, itemNumbers: [5, 42] },
    { shard: 1, itemNumbers: [7, 99] },
  ]);
  assert.deepEqual(shardItemNumbers([5, 7], 50), [
    { shard: 0, itemNumbers: [5] },
    { shard: 1, itemNumbers: [7] },
  ]);
  assert.deepEqual(shardItemNumbers([], 50), [{ shard: 0, itemNumbers: [] }]);
});

test("planned review shards stay within the Codex worker cap", () => {
  const itemNumbers = Array.from({ length: 300 }, (_, index) => index + 1);
  const shards = shardItemNumbers(itemNumbers, 400);
  assert.equal(shards.length, AUTOMATION_LIMITS.review_shards.hard_cap);
  assert.equal(
    shards.reduce((total, shard) => total + shard.itemNumbers.length, 0),
    itemNumbers.length,
  );
});

test("apply mode prioritizes matching close proposals before comment sync", () => {
  const issueClose = reportFrontMatter({
    decision: "close",
    close_reason: "implemented_on_main",
    action_taken: "proposed_close",
  });
  const legacyMaintainerSkip = reportFrontMatter({
    decision: "close",
    close_reason: "implemented_on_main",
    action_taken: "skipped_maintainer_authored",
  });
  const legacyInvalidDecision = reportFrontMatter({
    decision: "close",
    close_reason: "implemented_on_main",
    action_taken: "skipped_invalid_decision",
  });
  const legacyKeptOpen = reportFrontMatter({
    decision: "close",
    close_reason: "implemented_on_main",
    action_taken: "kept_open",
  });
  const pairBlockedOpenClosingPr = reportFrontMatter({
    decision: "close",
    close_reason: "implemented_on_main",
    action_taken: "skipped_open_closing_pr",
  });
  const pairBlockedSameAuthor = reportFrontMatter({
    decision: "close",
    close_reason: "implemented_on_main",
    action_taken: "skipped_same_author_pair",
  });
  const pullRequestClose = reportFrontMatter({
    type: "pull_request",
    decision: "close",
    close_reason: "implemented_on_main",
    action_taken: "proposed_close",
  });
  const duplicateSkip = reportFrontMatter({
    decision: "close",
    close_reason: "duplicate_or_superseded",
    action_taken: "skipped_invalid_decision",
  });

  assert.equal(applyDecisionPriority(issueClose, "issue"), 0);
  assert.equal(applyDecisionPriority(legacyMaintainerSkip, "issue"), 0);
  assert.equal(applyDecisionPriority(legacyInvalidDecision, "issue"), 0);
  assert.equal(applyDecisionPriority(legacyKeptOpen, "issue"), 0);
  assert.equal(applyDecisionPriority(pairBlockedOpenClosingPr, "issue"), 1);
  assert.equal(applyDecisionPriority(pairBlockedSameAuthor, "issue"), 1);
  assert.equal(applyDecisionPriority(pullRequestClose, "issue"), 1);
  assert.equal(applyDecisionPriority(duplicateSkip, "issue"), 2);
  assert.equal(applyDecisionPriority(reportFrontMatter(), "issue"), 2);
});

test("comment-only sync creates or refreshes stale durable review comments", () => {
  const now = Date.parse("2026-04-26T12:00:00Z");
  const base = {
    syncCommentsOnly: true,
    isCloseProposal: false,
    commentSyncMinAgeDays: 7,
    reviewCommentSyncedAt: "2026-04-25T12:00:00Z",
    hasExistingReviewComment: true,
    needsReviewCommentBodySync: true,
    needsReviewCommentHashSync: true,
    needsReviewCommentReferenceSync: false,
    now,
  };

  assert.equal(shouldSyncReviewComment(base), false);
  assert.equal(
    shouldSyncReviewComment({
      ...base,
      hasExistingReviewComment: false,
    }),
    true,
  );
  assert.equal(
    shouldSyncReviewComment({
      ...base,
      needsReviewCommentBodySync: false,
      needsReviewCommentHashSync: false,
      needsReviewCommentReferenceSync: true,
    }),
    true,
  );
  assert.equal(
    shouldSyncReviewComment({
      ...base,
      reviewCommentSyncedAt: "2026-04-18T12:00:00Z",
    }),
    true,
  );
  assert.equal(
    shouldSyncReviewComment({
      ...base,
      syncCommentsOnly: false,
    }),
    true,
  );
  assert.equal(
    shouldSyncReviewComment({
      ...base,
      isCloseProposal: true,
    }),
    true,
  );
});

test("review artifacts are ignored once the live item is closed", () => {
  assert.equal(reviewArtifactDestination("kept_open", true), "items");
  assert.equal(reviewArtifactDestination("proposed_close", true), "items");
  assert.equal(reviewArtifactDestination("closed", true), "closed");
  assert.equal(reviewArtifactDestination("proposed_close", false), "skip_closed");
  assert.equal(reviewArtifactDestination("kept_open", false), "skip_closed");
});

test("runtime budget only trips after a positive elapsed limit", () => {
  assert.equal(runtimeBudgetExceeded(1000, 0, 100000), false);
  assert.equal(runtimeBudgetExceeded(1000, 5000, 5999), false);
  assert.equal(runtimeBudgetExceeded(1000, 5000, 6000), true);
});

test("spam comment intake coalesces duplicate comment deliveries", () => {
  const workflow = readFileSync(".github/workflows/spam-comment-intake.yml", "utf8");

  assert.match(workflow, /types: \[clawsweeper_spam_comment_intake\]/);
  assert.doesNotMatch(workflow, /types: \[github_activity\]/);
  assert.match(workflow, /group: >-/);
  assert.match(workflow, /spam-comment-intake-\$\{\{ github\.event\.client_payload\.target_repo/);
  assert.match(workflow, /github\.event\.client_payload\.activity\.issue\.number/);
  assert.match(workflow, /github\.event\.client_payload\.activity\.pull_request\.number/);
  assert.match(workflow, /github\.event\.client_payload\.comment_id/);
  assert.match(workflow, /github\.event\.client_payload\.review_comment_id/);
  assert.match(workflow, /github\.event\.client_payload\.activity\.comment\.id/);
  assert.match(workflow, /Check core API budget/);
  assert.match(workflow, /CLAWSWEEPER_MIN_CORE_REMAINING/);
  assert.match(workflow, /github\.run_id/);
  assert.match(workflow, /cancel-in-progress: true/);
});

test("spam scanner exact dispatches publish only per-comment audit records", () => {
  const workflow = readFileSync(".github/workflows/spam-scanner.yml", "utf8");

  assert.match(workflow, /format\('spam-scanner-\{0\}-issue-comment-\{1\}'/);
  assert.match(workflow, /format\('spam-scanner-\{0\}-review-comment-\{1\}'/);
  assert.match(workflow, /results\/spam-audit\/\$\{target_slug\}\/issue_comment-\$\{id\}\.json/);
  assert.match(
    workflow,
    /results\/spam-audit\/\$\{target_slug\}\/pull_request_review_comment-\$\{id\}\.json/,
  );
  assert.match(workflow, /--path results\/spam-scanner\.json/);
  assert.match(workflow, /cancel-in-progress: false/);
});

test("issue implementation workflow lets job intent choose dispatch capacity", () => {
  const workflow = readFileSync(".github/workflows/repair-issue-implementation-intake.yml", "utf8");
  const dispatchInputs = workflow.slice(
    workflow.indexOf("  workflow_dispatch:"),
    workflow.indexOf("\npermissions:"),
  );

  assert.equal(dispatchInputs.match(/^      [a-z_]+:/gm)?.length, 10);
  assert.doesNotMatch(workflow, /^\s+intake_runner:/m);
  assert.match(
    workflow,
    /runs-on: \$\{\{ github\.event\.client_payload\.intake_runner \|\| vars\.CLAWSWEEPER_ISSUE_IMPLEMENTATION_INTAKE_RUNNER \|\| 'ubuntu-latest' \}\}/,
  );
  assert.match(
    workflow,
    /RUNNER: \$\{\{ github\.event\.inputs\.runner \|\| github\.event\.client_payload\.runner \|\| vars\.CLAWSWEEPER_WORKER_RUNNER/,
  );
  assert.match(
    workflow,
    /EXECUTION_RUNNER: \$\{\{ github\.event\.inputs\.execution_runner \|\| github\.event\.client_payload\.execution_runner \|\| vars\.CLAWSWEEPER_EXECUTION_RUNNER/,
  );
  assert.match(workflow, /cap_args=\(\)/);
  assert.match(workflow, /--max-live-workers "\$MAX_LIVE_WORKERS"/);
  assert.match(workflow, /"\$\{cap_args\[@\]\}"/);
  assert.doesNotMatch(workflow, /worker-limit issue_implementation/);
  assert.match(workflow, /owner: \$\{\{ steps\.target\.outputs\.target_owner \}\}/);
  assert.match(workflow, /id: dispatch-token/);
  assert.match(workflow, /GH_TOKEN: \$\{\{ steps\.dispatch-token\.outputs\.token \}\}/);
  assert.match(workflow, /MODEL: internal/);
  assert.match(workflow, /echo "target_slug=\$target_slug"/);
  assert.match(workflow, /sed -E 's\/\[\^a-z0-9_\.-\]\+\/-\/g;/);
  assert.match(
    workflow,
    /sparse-checkout: \|\n\s+records\/\$\{\{ steps\.target\.outputs\.target_slug \}\}\n\s+jobs\n\s+results/,
  );
});

test("repair workers hydrate only durable jobs from generated state", () => {
  const workflow = readFileSync(".github/workflows/repair-cluster-worker.yml", "utf8");
  const requeue = readFileSync("src/repair/requeue-job.ts", "utf8");

  assert.match(workflow, /clawsweeper-repair-requeue-\{0\}-\{1\}.*clawsweeper-repair-\{0\}/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /requeue:\n\s+description:/);
  assert.match(requeue, /"requeue=true"/);
  assert.equal(
    workflow.match(/uses: \.\/\.github\/actions\/setup-state[\s\S]*?sparse-checkout: jobs/g)
      ?.length,
    2,
  );
  assert.match(workflow, /CLAWSWEEPER_STEERABLE_CODEX/);
  assert.match(workflow, /actions\/cache\/restore@v5/);
  assert.match(workflow, /actions\/cache\/save@v5/);
  assert.match(workflow, /repair:action-session -- register/);
  assert.match(workflow, /completion-reason gates_passed/);
  assert.match(workflow, /post_flight_report=.*post-flight-report\.json/);
  assert.match(workflow, /\.action == "finalize_fix_pr"/);
  assert.match(workflow, /\.status == "ready"/);
  assert.match(
    workflow,
    /id: requeue_dispatch[\s\S]*if: \$\{\{ always\(\) && steps\.repair_requeue\.outputs\.count != '' && steps\.repair_requeue\.outputs\.count != '0' \}\}/,
  );
  assert.match(
    workflow,
    /if: \$\{\{ always\(\) && failure\(\) && steps\.crabfleet_session\.outcome == 'success' && \(steps\.repair_requeue\.outputs\.count == '' \|\| steps\.repair_requeue\.outputs\.count == '0' \|\| steps\.requeue_dispatch\.outcome != 'success'\) \}\}/,
  );
  assert.equal(workflow.match(/id: crabfleet_session/g)?.length, 2);
  assert.equal(workflow.match(/steps\.crabfleet_session\.outcome == 'success'/g)?.length, 6);
  assert.doesNotMatch(workflow, /if: \$\{\{[^\n]*env\.CLAWSWEEPER_CRABFLEET_AGENT_TOKEN/);
});

test("reviewed viable issues dispatch generated PRs and backfill durable open reports", () => {
  const workflow = readFileSync(".github/workflows/sweep.yml", "utf8");
  const eventDispatchStart = workflow.indexOf("- name: Dispatch viable issue implementation");
  const eventDispatch = workflow.slice(
    eventDispatchStart,
    workflow.indexOf("\n  plan:", eventDispatchStart),
  );

  assert.ok(eventDispatchStart >= 0);
  assert.match(eventDispatch, /--candidate-kind viable/);
  assert.match(eventDispatch, /\/tmp\/viable-event-candidate\.tsv/);
  assert.match(eventDispatch, /repair-issue-implementation-intake\.yml/);
  assert.match(eventDispatch, /-f candidate_kind=viable/);
  assert.match(eventDispatch, /-f report_repo=openclaw\/clawsweeper-state/);
  assert.match(eventDispatch, /steps\.target\.outputs\.target_repo != 'openclaw\/openclaw'/);
  assert.match(eventDispatch, /steps\.target\.outputs\.target_repo != 'openclaw\/clawhub'/);
  assert.doesNotMatch(eventDispatch, /vision-fit-implementation-candidates/);
  assert.match(workflow, /- name: Backfill viable open issue implementation candidates/);
  assert.match(workflow, /--report-dir "records\/\$target_slug\/items"/);
  assert.equal(workflow.match(/--report-dir "records\/\$target_slug\/items"/g)?.length, 3);
  assert.doesNotMatch(workflow, /CLAWSWEEPER_AUTO_IMPLEMENT_BACKFILL/);
  assert.equal(workflow.match(/vars\.CLAWSWEEPER_AUTO_IMPLEMENT_ISSUES == '1'/g)?.length, 4);
});

test("sweep workflow executes only durable queue leases without runner-side admission", () => {
  const workflow = readFileSync(".github/workflows/sweep.yml", "utf8").replace(/\r\n/g, "\n");
  const legacyIntakeBlock = workflow.slice(
    workflow.indexOf("\n  legacy-event-queue-intake:"),
    workflow.indexOf("\n  event-review-apply:"),
  );
  const eventReviewBlock = workflow.slice(
    workflow.indexOf("\n  event-review-apply:"),
    workflow.indexOf("\n  plan:"),
  );
  const claimIndex = eventReviewBlock.indexOf("- name: Claim exact-review queue lease");
  const setupPnpmIndex = eventReviewBlock.indexOf("- uses: ./.github/actions/setup-pnpm");
  const inProgressStatusIndex = eventReviewBlock.indexOf(
    "- name: Mark re-review command in progress",
  );
  const setupCodexIndex = eventReviewBlock.indexOf("- uses: ./.github/actions/setup-codex");
  const exactReviewIndex = eventReviewBlock.indexOf("- name: Review exact event item");
  const exactReviewStep = eventReviewBlock.slice(
    exactReviewIndex,
    eventReviewBlock.indexOf("- name: Create state token", exactReviewIndex),
  );

  assert.match(
    eventReviewBlock,
    /group: clawsweeper-event-review-\$\{\{ github\.event\.client_payload\.target_repo/,
  );
  assert.match(eventReviewBlock, /github\.event\.client_payload\.queue_lease_id != ''/);
  assert.match(legacyIntakeBlock, /Queue legacy exact-review event/);
  assert.match(legacyIntakeBlock, /\/internal\/exact-review\/enqueue/);
  assert.match(legacyIntakeBlock, /x-clawsweeper-exact-review-signature/);
  assert.match(legacyIntakeBlock, /CLAWSWEEPER_WEBHOOK_SECRET/);
  assert.match(eventReviewBlock, /cancel-in-progress: false/);
  assert.ok(claimIndex >= 0);
  assert.ok(setupPnpmIndex > claimIndex);
  assert.ok(inProgressStatusIndex > setupPnpmIndex);
  assert.ok(setupCodexIndex > inProgressStatusIndex);
  assert.ok(exactReviewIndex > setupCodexIndex);
  assert.match(eventReviewBlock, /\/internal\/exact-review\/claim/);
  assert.match(eventReviewBlock, /\/internal\/exact-review\/complete/);
  assert.match(eventReviewBlock, /exact-review queue leased this run/);
  assert.doesNotMatch(eventReviewBlock, /repair:codex-capacity/);
  assert.doesNotMatch(eventReviewBlock, /capacity-requeue/);
  assert.doesNotMatch(eventReviewBlock, /Waiting for Codex capacity/);
  assert.doesNotMatch(eventReviewBlock, /CLAWSWEEPER_EXACT_REVIEW_CAPACITY_RETRIES/);
  assert.match(exactReviewStep, /--batch-size 1/);
  assert.match(exactReviewStep, /--shard-count 1/);
  assert.match(exactReviewStep, /media_preprocessing_reserve_seconds=480/);
  assert.match(
    exactReviewStep,
    /review_timeout_seconds=\$\(\(codex_timeout_seconds \+ media_preprocessing_reserve_seconds \+ 180\)\)/,
  );
  assert.match(exactReviewStep, /detected media allowance \$\{media_proof_timeout_seconds\}s/);
  assert.match(exactReviewStep, /--codex-timeout-ms "\$codex_timeout_ms"/);
  assert.doesNotMatch(exactReviewStep, /--codex-timeout-ms 600000/);
});

test("sweep workflow gives high-context Codex reviews twenty minutes by default", () => {
  const workflow = readFileSync(".github/workflows/sweep.yml", "utf8");

  assert.match(
    workflow,
    /codex_timeout_ms:\n\s+description: "Per-item Codex timeout in milliseconds"\n\s+required: false\n\s+default: "1200000"/,
  );
  assert.doesNotMatch(workflow, /codex_timeout_ms=(?:600000|900000)/);
});

test("Codex workflows install pinned CLI releases and keep the model secret", () => {
  const action = readFileSync(".github/actions/setup-codex/action.yml", "utf8");
  const workflows = [
    ".github/workflows/assist.yml",
    ".github/workflows/commit-review.yml",
    ".github/workflows/maintainer-activity-report.yml",
    ".github/workflows/repair-cluster-worker.yml",
    ".github/workflows/repair-commit-finding-intake.yml",
    ".github/workflows/sweep.yml",
  ].map((file) => readFileSync(file, "utf8"));

  assert.match(action, /codex-version:[\s\S]*default: "0\.139\.0"/);
  assert.match(action, /proxy-version:[\s\S]*default: "0\.139\.0"/);
  assert.match(action, /@openai\/codex@\$\{\{ inputs\['codex-version'\] \}\}/);
  assert.match(action, /@openai\/codex-responses-api-proxy@\$\{\{ inputs\['proxy-version'\] \}\}/);
  assert.doesNotMatch(action, /@latest/);
  assert.match(action, /env -u OPENAI_API_KEY[\s\S]*-u CLAWSWEEPER_INTERNAL_MODEL/);
  assert.equal(action.match(/--ignore-scripts/g)?.length, 2);
  for (const workflow of workflows) {
    assert.match(workflow, /CLAWSWEEPER_MODEL: internal/);
    assert.match(workflow, /CLAWSWEEPER_INTERNAL_MODEL: \$\{\{ secrets\.CLAWSWEEPER_MODEL \}\}/);
    assert.doesNotMatch(workflow, /CLAWSWEEPER_CODEX_CLI_VERSION/);
    for (const line of workflow
      .split("\n")
      .filter((candidate) => /(?:OPENAI_API_KEY|CLAWSWEEPER_INTERNAL_MODEL):/.test(candidate))) {
      assert.match(line, /^\s{10,}/);
    }
  }
});

test("background review fanout keeps per-review transient recovery", () => {
  const workflow = readFileSync(".github/workflows/sweep.yml", "utf8");
  const reviewStart = workflow.indexOf("\n  review:");
  const publishStart = workflow.indexOf("\n  publish:", reviewStart);
  const reviewJob = workflow.slice(reviewStart, publishStart);

  assert.doesNotMatch(workflow, /\n  codex-smoke:/);
  assert.match(reviewJob, /needs: plan/);
  assert.doesNotMatch(reviewJob, /smoke-test/);
  assert.match(workflow, /publish:[\s\S]*needs: \[plan, review\]/);
});

test("synchronous Codex review surfaces use the shared bounded runner", () => {
  for (const file of [
    "src/clawsweeper.ts",
    "src/commit-sweeper.ts",
    "src/pr-close-coverage-proof.ts",
  ]) {
    const source = readFileSync(file, "utf8");
    assert.match(source, /runCodexProcess/);
    assert.doesNotMatch(source, /spawnSync\(\s*"codex"/);
  }
  assert.match(
    readFileSync("src/clawsweeper.ts", "utf8"),
    /"--output-last-message",\s*outputPath,\s*"--json"/,
  );
});

test("failed Codex workers use bounded automatic retry paths", () => {
  const worker = readFileSync("src/repair/run-worker.ts", "utf8");
  const outputCapture = readFileSync("src/codex-output-capture.ts", "utf8");
  const executor = readFileSync("src/repair/execute-fix-artifact.ts", "utf8");
  const selfHeal = readFileSync("src/repair/self-heal-failed-runs.ts", "utf8");

  assert.match(worker, /appendCodexOutputCapture/);
  assert.match(worker, /openCodexOutputCapture\(codexTranscriptPath\)/);
  assert.match(outputCapture, /DEFAULT_CODEX_OUTPUT_FILE_BYTES = 128 \* 1024 \* 1024/);
  assert.match(outputCapture, /Codex output truncated; final tail follows/);
  assert.doesNotMatch(worker, /Codex output exceeded|CLAWSWEEPER_CODEX_STDIO_MAX_BUFFER_MB/);
  assert.match(worker, /Codex worker timed out[\s\S]*process\.exit\(1\)/);
  assert.match(worker, /CLAWSWEEPER_CODEX_PLANNER_SANDBOX/);
  assert.match(worker, /\? "danger-full-access"\s*:\s*"read-only"/);
  assert.match(
    worker,
    /Codex worker completed without a structured result\.json artifact[\s\S]*process\.exit\(1\)/,
  );
  assert.match(executor, /requeue_required: true/);
  assert.match(executor, /if \(outcome\.requeue_required === true\) process\.exitCode = 1/);
  assert.match(selfHeal, /CLAWSWEEPER_SELF_HEAL_MAX_ATTEMPTS_PER_JOB \?\? 3/);
  assert.match(selfHeal, /reason: "retry_limit_reached"/);
});

test("repair workers expose an explicit sandbox fallback for trusted ephemeral runners", () => {
  const workflow = readFileSync(".github/workflows/repair-cluster-worker.yml", "utf8");

  assert.match(workflow, /planner_sandbox:/);
  assert.match(workflow, /default: read-only/);
  assert.match(workflow, /- danger-full-access/);
  assert.match(workflow, /CLAWSWEEPER_CODEX_PLANNER_SANDBOX: \$\{\{ inputs\.planner_sandbox \}\}/);
});

test("repair workflows preserve existing dispatch while scheduled cluster intake stays gated", () => {
  const cluster = readFileSync(".github/workflows/repair-cluster-worker.yml", "utf8");
  const clusterIntake = readFileSync(".github/workflows/repair-cluster-intake.yml", "utf8");
  const router = readFileSync(".github/workflows/repair-comment-router.yml", "utf8");
  const finalizer = readFileSync(".github/workflows/repair-finalize-open-prs.yml", "utf8");
  const selfHeal = readFileSync(".github/workflows/repair-self-heal.yml", "utf8");
  const sweep = readFileSync(".github/workflows/sweep.yml", "utf8").replace(/\r\n/g, "\n");
  const dispatchJobs = readFileSync("src/repair/dispatch-jobs.ts", "utf8");
  const importGitcrawl = readFileSync("src/repair/import-gitcrawl-clusters.ts", "utf8");
  const importLowSignal = readFileSync("src/repair/import-gitcrawl-low-signal-prs.ts", "utf8");
  const issueImplementation = readFileSync(
    ".github/workflows/repair-issue-implementation-intake.yml",
    "utf8",
  );
  const commitFinding = readFileSync(".github/workflows/repair-commit-finding-intake.yml", "utf8");
  const existingRepairWorkflows = [
    cluster,
    router,
    finalizer,
    selfHeal,
    sweep,
    issueImplementation,
    commitFinding,
  ].join("\n");

  assert.doesNotMatch(existingRepairWorkflows, /CLAWSWEEPER_FEATURE_REPAIR_ENABLED/);
  assert.match(sweep, /pnpm run repair:comment-router -- \\\n[\s\S]*--execute/);
  assert.match(router, /\{ \[ "\$\{\{ github\.event_name \}\}" = "repository_dispatch" \]; \}/);
  assert.match(issueImplementation, /ENABLED: \$\{\{ github\.event\.inputs\.enabled/);
  assert.match(commitFinding, /ENABLED: \$\{\{ github\.event\.inputs\.enabled/);
  assert.match(clusterIntake, /SCHEDULE_ENABLED/);
  assert.match(clusterIntake, /CLAWSWEEPER_FEATURE_CLUSTER_REPAIR_ENABLED/);
  const intakeJobHeader = clusterIntake.slice(
    clusterIntake.indexOf("  intake:"),
    clusterIntake.indexOf("    steps:"),
  );
  assert.match(
    intakeJobHeader,
    /if: \$\{\{ github\.event_name != 'schedule' \|\| vars\.CLAWSWEEPER_FEATURE_CLUSTER_REPAIR_ENABLED == '1' \}\}/,
  );
  assert.ok(
    clusterIntake.indexOf("vars.CLAWSWEEPER_FEATURE_CLUSTER_REPAIR_ENABLED") <
      clusterIntake.indexOf("actions/create-github-app-token"),
    "scheduled cluster intake gate must appear before token creation",
  );
  assert.match(dispatchJobs, /repairJobUsesClusterLane/);
  assert.doesNotMatch(dispatchJobs, /CLAWSWEEPER_FEATURE_CLUSTER_REPAIR_ENABLED/);
  assert.doesNotMatch(importGitcrawl, /CLAWSWEEPER_FEATURE_CLUSTER_REPAIR_ENABLED/);
  assert.doesNotMatch(importLowSignal, /CLAWSWEEPER_FEATURE_CLUSTER_REPAIR_ENABLED/);
});

test("cluster intake publishes generated repair state through state repo", () => {
  const workflow = readFileSync(".github/workflows/repair-cluster-intake.yml", "utf8");
  const stateTokenIndex = workflow.indexOf("uses: ./.github/actions/create-state-token");
  const setupStateIndex = workflow.indexOf("uses: ./.github/actions/setup-state");
  const importIndex = workflow.indexOf("- name: Import one cluster from gitcrawl-store");
  const publishIndex = workflow.indexOf("- name: Publish intake jobs and ledger");

  assert.notEqual(stateTokenIndex, -1);
  assert.notEqual(setupStateIndex, -1);
  assert.notEqual(importIndex, -1);
  assert.notEqual(publishIndex, -1);
  assert.ok(stateTokenIndex < setupStateIndex, "state token must be created before setup-state");
  assert.ok(setupStateIndex < importIndex, "state repo must be hydrated before job import");
  assert.ok(setupStateIndex < publishIndex, "state repo must be configured before publish-main");
  assert.match(workflow, /--path jobs/);
  assert.match(workflow, /--path results\/cluster-repair-intake/);
});

test("conflict self-heal publishes exact-head jobs before worker dispatch", () => {
  const source = readFileSync("src/repair/conflict-self-heal.ts", "utf8");
  const writeIndex = source.indexOf("writeSelfHealJob(candidate);");
  const publishIndex = source.indexOf("publishSelfHealJobs();");
  const dispatchIndex = source.indexOf("dispatchRepair(candidate);");

  assert.notEqual(writeIndex, -1);
  assert.notEqual(publishIndex, -1);
  assert.notEqual(dispatchIndex, -1);
  assert.ok(writeIndex < publishIndex, "self-heal jobs must be written before state publish");
  assert.ok(publishIndex < dispatchIndex, "self-heal jobs must be durable before worker dispatch");
  assert.match(source, /CLAWSWEEPER_STATE_DIR is required/);
  assert.match(source, /head SHA changed after state publish/);
});

test("review prompt asks for concise public review fields", () => {
  const prompt = readFileSync("prompts/review-item.md", "utf8");

  assert.match(prompt, /Keep these fields concise because they become the public review comment/);
  assert.match(prompt, /one short sentence for `changeSummary`, `workReason`, `bestSolution`/);
  assert.match(
    prompt,
    /merge\s+automation is reported by the command\/status comment and hidden markers/,
  );
});

test("review prompt keeps automerge opt-in from becoming generic manual review", () => {
  const prompt = readFileSync("prompts/review-item.md", "utf8");

  assert.match(prompt, /explicitly opted into `clawsweeper:automerge`/);
  assert.match(prompt, /Do not choose `manual_review` solely because/);
  assert.match(prompt, /`maintainer` label/);
  assert.match(prompt, /large `size:\*` label/);
  assert.match(prompt, /choose `queue_fix_pr` even when the\s+finding is process-only or P3/);
  assert.match(prompt, /`CHANGELOG\.md` is release-owned/);
  assert.match(prompt, /Do not\s+make missing `CHANGELOG\.md` a review finding/i);
  assert.match(prompt, /ask for PR-body or commit\s+message context/);
  assert.doesNotMatch(prompt, /missing required changelog\s+entry/);
  assert.match(prompt, /does not by itself block a clean automerge verdict/);
});

test("review prompts require reproduction and solution assessment details", () => {
  const itemPrompt = readFileSync("prompts/review-item.md", "utf8");
  const commitPrompt = readFileSync("prompts/review-commit.md", "utf8");

  assert.match(itemPrompt, /Always fill `reproductionAssessment`/);
  assert.match(itemPrompt, /itemCategory: "bug"/);
  assert.match(itemPrompt, /itemCategory: "skill"/);
  assert.match(itemPrompt, /Always fill `triagePriority`/);
  assert.match(itemPrompt, /maintainers\s+can find issues and pull requests\s+by priority/);
  assert.match(itemPrompt, /not just\s+from PR review findings/);
  assert.match(itemPrompt, /skills\/<vendor>/);
  assert.match(itemPrompt, /upload or publish it through ClawHub\.com/);
  assert.match(itemPrompt, /requiresNewConfigOption/);
  assert.match(itemPrompt, /automatic\s+bug-fix PR creation/);
  assert.match(itemPrompt, /For every other issue or PR reference,\s+use the full GitHub URL/);
  assert.doesNotMatch(itemPrompt, /normal `#123` links/);
  assert.match(itemPrompt, /Always fill `solutionAssessment`/);
  assert.match(itemPrompt, /Do we have a high-confidence way to reproduce the\s+issue\?/);
  assert.match(itemPrompt, /Is this the best way to solve the issue\?/);
  assert.match(commitPrompt, /The checkout is current target\s+`main`, not the commit snapshot/);
  assert.match(commitPrompt, /Do we have a high-confidence way to reproduce the issue\?/);
  assert.match(commitPrompt, /Is this the best way to solve the issue\?/);
});

test("commit review workflow settles and reviews from target main", () => {
  const workflow = readFileSync(".github/workflows/commit-review.yml", "utf8");

  assert.doesNotMatch(workflow, /clawsweeper_commit_review/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /gh workflow run commit-review\.yml/);
  assert.match(workflow, /CLAWSWEEPER_COMMIT_REVIEW_SETTLE_SECONDS \|\| '60'/);
  assert.match(workflow, /sleep "\$SETTLE_SECONDS"/);
  assert.match(workflow, /Check out target main/);
  assert.match(workflow, /checkout -B main refs\/remotes\/origin\/main/);
  assert.doesNotMatch(workflow, /checkout --detach "\$COMMIT_SHA"/);
});

test("sweep target write tokens can merge pull requests", () => {
  const workflow = readFileSync(".github/workflows/sweep.yml", "utf8");
  const targetWriteTokenBlocks = workflow
    .split("- name: Create target write token")
    .slice(1)
    .map((block) => block.split("\n      - ")[0]);

  assert.equal(targetWriteTokenBlocks.length, 3);
  for (const block of targetWriteTokenBlocks) {
    assert.match(block, /permission-contents: write/);
    assert.match(block, /permission-pull-requests: write/);
  }
});

test("sweep review recovery uses explicit failed shard artifacts", () => {
  const workflow = readFileSync(".github/workflows/sweep.yml", "utf8");

  assert.match(
    workflow,
    /name: Review shard \$\{\{ matrix\.shard \}\} · \$\{\{ needs\.plan\.outputs\.target_repo \}\}#\$\{\{ matrix\.item_numbers \}\}/,
  );
  assert.match(
    workflow,
    /- name: Review shard\r?\n\s+id: review-shard\r?\n\s+continue-on-error: true/,
  );
  assert.match(workflow, /- name: Record failed review shard/);
  assert.match(workflow, /steps\.review-shard\.outcome == 'failure'/);
  assert.match(workflow, /name: review-failed-shard-\$\{\{ matrix\.shard \}\}/);
  assert.match(workflow, /pattern: review-failed-shard-\*/);
  assert.ok(workflow.includes('sub("^Review shard ([0-9]+).*$"; "\\\\1")'));
  assert.match(workflow, /needs\.review\.result != 'skipped'/);
  assert.doesNotMatch(
    workflow,
    /needs\.review\.result == 'failure' \|\| needs\.review\.result == 'cancelled'/,
  );
});

test("sweep failed-review retry lane defaults to dry-run exact-item dispatch", () => {
  const workflow = readFileSync(".github/workflows/sweep.yml", "utf8");
  const retryBlock = workflow.slice(
    workflow.indexOf("retry-failed-reviews:"),
    workflow.indexOf("\n\n  audit-dashboard:"),
  );
  const planHeader = workflow.slice(
    workflow.indexOf("\n  plan:"),
    workflow.indexOf("\n    runs-on:", workflow.indexOf("\n  plan:")),
  );

  assert.match(workflow, /cron: "13 \* \* \* \*"/);
  assert.match(planHeader, /github\.event\.schedule == '13 \* \* \* \*'/);
  assert.match(retryBlock, /pnpm run retry-failed-reviews --/);
  assert.match(
    retryBlock,
    /DRY_RUN: \$\{\{ vars\.CLAWSWEEPER_FAILED_REVIEW_RETRY_ENABLED == '1' && 'false' \|\| 'true' \}\}/,
  );
  assert.match(retryBlock, /--dry-run/);
  assert.match(retryBlock, /--workflow-repo "\$GITHUB_REPOSITORY"/);
  assert.match(retryBlock, /--target-repo "\$TARGET_REPO"/);
  assert.match(retryBlock, /--path records\/openclaw-openclaw/);
});

test("sweep dashboard status writes are scoped to the target repository", () => {
  const workflow = readFileSync(".github/workflows/sweep.yml", "utf8");
  const statusCalls = [...workflow.matchAll(new RegExp("pnpm run status -- \\\\", "g"))];

  assert.ok(statusCalls.length > 0);
  for (const match of statusCalls) {
    const block = workflow.slice(match.index, match.index + 220);
    assert.match(block, /--target-repo /);
  }
});

test("review parser strips environment access caveats from risks", () => {
  const parsed = parseDecision(
    closeDecision({
      risks: [
        "GH_TOKEN was unavailable, so authenticated gh could not be used.",
        "A real product uncertainty remains.",
      ],
    }),
  );
  assert.deepEqual(parsed.risks, ["A real product uncertainty remains."]);
});

test("Codex login method defaults to API and accepts explicit local OAuth", () => {
  assert.equal(codexLoginMethod(""), "api");
  assert.equal(codexLoginMethod(" API "), "api");
  assert.equal(codexLoginMethod(" chatgpt "), "chatgpt");
  assert.equal(codexLoginConfig("chatgpt"), 'forced_login_method="chatgpt"');
});

test("Codex login method reads the environment without leaking test state", () => {
  const original = process.env.CLAWSWEEPER_CODEX_LOGIN_METHOD;
  try {
    delete process.env.CLAWSWEEPER_CODEX_LOGIN_METHOD;
    assert.equal(codexLoginMethod(), "api");
    process.env.CLAWSWEEPER_CODEX_LOGIN_METHOD = "chatgpt";
    assert.equal(codexLoginMethod(), "chatgpt");
  } finally {
    if (original === undefined) delete process.env.CLAWSWEEPER_CODEX_LOGIN_METHOD;
    else process.env.CLAWSWEEPER_CODEX_LOGIN_METHOD = original;
  }
});

test("review command leaves Codex login method unset unless explicitly supplied", () => {
  assert.equal(reviewCodexForcedLoginMethodForTest(parseClawsweeperArgs(["review"])), "");
  assert.equal(
    reviewCodexForcedLoginMethodForTest(parseClawsweeperArgs(["review", "--local-only"])),
    "",
  );
  assert.equal(
    reviewCodexForcedLoginMethodForTest(
      parseClawsweeperArgs(["review", "--codex-forced-login-method", "chatgpt"]),
    ),
    "chatgpt",
  );
});

test("Codex login method rejects invalid non-empty overrides", () => {
  assert.throws(
    () => codexLoginMethod("oauth"),
    /Invalid CLAWSWEEPER_CODEX_LOGIN_METHOD: oauth\. Expected "api" or "chatgpt"\./,
  );
});

test("codex subprocess env strips GitHub and App credentials", () => {
  const originalEnv = { ...process.env };
  try {
    process.env.GH_TOKEN = "gh";
    process.env.GITHUB_TOKEN = "github";
    process.env.COMMIT_SWEEPER_TARGET_GH_TOKEN = "target";
    process.env.CLAWSWEEPER_PROOF_INSPECTION_TOKEN = "codex-target";
    process.env.CLAWSWEEPER_APP_ID = "123";
    process.env.CLAWSWEEPER_APP_PRIVATE_KEY = "private";
    process.env.CLAWSWEEPER_CRABFLEET_AGENT_TOKEN = "agent";
    process.env.CLAWSWEEPER_CRABFLEET_SERVICE_TOKEN = "service";
    process.env.CLAWSWEEPER_CRABFLEET_RUNNER_PTY_URL = "wss://example.invalid/secret";
    process.env.CLAWSWEEPER_CRABFLEET_WORK_STATE_URL = "https://example.invalid/secret";
    process.env.OPENAI_API_KEY = "openai";
    process.env.CODEX_API_KEY = "codex";

    const env = codexEnv();

    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.COMMIT_SWEEPER_TARGET_GH_TOKEN, undefined);
    assert.equal(env.CLAWSWEEPER_PROOF_INSPECTION_TOKEN, undefined);
    assert.equal(env.CLAWSWEEPER_APP_ID, undefined);
    assert.equal(env.CLAWSWEEPER_APP_PRIVATE_KEY, undefined);
    assert.equal(env.CLAWSWEEPER_CRABFLEET_AGENT_TOKEN, undefined);
    assert.equal(env.CLAWSWEEPER_CRABFLEET_SERVICE_TOKEN, undefined);
    assert.equal(env.CLAWSWEEPER_CRABFLEET_RUNNER_PTY_URL, undefined);
    assert.equal(env.CLAWSWEEPER_CRABFLEET_WORK_STATE_URL, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.CODEX_API_KEY, undefined);
    assert.equal(env.GIT_OPTIONAL_LOCKS, "0");
  } finally {
    process.env = originalEnv;
  }
});

test("codex subprocess env can expose an explicit read-only GitHub token", () => {
  const originalEnv = { ...process.env };
  try {
    process.env.GH_TOKEN = "ambient";
    process.env.GITHUB_TOKEN = "github";
    process.env.COMMIT_SWEEPER_TARGET_GH_TOKEN = "hidden";
    process.env.CLAWSWEEPER_PROOF_INSPECTION_TOKEN = "hidden-codex";

    const env = codexEnv({ ghToken: "target-read" });

    assert.equal(env.GH_TOKEN, "target-read");
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.COMMIT_SWEEPER_TARGET_GH_TOKEN, undefined);
    assert.equal(env.CLAWSWEEPER_PROOF_INSPECTION_TOKEN, undefined);
    assert.equal(env.GIT_OPTIONAL_LOCKS, "0");
  } finally {
    process.env = originalEnv;
  }
});

test("related title search terms keep issue-specific words", () => {
  assert.deepEqual(
    relatedTitleSearchTerms(
      "Feature: message:before_send hook to enable content-quality fallback gating",
    ),
    ["message", "before_send", "hook", "enable", "content-quality", "fallback"],
  );
});

test("related GitHub issue search query uses issue-only title terms", () => {
  assert.equal(
    relatedGitHubIssueSearchQueryForTest(
      "openclaw/openclaw",
      "[Bug] Telegram group photo-only messages do not trigger image understanding",
    ),
    'repo:openclaw/openclaw is:issue in:title,body telegram group "photo-only" messages',
  );
  assert.equal(relatedGitHubIssueSearchQueryForTest("openclaw/openclaw", "Bug"), null);
});

test("audit detects live/local state drift and unsafe proposed records", () => {
  const result = auditFromSnapshot({
    openItems: [
      item({ number: 1, title: "tracked open" }),
      item({ number: 2, title: "missing open" }),
      item({ number: 3, title: "reopened archived" }),
      item({ number: 9, title: "maintainer implemented" }),
    ],
    itemRecords: [
      auditRecord(1),
      auditRecord(4),
      auditRecord(5),
      auditRecord(6, {
        labels: ["security"],
        decision: "close",
        closeReason: "implemented_on_main",
        action: "proposed_close",
      }),
      auditRecord(9, {
        labels: ["maintainer"],
        decision: "close",
        closeReason: "implemented_on_main",
        action: "proposed_close",
      }),
      auditRecord(7, { reviewStatus: "stale_local_checkout_blocked" }),
    ],
    closedRecords: [
      auditRecord(3, { location: "closed", path: "closed/3.md" }),
      auditRecord(5, { location: "closed", path: "closed/5.md" }),
      auditRecord(8, {
        location: "closed",
        path: "closed/8.md",
        labels: ["security"],
        action: "proposed_close",
      }),
    ],
    scanComplete: true,
    pagesScanned: 1,
    generatedAt: "2026-04-26T00:00:00.000Z",
  });

  assert.equal(result.counts.missingOpen, 1);
  assert.equal(result.counts.missingEligibleOpen, 1);
  assert.equal(result.counts.missingMaintainerOpen, 0);
  assert.equal(result.counts.missingProtectedOpen, 0);
  assert.equal(result.counts.missingRecentOpen, 0);
  assert.equal(result.findings.missingOpen[0].number, 2);
  assert.equal(result.findings.missingOpen[0].missingReason, "eligible");
  assert.equal(result.findings.missingEligibleOpen[0].number, 2);
  assert.equal(result.counts.openArchived, 1);
  assert.equal(result.findings.openArchived[0].closedPath, "closed/3.md");
  assert.equal(result.counts.staleItemRecords, 4);
  assert.equal(result.counts.duplicateRecords, 1);
  assert.equal(result.counts.protectedProposed, 1);
  assert.equal(result.findings.protectedProposed[0].number, 6);
  assert.equal(result.counts.staleReviews, 1);
});

test("audit classifies missing open records by actionable reason", () => {
  const base = {
    itemRecords: [],
    closedRecords: [],
    scanComplete: true,
    pagesScanned: 1,
    generatedAt: "2026-04-26T12:00:00.000Z",
  };
  const expectedQueueLag = auditFromSnapshot({
    ...base,
    openItems: [
      item({ number: 1, authorAssociation: "MEMBER" }),
      item({ number: 2, labels: ["beta-blocker"] }),
      item({
        number: 3,
        createdAt: "2026-04-26T11:30:00.000Z",
        updatedAt: "2026-04-26T11:30:00.000Z",
      }),
    ],
  });

  assert.equal(expectedQueueLag.counts.missingOpen, 3);
  assert.equal(expectedQueueLag.counts.missingEligibleOpen, 1);
  assert.equal(expectedQueueLag.counts.missingMaintainerOpen, 0);
  assert.equal(expectedQueueLag.counts.missingProtectedOpen, 1);
  assert.equal(expectedQueueLag.counts.missingRecentOpen, 1);
  assert.deepEqual(
    expectedQueueLag.findings.missingOpen.map((finding) => finding.missingReason),
    ["eligible", "protected_label", "recently_created"],
  );
  assert.equal(auditHasStrictFailures(expectedQueueLag), true);

  const actionableDrift = auditFromSnapshot({
    ...base,
    openItems: [item({ number: 4, createdAt: "2026-04-24T00:00:00.000Z" })],
  });

  assert.equal(actionableDrift.counts.missingEligibleOpen, 1);
  assert.equal(actionableDrift.findings.missingEligibleOpen[0].missingReason, "eligible");
  assert.equal(auditHasStrictFailures(actionableDrift), true);
});

test("audit health section summarizes strict status and actionable findings", () => {
  const result = auditFromSnapshot({
    openItems: [
      item({
        number: 10,
        title: "eligible missing",
        createdAt: "2026-04-24T00:00:00.000Z",
      }),
      item({ number: 11, title: "reopened archived" }),
      item({ number: 14, title: "stale open review" }),
    ],
    itemRecords: [
      auditRecord(12, { title: "stale local" }),
      auditRecord(13, {
        title: "protected close",
        labels: ["security"],
        action: "proposed_close",
      }),
      auditRecord(14, {
        title: "stale open review",
        currentState: "open",
        reviewStatus: "stale_reopened",
      }),
    ],
    closedRecords: [auditRecord(11, { location: "closed", path: "closed/11.md" })],
    scanComplete: true,
    pagesScanned: 1,
    generatedAt: "2026-04-26T12:00:00.000Z",
  });
  const section = auditHealthSection(result);

  assert.match(section, /### Audit Health/);
  assert.match(section, /<!-- clawsweeper-audit:openclaw-openclaw:start -->/);
  assert.match(
    section,
    /Repository: \[openclaw\/openclaw\]\(https:\/\/github\.com\/openclaw\/openclaw\)/,
  );
  assert.match(section, /Status: \*\*Action needed\*\*/);
  assert.match(section, /Targeted review input: `10,11,14`/);
  assert.match(section, /\| Missing eligible open records \| 1 \|/);
  assert.match(section, /\[#10\]\(https:\/\/github\.com\/openclaw\/openclaw\/issues\/10\)/);
  assert.match(section, /Missing eligible open/);
  assert.match(section, /\[#13\]\(https:\/\/github\.com\/openclaw\/openclaw\/issues\/13\)/);
  assert.match(section, /Protected proposed close/);
  assert.match(section, /\[#11\]\(https:\/\/github\.com\/openclaw\/openclaw\/issues\/11\)/);
  assert.match(section, /Open archived/);
  assert.doesNotMatch(section, /\[#12\]\(https:\/\/github\.com\/openclaw\/openclaw\/issues\/12\)/);
});

test("audit defers stale item drift until the open scan is complete", () => {
  const result = auditFromSnapshot({
    openItems: [item({ number: 1 })],
    itemRecords: [auditRecord(1), auditRecord(2)],
    closedRecords: [],
    scanComplete: false,
    pagesScanned: 1,
    generatedAt: "2026-04-26T00:00:00.000Z",
  });

  assert.equal(result.scan.complete, false);
  assert.equal(result.counts.staleItemRecords, 0);
  assert.deepEqual(result.findings.staleItemRecords, []);
});

test("recently closed dashboard rows link items and archived reports", () => {
  const rows = formatRecentClosedRows([
    {
      repo: "openclaw/clawhub",
      number: 42,
      kind: "pull_request",
      title: "Fix pipe | title",
      closeReason: "implemented_on_main",
      appliedAt: "2026-04-26T20:00:00.000Z",
      reportPath: "closed/42.md",
    },
  ]);

  assert.match(rows, /\[#42\]\(https:\/\/github\.com\/openclaw\/clawhub\/pull\/42\)/);
  assert.match(
    rows,
    /\[closed\/42\.md\]\(https:\/\/github\.com\/openclaw\/clawsweeper\/blob\/main\/closed\/42\.md\)/,
  );
  assert.match(rows, /Fix pipe \\| title/);
  assert.match(rows, /already implemented on main/);
  assert.match(rows, /Apr 26, 2026, 20:00 UTC/);
});

test("recently closed dashboard rows include reconciled external closes", () => {
  const markdown = reportFrontMatter({
    current_state: "closed",
    current_item_closed_at: "2026-04-28T08:15:03.000Z",
    reconciled_at: "2026-04-28T08:18:02.202Z",
    action_taken: "kept_open",
  });
  const rows = formatRecentClosedRows([
    {
      repo: "openclaw/openclaw",
      number: 73370,
      kind: "issue",
      title: "Externally closed item",
      closeReason: "closed externally after review",
      closedAt: dashboardClosedAt(markdown),
      appliedAt: undefined,
      reportPath: "records/openclaw-openclaw/closed/73370.md",
    },
  ]);

  assert.equal(dashboardClosedAt(markdown), "2026-04-28T08:15:03.000Z");
  assert.equal(
    dashboardClosedAt(
      reportFrontMatter({
        current_state: "closed",
        reconciled_at: "2026-04-28T08:18:02.202Z",
        action_taken: "kept_open",
      }),
    ),
    "2026-04-28T08:18:02.202Z",
  );
  assert.match(rows, /closed externally after review/);
  assert.match(rows, /Apr 28, 2026, 08:15 UTC/);
});

test("GitHub retry classifier distinguishes throttle and transient failures", () => {
  const throttled = new Error("API rate limit exceeded for user ID 1");
  assert.equal(ghRetryKind(throttled), "throttle");
  assert.equal(shouldRetryGh(throttled), true);
  assert.equal(ghRetryKind(new Error("gh: HTTP 429: Too Many Requests")), "throttle");
  assert.equal(ghRetryWaitMs("throttle", 0), 30_000);
  assert.equal(ghRetryWaitMs("throttle", 3), 60_000);
  assert.equal(ghRetryWaitMs("transient", 0), 2_000);

  const eof = Object.assign(new Error("Command failed: gh api repos/openclaw/openclaw/issues"), {
    stderr: 'Get "https://api.github.com/repos/openclaw/openclaw/issues?page=54": unexpected EOF\n',
  });
  assert.equal(ghRetryKind(eof), "transient");
  assert.equal(shouldRetryGh(eof), true);

  const connectionReset = new Error(
    "Post https://api.github.com/graphql: read: connection reset by peer",
  );
  assert.equal(ghRetryKind(connectionReset), "transient");
  assert.equal(ghRetryKind(new Error("read: connection reset")), "transient");

  const badGateway = Object.assign(new Error("gh: HTTP 502: Bad Gateway"), { stderr: "" });
  assert.equal(ghRetryKind(badGateway), "transient");

  const dispatchServerError = Object.assign(
    new Error(
      "could not create workflow dispatch event: HTTP 500: Failed to run workflow dispatch",
    ),
    { stderr: "" },
  );
  assert.equal(ghRetryKind(dispatchServerError), "transient");

  const htmlInsteadOfJson = Object.assign(
    new Error("Command failed: gh api repos/openclaw/openclaw/issues?page=47"),
    { stderr: "invalid character '<' looking for beginning of value\n" },
  );
  assert.equal(ghRetryKind(htmlInsteadOfJson), "transient");
  assert.equal(ghRetryKind(new Error("dial tcp: connection refused")), "transient");
  assert.equal(ghRetryKind(new Error("Could not resolve host: api.github.com")), "transient");
  assert.equal(ghRetryKind(new Error("request timed out")), "transient");

  const authFailure = Object.assign(new Error("gh: HTTP 401: Bad credentials"), {
    stderr: "Bad credentials",
  });
  assert.equal(ghRetryKind(authFailure), "none");
  assert.equal(shouldRetryGh(authFailure), false);

  const authFailureForIssue502 = Object.assign(
    new Error("Command failed: gh api repos/openclaw/openclaw/issues/502/comments"),
    { stderr: "gh: HTTP 401: Bad credentials" },
  );
  assert.equal(ghRetryKind(authFailureForIssue502), "none");
});

test("GitHub not found errors are recognizable non-retryable lookup misses", () => {
  const error = new Error(
    "Command failed: gh api repos/openclaw/openclaw/pulls/228\nHTTP 404: Not Found",
  );
  assert.equal(isGitHubNotFoundError(error), true);
  assert.equal(shouldRetryGh(error), false);
});

test("closing pull request references preserve fork repository identity", () => {
  assert.deepEqual(
    closingPullRequestReferenceTarget(
      {
        number: 228,
        repository: {
          owner: { login: "BingqingLyu" },
          name: "openclaw",
        },
      },
      "openclaw/openclaw",
    ),
    { repo: "BingqingLyu/openclaw", number: 228 },
  );
  assert.deepEqual(closingPullRequestReferenceTarget({ number: 40756 }, "openclaw/openclaw"), {
    repo: "openclaw/openclaw",
    number: 40756,
  });
  assert.equal(closingPullRequestReferenceTarget({ number: "228" }, "openclaw/openclaw"), null);
});

test("GitHub requires-authentication write errors are recognizable apply skips", () => {
  const error = Object.assign(
    new Error("Command failed: gh api repos/openclaw/openclaw/issues/74425/comments"),
    {
      stdout:
        '{\n  "message": "Requires authentication",\n  "documentation_url": "https://docs.github.com/rest",\n  "status": "401"\n}',
      stderr: "gh: Requires authentication (HTTP 401)\n",
    },
  );
  assert.equal(isGitHubRequiresAuthenticationError(error), true);
  assert.equal(shouldRetryGh(error), false);

  const issueEditError = Object.assign(
    new Error("Command failed: gh issue edit 85306 --add-label impact:message-loss"),
    {
      stderr:
        'error fetching labels: non-200 OK status code: 401 Unauthorized body: "{\\n  \\"message\\": \\"Requires authentication\\",\\n  \\"status\\": \\"401\\"\\n}"',
    },
  );
  assert.equal(isGitHubRequiresAuthenticationError(issueEditError), true);
  assert.equal(shouldRetryGh(issueEditError), false);
});

test("locked conversation failures are non-retryable but recognizable apply skips", () => {
  const locked = Object.assign(
    new Error("Command failed: gh api repos/openclaw/openclaw/issues/40088/comments"),
    {
      stdout:
        '{"message":"Unable to create comment because issue is locked.","documentation_url":"https://docs.github.com/articles/locking-conversations/","status":"403"}',
      stderr: "gh: Unable to create comment because issue is locked. (HTTP 403)\n",
    },
  );

  assert.equal(ghRetryKind(locked), "none");
  assert.equal(isLockedConversationCommentError(locked), true);
  assert.equal(
    lockedConversationApplyReason({ locked: true, activeLockReason: "resolved" }),
    "conversation is locked (resolved)",
  );
  assert.equal(lockedConversationApplyReason({ locked: false, activeLockReason: null }), null);
});

test("safeOutputTail tolerates missing process output", () => {
  assert.equal(safeOutputTail(undefined), "");
  assert.equal(safeOutputTail(null), "");
  assert.equal(safeOutputTail("abcdef", 3), "def");
});
