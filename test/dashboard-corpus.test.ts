import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";

import { aggregateRecords } from "../dashboard-site/scripts/records.ts";
import {
  corpusFrontMatter,
  FULL_REBUILD_CRON,
  planCorpusRefresh,
  readCorpusCursor,
  refreshCorpusRecords,
  restoreCorpusState,
  sealCorpusState,
  unsealCorpusState,
} from "../scripts/dashboard-corpus.ts";
import { COLD_HYDRATION_MAX_RECORDS, packWorkerRecordSnapshot } from "../scripts/worker-records.ts";

type Row = {
  repoSlug: string;
  section: string;
  id: string;
  content: string | null;
  storeRevision: number;
  revision: number;
};

// A canonical export journal with the queue's semantics: one row per identity at its newest
// store revision, deletions kept as tombstones, a global revision watermark, and pages of at
// most `pageSize` rows ordered by store revision.
class FakeStore {
  revision = 0;
  rows = new Map<string, Row>();
  exports: Array<{ repoSlug: string; sections: string[]; sinceRevision: number; cursor: number }> =
    [];
  snapshots = new Map<string, { archive: Buffer; descriptor: Record<string, unknown> }>();
  beforeExportPage?: (page: number) => void;
  failExportPage?: number;
  exportPage = 0;
  readonly pageSize: number;

  constructor(pageSize = 2) {
    this.pageSize = pageSize;
  }

  write(repoSlug: string, section: string, id: string | number, content: string | null) {
    const key = `${repoSlug}/${section}/${id}`;
    const previous = this.rows.get(key);
    this.rows.set(key, {
      repoSlug,
      section,
      id: String(id),
      content,
      storeRevision: ++this.revision,
      revision: (previous?.revision ?? 0) + 1,
    });
  }

  fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const endpoint = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (endpoint.endsWith("/records/slugs")) {
      const slugs = new Map<string, number>();
      for (const row of this.rows.values()) {
        slugs.set(row.repoSlug, Math.max(slugs.get(row.repoSlug) ?? 0, row.storeRevision));
      }
      return Response.json({
        ok: true,
        repositories: [...slugs].map(([repoSlug, revision]) => ({ repoSlug, revision })),
      });
    }
    if (endpoint.endsWith("/snapshots/latest")) {
      const snapshot = this.snapshots.get(body.repoSlug);
      if (!snapshot) return Response.json({ error: "snapshot_not_found" }, { status: 404 });
      return Response.json({ snapshotStoreAvailable: true, snapshot: snapshot.descriptor });
    }
    if (endpoint.endsWith("/snapshots/chunk")) {
      const archive = this.snapshots.get(body.repoSlug)!.archive;
      const { offset, length } = body;
      return new Response(archive.subarray(offset, offset + length), {
        status: 206,
        headers: { "content-range": `bytes ${offset}-${offset + length - 1}/${archive.length}` },
      });
    }
    if (endpoint.endsWith("/records/list")) {
      return Response.json({
        repoSlug: body.repoSlug,
        section: "items",
        records: [],
        nextCursor: null,
      });
    }
    assert.ok(endpoint.endsWith("/records/export"), endpoint);
    this.exportPage++;
    this.beforeExportPage?.(this.exportPage);
    if (this.failExportPage === this.exportPage) {
      return Response.json({ error: "denied" }, { status: 403 });
    }
    this.exports.push({
      repoSlug: body.repoSlug,
      sections: body.sections,
      sinceRevision: body.sinceRevision,
      cursor: body.cursor,
    });
    const after = Math.max(body.sinceRevision, body.cursor ?? 0);
    const matching = [...this.rows.values()]
      .filter(
        (row) =>
          row.repoSlug === body.repoSlug &&
          body.sections.includes(row.section) &&
          row.storeRevision > after,
      )
      .sort((left, right) => left.storeRevision - right.storeRevision);
    const page = matching.slice(0, this.pageSize);
    return Response.json({
      repoSlug: body.repoSlug,
      revision: this.revision,
      records: page.map((row) => ({
        section: row.section,
        id: row.id,
        content: row.content,
        digest:
          row.content === null ? null : createHash("sha256").update(row.content).digest("hex"),
        revision: row.revision,
        storeRevision: row.storeRevision,
        updatedAt: new Date(0).toISOString(),
        deleted: row.content === null,
      })),
      nextCursor: matching.length > page.length ? page.at(-1)!.storeRevision : null,
    });
  };
}

function files(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else result[path.relative(root, full)] = readFileSync(full, "utf8");
    }
  };
  if (existsSync(root)) walk(root);
  return result;
}

function fixtureRoot(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(path.join(tmpdir(), "dashboard-corpus-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const worker = (store: FakeStore) => ({
  baseUrl: "https://worker.invalid",
  webhookSecret: "fixture",
  fetch: store.fetch as typeof globalThis.fetch,
  log: () => {},
});

async function fullTree(store: FakeStore, root: string, name: string) {
  const state = path.join(root, name);
  await refreshCorpusRecords({ ...worker(store), stateDir: state, mode: "full" });
  return files(path.join(state, "records"));
}

test("incremental refresh reads only changes and matches a fresh full rebuild", async (t) => {
  const root = fixtureRoot(t);
  const store = new FakeStore();
  store.write("openclaw-alpha", "items", 1, "alpha one v1");
  store.write("openclaw-alpha", "items", 2, "alpha two");
  store.write("openclaw-alpha", "plans", 1, "plan text, never part of the corpus");
  store.write("openclaw-beta", "items", 3, "beta three open");
  store.write("openclaw-beta", "closed", 4, "beta four");
  store.write("openclaw-quiet", "items", 5, "quiet five");
  const state = path.join(root, "state");

  const full = await refreshCorpusRecords({ ...worker(store), stateDir: state, mode: "full" });
  assert.equal(full.bootstrapped, 3);
  const cursor = readCorpusCursor(state);
  assert.ok(cursor);
  for (const revision of Object.values(cursor.repositories)) assert.equal(revision, store.revision);
  assert.deepEqual(Object.keys(files(path.join(state, "records"))).sort(), [
    "openclaw-alpha/items/1.md",
    "openclaw-alpha/items/2.md",
    "openclaw-beta/closed/4.md",
    "openclaw-beta/items/3.md",
    "openclaw-quiet/items/5.md",
  ]);
  for (const call of store.exports) assert.deepEqual(call.sections, ["items", "closed"]);

  const fullWatermark = store.revision;
  store.write("openclaw-alpha", "items", 1, "alpha one v2");
  store.write("openclaw-alpha", "items", 2, null);
  // Archiving moves a record: a tombstone in items and a new closed record.
  store.write("openclaw-beta", "items", 3, null);
  store.write("openclaw-beta", "closed", 3, "beta three closed");
  store.write("openclaw-beta", "plans", 9, "plans change the slug revision only");
  store.write("openclaw-gamma", "items", 7, "a repository onboarded after the rebuild");
  store.exports = [];

  const incremental = await refreshCorpusRecords({
    ...worker(store),
    stateDir: state,
    mode: "incremental",
  });
  assert.equal(incremental.unchanged, 1);
  assert.equal(incremental.refreshed, 2);
  assert.equal(incremental.bootstrapped, 1);
  assert.equal(incremental.written, 2);
  assert.equal(incremental.deleted, 2);
  // The quiet repository is not exported at all; the others replay from the saved cursor.
  assert.equal(
    store.exports.some((call) => call.repoSlug === "openclaw-quiet"),
    false,
  );
  for (const call of store.exports.filter((entry) => entry.repoSlug !== "openclaw-gamma")) {
    assert.equal(call.sinceRevision, fullWatermark);
    assert.deepEqual(call.sections, ["items", "closed"]);
  }
  assert.deepEqual(files(path.join(state, "records")), await fullTree(store, root, "fresh"));
  const after = readCorpusCursor(state)!;
  assert.equal(after.repositories["openclaw-alpha"], store.revision);
  assert.equal(after.repositories["openclaw-quiet"], fullWatermark);
  assert.equal(after.repositories["openclaw-gamma"], store.revision);
  assert.equal(
    readdirSync(state).some((name) => name.startsWith(".")),
    false,
  );
});

test("a write that lands between export pages is never lost", async (t) => {
  const root = fixtureRoot(t);
  const store = new FakeStore(1);
  for (const id of [1, 2, 3]) store.write("openclaw-alpha", "items", id, `item ${id} v1`);
  const state = path.join(root, "state");
  await refreshCorpusRecords({ ...worker(store), stateDir: state, mode: "full" });
  for (const id of [1, 2, 3]) store.write("openclaw-alpha", "items", id, `item ${id} v2`);
  const firstWatermark = store.revision;
  // Pages are counted across refreshes: write between this refresh's first and second page.
  const secondPage = store.exportPage + 2;
  store.beforeExportPage = (page) => {
    if (page === secondPage) {
      store.write("openclaw-alpha", "items", 1, "item 1 v3 (written mid-export)");
      store.write("openclaw-alpha", "closed", 8, "closed mid-export");
    }
  };
  await refreshCorpusRecords({ ...worker(store), stateDir: state, mode: "incremental" });
  store.beforeExportPage = undefined;
  assert.equal(store.revision, firstWatermark + 2);
  // The cursor is the first page's watermark, so the next refresh replays the mid-export writes.
  assert.equal(readCorpusCursor(state)!.repositories["openclaw-alpha"], firstWatermark);
  await refreshCorpusRecords({ ...worker(store), stateDir: state, mode: "incremental" });
  assert.deepEqual(files(path.join(state, "records")), await fullTree(store, root, "fresh"));
});

test("a failed incremental refresh keeps its cursor and the next refresh converges", async (t) => {
  const root = fixtureRoot(t);
  const store = new FakeStore(1);
  store.write("openclaw-alpha", "items", 1, "one");
  store.write("openclaw-alpha", "items", 2, "two");
  const state = path.join(root, "state");
  await refreshCorpusRecords({ ...worker(store), stateDir: state, mode: "full" });
  const cursor = readFileSync(path.join(state, "cursor.json"), "utf8");
  store.write("openclaw-alpha", "items", 1, null);
  store.write("openclaw-alpha", "items", 2, "two v2");
  store.write("openclaw-alpha", "closed", 1, "one closed");
  // The first page (the tombstone) succeeds; the second fails.
  store.failExportPage = store.exportPage + 2;
  await assert.rejects(
    refreshCorpusRecords({ ...worker(store), stateDir: state, mode: "incremental" }),
    /403/,
  );
  // The tombstone is applied, but the cursor stays, so the retry replays it with the rest.
  assert.equal(readFileSync(path.join(state, "cursor.json"), "utf8"), cursor);
  store.failExportPage = undefined;
  await refreshCorpusRecords({ ...worker(store), stateDir: state, mode: "incremental" });
  assert.deepEqual(files(path.join(state, "records")), await fullTree(store, root, "fresh"));
});

test("an incremental refresh refuses to start without a saved cursor", async (t) => {
  const root = fixtureRoot(t);
  const store = new FakeStore();
  store.write("openclaw-alpha", "items", 1, "one");
  await assert.rejects(
    refreshCorpusRecords({
      ...worker(store),
      stateDir: path.join(root, "none"),
      mode: "incremental",
    }),
    /run a full rebuild/,
  );
  const stale = path.join(root, "stale");
  mkdirSync(path.join(stale, "records"), { recursive: true });
  writeFileSync(
    path.join(stale, "cursor.json"),
    JSON.stringify({ schemaVersion: 2, repositories: {} }),
  );
  assert.equal(readCorpusCursor(stale), null);
});

test("a full rebuild restores snapshots, keeps only corpus sections and swaps atomically", async (t) => {
  const root = fixtureRoot(t);
  const store = new FakeStore();
  store.write("openclaw-alpha", "items", 1, "one");
  store.write("openclaw-alpha", "closed", 2, "two");
  store.write("openclaw-alpha", "plans", 1, "plan");
  const tree = path.join(root, "snapshot-tree");
  for (const [section, name, content] of [
    ["items", "1.md", "one"],
    ["closed", "2.md", "two"],
    ["plans", "1.md", "plan"],
  ]) {
    mkdirSync(path.join(tree, section!), { recursive: true });
    writeFileSync(path.join(tree, section!, name!), content!);
  }
  const packed = await packWorkerRecordSnapshot({
    repoRoot: tree,
    archivePath: path.join(root, "snapshot.tar.gz"),
  });
  store.snapshots.set("openclaw-alpha", {
    archive: readFileSync(packed.archivePath),
    descriptor: {
      repoSlug: "openclaw-alpha",
      revisionWatermark: store.revision,
      objectKey: "fixture",
      bytes: packed.bytes,
      uncompressedBytes: packed.uncompressedBytes,
      fileCount: packed.fileCount,
      createdAt: new Date(0).toISOString(),
      access: { mode: "worker_range_proxy", maxChunkBytes: 64 },
    },
  });
  store.write("openclaw-alpha", "items", 1, null);
  store.write("openclaw-alpha", "items", 5, "five");
  const state = path.join(root, "state");
  mkdirSync(path.join(state, "records", "openclaw-old"), { recursive: true });
  writeFileSync(path.join(state, "records", "openclaw-old", "leftover.md"), "old");
  await refreshCorpusRecords({ ...worker(store), stateDir: state, mode: "full" });
  assert.deepEqual(files(path.join(state, "records")), {
    "openclaw-alpha/closed/2.md": "two",
    "openclaw-alpha/items/5.md": "five",
  });
  assert.deepEqual(
    store.exports.map((call) => call.sinceRevision),
    [3],
  );
  assert.deepEqual(store.exports[0]!.sections, ["items", "closed"]);
  // A failed rebuild keeps the previous tree.
  const rebuilt = files(state);
  store.failExportPage = store.exportPage + 1;
  await assert.rejects(
    refreshCorpusRecords({ ...worker(store), stateDir: state, mode: "full" }),
    /403/,
  );
  assert.deepEqual(files(state), rebuilt);
  assert.deepEqual(
    readdirSync(root).filter((name) => name.startsWith(".corpus-")),
    [],
  );
});

test("the tree keeps front matter only, and the aggregate is unchanged by it", async (t) => {
  assert.equal(corpusFrontMatter("---\na: 1\n---\n\nbody\n---\nmore"), "---\na: 1\n---\n");
  assert.equal(corpusFrontMatter("---\r\na: 1\r\n---\r\nbody"), "---\r\na: 1\r\n---\r\n");
  assert.equal(corpusFrontMatter("no front matter"), "no front matter");
  assert.equal(corpusFrontMatter("---\nunterminated"), "---\nunterminated");

  const root = fixtureRoot(t);
  const record = (number: number, decision: string) =>
    [
      "---",
      "repository: openclaw/clawsweeper",
      `number: ${number}`,
      "type: pull_request",
      "reviewed_at: 2026-10-19T10:00:00Z",
      "item_created_at: 2026-10-01T00:00:00Z",
      `title: "Item ${number}"`,
      `review_record: ${JSON.stringify({ version: 1, decision: { decision, closeReason: null } })}`,
      "---",
      "",
      "## Report",
      "",
      "Long report body ".repeat(200),
      "",
    ].join("\n");
  const store = new FakeStore();
  store.write("openclaw-clawsweeper", "items", 1, record(1, "keep_open"));
  store.write("openclaw-clawsweeper", "closed", 2, record(2, "close"));
  const state = path.join(root, "state");
  await refreshCorpusRecords({ ...worker(store), stateDir: state, mode: "full" });
  store.write("openclaw-clawsweeper", "items", 3, record(3, "keep_open"));
  await refreshCorpusRecords({ ...worker(store), stateDir: state, mode: "incremental" });
  const compact = files(path.join(state, "records"));
  assert.ok(Object.values(compact).every((content) => !content.includes("Long report body")));
  const whole = path.join(root, "whole");
  for (const row of store.rows.values()) {
    const file = path.join(whole, row.repoSlug, row.section, `${row.id}.md`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, row.content!);
  }
  const visibility = {
    "openclaw/clawsweeper": { public: true, checkedAt: new Date().toISOString() },
  };
  const now = Date.parse("2026-10-20T12:00:00Z");
  const strip = (value: { generatedAt?: string }) => ({ ...value, generatedAt: undefined });
  const fromTree = await aggregateRecords(
    path.join(state, "records"),
    { ...visibility },
    undefined,
    now,
  );
  const fromWhole = await aggregateRecords(whole, { ...visibility }, undefined, now);
  assert.equal(fromTree.repositories[0]?.totals.records, 3);
  assert.equal(fromTree.repositories[0]?.totals.typed, 3);
  assert.deepEqual(strip(fromTree), strip(fromWhole));
});

test("the cached tree is sealed with the records secret", async (t) => {
  const root = fixtureRoot(t);
  const store = new FakeStore();
  store.write("openclaw-private", "items", 1, "---\ntitle: private\n---\n");
  store.write("openclaw-private", "closed", 2, "---\ntitle: also private\n---\n");
  const state = path.join(root, "state");
  await refreshCorpusRecords({ ...worker(store), stateDir: state, mode: "full" });
  const archive = path.join(root, "cache", "tree.sealed");
  sealCorpusState(state, archive, "records-secret");
  const sealed = readFileSync(archive);
  assert.equal(sealed.includes(Buffer.from("private")), false);
  assert.equal(sealed.includes(Buffer.from("cursor.json")), false);

  const restored = path.join(root, "restored");
  unsealCorpusState(archive, restored, "records-secret");
  assert.deepEqual(files(restored), files(state));

  // A wrong key or a tampered archive never replaces the existing state.
  assert.throws(() => unsealCorpusState(archive, restored, "fork-guess"));
  const tampered = Buffer.from(sealed);
  tampered[tampered.length - 40] ^= 1;
  writeFileSync(path.join(root, "tampered.sealed"), tampered);
  assert.throws(() =>
    unsealCorpusState(path.join(root, "tampered.sealed"), restored, "records-secret"),
  );
  assert.deepEqual(files(restored), files(state));
  assert.deepEqual(
    readdirSync(root).filter((name) => name.startsWith(".corpus-unseal-")),
    [],
  );
  assert.throws(() => sealCorpusState(state, archive, ""), /SECRET is required/);

  // The planner sees a tree it cannot open (rotated secret) as missing, not as a failure.
  assert.equal(restoreCorpusState(archive, path.join(root, "rotated"), "rotated-secret"), false);
  assert.equal(existsSync(path.join(root, "rotated")), false);
  assert.equal(
    restoreCorpusState(path.join(root, "absent.sealed"), restored, "records-secret"),
    false,
  );
  assert.equal(restoreCorpusState(archive, path.join(root, "reopened"), "records-secret"), true);
  assert.deepEqual(files(path.join(root, "reopened")), files(state));
});

test("a new repository over the cold-hydration bound waits without holding back the rest", async (t) => {
  const root = fixtureRoot(t);
  const store = new FakeStore(1000);
  store.write("openclaw-alpha", "items", 1, "one");
  const state = path.join(root, "state");
  await refreshCorpusRecords({ ...worker(store), stateDir: state, mode: "full" });
  for (let id = 1; id <= COLD_HYDRATION_MAX_RECORDS + 1; id++) {
    store.write("openclaw-cold", "items", id, "cold");
  }
  store.write("openclaw-alpha", "items", 1, "one v2");
  const summary = await refreshCorpusRecords({
    ...worker(store),
    stateDir: state,
    mode: "incremental",
  });
  assert.equal(summary.deferred, 1);
  assert.equal(summary.refreshed, 1);
  assert.equal(
    readFileSync(path.join(state, "records/openclaw-alpha/items/1.md"), "utf8"),
    "one v2",
  );
  assert.equal(existsSync(path.join(state, "records/openclaw-cold")), false);
  assert.equal(readCorpusCursor(state)!.repositories["openclaw-cold"], undefined);
  // Store outages still fail the refresh.
  store.failExportPage = store.exportPage + 1;
  await assert.rejects(
    refreshCorpusRecords({ ...worker(store), stateDir: state, mode: "full" }),
    /403/,
  );
});

test("a rebuild over its time budget continues in the next runs and only then is complete", async (t) => {
  const root = fixtureRoot(t);
  const store = new FakeStore();
  store.write("openclaw-alpha", "items", 1, "one");
  store.write("openclaw-beta", "closed", 2, "two");
  const state = path.join(root, "state");
  const out = await refreshCorpusRecords({
    ...worker(store),
    stateDir: state,
    mode: "full",
    hydrationBudgetMs: 0,
  });
  // Every run hydrates at least one repository, however little budget is left.
  assert.equal(out.pending, 1);
  assert.deepEqual(Object.keys(readCorpusCursor(state)!.repositories), ["openclaw-alpha"]);
  store.write("openclaw-alpha", "items", 3, "three");
  const next = await refreshCorpusRecords({
    ...worker(store),
    stateDir: state,
    mode: "incremental",
    hydrationBudgetMs: 0,
  });
  assert.equal(next.pending, 0);
  assert.equal(next.bootstrapped, 1);
  assert.equal(next.refreshed, 1);
  assert.deepEqual(files(path.join(state, "records")), await fullTree(store, root, "fresh"));
});

test("refresh planning", () => {
  const now = new Date("2026-10-20T15:37:00Z");
  const quiet = new Date("2026-10-20T12:37:00Z");
  const plan = (input: Partial<Parameters<typeof planCorpusRefresh>[0]>) =>
    planCorpusRefresh({ event: "schedule", hasState: true, now, ...input });
  assert.equal(plan({}), "incremental");
  assert.equal(plan({ schedule: FULL_REBUILD_CRON }), "full");
  assert.equal(plan({ hasState: false }), "skip");
  assert.equal(plan({ hasState: false, now: quiet }), "full");
  assert.equal(plan({ event: "workflow_dispatch", requestedMode: "full" }), "full");
  assert.equal(plan({ event: "workflow_dispatch", requestedMode: "incremental" }), "incremental");
  assert.equal(plan({ event: "workflow_dispatch", hasState: false }), "full");
});

test("only the sealed tree and the public aggregate are cached; the site holds no records secret", () => {
  const site = readFileSync(".github/workflows/dashboard-site.yml", "utf8");
  assert.doesNotMatch(site, /hydrate-state|dashboard-corpus\.ts|CLAWSWEEPER_WEBHOOK_SECRET/);
  const corpus = YAML.parse(readFileSync(".github/workflows/dashboard-corpus.yml", "utf8")) as {
    on: { schedule: Array<{ cron: string }> };
    jobs: { refresh: { steps: Array<{ uses?: string; with?: { path?: string } }> } };
  };
  assert.ok(corpus.on.schedule.some((entry) => entry.cron === FULL_REBUILD_CRON));
  const cached = corpus.jobs.refresh.steps
    .filter((step) => String(step.uses).startsWith("actions/cache"))
    .map((step) => step.with?.path);
  assert.deepEqual([...new Set(cached)].sort(), [".corpus-cache", ".dashboard-corpus"]);
});
