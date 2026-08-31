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
  failureCorrelation: {
    responseStatus: number;
    responseBody: { error: string };
    traceId: string;
    durableObject: Record<string, unknown>;
    worker: Record<string, unknown>;
    pairedTraceId: boolean;
    contentRedacted: boolean;
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
  failureCorrelation: null,
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

function exportResponse(
  env: Record<string, unknown>,
  cursor: number,
  sections: RecordSection[] = ["items", "commits"],
  limit = 200,
) {
  return worker.fetch(
    signedStateAppendRequest(EXPORT_PATH, { repoSlug: REPO_SLUG, sections, cursor, limit }, SECRET),
    env,
  );
}

async function exportPage(
  env: Record<string, unknown>,
  cursor: number,
  sections: RecordSection[] = ["items", "commits"],
  limit = 200,
) {
  const response = await exportResponse(env, cursor, sections, limit);
  assert.equal(response.status, 200);
  return response.json() as Promise<{
    records: Array<{
      section: RecordSection;
      id: string;
      content: string | null;
      digest: string | null;
      revision: number;
      storeRevision: number;
      deleted: boolean;
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
    const candidateQueries = storage.sql.queriesMatching(/SELECT export\.repo_slug/);
    assert.equal(candidateQueries.length, 1);
    assert.equal(candidateQueries[0]?.bindings.at(-1), EXPECTED_RECORD_WORK_BUDGET);
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
    for (const record of page.records) {
      assert.equal(record.deleted, false);
      assert.notEqual(record.digest, null);
      received.push({ section: record.section, id: record.id, digest: record.digest! });
    }
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

test("signed record export does not advertise an empty page at the record boundary", async () => {
  const { env, storage } = await exportHarness();
  for (let index = 1; index <= EXPECTED_RECORD_WORK_BUDGET; index += 1) {
    seedFixtureRecord(
      storage,
      fixtureRecord({
        source: "canonical",
        section: "items",
        id: String(index),
        content: `record-${index}:`.padEnd(1024, String(index % 10)),
        storeRevision: index,
      }),
    );
  }

  for (let index = EXPECTED_RECORD_WORK_BUDGET + 1; index <= 150; index += 1) {
    seedFixtureRecord(
      storage,
      fixtureRecord({
        source: "canonical",
        section: "closed",
        id: String(index),
        content: `closed-${index}:`.padEnd(1024, String(index % 10)),
        storeRevision: index,
      }),
    );
  }

  const page = await exportPage(env, 0, ["items"]);

  assert.equal(page.records.length, EXPECTED_RECORD_WORK_BUDGET);
  assert.equal(page.nextCursor, null);
  const candidateQueries = storage.sql.queriesMatching(/SELECT export\.repo_slug/);
  assert.equal(candidateQueries.length, 1);
  assert.equal(candidateQueries[0]?.bindings.at(-1), EXPECTED_RECORD_WORK_BUDGET);
  assert.equal(
    storage.sql.queriesMatching(/SELECT 1\s+FROM exact_review_record_export_index/).length,
    1,
  );
  const plan = Array.from(
    storage.sql.exec(
      `EXPLAIN QUERY PLAN
       SELECT 1 FROM ${EXACT_REVIEW_RECORD_EXPORT_INDEX_TABLE}
        WHERE repo_slug = ? AND section IN (?) AND store_revision > ?
        LIMIT 1`,
      REPO_SLUG,
      "items",
      EXPECTED_RECORD_WORK_BUDGET,
    ),
    (row) => String(row.detail),
  ).join("\n");
  assert.match(plan, /exact_review_record_export_by_repo_section_revision/);
});

test("signed record export preserves historical backfill items and canonical tombstones", async () => {
  const { env, storage } = await exportHarness();
  const historical = fixtureRecord({
    source: "backfill",
    section: "items",
    id: "101",
    content: "historical backfill item",
    storeRevision: 1,
  });
  storage.sql.exec(
    `INSERT INTO ${EXACT_REVIEW_RECORD_BACKFILL_TABLE}
       (repo_slug, section, record_id, content, digest, byte_length, chunk_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    REPO_SLUG,
    historical.section,
    historical.id,
    historical.content,
    historical.digest,
    historical.byteLength,
    historical.storeRevision,
  );
  storage.sql.exec(
    `INSERT INTO ${EXACT_REVIEW_RECORD_EXPORT_INDEX_TABLE}
       (repo_slug, section, record_id, digest, deleted, revision, store_revision, source, updated_at)
     VALUES (?, ?, ?, ?, 0, 0, 1, 'backfill', 1)`,
    REPO_SLUG,
    historical.section,
    historical.id,
    historical.digest,
  );
  storage.sql.exec(
    `INSERT INTO ${EXACT_REVIEW_RECORD_EXPORT_INDEX_TABLE}
       (repo_slug, section, record_id, digest, deleted, revision, store_revision, source, updated_at)
     VALUES (?, 'items', '102', NULL, 1, 2, 2, 'canonical', 2)`,
    REPO_SLUG,
  );
  storage.sql.exec(
    `UPDATE ${EXACT_REVIEW_RECORD_EXPORT_META_TABLE}
        SET current_revision = 2 WHERE singleton_id = 1`,
  );

  storage.sql.resetQueryHistory();
  const first = await exportPage(env, 0, ["items"], 1);
  assert.deepEqual(first.records, [
    {
      section: "items",
      id: historical.id,
      content: historical.content,
      digest: historical.digest,
      revision: 0,
      storeRevision: 1,
      updatedAt: new Date(1).toISOString(),
      deleted: false,
    },
  ]);
  assert.equal(first.nextCursor, 1);
  assert.equal(storage.sql.queriesMatching(/FROM exact_review_record_backfill\s/).length, 1);
  assert.equal(storage.sql.queriesMatching(/FROM exact_review_canonical_records\s/).length, 0);

  storage.sql.resetQueryHistory();
  const second = await exportPage(env, first.nextCursor, ["items"]);
  assert.deepEqual(second.records, [
    {
      section: "items",
      id: "102",
      content: null,
      digest: null,
      revision: 2,
      storeRevision: 2,
      updatedAt: new Date(2).toISOString(),
      deleted: true,
    },
  ]);
  assert.equal(second.nextCursor, null);
  assert.equal(
    storage.sql.queriesMatching(
      /FROM (?:exact_review_canonical_records|exact_review_record_backfill)\s/,
    ).length,
    0,
  );
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

test("signed record export hides missing and invalid logical byte metadata", async () => {
  const originalError = console.error;
  const errors: unknown[][] = [];
  console.error = (...values: unknown[]) => errors.push(values);
  try {
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
    const missingResponse = await exportResponse(missingHarness.env, 0);
    assert.equal(missingResponse.status, 500);
    assert.equal(missingResponse.headers.get("content-type"), "application/json; charset=utf-8");
    const missingResponseBody = (await missingResponse.json()) as { error: string };
    assert.deepEqual(missingResponseBody, { error: "exact_review_queue_unavailable" });

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
    const invalidResponse = await exportResponse(invalidHarness.env, 0);
    assert.equal(invalidResponse.status, 500);
    assert.equal(invalidResponse.headers.get("content-type"), "application/json; charset=utf-8");
    assert.deepEqual(await invalidResponse.json(), { error: "exact_review_queue_unavailable" });
    const malformedHarness = await exportHarness();
    const malformed = fixtureRecord({
      source: "backfill",
      section: "commits",
      id: "c".repeat(40),
      content: "malformed-chunk",
      storeRevision: 1,
    });
    seedFixtureRecord(malformedHarness.storage, malformed);
    malformedHarness.storage.sql.exec(
      `UPDATE ${EXACT_REVIEW_RECORD_BACKFILL_TABLE}
          SET content = NULL, byte_length = 1, chunk_count = 1
        WHERE repo_slug = ? AND section = ? AND record_id = ?`,
      REPO_SLUG,
      malformed.section,
      malformed.id,
    );
    malformedHarness.storage.sql.exec(
      `INSERT INTO ${EXACT_REVIEW_RECORD_BACKFILL_CHUNK_TABLE}
         (repo_slug, section, record_id, chunk_index, content_base64)
       VALUES (?, ?, ?, 0, '%%%')`,
      REPO_SLUG,
      malformed.section,
      malformed.id,
    );
    const malformedResponse = await exportResponse(malformedHarness.env, 0);
    assert.equal(malformedResponse.status, 500);
    assert.deepEqual(await malformedResponse.json(), { error: "exact_review_queue_unavailable" });

    const invalidUtf8Harness = await exportHarness();
    const invalidUtf8 = fixtureRecord({
      source: "backfill",
      section: "commits",
      id: "d".repeat(40),
      content: "invalid-utf8",
      storeRevision: 1,
    });
    seedFixtureRecord(invalidUtf8Harness.storage, invalidUtf8);
    invalidUtf8Harness.storage.sql.exec(
      `UPDATE ${EXACT_REVIEW_RECORD_BACKFILL_TABLE}
          SET content = NULL, byte_length = 1, chunk_count = 1
        WHERE repo_slug = ? AND section = ? AND record_id = ?`,
      REPO_SLUG,
      invalidUtf8.section,
      invalidUtf8.id,
    );
    invalidUtf8Harness.storage.sql.exec(
      `INSERT INTO ${EXACT_REVIEW_RECORD_BACKFILL_CHUNK_TABLE}
         (repo_slug, section, record_id, chunk_index, content_base64)
       VALUES (?, ?, ?, 0, '/w==')`,
      REPO_SLUG,
      invalidUtf8.section,
      invalidUtf8.id,
    );
    const invalidUtf8Response = await exportResponse(invalidUtf8Harness.env, 0);
    assert.equal(invalidUtf8Response.status, 500);
    assert.deepEqual(await invalidUtf8Response.json(), { error: "exact_review_queue_unavailable" });

    const malformedCanonicalHarness = await exportHarness();
    const malformedCanonical = fixtureRecord({
      source: "canonical",
      section: "items",
      id: "2",
      content: "canonical-malformed".repeat(EXACT_REVIEW_CANONICAL_INLINE_BYTES),
      storeRevision: 1,
    });
    seedFixtureRecord(malformedCanonicalHarness.storage, malformedCanonical);
    malformedCanonicalHarness.storage.sql.exec(
      `DELETE FROM ${EXACT_REVIEW_CANONICAL_RECORD_CHUNK_TABLE}
        WHERE repo_slug = ? AND section = ? AND item_id = ?`,
      REPO_SLUG,
      malformedCanonical.section,
      Number(malformedCanonical.id),
    );
    const malformedCanonicalResponse = await exportResponse(malformedCanonicalHarness.env, 0);
    assert.equal(malformedCanonicalResponse.status, 500);
    assert.deepEqual(await malformedCanonicalResponse.json(), {
      error: "exact_review_queue_unavailable",
    });

    assert.equal(errors.length, 10);
    for (let index = 0; index < errors.length; index += 2) {
      assert.equal(errors[index]?.[0], "exact_review_queue_handler_failed");
      assert.equal(errors[index + 1]?.[0], "exact_review_queue_request_failed");
      const handler = errors[index]?.[1] as Record<string, unknown>;
      const request = errors[index + 1]?.[1] as Record<string, unknown>;
      assert.match(
        String(handler.trace_id),
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      assert.equal(request.trace_id, handler.trace_id);
      assert.deepEqual(handler, {
        phase: "fetch",
        trace_id: handler.trace_id,
        endpoint: "records_export",
        failure_category: "record_export_consistency",
        location: null,
      });
      assert.deepEqual(request, {
        trace_id: handler.trace_id,
        endpoint: "records_export",
        phase: "request",
        transport: "throw",
        upstream_status: null,
        remote: false,
        retryable: false,
        overloaded: false,
        failure_category: "request_exception",
      });
    }
    const serializedErrors = JSON.stringify(errors);
    assert.equal(serializedErrors.includes(REPO_SLUG), false);
    assert.equal(serializedErrors.includes("missing-metadata"), false);
    assert.equal(serializedErrors.includes("invalid-metadata"), false);
    assert.equal(serializedErrors.includes("malformed-chunk"), false);
    assert.equal(serializedErrors.includes("invalid-utf8"), false);
    assert.equal(serializedErrors.includes("canonical-malformed"), false);
    const proofHandler = errors[0]?.[1] as Record<string, unknown>;
    const proofWorker = errors[1]?.[1] as Record<string, unknown>;
    behaviorProof.failureCorrelation = {
      responseStatus: missingResponse.status,
      responseBody: missingResponseBody,
      traceId: String(proofHandler.trace_id),
      durableObject: proofHandler,
      worker: proofWorker,
      pairedTraceId: proofHandler.trace_id === proofWorker.trace_id,
      contentRedacted:
        !serializedErrors.includes(REPO_SLUG) &&
        !serializedErrors.includes("missing-metadata") &&
        !serializedErrors.includes("invalid-metadata") &&
        !serializedErrors.includes("malformed-chunk") &&
        !serializedErrors.includes("invalid-utf8") &&
        !serializedErrors.includes("canonical-malformed"),
    };
  } finally {
    console.error = originalError;
  }
});
