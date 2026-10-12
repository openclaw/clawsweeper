import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import {
  assertReportPublicationPolicy,
  decisionPublicationPolicy,
  RECORD_COMMENT_ONLY,
  manualPublicationOwnerFrom,
} from "./manual-publication-policy.js";
import { ExactReviewBatchQueueTransportError } from "./repair/exact-review-queue-transport-error.js";
import { isJsonObject } from "./repair/json-types.js";
import {
  hasQueueReviewLeaseIdentity,
  queueReviewLeaseIdentityFromReport,
} from "./review-lease-identity.js";

export class ManualPublicationAuthorityTransportError extends ExactReviewBatchQueueTransportError {
  constructor(reason: ExactReviewBatchQueueTransportError["reason"]) {
    super(reason, `manual publication authority unavailable (${reason})`);
    this.name = "ManualPublicationAuthorityTransportError";
  }
}

export function manualPublicationAuthorityTransportErrorFromStderr(stderr: string) {
  const match = stderr.match(
    /^ManualPublicationAuthorityTransportError: manual publication authority unavailable \((network_error|timeout|HTTP_(?:429|5\d\d))\)$/m,
  );
  return match
    ? new ManualPublicationAuthorityTransportError(
        match[1] as ExactReviewBatchQueueTransportError["reason"],
      )
    : null;
}

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
// Reused immediately before each apply mutation, including retries.
export function assertQueueReviewPublicationAuthority(
  markdown: string,
  targetRepo: string,
  number: number,
): void {
  if (!hasQueueReviewLeaseIdentity(markdown)) return;
  assertPublicationAuthority(markdown, targetRepo, number, false);
}

export function assertManualPublicationAuthority(
  markdown: string,
  targetRepo: string,
  number: number,
): void {
  assertPublicationAuthority(markdown, targetRepo, number, true);
}

function assertPublicationAuthority(
  markdown: string,
  targetRepo: string,
  number: number,
  manual: boolean,
): void {
  const queueIdentity = queueReviewLeaseIdentityFromReport(markdown);
  if (hasQueueReviewLeaseIdentity(markdown) && !queueIdentity) {
    throw new Error("queue publication requires a valid review lease identity");
  }
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
      "--write-out",
      "%{http_code}",
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
  const output = result.stdout || "";
  const httpStatus = /\d{3}$/.test(output) ? Number(output.slice(-3)) : 0;
  if (
    (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ||
    result.status === 28
  )
    throw new ManualPublicationAuthorityTransportError("timeout");
  if (result.error) throw new Error("manual publication fence is unavailable or expired");
  if ([5, 6, 7, 16, 18, 35, 52, 55, 56, 92].includes(result.status ?? -1))
    throw new ManualPublicationAuthorityTransportError("network_error");
  if (
    (result.status === 0 || result.status === 22) &&
    (httpStatus === 429 || (httpStatus >= 500 && httpStatus <= 599))
  )
    throw new ManualPublicationAuthorityTransportError(`HTTP_${httpStatus}`);
  if (result.status !== 0 || httpStatus !== 200)
    throw new Error("manual publication fence is unavailable or expired");
  let response: unknown;
  try {
    response = JSON.parse(output.slice(0, -3));
  } catch {
    throw new Error("manual publication authority response is invalid");
  }
  if (
    !isJsonObject(response) ||
    response.ok !== true ||
    !isJsonObject(response.decision) ||
    response.decision.targetRepo !== targetRepo ||
    response.decision.itemNumber !== number ||
    (manual && decisionPublicationPolicy(response.decision) !== RECORD_COMMENT_ONLY)
  ) {
    throw new Error("manual publication decision differs from queue authority");
  }
  if (queueIdentity) {
    const authority = response.queueIdentity;
    if (
      !isJsonObject(authority) ||
      authority.kind !== "queue" ||
      authority.itemKey !== queueIdentity.itemKey ||
      authority.leaseRevision !== queueIdentity.leaseRevision ||
      authority.claimGeneration !== queueIdentity.claimGeneration ||
      authority.runId !== queueIdentity.runId ||
      authority.runAttempt !== queueIdentity.runAttempt
    ) {
      throw new Error("queue publication review identity differs from queue authority");
    }
  }
  assertReportPublicationPolicy(
    markdown,
    manual ? RECORD_COMMENT_ONLY : decisionPublicationPolicy(response.decision),
  );
}
