#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 4;
const MAX_ITEMS = 32;
const DEFAULT_ITEM_TIMEOUT_MS = 8 * 60_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_MUTATION_FILES = 512;
const MAX_MUTATION_FILE_BYTES = 2 * 1024 * 1024;
const MAX_MUTATION_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_OUTCOME_BYTES = 2 * 1024 * 1024;

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

export function createSerialTaskQueue() {
  let tail = Promise.resolve();
  return (task) => {
    const current = tail.then(task);
    tail = current.catch(() => {});
    return current;
  };
}

export async function captureIsolatedStateCloneSource(stateRoot) {
  const remoteUrl = (await capture("git", ["-C", stateRoot, "remote", "get-url", "origin"])).trim();
  if (!remoteUrl) throw new Error("state origin URL is required");
  const config = await capture("git", ["-C", stateRoot, "config", "--local", "--null", "--list"]);
  return { remoteUrl, configEntries: workerGitConfigEntries(config) };
}

export async function createIsolatedStateClone({
  stateRoot,
  destination,
  baselineSha,
  timeoutMs,
  source,
}) {
  await runChecked("git", ["clone", "--shared", "--no-checkout", stateRoot, destination], {
    timeoutMs,
  });
  await runChecked("git", ["-C", destination, "remote", "set-url", "origin", source.remoteUrl], {
    timeoutMs,
  });
  for (const entry of source.configEntries) {
    await runChecked(
      "git",
      ["-C", destination, "config", "--local", "--add", entry.key, entry.value],
      {
        timeoutMs,
      },
    );
  }
  await runChecked("git", ["-C", destination, "checkout", "--detach", baselineSha], {
    timeoutMs,
  });
}

export async function importPreparedMutationObjects({
  stateRoot,
  stateClone,
  outcomePath,
  timeoutMs,
}) {
  if (!existsSync(outcomePath)) return;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("prepared mutation object import deadline expired");
  }
  const outcomeStat = lstatSync(outcomePath);
  if (!outcomeStat.isFile()) throw new Error("prepared mutation outcome must be a regular file");
  if (outcomeStat.size > MAX_OUTCOME_BYTES) {
    throw new Error("prepared mutation outcome exceeds the byte limit");
  }
  const deadline = Date.now() + timeoutMs;
  const outcome = JSON.parse(readFileSync(outcomePath, "utf8"));
  if (outcome.kind !== "eligible") return;
  const operations = Array.isArray(outcome.plan?.operations) ? outcome.plan.operations : [];
  if (operations.length > MAX_MUTATION_FILES) {
    throw new Error("prepared mutation exceeds the file limit");
  }
  const bytesByOid = new Map();
  let totalBytes = 0;
  for (const operation of operations) {
    const targetOid = operation?.targetOid;
    if (targetOid === null) continue;
    if (typeof targetOid !== "string" || !/^[a-f0-9]{40,64}$/.test(targetOid)) {
      throw new Error("prepared mutation contains an invalid target object id");
    }
    const bytes = Number(operation?.bytes);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_MUTATION_FILE_BYTES) {
      throw new Error(`prepared mutation contains an invalid byte count for ${targetOid}`);
    }
    totalBytes += bytes;
    if (totalBytes > MAX_MUTATION_TOTAL_BYTES) {
      throw new Error("prepared mutation exceeds the total byte limit");
    }
    const existingBytes = bytesByOid.get(targetOid);
    if (existingBytes !== undefined) {
      if (existingBytes !== bytes) {
        throw new Error(`prepared mutation repeats ${targetOid} with a different byte count`);
      }
      continue;
    }
    bytesByOid.set(targetOid, bytes);
  }
  if (outcome.plan?.totalBytes !== totalBytes) {
    throw new Error("prepared mutation total does not match its operations");
  }
  const targetOids = [...bytesByOid.keys()];
  if (!targetOids.length) return;
  await validateMutationObjects({
    root: stateClone,
    bytesByOid,
    deadline,
    boundary: "source",
  });
  await transferGitObjects({
    sourceRoot: stateClone,
    destinationRoot: stateRoot,
    oids: targetOids,
    timeoutMs: importTimeout(deadline),
  });
  await validateMutationObjects({
    root: stateRoot,
    bytesByOid,
    deadline,
    boundary: "destination",
  });
}

function workerGitConfigEntries(config) {
  const allowed =
    /^(?:http\..*\.extraheader|credential\..*|core\.sshcommand|user\.(?:name|email))$/i;
  return config
    .split("\0")
    .filter(Boolean)
    .flatMap((entry) => {
      const separator = entry.indexOf("\n");
      if (separator < 1) return [];
      const key = entry.slice(0, separator);
      return allowed.test(key) ? [{ key, value: entry.slice(separator + 1) }] : [];
    });
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
  const stateRoot = resolve(env("CLAWSWEEPER_STATE_DIR"));
  const baselineSha = (await capture("git", ["-C", stateRoot, "rev-parse", "HEAD"])).trim();
  // The source remote and auth config are process-stable for the batch. Capture
  // them once so worker fanout never races repeated reads of the shared clone.
  const cloneSource = await captureIsolatedStateCloneSource(stateRoot);
  const workersRoot = resolve(workspace, ".artifacts/exact-review-batch/workers");
  const heartbeatFailurePath = resolve(
    workspace,
    process.env.EXACT_REVIEW_BATCH_HEARTBEAT_FAILURE_PATH ||
      ".artifacts/exact-review-batch/heartbeat-failed",
  );
  rmSync(workersRoot, { recursive: true, force: true });
  mkdirSync(workersRoot, { recursive: true });
  let cleanupFailures = 0;
  const durations = [];
  let timeouts = 0;
  let admitted = 0;
  // Worker preparation is parallel, but every imported object lands in the
  // same state repository. Keep that shared Git mutation boundary serial.
  const importObjects = createSerialTaskQueue();

  const { peak } = await runBoundedPool(items, concurrency, async (item, index) => {
    const outcomePath = checkedOutcomePath(workspace, item.outcomePath);
    if (existsSync(heartbeatFailurePath) || Date.now() >= deadline) {
      writeFailure(outcomePath, "retryable_failure", "unknown_failure");
      return { kind: "not_admitted", durationMs: 0 };
    }
    admitted += 1;
    const identity = createHash("sha256")
      .update(`${item.itemKey}:${item.revision}:${item.claimGeneration}`)
      .digest("hex")
      .slice(0, 16);
    const root = join(workersRoot, `${String(index).padStart(2, "0")}-${identity}`);
    const stateClone = join(root, "state");
    const itemPath = join(root, "item.json");
    mkdirSync(root, { recursive: true });
    writeFileSync(itemPath, `${JSON.stringify(item)}\n`, "utf8");
    const workerStartedAt = Date.now();
    const itemDeadline = Math.min(deadline, workerStartedAt + itemTimeoutMs);
    let timedOut = false;
    let failureStage = "isolated state clone";
    try {
      await createIsolatedStateClone({
        stateRoot,
        destination: stateClone,
        baselineSha,
        timeoutMs: remainingTimeout(deadline),
        source: cloneSource,
      });
      failureStage = "worker execution";
      const status = await run(
        process.execPath,
        [process.argv[1], "worker", itemPath, root, stateClone, workspace],
        { timeoutMs: Math.min(itemTimeoutMs, remainingTimeout(deadline)) },
      );
      timedOut = status.timedOut;
      if (timedOut) timeouts += 1;
      if (existsSync(outcomePath)) {
        failureStage = "prepared object import";
        try {
          await importObjects(() =>
            importPreparedMutationObjects({
              stateRoot,
              stateClone,
              outcomePath,
              timeoutMs: importTimeout(itemDeadline),
            }),
          );
        } catch (error) {
          writeFailure(outcomePath, "retryable_failure", "unknown_failure");
          console.error(
            `Failed to import prepared mutation objects: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
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
    baselineSha,
    prepareDurationMs: Date.now() - startedAt,
    workerMaximumMs: sortedDurations.at(-1) || 0,
    workerP95Ms: percentile(sortedDurations, 0.95),
    admitted,
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

async function worker(itemPath, root, stateClone, workspace) {
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
    { env: { ...process.env, GH_TOKEN: env("REPO_TOKEN") } },
  );
  if (result.code !== 0)
    return writeFailure(outcomePath, "retryable_failure", "artifact_unavailable");
  const artifactBytes = directoryBytes(bundleDir);
  const maxArtifactBytes = positiveInteger(
    process.env.EXACT_REVIEW_BATCH_MAX_ARTIFACT_BYTES,
    DEFAULT_ARTIFACT_BYTES,
  );
  if (artifactBytes > maxArtifactBytes) {
    return writeFailure(outcomePath, "retryable_failure", "artifact_unavailable");
  }

  result = await run(
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
  if (result.code !== 0) return writeFailure(outcomePath, "retryable_failure", "unknown_failure");
  const report = join(bundleDir, "review", `${itemNumber}.md`);
  if (existsSync(report) && legacyTupleless(readFileSync(report, "utf8"))) {
    return writeFailure(outcomePath, "permanent_failure", "tuple_protocol_invalid");
  }
  if (existsSync(report)) cpSync(report, join(eventArtifacts, `${itemNumber}.md`));

  result = await run(process.execPath, [join(workspace, "dist/repair/publish-event-result.js")], {
    cwd: root,
    env: {
      ...process.env,
      CLAWSWEEPER_CODE_ROOT: workspace,
      CLAWSWEEPER_STATE_DIR: stateClone,
      EXACT_REVIEW_WORK_ROOT: root,
      TARGET_REPO: targetRepo,
      ITEM_NUMBER: itemNumber,
      CLOSE_REASONS: "implemented_on_main,duplicate_or_superseded,low_signal_unmergeable_pr",
      MIN_AGE_MINUTES: "0",
      REVIEW_ONLY: String(producer.sourceAction === "failed_review_shard_recovery"),
      EXACT_EVENT_PUBLICATION: "true",
      EXACT_REVIEW_CLOSE_COVERAGE_DEFERRED: "true",
      EXACT_REVIEW_BATCH_ITEM_KEY: String(item.itemKey),
      EXACT_REVIEW_BATCH_REVISION: String(item.revision),
      EXACT_REVIEW_BATCH_CLAIM_GENERATION: String(item.claimGeneration),
      EXACT_REVIEW_BATCH_MUTATION_OUTPUT: outcomePath,
    },
  });
  if (result.code !== 0 && !existsSync(outcomePath)) {
    writeFailure(outcomePath, "retryable_failure", "unknown_failure");
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

function writeFailure(path, kind, reasonCode) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ kind, reasonCode })}\n`, "utf8");
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
      stdio: "inherit",
    });
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
      resolvePromise({ code: code ?? 1, signal, timedOut });
    });
  });
}

function remainingTimeout(deadline) {
  return Math.max(1, deadline - Date.now());
}

function importTimeout(deadline) {
  const timeoutMs = deadline - Date.now();
  if (timeoutMs < 1) throw new Error("prepared mutation object import deadline expired");
  return timeoutMs;
}

async function runChecked(command, args, options = {}) {
  const result = await run(command, args, options);
  if (result.code !== 0 || result.timedOut) {
    throw new Error(`${basename(command)} exited ${result.code}`);
  }
  return result;
}

async function transferGitObjects({ sourceRoot, destinationRoot, oids, timeoutMs }) {
  await new Promise((resolvePromise, reject) => {
    const pack = spawn(
      "git",
      ["-C", sourceRoot, "pack-objects", "--stdout", "--revs", "--no-reuse-object"],
      {
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const unpack = spawn("git", ["-C", destinationRoot, "unpack-objects", "-r"], {
      detached: true,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let packError = "";
    let unpackError = "";
    let packCode = null;
    let unpackCode = null;
    let timedOut = false;
    let forceTimer = null;
    const terminate = (child, signal) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        // The process group may already have exited between the timer and signal.
      }
    };
    const fail = (error) => {
      terminate(pack, "SIGTERM");
      terminate(unpack, "SIGTERM");
      reject(error);
    };
    pack.once("error", fail);
    unpack.once("error", fail);
    pack.stderr.setEncoding("utf8");
    pack.stderr.on("data", (chunk) => (packError += chunk));
    unpack.stderr.setEncoding("utf8");
    unpack.stderr.on("data", (chunk) => (unpackError += chunk));
    pack.stdout.pipe(unpack.stdin);
    unpack.stdin.on("error", () => {
      // A failed unpack closes the pipe; process exit status supplies the useful error.
    });
    pack.stdin.end(`${oids.join("\n")}\n`);
    const timer = setTimeout(() => {
      timedOut = true;
      terminate(pack, "SIGTERM");
      terminate(unpack, "SIGTERM");
      forceTimer = setTimeout(() => {
        terminate(pack, "SIGKILL");
        terminate(unpack, "SIGKILL");
      }, 5_000);
    }, timeoutMs);
    const complete = () => {
      if (packCode === null || unpackCode === null) return;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (timedOut) return reject(new Error("prepared mutation object import timed out"));
      if (packCode !== 0 || unpackCode !== 0) {
        return reject(
          new Error(
            (
              unpackError ||
              packError ||
              `Git object transfer exited ${packCode}/${unpackCode}`
            ).trim(),
          ),
        );
      }
      resolvePromise();
    };
    pack.once("exit", (code) => {
      packCode = code ?? 1;
      complete();
    });
    unpack.once("exit", (code) => {
      unpackCode = code ?? 1;
      complete();
    });
  });
}

async function validateMutationObjects({ root, bytesByOid, deadline, boundary }) {
  const targetOids = [...bytesByOid.keys()];
  const output = await capture(
    "git",
    ["-C", root, "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    {
      input: `${targetOids.join("\n")}\n`,
      timeoutMs: importTimeout(deadline),
    },
  );
  const lines = output.trim().split("\n");
  if (lines.length !== targetOids.length) {
    throw new Error(`Git returned incomplete ${boundary} mutation metadata`);
  }
  for (let index = 0; index < targetOids.length; index += 1) {
    const targetOid = targetOids[index];
    const match = /^([a-f0-9]{40,64}) blob ([0-9]+)$/.exec(lines[index] || "");
    if (match?.[1] !== targetOid || Number(match[2]) !== bytesByOid.get(targetOid)) {
      throw new Error(`prepared mutation ${boundary} object does not match ${targetOid}`);
    }
  }
}

async function capture(command, args, options = {}) {
  return await new Promise((resolvePromise, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let forceTimer = null;
    const child = spawn(command, args, {
      detached: Boolean(options.timeoutMs),
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
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
    if (options.input === undefined) child.stdin.end();
    else child.stdin.end(options.input);
    child.once("exit", (code) => {
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (timedOut) return reject(new Error(`${basename(command)} timed out`));
      if (code !== 0) {
        return reject(new Error((stderr || `${basename(command)} exited ${code}`).trim()));
      }
      resolvePromise(stdout);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "worker") {
    await worker(process.argv[3], process.argv[4], process.argv[5], process.argv[6]);
  } else {
    await controller();
  }
}
