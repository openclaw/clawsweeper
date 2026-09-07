import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import {
  assertReportPublicationPolicy,
  decisionPublicationPolicy,
  RECORD_COMMENT_ONLY,
  manualPublicationOwnerFrom,
} from "./manual-publication-policy.js";

export function manualPublicationOwnerFromEnv(env = process.env) {
  const run = { runId: env.GITHUB_RUN_ID, runAttempt: Number(env.GITHUB_RUN_ATTEMPT) };
  return manualPublicationOwnerFrom(
    env.EXACT_REVIEW_BATCH_ID || env.EXACT_REVIEW_BATCH_LEASE_OWNER
      ? {
          batchId: env.EXACT_REVIEW_BATCH_ID,
          leaseOwner: env.EXACT_REVIEW_BATCH_LEASE_OWNER,
          ...run,
        }
      : { leaseId: env.EXACT_REVIEW_LEASE_ID, ...run },
  );
}

// Read the current coordinator fence; this never heartbeats or revives a lease.
// Reused immediately before each restricted apply mutation, including retries.
export function assertManualPublicationAuthority(
  markdown: string,
  targetRepo: string,
  number: number,
): void {
  const env = process.env;
  const baseUrl = env.EXACT_REVIEW_QUEUE_URL || "";
  const secret = env.CLAWSWEEPER_WEBHOOK_SECRET || "";
  const itemKey = env.EXACT_REVIEW_BATCH_ITEM_KEY || env.EXACT_REVIEW_ITEM_KEY || "";
  const revision = Number(env.EXACT_REVIEW_BATCH_REVISION || env.EXACT_REVIEW_LEASE_REVISION);
  const claimGeneration = Number(
    env.EXACT_REVIEW_BATCH_CLAIM_GENERATION || env.EXACT_REVIEW_CLAIM_GENERATION,
  );
  if (
    !baseUrl.startsWith("https://") ||
    !secret ||
    !itemKey ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    !Number.isSafeInteger(claimGeneration) ||
    claimGeneration < 1
  ) {
    throw new Error("manual publication requires current queue authority");
  }
  const canonicalTargetKey = `${targetRepo}#${number}`;
  const body = JSON.stringify({
    owner: manualPublicationOwnerFromEnv(env),
    canonicalTargetKey,
    fenceKey: itemKey,
    revision,
    identity: { canonicalTargetKey, fenceKey: itemKey, revision, claimGeneration },
  });
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const result = spawnSync(
    "curl",
    [
      "--fail",
      "--silent",
      "--show-error",
      "--connect-timeout",
      "2",
      "--max-time",
      "5",
      "--request",
      "POST",
      "--header",
      "content-type: application/json",
      "--header",
      `x-clawsweeper-exact-review-signature: ${signature}`,
      "--data-binary",
      "@-",
      `${baseUrl.replace(/\/$/, "")}/internal/exact-review/publication-authority`,
    ],
    { encoding: "utf8", input: body, timeout: 6_000, maxBuffer: 1024 * 1024 },
  );
  if (result.error || result.status !== 0)
    throw new Error("manual publication fence is unavailable or expired", { cause: result.error });
  const response = JSON.parse(result.stdout);
  if (
    response.ok !== true ||
    response.decision?.targetRepo !== targetRepo ||
    response.decision?.itemNumber !== number ||
    decisionPublicationPolicy(response.decision) !== RECORD_COMMENT_ONLY
  ) {
    throw new Error("manual publication decision differs from queue authority");
  }
  assertReportPublicationPolicy(markdown, RECORD_COMMENT_ONLY);
}
