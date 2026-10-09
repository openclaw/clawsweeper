import {
  assert,
  createHmac,
  test,
  ExactReviewQueue,
  MemoryDurableStorage,
  MemoryDurableNamespace,
  worker,
} from "./dashboard-worker-harness.ts";

const secret = "test-clawsweeper-webhook-secret";

for (const route of ["enqueue", "branch-authority", "source-authority"]) {
  test(`signed ${route} intake rejects a target repository that is not a slug`, async () => {
    const storage = new MemoryDurableStorage();
    const queue = new ExactReviewQueue({ storage }, {});
    // A newline is not a valid header value, so the Worker must stop before it builds headers.
    const body = JSON.stringify({
      delivery_id: `invalid-target-repo:${route}`,
      installation_id: 123,
      decision: {
        targetRepo: "openclaw/openclaw\nother/repo",
        targetBranch: "main",
        itemNumber: 597,
        itemKind: "issue",
        sourceEvent: "issues",
        sourceAction: "legacy_dispatch",
        supersedesInProgress: false,
      },
    });
    const response = await worker.fetch(
      new Request(`https://clawsweeper.openclaw.ai/internal/exact-review/${route}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-clawsweeper-exact-review-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
        },
        body,
      }),
      {
        CLAWSWEEPER_WEBHOOK_SECRET: secret,
        EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
      },
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_target_repo" });
    const stored = (await storage.get("exact-review-queue")) as { items: Record<string, unknown> };
    assert.deepEqual(stored.items, {});
  });
}
