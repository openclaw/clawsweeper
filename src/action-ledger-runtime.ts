import { createHash } from "node:crypto";
import path from "node:path";

import {
  prepareSafeReadRoot,
  prepareSafeReadTarget,
  prepareSafeWriteTarget,
  readDirectoryEntriesNoFollow,
  readUtf8FileIfExistsNoFollow,
  readUtf8FileNoFollow,
  writeUtf8FileCreateOnlyNoFollow,
  type SafeReadRoot,
} from "./action-ledger-files.js";
import {
  ACTION_EVENT_TYPES,
  actionEventShardContentReplayEquivalent,
  actionAttemptId,
  actionEventShardRelativePath,
  actionEventKey,
  actionIdempotencyKey,
  actionLedgerJson,
  actionOperationId,
  createActionEvent,
  isActionEventPhaseType,
  isActionEventReasonCode,
  isActionEventStatus,
  readActionEventShardAt,
  readAllSpooledActionEvents,
  sortActionEventsCausally,
  validateActionEvent,
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
import { normalizeRepo } from "./repository-profiles.js";

const DEFAULT_EVENT_OUTPUT_DIR = path.join(".clawsweeper-repair", "action-ledger-state");
const DEFAULT_CRABFLEET_TIMEOUT_MS = 10_000;
const MAX_CRABFLEET_TIMEOUT_MS = 60_000;
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
  const repository = normalizeRepo(requiredEnv(env, "GITHUB_REPOSITORY"));
  if (!/^[a-z0-9_][a-z0-9_.-]*\/[a-z0-9_][a-z0-9_.-]*$/.test(repository)) {
    throw new Error(`invalid GITHUB_REPOSITORY for action event telemetry: ${repository}`);
  }
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
  const eventInput = {
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
  };
  const recordedAt = options.now ? options.now() : new Date();
  const writeOptions = { now: () => recordedAt };
  createActionEvent(eventInput, writeOptions);
  ensureWorkflowPartitionDate(root, persistedWorkflowProducer(producer), env);
  const event = writeActionEvent(root, eventInput, writeOptions).event;
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
  const safeRoot = prepareSafeReadRoot(root, "action event spool");
  const events = readAllSpooledActionEvents(safeRoot);
  const groups = new Map<string, ActionEvent[]>();
  for (const event of events) {
    const key = actionLedgerJson(event.producer);
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
    const partitionDate = readWorkflowPartitionDate(safeRoot, first.producer);
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
  while (pendingCrabFleetPosts.size > 0) {
    await Promise.all(pendingCrabFleetPosts);
  }
}

export async function postActionEventToCrabFleet(
  event: ActionEvent,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const validatedEvent = validateActionEvent(event, "CrabFleet action event");
  const sessionId = String(env.CLAWSWEEPER_CRABFLEET_SESSION_ID ?? "").trim();
  const token = String(env.CLAWSWEEPER_CRABFLEET_AGENT_TOKEN ?? "").trim();
  if (!sessionId || !token) return;
  const baseUrl = String(env.CLAWSWEEPER_CRABFLEET_URL ?? "https://crabfleet.openclaw.ai").replace(
    /\/+$/,
    "",
  );
  const timeoutMs = crabFleetTimeoutMs(env);
  const controller = new AbortController();
  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;
  const timeoutError = new Error(`CrabFleet action event append timed out after ${timeoutMs}ms`);
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(timeoutError);
    }, timeoutMs);
  });
  const request = Promise.resolve().then(() =>
    fetchImpl(`${baseUrl}/api/agent/interactive-sessions/${encodeURIComponent(sessionId)}/events`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        eventKey: validatedEvent.event_key,
        type: "clawsweeper.action",
        message: actionEventMessage(validatedEvent),
        payload: {
          version: 1,
          event: validatedEvent,
        },
      }),
      signal: controller.signal,
    }),
  );
  const lateCleanup = request.then(async (response) => {
    if (timedOut) await cancelResponseBody(response);
  });
  void lateCleanup.catch(() => undefined);
  try {
    const response = await Promise.race([request, deadline]);
    const status = response.status;
    await Promise.race([cancelResponseBody(response), deadline]);
    if (!response.ok) {
      throw new Error(`CrabFleet action event append failed (${status})`);
    }
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function importActionEventShards(
  sourceRoot: string,
  destinationRoot: string,
): ActionEventShardImportResult {
  const source = path.resolve(sourceRoot);
  const destination = path.resolve(destinationRoot);
  let safeSource: SafeReadRoot;
  try {
    safeSource = prepareSafeReadRoot(source, "action event shard import source");
  } catch (error) {
    if (isNotFoundError(error)) return { created: 0, unchanged: 0, paths: [] };
    throw error;
  }
  let relativePaths: string[];
  try {
    relativePaths = recursiveFiles(safeSource, path.join("ledger", "v1", "events"))
      .filter((file) => /^ledger\/v1\/events\/.+\.jsonl$/.test(file))
      .sort();
  } catch (error) {
    if (isNotFoundError(error)) return { created: 0, unchanged: 0, paths: [] };
    throw error;
  }
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
    const events = readActionEventShardAt(safeSource, relativePath);
    const content = readUtf8FileNoFollow(
      prepareSafeReadTarget(safeSource, relativePath, "action event shard import source"),
    );
    if (!content.endsWith("\n")) {
      throw new Error(`action event shard must end with a newline: ${relativePath}`);
    }
    validateCanonicalImportedShard(relativePath, events, content);
    const target = prepareSafeWriteTarget(destination, relativePath, "action event shard import");
    const existing = readUtf8FileIfExistsNoFollow(target);
    if (existing !== null) {
      if (
        existing !== content &&
        !actionEventShardContentReplayEquivalent(existing, events, target.path)
      ) {
        throw new Error(`action event shard import conflict: ${relativePath}`);
      }
      unchanged += 1;
      continue;
    }
    const status = writeUtf8FileCreateOnlyNoFollow(target, content);
    if (status === "created") {
      created += 1;
      continue;
    }
    const raced = readUtf8FileNoFollow(target);
    if (raced !== content && !actionEventShardContentReplayEquivalent(raced, events, target.path)) {
      throw new Error(`action event shard import conflict: ${relativePath}`);
    }
    unchanged += 1;
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
  const firstProducer = actionLedgerJson(first.producer);
  for (const event of events) {
    if (seen.has(event.event_id)) {
      throw new Error(`action event shard contains duplicate events: ${relativePath}`);
    }
    seen.add(event.event_id);
    if (actionLedgerJson(event.producer) !== firstProducer) {
      throw new Error(`action event shard mixes producer identities: ${relativePath}`);
    }
  }
  const sorted = sortActionEventsCausally(events);
  const canonicalContent = `${sorted.map((event) => actionLedgerJson(event)).join("\n")}\n`;
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
    writeActionEvent(
      root,
      {
        eventKey: actionEventKey("projection.failed", {
          sourceEventId: event.event_id,
          destination: "crabfleet",
        }),
        operationId: event.operation_id,
        attemptId: event.attempt_id,
        parentEventId: event.event_id,
        phaseSeq:
          event.phase_seq === Number.MAX_SAFE_INTEGER ? event.phase_seq : event.phase_seq + 1,
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
          ...(event.subject.subject_id === undefined
            ? {}
            : { subjectId: event.subject.subject_id }),
          ...(event.subject.number === undefined ? {} : { number: event.subject.number }),
          ...(event.subject.cluster_id === undefined
            ? {}
            : { clusterId: event.subject.cluster_id }),
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
      },
      {
        generatedOccurredAt: event.recorded_at,
      },
    );
  } catch (error) {
    console.error(
      `[action-ledger] failed to record CrabFleet projection failure: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function ensureWorkflowPartitionDate(
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
  const target = prepareSafeWriteTarget(
    root,
    workflowPartitionRelativePath(producer),
    "action event partition marker",
  );
  const existing = readUtf8FileIfExistsNoFollow(target);
  if (existing !== null) {
    return validateWorkflowPartitionMarker(existing, partitionDate);
  }
  if (writeUtf8FileCreateOnlyNoFollow(target, `${partitionDate}\n`) === "exists") {
    return validateWorkflowPartitionMarker(readUtf8FileNoFollow(target), partitionDate);
  }
  return partitionDate;
}

function readWorkflowPartitionDate(root: SafeReadRoot, producer: ActionEvent["producer"]): string {
  const target = prepareSafeReadTarget(
    root,
    workflowPartitionRelativePath(producer),
    "action event partition marker",
  );
  return workflowPartitionCalendarDate(
    readUtf8FileNoFollow(target).trim(),
    "action event partition marker",
  );
}

function workflowPartitionRelativePath(producer: ActionEvent["producer"]): string {
  const identity = createHash("sha256").update(actionLedgerJson(producer)).digest("hex");
  return path.join(".clawsweeper-repair", "action-events", "_partitions", `${identity}.txt`);
}

function persistedWorkflowProducer(producer: ActionEventProducer): ActionEvent["producer"] {
  return {
    repository: producer.repository,
    sha: producer.sha,
    workflow: producer.workflow,
    job: producer.job,
    run_id: producer.runId,
    run_attempt: producer.runAttempt,
    component: producer.component,
  };
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

function recursiveFiles(root: SafeReadRoot, relativeDirectory = "."): string[] {
  const entries = readDirectoryEntriesNoFollow(
    root,
    relativeDirectory,
    "action event shard import source",
  );
  return entries.flatMap((entry) => {
    const relativePath =
      relativeDirectory === "."
        ? entry.name
        : path.posix.join(relativeDirectory.replaceAll(path.sep, "/"), entry.name);
    if (entry.isDirectory()) return recursiveFiles(root, relativePath);
    if (entry.isFile()) return [relativePath];
    if (entry.isSymbolicLink()) {
      throw new Error(`refusing symbolic link in action event shard import: ${relativePath}`);
    }
    throw new Error(`refusing unsafe action event shard import entry: ${relativePath}`);
  });
}

function crabFleetTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = String(env.CLAWSWEEPER_CRABFLEET_TIMEOUT_MS ?? "").trim();
  if (!raw) return DEFAULT_CRABFLEET_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CRABFLEET_TIMEOUT_MS) {
    throw new Error(
      `CLAWSWEEPER_CRABFLEET_TIMEOUT_MS must be an integer between 1 and ${MAX_CRABFLEET_TIMEOUT_MS}`,
    );
  }
  return value;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    throw new Error("CrabFleet action event response cleanup failed");
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
