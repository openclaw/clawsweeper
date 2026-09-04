import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { open } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import { WORKER_RECORDS_MANIFEST_SCHEMA_VERSION } from "../src/review-coverage-manifest.ts";
import {
  recordExtension,
  tarHeader,
  RECORD_SNAPSHOT_UPLOAD_MAX_BYTES,
  SNAPSHOT_UPLOAD_PART_BYTES,
  SNAPSHOT_UPLOAD_JSON_MAX_BYTES,
  SNAPSHOT_MAX_IDENTITIES,
  SNAPSHOT_MANIFEST_CHUNK_IDENTITIES,
  snapshotIdentityKey,
  type SnapshotIdentity,
} from "../src/record-snapshot-protocol.ts";

export const RECORD_SECTIONS = ["items", "closed", "plans", "decision-packets", "commits"] as const;
export type RecordSection = (typeof RECORD_SECTIONS)[number];

export type WorkerRecord = {
  section: RecordSection;
  id: string;
  content: string | null;
  digest: string | null;
  revision: number;
  storeRevision: number;
  updatedAt?: string;
  deleted: boolean;
};

type ExportPage = {
  repoSlug: string;
  revision: number;
  records: WorkerRecord[];
  nextCursor: number | null;
};

export type WorkerRecordSnapshot = {
  repoSlug: string;
  revision: number;
  exportStartRevision: number;
  records: WorkerRecord[];
};

export type WorkerStoredSnapshot = {
  repoSlug: string;
  revisionWatermark: number;
  objectKey: string;
  bytes: number;
  uncompressedBytes: number;
  fileCount: number;
  createdAt: string;
  access: { mode: "worker_range_proxy"; maxChunkBytes: number };
};

export type WorkerSnapshotUnavailableDetail = {
  repoSlug?: string;
  endpoint?: string;
  status?: number;
  code?: string;
  bodySnippet?: string;
  succeededSlugs?: number;
};

export class WorkerSnapshotUnavailableError extends Error {
  readonly reason: "snapshot_store_unavailable" | "snapshot_not_found";
  readonly detail: WorkerSnapshotUnavailableDetail;
  readonly detailText: string;

  constructor(
    reason: "snapshot_store_unavailable" | "snapshot_not_found",
    detail: WorkerSnapshotUnavailableDetail = {},
    options?: { cause?: unknown },
  ) {
    const base =
      reason === "snapshot_store_unavailable" ? "snapshot store unavailable" : "snapshot not found";
    const detailText = snapshotUnavailableDetailText(detail);
    super(detailText ? `${base} (${detailText})` : base, options);
    this.name = "WorkerSnapshotUnavailableError";
    this.reason = reason;
    this.detail = detail;
    this.detailText = detailText;
  }
}

function snapshotUnavailableDetailText(detail: WorkerSnapshotUnavailableDetail) {
  const parts: string[] = [];
  if (detail.repoSlug) parts.push(`repo=${detail.repoSlug}`);
  if (detail.endpoint) parts.push(`endpoint=${detail.endpoint}`);
  if (detail.status !== undefined) parts.push(`status=${detail.status}`);
  if (detail.code) parts.push(`code=${detail.code}`);
  if (detail.succeededSlugs !== undefined) parts.push(`succeededSlugs=${detail.succeededSlugs}`);
  if (detail.bodySnippet) parts.push(`body=${JSON.stringify(detail.bodySnippet)}`);
  return parts.join(" ");
}

export class WorkerRecordRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly bodySnippet: string;

  constructor(status: number, code: string, bodySnippet = "") {
    super(
      bodySnippet && bodySnippet !== code
        ? `Worker record request failed (${status}): ${code} — ${bodySnippet}`
        : `Worker record request failed (${status}): ${code}`,
    );
    this.name = "WorkerRecordRequestError";
    this.status = status;
    this.code = code;
    this.bodySnippet = bodySnippet;
  }
}

type SignedRequestRetryDelays = readonly [number, number];

const DEFAULT_SIGNED_REQUEST_RETRY_DELAYS_MS = [250, 500] as const;
const WORKER_RECORD_READ_RETRY_DELAYS_MS = [30_000, 60_000] as const;

type SignedRequestOptions = {
  baseUrl: string;
  path: string;
  webhookSecret: string;
  body: unknown;
  method?: "GET" | "POST";
  fetch?: typeof globalThis.fetch;
  retryDelaysMs?: SignedRequestRetryDelays;
};

type SignedPostOptions = Omit<SignedRequestOptions, "method"> & {
  validateResponse?: (value: unknown) => boolean;
};

// Cold hydration (no stored snapshot yet) replays the full journal from
// revision 0, so it must stay a small-repo affordance: a slug whose record set
// outgrows this bound has earned a real snapshot and still refuses cutover.
// 2000 small records is ~10 export pages and covers hundreds of reviewed items,
// giving a newly onboarded repository long runway before the first manual
// snapshot sweep is required.
export const COLD_HYDRATION_MAX_RECORDS = 2000;

export class WorkerRecordExportBoundError extends Error {
  readonly repoSlug: string;
  readonly received: number;
  readonly maxRecords: number;

  constructor(repoSlug: string, received: number, maxRecords: number) {
    super(
      `Worker record export for ${repoSlug} exceeded the ${maxRecords}-record bound (received ${received} before aborting)`,
    );
    this.name = "WorkerRecordExportBoundError";
    this.repoSlug = repoSlug;
    this.received = received;
    this.maxRecords = maxRecords;
  }
}

export async function exportWorkerRecords(options: {
  baseUrl: string;
  webhookSecret: string;
  repoSlug: string;
  sections?: readonly RecordSection[];
  sinceRevision?: number;
  limit?: number;
  maxRecords?: number;
  fetch?: typeof globalThis.fetch;
}): Promise<WorkerRecordSnapshot> {
  const sections = options.sections ?? RECORD_SECTIONS;
  const sinceRevision = options.sinceRevision ?? 0;
  const records = new Map<string, WorkerRecord>();
  let cursor: number | null = 0;
  let revision = sinceRevision;
  let exportStartRevision: number | undefined;
  do {
    const page = await signedWorkerRecordReadPost<ExportPage>({
      baseUrl: options.baseUrl,
      path: "/internal/state/records/export",
      webhookSecret: options.webhookSecret,
      body: {
        repoSlug: options.repoSlug,
        sections,
        sinceRevision,
        cursor,
        limit: options.limit ?? 200,
      },
      fetch: options.fetch,
      validateResponse: (value) => {
        const page = value as Partial<ExportPage> | null;
        if (
          typeof page === "object" &&
          page !== null &&
          !Array.isArray(page) &&
          page.repoSlug === options.repoSlug &&
          Number.isSafeInteger(page.revision) &&
          Number(page.revision) >= 0 &&
          Array.isArray(page.records) &&
          (page.nextCursor === null ||
            (Number.isSafeInteger(page.nextCursor) &&
              Number(page.nextCursor) >= 1 &&
              page.nextCursor !== cursor))
        ) {
          try {
            for (const record of page.records) validateWorkerRecord(record);
            return true;
          } catch {
            return false;
          }
        }
        return false;
      },
    });
    if (page.repoSlug !== options.repoSlug || !Number.isSafeInteger(page.revision)) {
      throw new Error("Worker returned an invalid record export envelope");
    }
    // Only the first page's watermark is safe for a new snapshot: later pages
    // may observe writes to records whose earlier revisions were already read.
    exportStartRevision ??= page.revision;
    revision = Math.max(revision, page.revision);
    for (const record of page.records) {
      validateWorkerRecord(record);
      const key = `${record.section}/${record.id}`;
      const prior = records.get(key);
      if (!prior || prior.storeRevision < record.storeRevision) records.set(key, record);
    }
    // Abort mid-pagination: the bound exists so an unsnapshotted large repo
    // never triggers an unbounded full-journal download.
    if (options.maxRecords !== undefined && records.size > options.maxRecords) {
      throw new WorkerRecordExportBoundError(options.repoSlug, records.size, options.maxRecords);
    }
    if (
      page.nextCursor !== null &&
      (!Number.isSafeInteger(page.nextCursor) || page.nextCursor < 1)
    ) {
      throw new Error("Worker returned an invalid record export cursor");
    }
    if (page.nextCursor !== null && page.nextCursor === cursor) {
      throw new Error("Worker record export cursor did not advance");
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  return {
    repoSlug: options.repoSlug,
    revision,
    exportStartRevision: exportStartRevision!,
    records: [...records.values()].sort((left, right) =>
      recordRelativePath(left).localeCompare(recordRelativePath(right)),
    ),
  };
}

export async function materializeWorkerRecords(options: {
  worktreeRoot: string;
  baseUrl: string;
  webhookSecret: string;
  repoSlugs: readonly string[];
  cacheRoot?: string;
  fetch?: typeof globalThis.fetch;
  log?: (line: string) => void;
}) {
  const log = options.log ?? ((line: string) => console.error(line));
  mkdirSync(options.worktreeRoot, { recursive: true });
  const recordsRoot = path.join(options.worktreeRoot, "records");
  const cacheRoot = path.resolve(
    options.cacheRoot ?? path.join(options.worktreeRoot, ".artifacts", "worker-records-cache"),
  );
  mkdirSync(cacheRoot, { recursive: true });
  const stagingRoot = mkdtempSync(path.join(options.worktreeRoot, ".worker-records-stage-"));
  const stagedRecordsRoot = path.join(stagingRoot, "records");
  mkdirSync(stagedRecordsRoot, { recursive: true });
  const repositories: Record<
    string,
    {
      revision: number;
      exportStartRevision: number;
      snapshotRevision: number;
      snapshotBytes: number;
      snapshotCache: "hit" | "miss" | "cold";
      deltaRecords: number;
      recordCount: number;
      coverageTrackedItemIds: number[];
    }
  > = {};
  try {
    for (const repoSlug of options.repoSlugs) {
      try {
        validateRepoSlug(repoSlug);
        const storedSnapshot = await fetchWorkerStoredSnapshot({
          baseUrl: options.baseUrl,
          webhookSecret: options.webhookSecret,
          repoSlug,
          fetch: options.fetch,
        }).catch((error: unknown) => {
          // A slug whose records were all created canonically after the last
          // snapshot sweep has no snapshot yet. That is a cold slug, not an
          // outage: hydrate it purely from the journal below instead of
          // refusing the whole multi-slug run. Store outages still refuse.
          if (
            error instanceof WorkerSnapshotUnavailableError &&
            error.reason === "snapshot_not_found"
          ) {
            return null;
          }
          throw error;
        });
        const stagedRepoRoot = path.join(stagedRecordsRoot, repoSlug);
        let snapshotBytes = 0;
        let snapshotCache: "hit" | "miss" | "cold" = "cold";
        if (storedSnapshot) {
          const cached = await ensureSnapshotCache({
            cacheRoot,
            baseUrl: options.baseUrl,
            webhookSecret: options.webhookSecret,
            snapshot: storedSnapshot,
            fetch: options.fetch,
          });
          cpSync(cached.treeRoot, stagedRepoRoot, { recursive: true });
          snapshotBytes = storedSnapshot.bytes;
          snapshotCache = cached.cache;
        } else {
          mkdirSync(stagedRepoRoot, { recursive: true });
        }
        const journal = await exportWorkerRecords({
          baseUrl: options.baseUrl,
          webhookSecret: options.webhookSecret,
          repoSlug,
          sinceRevision: storedSnapshot?.revisionWatermark ?? 0,
          ...(storedSnapshot ? {} : { maxRecords: COLD_HYDRATION_MAX_RECORDS }),
          fetch: options.fetch,
        }).catch((error: unknown) => {
          // Over the bound, the named refusal returns: the operator must run a
          // snapshot sweep for this slug before worker hydration accepts it.
          if (error instanceof WorkerRecordExportBoundError) {
            throw new WorkerSnapshotUnavailableError(
              "snapshot_not_found",
              {
                endpoint: "/internal/state/records/export",
                code: "cold_hydration_bound_exceeded",
                bodySnippet: `cold slug journal exceeded ${error.maxRecords} records; trigger a snapshot for this repository`,
              },
              { cause: error },
            );
          }
          throw error;
        });
        applyWorkerRecords(stagedRepoRoot, journal.records);
        const coverageTrackedItemIds = await fetchWorkerCanonicalItemIds({
          baseUrl: options.baseUrl,
          webhookSecret: options.webhookSecret,
          repoSlug,
          fetch: options.fetch,
        });
        repositories[repoSlug] = {
          revision: journal.revision,
          exportStartRevision: journal.exportStartRevision,
          snapshotRevision: storedSnapshot?.revisionWatermark ?? 0,
          snapshotBytes,
          snapshotCache,
          deltaRecords: journal.records.length,
          recordCount: countMaterializedRecords(stagingRoot, repoSlug),
          coverageTrackedItemIds,
        };
        const entry = repositories[repoSlug];
        log(
          storedSnapshot
            ? `[worker-records] snapshot hydrated repo=${repoSlug} revision=${entry.revision} snapshotRevision=${entry.snapshotRevision} snapshotBytes=${entry.snapshotBytes} cache=${entry.snapshotCache} deltaRecords=${entry.deltaRecords} records=${entry.recordCount} coverageTrackedItems=${entry.coverageTrackedItemIds.length}`
            : `[worker-records] COLD HYDRATION repo=${repoSlug}: no stored snapshot, replayed the full journal from revision 0 (revision=${entry.revision} journalRecords=${entry.deltaRecords} records=${entry.recordCount} coverageTrackedItems=${entry.coverageTrackedItemIds.length} bound=${COLD_HYDRATION_MAX_RECORDS}); trigger a snapshot sweep to make future hydrations incremental`,
        );
      } catch (error) {
        // Re-wrap so the refusal that aborts a multi-slug hydration names the
        // failing slug and how many slugs had already hydrated cleanly.
        if (error instanceof WorkerSnapshotUnavailableError) {
          throw new WorkerSnapshotUnavailableError(
            error.reason,
            { repoSlug, ...error.detail, succeededSlugs: Object.keys(repositories).length },
            { cause: error.cause ?? error },
          );
        }
        throw error;
      }
    }
    rmSync(recordsRoot, { force: true, recursive: true });
    renameSync(stagedRecordsRoot, recordsRoot);
  } finally {
    rmSync(stagingRoot, { force: true, recursive: true });
  }
  const manifestPath = writeWorkerRecordsManifest(options.worktreeRoot, repositories);
  return { recordsRoot, manifestPath, repositories };
}

export async function materializeWorkerItems(options: {
  worktreeRoot: string;
  baseUrl: string;
  webhookSecret: string;
  repoSlug: string;
  itemNumbers: readonly number[];
  fetch?: typeof globalThis.fetch;
}) {
  validateRepoSlug(options.repoSlug);
  const itemNumbers = [...new Set(options.itemNumbers)].sort((a, b) => a - b);
  if (
    !itemNumbers.length ||
    itemNumbers.some((number) => !Number.isSafeInteger(number) || number < 1)
  ) {
    throw new Error("Worker record item numbers must be positive safe integers");
  }

  mkdirSync(options.worktreeRoot, { recursive: true });
  const recordsRoot = path.join(options.worktreeRoot, "records");
  const stagingRoot = mkdtempSync(path.join(options.worktreeRoot, ".worker-records-stage-"));
  const stagedRecordsRoot = path.join(stagingRoot, "records");
  const previousRecordsRoot = path.join(stagingRoot, "previous-records");
  const records: Array<{ section: string; id: number; content: string; revision: number }> = [];
  let replacementInstalled = false;
  let previousRecordsMoved = false;
  try {
    for (const id of itemNumbers) {
      for (const section of ["items", "closed", "plans", "decision-packets"] as const) {
        let record: { content: string; digest: string; revision: number };
        try {
          record = await signedGet({
            baseUrl: options.baseUrl,
            path: `/internal/state/records/${options.repoSlug}/${section}/${id}`,
            webhookSecret: options.webhookSecret,
            fetch: options.fetch,
          });
        } catch (error) {
          if (
            error instanceof WorkerRecordRequestError &&
            error.status === 404 &&
            error.code === "record_not_found"
          )
            continue;
          throw error;
        }
        if (createHash("sha256").update(record.content).digest("hex") !== record.digest) {
          throw new Error("Worker record digest does not match its content");
        }
        const extension = section === "decision-packets" ? "json" : "md";
        const recordPath = path.join(
          stagedRecordsRoot,
          options.repoSlug,
          section,
          `${id}.${extension}`,
        );
        mkdirSync(path.dirname(recordPath), { recursive: true });
        writeFileSync(recordPath, record.content, "utf8");
        records.push({ section, id, content: record.content, revision: record.revision });
      }
    }
    mkdirSync(stagedRecordsRoot, { recursive: true });
    if (existsSync(recordsRoot)) {
      renameSync(recordsRoot, previousRecordsRoot);
      previousRecordsMoved = true;
    }
    try {
      renameSync(stagedRecordsRoot, recordsRoot);
      replacementInstalled = true;
    } catch (error) {
      if (previousRecordsMoved) renameSync(previousRecordsRoot, recordsRoot);
      throw error;
    }
  } finally {
    if (!previousRecordsMoved || replacementInstalled || existsSync(recordsRoot)) {
      rmSync(stagingRoot, { force: true, recursive: true });
    }
  }
  const repositories = {
    [options.repoSlug]: {
      revision: Math.max(0, ...records.map((record) => record.revision)),
      snapshotRevision: 0,
      snapshotBytes: 0,
      snapshotCache: "direct" as const,
      deltaRecords: records.length,
      recordCount: records.length,
      coverageTrackedItemIds: records
        .filter((record) => record.section === "items")
        .map((record) => record.id),
    },
  };
  const manifestPath = writeWorkerRecordsManifest(options.worktreeRoot, repositories);
  console.error(
    `[worker-records] focused tuples hydrated repo=${options.repoSlug} items=${itemNumbers.length} records=${records.length}`,
  );
  return { recordsRoot, manifestPath, repositories };
}

function writeWorkerRecordsManifest(worktreeRoot: string, repositories: Record<string, unknown>) {
  const manifestPath = path.join(worktreeRoot, ".artifacts", "worker-records-manifest.json");
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(
    manifestPath,
    `${JSON.stringify({ schemaVersion: WORKER_RECORDS_MANIFEST_SCHEMA_VERSION, source: "worker", repositories }, null, 2)}\n`,
    "utf8",
  );
  return manifestPath;
}

export async function fetchWorkerStoredSnapshot(options: {
  baseUrl: string;
  webhookSecret: string;
  repoSlug: string;
  fetch?: typeof globalThis.fetch;
}): Promise<WorkerStoredSnapshot> {
  const endpoint = "/internal/state/records/snapshots/latest";
  try {
    const envelope = await signedWorkerRecordReadPost<{
      snapshotStoreAvailable: boolean;
      snapshot: WorkerStoredSnapshot;
    }>({
      ...options,
      path: endpoint,
      body: { repoSlug: options.repoSlug },
      validateResponse: (value) => {
        const candidate = value as { snapshotStoreAvailable?: unknown; snapshot?: unknown } | null;
        if (
          typeof candidate !== "object" ||
          candidate === null ||
          Array.isArray(candidate) ||
          candidate.snapshotStoreAvailable !== true
        ) {
          return false;
        }
        try {
          validateStoredSnapshot(candidate.snapshot, options.repoSlug);
          return true;
        } catch {
          return false;
        }
      },
    });
    validateStoredSnapshot(envelope.snapshot, options.repoSlug);
    return envelope.snapshot;
  } catch (error) {
    if (
      error instanceof WorkerRecordRequestError &&
      (error.code === "snapshot_store_unavailable" || error.code === "snapshot_not_found")
    ) {
      // Preserve the request evidence: which repo, which endpoint, and what
      // the Worker actually said. A bare reason is undebuggable at cutover.
      throw new WorkerSnapshotUnavailableError(
        error.code,
        {
          repoSlug: options.repoSlug,
          endpoint,
          status: error.status,
          code: error.code,
          bodySnippet: error.bodySnippet,
        },
        { cause: error },
      );
    }
    throw error;
  }
}

export async function resolveWorkerSnapshotCacheKey(options: {
  baseUrl: string;
  webhookSecret: string;
  repoSlugs: readonly string[];
  fetch?: typeof globalThis.fetch;
}) {
  const snapshots = [] as WorkerStoredSnapshot[];
  const coldSlugs: string[] = [];
  for (const repoSlug of [...options.repoSlugs].sort()) {
    try {
      snapshots.push(await fetchWorkerStoredSnapshot({ ...options, repoSlug }));
    } catch (error) {
      if (error instanceof WorkerSnapshotUnavailableError) {
        // A snapshot-less (cold) slug contributes nothing to the snapshot
        // cache, so it must not invalidate the cache key for the whole fleet;
        // hydration cold-hydrates it from the journal. Store outages still throw.
        if (error.reason === "snapshot_not_found") {
          coldSlugs.push(repoSlug);
          continue;
        }
        throw new WorkerSnapshotUnavailableError(
          error.reason,
          { repoSlug, ...error.detail, succeededSlugs: snapshots.length },
          { cause: error.cause ?? error },
        );
      }
      throw error;
    }
  }
  const pairs = snapshots.map((snapshot) => `${snapshot.repoSlug}:${snapshot.revisionWatermark}`);
  return {
    snapshots,
    coldSlugs,
    key: createHash("sha256").update(pairs.join("\n")).digest("hex").slice(0, 24),
    pairs,
  };
}

export async function discoverWorkerRecordRepoSlugs(options: {
  baseUrl: string;
  webhookSecret: string;
  fetch?: typeof globalThis.fetch;
}): Promise<Array<{ repoSlug: string; revision: number }>> {
  const endpoint = "/internal/state/records/slugs";
  let envelope: { repositories?: unknown };
  try {
    envelope = await signedWorkerRecordReadPost<{ repositories?: unknown }>({
      baseUrl: options.baseUrl,
      path: endpoint,
      webhookSecret: options.webhookSecret,
      body: {},
      fetch: options.fetch,
      validateResponse: (value) => {
        const candidate = value as { repositories?: unknown } | null;
        if (
          typeof candidate === "object" &&
          candidate !== null &&
          !Array.isArray(candidate) &&
          Array.isArray(candidate.repositories)
        ) {
          return candidate.repositories.every((entry) => {
            const repository = entry as { repoSlug?: unknown; revision?: unknown } | null;
            return (
              typeof repository === "object" &&
              repository !== null &&
              !Array.isArray(repository) &&
              typeof repository.repoSlug === "string" &&
              isRepoSlug(repository.repoSlug) &&
              Number.isSafeInteger(repository.revision) &&
              Number(repository.revision) >= 0
            );
          });
        }
        return false;
      },
    });
  } catch (error) {
    // The canonical slug list is mandatory; surface request failures as a
    // canonical-store outage instead of consulting retired Git records.
    if (error instanceof WorkerRecordRequestError) {
      throw new WorkerSnapshotUnavailableError(
        "snapshot_store_unavailable",
        { endpoint, status: error.status, code: error.code, bodySnippet: error.bodySnippet },
        { cause: error },
      );
    }
    throw error;
  }
  if (!Array.isArray(envelope.repositories)) {
    throw new Error("Worker returned an invalid record slug envelope");
  }
  const repositories = envelope.repositories.map((value) => {
    const entry = value as { repoSlug?: unknown; revision?: unknown };
    if (
      !entry ||
      typeof entry.repoSlug !== "string" ||
      !isRepoSlug(entry.repoSlug) ||
      !Number.isSafeInteger(entry.revision) ||
      (entry.revision as number) < 0
    ) {
      throw new Error("Worker returned an invalid record slug entry");
    }
    return { repoSlug: entry.repoSlug, revision: entry.revision as number };
  });
  return repositories.sort((left, right) => left.repoSlug.localeCompare(right.repoSlug));
}

export async function fetchWorkerCanonicalItemIds(options: {
  baseUrl: string;
  webhookSecret: string;
  repoSlug: string;
  fetch?: typeof globalThis.fetch;
}): Promise<number[]> {
  const itemIds: number[] = [];
  const seen = new Set<number>();
  let nextCursor: number | null = 0;
  while (nextCursor !== null) {
    const cursor = nextCursor;
    const page = await signedWorkerRecordReadPost<{
      repoSlug: string;
      section: string;
      records: Array<{ id: number }>;
      nextCursor: number | null;
    }>({
      baseUrl: options.baseUrl,
      path: "/internal/state/records/list",
      webhookSecret: options.webhookSecret,
      body: { repoSlug: options.repoSlug, section: "items", cursor, limit: 500 },
      fetch: options.fetch,
      validateResponse: (value) => {
        const candidate = value as {
          repoSlug?: unknown;
          section?: unknown;
          records?: unknown;
          nextCursor?: unknown;
        } | null;
        if (
          typeof candidate === "object" &&
          candidate !== null &&
          !Array.isArray(candidate) &&
          candidate.repoSlug === options.repoSlug &&
          candidate.section === "items" &&
          Array.isArray(candidate.records)
        ) {
          const pageIds: number[] = [];
          let previousId = cursor;
          for (const record of candidate.records) {
            const itemId = (record as { id?: unknown } | null)?.id;
            if (
              typeof itemId !== "number" ||
              !Number.isSafeInteger(itemId) ||
              itemId <= previousId ||
              seen.has(itemId)
            ) {
              return false;
            }
            pageIds.push(itemId);
            previousId = itemId;
          }
          return (
            candidate.nextCursor === null ||
            (Number.isSafeInteger(candidate.nextCursor) &&
              Number(candidate.nextCursor) > cursor &&
              candidate.nextCursor === pageIds.at(-1))
          );
        }
        return false;
      },
    });
    if (
      page.repoSlug !== options.repoSlug ||
      page.section !== "items" ||
      !Array.isArray(page.records)
    ) {
      throw new Error("Worker returned an invalid canonical item listing");
    }
    for (const record of page.records) {
      const itemId = Number(record?.id);
      if (!Number.isSafeInteger(itemId) || itemId <= cursor || seen.has(itemId)) {
        throw new Error("Worker returned an invalid canonical item identity");
      }
      seen.add(itemId);
      itemIds.push(itemId);
    }
    if (page.nextCursor === null) {
      nextCursor = null;
      continue;
    }
    if (
      !Number.isSafeInteger(page.nextCursor) ||
      page.nextCursor <= cursor ||
      page.nextCursor !== itemIds.at(-1)
    ) {
      throw new Error("Worker returned an invalid canonical item cursor");
    }
    nextCursor = page.nextCursor;
  }
  return itemIds;
}

function countMaterializedRecords(root: string, repoSlug: string): number {
  const repoRoot = path.join(root, "records", repoSlug);
  if (!existsSync(repoRoot)) return 0;
  return RECORD_SECTIONS.reduce((total, section) => {
    const directory = path.join(repoRoot, section);
    if (!existsSync(directory)) return total;
    const extension = recordExtension(section);
    return (
      total +
      readdirSync(directory, { withFileTypes: true }).filter(
        (entry) => entry.isFile() && entry.name.endsWith(extension),
      ).length
    );
  }, 0);
}

async function ensureSnapshotCache(options: {
  cacheRoot: string;
  baseUrl: string;
  webhookSecret: string;
  snapshot: WorkerStoredSnapshot;
  fetch?: typeof globalThis.fetch;
}) {
  const cachePath = path.join(
    options.cacheRoot,
    options.snapshot.repoSlug,
    String(options.snapshot.revisionWatermark),
  );
  const treeRoot = path.join(cachePath, "tree");
  const manifestPath = path.join(cachePath, "snapshot.json");
  if (validSnapshotCache(manifestPath, treeRoot, options.snapshot)) {
    return { cache: "hit" as const, treeRoot };
  }

  rmSync(cachePath, { force: true, recursive: true });
  mkdirSync(path.dirname(cachePath), { recursive: true });
  const temporaryRoot = mkdtempSync(path.join(path.dirname(cachePath), ".download-"));
  const archivePath = path.join(temporaryRoot, "snapshot.tar.gz");
  const temporaryTree = path.join(temporaryRoot, "tree");
  mkdirSync(temporaryTree, { recursive: true });
  try {
    await downloadWorkerSnapshot({ ...options, archivePath });
    const unpacked = spawnSync("tar", ["-xzf", archivePath, "-C", temporaryTree], {
      encoding: "utf8",
    });
    if (unpacked.status !== 0) {
      throw new Error(`Snapshot archive could not be unpacked: ${unpacked.stderr.trim()}`);
    }
    const fileCount = validateSnapshotTree(temporaryTree);
    if (fileCount !== options.snapshot.fileCount) {
      throw new Error(
        `Snapshot file count mismatch: expected ${options.snapshot.fileCount}, received ${fileCount}`,
      );
    }
    mkdirSync(cachePath, { recursive: true });
    renameSync(temporaryTree, treeRoot);
    writeFileSync(
      manifestPath,
      `${JSON.stringify({
        schemaVersion: 1,
        repoSlug: options.snapshot.repoSlug,
        revisionWatermark: options.snapshot.revisionWatermark,
        bytes: options.snapshot.bytes,
        fileCount: options.snapshot.fileCount,
      })}\n`,
      "utf8",
    );
    return { cache: "miss" as const, treeRoot };
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

function validSnapshotCache(
  manifestPath: string,
  treeRoot: string,
  snapshot: WorkerStoredSnapshot,
) {
  if (!existsSync(manifestPath) || !existsSync(treeRoot)) return false;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    return (
      manifest.schemaVersion === 1 &&
      manifest.repoSlug === snapshot.repoSlug &&
      manifest.revisionWatermark === snapshot.revisionWatermark &&
      manifest.bytes === snapshot.bytes &&
      manifest.fileCount === snapshot.fileCount &&
      validateSnapshotTree(treeRoot) === snapshot.fileCount
    );
  } catch {
    return false;
  }
}

export async function downloadWorkerSnapshot(options: {
  archivePath: string;
  baseUrl: string;
  webhookSecret: string;
  snapshot: WorkerStoredSnapshot;
  fetch?: typeof globalThis.fetch;
}) {
  const descriptor = openSync(options.archivePath, "wx");
  let offset = 0;
  try {
    while (offset < options.snapshot.bytes) {
      const length = Math.min(
        options.snapshot.access.maxChunkBytes,
        options.snapshot.bytes - offset,
      );
      const bytes = await fetchWorkerSnapshotChunk({
        ...options,
        offset,
        length,
      });
      writeSync(descriptor, bytes);
      offset += bytes.byteLength;
    }
  } finally {
    closeSync(descriptor);
  }
}

async function fetchWorkerSnapshotChunk(options: {
  baseUrl: string;
  webhookSecret: string;
  snapshot: WorkerStoredSnapshot;
  offset: number;
  length: number;
  fetch?: typeof globalThis.fetch;
}) {
  const expectedRange = `bytes ${options.offset}-${options.offset + options.length - 1}/${options.snapshot.bytes}`;
  const startedAt = Date.now();
  const diagnosticOptions = {
    path: "/internal/state/records/snapshots/chunk",
    body: {
      repoSlug: options.snapshot.repoSlug,
      revisionWatermark: options.snapshot.revisionWatermark,
      offset: options.offset,
      length: options.length,
    },
  };
  for (let attempt = 1; ; attempt += 1) {
    let response: Response;
    try {
      response = await signedRequestWithMaxAttempts(
        {
          baseUrl: options.baseUrl,
          path: "/internal/state/records/snapshots/chunk",
          webhookSecret: options.webhookSecret,
          body: {
            repoSlug: options.snapshot.repoSlug,
            revisionWatermark: options.snapshot.revisionWatermark,
            offset: options.offset,
            length: options.length,
          },
          fetch: options.fetch,
          retryDelaysMs: WORKER_RECORD_READ_RETRY_DELAYS_MS,
        },
        1,
      );
    } catch (error) {
      recordReadDiagnostic(
        diagnosticOptions,
        attempt,
        startedAt,
        error instanceof RetryableSignedRequestError ? "transport" : "configuration",
        error instanceof RetryableSignedRequestError && attempt < SIGNED_REQUEST_MAX_ATTEMPTS,
      );
      if (!(error instanceof RetryableSignedRequestError)) throw error;
      if (attempt >= SIGNED_REQUEST_MAX_ATTEMPTS) throw error.cause;
      await signedRequestBackoff(attempt, WORKER_RECORD_READ_RETRY_DELAYS_MS);
      continue;
    }

    if (!response.ok) {
      recordReadDiagnostic(
        diagnosticOptions,
        attempt,
        startedAt,
        "http_error",
        response.status >= 500 && attempt < SIGNED_REQUEST_MAX_ATTEMPTS,
        response.status,
      );
      const bodyText = await response.text().catch(() => "");
      if (response.status >= 500 && attempt < SIGNED_REQUEST_MAX_ATTEMPTS) {
        await signedRequestBackoff(attempt, WORKER_RECORD_READ_RETRY_DELAYS_MS);
        continue;
      }
      throw workerRequestError(response.status, bodyText);
    }

    let bytes: Uint8Array | undefined;
    let protocolError: Error | undefined;
    if (response.status !== 206) {
      protocolError = new Error(`Worker snapshot chunk returned status ${response.status}`);
    } else if (response.headers.get("content-range") !== expectedRange) {
      protocolError = new Error("Worker snapshot chunk returned an invalid content range");
    } else {
      try {
        bytes = new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        protocolError = error instanceof Error ? error : new Error(String(error));
      }
      if (bytes !== undefined && bytes.byteLength !== options.length) {
        protocolError = new Error(
          `Worker snapshot chunk length mismatch: expected ${options.length}, received ${bytes.byteLength}`,
        );
      }
    }

    if (protocolError === undefined && bytes !== undefined) return bytes;
    recordReadDiagnostic(
      diagnosticOptions,
      attempt,
      startedAt,
      "invalid_response",
      attempt < SIGNED_REQUEST_MAX_ATTEMPTS,
      response.status,
    );
    await response.body?.cancel().catch(() => {});
    if (attempt >= SIGNED_REQUEST_MAX_ATTEMPTS) throw protocolError;
    await signedRequestBackoff(attempt, WORKER_RECORD_READ_RETRY_DELAYS_MS);
  }
}

function validateStoredSnapshot(snapshot: WorkerStoredSnapshot, repoSlug: string) {
  if (
    !snapshot ||
    snapshot.repoSlug !== repoSlug ||
    !Number.isSafeInteger(snapshot.revisionWatermark) ||
    snapshot.revisionWatermark < 0 ||
    !Number.isSafeInteger(snapshot.bytes) ||
    snapshot.bytes < 1 ||
    !Number.isSafeInteger(snapshot.fileCount) ||
    snapshot.fileCount < 0 ||
    !snapshot.access ||
    snapshot.access.mode !== "worker_range_proxy" ||
    !Number.isSafeInteger(snapshot.access.maxChunkBytes) ||
    snapshot.access.maxChunkBytes < 1 ||
    snapshot.access.maxChunkBytes > 32 * 1024 * 1024
  ) {
    throw new Error("Worker returned an invalid snapshot envelope");
  }
}

export async function packWorkerRecordSnapshot(options: { repoRoot: string; archivePath: string }) {
  const fileCount = validateSnapshotTree(options.repoRoot);
  if (fileCount > SNAPSHOT_MAX_IDENTITIES)
    throw new Error("Snapshot exceeds the 250,000 identity limit");
  const identities: SnapshotIdentity[] = [];
  let uncompressedBytes = 0;
  async function* chunks() {
    for (const section of RECORD_SECTIONS) {
      const directory = path.join(options.repoRoot, section);
      if (!existsSync(directory)) continue;
      for (const name of readdirSync(directory).sort()) {
        const filename = path.join(directory, name);
        const size = statSync(filename).size;
        yield tarHeader(`${section}/${name}`, size);
        yield* createReadStream(filename);
        const padding = (512 - (size % 512)) % 512;
        if (padding) yield new Uint8Array(padding);
        uncompressedBytes += size;
        identities.push([section, name.slice(0, -recordExtension(section).length)]);
      }
    }
    yield new Uint8Array(1024);
  }
  await pipeline(Readable.from(chunks()), createGzip(), createWriteStream(options.archivePath));
  identities.sort((a, b) => (snapshotIdentityKey(a) < snapshotIdentityKey(b) ? -1 : 1));
  return {
    archivePath: options.archivePath,
    bytes: statSync(options.archivePath).size,
    uncompressedBytes,
    fileCount,
    identities,
    identityDigest: createHash("sha256").update(JSON.stringify(identities)).digest("hex"),
  };
}

function validateSnapshotTree(treeRoot: string) {
  let fileCount = 0;
  for (const entry of readdirSync(treeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !RECORD_SECTIONS.includes(entry.name as RecordSection)) {
      throw new Error(`Snapshot archive contains an invalid root entry: ${entry.name}`);
    }
    const section = entry.name as RecordSection;
    const extension = recordExtension(section);
    for (const record of readdirSync(path.join(treeRoot, section), { withFileTypes: true })) {
      if (!record.isFile() || !record.name.endsWith(extension)) {
        throw new Error(`Snapshot archive contains an invalid record entry: ${record.name}`);
      }
      validateRecordId(section, record.name.slice(0, -extension.length));
      fileCount += 1;
    }
  }
  return fileCount;
}

function applyWorkerRecords(repoRoot: string, records: readonly WorkerRecord[]) {
  for (const record of records) {
    const destination = path.join(repoRoot, recordRelativePath(record));
    if (record.deleted) {
      rmSync(destination, { force: true });
      continue;
    }
    if (record.content === null)
      throw new Error(`Worker record is missing content: ${destination}`);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, record.content, "utf8");
  }
}

function signedWorkerRecordReadPost<T>(options: SignedPostOptions): Promise<T> {
  return signedPostWithRetryMode<T>(
    { ...options, retryDelaysMs: WORKER_RECORD_READ_RETRY_DELAYS_MS },
    true,
  );
}

function recordReadDiagnostic(
  options: { path: string; body?: unknown },
  attempt: number,
  startedAt: number,
  category: "transport" | "configuration" | "http_error" | "invalid_response",
  retry: boolean,
  status?: number,
) {
  const endpoints: Record<string, string> = {
    "/internal/state/records/slugs": "records_slugs",
    "/internal/state/records/list": "records_list",
    "/internal/state/records/export": "records_export",
    "/internal/state/records/snapshots/latest": "snapshots_latest",
    "/internal/state/records/snapshots/chunk": "snapshots_chunk",
  };
  const item =
    /^\/internal\/state\/records\/([a-z0-9-]+)\/(?:items|closed|plans|decision-packets)\/[1-9]\d*$/.exec(
      options.path,
    );
  const endpoint = endpoints[options.path] ?? (item ? "records_item" : undefined);
  if (!endpoint) return;
  const body =
    options.body !== null && typeof options.body === "object"
      ? (options.body as Record<string, unknown>)
      : {};
  const repoSlug = body.repoSlug ?? item?.[1];
  const coordinates: Record<string, string | number> = {};
  if (typeof repoSlug === "string" && repoSlug.length <= 200 && isRepoSlug(repoSlug)) {
    coordinates.repoSlug = repoSlug;
  }
  for (const key of ["cursor", "sinceRevision", "revisionWatermark", "offset", "length"] as const) {
    const value = body[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
      coordinates[key] = value;
    }
  }
  // At most three events per read; never include remote text, URLs or credentials.
  console.error(
    `[worker-record-read] ${JSON.stringify({
      event: retry ? "retry" : "failure",
      endpoint,
      ...coordinates,
      attempt,
      maxAttempts: SIGNED_REQUEST_MAX_ATTEMPTS,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      category,
      ...(status === undefined ? {} : { status }),
      delayMs: retry ? WORKER_RECORD_READ_RETRY_DELAYS_MS[attempt - 1] : 0,
    })}`,
  );
}

export async function signedPost<T>(options: SignedPostOptions): Promise<T> {
  return signedPostWithRetryMode<T>(options, false);
}

async function signedPostWithRetryMode<T>(
  options: SignedPostOptions,
  unifiedAttemptBudget: boolean,
): Promise<T> {
  const startedAt = Date.now();
  for (let attempt = 1; ; attempt += 1) {
    let response: Response;
    try {
      response = unifiedAttemptBudget
        ? await signedRequestWithMaxAttempts(options, 1)
        : await signedRequest(options);
    } catch (error) {
      if (unifiedAttemptBudget) {
        recordReadDiagnostic(
          options,
          attempt,
          startedAt,
          error instanceof RetryableSignedRequestError ? "transport" : "configuration",
          error instanceof RetryableSignedRequestError && attempt < SIGNED_REQUEST_MAX_ATTEMPTS,
        );
      }
      if (!(error instanceof RetryableSignedRequestError) || !unifiedAttemptBudget) throw error;
      if (attempt >= SIGNED_REQUEST_MAX_ATTEMPTS) throw error.cause;
      await signedRequestBackoff(attempt, options.retryDelaysMs);
      continue;
    }
    // Read the body exactly once; a Response body is a one-shot stream and a
    // later clone() of a consumed response throws, masking the real failure.
    const bodyText = await response.text().catch(() => "");
    if (!response.ok) {
      if (unifiedAttemptBudget) {
        recordReadDiagnostic(
          options,
          attempt,
          startedAt,
          "http_error",
          response.status >= 500 && attempt < SIGNED_REQUEST_MAX_ATTEMPTS,
          response.status,
        );
      }
      if (unifiedAttemptBudget && response.status >= 500 && attempt < SIGNED_REQUEST_MAX_ATTEMPTS) {
        await signedRequestBackoff(attempt, options.retryDelaysMs);
        continue;
      }
      throw workerRequestError(response.status, bodyText);
    }
    let value: unknown;
    try {
      value = JSON.parse(bodyText);
    } catch {
      value = undefined;
    }
    // A 2xx whose body is empty, non-JSON, or a JSON null/primitive (e.g. a
    // literal "null" page) is a protocol violation — every endpoint returns an
    // object envelope. The edge occasionally serves such bodies transiently
    // (observed as blank 200s), so retry within the bounded budget before
    // failing loudly with the status and a body snippet.
    if (
      typeof value !== "object" ||
      value === null ||
      (options.validateResponse !== undefined && !options.validateResponse(value))
    ) {
      if (unifiedAttemptBudget) {
        recordReadDiagnostic(
          options,
          attempt,
          startedAt,
          "invalid_response",
          attempt < SIGNED_REQUEST_MAX_ATTEMPTS,
          response.status,
        );
      }
      if (attempt < SIGNED_REQUEST_MAX_ATTEMPTS) {
        await signedRequestBackoff(attempt, options.retryDelaysMs);
        continue;
      }
      throw new WorkerRecordRequestError(
        response.status,
        "invalid_json_body",
        bodyText.trim().slice(0, 200),
      );
    }
    return value as T;
  }
}

async function signedGet<T>(options: {
  baseUrl: string;
  path: string;
  webhookSecret: string;
  fetch?: typeof globalThis.fetch;
}): Promise<T> {
  const startedAt = Date.now();
  for (let attempt = 1; ; attempt += 1) {
    let response: Response;
    try {
      response = await signedRequestWithMaxAttempts(
        {
          ...options,
          method: "GET",
          body: undefined,
          retryDelaysMs: WORKER_RECORD_READ_RETRY_DELAYS_MS,
        },
        1,
      );
    } catch (error) {
      recordReadDiagnostic(
        options,
        attempt,
        startedAt,
        error instanceof RetryableSignedRequestError ? "transport" : "configuration",
        error instanceof RetryableSignedRequestError && attempt < SIGNED_REQUEST_MAX_ATTEMPTS,
      );
      if (!(error instanceof RetryableSignedRequestError)) throw error;
      if (attempt >= SIGNED_REQUEST_MAX_ATTEMPTS) throw error.cause;
      await signedRequestBackoff(attempt, WORKER_RECORD_READ_RETRY_DELAYS_MS);
      continue;
    }
    const bodyText = await response.text().catch(() => "");
    if (!response.ok) {
      recordReadDiagnostic(
        options,
        attempt,
        startedAt,
        "http_error",
        response.status >= 500 && attempt < SIGNED_REQUEST_MAX_ATTEMPTS,
        response.status,
      );
      if (response.status >= 500 && attempt < SIGNED_REQUEST_MAX_ATTEMPTS) {
        await signedRequestBackoff(attempt, WORKER_RECORD_READ_RETRY_DELAYS_MS);
        continue;
      }
      throw workerRequestError(response.status, bodyText);
    }
    let value: unknown;
    try {
      value = JSON.parse(bodyText);
    } catch {
      value = undefined;
    }
    const envelope = value as
      | { content?: unknown; digest?: unknown; revision?: unknown }
      | null
      | undefined;
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      typeof envelope?.content !== "string" ||
      typeof envelope.digest !== "string" ||
      !Number.isSafeInteger(envelope.revision) ||
      Number(envelope.revision) < 1
    ) {
      recordReadDiagnostic(
        options,
        attempt,
        startedAt,
        "invalid_response",
        attempt < SIGNED_REQUEST_MAX_ATTEMPTS,
        response.status,
      );
      if (attempt < SIGNED_REQUEST_MAX_ATTEMPTS) {
        await signedRequestBackoff(attempt, WORKER_RECORD_READ_RETRY_DELAYS_MS);
        continue;
      }
      throw new WorkerRecordRequestError(
        response.status,
        "invalid_json_body",
        bodyText.trim().slice(0, 200),
      );
    }
    return value as T;
  }
}

const SIGNED_REQUEST_MAX_ATTEMPTS = 3;

class RetryableSignedRequestError extends Error {
  constructor(cause: unknown) {
    super("Signed request fetch failed", { cause });
    this.name = "RetryableSignedRequestError";
  }
}

export async function signedRequest(options: SignedRequestOptions) {
  return signedRequestWithMaxAttempts(options, SIGNED_REQUEST_MAX_ATTEMPTS);
}

async function signedRequestWithMaxAttempts(options: SignedRequestOptions, maxAttempts: number) {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  if (!baseUrl.startsWith("https://") && !baseUrl.startsWith("http://127.0.0.1:")) {
    throw new Error("Worker record URL must use HTTPS");
  }
  if (!options.webhookSecret) throw new Error("Worker records HMAC secret is required");
  const method = options.method ?? "POST";
  const body = method === "GET" ? "" : JSON.stringify(options.body);
  const signature = `sha256=${createHmac("sha256", options.webhookSecret).update(body).digest("hex")}`;
  const performFetch = options.fetch ?? globalThis.fetch;
  // Bounded retry for transient failures: 5xx responses and network errors
  // (GitHub/Cloudflare 502s regularly kill long reconcile/export runs). 4xx
  // responses are deterministic and returned to the caller immediately.
  for (let attempt = 1; ; attempt += 1) {
    let response: Response;
    try {
      response = await performFetch(`${baseUrl}${options.path}`, {
        method,
        headers: {
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
          "x-clawsweeper-exact-review-signature": signature,
        },
        ...(method === "POST" ? { body } : {}),
      });
    } catch (error) {
      if (attempt >= maxAttempts) {
        if (maxAttempts === 1) throw new RetryableSignedRequestError(error);
        throw error;
      }
      await signedRequestBackoff(attempt, options.retryDelaysMs);
      continue;
    }
    if (response.status < 500 || attempt >= maxAttempts) return response;
    await response.body?.cancel().catch(() => {});
    await signedRequestBackoff(attempt, options.retryDelaysMs);
  }
}

function signedRequestBackoff(
  attempt: number,
  retryDelaysMs: SignedRequestRetryDelays = DEFAULT_SIGNED_REQUEST_RETRY_DELAYS_MS,
) {
  const delayMs = retryDelaysMs[attempt - 1];
  if (delayMs === undefined)
    throw new Error(`Missing signed request retry delay for attempt ${attempt}`);
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function workerRequestError(status: number, bodyText: string) {
  let value: unknown = null;
  try {
    value = JSON.parse(bodyText);
  } catch {
    // Non-JSON error body (e.g. an HTML 502 page); fall through to the snippet.
  }
  const code =
    value && typeof value === "object" && "error" in value
      ? String((value as { error: unknown }).error)
      : String(status);
  return new WorkerRecordRequestError(status, code, bodyText.trim().slice(0, 200));
}

function validateWorkerRecord(record: WorkerRecord) {
  if (!RECORD_SECTIONS.includes(record.section)) throw new Error("Worker returned invalid section");
  validateRecordId(record.section, record.id);
  if (!Number.isSafeInteger(record.revision) || record.revision < 0) {
    throw new Error("Worker returned invalid row revision");
  }
  if (!Number.isSafeInteger(record.storeRevision) || record.storeRevision < 1) {
    throw new Error("Worker returned invalid store revision");
  }
  if (record.updatedAt !== undefined && !Number.isFinite(Date.parse(record.updatedAt))) {
    throw new Error("Worker returned invalid record provenance timestamp");
  }
  if (record.deleted) {
    if (record.content !== null || record.digest !== null) {
      throw new Error("Worker returned invalid deletion record");
    }
    return;
  }
  if (typeof record.content !== "string" || !/^[0-9a-f]{64}$/.test(record.digest || "")) {
    throw new Error("Worker returned invalid record content");
  }
  if (sha256(record.content) !== record.digest) throw new Error("Worker record digest mismatch");
}

function recordRelativePath(record: Pick<WorkerRecord, "section" | "id">) {
  return path.join(record.section, `${record.id}${recordExtension(record.section)}`);
}

function validateRecordId(section: RecordSection, id: string) {
  const valid = section === "commits" ? /^[0-9a-f]{40}$/.test(id) : /^[1-9]\d*$/.test(id);
  if (!valid) throw new Error(`Invalid ${section} record id: ${id}`);
}

function validateRepoSlug(value: string) {
  if (!isRepoSlug(value)) throw new Error(`Invalid record repository slug: ${value}`);
}

function isRepoSlug(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(value);
}

function sha256(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

export async function uploadWorkerRecordSnapshot(options: {
  baseUrl: string;
  webhookSecret: string;
  repoSlug: string;
  fetch?: typeof globalThis.fetch;
  log?: (line: string) => void;
}) {
  validateRepoSlug(options.repoSlug);
  const root = mkdtempSync(path.join(tmpdir(), "clawsweeper-snapshot-upload-"));
  let uploadId: string | undefined;
  const operationId =
    process.env.GITHUB_RUN_ID && process.env.GITHUB_RUN_ATTEMPT
      ? `${options.repoSlug}:${process.env.GITHUB_RUN_ID}:${process.env.GITHUB_RUN_ATTEMPT}`
      : randomUUID();
  const post = <T>(operation: string, body: Record<string, unknown>) =>
    signedPost<T>({
      ...options,
      path: `/internal/state/records/snapshots/upload/${operation}`,
      body: { ...body, operation, issuedAt: new Date().toISOString() },
    });
  try {
    const hydrated = await materializeWorkerRecords({
      ...options,
      worktreeRoot: root,
      repoSlugs: [options.repoSlug],
    });
    const packed = await packWorkerRecordSnapshot({
      repoRoot: path.join(hydrated.recordsRoot, options.repoSlug),
      archivePath: path.join(root, "snapshot.tar.gz"),
    });
    if (packed.bytes > RECORD_SNAPSHOT_UPLOAD_MAX_BYTES)
      throw new Error("Snapshot exceeds the 1 GiB upload limit");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(packed.archivePath)) hash.update(chunk);
    const descriptor = {
      repoSlug: options.repoSlug,
      revisionWatermark: hydrated.repositories[options.repoSlug]!.exportStartRevision,
      bytes: packed.bytes,
      uncompressedBytes: packed.uncompressedBytes,
      fileCount: packed.fileCount,
      identityDigest: packed.identityDigest,
      operationId,
      sha256: hash.digest("hex"),
    };
    const started = await post<{
      ok: boolean;
      uploadId: string;
      objectKey: string;
      partBytes: number;
    }>("start", descriptor);
    if (
      started.ok !== true ||
      typeof started.uploadId !== "string" ||
      started.partBytes !== SNAPSHOT_UPLOAD_PART_BYTES ||
      typeof started.objectKey !== "string"
    )
      throw new Error("Worker returned an invalid snapshot upload session");
    uploadId = started.uploadId;
    const parts: Array<{ partNumber: number; etag: string }> = [];
    const file = await open(packed.archivePath, "r");
    try {
      for (let offset = 0, partNumber = 1; offset < packed.bytes; partNumber++) {
        const bytes = Buffer.alloc(Math.min(SNAPSHOT_UPLOAD_PART_BYTES, packed.bytes - offset));
        let read = 0;
        while (read < bytes.length) {
          const result = await file.read(bytes, read, bytes.length - read, offset + read);
          if (result.bytesRead === 0)
            throw new Error("Snapshot archive ended before its declared length");
          read += result.bytesRead;
        }
        const result = await post<{ ok: boolean; part: { partNumber: number; etag: string } }>(
          "part",
          {
            uploadId,
            partNumber,
            data: bytes.toString("base64"),
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        );
        if (
          result.ok !== true ||
          result.part?.partNumber !== partNumber ||
          typeof result.part.etag !== "string" ||
          !result.part.etag
        )
          throw new Error("Worker returned an invalid snapshot part receipt");
        parts.push(result.part);
        offset += bytes.length;
      }
    } finally {
      await file.close();
    }
    const completion: Record<string, unknown> = {
      uploadId,
      parts,
      identities: packed.identities,
    };
    if (
      Buffer.byteLength(
        JSON.stringify({
          ...completion,
          operation: "complete",
          issuedAt: new Date().toISOString(),
        }),
      ) > SNAPSHOT_UPLOAD_JSON_MAX_BYTES
    ) {
      delete completion.identities;
      for (
        let offset = 0, partNumber = 1;
        offset < packed.identities.length;
        offset += SNAPSHOT_MANIFEST_CHUNK_IDENTITIES, partNumber++
      ) {
        await post("manifest", {
          uploadId,
          partNumber,
          identities: packed.identities.slice(offset, offset + SNAPSHOT_MANIFEST_CHUNK_IDENTITIES),
        });
      }
    }
    const result = await post<{ ok: boolean; snapshot: WorkerStoredSnapshot }>(
      "complete",
      completion,
    );
    if (
      result.ok !== true ||
      result.snapshot?.repoSlug !== options.repoSlug ||
      result.snapshot.objectKey !== started.objectKey ||
      result.snapshot.revisionWatermark !== descriptor.revisionWatermark ||
      result.snapshot.bytes !== packed.bytes
    )
      throw new Error("Worker returned an invalid registered snapshot");
    return result.snapshot;
  } catch (error) {
    if (uploadId) await post("abort", { uploadId }).catch(() => undefined);
    throw error;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export async function workerRecordsMain(argv: string[], env: NodeJS.ProcessEnv = process.env) {
  const [command, ...args] = argv;
  if (command !== "snapshot-upload")
    throw new Error(
      "Usage: worker-records.ts snapshot-upload --repo-slug <slug> [--records-url <url>]",
    );
  const { values } = parseArgs({
    args,
    options: { "repo-slug": { type: "string" }, "records-url": { type: "string" } },
    strict: true,
  });
  if (!values["repo-slug"]) throw new Error("--repo-slug is required");
  const webhookSecret = env.CLAWSWEEPER_RECORDS_SECRET ?? env.CLAWSWEEPER_WEBHOOK_SECRET ?? "";
  if (!webhookSecret) throw new Error("CLAWSWEEPER_WEBHOOK_SECRET is required");
  const snapshot = await uploadWorkerRecordSnapshot({
    repoSlug: values["repo-slug"],
    baseUrl:
      values["records-url"] ?? env.CLAWSWEEPER_RECORDS_URL ?? "https://clawsweeper.openclaw.ai",
    webhookSecret,
  });
  console.log(JSON.stringify(snapshot));
  return snapshot;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  workerRecordsMain(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
