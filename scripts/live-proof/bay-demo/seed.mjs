#!/usr/bin/env node

import { createHmac } from "node:crypto";

const origin = String(
  process.argv[2] || process.env.BAY_DEMO_ORIGIN || "http://127.0.0.1:8787",
).replace(/\/+$/, "");
const secret = String(process.env.BAY_DEMO_WEBHOOK_SECRET || "").trim();
if (!secret) throw new Error("BAY_DEMO_WEBHOOK_SECRET is required");

const repository = "openclaw/clawsweeper";
const itemNumbers = [1180, 1179, 1178, 1177, 1176, 1175];

function signature(body) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function postSigned(path, value, expected = [200, 202]) {
  const body = JSON.stringify(value);
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-clawsweeper-exact-review-signature": signature(body),
    },
    body,
  });
  const text = await response.text();
  if (!expected.includes(response.status)) {
    throw new Error(`${path} returned ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function postWebhook(event, deliveryId, payload) {
  const body = JSON.stringify(payload);
  const response = await fetch(`${origin}/github/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": signature(body),
    },
    body,
  });
  const text = await response.text();
  if (response.status !== 202) {
    throw new Error(`/github/webhook (${event}) returned ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

function marker(number) {
  return `<!-- clawsweeper-command-status:${number}:re_review:${number.toString(16).padStart(40, "0")} -->`;
}

function identity(number) {
  return {
    canonical_target_key: `${repository}#${number}`,
    fence_key: `${repository}#${number}`,
    revision: 1,
  };
}

async function seedLifecycle() {
  for (const number of itemNumbers) {
    await postSigned("/internal/exact-review/enqueue", {
      delivery_id: `local-bay-demo:${number}:v1`,
      decision: {
        targetRepo: repository,
        targetBranch: "main",
        itemNumber: number,
        itemKind: "issue",
        sourceEvent: "issues",
        sourceAction: "legacy_dispatch",
        supersedesInProgress: false,
        commandStatusMarker: marker(number),
        statusCommentId: 900000 + number,
      },
    });
  }

  await postSigned("/internal/exact-review/claimed-runs", {
    runs: [],
    include_all_claimed: true,
  });

  await postSigned("/internal/exact-review/lifecycle/canonical-receipt", {
    ...identity(1179),
    outcome: "accepted",
    receipt_id: "local-bay-demo:1179:canonical",
  });
  await postSigned("/internal/exact-review/lifecycle/router-receipt", {
    ...identity(1179),
    outcome: "durable",
    receipt_id: "local-bay-demo:1179:router",
  });

  await postSigned("/internal/exact-review/lifecycle/canonical-receipt", {
    ...identity(1178),
    outcome: "accepted",
    receipt_id: "local-bay-demo:1178:canonical",
  });
  await postSigned("/internal/exact-review/lifecycle/router-receipt", {
    ...identity(1178),
    outcome: "durable",
    receipt_id: "local-bay-demo:1178:router",
  });
  await postSigned("/internal/exact-review/lifecycle/command-ack/attempt", {
    ...identity(1178),
    status_marker: marker(1178),
    status_comment_id: 901178,
  });
  await postSigned("/internal/exact-review/lifecycle/command-ack/observed", {
    ...identity(1178),
    status_marker: marker(1178),
    command_comment_id: 801178,
    completion_comment_id: 901178,
    status_comment_id: 901178,
    observed_at: Date.now(),
  });

  for (const [number, kind] of [
    [1177, "superseded"],
    [1176, "requeue"],
    [1175, "dead_letter"],
  ]) {
    await postSigned("/internal/exact-review/lifecycle/terminal-disposition", {
      ...identity(number),
      kind,
    });
  }
}

const stageFixtures = [
  {
    number: 1180,
    runId: 990001,
    jobId: 991001,
    runStatus: "queued",
    jobStatus: "queued",
    jobName: "Review shard openclaw/clawsweeper#1180",
    steps: [{ number: 1, name: "Set up job", status: "queued", conclusion: null }],
  },
  {
    number: 1179,
    runId: 990002,
    jobId: 991002,
    runStatus: "in_progress",
    jobStatus: "in_progress",
    jobName: "Review shard openclaw/clawsweeper#1179",
    steps: [{ number: 1, name: "Set up job", status: "in_progress", conclusion: null }],
  },
  {
    number: 1178,
    runId: 990003,
    jobId: 991003,
    runStatus: "in_progress",
    jobStatus: "in_progress",
    jobName: "Review shard openclaw/clawsweeper#1178",
    steps: [
      { number: 1, name: "Check out repository", status: "completed", conclusion: "success" },
      { number: 2, name: "Install dependencies", status: "completed", conclusion: "success" },
      { number: 3, name: "Run Codex review", status: "in_progress", conclusion: null },
    ],
  },
  {
    number: 1177,
    runId: 990004,
    jobId: 991004,
    runStatus: "in_progress",
    jobStatus: "in_progress",
    jobName: "Publish exact review artifacts openclaw/clawsweeper#1177",
    steps: [
      {
        number: 1,
        name: "Claim durable exact review publication",
        status: "completed",
        conclusion: "success",
      },
      { number: 2, name: "Publish review artifacts", status: "in_progress", conclusion: null },
    ],
  },
  {
    number: 1176,
    runId: 990005,
    jobId: 991005,
    runStatus: "in_progress",
    jobStatus: "in_progress",
    jobName: "Publish exact review artifacts openclaw/clawsweeper#1176",
    steps: [
      { number: 1, name: "Publish review artifacts", status: "completed", conclusion: "success" },
      {
        number: 2,
        name: "Finalize healthy members under a fenced heartbeat",
        status: "in_progress",
        conclusion: null,
      },
    ],
  },
  {
    number: 1175,
    runId: 990006,
    jobId: 991006,
    runStatus: "in_progress",
    jobStatus: "in_progress",
    jobName: "Review shard openclaw/clawsweeper#1175",
    steps: [
      { number: 1, name: "Run Codex review", status: "completed", conclusion: "success" },
      { number: 2, name: "Validate repair", status: "in_progress", conclusion: null },
    ],
  },
];

function workflowRun(fixture, now) {
  return {
    id: fixture.runId,
    name: "Review ClawSweeper items",
    display_title: `Review event item ${repository}#${fixture.number}`,
    event: "repository_dispatch",
    status: fixture.runStatus,
    conclusion: null,
    html_url: `https://github.com/openclaw/clawsweeper/actions/runs/${fixture.runId}`,
    created_at: now,
    updated_at: now,
    run_attempt: 1,
  };
}

function workflowJob(fixture, now) {
  return {
    id: fixture.jobId,
    run_id: fixture.runId,
    name: fixture.jobName,
    status: fixture.jobStatus,
    conclusion: null,
    html_url: `https://github.com/openclaw/clawsweeper/actions/runs/${fixture.runId}/job/${fixture.jobId}`,
    started_at: now,
    updated_at: now,
    steps: fixture.steps,
  };
}

function workflowObject(kind, id, runId, now, snapshot) {
  return {
    kind,
    repository,
    id,
    runId,
    sourceUpdatedAt: now,
    snapshot,
  };
}

async function seedWorkflows() {
  const now = new Date().toISOString();
  const runs = stageFixtures.map((fixture) => workflowRun(fixture, now));
  const jobs = stageFixtures.map((fixture) => workflowJob(fixture, now));
  const repositoryPayload = {
    full_name: repository,
    default_branch: "main",
    private: false,
    archived: false,
    fork: false,
    has_issues: true,
  };

  await postWebhook("workflow_run", "local-bay-demo-workflow-run-subscription", {
    action: "in_progress",
    repository: repositoryPayload,
    installation: { id: 1 },
    workflow_run: runs[0],
  });
  await postWebhook("workflow_job", "local-bay-demo-workflow-job-subscription", {
    action: "in_progress",
    repository: repositoryPayload,
    installation: { id: 1 },
    workflow_run: { id: runs[0].id },
    workflow_job: jobs[0],
  });

  await postSigned("/internal/state/github-read-model/repair", {
    repository,
    repair_kind: "workflows",
    workflow_run_census_complete: true,
    workflow_run_census_started_at: now,
    complete_workflow_job_runs: runs.map((run) => run.id),
    workflow_job_census_started_at: now,
    workflow_job_census_version: 2,
    objects: [
      ...runs.map((run) => workflowObject("workflow_run", run.id, run.id, now, run)),
      ...jobs.map((job) => workflowObject("workflow_job", job.id, job.run_id, now, job)),
    ],
  });

  await postSigned("/internal/exact-review/review-run-telemetry", {
    run_id: "990003",
    run_attempt: 1,
    workflow_outcome: "success",
    trigger_lane: "exact_event",
    trigger_origin: "manual",
    target_repo: repository,
    started_at: now,
    completed_at: now,
    run_url: "https://github.com/openclaw/clawsweeper/actions/runs/990003",
    plan_count: 1,
    item_count: 6,
    publication_count: 2,
  });
}

await seedLifecycle();
await seedWorkflows();

let summary;
const projectionDeadline = Date.now() + 60_000;
do {
  const [statusResponse, lifecycleResponse] = await Promise.all([
    fetch(`${origin}/api/status`, { cache: "no-store" }),
    fetch(`${origin}/api/durable-lifecycle-bay`, { cache: "no-store" }),
  ]);
  if (!statusResponse.ok || !lifecycleResponse.ok) {
    throw new Error(
      `seed projection read failed: status=${statusResponse.status} lifecycle=${lifecycleResponse.status}`,
    );
  }
  const status = await statusResponse.json();
  const lifecycle = await lifecycleResponse.json();
  const activity = status?.exact_review_queue?.bay_projection?.activity;
  const stageCards = Array.isArray(activity?.items)
    ? activity.items.filter(
        (item) =>
          item?.repository === repository &&
          itemNumbers.includes(item?.item_number) &&
          typeof item?.stage === "string",
      )
    : [];
  const lifecycleBay = lifecycle?.durable_lifecycle_bay;
  if (
    activity?.complete === true &&
    stageCards.length === itemNumbers.length &&
    lifecycleBay?.collection?.state === "complete" &&
    lifecycleBay?.inventory?.lifecycle_records >= itemNumbers.length
  ) {
    summary = {
      activity_cards: activity.items.length,
      stage_cards: stageCards.length,
      lifecycle_records: lifecycleBay.inventory.lifecycle_records,
    };
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
} while (Date.now() < projectionDeadline);

if (!summary) throw new Error("seeded projections did not become complete within 60 seconds");
console.log(
  JSON.stringify(
    {
      ok: true,
      origin,
      ...summary,
    },
    null,
    2,
  ),
);
