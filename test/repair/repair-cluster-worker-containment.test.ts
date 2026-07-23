import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const workflow = fs.readFileSync(".github/workflows/repair-cluster-worker.yml", "utf8");

test("repair target containment preflight runs the enforced worker only for fix execution", () => {
  const preflightIndex = workflow.indexOf("- name: Verify Linux validation containment");
  const selfHealIndex = workflow.indexOf("- name: Verify self-heal head", preflightIndex - 1_000);
  const publishStatusIndex = workflow.indexOf(
    "- name: Publish automatic implementation build status",
  );
  const executeFixIndex = workflow.indexOf("- name: Execute credited fix artifact");

  assert.ok(preflightIndex > selfHealIndex);
  assert.ok(publishStatusIndex > preflightIndex);
  assert.ok(executeFixIndex > publishStatusIndex);

  const preflight = workflow.slice(preflightIndex, publishStatusIndex);
  const executionCondition =
    "steps.check_job.outputs.job_exists == '1' && steps.self_heal_head.outputs.matched != 'false' && env.CLAWSWEEPER_ALLOW_EXECUTE == '1' && env.CLAWSWEEPER_ALLOW_FIX_PR == '1'";
  assert.match(preflight, new RegExp(escapeRegExp(`if: \${{ ${executionCondition} }}`)));
  assert.match(preflight, /run: pnpm run repair:containment-smoke/);
  assert.doesNotMatch(preflight, /node --input-type=module|spawnSync|CONTAINMENT_PROBE_ROOT/);
  assert.doesNotMatch(preflight, /continue-on-error/);
});

test("repair target containment worker loads from the isolated work directory", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-containment-entry-"));
  const workerPath = path.resolve("dist/repair/contained-command-worker.js");

  try {
    const worker = spawnSync(process.execPath, [workerPath], {
      cwd: work,
      env: { ...process.env, NODE_TEST_CONTEXT: "child-v8" },
      input: JSON.stringify({
        args: ["-e", 'process.stdout.write("loaded")'],
        command: process.execPath,
        cwd: work,
        isolateNetwork: true,
        maxBuffer: 1024,
        writableRoots: [work],
        windowsVerbatimArguments: false,
      }),
      encoding: "utf8",
    });

    assert.equal(worker.status, 0, worker.stderr);
    assert.deepEqual(JSON.parse(worker.stdout), {
      backgroundProcesses: 0,
      signal: null,
      status: 0,
      stderr: "",
      stdout: "loaded",
    });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("closure-only apply does not depend on target containment or target tool setup", () => {
  const preflightIndex = workflow.indexOf("- name: Verify Linux validation containment");
  const publishStatusIndex = workflow.indexOf(
    "- name: Publish automatic implementation build status",
  );
  const applyIndex = workflow.indexOf("- name: Apply safe closure actions");

  const preflight = workflow.slice(preflightIndex, publishStatusIndex);
  const apply = workflow.slice(applyIndex, workflow.indexOf("- name:", applyIndex + 1));

  assert.match(preflight, /CLAWSWEEPER_ALLOW_FIX_PR == '1'/);
  assert.match(apply, /CLAWSWEEPER_ALLOW_EXECUTE == '1'/);
  assert.doesNotMatch(apply, /CLAWSWEEPER_ALLOW_FIX_PR/);
});

test("privileged execution requires the captured execution gate", () => {
  const executeJobIndex = workflow.indexOf("\n  execute:");
  const executeJob = workflow.slice(executeJobIndex);

  assert.ok(executeJobIndex >= 0);
  assert.match(executeJob, /if:.*needs\.cluster\.outputs\.allow_execute == '1'/);
  assert.match(
    workflow,
    /description: "Linux runner label for fix\/apply execution work with delegated namespaces, recursive mount hardening, and optional Landlock defense in depth"/,
  );
});

test("initial planning forwards the selected model like requeues", () => {
  const runWorkerIndex = workflow.indexOf("- name: Run worker");
  const reviewWorkerIndex = workflow.indexOf("- name: Review worker result", runWorkerIndex);
  const runWorker = workflow.slice(runWorkerIndex, reviewWorkerIndex);

  assert.ok(runWorkerIndex >= 0);
  assert.ok(reviewWorkerIndex > runWorkerIndex);
  assert.match(runWorker, /--model "\$\{\{ inputs\.model \}\}"/);
  assert.equal(workflow.match(/--model "\$\{\{ inputs\.model \}\}"/g)?.length, 2);
});

test("execution-gate downgrades complete the planning session without starting execution", () => {
  const runWorkerIndex = workflow.indexOf("- name: Run worker");
  const completionIndex = workflow.indexOf("- name: Record planning completion", runWorkerIndex);
  const executeIndex = workflow.indexOf("\n  execute:", completionIndex);

  assert.ok(runWorkerIndex >= 0);
  assert.ok(completionIndex > runWorkerIndex);
  assert.ok(executeIndex > completionIndex);
  assert.match(workflow.slice(runWorkerIndex, completionIndex), /effective_mode=\$worker_mode/);
  assert.match(
    workflow.slice(completionIndex, executeIndex),
    /steps\.run_worker\.outputs\.effective_mode.*plan/,
  );
  assert.match(
    workflow.slice(executeIndex),
    /needs\.cluster\.outputs\.effective_mode == 'execute'.*needs\.cluster\.outputs\.effective_mode == 'autonomous'/,
  );
});

test("snapshot-less self-heal retries default to plan mode", () => {
  const source = fs.readFileSync("src/repair/self-heal-failed-runs.ts", "utf8");

  assert.match(source, /record\.effective_mode/);
  assert.match(source, /: "plan"\),?\n\s*};/);
  assert.doesNotMatch(source, /record\.mode \?\? job\.frontmatter\.mode/);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
