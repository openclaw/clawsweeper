import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const workflow = parse(readFileSync(".github/workflows/dashboard.yml", "utf8"));
const verify = workflow.jobs.verify;
const smoke = verify.steps.find((step: { run?: string }) => step.run);

function evaluate(expression: string, event: string, mode: string) {
  return new Function("github", "inputs", `return (${expression.slice(3, -2)});`)(
    { event_name: event },
    { mode },
  );
}

test("dashboard verification is explicit and cannot cancel or enter deployment", () => {
  assert.equal(workflow.on.workflow_dispatch.inputs.mode.default, "deploy");
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.mode.options, ["deploy", "verify"]);
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  for (const [event, mode, deploy, verification] of [
    ["push", "", true, false],
    ["workflow_dispatch", "deploy", true, false],
    ["workflow_dispatch", "verify", false, true],
    ["workflow_dispatch", "unknown", false, false],
  ] as const) {
    assert.equal(evaluate(workflow.jobs.deploy.if, event, mode), deploy);
    assert.equal(evaluate(verify.if, event, mode), verification);
  }
  assert.equal(workflow.concurrency, undefined);
  assert.deepEqual(workflow.jobs.deploy.concurrency, {
    group: "clawsweeper-live-dashboard",
    "cancel-in-progress": true,
  });
  assert.deepEqual(verify.concurrency, {
    group: "clawsweeper-live-dashboard-verify",
    "cancel-in-progress": false,
  });
});

test("dashboard verification exposes only the existing signing secret to the smoke step", () => {
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.env, undefined);
  assert.equal(verify.env, undefined);
  assert.deepEqual(
    verify.steps
      .filter((step: { uses?: string }) => step.uses)
      .map((step: { uses: string }) => step.uses),
    ["actions/checkout@v7", "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020"],
  );
  assert.equal(verify.steps[0].with["persist-credentials"], false);
  assert.equal(verify.steps[1].with["node-version"], "24.22.1");
  assert.equal(verify.steps.filter((step: { run?: string }) => step.run).length, 1);
  assert.deepEqual(smoke.env, {
    CLAWSWEEPER_STATUS_URL: "https://clawsweeper.openclaw.ai",
    CLAWSWEEPER_EXPECTED_DEPLOY_SHA: "${{ inputs.expected_deployment_sha }}",
    CLAWSWEEPER_WEBHOOK_SECRET: "${{ secrets.CLAWSWEEPER_WEBHOOK_SECRET }}",
  });
  assert.doesNotMatch(smoke.run, /wrangler|curl|pnpm|npx|secrets-bulk/);
});

test("dashboard verification validates its revision before invoking the existing smoke", () => {
  const run = (sha: string, secret = "synthetic-signing-secret") =>
    spawnSync("bash", ["-c", `node() { printf '%s\\n' "$*"; }\n${smoke.run}`], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        CLAWSWEEPER_STATUS_URL: smoke.env.CLAWSWEEPER_STATUS_URL,
        CLAWSWEEPER_EXPECTED_DEPLOY_SHA: sha,
        CLAWSWEEPER_WEBHOOK_SECRET: secret,
      },
    });
  const valid = run("a".repeat(40));
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(valid.stdout, "scripts/dashboard-smoke.mjs https://clawsweeper.openclaw.ai\n");
  assert.equal(valid.stderr, "");
  for (const sha of ["", "a".repeat(39), "a".repeat(41), "A".repeat(40), "$(private-marker)"]) {
    const invalid = run(sha);
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stdout, "");
    assert.match(invalid.stderr, /Verification requires a full deployed commit SHA/);
    assert.doesNotMatch(invalid.stderr, /private-marker|synthetic-signing-secret/);
  }
  const unsigned = run("a".repeat(40), "");
  assert.equal(unsigned.status, 1);
  assert.equal(unsigned.stdout, "");
});
