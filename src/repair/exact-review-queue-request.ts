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

// One review revision in the publication lifecycle of one target item.
type ExactReviewLifecycleTarget = {
  canonical_target_key: string;
  fence_key: string;
  revision: number;
};

// The values that the queue accepts for each lifecycle record.
const ROUTER_OUTCOMES = ["durable", "not_required"] as const;
const CANONICAL_OUTCOMES = ["accepted", "deduped", "superseded"] as const;
// The terminal dispositions that workflow steps record.
const TERMINAL_DISPOSITIONS = [
  "requeue",
  "target_missing",
  "target_closed",
  "guarded_open",
  "policy_noop",
] as const;

try {
  process.stdout.write(JSON.stringify(exactReviewQueueRequest(process.argv.slice(2), process.env)));
} catch (error) {
  process.stderr.write(`exact-review-queue-request: ${(error as Error).message}\n`);
  process.exitCode = 1;
}

function exactReviewQueueRequest(argv: string[], env: NodeJS.ProcessEnv) {
  const [command, ...args] = argv;
  switch (command) {
    case "heartbeat":
      return exactReviewHeartbeatBody(exactReviewLeaseFromEnv(env), heartbeatFromArgs(args));
    case "lifecycle":
      return exactReviewLifecycleBody(args, env);
    default:
      throw new Error(
        "usage: heartbeat --phase <review|status|finalizing> | lifecycle <router-receipt|canonical-receipt|terminal-disposition>",
      );
  }
}

// Reads the lease tuple that the claim step exports to each lease-holding step.
function exactReviewLeaseFromEnv(env: NodeJS.ProcessEnv): ExactReviewLease {
  const itemKey = env.EXACT_REVIEW_ITEM_KEY ?? "";
  const leaseId = env.EXACT_REVIEW_LEASE_ID ?? "";
  const sourceHeadSha = (env.EXACT_REVIEW_SOURCE_HEAD_SHA ?? "").trim().toLowerCase();
  if (!itemKey || !leaseId) throw new Error("missing exact-review lease tuple");
  const { runId, runAttempt } = githubRun(env);
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
    runAttempt,
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

function exactReviewLifecycleBody(args: string[], env: NodeJS.ProcessEnv) {
  const [record, ...options] = args;
  switch (record) {
    case "router-receipt": {
      const { values } = parseArgs({
        args: options,
        options: { outcome: { type: "string" }, "receipt-id-prefix": { type: "string" } },
      });
      // The queue reads a missing outcome as "durable".
      const outcome =
        values.outcome === undefined
          ? undefined
          : oneOf(values.outcome, ROUTER_OUTCOMES, "--outcome");
      return {
        ...exactReviewLifecycleTarget(env),
        ...(outcome === undefined ? {} : { outcome }),
        receipt_id: receiptId(values["receipt-id-prefix"], env),
      };
    }
    case "canonical-receipt": {
      const { values } = parseArgs({
        args: options,
        options: { outcome: { type: "string" }, "receipt-id-prefix": { type: "string" } },
      });
      return {
        ...exactReviewLifecycleTarget(env),
        outcome: oneOf(values.outcome, CANONICAL_OUTCOMES, "--outcome"),
        receipt_id: receiptId(values["receipt-id-prefix"], env),
      };
    }
    case "terminal-disposition": {
      const { values } = parseArgs({ args: options, options: { kind: { type: "string" } } });
      return {
        ...exactReviewLifecycleTarget(env),
        kind: oneOf(values.kind, TERMINAL_DISPOSITIONS, "--kind"),
      };
    }
    default:
      throw new Error(
        "lifecycle record must be router-receipt, canonical-receipt or terminal-disposition",
      );
  }
}

// Reads the target item and the publisher fence that each lifecycle step receives.
function exactReviewLifecycleTarget(env: NodeJS.ProcessEnv): ExactReviewLifecycleTarget {
  const targetRepo = env.TARGET_REPO ?? "";
  const fenceKey = env.FENCE_KEY ?? "";
  if (!/^[^/\s]+\/[^/\s]+$/.test(targetRepo)) throw new Error("invalid TARGET_REPO");
  if (!fenceKey) throw new Error("missing FENCE_KEY");
  return {
    canonical_target_key: `${targetRepo}#${positiveInteger(env.ITEM_NUMBER, "ITEM_NUMBER")}`,
    fence_key: fenceKey,
    revision: positiveInteger(env.REVISION, "REVISION"),
  };
}

// A receipt id names the step and the workflow run attempt that sent it.
function receiptId(prefix: string | undefined, env: NodeJS.ProcessEnv) {
  if (!prefix || !/^[a-z]+(?:-[a-z]+)*$/.test(prefix)) {
    throw new Error("invalid --receipt-id-prefix");
  }
  const { runId, runAttempt } = githubRun(env);
  return `${prefix}:${runId}:${runAttempt}`;
}

function githubRun(env: NodeJS.ProcessEnv) {
  const runId = env.GITHUB_RUN_ID ?? "";
  if (!/^\d+$/.test(runId)) throw new Error("invalid GITHUB_RUN_ID");
  return { runId, runAttempt: positiveInteger(env.GITHUB_RUN_ATTEMPT, "GITHUB_RUN_ATTEMPT") };
}

function oneOf<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  name: string,
): T {
  const match = allowed.find((entry) => entry === value);
  if (match === undefined) throw new Error(`${name} must be ${allowed.join(", ")}`);
  return match;
}

function positiveInteger(value: string | undefined, name: string) {
  const number = Number(value);
  if (!value || !Number.isSafeInteger(number) || number < 1) throw new Error(`invalid ${name}`);
  return number;
}
