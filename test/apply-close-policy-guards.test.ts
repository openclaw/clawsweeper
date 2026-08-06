import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createApplyCloseGuards } from "../dist/clawsweeper-apply-close-guards.js";
import { executeApplyClose } from "../dist/clawsweeper-apply-close-execution.js";
import type { ReportEntry } from "../src/clawsweeper-types.ts";
import { implementedCloseReport, item, tmpPrefix } from "./helpers.ts";

const currentItem = {
  ...item(),
  number: 321,
  kind: "pull_request" as const,
  author: "reporter",
  authorAssociation: "CONTRIBUTOR",
};
function counterpartAdmission(
  closeReason: "implemented_on_main" | "stale_version_bug" | "stale_insufficient_info",
  changeAfterAdmission: "locked" | "closed" | "unknown" | null = null,
) {
  const root = mkdtempSync(tmpPrefix);
  try {
    const path = join(root, "320.md");
    const markdown = implementedCloseReport({
      repository: "openclaw/openclaw",
      number: 320,
      type: "issue",
      title: "Paired issue",
      author: "reporter",
      close_reason: closeReason,
      item_category: "bug",
      item_created_at: "2026-01-01T00:00:00Z",
      item_updated_at: "2026-01-01T00:00:00Z",
    });
    writeFileSync(path, markdown, "utf8");
    const counterpartItem = { ...currentItem, number: 320, kind: "issue" as const };
    const fileEntries: ReportEntry[] = [];
    let liveLocked = false;
    let liveState = changeAfterAdmission === "closed" ? "closed" : "open";
    let reviewStateReads = 0;
    const frontMatterValue = (source: string, key: string) =>
      new RegExp(`^${key}: (.*)$`, "m").exec(source)?.[1];
    const guards = createApplyCloseGuards(
      {
        applyBlockingProtectedLabels: () => [],
        closeReasonApplyAgeSkipReason: () => null,
        closeReasonEnabled: () => true,
        closingPullRequestsForIssue: () => [],
        collectItemContext: () => ({ relatedItems: [] }),
        commentBodyMatches: () => true,
        commentUpdatedAt: () => counterpartItem.updatedAt,
        duplicateCanonicalPullRequestBlockReason: () => null,
        fetchItem: () => ({ item: counterpartItem, state: liveState }),
        frontMatterValue,
        hasAutoCloseAllowedMetadata: () => true,
        hasVerifiedLocalCheckoutAccess: () => true,
        isApplyCloseCandidateReport: () => true,
        isMaintainerAuthorAssociation: () => false,
        isRetryableCloseSkipReport: () => false,
        issueRecentHumanCommentBlockReasonFromComments: () =>
          closeReason === "stale_insufficient_info"
            ? "issue has a non-bot comment within the last 60 days"
            : null,
        issueRecentHumanCommentBlockReasonSafe: () => {
          throw new Error("counterpart policy must reuse the complete comment read");
        },
        issueReviewCommentState: () => {
          reviewStateReads += 1;
          return { comments: [{}], reviewComment: { updated_at: counterpartItem.updatedAt } };
        },
        isVerifiedFixedCloseReason: () => false,
        itemSnapshotHash: () => "reviewed-snapshot",
        lockedConversationApplyReason: () => (liveLocked ? "conversation is locked" : null),
        markdownRepository: () => "openclaw/openclaw",
        markedReviewCommentBody: (_number: number, body: string) => body,
        normalizeAuthorAssociation: (value: unknown) => (typeof value === "string" ? value : ""),
        openClosingPullRequestApplyReason: () => null,
        renderReviewCommentFromReport: () => "review",
        reportCloseReason: () => closeReason,
        reportDecision: () => ({}),
        reportItemKind: () => "issue",
        reviewCommentBodyDigest: () => "digest",
        reviewCommentHashMatches: () => true,
        reviewSectionValue: () => "",
        sameAuthorCounterpartApplyReason: () => null,
        shouldSyncReviewComment: () => false,
        staleVersionBugApplyBlockReasonSafe: () =>
          closeReason === "stale_version_bug" ? "stale-version bug apply policy is disabled" : null,
        validateCloseDecision: () => ({ ok: true }),
      } as never,
      {
        applyCloseReasons: null,
        applyKind: "all",
        canClosePairCounterpartInThisRun: () => false,
        closedDir: join(root, "closed"),
        commentSyncMinAgeDays: 0,
        currentCloseState: () => ({
          closedCount: 0,
          closeReason: "implemented_on_main",
          markdown: "",
          needsReviewCommentSync: false,
          processedCount: 0,
          storedUpdatedAt: currentItem.updatedAt,
        }),
        currentPrCloseCoverageProofGateBlock: () => null,
        fileEntries,
        isRetryableSkippedClose: false,
        item: currentItem,
        itemsDir: root,
        limit: 2,
        minAgeDescription: "0 days",
        minAgeMs: 0,
        number: currentItem.number,
        openFileEntryByNumber: new Map([
          [320, { name: "320.md", number: 320, path, repo: "openclaw/openclaw", markdown }],
        ]),
        processedLimit: 2,
        repo: "openclaw/openclaw",
        requiredMaintainerDecision: null,
        staleMinAgeDays: 0,
      },
    );
    const admitted = guards.canStartSameAuthorPairCloseInThisRun(320, "issue");
    liveLocked = changeAfterAdmission === "locked";
    liveState =
      changeAfterAdmission === "closed" || changeAfterAdmission === "unknown"
        ? changeAfterAdmission
        : "open";
    const revalidated =
      !changeAfterAdmission || guards.canStartSameAuthorPairCloseInThisRun(320, "issue");
    return { admitted, fileEntries, revalidated, reviewStateReads };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
for (const closeReason of ["stale_version_bug", "stale_insufficient_info"] as const) {
  test(`same-author pair preflight blocks ${closeReason} counterpart policy`, () => {
    const r = counterpartAdmission(closeReason);
    assert.deepEqual([r.admitted, r.fileEntries.length, r.reviewStateReads], [false, 0, 1]);
  });
}
for (const change of ["locked", "closed", "unknown"] as const) {
  test(`same-author pair revalidation handles counterpart state ${change}`, () => {
    const { admitted, fileEntries, revalidated } = counterpartAdmission(
      "implemented_on_main",
      change,
    );
    assert.deepEqual([admitted, revalidated, fileEntries.length], [true, change === "closed", 1]);
  });
}
for (const [closeReason, dryRun, blockOnRead, pairBlockOn] of [
  ["stale_version_bug", false, 1, 0],
  ["stale_version_bug", false, 2, 0],
  ["obsolete_fix_pr", false, 2, 0],
  ["stale_version_bug", true, 0, 1],
  ["stale_version_bug", false, 0, 2],
] as const) {
  test(`${dryRun ? "dry-run pair" : `${closeReason} policy read ${blockOnRead}`} blocks before close`, () => {
    let policyReads = 0;
    const order: string[] = [];
    const record = (step: string, result: null | false) => () => (order.push(step), result);
    const livePolicyReason = () => {
      order.push(closeReason);
      return !dryRun && ++policyReads === blockOnRead ? `fresh ${closeReason} blocker` : null;
    };
    executeApplyClose(
      {
        closeReasonApplyAgeSkipReason: () => null,
        closeReasonEnabled: () => true,
        ensureRuntimeDelayFits: () => {},
        ensureCloseAppliedComment: record("comment", null),
        obsoleteFixPrApplyBlockReasonSafe: () =>
          closeReason === "obsolete_fix_pr" ? livePolicyReason() : null,
        reportDecision: () => ({}),
        staleVersionBugApplyBlockReasonSafe: () =>
          closeReason === "stale_version_bug" ? livePolicyReason() : null,
        validateCloseDecision: () => ({ ok: true }),
      } as never,
      {
        applyKind: "all",
        closeLimitReached: false,
        closeReason,
        currentApplyMutationLeaseBlockReason: record("lease", null),
        currentSameAuthorPairBlockReason: () => {
          order.push("pair");
          return order.filter((step) => step === "pair").length === pairBlockOn
            ? "paired issue changed"
            : null;
        },
        dryRun,
        getMarkdown: () => "",
        item: currentItem,
        logProgress: () => {},
        markApplySkipped: record("skip", false),
        postProofCoveringPrFreshnessBlock: () => null,
        postProofFreshnessBlock: () => null,
      } as never,
    );
    const expected = ["lease", closeReason];
    if (blockOnRead !== 1) expected.push("pair");
    if (!dryRun && blockOnRead !== 1) expected.push("comment", "lease", closeReason);
    if (pairBlockOn === 2) expected.push("pair");
    expected.push("skip");
    assert.deepEqual(order, expected);
  });
}
