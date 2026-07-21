#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { formatStateRepoSizeGb, inspectStateRepoSize } from "./state-repo-size.js";

export type StateCompactionOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: Date;
};

export type StateCompactionPreflight = {
  compact: boolean;
  sizeGb: number;
  thresholdGb: number;
};

export type StateCompactionBackup = {
  backupRef: string;
  expectedHead: string;
};

function writeOutput(env: NodeJS.ProcessEnv, values: Record<string, string>): void {
  if (!env.GITHUB_OUTPUT) return;
  appendFileSync(
    env.GITHUB_OUTPUT,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
}

export async function runStateCompactionPreflight(
  options: StateCompactionOptions = {},
): Promise<StateCompactionPreflight> {
  const env = options.env ?? process.env;
  const size = await inspectStateRepoSize({
    env,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  const compact = size.aboveThreshold;
  const formattedSize = formatStateRepoSizeGb(size.sizeGb);
  console.log(`state-repo size: ${formattedSize}GB`);
  if (compact) {
    console.log(
      `state compaction: eligible above ${size.thresholdGb}GB threshold (${formattedSize}GB)`,
    );
  } else {
    console.log(
      `state compaction: skipped at ${formattedSize}GB (threshold ${size.thresholdGb}GB)`,
    );
  }
  writeOutput(env, {
    compact: String(compact),
    size_gb: formattedSize,
    threshold_gb: String(size.thresholdGb),
  });
  return { compact, sizeGb: size.sizeGb, thresholdGb: size.thresholdGb };
}

export async function createStateCompactionBackup(
  options: StateCompactionOptions = {},
): Promise<StateCompactionBackup> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? new Date();
  const repository = env.STATE_REPOSITORY ?? "openclaw/clawsweeper-state";
  const branch = env.STATE_COMPACTION_BRANCH ?? "main";
  const expectedHead = env.STATE_COMPACTION_EXPECTED_HEAD ?? "";
  const token = env.CLAWSWEEPER_STATE_REPO_TOKEN ?? "";
  const apiUrl = (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("state repository is invalid");
  }
  if (!/^[A-Za-z0-9_./-]+$/.test(branch)) throw new Error("compaction branch is invalid");
  if (!/^[0-9a-fA-F]{40}$/.test(expectedHead)) throw new Error("expected head is invalid");
  if (!token) throw new Error("state repository token is missing");

  const request = async (path: string, init: RequestInit = {}): Promise<Response> =>
    fetchImpl(`${apiUrl}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
        ...init.headers,
      },
    });

  const headResponse = await request(`/repos/${repository}/git/ref/heads/${branch}`);
  if (!headResponse.ok) throw new Error(`GET compaction head returned ${headResponse.status}`);
  const head = (await headResponse.json()) as { object?: { sha?: unknown } | null };
  const currentHead = typeof head.object?.sha === "string" ? head.object.sha : "";
  if (currentHead !== expectedHead) {
    throw new Error(`state head moved before backup creation: expected ${expectedHead}`);
  }

  const backupRef = `backup/pre-compact-${now.toISOString().slice(0, 10)}`;
  const existingResponse = await request(`/repos/${repository}/git/ref/heads/${backupRef}`);
  if (existingResponse.ok) {
    const existing = (await existingResponse.json()) as {
      ref?: unknown;
      object?: { sha?: unknown } | null;
    };
    if (existing.ref !== `refs/heads/${backupRef}` || existing.object?.sha !== expectedHead) {
      throw new Error("existing backup ref does not match the expected head");
    }
    console.log(`state compaction: reusing ${backupRef} at ${expectedHead}`);
    writeOutput(env, { backup_ref: backupRef, expected_head: expectedHead });
    return { backupRef, expectedHead };
  }
  if (existingResponse.status !== 404) {
    throw new Error(`GET backup ref returned ${existingResponse.status}`);
  }
  const backupResponse = await request(`/repos/${repository}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${backupRef}`, sha: expectedHead }),
  });
  if (!backupResponse.ok) {
    throw new Error(`POST backup ref returned ${backupResponse.status}`);
  }
  const backup = (await backupResponse.json()) as {
    ref?: unknown;
    object?: { sha?: unknown } | null;
  };
  if (backup.ref !== `refs/heads/${backupRef}` || backup.object?.sha !== expectedHead) {
    throw new Error("backup ref response did not confirm the expected head");
  }
  console.log(`state compaction: created ${backupRef} at ${expectedHead}`);
  writeOutput(env, { backup_ref: backupRef, expected_head: expectedHead });
  return { backupRef, expectedHead };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] ?? "preflight";
  try {
    if (command === "preflight") await runStateCompactionPreflight();
    else if (command === "prepare-backup") await createStateCompactionBackup();
    else throw new Error(`unknown state-compaction command: ${command}`);
  } catch (error) {
    console.error(
      `state compaction failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
