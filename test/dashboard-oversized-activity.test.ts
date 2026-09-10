import {
  assert,
  test,
  ExactReviewQueue,
  MemoryDurableStorage,
  MemoryDurableNamespace,
  worker,
  leasedExactReviewQueueItem,
} from "./dashboard-worker-harness.ts";
import { OversizedActivityStore } from "../dashboard/oversized-activity-store.ts";
import {
  ownedCommentWriteIntent,
  ownedCommentWriteResult,
} from "../src/oversized-activity-write.ts";

const repo = "openclaw/openclaw",
  number = 42;
const pull = {
  number,
  title: "Synthetic",
  body: "Body",
  updated_at: "2026-01-01T00:00:00Z",
  comments: 0,
  review_comments: 0,
  labels: [],
  state: "open",
  head: { sha: "b".repeat(40) },
  additions: 50001,
  deletions: 0,
  changed_files: 1,
};
async function setup(upgraded: boolean) {
  const storage = new MemoryDurableStorage();
  const store = new OversizedActivityStore(storage.kv);
  const ref = upgraded
    ? await store.prepare(repo, number, { head: "b" }, async (path) =>
        path.endsWith("/pulls/42") ? pull : [],
      )
    : undefined;
  const item: any = leasedExactReviewQueueItem(number, "123");
  item.decision = {
    ...item.decision,
    itemKind: "pull_request",
    sourceEvent: "pull_request",
    ...(ref ? { oversizedActivityReference: ref } : {}),
  };
  item.leaseDecision = { ...item.decision };
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, { hostedTargetPredicate: () => true });
  const env = { EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue) };
  const tuple = {
    item_key: item.key,
    lease_id: item.leaseId,
    lease_revision: 1,
    claim_generation: 1,
    run_id: "123",
    run_attempt: 1,
  };
  const post = (path: string, body: unknown) =>
    worker.fetch(
      new Request(`https://clawsweeper.openclaw.ai/internal/exact-review/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
    );
  return { storage, store, ref, item, tuple, post };
}

test("upgraded Worker claim round-trips evidence, validates write receipts and releases the acknowledgement fence", async () => {
  const h = await setup(true);
  const response = await h.post("claim", { ...h.tuple, oversized_activity_version: 1 });
  assert.equal(response.status, 200);
  const claim: any = await response.json();
  assert.equal(claim.oversized_activity_version, 1);
  assert.deepEqual(claim.decision.oversizedActivityReference, h.ref);
  const context = claim.oversized_activity;
  assert.ok(context);
  assert.equal(h.store.blocked(repo, number), true);
  const get: any = await (
    await h.post("oversized-activity", { ...context, operation: "read" })
  ).json();
  assert.ok(get.evidence.baseline);
  assert.equal(get.evidence.receipts.length, 0);
  const malformed = await h.post("oversized-activity", {
    ...context,
    operation: "begin",
    receipt: { id: 1 },
  });
  assert.equal(malformed.status, 400);
  const body = "<!-- clawsweeper-command-ack:8 -->";
  const intent = ownedCommentWriteIntent(
    { method: "POST", path: `repos/${repo}/issues/42/comments`, body: { body } },
    null,
  );
  assert.equal(
    (await h.post("oversized-activity", { ...context, operation: "begin", receipt: intent }))
      .status,
    200,
  );
  const incomplete: any = await (
    await h.post("oversized-activity", { ...context, operation: "read" })
  ).json();
  assert.match(incomplete.evidence.invalid, /no complete receipt/);
  const timestamp = new Date().toISOString();
  const comment = {
    id: 9,
    body,
    user: { login: "clawsweeper[bot]" },
    created_at: timestamp,
    updated_at: timestamp,
  };
  const receipt = ownedCommentWriteResult(intent, comment, {
    ...pull,
    comments: 1,
    updated_at: timestamp,
  });
  assert.equal(
    (await h.post("oversized-activity", { ...context, operation: "complete", receipt })).status,
    200,
  );
  assert.equal(new OversizedActivityStore(h.storage.kv).evidence(h.ref!)?.receipts.length, 1);
  const wrong: any = await (
    await h.post("oversized-activity", {
      ...context,
      owner: { ...context.owner, runId: "999" },
      operation: "read",
    })
  ).json();
  assert.equal(wrong.evidence, null);
  const done = await h.post("complete", {
    ...h.tuple,
    outcome: "success",
    oversized_activity_failed: false,
  });
  assert.equal(done.status, 200, await done.text());
  assert.equal(h.store.blocked(repo, number), false);
});

test("old-head claim and completion retain their existing Worker protocol without evidence negotiation", async () => {
  const h = await setup(false);
  const response = await h.post("claim", h.tuple);
  assert.equal(response.status, 200);
  const claim: any = await response.json();
  assert.equal(claim.claimed, true);
  assert.equal(claim.oversized_activity_version, undefined);
  assert.equal(claim.oversized_activity, undefined);
  assert.equal(claim.decision.oversizedActivityReference, undefined);
  assert.equal(h.store.control(repo, number), undefined);
  const heartbeat = await h.post("heartbeat", { ...h.tuple, phase: "finalizing" });
  assert.equal(heartbeat.status, 200);
  const done = await h.post("complete", { ...h.tuple, outcome: "success" });
  assert.equal(done.status, 200, await done.text());
  assert.equal(h.store.control(repo, number), undefined);
});

test("queue owner captures the baseline and durable intent before acknowledgement effects, then fences late convergence", async () => {
  const { createServer } = await import("node:http");
  const storage = new MemoryDurableStorage();
  const live = { ...pull, head: { ...pull.head }, labels: [] };
  const events: string[] = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url!, "http://127.0.0.1").pathname;
    events.push(path);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(path.endsWith("/pulls/42") ? live : []));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    const queue = new ExactReviewQueue(
      { storage },
      { GITHUB_API_URL: `http://127.0.0.1:${address.port}` },
    );
    const decision = {
      targetRepo: repo,
      targetBranch: "main",
      itemNumber: number,
      itemKind: "pull_request",
      sourceEvent: "pull_request",
      sourceAction: "opened",
      supersedesInProgress: false,
    };
    const store = new OversizedActivityStore(storage.kv);
    await (queue as any).withOversizedAcknowledgement(
      decision,
      Promise.resolve("synthetic"),
      async (journal: any) => {
        assert.equal(typeof journal, "function");
        const ref = store.control(repo, number)!.reference;
        assert.ok(store.evidence(ref)?.baseline);
        assert.equal(store.evidence(ref)?.baseline?.source.comments, 0);
        const body = "<!-- clawsweeper-pr-ack item=42 -->";
        await journal(
          { path: `/repos/${repo}/issues/42/comments`, method: "POST", body: { body } },
          async () => {
            assert.match(store.evidence(ref)?.invalid || "", /no complete receipt/);
            assert.equal(events.length, 7);
            events.push("WRITE");
            live.comments = 1;
            live.updated_at = new Date().toISOString();
            return {
              id: 9,
              body,
              created_at: live.updated_at,
              updated_at: live.updated_at,
              user: { login: "clawsweeper[bot]" },
            };
          },
        );
      },
    );
    const ref = store.control(repo, number)!.reference;
    assert.equal(store.evidence(ref)?.receipts.length, 1);
    const owner = {
      itemKey: `${repo}#42`,
      leaseId: "synthetic",
      claimGeneration: 1,
      runId: "123",
      runAttempt: 1,
    };
    assert.equal(store.fence(ref, owner, Date.now() + 60000), true);
    await assert.rejects(
      () =>
        (queue as any).withOversizedAcknowledgement(
          decision,
          Promise.resolve("synthetic"),
          async () => {
            events.push("late duplicate POST/DELETE");
          },
        ),
      /fenced/,
    );
    assert.equal(events.includes("late duplicate POST/DELETE"), false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a failed size lookup cannot bypass a fence acquired during that lookup", async () => {
  const { createServer } = await import("node:http");
  const storage = new MemoryDurableStorage();
  const store = new OversizedActivityStore(storage.kv);
  const ref = await store.prepare(repo, number, {}, async (path) =>
    path.endsWith("/pulls/42") ? pull : [],
  );
  let reached!: () => void;
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let finish!: () => void;
  const server = createServer((_request, response) => {
    finish = () => {
      response.writeHead(400);
      response.end("synthetic missing metadata");
    };
    reached();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    const queue = new ExactReviewQueue(
      { storage },
      { GITHUB_API_URL: `http://127.0.0.1:${address.port}` },
    );
    let writes = 0;
    const pending = (queue as any).withOversizedAcknowledgement(
      { targetRepo: repo, itemNumber: number, itemKind: "pull_request" },
      Promise.resolve("synthetic"),
      async () => {
        writes++;
      },
    );
    await started;
    assert.equal(
      store.fence(
        ref,
        {
          itemKey: `${repo}#42`,
          leaseId: "claim",
          claimGeneration: 1,
          runId: "123",
          runAttempt: 1,
        },
        Date.now() + 60000,
      ),
      true,
    );
    finish();
    await assert.rejects(pending, /fenced/);
    assert.equal(writes, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("oversized evidence selects the per-item publication owner even when batching is enabled", async () => {
  const { exactReviewQueueIsBatchablePublication } =
    await import("../dashboard/exact-review-decision.ts");
  const decision: any = {
    targetRepo: repo,
    targetBranch: "main",
    itemNumber: number,
    itemKind: "pull_request",
    sourceEvent: "pull_request",
    sourceAction: "exact_review_artifact_publish",
    supersedesInProgress: false,
  };
  assert.equal(exactReviewQueueIsBatchablePublication({ decision }), true);
  decision.oversizedActivityReference = {
    version: 1,
    repo,
    number,
    epoch: "10000000-0000-0000-0000-000000000000",
  };
  assert.equal(exactReviewQueueIsBatchablePublication({ decision }), false);
});

for (const fails of [false, true]) {
  test(`claim revalidates an expired lease after ${fails ? "failed" : "ordinary-size"} metadata probe`, async () => {
    const { createServer } = await import("node:http");
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const storage = new MemoryDurableStorage();
    const item: any = leasedExactReviewQueueItem(number, "123");
    item.decision = { ...item.decision, itemKind: "pull_request", sourceEvent: "pull_request" };
    item.leaseDecision = { ...item.decision };
    await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
    let probes = 0;
    const server = createServer(async (request, response) => {
      const path = new URL(request.url!, "http://127.0.0.1").pathname;
      let data: unknown = { id: 123 };
      if (path.endsWith("/access_tokens")) data = { token: "synthetic" };
      if (path.endsWith("/pulls/42")) {
        probes++;
        const state: any = await storage.get("exact-review-queue");
        state.items[item.key].leaseExpiresAt = Date.now() - 1;
        await storage.put("exact-review-queue", state);
        data = fails ? { error: "synthetic metadata failure" } : { ...pull, additions: 1 };
      }
      response.writeHead(fails && path.endsWith("/pulls/42") ? 400 : 200, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify(data));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as { port: number };
      const queue = new ExactReviewQueue(
        { storage },
        {
          hostedPublicTargetProbe: async () => "public",
          CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
          CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
          GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
        },
      );
      const response = await queue.fetch(
        new Request("https://queue.invalid/claim", {
          method: "POST",
          body: JSON.stringify({
            item_key: item.key,
            lease_id: item.leaseId,
            lease_revision: 1,
            run_id: "123",
            run_attempt: 1,
            oversized_activity_version: 1,
          }),
        }),
      );
      assert.equal(probes, 1);
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error, "lease_not_active");
      const after: any = await storage.get("exact-review-queue");
      assert.ok(after.items[item.key].leaseExpiresAt < Date.now());
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
