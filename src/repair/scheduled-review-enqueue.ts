#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ExactReviewBatchQueueClient } from "./exact-review-batch-queue-client.js";
import { parseArgs } from "./lib.js";

type ScheduledReviewLane = "hot_intake" | "normal_backfill";

type PlanCandidate = {
  repo: string;
  number: number;
  kind: "issue" | "pull_request";
  updatedAt: string;
};

type ScheduledReviewPlan = {
  candidates: PlanCandidate[];
  selection?: Array<{ ageMs?: number }>;
};

export type ScheduledReviewEnqueueSummary = {
  lane: ScheduledReviewLane;
  offered: number;
  attempted: number;
  queued: number;
  deduped: number;
  shed: number;
  rateLimited: number;
  backpressured: number;
  rejected: number;
  deferred: number;
  ageHours: { p50: number | null; p90: number | null; max: number | null };
};

type EnqueueOptions = {
  plan: ScheduledReviewPlan;
  lane: ScheduledReviewLane;
  targetRepo: string;
  targetBranch: string;
  queueUrl: string;
  secret: string;
  deliveryPrefix: string;
  fetchImpl?: typeof fetch;
};

export async function enqueueScheduledReviewPlan(
  options: EnqueueOptions,
): Promise<ScheduledReviewEnqueueSummary> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const targetBranch = options.targetBranch.trim();
  if (!isPlausibleTargetBranch(targetBranch)) {
    throw new Error("scheduled review target branch is invalid");
  }
  for (const candidate of options.plan.candidates) validateCandidate(candidate, options.targetRepo);
  const queueUrl = options.queueUrl.replace(/\/$/, "");
  const queueClient = new ExactReviewBatchQueueClient({
    baseUrl: queueUrl,
    webhookSecret: options.secret,
    fetch: fetchImpl,
  });
  const capabilityResponse = await fetchImpl(`${queueUrl}/api/exact-review-queue`, {
    signal: AbortSignal.timeout(20_000),
  });
  const capability = (await capabilityResponse.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const scheduledFeed = capability?.scheduled_feed as Record<string, unknown> | undefined;
  if (
    !capabilityResponse.ok ||
    !scheduledFeed ||
    !Number.isFinite(Number(scheduledFeed.target_rate_per_hour)) ||
    scheduledFeed.enqueue_replay !== "scheduled_disposition_v1"
  ) {
    throw new Error("exact-review queue does not advertise scheduled feed admission");
  }
  const ages = (options.plan.selection ?? [])
    .map((selection) => Number(selection.ageMs))
    .filter((age) => Number.isFinite(age) && age >= 0)
    .sort((left, right) => left - right);
  const percentileHours = (quantile: number): number | null => {
    if (!ages.length) return null;
    const value = ages[Math.ceil(ages.length * quantile) - 1] ?? ages.at(-1);
    return value === undefined ? null : Math.round((value / 3_600_000) * 10) / 10;
  };
  const summary: ScheduledReviewEnqueueSummary = {
    lane: options.lane,
    offered: options.plan.candidates.length,
    attempted: 0,
    queued: 0,
    deduped: 0,
    shed: 0,
    rateLimited: 0,
    backpressured: 0,
    rejected: 0,
    deferred: 0,
    ageHours: {
      p50: percentileHours(0.5),
      p90: percentileHours(0.9),
      max: percentileHours(1),
    },
  };

  for (const [index, candidate] of options.plan.candidates.entries()) {
    const payload = JSON.stringify({
      delivery_id: `${options.deliveryPrefix}:${index}:${candidate.number}`,
      decision: {
        targetRepo: options.targetRepo,
        targetBranch,
        itemNumber: candidate.number,
        itemKind: candidate.kind,
        sourceEvent: candidate.kind === "pull_request" ? "pull_request" : "issues",
        sourceAction:
          options.lane === "hot_intake" ? "scheduled_hot_intake" : "scheduled_normal_backfill",
        supersedesInProgress: false,
        sourceUpdatedAt: candidate.updatedAt,
      },
    });
    summary.attempted += 1;
    const body = await queueClient.enqueueScheduledReview(payload);
    if (body.ok !== true) {
      throw new Error(`scheduled review queue rejected ${candidate.repo}#${candidate.number}`);
    }
    if (body.queued === true) summary.queued += 1;
    else if (body.deduped === true) summary.deduped += 1;
    else if (body.shed === true) {
      summary.shed += 1;
      if (body.reason === "scheduled_rate") summary.rateLimited += 1;
      else summary.backpressured += 1;
      summary.deferred = options.plan.candidates.length - index - 1;
      break;
    } else if (body.accepted === false) summary.rejected += 1;
    else {
      throw new Error(
        `scheduled review queue returned an unknown disposition for ${candidate.repo}#${candidate.number}`,
      );
    }
  }

  return summary;
}

function isPlausibleTargetBranch(value: string): boolean {
  return /^[A-Za-z0-9_./-]+$/.test(value) && !/^\d+$/.test(value) && !value.includes("..");
}

function validateCandidate(candidate: PlanCandidate, targetRepo: string): void {
  if (candidate.repo !== targetRepo)
    throw new Error("scheduled review candidate repository mismatch");
  if (!Number.isSafeInteger(candidate.number) || candidate.number < 1) {
    throw new Error("scheduled review candidate number is invalid");
  }
  if (candidate.kind !== "issue" && candidate.kind !== "pull_request") {
    throw new Error("scheduled review candidate kind is invalid");
  }
  if (!Number.isFinite(Date.parse(candidate.updatedAt))) {
    throw new Error("scheduled review candidate updatedAt is invalid");
  }
}

function readPlan(filePath: string): ScheduledReviewPlan {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  if (!Array.isArray(parsed.candidates)) throw new Error("scheduled review plan has no candidates");
  return {
    candidates: parsed.candidates as PlanCandidate[],
    ...(Array.isArray(parsed.selection)
      ? { selection: parsed.selection as Array<{ ageMs?: number }> }
      : {}),
  };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new Error(`${label} is required`);
}

function scheduledReviewLane(value: unknown): ScheduledReviewLane {
  if (value === "hot_intake" || value === "normal_backfill") return value;
  throw new Error("--lane must be hot_intake or normal_backfill");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await enqueueScheduledReviewPlan({
    plan: readPlan(requiredString(args.plan, "--plan")),
    lane: scheduledReviewLane(args.lane),
    targetRepo: requiredString(args["target-repo"], "--target-repo"),
    targetBranch: requiredString(args["target-branch"], "--target-branch"),
    queueUrl: requiredString(args["queue-url"], "--queue-url"),
    secret: requiredString(process.env.CLAWSWEEPER_WEBHOOK_SECRET, "CLAWSWEEPER_WEBHOOK_SECRET"),
    deliveryPrefix: requiredString(args["delivery-prefix"], "--delivery-prefix"),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
