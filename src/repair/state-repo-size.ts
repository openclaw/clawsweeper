#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_STATE_REPOSITORY = "openclaw/clawsweeper-state";
export const DEFAULT_STATE_REPO_SIZE_WARN_GB = 5;

export type StateRepoSize = {
  repository: string;
  sizeKb: number;
  sizeGb: number;
  thresholdGb: number;
  aboveThreshold: boolean;
};

export type StateRepoSizeOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
};

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1_024 ? parsed : fallback;
}

function stateRepository(env: NodeJS.ProcessEnv): string {
  const repository = env.STATE_REPOSITORY ?? DEFAULT_STATE_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("state repository is invalid");
  }
  return repository;
}

function stateToken(env: NodeJS.ProcessEnv): string {
  const token = env.CLAWSWEEPER_STATE_REPO_TOKEN ?? "";
  if (!token) throw new Error("state repository token is missing");
  return token;
}

export function formatStateRepoSizeGb(sizeGb: number): string {
  return sizeGb.toFixed(2);
}

export async function inspectStateRepoSize(
  options: StateRepoSizeOptions = {},
): Promise<StateRepoSize> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const repository = stateRepository(env);
  const token = stateToken(env);
  const thresholdGb = positiveNumber(env.STATE_REPO_SIZE_WARN_GB, DEFAULT_STATE_REPO_SIZE_WARN_GB);
  const apiUrl = (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
  const response = await fetchImpl(`${apiUrl}/repos/${repository}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GET repository returned ${response.status}`);
  const payload = (await response.json()) as { size?: unknown };
  const sizeKb = payload.size;
  if (typeof sizeKb !== "number" || !Number.isFinite(sizeKb) || sizeKb < 0) {
    throw new Error("repository response has an invalid size");
  }
  const sizeGb = sizeKb / 1024 / 1024;
  return {
    repository,
    sizeKb,
    sizeGb,
    thresholdGb,
    aboveThreshold: sizeGb > thresholdGb,
  };
}

export async function runStateRepoSizeCheck(options: StateRepoSizeOptions = {}): Promise<{
  size: StateRepoSize | null;
  errors: number;
}> {
  try {
    const size = await inspectStateRepoSize(options);
    const formatted = formatStateRepoSizeGb(size.sizeGb);
    console.log(`state-repo size: ${formatted}GB`);
    if (size.aboveThreshold) {
      console.warn(
        `::warning::state-repo size: ${formatted}GB exceeds ${size.thresholdGb}GB threshold`,
      );
    }
    return { size, errors: 0 };
  } catch (error) {
    console.log("state-repo size: unavailable");
    console.warn(
      `state-repo size check skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { size: null, errors: 1 };
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  await runStateRepoSizeCheck();
}
