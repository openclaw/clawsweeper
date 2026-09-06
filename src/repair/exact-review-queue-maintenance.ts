#!/usr/bin/env node
import { createHash } from "node:crypto";
import { ExactReviewBatchQueueClient } from "./exact-review-batch-queue-client.js";

const apply = process.argv.includes("--apply");
const maxItems = integerArg("--max-items", 100, 1, 100);
const requestedPasses = integerArg("--passes", 1, 1, 100);
const client = new ExactReviewBatchQueueClient({
  baseUrl: env("EXACT_REVIEW_QUEUE_URL"),
  webhookSecret: env("CLAWSWEEPER_WEBHOOK_SECRET"),
});

if (requestedPasses > 1) {
  console.error(
    `--passes=${requestedPasses} is deprecated and clamped to one observed pass per invocation`,
  );
}
const result = await client.reconcilePublications({ apply, maxItems });
console.log(
  JSON.stringify({
    ok: true,
    requestedPasses,
    effectivePasses: 1,
    ...result,
    // Retain stable row correlation without logging target or producer identities.
    sample: result.sample.map((sample) => ({
      identity_hash: createHash("sha256").update(sample.itemKey).digest("hex"),
      queueRevision: sample.queueRevision,
      reason: sample.reason,
      publicationRevision: sample.publicationRevision,
      supersededByRevision: sample.supersededByRevision,
      commandContext: sample.commandContext,
      acknowledgementState: sample.acknowledgementState,
      acknowledgementUnavailableReason: sample.acknowledgementUnavailableReason,
      supersedeSafe: sample.supersedeSafe,
      successorFenceState: sample.successorFenceState,
    })),
  }),
);

function integerArg(name: string, fallback: number, minimum: number, maximum: number): number {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? Number(process.argv[index + 1]) : fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
