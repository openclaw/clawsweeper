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
  assert.equal(second.decision.sourceAction, "scheduled_normal_backfill");
  assert.equal(second.decision.sourceEvent, "pull_request");
  assert.equal(second.decision.supersedesInProgress, false);
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
