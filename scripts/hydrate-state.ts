#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  discoverRecordRepoSlugs,
  materializeWorkerRecords,
  WorkerSnapshotUnavailableError,
} from "./worker-records.ts";

const GENERATED_PATHS = [
  "records",
  "jobs",
  "results",
  "ledger",
  "notifications",
  "assets",
  "apply-report.json",
  "repair-apply-report.json",
] as const;
const NON_RECORD_PATHS = GENERATED_PATHS.filter((relativePath) => relativePath !== "records");

type Args = {
  stateDir?: string;
  worktree?: string;
  recordsSource?: "git" | "worker";
  recordsUrl?: string;
  recordsRepoSlugs?: string[];
};

export async function hydrateState(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
) {
  const args = parseArgs(argv);
  const stateRoot = path.resolve(
    args.stateDir ?? env.CLAWSWEEPER_STATE_DIR ?? "../clawsweeper-state",
  );
  const worktreeRoot = path.resolve(args.worktree ?? process.cwd());
  const recordsSource = args.recordsSource ?? parseRecordsSource(env.CLAWSWEEPER_RECORDS_SOURCE);

  if (!existsSync(stateRoot)) throw new Error(`State directory does not exist: ${stateRoot}`);
  if (!GENERATED_PATHS.some((relativePath) => existsSync(path.join(stateRoot, relativePath)))) {
    throw new Error(
      `State directory has no generated paths: ${stateRoot}. Check out the generated state branch first, for example: git -C ${stateRoot} switch state`,
    );
  }

  const gitPaths = recordsSource === "git" ? GENERATED_PATHS : NON_RECORD_PATHS;
  for (const relativePath of gitPaths) copyGeneratedPath(stateRoot, worktreeRoot, relativePath);

  let worker: Awaited<ReturnType<typeof materializeWorkerRecords>> | undefined;
  let recordsFallback: { reason: string; source: "git" } | undefined;
  if (recordsSource === "worker") {
    const repoSlugs =
      args.recordsRepoSlugs ??
      parseRepoSlugs(env.CLAWSWEEPER_RECORDS_REPO_SLUGS) ??
      discoverRecordRepoSlugs(stateRoot);
    const webhookSecret = env.CLAWSWEEPER_RECORDS_SECRET ?? env.CLAWSWEEPER_WEBHOOK_SECRET ?? "";
    if (repoSlugs.length && !webhookSecret) {
      throw new Error("CLAWSWEEPER_RECORDS_SECRET is required for Worker record hydration");
    }
    try {
      if (!repoSlugs.length) throw new WorkerSnapshotUnavailableError("snapshot_not_found");
      worker = await materializeWorkerRecords({
        worktreeRoot,
        baseUrl:
          args.recordsUrl ??
          env.CLAWSWEEPER_RECORDS_URL ??
          env.CLAWSWEEPER_STATE_COORDINATOR_URL ??
          "https://clawsweeper.openclaw.ai",
        webhookSecret: webhookSecret || "unused-empty-snapshot",
        repoSlugs,
        cacheRoot: env.CLAWSWEEPER_RECORDS_CACHE_DIR,
        fetch: fetchImpl,
      });
    } catch (error) {
      if (!(error instanceof WorkerSnapshotUnavailableError)) throw error;
      const sourceRecords = path.join(stateRoot, "records");
      if (!existsSync(sourceRecords)) {
        throw new Error(
          `Worker record cutover refused (${error.reason}), and git fallback records are unavailable at ${sourceRecords}`,
          { cause: error },
        );
      }
      console.error(
        `[hydrate-state] WORKER RECORD CUTOVER REFUSED: ${error.message.toUpperCase()}; FALLING BACK TO GIT RECORDS`,
      );
      copyGeneratedPath(stateRoot, worktreeRoot, "records");
      recordsFallback = { reason: error.reason, source: "git" };
    }
  }

  const result = {
    hydrated: worker || recordsFallback ? [...gitPaths, "records"] : [...gitPaths],
    recordsSource: recordsFallback?.source ?? recordsSource,
    ...(recordsFallback ? { requestedRecordsSource: recordsSource, recordsFallback } : {}),
    source: stateRoot,
    target: worktreeRoot,
    ...(worker ? { worker: worker.repositories, manifest: worker.manifestPath } : {}),
  };
  console.log(JSON.stringify(result));
  return result;
}

function copyGeneratedPath(stateRoot: string, worktreeRoot: string, relativePath: string) {
  const source = path.join(stateRoot, relativePath);
  const destination = path.join(worktreeRoot, relativePath);
  rmSync(destination, { force: true, recursive: true });
  if (!existsSync(source)) return;
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
}

function parseArgs(argv: string[]): Args {
  const parsed: Args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--state-dir") parsed.stateDir = requiredValue(argv, ++index, arg);
    else if (arg === "--worktree") parsed.worktree = requiredValue(argv, ++index, arg);
    else if (arg === "--records-source") {
      parsed.recordsSource = parseRecordsSource(requiredValue(argv, ++index, arg));
    } else if (arg === "--records-url") parsed.recordsUrl = requiredValue(argv, ++index, arg);
    else if (arg === "--records-repo-slugs") {
      parsed.recordsRepoSlugs = parseRepoSlugs(requiredValue(argv, ++index, arg)) ?? [];
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function parseRecordsSource(value: string | undefined): "git" | "worker" {
  const source = value?.trim() || "git";
  if (source !== "git" && source !== "worker") {
    throw new Error(`CLAWSWEEPER_RECORDS_SOURCE must be git or worker, received: ${source}`);
  }
  return source;
}

function parseRepoSlugs(value: string | undefined) {
  if (value === undefined) return undefined;
  return [...new Set(value.split(/[\s,]+/).filter(Boolean))].sort();
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  await hydrateState(process.argv.slice(2));
}
