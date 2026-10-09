#!/usr/bin/env node
// Builds exact-review queue request bodies for workflow steps.
// Workflow steps send the body with control_plane_curl.
import { parseArgs } from "node:util";

type ExactReviewLease = {
  itemKey: string;
  leaseId: string;
  leaseRevision: number;
  claimGeneration: number;
  runId: string;
  runAttempt: number;
  sourceHeadSha: string | null;
};

// The queue accepts a review acknowledgement only on a status heartbeat,
// and generation_start only on a review heartbeat.
type ExactReviewHeartbeat =
  | { phase: "review"; generationStart?: boolean }
  | { phase: "status"; reviewAcknowledgementCommentId?: number }
  | { phase: "finalizing" };

try {
  process.stdout.write(JSON.stringify(exactReviewQueueRequest(process.argv.slice(2), process.env)));
} catch (error) {
  process.stderr.write(`exact-review-queue-request: ${(error as Error).message}\n`);
  process.exitCode = 1;
}

function exactReviewQueueRequest(argv: string[], env: NodeJS.ProcessEnv) {
  const [command, ...args] = argv;
  if (command !== "heartbeat") {
    throw new Error("usage: heartbeat --phase <review|status|finalizing>");
  }
  return exactReviewHeartbeatBody(exactReviewLeaseFromEnv(env), heartbeatFromArgs(args));
}

// Reads the lease tuple that the claim step exports to each lease-holding step.
function exactReviewLeaseFromEnv(env: NodeJS.ProcessEnv): ExactReviewLease {
  const itemKey = env.EXACT_REVIEW_ITEM_KEY ?? "";
  const leaseId = env.EXACT_REVIEW_LEASE_ID ?? "";
  const runId = env.GITHUB_RUN_ID ?? "";
  const sourceHeadSha = (env.EXACT_REVIEW_SOURCE_HEAD_SHA ?? "").trim().toLowerCase();
  if (!itemKey || !leaseId) throw new Error("missing exact-review lease tuple");
  if (!/^\d+$/.test(runId)) throw new Error("invalid GITHUB_RUN_ID");
  if (sourceHeadSha && !/^[0-9a-f]{40}$/.test(sourceHeadSha)) {
    throw new Error("invalid EXACT_REVIEW_SOURCE_HEAD_SHA");
  }
  return {
    itemKey,
    leaseId,
    leaseRevision: positiveInteger(env.EXACT_REVIEW_LEASE_REVISION, "EXACT_REVIEW_LEASE_REVISION"),
    claimGeneration: positiveInteger(
      env.EXACT_REVIEW_CLAIM_GENERATION,
      "EXACT_REVIEW_CLAIM_GENERATION",
    ),
    runId,
    runAttempt: positiveInteger(env.GITHUB_RUN_ATTEMPT, "GITHUB_RUN_ATTEMPT"),
    sourceHeadSha: sourceHeadSha || null,
  };
}

function exactReviewHeartbeatBody(lease: ExactReviewLease, heartbeat: ExactReviewHeartbeat) {
  return {
    item_key: lease.itemKey,
    lease_id: lease.leaseId,
    lease_revision: lease.leaseRevision,
    claim_generation: lease.claimGeneration,
    run_id: lease.runId,
    run_attempt: lease.runAttempt,
    ...(lease.sourceHeadSha ? { source_head_sha: lease.sourceHeadSha } : {}),
    ...(heartbeat.phase === "status" && heartbeat.reviewAcknowledgementCommentId !== undefined
      ? { review_acknowledgement_comment_id: heartbeat.reviewAcknowledgementCommentId }
      : {}),
    phase: heartbeat.phase,
    ...(heartbeat.phase === "review" && heartbeat.generationStart
      ? { generation_start: true }
      : {}),
  };
}

function heartbeatFromArgs(args: string[]): ExactReviewHeartbeat {
  const { values } = parseArgs({
    args,
    options: {
      phase: { type: "string" },
      "review-acknowledgement-comment-id": { type: "string" },
      "generation-start": { type: "boolean", default: false },
    },
  });
  const acknowledgement = values["review-acknowledgement-comment-id"];
  if (acknowledgement !== undefined && values.phase !== "status") {
    throw new Error("--review-acknowledgement-comment-id requires --phase status");
  }
  if (values["generation-start"] && values.phase !== "review") {
    throw new Error("--generation-start requires --phase review");
  }
  switch (values.phase) {
    case "review":
      return { phase: "review", generationStart: values["generation-start"] };
    case "status":
      return acknowledgement === undefined
        ? { phase: "status" }
        : {
            phase: "status",
            reviewAcknowledgementCommentId: positiveInteger(
              acknowledgement,
              "--review-acknowledgement-comment-id",
            ),
          };
    case "finalizing":
      return { phase: "finalizing" };
    default:
      throw new Error("--phase must be review, status or finalizing");
  }
}

function positiveInteger(value: string | undefined, name: string) {
  const number = Number(value);
  if (!value || !Number.isSafeInteger(number) || number < 1) throw new Error(`invalid ${name}`);
  return number;
}
