#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ExactReviewBatchQueueClient } from "./exact-review-batch-queue-client.js";

if (process.argv[2] === "retire-closed-publication") {
  try {
    await retireClosedPublication();
  } catch {
    // Artifacts, signed redirect URLs, and transport failures can contain private
    // identities. This operator surface deliberately emits no exception detail.
    console.error('{"ok":false,"status":"retirement_failed"}');
    console.error("[exact-review-queue-maintenance] FAILED (exit 1)");
    process.exitCode = 1;
  }
} else if (validReconciliationArguments()) {
  await reconcile();
} else {
  console.error("[exact-review-queue-maintenance] invalid arguments");
  console.error("[exact-review-queue-maintenance] FAILED (exit 1)");
  process.exitCode = 1;
}

function validReconciliationArguments(): boolean {
  const args = process.argv.slice(2);
  try {
    parseArgs({
      args: args[0] === "--" ? args.slice(1) : args,
      options: {
        apply: { type: "boolean" },
        "max-items": { type: "string" },
        passes: { type: "string" },
      },
    });
    return true;
  } catch {
    return false;
  }
}

async function retireClosedPublication() {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      apply: { type: "boolean", default: false },
      "plan-file": { type: "string" },
      "producer-run-id": { type: "string" },
      "artifact-id": { type: "string" },
      "publication-key-sha256": { type: "string" },
      "queue-revision": { type: "string" },
      "reviewed-plan-sha256": { type: "string" },
    },
  });
  if (!values["plan-file"]) throw new Error("plan file required");
  const {
    prepareClosedPublicationRetirement,
    applyClosedPublicationRetirement,
    retirementPlanSummary,
  } = await import("./closed-publication-retirement.js");
  if (values.apply) {
    if (statSync(values["plan-file"]).size > 8192) throw new Error("plan too large");
    const bytes = readFileSync(values["plan-file"]);
    if (bytes.length > 8192) throw new Error("plan too large");
    const result = await applyClosedPublicationRetirement(
      JSON.parse(bytes.toString("utf8")),
      values["reviewed-plan-sha256"] ?? "",
      env("GITHUB_SHA"),
      () =>
        new ExactReviewBatchQueueClient({
          baseUrl: env("EXACT_REVIEW_QUEUE_URL"),
          webhookSecret: env("CLAWSWEEPER_WEBHOOK_SECRET"),
        }),
    );
    console.log(JSON.stringify(result));
    return;
  }
  const plan = await prepareClosedPublicationRetirement(
    {
      producerRunId: Number(values["producer-run-id"]),
      artifactId: Number(values["artifact-id"]),
      publicationKeySha256: values["publication-key-sha256"] ?? "",
      queueRevision: Number(values["queue-revision"]),
      workflowSha: env("GITHUB_SHA"),
    },
    env("GH_TOKEN"),
  );
  writeFileSync(values["plan-file"], JSON.stringify(plan), { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify(retirementPlanSummary(plan)));
}

async function reconcile() {
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
