import type { LiveProofPlan, LiveProofStep } from "../clawsweeper-types.js";
import type { LiveProofDriveStatus } from "./manifest.js";
import type { LiveProofStepLogEntry } from "./drivers.js";

export const LIVE_VERIFICATION_SCHEMA_VERSION = 1;
export const LIVE_VERIFICATION_OUTPUT_MAX_CHARS = 16_000;
export const LIVE_VERIFICATION_COMMENT_OUTPUT_MAX_CHARS = 4_000;

export type LiveVerificationStepStatus = "completed" | "failed" | "not_run";

export interface LiveVerificationStepResult {
  action: LiveProofStep["action"];
  status: LiveVerificationStepStatus;
  detail: string;
  assertion?: string;
  present_at_start?: boolean;
  satisfied?: boolean;
}

export interface LiveVerificationResult {
  schema_version: 1;
  repo: string;
  item: number;
  head_sha: string;
  surface: "browser" | "terminal";
  entry: string;
  drive_status: LiveProofDriveStatus;
  steps: LiveVerificationStepResult[];
  output: string;
  overall_pass: boolean;
  verified_at: string;
}

const RESULT_KEYS = new Set([
  "schema_version",
  "repo",
  "item",
  "head_sha",
  "surface",
  "entry",
  "drive_status",
  "steps",
  "output",
  "overall_pass",
  "verified_at",
]);
const STEP_KEYS = new Set([
  "action",
  "status",
  "detail",
  "assertion",
  "present_at_start",
  "satisfied",
]);
const ACTIONS = new Set([
  "goto",
  "click",
  "fill",
  "press",
  "wait_for",
  "wait",
  "expect_text",
  "run",
  "expect_output",
]);

export function buildLiveVerificationResult(options: {
  repo: string;
  item: number;
  headSha: string;
  plan: LiveProofPlan;
  driveStatus: LiveProofDriveStatus;
  stepLog: readonly LiveProofStepLogEntry[];
  output: string;
  verifiedAt: string;
}): LiveVerificationResult {
  const steps = options.plan.steps.map((step, index): LiveVerificationStepResult => {
    const logged = options.stepLog[index];
    const assertion =
      step.action === "expect_text" || step.action === "expect_output" ? step.text : undefined;
    if (!logged || logged.action !== step.action) {
      return {
        action: step.action,
        status: "not_run",
        detail: "not run after an earlier step failed",
        ...(assertion ? { assertion } : {}),
        ...(assertion ? { present_at_start: false, satisfied: false } : {}),
      };
    }
    const expectation =
      logged.action === "expect_text" || logged.action === "expect_output" ? logged : undefined;
    return {
      action: step.action,
      status: logged.status,
      detail: trimText(logged.detail, 1_000),
      ...(assertion ? { assertion } : {}),
      ...(expectation
        ? {
            present_at_start: expectation.presentAtStart,
            satisfied: expectation.satisfied,
          }
        : {}),
    };
  });
  return {
    schema_version: 1,
    repo: options.repo,
    item: options.item,
    head_sha: options.headSha,
    surface: options.plan.surface as "browser" | "terminal",
    entry: options.plan.entry,
    drive_status: options.driveStatus,
    steps,
    output: trimText(options.output, LIVE_VERIFICATION_OUTPUT_MAX_CHARS),
    overall_pass:
      options.driveStatus === "completed" &&
      steps.every(
        (step) =>
          step.status === "completed" && (step.satisfied === undefined || step.satisfied === true),
      ),
    verified_at: options.verifiedAt,
  };
}

export function parseLiveVerificationResult(value: unknown): LiveVerificationResult {
  const record = requireRecord(value, "live verification result");
  rejectUnexpectedKeys(record, RESULT_KEYS, "live verification result");
  if (record.schema_version !== LIVE_VERIFICATION_SCHEMA_VERSION) {
    throw new Error("live verification result.schema_version must be 1");
  }
  const repo = requireSingleLine(record.repo, "live verification result.repo", 200);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error("live verification result.repo must be owner/repo");
  }
  const item = requirePositiveInteger(record.item, "live verification result.item");
  const headSha = requireSingleLine(
    record.head_sha,
    "live verification result.head_sha",
    40,
  ).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error("live verification result.head_sha must be a 40-character commit SHA");
  }
  if (record.surface !== "browser" && record.surface !== "terminal") {
    throw new Error("live verification result.surface must be browser or terminal");
  }
  const entry = requireSingleLine(record.entry, "live verification result.entry", 2_000);
  if (!Array.isArray(record.steps) || record.steps.length > 10) {
    throw new Error("live verification result.steps must be an array of at most 10 items");
  }
  const steps = record.steps.map((value, index) => parseStep(value, index));
  const output = requireString(record.output, "live verification result.output");
  if (output.length > LIVE_VERIFICATION_OUTPUT_MAX_CHARS) {
    throw new Error(
      `live verification result.output must be at most ${LIVE_VERIFICATION_OUTPUT_MAX_CHARS} characters`,
    );
  }
  if (!["completed", "partial", "failed"].includes(String(record.drive_status))) {
    throw new Error("live verification result.drive_status is invalid");
  }
  if (typeof record.overall_pass !== "boolean") {
    throw new Error("live verification result.overall_pass must be boolean");
  }
  const derivedOverallPass =
    record.drive_status === "completed" &&
    steps.every(
      (step) =>
        step.status === "completed" && (step.satisfied === undefined || step.satisfied === true),
    );
  if (record.overall_pass !== derivedOverallPass) {
    throw new Error("live verification result.overall_pass does not match its step outcomes");
  }
  const verifiedAt = requireSingleLine(
    record.verified_at,
    "live verification result.verified_at",
    100,
  );
  if (
    !Number.isFinite(Date.parse(verifiedAt)) ||
    new Date(Date.parse(verifiedAt)).toISOString() !== verifiedAt
  ) {
    throw new Error("live verification result.verified_at must be an ISO8601 UTC timestamp");
  }
  return {
    schema_version: 1,
    repo,
    item,
    head_sha: headSha,
    surface: record.surface,
    entry,
    drive_status: record.drive_status as LiveProofDriveStatus,
    steps,
    output,
    overall_pass: record.overall_pass,
    verified_at: verifiedAt,
  };
}

export function encodeLiveVerificationReportPayload(result: LiveVerificationResult): string {
  const parsed = parseLiveVerificationResult(result);
  return Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url");
}

export function decodeLiveVerificationReportPayload(value: string): LiveVerificationResult {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 50_000) {
    throw new Error("live verification report payload is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
  } catch (error) {
    throw new Error("live verification report payload is invalid", { cause: error });
  }
  return parseLiveVerificationResult(parsed);
}

export function renderLiveVerificationCommentBlock(result: LiveVerificationResult): string {
  const parsed = parseLiveVerificationResult(result);
  const assertions = parsed.steps.filter((step) => step.assertion !== undefined);
  const assertionLines = assertions.length
    ? assertions.map((step) => {
        const passed = step.status === "completed" && step.satisfied === true;
        return `- ${passed ? "PASS" : "FAIL"} \`${sanitizeInline(step.action)}\`: ${sanitizeInline(step.assertion ?? "")}`;
      })
    : ["- None recorded."];
  const output = sanitizeUntrustedOutput(parsed.output || "<no output captured>");
  return [
    `**Command:** \`${sanitizeInline(parsed.entry)}\``,
    "",
    `**Result:** ${parsed.overall_pass ? "PASS" : "FAIL"} (${parsed.drive_status})`,
    "",
    "```text",
    output,
    "```",
    "",
    "**Assertions:**",
    "",
    ...assertionLines,
  ].join("\n");
}

export function sanitizeUntrustedOutput(value: string): string {
  const normalized = value.replaceAll("\r\n", "\n").replace(/[\r\u2028\u2029]/g, "\n");
  const inert = normalized
    .replaceAll("`", "ˋ")
    .replaceAll("<", "‹")
    .replaceAll(">", "›")
    .replace(/([‹<]\s*!?--\s*)clawsweeper/gi, "$1claw\u200bsweeper");
  return trimText(inert, LIVE_VERIFICATION_COMMENT_OUTPUT_MAX_CHARS);
}

function parseStep(value: unknown, index: number): LiveVerificationStepResult {
  const label = `live verification result.steps[${index}]`;
  const record = requireRecord(value, label);
  rejectUnexpectedKeys(record, STEP_KEYS, label);
  const action = requireSingleLine(record.action, `${label}.action`, 50);
  if (!ACTIONS.has(action)) throw new Error(`${label}.action is invalid`);
  if (!["completed", "failed", "not_run"].includes(String(record.status))) {
    throw new Error(`${label}.status is invalid`);
  }
  const detail = requireString(record.detail, `${label}.detail`);
  if (detail.length > 1_000) throw new Error(`${label}.detail must be at most 1000 characters`);
  const isAssertion = action === "expect_text" || action === "expect_output";
  const assertion =
    record.assertion === undefined
      ? undefined
      : requireSingleLine(record.assertion, `${label}.assertion`, 2_000);
  if (isAssertion && assertion === undefined) throw new Error(`${label}.assertion is required`);
  if (!isAssertion && assertion !== undefined) throw new Error(`${label}.assertion is not allowed`);
  if (isAssertion) {
    if (typeof record.present_at_start !== "boolean" || typeof record.satisfied !== "boolean") {
      throw new Error(`${label} assertion outcomes must be boolean`);
    }
  } else if (record.present_at_start !== undefined || record.satisfied !== undefined) {
    throw new Error(`${label} assertion outcomes are not allowed`);
  }
  return {
    action: action as LiveProofStep["action"],
    status: record.status as LiveVerificationStepStatus,
    detail,
    ...(assertion !== undefined ? { assertion } : {}),
    ...(isAssertion
      ? {
          present_at_start: record.present_at_start as boolean,
          satisfied: record.satisfied as boolean,
        }
      : {}),
  };
}

function sanitizeInline(value: string): string {
  return sanitizeUntrustedOutput(value).replaceAll("\n", " ").slice(0, 2_000);
}

function trimText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 24)}\n… output truncated …`;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnexpectedKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unexpected = Object.keys(record).filter((key) => !allowed.has(key));
  if (unexpected.length) throw new Error(`${label} has unexpected keys: ${unexpected.join(", ")}`);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function requireSingleLine(value: unknown, label: string, maxChars: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maxChars ||
    /[\r\n\u2028\u2029]/.test(value)
  ) {
    throw new Error(
      `${label} must be a non-empty single-line string of at most ${maxChars} characters`,
    );
  }
  return value.trim();
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}
