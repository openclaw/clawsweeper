import type { ReviewTriggerLane, ReviewTriggerOrigin } from "./review-telemetry.ts";

const RUN_OUTCOMES = new Set(["success", "failure", "cancelled", "skipped"]);
const TRIGGER_LANES = new Set(["exact_event", "hot_intake", "normal_backfill", "recovery"]);
const TRIGGER_ORIGINS = new Set(["webhook", "command", "schedule", "manual", "system"]);
const JOB_OUTCOMES = new Set(["success", "failure", "cancelled", "skipped"]);

export type DurableReviewRunTelemetry = {
  run_id: string;
  run_attempt: number;
  workflow_outcome: "success" | "failure" | "cancelled" | "skipped";
  trigger_lane: ReviewTriggerLane;
  trigger_origin: ReviewTriggerOrigin;
  target_repo: string | null;
  started_at: string;
  completed_at: string;
  run_url: string;
  plan_count: number;
  item_count: number;
  publication_count: number;
  source_event?: string;
  source_action?: string;
  review_jobs?: Array<{
    name: string;
    conclusion: "success" | "failure" | "cancelled" | "skipped";
    item_number: number | null;
  }>;
};

export function normalizeReviewRunTelemetry(value: unknown): DurableReviewRunTelemetry | null {
  const record = objectValue(value);
  const runId = String(record.run_id || "").trim();
  const runAttempt = Number(record.run_attempt);
  const workflowOutcome = String(record.workflow_outcome || "");
  const triggerLane = String(record.trigger_lane || "");
  const triggerOrigin = String(record.trigger_origin || "");
  const targetRepo = record.target_repo == null ? null : String(record.target_repo).trim();
  const startedAt = timestamp(record.started_at);
  const completedAt = timestamp(record.completed_at);
  const runUrl = String(record.run_url || "").trim();
  const planCount = nonNegativeInteger(record.plan_count);
  const itemCount = nonNegativeInteger(record.item_count);
  const publicationCount = nonNegativeInteger(record.publication_count);
  const sourceEvent = optionalString(record.source_event, 100);
  const sourceAction = optionalString(record.source_action, 200);
  const reviewJobs = normalizeReviewJobs(record.review_jobs);
  if (
    !/^\d+$/.test(runId) ||
    !Number.isSafeInteger(runAttempt) ||
    runAttempt < 1 ||
    !RUN_OUTCOMES.has(workflowOutcome) ||
    !TRIGGER_LANES.has(triggerLane) ||
    !TRIGGER_ORIGINS.has(triggerOrigin) ||
    (targetRepo !== null && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(targetRepo)) ||
    !startedAt ||
    !completedAt ||
    Date.parse(completedAt) < Date.parse(startedAt) ||
    !/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+$/.test(runUrl) ||
    planCount === null ||
    itemCount === null ||
    publicationCount === null ||
    sourceEvent === null ||
    sourceAction === null ||
    reviewJobs === null
  ) {
    return null;
  }
  return {
    run_id: runId,
    run_attempt: runAttempt,
    workflow_outcome: workflowOutcome as DurableReviewRunTelemetry["workflow_outcome"],
    trigger_lane: triggerLane as ReviewTriggerLane,
    trigger_origin: triggerOrigin as ReviewTriggerOrigin,
    target_repo: targetRepo,
    started_at: startedAt,
    completed_at: completedAt,
    run_url: runUrl,
    plan_count: planCount,
    item_count: itemCount,
    publication_count: publicationCount,
    ...(sourceEvent === undefined ? {} : { source_event: sourceEvent }),
    ...(sourceAction === undefined ? {} : { source_action: sourceAction }),
    ...(reviewJobs === undefined ? {} : { review_jobs: reviewJobs }),
  };
}

function normalizeReviewJobs(value: unknown): DurableReviewRunTelemetry["review_jobs"] | null {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > 1_000) return null;
  const jobs: NonNullable<DurableReviewRunTelemetry["review_jobs"]> = [];
  for (const valueJob of value) {
    const job = objectValue(valueJob);
    const name = optionalString(job.name, 200);
    const conclusion = String(job.conclusion || "");
    const itemNumber = job.item_number == null ? null : Number(job.item_number);
    if (
      !name ||
      !JOB_OUTCOMES.has(conclusion) ||
      (itemNumber !== null && (!Number.isSafeInteger(itemNumber) || itemNumber < 1))
    ) {
      return null;
    }
    jobs.push({
      name,
      conclusion: conclusion as NonNullable<
        DurableReviewRunTelemetry["review_jobs"]
      >[number]["conclusion"],
      item_number: itemNumber,
    });
  }
  return jobs;
}

function nonNegativeInteger(value: unknown) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function optionalString(value: unknown, maxLength: number) {
  if (value === undefined || value === null) return undefined;
  const string = String(value).trim();
  return string && string.length <= maxLength ? string : null;
}

function timestamp(value: unknown) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
