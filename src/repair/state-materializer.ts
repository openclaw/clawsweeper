#!/usr/bin/env node
import { createHmac } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_STATE_MATERIALIZER_MAX_ROWS = 2_000;
export const DEFAULT_STATE_MATERIALIZER_MAX_BYTES = 20 * 1024 * 1024;
export const DEFAULT_STATE_MATERIALIZER_MAX_RUNTIME_MS = 10 * 60 * 1_000;

export type StateMaterializerSummary = {
  drained: number;
  acked: number;
  errors: number;
};

export type StateMaterializerRunOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

type StateDrainResponse = {
  token: string | null;
  recordCount: number;
};

/**
 * Compacts the retired append projection window without materializing files.
 *
 * Canonical records are stored in the Durable Object and ledger/assets blobs
 * are stored in R2. The window remains bounded and drained so old receipts and
 * any in-flight projection rows cannot accumulate after the git projection is
 * removed.
 */
export async function runStateMaterializer(
  options: StateMaterializerRunOptions = {},
): Promise<StateMaterializerSummary> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const queueUrl = (env.QUEUE_URL ?? "").replace(/\/$/, "");
  const webhookSecret = env.CLAWSWEEPER_WEBHOOK_SECRET ?? "";
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
  const startedAt = now().getTime();
  const summary: StateMaterializerSummary = { drained: 0, acked: 0, errors: 0 };
  const finish = (): StateMaterializerSummary => {
    console.log(
      `state-window-compactor: drained=${summary.drained} acked=${summary.acked} errors=${summary.errors}`,
    );
    return summary;
  };

  if (!queueUrl || !webhookSecret) {
    summary.errors += 1;
    console.warn("state-window-compactor skipped: missing queue URL or webhook secret");
    return finish();
  }

  while (now().getTime() - startedAt < maximumRuntimeMs) {
    try {
      const drain = await drainStateWindow({
        queueUrl,
        webhookSecret,
        maximumRows,
        maximumBytes,
        fetchImpl,
      });
      if (drain.recordCount === 0) break;
      if (!drain.token) throw new Error("non-empty state drain omitted its token");
      summary.drained += drain.recordCount;
      const acked = await ackStateWindow({
        queueUrl,
        webhookSecret,
        drainToken: drain.token,
        fetchImpl,
      });
      if (acked > drain.recordCount) {
        throw new Error(`state ack count ${acked} exceeded drained count ${drain.recordCount}`);
      }
      if (acked < drain.recordCount) {
        console.warn(
          `state ack count ${acked} was below drained count ${drain.recordCount}; rows re-drain next cycle`,
        );
      }
      summary.acked += acked;
    } catch (error) {
      summary.errors += 1;
      console.warn(`state-window-compactor cycle failed: ${errorMessage(error)}`);
      break;
    }
  }
  return finish();
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
  return { token, recordCount: body.records.length };
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
  return error instanceof Error ? error.message : String(error);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  const summary = await runStateMaterializer();
  if (summary.errors > 0) process.exitCode = 1;
}
