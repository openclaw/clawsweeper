import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";

import type { DirectReReviewIntake } from "./direct-re-review-admission.js";
import { queueResponseErrorCode, responseErrorCode } from "./exact-review-queue-transport-error.js";

const COMMAND_INTAKE_PATH = "/internal/exact-review/command-intake";
const REQUEST_TIMEOUT_MS = 15_000;
const COMMAND_INTAKE_ERROR_CODES = new Set([
  "webhook_not_configured",
  "invalid_signature",
  "exact_review_queue_not_configured",
  "exact_review_queue_unavailable",
  "private_target_unsupported",
  "target_visibility_unverified",
  "invalid_command_intake",
]);

export type CommandIntakeAdmissionResult =
  | { kind: "accepted"; deduped: boolean; commandVersionId: string }
  | { kind: "stale"; reason: string; commandVersionId: string };

export function signedExactReviewQueueRequest(options: {
  queueUrl: string;
  secret: string;
  intake: DirectReReviewIntake;
}) {
  if (!options.secret) throw new Error("internal exact-review queue secret is required");
  const body = JSON.stringify(options.intake);
  return {
    url: `${options.queueUrl.replace(/\/$/, "")}${COMMAND_INTAKE_PATH}`,
    body,
    headers: {
      "content-type": "application/json",
      "x-clawsweeper-exact-review-signature": `sha256=${createHmac("sha256", options.secret).update(body).digest("hex")}`,
    },
  };
}

export function postExactReviewCommandIntakeSync(options: {
  queueUrl: string;
  secret: string;
  intake: DirectReReviewIntake;
}) {
  const request = signedExactReviewQueueRequest(options);
  const headerArgs = Object.entries(request.headers).flatMap(([name, value]) => [
    "--header",
    `${name}: ${value}`,
  ]);
  const response = spawnSync(
    "curl",
    [
      "--silent",
      "--show-error",
      "--fail-with-body",
      "--write-out",
      "%{stderr}\n%{http_code}",
      "--max-time",
      String(REQUEST_TIMEOUT_MS / 1_000),
      ...headerArgs,
      "--data-binary",
      "@-",
      request.url,
    ],
    { encoding: "utf8", input: request.body },
  );
  if (response.status !== 0 || response.error) {
    // Curl owns this final numeric field; its earlier stderr can contain private details.
    const status = Number(response.stderr?.match(/\n(\d{3})$/)?.[1]);
    if (!response.error && response.status === 22 && status >= 400 && status <= 599) {
      throw commandIntakeHttpError(status, queueResponseErrorCode(Buffer.from(response.stdout)));
    }
    throw new Error(
      `exact-review command intake failed (curl exit ${response.status ?? "unknown"})`,
    );
  }
  return commandIntakeAdmissionResult(JSON.parse(response.stdout || "null"));
}

export async function postExactReviewCommandIntake(options: {
  queueUrl: string;
  secret: string;
  intake: DirectReReviewIntake;
  fetchImpl?: typeof fetch;
}) {
  const request = signedExactReviewQueueRequest(options);
  const response = await (options.fetchImpl ?? fetch)(request.url, {
    method: "POST",
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw commandIntakeHttpError(response.status, await responseErrorCode(response));
  }
  const result = await response.json().catch(() => null);
  return commandIntakeAdmissionResult(result);
}

function commandIntakeHttpError(status: number, code: string | undefined) {
  return new Error(
    `exact-review command intake failed (HTTP ${status})${code && COMMAND_INTAKE_ERROR_CODES.has(code) ? `: ${code}` : ""}`,
  );
}

export function commandIntakeAdmissionResult(value: unknown): CommandIntakeAdmissionResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("exact-review command intake returned an invalid result");
  }
  const result = value as Record<string, unknown>;
  const commandVersionId = String(result.command_version_id || "");
  if (result.ok !== true || !commandVersionId) {
    throw new Error("exact-review command intake was not accepted");
  }
  if (result.accepted === false && typeof result.reason === "string") {
    return { kind: "stale", reason: result.reason, commandVersionId };
  }
  if (result.accepted === true && typeof result.deduped === "boolean") {
    return {
      kind: "accepted",
      deduped: result.deduped,
      commandVersionId,
    };
  }
  throw new Error("exact-review command intake did not establish durable ownership");
}
