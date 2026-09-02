import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  GITHUB_WEBHOOK_READ_MODEL_COMMENT_TTL_MS,
  GITHUB_WEBHOOK_READ_MODEL_WORKFLOW_TTL_MS,
  GithubWebhookReadModelStore,
  githubWebhookReadModelDeliveryFromWebhook,
} from "../dashboard/github-webhook-read-model.ts";
import worker, { ExactReviewQueue } from "../dashboard/worker.ts";
import {
  MemoryDurableNamespace,
  MemoryDurableStorage,
  leasedExactReviewQueueItem,
  signedGithubWebhookRequest,
} from "./dashboard-worker-harness.ts";
import { githubReadModelLeaseItemRequest } from "../dist/github-webhook-read-model-client.js";

const secret = "github-read-model-test-secret";
const repository = {
  full_name: "openclaw/openclaw",
  default_branch: "main",
  private: false,
  archived: false,
  fork: false,
  has_issues: true,
};

test("read model dedupes GUIDs, keeps object watermarks monotonic, tombstones, and TTL", async () => {
  const storage = new MemoryDurableStorage();
  const store = new GithubWebhookReadModelStore(storage);
  store.ensureSchemaSync();
  const newer = requiredDelivery("issues", "guid-newer", "2026-08-14T10:05:00.000Z", {
    action: "labeled",
    repository,
    issue: issue(42, "new title", "2026-08-14T10:05:00.000Z"),
  });
  const old = requiredDelivery("issues", "guid-old", "2026-08-14T10:00:00.000Z", {
    action: "assigned",
    repository,
    issue: issue(42, "old title", "2026-08-14T10:00:00.000Z"),
  });
  assert.deepEqual(store.ingest(newer), { accepted: true, deduped: false, watermark: 1 });
  assert.deepEqual(store.ingest(newer), { accepted: true, deduped: true, watermark: 1 });
  assert.deepEqual(store.ingest(old), { accepted: true, deduped: false, watermark: 2 });
  const itemSnapshot = await store.readItem(
    { repository: "openclaw/openclaw", number: 42 },
    Date.parse("2026-08-14T10:06:00.000Z"),
  );
  assert.equal((itemSnapshot.item as Record<string, unknown>).title, "new title");
  assert.equal(itemSnapshot.watermark, 2);
  assert.equal(itemSnapshot.object_watermark, 1, "late delivery cannot regress the item");

  for (const [deliveryId, action, body, updatedAt] of [
    ["comment-create", "created", "placeholder", "2026-08-14T10:01:00.000Z"],
    ["comment-delete", "deleted", "placeholder", "2026-08-14T10:03:00.000Z"],
    ["comment-late-edit", "edited", "resurrected", "2026-08-14T10:02:00.000Z"],
  ] as const) {
    store.ingest(
      requiredDelivery("issue_comment", deliveryId, updatedAt, {
        action,
        repository,
        issue: issue(42, "new title", updatedAt),
        comment: {
          id: 9001,
          body,
          created_at: "2026-08-14T10:01:00.000Z",
          updated_at: updatedAt,
          user: { login: "clawsweeper[bot]", type: "Bot" },
        },
      }),
    );
  }
  const comments = await store.readComments(
    { repository: "openclaw/openclaw", number: 42 },
    Date.parse("2026-08-14T10:04:00.000Z"),
  );
  assert.deepEqual(comments.comments, []);
  assert.deepEqual(comments.tombstones, [9001]);
  assert.equal(comments.usable, true);
  const stale = await store.readComments(
    { repository: "openclaw/openclaw", number: 42 },
    Date.parse("2026-08-14T10:03:00.000Z") + GITHUB_WEBHOOK_READ_MODEL_COMMENT_TTL_MS + 1,
  );
  assert.equal(stale.usable, false);
  assert.equal((stale.freshness as Record<string, unknown>).stale, true);
});

test("receipt expiry upgrades existing databases idempotently and uses a SQLite range search", (t) => {
  const { storage, store, now } = receiptExpiryFixture();
  storage.sql.exec(`DROP INDEX ${receiptTimeIndex}`);
  const before = readModelState(storage);
  const queries: { query: string; bindings: unknown[] }[] = [];
  const exec = storage.sql.exec.bind(storage.sql);
  t.mock.method(storage.sql, "exec", (query: string, ...bindings: unknown[]) => {
    queries.push({ query, bindings });
    return exec(query, ...bindings);
  });
  new GithubWebhookReadModelStore(storage).ensureSchemaSync();
  store.ensureSchemaSync();
  assert.deepEqual(readModelState(storage), before);
  assert.deepEqual(
    [...exec(`SELECT name FROM pragma_index_info('${receiptTimeIndex}')`)].map((row) => row.name),
    ["received_at"],
  );
  store.ingest(receiptDelivery("plan", now), now);
  const prune = queries.find(({ query }) => query.startsWith(`DELETE FROM ${receiptTable} `));
  assert.ok(prune);
  const plan = [...exec(`EXPLAIN QUERY PLAN ${prune.query}`, ...prune.bindings)]
    .map((row) => row.detail)
    .join("\n");
  assert.match(plan, new RegExp(`SEARCH ${receiptTable} USING INDEX ${receiptTimeIndex}`));
  assert.doesNotMatch(plan, new RegExp(`SCAN ${receiptTable}|USE TEMP B-TREE FOR ORDER BY`));
  assert.throws(
    () => exec(`INSERT INTO ${receiptTable} VALUES ('retained', 'issues', 'edited', ?, 9999)`, now),
    /UNIQUE constraint failed/,
  );
  assert.throws(
    () => exec(`INSERT INTO ${receiptTable} VALUES ('other', 'issues', 'edited', ?, 1)`, now),
    /UNIQUE constraint failed/,
  );
});

for (const tied of [false, true]) {
  test(`receipt expiry preserves bounded drain, cutoff and replay (tied=${tied})`, () => {
    const controls = [false, true].map((indexed) => {
      const fixture = receiptExpiryFixture(tied);
      if (!indexed) fixture.storage.sql.exec(`DROP INDEX ${receiptTimeIndex}`);
      return fixture;
    });
    const outcomes = controls.map(({ storage, store, now, cutoff }) => {
      const before = readModelState(storage);
      assert.deepEqual(store.ingest(receiptDelivery(expiredReceiptId(0), now), now), {
        accepted: true,
        deduped: true,
        watermark: 2,
      });
      assert.deepEqual(readModelState(storage), before, "expired but retained GUID skips prune");
      const batches = [];
      for (let i = 0; i < 4; i += 1) {
        const previous = receiptIds(storage);
        assert.deepEqual(store.ingest(receiptDelivery(`drain-${i}`, now), now), {
          accepted: true,
          deduped: false,
          watermark: 604 + i,
        });
        const remaining = new Set(receiptIds(storage));
        const deleted = previous.filter((id) => !remaining.has(id));
        assert.equal(deleted.length, [256, 256, 88, 0][i]);
        if (!tied) {
          assert.deepEqual(
            deleted,
            Array.from({ length: deleted.length }, (_, j) => expiredReceiptId(i * 256 + j)).sort(),
          );
        }
        batches.push({ deleted, state: readModelState(storage) });
      }
      assert.deepEqual(
        [
          ...storage.sql.exec(
            `SELECT delivery_id FROM ${receiptTable} WHERE received_at <= ? ORDER BY received_at`,
            cutoff + 1,
          ),
        ].map((row) => row.delivery_id),
        ["at-cutoff", "after-cutoff"],
      );
      const drained = readModelState(storage);
      assert.deepEqual(store.ingest(receiptDelivery("drain-0", now), now), {
        accepted: true,
        deduped: true,
        watermark: 604,
      });
      assert.deepEqual(
        readModelState(storage),
        drained,
        "duplicate cannot regress global watermark",
      );
      assert.deepEqual(store.ingest(receiptDelivery(expiredReceiptId(0), now), now), {
        accepted: true,
        deduped: false,
        watermark: 608,
      });
      return { batches, replayed: readModelState(storage) };
    });
    // A local SQLite control, not a promise of SQL tie order across engines.
    assert.deepEqual(outcomes[1], outcomes[0]);
  });
}

test("receipt expiry and watermark writes roll back together after a later prune failure", (t) => {
  const { storage, store, now } = receiptExpiryFixture();
  const before = readModelState(storage);
  const exec = storage.sql.exec.bind(storage.sql);
  let pruned = 0;
  t.mock.method(storage.sql, "exec", (query: string, ...bindings: unknown[]) => {
    const result = exec(query, ...bindings);
    if (query.startsWith(`DELETE FROM ${receiptTable} `)) pruned = result.rowsWritten;
    return result;
  });
  storage.failNextSql(/DELETE FROM github_webhook_read_model_workflows_v1/);
  assert.throws(() => store.ingest(receiptDelivery("retry", now), now), /injected SQL failure/);
  assert.equal(pruned, 256, "failure occurs after receipt pruning");
  assert.deepEqual(readModelState(storage), before);
  assert.deepEqual(store.ingest(receiptDelivery("retry", now), now), {
    accepted: true,
    deduped: false,
    watermark: 604,
  });
  assert.equal(receiptIds(storage).length, 603 + 1 - 256);
});

const receiptTable = "github_webhook_read_model_deliveries_v1";
const receiptTimeIndex = "github_webhook_read_model_deliveries_received_at_v1";

function receiptDelivery(id: string, now: number) {
  const receivedAt = new Date(now).toISOString();
  return requiredDelivery("issues", id, receivedAt, {
    action: "edited",
    repository,
    issue: issue(42, id, receivedAt),
  });
}

function expiredReceiptId(i: number) {
  return createHash("sha256").update(`expired-${i}`).digest("hex");
}

function receiptExpiryFixture(tied = false) {
  const storage = new MemoryDurableStorage();
  const store = new GithubWebhookReadModelStore(storage);
  const now = Date.parse("2026-08-26T12:00:00Z");
  const cutoff = now - 30 * 24 * 60 * 60_000;
  store.ensureSchemaSync();
  store.ingest(receiptDelivery("retained", now - 1_000), now - 1_000);
  storage.transactionSync(() => {
    for (let i = 0; i < 600; i += 1) {
      storage.sql.exec(
        `INSERT INTO ${receiptTable} VALUES (?, 'issues', 'edited', ?, ?)`,
        expiredReceiptId(i),
        tied ? cutoff - 1 : cutoff - 600 + i,
        i + 2,
      );
    }
    storage.sql.exec(
      `INSERT INTO ${receiptTable} VALUES ('at-cutoff', 'issues', 'edited', ?, 602)`,
      cutoff,
    );
    storage.sql.exec(
      `INSERT INTO ${receiptTable} VALUES ('after-cutoff', 'issues', 'edited', ?, 603)`,
      cutoff + 1,
    );
    storage.sql.exec(
      `UPDATE github_webhook_read_model_meta_v1 SET watermark = 603, created_at = ?, updated_at = ?`,
      now - 1_000,
      now - 1_000,
    );
  });
  return { storage, store, now, cutoff };
}

function receiptIds(storage: MemoryDurableStorage) {
  return [...storage.sql.exec(`SELECT delivery_id FROM ${receiptTable} ORDER BY delivery_id`)].map(
    (row) => String(row.delivery_id),
  );
}

function readModelState(storage: MemoryDurableStorage) {
  return Object.fromEntries(
    [
      ...storage.sql.exec(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'github_webhook_read_model_%' ORDER BY name",
      ),
    ].map(({ name }) => [name, [...storage.sql.exec(`SELECT * FROM ${name} ORDER BY rowid`)]]),
  );
}

test("comment-count gaps force a repair poll and a complete repair heals the collection", async () => {
  const storage = new MemoryDurableStorage();
  const store = new GithubWebhookReadModelStore(storage);
  store.ensureSchemaSync();
  const updatedAt = "2026-08-14T11:00:00.000Z";
  store.ingest(
    requiredDelivery("issues", "gap-item", updatedAt, {
      action: "labeled",
      repository,
      issue: { ...issue(55, "gap", updatedAt), comments: 2 },
    }),
  );
  store.ingest(
    requiredDelivery("issue_comment", "gap-comment-one", updatedAt, {
      action: "created",
      repository,
      issue: { ...issue(55, "gap", updatedAt), comments: 2 },
      comment: { id: 5501, body: "one", created_at: updatedAt, updated_at: updatedAt },
    }),
  );
  const gap = await store.readComments(
    { repository: "openclaw/openclaw", number: 55 },
    Date.parse(updatedAt) + 1,
  );
  assert.equal(gap.gap_detected, true);
  assert.equal(gap.usable, false);
  store.repair(
    {
      repository: "openclaw/openclaw",
      repair_kind: "comments",
      complete_comment_items: [55],
      objects: [
        commentObject(55, 5501, "one", updatedAt),
        commentObject(55, 5502, "two", updatedAt),
      ],
    },
    Date.parse(updatedAt) + 2,
  );
  const healed = await store.readComments(
    { repository: "openclaw/openclaw", number: 55 },
    Date.parse(updatedAt) + 3,
  );
  assert.equal(healed.gap_detected, false);
  assert.equal(healed.usable, true);
  assert.equal((healed.comments as unknown[]).length, 2);
});

test("signed webhook loopback covers lifecycle, comments, reviews, checks, runs, and jobs", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
    hostedPublicTargetProbe: async () => "public" as const,
  };
  const now = new Date().toISOString();
  const events = [
    ["issues", "issue-labeled", { action: "labeled", issue: issue(77, "snapshot title", now) }],
    [
      "issue_comment",
      "comment-created",
      {
        action: "created",
        issue: issue(77, "snapshot title", now),
        comment: {
          id: 701,
          body: "ordinary non-command comment",
          created_at: now,
          updated_at: now,
          user: { login: "octocat", type: "User" },
        },
      },
    ],
    [
      "pull_request_review",
      "review-submitted",
      {
        action: "submitted",
        pull_request: pull(77, now),
        review: { id: 801, state: "approved", submitted_at: now, updated_at: now },
      },
    ],
    [
      "pull_request_review_comment",
      "review-comment-created",
      {
        action: "created",
        pull_request: pull(77, now),
        comment: { id: 802, body: "inline", created_at: now, updated_at: now },
      },
    ],
    [
      "workflow_run",
      "run-progress",
      { action: "in_progress", workflow_run: { id: 901, status: "in_progress", updated_at: now } },
    ],
    [
      "workflow_job",
      "job-progress",
      {
        action: "in_progress",
        workflow_job: { id: 902, run_id: 901, status: "in_progress", updated_at: now },
        workflow_run: { id: 901 },
      },
    ],
    [
      "check_run",
      "check-complete",
      { action: "completed", check_run: { id: 903, status: "completed", updated_at: now } },
    ],
  ] as const;
  for (const [event, deliveryId, value] of events) {
    const response = await worker.fetch(
      signedGithubWebhookRequest({
        event,
        secret,
        deliveryId,
        payload: { ...value, repository, installation: { id: 123 } },
      }),
      env,
    );
    assert.equal(response.status, 202, `${event} should be accepted`);
    assert.equal((await response.json()).materialized, true);
  }

  const item = await signedRead(env, "item", { repository: "openclaw/openclaw", number: 77 });
  assert.equal(item.usable, true);
  assert.equal((item.item as Record<string, unknown>).title, "snapshot title");
  const comments = await signedRead(env, "comments", {
    repository: "openclaw/openclaw",
    number: 77,
  });
  assert.equal(comments.usable, true);
  assert.equal((comments.comments as unknown[]).length, 1);
  const activity = await signedRead(env, "activity", {
    repository: "openclaw/openclaw",
    number: 77,
  });
  assert.equal(activity.usable, true);
  assert.deepEqual(activity.counts, { reviews: 1, review_comments: 1 });
  assert.match(String(activity.activity_digest), /^[0-9a-f]{64}$/);
  const partialWorkflows = await signedRead(env, "workflows", {
    repository: "openclaw/openclaw",
  });
  assert.equal(partialWorkflows.usable, false, "webhook rows alone are not a complete census");
  for (const invalidCoverage of [
    {},
    { repair_kind: "items", workflow_job_census_version: 2 },
    { workflow_job_census_version: "2" },
    { workflow_job_census_version: 2, complete_workflow_job_runs: ["901"] },
    { workflow_job_census_version: 2, workflow_job_census_started_at: null },
    { workflow_job_census_version: 2, workflow_job_census_started_at: "1171" },
    { workflow_job_census_version: 2, complete_workflow_job_runs: [901, 901] },
  ]) {
    await queue.fetch(
      new Request("https://queue/github-read-model/repair", {
        method: "POST",
        body: JSON.stringify({
          repository: "openclaw/openclaw",
          repair_kind: "workflows",
          complete_workflow_job_runs: [901],
          workflow_job_census_started_at: now,
          objects: [],
          ...invalidCoverage,
        }),
      }),
    );
  }
  const legacyCoverage = await signedRead(env, "workflows", {
    repository: "openclaw/openclaw",
  });
  assert.deepEqual(legacyCoverage.job_coverage_run_ids, []);
  await queue.fetch(
    new Request("https://queue/github-read-model/repair", {
      method: "POST",
      body: JSON.stringify({
        repository: "openclaw/openclaw",
        repair_kind: "workflows",
        workflow_run_census_complete: true,
        workflow_run_census_started_at: now,
        complete_workflow_job_runs: [901],
        workflow_job_census_started_at: now,
        workflow_job_census_version: 2,
        objects: [
          workflowObject("workflow_run", 901, 901, now, {
            id: 901,
            status: "in_progress",
            updated_at: now,
          }),
          workflowObject("workflow_job", 902, 901, now, {
            id: 902,
            run_id: 901,
            status: "in_progress",
            updated_at: now,
          }),
        ],
      }),
    }),
  );
  const workflows = await signedRead(env, "workflows", { repository: "openclaw/openclaw" });
  assert.equal(workflows.usable, true);
  assert.equal(workflows.jobs_usable, true);
  assert.deepEqual(workflows.job_coverage_run_ids, [901]);
  assert.equal((workflows.runs as unknown[]).length, 1);
  assert.equal((workflows.jobs as unknown[]).length, 1);
  assert.equal((workflows.checks as unknown[]).length, 1);

  const duplicate = await worker.fetch(
    signedGithubWebhookRequest({
      event: "workflow_job",
      secret,
      deliveryId: "job-progress",
      payload: {
        action: "in_progress",
        repository,
        installation: { id: 123 },
        workflow_job: { id: 902, run_id: 901, status: "in_progress", updated_at: now },
        workflow_run: { id: 901 },
      },
    }),
    env,
  );
  assert.equal(duplicate.status, 202);
  const afterDuplicate = await signedRead(env, "workflows", { repository: "openclaw/openclaw" });
  assert.equal(afterDuplicate.watermark, workflows.watermark);
});

test("read-model failures expose only endpoint-owned error codes", async () => {
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  const cases = [
    ["ingest", "invalid_github_webhook_read_model_delivery"],
    ["repair", "invalid_github_webhook_read_model_repair"],
    ["item", "invalid_github_webhook_read_model_item_request"],
    ["comments", "invalid_github_webhook_read_model_comments_request"],
    ["activity", "invalid_github_webhook_read_model_activity_request"],
    ["workflows", "invalid_github_webhook_read_model_workflows_request"],
    ["placeholders", "invalid_github_webhook_read_model_placeholders_request"],
  ] as const;

  for (const [operation, error] of cases) {
    const response = await queue.fetch(
      new Request(`https://queue/github-read-model/${operation}`, {
        method: "POST",
        body: JSON.stringify({ invalid: "private-path-marker" }),
      }),
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error });
  }
});

test("dashboard workflow snapshot preserves health decisions while removing run and job polls", async () => {
  const storage = new MemoryDurableStorage();
  const store = new GithubWebhookReadModelStore(storage);
  store.ensureSchemaSync();
  const now = new Date().toISOString();
  const run = {
    id: 9901,
    name: "Review",
    status: "in_progress",
    conclusion: null,
    updated_at: now,
  };
  const job = {
    id: 9902,
    run_id: 9901,
    name: "review shard",
    status: "in_progress",
    updated_at: now,
  };
  store.ingest(
    requiredDelivery("workflow_run", "status-run", now, {
      action: "in_progress",
      repository,
      workflow_run: run,
    }),
  );
  const partial = await store.readWorkflows(
    { repository: "openclaw/openclaw" },
    Date.parse(now) + 1,
  );
  assert.equal(partial.usable, false);
  store.repair(
    {
      repository: "openclaw/openclaw",
      repair_kind: "workflows",
      workflow_run_census_complete: true,
      workflow_run_census_started_at: now,
      complete_workflow_job_runs: [9901],
      workflow_job_census_started_at: now,
      workflow_job_census_version: 2,
      objects: [
        workflowObject("workflow_run", 9901, 9901, now, run),
        workflowObject("workflow_job", 9902, 9901, now, job),
      ],
    },
    Date.parse(now) + 1,
  );
  const censusWithoutJobSubscription = await store.readWorkflows(
    { repository: "openclaw/openclaw" },
    Date.parse(now) + 1,
  );
  assert.equal(censusWithoutJobSubscription.usable, true);
  assert.deepEqual(
    censusWithoutJobSubscription.job_coverage_run_ids,
    [],
    "a repair census cannot impersonate the missing workflow_job subscription",
  );
  store.ingest(
    requiredDelivery("workflow_job", "status-job", now, {
      action: "in_progress",
      repository,
      workflow_run: { id: 9901 },
      workflow_job: job,
    }),
  );
  let githubRequests = 0;
  const pollDecision = (() => {
    githubRequests += 2 + 5 + 1;
    return workflowHealthDecision([run], [job]);
  })();
  assert.equal(githubRequests, 8);
  const snapshot = await store.readWorkflows(
    { repository: "openclaw/openclaw" },
    Date.parse(now) + 1,
  );
  const snapshotDecision = workflowHealthDecision(
    snapshot.runs as Array<Record<string, unknown>>,
    snapshot.jobs as Array<Record<string, unknown>>,
  );
  assert.deepEqual(snapshotDecision, pollDecision);
  assert.equal(githubRequests, 8, "the snapshot decision adds no GitHub requests");
});

test("dashboard health revalidates and evicts stale phantom queued runs", async () => {
  for (const liveVerdict of ["completed", "absent", "queued", "error", "zombie"] as const) {
    const storage = new MemoryDurableStorage();
    const store = new GithubWebhookReadModelStore(storage);
    store.ensureSchemaSync();
    const queue = new ExactReviewQueue({ storage }, {});
    const observedAtMs = Date.now() - GITHUB_WEBHOOK_READ_MODEL_WORKFLOW_TTL_MS - 60_000;
    const observedAt = new Date(observedAtMs).toISOString();
    const createdAt = new Date(
      Date.now() - (liveVerdict === "zombie" ? 25 * 60 * 60_000 : 60 * 60_000),
    ).toISOString();
    const staleRun = {
      id: 9911,
      name: "Review",
      display_title: "Review event item openclaw/openclaw#9911",
      status: "queued",
      conclusion: null,
      created_at: createdAt,
      updated_at: observedAt,
    };
    store.ingest(
      requiredDelivery("workflow_run", `phantom-${liveVerdict}`, observedAt, {
        action: "requested",
        repository,
        workflow_run: staleRun,
      }),
      observedAtMs,
    );
    store.repair(
      {
        repository: "openclaw/openclaw",
        repair_kind: "workflows",
        workflow_run_census_complete: true,
        // Model the census race: this row arrived after the census began, so
        // reconciliation preserved it even though the completed census omitted it.
        workflow_run_census_started_at: new Date(observedAtMs - 1).toISOString(),
        objects: [],
      },
      Date.now() - 30_000,
    );
    const seeded = await store.readWorkflows({ repository: "openclaw/openclaw" });
    assert.equal(seeded.usable, true);
    assert.equal((seeded.runs as unknown[]).length, 1);

    const originalFetch = globalThis.fetch;
    const originalCaches = globalThis.caches;
    const originalWarn = console.warn;
    const warnings: string[] = [];
    Object.defineProperty(globalThis, "caches", {
      configurable: true,
      value: { default: { match: async () => undefined, put: async () => undefined } },
    });
    console.warn = (...values: unknown[]) => warnings.push(values.map(String).join(" "));
    let exactRunRequests = 0;
    globalThis.fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/repos/openclaw/openclaw/actions/runs/9911") {
        exactRunRequests += 1;
        if (liveVerdict === "zombie") throw new Error("zombie must not be reverified");
        if (liveVerdict === "absent") return jsonResponse({ message: "Not Found" }, 404);
        if (liveVerdict === "error") return jsonResponse({ message: "Unavailable" }, 503);
        return jsonResponse(
          liveVerdict === "completed"
            ? { ...staleRun, status: "completed", conclusion: "success", updated_at: new Date() }
            : staleRun,
        );
      }
      if (url.pathname.includes("/actions/workflows/") || url.pathname.endsWith("/actions/runs")) {
        return jsonResponse({ workflow_runs: [] });
      }
      if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
      if (url.pathname.includes("/issues")) return jsonResponse([]);
      throw new Error(`unexpected fetch ${url}`);
    };
    try {
      const response = await worker.fetch(
        new Request("https://clawsweeper.openclaw.ai/api/status"),
        {
          CLAWSWEEPER_REPO: "openclaw/openclaw",
          TARGET_REPOS: "openclaw/openclaw",
          CACHE_TTL_SECONDS: "0",
          CLAWSWEEPER_WEBHOOK_SECRET: secret,
          EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
        },
        { waitUntil: () => undefined },
      );
      const status = (await response.json()) as {
        operational_health: {
          status: string;
          queued_over_threshold: number;
          zombie_queued_runs: number;
        };
      };
      if (liveVerdict === "zombie") {
        assert.equal(status.operational_health.status, "healthy");
        assert.equal(status.operational_health.queued_over_threshold, 0);
        assert.equal(status.operational_health.zombie_queued_runs, 1);
        assert.equal(exactRunRequests, 0);
      } else if (liveVerdict === "error") {
        assert.equal(status.operational_health.status, "unknown");
        assert.equal(status.operational_health.queued_over_threshold, 0);
        assert.equal(
          warnings.some((line) => line.includes("github_read_model_workflow_run_evicted")),
          false,
        );
      } else if (liveVerdict === "queued") {
        assert.equal(status.operational_health.status, "degraded");
        assert.equal(status.operational_health.queued_over_threshold, 1);
        assert.equal(
          warnings.some((line) => line.includes("github_read_model_workflow_run_evicted")),
          false,
        );
        const confirmed = await store.readWorkflows({ repository: "openclaw/openclaw" });
        const observation = (confirmed.run_observations as Array<Record<string, unknown>>)[0];
        assert.ok(Date.parse(String(observation.confirmed_at)) > observedAtMs);
      } else {
        assert.equal(status.operational_health.status, "healthy");
        assert.equal(status.operational_health.queued_over_threshold, 0);
        assert.equal(
          warnings.some(
            (line) =>
              line.includes("github_read_model_workflow_run_evicted") &&
              line.includes(`"verdict":"${liveVerdict}"`),
          ),
          true,
        );
        const healed = await store.readWorkflows({ repository: "openclaw/openclaw" });
        assert.deepEqual(healed.runs, []);
      }
    } finally {
      globalThis.fetch = originalFetch;
      console.warn = originalWarn;
      Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
    }
  }
});

test("dashboard health caps stale queued-run revalidation and drains oldest rows first", async () => {
  const storage = new MemoryDurableStorage();
  const store = new GithubWebhookReadModelStore(storage);
  store.ensureSchemaSync();
  const queue = new ExactReviewQueue({ storage }, {});
  const observedAtMs = Date.now() - GITHUB_WEBHOOK_READ_MODEL_WORKFLOW_TTL_MS - 60_000;
  const observedAt = new Date(observedAtMs).toISOString();
  const staleRunCount = 205;
  const expectedBatchSize = 10;
  const runIds = Array.from({ length: staleRunCount }, (_, index) => 10_000 + index);

  for (const [index, runId] of runIds.entries()) {
    store.ingest(
      requiredDelivery("workflow_run", `stale-batch-${runId}`, observedAt, {
        action: "requested",
        repository,
        workflow_run: {
          id: runId,
          name: "Review",
          display_title: `Review event item openclaw/openclaw#${runId}`,
          status: "queued",
          conclusion: null,
          created_at: new Date(Date.now() - (60 + index) * 60_000).toISOString(),
          updated_at: observedAt,
        },
      }),
      observedAtMs,
    );
  }
  store.repair(
    {
      repository: "openclaw/openclaw",
      repair_kind: "workflows",
      workflow_run_census_complete: true,
      workflow_run_census_started_at: new Date(observedAtMs - 1).toISOString(),
      objects: [],
    },
    Date.now() - 30_000,
  );

  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const originalWarn = console.warn;
  const warnings: string[] = [];
  const exactRunRequests: number[] = [];
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: { match: async () => undefined, put: async () => undefined } },
  });
  console.warn = (...values: unknown[]) => warnings.push(values.map(String).join(" "));
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const exactRun = url.pathname.match(/^\/repos\/openclaw\/openclaw\/actions\/runs\/(\d+)$/);
    if (exactRun) {
      exactRunRequests.push(Number(exactRun[1]));
      await new Promise((resolve) => setTimeout(resolve, 40));
      return jsonResponse({ message: "Not Found" }, 404);
    }
    if (url.pathname.includes("/actions/workflows/") || url.pathname.endsWith("/actions/runs")) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname.includes("/issues")) return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    let remaining = staleRunCount;
    let refreshes = 0;
    while (remaining > 0) {
      const requestsBefore = exactRunRequests.length;
      const startedAt = Date.now();
      const response = await worker.fetch(
        new Request("https://clawsweeper.openclaw.ai/api/status"),
        {
          CLAWSWEEPER_REPO: "openclaw/openclaw",
          TARGET_REPOS: "openclaw/openclaw",
          CACHE_TTL_SECONDS: "0",
          CLAWSWEEPER_WEBHOOK_SECRET: secret,
          EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
        },
        { waitUntil: () => undefined },
      );
      const elapsedMs = Date.now() - startedAt;
      const status = (await response.json()) as {
        operational_health: { status: string; queued_over_threshold: number };
      };
      const batchSize = Math.min(expectedBatchSize, remaining);
      assert.equal(exactRunRequests.length - requestsBefore, batchSize);
      assert.ok(elapsedMs < 500, `bounded refresh took ${elapsedMs}ms`);
      remaining -= batchSize;
      refreshes += 1;
      assert.equal(status.operational_health.queued_over_threshold, 0);
      assert.equal(status.operational_health.status, remaining > 0 ? "unknown" : "healthy");

      const snapshot = await store.readWorkflows({ repository: "openclaw/openclaw" });
      assert.equal((snapshot.runs as unknown[]).length, remaining);
    }

    assert.equal(refreshes, Math.ceil(staleRunCount / expectedBatchSize));
    assert.deepEqual(
      exactRunRequests.slice(0, expectedBatchSize).toSorted((left, right) => left - right),
      runIds.slice(-expectedBatchSize),
    );
    assert.deepEqual(
      exactRunRequests.toSorted((left, right) => left - right),
      runIds,
      "successive refreshes select every stale row exactly once",
    );
    assert.ok(
      warnings.some(
        (line) =>
          line.includes('"event":"github_read_model_workflow_run_revalidation_batch"') &&
          line.includes(`"batch_size":${expectedBatchSize}`) &&
          line.includes(`"omitted_count":${staleRunCount - expectedBatchSize}`),
      ),
      "batch telemetry records the cap and omitted count",
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard health ignores repair-fed workflow rows without subscription coverage", async () => {
  const storage = new MemoryDurableStorage();
  const store = new GithubWebhookReadModelStore(storage);
  store.ensureSchemaSync();
  const queue = new ExactReviewQueue({ storage }, {});
  const now = new Date().toISOString();
  const phantom = {
    id: 9921,
    status: "queued",
    created_at: new Date(Date.now() - 60 * 60_000).toISOString(),
    updated_at: now,
  };
  store.repair(
    {
      repository: "openclaw/openclaw",
      repair_kind: "workflows",
      workflow_run_census_complete: true,
      workflow_run_census_started_at: now,
      objects: [workflowObject("workflow_run", 9921, 9921, now, phantom)],
    },
    Date.now(),
  );
  const repairOnly = await store.readWorkflows({ repository: "openclaw/openclaw" });
  assert.equal(repairOnly.usable, false);
  assert.equal((repairOnly.class_state as Record<string, unknown>).reason, "never_observed");

  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: { match: async () => undefined, put: async () => undefined } },
  });
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.includes("/actions/workflows/") || url.pathname.endsWith("/actions/runs")) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname.includes("/issues")) return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/openclaw",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
        CLAWSWEEPER_WEBHOOK_SECRET: secret,
        EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
      },
      { waitUntil: () => undefined },
    );
    const status = (await response.json()) as {
      operational_health: { status: string; queued_over_threshold: number };
    };
    assert.equal(status.operational_health.status, "healthy");
    assert.equal(status.operational_health.queued_over_threshold, 0);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("exact-review lease capability reads only its own item without the webhook secret", async () => {
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      "openclaw/openclaw#700": leasedExactReviewQueueItem(700, "7000"),
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const now = new Date().toISOString();
  await queue.fetch(
    new Request("https://queue/github-read-model/ingest", {
      method: "POST",
      body: JSON.stringify(
        requiredDelivery("issues", "lease-item", now, {
          action: "labeled",
          repository,
          issue: issue(700, "lease snapshot", now),
        }),
      ),
    }),
  );
  const env = { EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue) };
  const lease = githubReadModelLeaseItemRequest(
    { repository: "openclaw/openclaw", number: 700 },
    {
      QUEUE_URL: "https://clawsweeper.openclaw.ai",
      EXACT_REVIEW_ITEM_KEY: "openclaw/openclaw#700",
      EXACT_REVIEW_LEASE_ID: "lease-700",
      EXACT_REVIEW_LEASE_REVISION: "1",
      EXACT_REVIEW_CLAIM_GENERATION: "1",
      GITHUB_RUN_ID: "7000",
      GITHUB_RUN_ATTEMPT: "1",
    },
  );
  assert.ok(lease);
  const response = await worker.fetch(
    new Request(lease.url, { method: "POST", body: lease.body }),
    env,
  );
  assert.equal(response.status, 200);
  const snapshot = (await response.json()) as Record<string, unknown>;
  assert.equal(snapshot.lease_authorized, true);
  assert.equal(snapshot.usable, true);
  assert.equal((snapshot.item as Record<string, unknown>).title, "lease snapshot");

  const forged = JSON.parse(lease.body);
  forged.claim_generation = 2;
  const rejected = await worker.fetch(
    new Request(lease.url, { method: "POST", body: JSON.stringify(forged) }),
    env,
  );
  assert.equal(rejected.status, 409);
});

test("exact-review workflow exposes the scoped lease tuple but not the shared webhook secret", () => {
  const workflow = readFileSync(".github/workflows/sweep.yml", "utf8");
  const start = workflow.indexOf("- name: Review exact event item");
  const end = workflow.indexOf("\n      - name:", start + 1);
  const step = workflow.slice(start, end);
  assert.match(step, /EXACT_REVIEW_ITEM_KEY:/);
  assert.match(step, /EXACT_REVIEW_LEASE_ID:/);
  assert.match(step, /EXACT_REVIEW_LEASE_REVISION:/);
  assert.match(step, /EXACT_REVIEW_CLAIM_GENERATION:/);
  assert.match(step, /QUEUE_URL:/);
  assert.doesNotMatch(step, /CLAWSWEEPER_WEBHOOK_SECRET:/);
});

function issue(number: number, title: string, updatedAt: string) {
  return {
    number,
    title,
    body: "body",
    html_url: `https://github.com/openclaw/openclaw/issues/${number}`,
    state: "open",
    locked: false,
    created_at: "2026-08-14T09:00:00.000Z",
    updated_at: updatedAt,
    author_association: "CONTRIBUTOR",
    user: { login: "octocat", type: "User" },
    labels: [{ name: "bug" }],
  };
}

function pull(number: number, updatedAt: string) {
  return {
    ...issue(number, "pull title", updatedAt),
    head: { sha: "a".repeat(40) },
    base: { sha: "b".repeat(40) },
    draft: false,
  };
}

function requiredDelivery(event: string, deliveryId: string, receivedAt: string, payload: unknown) {
  const delivery = githubWebhookReadModelDeliveryFromWebhook({
    event,
    deliveryId,
    receivedAt,
    payload,
  });
  assert.ok(delivery);
  return delivery;
}

function commentObject(number: number, id: number, body: string, updatedAt: string) {
  return {
    kind: "comment",
    repository: "openclaw/openclaw",
    number,
    id,
    sourceUpdatedAt: updatedAt,
    tombstone: false,
    snapshot: { id, body, created_at: updatedAt, updated_at: updatedAt },
  };
}

function workflowObject(
  kind: "workflow_run" | "workflow_job",
  id: number,
  runId: number,
  updatedAt: string,
  snapshot: Record<string, unknown>,
) {
  return {
    kind,
    repository: "openclaw/openclaw",
    id,
    runId,
    sourceUpdatedAt: updatedAt,
    snapshot,
  };
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function workflowHealthDecision(
  runs: Array<Record<string, unknown>>,
  jobs: Array<Record<string, unknown>>,
) {
  return {
    active_runs: runs.filter((run) => run.status === "in_progress").length,
    failed_runs: runs.filter((run) => run.status === "completed" && run.conclusion === "failure")
      .length,
    active_jobs: jobs.filter((job) => job.status === "in_progress").length,
  };
}

async function signedRead(
  env: Record<string, unknown>,
  operation: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const response = await worker.fetch(
    new Request(`https://clawsweeper.openclaw.ai/internal/state/github-read-model/${operation}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clawsweeper-exact-review-signature": signature,
      },
      body,
    }),
    env,
  );
  assert.equal(response.status, 200);
  return (await response.json()) as Record<string, unknown>;
}
