import { frontMatterValue } from "./report-front-matter.ts";

export function hasVerifiedLocalCheckoutAccess(markdown: string): boolean {
  return (
    frontMatterValue(markdown, "local_checkout_access") === "verified" &&
    frontMatterValue(markdown, "local_checkout_access_source") === "runner_preflight_v1"
  );
}

export function effectiveReviewStatus(markdown: string): string {
  const status =
    frontMatterValue(markdown, "review_status") ??
    (markdown.includes("Codex review failed") ? "failed" : "complete");
  if (status === "complete" && !hasVerifiedLocalCheckoutAccess(markdown)) {
    return "stale_local_checkout_unverified";
  }
  return status;
}
