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
  return effectiveReviewStatusFromFields(
    status,
    frontMatterValue(markdown, "local_checkout_access"),
    frontMatterValue(markdown, "local_checkout_access_source"),
  );
}

// Bounded canonical-record readers have complete scalar lines before the large
// review_record field, but not the closing header. Share the same completion gate.
export function effectiveReviewStatusFromFields(
  status: string,
  localCheckoutAccess: string | null | undefined,
  localCheckoutAccessSource: string | null | undefined,
): string {
  if (
    status === "complete" &&
    (localCheckoutAccess !== "verified" || localCheckoutAccessSource !== "runner_preflight_v1")
  ) {
    return "stale_local_checkout_unverified";
  }
  return status;
}
