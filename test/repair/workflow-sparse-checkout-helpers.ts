import assert from "node:assert/strict";

import { parse } from "yaml";

import { readText } from "../helpers.ts";

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
  const workflow = parse(readText(workflowPath)) as Workflow;
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
