import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  lowSignalCloseReport,
  promotionGhMock,
  reportWithSyncedReviewComment,
  runApplyDecisionsForTest,
  stalePullRequestReport,
  tmpPrefix,
  withMockGh,
} from "./helpers.ts";

function recentItemCreatedAt() {
  // These cases isolate relationship classification, so keep age-based stale
  // promotion out of scope without a calendar date that eventually expires.
  return new Date().toISOString();
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
        itemCreatedAt: recentItemCreatedAt(),
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
        itemCreatedAt: recentItemCreatedAt(),
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
