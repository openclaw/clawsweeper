#!/usr/bin/env node
import fs from "node:fs";

import {
  checkpointPublishedReplacementSourceClosures,
  closePublishedReplacementSources,
  prepareExecutionAuthorization,
  publishValidatedExecution,
  restoreCheckpointedExecutionAuthorization,
  sealExecutionHandoff,
  validateExecutionHandoff,
  verifyExecutionAuthorization,
  verifyExecutionHandoff,
  verifyPublishedReceipt,
  verifyValidationReceipt,
} from "./execution-handoff.js";

const [command, ...argv] = process.argv.slice(2);
const args = parseArgs(argv);

switch (command) {
  case "authorize": {
    const authorization = prepareExecutionAuthorization({
      jobPath: requiredArg(args, "job"),
      runsRoot: requiredArg(args, "runs"),
      outputRoot: requiredArg(args, "out"),
      workflowRunId: requiredArg(args, "run-id"),
      workflowRunAttempt: requiredArg(args, "run-attempt"),
      workflowRepository: requiredArg(args, "workflow-repository"),
      workflowSha: requiredArg(args, "workflow-sha"),
      allowedOwner: requiredArg(args, "allowed-owner"),
      closeSupersededSourcePrs: /^(1|true|yes|on)$/i.test(args.get("close-superseded") ?? ""),
    });
    writeOutputs({
      authorization_sha256: authorization.identity_sha256,
      job_path: `${requiredArg(args, "out")}/job.md`,
      result_path: `${requiredArg(args, "out")}/run/result.json`,
      run_dir: `${requiredArg(args, "out")}/run`,
      execution_intent_path: `${requiredArg(args, "out")}/execution-intent.json`,
      source_job_path: authorization.source_job_path,
      target_repo: authorization.target_repo,
      target_owner: authorization.target_owner,
      target_name: authorization.target_name,
    });
    break;
  }
  case "restore-authorization": {
    const authorization = restoreCheckpointedExecutionAuthorization({
      sourceRoot: requiredArg(args, "source-root"),
      publicationRoot: requiredArg(args, "publication-root"),
      publicationReceiptPath: requiredArg(args, "publication-receipt"),
      validationReceiptPath: requiredArg(args, "validation-receipt"),
      outputRoot: requiredArg(args, "out"),
      workflowRunId: requiredArg(args, "run-id"),
      workflowRunAttempt: requiredArg(args, "run-attempt"),
      workflowRepository: requiredArg(args, "workflow-repository"),
      workflowSha: requiredArg(args, "workflow-sha"),
      sourceJobPath: requiredArg(args, "source-job-path"),
      allowedOwner: requiredArg(args, "allowed-owner"),
    });
    writeOutputs({
      authorization_sha256: authorization.identity_sha256,
      job_path: `${requiredArg(args, "out")}/job.md`,
      result_path: `${requiredArg(args, "out")}/run/result.json`,
      run_dir: `${requiredArg(args, "out")}/run`,
      execution_intent_path: `${requiredArg(args, "out")}/execution-intent.json`,
      source_job_path: authorization.source_job_path,
      target_repo: authorization.target_repo,
      target_owner: authorization.target_owner,
      target_name: authorization.target_name,
      checkpoint_recovered: "1",
      checkpoint_producer_attempt: authorization.checkpoint_producer_attempt,
      checkpoint_validation_receipt_sha256: authorization.checkpoint_validation_receipt_sha256,
    });
    break;
  }
  case "verify": {
    const authorization = verifyExecutionAuthorization(
      requiredArg(args, "root"),
      requiredArg(args, "authorization-sha256"),
    );
    writeOutputs({
      job_exists: "1",
      job_path: `${requiredArg(args, "root")}/job.md`,
      result_path: `${requiredArg(args, "root")}/run/result.json`,
      run_dir: `${requiredArg(args, "root")}/run`,
      execution_intent_path: `${requiredArg(args, "root")}/execution-intent.json`,
      target_repo: authorization.target_repo,
      target_owner: authorization.target_owner,
      target_name: authorization.target_name,
    });
    break;
  }
  case "seal": {
    const manifest = sealExecutionHandoff({
      root: requiredArg(args, "root"),
      expectedAuthorizationSha256: requiredArg(args, "authorization-sha256"),
      executeOutcome: requiredArg(args, "execute-outcome"),
    });
    writeOutputs({
      execution_manifest_sha256: manifest.identity_sha256,
      mutation_ready: String(manifest.mutation_ready),
    });
    break;
  }
  case "verify-execution": {
    const manifest = verifyExecutionHandoff(
      requiredArg(args, "root"),
      requiredArg(args, "authorization-sha256"),
    );
    writeOutputs({
      execution_manifest_sha256: manifest.identity_sha256,
      execute_outcome: manifest.execute_outcome,
      mutation_ready: String(manifest.mutation_ready),
    });
    break;
  }
  case "validate": {
    const receipt = validateExecutionHandoff({
      root: requiredArg(args, "root"),
      outputPath: requiredArg(args, "receipt"),
      expectedAuthorizationSha256: requiredArg(args, "authorization-sha256"),
    });
    writeOutputs({ receipt_sha256: receipt.identity_sha256 });
    break;
  }
  case "verify-receipt": {
    const receipt = verifyValidationReceipt({
      root: requiredArg(args, "root"),
      receiptPath: requiredArg(args, "receipt"),
      expectedAuthorizationSha256: requiredArg(args, "authorization-sha256"),
      expectedReceiptSha256: requiredArg(args, "receipt-sha256"),
    });
    writeOutputs({
      receipt_sha256: receipt.identity_sha256,
      target_repo: receipt.target_repo,
      validated_head_sha: receipt.validated_head_sha,
      validated_base_sha: receipt.validated_base_sha,
    });
    break;
  }
  case "publish": {
    const receipt = publishValidatedExecution({
      root: requiredArg(args, "root"),
      validationReceiptPath: requiredArg(args, "validation-receipt"),
      expectedAuthorizationSha256: requiredArg(args, "authorization-sha256"),
      expectedValidationReceiptSha256: requiredArg(args, "validation-receipt-sha256"),
      expectedMutationActor: requiredArg(args, "mutation-actor"),
      outputPath: requiredArg(args, "publication-receipt"),
    });
    writeOutputs({
      publication_receipt_sha256: receipt.identity_sha256,
      target_repo: receipt.target_repo,
      target_pr_number: String(receipt.target_pr_number),
      target_pr_url: receipt.target_pr_url,
      published_head_sha: receipt.published_head_sha,
    });
    break;
  }
  case "verify-publication": {
    const receipt = verifyPublishedReceipt({
      root: requiredArg(args, "root"),
      publicationReceiptPath: requiredArg(args, "publication-receipt"),
      validationReceiptPath: requiredArg(args, "validation-receipt"),
      expectedAuthorizationSha256: requiredArg(args, "authorization-sha256"),
      expectedValidationReceiptSha256: requiredArg(args, "validation-receipt-sha256"),
      expectedPublicationReceiptSha256: requiredArg(args, "publication-receipt-sha256"),
    });
    writeOutputs({
      target_repo: receipt.target_repo,
      target_pr_number: String(receipt.target_pr_number),
      target_pr_url: receipt.target_pr_url,
      published_head_sha: receipt.published_head_sha,
    });
    break;
  }
  case "close-sources": {
    const receipt = closePublishedReplacementSources({
      root: requiredArg(args, "root"),
      publicationReceiptPath: requiredArg(args, "publication-receipt"),
      validationReceiptPath: requiredArg(args, "validation-receipt"),
      expectedAuthorizationSha256: requiredArg(args, "authorization-sha256"),
      expectedValidationReceiptSha256: requiredArg(args, "validation-receipt-sha256"),
      expectedPublicationReceiptSha256: requiredArg(args, "publication-receipt-sha256"),
      expectedCloseActor: requiredArg(args, "close-actor"),
    });
    writeOutputs({
      target_repo: receipt.target_repo,
      target_pr_number: String(receipt.target_pr_number),
      target_pr_url: receipt.target_pr_url,
      published_head_sha: receipt.published_head_sha,
      publication_receipt_sha256: receipt.identity_sha256,
      sources_closed: "1",
    });
    break;
  }
  case "checkpoint-source-closes": {
    const receipt = checkpointPublishedReplacementSourceClosures({
      root: requiredArg(args, "root"),
      publicationReceiptPath: requiredArg(args, "publication-receipt"),
      validationReceiptPath: requiredArg(args, "validation-receipt"),
      expectedAuthorizationSha256: requiredArg(args, "authorization-sha256"),
      expectedValidationReceiptSha256: requiredArg(args, "validation-receipt-sha256"),
      expectedPublicationReceiptSha256: requiredArg(args, "publication-receipt-sha256"),
      expectedCloseActor: requiredArg(args, "close-actor"),
    });
    writeOutputs({
      target_repo: receipt.target_repo,
      target_pr_number: String(receipt.target_pr_number),
      target_pr_url: receipt.target_pr_url,
      published_head_sha: receipt.published_head_sha,
      publication_receipt_sha256: receipt.identity_sha256,
      source_closes_checkpointed: "1",
    });
    break;
  }
  default:
    throw new Error(
      "usage: execution-handoff <authorize|restore-authorization|verify|seal|verify-execution|validate|verify-receipt|publish|verify-publication|checkpoint-source-closes|close-sources> [options]",
    );
}

function parseArgs(values: string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument near ${name ?? "<end>"}`);
    }
    parsed.set(name.slice(2), value);
  }
  return parsed;
}

function requiredArg(args: Map<string, string>, name: string): string {
  const value = args.get(name)?.trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function writeOutputs(outputs: Record<string, string>) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    for (const [name, value] of Object.entries(outputs)) console.log(`${name}=${value}`);
    return;
  }
  fs.appendFileSync(
    outputPath,
    Object.entries(outputs)
      .map(([name, value]) => `${name}=${value}\n`)
      .join(""),
  );
}
