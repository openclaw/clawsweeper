import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { runCommand as run } from "./command-runner.js";
import { replacementPrBody } from "./external-messages.js";
import type { LooseRecord } from "./json-types.js";

export const EXECUTION_INTENT_SCHEMA_VERSION = 2;
export const PREPARED_PUBLICATION_SCHEMA_VERSION = 2;
export const PUBLICATION_RECEIPT_SCHEMA_VERSION = 1;

export type ExecutionSourceIntent = {
  kind: "pull_request" | "issue" | "commit" | "job";
  repo: string;
  number: number | null;
  url: string | null;
  expected_state: string;
  expected_revision_sha256: string | null;
  expected_head_repo: string | null;
  expected_head_ref: string | null;
  expected_head_sha: string | null;
  expected_base_ref: string | null;
  expected_base_sha: string | null;
};

export type ExecutionIntent = {
  schema_version: number;
  target_repo: string;
  source: ExecutionSourceIntent;
  target_base_ref: string;
  target_base_sha: string;
  operation: "update_source_pr" | "open_pull_request";
  output_repo: string;
  output_branch: string;
  expected_output_sha: string | null;
  expected_target_pr_number: number | null;
  action_name: "repair_contributor_branch" | "open_fix_pr";
  repair_strategy: string;
  action_identity_sha256: string;
  source_prs: string[];
  source_closing_references: string[];
  contributor_credits: LooseRecord[];
  superseded_source_prs: string[];
  close_superseded_source_prs: boolean;
  required_labels: string[];
  identity_sha256: string;
};

export type PreparedPublication = {
  schema_version: number;
  authorization_sha256: string;
  execution_intent_sha256: string;
  action_identity_sha256: string;
  target_repo: string;
  operation: "update_source_pr" | "open_pull_request";
  output_repo: string;
  output_branch: string;
  expected_output_sha: string | null;
  source: ExecutionSourceIntent;
  target_base_ref: string;
  target_base_sha: string;
  repair_delta_base_sha: string;
  prepared_head_sha: string;
  prepared_tree_sha: string;
  bundle_path: string;
  bundle_sha256: string;
  pr_title: string | null;
  pr_body: string | null;
  source_comment: string;
  superseded_source_actions: LooseRecord[];
  identity_sha256: string;
};

export type PublicationReceipt = {
  schema_version: number;
  validation_receipt_sha256: string;
  prepared_publication_sha256: string;
  execution_intent_sha256: string;
  action_identity_sha256: string;
  target_repo: string;
  operation: "update_source_pr" | "open_pull_request";
  output_repo: string;
  output_branch: string;
  published_head_sha: string;
  published_tree_sha: string;
  target_pr_number: number;
  target_pr_url: string;
  mutations: LooseRecord[];
  identity_sha256: string;
};

export function executionIntentRepairDeltaBaseSha(intent: ExecutionIntent): string {
  const repairDeltaBaseSha =
    intent.expected_output_sha ??
    (intent.source.kind === "pull_request" ? intent.source.expected_head_sha : null) ??
    intent.target_base_sha;
  if (!repairDeltaBaseSha) {
    throw new Error("execution intent repair delta base is required");
  }
  requireSha(repairDeltaBaseSha, "execution intent repair delta base");
  return repairDeltaBaseSha;
}

export function authorizedFixArtifact(
  executionIntent: ExecutionIntent,
  fixArtifact: LooseRecord,
): LooseRecord {
  return {
    ...fixArtifact,
    repair_strategy: executionIntent.repair_strategy,
    source_prs:
      executionIntent.source.kind === "pull_request" && executionIntent.source.url
        ? [executionIntent.source.url]
        : executionIntent.source_prs,
    supersede_source_prs: executionIntent.superseded_source_prs,
  };
}

export function createPreparedPublication({
  outputDir,
  targetDir,
  authorizationSha256,
  executionIntent,
  fixArtifact,
  repairDeltaBaseSha,
  preparedHeadSha,
  preparedTreeSha,
}: {
  outputDir: string;
  targetDir: string;
  authorizationSha256: string;
  executionIntent: ExecutionIntent;
  fixArtifact: LooseRecord;
  repairDeltaBaseSha: string;
  preparedHeadSha: string;
  preparedTreeSha: string;
}): PreparedPublication {
  requireDigest(authorizationSha256, "authorization digest");
  verifyExecutionIntentIdentity(executionIntent);
  requireSha(repairDeltaBaseSha, "repair delta base SHA");
  if (repairDeltaBaseSha !== executionIntentRepairDeltaBaseSha(executionIntent)) {
    throw new Error("repair delta base does not match the immutable pre-execution head");
  }
  requireSha(preparedHeadSha, "prepared head SHA");
  requireSha(preparedTreeSha, "prepared tree SHA");

  fs.mkdirSync(outputDir, { recursive: true });
  const bundleName = "prepared-repair.bundle";
  const bundlePath = path.join(outputDir, bundleName);
  const preparedRef = "refs/clawsweeper/prepared";
  run("git", ["update-ref", preparedRef, preparedHeadSha], { cwd: targetDir });
  const bundleArgs = ["bundle", "create", bundlePath, preparedRef];
  for (const prerequisite of uniqueStrings([
    executionIntent.target_base_sha,
    executionIntent.source.expected_head_sha,
    executionIntent.expected_output_sha,
  ])) {
    if (isAncestor(targetDir, prerequisite, preparedHeadSha)) {
      bundleArgs.push(`^${prerequisite}`);
    }
  }
  run("git", bundleArgs, { cwd: targetDir });
  run("git", ["bundle", "verify", bundlePath], { cwd: targetDir });

  const sourceComment = renderSourceComment({
    executionIntent,
    preparedHeadSha,
  });
  const prBody =
    executionIntent.operation === "open_pull_request"
      ? replacementPrBody({
          fixArtifact,
          contributorCredits: executionIntent.contributor_credits,
          sourceClosingReferences: executionIntent.source_closing_references,
        })
      : null;
  const supersededSourceActions =
    executionIntent.operation === "open_pull_request"
      ? executionIntent.superseded_source_prs.map((source) => ({
          source,
          operation: executionIntent.close_superseded_source_prs ? "close" : "comment",
        }))
      : [];
  const identity = {
    schema_version: PREPARED_PUBLICATION_SCHEMA_VERSION,
    authorization_sha256: authorizationSha256,
    execution_intent_sha256: executionIntent.identity_sha256,
    action_identity_sha256: executionIntent.action_identity_sha256,
    target_repo: executionIntent.target_repo,
    operation: executionIntent.operation,
    output_repo: executionIntent.output_repo,
    output_branch: executionIntent.output_branch,
    expected_output_sha: executionIntent.expected_output_sha,
    source: executionIntent.source,
    target_base_ref: executionIntent.target_base_ref,
    target_base_sha: executionIntent.target_base_sha,
    repair_delta_base_sha: repairDeltaBaseSha,
    prepared_head_sha: preparedHeadSha,
    prepared_tree_sha: preparedTreeSha,
    bundle_path: bundleName,
    bundle_sha256: sha256File(bundlePath),
    pr_title:
      executionIntent.operation === "open_pull_request" ? String(fixArtifact.pr_title) : null,
    pr_body: prBody,
    source_comment: sourceComment,
    superseded_source_actions: supersededSourceActions,
  };
  const publication: PreparedPublication = {
    ...identity,
    identity_sha256: digestJson(identity),
  };
  writeJson(path.join(outputDir, "publication-intent.json"), publication);
  return publication;
}

export function verifyPreparedPublication({
  publication,
  executionIntent,
  authorizationSha256,
  root,
  fixArtifact,
}: {
  publication: PreparedPublication;
  executionIntent: ExecutionIntent;
  authorizationSha256: string;
  root: string;
  fixArtifact: LooseRecord;
}): PreparedPublication {
  verifyExecutionIntentIdentity(executionIntent);
  const { identity_sha256: identitySha256, ...identity } = publication;
  if (
    publication.schema_version !== PREPARED_PUBLICATION_SCHEMA_VERSION ||
    identitySha256 !== digestJson(identity) ||
    publication.authorization_sha256 !== authorizationSha256 ||
    publication.execution_intent_sha256 !== executionIntent.identity_sha256 ||
    publication.action_identity_sha256 !== executionIntent.action_identity_sha256
  ) {
    throw new Error("prepared publication identity does not match its authorization");
  }
  for (const key of [
    "target_repo",
    "operation",
    "output_repo",
    "output_branch",
    "expected_output_sha",
    "target_base_ref",
    "target_base_sha",
  ] as const) {
    if (publication[key] !== executionIntent[key]) {
      throw new Error(`prepared publication ${key} does not match the authorized intent`);
    }
  }
  if (JSON.stringify(publication.source) !== JSON.stringify(executionIntent.source)) {
    throw new Error("prepared publication source does not match the authorized intent");
  }
  requireSha(publication.prepared_head_sha, "prepared publication head");
  requireSha(publication.prepared_tree_sha, "prepared publication tree");
  requireSha(publication.repair_delta_base_sha, "prepared publication repair delta base");
  if (publication.bundle_path !== "prepared-repair.bundle") {
    throw new Error("prepared publication bundle path is not the trusted fixed path");
  }
  const bundlePath = path.join(root, "run", publication.bundle_path);
  if (!fs.statSync(bundlePath).isFile() || sha256File(bundlePath) !== publication.bundle_sha256) {
    throw new Error("prepared publication bundle digest changed");
  }
  const expectedTitle =
    executionIntent.operation === "open_pull_request" ? String(fixArtifact.pr_title) : null;
  const expectedBody =
    executionIntent.operation === "open_pull_request"
      ? replacementPrBody({
          fixArtifact,
          contributorCredits: executionIntent.contributor_credits,
          sourceClosingReferences: executionIntent.source_closing_references,
        })
      : null;
  if (publication.pr_title !== expectedTitle || publication.pr_body !== expectedBody) {
    throw new Error("prepared pull request metadata is not deterministic");
  }
  const expectedSourceComment = renderSourceComment({
    executionIntent,
    preparedHeadSha: publication.prepared_head_sha,
  });
  if (publication.source_comment !== expectedSourceComment) {
    throw new Error("prepared source comment is not deterministic");
  }
  const expectedSourceActions =
    executionIntent.operation === "open_pull_request"
      ? executionIntent.superseded_source_prs.map((source) => ({
          source,
          operation: executionIntent.close_superseded_source_prs ? "close" : "comment",
        }))
      : [];
  if (
    JSON.stringify(publication.superseded_source_actions) !== JSON.stringify(expectedSourceActions)
  ) {
    throw new Error("prepared source closeout actions do not match the authorized intent");
  }
  return publication;
}

export function verifyExecutionIntentIdentity(intent: ExecutionIntent): ExecutionIntent {
  const { identity_sha256: identitySha256, ...identity } = intent;
  const sourcePrPattern = new RegExp(
    `^https://github\\.com/${escapeRegExp(intent.target_repo)}/pull/[1-9][0-9]*$`,
  );
  if (
    intent.schema_version !== EXECUTION_INTENT_SCHEMA_VERSION ||
    identitySha256 !== digestJson(identity) ||
    !Array.isArray(intent.source_prs) ||
    intent.source_prs.some(
      (source, index) =>
        typeof source !== "string" ||
        !sourcePrPattern.test(source) ||
        intent.source_prs.indexOf(source) !== index,
    ) ||
    (intent.source.kind === "pull_request" &&
      (!intent.source.url || !intent.source_prs.includes(intent.source.url))) ||
    !Array.isArray(intent.superseded_source_prs) ||
    intent.superseded_source_prs.some(
      (source, index) =>
        !intent.source_prs.includes(source) ||
        intent.superseded_source_prs.indexOf(source) !== index,
    ) ||
    !Array.isArray(intent.required_labels) ||
    intent.required_labels.some(
      (label, index) =>
        typeof label !== "string" ||
        !label.trim() ||
        intent.required_labels.findIndex(
          (candidate) => candidate.toLowerCase() === label.toLowerCase(),
        ) !== index,
    )
  ) {
    throw new Error("execution intent identity is invalid");
  }
  return intent;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function publicationReceipt({
  validationReceiptSha256,
  publication,
  targetPrNumber,
  mutations,
}: {
  validationReceiptSha256: string;
  publication: PreparedPublication;
  targetPrNumber: number;
  mutations: LooseRecord[];
}): PublicationReceipt {
  requireDigest(validationReceiptSha256, "validation receipt digest");
  if (!Number.isInteger(targetPrNumber) || targetPrNumber <= 0) {
    throw new Error("published target PR number is invalid");
  }
  const identity = {
    schema_version: PUBLICATION_RECEIPT_SCHEMA_VERSION,
    validation_receipt_sha256: validationReceiptSha256,
    prepared_publication_sha256: publication.identity_sha256,
    execution_intent_sha256: publication.execution_intent_sha256,
    action_identity_sha256: publication.action_identity_sha256,
    target_repo: publication.target_repo,
    operation: publication.operation,
    output_repo: publication.output_repo,
    output_branch: publication.output_branch,
    published_head_sha: publication.prepared_head_sha,
    published_tree_sha: publication.prepared_tree_sha,
    target_pr_number: targetPrNumber,
    target_pr_url: `https://github.com/${publication.target_repo}/pull/${targetPrNumber}`,
    mutations,
  };
  return { ...identity, identity_sha256: digestJson(identity) };
}

export function verifyPublicationReceipt({
  receipt,
  publication,
  validationReceiptSha256,
}: {
  receipt: PublicationReceipt;
  publication: PreparedPublication;
  validationReceiptSha256: string;
}): PublicationReceipt {
  const { identity_sha256: identitySha256, ...identity } = receipt;
  if (
    receipt.schema_version !== PUBLICATION_RECEIPT_SCHEMA_VERSION ||
    identitySha256 !== digestJson(identity) ||
    receipt.validation_receipt_sha256 !== validationReceiptSha256 ||
    receipt.prepared_publication_sha256 !== publication.identity_sha256 ||
    receipt.execution_intent_sha256 !== publication.execution_intent_sha256 ||
    receipt.action_identity_sha256 !== publication.action_identity_sha256 ||
    receipt.target_repo !== publication.target_repo ||
    receipt.operation !== publication.operation ||
    receipt.output_repo !== publication.output_repo ||
    receipt.output_branch !== publication.output_branch ||
    receipt.published_head_sha !== publication.prepared_head_sha ||
    receipt.published_tree_sha !== publication.prepared_tree_sha ||
    receipt.target_pr_url !==
      `https://github.com/${publication.target_repo}/pull/${receipt.target_pr_number}`
  ) {
    throw new Error("publication receipt does not match the exact validated repair");
  }
  if (
    publication.operation === "update_source_pr" &&
    receipt.target_pr_number !== publication.source.number
  ) {
    throw new Error("publication receipt redirected the authorized source pull request");
  }
  return receipt;
}

export function digestJson(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function renderSourceComment({
  executionIntent,
  preparedHeadSha,
}: {
  executionIntent: ExecutionIntent;
  preparedHeadSha: string;
}) {
  const action =
    executionIntent.operation === "update_source_pr"
      ? "ClawSweeper validated and published this exact repair commit."
      : "ClawSweeper validated a replacement repair and published it from a separate branch.";
  return [
    "<!-- clawsweeper-repair-publication -->",
    action,
    "",
    `Validated commit: \`${preparedHeadSha}\``,
    "Validation: independent staged proof passed",
  ].join("\n");
}

function uniqueStrings(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  try {
    run("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd });
    return true;
  } catch {
    return false;
  }
}

function requireSha(value: string, label: string) {
  if (!/^[a-f0-9]{40}$/i.test(value)) throw new Error(`${label} must be a full commit SHA`);
}

function requireDigest(value: string, label: string) {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
}
