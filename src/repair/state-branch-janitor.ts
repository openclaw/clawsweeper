#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_STATE_REPOSITORY } from "./state-repo-size.js";

export const STATE_BRANCH_PREFIX = "clawsweeper/immutable-ledger/";
export const DEFAULT_STATE_BRANCH_MAX_AGE_HOURS = 24;
export const DEFAULT_STATE_BRANCH_MAX_DELETIONS = 50;

type GitReference = {
  ref?: unknown;
  object?: { sha?: unknown } | null;
};

export type StateBranchIdentity = {
  branch: string;
  runId: string;
  runAttempt: number;
};

export type StateBranchJanitorSummary = {
  scanned: number;
  deleted: number;
  kept: number;
  errors: number;
};

export type StateBranchJanitorOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: Date;
};

function boundedPositiveInteger(
  value: string | undefined,
  fallback: number,
  maximum: number,
): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

function boundedPositiveNumber(
  value: string | undefined,
  fallback: number,
  maximum: number,
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

function validRepository(value: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

export function parseStateBranchIdentity(ref: string): StateBranchIdentity | null {
  const match = new RegExp(
    `^refs/heads/${STATE_BRANCH_PREFIX.replaceAll("/", "\\/")}(\\d+)-(\\d+)-(\\d+)-([0-9a-fA-F]{7,64})$`,
  ).exec(ref);
  if (!match) return null;
  const runAttempt = Number(match[2]);
  if (!Number.isSafeInteger(runAttempt) || runAttempt < 1) return null;
  return {
    branch: ref.slice("refs/heads/".length),
    runId: match[1]!,
    runAttempt,
  };
}

function timestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function runStateBranchJanitor(
  options: StateBranchJanitorOptions = {},
): Promise<StateBranchJanitorSummary> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? new Date();
  const stateRepository = env.STATE_REPOSITORY ?? DEFAULT_STATE_REPOSITORY;
  const sourceRepository = env.STATE_BRANCH_RUN_REPOSITORY ?? env.GITHUB_REPOSITORY ?? "";
  const stateToken = env.CLAWSWEEPER_STATE_REPO_TOKEN ?? "";
  const sourceToken = env.GH_TOKEN ?? env.GITHUB_TOKEN ?? "";
  const apiUrl = (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
  const maximumAgeHours = boundedPositiveNumber(
    env.STATE_BRANCH_MAX_AGE_HOURS,
    DEFAULT_STATE_BRANCH_MAX_AGE_HOURS,
    24 * 365,
  );
  const maximumDeletions = boundedPositiveInteger(
    env.STATE_BRANCH_MAX_DELETIONS,
    DEFAULT_STATE_BRANCH_MAX_DELETIONS,
    500,
  );
  let scanned = 0;
  let deleted = 0;
  let kept = 0;
  let errors = 0;

  const summary = (): StateBranchJanitorSummary => {
    console.log(
      `state-branch janitor: scanned=${scanned} deleted=${deleted} kept=${kept} errors=${errors}`,
    );
    return { scanned, deleted, kept, errors };
  };

  if (
    !stateToken ||
    !sourceToken ||
    !validRepository(stateRepository) ||
    !validRepository(sourceRepository)
  ) {
    errors += 1;
    console.warn("state-branch janitor skipped: missing or invalid configuration");
    return summary();
  }

  const request = async (path: string, token: string, init: RequestInit = {}): Promise<Response> =>
    fetchImpl(`${apiUrl}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        ...init.headers,
      },
    });

  const references: GitReference[] = [];
  try {
    const prefix = STATE_BRANCH_PREFIX.slice(0, -1);
    const response = await request(
      `/repos/${stateRepository}/git/matching-refs/heads/${prefix}`,
      stateToken,
    );
    if (!response.ok) throw new Error(`GET matching refs returned ${response.status}`);
    const matchingReferences = (await response.json()) as unknown;
    if (!Array.isArray(matchingReferences)) {
      throw new Error("matching refs response is not an array");
    }
    references.push(...(matchingReferences as GitReference[]));
  } catch (error) {
    errors += 1;
    console.warn(
      `state-branch janitor discovery skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
    return summary();
  }

  scanned = references.length;
  const maximumAgeMs = maximumAgeHours * 60 * 60 * 1_000;

  for (const reference of references) {
    if (deleted >= maximumDeletions) {
      kept += 1;
      continue;
    }
    const ref = typeof reference.ref === "string" ? reference.ref : "";
    const identity = parseStateBranchIdentity(ref);
    const commitSha = typeof reference.object?.sha === "string" ? reference.object.sha : "";
    if (!identity || !/^[0-9a-fA-F]{40}$/.test(commitSha)) {
      kept += 1;
      continue;
    }

    let shouldDelete = false;
    let runCreatedAt: number | null = null;
    try {
      const response = await request(
        `/repos/${sourceRepository}/actions/runs/${identity.runId}`,
        sourceToken,
      );
      if (response.ok) {
        const run = (await response.json()) as {
          id?: unknown;
          status?: unknown;
          created_at?: unknown;
        };
        if (String(run.id ?? "") !== identity.runId) throw new Error("workflow run id mismatch");
        shouldDelete = run.status === "completed";
        runCreatedAt = timestamp(run.created_at);
      } else if (response.status !== 404) {
        throw new Error(`GET workflow run returned ${response.status}`);
      }
    } catch (error) {
      errors += 1;
      console.warn(
        `${identity.branch} workflow lookup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!shouldDelete && runCreatedAt !== null) {
      shouldDelete = now.getTime() - runCreatedAt >= maximumAgeMs;
    }
    if (!shouldDelete && runCreatedAt === null) {
      try {
        const response = await request(
          `/repos/${stateRepository}/git/commits/${commitSha}`,
          stateToken,
        );
        if (!response.ok) throw new Error(`GET branch commit returned ${response.status}`);
        const commit = (await response.json()) as {
          committer?: { date?: unknown } | null;
          author?: { date?: unknown } | null;
        };
        const committedAt = timestamp(commit.committer?.date) ?? timestamp(commit.author?.date);
        if (committedAt === null) throw new Error("branch commit has no valid timestamp");
        shouldDelete = now.getTime() - committedAt >= maximumAgeMs;
      } catch (error) {
        errors += 1;
        console.warn(
          `${identity.branch} age lookup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (!shouldDelete) {
      kept += 1;
      continue;
    }
    try {
      const response = await request(
        `/repos/${stateRepository}/git/refs/heads/${identity.branch}`,
        stateToken,
        { method: "DELETE" },
      );
      if (!response.ok) throw new Error(`DELETE branch returned ${response.status}`);
      deleted += 1;
      console.log(`state-branch janitor: deleted ${identity.branch}`);
    } catch (error) {
      errors += 1;
      kept += 1;
      console.warn(
        `${identity.branch} deletion failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return summary();
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  await runStateBranchJanitor().catch((error) => {
    console.warn(
      `state-branch janitor skipped after unexpected error: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.log("state-branch janitor: scanned=0 deleted=0 kept=0 errors=1");
  });
}
