#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import path from "node:path";

import {
  discoverRecordRepoSlugs,
  resolveWorkerSnapshotCacheKey,
  WorkerSnapshotUnavailableError,
} from "./worker-records.ts";

const stateRoot = path.resolve(process.env.CLAWSWEEPER_STATE_DIR ?? "clawsweeper-state");
const repoSlugs = parseRepoSlugs(process.env.CLAWSWEEPER_RECORDS_REPO_SLUGS);
const resolvedRepoSlugs = repoSlugs.length ? repoSlugs : discoverRecordRepoSlugs(stateRoot);
const webhookSecret =
  process.env.CLAWSWEEPER_RECORDS_SECRET ?? process.env.CLAWSWEEPER_WEBHOOK_SECRET ?? "";
if (!webhookSecret) throw new Error("CLAWSWEEPER_RECORDS_SECRET is required");

try {
  if (!resolvedRepoSlugs.length) throw new WorkerSnapshotUnavailableError("snapshot_not_found");
  const result = await resolveWorkerSnapshotCacheKey({
    baseUrl: process.env.CLAWSWEEPER_RECORDS_URL ?? "https://clawsweeper.openclaw.ai",
    webhookSecret,
    repoSlugs: resolvedRepoSlugs,
  });
  writeOutput("available", "true");
  writeOutput("cache-key", result.key);
  console.log(JSON.stringify({ available: true, pairs: result.pairs }));
} catch (error) {
  if (!(error instanceof WorkerSnapshotUnavailableError)) throw error;
  writeOutput("available", "false");
  writeOutput("cache-key", "snapshot-unavailable");
  console.error(
    `[worker-record-cache] SNAPSHOT CACHE UNAVAILABLE (${error.reason}); HYDRATION WILL FALL BACK TO GIT`,
  );
}

function parseRepoSlugs(value: string | undefined) {
  return [...new Set((value ?? "").split(/[\s,]+/).filter(Boolean))].sort();
}

function writeOutput(name: string, value: string) {
  const output = process.env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, `${name}=${value}\n`, "utf8");
}
