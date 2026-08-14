import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  GITHUB_WEBHOOK_READ_MODEL_COMMENT_TTL_MS,
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
