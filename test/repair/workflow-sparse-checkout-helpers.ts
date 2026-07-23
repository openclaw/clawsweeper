import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parse } from "yaml";

export const SPARSE_REPAIR_BUILD_WORKFLOWS = [
  ".github/workflows/repair-comment-router.yml",
  ".github/workflows/spam-comment-intake.yml",
  ".github/workflows/spam-scanner.yml",
] as const;

type WorkflowStep = {
  uses?: unknown;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  steps?: WorkflowStep[];
};

type Workflow = {
  jobs?: Record<string, WorkflowJob>;
};

export function sourceSparseCheckoutEntries(workflowPath: string): string[] {
  // This helper is loaded before the smoke test builds anything, so it must not import the
  // general test helper whose production-module imports require an existing dist tree.
  const workflow = parse(readFileSync(workflowPath, "utf8")) as Workflow;
  const checkout = Object.values(workflow.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .find((step) => String(step.uses ?? "").startsWith("actions/checkout@"));
  assert.ok(checkout, `${workflowPath} must checkout its source tree`);

  const sparseCheckout = checkout.with?.["sparse-checkout"];
  assert.equal(typeof sparseCheckout, "string", `${workflowPath} must use sparse checkout`);
  return sparseCheckout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function sparseEntriesCover(entries: readonly string[], requiredPath: string): boolean {
  return entries.some((entry) => requiredPath === entry || requiredPath.startsWith(`${entry}/`));
}
