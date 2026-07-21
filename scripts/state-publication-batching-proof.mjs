#!/usr/bin/env node

/**
 * Definition: run isolated correctness and performance proof for exact-review
 * state publication batching. The performance mode reads a real state branch
 * into a temporary partial clone, then publishes only to a temporary local bare
 * repository. It never pushes to the source repository.
 *
 * Parameters: see --help. Performance defaults to 20 samples for batch sizes
 * 1, 2, 4, and 8. E2E mode uses an in-process synthetic queue and GitHub-effect
 * journal with a temporary Git remote.
 *
 * Outputs: a JSON report at --output and a one-line summary on stdout. Exit 0
 * means every invariant passed and the performance gate met the requested
 * throughput; exit 1 means proof failed; exit 2 means arguments were invalid.
 *
 * Decision: production state is read only. All receipt refs, commits, queue
 * outcomes, and synthetic GitHub effects stay below a disposable temp root.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { coordinateExactReviewBatch } from "../dist/repair/exact-review-batch-coordinator.js";
import { commitPreparedStateBatch } from "../dist/repair/state-publication-batch.js";
import { prepareStateMutationPlan } from "../dist/repair/state-publication-mutation.js";
import { StateWriterTelemetryRecorder } from "../dist/repair/state-writer-telemetry-recorder.js";

const DEFAULT_OUTPUT = ".artifacts/state-publication-batching-proof/report.json";
const DEFAULT_SOURCE = "https://github.com/openclaw/clawsweeper-state.git";
const DEFAULT_MINIMUM_SOURCE_PATHS = 300_000;
const ROLLOUT_SOURCE_HEAD = "15fb20fc3008c67e80ecd82d28fd4e72cab5adcd";
const ROLLOUT_SOURCE_PATHS = 385_840;
const BATCH_SIZES = [1, 2, 4, 8];

function usage() {
  return `Usage:
  node scripts/state-publication-batching-proof.mjs [options]

Description:
  Proves the PR2 batch committer against a realistic state tree and/or proves
  the PR3 coordinator against an isolated synthetic queue and GitHub journal.
  The source repository is cloned read-only; all writes target temporary repos.

Options:
  --mode <all|performance|e2e>  Proof mode (default: all)
  --state-source <url|path>     Read-only state repository (default: ${DEFAULT_SOURCE})
  --state-ref <ref>             Source branch or tag (default: state)
  --iterations <count>          Samples per batch size, 1-100 (default: 20)
  --minimum-throughput <items>  Required projected items/hour (default: 203)
  --minimum-source-paths <n>    Required source paths, 1-1000000 (default: ${DEFAULT_MINIMUM_SOURCE_PATHS})
  --diagnostic                  Allow non-rollout fixtures; never qualifies rollout
  --output <path>               JSON report path (default: ${DEFAULT_OUTPUT})
  -h, --help                    Show this help

Outputs:
  Writes one JSON report containing source identity, per-size p50/p95 timings,
  Git phase/process measurements, projected throughput, and synthetic E2E
  outcomes. Prints STATE_PUBLICATION_BATCHING_PROOF with the report path.

Examples:
  pnpm run build:repair && node scripts/state-publication-batching-proof.mjs --mode e2e --diagnostic
  pnpm run build:repair && node scripts/state-publication-batching-proof.mjs \\
    --mode performance --iterations 20 --output .artifacts/batching-proof.json
`;
}

function parseArgs(argv) {
  const options = {
    mode: "all",
    stateSource: DEFAULT_SOURCE,
    stateRef: "state",
    iterations: 20,
    minimumThroughput: 203,
    minimumSourcePaths: DEFAULT_MINIMUM_SOURCE_PATHS,
    diagnostic: false,
    output: DEFAULT_OUTPUT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "-h" || argument === "--help") return { help: true, options };
    if (argument === "--diagnostic") {
      options.diagnostic = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) failUsage(`Missing value for ${argument}`);
    if (argument === "--mode") options.mode = value;
    else if (argument === "--state-source") options.stateSource = value;
    else if (argument === "--state-ref") options.stateRef = value;
    else if (argument === "--iterations") options.iterations = numberOption(argument, value);
    else if (argument === "--minimum-throughput")
      options.minimumThroughput = numberOption(argument, value);
    else if (argument === "--minimum-source-paths")
      options.minimumSourcePaths = numberOption(argument, value);
    else if (argument === "--output") options.output = value;
    else failUsage(`Unknown option: ${argument}`);
    index += 1;
  }
  if (!new Set(["all", "performance", "e2e"]).has(options.mode)) {
    failUsage("--mode must be all, performance, or e2e");
  }
  if (
    !Number.isSafeInteger(options.iterations) ||
    options.iterations < 1 ||
    options.iterations > 100
  ) {
    failUsage("--iterations must be an integer from 1 to 100");
  }
  if (!Number.isFinite(options.minimumThroughput) || options.minimumThroughput <= 0) {
    failUsage("--minimum-throughput must be a positive number");
  }
  if (
    !Number.isSafeInteger(options.minimumSourcePaths) ||
    options.minimumSourcePaths < 1 ||
    options.minimumSourcePaths > 1_000_000
  ) {
    failUsage("--minimum-source-paths must be an integer from 1 to 1000000");
  }
  if (!options.stateSource.trim() || !options.stateRef.trim() || !options.output.trim()) {
    failUsage("--state-source, --state-ref, and --output must be non-empty");
  }
  return { help: false, options };
}

function validateProofContract(options) {
  if (options.diagnostic) return;
  if (options.mode !== "all") {
    failUsage("the default proof contract requires --mode all");
  }
  if (options.iterations < 20) {
    failUsage("the default proof contract requires at least 20 iterations per batch size");
  }
  if (options.minimumThroughput < 203) {
    failUsage("the default proof contract requires at least 203 projected items/hour");
  }
  if (options.minimumSourcePaths < DEFAULT_MINIMUM_SOURCE_PATHS) {
    failUsage(
      `the default proof contract requires at least ${DEFAULT_MINIMUM_SOURCE_PATHS} source paths`,
    );
  }
}

function numberOption(name, value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) failUsage(`${name} must be numeric`);
  return parsed;
}

function resolveStateSource(source) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source) || /^[^/]+@[^:]+:/.test(source)) {
    return source;
  }
  return path.resolve(source);
}

function failUsage(message) {
  process.stderr.write(`ERROR: ${message}\n\n${usage()}`);
  process.exit(2);
}

function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function createSmallRepository(root) {
  fs.mkdirSync(root, { recursive: true });
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  git(root, "init", "--bare", origin);
  git(root, "clone", origin, work);
  configureWorktree(work);
  fs.mkdirSync(path.join(work, "results"), { recursive: true });
  fs.writeFileSync(path.join(work, "results", "synthetic-sibling.json"), '{"kept":true}\n');
  git(work, "add", ".");
  git(work, "commit", "-m", "initial synthetic state");
  git(work, "push", "origin", "HEAD:state");
  return { origin, work };
}

function configureWorktree(work) {
  git(work, "config", "user.name", "ClawSweeper Batching Proof");
  git(work, "config", "user.email", "clawsweeper@example.com");
}

function withStateEnvironment(work, operation) {
  const previousDir = process.env.CLAWSWEEPER_STATE_DIR;
  const previousBranch = process.env.CLAWSWEEPER_PUBLISH_BRANCH;
  process.env.CLAWSWEEPER_STATE_DIR = work;
  process.env.CLAWSWEEPER_PUBLISH_BRANCH = "state";
  try {
    const result = operation();
    if (result && typeof result.finally === "function") {
      return result.finally(() => {
        restoreEnv("CLAWSWEEPER_STATE_DIR", previousDir);
        restoreEnv("CLAWSWEEPER_PUBLISH_BRANCH", previousBranch);
      });
    }
    restoreEnv("CLAWSWEEPER_STATE_DIR", previousDir);
    restoreEnv("CLAWSWEEPER_PUBLISH_BRANCH", previousBranch);
    return result;
  } catch (error) {
    restoreEnv("CLAWSWEEPER_STATE_DIR", previousDir);
    restoreEnv("CLAWSWEEPER_PUBLISH_BRANCH", previousBranch);
    throw error;
  }
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function runSyntheticE2e(root) {
  const fixture = createSmallRepository(path.join(root, "e2e"));
  const items = [1, 2, 3, 4].map((number) => ({
    itemKey: `synthetic/example#${number}`,
    revision: 1,
    claimGeneration: 1,
    decision: { itemNumber: number },
  }));
  const completed = [];
  const githubEffects = [];
  let enabled = true;
  let commitCalls = 0;
  const queue = syntheticQueue(items, completed, () => enabled);

  const result = await withStateEnvironment(fixture.work, () =>
    coordinateExactReviewBatch(
      { claimId: "synthetic-proof-batch", leaseOwner: "proof-run", maxItems: 4 },
      {
        queue,
        async prepare(item) {
          if (item.itemKey.endsWith("#3")) {
            return { kind: "retryable", reason: "invalid_artifact_fixture" };
          }
          if (item.itemKey.endsWith("#4")) return { kind: "superseded" };
          return {
            kind: "eligible",
            plan: prepareStateMutationPlan({
              identity: item,
              operations: [
                {
                  path: `records/synthetic-example/items/${item.decision.itemNumber}.md`,
                  expectedOid: null,
                  content: `synthetic item ${item.decision.itemNumber}\n`,
                },
              ],
            }),
          };
        },
        async deliverGithubEffects(item) {
          githubEffects.push({
            itemKey: item.itemKey,
            comment: "synthetic durable review",
            labels: ["clawsweeper-reviewed"],
          });
          return "ready";
        },
        async commit(batchId, plans) {
          commitCalls += 1;
          return commitPreparedStateBatch({
            batchId,
            plans,
            lease: { waitMs: 1, acquireTimeoutMs: 10_000 },
          });
        },
      },
    ),
  );

  assert.equal(result.kind, "claimed");
  assert.equal(commitCalls, 1);
  assert.equal(git(fixture.origin, "rev-list", "--count", "state").trim(), "2");
  assert.equal(
    git(fixture.origin, "show", "state:results/synthetic-sibling.json"),
    '{"kept":true}\n',
  );
  assert.equal(githubEffects.length, 2);
  assert.deepEqual(completed.map((item) => item.terminalOutcome).sort(), [
    "published",
    "published",
    "superseded",
  ]);
  enabled = false;
  const disabled = await coordinateExactReviewBatch(
    { claimId: "disabled-proof-batch", leaseOwner: "proof-run", maxItems: 4 },
    {
      queue,
      async prepare() {
        throw new Error("disabled batching must not prepare items");
      },
      async deliverGithubEffects() {
        throw new Error("disabled batching must not deliver effects");
      },
      async commit() {
        throw new Error("disabled batching must not commit");
      },
    },
  );
  assert.deepEqual(disabled, { kind: "idle" });
  const legacyReadyItems = queue.legacyReadyItems();
  const legacyConsumed = queue.consumeLegacy();
  assert.deepEqual(
    legacyReadyItems,
    result.publication.retryable.map((item) => item.itemKey),
  );
  assert.deepEqual(
    legacyConsumed.map((item) => item.itemKey),
    legacyReadyItems,
  );
  assert.deepEqual(queue.legacyReadyItems(), []);

  return {
    target: "isolated synthetic queue, GitHub-effect journal, and local bare Git remote",
    batchId: result.batchId,
    stateCommitSha: result.publication.stateCommitSha,
    commitCount: commitCalls,
    githubEffects,
    terminalOutcomes: completed,
    retryable: result.publication.retryable,
    preservedSibling: true,
    disabledFallback: {
      batchClaimed: false,
      legacyReadyItems,
      legacyConsumedItems: legacyConsumed.map((item) => item.itemKey),
    },
    passed: true,
  };
}

function syntheticQueue(items, completed, enabled) {
  const remaining = new Map(items.map((item) => [item.itemKey, item]));
  const lease = () => ({
    batchId: "synthetic-proof-batch",
    leaseOwner: "proof-run",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    items,
  });
  return {
    async claim() {
      return enabled() ? lease() : null;
    },
    async fetch() {
      return { batch: lease(), items, superseded: 0 };
    },
    async heartbeat() {
      return lease();
    },
    async complete(input) {
      completed.push(...input.items);
      for (const item of input.items) remaining.delete(item.itemKey);
      return { accepted: input.items.length, skipped: 0, batch: lease() };
    },
    legacyReadyItems() {
      return enabled() ? [] : [...remaining.keys()].sort();
    },
    consumeLegacy() {
      if (enabled()) throw new Error("legacy consumption must remain blocked while batching is on");
      const consumed = [...remaining.values()];
      remaining.clear();
      return consumed;
    },
  };
}

function prepareRealisticFixture(root, source, ref) {
  const origin = path.join(root, "realistic-origin.git");
  const work = path.join(root, "realistic-work");
  git(
    root,
    "clone",
    "--bare",
    "--filter=blob:none",
    "--single-branch",
    "--branch",
    ref,
    source,
    origin,
  );
  const sourceHead = git(origin, "rev-parse", ref).trim();
  const sourceTreePaths = Number(
    git(origin, "ls-tree", "-r", "--name-only", ref).split("\n").filter(Boolean).length,
  );
  git(root, "clone", "--no-checkout", origin, work);
  configureWorktree(work);
  return { origin, work, sourceHead, sourceTreePaths };
}

function runPerformanceProof(root, options) {
  const fixtureRoot = path.join(root, "performance");
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const fixture = prepareRealisticFixture(fixtureRoot, options.stateSource, options.stateRef);
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const bySize = [];
  for (const size of BATCH_SIZES) {
    const samples = [];
    for (let iteration = 0; iteration < options.iterations; iteration += 1) {
      const progress = [];
      const observer = new StateWriterTelemetryRecorder({
        mode: "batch",
        configuredBatchSize: size,
        actualBatchSize: size,
        observer: {
          progress(value) {
            progress.push({ phase: value.phase, at: Date.parse(value.observed_at) });
          },
        },
      });
      const trace = path.join(fixtureRoot, `trace-${size}-${iteration}.json`);
      const previousTrace = process.env.GIT_TRACE2_EVENT;
      process.env.GIT_TRACE2_EVENT = trace;
      try {
        const result = withStateEnvironment(fixture.work, () => {
          const plans = Array.from({ length: size }, (_, itemIndex) =>
            prepareStateMutationPlan({
              identity: {
                itemKey: `proof/${runId}#${size}-${iteration}-${itemIndex}`,
                revision: 1,
                claimGeneration: 1,
              },
              operations: [
                {
                  path: `proof/state-publication-batching/${runId}/size-${size}/iteration-${iteration}/item-${itemIndex}.md`,
                  expectedOid: null,
                  content: representativePayload(size, iteration, itemIndex),
                },
              ],
            }),
          );
          return commitPreparedStateBatch({
            batchId: `proof-${runId}-${size}-${iteration}`,
            plans,
            lease: { waitMs: 1, acquireTimeoutMs: 10_000, observer },
          });
        });
        samples.push({
          totalMs: result.git.durationMs,
          leaseAcquireMs: phaseDelta(progress, "waiting", "holding"),
          leaseHoldMs: result.leaseHoldMs,
          paths: result.pathCount,
          bytes: result.totalBytes,
          gitProcesses: result.git.processes,
          gitActions: result.git.actions,
          phases: tracePhases(trace),
        });
      } finally {
        restoreEnv("GIT_TRACE2_EVENT", previousTrace);
        fs.rmSync(trace, { force: true });
      }
    }
    const totalP95 = percentile(
      samples.map((sample) => sample.totalMs),
      0.95,
    );
    bySize.push({
      batchSize: size,
      sampleCount: samples.length,
      totalMs: percentiles(samples.map((sample) => sample.totalMs)),
      leaseAcquireMs: percentiles(samples.map((sample) => sample.leaseAcquireMs)),
      leaseHoldMs: percentiles(samples.map((sample) => sample.leaseHoldMs)),
      phaseMs: Object.fromEntries(
        ["receipt", "fetch", "tree", "commit", "push", "verification"].map((phase) => [
          phase,
          percentiles(samples.map((sample) => sample.phases[phase])),
        ]),
      ),
      changedPaths: percentiles(samples.map((sample) => sample.paths)),
      changedBytes: percentiles(samples.map((sample) => sample.bytes)),
      gitProcesses: percentiles(samples.map((sample) => sample.gitProcesses)),
      gitActions: samples[0]?.gitActions ?? {},
      projectedItemsPerHour: Math.round((3_600_000 * size * 10) / totalP95) / 10,
    });
  }
  const candidate = bySize.find((entry) => entry.batchSize === 2);
  assert.ok(candidate);
  const realisticTreePassed = fixture.sourceTreePaths >= options.minimumSourcePaths;
  const rolloutFixturePassed =
    fixture.sourceHead === ROLLOUT_SOURCE_HEAD && fixture.sourceTreePaths === ROLLOUT_SOURCE_PATHS;
  return {
    source: options.stateSource,
    sourceRef: options.stateRef,
    sourceHead: fixture.sourceHead,
    sourceTreePaths: fixture.sourceTreePaths,
    minimumSourcePaths: options.minimumSourcePaths,
    realisticTreePassed,
    rolloutFixture: {
      expectedHead: ROLLOUT_SOURCE_HEAD,
      expectedPaths: ROLLOUT_SOURCE_PATHS,
      passed: rolloutFixturePassed,
    },
    writesIsolatedToTemporaryRemote: true,
    minimumItemsPerHour: options.minimumThroughput,
    sizes: bySize,
    productionCandidateBatchSize: 2,
    productionCandidateItemsPerHour: candidate.projectedItemsPerHour,
    passed: realisticTreePassed && candidate.projectedItemsPerHour >= options.minimumThroughput,
  };
}

function representativePayload(size, iteration, itemIndex) {
  const header = `# Synthetic exact-review record\n\nsize: ${size}\niteration: ${iteration}\nitem: ${itemIndex}\n\n`;
  return `${header}${"proof payload line\n".repeat(64)}`;
}

function phaseDelta(progress, startPhase, endPhase) {
  const start = progress.find((entry) => entry.phase === startPhase)?.at;
  const end = progress.find((entry) => entry.phase === endPhase)?.at;
  return start === undefined || end === undefined ? 0 : Math.max(0, end - start);
}

function tracePhases(tracePath) {
  const events = fs
    .readFileSync(tracePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const starts = new Map();
  const commands = [];
  for (const event of events) {
    if (event.event === "start" && event.argv?.[0] === "git") starts.set(event.sid, event);
    if (event.event !== "exit") continue;
    const start = starts.get(event.sid);
    if (!start) continue;
    commands.push({
      action: gitAction(start.argv),
      durationMs: Math.round(Number(event.t_abs) * 1000),
    });
  }
  const lsRemote = commands.filter((command) => command.action === "ls-remote");
  return {
    receipt: lsRemote[0]?.durationMs ?? 0,
    fetch: sumActions(commands, new Set(["fetch"])),
    tree: sumActions(
      commands,
      new Set(["rev-parse", "ls-tree", "read-tree", "update-index", "write-tree"]),
    ),
    commit: sumActions(commands, new Set(["commit-tree"])),
    push: sumActions(commands, new Set(["push"])),
    verification: lsRemote.at(-1)?.durationMs ?? 0,
  };
}

function gitAction(argv) {
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === "-c") {
      index += 1;
      continue;
    }
    if (!String(argv[index]).startsWith("-")) return argv[index];
  }
  return "command";
}

function sumActions(commands, actions) {
  return commands
    .filter((command) => actions.has(command.action))
    .reduce((sum, command) => sum + command.durationMs, 0);
}

function percentiles(values) {
  return { p50: percentile(values, 0.5), p95: percentile(values, 0.95) };
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(usage());
    return;
  }
  validateProofContract(parsed.options);
  const options = {
    ...parsed.options,
    // Performance work moves into a temp directory, so relative local sources
    // must be anchored before any Git subprocess changes its cwd.
    stateSource: resolveStateSource(parsed.options.stateSource),
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-batching-proof-"));
  try {
    const provider = process.env.CRABBOX_PROVIDER || null;
    const leaseId = process.env.CRABBOX_LEASE_ID || process.env.CRABBOX_ID || null;
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      mode: options.mode,
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        crabboxProvider: provider,
        crabboxLeaseId: leaseId,
      },
      ...(options.mode === "all" || options.mode === "e2e"
        ? { e2e: await runSyntheticE2e(root) }
        : {}),
      ...(options.mode === "all" || options.mode === "performance"
        ? { performance: runPerformanceProof(root, options) }
        : {}),
    };
    const proofPassed = (report.e2e?.passed ?? true) && (report.performance?.passed ?? true);
    const passed = proofPassed;
    const output = path.resolve(options.output);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(
      output,
      `${JSON.stringify(
        {
          ...report,
          runKind: options.diagnostic ? "diagnostic" : "full-proof",
          passed,
        },
        null,
        2,
      )}\n`,
    );
    process.stdout.write(
      `STATE_PUBLICATION_BATCHING_PROOF ${JSON.stringify({ output, passed })}\n`,
    );
    if (!passed) process.exitCode = 1;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

await main();
