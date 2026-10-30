import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  materializeWorkerRecords,
  uploadWorkerRecordSnapshot,
  workerRecordsMain,
} from "../scripts/worker-records.ts";
import {
  ExactReviewQueue,
  MemoryDurableNamespace,
  MemoryDurableStorage,
  StatusStore,
  worker,
} from "./dashboard-worker-harness.ts";

const repoSlug = "fixture-repo";
const secret = "synthetic-snapshot-resume-secret";
const baseUrl = "http://127.0.0.1:8787";
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

// Under Actions the producer derives its upload operation id from the run, and
// the Worker deduplicates by it. Each scheduled run uploads once; these tests
// upload several times, so they use per-call random ids as outside Actions.
const actionsRun = { id: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT };
test.before(() => {
  delete process.env.GITHUB_RUN_ID;
  delete process.env.GITHUB_RUN_ATTEMPT;
});
test.after(() => {
  if (actionsRun.id !== undefined) process.env.GITHUB_RUN_ID = actionsRun.id;
  if (actionsRun.attempt !== undefined) process.env.GITHUB_RUN_ATTEMPT = actionsRun.attempt;
});

// R2 with the multipart resume API the signed upload route uses.
class ResumableBucket {
  objects = new Map<string, Uint8Array>();
  private uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();

  async createMultipartUpload(key: string) {
    const uploadId = `upload-${this.uploads.size + 1}`;
    this.uploads.set(uploadId, { key, parts: new Map() });
    return { uploadId, ...this.resumeMultipartUpload(key, uploadId) };
  }

  resumeMultipartUpload(key: string, uploadId: string) {
    const upload = this.uploads.get(uploadId)!;
    assert.equal(upload.key, key);
    return {
      uploadPart: async (partNumber: number, value: Uint8Array) => {
        upload.parts.set(partNumber, new Uint8Array(value).slice());
        return { partNumber, etag: digest(value) };
      },
      complete: async (parts: Array<{ partNumber: number }>) => {
        this.objects.set(
          key,
          Buffer.concat(parts.map(({ partNumber }) => upload.parts.get(partNumber)!)),
        );
      },
      abort: async () => undefined,
    };
  }

  async head(key: string) {
    const value = this.objects.get(key);
    return value ? { key, size: value.byteLength } : null;
  }

  async get(key: string, options?: { range?: { offset: number; length: number } }) {
    const value = this.objects.get(key);
    if (!value) return null;
    const offset = options?.range?.offset ?? 0;
    const length = options?.range?.length ?? value.byteLength - offset;
    return {
      body: new Response(value.slice(offset, offset + length)).body!,
      size: value.byteLength,
    };
  }

  async put(key: string, value: string | Uint8Array) {
    this.objects.set(key, typeof value === "string" ? Buffer.from(value) : value);
  }

  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }
}

// The production Worker, queue export, upload route and snapshot registration
// over in-memory SQLite and R2. Records are written the way canonical
// publication leaves them: one row per identity, each write taking the next
// store revision from the single monotonic counter.
async function harness() {
  const storage = new MemoryDurableStorage();
  const statusStorage = new MemoryDurableStorage();
  const bucket = new ResumableBucket();
  let serial = Promise.resolve();
  const statusState = {
    storage: statusStorage,
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
      const next = serial.then(callback);
      serial = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
  const env: Record<string, unknown> = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    STATE_SNAPSHOTS: bucket,
  };
  const queue = new ExactReviewQueue({ storage }, env);
  env.EXACT_REVIEW_QUEUE = new MemoryDurableNamespace(queue);
  env.STATUS_STORE = new MemoryDurableNamespace({
    fetch: (request: Request, init?: RequestInit) =>
      new StatusStore(statusState, env).fetch(new Request(request, init)),
  });
  const initialized = await queue.fetch(
    new Request("https://queue/records/export", {
      method: "POST",
      body: JSON.stringify({ repoSlug }),
    }),
  );
  assert.equal(initialized.status, 200, await initialized.clone().text());

  const truth = new Map<number, string>();
  const nextRevision = () => {
    storage.sql.exec(
      "UPDATE exact_review_record_export_meta SET current_revision = current_revision + 1 WHERE singleton_id = 1",
    );
    return Number(
      Array.from(
        storage.sql.exec("SELECT current_revision FROM exact_review_record_export_meta"),
      )[0].current_revision,
    );
  };
  const put = (id: number, content: string) => {
    const revision = nextRevision();
    storage.sql.exec(
      `INSERT INTO exact_review_canonical_records
         (repo_slug, section, item_id, content, digest, byte_length, chunk_count, deleted,
          revision, item_key, claim_generation, updated_at)
       VALUES (?, 'items', ?, ?, ?, ?, 0, 0, 1, ?, 1, ?)
       ON CONFLICT DO UPDATE SET content = excluded.content, digest = excluded.digest,
         byte_length = excluded.byte_length, deleted = 0, revision = revision + 1`,
      repoSlug,
      id,
      content,
      digest(content),
      Buffer.byteLength(content),
      `${repoSlug}#${id}`,
      revision,
    );
    storage.sql.exec(
      `INSERT INTO exact_review_record_export_index
         (repo_slug, section, record_id, digest, deleted, revision, store_revision, source, updated_at)
       VALUES (?, 'items', ?, ?, 0, 1, ?, 'canonical', ?)
       ON CONFLICT DO UPDATE SET digest = excluded.digest, deleted = 0,
         revision = revision + 1, store_revision = excluded.store_revision`,
      repoSlug,
      String(id),
      digest(content),
      revision,
      revision,
    );
    truth.set(id, content);
  };
  const remove = (id: number) => {
    const revision = nextRevision();
    storage.sql.exec(
      `UPDATE exact_review_canonical_records SET deleted = 1, content = NULL, digest = NULL,
         byte_length = 0 WHERE repo_slug = ? AND section = 'items' AND item_id = ?`,
      repoSlug,
      id,
    );
    storage.sql.exec(
      `UPDATE exact_review_record_export_index SET deleted = 1, digest = NULL,
         revision = revision + 1, store_revision = ? WHERE repo_slug = ? AND section = 'items' AND record_id = ?`,
      revision,
      repoSlug,
      String(id),
    );
    truth.delete(id);
  };
  const currentRevision = () =>
    Number(
      Array.from(
        storage.sql.exec("SELECT current_revision FROM exact_review_record_export_meta"),
      )[0].current_revision,
    );
  const snapshots = () =>
    Array.from(
      storage.sql.exec(
        "SELECT revision_watermark, file_count FROM exact_review_record_snapshots WHERE repo_slug = ? ORDER BY created_at, snapshot_id",
        repoSlug,
      ),
    ).map((row) => ({
      watermark: Number(row.revision_watermark),
      fileCount: Number(row.file_count),
    }));
  return { env, put, remove, truth, currentRevision, snapshots };
}

type Harness = Awaited<ReturnType<typeof harness>>;

// A clock that only moves when the producer asks the Worker for an export
// page, so a budget stops the replay after an exact number of pages.
function pagedSource(
  h: Harness,
  options: { pageMs?: number; afterExport?: (count: number) => void } = {},
) {
  let clock = 0;
  let exports = 0;
  const since: number[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(String(input), init);
    const pathname = new URL(request.url).pathname;
    if (pathname.endsWith("/records/export")) {
      const body = JSON.parse(String(init?.body));
      if (body.cursor === 0) since.push(body.sinceRevision);
    }
    const response = await worker.fetch(request, h.env);
    if (pathname.endsWith("/records/export")) {
      clock += options.pageMs ?? 60_000;
      options.afterExport?.(++exports);
    }
    return response;
  };
  return { fetch, now: () => clock, since, exports: () => exports };
}

async function upload(h: Harness, replayBudgetMs: number | undefined, source = pagedSource(h)) {
  return uploadWorkerRecordSnapshot({
    baseUrl,
    webhookSecret: secret,
    repoSlug,
    ...(replayBudgetMs === undefined ? {} : { replayBudgetMs }),
    now: source.now,
    fetch: source.fetch,
    log: () => {},
  });
}

// Readers hydrate the latest registered snapshot plus every later change; the
// result must equal the live canonical records exactly.
async function assertReaderMatchesTruth(h: Harness, root: string) {
  const worktreeRoot = mkdtempSync(path.join(root, "reader-"));
  const hydrated = await materializeWorkerRecords({
    baseUrl,
    webhookSecret: secret,
    repoSlugs: [repoSlug],
    worktreeRoot,
    trackCoverage: false,
    fetch: (input, init) => worker.fetch(new Request(String(input), init), h.env),
    log: () => {},
  });
  const items = path.join(hydrated.recordsRoot, repoSlug, "items");
  const files = existsSync(items) ? readdirSync(items).sort() : [];
  assert.deepEqual(
    files,
    [...h.truth.keys()].map((id) => `${id}.md`).sort(),
    "reader holds exactly the live identities",
  );
  for (const [id, content] of h.truth)
    assert.equal(readFileSync(path.join(items, `${id}.md`), "utf8"), content, `item ${id}`);
  return hydrated.repositories[repoSlug]!;
}

function tempRoot(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(path.join(tmpdir(), "snapshot-resume-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("a replay that reaches its budget registers a resumable snapshot the next run completes", async (t) => {
  const root = tempRoot(t);
  const h = await harness();
  for (let id = 1; id <= 1000; id++) h.put(id, `# Item ${id}\r\nUnicode 🦞\n`);
  const base = await upload(h, undefined);
  assert.equal(base.replay.complete, true);
  assert.equal(base.revisionWatermark, 1000);

  // A backlog larger than one budget: 900 rewrites after the stored snapshot.
  for (let id = 1; id <= 900; id++) h.put(id, `# Item ${id} v2\n`);
  // Writes that land while the producer is mid-replay: rewrite an identity the
  // replay already applied, delete one, rewrite one it has not reached, create one.
  const source = pagedSource(h, {
    afterExport: (count) => {
      if (count !== 1) return;
      h.put(5, "# Item 5 rewritten mid-replay\n");
      h.remove(10);
      h.put(850, "# Item 850 rewritten mid-replay\n");
      h.put(1001, "# Item 1001 created mid-replay\n");
    },
  });
  // Two 200-record pages fit the budget; the replay stops between pages.
  const partial = await upload(h, 120_000, source);
  assert.deepEqual(source.since, [1000]);
  assert.equal(partial.replay.complete, false);
  assert.equal(partial.replay.previousRevision, 1000);
  assert.equal(partial.replay.resumeRevision, 1400);
  assert.equal(partial.revisionWatermark, 1400);
  assert.equal(partial.replay.replayedRecords, 400);
  assert.equal(partial.fileCount, 1000);
  // The Worker's own coverage check accepted the cut.
  assert.deepEqual(h.snapshots().at(-1), { watermark: 1400, fileCount: 1000 });
  // Readers that hydrate the partial snapshot still see every live change.
  const reader = await assertReaderMatchesTruth(h, root);
  assert.equal(reader.snapshotRevision, 1400);

  const resumed = pagedSource(h);
  const complete = await upload(h, 10 * 60_000, resumed);
  assert.deepEqual(resumed.since, [1400]);
  assert.equal(complete.replay.complete, true);
  assert.equal(complete.replay.resumeRevision, null);
  assert.equal(complete.revisionWatermark, h.currentRevision());
  assert.equal(complete.fileCount, h.truth.size);
  const caughtUp = await assertReaderMatchesTruth(h, root);
  assert.equal(caughtUp.deltaRecords, 0);
});

test("one page per run still converges under continuous writes", async (t) => {
  const root = tempRoot(t);
  const h = await harness();
  for (let id = 1; id <= 300; id++) h.put(id, `# Item ${id}\n`);
  await upload(h, undefined);
  for (let id = 1; id <= 300; id++) h.put(id, `# Item ${id} backlog\n`);
  for (let id = 301; id <= 1200; id++) h.put(id, `# Item ${id} new\n`);

  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const watermarks: number[] = [];
  let runs = 0;
  for (;;) {
    runs++;
    assert.ok(runs <= 20, "converges within a bounded number of runs");
    // Ten writes land during every run: rewrites, deletes and creations.
    const source = pagedSource(h, {
      afterExport: (count) => {
        if (count !== 1) return;
        for (let write = 0; write < 10; write++) {
          const id = 1 + Math.floor(random() * 1300);
          if (random() < 0.2 && h.truth.has(id)) h.remove(id);
          else h.put(id, `# Item ${id} run ${runs} write ${write}\n`);
        }
      },
    });
    // The budget is already spent after the first page, the slowest possible
    // run; every run must still move the watermark forward.
    const snapshot = await upload(h, 1, source);
    if (watermarks.length) assert.ok(snapshot.revisionWatermark > watermarks.at(-1)!);
    watermarks.push(snapshot.revisionWatermark);
    await assertReaderMatchesTruth(h, root);
    if (snapshot.replay.complete) break;
    assert.equal(source.exports(), 1);
  }
  assert.ok(runs > 5, `backlog needed several runs (${runs})`);
});

test("an unbudgeted or ample budget replays to the end and keeps the first-page watermark", async () => {
  const h = await harness();
  for (let id = 1; id <= 450; id++) h.put(id, `# Item ${id}\n`);
  const source = pagedSource(h, {
    afterExport: (count) => {
      if (count === 1) h.put(2, "# Item 2 after first page\n");
    },
  });
  const snapshot = await upload(h, 60 * 60_000, source);
  assert.equal(snapshot.replay.complete, true);
  assert.equal(snapshot.replay.resumeRevision, null);
  // The rewrite after the first page lands past the conservative watermark.
  assert.equal(snapshot.revisionWatermark, 450);
  assert.equal(snapshot.fileCount, 450);
  assert.equal(source.exports(), 3);
});

test("snapshot-upload rejects malformed replay budgets before any request", async () => {
  const env = { CLAWSWEEPER_WEBHOOK_SECRET: secret, CLAWSWEEPER_RECORDS_URL: "http://127.0.0.1:9" };
  for (const value of ["0", "-5", "1.5", "abc", "1e3", "9999999"])
    await assert.rejects(
      workerRecordsMain(
        ["snapshot-upload", "--repo-slug", repoSlug, `--replay-budget-seconds=${value}`],
        env,
      ),
      /--replay-budget-seconds must be a positive whole number of seconds/,
    );
  await assert.rejects(
    workerRecordsMain(["snapshot-bootstrap-cold", "--replay-budget-seconds", "60"], env),
    /takes no --replay-budget-seconds/,
  );
  await assert.rejects(
    uploadWorkerRecordSnapshot({ baseUrl, webhookSecret: secret, repoSlug, replayBudgetMs: 0 }),
    /positive integer/,
  );
});
