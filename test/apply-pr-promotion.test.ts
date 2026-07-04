import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  promotionGhMock,
  reportWithSyncedReviewComment,
  runApplyDecisionsForTest,
  stalePullRequestReport,
  tmpPrefix,
  withMockCodexProof,
  withMockGh,
  workPlanCandidateReport,
} from "./helpers.ts";

test("apply-decisions upgrades live no-diff kept-open PRs to duplicate closes", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(itemsDir, "322.md"),
      workPlanCandidateReport({
        number: 322,
        repository: "openclaw/openclaw",
        type: "pull_request",
        title: "Empty PR",
        url: "https://github.com/openclaw/openclaw/pull/322",
        decision: "keep_open",
        close_reason: "none",
        action_taken: "kept_open",
        item_snapshot_hash: "reviewed-snapshot",
        item_created_at: "2026-05-01T00:00:00Z",
        item_updated_at: "2026-05-01T00:00:00Z",
        pull_head_sha: "head-sha",
        work_cluster_refs: JSON.stringify([
          "Superseded by https://github.com/openclaw/openclaw/pull/400",
        ]),
      }),
      "utf8",
    );

    const ghMock = `
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const path = args[1] || "";
if (args[0] === "api" && args[1] === "-i" && /\\/issues\\/322\\/timeline(?:\\?|$)/.test(args[2] || "")) {
  console.log("HTTP/2 200\\n\\n[]");
} else if (args[0] === "api" && /\\/issues\\/322\\/comments(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/322\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/322$/.test(path)) {
  console.log(JSON.stringify({
    number: 322,
    title: "Empty PR",
    html_url: "https://github.com/openclaw/openclaw/pull/322",
    body: "No remaining diff.",
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
    pull_request: { url: "https://api.github.com/repos/openclaw/openclaw/pulls/322" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/322$/.test(path)) {
  console.log(JSON.stringify({
    number: 322,
    title: "Empty PR",
    html_url: "https://github.com/openclaw/openclaw/pull/322",
    state: "open",
    changed_files: 0,
    commits: 0,
    review_comments: 0,
    body: "No remaining diff.",
    head: { sha: "head-sha", ref: "branch", repo: { full_name: "fork/openclaw" } },
    base: { sha: "base-sha", ref: "main", repo: { full_name: "openclaw/openclaw" } },
    user: { login: "reporter" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/400$/.test(path)) {
  console.log(JSON.stringify({
    number: 400,
    title: "Old related PR",
    html_url: "https://github.com/openclaw/openclaw/pull/400",
    state: "closed",
    merged_at: "2026-05-02T00:00:00Z",
    updated_at: "2026-05-02T00:00:00Z",
    mergeable_state: "clean",
    body: "Old related PR body.",
    labels: [{ name: "proof: sufficient" }]
  }));
} else if (args[0] === "api" && /\\/issues\\/400$/.test(path)) {
  console.log(JSON.stringify({
    number: 400,
    title: "Old related PR",
    html_url: "https://github.com/openclaw/openclaw/pull/400",
    body: "Old related PR body.",
    state: "closed",
    updated_at: "2026-05-02T00:00:00Z",
    labels: [{ name: "proof: sufficient" }],
    comments: 0,
    pull_request: { url: "https://api.github.com/repos/openclaw/openclaw/pulls/400" }
  }));
} else if (args[0] === "api" && /\\/issues\\/400\\/comments(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([]));
} else if (args[0] === "api" && /\\/pulls\\/400\\/files(?:\\?|$)/.test(path)) {
  const files = [{ filename: "src/runtime.ts" }];
  if (args.includes("--jq")) console.log(JSON.stringify(files.map((file) => file.filename)));
  else console.log(JSON.stringify([files]));
} else if (args[0] === "api" && /\\/pulls\\/322\\/(files|commits|comments)(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "label" || args[0] === "issue") {
  console.log("");
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    withMockGh(root, ghMock, () => {
      withMockCodexProof(
        root,
        { type: "failure", message: "proof should not run for no-diff PR" },
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
    });

    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 322,
        action: "review_comment_synced",
        reason: "would create durable Codex review comment",
      },
      {
        number: 322,
        action: "closed",
        reason:
          "dry-run: would close as duplicate or superseded; dry-run: would post close-applied comment",
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions promotes old F-rated stale PRs to duplicate closes", () => {
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
        work_cluster_refs: JSON.stringify(["Related discussion in #400"]),
      }),
      330,
      "none",
    );
    writeFileSync(join(itemsDir, "330.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 330,
        comment: synced.comment,
        linkedPulls: {
          400: {
            number: 400,
            title: "Related cleanup",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "closed",
            merged_at: "2026-05-02T00:00:00Z",
            body: "Related cleanup, not stale PR coverage evidence.",
            comments: [],
            labels: [],
          },
        },
      }),
      () => {
        withMockCodexProof(
          root,
          { type: "failure", message: "proof should not run for stale promotion incidental ref" },
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
      },
    );

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
      number: number;
      action: string;
      reason: string;
    }>;
    assert.equal(
      report.some((entry) => entry.action === "review_comment_synced"),
      true,
    );
    assert.equal(
      report.some((entry) => entry.action === "closed"),
      true,
    );
    assert.match(
      report.find((entry) => entry.action === "closed")?.reason ?? "",
      /duplicate or superseded/,
    );
    assert.doesNotMatch(JSON.stringify(report), /proof should not run/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions promotes stale PRs after automation-only drift", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const synced = reportWithSyncedReviewComment(stalePullRequestReport(), 330, "none");
    writeFileSync(join(itemsDir, "330.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 330,
        comment: synced.comment,
        itemUpdatedAt: "2026-05-02T00:00:00Z",
      }),
      () => {
        withMockCodexProof(
          root,
          {
            type: "decision",
            decision: "covered",
            reason: "PR B is the canonical PR covering PR A.",
          },
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
      },
    );

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{ action: string }>;
    assert.equal(
      report.some((entry) => entry.action === "closed"),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions does not promote stale PRs from truncated activity", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const synced = reportWithSyncedReviewComment(stalePullRequestReport(), 330, "none");
    writeFileSync(join(itemsDir, "330.md"), synced.report, "utf8");

    const comments = Array.from({ length: 24 }, (_, index) => ({
      id: 9330 + index,
      html_url: `https://github.com/openclaw/openclaw/pull/330#issuecomment-${9330 + index}`,
      created_at: "2026-05-01T01:00:00Z",
      updated_at: "2026-05-01T01:00:00Z",
      user: { login: "clawsweeper[bot]" },
      body: index === 0 ? synced.comment : "automation label sync",
    }));

    withMockGh(
      root,
      promotionGhMock({
        number: 330,
        comment: synced.comment,
        comments,
        issueCommentCount: 25,
      }),
      () => {
        withMockCodexProof(root, { type: "failure", message: "proof should not run" }, () => {
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
        });
      },
    );

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{ action: string }>;
    assert.equal(
      report.some((entry) => entry.action === "closed"),
      false,
    );
    assert.doesNotMatch(JSON.stringify(report), /proof should not run/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions does not promote stale PRs after human follow-up", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const synced = reportWithSyncedReviewComment(stalePullRequestReport(), 330, "none");
    writeFileSync(join(itemsDir, "330.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 330,
        comment: synced.comment,
        comments: [
          {
            id: 9330,
            html_url: "https://github.com/openclaw/openclaw/pull/330#issuecomment-9330",
            created_at: "2026-05-01T01:00:00Z",
            updated_at: "2026-05-01T01:00:00Z",
            user: { login: "clawsweeper[bot]" },
            body: synced.comment,
          },
          {
            id: 9331,
            html_url: "https://github.com/openclaw/openclaw/pull/330#issuecomment-9331",
            created_at: "2026-05-01T02:00:00Z",
            updated_at: "2026-05-01T02:00:00Z",
            user: { login: "reporter" },
            body: "I can still work on this.",
          },
        ],
      }),
      () => {
        withMockCodexProof(root, { type: "failure", message: "proof should not run" }, () => {
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
        });
      },
    );

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{ action: string }>;
    assert.equal(
      report.some((entry) => entry.action === "closed"),
      false,
    );
    assert.doesNotMatch(JSON.stringify(report), /proof should not run/);
    assert.match(readFileSync(join(itemsDir, "330.md"), "utf8"), /^action_taken: kept_open$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions does not promote stale PRs after a command-only re-review request", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const synced = reportWithSyncedReviewComment(stalePullRequestReport(), 330, "none");
    writeFileSync(join(itemsDir, "330.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 330,
        comment: synced.comment,
        comments: [
          {
            id: 9330,
            html_url: "https://github.com/openclaw/openclaw/pull/330#issuecomment-9330",
            created_at: "2026-05-01T01:00:00Z",
            updated_at: "2026-05-01T01:00:00Z",
            user: { login: "clawsweeper[bot]" },
            body: synced.comment,
          },
          {
            id: 9331,
            html_url: "https://github.com/openclaw/openclaw/pull/330#issuecomment-9331",
            created_at: "2026-05-01T02:00:00Z",
            updated_at: "2026-05-01T02:00:00Z",
            user: { login: "reporter" },
            body: "@clawsweeper re-review",
          },
        ],
        timeline: [
          {
            id: 9331,
            event: "commented",
            created_at: "2026-05-01T02:00:00Z",
            actor: { login: "reporter" },
          },
        ],
      }),
      () => {
        withMockCodexProof(root, { type: "failure", message: "proof should not run" }, () => {
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
        });
      },
    );

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{ action: string }>;
    assert.equal(
      report.some((entry) => entry.action === "closed"),
      false,
    );
    assert.doesNotMatch(JSON.stringify(report), /proof should not run/);
    assert.match(readFileSync(join(itemsDir, "330.md"), "utf8"), /^action_taken: kept_open$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions promotes recommended pause-or-close PRs", () => {
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
        number: 331,
        title: "Superseded prompt PR",
        pr_rating_overall: "D",
        pr_rating_proof: "D",
        merge_risk_options: JSON.stringify([
          {
            title: "Close as superseded after maintainer decision",
            body: "Current-main prompt work already covers the useful guidance.",
            category: "pause_or_close",
            recommended: true,
            automergeInstruction: "",
          },
        ]),
      }),
      331,
      "none",
    );
    writeFileSync(join(itemsDir, "331.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({ number: 331, title: "Superseded prompt PR", comment: synced.comment }),
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
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions promotes PRs superseded by linked pull requests", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const proofLogPath = join(root, "proof.log");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const linkedMarkdownLabelReport = stalePullRequestReport({
      number: 332,
      title: "Old activity PR",
      pr_rating_overall: "D",
      pr_rating_proof: "D",
      pr_rating_patch: "D",
      work_cluster_refs: JSON.stringify([
        "[replacement PR](https://github.com/openclaw/openclaw/pull/400)",
      ]),
    })
      .replace("Overall tier: F", "Overall tier: D")
      .replace("Proof tier: F", "Proof tier: D")
      .replace("Patch tier: F", "Patch tier: D");
    const synced = reportWithSyncedReviewComment(linkedMarkdownLabelReport, 332, "none");
    writeFileSync(join(itemsDir, "332.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 332,
        title: "Old activity PR",
        comment: synced.comment,
        linkedPulls: {
          400: {
            number: 400,
            title: "Canonical activity PR",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "open",
            merged_at: null,
            mergeable_state: "clean",
            labels: ["proof: sufficient"],
          },
        },
      }),
      () => {
        withMockCodexProof(
          root,
          {
            type: "decision",
            decision: "covered",
            reason: "PR B is the canonical PR covering PR A.",
            invocationLogPath: proofLogPath,
          },
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
      },
    );

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
      number: number;
      action: string;
      reason: string;
    }>;
    assert.equal(
      report.some((entry) => entry.action === "closed"),
      true,
    );
    assert.match(
      report.find((entry) => entry.action === "closed")?.reason ?? "",
      /duplicate or superseded/,
    );
    assert.match(readFileSync(proofLogPath, "utf8"), /proof/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions does not promote docs-only PRs superseded by code-only pull requests", () => {
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
        title: "ENETDOWN docs companion",
        pr_rating_overall: "D",
        pr_rating_proof: "D",
        pr_rating_patch: "D",
        pull_files: JSON.stringify(["docs/gateway/troubleshooting.md", "docs/platforms/macos.md"]),
        pull_files_truncated: false,
        work_cluster_refs: JSON.stringify([
          "Superseded by https://github.com/openclaw/openclaw/pull/400",
        ]),
      }),
      337,
      "none",
    );
    writeFileSync(join(itemsDir, "337.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 337,
        title: "ENETDOWN docs companion",
        comment: synced.comment,
        linkedPulls: {
          400: {
            number: 400,
            title: "Canonical ENETDOWN runtime fix",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "closed",
            merged_at: "2026-05-26T17:40:32Z",
            mergeable_state: "clean",
            labels: ["proof: sufficient"],
            files: [
              "src/infra/unhandled-rejections.ts",
              "extensions/telegram/src/network-errors.ts",
            ],
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
