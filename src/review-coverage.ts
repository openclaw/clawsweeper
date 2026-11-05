import { frontMatterValue } from "./report-front-matter.ts";
import { effectiveReviewStatusFromFields } from "./review-completion.ts";

// Leave room for the key and encoding overhead under SQLite-backed KV's 2 MiB limit.
export const REVIEW_COVERAGE_INVENTORY_MAX_BYTES = 1_900_000;
export const REVIEW_COVERAGE_INVENTORY_MAX_ITEMS = 20_000;
export type ReviewCoverageOpenItem = {
  number: number;
  kind: "issue" | "pull_request";
  updated_at: string;
  reopened_at?: string | null;
  head_sha?: string;
  labels: string[];
};
export type ReviewCoverageObservationScope =
  | "eligible"
  | "observed"
  | "archived"
  | "fork"
  | "alias"
  | "historical";
// Internal bounded item sources are never a v1 wire representation. The v1
// intake still requires Array.isArray; only the canonical v2 owner supplies one.
export type ReviewCoverageItemList = {
  readonly length: number;
  slice(start: number, end: number): ReviewCoverageOpenItem[];
  some(predicate: (item: ReviewCoverageOpenItem) => unknown): boolean;
  [Symbol.iterator](): IterableIterator<ReviewCoverageOpenItem>;
};
export type ReviewCoverageInventoryRepository = {
  observation_scope?: ReviewCoverageObservationScope;
  repo: string;
  repo_slug: string;
  open_issues: number | null;
  open_pull_requests: number | null;
  collection_window?: {
    started_at: string;
    ended_at: string;
    witness_observed_at: string;
    published_at: string;
  };
  counts_observed_at?: string | null;
  counts_qualification?: "identity_scan_drifted";
  visibility?: "public" | "unknown";
  reason?: string | undefined;
  missing_fields?: string[];
  complete?: boolean;
  items?: ReviewCoverageOpenItem[] | ReviewCoverageItemList;
};
export type ReviewCoverageInventorySnapshot = {
  // Internal v2 cohort admission; never a partial identity denominator.
  capacity_blocked?: boolean;
  generated_at: string;
  repositories: ReviewCoverageInventoryRepository[];
};
export type ReviewCoverageRecord = {
  unavailable?: boolean;
  kind?: string | undefined;
  headSha?: string | undefined;
  status: string;
  reviewedAt?: string | undefined;
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
  if (record.status !== "complete" && record.status !== "failed") return "unreviewed_records";
  if (
    record.kind !== item.kind ||
    (item.kind === "pull_request" && record.headSha !== item.head_sha)
  )
    return "stale";
  const reviewedAt = Date.parse(record.reviewedAt ?? "");
  const usableReviewTime = Number.isFinite(reviewedAt) && reviewedAt <= now;
  if (record.status === "complete" && !usableReviewTime) return "unreviewed_records";
  // Generic updated_at includes automation comments and is not a semantic
  // revision. Only an observed reopen invalidates the earlier open period.
  const reopenedAt = Date.parse(item.reopened_at ?? "");
  if (usableReviewTime && Number.isFinite(reopenedAt) && reopenedAt > reviewedAt) return "stale";
  // A matching failed attempt is not a completed review: no usable date or
  // successful-review freshness window is required to report that failure.
  if (record.status === "failed") return "failed";
  return now - reviewedAt < windowMs ? "reviewed_recent" : "expired";
}
