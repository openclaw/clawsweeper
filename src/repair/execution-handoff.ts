import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCommand as run } from "./command-runner.js";
import { closingReferencesFromMarkdown } from "./external-messages.js";
import { parsePullRequestUrl } from "./github-ref.js";
import { issueSourceStateBlockReason } from "./issue-source-guard.js";
import type { JsonValue, LooseRecord } from "./json-types.js";
import { assertAllowedOwner, parseJob, validateJob, type ParsedJob } from "./lib.js";
import {
  EXECUTION_INTENT_SCHEMA_VERSION,
  type ExecutionIntent,
  type PreparedPublication,
  type PublicationReceipt,
  digestJson,
  publicationReceipt,
  sha256File,
  verifyExecutionIntentIdentity,
  verifyPreparedPublication,
  verifyPublicationReceipt,
  writeJson,
} from "./prepared-publication.js";
import {
  isPassedStagedProofBundle,
  stagedProofBundle,
  stagedProofPlanArtifact,
  type StagedProofPlanArtifact,
} from "./staged-proof-gates.js";
import {
  buildTargetValidationProofPlan,
  prepareTargetToolchain,
  repairDeltaValidationPlan,
  replayStagedValidationProof,
  type TargetValidationOptions,
} from "./target-validation.js";

const AUTHORIZATION_SCHEMA_VERSION = 2;
const EXECUTION_SCHEMA_VERSION = 2;
const VALIDATION_RECEIPT_SCHEMA_VERSION = 2;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const MAX_HANDOFF_FILES = 4_096;

type FileDigest = {
  path: string;
  sha256: string;
  size: number;
};

type IntentResolver = (options: {
  job: ParsedJob;
  result: LooseRecord;
  actionIdentitySha256: string;
  closeSupersededSourcePrs: boolean;
}) => ExecutionIntent;

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
  execution_intent_sha256: string;
  action_identity_sha256: string;
  identity_sha256: string;
};

export type ExecutionManifest = {
  schema_version: number;
  authorization_sha256: string;
  execute_outcome: string;
  mutation_ready: boolean;
  report_sha256: string | null;
  publication_sha256: string | null;
  files: FileDigest[];
  tree_sha256: string;
  identity_sha256: string;
};

export type ValidationReceipt = {
  schema_version: number;
  authorization_sha256: string;
  execution_manifest_sha256: string;
  execution_intent_sha256: string;
  action_identity_sha256: string;
  prepared_publication_sha256: string;
  target_repo: string;
  operation: ExecutionIntent["operation"];
  output_repo: string;
  output_branch: string;
  source: ExecutionIntent["source"];
  validated_head_sha: string;
  validated_tree_sha: string;
  validated_base_sha: string;
  validation_proof_plan: StagedProofPlanArtifact;
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
  closeSupersededSourcePrs = false,
  resolveIntent = resolveLiveExecutionIntent,
}: {
  jobPath: string;
  runsRoot: string;
  outputRoot: string;
  workflowRunId: string;
  workflowRunAttempt: string;
  workflowRepository: string;
  workflowSha: string;
  allowedOwner: string;
  closeSupersededSourcePrs?: boolean;
  resolveIntent?: IntentResolver;
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
  const actionIdentitySha256 = repairActionIdentity(result);
  const executionIntent = resolveIntent({
    job,
    result,
    actionIdentitySha256,
    closeSupersededSourcePrs,
  });
  verifyExecutionIntentIdentity(executionIntent);
  assertExecutionIntentBindings(executionIntent, job, result);
  if (
    executionIntent.target_repo !== targetRepo ||
    executionIntent.action_identity_sha256 !== actionIdentitySha256
  ) {
    throw new Error("resolved execution intent does not match the immutable repair action");
  }

  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(outputRoot, "run"), { recursive: true });
  fs.copyFileSync(job.path, path.join(outputRoot, "job.md"));
  copyTree(runDirectory, path.join(outputRoot, "run"));
  writeJson(path.join(outputRoot, "execution-intent.json"), executionIntent);

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
    execution_intent_sha256: executionIntent.identity_sha256,
    action_identity_sha256: actionIdentitySha256,
  };
  const authorization: ExecutionAuthorization = {
    ...identity,
    identity_sha256: digestJson(identity),
  };
  writeJson(path.join(outputRoot, "authorization.json"), authorization);
  verifyExecutionAuthorization(outputRoot, authorization.identity_sha256);
  return authorization;
}

function assertExecutionIntentBindings(
  intent: ExecutionIntent,
  job: ParsedJob,
  result: LooseRecord,
) {
  const intendedSourceNumber = intendedJobSourceNumber(job, result, intent.target_repo);
  if (intendedSourceNumber && intent.source.number !== intendedSourceNumber) {
    throw new Error("resolved execution intent redirected the immutable source item");
  }
  if (
    intent.source.repo !== intent.target_repo ||
    (intent.source.kind === "pull_request" &&
      (intent.source.url !==
        `https://github.com/${intent.target_repo}/pull/${intent.source.number}` ||
        intent.source.expected_state !== "open" ||
        intent.source.expected_base_ref !== "main")) ||
    (job.frontmatter.source === "issue_implementation" &&
      (intent.source.kind !== "issue" ||
        intent.source.number !== Number(job.frontmatter.source_issue_number) ||
        intent.source.repo !== job.frontmatter.source_issue_repo ||
        intent.source.expected_revision_sha256 !== job.frontmatter.source_issue_revision_sha256)) ||
    (job.frontmatter.source === "clawsweeper_commit" &&
      (intent.source.kind !== "commit" ||
        intent.source.expected_head_sha !== job.frontmatter.commit_sha))
  ) {
    throw new Error("resolved execution intent changed the authorized source identity");
  }
  for (const expected of [job.frontmatter.expected_head_sha, result.reviewed_sha]) {
    if (
      expected &&
      SHA_PATTERN.test(String(expected)) &&
      intent.source.expected_head_sha !== String(expected)
    ) {
      throw new Error("resolved execution intent changed the expected source head");
    }
  }
  if (
    intent.output_repo !== intent.target_repo ||
    intent.target_base_ref !== "main" ||
    (intent.operation === "update_source_pr" &&
      (intent.source.kind !== "pull_request" ||
        intent.output_branch !== intent.source.expected_head_ref ||
        intent.action_name !== "repair_contributor_branch")) ||
    (intent.operation === "open_pull_request" &&
      (intent.action_name !== "open_fix_pr" ||
        intent.output_branch !==
          (job.frontmatter.target_branch ?? `clawsweeper/${job.frontmatter.cluster_id}`)))
  ) {
    throw new Error("resolved execution intent changed the authorized output operation");
  }
}

export function verifyExecutionAuthorization(
  root: string,
  expectedAuthorizationSha256: string,
): ExecutionAuthorization {
  requireDigest(expectedAuthorizationSha256, "expected authorization digest");
  assertExactTopLevel(
    root,
    ["authorization.json", "execution-intent.json", "job.md", "run"],
    ["execution-manifest.json"],
  );
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
  const intent = readExecutionIntent(root);
  if (
    intent.identity_sha256 !== authorization.execution_intent_sha256 ||
    intent.action_identity_sha256 !== authorization.action_identity_sha256 ||
    intent.target_repo !== authorization.target_repo
  ) {
    throw new Error("execution authorization intent digest changed");
  }
  const job = parseJob(path.join(root, "job.md"));
  const jobErrors = validateJob(job);
  if (jobErrors.length > 0) throw new Error(`invalid authorized job: ${jobErrors.join("; ")}`);
  const result = readJsonObject(path.join(root, "run", "result.json"), "authorized result");
  assertResultMatchesJob(result, job.frontmatter);
  if (
    job.frontmatter.repo !== authorization.target_repo ||
    job.frontmatter.cluster_id !== authorization.cluster_id ||
    job.frontmatter.mode !== authorization.mode ||
    repairActionIdentity(result) !== authorization.action_identity_sha256
  ) {
    throw new Error("execution authorization identity does not match its immutable job");
  }
  return authorization;
}

export function readExecutionIntent(root: string): ExecutionIntent {
  return verifyExecutionIntentIdentity(
    readJsonObject(path.join(root, "execution-intent.json"), "execution intent") as ExecutionIntent,
  );
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
  const publicationPath = path.join(root, "run", "publication-intent.json");
  const publication = fs.existsSync(publicationPath)
    ? readJsonObject(publicationPath, "prepared publication")
    : null;
  const mutationReady =
    executeOutcome === "success" &&
    report !== null &&
    publication !== null &&
    hasPreparedFixMutation(report);
  if (mutationReady) {
    verifyAuthorizedPreparedPublication(root, expectedAuthorizationSha256);
  }
  const files = digestTree(root, new Set(["execution-manifest.json"]));
  const identity = {
    schema_version: EXECUTION_SCHEMA_VERSION,
    authorization_sha256: expectedAuthorizationSha256,
    execute_outcome: requiredText(executeOutcome, "execute outcome"),
    mutation_ready: mutationReady,
    report_sha256: report ? sha256File(reportPath) : null,
    publication_sha256: publication ? sha256File(publicationPath) : null,
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
  const publicationPath = path.join(root, "run", "publication-intent.json");
  if (
    (fs.existsSync(reportPath) ? sha256File(reportPath) : null) !== manifest.report_sha256 ||
    (fs.existsSync(publicationPath) ? sha256File(publicationPath) : null) !==
      manifest.publication_sha256
  ) {
    throw new Error("execution report or publication digest does not match the manifest");
  }
  if (manifest.mutation_ready) {
    const report = readJsonObject(reportPath, "fix execution report");
    if (manifest.execute_outcome !== "success" || !hasPreparedFixMutation(report)) {
      throw new Error("execution manifest marks a non-successful repair as mutation-ready");
    }
    verifyAuthorizedPreparedPublication(root, expectedAuthorizationSha256);
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
  const intent = readExecutionIntent(root);
  const result = readJsonObject(path.join(root, "run", "result.json"), "authorized result");
  const report = readJsonObject(
    path.join(root, "run", "fix-execution-report.json"),
    "fix execution report",
  );
  const action = preparedFixMutation(report);
  if (!action) throw new Error("execution report has no exact prepared fix mutation");
  const publication = verifyAuthorizedPreparedPublication(root, expectedAuthorizationSha256);
  if (
    action.commit !== publication.prepared_head_sha ||
    action.prepared_tree_sha !== publication.prepared_tree_sha ||
    action.publication_intent_sha256 !== publication.identity_sha256 ||
    action.action !== intent.action_name ||
    action.status !== "prepared"
  ) {
    throw new Error("prepared fix action does not match the authorized publication");
  }

  const mergePreflight = objectValue(action.merge_preflight, "merge preflight");
  const executionProofPlan = objectValue(
    report.validation_proof_plan,
    "execution proof plan",
  ) as StagedProofPlanArtifact;
  const executionProof = objectValue(mergePreflight.validation_proof, "execution validation proof");

  const checkout = checkoutPreparedRepair({ root, intent, publication });
  try {
    const job = parseJob(path.join(root, "job.md"));
    const fixArtifact = objectValue(result.fix_artifact, "fix artifact");
    const automergeTargetValidation =
      String(job.frontmatter.source ?? "") === "pr_automerge" ||
      String(job.frontmatter.cluster_id ?? "").startsWith("automerge-");
    const options: TargetValidationOptions = {
      additionalValidationCommands:
        automergeTargetValidation && authorization.target_repo === "openclaw/openclaw"
          ? ["pnpm lint", "pnpm check:test-types"]
          : [],
      allowExpensiveValidation: true,
      installTargetDeps: true,
      pinnedBaseRef: publication.target_base_sha,
      proofSurfacePaths: Array.isArray(fixArtifact.likely_files)
        ? fixArtifact.likely_files.map(String)
        : [],
      strictTargetValidation: true,
      targetRepo: authorization.target_repo,
    };
    const immutableBeforeSetup = checkoutIdentity(checkout, publication.target_base_sha);
    prepareTargetToolchain(checkout, options);
    assertCheckoutIdentity(checkout, publication.target_base_sha, immutableBeforeSetup);
    const validationPlan = repairDeltaValidationPlan(
      {
        fixArtifact,
        targetDir: checkout,
        sourceHead: intent.source.expected_head_sha,
      },
      options,
    );
    const independentlyRequiredPlan = buildTargetValidationProofPlan(
      validationPlan.commands,
      checkout,
      validationPlan.options,
      publication.target_base_ref,
    );
    assertExactValidationProofPlan(executionProofPlan, independentlyRequiredPlan);
    if (
      !isPassedStagedProofBundle(executionProof, independentlyRequiredPlan) ||
      executionProof.validated_head_sha !== publication.prepared_head_sha ||
      executionProof.validated_base_sha !== publication.target_base_sha
    ) {
      throw new Error("execution proof is not bound to the prepared repair head and base");
    }
    const independentProof = replayStagedValidationProof(
      independentlyRequiredPlan,
      checkout,
      validationPlan.options,
      publication.target_base_ref,
    );
    const independentProofPlan = stagedProofPlanArtifact(independentProof.plan);
    if (JSON.stringify(independentProofPlan) !== JSON.stringify(independentlyRequiredPlan)) {
      throw new Error("independent validation did not replay the exact normalized proof plan");
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
      execution_intent_sha256: intent.identity_sha256,
      action_identity_sha256: intent.action_identity_sha256,
      prepared_publication_sha256: publication.identity_sha256,
      target_repo: authorization.target_repo,
      operation: intent.operation,
      output_repo: intent.output_repo,
      output_branch: intent.output_branch,
      source: intent.source,
      validated_head_sha: publication.prepared_head_sha,
      validated_tree_sha: publication.prepared_tree_sha,
      validated_base_sha: publication.target_base_sha,
      validation_proof_plan: independentProofPlan,
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

export function assertExactValidationProofPlan(
  executionProofPlan: StagedProofPlanArtifact,
  independentlyRequiredPlan: StagedProofPlanArtifact,
) {
  if (JSON.stringify(executionProofPlan) !== JSON.stringify(independentlyRequiredPlan)) {
    throw new Error("execution proof plan differs from independently required validation policy");
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
  const intent = readExecutionIntent(root);
  if (!manifest.mutation_ready || manifest.execute_outcome !== "success") {
    throw new Error("report-only execution cannot authorize privileged mutation");
  }
  const publication = verifyAuthorizedPreparedPublication(root, expectedAuthorizationSha256);
  const receipt = readJsonObject(receiptPath, "validation receipt") as ValidationReceipt;
  const { identity_sha256: identitySha256, ...identity } = receipt;
  if (
    receipt.schema_version !== VALIDATION_RECEIPT_SCHEMA_VERSION ||
    identitySha256 !== digestJson(identity) ||
    identitySha256 !== expectedReceiptSha256 ||
    receipt.authorization_sha256 !== expectedAuthorizationSha256 ||
    receipt.execution_manifest_sha256 !== manifest.identity_sha256 ||
    receipt.execution_intent_sha256 !== intent.identity_sha256 ||
    receipt.action_identity_sha256 !== intent.action_identity_sha256 ||
    receipt.prepared_publication_sha256 !== publication.identity_sha256 ||
    receipt.target_repo !== authorization.target_repo ||
    receipt.operation !== intent.operation ||
    receipt.output_repo !== intent.output_repo ||
    receipt.output_branch !== intent.output_branch ||
    JSON.stringify(receipt.source) !== JSON.stringify(intent.source) ||
    receipt.validated_head_sha !== publication.prepared_head_sha ||
    receipt.validated_tree_sha !== publication.prepared_tree_sha ||
    receipt.validated_base_sha !== publication.target_base_sha ||
    !isPassedStagedProofBundle(receipt.validation_proof, receipt.validation_proof_plan)
  ) {
    throw new Error("validation receipt does not authorize this exact execution handoff");
  }
  return receipt;
}

export function publishValidatedExecution({
  root,
  validationReceiptPath,
  expectedAuthorizationSha256,
  expectedValidationReceiptSha256,
  outputPath,
}: {
  root: string;
  validationReceiptPath: string;
  expectedAuthorizationSha256: string;
  expectedValidationReceiptSha256: string;
  outputPath: string;
}): PublicationReceipt {
  const validationReceipt = verifyValidationReceipt({
    root,
    receiptPath: validationReceiptPath,
    expectedAuthorizationSha256,
    expectedReceiptSha256: expectedValidationReceiptSha256,
  });
  const intent = readExecutionIntent(root);
  const publication = verifyAuthorizedPreparedPublication(root, expectedAuthorizationSha256);
  revalidateLiveSource(intent);
  const checkout = checkoutPreparedRepair({ root, intent, publication });
  const mutations: LooseRecord[] = [];
  try {
    run("gh", ["auth", "setup-git"], { cwd: checkout });
    const targetPrNumber =
      intent.operation === "update_source_pr"
        ? publishSourceBranchRepair({ checkout, intent, publication, mutations })
        : publishReplacementRepair({ checkout, intent, publication, mutations });
    const receipt = publicationReceipt({
      validationReceiptSha256: validationReceipt.identity_sha256,
      publication,
      targetPrNumber,
      mutations,
    });
    writeJson(outputPath, receipt);
    return receipt;
  } finally {
    fs.rmSync(path.dirname(checkout), { recursive: true, force: true });
  }
}

export function verifyPublishedReceipt({
  root,
  publicationReceiptPath,
  validationReceiptPath,
  expectedAuthorizationSha256,
  expectedValidationReceiptSha256,
  expectedPublicationReceiptSha256,
}: {
  root: string;
  publicationReceiptPath: string;
  validationReceiptPath: string;
  expectedAuthorizationSha256: string;
  expectedValidationReceiptSha256: string;
  expectedPublicationReceiptSha256: string;
}): PublicationReceipt {
  requireDigest(expectedPublicationReceiptSha256, "expected publication receipt digest");
  const validationReceipt = verifyValidationReceipt({
    root,
    receiptPath: validationReceiptPath,
    expectedAuthorizationSha256,
    expectedReceiptSha256: expectedValidationReceiptSha256,
  });
  const publication = verifyAuthorizedPreparedPublication(root, expectedAuthorizationSha256);
  const receipt = readJsonObject(
    publicationReceiptPath,
    "publication receipt",
  ) as PublicationReceipt;
  if (receipt.identity_sha256 !== expectedPublicationReceiptSha256) {
    throw new Error("publication receipt digest changed");
  }
  return verifyPublicationReceipt({
    receipt,
    publication,
    validationReceiptSha256: validationReceipt.identity_sha256,
  });
}

function resolveLiveExecutionIntent({
  job,
  result,
  actionIdentitySha256,
  closeSupersededSourcePrs,
}: {
  job: ParsedJob;
  result: LooseRecord;
  actionIdentitySha256: string;
  closeSupersededSourcePrs: boolean;
}): ExecutionIntent {
  const targetRepo = requiredRepo(result.repo, "target repository");
  const fixArtifact = objectValue(result.fix_artifact, "fix artifact");
  const repairStrategy = requiredText(fixArtifact.repair_strategy, "repair strategy");
  const sourcePrs = ((fixArtifact.source_prs ?? []) as JsonValue[])
    .map((source: JsonValue) => parsePullRequestUrl(source))
    .filter(
      (
        source: ReturnType<typeof parsePullRequestUrl>,
      ): source is NonNullable<ReturnType<typeof parsePullRequestUrl>> =>
        Boolean(source && source.repo === targetRepo),
    );
  const allowedNumbers = jobTargetNumbers(job, targetRepo);
  const sourcePr = sourcePrs[0] ?? null;
  for (const candidate of sourcePrs) {
    if (allowedNumbers.size > 0 && !allowedNumbers.has(candidate.number)) {
      throw new Error(
        `fix artifact source PR #${candidate.number} is outside the immutable job target set`,
      );
    }
  }
  const intendedSourceNumber = intendedJobSourceNumber(job, result, targetRepo);
  if (sourcePr && intendedSourceNumber && sourcePr.number !== intendedSourceNumber) {
    throw new Error(
      `fix artifact source PR #${sourcePr.number} differs from intended source #${intendedSourceNumber}`,
    );
  }

  let source: ExecutionIntent["source"];
  let contributorCredits: LooseRecord[] = [];
  let sourceClosingReferences: string[] = [];
  if (sourcePr) {
    const pull = ghObject(`repos/${targetRepo}/pulls/${sourcePr.number}`);
    const headRepo = requiredRepo(pull.head?.repo?.full_name, "source pull head repository");
    const headRef = requiredRef(pull.head?.ref, "source pull head ref");
    const headSha = requiredSha(pull.head?.sha, "source pull head SHA");
    const sourceBaseRef = requiredRef(pull.base?.ref, "source pull base ref");
    const sourceBaseSha = requiredSha(pull.base?.sha, "source pull base SHA");
    if (String(pull.state ?? "").toLowerCase() !== "open") {
      throw new Error(`source PR #${sourcePr.number} is not open`);
    }
    if (sourceBaseRef !== "main") {
      throw new Error(`source PR #${sourcePr.number} does not target main`);
    }
    for (const expected of [job.frontmatter.expected_head_sha, result.reviewed_sha]) {
      if (expected && SHA_PATTERN.test(String(expected)) && String(expected) !== headSha) {
        throw new Error(`source PR #${sourcePr.number} head changed before authorization`);
      }
    }
    source = {
      kind: "pull_request",
      repo: targetRepo,
      number: sourcePr.number,
      url: sourcePr.url,
      expected_state: "open",
      expected_revision_sha256: null,
      expected_head_repo: headRepo,
      expected_head_ref: headRef,
      expected_head_sha: headSha,
      expected_base_ref: sourceBaseRef,
      expected_base_sha: sourceBaseSha,
    };
    const login = String(pull.user?.login ?? "").trim();
    if (login && !/\[bot\]$/i.test(login)) {
      contributorCredits = [
        {
          login,
          name: login.replace(/[<>\r\n]/g, ""),
          email: `${Number(pull.user?.id) || login}+${login}@users.noreply.github.com`,
          sources: [sourcePr.url],
        },
      ];
    }
    sourceClosingReferences = closingReferencesFromMarkdown(pull.body);
  } else if (
    job.frontmatter.source === "issue_implementation" &&
    Number(job.frontmatter.source_issue_number) > 0
  ) {
    const number = Number(job.frontmatter.source_issue_number);
    const repo = requiredRepo(job.frontmatter.source_issue_repo, "source issue repository");
    if (repo !== targetRepo) throw new Error("source issue repository differs from target");
    const issue = ghObject(`repos/${repo}/issues/${number}`);
    const comments = ghPagedArray(`repos/${repo}/issues/${number}/comments?per_page=100`);
    const expectedRevision = requiredDigest(
      job.frontmatter.source_issue_revision_sha256,
      "source issue revision",
    );
    const block = issueSourceStateBlockReason({ issue, comments, expectedRevision });
    if (block) throw new Error(block);
    source = {
      kind: "issue",
      repo,
      number,
      url: `https://github.com/${repo}/issues/${number}`,
      expected_state: "open",
      expected_revision_sha256: expectedRevision,
      expected_head_repo: null,
      expected_head_ref: null,
      expected_head_sha: null,
      expected_base_ref: null,
      expected_base_sha: null,
    };
    sourceClosingReferences = [`Closes ${repo}#${number}`];
  } else if (job.frontmatter.source === "clawsweeper_commit") {
    source = {
      kind: "commit",
      repo: targetRepo,
      number: null,
      url: null,
      expected_state: "present",
      expected_revision_sha256: null,
      expected_head_repo: targetRepo,
      expected_head_ref: null,
      expected_head_sha: requiredSha(job.frontmatter.commit_sha, "source commit"),
      expected_base_ref: null,
      expected_base_sha: null,
    };
  } else {
    source = {
      kind: "job",
      repo: targetRepo,
      number: null,
      url: null,
      expected_state: "authorized",
      expected_revision_sha256: null,
      expected_head_repo: null,
      expected_head_ref: null,
      expected_head_sha: null,
      expected_base_ref: null,
      expected_base_sha: null,
    };
  }

  const targetBaseRef = "main";
  const targetBase = ghObject(`repos/${targetRepo}/branches/${targetBaseRef}`);
  const targetBaseSha = requiredSha(targetBase.commit?.sha, "target main SHA");
  const updateSource =
    repairStrategy === "repair_contributor_branch" &&
    source.kind === "pull_request" &&
    source.expected_head_repo === targetRepo;
  const operation: ExecutionIntent["operation"] = updateSource
    ? "update_source_pr"
    : "open_pull_request";
  const outputBranch = updateSource
    ? requiredRef(source.expected_head_ref, "source output branch")
    : requiredRef(
        job.frontmatter.target_branch ?? `clawsweeper/${job.frontmatter.cluster_id}`,
        "target output branch",
      );
  const expectedOutputSha = updateSource
    ? source.expected_head_sha
    : ghOptionalRefSha(targetRepo, outputBranch);
  const existingTargetPr = updateSource
    ? source.number
    : openPullForBranch(targetRepo, outputBranch, targetBaseRef);
  const normalizedSourcePrs = sourcePrs.map((entry) => entry.url);
  assertAuthorizedClosingReferences({
    fixArtifact,
    targetRepo,
    source,
    sourceClosingReferences,
  });
  const requestedSuperseded = (fixArtifact.supersede_source_prs ?? normalizedSourcePrs).map(String);
  const supersededSourcePrs =
    operation === "open_pull_request"
      ? normalizedSourcePrs.filter((entry: string) => requestedSuperseded.includes(entry))
      : [];
  const identity = {
    schema_version: EXECUTION_INTENT_SCHEMA_VERSION,
    target_repo: targetRepo,
    source,
    target_base_ref: targetBaseRef,
    target_base_sha: targetBaseSha,
    operation,
    output_repo: targetRepo,
    output_branch: outputBranch,
    expected_output_sha: expectedOutputSha,
    expected_target_pr_number: existingTargetPr,
    action_name: updateSource ? ("repair_contributor_branch" as const) : ("open_fix_pr" as const),
    repair_strategy: updateSource ? repairStrategy : "replace_uneditable_branch",
    action_identity_sha256: actionIdentitySha256,
    source_prs: normalizedSourcePrs,
    source_closing_references: sourceClosingReferences,
    contributor_credits: contributorCredits,
    superseded_source_prs: supersededSourcePrs,
    close_superseded_source_prs: closeSupersededSourcePrs,
  };
  return { ...identity, identity_sha256: digestJson(identity) };
}

function verifyAuthorizedPreparedPublication(
  root: string,
  expectedAuthorizationSha256: string,
): PreparedPublication {
  const authorization = verifyExecutionAuthorization(root, expectedAuthorizationSha256);
  const intent = readExecutionIntent(root);
  const result = readJsonObject(path.join(root, "run", "result.json"), "authorized result");
  const publication = readJsonObject(
    path.join(root, "run", "publication-intent.json"),
    "prepared publication",
  ) as PreparedPublication;
  if (authorization.execution_intent_sha256 !== intent.identity_sha256) {
    throw new Error("prepared publication authorization intent changed");
  }
  return verifyPreparedPublication({
    publication,
    executionIntent: intent,
    authorizationSha256: expectedAuthorizationSha256,
    root,
    fixArtifact: objectValue(result.fix_artifact, "fix artifact"),
  });
}

function checkoutPreparedRepair({
  root,
  intent,
  publication,
}: {
  root: string;
  intent: ExecutionIntent;
  publication: PreparedPublication;
}): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-proof-replay-"));
  const checkout = path.join(tempRoot, "target");
  try {
    fs.mkdirSync(checkout);
    run("git", ["init"], { cwd: checkout });
    run("git", ["remote", "add", "origin", `https://github.com/${intent.target_repo}.git`], {
      cwd: checkout,
    });
    fetchAndVerifyLiveRefs(checkout, intent);
    run(
      "git",
      [
        "fetch",
        path.join(root, "run", publication.bundle_path),
        "refs/clawsweeper/prepared:refs/clawsweeper/prepared",
      ],
      { cwd: checkout },
    );
    const preparedHead = run("git", ["rev-parse", "refs/clawsweeper/prepared"], {
      cwd: checkout,
    }).trim();
    const preparedTree = run("git", ["rev-parse", "refs/clawsweeper/prepared^{tree}"], {
      cwd: checkout,
    }).trim();
    if (
      preparedHead !== publication.prepared_head_sha ||
      preparedTree !== publication.prepared_tree_sha
    ) {
      throw new Error("prepared repair bundle commit or tree does not match its manifest");
    }
    run("git", ["checkout", "--detach", preparedHead], { cwd: checkout });
    return checkout;
  } catch (error) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

function fetchAndVerifyLiveRefs(checkout: string, intent: ExecutionIntent) {
  run(
    "git",
    [
      "fetch",
      "--no-tags",
      "--filter=blob:none",
      "origin",
      `+refs/heads/${intent.target_base_ref}:refs/remotes/origin/${intent.target_base_ref}`,
    ],
    { cwd: checkout },
  );
  const baseSha = run("git", ["rev-parse", `refs/remotes/origin/${intent.target_base_ref}`], {
    cwd: checkout,
  }).trim();
  if (baseSha !== intent.target_base_sha) {
    throw new Error("origin/main moved after authorization; refusing stale repair");
  }
  if (intent.source.kind === "pull_request") {
    run(
      "git",
      [
        "fetch",
        "--no-tags",
        "origin",
        `+refs/pull/${intent.source.number}/head:refs/remotes/clawsweeper/source`,
      ],
      { cwd: checkout },
    );
    const sourceSha = run("git", ["rev-parse", "refs/remotes/clawsweeper/source"], {
      cwd: checkout,
    }).trim();
    if (sourceSha !== intent.source.expected_head_sha) {
      throw new Error("source pull request head moved after authorization");
    }
  }
  if (intent.operation === "open_pull_request" && intent.expected_output_sha) {
    run(
      "git",
      [
        "fetch",
        "--no-tags",
        "origin",
        `+refs/heads/${intent.output_branch}:refs/remotes/clawsweeper/output`,
      ],
      { cwd: checkout },
    );
    const outputSha = run("git", ["rev-parse", "refs/remotes/clawsweeper/output"], {
      cwd: checkout,
    }).trim();
    if (outputSha !== intent.expected_output_sha) {
      throw new Error("authorized output branch moved before publication");
    }
  } else if (intent.operation === "open_pull_request") {
    const unexpectedOutput = run(
      "git",
      ["ls-remote", "--heads", "origin", `refs/heads/${intent.output_branch}`],
      { cwd: checkout },
    ).trim();
    if (unexpectedOutput) {
      throw new Error("authorized output branch appeared after authorization");
    }
  }
}

function publishSourceBranchRepair({
  checkout,
  intent,
  publication,
  mutations,
}: {
  checkout: string;
  intent: ExecutionIntent;
  publication: PreparedPublication;
  mutations: LooseRecord[];
}): number {
  if (
    intent.source.kind !== "pull_request" ||
    intent.source.repo !== intent.target_repo ||
    intent.source.expected_head_repo !== intent.target_repo ||
    intent.source.number === null
  ) {
    throw new Error("source-branch publication is not bound to a same-repository pull request");
  }
  const targetRef = `refs/heads/${intent.output_branch}`;
  run(
    "git",
    [
      "push",
      `--force-with-lease=${targetRef}:${intent.source.expected_head_sha}`,
      "origin",
      `refs/clawsweeper/prepared:${targetRef}`,
    ],
    { cwd: checkout },
  );
  mutations.push({
    operation: "push",
    repo: intent.target_repo,
    ref: targetRef,
    previous_sha: intent.source.expected_head_sha,
    sha: publication.prepared_head_sha,
  });
  run(
    "gh",
    [
      "pr",
      "comment",
      String(intent.source.number),
      "--repo",
      intent.target_repo,
      "--body",
      publication.source_comment,
    ],
    { cwd: checkout },
  );
  mutations.push({
    operation: "comment",
    repo: intent.target_repo,
    pull_number: intent.source.number,
  });
  verifyPublishedPull(intent.target_repo, intent.source.number, publication, intent);
  return intent.source.number;
}

function publishReplacementRepair({
  checkout,
  intent,
  publication,
  mutations,
}: {
  checkout: string;
  intent: ExecutionIntent;
  publication: PreparedPublication;
  mutations: LooseRecord[];
}): number {
  const liveTargetPr = openPullForBranch(
    intent.target_repo,
    intent.output_branch,
    intent.target_base_ref,
  );
  if (liveTargetPr !== intent.expected_target_pr_number) {
    throw new Error("target pull request changed after authorization");
  }
  const targetRef = `refs/heads/${intent.output_branch}`;
  const pushArgs = intent.expected_output_sha
    ? [
        "push",
        `--force-with-lease=${targetRef}:${intent.expected_output_sha}`,
        "origin",
        `refs/clawsweeper/prepared:${targetRef}`,
      ]
    : ["push", "origin", `refs/clawsweeper/prepared:${targetRef}`];
  run("git", pushArgs, { cwd: checkout });
  mutations.push({
    operation: "push",
    repo: intent.target_repo,
    ref: targetRef,
    previous_sha: intent.expected_output_sha,
    sha: publication.prepared_head_sha,
  });

  let targetPrNumber = intent.expected_target_pr_number;
  if (targetPrNumber) {
    verifyPublishedPull(intent.target_repo, targetPrNumber, publication, intent);
  } else {
    const bodyPath = path.join(path.dirname(checkout), "pull-request-body.md");
    fs.writeFileSync(bodyPath, publication.pr_body ?? "");
    const created = run(
      "gh",
      [
        "pr",
        "create",
        "--repo",
        intent.target_repo,
        "--base",
        intent.target_base_ref,
        "--head",
        intent.output_branch,
        "--title",
        publication.pr_title ?? "",
        "--body-file",
        bodyPath,
      ],
      { cwd: checkout },
    ).trim();
    const parsed = parsePullRequestUrl(created);
    if (!parsed || parsed.repo !== intent.target_repo) {
      throw new Error("created pull request URL escaped the authorized target repository");
    }
    targetPrNumber = parsed.number;
    mutations.push({
      operation: "open_pull_request",
      repo: intent.target_repo,
      pull_number: targetPrNumber,
      branch: intent.output_branch,
    });
    verifyPublishedPull(intent.target_repo, targetPrNumber, publication, intent);
  }

  for (const action of publication.superseded_source_actions) {
    const source = parsePullRequestUrl(action.source);
    if (!source || source.repo !== intent.target_repo || !intent.source_prs.includes(source.url)) {
      throw new Error("prepared source closeout redirected outside the authorized source set");
    }
    const replacementUrl = `https://github.com/${intent.target_repo}/pull/${targetPrNumber}`;
    const comment = [
      "<!-- clawsweeper-replacement-publication -->",
      `ClawSweeper published the independently validated replacement at ${replacementUrl}.`,
      `Validated commit: \`${publication.prepared_head_sha}\``,
    ].join("\n");
    run(
      "gh",
      ["pr", "comment", String(source.number), "--repo", intent.target_repo, "--body", comment],
      { cwd: checkout },
    );
    mutations.push({
      operation: "comment",
      repo: intent.target_repo,
      pull_number: source.number,
    });
    if (action.operation === "close") {
      run("gh", ["pr", "close", String(source.number), "--repo", intent.target_repo], {
        cwd: checkout,
      });
      mutations.push({
        operation: "close_pull_request",
        repo: intent.target_repo,
        pull_number: source.number,
      });
    }
  }
  return targetPrNumber;
}

function verifyPublishedPull(
  repo: string,
  number: number,
  publication: PreparedPublication,
  intent: ExecutionIntent,
) {
  const pull = ghObject(`repos/${repo}/pulls/${number}`);
  if (
    String(pull.state ?? "").toLowerCase() !== "open" ||
    pull.head?.repo?.full_name !== intent.output_repo ||
    pull.head?.ref !== intent.output_branch ||
    pull.head?.sha !== publication.prepared_head_sha ||
    pull.base?.ref !== intent.target_base_ref
  ) {
    throw new Error("published pull request does not match the validated output identity");
  }
}

function revalidateLiveSource(intent: ExecutionIntent) {
  if (intent.source.kind === "pull_request") {
    const pull = ghObject(`repos/${intent.source.repo}/pulls/${intent.source.number}`);
    if (
      String(pull.state ?? "").toLowerCase() !== intent.source.expected_state ||
      pull.head?.repo?.full_name !== intent.source.expected_head_repo ||
      pull.head?.ref !== intent.source.expected_head_ref ||
      pull.head?.sha !== intent.source.expected_head_sha ||
      pull.base?.ref !== intent.source.expected_base_ref
    ) {
      throw new Error("source pull request changed after authorization");
    }
    return;
  }
  if (intent.source.kind === "issue") {
    const issue = ghObject(`repos/${intent.source.repo}/issues/${intent.source.number}`);
    const comments = ghPagedArray(
      `repos/${intent.source.repo}/issues/${intent.source.number}/comments?per_page=100`,
    );
    const block = issueSourceStateBlockReason({
      issue,
      comments,
      expectedRevision: intent.source.expected_revision_sha256 ?? "",
    });
    if (block) throw new Error(block);
  }
}

function checkoutIdentity(cwd: string, baseRef: string) {
  return {
    head: run("git", ["rev-parse", "HEAD"], { cwd }).trim(),
    tree: run("git", ["rev-parse", "HEAD^{tree}"], { cwd }).trim(),
    base: run("git", ["rev-parse", baseRef], { cwd }).trim(),
    status: run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd }),
  };
}

function assertCheckoutIdentity(cwd: string, baseRef: string, expected: LooseRecord) {
  if (JSON.stringify(checkoutIdentity(cwd, baseRef)) !== JSON.stringify(expected)) {
    throw new Error("target dependency setup changed the immutable repair source");
  }
}

function repairActionIdentity(result: LooseRecord): string {
  const mutatingActions = (result.actions ?? []).filter((action: JsonValue) =>
    ["fix_needed", "build_fix_artifact", "open_fix_pr", "repair_contributor_branch"].includes(
      String(action?.action ?? ""),
    ),
  );
  if (!result.fix_artifact || mutatingActions.length === 0) {
    throw new Error("worker result does not contain an executable repair action identity");
  }
  return digestJson({
    fix_artifact: result.fix_artifact,
    mutating_actions: mutatingActions,
    canonical_pr: result.canonical_pr ?? null,
    reviewed_sha: result.reviewed_sha ?? null,
  });
}

function jobTargetNumbers(job: ParsedJob, repo: string): Set<number> {
  const numbers = new Set<number>();
  for (const value of [
    ...(job.frontmatter.canonical ?? []),
    ...(job.frontmatter.candidates ?? []),
    ...(job.frontmatter.cluster_refs ?? []),
  ]) {
    const text = String(value);
    const shorthand = text.match(/^#?(\d+)$/);
    const url = parsePullRequestUrl(text);
    if (shorthand) numbers.add(Number(shorthand[1]));
    if (url?.repo === repo) numbers.add(url.number);
  }
  return numbers;
}

function intendedJobSourceNumber(job: ParsedJob, result: LooseRecord, repo: string): number | null {
  if (job.frontmatter.source === "issue_implementation") {
    const number = Number(job.frontmatter.source_issue_number);
    return Number.isInteger(number) && number > 0 ? number : null;
  }
  const canonicalPr = parsePullRequestUrl(result.canonical_pr);
  if (canonicalPr) {
    if (canonicalPr.repo !== repo) {
      throw new Error("canonical pull request differs from the target repository");
    }
    return canonicalPr.number;
  }
  const canonicalNumbers = (job.frontmatter.canonical ?? [])
    .map((value: JsonValue) => String(value).match(/^#?(\d+)$/)?.[1])
    .filter((value): value is string => Boolean(value))
    .map(Number);
  return canonicalNumbers.length === 1 ? canonicalNumbers[0]! : null;
}

function assertAuthorizedClosingReferences({
  fixArtifact,
  targetRepo,
  source,
  sourceClosingReferences,
}: {
  fixArtifact: LooseRecord;
  targetRepo: string;
  source: ExecutionIntent["source"];
  sourceClosingReferences: string[];
}) {
  const allowed = new Set(
    sourceClosingReferences
      .map((reference) => closingReferenceTarget(reference, targetRepo))
      .filter((value): value is string => Boolean(value)),
  );
  if (source.kind === "issue" && source.number) {
    allowed.add(`${source.repo.toLowerCase()}#${source.number}`);
  }
  for (const reference of closingReferencesFromMarkdown(fixArtifact.pr_body)) {
    const target = closingReferenceTarget(reference, targetRepo);
    if (!target || !allowed.has(target)) {
      throw new Error(`fix artifact contains unauthorized closing reference: ${reference}`);
    }
  }
}

function closingReferenceTarget(reference: string, defaultRepo: string): string | null {
  const target = reference.trim().split(/\s+/).at(-1) ?? "";
  const issueUrl = target.match(
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+)$/i,
  );
  if (issueUrl) return `${issueUrl[1]!.toLowerCase()}#${issueUrl[2]}`;
  const qualified = target.match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/);
  if (qualified) return `${qualified[1]!.toLowerCase()}#${qualified[2]}`;
  const local = target.match(/^#(\d+)$/);
  return local ? `${defaultRepo.toLowerCase()}#${local[1]}` : null;
}

function ghObject(endpoint: string): LooseRecord {
  return objectValue(JSON.parse(run("gh", ["api", endpoint])), `GitHub response for ${endpoint}`);
}

function ghPagedArray(endpoint: string): LooseRecord[] {
  const pages = JSON.parse(run("gh", ["api", "--paginate", "--slurp", endpoint]));
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
    throw new Error(`GitHub paginated response for ${endpoint} is invalid`);
  }
  return pages.flat().map((value) => objectValue(value, `GitHub item for ${endpoint}`));
}

function ghOptionalRefSha(repo: string, branch: string): string | null {
  try {
    return requiredSha(
      ghObject(`repos/${repo}/git/ref/heads/${branch}`).object?.sha,
      "output branch SHA",
    );
  } catch (error) {
    if (/404|not found/i.test(String((error as Error).message ?? error))) return null;
    throw error;
  }
}

function openPullForBranch(repo: string, branch: string, base: string): number | null {
  const owner = repo.split("/")[0]!;
  const pulls = JSON.parse(
    run("gh", [
      "api",
      "--method",
      "GET",
      `repos/${repo}/pulls`,
      "-f",
      "state=open",
      "-f",
      `head=${owner}:${branch}`,
      "-f",
      `base=${base}`,
    ]),
  );
  if (!Array.isArray(pulls) || pulls.length > 1) {
    throw new Error("authorized output branch has an ambiguous pull request target");
  }
  if (pulls.length === 0) return null;
  const number = Number(pulls[0]?.number);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error("authorized output pull request number is invalid");
  }
  return number;
}

function preparedFixMutation(report: LooseRecord): LooseRecord | null {
  const prepared = (report.actions ?? []).filter(
    (action: JsonValue) =>
      ["repair_contributor_branch", "open_fix_pr"].includes(String(action?.action ?? "")) &&
      action?.status === "prepared",
  );
  return prepared.length === 1 ? (prepared[0] as LooseRecord) : null;
}

function hasPreparedFixMutation(report: LooseRecord): boolean {
  return preparedFixMutation(report) !== null;
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
  return objectValue(JSON.parse(fs.readFileSync(filePath, "utf8")), label);
}

function objectValue(value: unknown, label: string): LooseRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as LooseRecord;
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

function requiredRef(value: unknown, label: string): string {
  const ref = requiredText(value, label);
  if (!/^[A-Za-z0-9_.][A-Za-z0-9_./-]*$/.test(ref) || ref.includes("..")) {
    throw new Error(`${label} is invalid`);
  }
  return ref;
}

function requiredSha(value: unknown, label: string): string {
  const sha = requiredText(value, label).toLowerCase();
  if (!SHA_PATTERN.test(sha)) throw new Error(`${label} must be a full commit SHA`);
  return sha;
}

function requiredDigest(value: unknown, label: string): string {
  const digest = requiredText(value, label).toLowerCase();
  requireDigest(digest, label);
  return digest;
}

function requireDigest(value: string, label: string) {
  if (!DIGEST_PATTERN.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
}

export function sha256JsonForTest(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
