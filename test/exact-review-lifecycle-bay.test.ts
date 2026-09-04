import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import {
  ExactReviewLifecycleProjectionStore,
  type LifecycleTerminalDisposition,
} from "../dashboard/exact-review-lifecycle.ts";

test("lifecycle Bay streams more than 10k historical facts without losing lanes or revisions", (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  let observing = false;
  let transactionDepth = 0;
  let projectionReads = 0;
  let revisionLookups = 0;
  const storage = {
    sql: {
      exec(query: string, ...bindings: unknown[]) {
        if (observing) {
          assert.match(query, /^\s*SELECT\b/, "observation must not mutate storage");
          assert.equal(transactionDepth, 1, "all observation queries share one transaction");
          if (/SELECT MAX\(revision\)/.test(query)) revisionLookups += 1;
        }
        const statement = database.prepare(query);
        if (!/^\s*SELECT\b/i.test(query)) {
          statement.run(...(bindings as SQLInputValue[]));
          return [];
        }
        return (function* () {
          for (const row of statement.iterate(...(bindings as SQLInputValue[]))) {
            if (
              !observing ||
              !/SELECT projection_json, canonical_target_key, fence_key, revision/.test(query)
            ) {
              yield row;
              continue;
            }
            projectionReads += 1;
            let consumed = false;
            yield {
              ...row,
              get projection_json() {
                consumed = true;
                return row.projection_json;
              },
            };
            assert.equal(
              consumed,
              true,
              "the reader must consume each projection before advancing",
            );
          }
        })();
      },
    },
    transactionSync<T>(callback: () => T) {
      assert.equal(transactionDepth, 0);
      database.exec("BEGIN");
      transactionDepth += 1;
      try {
        const result = callback();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      } finally {
        transactionDepth -= 1;
      }
    },
  };
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  lifecycle.ensureSchemaSync();
  const now = Date.now();
  const record = (
    number: number,
    {
      revision = 1,
      fence = `fence:${number}:${revision}`,
      terminal,
      command = false,
      observedAt = now - 1_000,
    }: {
      revision?: number;
      fence?: string;
      terminal?: LifecycleTerminalDisposition;
      command?: boolean;
      observedAt?: number;
    } = {},
  ) => {
    const identity = {
      canonicalTargetKey: `openclaw/openclaw#${number}`,
      fenceKey: fence,
      revision,
    };
    lifecycle.recordAdmission({
      ...identity,
      deliveryId: `delivery:${fence}`,
      sourceAction: command ? "re_review" : "synchronize",
      commandOriginated: command,
      statusMarker: command ? `status:${number}` : null,
      statusCommentId: command ? number : null,
      observedAt,
    });
    if (terminal === "review_completed_routed") {
      lifecycle.recordCanonicalReceipt({
        ...identity,
        outcome: "accepted",
        receiptId: fence,
        observedAt,
      });
      lifecycle.recordRouterReceipt({
        ...identity,
        outcome: "durable",
        receiptId: fence,
        observedAt,
      });
    }
    if (terminal) lifecycle.recordTerminalDisposition({ ...identity, kind: terminal, observedAt });
    return identity;
  };
  for (let index = 0; index < 9_960; index += 1) {
    record(20_000 + index, {
      terminal: "review_completed_routed",
      observedAt: now - 2_000 - index,
    });
  }
  for (let index = 0; index < 34; index += 1) record(40_000 + index);
  record(10, { fence: "first-fence", observedAt: now - 1 });
  record(10, { fence: "second-fence", observedAt: now - 2 });
  const oldest = record(10, { revision: 2, observedAt: now - 100_000 });
  record(11, { terminal: "review_completed_routed", command: true });
  record(12, { terminal: "superseded" });
  record(13, { terminal: "requeue" });
  record(14, { terminal: "dead_letter" });

  const oldestProjection = lifecycle.read(
    oldest.canonicalTargetKey,
    oldest.fenceKey,
    oldest.revision,
  )!;
  const legacyProjection = { ...oldestProjection } as Record<string, unknown>;
  delete legacyProjection.routerReceipts;
  delete legacyProjection.terminalDispositions;
  delete legacyProjection.bayTelemetryPending;
  const replaceOldest = (json: string) => {
    database.exec("PRAGMA query_only = OFF");
    database
      .prepare(
        `UPDATE exact_review_lifecycle_projection_v1 SET projection_json = ?
        WHERE canonical_target_key = ? AND fence_key = ? AND revision = ?`,
      )
      .run(json, oldest.canonicalTargetKey, oldest.fenceKey, oldest.revision);
    database.exec("PRAGMA query_only = ON");
  };
  database
    .prepare(
      `INSERT INTO exact_review_lifecycle_projection_v1
       (canonical_target_key, fence_key, revision, projection_json, updated_at)
     VALUES ('private-owner/private-repo#1', 'private', 1, '{not-json', ?)`,
    )
    .run(now);
  replaceOldest(JSON.stringify(legacyProjection));
  const changesBefore = database.prepare("SELECT total_changes() AS count").get()?.count;
  observing = true;
  const read = () => lifecycle.readBaySnapshot(now, new Set(["openclaw/openclaw"]));
  const snapshot = read();
  assert.deepEqual(snapshot.collection, { state: "complete" });
  assert.deepEqual(snapshot.inventory, {
    lifecycle_records: 10_001,
    target_revisions: 10_000,
    unique_targets: 9_999,
  });
  assert.deepEqual(snapshot.lanes, {
    pending: 37,
    acknowledgement_pending: 1,
    completed: 9_960,
    superseded: 1,
    requeued: 1,
    terminal_attention: 1,
  });
  assert.equal(projectionReads, 10_001);
  assert.ok(revisionLookups <= 24, "identity lookups are bounded by the final sample");
  assert.equal(snapshot.sample?.returned, 24);
  assert.equal(snapshot.sample?.omitted, 9_977);
  assert.equal(new Set(snapshot.sample?.cards.map((card) => card.lane)).size, 6);
  const olderRevisions = snapshot.sample?.cards.filter((card) => card.target.number === 10);
  assert.equal(olderRevisions?.length, 2);
  assert.ok(olderRevisions?.every((card) => card.revision === 1 && !card.current_revision));
  assert.deepEqual(read(), snapshot, "repeated observation preserves the same facts and sample");
  assert.equal(database.prepare("SELECT total_changes() AS count").get()?.count, changesBefore);
  assert.equal(
    database
      .prepare(
        `SELECT projection_json FROM exact_review_lifecycle_projection_v1
        WHERE canonical_target_key = ? AND fence_key = ? AND revision = ?`,
      )
      .get(oldest.canonicalTargetKey, oldest.fenceKey, oldest.revision)?.projection_json,
    JSON.stringify(legacyProjection),
    "legacy normalization must remain in memory",
  );

  for (const [json, reason] of [
    ["{not-json", "malformed"],
    [JSON.stringify(oldestProjection) + "\0trailing", "malformed"],
    [
      JSON.stringify(oldestProjection).replace('"githubEffect"', '"githubEffect\\u0000extra"'),
      "mixed",
    ],
    [
      JSON.stringify(oldestProjection).replace(
        '"githubEffect":null',
        '"githubEffect":null,"githubEffect":{}',
      ),
      "mixed",
    ],
    [
      JSON.stringify(oldestProjection).replace('"githubEffect":null', '"githubEffect":NaN'),
      "malformed",
    ],
    [JSON.stringify(oldestProjection).replace('"version":1', "version:1"), "malformed"],
    [JSON.stringify({ ...oldestProjection, githubEffect: undefined }), "mixed"],
    [JSON.stringify({ ...oldestProjection, revision: 3 }), "mixed"],
    [JSON.stringify({ ...oldestProjection, bayTelemetryEventId: null }), "mixed"],
    [
      JSON.stringify({
        ...oldestProjection,
        terminalOperationIds: [
          { operationId: "duplicate", kind: "failure" },
          { operationId: "duplicate", kind: "failure" },
        ],
      }),
      "malformed",
    ],
    [
      JSON.stringify({
        ...oldestProjection,
        claims: [{ fenceKey: "ok", claimGeneration: 0, runId: "1", runAttempt: 1, claimedAt: now }],
      }),
      "mixed",
    ],
  ]) {
    replaceOldest(json!);
    const invalid = read();
    assert.deepEqual(invalid.collection, { state: "unknown", reason });
    assert.equal(invalid.inventory, null);
    assert.equal(invalid.lanes, null);
    assert.equal(invalid.sample, null);
  }
  const deepExtension = "[".repeat(1_010) + "0" + "]".repeat(1_010);
  replaceOldest(JSON.stringify(legacyProjection).replace(/}$/, `,"extension":${deepExtension}}`));
  assert.deepEqual(read(), snapshot, "SQLite depth limits must not reject valid full-parser rows");
  replaceOldest(JSON.stringify(legacyProjection));
  assert.deepEqual(read(), snapshot, "an invalid-row early return must release the read cursor");
});

test("streamed Bay materialization equals full audit materialization on mixed lifecycle facts", async () => {
  const { TestStorage } = await import("./exact-review-test-storage.ts");
  const storage = new TestStorage();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  lifecycle.ensureSchemaSync();
  const now = Date.parse("2026-09-04T00:00:00Z");
  const kinds: Array<LifecycleTerminalDisposition | null> = [
    null,
    "review_completed_routed",
    "superseded",
    "requeue",
    "dead_letter",
    "failure",
    "target_closed",
    "target_missing",
    "policy_noop",
    "guarded_open",
  ];
  for (let n = 0; n < 20; n++) {
    const identity = {
      canonicalTargetKey: `openclaw/openclaw#${Math.floor(n / 2) + 1}`,
      fenceKey: `fence:${n}`,
      revision: (n % 2) + 1,
    };
    lifecycle.recordAdmission({
      ...identity,
      deliveryId: `delivery:${n}`,
      sourceAction: "opened",
      commandOriginated: n < 10,
      statusMarker: null,
      statusCommentId: n + 1,
      observedAt: now - n,
    });
    lifecycle.recordClaim({
      ...identity,
      claimGeneration: 1,
      runId: String(n + 1),
      runAttempt: 1,
      observedAt: now - n,
    });
    lifecycle.recordReviewResult({
      ...identity,
      claimGeneration: 1,
      runId: String(n + 1),
      runAttempt: 1,
      outcome: "completed",
      observedAt: now - n,
    });
    lifecycle.recordCanonicalReceipt({
      ...identity,
      outcome: n % 2 ? "deduped" : "accepted",
      receiptId: `receipt:${n}`,
      observedAt: now - n,
    });
    lifecycle.recordRouterReceipt({
      ...identity,
      outcome: "durable",
      receiptId: `router:${n}`,
      observedAt: now - n,
    });
    const kind = kinds[n % kinds.length];
    if (kind) lifecycle.recordTerminalDisposition({ ...identity, kind, observedAt: now - n });
  }
  storage.run(
    "UPDATE exact_review_lifecycle_projection_v1 SET projection_json = json_remove(projection_json, '$.routerReceipts', '$.terminalDispositions', '$.terminalOperationIds', '$.bayTelemetryPending') WHERE fence_key = ?",
    "fence:19",
  );
  const full = lifecycle.createAuditInventorySnapshot(100, now);
  const bay = lifecycle.readBaySnapshot(now);
  assert.equal(full.collection.state, "complete");
  assert.equal(bay.collection.state, "complete");
  const key = (card: { target: { number: number }; revision: number }) =>
    `${card.target.number}:${card.revision}`;
  assert.deepEqual(
    [...bay.sample!.cards].sort((a, b) => key(a).localeCompare(key(b))),
    [...full.page!.records].sort((a, b) => key(a).localeCompare(key(b))),
  );
  for (const [lane, count] of Object.entries(bay.lanes!))
    assert.equal(count, full.page!.records.filter((card) => card.lane === lane).length);
  assert.equal(bay.inventory!.lifecycle_records, full.page!.records.length);
});
