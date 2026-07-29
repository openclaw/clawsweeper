#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  acceptClusterIntakeIntent,
  mergeClusterIntakeLedger,
  mergeClusterSelectorDecisionLedger,
  type ClusterIntakeIntent,
} from "./cluster-intake-state.js";
import {
  dispatchClusterIntakes,
  observeClusterDispatch,
  recoverPendingClusterIntakes,
  reserveClusterCapacity,
  type ClusterCapacity,
  type ClusterDispatchObserver,
} from "./cluster-intake-dispatch.js";
import { publishMainCommit, type GitPublishOptions, type PublishResult } from "./git-publish.js";
import { liveWorkerCapacity } from "./live-worker-capacity.js";

type PublishClusterRuntime = {
  env?: NodeJS.ProcessEnv;
  root?: string;
  publishGit?: (options: GitPublishOptions) => PublishResult;
  capacity?: ClusterCapacity;
  observe?: ClusterDispatchObserver;
};

const COMMIT_MESSAGE = "chore: publish durable cluster intake\n\n[skip ci]";

export async function publishClusterIntake(
  intentPath: string,
  options: PublishClusterRuntime = {},
): Promise<{ deduped: boolean; pending: boolean }> {
  const env = options.env ?? process.env;
  const root = options.root ?? process.cwd();
  const publishGit = options.publishGit ?? publishMainCommit;
  const intent = acceptClusterIntakeIntent(
    JSON.parse(readFileSync(intentPath, "utf8")),
    env.CLAWSWEEPER_WEBHOOK_SECRET ?? "",
  );
  const projection = projectClusterIntake(intent, root);
  publishGit({ message: COMMIT_MESSAGE, paths: projection.paths, rebaseStrategy: "normal" });

  const persistClaim = (ledgerPath: string): void => {
    publishGit({ message: COMMIT_MESSAGE, paths: [ledgerPath], rebaseStrategy: "normal" });
  };
  const dispatch = dispatchClusterIntakes(
    [intent],
    root,
    env,
    options.capacity ?? reserveClusterCapacity(liveWorkerCapacity),
    options.observe ?? observeClusterDispatch,
    persistClaim,
  );
  console.log(
    `durable cluster intake published: ${intent.jobs.length} job(s), pending=${dispatch.pending}`,
  );
  return { deduped: projection.deduped, pending: dispatch.pending };
}

export async function recoverClusterIntakes(options: PublishClusterRuntime = {}) {
  const env = options.env ?? process.env;
  const root = options.root ?? process.cwd();
  const publishGit = options.publishGit ?? publishMainCommit;
  const persist = (ledgerPath: string): void => {
    publishGit({ message: COMMIT_MESSAGE, paths: [ledgerPath], rebaseStrategy: "normal" });
  };
  const recovered = recoverPendingClusterIntakes(
    root,
    env,
    options.capacity ?? reserveClusterCapacity(liveWorkerCapacity),
    options.observe ?? observeClusterDispatch,
    persist,
  );
  if (recovered.updatedLedgers.length > 0) {
    publishGit({
      message: COMMIT_MESSAGE,
      paths: recovered.updatedLedgers,
      rebaseStrategy: "normal",
    });
  }
  console.log(
    `cluster intake recovery: updated=${recovered.updatedLedgers.length} pending=${recovered.pending}`,
  );
  return recovered;
}

function projectClusterIntake(
  intent: ClusterIntakeIntent,
  root: string,
): { paths: string[]; deduped: boolean } {
  const ledgerPath = clusterIntakeLedgerPath(intent);
  const currentLedger = readOptional(resolve(root, ledgerPath));
  const currentStores = currentLedger
    ? ((JSON.parse(currentLedger) as { stores?: Array<{ store_sha256?: string }> }).stores ?? [])
    : [];
  const deduped = currentStores.some((entry) => entry.store_sha256 === intent.store_sha256);
  const ledger = mergeClusterIntakeLedger(currentLedger, [intent]);
  writeText(resolve(root, ledgerPath), `${JSON.stringify(ledger, null, 2)}\n`);
  const paths = [ledgerPath];

  const selectorPath = clusterSelectorDecisionLedgerPath(intent);
  const selector = mergeClusterSelectorDecisionLedger(readOptional(resolve(root, selectorPath)), [
    intent,
  ]);
  if (selector) {
    writeText(resolve(root, selectorPath), `${JSON.stringify(selector, null, 2)}\n`);
    paths.push(selectorPath);
  }

  for (const job of intent.jobs) {
    const target = resolve(root, job.path);
    const current = readOptional(target);
    if (current !== undefined && current !== job.content) {
      throw new Error(`cluster intake job already has different content: ${job.path}`);
    }
    writeText(target, job.content);
    paths.push(job.path);
  }
  return { paths, deduped };
}

function clusterIntakeLedgerPath(intent: ClusterIntakeIntent): string {
  return `results/cluster-repair-intake/${intent.repo_slug}.json`;
}

function clusterSelectorDecisionLedgerPath(intent: ClusterIntakeIntent): string {
  return `results/cluster-repair-intake/${intent.repo_slug}.selector-decisions-v1.json`;
}

function readOptional(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function writeText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter((argument) => argument !== "--");
  if (args[0] === "--recover") {
    await recoverClusterIntakes().catch(fail);
  } else if (args[0]) {
    await publishClusterIntake(resolve(args[0])).catch(fail);
  } else {
    console.error("usage: publish-cluster-intake <intent.json> | --recover");
    process.exitCode = 2;
  }
}

function fail(error: unknown): void {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
