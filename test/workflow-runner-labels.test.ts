import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

type WorkflowDocument = {
  jobs?: Record<string, { "runs-on"?: string | string[] }>;
};

const workflowDirectory = ".github/workflows";
const expectedRunnerByJob = new Map([
  [
    ".github/workflows/sweep.yml:event-review-apply",
    "${{ vars.CLAWSWEEPER_REVIEW_RUNNER || 'ubuntu-latest' }}",
  ],
  [
    ".github/workflows/sweep.yml:review",
    "${{ vars.CLAWSWEEPER_REVIEW_RUNNER || 'ubuntu-latest' }}",
  ],
  [
    ".github/workflows/automerge-e2e.yml:automerge-e2e",
    "${{ vars.CLAWSWEEPER_E2E_RUNNER || 'blacksmith-16vcpu-ubuntu-2404' }}",
  ],
  [
    ".github/workflows/maintainer-report-discord.yml:notify",
    "${{ vars.CLAWSWEEPER_REPORT_RUNNER || 'blacksmith-4vcpu-ubuntu-2404' }}",
  ],
  [
    ".github/workflows/repair-containment-smoke.yml:containment-smoke",
    "${{ vars.CLAWSWEEPER_E2E_RUNNER || 'blacksmith-16vcpu-ubuntu-2404' }}",
  ],
  [
    ".github/workflows/repair-publish-results.yml:publish",
    "${{ vars.CLAWSWEEPER_WORKER_RUNNER || 'blacksmith-4vcpu-ubuntu-2404' }}",
  ],
  [
    ".github/workflows/spam-comment-intake.yml:intake",
    "${{ vars.CLAWSWEEPER_SPAM_RUNNER || 'blacksmith-4vcpu-ubuntu-2404' }}",
  ],
  [
    ".github/workflows/spam-scanner.yml:scan",
    "${{ vars.CLAWSWEEPER_SPAM_RUNNER || 'blacksmith-4vcpu-ubuntu-2404' }}",
  ],
]);

test("Blacksmith lanes keep their expected variable names and default labels", () => {
  for (const [site, expectedRunner] of expectedRunnerByJob) {
    const separator = site.lastIndexOf(":");
    const file = site.slice(0, separator);
    const jobName = site.slice(separator + 1);
    const workflow = parse(readFileSync(file, "utf8")) as WorkflowDocument;

    assert.equal(workflow.jobs?.[jobName]?.["runs-on"], expectedRunner, site);
  }
});

test("Blacksmith runner assignments keep a repository-variable escape hatch", () => {
  for (const name of readdirSync(workflowDirectory).filter((entry) => /\.ya?ml$/.test(entry))) {
    const file = join(workflowDirectory, name);
    const workflow = parse(readFileSync(file, "utf8")) as WorkflowDocument;
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      const runner = String(job["runs-on"] ?? "");
      if (!runner.includes("blacksmith-")) continue;

      assert.match(
        runner,
        /vars\.CLAWSWEEPER_[A-Z0-9_]*RUNNER\s*\|\|\s*'blacksmith-[a-z0-9-]+'/,
        `${file}:${jobName} must keep its Blacksmith label behind a vars fallback`,
      );
    }
  }
});
