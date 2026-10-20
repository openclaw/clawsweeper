#!/usr/bin/env node
// Incremental record tree for the static dashboard's review corpus.
//
//   node scripts/dashboard-corpus.ts plan    --state <dir> --status <file>
//   node scripts/dashboard-corpus.ts refresh --state <dir> --mode incremental|full
//   node scripts/dashboard-corpus.ts record  --status <file> --outcome success|failure
//                                            --mode incremental|full --started-at <iso>
//
// The corpus reads only the `items» and `closed» sections. A full rebuild hydrates them from
// the stored R2 snapshots plus the journal (the same lifecycle as scripts/hydrate-state.ts);
// every later refresh asks the canonical export journal only for records whose store
// revision is above the cursor saved with the tree. The journal keeps one row per record
// identity at its newest store revision and keeps deletions as tombstones, so a cursor replay
// sees every write and every deletion since the last refresh. The cursor is the first page's
// export watermark: a write that lands while the export pages run is read again next time,
// never lost, and re-applying a record is idempotent.
//
// The corpus aggregate reads front matter only (dashboard-site/scripts/records.ts), so the tree
// keeps each record's front matter and drops the report body. That keeps the cached tree, and
// every cache save and restore, a fraction of the canonical size.
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
  type RecordSection,
} from "./worker-records.ts";

export const CORPUS_SECTIONS: readonly RecordSection[] = ["items", "closed"];
export const CORPUS_STATE_SCHEMA_VERSION = 1;
// Weekly full rebuild in the quietest review hour; keep in sync with dashboard-corpus.yml.
export const FULL_REBUILD_CRON = "20 0 * * 0";
// Hours (UTC) in which a scheduled run without any incremental state may rebuild in full.
export const QUIET_HOURS_UTC: readonly number[] = [0, 12];
export const MAX_BACKOFF_HOURS = 12;
// Cron start times drift by minutes; do not let that turn a 2-hour backoff into 3 hours.
const BACKOFF_GRACE_MS = 15 * 60_000;

export type CorpusMode = "incremental" | "full";

export type CorpusCursorState = {
  schemaVersion: typeof CORPUS_STATE_SCHEMA_VERSION;
  sections: string[];
  fullRebuildAt: string;
  refreshedAt: string;
  repositories: Record<
    string,
    { revision: number; refreshedAt: string; source: "full" | "bootstrap" | "incremental" }
  >;
};

export type CorpusRefreshStatus = {
  schemaVersion: 1;
  consecutiveFailures: number;
  lastAttemptAt?: string;
  lastMode?: CorpusMode;
  lastSuccessAt?: string;
  lastFailureAt?: string;
};

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

export function readCorpusCursorState(stateDir: string): CorpusCursorState | null {
  if (!existsSync(recordsPath(stateDir))) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(cursorPath(stateDir), "utf8"));
  } catch {
    return null;
  }
  const state = value as Partial<CorpusCursorState> | null;
  if (
    !state ||
    typeof state !== "object" ||
    state.schemaVersion !== CORPUS_STATE_SCHEMA_VERSION ||
    !Array.isArray(state.sections) ||
    state.sections.join(",") !== CORPUS_SECTIONS.join(",") ||
    typeof state.fullRebuildAt !== "string" ||
    typeof state.repositories !== "object" ||
    state.repositories === null
  ) {
    return null;
  }
  for (const entry of Object.values(state.repositories)) {
    if (!entry || !Number.isSafeInteger(entry.revision) || entry.revision < 0) return null;
  }
  return state as CorpusCursorState;
}

function writeJsonAtomic(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, file);
}

export async function refreshCorpusRecords(
  options: WorkerOptions & { stateDir: string; mode: CorpusMode; now?: () => Date },
): Promise<CorpusRefreshSummary> {
  const now = options.now ?? (() => new Date());
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
    await rebuildCorpusRecords({ ...options, stateDir, log, now }, discovered);
    summary.bootstrapped = discovered.length;
    summary.durationMs = Date.now() - startedAt;
    return summary;
  }

  const state = readCorpusCursorState(stateDir);
  if (!state) {
    throw new Error(
      `No usable incremental corpus state in ${stateDir}; run a full rebuild (mode=full) first`,
    );
  }
  const listed = new Set(discovered.map((entry) => entry.repoSlug));
  // A slug the store no longer lists has no canonical records left to show, and a directory
  // without a cursor cannot be trusted; it is bootstrapped again below if still listed.
  for (const entry of readdirSync(recordsPath(stateDir), { withFileTypes: true })) {
    if (listed.has(entry.name) && state.repositories[entry.name]) continue;
    rmSync(path.join(recordsPath(stateDir), entry.name), { force: true, recursive: true });
  }
  for (const repoSlug of Object.keys(state.repositories)) {
    if (listed.has(repoSlug)) continue;
    rmSync(path.join(recordsPath(stateDir), repoSlug), { force: true, recursive: true });
    delete state.repositories[repoSlug];
    summary.removed++;
  }

  for (const { repoSlug, revision } of discovered) {
    const cursor = state.repositories[repoSlug];
    if (!cursor) {
      const bootstrapped = await bootstrapRepository({ ...options, stateDir, log }, repoSlug);
      state.repositories[repoSlug] = {
        revision: bootstrapped,
        refreshedAt: now().toISOString(),
        source: "bootstrap",
      };
      summary.bootstrapped++;
    } else if (revision <= cursor.revision) {
      // The slug listing reports each slug's newest store revision: nothing changed.
      summary.unchanged++;
      continue;
    } else {
      const applied = await applyRepositoryChanges(
        { ...options, stateDir },
        repoSlug,
        cursor.revision,
      );
      state.repositories[repoSlug] = {
        revision: Math.max(cursor.revision, applied.revision),
        refreshedAt: now().toISOString(),
        source: "incremental",
      };
      summary.refreshed++;
      summary.written += applied.written;
      summary.deleted += applied.deleted;
      log(
        `[dashboard-corpus] incremental repo=${repoSlug} since=${cursor.revision} cursor=${state.repositories[repoSlug].revision} written=${applied.written} deleted=${applied.deleted}`,
      );
    }
    // Persist after every repository: a later failure leaves a tree and cursor that agree.
    state.refreshedAt = now().toISOString();
    writeJsonAtomic(cursorPath(stateDir), state);
  }
  state.refreshedAt = now().toISOString();
  writeJsonAtomic(cursorPath(stateDir), state);
  summary.durationMs = Date.now() - startedAt;
  return summary;
}

// Every record of one repository whose store revision is above `sinceRevision», staged
// first and moved into the tree only after the whole export succeeded.
export async function applyRepositoryChanges(
  options: WorkerOptions & { stateDir: string },
  repoSlug: string,
  sinceRevision: number,
) {
  const repoRoot = path.join(recordsPath(options.stateDir), repoSlug);
  mkdirSync(repoRoot, { recursive: true });
  const stage = mkdtempSync(path.join(options.stateDir, ".stage-"));
  const changes = new Map<string, boolean>();
  try {
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
        const relative = path.join(
          record.section,
          `${record.id}${recordExtension(record.section)}`,
        );
        const staged = path.join(stage, relative);
        if (record.deleted) {
          rmSync(staged, { force: true });
        } else {
          mkdirSync(path.dirname(staged), { recursive: true });
          writeFileSync(staged, corpusFrontMatter(record.content ?? ""), "utf8");
        }
        changes.set(relative, record.deleted);
      },
    );
    let written = 0;
    let deleted = 0;
    for (const [relative, isDeleted] of changes) {
      const destination = path.join(repoRoot, relative);
      if (isDeleted) {
        rmSync(destination, { force: true });
        deleted++;
      } else {
        mkdirSync(path.dirname(destination), { recursive: true });
        renameSync(path.join(stage, relative), destination);
        written++;
      }
    }
    return { revision: journal.exportStartRevision, written, deleted };
  } finally {
    rmSync(stage, { force: true, recursive: true });
  }
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

async function rebuildCorpusRecords(
  options: WorkerOptions & {
    stateDir: string;
    log: (line: string) => void;
    now: () => Date;
  },
  discovered: Array<{ repoSlug: string }>,
) {
  const parent = path.dirname(options.stateDir);
  mkdirSync(parent, { recursive: true });
  // Built beside the live tree and swapped in only when every repository hydrated.
  const worktree = mkdtempSync(path.join(parent, ".corpus-full-"));
  const next = path.join(worktree, "state");
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
    const at = options.now().toISOString();
    const state: CorpusCursorState = {
      schemaVersion: CORPUS_STATE_SCHEMA_VERSION,
      sections: [...CORPUS_SECTIONS],
      fullRebuildAt: at,
      refreshedAt: at,
      repositories: Object.fromEntries(
        Object.entries(result.repositories).map(([repoSlug, entry]) => [
          repoSlug,
          { revision: entry.exportStartRevision, refreshedAt: at, source: "full" as const },
        ]),
      ),
    };
    compactCorpusTree(result.recordsRoot);
    mkdirSync(next, { recursive: true });
    renameSync(result.recordsRoot, recordsPath(next));
    writeJsonAtomic(cursorPath(next), state);
    rmSync(options.stateDir, { force: true, recursive: true });
    renameSync(next, options.stateDir);
  } finally {
    rmSync(worktree, { force: true, recursive: true });
  }
}

export function planCorpusRefresh(input: {
  event: string;
  schedule?: string;
  requestedMode?: string;
  hasState: boolean;
  status: CorpusRefreshStatus | null;
  now: Date;
}): CorpusRefreshPlan {
  if (input.event === "workflow_dispatch") {
    if (input.requestedMode === "full") return { mode: "full", reason: "manual full rebuild" };
    return input.hasState
      ? { mode: "incremental", reason: "manual incremental refresh" }
      : { mode: "full", reason: "manual refresh without incremental state" };
  }
  if (input.event !== "schedule") {
    return { mode: "skip", reason: `unsupported event ${input.event}` };
  }
  const failures = input.status?.consecutiveFailures ?? 0;
  const failedAt = Date.parse(input.status?.lastFailureAt ?? "");
  if (failures > 0 && Number.isFinite(failedAt)) {
    const hours = Math.min(2 ** failures, MAX_BACKOFF_HOURS);
    const retryAt = failedAt + hours * 3_600_000 - BACKOFF_GRACE_MS;
    if (input.now.getTime() < retryAt) {
      return {
        mode: "skip",
        reason: `backing off after ${failures} failed refresh(es) until ${new Date(retryAt).toISOString()}`,
      };
    }
  }
  if (input.schedule === FULL_REBUILD_CRON) return { mode: "full", reason: "weekly full rebuild" };
  if (input.hasState) return { mode: "incremental", reason: "scheduled incremental refresh" };
  return QUIET_HOURS_UTC.includes(input.now.getUTCHours())
    ? { mode: "full", reason: "no incremental state; rebuilding in a quiet hour" }
    : {
        mode: "skip",
        reason: "no incremental state; waiting for a quiet hour (00 or 12 UTC) or a manual run",
      };
}

export function recordCorpusRefreshResult(
  status: CorpusRefreshStatus | null,
  result: { outcome: "success" | "failure"; mode: CorpusMode; startedAt: string },
): CorpusRefreshStatus {
  const previous: CorpusRefreshStatus = status ?? { schemaVersion: 1, consecutiveFailures: 0 };
  if (result.outcome === "success") {
    return {
      ...previous,
      consecutiveFailures: 0,
      lastAttemptAt: result.startedAt,
      lastMode: result.mode,
      lastSuccessAt: result.startedAt,
    };
  }
  return {
    ...previous,
    consecutiveFailures: previous.consecutiveFailures + 1,
    lastAttemptAt: result.startedAt,
    lastMode: result.mode,
    lastFailureAt: result.startedAt,
  };
}

export function readCorpusRefreshStatus(file: string): CorpusRefreshStatus | null {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<CorpusRefreshStatus> | null;
    if (
      value?.schemaVersion !== 1 ||
      !Number.isSafeInteger(value.consecutiveFailures) ||
      Number(value.consecutiveFailures) < 0
    ) {
      return null;
    }
    return value as CorpusRefreshStatus;
  } catch {
    return null;
  }
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
      status: { type: "string" },
      mode: { type: "string" },
      outcome: { type: "string" },
      "started-at": { type: "string" },
    },
  });
  if (command === "plan") {
    if (!values.state || !values.status) throw new Error("plan requires --state and --status");
    const startedAt = new Date();
    const plan = planCorpusRefresh({
      event: process.env.EVENT_NAME ?? "",
      schedule: process.env.SCHEDULE || undefined,
      requestedMode: process.env.REQUESTED_MODE || undefined,
      hasState: process.env.HAS_STATE === "true",
      status: readCorpusRefreshStatus(values.status),
      now: startedAt,
    });
    console.log(JSON.stringify(plan));
    if (process.env.GITHUB_OUTPUT) {
      writeFileSync(
        process.env.GITHUB_OUTPUT,
        `mode=${plan.mode}\nstarted_at=${startedAt.toISOString()}\n`,
        { flag: "a" },
      );
    }
    if (plan.mode === "skip") console.log(`::notice::Corpus refresh skipped: ${plan.reason}`);
    return;
  }
  if (command === "refresh") {
    if (!values.state) throw new Error("refresh requires --state");
    const webhookSecret =
      process.env.CLAWSWEEPER_RECORDS_SECRET ?? process.env.CLAWSWEEPER_WEBHOOK_SECRET ?? "";
    if (!webhookSecret) throw new Error("CLAWSWEEPER_RECORDS_SECRET is required");
    const summary = await refreshCorpusRecords({
      stateDir: values.state,
      mode: parseMode(values.mode),
      baseUrl: process.env.CLAWSWEEPER_RECORDS_URL || "https://clawsweeper.openclaw.ai",
      webhookSecret,
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
  if (command === "record") {
    if (!values.status || !values["started-at"]) {
      throw new Error("record requires --status and --started-at");
    }
    if (values.outcome !== "success" && values.outcome !== "failure") {
      throw new Error("--outcome must be success or failure");
    }
    const status = recordCorpusRefreshResult(readCorpusRefreshStatus(values.status), {
      outcome: values.outcome,
      mode: parseMode(values.mode),
      startedAt: values["started-at"],
    });
    writeJsonAtomic(values.status, status);
    console.log(JSON.stringify(status));
    return;
  }
  throw new Error("usage: dashboard-corpus.ts plan|refresh|record [options]");
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  await main(process.argv.slice(2));
}
