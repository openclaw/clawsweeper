import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

interface CheckoutStep {
  uses?: string;
  with?: Record<string, unknown>;
}

interface WorkflowDocument {
  jobs?: Record<string, { steps?: CheckoutStep[] }>;
  runs?: { steps?: CheckoutStep[] };
}

function yamlFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return yamlFiles(path);
    return /\.ya?ml$/.test(entry.name) ? [path] : [];
  });
}

const checkoutV7Commit = "3d3c42e5aac5ba805825da76410c181273ba90b1";

test("every checkout uses v7 without disabling its fork-PR guard", () => {
  const checkouts = yamlFiles(".github").flatMap((path) => {
    const document = parse(readFileSync(path, "utf8")) as WorkflowDocument;
    return [
      ...Object.values(document.jobs ?? {}).flatMap((job) => job.steps ?? []),
      ...(document.runs?.steps ?? []),
    ]
      .filter((step) => step.uses?.startsWith("actions/checkout@"))
      .map((step) => ({ path, step }));
  });
  assert.ok(checkouts.length > 0, "expected checkout action references");
  for (const { path, step } of checkouts) {
    assert.ok(
      step.uses === "actions/checkout@v7" || step.uses === `actions/checkout@${checkoutV7Commit}`,
      `${path}: ${step.uses}`,
    );
    assert.notEqual(String(step.with?.["allow-unsafe-pr-checkout"]), "true", path);
  }
});

test("trusted-event workflows explicitly checkout the default branch", () => {
  const expectedRefs: Record<string, string> = {
    ".github/workflows/dashboard-ci.yml": "${{ github.event.repository.default_branch }}",
    ".github/workflows/github-activity.yml": "${{ github.event.repository.default_branch }}",
    // workflow_run events stay pinned to trusted default-branch code; the
    // manual publication lane runs its own write-gated dispatch ref.
    ".github/workflows/repair-publish-results.yml":
      "${{ github.event_name == 'workflow_dispatch' && github.ref_name || github.event.repository.default_branch }}",
  };
  for (const [path, expectedRef] of Object.entries(expectedRefs)) {
    const workflow = parse(readFileSync(path, "utf8")) as WorkflowDocument;
    const checkoutSteps = Object.values(workflow.jobs ?? {})
      .flatMap((job) => job.steps ?? [])
      .filter((step) => step.uses === "actions/checkout@v7");
    assert.equal(checkoutSteps.length, 1, path);
    assert.equal(checkoutSteps[0]?.with?.ref, expectedRef, path);
  }
});

test("trusted-event state checkout remains pinned to the state repository branch", () => {
  const action = parse(readFileSync(".github/actions/setup-state/action.yml", "utf8")) as {
    runs?: { steps?: CheckoutStep[] };
  };
  const checkout = action.runs?.steps?.find((step) => step.uses === "actions/checkout@v7");
  assert.equal(checkout?.with?.repository, "openclaw/clawsweeper-state");
  assert.equal(checkout?.with?.ref, "state");
});
