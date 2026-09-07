import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";

import { enqueueScheduledReviewPlan } from "../../dist/repair/scheduled-review-enqueue.js";
import { enqueueManualReviews } from "../../dist/repair/manual-review-enqueue.js";

test("manual admission reports partial failure, attempts the tail, and retries stable per-item identities", async () => {
  const payloads: string[] = [];
  const options = {
    targetRepo: "openclaw/gogcli",
    targetBranch: "main",
    codexTimeoutMs: 2_400_000,
    additionalPrompt: "Keep the operator's one-off instructions.\nDo not broaden scope.",
    itemNumbers: [1, 2, 3],
    requestId: "1234",
    queueUrl: "https://queue.example",
    secret: "synthetic",
    itemKind: async () => "issue" as const,
    fetch: async (_url: unknown, init?: RequestInit) => {
      if (!init?.method)
        return Response.json({
          manual_publication: { enabled: true, policy: "record_comment_only" },
        });
      payloads.push(String(init.body));
      const body = JSON.parse(String(init.body));
      return Response.json(
        body.decision.itemNumber === 2 ? { error: "unavailable" } : { ok: true, queued: true },
        { status: body.decision.itemNumber === 2 ? 400 : 202 },
      );
    },
  };
  const first = await enqueueManualReviews(options);
  assert.equal(first.ok, false);
  assert.equal(first.selected, 3);
  assert.equal(first.accepted, 2);
  assert.deepEqual(
    first.items.map((item) => item.accepted),
    [true, false, true],
  );
  for (const payload of payloads) {
    const decision = JSON.parse(payload).decision;
    assert.equal(decision.codexTimeoutMs, options.codexTimeoutMs);
    assert.equal(decision.additionalPrompt, options.additionalPrompt);
  }
  await enqueueManualReviews(options);
  assert.deepEqual(payloads.slice(0, 3), payloads.slice(3));
  assert.ok(
    payloads.every((p) => JSON.parse(p).decision.publicationPolicy === "record_comment_only"),
  );
  for (const codexTimeoutMs of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      enqueueManualReviews({ ...options, codexTimeoutMs }),
      /invalid explicit manual/,
    );
  }
});

test("manual admission refuses unavailable policy capability before resolving items", async () => {
  let reads = 0;
  await assert.rejects(
    enqueueManualReviews({
      targetRepo: "openclaw/gogcli",
      targetBranch: "main",
      codexTimeoutMs: 1_200_000,
      itemNumbers: [1],
      requestId: "1234",
      queueUrl: "https://queue.example",
      secret: "synthetic",
      itemKind: async () => {
        reads++;
        return "issue";
      },
      fetch: async () => Response.json({}),
    }),
    /does not advertise/,
  );
  assert.equal(reads, 0);
});
import { selectDueCandidates } from "../../dist/scheduler-policy.js";
import {
  buildExactReviewQueueRequest,
  ExactReviewQueue,
  MemoryDurableNamespace,
  MemoryDurableStorage,
  worker,
} from "../dashboard-worker-harness.ts";

function scheduledFeedCapability(targetRatePerHour: number) {
  return {
    scheduled_feed: {
      target_rate_per_hour: targetRatePerHour,
      enqueue_replay: "scheduled_disposition_v1",
    },
  };
}

const scheduledReplaySecret = "scheduled-replay-test-secret";

function scheduledCandidate(number: number) {
  return {
    repo: "openclaw/gogcli",
    number,
    kind: "issue" as const,
    updatedAt: "2026-09-04T00:00:00Z",
  };
}

function signedScheduledWorkerRequest(body: string) {
  return new Request("https://clawsweeper.openclaw.ai/internal/exact-review/enqueue", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-clawsweeper-exact-review-signature": `sha256=${createHmac("sha256", scheduledReplaySecret)
        .update(body)
        .digest("hex")}`,
    },
    body,
  });
}

test("coverage-untracked plans reach queue admission before canonical refreshes", async () => {
  const repo = "openclaw/openclaw";
  const candidate = (number: number, coverageTracked: boolean, reviewedAt: string) => ({
    item: {
      repo,
      number,
      kind: "issue" as const,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    review: { reviewStatus: "complete", reviewedAt },
    bucket: "weekly_issue" as const,
    priority: 6,
    reviewedAt: Date.parse(reviewedAt),
    nextDueAt: 0,
    coverageTracked,
  });
  const due = [
    ...Array.from({ length: 3_000 }, (_, index) =>
      candidate(index + 1, false, "2026-06-10T00:00:00Z"),
    ),
    ...Array.from({ length: 20 }, (_, index) =>
      candidate(3_001 + index, true, "2026-06-01T00:00:00Z"),
    ),
  ];
  const selected = selectDueCandidates(due, 128, undefined, Date.parse("2026-07-30T12:00:00Z"));
  const queuedNumbers: number[] = [];
  const summary = await enqueueScheduledReviewPlan({
    plan: {
      candidates: selected.map(({ item }) => item),
      selection: selected.map(() => ({ ageMs: 0 })),
    },
    lane: "normal_backfill",
    targetRepo: repo,
    targetBranch: "main",
    queueUrl: "https://queue.example",
    secret: "secret",
    deliveryPrefix: "scheduled:coverage:1",
    fetchImpl: async (_input, init) => {
      if (!init?.method) {
        return Response.json(scheduledFeedCapability(600));
      }
      const body = JSON.parse(String(init.body)) as { decision: { itemNumber: number } };
      queuedNumbers.push(body.decision.itemNumber);
      return Response.json({ ok: true, queued: true }, { status: 202 });
    },
  });

  assert.equal(summary.queued, 128);
  assert.equal(
    queuedNumbers.every((number) => number <= 3_000),
    true,
  );
});

test("scheduled review enqueue reports the full selection-to-queue funnel and stops on rate limit", async () => {
  const secret = "scheduled-review-test-secret";
  const requests: Array<{ body: string; signature: string }> = [];
  const dispositions = [
    { ok: true, queued: true },
    { ok: true, deduped: true },
    { ok: true, shed: true, reason: "scheduled_rate" },
  ];
  const summary = await enqueueScheduledReviewPlan({
    plan: {
      candidates: [1, 2, 3, 4].map((number) => ({
        repo: "openclaw/openclaw",
        number,
        kind: number === 2 ? ("pull_request" as const) : ("issue" as const),
        updatedAt: `2026-07-${String(20 + number).padStart(2, "0")}T00:00:00Z`,
      })),
      selection: [1, 6, 24, 240].map((hours) => ({ ageMs: hours * 3_600_000 })),
    },
    lane: "normal_backfill",
    targetRepo: "openclaw/openclaw",
    targetBranch: "main",
    queueUrl: "https://queue.example/",
    secret,
    deliveryPrefix: "scheduled:100:1",
    fetchImpl: async (_input, init) => {
      if (!init?.method) {
        return Response.json(scheduledFeedCapability(200));
      }
      const body = String(init?.body || "");
      const headers = (init?.headers ?? {}) as Record<string, string>;
      requests.push({
        body,
        signature: String(headers["x-clawsweeper-exact-review-signature"]),
      });
      return Response.json(dispositions[requests.length - 1], { status: 202 });
    },
  });

  assert.deepEqual(summary, {
    lane: "normal_backfill",
    offered: 4,
    attempted: 3,
    queued: 1,
    deduped: 1,
    shed: 1,
    rateLimited: 1,
    backpressured: 0,
    rejected: 0,
    deferred: 1,
    ageHours: { p50: 6, p90: 240, max: 240 },
  });
  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(
      request.signature,
      `sha256=${createHmac("sha256", secret).update(request.body).digest("hex")}`,
    );
  }
  const second = JSON.parse(requests[1]!.body);
  assert.equal(second.decision.targetBranch, "main");
  assert.equal(second.decision.sourceAction, "scheduled_normal_backfill");
  assert.equal(second.decision.sourceEvent, "pull_request");
  assert.equal(second.decision.supersedesInProgress, false);
});

for (const failure of ["HTTP 500", "TimeoutError"] as const) {
  test(`scheduled review enqueue retries ${failure} with one logical attempt and stable identity`, async () => {
    const secret = "scheduled-review-retry-secret";
    const requests: Array<{ body: string; signature: string }> = [];
    const summary = await enqueueScheduledReviewPlan({
      plan: {
        candidates: [
          {
            repo: "openclaw/openclaw",
            number: 42,
            kind: "issue",
            updatedAt: "2026-09-04T00:00:00Z",
          },
        ],
      },
      lane: "normal_backfill",
      targetRepo: "openclaw/openclaw",
      targetBranch: "main",
      queueUrl: "https://queue.example",
      secret,
      deliveryPrefix: "scheduled:retry:1",
      fetchImpl: async (_input, init) => {
        if (!init?.method) {
          return Response.json(scheduledFeedCapability(300));
        }
        const headers = init.headers as Record<string, string>;
        requests.push({
          body: String(init.body),
          signature: String(headers["x-clawsweeper-exact-review-signature"]),
        });
        if (requests.length === 1) {
          if (failure === "HTTP 500") {
            return Response.json({ error: "exact_review_queue_unavailable" }, { status: 500 });
          }
          throw new DOMException("synthetic timeout", "TimeoutError");
        }
        return Response.json({ ok: true, queued: true }, { status: 202 });
      },
    });

    assert.equal(summary.attempted, 1);
    assert.equal(summary.queued, 1);
    assert.equal(requests.length, 2);
    assert.equal(requests[0]!.body, requests[1]!.body);
    assert.equal(requests[0]!.signature, requests[1]!.signature);
    assert.equal(
      requests[0]!.signature,
      `sha256=${createHmac("sha256", secret).update(requests[0]!.body).digest("hex")}`,
    );
    assert.equal(JSON.parse(requests[0]!.body).delivery_id, "scheduled:retry:1:0:42");
  });
}

for (const scenario of [
  {
    name: "queued",
    env: {},
    prepare: async (_queue: ExactReviewQueue) => {},
    expectedBody: {
      ok: true,
      queued: true,
      item_key: "openclaw/gogcli#42",
      superseded_publications: 0,
    },
    summaryField: "queued",
  },
  {
    name: "scheduled item dedupe",
    env: {},
    prepare: async (queue: ExactReviewQueue) => {
      await queue.fetch(
        buildExactReviewQueueRequest(
          "scheduled-replay-existing",
          42,
          "opened",
          "issue",
          "openclaw/gogcli",
        ),
      );
    },
    expectedBody: {
      ok: true,
      deduped: true,
      item_key: "openclaw/gogcli#42",
      dedupe_scope: "scheduled_queue_item",
      dedupe_reason: "item_already_pending_or_active",
    },
    summaryField: "deduped",
  },
  {
    name: "backpressure shed",
    env: { EXACT_REVIEW_PENDING_SOFT_LIMIT: "1" },
    prepare: async (queue: ExactReviewQueue) => {
      await queue.fetch(
        buildExactReviewQueueRequest(
          "scheduled-replay-backpressure",
          41,
          "opened",
          "issue",
          "openclaw/gogcli",
        ),
      );
    },
    expectedBody: { ok: true, shed: true, reason: "backpressure" },
    summaryField: "backpressured",
  },
  {
    name: "scheduled rate shed",
    env: {
      EXACT_REVIEW_TARGET_RATE_PER_HOUR: "2",
      EXACT_REVIEW_TARGET_BURST: "2",
    },
    prepare: async (queue: ExactReviewQueue) => {
      await queue.fetch(
        buildExactReviewQueueRequest(
          "scheduled-replay-rate",
          41,
          "scheduled_normal_backfill",
          "issue",
          "openclaw/gogcli",
        ),
      );
    },
    expectedBody: { ok: true, shed: true, reason: "scheduled_rate" },
    summaryField: "rateLimited",
  },
] as const) {
  test(`scheduled review response-loss retry replays the exact ${scenario.name} disposition`, async () => {
    const storage = new MemoryDurableStorage();
    const queue = new ExactReviewQueue({ storage }, scenario.env);
    await scenario.prepare(queue);
    const env = {
      CLAWSWEEPER_WEBHOOK_SECRET: scheduledReplaySecret,
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
    };
    const requests: Array<{ body: string; signature: string }> = [];
    const responseBodies: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "POST") {
        requests.push({
          body: await request.clone().text(),
          signature: request.headers.get("x-clawsweeper-exact-review-signature") || "",
        });
      }
      const response = await worker.fetch(request, env);
      if (request.method !== "POST") return response;
      responseBodies.push(await response.clone().text());
      if (responseBodies.length === 1) {
        throw new DOMException("synthetic response loss", "TimeoutError");
      }
      return response;
    };

    const summary = await enqueueScheduledReviewPlan({
      plan: { candidates: [scheduledCandidate(42)] },
      lane: "normal_backfill",
      targetRepo: "openclaw/gogcli",
      targetBranch: "main",
      queueUrl: "https://clawsweeper.openclaw.ai",
      secret: scheduledReplaySecret,
      deliveryPrefix: `scheduled:response-loss:${scenario.summaryField}`,
      fetchImpl,
    });

    assert.equal(summary.attempted, 1);
    assert.equal(summary[scenario.summaryField], 1);
    assert.equal(requests.length, 2);
    assert.equal(requests[0]!.body, requests[1]!.body);
    assert.equal(requests[0]!.signature, requests[1]!.signature);
    assert.equal(responseBodies[0], responseBodies[1]);
    assert.deepEqual(JSON.parse(responseBodies[1]!), scenario.expectedBody);
    const stats = await (await queue.fetch(new Request("https://queue/stats"))).json();
    assert.equal(stats.lanes.review.shed_since_reset, scenario.expectedBody.shed === true ? 1 : 0);
  });
}

test("scheduled review enqueue fails closed when a retry loses the original disposition", async () => {
  const requests: Array<{ body: string; signature: string }> = [];
  await assert.rejects(
    enqueueScheduledReviewPlan({
      plan: {
        candidates: [
          {
            repo: "openclaw/openclaw",
            number: 42,
            kind: "issue",
            updatedAt: "2026-09-04T00:00:00Z",
          },
        ],
      },
      lane: "normal_backfill",
      targetRepo: "openclaw/openclaw",
      targetBranch: "main",
      queueUrl: "https://queue.example",
      secret: "scheduled-review-retry-secret",
      deliveryPrefix: "scheduled:retry:1",
      fetchImpl: async (_input, init) => {
        if (!init?.method) {
          return Response.json(scheduledFeedCapability(300));
        }
        const headers = init.headers as Record<string, string>;
        requests.push({
          body: String(init.body),
          signature: String(headers["x-clawsweeper-exact-review-signature"]),
        });
        return requests.length === 1
          ? Response.json({ error: "exact_review_queue_unavailable" }, { status: 500 })
          : Response.json({ ok: true, deduped: true }, { status: 202 });
      },
    }),
    /ambiguous dedupe after retry/,
  );

  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.body, requests[1]!.body);
  assert.equal(requests[0]!.signature, requests[1]!.signature);
});

test("scheduled review enqueue accepts a scoped item dedupe after retry", async () => {
  const secret = "scheduled-review-retry-secret";
  const requests: Array<{ body: string; signature: string }> = [];
  const summary = await enqueueScheduledReviewPlan({
    plan: {
      candidates: [
        {
          repo: "openclaw/openclaw",
          number: 42,
          kind: "issue",
          updatedAt: "2026-09-04T00:00:00Z",
        },
      ],
    },
    lane: "normal_backfill",
    targetRepo: "openclaw/openclaw",
    targetBranch: "main",
    queueUrl: "https://queue.example",
    secret,
    deliveryPrefix: "scheduled:retry:1",
    fetchImpl: async (_input, init) => {
      if (!init?.method) {
        return Response.json(scheduledFeedCapability(300));
      }
      const headers = init.headers as Record<string, string>;
      requests.push({
        body: String(init.body),
        signature: String(headers["x-clawsweeper-exact-review-signature"]),
      });
      return requests.length === 1
        ? Response.json({ error: "exact_review_queue_unavailable" }, { status: 500 })
        : Response.json(
            {
              ok: true,
              deduped: true,
              dedupe_scope: "scheduled_queue_item",
              dedupe_reason: "item_already_pending_or_active",
            },
            { status: 202 },
          );
    },
  });

  assert.equal(summary.attempted, 1);
  assert.equal(summary.deduped, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.body, requests[1]!.body);
  assert.equal(requests[0]!.signature, requests[1]!.signature);
  assert.equal(
    requests[0]!.signature,
    `sha256=${createHmac("sha256", secret).update(requests[0]!.body).digest("hex")}`,
  );
});

test("scheduled review delivery IDs conflict when authenticated bytes differ", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: scheduledReplaySecret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const body = JSON.stringify({
    delivery_id: "scheduled:byte-conflict:42",
    decision: {
      targetRepo: "openclaw/gogcli",
      targetBranch: "main",
      itemNumber: 42,
      itemKind: "issue",
      sourceEvent: "issues",
      sourceAction: "scheduled_normal_backfill",
      supersedesInProgress: false,
      sourceUpdatedAt: "2026-09-04T00:00:00Z",
    },
  });
  const first = await worker.fetch(signedScheduledWorkerRequest(body), env);
  assert.equal(first.status, 202);
  assert.equal((await first.json()).queued, true);

  const conflict = await worker.fetch(signedScheduledWorkerRequest(`${body} `), env);
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: "exact_review_delivery_conflict" });

  const receipt = Array.from(
    storage.sql.exec(
      `SELECT authenticated_body_fingerprint, scheduled_disposition_json
         FROM exact_review_queue_deliveries
        WHERE delivery_id = ?`,
      "scheduled:byte-conflict:42",
    ),
  )[0] as {
    authenticated_body_fingerprint: string;
    scheduled_disposition_json: string;
  };
  assert.equal(
    receipt.authenticated_body_fingerprint,
    createHash("sha256").update(body).digest("hex"),
  );
  assert.equal(receipt.scheduled_disposition_json.includes(scheduledReplaySecret), false);
  assert.equal(receipt.scheduled_disposition_json.includes("sourceUpdatedAt"), false);
});

test("scheduled disposition persistence rolls back with queue admission", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: scheduledReplaySecret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  await queue.fetch(new Request("https://queue/stats"));
  storage.failNextSql(/SET scheduled_disposition_json = \?/);
  const body = JSON.stringify({
    delivery_id: "scheduled:atomic:42",
    decision: {
      targetRepo: "openclaw/gogcli",
      targetBranch: "main",
      itemNumber: 42,
      itemKind: "issue",
      sourceEvent: "issues",
      sourceAction: "scheduled_normal_backfill",
      supersedesInProgress: false,
      sourceUpdatedAt: "2026-09-04T00:00:00Z",
    },
  });

  const failed = await worker.fetch(signedScheduledWorkerRequest(body), env);
  assert.equal(failed.status, 500);
  let stats = await (await queue.fetch(new Request("https://queue/stats"))).json();
  assert.equal(stats.pending, 0);
  assert.equal(stats.delivery_receipts, 0);
  assert.equal(stats.lanes.review.enqueued_total, 0);

  const accepted = await worker.fetch(signedScheduledWorkerRequest(body), env);
  assert.equal(accepted.status, 202);
  assert.equal((await accepted.json()).queued, true);
  stats = await (await queue.fetch(new Request("https://queue/stats"))).json();
  assert.equal(stats.pending, 1);
  assert.equal(stats.delivery_receipts, 1);
  assert.equal(stats.lanes.review.enqueued_total, 1);
});

test("delivery receipt upgrade leaves legacy rows ambiguous without a schema bump", async () => {
  const storage = new MemoryDurableStorage();
  storage.sql.exec(
    `CREATE TABLE exact_review_queue_deliveries (
       delivery_id TEXT PRIMARY KEY,
       received_at INTEGER NOT NULL
     ) STRICT`,
  );
  storage.sql.exec(
    `INSERT INTO exact_review_queue_deliveries (delivery_id, received_at) VALUES (?, ?)`,
    "scheduled:legacy-upgrade:0:42",
    Date.now(),
  );
  const queue = new ExactReviewQueue({ storage }, {});
  const stats = await (await queue.fetch(new Request("https://queue/stats"))).json();
  assert.equal(stats.storage_schema_version, 1);
  assert.deepEqual(
    Array.from(
      storage.sql.exec(
        "SELECT name FROM pragma_table_info('exact_review_queue_deliveries') ORDER BY cid",
      ),
    ).map((row) => row.name),
    ["delivery_id", "received_at", "authenticated_body_fingerprint", "scheduled_disposition_json"],
  );
  const body = JSON.stringify({
    delivery_id: "scheduled:legacy-upgrade:0:42",
    decision: {
      targetRepo: "openclaw/gogcli",
      targetBranch: "main",
      itemNumber: 42,
      itemKind: "issue",
      sourceEvent: "issues",
      sourceAction: "scheduled_normal_backfill",
      supersedesInProgress: false,
    },
  });
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: scheduledReplaySecret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const response = await worker.fetch(signedScheduledWorkerRequest(body), env);
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    ok: true,
    deduped: true,
    item_key: "openclaw/gogcli#42",
  });

  let postAttempt = 0;
  await assert.rejects(
    enqueueScheduledReviewPlan({
      plan: {
        candidates: [scheduledCandidate(42)],
      },
      lane: "normal_backfill",
      targetRepo: "openclaw/gogcli",
      targetBranch: "main",
      queueUrl: "https://queue.example",
      secret: scheduledReplaySecret,
      deliveryPrefix: "scheduled:legacy-upgrade",
      fetchImpl: async (request, init) => {
        const url = typeof request === "string" ? request : request.url;
        if (url.endsWith("/api/exact-review-queue")) {
          return Response.json(scheduledFeedCapability(300));
        }
        postAttempt += 1;
        if (postAttempt === 1) throw new DOMException("request timed out", "TimeoutError");
        return worker.fetch(new Request(request, init), env);
      },
    }),
    /ambiguous dedupe after retry/,
  );
  assert.equal(postAttempt, 2);
});

test("rollback-era receipts stay ambiguous while prior scheduled receipts still replay", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: scheduledReplaySecret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const originalBody = JSON.stringify({
    delivery_id: "scheduled:before-rollback:42",
    decision: {
      targetRepo: "openclaw/gogcli",
      targetBranch: "main",
      itemNumber: 42,
      itemKind: "issue",
      sourceEvent: "issues",
      sourceAction: "scheduled_normal_backfill",
      supersedesInProgress: false,
    },
  });
  const original = await worker.fetch(signedScheduledWorkerRequest(originalBody), env);
  const originalResponseText = await original.text();
  const shadow = structuredClone(
    storage.rawGet("exact-review-queue") as {
      deliveries: Record<string, number>;
      items: Record<string, unknown>;
    },
  );
  shadow.deliveries["scheduled:during-rollback:43"] = Date.now();
  storage.rawPut("exact-review-queue", shadow);

  const upgradedQueue = new ExactReviewQueue({ storage }, {});
  const upgradedEnv = {
    CLAWSWEEPER_WEBHOOK_SECRET: scheduledReplaySecret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(upgradedQueue),
  };
  const replay = await worker.fetch(signedScheduledWorkerRequest(originalBody), upgradedEnv);
  assert.equal(await replay.text(), originalResponseText);

  const rollbackBody = JSON.stringify({
    delivery_id: "scheduled:during-rollback:43",
    decision: {
      targetRepo: "openclaw/gogcli",
      targetBranch: "main",
      itemNumber: 43,
      itemKind: "issue",
      sourceEvent: "issues",
      sourceAction: "scheduled_normal_backfill",
      supersedesInProgress: false,
    },
  });
  const ambiguous = await worker.fetch(signedScheduledWorkerRequest(rollbackBody), upgradedEnv);
  assert.deepEqual(await ambiguous.json(), {
    ok: true,
    deduped: true,
    item_key: "openclaw/gogcli#43",
  });
});

test("scheduled review enqueue does not retry HTTP 4xx and preserves request identity", async () => {
  const secret = "scheduled-review-retry-secret";
  const requests: Array<{ body: string; signature: string }> = [];
  await assert.rejects(
    enqueueScheduledReviewPlan({
      plan: {
        candidates: [
          {
            repo: "openclaw/openclaw",
            number: 42,
            kind: "issue",
            updatedAt: "2026-09-04T00:00:00Z",
          },
        ],
      },
      lane: "normal_backfill",
      targetRepo: "openclaw/openclaw",
      targetBranch: "main",
      queueUrl: "https://queue.example",
      secret,
      deliveryPrefix: "scheduled:retry:1",
      fetchImpl: async (_input, init) => {
        if (!init?.method) {
          return Response.json(scheduledFeedCapability(300));
        }
        const headers = init.headers as Record<string, string>;
        requests.push({
          body: String(init.body),
          signature: String(headers["x-clawsweeper-exact-review-signature"]),
        });
        return Response.json({ error: "exact_review_conflict" }, { status: 409 });
      },
    }),
    {
      message:
        "Batch queue /internal/exact-review/enqueue failed (HTTP 409): exact_review_conflict",
    },
  );

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0]!.signature,
    `sha256=${createHmac("sha256", secret).update(requests[0]!.body).digest("hex")}`,
  );
  assert.equal(JSON.parse(requests[0]!.body).delivery_id, "scheduled:retry:1:0:42");
});

test("scheduled review enqueue rejects numeric target branches before queue admission", async () => {
  await assert.rejects(
    enqueueScheduledReviewPlan({
      plan: { candidates: [] },
      lane: "normal_backfill",
      targetRepo: "openclaw/openclaw",
      targetBranch: "0",
      queueUrl: "https://queue.example",
      secret: "secret",
      deliveryPrefix: "scheduled:100:1",
      fetchImpl: async () => {
        throw new Error("fetch must not run");
      },
    }),
    /target branch is invalid/,
  );
});

for (const capability of [
  { lanes: {} },
  { scheduled_feed: { target_rate_per_hour: 300 } },
  {
    scheduled_feed: {
      target_rate_per_hour: 300,
      enqueue_replay: "future_contract",
    },
  },
]) {
  test("scheduled review enqueue fails closed until the queue advertises replay-safe pacing", async () => {
    await assert.rejects(
      enqueueScheduledReviewPlan({
        plan: { candidates: [] },
        lane: "normal_backfill",
        targetRepo: "openclaw/openclaw",
        targetBranch: "main",
        queueUrl: "https://queue.example",
        secret: "secret",
        deliveryPrefix: "scheduled:100:1",
        fetchImpl: async () => Response.json(capability),
      }),
      /does not advertise scheduled feed admission/,
    );
  });
}

test("scheduled review enqueue rejects cross-repository plan candidates", async () => {
  await assert.rejects(
    enqueueScheduledReviewPlan({
      plan: {
        candidates: [
          {
            repo: "openclaw/other",
            number: 1,
            kind: "issue",
            updatedAt: "2026-07-29T00:00:00Z",
          },
        ],
      },
      lane: "hot_intake",
      targetRepo: "openclaw/openclaw",
      targetBranch: "main",
      queueUrl: "https://queue.example",
      secret: "secret",
      deliveryPrefix: "scheduled:100:1",
      fetchImpl: async () => {
        throw new Error("fetch must not run");
      },
    }),
    /candidate repository mismatch/,
  );
});
