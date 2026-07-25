import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

type WorkflowStep = {
  uses?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
};

type Workflow = {
  jobs?: Record<string, { steps?: WorkflowStep[] }>;
};

const workflowFiles = [
  ".github/workflows/assist.yml",
  ".github/workflows/commit-review.yml",
  ".github/workflows/maintainer-activity-report.yml",
  ".github/workflows/repair-cluster-worker.yml",
  ".github/workflows/repair-commit-finding-intake.yml",
  ".github/workflows/state-materializer.yml",
  ".github/workflows/sweep.yml",
];

test("every model CLI setup supports Claude providers with step-scoped credentials", () => {
  const setups: Array<{ file: string; step: WorkflowStep }> = [];
  for (const file of workflowFiles) {
    const workflow = parse(readFileSync(file, "utf8")) as Workflow;
    for (const job of Object.values(workflow.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (step.uses?.endsWith("/.github/actions/setup-codex")) setups.push({ file, step });
      }
    }
  }

  assert.equal(setups.length, 11);
  for (const { file, step } of setups) {
    assert.equal(
      step.with?.["model-runtime"],
      "${{ vars.CLAWSWEEPER_MODEL_RUNTIME || 'codex' }}",
      file,
    );
    assert.equal(
      step.with?.["claude-provider"],
      "${{ vars.CLAWSWEEPER_CLAUDE_PROVIDER || 'anthropic' }}",
      file,
    );
    assert.equal(step.env?.ANTHROPIC_API_KEY, "${{ secrets.ANTHROPIC_API_KEY }}", file);
    assert.equal(step.env?.ANTHROPIC_AUTH_TOKEN, "${{ secrets.ANTHROPIC_AUTH_TOKEN }}", file);
    assert.equal(step.env?.CLAUDE_CODE_OAUTH_TOKEN, "${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}", file);
    assert.equal(
      step.env?.CLAWSWEEPER_INTERNAL_MODEL,
      "${{ vars.CLAWSWEEPER_MODEL_RUNTIME == 'claude' && secrets.CLAWSWEEPER_CLAUDE_MODEL || secrets.CLAWSWEEPER_MODEL }}",
      file,
    );
  }
});

test("Claude setup keeps provider credentials in a private handoff file", () => {
  const action = readFileSync(".github/actions/setup-codex/action.yml", "utf8");
  const shim = readFileSync("src/claude-codex-shim.ts", "utf8");
  assert.match(action, /default: "2\.1\.220"/);
  assert.match(action, /chmod 700 "\$claude_config_dir"/);
  assert.match(action, /provider-env\.json/);
  assert.match(action, /mode: 0o600/);
  assert.match(shim, /CLAUDE_CODE_SUBPROCESS_ENV_SCRUB/);
  assert.doesNotMatch(action, /echo "\$ANTHROPIC_API_KEY"/);
});
