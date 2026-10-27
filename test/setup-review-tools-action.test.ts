import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { reviewToolArtifact, TRUFFLEHOG_VERSION } from "../dist/review-tool-bootstrap.js";

const actionPath = resolve(".github/actions/setup-review-tools");
const helper = join(actionPath, "archive-cache.mjs");
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const shell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function scannerFixture(options: { version?: string; smoke?: string } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clawsweeper-archive-test-")));
  const bin = join(root, "bin");
  const temporary = join(root, "temporary");
  const checkout = join(root, "checkout");
  const source = join(root, "source");
  for (const path of [bin, temporary, checkout, source]) mkdirSync(path);
  const calls = join(root, "scanner-calls");
  const downloads = join(root, "downloads");
  const payload = join(root, "payload.tar.gz");
  writeFileSync(
    join(source, "trufflehog"),
    `#!/bin/sh
test -z "\${OPENAI_API_KEY:-}\${GITHUB_TOKEN:-}" || exit 90
printf '%s|%s|%s\\n' "$*" "$HOME" "\${TMPDIR:-}" >> ${shell(calls)}
if [ "$1" = --version ]; then printf '%s\\n' ${shell(options.version ?? `trufflehog ${TRUFFLEHOG_VERSION}`)}; exit 0; fi
${options.smoke ?? "exit 0"}
`,
    { mode: 0o700 },
  );
  const packed = spawnSync("/usr/bin/tar", ["-czf", payload, "-C", source, "trufflehog"], {
    encoding: "utf8",
  });
  assert.equal(packed.status, 0, packed.stderr);
  const bytes = readFileSync(payload);
  writeFileSync(
    join(bin, "uname"),
    '#!/bin/sh\nif [ "$1" = -s ]; then echo Linux; else echo x86_64; fi\n',
    { mode: 0o700 },
  );
  symlinkSync(process.execPath, join(bin, "node"));
  writeFileSync(
    join(bin, "curl"),
    `#!/bin/sh
printf '%s\\n' "$*" >> ${shell(downloads)}
while [ "$1" != --output ]; do shift; done
cp ${shell(payload)} "$2"
`,
    { mode: 0o700 },
  );
  if (process.platform === "darwin")
    writeFileSync(join(bin, "sha256sum"), '#!/bin/sh\nexec /usr/bin/shasum -a 256 "$@"\n', {
      mode: 0o700,
    });
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    RUNNER_TEMP: temporary,
    GITHUB_WORKSPACE: checkout,
    GITHUB_PATH: join(root, "github-path"),
    GITHUB_OUTPUT: join(root, "github-output"),
    WORKFLOW_ACTION_PATH: actionPath,
    OPENAI_API_KEY: "must-not-reach-scanner",
    GITHUB_TOKEN: "must-not-reach-scanner",
  };
  const script = readFileSync(join(actionPath, "install.sh"), "utf8");
  assert.equal(script.match(/archive_sha256="[a-f0-9]{64}"/g)?.length, 1);
  // Only fixture bytes replace the pin; acquisition, verification, extraction and smoke stay real.
  const installer = script.replace(
    /archive_sha256="[a-f0-9]{64}"/,
    `archive_sha256="${hash(bytes)}"`,
  );
  const metadata = () => spawnSync(process.execPath, [helper], { env, encoding: "utf8" });
  const archive = join(temporary, "clawsweeper-review-archive", "archive.tar.gz");
  return {
    root,
    temporary,
    checkout,
    calls,
    downloads,
    payload,
    bytes,
    env,
    archive,
    metadata,
    run: (archivePath = archive) =>
      spawnSync("/bin/bash", ["-c", installer], {
        env: { ...env, CLAWSWEEPER_REVIEW_ARCHIVE_PATH: archivePath },
        encoding: "utf8",
      }),
    paths: () =>
      existsSync(env.GITHUB_PATH) ? readFileSync(env.GITHUB_PATH, "utf8").trim().split("\n") : [],
    downloadCount: () =>
      existsSync(downloads) ? readFileSync(downloads, "utf8").trim().split("\n").length : 0,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

test(
  "review scanner cold and warm archives always install and smoke fresh binaries",
  { skip: process.platform === "win32" },
  () => {
    const f = scannerFixture();
    try {
      const metadata = f.metadata();
      assert.equal(metadata.status, 0, metadata.stderr);
      const artifact = reviewToolArtifact("linux", "x64")!;
      assert.equal(
        readFileSync(f.env.GITHUB_OUTPUT, "utf8"),
        `archive-path=${f.archive}\ncache-key=review-scanner-archive-v1-${TRUFFLEHOG_VERSION}-${artifact.platform}-${artifact.sha256}\n`,
      );
      const cold = f.run();
      assert.equal(cold.status, 0, cold.stderr);
      assert.equal(hash(readFileSync(f.archive)), hash(f.bytes));
      assert.equal(statSync(f.archive).mode & 0o777, 0o600);
      const warm = f.run();
      assert.equal(warm.status, 0, warm.stderr);
      assert.equal(f.downloadCount(), 1);
      const paths = f.paths();
      assert.equal(paths.length, 2);
      assert.notEqual(paths[0], paths[1]);
      const calls = readFileSync(f.calls, "utf8").trim().split("\n");
      assert.equal(calls.length, 4);
      for (let index = 0; index < 2; index++) {
        const home = paths[index].slice(0, -4);
        assert.equal(calls[index * 2], `--version|${home}|`);
        assert.equal(
          calls[index * 2 + 1],
          `filesystem ${home}/smoke --results=verified,unknown --fail --fail-on-scan-errors --no-update --json --no-color|${home}|${home}`,
        );
        assert.equal(existsSync(join(home, "archive.tar.gz")), false);
        assert.equal(existsSync(join(home, "smoke")), false);
      }
      assert.match(
        readFileSync(f.downloads, "utf8"),
        /--connect-timeout 15 --max-time 60 --retry 2 --retry-all-errors --retry-delay 2 --retry-max-time 120/,
      );
    } finally {
      f.dispose();
    }
  },
);

for (const candidate of ["missing", "corrupt"])
  test(
    `review scanner ${candidate} archive acquires verified pinned bytes`,
    { skip: process.platform === "win32" },
    () => {
      const f = scannerFixture();
      try {
        assert.equal(f.metadata().status, 0);
        if (candidate === "corrupt") writeFileSync(f.archive, "not an archive", { mode: 0o600 });
        const result = f.run();
        assert.equal(result.status, 0, result.stderr);
        assert.equal(f.downloadCount(), 1);
        assert.equal(hash(readFileSync(f.archive)), hash(f.bytes));
        assert.equal(f.paths().length, 1);
      } finally {
        f.dispose();
      }
    },
  );

for (const failure of ["version", "smoke-exit", "smoke-output"])
  test(
    `review scanner ${failure} failure publishes neither PATH nor archive`,
    { skip: process.platform === "win32" },
    () => {
      const f = scannerFixture(
        failure === "version"
          ? { version: "trufflehog 0.0.0" }
          : { smoke: failure === "smoke-exit" ? "exit 7" : "echo unexpected-diagnostic" },
      );
      try {
        assert.equal(f.metadata().status, 0);
        const result = f.run();
        assert.notEqual(result.status, 0);
        assert.deepEqual(f.paths(), []);
        assert.equal(existsSync(f.archive), false);
        assert.deepEqual(readdirSync(f.temporary), ["clawsweeper-review-archive"]);
        assert.doesNotMatch(result.stdout + result.stderr, /unexpected-diagnostic/);
      } finally {
        f.dispose();
      }
    },
  );

for (const unsafe of [
  "symlink",
  "hardlink",
  "public-file",
  "public-directory",
  "wrong-path",
  "checkout",
  "checkout-dot-prefix",
])
  test(
    `review scanner refuses ${unsafe} archive transport before acquisition or execution`,
    { skip: process.platform === "win32" },
    () => {
      const f = scannerFixture();
      try {
        assert.equal(f.metadata().status, 0);
        let archivePath = f.archive;
        if (unsafe === "symlink") symlinkSync(f.payload, f.archive);
        if (unsafe === "hardlink") {
          chmodSync(f.payload, 0o600);
          linkSync(f.payload, f.archive);
        }
        if (unsafe === "public-file") writeFileSync(f.archive, f.bytes, { mode: 0o644 });
        if (unsafe === "public-directory")
          chmodSync(join(f.temporary, "clawsweeper-review-archive"), 0o755);
        if (unsafe === "wrong-path") archivePath = f.payload;
        if (unsafe === "checkout") f.env.RUNNER_TEMP = f.checkout;
        if (unsafe === "checkout-dot-prefix") {
          f.env.RUNNER_TEMP = join(f.checkout, "..transport");
          mkdirSync(f.env.RUNNER_TEMP);
        }
        if (unsafe.startsWith("checkout")) assert.notEqual(f.metadata().status, 0);
        const result = f.run(archivePath);
        assert.notEqual(result.status, 0);
        assert.equal(f.downloadCount(), 0);
        assert.equal(existsSync(f.calls), false);
        assert.deepEqual(f.paths(), []);
        assert.equal(
          readdirSync(f.temporary).filter((name) => name.startsWith("clawsweeper-review-tools."))
            .length,
          0,
        );
      } finally {
        f.dispose();
      }
    },
  );

test("shared scanner setup restores only the exact archive and saves before its caller continues", () => {
  type Step = {
    uses?: string;
    id?: string;
    if?: string;
    run?: string;
    with?: Record<string, unknown>;
    "continue-on-error"?: boolean;
  };
  const shared = parse(readFileSync(join(actionPath, "action.yml"), "utf8")) as {
    runs: { steps: Step[] };
  };
  const [metadata, restore, install, save] = shared.runs.steps;
  const artifact = reviewToolArtifact("linux", "x64")!;
  const installer = readFileSync(join(actionPath, "install.sh"), "utf8");
  assert.ok(installer.includes(`archive_sha256="${artifact.sha256}"`));
  assert.ok(installer.includes(artifact.url));
  assert.ok(installer.includes(`trufflehog ${TRUFFLEHOG_VERSION}`));
  assert.equal(shared.runs.steps.length, 4);
  assert.equal(metadata.id, "archive");
  assert.equal(restore.uses, "actions/cache/restore@v6");
  assert.equal(save.uses, "actions/cache/save@v6");
  assert.deepEqual(restore.with, save.with);
  assert.deepEqual(Object.keys(restore.with!).sort(), ["key", "path"]);
  assert.equal(restore["continue-on-error"], true);
  assert.equal(save["continue-on-error"], true);
  assert.equal(save.if, "steps.restore.outputs.cache-hit != 'true'");
  assert.match(install.run!, /install\.sh/);
  for (const name of ["setup-codex", "setup-openclaw"]) {
    const caller = parse(readFileSync(`.github/actions/${name}/action.yml`, "utf8")) as {
      runs: { steps: Step[] };
    };
    assert.equal(caller.runs.steps[0].uses, "./.github/actions/setup-review-tools");
    assert.equal(
      caller.runs.steps[0].if,
      name === "setup-openclaw" ? "${{ env.CLAWSWEEPER_RUNNER == 'openclaw' }}" : undefined,
    );
  }
});

test("every scanner caller builds its canonical artifact descriptor before setup", () => {
  type Step = { uses?: string; with?: Record<string, string> };
  let callers = 0;
  for (const name of ["ci", "assist", "sweep"]) {
    const workflow = parse(readFileSync(`.github/workflows/${name}.yml`, "utf8")) as {
      jobs: Record<string, { steps?: Step[] }>;
    };
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      const steps = job.steps ?? [];
      for (let index = 0; index < steps.length; index++) {
        if (
          !["./.github/actions/setup-codex", "./.github/actions/setup-openclaw"].includes(
            steps[index].uses ?? "",
          )
        )
          continue;
        callers++;
        assert.ok(
          steps
            .slice(0, index)
            .some(
              (step) =>
                step.uses === "./.github/actions/setup-pnpm" &&
                ["build", "build:node", "build:all"].includes(step.with?.["build-script"] ?? ""),
            ),
          `${name}/${jobName} must build the descriptor before scanner setup`,
        );
      }
    }
  }
  assert.equal(callers, 8);
});

test(
  "hosted scanner archive proof is scoped after the existing build and fails closed on missing ancestry",
  { skip: process.platform === "win32" },
  () => {
    type Step = {
      id?: string;
      uses?: string;
      if?: string;
      run?: string;
      with?: Record<string, unknown>;
    };
    const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8")) as {
      permissions: Record<string, string>;
      jobs: { "check-fast": { steps: Step[] } };
    };
    assert.deepEqual(workflow.permissions, { contents: "read" });
    const steps = workflow.jobs["check-fast"].steps;
    assert.equal(steps[0].with?.["fetch-depth"], 2);
    const admission = steps.find((step) => step.id === "scanner-proof")!;
    const first = steps.find((step) => step.id === "scanner-first")!;
    const second = steps.find((step) => step.id === "scanner-second")!;
    assert.ok(
      steps.indexOf(admission) > steps.findIndex((step) => step.run === "pnpm run check:fast"),
    );
    assert.equal(admission.if, "github.event_name == 'pull_request'");
    for (const step of [first, second]) {
      assert.equal(step.uses, "./.github/actions/setup-review-tools");
      assert.equal(step.if, "steps.scanner-proof.outputs.run == 'true'");
    }
    const root = realpathSync(mkdtempSync(join(tmpdir(), "clawsweeper-archive-admission-")));
    try {
      const bin = join(root, "bin");
      mkdirSync(bin);
      for (const exit of [0, 1, 128]) {
        const output = join(root, `output-${exit}`);
        writeFileSync(
          join(bin, "git"),
          `#!/bin/sh\nprintf '%s\\n' "$@" > ${shell(join(root, "git-args"))}\nexit ${exit}\n`,
          { mode: 0o700 },
        );
        const result = spawnSync("/bin/bash", ["-e", "-o", "pipefail", "-c", admission.run!], {
          env: { PATH: `${bin}:/usr/bin:/bin`, GITHUB_OUTPUT: output },
          encoding: "utf8",
        });
        assert.equal(result.status === 0, exit !== 128, result.stderr);
        assert.equal(
          existsSync(output) ? readFileSync(output, "utf8") : "",
          exit === 1 ? "run=true\n" : "",
        );
        assert.deepEqual(readFileSync(join(root, "git-args"), "utf8").trim().split("\n"), [
          "diff",
          "--quiet",
          "HEAD^1",
          "HEAD",
          "--",
          ".github/actions/setup-review-tools",
          ".github/actions/setup-codex/action.yml",
          ".github/actions/setup-openclaw/action.yml",
          ".github/workflows/ci.yml",
          "src/review-tool-bootstrap.ts",
          "test/setup-review-tools-action.test.ts",
          "test/setup-codex-action.test.ts",
          "test/backlog-reliability-proof.test.ts",
        ]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
