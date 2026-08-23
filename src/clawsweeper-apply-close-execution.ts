import type { CreateApplyDecisionWorkflowDependencies } from "./clawsweeper-apply-dependencies.js";
import { closeReasonText } from "./clawsweeper-close-reasons.js";
import { linkedIssueNumbersForImplementationProvenance } from "./clawsweeper-status-context.js";
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
import { stableJson } from "./stable-json.js";

type ApplyCloseExecutionDependencies = Pick<
  CreateApplyDecisionWorkflowDependencies,
  | "CLAWSWEEPER_BOT_AUTHORS"
  | "asRecord"
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
  | "fetchIssueReviewComments"
  | "fetchItem"
  | "frontMatterValue"
  | "GitHubRuntimeBudgetError"
  | "ghJson"
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
  archivePairedIssue: (number: number) => void;
  canStartPairedIssueClose: (number: number, kind: Item["kind"]) => boolean;
  pairedIssueMarkdown: (number: number) => string | null;
  pairedIssueReviewUpdatedAt: (number: number) => string | null;
  pairedIssueOwnedReviewCommentUpdatedAt: (number: number) => string | null;
  pairedIssueCanonicalProvenanceBlock: (number: number) => string | null;
  closeDelayMs: number;
  closeLimitReached: boolean;
  pairedIssueCloseCapacityAvailable: boolean;
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
  onPairedIssueClosed: (result: ApplyResult, dryRun: boolean) => boolean;
  postProofCoveringPrFreshnessBlock: () => PrCloseCoverageProofGateBlock | null;
  postProofFreshnessBlock: () => ReviewFreshnessBlock | null;
  proofResult: () => PrCloseCoverageProofGateResult | undefined;
  recordApplySkipped: (action: ActionTaken, reason: string) => boolean;
  recordMutation: (parentEventId?: string | null) => void;
  rememberSelfMutationUpdatedAt: (options?: {
    postReviewActivityStartedAtMs?: number;
    requiresReviewedPrActivityCursor?: boolean;
  }) => boolean;
  recordReviewLeaseSkip: (reason: string, preserveLease?: boolean) => boolean;
  recordRuntimeBudgetYield: (reason: string) => void;
  repo: string;
  requiredMaintainerDecision: MaintainerDecision | null;
  reviewComment: string;
  runtimeBudget: GitHubRuntimeBudget;
  setMarkdown: (markdown: string) => void;
  staleMinAgeDays: number;
  withPairedIssueMutationLease: <T>(
    number: number,
    operation: () => T,
    options?: { onOperationCompleted?: () => void },
  ) => T;
  emitEventApplyProof: boolean;
}

export function executeApplyClose(
  dependencies: ApplyCloseExecutionDependencies,
  options: ApplyCloseExecutionOptions,
): ApplyCloseFlow {
  const {
    CLAWSWEEPER_BOT_AUTHORS,
    asRecord,
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
    fetchIssueReviewComments,
    fetchItem,
    frontMatterValue,
    GitHubRuntimeBudgetError,
    ghJson,
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
    archivePairedIssue,
    canStartPairedIssueClose,
    pairedIssueMarkdown,
    pairedIssueReviewUpdatedAt,
    pairedIssueOwnedReviewCommentUpdatedAt,
    pairedIssueCanonicalProvenanceBlock,
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
    onPairedIssueClosed,
    pairedIssueCloseCapacityAvailable,
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
    withPairedIssueMutationLease,
  } = options;
  const skip = (action: ActionTaken, reason: string, liveGuardVerified = false): ApplyCloseFlow =>
    markApplySkipped(action, reason, liveGuardVerified) ? "stop" : "next";
  const recordSkip = (action: ActionTaken, reason: string): ApplyCloseFlow =>
    recordApplySkipped(action, reason) ? "stop" : "next";
  const skipLease = (reason: string): ApplyCloseFlow =>
    recordReviewLeaseSkip(reason, false) ? "stop" : "next";
  const pairedIssueSourceSnapshot = (issueNumber: number): string | null => {
    const issue = ghJson<Record<string, unknown>>(["api", `repos/${repo}/issues/${issueNumber}`]);
    if (typeof issue.title !== "string" || !Array.isArray(issue.labels)) return null;
    const labels = issue.labels
      .map((label) => {
        if (typeof label === "string") return label;
        if (!label || typeof label !== "object" || Array.isArray(label)) return null;
        const name = (label as { name?: unknown }).name;
        return typeof name === "string" ? name : null;
      })
      .filter((label): label is string => label !== null)
      .sort();
    if (labels.length !== issue.labels.length) return null;
    // A comment changes `comments` and may advance `updated_at`; exclude only
    // those self-mutation fields. Keep the rest of the issue representation so
    // changes such as assignees, milestone, state reason, or issue type block
    // the paired close instead of being mistaken for the bot's comment update.
    const { comments: _comments, updated_at: _updatedAt, labels: _rawLabels, ...source } = issue;
    return sha256(stableJson({ ...source, labels }));
  };
  const pairedIssueRecentNonSelfCommentBlockReasonSafe = (
    issueNumber: number,
    reviewedAtMs: number,
  ): string | null => {
    try {
      if (!Number.isFinite(reviewedAtMs)) {
        return "linked issue review timestamp is unavailable for final activity verification";
      }
      const cutoffMs = reviewedAtMs;
      const closeAppliedMarker = `<!-- clawsweeper-close-applied item=${issueNumber} -->`;
      for (const comment of fetchIssueReviewComments(issueNumber)) {
        const record = asRecord(comment);
        const createdAtMs = Date.parse(
          typeof record.created_at === "string" ? record.created_at : "",
        );
        const updatedAtMs = Date.parse(
          typeof record.updated_at === "string" ? record.updated_at : "",
        );
        if (!Number.isFinite(createdAtMs) || !Number.isFinite(updatedAtMs)) {
          return "linked issue comment activity check returned an invalid timestamp";
        }
        if (createdAtMs <= cutoffMs && updatedAtMs <= cutoffMs) continue;
        const user = asRecord(record.user);
        const login = typeof user.login === "string" ? user.login.trim().toLowerCase() : "";
        const body = typeof record.body === "string" ? record.body : "";
        if (
          CLAWSWEEPER_BOT_AUTHORS.has(login) &&
          (body.includes(closeAppliedMarker) ||
            body.includes(`<!-- clawsweeper-review item=${issueNumber}`))
        ) {
          continue;
        }
        return "linked issue has a non-ClawSweeper comment after its independent review";
      }
      return null;
    } catch (error) {
      return `linked issue comment activity check failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  };

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
  const implementationBasedPrClose =
    item.kind === "pull_request" &&
    ["implemented_on_main", "mostly_implemented_on_main"].includes(closeReason);
  const parsedLinkedIssueNumbers = implementationBasedPrClose
    ? (() => {
        const livePull = ghJson<{ body?: unknown }>([
          "api",
          `repos/${repo}/pulls/${number}`,
          "--jq",
          "{body}",
        ]);
        return typeof livePull.body === "string"
          ? linkedIssueNumbersForImplementationProvenance(livePull.body, repo)
          : null;
      })()
    : null;
  const linkedIssueNumbers = parsedLinkedIssueNumbers ?? [];
  // A PR may be only mostly redundant while the single bug it explicitly
  // claims to fix is fully resolved by the canonical implementation.
  const linkedIssueCloseReason: CloseReason = "implemented_on_main";
  const implementationProvenanceBlock = implementedOnMainCloseProvenanceBlock(
    getMarkdown(),
    item.kind,
    item.number,
    closeReason,
  );
  if (implementationProvenanceBlock) return skip("kept_open", implementationProvenanceBlock);
  if (implementationBasedPrClose && !parsedLinkedIssueNumbers) {
    return skip(
      "kept_open",
      "implemented-on-main close requires explicit same-repository linked issues for paired closeout",
    );
  }
  if (implementationBasedPrClose && linkedIssueNumbers.length !== 1) {
    return skip(
      "kept_open",
      "implemented-on-main close requires exactly one explicit same-repository linked issue for paired closeout",
    );
  }
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
  // Keep this baseline from before the final live freshness read. A closeout
  // comment changes the item's timestamp, so a later receipt must still reject
  // contributor activity that lands between this read and comment publication.
  const closeoutActivityBaselineMs = Date.now();
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
  const linkedItems = implementationBasedPrClose
    ? linkedIssueNumbers.map((issueNumber) => fetchItem(issueNumber))
    : [];
  for (const linkedItem of linkedItems) {
    if (linkedItem.item.kind !== "issue") {
      return skip(
        "kept_open",
        "implemented-on-main close found a linked item that is not an issue",
      );
    }
  }
  const linkedIssuesToClose = linkedItems.filter((liveIssue) => liveIssue.state === "open");
  if (linkedIssuesToClose.length > 0 && !pairedIssueCloseCapacityAvailable) {
    return skip(
      "kept_open",
      "implemented-on-main paired closeout exceeds the remaining close or processed-item limit",
    );
  }
  if (
    linkedIssuesToClose.length > 0 &&
    (applyKind !== "all" || !canStartPairedIssueClose(linkedIssuesToClose[0]!.item.number, "issue"))
  ) {
    return skip(
      "kept_open",
      "implemented-on-main paired closeout requires an eligible, independently reviewed linked issue in an all-items apply run",
    );
  }
  for (const liveIssue of linkedIssuesToClose) {
    const pairedIssueProvenanceBlock = pairedIssueCanonicalProvenanceBlock(liveIssue.item.number);
    if (pairedIssueProvenanceBlock) return skip("kept_open", pairedIssueProvenanceBlock);
    const pairedMarkdown = pairedIssueMarkdown(liveIssue.item.number);
    if (!pairedMarkdown) {
      return skip(
        "kept_open",
        "implemented-on-main paired closeout requires an independently reviewed linked issue report",
      );
    }
    if (
      pairedIssueReviewUpdatedAt(liveIssue.item.number) !== liveIssue.item.updatedAt &&
      pairedIssueOwnedReviewCommentUpdatedAt(liveIssue.item.number) !== liveIssue.item.updatedAt
    ) {
      return skip(
        "kept_open",
        "implemented-on-main paired closeout requires the linked issue to remain unchanged since its independent review",
      );
    }
    const issueValidation = validateCloseDecision(
      {
        repo,
        kind: liveIssue.item.kind,
        labels: liveIssue.item.labels,
        authorAssociation: liveIssue.item.authorAssociation,
      },
      {
        ...reportDecision(pairedMarkdown, linkedIssueCloseReason),
        closeReason: linkedIssueCloseReason,
      },
      { requireCloseComment: true },
    );
    if (!issueValidation.ok) return skip("kept_open", issueValidation.reason);
    if (liveIssue.item.locked) {
      return skip(
        "kept_open",
        "implemented-on-main paired closeout requires the linked issue to remain unlocked and unchanged since review",
      );
    }
  }
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
    for (const liveIssue of linkedIssuesToClose) {
      archivePairedIssue(liveIssue.item.number);
      onPairedIssueClosed(
        {
          number: liveIssue.item.number,
          action: "closed",
          reason: `dry-run: would close as ${closeReasonText(linkedIssueCloseReason)}`,
        },
        true,
      );
    }
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
    if (
      !rememberSelfMutationUpdatedAt({
        postReviewActivityStartedAtMs: closeoutActivityBaselineMs,
        requiresReviewedPrActivityCursor: implementationBasedPrClose,
      })
    ) {
      return markChangedSinceReview({
        reason: "closeout evidence freshness receipt could not be recorded",
      })
        ? "stop"
        : "next";
    }
  }
  const finalFreshnessBlock = postProofFreshnessBlock();
  if (finalFreshnessBlock) return markChangedSinceReview(finalFreshnessBlock) ? "stop" : "next";
  const finalCoveringPrFreshnessBlock = postProofCoveringPrFreshnessBlock();
  if (finalCoveringPrFreshnessBlock) {
    return skip(finalCoveringPrFreshnessBlock.actionTaken, finalCoveringPrFreshnessBlock.reason);
  }
  if (implementationBasedPrClose) {
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
  const pairedIssuesReadyToClose: Array<{
    number: number;
    reason: string;
    reviewedAtMs: number;
    sourceSnapshot: string;
  }> = [];
  for (const liveIssue of linkedIssuesToClose) {
    // Take the source snapshot before the live timestamp check. An edit before
    // the timestamp check changes updated_at; one after it changes this
    // snapshot, so neither can be hidden by the later bot comment.
    const preCommentIssueSource = pairedIssueSourceSnapshot(liveIssue.item.number);
    if (!preCommentIssueSource) {
      return skip(
        "kept_open",
        "implemented-on-main paired closeout could not preserve the linked issue source snapshot before final verification",
      );
    }
    const currentLinkedIssue = fetchItem(liveIssue.item.number, { bypassGenerationCache: true });
    if (
      currentLinkedIssue.state !== "open" ||
      currentLinkedIssue.item.kind !== "issue" ||
      currentLinkedIssue.item.updatedAt !== liveIssue.item.updatedAt ||
      currentLinkedIssue.item.locked
    ) {
      return skip(
        "kept_open",
        "implemented-on-main paired closeout requires the linked issue to remain unlocked and unchanged through final verification",
      );
    }
    const pairedMarkdown = pairedIssueMarkdown(currentLinkedIssue.item.number);
    if (!pairedMarkdown) {
      return skip(
        "kept_open",
        "implemented-on-main paired closeout requires an independently reviewed linked issue report",
      );
    }
    const pairedReviewedAtMs = Date.parse(frontMatterValue(pairedMarkdown, "reviewed_at") ?? "");
    if (!Number.isFinite(pairedReviewedAtMs) || pairedReviewedAtMs > Date.now()) {
      return skip(
        "kept_open",
        "implemented-on-main paired closeout requires a current independently reviewed linked issue timestamp",
      );
    }
    let issueCommentReason: string;
    try {
      issueCommentReason = withPairedIssueMutationLease(currentLinkedIssue.item.number, () =>
        ensureCloseAppliedComment({
          number: currentLinkedIssue.item.number,
          closeReason: linkedIssueCloseReason,
          markdown: getMarkdown(),
          itemUrl: currentLinkedIssue.item.url,
          dryRun,
        }),
      );
    } catch (error) {
      if (isGitHubRequiresAuthenticationError(error)) {
        return skip(
          "skipped_comment_auth",
          "GitHub rejected linked-issue closeout evidence comment write with Requires authentication",
        );
      }
      if (isLockedConversationCommentError(error)) {
        return skip(
          "skipped_locked_conversation",
          "linked issue conversation was locked while recording closeout evidence",
          true,
        );
      }
      throw error;
    }
    const postCommentLinkedIssue = fetchItem(currentLinkedIssue.item.number, {
      bypassGenerationCache: true,
    });
    const postCommentIssueSource = pairedIssueSourceSnapshot(currentLinkedIssue.item.number);
    const postCommentIssueActivity = pairedIssueRecentNonSelfCommentBlockReasonSafe(
      currentLinkedIssue.item.number,
      pairedReviewedAtMs,
    );
    const postCommentIssueValidation = validateCloseDecision(
      {
        repo,
        kind: postCommentLinkedIssue.item.kind,
        labels: postCommentLinkedIssue.item.labels,
        authorAssociation: postCommentLinkedIssue.item.authorAssociation,
      },
      {
        ...reportDecision(pairedMarkdown, linkedIssueCloseReason),
        closeReason: linkedIssueCloseReason,
      },
      { requireCloseComment: true },
    );
    if (
      postCommentLinkedIssue.state !== "open" ||
      postCommentLinkedIssue.item.kind !== "issue" ||
      postCommentLinkedIssue.item.locked ||
      postCommentIssueSource !== preCommentIssueSource ||
      postCommentIssueActivity ||
      !postCommentIssueValidation.ok
    ) {
      return skip(
        "kept_open",
        "implemented-on-main paired closeout requires the linked issue source to remain unchanged, unlocked, and free of new human activity through final verification",
      );
    }
    const finalLinkedIssue = fetchItem(currentLinkedIssue.item.number, {
      bypassGenerationCache: true,
    });
    const finalLinkedIssueSource = pairedIssueSourceSnapshot(currentLinkedIssue.item.number);
    const finalLinkedIssueActivity = pairedIssueRecentNonSelfCommentBlockReasonSafe(
      currentLinkedIssue.item.number,
      pairedReviewedAtMs,
    );
    if (
      finalLinkedIssue.state !== "open" ||
      finalLinkedIssue.item.kind !== "issue" ||
      finalLinkedIssue.item.locked ||
      finalLinkedIssueSource !== preCommentIssueSource ||
      finalLinkedIssueActivity
    ) {
      return skip(
        "kept_open",
        "implemented-on-main paired closeout requires the linked issue to remain unchanged after recording closeout evidence",
      );
    }
    pairedIssuesReadyToClose.push({
      number: finalLinkedIssue.item.number,
      reason: [closeReasonText(linkedIssueCloseReason), issueCommentReason]
        .filter(Boolean)
        .join("; "),
      reviewedAtMs: pairedReviewedAtMs,
      sourceSnapshot: preCommentIssueSource,
    });
  }
  const postPairedCloseMutationLeaseBlockReason = currentApplyMutationLeaseBlockReason();
  if (postPairedCloseMutationLeaseBlockReason)
    return skipLease(postPairedCloseMutationLeaseBlockReason);
  const postPairedCoveringFreshnessBlock = postProofCoveringPrFreshnessBlock();
  if (postPairedCoveringFreshnessBlock) {
    return skip(
      postPairedCoveringFreshnessBlock.actionTaken,
      postPairedCoveringFreshnessBlock.reason,
    );
  }
  const postPairedFreshnessBlock = postProofFreshnessBlock();
  if (postPairedFreshnessBlock)
    return markChangedSinceReview(postPairedFreshnessBlock) ? "stop" : "next";
  let pairedStop = false;
  for (const pairedIssue of pairedIssuesReadyToClose) {
    const preClosePairedIssue = fetchItem(pairedIssue.number, { bypassGenerationCache: true });
    const preClosePairedIssueSource = pairedIssueSourceSnapshot(pairedIssue.number);
    const preClosePairedIssueActivity = pairedIssueRecentNonSelfCommentBlockReasonSafe(
      pairedIssue.number,
      pairedIssue.reviewedAtMs,
    );
    const finalPairedIssue = fetchItem(pairedIssue.number, { bypassGenerationCache: true });
    const finalPairedIssueSource = pairedIssueSourceSnapshot(pairedIssue.number);
    const finalPairedIssueActivity = pairedIssueRecentNonSelfCommentBlockReasonSafe(
      pairedIssue.number,
      pairedIssue.reviewedAtMs,
    );
    if (
      preClosePairedIssue.state !== "open" ||
      preClosePairedIssue.item.kind !== "issue" ||
      preClosePairedIssue.item.locked ||
      preClosePairedIssueSource !== pairedIssue.sourceSnapshot ||
      preClosePairedIssueActivity ||
      finalPairedIssue.state !== "open" ||
      finalPairedIssue.item.kind !== "issue" ||
      finalPairedIssue.item.locked ||
      finalPairedIssueSource !== preClosePairedIssueSource ||
      finalPairedIssueActivity
    ) {
      return skip(
        "kept_open",
        `implemented-on-main paired closeout requires linked issue #${pairedIssue.number} to remain unchanged, unlocked, and free of new activity before closing the parent PR`,
      );
    }
    withPairedIssueMutationLease(
      pairedIssue.number,
      () =>
        closeItem({ number: pairedIssue.number, kind: "issue", reason: linkedIssueCloseReason }),
      {
        onOperationCompleted: () => {
          archivePairedIssue(pairedIssue.number);
          pairedStop ||= onPairedIssueClosed(
            { number: pairedIssue.number, action: "closed", reason: pairedIssue.reason },
            false,
          );
          logProgress(`linked issue #${pairedIssue.number}: ${pairedIssue.reason}`);
        },
      },
    );
  }
  let stop = false;
  let finalParentGuardFlow: ApplyCloseFlow | null = null;
  const finalAfterPairedCloseFreshnessBlock = postProofFreshnessBlock();
  if (finalAfterPairedCloseFreshnessBlock) {
    finalParentGuardFlow = markChangedSinceReview(finalAfterPairedCloseFreshnessBlock)
      ? "stop"
      : "next";
  } else {
    const finalAfterPairedCloseCoveringFreshnessBlock = postProofCoveringPrFreshnessBlock();
    if (finalAfterPairedCloseCoveringFreshnessBlock) {
      finalParentGuardFlow = skip(
        finalAfterPairedCloseCoveringFreshnessBlock.actionTaken,
        finalAfterPairedCloseCoveringFreshnessBlock.reason,
      );
    } else {
      const finalParentMutationLeaseBlockReason = currentApplyMutationLeaseBlockReason();
      if (finalParentMutationLeaseBlockReason) {
        finalParentGuardFlow = skipLease(finalParentMutationLeaseBlockReason);
      } else {
        closeItem({ number, kind: item.kind, reason: closeReason });
        let markdown = replaceSectionValue(
          getMarkdown(),
          REVIEW_SECTIONS.closeComment,
          reviewComment,
        );
        markdown = replaceFrontMatterValue(markdown, "close_comment_sha256", sha256(reviewComment));
        markdown = replaceFrontMatterValue(markdown, "action_taken", "closed");
        markdown = replaceFrontMatterValue(markdown, "applied_at", new Date().toISOString());
        markdown = replaceFrontMatterValue(markdown, "apply_checked_at", new Date().toISOString());
        setMarkdown(markdown);
        archiveClosed(markdown);
        stop = onClosed(
          {
            number,
            action: "closed",
            reason: [closeReasonText(closeReason), closeAppliedCommentReason]
              .filter(Boolean)
              .join("; "),
            ...(emitEventApplyProof ? { terminalStateVerified: true } : {}),
          },
          false,
        );
      }
    }
  }
  if (finalParentGuardFlow) return pairedStop ? "stop" : finalParentGuardFlow;
  let postCloseRuntimeYieldReason: string | null = null;
  try {
    ensureRuntimeDelayFits(closeDelayMs, "before close delay");
    sleepMs(closeDelayMs);
  } catch (error) {
    if (!(error instanceof GitHubRuntimeBudgetError)) throw error;
    postCloseRuntimeYieldReason = error.reason;
  }

  if (postCloseRuntimeYieldReason) {
    runtimeBudget.onYield?.(postCloseRuntimeYieldReason, false);
    return "yield";
  }
  return stop || pairedStop ? "stop" : "next";
}
