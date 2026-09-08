#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs as parseNodeArgs } from "node:util";

import { requiredCliValue } from "../src/clawsweeper-args.ts";
import { materializeStateBlobs } from "./worker-blobs.ts";
import {
  discoverWorkerRecordRepoSlugs,
  materializeWorkerItems,
  materializeWorkerRecords,
} from "./worker-records.ts";

const GIT_PATHS = [
  "jobs",
  "results",
  "notifications",
  "apply-report.json",
  "repair-apply-report.json",
] as const;

type Args = {
  stateDir?: string;
  worktree?: string;
  recordsUrl?: string;
  recordsRepoSlugs?: string[];
  recordsItemNumbers?: number[];
  hydrateStateBlobs?: boolean;
  hydrateGitState?: boolean;
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
  const hydrateStateBlobs = args.hydrateStateBlobs ?? true;
  const hydrateGitState = args.hydrateGitState ?? true;

  if (hydrateGitState) {
    hydrateGitOperationalState(stateRoot, worktreeRoot);
  }

  const baseUrl =
    args.recordsUrl ??
    env.CLAWSWEEPER_RECORDS_URL ??
    env.CLAWSWEEPER_STATE_COORDINATOR_URL ??
    "https://clawsweeper.openclaw.ai";
  const webhookSecret = env.CLAWSWEEPER_RECORDS_SECRET ?? env.CLAWSWEEPER_WEBHOOK_SECRET ?? "";
  if (!webhookSecret) {
    throw new Error("CLAWSWEEPER_RECORDS_SECRET is required for canonical state hydration");
  }

  const explicitRepoSlugs =
    args.recordsRepoSlugs ?? parseRepoSlugs(env.CLAWSWEEPER_RECORDS_REPO_SLUGS);
  if (args.recordsItemNumbers !== undefined && explicitRepoSlugs?.length !== 1) {
    throw new Error("Focused record hydration requires exactly one explicit repository slug");
  }
  const repoSlugs =
    explicitRepoSlugs ??
    (
      await discoverWorkerRecordRepoSlugs({
        baseUrl,
        webhookSecret,
        fetch: fetchImpl,
      })
    ).map((entry) => entry.repoSlug);
  if (!repoSlugs.length) throw new Error("canonical record store returned no repository slugs");

  const worker =
    args.recordsItemNumbers === undefined
      ? await materializeWorkerRecords({
          worktreeRoot,
          baseUrl,
          webhookSecret,
          repoSlugs,
          cacheRoot: env.CLAWSWEEPER_RECORDS_CACHE_DIR,
          fetch: fetchImpl,
        })
      : await materializeWorkerItems({
          worktreeRoot,
          baseUrl,
          webhookSecret,
          repoSlug: repoSlugs[0]!,
          itemNumbers: args.recordsItemNumbers,
          fetch: fetchImpl,
        });
  const blobs = hydrateStateBlobs
    ? await materializeStateBlobs({
        worktreeRoot,
        baseUrl,
        webhookSecret,
        cacheRoot: env.CLAWSWEEPER_BLOBS_CACHE_DIR,
        fetch: fetchImpl,
      })
    : undefined;

  const result = {
    hydrated: [
      ...(hydrateGitState ? GIT_PATHS : []),
      "records",
      ...(blobs ? ["ledger", "assets"] : []),
    ],
    recordsSource: "worker",
    ledgerSource: "worker",
    ...(hydrateGitState ? { source: stateRoot } : {}),
    target: worktreeRoot,
    worker: worker.repositories,
    manifest: worker.manifestPath,
    ...(blobs ? { blobs } : {}),
  };
  console.log(JSON.stringify(result));
  return result;
}

export function hydrateGitOperationalState(stateRoot: string, worktreeRoot: string): void {
  if (!existsSync(stateRoot)) throw new Error(`State directory does not exist: ${stateRoot}`);
  if (!GIT_PATHS.some((relativePath) => existsSync(path.join(stateRoot, relativePath)))) {
    throw new Error(
      `State directory has no operational paths: ${stateRoot}. Check out the generated state branch first.`,
    );
  }
  for (const relativePath of GIT_PATHS) copyGeneratedPath(stateRoot, worktreeRoot, relativePath);
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
  const normalized: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (
      [
        "--state-dir",
        "--worktree",
        "--records-url",
        "--records-item-number",
        "--records-repo-slugs",
      ].includes(arg)
    ) {
      normalized.push(`${arg}=${requiredCliValue(argv, ++index, arg)}`);
    } else if (arg === "--skip-state-blobs" || arg === "--skip-git-state") normalized.push(arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  const { values } = parseNodeArgs({
    args: normalized,
    options: {
      "state-dir": { type: "string" },
      worktree: { type: "string" },
      "records-url": { type: "string" },
      "skip-state-blobs": { type: "boolean" },
      "skip-git-state": { type: "boolean" },
      "records-item-number": { type: "string" },
      "records-repo-slugs": { type: "string" },
    },
  });
  const itemNumber = values["records-item-number"];
  const itemNumbers = itemNumber?.split(",").map((value) => {
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
      throw new Error("--records-item-number requires positive safe integers separated by commas");
    }
    return Number(value);
  });
  return {
    stateDir: values["state-dir"],
    worktree: values.worktree,
    recordsUrl: values["records-url"],
    hydrateStateBlobs: values["skip-state-blobs"] ? false : undefined,
    hydrateGitState: values["skip-git-state"] ? false : undefined,
    recordsItemNumbers: itemNumbers,
    ...(values["records-repo-slugs"] === undefined
      ? {}
      : { recordsRepoSlugs: parseRepoSlugs(values["records-repo-slugs"]) ?? [] }),
  };
}

function parseRepoSlugs(value: string | undefined) {
  if (value === undefined || value.trim() === "") return undefined;
  return [...new Set(value.split(/[\s,]+/).filter(Boolean))].sort();
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  await hydrateState(process.argv.slice(2));
}
