import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { ExactReviewPublicationBatchStore } from "../dashboard/exact-review-publication-batches.ts";
import { ExactReviewQueue } from "../dashboard/exact-review-queue.ts";
import worker from "../dashboard/worker.ts";

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
  private alarmAt: number | null = null;
  readonly sql = {
    exec: (query: string, ...bindings: unknown[]) => {
      const statement = this.database.prepare(query);
      if (/^\s*(?:SELECT|WITH)\b/i.test(query) || /\bRETURNING\b/i.test(query)) {
        return new SqlCursor(statement.all(...bindings) as Record<string, unknown>[]);
      }
      statement.run(...bindings);
      return new SqlCursor<Record<string, unknown>>([]);
    },
  };
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

test("queue pressure cannot stay idle while publication health is critical", async () => {
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
    assert.equal(stats.pressure.status, "saturated");
    assert.equal(stats.pressure.reason, "publication_critical");
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
    const queue = new ExactReviewQueue(
      { storage: new TestStorage() },
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
    if (url.pathname === "/app/installations/999/access_tokens") {
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.permissions, { actions: "write", contents: "write" });
      return new Response(JSON.stringify({ token: "test-token" }), {
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
        EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0",
      },
    );
    await queue.fetch(publicationRequest("delivery-batch-1", 110, "1010"));
    await queue.fetch(publicationRequest("delivery-batch-2", 111, "1011"));
    await queue.fetch(reviewRequest("delivery-review", 114));

    const alarm = queue.alarm();
    await batchDispatchStarted;

    assert.deepEqual(dispatches, [{ ref: "main", inputs: { execute: "true" } }]);
    const dispatchedStats = await (await queue.fetch(new Request("https://queue/stats"))).json();
    assert.equal(
      dispatchedStats.lanes.publication.batches.dispatch_pending_until,
      "1970-01-01T02:06:40.000Z",
    );
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
    assert.equal(storage.scheduledAlarm(), 7_001_000);

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
    assert.deepEqual(dispatches[1], {
      ref: "main",
      inputs: { execute: "true" },
    });
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
    const keys = new Set(claim.batch.items.map((item: { item_key: string }) => item.item_key));
    assert.deepEqual(
      keys,
      new Set([
        "openclaw/openclaw#10@publish:7010:1",
        "openclaw/openclaw#11@publish:7011:1",
        "openclaw/openclaw#12@publish:7012:1",
        "openclaw/openclaw#90@publish:7190:1",
      ]),
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
    const queue = new ExactReviewQueue(
      { storage: new TestStorage() },
      { EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1" },
    );
    await queue.fetch(publicationRequest("delivery-retryable", 123, "1023"));
    const claim = await (
      await queue.fetch(
        batchRequest("/publication-batches/claim", {
          claim_id: "claim-retryable",
          lease_owner: "worker-1",
          max_items: 1,
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
              error_fingerprint: "state-contention-proof",
            },
          ],
        }),
      )
    ).json();
    assert.equal(completion.accepted, 1, JSON.stringify(completion));
    assert.equal(completion.batch.state, "completed");
    assert.equal(completion.batch.items[0].terminal_outcome, "lease_expired");

    const stats = await (await queue.fetch(new Request("https://queue/stats"))).json();
    assert.equal(stats.lanes.publication.pending, 1);
    assert.equal(stats.lanes.publication.completed_total, 0);
    assert.equal(stats.lanes.publication.retried_total, 1);
    assert.equal(stats.lanes.publication.batches.leased, 0);

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
