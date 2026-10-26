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
  uses?: string;
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
  assert.deepEqual(check.needs, ["check-fast", "check-tests", "check-coverage", "local-package"]);
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

test("release and CI share one qualification whose output requires every consumer", () => {
  const qualification = parse(
    readFileSync(".github/workflows/local-package-qualification.yml", "utf8"),
  );
  const caller = parse(readFileSync(".github/workflows/release.yml", "utf8"));
  assert.equal(jobs["local-package"].uses, "./.github/workflows/local-package-qualification.yml");
  assert.equal(caller.jobs.qualification.uses, jobs["local-package"].uses);
  assert.deepEqual(qualification.permissions, { contents: "read" });
  assert.deepEqual(qualification.on, {
    workflow_call: {
      outputs: {
        "artifact-id": {
          description: "Canonical envelope accepted by every platform consumer",
          value: "${{ jobs.qualified.outputs.artifact-id }}",
        },
      },
    },
  });
  const {
    "package-envelope": producer,
    "installed-package": consumers,
    qualified,
  } = qualification.jobs;
  assert.equal(consumers.needs, "package-envelope");
  assert.deepEqual(consumers.strategy.matrix.os, ["ubuntu-latest", "windows-latest", "xcode-27"]);
  assert.equal(consumers.strategy["fail-fast"], false);
  assert.deepEqual(qualified.needs, ["package-envelope", "installed-package"]);
  // Default success() must skip the ID exporter and caller when any consumer
  // fails or is skipped. An always() exporter would break that ownership gate.
  assert.equal(qualified.if, undefined);
  assert.equal(caller.jobs.release.if, undefined);
  assert.equal(caller.jobs.release.needs, "qualification");
  assert.deepEqual(qualified.outputs, { "artifact-id": "${{ steps.result.outputs.artifact-id }}" });
  assert.equal(
    qualified.steps[0].env.ARTIFACT_ID,
    "${{ needs.package-envelope.outputs.artifact-id }}",
  );
  assert.equal(producer.outputs["artifact-id"], "${{ steps.envelope.outputs.artifact-id }}");
  const download = consumers.steps.find((step) =>
    step.uses?.startsWith("actions/download-artifact@"),
  );
  assert.deepEqual(download.with, {
    "artifact-ids": "${{ needs.package-envelope.outputs.artifact-id }}",
    path: "${{ runner.temp }}/local-package-envelope",
  });
  assert.equal(
    consumers.steps.at(-1).env.CLAWSWEEPER_TEST_PACKAGE_INPUT,
    "${{ runner.temp }}/local-package-envelope",
  );
});

test("release caller stays manual dry-run-only with the pinned shared permissions", () => {
  const caller = parse(readFileSync(".github/workflows/release.yml", "utf8"));
  assert.deepEqual(Object.keys(caller.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(caller.on.workflow_dispatch.inputs), ["version"]);
  assert.deepEqual(caller.permissions, {});
  assert.deepEqual(caller.jobs.qualification.permissions, { contents: "read" });
  const release = caller.jobs.release;
  assert.equal(
    release.uses,
    "openclaw/release-workflows/.github/workflows/release-source.yml@9d81ab3d2877f9900ef787e6dbcf4d9af96eb013",
  );
  assert.equal(release.secrets, undefined);
  assert.deepEqual(release.permissions, {
    actions: "read",
    checks: "read",
    contents: "write",
    statuses: "read",
  });
  assert.deepEqual(release.with, {
    version: "${{ inputs.version }}",
    dry_run: true,
    "require-signed-tag": true,
    "strict-checks": true,
    "ci-check-events": '["push"]',
    "test-runs-on": "ubuntu-latest",
    "test-command":
      "node scripts/release-local-package-envelope.mjs ${{ needs.qualification.outputs.artifact-id }}",
    "generated-input-artifact-id": "${{ needs.qualification.outputs.artifact-id }}",
    "generated-asset": "clawsweeper-local-envelope.tar.gz",
    "source-archives": false,
    "homebrew-formula": "",
  });
});
