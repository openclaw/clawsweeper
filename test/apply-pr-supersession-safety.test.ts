import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  promotionGhMock,
  reportWithSyncedReviewComment,
  runApplyDecisionsForTest,
  runOpenClawApplyDecisionsForTest,
  stalePullRequestReport,
  stripProofAndRatingFrontMatter,
  tmpPrefix,
  withApplyTestWorkspace,
  withMockCodexProof,
  withMockGh,
} from "./helpers.ts";

for (const syncCommentsOnly of [false, true]) {
  for (const [name, mergedAt, reference, mergeableState] of [
    ["open replacement", null, "[replacement PR]", "clean"],
    ["behind replacement", null, "[replacement PR]", "behind"],
    ["merged replacement", "2026-05-02T00:00:00Z", "[replacement PR]", "clean"],
    ["related canonical work", "2026-05-02T00:00:00Z", "[Related canonical record work]", "clean"],
  ] as const) {
    test(`apply-decisions preserves keep-open review with ${name} (comments-only=${syncCommentsOnly})`, () => {
      const root = mkdtempSync(tmpPrefix);
      try {
        const itemsDir = join(root, "items");
        const closedDir = join(root, "closed");
        const plansDir = join(root, "plans");
        const reportPath = join(root, "apply-report.json");
        const proofLogPath = join(root, "proof.log");
        const closeLogPath = join(root, "close.log");
        mkdirSync(itemsDir, { recursive: true });
        const synced = reportWithSyncedReviewComment(
          stalePullRequestReport({
            number: 333,
            title: "Keep this distinct change open",
            pr_rating_overall: "D",
            pr_rating_proof: "D",
            pr_rating_patch: "D",
            work_cluster_refs: JSON.stringify([
              `${reference}(https://github.com/openclaw/openclaw/pull/400)`,
            ]),
          }).replaceAll("tier: F", "tier: D"),
          333,
          "none",
        );
        const itemPath = join(itemsDir, "333.md");
        writeFileSync(itemPath, synced.report, "utf8");
        withMockGh(
          root,
          promotionGhMock({
            number: 333,
            title: "Keep this distinct change open",
            comment: synced.comment,
            closeCommandLogPath: closeLogPath,
            linkedPulls: {
              400: {
                number: 400,
                title: "Related work",
                html_url: "https://github.com/openclaw/openclaw/pull/400",
                state: mergedAt ? "closed" : "open",
                merged_at: mergedAt,
                mergeable_state: mergeableState,
                labels: mergedAt ? [] : ["proof: sufficient"],
              },
            },
          }),
          () =>
            withMockCodexProof(
              root,
              {
                type: "failure",
                message: "keep-open must not start close coverage proof",
                invocationLogPath: proofLogPath,
              },
              () =>
                runApplyDecisionsForTest({
                  itemsDir,
                  closedDir,
                  plansDir,
                  reportPath,
                  extraArgs: [
                    "--target-repo",
                    "openclaw/openclaw",
                    "--skip-dashboard",
                    "--item-number",
                    "333",
                    "--apply-kind",
                    "all",
                    ...(syncCommentsOnly
                      ? ["--sync-comments-only", "--comment-sync-min-age-days", "0"]
                      : []),
                  ],
                }),
            ),
        );
        const persisted = readFileSync(itemPath, "utf8");
        assert.match(persisted, /^decision: keep_open$/m);
        assert.match(persisted, /^action_taken: kept_open$/m);
        assert.match(persisted, /^close_reason: none$/m);
        assert.doesNotMatch(
          persisted,
          /Close this PR as superseded|I’m closing this PR as superseded/,
        );
        const commentPath = join(root, "comment-state-333.json");
        const comment = existsSync(commentPath)
          ? JSON.parse(readFileSync(commentPath, "utf8")).body
          : synced.comment;
        assert.doesNotMatch(
          comment,
          /Close this PR as superseded|I’m closing this PR as superseded/,
        );
        assert.equal(existsSync(proofLogPath), false);
        assert.equal(existsSync(closeLogPath), false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

test("apply-decisions does not promote PRs superseded by no-proof linked pull requests", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const proofLogPath = join(root, "proof.log");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const synced = reportWithSyncedReviewComment(
      stalePullRequestReport({
        number: 334,
        title: "Old activity PR",
        pr_rating_overall: "D",
        pr_rating_proof: "D",
        work_cluster_refs: JSON.stringify([
          "Superseded by https://github.com/openclaw/openclaw/pull/400",
        ]),
      }),
      334,
      "none",
    );
    writeFileSync(join(itemsDir, "334.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 334,
        title: "Old activity PR",
        comment: synced.comment,
        linkedPulls: {
          400: {
            number: 400,
            title: "Canonical activity PR without proof",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "open",
            merged_at: null,
            mergeable_state: "clean",
          },
        },
      }),
      () => {
        withMockCodexProof(
          root,
          {
            type: "failure",
            message: "proof should not run",
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
                "--apply-close-reasons",
                "low_signal_unmergeable_pr",
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
    }>;
    assert.equal(report.length, 1);
    assert.equal(report[0]?.number, 334);
    // Refreshing review presentation does not promote the keep-open decision.
    assert.ok(
      ["kept_open", "review_comment_synced"].includes(report[0]?.action ?? ""),
      JSON.stringify(report),
    );
    const persisted = readFileSync(join(itemsDir, "334.md"), "utf8");
    assert.match(persisted, /^decision: keep_open$/m);
    assert.match(persisted, /^action_taken: kept_open$/m);
    assert.match(persisted, /^close_reason: none$/m);
    assert.equal(existsSync(proofLogPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions does not promote PRs superseded by unsafe linked pull requests", () => {
  withApplyTestWorkspace(tmpPrefix, ({ root, itemsDir, closedDir, plansDir, reportPath }) => {
    const synced = reportWithSyncedReviewComment(
      stalePullRequestReport({
        number: 335,
        title: "Old activity PR",
        pr_rating_overall: "D",
        pr_rating_proof: "D",
        work_cluster_refs: JSON.stringify([
          "Superseded by https://github.com/openclaw/openclaw/pull/400",
        ]),
      }),
      335,
      "none",
    );
    writeFileSync(join(itemsDir, "335.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 335,
        title: "Old activity PR",
        comment: synced.comment,
        linkedPulls: {
          400: {
            number: 400,
            title: "Unsafe canonical PR",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "open",
            merged_at: null,
            mergeable_state: "clean",
            labels: ["triage: needs-real-behavior-proof", "status: 📣 needs proof"],
          },
        },
      }),
      () => {
        withMockCodexProof(root, { type: "failure", message: "proof should not run" }, () => {
          runOpenClawApplyDecisionsForTest({
            itemsDir,
            closedDir,
            plansDir,
            reportPath,
            dryRun: true,
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
  });
});

test("apply-decisions does not promote PRs superseded by F-rated linked pull requests", () => {
  withApplyTestWorkspace(tmpPrefix, ({ root, itemsDir, closedDir, plansDir, reportPath }) => {
    const sourceReport = stalePullRequestReport({
      number: 338,
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
    const synced = reportWithSyncedReviewComment(sourceReport, 338, "none");
    writeFileSync(join(itemsDir, "338.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 338,
        title: "Old activity PR",
        comment: synced.comment,
        linkedPulls: {
          400: {
            number: 400,
            title: "F-rated canonical PR",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "open",
            merged_at: null,
            mergeable_state: "clean",
            labels: ["proof: sufficient", "rating: unranked krab"],
          },
        },
      }),
      () => {
        withMockCodexProof(root, { type: "failure", message: "proof should not run" }, () => {
          runOpenClawApplyDecisionsForTest({
            itemsDir,
            closedDir,
            plansDir,
            reportPath,
            dryRun: true,
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
  });
});

test("apply-decisions does not promote PRs superseded by section-only unsafe linked reports", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const sourceReport = stalePullRequestReport({
      number: 340,
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
    const synced = reportWithSyncedReviewComment(sourceReport, 340, "none");
    writeFileSync(join(itemsDir, "340.md"), synced.report, "utf8");
    writeFileSync(
      join(itemsDir, "400.md"),
      stripProofAndRatingFrontMatter(
        stalePullRequestReport({
          number: 400,
          title: "Canonical PR with old section-only blockers",
          labels: JSON.stringify([]),
        }),
      ),
      "utf8",
    );

    withMockGh(
      root,
      promotionGhMock({
        number: 340,
        title: "Old activity PR",
        comment: synced.comment,
        linkedPulls: {
          400: {
            number: 400,
            title: "Canonical PR with old section-only blockers",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "open",
            merged_at: null,
            mergeable_state: "clean",
            labels: [],
          },
        },
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
              "--item-numbers",
              "340",
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

test("apply-decisions does not promote PRs when live labels supersede stale proof reports", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const sourceReport = stalePullRequestReport({
      number: 344,
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
    const synced = reportWithSyncedReviewComment(sourceReport, 344, "none");
    writeFileSync(join(itemsDir, "344.md"), synced.report, "utf8");
    writeFileSync(
      join(itemsDir, "400.md"),
      stalePullRequestReport({
        number: 400,
        title: "Canonical PR with stale sufficient proof report",
        labels: JSON.stringify(["proof: sufficient"]),
        pr_rating_overall: "D",
        pr_rating_proof: "D",
        pr_rating_patch: "D",
      })
        .replace("Status: missing", "Status: sufficient")
        .replace(
          "Overall tier: F\nProof tier: F\nPatch tier: F",
          "Overall tier: D\nProof tier: D\nPatch tier: D",
        ),
      "utf8",
    );

    withMockGh(
      root,
      promotionGhMock({
        number: 344,
        title: "Old activity PR",
        comment: synced.comment,
        linkedPulls: {
          400: {
            number: 400,
            title: "Canonical PR with current needs-proof labels",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "open",
            merged_at: null,
            mergeable_state: "clean",
            labels: ["triage: needs-real-behavior-proof", "status: needs proof"],
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
            "344",
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

test("apply-decisions does not promote PRs superseded by unknown-mergeability PRs", () => {
  withApplyTestWorkspace(tmpPrefix, ({ root, itemsDir, closedDir, plansDir, reportPath }) => {
    const sourceReport = stalePullRequestReport({
      number: 343,
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
    const synced = reportWithSyncedReviewComment(sourceReport, 343, "none");
    writeFileSync(join(itemsDir, "343.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 343,
        title: "Old activity PR",
        comment: synced.comment,
        linkedPulls: {
          400: {
            number: 400,
            title: "Canonical PR still computing mergeability",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "open",
            merged_at: null,
            mergeable_state: null,
            labels: ["proof: sufficient"],
          },
        },
      }),
      () => {
        runOpenClawApplyDecisionsForTest({
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
          dryRun: true,
        });
      },
    );

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{ action: string }>;
    assert.equal(
      report.some((entry) => entry.action === "closed"),
      false,
    );
  });
});

test("apply-decisions does not promote PRs superseded by non-clean linked pull requests", () => {
  withApplyTestWorkspace(tmpPrefix, ({ root, itemsDir, closedDir, plansDir, reportPath }) => {
    const sourceReport = stalePullRequestReport({
      number: 345,
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
    const synced = reportWithSyncedReviewComment(sourceReport, 345, "none");
    writeFileSync(join(itemsDir, "345.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 345,
        title: "Old activity PR",
        comment: synced.comment,
        linkedPulls: {
          400: {
            number: 400,
            title: "Blocked canonical PR",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "open",
            merged_at: null,
            mergeable_state: "blocked",
            labels: ["proof: sufficient"],
          },
        },
      }),
      () => {
        runOpenClawApplyDecisionsForTest({
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
          dryRun: true,
        });
      },
    );

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{ action: string }>;
    assert.equal(
      report.some((entry) => entry.action === "closed"),
      false,
    );
  });
});
