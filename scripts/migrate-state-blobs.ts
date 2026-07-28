#!/usr/bin/env node
/**
 * Cursor-resumable migration of the git state repo's `ledger/v1` and `assets`
 * trees into R2 through the Worker's `/internal/state/blobs/*` endpoints
 * (Cloudflare-canonical phase 3). Walks the state checkout, uploads files with
 * bounded concurrency (--concurrency, default 12) and digest verification, and
 * prints a JSON summary. Idempotent: a repeat run reports already-uploaded
 * files as unchanged, and a diverging immutable ledger key fails loudly with a
 * 409. Progress lines report a contiguous-prefix resume cursor that stays
 * valid under out-of-order completion.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  STATE_BLOB_TREES,
  downloadStateBlob,
  statStateBlob,
  uploadStateBlob,
} from "./worker-blobs.ts";
import { WorkerRecordRequestError } from "./worker-records.ts";

type MigrateArgs = {
  stateDir?: string;
  trees?: string[];
  recordsUrl?: string;
  cursor?: number;
  maxFiles?: number;
  verify?: "multipart" | "all";
  concurrency?: number;
};

export const MIGRATE_DEFAULT_CONCURRENCY = 12;
const MIGRATE_PRESSURE_MAX_ATTEMPTS = 6;
const MIGRATE_BACKOFF_BASE_MS = 500;
const MIGRATE_BACKOFF_MAX_MS = 30_000;

export async function migrateStateBlobs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
) {
  const args = parseArgs(argv);
  const stateRoot = path.resolve(args.stateDir ?? env.CLAWSWEEPER_STATE_DIR ?? "clawsweeper-state");
  if (!existsSync(stateRoot)) throw new Error(`State directory does not exist: ${stateRoot}`);
  const webhookSecret = env.CLAWSWEEPER_WEBHOOK_SECRET ?? "";
  if (!webhookSecret) throw new Error("CLAWSWEEPER_WEBHOOK_SECRET is required");
  const trees = args.trees ?? [...STATE_BLOB_TREES];
  for (const tree of trees) {
    if (!STATE_BLOB_TREES.includes(tree as (typeof STATE_BLOB_TREES)[number])) {
      throw new Error(`Unknown state blob tree: ${tree} (expected ${STATE_BLOB_TREES.join(", ")})`);
    }
  }
  const request = {
    baseUrl:
      args.recordsUrl ??
      env.CLAWSWEEPER_RECORDS_URL ??
      env.CLAWSWEEPER_STATE_COORDINATOR_URL ??
      "https://clawsweeper.openclaw.ai",
    webhookSecret,
    fetch: fetchImpl,
  };

  const files = trees.flatMap((tree) => collectTreeFiles(stateRoot, tree)).sort();
  const cursor = args.cursor ?? 0;
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > files.length) {
    throw new Error(`Invalid migration cursor: ${cursor}`);
  }
  const maxFiles = args.maxFiles ?? Number.POSITIVE_INFINITY;
  const selected = files.slice(
    cursor,
    maxFiles === Number.POSITIVE_INFINITY ? files.length : cursor + maxFiles,
  );
  const verifyMode = args.verify ?? "multipart";
  const concurrency = args.concurrency ?? MIGRATE_DEFAULT_CONCURRENCY;

  const summary = {
    trees,
    files: files.length,
    attempted: selected.length,
    uploaded: 0,
    unchanged: 0,
    verified: 0,
    bytesUploaded: 0,
    cursor,
    nextCursor: cursor + selected.length < files.length ? cursor + selected.length : null,
  };
  const verifyRoot = mkdtempSync(path.join(tmpdir(), "clawsweeper-blob-verify-"));
  try {
    const backoff = createAdaptiveBackoff(backoffBaseMs(env));
    // Per-file migration: read lazily (only in-flight files stay in memory),
    // digest-skip unchanged blobs, and re-download multipart uploads whose
    // digest is client-claimed. Counters are applied only after the file's
    // final successful attempt so a pressure retry never double-counts.
    const migrateFile = async (blobPath: string, index: number) => {
      const content = readFileSync(path.join(stateRoot, ...blobPath.split("/")));
      const digest = createHash("sha256").update(content).digest("hex");
      const attemptOnce = async (): Promise<{ uploaded: boolean; verified: boolean }> => {
        const existing = await statStateBlob({ ...request, blobPath });
        if (existing && existing.digest === digest && existing.bytes === content.byteLength) {
          return { uploaded: false, verified: false };
        }
        const uploaded = await uploadStateBlob({ ...request, blobPath, content });
        if (uploaded.unchanged) return { uploaded: false, verified: false };
        // Single-shot uploads are digest-verified by the Worker before the
        // object is written; multipart digests are client-claimed, so read
        // them back. --verify all forces read-back for every upload.
        if (uploaded.transport === "multipart" || verifyMode === "all") {
          const destination = path.join(verifyRoot, `verify-${index}`);
          const downloaded = await downloadStateBlob({
            ...request,
            blobPath,
            destination,
            expected: { bytes: content.byteLength, digest },
          });
          rmSync(destination, { force: true });
          if (downloaded.digest !== digest) {
            throw new Error(`Post-upload digest mismatch for ${blobPath}`);
          }
          return { uploaded: true, verified: true };
        }
        return { uploaded: true, verified: false };
      };
      // Adaptive pressure retry: the transport already retries transient 5xx
      // per request, so an escaping 429/5xx means sustained pressure. Pause
      // every worker (shared backoff) and retry the whole file — the stat
      // digest-skip makes a re-attempt after a partial success idempotent.
      for (let attempt = 1; ; attempt += 1) {
        await backoff.beforeAttempt();
        try {
          const outcome = await attemptOnce();
          backoff.recordSuccess();
          if (outcome.uploaded) {
            summary.uploaded += 1;
            summary.bytesUploaded += content.byteLength;
            if (outcome.verified) summary.verified += 1;
          } else {
            summary.unchanged += 1;
          }
          return;
        } catch (error) {
          if (!isPressureError(error) || attempt >= MIGRATE_PRESSURE_MAX_ATTEMPTS) throw error;
          backoff.recordPressure();
          console.error(
            `[state-blob-migration] pressure retry attempt=${attempt} path=${blobPath}`,
          );
        }
      }
    };

    const done = Array.from({ length: selected.length }, () => false);
    // `contiguous` counts the fully-completed prefix of `selected`: with
    // out-of-order completion under concurrency, only `cursor + contiguous`
    // is a safe resume cursor, so that is what the progress lines report.
    let contiguous = 0;
    let completedCount = 0;
    let nextIndex = 0;
    let firstError: unknown;
    const runWorker = async () => {
      while (firstError === undefined) {
        const index = nextIndex++;
        if (index >= selected.length) return;
        const blobPath = selected[index]!;
        try {
          await migrateFile(blobPath, index);
        } catch (error) {
          firstError ??= error;
          return;
        }
        done[index] = true;
        while (contiguous < selected.length && done[contiguous]) contiguous += 1;
        completedCount += 1;
        // Flushed per file so a cancelled run's log tail still names the last
        // safe resume cursor.
        console.error(
          `[state-blob-migration] file=${cursor + completedCount}/${files.length} resumeCursor=${cursor + contiguous} path=${blobPath}`,
        );
      }
    };
    const workerCount = Math.max(1, Math.min(concurrency, selected.length));
    await Promise.all(Array.from({ length: workerCount }, runWorker));
    if (firstError !== undefined) {
      console.error(
        `[state-blob-migration] aborting after failure; resume with --cursor ${cursor + contiguous}`,
      );
      throw firstError;
    }
  } finally {
    rmSync(verifyRoot, { force: true, recursive: true });
  }
  console.log(JSON.stringify(summary));
  return summary;
}

function isPressureError(error: unknown) {
  return error instanceof WorkerRecordRequestError && (error.status === 429 || error.status >= 500);
}

// Shared across every upload worker: one 429/5xx pauses the whole pool, and
// repeated pressure grows the pause exponentially (capped) until a request
// succeeds again.
function createAdaptiveBackoff(baseMs: number) {
  let level = 0;
  let pauseUntil = 0;
  return {
    async beforeAttempt() {
      for (;;) {
        const wait = pauseUntil - Date.now();
        if (wait <= 0) return;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    },
    recordSuccess() {
      level = 0;
    },
    recordPressure() {
      level += 1;
      const delay = Math.min(baseMs * 2 ** (level - 1), MIGRATE_BACKOFF_MAX_MS);
      pauseUntil = Math.max(pauseUntil, Date.now() + delay);
    },
  };
}

// Test seam: production runs use the default; tests shrink the base delay so
// pressure-retry coverage does not sleep for real.
function backoffBaseMs(env: NodeJS.ProcessEnv) {
  const raw = env.CLAWSWEEPER_MIGRATE_BACKOFF_BASE_MS;
  if (!raw) return MIGRATE_BACKOFF_BASE_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid CLAWSWEEPER_MIGRATE_BACKOFF_BASE_MS: ${raw}`);
  }
  return value;
}

function collectTreeFiles(stateRoot: string, tree: string): string[] {
  const root = path.join(stateRoot, ...tree.split("/"));
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const walk = (relative: string) => {
    for (const entry of readdirSync(path.join(stateRoot, ...relative.split("/")), {
      withFileTypes: true,
    })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) files.push(child);
      else throw new Error(`Unsupported state tree entry: ${child}`);
    }
  };
  walk(tree);
  return files;
}

function parseArgs(argv: string[]): MigrateArgs {
  const parsed: MigrateArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--state-dir") parsed.stateDir = requiredValue(argv, ++index, arg);
    else if (arg === "--trees") {
      parsed.trees = requiredValue(argv, ++index, arg)
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    } else if (arg === "--records-url") parsed.recordsUrl = requiredValue(argv, ++index, arg);
    else if (arg === "--cursor") parsed.cursor = nonNegativeInteger(argv, ++index, arg);
    else if (arg === "--max-files") parsed.maxFiles = positiveInteger(argv, ++index, arg);
    else if (arg === "--concurrency") parsed.concurrency = positiveInteger(argv, ++index, arg);
    else if (arg === "--verify") {
      const value = requiredValue(argv, ++index, arg);
      if (value !== "multipart" && value !== "all") {
        throw new Error("--verify must be multipart or all");
      }
      parsed.verify = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
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
  await migrateStateBlobs(process.argv.slice(2));
}
