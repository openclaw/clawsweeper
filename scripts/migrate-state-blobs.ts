#!/usr/bin/env node
/**
 * Cursor-resumable migration of the git state repo's `ledger/v1` and `assets`
 * trees into R2 through the Worker's `/internal/state/blobs/*` endpoints
 * (Cloudflare-canonical phase 3). Walks the state checkout, uploads every file
 * with digest verification, and prints a JSON summary. Idempotent: a repeat run
 * reports already-uploaded files as unchanged, and a diverging immutable
 * ledger key fails loudly with a 409.
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

type MigrateArgs = {
  stateDir?: string;
  trees?: string[];
  recordsUrl?: string;
  cursor?: number;
  maxFiles?: number;
  verify?: "multipart" | "all";
};

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
    let completed = cursor;
    for (const blobPath of selected) {
      const content = readFileSync(path.join(stateRoot, ...blobPath.split("/")));
      const digest = createHash("sha256").update(content).digest("hex");
      const existing = await statStateBlob({ ...request, blobPath });
      if (existing && existing.digest === digest && existing.bytes === content.byteLength) {
        summary.unchanged += 1;
      } else {
        const uploaded = await uploadStateBlob({ ...request, blobPath, content });
        if (uploaded.unchanged) {
          summary.unchanged += 1;
        } else {
          summary.uploaded += 1;
          summary.bytesUploaded += content.byteLength;
        }
        // Single-shot uploads are digest-verified by the Worker before the
        // object is written; multipart digests are client-claimed, so read
        // them back. --verify all forces read-back for every upload.
        if (!uploaded.unchanged && (uploaded.transport === "multipart" || verifyMode === "all")) {
          const destination = path.join(verifyRoot, `verify-${summary.verified}`);
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
          summary.verified += 1;
        }
      }
      completed += 1;
      console.error(`[state-blob-migration] file=${completed}/${files.length} path=${blobPath}`);
    }
  } finally {
    rmSync(verifyRoot, { force: true, recursive: true });
  }
  console.log(JSON.stringify(summary));
  return summary;
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
