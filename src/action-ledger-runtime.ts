import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  assertDirectoryNoLinks,
  prepareSafeWriteTarget,
  readUtf8FileIfExistsNoFollow,
  readUtf8FileNoFollow,
  writeUtf8FileExclusiveNoFollow,
} from "./action-ledger-files.js";
import {
  ACTION_EVENT_TYPES,
  actionAttemptId,
  actionEventShardRelativePath,
  actionEventKey,
  actionIdempotencyKey,
  actionOperationId,
  compareActionEventTimestamps,
  isActionEventPhaseType,
  isActionEventReasonCode,
  isActionEventStatus,
  readActionEventShard,
  readAllSpooledActionEvents,
  writeActionEvent,
  writeActionEventShard,
  type ActionEvent,
  type ActionEventAction,
  type ActionEventAttributes,
  type ActionEventEvidence,
  type ActionEventLearning,
  type ActionEventPrivacy,
  type ActionEventProducer,
  type ActionEventPhaseType,
  type ActionEventReasonCode,
  type ActionEventStatus,
  type ActionEventSubject,
} from "./action-ledger.js";
import { stableJson } from "./stable-json.js";

const DEFAULT_EVENT_OUTPUT_DIR = path.join(".clawsweeper-repair", "action-ledger-state");
const pendingCrabFleetPosts = new Set<Promise<void>>();

export type WorkflowActionEventInput = {
  scope: string;
  identity: unknown;
  operation?: string;
  operationIdentity?: unknown;
  attemptIdentity?: unknown;
  parentEventId?: string | null;
  phaseSeq?: number;
  idempotencyIdentity?: unknown;
  type: string;
  component: string;
  subject: ActionEventSubject;
  action: ActionEventAction;
  learning?: ActionEventLearning;
  evidence?: readonly ActionEventEvidence[];
  attributes?: ActionEventAttributes;
  privacy?: ActionEventPrivacy;
  occurredAt?: string;
};

export type WorkflowActionEventOptions = {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  fetchImpl?: typeof fetch;
};

export type WorkflowActionPhaseEventInput = Omit<
  WorkflowActionEventInput,
  "scope" | "type" | "action"
> & {
  phase: ActionEventPhaseType;
  status: ActionEventStatus;
  reasonCode?: ActionEventReasonCode;
  retryable: boolean;
  mutation: boolean;
};

export type ActionEventShardImportResult = {
  created: number;
  unchanged: number;
  paths: string[];
};

export function workflowActionEventsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CLAWSWEEPER_ACTION_LEDGER_DISABLED === "1") return false;
  return env.GITHUB_ACTIONS === "true" || env.CLAWSWEEPER_ACTION_LEDGER_FORCE === "1";
}

export function workflowActionProducer(
  component: string,
  env: NodeJS.ProcessEnv = process.env,
): ActionEventProducer {
  const repository = requiredEnv(env, "GITHUB_REPOSITORY");
  const workflowRef = String(env.GITHUB_WORKFLOW_REF ?? "").trim();
  const workflow = workflowRef
    ? path.posix.basename(workflowRef.split("@", 1)[0] ?? workflowRef)
    : machineIdentifier(requiredEnv(env, "GITHUB_WORKFLOW"), 128);
  const step = machineIdentifier(String(env.GITHUB_ACTION ?? "process"), 64);
  const invocation = machineIdentifier(
    String(env.CLAWSWEEPER_ACTION_LEDGER_INVOCATION ?? "default"),
    64,
  );
  return {
    repository,
    sha: requiredEnv(env, "GITHUB_SHA"),
    workflow,
    job: requiredEnv(env, "GITHUB_JOB"),
    runId: requiredEnv(env, "GITHUB_RUN_ID"),
    runAttempt: positiveIntegerEnv(env, "GITHUB_RUN_ATTEMPT"),
    component: `${machineIdentifier(component, 120)}.${step}.${invocation}`,
  };
}

export function recordWorkflowActionEvent(
  root: string,
  input: WorkflowActionEventInput,
  options: WorkflowActionEventOptions = {},
): ActionEvent | null {
  const env = options.env ?? process.env;
  if (!workflowActionEventsEnabled(env)) return null;
  if (input.action.mutation && input.idempotencyIdentity === undefined) {
    throw new Error("mutation action events require an explicit idempotencyIdentity");
  }
  const producer = workflowActionProducer(input.component, env);
  const operation = input.operation ?? input.scope.split(".", 1)[0] ?? input.scope;
  const operationId = actionOperationId(
    input.subject.repository,
    operation,
    input.operationIdentity ?? input.subject,
  );
  const attemptId = actionAttemptId(
    operationId,
    input.attemptIdentity ?? {
      repository: producer.repository,
      workflow: producer.workflow,
      runId: producer.runId,
      runAttempt: producer.runAttempt,
    },
  );
  const phaseSeq = input.phaseSeq ?? 1;
  const event = writeActionEvent(
    root,
    {
      eventKey: actionEventKey(input.scope, {
        attemptId,
        phaseSeq,
        producer: {
          job: producer.job,
          component: producer.component,
        },
        identity: input.identity,
      }),
      operationId,
      attemptId,
      parentEventId: input.parentEventId ?? null,
      phaseSeq,
      idempotencyKeySha256: actionIdempotencyKey(
        input.idempotencyIdentity ?? {
          operationId,
          scope: input.scope,
          identity: input.identity,
        },
      ),
      type: input.type,
      producer,
      subject: input.subject,
      action: input.action,
      ...(input.learning ? { learning: input.learning } : {}),
      ...(input.evidence ? { evidence: input.evidence } : {}),
      ...(input.attributes ? { attributes: input.attributes } : {}),
      ...(input.privacy ? { privacy: input.privacy } : {}),
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
    },
    options.now ? { now: options.now } : {},
  ).event;
  queueCrabFleetEvent(root, event, env, options.fetchImpl ?? fetch);
  return event;
}

export function recordWorkflowPhaseEvent(
  root: string,
  input: WorkflowActionPhaseEventInput,
  options: WorkflowActionEventOptions = {},
): ActionEvent | null {
  const phase = String(input.phase);
  const status = String(input.status);
  const reasonCode = input.reasonCode === undefined ? undefined : String(input.reasonCode);
  if (!isActionEventPhaseType(phase)) {
    throw new Error(`unknown action event phase type: ${phase}`);
  }
  if (!isActionEventStatus(status)) {
    throw new Error(`unknown action event status: ${status}`);
  }
  if (reasonCode !== undefined && !isActionEventReasonCode(reasonCode)) {
    throw new Error(`unknown action event reason code: ${reasonCode}`);
  }
  return recordWorkflowActionEvent(
    root,
    {
      scope: phase,
      identity: {
        phase,
        status,
        ...(reasonCode ? { reasonCode } : {}),
        identity: input.identity,
      },
      ...(input.operation ? { operation: input.operation } : {}),
      ...(input.operationIdentity === undefined
        ? {}
        : { operationIdentity: input.operationIdentity }),
      ...(input.attemptIdentity === undefined ? {} : { attemptIdentity: input.attemptIdentity }),
      ...(input.parentEventId === undefined ? {} : { parentEventId: input.parentEventId }),
      ...(input.phaseSeq === undefined ? {} : { phaseSeq: input.phaseSeq }),
      ...(input.idempotencyIdentity === undefined
        ? {}
        : { idempotencyIdentity: input.idempotencyIdentity }),
      type: phase,
      component: input.component,
      subject: input.subject,
      action: {
        name: phase,
        status,
        ...(reasonCode ? { reasonCode } : {}),
        retryable: input.retryable,
        mutation: input.mutation,
      },
      ...(input.learning ? { learning: input.learning } : {}),
      ...(input.evidence ? { evidence: input.evidence } : {}),
      ...(input.attributes ? { attributes: input.attributes } : {}),
      ...(input.privacy ? { privacy: input.privacy } : {}),
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
    },
    options,
  );
}

export async function flushWorkflowActionEvents(
  root: string,
  options: {
    env?: NodeJS.ProcessEnv;
    outputRoot?: string;
  } = {},
): Promise<string[]> {
  await flushPendingCrabFleetPosts();
  const env = options.env ?? process.env;
  if (!workflowActionEventsEnabled(env)) return [];
  const events = readAllSpooledActionEvents(root);
  const groups = new Map<string, ActionEvent[]>();
  for (const event of events) {
    const key = stableJson(event.producer);
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }
  const outputRoot = path.resolve(
    options.outputRoot ??
      env.CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT ??
      path.join(root, DEFAULT_EVENT_OUTPUT_DIR),
  );
  const paths: string[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    if (!first) continue;
    const partitionDate = workflowPartitionDate(root, first.producer, env);
    const result = writeActionEventShard(
      outputRoot,
      {
        repository: first.producer.repository,
        sha: first.producer.sha,
        producer: first.producer.component,
        workflow: first.producer.workflow,
        job: first.producer.job,
        runId: first.producer.run_id,
        runAttempt: first.producer.run_attempt,
        partitionDate,
      },
      group,
    );
    paths.push(result.relativePath);
  }
  return paths.sort();
}

export async function flushPendingCrabFleetPosts(): Promise<void> {
  const posts = [...pendingCrabFleetPosts];
  if (posts.length === 0) return;
  await Promise.all(posts);
}

export async function postActionEventToCrabFleet(
  event: ActionEvent,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const sessionId = String(env.CLAWSWEEPER_CRABFLEET_SESSION_ID ?? "").trim();
  const token = String(env.CLAWSWEEPER_CRABFLEET_AGENT_TOKEN ?? "").trim();
  if (!sessionId || !token) return;
  const baseUrl = String(env.CLAWSWEEPER_CRABFLEET_URL ?? "https://crabfleet.openclaw.ai").replace(
    /\/+$/,
    "",
  );
  const response = await fetchImpl(
    `${baseUrl}/api/agent/interactive-sessions/${encodeURIComponent(sessionId)}/events`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        eventKey: event.event_key,
        type: "clawsweeper.action",
        message: actionEventMessage(event),
        payload: {
          version: 1,
          event,
        },
      }),
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`CrabFleet action event append failed (${response.status})`);
  }
}

export function importActionEventShards(
  sourceRoot: string,
  destinationRoot: string,
): ActionEventShardImportResult {
  const source = path.resolve(sourceRoot);
  const destination = path.resolve(destinationRoot);
  if (!fs.existsSync(source)) return { created: 0, unchanged: 0, paths: [] };
  const relativePaths = recursiveFiles(source)
    .map((file) => path.relative(source, file).replaceAll(path.sep, "/"))
    .filter((file) => /^ledger\/v1\/events\/.+\.jsonl$/.test(file))
    .sort();
  let created = 0;
  let unchanged = 0;
  for (const relativePath of relativePaths) {
    if (
      !/^ledger\/v1\/events\/\d{4}\/\d{2}\/\d{2}\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.jsonl$/.test(
        relativePath,
      )
    ) {
      throw new Error(`invalid action event shard path: ${relativePath}`);
    }
    const sourcePath = path.join(source, relativePath);
    const events = readActionEventShard(sourcePath);
    const content = readUtf8FileNoFollow(sourcePath, "action event shard import source");
    if (!content.endsWith("\n")) {
      throw new Error(`action event shard must end with a newline: ${relativePath}`);
    }
    validateCanonicalImportedShard(relativePath, events, content);
    const target = prepareSafeWriteTarget(destination, relativePath, "action event shard import");
    try {
      writeUtf8FileExclusiveNoFollow(target, content);
      created += 1;
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      if (readUtf8FileNoFollow(target.path, "action event shard import") !== content) {
        throw new Error(`action event shard import conflict: ${relativePath}`);
      }
      unchanged += 1;
    }
  }
  return { created, unchanged, paths: relativePaths };
}

function validateCanonicalImportedShard(
  relativePath: string,
  events: readonly ActionEvent[],
  content: string,
): void {
  const match =
    /^ledger\/v1\/events\/(\d{4})\/(\d{2})\/(\d{2})\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.jsonl$/.exec(
      relativePath,
    );
  const first = events[0];
  if (!match || !first || events.length === 0) {
    throw new Error(`action event shard is empty or has an invalid path: ${relativePath}`);
  }
  const seen = new Set<string>();
  const firstProducer = stableJson(first.producer);
  for (const event of events) {
    if (seen.has(event.event_id)) {
      throw new Error(`action event shard contains duplicate events: ${relativePath}`);
    }
    seen.add(event.event_id);
    if (stableJson(event.producer) !== firstProducer) {
      throw new Error(`action event shard mixes producer identities: ${relativePath}`);
    }
  }
  const sorted = [...events].sort(
    (left, right) =>
      compareActionEventTimestamps(left.occurred_at, right.occurred_at) ||
      left.event_id.localeCompare(right.event_id),
  );
  const canonicalContent = `${sorted.map((event) => stableJson(event)).join("\n")}\n`;
  if (content !== canonicalContent) {
    throw new Error(`action event shard content is not canonical: ${relativePath}`);
  }
  const expectedPath = actionEventShardRelativePath(
    {
      repository: first.producer.repository,
      sha: first.producer.sha,
      producer: first.producer.component,
      workflow: first.producer.workflow,
      job: first.producer.job,
      runId: first.producer.run_id,
      runAttempt: first.producer.run_attempt,
      partitionDate: `${match[1]}-${match[2]}-${match[3]}`,
    },
    sorted,
  ).replaceAll(path.sep, "/");
  if (expectedPath !== relativePath) {
    throw new Error(
      `action event shard path does not match canonical identity: ${relativePath} != ${expectedPath}`,
    );
  }
}

function queueCrabFleetEvent(
  root: string,
  event: ActionEvent,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): void {
  const post = postActionEventToCrabFleet(event, env, fetchImpl)
    .catch((error) => {
      recordCrabFleetProjectionFailure(root, event);
      console.error(
        `[action-ledger] live CrabFleet projection failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    })
    .finally(() => pendingCrabFleetPosts.delete(post));
  pendingCrabFleetPosts.add(post);
}

function recordCrabFleetProjectionFailure(root: string, event: ActionEvent): void {
  try {
    writeActionEvent(root, {
      eventKey: actionEventKey("projection.failed", {
        sourceEventId: event.event_id,
        destination: "crabfleet",
      }),
      operationId: event.operation_id,
      attemptId: event.attempt_id,
      parentEventId: event.event_id,
      phaseSeq: event.phase_seq + 1,
      idempotencyKeySha256: actionIdempotencyKey({
        sourceEventId: event.event_id,
        destination: "crabfleet",
      }),
      type: ACTION_EVENT_TYPES.projectionFailed,
      producer: {
        repository: event.producer.repository,
        sha: event.producer.sha,
        workflow: event.producer.workflow,
        job: event.producer.job,
        runId: event.producer.run_id,
        runAttempt: event.producer.run_attempt,
        component: event.producer.component,
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
        name: "crabfleet_projection",
        status: "failed",
        reasonCode: "append_failed",
        retryable: true,
        mutation: false,
      },
      learning: {
        category: "delivery",
        signal: "retry_from_durable_ledger",
        ruleId: "crabfleet_projection_failed",
        confidence: 1,
      },
      attributes: {
        phase: "live_projection",
      },
      privacy: {
        classification: "internal",
        redactionVersion: "v1",
        fieldsDropped: ["token", "response_body", "error_detail"],
      },
      occurredAt: event.recorded_at,
    });
  } catch (error) {
    console.error(
      `[action-ledger] failed to record CrabFleet projection failure: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function workflowPartitionDate(
  root: string,
  producer: ActionEvent["producer"],
  env: NodeJS.ProcessEnv,
): string {
  const configured = String(env.CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE ?? "").trim();
  const runStartedAt = String(env.GITHUB_RUN_STARTED_AT ?? "").trim();
  let partitionDate: string;
  if (configured) {
    partitionDate = workflowPartitionCalendarDate(
      configured,
      "CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE",
    );
  } else if (runStartedAt) {
    partitionDate = workflowPartitionTimestampDate(runStartedAt);
  } else {
    throw new Error(
      "action event partitioning requires CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE or GITHUB_RUN_STARTED_AT",
    );
  }
  const identity = createHash("sha256").update(stableJson(producer)).digest("hex");
  const partitionPath = path.join(
    ".clawsweeper-repair",
    "action-events",
    "_partitions",
    `${identity}.txt`,
  );
  const target = prepareSafeWriteTarget(root, partitionPath, "action event partition marker");
  const existing = readUtf8FileIfExistsNoFollow(target.path, "action event partition marker");
  if (existing !== null) {
    return validateWorkflowPartitionMarker(existing, partitionDate);
  }
  try {
    writeUtf8FileExclusiveNoFollow(target, `${partitionDate}\n`);
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
    return validateWorkflowPartitionMarker(
      readUtf8FileNoFollow(target.path, "action event partition marker"),
      partitionDate,
    );
  }
  return partitionDate;
}

function validateWorkflowPartitionMarker(content: string, expected: string): string {
  const recorded = workflowPartitionCalendarDate(content.trim(), "action event partition marker");
  if (recorded !== expected) {
    throw new Error(`action event partition marker conflict: ${recorded} != ${expected}`);
  }
  return recorded;
}

function workflowPartitionCalendarDate(value: string, label: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`${label} must be YYYY-MM-DD`);
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`${label} must be YYYY-MM-DD`);
  }
  return value;
}

function workflowPartitionTimestampDate(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error("GITHUB_RUN_STARTED_AT must be an ISO date-time timestamp");
  }
  return new Date(value).toISOString().slice(0, 10);
}

function actionEventMessage(event: ActionEvent): string {
  const subject =
    event.subject.number === undefined
      ? `${event.subject.repository}:${event.subject.kind}`
      : `${event.subject.repository}#${event.subject.number}`;
  return `${event.event_type}:${event.action.status}:${subject}`;
}

function machineIdentifier(value: string, maxLength: number): string {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9_.:/@+-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength);
  if (!normalized) throw new Error("workflow action identifier is required");
  return normalized;
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = String(env[name] ?? "").trim();
  if (!value) throw new Error(`${name} is required for action event telemetry`);
  return value;
}

function positiveIntegerEnv(env: NodeJS.ProcessEnv, name: string): number {
  const value = Number(requiredEnv(env, name));
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function recursiveFiles(root: string): string[] {
  assertDirectoryNoLinks(root, "action event shard import source");
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const resolved = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`refusing symbolic link in action event shard import: ${resolved}`);
    }
    if (entry.isDirectory()) return recursiveFiles(resolved);
    return entry.isFile() ? [resolved] : [];
  });
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}
