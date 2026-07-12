import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCommand as run } from "./command-runner.js";
import { parsePullRequestUrl } from "./github-ref.js";
import type { JsonValue, LooseRecord } from "./json-types.js";
import { assertAllowedOwner, parseJob, validateJob } from "./lib.js";
import {
  prepareTargetToolchain,
  runStagedValidationProof,
  type TargetValidationOptions,
} from "./target-validation.js";
import {
  isPassedStagedProofBundle,
  stagedProofBundle,
  stagedProofPlanArtifact,
} from "./staged-proof-gates.js";

const AUTHORIZATION_SCHEMA_VERSION = 1;
const EXECUTION_SCHEMA_VERSION = 1;
const VALIDATION_RECEIPT_SCHEMA_VERSION = 1;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const MAX_HANDOFF_FILES = 4_096;

type FileDigest = {
  path: string;
  sha256: string;
  size: number;
};

export type ExecutionAuthorization = {
  schema_version: number;
  workflow_run_id: string;
  workflow_run_attempt: string;
  workflow_repository: string;
  workflow_sha: string;
  source_job_path: string;
  target_repo: string;
  target_owner: string;
  target_name: string;
  cluster_id: string;
  mode: string;
  job_sha256: string;
  result_sha256: string;
  identity_sha256: string;
};

export type ExecutionManifest = {
  schema_version: number;
  authorization_sha256: string;
  execute_outcome: string;
  mutation_ready: boolean;
  report_sha256: string | null;
  files: FileDigest[];
  tree_sha256: string;
  identity_sha256: string;
};

export type ValidationReceipt = {
  schema_version: number;
  authorization_sha256: string;
  execution_manifest_sha256: string;
  target_repo: string;
  validated_head_sha: string;
  validated_base_sha: string;
  validation_proof_plan: LooseRecord;
  validation_proof: LooseRecord;
  identity_sha256: string;
};

export function prepareExecutionAuthorization({
  jobPath,
  runsRoot,
  outputRoot,
  workflowRunId,
  workflowRunAttempt,
  workflowRepository,
  workflowSha,
  allowedOwner,
}: {
  jobPath: string;
  runsRoot: string;
  outputRoot: string;
  workflowRunId: string;
  workflowRunAttempt: string;
  workflowRepository: string;
  workflowSha: string;
  allowedOwner: string;
}): ExecutionAuthorization {
  const job = parseJob(jobPath);
  const jobErrors = validateJob(job);
  if (jobErrors.length > 0) throw new Error(`invalid execution job: ${jobErrors.join("; ")}`);
  const targetRepo = String(job.frontmatter.repo ?? "");
  assertAllowedOwner(targetRepo, allowedOwner);
  const targetMatch = targetRepo.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!targetMatch) throw new Error(`invalid target repository: ${targetRepo}`);
  const sourcePathParts = job.relativePath.split(path.sep);
  if (
    sourcePathParts[0] !== "jobs" ||
    sourcePathParts[1]?.toLowerCase() !== targetMatch[1]!.toLowerCase()
  ) {
    throw new Error("job path owner does not match the immutable target repository");
  }

  const runDirectory = selectSingleRunDirectory(runsRoot);
  const sourceResultPath = path.join(runDirectory, "result.json");
  const result = readJsonObject(sourceResultPath, "worker result");
  assertResultMatchesJob(result, job.frontmatter);
  assertSafeTree(runDirectory);

  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(outputRoot, "run"), { recursive: true });
  fs.copyFileSync(job.path, path.join(outputRoot, "job.md"));
  copyTree(runDirectory, path.join(outputRoot, "run"));

  const [, targetOwner, targetName] = targetMatch;
  const identity = {
    schema_version: AUTHORIZATION_SCHEMA_VERSION,
    workflow_run_id: requiredText(workflowRunId, "workflow run id"),
    workflow_run_attempt: requiredText(workflowRunAttempt, "workflow run attempt"),
    workflow_repository: requiredRepo(workflowRepository, "workflow repository"),
    workflow_sha: requiredSha(workflowSha, "workflow SHA"),
    source_job_path: job.relativePath,
    target_repo: targetRepo,
    target_owner: targetOwner!,
    target_name: targetName!,
    cluster_id: requiredText(job.frontmatter.cluster_id, "cluster id"),
    mode: requiredText(job.frontmatter.mode, "job mode"),
    job_sha256: sha256File(path.join(outputRoot, "job.md")),
    result_sha256: sha256File(path.join(outputRoot, "run", "result.json")),
  };
  const authorization: ExecutionAuthorization = {
    ...identity,
    identity_sha256: digestJson(identity),
  };
  writeJson(path.join(outputRoot, "authorization.json"), authorization);
  verifyExecutionAuthorization(outputRoot, authorization.identity_sha256);
  return authorization;
}

export function verifyExecutionAuthorization(
  root: string,
  expectedAuthorizationSha256: string,
): ExecutionAuthorization {
  requireDigest(expectedAuthorizationSha256, "expected authorization digest");
  assertExactTopLevel(root, ["authorization.json", "job.md", "run"], ["execution-manifest.json"]);
  assertSafeTree(root);

  const authorization = readJsonObject(
    path.join(root, "authorization.json"),
    "execution authorization",
  ) as ExecutionAuthorization;
  const { identity_sha256: identitySha256, ...identity } = authorization;
  if (
    authorization.schema_version !== AUTHORIZATION_SCHEMA_VERSION ||
    identitySha256 !== digestJson(identity) ||
    identitySha256 !== expectedAuthorizationSha256
  ) {
    throw new Error("execution authorization digest does not match trusted pre-execution identity");
  }
  if (
    sha256File(path.join(root, "job.md")) !== authorization.job_sha256 ||
    sha256File(path.join(root, "run", "result.json")) !== authorization.result_sha256
  ) {
    throw new Error("execution authorization job or result digest changed");
  }
  const job = parseJob(path.join(root, "job.md"));
  const jobErrors = validateJob(job);
  if (jobErrors.length > 0) throw new Error(`invalid authorized job: ${jobErrors.join("; ")}`);
  const result = readJsonObject(path.join(root, "run", "result.json"), "authorized result");
  assertResultMatchesJob(result, job.frontmatter);
  if (
    job.frontmatter.repo !== authorization.target_repo ||
    job.frontmatter.cluster_id !== authorization.cluster_id ||
    job.frontmatter.mode !== authorization.mode
  ) {
    throw new Error("execution authorization identity does not match its immutable job");
  }
  return authorization;
}

export function sealExecutionHandoff({
  root,
  expectedAuthorizationSha256,
  executeOutcome,
}: {
  root: string;
  expectedAuthorizationSha256: string;
  executeOutcome: string;
}): ExecutionManifest {
  verifyExecutionAuthorization(root, expectedAuthorizationSha256);
  const reportPath = path.join(root, "run", "fix-execution-report.json");
  const report = fs.existsSync(reportPath)
    ? readJsonObject(reportPath, "fix execution report")
    : null;
  const files = digestTree(root, new Set(["execution-manifest.json"]));
  const identity = {
    schema_version: EXECUTION_SCHEMA_VERSION,
    authorization_sha256: expectedAuthorizationSha256,
    execute_outcome: requiredText(executeOutcome, "execute outcome"),
    mutation_ready:
      executeOutcome === "success" && report !== null && hasSuccessfulFixMutation(report),
    report_sha256: report ? sha256File(reportPath) : null,
    files,
    tree_sha256: digestJson(files),
  };
  const manifest: ExecutionManifest = {
    ...identity,
    identity_sha256: digestJson(identity),
  };
  writeJson(path.join(root, "execution-manifest.json"), manifest);
  verifyExecutionHandoff(root, expectedAuthorizationSha256);
  return manifest;
}

export function verifyExecutionHandoff(
  root: string,
  expectedAuthorizationSha256: string,
): ExecutionManifest {
  verifyExecutionAuthorization(root, expectedAuthorizationSha256);
  const manifest = readJsonObject(
    path.join(root, "execution-manifest.json"),
    "execution manifest",
  ) as ExecutionManifest;
  const { identity_sha256: identitySha256, ...identity } = manifest;
  if (
    manifest.schema_version !== EXECUTION_SCHEMA_VERSION ||
    manifest.authorization_sha256 !== expectedAuthorizationSha256 ||
    identitySha256 !== digestJson(identity)
  ) {
    throw new Error("execution manifest digest does not match its authorization");
  }
  const files = digestTree(root, new Set(["execution-manifest.json"]));
  if (
    digestJson(files) !== manifest.tree_sha256 ||
    JSON.stringify(files) !== JSON.stringify(manifest.files)
  ) {
    throw new Error("execution handoff file set or digest changed");
  }
  const reportPath = path.join(root, "run", "fix-execution-report.json");
  const reportSha256 = fs.existsSync(reportPath) ? sha256File(reportPath) : null;
  if (reportSha256 !== manifest.report_sha256) {
    throw new Error("execution report digest does not match the execution manifest");
  }
  if (manifest.mutation_ready) {
    const report = readJsonObject(reportPath, "fix execution report");
    if (manifest.execute_outcome !== "success" || !hasSuccessfulFixMutation(report)) {
      throw new Error("execution manifest marks a non-successful repair as mutation-ready");
    }
  }
  return manifest;
}

export function validateExecutionHandoff({
  root,
  outputPath,
  expectedAuthorizationSha256,
}: {
  root: string;
  outputPath: string;
  expectedAuthorizationSha256: string;
}): ValidationReceipt {
  const authorization = verifyExecutionAuthorization(root, expectedAuthorizationSha256);
  const manifest = verifyExecutionHandoff(root, expectedAuthorizationSha256);
  if (!manifest.mutation_ready) {
    throw new Error("execution handoff is report-only and cannot produce a mutation receipt");
  }

  const result = readJsonObject(path.join(root, "run", "result.json"), "authorized result");
  const report = readJsonObject(
    path.join(root, "run", "fix-execution-report.json"),
    "fix execution report",
  );
  const action = successfulFixMutation(report);
  if (!action) throw new Error("execution report has no successful fix mutation");
  const target = parsePullRequestUrl(action.pr_url ?? action.target);
  if (!target || target.repo !== authorization.target_repo) {
    throw new Error("successful fix mutation is not bound to the authorized target repository");
  }

  const mergePreflight = objectValue(action.merge_preflight, "merge preflight");
  const expectedHeadSha = requiredSha(action.commit, "fix action commit");
  const expectedBaseSha = requiredSha(
    mergePreflight.validated_base_sha,
    "fix action validated base",
  );
  const executionProofPlan = objectValue(report.validation_proof_plan, "execution proof plan");
  const executionProof = objectValue(mergePreflight.validation_proof, "execution validation proof");
  if (
    !isPassedStagedProofBundle(executionProof, executionProofPlan) ||
    executionProof.validated_head_sha !== expectedHeadSha ||
    executionProof.validated_base_sha !== expectedBaseSha
  ) {
    throw new Error("execution proof is not bound to the successful fix head and base");
  }

  const checkout = checkoutPublishedRepair({
    repo: authorization.target_repo,
    pullNumber: target.number,
    expectedHeadSha,
    expectedBaseSha,
  });
  try {
    const validationCommands = arrayValue(
      mergePreflight.validation_commands,
      "merge preflight validation commands",
    );
    const options: TargetValidationOptions = {
      additionalValidationCommands: [],
      allowExpensiveValidation: true,
      installTargetDeps: true,
      pinnedBaseRef: expectedBaseSha,
      proofSurfacePaths: Array.isArray(result.fix_artifact?.likely_files)
        ? result.fix_artifact.likely_files.map(String)
        : [],
      strictTargetValidation: true,
      targetRepo: authorization.target_repo,
    };
    prepareTargetToolchain(checkout, options);
    const independentProof = runStagedValidationProof(
      validationCommands,
      checkout,
      options,
      "main",
    );
    const independentProofPlan = stagedProofPlanArtifact(independentProof.plan);
    if (independentProofPlan.plan_id !== executionProofPlan.plan_id) {
      throw new Error("independent validation plan does not match the execution proof plan");
    }

    verifyExecutionHandoff(root, expectedAuthorizationSha256);
    const validationProof = stagedProofBundle([independentProof.trace]) as LooseRecord;
    if (!isPassedStagedProofBundle(validationProof, independentProofPlan)) {
      throw new Error("independent validation proof did not pass");
    }
    const identity = {
      schema_version: VALIDATION_RECEIPT_SCHEMA_VERSION,
      authorization_sha256: expectedAuthorizationSha256,
      execution_manifest_sha256: manifest.identity_sha256,
      target_repo: authorization.target_repo,
      validated_head_sha: expectedHeadSha,
      validated_base_sha: expectedBaseSha,
      validation_proof_plan: independentProofPlan as LooseRecord,
      validation_proof: validationProof,
    };
    const receipt: ValidationReceipt = {
      ...identity,
      identity_sha256: digestJson(identity),
    };
    writeJson(outputPath, receipt);
    return receipt;
  } finally {
    fs.rmSync(path.dirname(checkout), { recursive: true, force: true });
  }
}

export function verifyValidationReceipt({
  root,
  receiptPath,
  expectedAuthorizationSha256,
  expectedReceiptSha256,
}: {
  root: string;
  receiptPath: string;
  expectedAuthorizationSha256: string;
  expectedReceiptSha256: string;
}): ValidationReceipt {
  requireDigest(expectedReceiptSha256, "expected validation receipt digest");
  const authorization = verifyExecutionAuthorization(root, expectedAuthorizationSha256);
  const manifest = verifyExecutionHandoff(root, expectedAuthorizationSha256);
  if (!manifest.mutation_ready || manifest.execute_outcome !== "success") {
    throw new Error("report-only execution cannot authorize privileged mutation");
  }
  const receipt = readJsonObject(receiptPath, "validation receipt") as ValidationReceipt;
  const { identity_sha256: identitySha256, ...identity } = receipt;
  if (
    receipt.schema_version !== VALIDATION_RECEIPT_SCHEMA_VERSION ||
    identitySha256 !== digestJson(identity) ||
    identitySha256 !== expectedReceiptSha256 ||
    receipt.authorization_sha256 !== expectedAuthorizationSha256 ||
    receipt.execution_manifest_sha256 !== manifest.identity_sha256 ||
    receipt.target_repo !== authorization.target_repo ||
    !isPassedStagedProofBundle(receipt.validation_proof, receipt.validation_proof_plan)
  ) {
    throw new Error("validation receipt does not authorize this exact execution handoff");
  }
  return receipt;
}

function checkoutPublishedRepair({
  repo,
  pullNumber,
  expectedHeadSha,
  expectedBaseSha,
}: {
  repo: string;
  pullNumber: number;
  expectedHeadSha: string;
  expectedBaseSha: string;
}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-proof-replay-"));
  const checkout = path.join(root, "target");
  try {
    fs.mkdirSync(checkout);
    run("git", ["init"], { cwd: checkout });
    run("git", ["remote", "add", "origin", `https://github.com/${repo}.git`], {
      cwd: checkout,
    });
    run(
      "git",
      [
        "fetch",
        "--no-tags",
        "--filter=blob:none",
        "origin",
        "+refs/heads/main:refs/remotes/origin/main",
        `+refs/pull/${pullNumber}/head:refs/remotes/clawsweeper/validation-head`,
      ],
      { cwd: checkout },
    );
    const liveBaseSha = run("git", ["rev-parse", "refs/remotes/origin/main"], {
      cwd: checkout,
    }).trim();
    const liveHeadSha = run("git", ["rev-parse", "refs/remotes/clawsweeper/validation-head"], {
      cwd: checkout,
    }).trim();
    if (liveBaseSha !== expectedBaseSha) {
      throw new Error("origin/main moved after execution proof; refusing stale mutation");
    }
    if (liveHeadSha !== expectedHeadSha) {
      throw new Error("published repair head moved after execution proof");
    }
    run("git", ["checkout", "--detach", expectedHeadSha], { cwd: checkout });
    return checkout;
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function selectSingleRunDirectory(runsRoot: string): string {
  const entries = fs.readdirSync(runsRoot, { withFileTypes: true });
  if (entries.length !== 1) {
    throw new Error(
      `worker handoff must contain exactly one run directory; found ${entries.length}`,
    );
  }
  const entry = entries[0]!;
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error("worker handoff entry must be one real run directory");
  }
  const runDirectory = path.join(runsRoot, entry.name);
  if (!fs.statSync(path.join(runDirectory, "result.json")).isFile()) {
    throw new Error("worker handoff run directory is missing result.json");
  }
  return runDirectory;
}

function assertResultMatchesJob(result: LooseRecord, frontmatter: LooseRecord) {
  for (const key of ["repo", "cluster_id", "mode"] as const) {
    if (String(result[key] ?? "") !== String(frontmatter[key] ?? "")) {
      throw new Error(`worker result ${key} does not match the immutable job`);
    }
  }
}

function successfulFixMutation(report: LooseRecord): LooseRecord | null {
  const successful = (report.actions ?? []).filter((action: JsonValue) => {
    const name = String(action?.action ?? "");
    const status = String(action?.status ?? "");
    return (
      (name === "repair_contributor_branch" && status === "pushed") ||
      (name === "open_fix_pr" && status === "opened")
    );
  });
  if (successful.length !== 1) return null;
  return successful[0] as LooseRecord;
}

function hasSuccessfulFixMutation(report: LooseRecord): boolean {
  return successfulFixMutation(report) !== null;
}

function copyTree(source: string, target: string) {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`handoff contains symlink: ${entry.name}`);
    if (entry.isDirectory()) {
      fs.mkdirSync(targetPath);
      copyTree(sourcePath, targetPath);
      continue;
    }
    if (!entry.isFile()) throw new Error(`handoff contains non-file entry: ${entry.name}`);
    fs.copyFileSync(sourcePath, targetPath);
  }
}

function assertSafeTree(root: string) {
  let count = 0;
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      count += 1;
      if (count > MAX_HANDOFF_FILES) throw new Error("handoff exceeds maximum file count");
      if (entry.isSymbolicLink()) {
        throw new Error(
          `handoff contains symlink: ${path.relative(root, path.join(directory, entry.name))}`,
        );
      }
      if (entry.isDirectory()) {
        visit(path.join(directory, entry.name));
      } else if (!entry.isFile()) {
        throw new Error(
          `handoff contains non-file entry: ${path.relative(root, path.join(directory, entry.name))}`,
        );
      }
    }
  };
  visit(root);
}

function assertExactTopLevel(root: string, required: string[], optional: string[] = []) {
  const names = fs.readdirSync(root).sort();
  for (const name of required) {
    if (!names.includes(name)) throw new Error(`handoff is missing ${name}`);
  }
  const allowed = new Set([...required, ...optional]);
  const unexpected = names.filter((name) => !allowed.has(name));
  if (unexpected.length > 0) {
    throw new Error(`handoff contains unexpected top-level entries: ${unexpected.join(", ")}`);
  }
}

function digestTree(root: string, excludedTopLevel: ReadonlySet<string>): FileDigest[] {
  const files: FileDigest[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (!relative.includes("/") && excludedTopLevel.has(relative)) continue;
      if (entry.isSymbolicLink()) throw new Error(`handoff contains symlink: ${relative}`);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        const stat = fs.statSync(absolute);
        files.push({ path: relative, sha256: sha256File(absolute), size: stat.size });
      } else {
        throw new Error(`handoff contains non-file entry: ${relative}`);
      }
    }
  };
  visit(root);
  if (files.length > MAX_HANDOFF_FILES) throw new Error("handoff exceeds maximum file count");
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function readJsonObject(filePath: string, label: string): LooseRecord {
  const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return objectValue(value, label);
}

function objectValue(value: unknown, label: string): LooseRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as LooseRecord;
}

function arrayValue(value: unknown, label: string): JsonValue[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  return value;
}

function requiredText(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function requiredRepo(value: unknown, label: string): string {
  const repo = requiredText(value, label);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`${label} must be owner/repo`);
  }
  return repo;
}

function requiredSha(value: unknown, label: string): string {
  const sha = requiredText(value, label).toLowerCase();
  if (!SHA_PATTERN.test(sha)) throw new Error(`${label} must be a full commit SHA`);
  return sha;
}

function requireDigest(value: string, label: string) {
  if (!DIGEST_PATTERN.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
}

function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function digestJson(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
