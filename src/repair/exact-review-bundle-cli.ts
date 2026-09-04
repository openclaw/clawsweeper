#!/usr/bin/env node
import { requiredEnv } from "../required-env.js";
import {
  createExactReviewBundle,
  exactReviewDecisionSha256,
  validateExactReviewBundle,
  type ExactReviewBundleContext,
} from "./exact-review-bundle.js";

const [command] = process.argv.slice(2);
if (command !== "create" && command !== "validate") {
  throw new Error("usage: exact-review-bundle-cli.ts <create|validate>");
}

const context = contextFromEnv(process.env);
const bundleDir = requiredEnv("EXACT_REVIEW_BUNDLE_DIR", process.env);
if (command === "create") {
  const reviewPath = optionalEnv(process.env, "EXACT_REVIEW_REPORT_PATH");
  const actionLedgerRoot = optionalEnv(process.env, "EXACT_REVIEW_ACTION_LEDGER_ROOT");
  const manifest = createExactReviewBundle({
    bundleDir,
    ...(reviewPath ? { reviewPath } : {}),
    ...(actionLedgerRoot ? { actionLedgerRoot } : {}),
    createdAt: new Date().toISOString(),
    context,
  });
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
} else {
  const manifest = validateExactReviewBundle(bundleDir, context);
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
}

function contextFromEnv(env: NodeJS.ProcessEnv): ExactReviewBundleContext {
  const protocolVersion = positiveIntegerEnv(env, "EXACT_REVIEW_PROTOCOL_VERSION");
  if (protocolVersion !== 1 && protocolVersion !== 2) {
    throw new Error("EXACT_REVIEW_PROTOCOL_VERSION must be 1 or 2");
  }
  return {
    repository: requiredEnv("GITHUB_REPOSITORY", env),
    sourceSha: optionalEnv(env, "EXACT_REVIEW_SOURCE_SHA") || requiredEnv("GITHUB_SHA", env),
    runId: optionalEnv(env, "EXACT_REVIEW_PRODUCER_RUN_ID") || requiredEnv("GITHUB_RUN_ID", env),
    runAttempt: positiveIntegerEnv(env, "EXACT_REVIEW_GENERATION_ATTEMPT"),
    producerJob: requiredEnv("EXACT_REVIEW_PRODUCER_JOB", env),
    decisionSha256: exactReviewDecisionSha256(requiredEnv("EXACT_REVIEW_DECISION", env)),
    targetRepo: requiredEnv("EXACT_REVIEW_TARGET_REPO", env),
    targetBranch: requiredEnv("EXACT_REVIEW_TARGET_BRANCH", env),
    itemNumber: positiveIntegerEnv(env, "EXACT_REVIEW_ITEM_NUMBER"),
    itemKind: itemKindEnv(env),
    itemKey: requiredEnv("EXACT_REVIEW_ITEM_KEY", env),
    protocolVersion,
    leaseRevision: optionalPositiveIntegerEnv(env, "EXACT_REVIEW_LEASE_REVISION"),
    claimGeneration: optionalPositiveIntegerEnv(env, "EXACT_REVIEW_CLAIM_GENERATION"),
    liveProceeded: booleanEnv(env, "EXACT_REVIEW_LIVE_PROCEEDED"),
    liveTerminalNoop: booleanEnv(env, "EXACT_REVIEW_LIVE_TERMINAL_NOOP"),
    liveTerminalMissing: booleanEnv(env, "EXACT_REVIEW_LIVE_TERMINAL_MISSING"),
    liveGuardedOpen: booleanEnv(env, "EXACT_REVIEW_LIVE_GUARDED_OPEN"),
  };
}

function optionalEnv(env: NodeJS.ProcessEnv, name: string): string {
  return String(env[name] ?? "").trim();
}

function positiveIntegerEnv(env: NodeJS.ProcessEnv, name: string): number {
  const value = Number(requiredEnv(name, env));
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function optionalPositiveIntegerEnv(env: NodeJS.ProcessEnv, name: string): number | null {
  const raw = optionalEnv(env, name);
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function booleanEnv(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = requiredEnv(name, env);
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function itemKindEnv(env: NodeJS.ProcessEnv): "issue" | "pull_request" {
  const value = requiredEnv("EXACT_REVIEW_ITEM_KIND", env);
  if (value === "issue" || value === "pull_request") return value;
  throw new Error("EXACT_REVIEW_ITEM_KIND must be issue or pull_request");
}
