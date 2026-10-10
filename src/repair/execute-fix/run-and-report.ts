// This module owns the fix executor's Codex handoff (the worker process, the
// read-only /review and the review-fix and validation-fix workers) and the fix
// execution report (write, debug artifacts and deferred publication).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { AgentInputScanError, type AgentScanSource } from "../../agent-input-scan.js";
import { runAgentProcess } from "../../agent-runner.js";
import {
  codexAppServerProcessOptionsFromEnv,
  type CodexProcessResult,
} from "../../codex-process.js";
import { codexJsonlFailureDetail } from "../../codex-transient.js";
import { parseBooleanEnv } from "../env-utils.js";
import { finalizeExecutionReport } from "../execution-finalization.js";
import {
  renderFixArtifactForPrompt,
  renderWorkerValidationGuidance,
} from "../fix-prompt-builder.js";
import { runGit } from "../git.js";
import type { JsonValue, LooseRecord } from "../json-types.js";
import { repoRoot } from "../lib.js";
import {
  codexModelArgs,
  codexSubprocessEnv as codexEnv,
  repairCodexConfigArgs,
} from "../process-env.js";
import { withTargetReviewSnapshot } from "../target-validation.js";
import { compactText, stripAnsi } from "../text-utils.js";

const codexHeartbeatMs = Math.max(
  10_000,
  Number(process.env.CLAWSWEEPER_CODEX_HEARTBEAT_MS ?? 60_000),
);
const fixDebugMaxBytes = Math.max(
  1024 * 1024,
  Number(process.env.CLAWSWEEPER_FIX_DEBUG_MAX_BYTES ?? 8 * 1024 * 1024),
);
const defaultCodexWriteSandbox =
  process.env.GITHUB_ACTIONS === "true" ? "danger-full-access" : "workspace-write";
const codexWriteSandbox = String(
  process.env.CLAWSWEEPER_CODEX_WRITE_SANDBOX ?? defaultCodexWriteSandbox,
);
const defaultCodexReviewSandbox = "read-only";
const codexReviewSandbox = String(
  process.env.CLAWSWEEPER_CODEX_REVIEW_SANDBOX ?? defaultCodexReviewSandbox,
);
const codexWriteNetworkAccess = parseBooleanEnv(
  process.env.CLAWSWEEPER_CODEX_WRITE_NETWORK_ACCESS,
  process.env.GITHUB_ACTIONS === "true",
);
const codexReviewNetworkAccess = parseBooleanEnv(
  process.env.CLAWSWEEPER_CODEX_REVIEW_NETWORK_ACCESS,
  false,
);

// The run values that the Codex handoff reads. The work root is a function because
// the executor picks it after its preflight checks. The timeout is a function
// because the remaining run budget gets smaller while the executor runs.
export interface ExecuteFixCodexRun {
  model: string;
  codexReasoningEffort: string;
  codexServiceTier: string;
  workRoot: () => string;
  currentCodexTimeoutMs: () => number;
}

export function createExecuteFixCodex({
  model,
  codexReasoningEffort,
  codexServiceTier,
  workRoot,
  currentCodexTimeoutMs,
}: ExecuteFixCodexRun) {
  const executionModelArgs = codexModelArgs(model);

  function runCodexWithHeartbeat({
    label,
    targetDir,
    prompt,
    timeoutMs,
    outputPath,
    logPrefix,
    review,
  }: {
    label: string;
    targetDir: string;
    prompt: string;
    timeoutMs: number;
    outputPath: string;
    logPrefix: string;
    review?: { schemaPath: string; scanSource: AgentScanSource };
  }) {
    const sandbox = review ? codexReviewSandbox : codexWriteSandbox;
    const networkAccess = review ? codexReviewNetworkAccess : codexWriteNetworkAccess;
    const codexExtraArgs = [
      "--cd",
      targetDir,
      ...executionModelArgs,
      "--sandbox",
      sandbox,
      ...codexWorkspaceSandboxConfigArgs(sandbox, networkAccess),
      ...repairCodexConfigArgs(codexReasoningEffort, codexServiceTier),
      ...(review ? ["--output-schema", review.schemaPath] : []),
      "--output-last-message",
      outputPath,
      "--json",
      "-",
    ];
    const env = codexEnv();
    const heartbeat = startCodexHeartbeat(label);
    try {
      const appServer = codexAppServerProcessOptionsFromEnv(label);
      return runAgentProcess({
        scanSource: review?.scanSource ?? { kind: "prompt" },
        label,
        prompt,
        model,
        reasoningEffort: codexReasoningEffort,
        codexExtraArgs,
        cwd: targetDir,
        env,
        timeoutMs,
        stdoutPath: path.join(workRoot(), `${logPrefix}.jsonl`),
        stderrPath: path.join(workRoot(), `${logPrefix}.stderr.log`),
        ...(appServer ? { appServer } : {}),
      });
    } finally {
      if (!heartbeat.killed) heartbeat.kill("SIGTERM");
    }
  }

  function startCodexHeartbeat(label: string) {
    const script = `
  const interval = Math.max(1000, Number(process.env.CLAWSWEEPER_CODEX_HEARTBEAT_MS || 60000));
  const label = process.env.CLAWSWEEPER_CODEX_HEARTBEAT_LABEL || "Codex subprocess";
  const startedAt = Date.now();
  setInterval(() => {
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    console.log(\`[clawsweeper repair] \${new Date().toISOString()} \${label} still running (\${elapsedSeconds}s elapsed)\`);
  }, interval);
  `;
    const child = spawn(process.execPath, ["-e", script], {
      env: {
        ...process.env,
        CLAWSWEEPER_CODEX_HEARTBEAT_LABEL: label,
        CLAWSWEEPER_CODEX_HEARTBEAT_MS: String(codexHeartbeatMs),
      },
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", () => {});
    return child;
  }

  function runCodexReview({
    checkoutBinding,
    fixArtifact,
    targetDir,
    mode,
    attempt,
    baseBranch,
    targetBaseSha,
    validationCommands = [],
    validationPlan = null,
  }: LooseRecord) {
    const outputPath = path.join(workRoot(), `${mode}-codex-review-${attempt}.json`);
    fs.rmSync(outputPath, { force: true });
    const schemaPath = codexReviewSchemaPath();
    const prompt = [
      "/review",
      "",
      `Review the current ClawSweeper Repair fix branch diff against pinned target base ${targetBaseSha} (${baseBranch}) before it can be merged.`,
      "",
      "Required checks:",
      "- security-sensitive issues are resolved or absent;",
      "- human PR/review comments from the artifact are addressed;",
      "- review-bot comments from Greptile, Codex, Asile, CodeRabbit, Copilot, and similar bots are addressed;",
      "- code is narrow, safe, and merge-ready;",
      "- validation commands are sufficient for the changed surface.",
      "",
      "Validation policy:",
      "- `pnpm check:changed` plus git diff checks is sufficient local proof for OpenClaw changed-surface fixes;",
      "- the changed-surface validation commands listed below have already passed; do not rerun them or start nested autoreview helpers;",
      "- this review is strictly read-only: do not modify tracked files, ignored artifacts, dependency caches, or Git metadata;",
      "- do not require full CI, full test suites, e2e/live/docker lanes, or unrelated flaky main checks to pass;",
      "- block only when the changed-lane proof fails or the current diff plausibly caused the failure.",
      "- repository policy overrides fix artifact credit wording: for openclaw/openclaw changelog entries, do not require or re-add forbidden `Thanks @codex`, `Thanks @openclaw`, or `Thanks @steipete` attribution; PR body/history/source links are acceptable credit for those source authors.",
      "",
      `Validation commands actually run: ${validationCommands.join("; ") || "none"}`,
      validationPlan
        ? `Validation scope: ${validationPlan.scope}; ${validationPlan.reason}; changed files: ${(validationPlan.changed_files ?? []).join(", ") || "none"}`
        : "",
      `Original artifact validation commands: ${(fixArtifact.validation_commands ?? []).join("; ")}`,
      "",
      "Return JSON only. If anything blocks merge, include actionable findings.",
      "",
      "Fix artifact:",
      "```json",
      renderFixArtifactForPrompt(fixArtifact),
      "```",
    ].join("\n");
    const reviewTimeoutMs = currentCodexTimeoutMs();
    const child = withTargetReviewSnapshot(
      {
        cwd: targetDir,
        baseSha: targetBaseSha,
        expected: checkoutBinding,
        timeoutMs: reviewTimeoutMs,
      },
      (scanSource, timeoutMs) =>
        runCodexWithHeartbeat({
          label: `Codex /review ${mode} attempt ${attempt}`,
          targetDir,
          prompt,
          timeoutMs,
          outputPath,
          logPrefix: `${mode}-codex-review-${attempt}`,
          review: { schemaPath, scanSource },
        }),
    );
    if ((child.error as JsonValue)?.code === "ETIMEDOUT")
      throw new Error(`Codex /review timed out after ${reviewTimeoutMs}ms`);
    if (child.error) throw new Error(child.error.message || String(child.error));
    if (child.status !== 0) throw new Error(child.stderr || child.stdout || "Codex /review failed");
    if (!fs.existsSync(outputPath)) {
      const fallbackReview = extractCodexReviewFromJsonl(child.stdout);
      if (fallbackReview) {
        fs.writeFileSync(outputPath, `${JSON.stringify(fallbackReview, null, 2)}\n`);
        return fallbackReview;
      }
      const stdout = compactText(child.stdout, 800);
      const stderr = compactText(child.stderr, 800);
      throw new Error(
        `Codex /review failed: structured output was not written to ${path.basename(outputPath)}; stdout=${stdout || "empty"}; stderr=${stderr || "empty"}`,
      );
    }
    try {
      return JSON.parse(fs.readFileSync(outputPath, "utf8"));
    } catch (error) {
      throw new Error(
        `Codex /review failed: invalid structured output in ${path.basename(outputPath)}: ${error.message}`,
        { cause: error },
      );
    }
  }

  function runCodexReviewFix({
    fixArtifact,
    targetDir,
    mode,
    review,
    attempt,
    targetBaseSha,
  }: LooseRecord) {
    const prompt = [
      "Address every actionable finding from Codex /review.",
      "",
      "Rules:",
      `- keep all inspection and validation anchored to pinned target base ${targetBaseSha};`,
      "- keep the patch narrow;",
      "- keep shell output bounded; inspect targeted files and avoid broad repo-wide dumps;",
      "- do not commit, push, open PRs, close PRs, or call gh;",
      renderWorkerValidationGuidance(),
      "- if a finding is false-positive, adjust comments/tests only when that makes the proof clearer.",
      "",
      "Codex /review findings:",
      "```json",
      JSON.stringify(review, null, 2),
      "```",
      "",
      "Fix artifact:",
      "```json",
      renderFixArtifactForPrompt(fixArtifact),
      "```",
    ].join("\n");
    const reviewFixTimeoutMs = currentCodexTimeoutMs();
    const child = runCodexWithHeartbeat({
      label: `Codex review-fix worker ${mode} attempt ${attempt}`,
      targetDir,
      prompt,
      timeoutMs: reviewFixTimeoutMs,
      outputPath: path.join(workRoot(), `${mode}-codex-review-fix-${attempt}.md`),
      logPrefix: `${mode}-codex-review-fix-${attempt}`,
    });
    if ((child.error as JsonValue)?.code === "ETIMEDOUT")
      throw new Error(`Codex review-fix worker timed out after ${reviewFixTimeoutMs}ms`);
    if (child.error) throw new Error(child.error.message || String(child.error));
    if (child.status !== 0)
      throw new Error(child.stderr || child.stdout || "Codex review-fix worker failed");
  }

  function runCodexValidationFix({
    fixArtifact,
    targetDir,
    mode,
    error,
    attempt,
    validationPlan,
    validationCommands = [],
    targetBaseSha,
  }: LooseRecord) {
    const validationError = compactText(String(error?.message ?? error), 8000);
    const changedFiles = runGit(["diff", "--name-only"], { cwd: targetDir })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const prompt = [
      "Fix the current repair patch so the changed-surface validation gate passes.",
      "",
      "Rules:",
      `- keep all inspection and validation anchored to pinned target base ${targetBaseSha};`,
      "- keep the patch narrow;",
      "- fix only issues introduced by the current repair branch or required to make its changed gate pass;",
      "- keep shell output bounded; inspect targeted files and avoid broad repo-wide dumps;",
      "- do not commit, push, open PRs, close PRs, or call gh;",
      renderWorkerValidationGuidance(),
      "- prefer the smallest lint/typecheck/test fix over broad rewrites.",
      "",
      `Validation commands attempted: ${validationCommands.join("; ") || "none"}`,
      validationPlan
        ? `Validation scope: ${validationPlan.scope}; ${validationPlan.reason}; changed files: ${(validationPlan.changed_files ?? []).join(", ") || "none"}`
        : "",
      `Current uncommitted changed files: ${changedFiles.join(", ") || "none"}`,
      "",
      "Validation failure:",
      "```text",
      validationError,
      "```",
      "",
      "Fix artifact:",
      "```json",
      renderFixArtifactForPrompt(fixArtifact),
      "```",
    ].join("\n");
    const validationFixTimeoutMs = currentCodexTimeoutMs();
    const child = runCodexWithHeartbeat({
      label: `Codex validation-fix worker ${mode} attempt ${attempt}`,
      targetDir,
      prompt,
      timeoutMs: validationFixTimeoutMs,
      outputPath: path.join(workRoot(), `${mode}-codex-validation-fix-${attempt}.md`),
      logPrefix: `${mode}-codex-validation-fix-${attempt}`,
    });
    if ((child.error as JsonValue)?.code === "ETIMEDOUT")
      throw new Error(`Codex validation-fix worker timed out after ${validationFixTimeoutMs}ms`);
    if (child.error) throw new Error(child.error.message || String(child.error));
    if (child.status !== 0)
      throw new Error(child.stderr || child.stdout || "Codex validation-fix worker failed");
  }

  function codexReviewSchemaPath() {
    const schemaPath = path.join(workRoot(), "codex-review.schema.json");
    if (fs.existsSync(schemaPath)) return schemaPath;
    fs.writeFileSync(
      schemaPath,
      `${JSON.stringify(
        {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          required: ["status", "summary", "findings", "findings_addressed", "evidence"],
          additionalProperties: false,
          properties: {
            status: { type: "string", enum: ["passed", "clean", "failed", "blocked"] },
            summary: { type: "string" },
            findings: {
              type: "array",
              items: {
                type: "object",
                required: ["severity", "summary", "evidence"],
                additionalProperties: false,
                properties: {
                  severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
                  summary: { type: "string" },
                  evidence: { type: "string" },
                },
              },
            },
            findings_addressed: { type: "boolean" },
            evidence: { type: "array", items: { type: "string" } },
          },
        },
        null,
        2,
      )}\n`,
    );
    return schemaPath;
  }

  return { runCodexReview, runCodexReviewFix, runCodexValidationFix, runCodexWithHeartbeat };
}

// The run values that the fix execution report reads. The report argument is the
// --report path from the command line. The executor publishes the outcome
// comments, so it gives that step as publishReportOutcome.
export interface ExecuteFixReportRun {
  deferPublication: boolean;
  reportArg: unknown;
  workRoot: () => string;
  publishReportOutcome: (report: LooseRecord, resultPath: string) => void;
}

export function createExecuteFixReport({
  deferPublication,
  reportArg,
  workRoot,
  publishReportOutcome,
}: ExecuteFixReportRun) {
  function writeReport(report: LooseRecord, resultPath: string) {
    const reportPath = fixExecutionReportPath(resultPath);
    const debugDir = copyFixDebugArtifacts(path.dirname(reportPath));
    if (debugDir) {
      report.debug_artifacts = path.relative(repoRoot(), debugDir);
    }
    finalizeExecutionReport({
      deferPublication,
      reportPath,
      serialize: () => `${JSON.stringify(report, null, 2)}\n`,
      publish: () => publishReportOutcome(report, resultPath),
    });
    console.log("Wrote fix execution report.");
  }

  function publishPersistedReport(resultPath: string) {
    const reportPath = fixExecutionReportPath(resultPath);
    if (!fs.existsSync(reportPath)) {
      console.warn(
        `No deferred fix execution report exists at ${reportPath}; skipping publication.`,
      );
      return;
    }
    const persistedReport = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    finalizeExecutionReport({
      deferPublication: false,
      reportPath,
      serialize: () => `${JSON.stringify(persistedReport, null, 2)}\n`,
      publish: () => publishReportOutcome(persistedReport, resultPath),
    });
    console.log("Published deferred fix execution outcome.");
  }

  function fixExecutionReportPath(resultPath: string) {
    return typeof reportArg === "string"
      ? path.resolve(reportArg)
      : path.join(path.dirname(resultPath), "fix-execution-report.json");
  }

  function copyFixDebugArtifacts(reportDir: JsonValue) {
    if (!workRoot() || !fs.existsSync(workRoot())) return "";
    const debugDir = path.join(reportDir, "fix-executor-debug");
    let copied = 0;
    for (const entry of fs.readdirSync(workRoot(), { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!/\.(jsonl|stderr\.log|md|json)$/i.test(entry.name)) continue;
      if (entry.name === "replacement-pr-body.md") continue;
      fs.mkdirSync(debugDir, { recursive: true });
      copyDebugFileWithTailCap(path.join(workRoot(), entry.name), path.join(debugDir, entry.name));
      copied += 1;
    }
    return copied > 0 ? debugDir : "";
  }

  return { publishPersistedReport, writeReport };
}

export function codexFailureDetail(child: CodexProcessResult, fallback: string) {
  const detail =
    codexJsonlFailureDetail(child.stdout) ||
    codexJsonlFailureDetail(child.stderr) ||
    stripAnsi(child.stderr).trim();
  return detail || fallback;
}

export function codexFailureMessage(label: string, detail: string) {
  return `${label}: ${compactText(stripAnsi(detail || "no Codex output"), 900)}`;
}

export function codexReviewFailureSummary(review: LooseRecord | null): string {
  return (
    review?.summary ??
    (Array.isArray(review?.findings)
      ? review.findings.map((finding: JsonValue) => finding.summary ?? finding).join("; ")
      : "unknown")
  );
}

export function isRetryableCodexReviewError(error: JsonValue) {
  if (error instanceof AgentInputScanError) return false;
  return /structured output was not written|invalid structured output/i.test(
    String(error?.message ?? error),
  );
}

export function isCleanCodexReview(review: LooseRecord) {
  const status = String(review?.status ?? "").toLowerCase();
  const findings = Array.isArray(review?.findings) ? review.findings : [];
  return (
    ["passed", "clean"].includes(status) &&
    findings.length === 0 &&
    review?.findings_addressed === true
  );
}

export function buildMergePreflight({ fixArtifact, codexReview }: LooseRecord) {
  const validationCommands = codexReview.validation_commands_run?.length
    ? codexReview.validation_commands_run
    : fixArtifact.validation_commands;
  return {
    target: null,
    security_status: "cleared",
    security_evidence: [
      "ClawSweeper Repair scoped security scan found no security-sensitive fix target, source PR, or fix artifact scope.",
    ],
    comments_status: "resolved",
    comments_evidence: [
      "Agentic fix pass addressed human PR/review comments named in the fix artifact.",
    ],
    bot_comments_status: "resolved",
    bot_comments_evidence: [
      "Agentic fix pass addressed Greptile/Codex/Asile/CodeRabbit/Copilot-style findings named in the fix artifact.",
    ],
    codex_review: {
      command: "/review",
      status: codexReview.status === "clean" ? "clean" : "passed",
      findings_addressed: true,
      evidence: codexReview.evidence?.length
        ? codexReview.evidence
        : [`Codex /review passed after agentic fix loop: ${codexReview.summary ?? "clean"}`],
    },
    validation_commands: validationCommands,
    final_base_sync: codexReview.final_base_sync ?? null,
  };
}

function codexWorkspaceSandboxConfigArgs(sandbox: string, networkAccess: boolean) {
  if (sandbox !== "workspace-write") return [];
  return ["-c", `sandbox_workspace_write.network_access=${networkAccess ? "true" : "false"}`];
}

function extractCodexReviewFromJsonl(stdout: JsonValue) {
  const candidates: string[] = [];
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const text = event?.item?.type === "agent_message" ? event.item.text : undefined;
    if (typeof text === "string" && text.trim().startsWith("{")) candidates.push(text.trim());
  }
  for (const text of candidates.reverse()) {
    try {
      const parsed = JSON.parse(text);
      if (isCodexReview(parsed)) return parsed;
    } catch {
      // Keep scanning older candidate messages.
    }
  }
  return null;
}

function isCodexReview(value: JsonValue) {
  return (
    value &&
    typeof value === "object" &&
    typeof value.status === "string" &&
    typeof value.summary === "string" &&
    Array.isArray(value.findings) &&
    typeof value.findings_addressed === "boolean" &&
    Array.isArray(value.evidence)
  );
}

function copyDebugFileWithTailCap(source: string, destination: string) {
  const size = fs.statSync(source).size;
  if (size <= fixDebugMaxBytes) {
    fs.copyFileSync(source, destination);
    return;
  }

  const readSize = Math.min(size, fixDebugMaxBytes);
  const buffer = Buffer.alloc(readSize);
  const fd = fs.openSync(source, "r");
  try {
    fs.readSync(fd, buffer, 0, readSize, size - readSize);
  } finally {
    fs.closeSync(fd);
  }
  fs.writeFileSync(
    destination,
    `[clawsweeper] debug file truncated from ${size} bytes to last ${readSize} bytes for final repair artifact; see dedicated Codex debug artifact when available.\n`,
  );
  fs.appendFileSync(destination, buffer);
}
