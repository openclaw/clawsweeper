import { frontMatterValue } from "./report-front-matter.ts";
import { effectiveReviewStatus } from "./review-completion.ts";

export const INITIAL_PR_REVIEW_QUIET_MS = 10 * 60_000;

export function isCompletedPullRequestReview(markdown: string): boolean {
  return (
    frontMatterValue(markdown, "type") === "pull_request" &&
    effectiveReviewStatus(markdown) === "complete" &&
    Number.isFinite(Date.parse(frontMatterValue(markdown, "reviewed_at") ?? ""))
  );
}
