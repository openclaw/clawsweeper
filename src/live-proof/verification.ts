import {
  requireRecord,
  rejectUnexpectedKeys,
  requireString,
  requirePositiveInteger,
} from "../value-coerce.js";
import { createHash } from "node:crypto";
import type { LiveProofPlan, LiveProofStep } from "../clawsweeper-types.js";
import { LIVE_VERIFICATION_MARKER } from "../clawsweeper-policy.js";
import type { LiveProofDriveStatus } from "./manifest.js";
import type { LiveProofStepLogEntry } from "./drivers.js";

export const LIVE_VERIFICATION_SCHEMA_VERSION = 1;
export const LIVE_VERIFICATION_OUTPUT_MAX_CHARS = 16_000;
export const LIVE_VERIFICATION_COMMENT_OUTPUT_MAX_CHARS = 4_000;
const OUTPUT_TRUNCATION_MARKER = "… output truncated …";
const LEGACY_TERMINAL_OUTPUT_NOT_OBSERVED_DETAIL =
  "command exited successfully; expected output was not observed in the captured pane";
const MISSING_OBSERVED_OUTCOME_REASON =
  "live verification completed without a satisfied expect_text or expect_output observation";
const INCOMPLETE_OBSERVED_OUTCOME_REASON =
  "live verification completed without every expect_text or expect_output observation satisfied";

export type LiveVerificationStepStatus = "completed" | "failed" | "not_run";

export interface LiveVerificationStepResult {
  action: LiveProofStep["action"];
  status: LiveVerificationStepStatus;
  detail: string;
  subject?: string;
  assertion?: string;
  present_at_start?: boolean;
  satisfied?: boolean;
}

export interface LiveVerificationFailure {
  phase: "step" | "execution";
  reason: string;
  step?: number;
  action?: LiveProofStep["action"];
}

export interface LiveVerificationResult {
  schema_version: 1;
  repo: string;
  item: number;
  head_sha: string;
  plan_sha256: string;
  surface: "browser" | "terminal";
  entry: string;
  drive_status: LiveProofDriveStatus;
  steps: LiveVerificationStepResult[];
  output: string;
  failure?: LiveVerificationFailure;
  overall_pass: boolean;
  verified_at: string;
}

export type AttachedLiveVerification =
  | { status: "absent" }
  | { status: "passed"; result: LiveVerificationResult }
  | { status: "failed"; result: LiveVerificationResult }
  | { status: "malformed" };

export interface LiveVerificationReportIdentity {
  repository: string | undefined;
  number: string | undefined;
  type: string | undefined;
  pullHeadSha: string | undefined;
}

const RESULT_KEYS = new Set([
  "schema_version",
  "repo",
  "item",
  "head_sha",
  "plan_sha256",
  "surface",
  "entry",
  "drive_status",
  "steps",
  "output",
  "failure",
  "overall_pass",
  "verified_at",
]);
const STEP_KEYS = new Set([
  "action",
  "status",
  "detail",
  "subject",
  "assertion",
  "present_at_start",
  "satisfied",
]);
const FAILURE_KEYS = new Set(["phase", "reason", "step", "action"]);
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
  executionFailureReason?: string;
  verifiedAt: string;
}): LiveVerificationResult {
  const steps = options.plan.steps.map((step, index): LiveVerificationStepResult => {
    const logged = options.stepLog[index];
    const subject = liveProofStepSubject(step);
    const assertion =
      step.action === "expect_text" || step.action === "expect_output" ? step.text : undefined;
    if (!logged || logged.action !== step.action) {
      return {
        action: step.action,
        status: "not_run",
        detail: "not run after an earlier step failed",
        ...(subject ? { subject } : {}),
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
      ...(subject ? { subject } : {}),
      ...(assertion ? { assertion } : {}),
      ...(expectation
        ? {
            present_at_start: expectation.presentAtStart,
            satisfied: expectation.satisfied,
          }
        : {}),
    };
  });
  const overallPass = liveVerificationOverallPass(options.driveStatus, steps);
  const failure = overallPass
    ? undefined
    : buildLiveVerificationFailure(
        steps,
        options.output,
        options.executionFailureReason ??
          (options.driveStatus === "completed"
            ? steps.some(isOutcomeAssertion)
              ? INCOMPLETE_OBSERVED_OUTCOME_REASON
              : MISSING_OBSERVED_OUTCOME_REASON
            : undefined),
      );
  return {
    schema_version: 1,
    repo: options.repo,
    item: options.item,
    head_sha: options.headSha,
    plan_sha256: liveProofPlanSha256(options.plan),
    surface: options.plan.surface as "browser" | "terminal",
    entry: options.plan.entry,
    drive_status: options.driveStatus,
    steps,
    output:
      options.plan.surface === "browser" && options.executionFailureReason === undefined
        ? ""
        : truncateOutput(options.output, LIVE_VERIFICATION_OUTPUT_MAX_CHARS),
    ...(failure ? { failure } : {}),
    overall_pass: overallPass,
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
  const planSha256 = requireSingleLine(
    record.plan_sha256,
    "live verification result.plan_sha256",
    64,
  );
  if (!/^[0-9a-f]{64}$/.test(planSha256)) {
    throw new Error("live verification result.plan_sha256 must be a lowercase SHA-256 digest");
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
  const failure = record.failure === undefined ? undefined : parseFailure(record.failure, steps);
  if (!["completed", "partial", "failed"].includes(String(record.drive_status))) {
    throw new Error("live verification result.drive_status is invalid");
  }
  if (typeof record.overall_pass !== "boolean") {
    throw new Error("live verification result.overall_pass must be boolean");
  }
  const derivedOverallPass = liveVerificationOverallPass(
    record.drive_status as LiveProofDriveStatus,
    steps,
  );
  if (record.overall_pass !== derivedOverallPass) {
    throw new Error("live verification result.overall_pass does not match its step outcomes");
  }
  if (record.overall_pass && failure) {
    throw new Error("live verification result.failure is not allowed for a passing result");
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
    plan_sha256: planSha256,
    surface: record.surface,
    entry,
    drive_status: record.drive_status as LiveProofDriveStatus,
    steps,
    output,
    ...(failure ? { failure } : {}),
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

export function validateLiveVerificationReportIdentity(
  result: Pick<LiveVerificationResult, "repo" | "item" | "head_sha">,
  identity: LiveVerificationReportIdentity,
): void {
  if (identity.repository?.trim().toLowerCase() !== result.repo.toLowerCase()) {
    throw new Error("record repository does not match the live verification result");
  }
  if (Number(identity.number) !== result.item) {
    throw new Error("record item number does not match the live verification result");
  }
  if (identity.type !== "pull_request") {
    throw new Error("live proof can only be attached to a pull request report");
  }
  if (identity.pullHeadSha?.trim().toLowerCase() !== result.head_sha) {
    throw new Error("record pull_head_sha does not match the live verification result");
  }
}

export function liveProofPlanSha256(plan: LiveProofPlan): string {
  if (plan.invalid) {
    throw new Error("invalid live proof plan cannot be verified");
  }
  const canonicalPlan = {
    status: plan.status,
    surface: plan.surface,
    terminalCompletion: plan.terminalCompletion,
    reason: plan.reason,
    payoff: {
      kind: plan.payoff.kind,
      justification: plan.payoff.justification,
    },
    entry: plan.entry,
    steps: plan.steps.map(canonicalLiveProofStep),
  };
  return createHash("sha256").update(JSON.stringify(canonicalPlan)).digest("hex");
}

export function validateLiveVerificationReportPlan(
  result: Pick<LiveVerificationResult, "entry" | "plan_sha256" | "steps" | "surface">,
  plan: LiveProofPlan,
): void {
  if (
    result.plan_sha256 !== liveProofPlanSha256(plan) ||
    result.surface !== plan.surface ||
    result.entry !== plan.entry
  ) {
    throw new Error("record live proof plan does not match the live verification result");
  }
  if (
    result.steps.length !== plan.steps.length ||
    result.steps.some(
      (outcome, index) => !liveVerificationOutcomeMatchesStep(outcome, plan.steps[index]),
    )
  ) {
    throw new Error("live verification step outcomes do not match the record live proof plan");
  }
}

export function parseAttachedLiveVerification(
  section: string,
  identity: LiveVerificationReportIdentity,
  plan: LiveProofPlan,
): AttachedLiveVerification {
  const lines = section.split(/\r?\n/);
  const markerLines = lines
    .map((line, index) => (line === LIVE_VERIFICATION_MARKER ? index : -1))
    .filter((index) => index >= 0);
  if (markerLines.length === 0) return { status: "absent" };
  if (markerLines.length !== 1) return { status: "malformed" };

  const resultLine = lines[(markerLines[0] ?? -1) + 1] ?? "";
  const match = /^Result: ([A-Za-z0-9_-]+)$/.exec(resultLine);
  if (!match?.[1]) return { status: "malformed" };
  try {
    const result = decodeLiveVerificationReportPayload(match[1]);
    validateLiveVerificationReportIdentity(result, identity);
    validateLiveVerificationReportPlan(result, plan);
    return { status: result.overall_pass ? "passed" : "failed", result };
  } catch {
    return { status: "malformed" };
  }
}

function canonicalLiveProofStep(step: LiveProofStep): Record<string, string | number> {
  switch (step.action) {
    case "goto":
      return { action: step.action, path: step.path };
    case "click":
    case "wait_for":
      return { action: step.action, target: step.target };
    case "fill":
      return { action: step.action, target: step.target, value: step.value };
    case "press":
      return { action: step.action, key: step.key };
    case "wait":
      return { action: step.action, seconds: step.seconds };
    case "expect_text":
    case "expect_output":
      return { action: step.action, text: step.text };
    case "run":
      return { action: step.action, command: step.command };
  }
}

function liveVerificationOutcomeMatchesStep(
  outcome: LiveVerificationStepResult,
  step: LiveProofStep | undefined,
): boolean {
  if (!step || outcome.action !== step.action) return false;
  const subject = liveProofStepSubject(step);
  return isOutcomeAssertion(step)
    ? outcome.assertion === subject &&
        (outcome.subject === undefined || outcome.subject === subject)
    : outcome.subject === subject;
}

export function renderLiveVerificationCommentBlock(result: LiveVerificationResult): string {
  const parsed = parseLiveVerificationResult(result);
  const resultLine = `**Result:** ${parsed.overall_pass ? "PASS" : "FAIL"} (${parsed.drive_status})${parsed.overall_pass ? "" : ` — ${renderFailureSummary(parsed)}`}`;
  const lines = [
    `**${parsed.surface === "browser" ? "Entry" : "Command"}:** \`${sanitizeInline(parsed.entry)}\``,
    "",
    resultLine,
  ];
  if (parsed.overall_pass) {
    lines.push(
      "",
      "PASS covers only the declared scenario and assertions; the real behavior proof assessment determines whether they cover the PR's changes.",
    );
  }
  if (parsed.surface === "browser") {
    const executed = parsed.steps.filter((step) => step.status !== "not_run");
    if (executed.length) {
      lines.push(
        "",
        "**Steps:**",
        "",
        ...executed.map((step) => {
          const passed = step.status === "completed";
          const subject = step.subject ? ` \`${sanitizeInline(step.subject)}\`` : "";
          const reason =
            step.status === "failed" ? ` — \`${sanitizeInline(oneLineReason(step.detail))}\`` : "";
          return `- ${passed ? "PASS" : "FAIL"} \`${sanitizeInline(step.action)}\`${subject}${reason}`;
        }),
      );
    }
    if (parsed.failure?.phase === "execution" && parsed.output) {
      lines.push(
        "",
        "**Startup output:**",
        "",
        "```text",
        sanitizeUntrustedOutput(parsed.output),
        "```",
      );
    }
    return lines.join("\n");
  }

  lines.push(
    "",
    "```text",
    sanitizeUntrustedOutput(parsed.output || "<no output captured>"),
    "```",
  );
  const assertions = parsed.steps.filter((step) => step.assertion !== undefined);
  if (assertions.length) {
    lines.push(
      "",
      "**Assertions:**",
      "",
      ...assertions.map((step) => {
        const passed = step.status === "completed" && step.satisfied === true;
        const notObserved =
          passed &&
          parsed.surface === "terminal" &&
          step.action === "expect_output" &&
          step.detail === LEGACY_TERMINAL_OUTPUT_NOT_OBSERVED_DETAIL;
        const outcome = !passed ? "FAIL" : notObserved ? "NOT OBSERVED" : "PASS";
        const detail = notObserved ? ` — ${sanitizeInline(step.detail)}` : "";
        return `- ${outcome} \`${sanitizeInline(step.action)}\`: ${sanitizeInline(step.assertion ?? "")}${detail}`;
      }),
    );
  }
  return lines.join("\n");
}

export function sanitizeUntrustedOutput(value: string): string {
  return truncateOutput(sanitizeUntrustedText(value), LIVE_VERIFICATION_COMMENT_OUTPUT_MAX_CHARS);
}

function sanitizeUntrustedText(value: string): string {
  const normalized = value.replaceAll("\r\n", "\n").replace(/[\r\u2028\u2029]/g, "\n");
  return normalized
    .replaceAll("`", "ˋ")
    .replaceAll("<", "‹")
    .replaceAll(">", "›")
    .replace(/([‹<]\s*!?--\s*)clawsweeper/gi, "$1claw\u200bsweeper");
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
  const subject =
    record.subject === undefined
      ? undefined
      : requireBoundedString(record.subject, `${label}.subject`, 4_000);
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
    ...(subject !== undefined ? { subject } : {}),
    ...(assertion !== undefined ? { assertion } : {}),
    ...(isAssertion
      ? {
          present_at_start: record.present_at_start as boolean,
          satisfied: record.satisfied as boolean,
        }
      : {}),
  };
}

function parseFailure(
  value: unknown,
  steps: readonly LiveVerificationStepResult[],
): LiveVerificationFailure {
  const label = "live verification result.failure";
  const record = requireRecord(value, label);
  rejectUnexpectedKeys(record, FAILURE_KEYS, label);
  if (record.phase !== "step" && record.phase !== "execution") {
    throw new Error(`${label}.phase must be step or execution`);
  }
  const reason = requireSingleLine(record.reason, `${label}.reason`, 1_000);
  if (record.phase === "execution") {
    if (record.step !== undefined || record.action !== undefined) {
      throw new Error(`${label} execution failures cannot name a plan step`);
    }
    return { phase: "execution", reason };
  }
  const step = requirePositiveInteger(record.step, `${label}.step`);
  const action = requireSingleLine(record.action, `${label}.action`, 50);
  if (!ACTIONS.has(action)) throw new Error(`${label}.action is invalid`);
  const failed = steps[step - 1];
  if (!failed || failed.status !== "failed" || failed.action !== action) {
    throw new Error(`${label} does not match the failed step outcome`);
  }
  return { phase: "step", reason, step, action: action as LiveProofStep["action"] };
}

function buildLiveVerificationFailure(
  steps: readonly LiveVerificationStepResult[],
  output: string,
  executionFailureReason?: string,
): LiveVerificationFailure {
  const failedIndex = steps.findIndex((step) => step.status === "failed");
  if (failedIndex >= 0) {
    const failed = steps[failedIndex]!;
    return {
      phase: "step",
      reason: oneLineReason(failed.detail),
      step: failedIndex + 1,
      action: failed.action,
    };
  }
  return {
    phase: "execution",
    reason: oneLineReason(
      executionFailureReason || output || "driver exited unsuccessfully without a captured reason",
    ),
  };
}

function liveVerificationOverallPass(
  driveStatus: LiveProofDriveStatus,
  steps: readonly LiveVerificationStepResult[],
): boolean {
  return (
    driveStatus === "completed" &&
    steps.some(isOutcomeAssertion) &&
    steps.every(
      (step) =>
        step.status === "completed" &&
        (isOutcomeAssertion(step) ? step.satisfied === true : step.satisfied === undefined),
    )
  );
}

function isOutcomeAssertion(step: Pick<LiveVerificationStepResult, "action">): boolean {
  return step.action === "expect_text" || step.action === "expect_output";
}

function liveProofStepSubject(step: LiveProofStep): string {
  switch (step.action) {
    case "goto":
      return step.path;
    case "click":
    case "wait_for":
      return step.target;
    case "fill":
      return `${step.target} ← ${step.value}`;
    case "press":
      return step.key;
    case "wait":
      return `${step.seconds}s`;
    case "expect_text":
    case "expect_output":
      return step.text;
    case "run":
      return step.command;
  }
}

function renderFailureSummary(result: LiveVerificationResult): string {
  const failure =
    result.failure ??
    (() => {
      const failedIndex = result.steps.findIndex((step) => step.status === "failed");
      if (failedIndex >= 0) {
        const failed = result.steps[failedIndex]!;
        return {
          phase: "step" as const,
          reason: oneLineReason(failed.detail),
          step: failedIndex + 1,
          action: failed.action,
        };
      }
      return {
        phase: "execution" as const,
        reason: oneLineReason(
          result.output || "driver exited unsuccessfully without a captured reason",
        ),
      };
    })();
  if (failure.phase === "step") {
    const step = result.steps[(failure.step ?? 1) - 1];
    const subject = step?.subject ? ` \`${sanitizeInline(step.subject)}\`` : "";
    return `step ${failure.step} \`${sanitizeInline(failure.action ?? step?.action ?? "unknown")}\`${subject}: \`${sanitizeInline(failure.reason)}\``;
  }
  const next = result.steps.findIndex((step) => step.status === "not_run");
  const before =
    next >= 0 ? ` before step ${next + 1} \`${sanitizeInline(result.steps[next]!.action)}\`` : "";
  return `execution${before}: \`${sanitizeInline(failure.reason)}\``;
}

function sanitizeInline(value: string): string {
  return sanitizeUntrustedText(value).replaceAll("\n", " ").slice(0, 2_000);
}

function oneLineReason(value: string): string {
  const firstLine =
    value
      .replaceAll("\r\n", "\n")
      .replace(/[\r\u2028\u2029]/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? "driver exited unsuccessfully without a captured reason";
  return firstLine.slice(0, 1_000);
}

function trimText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 24)}\n… output truncated …`;
}

function truncateOutput(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const separator = `\n${OUTPUT_TRUNCATION_MARKER}\n`;
  const available = maxChars - separator.length;
  const headChars = Math.ceil(available / 2);
  const tailChars = Math.floor(available / 2);
  return `${value.slice(0, headChars)}${separator}${value.slice(-tailChars)}`;
}

function requireBoundedString(value: unknown, label: string, maxChars: number): string {
  const string = requireString(value, label);
  if (string.length > maxChars) {
    throw new Error(`${label} must be at most ${maxChars} characters`);
  }
  return string;
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
