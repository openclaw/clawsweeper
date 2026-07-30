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
}

function yamlFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return yamlFiles(path);
    return /\.ya?ml$/.test(entry.name) ? [path] : [];
  });
}

const actionFiles = yamlFiles(".github");
const checkoutReferences = actionFiles.flatMap((path) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.includes("actions/checkout@"))
    .map((line) => ({
      path,
      reference: line
        .trim()
        .replace(/^-?\s*uses:\s*/, "")
        .replace(/\s+#.*$/, ""),
    })),
);
const checkoutV7Commit = "9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0";

test("every checkout uses v7 without disabling its fork-PR guard", () => {
  assert.ok(checkoutReferences.length > 0, "expected checkout action references");
  for (const { path, reference } of checkoutReferences) {
    assert.ok(
      reference === "actions/checkout@v7" || reference === `actions/checkout@${checkoutV7Commit}`,
      `${path}: ${reference}`,
    );
  }

  const sources = actionFiles.map((path) => readFileSync(path, "utf8")).join("\n");
  assert.doesNotMatch(sources, /allow-unsafe-pr-checkout:\s*true/);
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
