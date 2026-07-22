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
  assert.deepEqual(batches.activeLeaseSnapshot(1_500), {
    itemKeys: candidates.slice(0, 2).map((item) => item.itemKey),
    nextLeaseExpiresAt: 2_000,
  });
  assert.equal(batches.fetch("batch-1", "wrong-worker", 1_500), null);
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
          protocolVersion: 2,
          leaseRevision: 1,
          claimGeneration: 1,
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
