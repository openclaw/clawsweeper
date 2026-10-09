import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";

// Parsed workflow YAML. A missing job or step fails the step lookup below.
const workflow = parseYaml(
  fs.readFileSync(".github/workflows/repair-cluster-worker.yml", "utf8"),
) as {
  env: Record<string, string>;
  jobs: { cluster: { steps: Array<{ name?: string; run?: string }> } };
};

test("repair target containment worker loads from the isolated work directory", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-containment-entry-"));

  try {
    const worker = runWorker(work, { ...process.env, NODE_TEST_CONTEXT: "child-v8" });

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

test(
  "validation worker refuses to run commands without Linux containment",
  { skip: process.platform === "linux" },
  () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-containment-platform-"));
    const { NODE_TEST_CONTEXT: _testContext, ...env } = process.env;

    try {
      const worker = runWorker(work, env);

      assert.notEqual(worker.status, 0);
      assert.match(worker.stderr, /validation process containment requires Linux/);
      assert.doesNotMatch(worker.stdout, /loaded/);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  },
);

test("planning forwards the selected model and downgrades modes unless execution is allowed", () => {
  assert.equal(workflow.env.CLUSTER_WORKER_MODEL, "${{ inputs.model }}");
  for (const [mode, allowExecute, effectiveMode] of [
    ["execute", "0", "plan"],
    ["autonomous", "1", "autonomous"],
  ]) {
    const result = runClusterStep("Run worker", {
      CLAWSWEEPER_ALLOW_EXECUTE: allowExecute,
      CLUSTER_JOB_PATH: "jobs/openclaw/inbox/issue-openclaw-openclaw-1.md",
      CLUSTER_WORKER_DRY_RUN: "false",
      CLUSTER_WORKER_MODE: mode,
      CLUSTER_WORKER_MODEL: "selected-model",
    });

    assert.equal(result.output, `effective_mode=${effectiveMode}\n`);
    assert.deepEqual(result.pnpm, [
      "run",
      "repair:worker",
      "--",
      "jobs/openclaw/inbox/issue-openclaw-openclaw-1.md",
      "--mode",
      effectiveMode,
      "--model",
      "selected-model",
    ]);
  }
});

test("plan-only planning completes the session without starting execution", () => {
  const complete = (effectiveMode: string) =>
    runClusterStep("Record planning completion", {
      CLUSTER_WORKER_DRY_RUN: "false",
      EFFECTIVE_MODE: effectiveMode,
    }).pnpm;

  assert.deepEqual(complete("plan").slice(0, 6), [
    "run",
    "repair:action-session",
    "--",
    "update",
    "--state",
    "completed",
  ]);
  assert.ok(complete("plan").includes("plan_complete"));
  assert.deepEqual(complete("execute").slice(4, 6), ["--state", "running"]);
});

function runWorker(work: string, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [path.resolve("dist/repair/contained-command-worker.js")], {
    cwd: work,
    env,
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
}

function runClusterStep(name: string, env: Record<string, string>) {
  const step = workflow.jobs.cluster.steps.find((candidate) => candidate.name === name);
  assert.ok(step?.run, name);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-cluster-step-"));
  const output = path.join(root, "github-output");
  const pnpmArgs = path.join(root, "pnpm-args");
  fs.writeFileSync(output, "");
  fs.writeFileSync(pnpmArgs, "");
  try {
    const result = spawnSync(
      "bash",
      ["-eu", "-c", `pnpm() { printf '%s\\n' "$@" >> "$PNPM_ARGS"; }\n${step.run}`],
      {
        encoding: "utf8",
        env: { ...process.env, ...env, GITHUB_OUTPUT: output, PNPM_ARGS: pnpmArgs },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return {
      output: fs.readFileSync(output, "utf8"),
      pnpm: fs.readFileSync(pnpmArgs, "utf8").trimEnd().split("\n"),
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
