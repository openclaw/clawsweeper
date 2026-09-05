import { requiredEnv } from "../required-env.js";
import { createHmac } from "node:crypto";
import fs from "node:fs";

import type {
  BatchPublicationIdentity,
  PreparedStateMutationOperation,
  PreparedStateMutationPlan,
} from "./state-publication-mutation.js";

export const DIRECT_PUBLICATION_MAX_POST_BYTES = 4 * 1024 * 1024;
const DEFAULT_ATTEMPTS = 3;

export type DirectPublicationOperation = PreparedStateMutationOperation & {
  contentBase64?: string;
};

export type DirectPublicationLifecycleKind =
  | "router"
  | "router_deferred_coverage"
  | "router_not_required"
  | "requeue"
  | "target_missing"
  | "target_closed"
  | "guarded_open"
  | "policy_noop";

export type DirectPublicationLifecyclePlan = {
  kind: DirectPublicationLifecycleKind;
};

export type DirectPublicationPayload = {
  canonicalTargetKey: string;
  fenceKey: string;
  revision: number;
  sourceSha?: string;
  identity: BatchPublicationIdentity & PreparedStateMutationPlan["identity"];
  operations: DirectPublicationOperation[];
  totalBytes: number;
  lifecycle?: DirectPublicationLifecyclePlan;
};

export type DirectPublicationPostResult =
  | { kind: "accepted"; attempts: number; response: Record<string, unknown> }
  | { kind: "fallback"; attempts: number; reason: string; status?: number };

export function exactReviewDirectPublicationEnabled(value: string | undefined) {
  return value === "1" || value === "true";
}

export function prepareDirectPublicationPayload(options: {
  revision: number;
  plan: PreparedStateMutationPlan;
  sourceSha?: string;
  lifecycle?: DirectPublicationLifecyclePlan;
}): DirectPublicationPayload {
  const publication = options.plan.publication ?? {
    canonicalTargetKey: options.plan.identity.itemKey,
    fenceKey: options.plan.identity.itemKey,
  };
  return {
    canonicalTargetKey: publication.canonicalTargetKey,
    fenceKey: publication.fenceKey,
    revision: options.revision,
    ...(options.sourceSha === undefined ? {} : { sourceSha: options.sourceSha }),
    identity: { ...publication, ...options.plan.identity },
    operations: options.plan.operations.map((operation) => ({ ...operation })),
    totalBytes: options.plan.totalBytes,
    ...(options.lifecycle === undefined ? {} : { lifecycle: options.lifecycle }),
  };
}

export async function postDirectPublicationResult(options: {
  baseUrl: string;
  webhookSecret: string;
  payload: DirectPublicationPayload;
  attempts?: number;
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  path?:
    | "/internal/exact-review/publication-results"
    | "/internal/exact-review/publication-batch-results";
}): Promise<DirectPublicationPostResult> {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  if (!baseUrl.startsWith("https://")) throw new Error("Direct publication URL must use HTTPS");
  if (!options.webhookSecret) throw new Error("Direct publication webhook secret is required");
  const body = JSON.stringify(options.payload);
  const bodyBytes = Buffer.byteLength(body);
  if (bodyBytes > DIRECT_PUBLICATION_MAX_POST_BYTES) {
    console.warn(
      `Direct publication payload truncated before delivery: ${bodyBytes} bytes exceeds ${DIRECT_PUBLICATION_MAX_POST_BYTES}`,
    );
    return { kind: "fallback", attempts: 0, reason: "payload_too_large", status: 413 };
  }
  const signature = `sha256=${createHmac("sha256", options.webhookSecret).update(body).digest("hex")}`;
  const attempts = boundedAttempts(options.attempts ?? DEFAULT_ATTEMPTS);
  const request = options.fetch ?? globalThis.fetch;
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let lastReason = "direct_publication_unavailable";
  let lastStatus: number | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await request(
        `${baseUrl}${options.path ?? "/internal/exact-review/publication-results"}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-clawsweeper-exact-review-signature": signature,
          },
          body,
          signal: AbortSignal.timeout(20_000),
        },
      );
      lastStatus = response.status;
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (
        response.ok &&
        payload.ok === true &&
        (payload.accepted === true || payload.deduped === true || payload.superseded === true)
      ) {
        return { kind: "accepted", attempts: attempt, response: payload };
      }
      const reason = String(payload.error || `http_${response.status}`);
      const detail = typeof payload.detail === "string" ? payload.detail.trim() : "";
      lastReason = detail ? `${reason}: ${detail}` : reason;
      if (
        response.status === 413 ||
        (response.status >= 400 && response.status < 500 && response.status !== 429)
      ) {
        return { kind: "fallback", attempts: attempt, reason: lastReason, status: response.status };
      }
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    }
    if (attempt < attempts) await sleep(attempt * 5_000);
  }
  return {
    kind: "fallback",
    attempts,
    reason: lastReason,
    ...(lastStatus === undefined ? {} : { status: lastStatus }),
  };
}

export async function runExactReviewDirectPublicationFromEnv() {
  if (!exactReviewDirectPublicationEnabled(process.env.EXACT_REVIEW_DIRECT_PUBLICATION_ENABLED)) {
    writeGithubOutput("accepted", "false");
    writeGithubOutput("fallback", "true");
    writeGithubOutput("reason", "direct_publication_disabled");
    return;
  }
  const outputPath = requiredEnv("EXACT_REVIEW_DIRECT_MUTATION_OUTPUT");
  const outcome = JSON.parse(fs.readFileSync(outputPath, "utf8")) as {
    kind?: string;
    plan?: PreparedStateMutationPlan;
    disposition?: unknown;
  };
  if (outcome.kind !== "eligible" || !outcome.plan) {
    writeGithubOutput("accepted", "false");
    writeGithubOutput("fallback", "true");
    writeGithubOutput("reason", `mutation_${String(outcome.kind || "missing")}`);
    return;
  }
  const sourceAction = process.env.EXACT_REVIEW_DIRECT_SOURCE_ACTION;
  if (typeof sourceAction !== "string" || sourceAction.length === 0) {
    writeGithubOutput("accepted", "false");
    writeGithubOutput("fallback", "true");
    writeGithubOutput("reason", "invalid_direct_source_action");
    return;
  }
  const lifecycle = directPublicationLifecyclePlanFromOutcome(outcome.disposition, sourceAction);
  if (!lifecycle) {
    writeGithubOutput("accepted", "false");
    writeGithubOutput("fallback", "true");
    writeGithubOutput("reason", "invalid_direct_lifecycle");
    return;
  }
  const payload = prepareDirectPublicationPayload({
    revision: positiveInteger(requiredEnv("EXACT_REVIEW_DIRECT_REVISION"), "revision"),
    plan: outcome.plan,
    sourceSha: requiredExactShaEnv("GITHUB_SHA"),
    lifecycle,
  });
  const result = await postDirectPublicationResult({
    baseUrl: requiredEnv("EXACT_REVIEW_QUEUE_URL"),
    webhookSecret: requiredEnv("CLAWSWEEPER_WEBHOOK_SECRET"),
    payload,
  });
  writeGithubOutput("accepted", result.kind === "accepted" ? "true" : "false");
  writeGithubOutput("fallback", result.kind === "fallback" ? "true" : "false");
  writeGithubOutput("attempts", String(result.attempts));
  writeGithubOutput(
    "superseded",
    result.kind === "accepted" && result.response.superseded === true ? "true" : "false",
  );
  if (result.kind === "fallback") {
    writeGithubOutput("reason", result.reason.replace(/[\r\n]/g, " ").slice(0, 500));
    console.warn(`Direct exact-review publication deferred to the durable queue: ${result.reason}`);
  }
}

function directPublicationLifecyclePlanFromOutcome(
  value: unknown,
  sourceAction: string | undefined,
): DirectPublicationLifecyclePlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const disposition = value as Record<string, unknown>;
  const expectedBoolean = (name: string) => disposition[name] === true;
  const guardedOpenAction = disposition.guardedOpenAction;
  if (
    typeof guardedOpenAction !== "string" &&
    guardedOpenAction !== null &&
    guardedOpenAction !== undefined
  ) {
    return null;
  }
  if (expectedBoolean("requeueLatestExpected")) return { kind: "requeue" };
  if (expectedBoolean("terminalMissingExpected")) return { kind: "target_missing" };
  if (expectedBoolean("terminalClosedExpected")) return { kind: "target_closed" };
  if (typeof guardedOpenAction === "string" && guardedOpenAction.length > 0) {
    return { kind: "guarded_open" };
  }
  if (sourceAction === "failed_review_shard_recovery") return { kind: "router_not_required" };
  if (expectedBoolean("routableSyncExpected")) return { kind: "router" };
  if (expectedBoolean("deferredCloseCoverageExpected")) {
    return { kind: "router_deferred_coverage" };
  }
  if (
    [
      "requeueLatestExpected",
      "terminalMissingExpected",
      "terminalClosedExpected",
      "routableSyncExpected",
      "deferredCloseCoverageExpected",
    ].some((name) => disposition[name] !== false && disposition[name] !== true)
  ) {
    return null;
  }
  return { kind: "policy_noop" };
}

function boundedAttempts(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 5) {
    throw new Error("Direct publication attempts must be between 1 and 5");
  }
  return value;
}

function requiredExactShaEnv(name: string) {
  const value = process.env[name];
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
    throw new Error(`${name} must be an exact lowercase commit SHA`);
  }
  return value;
}

function positiveInteger(value: string, label: string) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`Invalid ${label}`);
  return number;
}

function writeGithubOutput(key: string, value: string) {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) return;
  fs.appendFileSync(path, `${key}=${value}\n`, "utf8");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runExactReviewDirectPublicationFromEnv().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
