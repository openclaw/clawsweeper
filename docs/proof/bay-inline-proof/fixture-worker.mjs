// LOCAL PROOF ONLY. Never deploy this fixture entrypoint.
import productionWorker, { StatusStore } from "../../../dashboard/worker.ts";
import { ExactReviewQueue } from "../../../dashboard/exact-review-queue.ts";
import { ExactReviewLifecycleProjectionStore } from "../../../dashboard/exact-review-lifecycle.ts";
import { ExactReviewLifecycleTelemetryStore } from "../../../dashboard/exact-review-lifecycle-telemetry.ts";
export { StatusStore };
export class InlineProofFixtureQueue {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = { ...env, hostedTargetPredicate: () => true, hostedPublicTargetProbe: async () => "public" };
    this.queue = new ExactReviewQueue(ctx, this.env);
  }
  async alarm() { /* Fixture runs no dispatch or external producer. */ }
  async fetch(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/fixture/")) return this.queue.fetch(request);
    const body = await request.json();
    const post = (route, value) => this.queue.fetch(new Request("https://queue" + route, { method: "POST", body: JSON.stringify(value) }));
    const storage = this.ctx.storage;
    if (url.pathname === "/fixture/proof") {
      const response = await post("/review-proof", body);
      if (!response.ok) return response;
      const data = await response.json();
      const projection = new ExactReviewLifecycleProjectionStore(storage).read(body.lease.itemKey, body.lease.itemKey, body.lease.leaseRevision);
      return Response.json({ ...data, participationUpdatedAt: projection?.updatedAt ?? null });
    }
    if (url.pathname === "/fixture/incomplete-lineage") {
      const key = "openclaw/openclaw#" + body.number, fence = key + "@publish:incomplete-fixture";
      if (body.remove) storage.sql.exec("DELETE FROM exact_review_lifecycle_projection_v1 WHERE canonical_target_key = ? AND fence_key = ?", key, fence);
      else {
        const source = JSON.parse([...storage.sql.exec("SELECT projection_json FROM exact_review_lifecycle_projection_v1 WHERE canonical_target_key = ? AND fence_key = ?", key, key + "@publish:fixture")][0].projection_json);
        storage.sql.exec("INSERT INTO exact_review_lifecycle_projection_v1 (canonical_target_key, fence_key, revision, projection_json, updated_at) VALUES (?, ?, 1, ?, ?)", key, fence, JSON.stringify({ producerLineage: { fenceKey: source.producerLineage.fenceKey, revision: source.producerLineage.revision } }), Date.now());
      }
      this.queue = new ExactReviewQueue(this.ctx, this.env);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/fixture/admit") {
      const number = body.number;
      const key = "openclaw/openclaw#" + number;
      const now = Date.now();
      const decision = { targetRepo: "openclaw/openclaw", targetBranch: "main", itemNumber: number, itemKind: "pull_request", sourceEvent: "pull_request", sourceAction: "synchronize", sourceHeadSha: "a".repeat(40), sourceUpdatedAt: new Date(now - body.duration).toISOString(), supersedesInProgress: true };
      const response = await post("/enqueue", { delivery_id: "fixture-" + number, decision });
      if (!response.ok) return response;
      const row = [...storage.sql.exec("SELECT item_json FROM exact_review_queue_items WHERE item_key = ?", key)][0];
      if (!row) throw new Error("fixture admission missing: " + await response.text());
      const item = JSON.parse(row.item_json);
      Object.assign(item, { state: "leased", leasePhase: "review", leaseDecision: decision, leaseId: "fixture-lease-" + number, leaseRevision: item.revision, leaseExpiresAt: now + 3600000, claimedRunId: String(number), claimedRunAttempt: 1, claimGeneration: 1, claimProtocolVersion: 2 });
      storage.sql.exec("UPDATE exact_review_queue_items SET item_json = ? WHERE item_key = ?", JSON.stringify(item), key);
      for (const table of ["exact_review_lifecycle_bay_meta_v2", "exact_review_lifecycle_bay_scope_v2"]) storage.sql.exec("UPDATE " + table + " SET coverage_started_at = ?", now - 7200000);
      storage.sql.exec("UPDATE exact_review_lifecycle_bay_scope_v2 SET trigger_coverage_started_at = NULL");
      return Response.json({ lease: { itemKey: key, leaseId: item.leaseId, leaseRevision: item.revision, claimGeneration: 1, runId: String(number), runAttempt: 1, sourceHeadSha: decision.sourceHeadSha } });
    }
    if (url.pathname === "/fixture/retry") {
      const lease = body.lease;
      const response = await post("/complete", { item_key: lease.itemKey, lease_id: lease.leaseId, lease_revision: lease.leaseRevision, claim_generation: lease.claimGeneration, run_id: lease.runId, run_attempt: lease.runAttempt, outcome: "failure" });
      if (!response.ok) return response;
      const item = JSON.parse([...storage.sql.exec("SELECT item_json FROM exact_review_queue_items WHERE item_key = ?", lease.itemKey)][0].item_json);
      return Response.json({ state: item.state, privateRequestsCleared: item.reviewProofRequests === undefined, leaseCleared: item.leaseId === undefined, participation: new ExactReviewLifecycleProjectionStore(storage).read(lease.itemKey, lease.itemKey, lease.leaseRevision)?.inlineProof });
    }
    if (url.pathname === "/fixture/corrupt") {
      const key = "openclaw/openclaw#" + body.number;
      storage.sql.exec("UPDATE exact_review_lifecycle_projection_v1 SET projection_json = ? WHERE canonical_target_key = ? AND fence_key = ?", body.shape ? JSON.stringify({ inlineProof: "requested" }) : "{not-json", key, key);
      this.queue = new ExactReviewQueue(this.ctx, this.env);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/fixture/malformed") {
      const key = "openclaw/openclaw#" + body.number;
      storage.sql.exec("INSERT INTO exact_review_lifecycle_projection_v1 (canonical_target_key, fence_key, revision, projection_json, updated_at) VALUES (?, ?, 1, ?, ?)", key, key + "@publish:malformed", "{not-json", Date.now());
      this.queue = new ExactReviewQueue(this.ctx, this.env);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/fixture/compete") {
      const key = "openclaw/openclaw#" + body.number;
      const source = JSON.parse([...storage.sql.exec("SELECT projection_json FROM exact_review_lifecycle_projection_v1 WHERE canonical_target_key = ? AND fence_key = ?", key, key + "@publish:fixture")][0].projection_json);
      const sibling = { canonicalTargetKey: key, fenceKey: key + "@publish:competing", revision: 1 };
      new ExactReviewLifecycleProjectionStore(storage).recordAdmission({ ...sibling, deliveryId: "competing-fixture", sourceAction: "synchronize", commandOriginated: source.admission.commandOriginated, statusMarker: source.admission.statusMarker, statusCommentId: source.admission.statusCommentId, observedAt: Date.now() });
      storage.sql.exec("UPDATE exact_review_lifecycle_projection_v1 SET projection_json = json_set(projection_json, '$.producerLineage', json(?)) WHERE fence_key = ?", JSON.stringify(source.producerLineage), sibling.fenceKey);
      this.queue = new ExactReviewQueue(this.ctx, this.env);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/fixture/finalize") {
      const key = "openclaw/openclaw#" + body.number;
      const row = [...storage.sql.exec("SELECT item_json FROM exact_review_queue_items WHERE item_key = ?", key)][0];
      const item = JSON.parse(row.item_json);
      const sourceIdentity = { canonicalTargetKey: key, fenceKey: key, revision: item.leaseRevision ?? item.revision };
      let identity = sourceIdentity;
      const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
      if (body.historical) {
        // Model an old durable projection whose request collection was never tracked.
        storage.sql.exec("UPDATE exact_review_lifecycle_projection_v1 SET projection_json = json_remove(projection_json, '$.inlineProof') WHERE canonical_target_key = ?", key);
      }
      const completedAt = Date.parse(item.decision.sourceUpdatedAt) + body.duration;
      if (body.linked) {
        lifecycle.recordClaim({ ...sourceIdentity, claimGeneration: 1, runId: String(body.number), runAttempt: 1, observedAt: completedAt });
        lifecycle.recordReviewResult({ ...sourceIdentity, claimGeneration: 1, runId: String(body.number), runAttempt: 1, outcome: "completed", observedAt: completedAt });
        identity = { ...sourceIdentity, fenceKey: key + "@publish:fixture", revision: 1 };
        lifecycle.recordAdmission({ ...identity, deliveryId: "fixture-publication-" + body.number, sourceAction: "synchronize", commandOriginated: false, statusMarker: null, statusCommentId: null, triggeredAt: Date.parse(item.decision.sourceUpdatedAt), observedAt: completedAt, producerLineage: { fenceKey: key, revision: sourceIdentity.revision, claimGeneration: 1 } });
        storage.sql.exec("UPDATE exact_review_lifecycle_projection_v1 SET projection_json = json_set(projection_json, '$.producerLineage', json(?)) WHERE fence_key = ?", JSON.stringify({ fenceKey: key, revision: sourceIdentity.revision, claimGeneration: 1 }), identity.fenceKey);
        if (!body.legacy) new ExactReviewLifecycleTelemetryStore(storage).recordDirectOutcome({ ...identity, claimGeneration: 1, outcome: "accepted", observedAt: completedAt });
      }
      lifecycle.recordGithubEffect({ ...identity, commentId: body.number + 100000, digest: "a".repeat(64), observedAt: completedAt });
      lifecycle.recordRouterReceipt({ ...identity, outcome: "not_required", receiptId: "fixture-router-" + body.number, observedAt: completedAt });
      const terminal = lifecycle.recordTerminalDisposition({ ...identity, kind: "review_completed_routed", observedAt: completedAt });
      const telemetry = new ExactReviewLifecycleTelemetryStore(storage);
      telemetry.syncBayLifecycle(terminal);
      telemetry.syncBayLifecycle(terminal); // Receipt replay must not double the sample.
      if (body.legacy) storage.sql.exec("UPDATE exact_review_lifecycle_bay_event_v2 SET legacy_batch_path = 1 WHERE canonical_target_key = ?", key);
      // Remove the entire leased item, as finalization does. Only durable rollup remains.
      storage.sql.exec("DELETE FROM exact_review_queue_items WHERE item_key = ?", key);
      this.queue = new ExactReviewQueue(this.ctx, this.env);
      return Response.json({ participation: lifecycle.read(key, key, sourceIdentity.revision)?.inlineProof ?? "unknown" });
    }
    return new Response("unknown fixture", { status: 404 });
  }
}
export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname.startsWith("/fixture/")) return env.EXACT_REVIEW_QUEUE.get(env.EXACT_REVIEW_QUEUE.idFromName("global")).fetch(request);
    return productionWorker.fetch(request, env, ctx);
  },
};
