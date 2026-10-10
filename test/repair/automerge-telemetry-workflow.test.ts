import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse as parseYaml } from "yaml";

// Parsed workflow YAML. A missing step fails the lookup below.
const workflow = parseYaml(readFileSync(".github/workflows/repair-cluster-worker.yml", "utf8")) as {
  jobs: Record<string, { steps: Array<Record<string, unknown>> }>;
};

test("repair workflow reports failed automerge sessions without changing control flow", () => {
  const step = Object.values(workflow.jobs)
    .flatMap((job) => job.steps)
    .find((candidate) => candidate.name === "Reconcile failed automerge telemetry");

  assert.ok(step, "expected failed automerge telemetry step");
  assert.match(String(step.if), /always\(\) && failure\(\) && inputs\.automerge_session_id != ''/);
  assert.equal(step["continue-on-error"], true);

  const sessionId = 'session "$(touch injected)"';
  const result = spawnSync(
    "bash",
    ["-eu", "-c", `node() { printf '%s\\n' "$@"; }\n${String(step.run)}`],
    {
      encoding: "utf8",
      env: { ...process.env, AUTOMERGE_RUN_URL: "https://run", AUTOMERGE_SESSION_ID: sessionId },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trimEnd().split("\n"), [
    "scripts/dashboard-reconcile-automerge.ts",
    "--session-id",
    sessionId,
    "--run-url",
    "https://run",
    "--run-conclusion",
    "failure",
  ]);
});
