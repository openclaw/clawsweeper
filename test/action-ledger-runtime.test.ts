import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  ACTION_EVENT_SHARD_IMPORT_MAX_PUBLISH_PATHS,
  ACTION_EVENT_SHARD_IMPORT_LIMITS,
  CRABFLEET_PROJECTION_LIMITS,
  flushPendingCrabFleetPosts,
  flushWorkflowActionEvents,
  importActionEventShards,
  interruptOpenWorkflowActionEvents,
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
  actionEventId,
  actionEventKey,
  actionEventShardRelativePath,
  actionLedgerJson,
  createActionEvent,
  readAllSpooledActionEvents,
  readActionEventShard,
  readActionEventShardAt,
  writeActionEventShard,
  writeActionEventShards,
  type ActionEvent,
  type ActionEventInput,
  type ActionEventShardIdentity,
} from "../dist/action-ledger.js";
import {
  prepareSafeWriteTarget,
  processIncarnationIdentitySha256,
  tryAcquireUtf8FileLockNoFollow,
} from "../dist/action-ledger-files.js";

function tempRoot(): string {
  return fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-action-runtime-")),
  );
}

function trustedChildRoot(root: string, name: string): string {
  const child = path.join(root, name);
  fs.mkdirSync(child);
  return fs.realpathSync.native(child);
}

async function waitForPath(filePath: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

async function waitForPositivePidFile(filePath: string, timeoutMs = 2_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = fs.readFileSync(filePath, "utf8").trim();
      if (/^[1-9]\d*$/.test(value)) {
        const pid = Number(value);
        if (Number.isSafeInteger(pid)) return pid;
      }
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline)
      throw new Error(`timed out waiting for positive PID in ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForLinuxProcessState(
  pid: number,
  expectedState: string,
  timeoutMs = 2_000,
): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error(`invalid Linux process PID: ${pid}`);
  const statPath = `/proc/${pid}/stat`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const stat = fs.readFileSync(statPath, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      if (commandEnd >= 0) {
        const state = stat
          .slice(commandEnd + 1)
          .trim()
          .split(/\s+/)[0];
        if (state === expectedState) return true;
      }
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function childResult(
  child: ChildProcess,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { code, stdout, stderr };
}

function createDirectoryLink(target: string, link: string): void {
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

function adversarialShardPath(source: string, index: number): string {
  const directory = path.join(
    source,
    "ledger",
    "v1",
    "events",
    "2026",
    "07",
    "12",
    "openclaw-clawsweeper",
    "review",
  );
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, `run-1-review-${String(index).padStart(4, "0")}.jsonl`);
}

function workflowEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = {
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
  const sessionId = String(env.CLAWSWEEPER_CRABFLEET_SESSION_ID ?? "").trim();
  if (sessionId && overrides.CLAWSWEEPER_CRABFLEET_WORK_STATE_URL === undefined) {
    env.CLAWSWEEPER_CRABFLEET_WORK_STATE_URL = `https://crabfleet.openclaw.ai/api/agent/interactive-sessions/${encodeURIComponent(sessionId)}/work-state`;
  }
  return env;
}

function recordWorkflowAttemptMutationOutcome(
  root: string,
  env: NodeJS.ProcessEnv,
  outcome: "unknown" | "observed" | null,
  options: { workKey?: string; attempt?: number } = {},
): {
  started: ActionEvent;
  mutationAttempt: ActionEvent;
  mutationOutcome: ActionEvent | null;
  operationIdentity: { workKey: string };
  attemptIdentity: { workKey: string; attempt: number };
  idempotencyIdentity: {
    operation: { workKey: string };
    slot: string;
    attempt: number;
  };
  subject: {
    repository: string;
    kind: "queue_item";
    subjectId: string;
  };
} {
  const workKey = options.workKey ?? `openclaw/openclaw:${outcome ?? "crash"}`;
  const attempt = options.attempt ?? 1;
  const operationIdentity = { workKey };
  const attemptIdentity = { workKey, attempt };
  const subject = {
    repository: "openclaw/openclaw",
    kind: "queue_item" as const,
    subjectId: workKey,
  };
  const started = recordWorkflowPhaseEvent(
    root,
    {
      phase: ACTION_EVENT_TYPES.workflowAttempt,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      retryable: false,
      mutation: false,
      identity: { state: "started", attempt },
      operation: "repair",
      operationIdentity,
      attemptIdentity,
      phaseSeq: 1,
      component: "repair_worker",
      subject,
      attributes: { state: "started", completion_reason: "workflow_started" },
    },
    { env },
  );
  assert.ok(started);
  const idempotencyIdentity = {
    operation: operationIdentity,
    slot: "repair_mutation",
    attempt,
  };
  const mutationAttempt = recordWorkflowPhaseEvent(
    root,
    {
      phase: ACTION_EVENT_PHASE_TYPES.repairExecute,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      retryable: true,
      mutation: false,
      identity: { state: "mutation_attempted", attempt },
      operation: "repair",
      operationIdentity,
      attemptIdentity,
      parentEventId: started.event_id,
      phaseSeq: 2,
      idempotencyIdentity,
      component: "repair_worker",
      subject,
      attributes: { state: "mutation_attempted", completion_reason: "mutation_attempted" },
    },
    { env },
  );
  assert.ok(mutationAttempt);
  if (outcome === null) {
    return {
      started,
      mutationAttempt,
      mutationOutcome: null,
      operationIdentity,
      attemptIdentity,
      idempotencyIdentity,
      subject,
    };
  }
  const mutationOutcome = recordWorkflowPhaseEvent(
    root,
    {
      phase: ACTION_EVENT_PHASE_TYPES.repairExecute,
      status: outcome === "unknown" ? ACTION_EVENT_STATUSES.failed : ACTION_EVENT_STATUSES.executed,
      reasonCode:
        outcome === "unknown"
          ? ACTION_EVENT_REASON_CODES.unavailable
          : ACTION_EVENT_REASON_CODES.alreadyComplete,
      retryable: outcome === "unknown",
      mutation: true,
      identity: { state: `mutation_${outcome}`, attempt, outcome },
      operation: "repair",
      operationIdentity,
      attemptIdentity,
      parentEventId: mutationAttempt.event_id,
      phaseSeq: 3,
      idempotencyIdentity,
      component: "repair_worker",
      subject,
      attributes: {
        state: `mutation_${outcome}`,
        completion_reason: outcome === "unknown" ? "mutation_outcome_unknown" : "mutation_observed",
      },
    },
    { env },
  );
  assert.ok(mutationOutcome);
  return {
    started,
    mutationAttempt,
    mutationOutcome,
    operationIdentity,
    attemptIdentity,
    idempotencyIdentity,
    subject,
  };
}

function recordReview(
  root: string,
  env: NodeJS.ProcessEnv = workflowEnv(),
  now = new Date("2026-07-12T10:01:00.000Z"),
  options: {
    generatedOccurrence?: boolean;
    occurredAt?: string;
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
      ...(options.generatedOccurrence
        ? {}
        : { occurredAt: options.occurredAt ?? "2026-07-12T10:00:00.000Z" }),
    },
    {
      env,
      now: () => now,
      fetchImpl: options.fetchImpl ?? (async () => new Response(null, { status: 204 })),
    },
  );
}

function recordReviewNumber(
  root: string,
  number: number,
  env: NodeJS.ProcessEnv = workflowEnv(),
  fetchImpl: typeof fetch = async () => new Response(null, { status: 204 }),
) {
  return recordWorkflowActionEvent(
    root,
    {
      scope: "review.completed",
      identity: { repository: "openclaw/openclaw", number, sourceRevision: `abc${number}` },
      type: ACTION_EVENT_TYPES.reviewCompleted,
      component: "review",
      subject: {
        repository: "openclaw/openclaw",
        kind: "pull_request",
        number,
        sourceRevision: `abc${number}`,
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
      fetchImpl,
    },
  );
}

function producerLockRelativePath(event: ActionEvent): string {
  const identity = createHash("sha256").update(actionLedgerJson(event.producer)).digest("hex");
  return path.join(".clawsweeper-repair", "action-events", "_locks", `${identity}.lock`);
}

function shardIdentity(event: ActionEvent): ActionEventShardIdentity {
  return {
    repository: event.producer.repository,
    sha: event.producer.sha,
    producer: event.producer.component,
    workflow: event.producer.workflow,
    job: event.producer.job,
    runId: event.producer.run_id,
    runAttempt: event.producer.run_attempt,
    partitionDate: "2026-07-12",
  };
}

function readOutputEvents(outputRoot: string, relativePaths: readonly string[]): ActionEvent[] {
  return relativePaths.flatMap((relativePath) =>
    fs
      .readFileSync(path.join(outputRoot, relativePath), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ActionEvent),
  );
}

function recreateActionEvent(
  event: ActionEvent,
  {
    eventKey = event.event_key,
    parentEventId = event.parent_event_id,
    producer = event.producer,
  }: {
    eventKey?: string;
    parentEventId?: string | null;
    producer?: ActionEvent["producer"];
  } = {},
): ActionEvent {
  return createActionEvent(
    {
      eventKey,
      operationId: event.operation_id,
      attemptId: event.attempt_id,
      parentEventId,
      phaseSeq: event.phase_seq,
      idempotencyKeySha256: event.idempotency_key_sha256,
      type: event.event_type,
      producer: {
        repository: producer.repository,
        sha: producer.sha,
        workflow: producer.workflow,
        job: producer.job,
        runId: producer.run_id,
        runAttempt: producer.run_attempt,
        component: producer.component,
      },
      subject: {
        repository: event.subject.repository,
        kind: event.subject.kind,
        ...(event.subject.subject_id === undefined ? {} : { subjectId: event.subject.subject_id }),
        ...(event.subject.number === undefined ? {} : { number: event.subject.number }),
        ...(event.subject.cluster_id === undefined ? {} : { clusterId: event.subject.cluster_id }),
        ...(event.subject.source_revision === undefined
          ? {}
          : { sourceRevision: event.subject.source_revision }),
        ...(event.subject.record_path === undefined
          ? {}
          : { recordPath: event.subject.record_path }),
      },
      action: {
        name: event.action.name,
        status: event.action.status,
        ...(event.action.reason_code === undefined ? {} : { reasonCode: event.action.reason_code }),
        retryable: event.action.retryable,
        mutation: event.action.mutation,
      },
      ...(event.learning === undefined
        ? {}
        : {
            learning: {
              category: event.learning.category,
              signal: event.learning.signal,
              ...(event.learning.rule_id === undefined ? {} : { ruleId: event.learning.rule_id }),
              ...(event.learning.confidence === undefined
                ? {}
                : { confidence: event.learning.confidence }),
            },
          }),
      ...(event.evidence === undefined
        ? {}
        : {
            evidence: event.evidence.map((entry) => ({
              kind: entry.kind,
              ...(entry.sha256 === undefined ? {} : { sha256: entry.sha256 }),
              ...(entry.report_path === undefined ? {} : { reportPath: entry.report_path }),
              ...(entry.run_url === undefined ? {} : { runUrl: entry.run_url }),
              ...(entry.snapshot_id === undefined ? {} : { snapshotId: entry.snapshot_id }),
            })),
          }),
      ...(event.attributes === undefined
        ? {}
        : { attributes: event.attributes as ActionEventInput["attributes"] }),
      privacy: {
        classification: event.privacy.classification,
        redactionVersion: event.privacy.redaction_version,
        fieldsDropped: event.privacy.fields_dropped,
      },
      occurredAt: event.occurred_at,
    },
    { now: () => new Date(event.recorded_at) },
  );
}

test("workflow event telemetry is disabled outside an explicit workflow context", () => {
  for (const env of [{}, { GITHUB_ACTIONS: "true" }]) {
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
        { env },
      ),
      null,
    );
  }
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

test("timeout recovery closes only start-only review attempts before finalization", () => {
  const root = tempRoot();
  const env = workflowEnv();
  const operationIdentity = {
    repository: "openclaw/openclaw",
    candidateSnapshots: [
      {
        repository: "openclaw/openclaw",
        number: 42,
        kind: "pull_request",
        updatedAt: "2026-07-12T09:00:00Z",
      },
      {
        repository: "openclaw/openclaw",
        number: 43,
        kind: "issue",
        updatedAt: "2026-07-12T09:01:00Z",
      },
      {
        repository: "openclaw/openclaw",
        number: 44,
        kind: "pull_request",
        updatedAt: "2026-07-12T09:02:00Z",
      },
    ],
  };
  const batch = recordWorkflowPhaseEvent(
    root,
    {
      phase: ACTION_EVENT_TYPES.reviewBatch,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      retryable: false,
      mutation: false,
      identity: { slot: "batch_start" },
      operation: "review",
      operationIdentity,
      phaseSeq: 1,
      component: "review",
      subject: { repository: "openclaw/openclaw", kind: "workflow" },
    },
    { env },
  );
  assert.ok(batch);
  const openItem = recordWorkflowPhaseEvent(
    root,
    {
      phase: ACTION_EVENT_TYPES.reviewItem,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      retryable: false,
      mutation: false,
      identity: { slot: "item_start", number: 42 },
      operation: "review",
      operationIdentity,
      parentEventId: batch.event_id,
      phaseSeq: 10,
      component: "review",
      subject: { repository: "openclaw/openclaw", kind: "pull_request", number: 42 },
    },
    { env },
  );
  assert.ok(openItem);
  const completedItem = recordWorkflowPhaseEvent(
    root,
    {
      phase: ACTION_EVENT_TYPES.reviewItem,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      retryable: false,
      mutation: false,
      identity: { slot: "item_start", number: 43 },
      operation: "review",
      operationIdentity,
      parentEventId: batch.event_id,
      phaseSeq: 20,
      component: "review",
      subject: { repository: "openclaw/openclaw", kind: "issue", number: 43 },
    },
    { env },
  );
  assert.ok(completedItem);
  recordWorkflowPhaseEvent(
    root,
    {
      phase: ACTION_EVENT_TYPES.reviewItem,
      status: ACTION_EVENT_STATUSES.completed,
      reasonCode: ACTION_EVENT_REASON_CODES.completed,
      retryable: false,
      mutation: false,
      identity: { slot: "item_terminal", number: 43 },
      operation: "review",
      operationIdentity,
      parentEventId: completedItem.event_id,
      phaseSeq: 22,
      component: "review",
      subject: {
        repository: "openclaw/openclaw",
        kind: "issue",
        number: 43,
        sourceRevision: "revision-43",
      },
    },
    { env },
  );

  assert.equal(
    interruptOpenWorkflowActionEvents(root, {
      env,
      now: () => new Date("2026-07-12T10:05:00Z"),
    }),
    2,
  );
  assert.equal(interruptOpenWorkflowActionEvents(root, { env }), 0);

  const events = readAllSpooledActionEvents(root);
  const interrupted = events.filter(
    (event) =>
      event.action.status === ACTION_EVENT_STATUSES.failed &&
      event.action.reason_code === ACTION_EVENT_REASON_CODES.timeout,
  );
  assert.equal(interrupted.length, 2);
  assert.deepEqual(
    interrupted
      .map((event) => [event.event_type, event.subject.number ?? null] as const)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    [
      [ACTION_EVENT_TYPES.reviewBatch, null],
      [ACTION_EVENT_TYPES.reviewItem, 42],
    ],
  );
  assert.ok(
    interrupted.every(
      (event) =>
        event.operation_id === batch.operation_id &&
        event.attempt_id === batch.attempt_id &&
        event.action.retryable &&
        !event.action.mutation,
    ),
  );
  assert.equal(
    events.filter(
      (event) =>
        event.event_type === ACTION_EVENT_TYPES.reviewItem &&
        (event.subject.number === 43 || event.subject.number === 44) &&
        event.action.status === ACTION_EVENT_STATUSES.failed,
    ).length,
    0,
  );
  assert.equal(events.filter((event) => event.subject.number === 44).length, 0);
});

test("timeout recovery preserves hard-killed apply mutation truth and ignores untouched items", () => {
  const root = tempRoot();
  const env = workflowEnv({
    CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "apply-0",
    GITHUB_ACTION: "__apply",
    GITHUB_JOB: "apply-existing",
  });
  const operationIdentity = {
    repository: "openclaw/openclaw",
    checkpoint: "2",
    candidateRevisions: [
      { number: 41, sourceRevision: "revision-41" },
      { number: 42, sourceRevision: "revision-42" },
      { number: 43, sourceRevision: "revision-43" },
    ],
  };
  const batch = recordWorkflowPhaseEvent(
    root,
    {
      phase: ACTION_EVENT_TYPES.applyBatch,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      retryable: false,
      mutation: false,
      identity: { slot: "apply_batch_start" },
      operation: "apply",
      operationIdentity,
      phaseSeq: 1,
      idempotencyIdentity: { operationIdentity, slot: "apply_batch_start" },
      component: "apply_decisions",
      subject: { repository: "openclaw/openclaw", kind: "workflow" },
    },
    { env },
  );
  assert.ok(batch);
  const completedStart = recordWorkflowPhaseEvent(
    root,
    {
      phase: ACTION_EVENT_TYPES.applyAction,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      retryable: false,
      mutation: false,
      identity: { slot: "apply_item_start", number: 41 },
      operation: "apply",
      operationIdentity,
      parentEventId: batch.event_id,
      phaseSeq: 10,
      idempotencyIdentity: {
        operation: "apply",
        slot: "apply_item",
        repository: "openclaw/openclaw",
        number: 41,
        sourceRevision: "revision-41",
      },
      component: "apply_decisions",
      subject: {
        repository: "openclaw/openclaw",
        kind: "pull_request",
        number: 41,
        sourceRevision: "revision-41",
      },
    },
    { env },
  );
  assert.ok(completedStart);
  recordWorkflowPhaseEvent(
    root,
    {
      phase: ACTION_EVENT_TYPES.applyAction,
      status: ACTION_EVENT_STATUSES.completed,
      reasonCode: ACTION_EVENT_REASON_CODES.completed,
      retryable: false,
      mutation: false,
      identity: { slot: "apply_result", number: 41 },
      operation: "apply",
      operationIdentity,
      parentEventId: completedStart.event_id,
      phaseSeq: 12,
      idempotencyIdentity: {
        operation: "apply",
        slot: "apply_item",
        repository: "openclaw/openclaw",
        number: 41,
        sourceRevision: "revision-41",
      },
      component: "apply_decisions",
      subject: {
        repository: "openclaw/openclaw",
        kind: "pull_request",
        number: 41,
        sourceRevision: "revision-41",
      },
    },
    { env },
  );
  const activeStart = recordWorkflowPhaseEvent(
    root,
    {
      phase: ACTION_EVENT_TYPES.applyAction,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      retryable: false,
      mutation: false,
      identity: { slot: "apply_item_start", number: 42 },
      operation: "apply",
      operationIdentity,
      parentEventId: batch.event_id,
      phaseSeq: 30,
      idempotencyIdentity: {
        operation: "apply",
        slot: "apply_item",
        repository: "openclaw/openclaw",
        number: 42,
        sourceRevision: "revision-42",
      },
      component: "apply_decisions",
      subject: {
        repository: "openclaw/openclaw",
        kind: "pull_request",
        number: 42,
        sourceRevision: "revision-42",
      },
    },
    { env },
  );
  assert.ok(activeStart);
  const mutation = recordWorkflowPhaseEvent(
    root,
    {
      phase: ACTION_EVENT_TYPES.applyAction,
      status: ACTION_EVENT_STATUSES.executed,
      reasonCode: ACTION_EVENT_REASON_CODES.completed,
      retryable: true,
      mutation: true,
      identity: { slot: "apply_mutation_observed", number: 42 },
      operation: "apply",
      operationIdentity,
      parentEventId: activeStart.event_id,
      phaseSeq: 31,
      idempotencyIdentity: {
        operation: "apply",
        slot: "apply_item",
        repository: "openclaw/openclaw",
        number: 42,
        sourceRevision: "revision-42",
      },
      component: "apply_decisions",
      subject: {
        repository: "openclaw/openclaw",
        kind: "pull_request",
        number: 42,
        sourceRevision: "revision-42",
      },
    },
    { env },
  );
  assert.ok(mutation);

  assert.equal(
    interruptOpenWorkflowActionEvents(root, {
      env,
      now: () => new Date("2026-07-12T10:05:00Z"),
    }),
    2,
  );
  assert.equal(interruptOpenWorkflowActionEvents(root, { env }), 0);

  const events = readAllSpooledActionEvents(root);
  const interrupted = events.filter(
    (event) =>
      event.action.status === ACTION_EVENT_STATUSES.failed &&
      event.action.reason_code === ACTION_EVENT_REASON_CODES.timeout,
  );
  assert.equal(interrupted.length, 2);
  assert.ok(interrupted.every((event) => event.action.mutation));
  const interruptedItem = interrupted.find(
    (event) => event.event_type === ACTION_EVENT_TYPES.applyAction && event.subject.number === 42,
  );
  assert.ok(interruptedItem);
  assert.equal(interruptedItem.parent_event_id, mutation.event_id);
  assert.equal(interruptedItem.idempotency_key_sha256, activeStart.idempotency_key_sha256);
  assert.equal(
    interrupted.filter(
      (event) =>
        event.event_type === ACTION_EVENT_TYPES.applyAction &&
        (event.subject.number === 41 || event.subject.number === 43),
    ).length,
    0,
  );
  assert.equal(events.filter((event) => event.subject.number === 43).length, 0);
});

test("timeout recovery terminalizes the latest open mutation before its item summary", () => {
  const root = tempRoot();
  const env = workflowEnv({
    CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "apply-uncertain",
    GITHUB_ACTION: "__apply",
    GITHUB_JOB: "apply-existing",
  });
  const operationIdentity = {
    repository: "openclaw/openclaw",
    candidateRevisions: [{ number: 52, sourceRevision: "revision-52" }],
  };
  const batch = recordWorkflowPhaseEvent(
    root,
    {
      phase: ACTION_EVENT_TYPES.applyBatch,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      retryable: false,
      mutation: false,
      identity: { slot: "apply_batch_start" },
      operation: "apply",
      operationIdentity,
      phaseSeq: 1,
      idempotencyIdentity: { operationIdentity, slot: "apply_batch_start" },
      component: "apply_decisions",
      subject: { repository: "openclaw/openclaw", kind: "workflow" },
    },
    { env },
  );
  assert.ok(batch);
  const item = recordWorkflowPhaseEvent(
    root,
    {
      phase: ACTION_EVENT_TYPES.applyAction,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      retryable: false,
      mutation: false,
      identity: { slot: "apply_item_start", number: 52 },
      operation: "apply",
      operationIdentity,
      parentEventId: batch.event_id,
      phaseSeq: 10,
      idempotencyIdentity: {
        operation: "apply",
        slot: "apply_item",
        repository: "openclaw/openclaw",
        number: 52,
        sourceRevision: "revision-52",
      },
      component: "apply_decisions",
      subject: {
        repository: "openclaw/openclaw",
        kind: "pull_request",
        number: 52,
        sourceRevision: "revision-52",
      },
    },
    { env },
  );
  assert.ok(item);
  const acceptedAttempt = recordWorkflowPhaseEvent(
    root,
    {
      phase: ACTION_EVENT_TYPES.applyAction,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      retryable: false,
      mutation: false,
      identity: { slot: "apply_mutation_attempt", mutationIdentitySha256: "a".repeat(64) },
      operation: "apply",
      operationIdentity,
      parentEventId: item.event_id,
      phaseSeq: 11,
      idempotencyIdentity: {
        operation: "apply",
        slot: "apply_mutation",
        repository: "openclaw/openclaw",
        number: 52,
        sourceRevision: "revision-52",
        mutationIdentitySha256: "a".repeat(64),
      },
      component: "apply_decisions",
      subject: {
        repository: "openclaw/openclaw",
        kind: "pull_request",
        number: 52,
        sourceRevision: "revision-52",
      },
      attributes: { completion_reason: "mutation_attempted" },
    },
    { env },
  );
  assert.ok(acceptedAttempt);
  const acceptedOutcome = recordWorkflowPhaseEvent(
    root,
    {
      phase: ACTION_EVENT_TYPES.applyAction,
      status: ACTION_EVENT_STATUSES.executed,
      reasonCode: ACTION_EVENT_REASON_CODES.completed,
      retryable: false,
      mutation: true,
      identity: { slot: "apply_mutation_outcome", outcome: "accepted" },
      operation: "apply",
      operationIdentity,
      parentEventId: acceptedAttempt.event_id,
      phaseSeq: 12,
      idempotencyIdentity: {
        operation: "apply",
        slot: "apply_mutation",
        repository: "openclaw/openclaw",
        number: 52,
        sourceRevision: "revision-52",
        mutationIdentitySha256: "a".repeat(64),
      },
      component: "apply_decisions",
      subject: {
        repository: "openclaw/openclaw",
        kind: "pull_request",
        number: 52,
        sourceRevision: "revision-52",
      },
      attributes: { completion_reason: "mutation_accepted" },
    },
    { env },
  );
  assert.ok(acceptedOutcome);
  const attempt = recordWorkflowPhaseEvent(
    root,
    {
      phase: ACTION_EVENT_TYPES.applyAction,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      retryable: false,
      mutation: false,
      identity: { slot: "apply_mutation_attempt", mutationIdentitySha256: "c".repeat(64) },
      operation: "apply",
      operationIdentity,
      parentEventId: acceptedOutcome.event_id,
      phaseSeq: 13,
      idempotencyIdentity: {
        operation: "apply",
        slot: "apply_mutation",
        repository: "openclaw/openclaw",
        number: 52,
        sourceRevision: "revision-52",
        mutationIdentitySha256: "c".repeat(64),
      },
      component: "apply_decisions",
      subject: {
        repository: "openclaw/openclaw",
        kind: "pull_request",
        number: 52,
        sourceRevision: "revision-52",
      },
      attributes: { completion_reason: "mutation_attempted" },
    },
    { env },
  );
  assert.ok(attempt);
  const rejectedItem = recordWorkflowPhaseEvent(
    root,
    {
      phase: ACTION_EVENT_TYPES.applyAction,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      retryable: false,
      mutation: false,
      identity: { slot: "apply_item_start", number: 53 },
      operation: "apply",
      operationIdentity,
      parentEventId: batch.event_id,
      phaseSeq: 30,
      idempotencyIdentity: {
        operation: "apply",
        slot: "apply_item",
        repository: "openclaw/openclaw",
        number: 53,
        sourceRevision: "revision-53",
      },
      component: "apply_decisions",
      subject: {
        repository: "openclaw/openclaw",
        kind: "pull_request",
        number: 53,
        sourceRevision: "revision-53",
      },
    },
    { env },
  );
  assert.ok(rejectedItem);
  const rejectedAttempt = recordWorkflowPhaseEvent(
    root,
    {
      phase: ACTION_EVENT_TYPES.applyAction,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      retryable: false,
      mutation: false,
      identity: { slot: "apply_mutation_attempt", mutationIdentitySha256: "b".repeat(64) },
      operation: "apply",
      operationIdentity,
      parentEventId: rejectedItem.event_id,
      phaseSeq: 31,
      idempotencyIdentity: {
        operation: "apply",
        slot: "apply_mutation",
        repository: "openclaw/openclaw",
        number: 53,
        sourceRevision: "revision-53",
        mutationIdentitySha256: "b".repeat(64),
      },
      component: "apply_decisions",
      subject: {
        repository: "openclaw/openclaw",
        kind: "pull_request",
        number: 53,
        sourceRevision: "revision-53",
      },
      attributes: { completion_reason: "mutation_attempted" },
    },
    { env },
  );
  assert.ok(rejectedAttempt);
  const rejectedOutcome = recordWorkflowPhaseEvent(
    root,
    {
      phase: ACTION_EVENT_TYPES.applyAction,
      status: ACTION_EVENT_STATUSES.skipped,
      reasonCode: ACTION_EVENT_REASON_CODES.notApplicable,
      retryable: false,
      mutation: false,
      identity: { slot: "apply_mutation_outcome", outcome: "rejected" },
      operation: "apply",
      operationIdentity,
      parentEventId: rejectedAttempt.event_id,
      phaseSeq: 32,
      idempotencyIdentity: {
        operation: "apply",
        slot: "apply_mutation",
        repository: "openclaw/openclaw",
        number: 53,
        sourceRevision: "revision-53",
        mutationIdentitySha256: "b".repeat(64),
      },
      component: "apply_decisions",
      subject: {
        repository: "openclaw/openclaw",
        kind: "pull_request",
        number: 53,
        sourceRevision: "revision-53",
      },
      attributes: { completion_reason: "mutation_rejected" },
    },
    { env },
  );
  assert.ok(rejectedOutcome);

  assert.equal(interruptOpenWorkflowActionEvents(root, { env }), 4);
  const events = readAllSpooledActionEvents(root);
  const recovered = events.filter(
    (event) =>
      event.action.status === ACTION_EVENT_STATUSES.failed &&
      event.attributes?.completion_reason === "mutation_outcome_unknown",
  );
  assert.equal(recovered.length, 3);
  assert.ok(recovered.every((event) => event.action.mutation));
  const recoveredAttempt = recovered.find(
    (event) => event.idempotency_key_sha256 === attempt.idempotency_key_sha256,
  );
  assert.ok(recoveredAttempt);
  assert.equal(recoveredAttempt.parent_event_id, attempt.event_id);
  assert.notEqual(recoveredAttempt.parent_event_id, acceptedOutcome.event_id);
  assert.ok(acceptedOutcome.phase_seq < attempt.phase_seq);
  assert.ok(attempt.phase_seq < recoveredAttempt.phase_seq);
  const recoveredItem = recovered.find(
    (event) =>
      event.subject.number === 52 && event.idempotency_key_sha256 === item.idempotency_key_sha256,
  );
  assert.ok(recoveredItem);
  assert.equal(recoveredItem.parent_event_id, recoveredAttempt.event_id);
  assert.ok(recoveredAttempt.phase_seq < recoveredItem.phase_seq);
  const rejectedRecovery = events.find(
    (event) =>
      event.subject.number === 53 &&
      event.action.status === ACTION_EVENT_STATUSES.failed &&
      event.attributes?.completion_reason === "timeout",
  );
  assert.ok(rejectedRecovery);
  assert.equal(rejectedRecovery.action.mutation, false);
  assert.equal(rejectedRecovery.parent_event_id, rejectedOutcome.event_id);
  const recoveredTerminals = events.filter(
    (event) =>
      event.action.status === ACTION_EVENT_STATUSES.failed && event.attributes?.partial === true,
  );
  assert.equal(recoveredTerminals.length, 4);
  const eventsById = new Map(events.map((event) => [event.event_id, event]));
  for (const terminal of recoveredTerminals) {
    const parent = terminal.parent_event_id ? eventsById.get(terminal.parent_event_id) : null;
    assert.ok(parent);
    assert.ok(terminal.phase_seq > parent.phase_seq);
  }
  const phaseSeqs = events.map((event) => event.phase_seq);
  assert.equal(new Set(phaseSeqs).size, phaseSeqs.length);
  assert.equal(interruptOpenWorkflowActionEvents(root, { env }), 0);
});

test("interruption recovery follows the latest accepted mutation ordinal", () => {
  const root = tempRoot();
  const env = workflowEnv({
    CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "apply-ordered-mutations",
    GITHUB_ACTION: "__apply",
    GITHUB_JOB: "apply-existing",
  });
  const operationIdentity = {
    repository: "openclaw/openclaw",
    candidateRevisions: [{ number: 53, sourceRevision: "revision-53" }],
  };
  const batch = recordWorkflowPhaseEvent(
    root,
    {
      phase: ACTION_EVENT_TYPES.applyBatch,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      retryable: false,
      mutation: false,
      identity: { slot: "apply_batch_start" },
      operation: "apply",
      operationIdentity,
      phaseSeq: 1,
      idempotencyIdentity: { operationIdentity, slot: "apply_batch_start" },
      component: "apply_decisions",
      subject: { repository: "openclaw/openclaw", kind: "workflow" },
    },
    { env },
  );
  assert.ok(batch);
  const item = recordWorkflowPhaseEvent(
    root,
    {
      phase: ACTION_EVENT_TYPES.applyAction,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      retryable: false,
      mutation: false,
      identity: { slot: "apply_item_start", number: 53 },
      operation: "apply",
      operationIdentity,
      parentEventId: batch.event_id,
      phaseSeq: 2,
      idempotencyIdentity: {
        operation: "apply",
        slot: "apply_item",
        repository: "openclaw/openclaw",
        number: 53,
        sourceRevision: "revision-53",
      },
      component: "apply_decisions",
      subject: {
        repository: "openclaw/openclaw",
        kind: "pull_request",
        number: 53,
        sourceRevision: "revision-53",
      },
    },
    { env },
  );
  assert.ok(item);

  let parentEventId = item.event_id;
  let latestOutcome: ActionEvent | null = null;
  for (const [index, mutationIdentitySha256] of ["f".repeat(64), "0".repeat(64)].entries()) {
    const idempotencyIdentity = {
      operation: "apply",
      slot: "apply_mutation",
      repository: "openclaw/openclaw",
      number: 53,
      sourceRevision: "revision-53",
      mutationIdentitySha256,
    };
    const attempt = recordWorkflowPhaseEvent(
      root,
      {
        phase: ACTION_EVENT_TYPES.applyAction,
        status: ACTION_EVENT_STATUSES.started,
        reasonCode: ACTION_EVENT_REASON_CODES.selected,
        retryable: true,
        mutation: false,
        identity: { slot: "apply_mutation_attempt", mutationIdentitySha256 },
        operation: "apply",
        operationIdentity,
        parentEventId,
        phaseSeq: 3 + index * 2,
        idempotencyIdentity,
        component: "apply_decisions",
        subject: {
          repository: "openclaw/openclaw",
          kind: "pull_request",
          number: 53,
          sourceRevision: "revision-53",
        },
        attributes: { completion_reason: "mutation_attempted" },
      },
      { env },
    );
    assert.ok(attempt);
    const outcome = recordWorkflowPhaseEvent(
      root,
      {
        phase: ACTION_EVENT_TYPES.applyAction,
        status: ACTION_EVENT_STATUSES.executed,
        reasonCode: ACTION_EVENT_REASON_CODES.completed,
        retryable: false,
        mutation: true,
        identity: { slot: "apply_mutation_outcome", mutationIdentitySha256, outcome: "accepted" },
        operation: "apply",
        operationIdentity,
        parentEventId: attempt.event_id,
        phaseSeq: 4 + index * 2,
        idempotencyIdentity,
        component: "apply_decisions",
        subject: {
          repository: "openclaw/openclaw",
          kind: "pull_request",
          number: 53,
          sourceRevision: "revision-53",
        },
        attributes: { completion_reason: "mutation_accepted" },
      },
      { env },
    );
    assert.ok(outcome);
    parentEventId = outcome.event_id;
    latestOutcome = outcome;
  }

  assert.ok(latestOutcome);
  assert.equal(interruptOpenWorkflowActionEvents(root, { env }), 2);
  const recoveredItem = readAllSpooledActionEvents(root).find(
    (event) =>
      event.subject.number === 53 &&
      event.attributes?.completion_reason === "timeout" &&
      event.attributes.partial === true,
  );
  assert.ok(recoveredItem);
  assert.equal(recoveredItem.parent_event_id, latestOutcome.event_id);
  assert.ok(recoveredItem.phase_seq > latestOutcome.phase_seq);
  const attemptPhases = readAllSpooledActionEvents(root)
    .filter(
      (event) =>
        event.operation_id === recoveredItem.operation_id &&
        event.attempt_id === recoveredItem.attempt_id,
    )
    .map((event) => event.phase_seq);
  assert.equal(new Set(attemptPhases).size, attemptPhases.length);
  assert.equal(recoveredItem.action.mutation, true);
  assert.equal(recoveredItem.action.retryable, true);
});

test("review interruption recovery aggregates coordination comment mutations", () => {
  const root = tempRoot();
  const env = workflowEnv({
    CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "review-coordination-mutation",
    GITHUB_ACTION: "__review",
    GITHUB_JOB: "review",
  });
  const operationIdentity = {
    repository: "openclaw/openclaw",
    candidateSnapshots: [
      {
        repository: "openclaw/openclaw",
        kind: "pull_request",
        number: 54,
        updatedAt: "2026-07-12T12:00:00Z",
      },
    ],
  };
  const batch = recordWorkflowPhaseEvent(
    root,
    {
      phase: ACTION_EVENT_TYPES.reviewBatch,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      retryable: false,
      mutation: false,
      identity: { slot: "review_batch_start" },
      operation: "review",
      operationIdentity,
      phaseSeq: 1,
      idempotencyIdentity: { operationIdentity, slot: "review_batch_start" },
      component: "review",
      subject: { repository: "openclaw/openclaw", kind: "workflow" },
    },
    { env },
  );
  assert.ok(batch);
  const item = recordWorkflowPhaseEvent(
    root,
    {
      phase: ACTION_EVENT_TYPES.reviewItem,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      retryable: false,
      mutation: false,
      identity: { slot: "review_item_start", number: 54 },
      operation: "review",
      operationIdentity,
      parentEventId: batch.event_id,
      phaseSeq: 2,
      idempotencyIdentity: {
        operation: "review",
        slot: "review_item",
        repository: "openclaw/openclaw",
        number: 54,
      },
      component: "review",
      subject: {
        repository: "openclaw/openclaw",
        kind: "pull_request",
        number: 54,
        sourceRevision: "a".repeat(40),
      },
    },
    { env },
  );
  assert.ok(item);
  const mutationIdentity = {
    operation: "review",
    slot: "coordination_mutation",
    repository: "openclaw/openclaw",
    number: 54,
    mutationIdentitySha256: "b".repeat(64),
  };
  const attempt = recordWorkflowPhaseEvent(
    root,
    {
      phase: ACTION_EVENT_TYPES.reviewItem,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      retryable: true,
      mutation: false,
      identity: { slot: "review_coordination_mutation_attempt", number: 54 },
      operation: "review",
      operationIdentity,
      parentEventId: item.event_id,
      phaseSeq: 3,
      idempotencyIdentity: mutationIdentity,
      component: "review",
      subject: {
        repository: "openclaw/openclaw",
        kind: "pull_request",
        number: 54,
        sourceRevision: "a".repeat(40),
      },
      attributes: { completion_reason: "mutation_attempted" },
    },
    { env },
  );
  assert.ok(attempt);
  const outcome = recordWorkflowPhaseEvent(
    root,
    {
      phase: ACTION_EVENT_TYPES.reviewItem,
      status: ACTION_EVENT_STATUSES.executed,
      reasonCode: ACTION_EVENT_REASON_CODES.completed,
      retryable: false,
      mutation: true,
      identity: { slot: "review_coordination_mutation_outcome", number: 54 },
      operation: "review",
      operationIdentity,
      parentEventId: attempt.event_id,
      phaseSeq: 4,
      idempotencyIdentity: mutationIdentity,
      component: "review",
      subject: {
        repository: "openclaw/openclaw",
        kind: "pull_request",
        number: 54,
        sourceRevision: "a".repeat(40),
      },
      attributes: { completion_reason: "mutation_accepted" },
    },
    { env },
  );
  assert.ok(outcome);

  assert.equal(interruptOpenWorkflowActionEvents(root, { env }), 2);
  const recovered = readAllSpooledActionEvents(root).filter(
    (event) =>
      event.attributes?.completion_reason === "timeout" && event.action.status === "failed",
  );
  const recoveredItem = recovered.find((event) => event.subject.number === 54);
  const recoveredBatch = recovered.find((event) => event.subject.kind === "workflow");
  assert.ok(recoveredItem);
  assert.ok(recoveredBatch);
  assert.equal(recoveredItem.parent_event_id, outcome.event_id);
  assert.ok(recoveredItem.phase_seq > outcome.phase_seq);
  assert.equal(recoveredItem.action.mutation, true);
  assert.equal(recoveredBatch.action.mutation, true);
});

test("interruption recovery preserves any earlier unknown mutation outcome", () => {
  const root = tempRoot();
  const env = workflowEnv({
    CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "apply-unknown-then-accepted",
    GITHUB_ACTION: "__apply",
    GITHUB_JOB: "apply-existing",
  });
  const operationIdentity = {
    repository: "openclaw/openclaw",
    candidateRevisions: [{ number: 54, sourceRevision: "revision-54" }],
  };
  const batch = recordWorkflowPhaseEvent(
    root,
    {
      phase: ACTION_EVENT_TYPES.applyBatch,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      retryable: false,
      mutation: false,
      identity: { slot: "apply_batch_start" },
      operation: "apply",
      operationIdentity,
      phaseSeq: 1,
      idempotencyIdentity: { operationIdentity, slot: "apply_batch_start" },
      component: "apply_decisions",
      subject: { repository: "openclaw/openclaw", kind: "workflow" },
    },
    { env },
  );
  assert.ok(batch);
  const item = recordWorkflowPhaseEvent(
    root,
    {
      phase: ACTION_EVENT_TYPES.applyAction,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      retryable: false,
      mutation: false,
      identity: { slot: "apply_item_start", number: 54 },
      operation: "apply",
      operationIdentity,
      parentEventId: batch.event_id,
      phaseSeq: 10,
      idempotencyIdentity: {
        operation: "apply",
        slot: "apply_item",
        repository: "openclaw/openclaw",
        number: 54,
        sourceRevision: "revision-54",
      },
      component: "apply_decisions",
      subject: {
        repository: "openclaw/openclaw",
        kind: "pull_request",
        number: 54,
        sourceRevision: "revision-54",
      },
    },
    { env },
  );
  assert.ok(item);

  const recordAttempt = (
    mutationIdentitySha256: string,
    outcome: "unknown" | "accepted",
    phaseSeq: number,
  ): ActionEvent => {
    const idempotencyIdentity = {
      operation: "apply",
      slot: "apply_mutation",
      repository: "openclaw/openclaw",
      number: 54,
      sourceRevision: "revision-54",
      mutationIdentitySha256,
    };
    const attempt = recordWorkflowPhaseEvent(
      root,
      {
        phase: ACTION_EVENT_TYPES.applyAction,
        status: ACTION_EVENT_STATUSES.started,
        reasonCode: ACTION_EVENT_REASON_CODES.selected,
        retryable: true,
        mutation: false,
        identity: { slot: "apply_mutation_attempt", mutationIdentitySha256 },
        operation: "apply",
        operationIdentity,
        parentEventId: item.event_id,
        phaseSeq,
        idempotencyIdentity,
        component: "apply_decisions",
        subject: {
          repository: "openclaw/openclaw",
          kind: "pull_request",
          number: 54,
          sourceRevision: "revision-54",
        },
        attributes: { completion_reason: "mutation_attempted" },
      },
      { env },
    );
    assert.ok(attempt);
    const terminal = recordWorkflowPhaseEvent(
      root,
      {
        phase: ACTION_EVENT_TYPES.applyAction,
        status:
          outcome === "accepted" ? ACTION_EVENT_STATUSES.executed : ACTION_EVENT_STATUSES.failed,
        reasonCode:
          outcome === "accepted"
            ? ACTION_EVENT_REASON_CODES.completed
            : ACTION_EVENT_REASON_CODES.unavailable,
        retryable: outcome === "unknown",
        mutation: true,
        identity: { slot: "apply_mutation_outcome", mutationIdentitySha256, outcome },
        operation: "apply",
        operationIdentity,
        parentEventId: attempt.event_id,
        phaseSeq: phaseSeq + 1,
        idempotencyIdentity,
        component: "apply_decisions",
        subject: {
          repository: "openclaw/openclaw",
          kind: "pull_request",
          number: 54,
          sourceRevision: "revision-54",
        },
        attributes: {
          completion_reason:
            outcome === "accepted" ? "mutation_accepted" : "mutation_outcome_unknown",
        },
      },
      { env },
    );
    assert.ok(terminal);
    return terminal;
  };

  const unknown = recordAttempt("a".repeat(64), "unknown", 11);
  recordAttempt("b".repeat(64), "accepted", 21);

  assert.equal(interruptOpenWorkflowActionEvents(root, { env }), 2);
  const allEvents = readAllSpooledActionEvents(root);
  const recovered = allEvents.filter(
    (event) =>
      event.attributes?.completion_reason === "mutation_outcome_unknown" &&
      event.attributes.partial === true,
  );
  assert.equal(recovered.length, 2);
  assert.ok(recovered.every((event) => event.action.mutation));
  assert.ok(recovered.every((event) => event.action.retryable === false));
  const itemTerminal = recovered.find((event) => event.subject.number === 54);
  assert.ok(itemTerminal);
  assert.equal(itemTerminal?.parent_event_id, unknown.event_id);
  assert.ok(unknown.phase_seq < itemTerminal.phase_seq);
  const batchTerminal = recovered.find((event) => event.subject.kind === "workflow");
  assert.ok(batchTerminal);
  assert.equal(batchTerminal.parent_event_id, itemTerminal.event_id);
  assert.ok(itemTerminal.phase_seq < batchTerminal.phase_seq);
  assert.equal(interruptOpenWorkflowActionEvents(root, { env }), 0);
});

test("interruption recovery closes the exact retry dispatch and aggregates it into the batch", () => {
  const root = tempRoot();
  const env = workflowEnv({
    CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "retry-0",
    GITHUB_ACTION: "__retry",
    GITHUB_JOB: "retry-failed-reviews",
  });
  const operationIdentity = {
    repository: "openclaw/openclaw",
    requestedItemNumbers: [42],
  };
  const batch = recordWorkflowPhaseEvent(
    root,
    {
      phase: ACTION_EVENT_TYPES.reviewRetry,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      retryable: false,
      mutation: false,
      identity: { slot: "retry_batch_start" },
      operation: "review_retry",
      operationIdentity,
      phaseSeq: 1,
      idempotencyIdentity: { operationIdentity, slot: "retry_batch_start" },
      component: "retry_failed_reviews",
      subject: { repository: "openclaw/openclaw", kind: "workflow" },
    },
    { env },
  );
  assert.ok(batch);
  const dispatch = recordWorkflowPhaseEvent(
    root,
    {
      phase: ACTION_EVENT_TYPES.reviewRetry,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      retryable: false,
      mutation: false,
      identity: { slot: "retry_dispatch_attempt", number: 42 },
      operation: "review_retry",
      operationIdentity,
      parentEventId: batch.event_id,
      phaseSeq: 100_000,
      idempotencyIdentity: {
        operation: "review_retry",
        slot: "retry_dispatch",
        repository: "openclaw/openclaw",
        number: 42,
        sourceRevision: "revision-42",
      },
      component: "retry_failed_reviews",
      subject: {
        repository: "openclaw/openclaw",
        kind: "issue",
        number: 42,
        sourceRevision: "revision-42",
      },
      attributes: { completion_reason: "dispatch_attempted" },
    },
    { env },
  );
  assert.ok(dispatch);

  assert.equal(
    interruptOpenWorkflowActionEvents(root, {
      env,
      reasonCode: ACTION_EVENT_REASON_CODES.workflowFailed,
    }),
    2,
  );
  const events = readAllSpooledActionEvents(root);
  const dispatchTerminal = events.find(
    (event) =>
      event.parent_event_id === dispatch.event_id &&
      event.subject.number === 42 &&
      event.attributes?.completion_reason === "dispatch_outcome_unknown",
  );
  assert.ok(dispatchTerminal);
  assert.equal(dispatchTerminal.idempotency_key_sha256, dispatch.idempotency_key_sha256);
  assert.equal(dispatchTerminal.action.retryable, false);
  assert.equal(dispatchTerminal.action.mutation, true);

  const batchTerminal = events.find(
    (event) =>
      event.subject.kind === "workflow" &&
      event.action.status === ACTION_EVENT_STATUSES.failed &&
      event.phase_seq === 1_000_000,
  );
  assert.ok(batchTerminal);
  assert.equal(batchTerminal.parent_event_id, dispatchTerminal.event_id);
  assert.ok(dispatchTerminal.phase_seq < batchTerminal.phase_seq);
  assert.equal(batchTerminal.action.mutation, true);
  assert.equal(batchTerminal.action.retryable, false);
  assert.equal(interruptOpenWorkflowActionEvents(root, { env }), 0);
});

test("interruption recovery preserves cancellation instead of rewriting it as timeout", () => {
  const root = tempRoot();
  const env = workflowEnv({ CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "cancelled-review" });
  recordWorkflowPhaseEvent(
    root,
    {
      phase: ACTION_EVENT_TYPES.reviewBatch,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      retryable: false,
      mutation: false,
      identity: { slot: "review_batch_start" },
      operation: "review",
      operationIdentity: { repository: "openclaw/openclaw" },
      phaseSeq: 1,
      component: "review",
      subject: { repository: "openclaw/openclaw", kind: "workflow" },
    },
    { env },
  );

  assert.equal(
    interruptOpenWorkflowActionEvents(root, {
      env,
      reasonCode: ACTION_EVENT_REASON_CODES.cancelled,
    }),
    1,
  );
  const terminal = readAllSpooledActionEvents(root).find(
    (event) => event.action.status === ACTION_EVENT_STATUSES.cancelled,
  );
  assert.equal(terminal?.action.reason_code, ACTION_EVENT_REASON_CODES.cancelled);
  assert.equal(terminal?.attributes?.completion_reason, "cancelled");
});

test("interruption recovery preserves unknown child mutations on workflow attempts", () => {
  const root = tempRoot();
  const env = workflowEnv({
    CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "repair-attempt-unknown-mutation",
  });
  const { mutationOutcome } = recordWorkflowAttemptMutationOutcome(root, env, "unknown");
  assert.ok(mutationOutcome);

  assert.equal(interruptOpenWorkflowActionEvents(root, { env }), 1);
  const terminal = readAllSpooledActionEvents(root).find(
    (event) =>
      event.event_type === ACTION_EVENT_TYPES.workflowAttempt &&
      event.action.status === ACTION_EVENT_STATUSES.failed,
  );
  assert.ok(terminal);
  assert.equal(terminal.parent_event_id, mutationOutcome.event_id);
  assert.equal(terminal.action.mutation, true);
  assert.equal(terminal.action.retryable, false);
  assert.equal(terminal.attributes?.completion_reason, "mutation_outcome_unknown");
  assert.equal(interruptOpenWorkflowActionEvents(root, { env }), 0);
});

test("interruption recovery preserves observed child mutations on workflow attempts", () => {
  const root = tempRoot();
  const env = workflowEnv({
    CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "repair-attempt-observed-mutation",
  });
  const { mutationOutcome } = recordWorkflowAttemptMutationOutcome(root, env, "observed");
  assert.ok(mutationOutcome);

  assert.equal(interruptOpenWorkflowActionEvents(root, { env }), 1);
  const terminal = readAllSpooledActionEvents(root).find(
    (event) =>
      event.event_type === ACTION_EVENT_TYPES.workflowAttempt &&
      event.action.status === ACTION_EVENT_STATUSES.failed,
  );
  assert.ok(terminal);
  assert.equal(terminal.parent_event_id, mutationOutcome.event_id);
  assert.equal(terminal.action.mutation, true);
  assert.equal(terminal.action.retryable, true);
  assert.equal(terminal.attributes?.completion_reason, "timeout");
  assert.equal(interruptOpenWorkflowActionEvents(root, { env }), 0);
});

test("interruption recovery terminalizes dangling repair execution before its workflow attempt", () => {
  const root = tempRoot();
  const env = workflowEnv({
    CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "repair-attempt-crash-window",
  });
  const { mutationAttempt } = recordWorkflowAttemptMutationOutcome(root, env, null);

  assert.equal(interruptOpenWorkflowActionEvents(root, { env }), 2);
  const events = readAllSpooledActionEvents(root);
  const repairTerminal = events.find(
    (event) =>
      event.event_type === ACTION_EVENT_TYPES.repairExecute &&
      event.action.status === ACTION_EVENT_STATUSES.failed,
  );
  assert.ok(repairTerminal);
  assert.equal(repairTerminal.parent_event_id, mutationAttempt.event_id);
  assert.equal(repairTerminal.idempotency_key_sha256, mutationAttempt.idempotency_key_sha256);
  assert.equal(repairTerminal.attributes?.completion_reason, "mutation_outcome_unknown");
  assert.equal(repairTerminal.action.retryable, false);

  const attemptTerminal = events.find(
    (event) =>
      event.event_type === ACTION_EVENT_TYPES.workflowAttempt &&
      event.action.status === ACTION_EVENT_STATUSES.failed,
  );
  assert.ok(attemptTerminal);
  assert.equal(attemptTerminal.parent_event_id, repairTerminal.event_id);
  assert.ok(repairTerminal.phase_seq < attemptTerminal.phase_seq);
  assert.equal(attemptTerminal.attributes?.completion_reason, "mutation_outcome_unknown");
  assert.equal(attemptTerminal.action.retryable, false);
  assert.equal(interruptOpenWorkflowActionEvents(root, { env }), 0);
});

test("later observed mutation truth supersedes an earlier unknown outcome", () => {
  const root = tempRoot();
  const env = workflowEnv({
    CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "repair-attempt-later-observation",
  });
  const recorded = recordWorkflowAttemptMutationOutcome(root, env, "unknown");
  assert.ok(recorded.mutationOutcome);
  const observed = recordWorkflowPhaseEvent(
    root,
    {
      phase: ACTION_EVENT_PHASE_TYPES.repairExecute,
      status: ACTION_EVENT_STATUSES.executed,
      reasonCode: ACTION_EVENT_REASON_CODES.alreadyComplete,
      retryable: false,
      mutation: true,
      identity: { state: "mutation_observed", attempt: 1 },
      operation: "repair",
      operationIdentity: recorded.operationIdentity,
      attemptIdentity: recorded.attemptIdentity,
      parentEventId: recorded.mutationAttempt.event_id,
      phaseSeq: 4,
      idempotencyIdentity: recorded.idempotencyIdentity,
      component: "repair_worker",
      subject: recorded.subject,
      attributes: {
        state: "mutation_observed",
        completion_reason: "mutation_observed",
      },
    },
    { env },
  );
  assert.ok(observed);
  assert.equal(observed.idempotency_key_sha256, recorded.mutationOutcome.idempotency_key_sha256);

  assert.equal(interruptOpenWorkflowActionEvents(root, { env }), 1);
  const terminal = readAllSpooledActionEvents(root).find(
    (event) =>
      event.event_type === ACTION_EVENT_TYPES.workflowAttempt &&
      event.action.status === ACTION_EVENT_STATUSES.failed,
  );
  assert.ok(terminal);
  assert.equal(terminal.parent_event_id, observed.event_id);
  assert.equal(terminal.action.mutation, true);
  assert.equal(terminal.action.retryable, true);
  assert.equal(terminal.attributes?.completion_reason, "timeout");
});

test("workflow attempt mutation aggregation is bounded to the exact attempt", () => {
  const root = tempRoot();
  const env = workflowEnv({
    CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "repair-attempt-bounded-mutations",
  });
  const workKey = "openclaw/openclaw:bounded";
  const unknown = recordWorkflowAttemptMutationOutcome(root, env, "unknown", {
    workKey,
    attempt: 1,
  });
  const observed = recordWorkflowAttemptMutationOutcome(root, env, "observed", {
    workKey,
    attempt: 2,
  });

  assert.equal(interruptOpenWorkflowActionEvents(root, { env }), 2);
  const terminals = readAllSpooledActionEvents(root).filter(
    (event) =>
      event.event_type === ACTION_EVENT_TYPES.workflowAttempt &&
      event.action.status === ACTION_EVENT_STATUSES.failed,
  );
  assert.equal(terminals.length, 2);

  const unknownTerminal = terminals.find(
    (event) => event.attempt_id === unknown.started.attempt_id,
  );
  assert.ok(unknownTerminal);
  assert.ok(unknown.mutationOutcome);
  assert.equal(unknownTerminal.parent_event_id, unknown.mutationOutcome.event_id);
  assert.equal(unknownTerminal.attributes?.completion_reason, "mutation_outcome_unknown");
  assert.equal(unknownTerminal.action.retryable, false);

  const observedTerminal = terminals.find(
    (event) => event.attempt_id === observed.started.attempt_id,
  );
  assert.ok(observedTerminal);
  assert.ok(observed.mutationOutcome);
  assert.equal(observedTerminal.parent_event_id, observed.mutationOutcome.event_id);
  assert.equal(observedTerminal.attributes?.completion_reason, "timeout");
  assert.equal(observedTerminal.action.retryable, true);
  assert.equal(interruptOpenWorkflowActionEvents(root, { env }), 0);
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

test("workflow writers reject explicitly empty source timestamps", () => {
  const root = tempRoot();
  assert.throws(
    () =>
      recordReview(root, workflowEnv(), new Date("2026-07-12T10:01:00.000Z"), {
        occurredAt: "",
      }),
    /action event occurredAt is required/,
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
  assert.equal(
    workflowActionProducer(
      "review",
      workflowEnv({
        GITHUB_WORKFLOW_REF:
          "openclaw/clawsweeper/.github/workflows/sweep@nightly.yml@refs/heads/main",
      }),
    ).workflow,
    "sweep@nightly.yml",
  );
});

test("workflow producer normalization preserves distinct original identities", () => {
  const readable = workflowActionProducer("review-lane", workflowEnv());
  const sanitized = workflowActionProducer("review lane", workflowEnv());
  assert.notEqual(sanitized.component, readable.component);
  assert.match(sanitized.component, /^review-lane-[a-f0-9]{12}\./);

  const sharedPrefix = "review-".repeat(30);
  const first = workflowActionProducer(`${sharedPrefix}first`, workflowEnv());
  const second = workflowActionProducer(`${sharedPrefix}second`, workflowEnv());
  assert.notEqual(first.component, second.component);
  assert.ok(first.component.length <= 120 + 1 + 64 + 1 + 64);
  assert.match(first.component, /-[a-f0-9]{12}\.__run_5\.review-0$/);

  const root = tempRoot();
  const firstEvent = recordWorkflowActionEvent(
    root,
    {
      scope: "review.completed",
      identity: { number: 42 },
      type: ACTION_EVENT_TYPES.reviewCompleted,
      component: "review lane",
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
    { env: workflowEnv() },
  );
  const secondEvent = recordWorkflowActionEvent(
    root,
    {
      scope: "review.completed",
      identity: { number: 42 },
      type: ACTION_EVENT_TYPES.reviewCompleted,
      component: "review-lane",
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
    { env: workflowEnv() },
  );
  assert.ok(firstEvent);
  assert.ok(secondEvent);
  assert.notEqual(firstEvent.producer.component, secondEvent.producer.component);
  assert.notEqual(firstEvent.event_key, secondEvent.event_key);
  assert.notEqual(firstEvent.event_id, secondEvent.event_id);
});

test("workflow events finalize into one replay-stable per-step shard", async () => {
  const root = tempRoot();
  const outputRoot = trustedChildRoot(root, "state");
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
    /^ledger\/v1\/events\/2026\/07\/12\/openclaw-clawsweeper\/review\.__run_5\.review-0\/100-2-review-[a-f0-9]{12}-part-000001-of-000001\.jsonl$/,
  );
  assert.equal(
    fs.readFileSync(path.join(outputRoot, first[0]!), "utf8").trim().split("\n").length,
    1,
  );
});

test("finalization rejects noncanonical caller and environment output roots", async () => {
  const root = tempRoot();
  const outputRoot = trustedChildRoot(root, "state");
  fs.mkdirSync(path.join(outputRoot, "child"));
  const noncanonical = `${outputRoot}${path.sep}child${path.sep}..`;
  recordReview(root);

  await assert.rejects(
    flushWorkflowActionEvents(root, {
      env: workflowEnv(),
      outputRoot: noncanonical,
    }),
    /noncanonical action event shard output root/,
  );
  await assert.rejects(
    flushWorkflowActionEvents(root, {
      env: workflowEnv({
        CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: noncanonical,
      }),
    }),
    /noncanonical action event shard output root/,
  );
  assert.deepEqual(fs.readdirSync(outputRoot), ["child"]);
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
    const outputRoot = trustedChildRoot(root, "state");
    const [relativePath] = await flushWorkflowActionEvents(root, {
      env,
      outputRoot,
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

test("workflow partition timestamps require real calendar dates", async () => {
  for (const runStartedAt of [
    "2026-02-29T00:00:00Z",
    "2026-02-30T00:00:00Z",
    "2026-04-31T23:59:59+02:00",
  ]) {
    const root = tempRoot();
    assert.throws(
      () =>
        recordReview(
          root,
          workflowEnv({
            CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: undefined,
            GITHUB_RUN_STARTED_AT: runStartedAt,
          }),
        ),
      /GITHUB_RUN_STARTED_AT must be an ISO date-time timestamp/,
      runStartedAt,
    );
    assert.equal(fs.existsSync(path.join(root, ".clawsweeper-repair")), false);
  }

  const root = tempRoot();
  const outputRoot = trustedChildRoot(root, "state");
  const env = workflowEnv({
    CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: undefined,
    GITHUB_RUN_STARTED_AT: "2024-02-29T23:30:00-02:00",
  });
  recordReview(root, env);
  const [relativePath] = await flushWorkflowActionEvents(root, { env, outputRoot });
  assert.match(relativePath ?? "", /^ledger\/v1\/events\/2024\/03\/01\//);

  for (const runStartedAt of ["0001-01-01T00:00:00Z", "0099-12-31T23:59:59Z"]) {
    const earlyRoot = tempRoot();
    const earlyOutputRoot = trustedChildRoot(earlyRoot, "state");
    const earlyEnv = workflowEnv({
      CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: undefined,
      GITHUB_RUN_STARTED_AT: runStartedAt,
    });
    recordReview(earlyRoot, earlyEnv, new Date("2026-07-12T10:01:00.000Z"), {
      occurredAt: runStartedAt,
    });
    const [earlyPath] = await flushWorkflowActionEvents(earlyRoot, {
      env: earlyEnv,
      outputRoot: earlyOutputRoot,
    });
    assert.match(earlyPath ?? "", new RegExp(`^ledger/v1/events/${runStartedAt.slice(0, 4)}/`));
  }

  for (const runStartedAt of ["0001-01-01T00:00:00+00:01", "9999-12-31T23:59:59-00:01"]) {
    const overflowRoot = tempRoot();
    assert.throws(
      () =>
        recordReview(
          overflowRoot,
          workflowEnv({
            CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: undefined,
            GITHUB_RUN_STARTED_AT: runStartedAt,
          }),
        ),
      /GITHUB_RUN_STARTED_AT UTC partition date must be YYYY-MM-DD/,
      runStartedAt,
    );
    assert.equal(fs.existsSync(path.join(overflowRoot, ".clawsweeper-repair")), false);
  }
});

test("workflow partition-marker reads are bounded on replay and finalization", async () => {
  const root = tempRoot();
  const outputRoot = trustedChildRoot(root, "state");
  const env = workflowEnv();
  recordReview(root, env);
  const markerDirectory = path.join(root, ".clawsweeper-repair", "action-events", "_partitions");
  const [markerName] = fs.readdirSync(markerDirectory);
  assert.ok(markerName);
  const markerPath = path.join(markerDirectory, markerName);
  fs.writeFileSync(markerPath, "2".repeat(65));

  assert.throws(() => recordReview(root, env), /partition marker file exceeds 64 byte limit/);
  await assert.rejects(
    flushWorkflowActionEvents(root, { env, outputRoot }),
    /partition marker file exceeds 64 byte limit/,
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
  const outputRoot = trustedChildRoot(root, "state");
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
  const outputRoot = trustedChildRoot(root, "state");
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

test("producer locks reclaim fresh dead owners and never evict a live holder by age", async () => {
  const deadRoot = tempRoot();
  const deadEvent = recordReviewNumber(deadRoot, 41);
  assert.ok(deadEvent);
  const deadTarget = prepareSafeWriteTarget(
    deadRoot,
    producerLockRelativePath(deadEvent),
    "test producer lock",
  );
  const deadContent = `${actionLedgerJson({
    schema: "clawsweeper.action-ledger-producer-lock",
    schema_version: 1,
    pid: 2_147_483_647,
    process_incarnation_sha256: "0".repeat(64),
    acquired_at_ms: Date.now(),
    nonce: "00000000-0000-4000-8000-000000000000",
  })}\n`;
  const releaseDead = tryAcquireUtf8FileLockNoFollow(deadTarget, deadContent);
  assert.ok(releaseDead);
  const deadStartedAt = Date.now();
  assert.ok(recordReviewNumber(deadRoot, 42));
  assert.ok(Date.now() - deadStartedAt < 1_000);
  assert.doesNotThrow(releaseDead);

  const reusedRoot = tempRoot();
  const reusedEvent = recordReviewNumber(reusedRoot, 45);
  assert.ok(reusedEvent);
  const reusedTarget = prepareSafeWriteTarget(
    reusedRoot,
    producerLockRelativePath(reusedEvent),
    "test reused producer lock",
  );
  const currentIncarnation = processIncarnationIdentitySha256();
  assert.ok(currentIncarnation);
  const reusedContent = `${actionLedgerJson({
    schema: "clawsweeper.action-ledger-producer-lock",
    schema_version: 1,
    pid: process.pid,
    process_incarnation_sha256:
      currentIncarnation === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64),
    acquired_at_ms: Date.now(),
    nonce: "00000000-0000-4000-8000-000000000002",
  })}\n`;
  const releaseReused = tryAcquireUtf8FileLockNoFollow(reusedTarget, reusedContent);
  assert.ok(releaseReused);
  const reusedStartedAt = Date.now();
  assert.ok(recordReviewNumber(reusedRoot, 46));
  assert.ok(Date.now() - reusedStartedAt < 1_000);
  assert.doesNotThrow(releaseReused);

  const liveRoot = tempRoot();
  const outputRoot = trustedChildRoot(liveRoot, "state");
  const liveEvent = recordReviewNumber(liveRoot, 51);
  assert.ok(liveEvent);
  const readyPath = path.join(liveRoot, "holder-ready");
  const filesModuleUrl = pathToFileURL(
    path.join(process.cwd(), "dist", "action-ledger-files.js"),
  ).href;
  const ledgerModuleUrl = pathToFileURL(path.join(process.cwd(), "dist", "action-ledger.js")).href;
  const holderScript = `
import fs from "node:fs";
const {
  prepareSafeWriteTarget,
  processIncarnationIdentitySha256,
  tryAcquireUtf8FileLockNoFollow
} = await import(${JSON.stringify(filesModuleUrl)});
const { actionLedgerJson } = await import(${JSON.stringify(ledgerModuleUrl)});
const target = prepareSafeWriteTarget(process.argv[1], process.argv[2], "live producer lock");
const processIncarnation = processIncarnationIdentitySha256();
if (!processIncarnation) process.exit(2);
const content = actionLedgerJson({
  schema: "clawsweeper.action-ledger-producer-lock",
  schema_version: 1,
  pid: process.pid,
  process_incarnation_sha256: processIncarnation,
  acquired_at_ms: Date.now() - 5 * 60_000 + 75,
  nonce: "00000000-0000-4000-8000-000000000001"
}) + "\\n";
const release = tryAcquireUtf8FileLockNoFollow(target, content);
if (!release) process.exit(3);
fs.writeFileSync(process.argv[3], "ready\\n");
await new Promise((resolve) => setTimeout(resolve, 150));
if (!fs.existsSync(target.path) || fs.readFileSync(target.path, "utf8") !== content) process.exit(4);
release();
`;
  const holder = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      holderScript,
      liveRoot,
      producerLockRelativePath(liveEvent),
      readyPath,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const holderDone = childResult(holder);
  await waitForPath(readyPath);

  const startedAt = Date.now();
  assert.ok(recordReviewNumber(liveRoot, 52));
  assert.ok(Date.now() - startedAt >= 100);
  const result = await holderDone;
  assert.equal(result.code, 0, result.stderr || result.stdout);

  const paths = await flushWorkflowActionEvents(liveRoot, {
    env: workflowEnv(),
    outputRoot,
  });
  assert.equal(readOutputEvents(outputRoot, paths).length, 2);
  assert.throws(() => recordReviewNumber(liveRoot, 53), /producer is already finalized/);
  assert.equal(readOutputEvents(outputRoot, paths).length, 2);
});

test(
  "macOS process identities distinguish processes started within the same second",
  { skip: process.platform === "darwin" ? false : "requires macOS proc_pidinfo" },
  () => {
    const filesModuleUrl = pathToFileURL(
      path.join(process.cwd(), "dist", "action-ledger-files.js"),
    ).href;
    const script = `
const { processIncarnationIdentitySha256 } = await import(${JSON.stringify(filesModuleUrl)});
process.stdout.write(JSON.stringify({
  identity: processIncarnationIdentitySha256(),
  second: new Date().toISOString().slice(0, 19)
}));
`;
    const samples: Array<{ identity: string; second: string }> = [];
    for (let index = 0; index < 12; index += 1) {
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      const sample = JSON.parse(result.stdout) as { identity: string | null; second: string };
      assert.ok(sample.identity);
      samples.push({ identity: sample.identity, second: sample.second });
    }
    const bySecond = new Map<string, Array<{ identity: string; second: string }>>();
    for (const sample of samples) {
      const group = bySecond.get(sample.second) ?? [];
      group.push(sample);
      bySecond.set(sample.second, group);
    }
    const sameSecond = [...bySecond.values()].sort((left, right) => right.length - left.length)[0]!;
    assert.ok(sameSecond.length >= 2);
    assert.equal(new Set(sameSecond.map((sample) => sample.identity)).size, sameSecond.length);
  },
);

test(
  "Linux stale-lock checks bypass cached identities after PID reuse",
  { skip: process.platform === "linux" ? false : "requires Linux procfs" },
  () => {
    const root = tempRoot();
    const first = recordReviewNumber(root, 81);
    assert.ok(first);
    const target = prepareSafeWriteTarget(
      root,
      producerLockRelativePath(first),
      "cached identity producer lock",
    );
    const cachedIdentity = processIncarnationIdentitySha256();
    assert.ok(cachedIdentity);
    const content = `${actionLedgerJson({
      schema: "clawsweeper.action-ledger-producer-lock",
      schema_version: 1,
      pid: process.pid,
      process_incarnation_sha256: cachedIdentity,
      acquired_at_ms: Date.now(),
      nonce: "00000000-0000-4000-8000-000000000003",
    })}\n`;
    const releaseCached = tryAcquireUtf8FileLockNoFollow(target, content);
    assert.ok(releaseCached);

    const statPath = `/proc/${process.pid}/stat`;
    const originalStat = fs.readFileSync(statPath, "utf8");
    const commandEnd = originalStat.lastIndexOf(")");
    assert.ok(commandEnd >= 0);
    const fields = originalStat
      .slice(commandEnd + 1)
      .trim()
      .split(/\s+/);
    fields[19] = String(BigInt(fields[19]!) + 1n);
    const recycledStat = `${originalStat.slice(0, commandEnd + 1)} ${fields.join(" ")}\n`;
    const originalReadFileSync = fs.readFileSync;
    fs.readFileSync = ((filePath, options) => {
      if (filePath === statPath && options === "utf8") return recycledStat;
      return originalReadFileSync(filePath, options as never);
    }) as typeof fs.readFileSync;
    try {
      const startedAt = Date.now();
      assert.ok(recordReviewNumber(root, 82));
      assert.ok(Date.now() - startedAt < 1_000);
    } finally {
      fs.readFileSync = originalReadFileSync;
      processIncarnationIdentitySha256(process.pid, { fresh: true });
    }
    assert.doesNotThrow(releaseCached);
  },
);

test("Linux zombie-lock polling rejects PID 0 before probing procfs", async () => {
  await assert.rejects(waitForLinuxProcessState(0, "Z"), /invalid Linux process PID: 0/);
});

test(
  "Linux producer locks reclaim zombie owners",
  { skip: process.platform === "linux" ? false : "requires Linux procfs zombie state" },
  async (t) => {
    const python = spawnSync("python3", ["--version"], { encoding: "utf8" });
    if (python.error || python.status !== 0) {
      t.skip("python3 is required to hold a zombie child for this test");
      return;
    }
    const root = tempRoot();
    const first = recordReviewNumber(root, 91);
    assert.ok(first);
    const pidPath = path.join(root, "zombie-pid");
    const keeper = spawn(
      "python3",
      [
        "-c",
        [
          "import os, sys, time",
          "pid = os.fork()",
          "if pid == 0: os._exit(0)",
          "open(sys.argv[1], 'w', encoding='utf-8').write(str(pid))",
          "time.sleep(10)",
        ].join("\n"),
        pidPath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const keeperDone = childResult(keeper);
    try {
      const zombiePid = await waitForPositivePidFile(pidPath);
      if (!(await waitForLinuxProcessState(zombiePid, "Z"))) {
        t.skip("zombie child disappeared before its state could be observed");
        return;
      }

      const target = prepareSafeWriteTarget(
        root,
        producerLockRelativePath(first),
        "zombie producer lock",
      );
      const content = `${actionLedgerJson({
        schema: "clawsweeper.action-ledger-producer-lock",
        schema_version: 1,
        pid: zombiePid,
        process_incarnation_sha256: "0".repeat(64),
        acquired_at_ms: Date.now(),
        nonce: "00000000-0000-4000-8000-000000000004",
      })}\n`;
      const releaseZombie = tryAcquireUtf8FileLockNoFollow(target, content);
      assert.ok(releaseZombie);
      const startedAt = Date.now();
      assert.ok(recordReviewNumber(root, 92));
      assert.ok(Date.now() - startedAt < 1_000);
      assert.doesNotThrow(releaseZombie);
    } finally {
      keeper.kill("SIGTERM");
      await keeperDone;
    }
  },
);

test("projection admission is registered before producer lock release", async () => {
  const root = tempRoot();
  const outputRoot = trustedChildRoot(root, "state");
  const env = workflowEnv({
    CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "agent-token",
    CLAWSWEEPER_CRABFLEET_SESSION_ID: "session-1",
  });
  const originalRenameSync = fs.renameSync;
  const originalError = console.error;
  let flush: Promise<string[]> | undefined;
  let flushStarted = false;
  fs.renameSync = ((oldPath, newPath) => {
    const result = originalRenameSync(oldPath, newPath);
    if (
      !flushStarted &&
      String(oldPath).includes(
        `${path.sep}.clawsweeper-repair${path.sep}action-events${path.sep}_locks${path.sep}`,
      ) &&
      String(oldPath).endsWith(".lock")
    ) {
      flushStarted = true;
      flush = flushWorkflowActionEvents(root, { env, outputRoot });
    }
    return result;
  }) as typeof fs.renameSync;
  console.error = () => undefined;
  try {
    assert.ok(recordReviewNumber(root, 101, env, async () => new Response(null, { status: 503 })));
  } finally {
    fs.renameSync = originalRenameSync;
  }
  try {
    assert.ok(flush);
    const paths = await flush;
    assert.deepEqual(
      readOutputEvents(outputRoot, paths)
        .map((event) => event.event_type)
        .sort(),
      [ACTION_EVENT_TYPES.projectionFailed, ACTION_EVENT_TYPES.reviewCompleted].sort(),
    );
  } finally {
    console.error = originalError;
  }
});

test("finalization publishes local shards before a bounded projection drain and rejects late events", async () => {
  const root = tempRoot();
  const outputRoot = trustedChildRoot(root, "state");
  const env = workflowEnv({
    CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "agent-token",
    CLAWSWEEPER_CRABFLEET_SESSION_ID: "session-1",
    CLAWSWEEPER_CRABFLEET_TIMEOUT_MS: "60000",
  });
  let aborted = false;
  const originalError = console.error;
  console.error = () => undefined;
  try {
    const event = recordReview(root, env, new Date("2026-07-12T10:01:00.000Z"), {
      fetchImpl: ((_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        })) as typeof fetch,
    });
    assert.ok(event);
    const primaryPath = actionEventShardRelativePath(shardIdentity(event), [event], 1, 1);
    const flush = flushWorkflowActionEvents(root, {
      env,
      outputRoot,
      projectionFlushTimeoutMs: 20,
    });

    assert.equal(fs.existsSync(path.join(outputRoot, primaryPath)), true);
    assert.equal(readOutputEvents(outputRoot, [primaryPath])[0]?.event_id, event.event_id);
    assert.throws(
      () =>
        recordWorkflowActionEvent(
          root,
          {
            scope: "review.completed",
            identity: { number: 43 },
            type: ACTION_EVENT_TYPES.reviewCompleted,
            component: "review",
            subject: {
              repository: "openclaw/openclaw",
              kind: "pull_request",
              number: 43,
            },
            action: {
              name: "review",
              status: "completed",
              retryable: false,
              mutation: false,
            },
          },
          { env },
        ),
      /producer is already finalized; use a new CLAWSWEEPER_ACTION_LEDGER_INVOCATION/,
    );

    const paths = await flush;
    assert.equal(aborted, true);
    assert.deepEqual(
      readOutputEvents(outputRoot, paths)
        .map((entry) => entry.event_type)
        .sort(),
      [ACTION_EVENT_TYPES.projectionFailed, ACTION_EVENT_TYPES.reviewCompleted].sort(),
    );

    const replay = recordReview(root, workflowEnv(), new Date("2026-07-12T10:01:00.000Z"));
    assert.equal(replay?.event_id, event.event_id);
    assert.ok(
      recordReview(
        root,
        workflowEnv({ CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "review-1" }),
        new Date("2026-07-12T10:01:00.000Z"),
      ),
    );
  } finally {
    console.error = originalError;
  }
});

test("different workflow steps receive independent shard identities", async () => {
  const root = tempRoot();
  const outputRoot = trustedChildRoot(root, "state");
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
  const outputRoot = trustedChildRoot(root, "state");
  const destination = trustedChildRoot(root, "destination");
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

  const imported = importActionEventShards(outputRoot, destination);
  assert.equal(imported.created, 2);
  assert.deepEqual(imported.eventPaths, paths);
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
    "https://crabfleet.openclaw.ai/api/agent/interactive-sessions/session-1/events",
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

test("CrabFleet projection preserves a custom base bound to session provenance", async () => {
  const customBase = "https://fleet.example.test/staging";
  const event = recordReview(tempRoot());
  assert.ok(event);
  let requestUrl = "";
  await postActionEventToCrabFleet(
    event,
    workflowEnv({
      CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "agent-token",
      CLAWSWEEPER_CRABFLEET_SESSION_ID: "session-1",
      CLAWSWEEPER_CRABFLEET_URL: customBase,
      CLAWSWEEPER_CRABFLEET_WORK_STATE_URL: `${customBase}/api/agent/interactive-sessions/session-1/work-state`,
    }),
    (async (url: string | URL | Request) => {
      requestUrl = String(url);
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  );
  assert.equal(requestUrl, `${customBase}/api/agent/interactive-sessions/session-1/events`);
});

test("CrabFleet projection rejects unsafe URLs and registration-origin drift", async () => {
  const event = recordReview(tempRoot());
  assert.ok(event);
  let requests = 0;
  for (const configuredUrl of [
    "http://crabfleet.openclaw.ai",
    "https://user:password@crabfleet.openclaw.ai",
    "https://crabfleet.openclaw.ai.evil.example",
    "https://crabfleet.openclaw.ai/api",
    "https://crabfleet.openclaw.ai?redirect=https://evil.example",
  ]) {
    await assert.rejects(
      postActionEventToCrabFleet(
        event,
        workflowEnv({
          CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "agent-token",
          CLAWSWEEPER_CRABFLEET_SESSION_ID: "session-1",
          CLAWSWEEPER_CRABFLEET_URL: configuredUrl,
        }),
        (async () => {
          requests += 1;
          return new Response(null, { status: 204 });
        }) as typeof fetch,
      ),
      /credential-free HTTPS URL|registered session provenance/,
      configuredUrl,
    );
  }
  assert.equal(requests, 0);
});

test("CrabFleet projection bounds active fetches and queued work", async () => {
  const root = tempRoot();
  const outputRoot = trustedChildRoot(root, "state");
  const env = workflowEnv({
    CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "agent-token",
    CLAWSWEEPER_CRABFLEET_SESSION_ID: "session-1",
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let active = 0;
  let maxActive = 0;
  let started = 0;
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  try {
    const total =
      CRABFLEET_PROJECTION_LIMITS.maxConcurrent + CRABFLEET_PROJECTION_LIMITS.maxQueued + 1;
    for (let index = 0; index < total; index += 1) {
      const event = recordReview(root, env, new Date("2026-07-12T10:01:00.000Z"), {
        fetchImpl: (async () => {
          started += 1;
          active += 1;
          maxActive = Math.max(maxActive, active);
          await gate;
          active -= 1;
          return new Response(null, { status: 204 });
        }) as typeof fetch,
      });
      assert.ok(event);
    }

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started, CRABFLEET_PROJECTION_LIMITS.maxConcurrent);
    assert.equal(maxActive, CRABFLEET_PROJECTION_LIMITS.maxConcurrent);
    assert.equal(errors.length, 1);
    assert.match(
      errors[0] ?? "",
      new RegExp(`queue limit ${CRABFLEET_PROJECTION_LIMITS.maxQueued} reached`),
    );

    release();
    await flushPendingCrabFleetPosts();
    assert.equal(
      started,
      CRABFLEET_PROJECTION_LIMITS.maxConcurrent + CRABFLEET_PROJECTION_LIMITS.maxQueued,
    );
    assert.equal(maxActive, CRABFLEET_PROJECTION_LIMITS.maxConcurrent);
  } finally {
    release();
    await flushPendingCrabFleetPosts();
    console.error = originalError;
  }

  const paths = await flushWorkflowActionEvents(root, { env, outputRoot });
  const events = readOutputEvents(outputRoot, paths);
  assert.deepEqual(
    events.map((event) => event.event_type).sort(),
    [ACTION_EVENT_TYPES.reviewCompleted, ACTION_EVENT_TYPES.projectionFailed].sort(),
  );
});

test("CrabFleet projection admission is fair across spool roots", async () => {
  const saturatedRoot = tempRoot();
  const independentRoot = tempRoot();
  const env = workflowEnv({
    CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "agent-token",
    CLAWSWEEPER_CRABFLEET_SESSION_ID: "session-1",
    CLAWSWEEPER_CRABFLEET_TIMEOUT_MS: "60000",
  });
  const firstWaveResolvers: Array<(response: Response) => void> = [];
  const startOrder: string[] = [];
  let saturatedStarted = 0;
  const saturatedFetch = (() => {
    saturatedStarted += 1;
    startOrder.push("saturated");
    if (saturatedStarted <= CRABFLEET_PROJECTION_LIMITS.maxConcurrent) {
      return new Promise<Response>((resolve) => firstWaveResolvers.push(resolve));
    }
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;
  const saturatedTotal =
    CRABFLEET_PROJECTION_LIMITS.maxConcurrent + CRABFLEET_PROJECTION_LIMITS.maxQueued;
  for (let index = 0; index < saturatedTotal; index += 1) {
    assert.ok(recordReviewNumber(saturatedRoot, 100 + index, env, saturatedFetch));
  }
  assert.ok(
    recordReviewNumber(independentRoot, 999, env, (async () => {
      startOrder.push("independent");
      return new Response(null, { status: 204 });
    }) as typeof fetch),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(startOrder, Array(CRABFLEET_PROJECTION_LIMITS.maxConcurrent).fill("saturated"));

  firstWaveResolvers.shift()!(new Response(null, { status: 204 }));
  const fairnessDeadline = Date.now() + 500;
  while (!startOrder.includes("independent")) {
    if (Date.now() >= fairnessDeadline) {
      throw new Error("independent root did not receive the next projection slot");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(startOrder.slice(0, 5), [
    "saturated",
    "saturated",
    "saturated",
    "saturated",
    "independent",
  ]);

  for (const resolve of firstWaveResolvers) resolve(new Response(null, { status: 204 }));
  await flushPendingCrabFleetPosts();
  assert.equal(startOrder.filter((entry) => entry === "saturated").length, saturatedTotal);
});

test("exported CrabFleet posts share the four-request admission bound", async () => {
  const event = recordReview(tempRoot());
  assert.ok(event);
  const env = workflowEnv({
    CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "agent-token",
    CLAWSWEEPER_CRABFLEET_SESSION_ID: "session-1",
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let active = 0;
  let maxActive = 0;
  let started = 0;
  const posts = Array.from({ length: CRABFLEET_PROJECTION_LIMITS.maxConcurrent * 2 }, () =>
    postActionEventToCrabFleet(event, env, (async () => {
      started += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate;
      active -= 1;
      return new Response(null, { status: 204 });
    }) as typeof fetch),
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, CRABFLEET_PROJECTION_LIMITS.maxConcurrent);
  assert.equal(maxActive, CRABFLEET_PROJECTION_LIMITS.maxConcurrent);
  release();
  await Promise.all(posts);
  assert.equal(started, CRABFLEET_PROJECTION_LIMITS.maxConcurrent * 2);
  assert.equal(maxActive, CRABFLEET_PROJECTION_LIMITS.maxConcurrent);
});

test("queued direct CrabFleet posts validate before admission and reject without hanging", async () => {
  const event = recordReview(tempRoot());
  assert.ok(event);
  const env = workflowEnv({
    CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "agent-token",
    CLAWSWEEPER_CRABFLEET_SESSION_ID: "session-1",
    CLAWSWEEPER_CRABFLEET_TIMEOUT_MS: "1000",
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const active = Array.from({ length: CRABFLEET_PROJECTION_LIMITS.maxConcurrent }, () =>
    postActionEventToCrabFleet(event, env, (async () => {
      await gate;
      return new Response(null, { status: 204 });
    }) as typeof fetch),
  );
  await new Promise((resolve) => setImmediate(resolve));

  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  try {
    await Promise.race([
      assert.rejects(
        postActionEventToCrabFleet({ ...event, event_id: "invalid" }, env),
        /invalid action event identity|invalid action event schema/,
      ),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("invalid queued post hung")), 200),
      ),
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    release();
    await Promise.all(active);
    process.off("unhandledRejection", onUnhandled);
  }
});

test("CrabFleet queued projections snapshot endpoint and credentials", async () => {
  const root = tempRoot();
  const customBase = "https://fleet.example.test/staging";
  const env = workflowEnv({
    CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "original-token",
    CLAWSWEEPER_CRABFLEET_SESSION_ID: "original-session",
    CLAWSWEEPER_CRABFLEET_TIMEOUT_MS: "1000",
    CLAWSWEEPER_CRABFLEET_URL: customBase,
    CLAWSWEEPER_CRABFLEET_WORK_STATE_URL: `${customBase}/api/agent/interactive-sessions/original-session/work-state`,
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  for (let index = 0; index < CRABFLEET_PROJECTION_LIMITS.maxConcurrent; index += 1) {
    assert.ok(
      recordReview(root, env, new Date("2026-07-12T10:01:00.000Z"), {
        fetchImpl: (async () => {
          await gate;
          return new Response(null, { status: 204 });
        }) as typeof fetch,
      }),
    );
  }

  let queuedRequest: { url: string; authorization: string } | undefined;
  assert.ok(
    recordReview(root, env, new Date("2026-07-12T10:01:00.000Z"), {
      fetchImpl: (async (url, init) => {
        if (!init) throw new Error("missing CrabFleet request init");
        queuedRequest = {
          url: String(url),
          authorization: String((init.headers as Record<string, string>).authorization),
        };
        await new Promise((resolve) => setTimeout(resolve, 10));
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    }),
  );
  env.CLAWSWEEPER_CRABFLEET_AGENT_TOKEN = "changed-token";
  env.CLAWSWEEPER_CRABFLEET_SESSION_ID = "changed-session";
  env.CLAWSWEEPER_CRABFLEET_URL = "https://evil.example";
  env.CLAWSWEEPER_CRABFLEET_TIMEOUT_MS = "1";

  release();
  await flushPendingCrabFleetPosts();
  assert.deepEqual(queuedRequest, {
    url: `${customBase}/api/agent/interactive-sessions/original-session/events`,
    authorization: "Bearer original-token",
  });
});

test("workflow projection drains are scoped to one spool root", async () => {
  const blockedRoot = tempRoot();
  const blockedOutput = trustedChildRoot(blockedRoot, "state");
  const readyRoot = tempRoot();
  const readyOutput = trustedChildRoot(readyRoot, "state");
  const blockedEnv = workflowEnv({
    CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "agent-token",
    CLAWSWEEPER_CRABFLEET_SESSION_ID: "session-1",
    CLAWSWEEPER_CRABFLEET_TIMEOUT_MS: "60000",
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  assert.ok(
    recordReviewNumber(blockedRoot, 71, blockedEnv, (async () => {
      await gate;
      return new Response(null, { status: 204 });
    }) as typeof fetch),
  );
  assert.ok(recordReviewNumber(readyRoot, 72, workflowEnv()));

  let timeout: NodeJS.Timeout | undefined;
  try {
    const readyPaths = await Promise.race([
      flushWorkflowActionEvents(readyRoot, {
        env: workflowEnv(),
        outputRoot: readyOutput,
      }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("independent root drain was blocked")), 250);
      }),
    ]);
    assert.equal(readOutputEvents(readyOutput, readyPaths).length, 1);
  } finally {
    if (timeout) clearTimeout(timeout);
    release();
  }
  const blockedPaths = await flushWorkflowActionEvents(blockedRoot, {
    env: blockedEnv,
    outputRoot: blockedOutput,
  });
  assert.equal(readOutputEvents(blockedOutput, blockedPaths).length, 1);
});

test("CrabFleet timeouts keep unresolved fetches inside the concurrency bound", async () => {
  const root = tempRoot();
  const env = workflowEnv({
    CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "agent-token",
    CLAWSWEEPER_CRABFLEET_SESSION_ID: "session-1",
    CLAWSWEEPER_CRABFLEET_TIMEOUT_MS: "10",
  });
  const resolvers: Array<(response: Response) => void> = [];
  let started = 0;
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  try {
    for (let index = 0; index < CRABFLEET_PROJECTION_LIMITS.maxConcurrent; index += 1) {
      const event = recordReview(root, env, new Date("2026-07-12T10:01:00.000Z"), {
        fetchImpl: (() => {
          started += 1;
          return new Promise<Response>((resolve) => resolvers.push(resolve));
        }) as typeof fetch,
      });
      assert.ok(event);
    }
    await flushPendingCrabFleetPosts();
    assert.equal(started, CRABFLEET_PROJECTION_LIMITS.maxConcurrent);

    for (let index = 0; index < CRABFLEET_PROJECTION_LIMITS.maxConcurrent; index += 1) {
      const event = recordReview(root, env, new Date("2026-07-12T10:01:00.000Z"), {
        fetchImpl: (() => {
          started += 1;
          return new Promise<Response>(() => undefined);
        }) as typeof fetch,
      });
      assert.ok(event);
    }
    await flushPendingCrabFleetPosts();
    assert.equal(started, CRABFLEET_PROJECTION_LIMITS.maxConcurrent);
    assert.equal(
      errors.filter((entry) => entry.includes("unresolved CrabFleet requests")).length,
      CRABFLEET_PROJECTION_LIMITS.maxConcurrent,
    );
  } finally {
    for (const resolve of resolvers) resolve(new Response(null, { status: 204 }));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await flushPendingCrabFleetPosts();
    console.error = originalError;
  }

  let recoveryStarted = 0;
  const recovered = recordReview(root, env, new Date("2026-07-12T10:01:00.000Z"), {
    fetchImpl: (async () => {
      recoveryStarted += 1;
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });
  assert.ok(recovered);
  await flushPendingCrabFleetPosts();
  assert.equal(recoveryStarted, 1);
});

test("queued direct CrabFleet posts terminate when every active cleanup is stuck", async () => {
  const event = recordReview(tempRoot());
  assert.ok(event);
  const env = workflowEnv({
    CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "agent-token",
    CLAWSWEEPER_CRABFLEET_SESSION_ID: "session-1",
    CLAWSWEEPER_CRABFLEET_TIMEOUT_MS: "10",
  });
  const cleanupResolvers: Array<() => void> = [];
  const fetchImpl = (async () =>
    ({
      ok: true,
      status: 204,
      body: {
        cancel: () =>
          new Promise<void>((resolve) => {
            cleanupResolvers.push(resolve);
          }),
      },
    }) as unknown as Response) as typeof fetch;
  const posts = Array.from({ length: CRABFLEET_PROJECTION_LIMITS.maxConcurrent + 1 }, () =>
    postActionEventToCrabFleet(event, env, fetchImpl),
  );
  const settled = await Promise.race([
    Promise.allSettled(posts),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("queued direct posts did not terminate")), 500),
    ),
  ]);
  assert.equal(
    settled.every((result) => result.status === "rejected"),
    true,
  );
  assert.match(
    String((settled.at(-1) as PromiseRejectedResult).reason),
    /blocked by .* unresolved CrabFleet requests|queue timed out/,
  );
  assert.equal(cleanupResolvers.length, CRABFLEET_PROJECTION_LIMITS.maxConcurrent);
  for (const resolve of cleanupResolvers) resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
});

test("cleanup-stuck projection rejection is scoped to the affected spool root", async () => {
  const blockedRoot = tempRoot();
  const independentRoot = tempRoot();
  const blockedEnv = workflowEnv({
    CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "agent-token",
    CLAWSWEEPER_CRABFLEET_SESSION_ID: "session-1",
    CLAWSWEEPER_CRABFLEET_TIMEOUT_MS: "10",
  });
  const independentEnv = workflowEnv({
    CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "agent-token",
    CLAWSWEEPER_CRABFLEET_SESSION_ID: "session-1",
    CLAWSWEEPER_CRABFLEET_TIMEOUT_MS: "1000",
  });
  const cleanupResolvers: Array<() => void> = [];
  const blockedFetch = (async () =>
    ({
      ok: true,
      status: 204,
      body: {
        cancel: () =>
          new Promise<void>((resolve) => {
            cleanupResolvers.push(resolve);
          }),
      },
    }) as unknown as Response) as typeof fetch;
  for (let index = 0; index < CRABFLEET_PROJECTION_LIMITS.maxConcurrent + 1; index += 1) {
    assert.ok(recordReviewNumber(blockedRoot, 300 + index, blockedEnv, blockedFetch));
  }
  let independentStarted = 0;
  assert.ok(
    recordReviewNumber(independentRoot, 400, independentEnv, (async () => {
      independentStarted += 1;
      return new Response(null, { status: 204 });
    }) as typeof fetch),
  );

  const blockedDeadline = Date.now() + 500;
  while (cleanupResolvers.length < CRABFLEET_PROJECTION_LIMITS.maxConcurrent) {
    if (Date.now() >= blockedDeadline) {
      throw new Error("blocked root did not enter response cleanup");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(independentStarted, 0);

  cleanupResolvers.shift()!();
  const independentDeadline = Date.now() + 500;
  while (independentStarted === 0) {
    if (Date.now() >= independentDeadline) {
      throw new Error("independent root did not start after a projection slot recovered");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  for (const resolve of cleanupResolvers) resolve();
  await flushPendingCrabFleetPosts();
  assert.equal(independentStarted, 1);
});

test("CrabFleet timeouts hold slots until response cleanup settles", async () => {
  const root = tempRoot();
  const env = workflowEnv({
    CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "agent-token",
    CLAWSWEEPER_CRABFLEET_SESSION_ID: "session-1",
    CLAWSWEEPER_CRABFLEET_TIMEOUT_MS: "10",
  });
  const cleanupResolvers: Array<() => void> = [];
  let started = 0;
  let secondWaveStarted = 0;
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  try {
    for (let index = 0; index < CRABFLEET_PROJECTION_LIMITS.maxConcurrent; index += 1) {
      assert.ok(
        recordReview(root, env, new Date("2026-07-12T10:01:00.000Z"), {
          fetchImpl: (async () => {
            started += 1;
            return {
              ok: true,
              status: 204,
              body: {
                cancel: () =>
                  new Promise<void>((resolve) => {
                    cleanupResolvers.push(resolve);
                  }),
              },
            } as unknown as Response;
          }) as typeof fetch,
        }),
      );
    }
    await flushPendingCrabFleetPosts();
    assert.equal(started, CRABFLEET_PROJECTION_LIMITS.maxConcurrent);
    assert.equal(cleanupResolvers.length, CRABFLEET_PROJECTION_LIMITS.maxConcurrent);

    for (let index = 0; index < CRABFLEET_PROJECTION_LIMITS.maxConcurrent; index += 1) {
      assert.ok(
        recordReview(root, env, new Date("2026-07-12T10:01:00.000Z"), {
          fetchImpl: (async () => {
            secondWaveStarted += 1;
            return new Response(null, { status: 204 });
          }) as typeof fetch,
        }),
      );
    }
    await flushPendingCrabFleetPosts();
    assert.equal(secondWaveStarted, 0);
    assert.equal(
      errors.filter((entry) => entry.includes("unresolved CrabFleet requests")).length,
      CRABFLEET_PROJECTION_LIMITS.maxConcurrent,
    );
  } finally {
    for (const resolve of cleanupResolvers) resolve();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await flushPendingCrabFleetPosts();
    console.error = originalError;
  }

  let recoveryStarted = 0;
  assert.ok(
    recordReview(root, env, new Date("2026-07-12T10:01:00.000Z"), {
      fetchImpl: (async () => {
        recoveryStarted += 1;
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    }),
  );
  await flushPendingCrabFleetPosts();
  assert.equal(recoveryStarted, 1);
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

test("CrabFleet rejects forged event bodies before projection", async () => {
  const event = recordReview(tempRoot());
  assert.ok(event);
  const forgedEvents = [
    {
      ...structuredClone(event),
      action: {
        ...event.action,
        status: "published",
      },
    },
    {
      ...structuredClone(event),
      prompt: "unhashed private text",
    },
  ];
  let requests = 0;

  for (const forged of forgedEvents) {
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
      /invalid action event semantic digest|unknown or non-canonical fields/,
    );
  }
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

test("malformed CrabFleet projection configuration is non-fatal and durably redacted", async () => {
  const cases = [
    {
      name: "url",
      overrides: {
        CLAWSWEEPER_CRABFLEET_URL: "https://user:private-value@fleet.example.test",
      },
    },
    {
      name: "timeout",
      overrides: {
        CLAWSWEEPER_CRABFLEET_TIMEOUT_MS: "999999",
      },
    },
  ];
  for (const testCase of cases) {
    const root = tempRoot();
    const outputRoot = trustedChildRoot(root, "state");
    const env = workflowEnv({
      CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "agent-private-value",
      CLAWSWEEPER_CRABFLEET_SESSION_ID: `session-${testCase.name}`,
      ...testCase.overrides,
    });
    let requests = 0;
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
    try {
      const event = recordReview(root, env, new Date("2026-07-12T10:01:00.000Z"), {
        fetchImpl: (async () => {
          requests += 1;
          return new Response(null, { status: 204 });
        }) as typeof fetch,
      });
      assert.ok(event, testCase.name);
      const paths = await flushWorkflowActionEvents(root, { env, outputRoot });
      const events = readOutputEvents(outputRoot, paths);
      assert.deepEqual(
        events.map((entry) => entry.event_type).sort(),
        [ACTION_EVENT_TYPES.reviewCompleted, ACTION_EVENT_TYPES.projectionFailed].sort(),
        testCase.name,
      );
    } finally {
      console.error = originalError;
    }
    assert.equal(requests, 0, testCase.name);
    assert.equal(errors.length, 1, testCase.name);
    assert.match(errors[0] ?? "", /invalid CrabFleet projection configuration/, testCase.name);
    assert.doesNotMatch(
      errors.join("\n"),
      /private-value|999999|fleet\.example\.test/,
      testCase.name,
    );
  }
});

test("projection-failure producers seal only after their root-specific drain completes", async () => {
  const root = tempRoot();
  const outputRoot = trustedChildRoot(root, "state");
  const invalidEnv = workflowEnv({
    CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "agent-token",
    CLAWSWEEPER_CRABFLEET_SESSION_ID: "session-1",
    CLAWSWEEPER_CRABFLEET_URL: "https://evil.example",
  });
  const validEnv = workflowEnv({
    CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "agent-token",
    CLAWSWEEPER_CRABFLEET_SESSION_ID: "session-1",
  });
  const originalError = console.error;
  console.error = () => undefined;
  try {
    assert.ok(recordReviewNumber(root, 61, invalidEnv));
    assert.ok(
      recordReviewNumber(root, 62, validEnv, async () => new Response(null, { status: 503 })),
    );
    const paths = await flushWorkflowActionEvents(root, { env: validEnv, outputRoot });
    const events = readOutputEvents(outputRoot, paths);
    assert.equal(
      events.filter((event) => event.event_type === ACTION_EVENT_TYPES.reviewCompleted).length,
      2,
    );
    assert.equal(
      events.filter((event) => event.event_type === ACTION_EVENT_TYPES.projectionFailed).length,
      2,
    );
    assert.deepEqual(await flushWorkflowActionEvents(root, { env: validEnv, outputRoot }), paths);
  } finally {
    console.error = originalError;
  }
});

test("CrabFleet projection failures remain durable and retryable", async () => {
  const root = tempRoot();
  const outputRoot = trustedChildRoot(root, "state");
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

  const paths = await flushWorkflowActionEvents(root, { env, outputRoot });
  const events = readOutputEvents(outputRoot, paths);
  assert.deepEqual(
    events.map((entry) => entry.event_type).sort(),
    [ACTION_EVENT_TYPES.reviewCompleted, ACTION_EVENT_TYPES.projectionFailed].sort(),
  );
  const source = events.find((entry) => entry.event_type === ACTION_EVENT_TYPES.reviewCompleted);
  const failure = events.find((entry) => entry.event_type === ACTION_EVENT_TYPES.projectionFailed);
  assert.ok(source);
  assert.ok(failure);
  assert.equal(source.occurred_at, "2026-07-12T12:00:00.000Z");
  assert.equal(source.occurred_at_source, "source");
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
    let firstPaths: string[] | undefined;
    let firstContents: string[] | undefined;
    for (const [index, root] of roots.entries()) {
      const event = recordReview(root, env, timestamps[index], {
        generatedOccurrence: true,
        fetchImpl: async () => new Response(null, { status: 503 }),
      });
      assert.ok(event);
      const paths = await flushWorkflowActionEvents(root, { env, outputRoot });
      const contents = paths.map((relativePath) =>
        fs.readFileSync(path.join(outputRoot, relativePath), "utf8"),
      );
      if (index === 0) {
        firstPaths = paths;
        firstContents = contents;
      } else {
        assert.deepEqual(paths, firstPaths);
        assert.deepEqual(contents, firstContents);
      }
    }
  } finally {
    console.error = originalError;
  }

  const paths = await flushWorkflowActionEvents(roots[0]!, { env, outputRoot });
  const events = readOutputEvents(outputRoot, paths);
  assert.deepEqual(events.map((event) => event.occurred_at_source).sort(), [
    "generated",
    "generated",
  ]);
});

test("CrabFleet timeouts preserve canonical events and record projection failure", async () => {
  const root = tempRoot();
  const outputRoot = trustedChildRoot(root, "state");
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
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("aborted"));
            });
          })) as typeof fetch,
      },
    );
    assert.ok(event);
    const paths = await flushWorkflowActionEvents(root, { env, outputRoot });
    const events = readOutputEvents(outputRoot, paths);
    assert.deepEqual(
      events.map((entry) => entry.event_type).sort(),
      [ACTION_EVENT_TYPES.reviewCompleted, ACTION_EVENT_TYPES.projectionFailed].sort(),
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
  const outputRoot = trustedChildRoot(root, "state");
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
    const paths = await flushWorkflowActionEvents(root, { env, outputRoot });
    const phaseSequences = readOutputEvents(outputRoot, paths).map((event) => event.phase_seq);
    assert.deepEqual(phaseSequences, [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]);
  } finally {
    console.error = originalError;
  }
});

test("state shard imports are validated, create-only, and conflict detecting", async () => {
  const root = tempRoot();
  const source = trustedChildRoot(root, "source");
  const destination = trustedChildRoot(root, "destination");
  recordReview(root);
  await flushWorkflowActionEvents(root, {
    env: workflowEnv(),
    outputRoot: source,
  });

  const created = importActionEventShards(source, destination);
  const destinationDirectory = path.dirname(path.join(destination, created.eventPaths[0]!));
  const replayed = importActionEventShards(source, destination);
  assert.equal(created.created, 1);
  assert.equal(replayed.unchanged, 1);
  assert.deepEqual(
    fs.readdirSync(destinationDirectory).filter((entry) => entry.endsWith(".tmp")),
    [],
  );

  const shard = path.join(source, created.eventPaths[0]!);
  fs.appendFileSync(shard, "\n", "utf8");
  assert.throws(
    () => importActionEventShards(source, destination),
    /action event shard content is not canonical/,
  );
});

test("manifest-bound imports reject a missing producer group before state publication", async () => {
  const root = tempRoot();
  const source = trustedChildRoot(root, "source");
  const destination = trustedChildRoot(root, "destination");
  recordReviewNumber(root, 42, workflowEnv({ CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "initial" }));
  const initialPaths = await flushWorkflowActionEvents(root, {
    env: workflowEnv({ CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "initial" }),
    outputRoot: source,
  });
  recordReviewNumber(root, 43, workflowEnv({ CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "retry" }));
  const manifestPaths = await flushWorkflowActionEvents(root, {
    env: workflowEnv({ CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "retry" }),
    outputRoot: source,
  });
  assert.equal(initialPaths.length, 1);
  assert.equal(manifestPaths.length, 2);

  fs.rmSync(path.join(source, initialPaths[0]!));
  assert.throws(
    () =>
      importActionEventShards(source, destination, {
        expectedEventPaths: manifestPaths,
      }),
    /action event shard manifest path is missing/,
  );
  assert.deepEqual(fs.readdirSync(destination), []);

  await flushWorkflowActionEvents(root, {
    env: workflowEnv({ CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "retry" }),
    outputRoot: source,
  });
  const imported = importActionEventShards(source, destination, {
    expectedEventPaths: manifestPaths,
  });
  assert.equal(imported.created, 2);
  assert.deepEqual(imported.eventPaths, manifestPaths);
});

test("state shard imports reject producer provenance outside the authenticated workflow job", async () => {
  const root = tempRoot();
  const source = trustedChildRoot(root, "source");
  const destination = trustedChildRoot(root, "destination");
  const event = recordReview(root);
  assert.ok(event);
  await flushWorkflowActionEvents(root, {
    env: workflowEnv(),
    outputRoot: source,
  });

  assert.throws(
    () =>
      importActionEventShards(source, destination, {
        expectedProducer: {
          repository: event.producer.repository,
          sha: event.producer.sha,
          workflow: event.producer.workflow,
          job: "publish",
          runId: event.producer.run_id,
          runAttempt: event.producer.run_attempt,
        },
      }),
    /producer provenance mismatch for job/,
  );
  assert.deepEqual(fs.readdirSync(destination), []);

  assert.equal(
    importActionEventShards(source, destination, {
      expectedProducer: {
        repository: event.producer.repository,
        sha: event.producer.sha,
        workflow: event.producer.workflow,
        job: event.producer.job,
        runId: event.producer.run_id,
        runAttempt: event.producer.run_attempt,
      },
    }).created,
    1,
  );
});

test("state shard imports validate duplicate and causal integrity across shard parts", () => {
  const root = tempRoot();
  const event = recordReview(root);
  assert.ok(event);
  const identity = shardIdentity(event);

  const duplicateSource = trustedChildRoot(root, "duplicate-source");
  const duplicateDestination = trustedChildRoot(root, "duplicate-destination");
  writeActionEventShard(duplicateSource, identity, [event], 1, 2);
  writeActionEventShard(duplicateSource, identity, [event], 2, 2);
  assert.throws(
    () => importActionEventShards(duplicateSource, duplicateDestination),
    /shard batch contains duplicate event/,
  );
  assert.deepEqual(fs.readdirSync(duplicateDestination), []);

  const firstKey = actionEventKey("review.cycle", { node: "first" });
  const secondKey = actionEventKey("review.cycle", { node: "second" });
  const firstId = actionEventId(event.subject.repository, firstKey);
  const secondId = actionEventId(event.subject.repository, secondKey);
  const first = recreateActionEvent(event, {
    eventKey: firstKey,
    parentEventId: secondId,
  });
  const second = recreateActionEvent(event, {
    eventKey: secondKey,
    parentEventId: firstId,
  });
  const cycleSource = trustedChildRoot(root, "cycle-source");
  const cycleDestination = trustedChildRoot(root, "cycle-destination");
  writeActionEventShard(cycleSource, identity, [first], 1, 2);
  writeActionEventShard(cycleSource, identity, [second], 2, 2);
  assert.throws(() => importActionEventShards(cycleSource, cycleDestination), /causal cycle/);
  assert.deepEqual(fs.readdirSync(cycleDestination), []);
});

test("state shard imports require deterministic repacking across shard parts", () => {
  const root = tempRoot();
  const event = recordReview(root);
  assert.ok(event);
  const second = recreateActionEvent(event, {
    eventKey: actionEventKey("review.completed", { number: 43 }),
    parentEventId: null,
  });
  const source = trustedChildRoot(root, "source");
  const destination = trustedChildRoot(root, "destination");
  const identity = shardIdentity(event);
  writeActionEventShard(source, identity, [event], 1, 2);
  writeActionEventShard(source, identity, [second], 2, 2);

  assert.throws(
    () => importActionEventShards(source, destination),
    /shard batch is not deterministically packed/,
  );
  assert.deepEqual(fs.readdirSync(destination), []);
});

test("state shard imports reject incomplete numbered sets and split producer partitions", () => {
  const root = tempRoot();
  const event = recordReview(root);
  assert.ok(event);
  const second = recreateActionEvent(event, {
    eventKey: actionEventKey("review.completed", { number: 43 }),
    parentEventId: null,
  });
  const identity = shardIdentity(event);

  const incompleteSource = trustedChildRoot(root, "incomplete-source");
  const incompleteDestination = trustedChildRoot(root, "incomplete-destination");
  writeActionEventShard(incompleteSource, identity, [event], 1, 3);
  writeActionEventShard(incompleteSource, identity, [second], 2, 3);
  assert.throws(
    () => importActionEventShards(incompleteSource, incompleteDestination),
    /shard batch is incomplete/,
  );
  assert.deepEqual(fs.readdirSync(incompleteDestination), []);

  const splitSource = trustedChildRoot(root, "split-source");
  const splitDestination = trustedChildRoot(root, "split-destination");
  writeActionEventShard(splitSource, identity, [event]);
  writeActionEventShard(splitSource, { ...identity, partitionDate: "2026-07-13" }, [second]);
  assert.throws(
    () => importActionEventShards(splitSource, splitDestination),
    /splits one producer run across partition dates/,
  );
  assert.deepEqual(fs.readdirSync(splitDestination), []);
});

test("state shard imports retain producer bindings across sequential batches", () => {
  const root = tempRoot();
  const event = recordReview(root);
  assert.ok(event);
  const identity = shardIdentity(event);
  const destination = trustedChildRoot(root, "destination");

  const initialSource = trustedChildRoot(root, "initial-source");
  writeActionEventShard(initialSource, identity, [event], 1, 1);
  assert.equal(importActionEventShards(initialSource, destination).created, 1);

  const replacementSource = trustedChildRoot(root, "replacement-source");
  const replacementEvents = Array.from({ length: 1_025 }, (_, index) =>
    recreateActionEvent(event, {
      eventKey: actionEventKey("review.replacement", { index }),
      parentEventId: null,
    }),
  );
  const replacementParts = writeActionEventShards(replacementSource, identity, replacementEvents);
  assert.equal(replacementParts.length, 2);
  assert.throws(
    () => importActionEventShards(replacementSource, destination),
    /producer shard-set binding conflict/,
  );

  const movedSource = trustedChildRoot(root, "moved-source");
  const movedEvent = recreateActionEvent(event, {
    eventKey: actionEventKey("review.moved", { partition: "2026-07-13" }),
    parentEventId: null,
  });
  writeActionEventShard(movedSource, { ...identity, partitionDate: "2026-07-13" }, [movedEvent]);
  assert.throws(
    () => importActionEventShards(movedSource, destination),
    /producer partition binding conflict/,
  );
});

test("state shard imports retain global event identity and causal acyclicity", () => {
  const root = tempRoot();
  const base = recordReview(root);
  assert.ok(base);

  const identityDestination = trustedChildRoot(root, "identity-destination");
  const identitySource = trustedChildRoot(root, "identity-source");
  writeActionEventShard(identitySource, shardIdentity(base), [base]);
  assert.equal(importActionEventShards(identitySource, identityDestination).created, 1);

  const conflictingProducer = {
    ...base.producer,
    component: `${base.producer.component}.conflict`,
  };
  const conflicting = recreateActionEvent(base, { producer: conflictingProducer });
  const conflictingSource = trustedChildRoot(root, "conflicting-source");
  const conflictingShard = writeActionEventShard(conflictingSource, shardIdentity(conflicting), [
    conflicting,
  ]);
  assert.throws(
    () => importActionEventShards(conflictingSource, identityDestination),
    /event identity conflict/,
  );
  assert.equal(fs.existsSync(path.join(identityDestination, conflictingShard.relativePath)), false);

  const cycleDestination = trustedChildRoot(root, "cycle-destination");
  const firstKey = actionEventKey("review.sequential-cycle", { node: "first" });
  const secondKey = actionEventKey("review.sequential-cycle", { node: "second" });
  const firstId = actionEventId(base.subject.repository, firstKey);
  const secondId = actionEventId(base.subject.repository, secondKey);
  const first = recreateActionEvent(base, {
    eventKey: firstKey,
    parentEventId: secondId,
  });
  const second = recreateActionEvent(base, {
    eventKey: secondKey,
    parentEventId: firstId,
    producer: {
      ...base.producer,
      component: `${base.producer.component}.cycle`,
    },
  });
  const firstSource = trustedChildRoot(root, "cycle-first-source");
  const secondSource = trustedChildRoot(root, "cycle-second-source");
  writeActionEventShard(firstSource, shardIdentity(first), [first]);
  const secondShard = writeActionEventShard(secondSource, shardIdentity(second), [second]);
  assert.equal(importActionEventShards(firstSource, cycleDestination).created, 1);
  assert.throws(() => importActionEventShards(secondSource, cycleDestination), /causal cycle/);
  assert.equal(fs.existsSync(path.join(cycleDestination, secondShard.relativePath)), false);
});

test("destination import transactions prevent concurrent opposing parent edges", async () => {
  const root = tempRoot();
  const base = recordReview(root);
  assert.ok(base);
  const destination = trustedChildRoot(root, "cycle-race-destination");
  const firstKey = actionEventKey("review.concurrent-cycle", { node: "first" });
  const secondKey = actionEventKey("review.concurrent-cycle", { node: "second" });
  const firstId = actionEventId(base.subject.repository, firstKey);
  const secondId = actionEventId(base.subject.repository, secondKey);
  const first = recreateActionEvent(base, {
    eventKey: firstKey,
    parentEventId: secondId,
  });
  const second = recreateActionEvent(base, {
    eventKey: secondKey,
    parentEventId: firstId,
    producer: {
      ...base.producer,
      component: `${base.producer.component}.concurrent-cycle`,
    },
  });
  const firstSource = trustedChildRoot(root, "cycle-race-first-source");
  const secondSource = trustedChildRoot(root, "cycle-race-second-source");
  const firstShard = writeActionEventShard(firstSource, shardIdentity(first), [first]);
  const secondShard = writeActionEventShard(secondSource, shardIdentity(second), [second]);
  const readyPath = path.join(root, "cycle-race-ready");
  const releasePath = path.join(root, "cycle-race-release");
  const moduleUrl = pathToFileURL(
    path.join(process.cwd(), "dist", "action-ledger-runtime.js"),
  ).href;
  const firstScript = `import fs from "node:fs";
const originalLink = fs.linkSync;
const wait = new Int32Array(new SharedArrayBuffer(4));
let paused = false;
fs.linkSync = (sourcePath, targetPath) => {
  if (
    !paused &&
    String(targetPath).includes("import-bindings") &&
    String(targetPath).includes("events")
  ) {
    paused = true;
    fs.writeFileSync(process.argv[3], "ready\\n");
    while (!fs.existsSync(process.argv[4])) Atomics.wait(wait, 0, 0, 5);
  }
  return originalLink(sourcePath, targetPath);
};
const { importActionEventShards } = await import(${JSON.stringify(moduleUrl)});
importActionEventShards(process.argv[1], process.argv[2]);`;
  const importScript = `const { importActionEventShards } = await import(${JSON.stringify(
    moduleUrl,
  )});
importActionEventShards(process.argv[1], process.argv[2]);`;
  const firstChild = spawn(
    process.execPath,
    ["--input-type=module", "-e", firstScript, firstSource, destination, readyPath, releasePath],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const firstDone = childResult(firstChild);
  await waitForPath(readyPath);
  const secondChild = spawn(
    process.execPath,
    ["--input-type=module", "-e", importScript, secondSource, destination],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const secondDone = childResult(secondChild);
  await new Promise((resolve) => setTimeout(resolve, 100));
  fs.writeFileSync(releasePath, "release\n");

  const [firstResult, secondResult] = await Promise.all([firstDone, secondDone]);
  assert.equal(firstResult.code, 0, firstResult.stderr || firstResult.stdout);
  assert.notEqual(secondResult.code, 0, secondResult.stdout);
  assert.match(secondResult.stderr, /causal cycle/);
  assert.equal(fs.existsSync(path.join(destination, firstShard.relativePath)), true);
  assert.equal(fs.existsSync(path.join(destination, secondShard.relativePath)), false);
});

test("state shard imports reject noncanonical trusted root spellings", async () => {
  const root = tempRoot();
  const source = trustedChildRoot(root, "source");
  const destination = trustedChildRoot(root, "destination");
  fs.mkdirSync(path.join(destination, "child"));
  recordReview(root);
  await flushWorkflowActionEvents(root, {
    env: workflowEnv(),
    outputRoot: source,
  });

  assert.throws(
    () => importActionEventShards(`${source}${path.sep}.`, destination),
    /noncanonical action event shard import source root/,
  );
  assert.throws(
    () => importActionEventShards(source, `${destination}${path.sep}child${path.sep}..`),
    /noncanonical action event shard import root/,
  );
});

test("state shard imports read each source shard once", async () => {
  const root = tempRoot();
  const source = trustedChildRoot(root, "source");
  const destination = trustedChildRoot(root, "destination");
  recordReview(root);
  const [relativePath] = await flushWorkflowActionEvents(root, {
    env: workflowEnv(),
    outputRoot: source,
  });
  assert.ok(relativePath);
  const shardPath = path.join(source, relativePath);
  const originalOpenSync = fs.openSync;
  let sourceOpenCount = 0;
  fs.openSync = ((filePath, flags, mode) => {
    if (filePath === shardPath) sourceOpenCount += 1;
    return originalOpenSync(filePath, flags, mode);
  }) as typeof fs.openSync;
  try {
    assert.equal(importActionEventShards(source, destination).created, 1);
  } finally {
    fs.openSync = originalOpenSync;
  }
  assert.equal(sourceOpenCount, 1);
});

test("state shard imports bound traversal depth and fanout", () => {
  const root = tempRoot();
  const destination = trustedChildRoot(root, "destination");

  const deepSource = trustedChildRoot(root, "deep-source");
  fs.mkdirSync(path.join(deepSource, "ledger", "v1", "events", "a", "b", "c", "d", "e", "f"), {
    recursive: true,
  });
  assert.throws(
    () => importActionEventShards(deepSource, destination),
    new RegExp(`maximum depth ${ACTION_EVENT_SHARD_IMPORT_LIMITS.maxDepth}`),
  );

  const fileSource = trustedChildRoot(root, "file-source");
  const fileDirectory = path.join(fileSource, "ledger", "v1", "events");
  fs.mkdirSync(fileDirectory, { recursive: true });
  for (let index = 0; index <= ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFiles; index += 1) {
    fs.writeFileSync(path.join(fileDirectory, `entry-${index}.txt`), "");
  }
  assert.throws(
    () => importActionEventShards(fileSource, destination),
    new RegExp(`${ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFiles} file limit`),
  );

  const directorySource = trustedChildRoot(root, "directory-source");
  const directoryRoot = path.join(directorySource, "ledger", "v1", "events");
  fs.mkdirSync(directoryRoot, { recursive: true });
  for (let index = 0; index < ACTION_EVENT_SHARD_IMPORT_LIMITS.maxDirectories; index += 1) {
    fs.mkdirSync(path.join(directoryRoot, `directory-${index}`));
  }
  assert.throws(
    () => importActionEventShards(directorySource, destination),
    new RegExp(`${ACTION_EVENT_SHARD_IMPORT_LIMITS.maxDirectories} directory limit`),
  );
  assert.deepEqual(fs.readdirSync(destination), []);
});

test("state shard imports enforce per-file byte, line, and event limits", async () => {
  const root = tempRoot();
  const destination = trustedChildRoot(root, "destination");

  const byteSource = trustedChildRoot(root, "byte-source");
  fs.writeFileSync(
    adversarialShardPath(byteSource, 1),
    Buffer.alloc(ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFileBytes + 1, 0x61),
  );
  assert.throws(
    () => importActionEventShards(byteSource, destination),
    new RegExp(`${ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFileBytes} byte limit`),
  );

  const lineSource = trustedChildRoot(root, "line-source");
  fs.writeFileSync(
    adversarialShardPath(lineSource, 1),
    "\n".repeat(ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFileLines + 1),
  );
  assert.throws(
    () => importActionEventShards(lineSource, destination),
    new RegExp(`${ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFileLines} line limit`),
  );

  const eventSource = trustedChildRoot(root, "event-source");
  recordReview(root);
  const [relativePath] = await flushWorkflowActionEvents(root, {
    env: workflowEnv(),
    outputRoot: eventSource,
  });
  assert.ok(relativePath);
  const eventPath = path.join(eventSource, relativePath);
  const eventLine = fs.readFileSync(eventPath, "utf8").trim();
  fs.writeFileSync(
    eventPath,
    `${Array.from(
      { length: ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFileEvents + 1 },
      () => eventLine,
    ).join("\n")}\n`,
  );
  assert.throws(
    () => importActionEventShards(eventSource, destination),
    new RegExp(`${ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFileEvents} event limit`),
  );
  assert.deepEqual(fs.readdirSync(destination), []);
});

test("state shard imports enforce aggregate byte limits before publication", async () => {
  const root = tempRoot();
  const destination = trustedChildRoot(root, "destination");

  const byteSource = trustedChildRoot(root, "byte-source");
  const byteFileCount =
    Math.floor(
      ACTION_EVENT_SHARD_IMPORT_LIMITS.maxTotalBytes /
        ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFileBytes,
    ) + 1;
  for (let index = 0; index < byteFileCount; index += 1) {
    const content = Buffer.alloc(ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFileBytes, 0x61);
    content[content.length - 1] = 0x0a;
    fs.writeFileSync(adversarialShardPath(byteSource, index), content);
  }
  assert.throws(
    () => importActionEventShards(byteSource, destination),
    new RegExp(`${ACTION_EVENT_SHARD_IMPORT_LIMITS.maxTotalBytes} total byte limit`),
  );

  assert.equal(
    ACTION_EVENT_SHARD_IMPORT_LIMITS.maxTotalEvents,
    ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFiles * ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFileEvents,
  );
  assert.deepEqual(fs.readdirSync(destination), []);
});

test("state shard imports accept a complete 4097-event producer run", () => {
  const root = tempRoot();
  const source = trustedChildRoot(root, "source");
  const destination = trustedChildRoot(root, "destination");
  const base = recordReview(root);
  assert.ok(base);
  const events = Array.from({ length: 4_097 }, (_, index) =>
    recreateActionEvent(base, {
      eventKey: actionEventKey("review.large-import", { index }),
      parentEventId: null,
    }),
  );
  const shards = writeActionEventShards(source, shardIdentity(base), events);
  assert.ok(shards.length > 4);

  const imported = importActionEventShards(source, destination);
  assert.equal(imported.created, shards.length);
  assert.equal(
    imported.eventPaths.reduce(
      (count, relativePath) =>
        count +
        fs.readFileSync(path.join(destination, relativePath), "utf8").trim().split("\n").length,
      0,
    ),
    events.length,
  );
});

test("state shard imports preserve chronological ordering across timestamp offsets", async () => {
  const root = tempRoot();
  const source = trustedChildRoot(root, "source");
  const destination = trustedChildRoot(root, "destination");
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
    .readFileSync(path.join(destination, imported.eventPaths[0]!), "utf8")
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
  const source = trustedChildRoot(root, "source");
  const destination = trustedChildRoot(root, "destination");
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
    .readFileSync(path.join(destination, imported.eventPaths[0]!), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).occurred_at);
  assert.deepEqual(occurredAt, ["2026-07-12T12:00:00.0001+02:00", "2026-07-12T10:00:00.0009Z"]);
});

test("state shard imports reject forged paths and duplicate events", async () => {
  const root = tempRoot();
  const source = trustedChildRoot(root, "source");
  const forgedDestination = trustedChildRoot(root, "forged-destination");
  const duplicateDestination = trustedChildRoot(root, "duplicate-destination");
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
    () => importActionEventShards(source, forgedDestination),
    /path does not match canonical identity/,
  );

  fs.renameSync(forged, shard);
  fs.writeFileSync(shard, `${content.trim()}\n${content.trim()}\n`, "utf8");
  assert.throws(
    () => importActionEventShards(source, duplicateDestination),
    /contains duplicate events/,
  );
});

test("state shard imports reject forged confidential event-key scopes", async () => {
  const root = tempRoot();
  const source = trustedChildRoot(root, "source");
  const destination = trustedChildRoot(root, "destination");
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

  assert.throws(() => importActionEventShards(source, destination), /confidential identifier/);
});

test("state shard imports reject forged source occurrence provenance", async () => {
  const root = tempRoot();
  const source = trustedChildRoot(root, "source");
  const destination = trustedChildRoot(root, "destination");
  recordReview(root);
  const [relativePath] = await flushWorkflowActionEvents(root, {
    env: workflowEnv(),
    outputRoot: source,
  });
  assert.ok(relativePath);
  const shardPath = path.join(source, relativePath);
  const event = JSON.parse(fs.readFileSync(shardPath, "utf8"));
  event.occurred_at = "2020-01-01T00:00:00.000Z";
  event.occurred_at_source = "generated";
  fs.writeFileSync(shardPath, `${actionLedgerJson(event)}\n`, "utf8");

  assert.throws(
    () => importActionEventShards(source, destination),
    /invalid action event semantic digest/,
  );
});

test("state shard imports ignore unrelated entries and reject links in the ledger subtree", () => {
  const root = tempRoot();
  const source = trustedChildRoot(root, "source");
  const linked = trustedChildRoot(root, "linked-source");
  const emptyDestination = trustedChildRoot(root, "empty-destination");
  const destination = trustedChildRoot(root, "destination");
  createDirectoryLink(linked, path.join(source, "linked"));
  assert.deepEqual(importActionEventShards(source, emptyDestination), {
    created: 0,
    unchanged: 0,
    eventPaths: [],
    reservationPaths: [],
    completionPaths: [],
    paths: [],
  });
  createDirectoryLink(linked, path.join(source, "ledger"));
  assert.throws(() => importActionEventShards(source, destination), /symbolic link or junction/);
});

test(
  "state shard import checks detect source-root swaps as defense in depth",
  {
    skip:
      process.platform === "win32"
        ? "requires POSIX directory rename and symlink semantics"
        : false,
  },
  async () => {
    const root = tempRoot();
    const source = trustedChildRoot(root, "source");
    const outside = path.join(root, "outside");
    const destination = trustedChildRoot(root, "destination");
    const base = recordReview(root);
    assert.ok(base);
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
        /changed action event shard import source file/,
      );
    } finally {
      fs.openSync = originalOpenSync;
    }
    assert.equal(swapped, true);
    assert.equal(fs.existsSync(path.join(destination, relativePath)), false);
  },
);

test(
  "interrupted shard imports publish completion manifests only after payload verification",
  {
    skip: process.platform === "win32" ? "uses SIGKILL process termination" : false,
  },
  async () => {
    const root = tempRoot();
    const source = trustedChildRoot(root, "source");
    const destination = trustedChildRoot(root, "destination");
    const base = recordReview(root);
    assert.ok(base);
    const events = Array.from({ length: 1_025 }, (_, index) =>
      recreateActionEvent(base, {
        eventKey: actionEventKey("review.interrupted-import", { index }),
        parentEventId: null,
      }),
    );
    const sourceShards = writeActionEventShards(source, shardIdentity(base), events);
    assert.equal(sourceShards.length, 2);
    const moduleUrl = pathToFileURL(
      path.join(process.cwd(), "dist", "action-ledger-runtime.js"),
    ).href;
    const script = `import fs from "node:fs";
const originalLink = fs.linkSync;
let interrupted = false;
fs.linkSync = (sourcePath, targetPath) => {
  originalLink(sourcePath, targetPath);
  if (!interrupted && String(targetPath).endsWith(".jsonl")) {
    interrupted = true;
    process.kill(process.pid, "SIGKILL");
  }
};
const { importActionEventShards } = await import(${JSON.stringify(moduleUrl)});
importActionEventShards(process.argv[1], process.argv[2]);`;
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script, source, destination],
      { encoding: "utf8" },
    );
    assert.equal(child.signal, "SIGKILL", child.stderr);
    const published = sourceShards.filter((shard) =>
      fs.existsSync(path.join(destination, shard.relativePath)),
    );
    assert.equal(published.length, 1);
    const interrupted = published[0]!;
    assert.throws(
      () => readActionEventShardAt(destination, interrupted.relativePath),
      /import transaction is incomplete/,
    );
    assert.throws(
      () => readActionEventShard(path.join(destination, interrupted.relativePath)),
      /import transaction is incomplete/,
    );
    const reservationRoot = path.join(destination, "ledger", "v1", "import-bindings", "shard-sets");
    const completionRoot = path.join(
      destination,
      "ledger",
      "v1",
      "import-bindings",
      "completed-shard-sets",
    );
    assert.equal(fs.readdirSync(reservationRoot).length, 1);
    assert.deepEqual(fs.existsSync(completionRoot) ? fs.readdirSync(completionRoot) : [], []);

    const replacementSource = trustedChildRoot(root, "replacement-source");
    const replacement = recreateActionEvent(base, {
      eventKey: actionEventKey("review.replacement-after-interruption", { number: 43 }),
      parentEventId: null,
    });
    const replacementShard = writeActionEventShard(replacementSource, shardIdentity(replacement), [
      replacement,
    ]);
    assert.throws(
      () => importActionEventShards(replacementSource, destination),
      /producer shard-set binding conflict/,
    );
    assert.equal(fs.existsSync(path.join(destination, replacementShard.relativePath)), false);

    const replay = importActionEventShards(source, destination);
    assert.equal(replay.created, 1);
    assert.equal(replay.unchanged, 1);
    assert.deepEqual(replay.eventPaths, sourceShards.map((shard) => shard.relativePath).sort());
    assert.ok(replay.reservationPaths.length > 0);
    assert.ok(replay.completionPaths.length > 0);
    assert.deepEqual(
      replay.paths,
      [...replay.eventPaths, ...replay.reservationPaths, ...replay.completionPaths].sort(),
    );
    assert.ok(replay.paths.length <= ACTION_EVENT_SHARD_IMPORT_MAX_PUBLISH_PATHS);
    const freshState = trustedChildRoot(root, "fresh-state");
    for (const relativePath of replay.paths) {
      const target = path.join(freshState, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(destination, relativePath), target);
    }
    assert.throws(
      () => importActionEventShards(replacementSource, freshState),
      /producer shard-set binding conflict/,
    );
    for (const shard of sourceShards) {
      assert.equal(
        fs.readFileSync(path.join(destination, shard.relativePath), "utf8"),
        fs.readFileSync(path.join(source, shard.relativePath), "utf8"),
      );
      assert.doesNotThrow(() => readActionEventShardAt(destination, shard.relativePath));
    }
    assert.equal(fs.readdirSync(completionRoot).length, 1);
  },
);

test("partition markers and import destinations reject symlinked parents", async () => {
  const root = tempRoot();
  const source = trustedChildRoot(root, "source");
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
