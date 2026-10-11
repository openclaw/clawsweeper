import assert from "node:assert/strict";
import test from "node:test";
import { parse as parseYaml } from "yaml";

import { readText } from "../helpers.ts";

type Workflow = {
  on: Record<string, { paths?: string[] } | null>;
  permissions: Record<string, string>;
  jobs: Record<
    string,
    {
      if?: string;
      "continue-on-error"?: unknown;
      steps: Array<{ run?: string; "continue-on-error"?: unknown }>;
    }
  >;
};

// The smoke is the only pre-merge run of real containment on a production-class runner.
test("containment smoke runs the compiled preflight for every containment change", () => {
  const document = parseYaml(
    readText(".github/workflows/repair-containment-smoke.yml"),
  ) as Workflow;
  const job = document.jobs["containment-smoke"]!;
  assert.deepEqual(document.permissions, { contents: "read" });
  assert.match(job.if ?? "", /github\.event_name != 'pull_request'/);
  assert.match(
    job.if ?? "",
    /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
  );
  const jobSteps = job.steps;
  assert.deepEqual(
    jobSteps.filter((step) => step.run).map((step) => step.run),
    ["pnpm run repair:containment-smoke"],
  );
  assert.ok(jobSteps.every((step) => step["continue-on-error"] === undefined));
  assert.equal(job["continue-on-error"], undefined);
  for (const source of [
    "src/repair/contained-command-sandbox.ts",
    "src/repair/contained-command-worker.ts",
    "src/repair/containment-preflight.ts",
    "src/repair/process-tree-containment.ts",
  ]) {
    assert.ok(document.on.push?.paths?.includes(source), source);
    assert.ok(document.on.pull_request?.paths?.includes(source), source);
  }
});
