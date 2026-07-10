import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  lowSignalCloseReport,
  markedReviewCommentForTest,
  promotionGhMock,
  reportWithSyncedReviewComment,
  runApplyDecisionsForTest,
  tmpPrefix,
  withMockCodexProof,
  withMockGh,
} from "./helpers.ts";

test("apply-decisions skips stale close reports before duplicate PR coverage proof", () => {
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
        number: 353,
        title: "Stale duplicate close report",
        reviewed_at: "2026-05-01T00:00:00Z",
        close_reason: "duplicate_or_superseded",
        work_cluster_refs: JSON.stringify([
          "Superseded by https://github.com/openclaw/openclaw/pull/400",
        ]),
      }).replace(
        "Closing this PR because the branch is not a useful landing base.",
        "Closing this PR as superseded by https://github.com/openclaw/openclaw/pull/400.",
      ),
      353,
      "duplicate_or_superseded",
    );
    writeFileSync(join(itemsDir, "353.md"), synced.report, "utf8");
    const newerComment = markedReviewCommentForTest(
      353,
      [
        "Codex review: ready for maintainer look.",
        "",
        "<!-- clawsweeper-verdict:needs-human item=353 sha=head-sha confidence=high updated_at=2026-05-01T00:05:00Z reviewed_at=2026-05-01T00:10:00Z source_revision=new-source -->",
      ].join("\n"),
    );

    withMockGh(
      root,
      promotionGhMock({
        number: 353,
        title: "Stale duplicate close report",
        comment: newerComment,
        linkedPulls: {
          400: {
            number: 400,
            title: "Canonical replacement",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "closed",
            merged_at: "2026-05-02T00:00:00Z",
            body: "Carries the replacement behavior.",
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
            decision: "covered",
            reason: "The replacement carries the source behavior.",
            invocationLogPath: proofLogPath,
          },
          () => {
            runApplyDecisionsForTest({
              itemsDir,
              closedDir,
              plansDir,
              reportPath,
              extraArgs: ["--target-repo", "openclaw/openclaw", "--apply-kind", "all"],
            });
          },
        );
      },
    );

    assert.equal(existsSync(proofLogPath), false);
    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 353,
        action: "skipped_stale_review_comment_sync",
        reason:
          "live durable review comment is newer than the local report: comment reviewed_at=2026-05-01T00:10:00Z, report reviewed_at=2026-05-01T00:00:00Z; comment head=head-sha, report head=missing",
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions checks duplicate PR coverage proof before syncing corrected review comments", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const commentWriteLogPath = join(root, "comment-writes.log");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const reportMarkdown = lowSignalCloseReport({
      number: 354,
      title: "Unsynced duplicate close",
      close_reason: "duplicate_or_superseded",
      work_cluster_refs: JSON.stringify([
        "Superseded by https://github.com/openclaw/openclaw/pull/400",
      ]),
    }).replace(
      "Closing this PR because the branch is not a useful landing base.",
      "Closing this PR as superseded by https://github.com/openclaw/openclaw/pull/400.",
    );
    writeFileSync(join(itemsDir, "354.md"), reportMarkdown, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 354,
        title: "Unsynced duplicate close",
        comment: "",
        comments: [],
        issueCommentCount: 0,
        commentWriteLogPath,
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
      }),
      () => {
        withMockCodexProof(
          root,
          {
            type: "decision",
            decision: "keep_open",
            reason: "PR A still has unique fallback route behavior that PR B does not cover.",
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
      report.some((entry) => entry.action === "review_comment_synced"),
      false,
    );
    assert.equal(
      report.find((entry) => entry.number === 354)?.action,
      "skipped_pr_close_coverage_proof",
    );
    assert.match(
      report.find((entry) => entry.number === 354)?.reason ?? "",
      /unique fallback route behavior/,
    );
    assert.match(readFileSync(commentWriteLogPath, "utf8"), /issues\/354\/comments/);
    const blockedReport = readFileSync(join(itemsDir, "354.md"), "utf8");
    assert.match(blockedReport, /^decision: keep_open$/m);
    assert.match(blockedReport, /^review_comment_synced_at:/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions closes existing duplicate PR close proposals when coverage proof says covered", () => {
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
        number: 349,
        title: "Provider route fallback",
        close_reason: "duplicate_or_superseded",
        work_cluster_refs: JSON.stringify([
          "Superseded by https://github.com/openclaw/openclaw/pull/400",
        ]),
      }).replace(
        "Closing this PR because the branch is not a useful landing base.",
        "Closing this PR as superseded by https://github.com/openclaw/openclaw/pull/400.",
      ),
      349,
      "duplicate_or_superseded",
    );
    writeFileSync(join(itemsDir, "349.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 349,
        title: "Provider route fallback",
        comment: synced.comment,
        linkedPulls: {
          400: {
            number: 400,
            title: "Provider cleanup",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "closed",
            merged_at: "2026-05-02T00:00:00Z",
            body: "Includes the fallback route behavior from PR 349.",
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
    );
    assert.match(
      report.find((entry) => entry.action === "closed")?.reason ?? "",
      /duplicate or superseded/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions records successful duplicate PR coverage proof for closed PRs", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const closeAppliedBodyLogPath = join(root, "close-applied-body.log");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const synced = reportWithSyncedReviewComment(
      lowSignalCloseReport({
        number: 360,
        title: "Provider route fallback",
        close_reason: "duplicate_or_superseded",
        work_cluster_refs: JSON.stringify([
          "Superseded by https://github.com/openclaw/openclaw/pull/400",
        ]),
      }).replace(
        "Closing this PR because the branch is not a useful landing base.",
        "Closing this PR as superseded by https://github.com/openclaw/openclaw/pull/400.",
      ),
      360,
      "duplicate_or_superseded",
    );
    writeFileSync(join(itemsDir, "360.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 360,
        title: "Provider route fallback",
        comment: synced.comment,
        closeAppliedBodyLogPath,
        linkedPulls: {
          400: {
            number: 400,
            title: "Provider cleanup",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "closed",
            merged_at: "2026-05-02T00:00:00Z",
            body: "Includes the fallback route behavior from PR 360.",
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

    const closedReport = readFileSync(join(closedDir, "360.md"), "utf8");
    assert.match(closedReport, /## PR Close Coverage Proof/);
    assert.match(closedReport, /Reason: PR B carries forward PR A's fallback route behavior\./);
    const closeAppliedBody = readFileSync(closeAppliedBodyLogPath, "utf8");
    assert.match(
      closeAppliedBody,
      /Coverage proof: PR B carries forward PR A's fallback route behavior\./,
    );
    assert.match(
      closeAppliedBody,
      /Covering PR: https:\/\/github\.com\/openclaw\/openclaw\/pull\/400\./,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions consumes a bound precomputed proof without invoking Codex", () => {
  const root = mkdtempSync(tmpPrefix);
  const originalCodexBin = process.env.CODEX_BIN;
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const artifactDir = join(root, "proof-artifacts");
    const proofLogPath = join(root, "proof.log");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const synced = reportWithSyncedReviewComment(
      lowSignalCloseReport({
        number: 361,
        title: "Provider route fallback",
        close_reason: "duplicate_or_superseded",
        work_cluster_refs: JSON.stringify([
          "Superseded by https://github.com/openclaw/openclaw/pull/400",
        ]),
      }).replace(
        "Closing this PR because the branch is not a useful landing base.",
        "Closing this PR as superseded by https://github.com/openclaw/openclaw/pull/400.",
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
            updated_at: "2026-05-01T00:00:00Z",
            body: "Includes the fallback route behavior from PR 361.",
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
            decision: "covered",
            reason: "PR B carries forward PR A's fallback route behavior.",
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
                "--artifact-dir",
                artifactDir,
                "--dry-run",
                "--apply-kind",
                "all",
                "--processed-limit",
                "3",
              ],
            });
          },
        );

        assert.equal(readFileSync(proofLogPath, "utf8"), "proof\n");
        assert.equal(
          existsSync(join(artifactDir, "pr-close-coverage-proof", "361-400.proof.json")),
          true,
        );
        process.env.CODEX_BIN = join(root, "codex-must-not-run");
        writeFileSync(
          join(itemsDir, "361.md"),
          synced.report.replace(
            "Superseded by https://github.com/openclaw/openclaw/pull/400",
            "Fixed by https://github.com/openclaw/openclaw/pull/400",
          ),
          "utf8",
        );
        runApplyDecisionsForTest({
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
          extraArgs: [
            "--target-repo",
            "openclaw/openclaw",
            "--artifact-dir",
            artifactDir,
            "--require-precomputed-pr-close-coverage-proof",
            "--apply-kind",
            "all",
            "--processed-limit",
            "3",
          ],
        });
        const staleInputReport = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
          action: string;
          reason: string;
        }>;
        assert.equal(
          staleInputReport.some((entry) => entry.action === "closed"),
          false,
        );
        assert.match(staleInputReport[0]?.reason ?? "", /prompt snapshot is stale/);

        writeFileSync(join(itemsDir, "361.md"), synced.report, "utf8");
        runApplyDecisionsForTest({
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
          extraArgs: [
            "--target-repo",
            "openclaw/openclaw",
            "--artifact-dir",
            artifactDir,
            "--require-precomputed-pr-close-coverage-proof",
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
    assert.equal(existsSync(join(closedDir, "361.md")), true);
    assert.equal(readFileSync(proofLogPath, "utf8"), "proof\n");
  } finally {
    if (originalCodexBin === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = originalCodexBin;
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions bounds proof envelopes for reports with many canonical PR refs", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const artifactDir = join(root, "proof-artifacts");
    const proofLogPath = join(root, "proof.log");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const coveringNumbers = [400, 401, 402, 403, 404];
    const synced = reportWithSyncedReviewComment(
      lowSignalCloseReport({
        number: 365,
        title: "Provider route fallback",
        close_reason: "duplicate_or_superseded",
        work_cluster_refs: JSON.stringify(
          coveringNumbers.map(
            (number) => `Superseded by https://github.com/openclaw/openclaw/pull/${number}`,
          ),
        ),
      }).replace(
        "Closing this PR because the branch is not a useful landing base.",
        "Closing this PR as superseded by the linked canonical pull requests.",
      ),
      365,
      "duplicate_or_superseded",
    );
    writeFileSync(join(itemsDir, "365.md"), synced.report, "utf8");
    const linkedPulls = Object.fromEntries(
      coveringNumbers.map((number) => [
        number,
        {
          number,
          title: `Provider cleanup ${number}`,
          html_url: `https://github.com/openclaw/openclaw/pull/${number}`,
          state: "closed",
          merged_at: "2026-05-02T00:00:00Z",
          updated_at: "2026-05-01T00:00:00Z",
          body: `Provider cleanup candidate ${number}.`,
          comments: [],
          labels: [],
        },
      ]),
    );

    withMockGh(
      root,
      promotionGhMock({
        number: 365,
        title: "Provider route fallback",
        comment: synced.comment,
        linkedPulls,
      }),
      () => {
        withMockCodexProof(
          root,
          {
            type: "decision",
            decision: "keep_open",
            reason: "The source still contains unique provider route behavior.",
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
                "--artifact-dir",
                artifactDir,
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

    assert.equal(readFileSync(proofLogPath, "utf8").trim().split("\n").length, 4);
    const proofFiles = readdirSync(join(artifactDir, "pr-close-coverage-proof")).filter((name) =>
      name.endsWith(".proof.json"),
    );
    assert.equal(proofFiles.length, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions fails closed when a required precomputed proof is missing", () => {
  const root = mkdtempSync(tmpPrefix);
  const originalCodexBin = process.env.CODEX_BIN;
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const synced = reportWithSyncedReviewComment(
      lowSignalCloseReport({
        number: 362,
        title: "Provider route fallback",
        close_reason: "duplicate_or_superseded",
        work_cluster_refs: JSON.stringify([
          "Superseded by https://github.com/openclaw/openclaw/pull/400",
        ]),
      }).replace(
        "Closing this PR because the branch is not a useful landing base.",
        "Closing this PR as superseded by https://github.com/openclaw/openclaw/pull/400.",
      ),
      362,
      "duplicate_or_superseded",
    );
    writeFileSync(join(itemsDir, "362.md"), synced.report, "utf8");
    process.env.CODEX_BIN = join(root, "codex-must-not-run");
    const ghMock = promotionGhMock({
      number: 362,
      title: "Provider route fallback",
      comment: synced.comment,
      linkedPulls: {
        400: {
          number: 400,
          title: "Provider cleanup",
          html_url: "https://github.com/openclaw/openclaw/pull/400",
          state: "closed",
          merged_at: "2026-05-02T00:00:00Z",
          body: "Includes the fallback route behavior from PR 362.",
          comments: [],
          labels: [],
        },
      },
    });
    const runRequiredProofApply = (artifactDir: string) =>
      withMockGh(root, ghMock, () => {
        runApplyDecisionsForTest({
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
          extraArgs: [
            "--target-repo",
            "openclaw/openclaw",
            "--artifact-dir",
            artifactDir,
            "--require-precomputed-pr-close-coverage-proof",
            "--apply-kind",
            "all",
            "--processed-limit",
            "3",
          ],
        });
      });

    const artifactDir = join(root, "missing-proof-artifacts");
    runRequiredProofApply(artifactDir);

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
      action: string;
      reason: string;
    }>;
    assert.equal(
      report.some((entry) => entry.action === "closed"),
      false,
    );
    assert.equal(report[0]?.action, "retry_pr_close_coverage_proof");
    assert.match(report[0]?.reason ?? "", /artifact validation.*ENOENT/);

    const proofDir = join(artifactDir, "pr-close-coverage-proof");
    mkdirSync(proofDir, { recursive: true });
    writeFileSync(join(proofDir, "362-400.proof.json"), '{"schemaVersion":1}\n');
    runRequiredProofApply(artifactDir);
    const invalidReport = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
      action: string;
      reason: string;
    }>;
    assert.equal(
      invalidReport.some((entry) => entry.action === "closed"),
      false,
    );
    assert.equal(invalidReport[0]?.action, "retry_pr_close_coverage_proof");
    assert.match(invalidReport[0]?.reason ?? "", /artifact validation.*source must be an object/);
  } finally {
    if (originalCodexBin === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = originalCodexBin;
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions filters covering PR bot comments from coverage proof", () => {
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
        number: 363,
        title: "Provider route fallback",
        close_reason: "duplicate_or_superseded",
        work_cluster_refs: JSON.stringify([
          "Superseded by https://github.com/openclaw/openclaw/pull/400",
        ]),
      }).replace(
        "Closing this PR because the branch is not a useful landing base.",
        "Closing this PR as superseded by https://github.com/openclaw/openclaw/pull/400.",
      ),
      363,
      "duplicate_or_superseded",
    );
    writeFileSync(join(itemsDir, "363.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 363,
        title: "Provider route fallback",
        comment: synced.comment,
        linkedPulls: {
          400: {
            number: 400,
            title: "Provider cleanup",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "closed",
            merged_at: "2026-05-02T00:00:00Z",
            body: "Includes the fallback route behavior from PR 363.",
            comments: [
              {
                id: 9400,
                html_url: "https://github.com/openclaw/openclaw/pull/400#issuecomment-9400",
                created_at: "2026-05-01T02:00:00Z",
                updated_at: "2026-05-01T02:00:00Z",
                user: { login: "clawsweeper[bot]" },
                body: [
                  "AUTOMATION_SHOULD_NOT_REACH_SWEEP_PROOF",
                  "",
                  "<!-- clawsweeper-review item=400 -->",
                ].join("\n"),
              },
              {
                id: 9401,
                html_url: "https://github.com/openclaw/openclaw/pull/400#issuecomment-9401",
                created_at: "2026-05-01T03:00:00Z",
                updated_at: "2026-05-01T03:00:00Z",
                user: { login: "maintainer" },
                body: "HUMAN_COVERING_CONTEXT_REACHES_SWEEP_PROOF",
              },
            ],
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
            expectedPromptIncludes: "HUMAN_COVERING_CONTEXT_REACHES_SWEEP_PROOF",
            unexpectedPromptIncludes: "AUTOMATION_SHOULD_NOT_REACH_SWEEP_PROOF",
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
    }>;
    assert.equal(
      report.some((entry) => entry.action === "closed"),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions rechecks duplicate PR freshness after coverage proof passes", () => {
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
          "Superseded by https://github.com/openclaw/openclaw/pull/400",
        ]),
      }).replace(
        "Closing this PR because the branch is not a useful landing base.",
        "Closing this PR as superseded by https://github.com/openclaw/openclaw/pull/400.",
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
        itemUpdatedAtAfterProof: "2026-05-01T00:05:00Z",
        itemUpdatedAtAfterProofLogPath: proofLogPath,
        linkedPulls: {
          400: {
            number: 400,
            title: "Provider cleanup",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "closed",
            merged_at: "2026-05-02T00:00:00Z",
            body: "Includes the fallback route behavior from PR 357.",
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
            decision: "covered",
            reason: "PR B carries forward PR A's fallback route behavior.",
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
    assert.equal(report[0]?.action, "skipped_changed_since_review");
    assert.match(report[0]?.reason ?? "", /updated_at changed/);
    assert.equal(existsSync(join(closedDir, "357.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions rechecks covering PR freshness after coverage proof passes", () => {
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
        number: 360,
        title: "Provider route fallback",
        close_reason: "duplicate_or_superseded",
        work_cluster_refs: JSON.stringify([
          "Superseded by https://github.com/openclaw/openclaw/pull/400",
        ]),
      }).replace(
        "Closing this PR because the branch is not a useful landing base.",
        "Closing this PR as superseded by https://github.com/openclaw/openclaw/pull/400.",
      ),
      360,
      "duplicate_or_superseded",
    );
    writeFileSync(join(itemsDir, "360.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 360,
        title: "Provider route fallback",
        comment: synced.comment,
        itemUpdatedAtAfterProofLogPath: proofLogPath,
        linkedPulls: {
          400: {
            number: 400,
            title: "Provider cleanup",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "closed",
            merged_at: "2026-05-02T00:00:00Z",
            updated_at: "2026-05-01T00:00:00Z",
            body: "Includes the fallback route behavior from PR 360.",
            comments: [],
            labels: [],
          },
        },
        linkedPullsAfterProof: {
          400: {
            number: 400,
            title: "Provider cleanup",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "closed",
            merged_at: "2026-05-02T00:00:00Z",
            updated_at: "2026-05-01T00:05:00Z",
            body: "Changed after proof ran.",
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
            decision: "covered",
            reason: "PR B carries forward PR A's fallback route behavior.",
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
      /linked canonical PR #400 changed after coverage proof/,
    );
    assert.equal(existsSync(join(closedDir, "360.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
