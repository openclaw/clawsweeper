import { errorMessage } from "../value-coerce.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

import { resolveSpawnCommand } from "../command.js";
import type { LooseRecord } from "./json-types.js";
import {
  dispatchClaimDecision,
  hasSuccessfulDispatchExecutionJob,
} from "./comment-router-utils.js";
import { ghJson } from "./github-cli.js";
import { liveWorkerCapacity } from "./live-worker-capacity.js";
import { workerLimit } from "../limits.js";
import {
  clusterDispatchAuthenticationTag,
  clusterIntakeLedger,
  clusterWorkflowDispatchInputs,
  CLUSTER_INTAKE_LEDGER_SCHEMA,
  markClusterIntakeDispatchClaimed,
  markClusterIntakeDispatched,
  mergeClusterIntakeLedger,
  validateClusterJobContent,
  verifyClusterLedgerEntryAcceptedIntent,
  type ClusterIntakeIntent,
  type ClusterIntakeLedger,
  type ClusterLedgerEntry,
} from "./cluster-intake-state.js";

export type ClusterDispatchObservation = {
  action: "dispatch" | "wait" | "recover";
  run: LooseRecord | null;
};

export type ClusterDispatchObserver = (
  entry: ClusterLedgerEntry,
  env: NodeJS.ProcessEnv,
) => ClusterDispatchObservation;

export type ClusterCapacity = (options: Record<string, unknown>) => {
  active: number;
  max_live_workers: number;
};

export function reserveClusterCapacity(capacity: ClusterCapacity): ClusterCapacity {
  let reserved = 0;
  return (options) => {
    const snapshot = capacity(options);
    const maximum = Math.max(0, Math.floor(Number(snapshot.max_live_workers) || 0));
    const visibleActive = Math.max(0, Math.floor(Number(snapshot.active) || 0));
    const effectiveActive = Math.min(maximum, visibleActive + reserved);
    const requested = Math.max(0, Math.floor(Number(options.requested) || 0));
    reserved += Math.min(requested, Math.max(0, maximum - effectiveActive));
    return { active: effectiveActive, max_live_workers: maximum };
  };
}

export function dispatchClusterIntakes(
  intents: readonly ClusterIntakeIntent[],
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  capacity: ClusterCapacity = reserveClusterCapacity(liveWorkerCapacity),
  observe: ClusterDispatchObserver = observeClusterDispatch,
  persistClaim?: (ledgerPath: string) => void,
): { updatedLedgers: string[]; pending: boolean } {
  const updatedLedgers: string[] = [];
  let pending = false;
  const byRepository = new Map<string, ClusterIntakeIntent[]>();
  for (const intent of intents) {
    const values = byRepository.get(intent.target_repo) ?? [];
    values.push(intent);
    byRepository.set(intent.target_repo, values);
  }
  for (const repositoryIntents of byRepository.values()) {
    const ledgerPath = clusterIntakeLedgerPath(repositoryIntents[0]!);
    const ledger = mergeClusterIntakeLedger(
      readFileSync(resolve(root, ledgerPath), "utf8"),
      repositoryIntents,
    );
    const dispatch = dispatchClusterLedger(
      ledgerPath,
      ledger,
      root,
      env,
      capacity,
      observe,
      persistClaim,
      false,
    );
    if (dispatch.updated) updatedLedgers.push(ledgerPath);
    pending ||= dispatch.pending;
  }
  return { updatedLedgers, pending };
}

export function recoverPendingClusterIntakes(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  capacity: ClusterCapacity = reserveClusterCapacity(liveWorkerCapacity),
  observe: ClusterDispatchObserver = observeClusterDispatch,
  persistClaim?: (ledgerPath: string) => void,
): { updatedLedgers: string[]; pending: boolean } {
  const ledgerRoot = resolve(root, "results/cluster-repair-intake");
  if (!existsSync(ledgerRoot)) return { updatedLedgers: [], pending: false };
  const updatedLedgers: string[] = [];
  let pending = false;
  for (const name of readdirSync(ledgerRoot)
    .filter((entry) => entry.endsWith(".json") && !entry.includes("selector-decisions"))
    .sort()) {
    const ledgerPath = `results/cluster-repair-intake/${name}`;
    const parsed = JSON.parse(readFileSync(resolve(root, ledgerPath), "utf8")) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as { schema?: unknown }).schema !== CLUSTER_INTAKE_LEDGER_SCHEMA
    ) {
      continue;
    }
    let ledger: ClusterIntakeLedger;
    try {
      ledger = clusterIntakeLedger(parsed);
    } catch (error) {
      console.warn(
        `cluster intake recovery skipped unverifiable ledger ${ledgerPath}: ${errorMessage(error)}`,
      );
      continue;
    }
    const dispatch = dispatchClusterLedger(
      ledgerPath,
      ledger,
      root,
      env,
      capacity,
      observe,
      persistClaim,
      true,
    );
    if (dispatch.updated) updatedLedgers.push(ledgerPath);
    pending ||= dispatch.pending;
  }
  return { updatedLedgers, pending };
}

function dispatchClusterLedger(
  ledgerPath: string,
  ledger: ClusterIntakeLedger,
  root: string,
  env: NodeJS.ProcessEnv,
  capacity: ClusterCapacity,
  observe: ClusterDispatchObserver,
  persistClaim: ((ledgerPath: string) => void) | undefined,
  recoverUnclaimed: boolean,
): { updated: boolean; pending: boolean } {
  const repoSlug = ledger.target_repo.replace("/", "-");
  const dispatchSecret = env.CLAWSWEEPER_WEBHOOK_SECRET ?? "";
  const resolvedRoot = resolve(root);
  const unresolvedJobs = Object.values(ledger.clusters)
    .filter((entry) => entry.status !== "dispatched")
    .sort(
      (left, right) =>
        left.accepted_at.localeCompare(right.accepted_at) || left.cluster_id - right.cluster_id,
    )
    .map((entry) => {
      verifyClusterLedgerEntryAcceptedIntent(dispatchSecret, ledger.target_repo, entry);
      if (
        entry.dispatch_key !== `cluster-intake:${repoSlug}:${entry.cluster_id}` ||
        !/^[a-f0-9]{64}$/.test(entry.digest) ||
        !/^[A-Za-z0-9._-]{1,80}$/.test(entry.runner) ||
        !/^[A-Za-z0-9._-]{1,80}$/.test(entry.execution_runner) ||
        !/^[A-Za-z0-9._-]{1,80}$/.test(entry.model)
      ) {
        throw new Error(`invalid unresolved cluster dispatch metadata: ${entry.cluster_id}`);
      }
      const absoluteJob = resolve(root, entry.job);
      if (
        absoluteJob === resolvedRoot ||
        !absoluteJob.startsWith(`${resolvedRoot}${sep}`) ||
        !existsSync(absoluteJob)
      ) {
        throw new Error(`unresolved cluster job is missing or outside checkout: ${entry.job}`);
      }
      const content = readFileSync(absoluteJob, "utf8");
      if (createHash("sha256").update(content).digest("hex") !== entry.digest) {
        throw new Error(`unresolved cluster job digest mismatch: ${entry.job}`);
      }
      validateClusterJobContent(content, ledger.target_repo, entry.cluster_id);
      return {
        cluster_id: entry.cluster_id,
        path: entry.job,
        content,
        digest: entry.digest,
        dispatch_key: entry.dispatch_key,
        accepted_intent_digest: entry.accepted_intent_digest,
        accepted_intent_receipt: entry.accepted_intent_receipt,
        runner: entry.runner,
        execution_runner: entry.execution_runner,
        model: entry.model,
        ledgerEntry: entry,
      };
    });

  let pending = false;
  let ledgerUpdated = false;
  let workingLedger = ledger;
  const dispatchableJobs = [] as (typeof unresolvedJobs)[number][];
  for (const job of unresolvedJobs) {
    if (job.ledgerEntry.status === "dispatch_pending" && !recoverUnclaimed) {
      dispatchableJobs.push(job);
      continue;
    }
    const observationEntry =
      job.ledgerEntry.status === "dispatch_pending"
        ? { ...job.ledgerEntry, dispatch_claimed_at: job.ledgerEntry.accepted_at }
        : job.ledgerEntry;
    if (!observationEntry.dispatch_claimed_at) {
      throw new Error(`cluster dispatch claim has no timestamp: ${job.cluster_id}`);
    }
    const observation = observe(observationEntry, env);
    if (observation.action === "recover") {
      const runId = Number(observation.run?.id ?? observation.run?.databaseId ?? 0);
      workingLedger = markClusterIntakeDispatched(workingLedger, [job], new Date().toISOString(), {
        ...(Number.isSafeInteger(runId) && runId > 0 ? { id: runId } : {}),
        ...(observation.run?.url || observation.run?.html_url
          ? { url: String(observation.run.url ?? observation.run.html_url) }
          : {}),
      });
      ledgerUpdated = true;
      continue;
    }
    if (observation.action === "wait") {
      pending = true;
      continue;
    }
    dispatchableJobs.push(job);
  }

  let jobsToDispatch = dispatchableJobs;
  if (dispatchableJobs.length > 0) {
    const workerCapacity = capacity({
      repo: env.CLAWSWEEPER_REPO || "openclaw/clawsweeper",
      workflow: "repair-cluster-worker.yml",
      requested: dispatchableJobs.length,
      maxLiveWorkers: workerLimit("cluster_repair"),
      env,
    });
    const available = Math.max(0, workerCapacity.max_live_workers - workerCapacity.active);
    jobsToDispatch = dispatchableJobs.slice(0, available);
    pending ||= jobsToDispatch.length < dispatchableJobs.length;
  }
  if (jobsToDispatch.length > 0) {
    workingLedger = markClusterIntakeDispatchClaimed(
      workingLedger,
      jobsToDispatch,
      new Date().toISOString(),
    );
    ledgerUpdated = true;
    pending = true;
  }
  if (ledgerUpdated) {
    writeFileSync(resolve(root, ledgerPath), `${JSON.stringify(workingLedger, null, 2)}\n`, "utf8");
  }
  if (jobsToDispatch.length > 0) persistClaim?.(ledgerPath);

  for (const job of jobsToDispatch) {
    const jobAuthentication = clusterDispatchAuthenticationTag(dispatchSecret, {
      jobPath: job.path,
      jobDigest: job.digest,
      dispatchKey: job.dispatch_key,
      mode: "autonomous",
      runner: job.runner,
      executionRunner: job.execution_runner,
      plannerSandbox: "read-only",
      model: job.model,
      dryRun: "false",
    });
    const dispatchInputs = clusterWorkflowDispatchInputs(job, {
      runner: job.runner,
      executionRunner: job.execution_runner,
      model: job.model,
      jobAuth: jobAuthentication,
    });
    const invocation = resolveSpawnCommand(
      "gh",
      [
        "workflow",
        "run",
        "repair-cluster-worker.yml",
        "--repo",
        env.CLAWSWEEPER_REPO || "openclaw/clawsweeper",
        "--ref",
        env.CLAWSWEEPER_DISPATCH_REF || "main",
        ...Object.entries(dispatchInputs).flatMap(([key, value]) => ["-f", `${key}=${value}`]),
      ],
      { cwd: root, env },
    );
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: root,
      encoding: "utf8",
      env,
      stdio: "pipe",
      ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    if (result.status !== 0) {
      throw new Error(
        `cluster intake dispatch failed for ${ledger.target_repo} cluster ${job.cluster_id}: ${result.stderr || result.stdout || result.status}`,
      );
    }
  }
  return { updated: ledgerUpdated, pending };
}

export function observeClusterDispatch(
  entry: ClusterLedgerEntry,
  env: NodeJS.ProcessEnv,
): ClusterDispatchObservation {
  const repo = env.CLAWSWEEPER_REPO || "openclaw/clawsweeper";
  const expectedTitle = `repair cluster ${entry.job} [${entry.dispatch_key}]`;
  const runs = ghJson<LooseRecord[]>(
    [
      "run",
      "list",
      "--repo",
      repo,
      "--workflow",
      "repair-cluster-worker.yml",
      "--limit",
      "100",
      "--json",
      "databaseId,displayTitle,status,conclusion,createdAt,updatedAt,url",
    ],
    { env },
  ).map((run) => {
    if (
      String(run.displayTitle ?? run.display_title ?? "") !== expectedTitle ||
      String(run.status ?? "").toLowerCase() !== "completed"
    ) {
      return run;
    }
    const runId = Number(run.databaseId ?? run.id ?? 0);
    if (!Number.isSafeInteger(runId) || runId < 1) {
      return { ...run, dispatch_execution_verified: false };
    }
    const response = ghJson<LooseRecord>(
      ["api", `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`],
      { env },
    );
    const jobs = Array.isArray(response.jobs) ? response.jobs : [];
    return {
      ...run,
      dispatch_execution_verified: hasSuccessfulDispatchExecutionJob(
        jobs,
        "Plan and review cluster",
      ),
    };
  });
  return dispatchClaimDecision({
    claim: { processed_at: entry.dispatch_claimed_at },
    runs,
    expectedTitle,
  }) as ClusterDispatchObservation;
}

function clusterIntakeLedgerPath(intent: ClusterIntakeIntent): string {
  return `results/cluster-repair-intake/${intent.repo_slug}.json`;
}
