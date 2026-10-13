import assert from "node:assert/strict";
import test from "node:test";
import {
  ExactReviewLifecycleProjectionStore,
  type LifecycleProducerLineage,
} from "../dashboard/exact-review-lifecycle.ts";
import { TestStorage } from "./exact-review-test-storage.ts";
import { MemoryDurableStorage } from "./dashboard-worker-harness.ts";

function producerJourneyFixture() {
  const storage = new TestStorage();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  lifecycle.ensureSchemaSync();
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
    const audit = store.createAuditInventorySnapshot(100, now + 1_000);
    assert.equal(audit.collection.state, "complete");
    return audit.page!.records;
  };
  lifecycle.recordAdmission(admission({ ...producer, revision: 1 }));
  lifecycle.recordAdmission(admission());
  reviewed();
  return {
    storage,
    lifecycle,
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
  f.finish();
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
    f.finish();
  }
  const lifecycleFacts = (entries: typeof cards) =>
    entries.map((card) => ({
      target: card.target,
      revision: card.revision,
      state: card.state,
      current_revision: card.current_revision,
      facts: card.facts,
      terminal_history: card.terminal_history,
    }));
  assert.deepEqual(lifecycleFacts(f.cards(reconstructed)), lifecycleFacts(cards));

  reconstructed.recordAdmission(f.admission({ ...f.producer, revision: 3 }));
  f.reviewed({ ...f.producer, revision: 3 }); // Even identical delivery/run/generation is not lineage.
  const later = f.cards(reconstructed);
  assert.deepEqual(
    later.filter((card) => card.current_revision).map((card) => [card.revision, card.state]),
    [[3, "pending"]],
  );
  assert.equal(later.find((card) => card.revision === 2)!.state, "completed");
});

test("historical lifecycle metadata preserves canonical facts and idempotent admission", () => {
  const f = producerJourneyFixture();
  const expected = f.lifecycle.read(f.producer.canonicalTargetKey, f.producer.fenceKey, 2)!;
  for (const metadata of [
    {
      bayTelemetryPending: true,
      bayTelemetryEventId: "historical-event",
      inlineProof: { requested: true, firstRequestedAt: 10 },
    },
    {
      bayTelemetryPending: "legacy",
      bayTelemetryEventId: { retired: true },
      inlineProof: "legacy",
    },
  ]) {
    f.storage.run(
      `UPDATE exact_review_lifecycle_projection_v1 SET projection_json = ?
       WHERE canonical_target_key = ? AND fence_key = ? AND revision = ?`,
      JSON.stringify({
        ...expected,
        ...metadata,
        admission: { ...expected.admission, bayJourneyDeliveryId: { retired: true } },
      }),
      f.producer.canonicalTargetKey,
      f.producer.fenceKey,
      2,
    );
    const reconstructed = new ExactReviewLifecycleProjectionStore(f.storage);
    assert.deepEqual(
      reconstructed.read(f.producer.canonicalTargetKey, f.producer.fenceKey, 2),
      expected,
    );
    assert.deepEqual(reconstructed.recordAdmission(f.admission()), expected);
    assert.equal(f.cards(reconstructed).find((card) => card.revision === 2)!.state, "pending");
  }
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

test("competing-child lookup uses its full lineage index and tolerates malformed legacy JSON", () => {
  const storage = new MemoryDurableStorage();
  new ExactReviewLifecycleProjectionStore(storage).ensureSchemaSync();
  storage.sql.exec(
    "INSERT INTO exact_review_lifecycle_projection_v1 (canonical_target_key, revision, fence_key, projection_json, updated_at) VALUES (?, ?, ?, ?, ?)",
    "openclaw/openclaw#1",
    1,
    "invalid",
    "not json",
    Date.now(),
  );
  const plan = Array.from(
    storage.sql.exec(
      "EXPLAIN QUERY PLAN SELECT 1 FROM exact_review_lifecycle_projection_v1 AS sibling WHERE json_valid(sibling.projection_json) AND sibling.canonical_target_key = ? AND json_extract(sibling.projection_json, '$.producerLineage.fenceKey') = ? AND json_extract(sibling.projection_json, '$.producerLineage.revision') = ? AND json_extract(sibling.projection_json, '$.producerLineage.claimGeneration') = ? AND (sibling.fence_key != ? OR sibling.revision != ?)",
      "openclaw/openclaw#1",
      "openclaw/openclaw#1",
      2,
      4,
      "publication",
      1,
    ),
  );
  const details = plan.map((row) => String(row.detail)).join(" ");
  assert.match(details, /exact_review_lifecycle_projection_producer_lineage_v1/);
  const malformedPlan = Array.from(
    storage.sql.exec(
      "EXPLAIN QUERY PLAN SELECT 1 FROM exact_review_lifecycle_projection_v1 AS malformed WHERE NOT json_valid(malformed.projection_json) AND malformed.canonical_target_key = ?",
      "openclaw/openclaw#1",
    ),
  );
  assert.match(
    malformedPlan.map((row) => String(row.detail)).join(" "),
    /exact_review_lifecycle_projection_malformed_target_v1/,
  );
  assert.equal((details.match(/<expr>=\?/g) || []).length, 3);
});
