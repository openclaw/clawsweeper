import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { parse } from "yaml";

type Workflow = {
  jobs?: Record<string, { steps?: Array<{ name?: string; run?: string; env?: unknown }> }>;
};

test("cluster worker passes workflow inputs through environment boundaries", () => {
  const source = fs.readFileSync(".github/workflows/repair-cluster-worker.yml", "utf8");
  const workflow = parse(source) as Workflow;
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (typeof step.run !== "string") continue;
      assert.doesNotMatch(
        step.run,
        /\$\{\{\s*inputs\./,
        `${jobName}/${step.name ?? "unnamed"} interpolates an input into shell source`,
      );
    }
  }
  assert.match(source, /job_auth:[\s\S]*Materializer HMAC/);
  assert.equal(source.match(/run: pnpm run repair:restore-cluster-intake-job/g)?.length, 3);
  assert.equal(source.match(/CLAWSWEEPER_WEBHOOK_SECRET: \$\{\{ secrets\./g)?.length, 4);
  assert.ok(
    source.indexOf("Authenticate durable intake before credentials") <
      source.indexOf("Create GitHub App token"),
  );
  assert.doesNotMatch(source, /restore-durable-intake-job\.sh/);
});

test("cluster intake validates one safe repository token before exporting outputs", () => {
  const source = fs.readFileSync(".github/workflows/repair-cluster-intake.yml", "utf8");
  const workflow = parse(source) as Workflow;
  const resolveStep = workflow.jobs?.intake?.steps?.find(
    (step) => step.name === "Resolve target repository",
  );
  assert.ok(resolveStep?.run);
  assert.match(resolveStep.run, /\^\[A-Za-z0-9_\.-\]\+\/\[A-Za-z0-9_\.-\]\+\$/);
  assert.match(resolveStep.run, /printf 'name=%s\\n'/);
  assert.doesNotMatch(resolveStep.run, /echo "name=\$target_name"/);
});
