import {
  assert,
  test,
  ExactReviewQueue,
  MemoryDurableStorage,
} from "./dashboard-worker-harness.ts";
import { ReviewCoverageCensusStore } from "../dashboard/review-coverage-census.ts";
import { authorityFixture } from "../docs/proof/ui-live-coverage/coverage-authority-fixture.mjs";
import { censusFixture } from "./fixtures/review-coverage-census.ts";
import { runReviewCoverageCensus } from "../dist/repair/review-coverage-census.js";

const startRequest = () =>
  new Request("https://local.invalid/review-coverage/census/start", {
    method: "POST",
    body: JSON.stringify({
      version: 2,
      attempt: "schema-owner",
      observedAt: new Date().toISOString(),
      repositories: [],
    }),
  });

test("census store constructor is storage-only and explicit schema setup is idempotent", () => {
  const calls: string[] = [];
  const storage = {
    sql: {
      exec(query: string) {
        calls.push(query);
        return [];
      },
    },
    transactionSync<T>(fn: () => T) {
      return fn();
    },
  };
  const store = new ReviewCoverageCensusStore(storage);
  assert.equal(calls.length, 0);
  store.ensureSchemaSync();
  assert.equal(calls.filter((q) => q.startsWith("CREATE TABLE")).length, 5);
  const initializedCalls = calls.length;
  store.ensureSchemaSync();
  assert.equal(calls.length, initializedCalls);
});

test("census DDL failure rejects the existing schema barrier and later fetch fails closed", async (t) => {
  const storage = new MemoryDurableStorage(),
    failure = new Error("private census schema marker");
  failure.stack = "Error: private census schema marker\n    at censusSchema (worker.js:456:9)";
  storage.failNextSql(/CREATE TABLE IF NOT EXISTS coverage_census_/, failure);
  const queries: string[] = [],
    exec = storage.sql.exec.bind(storage.sql);
  t.mock.method(storage.sql, "exec", (query: string, ...args: unknown[]) => {
    queries.push(query);
    return exec(query, ...args);
  });
  const errors: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => errors.push(args));
  let initialized: Promise<void> | undefined;
  const queue = new ExactReviewQueue(
    {
      storage,
      blockConcurrencyWhile(callback: () => Promise<void>) {
        initialized = callback();
        return initialized;
      },
    },
    {},
  );
  assert.ok(initialized);
  await assert.rejects(initialized, (e) => e === failure);
  assert.equal(errors[0]![0], "exact_review_queue_handler_failed");
  assert.equal((errors[0]![1] as { phase: string }).phase, "initialize");
  assert.deepEqual((errors[0]![1] as { location: number[] }).location, [456, 9]);
  assert.ok(!JSON.stringify(errors).includes("private census"));
  await assert.rejects(queue.fetch(startRequest()), (e) => e === failure);
  await assert.rejects(queue.alarm(), (e) => e === failure);
  assert.ok(!JSON.stringify(errors).includes("private census"));
  assert.ok(
    queries
      .filter((q) => q.includes("coverage_census_"))
      .every((q) => q.startsWith("CREATE TABLE")),
  );
  assert.equal(queries.filter((q) => q.includes("coverage_census_")).length, 1);
});

test("a checkpoint queued before the schema barrier resolves cannot read or publish progress", async (t) => {
  const storage = new MemoryDurableStorage(),
    queries: string[] = [],
    exec = storage.sql.exec.bind(storage.sql);
  t.mock.method(storage.sql, "exec", (query: string, ...args: unknown[]) => {
    queries.push(query);
    return exec(query, ...args);
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let initialized!: Promise<void>;
  const queue = new ExactReviewQueue(
    {
      storage,
      blockConcurrencyWhile(callback: () => Promise<void>) {
        initialized = gate.then(callback);
        return initialized;
      },
    },
    {},
  );
  let settled = false;
  const pending = queue.fetch(startRequest()).finally(() => {
    settled = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false);
  assert.ok(!queries.some((q) => q.includes("coverage_census_")));
  release();
  await initialized;
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal((await response.json()).metadataAccepted, true);
  assert.equal(
    queries.filter((q) => q.startsWith("CREATE TABLE IF NOT EXISTS coverage_census_")).length,
    5,
  );
});

test("warm namespace schema initialization preserves the census cursor and canonical admission state", async () => {
  const a = await authorityFixture(),
    model = censusFixture([{ name: "core", issues: 250, pulls: 1 }]);
  try {
    const attempt = "warm-schema-owner";
    let accepted = false;
    const control = async (path: string, body: Record<string, unknown>) => {
      if (accepted && path.endsWith("/next")) return { ok: true, work: [] };
      // This test keeps driving the same attempt after the run returns, so it keeps the lease.
      if (path.endsWith("/release")) return { ok: true };
      const response = await a.queue.fetch(
        new Request("https://local.invalid" + path.replace("/internal", ""), {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
      const result = await response.json();
      if (path.endsWith("/accept") && result.ok) accepted = true;
      return result;
    };
    await runReviewCoverageCensus({
      attempt,
      repositories: model.population().map((r) => ({ ...r, countsAt: new Date().toISOString() })),
      query: model.query,
      control,
    });
    assert.equal(accepted, true);
    const snapshots = () =>
      JSON.stringify([
        Array.from(a.storage.sql.exec("SELECT * FROM coverage_census_repositories ORDER BY repo")),
        Array.from(
          a.storage.sql.exec(
            "SELECT * FROM coverage_census_items ORDER BY repo,generation,kind,number",
          ),
        ),
        Array.from(
          a.storage.sql.exec(
            "SELECT * FROM coverage_census_cursors ORDER BY repo,generation,kind,cursor",
          ),
        ),
      ]);
    const before = snapshots(),
      canonical = JSON.stringify(a.canonicalState()),
      admission = JSON.stringify(a.storage.kv.get("exact-review-queue"));
    const state = JSON.parse(
      String(
        Array.from(a.storage.sql.exec("SELECT state FROM coverage_census_repositories"))[0]!.state,
      ),
    );
    const cursor = state.active.connections.issue.cursor;
    assert.ok(cursor);
    let initialized!: Promise<void>;
    const queue = new ExactReviewQueue(
      {
        storage: a.storage,
        blockConcurrencyWhile(callback: () => Promise<void>) {
          initialized = callback();
          return initialized;
        },
      },
      a.env,
    );
    await initialized;
    assert.equal(snapshots(), before);
    const next = await queue.fetch(
      new Request("https://local.invalid/review-coverage/census/next", {
        method: "POST",
        body: JSON.stringify({ version: 2, attempt, excluded: ["fixture/core:pull_request"] }),
      }),
    );
    assert.equal(next.status, 200);
    const body = await next.json();
    const again = await queue.fetch(
      new Request("https://local.invalid/review-coverage/census/next", {
        method: "POST",
        body: JSON.stringify({ version: 2, attempt }),
      }),
    );
    assert.equal(again.status, 200);
    const second = await again.json();
    assert.ok(
      [...body.work, ...second.work].some((w) => w.kind === "issue" && w.cursor === cursor),
      JSON.stringify({ cursor, body, second }),
    );
    assert.equal(JSON.stringify(a.canonicalState()), canonical);
    assert.equal(JSON.stringify(a.storage.kv.get("exact-review-queue")), admission);
  } finally {
    model.db.close();
  }
});

test("fallback initialization without a concurrency hook rejects once and never serves a checkpoint", async (t) => {
  const storage = new MemoryDurableStorage(),
    failure = new Error("private fallback census marker");
  failure.stack = "Error: private fallback census marker\n    at schema (worker.js:456:9)";
  storage.failNextSql(/CREATE TABLE IF NOT EXISTS coverage_census_/, failure);
  const errors: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => errors.push(args));
  const queue = new ExactReviewQueue({ storage }, {});
  await assert.rejects(queue.fetch(startRequest()), (e) => e === failure);
  await assert.rejects(queue.alarm(), (e) => e === failure);
  assert.equal(errors.filter((r) => (r[1] as { phase?: string }).phase === "initialize").length, 1);
  assert.ok(!JSON.stringify(errors).includes("private fallback"));
});
