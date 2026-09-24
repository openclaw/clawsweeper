import assert from "node:assert/strict";
import test from "node:test";
import {
  ExactReviewQueue,
  type ExactReviewQueueItem,
  type ExactReviewQueueState,
} from "../dashboard/exact-review-queue.ts";
import type { ExactReviewDecision } from "../dashboard/exact-review-decision.ts";
import { ExactReviewLifecycleProjectionStore } from "../dashboard/exact-review-lifecycle.ts";
import {
  exactReviewParkedOperatorEligible,
  exactReviewParkedRecoveryAt,
  exactReviewQueueBayProjection,
} from "../dashboard/exact-review-read-model.ts";
import { TestStorage } from "./exact-review-test-storage.ts";

const key = "openclaw/openclaw#42";
const head = "a".repeat(40);

async function fixture(overrides: Partial<ExactReviewDecision> = {}, newer = false) {
  const storage = new TestStorage();
  const now = Date.now();
  const decision: ExactReviewDecision = {
    targetRepo: "openclaw/openclaw",
    targetBranch: "main",
    itemNumber: 42,
    itemKind: "pull_request",
    sourceEvent: "pull_request",
    sourceAction: "opened",
    supersedesInProgress: false,
    sourceHeadSha: head,
    sourceHeadVerified: true,
    sourceBaseSha: "b".repeat(40),
    sourceContentRevision: "c".repeat(64),
    sourceUpdatedAt: "2026-09-24T00:00:00Z",
    ...overrides,
  };
  const item: ExactReviewQueueItem = {
    key,
    decision: newer ? { ...decision, sourceHeadSha: "d".repeat(40) } : decision,
    leaseDecision: { ...decision },
    state: "leased",
    revision: newer ? 2 : 1,
    createdAt: now - 60_000,
    updatedAt: now - 60_000,
    nextAttemptAt: now - 60_000,
    attempts: 0,
    leaseId: "lease-42",
    leaseRevision: 1,
    leaseExpiresAt: now + 3_600_000,
    claimedRunId: "4242",
    claimedRunAttempt: 1,
    claimGeneration: 1,
    claimProtocolVersion: 2,
  };
  await storage.put("exact-review-queue", { items: { [key]: item } });
  const queue = new ExactReviewQueue(
    { storage },
    { hostedTargetPredicate: () => true, hostedPublicTargetProbe: async () => "public" },
  );
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  lifecycle.recordAdmission({
    canonicalTargetKey: key,
    fenceKey: key,
    revision: 1,
    deliveryId: "original-delivery",
    sourceAction: "opened",
    commandOriginated: false,
    statusMarker: null,
    statusCommentId: null,
    observedAt: now - 60_000,
  });
  const post = async (path: string, body: unknown) => {
    const response = await queue.fetch(
      new Request(`https://queue${path}`, { method: "POST", body: JSON.stringify(body) }),
    );
    const result = await response.json();
    assert.ok(response.ok, JSON.stringify(result));
    return result;
  };
  return {
    storage,
    queue,
    lifecycle,
    decision,
    post,
    state: async () => (await storage.get("exact-review-queue")) as ExactReviewQueueState,
    complete: (reason = "source_incompatible") =>
      post("/complete", {
        lease_id: "lease-42",
        item_key: key,
        lease_revision: 1,
        claim_generation: 1,
        run_id: "4242",
        run_attempt: 1,
        outcome: "failure",
        review_failure_reason: reason,
      }),
  };
}

test("pinned incompatible PR survives restart and dedupes both scheduled lanes", async () => {
  const h = await fixture();
  assert.deepEqual(await h.complete(), { ok: true, requeued: false });
  const stopped = (await h.state()).items[key];
  assert.equal(stopped.state, "parked");
  assert.equal(stopped.parkedReason, "source_incompatible");
  assert.equal(stopped.leaseId, undefined);
  assert.equal(exactReviewParkedRecoveryAt(stopped), null);
  assert.equal(exactReviewParkedOperatorEligible(stopped), true);
  assert.equal(h.lifecycle.read(key, key, 1)?.terminalDisposition?.kind, "failure");
  assert.deepEqual(exactReviewQueueBayProjection([stopped]).items?.[0]?.review_failure, {
    stage: "source_preparation",
    reason: "source_incompatible",
  });
  const restarted = new ExactReviewQueue(
    { storage: h.storage },
    { hostedTargetPredicate: () => true, hostedPublicTargetProbe: async () => "public" },
  );
  for (const sourceAction of ["scheduled_hot_intake", "scheduled_normal_backfill"]) {
    const request = () =>
      new Request("https://queue/enqueue", {
        method: "POST",
        headers: { "x-clawsweeper-exact-review-body-sha256": "f".repeat(64) },
        body: JSON.stringify({
          delivery_id: sourceAction,
          decision: { ...h.decision, sourceAction },
        }),
      });
    const response = await restarted.fetch(request());
    const result = await response.json();
    assert.equal(response.status, 202);
    assert.equal(result.deduped, true);
    assert.equal(result.dedupe_reason, "source_incompatible");
    assert.deepEqual(await (await restarted.fetch(request())).json(), result);
  }
  assert.equal((await h.state()).items[key].revision, 1);
});

test("fresh source reconciliation preserves head, base and body recovery", async () => {
  for (const change of [
    { source_head_sha: "d".repeat(40) },
    { source_base_sha: "e".repeat(40) },
    { source_content_revision: "f".repeat(64) },
  ]) {
    const h = await fixture();
    await h.complete();
    const inventory = await h.post("/parked-reviews/list", { limit: 10 });
    assert.equal(inventory.parked_reviews.length, 1);
    const item = inventory.parked_reviews[0];
    const unchanged = await h.post("/parked-reviews/recover-fresh", {
      idempotency_key: "unchanged",
      items: [item],
    });
    assert.equal(unchanged.unchanged, 1);
    assert.equal((await h.state()).items[key].state, "parked");
    const changed = await h.post("/parked-reviews/recover-fresh", {
      idempotency_key: "changed",
      items: [{ ...item, ...change }],
    });
    assert.equal(changed.recovered, 1);
    assert.equal((await h.state()).items[key].state, "pending");
  }
});

test("explicit re-review and newer in-flight source keep their normal paths", async () => {
  const h = await fixture();
  await h.complete();
  const commandDecision = { ...h.decision };
  delete commandDecision.sourceHeadSha;
  delete commandDecision.sourceHeadVerified;
  const response = await h.post("/enqueue", {
    delivery_id: "maintainer-rereview",
    decision: {
      ...commandDecision,
      sourceAction: "re_review_command",
      commandStatusMarker: "<!-- clawsweeper-command-status:42:re_review:fixture -->",
      statusCommentId: 4200,
      additionalPrompt: "Review this revision again.",
    },
  });
  assert.equal(response.queued, true);
  assert.equal((await h.state()).items[key].state, "pending");
  const newer = await fixture({}, true);
  assert.deepEqual(await newer.complete(), { ok: true, requeued: true });
  assert.equal((await newer.state()).items[key].revision, 2);
  assert.equal((await newer.state()).items[key].state, "pending");
});

test("retained stops use existing closed-target cleanup and survive telemetry failure", async () => {
  const h = await fixture();
  Reflect.set(h.queue, "reviewFailureTelemetryStore", {
    recordSync() {
      throw new Error("fixture telemetry unavailable");
    },
    recordDropSync() {},
  });
  await h.complete();
  assert.equal((await h.state()).items[key].parkedReason, "source_incompatible");
  const inventory = await h.post("/parked-reviews/list", { limit: 10 });
  assert.deepEqual(
    await h.post("/parked-reviews/resolve", {
      items: inventory.parked_reviews,
      note: "automatic reconciliation: terminal test target",
    }),
    { ok: true, resolved: 1, skipped: 0 },
  );
  assert.equal((await h.state()).items[key], undefined);
});

test("only identified pinned PR incompatibility creates a retained stop", async () => {
  for (const overrides of [
    { itemKind: "issue", sourceEvent: "issues" },
    { sourceHeadSha: undefined },
    { commandStatusMarker: "<!-- clawsweeper-command-status:42:re_review:fixture -->" },
  ] satisfies Array<Partial<ExactReviewDecision>>) {
    const h = await fixture(overrides);
    await h.complete();
    assert.equal((await h.state()).items[key], undefined);
  }
  for (const reason of ["scanner_unavailable", "scanner_failed", "deadline", "findings"]) {
    const h = await fixture();
    await h.complete(reason);
    assert.equal((await h.state()).items[key], undefined);
  }
});
