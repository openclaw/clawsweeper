import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  renderReviewCommentFromReport,
  renderReviewStartStatusComment,
} from "../dist/clawsweeper.js";
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

function boundDuplicateCloseComment(number: number, canonicalUrl: string): string {
  const markerFields = [
    `item=${number}`,
    "sha=head-sha",
    "confidence=high",
    "updated_at=2026-05-01T00:00:00.000Z",
    "reviewed_at=2026-05-01T00:00:00.000Z",
    "source_revision=reviewed-source",
    "action_taken=proposed_close",
    "reason=duplicate_or_superseded",
  ].join(" ");
  return [
    "Codex review: close this as superseded.",
    "",
    `Canonical: ${canonicalUrl}`,
    "",
    `<!-- clawsweeper-verdict:close ${markerFields} -->`,
    `<!-- clawsweeper-action:close-required ${markerFields} -->`,
    `<!-- clawsweeper-review item=${number} -->`,
  ].join("\n");
}

test("apply-decisions blocks duplicate close when linked canonical PR closed unmerged", () => {
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
        number: 336,
        title: "Already proposed duplicate close",
        close_reason: "duplicate_or_superseded",
        work_cluster_refs: JSON.stringify([
          "Superseded by https://github.com/openclaw/openclaw/pull/400",
        ]),
      }),
      336,
      "duplicate_or_superseded",
    );
    writeFileSync(join(itemsDir, "336.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 336,
        title: "Already proposed duplicate close",
        comment: boundDuplicateCloseComment(336, "https://github.com/openclaw/openclaw/pull/400"),
        linkedPulls: {
          400: {
            number: 400,
            title: "Closed unmerged canonical PR",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "closed",
            merged_at: null,
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
            "--processed-limit",
            "3",
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
    assert.match(
      report.find((entry) => entry.action === "kept_open")?.reason ?? "",
      /closed and unmerged/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions blocks duplicate close when canonical PR is only in close comment", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const reportMarkdown = lowSignalCloseReport({
      number: 346,
      title: "Already proposed duplicate close",
      close_reason: "duplicate_or_superseded",
      work_cluster_refs: JSON.stringify([]),
    }).replace(
      "Closing this PR because the branch is not a useful landing base.",
      [
        "Closing this PR as superseded by https://github.com/openclaw/openclaw/pull/400.",
        "",
        "Earlier context also mentioned https://github.com/openclaw/openclaw/pull/401.",
      ].join("\n"),
    );
    const synced = reportWithSyncedReviewComment(reportMarkdown, 346, "duplicate_or_superseded");
    writeFileSync(join(itemsDir, "346.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 346,
        title: "Already proposed duplicate close",
        comment: boundDuplicateCloseComment(346, "https://github.com/openclaw/openclaw/pull/400"),
        linkedPulls: {
          400: {
            number: 400,
            title: "Closed unmerged canonical PR",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "closed",
            merged_at: null,
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
            "--processed-limit",
            "3",
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
    assert.match(
      report.find((entry) => entry.action === "kept_open")?.reason ?? "",
      /closed and unmerged/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions keeps existing duplicate PR close proposals open when coverage proof says keep_open", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const commentWriteLogPath = join(root, "comment-write.log");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const synced = reportWithSyncedReviewComment(
      lowSignalCloseReport({
        number: 348,
        title: "Provider route fallback",
        close_reason: "duplicate_or_superseded",
        work_cluster_refs: JSON.stringify([
          "Superseded by https://github.com/openclaw/openclaw/pull/400",
        ]),
      }).replace(
        "Closing this PR because the branch is not a useful landing base.",
        "Closing this PR as superseded by https://github.com/openclaw/openclaw/pull/400.",
      ),
      348,
      "duplicate_or_superseded",
    );
    writeFileSync(join(itemsDir, "348.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 348,
        title: "Provider route fallback",
        comment: synced.comment,
        commentWriteLogPath,
        linkedPulls: {
          400: {
            number: 400,
            title: "Provider cleanup",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "closed",
            merged_at: "2026-05-02T00:00:00Z",
            body: "Cleans up provider setup without changing the fallback route.",
            comments: [
              {
                id: 9400,
                html_url: "https://github.com/openclaw/openclaw/pull/400#issuecomment-9400",
                created_at: "2026-05-01T02:00:00Z",
                updated_at: "2026-05-01T02:00:00Z",
                user: { login: "maintainer" },
                body: "This does not include the fallback route behavior from PR 348.",
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
      action: string;
      reason: string;
    }>;
    assert.equal(
      report.some((entry) => entry.action === "closed"),
      false,
    );
    assert.equal(
      report.find((entry) => entry.number === 348)?.action,
      "skipped_pr_close_coverage_proof",
    );
    assert.match(
      report.find((entry) => entry.action === "skipped_pr_close_coverage_proof")?.reason ?? "",
      /unique fallback route behavior/,
    );
    assert.match(
      readFileSync(join(itemsDir, "348.md"), "utf8"),
      /action_taken: skipped_pr_close_coverage_proof/,
    );
    const blockedReport = readFileSync(join(itemsDir, "348.md"), "utf8");
    assert.match(blockedReport, /^decision: keep_open$/m);
    assert.match(blockedReport, /^close_reason: none$/m);
    assert.match(blockedReport, /## PR Close Coverage Proof\n\nDecision: keep_open/);
    assert.match(blockedReport, /unique fallback route behavior/);
    assert.match(readFileSync(commentWriteLogPath, "utf8"), /issues\/comments\/9348/);
    assert.doesNotMatch(
      renderReviewCommentFromReport(blockedReport, "none"),
      /I’m closing this PR/,
    );

    writeFileSync(commentWriteLogPath, "", "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 348,
        title: "Provider route fallback",
        comment: synced.comment,
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
        withMockCodexProof(root, { type: "failure", message: "proof should not rerun" }, () => {
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
              "--sync-comments-only",
              "--processed-limit",
              "3",
            ],
          });
        });
      },
    );

    const retryReport = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
      number: number;
      action: string;
      reason: string;
    }>;
    assert.equal(
      retryReport.some((entry) => entry.action === "closed"),
      false,
    );
    assert.equal(retryReport.find((entry) => entry.number === 348)?.action, "kept_open");
    assert.equal(
      retryReport.some((entry) => /proof should not rerun/.test(entry.reason)),
      false,
    );
    assert.equal(readFileSync(commentWriteLogPath, "utf8"), "");
    assert.equal(existsSync(join(closedDir, "348.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions skips duplicate PR coverage proof during synced comment-only runs", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const proofLogPath = join(root, "proof.log");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const reportMarkdown = lowSignalCloseReport({
      number: 348,
      title: "Provider route fallback",
      close_reason: "duplicate_or_superseded",
      work_cluster_refs: JSON.stringify([
        "Superseded by https://github.com/openclaw/openclaw/pull/400",
      ]),
    }).replace(
      "Closing this PR because the branch is not a useful landing base.",
      "Closing this PR as superseded by https://github.com/openclaw/openclaw/pull/400.",
    );
    const synced = reportWithSyncedReviewComment(reportMarkdown, 348, "duplicate_or_superseded");
    writeFileSync(join(itemsDir, "348.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 348,
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
      }),
      () => {
        withMockCodexProof(
          root,
          { type: "failure", message: "proof should not run", invocationLogPath: proofLogPath },
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
                "--sync-comments-only",
                "--processed-limit",
                "1",
              ],
            });
          },
        );
      },
    );

    assert.equal(existsSync(proofLogPath), false);
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
      action: string;
      reason: string;
    }>;
    assert.equal(
      report.some((entry) => /proof should not run/.test(entry.reason)),
      false,
    );
    assert.equal(existsSync(join(closedDir, "348.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions skips duplicate PR coverage proof during stale comment-only sync", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const proofLogPath = join(root, "proof.log");
    const commentWriteLogPath = join(root, "comment-write.log");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const reportMarkdown = lowSignalCloseReport({
      number: 349,
      title: "Provider route fallback",
      close_reason: "duplicate_or_superseded",
      work_cluster_refs: JSON.stringify([
        "Superseded by https://github.com/openclaw/openclaw/pull/400",
      ]),
    }).replace(
      "Closing this PR because the branch is not a useful landing base.",
      "Closing this PR as superseded by https://github.com/openclaw/openclaw/pull/400.",
    );
    const synced = reportWithSyncedReviewComment(reportMarkdown, 349, "duplicate_or_superseded");
    writeFileSync(join(itemsDir, "349.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 349,
        title: "Provider route fallback",
        comment: markedReviewCommentForTest(349, "Stale durable review comment."),
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
          { type: "failure", message: "proof should not run", invocationLogPath: proofLogPath },
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
                "--sync-comments-only",
                "--processed-limit",
                "1",
              ],
            });
          },
        );
      },
    );

    assert.equal(existsSync(proofLogPath), false);
    assert.match(readFileSync(commentWriteLogPath, "utf8"), /issues\/comments\/9349/);
    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 349,
        action: "review_comment_synced",
        reason: "updated durable Codex review comment",
      },
    ]);
    assert.equal(existsSync(join(closedDir, "349.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions corrects stale close comments when the canonical PR closed unmerged", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const proofLogPath = join(root, "proof.log");
    const commentWriteLogPath = join(root, "comment-write.log");
    const canonicalUrl = "https://github.com/openclaw/openclaw/pull/400";
    const headSha = "a".repeat(40);
    const reviewLeaseOwner = "stale-canonical-review";
    const reviewLeaseCommentId = 9351;
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const rootCauseCluster = {
      confidence: "high",
      canonicalRef: canonicalUrl,
      currentItemRelationship: "superseded",
      summary: "This PR is superseded by an open, mergeable canonical PR.",
      members: [
        {
          ref: canonicalUrl,
          relationship: "canonical",
          reason: "This was the open canonical landing path.",
        },
      ],
    };
    const mergeRiskOptions = [
      {
        title: "Close in favor of the canonical PR",
        body: `Use ${canonicalUrl} as the single landing path.`,
        category: "pause_or_close",
        recommended: true,
        automergeInstruction: "",
      },
    ];
    const reportMarkdown = `${lowSignalCloseReport({
      number: 350,
      title: "Provider route fallback",
      action_taken: "skipped_changed_since_review",
      close_reason: "duplicate_or_superseded",
      work_cluster_refs: JSON.stringify([`Superseded by ${canonicalUrl}`]),
      root_cause_cluster: JSON.stringify(rootCauseCluster),
      merge_risk_options: JSON.stringify(mergeRiskOptions),
      label_justifications: JSON.stringify([
        { label: "P2", reason: `The canonical landing path is ${canonicalUrl}.` },
      ]),
      review_metrics: JSON.stringify([
        { label: "Canonical status", value: "open", reason: canonicalUrl },
      ]),
      pull_head_sha: headSha,
      review_lease_owner: reviewLeaseOwner,
      review_lease_comment_id: String(reviewLeaseCommentId),
    })
      .replace(
        "The dashboard has queue_fix_pr candidates but no generated coding plan.",
        `Close this PR because ${canonicalUrl} is open and canonical.`,
      )
      .replace(
        "- **branch shape:** PR diff is mostly unrelated provider churn around a tiny possible useful tweak",
        `- **Canonical PR status:** ${canonicalUrl} is open, mergeable, and proof-positive.`,
      )
      .replace(
        "Closing this PR because the branch is not a useful landing base.",
        `Closing this PR as superseded by ${canonicalUrl}.`,
      )}

## Best Possible Solution

Close this branch and land ${canonicalUrl}.

## Solution Assessment

This branch is superseded by the open canonical PR at ${canonicalUrl}.

## Root-Cause Cluster

Current item relationship: superseded

Confidence: high

Canonical ref: ${canonicalUrl}

Summary: This PR is superseded by an open, mergeable canonical PR.

Members:
- **canonical:** ${canonicalUrl}
  - reason: This was the open canonical landing path.

## PR Rating

Overall tier: F

Proof tier: D

Patch tier: F

Summary: This branch is superseded by the canonical PR.

Next rank-up steps:

- Close this PR in favor of ${canonicalUrl}.

## Work Candidate

Candidate: none

Confidence: high

Priority: low

Status: none

Reason: No work is needed because ${canonicalUrl} is the canonical landing path.

## Likely Related People

- **contributor:** canonical candidate author
  - reason: They authored the open canonical PR at ${canonicalUrl}.
  - confidence: medium

## Risks / Open Questions

- The proof is already available on ${canonicalUrl}.
`;
    const synced = reportWithSyncedReviewComment(reportMarkdown, 350, "duplicate_or_superseded");
    const recentlySyncedReport = synced.report.replace(
      /^review_comment_synced_at: .*$/m,
      `review_comment_synced_at: ${new Date().toISOString()}`,
    );
    const reportReviewedAt = recentlySyncedReport.match(/^reviewed_at: (.+)$/m)?.[1];
    assert.ok(reportReviewedAt);
    const newerStaleCloseComment = [
      "Codex review: close this as superseded.",
      "",
      `Canonical landing path: ${canonicalUrl}.`,
      "",
      "<!-- clawsweeper-verdict:close item=350 sha=head-sha confidence=high updated_at=2099-01-01T00:00:00.000Z reviewed_at=2099-01-01T00:00:00.000Z source_revision=newer-source action_taken=skipped_changed_since_review reason=duplicate_or_superseded -->",
      "<!-- clawsweeper-action:close-required item=350 sha=head-sha confidence=high updated_at=2099-01-01T00:00:00.000Z reviewed_at=2099-01-01T00:00:00.000Z source_revision=newer-source action_taken=skipped_changed_since_review reason=duplicate_or_superseded -->",
      "<!-- clawsweeper-review item=350 -->",
    ].join("\n");
    const differentCanonicalCloseComment = newerStaleCloseComment.replace(
      canonicalUrl,
      "https://github.com/openclaw/openclaw/pull/401",
    );
    const multiMemberCloseComment = newerStaleCloseComment.replace(
      `Canonical landing path: ${canonicalUrl}.`,
      [
        "**Root-cause cluster**",
        `Canonical: ${canonicalUrl}`,
        "Members:",
        `- \`canonical\`: ${canonicalUrl} - This is the canonical landing path.`,
        "- `superseded`: https://github.com/openclaw/openclaw/pull/402 - This related branch is also superseded.",
      ].join("\n"),
    );
    const issueCanonicalCloseComment = newerStaleCloseComment
      .replace(
        `Canonical landing path: ${canonicalUrl}.`,
        [
          "**Root-cause cluster**",
          "Canonical: https://github.com/openclaw/openclaw/issues/500",
          "Members:",
          `- \`superseded\`: ${canonicalUrl} - This PR is the unique superseding landing path.`,
        ].join("\n"),
      )
      .replaceAll("reviewed_at=2099-01-01T00:00:00.000Z", `reviewed_at=${reportReviewedAt}`);
    const leaseStartedAt = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const reviewLeaseComment = renderReviewStartStatusComment({
      number: 350,
      kind: "pull_request",
      title: "Provider route fallback",
      headSha,
      startedAt: leaseStartedAt,
      leaseExpiresAt,
      leaseOwner: reviewLeaseOwner,
    });
    const leasedPromotionGhMock = (options: Parameters<typeof promotionGhMock>[0]): string =>
      promotionGhMock({
        ...options,
        headSha,
        comments: [
          {
            id: 9350,
            html_url: "https://github.com/openclaw/openclaw/pull/350#issuecomment-9350",
            created_at: "2026-05-01T01:00:00Z",
            updated_at: "2099-01-01T00:00:00.000Z",
            user: { login: "clawsweeper[bot]" },
            body: options.comment,
          },
          {
            id: reviewLeaseCommentId,
            html_url: `https://github.com/openclaw/openclaw/pull/350#issuecomment-${reviewLeaseCommentId}`,
            created_at: leaseStartedAt,
            updated_at: leaseStartedAt,
            user: { login: "clawsweeper[bot]" },
            body: reviewLeaseComment,
          },
        ],
      });
    writeFileSync(join(itemsDir, "350.md"), recentlySyncedReport, "utf8");

    withMockGh(
      root,
      leasedPromotionGhMock({
        number: 350,
        title: "Provider route fallback",
        itemUpdatedAt: "2026-05-02T00:00:00Z",
        comment: newerStaleCloseComment,
        commentWriteLogPath,
        commentWriteError: "gh: Requires authentication (HTTP 401)",
        linkedPulls: {
          400: {
            number: 400,
            title: "Closed canonical PR",
            html_url: canonicalUrl,
            state: "closed",
            merged_at: null,
            labels: [],
          },
        },
      }),
      () => {
        withMockCodexProof(
          root,
          { type: "failure", message: "proof should not run", invocationLogPath: proofLogPath },
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
                "--sync-comments-only",
                "--comment-sync-min-age-days",
                "30",
                "--processed-limit",
                "1",
              ],
            });
          },
        );
      },
    );

    assert.equal(existsSync(proofLogPath), false);
    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 350,
        action: "retry_stale_canonical_comment_sync",
        reason:
          "GitHub rejected durable review comment write with Requires authentication; stale canonical comment correction remains pending",
      },
    ]);
    const pendingReport = readFileSync(join(itemsDir, "350.md"), "utf8");
    assert.match(pendingReport, /^decision: keep_open$/m);
    assert.match(pendingReport, /^action_taken: retry_stale_canonical_comment_sync$/m);
    assert.match(pendingReport, /^stale_canonical_pull_request_number: 400$/m);
    assert.equal(existsSync(join(root, "comment-state-350.json")), false);

    const commentWriteCount = (): number =>
      readFileSync(commentWriteLogPath, "utf8").trim().split("\n").filter(Boolean).length;
    const writesAfterAuthFailure = commentWriteCount();
    const runPendingRetry = (comment: string, linkedPull: Record<string, unknown>): void => {
      withMockGh(
        root,
        leasedPromotionGhMock({
          number: 350,
          title: "Provider route fallback",
          itemUpdatedAt: "2026-05-02T00:00:00Z",
          comment,
          commentWriteLogPath,
          linkedPulls: { 400: linkedPull },
        }),
        () => {
          withMockCodexProof(
            root,
            { type: "failure", message: "proof should not run", invocationLogPath: proofLogPath },
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
                  "--sync-comments-only",
                  "--comment-sync-min-age-days",
                  "30",
                  "--processed-limit",
                  "1",
                ],
              });
            },
          );
        },
      );
    };

    runPendingRetry(newerStaleCloseComment, {
      number: 400,
      title: "Reopened canonical PR",
      html_url: canonicalUrl,
      state: "open",
      merged_at: null,
      labels: [],
    });
    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 350,
        action: "retry_stale_canonical_comment_sync",
        reason:
          "linked canonical PR #400 is no longer closed and unmerged; fresh review required before stale comment correction",
      },
    ]);
    assert.equal(commentWriteCount(), writesAfterAuthFailure);

    runPendingRetry(differentCanonicalCloseComment, {
      number: 400,
      title: "Closed canonical PR",
      html_url: canonicalUrl,
      state: "closed",
      merged_at: null,
      labels: [],
    });
    const differentCanonicalResult = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
      number: number;
      action: string;
      reason: string;
    }>;
    assert.equal(differentCanonicalResult[0]?.number, 350);
    assert.equal(differentCanonicalResult[0]?.action, "retry_stale_canonical_comment_sync");
    assert.match(differentCanonicalResult[0]?.reason ?? "", /newer than the local report/);
    assert.match(
      differentCanonicalResult[0]?.reason ?? "",
      /stale canonical comment correction remains pending/,
    );
    assert.equal(commentWriteCount(), writesAfterAuthFailure);

    const writesBeforeIssueCanonical = commentWriteCount();
    runPendingRetry(issueCanonicalCloseComment, {
      number: 400,
      title: "Closed canonical PR",
      html_url: canonicalUrl,
      state: "closed",
      merged_at: null,
      labels: [],
    });
    const issueCanonicalResult = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
      number: number;
      action: string;
      reason: string;
    }>;
    assert.equal(issueCanonicalResult[0]?.number, 350);
    assert.equal(issueCanonicalResult[0]?.action, "retry_stale_canonical_comment_sync");
    assert.match(issueCanonicalResult[0]?.reason ?? "", /not bound to stored canonical PR #400/);
    assert.match(
      issueCanonicalResult[0]?.reason ?? "",
      /stale canonical comment correction remains pending/,
    );
    assert.equal(commentWriteCount(), writesBeforeIssueCanonical);

    withMockGh(
      root,
      leasedPromotionGhMock({
        number: 350,
        title: "Provider route fallback",
        itemUpdatedAt: "2026-05-02T00:00:00Z",
        comment: multiMemberCloseComment,
        commentWriteLogPath,
        linkedPulls: {
          400: {
            number: 400,
            title: "Closed canonical PR",
            html_url: canonicalUrl,
            state: "closed",
            merged_at: null,
            labels: [],
          },
        },
      }),
      () => {
        withMockCodexProof(
          root,
          { type: "failure", message: "proof should not run", invocationLogPath: proofLogPath },
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
                "--sync-comments-only",
                "--comment-sync-min-age-days",
                "30",
                "--processed-limit",
                "1",
              ],
            });
          },
        );
      },
    );

    assert.equal(existsSync(proofLogPath), false);
    assert.match(readFileSync(commentWriteLogPath, "utf8"), /issues\/comments\/9350/);
    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 350,
        action: "kept_open",
        reason:
          "linked canonical PR #400 is closed and unmerged; refusing duplicate/superseded auto-close; updated durable Codex review comment",
      },
    ]);
    const storedReport = readFileSync(join(itemsDir, "350.md"), "utf8");
    assert.match(storedReport, /^decision: keep_open$/m);
    assert.match(storedReport, /^close_reason: none$/m);
    assert.match(storedReport, /^confidence: low$/m);
    assert.match(storedReport, /^action_taken: corrected_stale_canonical_comment$/m);
    assert.match(storedReport, /^stale_canonical_pull_request_number: none$/m);
    assert.match(storedReport, /^merge_risk_options: \[\]$/m);
    assert.match(storedReport, /"canonicalRef":null/);
    assert.doesNotMatch(storedReport, new RegExp(canonicalUrl));
    const liveComment = (
      JSON.parse(readFileSync(join(root, "comment-state-350.json"), "utf8")) as { body: string }
    ).body;
    assert.match(liveComment, /closed and unmerged/);
    assert.doesNotMatch(liveComment, new RegExp(canonicalUrl));
    assert.doesNotMatch(liveComment, /clawsweeper-(?:verdict:close|action:close-required)/);
    assert.equal(existsSync(join(closedDir, "350.md")), false);

    const followupReportPath = join(root, "followup-apply-report.json");
    withMockGh(
      root,
      promotionGhMock({
        number: 350,
        title: "Provider route fallback",
        itemUpdatedAt: "2026-05-02T00:00:00Z",
        comment: markedReviewCommentForTest(350, "Stale durable review comment."),
      }),
      () => {
        withMockCodexProof(
          root,
          { type: "failure", message: "corrected report must not be promoted" },
          () => {
            runApplyDecisionsForTest({
              itemsDir,
              closedDir,
              plansDir,
              reportPath: followupReportPath,
              extraArgs: [
                "--target-repo",
                "openclaw/openclaw",
                "--apply-kind",
                "all",
                "--dry-run",
                "--processed-limit",
                "1",
              ],
            });
          },
        );
      },
    );
    assert.deepEqual(JSON.parse(readFileSync(followupReportPath, "utf8")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions does not create close comments from changed reports while canonical stays open", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const dryRunReportPath = join(root, "dry-run-apply-report.json");
    const proofLogPath = join(root, "proof.log");
    const commentWriteLogPath = join(root, "comment-write.log");
    const canonicalUrl = "https://github.com/openclaw/openclaw/pull/400";
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const reportMarkdown = lowSignalCloseReport({
      number: 369,
      title: "Changed duplicate report without a durable comment",
      action_taken: "skipped_changed_since_review",
      close_reason: "duplicate_or_superseded",
      work_cluster_refs: JSON.stringify([`Superseded by ${canonicalUrl}`]),
    }).replace(
      "Closing this PR because the branch is not a useful landing base.",
      `Closing this PR as superseded by ${canonicalUrl}.`,
    );
    writeFileSync(join(itemsDir, "369.md"), reportMarkdown, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 369,
        title: "Changed duplicate report without a durable comment",
        labels: [],
        itemUpdatedAt: "2026-05-02T00:00:00Z",
        comment: "",
        comments: [],
        commentWriteLogPath,
        linkedPulls: {
          400: {
            number: 400,
            title: "Open canonical PR",
            html_url: canonicalUrl,
            state: "open",
            merged_at: null,
            labels: [],
          },
        },
      }),
      () => {
        withMockCodexProof(
          root,
          { type: "failure", message: "proof should not run", invocationLogPath: proofLogPath },
          () => {
            runApplyDecisionsForTest({
              itemsDir,
              closedDir,
              plansDir,
              reportPath: dryRunReportPath,
              extraArgs: [
                "--target-repo",
                "openclaw/openclaw",
                "--apply-kind",
                "all",
                "--sync-comments-only",
                "--dry-run",
                "--processed-limit",
                "1",
              ],
            });
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
                "--sync-comments-only",
                "--processed-limit",
                "1",
              ],
            });
          },
        );
      },
    );

    assert.equal(existsSync(proofLogPath), false);
    assert.equal(existsSync(commentWriteLogPath), false);
    assert.equal(existsSync(join(root, "comment-state-369.json")), false);
    assert.deepEqual(JSON.parse(readFileSync(dryRunReportPath, "utf8")), []);
    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), []);
    const storedReport = readFileSync(join(itemsDir, "369.md"), "utf8");
    assert.match(storedReport, /^action_taken: skipped_changed_since_review$/m);
    assert.match(storedReport, /^decision: close$/m);
    assert.equal(existsSync(join(closedDir, "369.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions rechecks a structured canonical ref at the comment mutation boundary", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const proofLogPath = join(root, "proof.log");
    const commentWriteLogPath = join(root, "comment-write.log");
    const canonicalUrl = "https://github.com/openclaw/openclaw/pull/400";
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const rootCauseCluster = {
      confidence: "high",
      canonicalRef: canonicalUrl,
      currentItemRelationship: "superseded",
      summary: "The structured review identified one canonical landing path.",
      members: [
        {
          ref: canonicalUrl,
          relationship: "canonical",
          reason: "This was the canonical landing path at review time.",
        },
      ],
    };
    const synced = reportWithSyncedReviewComment(
      lowSignalCloseReport({
        number: 352,
        title: "Provider route fallback",
        action_taken: "skipped_changed_since_review",
        close_reason: "duplicate_or_superseded",
        work_cluster_refs: "[]",
        root_cause_cluster: JSON.stringify(rootCauseCluster),
      }),
      352,
      "duplicate_or_superseded",
    );
    writeFileSync(join(itemsDir, "352.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 352,
        title: "Provider route fallback",
        comment: boundDuplicateCloseComment(352, canonicalUrl),
        commentWriteLogPath,
        linkedPulls: {
          400: {
            number: 400,
            title: "Canonical provider fix",
            html_url: canonicalUrl,
            state: "open",
            merged_at: null,
            labels: [],
          },
        },
        linkedPullsAfterCommentRead: {
          400: {
            number: 400,
            title: "Canonical provider fix",
            html_url: canonicalUrl,
            state: "closed",
            merged_at: null,
            labels: [],
          },
        },
      }),
      () => {
        withMockCodexProof(
          root,
          { type: "failure", message: "proof should not run", invocationLogPath: proofLogPath },
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
                "--sync-comments-only",
                "--processed-limit",
                "1",
              ],
            });
          },
        );
      },
    );

    assert.equal(existsSync(proofLogPath), false);
    assert.match(readFileSync(commentWriteLogPath, "utf8"), /issues\/comments\/9352/);
    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 352,
        action: "kept_open",
        reason:
          "linked canonical PR #400 is closed and unmerged; refusing duplicate/superseded auto-close; updated durable Codex review comment",
      },
    ]);
    const storedReport = readFileSync(join(itemsDir, "352.md"), "utf8");
    assert.match(storedReport, /^action_taken: corrected_stale_canonical_comment$/m);
    assert.doesNotMatch(storedReport, new RegExp(canonicalUrl));
    const liveComment = (
      JSON.parse(readFileSync(join(root, "comment-state-352.json"), "utf8")) as { body: string }
    ).body;
    assert.match(liveComment, /closed and unmerged/);
    assert.doesNotMatch(liveComment, /clawsweeper-(?:verdict:close|action:close-required)/);
    assert.equal(existsSync(join(closedDir, "352.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions keeps an unreadable canonical PR in the comment-sync queue", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const proofLogPath = join(root, "proof.log");
    const commentWriteLogPath = join(root, "comment-write.log");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const canonicalUrl = "https://github.com/openclaw/openclaw/pull/400";
    const synced = reportWithSyncedReviewComment(
      lowSignalCloseReport({
        number: 351,
        title: "Provider route fallback",
        close_reason: "duplicate_or_superseded",
        work_cluster_refs: JSON.stringify([
          `Related pull request: ${canonicalUrl}`,
          "Background issue: #500",
        ]),
      }).replace(
        "Closing this PR because the branch is not a useful landing base.",
        `Closing this PR as superseded by ${canonicalUrl}.`,
      ),
      351,
      "duplicate_or_superseded",
    );
    writeFileSync(join(itemsDir, "351.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 351,
        title: "Provider route fallback",
        comment: markedReviewCommentForTest(351, "Stale durable review comment."),
        commentWriteLogPath,
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
          { type: "failure", message: "proof should not run", invocationLogPath: proofLogPath },
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
                "--sync-comments-only",
                "--processed-limit",
                "1",
              ],
            });
          },
        );
      },
    );

    assert.equal(existsSync(proofLogPath), false);
    assert.equal(existsSync(commentWriteLogPath), false);
    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 351,
        action: "retry_pr_close_coverage_proof",
        reason:
          "linked canonical PR #400 could not be read; refusing duplicate/superseded comment sync",
      },
    ]);
    const storedReport = readFileSync(join(itemsDir, "351.md"), "utf8");
    assert.match(storedReport, /^decision: close$/m);
    assert.match(storedReport, /^close_reason: duplicate_or_superseded$/m);
    assert.match(storedReport, /^action_taken: proposed_close$/m);
    assert.match(storedReport, new RegExp(canonicalUrl));
    assert.equal(existsSync(join(root, "comment-state-351.json")), false);
    assert.equal(existsSync(join(closedDir, "351.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions gates duplicate PR closes with shorthand canonical refs", () => {
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
        number: 356,
        title: "Provider route fallback",
        close_reason: "duplicate_or_superseded",
        work_cluster_refs: JSON.stringify(["Superseded by #400"]),
      }).replace(
        "Closing this PR because the branch is not a useful landing base.",
        "Closing this PR as superseded by openclaw/openclaw#400.",
      ),
      356,
      "duplicate_or_superseded",
    );
    writeFileSync(join(itemsDir, "356.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 356,
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
            comments: [
              {
                id: 9400,
                html_url: "https://github.com/openclaw/openclaw/pull/400#issuecomment-9400",
                created_at: "2026-05-01T02:00:00Z",
                updated_at: "2026-05-01T02:00:00Z",
                user: { login: "maintainer" },
                body: "This does not include the fallback route behavior from PR 356.",
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
      report.find((entry) => entry.number === 356)?.action,
      "skipped_pr_close_coverage_proof",
    );
    assert.match(readFileSync(proofLogPath, "utf8"), /proof/);
    assert.match(
      report.find((entry) => entry.number === 356)?.reason ?? "",
      /unique fallback route behavior/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions gates duplicate PR closes when unrelated bare issue refs accompany one PR URL", () => {
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
        number: 359,
        title: "Provider route fallback",
        close_reason: "duplicate_or_superseded",
        work_cluster_refs: JSON.stringify([
          "Related pull request: https://github.com/openclaw/openclaw/pull/400",
          "Background issue: #500",
        ]),
      }).replace(
        "Closing this PR because the branch is not a useful landing base.",
        "Closing this PR because the related pull request is the better review target.",
      ),
      359,
      "duplicate_or_superseded",
    );
    writeFileSync(join(itemsDir, "359.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 359,
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
      report.find((entry) => entry.number === 359)?.action,
      "skipped_pr_close_coverage_proof",
    );
    assert.match(readFileSync(proofLogPath, "utf8"), /proof/);
    assert.match(
      report.find((entry) => entry.number === 359)?.reason ?? "",
      /unique fallback route behavior/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
