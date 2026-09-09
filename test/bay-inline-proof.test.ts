import assert from "node:assert/strict";
import test from "node:test";
import {
  ExactReviewLifecycleProjectionStore,
  ExactReviewLifecycleTelemetryStore,
  MemoryDurableStorage,
} from "./dashboard-worker-harness.ts";
import {
  inlineProofParticipation,
  publicInlineProofCohorts,
} from "../dashboard/inline-proof-telemetry.ts";

test("inline participation is durable, closed, revision-scoped and independent of legacy publication", () => {
  const storage = new MemoryDurableStorage();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const telemetry = new ExactReviewLifecycleTelemetryStore(storage);
  const now = Date.now();
  telemetry.syncBayRepositoryScope(new Set(["openclaw/openclaw"]), now);
  for (const [index, [proof, duration, legacy]] of (
    [
      ["requested", 120_000, false],
      ["requested", 240_000, false],
      ["not_requested", 60_000, false],
      ["unknown", 600_000, false],
      ["unknown", 900_000, true],
    ] as const
  ).entries()) {
    const key = "openclaw/openclaw#" + (900 + index);
    const identity = {
      canonicalTargetKey: key,
      fenceKey: legacy ? key + "@publish:1" : key,
      revision: 1,
    };
    lifecycle.recordAdmission({
      ...identity,
      deliveryId: key,
      sourceAction: "synchronize",
      commandOriginated: false,
      statusMarker: null,
      statusCommentId: null,
      triggeredAt: now,
      observedAt: now,
      ...(proof === "unknown" ? {} : { inlineProofTracked: true as const }),
    });
    if (proof === "requested") {
      storage.transactionSync(() => {
        const first = lifecycle.recordInlineProofRequestSync({ ...identity, observedAt: now + 1 });
        const changes = Array.from(storage.sql.exec("SELECT total_changes() AS total"))[0]!.total;
        const replay = lifecycle.recordInlineProofRequestSync({ ...identity, observedAt: now + 2 });
        assert.equal(replay?.updatedAt, first?.updatedAt);
        assert.equal(
          Array.from(storage.sql.exec("SELECT total_changes() AS total"))[0]!.total,
          changes,
          "a replay must not write or refresh lifecycle recency",
        );
      });
      lifecycle.recordTerminalDisposition({ ...identity, kind: "requeue", observedAt: now + 3 });
      assert.equal(
        new ExactReviewLifecycleProjectionStore(storage).read(key, identity.fenceKey, 1)
          ?.inlineProof,
        "requested",
      );
    }
    lifecycle.recordGithubEffect({
      ...identity,
      commentId: 9000 + index,
      digest: "a".repeat(64),
      observedAt: now + duration,
    });
    const terminal = lifecycle.recordTerminalDisposition({
      ...identity,
      kind: "review_completed_routed",
      observedAt: now + duration,
    });
    telemetry.syncBayLifecycle(terminal);
    telemetry.syncBayLifecycle(terminal);
    lifecycle.recordAdmission({
      ...identity,
      revision: 2,
      deliveryId: key + ":new",
      sourceAction: "synchronize",
      commandOriginated: false,
      statusMarker: null,
      statusCommentId: null,
      observedAt: now + duration + 1,
      inlineProofTracked: true,
    });
    assert.equal(lifecycle.read(key, identity.fenceKey, 2)?.inlineProof, "not_requested");
  }
  const timings = telemetry.baySnapshot(now + 1_000_000, new Set(["openclaw/openclaw"])).timings!;
  assert.equal(timings.overall.samples, 4);
  assert.deepEqual(timings.inline_proof?.requested.overall, {
    samples: 2,
    median_ms: 180_000,
    average_ms: 180_000,
  });
  assert.deepEqual(timings.inline_proof?.not_requested.overall, {
    samples: 1,
    median_ms: 60_000,
    average_ms: 60_000,
  });
  assert.equal(timings.inline_proof?.unknown.overall.samples, 1);
  assert.equal(timings.including_legacy_batch.inline_proof?.unknown.overall.samples, 2);
  assert.ok(publicInlineProofCohorts(timings.inline_proof, 4));
  assert.equal(publicInlineProofCohorts(timings.inline_proof, 3), null);
  assert.equal(inlineProofParticipation(false), "unknown");
  assert.equal(inlineProofParticipation("completed"), "unknown");
  const tainted = { ...timings.inline_proof, proofPlan: "PRIVATE_PLAN", requestId: "PRIVATE_ID" };
  const clean = publicInlineProofCohorts(tainted, 4)!;
  assert.equal(JSON.stringify(clean).includes("PRIVATE"), false);
  assert.equal(clean.requested.overall.samples, 2);
});

for (const scenario of [
  "requested",
  "not_requested",
  "legacy_requested",
  "historical",
  "wrong_generation",
  "newer_claim",
  "cancelled",
  "command_mismatch",
  "missing_producer",
  "competing_child",
  "malformed_sibling",
  "malformed_other_target",
  "malformed_event",
  "malformed_producer",
  "malformed_claim_entries",
  "malformed_result_entries",
  "valid_json_corrupt_event",
  "wrong_event_identity",
  "valid_json_corrupt_producer",
  "invalid_claim_metadata",
  "incomplete_lineage_sibling",
  "invalid_other_generation_sibling",
] as const) {
  test("linked publication inline participation: " + scenario, () => {
    const storage = new MemoryDurableStorage();
    const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
    const telemetry = new ExactReviewLifecycleTelemetryStore(storage);
    const now = Date.now();
    telemetry.syncBayRepositoryScope(new Set(["openclaw/openclaw"]), now);
    const producer = {
      canonicalTargetKey: "openclaw/openclaw#95100",
      fenceKey: "openclaw/openclaw#95100",
      revision: 2,
    };
    const publication = { ...producer, fenceKey: producer.fenceKey + "@publish:1", revision: 1 };
    const common = {
      sourceAction: "synchronize",
      commandOriginated: false,
      statusMarker: null,
      statusCommentId: null,
      triggeredAt: now,
      observedAt: now,
    };
    lifecycle.recordAdmission({
      ...producer,
      ...common,
      deliveryId: "producer",
      ...(scenario === "historical" ? {} : { inlineProofTracked: true as const }),
    });
    if (scenario !== "not_requested" && scenario !== "historical")
      storage.transactionSync(() =>
        lifecycle.recordInlineProofRequestSync({ ...producer, observedAt: now }),
      );
    lifecycle.recordClaim({
      ...producer,
      claimGeneration: 4,
      runId: "123",
      runAttempt: 1,
      observedAt: now,
    });
    lifecycle.recordReviewResult({
      ...producer,
      claimGeneration: 4,
      runId: "123",
      runAttempt: 1,
      outcome: scenario === "cancelled" ? "cancelled" : "completed",
      observedAt: now + 1000,
    });
    if (scenario === "newer_claim")
      lifecycle.recordClaim({
        ...producer,
        claimGeneration: 5,
        runId: "124",
        runAttempt: 1,
        observedAt: now + 2000,
      });
    lifecycle.recordAdmission({
      ...publication,
      ...common,
      deliveryId: "publication",
      ...(scenario === "command_mismatch" ? { statusMarker: "different-command" } : {}),
    });
    // Persist the additive producer-lineage shape shipped on main after the UI base.
    storage.sql.exec(
      "UPDATE exact_review_lifecycle_projection_v1 SET projection_json = json_set(projection_json, '$.producerLineage', json(?)) WHERE fence_key = ?",
      JSON.stringify({
        fenceKey: producer.fenceKey,
        revision: producer.revision,
        claimGeneration: scenario === "wrong_generation" ? 3 : 4,
      }),
      publication.fenceKey,
    );
    if (scenario === "competing_child") {
      const competitor = { ...publication, fenceKey: publication.fenceKey + ":competing" };
      lifecycle.recordAdmission({ ...competitor, ...common, deliveryId: "competing-publication" });
      storage.sql.exec(
        "UPDATE exact_review_lifecycle_projection_v1 SET projection_json = json_set(projection_json, '$.producerLineage', json(?)) WHERE fence_key = ?",
        JSON.stringify({
          fenceKey: producer.fenceKey,
          revision: producer.revision,
          claimGeneration: 4,
        }),
        competitor.fenceKey,
      );
      lifecycle.recordGithubEffect({
        ...competitor,
        commentId: 7001,
        digest: "c".repeat(64),
        observedAt: now + 60000,
      });
      telemetry.recordDirectOutcome({
        ...competitor,
        claimGeneration: 1,
        outcome: "accepted",
        observedAt: now + 60000,
      });
      telemetry.syncBayLifecycle(
        lifecycle.recordTerminalDisposition({
          ...competitor,
          kind: "review_completed_routed",
          observedAt: now + 60000,
        }),
      );
    }
    lifecycle.recordGithubEffect({
      ...publication,
      commentId: 7000,
      digest: "b".repeat(64),
      observedAt: now + 60000,
    });
    if (scenario !== "legacy_requested")
      telemetry.recordDirectOutcome({
        ...publication,
        claimGeneration: 1,
        outcome: "accepted",
        observedAt: now + 60000,
      });
    telemetry.syncBayLifecycle(
      lifecycle.recordTerminalDisposition({
        ...publication,
        kind: "review_completed_routed",
        observedAt: now + 60000,
      }),
    );
    if (scenario === "missing_producer")
      storage.sql.exec(
        "DELETE FROM exact_review_lifecycle_projection_v1 WHERE fence_key = ?",
        producer.fenceKey,
      );
    if (scenario === "malformed_sibling" || scenario === "malformed_other_target") {
      storage.sql.exec(
        "INSERT INTO exact_review_lifecycle_projection_v1 (canonical_target_key, fence_key, revision, projection_json, updated_at) VALUES (?, ?, 1, ?, ?)",
        scenario === "malformed_sibling" ? producer.canonicalTargetKey : "openclaw/openclaw#95101",
        "malformed-publisher",
        "{not-json",
        now,
      );
    }
    if (scenario === "malformed_event" || scenario === "malformed_producer") {
      storage.sql.exec(
        "UPDATE exact_review_lifecycle_projection_v1 SET projection_json = ? WHERE fence_key = ?",
        "{not-json",
        scenario === "malformed_event" ? publication.fenceKey : producer.fenceKey,
      );
    }
    if (scenario === "malformed_claim_entries" || scenario === "malformed_result_entries") {
      const field = scenario === "malformed_claim_entries" ? "claims" : "reviewResults";
      storage.sql.exec(
        "UPDATE exact_review_lifecycle_projection_v1 SET projection_json = json_set(projection_json, ?, json(?)) WHERE fence_key = ?",
        "$." + field,
        JSON.stringify(["not an object"]),
        producer.fenceKey,
      );
    }
    if (scenario === "valid_json_corrupt_event") {
      storage.sql.exec(
        "UPDATE exact_review_lifecycle_projection_v1 SET projection_json = ? WHERE fence_key = ?",
        JSON.stringify({ inlineProof: "requested" }),
        publication.fenceKey,
      );
    }
    if (
      ["wrong_event_identity", "valid_json_corrupt_producer", "invalid_claim_metadata"].includes(
        scenario,
      )
    ) {
      const key = scenario === "wrong_event_identity" ? publication.fenceKey : producer.fenceKey;
      const original = JSON.parse(
        String(
          Array.from(
            storage.sql.exec(
              "SELECT projection_json FROM exact_review_lifecycle_projection_v1 WHERE fence_key = ?",
              key,
            ),
          )[0]!.projection_json,
        ),
      );
      if (scenario === "wrong_event_identity") original.revision += 1;
      else if (scenario === "valid_json_corrupt_producer") delete original.version;
      else delete original.claims[0].runId;
      storage.sql.exec(
        "UPDATE exact_review_lifecycle_projection_v1 SET projection_json = ? WHERE fence_key = ?",
        JSON.stringify(original),
        key,
      );
    }
    if (
      scenario === "incomplete_lineage_sibling" ||
      scenario === "invalid_other_generation_sibling"
    ) {
      storage.sql.exec(
        "INSERT INTO exact_review_lifecycle_projection_v1 (canonical_target_key, fence_key, revision, projection_json, updated_at) VALUES (?, ?, 1, ?, ?)",
        producer.canonicalTargetKey,
        "invalid-lineage-sibling",
        JSON.stringify({
          producerLineage: {
            fenceKey: producer.fenceKey,
            revision: producer.revision,
            ...(scenario === "invalid_other_generation_sibling" ? { claimGeneration: 5 } : {}),
          },
        }),
        now,
      );
    }
    const expected =
      scenario === "requested" ||
      scenario === "legacy_requested" ||
      scenario === "malformed_other_target"
        ? "requested"
        : scenario === "not_requested"
          ? "not_requested"
          : "unknown";
    const timings = telemetry.baySnapshot(now + 120000, new Set(["openclaw/openclaw"])).timings!;
    const samples = scenario === "competing_child" ? 2 : 1;
    assert.equal(timings.including_legacy_batch.inline_proof![expected].overall.samples, samples);
    assert.equal(timings.overall.samples, scenario === "legacy_requested" ? 0 : samples);
    assert.equal(timings.including_legacy_batch.overall.samples, samples);
  });
}

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
