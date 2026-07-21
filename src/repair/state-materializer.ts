#!/usr/bin/env node
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  actionLedgerJson,
  parseActionEventShardContent,
  validateActionEvent,
} from "../action-ledger.js";
import { isActionEventPublishPath } from "../action-ledger-paths.js";
import { mergeCommentRouterLedgers } from "./comment-router-ledger-merge.js";
import { publishMainCommit } from "./git-publish.js";
import { mergeSweepStatusJson } from "./sweep-status-merge.js";

export const DEFAULT_STATE_MATERIALIZER_MAX_ROWS = 2_000;
export const DEFAULT_STATE_MATERIALIZER_MAX_BYTES = 20 * 1024 * 1024;
export const DEFAULT_STATE_MATERIALIZER_MAX_RUNTIME_MS = 10 * 60 * 1_000;

const COMMENT_ROUTER_LEDGER_PATH = "results/comment-router.json";
const EMPTY_COMMENT_ROUTER_LEDGER = '{"updated_at":null,"commands":[]}';
const STATE_MATERIALIZER_COMMIT_MESSAGE = "chore: materialize queued state\n\n[skip ci]";
const STATE_APPEND_KINDS = new Set<StateAppendKind>([
  "sweep_status",
  "comment_router",
  "apply_proof",
]);

export type StateAppendKind = "sweep_status" | "comment_router" | "apply_proof";

export type StateAppendRecord = {
  seq: number;
  kind: StateAppendKind;
  key: string;
  payload: unknown;
  produced_at: string;
  delivery_id: string;
};

export type StateMaterializerSummary = {
  drained: number;
  committed: number;
  acked: number;
  skipped: number;
  errors: number;
};

export type StateMaterializationPlan = {
  publishPaths: string[];
  writes: Array<{ path: string; content: string }>;
  selected: number;
  skipped: number;
};

export type StateMaterializerRunOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

type StateDrainResponse = {
  token: string | null;
  records: StateAppendRecord[];
};

export function selectLatestStateRecords(records: readonly StateAppendRecord[]): {
  records: StateAppendRecord[];
  skipped: number;
} {
  const ordered = [...records].sort((left, right) => left.seq - right.seq);
  for (let index = 0; index < ordered.length; index += 1) {
    const record = ordered[index]!;
    assertStateAppendRecord(record);
    if (index > 0 && ordered[index - 1]!.seq === record.seq) {
      throw new Error(`state drain contains duplicate sequence ${record.seq}`);
    }
  }

  const latest = new Map<string, StateAppendRecord>();
  for (const record of ordered) latest.set(`${record.kind}\0${record.key}`, record);
  const selected = [...latest.values()].sort((left, right) => left.seq - right.seq);
  return { records: selected, skipped: records.length - selected.length };
}

export function sweepStatusPathForStateKey(key: string): string {
  const slugMatch = /^([A-Za-z0-9][A-Za-z0-9_.-]*)$/.exec(key);
  if (slugMatch) return `results/sweep-status/${slugMatch[1]}.json`;
  const pathMatch = /^results\/sweep-status\/([A-Za-z0-9][A-Za-z0-9_.-]*)\.json$/.exec(key);
  if (pathMatch) return key;
  throw new Error(`invalid sweep status key: ${key}`);
}

export function serializeApplyProof(path: string, payload: unknown): string {
  if (!isActionEventPublishPath(path)) {
    throw new Error(`invalid apply proof ledger path: ${path}`);
  }
  if (path.endsWith(".jsonl")) {
    const content =
      typeof payload === "string"
        ? payload
        : Array.isArray(payload)
          ? `${payload
              .map((event, index) =>
                actionLedgerJson(validateActionEvent(event, `${path}:${index + 1}`)),
              )
              .join("\n")}\n`
          : (() => {
              throw new Error(`apply proof event payload must be an array or string: ${path}`);
            })();
    parseActionEventShardContent(content, path);
    return content;
  }

  if (typeof payload !== "string") return `${actionLedgerJson(payload)}\n`;
  if (!payload.endsWith("\n") || payload.slice(0, -1).includes("\n")) {
    throw new Error(`apply proof binding must be one newline-terminated JSON value: ${path}`);
  }
  const parsed = JSON.parse(payload.slice(0, -1)) as unknown;
  const canonical = `${actionLedgerJson(parsed)}\n`;
  if (payload !== canonical) throw new Error(`apply proof binding is not canonical: ${path}`);
  return payload;
}

export function planStateMaterialization(
  records: readonly StateAppendRecord[],
  currentFiles: ReadonlyMap<string, string> = new Map(),
): StateMaterializationPlan {
  const selected = selectLatestStateRecords(records);
  const contentByPath = new Map<string, string>();
  const publishPaths: string[] = [];
  const addPublishPath = (path: string): void => {
    if (!publishPaths.includes(path)) publishPaths.push(path);
  };

  for (const record of selected.records) {
    if (record.kind === "sweep_status") {
      const path = sweepStatusPathForStateKey(record.key);
      const slug = path.slice("results/sweep-status/".length, -".json".length);
      if (!isRecord(record.payload) || record.payload.slug !== slug) {
        throw new Error(`sweep status payload slug does not match ${path}`);
      }
      const payloadText = JSON.stringify(record.payload);
      const content = mergeSweepStatusJson({
        path,
        baseText: null,
        localText: null,
        remoteText: payloadText,
      });
      contentByPath.set(path, content);
      addPublishPath(path);
      continue;
    }

    if (record.kind === "comment_router") {
      const payloadText = JSON.stringify(record.payload);
      const current =
        contentByPath.get(COMMENT_ROUTER_LEDGER_PATH) ??
        currentFiles.get(COMMENT_ROUTER_LEDGER_PATH) ??
        EMPTY_COMMENT_ROUTER_LEDGER;
      contentByPath.set(
        COMMENT_ROUTER_LEDGER_PATH,
        mergeCommentRouterLedgers(payloadText, current),
      );
      addPublishPath(COMMENT_ROUTER_LEDGER_PATH);
      continue;
    }

    const path = record.key;
    const content = serializeApplyProof(path, record.payload);
    const current = currentFiles.get(path);
    if (current !== undefined && current !== content) {
      throw new Error(`immutable apply proof already has different content: ${path}`);
    }
    contentByPath.set(path, content);
    addPublishPath(path);
  }

  return {
    publishPaths,
    writes: [...contentByPath]
      .filter(([path, content]) => currentFiles.get(path) !== content)
      .map(([path, content]) => ({ path, content })),
    selected: selected.records.length,
    skipped: selected.skipped,
  };
}

export async function runStateMaterializer(
  options: StateMaterializerRunOptions = {},
): Promise<StateMaterializerSummary> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const queueUrl = (env.QUEUE_URL ?? "").replace(/\/$/, "");
  const webhookSecret = env.CLAWSWEEPER_WEBHOOK_SECRET ?? "";
  registerStateSecretForRedaction(webhookSecret);
  const maximumRows = boundedPositiveInteger(
    env.CLAWSWEEPER_STATE_MATERIALIZER_MAX_ROWS ?? env.STATE_MATERIALIZER_MAX_ROWS,
    DEFAULT_STATE_MATERIALIZER_MAX_ROWS,
    100_000,
  );
  const maximumBytes = boundedPositiveInteger(
    env.CLAWSWEEPER_STATE_MATERIALIZER_MAX_BYTES ?? env.STATE_MATERIALIZER_MAX_BYTES,
    DEFAULT_STATE_MATERIALIZER_MAX_BYTES,
    100 * 1024 * 1024,
  );
  const maximumRuntimeMs = boundedPositiveInteger(
    env.CLAWSWEEPER_STATE_MATERIALIZER_MAX_RUNTIME_MS ?? env.STATE_MATERIALIZER_MAX_RUNTIME_MS,
    DEFAULT_STATE_MATERIALIZER_MAX_RUNTIME_MS,
    60 * 60 * 1_000,
  );
  const publishMaxAttempts = boundedPositiveInteger(
    env.CLAWSWEEPER_STATE_MATERIALIZER_PUBLISH_MAX_ATTEMPTS,
    8,
    64,
  );
  const publishPushAttempts = boundedPositiveInteger(
    env.CLAWSWEEPER_STATE_MATERIALIZER_PUSH_ATTEMPTS,
    3,
    16,
  );
  const branch = env.CLAWSWEEPER_PUBLISH_BRANCH?.trim() || "state";
  const startedAt = now().getTime();
  const summary: StateMaterializerSummary = {
    drained: 0,
    committed: 0,
    acked: 0,
    skipped: 0,
    errors: 0,
  };
  const finish = (): StateMaterializerSummary => {
    console.log(
      `state-materializer: drained=${summary.drained} committed=${summary.committed} acked=${summary.acked} skipped=${summary.skipped} errors=${summary.errors}`,
    );
    return summary;
  };

  if (!queueUrl || !webhookSecret) {
    summary.errors += 1;
    console.warn("state-materializer skipped: missing queue URL or webhook secret");
    return finish();
  }

  while (now().getTime() - startedAt < maximumRuntimeMs) {
    let drain: StateDrainResponse;
    try {
      drain = await drainStateWindow({
        queueUrl,
        webhookSecret,
        maximumRows,
        maximumBytes,
        fetchImpl,
      });
    } catch (error) {
      summary.errors += 1;
      console.warn(`state-materializer drain failed: ${errorMessage(error)}`);
      break;
    }
    if (drain.records.length === 0) break;
    summary.drained += drain.records.length;

    try {
      if (!drain.token) throw new Error("non-empty state drain omitted its token");
      const selected = selectLatestStateRecords(drain.records);
      const currentFiles = readCurrentFiles(materializationPaths(selected.records), process.cwd());
      const plan = planStateMaterialization(drain.records, currentFiles);
      applyStateMaterializationPlan(plan, process.cwd());
      publishMainCommit({
        message: STATE_MATERIALIZER_COMMIT_MESSAGE,
        paths: plan.publishPaths,
        branch,
        maxAttempts: publishMaxAttempts,
        pushAttempts: publishPushAttempts,
      });
      summary.committed += plan.selected;
      summary.skipped += plan.skipped;

      const acked = await ackStateWindow({
        queueUrl,
        webhookSecret,
        drainToken: drain.token,
        fetchImpl,
      });
      if (acked > drain.records.length) {
        throw new Error(`state ack count ${acked} exceeded drained count ${drain.records.length}`);
      }
      if (acked < drain.records.length) {
        // An expired drain lease re-exposes the rows for the next cycle and a
        // re-materialization of already-applied records commits nothing, so a
        // partial ack is re-delivery by design, not a failure.
        console.warn(
          `state ack count ${acked} was below drained count ${drain.records.length}; rows re-drain next cycle`,
        );
      }
      summary.acked += acked;
    } catch (error) {
      summary.errors += 1;
      console.warn(`state-materializer cycle failed: ${errorMessage(error)}`);
      break;
    }
  }
  return finish();
}

export function applyStateMaterializationPlan(plan: StateMaterializationPlan, root: string): void {
  const resolvedRoot = resolve(root);
  for (const write of plan.writes) {
    const target = resolve(resolvedRoot, write.path);
    if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${sep}`)) {
      throw new Error(`refusing state materialization outside checkout: ${write.path}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, write.content, "utf8");
  }
}

function materializationPaths(records: readonly StateAppendRecord[]): string[] {
  const paths: string[] = [];
  for (const record of records) {
    const path =
      record.kind === "sweep_status"
        ? sweepStatusPathForStateKey(record.key)
        : record.kind === "comment_router"
          ? COMMENT_ROUTER_LEDGER_PATH
          : record.key;
    if (record.kind === "apply_proof" && !isActionEventPublishPath(path)) {
      throw new Error(`invalid apply proof ledger path: ${path}`);
    }
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}

function readCurrentFiles(paths: readonly string[], root: string): Map<string, string> {
  const resolvedRoot = resolve(root);
  const files = new Map<string, string>();
  for (const path of paths) {
    const target = resolve(resolvedRoot, path);
    if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${sep}`)) {
      throw new Error(`refusing state read outside checkout: ${path}`);
    }
    if (existsSync(target)) files.set(path, readFileSync(target, "utf8"));
  }
  return files;
}

async function drainStateWindow(options: {
  queueUrl: string;
  webhookSecret: string;
  maximumRows: number;
  maximumBytes: number;
  fetchImpl: typeof fetch;
}): Promise<StateDrainResponse> {
  const body = await postSignedStateRequest({
    ...options,
    path: "/internal/state/drain",
    payload: { max_rows: options.maximumRows, max_bytes: options.maximumBytes },
  });
  if (body.ok !== true || !Array.isArray(body.records)) {
    throw new Error("POST /internal/state/drain returned an invalid response");
  }
  const token = body.drain_token === null ? null : String(body.drain_token || "").trim();
  if (body.records.length > 0 && !token) {
    throw new Error("POST /internal/state/drain returned records without a token");
  }
  const records = body.records.map(stateAppendRecordFrom);
  selectLatestStateRecords(records);
  return { token, records };
}

async function ackStateWindow(options: {
  queueUrl: string;
  webhookSecret: string;
  drainToken: string;
  fetchImpl: typeof fetch;
}): Promise<number> {
  const body = await postSignedStateRequest({
    ...options,
    path: "/internal/state/ack",
    payload: { drain_token: options.drainToken },
  });
  const acked = Number(body.acked);
  if (body.ok !== true || !Number.isSafeInteger(acked) || acked < 0) {
    throw new Error("POST /internal/state/ack returned an invalid response");
  }
  return acked;
}

async function postSignedStateRequest(options: {
  queueUrl: string;
  webhookSecret: string;
  path: string;
  payload: unknown;
  fetchImpl: typeof fetch;
}): Promise<Record<string, unknown>> {
  const body = JSON.stringify(options.payload);
  const signature = `sha256=${createHmac("sha256", options.webhookSecret)
    .update(body)
    .digest("hex")}`;
  const response = await options.fetchImpl(`${options.queueUrl}${options.path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-clawsweeper-exact-review-signature": signature,
    },
    body,
  });
  if (!response.ok) throw new Error(`POST ${options.path} returned ${response.status}`);
  const value = (await response.json().catch(() => null)) as unknown;
  if (!isRecord(value)) throw new Error(`POST ${options.path} returned invalid JSON`);
  return value;
}

function stateAppendRecordFrom(value: unknown): StateAppendRecord {
  if (!isRecord(value)) throw new Error("state drain record must be an object");
  if (!Object.hasOwn(value, "payload")) throw new Error("state drain record has no payload");
  const record = {
    seq: Number(value.seq),
    kind: String(value.kind || "") as StateAppendKind,
    key: String(value.key || "").trim(),
    payload: value.payload,
    produced_at: String(value.produced_at || "").trim(),
    delivery_id: String(value.delivery_id || "").trim(),
  };
  assertStateAppendRecord(record);
  return record;
}

function assertStateAppendRecord(record: StateAppendRecord): void {
  if (!Number.isSafeInteger(record.seq) || record.seq < 1) {
    throw new Error("state drain record has an invalid sequence");
  }
  if (!STATE_APPEND_KINDS.has(record.kind)) {
    throw new Error(`state drain record has an invalid kind: ${record.kind}`);
  }
  if (!record.key || record.key.length > 2_048) {
    throw new Error("state drain record has an invalid key");
  }
  if (record.payload === undefined) throw new Error("state drain record has no payload");
  if (!record.produced_at || !Number.isFinite(Date.parse(record.produced_at))) {
    throw new Error("state drain record has an invalid produced_at");
  }
  if (!record.delivery_id) throw new Error("state drain record has no delivery_id");
}

function boundedPositiveInteger(
  value: string | undefined,
  fallback: number,
  maximum: number,
): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactStateSecrets(message);
}

let stateSecretsToRedact: string[] = [];

function registerStateSecretForRedaction(secret: string): void {
  if (secret && !stateSecretsToRedact.includes(secret)) stateSecretsToRedact.push(secret);
}

// Error text can transit request internals; never let a registered secret
// value reach the log stream in clear text.
function redactStateSecrets(message: string): string {
  let redacted = message;
  for (const secret of stateSecretsToRedact) {
    redacted = redacted.split(secret).join("<redacted>");
  }
  return redacted;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const summary = await runStateMaterializer();
    if (summary.errors > 0) process.exitCode = 1;
  } catch (error) {
    console.warn(`state-materializer failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}
