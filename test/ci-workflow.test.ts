import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

type Step = {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
};
type Job = {
  name?: string;
  if?: string;
  needs?: string | string[];
  strategy?: { "fail-fast"?: boolean; matrix?: { shard?: number[] } };
  steps: Step[];
};

const jobs = parse(readFileSync(".github/workflows/ci.yml", "utf8")).jobs as Record<string, Job>;

test("CI keeps one pnpm check status that requires every check job", () => {
  assert.deepEqual(
    Object.entries(jobs)
      .filter(([, job]) => job.name === "pnpm check")
      .map(([id]) => id),
    ["check"],
  );
  const check = jobs.check!;
  // A skipped job reads as success to required-status checks, so it must always run.
  assert.equal(check.if, "always()");
  assert.deepEqual(check.needs, ["check-fast", "check-tests", "check-coverage"]);
  const [gate] = check.steps;
  assert.equal(gate?.env?.NEEDS, "${{ toJSON(needs) }}");
  assert.match(gate?.run ?? "", /jq -e 'all\(\.\[\]; \.result == "success"\)'/);
});

test("CI runs the fast gates once and the full suite as coverage shards", () => {
  assert.ok(jobs["check-fast"]!.steps.some((step) => step.run === "pnpm run check:fast"));

  const shards = jobs["check-tests"]!;
  assert.equal(shards.strategy?.["fail-fast"], false);
  const matrix = shards.strategy?.matrix?.shard ?? [];
  assert.ok(matrix.length > 1);
  assert.deepEqual(
    matrix,
    matrix.map((_, index) => index + 1),
  );
  const shardRun = shards.steps.find((step) => step.run?.includes("--shard"));
  assert.equal(shardRun?.env?.SHARD, "${{ matrix.shard }}/${{ strategy.job-total }}");
  assert.equal(
    shardRun?.run,
    'node scripts/run-node-tests.mjs all --shard "$SHARD" --coverage-out "$RUNNER_TEMP/coverage"',
  );
  const upload = shards.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
  assert.deepEqual(upload?.with, {
    name: "coverage-shard-${{ matrix.shard }}",
    path: "${{ runner.temp }}/coverage",
    "if-no-files-found": "error",
    "retention-days": 1,
    overwrite: true,
  });

  const coverage = jobs["check-coverage"]!;
  assert.equal(coverage.needs, "check-tests");
  const download = coverage.steps.find((step) =>
    step.uses?.startsWith("actions/download-artifact@"),
  );
  assert.deepEqual(download?.with, {
    pattern: "coverage-shard-*",
    path: "${{ runner.temp }}/coverage",
  });
  assert.ok(
    coverage.steps.some(
      (step) =>
        step.run === 'node scripts/run-node-tests.mjs all --coverage-from "$RUNNER_TEMP/coverage"',
    ),
  );

  // The report maps profiles onto compiled sources, so both jobs build the same outputs.
  const buildScript = (job: Job) =>
    job.steps.find((step) => step.uses === "./.github/actions/setup-pnpm")?.with?.["build-script"];
  assert.equal(buildScript(shards), "build:all");
  assert.equal(buildScript(coverage), "build:all");
});
