import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { enqueueScheduledReviewPlan } from "../../dist/repair/scheduled-review-enqueue.js";
import { selectDueCandidates } from "../../dist/scheduler-policy.js";

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
        return Response.json({ scheduled_feed: { target_rate_per_hour: 600 } });
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
        return Response.json({ scheduled_feed: { target_rate_per_hour: 200 } });
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
          return Response.json({ scheduled_feed: { target_rate_per_hour: 300 } });
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
          return Response.json({ scheduled_feed: { target_rate_per_hour: 300 } });
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
        return Response.json({ scheduled_feed: { target_rate_per_hour: 300 } });
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
          return Response.json({ scheduled_feed: { target_rate_per_hour: 300 } });
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

test("scheduled review enqueue fails closed until the queue advertises pacing", async () => {
  await assert.rejects(
    enqueueScheduledReviewPlan({
      plan: { candidates: [] },
      lane: "normal_backfill",
      targetRepo: "openclaw/openclaw",
      targetBranch: "main",
      queueUrl: "https://queue.example",
      secret: "secret",
      deliveryPrefix: "scheduled:100:1",
      fetchImpl: async () => Response.json({ lanes: {} }),
    }),
    /does not advertise scheduled feed admission/,
  );
});

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
