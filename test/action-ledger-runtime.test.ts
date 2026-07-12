import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  flushWorkflowActionEvents,
  importActionEventShards,
  postActionEventToCrabFleet,
  recordWorkflowActionEvent,
  recordWorkflowPhaseEvent,
  workflowActionProducer,
} from "../dist/action-ledger-runtime.js";
import {
  ACTION_EVENT_PHASE_TYPES,
  ACTION_EVENT_REASON_CODES,
  ACTION_EVENT_STATUSES,
  ACTION_EVENT_TYPES,
} from "../dist/action-ledger.js";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-action-runtime-"));
}

function workflowEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
    CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "review-0",
    CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-07-12",
    GITHUB_ACTION: "__run_5",
    GITHUB_JOB: "review",
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_RUN_ID: "100",
    GITHUB_SHA: "abc123",
    GITHUB_WORKFLOW: "ClawSweeper Sweep",
    GITHUB_WORKFLOW_REF: "openclaw/clawsweeper/.github/workflows/sweep.yml@refs/heads/main",
    ...overrides,
  };
}

function recordReview(root: string, env: NodeJS.ProcessEnv = workflowEnv()) {
  return recordWorkflowActionEvent(
    root,
    {
      scope: "review.completed",
      identity: {
        repository: "openclaw/openclaw",
        number: 42,
        sourceRevision: "abc123",
      },
      type: ACTION_EVENT_TYPES.reviewCompleted,
      component: "review",
      subject: {
        repository: "openclaw/openclaw",
        kind: "pull_request",
        number: 42,
        sourceRevision: "abc123",
      },
      action: {
        name: "review",
        status: "completed",
        reasonCode: "keep_open",
        retryable: false,
        mutation: false,
      },
      attributes: {
        cached: false,
        duration_ms: 1_000,
        finding_count: 2,
      },
      privacy: {
        classification: "internal",
        redactionVersion: "v1",
        fieldsDropped: ["body", "comments", "diff", "logs", "prompt"],
      },
      occurredAt: "2026-07-12T10:00:00.000Z",
    },
    {
      env,
      now: () => new Date("2026-07-12T10:01:00.000Z"),
      fetchImpl: async () => new Response(null, { status: 204 }),
    },
  );
}

test("workflow event telemetry is disabled outside an explicit workflow context", () => {
  assert.equal(
    recordWorkflowActionEvent(
      tempRoot(),
      {
        scope: "review.completed",
        identity: { number: 42 },
        type: ACTION_EVENT_TYPES.reviewCompleted,
        component: "review",
        subject: {
          repository: "openclaw/openclaw",
          kind: "pull_request",
          number: 42,
        },
        action: {
          name: "review",
          status: "completed",
          retryable: false,
          mutation: false,
        },
      },
      { env: {} },
    ),
    null,
  );
});

test("phase event helpers derive canonical types, action names, and replay identities", () => {
  const root = tempRoot();
  const input = {
    phase: ACTION_EVENT_PHASE_TYPES.repairPlan,
    status: ACTION_EVENT_STATUSES.completed,
    reasonCode: ACTION_EVENT_REASON_CODES.completed,
    operation: "repair",
    operationIdentity: {
      queueItem: "repair_42",
      sourceRevision: "abc123",
    },
    attemptIdentity: {
      queueItem: "repair_42",
      attempt: 2,
    },
    phaseSeq: 3,
    idempotencyIdentity: {
      queueItem: "repair_42",
      action: "plan",
    },
    identity: {
      queueItem: "repair_42",
      sourceRevision: "abc123",
    },
    component: "repair_plan",
    subject: {
      repository: "openclaw/openclaw",
      kind: "queue_item" as const,
      subjectId: "repair_42",
      sourceRevision: "abc123",
    },
    retryable: false,
    mutation: false,
    attributes: {
      attempt: 2,
      queue_depth: 3,
      workflow_phase: "planning",
    },
    occurredAt: "2026-07-12T10:00:00.000Z",
  };
  const first = recordWorkflowPhaseEvent(root, input, {
    env: workflowEnv(),
    now: () => new Date("2026-07-12T10:01:00.000Z"),
    fetchImpl: async () => new Response(null, { status: 204 }),
  });
  const replay = recordWorkflowPhaseEvent(root, input, {
    env: workflowEnv(),
    now: () => new Date("2026-07-12T11:00:00.000Z"),
    fetchImpl: async () => new Response(null, { status: 204 }),
  });

  assert.ok(first);
  assert.ok(replay);
  assert.equal(replay.event_id, first.event_id);
  assert.equal(first.event_type, ACTION_EVENT_PHASE_TYPES.repairPlan);
  assert.equal(first.action.name, ACTION_EVENT_PHASE_TYPES.repairPlan);
  assert.equal(first.action.status, ACTION_EVENT_STATUSES.completed);
  assert.equal(first.action.reason_code, ACTION_EVENT_REASON_CODES.completed);
  assert.equal(first.subject.subject_id, "repair_42");
  assert.match(first.operation_id, /^[a-f0-9]{64}$/);
  assert.match(first.attempt_id, /^[a-f0-9]{64}$/);
  assert.equal(first.parent_event_id, null);
  assert.equal(first.phase_seq, 3);
  assert.match(first.idempotency_key_sha256, /^[a-f0-9]{64}$/);
});

test("workflow retries preserve operation and idempotency identity but change attempts", () => {
  const root = tempRoot();
  const input = {
    scope: "repair.execute",
    operation: "repair",
    operationIdentity: { queueItem: "repair_42" },
    phaseSeq: 4,
    idempotencyIdentity: { queueItem: "repair_42", mutation: "push_branch" },
    identity: { queueItem: "repair_42", phase: "execute" },
    type: ACTION_EVENT_TYPES.repairExecute,
    component: "repair_execute",
    subject: {
      repository: "openclaw/openclaw",
      kind: "queue_item" as const,
      subjectId: "repair_42",
    },
    action: {
      name: "repair.execute",
      status: "executed",
      retryable: true,
      mutation: true,
    },
  };
  const first = recordWorkflowActionEvent(root, input, {
    env: workflowEnv({ GITHUB_RUN_ATTEMPT: "2" }),
    fetchImpl: async () => new Response(null, { status: 204 }),
  });
  const retry = recordWorkflowActionEvent(root, input, {
    env: workflowEnv({ GITHUB_RUN_ATTEMPT: "3" }),
    fetchImpl: async () => new Response(null, { status: 204 }),
  });
  assert.ok(first);
  assert.ok(retry);
  assert.equal(retry.operation_id, first.operation_id);
  assert.equal(retry.idempotency_key_sha256, first.idempotency_key_sha256);
  assert.notEqual(retry.attempt_id, first.attempt_id);
  assert.notEqual(retry.event_id, first.event_id);
});

test("mutation retries require explicit outcome-independent idempotency identity", () => {
  const root = tempRoot();
  const base = {
    phase: ACTION_EVENT_PHASE_TYPES.repairExecute,
    operation: "repair",
    operationIdentity: { queueItem: "repair_42" },
    identity: { queueItem: "repair_42", mutation: "push_branch" },
    component: "repair_execute",
    subject: {
      repository: "openclaw/openclaw",
      kind: "queue_item" as const,
      subjectId: "repair_42",
    },
    retryable: true,
    mutation: true,
  };

  assert.throws(
    () =>
      recordWorkflowPhaseEvent(
        root,
        {
          ...base,
          status: ACTION_EVENT_STATUSES.failed,
          reasonCode: ACTION_EVENT_REASON_CODES.exception,
        },
        { env: workflowEnv() },
      ),
    /require an explicit idempotencyIdentity/,
  );

  const idempotencyIdentity = {
    queueItem: "repair_42",
    mutation: "push_branch",
    targetBranch: "repair/42",
  };
  const failed = recordWorkflowPhaseEvent(
    root,
    {
      ...base,
      status: ACTION_EVENT_STATUSES.failed,
      reasonCode: ACTION_EVENT_REASON_CODES.exception,
      idempotencyIdentity,
    },
    { env: workflowEnv({ GITHUB_RUN_ATTEMPT: "2" }) },
  );
  const completed = recordWorkflowPhaseEvent(
    root,
    {
      ...base,
      status: ACTION_EVENT_STATUSES.completed,
      reasonCode: ACTION_EVENT_REASON_CODES.completed,
      idempotencyIdentity,
    },
    { env: workflowEnv({ GITHUB_RUN_ATTEMPT: "3" }) },
  );

  assert.ok(failed);
  assert.ok(completed);
  assert.equal(completed.operation_id, failed.operation_id);
  assert.equal(completed.idempotency_key_sha256, failed.idempotency_key_sha256);
  assert.notEqual(completed.attempt_id, failed.attempt_id);
  assert.notEqual(completed.event_id, failed.event_id);
});

test("phase event helpers reject noncanonical phase, status, and reason strings", () => {
  const base = {
    phase: ACTION_EVENT_PHASE_TYPES.reviewItem,
    status: ACTION_EVENT_STATUSES.started,
    identity: { number: 42 },
    component: "review",
    subject: {
      repository: "openclaw/openclaw",
      kind: "pull_request" as const,
      number: 42,
    },
    retryable: true,
    mutation: false,
  };
  assert.throws(
    () => recordWorkflowPhaseEvent(tempRoot(), { ...base, phase: "review.anything" as never }),
    /unknown action event phase type/,
  );
  assert.throws(
    () => recordWorkflowPhaseEvent(tempRoot(), { ...base, status: "some prose" as never }),
    /unknown action event status/,
  );
  assert.throws(
    () =>
      recordWorkflowPhaseEvent(tempRoot(), {
        ...base,
        reasonCode: "because_i_said_so" as never,
      }),
    /unknown action event reason code/,
  );
});

test("workflow producer identity uses stable workflow and step identifiers", () => {
  assert.deepEqual(workflowActionProducer("review", workflowEnv()), {
    repository: "openclaw/clawsweeper",
    sha: "abc123",
    workflow: "sweep.yml",
    job: "review",
    runId: "100",
    runAttempt: 2,
    component: "review.__run_5.review-0",
  });
});

test("workflow events finalize into one replay-stable per-step shard", async () => {
  const root = tempRoot();
  const outputRoot = path.join(root, "state");
  const event = recordReview(root);
  assert.ok(event);

  const first = await flushWorkflowActionEvents(root, {
    env: workflowEnv(),
    outputRoot,
  });
  const replay = await flushWorkflowActionEvents(root, {
    env: workflowEnv(),
    outputRoot,
  });

  assert.deepEqual(replay, first);
  assert.equal(first.length, 1);
  assert.match(
    first[0] ?? "",
    /^ledger\/v1\/events\/2026\/07\/12\/review\.__run_5\.review-0\/100-2-review-[a-f0-9]{12}\.jsonl$/,
  );
  assert.equal(
    fs.readFileSync(path.join(outputRoot, first[0]!), "utf8").trim().split("\n").length,
    1,
  );
});

test("different workflow steps receive independent shard identities", async () => {
  const root = tempRoot();
  const outputRoot = path.join(root, "state");
  recordReview(root, workflowEnv({ GITHUB_ACTION: "__run_5" }));
  recordReview(root, workflowEnv({ GITHUB_ACTION: "__run_6" }));

  const paths = await flushWorkflowActionEvents(root, {
    env: workflowEnv(),
    outputRoot,
  });
  assert.equal(paths.length, 2);
  assert.notEqual(paths[0], paths[1]);
});

test("CrabFleet projection sends the validated ledger event and bearer token", async () => {
  const root = tempRoot();
  const event = recordReview(root);
  assert.ok(event);
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  await postActionEventToCrabFleet(
    event,
    workflowEnv({
      CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "agent-token",
      CLAWSWEEPER_CRABFLEET_SESSION_ID: "session-1",
      CLAWSWEEPER_CRABFLEET_URL: "https://crabfleet.example/",
    }),
    (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
        init,
      });
      return new Response(JSON.stringify({ duplicate: false }), { status: 200 });
    }) as typeof fetch,
  );

  const request = requests[0];
  assert.ok(request);
  assert.equal(
    request.url,
    "https://crabfleet.example/api/agent/interactive-sessions/session-1/events",
  );
  const init = request.init;
  assert.ok(init);
  assert.equal((init.headers as Record<string, string>).authorization, "Bearer agent-token");
  assert.equal(typeof init.body, "string");
  const body = JSON.parse(init.body);
  assert.equal(body.eventKey, event.event_key);
  assert.equal(body.type, "clawsweeper.action");
  assert.deepEqual(body.payload, { version: 1, event });
});

test("CrabFleet projection failures remain durable and retryable", async () => {
  const root = tempRoot();
  const outputRoot = path.join(root, "state");
  const errors: string[] = [];
  const originalError = console.error;
  const env = workflowEnv({
    CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "agent-token",
    CLAWSWEEPER_CRABFLEET_SESSION_ID: "session-1",
  });
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  let event: ReturnType<typeof recordWorkflowActionEvent>;
  try {
    event = recordWorkflowActionEvent(
      root,
      {
        scope: "review.completed",
        identity: {
          repository: "openclaw/openclaw",
          number: 42,
          sourceRevision: "abc123",
        },
        type: ACTION_EVENT_TYPES.reviewCompleted,
        component: "review",
        subject: {
          repository: "openclaw/openclaw",
          kind: "pull_request",
          number: 42,
          sourceRevision: "abc123",
        },
        action: {
          name: "review",
          status: "completed",
          retryable: false,
          mutation: false,
        },
        occurredAt: "2026-07-12T10:00:00.000Z",
      },
      {
        env,
        now: () => new Date("2026-07-12T10:01:00.000Z"),
        fetchImpl: async () => new Response("sensitive upstream detail", { status: 503 }),
      },
    );
    await flushWorkflowActionEvents(root, { env, outputRoot });
  } finally {
    console.error = originalError;
  }
  assert.ok(event);

  const [relativePath] = await flushWorkflowActionEvents(root, { env, outputRoot });
  assert.ok(relativePath);
  const events = fs
    .readFileSync(path.join(outputRoot, relativePath), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    events.map((entry) => entry.event_type),
    [ACTION_EVENT_TYPES.reviewCompleted, ACTION_EVENT_TYPES.projectionFailed],
  );
  const failure = events[1];
  assert.equal(failure.action.reason_code, "append_failed");
  assert.equal(failure.action.retryable, true);
  assert.equal(failure.learning.signal, "retry_from_durable_ledger");
  assert.equal(failure.operation_id, event.operation_id);
  assert.equal(failure.attempt_id, event.attempt_id);
  assert.equal(failure.parent_event_id, event.event_id);
  assert.equal(failure.phase_seq, event.phase_seq + 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? "", /append failed \(503\)/);
  assert.doesNotMatch(errors[0] ?? "", /sensitive upstream detail/);
});

test("state shard imports are validated, create-only, and conflict detecting", async () => {
  const root = tempRoot();
  const source = path.join(root, "source");
  const destination = path.join(root, "destination");
  recordReview(root);
  await flushWorkflowActionEvents(root, {
    env: workflowEnv(),
    outputRoot: source,
  });

  const created = importActionEventShards(source, destination);
  const replayed = importActionEventShards(source, destination);
  assert.equal(created.created, 1);
  assert.equal(replayed.unchanged, 1);

  const shard = path.join(source, created.paths[0]!);
  fs.appendFileSync(shard, "\n", "utf8");
  assert.throws(
    () => importActionEventShards(source, destination),
    /action event shard content is not canonical/,
  );
});

test("state shard imports preserve chronological ordering across timestamp offsets", async () => {
  const root = tempRoot();
  const source = path.join(root, "source");
  const destination = path.join(root, "destination");
  recordReview(root);
  recordWorkflowActionEvent(
    root,
    {
      scope: "review.started",
      identity: {
        repository: "openclaw/openclaw",
        number: 42,
        sourceRevision: "abc123",
      },
      type: ACTION_EVENT_TYPES.reviewStarted,
      component: "review",
      subject: {
        repository: "openclaw/openclaw",
        kind: "pull_request",
        number: 42,
        sourceRevision: "abc123",
      },
      action: {
        name: "review",
        status: "started",
        retryable: true,
        mutation: false,
      },
      occurredAt: "2026-07-12T10:30:00.000+02:00",
    },
    {
      env: workflowEnv(),
      now: () => new Date("2026-07-12T10:01:00.000Z"),
      fetchImpl: async () => new Response(null, { status: 204 }),
    },
  );

  await flushWorkflowActionEvents(root, {
    env: workflowEnv(),
    outputRoot: source,
  });
  const imported = importActionEventShards(source, destination);
  assert.equal(imported.created, 1);
  const eventTypes = fs
    .readFileSync(path.join(destination, imported.paths[0]!), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).event_type);
  assert.deepEqual(eventTypes, [
    ACTION_EVENT_TYPES.reviewStarted,
    ACTION_EVENT_TYPES.reviewCompleted,
  ]);
});

test("state shard imports accept exact sub-millisecond canonical ordering", async () => {
  const root = tempRoot();
  const source = path.join(root, "source");
  const destination = path.join(root, "destination");
  const env = workflowEnv();
  recordWorkflowActionEvent(
    root,
    {
      scope: "review.completed",
      identity: {
        repository: "openclaw/openclaw",
        number: 42,
        sourceRevision: "abc123",
      },
      type: ACTION_EVENT_TYPES.reviewCompleted,
      component: "review",
      subject: {
        repository: "openclaw/openclaw",
        kind: "pull_request",
        number: 42,
        sourceRevision: "abc123",
      },
      action: {
        name: "review",
        status: "completed",
        retryable: false,
        mutation: false,
      },
      occurredAt: "2026-07-12T10:00:00.0009Z",
    },
    { env, fetchImpl: async () => new Response(null, { status: 204 }) },
  );
  recordWorkflowActionEvent(
    root,
    {
      scope: "review.started",
      identity: {
        repository: "openclaw/openclaw",
        number: 43,
        sourceRevision: "abc123",
      },
      type: ACTION_EVENT_TYPES.reviewStarted,
      component: "review",
      subject: {
        repository: "openclaw/openclaw",
        kind: "pull_request",
        number: 43,
        sourceRevision: "abc123",
      },
      action: {
        name: "review",
        status: "started",
        retryable: true,
        mutation: false,
      },
      occurredAt: "2026-07-12T12:00:00.0001+02:00",
    },
    { env, fetchImpl: async () => new Response(null, { status: 204 }) },
  );

  await flushWorkflowActionEvents(root, { env, outputRoot: source });
  const imported = importActionEventShards(source, destination);
  assert.equal(imported.created, 1);
  const occurredAt = fs
    .readFileSync(path.join(destination, imported.paths[0]!), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).occurred_at);
  assert.deepEqual(occurredAt, ["2026-07-12T12:00:00.0001+02:00", "2026-07-12T10:00:00.0009Z"]);
});

test("state shard imports reject forged paths and duplicate events", async () => {
  const root = tempRoot();
  const source = path.join(root, "source");
  recordReview(root);
  const [relativePath] = await flushWorkflowActionEvents(root, {
    env: workflowEnv(),
    outputRoot: source,
  });
  assert.ok(relativePath);
  const shard = path.join(source, relativePath);
  const content = fs.readFileSync(shard, "utf8");
  const forged = path.join(path.dirname(shard), `forged-${path.basename(shard)}`);
  fs.renameSync(shard, forged);
  assert.throws(
    () => importActionEventShards(source, path.join(root, "forged-destination")),
    /path does not match canonical identity/,
  );

  fs.renameSync(forged, shard);
  fs.writeFileSync(shard, `${content.trim()}\n${content.trim()}\n`, "utf8");
  assert.throws(
    () => importActionEventShards(source, path.join(root, "duplicate-destination")),
    /contains duplicate events/,
  );
});

test("state shard imports reject symbolic links", () => {
  const root = tempRoot();
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  fs.symlinkSync(path.join(root, "missing"), path.join(source, "linked"));
  assert.throws(
    () => importActionEventShards(source, path.join(root, "destination")),
    /refusing symbolic link/,
  );
});
