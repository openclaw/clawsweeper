import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";

import type { DirectReReviewIntake } from "./direct-re-review-admission.js";

const COMMAND_INTAKE_PATH = "/internal/exact-review/command-intake";
const REQUEST_TIMEOUT_MS = 15_000;

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
      "--max-time",
      String(REQUEST_TIMEOUT_MS / 1_000),
      ...headerArgs,
      "--data-binary",
      "@-",
      request.url,
    ],
    { encoding: "utf8", input: request.body },
  );
  if (response.status !== 0) {
    throw new Error(`exact re-review command intake failed: ${response.stderr || response.stdout}`);
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
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`exact-review command intake failed (HTTP ${response.status})`);
  }
  return commandIntakeAdmissionResult(result);
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
