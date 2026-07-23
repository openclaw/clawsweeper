#!/usr/bin/env node
import { ExactReviewBatchQueueClient } from "./exact-review-batch-queue-client.js";

const apply = process.argv.includes("--apply");
const maxItems = integerArg("--max-items", 100, 1, 100);
const passes = integerArg("--passes", apply ? 1 : 1, 1, 100);
const client = new ExactReviewBatchQueueClient({
  baseUrl: env("EXACT_REVIEW_QUEUE_URL"),
  webhookSecret: env("CLAWSWEEPER_WEBHOOK_SECRET"),
});

for (let pass = 1; pass <= passes; pass += 1) {
  const result = await client.reconcilePublications({ apply, maxItems });
  console.log(JSON.stringify({ ok: true, pass, ...result }));
  if (!apply || result.changed === 0 || result.eligibleRemaining === 0) break;
}

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
