import { frontMatterValue } from "./report-front-matter.ts";
import { hasReviewAutomationOptIn } from "./maintainer-review-policy.ts";
import { effectiveReviewStatus } from "./review-completion.ts";

export const INITIAL_PR_REVIEW_QUIET_MS = 10 * 60_000;

export function isCompletedPullRequestReview(markdown: string): boolean {
  return (
    frontMatterValue(markdown, "type") === "pull_request" &&
    effectiveReviewStatus(markdown) === "complete" &&
    Number.isFinite(Date.parse(frontMatterValue(markdown, "reviewed_at") ?? ""))
  );
}

export function requiresPullRequestReReviewRequest(
  item: { kind: string; labels?: unknown },
  review: { reviewStatus: string | undefined } | null,
): boolean {
  return (
    item.kind === "pull_request" &&
    review?.reviewStatus === "complete" &&
    !hasReviewAutomationOptIn(item)
  );
}
