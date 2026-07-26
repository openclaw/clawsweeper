import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  PreparedStateMutationOperation,
  PreparedStateMutationPlan,
} from "./state-publication-mutation.js";

export const DIRECT_PUBLICATION_MAX_POST_BYTES = 4 * 1024 * 1024;
const DEFAULT_ATTEMPTS = 3;

export type DirectPublicationOperation = PreparedStateMutationOperation & {
  contentBase64?: string;
};

export type DirectPublicationPayload = {
  itemKey: string;
  revision: number;
  identity: PreparedStateMutationPlan["identity"];
  operations: DirectPublicationOperation[];
  totalBytes: number;
};

export type DirectPublicationPostResult =
  | { kind: "accepted"; attempts: number; response: Record<string, unknown> }
  | { kind: "fallback"; attempts: number; reason: string; status?: number };

export function exactReviewDirectPublicationEnabled(value: string | undefined) {
  return value === "1" || value === "true";
}

export function prepareDirectPublicationPayload(options: {
  itemKey: string;
  revision: number;
  plan: PreparedStateMutationPlan;
  stateRoot: string;
}): DirectPublicationPayload {
  const operations = options.plan.operations.map((operation): DirectPublicationOperation => {
    if (operation.targetOid === null) return { ...operation };
    const content = fs.readFileSync(path.join(options.stateRoot, operation.path));
    if (content.byteLength !== operation.bytes) {
      throw new Error(`Prepared blob size changed for ${operation.path}`);
    }
    return { ...operation, contentBase64: content.toString("base64") };
  });
  return {
    itemKey: options.itemKey,
    revision: options.revision,
    identity: { ...options.plan.identity },
    operations,
    totalBytes: options.plan.totalBytes,
  };
}

export async function postDirectPublicationResult(options: {
  baseUrl: string;
  webhookSecret: string;
  payload: DirectPublicationPayload;
  attempts?: number;
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<void>;
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
      const response = await request(`${baseUrl}/internal/exact-review/publication-results`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-clawsweeper-exact-review-signature": signature,
        },
        body,
        signal: AbortSignal.timeout(20_000),
      });
      lastStatus = response.status;
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (
        response.ok &&
        payload.ok === true &&
        (payload.accepted === true || payload.deduped === true || payload.superseded === true)
      ) {
        return { kind: "accepted", attempts: attempt, response: payload };
      }
      lastReason = String(payload.error || `http_${response.status}`);
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
  };
  if (outcome.kind !== "eligible" || !outcome.plan) {
    writeGithubOutput("accepted", "false");
    writeGithubOutput("fallback", "true");
    writeGithubOutput("reason", `mutation_${String(outcome.kind || "missing")}`);
    return;
  }
  const payload = prepareDirectPublicationPayload({
    itemKey: requiredEnv("EXACT_REVIEW_DIRECT_ITEM_KEY"),
    revision: positiveInteger(requiredEnv("EXACT_REVIEW_DIRECT_REVISION"), "revision"),
    plan: outcome.plan,
    stateRoot: requiredEnv("CLAWSWEEPER_STATE_DIR"),
  });
  const result = await postDirectPublicationResult({
    baseUrl: requiredEnv("EXACT_REVIEW_QUEUE_URL"),
    webhookSecret: requiredEnv("CLAWSWEEPER_WEBHOOK_SECRET"),
    payload,
  });
  writeGithubOutput("accepted", result.kind === "accepted" ? "true" : "false");
  writeGithubOutput("fallback", result.kind === "fallback" ? "true" : "false");
  writeGithubOutput("attempts", String(result.attempts));
  if (result.kind === "fallback") {
    writeGithubOutput("reason", result.reason.replace(/[\r\n]/g, " ").slice(0, 500));
    console.warn(`Direct exact-review publication fell back to the legacy queue: ${result.reason}`);
  }
}

function boundedAttempts(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 5) {
    throw new Error("Direct publication attempts must be between 1 and 5");
  }
  return value;
}

function requiredEnv(name: string) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
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
