#!/usr/bin/env node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { hydrateState } from "./hydrate-state.ts";
import { recordTreeDigests } from "./worker-records.ts";

export async function verifyWorkerRecordParity(
  options: {
    stateRoot: string;
    repoSlug: string;
    recordsUrl: string;
    webhookSecret: string;
  },
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
) {
  const scratch = mkdtempSync(path.join(tmpdir(), "clawsweeper-record-parity-"));
  const gitRoot = path.join(scratch, "git");
  const workerRoot = path.join(scratch, "worker");
  try {
    await hydrateState(
      ["--state-dir", options.stateRoot, "--worktree", gitRoot, "--records-source", "git"],
      {},
      fetchImpl,
    );
    await hydrateState(
      [
        "--state-dir",
        options.stateRoot,
        "--worktree",
        workerRoot,
        "--records-source",
        "worker",
        "--records-url",
        options.recordsUrl,
        "--records-repo-slugs",
        options.repoSlug,
      ],
      { CLAWSWEEPER_WEBHOOK_SECRET: options.webhookSecret },
      fetchImpl,
    );
    const git = recordTreeDigests(gitRoot, options.repoSlug);
    const worker = recordTreeDigests(workerRoot, options.repoSlug);
    const paths = [...new Set([...git.keys(), ...worker.keys()])].sort();
    const mismatches = paths.flatMap((recordPath) => {
      const gitDigest = git.get(recordPath) ?? null;
      const workerDigest = worker.get(recordPath) ?? null;
      return gitDigest === workerDigest ? [] : [{ path: recordPath, gitDigest, workerDigest }];
    });
    return {
      repoSlug: options.repoSlug,
      gitRecords: git.size,
      workerRecords: worker.size,
      mismatches,
    };
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const webhookSecret = process.env.CLAWSWEEPER_WEBHOOK_SECRET ?? "";
  if (!webhookSecret) throw new Error("CLAWSWEEPER_WEBHOOK_SECRET is required");
  const result = await verifyWorkerRecordParity({
    stateRoot: path.resolve(
      args.stateDir ?? process.env.CLAWSWEEPER_STATE_DIR ?? "clawsweeper-state",
    ),
    repoSlug: required(args.repoSlug, "--repo-slug"),
    recordsUrl:
      args.recordsUrl ?? process.env.CLAWSWEEPER_RECORDS_URL ?? "https://clawsweeper.openclaw.ai",
    webhookSecret,
  });
  console.log(JSON.stringify(result));
  if (result.mismatches.length) process.exitCode = 1;
}

function parseArgs(argv: string[]) {
  const result: { stateDir?: string; repoSlug?: string; recordsUrl?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--state-dir") result.stateDir = requiredValue(argv, ++index, arg);
    else if (arg === "--repo-slug") result.repoSlug = requiredValue(argv, ++index, arg);
    else if (arg === "--records-url") result.recordsUrl = requiredValue(argv, ++index, arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function requiredValue(argv: string[], index: number, flag: string) {
  return required(argv[index], `${flag} value`);
}

function required(value: string | undefined, label: string) {
  if (!value || value.startsWith("--")) throw new Error(`${label} is required`);
  return value;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
