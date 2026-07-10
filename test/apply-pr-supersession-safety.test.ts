import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  promotionGhMock,
  reportWithSyncedReviewComment,
  runApplyDecisionsForTest,
  stalePullRequestReport,
  stripProofAndRatingFrontMatter,
  tmpPrefix,
  withMockCodexProof,
  withMockGh,
} from "./helpers.ts";

test("apply-decisions keeps promoted PR close proposals open when coverage proof fails", () => {
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
        number: 352,
        title: "Old activity PR",
        pr_rating_overall: "D",
        pr_rating_proof: "D",
        work_cluster_refs: JSON.stringify([
          "Superseded by https://github.com/openclaw/openclaw/pull/400",
        ]),
      }),
      352,
      "none",
    );
    writeFileSync(join(itemsDir, "352.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 352,
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
        withMockCodexProof(root, { type: "failure", message: "model unavailable" }, () => {
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

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
      action: string;
      reason: string;
    }>;
    assert.equal(
      report.some((entry) => entry.action === "closed"),
      false,
    );
    assert.match(
      report.find((entry) => entry.action === "retry_pr_close_coverage_proof")?.reason ?? "",
      /PR close coverage proof failed/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions promotes PRs superseded by merged linked pull requests without proof labels", () => {
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
        title: "Old merged-replacement PR",
        pr_rating_overall: "D",
        pr_rating_proof: "D",
        work_cluster_refs: JSON.stringify([
          "Superseded by https://github.com/openclaw/openclaw/pull/400",
        ]),
      }),
      333,
      "none",
    );
    writeFileSync(join(itemsDir, "333.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 333,
        title: "Old merged-replacement PR",
        comment: synced.comment,
        linkedPulls: {
          400: {
            number: 400,
            title: "Merged canonical PR",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "closed",
            merged_at: "2026-05-02T00:00:00Z",
            mergeable_state: "dirty",
            labels: ["status: needs proof", "rating: unranked krab"],
          },
        },
      }),
      () => {
        withMockCodexProof(
          root,
          {
            type: "decision",
            decision: "covered",
            reason: "PR B is the merged canonical PR covering PR A.",
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions does not promote PRs superseded by no-proof linked pull requests", () => {
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
              "--apply-close-reasons",
              "low_signal_unmergeable_pr",
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
    assert.equal(
      report.some((entry) => entry.action === "kept_open"),
      true,
    );
    assert.doesNotMatch(JSON.stringify(report), /proof should not run/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions does not promote PRs superseded by unsafe linked pull requests", () => {
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

test("apply-decisions does not promote PRs superseded by F-rated linked pull requests", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
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

test("apply-decisions promotes PRs when a proof-backed canonical PR is behind", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const sourceReport = stalePullRequestReport({
      number: 342,
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
    const synced = reportWithSyncedReviewComment(sourceReport, 342, "none");
    writeFileSync(join(itemsDir, "342.md"), synced.report, "utf8");
    writeFileSync(
      join(itemsDir, "400.md"),
      stalePullRequestReport({
        number: 400,
        title: "Canonical PR with stale proof report",
        labels: JSON.stringify(["status: needs proof"]),
        pr_rating_overall: "D",
        pr_rating_proof: "D",
        pr_rating_patch: "D",
      }).replace(
        "Overall tier: F\nProof tier: F\nPatch tier: F",
        "Overall tier: D\nProof tier: D\nPatch tier: D",
      ),
      "utf8",
    );

    withMockGh(
      root,
      promotionGhMock({
        number: 342,
        title: "Old activity PR",
        comment: synced.comment,
        linkedPulls: {
          400: {
            number: 400,
            title: "Canonical PR with live proof label",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "open",
            merged_at: null,
            mergeable_state: "behind",
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
            reason: "PR B is the live proof-backed canonical PR covering PR A.",
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
                "--item-numbers",
                "342",
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
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
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

test("apply-decisions does not promote PRs superseded by non-clean linked pull requests", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
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
