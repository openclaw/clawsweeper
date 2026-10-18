import type { ReviewUsageRecord } from "../src/review-usage-contract.ts";

// Analytics Engine columns are one-based within each tuple. Keep this layout stable;
// docs/live-dashboard.md documents the SQL columns using these source tuples.
export const REVIEW_USAGE_LAYOUT = {
  indexes: ["target_repo"],
  blobs: [
    "target_repo",
    "item_kind",
    "outcome",
    "trigger_lane",
    "service_tier",
    "reasoning_effort",
    "run_id",
    "item_number",
  ],
  doubles: [
    "input_tokens",
    "cached_input_tokens",
    "cache_write_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "duration_ms",
    "usage_present",
    "core_usage_present",
  ],
} as const;

export type ReviewUsageDataPoint = {
  indexes: string[];
  blobs: string[];
  doubles: number[];
};

export type ReviewUsageDataset = {
  writeDataPoint(point: ReviewUsageDataPoint): void;
};

export function writeReviewUsage(dataset: ReviewUsageDataset, payload: ReviewUsageRecord): void {
  const blobs = {
    ...payload,
    trigger_lane: payload.trigger_lane || "",
    service_tier: payload.service_tier || "standard",
    reasoning_effort: payload.reasoning_effort || "",
    item_number: String(payload.item_number),
  };
  const doubles = {
    input_tokens: payload.usage?.input_tokens ?? 0,
    cached_input_tokens: payload.usage?.cached_input_tokens ?? 0,
    cache_write_input_tokens: payload.usage?.cache_write_input_tokens ?? 0,
    output_tokens: payload.usage?.output_tokens ?? 0,
    reasoning_output_tokens: payload.usage?.reasoning_output_tokens ?? 0,
    duration_ms: payload.duration_ms,
    // Keep the existing full-usage flag meaningful to older queries; unknown writes are not zeroes.
    usage_present:
      payload.usage !== null && payload.usage.cache_write_input_tokens !== null ? 1 : 0,
    core_usage_present: payload.usage === null ? 0 : 1,
  };
  dataset.writeDataPoint({
    indexes: REVIEW_USAGE_LAYOUT.indexes.map((key) => payload[key]),
    blobs: REVIEW_USAGE_LAYOUT.blobs.map((key) => blobs[key]),
    doubles: REVIEW_USAGE_LAYOUT.doubles.map((key) => doubles[key]),
  });
}
