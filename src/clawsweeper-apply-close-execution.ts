import type { CreateApplyDecisionWorkflowDependencies } from "./clawsweeper-apply-dependencies.js";
import { closeReasonText } from "./clawsweeper-close-reasons.js";
import {
  EVENT_GUARDED_OPEN_ACTIONS,
  REVIEW_SECTIONS,
  STALE_INSUFFICIENT_INFO_MIN_INACTIVE_DAYS,
} from "./clawsweeper-policy.js";
import type {
  ActionTaken,
  ApplyKind,
  ApplyResult,
  AuthorPrBudgetApplyGate,
  CloseReason,
  GitHubRuntimeBudget,
  Item,
  PrCloseCoverageProofGateBlock,
  PrCloseCoverageProofGateResult,
} from "./clawsweeper-types.js";
import type { MaintainerDecision } from "./decision-packets.js";
import { IDEA_ARCHIVE_LABEL } from "./idea-archive-revival.js";
import {
  isGitHubRequiresAuthenticationError,
  isLockedConversationCommentError,
} from "./github-retry.js";

type ApplyCloseExecutionDependencies = Pick<
  CreateApplyDecisionWorkflowDependencies,
  | "abandonedPrApplyBlockReasonSafe"
  | "addIssueLabel"
  | "applyPrCloseCoverageProofReportSection"
  | "closeItem"
  | "closeReasonApplyAgeSkipReason"
  | "closeReasonEnabled"
  | "duplicateCanonicalPullRequestBlockReason"
  | "ensureCloseAppliedComment"
  | "ensureIdeaArchiveLabel"
  | "ensureRuntimeDelayFits"
  | "GitHubRuntimeBudgetError"
  | "implementedOnMainPullRequestProvenanceApplyBlock"
  | "issueRecentHumanCommentBlockReasonSafe"
  | "lowSignalUnmergeablePrApplyBlockReasonSafe"
  | "normalizeLabelName"
  | "removeCurrentCursorTraceItem"
  | "replaceFrontMatterValue"
  | "replaceSectionValue"
  | "reportDecision"
  | "sha256"
  | "sleepMs"
  | "stalledUnprovenPrApplyBlockReasonSafe"
  | "unsponsoredFeatureApplyBlockReasonSafe"
  | "validateCloseDecision"
>;

type ApplyCloseFlow = "next" | "stop" | "yield";
type ReviewFreshnessBlock = {
  reason: string;
  currentUpdatedAt?: string;
  currentSnapshotHash?: string;
};

export function implementedOnMainCloseProvenanceBlock(
  markdown: string,
  itemKind: Item["kind"],
  itemNumber: number,
  closeReason: CloseReason,
): string | null {
  if (
    itemKind !== "pull_request" ||
    !["implemented_on_main", "mostly_implemented_on_main"].includes(closeReason)
  ) {
    return null;
  }
  const fixedPrUrl = markdown.match(/^fixed_pr_url: (.+)$/m)?.[1]?.trim();
  const repository = markdown.match(/^repository: (.+)$/m)?.[1]?.trim();
  const fixedPrNumber = markdown.match(/^fixed_pr_number: (\d+)$/m)?.[1]?.trim();
  const fixedPrConfidence = markdown.match(/^fixed_pr_confidence: (.+)$/m)?.[1]?.trim();
  const fixedPrSource = markdown.match(/^fixed_pr_source: (.+)$/m)?.[1]?.trim();
  const fixedPrMergedAt = markdown.match(/^fixed_pr_merged_at: (.+)$/m)?.[1]?.trim();
  if (
    fixedPrUrl &&
    repository &&
    fixedPrNumber &&
    fixedPrNumber !== String(itemNumber) &&
    fixedPrUrl === `https://github.com/${repository}/pull/${fixedPrNumber}` &&
    fixedPrConfidence === "high" &&
    fixedPrSource &&
    fixedPrSource !== "unknown" &&
    fixedPrSource.includes("GitHub ") &&
    fixedPrMergedAt &&
    fixedPrMergedAt !== "unknown"
  ) {
    return null;
  }
  return "implemented-on-main close requires a GitHub-verified, same-repository merged fixing pull request";
}

interface ApplyCloseExecutionOptions {
  applyCloseReasons: ReadonlySet<CloseReason> | null;
  applyKind: ApplyKind;
  archiveClosed: (markdown: string) => void;
  closeDelayMs: number;
  closeLimitReached: boolean;
  closeReason: CloseReason;
  closedDir: string;
  currentApplyMutationLeaseBlockReason: () => string | null;
  currentAuthorPrBudgetApplyGate: () => AuthorPrBudgetApplyGate;
  currentObsoleteFixPrBlockReason: () => string | null;
  currentPrCloseCoverageProofGateBlock: () => PrCloseCoverageProofGateBlock | null;
  currentStaleVersionBugBlockReason: () => string | null;
  dryRun: boolean;
  examinedItemNumbers: number[];
  getMarkdown: () => string;
  isRetryableSkippedClose: boolean;
  item: Item;
  itemsDir: string;
  logProgress: (message: string) => void;
  markApplySkipped: (action: ActionTaken, reason: string, liveGuardVerified?: boolean) => boolean;
  markChangedSinceReview: (block: ReviewFreshnessBlock) => boolean;
  minAgeDescription: string;
  minAgeMs: number;
  number: number;
  onClosed: (result: ApplyResult, dryRun: boolean) => boolean;
  postProofCoveringPrFreshnessBlock: () => PrCloseCoverageProofGateBlock | null;
  postProofFreshnessBlock: () => ReviewFreshnessBlock | null;
  proofResult: () => PrCloseCoverageProofGateResult | undefined;
  recordApplySkipped: (action: ActionTaken, reason: string) => boolean;
  recordMutation: (parentEventId?: string | null) => void;
  rememberSelfMutationUpdatedAt: (options?: {
    allowsPostReviewAutomationActivity?: boolean;
  }) => void;
  recordReviewLeaseSkip: (reason: string, preserveLease?: boolean) => boolean;
  recordRuntimeBudgetYield: (reason: string) => void;
  repo: string;
  requiredMaintainerDecision: MaintainerDecision | null;
  reviewComment: string;
  runtimeBudget: GitHubRuntimeBudget;
  setMarkdown: (markdown: string) => void;
  staleMinAgeDays: number;
  emitEventApplyProof: boolean;
}

export function executeApplyClose(
  dependencies: ApplyCloseExecutionDependencies,
  options: ApplyCloseExecutionOptions,
): ApplyCloseFlow {
  const {
    abandonedPrApplyBlockReasonSafe,
    addIssueLabel,
    applyPrCloseCoverageProofReportSection,
    closeItem,
    closeReasonApplyAgeSkipReason,
    closeReasonEnabled,
    duplicateCanonicalPullRequestBlockReason,
    ensureCloseAppliedComment,
    ensureIdeaArchiveLabel,
    ensureRuntimeDelayFits,
    GitHubRuntimeBudgetError,
    implementedOnMainPullRequestProvenanceApplyBlock,
    issueRecentHumanCommentBlockReasonSafe,
    lowSignalUnmergeablePrApplyBlockReasonSafe,
    normalizeLabelName,
    removeCurrentCursorTraceItem,
    replaceFrontMatterValue,
    replaceSectionValue,
    reportDecision,
    sha256,
    sleepMs,
    stalledUnprovenPrApplyBlockReasonSafe,
    unsponsoredFeatureApplyBlockReasonSafe,
    validateCloseDecision,
  } = dependencies;
  const {
    applyCloseReasons,
    applyKind,
    archiveClosed,
    closeDelayMs,
    closeLimitReached,
    closeReason,
    closedDir,
    currentApplyMutationLeaseBlockReason,
    currentAuthorPrBudgetApplyGate,
    currentObsoleteFixPrBlockReason,
    currentPrCloseCoverageProofGateBlock,
    currentStaleVersionBugBlockReason,
    dryRun,
    emitEventApplyProof,
    examinedItemNumbers,
    getMarkdown,
    isRetryableSkippedClose,
    item,
    itemsDir,
    logProgress,
    markApplySkipped,
    markChangedSinceReview,
    minAgeDescription,
    minAgeMs,
    number,
    onClosed,
    postProofCoveringPrFreshnessBlock,
    postProofFreshnessBlock,
    proofResult,
    recordApplySkipped,
    recordMutation,
    rememberSelfMutationUpdatedAt,
    recordReviewLeaseSkip,
    recordRuntimeBudgetYield,
    repo,
    requiredMaintainerDecision,
    reviewComment,
    runtimeBudget,
    setMarkdown,
    staleMinAgeDays,
  } = options;
  const skip = (action: ActionTaken, reason: string, liveGuardVerified = false): ApplyCloseFlow =>
    markApplySkipped(action, reason, liveGuardVerified) ? "stop" : "next";
  const recordSkip = (action: ActionTaken, reason: string): ApplyCloseFlow =>
    recordApplySkipped(action, reason) ? "stop" : "next";
  const skipLease = (reason: string): ApplyCloseFlow =>
    recordReviewLeaseSkip(reason, false) ? "stop" : "next";

  if (
    requiredMaintainerDecision?.required &&
    closeReason !== "unsponsored_feature_request" &&
    closeReason !== "author_pr_budget_exceeded"
  ) {
    return skip(
      "kept_open",
      `maintainer decision required: ${requiredMaintainerDecision.question}`,
    );
  }
  if (closeLimitReached) {
    removeCurrentCursorTraceItem(examinedItemNumbers, number);
    return "stop";
  }
  if (applyKind !== "all" && item.kind !== applyKind) {
    return recordSkip("kept_open", `type is ${item.kind}; apply kind is ${applyKind}`);
  }
  if (!closeReasonEnabled(closeReason, applyCloseReasons)) {
    return recordSkip("kept_open", `close reason ${closeReason} is not enabled for this apply run`);
  }
  const implementationProvenanceBlock = implementedOnMainCloseProvenanceBlock(
    getMarkdown(),
    item.kind,
    item.number,
    closeReason,
  );
  if (implementationProvenanceBlock) return skip("kept_open", implementationProvenanceBlock);
  const currentImplementationProvenanceBlock = implementedOnMainPullRequestProvenanceApplyBlock(
    getMarkdown(),
    item,
    closeReason,
  );
  if (currentImplementationProvenanceBlock) {
    return skip("kept_open", currentImplementationProvenanceBlock);
  }

  const currentReportValidation = validateCloseDecision(
    { repo, kind: item.kind, labels: item.labels, authorAssociation: item.authorAssociation },
    reportDecision(getMarkdown(), closeReason),
    { requireCloseComment: !isRetryableSkippedClose },
  );
  if (!currentReportValidation.ok && currentReportValidation.actionTaken !== "kept_open") {
    return skip(
      currentReportValidation.actionTaken,
      currentReportValidation.reason,
      EVENT_GUARDED_OPEN_ACTIONS.has(currentReportValidation.actionTaken),
    );
  }
  const duplicateCanonicalBlock = (): string | null =>
    closeReason === "duplicate_or_superseded"
      ? duplicateCanonicalPullRequestBlockReason(getMarkdown(), item, {
          reportDirs: [itemsDir, closedDir],
        })
      : null;
  const earlyDuplicateCanonicalBlock = duplicateCanonicalBlock();
  if (earlyDuplicateCanonicalBlock) return skip("kept_open", earlyDuplicateCanonicalBlock);

  const ageSkipReason = closeReasonApplyAgeSkipReason(item, closeReason, {
    minAgeMs,
    minAgeDescription,
    staleMinAgeDays,
  });
  if (ageSkipReason) return recordSkip("kept_open", ageSkipReason);

  const proofBlock =
    closeReason === "duplicate_or_superseded" ? currentPrCloseCoverageProofGateBlock() : null;
  if (proofBlock) {
    if (proofBlock.actionTaken === "skipped_runtime_budget") {
      recordRuntimeBudgetYield(proofBlock.reason);
      return "stop";
    }
    return skip(proofBlock.actionTaken, proofBlock.reason);
  }
  const lateDuplicateCanonicalBlock = duplicateCanonicalBlock();
  if (lateDuplicateCanonicalBlock) return skip("kept_open", lateDuplicateCanonicalBlock);
  const coveringFreshnessBlock = postProofCoveringPrFreshnessBlock();
  if (coveringFreshnessBlock) {
    return skip(coveringFreshnessBlock.actionTaken, coveringFreshnessBlock.reason);
  }
  const freshnessBlock = postProofFreshnessBlock();
  if (freshnessBlock) return markChangedSinceReview(freshnessBlock) ? "stop" : "next";
  if (closeReason === "duplicate_or_superseded") {
    setMarkdown(applyPrCloseCoverageProofReportSection(getMarkdown(), proofResult()));
  }

  if (closeReason === "low_signal_unmergeable_pr") {
    const reason = lowSignalUnmergeablePrApplyBlockReasonSafe(number, staleMinAgeDays);
    if (reason) return skip("skipped_low_signal_live_guard", reason, true);
  }
  const inactivityPolicy = {
    stalled_unproven_pr: () => stalledUnprovenPrApplyBlockReasonSafe(number, item),
    abandoned_pr: () => abandonedPrApplyBlockReasonSafe(number, item),
    unsponsored_feature_request: () => unsponsoredFeatureApplyBlockReasonSafe(number, item),
    author_pr_budget_exceeded: () => {
      const gate = currentAuthorPrBudgetApplyGate();
      return gate.allowed ? null : gate.reason;
    },
    stale_version_bug: currentStaleVersionBugBlockReason,
    obsolete_fix_pr: currentObsoleteFixPrBlockReason,
    stale_insufficient_info: () =>
      issueRecentHumanCommentBlockReasonSafe(number, STALE_INSUFFICIENT_INFO_MIN_INACTIVE_DAYS),
  } satisfies Partial<Record<CloseReason, () => string | null>>;
  const inactivityCloseBlockReason =
    closeReason in inactivityPolicy
      ? inactivityPolicy[closeReason as keyof typeof inactivityPolicy]()
      : null;
  if (inactivityCloseBlockReason) return skip("kept_open", inactivityCloseBlockReason);

  const closeMutationLeaseBlockReason = currentApplyMutationLeaseBlockReason();
  if (closeMutationLeaseBlockReason) return skipLease(closeMutationLeaseBlockReason);
  logProgress(`closing #${number}`);
  let closeAppliedCommentReason: string | null = null;
  if (dryRun) {
    const finalImplementationProvenanceBlock = implementedOnMainPullRequestProvenanceApplyBlock(
      getMarkdown(),
      item,
      closeReason,
    );
    if (finalImplementationProvenanceBlock) {
      return skip("kept_open", finalImplementationProvenanceBlock);
    }
    closeAppliedCommentReason =
      item.kind === "pull_request"
        ? ensureCloseAppliedComment({
            number,
            closeReason,
            markdown: getMarkdown(),
            itemUrl: item.url,
            dryRun,
          })
        : null;
    const stop = onClosed(
      {
        number,
        action: "closed",
        reason: [
          `dry-run: would close as ${closeReasonText(closeReason)}`,
          closeAppliedCommentReason,
        ]
          .filter(Boolean)
          .join("; "),
      },
      true,
    );
    return stop ? "stop" : "next";
  }

  const preCloseMutationLeaseBlockReason = currentApplyMutationLeaseBlockReason();
  if (preCloseMutationLeaseBlockReason) return skipLease(preCloseMutationLeaseBlockReason);
  ensureRuntimeDelayFits(closeDelayMs, "before close");
  try {
    closeAppliedCommentReason =
      item.kind === "pull_request"
        ? ensureCloseAppliedComment({
            number,
            closeReason,
            markdown: getMarkdown(),
            itemUrl: item.url,
            dryRun,
          })
        : null;
  } catch (error) {
    if (isGitHubRequiresAuthenticationError(error)) {
      return skip(
        "skipped_comment_auth",
        "GitHub rejected closeout evidence comment write with Requires authentication",
      );
    }
    if (isLockedConversationCommentError(error)) {
      return skip(
        "skipped_locked_conversation",
        "conversation was locked while recording closeout evidence",
        true,
      );
    }
    throw error;
  }
  if (/^(?:posted|updated) close-applied comment$/.test(closeAppliedCommentReason ?? "")) {
    // The comment updates the PR's activity timestamp. Admit only this verified
    // self-mutation before the final freshness guard; it still rejects any
    // intervening contributor activity or source/head drift.
    rememberSelfMutationUpdatedAt({ allowsPostReviewAutomationActivity: true });
  }
  const finalFreshnessBlock = postProofFreshnessBlock();
  if (finalFreshnessBlock) return markChangedSinceReview(finalFreshnessBlock) ? "stop" : "next";
  const finalCoveringPrFreshnessBlock = postProofCoveringPrFreshnessBlock();
  if (finalCoveringPrFreshnessBlock) {
    return skip(finalCoveringPrFreshnessBlock.actionTaken, finalCoveringPrFreshnessBlock.reason);
  }
  // Preserve the archive label after an uncertain close; the revival watcher reconciles it.
  // The earlier check avoids unnecessary apply work; this one closes the race with the mutation.
  const finalImplementationProvenanceBlock = implementedOnMainPullRequestProvenanceApplyBlock(
    getMarkdown(),
    item,
    closeReason,
  );
  if (finalImplementationProvenanceBlock) {
    return skip("kept_open", finalImplementationProvenanceBlock);
  }
  if (closeReason === "unsponsored_feature_request") {
    const needsIdeaArchiveLabel = !item.labels.map(normalizeLabelName).includes(IDEA_ARCHIVE_LABEL);
    ensureIdeaArchiveLabel(recordMutation);
    if (needsIdeaArchiveLabel) {
      addIssueLabel(number, IDEA_ARCHIVE_LABEL, recordMutation);
      item.labels.push(IDEA_ARCHIVE_LABEL);
      setMarkdown(replaceFrontMatterValue(getMarkdown(), "labels", JSON.stringify(item.labels)));
    }
  }
  const finalCloseMutationLeaseBlockReason = currentApplyMutationLeaseBlockReason();
  if (finalCloseMutationLeaseBlockReason) return skipLease(finalCloseMutationLeaseBlockReason);
  closeItem({ number, kind: item.kind, reason: closeReason });
  let postCloseRuntimeYieldReason: string | null = null;
  try {
    ensureRuntimeDelayFits(closeDelayMs, "before close delay");
    sleepMs(closeDelayMs);
  } catch (error) {
    if (!(error instanceof GitHubRuntimeBudgetError)) throw error;
    postCloseRuntimeYieldReason = error.reason;
  }

  let markdown = replaceSectionValue(getMarkdown(), REVIEW_SECTIONS.closeComment, reviewComment);
  markdown = replaceFrontMatterValue(markdown, "close_comment_sha256", sha256(reviewComment));
  markdown = replaceFrontMatterValue(markdown, "action_taken", "closed");
  markdown = replaceFrontMatterValue(markdown, "applied_at", new Date().toISOString());
  markdown = replaceFrontMatterValue(markdown, "apply_checked_at", new Date().toISOString());
  setMarkdown(markdown);
  archiveClosed(markdown);
  const stop = onClosed(
    {
      number,
      action: "closed",
      reason: [closeReasonText(closeReason), closeAppliedCommentReason].filter(Boolean).join("; "),
      ...(emitEventApplyProof ? { terminalStateVerified: true } : {}),
    },
    false,
  );
  if (postCloseRuntimeYieldReason) {
    runtimeBudget.onYield?.(postCloseRuntimeYieldReason, false);
    return "yield";
  }
  return stop ? "stop" : "next";
}
