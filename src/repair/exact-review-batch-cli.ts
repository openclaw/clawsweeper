#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ExactReviewBatchCompletion } from "./exact-review-batch-publisher.js";
import {
  ExactReviewBatchQueueClient,
  type ExactReviewBatchQueueItem,
} from "./exact-review-batch-queue-client.js";
import { commitPreparedStateBatch } from "./state-publication-batch.js";
import {
  validatePreparedStateMutationPlans,
  type PreparedStateMutationPlan,
} from "./state-publication-mutation.js";

type BatchManifest = {
  batchId: string;
  leaseOwner: string;
  items: Array<ExactReviewBatchQueueItem & { outcomePath: string }>;
};

const command = process.argv[2];
if (!command || !["claim", "heartbeat", "commit", "complete"].includes(command)) {
  throw new Error("usage: exact-review-batch-cli.ts <claim|heartbeat|commit|complete>");
}

const queueSecret = process.env.CLAWSWEEPER_WEBHOOK_SECRET;
if (!queueSecret) throw new Error("CLAWSWEEPER_WEBHOOK_SECRET is required");

const client = new ExactReviewBatchQueueClient({
  baseUrl: env("EXACT_REVIEW_QUEUE_URL"),
  webhookSecret: queueSecret,
});

if (command === "claim") await claim();
else if (command === "heartbeat") await heartbeat();
else if (command === "commit") await commit();
else await complete();

async function claim() {
  const leaseOwner = env("EXACT_REVIEW_BATCH_LEASE_OWNER");
  const batchId = env("EXACT_REVIEW_BATCH_ID");
  const lease = await client.claim({
    claimId: batchId,
    leaseOwner,
    maxItems: positiveInteger(env("EXACT_REVIEW_BATCH_MAX_ITEMS")),
  });
  if (!lease) {
    output("claimed", "false");
    return;
  }
  const fetched = await client.fetch({ batchId: lease.batchId, leaseOwner });
  const manifestPath = env("EXACT_REVIEW_BATCH_MANIFEST");
  const outcomeDir = join(dirname(manifestPath), "outcomes");
  const manifest: BatchManifest = {
    batchId: lease.batchId,
    leaseOwner,
    items: fetched.items.map((item, index) => ({
      ...item,
      outcomePath: join(outcomeDir, `${index}.json`),
    })),
  };
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  output("claimed", "true");
  output("batch_id", lease.batchId);
  output("item_count", String(manifest.items.length));
  output("manifest", manifestPath);
  // Fetch terminalizes members that drifted after claim. An all-stale batch is
  // already complete and must not require a target-owner credential.
  if (!manifest.items.length) return;
  const targets = manifest.items.map((item) => targetRepoFromDecision(item.decision));
  const owners = new Set(targets.map((target) => target.split("/", 1)[0]));
  if (owners.size !== 1) throw new Error("A publication batch must contain one target owner");
  output("target_owner", [...owners][0]!);
  output(
    "target_repositories",
    [...new Set(targets.map((target) => target.split("/")[1]))].join(","),
  );
}

async function heartbeat() {
  const manifest = readManifest();
  await client.heartbeat({
    batchId: manifest.batchId,
    leaseOwner: manifest.leaseOwner,
    items: manifest.items,
  });
  console.log(JSON.stringify({ ok: true, batch_id: manifest.batchId }));
}

async function commit() {
  const manifest = readManifest();
  const fetched = await client.fetch({
    batchId: manifest.batchId,
    leaseOwner: manifest.leaseOwner,
  });
  const active = new Map(fetched.items.map((item) => [item.itemKey, item]));
  const superseded: ExactReviewBatchCompletion[] = [];
  const plans: PreparedStateMutationPlan[] = [];
  for (const manifestItem of manifest.items) {
    const current = active.get(manifestItem.itemKey);
    if (!current || !existsSync(manifestItem.outcomePath)) continue;
    const outcome = objectValue(JSON.parse(readFileSync(manifestItem.outcomePath, "utf8")));
    if (outcome.kind === "superseded") {
      if (optionalObjectValue(outcome.disposition).requeueLatestExpected !== true) {
        superseded.push({ ...current, terminalOutcome: "superseded" });
      }
      continue;
    }
    if (outcome.kind !== "eligible") continue;
    const [plan] = validatePreparedStateMutationPlans([
      outcome.plan as PreparedStateMutationPlan,
    ]).plans;
    if (
      !plan ||
      plan.identity.itemKey !== current.itemKey ||
      plan.identity.revision !== current.revision ||
      plan.identity.claimGeneration !== current.claimGeneration
    ) {
      throw new Error(`Batch outcome identity does not match ${current.itemKey}`);
    }
    plans.push(plan);
  }

  let stateCommitSha: string | undefined;
  try {
    if (plans.length) {
      stateCommitSha = commitPreparedStateBatch({
        batchId: manifest.batchId,
        plans,
      }).commitSha;
    }
  } catch (error) {
    await acknowledge(manifest, superseded, undefined, failureFingerprint(error));
    throw error;
  }
  const receiptPath = batchReceiptPath();
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(
    receiptPath,
    `${JSON.stringify(
      {
        batchId: manifest.batchId,
        stateCommitSha: stateCommitSha ?? null,
        publishedItemKeys: plans.map((plan) => plan.identity.itemKey),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(
    JSON.stringify({
      ok: true,
      batch_id: manifest.batchId,
      state_commit_sha: stateCommitSha ?? null,
      materialized: plans.length,
      superseded: superseded.length,
    }),
  );
}

async function complete() {
  const manifest = readManifest();
  const receipt = objectValue(JSON.parse(readFileSync(batchReceiptPath(), "utf8")));
  if (receipt.batchId !== manifest.batchId) throw new Error("Batch receipt identity mismatch");
  const publishedKeys = new Set(
    Array.isArray(receipt.publishedItemKeys)
      ? receipt.publishedItemKeys.map((value) => stringValue(value, "publishedItemKey"))
      : [],
  );
  const fetched = await client.fetch({
    batchId: manifest.batchId,
    leaseOwner: manifest.leaseOwner,
  });
  const active = new Map(fetched.items.map((item) => [item.itemKey, item]));
  const completions: ExactReviewBatchCompletion[] = [];
  for (const manifestItem of manifest.items) {
    const current = active.get(manifestItem.itemKey);
    if (!current || !existsSync(manifestItem.outcomePath)) continue;
    const outcome = objectValue(JSON.parse(readFileSync(manifestItem.outcomePath, "utf8")));
    if (outcome.kind === "superseded") {
      if (
        optionalObjectValue(outcome.disposition).requeueLatestExpected === true &&
        outcome.postEffectsComplete !== true
      ) {
        continue;
      }
      completions.push({ ...current, terminalOutcome: "superseded" });
      continue;
    }
    if (outcome.kind !== "eligible" || !publishedKeys.has(current.itemKey)) continue;
    const disposition = objectValue(outcome.disposition);
    const requiresDeferredEffect =
      disposition.requeueLatestExpected === true ||
      disposition.deferredCloseCoverageExpected === true ||
      disposition.routableSyncExpected === true;
    if (requiresDeferredEffect && outcome.postEffectsComplete !== true) continue;
    completions.push({ ...current, terminalOutcome: "published" });
  }
  const stateCommitSha =
    typeof receipt.stateCommitSha === "string" && receipt.stateCommitSha
      ? receipt.stateCommitSha
      : undefined;
  const result = await acknowledge(manifest, completions, stateCommitSha);
  console.log(
    JSON.stringify({
      ok: true,
      batch_id: manifest.batchId,
      accepted: result?.accepted ?? 0,
      retryable: fetched.items.length - completions.length,
    }),
  );
}

async function acknowledge(
  manifest: BatchManifest,
  completions: ExactReviewBatchCompletion[],
  stateCommitSha?: string,
  failure?: string,
) {
  if (!completions.length) return null;
  return client.complete({
    batchId: manifest.batchId,
    leaseOwner: manifest.leaseOwner,
    items: completions,
    ...(stateCommitSha ? { stateCommitSha } : {}),
    ...(failure ? { failureFingerprint: failure } : {}),
  });
}

function readManifest(): BatchManifest {
  const value = objectValue(JSON.parse(readFileSync(env("EXACT_REVIEW_BATCH_MANIFEST"), "utf8")));
  if (!Array.isArray(value.items)) throw new Error("Batch manifest items must be an array");
  return {
    batchId: stringValue(value.batchId, "batchId"),
    leaseOwner: stringValue(value.leaseOwner, "leaseOwner"),
    items: value.items.map((entry) => {
      const item = objectValue(entry);
      return {
        itemKey: stringValue(item.itemKey, "itemKey"),
        revision: positiveInteger(item.revision),
        claimGeneration: positiveInteger(item.claimGeneration),
        decision: item.decision,
        outcomePath: stringValue(item.outcomePath, "outcomePath"),
      };
    }),
  };
}

function batchReceiptPath(): string {
  return (
    process.env.EXACT_REVIEW_BATCH_RECEIPT ||
    join(dirname(env("EXACT_REVIEW_BATCH_MANIFEST")), "state-receipt.json")
  );
}

function output(name: string, value: string) {
  const path = process.env.GITHUB_OUTPUT;
  if (path) writeFileSync(path, `${name}=${value}\n`, { encoding: "utf8", flag: "a" });
  else console.log(`${name}=${value}`);
}

function failureFingerprint(error: unknown): string {
  const detail = error instanceof Error ? `${error.name}:${error.message}` : String(error);
  return createHash("sha256").update(detail).digest("hex");
}

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object");
  }
  return value as Record<string, unknown>;
}

function optionalObjectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid ${name}`);
  return value;
}

function positiveInteger(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("Expected a positive integer");
  return number;
}

function targetRepoFromDecision(value: unknown): string {
  const repo = stringValue(objectValue(value).targetRepo, "decision.targetRepo");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error("Invalid decision.targetRepo");
  }
  return repo;
}
