import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  lowSignalCloseReport,
  promotionGhMock,
  reportWithSyncedReviewComment,
  runApplyDecisionsForTest,
  tmpPrefix,
  withMockCodexProof,
  withMockGh,
} from "./helpers.ts";

test("apply-decisions ignores bare refs inside cross-repo markdown link labels for duplicate proof", () => {
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
      lowSignalCloseReport({
        number: 357,
        title: "Provider route fallback",
        close_reason: "duplicate_or_superseded",
        work_cluster_refs: JSON.stringify([
          "Superseded by [PR #400](https://github.com/other/repo/pull/400)",
        ]),
      }).replace(
        "Closing this PR because the branch is not a useful landing base.",
        "Closing this PR as superseded by the linked external PR.",
      ),
      357,
      "duplicate_or_superseded",
    );
    writeFileSync(join(itemsDir, "357.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 357,
        title: "Provider route fallback",
        comment: synced.comment,
        linkedPulls: {
          400: {
            number: 400,
            title: "Unrelated same-repo PR",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "closed",
            merged_at: "2026-05-02T00:00:00Z",
            body: "Unrelated provider cleanup.",
            comments: [],
            labels: [],
          },
        },
      }),
      () => {
        withMockCodexProof(
          root,
          {
            type: "failure",
            message: "coverage proof should not run for cross-repo markdown link labels",
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

    assert.equal(existsSync(proofLogPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions ignores bare refs inside same-repo markdown link labels for duplicate proof", () => {
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
      lowSignalCloseReport({
        number: 358,
        title: "Provider route fallback",
        close_reason: "duplicate_or_superseded",
        work_cluster_refs: JSON.stringify([
          "Superseded by [fixes #123](https://github.com/openclaw/openclaw/pull/400)",
        ]),
      }).replace(
        "Closing this PR because the branch is not a useful landing base.",
        "Closing this PR as superseded by the linked canonical PR.",
      ),
      358,
      "duplicate_or_superseded",
    );
    writeFileSync(join(itemsDir, "358.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 358,
        title: "Provider route fallback",
        comment: synced.comment,
        linkedPulls: {
          123: {
            number: 123,
            title: "Unrelated draft PR",
            html_url: "https://github.com/openclaw/openclaw/pull/123",
            state: "open",
            merged_at: null,
            mergeable_state: "clean",
            draft: true,
            body: "Unrelated provider cleanup.",
            comments: [],
            labels: [],
          },
          400: {
            number: 400,
            title: "Canonical provider replacement",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "closed",
            merged_at: "2026-05-02T00:00:00Z",
            body: "Covers the provider route fallback behavior.",
            comments: [],
            labels: [],
          },
        },
      }),
      () => {
        withMockCodexProof(
          root,
          {
            type: "decision",
            decision: "keep_open",
            reason: "PR A still has unique fallback route behavior that PR B does not cover.",
            invocationLogPath: proofLogPath,
            expectedPromptIncludes: "Canonical provider replacement",
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
    assert.equal(
      report.find((entry) => entry.number === 358)?.action,
      "skipped_pr_close_coverage_proof",
    );
    assert.match(readFileSync(proofLogPath, "utf8"), /proof/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions keeps newline-start bare PR refs tied to their own line", () => {
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
      lowSignalCloseReport({
        number: 358,
        title: "Provider route fallback",
        close_reason: "duplicate_or_superseded",
        work_cluster_refs: JSON.stringify(["Links:\n#400 supersedes this PR and #500 is related"]),
      }).replace(
        "Closing this PR because the branch is not a useful landing base.",
        "Closing this PR as superseded by the linked canonical PR.",
      ),
      358,
      "duplicate_or_superseded",
    );
    writeFileSync(join(itemsDir, "358.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 358,
        title: "Provider route fallback",
        comment: synced.comment,
        linkedPulls: {
          400: {
            number: 400,
            title: "Provider cleanup",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "closed",
            merged_at: "2026-05-02T00:00:00Z",
            body: "Cleans up provider setup without changing the fallback route.",
            comments: [],
            labels: [],
          },
        },
        linkedIssues: {
          500: {
            number: 500,
            title: "Related provider issue",
            html_url: "https://github.com/openclaw/openclaw/issues/500",
            state: "open",
            labels: [],
          },
        },
      }),
      () => {
        withMockCodexProof(
          root,
          {
            type: "decision",
            decision: "keep_open",
            reason: "PR A still has unique fallback route behavior that PR B does not cover.",
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
      false,
    );
    assert.equal(
      report.find((entry) => entry.number === 358)?.action,
      "skipped_pr_close_coverage_proof",
    );
    assert.match(readFileSync(proofLogPath, "utf8"), /proof/);
    assert.match(
      report.find((entry) => entry.number === 358)?.reason ?? "",
      /unique fallback route behavior/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions ignores unrelated same-line bare PR refs for duplicate proof", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const synced = reportWithSyncedReviewComment(
      lowSignalCloseReport({
        number: 361,
        title: "Provider route fallback",
        close_reason: "duplicate_or_superseded",
        work_cluster_refs: JSON.stringify(["Superseded by #400; #500 is related"]),
      }).replace(
        "Closing this PR because the branch is not a useful landing base.",
        "Closing this PR as superseded by the linked canonical PR.",
      ),
      361,
      "duplicate_or_superseded",
    );
    writeFileSync(join(itemsDir, "361.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 361,
        title: "Provider route fallback",
        comment: synced.comment,
        linkedPulls: {
          400: {
            number: 400,
            title: "Provider cleanup",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "closed",
            merged_at: "2026-05-02T00:00:00Z",
            body: "Includes the fallback route behavior from PR 361.",
            comments: [],
            labels: [],
          },
          500: {
            number: 500,
            title: "Related draft PR",
            html_url: "https://github.com/openclaw/openclaw/pull/500",
            state: "open",
            merged_at: null,
            mergeable_state: "clean",
            draft: true,
            labels: [],
          },
        },
      }),
      () => {
        withMockCodexProof(
          root,
          {
            type: "decision",
            decision: "covered",
            reason: "PR B carries forward PR A's fallback route behavior.",
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
      JSON.stringify(report),
    );
    assert.match(
      report.find((entry) => entry.action === "closed")?.reason ?? "",
      /duplicate or superseded/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const scenario of [
  { name: "and", number: 364, refs: "#400 and #401" },
  { name: "comma", number: 365, refs: "#400, #401" },
  { name: "semicolon", number: 366, refs: "#400; #401" },
  { name: "comma and and", number: 367, refs: "#400, #401, and #402" },
  {
    name: "markdown links",
    number: 368,
    refs: "[first](https://github.com/openclaw/openclaw/pull/400), [second](https://github.com/openclaw/openclaw/pull/401)",
  },
]) {
  test(`apply-decisions preserves supersession context across shorthand PR ref lists with ${scenario.name}`, () => {
    const root = mkdtempSync(tmpPrefix);
    try {
      const itemsDir = join(root, "items");
      const closedDir = join(root, "closed");
      const plansDir = join(root, "plans");
      const reportPath = join(root, "apply-report.json");
      mkdirSync(itemsDir, { recursive: true });
      mkdirSync(plansDir, { recursive: true });
      const synced = reportWithSyncedReviewComment(
        lowSignalCloseReport({
          number: scenario.number,
          title: "Provider route fallback",
          close_reason: "duplicate_or_superseded",
          work_cluster_refs: JSON.stringify([`Superseded by ${scenario.refs}`]),
        }).replace(
          "Closing this PR because the branch is not a useful landing base.",
          "Closing this PR as superseded by the linked canonical PRs.",
        ),
        scenario.number,
        "duplicate_or_superseded",
      );
      writeFileSync(join(itemsDir, `${scenario.number}.md`), synced.report, "utf8");

      withMockGh(
        root,
        promotionGhMock({
          number: scenario.number,
          title: "Provider route fallback",
          comment: synced.comment,
          linkedPulls: {
            400: {
              number: 400,
              title: "Initial provider cleanup",
              html_url: "https://github.com/openclaw/openclaw/pull/400",
              state: "closed",
              merged_at: "2026-05-01T00:00:00Z",
              body: "Cleans up provider setup without changing the fallback route.",
              comments: [],
              labels: [],
            },
            401: {
              number: 401,
              title: "Provider cleanup",
              html_url: "https://github.com/openclaw/openclaw/pull/401",
              state: "closed",
              merged_at: "2026-05-02T00:00:00Z",
              body: `Includes the fallback route behavior from PR ${scenario.number}.`,
              comments: [],
              labels: [],
            },
            402: {
              number: 402,
              title: "Later provider cleanup",
              html_url: "https://github.com/openclaw/openclaw/pull/402",
              state: "closed",
              merged_at: "2026-05-03T00:00:00Z",
              body: "Follow-up provider cleanup.",
              comments: [],
              labels: [],
            },
          },
        }),
        () => {
          withMockCodexProof(
            root,
            {
              type: "decision",
              decision: "keep_open",
              reason: "PR B carries forward PR A's fallback route behavior.",
              keepOpenPromptIncludes:
                "Cleans up provider setup without changing the fallback route.",
              coveredPromptIncludes: `Includes the fallback route behavior from PR ${scenario.number}.`,
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
        JSON.stringify(report),
      );
      assert.match(
        report.find((entry) => entry.action === "closed")?.reason ?? "",
        /duplicate or superseded/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("apply-decisions does not proof-gate duplicate PR closes with bare issue refs", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const synced = reportWithSyncedReviewComment(
      lowSignalCloseReport({
        number: 357,
        title: "Provider route fallback",
        close_reason: "duplicate_or_superseded",
        work_cluster_refs: JSON.stringify(["Duplicate of #456"]),
      }).replace(
        "Closing this PR because the branch is not a useful landing base.",
        "Closing this PR as a duplicate of canonical issue #456.",
      ),
      357,
      "duplicate_or_superseded",
    );
    writeFileSync(join(itemsDir, "357.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 357,
        title: "Provider route fallback",
        comment: synced.comment,
        linkedIssues: {
          456: {
            number: 456,
            title: "Provider fallback tracker",
            html_url: "https://github.com/openclaw/openclaw/issues/456",
            state: "open",
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
      true,
    );
    assert.equal(JSON.stringify(report).includes("proof should not run"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions preserves full PR URL evidence over later bare refs", () => {
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
      lowSignalCloseReport({
        number: 348,
        title: "Already proposed duplicate close",
        close_reason: "duplicate_or_superseded",
        work_cluster_refs: JSON.stringify([
          "Superseded by https://github.com/openclaw/openclaw/pull/400",
        ]),
      }).replace(
        "Closing this PR because the branch is not a useful landing base.",
        "Closing this PR as superseded by https://github.com/openclaw/openclaw/pull/400.\nLater issue discussion also mentions #400.",
      ),
      348,
      "duplicate_or_superseded",
    );
    writeFileSync(join(itemsDir, "348.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 348,
        title: "Already proposed duplicate close",
        comment: synced.comment,
        linkedIssues: {
          400: {
            number: 400,
            title: "Issue with same number",
            html_url: "https://github.com/openclaw/openclaw/issues/400",
            state: "open",
            comments: [],
            labels: [],
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
      false,
    );
    assert.match(
      report.find((entry) => entry.action === "retry_pr_close_coverage_proof")?.reason ?? "",
      /linked canonical PR #400 could not be read/,
    );
    assert.equal(existsSync(proofLogPath), false);
    assert.equal(existsSync(join(closedDir, "348.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
