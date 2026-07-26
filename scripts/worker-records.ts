import { createHash, createHmac } from "node:crypto";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const RECORD_SECTIONS = ["items", "closed", "plans", "decision-packets", "commits"] as const;
export type RecordSection = (typeof RECORD_SECTIONS)[number];

export type WorkerRecord = {
  section: RecordSection;
  id: string;
  content: string | null;
  digest: string | null;
  revision: number;
  storeRevision: number;
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

export class WorkerSnapshotUnavailableError extends Error {
  readonly reason: "snapshot_store_unavailable" | "snapshot_not_found";

  constructor(reason: "snapshot_store_unavailable" | "snapshot_not_found") {
    super(
      reason === "snapshot_store_unavailable" ? "snapshot store unavailable" : "snapshot not found",
    );
    this.name = "WorkerSnapshotUnavailableError";
    this.reason = reason;
  }
}

class WorkerRecordRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(`Worker record request failed (${status}): ${code}`);
    this.name = "WorkerRecordRequestError";
    this.status = status;
    this.code = code;
  }
}

export async function exportWorkerRecords(options: {
  baseUrl: string;
  webhookSecret: string;
  repoSlug: string;
  sections?: readonly RecordSection[];
  sinceRevision?: number;
  limit?: number;
  fetch?: typeof globalThis.fetch;
}): Promise<WorkerRecordSnapshot> {
  const sections = options.sections ?? RECORD_SECTIONS;
  const sinceRevision = options.sinceRevision ?? 0;
  const records = new Map<string, WorkerRecord>();
  let cursor: number | null = 0;
  let revision = sinceRevision;
  do {
    const page = await signedPost<ExportPage>({
      baseUrl: options.baseUrl,
      path: "/internal/state/records/export",
      webhookSecret: options.webhookSecret,
      body: {
        repoSlug: options.repoSlug,
        sections,
        sinceRevision,
        cursor,
        limit: options.limit ?? 100,
      },
      fetch: options.fetch,
    });
    if (page.repoSlug !== options.repoSlug || !Number.isSafeInteger(page.revision)) {
      throw new Error("Worker returned an invalid record export envelope");
    }
    revision = Math.max(revision, page.revision);
    for (const record of page.records) {
      validateWorkerRecord(record);
      const key = `${record.section}/${record.id}`;
      const prior = records.get(key);
      if (!prior || prior.storeRevision < record.storeRevision) records.set(key, record);
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
}) {
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
      snapshotRevision: number;
      snapshotBytes: number;
      snapshotCache: "hit" | "miss";
      deltaRecords: number;
      recordCount: number;
    }
  > = {};
  try {
    for (const repoSlug of options.repoSlugs) {
      validateRepoSlug(repoSlug);
      const storedSnapshot = await fetchWorkerStoredSnapshot({
        baseUrl: options.baseUrl,
        webhookSecret: options.webhookSecret,
        repoSlug,
        fetch: options.fetch,
      });
      const cached = await ensureSnapshotCache({
        cacheRoot,
        baseUrl: options.baseUrl,
        webhookSecret: options.webhookSecret,
        snapshot: storedSnapshot,
        fetch: options.fetch,
      });
      const stagedRepoRoot = path.join(stagedRecordsRoot, repoSlug);
      cpSync(cached.treeRoot, stagedRepoRoot, { recursive: true });
      const journal = await exportWorkerRecords({
        baseUrl: options.baseUrl,
        webhookSecret: options.webhookSecret,
        repoSlug,
        sinceRevision: storedSnapshot.revisionWatermark,
        fetch: options.fetch,
      });
      applyWorkerRecords(stagedRepoRoot, journal.records);
      repositories[repoSlug] = {
        revision: journal.revision,
        snapshotRevision: storedSnapshot.revisionWatermark,
        snapshotBytes: storedSnapshot.bytes,
        snapshotCache: cached.cache,
        deltaRecords: journal.records.length,
        recordCount: collectGitRecords(stagingRoot, repoSlug).length,
      };
    }
    rmSync(recordsRoot, { force: true, recursive: true });
    renameSync(stagedRecordsRoot, recordsRoot);
  } finally {
    rmSync(stagingRoot, { force: true, recursive: true });
  }
  const manifestPath = path.join(
    options.worktreeRoot,
    ".artifacts",
    "worker-records-manifest.json",
  );
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(
    manifestPath,
    `${JSON.stringify({ schemaVersion: 2, source: "worker", repositories }, null, 2)}\n`,
    "utf8",
  );
  return { recordsRoot, manifestPath, repositories };
}

export async function fetchWorkerStoredSnapshot(options: {
  baseUrl: string;
  webhookSecret: string;
  repoSlug: string;
  fetch?: typeof globalThis.fetch;
}): Promise<WorkerStoredSnapshot> {
  try {
    const envelope = await signedPost<{
      snapshotStoreAvailable: boolean;
      snapshot: WorkerStoredSnapshot;
    }>({
      ...options,
      path: "/internal/state/records/snapshots/latest",
      body: { repoSlug: options.repoSlug },
    });
    validateStoredSnapshot(envelope.snapshot, options.repoSlug);
    return envelope.snapshot;
  } catch (error) {
    if (
      error instanceof WorkerRecordRequestError &&
      (error.code === "snapshot_store_unavailable" || error.code === "snapshot_not_found")
    ) {
      throw new WorkerSnapshotUnavailableError(error.code);
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
  for (const repoSlug of [...options.repoSlugs].sort()) {
    snapshots.push(await fetchWorkerStoredSnapshot({ ...options, repoSlug }));
  }
  const pairs = snapshots.map((snapshot) => `${snapshot.repoSlug}:${snapshot.revisionWatermark}`);
  return {
    snapshots,
    key: createHash("sha256").update(pairs.join("\n")).digest("hex").slice(0, 24),
    pairs,
  };
}

export function discoverRecordRepoSlugs(stateRoot: string): string[] {
  const recordsRoot = path.join(stateRoot, "records");
  if (!existsSync(recordsRoot)) return [];
  return readdirSync(recordsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isRepoSlug(entry.name))
    .map((entry) => entry.name)
    .sort();
}

export function collectGitRecords(stateRoot: string, repoSlug: string) {
  validateRepoSlug(repoSlug);
  const root = path.join(stateRoot, "records", repoSlug);
  const records: Array<{
    section: RecordSection;
    id: string;
    content: string;
    digest: string;
  }> = [];
  for (const section of RECORD_SECTIONS) {
    const directory = path.join(root, section);
    if (!existsSync(directory)) continue;
    const extension = recordExtension(section);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(extension)) continue;
      const id = entry.name.slice(0, -extension.length);
      validateRecordId(section, id);
      const content = readFileSync(path.join(directory, entry.name), "utf8");
      records.push({ section, id, content, digest: sha256(content) });
    }
  }
  return records.sort((left, right) =>
    `${left.section}/${left.id}`.localeCompare(`${right.section}/${right.id}`),
  );
}

export async function ingestGitRecords(options: {
  stateRoot: string;
  repoSlug: string;
  baseUrl: string;
  webhookSecret: string;
  fetch?: typeof globalThis.fetch;
  maxRecordsPerBatch?: number;
  maxRequestBytes?: number;
  cursor?: number;
  maxBatches?: number;
  onBatch?: (progress: { completedCursor: number; totalBatches: number }) => void;
}) {
  const records = collectGitRecords(options.stateRoot, options.repoSlug);
  const batches = batchIngestRecords(
    options.repoSlug,
    records,
    options.maxRecordsPerBatch ?? 50,
    options.maxRequestBytes ?? 3 * 1024 * 1024,
  );
  const cursor = options.cursor ?? 0;
  const maxBatches = options.maxBatches ?? Number.POSITIVE_INFINITY;
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > batches.length) {
    throw new Error(`Invalid backfill cursor: ${cursor}`);
  }
  if (
    !(
      maxBatches === Number.POSITIVE_INFINITY ||
      (Number.isSafeInteger(maxBatches) && maxBatches > 0)
    )
  ) {
    throw new Error(`Invalid backfill batch limit: ${maxBatches}`);
  }
  const totals = { inserted: 0, unchanged: 0, skippedNewer: 0, records: records.length };
  let revision = 0;
  const selected = batches.slice(cursor, cursor + maxBatches);
  let completedCursor = cursor;
  for (const body of selected) {
    const response = await signedPost<{
      inserted: number;
      unchanged: number;
      skippedNewer: number;
      watermark: number;
    }>({
      baseUrl: options.baseUrl,
      path: "/internal/state/records/ingest",
      webhookSecret: options.webhookSecret,
      body,
      fetch: options.fetch,
    });
    totals.inserted += response.inserted;
    totals.unchanged += response.unchanged;
    totals.skippedNewer += response.skippedNewer;
    revision = Math.max(revision, response.watermark);
    completedCursor += 1;
    options.onBatch?.({ completedCursor, totalBatches: batches.length });
  }
  return {
    ...totals,
    batches: selected.length,
    totalBatches: batches.length,
    cursor,
    nextCursor: completedCursor < batches.length ? completedCursor : null,
    revision,
  };
}

export function recordTreeDigests(root: string, repoSlug: string) {
  return new Map(
    collectGitRecords(root, repoSlug).map((record) => [
      `${record.section}/${record.id}${recordExtension(record.section)}`,
      record.digest,
    ]),
  );
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
    await downloadSnapshot({ ...options, archivePath });
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

async function downloadSnapshot(options: {
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
      const response = await signedRequest({
        baseUrl: options.baseUrl,
        path: "/internal/state/records/snapshots/chunk",
        webhookSecret: options.webhookSecret,
        body: {
          repoSlug: options.snapshot.repoSlug,
          revisionWatermark: options.snapshot.revisionWatermark,
          offset,
          length,
        },
        fetch: options.fetch,
      });
      if (!response.ok) throw await workerRequestError(response);
      if (response.status !== 206) {
        throw new Error(`Worker snapshot chunk returned status ${response.status}`);
      }
      const expectedRange = `bytes ${offset}-${offset + length - 1}/${options.snapshot.bytes}`;
      if (response.headers.get("content-range") !== expectedRange) {
        throw new Error("Worker snapshot chunk returned an invalid content range");
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength !== length) {
        throw new Error(
          `Worker snapshot chunk length mismatch: expected ${length}, received ${bytes.byteLength}`,
        );
      }
      writeSync(descriptor, bytes);
      offset += bytes.byteLength;
    }
  } finally {
    closeSync(descriptor);
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

export async function signedPost<T>(options: {
  baseUrl: string;
  path: string;
  webhookSecret: string;
  body: unknown;
  fetch?: typeof globalThis.fetch;
}): Promise<T> {
  const response = await signedRequest(options);
  const value = await response.json().catch(() => null);
  if (!response.ok) throw await workerRequestError(response, value);
  return value as T;
}

async function signedRequest(options: {
  baseUrl: string;
  path: string;
  webhookSecret: string;
  body: unknown;
  fetch?: typeof globalThis.fetch;
}) {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  if (!baseUrl.startsWith("https://") && !baseUrl.startsWith("http://127.0.0.1:")) {
    throw new Error("Worker record URL must use HTTPS");
  }
  if (!options.webhookSecret) throw new Error("Worker records HMAC secret is required");
  const body = JSON.stringify(options.body);
  const signature = `sha256=${createHmac("sha256", options.webhookSecret).update(body).digest("hex")}`;
  return (options.fetch ?? globalThis.fetch)(`${baseUrl}${options.path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-clawsweeper-exact-review-signature": signature,
    },
    body,
  });
}

async function workerRequestError(response: Response, parsedValue?: unknown) {
  const value =
    parsedValue ??
    (await response
      .clone()
      .json()
      .catch(() => null));
  const code =
    value && typeof value === "object" && "error" in value
      ? String((value as { error: unknown }).error)
      : String(response.status);
  return new WorkerRecordRequestError(response.status, code);
}

function batchIngestRecords(
  repoSlug: string,
  records: ReturnType<typeof collectGitRecords>,
  maxRecords: number,
  maxBytes: number,
) {
  const batches: Array<{ repoSlug: string; records: typeof records }> = [];
  let current: typeof records = [];
  for (const record of records) {
    const candidate = [...current, record];
    const bytes = Buffer.byteLength(JSON.stringify({ repoSlug, records: candidate }));
    if (current.length && (candidate.length > maxRecords || bytes > maxBytes)) {
      batches.push({ repoSlug, records: current });
      current = [record];
    } else {
      current = candidate;
    }
    if (Buffer.byteLength(JSON.stringify({ repoSlug, records: current })) > maxBytes) {
      throw new Error(`Record exceeds ingest request limit: ${record.section}/${record.id}`);
    }
  }
  if (current.length) batches.push({ repoSlug, records: current });
  return batches;
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

function recordExtension(section: RecordSection) {
  return section === "decision-packets" ? ".json" : ".md";
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
