#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import type { ExactReviewBatchCompletion } from "./exact-review-batch-publisher.js";
import {
  ExactReviewBatchQueueClient,
  type ExactReviewGithubRateLimitObservation,
  type ExactReviewGithubRequestMetric,
  type ExactReviewBatchQueueItem,
  type ExactReviewBatchPostEffectRoute,
} from "./exact-review-batch-queue-client.js";
import { exactReviewBatchStateWriterProgressReporter } from "./exact-review-batch-state-writer-progress.js";
import { postDirectPublicationResult } from "./exact-review-direct-publication.js";
import { failureFingerprint } from "./error-fingerprint.js";
import { StateWriterTelemetryRecorder } from "./state-writer-telemetry-recorder.js";
import { normalizeRepo, slugForRepo } from "../repository-profiles.js";
import type { StateWriterOperation } from "../state-writer-telemetry.js";
import {
  validatePreparedStateMutationPlans,
  type PreparedStateMutationPlan,
} from "./state-publication-mutation.js";

type BatchManifest = {
  batchId: string;
  leaseOwner: string;
  leaseExpiresAt: string;
  configuredBatchSize: number;
  batchWaitMs: number;
  items: Array<ExactReviewBatchQueueItem & { outcomePath: string }>;
};

type BatchReceipt = {
  batchId: string;
  publishedItemKeys: Set<string>;
  outcomes: Map<string, BatchPublicationOutcome>;
  stateCommitSha?: string;
  stateWriter?: StateWriterOperation;
};

type BatchPublicationOutcome = {
  canonicalTargetKey: string;
  fenceKey: string;
  revision: number;
  claimGeneration: number;
  outcome: "accepted" | "deduped" | "superseded" | "retryable" | "permanent";
  reasonCode?: "state_contention" | "tuple_protocol_invalid" | "unknown_failure";
  errorFingerprint?: string;
};

const command = process.argv[2];
if (
  !command ||
  ![
    "claim",
    "heartbeat",
    "observe",
    "commit",
    "complete",
    "release",
    "rate-limit",
    "request-metric",
    "post-effect",
  ].includes(command)
) {
  throw new Error(
    "usage: exact-review-batch-cli.ts <claim|heartbeat|observe|commit|complete|release|rate-limit|request-metric|post-effect>",
  );
}

const queueSecret = process.env.CLAWSWEEPER_WEBHOOK_SECRET;
if (!queueSecret) throw new Error("CLAWSWEEPER_WEBHOOK_SECRET is required");

const client = new ExactReviewBatchQueueClient({
  baseUrl: env("EXACT_REVIEW_QUEUE_URL"),
  webhookSecret: queueSecret,
});

if (command === "claim") await claim();
else if (command === "heartbeat") await heartbeat();
else if (command === "observe") await observe();
else if (command === "commit") await commit();
else if (command === "complete") await complete();
else if (command === "release") await release();
else if (command === "rate-limit") recordRateLimit();
else if (command === "post-effect") await postEffect();
else recordRequestMetric();

async function postEffect() {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: { route: { type: "string" }, payload: { type: "string" } },
  });
  if (
    !values.route ||
    !["enqueue", "router-receipt", "terminal-disposition"].includes(values.route) ||
    !values.payload
  ) {
    throw new Error(
      "post-effect requires --route <enqueue|router-receipt|terminal-disposition> --payload <file>",
    );
  }
  const payload = readFileSync(values.payload, "utf8");
  objectValue(JSON.parse(payload));
  const response = await client.postEffect(
    values.route as ExactReviewBatchPostEffectRoute,
    payload,
  );
  console.log(JSON.stringify(response));
}

function recordRateLimit() {
  const scope = env("EXACT_REVIEW_GITHUB_RATE_LIMIT_SCOPE");
  const targetOwner = process.env.EXACT_REVIEW_GITHUB_RATE_LIMIT_TARGET_OWNER?.trim().toLowerCase();
  if (scope !== "repository_actions" && scope !== "target_app") {
    throw new Error("EXACT_REVIEW_GITHUB_RATE_LIMIT_SCOPE is invalid");
  }
  if (scope === "target_app" && !/^[a-z0-9_.-]{1,100}$/.test(targetOwner || "")) {
    throw new Error("EXACT_REVIEW_GITHUB_RATE_LIMIT_TARGET_OWNER is invalid");
  }
  const now = Date.now();
  const status = spawnSync(
    "gh",
    [
      "api",
      "rate_limit",
      "--jq",
      "{remaining:.resources.core.remaining,reset:.resources.core.reset}",
    ],
    {
      encoding: "utf8",
      env: process.env,
      timeout: 20_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let resetAt = 0;
  if (status.status === 0) {
    try {
      const parsed = JSON.parse(status.stdout || "null") as {
        remaining?: unknown;
        reset?: unknown;
      };
      if (Number(parsed.remaining) <= 0 && Number.isSafeInteger(Number(parsed.reset))) {
        resetAt = Number(parsed.reset) * 1_000;
      }
    } catch {
      // The conservative circuit below still prevents same-pool fanout.
    }
  }
  const observation = {
    scope,
    ...(targetOwner ? { target_owner: targetOwner } : {}),
    observed_at: new Date(now).toISOString(),
    retry_at: new Date(Math.max(now + 60_000, resetAt)).toISOString(),
    provenance: resetAt ? "rate_limit_status" : "fallback",
    authoritative: resetAt > 0,
  };
  mkdirSync(dirname(rateLimitObservationPath()), { recursive: true });
  mkdirSync(dirname(requestMetricsPath()), { recursive: true });
  appendFileSync(rateLimitObservationPath(), `${JSON.stringify(observation)}\n`, "utf8");
  appendRouterDispatchMetric(scope, "throttle");
  appendFileSync(
    requestMetricsPath(),
    `${JSON.stringify({
      scope,
      category: "rate_status",
      mode: "read",
      outcome: status.status === 0 ? "success" : "error",
      repeat_revision: false,
      count: 1,
    })}\n`,
    "utf8",
  );
  console.log(JSON.stringify({ ok: true, observation }));
}

function recordRequestMetric() {
  const scope = env("EXACT_REVIEW_GITHUB_RATE_LIMIT_SCOPE");
  const outcome = env("EXACT_REVIEW_GITHUB_REQUEST_OUTCOME");
  if (scope !== "repository_actions" && scope !== "target_app") {
    throw new Error("EXACT_REVIEW_GITHUB_RATE_LIMIT_SCOPE is invalid");
  }
  if (outcome !== "success" && outcome !== "error") {
    throw new Error("EXACT_REVIEW_GITHUB_REQUEST_OUTCOME is invalid");
  }
  mkdirSync(dirname(requestMetricsPath()), { recursive: true });
  appendRouterDispatchMetric(scope, outcome);
  console.log(JSON.stringify({ ok: true, scope, outcome }));
}

function appendRouterDispatchMetric(
  scope: "repository_actions" | "target_app",
  outcome: "success" | "throttle" | "error",
) {
  appendFileSync(
    requestMetricsPath(),
    `${JSON.stringify({
      scope,
      category: "workflow_dispatch",
      mode: "mutation_or_private_read",
      outcome,
      repeat_revision: requestRepeatRevision(),
      count: 1,
    })}\n`,
    "utf8",
  );
}

function requestRepeatRevision(): boolean {
  return process.env.EXACT_REVIEW_GITHUB_REQUEST_REPEAT?.trim().toLowerCase() === "true";
}

async function claim() {
  const leaseOwner = env("EXACT_REVIEW_BATCH_LEASE_OWNER");
  const batchId = env("EXACT_REVIEW_BATCH_ID");
  const dispatch = optionalDispatchTelemetry();
  const runner = optionalRunnerTelemetry();
  const lease = await client.claim({
    claimId: batchId,
    leaseOwner,
    maxItems: positiveInteger(env("EXACT_REVIEW_BATCH_MAX_ITEMS")),
    ...(dispatch ? { dispatch } : {}),
    ...(runner ? { runner } : {}),
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
    leaseExpiresAt: fetched.batch.leaseExpiresAt,
    configuredBatchSize: lease.configuredBatchSize,
    batchWaitMs: lease.batchWaitMs,
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
  output(
    "records_repo_slugs",
    [...new Set(targets.map((target) => slugForRepo(normalizeRepo(target))))].sort().join(","),
  );
}

async function heartbeat() {
  const manifest = readManifest();
  const lease = await client.heartbeat({
    batchId: manifest.batchId,
    leaseOwner: manifest.leaseOwner,
    leaseExpiresAt: manifest.leaseExpiresAt,
    items: manifest.items,
  });
  saveLeaseExpiry(lease.leaseExpiresAt);
  console.log(JSON.stringify({ ok: true, batch_id: manifest.batchId }));
}

async function observe() {
  const manifest = readManifest();
  const stage = String(process.env.EXACT_REVIEW_BATCH_OBSERVATION || "").trim();
  if (
    !(
      [
        "preparation_started",
        "preparation_finished",
        "final_github_apply",
        "github_throttle",
      ] as string[]
    ).includes(stage)
  ) {
    throw new Error("EXACT_REVIEW_BATCH_OBSERVATION is invalid");
  }
  const observedAt = process.env.EXACT_REVIEW_BATCH_OBSERVED_AT?.trim() || new Date().toISOString();
  if (!Number.isFinite(Date.parse(observedAt))) {
    throw new Error("EXACT_REVIEW_BATCH_OBSERVED_AT is invalid");
  }
  const lease = await client.heartbeat({
    batchId: manifest.batchId,
    leaseOwner: manifest.leaseOwner,
    leaseExpiresAt: manifest.leaseExpiresAt,
    items: manifest.items,
    observation: {
      stage: stage as
        | "preparation_started"
        | "preparation_finished"
        | "final_github_apply"
        | "github_throttle",
      observedAt,
    },
  });
  saveLeaseExpiry(lease.leaseExpiresAt);
  console.log(JSON.stringify({ ok: true, batch_id: manifest.batchId, stage }));
}

function saveLeaseExpiry(leaseExpiresAt: string) {
  const path = env("EXACT_REVIEW_BATCH_MANIFEST");
  const manifest = objectValue(JSON.parse(readFileSync(path, "utf8")));
  if (Date.parse(String(manifest.leaseExpiresAt)) >= Date.parse(leaseExpiresAt)) return;
  manifest.leaseExpiresAt = leaseExpiresAt;
  // Heartbeat and observation processes share the manifest with preparation.
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

async function commit() {
  const manifest = readManifest();
  const fetched = await client.fetch({
    batchId: manifest.batchId,
    leaseOwner: manifest.leaseOwner,
  });
  const active = new Map(fetched.items.map((item) => [item.itemKey, item]));
  const superseded: ExactReviewBatchCompletion[] = [];
  const commitCandidates: Array<{
    member: ExactReviewBatchQueueItem;
    plan: PreparedStateMutationPlan;
  }> = [];
  const publicationOutcomes: BatchPublicationOutcome[] = [];
  for (const manifestItem of manifest.items) {
    const current = active.get(manifestItem.itemKey);
    if (!current || !existsSync(manifestItem.outcomePath)) continue;
    const outcome = objectValue(JSON.parse(readFileSync(manifestItem.outcomePath, "utf8")));
    if (outcome.kind === "superseded") {
      if (optionalObjectValue(outcome.disposition).requeueLatestExpected !== true) {
        superseded.push({ ...current, terminalOutcome: "superseded" });
        publicationOutcomes.push(supersededPublicationOutcome(current));
      }
      continue;
    }
    if (outcome.kind !== "eligible") continue;
    try {
      const [plan] = validatePreparedStateMutationPlans([
        outcome.plan as PreparedStateMutationPlan,
      ]).plans;
      const publication = plan?.publication;
      const canonicalTargetKey = canonicalTargetKeyForMember(current);
      if (
        !plan ||
        !publication ||
        plan.identity.itemKey !== current.itemKey ||
        plan.identity.revision !== current.revision ||
        plan.identity.claimGeneration !== current.claimGeneration ||
        publication.canonicalTargetKey !== canonicalTargetKey ||
        publication.fenceKey !== current.itemKey
      ) {
        throw new Error(`Batch outcome identity does not match ${current.itemKey}`);
      }
      commitCandidates.push({ member: current, plan });
    } catch (error) {
      publicationOutcomes.push(permanentPublicationOutcome(current, failureFingerprint(error)));
    }
  }

  const plans = commitCandidates.map((candidate) => candidate.plan);

  let stateWriter: StateWriterOperation | undefined;
  const progressObserver = exactReviewBatchStateWriterProgressReporter({
    queueUrl: env("EXACT_REVIEW_QUEUE_URL"),
    webhookSecret: env("CLAWSWEEPER_WEBHOOK_SECRET"),
    batchId: manifest.batchId,
    leaseOwner: manifest.leaseOwner,
    items: manifest.items,
  });
  const recorder = plans.length
    ? new StateWriterTelemetryRecorder({
        mode: "batch",
        operationId: `batch:${manifest.batchId}`,
        configuredBatchSize: manifest.configuredBatchSize,
        actualBatchSize: plans.length,
        batchWaitMs: manifest.batchWaitMs,
        ...(progressObserver ? { observer: progressObserver } : {}),
      })
    : null;
  if (plans.length) {
    const published = await publishCanonicalBatch(commitCandidates);
    publicationOutcomes.push(...published);
    const materialized = published.filter(
      (outcome) => outcome.outcome === "accepted" || outcome.outcome === "deduped",
    ).length;
    if (materialized) recorder?.recordMaterializedCommit(materialized);
    recorder?.finalize(materialized ? "materialized" : "failed");
    stateWriter = recorder?.toTerminalObject() ?? undefined;
  }
  const receiptPath = batchReceiptPath();
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(
    receiptPath,
    `${JSON.stringify(
      {
        batchId: manifest.batchId,
        stateCommitSha: null,
        // Retained for pre-envelope receipt readers. New completion logic uses
        // the per-member outcomes below, including both identities.
        publishedItemKeys: publicationOutcomes
          .filter((outcome) => outcome.outcome === "accepted" || outcome.outcome === "deduped")
          .map((outcome) => outcome.fenceKey),
        outcomes: publicationOutcomes,
        stateWriter: stateWriter ?? null,
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
      state_commit_sha: null,
      materialized: publicationOutcomes.filter(
        (outcome) => outcome.outcome === "accepted" || outcome.outcome === "deduped",
      ).length,
      quarantined: 0,
      superseded: superseded.length,
    }),
  );
}

async function publishCanonicalBatch(
  candidates: ReadonlyArray<{ member: ExactReviewBatchQueueItem; plan: PreparedStateMutationPlan }>,
): Promise<BatchPublicationOutcome[]> {
  const outcomes: BatchPublicationOutcome[] = [];
  for (const { member, plan } of candidates) {
    const publication = plan.publication!;
    const operations = plan.operations.map((operation) => ({ ...operation }));
    try {
      const result = await postDirectPublicationResult({
        baseUrl: env("EXACT_REVIEW_QUEUE_URL"),
        webhookSecret: env("CLAWSWEEPER_WEBHOOK_SECRET"),
        path: "/internal/exact-review/publication-batch-results",
        payload: {
          canonicalTargetKey: publication.canonicalTargetKey,
          fenceKey: publication.fenceKey,
          revision: plan.identity.revision,
          identity: { ...publication, ...plan.identity },
          operations,
          totalBytes: plan.totalBytes,
        },
      });
      outcomes.push(publicationOutcomeFromResult(member, publication, result));
    } catch (error) {
      outcomes.push(retryablePublicationOutcome(member, publication, failureFingerprint(error)));
    }
  }
  return outcomes;
}

async function complete() {
  const manifest = readManifest();
  const receipt = readBatchReceipt(manifest, true)!;
  const fetched = await client.fetch({
    batchId: manifest.batchId,
    leaseOwner: manifest.leaseOwner,
  });
  const active = new Map(fetched.items.map((item) => [item.itemKey, item]));
  const completions: ExactReviewBatchCompletion[] = [];
  for (const manifestItem of manifest.items) {
    const current = active.get(manifestItem.itemKey);
    if (!current) continue;
    if (!existsSync(manifestItem.outcomePath)) {
      const circuit = latestRateLimitObservation();
      completions.push(
        circuit
          ? retryableCompletion(
              current,
              "github_rate_limit",
              undefined,
              circuit.retryAt,
              false,
              circuit.scope,
            )
          : retryableCompletion(current, "unknown_failure"),
      );
      continue;
    }
    const outcome = objectValue(JSON.parse(readFileSync(manifestItem.outcomePath, "utf8")));
    if (outcome.kind === "superseded") {
      if (hasPendingPostEffects(outcome)) {
        continue;
      }
      completions.push({ ...current, terminalOutcome: "superseded" });
      continue;
    }
    const failure = failureCompletion(current, outcome);
    if (failure) {
      completions.push(failure);
      continue;
    }
    const publicationOutcome = receipt.outcomes.get(current.itemKey);
    if (publicationOutcome) {
      completions.push(publicationCompletion(current, publicationOutcome, outcome));
      continue;
    }
    if (outcome.kind !== "eligible" || !receipt.publishedItemKeys.has(current.itemKey)) {
      completions.push(retryableCompletion(current, "unknown_failure"));
      continue;
    }
    if (hasPendingPostEffects(outcome)) continue;
    completions.push({ ...current, terminalOutcome: "published" });
  }
  const result = await acknowledge(
    manifest,
    completions,
    receipt.stateCommitSha,
    undefined,
    receipt.stateWriter,
    true,
  );
  const retryable = completions.filter(
    (completion) =>
      completion.terminalOutcome !== "published" && completion.terminalOutcome !== "superseded",
  ).length;
  console.log(
    JSON.stringify({
      ok: true,
      batch_id: manifest.batchId,
      accepted: result?.accepted ?? 0,
      retryable,
    }),
  );
}

async function release() {
  const manifest = readManifest();
  const receipt = readBatchReceipt(manifest, false);
  // Cleanup must remain available when the queue fetch path is degraded. The
  // claimed manifest already contains the exact revision and generation fences
  // accepted by the complete route, so a fresh read adds availability risk but
  // cannot strengthen ownership.
  const completions: ExactReviewBatchCompletion[] = manifest.items.map((member) => {
    if (existsSync(member.outcomePath)) {
      const outcome = objectValue(JSON.parse(readFileSync(member.outcomePath, "utf8")));
      if (outcome.kind === "superseded" && !hasPendingPostEffects(outcome)) {
        return { ...member, terminalOutcome: "superseded" };
      }
      const failure = failureCompletion(member, outcome);
      if (failure) return failure;
      const publicationOutcome = receipt?.outcomes.get(member.itemKey);
      if (publicationOutcome) return publicationCompletion(member, publicationOutcome, outcome);
      // A receipt proves the state mutation committed. A member is safe to
      // acknowledge as published only after every required post-commit effect
      // is also durable; otherwise requeueing preserves that unfinished work.
      if (
        outcome.kind === "eligible" &&
        receipt?.publishedItemKeys.has(member.itemKey) &&
        !hasPendingPostEffects(outcome)
      ) {
        return { ...member, terminalOutcome: "published" };
      }
    }
    const circuit = latestRateLimitObservation();
    return circuit
      ? retryableCompletion(
          member,
          "github_rate_limit",
          undefined,
          circuit.retryAt,
          false,
          circuit.scope,
        )
      : retryableCompletion(member, "workflow_cancelled");
  });
  const result = await acknowledge(
    manifest,
    completions,
    receipt?.stateCommitSha,
    undefined,
    receipt?.stateWriter,
    true,
  );
  console.log(
    JSON.stringify({
      ok: true,
      batch_id: manifest.batchId,
      released: result?.accepted ?? 0,
    }),
  );
}

async function acknowledge(
  manifest: BatchManifest,
  completions: ExactReviewBatchCompletion[],
  stateCommitSha?: string,
  failure?: string,
  stateWriter?: StateWriterOperation,
  includeTelemetry = false,
) {
  const acknowledged = readTelemetryAcknowledgement();
  const rateLimitEnd = telemetryFileSize(rateLimitObservationPath());
  const requestMetricsEnd = telemetryFileSize(requestMetricsPath());
  const rateLimitObservations = includeTelemetry
    ? readRateLimitObservations(acknowledged.rateLimitBytes, rateLimitEnd)
    : [];
  const requestMetrics = includeTelemetry
    ? readRequestMetrics(acknowledged.requestMetricBytes, requestMetricsEnd)
    : [];
  const telemetrySubmitted = rateLimitObservations.length > 0 || requestMetrics.length > 0;
  const telemetryId = telemetrySubmitted
    ? telemetrySubmissionId(acknowledged, rateLimitEnd, requestMetricsEnd)
    : undefined;
  if (
    !completions.length &&
    !stateWriter &&
    !rateLimitObservations.length &&
    !requestMetrics.length
  )
    return null;
  const result = await client.complete({
    batchId: manifest.batchId,
    leaseOwner: manifest.leaseOwner,
    items: completions,
    ...(stateCommitSha ? { stateCommitSha } : {}),
    ...(failure ? { failureFingerprint: failure } : {}),
    ...(stateWriter ? { stateWriter } : {}),
    ...(rateLimitObservations.length ? { rateLimitObservations } : {}),
    ...(requestMetrics.length ? { requestMetrics } : {}),
    ...(telemetryId ? { telemetryId } : {}),
  });
  if (includeTelemetry && (!telemetrySubmitted || result.telemetryAccepted)) {
    mkdirSync(dirname(telemetryAcknowledgedPath()), { recursive: true });
    writeFileSync(
      telemetryAcknowledgedPath(),
      `${JSON.stringify({ rateLimitBytes: rateLimitEnd, requestMetricBytes: requestMetricsEnd })}\n`,
      "utf8",
    );
  }
  return result;
}

function telemetrySubmissionId(
  acknowledged: { rateLimitBytes: number; requestMetricBytes: number },
  rateLimitEnd: number,
  requestMetricEnd: number,
): string {
  const producer = [
    process.env.GITHUB_RUN_ID || "local",
    process.env.GITHUB_RUN_ATTEMPT || "0",
    dirname(env("EXACT_REVIEW_BATCH_MANIFEST")),
  ].join(":");
  return createHash("sha256")
    .update(
      JSON.stringify({
        producer,
        rateLimitStart: acknowledged.rateLimitBytes,
        rateLimitEnd,
        requestMetricStart: acknowledged.requestMetricBytes,
        requestMetricEnd,
      }),
    )
    .digest("hex");
}

function failureCompletion(
  member: ExactReviewBatchQueueItem,
  outcome: Record<string, unknown>,
): ExactReviewBatchCompletion | null {
  const terminalOutcome = String(outcome.kind || "");
  if (
    terminalOutcome !== "retryable_failure" &&
    terminalOutcome !== "refresh_required" &&
    terminalOutcome !== "permanent_failure"
  ) {
    return null;
  }
  if (hasPendingPostEffects(outcome)) return retryableCompletion(member, "unknown_failure");
  const reasonCode = stringValue(outcome.reasonCode, "outcome.reasonCode");
  const errorFingerprint =
    typeof outcome.errorFingerprint === "string" && outcome.errorFingerprint
      ? outcome.errorFingerprint
      : undefined;
  const retryAt =
    typeof outcome.retryAt === "string" && Number.isFinite(Date.parse(outcome.retryAt))
      ? new Date(Date.parse(outcome.retryAt)).toISOString()
      : undefined;
  const attempted = outcome.attempted === false ? false : undefined;
  const poolClass =
    outcome.rateLimitScope === "repository_actions" || outcome.rateLimitScope === "target_app"
      ? outcome.rateLimitScope
      : undefined;
  return {
    ...member,
    terminalOutcome,
    reasonCode,
    ...(errorFingerprint ? { errorFingerprint } : {}),
    ...(retryAt ? { retryAt } : {}),
    ...(attempted !== undefined ? { attempted } : {}),
    ...(poolClass ? { poolClass } : {}),
  };
}

function retryableCompletion(
  member: ExactReviewBatchQueueItem,
  reasonCode: string,
  errorFingerprint?: string,
  retryAt?: string,
  attempted?: boolean,
  poolClass?: ExactReviewBatchCompletion["poolClass"],
): ExactReviewBatchCompletion {
  return {
    ...member,
    terminalOutcome: "retryable_failure",
    reasonCode,
    ...(errorFingerprint ? { errorFingerprint } : {}),
    ...(retryAt ? { retryAt } : {}),
    ...(attempted !== undefined ? { attempted } : {}),
    ...(poolClass ? { poolClass } : {}),
  };
}

function telemetryAcknowledgedPath(): string {
  return join(dirname(env("EXACT_REVIEW_BATCH_MANIFEST")), "github-telemetry-acknowledged");
}

function readTelemetryAcknowledgement(): {
  rateLimitBytes: number;
  requestMetricBytes: number;
} {
  const path = telemetryAcknowledgedPath();
  if (!existsSync(path)) return { rateLimitBytes: 0, requestMetricBytes: 0 };
  try {
    const value = objectValue(JSON.parse(readFileSync(path, "utf8")));
    const rateLimitBytes = Number(value.rateLimitBytes);
    const requestMetricBytes = Number(value.requestMetricBytes);
    if (
      Number.isSafeInteger(rateLimitBytes) &&
      rateLimitBytes >= 0 &&
      Number.isSafeInteger(requestMetricBytes) &&
      requestMetricBytes >= 0
    ) {
      return { rateLimitBytes, requestMetricBytes };
    }
  } catch {
    // A malformed acknowledgement is safe to replay; the queue aggregates telemetry.
  }
  return { rateLimitBytes: 0, requestMetricBytes: 0 };
}

function telemetryFileSize(path: string): number {
  return existsSync(path) ? readFileSync(path).byteLength : 0;
}

function readTelemetrySlice(path: string, start: number, end: number): string {
  if (!existsSync(path) || end <= start) return "";
  const contents = readFileSync(path);
  return contents
    .subarray(Math.min(start, contents.byteLength), Math.min(end, contents.byteLength))
    .toString("utf8");
}

function rateLimitObservationPath(): string {
  return (
    process.env.CLAWSWEEPER_GITHUB_RATE_LIMIT_OBSERVATION_PATH ||
    join(dirname(env("EXACT_REVIEW_BATCH_MANIFEST")), "github-rate-limits.jsonl")
  );
}

function requestMetricsPath(): string {
  return (
    process.env.CLAWSWEEPER_GITHUB_REQUEST_METRICS_PATH ||
    join(dirname(env("EXACT_REVIEW_BATCH_MANIFEST")), "github-request-metrics.jsonl")
  );
}

function readRateLimitObservations(
  start = 0,
  end = telemetryFileSize(rateLimitObservationPath()),
): ExactReviewGithubRateLimitObservation[] {
  const path = rateLimitObservationPath();
  if (!existsSync(path)) return [];
  const byPool = new Map<string, ExactReviewGithubRateLimitObservation>();
  for (const line of readTelemetrySlice(path, start, end).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = objectValue(JSON.parse(line));
      const scope = String(value.scope || "");
      const targetOwner = String(value.target_owner || "")
        .trim()
        .toLowerCase();
      const observedAt = new Date(String(value.observed_at || "")).toISOString();
      const retryAt = new Date(String(value.retry_at || "")).toISOString();
      const provenance = String(value.provenance || "");
      if (
        (scope !== "repository_actions" && scope !== "target_app") ||
        (scope === "target_app" && !/^[a-z0-9_.-]{1,100}$/.test(targetOwner)) ||
        !["retry_after", "rate_limit_reset", "rate_limit_status", "fallback"].includes(provenance)
      ) {
        continue;
      }
      const observation: ExactReviewGithubRateLimitObservation = {
        scope,
        ...(targetOwner ? { targetOwner } : {}),
        observedAt,
        retryAt,
        provenance: provenance as ExactReviewGithubRateLimitObservation["provenance"],
        authoritative: value.authoritative === true,
      };
      const key = `${scope}:${targetOwner}`;
      const prior = byPool.get(key);
      if (!prior || Date.parse(prior.retryAt) < Date.parse(retryAt)) byPool.set(key, observation);
    } catch {
      // A partial JSONL tail cannot influence a durable circuit.
    }
  }
  return [...byPool.values()];
}

function latestRateLimitObservation(): ExactReviewGithubRateLimitObservation | null {
  return (
    readRateLimitObservations()
      .filter((observation) => Date.parse(observation.retryAt) > Date.now())
      .sort((left, right) => Date.parse(right.retryAt) - Date.parse(left.retryAt))[0] ?? null
  );
}

function readRequestMetrics(
  start = 0,
  end = telemetryFileSize(requestMetricsPath()),
): ExactReviewGithubRequestMetric[] {
  const path = requestMetricsPath();
  if (!existsSync(path)) return [];
  const counts = new Map<string, ExactReviewGithubRequestMetric>();
  for (const line of readTelemetrySlice(path, start, end).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = objectValue(JSON.parse(line));
      const scope = String(value.scope || "");
      const category = String(value.category || "");
      const mode = String(value.mode || "");
      const outcome = String(value.outcome || "");
      const repeatRevision = value.repeat_revision === true;
      const count = Number(value.count);
      if (
        !["repository_actions", "target_app"].includes(scope) ||
        ![
          "artifact_download",
          "rate_status",
          "comments",
          "labels",
          "reviews",
          "workflow_dispatch",
          "item_metadata",
          "other",
        ].includes(category) ||
        !["read", "mutation_or_private_read"].includes(mode) ||
        !["success", "throttle", "transient", "error", "skipped_by_circuit"].includes(outcome) ||
        !Number.isInteger(count) ||
        count < 1 ||
        count > 10_000
      ) {
        continue;
      }
      const key = [scope, category, mode, outcome, String(repeatRevision)].join(":");
      const prior = counts.get(key);
      counts.set(key, {
        scope: scope as ExactReviewGithubRequestMetric["scope"],
        category: category as ExactReviewGithubRequestMetric["category"],
        mode: mode as ExactReviewGithubRequestMetric["mode"],
        outcome: outcome as ExactReviewGithubRequestMetric["outcome"],
        repeatRevision,
        count: (prior?.count || 0) + count,
      });
    } catch {
      // Invalid metrics are dropped instead of widening the status contract.
    }
  }
  return [...counts.values()];
}

function publicationOutcomeFromResult(
  member: ExactReviewBatchQueueItem,
  publication: NonNullable<PreparedStateMutationPlan["publication"]>,
  result: Awaited<ReturnType<typeof postDirectPublicationResult>>,
): BatchPublicationOutcome {
  const identity = publicationOutcomeIdentity(member, publication);
  if (result.kind === "accepted") {
    if (result.response.superseded === true) return { ...identity, outcome: "superseded" };
    if (result.response.deduped === true) return { ...identity, outcome: "deduped" };
    return { ...identity, outcome: "accepted" };
  }
  const fingerprint = failureFingerprint(new Error(result.reason));
  if (result.reason === "direct_publication_fence_not_owned") {
    return {
      ...identity,
      outcome: "retryable",
      reasonCode: "unknown_failure",
      errorFingerprint: fingerprint,
    };
  }
  if (result.status === 400 || result.status === 413) {
    return {
      ...identity,
      outcome: "permanent",
      reasonCode: "tuple_protocol_invalid",
      errorFingerprint: fingerprint,
    };
  }
  if (result.status === undefined || result.status === 429 || result.status >= 500) {
    return {
      ...identity,
      outcome: "retryable",
      reasonCode: "state_contention",
      errorFingerprint: fingerprint,
    };
  }
  return {
    ...identity,
    outcome: "retryable",
    reasonCode: "unknown_failure",
    errorFingerprint: fingerprint,
  };
}

function supersededPublicationOutcome(member: ExactReviewBatchQueueItem): BatchPublicationOutcome {
  return { ...publicationOutcomeIdentity(member), outcome: "superseded" };
}

function permanentPublicationOutcome(
  member: ExactReviewBatchQueueItem,
  errorFingerprint: string,
): BatchPublicationOutcome {
  return {
    ...publicationOutcomeIdentity(member),
    outcome: "permanent",
    reasonCode: "tuple_protocol_invalid",
    errorFingerprint,
  };
}

function retryablePublicationOutcome(
  member: ExactReviewBatchQueueItem,
  publication: NonNullable<PreparedStateMutationPlan["publication"]>,
  errorFingerprint: string,
): BatchPublicationOutcome {
  return {
    ...publicationOutcomeIdentity(member, publication),
    outcome: "retryable",
    reasonCode: "unknown_failure",
    errorFingerprint,
  };
}

function publicationOutcomeIdentity(
  member: ExactReviewBatchQueueItem,
  publication?: NonNullable<PreparedStateMutationPlan["publication"]>,
): Pick<
  BatchPublicationOutcome,
  "canonicalTargetKey" | "fenceKey" | "revision" | "claimGeneration"
> {
  const canonicalTargetKey = canonicalTargetKeyForMember(member);
  if (
    publication &&
    (publication.canonicalTargetKey !== canonicalTargetKey ||
      publication.fenceKey !== member.itemKey)
  ) {
    throw new Error(`Batch publication identity does not match ${member.itemKey}`);
  }
  return {
    canonicalTargetKey,
    fenceKey: member.itemKey,
    revision: member.revision,
    claimGeneration: member.claimGeneration,
  };
}

function canonicalTargetKeyForMember(member: ExactReviewBatchQueueItem): string {
  const decision = objectValue(member.decision);
  const targetRepo = targetRepoFromDecision(decision);
  const itemNumber = positiveInteger(decision.itemNumber);
  return `${targetRepo}#${itemNumber}`;
}

function publicationOutcomeMatchesMember(
  publication: BatchPublicationOutcome,
  member: ExactReviewBatchQueueItem,
): boolean {
  return (
    publication.fenceKey === member.itemKey &&
    publication.revision === member.revision &&
    publication.claimGeneration === member.claimGeneration &&
    publication.canonicalTargetKey === canonicalTargetKeyForMember(member)
  );
}

function publicationOutcomeMatchesManifest(
  publication: BatchPublicationOutcome,
  manifest: BatchManifest,
): boolean {
  const member = manifest.items.find((item) => item.itemKey === publication.fenceKey);
  return !!member && publicationOutcomeMatchesMember(publication, member);
}

function batchPublicationOutcome(value: unknown): BatchPublicationOutcome {
  const outcome = objectValue(value);
  const canonicalTargetKey = exactIdentityValue(outcome.canonicalTargetKey, "canonicalTargetKey");
  if (!/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9]\d*)$/.test(canonicalTargetKey)) {
    throw new Error("Invalid batch receipt canonical target key");
  }
  const fenceKey = exactIdentityValue(outcome.fenceKey, "fenceKey");
  const terminal = String(outcome.outcome || "");
  if (
    !(["accepted", "deduped", "superseded", "retryable", "permanent"] as string[]).includes(
      terminal,
    )
  ) {
    throw new Error("Invalid batch receipt publication outcome");
  }
  const reasonCode =
    outcome.reasonCode === undefined
      ? undefined
      : exactIdentityValue(outcome.reasonCode, "reasonCode");
  if (
    reasonCode &&
    reasonCode !== "state_contention" &&
    reasonCode !== "tuple_protocol_invalid" &&
    reasonCode !== "unknown_failure"
  ) {
    throw new Error("Invalid batch receipt publication reason code");
  }
  const errorFingerprint =
    outcome.errorFingerprint === undefined
      ? undefined
      : exactIdentityValue(outcome.errorFingerprint, "errorFingerprint");
  if (errorFingerprint && !/^[a-f0-9]{64}$/.test(errorFingerprint)) {
    throw new Error("Invalid batch receipt publication error fingerprint");
  }
  const parsed: BatchPublicationOutcome = {
    canonicalTargetKey,
    fenceKey,
    revision: positiveInteger(outcome.revision),
    claimGeneration: positiveInteger(outcome.claimGeneration),
    outcome: terminal as BatchPublicationOutcome["outcome"],
  };
  if (reasonCode) {
    parsed.reasonCode = reasonCode as NonNullable<BatchPublicationOutcome["reasonCode"]>;
  }
  if (errorFingerprint) parsed.errorFingerprint = errorFingerprint;
  return parsed;
}

function publicationCompletion(
  member: ExactReviewBatchQueueItem,
  publication: BatchPublicationOutcome,
  outcome: Record<string, unknown>,
): ExactReviewBatchCompletion {
  if (!publicationOutcomeMatchesMember(publication, member)) {
    return retryableCompletion(member, "unknown_failure", publication.errorFingerprint);
  }
  if (publication.outcome === "permanent") {
    return {
      ...member,
      terminalOutcome: "permanent_failure",
      reasonCode: "tuple_protocol_invalid",
      ...(publication.errorFingerprint ? { errorFingerprint: publication.errorFingerprint } : {}),
    };
  }
  if (hasPendingPostEffects(outcome)) {
    return retryableCompletion(member, "unknown_failure", publication.errorFingerprint);
  }
  if (publication.outcome === "superseded") {
    return { ...member, terminalOutcome: "superseded" };
  }
  if (publication.outcome === "retryable") {
    return retryableCompletion(
      member,
      publication.reasonCode ?? "unknown_failure",
      publication.errorFingerprint,
    );
  }
  if (outcome.kind !== "eligible" || hasPendingPostEffects(outcome)) {
    return retryableCompletion(member, "unknown_failure", publication.errorFingerprint);
  }
  return { ...member, terminalOutcome: "published" };
}

function hasPendingPostEffects(outcome: Record<string, unknown>): boolean {
  const disposition = optionalObjectValue(outcome.disposition);
  const requiresPostEffects =
    // Every accepted eligible member needs a router or terminal lifecycle
    // receipt before its canonical commit can be considered fully delivered.
    // Infer that requirement from the durable outcome so an interruption
    // between commit and the workflow marker cannot release it as published.
    outcome.kind === "eligible" ||
    disposition.requeueLatestExpected === true ||
    disposition.deferredCloseCoverageExpected === true ||
    disposition.routableSyncExpected === true;
  return (
    (requiresPostEffects || outcome.postEffectsRequired === true) &&
    outcome.postEffectsComplete !== true
  );
}

function readManifest(): BatchManifest {
  const value = objectValue(JSON.parse(readFileSync(env("EXACT_REVIEW_BATCH_MANIFEST"), "utf8")));
  if (!Array.isArray(value.items)) throw new Error("Batch manifest items must be an array");
  return {
    batchId: stringValue(value.batchId, "batchId"),
    leaseOwner: stringValue(value.leaseOwner, "leaseOwner"),
    leaseExpiresAt: stringValue(value.leaseExpiresAt, "leaseExpiresAt"),
    configuredBatchSize: positiveInteger(value.configuredBatchSize),
    batchWaitMs: nonNegativeInteger(value.batchWaitMs),
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

function readBatchReceipt(manifest: BatchManifest, required: boolean): BatchReceipt | null {
  const path = batchReceiptPath();
  if (!existsSync(path)) {
    if (required) throw new Error("Batch receipt is missing");
    return null;
  }
  const receipt = objectValue(JSON.parse(readFileSync(path, "utf8")));
  const batchId = stringValue(receipt.batchId, "receipt.batchId");
  if (batchId !== manifest.batchId) throw new Error("Batch receipt identity mismatch");
  const publishedItemKeys = new Set(
    Array.isArray(receipt.publishedItemKeys)
      ? receipt.publishedItemKeys.map((value) => stringValue(value, "publishedItemKey"))
      : [],
  );
  const outcomes = new Map<string, BatchPublicationOutcome>();
  if (Array.isArray(receipt.outcomes)) {
    for (const value of receipt.outcomes) {
      const parsed = batchPublicationOutcome(value);
      if (!publicationOutcomeMatchesManifest(parsed, manifest)) {
        throw new Error("Batch receipt outcome identity mismatch");
      }
      if (outcomes.has(parsed.fenceKey)) throw new Error("Batch receipt repeats a fence key");
      outcomes.set(parsed.fenceKey, parsed);
    }
  }
  const stateCommitSha =
    typeof receipt.stateCommitSha === "string" && receipt.stateCommitSha
      ? receipt.stateCommitSha
      : undefined;
  const stateWriter =
    receipt.stateWriter && typeof receipt.stateWriter === "object"
      ? (receipt.stateWriter as StateWriterOperation)
      : undefined;
  return {
    batchId,
    publishedItemKeys,
    outcomes,
    ...(stateCommitSha ? { stateCommitSha } : {}),
    ...(stateWriter ? { stateWriter } : {}),
  };
}

function output(name: string, value: string) {
  const path = process.env.GITHUB_OUTPUT;
  if (path) writeFileSync(path, `${name}=${value}\n`, { encoding: "utf8", flag: "a" });
  else console.log(`${name}=${value}`);
}

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalDispatchTelemetry() {
  const id = process.env.EXACT_REVIEW_BATCH_DISPATCH_ID?.trim();
  const at = process.env.EXACT_REVIEW_BATCH_DISPATCHED_AT?.trim();
  if (!id && !at) return undefined;
  if (!id || !at || !Number.isFinite(Date.parse(at))) {
    throw new Error("Exact-review batch dispatch telemetry is incomplete");
  }
  return { id, at };
}

function optionalRunnerTelemetry() {
  const runId = process.env.GITHUB_RUN_ID?.trim();
  const runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  const startedAt = process.env.EXACT_REVIEW_BATCH_RUNNER_STARTED_AT?.trim();
  // A job that began before the workflow gained this environment value checks
  // out current main for the CLI. Keep that in-flight job claim-compatible and
  // leave only its optional runner telemetry absent.
  if (!startedAt) return undefined;
  if (
    !runId ||
    !Number.isSafeInteger(runAttempt) ||
    runAttempt < 1 ||
    !Number.isFinite(Date.parse(startedAt))
  ) {
    throw new Error("Exact-review batch runner telemetry is incomplete");
  }
  return { runId, runAttempt, startedAt };
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

function exactIdentityValue(value: unknown, name: string): string {
  const text = stringValue(value, name);
  if (text !== text.trim() || text.includes("\0") || /[\r\n]/.test(text)) {
    throw new Error(`Invalid exact ${name}`);
  }
  return text;
}

function positiveInteger(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("Expected a positive integer");
  return number;
}

function nonNegativeInteger(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0)
    throw new Error("Expected a non-negative integer");
  return number;
}

function targetRepoFromDecision(value: unknown): string {
  const repo = stringValue(objectValue(value).targetRepo, "decision.targetRepo");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error("Invalid decision.targetRepo");
  }
  return repo;
}
