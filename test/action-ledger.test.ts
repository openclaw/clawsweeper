import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ACTION_EVENT_ATTRIBUTE_KEYS,
  ACTION_EVENT_CONFIDENTIAL_IDENTIFIER_PATTERN_SOURCES,
  ACTION_EVENT_FAMILIES,
  ACTION_EVENT_MACHINE_TEXT_PATTERN_SOURCE,
  ACTION_EVENT_PHASE_TYPES,
  ACTION_EVENT_REASON_CODES,
  ACTION_EVENT_STATUSES,
  ACTION_EVENT_SUBJECT_KINDS,
  ACTION_EVENT_TYPES,
  ActionEventConflictError,
  ActionEventShardConflictError,
  actionAttemptId,
  actionEventId,
  actionEventKey,
  actionEventShardRelativePath,
  actionEventSpoolRelativePath,
  actionIdempotencyKey,
  actionOperationId,
  createActionEvent,
  isActionEventPhaseType,
  isActionEventReasonCode,
  isActionEventStatus,
  readActionEventShard,
  readSpooledActionEvents,
  writeActionEvent,
  writeActionEventShard,
  type ActionEventInput,
  type ActionEventProducer,
} from "../dist/action-ledger.js";

const producer: ActionEventProducer = {
  repository: "openclaw/clawsweeper",
  sha: "abc123",
  workflow: "sweep",
  job: "review-3",
  runId: "100",
  runAttempt: 2,
  component: "review",
};
const operationId = actionOperationId("openclaw/openclaw", "review", {
  number: 42,
  sourceRevision: "abc123",
});
const attemptId = actionAttemptId(operationId, {
  workflow: "sweep",
  runId: "100",
  runAttempt: 2,
});

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-action-ledger-"));
}

function createDirectoryLink(target: string, link: string): void {
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

function reviewEventKey(
  scope = "review.completed",
  identity: Record<string, unknown> = {
    repository: "openclaw/openclaw",
    number: 42,
    sourceRevision: "abc123",
  },
): string {
  return actionEventKey(scope, identity);
}

function reviewInput(overrides: Partial<ActionEventInput> = {}): ActionEventInput {
  return {
    eventKey: reviewEventKey(),
    operationId,
    attemptId,
    parentEventId: null,
    phaseSeq: 2,
    idempotencyKeySha256: actionIdempotencyKey({
      repository: "openclaw/openclaw",
      number: 42,
      sourceRevision: "abc123",
      action: "review",
    }),
    type: ACTION_EVENT_TYPES.reviewCompleted,
    producer,
    subject: {
      repository: "openclaw/openclaw",
      kind: "pull_request",
      number: 42,
      sourceRevision: "abc123",
      recordPath: "records/openclaw-openclaw/items/42.md",
    },
    action: {
      name: "review",
      status: "completed",
      reasonCode: "keep_open",
      retryable: false,
      mutation: false,
    },
    evidence: [
      {
        kind: "review_record",
        reportPath: "records/openclaw-openclaw/items/42.md",
        sha256: "a".repeat(64),
        runUrl: "https://github.com/openclaw/clawsweeper/actions/runs/100",
      },
    ],
    attributes: {
      review_mode: "full",
      finding_count: 2,
      cached: false,
    },
    privacy: {
      classification: "internal",
      redactionVersion: "v1",
      fieldsDropped: ["body", "prompt"],
    },
    occurredAt: "2026-07-12T10:00:00.000Z",
    ...overrides,
  };
}

test("action events use deterministic identities and local spool paths", () => {
  const key = actionEventKey("review.completed", {
    repository: "openclaw/openclaw",
    number: 42,
    sourceRevision: "abc123",
  });
  assert.equal(
    key,
    actionEventKey("review.completed", {
      sourceRevision: "abc123",
      number: 42,
      repository: "openclaw/openclaw",
    }),
  );

  const id = actionEventId("OpenClaw/OpenClaw", key);
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.equal(
    actionEventSpoolRelativePath("OpenClaw/OpenClaw", id),
    path.join(".clawsweeper-repair", "action-events", "openclaw-openclaw", `${id}.json`),
  );
});

test("operation, attempt, and idempotency identities are canonical and separately scoped", () => {
  const reorderedOperation = actionOperationId("OpenClaw/OpenClaw", "review", {
    sourceRevision: "abc123",
    number: 42,
  });
  assert.equal(reorderedOperation, operationId);
  assert.equal(
    actionAttemptId(operationId, {
      runAttempt: 2,
      runId: "100",
      workflow: "sweep",
    }),
    attemptId,
  );
  assert.notEqual(
    actionAttemptId(operationId, { workflow: "sweep", runId: "100", runAttempt: 3 }),
    attemptId,
  );
  assert.equal(
    actionIdempotencyKey({ sourceRevision: "abc123", number: 42 }),
    actionIdempotencyKey({ number: 42, sourceRevision: "abc123" }),
  );
});

test("identity hashing rejects values outside the canonical JSON domain", () => {
  class IdentityClass {
    value = 1;
  }
  const accessor = Object.defineProperty({}, "value", {
    enumerable: true,
    get: () => 1,
  });
  const hidden = Object.defineProperty({}, "value", {
    value: 1,
  });
  const decorated = Object.assign([1], { extra: 2 });
  const invalidIdentities: unknown[] = [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -0,
    new Date("2026-07-12T00:00:00Z"),
    new IdentityClass(),
    undefined,
    () => 1,
    Symbol("identity"),
    1n,
    Array(1),
    [undefined],
    decorated,
    { value: undefined },
    { value: () => 1 },
    { value: Symbol("identity") },
    { value: 1n },
    accessor,
    hidden,
  ];

  for (const identity of invalidIdentities) {
    assert.throws(() => actionIdempotencyKey(identity), /action event data contains/);
  }
  for (const identity of [{ token: "opaque" }, { api_key: "opaque" }, { clientSecret: "opaque" }]) {
    assert.throws(
      () => actionIdempotencyKey(identity),
      /identity contains a high-risk credential field/,
    );
  }
  assert.throws(() => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    actionEventKey("review.completed", cycle);
  }, /contains a cycle/);
});

test("every event persists the required correlation envelope", () => {
  const event = createActionEvent(reviewInput());
  assert.equal(event.operation_id, operationId);
  assert.equal(event.attempt_id, attemptId);
  assert.equal(event.parent_event_id, null);
  assert.equal(event.phase_seq, 2);
  assert.match(event.idempotency_key_sha256, /^[a-f0-9]{64}$/);
});

test("events reject malformed correlation identities and self-parenting", () => {
  assert.throws(
    () => createActionEvent(reviewInput({ operationId: "not-a-digest" })),
    /operation id must be a lowercase SHA-256 digest/,
  );
  assert.throws(
    () => createActionEvent(reviewInput({ phaseSeq: 0 })),
    /phase sequence must be a positive integer/,
  );
  const input = reviewInput();
  const eventId = actionEventId(input.subject.repository, input.eventKey);
  assert.throws(
    () => createActionEvent({ ...input, parentEventId: eventId }),
    /cannot reference itself/,
  );
});

test("callers cannot persist raw event identity in an event key", () => {
  assert.throws(
    () =>
      createActionEvent(
        reviewInput({
          eventKey: "review.completed:openclaw/openclaw:42:private-value",
        }),
      ),
    /must be generated/,
  );
});

test("the standard taxonomy covers six families without orphaned or duplicate types", () => {
  const values = Object.values(ACTION_EVENT_TYPES);
  assert.equal(new Set(values).size, values.length);
  assert.deepEqual(Object.keys(ACTION_EVENT_FAMILIES), [
    "review",
    "command",
    "repair",
    "apply",
    "operations",
    "evidence",
  ]);
  const familyValues = Object.values(ACTION_EVENT_FAMILIES).flat();
  assert.equal(familyValues.length, values.length);
  assert.deepEqual(new Set(familyValues), new Set(values));

  for (const required of [
    "command.received",
    "command.classified",
    "command.claim_refreshed",
    "command.progress",
    "command.wait",
    "command.requeue",
    "command.recover",
    "workflow.attempt",
    "dispatch.lifecycle",
    "retry.lifecycle",
    "queue.lifecycle",
    "review.batch",
    "review.item",
    "review.retry",
    "review.log_publication",
    "review.comment_publication",
    "repair.intake",
    "repair.dispatch",
    "repair.plan",
    "repair.execute",
    "repair.validate",
    "repair.review",
    "repair.publish",
    "repair.postflight",
    "repair.requeue",
    "repair.recover",
    "repair.queue",
    "repair.blocked",
    "repair.failed",
    "apply.action",
    "apply.batch",
    "apply.publish",
    "notification.delivery",
    "notification.planned",
    "notification.skipped",
    "notification.retried",
    "notification.sent",
    "notification.failed",
    "publication.lifecycle",
    "status.lifecycle",
    "dashboard.lifecycle",
    "session.cancelled",
    "gitcrawl.snapshot",
    "gitcrawl.query",
    "gitcrawl.binding",
    "proof.stage",
    "proof.binding",
  ]) {
    assert.equal(values.includes(required as never), true, required);
  }
});

test("canonical phase, status, and reason vocabularies reject arbitrary strings", () => {
  for (const required of [
    ACTION_EVENT_TYPES.repairBlocked,
    ACTION_EVENT_TYPES.repairFailed,
    ACTION_EVENT_TYPES.notificationPlanned,
    ACTION_EVENT_TYPES.notificationSkipped,
    ACTION_EVENT_TYPES.notificationRetried,
    ACTION_EVENT_TYPES.sessionCancelled,
  ]) {
    assert.equal(Object.values(ACTION_EVENT_PHASE_TYPES).includes(required), true, required);
  }
  for (const phase of Object.values(ACTION_EVENT_PHASE_TYPES)) {
    assert.equal(isActionEventPhaseType(phase), true, phase);
  }
  for (const status of Object.values(ACTION_EVENT_STATUSES)) {
    assert.equal(isActionEventStatus(status), true, status);
  }
  for (const reason of Object.values(ACTION_EVENT_REASON_CODES)) {
    assert.equal(isActionEventReasonCode(reason), true, reason);
  }
  assert.equal(isActionEventPhaseType("repair.anything"), false);
  assert.equal(isActionEventStatus("some prose"), false);
  assert.equal(isActionEventReasonCode("because I said so"), false);
});

test("new durable subjects carry bounded machine identities", () => {
  for (const kind of ["commit", "queue_item", "deployment", "publication"] as const) {
    const event = createActionEvent(
      reviewInput({
        eventKey: reviewEventKey(`subject.${kind}`),
        subject: {
          repository: "openclaw/openclaw",
          kind,
          subjectId: `${kind}_42`,
          ...(kind === "commit" ? { sourceRevision: "abc123" } : {}),
        },
      }),
    );
    assert.equal(event.subject.kind, kind);
    assert.equal(event.subject.subject_id, `${kind}_42`);
  }
});

test("runtime allowlists stay aligned with the checked-in schema", () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "schema", "state-ledger-event.schema.json"), "utf8"),
  );
  assert.deepEqual(schema.properties.subject.properties.kind.enum, [...ACTION_EVENT_SUBJECT_KINDS]);
  assert.deepEqual(
    Object.keys(schema.properties.attributes.properties).sort(),
    [...ACTION_EVENT_ATTRIBUTE_KEYS].sort(),
  );
  assert.deepEqual(schema.$defs.standardEventType.enum, Object.values(ACTION_EVENT_TYPES));
  assert.deepEqual(schema.$defs.canonicalActionStatus.enum, Object.values(ACTION_EVENT_STATUSES));
  assert.deepEqual(schema.$defs.canonicalReasonCode.enum, Object.values(ACTION_EVENT_REASON_CODES));
  assert.equal(schema.$defs.machineText.pattern, ACTION_EVENT_MACHINE_TEXT_PATTERN_SOURCE);
  assert.deepEqual(
    schema.$defs.confidentialIdentifier.anyOf.map((entry: { pattern: string }) => entry.pattern),
    [...ACTION_EVENT_CONFIDENTIAL_IDENTIFIER_PATTERN_SOURCES],
  );
});

test("runtime and schema apply the same machine-text privacy boundary", () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "schema", "state-ledger-event.schema.json"), "utf8"),
  );
  const machineText = schema.$defs.machineText as {
    minLength: number;
    maxLength: number;
    pattern: string;
  };
  const confidentialPatterns = (
    schema.$defs.confidentialIdentifier.anyOf as Array<{ pattern: string }>
  ).map((entry) => new RegExp(entry.pattern));
  const schemaAllows = (value: string): boolean =>
    value.length >= machineText.minLength &&
    value.length <= machineText.maxLength &&
    new RegExp(machineText.pattern).test(value) &&
    confidentialPatterns.every((pattern) => !pattern.test(value));
  const samples = [
    "review.completed",
    "claude-3.5",
    "github.com/openclaw",
    `ghs_${"A".repeat(30)}`,
    `ghu_${"A".repeat(30)}`,
    `gho_${"A".repeat(30)}`,
    `ghr_${"A".repeat(30)}`,
    `github_pat_${"A".repeat(24)}`,
    `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${"A".repeat(32)}`,
    `Bearer:${"A".repeat(32)}`,
    `api_key:${"A".repeat(32)}`,
    `cloudflare_api_token:${"A".repeat(32)}`,
    "service.internal",
    "internal.example.com",
    "https://host.docker.internal/api",
    "https://10.0.0.1/api",
  ];

  for (const value of samples) {
    let runtimeAllows = true;
    try {
      createActionEvent(
        reviewInput({
          action: {
            name: "review",
            status: value,
            retryable: false,
            mutation: false,
          },
        }),
      );
    } catch {
      runtimeAllows = false;
    }
    assert.equal(runtimeAllows, schemaAllows(value), value);
  }
});

test("action event writes are create-only and replay-idempotent", () => {
  const root = tempRoot();
  const input = reviewInput();
  const created = writeActionEvent(root, input, {
    now: () => new Date("2026-07-12T10:01:00.000Z"),
  });
  const replayed = writeActionEvent(root, input, {
    now: () => new Date("2026-07-12T11:00:00.000Z"),
  });

  assert.equal(created.status, "created");
  assert.equal(replayed.status, "unchanged");
  assert.equal(replayed.event.recorded_at, "2026-07-12T10:01:00.000Z");
  assert.equal(fs.readFileSync(created.path, "utf8"), fs.readFileSync(replayed.path, "utf8"));
});

test("spool and shard writes reject symlinked parent directories", () => {
  const root = tempRoot();
  const outside = tempRoot();
  fs.mkdirSync(path.join(root, ".clawsweeper-repair"));
  createDirectoryLink(outside, path.join(root, ".clawsweeper-repair", "action-events"));

  assert.throws(() => writeActionEvent(root, reviewInput()), /symbolic link or junction/);
  assert.deepEqual(fs.readdirSync(outside), []);

  const shardRoot = tempRoot();
  const shardOutside = tempRoot();
  createDirectoryLink(shardOutside, path.join(shardRoot, "ledger"));
  assert.throws(
    () =>
      writeActionEventShard(
        shardRoot,
        {
          repository: producer.repository,
          sha: producer.sha,
          producer: "review",
          workflow: "sweep",
          job: "review-3",
          runId: "100",
          runAttempt: 2,
          partitionDate: "2026-07-12",
        },
        [createActionEvent(reviewInput())],
      ),
    /symbolic link or junction/,
  );
  assert.deepEqual(fs.readdirSync(shardOutside), []);
});

test("an event key cannot be reused for different semantic content", () => {
  const root = tempRoot();
  writeActionEvent(root, reviewInput());

  assert.throws(
    () =>
      writeActionEvent(
        root,
        reviewInput({
          action: {
            name: "review",
            status: "completed",
            reasonCode: "close",
            retryable: false,
            mutation: false,
          },
        }),
      ),
    (error) => {
      assert.ok(error instanceof ActionEventConflictError);
      assert.match(error.message, /action event conflict/);
      return true;
    },
  );
});

test("an event key cannot be replayed with a different occurrence timestamp", () => {
  const root = tempRoot();
  writeActionEvent(root, reviewInput());

  assert.throws(
    () =>
      writeActionEvent(
        root,
        reviewInput({
          occurredAt: "2026-07-12T10:00:01.000Z",
        }),
      ),
    ActionEventConflictError,
  );
});

test("durable shards batch sorted events once per producer job", () => {
  const root = tempRoot();
  const completed = createActionEvent(reviewInput(), {
    now: () => new Date("2026-07-12T10:01:00.000Z"),
  });
  const started = createActionEvent(
    reviewInput({
      eventKey: reviewEventKey("review.started"),
      type: ACTION_EVENT_TYPES.reviewStarted,
      action: {
        name: "review",
        status: "started",
        retryable: true,
        mutation: false,
      },
      evidence: [],
      occurredAt: "2026-07-12T09:58:00.000Z",
    }),
    { now: () => new Date("2026-07-12T09:58:01.000Z") },
  );
  const identity = {
    repository: producer.repository,
    sha: producer.sha,
    producer: "review",
    workflow: "sweep",
    job: "review-3",
    runId: "100",
    runAttempt: 2,
    partitionDate: "2026-07-12",
  };

  const created = writeActionEventShard(root, identity, [completed, started, completed]);
  const replayed = writeActionEventShard(root, identity, [started, completed]);

  assert.equal(created.status, "created");
  assert.equal(replayed.status, "unchanged");
  assert.equal(created.eventCount, 2);
  assert.equal(created.relativePath, actionEventShardRelativePath(identity, [started, completed]));
  assert.match(
    created.relativePath,
    /^ledger\/v1\/events\/2026\/07\/12\/openclaw-clawsweeper\/review\/100-2-review-3-[a-f0-9]{12}\.jsonl$/,
  );
  assert.deepEqual(
    readActionEventShard(created.path).map((event) => event.event_type),
    [ACTION_EVENT_TYPES.reviewStarted, ACTION_EVENT_TYPES.reviewCompleted],
  );
});

test("durable shards preserve sub-millisecond ordering across timestamp offsets", () => {
  const root = tempRoot();
  const later = createActionEvent(
    reviewInput({
      occurredAt: "2026-07-12T10:00:00.0009Z",
    }),
  );
  const earlier = createActionEvent(
    reviewInput({
      eventKey: reviewEventKey("review.started", {
        repository: "openclaw/openclaw",
        number: 43,
        sourceRevision: "abc123",
      }),
      type: ACTION_EVENT_TYPES.reviewStarted,
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
      evidence: [],
      occurredAt: "2026-07-12T12:00:00.0001+02:00",
    }),
  );
  const identity = {
    repository: producer.repository,
    sha: producer.sha,
    producer: "review",
    workflow: "sweep",
    job: "review-3",
    runId: "100",
    runAttempt: 2,
    partitionDate: "2026-07-12",
  };

  const shard = writeActionEventShard(root, identity, [later, earlier]);

  assert.deepEqual(
    readActionEventShard(shard.path).map((event) => event.occurred_at),
    [earlier.occurred_at, later.occurred_at],
  );
});

test("a shard identity cannot be reused for a different event set", () => {
  const root = tempRoot();
  const identity = {
    repository: producer.repository,
    sha: producer.sha,
    producer: "review",
    workflow: "sweep",
    job: "review-3",
    runId: "100",
    runAttempt: 2,
    partitionDate: "2026-07-12",
  };
  const completed = createActionEvent(reviewInput());
  writeActionEventShard(root, identity, [completed]);
  const second = createActionEvent(
    reviewInput({
      eventKey: reviewEventKey("review.completed", {
        repository: "openclaw/openclaw",
        number: 43,
        sourceRevision: "def456",
      }),
      subject: {
        repository: "openclaw/openclaw",
        kind: "pull_request",
        number: 43,
        sourceRevision: "def456",
      },
    }),
  );

  assert.throws(
    () => writeActionEventShard(root, identity, [completed, second]),
    ActionEventShardConflictError,
  );
});

test("shard paths use the stable run partition instead of event ordering", () => {
  const identity = {
    repository: producer.repository,
    sha: producer.sha,
    producer: "review",
    workflow: "sweep",
    job: "review-3",
    runId: "100",
    runAttempt: 2,
    partitionDate: "2026-07-12",
  };
  const completed = createActionEvent(reviewInput());
  const earlier = createActionEvent(
    reviewInput({
      eventKey: reviewEventKey("review.started"),
      type: ACTION_EVENT_TYPES.reviewStarted,
      action: {
        name: "review",
        status: "started",
        retryable: true,
        mutation: false,
      },
      occurredAt: "2026-07-11T23:59:00.000Z",
    }),
  );

  assert.equal(
    actionEventShardRelativePath(identity, [completed]),
    actionEventShardRelativePath(identity, [earlier, completed]),
  );
});

test("duplicate event IDs must have identical occurrence metadata", () => {
  const identity = {
    repository: producer.repository,
    sha: producer.sha,
    producer: "review",
    workflow: "sweep",
    job: "review-3",
    runId: "100",
    runAttempt: 2,
    partitionDate: "2026-07-12",
  };
  const first = createActionEvent(reviewInput(), {
    now: () => new Date("2026-07-12T10:01:00.000Z"),
  });
  const conflicting = createActionEvent(reviewInput({ occurredAt: "2026-07-12T10:00:01.000Z" }), {
    now: () => new Date("2026-07-12T10:01:00.000Z"),
  });

  assert.throws(
    () => actionEventShardRelativePath(identity, [first, conflicting]),
    /conflicting duplicate metadata/,
  );
});

test("spooled events remain independent and read in occurrence order", () => {
  const root = tempRoot();
  const later = writeActionEvent(
    root,
    reviewInput({
      occurredAt: "2026-07-12T09:00:00.000Z",
    }),
  );
  const earlier = writeActionEvent(
    root,
    reviewInput({
      eventKey: reviewEventKey("review.started"),
      type: ACTION_EVENT_TYPES.reviewStarted,
      action: {
        name: "review",
        status: "started",
        retryable: true,
        mutation: false,
      },
      occurredAt: "2026-07-12T10:00:00.000+02:00",
    }),
  );

  assert.notEqual(later.path, earlier.path);
  assert.deepEqual(
    readSpooledActionEvents(root, "openclaw/openclaw").map((event) => event.event_type),
    [ACTION_EVENT_TYPES.reviewStarted, ACTION_EVENT_TYPES.reviewCompleted],
  );
});

test("replaying an event with generated occurrence time preserves the first write", () => {
  const root = tempRoot();
  const first = writeActionEvent(root, reviewInput(), {
    now: () => new Date("2026-07-12T10:01:00.000Z"),
  });
  const replay = writeActionEvent(root, reviewInput(), {
    now: () => new Date("2026-07-12T10:02:00.000Z"),
  });

  assert.equal(replay.status, "unchanged");
  assert.equal(replay.event.occurred_at, first.event.occurred_at);
  assert.equal(replay.event.recorded_at, first.event.recorded_at);
});

test("replaying an event with a changed explicit occurrence time still conflicts", () => {
  const root = tempRoot();
  writeActionEvent(root, reviewInput({ occurredAt: "2026-07-12T10:00:00.000Z" }));

  assert.throws(
    () => writeActionEvent(root, reviewInput({ occurredAt: "2026-07-12T10:00:01.000Z" })),
    /action event conflict/,
  );
});

test("durable privacy guards reject raw text, local paths, secrets, and invalid digests", () => {
  assert.throws(
    () =>
      createActionEvent(
        reviewInput({
          attributes: { note: "neutral-key prose is still not durable" } as never,
        }),
      ),
    /not allowlisted/,
  );
  assert.throws(
    () =>
      createActionEvent(
        reviewInput({
          attributes: { model: "secret@example.com" },
        }),
      ),
    /confidential identifier/,
  );
  for (const confidentialIdentifier of [
    `ghs_${"A".repeat(30)}`,
    `ghu_${"A".repeat(30)}`,
    `gho_${"A".repeat(30)}`,
    `ghr_${"A".repeat(30)}`,
    `github_pat_${"A".repeat(24)}`,
    `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${"A".repeat(32)}`,
    `Bearer:${"A".repeat(32)}`,
    `cloudflare_api_token:${"A".repeat(32)}`,
    "service.internal",
    "internal.example.com",
  ]) {
    assert.throws(
      () =>
        createActionEvent(
          reviewInput({
            action: {
              name: "review",
              status: confidentialIdentifier,
              retryable: false,
              mutation: false,
            },
          }),
        ),
      /confidential identifier/,
    );
  }
  assert.throws(
    () =>
      createActionEvent(
        reviewInput({
          evidence: [{ kind: "review", sha256: "nope" }],
        }),
      ),
    /evidence sha256/,
  );
  assert.throws(
    () =>
      createActionEvent(
        reviewInput({
          subject: {
            repository: "../outside",
            kind: "repository",
          },
        }),
      ),
    /invalid action event repository/,
  );
  assert.throws(
    () =>
      createActionEvent(
        reviewInput({
          attributes: { model: { not: "a scalar" } } as never,
        }),
      ),
    /must be a scalar/,
  );
  assert.throws(
    () =>
      createActionEvent(
        reviewInput({
          attributes: { completion_reason: "raw prose is not a reason code" },
        }),
      ),
    /machine-readable text/,
  );
  assert.throws(
    () =>
      createActionEvent(
        reviewInput({
          attributes: { finding_count: 1.5 },
        }),
      ),
    /non-negative integer/,
  );
  for (const recordPath of [
    "./",
    ".//Users/example/private.txt",
    "./C:/Users/example/private.txt",
    `records/github_pat_${"A".repeat(24)}.md`,
  ]) {
    assert.throws(
      () =>
        createActionEvent(
          reviewInput({
            subject: {
              repository: "openclaw/openclaw",
              kind: "issue",
              number: 42,
              recordPath,
            },
          }),
        ),
      /repository-relative path|confidential identifier/,
    );
  }
});

test("event readers reject unknown fields instead of carrying unhashed data into shards", () => {
  const root = tempRoot();
  const written = writeActionEvent(root, reviewInput());
  const value = JSON.parse(fs.readFileSync(written.path, "utf8"));
  value.prompt = "unhashed private text";
  fs.writeFileSync(written.path, `${JSON.stringify(value)}\n`);

  assert.throws(
    () => readSpooledActionEvents(root, "openclaw/openclaw"),
    /unknown or non-canonical fields/,
  );
});

test("run URLs are limited to public GitHub workflow evidence", () => {
  for (const runUrl of [
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/actions/runs/100",
    "https://[fc00::1]/actions/runs/100",
    "https://internal.example/actions/runs/100",
    "https://github.com/login/oauth/authorize?client_secret=PLACEHOLDER",
    "https://github.com/openclaw/clawsweeper/actions/runs/100?token=PLACEHOLDER",
    "https://github.com/openclaw/clawsweeper/issues/100",
  ]) {
    assert.throws(
      () =>
        createActionEvent(
          reviewInput({
            evidence: [{ kind: "run", runUrl }],
          }),
        ),
      /credential-free HTTPS URL|public github\.com Actions run/,
    );
  }
});

test("runtime normalization enforces checked-in schema bounds", () => {
  const expanded = createActionEvent(
    reviewInput({
      attributes: {
        action_count: 3,
        batch_index: 0,
        batch_size: 10,
        final_attempt: false,
        log_count: 2,
        log_kind: "review_worker",
        queue_depth: 4,
        queue_kind: "repair",
        retry_count: 1,
        retry_delay_ms: 5_000,
        validation_count: 2,
        validation_kind: "focused",
        wait_duration_ms: 250,
        workflow_phase: "postflight",
      },
    }),
  );
  assert.equal(expanded.attributes?.queue_depth, 4);
  assert.equal(expanded.attributes?.workflow_phase, "postflight");

  assert.throws(
    () =>
      createActionEvent(
        reviewInput({
          evidence: Array.from({ length: 65 }, (_, index) => ({
            kind: `evidence_${index}`,
          })),
        }),
      ),
    /exceeds 64 entries/,
  );
  assert.throws(
    () =>
      createActionEvent(
        reviewInput({
          subject: {
            repository: "openclaw/openclaw",
            kind: "cluster",
            clusterId: "x".repeat(257),
          },
        }),
      ),
    /cluster id exceeds 256/,
  );
  assert.throws(
    () => createActionEvent(reviewInput({ occurredAt: "2026-07-12" })),
    /ISO date-time/,
  );
  assert.throws(
    () => createActionEvent(reviewInput({ occurredAt: "2026-02-31T10:00:00Z" })),
    /ISO date-time/,
  );
  assert.throws(
    () =>
      createActionEvent(
        reviewInput({
          privacy: {
            classification: "internal",
            redactionVersion: "v1",
            fieldsDropped: Array.from({ length: 65 }, (_, index) => `field_${index}`),
          },
        }),
      ),
    /fieldsDropped exceeds 64 entries/,
  );
  assert.throws(
    () =>
      createActionEvent(
        reviewInput({
          attributes: { retry_count: -1 },
        }),
      ),
    /non-negative integer/,
  );
  for (const status of [
    "10.0.0.1:22",
    "ssh://alice:secret@10.0.0.1",
    "prefix:169.254.169.254",
    "https://internal.local",
  ]) {
    assert.throws(
      () =>
        createActionEvent(
          reviewInput({
            action: {
              name: "review",
              status,
              retryable: false,
              mutation: false,
            },
          }),
        ),
      /confidential identifier/,
    );
  }
  assert.throws(
    () =>
      writeActionEventShard(
        tempRoot(),
        {
          repository: producer.repository,
          sha: producer.sha,
          producer: "review",
          workflow: "sweep",
          job: "review-3",
          runId: "100",
          runAttempt: 2,
          partitionDate: "2026-02-31",
        },
        [createActionEvent(reviewInput())],
      ),
    /ISO calendar date/,
  );
});

test("shards reject events from any different producer identity", () => {
  const event = createActionEvent(reviewInput());
  const identity = {
    repository: producer.repository,
    sha: producer.sha,
    producer: producer.component,
    workflow: producer.workflow,
    job: producer.job,
    runId: producer.runId,
    runAttempt: producer.runAttempt,
    partitionDate: "2026-07-12",
  };
  for (const changed of [
    { ...identity, repository: "other/automation" },
    { ...identity, sha: "def456" },
    { ...identity, producer: "apply" },
  ]) {
    assert.throws(
      () => writeActionEventShard(tempRoot(), changed, [event]),
      /does not match shard producer identity/,
    );
  }
  assert.notEqual(
    actionEventShardRelativePath(identity, [event]),
    actionEventShardRelativePath({ ...identity, sha: "def456" }, [event]),
  );
});
