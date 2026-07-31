import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { parse } from "yaml";

type Workflow = {
  jobs?: Record<
    string,
    {
      env?: Record<string, string>;
      steps?: Array<{ name?: string; run?: string; env?: unknown }>;
    }
  >;
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

test("generated issue workers can create PRs but never inherit the maintainer merge gate", () => {
  const workflow = parse(
    fs.readFileSync(".github/workflows/repair-cluster-worker.yml", "utf8"),
  ) as Workflow;

  for (const jobName of ["cluster", "execute"]) {
    const expression = workflow.jobs?.[jobName]?.env?.CLAWSWEEPER_ALLOW_MERGE;
    assert.ok(expression, `${jobName} is missing an explicit merge gate`);
    assert.match(expression, /!contains\(inputs\.job, '\/inbox\/issue-'\)/);
    assert.match(expression, /\|\| '0'/);
  }

  assert.match(
    workflow.jobs?.execute?.env?.CLAWSWEEPER_OPENCLAW_MODEL ?? "",
    /CLAWSWEEPER_FIX_PR_MODEL \|\| 'gpt-5\.6-sol'/,
  );
  assert.match(
    workflow.jobs?.execute?.env?.CLAWSWEEPER_CODEX_REASONING_EFFORT ?? "",
    /CLAWSWEEPER_FIX_PR_REASONING_EFFORT \|\| 'xhigh'/,
  );
});

test("deduplicated issue dispatch preserves the actual existing worker creation time", () => {
  const source = fs.readFileSync(
    ".github/workflows/repair-issue-implementation-intake.yml",
    "utf8",
  );
  const workflow = parse(source) as Workflow;
  const dispatch = workflow.jobs?.intake?.steps?.find(
    (step) => step.name === "Dispatch repair worker",
  ) as { id?: string } | undefined;
  const record = workflow.jobs?.intake?.steps?.find(
    (step) => step.name === "Record successful repair worker dispatch",
  );

  assert.equal(dispatch?.id, "dispatch-worker");
  assert.match(source, /steps\.dispatch-worker\.outputs\.issue_worker_created_at/);
  assert.match(record?.run ?? "", /--worker-created-at "\$WORKER_CREATED_AT"/);
  assert.match(
    fs.readFileSync("src/repair/dispatch-jobs.ts", "utf8"),
    /issue_worker_created_at=\$\{createdAt\}/,
  );
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
