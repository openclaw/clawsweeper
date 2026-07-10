import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  lowSignalCloseReport,
  promotionGhMock,
  reportWithSyncedReviewComment,
  runApplyDecisionsForTest,
  stalePullRequestReport,
  tmpPrefix,
  withMockCodexProof,
  withMockGh,
  workPlanCandidateReport,
} from "./helpers.ts";

function runLowSignalApplyFixture(options: {
  number: number;
  reportOverrides?: Record<string, unknown>;
  itemCreatedAt?: string;
  itemUpdatedAt?: string;
  headSha?: string;
  headActivityAt?: string | null;
  mergeable?: boolean | null;
  mergeableState?: string | null;
  comments?: (reviewComment: string) => unknown[];
  timeline?: unknown[];
}): Array<{ number: number; action: string; reason: string }> {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const sourceReport = lowSignalCloseReport({
      number: options.number,
      title: "Low-signal close guard fixture",
      ...options.reportOverrides,
    });
    const synced = reportWithSyncedReviewComment(
      sourceReport,
      options.number,
      "low_signal_unmergeable_pr",
    );
    writeFileSync(join(itemsDir, `${options.number}.md`), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: options.number,
        title: "Low-signal close guard fixture",
        comment: synced.comment,
        ...(options.itemCreatedAt ? { itemCreatedAt: options.itemCreatedAt } : {}),
        ...(options.itemUpdatedAt ? { itemUpdatedAt: options.itemUpdatedAt } : {}),
        ...(options.headSha ? { headSha: options.headSha } : {}),
        ...(options.headActivityAt !== undefined ? { headActivityAt: options.headActivityAt } : {}),
        ...(options.mergeable !== undefined ? { mergeable: options.mergeable } : {}),
        ...(options.mergeableState !== undefined ? { mergeableState: options.mergeableState } : {}),
        ...(options.comments ? { comments: options.comments(synced.comment) } : {}),
        ...(options.timeline ? { timeline: options.timeline } : {}),
      }),
      () => {
        runApplyDecisionsForTest({
          targetRepo: "openclaw/openclaw",
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
          extraArgs: [
            "--dry-run",
            "--apply-kind",
            "all",
            "--apply-close-reasons",
            "low_signal_unmergeable_pr",
            "--stale-min-age-days",
            "30",
            "--item-numbers",
            String(options.number),
          ],
        });
      },
    );

    return JSON.parse(readFileSync(reportPath, "utf8"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertResolvedPromotionRespectsCloseReasonFilter(options: {
  number: number;
  applyCloseReason: "duplicate_or_superseded" | "low_signal_unmergeable_pr";
  sourceFiles: string[];
  linkedFiles?: string[];
  noDiff?: boolean;
}): void {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const proofLogPath = join(root, "proof.log");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const keepOpenSummary =
      "Keep open: live promotion must first resolve to an enabled close reason.";
    const sourceReport = stalePullRequestReport({
      number: options.number,
      title: "Ambiguous stale promotion",
      pull_files: JSON.stringify(options.sourceFiles),
      pull_files_truncated: false,
      work_cluster_refs: JSON.stringify(options.linkedFiles ? ["Superseded by #400"] : []),
    }).replace(
      "## Summary\n\nThe dashboard has queue_fix_pr candidates but no generated coding plan.",
      `## Summary\n\n${keepOpenSummary}`,
    );
    const synced = reportWithSyncedReviewComment(sourceReport, options.number, "none");
    const itemPath = join(itemsDir, `${options.number}.md`);
    writeFileSync(itemPath, synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: options.number,
        title: "Ambiguous stale promotion",
        comment: synced.comment,
        changedFiles: options.noDiff ? 0 : options.sourceFiles.length,
        sourceFiles: options.sourceFiles,
        linkedPulls: options.linkedFiles
          ? {
              400: {
                number: 400,
                title: "Merged canonical replacement",
                html_url: "https://github.com/openclaw/openclaw/pull/400",
                state: "closed",
                merged_at: "2026-05-02T00:00:00Z",
                mergeable_state: "clean",
                labels: ["proof: sufficient"],
                files: options.linkedFiles,
              },
            }
          : {},
      }),
      () => {
        withMockCodexProof(
          root,
          {
            type: "failure",
            message: "proof must not run for a resolved disallowed promotion",
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
                "--apply-kind",
                "all",
                "--apply-close-reasons",
                options.applyCloseReason,
                "--processed-limit",
                "3",
              ],
            });
          },
        );
      },
    );

    const results = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{ action: string }>;
    assert.equal(
      results.some((entry) => entry.action === "closed"),
      false,
    );
    assert.equal(existsSync(join(closedDir, `${options.number}.md`)), false);
    const stored = readFileSync(itemPath, "utf8");
    assert.match(stored, /^decision: keep_open$/m);
    assert.match(stored, /^close_reason: none$/m);
    assert.match(stored, /^apply_checked_at: /m);
    assert.match(
      stored,
      new RegExp(`## Summary\\n\\n${keepOpenSummary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
    const commentStatePath = join(root, `comment-state-${options.number}.json`);
    const liveComment = existsSync(commentStatePath)
      ? (JSON.parse(readFileSync(commentStatePath, "utf8")) as { body: string }).body
      : synced.comment;
    assert.doesNotMatch(liveComment, /clawsweeper-(?:verdict:close|action:close-required)/);
    assert.equal(existsSync(proofLogPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("apply-decisions checkpoints a valid promotion probe with no action record", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const itemPath = join(itemsDir, "333.md");
    const now = new Date().toISOString();
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const sourceReport = stalePullRequestReport({
      number: 333,
      title: "Recent incomplete PR",
      item_created_at: now,
      item_updated_at: now,
      reviewed_at: now,
      labels: JSON.stringify([]),
    });
    const synced = reportWithSyncedReviewComment(sourceReport, 333, "none");
    writeFileSync(itemPath, synced.report, "utf8");

    const ghOptions = {
      number: 333,
      title: "Recent incomplete PR",
      itemCreatedAt: now,
      itemUpdatedAt: now,
      comment: synced.comment,
    };
    let liveLabels = [];
    let actions = [{ action: "not-run" }];
    for (let attempt = 0; attempt < 5 && actions.length > 0; attempt += 1) {
      withMockGh(root, promotionGhMock({ ...ghOptions, labels: liveLabels }), () => {
        runApplyDecisionsForTest({
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
          extraArgs: ["--target-repo", "openclaw/openclaw", "--processed-limit", "3"],
        });
      });
      actions = JSON.parse(readFileSync(reportPath, "utf8"));
      if (actions.length === 0) break;
      const stored = readFileSync(itemPath, "utf8");
      liveLabels = JSON.parse(stored.match(/^labels: (.+)$/m)?.[1] ?? "[]");
      writeFileSync(itemPath, stored.replace(/^apply_checked_at: .*\n/m, ""), "utf8");
    }

    assert.deepEqual(actions, []);
    assert.match(readFileSync(itemPath, "utf8"), /^apply_checked_at: /m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply leaves a promotable old report unchanged while exact-head review is active", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const number = 74487;
    const headSha = "0123456789abcdef0123456789abcdef01234567";
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });

    const sourceReport = workPlanCandidateReport({
      number,
      repository: "openclaw/openclaw",
      type: "pull_request",
      title: "Empty PR under active re-review",
      url: `https://github.com/openclaw/openclaw/pull/${number}`,
      decision: "keep_open",
      close_reason: "none",
      action_taken: "kept_open",
      item_snapshot_hash: "reviewed-snapshot",
      item_created_at: "2026-05-01T00:00:00Z",
      item_updated_at: "2026-05-01T00:00:00Z",
      reviewed_at: "2026-05-01T00:00:00Z",
      pull_head_sha: headSha,
      work_cluster_refs: JSON.stringify([]),
    });
    const synced = reportWithSyncedReviewComment(sourceReport, number, "none");
    const activeComment = synced.comment.replace(
      `<!-- clawsweeper-review item=${number} -->`,
      [
        `<!-- clawsweeper-review-status:started item=${number} sha=${headSha} started_at=${startedAt} lease_expires_at=${expiresAt} v=1 -->`,
        `<!-- clawsweeper-review item=${number} -->`,
      ].join("\n\n"),
    );
    const itemPath = join(itemsDir, `${number}.md`);
    writeFileSync(itemPath, synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number,
        title: "Empty PR under active re-review",
        headSha,
        changedFiles: 0,
        sourceFiles: [],
        comment: activeComment,
      }),
      () => {
        runApplyDecisionsForTest({
          targetRepo: "openclaw/openclaw",
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
          extraArgs: ["--apply-kind", "all", "--item-numbers", String(number)],
        });
      },
    );

    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number,
        action: "kept_open",
        reason: `same-head ClawSweeper review is active until ${expiresAt}`,
      },
    ]);
    const stored = readFileSync(itemPath, "utf8");
    assert.match(stored, /^decision: keep_open$/m);
    assert.match(stored, /^action_taken: kept_open$/m);
    assert.match(stored, /^close_reason: none$/m);
    assert.doesNotMatch(stored, /^original_(?:action_taken|close_reason):/m);
    assert.equal(existsSync(join(closedDir, `${number}.md`)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

test("apply-decisions promotes old F-rated stale PRs with low-signal close semantics", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const closeAppliedBodyLogPath = join(root, "close-applied-body.log");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const staleReport = stalePullRequestReport({
      work_cluster_refs: JSON.stringify(["Related discussion in #400"]),
    }).replace(
      "## Summary\n\nThe dashboard has queue_fix_pr candidates but no generated coding plan.",
      "## Summary\n\nKeep open: this branch needs contributor follow-up before any close decision.",
    );
    const synced = reportWithSyncedReviewComment(staleReport, 330, "none");
    writeFileSync(join(itemsDir, "330.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 330,
        comment: synced.comment,
        headRunPullRequests: [],
        closeAppliedBodyLogPath,
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
      /low-signal unmergeable PR/,
    );
    assert.doesNotMatch(JSON.stringify(report), /proof should not run/);
    const promoted = readFileSync(join(closedDir, "330.md"), "utf8");
    assert.match(promoted, /^close_reason: low_signal_unmergeable_pr$/m);
    assert.match(
      promoted,
      /## Summary\n\nClose this stale PR: the latest review rated it F, it still lacks merge-ready proof, and there has been no human follow-up after the durable review\./,
    );
    assert.doesNotMatch(promoted, /## Summary\n\nKeep open:/);
    const closeAppliedBody = readFileSync(closeAppliedBodyLogPath, "utf8");
    assert.match(closeAppliedBody, /Close reason: low-signal unmergeable PR\./);
    assert.doesNotMatch(closeAppliedBody, /Keep open:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions keeps MERGEABLE UNSTABLE low-signal proposals open", () => {
  const report = runLowSignalApplyFixture({
    number: 341,
    reportOverrides: {
      item_created_at: "2026-02-01T00:00:00Z",
      item_updated_at: "2026-05-01T00:00:00Z",
      reviewed_at: "2026-05-01T00:00:00Z",
      pull_head_sha: "head-sha",
    },
    itemCreatedAt: "2026-02-01T00:00:00Z",
    itemUpdatedAt: "2026-05-01T00:00:00Z",
    mergeable: true,
    mergeableState: "unstable",
    headActivityAt: "2026-02-01T01:00:00Z",
  });

  assert.match(
    report.find((entry) => entry.action === "kept_open")?.reason ?? "",
    /requires a live merge conflict; GitHub reports mergeable=true, mergeable_state=unstable/,
  );
  assert.equal(
    report.some((entry) => entry.action === "closed"),
    false,
  );
});

test("apply-decisions rechecks low-signal liveness before writing an unsynced close comment", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const number = 371;
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const commentWriteLogPath = join(root, "comment-writes.log");
    const authorActivityAt = new Date().toISOString();
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const sourceReport = lowSignalCloseReport({
      number,
      title: "Unsynced low-signal close guard fixture",
      item_created_at: "2026-02-01T00:00:00Z",
      item_updated_at: "2026-05-01T00:00:00Z",
      reviewed_at: "2026-05-01T00:00:00Z",
      pull_head_sha: "head-sha",
    });
    const rendered = reportWithSyncedReviewComment(
      sourceReport,
      number,
      "low_signal_unmergeable_pr",
    );
    writeFileSync(join(itemsDir, `${number}.md`), sourceReport, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number,
        title: "Unsynced low-signal close guard fixture",
        comment: rendered.comment,
        commentWriteLogPath,
        comments: [],
        commentsAfterFirstRead: [
          {
            id: 9371,
            created_at: authorActivityAt,
            updated_at: authorActivityAt,
            user: { login: "reporter" },
            body: "I am still working on this PR.",
          },
        ],
        itemCreatedAt: "2026-02-01T00:00:00Z",
        itemUpdatedAt: "2026-05-01T00:00:00Z",
        mergeable: false,
        mergeableState: "dirty",
        headActivityAt: "2026-02-01T01:00:00Z",
      }),
      () => {
        runApplyDecisionsForTest({
          targetRepo: "openclaw/openclaw",
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
          extraArgs: [
            "--apply-close-reasons",
            "duplicate_or_superseded",
            "--stale-min-age-days",
            "30",
            "--processed-limit",
            "1",
            "--item-numbers",
            String(number),
          ],
        });
      },
    );

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
      number: number;
      action: string;
      reason: string;
    }>;
    assert.deepEqual(report, [
      {
        number,
        action: "kept_open",
        reason:
          "low_signal_unmergeable_pr requires 30 days without author comments or head activity",
      },
    ]);
    assert.equal(existsSync(commentWriteLogPath), false);
    assert.equal(existsSync(join(root, `comment-state-${number}.json`)), false);
    assert.match(
      readFileSync(join(itemsDir, `${number}.md`), "utf8"),
      /^action_taken: kept_open$/m,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions keeps recently updated DIRTY low-signal proposals open", () => {
  const number = 342;
  const headSha = "3423423423423423423423423423423423423423";
  const now = Date.now();
  const createdAt = new Date(now - 45 * 24 * 60 * 60 * 1000).toISOString();
  const authorActivityAt = new Date(now - 4.5 * 60 * 60 * 1000).toISOString();
  const reviewedAt = new Date(now - 4 * 60 * 60 * 1000).toISOString();
  const report = runLowSignalApplyFixture({
    number,
    reportOverrides: {
      author: "reporter",
      item_created_at: createdAt,
      item_updated_at: reviewedAt,
      reviewed_at: reviewedAt,
      pull_head_sha: headSha,
    },
    itemCreatedAt: createdAt,
    itemUpdatedAt: reviewedAt,
    headSha,
    mergeable: false,
    mergeableState: "dirty",
    headActivityAt: authorActivityAt,
    comments: (reviewComment) => [
      {
        id: 9342,
        created_at: reviewedAt,
        updated_at: reviewedAt,
        user: { login: "clawsweeper[bot]" },
        body: reviewComment,
      },
      {
        id: 9343,
        created_at: authorActivityAt,
        updated_at: authorActivityAt,
        user: { login: "reporter" },
        body: "Rebased and force-pushed the requested changes.",
      },
    ],
    timeline: [
      {
        event: "head_ref_force_pushed",
        created_at: authorActivityAt,
        actor: { login: "reporter" },
        commit_id: headSha,
      },
    ],
  });

  assert.match(
    report.find((entry) => entry.action === "kept_open")?.reason ?? "",
    /requires 30 days without author comments or head activity/,
  );
  assert.equal(
    report.some((entry) => entry.action === "closed"),
    false,
  );
});

test("apply-decisions still closes old DIRTY low-signal proposals", () => {
  const report = runLowSignalApplyFixture({
    number: 343,
    reportOverrides: {
      item_created_at: "2026-02-01T00:00:00Z",
      item_updated_at: "2026-05-01T00:00:00Z",
      reviewed_at: "2026-05-01T00:00:00Z",
      pull_head_sha: "head-sha",
    },
    itemCreatedAt: "2026-02-01T00:00:00Z",
    itemUpdatedAt: "2026-05-01T00:00:00Z",
    mergeable: false,
    mergeableState: "dirty",
    headActivityAt: "2026-02-01T01:00:00Z",
  });

  assert.match(
    report.find((entry) => entry.action === "closed")?.reason ?? "",
    /dry-run: would close as low-signal unmergeable PR/,
  );
});

test("apply-decisions fails closed without current-head activity evidence", () => {
  const report = runLowSignalApplyFixture({
    number: 345,
    reportOverrides: {
      item_created_at: "2026-02-01T00:00:00Z",
      item_updated_at: "2026-05-01T00:00:00Z",
      reviewed_at: "2026-05-01T00:00:00Z",
      pull_head_sha: "head-sha",
    },
    itemCreatedAt: "2026-02-01T00:00:00Z",
    itemUpdatedAt: "2026-05-01T00:00:00Z",
    mergeable: false,
    mergeableState: "dirty",
    headActivityAt: null,
  });

  assert.match(
    report.find((entry) => entry.action === "kept_open")?.reason ?? "",
    /requires dated activity evidence for the current head/,
  );
});

test("stale F promotion ignores recent pre-review author reviews", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const number = 344;
    const headSha = "3443443443443443443443443443443443443443";
    const now = Date.now();
    const createdAt = new Date(now - 45 * 24 * 60 * 60 * 1000).toISOString();
    const authorActivityAt = new Date(now - 4.5 * 60 * 60 * 1000).toISOString();
    const oldHeadActivityAt = new Date(now - 44 * 24 * 60 * 60 * 1000).toISOString();
    const reviewedAt = new Date(now - 4 * 60 * 60 * 1000).toISOString();
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const sourceReport = stalePullRequestReport({
      number,
      title: "Recent contributor activity before review",
      author: "reporter",
      item_created_at: createdAt,
      item_updated_at: reviewedAt,
      reviewed_at: reviewedAt,
      pull_head_sha: headSha,
    });
    const synced = reportWithSyncedReviewComment(sourceReport, number, "none");
    writeFileSync(join(itemsDir, `${number}.md`), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number,
        title: "Recent contributor activity before review",
        comment: synced.comment,
        itemCreatedAt: createdAt,
        itemUpdatedAt: reviewedAt,
        headSha,
        headActivityAt: oldHeadActivityAt,
        mergeable: false,
        mergeableState: "dirty",
        comments: [
          {
            id: 9344,
            created_at: reviewedAt,
            updated_at: reviewedAt,
            user: { login: "clawsweeper[bot]" },
            body: synced.comment,
          },
        ],
        reviews: [
          {
            id: 9345,
            submitted_at: authorActivityAt,
            user: { login: "reporter" },
            state: "COMMENTED",
          },
        ],
      }),
      () => {
        runApplyDecisionsForTest({
          targetRepo: "openclaw/openclaw",
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
          extraArgs: [
            "--dry-run",
            "--apply-kind",
            "all",
            "--apply-close-reasons",
            "low_signal_unmergeable_pr",
            "--stale-min-age-days",
            "30",
            "--item-numbers",
            String(number),
          ],
        });
      },
    );

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
      action: string;
      reason: string;
    }>;
    assert.equal(
      report.some((entry) => entry.action === "closed"),
      false,
    );
    assert.match(readFileSync(join(itemsDir, `${number}.md`), "utf8"), /^close_reason: none$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions does not persist duplicate promotion when only low-signal closes are enabled", () => {
  assertResolvedPromotionRespectsCloseReasonFilter({
    number: 338,
    applyCloseReason: "low_signal_unmergeable_pr",
    sourceFiles: ["src/runtime.ts"],
    linkedFiles: ["src/runtime.ts"],
  });
});

test("apply-decisions does not persist low-signal fallback when only duplicate closes are enabled", () => {
  assertResolvedPromotionRespectsCloseReasonFilter({
    number: 339,
    applyCloseReason: "duplicate_or_superseded",
    sourceFiles: ["docs/gateway/troubleshooting.md"],
    linkedFiles: ["src/runtime.ts"],
  });
});

test("apply-decisions does not fall through from filtered no-diff to low-signal promotion", () => {
  assertResolvedPromotionRespectsCloseReasonFilter({
    number: 340,
    applyCloseReason: "low_signal_unmergeable_pr",
    sourceFiles: [],
    noDiff: true,
  });
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
    const docsOnlyReport = stalePullRequestReport({
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
    })
      .replace("Overall tier: F", "Overall tier: D")
      .replace("Proof tier: F", "Proof tier: D")
      .replace("Patch tier: F", "Patch tier: D");
    const synced = reportWithSyncedReviewComment(docsOnlyReport, 337, "none");
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
