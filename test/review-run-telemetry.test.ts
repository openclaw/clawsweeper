import assert from "node:assert/strict";
import test from "node:test";

import { normalizeReviewRunTelemetry } from "../dashboard/review-run-telemetry.ts";
import {
  buildReviewRunTelemetry,
  classifyReviewRun,
  fetchJobs,
} from "../scripts/review-run-observer.mjs";

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: 1234,
    run_attempt: 2,
    status: "completed",
    conclusion: "success",
    event: "repository_dispatch",
    display_title: "Review event item openclaw/openclaw#674 [router-command]",
    run_started_at: "2026-07-19T10:00:00Z",
    updated_at: "2026-07-19T10:05:00Z",
    html_url: "https://github.com/openclaw/clawsweeper/actions/runs/1234",
    ...overrides,
  };
}

test("review observer attributes each review entry path without counting support runs", () => {
  assert.deepEqual(classifyReviewRun(run()), {
    trigger_lane: "exact_event",
    trigger_origin: "command",
    target_repo: "openclaw/openclaw",
  });
  assert.equal(
    classifyReviewRun(run({ display_title: "Review event item openclaw/openclaw#674" }))
      ?.trigger_origin,
    "webhook",
  );
  assert.equal(
    classifyReviewRun(
      run({
        display_title: "Review event item openclaw/openclaw#674",
        event: "workflow_dispatch",
      }),
    )?.trigger_origin,
    "manual",
  );
  assert.equal(
    classifyReviewRun(run({ display_title: "Review hot ClawSweeper items", event: "schedule" }))
      ?.trigger_lane,
    "hot_intake",
  );
  assert.equal(
    classifyReviewRun(run({ display_title: "Review ClawSweeper items", event: "schedule" }))
      ?.trigger_lane,
    "normal_backfill",
  );
  assert.equal(
    classifyReviewRun(run({ display_title: "Retry failed Codex reviews", event: "schedule" }))
      ?.trigger_lane,
    "recovery",
  );
  assert.equal(
    classifyReviewRun(run({ display_title: "Retry failed Codex reviews", event: "workflow_call" }))
      ?.trigger_origin,
    "system",
  );
  assert.equal(
    classifyReviewRun(run({ display_title: "Apply default ClawSweeper closures" })),
    null,
  );
  assert.equal(classifyReviewRun(run({ display_title: "Reconcile exact-review leases" })), null);
});

test("review observer records bounded plan, item, and publication counts", () => {
  const record = buildReviewRunTelemetry(run(), [
    { name: "Plan review items" },
    { name: "Review item 674", conclusion: "success" },
    { name: "Review shard 2", conclusion: "cancelled" },
    { name: "Publish exact review" },
  ]);
  assert.equal(record?.plan_count, 1);
  assert.equal(record?.item_count, 1);
  assert.equal(record?.publication_count, 1);
  assert.deepEqual(record?.review_jobs, [
    { name: "Review shard 2", conclusion: "cancelled", item_number: 674 },
  ]);
  assert.deepEqual(normalizeReviewRunTelemetry(record), {
    ...record,
    started_at: "2026-07-19T10:00:00.000Z",
    completed_at: "2026-07-19T10:05:00.000Z",
  });
});

test("review observer excludes queue and publication support runs from review attempts", () => {
  assert.equal(
    buildReviewRunTelemetry(run(), [
      { name: "Queue legacy exact-review event", conclusion: "success" },
      { name: "Review exact event item", conclusion: "skipped" },
    ]),
    null,
  );
  assert.equal(
    buildReviewRunTelemetry(
      run({ display_title: "Review event item openclaw/openclaw#674@publish:1:1" }),
      [{ name: "Publish exact review artifact", conclusion: "success" }],
    ),
    null,
  );
  assert.deepEqual(
    buildReviewRunTelemetry(run(), [{ name: "Review exact event item", conclusion: "success" }])
      ?.review_jobs,
    [{ name: "Review exact event item", conclusion: "success", item_number: 674 }],
  );
});

test("review observer counts skipped matrix jobs after an active plan", () => {
  const record = buildReviewRunTelemetry(
    run({ conclusion: "failure", display_title: "Review ClawSweeper items" }),
    [
      { name: "Plan review items", conclusion: "failure" },
      { name: "Review item 674", conclusion: "skipped" },
      { name: "Review item 675", conclusion: "skipped" },
    ],
  );
  assert.equal(record?.item_count, 2);
  assert.deepEqual(record?.review_jobs, [
    { name: "Review item 674", conclusion: "skipped", item_number: 674 },
    { name: "Review item 675", conclusion: "skipped", item_number: 675 },
  ]);
});

test("review run telemetry rejects unsafe identities and nonterminal time order", () => {
  const record = buildReviewRunTelemetry(run(), [
    { name: "Review exact event item", conclusion: "success" },
  ]);
  assert.ok(record);
  assert.equal(normalizeReviewRunTelemetry({ ...record, run_id: "not-a-run" }), null);
  assert.equal(
    normalizeReviewRunTelemetry({
      ...record,
      completed_at: "2026-07-19T09:59:59Z",
    }),
    null,
  );
});

test("review observer paginates jobs instead of silently undercounting large matrices", async () => {
  const originalFetch = globalThis.fetch;
  const pages: number[] = [];
  globalThis.fetch = async (input) => {
    const page = Number(new URL(String(input)).searchParams.get("page"));
    pages.push(page);
    const jobs =
      page === 1
        ? Array.from({ length: 100 }, (_, index) => ({
            name: `Review item ${index + 1}`,
            conclusion: "success",
          }))
        : [{ name: "Publish review artifacts", conclusion: "success" }];
    return new Response(JSON.stringify({ jobs }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const jobs = await fetchJobs(run(), {
      token: "test-token-placeholder",
      repository: "openclaw/clawsweeper",
      apiUrl: "https://api.github.test",
    });
    assert.equal(jobs.length, 101);
    assert.deepEqual(pages, [1, 2]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("review observer accepts exactly its 1000-job fetch bound", async () => {
  const originalFetch = globalThis.fetch;
  const pages: number[] = [];
  globalThis.fetch = async (input) => {
    const page = Number(new URL(String(input)).searchParams.get("page"));
    pages.push(page);
    return new Response(
      JSON.stringify({
        total_count: 1_000,
        jobs: Array.from({ length: 100 }, (_, index) => ({
          name: `Review item ${(page - 1) * 100 + index + 1}`,
          conclusion: "success",
        })),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const jobs = await fetchJobs(run(), {
      token: "test-token-placeholder",
      repository: "openclaw/clawsweeper",
      apiUrl: "https://api.github.test",
    });
    assert.equal(jobs.length, 1_000);
    assert.deepEqual(pages, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("review observer rejects runs beyond its 1000-job fetch bound", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ total_count: 1_001, jobs: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  try {
    await assert.rejects(
      fetchJobs(run(), {
        token: "test-token-placeholder",
        repository: "openclaw/clawsweeper",
        apiUrl: "https://api.github.test",
      }),
      /exceeds observer bound of 1000/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("review observer preserves every job identity within its fetch bound", () => {
  const jobs = Array.from({ length: 101 }, (_, index) => ({
    name: `Review item ${index + 1}`,
    conclusion: "success",
  }));
  const record = buildReviewRunTelemetry(
    run({
      display_title: "Review ClawSweeper items",
      event: "schedule",
    }),
    jobs,
  );
  assert.equal(record?.item_count, 101);
  assert.equal(record?.review_jobs?.length, 101);
  assert.ok(normalizeReviewRunTelemetry(record));
});
