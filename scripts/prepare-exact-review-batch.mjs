#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  cpSync,
  closeSync,
  existsSync,
  appendFileSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  appendLegacyAvoidedGithubEgressMember,
  recordGithubEgressMember,
} from "../dist/github-egress-observer.js";
import { eventRecordPaths } from "../dist/repair/event-record-store.js";
import { assertRepo } from "../dist/repair/comment-router-utils.js";
import { requirePositiveInteger } from "../dist/value-coerce.js";
import {
  exactReviewArtifactReceiptTuple,
  publishExactReviewArtifact,
  restoreExactReviewArtifact,
} from "./exact-review-artifact-cache.mjs";

const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 4;
const MAX_ITEMS = 32;
const DEFAULT_ITEM_TIMEOUT_MS = 8 * 60_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_ARTIFACT_BYTES = 64 * 1024 * 1024;

export async function runBoundedPool(items, concurrency, worker) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new Error(`prepare concurrency must be between 1 and ${MAX_CONCURRENCY}`);
  }
  let cursor = 0;
  let active = 0;
  let peak = 0;
  const results = Array.from({ length: items.length });
  async function consume() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      active += 1;
      peak = Math.max(peak, active);
      try {
        results[index] = await worker(items[index], index);
      } finally {
        active -= 1;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, consume));
  return { results, peak };
}

async function controller() {
  const startedAt = Date.now();
  const workspace = resolve(process.env.GITHUB_WORKSPACE || process.cwd());
  const manifestPath = resolve(env("EXACT_REVIEW_BATCH_MANIFEST"));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const items = Array.isArray(manifest.items) ? manifest.items : [];
  if (items.length > MAX_ITEMS) throw new Error(`batch exceeds ${MAX_ITEMS} items`);
  const concurrency = boundedInteger(
    process.env.EXACT_REVIEW_BATCH_PREPARE_CONCURRENCY,
    DEFAULT_CONCURRENCY,
    MAX_CONCURRENCY,
  );
  const itemTimeoutMs = positiveInteger(
    process.env.EXACT_REVIEW_BATCH_ITEM_TIMEOUT_MS,
    DEFAULT_ITEM_TIMEOUT_MS,
  );
  const totalTimeoutMs = positiveInteger(
    process.env.EXACT_REVIEW_BATCH_PREPARE_TIMEOUT_MS,
    DEFAULT_TOTAL_TIMEOUT_MS,
  );
  const deadline = startedAt + totalTimeoutMs;
  const workersRoot = resolve(workspace, ".artifacts/exact-review-batch/workers");
  const heartbeatFailurePath = resolve(
    workspace,
    process.env.EXACT_REVIEW_BATCH_HEARTBEAT_FAILURE_PATH ||
      ".artifacts/exact-review-batch/heartbeat-failed",
  );
  const rateLimitObservationPath = resolve(
    workspace,
    process.env.CLAWSWEEPER_GITHUB_RATE_LIMIT_OBSERVATION_PATH ||
      ".artifacts/exact-review-batch/github-rate-limits.jsonl",
  );
  const requestMetricsPath = resolve(
    workspace,
    process.env.CLAWSWEEPER_GITHUB_REQUEST_METRICS_PATH ||
      ".artifacts/exact-review-batch/github-request-metrics.jsonl",
  );
  rmSync(workersRoot, { recursive: true, force: true });
  mkdirSync(workersRoot, { recursive: true });
  mkdirSync(dirname(rateLimitObservationPath), { recursive: true });
  rmSync(rateLimitObservationPath, { force: true });
  rmSync(`${rateLimitObservationPath}.lookup-repository_actions.lock`, { force: true });
  rmSync(`${rateLimitObservationPath}.lookup-target_app.lock`, { force: true });
  rmSync(`${rateLimitObservationPath}.fallback-target_app.lock`, { force: true });
  rmSync(requestMetricsPath, { force: true });
  let cleanupFailures = 0;
  const durations = [];
  let timeouts = 0;
  let admitted = 0;
  let collapsed = 0;
  let cacheHits = 0;
  let cacheFallbacks = 0;
  let githubArtifactRequests = 0;
  const { peak } = await runBoundedPool(items, concurrency, async (item, index) => {
    const outcomePath = checkedOutcomePath(workspace, item.outcomePath);
    if (existsSync(heartbeatFailurePath) || Date.now() >= deadline) {
      recordGithubEgressMember({
        env: { ...process.env, TARGET_REPO: String(item.decision?.targetRepo || "") },
        poolClass: "repository_actions",
        stage: "publication_prepare",
        sourceAction: item.decision?.publication?.producerDecision?.sourceAction,
        claimGeneration: item.claimGeneration,
        repeatRevision: item.repeatRevision === true,
        attempted: false,
        outcome: "pre_wire_failure",
      });
      writeFailure(outcomePath, "retryable_failure", "unknown_failure");
      return { kind: "not_admitted", durationMs: 0 };
    }
    const identity = createHash("sha256")
      .update(`${item.itemKey}:${item.revision}:${item.claimGeneration}`)
      .digest("hex")
      .slice(0, 16);
    const root = join(workersRoot, `${String(index).padStart(2, "0")}-${identity}`);
    const itemPath = join(root, "item.json");
    mkdirSync(root, { recursive: true });
    writeFileSync(itemPath, `${JSON.stringify(item)}\n`, "utf8");
    const workerStartedAt = Date.now();
    let timedOut = false;
    let failureStage = "canonical record copy";
    try {
      const targetRepo = String(item.decision?.targetRepo || "");
      assertRepo(targetRepo, "targetRepo");
      const itemNumber = String(requirePositiveInteger(item.decision?.itemNumber, "itemNumber"));
      if (targetRepo.split("/").some((part) => part === "." || part === "..")) {
        throw new Error("invalid canonical record identity");
      }
      const paths = eventRecordPaths({
        targetRepo,
        itemNumber,
        snapshotDir: join(root, ".artifacts/event-record-snapshot"),
      });
      const recordsSource = join(workspace, "records");
      if (!existsSync(recordsSource)) throw new Error("canonical records are not hydrated");
      if (!statSync(recordsSource).isDirectory()) {
        // Preserve the publisher's non-retryable failure for an invalid records root.
        writeFailure(outcomePath, "permanent_failure", "unknown_failure");
        throw new Error("canonical records are not a directory");
      }
      // Exact-event apply is selected-only, including paired-record lookups.
      for (const path of [
        paths.itemRecord,
        paths.closedRecord,
        paths.planRecord,
        paths.decisionPacket,
      ]) {
        const source = join(workspace, path);
        if (!existsSync(source)) continue;
        const destination = join(root, path);
        mkdirSync(dirname(destination), { recursive: true });
        cpSync(source, destination);
      }
      failureStage = "worker execution";
      const status = await run(
        process.execPath,
        [process.argv[1], "worker", itemPath, root, workspace],
        {
          timeoutMs: Math.min(itemTimeoutMs, remainingTimeout(deadline)),
          env: {
            ...process.env,
            EXACT_REVIEW_BATCH_ID: manifest.batchId,
            EXACT_REVIEW_BATCH_LEASE_OWNER: manifest.leaseOwner,
          },
        },
      );
      const acquisition = readWorkerAcquisition(root);
      if (acquisition.cacheHit) cacheHits += 1;
      if (acquisition.cacheFallback) cacheFallbacks += 1;
      githubArtifactRequests += acquisition.githubArtifactRequests;
      if (acquisition.circuitDeferred) collapsed += 1;
      else admitted += 1;
      timedOut = status.timedOut;
      if (timedOut) timeouts += 1;
      if ((status.code !== 0 || timedOut) && !existsSync(outcomePath)) {
        writeFailure(outcomePath, "retryable_failure", "unknown_failure");
      }
    } catch {
      if (!existsSync(outcomePath)) {
        writeFailure(outcomePath, "retryable_failure", "unknown_failure");
      }
      console.error(`Failed to prepare batch member ${item.itemKey} during ${failureStage}`);
    } finally {
      durations.push(Date.now() - workerStartedAt);
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        cleanupFailures += 1;
      }
    }
    return { kind: timedOut ? "timeout" : "complete", durationMs: Date.now() - workerStartedAt };
  });

  const sortedDurations = [...durations].sort((a, b) => a - b);
  const telemetry = {
    configuredConcurrency: concurrency,
    observedPeakWorkers: peak,
    prepareDurationMs: Date.now() - startedAt,
    workerMaximumMs: sortedDurations.at(-1) || 0,
    workerP95Ms: percentile(sortedDurations, 0.95),
    admitted,
    collapsed,
    cacheHits,
    cacheFallbacks,
    githubArtifactRequests,
    completedOutcomes: items.filter((item) =>
      existsSync(checkedOutcomePath(workspace, item.outcomePath)),
    ).length,
    timeouts,
    heartbeatFailed: existsSync(heartbeatFailurePath),
    cleanupFailures,
    limits: {
      maxItems: MAX_ITEMS,
      itemTimeoutMs,
      totalTimeoutMs,
      maxArtifactBytes: positiveInteger(
        process.env.EXACT_REVIEW_BATCH_MAX_ARTIFACT_BYTES,
        DEFAULT_ARTIFACT_BYTES,
      ),
    },
  };
  writeFileSync(
    resolve(workspace, ".artifacts/exact-review-batch/prepare-telemetry.json"),
    `${JSON.stringify(telemetry, null, 2)}\n`,
    "utf8",
  );
  if (telemetry.heartbeatFailed || cleanupFailures > 0) process.exitCode = 1;
}

async function worker(itemPath, root, workspace) {
  const item = JSON.parse(readFileSync(itemPath, "utf8"));
  const decision = item.decision;
  const publication = decision.publication;
  const producer = publication.producerDecision;
  const itemNumber = String(decision.itemNumber);
  const targetRepo = String(decision.targetRepo);
  const outcomePath = checkedOutcomePath(workspace, item.outcomePath);
  const bundleDir = join(root, "bundles", itemNumber);
  const eventArtifacts = join(root, "artifacts/event");
  mkdirSync(bundleDir, { recursive: true });
  mkdirSync(eventArtifacts, { recursive: true });
  mkdirSync(dirname(outcomePath), { recursive: true });

  const rateLimitObservationPath = resolve(
    workspace,
    process.env.CLAWSWEEPER_GITHUB_RATE_LIMIT_OBSERVATION_PATH ||
      ".artifacts/exact-review-batch/github-rate-limits.jsonl",
  );
  const requestMetricsPath = resolve(
    workspace,
    process.env.CLAWSWEEPER_GITHUB_REQUEST_METRICS_PATH ||
      ".artifacts/exact-review-batch/github-request-metrics.jsonl",
  );
  const itemEgressEnv = {
    TARGET_REPO: targetRepo,
    CLAWSWEEPER_GITHUB_POOL_CLASS: "repository_actions",
    CLAWSWEEPER_GITHUB_STAGE: "publication_prepare",
    CLAWSWEEPER_GITHUB_SOURCE_ACTION: String(producer.sourceAction || ""),
    CLAWSWEEPER_GITHUB_CLAIM_GENERATION: String(item.claimGeneration),
    CLAWSWEEPER_GITHUB_REQUEST_REPEAT: String(item.repeatRevision === true),
  };
  const maxArtifactBytes = positiveInteger(
    process.env.EXACT_REVIEW_BATCH_MAX_ARTIFACT_BYTES,
    DEFAULT_ARTIFACT_BYTES,
  );
  const maxArchiveBytes = maxArtifactBytes + 2 * 1024 * 1024;
  const acquisitionPath = join(root, "artifact-acquisition.json");
  const acquisition = {
    cacheHit: false,
    cacheFallback: false,
    circuitDeferred: false,
    githubArtifactRequests: 0,
  };
  const cacheOptions = exactReviewArtifactCacheOptions(item, bundleDir, maxArchiveBytes);
  let bundleReady = false;
  if (cacheOptions) {
    try {
      const restored = await restoreExactReviewArtifact(cacheOptions);
      if (restored.hit) {
        const validation = await validateExactReviewBundle({
          bundleDir,
          workspace,
          item,
          decision,
          publication,
          producer,
          itemNumber,
          targetRepo,
        });
        if (!validation.valid) throw new Error("cached bundle validation failed");
        acquisition.cacheHit = true;
        bundleReady = true;
      } else {
        acquisition.cacheFallback = true;
      }
    } catch {
      acquisition.cacheFallback = true;
      rmSync(bundleDir, { recursive: true, force: true });
      mkdirSync(bundleDir, { recursive: true });
      console.warn(
        `Exact-review artifact cache miss or mismatch for ${item.itemKey}; using GitHub`,
      );
    }
  }

  if (!bundleReady) {
    const activeCircuit = latestActiveRateLimitObservation(rateLimitObservationPath);
    if (activeCircuit) {
      acquisition.circuitDeferred = true;
      writeWorkerAcquisition(acquisitionPath, acquisition);
      appendRequestMetric(requestMetricsPath, {
        scope: activeCircuit.scope,
        category: "artifact_download",
        mode: "read",
        outcome: "skipped_by_circuit",
        repeat_revision: item.repeatRevision === true,
        count: 1,
      });
      appendLegacyAvoidedGithubEgressMember({
        env: { ...process.env, TARGET_REPO: targetRepo },
        poolClass:
          activeCircuit.scope === "repository_actions" ? "repository_actions" : "target_app",
        stage: "publication_prepare",
        sourceAction: producer.sourceAction,
        operation: "artifact_download",
        claimGeneration: item.claimGeneration,
        repeatRevision: item.repeatRevision === true,
      });
      return writeFailure(outcomePath, "retryable_failure", "github_rate_limit", {
        retryAt: activeCircuit.retry_at,
        rateLimitScope: activeCircuit.scope,
        rateLimitProvenance: activeCircuit.provenance,
        rateLimitAuthoritative: activeCircuit.authoritative === true,
        attempted: false,
      });
    }
    recordGithubEgressMember({
      env: { ...process.env, TARGET_REPO: targetRepo },
      poolClass: "repository_actions",
      stage: "publication_prepare",
      sourceAction: producer.sourceAction,
      claimGeneration: item.claimGeneration,
      repeatRevision: item.repeatRevision === true,
      attempted: true,
      outcome: "attempted",
    });
    acquisition.githubArtifactRequests = 1;
    writeWorkerAcquisition(acquisitionPath, acquisition);
    const repositoryToken = env("REPO_TOKEN");
    let result = await run(
      "gh",
      [
        "run",
        "download",
        String(publication.producerRunId),
        "--repo",
        env("GITHUB_REPOSITORY"),
        "--name",
        String(publication.artifactName),
        "--dir",
        bundleDir,
      ],
      {
        env: {
          ...process.env,
          GH_TOKEN: repositoryToken,
          ...itemEgressEnv,
        },
        capture: true,
      },
    );
    appendRequestMetric(requestMetricsPath, {
      scope: "repository_actions",
      category: "artifact_download",
      mode: "read",
      outcome:
        result.code === 0 ? "success" : githubThrottleText(result.stderr) ? "throttle" : "error",
      repeat_revision: item.repeatRevision === true,
      count: 1,
    });
    if (result.code !== 0 && githubThrottleText(result.stderr)) {
      const observation = await resolveRateLimitObservation(
        repositoryToken,
        requestMetricsPath,
        rateLimitObservationPath,
        itemEgressEnv,
      );
      appendJsonLine(rateLimitObservationPath, observation);
      return writeFailure(outcomePath, "retryable_failure", "github_rate_limit", {
        retryAt: observation.retry_at,
        rateLimitScope: observation.scope,
        rateLimitProvenance: observation.provenance,
        rateLimitAuthoritative: observation.authoritative,
        attempted: true,
      });
    }
    if (result.code !== 0)
      return writeFailure(outcomePath, "retryable_failure", "artifact_unavailable");
    const artifactBytes = directoryBytes(bundleDir);
    if (artifactBytes > maxArtifactBytes) {
      return writeFailure(outcomePath, "retryable_failure", "artifact_unavailable");
    }
    const validation = await validateExactReviewBundle({
      bundleDir,
      workspace,
      item,
      decision,
      publication,
      producer,
      itemNumber,
      targetRepo,
    });
    if (!validation.valid) {
      if (validation.legacyTupleless) {
        return writeFailure(outcomePath, "permanent_failure", "tuple_protocol_invalid");
      }
      return writeFailure(outcomePath, "retryable_failure", "unknown_failure");
    }
    bundleReady = true;
    if (cacheOptions) {
      await publishExactReviewArtifact(cacheOptions).catch(() => {
        console.warn(`Exact-review artifact cache population failed for ${item.itemKey}`);
      });
    }
  }
  writeWorkerAcquisition(acquisitionPath, acquisition);
  const liveProofPublication = await run(
    process.execPath,
    [
      join(workspace, "dist/clawsweeper.js"),
      "live-proof-publish-artifacts",
      "--artifact-dir",
      bundleDir,
    ],
    { cwd: workspace, env: process.env, capture: true },
  );
  if (liveProofPublication.code !== 0) {
    try {
      if (JSON.parse(liveProofPublication.stdout).status === "invalid_artifact")
        return writeFailure(outcomePath, "refresh_required", "invalid_artifact");
    } catch {}
    console.error(liveProofPublication.stderr);
    return writeFailure(outcomePath, "retryable_failure", "unknown_failure");
  }
  const report = join(bundleDir, "review", `${itemNumber}.md`);
  if (existsSync(report)) {
    cpSync(report, join(eventArtifacts, `${itemNumber}.md`));
    cpSync(report, outcomePath.replace(/\.json$/, ".report.md"));
  }

  const result = await run(
    process.execPath,
    [join(workspace, "dist/repair/publish-event-result.js")],
    {
      cwd: root,
      env: {
        ...process.env,
        CLAWSWEEPER_GH_RETRY_ATTEMPTS: "2",
        CLAWSWEEPER_CODE_ROOT: workspace,
        EXACT_REVIEW_WORK_ROOT: root,
        TARGET_REPO: targetRepo,
        ITEM_NUMBER: itemNumber,
        EXACT_REVIEW_DECISION: JSON.stringify(producer),
        MIN_AGE_MINUTES: "0",
        REVIEW_ONLY: String(
          producer.publicationPolicy === "record_comment_only" ||
            producer.sourceAction === "failed_review_shard_recovery",
        ),
        EXACT_EVENT_PUBLICATION: "true",
        EXACT_REVIEW_CLOSE_COVERAGE_DEFERRED: "true",
        EXACT_REVIEW_BATCH_ITEM_KEY: String(item.itemKey),
        EXACT_REVIEW_BATCH_REVISION: String(item.revision),
        EXACT_REVIEW_BATCH_CLAIM_GENERATION: String(item.claimGeneration),
        EXACT_REVIEW_BATCH_MUTATION_OUTPUT: outcomePath,
        CLAWSWEEPER_GITHUB_RATE_LIMIT_OBSERVATION_PATH: rateLimitObservationPath,
        CLAWSWEEPER_GITHUB_REQUEST_METRICS_PATH: requestMetricsPath,
        CLAWSWEEPER_GITHUB_STAGE: "publication_apply",
        CLAWSWEEPER_GITHUB_SOURCE_ACTION: String(producer.sourceAction || ""),
        CLAWSWEEPER_GITHUB_REQUEST_REPEAT: String(item.repeatRevision === true),
      },
    },
  );
  if (result.code !== 0 && !existsSync(outcomePath)) {
    writeFailure(outcomePath, "retryable_failure", "unknown_failure");
  }
}

async function validateExactReviewBundle({
  bundleDir,
  workspace,
  decision,
  publication,
  producer,
  itemNumber,
  targetRepo,
}) {
  const result = await run(
    process.execPath,
    [join(workspace, "dist/repair/exact-review-bundle-cli.js"), "validate"],
    {
      cwd: workspace,
      env: {
        ...process.env,
        EXACT_REVIEW_BUNDLE_DIR: bundleDir,
        EXACT_REVIEW_CLAIM_GENERATION: String(publication.claimGeneration),
        EXACT_REVIEW_DECISION: JSON.stringify(producer),
        EXACT_REVIEW_GENERATION_ATTEMPT: String(publication.producerRunAttempt),
        EXACT_REVIEW_ITEM_KEY: String(publication.itemKey),
        EXACT_REVIEW_ITEM_KIND: String(decision.itemKind),
        EXACT_REVIEW_ITEM_NUMBER: itemNumber,
        EXACT_REVIEW_LEASE_REVISION: String(publication.leaseRevision),
        EXACT_REVIEW_LIVE_GUARDED_OPEN: String(publication.liveGuardedOpen),
        EXACT_REVIEW_LIVE_PROCEEDED: String(publication.liveProceeded),
        EXACT_REVIEW_LIVE_TERMINAL_MISSING: String(publication.liveTerminalMissing),
        EXACT_REVIEW_LIVE_TERMINAL_NOOP: String(publication.liveTerminalNoop),
        EXACT_REVIEW_PRODUCER_JOB: "event-review-apply",
        EXACT_REVIEW_PRODUCER_RUN_ID: String(publication.producerRunId),
        EXACT_REVIEW_PROTOCOL_VERSION: String(publication.protocolVersion),
        EXACT_REVIEW_SOURCE_SHA: String(publication.sourceSha),
        EXACT_REVIEW_TARGET_BRANCH: String(decision.targetBranch),
        EXACT_REVIEW_TARGET_REPO: targetRepo,
      },
    },
  );
  const report = join(bundleDir, "review", `${itemNumber}.md`);
  const tupleless = existsSync(report) && legacyTupleless(readFileSync(report, "utf8"));
  return { valid: result.code === 0 && !tupleless, legacyTupleless: tupleless };
}

function exactReviewArtifactCacheOptions(item, bundleDir, maxArchiveBytes) {
  const baseUrl = String(process.env.EXACT_REVIEW_QUEUE_URL || "").trim();
  const webhookSecret = String(process.env.CLAWSWEEPER_WEBHOOK_SECRET || "");
  if (!baseUrl || !webhookSecret) return null;
  try {
    return {
      baseUrl,
      webhookSecret,
      tuple: exactReviewArtifactReceiptTuple(item),
      bundleDir,
      maxArchiveBytes,
    };
  } catch {
    return null;
  }
}

function writeWorkerAcquisition(path, value) {
  writeFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
}

function readWorkerAcquisition(root) {
  const path = join(root, "artifact-acquisition.json");
  if (!existsSync(path)) {
    return {
      cacheHit: false,
      cacheFallback: false,
      circuitDeferred: false,
      githubArtifactRequests: 0,
    };
  }
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return {
      cacheHit: value.cacheHit === true,
      cacheFallback: value.cacheFallback === true,
      circuitDeferred: value.circuitDeferred === true,
      githubArtifactRequests: Number(value.githubArtifactRequests) === 1 ? 1 : 0,
    };
  } catch {
    return {
      cacheHit: false,
      cacheFallback: false,
      circuitDeferred: false,
      githubArtifactRequests: 0,
    };
  }
}

function checkedOutcomePath(workspace, path) {
  const outcomeRoot = resolve(workspace, ".artifacts/exact-review-batch/outcomes");
  const candidate = resolve(workspace, String(path));
  if (candidate !== outcomeRoot && !candidate.startsWith(`${outcomeRoot}${sep}`)) {
    throw new Error("batch outcome path escapes the bounded outcome root");
  }
  return candidate;
}

function writeFailure(path, kind, reasonCode, details = {}) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ kind, reasonCode, ...details })}\n`, "utf8");
}

function githubThrottleText(value) {
  return /api rate limit exceeded|secondary rate limit|abuse detection|http\s*429|rate limited|was submitted too quickly/i.test(
    String(value || ""),
  );
}

async function resolveRateLimitObservation(
  token,
  requestMetricsPath,
  observationPath,
  telemetryEnv,
) {
  const now = Date.now();
  try {
    closeSync(openSync(`${observationPath}.lookup-repository_actions.lock`, "wx"));
  } catch {
    return {
      scope: "repository_actions",
      observed_at: new Date(now).toISOString(),
      retry_at: new Date(now + 60_000).toISOString(),
      provenance: "fallback",
      authoritative: false,
    };
  }
  const status = await run(
    "gh",
    [
      "api",
      "rate_limit",
      "--jq",
      "{remaining:.resources.core.remaining,reset:.resources.core.reset}",
    ],
    { env: { ...process.env, GH_TOKEN: token, ...telemetryEnv }, capture: true },
  );
  appendRequestMetric(requestMetricsPath, {
    scope: "repository_actions",
    category: "rate_status",
    mode: "read",
    outcome:
      status.code === 0 ? "success" : githubThrottleText(status.stderr) ? "throttle" : "error",
    repeat_revision: false,
    count: 1,
  });
  let resetAt = 0;
  if (status.code === 0) {
    try {
      const parsed = JSON.parse(status.stdout || "null");
      if (Number(parsed?.remaining) <= 0 && Number.isSafeInteger(Number(parsed?.reset))) {
        resetAt = Number(parsed.reset) * 1_000;
      }
    } catch {
      // The shared circuit still uses the conservative fallback below.
    }
  }
  return {
    scope: "repository_actions",
    observed_at: new Date(now).toISOString(),
    retry_at: new Date(Math.max(now + 60_000, resetAt)).toISOString(),
    provenance: resetAt ? "rate_limit_status" : "fallback",
    authoritative: resetAt > 0,
  };
}

function appendJsonLine(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
}

function appendRequestMetric(path, value) {
  appendJsonLine(path, value);
}

function latestActiveRateLimitObservation(path) {
  if (!existsSync(path)) return null;
  let latest = null;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      const retryAt = Date.parse(String(value.retry_at || ""));
      if (retryAt > Date.now() && (!latest || retryAt > Date.parse(latest.retry_at)))
        latest = value;
    } catch {
      // A partial observation cannot open a circuit; the publisher outcome remains authoritative.
    }
  }
  return latest;
}

function legacyTupleless(markdown) {
  const owner = /^review_lease_owner:\s*(.+)\s*$/m.exec(markdown)?.[1]?.trim() || "";
  const commentId = Number(/^review_lease_comment_id:\s*(\d+)\s*$/m.exec(markdown)?.[1] || "0");
  return (!owner || owner === "unknown") && (!Number.isInteger(commentId) || commentId <= 0);
}

function directoryBytes(path) {
  let total = 0;
  const stack = [path];
  while (stack.length) {
    const current = stack.pop();
    const stat = statSync(current);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(current)) stack.push(join(current, entry));
    } else total += stat.size;
  }
  return total;
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];
}

function boundedInteger(value, fallback, maximum) {
  const parsed = positiveInteger(value, fallback);
  if (parsed > maximum) throw new Error(`value must not exceed ${maximum}`);
  return parsed;
}

function positiveInteger(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error("value must be a positive integer");
  return parsed;
}

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: Boolean(options.timeoutMs),
      env: options.env || process.env,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (options.capture) {
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
        process.stderr.write(chunk);
      });
    }
    let timedOut = false;
    let forceTimer = null;
    const terminate = (signal) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        // The process group may already have exited between the timer and signal.
      }
    };
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          terminate("SIGTERM");
          forceTimer = setTimeout(() => terminate("SIGKILL"), 5_000);
        }, options.timeoutMs)
      : null;
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      resolvePromise({ code: code ?? 1, signal, timedOut, stdout, stderr });
    });
  });
}

function remainingTimeout(deadline) {
  return Math.max(1, deadline - Date.now());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "worker") {
    await worker(process.argv[3], process.argv[4], process.argv[5]);
  } else {
    await controller();
  }
}
