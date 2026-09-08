import { randomUUID } from "node:crypto";
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

const DURABLE_REVIEW_COMMENT_MAX_BYTES = 60 * 1024;

export class DurableReviewPublicationBlockedError extends Error {
  constructor(
    message: string,
    readonly syncedComment: Record<string, unknown>,
    readonly publishedBody: string,
  ) {
    super(message);
    this.name = "DurableReviewPublicationBlockedError";
  }
}

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
    isReviewPublicationReceipt,
    durableReviewCausalIdentityFromBody,
    identitylessPublicationFallback,
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
    const commentPath = join(ROOT, ".artifacts", `comment-${number}-${randomUUID()}`);
    const commentFile = `${commentPath}.md`;
    ensureDir(dirname(commentFile));
    writeFileSync(commentFile, body, "utf8");
    const commentPayloadFile = `${commentPath}.json`;
    writeFileSync(commentPayloadFile, JSON.stringify({ body }), "utf8");
    return commentPayloadFile;
  }

  function boundedReviewVersionMarker(
    number: number,
    identity: {
      reviewedAt: string;
      headSha: string | null;
      sourceRevision: string | null;
      leaseOwner: string | null;
      leaseCommentId: string | null;
    } | null,
  ): string {
    if (
      !identity ||
      timestampMs(identity.reviewedAt) === null ||
      (identity.headSha !== null && !/^[0-9a-f]{40}$/i.test(identity.headSha))
    ) {
      return "";
    }
    const attrs = [
      `item=${number}`,
      `reviewed_at=${new Date(timestampMs(identity.reviewedAt)!).toISOString()}`,
      `sha=${identity.headSha?.toLowerCase() ?? "na"}`,
      ...(identity.sourceRevision &&
      /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(identity.sourceRevision)
        ? [`source_revision=${identity.sourceRevision.toLowerCase()}`]
        : []),
      ...(identity.leaseOwner && /^[A-Za-z0-9._:-]{1,200}$/.test(identity.leaseOwner)
        ? [`lease_owner=${identity.leaseOwner}`]
        : []),
      ...(identity.leaseCommentId &&
      /^[1-9]\d*$/.test(identity.leaseCommentId) &&
      Number.isSafeInteger(Number(identity.leaseCommentId))
        ? [`lease_comment_id=${identity.leaseCommentId}`]
        : []),
      "v=1",
    ].join(" ");
    return `<!-- clawsweeper-review-version ${attrs} -->`;
  }

  function oversizedReviewCommentFallback(number: number, body: string, bodyBytes: number): string {
    const identity = durableReviewCausalIdentityFromBody(body, number);
    const version = identity
      ? boundedReviewVersionMarker(number, {
          ...identity,
          leaseCommentId: String(identity.leaseCommentId),
        })
      : "";
    const fallback = markedReviewCommentBody(
      number,
      [
        "Codex review: publication failed closed.",
        "",
        "# ClawSweeper review",
        "",
        "## Merge readiness",
        "",
        "**Blocked by review publication failure.**",
        "",
        `The generated review was ${bodyBytes} bytes; GitHub publication is bounded to ${DURABLE_REVIEW_COMMENT_MAX_BYTES} bytes. The item remains open.`,
        "",
        "## Before merge",
        "",
        "- [ ] **Retry bounded review publication (P2)** - Reduce the generated review and run a fresh review before merge.",
        "",
        `<!-- clawsweeper-verdict:needs-human item=${number}${identity?.headSha ? ` sha=${identity.headSha}` : ""} -->`,
        identity?.headSha
          ? `<!-- clawsweeper-review-state:blocked item=${number} sha=${identity.headSha} v=1 -->`
          : "",
        version,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    if (Buffer.byteLength(fallback, "utf8") > DURABLE_REVIEW_COMMENT_MAX_BYTES) {
      throw new Error(
        `bounded durable review fallback for #${number} exceeds the publication limit`,
      );
    }
    return fallback;
  }

  function upsertReviewComment(
    number: number,
    body: string,
    existing = issueReviewComment(number, [body]),
    mutationIdentity?: string,
    options: { suppressAutomationMarkers?: boolean } = {},
  ): Record<string, unknown> {
    const markedBody = markedReviewCommentBody(number, body);
    const bodyBytes = Buffer.byteLength(markedBody, "utf8");
    const oversized = bodyBytes > DURABLE_REVIEW_COMMENT_MAX_BYTES;
    if (oversized && options.suppressAutomationMarkers) {
      throw new Error(
        `durable review comment for #${number} exceeds ${DURABLE_REVIEW_COMMENT_MAX_BYTES} bytes; marker-suppressed publication cannot emit a fallback`,
      );
    }
    const publicationBody = oversized
      ? oversizedReviewCommentFallback(number, markedBody, bodyBytes)
      : markedBody;
    const id = commentId(existing);
    if (id !== null && identitylessPublicationFallback(number, existing)) {
      const identity = durableReviewCausalIdentityFromBody(markedBody, number);
      if (!identity || identity.leaseCommentId <= id) {
        throw new Error(
          `durable review comment ${id} is a fail-closed publication fallback; a fresh review lease is required before replacement`,
        );
      }
    }
    const identitylessFallback =
      oversized && durableReviewCausalIdentityFromBody(publicationBody, number) === null;
    // Identity-less fallbacks need a new server id so later review leases can
    // prove causal supersession without comparing client and server clocks.
    const patchTargetId =
      !identitylessFallback && id !== null && canPatchReviewComment(existing) ? id : null;
    const payload = writeCommentPayload(number, publicationBody);
    let args: string[];
    if (patchTargetId !== null) {
      args = [
        "api",
        `repos/${targetRepo()}/issues/comments/${patchTargetId}`,
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
      identity:
        mutationIdentity ??
        `review_comment_upsert:${number}:${reviewCommentBodyDigest(publicationBody)}`,
      args,
      knownNoMutation: (error) =>
        isGitHubRequiresAuthenticationError(error) || isLockedConversationCommentError(error),
    });
    const written = reviewCommentFromMutationResponse(response, args);
    const verifiedWritten = isReviewPublicationReceipt(
      written,
      publicationBody,
      patchTargetId ?? undefined,
    )
      ? written
      : undefined;
    const synced =
      verifiedWritten ??
      issueReviewCommentWithBody(number, publicationBody, patchTargetId ?? undefined);
    if (synced && oversized) {
      throw new DurableReviewPublicationBlockedError(
        `durable review comment for #${number} exceeded ${DURABLE_REVIEW_COMMENT_MAX_BYTES} bytes; published a blocked fallback and kept the item open`,
        synced,
        publicationBody,
      );
    }
    if (synced) return synced;
    if (patchTargetId !== null) {
      throw new Error(
        `GitHub comment PATCH for #${number} did not verify target comment ${patchTargetId}`,
      );
    }
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
    expectedBody?: string,
  ): Record<string, unknown> | undefined {
    const comments = ghPaged<unknown>(`repos/${targetRepo()}/issues/${number}/comments`).map(
      asRecord,
    );
    const marked = comments.filter((candidate) => {
      const body = candidate.body;
      return typeof body === "string" && body.includes(marker);
    });
    // A marker and body are both predictable and therefore not ownership proof.
    // Prefer an exact ClawSweeper receipt, then another owned marker as an
    // update target. This avoids selecting a spoofed marker forever and posting
    // a duplicate on every retry.
    if (expectedBody) {
      const matching = marked.find(
        (candidate) => candidate.body === expectedBody && canPatchReviewComment(candidate),
      );
      if (matching) return matching;
    }
    return marked.find(canPatchReviewComment);
  }

  function closeAppliedEvidenceLink(markdown: string, itemUrl: string): string {
    const fixedPrUrl = frontMatterValue(markdown, "fixed_pr_url");
    const fixedPrNumber = frontMatterValue(markdown, "fixed_pr_number");
    if (fixedPrUrl && fixedPrUrl !== "unknown") {
      const label =
        fixedPrNumber && fixedPrNumber !== "unknown" ? `fix PR #${fixedPrNumber}` : "fix PR";
      return markdownLink(label, fixedPrUrl);
    }
    const reviewCommentUrl = frontMatterValue(markdown, "review_comment_url");
    if (reviewCommentUrl && reviewCommentUrl !== "unknown") {
      return markdownLink("durable ClawSweeper review", reviewCommentUrl);
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
    const implementationBasedPrClose = [
      "implemented_on_main",
      "mostly_implemented_on_main",
    ].includes(options.closeReason);
    const reviewCommentUrl = frontMatterValue(options.markdown, "review_comment_url");
    const closeEvidence = implementationBasedPrClose
      ? closeAppliedEvidenceLink(options.markdown, options.itemUrl)
      : markdownLink(
          "durable ClawSweeper review",
          reviewCommentUrl && reviewCommentUrl !== "unknown" ? reviewCommentUrl : options.itemUrl,
        );
    return [
      implementationBasedPrClose
        ? "ClawSweeper recorded implementation evidence for this proposed close."
        : "ClawSweeper recorded closeout evidence for this proposed close.",
      "",
      "- Action: close remains subject to final live verification.",
      `- Close reason: ${closeReasonText(options.closeReason)}.`,
      `${implementationBasedPrClose ? "Implementation" : "Review"} evidence: ${closeEvidence}.`,
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
    const body = renderCloseAppliedComment(options);
    const existing = issueCommentWithMarker(options.number, marker, body);
    if (existing?.body === body) {
      return "matching ClawSweeper close-applied comment already exists";
    }
    if (options.dryRun) return "dry-run: would post close-applied comment";
    const payload = writeCommentPayload(options.number, body);
    const existingId = commentId(existing);
    const updateExisting = existingId !== null && canPatchReviewComment(existing);
    ghObservedMutationCommand({
      identity: `close_applied_comment:${options.number}:${sha256(body)}`,
      args: updateExisting
        ? [
            "api",
            `repos/${targetRepo()}/issues/comments/${existingId}`,
            "--method",
            "PATCH",
            "--input",
            payload,
          ]
        : [
            "api",
            `repos/${targetRepo()}/issues/${options.number}/comments`,
            "--method",
            "POST",
            "--input",
            payload,
          ],
      knownNoMutation: (error) =>
        isGitHubRequiresAuthenticationError(error) || isLockedConversationCommentError(error),
    });
    return updateExisting ? "updated close-applied comment" : "posted close-applied comment";
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
