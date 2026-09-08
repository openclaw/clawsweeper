import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createApplyProofFreshnessGuards } from "../dist/clawsweeper-apply-proof-freshness.js";
import { completeActivityContextSymbol } from "../dist/clawsweeper-types.js";
import {
  emptyReviewedPrActivityCursor,
  lowSignalCloseReport,
  promotionGhMock,
  reportWithSyncedReviewComment,
  runApplyDecisionsForTest,
  runOpenClawApplyDecisionsForTest,
  tmpPrefix,
  withApplyTestWorkspace,
  withMockCodexProof,
  withMockGh,
} from "./helpers.ts";

test("post-proof freshness accepts a prior-run automation receipt only with a complete match", () => {
  const automationItemUpdatedAt = "2026-08-01T14:53:29Z";
  const context = {
    sourceRevision: "a".repeat(64),
    timelineRevision: "b".repeat(64),
    pullReviewActivityCursor: emptyReviewedPrActivityCursor,
    [completeActivityContextSymbol]: {
      comments: [],
      timeline: [],
      pullReviewComments: [],
    },
  };
  const guard = (completeReceiptMatches: boolean) =>
    createApplyProofFreshnessGuards({
      action: undefined,
      automationItemUpdatedAt,
      collectItemContext: () => context,
      completeReviewActivityReceiptMatches: () => completeReceiptMatches,
      contextHasNonAutomationActivityAfter: () => false,
      coveringPrCloseCoveragePullRequestSnapshotSha256: () => "c".repeat(64),
      currentProofState: () => ({
        cachedPrCloseCoverageProofGateResult: {
          status: "allowed",
          covering: {
            number: 400,
            provedAtMs: Date.parse("2026-08-01T14:53:30Z"),
            snapshotSha256: "c".repeat(64),
            updatedAt: automationItemUpdatedAt,
            url: "https://github.com/openclaw/openclaw/pull/400",
            proof: {
              decision: "covered",
              reason: "covered",
              coveredWork: ["same behavior"],
              uniqueSourceWork: [],
              reviewerConcerns: [],
            },
          },
        },
        prCloseCoverageProofGateChecked: true,
        prCloseCoverageProofStartedAtMs: Date.parse("2026-08-01T14:53:30Z"),
        storedHash: undefined,
        storedUpdatedAt: "2026-08-01T14:52:41Z",
      }),
      expectedReviewActivityCursor: emptyReviewedPrActivityCursor,
      fetchItem: () => ({
        state: "open",
        item: { kind: "pull_request", updatedAt: automationItemUpdatedAt },
      }),
      fetchReviewedPrActivityCursor: () => emptyReviewedPrActivityCursor,
      freshPullRequestReviewHead: () => true,
      GitHubRuntimeBudgetError: class extends Error {},
      itemKind: "pull_request",
      itemSnapshotHash: () => "d".repeat(64),
      number: 359,
      reviewHasCompleteActivityIdentity: true,
      reviewMarkdown: "---\ntype: pull_request\n---\n",
      retryCloseCoverageCommandStatusOnlyUpdate: () => false,
      selfMutationItemReceipts: [],
    } as never);

  assert.equal(guard(true).postProofFreshnessBlock(), null);
  assert.match(guard(false).postProofFreshnessBlock()?.reason ?? "", /updated_at changed/);
});

test("forced final freshness rechecks an item without coverage proof or a new self receipt", () => {
  let fetchCount = 0;
  const guards = createApplyProofFreshnessGuards({
    action: undefined,
    automationItemUpdatedAt: undefined,
    collectItemContext: () => {
      throw new Error("changed updated_at must fail before collecting context");
    },
    completeReviewActivityReceiptMatches: () => false,
    contextHasNonAutomationActivityAfter: () => false,
    coveringPrCloseCoveragePullRequestSnapshotSha256: () => "c".repeat(64),
    currentProofState: () => ({
      cachedPrCloseCoverageProofGateResult: undefined,
      prCloseCoverageProofGateChecked: false,
      prCloseCoverageProofStartedAtMs: null,
      storedHash: undefined,
      storedUpdatedAt: "2026-08-01T14:52:41Z",
    }),
    expectedReviewActivityCursor: undefined,
    fetchItem: () => {
      fetchCount += 1;
      return {
        state: "open",
        item: { kind: "pull_request", updatedAt: "2026-08-01T14:53:29Z" },
      };
    },
    fetchReviewedPrActivityCursor: () => emptyReviewedPrActivityCursor,
    freshPullRequestReviewHead: () => true,
    GitHubRuntimeBudgetError: class extends Error {},
    itemKind: "pull_request",
    itemSnapshotHash: () => "d".repeat(64),
    number: 359,
    reviewHasCompleteActivityIdentity: false,
    reviewMarkdown: "---\ntype: pull_request\n---\n",
    retryCloseCoverageCommandStatusOnlyUpdate: () => false,
    selfMutationItemReceipts: [],
  } as never);

  assert.equal(guards.postProofFreshnessBlock(), null);
  assert.equal(fetchCount, 0);
  assert.equal(guards.postProofFreshnessBlock({ force: true })?.reason, "updated_at changed");
  assert.equal(fetchCount, 1);
});

function sourceRevisionForTest(title: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        title,
        body: "Stale PR body.",
        labels: [],
        comments: [],
      }),
    )
    .digest("hex");
}

function timelineRevisionForTest(
  events: Array<{
    id: number;
    event: string;
    actor: { login: string };
    commit_id?: string;
    label?: { name: string };
    rename?: unknown;
  }>,
): string {
  const digestParts = events.map((event) => ({
    actor: event.actor.login,
    commitId: event.commit_id ?? null,
    event: event.event,
    id: event.id,
    label: event.label?.name ?? null,
    rename: event.rename ?? null,
    sourceIssue: null,
  }));
  return createHash("sha256").update(JSON.stringify(digestParts)).digest("hex");
}

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

test("apply-decisions fails closed when a self-mutation receipt is truncated", () => {
  withApplyTestWorkspace(tmpPrefix, ({ root, itemsDir, closedDir, plansDir, reportPath }) => {
    const proofLogPath = join(root, "proof.log");
    const labelLogPath = join(root, "labels.log");
    const synced = reportWithSyncedReviewComment(
      lowSignalCloseReport({
        number: 359,
        title: "Provider route fallback",
        close_reason: "duplicate_or_superseded",
        item_source_revision: sourceRevisionForTest("Provider route fallback"),
        pull_head_sha: "head-sha",
        labels: JSON.stringify(["status: 📣 needs proof"]),
        work_cluster_refs: JSON.stringify([
          "Superseded by https://github.com/openclaw/openclaw/pull/400",
        ]),
      }).replace(
        "Closing this PR because the branch is not a useful landing base.",
        "Closing this PR as superseded by https://github.com/openclaw/openclaw/pull/400.",
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
        issueCommentCount: 25,
        itemUpdatedAtAfterLabelSync: "2026-05-01T00:04:00Z",
        itemUpdatedAtAfterLabelSyncLogPath: labelLogPath,
        linkedPulls: {
          400: {
            number: 400,
            title: "Provider cleanup",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "closed",
            merged_at: "2026-05-02T00:00:00Z",
            body: "Includes the fallback route behavior from PR 359.",
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
            runOpenClawApplyDecisionsForTest({
              itemsDir,
              closedDir,
              plansDir,
              reportPath,
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
      JSON.stringify(report, null, 2),
    );
    assert.match(readFileSync(labelLogPath, "utf8"), /issue edit 359/);
    assert.equal(report[0]?.action, "skipped_changed_since_review");
    assert.match(report[0]?.reason ?? "", /same-second activity requires a fresh review/);
    assert.equal(existsSync(join(closedDir, "359.md")), false);
  });
});

test("apply-decisions blocks same-second human timeline activity hidden by self-updates", () => {
  withApplyTestWorkspace(tmpPrefix, ({ root, itemsDir, closedDir, plansDir, reportPath }) => {
    const proofLogPath = join(root, "proof.log");
    const labelLogPath = join(root, "labels.log");
    const synced = reportWithSyncedReviewComment(
      lowSignalCloseReport({
        number: 362,
        title: "Provider route fallback",
        close_reason: "duplicate_or_superseded",
        item_source_revision: sourceRevisionForTest("Provider route fallback"),
        pull_head_sha: "head-sha",
        labels: JSON.stringify(["status: 📣 needs proof"]),
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

    withMockGh(
      root,
      promotionGhMock({
        number: 362,
        title: "Provider route fallback",
        comment: synced.comment,
        timeline: [
          {
            id: 9362,
            event: "assigned",
            created_at: "2026-05-01T00:00:00Z",
            actor: { login: "maintainer" },
          },
        ],
        // GitHub timestamps are second-granular: the human assignment and the
        // bot-owned label mutation can leave the item timestamp equal to the
        // reviewed value even though the activity receipt changed.
        itemUpdatedAtAfterLabelSync: "2026-05-01T00:00:00Z",
        itemUpdatedAtAfterLabelSyncLogPath: labelLogPath,
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
            runOpenClawApplyDecisionsForTest({
              itemsDir,
              closedDir,
              plansDir,
              reportPath,
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
    assert.match(report[0]?.reason ?? "", /same-second activity requires a fresh review/);
    assert.match(readFileSync(labelLogPath, "utf8"), /issue edit 362/);
    assert.equal(existsSync(join(closedDir, "362.md")), false);
  });
});

test("apply-decisions accepts same-second human activity already captured by the review", () => {
  withApplyTestWorkspace(tmpPrefix, ({ root, itemsDir, closedDir, plansDir, reportPath }) => {
    const proofLogPath = join(root, "proof.log");
    const reviewedTimeline = [
      {
        id: 9364,
        event: "assigned",
        created_at: "2026-05-01T00:00:00Z",
        actor: { login: "maintainer" },
      },
    ];
    const synced = reportWithSyncedReviewComment(
      lowSignalCloseReport({
        number: 364,
        title: "Provider route fallback",
        close_reason: "duplicate_or_superseded",
        item_source_revision: sourceRevisionForTest("Provider route fallback"),
        review_timeline_revision: timelineRevisionForTest(reviewedTimeline),
        pull_head_sha: "head-sha",
        work_cluster_refs: JSON.stringify([
          "Superseded by https://github.com/openclaw/openclaw/pull/400",
        ]),
      }).replace(
        "Closing this PR because the branch is not a useful landing base.",
        "Closing this PR as superseded by https://github.com/openclaw/openclaw/pull/400.",
      ),
      364,
      "duplicate_or_superseded",
    );
    writeFileSync(join(itemsDir, "364.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 364,
        title: "Provider route fallback",
        comment: synced.comment,
        timeline: reviewedTimeline,
        itemUpdatedAtAfterLabelSync: "2026-05-01T00:00:00Z",
        linkedPulls: {
          400: {
            number: 400,
            title: "Provider cleanup",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "closed",
            merged_at: "2026-05-02T00:00:00Z",
            body: "Includes the fallback route behavior from PR 364.",
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
            runOpenClawApplyDecisionsForTest({
              itemsDir,
              closedDir,
              plansDir,
              reportPath,
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
      JSON.stringify(report, null, 2),
    );
    assert.equal(existsSync(join(closedDir, "364.md")), true);
  });
});

test("apply-decisions keeps existing duplicate PR close proposals open when coverage proof fails", () => {
  withApplyTestWorkspace(tmpPrefix, ({ root, itemsDir, closedDir, plansDir, reportPath }) => {
    const synced = reportWithSyncedReviewComment(
      lowSignalCloseReport({
        number: 350,
        title: "Provider route fallback",
        close_reason: "duplicate_or_superseded",
        work_cluster_refs: JSON.stringify([
          "Superseded by https://github.com/openclaw/openclaw/pull/400",
        ]),
      }).replace(
        "Closing this PR because the branch is not a useful landing base.",
        "Closing this PR as superseded by https://github.com/openclaw/openclaw/pull/400.",
      ),
      350,
      "duplicate_or_superseded",
    );
    writeFileSync(join(itemsDir, "350.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 350,
        title: "Provider route fallback",
        comment: synced.comment,
        linkedPulls: {
          400: {
            number: 400,
            title: "Provider cleanup",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "closed",
            merged_at: "2026-05-02T00:00:00Z",
            body: "May or may not include PR 350.",
            comments: [],
            labels: [],
          },
        },
      }),
      () => {
        withMockCodexProof(root, { type: "failure", message: "model unavailable" }, () => {
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
  });
});

test("apply-decisions retries transient duplicate PR coverage proof failures", () => {
  withApplyTestWorkspace(tmpPrefix, ({ root, itemsDir, closedDir, plansDir, reportPath }) => {
    const proofLogPath = join(root, "proof.log");
    const synced = reportWithSyncedReviewComment(
      lowSignalCloseReport({
        number: 353,
        title: "Provider route fallback",
        pull_head_sha: "head-sha",
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

    withMockGh(
      root,
      promotionGhMock({
        number: 353,
        title: "Provider route fallback",
        comment: synced.comment,
        linkedPulls: {
          400: {
            number: 400,
            title: "Provider cleanup",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "closed",
            merged_at: "2026-05-02T00:00:00Z",
            body: "Includes the fallback route behavior from PR 353.",
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
            message: "temporary model outage",
            invocationLogPath: proofLogPath,
          },
          () => {
            runOpenClawApplyDecisionsForTest({
              itemsDir,
              closedDir,
              plansDir,
              reportPath,
            });
          },
        );
      },
    );

    let report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
      action: string;
      reason: string;
    }>;
    assert.equal(
      report.some((entry) => entry.action === "closed"),
      false,
    );
    assert.match(
      report.find((entry) => entry.action === "retry_pr_close_coverage_proof")?.reason ?? "",
      /temporary/,
    );
    assert.match(
      readFileSync(join(itemsDir, "353.md"), "utf8"),
      /^action_taken: retry_pr_close_coverage_proof$/m,
    );

    withMockGh(
      root,
      promotionGhMock({
        number: 353,
        title: "Provider route fallback",
        comment: synced.comment,
        linkedPulls: {
          400: {
            number: 400,
            title: "Provider cleanup",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "closed",
            merged_at: "2026-05-02T00:00:00Z",
            body: "Includes the fallback route behavior from PR 353.",
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
            runOpenClawApplyDecisionsForTest({
              itemsDir,
              closedDir,
              plansDir,
              reportPath,
            });
          },
        );
      },
    );

    report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
      action: string;
      reason: string;
    }>;
    assert.equal(
      report.some((entry) => entry.action === "closed"),
      true,
    );
    assert.equal(readFileSync(proofLogPath, "utf8").trim().split("\n").length, 2);
    assert.ok(existsSync(join(closedDir, "353.md")));
  });
});

test("apply-decisions checks age before duplicate PR coverage proof", () => {
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
        number: 351,
        title: "Provider route fallback",
        close_reason: "duplicate_or_superseded",
        work_cluster_refs: JSON.stringify([
          "Superseded by https://github.com/openclaw/openclaw/pull/400",
        ]),
      }).replace(
        "Closing this PR because the branch is not a useful landing base.",
        "Closing this PR as superseded by https://github.com/openclaw/openclaw/pull/400.",
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
        comment: synced.comment,
        linkedPulls: {
          400: {
            number: 400,
            title: "Provider cleanup",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "closed",
            merged_at: "2026-05-02T00:00:00Z",
            body: "Includes the fallback route behavior from PR 351.",
            comments: [],
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
              "--min-age-days",
              "99999",
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
      report.find((entry) => entry.action === "kept_open")?.reason ?? "",
      /created less than or equal to 99999 days ago/,
    );
    assert.doesNotMatch(JSON.stringify(report), /proof should not run/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions ignores unrelated unsafe PR links when canonical PR is safe", () => {
  withApplyTestWorkspace(tmpPrefix, ({ root, itemsDir, closedDir, plansDir, reportPath }) => {
    const reportMarkdown = lowSignalCloseReport({
      number: 347,
      title: "Already proposed duplicate close",
      close_reason: "duplicate_or_superseded",
      work_cluster_refs: JSON.stringify(["https://github.com/openclaw/openclaw/pull/401"]),
    }).replace(
      "Closing this PR because the branch is not a useful landing base.",
      [
        "Closing this PR as superseded by https://github.com/openclaw/openclaw/pull/400.",
        "",
        "Earlier context also mentioned https://github.com/openclaw/openclaw/pull/401.",
      ].join("\n"),
    );
    const synced = reportWithSyncedReviewComment(reportMarkdown, 347, "duplicate_or_superseded");
    writeFileSync(join(itemsDir, "347.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 347,
        title: "Already proposed duplicate close",
        comment: synced.comment,
        linkedPulls: {
          400: {
            number: 400,
            title: "Merged canonical PR",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "closed",
            merged_at: "2026-05-02T00:00:00Z",
            labels: [],
          },
          401: {
            number: 401,
            title: "Unrelated closed PR",
            html_url: "https://github.com/openclaw/openclaw/pull/401",
            state: "closed",
            merged_at: null,
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
            reason: "PR B is the merged canonical PR covering PR A.",
          },
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
      },
    );

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{ action: string }>;
    assert.equal(
      report.some((entry) => entry.action === "closed"),
      true,
    );
  });
});

test("apply-decisions blocks duplicate close when canonical PR is a bare cluster ref", () => {
  withApplyTestWorkspace(tmpPrefix, ({ root, itemsDir, closedDir, plansDir, reportPath }) => {
    const synced = reportWithSyncedReviewComment(
      lowSignalCloseReport({
        number: 341,
        title: "Already proposed duplicate close",
        close_reason: "duplicate_or_superseded",
        work_cluster_refs: JSON.stringify(["https://github.com/openclaw/openclaw/pull/400"]),
      }),
      341,
      "duplicate_or_superseded",
    );
    writeFileSync(join(itemsDir, "341.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 341,
        title: "Already proposed duplicate close",
        comment: boundDuplicateCloseComment(341, "https://github.com/openclaw/openclaw/pull/400"),
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
        runOpenClawApplyDecisionsForTest({
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
          dryRun: true,
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
  });
});

test("apply-decisions retries duplicate close when linked canonical PR comments cannot be read", () => {
  withApplyTestWorkspace(tmpPrefix, ({ root, itemsDir, closedDir, plansDir, reportPath }) => {
    const synced = reportWithSyncedReviewComment(
      lowSignalCloseReport({
        number: 340,
        title: "Already proposed duplicate close",
        close_reason: "duplicate_or_superseded",
        work_cluster_refs: JSON.stringify([
          "Superseded by https://github.com/openclaw/openclaw/pull/400",
        ]),
      }),
      340,
      "duplicate_or_superseded",
    );
    writeFileSync(join(itemsDir, "340.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 340,
        title: "Already proposed duplicate close",
        comment: synced.comment,
        linkedPulls: {
          400: {
            number: 400,
            title: "Provider cleanup",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "closed",
            merged_at: "2026-05-02T00:00:00Z",
            body: "Includes the provider cleanup from PR 340.",
            comments: [{ body: "temporary hydration target" }],
            commentsError: "temporary comments outage",
            labels: [],
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
      /temporary comments outage/,
    );
  });
});
