#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const workerPath = path.join(process.cwd(), "dashboard", "worker.ts");
const queuePath = path.join(process.cwd(), "dashboard", "exact-review-queue.ts");
const worker = fs.readFileSync(workerPath, "utf8");
const queue = fs.readFileSync(queuePath, "utf8");

// Strip comments and string literals so a comment or string mentioning a
// forbidden name cannot satisfy or trip the check.
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/`(?:\\.|[^`\\])*`/g, '""')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, '""');
}

const workerCode = codeOnly(worker);
const queueCode = codeOnly(queue);

// A real import statement, not a mention in a comment or string.
if (!/^import[\s\S]*?from\s*"\.\/exact-review-queue\.ts";/m.test(worker)) {
  throw new Error("dashboard/worker.ts must import the exact-review queue service module");
}

// The queue module must actually define the service.
if (!/\bclass ExactReviewQueue\b/.test(queueCode)) {
  throw new Error("dashboard/exact-review-queue.ts must define class ExactReviewQueue");
}

const forbidden = [
  /\bclass ExactReviewQueue\b/,
  /\bfunction exactReviewEffectiveLeaseExpiresAt\b/,
  /\bfunction reclaimExpiredExactReviewLease(?:s)?\b/,
  /\bfunction exactReviewQueueDebouncedAttemptAt\b/,
  /\bfunction exactReviewQueueAdmittedItems\b/,
  /\bEXACT_REVIEW_QUEUE_(?:META|ITEM|DELIVERY|METRICS)_TABLE\s*=/,
];

for (const pattern of forbidden) {
  if (pattern.test(workerCode)) {
    throw new Error(`dashboard/worker.ts redefines queue-critical logic: ${pattern}`);
  }
}

console.log("dashboard queue boundary check passed");
