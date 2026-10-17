import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  ExactReviewDirectPublicationStore,
  validateDirectPublicationPlan,
} from "../dashboard/exact-review-direct-publication.ts";
import { ExactReviewQueue } from "../dashboard/exact-review-queue.ts";
import { TestStorage } from "./exact-review-test-storage.ts";

const key = "record-backfill-shadow-cleanup:v1";
const repo = "example-project";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const request = () =>
  new Request("https://queue.invalid/admission-capabilities", { method: "POST" });

async function plan(id: number, content: string | null, revision = 1) {
  return validateDirectPublicationPlan({
    canonicalTargetKey: `example/project#${id}`,
    fenceKey: `example/project#${id}`,
    revision,
    identity: {
      canonicalTargetKey: `example/project#${id}`,
      fenceKey: `example/project#${id}`,
      revision,
      claimGeneration: 1,
    },
    operations: [
      {
        path: `records/${repo}/items/${id}.md`,
        mode: "100644",
        deleted: content === null,
        bytes: content === null ? 0 : Buffer.byteLength(content),
        ...(content === null ? {} : { contentBase64: Buffer.from(content).toString("base64") }),
      },
    ],
    totalBytes: content === null ? 0 : Buffer.byteLength(content),
  });
}

function shadow(storage: TestStorage, id: string, chunked = false, section = "items") {
  const content = `historical body ${id}`;
  storage.run(
    `INSERT INTO exact_review_record_backfill
      (repo_slug, section, record_id, content, digest, byte_length, chunk_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    repo,
    section,
    id,
    chunked ? null : content,
    hash(content),
    Buffer.byteLength(content),
    chunked ? 1 : 0,
  );
  if (chunked)
    storage.run(
      `INSERT INTO exact_review_record_backfill_chunks VALUES (?, ?, ?, 0, ?)`,
      repo,
      section,
      id,
      Buffer.from(content).toString("base64"),
    );
  return Buffer.byteLength(content);
}

function setup() {
  const storage = new TestStorage();
  const store = new ExactReviewDirectPublicationStore(storage);
  store.ensureSchemaSync();
  return { storage, store };
}

test("canonical publication removes only its replaced shadow after the export write", async () => {
  const { storage, store } = setup();
  shadow(storage, "1", true);
  shadow(storage, "2");
  const accepted = await plan(1, "canonical body");
  store.accept(accepted, 10);
  assert.equal(
    storage.scalar(
      "SELECT COUNT(*) AS value FROM exact_review_record_backfill WHERE record_id = '1'",
    ),
    0,
  );
  assert.equal(
    storage.scalar("SELECT COUNT(*) AS value FROM exact_review_record_backfill_chunks"),
    0,
  );
  assert.equal(
    storage.scalar(
      "SELECT COUNT(*) AS value FROM exact_review_record_backfill WHERE record_id = '2'",
    ),
    1,
  );
  assert.equal(store.readExportRecord(repo, "items", "1")?.content, "canonical body");
  assert.equal(store.accept(accepted, 11).outcome, "deduped");
});

test("producer failure after shadow deletion rolls back canonical, export, parent and chunks", async () => {
  const { storage, store } = setup();
  const accepted = await plan(1, "canonical body");
  store.accept(accepted, 10);
  shadow(storage, "1", true);
  const replacement = await plan(1, null, 2);
  const before = store.readExportRecord(repo, "items", "1");
  storage.failNextSqlMatching(/INSERT INTO exact_review_direct_publication_plans/);
  assert.throws(() => store.accept(replacement, 12), /injected/);
  assert.deepEqual(store.readExportRecord(repo, "items", "1"), before);
  assert.equal(storage.scalar("SELECT COUNT(*) AS value FROM exact_review_record_backfill"), 1);
  assert.equal(
    storage.scalar("SELECT COUNT(*) AS value FROM exact_review_record_backfill_chunks"),
    1,
  );
  store.accept(replacement, 13);
  assert.equal(store.readExportRecord(repo, "items", "1")?.deleted, true);
  assert.equal(storage.scalar("SELECT COUNT(*) AS value FROM exact_review_record_backfill"), 0);
});

test("historical cleanup requires exact current canonical ownership and preserves all commits", async () => {
  const { storage, store } = setup();
  for (let id = 1; id <= 6; id++)
    store.accept(await plan(id, id === 2 ? null : `current ${id}`), 10);
  const bytes = shadow(storage, "1", true) + shadow(storage, "2");
  shadow(storage, "3");
  shadow(storage, "4");
  shadow(storage, "5");
  shadow(storage, "6");
  shadow(storage, "01");
  shadow(storage, "99");
  storage.run(
    "UPDATE exact_review_record_export_index SET source = 'backfill' WHERE record_id = '3'",
  );
  storage.run(
    "UPDATE exact_review_record_export_index SET revision = revision + 1 WHERE record_id = '4'",
  );
  storage.run(
    "UPDATE exact_review_record_export_index SET digest = ? WHERE record_id = '5' AND section = 'items'",
    hash("mismatch"),
  );
  storage.run("DELETE FROM exact_review_canonical_records WHERE item_id = 6");
  for (const source of ["canonical", "backfill"]) {
    const id = hash(source).slice(0, 40);
    store.publishCanonicalCommits(
      repo,
      [{ section: "commits", id, content: source, digest: hash(source), bytes: source.length }],
      10,
    );
    storage.run(
      "UPDATE exact_review_record_export_index SET source = ? WHERE record_id = ?",
      source,
      id,
    );
  }
  const exportedBefore = store.readExportRecord(repo, "items", "1");
  const tombstoneBefore = store.readExportRecord(repo, "items", "2");
  const watermark = store.currentExportRevision();
  const result = storage.transactionSync(() =>
    store.pruneBackfillShadowsSync(0, store.backfillShadowUpperRowidSync()),
  );
  assert.equal(result.scanned, 10);
  assert.equal(result.retired, 2);
  assert.equal(result.retiredBytes, bytes);
  assert.equal(result.complete, true);
  assert.equal(storage.scalar("SELECT COUNT(*) AS value FROM exact_review_record_backfill"), 8);
  assert.equal(
    storage.scalar("SELECT COUNT(*) AS value FROM exact_review_record_backfill_chunks"),
    0,
  );
  assert.deepEqual(store.readExportRecord(repo, "items", "1"), exportedBefore);
  assert.deepEqual(store.readExportRecord(repo, "items", "2"), tombstoneBefore);
  assert.equal(store.currentExportRevision(), watermark);
});

test("idle alarms checkpoint raw candidates, resume once, and stop despite ineligible prefixes", async () => {
  const { storage, store } = setup();
  for (let id = 1; id <= 130; id++) {
    if (id > 64) store.accept(await plan(id, `current ${id}`), 10);
    shadow(storage, String(id));
  }
  let queue = new ExactReviewQueue({ storage }, {});
  assert.equal((await queue.fetch(request())).status, 200);
  const initial = structuredClone(storage.kv.get(key)) as { upperRowid: number };
  assert.equal(initial.upperRowid, 130);
  assert.ok(await storage.getAlarm());
  await queue.alarm();
  assert.equal((storage.kv.get(key) as { scanned: number }).scanned, 64);
  assert.equal(storage.scalar("SELECT COUNT(*) AS value FROM exact_review_record_backfill"), 130);

  queue = new ExactReviewQueue({ storage }, {});
  await queue.fetch(request());
  await queue.alarm();
  assert.equal((storage.kv.get(key) as { scanned: number }).scanned, 128);
  assert.equal(storage.scalar("SELECT COUNT(*) AS value FROM exact_review_record_backfill"), 66);
  // Newer rows are outside the captured range; a producer removes the last
  // captured row before the next pass, leaving an empty tail to finish.
  shadow(storage, "131");
  store.accept(await plan(129, "replacement 129", 2), 20);
  store.accept(await plan(130, "replacement 130", 2), 20);
  await queue.alarm();
  const completed = structuredClone(storage.kv.get(key)) as {
    completedAt: number;
    scanned: number;
    afterRowid: number;
  };
  assert.ok(completed.completedAt);
  assert.equal(completed.scanned, 128);
  assert.equal(completed.afterRowid, initial.upperRowid);
  // The independent finite hydration-field sweep may still have cache-free
  // canonical identities to classify after backfill retirement finishes.
  for (let pass = 0; pass < 40 && (await storage.getAlarm()) !== null; pass++) await queue.alarm();
  assert.equal(await storage.getAlarm(), null);
  queue = new ExactReviewQueue({ storage }, {});
  await queue.fetch(request());
  assert.deepEqual(storage.kv.get(key), completed);
  assert.equal(await storage.getAlarm(), null);
  assert.equal(storage.scalar("SELECT COUNT(*) AS value FROM exact_review_record_backfill"), 65);
});

test("cleanup rollback preserves shadow chunks and cursor; initialization preserves earlier alarms", async () => {
  const { storage, store } = setup();
  store.accept(await plan(1, "current"), 10);
  shadow(storage, "1", true);
  const earlier = Date.now() + 500;
  await storage.setAlarm(earlier);
  const queue = new ExactReviewQueue({ storage }, {});
  await queue.fetch(request());
  assert.equal(await storage.getAlarm(), earlier);
  const before = structuredClone(storage.kv.get(key));
  const put = storage.kv.put;
  storage.kv.put = (name, value) => {
    if (name === key) throw new Error("checkpoint unavailable");
    return put(name, value);
  };
  await assert.rejects(queue.alarm(), /checkpoint unavailable/);
  assert.deepEqual(storage.kv.get(key), before);
  assert.equal(storage.scalar("SELECT COUNT(*) AS value FROM exact_review_record_backfill"), 1);
  assert.equal(
    storage.scalar("SELECT COUNT(*) AS value FROM exact_review_record_backfill_chunks"),
    1,
  );
  storage.kv.put = put;
  await queue.alarm();
  assert.equal(storage.scalar("SELECT COUNT(*) AS value FROM exact_review_record_backfill"), 0);
  assert.ok((storage.kv.get(key) as { completedAt: number }).completedAt);
  assert.equal(await storage.getAlarm(), null);
});

test("invalid persisted sweep cursors fail closed without retiring rows", async () => {
  for (const [afterRowid, upperRowid] of [
    [-1, 1],
    [2, 1],
    [0, 1.5],
    [NaN, 1],
  ]) {
    const { storage, store } = setup();
    store.accept(await plan(1, "current"), 10);
    shadow(storage, "1", true);
    storage.kv.put(key, { afterRowid, upperRowid, completedAt: null });
    const queue = new ExactReviewQueue({ storage }, {});
    await assert.rejects(queue.fetch(request()), /invalid backfill shadow cleanup cursor/);
    assert.equal(storage.scalar("SELECT COUNT(*) AS value FROM exact_review_record_backfill"), 1);
  }
});

test("owner identity stays exact outside JavaScript's integer range", async () => {
  const { storage, store } = setup();
  store.accept(await plan(1, "current"), 10);
  storage.run(`INSERT INTO exact_review_canonical_records
    SELECT repo_slug, section, 9007199254740993, content, digest, byte_length,
      chunk_count, deleted, revision, item_key, claim_generation, updated_at
    FROM exact_review_canonical_records WHERE item_id = 1 AND section = 'items'`);
  storage.run(`INSERT INTO exact_review_record_export_index
    SELECT repo_slug, section, '9007199254740993', digest, deleted, revision,
      99999, source, updated_at
    FROM exact_review_record_export_index WHERE record_id = '1' AND section = 'items'`);
  shadow(storage, "9007199254740993");
  shadow(storage, "9007199254740992");
  const result = storage.transactionSync(() =>
    store.pruneBackfillShadowsSync(0, store.backfillShadowUpperRowidSync()),
  );
  assert.equal(result.retired, 1);
  assert.equal(
    storage.scalar(
      "SELECT COUNT(*) AS value FROM exact_review_record_backfill WHERE record_id = '9007199254740992'",
    ),
    1,
  );
});
