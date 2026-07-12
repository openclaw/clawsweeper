import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  ACTION_LEDGER_CANONICAL_JSON_LIMITS,
  ACTION_EVENT_ATTRIBUTE_KEYS,
  ACTION_EVENT_CONFIDENTIAL_IDENTIFIER_PATTERN_SOURCES,
  ACTION_EVENT_FAMILIES,
  ACTION_EVENT_MACHINE_TEXT_PATTERN_SOURCE,
  ACTION_EVENT_PHASE_TYPES,
  ACTION_EVENT_REASON_CODES,
  ACTION_EVENT_RELATIVE_DATA_PATH_PATTERN_SOURCE,
  ACTION_EVENT_SHARD_FILE_LIMITS,
  ACTION_EVENT_SHARD_SET_LIMITS,
  ACTION_EVENT_SPOOL_READ_LIMITS,
  ACTION_EVENT_STATUSES,
  ACTION_EVENT_SUBJECT_KINDS,
  ACTION_EVENT_TIMESTAMP_PATTERN_SOURCE,
  ACTION_EVENT_TYPES,
  ActionEventConflictError,
  ActionEventShardConflictError,
  actionAttemptId,
  actionEventId,
  actionEventKey,
  actionEventShardRelativePath,
  actionEventSpoolRelativePath,
  actionIdempotencyKey,
  actionLedgerJson,
  actionOperationId,
  createActionEvent,
  isActionEventPhaseType,
  isActionEventReasonCode,
  isActionEventStatus,
  readActionEvent,
  readActionEventShard,
  readAllSpooledActionEvents,
  readSpooledActionEvents,
  validateActionEvent,
  writeActionEvent,
  writeActionEventShard,
  writeActionEventShards,
  type ActionEvent,
  type ActionEventInput,
  type ActionEventProducer,
} from "../dist/action-ledger.js";
import {
  prepareSafeWriteTarget,
  removeUtf8FileIfContentNoFollow,
  tryAcquireUtf8FileLockNoFollow,
} from "../dist/action-ledger-files.js";
import { importActionEventShards } from "../dist/action-ledger-runtime.js";
import { stableJson } from "../dist/stable-json.js";

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
  return fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-action-ledger-")),
  );
}

function createDirectoryLink(target: string, link: string): void {
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

type TestJsonSchema = Record<string, unknown>;

function schemaAccepts(root: TestJsonSchema, value: unknown): boolean {
  return schemaNodeAccepts(root, root, value);
}

function schemaNodeAccepts(root: TestJsonSchema, node: TestJsonSchema, value: unknown): boolean {
  const reference = node.$ref;
  if (typeof reference === "string") {
    if (!reference.startsWith("#/$defs/")) return false;
    const name = reference.slice("#/$defs/".length);
    const definition = (root.$defs as Record<string, TestJsonSchema> | undefined)?.[name];
    if (!definition || !schemaNodeAccepts(root, definition, value)) return false;
  }
  const allOf = node.allOf as TestJsonSchema[] | undefined;
  if (allOf && !allOf.every((entry) => schemaNodeAccepts(root, entry, value))) return false;
  const anyOf = node.anyOf as TestJsonSchema[] | undefined;
  if (anyOf && !anyOf.some((entry) => schemaNodeAccepts(root, entry, value))) return false;
  const oneOf = node.oneOf as TestJsonSchema[] | undefined;
  if (oneOf && oneOf.filter((entry) => schemaNodeAccepts(root, entry, value)).length !== 1) {
    return false;
  }
  const excluded = node.not as TestJsonSchema | undefined;
  if (excluded && schemaNodeAccepts(root, excluded, value)) return false;
  if ("const" in node && !sameJsonValue(value, node.const)) return false;
  const allowed = node.enum as unknown[] | undefined;
  if (allowed && !allowed.some((entry) => sameJsonValue(value, entry))) return false;

  const type = node.type;
  if (typeof type === "string" && !matchesSchemaType(type, value)) return false;
  if (Array.isArray(type) && !type.some((entry) => matchesSchemaType(String(entry), value))) {
    return false;
  }

  if (typeof value === "string") {
    if (typeof node.minLength === "number" && value.length < node.minLength) return false;
    if (typeof node.maxLength === "number" && value.length > node.maxLength) return false;
    if (typeof node.pattern === "string" && !new RegExp(node.pattern).test(value)) return false;
    if (node.format === "date-time" && !Number.isFinite(Date.parse(value))) return false;
    if (node.format === "uri") {
      try {
        new URL(value);
      } catch {
        return false;
      }
    }
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return false;
    if (typeof node.minimum === "number" && value < node.minimum) return false;
    if (typeof node.maximum === "number" && value > node.maximum) return false;
  }

  if (Array.isArray(value)) {
    if (typeof node.minItems === "number" && value.length < node.minItems) return false;
    if (typeof node.maxItems === "number" && value.length > node.maxItems) return false;
    if (
      node.uniqueItems === true &&
      new Set(value.map((entry) => JSON.stringify(entry))).size !== value.length
    ) {
      return false;
    }
    const items = node.items as TestJsonSchema | undefined;
    if (items && !value.every((entry) => schemaNodeAccepts(root, items, entry))) return false;
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const required = node.required as string[] | undefined;
    if (required && required.some((key) => !Object.hasOwn(record, key))) return false;
    const properties = (node.properties as Record<string, TestJsonSchema> | undefined) ?? {};
    if (
      node.additionalProperties === false &&
      Object.keys(record).some((key) => !properties[key])
    ) {
      return false;
    }
    for (const [key, entry] of Object.entries(record)) {
      const property = properties[key];
      if (property && !schemaNodeAccepts(root, property, entry)) return false;
    }
  }

  return true;
}

function matchesSchemaType(type: string, value: unknown): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object")
    return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number";
  return typeof value === type;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
    path.join(
      ".clawsweeper-repair",
      "action-events",
      "openclaw-openclaw-5dcd5a46c4da",
      `${id}.json`,
    ),
  );
});

test("spool directories isolate lossy repository slugs and readers verify canonical placement", () => {
  const root = tempRoot();
  const firstRepository = "a/b-c";
  const secondRepository = "a-b/c";
  const event = writeActionEvent(
    root,
    reviewInput({
      subject: {
        repository: firstRepository,
        kind: "repository",
      },
    }),
  );
  const misplacedPath = path.join(
    root,
    actionEventSpoolRelativePath(secondRepository, event.event.event_id),
  );

  assert.notEqual(
    path.dirname(actionEventSpoolRelativePath(firstRepository, event.event.event_id)),
    path.dirname(actionEventSpoolRelativePath(secondRepository, event.event.event_id)),
  );
  fs.mkdirSync(path.dirname(misplacedPath), { recursive: true });
  fs.copyFileSync(event.path, misplacedPath);
  assert.throws(() => readSpooledActionEvents(root, secondRepository), /spool repository mismatch/);
  assert.throws(() => readAllSpooledActionEvents(root), /spool path is not canonical/);
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
  assert.notEqual(
    actionIdempotencyKey(JSON.parse('{"__proto__":"bound"}')),
    actionIdempotencyKey({}),
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
    Number.MAX_SAFE_INTEGER + 1,
    Number.MAX_SAFE_INTEGER + 2,
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
  for (const identity of [
    { token: "opaque" },
    { api_key: "opaque" },
    { clientSecret: "opaque" },
    { authToken: "opaque" },
    { authorizationHeader: "opaque" },
    { bearerToken: "opaque" },
    { githubToken: "opaque" },
    { refresh_token: "opaque" },
    { secretAccessToken: "opaque" },
    { cloudflareApiToken: "opaque" },
  ]) {
    assert.throws(
      () => actionIdempotencyKey(identity),
      /identity contains a high-risk credential field/,
    );
  }
  assert.match(
    actionIdempotencyKey({ runId: String(Number.MAX_SAFE_INTEGER + 2) }),
    /^[a-f0-9]{64}$/,
  );
  assert.throws(
    () => actionIdempotencyKey({ ["\ud800"]: "unsupported" }),
    /unsupported object key/,
  );
  assert.throws(() => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    actionEventKey("review.completed", cycle);
  }, /contains a cycle/);
});

test("canonical identity hashing rejects excessive depth, nodes, and input size deterministically", () => {
  let deep: unknown = "leaf";
  for (let depth = 0; depth <= ACTION_LEDGER_CANONICAL_JSON_LIMITS.maxDepth; depth += 1) {
    deep = { child: deep };
  }
  assert.throws(
    () => actionIdempotencyKey(deep),
    new RegExp(`canonical JSON depth limit ${ACTION_LEDGER_CANONICAL_JSON_LIMITS.maxDepth}`),
  );

  assert.throws(
    () =>
      actionIdempotencyKey(
        Array.from({ length: ACTION_LEDGER_CANONICAL_JSON_LIMITS.maxNodes }, (_, index) => index),
      ),
    new RegExp(`canonical JSON node limit ${ACTION_LEDGER_CANONICAL_JSON_LIMITS.maxNodes}`),
  );

  assert.throws(
    () =>
      actionIdempotencyKey({
        value: "x".repeat(ACTION_LEDGER_CANONICAL_JSON_LIMITS.maxBytes),
      }),
    new RegExp(`canonical JSON size limit ${ACTION_LEDGER_CANONICAL_JSON_LIMITS.maxBytes} bytes`),
  );
  assert.throws(
    () =>
      actionIdempotencyKey({
        value: "\u0001".repeat(Math.floor(ACTION_LEDGER_CANONICAL_JSON_LIMITS.maxBytes / 6) + 1),
      }),
    new RegExp(`canonical JSON size limit ${ACTION_LEDGER_CANONICAL_JSON_LIMITS.maxBytes} bytes`),
  );
});

test("ledger ordering is binary and locale independent without changing shared stable JSON", () => {
  const sharedValue = { "\u00e4": 1, z: 2 };
  const sharedExpected = JSON.stringify(
    Object.fromEntries(
      Object.entries(sharedValue).sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
  assert.equal(stableJson(sharedValue), sharedExpected);
  assert.equal(
    actionLedgerJson({ "2": "two", "10": "ten", "\u00e4": 1, z: 2 }),
    '{"10":"ten","2":"two","z":2,"\u00e4":1}',
  );
  const event = createActionEvent(
    reviewInput({
      evidence: [
        { kind: "report", reportPath: "records/a.md" },
        { kind: "report", reportPath: "records/Z.md" },
      ],
    }),
  );
  assert.deepEqual(
    event.evidence?.map((entry) => entry.report_path),
    ["records/Z.md", "records/a.md"],
  );
  const moduleUrl = pathToFileURL(path.join(process.cwd(), "dist", "action-ledger.js")).href;
  const script = `import { actionLedgerJson } from ${JSON.stringify(moduleUrl)};
process.stdout.write(actionLedgerJson({ "2": "two", "10": "ten", "\\u00e4": 1, z: 2 }));`;
  const outputs = ["en_US.UTF-8", "sv_SE.UTF-8"].map((locale) => {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, LANG: locale, LC_ALL: locale },
    });
    assert.equal(child.status, 0, child.stderr);
    return child.stdout;
  });
  assert.deepEqual(outputs, [
    '{"10":"ten","2":"two","z":2,"\u00e4":1}',
    '{"10":"ten","2":"two","z":2,"\u00e4":1}',
  ]);
});

test("every event persists the required correlation envelope", () => {
  const event = createActionEvent(reviewInput());
  assert.equal(event.operation_id, operationId);
  assert.equal(event.attempt_id, attemptId);
  assert.equal(event.parent_event_id, null);
  assert.equal(event.phase_seq, 2);
  assert.match(event.idempotency_key_sha256, /^[a-f0-9]{64}$/);
  assert.equal(event.occurred_at_source, "source");
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
  const event = createActionEvent(input);
  assert.throws(
    () => validateActionEvent({ ...event, parent_event_id: event.event_id }),
    /cannot reference itself/,
  );
});

test("event creation rejects noncanonical writer timestamps before persistence", () => {
  for (const year of [0, 10_000]) {
    const now = new Date(0);
    now.setUTCFullYear(year, 0, 1);
    const root = tempRoot();
    assert.throws(
      () => writeActionEvent(root, reviewInput(), { now: () => now }),
      /action event recorded_at must be an ISO date-time timestamp/,
    );
    assert.deepEqual(fs.readdirSync(root), []);
  }
});

test("runtime and schema require the same canonical timestamp syntax", () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "schema", "state-ledger-event.schema.json"), "utf8"),
  ) as TestJsonSchema;
  const timestampSchema = (schema.properties as Record<string, TestJsonSchema>).occurred_at!;
  for (const timestamp of [
    "0001-01-01T00:00:00Z",
    "0004-02-29T00:00:00Z",
    "2024-02-29T10:00:00Z",
    "2026-07-12T10:00:00Z",
    "2026-07-12T10:00:00.123456789+02:30",
  ]) {
    assert.equal(schemaNodeAccepts(schema, timestampSchema, timestamp), true, timestamp);
    assert.doesNotThrow(() => createActionEvent(reviewInput({ occurredAt: timestamp })));
  }
  for (const timestamp of [
    "2026-07-12t10:00:00z",
    "0000-01-01T00:00:00Z",
    "1900-02-29T10:00:00Z",
    "2026-02-29T10:00:00Z",
    "2026-02-30T10:00:00Z",
    "2026-04-31T10:00:00Z",
    "2026-13-12T10:00:00Z",
    "2026-07-32T10:00:00Z",
    "2026-07-12T24:00:00Z",
    "2026-07-12T10:60:00Z",
    "2026-07-12T10:00:60Z",
    "2026-07-12T10:00:00+24:00",
    "2026-07-12T10:00:00+02:60",
    "2026-07-12 10:00:00Z",
  ]) {
    assert.equal(schemaNodeAccepts(schema, timestampSchema, timestamp), false, timestamp);
    assert.throws(
      () => createActionEvent(reviewInput({ occurredAt: timestamp })),
      /must be an ISO date-time timestamp/,
      timestamp,
    );
  }
});

test("runtime and schema require namespaced portable data paths", () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "schema", "state-ledger-event.schema.json"), "utf8"),
  ) as TestJsonSchema;
  const relativePathSchema = (schema.$defs as Record<string, TestJsonSchema>).relativePath!;
  assert.equal(relativePathSchema.pattern, ACTION_EVENT_RELATIVE_DATA_PATH_PATTERN_SOURCE);

  for (const reportPath of [
    ".artifacts/review-42.json",
    "artifacts/reviews/42.md",
    "jobs/repair_42/result.json",
    "ledger/v1/events/2026/07/12/events.jsonl",
    "logs/review/42.json",
    "notifications/github-activity-report.json",
    "records/openclaw-openclaw/items/42.md",
    "results/audit/latest.json",
  ]) {
    assert.equal(schemaNodeAccepts(schema, relativePathSchema, reportPath), true, reportPath);
    assert.doesNotThrow(() =>
      createActionEvent(reviewInput({ evidence: [{ kind: "report", reportPath }] })),
    );
  }

  for (const reportPath of [
    "review completed without findings",
    "misc/report.md",
    "records/review notes.md",
    "records/\u00e4.md",
    "records/.hidden",
    "records/items/",
    "records",
    "records/CON",
    "records/con.txt",
    "records/NUL.txt",
    "records/COM1",
    "records/LPT9.log",
    "records/item.",
  ]) {
    assert.equal(schemaNodeAccepts(schema, relativePathSchema, reportPath), false, reportPath);
    assert.throws(
      () => createActionEvent(reviewInput({ evidence: [{ kind: "report", reportPath }] })),
      /namespaced repository-relative data path/,
      reportPath,
    );
  }
});

test("action flags and supplied evidence values require exact types and bindings", () => {
  for (const action of [
    { ...reviewInput().action, retryable: "false" as never },
    { ...reviewInput().action, mutation: 1 as never },
  ]) {
    assert.throws(
      () => createActionEvent(reviewInput({ action })),
      /action event action (?:retryable|mutation) must be a boolean/,
    );
  }

  const valid = createActionEvent(reviewInput());
  assert.throws(
    () =>
      validateActionEvent({
        ...valid,
        action: { ...valid.action, retryable: "false" },
      }),
    /action event action retryable must be a boolean/,
  );

  for (const evidence of [
    { kind: "review", sha256: "" },
    { kind: "review", reportPath: "" },
    { kind: "review", runUrl: "" },
    { kind: "review", snapshotId: "" },
  ]) {
    assert.throws(
      () => createActionEvent(reviewInput({ evidence: [evidence] })),
      /required|SHA-256|repository-relative|HTTPS URL/,
    );
  }
});

test("event-key scopes reject raw identities and confidential identifiers", () => {
  assert.throws(
    () =>
      createActionEvent(
        reviewInput({
          eventKey: "review.completed:openclaw/openclaw:42:private-value",
        }),
      ),
    /must be generated/,
  );

  const schema = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "schema", "state-ledger-event.schema.json"), "utf8"),
  ) as TestJsonSchema;
  const eventKeySchema = (schema.$defs as Record<string, TestJsonSchema>).eventKey!;
  const safeKey = actionEventKey("review.completed", { number: 42 });
  assert.equal(schemaNodeAccepts(schema, eventKeySchema, safeKey), true);

  for (const scope of [
    `ghp_${"A".repeat(20)}`,
    `Bearer-${"A".repeat(20)}`,
    `Bearer+${"A".repeat(20)}`,
    "Basic+YTpi",
    "Basic+dXNlcjpwYXNz",
    "service.internal",
  ]) {
    const forgedKey = `${scope}:${"a".repeat(64)}`;
    assert.throws(() => actionEventKey(scope, { number: 42 }), /confidential identifier/, scope);
    assert.throws(
      () => actionEventId("openclaw/openclaw", forgedKey),
      /confidential identifier/,
      scope,
    );
    assert.throws(
      () => createActionEvent(reviewInput({ eventKey: forgedKey })),
      /confidential identifier/,
      scope,
    );
    assert.equal(schemaNodeAccepts(schema, eventKeySchema, forgedKey), false, scope);
  }
});

test("event readers reject forged confidential event-key scopes", () => {
  const root = tempRoot();
  const valid = createActionEvent(reviewInput());
  const forgedKey = `ghp_${"A".repeat(20)}:${valid.event_key.split(":")[1]}`;
  const forgedId = createHash("sha256")
    .update(`${valid.subject.repository}\n${forgedKey}`)
    .digest("hex");
  const forged = {
    ...valid,
    event_id: forgedId,
    event_key: forgedKey,
  };
  const relativePath = actionEventSpoolRelativePath(valid.subject.repository, forgedId);
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${actionLedgerJson(forged)}\n`, "utf8");

  assert.throws(
    () => readSpooledActionEvents(root, valid.subject.repository),
    /confidential identifier/,
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
  assert.equal(schema.properties.occurred_at.pattern, ACTION_EVENT_TIMESTAMP_PATTERN_SOURCE);
  assert.equal(schema.properties.recorded_at.pattern, ACTION_EVENT_TIMESTAMP_PATTERN_SOURCE);
  const confidentialEntries = schema.$defs.confidentialIdentifier.anyOf as Array<{
    pattern?: string;
  }>;
  assert.deepEqual(
    confidentialEntries.flatMap((entry) => (entry.pattern ? [entry.pattern] : [])),
    [...ACTION_EVENT_CONFIDENTIAL_IDENTIFIER_PATTERN_SOURCES],
  );
});

test("runtime and schema apply the same machine-text privacy boundary", () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "schema", "state-ledger-event.schema.json"), "utf8"),
  ) as TestJsonSchema;
  const valid = createActionEvent(reviewInput());
  const schemaAllows = (value: string): boolean => {
    const candidate = structuredClone(valid) as unknown as Record<string, unknown>;
    (candidate.action as Record<string, unknown>).status = value;
    return schemaAccepts(schema, candidate);
  };
  const samples = [
    "review.completed",
    "claude-3.5",
    "github.com/openclaw",
    `ghs_${"A".repeat(30)}`,
    `ghu_${"A".repeat(30)}`,
    `gho_${"A".repeat(30)}`,
    `ghr_${"A".repeat(30)}`,
    `github_pat_${"A".repeat(24)}`,
    `npm_${"A".repeat(36)}`,
    `xoxb-${"A".repeat(24)}`,
    `xoxp-${"A".repeat(24)}`,
    `AKIA${"A".repeat(16)}`,
    `ASIA${"A".repeat(16)}`,
    `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${"A".repeat(32)}`,
    `Bearer:${"A".repeat(32)}`,
    `Bearer+${"A".repeat(32)}`,
    `bEaReR+${"A".repeat(32)}`,
    "Basic:dXNlcjpwYXNz",
    "Basic+YTpi",
    "Basic+dXNlcjpwYXNz",
    "bAsIc+dXNlcjpwYXNz",
    "alice%40example.com",
    "alice@corp",
    "%2FUsers%2Falice%2Fsecret",
    "https%3A%2F%2Fservice.internal%2Fapi",
    `api_key:${"A".repeat(32)}`,
    `cloudflare_api_token:${"A".repeat(32)}`,
    `fc00::1`,
    "0:0:0:0:0:0:0:1",
    "::ffff:7f00:1",
    "::ffff:c0a8:1",
    "0:0::ffff:c0a8:1",
    "0::c0a8:1",
    "status:0:0::ffff:c0a8:1",
    "status:0::c0a8:1",
    "0:0:0:0:0:ffff:a00:1",
    "0:0:0:0:0:ffff:7f00:1",
    "0:0:0:0:0:ffff:a9fe:1",
    "0:0:0:0:0:ffff:ac10:1",
    "0:0:0:0:0:ffff:c0a8:1",
    "0:0:0:0:0:0:c0a8:1",
    "service.internal",
    "service.internal.",
    "service.internal..",
    "SERVICE.INTERNAL",
    "LOCALHOST:443",
    "user@LOCALHOST",
    "file:/etc/passwd",
    "file:etc/passwd",
    "FILE:etc/passwd",
    "https://user@host/path",
    "https:user@host/path",
    "HTTPS:user@host/path",
    "internal.example.com",
    "https://host.docker.internal/api",
    "https://service.internal.././api",
    "https://10.0.0.1/api",
    "runner:/etc/openclaw/config",
    "runner:C:/build/worktree",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://0x7f.1/",
    "http://0x64.0x40.1.1/",
    "http://0x8.8.8.8/",
    "http://017700000001/",
    "010.0.0.1",
    "http://010.0.0.1/",
    "http://127.1/",
    "http://127.0.1/",
    "http://10.1/",
    "http://192.168.1/",
    "host-10.0.0.1",
    "0:0::1",
    "0:0::ffff:808:808",
    "0::808:808",
    "2001:4860:4860::8888",
    "status:0:0::ffff:808:808",
    "status:2001:4860:4860::8888",
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

test("privacy normalization preserves public machine identifiers", () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "schema", "state-ledger-event.schema.json"), "utf8"),
  ) as TestJsonSchema;
  for (const status of [
    "basic-authentication",
    "basic+authentication",
    "bearer+status",
    "localhost-check",
    "user-at-localhost",
    "file-cache",
    "file+cache",
    "public.example",
    "public.example..",
    "https://public.example/./api",
    "runner:relative/path",
    "http://126.1/",
    "http://192.167.1/",
    "8.0.0.1",
    "http://8.0.0.1/",
    "0:0:0:0:0:ffff:808:808",
    "0:0:0:0:0:ffff:ac20:1",
    "0:0::ffff:808:808",
    "0::808:808",
    "2001:4860:4860::8888",
    "status:0:0::ffff:808:808",
    "status:2001:4860:4860::8888",
    "https://github.com/openclaw/clawsweeper/actions/runs/100",
  ]) {
    const event = createActionEvent(
      reviewInput({
        action: {
          name: "review",
          status,
          retryable: false,
          mutation: false,
        },
      }),
    );
    assert.equal(event.action.status, status);
    assert.equal(schemaAccepts(schema, event), true, status);
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

test("ledger writes require pre-existing canonical trusted roots", () => {
  const parent = tempRoot();
  const missingRoot = path.join(parent, "missing");
  assert.throws(() => writeActionEvent(missingRoot, reviewInput()), /missing action event root/);
  assert.equal(fs.existsSync(missingRoot), false);

  const noncanonicalRoot = `${parent}${path.sep}child${path.sep}..`;
  assert.throws(
    () => writeActionEvent(noncanonicalRoot, reviewInput()),
    /noncanonical action event root/,
  );

  const actualParent = path.join(parent, "actual-parent");
  const actualRoot = path.join(actualParent, "ledger");
  fs.mkdirSync(actualRoot, { recursive: true });
  const linkedParent = path.join(parent, "linked-parent");
  createDirectoryLink(actualParent, linkedParent);
  assert.throws(
    () => writeActionEvent(path.join(linkedParent, "ledger"), reviewInput()),
    /link-resolved action event root/,
  );
  assert.deepEqual(fs.readdirSync(actualRoot), []);
});

test("exclusive file locks contend, roll back failed creation, and tolerate disappearance", () => {
  const root = tempRoot();
  const target = prepareSafeWriteTarget(root, "locks/producer.lock", "test producer");
  const firstContent = "first-owner\n";
  const releaseFirst = tryAcquireUtf8FileLockNoFollow(target, firstContent);
  assert.ok(releaseFirst);
  assert.equal(tryAcquireUtf8FileLockNoFollow(target, "second-owner\n"), null);
  releaseFirst();

  const originalWriteFileSync = fs.writeFileSync;
  let injected = false;
  fs.writeFileSync = ((file, data, options) => {
    originalWriteFileSync(file, data, options as never);
    if (!injected && typeof file === "number") {
      injected = true;
      assert.equal(fs.existsSync(target.path), false);
      throw new Error("injected lock write failure");
    }
  }) as typeof fs.writeFileSync;
  try {
    assert.throws(
      () => tryAcquireUtf8FileLockNoFollow(target, "failed-owner\n"),
      /injected lock write failure/,
    );
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }
  assert.equal(injected, true);
  assert.equal(fs.existsSync(target.path), false);
  assert.deepEqual(fs.readdirSync(path.dirname(target.path)), []);

  const originalFsyncSync = fs.fsyncSync;
  let fsyncCalls = 0;
  fs.fsyncSync = ((descriptor) => {
    fsyncCalls += 1;
    if (fsyncCalls === 2) throw new Error("injected published lock failure");
    return originalFsyncSync(descriptor);
  }) as typeof fs.fsyncSync;
  try {
    assert.throws(
      () => tryAcquireUtf8FileLockNoFollow(target, "published-failure\n"),
      /injected published lock failure/,
    );
  } finally {
    fs.fsyncSync = originalFsyncSync;
  }
  assert.equal(fsyncCalls >= 2, true);
  assert.equal(fs.existsSync(target.path), false);
  assert.deepEqual(fs.readdirSync(path.dirname(target.path)), []);

  const disappearingContent = "disappearing-owner\n";
  const releaseDisappearing = tryAcquireUtf8FileLockNoFollow(target, disappearingContent);
  assert.ok(releaseDisappearing);
  const originalOpenSync = fs.openSync;
  let disappeared = false;
  fs.openSync = ((filePath, flags, mode) => {
    if (!disappeared && filePath === target.path) {
      disappeared = true;
      fs.unlinkSync(target.path);
    }
    return originalOpenSync(filePath, flags, mode);
  }) as typeof fs.openSync;
  try {
    assert.equal(removeUtf8FileIfContentNoFollow(target, disappearingContent), false);
  } finally {
    fs.openSync = originalOpenSync;
  }
  assert.equal(disappeared, true);
  assert.doesNotThrow(releaseDisappearing);

  const replacedContent = "replaced-owner\n";
  const releaseReplaced = tryAcquireUtf8FileLockNoFollow(target, replacedContent);
  assert.ok(releaseReplaced);
  const originalCloseSync = fs.closeSync;
  let replaced = false;
  fs.closeSync = ((descriptor) => {
    originalCloseSync(descriptor);
    if (!replaced) {
      replaced = true;
      if (fs.existsSync(target.path)) fs.unlinkSync(target.path);
      fs.writeFileSync(target.path, replacedContent);
    }
  }) as typeof fs.closeSync;
  try {
    assert.equal(removeUtf8FileIfContentNoFollow(target, replacedContent), false);
  } finally {
    fs.closeSync = originalCloseSync;
  }
  assert.equal(replaced, true);
  assert.doesNotThrow(releaseReplaced);
  assert.equal(removeUtf8FileIfContentNoFollow(target, replacedContent), true);

  const staleContent = "stale-owner\n";
  const successorContent = "successor-owner\n";
  const releaseStale = tryAcquireUtf8FileLockNoFollow(target, staleContent);
  assert.ok(releaseStale);
  const originalRenameSync = fs.renameSync;
  let releaseSuccessor: (() => void) | null = null;
  let successorRaced = false;
  fs.renameSync = ((oldPath, newPath) => {
    if (!successorRaced && oldPath === target.path) {
      successorRaced = true;
      fs.unlinkSync(target.path);
      releaseSuccessor = tryAcquireUtf8FileLockNoFollow(target, successorContent);
      assert.ok(releaseSuccessor);
    }
    return originalRenameSync(oldPath, newPath);
  }) as typeof fs.renameSync;
  try {
    assert.equal(removeUtf8FileIfContentNoFollow(target, staleContent), false);
  } finally {
    fs.renameSync = originalRenameSync;
  }
  assert.equal(successorRaced, true);
  assert.equal(fs.readFileSync(target.path, "utf8"), successorContent);
  assert.doesNotThrow(releaseStale);
  assert.ok(releaseSuccessor);
  releaseSuccessor();

  const releaseFinal = tryAcquireUtf8FileLockNoFollow(target, "final-owner\n");
  assert.ok(releaseFinal);
  releaseFinal();
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

test(
  "parent-chain checks detect a swap during open as defense in depth",
  {
    skip:
      process.platform === "win32"
        ? "requires POSIX directory rename and symlink semantics"
        : false,
  },
  () => {
    const root = tempRoot();
    const outside = tempRoot();
    const event = createActionEvent(reviewInput());
    const relativePath = actionEventSpoolRelativePath(event.subject.repository, event.event_id);
    const eventParent = path.dirname(path.join(root, relativePath));
    const savedParent = `${eventParent}.saved`;
    const originalOpenSync = fs.openSync;
    let swapped = false;

    fs.openSync = ((filePath, flags, mode) => {
      if (
        !swapped &&
        typeof filePath === "string" &&
        path.dirname(filePath) === eventParent &&
        filePath.endsWith(".tmp")
      ) {
        swapped = true;
        fs.renameSync(eventParent, savedParent);
        createDirectoryLink(outside, eventParent);
        try {
          return originalOpenSync(filePath, flags, mode);
        } finally {
          fs.unlinkSync(eventParent);
          fs.renameSync(savedParent, eventParent);
        }
      }
      return originalOpenSync(filePath, flags, mode);
    }) as typeof fs.openSync;
    try {
      assert.throws(
        () => writeActionEvent(root, reviewInput()),
        /missing action event|changed action event/,
      );
    } finally {
      fs.openSync = originalOpenSync;
    }

    assert.equal(swapped, true);
    assert.equal(fs.existsSync(path.join(root, relativePath)), false);
    fs.rmSync(outside, { recursive: true, force: true });
  },
);

test("successful and race-loser publications remove staging aliases", () => {
  const root = tempRoot();
  const created = writeActionEvent(root, reviewInput());
  assert.equal(created.status, "created");
  assert.deepEqual(
    fs.readdirSync(path.dirname(created.path)).filter((entry) => entry.endsWith(".tmp")),
    [],
  );

  fs.rmSync(created.path);
  const originalLinkSync = fs.linkSync;
  let raced = false;
  fs.linkSync = ((source, destination) => {
    if (!raced) {
      raced = true;
      originalLinkSync(source, destination);
    }
    return originalLinkSync(source, destination);
  }) as typeof fs.linkSync;
  try {
    assert.equal(writeActionEvent(root, reviewInput()).status, "unchanged");
  } finally {
    fs.linkSync = originalLinkSync;
  }
  assert.equal(raced, true);
  assert.deepEqual(
    fs.readdirSync(path.dirname(created.path)).filter((entry) => entry.endsWith(".tmp")),
    [],
  );
});

test(
  "staging cleanup checks detect a replaced parent as defense in depth",
  {
    skip:
      process.platform === "win32"
        ? "requires POSIX directory rename and symlink semantics"
        : false,
  },
  () => {
    const root = tempRoot();
    const outside = tempRoot();
    const event = createActionEvent(reviewInput());
    const relativePath = actionEventSpoolRelativePath(event.subject.repository, event.event_id);
    const eventParent = path.dirname(path.join(root, relativePath));
    const savedParent = `${eventParent}.saved`;
    const originalLinkSync = fs.linkSync;
    let swapped = false;

    fs.linkSync = ((source, destination) => {
      originalLinkSync(source, destination);
      if (!swapped) {
        swapped = true;
        fs.renameSync(eventParent, savedParent);
        createDirectoryLink(outside, eventParent);
      }
    }) as typeof fs.linkSync;
    try {
      assert.throws(
        () => writeActionEvent(root, reviewInput()),
        /symbolic link or junction|changed/,
      );
    } finally {
      fs.linkSync = originalLinkSync;
      if (fs.lstatSync(eventParent).isSymbolicLink()) fs.unlinkSync(eventParent);
      if (fs.existsSync(savedParent)) fs.renameSync(savedParent, eventParent);
    }

    assert.equal(swapped, true);
    assert.ok(fs.readdirSync(eventParent).some((entry) => entry.endsWith(".tmp")));
  },
);

test(
  "event read checks detect a parent swap as defense in depth",
  {
    skip:
      process.platform === "win32"
        ? "requires POSIX directory rename and symlink semantics"
        : false,
  },
  () => {
    const root = tempRoot();
    const outside = tempRoot();
    const written = writeActionEvent(root, reviewInput());
    const eventParent = path.dirname(written.path);
    const savedParent = `${eventParent}.saved`;
    fs.writeFileSync(
      path.join(outside, path.basename(written.path)),
      fs.readFileSync(written.path),
    );
    const originalOpenSync = fs.openSync;
    let swapped = false;

    fs.openSync = ((filePath, flags, mode) => {
      if (!swapped && filePath === written.path) {
        swapped = true;
        fs.renameSync(eventParent, savedParent);
        createDirectoryLink(outside, eventParent);
        try {
          return originalOpenSync(filePath, flags, mode);
        } finally {
          fs.unlinkSync(eventParent);
          fs.renameSync(savedParent, eventParent);
        }
      }
      return originalOpenSync(filePath, flags, mode);
    }) as typeof fs.openSync;
    try {
      assert.throws(
        () => readSpooledActionEvents(root, "openclaw/openclaw"),
        /changed action event spool entry file/,
      );
    } finally {
      fs.openSync = originalOpenSync;
    }
    assert.equal(swapped, true);
  },
);

test(
  "event reads cannot block when a validated file is swapped to a FIFO",
  {
    skip: process.platform === "win32" ? "requires POSIX FIFO semantics" : false,
  },
  () => {
    const root = tempRoot();
    const written = writeActionEvent(root, reviewInput());
    const saved = `${written.path}.saved`;
    const originalOpenSync = fs.openSync;
    let swapped = false;

    fs.openSync = ((filePath, flags, mode) => {
      if (!swapped && filePath === written.path) {
        swapped = true;
        assert.notEqual(Number(flags) & (fs.constants.O_NONBLOCK ?? 0), 0);
        fs.renameSync(written.path, saved);
        const fifo = spawnSync("/usr/bin/mkfifo", [written.path], { encoding: "utf8" });
        assert.equal(fifo.status, 0, fifo.stderr);
      }
      return originalOpenSync(filePath, flags, mode);
    }) as typeof fs.openSync;
    try {
      assert.throws(() => readSpooledActionEvents(root, "openclaw/openclaw"), /refusing non-file/);
    } finally {
      fs.openSync = originalOpenSync;
      if (fs.existsSync(written.path)) fs.rmSync(written.path);
      if (fs.existsSync(saved)) fs.renameSync(saved, written.path);
    }
    assert.equal(swapped, true);
  },
);

test("spool readers reject unsafe entry types instead of skipping them", () => {
  const root = tempRoot();
  const written = writeActionEvent(root, reviewInput());
  fs.mkdirSync(path.join(path.dirname(written.path), "poison.json"));
  assert.throws(
    () => readSpooledActionEvents(root, "openclaw/openclaw"),
    /refusing unsafe action event spool entry/,
  );

  fs.rmSync(path.join(path.dirname(written.path), "poison.json"), { recursive: true });
  fs.writeFileSync(path.join(root, ".clawsweeper-repair", "action-events", "poison"), "data");
  assert.throws(() => readAllSpooledActionEvents(root), /refusing unsafe action event spool entry/);
});

test("spool readers bound repository and per-repository fanout before sorting", () => {
  const repositoryRoot = tempRoot();
  const actionRoot = path.join(repositoryRoot, ".clawsweeper-repair", "action-events");
  fs.mkdirSync(actionRoot, { recursive: true });
  for (let index = 0; index <= ACTION_EVENT_SPOOL_READ_LIMITS.maxRepositories; index += 1) {
    fs.mkdirSync(path.join(actionRoot, `repository-${index}`));
  }
  assert.throws(
    () => readAllSpooledActionEvents(repositoryRoot),
    new RegExp(`${ACTION_EVENT_SPOOL_READ_LIMITS.maxRepositories} repository limit`),
  );

  const entryRoot = tempRoot();
  const written = writeActionEvent(entryRoot, reviewInput());
  for (let index = 0; index < ACTION_EVENT_SPOOL_READ_LIMITS.maxEntriesPerRepository; index += 1) {
    fs.writeFileSync(path.join(path.dirname(written.path), `ignored-${index}.tmp`), "");
  }
  assert.throws(
    () => readAllSpooledActionEvents(entryRoot),
    new RegExp(`${ACTION_EVENT_SPOOL_READ_LIMITS.maxEntriesPerRepository} entry limit`),
  );
});

test("spool readers enforce aggregate byte budgets before retaining another event", () => {
  const root = tempRoot();
  const machineValues = Array.from(
    { length: 64 },
    (_, index) => `value_${index}_${"x".repeat(238)}`,
  );
  const machineAttributeKeys = [
    "cache_mode",
    "completion_reason",
    "delivery_kind",
    "dispatch_kind",
    "log_kind",
    "model",
    "phase",
    "publication_kind",
    "queue_kind",
    "query_version",
    "reasoning_effort",
    "review_mode",
    "state",
    "status_kind",
    "validation_kind",
    "work_kind",
    "workflow_phase",
  ];
  const attributes = Object.fromEntries(
    machineAttributeKeys.map((key) => [key, machineValues]),
  ) as ActionEventInput["attributes"];
  const evidence = Array.from({ length: 64 }, (_, index) => ({
    kind: `report_${index}`,
    sha256: createHash("sha256").update(String(index)).digest("hex"),
    reportPath: `artifacts/reviews/${"x".repeat(238)}_${index}.json`,
    snapshotId: `snapshot_${index}_${"x".repeat(240)}`,
  }));
  const privacy = {
    classification: "internal" as const,
    redactionVersion: "v1",
    fieldsDropped: Array.from({ length: 64 }, (_, index) => `field_${index}_${"x".repeat(240)}`),
  };
  const sample = createActionEvent(reviewInput({ attributes, evidence, privacy }));
  const eventBytes = Buffer.byteLength(`${actionLedgerJson(sample)}\n`, "utf8");
  const mutableLimits = ACTION_EVENT_SPOOL_READ_LIMITS as { maxTotalBytes: number };
  const configuredLimit = eventBytes * 2;
  const originalLimit = mutableLimits.maxTotalBytes;
  mutableLimits.maxTotalBytes = configuredLimit;
  try {
    for (let index = 0; index < 3; index += 1) {
      writeActionEvent(
        root,
        reviewInput({
          eventKey: reviewEventKey("review.aggregate-budget", { index }),
          attributes,
          evidence,
          privacy,
        }),
      );
    }
    assert.throws(
      () => readAllSpooledActionEvents(root),
      new RegExp(`${configuredLimit} total byte limit`),
    );
  } finally {
    mutableLimits.maxTotalBytes = originalLimit;
  }
});

test("event readers reject duplicate keys and noncanonical durable JSON bytes", () => {
  const root = tempRoot();
  const written = writeActionEvent(root, reviewInput());
  const canonical = fs.readFileSync(written.path, "utf8");
  const concealed = `npm_${"A".repeat(36)}`;
  for (const duplicateKey of ["event_type", "event_\\u0074ype"]) {
    fs.writeFileSync(
      written.path,
      canonical.replace(
        `"event_type":"${ACTION_EVENT_TYPES.reviewCompleted}"`,
        `"event_type":"${concealed}","${duplicateKey}":"${ACTION_EVENT_TYPES.reviewCompleted}"`,
      ),
    );

    assert.match(fs.readFileSync(written.path, "utf8"), new RegExp(concealed));
    assert.throws(
      () => readSpooledActionEvents(root, "openclaw/openclaw"),
      /action event JSON contains a duplicate object key/,
    );
  }

  fs.writeFileSync(written.path, canonical.replace('{"action":', '{ "action":'));
  assert.throws(
    () => readSpooledActionEvents(root, "openclaw/openclaw"),
    /action event JSON is not canonical/,
  );
});

test("direct event and shard reads enforce bounded allocation", () => {
  const root = tempRoot();
  const eventPath = path.join(root, "event.json");
  const shardPath = path.join(root, "events.jsonl");
  fs.writeFileSync(eventPath, Buffer.alloc(ACTION_LEDGER_CANONICAL_JSON_LIMITS.maxBytes + 1, 0x61));
  fs.writeFileSync(shardPath, Buffer.alloc(ACTION_EVENT_SHARD_FILE_LIMITS.maxBytes + 1, 0x61));

  assert.throws(
    () => readActionEvent(eventPath),
    new RegExp(`${ACTION_LEDGER_CANONICAL_JSON_LIMITS.maxBytes} byte limit`),
  );
  assert.throws(
    () => readActionEventShard(shardPath),
    new RegExp(`${ACTION_EVENT_SHARD_FILE_LIMITS.maxBytes} byte limit`),
  );
});

test("shard writers bound existing and raced destination reads", () => {
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
  const event = createActionEvent(reviewInput());
  const relativePath = actionEventShardRelativePath(identity, [event], 1, 1);

  const existingRoot = tempRoot();
  const existingPath = path.join(existingRoot, relativePath);
  fs.mkdirSync(path.dirname(existingPath), { recursive: true });
  fs.writeFileSync(existingPath, Buffer.alloc(ACTION_EVENT_SHARD_FILE_LIMITS.maxBytes + 1, 0x61));
  assert.throws(
    () => writeActionEventShard(existingRoot, identity, [event], 1, 1),
    new RegExp(`${ACTION_EVENT_SHARD_FILE_LIMITS.maxBytes} byte limit`),
  );

  const racedRoot = tempRoot();
  const racedPath = path.join(racedRoot, relativePath);
  const originalLinkSync = fs.linkSync;
  let raced = false;
  fs.linkSync = ((source, destination) => {
    if (!raced && destination === racedPath) {
      raced = true;
      fs.writeFileSync(racedPath, Buffer.alloc(ACTION_EVENT_SHARD_FILE_LIMITS.maxBytes + 1, 0x62));
      const error = new Error("raced shard") as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    }
    return originalLinkSync(source, destination);
  }) as typeof fs.linkSync;
  try {
    assert.throws(
      () => writeActionEventShard(racedRoot, identity, [event], 1, 1),
      new RegExp(`${ACTION_EVENT_SHARD_FILE_LIMITS.maxBytes} byte limit`),
    );
  } finally {
    fs.linkSync = originalLinkSync;
  }
  assert.equal(raced, true);
});

test("direct shard readers enforce non-empty unique ordered acyclic collections and counts", () => {
  const root = tempRoot();
  const emptyPath = path.join(root, "empty.jsonl");
  fs.writeFileSync(emptyPath, "");
  assert.throws(() => readActionEventShard(emptyPath), /requires events/);

  const base = createActionEvent(reviewInput());
  const duplicatePath = path.join(root, "duplicate.jsonl");
  const baseLine = actionLedgerJson(base);
  fs.writeFileSync(duplicatePath, `${baseLine}\n${baseLine}\n`);
  assert.throws(() => readActionEventShard(duplicatePath), /duplicate event/);

  const earlier = createActionEvent(
    reviewInput({
      eventKey: reviewEventKey("review.earlier"),
      occurredAt: "2026-07-12T09:00:00Z",
    }),
  );
  const later = createActionEvent(
    reviewInput({
      eventKey: reviewEventKey("review.later"),
      occurredAt: "2026-07-12T10:00:00Z",
    }),
  );
  const unorderedPath = path.join(root, "unordered.jsonl");
  fs.writeFileSync(unorderedPath, `${actionLedgerJson(later)}\n${actionLedgerJson(earlier)}\n`);
  assert.throws(() => readActionEventShard(unorderedPath), /canonical causal order/);

  const firstKey = reviewEventKey("review.cycle", { node: "first" });
  const secondKey = reviewEventKey("review.cycle", { node: "second" });
  const first = createActionEvent(
    reviewInput({
      eventKey: firstKey,
      parentEventId: actionEventId("openclaw/openclaw", secondKey),
    }),
  );
  const second = createActionEvent(
    reviewInput({
      eventKey: secondKey,
      parentEventId: actionEventId("openclaw/openclaw", firstKey),
    }),
  );
  const cyclePath = path.join(root, "cycle.jsonl");
  fs.writeFileSync(cyclePath, `${actionLedgerJson(first)}\n${actionLedgerJson(second)}\n`);
  assert.throws(() => readActionEventShard(cyclePath), /causal cycle/);

  const excessivePath = path.join(root, "excessive.jsonl");
  fs.writeFileSync(
    excessivePath,
    `${Array.from({ length: ACTION_EVENT_SHARD_FILE_LIMITS.maxEvents + 1 }, () => baseLine).join(
      "\n",
    )}\n`,
  );
  assert.throws(
    () => readActionEventShard(excessivePath),
    new RegExp(`${ACTION_EVENT_SHARD_FILE_LIMITS.maxEvents} event limit`),
  );
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

test("durable shard writers split deterministically within importer event and byte limits", () => {
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
  const eventLimited = Array.from(
    { length: ACTION_EVENT_SHARD_FILE_LIMITS.maxEvents + 1 },
    (_, index) =>
      createActionEvent(
        reviewInput({
          eventKey: reviewEventKey("review.completed", { index }),
        }),
      ),
  );
  const eventRoot = tempRoot();
  const first = writeActionEventShards(eventRoot, identity, eventLimited);
  const replay = writeActionEventShards(eventRoot, identity, [...eventLimited].reverse());
  const imported = importActionEventShards(eventRoot, tempRoot());

  assert.deepEqual(
    first.map((result) => result.eventCount),
    [ACTION_EVENT_SHARD_FILE_LIMITS.maxEvents, 1],
  );
  assert.deepEqual(
    first.map((result) => path.basename(result.path)),
    first.map((_, index) =>
      path.basename(
        actionEventShardRelativePath(identity, [eventLimited[0]!], index + 1, first.length),
      ),
    ),
  );
  assert.deepEqual(
    replay.map((result) => result.status),
    ["unchanged", "unchanged"],
  );
  assert.equal(imported.created, 2);
  assert.deepEqual(imported.paths, first.map((result) => result.relativePath).sort());
  for (const result of first) {
    assert.ok(fs.statSync(result.path).size <= ACTION_EVENT_SHARD_FILE_LIMITS.maxBytes);
    assert.ok(result.eventCount <= ACTION_EVENT_SHARD_FILE_LIMITS.maxEvents);
  }
  assert.throws(
    () => writeActionEventShard(tempRoot(), identity, eventLimited),
    new RegExp(`${ACTION_EVENT_SHARD_FILE_LIMITS.maxEvents} raw event limit`),
  );
  const duplicateFlood = Array(ACTION_EVENT_SHARD_FILE_LIMITS.maxEvents + 1).fill(
    eventLimited[0]!,
  ) as ActionEvent[];
  assert.throws(
    () => actionEventShardRelativePath(identity, duplicateFlood),
    new RegExp(`${ACTION_EVENT_SHARD_FILE_LIMITS.maxEvents} raw event limit`),
  );
  assert.throws(
    () => writeActionEventShard(tempRoot(), identity, duplicateFlood),
    new RegExp(`${ACTION_EVENT_SHARD_FILE_LIMITS.maxEvents} raw event limit`),
  );
  assert.throws(
    () =>
      writeActionEventShards(
        tempRoot(),
        identity,
        Array(ACTION_EVENT_SHARD_SET_LIMITS.maxEvents + 1).fill(eventLimited[0]!) as ActionEvent[],
      ),
    new RegExp(`${ACTION_EVENT_SHARD_SET_LIMITS.maxEvents} raw event limit`),
  );

  const bulkyEvidence = Array.from({ length: 64 }, (_, index) => ({
    kind: `evidence_${index}`,
    snapshotId: `snapshot_${index}_${"x".repeat(220)}`,
  }));
  const byteLimited = [];
  let bytes = 0;
  for (let index = 0; bytes <= ACTION_EVENT_SHARD_FILE_LIMITS.maxBytes; index += 1) {
    const event = createActionEvent(
      reviewInput({
        eventKey: reviewEventKey("review.completed", { bulky: index }),
        evidence: bulkyEvidence,
      }),
    );
    byteLimited.push(event);
    bytes += Buffer.byteLength(`${actionLedgerJson(event)}\n`, "utf8");
  }
  assert.ok(byteLimited.length < ACTION_EVENT_SHARD_FILE_LIMITS.maxEvents);
  const byteResults = writeActionEventShards(tempRoot(), identity, byteLimited);
  assert.ok(byteResults.length > 1);
  assert.equal(
    byteResults.reduce((total, result) => total + result.eventCount, 0),
    byteLimited.length,
  );
  assert.ok(
    byteResults.every(
      (result) => fs.statSync(result.path).size <= ACTION_EVENT_SHARD_FILE_LIMITS.maxBytes,
    ),
  );
  assert.throws(
    () => writeActionEventShard(tempRoot(), identity, byteLimited),
    new RegExp(`${ACTION_EVENT_SHARD_FILE_LIMITS.maxBytes} byte limit`),
  );
  assert.throws(
    () => actionEventShardRelativePath(identity, [eventLimited[0]!], 1),
    /index and count must be provided together/,
  );
  assert.throws(
    () => actionEventShardRelativePath(identity, [eventLimited[0]!], 2, 1),
    /index cannot exceed shard count/,
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

test("durable shards preserve causal order ahead of source timestamps", () => {
  const root = tempRoot();
  const parent = createActionEvent(
    reviewInput({
      eventKey: reviewEventKey("review.started"),
      phaseSeq: 1,
      type: ACTION_EVENT_TYPES.reviewStarted,
      action: {
        name: "review",
        status: "started",
        retryable: true,
        mutation: false,
      },
      occurredAt: "2026-07-12T12:00:00.000Z",
    }),
  );
  const child = createActionEvent(
    reviewInput({
      parentEventId: parent.event_id,
      occurredAt: "2026-07-12T10:00:00.000Z",
    }),
  );
  const shard = writeActionEventShard(
    root,
    {
      repository: producer.repository,
      sha: producer.sha,
      producer: producer.component,
      workflow: producer.workflow,
      job: producer.job,
      runId: producer.runId,
      runAttempt: producer.runAttempt,
      partitionDate: "2026-07-12",
    },
    [child, parent],
  );

  const events = readActionEventShard(shard.path);
  assert.deepEqual(
    events.map((event) => event.event_id),
    [parent.event_id, child.event_id],
  );
  assert.deepEqual(
    events.map((event) => event.occurred_at),
    ["2026-07-12T12:00:00.000Z", "2026-07-12T10:00:00.000Z"],
  );
});

test("durable shards reject causal cycles", () => {
  const firstKey = reviewEventKey("review.started", { node: "first" });
  const secondKey = reviewEventKey("review.completed", { node: "second" });
  const firstId = actionEventId("openclaw/openclaw", firstKey);
  const secondId = actionEventId("openclaw/openclaw", secondKey);
  const first = createActionEvent(
    reviewInput({
      eventKey: firstKey,
      parentEventId: secondId,
      phaseSeq: 1,
      type: ACTION_EVENT_TYPES.reviewStarted,
      action: {
        name: "review",
        status: "started",
        retryable: true,
        mutation: false,
      },
    }),
  );
  const second = createActionEvent(
    reviewInput({
      eventKey: secondKey,
      parentEventId: firstId,
    }),
  );

  assert.throws(
    () =>
      writeActionEventShard(
        tempRoot(),
        {
          repository: producer.repository,
          sha: producer.sha,
          producer: producer.component,
          workflow: producer.workflow,
          job: producer.job,
          runId: producer.runId,
          runAttempt: producer.runAttempt,
          partitionDate: "2026-07-12",
        },
        [first, second],
      ),
    /causal cycle/,
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

test("shard path components stay below portable filesystem name limits", () => {
  const longProducer = {
    repository: producer.repository,
    sha: producer.sha,
    workflow: "w".repeat(128),
    job: "j".repeat(128),
    runId: "r".repeat(256),
    runAttempt: Number.MAX_SAFE_INTEGER,
    component: "p".repeat(256),
  };
  const event = createActionEvent(reviewInput({ producer: longProducer }));
  const identity = {
    repository: longProducer.repository,
    sha: longProducer.sha,
    producer: longProducer.component,
    workflow: longProducer.workflow,
    job: longProducer.job,
    runId: longProducer.runId,
    runAttempt: longProducer.runAttempt,
    partitionDate: "2026-07-12",
  };
  const written = writeActionEventShard(tempRoot(), identity, [event]);
  const components = written.relativePath.split("/");

  assert.ok(components.every((component) => Buffer.byteLength(component, "utf8") < 255));
  assert.ok(Buffer.byteLength(path.basename(written.path), "utf8") < 255);
  assert.equal(readActionEventShard(written.path).length, 1);
  assert.notEqual(
    written.relativePath,
    actionEventShardRelativePath({ ...identity, runId: `${"r".repeat(255)}x` }, [event]),
  );
});

test("shard path components encode Windows device names and trailing dots", () => {
  for (const component of ["CON", "AUX.txt", "NUL", "COM1", "LPT9", "producer."]) {
    const reservedProducer = { ...producer, component };
    const event = createActionEvent(reviewInput({ producer: reservedProducer }));
    const relativePath = actionEventShardRelativePath(
      {
        repository: reservedProducer.repository,
        sha: reservedProducer.sha,
        producer: reservedProducer.component,
        workflow: reservedProducer.workflow,
        job: reservedProducer.job,
        runId: reservedProducer.runId,
        runAttempt: reservedProducer.runAttempt,
        partitionDate: "2026-07-12",
      },
      [event],
    );
    const producerComponent = relativePath.split("/").at(-2)!;
    assert.doesNotMatch(
      producerComponent,
      /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i,
      component,
    );
    assert.equal(producerComponent.endsWith("."), false, component);
    assert.match(producerComponent, /-[a-f0-9]{12}$/, component);
  }
});

test("duplicate event IDs preserve recording metadata and reject changed source provenance", () => {
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
    /action event conflict/,
  );

  const replay = createActionEvent(reviewInput(), {
    now: () => new Date("2026-07-12T11:00:00.000Z"),
  });
  const root = tempRoot();
  const written = writeActionEventShard(root, identity, [first, replay]);
  const [persisted] = readActionEventShard(written.path);
  assert.equal(persisted?.recorded_at, first.recorded_at);
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
  const first = writeActionEvent(root, reviewInput({ occurredAt: undefined }), {
    now: () => new Date("2026-07-12T10:01:00.000Z"),
  });
  const replay = writeActionEvent(root, reviewInput({ occurredAt: undefined }), {
    now: () => new Date("2026-07-12T10:02:00.000Z"),
  });

  assert.equal(replay.status, "unchanged");
  assert.equal(first.event.occurred_at_source, "generated");
  assert.equal(replay.event.occurred_at_source, "generated");
  assert.equal(replay.event.semantic_sha256, first.event.semantic_sha256);
  assert.equal(replay.event.occurred_at, first.event.occurred_at);
  assert.equal(replay.event.recorded_at, first.event.recorded_at);
});

test("source occurrence provenance is bound into the semantic digest", () => {
  const source = createActionEvent(reviewInput(), {
    now: () => new Date("2026-07-12T10:01:00.000Z"),
  });
  const generated = createActionEvent(reviewInput({ occurredAt: undefined }), {
    now: () => new Date("2026-07-12T10:00:00.000Z"),
  });

  assert.equal(source.occurred_at, generated.occurred_at);
  assert.notEqual(source.occurred_at_source, generated.occurred_at_source);
  assert.notEqual(source.semantic_sha256, generated.semantic_sha256);
});

test("generated occurrence clocks cannot reverse deterministic shard ordering", () => {
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
  const inputA = reviewInput({
    eventKey: reviewEventKey("generated.a"),
    occurredAt: undefined,
  });
  const inputB = reviewInput({
    eventKey: reviewEventKey("generated.b"),
    occurredAt: undefined,
  });
  const firstEvents = [
    createActionEvent(inputA, { now: () => new Date("2026-07-12T11:00:00.000Z") }),
    createActionEvent(inputB, { now: () => new Date("2026-07-12T10:00:00.000Z") }),
  ];
  const replayEvents = [
    createActionEvent(inputA, { now: () => new Date("2026-07-12T09:00:00.000Z") }),
    createActionEvent(inputB, { now: () => new Date("2026-07-12T12:00:00.000Z") }),
  ];
  const root = tempRoot();
  const first = writeActionEventShard(root, identity, firstEvents);
  const replay = writeActionEventShard(root, identity, replayEvents);

  assert.equal(replay.status, "unchanged");
  assert.equal(replay.path, first.path);
  assert.deepEqual(
    readActionEventShard(first.path).map((event) => event.event_id),
    firstEvents.map((event) => event.event_id).sort(),
  );
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
    `xoxb-${"A".repeat(24)}`,
    `xoxp-${"A".repeat(24)}`,
    `AKIA${"A".repeat(16)}`,
    `ASIA${"A".repeat(16)}`,
    `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${"A".repeat(32)}`,
    `Bearer:${"A".repeat(32)}`,
    `bEaReR ${"A".repeat(32)}`,
    `Bearer%20${"A".repeat(32)}`,
    "Basic YTpi",
    `Basic ${Buffer.from("user:password").toString("base64")}`,
    `cloudflare_api_token:${"A".repeat(32)}`,
    "alice%40example.com",
    "alice@corp",
    "%2FUsers%2Falice%2Fsecret",
    "https%3A%2F%2Fservice.internal%2Fapi",
    "C:/build/runner/worktree",
    "runner:/etc/openclaw/config",
    "runner:C:/build/worktree",
    "service.internal",
    "service.internal.",
    "internal.example.com",
    "0:0:0:0:0:0:0:1",
    "status:0:0::ffff:c0a8:1",
    "status:0::c0a8:1",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://017700000001/",
    "010.0.0.1",
    "http://010.0.0.1/",
    "host-10.0.0.1",
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
    `records/Bearer ${"A".repeat(32)}.json`,
    "C:/USERS/Private/secret.txt",
    "records/C:/USERS/Private/secret.txt",
    "\\\\server\\share\\report.json",
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
      /repository-relative (?:data )?path|confidential identifier/,
    );
  }
});

test("checked-in schema rejects values rejected by runtime normalization", () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "schema", "state-ledger-event.schema.json"), "utf8"),
  ) as TestJsonSchema;
  const valid = createActionEvent(reviewInput());
  assert.equal(schemaAccepts(schema, valid), true);

  const cases: Array<{
    label: string;
    mutate: (event: Record<string, unknown>) => void;
    runtime: () => unknown;
  }> = [
    {
      label: "private IPv6",
      mutate: (event) => {
        (event.action as Record<string, unknown>).status = "fc00::1";
      },
      runtime: () =>
        createActionEvent(
          reviewInput({
            action: {
              name: "review",
              status: "fc00::1",
              retryable: false,
              mutation: false,
            },
          }),
        ),
    },
    {
      label: "dot-only relative path",
      mutate: (event) => {
        ((event.evidence as Array<Record<string, unknown>>)[0] as Record<string, unknown>)[
          "report_path"
        ] = "./";
      },
      runtime: () =>
        createActionEvent(reviewInput({ evidence: [{ kind: "review", reportPath: "./" }] })),
    },
    {
      label: "UNC relative path",
      mutate: (event) => {
        ((event.evidence as Array<Record<string, unknown>>)[0] as Record<string, unknown>)[
          "report_path"
        ] = "\\\\server\\share\\report.json";
      },
      runtime: () =>
        createActionEvent(
          reviewInput({
            evidence: [{ kind: "review", reportPath: "\\\\server\\share\\report.json" }],
          }),
        ),
    },
    {
      label: "uppercase Windows private path",
      mutate: (event) => {
        ((event.evidence as Array<Record<string, unknown>>)[0] as Record<string, unknown>)[
          "report_path"
        ] = "records/C:/USERS/Private/secret.txt";
      },
      runtime: () =>
        createActionEvent(
          reviewInput({
            evidence: [{ kind: "review", reportPath: "records/C:/USERS/Private/secret.txt" }],
          }),
        ),
    },
    {
      label: "percent-encoded private path",
      mutate: (event) => {
        ((event.evidence as Array<Record<string, unknown>>)[0] as Record<string, unknown>)[
          "report_path"
        ] = "records/%2FUsers%2Fexample%2Fsecret.txt";
      },
      runtime: () =>
        createActionEvent(
          reviewInput({
            evidence: [
              {
                kind: "review",
                reportPath: "records/%2FUsers%2Fexample%2Fsecret.txt",
              },
            ],
          }),
        ),
    },
    {
      label: "trailing-dot private host",
      mutate: (event) => {
        (event.action as Record<string, unknown>).status = "service.internal.";
      },
      runtime: () =>
        createActionEvent(
          reviewInput({
            action: {
              name: "review",
              status: "service.internal.",
              retryable: false,
              mutation: false,
            },
          }),
        ),
    },
    {
      label: "expanded IPv6 loopback",
      mutate: (event) => {
        (event.action as Record<string, unknown>).status = "0:0:0:0:0:0:0:1";
      },
      runtime: () =>
        createActionEvent(
          reviewInput({
            action: {
              name: "review",
              status: "0:0:0:0:0:0:0:1",
              retryable: false,
              mutation: false,
            },
          }),
        ),
    },
    {
      label: "expanded IPv4-mapped private IPv6",
      mutate: (event) => {
        (event.action as Record<string, unknown>).status = "0:0:0:0:0:ffff:c0a8:1";
      },
      runtime: () =>
        createActionEvent(
          reviewInput({
            action: {
              name: "review",
              status: "0:0:0:0:0:ffff:c0a8:1",
              retryable: false,
              mutation: false,
            },
          }),
        ),
    },
    {
      label: "expanded IPv4-mapped CGNAT IPv6",
      mutate: (event) => {
        (event.action as Record<string, unknown>).status = "0:0:0:0:0:ffff:6440:1";
      },
      runtime: () =>
        createActionEvent(
          reviewInput({
            action: {
              name: "review",
              status: "0:0:0:0:0:ffff:6440:1",
              retryable: false,
              mutation: false,
            },
          }),
        ),
    },
    {
      label: "embedded private IPv4",
      mutate: (event) => {
        (event.action as Record<string, unknown>).status = "host-10.0.0.1";
      },
      runtime: () =>
        createActionEvent(
          reviewInput({
            action: {
              name: "review",
              status: "host-10.0.0.1",
              retryable: false,
              mutation: false,
            },
          }),
        ),
    },
    {
      label: "CGNAT address",
      mutate: (event) => {
        (event.action as Record<string, unknown>).status = "100.100.100.100";
      },
      runtime: () =>
        createActionEvent(
          reviewInput({
            action: {
              name: "review",
              status: "100.100.100.100",
              retryable: false,
              mutation: false,
            },
          }),
        ),
    },
    {
      label: "URL userinfo",
      mutate: (event) => {
        ((event.evidence as Array<Record<string, unknown>>)[0] as Record<string, unknown>)[
          "run_url"
        ] = "https://user@github.com/openclaw/clawsweeper/actions/runs/100";
      },
      runtime: () =>
        createActionEvent(
          reviewInput({
            evidence: [
              {
                kind: "run",
                runUrl: "https://user@github.com/openclaw/clawsweeper/actions/runs/100",
              },
            ],
          }),
        ),
    },
    {
      label: "whitespace bearer credential",
      mutate: (event) => {
        ((event.evidence as Array<Record<string, unknown>>)[0] as Record<string, unknown>)[
          "report_path"
        ] = `records/Bearer ${"A".repeat(32)}.json`;
      },
      runtime: () =>
        createActionEvent(
          reviewInput({
            evidence: [{ kind: "review", reportPath: `records/Bearer ${"A".repeat(32)}.json` }],
          }),
        ),
    },
    {
      label: "unsafe integer",
      mutate: (event) => {
        event.phase_seq = Number.MAX_SAFE_INTEGER + 1;
      },
      runtime: () => createActionEvent(reviewInput({ phaseSeq: Number.MAX_SAFE_INTEGER + 1 })),
    },
    {
      label: "empty evidence",
      mutate: (event) => {
        event.evidence = [];
      },
      runtime: () => {
        const root = tempRoot();
        const written = writeActionEvent(root, reviewInput());
        const event = JSON.parse(fs.readFileSync(written.path, "utf8"));
        event.evidence = [];
        fs.writeFileSync(written.path, `${JSON.stringify(event)}\n`);
        return readSpooledActionEvents(root, "openclaw/openclaw");
      },
    },
  ];

  for (const value of [
    "Basic:dXNlcjpwYXNz",
    "alice@corp",
    `xoxb-${"A".repeat(24)}`,
    `AKIA${"A".repeat(16)}`,
    "LOCALHOST:443",
    "user@LOCALHOST",
    "file:/etc/passwd",
    "SERVICE.INTERNAL",
    "0:0::1",
    "https://user@host/path",
  ]) {
    cases.push({
      label: `confidential machine text ${value}`,
      mutate: (event) => {
        (event.action as Record<string, unknown>).status = value;
      },
      runtime: () =>
        createActionEvent(
          reviewInput({
            action: {
              name: "review",
              status: value,
              retryable: false,
              mutation: false,
            },
          }),
        ),
    });
  }

  for (const entry of cases) {
    const candidate = structuredClone(valid) as unknown as Record<string, unknown>;
    entry.mutate(candidate);
    assert.equal(schemaAccepts(schema, candidate), false, entry.label);
    assert.throws(entry.runtime, undefined, entry.label);
  }
});

test("ledger file reads reject malformed UTF-8 and dot-only path segments", () => {
  const root = tempRoot();
  assert.throws(
    () => prepareSafeWriteTarget(root, "ledger/./events.jsonl", "action event shard"),
    /outside root/,
  );

  const written = writeActionEvent(root, reviewInput());
  const content = fs.readFileSync(written.path);
  content[0] = 0xff;
  fs.writeFileSync(written.path, content);
  assert.throws(() => readSpooledActionEvents(root, "openclaw/openclaw"), /invalid UTF-8/);
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
  const schema = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "schema", "state-ledger-event.schema.json"), "utf8"),
  ) as TestJsonSchema;
  const valid = createActionEvent(
    reviewInput({
      evidence: [
        {
          kind: "run",
          runUrl: "https://github.com/openclaw/clawsweeper/actions/runs/100",
        },
      ],
    }),
  );
  for (const runUrl of [
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/actions/runs/100",
    "https://[fc00::1]/actions/runs/100",
    "https://internal.example/actions/runs/100",
    "https://service.internal./actions/runs/100",
    "https://user@github.com/openclaw/clawsweeper/actions/runs/100",
    "https://github.com/login/oauth/authorize?client_secret=PLACEHOLDER",
    "https://github.com/openclaw/clawsweeper/actions/runs/100?token=PLACEHOLDER",
    "https://github.com/openclaw/clawsweeper/actions/runs/100?",
    "https://github.com/openclaw/clawsweeper/actions/runs/100#",
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
    const candidate = structuredClone(valid) as unknown as Record<string, unknown>;
    ((candidate.evidence as Array<Record<string, unknown>>)[0] as Record<string, unknown>)[
      "run_url"
    ] = runUrl;
    assert.equal(schemaAccepts(schema, candidate), false, runUrl);
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
    () => createActionEvent(reviewInput({ occurredAt: "" })),
    /action event occurredAt is required/,
  );
  assert.throws(
    () => createActionEvent(reviewInput({ occurredAt: "2026-07-12" })),
    /ISO date-time/,
  );
  assert.throws(
    () => createActionEvent(reviewInput({ occurredAt: "2026-02-31T10:00:00Z" })),
    /ISO date-time/,
  );
  for (const occurredAt of ["0001-01-01T00:00:00Z", "0099-12-31T23:59:59Z"]) {
    assert.equal(createActionEvent(reviewInput({ occurredAt })).occurred_at, occurredAt);
  }
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
    "host-10.0.0.1",
    "ssh://alice:secret@10.0.0.1",
    "https://100.64.0.1/api",
    "prefix:100.127.255.254",
    "prefix:169.254.169.254",
    "https://internal.local",
    "https://service.internal./api",
    "https://service.internal.././api",
    "0:0:0:0:0:0:0:1",
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
  assert.match(
    actionEventShardRelativePath(
      {
        repository: producer.repository,
        sha: producer.sha,
        producer: "review",
        workflow: "sweep",
        job: "review-3",
        runId: "100",
        runAttempt: 2,
        partitionDate: "0001-01-01",
      },
      [createActionEvent(reviewInput({ occurredAt: "0001-01-01T00:00:00Z" }))],
    ),
    /^ledger\/v1\/events\/0001\/01\/01\//,
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
