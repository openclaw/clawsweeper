import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createApplyCloseGuards } from "../dist/clawsweeper-apply-close-guards.js";
import {
  evaluateApplyClosePolicy,
  evaluateApplyCloseReasonPolicy,
  liveApplyCloseReasonPolicyBlock,
} from "../dist/clawsweeper-apply-close-policies.js";
import { LiveReadGeneration } from "../dist/live-read-generation.js";
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
        resetGuardReadCache: () => {},
        withGuardReadOptions: (_options, read) => read(),
        ghJson: () => ({}),
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
        openReportEntry: (number) =>
          number === 320
            ? { name: "320.md", number: 320, path, repo: "openclaw/openclaw", markdown }
            : undefined,
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

test("terminal reason policy bypasses an unchanged live-read generation", () => {
  const generation = new LiveReadGeneration();
  let options = {};
  let liveReason: string | null = null;
  let reads = 0;
  const readReason = () =>
    generation.read(
      "policy",
      () => {
        reads++;
        return liveReason;
      },
      options,
    );
  const dependencies = {
    resetGuardReadCache: () => {},
    withGuardReadOptions: (next, read) => {
      const previous = options;
      options = next;
      try {
        return read();
      } finally {
        options = previous;
      }
    },
    closeReasonEnabled: () => true,
    ghJson: () => ({}),
  } as never;
  const policy = {
    closeReason: "stale_version_bug",
    currentStaleVersionBugBlockReason: readReason,
    item: currentItem,
    markdown: "",
    number: 321,
    storedUpdatedAt: currentItem.updatedAt,
  } as const;
  assert.equal(
    evaluateApplyClosePolicy(dependencies, {
      ...policy,
      phase: "before-canonical",
      applyCloseReasons: null,
      applyKind: "all",
      isCloseProposal: true,
      state: "open",
      syncCommentsOnly: false,
    } as never).block,
    null,
  );
  liveReason = "fresh policy drift";
  assert.equal(readReason(), null);
  assert.equal(
    liveApplyCloseReasonPolicyBlock(dependencies, policy as never)?.reason,
    "fresh policy drift",
  );
  assert.equal(reads, 2);
});

test("shared reason evaluation preserves repository-managed PR protection", () => {
  const managed = { ...currentItem, repo: "openclaw/openclaw", author: "openclaw-mantis[bot]" };
  const result = evaluateApplyCloseReasonPolicy(
    {
      ghJson: () => ({
        user: { login: managed.author },
        head: { ref: "automation/native-app-locale-refresh", repo: { full_name: managed.repo } },
        base: { ref: "main", repo: { full_name: managed.repo } },
      }),
    } as never,
    {
      item: managed,
      number: managed.number,
      closeReason: "implemented_on_main",
      phase: "before-canonical",
    } as never,
  );
  assert.match(result.block?.reason ?? "", /repository-managed locale PR/);
});
