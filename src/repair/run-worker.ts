#!/usr/bin/env node
import type { JsonValue, LooseRecord } from "./json-types.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  appendCodexOutputCapture,
  closeCodexOutputCapture,
  codexOutputTail,
  openCodexOutputCapture,
} from "../codex-output-capture.js";
import { codexAppServerProcessOptionsFromEnv, runCodexProcess } from "../codex-process.js";
import { spawnCodex, terminateCodexProcessTree } from "../codex-spawn.js";
import { deterministicAutomergeResult } from "./deterministic-automerge-result.js";
import {
  assertAllowedOwner,
  makeRunDir,
  parseArgs,
  parseJob,
  renderPrompt,
  repoRoot,
  validateJob,
} from "./lib.js";
import {
  codexLoginConfig,
  codexSubprocessEnv,
  codexModelArgs,
  repairCodexReasoningEffort,
  repairCodexServiceTier,
} from "./process-env.js";
import { sanitizeResultEvidence } from "./url-safety.js";

const args = parseArgs(process.argv.slice(2));
const jobPath = args._[0];
const mode = args.mode ?? "plan";
const dryRun = Boolean(args["dry-run"] || process.env.CLAWSWEEPER_DRY_RUN === "1");
const model = args.model ?? process.env.CLAWSWEEPER_MODEL ?? "internal";
const codexTimeoutMs = Number(process.env.CLAWSWEEPER_CODEX_TIMEOUT_MS ?? 30 * 60 * 1000);
const resultRepairAttempts = Math.max(
  0,
  Number(process.env.CLAWSWEEPER_RESULT_REPAIR_ATTEMPTS ?? 1),
);
const resultRepairTimeoutMs = Number(
  process.env.CLAWSWEEPER_RESULT_REPAIR_TIMEOUT_MS ?? 10 * 60 * 1000,
);
const codexReasoningEffort = repairCodexReasoningEffort();
const codexServiceTier = repairCodexServiceTier();
const codexHeartbeatMs = Math.max(
  10_000,
  Number(process.env.CLAWSWEEPER_CODEX_HEARTBEAT_MS ?? 60_000),
);

if (!jobPath) {
  console.error(
    "usage: node scripts/run-worker.ts <job.md> --mode plan|execute|autonomous [--dry-run]",
  );
  process.exit(2);
}
if (!["plan", "execute", "autonomous"].includes(mode)) {
  console.error("mode must be plan, execute, or autonomous");
  process.exit(2);
}

const job = parseJob(jobPath);
const errors = validateJob(job);
if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}

assertAllowedOwner(job.frontmatter.repo, process.env.CLAWSWEEPER_ALLOWED_OWNER);

if ((mode === "execute" || mode === "autonomous") && !dryRun) {
  if (job.frontmatter.mode !== mode) {
    throw new Error(`refusing ${mode}: job frontmatter mode is not ${mode}`);
  }
  if (process.env.CLAWSWEEPER_ALLOW_EXECUTE !== "1") {
    throw new Error(`refusing ${mode}: CLAWSWEEPER_ALLOW_EXECUTE must be 1`);
  }
}

const runDir = makeRunDir(job, mode);
const promptPath = path.join(runDir, "prompt.md");
const resultPath = path.join(runDir, "result.json");
const transcriptPath = path.join(runDir, "codex.jsonl");
const promptContext: Record<string, string> = {};
const targetCheckout = dryRun ? "" : prepareTargetCheckout(job);
if (targetCheckout) {
  process.env.CLAWSWEEPER_TARGET_CHECKOUT = targetCheckout;
  promptContext.targetCheckout = targetCheckout;
}

if (!dryRun) {
  const plannerArgs = [
    path.join(repoRoot(), "dist/repair/plan-cluster.js"),
    jobPath,
    "--run-dir",
    runDir,
  ];
  const planner = spawnSync(process.execPath, plannerArgs, {
    cwd: repoRoot(),
    encoding: "utf8",
    env: process.env,
  });
  if (planner.status !== 0) {
    console.error(planner.stderr || planner.stdout);
    process.exit(planner.status ?? 1);
  }
  promptContext.clusterPlanPath = path.join(runDir, "cluster-plan.json");
  promptContext.fixArtifactPath = path.join(runDir, "fix-artifact.json");
  const deterministicResult = readDeterministicResultIfAvailable({
    job,
    mode,
    clusterPlanPath: promptContext.clusterPlanPath,
  });
  if (deterministicResult) {
    sanitizeResultEvidence(deterministicResult);
    fs.writeFileSync(resultPath, `${JSON.stringify(deterministicResult, null, 2)}\n`);
    console.log(`result: ${path.relative(repoRoot(), resultPath)}`);
    process.exit(0);
  }
} else if (mode === "autonomous") {
  const plannerArgs = [
    path.join(repoRoot(), "dist/repair/plan-cluster.js"),
    jobPath,
    "--run-dir",
    runDir,
    "--offline",
  ];
  const planner = spawnSync(process.execPath, plannerArgs, {
    cwd: repoRoot(),
    encoding: "utf8",
    env: process.env,
  });
  if (planner.status !== 0) {
    console.error(planner.stderr || planner.stdout);
    process.exit(planner.status ?? 1);
  }
  promptContext.clusterPlanPath = path.join(runDir, "cluster-plan.json");
  promptContext.fixArtifactPath = path.join(runDir, "fix-artifact.json");
}

const prompt = renderPrompt(job, mode, promptContext);

fs.writeFileSync(promptPath, prompt);

if (dryRun) {
  const dryResult = {
    status: "planned",
    repo: job.frontmatter.repo,
    cluster_id: job.frontmatter.cluster_id,
    mode,
    summary: "dry run only; prompt rendered but Codex was not invoked",
    actions: [],
    prompt_path: path.relative(repoRoot(), promptPath),
  };
  sanitizeResultEvidence(dryResult);
  fs.writeFileSync(resultPath, `${JSON.stringify(dryResult, null, 2)}\n`);
  console.log(JSON.stringify(dryResult, null, 2));
  process.exit(0);
}

const child = await runCodex({
  input: prompt,
  outputPath: resultPath,
  transcriptPath,
  stderrPath: path.join(runDir, "codex.stderr.log"),
  timeoutMs: codexTimeoutMs,
});

if ((child.error as JsonValue)?.code === "ETIMEDOUT") {
  writeBlockedResult(`Codex worker timed out after ${codexTimeoutMs}ms`);
  console.error(`Codex worker timed out after ${codexTimeoutMs}ms`);
  process.exit(1);
}

if (child.error) {
  const detail = child.error.message || String(child.error);
  writeBlockedResult(`Codex worker failed: ${detail}`);
  console.error(detail);
  process.exit(1);
}

if (child.status !== 0) {
  const detail = child.stderr || child.stdout || `Codex worker exited ${child.status}`;
  writeBlockedResult(detail.trim());
  console.error(detail);
  process.exit(1);
}

if (!fs.existsSync(resultPath)) {
  writeBlockedResult("Codex worker completed without a structured result.json artifact.");
  process.exit(1);
}
sanitizeResultFile(resultPath);
await repairResultIfNeeded();
sanitizeResultFile(resultPath);

console.log(`result: ${path.relative(repoRoot(), resultPath)}`);

function readDeterministicResultIfAvailable({
  job,
  mode,
  clusterPlanPath,
}: LooseRecord): LooseRecord | null {
  if (process.env.CLAWSWEEPER_DETERMINISTIC_AUTOMERGE_REPAIRS === "0") return null;
  if (!fs.existsSync(String(clusterPlanPath))) return null;
  const clusterPlan = JSON.parse(fs.readFileSync(String(clusterPlanPath), "utf8"));
  return deterministicAutomergeResult({ job, mode, clusterPlan });
}

function runCodex({
  input,
  outputPath,
  transcriptPath: codexTranscriptPath,
  stderrPath,
  timeoutMs,
}: LooseRecord) {
  const codexArgs = [
    "exec",
    "--cd",
    codexWorkspaceRoot(),
    ...codexModelArgs(String(model)),
    "--sandbox",
    "read-only",
    ...codexConfigArgs(),
    "--output-schema",
    path.join(repoRoot(), "schema", "repair", "codex-result.schema.json"),
    "--output-last-message",
    outputPath,
    "--json",
    "-",
  ];

  return spawnCodexWithHeartbeat({
    args: codexArgs,
    cwd: codexWorkspaceRoot(),
    input: String(input ?? ""),
    transcriptPath: codexTranscriptPath,
    stderrPath,
    timeoutMs: Number(timeoutMs),
  });
}

function spawnCodexWithHeartbeat({
  args: commandArgs,
  cwd,
  input,
  transcriptPath: codexTranscriptPath,
  stderrPath,
  timeoutMs,
}: LooseRecord): Promise<LooseRecord> {
  const appServer = codexAppServerProcessOptionsFromEnv("Codex planning worker");
  if (appServer) {
    return Promise.resolve(
      runCodexProcess({
        args: commandArgs,
        cwd,
        env: codexEnv(),
        input,
        timeoutMs,
        stdoutPath: codexTranscriptPath,
        stderrPath,
        appServer,
      }),
    );
  }
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    let timeoutError: Error | null = null;
    const stdout = openCodexOutputCapture(codexTranscriptPath);
    const stderr = openCodexOutputCapture(stderrPath);

    const childEnv = codexEnv();
    const child = spawnCodex(commandArgs, { cwd, env: childEnv });

    const heartbeat = setInterval(() => {
      const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
      console.log(
        `[clawsweeper repair] ${new Date().toISOString()} Codex worker still running (${elapsedSeconds}s elapsed)`,
      );
    }, codexHeartbeatMs);
    const timeout = setTimeout(() => {
      timeoutError = new Error(`Codex worker timed out after ${timeoutMs}ms`);
      (timeoutError as LooseRecord).code = "ETIMEDOUT";
      terminateCodexProcessTree(child, "SIGTERM", 5_000);
    }, timeoutMs);

    const finish = (result: LooseRecord) => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      clearTimeout(timeout);
      closeCodexOutputCapture(stdout);
      closeCodexOutputCapture(stderr);
      resolve(result);
    };

    const append = (stream: "stdout" | "stderr", chunk: Buffer) => {
      if (stream === "stdout") {
        appendCodexOutputCapture(stdout, chunk);
      } else {
        appendCodexOutputCapture(stderr, chunk);
      }
    };

    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    child.on("error", (error) => {
      finish({
        status: null,
        stdout: codexOutputTail(stdout),
        stderr: codexOutputTail(stderr),
        error,
      });
    });
    child.on("close", (status, signal) => {
      finish({
        status,
        signal,
        stdout: codexOutputTail(stdout),
        stderr: codexOutputTail(stderr),
        error: timeoutError ?? undefined,
      });
    });
    child.stdin.end(input);
  });
}

function codexWorkspaceRoot(): string {
  return targetCheckout || repoRoot();
}

function codexConfigArgs() {
  const configs = [
    'approval_policy="never"',
    codexLoginConfig(),
    `model_reasoning_effort=${JSON.stringify(codexReasoningEffort)}`,
  ];
  if (codexServiceTier) configs.push(`service_tier=${JSON.stringify(codexServiceTier)}`);
  return configs.flatMap((config: JsonValue) => ["-c", config]);
}

async function repairResultIfNeeded() {
  for (let attempt = 1; attempt <= resultRepairAttempts; attempt += 1) {
    const review = reviewResult();
    if (review.status === 0) return;
    fs.writeFileSync(
      path.join(runDir, `review-results-failed-${attempt}.json`),
      review.stdout || review.stderr || "",
    );
    if (!fs.existsSync(resultPath)) return;

    const beforePath = path.join(runDir, `result.before-repair-${attempt}.json`);
    fs.copyFileSync(resultPath, beforePath);
    const repairPrompt = [
      "You are repairing a ClawSweeper Repair structured JSON result that failed deterministic validation.",
      "",
      "Do not mutate GitHub. Do not change the job scope. Return a complete replacement JSON result only.",
      "Fix the validation failures with the narrowest safe changes. If a PR closeout comment is missing contributor credit, update that action comment to explicitly preserve credit, including wording such as `credit`, `attribution`, `thanks @user`, or `source PR`, and keep the canonical/fix links intact.",
      "If a validator failure reveals that an action is not safely repairable from the provided artifacts, downgrade only that action to a non-mutating `keep_related`, `keep_independent`, blocked fix-first action, or `needs_human` with exact evidence.",
      "",
      "## Validator output",
      "```json",
      (review.stdout || review.stderr || "").trim(),
      "```",
      "",
      "## Current result JSON",
      "```json",
      fs.readFileSync(beforePath, "utf8").trim(),
      "```",
      "",
      "## Original worker prompt",
      "```md",
      prompt,
      "```",
    ].join("\n");

    const repair = await runCodex({
      input: repairPrompt,
      outputPath: resultPath,
      transcriptPath: path.join(runDir, `codex-repair-${attempt}.jsonl`),
      stderrPath: path.join(runDir, `codex-repair-${attempt}.stderr.log`),
      timeoutMs: resultRepairTimeoutMs,
    });
    if ((repair.error as JsonValue)?.code === "ETIMEDOUT") {
      console.error(`Codex result repair timed out after ${resultRepairTimeoutMs}ms`);
      return;
    }
    if (repair.status !== 0) {
      console.error(
        repair.stderr || repair.stdout || `Codex result repair exited ${repair.status}`,
      );
      return;
    }
    sanitizeResultFile(resultPath);
  }
}

function reviewResult() {
  return spawnSync(
    process.execPath,
    [path.join(repoRoot(), "dist/repair/review-results.js"), runDir],
    {
      cwd: repoRoot(),
      encoding: "utf8",
      env: process.env,
    },
  );
}

function codexEnv() {
  return codexSubprocessEnv();
}

function prepareTargetCheckout(job: LooseRecord): string {
  const explicit = stringValue(job.frontmatter.target_checkout);
  if (explicit) return explicit;

  const fromEnv = stringValue(process.env.CLAWSWEEPER_TARGET_CHECKOUT);
  if (fromEnv) return fromEnv;

  const targetRepo = String(job.frontmatter.repo ?? "");
  if (process.env.GITHUB_REPOSITORY === targetRepo) return repoRoot();

  const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-target-"));
  const targetDir = path.join(targetRoot, targetRepo.replace(/[^A-Za-z0-9_.-]+/g, "-"));
  runCommand("gh", ["repo", "clone", targetRepo, targetDir, "--", "--depth=1"]);
  return targetDir;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function runCommand(command: string, commandArgs: string[]) {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot(),
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${commandArgs.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
}

function writeBlockedResult(summary: LooseRecord) {
  if (fs.existsSync(resultPath)) return;
  const result = {
    status: "blocked",
    repo: job.frontmatter.repo,
    cluster_id: job.frontmatter.cluster_id,
    mode,
    summary,
    actions: [],
    needs_human: [summary],
    canonical: null,
    canonical_issue: null,
    canonical_pr: null,
    fix_artifact: null,
  };
  sanitizeResultEvidence(result);
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
}

function sanitizeResultFile(filePath: string) {
  if (!fs.existsSync(filePath)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object") return;
  sanitizeResultEvidence(parsed as LooseRecord);
  fs.writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`);
}
