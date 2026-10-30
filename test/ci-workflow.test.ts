import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";

type Step = {
  id?: string;
  if?: string;
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
  outputs?: Record<string, string>;
  strategy?: { "fail-fast"?: boolean; matrix?: { shard?: number[] } };
  steps: Step[];
};

const jobs = parse(readFileSync(".github/workflows/ci.yml", "utf8")).jobs as Record<string, Job>;

test("review network smoke caches downloads without admitting cached installations", () => {
  const steps = jobs["review-network-smoke"]!.steps;
  const setup = steps.find((step) => step.uses?.startsWith("actions/setup-node@"));
  assert.deepEqual(setup?.with, {
    "node-version": "24.22.1",
    cache: "npm",
    "cache-dependency-path": ".github/actions/setup-codex/action.yml",
  });
  assert.equal(steps.filter((step) => step.run).length, 1);
  assert.equal(steps.find((step) => step.run)?.if, undefined);
});

test(
  "review network smoke installs the exact pin into fresh isolated locations on every run",
  { skip: process.platform === "win32" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "review-network-install-"));
    const tools = join(root, "tools");
    const checkout = join(root, "checkout");
    const temporary = join(root, "temporary");
    const trace = join(root, "calls.jsonl");
    for (const path of [tools, checkout, temporary]) mkdirSync(path);
    symlinkSync(resolve(".github"), join(checkout, ".github"), "dir");
    const action = parse(readFileSync(".github/actions/setup-codex/action.yml", "utf8"));
    const version = action.inputs["codex-version"].default;
    const sandbox = `#!${process.execPath}
const assert = require("node:assert/strict");
const fs = require("node:fs");
const args = process.argv.slice(2);
assert.deepEqual(args.slice(0, 8), ["sandbox", "--permission-profile", "clawsweeper-review", "-C", ${JSON.stringify(checkout)}, "--", "/bin/sh", "-eu"]);
assert.equal(args[8], "-c");
assert.equal(args.length, 10);
assert.equal(process.env.GITHUB_TOKEN, undefined);
assert.equal(process.env.OPENAI_API_KEY, undefined);
const config = fs.readFileSync(process.env.CODEX_HOME + "/config.toml", "utf8");
assert.ok(config.includes('default_permissions = "clawsweeper-review"'));
assert.ok(config.includes('model = "gpt-5.4"'));
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ kind: "sandbox", args, home: process.env.CODEX_HOME }) + "\\n");
`;
    writeFileSync(
      join(tools, "npm"),
      `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const prefix = args[args.indexOf("--prefix") + 1];
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ kind: "install", args, prefix }) + "\\n");
fs.mkdirSync(path.join(prefix, "bin"));
fs.writeFileSync(path.join(prefix, "bin/codex"), ${JSON.stringify(sandbox)}, { mode: 0o755 });
`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(tools, "sysctl"),
      '#!/bin/sh\ncase "$*" in "-n kernel.unprivileged_userns_clone") echo 1;; "-n kernel.apparmor_restrict_unprivileged_userns") echo 0;; *) exit 97;; esac\n',
      { mode: 0o755 },
    );
    try {
      const run = jobs["review-network-smoke"]!.steps.find((step) => step.run)!.run!;
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = spawnSync("/bin/bash", ["-c", run], {
          cwd: checkout,
          encoding: "utf8",
          timeout: 20_000,
          env: {
            PATH: `${tools}:${dirname(process.execPath)}:/usr/bin:/bin`,
            HOME: root,
            RUNNER_TEMP: temporary,
            GITHUB_TOKEN: "fixture-only",
            OPENAI_API_KEY: "fixture-only",
          },
        });
        assert.equal(result.status, 0, result.stderr);
      }
      const calls = readFileSync(trace, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        calls.map((call) => call.kind),
        ["install", "sandbox", "install", "sandbox"],
      );
      assert.notEqual(calls[0].prefix, calls[2].prefix);
      assert.notEqual(calls[1].home, calls[3].home);
      const smoke = readFileSync(".github/actions/setup-codex/smoke-review-network.sh", "utf8");
      const command = smoke.match(/-c '\n([\s\S]+)\n  '\n$/)![1];
      for (const [install, sandboxCall] of [
        [calls[0], calls[1]],
        [calls[2], calls[3]],
      ]) {
        assert.ok(install.prefix.startsWith(join(temporary, "review-codex.")));
        assert.ok(sandboxCall.home.startsWith(join(temporary, "review-codex-home.")));
        assert.notEqual(install.prefix, sandboxCall.home);
        assert.deepEqual(install.args, [
          "install",
          "--global",
          "--prefix",
          install.prefix,
          `@openai/codex@${version}`,
          "--no-audit",
          "--no-fund",
          "--ignore-scripts",
        ]);
        // The real smoke script reaches the fixture CLI; hosted CI proves enforcement.
        assert.equal(sandboxCall.args[9], `\n${command}\n  `);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

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
  assert.deepEqual(check.needs, [
    "check-fast",
    "check-tests",
    "check-coverage",
    "package-admission",
    "local-package",
  ]);
  const [gate] = check.steps;
  assert.equal(gate?.env?.NEEDS, "${{ toJSON(needs) }}");
  const runGate = (needs: Record<string, unknown>) =>
    spawnSync("bash", ["-euo", "pipefail", "-c", gate!.run!], {
      encoding: "utf8",
      env: { ...process.env, NEEDS: JSON.stringify(needs) },
    }).status;
  const passed = {
    "check-fast": { result: "success" },
    "check-tests": { result: "success" },
    "check-coverage": { result: "success" },
    "package-admission": { result: "success", outputs: { "package-required": "true" } },
    "local-package": { result: "success" },
  };
  assert.equal(runGate(passed), 0);
  const skipped = {
    ...passed,
    "package-admission": { result: "success", outputs: { "package-required": "false" } },
    "local-package": { result: "skipped" },
  };
  assert.equal(runGate(skipped), 0);
  assert.notEqual(runGate({ ...passed, "local-package": { result: "skipped" } }), 0);
  for (const result of ["failure", "cancelled", "skipped", ""]) {
    for (const key of ["check-fast", "check-tests", "check-coverage", "package-admission"]) {
      assert.notEqual(
        runGate({ ...skipped, [key]: { ...skipped[key as keyof typeof skipped], result } }),
        0,
      );
    }
  }
  for (const value of [undefined, "", "False", "false\n", false, null, "true "]) {
    assert.notEqual(
      runGate({
        ...passed,
        "package-admission": { result: "success", outputs: { "package-required": value } },
      }),
      0,
    );
  }
  for (const result of ["failure", "cancelled", ""]) {
    assert.notEqual(runGate({ ...skipped, "local-package": { result } }), 0);
  }
  for (const key of Object.keys(passed)) {
    const missing = { ...passed } as Record<string, unknown>;
    delete missing[key];
    assert.notEqual(runGate(missing), 0);
  }
});

test("package admission is dependency-free, bounded and skips only a successful literal false", () => {
  const admission = jobs["package-admission"]!;
  assert.deepEqual(admission.steps[0], {
    uses: "actions/checkout@v7",
    with: { "fetch-depth": 2, "persist-credentials": false },
  });
  assert.deepEqual(admission.steps[1], {
    uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    with: { "node-version": "24.22.1" },
  });
  assert.equal(admission.steps.length, 3);
  assert.equal(admission.steps[2]!.id, "classify");
  assert.equal(admission.steps[2]!.run, "node scripts/local-package-admission.mjs");
  assert.deepEqual(admission.outputs, {
    "package-required": "${{ steps.classify.outputs.package-required }}",
  });
  assert.equal(jobs["local-package"]!.needs, "package-admission");
  assert.equal(
    jobs["local-package"]!.if,
    "${{ !cancelled() && !(needs.package-admission.result == 'success' && needs.package-admission.outputs.package-required == 'false') }}",
  );
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

test("release caller defaults to rehearsal with explicit signed-tag publication", () => {
  const caller = parse(readFileSync(".github/workflows/release.yml", "utf8"));
  assert.deepEqual(Object.keys(caller.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(caller.on.workflow_dispatch.inputs), ["version", "publish"]);
  assert.deepEqual(caller.on.workflow_dispatch.inputs.publish, {
    description: "Publish from an existing signed version tag; otherwise rehearse",
    type: "boolean",
    default: false,
  });
  assert.deepEqual(caller.permissions, {});
  assert.deepEqual(caller.jobs.preflight.permissions, {});
  assert.equal(caller.jobs.qualification.needs, "preflight");
  assert.equal(caller.jobs.qualification.if, undefined);
  assert.deepEqual(caller.jobs.qualification.permissions, { contents: "read" });
  const release = caller.jobs.release;
  assert.equal(
    release.uses,
    "openclaw/release-workflows/.github/workflows/release-source.yml@933d6886e83ec26f29f13b3444638f0d7fd9cde3",
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
    dry_run: "${{ !inputs.publish }}",
    "require-signed-tag": true,
    "require-current-signer": true,
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

test("release preflight visibly rejects publication from any other ref", () => {
  const caller = parse(readFileSync(".github/workflows/release.yml", "utf8"));
  const step = caller.jobs.preflight.steps[0];
  assert.deepEqual(step.env, {
    PUBLISH: "${{ inputs.publish }}",
    VERSION: "${{ inputs.version }}",
    RELEASE_REF: "${{ github.ref }}",
  });
  for (const [publish, version, ref, expected] of [
    ["false", "0.3.1", "refs/heads/main", 0],
    ["", "0.3.1", "refs/heads/main", 0],
    ["true", "0.3.1", "refs/heads/main", 1],
    ["true", "0.3.1", "refs/tags/v0.3.2", 1],
    ["true", "0.3.1", "refs/tags/v0.3.1", 0],
    ["true", "v0.3.1", "refs/tags/v0.3.1", 0],
    ["true", "vv0.3.1", "refs/tags/v0.3.1", 1],
  ] as const) {
    const result = spawnSync("bash", ["-e", "-c", step.run], {
      env: { ...process.env, PUBLISH: publish, VERSION: version, RELEASE_REF: ref },
      encoding: "utf8",
    });
    assert.equal(result.status, expected, result.stderr);
    if (expected)
      assert.match(result.stderr, /Publication requires the existing signed version tag/);
  }
});

test("release signer policy is protected by the security owners", () => {
  assert.equal(
    readFileSync(".github/release-allowed-signers", "utf8"),
    'vincentkoc namespaces="git" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMYJHwFnesHbwtPLErQBRMffbET0Wrbzh+PjkndZRNyy\n',
  );
  assert.match(
    readFileSync(".github/CODEOWNERS", "utf8"),
    /^\/\.github\/release-allowed-signers @openclaw\/openclaw-secops$/m,
  );
});
