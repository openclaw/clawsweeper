import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  implementedCloseReport,
  reportWithSyncedReviewComment,
  runApplyDecisionsForTest,
  tmpPrefix,
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
