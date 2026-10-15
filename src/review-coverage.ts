import { frontMatterValue } from "./report-front-matter.ts";
import { effectiveReviewStatusFromFields } from "./review-completion.ts";

// Leave room for the key and encoding overhead under SQLite-backed KV's 2 MiB limit.
export const REVIEW_COVERAGE_INVENTORY_MAX_BYTES = 1_900_000;
export const REVIEW_COVERAGE_INVENTORY_MAX_ITEMS = 20_000;
export type ReviewCoverageOpenItem = {
  number: number;
  kind: "issue" | "pull_request";
  updated_at: string;
  head_sha?: string;
  labels: string[];
};
export type ReviewCoverageInventoryRepository = {
  repo: string;
  repo_slug: string;
  open_issues: number;
  open_pull_requests: number;
  complete?: boolean;
  items?: ReviewCoverageOpenItem[];
};
export type ReviewCoverageInventorySnapshot = {
  generated_at: string;
  repositories: ReviewCoverageInventoryRepository[];
};
export type ReviewCoverageRecord = {
  kind: string | undefined;
  headSha: string | undefined;
  status: string;
  reviewedAt: string | undefined;
};

export const REVIEW_COVERAGE_RECORD_FIELDS = [
  "type",
  "pull_head_sha",
  "review_status",
  "reviewed_at",
  "local_checkout_access",
  "local_checkout_access_source",
] as const;
type ReviewCoverageRecordFields = Partial<
  Record<(typeof REVIEW_COVERAGE_RECORD_FIELDS)[number], string | null>
>;

export function reviewCoverageRecord(markdown: string): ReviewCoverageRecord {
  return reviewCoverageRecordFromFields(
    Object.fromEntries(
      REVIEW_COVERAGE_RECORD_FIELDS.map((key) => [key, frontMatterValue(markdown, key)]),
    ),
  );
}

export function reviewCoverageRecordFromFields(
  fields: ReviewCoverageRecordFields,
): ReviewCoverageRecord {
  return {
    kind: fields.type ?? undefined,
    headSha: fields.pull_head_sha ?? undefined,
    // Missing status never takes the legacy complete default, including a cut-off line.
    status: effectiveReviewStatusFromFields(
      fields.review_status ?? "unknown",
      fields.local_checkout_access,
      fields.local_checkout_access_source,
    ),
    reviewedAt: fields.reviewed_at ?? undefined,
  };
}

export function reviewCoverageRecordState(
  record: ReviewCoverageRecord,
  item: ReviewCoverageOpenItem,
  now: number,
  windowMs: number,
): "reviewed_recent" | "stale" | "failed" | "expired" | "unreviewed_records" {
  if (record.status.startsWith("stale_")) return "stale";
  if (record.status === "failed") return "failed";
  if (record.status !== "complete") return "unreviewed_records";
  if (
    record.kind !== item.kind ||
    (item.kind === "pull_request" && record.headSha !== item.head_sha)
  )
    return "stale";
  const reviewedAt = Date.parse(record.reviewedAt ?? "");
  if (!Number.isFinite(reviewedAt) || reviewedAt > now) return "unreviewed_records";
  return now - reviewedAt < windowMs ? "reviewed_recent" : "expired";
}
