#!/usr/bin/env node
import { appendFileSync } from "node:fs";

import {
  discoverWorkerRecordRepoSlugs,
  resolveWorkerSnapshotCacheKey,
  WorkerSnapshotUnavailableError,
} from "./worker-records.ts";

const repoSlugs = parseRepoSlugs(process.env.CLAWSWEEPER_RECORDS_REPO_SLUGS);
const baseUrl = process.env.CLAWSWEEPER_RECORDS_URL ?? "https://clawsweeper.openclaw.ai";
const webhookSecret =
  process.env.CLAWSWEEPER_RECORDS_SECRET ?? process.env.CLAWSWEEPER_WEBHOOK_SECRET ?? "";
if (!webhookSecret) throw new Error("CLAWSWEEPER_RECORDS_SECRET is required");

try {
  // Match hydrate-state discovery: the Worker record store is the slug
  // authority (the worker-mode sparse checkout has no records/ tree to read).
  const resolvedRepoSlugs = repoSlugs.length
    ? repoSlugs
    : (await discoverWorkerRecordRepoSlugs({ baseUrl, webhookSecret })).map(
        (entry) => entry.repoSlug,
      );
  if (!resolvedRepoSlugs.length) throw new WorkerSnapshotUnavailableError("snapshot_not_found");
  const result = await resolveWorkerSnapshotCacheKey({
    baseUrl,
    webhookSecret,
    repoSlugs: resolvedRepoSlugs,
  });
  if (result.coldSlugs.length) {
    console.error(
      `[worker-record-cache] ${result.coldSlugs.length} cold slug(s) have no stored snapshot and are excluded from the cache key (hydration replays their journal from revision 0): ${result.coldSlugs.join(", ")}`,
    );
  }
  writeOutput("available", "true");
  writeOutput("cache-key", result.key);
  console.log(
    JSON.stringify({ available: true, pairs: result.pairs, coldSlugs: result.coldSlugs }),
  );
} catch (error) {
  if (!(error instanceof WorkerSnapshotUnavailableError)) throw error;
  writeOutput("available", "false");
  writeOutput("cache-key", "snapshot-unavailable");
  console.error(
    `[worker-record-cache] SNAPSHOT CACHE UNAVAILABLE (${error.reason}${error.detailText ? `: ${error.detailText}` : ""}); HYDRATION WILL REPLAY THE CANONICAL JOURNAL`,
  );
}

function parseRepoSlugs(value: string | undefined) {
  return [...new Set((value ?? "").split(/[\s,]+/).filter(Boolean))].sort();
}

function writeOutput(name: string, value: string) {
  const output = process.env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, `${name}=${value}\n`, "utf8");
}
