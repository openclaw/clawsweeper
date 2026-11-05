import {
  assert,
  test,
  ExactReviewQueue,
  MemoryDurableStorage,
} from "./dashboard-worker-harness.ts";

const checkpoint = () =>
  new Request("https://local.invalid/review-coverage/census/start", {
    method: "POST",
    body: JSON.stringify({
      version: 2,
      attempt: "fallback-prefix",
      observedAt: new Date().toISOString(),
      repositories: [],
    }),
  });

function assertPrefix(storage: MemoryDurableStorage) {
  assert.doesNotThrow(() => storage.sql.readNormalizedQueue());
  assert.doesNotThrow(() =>
    Array.from(
      storage.sql.exec(
        "SELECT audit_id, superseded_lease_id FROM exact_review_queue_supersessions LIMIT 1",
      ),
    ),
  );
  assert.doesNotThrow(() =>
    Array.from(storage.sql.exec("SELECT * FROM exact_review_publication_batches LIMIT 1")),
  );
  assert.doesNotThrow(() =>
    Array.from(storage.sql.exec("SELECT * FROM exact_review_publication_cause_buckets_v1 LIMIT 1")),
  );
}

test("no-hook construction preserves immediate full schema and migration prefix", async () => {
  const storage = new MemoryDurableStorage();
  assert.throws(() => storage.sql.readNormalizedQueue(), /no such table/);
  const queue = new ExactReviewQueue({ storage }, {});
  assertPrefix(storage);
  const prefix = storage.sql.readNormalizedQueue();
  assert.ok(prefix);
  assert.equal((await queue.fetch(checkpoint())).status, 200);
  const admitted = storage.sql.readNormalizedQueue();
  assert.deepEqual(admitted?.items, prefix?.items);
  assert.deepEqual(admitted?.deliveries, prefix?.deliveries);
  const warm = new ExactReviewQueue({ storage }, {});
  assertPrefix(storage);
  assert.deepEqual(storage.sql.readNormalizedQueue(), admitted);
  assert.equal((await warm.fetch(checkpoint())).status, 200);
  assert.deepEqual(storage.sql.readNormalizedQueue()?.items, admitted?.items);
});

test("fallback prefix is synchronous while fetch and alarm still wait for async maintenance", async (t) => {
  const storage = new MemoryDurableStorage(),
    queries: string[] = [],
    exec = storage.sql.exec.bind(storage.sql);
  assert.throws(() => storage.sql.readNormalizedQueue(), /no such table/);
  t.mock.method(storage.sql, "exec", (query: string, ...args: unknown[]) => {
    queries.push(query);
    return exec(query, ...args);
  });
  let release!: () => void,
    entered = false;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const prototype = ExactReviewQueue.prototype as unknown as {
    scheduleStorageMaintenance: () => Promise<void>;
  };
  t.mock.method(prototype, "scheduleStorageMaintenance", () => {
    entered = true;
    return gate;
  });
  const queue = new ExactReviewQueue({ storage }, {});
  assertPrefix(storage);
  assert.equal(entered, true);
  const prefix = storage.sql.readNormalizedQueue();
  let fetched = false,
    alarmed = false;
  const response = queue.fetch(checkpoint()).finally(() => (fetched = true)),
    alarm = queue.alarm().finally(() => (alarmed = true));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fetched, false);
  assert.equal(alarmed, false);
  assert.equal(
    queries.filter((q) => q.startsWith("CREATE TABLE IF NOT EXISTS coverage_census_")).length,
    5,
  );
  release();
  assert.equal((await response).status, 200);
  await alarm;
  assert.deepEqual(storage.sql.readNormalizedQueue()?.items, prefix?.items);
  assert.deepEqual(storage.sql.readNormalizedQueue()?.deliveries, prefix?.deliveries);
  assert.equal(
    queries.filter((q) => q.startsWith("CREATE TABLE IF NOT EXISTS coverage_census_")).length,
    5,
  );
});

test("a full-prefix DDL failure remains a rejected initialization with redacted coordinates", async (t) => {
  const storage = new MemoryDurableStorage(),
    failure = new Error("private full-prefix schema marker");
  failure.stack = "Error: private full-prefix schema marker\n    at schema (worker.js:456:9)";
  storage.failNextSql(/CREATE TABLE IF NOT EXISTS exact_review_queue_meta/, failure);
  const errors: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => errors.push(args));
  let queue!: ExactReviewQueue;
  assert.doesNotThrow(() => {
    queue = new ExactReviewQueue({ storage }, {});
  });
  await assert.rejects(queue.fetch(checkpoint()), (e) => e === failure);
  await assert.rejects(queue.alarm(), (e) => e === failure);
  const initialization = errors.filter((r) => (r[1] as { phase?: string }).phase === "initialize");
  assert.equal(initialization.length, 1);
  assert.deepEqual((initialization[0]![1] as { location: number[] }).location, [456, 9]);
  assert.ok(!JSON.stringify(errors).includes("private full-prefix"));
});
