import {
  assert,
  createHmac,
  test,
  worker,
  ExactReviewQueue,
  MemoryDurableStorage,
  MemoryDurableNamespace,
  leasedExactReviewQueueItem,
  leasedExactReviewPublicationItem,
} from "./dashboard-worker-harness.ts";

test("state writer telemetry is optional, idempotent, and summary-safe", async () => {
  const storage = new MemoryDurableStorage();
  const items = Object.fromEntries(
    Array.from({ length: 2 }, (_, index) => {
      const item = leasedExactReviewPublicationItem(96_000 + index, `9600${index}`);
      return [item.key, item];
    }),
  );
  await storage.put("exact-review-queue", { deliveries: {}, items });
  const queue = new ExactReviewQueue({ storage }, {});
  const now = new Date().toISOString();
  const telemetry = {
    schema_version: 1,
    operation_id: "batch:telemetry-test",
    mode: "batch",
    started_at: now,
    finished_at: now,
    wait_ms: 1,
    acquire_attempts: 1,
    acquired: true,
    hold_ms: 2,
    renewals: 0,
    released: true,
    git_duration_ms: 3,
    git_processes: 4,
    commit_count: 1,
    materialized_items: 2,
    configured_batch_size: 2,
    actual_batch_size: 2,
    batch_wait_ms: 1,
    outcome: "materialized",
  };
  for (const item of Object.values(items)) {
    const response = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify({
          lease_id: item.leaseId,
          item_key: item.key,
          lease_revision: 1,
          claim_generation: 1,
          run_id: item.claimedRunId,
          run_attempt: 1,
          outcome: "success",
          completion_kind: "published",
          reason_code: "publication_applied",
          state_writer: telemetry,
        }),
      }),
    );
    assert.equal(response.status, 200);
  }
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.state_writer.last_15_minutes.operations, 1);
  assert.equal(stats.state_writer.last_15_minutes.state_commits, 1);
  assert.equal(stats.state_writer.last_15_minutes.materialized_items, 2);
  assert.equal(stats.state_writer.last_15_minutes.items_per_commit, 2);
  assert.equal(stats.state_writer.diagnostics.accepted_terminal_total, 1);
  assert.equal(stats.state_writer.diagnostics.duplicate_terminal_total, 1);
  assert.equal(stats.state_writer.diagnostics.state_commits_total, 1);
  assert.equal(stats.state_writer.diagnostics.materialized_items_total, 2);

  const malformed = leasedExactReviewPublicationItem(97_001, "97001");
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { [malformed.key]: malformed },
  });
  const rejected = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: malformed.leaseId,
        item_key: malformed.key,
        lease_revision: 1,
        claim_generation: 1,
        run_id: malformed.claimedRunId,
        run_attempt: 1,
        outcome: "success",
        completion_kind: "published",
        reason_code: "publication_applied",
        state_writer: { schema_version: 1, operation_id: "bad" },
      }),
    }),
  );
  assert.equal(rejected.status, 200);
  const afterReject = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(afterReject.state_writer.diagnostics.rejected_terminal_total, 1);

  const reviewOnly = leasedExactReviewQueueItem(97_002, "97002");
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { [reviewOnly.key]: reviewOnly },
  });
  const ignored = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: reviewOnly.leaseId,
        item_key: reviewOnly.key,
        lease_revision: 1,
        claim_generation: 1,
        run_id: reviewOnly.claimedRunId,
        run_attempt: 1,
        outcome: "success",
        state_writer: telemetry,
      }),
    }),
  );
  assert.equal(ignored.status, 200);
  const afterIgnore = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(afterIgnore.state_writer.last_15_minutes.operations, 1);
  assert.equal(afterIgnore.state_writer.diagnostics.rejected_terminal_total, 2);
});

test("exact-review queue drops the retired per-item review telemetry table", async () => {
  const storage = new MemoryDurableStorage();
  storage.sql.exec(
    `CREATE TABLE exact_review_review_telemetry (
       repo TEXT NOT NULL,
       item_number INTEGER NOT NULL,
       run_id TEXT NOT NULL,
       run_attempt INTEGER NOT NULL,
       status TEXT NOT NULL,
       updated_at INTEGER NOT NULL,
       record_json TEXT NOT NULL,
       PRIMARY KEY (repo, item_number, run_id, run_attempt)
     ) STRICT`,
  );
  storage.sql.exec(
    `CREATE INDEX exact_review_review_telemetry_status
       ON exact_review_review_telemetry (status, updated_at)`,
  );
  storage.sql.exec(
    `CREATE INDEX exact_review_review_telemetry_aggregate
       ON exact_review_review_telemetry (repo, updated_at)`,
  );
  storage.sql.exec(
    `CREATE INDEX exact_review_review_telemetry_operation
       ON exact_review_review_telemetry (run_id, run_attempt)`,
  );

  const queue = new ExactReviewQueue({ storage }, {});
  const response = await queue.fetch(new Request("https://queue/stats"));
  assert.equal(response.status, 200);
  const stats = (await response.json()) as Record<string, unknown>;
  assert.ok(!Object.hasOwn(stats, "review_telemetry_health"));
  assert.deepEqual(
    Array.from(
      storage.sql.exec(
        `SELECT name FROM sqlite_master
          WHERE name LIKE 'exact_review_review_telemetry%' ORDER BY name`,
      ),
    ),
    [],
  );
  assert.equal(
    Array.from(
      storage.sql.exec(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'exact_review_run_telemetry'`,
      ),
    ).length,
    1,
  );
});

test("removed per-item review telemetry write routes return not found", async () => {
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: "test-token-placeholder",
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const queuePost = await queue.fetch(
    new Request("https://queue/review-telemetry", { method: "POST", body: "{}" }),
  );
  const queueGet = await queue.fetch(new Request("https://queue/review-telemetry"));
  const internal = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/review-telemetry", {
      method: "POST",
      body: "{}",
    }),
    env,
  );
  assert.deepEqual([queuePost.status, queueGet.status, internal.status], [404, 404, 404]);
});

test("public per-item review read contract returns a stable empty envelope", async () => {
  const response = await worker.fetch(
    new Request(
      "https://clawsweeper.openclaw.ai/api/exact-review-queue/reviews?repo=openclaw%2Fopenclaw&item_number=674&limit=100",
    ),
    {},
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    collection: { state: "complete", scope: "aggregate_only" },
    reviews: [],
  });
});

test("public per-item review read contract ignores identifying queries", async () => {
  const response = await worker.fetch(
    new Request(
      "https://clawsweeper.openclaw.ai/api/exact-review-queue/reviews?repo=openclaw&item_number=0&limit=101",
    ),
    {},
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    collection: { state: "complete", scope: "aggregate_only" },
    reviews: [],
  });
});

test("review observer write is signed while aggregate telemetry remains read-only", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const record = JSON.stringify({
    run_id: "60000",
    run_attempt: 1,
    workflow_outcome: "success",
    trigger_lane: "normal_backfill",
    trigger_origin: "schedule",
    target_repo: "openclaw/openclaw",
    started_at: new Date(Date.now() - 60_000).toISOString(),
    completed_at: new Date().toISOString(),
    run_url: "https://github.com/openclaw/clawsweeper/actions/runs/60000",
    plan_count: 1,
    item_count: 4,
    publication_count: 1,
  });
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: "test-token-placeholder",
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const denied = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/review-run-telemetry", {
      method: "POST",
      body: record,
    }),
    env,
  );
  assert.equal(denied.status, 401);

  const signature = `sha256=${createHmac("sha256", "test-token-placeholder").update(record).digest("hex")}`;
  const accepted = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/review-run-telemetry", {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": signature },
      body: record,
    }),
    env,
  );
  assert.equal(accepted.status, 200);
  const publicQueryMarker = ["synthetic", "review", "filter"].join("_");
  const aggregate = await worker.fetch(
    new Request(
      `https://clawsweeper.openclaw.ai/api/review-observability?range=24h&repo=${publicQueryMarker}`,
    ),
    env,
  );
  assert.equal(aggregate.status, 200);
  const body = (await aggregate.json()) as {
    mode: string;
    sources: Array<{ lane: string; run_count: number }>;
  };
  assert.equal(body.mode, "passive");
  assert.equal(body.sources.find((source) => source.lane === "normal_backfill")?.run_count, 1);
  assert.equal(JSON.stringify(body).includes(publicQueryMarker), false);
  assert.equal(Object.hasOwn(body, "repo"), false);
});
