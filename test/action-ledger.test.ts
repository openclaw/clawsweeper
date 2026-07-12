import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

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
  actionLedgerJson,
  actionOperationId,
  createActionEvent,
  isActionEventPhaseType,
  isActionEventReasonCode,
  isActionEventStatus,
  readActionEventShard,
  readAllSpooledActionEvents,
  readSpooledActionEvents,
  writeActionEvent,
  writeActionEventShard,
  type ActionEventInput,
  type ActionEventProducer,
} from "../dist/action-ledger.js";
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
  return fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-action-ledger-"));
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
        { kind: "report", reportPath: "records/\u00e4.md" },
        { kind: "report", reportPath: "records/z.md" },
      ],
    }),
  );
  assert.deepEqual(
    event.evidence?.map((entry) => entry.report_path),
    ["records/z.md", "records/\u00e4.md"],
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

  for (const scope of [`ghp_${"A".repeat(20)}`, `Bearer-${"A".repeat(20)}`, "service.internal"]) {
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
    "Basic:dXNlcjpwYXNz",
    "alice%40example.com",
    "%2FUsers%2Falice%2Fsecret",
    "https%3A%2F%2Fservice.internal%2Fapi",
    `api_key:${"A".repeat(32)}`,
    `cloudflare_api_token:${"A".repeat(32)}`,
    `fc00::1`,
    "0:0:0:0:0:0:0:1",
    "::ffff:7f00:1",
    "service.internal",
    "service.internal.",
    "SERVICE.INTERNAL",
    "LOCALHOST:443",
    "user@LOCALHOST",
    "file:/etc/passwd",
    "https://user@host/path",
    "internal.example.com",
    "https://host.docker.internal/api",
    "https://10.0.0.1/api",
    "host-10.0.0.1",
    "0:0::1",
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
    "localhost-check",
    "user-at-localhost",
    "file-cache",
    "public.example",
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
  "writes fail closed when a parent is swapped during open",
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
    const leaked = fs.readdirSync(outside).map((entry) => path.join(outside, entry));
    assert.ok(leaked.length <= 1);
    for (const filePath of leaked) assert.equal(fs.statSync(filePath).size, 0);
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
  "staging cleanup refuses a parent replaced after publication",
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
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.ok(fs.readdirSync(eventParent).some((entry) => entry.endsWith(".tmp")));
  },
);

test(
  "event reads reject a parent swap between validation and open",
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

test("duplicate event IDs preserve first-writer metadata but require identical source metadata", () => {
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
  assert.equal(replay.event.occurred_at, first.event.occurred_at);
  assert.equal(replay.event.recorded_at, first.event.recorded_at);
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
    `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${"A".repeat(32)}`,
    `Bearer:${"A".repeat(32)}`,
    `bEaReR ${"A".repeat(32)}`,
    `Bearer%20${"A".repeat(32)}`,
    `Basic ${Buffer.from("user:password").toString("base64")}`,
    `cloudflare_api_token:${"A".repeat(32)}`,
    "alice%40example.com",
    "%2FUsers%2Falice%2Fsecret",
    "https%3A%2F%2Fservice.internal%2Fapi",
    "C:/build/runner/worktree",
    "service.internal",
    "service.internal.",
    "internal.example.com",
    "0:0:0:0:0:0:0:1",
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
      /repository-relative path|confidential identifier/,
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
      label: "IPv4-mapped IPv6 loopback",
      mutate: (event) => {
        (event.action as Record<string, unknown>).status = "::ffff:7f00:1";
      },
      runtime: () =>
        createActionEvent(
          reviewInput({
            action: {
              name: "review",
              status: "::ffff:7f00:1",
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
    "https://service.internal./actions/runs/100",
    "https://user@github.com/openclaw/clawsweeper/actions/runs/100",
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
    "host-10.0.0.1",
    "ssh://alice:secret@10.0.0.1",
    "prefix:169.254.169.254",
    "https://internal.local",
    "https://service.internal./api",
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
