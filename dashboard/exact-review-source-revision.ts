import { reviewSourceRevisionLabels } from "../src/repair/exact-review-guard-labels.ts";

type SourceRecord = Record<string, unknown>;

function sourceRecord(value: unknown): SourceRecord {
  return value !== null && typeof value === "object" ? (value as SourceRecord) : {};
}

export function exactReviewSourceRevisionMaterial(value: unknown) {
  const source = sourceRecord(value);
  if (
    typeof source.title !== "string" ||
    (source.body !== null && typeof source.body !== "string") ||
    typeof source.locked !== "boolean" ||
    !Array.isArray(source.labels)
  ) {
    return null;
  }
  return {
    version: 2,
    title: source.title,
    body: source.body || "",
    locked: source.locked,
    // Retain the v2 key for persisted-row compatibility. The value now includes
    // every review-relevant label, not only close guards.
    close_guard_labels: reviewSourceRevisionLabels(source.labels, {
      preserveAutomationModeLabels: true,
    }),
  };
}
