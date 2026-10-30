#!/usr/bin/env node
// Incremental record tree for the static dashboard's review corpus (dashboard-corpus.yml).
//
//   node scripts/dashboard-corpus.ts --state <dir> --archive <sealed tree>
//
// The corpus reads only the `items` and `closed` sections. A full rebuild hydrates them from
// the stored R2 snapshots plus the journal (the same lifecycle as scripts/hydrate-state.ts);
// every later refresh asks the canonical export journal only for records whose store
// revision is above the cursor saved with the tree. The journal keeps one row per record
// identity at its newest store revision and keeps deletions as tombstones, so a cursor replay
// sees every write and every deletion since the last refresh. The cursor is the first page's
// export watermark: a write that lands while the export pages run is read again next time,
// never lost, and re-applying a record is idempotent. A refresh that fails part-way writes no
// archive, so the next run replays from the last saved tree.
//
// The aggregate reads front matter only (dashboard-site/scripts/records.ts), so the tree keeps
// each record's front matter and drops the report body, a fraction of the canonical size.
//
// The tree holds canonical records of every repository the store lists, private ones included,
// and Actions caches of the default branch are readable by pull-request workflows. The tree is
// therefore only ever written as an AES-256-GCM sealed archive keyed from the records secret,
// which pull-request workflows from forks never receive.
import { execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { recordExtension } from "../src/record-snapshot-protocol.ts";
import {
  discoverWorkerRecordRepoSlugs,
  materializeWorkerRecords,
  visitWorkerRecords,
  WorkerSnapshotUnavailableError,
  type RecordSection,
} from "./worker-records.ts";

export const CORPUS_SECTIONS: readonly RecordSection[] = ["items", "closed"];
// Weekly full rebuild in the quietest review hour; keep in sync with dashboard-corpus.yml.
export const FULL_REBUILD_CRON = "20 0 * * 0";
// A run stops starting repository hydrations after this long and saves what it has; the next
// hourly run hydrates the rest. Stored snapshots can lag the journal by millions of revisions, so a
// complete rebuild may need several runs; the workflow step timeout leaves room for the repository
// still hydrating when the budget runs out.
export const HYDRATION_BUDGET_MS = 25 * 60_000;
// Hours (UTC) in which a scheduled run without a saved tree may rebuild in full.
const QUIET_HOURS_UTC: readonly number[] = [0, 12];

export type CorpusMode = "incremental" | "full";

// The newest store revision applied to the tree, per repository slug.
type CorpusCursor = { schemaVersion: 1; repositories: Record<string, number> };

type WorkerOptions = {
  baseUrl: string;
  webhookSecret: string;
  fetch?: typeof globalThis.fetch;
  log?: (line: string) => void;
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
  options: WorkerOptions & { stateDir: string; mode: CorpusMode; hydrationBudgetMs?: number },
) {
  const startedAt = Date.now();
  const hydrateUntil = startedAt + (options.hydrationBudgetMs ?? HYDRATION_BUDGET_MS);
  const stateDir = path.resolve(options.stateDir);
  const discovered = await discoverWorkerRecordRepoSlugs(options);
  if (!discovered.length) throw new Error("canonical record store returned no repository slugs");
  const summary = {
    mode: options.mode,
    repositories: discovered.length,
    unchanged: 0,
    refreshed: 0,
    bootstrapped: 0,
    deferred: 0,
    pending: 0,
    written: 0,
    deleted: 0,
    durationMs: 0,
  };

  if (options.mode === "full") {
    // Hydrates beside the live tree and replaces it only when the run succeeds. Repositories the
    // budget left for later have no cursor, so the following incremental runs hydrate them.
    const parent = path.dirname(stateDir);
    mkdirSync(parent, { recursive: true });
    const staging = mkdtempSync(path.join(parent, ".corpus-full-"));
    try {
      const repoSlugs = discovered.map((entry) => entry.repoSlug);
      const hydrated = await hydrateRepositories(
        options,
        repoSlugs,
        recordsPath(staging),
        hydrateUntil,
      );
      writeCursor(staging, { schemaVersion: 1, repositories: hydrated.revisions });
      rmSync(stateDir, { force: true, recursive: true });
      renameSync(staging, stateDir);
      summary.bootstrapped = Object.keys(hydrated.revisions).length;
      summary.deferred = hydrated.deferred;
      summary.pending = hydrated.pending;
    } finally {
      rmSync(staging, { force: true, recursive: true });
    }
    summary.durationMs = Date.now() - startedAt;
    return summary;
  }

  const cursor = readCorpusCursor(stateDir);
  if (!cursor) {
    throw new Error(
      `No usable incremental corpus state in ${stateDir}; run a full rebuild (mode=full) first`,
    );
  }
  // The export index never deletes rows (deletions are tombstones), so a listed slug stays
  // listed; a slug without a cursor is new and is hydrated like a full rebuild.
  const added = discovered
    .map((entry) => entry.repoSlug)
    .filter((repoSlug) => cursor.repositories[repoSlug] === undefined);
  if (added.length) {
    const hydrated = await hydrateRepositories(options, added, recordsPath(stateDir), hydrateUntil);
    Object.assign(cursor.repositories, hydrated.revisions);
    summary.bootstrapped = Object.keys(hydrated.revisions).length;
    summary.deferred = hydrated.deferred;
    summary.pending = hydrated.pending;
  }
  for (const { repoSlug, revision } of discovered) {
    if (added.includes(repoSlug)) continue;
    const since = cursor.repositories[repoSlug]!;
    // The slug listing reports each slug's newest store revision.
    if (revision <= since) {
      summary.unchanged++;
      continue;
    }
    const applied = await applyRepositoryChanges(options, stateDir, repoSlug, since);
    cursor.repositories[repoSlug] = Math.max(since, applied.revision);
    summary.refreshed++;
    summary.written += applied.written;
    summary.deleted += applied.deleted;
  }
  writeCursor(stateDir, cursor);
  summary.durationMs = Date.now() - startedAt;
  return summary;
}

// Applies every record of one repository whose store revision is above `sinceRevision`, in
// journal order.
async function applyRepositoryChanges(
  options: WorkerOptions,
  stateDir: string,
  repoSlug: string,
  sinceRevision: number,
) {
  const repoRoot = path.join(recordsPath(stateDir), repoSlug);
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

// Hydrates repositories from their snapshots plus the journal into `recordsRoot/<slug>`, trimmed to
// front matter, and returns each hydrated repository's cursor. No repository starts after
// `hydrateUntil` (except the first); those left are counted as pending. A repository without a stored
// snapshot whose journal is over the cold-hydration bound is left out (it has no cursor, so every
// later refresh tries it again) instead of holding back every other repository until the
// snapshot sweep reaches it. Store outages still fail the refresh.
async function hydrateRepositories(
  options: WorkerOptions,
  repoSlugs: readonly string[],
  recordsRoot: string,
  hydrateUntil: number,
) {
  mkdirSync(recordsRoot, { recursive: true });
  const worktree = mkdtempSync(path.join(path.dirname(recordsRoot), ".corpus-hydrate-"));
  const revisions: Record<string, number> = {};
  let deferred = 0;
  let pending = 0;
  try {
    for (const repoSlug of repoSlugs) {
      // At least one repository per run, so a run that spent its budget elsewhere still progresses.
      if (Date.now() >= hydrateUntil && (Object.keys(revisions).length || deferred)) {
        pending++;
        continue;
      }
      let result;
      try {
        result = await materializeWorkerRecords({
          worktreeRoot: worktree,
          baseUrl: options.baseUrl,
          webhookSecret: options.webhookSecret,
          repoSlugs: [repoSlug],
          sections: CORPUS_SECTIONS,
          trackCoverage: false,
          fetch: options.fetch,
          log: options.log,
        });
      } catch (error) {
        if (
          !(error instanceof WorkerSnapshotUnavailableError) ||
          error.detail.code !== "cold_hydration_bound_exceeded"
        ) {
          throw error;
        }
        console.log(
          `::warning::Corpus left out ${repoSlug} until it has a stored snapshot: ${error.message}`,
        );
        deferred++;
        continue;
      }
      compactCorpusTree(result.recordsRoot);
      const source = path.join(result.recordsRoot, repoSlug);
      const destination = path.join(recordsRoot, repoSlug);
      rmSync(destination, { force: true, recursive: true });
      if (existsSync(source)) renameSync(source, destination);
      else mkdirSync(destination, { recursive: true });
      revisions[repoSlug] = result.repositories[repoSlug]!.exportStartRevision;
    }
    if (pending) {
      console.log(
        `::notice::Corpus hydration budget used; ${pending} repositories hydrate on the next runs.`,
      );
    }
    return { revisions, deferred, pending };
  } finally {
    rmSync(worktree, { force: true, recursive: true });
  }
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

function sealingKey(secret: string) {
  if (!secret) throw new Error("CLAWSWEEPER_RECORDS_SECRET is required to seal the corpus tree");
  return createHmac("sha256", secret).update("clawsweeper dashboard corpus tree v1").digest();
}

// tar.gz sealed with AES-256-GCM: IV, ciphertext, then the authentication tag. The compacted
// tree compresses to a few MB per 100,000 records, so it is sealed in memory.
export function sealCorpusState(stateDir: string, archive: string, secret: string) {
  if (!readCorpusCursor(stateDir)) throw new Error(`No corpus state to seal in ${stateDir}`);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", sealingKey(secret), iv);
  const tarball = execFileSync("tar", ["-czf", "-", "-C", stateDir, "cursor.json", "records"], {
    maxBuffer: 2 ** 31,
  });
  const sealed = Buffer.concat([iv, cipher.update(tarball), cipher.final(), cipher.getAuthTag()]);
  mkdirSync(path.dirname(archive), { recursive: true });
  writeFileSync(`${archive}.tmp`, sealed);
  renameSync(`${archive}.tmp`, archive);
  return { bytes: sealed.length };
}

// Authenticates and unpacks into a staging directory; the state is replaced only on success.
export function unsealCorpusState(archive: string, stateDir: string, secret: string) {
  const sealed = readFileSync(archive);
  if (sealed.length < IV_BYTES + TAG_BYTES) throw new Error("Sealed corpus tree is truncated");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    sealingKey(secret),
    sealed.subarray(0, IV_BYTES),
  );
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  const tarball = Buffer.concat([
    decipher.update(sealed.subarray(IV_BYTES, sealed.length - TAG_BYTES)),
    decipher.final(),
  ]);
  const parent = path.dirname(path.resolve(stateDir));
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(path.join(parent, ".corpus-unseal-"));
  try {
    execFileSync("tar", ["-xzf", "-", "-C", staging], { input: tarball });
    if (!readCorpusCursor(staging)) throw new Error("Sealed corpus tree holds no usable state");
    rmSync(stateDir, { force: true, recursive: true });
    renameSync(staging, stateDir);
  } finally {
    rmSync(staging, { force: true, recursive: true });
  }
}

// Unseals the saved tree into `stateDir` and reports whether there is one. A tree sealed under a
// rotated secret, or damaged, counts as missing, so the next quiet-hour run rebuilds it instead of
// every hourly run failing until someone dispatches mode=full.
export function restoreCorpusState(archive: string, stateDir: string, secret: string) {
  if (!existsSync(archive)) return false;
  try {
    unsealCorpusState(archive, stateDir, secret);
    return true;
  } catch (error) {
    console.log(
      `::warning::Saved corpus tree cannot be opened (${error instanceof Error ? error.message : String(error)}); treating it as missing.`,
    );
    return false;
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
}): CorpusMode | "skip" {
  if (input.event === "workflow_dispatch") {
    return input.requestedMode === "full" || !input.hasState ? "full" : "incremental";
  }
  if (input.schedule === FULL_REBUILD_CRON) return "full";
  if (input.hasState) return "incremental";
  return QUIET_HOURS_UTC.includes(input.now.getUTCHours()) ? "full" : "skip";
}

async function main(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: { state: { type: "string" }, archive: { type: "string" } },
  });
  if (!values.state || !values.archive) {
    throw new Error("usage: dashboard-corpus.ts --state <dir> --archive <sealed tree>");
  }
  const secret = process.env.CLAWSWEEPER_RECORDS_SECRET ?? "";
  if (!secret) throw new Error("CLAWSWEEPER_RECORDS_SECRET is required");
  const mode = planCorpusRefresh({
    event: process.env.EVENT_NAME ?? "",
    schedule: process.env.SCHEDULE || undefined,
    requestedMode: process.env.REQUESTED_MODE || undefined,
    hasState: restoreCorpusState(values.archive, values.state, secret),
    now: new Date(),
  });
  if (mode === "skip") {
    console.log(
      "::notice::No usable corpus tree: a scheduled run rebuilds it in the 00 or 12 UTC hour, or run this workflow with mode=full.",
    );
    return;
  }
  const summary = await refreshCorpusRecords({
    stateDir: values.state,
    mode,
    baseUrl: process.env.CLAWSWEEPER_RECORDS_URL || "https://clawsweeper.openclaw.ai",
    webhookSecret: secret,
  });
  const { bytes } = sealCorpusState(values.state, values.archive, secret);
  console.log(JSON.stringify({ ...summary, sealedBytes: bytes }));
  if (process.env.GITHUB_OUTPUT) {
    // The aggregate is rebuilt only from a complete tree, so the site keeps the last complete
    // corpus while a rebuild spans several runs.
    writeFileSync(
      process.env.GITHUB_OUTPUT,
      `refreshed=true\ncomplete=${summary.pending === 0}\n`,
      { flag: "a" },
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  await main(process.argv.slice(2));
}
