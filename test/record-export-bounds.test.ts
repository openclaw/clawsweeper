import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  EXACT_REVIEW_CANONICAL_CHUNK_BYTES,
  EXACT_REVIEW_CANONICAL_INLINE_BYTES,
  EXACT_REVIEW_CANONICAL_RECORD_CHUNK_TABLE,
  EXACT_REVIEW_CANONICAL_RECORD_TABLE,
  EXACT_REVIEW_RECORD_BACKFILL_CHUNK_TABLE,
  EXACT_REVIEW_RECORD_BACKFILL_TABLE,
  EXACT_REVIEW_RECORD_EXPORT_INDEX_TABLE,
  EXACT_REVIEW_RECORD_EXPORT_META_TABLE,
  type RecordSection,
} from "../dashboard/exact-review-direct-publication.ts";
import {
  ExactReviewQueue,
  MemoryDurableNamespace,
  MemoryDurableStorage,
  signedStateAppendRequest,
  worker,
} from "./dashboard-worker-harness.ts";

const EXPORT_PATH = "/internal/state/records/export";
const REPO_SLUG = "openclaw-openclaw";
const SECRET = "bounded-record-export-secret";
const EXPECTED_SOURCE_BYTE_BUDGET = 2 * 1024 * 1024;
const EXPECTED_RECORD_WORK_BUDGET = 50;
const proofPath = process.env.RECORD_EXPORT_PROOF_PATH;
const behaviorProof: {
  claim: string;
  surface: string;
  limits: string;
  pages: Array<{
    cursor: number;
    nextCursor: number | null;
    records: number;
    sourceBytes: number;
    reconstructionQueries: number;
  }>;
  manifestParity: boolean;
  expectedManifest: Array<{ path: string; digest: string }>;
  materializedManifest: Array<{ path: string; digest: string }>;
  oversizedFirst: {
    sourceBytes: number;
    serializedBytes: number;
    records: number;
    reconstructionQueries: number;
    nextCursor: number | null;
  } | null;
} = {
  claim:
    "a signed records export stays within source-byte and reconstruction-work budgets, advances its cursor, and repeated calls materialize the exact fixture",
  surface: "local Worker route plus SQLite-backed ExactReviewQueue durable object",
  limits: "local controlled fixture; no production Cloudflare CPU claim",
  pages: [],
  manifestParity: false,
  expectedManifest: [],
  materializedManifest: [],
  oversizedFirst: null,
};

test.after(() => {
  if (!proofPath) return;
  mkdirSync(path.dirname(proofPath), { recursive: true });
  writeFileSync(proofPath, `${JSON.stringify(behaviorProof, null, 2)}\n`, { mode: 0o600 });
});

type FixtureRecord = {
  source: "canonical" | "backfill";
  section: RecordSection;
  id: string;
  content: string;
  digest: string;
  byteLength: number;
  storeRevision: number;
};

async function exportHarness() {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: SECRET,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const initialized = await worker.fetch(
    signedStateAppendRequest(
      EXPORT_PATH,
      { repoSlug: REPO_SLUG, sections: ["items", "commits"] },
      SECRET,
    ),
    env,
  );
  assert.equal(initialized.status, 200);
  storage.sql.resetQueryHistory();
  return { env, storage };
}

function fixtureRecord(options: {
  source: "canonical" | "backfill";
  section: RecordSection;
  id: string;
  content: string;
  storeRevision: number;
}): FixtureRecord {
  return {
    ...options,
    digest: createHash("sha256").update(options.content).digest("hex"),
    byteLength: Buffer.byteLength(options.content),
  };
}

function insertChunks(
  storage: MemoryDurableStorage,
  table: string,
  identity: readonly unknown[],
  content: string,
) {
  const bytes = Buffer.from(content);
  let chunkIndex = 0;
  for (let offset = 0; offset < bytes.byteLength; offset += EXACT_REVIEW_CANONICAL_CHUNK_BYTES) {
    storage.sql.exec(
      `INSERT INTO ${table} VALUES (${identity.map(() => "?").join(", ")}, ?, ?)`,
      ...identity,
      chunkIndex,
      bytes.subarray(offset, offset + EXACT_REVIEW_CANONICAL_CHUNK_BYTES).toString("base64"),
    );
    chunkIndex += 1;
  }
  return chunkIndex;
}

function seedFixtureRecord(storage: MemoryDurableStorage, record: FixtureRecord) {
  const chunked = record.byteLength > EXACT_REVIEW_CANONICAL_INLINE_BYTES;
  if (record.source === "canonical") {
    assert.notEqual(record.section, "commits");
    const itemId = Number(record.id);
    const chunkCount = chunked
      ? insertChunks(
          storage,
          EXACT_REVIEW_CANONICAL_RECORD_CHUNK_TABLE,
          [REPO_SLUG, record.section, itemId],
          record.content,
        )
      : 0;
    storage.sql.exec(
      `INSERT INTO ${EXACT_REVIEW_CANONICAL_RECORD_TABLE}
         (repo_slug, section, item_id, content, digest, byte_length, chunk_count, deleted,
          revision, item_key, claim_generation, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?, 1, ?)`,
      REPO_SLUG,
      record.section,
      itemId,
      chunked ? null : record.content,
      record.digest,
      record.byteLength,
      chunkCount,
      `${REPO_SLUG}#${itemId}`,
      record.storeRevision,
    );
  } else {
    const chunkCount = chunked
      ? insertChunks(
          storage,
          EXACT_REVIEW_RECORD_BACKFILL_CHUNK_TABLE,
          [REPO_SLUG, record.section, record.id],
          record.content,
        )
      : 0;
    storage.sql.exec(
      `INSERT INTO ${EXACT_REVIEW_RECORD_BACKFILL_TABLE}
         (repo_slug, section, record_id, content, digest, byte_length, chunk_count, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      REPO_SLUG,
      record.section,
      record.id,
      chunked ? null : record.content,
      record.digest,
      record.byteLength,
      chunkCount,
      record.storeRevision,
    );
  }
  storage.sql.exec(
    `INSERT INTO ${EXACT_REVIEW_RECORD_EXPORT_INDEX_TABLE}
       (repo_slug, section, record_id, digest, deleted, revision, store_revision, source, updated_at)
     VALUES (?, ?, ?, ?, 0, 1, ?, ?, ?)`,
    REPO_SLUG,
    record.section,
    record.id,
    record.digest,
    record.storeRevision,
    record.source,
    record.storeRevision,
  );
  storage.sql.exec(
    `UPDATE ${EXACT_REVIEW_RECORD_EXPORT_META_TABLE}
        SET current_revision = MAX(current_revision, ?) WHERE singleton_id = 1`,
    record.storeRevision,
  );
}

function reconstructedRecords(
  storage: MemoryDurableStorage,
  recordsByIdentity: ReadonlyMap<string, FixtureRecord>,
) {
  const queries = storage.sql.queriesMatching(
    /SELECT content, (?:digest, )?byte_length, chunk_count(?:, deleted, revision, updated_at)?\s+FROM (?:exact_review_canonical_records|exact_review_record_backfill)/,
  );
  return queries.map(({ bindings }) => {
    const identity = `${String(bindings[1])}/${String(bindings[2])}`;
    const record = recordsByIdentity.get(identity);
    assert.ok(record, `unexpected reconstruction query for ${identity}`);
    return record;
  });
}

async function exportPage(
  env: Record<string, unknown>,
  cursor: number,
  sections: RecordSection[] = ["items", "commits"],
) {
  const response = await worker.fetch(
    signedStateAppendRequest(
      EXPORT_PATH,
      { repoSlug: REPO_SLUG, sections, cursor, limit: 200 },
      SECRET,
    ),
    env,
  );
  assert.equal(response.status, 200);
  return response.json() as Promise<{
    records: Array<{
      section: RecordSection;
      id: string;
      content: string;
      digest: string;
      storeRevision: number;
    }>;
    nextCursor: number | null;
  }>;
}

test("signed record export bounds reconstruction work and source bytes while paginating exactly", async () => {
  const { env, storage } = await exportHarness();
  const fixtures: FixtureRecord[] = [];
  for (let index = 1; index <= 55; index += 1) {
    const canonical = index % 2 === 1;
    fixtures.push(
      fixtureRecord({
        source: canonical ? "canonical" : "backfill",
        section: canonical ? "items" : "commits",
        id: canonical ? String(index) : index.toString(16).padStart(40, "0"),
        content: `record-${index}:`.padEnd(1024, String(index % 10)),
        storeRevision: index,
      }),
    );
  }
  for (let index = 56; index <= 58; index += 1) {
    fixtures.push(
      fixtureRecord({
        source: index % 2 === 0 ? "canonical" : "backfill",
        section: index % 2 === 0 ? "items" : "commits",
        id: index % 2 === 0 ? String(index) : index.toString(16).padStart(40, "0"),
        content: String.fromCharCode(65 + index).repeat(1_600_000),
        storeRevision: index,
      }),
    );
  }
  for (const record of fixtures) seedFixtureRecord(storage, record);
  const recordsByIdentity = new Map(
    fixtures.map((record) => [`${record.section}/${record.id}`, record]),
  );

  const received: Array<{ section: RecordSection; id: string; digest: string }> = [];
  const pageSizes: number[] = [];
  let nextCursor: number | null = 0;
  while (nextCursor !== null) {
    const cursor = nextCursor;
    storage.sql.resetQueryHistory();
    const page = await exportPage(env, cursor);
    const reconstructed = reconstructedRecords(storage, recordsByIdentity);
    const reconstructedBytes = reconstructed.reduce((sum, record) => sum + record.byteLength, 0);
    assert.ok(reconstructed.length <= EXPECTED_RECORD_WORK_BUDGET);
    assert.ok(reconstructedBytes <= EXPECTED_SOURCE_BYTE_BUDGET);
    assert.equal(reconstructed.length, page.records.length);
    assert.ok(page.records.length > 0);
    assert.equal(page.records.at(-1)?.storeRevision, page.nextCursor ?? fixtures.length);
    behaviorProof.pages.push({
      cursor,
      nextCursor: page.nextCursor,
      records: page.records.length,
      sourceBytes: reconstructedBytes,
      reconstructionQueries: reconstructed.length,
    });
    received.push(...page.records);
    pageSizes.push(page.records.length);
    if (page.nextCursor !== null) assert.ok(page.nextCursor > cursor);
    nextCursor = page.nextCursor;
  }

  assert.deepEqual(pageSizes, [50, 6, 1, 1]);
  assert.deepEqual(
    received.map(({ section, id, digest }) => ({ section, id, digest })),
    fixtures.map(({ section, id, digest }) => ({ section, id, digest })),
  );
  const manifest = (records: Array<{ section: RecordSection; id: string; digest: string }>) =>
    records.map(({ section, id, digest }) => ({
      path: `records/${REPO_SLUG}/${section}/${id}.md`,
      digest,
    }));
  behaviorProof.expectedManifest = manifest(fixtures);
  behaviorProof.materializedManifest = manifest(received);
  behaviorProof.manifestParity = true;
});

test("signed record export returns one oversized serialized record and advances", async () => {
  const { env, storage } = await exportHarness();
  const fixtures = [
    fixtureRecord({
      source: "backfill",
      section: "commits",
      id: "a".repeat(40),
      content: '"'.repeat(EXPECTED_SOURCE_BYTE_BUDGET),
      storeRevision: 1,
    }),
    fixtureRecord({
      source: "canonical",
      section: "items",
      id: "2",
      content: "after-oversized",
      storeRevision: 2,
    }),
  ];
  for (const record of fixtures) seedFixtureRecord(storage, record);
  const recordsByIdentity = new Map(
    fixtures.map((record) => [`${record.section}/${record.id}`, record]),
  );

  storage.sql.resetQueryHistory();
  const first = await exportPage(env, 0);
  assert.equal(first.records.length, 1);
  assert.equal(first.records[0]?.id, "a".repeat(40));
  assert.equal(first.nextCursor, 1);
  const firstReconstructed = reconstructedRecords(storage, recordsByIdentity);
  assert.equal(firstReconstructed.length, 1);
  behaviorProof.oversizedFirst = {
    sourceBytes: firstReconstructed[0]!.byteLength,
    serializedBytes: new TextEncoder().encode(JSON.stringify(first.records[0])).byteLength,
    records: first.records.length,
    reconstructionQueries: firstReconstructed.length,
    nextCursor: first.nextCursor,
  };

  storage.sql.resetQueryHistory();
  const second = await exportPage(env, first.nextCursor);
  assert.equal(second.records.length, 1);
  assert.equal(second.records[0]?.id, "2");
  assert.equal(second.nextCursor, null);
});

test("signed record export rejects missing and invalid logical byte metadata", async () => {
  const missingHarness = await exportHarness();
  const missing = fixtureRecord({
    source: "canonical",
    section: "items",
    id: "1",
    content: "missing-metadata",
    storeRevision: 1,
  });
  seedFixtureRecord(missingHarness.storage, missing);
  missingHarness.storage.sql.exec(
    `DELETE FROM ${EXACT_REVIEW_CANONICAL_RECORD_TABLE}
      WHERE repo_slug = ? AND section = ? AND item_id = ?`,
    REPO_SLUG,
    missing.section,
    Number(missing.id),
  );
  await assert.rejects(
    exportPage(missingHarness.env, 0),
    /invalid record export byte metadata.*items\/1/,
  );

  const invalidHarness = await exportHarness();
  const invalid = fixtureRecord({
    source: "backfill",
    section: "commits",
    id: "b".repeat(40),
    content: "invalid-metadata",
    storeRevision: 1,
  });
  seedFixtureRecord(invalidHarness.storage, invalid);
  invalidHarness.storage.sql.exec(
    `UPDATE ${EXACT_REVIEW_RECORD_BACKFILL_TABLE}
        SET byte_length = 9007199254740992
      WHERE repo_slug = ? AND section = ? AND record_id = ?`,
    REPO_SLUG,
    invalid.section,
    invalid.id,
  );
  await assert.rejects(
    exportPage(invalidHarness.env, 0),
    /invalid record export byte metadata.*commits/,
  );
});
