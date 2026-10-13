import assert from "node:assert/strict";
import test from "node:test";
import {
  ExactReviewLifecycleProjectionStore,
  MemoryDurableStorage,
} from "./dashboard-worker-harness.ts";
import { inlineProofParticipation } from "../dashboard/inline-proof-telemetry.ts";

test("inline participation is durable, closed, revision-scoped and independent of legacy publication", () => {
  const storage = new MemoryDurableStorage();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const now = Date.now();
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
    lifecycle.recordTerminalDisposition({
      ...identity,
      kind: "review_completed_routed",
      observedAt: now + duration,
    });
    assert.equal(
      new ExactReviewLifecycleProjectionStore(storage).read(key, identity.fenceKey, 1)?.inlineProof,
      proof === "unknown" ? undefined : proof,
    );
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
  assert.equal(inlineProofParticipation(false), "unknown");
  assert.equal(inlineProofParticipation("completed"), "unknown");
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
