#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { materializeStateBlobs, WorkerBlobsUnavailableError } from "./worker-blobs.ts";
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
// The ledger/assets trees ride the blob transport together: both are plain
// file trees served from R2 under the ledger/v1/... and assets/... prefixes.
const BLOB_PATHS = ["ledger", "assets"] as const;

type Args = {
  stateDir?: string;
  worktree?: string;
  recordsSource?: "git" | "worker";
  ledgerSource?: "git" | "worker";
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
  const ledgerSource =
    args.ledgerSource ?? parseSource(env.CLAWSWEEPER_LEDGER_SOURCE, "CLAWSWEEPER_LEDGER_SOURCE");

  if (!existsSync(stateRoot)) throw new Error(`State directory does not exist: ${stateRoot}`);
  if (!GENERATED_PATHS.some((relativePath) => existsSync(path.join(stateRoot, relativePath)))) {
    throw new Error(
      `State directory has no generated paths: ${stateRoot}. Check out the generated state branch first, for example: git -C ${stateRoot} switch state`,
    );
  }

  const gitPaths = GENERATED_PATHS.filter(
    (relativePath) =>
      (recordsSource === "git" || relativePath !== "records") &&
      (ledgerSource === "git" || !BLOB_PATHS.includes(relativePath as "ledger" | "assets")),
  );
  for (const relativePath of gitPaths) copyGeneratedPath(stateRoot, worktreeRoot, relativePath);

  const baseUrl =
    args.recordsUrl ??
    env.CLAWSWEEPER_RECORDS_URL ??
    env.CLAWSWEEPER_STATE_COORDINATOR_URL ??
    "https://clawsweeper.openclaw.ai";
  const webhookSecret = env.CLAWSWEEPER_RECORDS_SECRET ?? env.CLAWSWEEPER_WEBHOOK_SECRET ?? "";

  let blobs: Awaited<ReturnType<typeof materializeStateBlobs>> | undefined;
  let ledgerFallback: { reason: string; source: "git" } | undefined;
  if (ledgerSource === "worker") {
    if (!webhookSecret) {
      throw new Error("CLAWSWEEPER_RECORDS_SECRET is required for Worker ledger hydration");
    }
    try {
      blobs = await materializeStateBlobs({
        worktreeRoot,
        baseUrl,
        webhookSecret,
        cacheRoot: env.CLAWSWEEPER_BLOBS_CACHE_DIR,
        fetch: fetchImpl,
      });
    } catch (error) {
      if (!(error instanceof WorkerBlobsUnavailableError)) throw error;
      console.error(
        `[hydrate-state] WORKER LEDGER CUTOVER REFUSED: ${error.message.toUpperCase()}; FALLING BACK TO GIT LEDGER/ASSETS`,
      );
      for (const relativePath of BLOB_PATHS) {
        copyGeneratedPath(stateRoot, worktreeRoot, relativePath);
      }
      ledgerFallback = { reason: error.reason, source: "git" };
    }
  }

  let worker: Awaited<ReturnType<typeof materializeWorkerRecords>> | undefined;
  let recordsFallback:
    | {
        reason: string;
        source: "git";
        slug?: string;
        detail?: {
          endpoint?: string;
          status?: number;
          code?: string;
          bodySnippet?: string;
          succeededSlugs?: number;
        };
      }
    | undefined;
  if (recordsSource === "worker") {
    const repoSlugs =
      args.recordsRepoSlugs ??
      parseRepoSlugs(env.CLAWSWEEPER_RECORDS_REPO_SLUGS) ??
      discoverRecordRepoSlugs(stateRoot);
    if (repoSlugs.length && !webhookSecret) {
      throw new Error("CLAWSWEEPER_RECORDS_SECRET is required for Worker record hydration");
    }
    try {
      if (!repoSlugs.length) {
        throw new WorkerSnapshotUnavailableError("snapshot_not_found", {
          code: "no_record_repo_slugs",
        });
      }
      worker = await materializeWorkerRecords({
        worktreeRoot,
        baseUrl,
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
      // Keep the reason shout-case for greppability, but append the request
      // evidence verbatim: slug, endpoint, HTTP status, error code, body.
      const reasonText =
        error.reason === "snapshot_store_unavailable"
          ? "SNAPSHOT STORE UNAVAILABLE"
          : "SNAPSHOT NOT FOUND";
      console.error(
        `[hydrate-state] WORKER RECORD CUTOVER REFUSED: ${reasonText}${error.detailText ? ` (${error.detailText})` : ""}; FALLING BACK TO GIT RECORDS`,
      );
      copyGeneratedPath(stateRoot, worktreeRoot, "records");
      const { repoSlug: failedSlug, ...detail } = error.detail;
      recordsFallback = {
        reason: error.reason,
        source: "git",
        ...(failedSlug ? { slug: failedSlug } : {}),
        ...(Object.keys(detail).length ? { detail } : {}),
      };
    }
  }

  const result = {
    hydrated: [
      ...gitPaths,
      ...(worker || recordsFallback ? ["records"] : []),
      ...(blobs || ledgerFallback ? BLOB_PATHS : []),
    ],
    recordsSource: recordsFallback?.source ?? recordsSource,
    ...(recordsFallback ? { requestedRecordsSource: recordsSource, recordsFallback } : {}),
    ledgerSource: ledgerFallback?.source ?? ledgerSource,
    ...(ledgerFallback ? { requestedLedgerSource: ledgerSource, ledgerFallback } : {}),
    source: stateRoot,
    target: worktreeRoot,
    ...(worker ? { worker: worker.repositories, manifest: worker.manifestPath } : {}),
    ...(blobs ? { blobs } : {}),
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
    } else if (arg === "--ledger-source") {
      parsed.ledgerSource = parseSource(requiredValue(argv, ++index, arg), arg);
    } else if (arg === "--records-url") parsed.recordsUrl = requiredValue(argv, ++index, arg);
    else if (arg === "--records-repo-slugs") {
      parsed.recordsRepoSlugs = parseRepoSlugs(requiredValue(argv, ++index, arg)) ?? [];
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function parseRecordsSource(value: string | undefined): "git" | "worker" {
  return parseSource(value, "CLAWSWEEPER_RECORDS_SOURCE");
}

function parseSource(value: string | undefined, label: string): "git" | "worker" {
  const source = value?.trim() || "git";
  if (source !== "git" && source !== "worker") {
    throw new Error(`${label} must be git or worker, received: ${source}`);
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
