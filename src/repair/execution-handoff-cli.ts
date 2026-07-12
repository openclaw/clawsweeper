#!/usr/bin/env node
import fs from "node:fs";

import {
  prepareExecutionAuthorization,
  sealExecutionHandoff,
  validateExecutionHandoff,
  verifyExecutionAuthorization,
  verifyExecutionHandoff,
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
    });
    writeOutputs({
      authorization_sha256: authorization.identity_sha256,
      job_path: `${requiredArg(args, "out")}/job.md`,
      result_path: `${requiredArg(args, "out")}/run/result.json`,
      run_dir: `${requiredArg(args, "out")}/run`,
      source_job_path: authorization.source_job_path,
      target_repo: authorization.target_repo,
      target_owner: authorization.target_owner,
      target_name: authorization.target_name,
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
      target_repo: receipt.target_repo,
      validated_head_sha: receipt.validated_head_sha,
      validated_base_sha: receipt.validated_base_sha,
    });
    break;
  }
  default:
    throw new Error(
      "usage: execution-handoff <authorize|verify|seal|verify-execution|validate|verify-receipt> [options]",
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
