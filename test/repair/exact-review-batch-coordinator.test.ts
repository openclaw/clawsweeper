import assert from "node:assert/strict";
import test from "node:test";

import { coordinateExactReviewBatch } from "../../dist/repair/exact-review-batch-coordinator.js";
import {
  ExactReviewBatchQueueClient,
  verifyExactReviewBatchSignature,
} from "../../dist/repair/exact-review-batch-queue-client.js";

const queueItems = [1, 2, 3].map((number) => ({
  itemKey: `openclaw/openclaw#${number}`,
  revision: 1,
  claimGeneration: 1,
  decision: { itemNumber: number },
}));

test("coordinator heartbeats, isolates mixed outcomes, and acknowledges terminal members", async () => {
  const completed: unknown[] = [];
  let heartbeats = 0;
  let commits = 0;
  const result = await coordinateExactReviewBatch(
    { claimId: "claim-1", leaseOwner: "run-1", maxItems: 3, heartbeatIntervalMs: 60_000 },
    {
      queue: fakeQueue({
        heartbeat: () => {
          heartbeats += 1;
        },
        complete: (input) => completed.push(input),
      }),
      async prepare(item) {
        if (item.itemKey.endsWith("#1")) {
          return { kind: "retryable", reason: "artifact_unavailable" };
        }
        if (item.itemKey.endsWith("#2")) return { kind: "superseded" };
        return { kind: "eligible", plan: plan(item) };
      },
      async deliverGithubEffects() {
        return "ready";
      },
      async commit(batchId, plans) {
        commits += 1;
        assert.equal(batchId, "claim-1");
        assert.equal(plans.length, 1);
        return { commitSha: "a".repeat(40) };
      },
    },
  );

  assert.equal(result.kind, "claimed");
  assert.equal(commits, 1);
  assert.ok(heartbeats >= 6);
  assert.equal(completed.length, 1);
  assert.deepEqual(
    result.kind === "claimed"
      ? result.publication.completions.map((item) => item.terminalOutcome).sort()
      : [],
    ["published", "superseded"],
  );
});

test("acknowledgement timeout reruns the same stable batch without duplicate completion", async () => {
  let attempts = 0;
  const commitBatchIds: string[] = [];
  const queue = fakeQueue({
    complete() {
      attempts += 1;
      if (attempts === 1) throw new Error("ack timeout");
    },
  });
  const dependencies = {
    queue,
    async prepare(item: (typeof queueItems)[number]) {
      return { kind: "eligible" as const, plan: plan(item) };
    },
    async deliverGithubEffects() {
      return "ready" as const;
    },
    async commit(batchId: string) {
      commitBatchIds.push(batchId);
      return { commitSha: "b".repeat(40) };
    },
  };

  await assert.rejects(
    coordinateExactReviewBatch(
      { claimId: "claim-1", leaseOwner: "run-1", maxItems: 3 },
      dependencies,
    ),
    /ack timeout/,
  );
  const recovered = await coordinateExactReviewBatch(
    { claimId: "claim-1", leaseOwner: "run-1", maxItems: 3 },
    dependencies,
  );
  assert.equal(recovered.kind, "claimed");
  assert.deepEqual(commitBatchIds, ["claim-1", "claim-1"]);
  assert.equal(attempts, 2);
});

test("queue client signs protocol calls and rejects malformed responses", async () => {
  const paths: string[] = [];
  const bodies: unknown[] = [];
  const client = new ExactReviewBatchQueueClient({
    baseUrl: "https://queue.example",
    webhookSecret: "secret",
    fetch: async (input, init) => {
      const url = String(input);
      paths.push(new URL(url).pathname);
      const body = String(init?.body);
      bodies.push(JSON.parse(body));
      const signature = String(
        new Headers(init?.headers).get("x-clawsweeper-exact-review-signature"),
      );
      assert.equal(verifyExactReviewBatchSignature(body, signature, "secret"), true);
      return new Response(
        JSON.stringify({
          ok: true,
          claimed: true,
          batch: leaseJson(),
        }),
      );
    },
  });
  const lease = await client.claim({ claimId: "claim-1", leaseOwner: "run-1", maxItems: 3 });
  assert.equal(lease?.batchId, "claim-1");
  await client.heartbeat({ batchId: "claim-1", leaseOwner: "run-1", items: queueItems });
  assert.deepEqual(paths, [
    "/internal/exact-review/publication-batches/claim",
    "/internal/exact-review/publication-batches/heartbeat",
  ]);
  assert.deepEqual(bodies[1], {
    batch_id: "claim-1",
    lease_owner: "run-1",
    items: queueItems.map((item) => ({
      item_key: item.itemKey,
      revision: item.revision,
      claim_generation: item.claimGeneration,
    })),
  });
});

function fakeQueue(
  hooks: {
    heartbeat?: () => void;
    complete?: (input: unknown) => void;
  } = {},
) {
  return {
    async claim() {
      return {
        batchId: "claim-1",
        leaseOwner: "run-1",
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        items: queueItems,
      };
    },
    async fetch() {
      return {
        batch: {
          batchId: "claim-1",
          leaseOwner: "run-1",
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          items: queueItems,
        },
        items: queueItems,
        superseded: 0,
      };
    },
    async heartbeat() {
      hooks.heartbeat?.();
      return {
        batchId: "claim-1",
        leaseOwner: "run-1",
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        items: queueItems,
      };
    },
    async complete(input: { items: unknown[] }) {
      hooks.complete?.(input);
      return {
        accepted: input.items.length,
        skipped: 0,
        batch: {
          batchId: "claim-1",
          leaseOwner: "run-1",
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          items: queueItems,
        },
      };
    },
  };
}

function leaseJson() {
  return {
    batch_id: "claim-1",
    lease_owner: "run-1",
    lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    items: queueItems.map((item) => ({
      item_key: item.itemKey,
      revision: item.revision,
      claim_generation: item.claimGeneration,
    })),
  };
}

function plan(item: (typeof queueItems)[number]) {
  return {
    identity: item,
    operations: [
      {
        path: `records/openclaw-openclaw/items/${item.itemKey.at(-1)}.md`,
        expectedOid: null,
        targetOid: "a".repeat(40),
        mode: "100644" as const,
        bytes: 1,
      },
    ],
    totalBytes: 1,
  };
}
