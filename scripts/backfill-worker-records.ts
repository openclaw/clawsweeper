#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ingestGitRecords, replayWorkerRecordProjections } from "./worker-records.ts";

export async function backfillWorkerRecords(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
) {
  const args = parseArgs(argv);
  const repoSlug = args.repoSlug ?? env.CLAWSWEEPER_RECORDS_REPO_SLUG;
  if (!repoSlug) throw new Error("--repo-slug is required");
  const webhookSecret = env.CLAWSWEEPER_WEBHOOK_SECRET ?? "";
  if (!webhookSecret) throw new Error("CLAWSWEEPER_WEBHOOK_SECRET is required");
  const result = await ingestGitRecords({
    stateRoot: path.resolve(args.stateDir ?? env.CLAWSWEEPER_STATE_DIR ?? "clawsweeper-state"),
    repoSlug,
    baseUrl:
      args.recordsUrl ??
      env.CLAWSWEEPER_RECORDS_URL ??
      env.CLAWSWEEPER_STATE_COORDINATOR_URL ??
      "https://clawsweeper.openclaw.ai",
    webhookSecret,
    fetch: fetchImpl,
    cursor: args.cursor,
    maxBatches: args.maxBatches,
    onBatch: ({ completedCursor, totalBatches }) => {
      console.error(
        `[worker-record-backfill] cursor=${completedCursor}/${totalBatches} repo=${repoSlug}`,
      );
    },
  });
  let replay: Awaited<ReturnType<typeof replayWorkerRecordProjections>> | null = null;
  if (args.replayProjections) {
    if (result.nextCursor !== null) {
      throw new Error("Projection replay requires the git backfill to reach its final cursor");
    }
    replay = await replayWorkerRecordProjections({
      repoSlug,
      baseUrl:
        args.recordsUrl ??
        env.CLAWSWEEPER_RECORDS_URL ??
        env.CLAWSWEEPER_STATE_COORDINATOR_URL ??
        "https://clawsweeper.openclaw.ai",
      webhookSecret,
      fetch: fetchImpl,
      ...(args.replayItemIds?.length ? { itemIds: args.replayItemIds } : {}),
      ...(args.maxReplayTuples ? { maxTuples: args.maxReplayTuples } : {}),
      ...(args.replayCursor !== undefined ? { cursor: args.replayCursor } : {}),
      onTuple: ({ completed, total, itemId }) => {
        console.error(
          `[worker-record-replay] tuple=${completed}/${total} repo=${repoSlug} item=${itemId}`,
        );
      },
    });
  }
  console.log(JSON.stringify({ repoSlug, ...result, replay }));
  return { ...result, replay };
}

function parseArgs(argv: string[]) {
  const result: {
    stateDir?: string;
    repoSlug?: string;
    recordsUrl?: string;
    cursor?: number;
    maxBatches?: number;
    replayProjections?: boolean;
    replayItemIds?: string[];
    maxReplayTuples?: number;
    replayCursor?: number;
  } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--state-dir") result.stateDir = requiredValue(argv, ++index, arg);
    else if (arg === "--repo-slug") result.repoSlug = requiredValue(argv, ++index, arg);
    else if (arg === "--records-url") result.recordsUrl = requiredValue(argv, ++index, arg);
    else if (arg === "--cursor") result.cursor = nonNegativeInteger(argv, ++index, arg);
    else if (arg === "--max-batches") result.maxBatches = positiveInteger(argv, ++index, arg);
    else if (arg === "--replay-projections") result.replayProjections = true;
    else if (arg === "--replay-item-ids")
      result.replayItemIds = requiredValue(argv, ++index, arg)
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    else if (arg === "--max-replay-tuples")
      result.maxReplayTuples = positiveInteger(argv, ++index, arg);
    else if (arg === "--replay-cursor")
      result.replayCursor = nonNegativeInteger(argv, ++index, arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function nonNegativeInteger(argv: string[], index: number, flag: string) {
  const value = Number(requiredValue(argv, index, flag));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${flag} must be at least 0`);
  return value;
}

function positiveInteger(argv: string[], index: number, flag: string) {
  const value = Number(requiredValue(argv, index, flag));
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${flag} must be at least 1`);
  return value;
}

function requiredValue(argv: string[], index: number, flag: string) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  await backfillWorkerRecords(process.argv.slice(2));
}
