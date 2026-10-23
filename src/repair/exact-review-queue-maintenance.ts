#!/usr/bin/env node
import { verifyCanonicalBodyLifecycle } from "../canonical-body-tiering-policy.js";
import { sha256 } from "../content-hash.js";
import { requiredEnv as env } from "../required-env.js";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ExactReviewBatchQueueClient } from "./exact-review-batch-queue-client.js";
import { ExactReviewBatchQueueRequestError } from "./exact-review-queue-transport-error.js";

const canonicalProgress: {
  stage: "arguments" | "lifecycle" | "queue_request" | "queue_response";
  completed_passes: number;
  last_observed_checkpoint: Record<string, number | null> | null;
} = { stage: "arguments", completed_passes: 0, last_observed_checkpoint: null };

if (process.argv[2] === "canonical-bodies") {
  try {
    await maintainCanonicalBodies();
  } catch (error) {
    const failure = error instanceof ExactReviewBatchQueueRequestError ? error : null;
    // A shaped server string may still contain a private identifier. Only these
    // endpoint-owned codes and closed transport fields may reach operator logs.
    const code = failure?.details.code;
    console.error(
      JSON.stringify({
        ok: false,
        status: "canonical_tiering_failed",
        ...canonicalProgress,
        reason: failure?.reason.startsWith("HTTP_") ? "http_error" : (failure?.reason ?? "unknown"),
        http_status: failure?.details.status ?? null,
        code:
          code &&
          [
            "canonical_tiering_deployment_mismatch",
            "canonical_tiering_reviewed_preview_required",
            "invalid_canonical_tiering_action",
            "exact_review_queue_unavailable",
            "exact_review_queue_not_configured",
            "invalid_signature",
            "webhook_not_configured",
          ].includes(code)
            ? code
            : null,
        failure_category: failure?.details.category ?? null,
        trace_id: failure?.details.traceId ?? null,
      }),
    );
    console.error("[exact-review-queue-maintenance] FAILED (exit 1)");
    process.exitCode = 1;
  }
} else if (process.argv[2] === "retire-closed-publication") {
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
        identity_hash: sha256(sample.itemKey),
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

async function maintainCanonicalBodies() {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      action: { type: "string", default: "preview" },
      apply: { type: "boolean", default: false },
      "expected-deployment-sha": { type: "string" },
      "attestation-file": { type: "string" },
      "reviewed-plan-sha256": { type: "string" },
      "previous-plan-sha256": { type: "string" },
    },
  });
  const action = values.action;
  const preview = action === "preview" || action === "requalify-preview";
  const requalification = action === "requalify-preview" || action === "requalify";
  if (
    !["preview", "activate", "migrate", "requalify-preview", "requalify"].includes(action) ||
    preview === values.apply ||
    (requalification && !/^[a-f0-9]{64}$/.test(values["previous-plan-sha256"] ?? ""))
  )
    throw new Error("invalid canonical tiering action");
  if (!values["attestation-file"] || statSync(values["attestation-file"]).size > 8192)
    throw new Error("bounded operator attestation required");
  const bytes = readFileSync(values["attestation-file"]);
  if (bytes.byteLength > 8192) throw new Error("attestation too large");
  const attestation: unknown = JSON.parse(bytes.toString("utf8"));
  canonicalProgress.stage = "lifecycle";
  await verifyCanonicalBodyLifecycle(
    attestation,
    env("CLOUDFLARE_ACCOUNT_ID"),
    env("CLOUDFLARE_API_TOKEN"),
  );
  const client = new ExactReviewBatchQueueClient({
    baseUrl: env("EXACT_REVIEW_QUEUE_URL"),
    webhookSecret: env("CLAWSWEEPER_WEBHOOK_SECRET"),
  });
  const started = Date.now();
  let result: Record<string, unknown> = {},
    previous: Record<string, unknown> | null = null,
    passes = 0,
    stop = "pass_limit";
  // Explicit migration drains bounded passes under one approved plan. It never
  // schedules an alarm or changes startup behavior; the durable cursor resumes.
  for (; passes < (action === "migrate" ? 100_000 : 1);) {
    if (Date.now() - started >= 50 * 60 * 1000) {
      stop = "time_limit";
      break;
    }
    canonicalProgress.stage = "queue_request";
    result = await client.maintainCanonicalBodies({
      action,
      execute: values.apply,
      expectedDeploymentSha: values["expected-deployment-sha"],
      reviewedPreviewSha256: values["reviewed-plan-sha256"],
      previousPlanSha256: values["previous-plan-sha256"],
      attestation,
    });
    canonicalProgress.stage = "queue_response";
    if (result.ok !== true)
      throw new ExactReviewBatchQueueRequestError(
        "invalid_response",
        "Invalid canonical maintenance response",
      );
    passes++;
    if (action !== "migrate") {
      stop = "requested_action";
      break;
    }
    const checkpoint = result.checkpoint as Record<string, unknown>;
    // The last acknowledged checkpoint is advisory: a lost response may follow
    // a committed pass. Never copy plan JSON or arbitrary response fields here.
    const progress: Record<string, number | null> = {};
    for (const key of [
      "after_rowid",
      "migrated",
      "scanned",
      "source_bytes",
      "conflicts",
      "completed_at",
    ]) {
      const value = checkpoint?.[key];
      if (
        value === null ||
        (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
      )
        progress[key] = value;
    }
    if (
      !Number.isSafeInteger(progress.after_rowid) ||
      !Number.isSafeInteger(progress.migrated) ||
      (progress.completed_at !== null && !Number.isSafeInteger(progress.completed_at))
    )
      throw new ExactReviewBatchQueueRequestError(
        "invalid_response",
        "Invalid canonical migration checkpoint",
      );
    canonicalProgress.last_observed_checkpoint = progress;
    canonicalProgress.completed_passes = passes;
    if (progress.completed_at !== null) {
      stop = "complete";
      break;
    }
    if (
      previous &&
      Number(progress.after_rowid) <= Number(previous.after_rowid) &&
      progress.migrated === previous.migrated
    ) {
      stop = "unresolved_source";
      break;
    }
    previous = progress;
    if (passes % 100 === 0) console.log(JSON.stringify({ ok: true, passes, checkpoint }));
  }
  console.log(JSON.stringify({ ...result, passes, stop }));
}
