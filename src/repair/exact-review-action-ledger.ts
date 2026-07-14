import { createHash, createHmac } from "node:crypto";
import fs from "node:fs";

import {
  repairHttpMutationOutcome,
  runRepairMutationAsync,
  type RepairLifecycleInput,
  type RepairMutationOutcome,
} from "./repair-action-ledger.js";

export type ExactReviewQueueCommand = "enqueue" | "claim" | "complete" | "reconcile";

type JsonObject = Record<string, unknown>;

type ExactReviewQueueRequest = {
  command: ExactReviewQueueCommand;
  endpoint: string;
  headers: Record<string, string>;
  payload: JsonObject;
  lifecycle: RepairLifecycleInput;
  parseAcceptedResponse?: (response: Response) => Promise<Record<string, string>>;
};

type ExactReviewQueueDependencies = {
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  attempts?: number;
  timeoutMs?: number;
};

export async function runExactReviewQueueCommand(
  command: ExactReviewQueueCommand,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: ExactReviewQueueDependencies = {},
): Promise<Record<string, string>> {
  prepareLedgerDirectories(env);
  const request = exactReviewQueueRequest(command, env);
  const fetchImpl = dependencies.fetch ?? fetch;
  const sleep = dependencies.sleep ?? defaultSleep;
  const attempts = dependencies.attempts ?? 3;
  const timeoutMs = dependencies.timeoutMs ?? (command === "reconcile" ? 120_000 : 20_000);
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new Error("exact-review request attempt count is invalid");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new Error("exact-review request timeout is invalid");
  }

  const body = JSON.stringify(request.payload);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await runRepairMutationAsync(request.lifecycle, {
        kind: `exact_review_${command}`,
        operationName: "exact_review_queue",
        component: `exact_review_queue_${command}`,
        identity: request.payload,
        operation: async () => {
          const response = await fetchImpl(request.endpoint, {
            method: "POST",
            headers: request.headers,
            body,
            redirect: "manual",
            signal: AbortSignal.timeout(timeoutMs),
          });
          const outcome = exactReviewQueueHttpOutcome(response);
          if (outcome !== "accepted" || !request.parseAcceptedResponse) {
            return { outcome, outputs: {} };
          }
          return {
            outcome,
            outputs: await request.parseAcceptedResponse(response),
          };
        },
        outcome: (result) => result.outcome,
      });
      if (result.outcome === "accepted") return result.outputs;
    } catch {
      // The mutation wrapper records transport and response-validation failures as unknown.
    }
    if (attempt < attempts) await sleep(attempt * 5_000);
  }
  throw new Error(`exact-review ${command} request failed after ${attempts} attempts`);
}

export function exactReviewQueueHttpOutcome(response: {
  ok: boolean;
  status: number;
}): RepairMutationOutcome {
  if (response.ok) return "accepted";
  if (
    response.status >= 400 &&
    response.status < 500 &&
    ![408, 425, 429].includes(response.status)
  ) {
    return "rejected";
  }
  return repairHttpMutationOutcome(response);
}

function exactReviewQueueRequest(
  command: ExactReviewQueueCommand,
  env: NodeJS.ProcessEnv,
): ExactReviewQueueRequest {
  if (command === "enqueue") return enqueueRequest(env);
  if (command === "claim") return claimRequest(env);
  if (command === "complete") return completeRequest(env);
  return reconcileRequest(env);
}

function enqueueRequest(env: NodeJS.ProcessEnv): ExactReviewQueueRequest {
  const dispatch = parseObject(requiredEnv(env, "CLIENT_PAYLOAD"), "CLIENT_PAYLOAD");
  const itemKind = dispatch.item_kind === "pull_request" ? "pull_request" : "issue";
  const sourceEvent = dispatch.source_event === "pull_request" ? "pull_request" : "issues";
  const targetRepo = normalizedRepository(dispatch.target_repo ?? "openclaw/openclaw");
  const itemNumber = positiveInteger(dispatch.item_number, "item_number");
  const dispatchKey = stringValue(dispatch.dispatch_key);
  const deliveryId = dispatchKey
    ? `router:${dispatchKey}`
    : `legacy:${requiredEnv(env, "GITHUB_RUN_ID")}:${positiveInteger(
        env.GITHUB_RUN_ATTEMPT,
        "GITHUB_RUN_ATTEMPT",
      )}`;
  const decision: JsonObject = {
    targetRepo,
    targetBranch: stringValue(dispatch.target_branch) || "main",
    itemNumber,
    itemKind,
    sourceEvent,
    sourceAction: stringValue(dispatch.source_action) || "legacy_dispatch",
    supersedesInProgress: dispatch.supersedes_in_progress === true,
  };
  copyFiniteNumber(dispatch, decision, "codex_timeout_ms", "codexTimeoutMs");
  copyFiniteNumber(dispatch, decision, "media_proof_timeout_ms", "mediaProofTimeoutMs");
  copyFiniteNumber(dispatch, decision, "source_comment_id", "sourceCommentId");
  copyPresent(dispatch, decision, "command_status_marker", "commandStatusMarker");
  copyPresent(dispatch, decision, "status_comment_id", "statusCommentId");
  copyPresent(dispatch, decision, "additional_prompt", "additionalPrompt");
  const payload = { delivery_id: deliveryId, decision };
  return signedRequest(
    "enqueue",
    env,
    payload,
    targetRepo,
    itemNumber,
    {
      deliveryId,
      itemKey: `${targetRepo}#${itemNumber}`,
    },
    parseEnqueueResponse,
  );
}

function claimRequest(env: NodeJS.ProcessEnv): ExactReviewQueueRequest {
  const dispatch = parseObject(requiredEnv(env, "DISPATCH_PAYLOAD"), "DISPATCH_PAYLOAD");
  const leaseId = requiredEnv(env, "QUEUE_LEASE_ID");
  const runAttempt = positiveInteger(env.RUN_ATTEMPT ?? env.GITHUB_RUN_ATTEMPT, "RUN_ATTEMPT");
  const requestedItemKey = stringValue(env.ITEM_KEY);
  const rawLeaseRevision = stringValue(env.QUEUE_LEASE_REVISION);
  const hasTuple = Boolean(requestedItemKey || rawLeaseRevision);
  const leaseRevision = hasTuple ? positiveInteger(rawLeaseRevision, "QUEUE_LEASE_REVISION") : null;
  if (hasTuple && !requestedItemKey) {
    throw new Error("ITEM_KEY is required with QUEUE_LEASE_REVISION");
  }
  const payload: JsonObject = {
    lease_id: leaseId,
    ...(hasTuple
      ? {
          item_key: requestedItemKey,
          lease_revision: leaseRevision,
        }
      : {}),
    run_id: requiredEnv(env, "GITHUB_RUN_ID"),
    run_attempt: runAttempt,
  };
  const fallback = exactReviewTarget(dispatch, requestedItemKey, env);
  return unsignedRequest(
    "claim",
    env,
    payload,
    fallback.repository,
    fallback.number,
    {
      itemKey: requestedItemKey || null,
      leaseRevision,
      leaseIdSha256: sha256(leaseId),
      runId: payload.run_id,
      runAttempt,
    },
    (response) =>
      parseClaimResponse(response, {
        dispatch,
        requestedItemKey,
        requestedLeaseRevision: leaseRevision,
        leaseId,
      }),
  );
}

function completeRequest(env: NodeJS.ProcessEnv): ExactReviewQueueRequest {
  const leaseId = requiredEnv(env, "QUEUE_LEASE_ID");
  const protocolVersion = positiveInteger(env.PROTOCOL_VERSION, "PROTOCOL_VERSION");
  if (protocolVersion !== 1 && protocolVersion !== 2) {
    throw new Error("PROTOCOL_VERSION must be 1 or 2");
  }
  const runAttempt = positiveInteger(env.RUN_ATTEMPT ?? env.GITHUB_RUN_ATTEMPT, "RUN_ATTEMPT");
  const itemKey = stringValue(env.ITEM_KEY);
  const leaseRevision =
    protocolVersion === 2
      ? positiveInteger(env.QUEUE_LEASE_REVISION, "QUEUE_LEASE_REVISION")
      : null;
  const claimGeneration =
    protocolVersion === 2 ? positiveInteger(env.CLAIM_GENERATION, "CLAIM_GENERATION") : null;
  if (protocolVersion === 2 && !itemKey) throw new Error("ITEM_KEY is required for protocol 2");
  const primaryOutcome = stringValue(env.PRIMARY_OUTCOME);
  const outcome = ["success", "cancelled", "failure"].includes(primaryOutcome)
    ? primaryOutcome
    : "failure";
  const retryAt = stringValue(env.RETRY_AT);
  if (retryAt && !Number.isFinite(Date.parse(retryAt))) {
    throw new Error("RETRY_AT must be an ISO timestamp");
  }
  const requeueLatest = env.REQUEUE_LATEST === "true";
  const payload: JsonObject = {
    lease_id: leaseId,
    ...(protocolVersion === 2
      ? {
          item_key: itemKey,
          lease_revision: leaseRevision,
          claim_generation: claimGeneration,
        }
      : {}),
    run_id: requiredEnv(env, "GITHUB_RUN_ID"),
    run_attempt: runAttempt,
    outcome,
    ...(retryAt ? { retry_at: retryAt } : {}),
    ...(requeueLatest ? { requeue_latest: true } : {}),
  };
  const target = exactReviewTarget({}, itemKey, env);
  return unsignedRequest("complete", env, payload, target.repository, target.number, {
    itemKey: itemKey || null,
    leaseRevision,
    claimGeneration,
    leaseIdSha256: sha256(leaseId),
    runId: payload.run_id,
    runAttempt,
    outcome,
    retryAt: retryAt || null,
    requeueLatest,
  });
}

function reconcileRequest(env: NodeJS.ProcessEnv): ExactReviewQueueRequest {
  const sourceRunId = requiredEnv(env, "SOURCE_RUN_ID");
  if (!/^\d+$/.test(sourceRunId)) throw new Error("SOURCE_RUN_ID must be numeric");
  const sourceRunAttempt = positiveInteger(env.SOURCE_RUN_ATTEMPT, "SOURCE_RUN_ATTEMPT");
  const payload = {
    runs: [
      {
        run_id: sourceRunId,
        run_attempt: sourceRunAttempt,
      },
    ],
    include_all_claimed: true,
  };
  const repository = normalizedRepository(env.GITHUB_REPOSITORY ?? "openclaw/clawsweeper");
  return signedRequest("reconcile", env, payload, repository, null, {
    sourceRunId,
    sourceRunAttempt,
  });
}

function signedRequest(
  command: "enqueue" | "reconcile",
  env: NodeJS.ProcessEnv,
  payload: JsonObject,
  repository: string,
  number: number | null,
  businessIdentity: unknown,
  parseAcceptedResponse?: (response: Response) => Promise<Record<string, string>>,
): ExactReviewQueueRequest {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", requiredEnv(env, "CLAWSWEEPER_WEBHOOK_SECRET"))
    .update(body)
    .digest("hex")}`;
  return request(
    command,
    env,
    payload,
    repository,
    number,
    businessIdentity,
    {
      "content-type": "application/json",
      "x-clawsweeper-exact-review-signature": signature,
    },
    parseAcceptedResponse,
  );
}

function unsignedRequest(
  command: "claim" | "complete",
  env: NodeJS.ProcessEnv,
  payload: JsonObject,
  repository: string,
  number: number | null,
  businessIdentity: unknown,
  parseAcceptedResponse?: (response: Response) => Promise<Record<string, string>>,
): ExactReviewQueueRequest {
  return request(
    command,
    env,
    payload,
    repository,
    number,
    businessIdentity,
    { "content-type": "application/json" },
    parseAcceptedResponse,
  );
}

function request(
  command: ExactReviewQueueCommand,
  env: NodeJS.ProcessEnv,
  payload: JsonObject,
  repository: string,
  number: number | null,
  businessIdentity: unknown,
  headers: Record<string, string>,
  parseAcceptedResponse?: (response: Response) => Promise<Record<string, string>>,
): ExactReviewQueueRequest {
  const identitySha256 = sha256(JSON.stringify(businessIdentity));
  return {
    command,
    endpoint: `${queueUrl(env)}/internal/exact-review/${command}`,
    headers,
    payload,
    lifecycle: {
      repository,
      workKey: `exact-review:${command}:${identitySha256}`,
      ...(number ? { number } : {}),
      subjectKind: "queue_item",
      subjectId: `exact-review-${command}-${identitySha256.slice(0, 24)}`,
    },
    ...(parseAcceptedResponse ? { parseAcceptedResponse } : {}),
  };
}

async function parseClaimResponse(
  response: Response,
  context: {
    dispatch: JsonObject;
    requestedItemKey: string;
    requestedLeaseRevision: number | null;
    leaseId: string;
  },
): Promise<Record<string, string>> {
  const text = await boundedResponseText(response);
  const parsed = parseObject(text, "claim response");
  const responseProtocol = Number(parsed.protocol_version || 1);
  if (responseProtocol !== 1 && responseProtocol !== 2) {
    throw new Error("claim response protocol is invalid");
  }
  if (parsed.claimed !== true) throw new Error("claim response was not accepted");

  const reviewOptions = objectValue(context.dispatch.review_options);
  const legacyDecision: JsonObject = {
    targetRepo: stringValue(context.dispatch.target_repo),
    targetBranch: stringValue(context.dispatch.target_branch) || "main",
    itemNumber: Number(context.dispatch.item_number),
    itemKind: stringValue(context.dispatch.item_kind),
    sourceEvent: stringValue(context.dispatch.source_event),
    sourceAction: stringValue(context.dispatch.source_action) || "legacy_dispatch",
    supersedesInProgress: context.dispatch.supersedes_in_progress === true,
  };
  copyFiniteNumber(reviewOptions, legacyDecision, "codex_timeout_ms", "codexTimeoutMs");
  copyFiniteNumber(reviewOptions, legacyDecision, "media_proof_timeout_ms", "mediaProofTimeoutMs");
  copyFiniteNumber(reviewOptions, legacyDecision, "source_comment_id", "sourceCommentId");
  copyPresent(reviewOptions, legacyDecision, "command_status_marker", "commandStatusMarker");
  copyPresent(reviewOptions, legacyDecision, "status_comment_id", "statusCommentId");
  copyPresent(reviewOptions, legacyDecision, "additional_prompt", "additionalPrompt");
  const decision =
    parsed.decision && typeof parsed.decision === "object" && !Array.isArray(parsed.decision)
      ? (parsed.decision as JsonObject)
      : legacyDecision;
  const targetRepo = normalizedRepository(decision.targetRepo);
  const itemNumber = positiveInteger(decision.itemNumber, "claim decision itemNumber");
  const itemKey = `${targetRepo}#${itemNumber}`;
  const leaseRevision =
    responseProtocol === 2
      ? Number(parsed.lease_revision)
      : Number(
          parsed.revision || parsed.lease_revision || context.requestedLeaseRevision || Number.NaN,
        );
  const claimGeneration = Number(parsed.claim_generation);
  if (
    (decision.itemKind !== "issue" && decision.itemKind !== "pull_request") ||
    (decision.sourceEvent !== "issues" && decision.sourceEvent !== "pull_request") ||
    !stringValue(decision.sourceAction)
  ) {
    throw new Error("claim decision is invalid");
  }
  if (parsed.item_key && parsed.item_key !== itemKey) {
    throw new Error("claim response item key is invalid");
  }
  if (context.requestedItemKey && context.requestedItemKey !== itemKey) {
    throw new Error("claim response target does not match the requested item");
  }
  if (
    responseProtocol === 2 &&
    (!parsed.decision ||
      typeof parsed.decision !== "object" ||
      Array.isArray(parsed.decision) ||
      parsed.item_key !== context.requestedItemKey ||
      parsed.lease_revision !== context.requestedLeaseRevision ||
      !Number.isInteger(claimGeneration) ||
      claimGeneration < 1)
  ) {
    throw new Error("claim response lease tuple is invalid");
  }
  return {
    lease_id: context.leaseId,
    item_key: itemKey,
    lease_revision: Number.isInteger(leaseRevision) ? String(leaseRevision) : "",
    claim_generation: responseProtocol === 2 ? String(claimGeneration) : "",
    protocol_version: String(responseProtocol),
    decision: JSON.stringify(decision),
  };
}

async function parseEnqueueResponse(response: Response): Promise<Record<string, string>> {
  const parsed = parseObject(await boundedResponseText(response), "enqueue response");
  if (
    parsed.ok !== true ||
    (parsed.queued !== true && parsed.deduped !== true && parsed.accepted !== false)
  ) {
    throw new Error("enqueue response was not acknowledged");
  }
  return {};
}

async function boundedResponseText(response: Response): Promise<string> {
  const body = response.body;
  if (!body) return "";

  const limit = 1024 * 1024;
  const chunks: Buffer[] = [];
  const reader = body.getReader();
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the response-size failure if cancellation also fails.
        }
        throw new Error("exact-review response exceeds 1 MiB");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

function exactReviewTarget(
  dispatch: JsonObject,
  itemKey: string,
  env: NodeJS.ProcessEnv,
): { repository: string; number: number | null } {
  const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9]\d*)$/.exec(itemKey);
  if (match) {
    return {
      repository: normalizedRepository(match[1]),
      number: positiveInteger(match[2], "item key number"),
    };
  }
  const repository = normalizedRepository(
    dispatch.target_repo ?? env.GITHUB_REPOSITORY ?? "openclaw/clawsweeper",
  );
  const rawNumber = Number(dispatch.item_number);
  return {
    repository,
    number: Number.isSafeInteger(rawNumber) && rawNumber > 0 ? rawNumber : null,
  };
}

function queueUrl(env: NodeJS.ProcessEnv): string {
  const raw = requiredEnv(env, "QUEUE_URL").replace(/\/+$/, "");
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("QUEUE_URL protocol is invalid");
  }
  if (parsed.username || parsed.password) {
    throw new Error("QUEUE_URL credentials are not supported");
  }
  return parsed.toString().replace(/\/+$/, "");
}

function prepareLedgerDirectories(env: NodeJS.ProcessEnv): void {
  for (const name of [
    "CLAWSWEEPER_ACTION_LEDGER_ROOT",
    "CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT",
  ] as const) {
    const directory = stringValue(env[name]);
    if (directory) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
}

function parseObject(value: string, label: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be an object`);
  }
  return parsed as JsonObject;
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function copyFiniteNumber(
  source: JsonObject,
  target: JsonObject,
  sourceKey: string,
  targetKey: string,
): void {
  const value = Number(source[sourceKey]);
  if (Number.isFinite(value)) target[targetKey] = value;
}

function copyPresent(
  source: JsonObject,
  target: JsonObject,
  sourceKey: string,
  targetKey: string,
): void {
  if (Object.hasOwn(source, sourceKey)) target[targetKey] = source[sourceKey];
}

function normalizedRepository(value: unknown): string {
  const repository = stringValue(value);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("exact-review repository is invalid");
  }
  return repository;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = stringValue(env[name]);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
