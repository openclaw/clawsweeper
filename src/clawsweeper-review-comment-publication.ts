import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { closeReasonText } from "./clawsweeper-close-reasons.js";
import { PR_CLOSE_COVERAGE_PROOF_SECTION } from "./clawsweeper-policy.js";
import type { CloseReason, ReviewArtifactDestination } from "./clawsweeper-types.js";
import { parseGhJson } from "./github-json.js";
import {
  isGitHubRequiresAuthenticationError,
  isLockedConversationCommentError,
} from "./github-retry.js";
import type { ReviewCommentWorkflowDependencies } from "./clawsweeper-review-comment-dependencies.js";
import type { createReviewCommentIdentity } from "./clawsweeper-review-comment-identity.js";
import type { createReviewCommentState } from "./clawsweeper-review-comment-state.js";

export function createReviewCommentPublication(
  dependencies: ReviewCommentWorkflowDependencies &
    ReturnType<typeof createReviewCommentIdentity> &
    ReturnType<typeof createReviewCommentState>,
) {
  const {
    root: ROOT,
    targetRepo,
    ghObservedMutationCommand,
    sha256,
    ghPaged,
    reviewCommentBodyDigest,
    asRecord,
    ensureDir,
    frontMatterValue,
    replaceFrontMatterValue,
    sectionValue,
    timestampMs,
    sentence,
    normalizedLabelSet,
    sectionLineValue,
    markdownLink,
    closeAppliedCommentMarker,
    markedReviewCommentBody,
    issueReviewComment,
    issueReviewCommentWithBody,
    commentUpdatedAt,
    commentId,
    commentUrl,
    canPatchReviewComment,
  } = dependencies;

  function reviewArtifactDestination(
    action: string | undefined,
    itemIsOpen: boolean,
  ): ReviewArtifactDestination {
    if (!itemIsOpen) return "skip_closed";
    return action === "closed" || action === "skipped_already_closed" ? "closed" : "items";
  }

  function runtimeBudgetExceeded(
    startedAtMs: number,
    maxRuntimeMs: number,
    nowMs: number,
  ): boolean {
    return maxRuntimeMs > 0 && nowMs - startedAtMs >= maxRuntimeMs;
  }

  function removeCurrentCursorTraceItem(
    examinedItemNumbers: number[],
    currentNumber: number,
  ): void {
    if (examinedItemNumbers.at(-1) === currentNumber) examinedItemNumbers.pop();
  }

  function timeoutWithinRuntimeBudget(
    startedAtMs: number,
    maxRuntimeMs: number,
    requestedTimeoutMs: number,
    nowMs: number,
  ): number | null {
    if (maxRuntimeMs <= 0) return requestedTimeoutMs;
    const remainingMs = maxRuntimeMs - (nowMs - startedAtMs);
    return remainingMs > 0 ? Math.min(requestedTimeoutMs, remainingMs) : null;
  }

  function coverageProofRetryExhaustedRuntimeBudget(
    startedAtMs: number,
    maxRuntimeMs: number,
    actionTaken: string,
    nowMs: number,
  ): boolean {
    return (
      actionTaken === "retry_pr_close_coverage_proof" &&
      runtimeBudgetExceeded(startedAtMs, maxRuntimeMs, nowMs)
    );
  }

  function recordedLabelSyncCoversUpdate(options: {
    itemUpdatedAt: string;
    labelsSyncedAt: string | undefined;
    liveLabels: readonly string[];
    recordedLabels: readonly string[];
    hasNonAutomationActivity: boolean;
  }): boolean {
    const itemUpdatedAtMs = timestampMs(options.itemUpdatedAt);
    const labelsSyncedAtMs = timestampMs(options.labelsSyncedAt);
    if (
      itemUpdatedAtMs === null ||
      labelsSyncedAtMs === null ||
      itemUpdatedAtMs > labelsSyncedAtMs ||
      options.hasNonAutomationActivity
    ) {
      return false;
    }
    const liveLabelSet = normalizedLabelSet(options.liveLabels);
    const recordedLabelSet = normalizedLabelSet(options.recordedLabels);
    return (
      liveLabelSet.size === recordedLabelSet.size &&
      [...liveLabelSet].every((label) => recordedLabelSet.has(label))
    );
  }

  function updateReviewCommentMetadata(
    markdown: string,
    comment: Record<string, unknown> | undefined,
    body: string,
  ): string {
    let next = replaceFrontMatterValue(
      markdown,
      "review_comment_sha256",
      reviewCommentBodyDigest(body),
    );
    const id = commentId(comment);
    const url = commentUrl(comment);
    if (id !== null) next = replaceFrontMatterValue(next, "review_comment_id", String(id));
    if (url) next = replaceFrontMatterValue(next, "review_comment_url", url);
    const checkedAt = new Date().toISOString();
    next = replaceFrontMatterValue(
      next,
      "review_comment_synced_at",
      commentUpdatedAt(comment) ?? checkedAt,
    );
    next = replaceFrontMatterValue(next, "review_comment_checked_at", checkedAt);
    return next;
  }

  function writeCommentPayload(number: number, body: string): string {
    const commentFile = join(ROOT, ".artifacts", `comment-${number}.md`);
    ensureDir(dirname(commentFile));
    writeFileSync(commentFile, body, "utf8");
    const commentPayloadFile = join(ROOT, ".artifacts", `comment-${number}.json`);
    writeFileSync(commentPayloadFile, JSON.stringify({ body }), "utf8");
    return commentPayloadFile;
  }

  function upsertReviewComment(
    number: number,
    body: string,
    existing = issueReviewComment(number, [body]),
    mutationIdentity = `review_comment_upsert:${number}:${reviewCommentBodyDigest(body)}`,
  ): Record<string, unknown> | undefined {
    const markedBody = markedReviewCommentBody(number, body);
    const id = commentId(existing);
    const payload = writeCommentPayload(number, markedBody);
    let args: string[];
    if (id !== null && canPatchReviewComment(existing)) {
      args = [
        "api",
        `repos/${targetRepo()}/issues/comments/${id}`,
        "--method",
        "PATCH",
        "--input",
        payload,
      ];
    } else {
      args = [
        "api",
        `repos/${targetRepo()}/issues/${number}/comments`,
        "--method",
        "POST",
        "--input",
        payload,
      ];
    }
    const response = ghObservedMutationCommand({
      identity: mutationIdentity,
      args,
      knownNoMutation: (error) =>
        isGitHubRequiresAuthenticationError(error) || isLockedConversationCommentError(error),
    });
    const written = reviewCommentFromMutationResponse(response, args);
    if (written) return written;
    const fallback = issueReviewCommentWithBody(number, markedBody);
    if (fallback) return fallback;
    throw new Error(
      `GitHub comment mutation for #${number} did not return or expose the synced review comment`,
    );
  }

  function reviewCommentFromMutationResponse(
    response: string,
    args: readonly string[],
  ): Record<string, unknown> | undefined {
    if (!response.trim()) return undefined;
    try {
      const comment = asRecord(parseGhJson<unknown>(response, args));
      if (commentId(comment) !== null || commentUrl(comment)) {
        return comment;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  function issueCommentWithMarker(
    number: number,
    marker: string,
  ): Record<string, unknown> | undefined {
    const comments = ghPaged<unknown>(`repos/${targetRepo()}/issues/${number}/comments`).map(
      asRecord,
    );
    return comments.find((candidate) => {
      const body = candidate.body;
      return typeof body === "string" && body.includes(marker);
    });
  }

  function closeAppliedEvidenceLink(markdown: string, itemUrl: string): string {
    const reviewCommentUrl = frontMatterValue(markdown, "review_comment_url");
    if (reviewCommentUrl && reviewCommentUrl !== "unknown") {
      return markdownLink("durable ClawSweeper review", reviewCommentUrl);
    }
    const fixedPrUrl = frontMatterValue(markdown, "fixed_pr_url");
    const fixedPrNumber = frontMatterValue(markdown, "fixed_pr_number");
    if (fixedPrUrl && fixedPrUrl !== "unknown") {
      const label =
        fixedPrNumber && fixedPrNumber !== "unknown" ? `fix PR #${fixedPrNumber}` : "fix PR";
      return markdownLink(label, fixedPrUrl);
    }
    return markdownLink("closed PR", itemUrl);
  }

  function renderCloseAppliedComment(options: {
    number: number;
    closeReason: CloseReason;
    markdown: string;
    itemUrl: string;
  }): string {
    const coverageProofLine = closeAppliedCoverageProofLine(options.markdown);
    return [
      "ClawSweeper applied the proposed close for this PR.",
      "",
      "- Action: closed this PR.",
      `- Close reason: ${closeReasonText(options.closeReason)}.`,
      `- Evidence: ${closeAppliedEvidenceLink(options.markdown, options.itemUrl)}.`,
      coverageProofLine,
      "",
      closeAppliedCommentMarker(options.number),
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  }

  function closeAppliedCoverageProofLine(markdown: string): string | null {
    const proof = sectionValue(markdown, PR_CLOSE_COVERAGE_PROOF_SECTION);
    if (!proof) return null;
    const reason = sectionLineValue(proof, "Reason");
    if (!reason) return null;
    const covering = sectionLineValue(proof, "Covering PR");
    return [`- Coverage proof: ${sentence(reason)}`, covering ? ` Covering PR: ${covering}.` : ""]
      .join("")
      .trim();
  }

  function ensureCloseAppliedComment(options: {
    number: number;
    closeReason: CloseReason;
    markdown: string;
    itemUrl: string;
    dryRun: boolean;
  }): string {
    const marker = closeAppliedCommentMarker(options.number);
    if (issueCommentWithMarker(options.number, marker)) {
      return "matching ClawSweeper close-applied comment already exists";
    }
    const body = renderCloseAppliedComment(options);
    if (options.dryRun) return "dry-run: would post close-applied comment";
    const payload = writeCommentPayload(options.number, body);
    ghObservedMutationCommand({
      identity: `close_applied_comment:${options.number}:${sha256(body)}`,
      args: [
        "api",
        `repos/${targetRepo()}/issues/${options.number}/comments`,
        "--method",
        "POST",
        "--input",
        payload,
      ],
    });
    return "posted close-applied comment";
  }

  return {
    reviewArtifactDestination,
    runtimeBudgetExceeded,
    removeCurrentCursorTraceItem,
    timeoutWithinRuntimeBudget,
    coverageProofRetryExhaustedRuntimeBudget,
    recordedLabelSyncCoversUpdate,
    updateReviewCommentMetadata,
    writeCommentPayload,
    upsertReviewComment,
    reviewCommentFromMutationResponse,
    issueCommentWithMarker,
    closeAppliedEvidenceLink,
    renderCloseAppliedComment,
    closeAppliedCoverageProofLine,
    ensureCloseAppliedComment,
  };
}
