import {
  assert,
  test,
  ExactReviewQueue,
  ExactReviewLifecycleProjectionStore,
  ExactReviewPublicationBatchStore,
  MemoryDurableStorage,
  leasedExactReviewPublicationItem,
} from "./dashboard-worker-harness.ts";

for (const scenario of [
  { committed: "policy_noop", requested: "target_closed", expected: "policy_noop" },
  { committed: "policy_noop", requested: "superseded", expected: "policy_noop", batch: true },
  {
    committed: "review_completed_routed",
    requested: "failure",
    expected: "review_completed_routed",
  },
  { committed: "superseded", requested: "target_closed", expected: "superseded", command: true },
  { committed: "dead_letter", requested: "failure", expected: "dead_letter" },
  { committed: "requeue", requested: "target_closed", expected: "target_closed" },
  { committed: null, requested: "target_closed", expected: "target_closed" },
  { committed: "review_completed_routed", requested: "requeue", expected: "requeue" },
] as const) {
  test(`completion preserves ${scenario.committed ?? "uncommitted"} with ${scenario.requested}`, async () => {
    const storage = new MemoryDurableStorage();
    const item = leasedExactReviewPublicationItem(980, "9800");
    const command = "command" in scenario;
    const batch = "batch" in scenario;
    if (batch) item.state = "pending";
    if (command) {
      for (const decision of [item.decision, item.leaseDecision!]) {
        Object.assign(decision.publication.producerDecision, {
          commandStatusMarker: "<!-- clawsweeper-command-status:980:re_review:test -->",
          statusCommentId: 980,
        });
      }
    }
    await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
    const queue = new ExactReviewQueue({ storage }, {});
    const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
    const identity = {
      canonicalTargetKey: "openclaw/openclaw#980",
      fenceKey: item.key,
      revision: 1,
    };
    lifecycle.recordAdmission({
      ...identity,
      deliveryId: "completion-proof",
      sourceAction: "opened",
      commandOriginated: command,
      statusMarker: command ? "<!-- clawsweeper-command-status:980:re_review:test -->" : null,
      statusCommentId: command ? 980 : null,
      observedAt: Date.now(),
    });
    if (scenario.committed) {
      lifecycle.recordTerminalDisposition({
        ...identity,
        kind: scenario.committed,
        observedAt: Date.now(),
      });
    }
    const before = lifecycle.read(identity.canonicalTargetKey, item.key, 1)!;
    if (batch) {
      const batches = new ExactReviewPublicationBatchStore(storage);
      batches.ensureSchemaSync();
      assert.ok(
        batches.claim({
          batchId: "terminal-proof",
          leaseOwner: "proof-worker",
          now: Date.now(),
          leaseExpiresAt: Date.now() + 60_000,
          maxItems: 1,
          candidates: [{ itemKey: item.key, revision: 1 }],
        }),
      );
    }
    const response = await queue.fetch(
      new Request(`https://queue/${batch ? "publication-batches/complete" : "complete"}`, {
        method: "POST",
        body: JSON.stringify(
          batch
            ? {
                batch_id: "terminal-proof",
                lease_owner: "proof-worker",
                items: [
                  {
                    item_key: item.key,
                    revision: 1,
                    claim_generation: 1,
                    terminal_outcome: "superseded",
                  },
                ],
              }
            : {
                item_key: item.key,
                lease_id: item.leaseId,
                lease_revision: 1,
                claim_generation: 1,
                run_id: "9800",
                run_attempt: 1,
                outcome: "success",
                completion_kind: "superseded",
                reason_code: "remote_closed",
                lifecycle_terminal_disposition: scenario.requested,
                ...(scenario.requested === "requeue" ? { requeue_latest: true } : {}),
              },
        ),
      }),
    );
    assert.equal(response.status, 200);
    const projection = lifecycle.read(identity.canonicalTargetKey, item.key, 1)!;
    assert.equal(projection.terminalDisposition?.kind, scenario.expected);
    if (scenario.expected === scenario.committed) {
      assert.deepEqual(projection.terminalDispositions, before.terminalDispositions);
    }
    assert.deepEqual(
      projection.reviewResults.map((result) => result.outcome),
      batch ? [] : ["completed"],
    );
    const state = (await storage.get("exact-review-queue")) as {
      items: Record<string, typeof item & { terminalFinalization?: { disposition: string } }>;
    };
    if (command) {
      assert.deepEqual(
        Object.values(state.items)
          .filter((entry) => entry.terminalFinalization)
          .map((entry) => entry.terminalFinalization?.disposition),
        [scenario.expected],
      );
    } else if (scenario.expected !== "requeue") {
      assert.equal(state.items[item.key], undefined);
    }
  });
}
