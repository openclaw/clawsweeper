import assert from "node:assert/strict";
import test from "node:test";
import {
  censusAcceptFailureDetail,
  censusDiagnostic,
  observeCensusAcceptFailure,
} from "../../src/coverage-census-diagnostics.ts";
import { CENSUS } from "../../src/review-coverage-census.ts";
import { censusQuery, censusQueryPages } from "../../dist/repair/review-coverage-census.js";
import { censusFixture } from "../fixtures/review-coverage-census.ts";

const sentinel = "private/repository SQL SELECT token=secret";
test("accept details use only closed owner guards, classes and SQLite codes", () => {
  for (const [error, fault] of [
    [new Error("census observation window conflict"), "observation_window"],
    [new Error("census checkpoint conflict"), "checkpoint"],
    [new TypeError(sentinel), "type_error"],
    [new RangeError(sentinel), "range_error"],
    [Object.assign(new Error(sentinel), { code: "SQLITE_TOOBIG" }), "sqlite_toobig"],
    [Object.assign(new Error(sentinel), { code: sentinel }), "unknown"],
    [new Error("prefix census checkpoint conflict " + sentinel), "unknown"],
  ] as const) {
    const before = Object.getOwnPropertyDescriptors(error);
    observeCensusAcceptFailure(error, "items");
    const detail = censusAcceptFailureDetail(error);
    assert.deepEqual(detail, { operation: "items", fault });
    assert.deepEqual(Object.getOwnPropertyDescriptors(error), before);
    assert.ok(!JSON.stringify(detail).includes(sentinel));
  }
});

test("accept diagnostic never reads caller getters or serializes arbitrary details", () => {
  let reads = 0;
  const error = Object.defineProperties(
    {},
    {
      message: {
        get() {
          reads++;
          throw new Error(sentinel);
        },
      },
      code: {
        get() {
          reads++;
          throw new Error(sentinel);
        },
      },
    },
  );
  observeCensusAcceptFailure(error, "receipt");
  assert.deepEqual(censusAcceptFailureDetail(error), { operation: "receipt", fault: "unknown" });
  assert.equal(reads, 0);
  assert.deepEqual(censusAcceptFailureDetail(sentinel), {});
  const base = { phase: "accept", category: "unclassified" };
  assert.deepEqual(censusDiagnostic({ ...base, operation: sentinel, fault: "unknown" }), base);
  assert.deepEqual(censusDiagnostic({ ...base, operation: "items", fault: sentinel }), base);
  assert.deepEqual(
    censusDiagnostic({ ...base, phase: "query", operation: "items", fault: "unknown" }),
    { phase: "query", category: "unclassified" },
  );
  assert.deepEqual(
    censusDiagnostic({ ...base, operation: "items", fault: "type_error", sql: sentinel }),
    { ...base, operation: "items", fault: "type_error" },
  );
});

async function preparedPage() {
  const f = censusFixture([{ name: "one", issues: 1, pulls: 0 }]);
  const attempt = "accept-diagnostic-fixture";
  await f.control("/start", {
    version: CENSUS.version,
    attempt,
    repositories: f.population(),
    observedAt: new Date(f.time).toISOString(),
  });
  const next = await f.control("/next", { version: CENSUS.version, attempt });
  const work = next.work as Parameters<typeof censusQuery>[0];
  const pages = censusQueryPages(
    await f.query(censusQuery(work)),
    work,
    new Date(f.time).toISOString(),
  );
  return {
    f,
    body: { version: CENSUS.version, attempt, requestId: "accept-diagnostic-page", pages },
  };
}

test("real checkpoint rejection retains original Error and leaves derived rows unchanged", async () => {
  const { f, body } = await preparedPage();
  body.pages[0]!.revisionNumber++;
  const before = JSON.stringify(f.states());
  let original: unknown;
  await assert.rejects(f.store.accept(body, f.time), (error) => {
    original = error;
    assert.equal((error as Error).message, "census checkpoint conflict");
    assert.deepEqual(censusAcceptFailureDetail(error), {
      operation: "checkpoint",
      fault: "checkpoint",
    });
    return true;
  });
  assert.ok(original instanceof Error);
  assert.equal(JSON.stringify(f.states()), before);
});

test("successful acceptance and replay remain idempotent", async () => {
  const { f, body } = await preparedPage();
  const first = await f.store.accept(body, f.time);
  const before = JSON.stringify(f.states());
  const replay = await f.store.accept(body, f.time);
  assert.equal(first.accepted, true);
  assert.equal(replay.replayed, true);
  assert.equal(JSON.stringify(f.states()), before);
});

test("SQL rejection keeps exact error identity, cause and rolled-back derived state", async () => {
  const { f, body } = await preparedPage();
  const error = new Error(sentinel, { cause: new Error("original-private-cause") });
  const descriptors = Object.getOwnPropertyDescriptors(error);
  const sql = (
    f.store as unknown as { storage: { sql: { exec: (...args: unknown[]) => unknown } } }
  ).storage.sql;
  const original = sql.exec;
  const before = JSON.stringify(f.states());
  sql.exec = function (...args: unknown[]) {
    if (String(args[0]).startsWith("INSERT OR REPLACE INTO coverage_census_items")) throw error;
    return original.apply(this, args);
  };
  try {
    await assert.rejects(f.store.accept(body, f.time), (caught) => {
      assert.equal(caught, error);
      assert.deepEqual(censusAcceptFailureDetail(caught), { operation: "items", fault: "unknown" });
      return true;
    });
    assert.deepEqual(Object.getOwnPropertyDescriptors(error), descriptors);
    assert.equal(JSON.stringify(f.states()), before);
  } finally {
    sql.exec = original;
  }
});

test("receipt and cleanup failures roll back and do not poison a later invocation", async () => {
  for (const operation of ["replay", "receipt", "cleanup"] as const) {
    const { f, body } = await preparedPage();
    const sql = f.store.storage.sql;
    const original = sql.exec.bind(sql);
    const error = new TypeError("private-token-sql-cursor");
    const descriptors = Object.getOwnPropertyDescriptors(error);
    const before = JSON.stringify(f.states());
    let injected = false;
    sql.exec = (statement: string, ...bindings: unknown[]) => {
      const matches =
        operation === "replay"
          ? statement.startsWith("SELECT attempt,digest,result FROM coverage_census_receipts")
          : operation === "receipt"
            ? statement.startsWith("INSERT INTO coverage_census_receipts")
            : statement.startsWith("DELETE FROM coverage_census_receipts");
      if (matches && !injected) {
        injected = true;
        throw error;
      }
      return original(statement, ...bindings);
    };
    try {
      await assert.rejects(f.store.accept(body, f.time), (caught) => {
        assert.equal(caught, error);
        assert.deepEqual(censusAcceptFailureDetail(caught), { operation, fault: "type_error" });
        return true;
      });
      assert.equal(injected, true);
      assert.deepEqual(Object.getOwnPropertyDescriptors(error), descriptors);
      assert.equal(JSON.stringify(f.states()), before);
    } finally {
      sql.exec = original;
    }
    const accepted = await f.store.accept(body, f.time);
    assert.deepEqual(await f.store.accept(body, f.time), { ...accepted, replayed: true }); // lost ACK replay
    // Reusing a caller-owned throw in a new invocation replaces, not leaks, its stage.
    const hostile = new Proxy(
      {},
      {
        get() {
          throw error;
        },
      },
    );
    await assert.rejects(f.store.accept(hostile, f.time), (caught) => {
      assert.equal(caught, error);
      assert.deepEqual(censusAcceptFailureDetail(caught), {
        operation: "validate",
        fault: "type_error",
      });
      return true;
    });
    assert.deepEqual(Object.getOwnPropertyDescriptors(error), descriptors);
  }
});
