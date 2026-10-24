#!/usr/bin/env node
// Incremental record tree for the static dashboard's review corpus.
//
//   node scripts/dashboard-corpus.ts plan
//   node scripts/dashboard-corpus.ts refresh --state <dir> --mode incremental|full
//   node scripts/dashboard-corpus.ts pack    --state <dir> --archive <file>
//   node scripts/dashboard-corpus.ts unpack  --archive <file> --state <dir>
//
// The corpus reads only the `items` and `closed` sections. A full rebuild hydrates them from
// the stored R2 snapshots plus the journal (the same lifecycle as scripts/hydrate-state.ts);
// every later refresh asks the canonical export journal only for records whose store
// revision is above the cursor saved with the tree. The journal keeps one row per record
// identity at its newest store revision and keeps deletions as tombstones, so a cursor replay
// sees every write and every deletion since the last refresh. The cursor is the first page's
// export watermark: a write that lands while the export pages run is read again next time,
// never lost, and re-applying a record is idempotent. A refresh that fails part-way leaves the
// old cursor beside a partly updated tree, which the next replay brings up to date; the
// workflow never saves the tree of a failed refresh.
//
// The corpus aggregate reads front matter only (dashboard-site/scripts/records.ts), so the tree
// keeps each record's front matter and drops the report body. That keeps the cached tree, and
// every cache save and restore, a fraction of the canonical size.
//
// The tree holds canonical records of every repository the store lists, private ones included,
// and Actions caches of the default branch are readable by pull-request workflows. The tree is
// therefore cached only as an AES-256-GCM sealed archive keyed from the records secret, which
// pull-request workflows from forks never receive.
import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { recordExtension } from "../src/record-snapshot-protocol.ts";
import {
  discoverWorkerRecordRepoSlugs,
  materializeWorkerRecords,
  visitWorkerRecords,
  type RecordSection,
} from "./worker-records.ts";

export const CORPUS_SECTIONS: readonly RecordSection[] = ["items", "closed"];
// Weekly full rebuild in the quietest review hour; keep in sync with dashboard-corpus.yml.
export const FULL_REBUILD_CRON = "20 0 * * 0";
// Hours (UTC) in which a scheduled run without a saved tree may rebuild in full.
const QUIET_HOURS_UTC: readonly number[] = [0, 12];

export type CorpusMode = "incremental" | "full";

// The newest store revision applied to the tree, per repository slug.
type CorpusCursor = { schemaVersion: 1; repositories: Record<string, number> };

export type CorpusRefreshPlan = { mode: CorpusMode | "skip"; reason: string };

type WorkerOptions = {
  baseUrl: string;
  webhookSecret: string;
  fetch?: typeof globalThis.fetch;
  log?: (line: string) => void;
};

export type CorpusRefreshSummary = {
  mode: CorpusMode;
  repositories: number;
  unchanged: number;
  refreshed: number;
  bootstrapped: number;
  removed: number;
  written: number;
  deleted: number;
  durationMs: number;
};

// A record's leading front matter block, through its closing `---` line; a record without one
// is kept whole (the aggregate skips it either way).
export function corpusFrontMatter(content: string): string {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) return content;
  const lines = content.split("\n");
  for (let index = 1; index < lines.length; index++) {
    if (lines[index]!.replace(/\r$/, "") === "---")
      return `${lines.slice(0, index + 1).join("\n")}\n`;
  }
  return content;
}

function compactCorpusTree(root: string) {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      compactCorpusTree(full);
    } else if (entry.isFile()) {
      const content = readFileSync(full, "utf8");
      const compact = corpusFrontMatter(content);
      if (compact.length !== content.length) writeFileSync(full, compact, "utf8");
    }
  }
}

const cursorPath = (stateDir: string) => path.join(stateDir, "cursor.json");
const recordsPath = (stateDir: string) => path.join(stateDir, "records");

export function readCorpusCursor(stateDir: string): CorpusCursor | null {
  if (!existsSync(recordsPath(stateDir))) return null;
  try {
    const cursor = JSON.parse(readFileSync(cursorPath(stateDir), "utf8")) as Partial<CorpusCursor>;
    const revisions =
      cursor?.schemaVersion === 1 && cursor.repositories && typeof cursor.repositories === "object"
        ? Object.values(cursor.repositories)
        : null;
    return revisions?.every((revision) => Number.isSafeInteger(revision) && revision >= 0)
      ? (cursor as CorpusCursor)
      : null;
  } catch {
    return null;
  }
}

const writeCursor = (stateDir: string, cursor: CorpusCursor) =>
  writeFileSync(cursorPath(stateDir), `${JSON.stringify(cursor, null, 2)}\n`, "utf8");

export async function refreshCorpusRecords(
  options: WorkerOptions & { stateDir: string; mode: CorpusMode },
): Promise<CorpusRefreshSummary> {
  const startedAt = Date.now();
  const log = options.log ?? ((line: string) => console.error(line));
  const stateDir = path.resolve(options.stateDir);
  const discovered = await discoverWorkerRecordRepoSlugs(options);
  if (!discovered.length) throw new Error("canonical record store returned no repository slugs");
  const summary: CorpusRefreshSummary = {
    mode: options.mode,
    repositories: discovered.length,
    unchanged: 0,
    refreshed: 0,
    bootstrapped: 0,
    removed: 0,
    written: 0,
    deleted: 0,
    durationMs: 0,
  };

  if (options.mode === "full") {
    await rebuildCorpusRecords({ ...options, stateDir, log }, discovered);
    summary.bootstrapped = discovered.length;
    summary.durationMs = Date.now() - startedAt;
    return summary;
  }

  const cursor = readCorpusCursor(stateDir);
  if (!cursor) {
    throw new Error(
      `No usable incremental corpus state in ${stateDir}; run a full rebuild (mode=full) first`,
    );
  }
  const listed = new Set(discovered.map((entry) => entry.repoSlug));
  // A slug the store no longer lists has no canonical records left to show, and a directory
  // without a cursor cannot be trusted; it is bootstrapped again below if still listed.
  for (const entry of readdirSync(recordsPath(stateDir), {
    withFileTypes: true,
  })) {
    if (listed.has(entry.name) && cursor.repositories[entry.name] !== undefined) continue;
    rmSync(path.join(recordsPath(stateDir), entry.name), {
      force: true,
      recursive: true,
    });
  }
  for (const repoSlug of Object.keys(cursor.repositories)) {
    if (listed.has(repoSlug)) continue;
    delete cursor.repositories[repoSlug];
    summary.removed++;
  }

  for (const { repoSlug, revision } of discovered) {
    const since = cursor.repositories[repoSlug];
    if (since === undefined) {
      cursor.repositories[repoSlug] = await bootstrapRepository(
        { ...options, stateDir, log },
        repoSlug,
      );
      summary.bootstrapped++;
    } else if (revision <= since) {
      // The slug listing reports each slug's newest store revision: nothing changed.
      summary.unchanged++;
    } else {
      const applied = await applyRepositoryChanges({ ...options, stateDir }, repoSlug, since);
      cursor.repositories[repoSlug] = Math.max(since, applied.revision);
      summary.refreshed++;
      summary.written += applied.written;
      summary.deleted += applied.deleted;
      log(
        `[dashboard-corpus] incremental repo=${repoSlug} since=${since} cursor=${cursor.repositories[repoSlug]} written=${applied.written} deleted=${applied.deleted}`,
      );
    }
  }
  writeCursor(stateDir, cursor);
  summary.durationMs = Date.now() - startedAt;
  return summary;
}

// Applies every record of one repository whose store revision is above `sinceRevision`, in
// journal order.
async function applyRepositoryChanges(
  options: WorkerOptions & { stateDir: string },
  repoSlug: string,
  sinceRevision: number,
) {
  const repoRoot = path.join(recordsPath(options.stateDir), repoSlug);
  let written = 0;
  let deleted = 0;
  const journal = await visitWorkerRecords(
    {
      baseUrl: options.baseUrl,
      webhookSecret: options.webhookSecret,
      repoSlug,
      sections: CORPUS_SECTIONS,
      sinceRevision,
      fetch: options.fetch,
    },
    (record) => {
      const file = path.join(
        repoRoot,
        record.section,
        `${record.id}${recordExtension(record.section)}`,
      );
      if (record.deleted) {
        rmSync(file, { force: true });
        deleted++;
      } else {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, corpusFrontMatter(record.content ?? ""), "utf8");
        written++;
      }
    },
  );
  return { revision: journal.exportStartRevision, written, deleted };
}

async function bootstrapRepository(
  options: WorkerOptions & { stateDir: string; log: (line: string) => void },
  repoSlug: string,
) {
  const worktree = mkdtempSync(path.join(options.stateDir, ".bootstrap-"));
  try {
    const result = await materializeWorkerRecords({
      worktreeRoot: worktree,
      baseUrl: options.baseUrl,
      webhookSecret: options.webhookSecret,
      repoSlugs: [repoSlug],
      sections: CORPUS_SECTIONS,
      trackCoverage: false,
      fetch: options.fetch,
      log: options.log,
    });
    const destination = path.join(recordsPath(options.stateDir), repoSlug);
    rmSync(destination, { force: true, recursive: true });
    const source = path.join(result.recordsRoot, repoSlug);
    compactCorpusTree(source);
    if (existsSync(source)) renameSync(source, destination);
    else mkdirSync(destination, { recursive: true });
    return result.repositories[repoSlug]!.exportStartRevision;
  } finally {
    rmSync(worktree, { force: true, recursive: true });
  }
}

// Hydrates beside the live tree and replaces it only when every repository hydrated.
async function rebuildCorpusRecords(
  options: WorkerOptions & { stateDir: string; log: (line: string) => void },
  discovered: Array<{ repoSlug: string }>,
) {
  const parent = path.dirname(options.stateDir);
  mkdirSync(parent, { recursive: true });
  const worktree = mkdtempSync(path.join(parent, ".corpus-full-"));
  try {
    const result = await materializeWorkerRecords({
      worktreeRoot: worktree,
      baseUrl: options.baseUrl,
      webhookSecret: options.webhookSecret,
      repoSlugs: discovered.map((entry) => entry.repoSlug),
      sections: CORPUS_SECTIONS,
      trackCoverage: false,
      fetch: options.fetch,
      log: options.log,
    });
    compactCorpusTree(result.recordsRoot);
    rmSync(options.stateDir, { force: true, recursive: true });
    mkdirSync(options.stateDir, { recursive: true });
    renameSync(result.recordsRoot, recordsPath(options.stateDir));
    writeCursor(options.stateDir, {
      schemaVersion: 1,
      repositories: Object.fromEntries(
        Object.entries(result.repositories).map(([repoSlug, entry]) => [
          repoSlug,
          entry.exportStartRevision,
        ]),
      ),
    });
  } finally {
    rmSync(worktree, { force: true, recursive: true });
  }
}

const SEALED_MAGIC = Buffer.from("CSCORPUS1\n");
const SEALED_IV_BYTES = 12;
const SEALED_TAG_BYTES = 16;

function sealingKey(secret: string) {
  if (!secret) throw new Error("CLAWSWEEPER_RECORDS_SECRET is required to seal the corpus tree");
  return createHmac("sha256", secret).update("clawsweeper dashboard corpus tree v1").digest();
}

function waitForExit(child: ReturnType<typeof spawn>, label: string) {
  return new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`${label} failed (${signal ?? code})`)),
    );
  });
}

// tar | gzip | AES-256-GCM: magic, IV, ciphertext, then the authentication tag.
export async function sealCorpusState(stateDir: string, archive: string, secret: string) {
  if (!readCorpusCursor(stateDir)) throw new Error(`No corpus state to seal in ${stateDir}`);
  const key = sealingKey(secret);
  mkdirSync(path.dirname(archive), { recursive: true });
  const temporary = `${archive}.${process.pid}.tmp`;
  const iv = randomBytes(SEALED_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const tar = spawn("tar", ["-czf", "-", "-C", stateDir, "cursor.json", "records"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = waitForExit(tar, "tar");
  exited.catch(() => undefined);
  try {
    await pipeline(
      tar.stdout!,
      cipher,
      async function* (source) {
        yield SEALED_MAGIC;
        yield iv;
        for await (const chunk of source) yield chunk as Buffer;
        yield cipher.getAuthTag();
      },
      createWriteStream(temporary),
    );
    await exited;
    renameSync(temporary, archive);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return { bytes: statSync(archive).size };
}

// Authenticates and unpacks into a staging directory; the state is replaced only on success.
export async function unsealCorpusState(archive: string, stateDir: string, secret: string) {
  const key = sealingKey(secret);
  const size = statSync(archive).size;
  const header = SEALED_MAGIC.length + SEALED_IV_BYTES;
  if (size < header + SEALED_TAG_BYTES) throw new Error("Sealed corpus tree is truncated");
  const descriptor = openSync(archive, "r");
  const prefix = Buffer.alloc(header);
  const tag = Buffer.alloc(SEALED_TAG_BYTES);
  try {
    readSync(descriptor, prefix, 0, header, 0);
    readSync(descriptor, tag, 0, SEALED_TAG_BYTES, size - SEALED_TAG_BYTES);
  } finally {
    closeSync(descriptor);
  }
  if (!prefix.subarray(0, SEALED_MAGIC.length).equals(SEALED_MAGIC)) {
    throw new Error("Sealed corpus tree has an unknown format");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, prefix.subarray(SEALED_MAGIC.length));
  decipher.setAuthTag(tag);
  const parent = path.dirname(path.resolve(stateDir));
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(path.join(parent, ".corpus-unseal-"));
  try {
    const tar = spawn("tar", ["-xzf", "-", "-C", staging], {
      stdio: ["pipe", "ignore", "inherit"],
    });
    const exited = waitForExit(tar, "tar");
    exited.catch(() => undefined);
    await pipeline(
      createReadStream(archive, {
        start: header,
        end: size - SEALED_TAG_BYTES - 1,
      }),
      decipher,
      tar.stdin!,
    );
    await exited;
    if (!readCorpusCursor(staging)) throw new Error("Sealed corpus tree holds no usable state");
    rmSync(stateDir, { force: true, recursive: true });
    renameSync(staging, stateDir);
  } finally {
    rmSync(staging, { force: true, recursive: true });
  }
}

// A failed refresh is retried on the next hourly run: an incremental retry costs one slug listing
// plus the changed records, and a scheduled full rebuild only runs weekly or, without a saved
// tree, in the two quiet hours.
export function planCorpusRefresh(input: {
  event: string;
  schedule?: string;
  requestedMode?: string;
  hasState: boolean;
  now: Date;
}): CorpusRefreshPlan {
  if (input.event === "workflow_dispatch") {
    if (input.requestedMode === "full") return { mode: "full", reason: "manual full rebuild" };
    return input.hasState
      ? { mode: "incremental", reason: "manual incremental refresh" }
      : { mode: "full", reason: "manual refresh without incremental state" };
  }
  if (input.schedule === FULL_REBUILD_CRON) return { mode: "full", reason: "weekly full rebuild" };
  if (input.hasState) return { mode: "incremental", reason: "scheduled incremental refresh" };
  return QUIET_HOURS_UTC.includes(input.now.getUTCHours())
    ? {
        mode: "full",
        reason: "no incremental state; rebuilding in a quiet hour",
      }
    : {
        mode: "skip",
        reason: "no incremental state; waiting for a quiet hour (00 or 12 UTC) or a manual run",
      };
}

function parseMode(value: string | undefined): CorpusMode {
  if (value === "incremental" || value === "full") return value;
  throw new Error("--mode must be incremental or full");
}

async function main(argv: string[]) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      state: { type: "string" },
      mode: { type: "string" },
      archive: { type: "string" },
    },
  });
  const secret =
    process.env.CLAWSWEEPER_RECORDS_SECRET || process.env.CLAWSWEEPER_WEBHOOK_SECRET || "";
  if (command === "plan") {
    const plan = planCorpusRefresh({
      event: process.env.EVENT_NAME ?? "",
      schedule: process.env.SCHEDULE || undefined,
      requestedMode: process.env.REQUESTED_MODE || undefined,
      hasState: process.env.HAS_STATE === "true",
      now: new Date(),
    });
    console.log(JSON.stringify(plan));
    if (process.env.GITHUB_OUTPUT)
      writeFileSync(process.env.GITHUB_OUTPUT, `mode=${plan.mode}\n`, {
        flag: "a",
      });
    if (plan.mode === "skip") console.log(`::notice::Corpus refresh skipped: ${plan.reason}`);
    return;
  }
  if (command === "pack" || command === "unpack") {
    if (!values.state || !values.archive)
      throw new Error(`${command} requires --state and --archive`);
    if (command === "pack") {
      console.log(JSON.stringify(await sealCorpusState(values.state, values.archive, secret)));
    } else {
      await unsealCorpusState(values.archive, values.state, secret);
    }
    return;
  }
  if (command === "refresh") {
    if (!values.state) throw new Error("refresh requires --state");
    if (!secret) throw new Error("CLAWSWEEPER_RECORDS_SECRET is required");
    const summary = await refreshCorpusRecords({
      stateDir: values.state,
      mode: parseMode(values.mode),
      baseUrl: process.env.CLAWSWEEPER_RECORDS_URL || "https://clawsweeper.openclaw.ai",
      webhookSecret: secret,
    });
    console.log(JSON.stringify(summary));
    if (process.env.GITHUB_STEP_SUMMARY) {
      writeFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `### Corpus record refresh\n\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\`\n`,
        { flag: "a" },
      );
    }
    return;
  }
  throw new Error("usage: dashboard-corpus.ts plan|refresh|pack|unpack [options]");
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  await main(process.argv.slice(2));
}
