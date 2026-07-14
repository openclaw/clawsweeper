import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workflow = fs.readFileSync(".github/workflows/repair-cluster-worker.yml", "utf8");

test("repair target containment preflight runs the enforced worker only for fix execution", () => {
  const preflightIndex = workflow.indexOf("- name: Verify Linux validation containment");
  const selfHealIndex = workflow.indexOf("- name: Verify self-heal head", preflightIndex - 1_000);
  const setupBunIndex = workflow.indexOf("- name: Setup pinned Bun for target validation");
  const executeFixIndex = workflow.indexOf("- name: Execute credited fix artifact");

  assert.ok(preflightIndex > selfHealIndex);
  assert.ok(setupBunIndex > preflightIndex);
  assert.ok(executeFixIndex > setupBunIndex);

  const preflight = workflow.slice(preflightIndex, setupBunIndex);
  const executionCondition =
    "steps.check_job.outputs.job_exists == '1' && steps.self_heal_head.outputs.matched != 'false' && env.CLAWSWEEPER_ALLOW_EXECUTE == '1' && env.CLAWSWEEPER_ALLOW_FIX_PR == '1'";
  assert.match(preflight, new RegExp(escapeRegExp(`if: \${{ ${executionCondition} }}`)));
  assert.match(preflight, /dist\/repair\/contained-command-worker\.js/);
  assert.match(preflight, /host filesystem remained visible/);
  assert.match(preflight, /host \/run entries remained visible/);
  assert.match(preflight, /non-writable path accepted a write/);
  assert.match(preflight, /validation capabilities were not fully dropped/);
  assert.match(preflight, /listener\.bind\(\('127\.0\.0\.1', 0\)\)/);
  assert.match(preflight, /result\.status !== 0/);
  assert.match(preflight, /result\.backgroundProcesses !== 0/);
  assert.doesNotMatch(preflight, /continue-on-error/);
  assert.doesNotMatch(preflight, /mount_probe|mount_errno|assert not \(mount_probe/);
});

test("closure-only apply does not depend on target containment or target tool setup", () => {
  const preflightIndex = workflow.indexOf("- name: Verify Linux validation containment");
  const setupBunIndex = workflow.indexOf("- name: Setup pinned Bun for target validation");
  const applyIndex = workflow.indexOf("- name: Apply safe closure actions");

  const preflight = workflow.slice(preflightIndex, setupBunIndex);
  const setupBun = workflow.slice(setupBunIndex, applyIndex);
  const apply = workflow.slice(applyIndex, workflow.indexOf("- name:", applyIndex + 1));

  assert.match(preflight, /CLAWSWEEPER_ALLOW_FIX_PR == '1'/);
  assert.match(setupBun, /CLAWSWEEPER_ALLOW_FIX_PR == '1'/);
  assert.match(apply, /CLAWSWEEPER_ALLOW_EXECUTE == '1'/);
  assert.doesNotMatch(apply, /CLAWSWEEPER_ALLOW_FIX_PR/);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
