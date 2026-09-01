import {
  firstBeforeMergeAction,
  firstNonEmptyLine,
  htmlMarkerWithPrefix,
  markdownSection,
  markdownTopLevelSection,
  markerAttribute,
  previousReviewProofStatus,
  previousReviewRating,
  previousReviewReviewedAt,
  previousReviewStatus,
} from "./clawsweeper-markdown.js";
import { REVIEW_COMMENT_MARKER_PREFIX } from "./clawsweeper-policy.js";
import type { ContextHydration, PreviousClawSweeperReview } from "./clawsweeper-types.js";
import {
  parseReviewHistory,
  reviewHistoryCycleFromCommentBody,
  type ReviewHistoryCycle,
} from "./review-history.js";

export interface ReviewCommentContext {
  isClawSweeperComment: (value: unknown) => boolean;
  reviewCommentBodyDigest: (body: string) => string;
}

const COMMAND_ONLY_PATTERN = /^@clawsweeper\s+(?:re-review|re-run|review)\s*$/i;
const AUTOMATION_NOISE_PATTERNS = [
  /clawsweeper-pr-egg-hatch:/i,
  /clawsweeper-assist:/i,
  /clawsweeper-visual\s+item=/i,
  /clawsweeper-command(?:-status|-ack)?:/i,
  /clawsweeper-review-status:/i,
  /clawsweeper-close-applied\s+item=/i,
  /clawsweeper-repair:close:/i,
  /^ClawSweeper status: review started\./i,
] as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function rawCommentBody(value: unknown): string {
  const body = asRecord(value).body;
  return typeof body === "string" ? body : "";
}

export function timestampValueMs(value: unknown): number {
  return typeof value === "string" ? Date.parse(value) || 0 : 0;
}

function commentTimestampMs(value: unknown): number {
  const comment = asRecord(value);
  return timestampValueMs(comment.updated_at) || timestampValueMs(comment.created_at);
}

function isDurableReviewComment(
  value: unknown,
  number: number,
  context: ReviewCommentContext,
): boolean {
  return (
    context.isClawSweeperComment(value) &&
    rawCommentBody(value).includes(`${REVIEW_COMMENT_MARKER_PREFIX} item=${number} -->`)
  );
}

function isAutomationNoiseComment(
  value: unknown,
  number: number,
  context: ReviewCommentContext,
): boolean {
  const body = rawCommentBody(value);
  if (!body.trim() || !context.isClawSweeperComment(value)) return false;
  return (
    isDurableReviewComment(value, number, context) ||
    AUTOMATION_NOISE_PATTERNS.some((pattern) => pattern.test(body))
  );
}

export function filterReviewComments(
  comments: readonly unknown[],
  number: number,
  context: ReviewCommentContext,
): { included: unknown[]; filtered: number } {
  const included = comments.filter(
    (comment) =>
      !isAutomationNoiseComment(comment, number, context) &&
      !COMMAND_ONLY_PATTERN.test(rawCommentBody(comment).trim()),
  );
  return { included, filtered: comments.length - included.length };
}

function reviewHistoryFindings(
  cycle: ReviewHistoryCycle | undefined,
): Array<{ priority: string; title: string }> {
  if (!cycle) return [];
  return cycle.findings.flatMap((finding) => {
    const match = finding.match(/^\[(P[0-3])\]\s+(.+)$/);
    return match?.[1] && match[2] ? [{ priority: match[1], title: match[2] }] : [];
  });
}

export function latestClawSweeperReview(
  comments: readonly unknown[],
  number: number,
  context: ReviewCommentContext,
): PreviousClawSweeperReview | null {
  const latest = comments
    .filter((comment) => isDurableReviewComment(comment, number, context))
    .sort((left, right) => commentTimestampMs(right) - commentTimestampMs(left))[0];
  if (!latest) return null;
  return previousClawSweeperReviewFromComment(latest, context);
}

export function previousClawSweeperReviewFromComment(
  value: unknown,
  context: ReviewCommentContext,
): PreviousClawSweeperReview {
  const comment = asRecord(value);
  const body = rawCommentBody(value);
  const verdictMarker = htmlMarkerWithPrefix(body, "clawsweeper-verdict:");
  const actionMarker = htmlMarkerWithPrefix(body, "clawsweeper-action:");
  const history = parseReviewHistory(body);
  const currentCycle = reviewHistoryCycleFromCommentBody(body);
  const latestCompletedCycle = currentCycle ?? history.cycles.at(-1);
  const earlierReviewCycles = currentCycle ? history.cycles : history.cycles.slice(0, -1);
  return {
    status: previousReviewStatus(body),
    verdictDigest: context.reviewCommentBodyDigest(body),
    reviewedAt: previousReviewReviewedAt(body) ?? latestCompletedCycle?.reviewedAt ?? null,
    reviewedSha:
      markerAttribute(verdictMarker, "sha") ??
      markerAttribute(actionMarker, "sha") ??
      latestCompletedCycle?.sha ??
      null,
    verdictMarker,
    actionMarker,
    summary:
      firstNonEmptyLine(markdownSection(body, "What this changes")) ||
      firstNonEmptyLine(markdownSection(body, "Summary")),
    proofStatus: previousReviewProofStatus(body),
    rating: previousReviewRating(body),
    nextStep: markdownTopLevelSection(body, "Before merge")
      ? firstBeforeMergeAction(body)
      : firstNonEmptyLine(markdownSection(body, "Next step before merge")) ||
        firstNonEmptyLine(markdownSection(body, "Next step")),
    findings: reviewHistoryFindings(latestCompletedCycle),
    earlierReviewCycles,
    completedReviewCycles: history.totalCompletedCycles + (currentCycle ? 1 : 0),
    commentId: comment.id,
    commentUrl: comment.html_url,
    commentUpdatedAt: comment.updated_at,
  };
}

export function latestClawSweeperReviewFromHydration(
  commentsWindow: ContextHydration<unknown>,
  completeComments: readonly unknown[],
  number: number,
  context: ReviewCommentContext,
): PreviousClawSweeperReview | null {
  return latestClawSweeperReview(
    commentsWindow.truncated ? completeComments : commentsWindow.items,
    number,
    context,
  );
}

export function previousClawSweeperReviewDigest(value: unknown): string | null {
  const digest = asRecord(value).verdictDigest;
  return typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest) ? digest : null;
}
