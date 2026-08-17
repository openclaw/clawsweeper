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

// `build` compiles tsconfig.json to dist/clawsweeper.js and `build:repair` compiles
// tsconfig.repair.json; neither emits the other's entry point. Resolve a build-script
// through package.json instead of restating which script names cover which bundle, so
// a job that gains a bundle invocation cannot keep a build that omits it.
function packageScripts(): Record<string, string> {
  const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts?: Record<string, string>;
  };
  return manifest.scripts ?? {};
}

function resolveScriptClosure(script: string): Set<string> {
  const scripts = packageScripts();
  const value = script.trim().replace(/^["']|["']$/g, "");
  const expressionScripts = [...script.matchAll(/["']([\w:.-]+)["']/g)].map((match) => match[1]!);
  const pending = /^\/(.+)\/$/.exec(value)
    ? Object.keys(scripts).filter((name) => new RegExp(/^\/(.+)\/$/.exec(value)![1]!).test(name))
    : [value, ...expressionScripts];
  const closure = new Set<string>();
  while (pending.length > 0) {
    const name = pending.pop();
    if (!name || closure.has(name)) continue;
    const body = scripts[name];
    if (body === undefined) continue;
    closure.add(name);
    for (const match of body.matchAll(/pnpm run (?:--silent )?([\w:.-]+)/g)) {
      if (match[1]) pending.push(match[1]);
    }
  }
  return closure;
}

export function buildScriptEmitsMainBundle(script: string): boolean {
  return resolveScriptClosure(script).has("build");
}

export function buildScriptEmitsRepairBundle(script: string): boolean {
  return resolveScriptClosure(script).has("build:repair");
}

export function workflowBuildScripts(workflowPath: string): string[] {
  const workflow = parse(readFileSync(workflowPath, "utf8")) as Workflow;
  return Object.values(workflow.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .filter((step) => String(step.uses ?? "").includes("actions/setup-pnpm"))
    .map((step) => String(step.with?.["build-script"] ?? ""));
}
