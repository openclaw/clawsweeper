import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import {
  ExactReviewLifecycleProjectionStore,
  type LifecycleTerminalDisposition,
  type LifecycleProducerLineage,
} from "../dashboard/exact-review-lifecycle.ts";
import { ExactReviewLifecycleTelemetryStore } from "../dashboard/exact-review-lifecycle-telemetry.ts";
import { TestStorage } from "./exact-review-test-storage.ts";

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

test("streamed Bay materialization equals full audit materialization on mixed lifecycle facts", () => {
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
  const exec = storage.sql.exec.bind(storage.sql);
  const projectionPlans: string[] = [];
  storage.sql.exec = (query, ...bindings) => {
    if (/^\s*SELECT projection_json/.test(query)) {
      projectionPlans.push(
        Array.from(exec(`EXPLAIN QUERY PLAN ${query}`, ...bindings))
          .map((row) => String(row.detail))
          .join("\n"),
      );
    }
    return exec(query, ...bindings);
  };
  const bay = lifecycle.readBaySnapshot(now);
  assert.equal(projectionPlans.length, 1);
  assert.doesNotMatch(projectionPlans[0]!, /USE TEMP B-TREE/i);
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

function producerJourneyFixture() {
  const storage = new TestStorage();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const telemetry = new ExactReviewLifecycleTelemetryStore(storage);
  lifecycle.ensureSchemaSync();
  telemetry.ensureSchemaSync();
  const now = Date.now();
  const producer = {
    canonicalTargetKey: "openclaw/openclaw#71",
    fenceKey: "openclaw/openclaw#71",
    revision: 2,
  };
  const publication = { ...producer, fenceKey: "openclaw/openclaw#71@publish:1071:1", revision: 1 };
  const lineage = { fenceKey: producer.fenceKey, revision: 2, claimGeneration: 7 };
  const admission = (identity = producer, producerLineage?: LifecycleProducerLineage) => ({
    ...identity,
    ...(producerLineage ? { producerLineage } : {}),
    deliveryId: "shared-delivery-is-not-lineage",
    sourceDeliveryId: "shared-source-is-not-lineage",
    sourceAction: "manual_explicit_review",
    commandOriginated: false,
    statusMarker: null,
    statusCommentId: null,
    triggeredAt: now - 60_000,
    observedAt: now,
  });
  const reviewed = (identity = producer, claimGeneration = 7) =>
    lifecycle.recordReviewResult({
      ...identity,
      claimGeneration,
      runId: "1071",
      runAttempt: 1,
      outcome: "completed",
      observedAt: now,
    });
  const finish = (identity = publication) => {
    lifecycle.recordClaim({
      ...identity,
      claimGeneration: 11,
      runId: "9000",
      runAttempt: 1,
      observedAt: now,
    });
    lifecycle.recordGithubEffect({
      ...identity,
      commentId: 106,
      digest: "a".repeat(64),
      observedAt: now + 100,
    });
    lifecycle.recordCanonicalReceipt({
      ...identity,
      outcome: "accepted",
      receiptId: `batch:${identity.fenceKey}:${identity.revision}`,
      observedAt: now + 100,
    });
    lifecycle.recordRouterReceipt({
      ...identity,
      outcome: "not_required",
      receiptId: "router-batch:9000",
      observedAt: now + 200,
      operationComplete: true,
    });
    return lifecycle.recordTerminalDisposition({
      ...identity,
      kind: "review_completed_routed",
      operationId: "completed:9000",
      observedAt: now + 200,
    });
  };
  const cards = (store = lifecycle) => {
    const bay = store.readBaySnapshot(now + 1_000);
    const audit = store.createAuditInventorySnapshot(100, now + 1_000);
    assert.equal(bay.collection.state, "complete");
    assert.equal(audit.collection.state, "complete");
    assert.deepEqual(
      bay.sample!.cards.map((card) => JSON.stringify(card)).sort(),
      audit.page!.records.map((card) => JSON.stringify(card)).sort(),
    );
    return audit.page!.records;
  };
  lifecycle.recordAdmission(admission({ ...producer, revision: 1 }));
  lifecycle.recordAdmission(admission());
  reviewed();
  return {
    storage,
    lifecycle,
    telemetry,
    now,
    producer,
    publication,
    lineage,
    admission,
    reviewed,
    finish,
    cards,
  };
}

test("linked producer2/publication1 survives reconstruction and never completes producer1 or producer3", () => {
  const f = producerJourneyFixture();
  f.lifecycle.recordAdmission(f.admission(f.publication, f.lineage));
  const producerBefore = f.lifecycle.read(f.producer.canonicalTargetKey, f.producer.fenceKey, 2);
  assert.equal(f.telemetry.syncBayLifecycle(f.finish()), true);
  // These stores have no queue state: reconstruction reads only durable lifecycle facts.
  const reconstructed = new ExactReviewLifecycleProjectionStore(f.storage);
  const cards = f.cards(reconstructed);
  const current = cards.filter((card) => card.current_revision);
  assert.equal(current.length, 1);
  assert.equal(current[0]!.revision, 2);
  assert.equal(current[0]!.state, "completed");
  assert.deepEqual(current[0]!.facts, {
    admission: "recorded",
    claim_count: 0,
    review_result: "completed",
    github_effect_recorded: true,
    canonical_receipts: ["accepted"],
    router_receipt: "not_required",
    acknowledgement: "not_required",
  });
  assert.ok(
    cards.some((card) => card.revision === 1 && card.state === "pending" && !card.current_revision),
  );
  assert.deepEqual(
    reconstructed.read(f.producer.canonicalTargetKey, f.producer.fenceKey, 2),
    producerBefore,
    "logical completion never writes producer receipts, claims, or terminal facts",
  );

  for (let replay = 0; replay < 3; replay++) {
    const telemetry = new ExactReviewLifecycleTelemetryStore(f.storage);
    assert.equal(telemetry.syncBayLifecycle(f.finish()), true);
    assert.deepEqual(telemetry.reconcileBayLifecyclePending(), {
      pending: false,
      progressed: false,
    });
    assert.equal(telemetry.baySnapshot(f.now + 1_000).terminal!.terminal_count, 1);
  }
  const events = Array.from(
    f.storage.sql.exec(
      "SELECT event_id, fence_key, revision FROM exact_review_lifecycle_bay_event_v2",
    ),
  );
  assert.deepEqual(
    events.map((event) => ({ ...event })),
    [
      {
        event_id: `bay:v2:${f.publication.fenceKey}:1`,
        fence_key: f.publication.fenceKey,
        revision: 1,
      },
    ],
  );

  reconstructed.recordAdmission(f.admission({ ...f.producer, revision: 3 }));
  f.reviewed({ ...f.producer, revision: 3 }); // Even identical delivery/run/generation is not lineage.
  const later = f.cards(reconstructed);
  assert.deepEqual(
    later.filter((card) => card.current_revision).map((card) => [card.revision, card.state]),
    [[3, "pending"]],
  );
  assert.equal(later.find((card) => card.revision === 2)!.state, "completed");
  assert.equal(f.telemetry.baySnapshot(f.now + 1_000).terminal!.terminal_count, 1);
});

test("a linked publication with a missing producer is historical, not a current producer completion", () => {
  const f = producerJourneyFixture();
  f.lifecycle.recordAdmission(f.admission(f.publication, f.lineage));
  f.finish();
  f.storage.run(
    "DELETE FROM exact_review_lifecycle_projection_v1 WHERE fence_key = ?",
    f.producer.fenceKey,
  );
  const cards = f.cards();
  assert.equal(cards.length, 1);
  assert.equal(cards[0]!.state, "completed");
  assert.equal(cards[0]!.current_revision, false);
});

test("producer lineage is immutable and validates exact target, revision, and generation", () => {
  const f = producerJourneyFixture();
  const admitted = f.admission(f.publication, f.lineage);
  f.lifecycle.recordAdmission(admitted);
  assert.doesNotThrow(() => f.lifecycle.recordAdmission(admitted));
  for (const producerLineage of [
    undefined,
    { ...f.lineage, revision: 3 },
    { ...f.lineage, claimGeneration: 8 },
  ]) {
    assert.throws(
      () => f.lifecycle.recordAdmission({ ...admitted, producerLineage }),
      /conflicting lifecycle admission/,
    );
  }
  for (const producerLineage of [
    { ...f.lineage, fenceKey: "openclaw/openclaw#72" },
    { ...f.lineage, revision: 0 },
    { ...f.lineage, claimGeneration: 0 },
    { ...f.lineage, runId: "1071" },
    null,
  ]) {
    assert.throws(
      () => f.lifecycle.recordAdmission({ ...admitted, producerLineage } as typeof admitted),
      /invalid lifecycle producer lineage/,
    );
  }
  assert.throws(
    () => f.lifecycle.recordAdmission(f.admission(f.producer, f.lineage)),
    /invalid lifecycle producer lineage/,
  );
});

for (const scenario of [
  "missing",
  "wrong-revision",
  "wrong-generation",
  "competing",
  "newer-claim",
  "producer-terminal",
  "command-mismatch",
] as const) {
  test(`journey resolution fails closed for ${scenario} lineage evidence`, () => {
    const f = producerJourneyFixture();
    const link =
      scenario === "missing"
        ? undefined
        : {
            ...f.lineage,
            ...(scenario === "wrong-revision" ? { revision: 1 } : {}),
            ...(scenario === "wrong-generation" ? { claimGeneration: 6 } : {}),
          };
    f.lifecycle.recordAdmission({
      ...f.admission(f.publication, link),
      ...(scenario === "command-mismatch" ? { commandOriginated: true, statusCommentId: 100 } : {}),
    });
    f.finish();
    if (scenario === "competing") {
      f.lifecycle.recordAdmission(
        f.admission({ ...f.publication, fenceKey: "another-physical-publication" }, f.lineage),
      );
    }
    if (scenario === "newer-claim") f.reviewed(f.producer, 8);
    if (scenario === "producer-terminal")
      f.lifecycle.recordTerminalDisposition({ ...f.producer, kind: "requeue", observedAt: f.now });
    const producer = f.cards().find((card) => card.revision === 2)!;
    assert.equal(producer.state, scenario === "producer-terminal" ? "requeue" : "pending");
    assert.equal(producer.facts.github_effect_recorded, false);
    assert.deepEqual(producer.facts.canonical_receipts, []);
  });
}

test("retained publication generations do not compete with the current producer generation", () => {
  const f = producerJourneyFixture();
  f.lifecycle.recordAdmission(f.admission(f.publication, f.lineage));
  f.finish();
  f.reviewed(f.producer, 8);
  const currentPublication = { ...f.publication, fenceKey: "current-generation-publication" };
  const currentLineage = { ...f.lineage, claimGeneration: 8 };
  f.lifecycle.recordAdmission(f.admission(currentPublication, currentLineage));
  f.finish(currentPublication);
  const current = () => f.cards().filter((card) => card.current_revision);
  assert.deepEqual(
    current().map((card) => [card.revision, card.state]),
    [[2, "completed"]],
  );

  f.lifecycle.recordAdmission(
    f.admission(
      { ...currentPublication, fenceKey: "competing-current-publication" },
      currentLineage,
    ),
  );
  assert.deepEqual(
    current().map((card) => [card.revision, card.state]),
    [[2, "pending"]],
  );
});

test("unlinked higher publication counter cannot mask the canonical producer current journey", () => {
  const f = producerJourneyFixture();
  const legacy = { ...f.publication, revision: 50 };
  f.lifecycle.recordAdmission(f.admission(legacy));
  f.finish(legacy);
  const cards = f.cards();
  assert.deepEqual(
    cards.filter((card) => card.current_revision).map((card) => [card.revision, card.state]),
    [[2, "pending"]],
  );
  assert.equal(cards.find((card) => card.revision === 50)!.state, "completed");

  f.storage.run(
    "UPDATE exact_review_lifecycle_projection_v1 SET projection_json = json_set(projection_json, '$.producerLineage', json('null')) WHERE fence_key = ?",
    legacy.fenceKey,
  );
  assert.equal(f.lifecycle.readBaySnapshot().collection.state, "unknown");
  assert.equal(f.lifecycle.createAuditInventorySnapshot(100).collection.state, "unknown");
});

test("standalone legacy fence remains observable but competing fence families have no current completion", () => {
  const f = producerJourneyFixture();
  f.storage.run(
    "DELETE FROM exact_review_lifecycle_projection_v1 WHERE fence_key = ?",
    f.producer.fenceKey,
  );
  f.lifecycle.recordAdmission(f.admission(f.publication));
  f.finish();
  assert.deepEqual(
    f
      .cards()
      .filter((card) => card.current_revision)
      .map((card) => card.state),
    ["completed"],
  );
  const competitor = { ...f.publication, fenceKey: "independent-legacy-fence", revision: 50 };
  f.lifecycle.recordAdmission(f.admission(competitor));
  f.finish(competitor);
  assert.deepEqual(
    f.cards().filter((card) => card.current_revision),
    [],
  );
});
