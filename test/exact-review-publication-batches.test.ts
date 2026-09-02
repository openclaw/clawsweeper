import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { ExactReviewPublicationBatchStore } from "../dashboard/exact-review-publication-batches.ts";
import {
  EXACT_REVIEW_CANONICAL_INLINE_BYTES,
  EXACT_REVIEW_DIRECT_PUBLICATION_RETENTION_MS,
  EXACT_REVIEW_DIRECT_PUBLICATION_MAX_POST_BYTES,
  ExactReviewDirectPublicationStore,
  validateCanonicalRecordTupleMutation,
  validateDirectPublicationPlan,
  type DirectPublicationPlan,
} from "../dashboard/exact-review-direct-publication.ts";
import {
  EXACT_REVIEW_LIFECYCLE_PROJECTION_TABLE,
  ExactReviewLifecycleProjectionStore,
} from "../dashboard/exact-review-lifecycle.ts";
import { ExactReviewQueue as RuntimeExactReviewQueue } from "../dashboard/exact-review-queue.ts";
import worker from "../dashboard/worker.ts";

class ExactReviewQueue extends RuntimeExactReviewQueue {
  constructor(
    state: ConstructorParameters<typeof RuntimeExactReviewQueue>[0],
    env: ConstructorParameters<typeof RuntimeExactReviewQueue>[1],
    random?: ConstructorParameters<typeof RuntimeExactReviewQueue>[2],
  ) {
    super(
      state,
      {
        hostedTargetPredicate: () => true,
        hostedPublicTargetProbe: async () => "public",
        ...env,
      },
      random,
    );
  }
}

class SqlCursor<T extends Record<string, unknown>> implements Iterable<T> {
  private readonly rows: T[];

  constructor(rows: T[]) {
    this.rows = rows;
  }

  *[Symbol.iterator]() {
    yield* this.rows;
  }
}

class TestStorage {
  private readonly database = new DatabaseSync(":memory:");
  private readonly values = new Map<string, unknown>();
  private failSqlPattern: RegExp | null = null;
  private failSqlMatchesRemaining = 0;
  private alarmAt: number | null = null;
  readonly sql = {
    exec: (query: string, ...bindings: unknown[]) => {
      if (this.failSqlPattern?.test(query)) {
        this.failSqlMatchesRemaining -= 1;
        if (this.failSqlMatchesRemaining === 0) {
          this.failSqlPattern = null;
          throw new Error("injected telemetry state write failure");
        }
      }
      const statement = this.database.prepare(query);
      if (/^\s*(?:SELECT|WITH)\b/i.test(query) || /\bRETURNING\b/i.test(query)) {
        return new SqlCursor(statement.all(...bindings) as Record<string, unknown>[]);
      }
      statement.run(...bindings);
      return new SqlCursor<Record<string, unknown>>([]);
    },
  };

  failNextSqlMatching(pattern: RegExp) {
    this.failSqlPattern = pattern;
    this.failSqlMatchesRemaining = 1;
  }

  failSqlMatchingAfter(pattern: RegExp, successfulMatches: number) {
    this.failSqlPattern = pattern;
    this.failSqlMatchesRemaining = successfulMatches + 1;
  }
  readonly kv = {
    get: (key: string) => this.values.get(key),
    put: (key: string, value: unknown) => this.values.set(key, structuredClone(value)),
    delete: (key: string) => this.values.delete(key),
  };

  transactionSync<T>(callback: () => T) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  scalar(query: string) {
    return Number((this.database.prepare(query).get() as { value: number }).value);
  }

  exec(query: string) {
    this.database.exec(query);
  }

  run(query: string, ...bindings: unknown[]) {
    this.database.prepare(query).run(...bindings);
  }

  async get(key: string) {
    return this.values.get(key);
  }

  async put(key: string, value: unknown) {
    this.values.set(key, structuredClone(value));
  }

  async delete(key: string) {
    this.values.delete(key);
  }

  async list(options?: { prefix?: string }) {
    const prefix = options?.prefix || "";
    return new Map(
      [...this.values.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  }

  async getAlarm() {
    return this.alarmAt;
  }

  async setAlarm(at: number) {
    this.alarmAt = at;
  }

  async deleteAlarm() {
    this.alarmAt = null;
  }

  scheduledAlarm() {
    return this.alarmAt;
  }
}

const candidates = [
  { itemKey: "openclaw/openclaw#1@publish:10:1", revision: 1 },
  { itemKey: "openclaw/openclaw#2@publish:20:1", revision: 2 },
  { itemKey: "openclaw/openclaw#3@publish:30:1", revision: 3 },
  { itemKey: "openclaw/openclaw#4@publish:40:1", revision: 4 },
];

function directPlan(
  canonicalTargetKey: string,
  revision: number,
  options: {
    path?: string;
    content?: Buffer;
    files?: number;
    fenceKey?: string;
    claimGeneration?: number;
  } = {},
): DirectPublicationPlan {
  const content = options.content ?? Buffer.from(`result-${revision}`);
  const files = options.files ?? 1;
  const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(canonicalTargetKey)!;
  const root = `records/${match[1]}-${match[2]}`;
  const number = match[3];
  const fenceKey = options.fenceKey ?? canonicalTargetKey;
  const tuplePaths = [
    `${root}/items/${number}.md`,
    `${root}/plans/${number}.md`,
    `${root}/decision-packets/${number}.json`,
    `${root}/closed/${number}.md`,
  ];
  return {
    canonicalTargetKey,
    fenceKey,
    revision,
    identity: {
      canonicalTargetKey,
      fenceKey,
      revision,
      claimGeneration: options.claimGeneration ?? 1,
    },
    operations: Array.from({ length: files }, (_, index) => ({
      path: options.path ?? tuplePaths[index]!,
      deleted: false,
      mode: "100644" as const,
      bytes: content.byteLength,
      contentBase64: content.toString("base64"),
    })),
    totalBytes: content.byteLength * files,
  };
}

test("direct publication canonically stores, dedupes, and ratchets revisions", async () => {
  const storage = new TestStorage();
  const store = new ExactReviewDirectPublicationStore(storage);
  store.ensureSchemaSync();

  const first = await validateDirectPublicationPlan(directPlan("openclaw/openclaw#1", 1));
  const accepted = store.accept(first, 1_000);
  assert.equal(accepted.outcome, "accepted");
  assert.equal(accepted.row.commitSha, "do-revision:1");
  assert.equal(store.accept(first, 1_001).outcome, "deduped");
  const newer = store.accept(
    await validateDirectPublicationPlan(directPlan("openclaw/openclaw#1", 2)),
    1_002,
  );
  assert.equal(newer.outcome, "accepted");

  const record = store.readCanonical("openclaw-openclaw", "items", 1);
  assert.equal(record?.content, "result-2");
  assert.equal(record?.revision, 2);
  assert.match(record?.digest || "", /^[a-f0-9]{64}$/);
  assert.deepEqual(
    store.list().map((row) => [row.revision, row.state]),
    [
      [1, "published"],
      [2, "published"],
    ],
  );
});

test("direct publication makes section moves canonical with sibling and stale-sidecar tombstones", async () => {
  const storage = new TestStorage();
  const store = new ExactReviewDirectPublicationStore(storage);
  store.ensureSchemaSync();
  store.accept(await validateDirectPublicationPlan(directPlan("openclaw/openclaw#11", 1)), 1_000);
  store.accept(
    await validateDirectPublicationPlan(
      directPlan("openclaw/openclaw#11", 2, {
        path: "records/openclaw-openclaw/closed/11.md",
        content: Buffer.from("closed-result"),
      }),
    ),
    1_001,
  );

  assert.equal(store.readCanonical("openclaw-openclaw", "closed", 11)?.content, "closed-result");
  assert.equal(store.readCanonical("openclaw-openclaw", "items", 11)?.deleted, true);
  assert.equal(store.readCanonical("openclaw-openclaw", "plans", 11)?.deleted, true);
  assert.equal(store.readCanonical("openclaw-openclaw", "decision-packets", 11)?.deleted, true);
});

test("direct publication idempotency compares canonical content", async () => {
  const storage = new TestStorage();
  const store = new ExactReviewDirectPublicationStore(storage);
  store.ensureSchemaSync();
  const first = await validateDirectPublicationPlan(directPlan("openclaw/openclaw#2", 1));
  store.accept(first, 1_000);
  const retry = await validateDirectPublicationPlan(directPlan("openclaw/openclaw#2", 1));
  assert.equal(store.accept(retry, 1_001).outcome, "deduped");
});

test("direct publication preserves canonical targets and exact publication fences independently", async () => {
  const storage = new TestStorage();
  const store = new ExactReviewDirectPublicationStore(storage);
  store.ensureSchemaSync();
  const plan = await validateDirectPublicationPlan(
    directPlan("openclaw/openclaw#22", 1, {
      fenceKey: "openclaw/openclaw#22@publish:77:3",
    }),
  );

  assert.equal(plan.canonicalTargetKey, "openclaw/openclaw#22");
  assert.equal(plan.fenceKey, "openclaw/openclaw#22@publish:77:3");
  assert.equal(store.accept(plan, 1_000).outcome, "accepted");
  assert.equal(store.accept(plan, 1_001).outcome, "deduped");
  const receipt = store.get(plan.fenceKey, plan.revision);
  assert.equal(receipt?.canonicalTargetKey, plan.canonicalTargetKey);
  assert.equal(receipt?.fenceKey, plan.fenceKey);
  assert.equal(receipt?.identity.canonicalTargetKey, plan.canonicalTargetKey);
  assert.equal(receipt?.identity.fenceKey, plan.fenceKey);
  await assert.rejects(
    validateDirectPublicationPlan({
      ...plan,
      identity: { ...plan.identity, fenceKey: "openclaw/openclaw#22@publish:77:4" },
    }),
    /invalid direct publication identity/,
  );
  await assert.rejects(
    validateDirectPublicationPlan({ ...plan, canonicalTargetKey: `${plan.canonicalTargetKey} ` }),
    /canonical target key/,
  );
});

test("direct publication retains an immutable lifecycle recovery plan without backfill", async () => {
  const storage = new TestStorage();
  const store = new ExactReviewDirectPublicationStore(storage);
  store.ensureSchemaSync();
  const plan = await validateDirectPublicationPlan({
    ...directPlan("openclaw/openclaw#220", 1),
    lifecycle: { kind: "router" },
  });
  assert.equal(store.accept(plan, 1_000).outcome, "accepted");
  assert.deepEqual(store.get(plan.fenceKey, plan.revision)?.lifecycle, { kind: "router" });
  assert.equal(store.accept(plan, 1_001).outcome, "deduped");

  const conflicting = await validateDirectPublicationPlan({
    ...directPlan("openclaw/openclaw#220", 1),
    lifecycle: { kind: "policy_noop" },
  });
  assert.throws(() => store.accept(conflicting, 1_002), /conflicting direct publication retry/);
  await assert.rejects(
    validateDirectPublicationPlan({
      ...directPlan("openclaw/openclaw#221", 1),
      lifecycle: { kind: "router", extra: true },
    }),
    /invalid direct publication lifecycle plan/,
  );

  const preLifecyclePlan = await validateDirectPublicationPlan(
    directPlan("openclaw/openclaw#222", 1),
  );
  assert.equal(store.accept(preLifecyclePlan, 1_003).outcome, "accepted");
  assert.equal(store.get(preLifecyclePlan.fenceKey, preLifecyclePlan.revision)?.lifecycle, null);
});

test("direct publication dedupes an accepted tuple after its batch fence is reclaimed", async () => {
  const storage = new TestStorage();
  const store = new ExactReviewDirectPublicationStore(storage);
  store.ensureSchemaSync();
  const first = await validateDirectPublicationPlan(
    directPlan("openclaw/openclaw#23", 1, {
      fenceKey: "openclaw/openclaw#23@publish:78:3",
      claimGeneration: 1,
    }),
  );
  assert.equal(store.accept(first, 1_000).outcome, "accepted");
  const reclaimed = await validateDirectPublicationPlan(
    directPlan("openclaw/openclaw#23", 1, {
      fenceKey: "openclaw/openclaw#23@publish:78:3",
      claimGeneration: 2,
    }),
  );
  assert.equal(store.accept(reclaimed, 1_001).outcome, "deduped");
  assert.equal(store.readCanonical("openclaw-openclaw", "items", 23)?.content, "result-1");
});

test("direct publication preserves a reclaimed superseded fence outcome", async () => {
  const storage = new TestStorage();
  const store = new ExactReviewDirectPublicationStore(storage);
  store.ensureSchemaSync();
  const fenceKey = "openclaw/openclaw#24@publish:79:3";
  assert.equal(
    store.accept(
      await validateDirectPublicationPlan(
        directPlan("openclaw/openclaw#24", 2, { fenceKey, claimGeneration: 1 }),
      ),
      1_000,
    ).outcome,
    "accepted",
  );
  const stale = await validateDirectPublicationPlan(
    directPlan("openclaw/openclaw#24", 1, { fenceKey, claimGeneration: 1 }),
  );
  assert.equal(store.accept(stale, 1_001).outcome, "superseded");
  const reclaimed = await validateDirectPublicationPlan(
    directPlan("openclaw/openclaw#24", 1, { fenceKey, claimGeneration: 2 }),
  );
  assert.equal(store.accept(reclaimed, 1_002).outcome, "superseded");
});

test("direct publication does not order independent fences by their local revisions", async () => {
  const storage = new TestStorage();
  const store = new ExactReviewDirectPublicationStore(storage);
  store.ensureSchemaSync();
  assert.equal(
    store.accept(
      await validateDirectPublicationPlan(
        directPlan("openclaw/openclaw#25", 2, {
          fenceKey: "openclaw/openclaw#25@publish:80:1",
          content: Buffer.from("older-fence"),
        }),
      ),
      1_000,
    ).outcome,
    "accepted",
  );
  assert.equal(
    store.accept(
      await validateDirectPublicationPlan(
        directPlan("openclaw/openclaw#25", 1, {
          fenceKey: "openclaw/openclaw#25@publish:81:1",
          content: Buffer.from("later-fence"),
        }),
      ),
      1_001,
    ).outcome,
    "accepted",
  );
  assert.equal(store.readCanonical("openclaw-openclaw", "items", 25)?.content, "later-fence");
});

test("direct publication chunks large canonical values without projection rows", async () => {
  const storage = new TestStorage();
  const store = new ExactReviewDirectPublicationStore(storage);
  store.ensureSchemaSync();
  const content = Buffer.alloc(EXACT_REVIEW_CANONICAL_INLINE_BYTES + 1, "x");
  const plan = await validateDirectPublicationPlan(
    directPlan("openclaw/openclaw#3", 1, { content }),
  );
  store.accept(plan, 1_000);
  const row = store.readCanonical("openclaw-openclaw", "items", 3);
  assert.equal(row?.content?.length, content.length);
  assert.equal(row?.revision, 1);
  assert.equal(
    storage.scalar(
      `SELECT COUNT(*) AS value FROM exact_review_canonical_record_chunks WHERE item_id = 3`,
    ) > 1,
    true,
  );
});

test("direct publication prunes terminal plan receipts after seven days but keeps records", async () => {
  const storage = new TestStorage();
  const store = new ExactReviewDirectPublicationStore(storage);
  store.ensureSchemaSync();
  store.accept(await validateDirectPublicationPlan(directPlan("openclaw/openclaw#4", 1)), 1_000);
  assert.equal(store.pruneTerminalSync(1_000 + EXACT_REVIEW_DIRECT_PUBLICATION_RETENTION_MS), 1);
  assert.equal(store.list().length, 0);
  assert.equal(store.readCanonical("openclaw-openclaw", "items", 4)?.content, "result-1");
});

test("direct publication replaces a retired pending plan with canonical state", async () => {
  const storage = new TestStorage();
  const store = new ExactReviewDirectPublicationStore(storage);
  store.ensureSchemaSync();
  const legacy = directPlan("openclaw/openclaw#5", 1);
  storage.run(
    `INSERT INTO exact_review_direct_publication_plans
       (item_key, revision, identity_item_key, identity_revision, claim_generation,
        operations_json, total_bytes, file_count, state, attempts, created_at, updated_at,
        next_attempt_at, commit_sha, failure_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 1000, 1000, 1000, NULL, NULL)`,
    legacy.fenceKey,
    legacy.revision,
    legacy.identity.fenceKey,
    legacy.identity.revision,
    legacy.identity.claimGeneration,
    JSON.stringify(legacy.operations),
    legacy.totalBytes,
    legacy.operations.length,
  );

  const accepted = store.accept(await validateDirectPublicationPlan(legacy), 2_000);

  assert.equal(accepted.outcome, "accepted");
  assert.equal(store.readCanonical("openclaw-openclaw", "items", 5)?.content, "result-1");
  assert.equal(store.list()[0]?.state, "published");
});

test("direct publication validates tuple and per-file size caps", async () => {
  const tooLargeFile = Buffer.alloc(2 * 1024 * 1024 + 1);
  await assert.rejects(
    validateDirectPublicationPlan(directPlan("openclaw/openclaw#7", 1, { content: tooLargeFile })),
    /byte count/,
  );

  const invalidPath = directPlan("openclaw/openclaw#8", 1, {
    path: "records/other/items/8.md",
  });
  await assert.rejects(validateDirectPublicationPlan(invalidPath), /outside openclaw-openclaw#8/);
  assert.equal(EXACT_REVIEW_DIRECT_PUBLICATION_MAX_POST_BYTES, 4 * 1024 * 1024);
});

test("direct publication accepts repository-only path casing differences", async () => {
  const mixedCase = directPlan("steipete/CodexBar#2516", 1, {
    path: "records/steipete-CodexBar/items/2516.md",
  });
  const accepted = await validateDirectPublicationPlan(mixedCase);
  assert.equal(accepted.operations[0]?.path, "records/steipete-codexbar/items/2516.md");
  assert.equal(accepted.operations[0]?.repoSlug, "steipete-codexbar");
  assert.equal(
    accepted.operations[0]?.digest,
    createHash("sha256").update(Buffer.from("result-1")).digest("hex"),
  );

  const storage = new TestStorage();
  const store = new ExactReviewDirectPublicationStore(storage);
  store.ensureSchemaSync();
  assert.equal(store.accept(accepted, 1_000).outcome, "accepted");
  const normalizedRetry = await validateDirectPublicationPlan(
    directPlan("steipete/CodexBar#2516", 1, {
      path: "records/steipete-codexbar/items/2516.md",
    }),
  );
  assert.equal(store.accept(normalizedRetry, 1_001).outcome, "deduped");
  assert.equal(store.list().length, 1);
  assert.equal(store.readCanonical("steipete-codexbar", "items", 2516)?.content, "result-1");
  assert.equal(store.readCanonical("steipete-CodexBar", "items", 2516), null);
  assert.equal(
    storage.scalar(
      `SELECT COUNT(*) AS value FROM exact_review_canonical_records
        WHERE repo_slug = 'steipete-CodexBar'`,
    ),
    0,
  );
  assert.equal(
    storage.scalar(
      `SELECT COUNT(*) AS value FROM exact_review_record_export_index
        WHERE repo_slug = 'steipete-CodexBar'`,
    ),
    0,
  );
  assert.deepEqual(store.get(accepted.fenceKey, accepted.revision)?.operations, [
    {
      path: "records/steipete-codexbar/items/2516.md",
      bytes: Buffer.byteLength("result-1"),
      digest: createHash("sha256").update(Buffer.from("result-1")).digest("hex"),
      deleted: false,
    },
  ]);

  const differentRepository = structuredClone(mixedCase);
  differentRepository.operations[0]!.path = "records/steipete-other/items/2516.md";
  await assert.rejects(
    validateDirectPublicationPlan(differentRepository),
    /direct publication path is outside steipete-CodexBar#2516/,
  );

  const invalidMode = structuredClone(mixedCase);
  invalidMode.operations[0]!.mode = "100755" as "100644";
  await assert.rejects(
    validateDirectPublicationPlan(invalidMode),
    /invalid mutation mode for records\/steipete-CodexBar\/items\/2516\.md/,
  );

  const invalidBytes = structuredClone(mixedCase);
  invalidBytes.operations[0]!.bytes += 1;
  await assert.rejects(
    validateDirectPublicationPlan(invalidBytes),
    /mutation byte count does not match content/,
  );
});

test("lowercase direct publication preserves operation bytes exactly", async () => {
  const input = directPlan("openclaw/openclaw#806", 1);
  const accepted = await validateDirectPublicationPlan(input);
  assert.equal(accepted.operations[0]?.path, input.operations[0]?.path);
  assert.equal(accepted.operations[0]?.mode, input.operations[0]?.mode);
  assert.equal(accepted.operations[0]?.bytes, input.operations[0]?.bytes);
  assert.equal(accepted.operations[0]?.contentBase64, input.operations[0]?.contentBase64);
  assert.deepEqual(
    Buffer.from(accepted.operations[0]!.contentBase64!, "base64"),
    Buffer.from(input.operations[0]!.contentBase64!, "base64"),
  );
});

test("canonical tuple packet references ignore only repository casing", async () => {
  const packet = JSON.stringify({ decision: "keep-open" });
  const packetDigest = createHash("sha256").update(packet).digest("hex");
  const item = [
    "---",
    `decision_packet_sha256: ${packetDigest}`,
    "decision_packet_path: records/steipete-CodexBar/decision-packets/2516.json",
    "---",
    "",
    "review",
  ].join("\n");
  const mutation = {
    deliveryId: "record-tuple:mixed-packet-path:2516",
    key: "steipete-CodexBar/2516",
    operations: [
      {
        path: "records/steipete-codexbar/items/2516.md",
        expectedDigest: null,
        contentBase64: Buffer.from(item).toString("base64"),
      },
      { path: "records/steipete-codexbar/closed/2516.md", expectedDigest: null },
      { path: "records/steipete-codexbar/plans/2516.md", expectedDigest: null },
      {
        path: "records/steipete-codexbar/decision-packets/2516.json",
        expectedDigest: null,
        contentBase64: Buffer.from(packet).toString("base64"),
      },
    ],
  };

  await assert.doesNotReject(validateCanonicalRecordTupleMutation(mutation));

  const wrongDigest = structuredClone(mutation);
  wrongDigest.operations[0]!.contentBase64 = Buffer.from(
    item.replace(packetDigest, "0".repeat(64)),
  ).toString("base64");
  await assert.rejects(
    validateCanonicalRecordTupleMutation(wrongDigest),
    /decision packet reference is inconsistent/,
  );
});

test("publication batches atomically select ready items without duplicate active ownership", () => {
  const storage = new TestStorage();
  const batches = new ExactReviewPublicationBatchStore(storage);
  batches.ensureSchemaSync();

  const first = batches.claim({
    batchId: "batch-1",
    leaseOwner: "worker-1",
    leaseExpiresAt: 2_000,
    now: 1_000,
    maxItems: 2,
    candidates,
  });
  const second = batches.claim({
    batchId: "batch-2",
    leaseOwner: "worker-2",
    leaseExpiresAt: 2_000,
    now: 1_000,
    maxItems: 2,
    candidates,
  });

  assert.deepEqual(
    first?.items.map((item) => item.itemKey),
    candidates.slice(0, 2).map((item) => item.itemKey),
  );
  assert.equal(second, null);
  assert.equal(first?.configuredBatchSize, 2);
  assert.deepEqual(batches.activeLeaseSnapshot(1_500), {
    items: candidates.slice(0, 2).map((candidate) => ({
      itemKey: candidate.itemKey,
      batchId: "batch-1",
    })),
    itemKeys: candidates.slice(0, 2).map((item) => item.itemKey),
    activeBatches: 1,
    nextLeaseExpiresAt: 2_000,
  });
  assert.equal(batches.fetch("batch-1", "wrong-worker", 1_500), null);
});

test("publication batches allow a bounded number of disjoint active owners", () => {
  const storage = new TestStorage();
  const batches = new ExactReviewPublicationBatchStore(storage);
  batches.ensureSchemaSync();

  const first = batches.claim({
    batchId: "parallel-1",
    leaseOwner: "worker-1",
    leaseExpiresAt: 2_000,
    now: 1_000,
    maxItems: 2,
    maxConcurrentBatches: 2,
    candidates,
  });
  const second = batches.claim({
    batchId: "parallel-2",
    leaseOwner: "worker-2",
    leaseExpiresAt: 2_500,
    now: 1_000,
    maxItems: 2,
    maxConcurrentBatches: 2,
    candidates,
  });
  const third = batches.claim({
    batchId: "parallel-3",
    leaseOwner: "worker-3",
    leaseExpiresAt: 3_000,
    now: 1_000,
    maxItems: 1,
    maxConcurrentBatches: 2,
    candidates,
  });

  assert.deepEqual(
    first?.items.map((item) => item.itemKey),
    candidates.slice(0, 2).map((item) => item.itemKey),
  );
  assert.deepEqual(
    second?.items.map((item) => item.itemKey),
    candidates.slice(2).map((item) => item.itemKey),
  );
  assert.equal(third, null);
  assert.deepEqual(batches.activeLeaseSnapshot(1_500), {
    items: [
      ...candidates.slice(0, 2).map((candidate) => ({
        itemKey: candidate.itemKey,
        batchId: "parallel-1",
      })),
      ...candidates.slice(2).map((candidate) => ({
        itemKey: candidate.itemKey,
        batchId: "parallel-2",
      })),
    ],
    itemKeys: candidates.map((item) => item.itemKey),
    activeBatches: 2,
    nextLeaseExpiresAt: 2_000,
  });
});

test("batch schema migration derives a safe cap for an active legacy lease", () => {
  const storage = new TestStorage();
  storage.exec(
    `CREATE TABLE exact_review_publication_batches (
       batch_id TEXT PRIMARY KEY,
       state TEXT NOT NULL,
       lease_owner TEXT NOT NULL,
       lease_expires_at INTEGER NOT NULL,
       attempt INTEGER NOT NULL,
       created_at INTEGER NOT NULL,
       completed_at INTEGER,
       state_commit_sha TEXT,
       failure_fingerprint TEXT
     ) STRICT;
     CREATE TABLE exact_review_publication_batch_items (
       batch_id TEXT NOT NULL,
       item_key TEXT NOT NULL,
       revision INTEGER NOT NULL,
       claim_generation INTEGER NOT NULL,
       terminal_outcome TEXT,
       PRIMARY KEY (batch_id, item_key)
     ) STRICT;
     INSERT INTO exact_review_publication_batches
       (batch_id, state, lease_owner, lease_expires_at, attempt, created_at)
       VALUES ('legacy-active', 'leased', 'worker', 2000, 1, 1000);
     INSERT INTO exact_review_publication_batch_items
       (batch_id, item_key, revision, claim_generation)
       VALUES ('legacy-active', 'item-1', 1, 1), ('legacy-active', 'item-2', 1, 1);`,
  );
  const batches = new ExactReviewPublicationBatchStore(storage);
  batches.ensureSchemaSync();

  assert.equal(batches.fetch("legacy-active", "worker", 1_500)?.configuredBatchSize, 2);
});

test("fresh batch schema remains writable by the current-main insert after rollback", () => {
  const storage = new TestStorage();
  const batches = new ExactReviewPublicationBatchStore(storage);
  batches.ensureSchemaSync();

  storage.exec(
    `INSERT INTO exact_review_publication_batches
       (batch_id, state, lease_owner, lease_expires_at, attempt, created_at)
     VALUES ('rollback-writer', 'leased', 'worker', 2000, 1, 1000)`,
  );

  assert.equal(
    storage.scalar(
      `SELECT configured_batch_size AS value
         FROM exact_review_publication_batches WHERE batch_id = 'rollback-writer'`,
    ),
    1,
  );
});

test("expired unfinished membership is reclaimable with a new fencing generation", () => {
  const storage = new TestStorage();
  const batches = new ExactReviewPublicationBatchStore(storage);
  batches.ensureSchemaSync();
  const first = batches.claim({
    batchId: "batch-expiring",
    leaseOwner: "worker-1",
    leaseExpiresAt: 2_000,
    now: 1_000,
    maxItems: 1,
    candidates,
  });
  assert.equal(first?.items[0].claimGeneration, 1);

  const reclaimed = batches.claim({
    batchId: "batch-reclaimed",
    leaseOwner: "worker-2",
    leaseExpiresAt: 4_000,
    now: 2_001,
    maxItems: 1,
    candidates,
  });
  assert.equal(reclaimed?.items[0].itemKey, candidates[0].itemKey);
  assert.equal(reclaimed?.items[0].claimGeneration, 2);
  assert.equal(batches.fetch("batch-expiring", "worker-1", 2_001), null);

  const staleCompletion = batches.complete(
    "batch-reclaimed",
    "worker-2",
    [
      {
        ...candidates[0],
        claimGeneration: 1,
        terminalOutcome: "published",
      },
    ],
    2_100,
  );
  assert.equal(staleCompletion?.state, "leased");
  assert.equal(staleCompletion?.items[0].terminalOutcome, null);
});

test("batch completion is fenced per item and retains publication metadata", () => {
  const storage = new TestStorage();
  const batches = new ExactReviewPublicationBatchStore(storage);
  batches.ensureSchemaSync();
  const batch = batches.claim({
    batchId: "batch-complete",
    leaseOwner: "worker-1",
    leaseExpiresAt: 5_000,
    now: 1_000,
    maxItems: 2,
    candidates,
  });
  assert.ok(batch);

  const rejected = batches.complete(
    batch.batchId,
    batch.leaseOwner,
    [
      {
        ...batch.items[0],
        claimGeneration: batch.items[0].claimGeneration + 1,
        terminalOutcome: "published",
      },
    ],
    1_500,
    { stateCommitSha: "c".repeat(40), failureFingerprint: "stale" },
  );
  assert.equal(rejected?.stateCommitSha, null);
  assert.equal(rejected?.failureFingerprint, null);

  const completed = batches.complete(
    batch.batchId,
    batch.leaseOwner,
    batch.items.map((item, index) => ({
      itemKey: item.itemKey,
      revision: item.revision,
      claimGeneration: item.claimGeneration,
      terminalOutcome: index === 0 ? "published" : "superseded",
    })),
    2_000,
    { stateCommitSha: "a".repeat(40), failureFingerprint: "none" },
  );

  assert.equal(completed?.state, "completed");
  assert.equal(completed?.completedAt, 2_000);
  assert.equal(completed?.stateCommitSha, "a".repeat(40));
  assert.deepEqual(
    completed?.items.map((item) => item.terminalOutcome),
    ["published", "superseded"],
  );

  const retried = batches.complete(
    batch.batchId,
    batch.leaseOwner,
    batch.items.map((item, index) => ({
      itemKey: item.itemKey,
      revision: item.revision,
      claimGeneration: item.claimGeneration,
      terminalOutcome: index === 0 ? "lease_expired" : "published",
    })),
    2_100,
  );
  assert.deepEqual(retried, completed);
  assert.equal(
    batches.complete(
      batch.batchId,
      batch.leaseOwner,
      [
        {
          ...batch.items[0],
          claimGeneration: batch.items[0].claimGeneration + 1,
          terminalOutcome: "superseded",
        },
      ],
      2_100,
    ),
    null,
  );
});

test("bounded cleanup preserves active batches and open dead letters", () => {
  const storage = new TestStorage();
  const batches = new ExactReviewPublicationBatchStore(storage);
  batches.ensureSchemaSync();
  storage.exec(
    "CREATE TABLE exact_review_queue_dead_letters (dead_letter_id TEXT PRIMARY KEY, status TEXT)",
  );
  storage.exec(
    "INSERT INTO exact_review_queue_dead_letters (dead_letter_id, status) VALUES ('dlq-1', 'open')",
  );

  for (let index = 0; index < 3; index += 1) {
    const batch = batches.claim({
      batchId: `completed-${index}`,
      leaseOwner: "worker",
      leaseExpiresAt: 5_000,
      now: 1_000 + index,
      maxItems: 1,
      candidates: [{ itemKey: `item-${index}`, revision: 1 }],
    });
    assert.ok(batch);
    batches.complete(
      batch.batchId,
      batch.leaseOwner,
      [
        {
          itemKey: batch.items[0].itemKey,
          revision: 1,
          claimGeneration: 1,
          terminalOutcome: "published",
        },
      ],
      2_000 + index,
    );
  }
  batches.claim({
    batchId: "still-active",
    leaseOwner: "worker",
    leaseExpiresAt: 20_000,
    now: 3_000,
    maxItems: 1,
    candidates: [{ itemKey: "active-item", revision: 1 }],
  });

  const stats = batches.stats(10_000, { completedTtlMs: 1_000, cleanupLimit: 2 });
  assert.equal(stats.cleanup.deletedThisPass, 2);
  assert.equal(stats.cleanup.eligibleRemaining, 1);
  assert.equal(stats.leased, 1);
  assert.equal(stats.activeItems, 1);
  assert.equal(storage.scalar("SELECT COUNT(*) AS value FROM exact_review_queue_dead_letters"), 1);
});

test("cleanup retains fencing generations when a batch id is reused", () => {
  const storage = new TestStorage();
  const batches = new ExactReviewPublicationBatchStore(storage);
  batches.ensureSchemaSync();
  const candidate = { itemKey: "item-reclaimed-after-cleanup", revision: 1 };
  const first = batches.claim({
    batchId: "reused-batch",
    leaseOwner: "worker",
    leaseExpiresAt: 5_000,
    now: 1_000,
    maxItems: 1,
    candidates: [candidate],
  });
  assert.ok(first);
  batches.complete(
    first.batchId,
    first.leaseOwner,
    [
      {
        ...candidate,
        claimGeneration: first.items[0].claimGeneration,
        terminalOutcome: "published",
      },
    ],
    2_000,
  );
  batches.stats(10_000, { completedTtlMs: 1_000, cleanupLimit: 1 });

  const reclaimed = batches.claim({
    batchId: "reused-batch",
    leaseOwner: "worker",
    leaseExpiresAt: 20_000,
    now: 10_000,
    maxItems: 1,
    candidates: [candidate],
  });
  assert.equal(reclaimed?.items[0].claimGeneration, 2);

  const staleCompletion = batches.complete(
    "reused-batch",
    "worker",
    [
      {
        ...candidate,
        claimGeneration: 1,
        terminalOutcome: "published",
      },
    ],
    11_000,
  );
  assert.equal(staleCompletion?.state, "leased");
  assert.equal(staleCompletion?.items[0].terminalOutcome, null);
});

function publicationRequest(
  deliveryId: string,
  number: number,
  producerRunId: string,
  targetRepo = "openclaw/openclaw",
  leaseRevision: number | null = 1,
  protocolVersion: 1 | 2 = 2,
) {
  const producerDecision = {
    targetRepo,
    targetBranch: "main",
    itemNumber: number,
    itemKind: "issue",
    sourceEvent: "issues",
    sourceAction: "opened",
    supersedesInProgress: false,
  };
  return new Request("https://queue/enqueue", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      delivery_id: deliveryId,
      decision: {
        ...producerDecision,
        sourceAction: "exact_review_artifact_publish",
        publication: {
          artifactName: `exact-review-${producerRunId}-1`,
          producerRunId,
          producerRunAttempt: 1,
          sourceSha: "a".repeat(40),
          itemKey: `${targetRepo}#${number}`,
          protocolVersion,
          leaseRevision: protocolVersion === 2 ? leaseRevision : null,
          claimGeneration: protocolVersion === 2 ? 1 : null,
          liveProceeded: true,
          liveTerminalNoop: false,
          liveTerminalMissing: false,
          liveGuardedOpen: false,
          producerDecision,
        },
      },
    }),
  });
}

function reviewRequest(deliveryId: string, number: number) {
  return new Request("https://queue/enqueue", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      delivery_id: deliveryId,
      decision: {
        targetRepo: "openclaw/openclaw",
        targetBranch: "main",
        itemNumber: number,
        itemKind: "issue",
        sourceEvent: "issues",
        sourceAction: "opened",
        supersedesInProgress: false,
      },
    }),
  });
}

function batchRequest(path: string, body: unknown) {
  return new Request(`https://queue${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("batch claims retain lifecycle identity until canonical routing is durable", async () => {
  const storage = new TestStorage();
  const queue = new ExactReviewQueue(
    { storage },
    { EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1" },
  );
  await queue.fetch(publicationRequest("lifecycle-batch", 735, "2735"));
  const claim = await (
    await queue.fetch(
      batchRequest("/publication-batches/claim", {
        claim_id: "lifecycle-batch-735",
        lease_owner: "worker-lifecycle",
        max_items: 1,
        runner_run_id: "9735",
        runner_run_attempt: 2,
        runner_started_at: "2026-07-30T12:00:00.000Z",
      }),
    )
  ).json();
  assert.equal(claim.claimed, true, JSON.stringify(claim));
  const member = claim.batch.items[0] as {
    item_key: string;
    revision: number;
    claim_generation: number;
  };
  const plan = directPlan("openclaw/openclaw#735", member.revision, {
    fenceKey: member.item_key,
    claimGeneration: member.claim_generation,
  });
  const published = await queue.fetch(
    new Request("https://queue/publication-batch-results", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(plan),
    }),
  );
  assert.equal(published.status, 202);
  const routed = await queue.fetch(
    batchRequest("/lifecycle/router-receipt", {
      canonical_target_key: "openclaw/openclaw#735",
      fence_key: member.item_key,
      revision: member.revision,
      receipt_id: "router-batch:9735:2:735",
    }),
  );
  assert.equal(routed.status, 200);
  const row = Array.from(
    storage.sql.exec(
      `SELECT projection_json FROM ${EXACT_REVIEW_LIFECYCLE_PROJECTION_TABLE}
        WHERE canonical_target_key = ? AND fence_key = ? AND revision = ?`,
      "openclaw/openclaw#735",
      member.item_key,
      member.revision,
    ),
  )[0] as { projection_json: string };
  const projection = JSON.parse(row.projection_json) as {
    admission: { deliveryId: string };
    claims: Array<{ claimGeneration: number; runId: string; runAttempt: number }>;
    reviewResults: Array<{
      claimGeneration: number;
      runId: string;
      runAttempt: number;
      outcome: string;
    }>;
    canonicalReceipts: Array<{ outcome: string; receiptId: string }>;
    routerReceipts: Array<{ receiptId: string }>;
    terminalDisposition: { kind: string } | null;
  };
  assert.equal(projection.admission.deliveryId, "lifecycle-batch");
  assert.deepEqual(
    projection.claims.map(({ claimGeneration, runId, runAttempt }) => ({
      claimGeneration,
      runId,
      runAttempt,
    })),
    [{ claimGeneration: member.claim_generation, runId: "9735", runAttempt: 2 }],
  );
  assert.deepEqual(
    projection.reviewResults.map(({ claimGeneration, runId, runAttempt, outcome }) => ({
      claimGeneration,
      runId,
      runAttempt,
      outcome,
    })),
    [
      {
        claimGeneration: member.claim_generation,
        runId: "9735",
        runAttempt: 2,
        outcome: "completed",
      },
    ],
  );
  assert.equal(projection.canonicalReceipts[0]?.outcome, "accepted");
  assert.match(projection.canonicalReceipts[0]?.receiptId ?? "", /^batch:/);
  assert.deepEqual(
    projection.routerReceipts.map((receipt) => receipt.receiptId),
    ["router-batch:9735:2:735"],
  );
  assert.equal(projection.terminalDisposition?.kind, "review_completed_routed");
});

test("queue batch claim defaults off and additive schema keeps the legacy version", async () => {
  const queue = new ExactReviewQueue({ storage: new TestStorage() }, {});
  await queue.fetch(publicationRequest("delivery-1", 101, "1001"));
  const claim = await queue.fetch(
    batchRequest("/publication-batches/claim", {
      claim_id: "claim-disabled",
      lease_owner: "worker-1",
    }),
  );
  assert.equal(claim.status, 409);
  assert.deepEqual(await claim.json(), { error: "publication_batching_disabled" });

  const stats = await (await queue.fetch(new Request("https://queue/stats"))).json();
  assert.equal(stats.storage_schema_version, 1);
  assert.equal(stats.lanes.publication.batches.enabled, false);
  assert.equal(stats.lanes.publication.batches.max_items, 8);
  assert.equal(stats.lanes.publication.batches.max_wait_seconds, 60);
  assert.equal(stats.lanes.publication.batches.leased, 0);
});

test("critical publication health does not override review pressure", async () => {
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const queue = new ExactReviewQueue({ storage: new TestStorage() }, {});
    await queue.fetch(publicationRequest("delivery-critical", 102, "1002"));
    now += 6 * 60 * 60 * 1_000;

    const stats = await (await queue.fetch(new Request("https://queue/stats"))).json();
    assert.deepEqual(stats.lanes.publication.health, {
      status: "critical",
      reason: "oldest_pending_over_6h",
    });
    assert.equal(stats.pressure.status, "idle");
    assert.equal(stats.pressure.reason, "no_ready_backlog");
  } finally {
    Date.now = originalNow;
  }
});

test("legacy queue migration preserves receipts while adding empty batch tables", async () => {
  const originalNow = Date.now;
  Date.now = () => 3_000_000;
  try {
    const storage = new TestStorage();
    await storage.put("exact-review-queue", {
      items: {},
      deliveries: { "legacy-delivery": 3_000_000 },
    });
    const queue = new ExactReviewQueue({ storage }, {});
    const stats = await (await queue.fetch(new Request("https://queue/stats"))).json();

    assert.equal(stats.delivery_receipts, 1);
    assert.equal(stats.storage_schema_version, 1);
    assert.equal(stats.lanes.publication.batches.active_items, 0);
    assert.equal(
      storage.scalar("SELECT COUNT(*) AS value FROM exact_review_publication_batches"),
      0,
    );
  } finally {
    Date.now = originalNow;
  }
});

test("batch claim honors the existing dispatcher pause gate", async () => {
  const originalNow = Date.now;
  Date.now = () => 4_000_000;
  try {
    const storage = new TestStorage();
    const queue = new ExactReviewQueue(
      { storage },
      { EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1" },
    );
    await queue.fetch(publicationRequest("delivery-paused", 104, "1004"));
    Array.from(
      storage.sql.exec(
        "UPDATE exact_review_queue_meta SET dispatcher_json = ? WHERE singleton_id = 1",
        JSON.stringify({
          state: "paused",
          checkedAt: 4_000_000,
          retryAt: 4_060_000,
          reason: "workflow_not_active",
        }),
      ),
    );

    const claim = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-paused",
          lease_owner: "worker-1",
          max_items: 1,
        }),
      )
    ).json();
    assert.equal(claim.claimed, false);
    assert.equal(claim.batch, null);
  } finally {
    Date.now = originalNow;
  }
});

test("an active batch blocks the legacy publisher until its lease expires", async () => {
  const originalNow = Date.now;
  Date.now = () => 5_000_000;
  try {
    const storage = new TestStorage();
    const queue = new ExactReviewQueue(
      { storage },
      {
        EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
        EXACT_REVIEW_PUBLICATION_BATCH_LEASE_MS: "60000",
        EXACT_REVIEW_PUBLICATION_BASE_CONCURRENT: "1",
        EXACT_REVIEW_PUBLICATION_MAX_CONCURRENT: "1",
        EXACT_REVIEW_PUBLICATION_MIN_CONCURRENT: "1",
      },
    );
    await queue.fetch(publicationRequest("delivery-owned", 105, "1005"));
    await queue.fetch(publicationRequest("delivery-unowned", 106, "1006"));
    await queue.fetch(publicationRequest("delivery-unowned-2", 107, "1007"));

    const claim = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-blocks-legacy",
          lease_owner: "worker-1",
          max_items: 2,
        }),
      )
    ).json();
    assert.equal(claim.claimed, true, JSON.stringify(claim));
    assert.equal(claim.batch.items.length, 2);

    await queue.alarm();
    const stats = await (await queue.fetch(new Request("https://queue/stats"))).json();
    assert.equal(stats.lanes.publication.pending, 3);
    assert.equal(stats.lanes.publication.dispatching, 0);
    assert.equal(stats.admissible_pending, 0);
    assert.equal(storage.scheduledAlarm(), 5_060_000);
  } finally {
    Date.now = originalNow;
  }
});

test("queue claims distinct batches up to the configured concurrent owner cap", async () => {
  const originalNow = Date.now;
  Date.now = () => 5_500_000;
  try {
    const storage = new TestStorage();
    const queue = new ExactReviewQueue(
      { storage },
      {
        EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
        EXACT_REVIEW_PUBLICATION_BATCH_SIZE: "2",
        EXACT_REVIEW_PUBLICATION_BATCH_MAX_CONCURRENT: "2",
      },
    );
    for (let itemNumber = 120; itemNumber < 125; itemNumber += 1) {
      await queue.fetch(
        publicationRequest(
          `delivery-parallel-${itemNumber}`,
          itemNumber,
          String(4000 + itemNumber),
        ),
      );
    }

    const claim = async (id: string) =>
      (
        await queue.fetch(
          batchRequest("/publication-batches/claim", {
            claim_id: id,
            lease_owner: id,
            max_items: 2,
          }),
        )
      ).json();
    const first = await claim("parallel-claim-1");
    const second = await claim("parallel-claim-2");
    const third = await claim("parallel-claim-3");

    assert.equal(first.claimed, true, JSON.stringify(first));
    assert.equal(second.claimed, true, JSON.stringify(second));
    assert.equal(third.claimed, false, JSON.stringify(third));
    assert.deepEqual(
      [
        ...first.batch.items.map((item: { item_key: string }) => item.item_key),
        ...second.batch.items.map((item: { item_key: string }) => item.item_key),
      ],
      [
        "openclaw/openclaw#120@publish:4120:1",
        "openclaw/openclaw#121@publish:4121:1",
        "openclaw/openclaw#122@publish:4122:1",
        "openclaw/openclaw#123@publish:4123:1",
      ],
    );
    const stats = await (await queue.fetch(new Request("https://queue/stats"))).json();
    assert.equal(stats.lanes.publication.batches.max_concurrent, 2);
    assert.equal(stats.lanes.publication.batches.leased, 2);
    assert.equal(stats.lanes.publication.batches.active_items, 4);
  } finally {
    Date.now = originalNow;
  }
});

test("batch claim serializes distinct publication events for the same durable item", async () => {
  const originalNow = Date.now;
  Date.now = () => 6_000_000;
  try {
    const storage = new TestStorage();
    const queue = new ExactReviewQueue(
      { storage },
      { EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1" },
    );
    await queue.fetch(publicationRequest("delivery-duplicate-old", 108676, "2001"));
    await queue.fetch(publicationRequest("delivery-duplicate-new", 108676, "2002"));
    await queue.fetch(publicationRequest("delivery-distinct", 108677, "2003"));

    const claim = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-unique-durable-items",
          lease_owner: "worker-1",
          max_items: 2,
        }),
      )
    ).json();

    assert.equal(claim.claimed, true, JSON.stringify(claim));
    assert.deepEqual(
      claim.batch.items.map((item: { item_key: string }) => item.item_key),
      ["openclaw/openclaw#108676@publish:2001:1", "openclaw/openclaw#108677@publish:2003:1"],
    );
  } finally {
    Date.now = originalNow;
  }
});

test("publication ingress is never shed by the review pending soft limit", async () => {
  const originalNow = Date.now;
  Date.now = () => 6_100_000;
  try {
    const queue = new ExactReviewQueue(
      { storage: new TestStorage() },
      {
        EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
        EXACT_REVIEW_PENDING_SOFT_LIMIT: "1",
      },
    );
    await queue.fetch(reviewRequest("delivery-review-cap", 108699));
    const response = await (
      await queue.fetch(
        publicationRequest(
          "delivery-publication-over-cap",
          108699,
          "2099",
          "openclaw/openclaw",
          null,
          1,
        ),
      )
    ).json();

    assert.equal(response.queued, true);
    assert.equal(response.shed, undefined);
    const stats = await (await queue.fetch(new Request("https://queue/stats"))).json();
    assert.equal(stats.lanes.publication.pending, 1);
  } finally {
    Date.now = originalNow;
  }
});

test("newer publication revisions supersede unowned pending rows at enqueue", async () => {
  const originalNow = Date.now;
  Date.now = () => 6_200_000;
  try {
    const queue = new ExactReviewQueue(
      { storage: new TestStorage() },
      { EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1" },
    );
    await queue.fetch(
      publicationRequest("delivery-revision-1", 108700, "2101", "openclaw/openclaw", 1),
    );
    const response = await (
      await queue.fetch(
        publicationRequest("delivery-revision-2", 108700, "2102", "openclaw/openclaw", 2),
      )
    ).json();

    assert.equal(response.queued, true);
    assert.equal(response.superseded_publications, 1);
    const stats = await (await queue.fetch(new Request("https://queue/stats"))).json();
    assert.equal(stats.lanes.publication.pending, 1);
    assert.equal(stats.lanes.publication.completed_total, 1);
    assert.equal(stats.lanes.publication.superseded_total, 1);
  } finally {
    Date.now = originalNow;
  }
});

test("semantic lineage dedupe cannot leave obsolete rows eligible for a batch", async () => {
  const originalNow = Date.now;
  Date.now = () => 6_250_000;
  try {
    const queue = new ExactReviewQueue(
      { storage: new TestStorage() },
      {
        EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
        EXACT_REVIEW_PUBLICATION_BATCH_SIZE: "8",
      },
    );
    for (let index = 0; index < 101; index += 1) {
      await queue.fetch(
        publicationRequest(
          `delivery-many-old-${index}`,
          108703,
          String(2400 + index),
          "openclaw/openclaw",
          1,
        ),
      );
    }
    await queue.fetch(
      publicationRequest("delivery-many-new", 108703, "2600", "openclaw/openclaw", 2),
    );

    const before = await (await queue.fetch(new Request("https://queue/stats"))).json();
    assert.equal(before.lanes.publication.pending, 1);
    assert.equal(before.lanes.publication.semantic_deduped_total, 100);
    const claim = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-skips-obsolete-remainder",
          lease_owner: "worker-1",
          max_items: 32,
        }),
      )
    ).json();
    assert.deepEqual(
      claim.batch.items.map((item: { item_key: string }) => item.item_key),
      ["openclaw/openclaw#108703@publish:2600:1"],
    );
  } finally {
    Date.now = originalNow;
  }
});

test("stale publication ingress is acknowledged without replacing a newer revision", async () => {
  const originalNow = Date.now;
  Date.now = () => 6_300_000;
  try {
    const queue = new ExactReviewQueue(
      { storage: new TestStorage() },
      { EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1" },
    );
    await queue.fetch(publicationRequest("delivery-newer", 108701, "2202", "openclaw/openclaw", 2));
    const removedNewer = await (
      await queue.fetch(
        batchRequest("/publications/supersede", {
          items: [{ item_key: "openclaw/openclaw#108701@publish:2202:1", revision: 1 }],
        }),
      )
    ).json();
    assert.equal(removedNewer.superseded, 1);
    const response = await (
      await queue.fetch(
        publicationRequest("delivery-stale", 108701, "2201", "openclaw/openclaw", 1),
      )
    ).json();

    assert.equal(response.deduped, true);
    assert.equal(response.superseded, true);
    assert.equal(response.publication_revision, 1);
    assert.equal(response.superseded_by_revision, 2);
    const stats = await (await queue.fetch(new Request("https://queue/stats"))).json();
    assert.equal(stats.lanes.publication.pending, 0);
  } finally {
    Date.now = originalNow;
  }
});

test("publication reconcile preserves active batches and removes older revisions after expiry", async () => {
  const originalNow = Date.now;
  let now = 6_400_000;
  Date.now = () => now;
  try {
    const queue = new ExactReviewQueue(
      { storage: new TestStorage() },
      {
        EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
        EXACT_REVIEW_PUBLICATION_BATCH_LEASE_MS: "60000",
      },
    );
    await queue.fetch(
      publicationRequest("delivery-owned-old", 108702, "2301", "openclaw/openclaw", 1),
    );
    const claim = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-reconcile-protection",
          lease_owner: "worker-1",
          max_items: 1,
        }),
      )
    ).json();
    assert.equal(claim.claimed, true);
    await queue.fetch(
      publicationRequest("delivery-unowned-new", 108702, "2302", "openclaw/openclaw", 2),
    );
    const removedNewer = await (
      await queue.fetch(
        batchRequest("/publications/supersede", {
          items: [{ item_key: "openclaw/openclaw#108702@publish:2302:1", revision: 1 }],
        }),
      )
    ).json();
    assert.equal(removedNewer.superseded, 1);

    const protectedResult = await (
      await queue.fetch(batchRequest("/publications/reconcile", { apply: true, max_items: 100 }))
    ).json();
    assert.equal(protectedResult.changed, 0);
    assert.equal(protectedResult.eligible, 0);

    now += 60_001;
    const dryRun = await (
      await queue.fetch(batchRequest("/publications/reconcile", { max_items: 100 }))
    ).json();
    assert.equal(dryRun.apply, false);
    assert.equal(dryRun.eligible, 1);
    assert.equal(dryRun.changed, 0);

    const applied = await (
      await queue.fetch(batchRequest("/publications/reconcile", { apply: true, max_items: 100 }))
    ).json();
    assert.equal(applied.changed, 1);
    assert.equal(applied.eligible_remaining, 0);
    const stats = await (await queue.fetch(new Request("https://queue/stats"))).json();
    assert.equal(stats.lanes.publication.pending, 0);
  } finally {
    Date.now = originalNow;
  }
});

test("publication reconcile backfills historical duplicate lineages in bounded passes", async () => {
  const originalNow = Date.now;
  const now = 6_450_000;
  Date.now = () => now;
  try {
    const storage = new TestStorage();
    const decisions = await Promise.all(
      ["2401", "2402", "2403"].map(async (producerRunId) => {
        const payload = (await publicationRequest(
          `legacy-lineage-${producerRunId}`,
          108703,
          producerRunId,
        ).json()) as { decision: Record<string, unknown> };
        return payload.decision;
      }),
    );
    const keys = ["2401", "2402", "2403"].map(
      (producerRunId) => `openclaw/openclaw#108703@publish:${producerRunId}:1`,
    );
    await storage.put("exact-review-queue", {
      items: Object.fromEntries(
        keys.map((key, index) => [
          key,
          {
            decision: decisions[index],
            state: "pending",
            revision: 1,
            createdAt: now - (3 - index) * 100_000,
            updatedAt: now - (3 - index) * 100_000,
            nextAttemptAt: now - (3 - index) * 100_000,
            attempts: index === 0 ? 7 : 0,
            ...(index === 0
              ? {
                  publicationFailureAttempts: 2,
                  firstFailureAt: now - 300_000,
                  lastFailureReason: "state_contention",
                }
              : {}),
          },
        ]),
      ),
      deliveries: {},
    });
    const queue = new ExactReviewQueue({ storage }, {});

    const dryRun = await (
      await queue.fetch(batchRequest("/publications/reconcile", { max_items: 1 }))
    ).json();
    assert.equal(dryRun.apply, false);
    assert.equal(dryRun.eligible, 2);
    assert.equal(dryRun.changed, 0);
    assert.equal(dryRun.lineage_duplicate_eligible, 2);
    assert.equal(dryRun.oldest_eligible_age_seconds, 200);
    assert.equal(dryRun.oldest_remaining_age_seconds, 200);
    assert.equal(dryRun.sample[0].reason, "duplicate_lineage");
    assert.equal(dryRun.sample[0].retained_item_key, keys[0]);

    const firstPass = await (
      await queue.fetch(batchRequest("/publications/reconcile", { apply: true, max_items: 1 }))
    ).json();
    assert.equal(firstPass.changed, 1);
    assert.equal(firstPass.eligible_remaining, 1);
    assert.equal(firstPass.lineage_duplicate_changed, 1);
    assert.equal(firstPass.lineage_refreshed, 1);
    assert.equal(firstPass.oldest_remaining_age_seconds, 100);

    const afterFirstPass = await (
      await queue.fetch(batchRequest("/publications/list", { limit: 100 }))
    ).json();
    const retained = afterFirstPass.publications.find(
      (item: { item_key: string }) => item.item_key === keys[0],
    );
    assert.equal(retained.attempts, 7);
    assert.equal(retained.revision, 2);
    assert.equal(retained.decision.publication.producerRunId, "2403");

    const staleSupersede = await (
      await queue.fetch(
        batchRequest("/publications/supersede", {
          items: [{ item_key: keys[0], revision: 1 }],
        }),
      )
    ).json();
    assert.equal(staleSupersede.superseded, 0);

    const secondPass = await (
      await queue.fetch(batchRequest("/publications/reconcile", { apply: true, max_items: 100 }))
    ).json();
    assert.equal(secondPass.changed, 1);
    assert.equal(secondPass.eligible_remaining, 0);
    assert.equal(secondPass.lineage_duplicate_changed, 1);
    assert.equal(secondPass.lineage_refreshed, 0);
    assert.equal(secondPass.oldest_remaining_age_seconds, null);

    const stats = await (await queue.fetch(new Request("https://queue/stats"))).json();
    assert.equal(stats.lanes.publication.pending, 1);
    assert.equal(stats.lanes.publication.superseded_total, 2);
    assert.equal(stats.lanes.publication.semantic_deduped_total, 2);
  } finally {
    Date.now = originalNow;
  }
});

test("publication lineage reconcile defers the whole lineage while a batch owns it", async () => {
  const originalNow = Date.now;
  let now = 6_475_000;
  Date.now = () => now;
  try {
    const storage = new TestStorage();
    const producerRunIds = ["2501", "2502"];
    const decisions = await Promise.all(
      producerRunIds.map(async (producerRunId) => {
        const payload = (await publicationRequest(
          `legacy-owned-lineage-${producerRunId}`,
          108704,
          producerRunId,
        ).json()) as { decision: Record<string, unknown> };
        return payload.decision;
      }),
    );
    const keys = producerRunIds.map(
      (producerRunId) => `openclaw/openclaw#108704@publish:${producerRunId}:1`,
    );
    await storage.put("exact-review-queue", {
      items: Object.fromEntries(
        keys.map((key, index) => [
          key,
          {
            decision: decisions[index],
            state: "pending",
            revision: 1,
            createdAt: now - (2 - index) * 100_000,
            updatedAt: now - (2 - index) * 100_000,
            nextAttemptAt: now - (2 - index) * 100_000,
            attempts: 0,
          },
        ]),
      ),
      deliveries: {},
    });
    const queue = new ExactReviewQueue(
      { storage },
      {
        EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
        EXACT_REVIEW_PUBLICATION_BATCH_LEASE_MS: "60000",
      },
    );
    const claim = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-lineage-reconcile-protection",
          lease_owner: "worker-1",
          max_items: 1,
        }),
      )
    ).json();
    assert.equal(claim.claimed, true);
    assert.equal(claim.batch.items[0].item_key, keys[0]);

    const applied = await (
      await queue.fetch(batchRequest("/publications/reconcile", { apply: true, max_items: 100 }))
    ).json();
    assert.equal(applied.changed, 0);
    assert.equal(applied.eligible, 0);
    assert.equal(applied.lineage_duplicate_changed, 0);
    assert.equal(applied.protected_batch_items, 1);
    assert.equal(applied.protected_lineage_items, 2);

    const fetched = await (
      await queue.fetch(
        batchRequest("/publication-batches/fetch", {
          batch_id: claim.batch.batch_id,
          lease_owner: "worker-1",
        }),
      )
    ).json();
    assert.equal(fetched.batch.items[0].item_key, keys[0]);
    assert.equal(fetched.items[0].item_key, keys[0]);

    now += 60_001;
    const reconciled = await (
      await queue.fetch(batchRequest("/publications/reconcile", { apply: true, max_items: 100 }))
    ).json();
    assert.equal(reconciled.changed, 1);
    assert.equal(reconciled.lineage_duplicate_changed, 1);
    assert.equal(reconciled.lineage_refreshed, 1);

    const publications = await (
      await queue.fetch(batchRequest("/publications/list", { limit: 100 }))
    ).json();
    assert.equal(publications.publications.length, 1);
    assert.equal(publications.publications[0].item_key, keys[0]);
    assert.equal(publications.publications[0].decision.publication.producerRunId, "2502");
  } finally {
    Date.now = originalNow;
  }
});

test("batch claim scans beyond but cannot exceed the configured rollout size", async () => {
  const originalNow = Date.now;
  Date.now = () => 6_500_000;
  try {
    const queue = new ExactReviewQueue(
      { storage: new TestStorage() },
      {
        EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
        EXACT_REVIEW_PUBLICATION_BATCH_SIZE: "4",
      },
    );
    for (let itemNumber = 1; itemNumber <= 8; itemNumber += 1) {
      await queue.fetch(
        publicationRequest(`delivery-cap-${itemNumber}`, itemNumber, `${3000 + itemNumber}`),
      );
    }

    const claim = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-configured-cap",
          lease_owner: "worker-1",
          max_items: 50,
        }),
      )
    ).json();

    assert.equal(claim.claimed, true, JSON.stringify(claim));
    assert.equal(claim.requested_max_items, 50);
    assert.equal(claim.effective_max_items, 4);
    assert.equal(claim.batch.items.length, 4);
  } finally {
    Date.now = originalNow;
  }
});

test("rollout dispatches one full batch workflow without admitting legacy publishers", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = 7_000_000;
  Date.now = () => now;
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const dispatches: unknown[] = [];
  const regularDispatches: unknown[] = [];
  let signalBatchDispatch!: () => void;
  let releaseBatchDispatch!: () => void;
  const batchDispatchStarted = new Promise<void>((resolve) => {
    signalBatchDispatch = resolve;
  });
  const batchDispatchRelease = new Promise<void>((resolve) => {
    releaseBatchDispatch = resolve;
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/installation") {
      return new Response(JSON.stringify({ id: 999 }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/repos/openclaw/openclaw/installation") {
      return new Response(JSON.stringify({ id: 1000 }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/app/installations/999/access_tokens") {
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.permissions, { actions: "write", contents: "write" });
      return new Response(JSON.stringify({ token: "test-token" }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/app/installations/1000/access_tokens") {
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body, {
        repositories: ["openclaw"],
        permissions: { issues: "read", pull_requests: "read" },
      });
      return new Response(JSON.stringify({ token: "target-token" }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues/114") {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer target-token");
      return new Response(JSON.stringify({ state: "open" }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/exact-review-batch-publish.yml/dispatches"
    ) {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-token");
      dispatches.push(JSON.parse(String(init?.body)));
      signalBatchDispatch();
      await batchDispatchRelease;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml") {
      return new Response(JSON.stringify({ state: "active" }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      regularDispatches.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const storage = new TestStorage();
    const queue = new ExactReviewQueue(
      { storage },
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
        EXACT_REVIEW_PUBLICATION_BATCH_SIZE: "2",
        EXACT_REVIEW_PUBLICATION_BATCH_WAIT_MS: "60000",
        EXACT_REVIEW_PUBLICATION_BATCH_DISPATCH_RESERVATION_MS: "60000",
        EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0",
      },
    );
    await queue.fetch(publicationRequest("delivery-batch-1", 110, "1010"));
    await queue.fetch(publicationRequest("delivery-batch-2", 111, "1011"));
    await queue.fetch(reviewRequest("delivery-review", 114));

    const alarm = queue.alarm();
    await batchDispatchStarted;

    assert.equal(dispatches.length, 1);
    const [dispatch] = dispatches as Array<{
      ref: string;
      inputs: Record<string, string>;
    }>;
    assert.equal(dispatch?.ref, "main");
    assert.equal(dispatch?.inputs.execute, "true");
    assert.match(String(dispatch?.inputs.dispatch_id), /^publication-batch-dispatch:/);
    assert.equal(dispatch?.inputs.dispatched_at, "1970-01-01T01:56:40.000Z");
    const dispatchedStats = await (await queue.fetch(new Request("https://queue/stats"))).json();
    assert.equal(
      dispatchedStats.lanes.publication.batches.dispatch_pending_until,
      "1970-01-01T01:57:40.000Z",
    );
    now += 30_000;
    const stalledDispatchStats = await (
      await queue.fetch(new Request("https://queue/stats"))
    ).json();
    assert.ok(
      stalledDispatchStats.reservation_claim_observability.alerts.some(
        (alert: { kind: string }) => alert.kind === "dispatcher_handoff_stalled",
      ),
    );
    const delayedClaim = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-delayed-dispatch",
          lease_owner: "worker-delayed",
          max_items: 2,
          dispatch_id: "publication-batch-dispatch:delayed",
          dispatched_at: new Date(now - 1_000).toISOString(),
        }),
      )
    ).json();
    assert.equal(delayedClaim.claimed, false);
    assert.equal(delayedClaim.preflight_required, true);
    const claimed = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-dispatched",
          lease_owner: "worker-1",
          max_items: 2,
        }),
      )
    ).json();
    assert.equal(claimed.claimed, true);
    releaseBatchDispatch();
    await alarm;

    const stats = await (await queue.fetch(new Request("https://queue/stats"))).json();
    assert.equal(stats.lanes.publication.pending, 2);
    assert.equal(stats.lanes.publication.dispatching, 0);
    assert.equal(stats.admissible_pending, 0);
    assert.equal(stats.lanes.publication.batches.max_items, 2);
    assert.equal(stats.lanes.publication.batches.max_wait_seconds, 60);
    assert.equal(stats.lanes.publication.batches.last_dispatch_succeeded, true);
    assert.equal(stats.lanes.publication.batches.dispatch_pending_until, null);
    assert.equal(regularDispatches.length, 1);
    assert.equal(storage.scheduledAlarm(), 7_031_000);

    await queue.alarm();
    assert.equal(dispatches.length, 1);

    const partialStorage = new TestStorage();
    const partialQueue = new ExactReviewQueue(
      { storage: partialStorage },
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
        EXACT_REVIEW_PUBLICATION_BATCH_SIZE: "2",
        EXACT_REVIEW_PUBLICATION_BATCH_WAIT_MS: "60000",
      },
    );
    now = 8_000_000;
    await partialQueue.fetch(publicationRequest("delivery-partial", 112, "1012"));
    await partialQueue.alarm();
    assert.equal(dispatches.length, 1);
    assert.equal(partialStorage.scheduledAlarm(), 8_060_000);

    now = 8_060_000;
    await partialQueue.alarm();
    const secondDispatch = dispatches[1] as { ref: string; inputs: Record<string, string> };
    assert.equal(secondDispatch.ref, "main");
    assert.equal(secondDispatch.inputs.execute, "true");
    assert.match(secondDispatch.inputs.dispatch_id, /^publication-batch-dispatch:/);
    assert.equal(secondDispatch.inputs.dispatched_at, "1970-01-01T02:14:20.000Z");
    assert.equal(partialStorage.scheduledAlarm(), 8_660_000);

    const multiOwnerStorage = new TestStorage();
    const multiOwnerQueue = new ExactReviewQueue(
      { storage: multiOwnerStorage },
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
        EXACT_REVIEW_PUBLICATION_BATCH_SIZE: "2",
        EXACT_REVIEW_PUBLICATION_BATCH_WAIT_MS: "60000",
      },
    );
    now = 10_000_000;
    await multiOwnerQueue.fetch(publicationRequest("delivery-owner-a", 115, "1014", "aaa/repo"));
    await multiOwnerQueue.fetch(publicationRequest("delivery-owner-b1", 116, "1015", "bbb/repo"));
    await multiOwnerQueue.fetch(publicationRequest("delivery-owner-b2", 117, "1016", "bbb/repo"));
    await multiOwnerQueue.alarm();
    assert.equal(dispatches.length, 3);
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
  }
});

test("rollout refills concurrent batch owner slots without exceeding the cap", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = 11_000_000;
  Date.now = () => now;
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const dispatches: unknown[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/installation") {
      return new Response(JSON.stringify({ id: 999 }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/app/installations/999/access_tokens") {
      return new Response(JSON.stringify({ token: "test-token" }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/exact-review-batch-publish.yml/dispatches"
    ) {
      dispatches.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml") {
      return new Response(JSON.stringify({ state: "active" }), {
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const storage = new TestStorage();
    const queue = new ExactReviewQueue(
      { storage },
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
        EXACT_REVIEW_PUBLICATION_BATCH_SIZE: "2",
        EXACT_REVIEW_PUBLICATION_BATCH_MAX_CONCURRENT: "2",
        EXACT_REVIEW_PUBLICATION_BATCH_DISPATCH_COOLDOWN_MS: "1000",
      },
    );
    for (let itemNumber = 150; itemNumber < 155; itemNumber += 1) {
      await queue.fetch(
        publicationRequest(`delivery-refill-${itemNumber}`, itemNumber, String(5000 + itemNumber)),
      );
    }

    await queue.alarm();
    assert.equal(dispatches.length, 1);
    const first = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "refill-claim-1",
          lease_owner: "refill-worker-1",
          max_items: 2,
        }),
      )
    ).json();
    assert.equal(first.claimed, true, JSON.stringify(first));

    now += 1_000;
    await queue.alarm();
    assert.equal(dispatches.length, 2);
    const second = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "refill-claim-2",
          lease_owner: "refill-worker-2",
          max_items: 2,
        }),
      )
    ).json();
    assert.equal(second.claimed, true, JSON.stringify(second));

    now += 1_000;
    await queue.alarm();
    assert.equal(dispatches.length, 2);
    const stats = await (await queue.fetch(new Request("https://queue/stats"))).json();
    assert.equal(stats.lanes.publication.batches.leased, 2);
    assert.equal(stats.lanes.publication.batches.active_items, 4);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("batch rollout wakes a retryable publication at its next eligibility time", async () => {
  const originalNow = Date.now;
  Date.now = () => 9_000_000;
  try {
    const storage = new TestStorage();
    const queue = new ExactReviewQueue(
      { storage },
      {
        EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
        EXACT_REVIEW_PUBLICATION_BATCH_SIZE: "2",
        EXACT_REVIEW_PUBLICATION_BATCH_WAIT_MS: "60000",
      },
    );
    await queue.fetch(publicationRequest("delivery-future-retry", 113, "1013"));
    const [row] = Array.from(
      storage.sql.exec(
        "SELECT item_key, item_json FROM exact_review_queue_items WHERE item_key LIKE ?",
        "%#113@publish:%",
      ),
    ) as Array<{ item_key: string; item_json: string }>;
    assert.ok(row);
    const item = JSON.parse(row.item_json);
    item.nextAttemptAt = 9_030_000;
    Array.from(
      storage.sql.exec(
        "UPDATE exact_review_queue_items SET item_json = ? WHERE item_key = ?",
        JSON.stringify(item),
        row.item_key,
      ),
    );

    await queue.alarm();

    assert.equal(storage.scheduledAlarm(), 9_030_000);
  } finally {
    Date.now = originalNow;
  }
});

test("batch protocol routes require the shared internal signature", async () => {
  const secret = "test-secret";
  const body = JSON.stringify({ claim_id: "claim-authenticated", lease_owner: "worker-1" });
  let forwardedPath = "";
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: {
      idFromName: () => "global",
      get: () => ({
        fetch: async (request: Request) => {
          forwardedPath = new URL(request.url).pathname;
          return new Response(JSON.stringify({ ok: true }));
        },
      }),
    },
  };
  const url = "https://clawsweeper.openclaw.ai/internal/exact-review/publication-batches/claim";
  const unauthorized = await worker.fetch(new Request(url, { method: "POST", body }), env);
  assert.equal(unauthorized.status, 401);

  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const authorized = await worker.fetch(
    new Request(url, {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": signature },
      body,
    }),
    env,
  );
  assert.equal(authorized.status, 200);
  assert.equal(forwardedPath, "/publication-batches/claim");
});

test("batch claims reject partial dispatch metadata", async () => {
  const queue = new ExactReviewQueue(
    { storage: new TestStorage() },
    { EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1" },
  );
  for (const body of [
    {
      claim_id: "partial-dispatch-id",
      lease_owner: "worker-partial",
      dispatch_id: "publication-batch-dispatch:partial",
    },
    {
      claim_id: "partial-dispatch-time",
      lease_owner: "worker-partial",
      dispatched_at: "2026-07-26T08:00:00.000Z",
    },
  ]) {
    const response = await queue.fetch(batchRequest("/publication-batches/claim", body));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "invalid_batch_dispatch_metadata");
  }
});

test("publication batch observability always retains active leases beside bounded history", () => {
  const storage = new TestStorage();
  const batches = new ExactReviewPublicationBatchStore(storage);
  batches.ensureSchemaSync();
  const active = batches.claim({
    batchId: "active-observability",
    leaseOwner: "worker-active",
    leaseExpiresAt: 10_000,
    now: 1_000,
    maxItems: 1,
    maxConcurrentBatches: 2,
    candidates: [candidates[0]!],
  });
  const historical = batches.claim({
    batchId: "historical-observability",
    leaseOwner: "worker-history",
    leaseExpiresAt: 10_000,
    now: 2_000,
    maxItems: 1,
    maxConcurrentBatches: 2,
    candidates: [candidates[1]!],
  });
  assert.ok(active);
  assert.ok(historical);
  batches.complete(
    historical.batchId,
    historical.leaseOwner,
    historical.items.map((item) => ({ ...item, terminalOutcome: "published" as const })),
    3_000,
  );

  const sample = batches.observability(3_001, 1).batches;
  assert.deepEqual(
    sample.map((batch) => batch.batchId),
    ["active-observability", "historical-observability"],
  );
});

test("publication batch observability retains the most recently completed terminal history", () => {
  const storage = new TestStorage();
  const batches = new ExactReviewPublicationBatchStore(storage);
  batches.ensureSchemaSync();
  const slow = batches.claim({
    batchId: "slow-terminal-observability",
    leaseOwner: "worker-slow",
    leaseExpiresAt: 10_000,
    now: 1_000,
    maxItems: 1,
    candidates: [candidates[0]!],
  });
  const newer = batches.claim({
    batchId: "newer-terminal-observability",
    leaseOwner: "worker-newer",
    leaseExpiresAt: 10_000,
    now: 2_000,
    maxItems: 1,
    maxConcurrentBatches: 2,
    candidates: [candidates[1]!],
  });
  assert.ok(slow);
  assert.ok(newer);
  batches.complete(
    newer.batchId,
    newer.leaseOwner,
    newer.items.map((item) => ({ ...item, terminalOutcome: "published" as const })),
    2_500,
  );
  batches.complete(
    slow.batchId,
    slow.leaseOwner,
    slow.items.map((item) => ({ ...item, terminalOutcome: "published" as const })),
    3_000,
  );

  assert.deepEqual(
    batches.observability(3_001, 1).batches.map((batch) => batch.batchId),
    ["slow-terminal-observability"],
  );
});

test("reservation-to-claim observability traces one batch without exposing lease credentials", async () => {
  const originalNow = Date.now;
  let now = 18_000_000;
  Date.now = () => now;
  try {
    const queue = new ExactReviewQueue(
      { storage: new TestStorage() },
      { EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1" },
    );
    await queue.fetch(publicationRequest("reservation-claim-trace", 729, "2729"));
    now += 2_000;
    const claim = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "trace-batch-729",
          lease_owner: "worker-secret-not-public",
          max_items: 1,
          dispatch_id: "publication-batch-dispatch:trace-729",
          dispatched_at: new Date(now - 1_000).toISOString(),
          runner_run_id: "92729",
          runner_run_attempt: 3,
          runner_started_at: new Date(now - 500).toISOString(),
        }),
      )
    ).json();
    const member = claim.batch.items[0];
    const claimedStats = await (await queue.fetch(new Request("https://queue/stats"))).json();
    assert.equal(claimedStats.reservation_claim_observability.queue_slots.active_items, 1);
    assert.equal(claimedStats.reservation_claim_observability.queue_slots.unassigned_pending, 0);
    assert.ok(
      !claimedStats.reservation_claim_observability.alerts.some(
        (alert: { kind: string }) => alert.kind === "no_capacity",
      ),
    );
    const heartbeat = (
      timelineStage: string,
      observedAt: number,
      progress?: Record<string, unknown>,
    ) =>
      batchRequest("/publication-batches/heartbeat", {
        batch_id: claim.batch.batch_id,
        lease_owner: "worker-secret-not-public",
        items: [member],
        ...(progress ? { state_writer_progress: progress } : {}),
        ...(timelineStage
          ? { timeline_stage: timelineStage, observed_at: new Date(observedAt).toISOString() }
          : {}),
      });
    now += 500;
    assert.equal((await queue.fetch(heartbeat("preparation_started", now))).status, 200);
    now += 500;
    assert.equal((await queue.fetch(heartbeat("preparation_finished", now))).status, 200);
    now += 500;
    assert.equal(
      (
        await queue.fetch(
          heartbeat("", now, {
            schema_version: 1,
            operation_id: `batch:${claim.batch.batch_id}`,
            mode: "batch",
            phase: "waiting",
            sequence: 1,
            observed_at: new Date(now).toISOString(),
            configured_batch_size: 1,
            actual_batch_size: 1,
          }),
        )
      ).status,
      200,
    );
    now += 500;
    assert.equal((await queue.fetch(heartbeat("final_github_apply", now))).status, 200);
    now += 500;
    assert.equal((await queue.fetch(heartbeat("github_throttle", now))).status, 200);
    now += 500;
    const completed = await (
      await queue.fetch(
        batchRequest("/publication-batches/complete", {
          batch_id: claim.batch.batch_id,
          lease_owner: "worker-secret-not-public",
          state_commit_sha: "a".repeat(40),
          failure_fingerprint: "failure-body-secret-not-public",
          state_writer: {
            schema_version: 1,
            operation_id: `batch:${claim.batch.batch_id}`,
            mode: "batch",
            started_at: new Date(now - 1_000).toISOString(),
            finished_at: new Date(now).toISOString(),
            wait_ms: 500,
            acquire_attempts: 1,
            acquired: true,
            hold_ms: 500,
            renewals: 0,
            released: true,
            git_duration_ms: 1_000,
            git_processes: 1,
            commit_count: 1,
            materialized_items: 1,
            configured_batch_size: 1,
            actual_batch_size: 1,
            batch_wait_ms: 0,
            outcome: "materialized",
          },
          items: [
            {
              item_key: member.item_key,
              revision: member.revision,
              claim_generation: member.claim_generation,
              terminal_outcome: "published",
            },
          ],
        }),
      )
    ).json();
    assert.equal(completed.accepted, 1, JSON.stringify(completed));

    const stats = await (await queue.fetch(new Request("https://queue/stats"))).json();
    const observability = stats.reservation_claim_observability;
    assert.deepEqual(observability.publication_paths, {
      cloudflare_canonical_direct: {
        enabled: true,
        reservation_to_claim: "not_applicable",
        state_writer_timing: "not_applicable",
      },
      legacy_state_repo_batch: {
        enabled: true,
        reservation_to_claim: "tracked",
        state_writer_timing: "tracked",
      },
    });
    const batch = observability.batches.find(
      (entry: { batch_id: string }) => entry.batch_id === claim.batch.batch_id,
    );
    assert.ok(batch, JSON.stringify(observability));
    assert.equal(batch.publication_path, "legacy_state_repo_batch");
    assert.equal(batch.dispatch.id, "publication-batch-dispatch:trace-729");
    assert.equal(batch.workflow.run_id, "92729");
    assert.equal(batch.workflow.run_attempt, 3);
    assert.ok(batch.workflow.runner_started_at);
    assert.ok(batch.timeline.preparation_started_at);
    assert.ok(batch.timeline.preparation_finished_at);
    assert.ok(batch.timeline.state_writer_wait_at);
    assert.ok(batch.timeline.state_writer_committed_at);
    assert.ok(batch.timeline.final_github_apply_at);
    assert.ok(batch.timeline.github_throttle_at);
    assert.equal(batch.items[0].producer_run_id, "2729");
    assert.equal(batch.items[0].reservation_to_claim_ms, 1_000);
    assert.equal(batch.items[0].enqueue_to_claim_ms, 2_000);
    assert.equal(observability.delay_buckets.metric, "reservation_to_claim_ms");
    assert.ok(
      observability.alerts.some((alert: { kind: string }) => alert.kind === "github_throttle"),
    );
    assert.match(JSON.stringify(observability), /publication-batch-dispatch:trace-729/);
    assert.doesNotMatch(JSON.stringify(observability), /worker-secret-not-public/);
    assert.doesNotMatch(JSON.stringify(observability), /failure-body-secret-not-public/);
  } finally {
    Date.now = originalNow;
  }
});

test("authenticated publication reconciliation dry-run reports without mutation", async () => {
  const originalNow = Date.now;
  const now = 13_000_000;
  Date.now = () => now;
  try {
    const secret = "test-secret";
    const producerRunIds = ["2601", "2602"];
    const decisions = await Promise.all(
      producerRunIds.map(async (producerRunId) => {
        const payload = (await publicationRequest(
          `authenticated-dry-run-${producerRunId}`,
          108705,
          producerRunId,
        ).json()) as { decision: Record<string, unknown> };
        return payload.decision;
      }),
    );
    const storage = new TestStorage();
    await storage.put("exact-review-queue", {
      items: Object.fromEntries(
        producerRunIds.map((producerRunId, index) => [
          `openclaw/openclaw#108705@publish:${producerRunId}:1`,
          {
            decision: decisions[index],
            state: "pending",
            revision: 1,
            createdAt: now - (2 - index) * 60_000,
            updatedAt: now - (2 - index) * 60_000,
            nextAttemptAt: now - (2 - index) * 60_000,
            attempts: 0,
          },
        ]),
      ),
      deliveries: {},
    });
    const queue = new ExactReviewQueue({ storage }, {});
    let forwardedPath = "";
    const env = {
      CLAWSWEEPER_WEBHOOK_SECRET: secret,
      EXACT_REVIEW_QUEUE: {
        idFromName: () => "global",
        get: () => ({
          fetch: async (request: Request) => {
            forwardedPath = new URL(request.url).pathname;
            return queue.fetch(request);
          },
        }),
      },
    };
    const body = JSON.stringify({ apply: false, max_items: 1 });
    const url = "https://clawsweeper.openclaw.ai/internal/exact-review/publications/reconcile";
    const unauthorized = await worker.fetch(new Request(url, { method: "POST", body }), env);
    assert.equal(unauthorized.status, 401);

    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    const authorized = await worker.fetch(
      new Request(url, {
        method: "POST",
        headers: { "x-clawsweeper-exact-review-signature": signature },
        body,
      }),
      env,
    );
    assert.equal(authorized.status, 200);
    assert.equal(forwardedPath, "/publications/reconcile");
    const result = await authorized.json();
    assert.equal(result.apply, false);
    assert.equal(result.eligible, 1);
    assert.equal(result.changed, 0);
    assert.equal(result.eligible_remaining, 1);
    assert.equal(result.lineage_duplicate_eligible, 1);
    assert.equal(result.protected_lineage_items, 0);
    assert.equal(result.oldest_eligible_age_seconds, 60);
    const stats = await (await queue.fetch(new Request("https://queue/stats"))).json();
    assert.equal(stats.lanes.publication.pending, 2);

    if (process.env.CLAWSWEEPER_EVIDENCE_TRANSCRIPT === "1") {
      console.log(
        `AUTHENTICATED_PUBLICATION_RECONCILE_DRY_RUN=${JSON.stringify({
          http_status: authorized.status,
          apply: result.apply,
          scanned: result.scanned,
          eligible: result.eligible,
          changed: result.changed,
          eligible_remaining: result.eligible_remaining,
          lineage_duplicate_eligible: result.lineage_duplicate_eligible,
          protected_batch_items: result.protected_batch_items,
          protected_lineage_items: result.protected_lineage_items,
          oldest_eligible_age_seconds: result.oldest_eligible_age_seconds,
          pending_before: 2,
          pending_after: stats.lanes.publication.pending,
        })}`,
      );
    }
  } finally {
    Date.now = originalNow;
  }
});

test("queue fetch terminalizes a stale batch revision before dispatch", async () => {
  const originalNow = Date.now;
  Date.now = () => 1_000_000;
  try {
    const storage = new TestStorage();
    const queue = new ExactReviewQueue(
      { storage },
      {
        EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
        EXACT_REVIEW_PUBLICATION_BATCH_LEASE_MS: "60000",
      },
    );
    const enqueued = await queue.fetch(publicationRequest("delivery-stale-1", 102, "1002"));
    assert.equal(enqueued.status, 202, JSON.stringify(await enqueued.clone().json()));
    const beforeClaim = await (await queue.fetch(new Request("https://queue/stats"))).json();
    assert.equal(beforeClaim.lanes.publication.pending, 1, JSON.stringify(beforeClaim));
    const claim = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-stale-revision-1",
          lease_owner: "worker-1",
          max_items: 1,
          runner_run_id: "91002",
          runner_run_attempt: 1,
          runner_started_at: "2026-07-30T12:00:00.000Z",
        }),
      )
    ).json();
    assert.equal(claim.claimed, true, JSON.stringify(claim));
    assert.equal(claim.batch.items[0].revision, 1);

    const retriedClaim = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-stale-revision-1",
          lease_owner: "worker-1",
          max_items: 1,
        }),
      )
    ).json();
    assert.deepEqual(retriedClaim, claim);

    const competingClaim = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-competing",
          lease_owner: "worker-2",
          max_items: 1,
        }),
      )
    ).json();
    assert.equal(competingClaim.claimed, false);
    assert.equal(competingClaim.batch, null);

    await queue.alarm();
    const ownedStats = await (await queue.fetch(new Request("https://queue/stats"))).json();
    assert.equal(ownedStats.lanes.publication.pending, 1);
    assert.equal(ownedStats.lanes.publication.dispatching, 0);
    assert.equal(storage.scheduledAlarm(), 1_060_000);

    await queue.fetch(publicationRequest("delivery-stale-2", 102, "1002"));
    const fetched = await (
      await queue.fetch(
        batchRequest("/publication-batches/fetch", {
          batch_id: claim.batch.batch_id,
          lease_owner: "worker-1",
        }),
      )
    ).json();
    assert.equal(fetched.superseded, 1);
    assert.equal(fetched.items.length, 0);
    assert.equal(fetched.batch.state, "completed");
    assert.equal(fetched.batch.items[0].terminal_outcome, "superseded");
    assert.equal(storage.scheduledAlarm(), 1_060_000);
    const lifecycleRow = Array.from(
      storage.sql.exec(
        `SELECT projection_json FROM ${EXACT_REVIEW_LIFECYCLE_PROJECTION_TABLE}
          WHERE canonical_target_key = ? AND fence_key = ? AND revision = ?`,
        "openclaw/openclaw#102",
        claim.batch.items[0].item_key,
        1,
      ),
    )[0] as { projection_json: string };
    const lifecycle = JSON.parse(lifecycleRow.projection_json) as {
      terminalDisposition: { kind: string } | null;
      reviewResults: Array<{ outcome: string }>;
    };
    assert.equal(lifecycle.terminalDisposition?.kind, "superseded");
    assert.equal(lifecycle.reviewResults[0]?.outcome, "completed");

    const retriedFetch = await (
      await queue.fetch(
        batchRequest("/publication-batches/fetch", {
          batch_id: claim.batch.batch_id,
          lease_owner: "worker-1",
        }),
      )
    ).json();
    assert.equal(retriedFetch.batch.state, "completed");
    assert.equal(retriedFetch.superseded, 1);

    const next = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-stale-revision-2",
          lease_owner: "worker-2",
          max_items: 1,
        }),
      )
    ).json();
    assert.equal(next.batch.items[0].revision, 2);
    assert.equal(next.batch.items[0].claim_generation, 2);
  } finally {
    Date.now = originalNow;
  }
});

test("batch heartbeat extends only the active fenced lease", async () => {
  const originalNow = Date.now;
  Date.now = () => 1_500_000;
  try {
    const queue = new ExactReviewQueue(
      { storage: new TestStorage() },
      {
        EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
        EXACT_REVIEW_PUBLICATION_BATCH_LEASE_MS: "60000",
      },
    );
    await queue.fetch(publicationRequest("delivery-heartbeat-1", 110, "1010"));
    await queue.fetch(publicationRequest("delivery-heartbeat-2", 111, "1011"));
    const claim = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-heartbeat",
          lease_owner: "worker-1",
          max_items: 2,
        }),
      )
    ).json();
    assert.equal(claim.batch.lease_expires_at, new Date(1_560_000).toISOString());
    const members = claim.batch.items.map((item) => ({
      item_key: item.item_key,
      revision: item.revision,
      claim_generation: item.claim_generation,
    }));

    Date.now = () => 1_530_000;
    const heartbeat = await (
      await queue.fetch(
        batchRequest("/publication-batches/heartbeat", {
          batch_id: claim.batch.batch_id,
          lease_owner: "worker-1",
          items: members,
        }),
      )
    ).json();
    assert.equal(heartbeat.batch.lease_expires_at, new Date(1_590_000).toISOString());

    await queue.fetch(publicationRequest("delivery-heartbeat-3", 110, "1010"));
    const fetched = await (
      await queue.fetch(
        batchRequest("/publication-batches/fetch", {
          batch_id: claim.batch.batch_id,
          lease_owner: "worker-1",
        }),
      )
    ).json();
    assert.equal(fetched.superseded, 1);
    assert.equal(fetched.items.length, 1);

    Date.now = () => 1_540_000;
    const originalFence = await (
      await queue.fetch(
        batchRequest("/publication-batches/heartbeat", {
          batch_id: claim.batch.batch_id,
          lease_owner: "worker-1",
          items: members,
        }),
      )
    ).json();
    assert.equal(originalFence.batch.lease_expires_at, new Date(1_600_000).toISOString());

    const staleOwner = await queue.fetch(
      batchRequest("/publication-batches/heartbeat", {
        batch_id: claim.batch.batch_id,
        lease_owner: "worker-2",
        items: members,
      }),
    );
    assert.equal(staleOwner.status, 409);

    const staleGeneration = await queue.fetch(
      batchRequest("/publication-batches/heartbeat", {
        batch_id: claim.batch.batch_id,
        lease_owner: "worker-1",
        items: members.map((item) => ({
          ...item,
          claim_generation: item.claim_generation + 1,
        })),
      }),
    );
    assert.equal(staleGeneration.status, 409);

    Date.now = () => 1_600_000;
    const expired = await queue.fetch(
      batchRequest("/publication-batches/heartbeat", {
        batch_id: claim.batch.batch_id,
        lease_owner: "worker-1",
        items: members,
      }),
    );
    assert.equal(expired.status, 409);
  } finally {
    Date.now = originalNow;
  }
});

test("batch admission keeps one target owner for least-privilege credentials", async () => {
  const originalNow = Date.now;
  let now = 1_700_000;
  Date.now = () => now;
  try {
    const queue = new ExactReviewQueue(
      { storage: new TestStorage() },
      { EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1" },
    );
    await queue.fetch(publicationRequest("owner-a-1", 120, "1020"));
    now += 1;
    await queue.fetch(publicationRequest("owner-b", 121, "1021", "example/project"));
    now += 1;
    await queue.fetch(publicationRequest("owner-a-2", 122, "1022"));
    const claim = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-owner-scoped",
          lease_owner: "worker-1",
          max_items: 3,
        }),
      )
    ).json();
    assert.deepEqual(
      claim.batch.items.map((item) => item.item_key),
      ["openclaw/openclaw#120@publish:1020:1", "openclaw/openclaw#122@publish:1022:1"],
    );
  } finally {
    Date.now = originalNow;
  }
});

test("batch ask widens owner scanning without exceeding the configured lease size", async () => {
  const originalNow = Date.now;
  let now = 1_800_000;
  Date.now = () => now;
  try {
    const queue = new ExactReviewQueue(
      { storage: new TestStorage() },
      {
        EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
        EXACT_REVIEW_PUBLICATION_BATCH_SIZE: "2",
      },
    );
    await queue.fetch(publicationRequest("owner-a-oldest", 130, "1030"));
    now += 1;
    await queue.fetch(publicationRequest("owner-b-interleaved", 131, "1031", "example/project"));
    now += 1;
    await queue.fetch(publicationRequest("owner-a-second", 132, "1032"));
    now += 1;
    await queue.fetch(publicationRequest("owner-a-over-cap", 133, "1033"));

    const claim = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-owner-scan-cap",
          lease_owner: "worker-1",
          max_items: 4,
        }),
      )
    ).json();

    assert.deepEqual(
      claim.batch.items.map((item) => item.item_key),
      ["openclaw/openclaw#130@publish:1030:1", "openclaw/openclaw#132@publish:1032:1"],
    );
    assert.equal(claim.configured_batch_size, 2);
  } finally {
    Date.now = originalNow;
  }
});

test("aged superseded publication does not dispatch a fresh owner before its deadline", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = 1_850_000;
  const agedEnqueuedAt = now;
  Date.now = () => now;
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const checkedTargets: string[] = [];
  const dispatches: Array<{ inputs: Record<string, string> }> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/installation") {
      return new Response(JSON.stringify({ id: 999 }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/repos/fresh/repo/installation") {
      return new Response(JSON.stringify({ id: 1001 }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/app/installations/999/access_tokens") {
      return new Response(JSON.stringify({ token: "dispatch-token" }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/app/installations/1001/access_tokens") {
      return new Response(JSON.stringify({ token: "fresh-token" }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/repos/fresh/repo/issues/161") {
      checkedTargets.push("fresh/repo#161");
      return new Response(JSON.stringify({ state: "open" }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/exact-review-batch-publish.yml/dispatches"
    ) {
      dispatches.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const storage = new TestStorage();
    const queue = new ExactReviewQueue(
      { storage },
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
        EXACT_REVIEW_PUBLICATION_BATCH_SIZE: "2",
        EXACT_REVIEW_PUBLICATION_BATCH_LEASE_MS: "60000",
        EXACT_REVIEW_PUBLICATION_BATCH_WAIT_MS: "300000",
        EXACT_REVIEW_PUBLICATION_FRESH_LANE_ENABLED: "1",
        EXACT_REVIEW_PUBLICATION_FRESH_LANE_MAX_ITEMS: "1",
        EXACT_REVIEW_PUBLICATION_FRESH_LANE_MAX_AGE_MS: "60000",
      },
    );
    await queue.fetch(publicationRequest("superseded-aged-1", 160, "1060", "stale/repo", 1));
    const owned = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-superseded-aged",
          lease_owner: "worker-1",
          max_items: 1,
        }),
      )
    ).json();
    assert.equal(owned.claimed, true, JSON.stringify(owned));

    now += 1;
    await queue.fetch(publicationRequest("superseded-aged-2", 160, "1061", "stale/repo", 2));
    const removedNewer = await (
      await queue.fetch(
        batchRequest("/publications/supersede", {
          items: [{ item_key: "stale/repo#160@publish:1061:1", revision: 1 }],
        }),
      )
    ).json();
    assert.equal(removedNewer.superseded, 1);

    now = agedEnqueuedAt + 300_001;
    const freshEnqueuedAt = now;
    await queue.fetch(publicationRequest("valid-fresh-owner", 161, "1062", "fresh/repo"));
    await queue.alarm();

    assert.deepEqual(checkedTargets, []);
    assert.equal(dispatches.length, 0);
    assert.equal(storage.scheduledAlarm(), freshEnqueuedAt + 300_000);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("oldest publication aging deadline drives the alarm and then its owner claim", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = 1_900_000;
  const agingDeadline = now + 300_000;
  Date.now = () => now;
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const dispatches: Array<{ inputs: Record<string, string> }> = [];
  const checkedTargets: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/installation") {
      return new Response(JSON.stringify({ id: 999 }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/repos/aged/repo/installation") {
      return new Response(JSON.stringify({ id: 1000 }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/app/installations/999/access_tokens") {
      return new Response(JSON.stringify({ token: "dispatch-token" }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/app/installations/1000/access_tokens") {
      return new Response(JSON.stringify({ token: "aged-token" }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/repos/aged/repo/issues/140") {
      checkedTargets.push("aged/repo#140");
      return new Response(JSON.stringify({ state: "open" }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/exact-review-batch-publish.yml/dispatches"
    ) {
      dispatches.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const storage = new TestStorage();
    const queue = new ExactReviewQueue(
      { storage },
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
        EXACT_REVIEW_PUBLICATION_BATCH_SIZE: "4",
        EXACT_REVIEW_PUBLICATION_BATCH_WAIT_MS: "300000",
        EXACT_REVIEW_PUBLICATION_FRESH_LANE_ENABLED: "1",
        EXACT_REVIEW_PUBLICATION_FRESH_LANE_MAX_ITEMS: "1",
        EXACT_REVIEW_PUBLICATION_FRESH_LANE_MAX_AGE_MS: "60000",
      },
    );
    await queue.fetch(publicationRequest("owner-aged", 140, "1040", "aged/repo"));
    now += 120_000;
    await queue.fetch(publicationRequest("owner-fresh", 141, "1041", "fresh/repo"));

    await queue.alarm();

    assert.deepEqual(checkedTargets, []);
    assert.equal(dispatches.length, 0);
    assert.equal(storage.scheduledAlarm(), agingDeadline);

    now = agingDeadline - 1;
    await queue.fetch(publicationRequest("owner-fresh-replenished", 142, "1042", "fresh/repo"));
    now = agingDeadline;
    await queue.alarm();

    assert.deepEqual(checkedTargets, ["aged/repo#140"]);
    assert.equal(dispatches.length, 1);
    const dispatch = dispatches[0]!;
    const claim = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-aged-owner",
          lease_owner: "worker-1",
          max_items: 50,
          dispatch_id: dispatch.inputs.dispatch_id,
          dispatched_at: dispatch.inputs.dispatched_at,
        }),
      )
    ).json();
    assert.equal(claim.claimed, true, JSON.stringify(claim));
    assert.deepEqual(
      claim.batch.items.map((item: { item_key: string }) => item.item_key),
      ["aged/repo#140@publish:1040:1"],
    );
    if (process.env.CLAWSWEEPER_EVIDENCE_TRANSCRIPT === "1") {
      console.log(
        `PUBLICATION_OWNER_AGING_PROOF=${JSON.stringify({
          early_alarm_at: new Date(agingDeadline).toISOString(),
          alarm_dispatched: dispatches.length === 1,
          terminal_preflight: checkedTargets,
          claimed_items: claim.batch.items.map((item: { item_key: string }) => item.item_key),
        })}`,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("Bay no-progress recovery backs off without duplicating an aged publication owner", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = 20_000_000;
  Date.now = () => now;
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const dispatches: Array<{ inputs: Record<string, string> }> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/installation") {
      return new Response(JSON.stringify({ id: 999 }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/repos/aged/repo/installation") {
      return new Response(JSON.stringify({ id: 1000 }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/app/installations/999/access_tokens") {
      return new Response(JSON.stringify({ token: "dispatch-token" }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/app/installations/1000/access_tokens") {
      return new Response(JSON.stringify({ token: "aged-token" }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/repos/aged/repo/issues/170") {
      return new Response(JSON.stringify({ state: "open" }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/exact-review-batch-publish.yml/dispatches"
    ) {
      dispatches.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const storage = new TestStorage();
    const env = {
      CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
      CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
      EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
      EXACT_REVIEW_PUBLICATION_BATCH_SIZE: "1",
      EXACT_REVIEW_PUBLICATION_BATCH_WAIT_MS: "60000",
      EXACT_REVIEW_PUBLICATION_BATCH_LEASE_MS: "600000",
      EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0",
    };
    let queue = new ExactReviewQueue({ storage }, env);
    await queue.fetch(publicationRequest("bay-backoff-aged", 170, "1170", "aged/repo"));
    const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
    const stalledIdentity = {
      canonicalTargetKey: "openclaw/openclaw#9170",
      fenceKey: "openclaw/openclaw#9170@exact:1",
      revision: 1,
    };
    lifecycle.recordAdmission({
      ...stalledIdentity,
      deliveryId: "bay-backoff-stalled",
      sourceAction: "opened",
      commandOriginated: false,
      statusMarker: null,
      statusCommentId: null,
      triggeredAt: now,
      observedAt: now,
    });
    lifecycle.markBayTelemetryPending(stalledIdentity);
    storage.run(
      `UPDATE ${EXACT_REVIEW_LIFECYCLE_PROJECTION_TABLE}
          SET projection_json = ?
        WHERE canonical_target_key = ? AND fence_key = ? AND revision = ?`,
      "{",
      stalledIdentity.canonicalTargetKey,
      stalledIdentity.fenceKey,
      stalledIdentity.revision,
    );

    now += 60_000;
    await queue.alarm();
    assert.equal(dispatches.length, 1);
    const stalledRetryAt = now + 60_000;
    assert.equal(storage.scheduledAlarm(), stalledRetryAt);
    now += 2_000;
    await storage.setAlarm(now);
    await queue.alarm();
    assert.equal(dispatches.length, 1);
    assert.equal(storage.scheduledAlarm(), stalledRetryAt);
    const trafficIdentity = {
      canonicalTargetKey: "openclaw/openclaw#9180",
      fenceKey: "openclaw/openclaw#9180@exact:1",
      revision: 1,
    };
    lifecycle.recordAdmission({
      ...trafficIdentity,
      deliveryId: "bay-backoff-traffic",
      sourceAction: "opened",
      commandOriginated: false,
      statusMarker: null,
      statusCommentId: null,
      triggeredAt: now,
      observedAt: now,
    });
    const traffic = await queue.fetch(
      batchRequest("/lifecycle/terminal-disposition", {
        canonical_target_key: trafficIdentity.canonicalTargetKey,
        fence_key: trafficIdentity.fenceKey,
        revision: trafficIdentity.revision,
        kind: "failure",
      }),
    );
    assert.equal(traffic.status, 200);
    assert.equal(storage.scheduledAlarm(), stalledRetryAt);
    const dispatch = dispatches[0]!;
    now += 10_000;
    const staleClaim = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-bay-backoff-stale",
          lease_owner: "worker-stale",
          max_items: 1,
          dispatch_id: "publication-batch-dispatch:stale",
          dispatched_at: new Date(now - 1_000).toISOString(),
        }),
      )
    ).json();
    assert.equal(staleClaim.claimed, false);
    assert.equal(staleClaim.preflight_required, true);

    const claim = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-bay-backoff",
          lease_owner: "worker-1",
          max_items: 1,
          dispatch_id: dispatch.inputs.dispatch_id,
          dispatched_at: dispatch.inputs.dispatched_at,
        }),
      )
    ).json();
    assert.equal(claim.claimed, true, JSON.stringify(claim));
    assert.equal(claim.batch.items.length, 1);
    const members = claim.batch.items.map((item) => ({
      item_key: item.item_key,
      revision: item.revision,
      claim_generation: item.claim_generation,
    }));
    const heartbeat = await queue.fetch(
      batchRequest("/publication-batches/heartbeat", {
        batch_id: claim.batch.batch_id,
        lease_owner: "worker-1",
        items: members,
      }),
    );
    assert.equal(heartbeat.status, 200, JSON.stringify(await heartbeat.clone().json()));

    const competingClaim = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-bay-backoff-competing",
          lease_owner: "worker-2",
          max_items: 1,
        }),
      )
    ).json();
    assert.equal(competingClaim.claimed, false);
    assert.equal(competingClaim.batch, null);

    now = stalledRetryAt;
    await queue.alarm();
    const stats = await (await queue.fetch(new Request("https://queue/stats"))).json();
    assert.equal(dispatches.length, 1);
    assert.equal(stats.lanes.publication.batches.active_items, 1);
    assert.equal(storage.scheduledAlarm(), now + 60_000);

    const progressingStorage = new TestStorage();
    const progressingQueue = new ExactReviewQueue({ storage: progressingStorage }, {});
    await progressingQueue.fetch(new Request("https://queue/stats"));
    const progressingLifecycle = new ExactReviewLifecycleProjectionStore(progressingStorage);
    for (let index = 0; index < 257; index += 1) {
      const identity = {
        canonicalTargetKey: `openclaw/openclaw#${9_500 + index}`,
        fenceKey: `openclaw/openclaw#${9_500 + index}@exact:1`,
        revision: 1,
      };
      progressingLifecycle.recordAdmission({
        ...identity,
        deliveryId: `bay-backoff-progress:${index}`,
        sourceAction: "opened",
        commandOriginated: false,
        statusMarker: null,
        statusCommentId: null,
        triggeredAt: now,
        observedAt: now,
      });
      progressingLifecycle.markBayTelemetryPending(identity);
    }
    progressingStorage.failSqlMatchingAfter(/INSERT INTO exact_review_lifecycle_projection_v1/, 1);
    await progressingQueue.alarm();
    assert.equal(progressingStorage.scheduledAlarm(), now + 1_000);

    const clearedStorage = new TestStorage();
    const clearedQueue = new ExactReviewQueue({ storage: clearedStorage }, {});
    await clearedQueue.fetch(new Request("https://queue/stats"));
    const clearedLifecycle = new ExactReviewLifecycleProjectionStore(clearedStorage);
    const clearedIdentity = {
      canonicalTargetKey: "openclaw/openclaw#9800",
      fenceKey: "openclaw/openclaw#9800@exact:1",
      revision: 1,
    };
    clearedLifecycle.recordAdmission({
      ...clearedIdentity,
      deliveryId: "bay-backoff-cleared",
      sourceAction: "opened",
      commandOriginated: false,
      statusMarker: null,
      statusCommentId: null,
      triggeredAt: now,
      observedAt: now,
    });
    clearedLifecycle.markBayTelemetryPending(clearedIdentity);
    clearedStorage.run(
      `UPDATE ${EXACT_REVIEW_LIFECYCLE_PROJECTION_TABLE}
          SET projection_json = ?
        WHERE canonical_target_key = ? AND fence_key = ? AND revision = ?`,
      "{",
      clearedIdentity.canonicalTargetKey,
      clearedIdentity.fenceKey,
      clearedIdentity.revision,
    );
    await clearedQueue.alarm();
    assert.equal(clearedStorage.scheduledAlarm(), now + 60_000);
    clearedStorage.run(
      `DELETE FROM ${EXACT_REVIEW_LIFECYCLE_PROJECTION_TABLE}
        WHERE canonical_target_key = ? AND fence_key = ? AND revision = ?`,
      clearedIdentity.canonicalTargetKey,
      clearedIdentity.fenceKey,
      clearedIdentity.revision,
    );
    await clearedQueue.fetch(new Request("https://queue/stats"));
    const laterIdentity = {
      canonicalTargetKey: "openclaw/openclaw#9801",
      fenceKey: "openclaw/openclaw#9801@exact:1",
      revision: 1,
    };
    clearedLifecycle.recordAdmission({
      ...laterIdentity,
      deliveryId: "bay-backoff-later",
      sourceAction: "opened",
      commandOriginated: false,
      statusMarker: null,
      statusCommentId: null,
      triggeredAt: now,
      observedAt: now,
    });
    clearedLifecycle.markBayTelemetryPending(laterIdentity);
    await clearedQueue.fetch(new Request("https://queue/stats"));
    assert.equal(clearedStorage.scheduledAlarm(), now + 1_000);

    if (process.env.CLAWSWEEPER_EVIDENCE_TRANSCRIPT === "1") {
      console.log(
        `BAY_RECOVERY_BACKOFF_PROOF=${JSON.stringify({
          no_progress_alarm_delay_ms: 60_000,
          dispatch_count: dispatches.length,
          stale_claimed: staleClaim.claimed,
          heartbeat_status: heartbeat.status,
          active_items: stats.lanes.publication.batches.active_items,
          progress_alarm_delay_ms: 1_000,
          cleared_deadline_alarm_delay_ms: 1_000,
        })}`,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("fresh publication owner still wins when no owner's work has aged", async () => {
  const originalNow = Date.now;
  let now = 1_950_000;
  Date.now = () => now;
  try {
    const queue = new ExactReviewQueue(
      { storage: new TestStorage() },
      {
        EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
        EXACT_REVIEW_PUBLICATION_BATCH_SIZE: "2",
        EXACT_REVIEW_PUBLICATION_BATCH_WAIT_MS: "300000",
        EXACT_REVIEW_PUBLICATION_FRESH_LANE_ENABLED: "1",
        EXACT_REVIEW_PUBLICATION_FRESH_LANE_MAX_ITEMS: "1",
        EXACT_REVIEW_PUBLICATION_FRESH_LANE_MAX_AGE_MS: "60000",
      },
    );
    await queue.fetch(publicationRequest("owner-full-1", 150, "1050", "full/repo"));
    now += 1;
    await queue.fetch(publicationRequest("owner-full-2", 151, "1051", "full/repo"));
    now += 60_001;
    await queue.fetch(publicationRequest("owner-fresh-only", 152, "1052", "fresh/repo"));

    const claim = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-fresh-owner",
          lease_owner: "worker-1",
          max_items: 50,
        }),
      )
    ).json();

    assert.equal(claim.claimed, true, JSON.stringify(claim));
    assert.deepEqual(
      claim.batch.items.map((item: { item_key: string }) => item.item_key),
      ["fresh/repo#152@publish:1052:1"],
    );
  } finally {
    Date.now = originalNow;
  }
});

test("fresh publication admission reserves bounded service and preserves historical FIFO", async () => {
  const originalNow = Date.now;
  let now = 2_000_000;
  Date.now = () => now;
  try {
    const queue = new ExactReviewQueue(
      { storage: new TestStorage() },
      {
        EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
        EXACT_REVIEW_PUBLICATION_BATCH_SIZE: "4",
        EXACT_REVIEW_PUBLICATION_FRESH_LANE_ENABLED: "1",
        EXACT_REVIEW_PUBLICATION_FRESH_LANE_MAX_ITEMS: "1",
        EXACT_REVIEW_PUBLICATION_FRESH_LANE_MAX_AGE_MS: "60000",
      },
    );
    for (let itemNumber = 10; itemNumber <= 13; itemNumber += 1) {
      await queue.fetch(
        publicationRequest(`historical-${itemNumber}`, itemNumber, String(7000 + itemNumber)),
      );
      now += 1;
    }
    now += 60_001;
    for (let itemNumber = 90; itemNumber <= 92; itemNumber += 1) {
      await queue.fetch(
        publicationRequest(`fresh-${itemNumber}`, itemNumber, String(7100 + itemNumber)),
      );
      now += 1;
    }

    const stats = await (await queue.fetch(new Request("https://queue/stats"))).json();
    assert.deepEqual(stats.lanes.publication.batches.fresh_lane, {
      enabled: true,
      reserved_items: 1,
      max_age_seconds: 60,
      ready_items: 3,
      historical_ready_items: 4,
    });

    const claim = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-fresh-reserve",
          lease_owner: "worker-1",
          max_items: 50,
        }),
      )
    ).json();
    assert.deepEqual(
      claim.batch.items.map((item: { item_key: string }) => item.item_key),
      [
        "openclaw/openclaw#10@publish:7010:1",
        "openclaw/openclaw#11@publish:7011:1",
        "openclaw/openclaw#12@publish:7012:1",
        "openclaw/openclaw#90@publish:7190:1",
      ],
    );
  } finally {
    Date.now = originalNow;
  }
});

test("continuously replenished fresh work preserves historical progress across batches", async () => {
  const originalNow = Date.now;
  let now = 2_500_000;
  Date.now = () => now;
  try {
    const queue = new ExactReviewQueue(
      { storage: new TestStorage() },
      {
        EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
        EXACT_REVIEW_PUBLICATION_BATCH_SIZE: "4",
        EXACT_REVIEW_PUBLICATION_BATCH_MAX_CONCURRENT: "2",
        EXACT_REVIEW_PUBLICATION_FRESH_LANE_ENABLED: "1",
        EXACT_REVIEW_PUBLICATION_FRESH_LANE_MAX_ITEMS: "1",
        EXACT_REVIEW_PUBLICATION_FRESH_LANE_MAX_AGE_MS: "60000",
      },
    );
    for (let itemNumber = 30; itemNumber <= 37; itemNumber += 1) {
      await queue.fetch(
        publicationRequest(`continuous-old-${itemNumber}`, itemNumber, String(7400 + itemNumber)),
      );
      now += 1;
    }
    now += 60_001;
    await queue.fetch(publicationRequest("continuous-fresh-90", 90, "7490"));
    now += 1;
    await queue.fetch(publicationRequest("continuous-fresh-91", 91, "7491"));

    const claim = async (id: string) =>
      (
        await queue.fetch(
          batchRequest("/publication-batches/claim", {
            claim_id: id,
            lease_owner: id,
            max_items: 50,
          }),
        )
      ).json();
    const first = await claim("continuous-claim-1");
    assert.deepEqual(
      new Set(first.batch.items.map((item: { item_key: string }) => item.item_key)),
      new Set([
        "openclaw/openclaw#30@publish:7430:1",
        "openclaw/openclaw#31@publish:7431:1",
        "openclaw/openclaw#32@publish:7432:1",
        "openclaw/openclaw#90@publish:7490:1",
      ]),
    );

    now += 1;
    await queue.fetch(publicationRequest("continuous-fresh-92", 92, "7492"));
    const second = await claim("continuous-claim-2");
    assert.deepEqual(
      new Set(second.batch.items.map((item: { item_key: string }) => item.item_key)),
      new Set([
        "openclaw/openclaw#33@publish:7433:1",
        "openclaw/openclaw#34@publish:7434:1",
        "openclaw/openclaw#35@publish:7435:1",
        "openclaw/openclaw#91@publish:7491:1",
      ]),
    );
  } finally {
    Date.now = originalNow;
  }
});

test("fresh publication admission flag restores strict historical FIFO", async () => {
  const originalNow = Date.now;
  let now = 3_000_000;
  Date.now = () => now;
  try {
    const queue = new ExactReviewQueue(
      { storage: new TestStorage() },
      {
        EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
        EXACT_REVIEW_PUBLICATION_BATCH_SIZE: "2",
        EXACT_REVIEW_PUBLICATION_FRESH_LANE_ENABLED: "0",
        EXACT_REVIEW_PUBLICATION_FRESH_LANE_MAX_ITEMS: "1",
        EXACT_REVIEW_PUBLICATION_FRESH_LANE_MAX_AGE_MS: "60000",
      },
    );
    await queue.fetch(publicationRequest("rollback-old-1", 20, "7201"));
    now += 1;
    await queue.fetch(publicationRequest("rollback-old-2", 21, "7202"));
    now += 60_001;
    await queue.fetch(publicationRequest("rollback-fresh", 99, "7299"));

    const claim = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-fresh-disabled",
          lease_owner: "worker-1",
          max_items: 50,
        }),
      )
    ).json();
    assert.deepEqual(
      claim.batch.items.map((item: { item_key: string }) => item.item_key),
      ["openclaw/openclaw#20@publish:7201:1", "openclaw/openclaw#21@publish:7202:1"],
    );
  } finally {
    Date.now = originalNow;
  }
});

test("batch fetch supersedes a claimed publication when the source head advances", async () => {
  const originalNow = Date.now;
  Date.now = () => 4_000_000;
  try {
    const queue = new ExactReviewQueue(
      { storage: new TestStorage() },
      {
        EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
        EXACT_REVIEW_PUBLICATION_BATCH_SIZE: "2",
      },
    );
    await queue.fetch(publicationRequest("source-head-1", 200, "7301", "openclaw/openclaw", 1));
    const claim = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-source-head-1",
          lease_owner: "worker-1",
          max_items: 1,
        }),
      )
    ).json();
    await queue.fetch(publicationRequest("source-head-2", 200, "7302", "openclaw/openclaw", 2));

    const fetched = await (
      await queue.fetch(
        batchRequest("/publication-batches/fetch", {
          batch_id: claim.batch.batch_id,
          lease_owner: "worker-1",
        }),
      )
    ).json();
    assert.equal(fetched.superseded, 1);
    assert.equal(fetched.items.length, 0);
    assert.equal(fetched.batch.items[0].terminal_outcome, "superseded");

    const afterFetch = await (await queue.fetch(new Request("https://queue/stats"))).json();
    assert.equal(afterFetch.lanes.publication.pending, 1);
    assert.equal(afterFetch.lanes.publication.completed_total, 1);
    assert.equal(afterFetch.lanes.publication.superseded_total, 1);

    const next = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-source-head-2",
          lease_owner: "worker-2",
          max_items: 1,
        }),
      )
    ).json();
    assert.equal(next.batch.items[0].revision, 1);
    assert.equal(next.batch.items[0].item_key, "openclaw/openclaw#200@publish:7302:1");
  } finally {
    Date.now = originalNow;
  }
});

test("idempotent batch claims retain the cap recorded by the original lease", async () => {
  const originalNow = Date.now;
  Date.now = () => 1_900_000;
  try {
    const storage = new TestStorage();
    const initialQueue = new ExactReviewQueue(
      { storage },
      {
        EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
        EXACT_REVIEW_PUBLICATION_BATCH_SIZE: "2",
      },
    );
    await initialQueue.fetch(publicationRequest("stable-cap-1", 140, "1040"));
    await initialQueue.fetch(publicationRequest("stable-cap-2", 141, "1041"));
    const requestBody = {
      claim_id: "claim-stable-cap",
      lease_owner: "worker-1",
      max_items: 4,
    };
    const initial = await (
      await initialQueue.fetch(batchRequest("/publication-batches/claim", requestBody))
    ).json();
    assert.equal(initial.configured_batch_size, 2);

    for (const configuredSize of [1, 4]) {
      const retryQueue = new ExactReviewQueue(
        { storage },
        {
          EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
          EXACT_REVIEW_PUBLICATION_BATCH_SIZE: String(configuredSize),
        },
      );
      const retried = await (
        await retryQueue.fetch(batchRequest("/publication-batches/claim", requestBody))
      ).json();
      assert.equal(retried.configured_batch_size, 2);
      assert.equal(retried.batch.configured_batch_size, 2);
      assert.equal(retried.batch.items.length, 2);
    }
  } finally {
    Date.now = originalNow;
  }
});

test("queue completion atomically removes only the owned publication revision", async () => {
  const originalNow = Date.now;
  Date.now = () => 2_000_000;
  try {
    const queue = new ExactReviewQueue(
      { storage: new TestStorage() },
      { EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1" },
    );
    const enqueued = await queue.fetch(publicationRequest("delivery-complete", 103, "1003"));
    assert.equal(enqueued.status, 202, JSON.stringify(await enqueued.clone().json()));
    const beforeClaim = await (await queue.fetch(new Request("https://queue/stats"))).json();
    assert.equal(beforeClaim.lanes.publication.pending, 1, JSON.stringify(beforeClaim));
    const claim = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-complete",
          lease_owner: "worker-1",
          max_items: 1,
        }),
      )
    ).json();
    assert.equal(claim.claimed, true, JSON.stringify(claim));
    assert.equal(claim.batch_wait_ms, 0);
    const member = claim.batch.items[0];
    const progress = {
      schema_version: 1,
      operation_id: "batch:claim-complete",
      mode: "batch",
      phase: "holding",
      sequence: 2,
      observed_at: new Date(1_999_500).toISOString(),
      configured_batch_size: 1,
      actual_batch_size: 1,
    };
    const heartbeat = await queue.fetch(
      batchRequest("/publication-batches/heartbeat", {
        batch_id: claim.batch.batch_id,
        lease_owner: "worker-1",
        items: [member],
        state_writer_progress: progress,
      }),
    );
    assert.equal(heartbeat.status, 200, JSON.stringify(await heartbeat.clone().json()));
    const stateWriter = {
      schema_version: 1,
      operation_id: "batch:claim-complete",
      mode: "batch",
      started_at: new Date(1_999_000).toISOString(),
      finished_at: new Date(2_000_000).toISOString(),
      wait_ms: 500,
      acquire_attempts: 2,
      acquired: true,
      hold_ms: 500,
      renewals: 0,
      released: true,
      git_duration_ms: 1_000,
      git_processes: 8,
      commit_count: 1,
      materialized_items: 1,
      configured_batch_size: 1,
      actual_batch_size: 1,
      batch_wait_ms: 0,
      outcome: "materialized",
    };
    const completion = await (
      await queue.fetch(
        batchRequest("/publication-batches/complete", {
          batch_id: claim.batch.batch_id,
          lease_owner: "worker-1",
          state_commit_sha: "b".repeat(40),
          state_writer: stateWriter,
          items: [
            {
              item_key: member.item_key,
              revision: member.revision,
              claim_generation: member.claim_generation,
              terminal_outcome: "published",
            },
          ],
        }),
      )
    ).json();
    assert.equal(completion.accepted, 1);
    assert.equal(completion.batch.state, "completed");

    const retriedCompletion = await (
      await queue.fetch(
        batchRequest("/publication-batches/complete", {
          batch_id: claim.batch.batch_id,
          lease_owner: "worker-1",
          state_commit_sha: "b".repeat(40),
          items: [
            {
              item_key: member.item_key,
              revision: member.revision,
              claim_generation: member.claim_generation,
              terminal_outcome: "retryable_failure",
              reason_code: "workflow_cancelled",
            },
          ],
        }),
      )
    ).json();
    assert.equal(retriedCompletion.accepted, 0);
    assert.equal(retriedCompletion.batch.state, "completed");

    const stats = await (await queue.fetch(new Request("https://queue/stats"))).json();
    assert.equal(stats.lanes.publication.pending, 0);
    assert.equal(stats.lanes.publication.published_total, 1);
    assert.equal(stats.lanes.publication.batches.completed, 1);
    assert.equal(stats.state_writer.mode, "batch");
    assert.equal(stats.state_writer.collection.status, "fresh");
    assert.equal(stats.state_writer.last_15_minutes.state_commits, 1);
    assert.equal(stats.state_writer.last_15_minutes.materialized_items, 1);
  } finally {
    Date.now = originalNow;
  }
});

test("direct fenced cleanup treats an expired batch as an idempotent no-op", async () => {
  const originalNow = Date.now;
  let now = 2_500_000;
  Date.now = () => now;
  try {
    const queue = new ExactReviewQueue(
      { storage: new TestStorage() },
      {
        EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
        EXACT_REVIEW_PUBLICATION_BATCH_LEASE_MS: "60000",
      },
    );
    await queue.fetch(publicationRequest("delivery-expired-cleanup", 126, "1026"));
    const claim = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-expired-cleanup",
          lease_owner: "worker-1",
          max_items: 1,
        }),
      )
    ).json();
    const member = claim.batch.items[0];

    now += 60_001;
    const cleanup = await queue.fetch(
      batchRequest("/publication-batches/complete", {
        batch_id: claim.batch.batch_id,
        lease_owner: "worker-1",
        items: [
          {
            item_key: member.item_key,
            revision: member.revision,
            claim_generation: member.claim_generation,
            terminal_outcome: "retryable_failure",
            reason_code: "workflow_cancelled",
          },
        ],
      }),
    );
    assert.equal(cleanup.status, 200);
    assert.deepEqual(await cleanup.json(), {
      ok: true,
      accepted: 0,
      skipped: 1,
      batch: {
        ...claim.batch,
        state: "expired",
        completed_at: new Date(now).toISOString(),
        items: [{ ...member, terminal_outcome: "lease_expired" }],
      },
    });
  } finally {
    Date.now = originalNow;
  }
});

test("retryable batch completion releases ownership and preserves queue retry policy", async () => {
  const originalNow = Date.now;
  let now = 2_000_000;
  Date.now = () => now;
  try {
    const storage = new TestStorage();
    const queue = new ExactReviewQueue(
      { storage },
      { EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1" },
    );
    await queue.fetch(publicationRequest("delivery-retryable", 123, "1023"));
    const claim = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-retryable",
          lease_owner: "worker-1",
          max_items: 1,
          runner_run_id: "9123",
          runner_run_attempt: 1,
          runner_started_at: "2026-07-30T12:00:00.000Z",
        }),
      )
    ).json();
    const member = claim.batch.items[0];
    const invalidCompletion = await queue.fetch(
      batchRequest("/publication-batches/complete", {
        batch_id: claim.batch.batch_id,
        lease_owner: "worker-1",
        items: [
          {
            item_key: member.item_key,
            revision: member.revision,
            claim_generation: member.claim_generation,
            terminal_outcome: "retryable_failure",
            reason_code: "publication_applied",
          },
        ],
      }),
    );
    assert.equal(invalidCompletion.status, 400);
    const completion = await (
      await queue.fetch(
        batchRequest("/publication-batches/complete", {
          batch_id: claim.batch.batch_id,
          lease_owner: "worker-1",
          failure_fingerprint: "state-contention-proof",
          items: [
            {
              item_key: member.item_key,
              revision: member.revision,
              claim_generation: member.claim_generation,
              terminal_outcome: "retryable_failure",
              reason_code: "state_contention",
              pool_class: "repository_actions",
              error_fingerprint: "state-contention-proof",
            },
          ],
        }),
      )
    ).json();
    assert.equal(completion.accepted, 1, JSON.stringify(completion));
    assert.equal(completion.batch.state, "completed");
    assert.equal(completion.batch.items[0].terminal_outcome, "lease_expired");
    const lifecycleRow = Array.from(
      storage.sql.exec(
        `SELECT projection_json FROM ${EXACT_REVIEW_LIFECYCLE_PROJECTION_TABLE}
          WHERE canonical_target_key = ? AND fence_key = ? AND revision = ?`,
        "openclaw/openclaw#123",
        member.item_key,
        member.revision,
      ),
    )[0] as { projection_json: string };
    assert.equal(JSON.parse(lifecycleRow.projection_json).terminalDisposition?.kind, "requeue");

    const stats = await (await queue.fetch(new Request("https://queue/stats"))).json();
    assert.equal(stats.lanes.publication.pending, 1);
    assert.equal(stats.lanes.publication.completed_total, 0);
    assert.equal(stats.lanes.publication.retried_total, 1);
    assert.equal(stats.lanes.publication.batches.leased, 0);
    assert.deepEqual(stats.lanes.publication.flow.last_15_minutes.causes.rows, [
      {
        transition: "retried",
        stage: "state_commit",
        completion_kind: "retryable_failure",
        reason_code: "state_contention",
        revision_relation: "same_revision",
        pool_class: "repository_actions",
        recovery_cause: "state_retry",
        backoff_reason: "publication_retry",
        attempt_bucket: "1",
        count: 1,
      },
    ]);

    now += 10 * 60_000;
    const replacement = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-after-retryable",
          lease_owner: "worker-2",
          max_items: 1,
        }),
      )
    ).json();
    assert.equal(replacement.claimed, true, JSON.stringify(replacement));
    assert.equal(replacement.batch.items[0].item_key, member.item_key);
    assert.notEqual(replacement.batch.items[0].claim_generation, member.claim_generation);

    const stale = await (
      await queue.fetch(
        batchRequest("/publication-batches/complete", {
          batch_id: claim.batch.batch_id,
          lease_owner: "worker-1",
          items: [
            {
              item_key: member.item_key,
              revision: member.revision,
              claim_generation: member.claim_generation,
              terminal_outcome: "retryable_failure",
              reason_code: "state_contention",
            },
          ],
        }),
      )
    ).json();
    assert.equal(stale.accepted, 0);
    const fetchedReplacement = await (
      await queue.fetch(
        batchRequest("/publication-batches/fetch", {
          batch_id: replacement.batch.batch_id,
          lease_owner: "worker-2",
        }),
      )
    ).json();
    assert.equal(fetchedReplacement.items.length, 1);

    const published = await (
      await queue.fetch(
        batchRequest("/publication-batches/complete", {
          batch_id: replacement.batch.batch_id,
          lease_owner: "worker-2",
          items: [
            {
              item_key: replacement.batch.items[0].item_key,
              revision: replacement.batch.items[0].revision,
              claim_generation: replacement.batch.items[0].claim_generation,
              terminal_outcome: "published",
            },
          ],
        }),
      )
    ).json();
    assert.equal(published.accepted, 1, JSON.stringify(published));

    const completedStats = await (await queue.fetch(new Request("https://queue/stats"))).json();
    assert.equal(completedStats.lanes.publication.pending, 0);
    assert.equal(completedStats.lanes.publication.published_total, 1);
    const publishedCause = completedStats.lanes.publication.flow.last_15_minutes.causes.rows.find(
      (row: { transition: string }) => row.transition === "published",
    );
    assert.equal(publishedCause?.attempt_bucket, "1");
  } finally {
    Date.now = originalNow;
  }
});

test("batch completion refreshes deterministic invalid artifacts", async () => {
  const storage = new TestStorage();
  const queue = new ExactReviewQueue(
    { storage },
    {
      EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
      EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0",
    },
  );
  await queue.fetch(publicationRequest("delivery-invalid-artifact", 127, "1027"));
  const claim = await (
    await queue.fetch(
      batchRequest("/publication-batches/claim", {
        claim_id: "claim-invalid-artifact",
        lease_owner: "worker-1",
        max_items: 1,
      }),
    )
  ).json();
  const member = claim.batch.items[0];

  const completion = await (
    await queue.fetch(
      batchRequest("/publication-batches/complete", {
        batch_id: claim.batch.batch_id,
        lease_owner: "worker-1",
        items: [
          {
            item_key: member.item_key,
            revision: member.revision,
            claim_generation: member.claim_generation,
            terminal_outcome: "refresh_required",
            reason_code: "invalid_artifact",
          },
        ],
      }),
    )
  ).json();

  assert.equal(completion.accepted, 1, JSON.stringify(completion));
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { decision: { sourceAction: string; publication?: unknown } }>;
  };
  assert.equal(state.items[member.item_key], undefined);
  assert.equal(
    state.items["openclaw/openclaw#127"].decision.sourceAction,
    "artifact_retention_recovery",
  );
  assert.equal(state.items["openclaw/openclaw#127"].decision.publication, undefined);
});

test("credential circuits persist, preserve healthy owners, and defer unattempted members without retry charge", async () => {
  const originalNow = Date.now;
  let now = Date.parse("2026-08-10T14:00:00.000Z");
  Date.now = () => now;
  try {
    const storage = new TestStorage();
    let queue = new ExactReviewQueue(
      { storage },
      { EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1" },
    );
    for (let index = 0; index < 52; index += 1) {
      await queue.fetch(
        publicationRequest(`owner-a-${index}`, 201 + index, String(1201 + index), "aaa/repo"),
      );
    }
    await queue.fetch(publicationRequest("owner-b", 300, "1300", "bbb/repo"));
    const claim = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-owner-a",
          lease_owner: "worker-a",
          max_items: 1,
        }),
      )
    ).json();
    const member = claim.batch.items[0];
    assert.match(member.item_key, /^aaa\/repo#/);
    const malformedUnattempted = await queue.fetch(
      batchRequest("/publication-batches/complete", {
        batch_id: claim.batch.batch_id,
        lease_owner: "worker-a",
        items: [
          {
            item_key: member.item_key,
            revision: member.revision,
            claim_generation: member.claim_generation,
            terminal_outcome: "retryable_failure",
            reason_code: "github_rate_limit",
            attempted: false,
          },
        ],
      }),
    );
    assert.equal(malformedUnattempted.status, 400);
    assert.deepEqual(await malformedUnattempted.json(), { error: "invalid_batch_completions" });
    const longerReset = now + 120_000;
    const completion = await (
      await queue.fetch(
        batchRequest("/publication-batches/complete", {
          batch_id: claim.batch.batch_id,
          lease_owner: "worker-a",
          github_rate_limit_observations: [
            {
              scope: "target_app",
              target_owner: "aaa",
              observed_at: new Date(now).toISOString(),
              retry_at: new Date(longerReset).toISOString(),
              provenance: "rate_limit_status",
              authoritative: true,
            },
            {
              scope: "target_app",
              target_owner: "aaa",
              observed_at: new Date(now + 1).toISOString(),
              retry_at: new Date(now + 60_000).toISOString(),
              provenance: "fallback",
              authoritative: false,
            },
          ],
          github_request_metrics: [
            {
              scope: "target_app",
              category: "item_metadata",
              mode: "read",
              outcome: "throttle",
              repeat_revision: false,
              count: 1,
            },
          ],
          items: [
            {
              item_key: member.item_key,
              revision: member.revision,
              claim_generation: member.claim_generation,
              terminal_outcome: "retryable_failure",
              reason_code: "github_rate_limit",
              pool_class: "target_app",
              retry_at: new Date(longerReset).toISOString(),
              attempted: false,
            },
          ],
        }),
      )
    ).json();
    assert.equal(completion.accepted, 1, JSON.stringify(completion));

    let stats = await (await queue.fetch(new Request("https://queue/stats"))).json();
    assert.equal(stats.lanes.publication.retried_total, 0);
    assert.equal(stats.lanes.publication.credential_circuits.length, 1);
    const { recovery_until: recoveryUntil, ...credentialCircuit } =
      stats.lanes.publication.credential_circuits[0];
    assert.deepEqual(credentialCircuit, {
      pool: "target_app:aaa",
      scope: "target_app",
      target_owner: "aaa",
      observed_at: new Date(now).toISOString(),
      blocked_until: new Date(longerReset).toISOString(),
      reset_source: "rate_limit_status",
      authoritative: true,
      active: true,
      affected_pending: 52,
    });
    assert.ok(Date.parse(recoveryUntil) > longerReset);
    assert.ok(Date.parse(recoveryUntil) <= longerReset + 30_000);
    assert.equal(
      stats.lanes.publication.github_request_metrics.counters[
        "target_app:item_metadata:read:throttle:first"
      ],
      1,
    );
    assert.equal(stats.lanes.publication.capacity_control.last_failure_kind, "github_rate_limit");
    assert.deepEqual(stats.lanes.publication.flow.last_15_minutes.causes.rows, [
      {
        transition: "backoff",
        stage: "publication_apply",
        completion_kind: "retryable_failure",
        reason_code: "github_rate_limit",
        revision_relation: "same_revision",
        pool_class: "target_app",
        recovery_cause: "credential_circuit",
        backoff_reason: "publication_retry",
        attempt_bucket: "0",
        count: 1,
      },
    ]);

    const lateReset = now + 180_000;
    const lateTelemetry = {
      batch_id: claim.batch.batch_id,
      lease_owner: "worker-a",
      github_telemetry_id: "a".repeat(64),
      github_rate_limit_observations: [
        {
          scope: "target_app",
          target_owner: "aaa",
          observed_at: new Date(now + 2).toISOString(),
          retry_at: new Date(lateReset).toISOString(),
          provenance: "retry_after",
          authoritative: true,
        },
      ],
      github_request_metrics: [
        {
          scope: "target_app",
          category: "workflow_dispatch",
          mode: "mutation_or_private_read",
          outcome: "throttle",
          repeat_revision: true,
          count: 1,
        },
      ],
      items: [],
    };
    storage.failNextSqlMatching(/UPDATE exact_review_queue_meta/);
    await assert.rejects(
      queue.fetch(batchRequest("/publication-batches/complete", lateTelemetry)),
      /injected telemetry state write failure/,
    );
    stats = await (await queue.fetch(new Request("https://queue/stats"))).json();
    assert.equal(
      stats.lanes.publication.github_request_metrics.counters[
        "target_app:workflow_dispatch:mutation_or_private_read:throttle:repeat"
      ],
      undefined,
    );
    assert.equal(
      stats.lanes.publication.credential_circuits[0].blocked_until,
      new Date(longerReset).toISOString(),
    );
    const late = await (
      await queue.fetch(batchRequest("/publication-batches/complete", lateTelemetry))
    ).json();
    assert.equal(late.accepted, 0);
    assert.equal(late.telemetry_accepted, true);
    const duplicate = await (
      await queue.fetch(batchRequest("/publication-batches/complete", lateTelemetry))
    ).json();
    assert.equal(duplicate.telemetry_accepted, true);
    stats = await (await queue.fetch(new Request("https://queue/stats"))).json();
    assert.equal(
      stats.lanes.publication.credential_circuits[0].blocked_until,
      new Date(lateReset).toISOString(),
    );
    assert.equal(
      stats.lanes.publication.github_request_metrics.counters[
        "target_app:workflow_dispatch:mutation_or_private_read:throttle:repeat"
      ],
      1,
    );
    assert.equal(stats.lanes.publication.capacity_control.ceiling, 12);
    queue = new ExactReviewQueue({ storage }, { EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1" });
    const healthyOwner = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-owner-b",
          lease_owner: "worker-b",
          max_items: 50,
        }),
      )
    ).json();
    assert.equal(healthyOwner.claimed, true, JSON.stringify(healthyOwner));
    assert.match(healthyOwner.batch.items[0].item_key, /^bbb\/repo#/);
    const replacementLeaseDuplicate = await (
      await queue.fetch(
        batchRequest("/publication-batches/complete", {
          ...lateTelemetry,
          batch_id: healthyOwner.batch.batch_id,
          lease_owner: "worker-b",
        }),
      )
    ).json();
    assert.equal(replacementLeaseDuplicate.telemetry_accepted, true);
    stats = await (await queue.fetch(new Request("https://queue/stats"))).json();
    assert.equal(
      stats.lanes.publication.github_request_metrics.counters[
        "target_app:workflow_dispatch:mutation_or_private_read:throttle:repeat"
      ],
      1,
    );
    const independentTelemetry = await (
      await queue.fetch(
        batchRequest("/publication-batches/complete", {
          ...lateTelemetry,
          batch_id: healthyOwner.batch.batch_id,
          lease_owner: "worker-b",
          github_telemetry_id: "b".repeat(64),
        }),
      )
    ).json();
    assert.equal(independentTelemetry.telemetry_accepted, true);
    stats = await (await queue.fetch(new Request("https://queue/stats"))).json();
    assert.equal(
      stats.lanes.publication.github_request_metrics.counters[
        "target_app:workflow_dispatch:mutation_or_private_read:throttle:repeat"
      ],
      2,
    );
    assert.equal(stats.lanes.publication.capacity_control.ceiling, 6);
    const retainedReceiptPayloads: Record<string, unknown>[] = [];
    for (let index = 0; index < 201; index += 1) {
      const payload = {
        batch_id: healthyOwner.batch.batch_id,
        lease_owner: "worker-b",
        github_telemetry_id: index.toString(16).padStart(64, "0"),
        github_request_metrics: lateTelemetry.github_request_metrics,
        items: [],
      };
      retainedReceiptPayloads.push(payload);
      const recorded = await (
        await queue.fetch(batchRequest("/publication-batches/complete", payload))
      ).json();
      assert.equal(recorded.telemetry_accepted, true);
    }
    const delayedDuplicate = await (
      await queue.fetch(batchRequest("/publication-batches/complete", retainedReceiptPayloads[0]))
    ).json();
    assert.equal(delayedDuplicate.telemetry_accepted, true);
    stats = await (await queue.fetch(new Request("https://queue/stats"))).json();
    assert.equal(
      stats.lanes.publication.github_request_metrics.counters[
        "target_app:workflow_dispatch:mutation_or_private_read:throttle:repeat"
      ],
      203,
    );

    const receiptFailureReset = lateReset + 60_000;
    const receiptFailureTelemetry = {
      batch_id: healthyOwner.batch.batch_id,
      lease_owner: "worker-b",
      github_telemetry_id: "c".repeat(64),
      github_rate_limit_observations: [
        {
          scope: "target_app",
          target_owner: "aaa",
          observed_at: new Date(now + 3).toISOString(),
          retry_at: new Date(receiptFailureReset).toISOString(),
          provenance: "retry_after",
          authoritative: true,
        },
      ],
      items: [],
    };
    storage.failNextSqlMatching(/INSERT INTO exact_review_github_telemetry_receipts/);
    await assert.rejects(
      queue.fetch(batchRequest("/publication-batches/complete", receiptFailureTelemetry)),
      /injected telemetry state write failure/,
    );
    stats = await (await queue.fetch(new Request("https://queue/stats"))).json();
    assert.equal(stats.lanes.publication.capacity_control.ceiling, 6);
    assert.equal(
      stats.lanes.publication.credential_circuits[0].blocked_until,
      new Date(lateReset).toISOString(),
    );
    const receiptReplay = await (
      await queue.fetch(batchRequest("/publication-batches/complete", receiptFailureTelemetry))
    ).json();
    assert.equal(receiptReplay.telemetry_accepted, true);
    stats = await (await queue.fetch(new Request("https://queue/stats"))).json();
    assert.equal(stats.lanes.publication.capacity_control.ceiling, 4);
    assert.equal(
      stats.lanes.publication.credential_circuits[0].blocked_until,
      new Date(receiptFailureReset).toISOString(),
    );

    const healthyMember = healthyOwner.batch.items[0];
    const healthyCompletion = await queue.fetch(
      batchRequest("/publication-batches/complete", {
        batch_id: healthyOwner.batch.batch_id,
        lease_owner: "worker-b",
        items: [
          {
            item_key: healthyMember.item_key,
            revision: healthyMember.revision,
            claim_generation: healthyMember.claim_generation,
            terminal_outcome: "superseded",
          },
        ],
      }),
    );
    assert.equal(
      healthyCompletion.status,
      200,
      JSON.stringify(await healthyCompletion.clone().json()),
    );

    now = receiptFailureReset + 16 * 60_000;
    stats = await (await queue.fetch(new Request("https://queue/stats"))).json();
    assert.equal(stats.lanes.publication.credential_circuits[0].active, false);
    const recoveredOwner = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-owner-a-recovered",
          lease_owner: "worker-c",
          max_items: 50,
        }),
      )
    ).json();
    assert.equal(recoveredOwner.claimed, true, JSON.stringify(recoveredOwner));
    assert.match(recoveredOwner.batch.items[0].item_key, /^aaa\/repo#/);
  } finally {
    Date.now = originalNow;
  }
});

test("repository Actions circuit blocks every publication batch until reset", async () => {
  const originalNow = Date.now;
  let now = Date.parse("2026-08-10T14:00:00.000Z");
  Date.now = () => now;
  try {
    const queue = new ExactReviewQueue(
      { storage: new TestStorage() },
      { EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1" },
    );
    await queue.fetch(publicationRequest("actions-a", 211, "1211", "aaa/repo"));
    await queue.fetch(publicationRequest("actions-b", 212, "1212", "bbb/repo"));
    const claim = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-actions-a",
          lease_owner: "worker-a",
          max_items: 1,
        }),
      )
    ).json();
    const member = claim.batch.items[0];
    const resetAt = now + 90_000;
    const completed = await queue.fetch(
      batchRequest("/publication-batches/complete", {
        batch_id: claim.batch.batch_id,
        lease_owner: "worker-a",
        github_rate_limit_observations: [
          {
            scope: "repository_actions",
            observed_at: new Date(now).toISOString(),
            retry_at: new Date(resetAt).toISOString(),
            provenance: "rate_limit_status",
            authoritative: true,
          },
        ],
        items: [
          {
            item_key: member.item_key,
            revision: member.revision,
            claim_generation: member.claim_generation,
            terminal_outcome: "retryable_failure",
            reason_code: "github_rate_limit",
            retry_at: new Date(resetAt).toISOString(),
            attempted: false,
          },
        ],
      }),
    );
    assert.equal(completed.status, 200, JSON.stringify(await completed.clone().json()));
    const blocked = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-actions-blocked",
          lease_owner: "worker-b",
          max_items: 2,
        }),
      )
    ).json();
    assert.equal(blocked.claimed, false, JSON.stringify(blocked));
    const stats = await (await queue.fetch(new Request("https://queue/stats"))).json();
    assert.equal(
      stats.lanes.publication.credential_circuits[0].pool,
      "actions:openclaw/clawsweeper",
    );
    assert.equal(stats.lanes.publication.credential_circuits[0].affected_pending, 2);
    assert.ok(Date.parse(stats.lanes.publication.credential_circuits[0].recovery_until) > resetAt);

    now = resetAt;
    const resetBoundary = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-actions-reset-boundary",
          lease_owner: "worker-boundary",
          max_items: 2,
        }),
      )
    ).json();
    assert.equal(resetBoundary.claimed, false, JSON.stringify(resetBoundary));

    now = resetAt + 31_000;
    const recovered = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-actions-recovered",
          lease_owner: "worker-c",
          max_items: 2,
        }),
      )
    ).json();
    assert.equal(recovered.claimed, true, JSON.stringify(recovered));
  } finally {
    Date.now = originalNow;
  }
});

test("batch failure completion requeues a newer revision owned by the same lease", async () => {
  const originalNow = Date.now;
  let now = 2_500_000;
  Date.now = () => now;
  try {
    const queue = new ExactReviewQueue(
      { storage: new TestStorage() },
      { EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1" },
    );
    await queue.fetch(publicationRequest("delivery-owned-revision-1", 127, "1027"));
    const claim = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-owned-revision-1",
          lease_owner: "worker-1",
          max_items: 1,
        }),
      )
    ).json();
    const member = claim.batch.items[0];

    await queue.fetch(publicationRequest("delivery-owned-revision-2", 127, "1027"));
    const completion = await (
      await queue.fetch(
        batchRequest("/publication-batches/complete", {
          batch_id: claim.batch.batch_id,
          lease_owner: "worker-1",
          items: [
            {
              item_key: member.item_key,
              revision: member.revision,
              claim_generation: member.claim_generation,
              terminal_outcome: "retryable_failure",
              reason_code: "workflow_cancelled",
            },
          ],
        }),
      )
    ).json();
    assert.equal(completion.accepted, 1, JSON.stringify(completion));

    const stats = await (await queue.fetch(new Request("https://queue/stats"))).json();
    assert.equal(stats.lanes.publication.pending, 1);
    assert.equal(stats.lanes.publication.retried_total, 0);
    assert.equal(stats.lanes.publication.batches.leased, 0);

    now += 1;
    const replacement = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-owned-revision-2",
          lease_owner: "worker-2",
          max_items: 1,
        }),
      )
    ).json();
    assert.equal(replacement.claimed, true, JSON.stringify(replacement));
    assert.equal(replacement.batch.items[0].revision, 2);
    assert.notEqual(replacement.batch.items[0].claim_generation, member.claim_generation);
  } finally {
    Date.now = originalNow;
  }
});

test("batch published completion preserves a newer revision owned by the same lease", async () => {
  const originalNow = Date.now;
  let now = 2_750_000;
  Date.now = () => now;
  try {
    const queue = new ExactReviewQueue(
      { storage: new TestStorage() },
      { EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1" },
    );
    await queue.fetch(publicationRequest("delivery-published-revision-1", 128, "1028"));
    const claim = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-published-revision-1",
          lease_owner: "worker-1",
          max_items: 1,
        }),
      )
    ).json();
    const member = claim.batch.items[0];

    await queue.fetch(publicationRequest("delivery-published-revision-2", 128, "1028"));
    const completion = await (
      await queue.fetch(
        batchRequest("/publication-batches/complete", {
          batch_id: claim.batch.batch_id,
          lease_owner: "worker-1",
          state_commit_sha: "d".repeat(40),
          items: [
            {
              item_key: member.item_key,
              revision: member.revision,
              claim_generation: member.claim_generation,
              terminal_outcome: "published",
            },
          ],
        }),
      )
    ).json();
    assert.equal(completion.accepted, 1, JSON.stringify(completion));

    const stats = await (await queue.fetch(new Request("https://queue/stats"))).json();
    assert.equal(stats.lanes.publication.pending, 1);
    assert.equal(stats.lanes.publication.published_total, 1);
    assert.equal(stats.lanes.publication.batches.leased, 0);
    assert.equal(
      stats.lanes.publication.flow.last_15_minutes.causes.reconciliation.published.complete,
      true,
    );
    assert.deepEqual(
      stats.lanes.publication.flow.last_15_minutes.causes.rows.map((row) => ({
        transition: row.transition,
        reason_code: row.reason_code,
        revision_relation: row.revision_relation,
        recovery_cause: row.recovery_cause,
      })),
      [
        {
          transition: "backoff",
          reason_code: "publication_applied",
          revision_relation: "newer_local_revision",
          recovery_cause: "newer_revision",
        },
        {
          transition: "published",
          reason_code: "publication_applied",
          revision_relation: "newer_local_revision",
          recovery_cause: "newer_revision",
        },
      ],
    );

    now += 1;
    const replacement = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-published-revision-2",
          lease_owner: "worker-2",
          max_items: 1,
        }),
      )
    ).json();
    assert.equal(replacement.claimed, true, JSON.stringify(replacement));
    assert.equal(replacement.batch.items[0].revision, 2);
    assert.notEqual(replacement.batch.items[0].claim_generation, member.claim_generation);
  } finally {
    Date.now = originalNow;
  }
});

test("partial batch completion publishes healthy members and releases retryable members", async () => {
  const originalNow = Date.now;
  Date.now = () => 3_000_000;
  try {
    const queue = new ExactReviewQueue(
      { storage: new TestStorage() },
      { EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1" },
    );
    await queue.fetch(publicationRequest("delivery-partial-published", 124, "1024"));
    await queue.fetch(publicationRequest("delivery-partial-retryable", 125, "1025"));
    const claim = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-partial",
          lease_owner: "worker-1",
          max_items: 2,
        }),
      )
    ).json();
    const [published, retryable] = claim.batch.items;
    const completion = await (
      await queue.fetch(
        batchRequest("/publication-batches/complete", {
          batch_id: claim.batch.batch_id,
          lease_owner: "worker-1",
          state_commit_sha: "c".repeat(40),
          items: [
            {
              item_key: published.item_key,
              revision: published.revision,
              claim_generation: published.claim_generation,
              terminal_outcome: "published",
            },
            {
              item_key: retryable.item_key,
              revision: retryable.revision,
              claim_generation: retryable.claim_generation,
              terminal_outcome: "retryable_failure",
              reason_code: "artifact_unavailable",
            },
          ],
        }),
      )
    ).json();
    assert.equal(completion.accepted, 2, JSON.stringify(completion));
    assert.equal(completion.batch.state, "completed");

    const stats = await (await queue.fetch(new Request("https://queue/stats"))).json();
    assert.equal(stats.lanes.publication.pending, 1);
    assert.equal(stats.lanes.publication.published_total, 1);
    assert.equal(stats.lanes.publication.retried_total, 1);
    assert.equal(stats.lanes.publication.batches.leased, 0);
  } finally {
    Date.now = originalNow;
  }
});

test("batch completion schedules the remaining partial batch at its departure deadline", async () => {
  const originalNow = Date.now;
  Date.now = () => 6_000_000;
  try {
    const storage = new TestStorage();
    const queue = new ExactReviewQueue(
      { storage },
      {
        EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
        EXACT_REVIEW_PUBLICATION_BATCH_LEASE_MS: "60000",
      },
    );
    await queue.fetch(publicationRequest("delivery-completing", 108, "1008"));
    await queue.fetch(publicationRequest("delivery-waiting", 109, "1009"));
    const claim = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-wakes-legacy",
          lease_owner: "worker-1",
          max_items: 1,
        }),
      )
    ).json();
    await queue.alarm();
    assert.equal(storage.scheduledAlarm(), 6_060_000);

    const member = claim.batch.items[0];
    const completion = await queue.fetch(
      batchRequest("/publication-batches/complete", {
        batch_id: claim.batch.batch_id,
        lease_owner: "worker-1",
        items: [
          {
            item_key: member.item_key,
            revision: member.revision,
            claim_generation: member.claim_generation,
            terminal_outcome: "published",
          },
        ],
      }),
    );
    assert.equal(completion.status, 200);
    assert.equal(storage.scheduledAlarm(), 6_060_000);
  } finally {
    Date.now = originalNow;
  }
});
