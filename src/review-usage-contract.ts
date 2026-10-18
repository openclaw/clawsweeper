import { isRecord } from "./value-coerce.ts";

export interface ReviewUsageRecord {
  schema: 1;
  target_repo: string;
  item_number: number;
  item_kind: "issue" | "pull_request";
  run_id: string;
  run_attempt: number;
  trigger_lane?: string;
  service_tier?: string;
  reasoning_effort?: string;
  outcome: "ok" | "failed" | "timeout";
  duration_ms: number;
  usage: {
    input_tokens: number;
    cached_input_tokens: number;
    cache_write_input_tokens: number | null;
    output_tokens: number;
    reasoning_output_tokens: number;
  } | null;
}

const PAYLOAD_KEYS: readonly string[] = [
  "schema",
  "target_repo",
  "item_number",
  "item_kind",
  "run_id",
  "run_attempt",
  "trigger_lane",
  "service_tier",
  "reasoning_effort",
  "outcome",
  "duration_ms",
  "usage",
];
const USAGE_KEYS: readonly string[] = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
];

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return nonnegativeInteger(value) && value > 0;
}

function optionalLabel(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && /^[a-zA-Z0-9_.-]{0,64}$/.test(value));
}

export function isReviewTokenUsage(
  value: unknown,
): value is NonNullable<ReviewUsageRecord["usage"]> {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => USAGE_KEYS.includes(key)) &&
    USAGE_KEYS.every((key) =>
      key === "cache_write_input_tokens" && value[key] === null
        ? true
        : nonnegativeInteger(value[key]),
    )
  );
}

export function isReviewUsageRecord(value: unknown): value is ReviewUsageRecord {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => PAYLOAD_KEYS.includes(key)) &&
    value.schema === 1 &&
    typeof value.target_repo === "string" &&
    /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?\/[a-zA-Z0-9_.-]{1,100}$/.test(
      value.target_repo,
    ) &&
    !value.target_repo.endsWith("/.") &&
    !value.target_repo.endsWith("/..") &&
    positiveInteger(value.item_number) &&
    (value.item_kind === "issue" || value.item_kind === "pull_request") &&
    typeof value.run_id === "string" &&
    /^[1-9][0-9]{0,31}$/.test(value.run_id) &&
    positiveInteger(value.run_attempt) &&
    optionalLabel(value.trigger_lane) &&
    optionalLabel(value.service_tier) &&
    optionalLabel(value.reasoning_effort) &&
    (value.outcome === "ok" || value.outcome === "failed" || value.outcome === "timeout") &&
    nonnegativeInteger(value.duration_ms) &&
    (value.usage === null || isReviewTokenUsage(value.usage))
  );
}
