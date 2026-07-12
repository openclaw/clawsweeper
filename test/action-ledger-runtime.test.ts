import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

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
  actionLedgerJson,
} from "../dist/action-ledger.js";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-action-runtime-"));
}

function createDirectoryLink(target: string, link: string): void {
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
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

function recordReview(
  root: string,
  env: NodeJS.ProcessEnv = workflowEnv(),
  now = new Date("2026-07-12T10:01:00.000Z"),
  options: {
    generatedOccurrence?: boolean;
    fetchImpl?: typeof fetch;
  } = {},
) {
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
      ...(options.generatedOccurrence ? {} : { occurredAt: "2026-07-12T10:00:00.000Z" }),
    },
    {
      env,
      now: () => now,
      fetchImpl: options.fetchImpl ?? (async () => new Response(null, { status: 204 })),
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

test("invalid workflow events do not create partition markers", () => {
  const root = tempRoot();
  assert.throws(
    () =>
      recordWorkflowActionEvent(
        root,
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
            status: `Bearer ${"A".repeat(32)}`,
            retryable: false,
            mutation: false,
          },
        },
        { env: workflowEnv() },
      ),
    /confidential identifier/,
  );
  assert.equal(fs.existsSync(path.join(root, ".clawsweeper-repair")), false);
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

test("workflow event scopes reject confidential identifiers before persistence or projection", () => {
  for (const scope of [`ghp_${"A".repeat(20)}`, `Bearer-${"A".repeat(20)}`, "service.internal"]) {
    const root = tempRoot();
    let requests = 0;
    assert.throws(
      () =>
        recordWorkflowActionEvent(
          root,
          {
            scope,
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
          {
            env: workflowEnv({
              CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "agent-token",
              CLAWSWEEPER_CRABFLEET_SESSION_ID: "session-1",
            }),
            fetchImpl: (async () => {
              requests += 1;
              return new Response(null, { status: 204 });
            }) as typeof fetch,
          },
        ),
      /confidential identifier/,
      scope,
    );
    assert.equal(requests, 0, scope);
    assert.equal(fs.existsSync(path.join(root, ".clawsweeper-repair")), false, scope);
  }
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
    /^ledger\/v1\/events\/2026\/07\/12\/openclaw-clawsweeper\/review\.__run_5\.review-0\/100-2-review-[a-f0-9]{12}\.jsonl$/,
  );
  assert.equal(
    fs.readFileSync(path.join(outputRoot, first[0]!), "utf8").trim().split("\n").length,
    1,
  );
});

test("fresh roots reconstruct shard partitions from immutable run metadata", async () => {
  const env = workflowEnv({
    CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: undefined,
    GITHUB_RUN_STARTED_AT: "2026-07-10T23:30:00-02:00",
  });
  const roots = [tempRoot(), tempRoot()];
  const paths: string[] = [];
  for (const root of roots) {
    recordReview(root, env);
    const [relativePath] = await flushWorkflowActionEvents(root, {
      env,
      outputRoot: path.join(root, "state"),
    });
    assert.ok(relativePath);
    paths.push(relativePath);
  }

  assert.equal(paths[1], paths[0]);
  assert.match(paths[0] ?? "", /^ledger\/v1\/events\/2026\/07\/11\//);

  const missingMetadataRoot = tempRoot();
  assert.throws(
    () =>
      recordReview(
        missingMetadataRoot,
        workflowEnv({
          CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: undefined,
        }),
      ),
    /requires CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE or GITHUB_RUN_STARTED_AT/,
  );
});

test("fresh-root shard replay preserves the first recorded-at metadata", async () => {
  const env = workflowEnv();
  const firstRoot = tempRoot();
  const replayRoot = tempRoot();
  const outputRoot = tempRoot();
  recordReview(firstRoot, env, new Date("2026-07-12T10:01:00.000Z"));
  const [firstPath] = await flushWorkflowActionEvents(firstRoot, { env, outputRoot });
  assert.ok(firstPath);
  const firstContent = fs.readFileSync(path.join(outputRoot, firstPath), "utf8");

  recordReview(replayRoot, env, new Date("2026-07-12T11:30:00.000Z"));
  const [replayPath] = await flushWorkflowActionEvents(replayRoot, { env, outputRoot });
  assert.equal(replayPath, firstPath);
  assert.equal(fs.readFileSync(path.join(outputRoot, replayPath!), "utf8"), firstContent);
  assert.equal(JSON.parse(firstContent).recorded_at, "2026-07-12T10:01:00.000Z");
});

test("fresh-root shard replay ignores only generated occurrence clock drift", async () => {
  const env = workflowEnv();
  const firstRoot = tempRoot();
  const replayRoot = tempRoot();
  const outputRoot = tempRoot();
  const first = recordReview(firstRoot, env, new Date("2026-07-12T10:01:00.000Z"), {
    generatedOccurrence: true,
  });
  const [firstPath] = await flushWorkflowActionEvents(firstRoot, { env, outputRoot });
  assert.ok(first);
  assert.ok(firstPath);
  const firstContent = fs.readFileSync(path.join(outputRoot, firstPath), "utf8");

  const replay = recordReview(replayRoot, env, new Date("2026-07-12T11:30:00.000Z"), {
    generatedOccurrence: true,
  });
  const [replayPath] = await flushWorkflowActionEvents(replayRoot, { env, outputRoot });
  assert.ok(replay);
  assert.equal(replayPath, firstPath);
  assert.notEqual(replay.occurred_at, first.occurred_at);
  assert.equal(first.occurred_at_source, "generated");
  assert.equal(replay.occurred_at_source, "generated");
  assert.equal(fs.readFileSync(path.join(outputRoot, replayPath!), "utf8"), firstContent);
});

test("imports preserve first-writer shard bytes across fresh-root recorded-at drift", async () => {
  const env = workflowEnv();
  const firstRoot = tempRoot();
  const replayRoot = tempRoot();
  const firstOutput = tempRoot();
  const replayOutput = tempRoot();
  const destination = tempRoot();
  recordReview(firstRoot, env, new Date("2026-07-12T10:01:00.000Z"));
  recordReview(replayRoot, env, new Date("2026-07-12T11:30:00.000Z"));
  const [firstPath] = await flushWorkflowActionEvents(firstRoot, {
    env,
    outputRoot: firstOutput,
  });
  const [replayPath] = await flushWorkflowActionEvents(replayRoot, {
    env,
    outputRoot: replayOutput,
  });
  assert.equal(replayPath, firstPath);
  assert.notEqual(
    fs.readFileSync(path.join(firstOutput, firstPath!), "utf8"),
    fs.readFileSync(path.join(replayOutput, replayPath!), "utf8"),
  );

  assert.equal(importActionEventShards(firstOutput, destination).created, 1);
  assert.equal(importActionEventShards(replayOutput, destination).unchanged, 1);
  assert.equal(
    fs.readFileSync(path.join(destination, firstPath!), "utf8"),
    fs.readFileSync(path.join(firstOutput, firstPath!), "utf8"),
  );
});

test("historical producer partitions survive later-run flush environments", async () => {
  const root = tempRoot();
  const outputRoot = path.join(root, "state");
  recordReview(
    root,
    workflowEnv({
      CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-07-10",
      GITHUB_RUN_ID: "100",
    }),
  );
  recordReview(
    root,
    workflowEnv({
      CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-07-12",
      GITHUB_RUN_ID: "200",
    }),
  );

  const paths = await flushWorkflowActionEvents(root, {
    env: workflowEnv({
      CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-07-12",
      GITHUB_RUN_ID: "200",
    }),
    outputRoot,
  });
  assert.equal(paths.length, 2);
  assert.ok(paths.some((entry) => entry.startsWith("ledger/v1/events/2026/07/10/")));
  assert.ok(paths.some((entry) => entry.startsWith("ledger/v1/events/2026/07/12/")));
});

test("concurrent flushes converge on one immutable shard", async () => {
  const root = tempRoot();
  const outputRoot = path.join(root, "state");
  recordReview(root);

  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      flushWorkflowActionEvents(root, {
        env: workflowEnv(),
        outputRoot,
      }),
    ),
  );
  for (const result of results) assert.deepEqual(result, results[0]);
  const relativePath = results[0]?.[0];
  assert.ok(relativePath);
  assert.equal(
    fs.readFileSync(path.join(outputRoot, relativePath), "utf8").trim().split("\n").length,
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

test("full producer identity prevents cross-repository shard collisions", async () => {
  const root = tempRoot();
  const outputRoot = path.join(root, "state");
  recordReview(
    root,
    workflowEnv({
      GITHUB_REPOSITORY: "openclaw/clawsweeper",
      GITHUB_SHA: "abc123",
    }),
  );
  recordReview(
    root,
    workflowEnv({
      GITHUB_REPOSITORY: "other/automation",
      GITHUB_SHA: "def456",
    }),
  );

  const paths = await flushWorkflowActionEvents(root, {
    env: workflowEnv(),
    outputRoot,
  });
  assert.equal(paths.length, 2);
  assert.ok(paths.some((entry) => entry.includes("/openclaw-clawsweeper/")));
  assert.ok(paths.some((entry) => entry.includes("/other-automation/")));

  const imported = importActionEventShards(outputRoot, path.join(root, "destination"));
  assert.equal(imported.created, 2);
  assert.deepEqual(imported.paths, paths);
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

test("CrabFleet rejects forged confidential event keys before projection", async () => {
  const event = recordReview(tempRoot());
  assert.ok(event);
  const forgedKey = `ghp_${"A".repeat(20)}:${event.event_key.split(":")[1]}`;
  const forged = {
    ...event,
    event_key: forgedKey,
    event_id: createHash("sha256")
      .update(`${event.subject.repository}\n${forgedKey}`)
      .digest("hex"),
  };
  let requests = 0;

  await assert.rejects(
    postActionEventToCrabFleet(
      forged,
      workflowEnv({
        CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "agent-token",
        CLAWSWEEPER_CRABFLEET_SESSION_ID: "session-1",
      }),
      (async () => {
        requests += 1;
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    ),
    /confidential identifier/,
  );
  assert.equal(requests, 0);
});

test("CrabFleet projection cancels successful response bodies", async () => {
  const event = recordReview(tempRoot());
  assert.ok(event);
  let cancelled = 0;
  await postActionEventToCrabFleet(
    event,
    workflowEnv({
      CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "agent-token",
      CLAWSWEEPER_CRABFLEET_SESSION_ID: "session-1",
    }),
    (async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled += 1;
          },
        }),
        { status: 200 },
      )) as typeof fetch,
  );
  assert.equal(cancelled, 1);
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
        occurredAt: "2026-07-12T12:00:00.000Z",
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
  assert.equal(events[0].occurred_at, "2026-07-12T12:00:00.000Z");
  assert.equal(events[0].occurred_at_source, "source");
  assert.equal(failure.occurred_at, "2026-07-12T10:01:00.000Z");
  assert.equal(failure.occurred_at_source, "generated");
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

test("fresh-root projection failures replay despite generated clock drift", async () => {
  const env = workflowEnv({
    CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "agent-token",
    CLAWSWEEPER_CRABFLEET_SESSION_ID: "session-1",
  });
  const outputRoot = tempRoot();
  const roots = [tempRoot(), tempRoot()];
  const timestamps = [new Date("2026-07-12T10:01:00.000Z"), new Date("2026-07-12T11:30:00.000Z")];
  const originalError = console.error;
  console.error = () => undefined;
  try {
    let firstPath: string | undefined;
    let firstContent: string | undefined;
    for (const [index, root] of roots.entries()) {
      const event = recordReview(root, env, timestamps[index], {
        generatedOccurrence: true,
        fetchImpl: async () => new Response(null, { status: 503 }),
      });
      assert.ok(event);
      const [relativePath] = await flushWorkflowActionEvents(root, { env, outputRoot });
      assert.ok(relativePath);
      if (index === 0) {
        firstPath = relativePath;
        firstContent = fs.readFileSync(path.join(outputRoot, relativePath), "utf8");
      } else {
        assert.equal(relativePath, firstPath);
        assert.equal(fs.readFileSync(path.join(outputRoot, relativePath), "utf8"), firstContent);
      }
    }
  } finally {
    console.error = originalError;
  }

  const [relativePath] = await flushWorkflowActionEvents(roots[0]!, { env, outputRoot });
  assert.ok(relativePath);
  const events = fs
    .readFileSync(path.join(outputRoot, relativePath), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    events.map((event) => event.occurred_at_source),
    ["generated", "generated"],
  );
});

test("CrabFleet timeouts preserve canonical events and record projection failure", async () => {
  const root = tempRoot();
  const outputRoot = path.join(root, "state");
  const errors: string[] = [];
  const originalError = console.error;
  let aborted = false;
  const env = workflowEnv({
    CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "agent-token",
    CLAWSWEEPER_CRABFLEET_SESSION_ID: "session-1",
    CLAWSWEEPER_CRABFLEET_TIMEOUT_MS: "20",
  });
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  try {
    const event = recordWorkflowActionEvent(
      root,
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
      {
        env,
        fetchImpl: ((_url, init) =>
          new Promise<Response>(() => {
            init?.signal?.addEventListener("abort", () => {
              aborted = true;
            });
          })) as typeof fetch,
      },
    );
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
  } finally {
    console.error = originalError;
  }
  assert.equal(aborted, true);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? "", /timed out after 20ms/);
});

test("late CrabFleet response cleanup failures are consumed after timeout", async () => {
  const event = recordReview(tempRoot());
  assert.ok(event);
  let resolveResponse!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  try {
    await assert.rejects(
      postActionEventToCrabFleet(
        event,
        workflowEnv({
          CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "agent-token",
          CLAWSWEEPER_CRABFLEET_SESSION_ID: "session-1",
          CLAWSWEEPER_CRABFLEET_TIMEOUT_MS: "10",
        }),
        (() => response) as typeof fetch,
      ),
      /timed out after 10ms/,
    );
    resolveResponse({
      ok: true,
      status: 200,
      body: {
        cancel: async () => {
          throw new Error("late cleanup failure");
        },
      },
    } as unknown as Response);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("projection failure recording remains valid at max-safe phase sequence", async () => {
  const root = tempRoot();
  const outputRoot = path.join(root, "state");
  const env = workflowEnv({
    CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "agent-token",
    CLAWSWEEPER_CRABFLEET_SESSION_ID: "session-1",
  });
  const originalError = console.error;
  console.error = () => undefined;
  try {
    recordWorkflowActionEvent(
      root,
      {
        scope: "review.completed",
        identity: { number: 42 },
        phaseSeq: Number.MAX_SAFE_INTEGER,
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
      {
        env,
        fetchImpl: async () => new Response(null, { status: 503 }),
      },
    );
    const [relativePath] = await flushWorkflowActionEvents(root, { env, outputRoot });
    assert.ok(relativePath);
    const phaseSequences = fs
      .readFileSync(path.join(outputRoot, relativePath), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).phase_seq);
    assert.deepEqual(phaseSequences, [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]);
  } finally {
    console.error = originalError;
  }
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
  const destinationDirectory = path.dirname(path.join(destination, created.paths[0]!));
  const replayed = importActionEventShards(source, destination);
  assert.equal(created.created, 1);
  assert.equal(replayed.unchanged, 1);
  assert.deepEqual(
    fs.readdirSync(destinationDirectory).filter((entry) => entry.endsWith(".tmp")),
    [],
  );

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

test("state shard imports reject forged confidential event-key scopes", async () => {
  const root = tempRoot();
  const source = path.join(root, "source");
  recordReview(root);
  const [relativePath] = await flushWorkflowActionEvents(root, {
    env: workflowEnv(),
    outputRoot: source,
  });
  assert.ok(relativePath);
  const shardPath = path.join(source, relativePath);
  const event = JSON.parse(fs.readFileSync(shardPath, "utf8"));
  const forgedKey = `service.internal:${event.event_key.split(":")[1]}`;
  event.event_key = forgedKey;
  event.event_id = createHash("sha256")
    .update(`${event.subject.repository}\n${forgedKey}`)
    .digest("hex");
  fs.writeFileSync(shardPath, `${actionLedgerJson(event)}\n`, "utf8");

  assert.throws(
    () => importActionEventShards(source, path.join(root, "destination")),
    /confidential identifier/,
  );
});

test("state shard imports ignore unrelated entries and reject links in the ledger subtree", () => {
  const root = tempRoot();
  const source = path.join(root, "source");
  const linked = path.join(root, "linked-source");
  fs.mkdirSync(source);
  fs.mkdirSync(linked);
  createDirectoryLink(linked, path.join(source, "linked"));
  assert.deepEqual(importActionEventShards(source, path.join(root, "empty-destination")), {
    created: 0,
    unchanged: 0,
    paths: [],
  });
  createDirectoryLink(linked, path.join(source, "ledger"));
  assert.throws(
    () => importActionEventShards(source, path.join(root, "destination")),
    /symbolic link or junction/,
  );
});

test(
  "state shard imports bind file reads to the enumerated source root",
  {
    skip:
      process.platform === "win32"
        ? "requires POSIX directory rename and symlink semantics"
        : false,
  },
  async () => {
    const root = tempRoot();
    const source = path.join(root, "source");
    const outside = path.join(root, "outside");
    const destination = path.join(root, "destination");
    recordReview(root);
    const [relativePath] = await flushWorkflowActionEvents(root, {
      env: workflowEnv(),
      outputRoot: source,
    });
    assert.ok(relativePath);
    fs.mkdirSync(path.dirname(path.join(outside, relativePath)), { recursive: true });
    fs.copyFileSync(path.join(source, relativePath), path.join(outside, relativePath));
    const savedSource = `${source}.saved`;
    const originalOpenSync = fs.openSync;
    let swapped = false;

    fs.openSync = ((filePath, flags, mode) => {
      if (!swapped && filePath === path.join(source, relativePath)) {
        swapped = true;
        fs.renameSync(source, savedSource);
        createDirectoryLink(outside, source);
        try {
          return originalOpenSync(filePath, flags, mode);
        } finally {
          fs.unlinkSync(source);
          fs.renameSync(savedSource, source);
        }
      }
      return originalOpenSync(filePath, flags, mode);
    }) as typeof fs.openSync;
    try {
      assert.throws(
        () => importActionEventShards(source, destination),
        /changed action event shard file/,
      );
    } finally {
      fs.openSync = originalOpenSync;
    }
    assert.equal(swapped, true);
    assert.equal(fs.existsSync(path.join(destination, relativePath)), false);
  },
);

test(
  "interrupted shard imports leave no partial final and recover on replay",
  {
    skip: process.platform === "win32" ? "uses SIGKILL process termination" : false,
  },
  async () => {
    const root = tempRoot();
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    recordReview(root);
    const [relativePath] = await flushWorkflowActionEvents(root, {
      env: workflowEnv(),
      outputRoot: source,
    });
    assert.ok(relativePath);
    const moduleUrl = pathToFileURL(
      path.join(process.cwd(), "dist", "action-ledger-runtime.js"),
    ).href;
    const script = `import fs from "node:fs";
const originalWrite = fs.writeFileSync;
let interrupted = false;
fs.writeFileSync = (target, data, options) => {
  if (!interrupted && typeof target === "number") {
    interrupted = true;
    const partial = typeof data === "string" ? data.slice(0, 64) : data.subarray(0, 64);
    originalWrite(target, partial, options);
    fs.fsyncSync(target);
    process.kill(process.pid, "SIGKILL");
  }
  return originalWrite(target, data, options);
};
const { importActionEventShards } = await import(${JSON.stringify(moduleUrl)});
importActionEventShards(process.argv[1], process.argv[2]);`;
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script, source, destination],
      { encoding: "utf8" },
    );
    assert.equal(child.signal, "SIGKILL", child.stderr);
    assert.equal(fs.existsSync(path.join(destination, relativePath)), false);
    const destinationDirectory = path.dirname(path.join(destination, relativePath));
    assert.ok(fs.readdirSync(destinationDirectory).some((entry) => entry.endsWith(".tmp")));

    const replay = importActionEventShards(source, destination);
    assert.equal(replay.created, 1);
    assert.equal(
      fs.readFileSync(path.join(destination, relativePath), "utf8"),
      fs.readFileSync(path.join(source, relativePath), "utf8"),
    );
  },
);

test("partition markers and import destinations reject symlinked parents", async () => {
  const root = tempRoot();
  const source = path.join(root, "source");
  const outsidePartitions = path.join(root, "outside-partitions");
  fs.mkdirSync(outsidePartitions);
  fs.mkdirSync(path.join(root, ".clawsweeper-repair", "action-events"), { recursive: true });
  createDirectoryLink(
    outsidePartitions,
    path.join(root, ".clawsweeper-repair", "action-events", "_partitions"),
  );
  assert.throws(() => recordReview(root), /symbolic link or junction/);
  assert.deepEqual(fs.readdirSync(outsidePartitions), []);

  fs.rmSync(path.join(root, ".clawsweeper-repair", "action-events", "_partitions"));
  recordReview(root);
  const [relativePath] = await flushWorkflowActionEvents(root, {
    env: workflowEnv(),
    outputRoot: source,
  });
  assert.ok(relativePath);

  const destination = path.join(root, "destination");
  const outsideDestination = path.join(root, "outside-destination");
  fs.mkdirSync(destination);
  fs.mkdirSync(outsideDestination);
  createDirectoryLink(outsideDestination, path.join(destination, "ledger"));
  assert.throws(() => importActionEventShards(source, destination), /symbolic link or junction/);
  assert.deepEqual(fs.readdirSync(outsideDestination), []);

  const destinationLink = path.join(root, "destination-link");
  createDirectoryLink(outsideDestination, destinationLink);
  assert.throws(
    () => importActionEventShards(source, destinationLink),
    /symbolic link or junction/,
  );

  if (process.platform !== "win32") {
    const finalDestination = path.join(root, "final-destination");
    const outsideFile = path.join(root, "outside-shard.jsonl");
    const finalPath = path.join(finalDestination, relativePath);
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    fs.writeFileSync(outsideFile, "sentinel\n");
    fs.symlinkSync(outsideFile, finalPath, "file");
    assert.throws(
      () => importActionEventShards(source, finalDestination),
      /symbolic link or non-file/,
    );
    assert.equal(fs.readFileSync(outsideFile, "utf8"), "sentinel\n");
  }
});
