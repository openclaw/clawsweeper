import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertTargetCheckoutBinding,
  canSkipInternalCodexReviewForRepairDelta,
  captureFinalTargetCheckoutBinding,
  captureTargetCheckoutBinding,
  classifyExternalBaseValidationFailure,
  completeTargetRebaseWithIsolation,
  compactTargetHistoryWithPlumbing,
  commitTargetCheckoutWithPlumbing,
  createTargetCheckpointWithPlumbing,
  materializeTargetCommitWithIsolation,
  preflightTargetValidationPlan,
  prepareTargetToolchain,
  rebaseTargetOntoVerifiedBase,
  repairDeltaValidationPlan,
  reproduceValidationFailureAtPinnedBase,
  requiredValidationCommands,
  runAllowedValidationCommands,
  selectWorkspacePackageManifests,
  switchTargetBranchWithPlumbing,
  workspacePackagePaths,
  workspacePatternMatches,
} from "../../dist/repair/target-validation.js";
import { compactText } from "../../dist/repair/text-utils.js";
import {
  __resetTargetRepoToolchainCache,
  resolveTargetRepoToolchain,
} from "../../dist/repair/target-toolchain-config.js";
import {
  packageManagerWorkspaceScoped,
  packageScriptRequirement,
  parseAllowedValidationCommand,
  requireWorkspaceMatchFailure,
  validationCommandForExecution,
} from "../../dist/repair/validation-command-utils.js";
import { mockCommandBinEnv } from "../helpers.ts";

const FAKE_TOOLCHAIN_TIMEOUT_MS = 15_000;

test("OpenClaw repairs require changed-surface validation even when omitted", () => {
  const cwd = packageFixture({ "check:changed": "node check.js" });
  const options = validationOptions("openclaw/openclaw");

  assert.deepEqual(requiredValidationCommands([], cwd, options), ["pnpm check:changed"]);
  assert.deepEqual(requiredValidationCommands(["pnpm test test/foo.test.ts"], cwd, options), [
    "pnpm test test/foo.test.ts",
    "pnpm check:changed",
  ]);
  assert.deepEqual(requiredValidationCommands(["pnpm check:changed"], cwd, options), [
    "pnpm check:changed",
  ]);
});

test("non-OpenClaw repairs do not get OpenClaw changed gate injection", () => {
  // The target repo's checkout happens to expose a `check:changed` script,
  // but the per-repo toolchain (resolved from config/target-repositories.json)
  // declares ClawHub as bun-based with `changed_gate: null`, so the executor
  // must NOT inject `pnpm check:changed`. It is fine — and expected — that
  // ClawHub's own declared validation commands (e.g. `bun run check`) appear;
  // the invariant under test here is purely "no pnpm check:changed leakage".
  const cwd = packageFixture({ "check:changed": "node check.js" });

  const resolved = requiredValidationCommands([], cwd, validationOptions("openclaw/clawhub"));
  assert.ok(
    !resolved.includes("pnpm check:changed"),
    `expected no pnpm check:changed leakage for non-OpenClaw repo, got ${JSON.stringify(resolved)}`,
  );
});

test("ClawSweeper repairs preserve their configured changed gate from the real config", () => {
  const cwd = packageFixture({ "check:changed": "node check.js" });

  __resetTargetRepoToolchainCache();
  try {
    assert.deepEqual(
      requiredValidationCommands(
        ["pnpm check:changed"],
        cwd,
        validationOptions("openclaw/clawsweeper"),
      ),
      ["pnpm check:changed"],
    );
  } finally {
    __resetTargetRepoToolchainCache();
  }
});

test("validation preflight reports injected OpenClaw changed gate", () => {
  const cwd = packageFixture({ "check:changed": "node check.js" });

  assert.deepEqual(
    preflightTargetValidationPlan(
      { fixArtifact: { validation_commands: [] }, targetDir: cwd },
      validationOptions("openclaw/openclaw"),
    ),
    {
      status: "passed",
      resolved_commands: ["pnpm check:changed"],
      available_scripts: ["check:changed"],
    },
  );
});

test("validation preflight blocks targets without any validation command", () => {
  const cwd = packageFixture({});

  assert.deepEqual(
    preflightTargetValidationPlan(
      { fixArtifact: { validation_commands: [] }, targetDir: cwd },
      validationOptions("steipete/example", {
        toolchain: {
          packageManager: "pnpm",
          baseValidationCommands: [],
          changedGate: null,
        },
      }),
    ),
    {
      status: "blocked",
      code: "validation_command_missing",
      available_scripts: [],
      resolved_commands: [],
      reason:
        "validation_command_missing: no configured or artifact validation command is available",
    },
  );
});

test("OpenClaw automerge repairs keep strict validation scoped to the repair command", () => {
  const cwd = packageFixture({
    "check:changed": "node check.js",
    "check:test-types": "node types.js",
    lint: "node lint.js",
  });
  const options = {
    ...validationOptions("openclaw/openclaw"),
    strictTargetValidation: true,
  };

  assert.deepEqual(requiredValidationCommands(["pnpm check:changed"], cwd, options), [
    "pnpm check:changed",
  ]);
  assert.deepEqual(
    preflightTargetValidationPlan(
      { fixArtifact: { validation_commands: ["pnpm check:changed"] }, targetDir: cwd },
      options,
    ),
    {
      status: "passed",
      resolved_commands: ["pnpm check:changed"],
      available_scripts: ["check:changed", "check:test-types", "lint"],
    },
  );
});

test("validation preflight accepts env-prefixed OpenClaw QA commands", () => {
  const cwd = packageFixture({ "check:changed": "node check.js" });

  assert.deepEqual(
    preflightTargetValidationPlan(
      {
        fixArtifact: {
          validation_commands: [
            "env QA_PARITY_CONCURRENCY=1 OPENCLAW_BUILD_PRIVATE_QA=1 OPENCLAW_ENABLE_PRIVATE_QA_CLI=1 OPENAI_API_KEY= ANTHROPIC_API_KEY= OPENCLAW_LIVE_OPENAI_KEY= OPENCLAW_LIVE_ANTHROPIC_KEY= OPENCLAW_LIVE_GEMINI_KEY= OPENCLAW_LIVE_SETUP_TOKEN_VALUE= pnpm openclaw qa suite --provider-mode mock-openai --parity-pack agentic --concurrency 1 --model ${OPENCLAW_CI_OPENAI_MODEL:-openai/gpt-5.6-sol} --alt-model example/model-alt --output-dir .artifacts/qa-e2e/gpt54",
          ],
        },
        targetDir: cwd,
      },
      validationOptions("openclaw/openclaw"),
    ),
    {
      status: "passed",
      resolved_commands: ["pnpm check:changed"],
      available_scripts: ["check:changed"],
    },
  );
});

test("validation preflight accepts assignment-prefixed OpenClaw test commands", () => {
  const cwd = packageFixture({ "check:changed": "node check.js" });

  assert.deepEqual(
    preflightTargetValidationPlan(
      {
        fixArtifact: {
          validation_commands: [
            "OPENCLAW_VITEST_FS_MODULE_CACHE_PATH=.vitest-cache-pairing pnpm test:serial src/pairing/pairing-store.test.ts",
          ],
        },
        targetDir: cwd,
      },
      validationOptions("openclaw/openclaw"),
    ),
    {
      status: "passed",
      resolved_commands: ["pnpm check:changed"],
      available_scripts: ["check:changed"],
    },
  );
});

test("validation preflight accepts leading env assignment commands", () => {
  const cwd = gitPackageFixture({ "test:serial": "node test.js" });
  fs.mkdirSync(path.join(cwd, "src", "pairing"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "pairing", "pairing-store.test.ts"), "");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  const command =
    "OPENCLAW_VITEST_FS_MODULE_CACHE_PATH=.vitest-cache-pairing pnpm test:serial src/pairing/pairing-store.test.ts";

  assert.deepEqual(
    preflightTargetValidationPlan(
      {
        fixArtifact: {
          validation_commands: [command],
        },
        targetDir: cwd,
      },
      {
        ...validationOptions("openclaw/openclaw"),
        skipOpenClawChangedGate: true,
      },
    ),
    {
      status: "passed",
      resolved_commands: [`env ${command}`],
      available_scripts: ["test:serial"],
    },
  );
});

test("validation preflight preserves direct Vitest commands without requiring a package script", () => {
  const cwd = gitPackageFixture({
    check: "node check.js",
    typecheck: "node typecheck.js",
  });
  fs.mkdirSync(path.join(cwd, "tests", "browser"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "tests", "browser", "pageActions.test.ts"), "");
  fs.writeFileSync(path.join(cwd, "tests", "browser", "ignored.test.ts"), "");
  fs.writeFileSync(path.join(cwd, "vitest.browser.config.ts"), "");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");

  assert.deepEqual(
    preflightTargetValidationPlan(
      {
        fixArtifact: {
          validation_commands: [
            "pnpm vitest run --passWithNoTests --coverage --config vitest.browser.config.ts --pool threads --exclude tests/browser/ignored.test.ts tests/browser/pageActions.test.ts",
            "pnpm run typecheck",
            "pnpm run check",
          ],
        },
        targetDir: cwd,
      },
      validationOptions("steipete/oracle", {
        toolchain: {
          packageManager: "pnpm",
          baseValidationCommands: [],
          changedGate: null,
        },
      }),
    ),
    {
      status: "passed",
      resolved_commands: [
        "pnpm exec vitest run --passWithNoTests --coverage --config vitest.browser.config.ts --pool threads --exclude tests/browser/ignored.test.ts tests/browser/pageActions.test.ts",
        "pnpm run typecheck",
        "pnpm run check",
      ],
      available_scripts: ["check", "typecheck"],
    },
  );
});

test("validation preflight preserves directory-scoped direct Vitest commands", () => {
  const cwd = gitPackageFixture({});
  fs.mkdirSync(path.join(cwd, "tests", "browser"), { recursive: true });
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");

  assert.deepEqual(
    preflightTargetValidationPlan(
      {
        fixArtifact: {
          validation_commands: ["pnpm vitest run tests/browser"],
        },
        targetDir: cwd,
      },
      validationOptions("steipete/oracle", {
        toolchain: {
          packageManager: "pnpm",
          baseValidationCommands: [],
          changedGate: null,
        },
      }),
    ),
    {
      status: "passed",
      resolved_commands: ["pnpm exec vitest run tests/browser"],
      available_scripts: [],
    },
  );
});

test("validation preflight blocks unscoped direct Vitest commands", () => {
  const cwd = packageFixture({});
  fs.writeFileSync(path.join(cwd, "vitest.browser.config.ts"), "");
  const options = validationOptions("steipete/oracle", {
    toolchain: {
      packageManager: "pnpm",
      baseValidationCommands: [],
      changedGate: null,
    },
  });

  for (const command of [
    "pnpm vitest run --config vitest.browser.config.ts",
    "pnpm exec vitest run --config vitest.browser.config.ts",
    "pnpm vitest run --exclude tests/browser/pageActions.test.ts",
    "pnpm vitest run login",
    "pnpm exec vitest run src",
  ]) {
    const result = preflightTargetValidationPlan(
      {
        fixArtifact: {
          validation_commands: [command],
        },
        targetDir: cwd,
      },
      options,
    );

    assert.equal(result.status, "blocked");
    assert.equal(result.code, "validation_script_missing");
    assert.equal(result.missing_script, "check:changed");
    assert.deepEqual(result.resolved_commands, ["pnpm check:changed"]);
  }
  for (const command of [
    "pnpm vitest run --update tests/browser/pageActions.test.ts",
    "pnpm vitest run -u tests/browser/pageActions.test.ts",
  ]) {
    assert.throws(
      () =>
        preflightTargetValidationPlan(
          { fixArtifact: { validation_commands: [command] }, targetDir: cwd },
          options,
        ),
      /unsafe validation command/,
    );
  }
});

test("validation preflight blocks direct Vitest commands with missing test paths", () => {
  const cwd = gitPackageFixture({});
  fs.writeFileSync(path.join(cwd, "vitest.browser.config.ts"), "");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  attachOrigin(cwd);

  for (const command of [
    "pnpm vitest run --config vitest.browser.config.ts tests/browser/deleted.test.ts",
    "pnpm exec vitest run --config vitest.browser.config.ts tests/browser/deleted.test.ts",
  ]) {
    const result = preflightTargetValidationPlan(
      {
        fixArtifact: {
          validation_commands: [command],
        },
        targetDir: cwd,
      },
      validationOptions("steipete/oracle", {
        toolchain: {
          packageManager: "pnpm",
          baseValidationCommands: [],
          changedGate: null,
        },
      }),
    );

    assert.equal(result.status, "blocked");
    assert.equal(result.code, "validation_script_missing");
    assert.equal(result.missing_script, "check:changed");
    assert.deepEqual(result.resolved_commands, ["pnpm check:changed"]);
  }
});

test("validation preflight blocks package test commands with missing directory paths", () => {
  const cwd = gitPackageFixture({ "test:serial": "node test.js" });
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  attachOrigin(cwd);

  const result = preflightTargetValidationPlan(
    {
      fixArtifact: {
        validation_commands: ["pnpm test:serial tests/deleted"],
      },
      targetDir: cwd,
    },
    validationOptions("steipete/oracle", {
      toolchain: {
        packageManager: "pnpm",
        baseValidationCommands: [],
        changedGate: null,
      },
    }),
  );

  assert.equal(result.status, "blocked");
  assert.equal(result.code, "validation_script_missing");
  assert.equal(result.missing_script, "check:changed");
  assert.deepEqual(result.resolved_commands, ["pnpm check:changed"]);
});

test("validation parser requires env assignments before env command", () => {
  assert.deepEqual(parseAllowedValidationCommand("FOO=1 pnpm test:serial src/foo.test.ts"), [
    "env",
    "FOO=1",
    "pnpm",
    "test:serial",
    "src/foo.test.ts",
  ]);
  assert.throws(
    () => parseAllowedValidationCommand("env pnpm test:serial src/foo.test.ts"),
    /unsupported validation command/,
  );
});

test("validation parser accepts common non-Node project commands", () => {
  assert.deepEqual(parseAllowedValidationCommand("make fmt"), ["make", "fmt"]);
  assert.deepEqual(parseAllowedValidationCommand("ansible-playbook playbook.yml --syntax-check"), [
    "ansible-playbook",
    "playbook.yml",
    "--syntax-check",
  ]);
  assert.deepEqual(parseAllowedValidationCommand("bash tests/run-tests.sh ubuntu2404"), [
    "bash",
    "tests/run-tests.sh",
    "ubuntu2404",
  ]);
  assert.deepEqual(parseAllowedValidationCommand("pnpm exec vitest run tests/browser"), [
    "pnpm",
    "exec",
    "vitest",
    "run",
    "tests/browser",
  ]);
  assert.deepEqual(parseAllowedValidationCommand("pnpm exec node --test test/example.test.ts"), [
    "pnpm",
    "exec",
    "node",
    "--test",
    "test/example.test.ts",
  ]);
  assert.deepEqual(parseAllowedValidationCommand('go test ./internal/cmd -run "TestA|TestB"'), [
    "go",
    "test",
    "./internal/cmd",
    "-run",
    "TestA|TestB",
  ]);
});

test("validation parser still rejects executable shell syntax", () => {
  assert.throws(() => parseAllowedValidationCommand("make fmt; make test"), /unsafe|unsupported/);
  assert.throws(
    () => parseAllowedValidationCommand("go test ./... | tee output"),
    /unsafe|unsupported/,
  );
  assert.throws(() => parseAllowedValidationCommand("make $(printf fmt)"), /unsafe|unsupported/);
  for (const command of [
    `bash -c 'make test'`,
    "bash /tmp/run-tests.sh",
    "bash ../run-tests.sh",
    "bash tests/../run-tests.sh",
  ]) {
    assert.throws(() => parseAllowedValidationCommand(command), /unsafe|unsupported/);
  }
});

test("validation parser rejects direct interpreter eval commands", () => {
  for (const command of [
    `node -e 'require("child_process").execFileSync("gh",["issue","edit","1"])'`,
    `bun --eval='Bun.spawnSync(["gh","issue","edit","1"])'`,
    `python3 -c 'import subprocess; subprocess.run(["gh", "issue", "edit", "1"])'`,
    `ruby -e 'system("gh", "issue", "edit", "1")'`,
    `php -r 'system("gh issue edit 1");'`,
    `swift -e 'print("inline")'`,
    `uv run python -c 'import subprocess; subprocess.run(["gh", "issue", "edit", "1"])'`,
    `npm exec -- node -e 'require("child_process").execFileSync("gh",["issue","edit","1"])'`,
    `pnpm exec node --eval='require("child_process").execFileSync("gh",["issue","edit","1"])'`,
    `bundle exec ruby -e 'system("gh", "issue", "edit", "1")'`,
    `pnpm exec sh -c 'gh issue edit 1 --add-label security'`,
    `uv run bash -c 'gh issue edit 1 --add-label security'`,
    `pnpm exec tsx -e 'console.log("inline")'`,
    `pnpm exec ts-node --eval='console.log("inline")'`,
    `pnpm dlx tsx --eval='console.log("inline")'`,
    `npm exec tsx -e 'console.log("inline")'`,
    `bun x tsx -e 'console.log("inline")'`,
    `pnpm exec gh issue edit 1 --add-label security`,
  ]) {
    assert.throws(() => parseAllowedValidationCommand(command), /unsafe validation command/);
  }
});

test("validation parser rejects Node and Bun preload or loader options", () => {
  for (const command of [
    "node --require ./hook.cjs --test test/example.test.ts",
    "node -r./hook.cjs --test test/example.test.ts",
    "node --import=./hook.mjs --test test/example.test.ts",
    "node --loader ./loader.mjs --test test/example.test.ts",
    "node --experimental-loader=./loader.mjs --test test/example.test.ts",
    "bun --preload ./hook.ts test test/example.test.ts",
    "bun -r./hook.ts test test/example.test.ts",
    "pnpm exec node --import ./hook.mjs --test test/example.test.ts",
    "pnpm exec bun --preload=./hook.ts test test/example.test.ts",
  ]) {
    assert.throws(() => parseAllowedValidationCommand(command), /unsafe validation command/);
  }
});

test("validation parser rejects mutating package, Git, formatter, and environment forms", () => {
  for (const command of [
    "npm i",
    "npm insta",
    "npm cit",
    "npm run install",
    "npm run audit --if-present",
    "npm --if-present run check",
    "npm --ignore-scripts=false run check",
    "npm --no-ignore-scripts run check",
    "npm --no-ignore-s run check",
    "npm run check --ignore-s=false",
    "npm run check --foreground-s",
    "pnpm i",
    "pnpm --filter app ln ../pkg",
    "pnpm c set ignore-scripts false",
    "pnpm rb",
    "pnpm rt use 24",
    "pnpm setup",
    "pnpm --filter app deploy",
    "pnpm --dir . test",
    "pnpm --config.ignore-scripts=false test",
    "pnpm run postinstall",
    "bun run install",
    "bun test -u test/example.test.ts",
    "pnpm lint --fix",
    "pnpm --filter app exec prettier -w /tmp/file.js",
    "ruff check --fix-only src",
    "pnpm format --write",
    "pnpm vitest run --update tests/example.test.ts",
    "pnpm exec vitest run -u tests/example.test.ts",
    "pnpm exec ava -u tests/example.test.ts",
    "git checkout main",
    "git fsck --lost-found",
    "cargo fmt",
    "go env -w GOFLAGS=-mod=readonly",
    "PATH=./bin pnpm check:changed",
    "HOME=/host pnpm check:changed",
    "USERPROFILE=C:\\host pnpm check:changed",
    "APPDATA=/host/appdata pnpm check:changed",
    "LOCALAPPDATA=/host/local pnpm check:changed",
    "XDG_CACHE_HOME=/host/cache pnpm check:changed",
    "XDG_CONFIG_HOME=/host/config pnpm check:changed",
    "XDG_DATA_HOME=/host/data pnpm check:changed",
    "XDG_RUNTIME_DIR=/host/runtime pnpm check:changed",
    "XDG_STATE_HOME=/host/state pnpm check:changed",
    "AWS_SHARED_CREDENTIALS_FILE=/host/aws pnpm check:changed",
    "GOOGLE_APPLICATION_CREDENTIALS=/host/google.json pnpm check:changed",
    "NODE_OPTIONS=--require=./hook.cjs node --test test/example.test.ts",
    "COREPACK_NPM_REGISTRY=https://registry.invalid pnpm check:changed",
    "npm_config_userconfig=./malicious.npmrc pnpm check:changed",
    "GIT_CONFIG_COUNT=1 git diff --check",
  ]) {
    assert.throws(() => parseAllowedValidationCommand(command), /unsafe validation command/);
  }

  assert.deepEqual(parseAllowedValidationCommand("pnpm format:check"), ["pnpm", "format:check"]);
  assert.deepEqual(parseAllowedValidationCommand("cargo fmt --check"), ["cargo", "fmt", "--check"]);
  assert.deepEqual(parseAllowedValidationCommand("git diff --check"), ["git", "diff", "--check"]);
  assert.deepEqual(parseAllowedValidationCommand("git status -u"), ["git", "status", "-u"]);
  assert.deepEqual(parseAllowedValidationCommand("npm --if-present=false run check"), [
    "npm",
    "--if-present=false",
    "run",
    "check",
  ]);
  assert.deepEqual(parseAllowedValidationCommand("CI=1 pnpm check:changed"), [
    "env",
    "CI=1",
    "pnpm",
    "check:changed",
  ]);
});

test("bun run workspace options are parsed before the script name", () => {
  assert.deepEqual(packageScriptRequirement(["bun", "run", "--filter", "app", "check"]), {
    name: "check",
    command: "bun run --filter app check",
    packageManager: "bun",
    workspaceAll: false,
    workspaceScoped: true,
    workspaceSelectors: ["app"],
  });
  assert.deepEqual(parseAllowedValidationCommand("bun run --filter app check"), [
    "bun",
    "run",
    "--filter",
    "app",
    "check",
  ]);
});

test("validation parser keeps script arguments after the package-manager separator", () => {
  assert.deepEqual(parseAllowedValidationCommand("npm run check -- --if-present"), [
    "npm",
    "run",
    "check",
    "--",
    "--if-present",
  ]);
});

test("validation parser rejects unsupported npm options after the script", () => {
  for (const command of [
    "npm run check --script-shell /tmp/runner",
    "npm run check --script-shell=/tmp/runner",
    "npm run check --cache /tmp/cache",
    "npm run check --prefix=/tmp/project",
    "npm run check --userconfig .npmrc",
    "npm run check --unknown-option value",
    "npm test --script-shell /tmp/runner",
  ]) {
    assert.throws(() => parseAllowedValidationCommand(command), /unsafe validation command/);
  }

  assert.deepEqual(parseAllowedValidationCommand("npm run check --workspace worker --silent"), [
    "npm",
    "run",
    "check",
    "--workspace",
    "worker",
    "--silent",
  ]);
  assert.deepEqual(parseAllowedValidationCommand("npm run check -- --script-shell /tmp/runner"), [
    "npm",
    "run",
    "check",
    "--",
    "--script-shell",
    "/tmp/runner",
  ]);
});

test("pnpm path normalization honors global options before the command", () => {
  const cwd = gitPackageFixture({ "check:changed": 'node -e ""' });
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  attachOrigin(cwd);

  assert.deepEqual(
    preflightTargetValidationPlan(
      {
        fixArtifact: {
          validation_commands: [
            "pnpm --offline exec vitest run missing/example.test.ts --passWithNoTests",
          ],
        },
        targetDir: cwd,
      },
      validationOptions("steipete/example", {
        toolchain: {
          packageManager: "pnpm",
          baseValidationCommands: [],
          changedGate: null,
        },
      }),
    ),
    {
      status: "passed",
      resolved_commands: ["pnpm check:changed"],
      available_scripts: ["check:changed"],
    },
  );
});

test("disabled pnpm workspace flags do not bypass test path normalization", () => {
  const cwd = gitPackageFixture({ "check:changed": 'node -e ""', test: 'node -e ""' });
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  attachOrigin(cwd);

  assert.equal(
    packageManagerWorkspaceScoped(
      parseAllowedValidationCommand("pnpm --recursive=false test ../outside.test.ts"),
    ),
    false,
  );
  assert.deepEqual(
    preflightTargetValidationPlan(
      {
        fixArtifact: {
          validation_commands: ["pnpm --recursive=false test ../outside.test.ts"],
        },
        targetDir: cwd,
      },
      validationOptions("steipete/example", {
        toolchain: {
          packageManager: "pnpm",
          baseValidationCommands: [],
          changedGate: null,
        },
      }),
    ),
    {
      status: "passed",
      resolved_commands: ["pnpm check:changed"],
      available_scripts: ["check:changed", "test"],
    },
  );
});

test("workspace-filtered test paths remain relative to the selected package", () => {
  const cwd = gitPackageFixture({});
  fs.mkdirSync(path.join(cwd, "packages", "worker", "test"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, "packages", "worker", "package.json"),
    `${JSON.stringify(
      {
        name: "@openclaw/worker",
        scripts: { test: "vitest run", "test:serial": "vitest run" },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(path.join(cwd, "packages", "worker", "test", "worker.test.ts"), "export {};\n");
  fs.writeFileSync(path.join(cwd, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  attachOrigin(cwd);
  const options = validationOptions("steipete/example", {
    toolchain: {
      packageManager: "pnpm",
      baseValidationCommands: [],
      changedGate: null,
    },
  });

  for (const command of [
    "pnpm --filter @openclaw/worker test test/worker.test.ts",
    "pnpm --filter @openclaw/worker test:serial test/worker.test.ts",
    "pnpm --filter @openclaw/worker exec vitest run test/worker.test.ts",
  ]) {
    const result = preflightTargetValidationPlan(
      { fixArtifact: { validation_commands: [command] }, targetDir: cwd },
      options,
    );
    assert.equal(result.status, "passed");
    assert.deepEqual(result.resolved_commands, [
      command.replace("pnpm ", "pnpm --fail-if-no-match "),
    ]);
  }
});

test("bun test is treated as the built-in runner instead of a package script", () => {
  const cwd = gitBunPackageFixture({});
  fs.mkdirSync(path.join(cwd, "test"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "test", "example.test.ts"), "");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");

  assert.deepEqual(
    preflightTargetValidationPlan(
      {
        fixArtifact: {
          validation_commands: ["bun test test/example.test.ts"],
        },
        targetDir: cwd,
      },
      validationOptions("steipete/example", {
        toolchain: {
          packageManager: "bun",
          baseValidationCommands: [],
          changedGate: null,
        },
      }),
    ),
    {
      status: "passed",
      resolved_commands: ["bun test test/example.test.ts"],
      available_scripts: [],
    },
  );
});

test("package validation execution suppresses lifecycle hooks", () => {
  assert.deepEqual(validationCommandForExecution(["npm", "run", "check"]), [
    "npm",
    "--ignore-scripts",
    "run",
    "check",
  ]);
  assert.deepEqual(validationCommandForExecution(["pnpm", "--filter", "app", "check"]), [
    "pnpm",
    "--config.enable-pre-post-scripts=false",
    "--fail-if-no-match",
    "--filter",
    "app",
    "check",
  ]);
  assert.deepEqual(validationCommandForExecution(["pnpm", "run", "--filter", "app", "check"]), [
    "pnpm",
    "--config.enable-pre-post-scripts=false",
    "--fail-if-no-match",
    "run",
    "--filter",
    "app",
    "check",
  ]);
  assert.throws(
    () => validationCommandForExecution(["npm", "--ignore-scripts=false", "run", "check"]),
    /lifecycle suppression is overridden/,
  );
  assert.throws(
    () => validationCommandForExecution(["npm", "run", "check", "--ignore-s=false"]),
    /lifecycle suppression is overridden/,
  );
  assert.throws(
    () => validationCommandForExecution(["npm", "run", "check", "--no-ignore-scripts"]),
    /lifecycle suppression is overridden/,
  );
  assert.deepEqual(
    validationCommandForExecution([
      "npm",
      "--ignore-scripts=false",
      "--ignore-scripts=true",
      "run",
      "check",
    ]),
    ["npm", "--ignore-scripts=false", "--ignore-scripts=true", "run", "check"],
  );
  assert.throws(
    () =>
      validationCommandForExecution([
        "npm",
        "--ignore-scripts=true",
        "--ignore-scripts=false",
        "run",
        "check",
      ]),
    /lifecycle suppression is overridden/,
  );
  assert.deepEqual(
    validationCommandForExecution([
      "npm",
      "--foreground-scripts=true",
      "--foreground-scripts=false",
      "run",
      "check",
    ]),
    [
      "npm",
      "--ignore-scripts",
      "--foreground-scripts=true",
      "--foreground-scripts=false",
      "run",
      "check",
    ],
  );
  assert.throws(
    () =>
      validationCommandForExecution([
        "npm",
        "--foreground-scripts=false",
        "--foreground-scripts=true",
        "run",
        "check",
      ]),
    /lifecycle suppression is overridden/,
  );
  assert.deepEqual(
    validationCommandForExecution(["npm", "--no-ignore-scripts=false", "run", "check"]),
    ["npm", "--no-ignore-scripts=false", "run", "check"],
  );
  assert.deepEqual(
    requireWorkspaceMatchFailure(["env", "CI=1", "pnpm", "--filter", "app", "check"]),
    ["env", "CI=1", "pnpm", "--fail-if-no-match", "--filter", "app", "check"],
  );
  assert.deepEqual(
    requireWorkspaceMatchFailure(["pnpm", "--fail-if-no-match=false", "--filter", "app", "check"]),
    ["pnpm", "--fail-if-no-match", "--filter", "app", "check"],
  );
});

test("Bun validation rejects selected pre and post lifecycle hooks", () => {
  for (const hook of ["precheck", "postcheck"]) {
    const cwd = gitBunPackageFixture({
      [hook]: "node hook.js",
      check: "node check.js",
    });
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "initial");
    attachOrigin(cwd);
    const command = "bun run check";
    const options = validationOptions("steipete/example", {
      toolchain: {
        packageManager: "bun",
        baseValidationCommands: [],
        changedGate: null,
      },
    });

    assert.deepEqual(
      preflightTargetValidationPlan(
        { fixArtifact: { validation_commands: [command] }, targetDir: cwd },
        options,
      ),
      {
        status: "blocked",
        code: "validation_script_unsafe",
        required: "bun run check",
        unsafe_hook: hook,
        available_scripts: ["check", hook].sort(),
        resolved_commands: ["bun run check"],
        reason: `validation_script_unsafe: Bun would execute ${hook} around bun run check`,
      },
    );
    assert.throws(
      () => runAllowedValidationCommands([command], cwd, options),
      new RegExp(`Bun would execute ${hook}`),
    );
  }
});

test("Bun validation fails closed when lifecycle hook inspection is inconclusive", () => {
  const options = validationOptions("steipete/example", {
    toolchain: {
      packageManager: "bun",
      baseValidationCommands: [],
      changedGate: null,
    },
  });
  const fixtures = [
    () => {
      const cwd = gitBunPackageFixture({ check: "node check.js" });
      fs.writeFileSync(path.join(cwd, "package.json"), "{");
      return { command: "bun run check", cwd };
    },
    () => {
      const cwd = gitBunPackageFixture({});
      fs.writeFileSync(
        path.join(cwd, "package.json"),
        `${JSON.stringify(
          {
            packageManager: "bun@1.1.0",
            workspaces: ["packages/*"],
          },
          null,
          2,
        )}\n`,
      );
      fs.mkdirSync(path.join(cwd, "packages", "worker"), { recursive: true });
      fs.symlinkSync(
        path.relative(path.join(cwd, "packages", "worker"), path.join(cwd, "package.json")),
        path.join(cwd, "packages", "worker", "package.json"),
      );
      return { command: "bun run --filter worker check", cwd };
    },
    () => {
      const cwd = gitBunPackageFixture({});
      fs.writeFileSync(
        path.join(cwd, "package.json"),
        `${JSON.stringify(
          {
            packageManager: "bun@1.1.0",
            workspaces: ["packages/*"],
          },
          null,
          2,
        )}\n`,
      );
      fs.mkdirSync(path.join(cwd, "packages", "worker"), { recursive: true });
      fs.writeFileSync(
        path.join(cwd, "packages", "worker", "package.json"),
        `${JSON.stringify({ name: "worker", scripts: { check: "node check.js" } })}\n`,
      );
      return { command: "bun run --filter ...worker check", cwd };
    },
  ];

  for (const createFixture of fixtures) {
    const { command, cwd } = createFixture();
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "initial");
    attachOrigin(cwd);

    const preflight = preflightTargetValidationPlan(
      { fixArtifact: { validation_commands: [command] }, targetDir: cwd },
      options,
    );
    assert.equal(preflight.status, "blocked");
    assert.equal(preflight.code, "validation_script_unsafe");
    assert.match(preflight.reason, /lifecycle hook inspection was inconclusive/);
    assert.throws(
      () => runAllowedValidationCommands([command], cwd, options),
      /lifecycle hook inspection was inconclusive/,
    );
  }
});

test("implicit pnpm script names preserve package.json case", () => {
  const cwd = packageFixture({ Check: "node --test", Install: "node --test" });
  const options = validationOptions("steipete/example", {
    toolchain: {
      packageManager: "pnpm",
      baseValidationCommands: [],
      changedGate: null,
    },
  });

  assert.equal(packageScriptRequirement(["pnpm", "Check"])?.name, "Check");
  assert.equal(
    preflightTargetValidationPlan(
      { fixArtifact: { validation_commands: ["pnpm Check"] }, targetDir: cwd },
      options,
    ).status,
    "passed",
  );
  assert.equal(
    preflightTargetValidationPlan(
      { fixArtifact: { validation_commands: ["pnpm Install"] }, targetDir: cwd },
      options,
    ).status,
    "passed",
  );
  const mismatched = preflightTargetValidationPlan(
    { fixArtifact: { validation_commands: ["pnpm check"] }, targetDir: cwd },
    options,
  );
  assert.equal(mismatched.status, "blocked");
});

test("filtered pnpm validation fails when no workspace matches", () => {
  const cwd = gitPackageFixture({ check: "node --test" });
  fs.writeFileSync(path.join(cwd, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  attachOrigin(cwd);
  const options = validationOptions("steipete/example", {
    toolchain: {
      packageManager: "pnpm",
      baseValidationCommands: [],
      changedGate: null,
    },
  });
  const command = "pnpm --fail-if-no-match=false --filter __clawsweeper_no_such_workspace__ check";
  assert.deepEqual(
    preflightTargetValidationPlan(
      { fixArtifact: { validation_commands: [command] }, targetDir: cwd },
      options,
    ),
    {
      status: "passed",
      resolved_commands: [
        "pnpm --fail-if-no-match --filter __clawsweeper_no_such_workspace__ check",
      ],
      available_scripts: ["check"],
    },
  );

  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-pnpm-filter-"));
  const pnpmPath = path.join(binDir, "pnpm.js");
  const logPath = path.join(binDir, "pnpm.log");
  fs.writeFileSync(
    pnpmPath,
    `const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(logPath)}, args.join(" "));
if (args.includes("--fail-if-no-match")) {
  console.error("No projects matched the filters");
  process.exit(1);
}
`,
  );

  assert.throws(
    () =>
      withMockCommand("pnpm", pnpmPath, () =>
        runAllowedValidationCommands([command], cwd, options),
      ),
    /No projects matched the filters/,
  );
  assert.equal(
    fs.readFileSync(logPath, "utf8"),
    "--config.enable-pre-post-scripts=false --fail-if-no-match --filter __clawsweeper_no_such_workspace__ check",
  );
});

test("filtered Bun validation fails preflight when no workspace matches", () => {
  const cwd = bunPackageFixture({ check: "node --test" });
  fs.mkdirSync(path.join(cwd, "packages", "app"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, "packages", "app", "package.json"),
    `${JSON.stringify({ name: "app", scripts: { check: "node --test" } }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(cwd, "package.json"),
    `${JSON.stringify(
      {
        scripts: { check: "node --test" },
        packageManager: "bun@1.1.0",
        workspaces: ["packages/*"],
      },
      null,
      2,
    )}\n`,
  );

  const result = preflightTargetValidationPlan(
    {
      fixArtifact: {
        validation_commands: ["bun run --filter __clawsweeper_no_such_workspace__ check"],
      },
      targetDir: cwd,
    },
    validationOptions("steipete/example", {
      toolchain: {
        packageManager: "bun",
        baseValidationCommands: [],
        changedGate: null,
      },
    }),
  );

  assert.equal(result.status, "blocked");
  assert.equal(result.code, "validation_script_missing");
  assert.equal(result.missing_script, "check");
});

test("workspace-scoped validation resolves scripts from the selected package", () => {
  const cwd = packageFixture({});
  fs.mkdirSync(path.join(cwd, "packages", "worker"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, "packages", "worker", "package.json"),
    `${JSON.stringify({ name: "@openclaw/worker", scripts: { check: "node --test" } }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(cwd, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");

  assert.deepEqual(
    preflightTargetValidationPlan(
      {
        fixArtifact: {
          validation_commands: ["pnpm --filter @openclaw/worker check"],
        },
        targetDir: cwd,
      },
      validationOptions("steipete/example", {
        toolchain: {
          packageManager: "pnpm",
          baseValidationCommands: [],
          changedGate: null,
        },
      }),
    ),
    {
      status: "passed",
      resolved_commands: ["pnpm --fail-if-no-match --filter @openclaw/worker check"],
      available_scripts: [],
    },
  );
});

test("pnpm workspace scope ignores package.json workspaces without pnpm-workspace.yaml", () => {
  const cwd = packageFixture({});
  fs.mkdirSync(path.join(cwd, "packages", "worker"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, "packages", "worker", "package.json"),
    `${JSON.stringify({ name: "@openclaw/worker", scripts: { check: "node --test" } }, null, 2)}\n`,
  );
  const packagePath = path.join(cwd, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  packageJson.workspaces = ["packages/*"];
  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

  const result = preflightTargetValidationPlan(
    {
      fixArtifact: {
        validation_commands: ["pnpm --filter @openclaw/worker check"],
      },
      targetDir: cwd,
    },
    validationOptions("steipete/example", {
      toolchain: {
        packageManager: "pnpm",
        baseValidationCommands: [],
        changedGate: null,
      },
    }),
  );

  assert.equal(result.status, "blocked");
  assert.equal(result.code, "validation_script_missing");
});

test("workspace-scoped validation blocks a matched package without the requested script", () => {
  const cwd = packageFixture({});
  fs.mkdirSync(path.join(cwd, "packages", "worker"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, "packages", "worker", "package.json"),
    `${JSON.stringify({ name: "@openclaw/worker", scripts: { lint: "node --test" } }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(cwd, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");

  const result = preflightTargetValidationPlan(
    {
      fixArtifact: {
        validation_commands: ["pnpm --filter @openclaw/worker check"],
      },
      targetDir: cwd,
    },
    validationOptions("steipete/example", {
      toolchain: {
        packageManager: "pnpm",
        baseValidationCommands: [],
        changedGate: null,
      },
    }),
  );

  assert.equal(result.status, "blocked");
  assert.equal(result.code, "validation_script_missing");
  assert.equal(result.missing_script, "check");
});

test("workspace-scoped validation fails closed on unsafe workspace discovery", () => {
  const cwd = packageFixture({});
  fs.writeFileSync(path.join(cwd, "pnpm-workspace.yaml"), "packages:\n  - ../outside\n");

  const result = preflightTargetValidationPlan(
    {
      fixArtifact: {
        validation_commands: ["pnpm --filter outside check"],
      },
      targetDir: cwd,
    },
    validationOptions("steipete/example", {
      toolchain: {
        packageManager: "pnpm",
        baseValidationCommands: [],
        changedGate: null,
      },
    }),
  );

  assert.equal(result.status, "blocked");
  assert.equal(result.code, "validation_script_missing");
});

test("workspace-scoped validation parses npm run options after the script", () => {
  const cwd = packageFixture({});
  fs.mkdirSync(path.join(cwd, "packages", "worker"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, "packages", "worker", "package.json"),
    `${JSON.stringify({ name: "worker", scripts: { check: "node --test" } }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(cwd, "package.json"),
    `${JSON.stringify({ packageManager: "npm@11.0.0", workspaces: ["packages/*"] }, null, 2)}\n`,
  );

  assert.equal(
    preflightTargetValidationPlan(
      {
        fixArtifact: {
          validation_commands: ["npm run check --workspace worker"],
        },
        targetDir: cwd,
      },
      validationOptions("steipete/example", {
        toolchain: {
          packageManager: "npm",
          baseValidationCommands: [],
          changedGate: null,
        },
      }),
    ).status,
    "passed",
  );
});

test("npm all-workspace shorthand works globally and around the run script", () => {
  const cwd = packageFixture({});
  fs.mkdirSync(path.join(cwd, "packages", "worker"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, "packages", "worker", "package.json"),
    `${JSON.stringify({ name: "worker", scripts: { check: "node --test" } }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(cwd, "package.json"),
    `${JSON.stringify({ packageManager: "npm@11.0.0", workspaces: ["packages/*"] }, null, 2)}\n`,
  );
  const options = validationOptions("steipete/example", {
    toolchain: {
      packageManager: "npm",
      baseValidationCommands: [],
      changedGate: null,
    },
  });

  for (const command of ["npm --ws run check", "npm run --ws check", "npm run check --ws"]) {
    assert.equal(
      preflightTargetValidationPlan(
        { fixArtifact: { validation_commands: [command] }, targetDir: cwd },
        options,
      ).status,
      "passed",
    );
  }
  assert.deepEqual(packageScriptRequirement(parseAllowedValidationCommand("npm --ws=false test")), {
    name: "test",
    command: "npm --ws=false test",
    packageManager: "npm",
    workspaceAll: false,
    workspaceScoped: false,
    workspaceSelectors: [],
  });
});

test("npm workspace booleans use the final option value", () => {
  assert.deepEqual(
    packageScriptRequirement(
      parseAllowedValidationCommand("npm --workspaces --workspaces=false run check"),
    ),
    {
      name: "check",
      command: "npm --workspaces --workspaces=false run check",
      packageManager: "npm",
      workspaceAll: false,
      workspaceScoped: false,
      workspaceSelectors: [],
    },
  );
  assert.deepEqual(
    packageScriptRequirement(
      parseAllowedValidationCommand("npm --workspaces=false run --ws check"),
    ),
    {
      name: "check",
      command: "npm --workspaces=false run --ws check",
      packageManager: "npm",
      workspaceAll: true,
      workspaceScoped: true,
      workspaceSelectors: [],
    },
  );
});

test("npm all-workspace validation requires every selected package script", () => {
  const cwd = packageFixture({});
  fs.mkdirSync(path.join(cwd, "packages", "worker"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "packages", "web"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, "packages", "worker", "package.json"),
    `${JSON.stringify({ name: "worker", scripts: { check: "node --test" } }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(cwd, "packages", "web", "package.json"),
    `${JSON.stringify({ name: "web", scripts: { lint: "node --test" } }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(cwd, "package.json"),
    `${JSON.stringify({ packageManager: "npm@11.0.0", workspaces: ["packages/*"] }, null, 2)}\n`,
  );
  const result = preflightTargetValidationPlan(
    { fixArtifact: { validation_commands: ["npm run check --workspaces"] }, targetDir: cwd },
    validationOptions("steipete/example", {
      toolchain: {
        packageManager: "npm",
        baseValidationCommands: [],
        changedGate: null,
      },
    }),
  );

  assert.equal(result.status, "blocked");
  assert.equal(result.code, "validation_script_missing");
  assert.equal(result.missing_script, "check");
});

test("workspace-scoped validation parses npm test shorthand options", () => {
  const cwd = packageFixture({});
  fs.mkdirSync(path.join(cwd, "packages", "worker"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, "packages", "worker", "package.json"),
    `${JSON.stringify({ name: "worker", scripts: { test: "node --test" } }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(cwd, "package.json"),
    `${JSON.stringify({ packageManager: "npm@11.0.0", workspaces: ["packages/*"] }, null, 2)}\n`,
  );
  const options = validationOptions("steipete/example", {
    toolchain: {
      packageManager: "npm",
      baseValidationCommands: [],
      changedGate: null,
    },
  });

  for (const command of [
    "npm test --workspace worker",
    "npm t --workspace=worker",
    "npm tst --workspace=worker",
  ]) {
    assert.equal(
      preflightTargetValidationPlan(
        { fixArtifact: { validation_commands: [command] }, targetDir: cwd },
        options,
      ).status,
      "passed",
    );
  }
});

test("pnpm test shorthands validate the test script they execute", () => {
  const cwd = packageFixture({ test: "node --test" });
  const options = validationOptions("steipete/example", {
    toolchain: {
      packageManager: "pnpm",
      baseValidationCommands: [],
      changedGate: null,
    },
  });

  for (const command of ["pnpm t", "pnpm tst"]) {
    assert.equal(
      preflightTargetValidationPlan(
        { fixArtifact: { validation_commands: [command] }, targetDir: cwd },
        options,
      ).status,
      "passed",
    );
  }
});

test("workspace-scoped validation rejects empty recursive proof", () => {
  const cwd = packageFixture({ check: "node --test" });
  fs.writeFileSync(path.join(cwd, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");

  const result = preflightTargetValidationPlan(
    {
      fixArtifact: {
        validation_commands: ["pnpm --recursive=true check"],
      },
      targetDir: cwd,
    },
    validationOptions("steipete/example", {
      toolchain: {
        packageManager: "pnpm",
        baseValidationCommands: [],
        changedGate: null,
      },
    }),
  );

  assert.equal(result.status, "blocked");
  assert.equal(result.code, "validation_script_missing");
});

test("workspace selector values do not alias boolean false", () => {
  const cwd = packageFixture({});
  fs.mkdirSync(path.join(cwd, "packages", "false"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, "packages", "false", "package.json"),
    `${JSON.stringify({ name: "false", scripts: { check: "node --test" } }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(cwd, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");

  assert.equal(
    preflightTargetValidationPlan(
      {
        fixArtifact: {
          validation_commands: ["pnpm --filter false check"],
        },
        targetDir: cwd,
      },
      validationOptions("steipete/example", {
        toolchain: {
          packageManager: "pnpm",
          baseValidationCommands: [],
          changedGate: null,
        },
      }),
    ).status,
    "passed",
  );
});

test("workspace discovery enforces pattern and traversal budgets", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workspace-budget-"));
  for (const relativePath of ["packages/app", "packages/web", "packages/deep/child"]) {
    fs.mkdirSync(path.join(cwd, relativePath), { recursive: true });
    fs.writeFileSync(path.join(cwd, relativePath, "package.json"), "{}\n");
  }
  fs.writeFileSync(path.join(cwd, "one.txt"), "1\n");
  fs.writeFileSync(path.join(cwd, "two.txt"), "2\n");

  assert.deepEqual(workspacePackagePaths(cwd, ["packages/{app,web}"]), [
    "packages/app",
    "packages/web",
  ]);
  assert.deepEqual(workspacePackagePaths(cwd, ["packages/**", "!packages/deep/**"]), [
    "packages/app",
    "packages/web",
  ]);
  assert.throws(
    () => workspacePackagePaths(cwd, ["packages/**"], { maxDirectories: 2 }),
    /directory budget/,
  );
  assert.throws(() => workspacePackagePaths(cwd, ["packages/**"], { maxDepth: 2 }), /depth budget/);
  assert.throws(
    () => workspacePackagePaths(cwd, ["packages/**"], { maxEntries: 2 }),
    /entry budget/,
  );
  assert.throws(
    () =>
      workspacePackagePaths(cwd, ["packages/nope", "packages/**"], {
        maxMatchOperations: 1,
      }),
    /glob evaluation.*work budget/,
  );
  assert.throws(
    () =>
      workspacePackagePaths(
        cwd,
        Array.from({ length: 257 }, () => "packages/*"),
      ),
    /pattern count/,
  );
  assert.throws(
    () => workspacePackagePaths(cwd, [`packages/${"*a".repeat(129)}`]),
    /operator budget/,
  );
});

test("workspace discovery enforces a synchronous deadline", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workspace-deadline-"));
  for (let index = 0; index < 500; index += 1) {
    fs.mkdirSync(path.join(cwd, "packages", `package-${index}`), { recursive: true });
  }

  assert.throws(
    () => workspacePackagePaths(cwd, ["packages/**"], { timeoutMs: 1 }),
    /supported deadline/,
  );
});

test(
  "workspace preflight rejects non-regular package metadata without blocking",
  { skip: process.platform === "win32" },
  () => {
    const cwd = packageFixture({});
    fs.mkdirSync(path.join(cwd, "packages", "worker"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      `${JSON.stringify({ packageManager: "npm@11.0.0", workspaces: ["packages/*"] }, null, 2)}\n`,
    );
    execFileSync("mkfifo", [path.join(cwd, "packages", "worker", "package.json")]);
    const startedAt = Date.now();
    const result = preflightTargetValidationPlan(
      {
        fixArtifact: {
          validation_commands: ["npm --ws run check"],
        },
        targetDir: cwd,
      },
      validationOptions("steipete/example", {
        toolchain: {
          packageManager: "npm",
          baseValidationCommands: [],
          changedGate: null,
        },
      }),
    );

    assert.equal(result.status, "blocked");
    assert.ok(Date.now() - startedAt < 1_000, "FIFO metadata preflight must fail promptly");
  },
);

test("workspace wildcard and selector inputs are bounded", () => {
  assert.equal(workspacePatternMatches("packages/test-?", "packages/test-a"), true);
  assert.equal(workspacePatternMatches("packages/**/test-*", "packages/a/b/test-unit"), true);
  assert.equal(workspacePatternMatches("packages/*", "packages/a/b"), false);
  assert.throws(
    () => workspacePatternMatches(`${"*a".repeat(129)}b`, "a".repeat(129)),
    /operator budget/,
  );
  assert.equal(
    selectWorkspacePackageManifests(
      [
        { name: null, relativeDir: ".", scriptCommands: new Map(), scripts: new Set() },
        {
          name: "worker",
          relativeDir: "packages/worker",
          scriptCommands: new Map([["check", "node --test"]]),
          scripts: new Set(["check"]),
        },
      ],
      ["missing", "worker"],
      false,
      { maxMatchOperations: 1 },
    ),
    null,
  );

  const cwd = packageFixture({});
  fs.mkdirSync(path.join(cwd, "packages", "worker"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, "packages", "worker", "package.json"),
    `${JSON.stringify({ name: "worker", scripts: { check: "node --test" } }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(cwd, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  const options = validationOptions("steipete/example", {
    toolchain: {
      packageManager: "pnpm",
      baseValidationCommands: [],
      changedGate: null,
    },
  });
  for (const command of [
    `pnpm --filter '${"*a".repeat(129)}' check`,
    `pnpm ${Array.from({ length: 257 }, (_, index) => `--filter missing-${index}`).join(" ")} check`,
  ]) {
    assert.equal(
      preflightTargetValidationPlan(
        { fixArtifact: { validation_commands: [command] }, targetDir: cwd },
        options,
      ).status,
      "blocked",
    );
  }
});

test("pnpm documented dependency and changed-since selectors defer to bounded runtime matching", () => {
  const cwd = packageFixture({});
  for (const [directory, name] of [
    ["packages/foo", "foo"],
    ["packages/bar", "bar"],
  ]) {
    fs.mkdirSync(path.join(cwd, directory), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, directory, "package.json"),
      `${JSON.stringify({ name, scripts: { check: "node --test" } }, null, 2)}\n`,
    );
  }
  fs.writeFileSync(path.join(cwd, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  const options = validationOptions("steipete/example", {
    toolchain: {
      packageManager: "pnpm",
      baseValidationCommands: [],
      changedGate: null,
    },
  });
  for (const selector of [
    "foo...",
    "foo^...",
    "...foo",
    "...^foo",
    "[origin/main]",
    "...[origin/main]",
    "{packages/**}[origin/main]...",
    "...{packages/**}[origin/main]...",
  ]) {
    const command = `pnpm --filter '${selector}' check`;
    const result = preflightTargetValidationPlan(
      { fixArtifact: { validation_commands: [command] }, targetDir: cwd },
      options,
    );
    assert.equal(result.status, "passed", selector);
    assert.deepEqual(result.resolved_commands, [
      `pnpm --fail-if-no-match --filter ${selector} check`,
    ]);
  }

  const manifests = [
    { name: null, relativeDir: ".", scriptCommands: new Map(), scripts: new Set() },
    {
      name: "foo",
      relativeDir: "packages/foo",
      scriptCommands: new Map([["check", "node --test"]]),
      scripts: new Set(["check"]),
    },
  ];
  for (const selector of ["...", "foo....", "foo[origin/main][other]", "foo[origin main]"]) {
    assert.equal(selectWorkspacePackageManifests(manifests, [selector], false), null);
  }
});

test("validation preflight accepts scoped OpenGrep commands", () => {
  const cwd = packageFixture({ "check:changed": "node check.js" });
  const command =
    "scripts/run-opengrep.sh --error -- src/infra/net/http-connect-tunnel.ts src/infra/push-apns-http2.ts src/infra/push-apns.ts";

  assert.deepEqual(parseAllowedValidationCommand(command), [
    "scripts/run-opengrep.sh",
    "--error",
    "--",
    "src/infra/net/http-connect-tunnel.ts",
    "src/infra/push-apns-http2.ts",
    "src/infra/push-apns.ts",
  ]);
  assert.deepEqual(
    preflightTargetValidationPlan(
      {
        fixArtifact: {
          validation_commands: [command],
        },
        targetDir: cwd,
      },
      validationOptions("openclaw/openclaw"),
    ),
    {
      status: "passed",
      resolved_commands: ["pnpm check:changed"],
      available_scripts: ["check:changed"],
    },
  );
});

test("validation preflight preserves scoped git diff checks", () => {
  const cwd = packageFixture({ "check:changed": "node check.js" });
  const sourceHead = "0123456789abcdef0123456789abcdef01234567";

  assert.deepEqual(
    preflightTargetValidationPlan(
      {
        fixArtifact: {
          validation_commands: [`git diff --check ${sourceHead}..HEAD`],
        },
        targetDir: cwd,
      },
      {
        ...validationOptions("openclaw/openclaw"),
        skipOpenClawChangedGate: true,
      },
    ),
    {
      status: "passed",
      resolved_commands: [`git diff --check ${sourceHead}..HEAD`],
      available_scripts: ["check:changed"],
    },
  );
});

test("adopted OpenClaw PR repairs validate changelog-only repair deltas without full changed gate", () => {
  const cwd = gitPackageFixture({ "check:changed": "node check.js" });
  fs.writeFileSync(path.join(cwd, "CHANGELOG.md"), "# Changelog\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  const sourceHead = git(cwd, "rev-parse", "HEAD");

  fs.appendFileSync(path.join(cwd, "CHANGELOG.md"), "\n- Fix the Codex plugin bridge.\n");
  git(cwd, "add", "CHANGELOG.md");
  git(cwd, "commit", "-m", "add changelog");

  const plan = repairDeltaValidationPlan(
    {
      fixArtifact: {
        repair_strategy: "repair_contributor_branch",
        validation_commands: ["pnpm check:changed"],
      },
      targetDir: cwd,
      sourceHead,
    },
    validationOptions("openclaw/openclaw"),
  );

  assert.equal(plan.scope, "repair-delta-docs");
  assert.deepEqual(plan.changed_files, ["CHANGELOG.md"]);
  assert.deepEqual(plan.commands, [`git diff --check ${sourceHead}..HEAD`]);
  assert.deepEqual(requiredValidationCommands(plan.commands, cwd, plan.options), [
    `git diff --check ${sourceHead}..HEAD`,
  ]);
  assert.equal(canSkipInternalCodexReviewForRepairDelta(plan), true);
});

test("adopted OpenClaw PR repairs keep full changed gate for code repair deltas", () => {
  const cwd = gitPackageFixture({ "check:changed": "node check.js" });
  fs.mkdirSync(path.join(cwd, "src"));
  fs.writeFileSync(path.join(cwd, "src/index.ts"), "export const value = 1;\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  const sourceHead = git(cwd, "rev-parse", "HEAD");

  fs.writeFileSync(path.join(cwd, "src/index.ts"), "export const value = 2;\n");
  git(cwd, "add", "src/index.ts");
  git(cwd, "commit", "-m", "repair code");

  const plan = repairDeltaValidationPlan(
    {
      fixArtifact: {
        repair_strategy: "repair_contributor_branch",
        validation_commands: ["pnpm test src/index.test.ts"],
      },
      targetDir: cwd,
      sourceHead,
    },
    validationOptions("openclaw/openclaw"),
  );

  assert.equal(plan.scope, "changed-surface");
  assert.deepEqual(plan.changed_files, ["src/index.ts"]);
  assert.deepEqual(requiredValidationCommands(plan.commands, cwd, plan.options), [
    "pnpm test src/index.test.ts",
    "pnpm check:changed",
  ]);
  assert.equal(canSkipInternalCodexReviewForRepairDelta(plan), false);
});

test("base-identical validation failures outside the repair delta are external blockers", () => {
  const cwd = gitPackageFixture({ "check:changed": "node check.js" });
  fs.mkdirSync(path.join(cwd, "src"));
  fs.writeFileSync(path.join(cwd, "src/base.ts"), "export const base = true;\n");
  fs.writeFileSync(path.join(cwd, "src/repair.ts"), "export const value = 1;\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "base");
  const pinnedBaseRef = git(cwd, "rev-parse", "HEAD");

  fs.writeFileSync(path.join(cwd, "src/repair.ts"), "export const value = 2;\n");
  git(cwd, "add", "src/repair.ts");
  git(cwd, "commit", "-m", "source change");
  const repairBaseRef = git(cwd, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(cwd, "src/repair.ts"), "export const value = 3;\n");
  git(cwd, "add", "src/repair.ts");
  git(cwd, "commit", "-m", "repair change");

  assert.deepEqual(
    classifyExternalBaseValidationFailure({
      targetDir: cwd,
      pinnedBaseRef,
      repairBaseRef,
      error: new Error(`${path.join(cwd, "src/base.ts")}:1: lint failed`),
      baseError: new Error(`${path.join(cwd, "src/base.ts")}:1: lint failed`),
    }),
    {
      paths: ["src/base.ts"],
      reason: "validation failed only in base-identical files outside the repair delta",
    },
  );
  assert.deepEqual(
    classifyExternalBaseValidationFailure({
      targetDir: cwd,
      pinnedBaseRef,
      repairBaseRef,
      error: new Error("package.json:1: configuration lint failed"),
      baseError: new Error("package.json:1: configuration lint failed"),
    })?.paths,
    ["package.json"],
  );
  assert.equal(
    classifyExternalBaseValidationFailure({
      targetDir: cwd,
      pinnedBaseRef,
      repairBaseRef,
      error: new Error("src/base.ts:1: newly introduced type error"),
      baseError: new Error("src/base.ts:1: pre-existing lint error"),
    }),
    null,
  );
});

test("validation failures in repair-changed files remain repair scope", () => {
  const cwd = gitPackageFixture({ "check:changed": "node check.js" });
  fs.mkdirSync(path.join(cwd, "src"));
  fs.writeFileSync(path.join(cwd, "src/repair.ts"), "export const value = 1;\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "base");
  const pinnedBaseRef = git(cwd, "rev-parse", "HEAD");
  const repairBaseRef = pinnedBaseRef;
  fs.writeFileSync(path.join(cwd, "src/repair.ts"), "export const value = 2;\n");
  git(cwd, "add", "src/repair.ts");
  git(cwd, "commit", "-m", "repair change");

  assert.equal(
    classifyExternalBaseValidationFailure({
      targetDir: cwd,
      pinnedBaseRef,
      repairBaseRef,
      error: new Error("src/repair.ts:1: lint failed"),
      baseError: new Error("src/repair.ts:1: lint failed"),
    }),
    null,
  );
});

test("final-sync classification excludes files changed only by advanced main", () => {
  const cwd = gitPackageFixture({ "check:changed": "node check.js" });
  fs.mkdirSync(path.join(cwd, "src"));
  fs.writeFileSync(path.join(cwd, "src/base.ts"), "export const base = 1;\n");
  fs.writeFileSync(path.join(cwd, "src/repair.ts"), "export const repair = 1;\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "base");
  const preSyncBaseRef = git(cwd, "rev-parse", "HEAD");
  git(cwd, "checkout", "-b", "repair");
  fs.writeFileSync(path.join(cwd, "src/repair.ts"), "export const repair = 2;\n");
  git(cwd, "add", "src/repair.ts");
  git(cwd, "commit", "-m", "repair delta");
  const repairDeltaPaths = git(cwd, "diff", "--name-only", `${preSyncBaseRef}..HEAD`).split(
    /\r?\n/,
  );

  git(cwd, "checkout", "main");
  fs.writeFileSync(path.join(cwd, "src/base.ts"), "export const base = 2;\n");
  git(cwd, "add", "src/base.ts");
  git(cwd, "commit", "-m", "advanced main");
  const synchronizedBaseRef = git(cwd, "rev-parse", "HEAD");
  git(cwd, "checkout", "repair");
  git(cwd, "rebase", "main");

  const diagnostic = new Error("src/base.ts:1: lint failed");
  assert.equal(
    classifyExternalBaseValidationFailure({
      targetDir: cwd,
      pinnedBaseRef: synchronizedBaseRef,
      repairBaseRef: preSyncBaseRef,
      error: diagnostic,
      baseError: diagnostic,
    }),
    null,
  );
  assert.deepEqual(
    classifyExternalBaseValidationFailure({
      targetDir: cwd,
      pinnedBaseRef: synchronizedBaseRef,
      repairBaseRef: preSyncBaseRef,
      repairDeltaPaths,
      error: diagnostic,
      baseError: diagnostic,
    }),
    {
      paths: ["src/base.ts"],
      reason: "validation failed only in base-identical files outside the repair delta",
    },
  );
});

test("pinned-base validation reproduction proves the same base failure", () => {
  const cwd = gitPackageFixture({ "check:changed": "node check.js" });
  fs.mkdirSync(path.join(cwd, "src"));
  fs.writeFileSync(
    path.join(cwd, "check.js"),
    "console.error('src/base.ts:1: lint failed'); process.exit(1);\n",
  );
  fs.writeFileSync(path.join(cwd, "src/base.ts"), "export const base = true;\n");
  fs.writeFileSync(path.join(cwd, "src/repair.ts"), "export const value = 1;\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "base");
  const pinnedBaseRef = git(cwd, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(cwd, "src/repair.ts"), "export const value = 2;\n");
  git(cwd, "add", "src/repair.ts");
  git(cwd, "commit", "-m", "repair change");

  const baseError = reproduceValidationFailureAtPinnedBase({
    commands: ["pnpm check:changed"],
    targetDir: cwd,
    options: validationOptions("openclaw/openclaw", { pinnedBaseRef }),
  });

  assert.match(String(baseError), /src\/base\.ts:1: lint failed/);
});

test("pinned-base reproduction fails closed when dependency inputs changed", () => {
  const cwd = gitPackageFixture({ "check:changed": "node check.js" });
  fs.writeFileSync(
    path.join(cwd, "check.js"),
    "console.error('src/base.ts:1: lint failed'); process.exit(1);\n",
  );
  fs.mkdirSync(path.join(cwd, "src"));
  fs.writeFileSync(path.join(cwd, "src/base.ts"), "export const base = true;\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "base");
  const pinnedBaseRef = git(cwd, "rev-parse", "HEAD");
  const packageJson = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
  packageJson.dependencies = { "fixture-dependency": "1.0.0" };
  fs.writeFileSync(path.join(cwd, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);

  assert.equal(
    reproduceValidationFailureAtPinnedBase({
      commands: ["pnpm check:changed"],
      targetDir: cwd,
      options: validationOptions("openclaw/openclaw", { pinnedBaseRef }),
    }),
    null,
  );
  git(cwd, "add", "package.json");
  assert.equal(
    reproduceValidationFailureAtPinnedBase({
      commands: ["pnpm check:changed"],
      targetDir: cwd,
      options: validationOptions("openclaw/openclaw", { pinnedBaseRef }),
    }),
    null,
  );
  git(cwd, "commit", "-m", "change dependency inputs");
  assert.equal(
    reproduceValidationFailureAtPinnedBase({
      commands: ["pnpm check:changed"],
      targetDir: cwd,
      options: validationOptions("openclaw/openclaw", { pinnedBaseRef }),
    }),
    null,
  );
});

test("pinned-base reproduction does not reuse a mutable dependency runtime", () => {
  const cwd = gitPackageFixture({ "check:changed": "node check.js" });
  fs.writeFileSync(
    path.join(cwd, "check.js"),
    "const fs = require('node:fs'); if (fs.existsSync('node_modules/fixture-dependency/state.js')) { console.error('src/base.ts:1: lint failed'); process.exit(1); }\n",
  );
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "base");
  const pinnedBaseRef = git(cwd, "rev-parse", "HEAD");
  fs.mkdirSync(path.join(cwd, "node_modules", "fixture-dependency"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "node_modules", "fixture-dependency", "state.js"), "mutated\n");

  assert.equal(
    reproduceValidationFailureAtPinnedBase({
      commands: ["pnpm check:changed"],
      targetDir: cwd,
      options: validationOptions("openclaw/openclaw", { pinnedBaseRef }),
    }),
    null,
  );
});

test("pinned-base reproduction prepares an independent runtime after normal setup", () => {
  const cwd = gitBunPackageFixture({ check: "bun run check" });
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "base");
  const pinnedBaseRef = git(cwd, "rev-parse", "HEAD");
  const { binDir } = fakeBunFixture(cwd, { failRun: true });
  const options = validationOptions("openclaw/clawhub", {
    ...clawhubToolchain(),
    pinnedBaseRef,
    installTargetDeps: true,
    installTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
    setupTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
  });

  withPathPrefix(binDir, () => {
    prepareTargetToolchain(cwd, options);
    assert.equal(fs.existsSync(path.join(cwd, "node_modules")), true);
    const baseError = reproduceValidationFailureAtPinnedBase({
      commands: ["bun run check"],
      targetDir: cwd,
      options,
    });
    assert.match(String(baseError), /src\/base\.ts:1: lint failed/);
  });
});

test("pinned-base reproduction fails closed when the pinned ref is unavailable", () => {
  const cwd = gitPackageFixture({ "check:changed": "node check.js" });
  fs.writeFileSync(path.join(cwd, "check.js"), "process.exit(1);\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "base");

  assert.equal(
    reproduceValidationFailureAtPinnedBase({
      commands: ["pnpm check:changed"],
      targetDir: cwd,
      options: validationOptions("openclaw/openclaw", { pinnedBaseRef: "f".repeat(40) }),
    }),
    null,
  );
});

test("bun-based target repos do not get pnpm check:changed injected", () => {
  const cwd = bunPackageFixture({ check: "bun x tsc --noEmit" });

  assert.deepEqual(
    requiredValidationCommands([], cwd, validationOptions("openclaw/clawhub", clawhubToolchain())),
    ["bun run check"],
  );
});

test("bun-based target repos pass preflight when their script exists", () => {
  const cwd = bunPackageFixture({ check: "bun x tsc --noEmit" });

  assert.deepEqual(
    preflightTargetValidationPlan(
      { fixArtifact: { validation_commands: ["bun run check"] }, targetDir: cwd },
      validationOptions("openclaw/clawhub", clawhubToolchain()),
    ),
    {
      status: "passed",
      resolved_commands: ["bun run check"],
      available_scripts: ["check"],
    },
  );
});

test("bun-based target repos drop stale pnpm check:changed and pass on their real validation command", () => {
  // Regression guard for the stale-deterministic-artifact path: an automerge
  // artifact authored before per-repo toolchain config (or any future caller
  // that still ships `pnpm check:changed` for a non-pnpm target) must not be
  // able to terminally preflight ClawHub on `validation_script_missing`.
  // Instead the bun toolchain's baseValidationCommands (`bun run check`)
  // should drive preflight to `passed`.
  const cwd = bunPackageFixture({ check: "bun x tsc --noEmit" });

  const result = preflightTargetValidationPlan(
    { fixArtifact: { validation_commands: ["pnpm check:changed"] }, targetDir: cwd },
    validationOptions("openclaw/clawhub", clawhubToolchain()),
  );

  assert.equal(result.status, "passed");
  assert.deepEqual(result.resolved_commands, ["bun run check"]);
  assert.deepEqual(result.available_scripts, ["check"]);
});

test("non-gated target repos replace stale changed gates with git validation", () => {
  const cwd = packageFixture({ test: "node test.js" });

  const result = preflightTargetValidationPlan(
    { fixArtifact: { validation_commands: ["pnpm check:changed"] }, targetDir: cwd },
    validationOptions("openclaw/fs-safe", {
      toolchain: {
        packageManager: "pnpm",
        baseValidationCommands: [],
        changedGate: null,
      },
    }),
  );

  assert.equal(result.status, "passed");
  assert.deepEqual(result.resolved_commands, ["git diff --check"]);
  assert.deepEqual(result.available_scripts, ["test"]);
});

test("repair execution provisions pinned Bun before target validation can invoke it", () => {
  const workflow = fs.readFileSync(".github/workflows/repair-cluster-worker.yml", "utf8");
  const containmentIndex = workflow.indexOf("- name: Verify Linux validation containment");
  const setupBunIndex = workflow.indexOf("- name: Setup pinned Bun for target validation");
  const executeFixIndex = workflow.indexOf("- name: Execute credited fix artifact");

  assert.ok(containmentIndex >= 0, "expected repair execution workflow to gate containment");
  assert.ok(setupBunIndex >= 0, "expected repair execution workflow to set up Bun");
  assert.ok(executeFixIndex >= 0, "expected repair execution workflow to execute fix artifacts");
  assert.ok(containmentIndex < setupBunIndex, "expected containment preflight before target setup");
  assert.ok(setupBunIndex < executeFixIndex, "expected Bun setup before repair:execute-fix");

  const containmentStep = workflow.slice(containmentIndex, setupBunIndex);
  assert.match(containmentStep, /pnpm run repair:containment-smoke/);
  const preflight = fs.readFileSync("src/repair/containment-preflight.ts", "utf8");
  const worker = fs.readFileSync("src/repair/contained-command-worker.ts", "utf8");
  const runtime = fs.readFileSync("src/repair/process-tree-containment.ts", "utf8");
  assert.match(preflight, /process\.platform !== "linux"/);
  assert.match(worker, /command: "\/usr\/bin\/unshare"/);
  assert.match(worker, /"--map-root-user"/);
  assert.match(worker, /"--kill-child=SIGKILL"/);
  assert.match(runtime, /SYS_LANDLOCK_CREATE_RULESET = 444/);
  assert.match(runtime, /if error\.errno not in \{errno\.ENOSYS, errno\.EOPNOTSUPP\}/);
  const setupBunStep = workflow.slice(setupBunIndex, executeFixIndex);
  assert.match(setupBunStep, /uses: oven-sh\/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6/);
  assert.match(setupBunStep, /bun-version: 1\.3\.14/);
});

test("bun-based target toolchain installs deps and runs configured validation", () => {
  const cwd = gitBunPackageFixture({ check: "bun x tsc --noEmit" });
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  attachOrigin(cwd);

  const { binDir, logPath } = fakeBunFixture(cwd);
  withPathPrefix(binDir, () => {
    prepareTargetToolchain(cwd, {
      ...validationOptions("openclaw/clawhub", clawhubToolchain()),
      installTargetDeps: true,
      installTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
      setupTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
    });
    assert.deepEqual(
      runAllowedValidationCommands(
        ["bun run check"],
        cwd,
        validationOptions("openclaw/clawhub", clawhubToolchain()),
      ),
      ["bun run check"],
    );
  });

  assert.deepEqual(fs.readFileSync(logPath, "utf8").trim().split(/\r?\n/), [
    "--version",
    "install --frozen-lockfile --ignore-scripts --registry https://registry.npmjs.org/",
    "run check",
  ]);
});

test("dependency setup permits inert package-manager config files", () => {
  for (const [configName, contents] of [
    [".npmrc", ""],
    [".npmrc", "# Registry and auth settings belong in the runner environment.\n; npm comment\n"],
    ["bunfig.toml", "# Install settings belong in the runner environment.\n"],
  ] as const) {
    const cwd = gitBunPackageFixture({ check: "bun x tsc --noEmit" });
    fs.writeFileSync(path.join(cwd, configName), contents);
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "initial");
    attachOrigin(cwd);

    const { binDir } = fakeBunFixture(cwd);
    withPathPrefix(binDir, () => {
      assert.doesNotThrow(() =>
        prepareTargetToolchain(cwd, {
          ...validationOptions("openclaw/clawhub", clawhubToolchain()),
          installTargetDeps: true,
          installTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
          setupTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
        }),
      );
    });
  }
});

test("dependency setup permits external funding metadata in npm lockfiles", () => {
  for (const lockfile of ["package-lock.json", "npm-shrinkwrap.json"]) {
    const cwd = gitPackageFixture({ check: 'node -e ""' });
    fs.rmSync(path.join(cwd, "pnpm-lock.yaml"));
    const packagePath = path.join(cwd, "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    packageJson.packageManager = "npm@11.0.0";
    fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    fs.writeFileSync(
      path.join(cwd, lockfile),
      `${JSON.stringify(
        {
          name: "fixture",
          lockfileVersion: 3,
          packages: {
            "": { name: "fixture", version: "1.0.0" },
            "node_modules/funding-string": {
              version: "1.0.0",
              resolved: "https://registry.npmjs.org/funding-string/-/funding-string-1.0.0.tgz",
              funding: "https://github.com/sponsors/example",
            },
            "node_modules/funding-object": {
              version: "1.0.0",
              resolved: "https://registry.npmjs.org/funding-object/-/funding-object-1.0.0.tgz",
              funding: { type: "individual", url: "https://patreon.com/example" },
            },
            "node_modules/funding-array": {
              version: "1.0.0",
              resolved: "https://registry.npmjs.org/funding-array/-/funding-array-1.0.0.tgz",
              funding: [
                { type: "collective", url: "https://opencollective.com/example" },
                "https://github.com/sponsors/example",
              ],
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "initial");
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-npm-funding-bin-"));
    const npmPath = path.join(binDir, "npm.js");
    fs.writeFileSync(
      npmPath,
      'require("node:fs").mkdirSync("node_modules", { recursive: true });\n',
    );

    withMockCommand("npm", npmPath, () =>
      prepareTargetToolchain(cwd, {
        ...validationOptions("steipete/example", {
          toolchain: {
            packageManager: "npm",
            baseValidationCommands: [],
            changedGate: null,
          },
        }),
        installTargetDeps: true,
        installTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
        setupTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
      }),
    );
  }
});

test("dependency setup keeps non-funding npm lockfile URLs fail-closed", () => {
  for (const metadata of [
    { resolved: "https://github.com/example/payload.tgz" },
    { homepage: "https://github.com/example/payload" },
  ]) {
    const cwd = gitPackageFixture({ check: 'node -e ""' });
    fs.writeFileSync(
      path.join(cwd, "package-lock.json"),
      `${JSON.stringify({
        lockfileVersion: 3,
        packages: { "node_modules/payload": { version: "1.0.0", ...metadata } },
      })}\n`,
    );
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "initial");

    assert.throws(
      () =>
        prepareTargetToolchain(cwd, {
          ...validationOptions("steipete/example", {
            toolchain: {
              packageManager: "npm",
              baseValidationCommands: [],
              changedGate: null,
            },
          }),
          installTargetDeps: true,
          installTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
          setupTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
        }),
      /destination is not approved: https:\/\/github\.com/,
    );
  }
});

test("dependency setup rejects install destinations for dependencies named funding", () => {
  for (const dependencies of [
    {
      funding: {
        version: "1.0.0",
        resolved: "https://github.com/example/funding.tgz",
      },
    },
    {
      packages: {
        version: "1.0.0",
        dependencies: {
          funding: {
            version: "1.0.0",
            resolved: "https://github.com/example/nested-funding.tgz",
          },
        },
      },
    },
  ]) {
    const cwd = gitPackageFixture({ check: 'node -e ""' });
    fs.writeFileSync(
      path.join(cwd, "package-lock.json"),
      `${JSON.stringify({ lockfileVersion: 2, dependencies })}\n`,
    );
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "initial");

    assert.throws(
      () =>
        prepareTargetToolchain(cwd, {
          ...validationOptions("steipete/example", {
            toolchain: {
              packageManager: "npm",
              baseValidationCommands: [],
              changedGate: null,
            },
          }),
          installTargetDeps: true,
          installTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
          setupTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
        }),
      /destination is not approved: https:\/\/github\.com/,
    );
  }
});

test("dependency setup rejects target-controlled network destinations", () => {
  const cases = [
    {
      expected: /network config is not allowed: \.npmrc/,
      prepare() {
        const cwd = gitPackageFixture({ check: 'node -e ""' });
        fs.writeFileSync(path.join(cwd, ".npmrc"), "registry=http://127.0.0.1:4873/\n");
        return {
          cwd,
          options: validationOptions("steipete/example", {
            toolchain: {
              packageManager: "pnpm",
              baseValidationCommands: ["pnpm check"],
              changedGate: null,
            },
          }),
        };
      },
    },
    ...[
      "//registry.npmjs.org/:_authToken=secret\n",
      "proxy=http://127.0.0.1:8080/\n",
      "cafile=./target-controlled-ca.pem\n",
      "fetch-retries=9\n",
      "future-network-setting=value\n",
      "# comment\rregistry=http://attacker.example/\n",
    ].map((contents) => ({
      expected: /network config is not allowed: \.npmrc/,
      prepare() {
        const cwd = gitPackageFixture({ check: 'node -e ""' });
        fs.writeFileSync(path.join(cwd, ".npmrc"), contents);
        return {
          cwd,
          options: validationOptions("steipete/example", {
            toolchain: {
              packageManager: "pnpm" as const,
              baseValidationCommands: ["pnpm check"],
              changedGate: null,
            },
          }),
        };
      },
    })),
    {
      expected: /network config is not allowed: bunfig\.toml/,
      prepare() {
        const cwd = gitBunPackageFixture({ check: 'node -e ""' });
        fs.writeFileSync(
          path.join(cwd, "bunfig.toml"),
          '[install]\nregistry = "http://127.0.0.1:4873/"\n',
        );
        return {
          cwd,
          options: validationOptions("openclaw/clawhub", clawhubToolchain()),
        };
      },
    },
    {
      expected: /destination is not approved: http:\/\/169\.254\.169\.254/,
      prepare() {
        const cwd = gitPackageFixture({ check: 'node -e ""' });
        fs.writeFileSync(
          path.join(cwd, "pnpm-lock.yaml"),
          "lockfileVersion: '9.0'\npackages:\n  payload:\n    resolution:\n      tarball: http://169.254.169.254/latest/meta-data/\n",
        );
        return {
          cwd,
          options: validationOptions("steipete/example", {
            toolchain: {
              packageManager: "pnpm",
              baseValidationCommands: ["pnpm check"],
              changedGate: null,
            },
          }),
        };
      },
    },
    {
      expected: /destination is not approved/,
      prepare() {
        const cwd = gitBunPackageFixture({ check: 'node -e ""' });
        const packagePath = path.join(cwd, "package.json");
        const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
        packageJson.dependencies = { payload: "github:example/payload" };
        fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
        return {
          cwd,
          options: validationOptions("openclaw/clawhub", clawhubToolchain()),
        };
      },
    },
    {
      expected: /destination is not approved: http:\/\/127\.0\.0\.1:8080/,
      prepare() {
        const cwd = gitPackageFixture({ check: 'node -e ""' });
        fs.writeFileSync(
          path.join(cwd, "package-lock.json"),
          '{"lockfileVersion":3,"packages":{"node_modules/payload":{"resolved":"http:\\/\\/127.0.0.1:8080/payload.tgz"}}}\n',
        );
        return {
          cwd,
          options: validationOptions("steipete/example", {
            toolchain: {
              packageManager: "npm",
              baseValidationCommands: ["npm run check"],
              changedGate: null,
            },
          }),
        };
      },
    },
    {
      expected: /(?:target dependency install|validation symlink escapes target checkout)/,
      prepare() {
        const cwd = gitPackageFixture({ check: 'node -e ""' });
        const packagePath = path.join(cwd, "package.json");
        const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
        packageJson.dependencies = { payload: "file:../outside" };
        fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
        return {
          cwd,
          options: validationOptions("steipete/example", {
            toolchain: {
              packageManager: "npm",
              baseValidationCommands: ["npm run check"],
              changedGate: null,
            },
          }),
        };
      },
    },
    {
      expected: /(?:target dependency install|validation symlink escapes target checkout)/,
      prepare() {
        const cwd = gitPackageFixture({ check: 'node -e ""' });
        const packagePath = path.join(cwd, "package.json");
        const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
        packageJson.dependencies = { payload: "../outside" };
        fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
        return {
          cwd,
          options: validationOptions("steipete/example", {
            toolchain: {
              packageManager: "npm",
              baseValidationCommands: ["npm run check"],
              changedGate: null,
            },
          }),
        };
      },
    },
    {
      expected: /(?:target dependency install|validation symlink escapes target checkout)/,
      prepare() {
        const cwd = gitPackageFixture({ check: 'node -e ""' });
        const packagePath = path.join(cwd, "package.json");
        const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
        packageJson.dependencies = { payload: "workspace:../outside" };
        fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
        return {
          cwd,
          options: validationOptions("steipete/example", {
            toolchain: {
              packageManager: "pnpm",
              baseValidationCommands: ["pnpm check"],
              changedGate: null,
            },
          }),
        };
      },
    },
    {
      expected: /(?:target dependency install|validation symlink escapes target checkout)/,
      prepare() {
        const cwd = gitPackageFixture({ check: 'node -e ""' });
        const packagePath = path.join(cwd, "package.json");
        const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
        packageJson.dependencies = { payload: "workspace:..\\outside" };
        fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
        return {
          cwd,
          options: validationOptions("steipete/example", {
            toolchain: {
              packageManager: "pnpm",
              baseValidationCommands: ["pnpm check"],
              changedGate: null,
            },
          }),
        };
      },
    },
    {
      expected: /(?:target dependency install|validation symlink escapes target checkout)/,
      prepare() {
        const cwd = gitPackageFixture({ check: 'node -e ""' });
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-local-dependency-"));
        const vendorDir = path.join(cwd, "vendor");
        fs.mkdirSync(vendorDir);
        fs.symlinkSync(outside, path.join(vendorDir, "payload"));
        const packagePath = path.join(cwd, "package.json");
        const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
        packageJson.dependencies = { payload: "file:./vendor/payload" };
        fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
        return {
          cwd,
          options: validationOptions("steipete/example", {
            toolchain: {
              packageManager: "npm",
              baseValidationCommands: ["npm run check"],
              changedGate: null,
            },
          }),
        };
      },
    },
    {
      expected: /(?:target dependency install|validation symlink escapes target checkout)/,
      prepare() {
        const cwd = gitPackageFixture({ check: 'node -e ""' });
        const localPackageDir = path.join(cwd, "packages", "payload");
        fs.mkdirSync(localPackageDir, { recursive: true });
        fs.writeFileSync(
          path.join(localPackageDir, "package.json"),
          `${JSON.stringify(
            {
              name: "payload",
              version: "1.0.0",
              dependencies: { nested: "http://169.254.169.254/latest/meta-data/" },
            },
            null,
            2,
          )}\n`,
        );
        const packagePath = path.join(cwd, "package.json");
        const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
        packageJson.dependencies = { payload: "file:./packages/payload" };
        fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
        return {
          cwd,
          options: validationOptions("steipete/example", {
            toolchain: {
              packageManager: "npm",
              baseValidationCommands: ["npm run check"],
              changedGate: null,
            },
          }),
        };
      },
    },
    {
      expected: /(?:target dependency install|validation symlink escapes target checkout)/,
      prepare() {
        const cwd = gitPackageFixture({ check: 'node -e ""' });
        const packagePath = path.join(cwd, "package.json");
        const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
        packageJson.dependencies = { payload: "./payload.tgz" };
        fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
        return {
          cwd,
          options: validationOptions("steipete/example", {
            toolchain: {
              packageManager: "npm",
              baseValidationCommands: ["npm run check"],
              changedGate: null,
            },
          }),
        };
      },
    },
    {
      expected: /cannot inspect bun\.lockb/,
      prepare() {
        const cwd = gitBunPackageFixture({ check: 'node -e ""' });
        fs.rmSync(path.join(cwd, "bun.lock"));
        fs.writeFileSync(path.join(cwd, "bun.lockb"), "opaque");
        return {
          cwd,
          options: validationOptions("openclaw/clawhub", clawhubToolchain()),
        };
      },
    },
  ];

  for (const fixture of cases) {
    const { cwd, options } = fixture.prepare();
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "initial");
    assert.throws(
      () =>
        prepareTargetToolchain(cwd, {
          ...options,
          installTargetDeps: true,
          installTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
          setupTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
        }),
      fixture.expected,
    );
  }
});

test("dependency setup preserves tracked in-checkout local workspace dependencies", () => {
  for (const { dependencyName, spec, version } of [
    { dependencyName: "shared", spec: "file:../shared", version: "file:../shared" },
    { dependencyName: "shared", spec: "workspace:../shared", version: "link:../shared" },
    { dependencyName: "root", spec: "workspace:*", version: "workspace:*" },
    { dependencyName: "alias", spec: "workspace:shared@*", version: "link:../shared" },
  ]) {
    const cwd = gitBunPackageFixture({});
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      `${JSON.stringify(
        {
          name: "root",
          packageManager: "bun@1.1.0",
          workspaces: ["packages/*"],
        },
        null,
        2,
      )}\n`,
    );
    for (const [name, dependencies] of [
      ["app", { [dependencyName]: spec }],
      ["shared", {}],
    ]) {
      const directory = path.join(cwd, "packages", name);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(
        path.join(directory, "package.json"),
        `${JSON.stringify({ name, version: "1.0.0", dependencies }, null, 2)}\n`,
      );
    }
    fs.writeFileSync(
      path.join(cwd, "pnpm-lock.yaml"),
      `${JSON.stringify({
        lockfileVersion: "9.0",
        importers: {
          "packages/app": {
            dependencies: {
              [dependencyName]: {
                specifier: spec,
                version,
              },
            },
          },
        },
      })}\n`,
    );
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "initial");
    const { binDir } = fakeBunFixture(cwd);

    withPathPrefix(binDir, () =>
      prepareTargetToolchain(cwd, {
        ...validationOptions("openclaw/clawhub", clawhubToolchain()),
        installTargetDeps: true,
        installTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
        setupTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
      }),
    );
  }
});

test("dependency setup accepts npm lockfile v3 tracked workspace links", () => {
  const cwd = gitPackageFixture({ check: 'node -e ""' });
  const packagePath = path.join(cwd, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  packageJson.packageManager = "npm@11.0.0";
  packageJson.workspaces = ["packages/*"];
  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  const workspaceDir = path.join(cwd, "packages", "shared");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, "package.json"),
    `${JSON.stringify({ name: "@example/shared", version: "1.0.0" }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(cwd, "package-lock.json"),
    `${JSON.stringify(
      {
        name: "root",
        lockfileVersion: 3,
        packages: {
          "": { workspaces: ["packages/*"] },
          "node_modules/@example/shared": { resolved: "packages/shared", link: true },
          "packages/shared": { name: "@example/shared", version: "1.0.0" },
        },
      },
      null,
      2,
    )}\n`,
  );
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-npm-workspace-link-"));
  const npmPath = path.join(binDir, "npm.js");
  fs.writeFileSync(npmPath, 'require("node:fs").mkdirSync("node_modules", { recursive: true });\n');

  withMockCommand("npm", npmPath, () =>
    prepareTargetToolchain(cwd, {
      ...validationOptions("steipete/example", {
        toolchain: {
          packageManager: "npm",
          baseValidationCommands: [],
          changedGate: null,
        },
      }),
      installTargetDeps: true,
      installTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
      setupTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
    }),
  );
});

test("pnpm dependency setup does not authorize package.json-only workspaces", () => {
  const cwd = gitPackageFixture({ check: 'node -e ""' });
  const packagePath = path.join(cwd, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  packageJson.workspaces = ["packages/*"];
  packageJson.dependencies = { payload: "file:./packages/payload" };
  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  const workspaceDir = path.join(cwd, "packages", "payload");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, "package.json"),
    `${JSON.stringify({ name: "payload", version: "1.0.0" }, null, 2)}\n`,
  );
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");

  assert.throws(
    () =>
      prepareTargetToolchain(cwd, {
        ...validationOptions("steipete/example", {
          toolchain: {
            packageManager: "pnpm",
            baseValidationCommands: [],
            changedGate: null,
          },
        }),
        installTargetDeps: true,
        installTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
        setupTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
      }),
    /local package is not a tracked workspace/,
  );
});

test("dependency setup rejects unsafe structured lockfile local resolutions", () => {
  const cases = [
    {
      lockfile: "package-lock.json",
      value: {
        lockfileVersion: 3,
        packages: {
          "node_modules/payload": { resolved: "file:../outside" },
        },
      },
    },
    {
      lockfile: "package-lock.json",
      value: {
        lockfileVersion: 3,
        packages: {
          "node_modules/payload": { resolved: "/tmp/outside" },
        },
      },
    },
    {
      lockfile: "pnpm-lock.yaml",
      value: {
        lockfileVersion: "9.0",
        importers: {
          ".": {
            dependencies: {
              payload: { version: "portal:../outside" },
            },
          },
        },
      },
    },
    {
      lockfile: "pnpm-lock.yaml",
      value: {
        lockfileVersion: "9.0",
        importers: {
          ".": {
            dependencies: {
              payload: {
                version: "patch:https://example.invalid/payload.tgz#./patches/payload.patch",
              },
            },
          },
        },
      },
    },
    {
      lockfile: "pnpm-lock.yaml",
      value: {
        lockfileVersion: "9.0",
        importers: {
          ".": {
            dependencies: {
              payload: { version: "link:../outside" },
            },
          },
        },
      },
    },
    {
      lockfile: "pnpm-lock.yaml",
      value: {
        lockfileVersion: "9.0",
        importers: {
          ".": {
            dependencies: {
              payload: { version: "path:./packages/untracked" },
            },
          },
        },
      },
    },
    {
      lockfile: "pnpm-lock.yaml",
      value: {
        lockfileVersion: "9.0",
        importers: {
          ".": {
            dependencies: {
              payload: { version: "patch:payload@1.0.0#../outside.patch" },
            },
          },
        },
      },
    },
    {
      lockfile: "pnpm-lock.yaml",
      value: {
        lockfileVersion: "9.0",
        packages: {
          payload: { resolution: { directory: "../outside" } },
        },
      },
    },
  ];

  for (const fixture of cases) {
    const cwd = gitPackageFixture({ check: 'node -e ""' });
    fs.writeFileSync(path.join(cwd, fixture.lockfile), `${JSON.stringify(fixture.value)}\n`);
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "initial");

    assert.throws(
      () =>
        prepareTargetToolchain(cwd, {
          ...validationOptions("steipete/example", {
            toolchain: {
              packageManager: fixture.lockfile.endsWith(".json") ? "npm" : "pnpm",
              baseValidationCommands: [],
              changedGate: null,
            },
          }),
          installTargetDeps: true,
          installTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
          setupTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
        }),
      /(?:target dependency install|validation symlink escapes target checkout)/,
    );
  }
});

test("dependency setup rejects untracked and symlink-external local workspaces", () => {
  for (const kind of ["untracked", "external-symlink"]) {
    const cwd = gitPackageFixture({ check: 'node -e ""' });
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      `${JSON.stringify(
        {
          scripts: { check: 'node -e ""' },
          packageManager: "pnpm@10.33.0",
          workspaces: ["packages/*"],
        },
        null,
        2,
      )}\n`,
    );
    fs.writeFileSync(path.join(cwd, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "initial");

    const packageDir = path.join(cwd, "packages", "payload");
    fs.mkdirSync(packageDir, { recursive: true });
    if (kind === "untracked") {
      fs.writeFileSync(
        path.join(packageDir, "package.json"),
        `${JSON.stringify({ name: "payload", version: "1.0.0" })}\n`,
      );
    } else {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-local-workspace-"));
      fs.writeFileSync(
        path.join(outside, "package.json"),
        `${JSON.stringify({ name: "payload", version: "1.0.0" })}\n`,
      );
      fs.symlinkSync(path.join(outside, "package.json"), path.join(packageDir, "package.json"));
    }
    const packageJson = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
    packageJson.dependencies = { payload: "file:./packages/payload" };
    fs.writeFileSync(path.join(cwd, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);

    assert.throws(
      () =>
        prepareTargetToolchain(cwd, {
          ...validationOptions("steipete/example", {
            toolchain: {
              packageManager: "pnpm",
              baseValidationCommands: [],
              changedGate: null,
            },
          }),
          installTargetDeps: true,
          installTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
          setupTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
        }),
      /(?:workspace manifest is not tracked|metadata must be a regular file|local package|validation symlink escapes target checkout)/,
    );
  }
});

test(
  "bun dependency setup rejects and reaps detached descendants",
  { skip: process.platform !== "linux" },
  (context) => {
    if (!linuxValidationContainmentAvailable()) {
      context.skip("runner does not provide delegated user namespaces and Landlock ABI 3+");
      return;
    }
    const cwd = gitBunPackageFixture({ check: 'node -e ""' });
    const marker = path.join(cwd, "node_modules", "detached-bun-ran");
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "initial");
    attachOrigin(cwd);
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-bun-setup-containment-"));
    writeNodeCommandShim(
      binDir,
      "bun",
      `#!/usr/bin/env node
if (process.argv[2] === "--version") {
  process.stdout.write("1.3.14");
} else if (process.argv[2] === "install") {
  const { spawn } = require("node:child_process");
  const child = spawn(process.execPath, ["-e", ${JSON.stringify(
    `setTimeout(() => { require("node:fs").mkdirSync(${JSON.stringify(path.dirname(marker))}, { recursive: true }); require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"); }, 750);`,
  )}], { detached: true, stdio: "ignore" });
  child.unref();
}
`,
    );

    const previousForceContainment = process.env.CLAWSWEEPER_TEST_FORCE_LINUX_CONTAINMENT;
    process.env.CLAWSWEEPER_TEST_FORCE_LINUX_CONTAINMENT = "1";
    try {
      assert.throws(
        () =>
          withPathPrefix(binDir, () =>
            prepareTargetToolchain(cwd, {
              ...validationOptions("openclaw/clawhub", clawhubToolchain()),
              installTargetDeps: true,
              installTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
              setupTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
            }),
          ),
        /left [1-9]\d* background process/,
      );
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
      assert.equal(fs.existsSync(marker), false);
    } finally {
      restoreEnv("CLAWSWEEPER_TEST_FORCE_LINUX_CONTAINMENT", previousForceContainment);
    }
  },
);

test(
  "npm dependency setup rejects and reaps detached descendants",
  { skip: process.platform !== "linux" },
  (context) => {
    if (!linuxValidationContainmentAvailable()) {
      context.skip("runner does not provide delegated user namespaces and Landlock ABI 3+");
      return;
    }
    const cwd = gitPackageFixture({ check: 'node -e ""' });
    const marker = path.join(cwd, "node_modules", "detached-npm-ran");
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "initial");
    attachOrigin(cwd);
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-npm-setup-containment-"));
    writeNodeCommandShim(
      binDir,
      "npm",
      `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(
        `setTimeout(() => { require("node:fs").mkdirSync(${JSON.stringify(path.dirname(marker))}, { recursive: true }); require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"); }, 750);`,
      )}], { detached: true, stdio: "ignore" });
child.unref();
`,
    );

    const previousForceContainment = process.env.CLAWSWEEPER_TEST_FORCE_LINUX_CONTAINMENT;
    process.env.CLAWSWEEPER_TEST_FORCE_LINUX_CONTAINMENT = "1";
    try {
      assert.throws(
        () =>
          withPathOnlyPrefix(binDir, () =>
            prepareTargetToolchain(cwd, {
              ...validationOptions("steipete/example", {
                toolchain: {
                  packageManager: "npm",
                  baseValidationCommands: ["npm run check"],
                  changedGate: null,
                },
              }),
              installTargetDeps: true,
              installTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
              setupTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
            }),
          ),
        /left [1-9]\d* background process/,
      );
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
      assert.equal(fs.existsSync(marker), false);
    } finally {
      restoreEnv("CLAWSWEEPER_TEST_FORCE_LINUX_CONTAINMENT", previousForceContainment);
    }
  },
);

test("pnpm validation reuses the prepared target version and rejects stale setup", () => {
  const cwd = gitPackageFixture({ verify: "node check.js" });
  const packagePath = path.join(cwd, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  packageJson.packageManager = "pnpm@9.15.0";
  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  fs.writeFileSync(path.join(cwd, "check.js"), "process.exit(0);\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  attachOrigin(cwd);

  const hostBin = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-host-pnpm-"));
  const preparedBin = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-target-pnpm-bin-"));
  const corepackLog = path.join(hostBin, "corepack.log");
  const hostLog = path.join(hostBin, "host-pnpm.log");
  const targetLog = path.join(preparedBin, "target-pnpm.log");
  writeNodeCommandShim(
    preparedBin,
    "pnpm",
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(targetLog)}, args.join(" ") + "\\n");
if (args[0] === "install") fs.mkdirSync("node_modules", { recursive: true });
`,
  );
  writeNodeCommandShim(
    hostBin,
    "pnpm",
    `#!/usr/bin/env node
require("node:fs").appendFileSync(${JSON.stringify(hostLog)}, process.argv.slice(2).join(" ") + "\\n");
process.exit(42);
`,
  );
  writeNodeCommandShim(
    hostBin,
    "corepack",
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(corepackLog)}, args.join(" ") + "\\n");
if (args[0] === "enable") {
  const destination = args[args.indexOf("--install-directory") + 1];
  fs.mkdirSync(destination, { recursive: true });
  for (const name of fs.readdirSync(${JSON.stringify(preparedBin)})) {
    if (!name.startsWith("pnpm")) continue;
    const source = path.join(${JSON.stringify(preparedBin)}, name);
    const target = path.join(destination, name);
    fs.copyFileSync(source, target);
    fs.chmodSync(target, fs.statSync(source).mode);
  }
}
`,
  );
  const options = {
    ...validationOptions("steipete/example", {
      toolchain: {
        packageManager: "pnpm",
        baseValidationCommands: ["pnpm verify"],
        changedGate: null,
      },
    }),
    installTargetDeps: true,
    installTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
    setupTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
  };

  withCommandOverridesUnset(["corepack", "pnpm"], () =>
    withPathOnlyPrefix(hostBin, () => {
      prepareTargetToolchain(cwd, options);
      assert.deepEqual(runAllowedValidationCommands(["pnpm verify"], cwd, options), [
        "pnpm verify",
      ]);

      fs.writeFileSync(path.join(cwd, "check.js"), "process.exit(1);\n");
      assert.throws(
        () => runAllowedValidationCommands(["pnpm verify"], cwd, options),
        /prepared target pnpm toolchain is stale/,
      );

      prepareTargetToolchain(cwd, options);
      assert.deepEqual(runAllowedValidationCommands(["pnpm verify"], cwd, options), [
        "pnpm verify",
      ]);
    }),
  );

  assert.equal(fs.existsSync(hostLog), false, "host pnpm must never run");
  const corepackInvocations = fs.readFileSync(corepackLog, "utf8").trim().split(/\r?\n/);
  assert.equal(corepackInvocations.length, 4);
  assert.match(corepackInvocations[0], /enable --install-directory .*[/\\]corepack[/\\]bin/);
  assert.equal(corepackInvocations[1], "prepare pnpm@9.15.0 --activate");
  assert.match(corepackInvocations[2], /enable --install-directory .*[/\\]corepack[/\\]bin/);
  assert.equal(corepackInvocations[3], "prepare pnpm@9.15.0 --activate");
  const targetInvocations = fs.readFileSync(targetLog, "utf8").trim().split(/\r?\n/);
  assert.equal(targetInvocations.filter((line) => line.startsWith("install ")).length, 2);
  assert.deepEqual(
    targetInvocations.filter((line) => line.endsWith("verify")),
    [
      "--config.enable-pre-post-scripts=false verify",
      "--config.enable-pre-post-scripts=false verify",
    ],
  );
});

test(
  "pnpm validation refreshes the prepared executable before every command",
  { skip: process.platform === "win32" },
  () => {
    const cwd = gitPackageFixture({
      first: 'node -e ""',
      second: 'node -e ""',
    });
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "initial");
    attachOrigin(cwd);

    const hostBin = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-pnpm-refresh-"));
    const logPath = path.join(hostBin, "pnpm.log");
    const maliciousMarker = path.join(hostBin, "malicious-ran");
    const maliciousSource = `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(maliciousMarker)}, "ran");
`;
    const pnpmSource = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, args.join(" ") + "\\n");
if (args.includes("install")) fs.mkdirSync("node_modules", { recursive: true });
if (args.includes("first")) {
  fs.writeFileSync(process.argv[1], ${JSON.stringify(maliciousSource)}, { mode: 0o755 });
}
`;
    writeNodeCommandShim(
      hostBin,
      "corepack",
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "enable") {
  const destination = args[args.indexOf("--install-directory") + 1];
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, "pnpm"), ${JSON.stringify(pnpmSource)}, { mode: 0o755 });
}
`,
    );
    const options = {
      ...validationOptions("steipete/example", {
        toolchain: {
          packageManager: "pnpm",
          baseValidationCommands: [],
          changedGate: null,
        },
      }),
      installTargetDeps: true,
      installTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
      setupTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
    };

    withCommandOverridesUnset(["corepack", "pnpm"], () =>
      withPathOnlyPrefix(hostBin, () => {
        prepareTargetToolchain(cwd, options);
        assert.deepEqual(
          runAllowedValidationCommands(["pnpm first", "pnpm second"], cwd, options),
          ["pnpm first", "pnpm second"],
        );
      }),
    );

    assert.equal(fs.existsSync(maliciousMarker), false);
    assert.deepEqual(fs.readFileSync(logPath, "utf8").trim().split(/\r?\n/), [
      "install --frozen-lockfile --prefer-offline --ignore-scripts --ignore-pnpmfile --config.registry=https://registry.npmjs.org/ --config.engine-strict=false --config.enable-pre-post-scripts=false",
      "--config.enable-pre-post-scripts=false first",
      "--config.enable-pre-post-scripts=false second",
    ]);
  },
);

test("pnpm setup disables target pnpmfile hooks", { skip: process.platform === "win32" }, () => {
  const cwd = gitPackageFixture({ verify: 'node -e ""' });
  const hostBin = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-pnpmfile-"));
  const maliciousMarker = path.join(hostBin, "pnpmfile-ran");
  fs.writeFileSync(
    path.join(cwd, ".pnpmfile.cjs"),
    `require("node:fs").writeFileSync(${JSON.stringify(maliciousMarker)}, "ran");\n`,
  );
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  attachOrigin(cwd);

  const pnpmSource = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("install")) {
  if (!args.includes("--ignore-pnpmfile")) require(path.resolve(".pnpmfile.cjs"));
  fs.mkdirSync("node_modules", { recursive: true });
}
`;
  writeNodeCommandShim(
    hostBin,
    "corepack",
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "enable") {
  const destination = args[args.indexOf("--install-directory") + 1];
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, "pnpm"), ${JSON.stringify(pnpmSource)}, { mode: 0o755 });
}
`,
  );
  const options = {
    ...validationOptions("steipete/example", {
      toolchain: {
        packageManager: "pnpm",
        baseValidationCommands: [],
        changedGate: null,
      },
    }),
    installTargetDeps: true,
    installTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
    setupTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
  };

  withCommandOverridesUnset(["corepack", "pnpm"], () =>
    withPathOnlyPrefix(hostBin, () => prepareTargetToolchain(cwd, options)),
  );

  assert.equal(fs.existsSync(maliciousMarker), false);
});

test(
  "validation rejects ignored dependency poisoning before the next command",
  { skip: process.platform === "win32" },
  () => {
    const cwd = gitPackageFixture({
      first: 'node -e ""',
      second: 'node -e ""',
    });
    fs.writeFileSync(path.join(cwd, ".gitignore"), "node_modules/\n");
    fs.mkdirSync(path.join(cwd, "node_modules", "fixture-dependency"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "node_modules", "fixture-dependency", "state.js"), "safe\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "initial");
    attachOrigin(cwd);

    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-runtime-poison-"));
    const secondCommandMarker = path.join(binDir, "second-command-ran");
    writeNodeCommandShim(
      binDir,
      "pnpm",
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("first")) {
  fs.writeFileSync("node_modules/fixture-dependency/state.js", "poisoned\\n");
}
if (args.includes("second")) {
  fs.writeFileSync(${JSON.stringify(secondCommandMarker)}, "ran");
}
`,
    );
    const options = validationOptions("steipete/example", {
      toolchain: {
        packageManager: "pnpm",
        baseValidationCommands: [],
        changedGate: null,
      },
    });

    assert.throws(
      () =>
        withPathOnlyPrefix(binDir, () =>
          runAllowedValidationCommands(["pnpm first", "pnpm second"], cwd, options),
        ),
      /unsafe validation command mutated checkout identity/,
    );
    assert.equal(fs.existsSync(secondCommandMarker), false);
  },
);

test(
  "validation rejects ignored vendor poisoning before the next command",
  { skip: process.platform === "win32" },
  () => {
    const cwd = gitPackageFixture({
      first: 'node -e ""',
      second: 'node -e ""',
    });
    fs.writeFileSync(path.join(cwd, ".gitignore"), "vendor/\n");
    fs.mkdirSync(path.join(cwd, "vendor", "fixture-dependency"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "vendor", "fixture-dependency", "state.php"), "safe\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "initial");
    attachOrigin(cwd);

    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-vendor-poison-"));
    writeNodeCommandShim(
      binDir,
      "pnpm",
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("first")) {
  fs.writeFileSync("vendor/fixture-dependency/state.php", "poisoned\\n");
}
if (args.includes("second")) process.exit(70);
`,
    );
    const options = validationOptions("steipete/example", {
      toolchain: {
        packageManager: "pnpm",
        baseValidationCommands: [],
        changedGate: null,
      },
    });

    assert.throws(
      () =>
        withPathOnlyPrefix(binDir, () =>
          runAllowedValidationCommands(["pnpm first", "pnpm second"], cwd, options),
        ),
      /unsafe validation command mutated checkout identity/,
    );
  },
);

test(
  "validation rejects poisoning through arbitrary pre-existing ignored inputs",
  { skip: process.platform === "win32" },
  () => {
    const cwd = gitPackageFixture({
      first: 'node -e ""',
      second: 'node -e ""',
    });
    fs.writeFileSync(path.join(cwd, ".gitignore"), ".validation-cache/\n");
    fs.mkdirSync(path.join(cwd, ".validation-cache"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".validation-cache", "state.json"), '{"safe":true}\n');
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "initial");
    attachOrigin(cwd);

    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-arbitrary-poison-"));
    const secondCommandMarker = path.join(binDir, "second-command-ran");
    writeNodeCommandShim(
      binDir,
      "pnpm",
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("first")) fs.writeFileSync(".validation-cache/state.json", '{"safe":false}\\n');
if (args.includes("second")) fs.writeFileSync(${JSON.stringify(secondCommandMarker)}, "ran");
`,
    );
    const options = validationOptions("steipete/example", {
      toolchain: {
        packageManager: "pnpm",
        baseValidationCommands: [],
        changedGate: null,
      },
    });

    assert.throws(
      () =>
        withPathOnlyPrefix(binDir, () =>
          runAllowedValidationCommands(["pnpm first", "pnpm second"], cwd, options),
        ),
      /unsafe validation command mutated checkout identity/,
    );
    assert.equal(fs.existsSync(secondCommandMarker), false);
  },
);

test(
  "validation removes arbitrary newly-created ignored outputs between commands",
  { skip: process.platform === "win32" },
  () => {
    const cwd = gitPackageFixture({
      first: 'node -e ""',
      second: 'node -e ""',
    });
    fs.writeFileSync(path.join(cwd, ".gitignore"), ".generated-proof/\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "initial");
    attachOrigin(cwd);

    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-arbitrary-reset-"));
    writeNodeCommandShim(
      binDir,
      "pnpm",
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("first")) {
  fs.mkdirSync(".generated-proof", { recursive: true });
  fs.writeFileSync(".generated-proof/state.json", '{"poisoned":true}\\n');
}
if (args.includes("second") && fs.existsSync(".generated-proof")) process.exit(70);
`,
    );
    const options = validationOptions("steipete/example", {
      toolchain: {
        packageManager: "pnpm",
        baseValidationCommands: [],
        changedGate: null,
      },
    });

    assert.deepEqual(
      withPathOnlyPrefix(binDir, () =>
        runAllowedValidationCommands(["pnpm first", "pnpm second"], cwd, options),
      ),
      ["pnpm first", "pnpm second"],
    );
    assert.equal(fs.existsSync(path.join(cwd, ".generated-proof")), false);
  },
);

test("validation fails closed on unsafe ignored Git path discovery", () => {
  const cwd = gitPackageFixture({ check: 'node -e ""' });
  fs.writeFileSync(path.join(cwd, ".gitignore"), "*.validation-cache\n");
  fs.writeFileSync(path.join(cwd, "unsafe\n.validation-cache"), "poisoned\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  attachOrigin(cwd);

  assert.throws(
    () =>
      runAllowedValidationCommands(
        ["pnpm check"],
        cwd,
        validationOptions("steipete/example", {
          toolchain: {
            packageManager: "pnpm",
            baseValidationCommands: [],
            changedGate: null,
          },
        }),
      ),
    /ignored validation input discovery returned an unsafe path/,
  );
});

test(
  "validation clears ignored build roots between commands",
  { skip: process.platform === "win32" },
  () => {
    const cwd = gitPackageFixture({
      first: 'node -e ""',
      second: 'node -e ""',
    });
    const runtimeRoots = [".build", ".gradle", "dist", "target"];
    fs.writeFileSync(
      path.join(cwd, ".gitignore"),
      runtimeRoots.map((runtimeRoot) => `${runtimeRoot}/`).join("\n") + "\n",
    );
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "initial");
    attachOrigin(cwd);

    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-build-roots-"));
    writeNodeCommandShim(
      binDir,
      "pnpm",
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const runtimeRoots = ${JSON.stringify(runtimeRoots)};
if (args.includes("first")) {
  for (const root of runtimeRoots) {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "state"), "poisoned\\n");
  }
}
if (args.includes("second") && runtimeRoots.some((root) => fs.existsSync(root))) process.exit(70);
`,
    );
    const options = validationOptions("steipete/example", {
      toolchain: {
        packageManager: "pnpm",
        baseValidationCommands: [],
        changedGate: null,
      },
    });

    assert.deepEqual(
      withPathOnlyPrefix(binDir, () =>
        runAllowedValidationCommands(["pnpm first", "pnpm second"], cwd, options),
      ),
      ["pnpm first", "pnpm second"],
    );
    for (const runtimeRoot of runtimeRoots) {
      assert.equal(fs.existsSync(path.join(cwd, runtimeRoot)), false);
    }
  },
);

test(
  "validation binds ignored runtime symlink target contents between commands",
  { skip: process.platform === "win32" },
  () => {
    const cwd = gitPackageFixture({
      first: 'node -e ""',
      second: 'node -e ""',
    });
    fs.writeFileSync(path.join(cwd, ".gitignore"), "node_modules/\nruntime-input/\n");
    const externalInput = path.join(cwd, "runtime-input", "state.js");
    const dependencyDir = path.join(cwd, "node_modules", "fixture-dependency");
    fs.mkdirSync(path.dirname(externalInput), { recursive: true });
    fs.mkdirSync(dependencyDir, { recursive: true });
    fs.writeFileSync(externalInput, "safe\n");
    fs.symlinkSync(
      path.relative(dependencyDir, externalInput),
      path.join(dependencyDir, "state.js"),
    );
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "initial");
    attachOrigin(cwd);

    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-runtime-symlink-"));
    const secondCommandMarker = path.join(binDir, "second-command-ran");
    writeNodeCommandShim(
      binDir,
      "pnpm",
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("first")) {
  fs.writeFileSync("node_modules/fixture-dependency/state.js", "poisoned\\n");
}
if (args.includes("second")) {
  fs.writeFileSync(${JSON.stringify(secondCommandMarker)}, "ran");
}
`,
    );
    const options = validationOptions("steipete/example", {
      toolchain: {
        packageManager: "pnpm",
        baseValidationCommands: [],
        changedGate: null,
      },
    });

    assert.throws(
      () =>
        withPathOnlyPrefix(binDir, () =>
          runAllowedValidationCommands(["pnpm first", "pnpm second"], cwd, options),
        ),
      /unsafe validation command mutated checkout identity/,
    );
    assert.equal(fs.readFileSync(externalInput, "utf8"), "poisoned\n");
    assert.equal(fs.existsSync(secondCommandMarker), false);
  },
);

test(
  "runtime identity handles pnpm symlink graphs without duplicate traversal",
  { skip: process.platform === "win32" },
  () => {
    const cwd = gitPackageFixture({ check: 'node -e ""' });
    const virtualStore = path.join(cwd, "node_modules", ".pnpm");
    const packageA = path.join(virtualStore, "a@1.0.0", "node_modules", "a");
    const packageB = path.join(virtualStore, "b@1.0.0", "node_modules", "b");
    fs.mkdirSync(path.join(packageA, "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(packageB, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(packageA, "index.js"), "module.exports = 'a';\n");
    fs.writeFileSync(path.join(packageB, "index.js"), "module.exports = 'b';\n");
    fs.symlinkSync(
      path.relative(path.join(packageA, "node_modules"), packageB),
      path.join(packageA, "node_modules", "b"),
    );
    fs.symlinkSync(
      path.relative(path.join(packageB, "node_modules"), packageA),
      path.join(packageB, "node_modules", "a"),
    );
    fs.symlinkSync(
      path.relative(path.join(cwd, "node_modules"), packageA),
      path.join(cwd, "node_modules", "a"),
    );
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "initial");

    const before = captureTargetCheckoutBinding(cwd);
    fs.writeFileSync(path.join(packageB, "index.js"), "module.exports = 'poisoned';\n");

    assert.throws(
      () => assertTargetCheckoutBinding(cwd, before),
      /target checkout changed after validation/,
    );
  },
);

test(
  "pnpm setup rejects prepared executables that escape through symlinks",
  { skip: process.platform === "win32" },
  () => {
    const cwd = gitPackageFixture({ verify: 'node -e ""' });
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "initial");
    attachOrigin(cwd);

    const hostBin = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-pnpm-symlink-"));
    const externalPnpm = path.join(hostBin, "external-pnpm");
    fs.writeFileSync(
      externalPnpm,
      `#!/usr/bin/env node
if (process.argv.includes("install")) require("node:fs").mkdirSync("node_modules", { recursive: true });
`,
      { mode: 0o755 },
    );
    writeNodeCommandShim(
      hostBin,
      "corepack",
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "enable") {
  const destination = args[args.indexOf("--install-directory") + 1];
  fs.mkdirSync(destination, { recursive: true });
  fs.symlinkSync(${JSON.stringify(externalPnpm)}, path.join(destination, "pnpm"));
}
`,
    );
    const options = {
      ...validationOptions("steipete/example", {
        toolchain: {
          packageManager: "pnpm",
          baseValidationCommands: [],
          changedGate: null,
        },
      }),
      installTargetDeps: true,
      installTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
      setupTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
    };

    assert.throws(
      () =>
        withCommandOverridesUnset(["corepack", "pnpm"], () =>
          withPathOnlyPrefix(hostBin, () => prepareTargetToolchain(cwd, options)),
        ),
      /prepared target pnpm symlink escapes runtime/,
    );
  },
);

test(
  "pnpm setup freezes a runnable external Corepack shim",
  { skip: process.platform === "win32" },
  () => {
    const cwd = gitPackageFixture({ verify: 'node -e ""' });
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "initial");
    attachOrigin(cwd);

    const hostBin = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-corepack-shim-"));
    const distRoot = path.join(hostBin, "corepack-package", "dist");
    const corepackLib = path.join(distRoot, "lib", "corepack.cjs");
    const pnpmEntrypoint = path.join(distRoot, "pnpm.js");
    const logPath = path.join(hostBin, "pnpm.log");
    const maliciousMarker = path.join(hostBin, "external-corepack-ran");
    fs.mkdirSync(path.dirname(corepackLib), { recursive: true });
    fs.writeFileSync(pnpmEntrypoint, '#!/usr/bin/env node\nrequire("./lib/corepack.cjs");\n', {
      mode: 0o755,
    });
    fs.writeFileSync(
      corepackLib,
      `const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, args.join(" ") + "\\n");
if (args.includes("install")) fs.mkdirSync("node_modules", { recursive: true });
`,
    );
    writeNodeCommandShim(
      hostBin,
      "corepack",
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "enable") {
  const destination = args[args.indexOf("--install-directory") + 1];
  fs.mkdirSync(destination, { recursive: true });
  fs.symlinkSync(path.relative(destination, ${JSON.stringify(pnpmEntrypoint)}), path.join(destination, "pnpm"));
}
`,
    );
    const options = {
      ...validationOptions("steipete/example", {
        toolchain: {
          packageManager: "pnpm",
          baseValidationCommands: [],
          changedGate: null,
        },
      }),
      installTargetDeps: true,
      installTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
      setupTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
    };

    withCommandOverridesUnset(["corepack", "pnpm"], () =>
      withPathOnlyPrefix(hostBin, () => {
        prepareTargetToolchain(cwd, options);
        fs.writeFileSync(
          corepackLib,
          `require("node:fs").writeFileSync(${JSON.stringify(maliciousMarker)}, "ran");\n`,
        );
        assert.deepEqual(runAllowedValidationCommands(["pnpm verify"], cwd, options), [
          "pnpm verify",
        ]);
      }),
    );

    assert.equal(fs.existsSync(maliciousMarker), false);
    assert.deepEqual(fs.readFileSync(logPath, "utf8").trim().split(/\r?\n/), [
      "install --frozen-lockfile --prefer-offline --ignore-scripts --ignore-pnpmfile --config.registry=https://registry.npmjs.org/ --config.engine-strict=false --config.enable-pre-post-scripts=false",
      "--config.enable-pre-post-scripts=false verify",
    ]);
  },
);

test("bun-based target toolchain strips caller identity and path configuration", () => {
  // Regression guard for the `bunx only-allow bun` preinstall failure on
  // openclaw/clawhub: ClawSweeper itself runs under pnpm so `process.env`
  // carries `npm_config_user_agent=pnpm/...`. If that value leaked into the
  // `bun install` child we'd shell out to, target preinstalls that gate on
  // `only-allow bun` would refuse to run. prepareBunToolchain must scrub
  // caller identity/lifecycle env and assert a bun user-agent instead. Registry
  // selection remains available, but path-bearing cache/userconfig overrides do not.
  const cwd = gitBunPackageFixture({ check: "bun x tsc --noEmit" });
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  attachOrigin(cwd);

  const { binDir, envLogPath } = envLoggingBunFixture();
  const previousUserAgent = process.env.npm_config_user_agent;
  const previousRegistry = process.env.npm_config_registry;
  const previousCache = process.env.npm_config_cache;
  const previousUserconfig = process.env.npm_config_userconfig;
  const previousNpmExecpath = process.env.npm_execpath;
  const previousNpmNodeExecpath = process.env.npm_node_execpath;
  const previousNpmLifecycleEvent = process.env.npm_lifecycle_event;
  const previousNpmPackageName = process.env.npm_package_name;
  const previousPnpmHome = process.env.PNPM_HOME;
  const previousPnpmStorePath = process.env.PNPM_STORE_PATH;
  process.env.npm_config_user_agent = "pnpm/10.0.0 npm/? node/v22.0.0 linux x64";
  process.env.npm_config_registry = "https://registry.example.invalid/";
  process.env.npm_config_cache = "/tmp/npm-cache";
  process.env.npm_config_userconfig = "/tmp/npmrc";
  process.env.npm_execpath = "/tmp/pnpm";
  process.env.npm_node_execpath = "/tmp/node";
  process.env.npm_lifecycle_event = "repair:execute-fix";
  process.env.npm_package_name = "clawsweeper";
  process.env.PNPM_HOME = "/tmp/pnpm-home";
  process.env.PNPM_STORE_PATH = "/tmp/pnpm-store";
  try {
    withPathPrefix(binDir, () => {
      prepareTargetToolchain(cwd, {
        ...validationOptions("openclaw/clawhub", clawhubToolchain()),
        installTargetDeps: true,
        installTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
        setupTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
      });
    });
  } finally {
    restoreEnv("npm_config_user_agent", previousUserAgent);
    restoreEnv("npm_config_registry", previousRegistry);
    restoreEnv("npm_config_cache", previousCache);
    restoreEnv("npm_config_userconfig", previousUserconfig);
    restoreEnv("npm_execpath", previousNpmExecpath);
    restoreEnv("npm_node_execpath", previousNpmNodeExecpath);
    restoreEnv("npm_lifecycle_event", previousNpmLifecycleEvent);
    restoreEnv("npm_package_name", previousNpmPackageName);
    restoreEnv("PNPM_HOME", previousPnpmHome);
    restoreEnv("PNPM_STORE_PATH", previousPnpmStorePath);
  }

  const envEntries = fs
    .readFileSync(envLogPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(envEntries.length, 2, "expected --version and install env snapshots");
  for (const env of envEntries) {
    assert.match(
      String(env.npm_config_user_agent ?? ""),
      /^bun\//,
      `expected bun user-agent, got ${JSON.stringify(env.npm_config_user_agent)}`,
    );
    assert.equal(
      env.npm_config_registry,
      "https://registry.example.invalid/",
      "npm-compatible registry config must pass through to bun children",
    );
    assert.equal(env.npm_config_cache, undefined, "npm cache path must not leak to bun children");
    assert.equal(
      env.npm_config_userconfig,
      undefined,
      "npm userconfig path must not leak to bun children",
    );
    assert.equal(env.npm_execpath, undefined, "npm_execpath must not leak to bun children");
    assert.equal(
      env.npm_node_execpath,
      undefined,
      "npm_node_execpath must not leak to bun children",
    );
    assert.equal(
      env.npm_lifecycle_event,
      undefined,
      "npm_lifecycle_event must not leak to bun children",
    );
    assert.equal(env.npm_package_name, undefined, "npm_package_* must not leak to bun children");
    assert.equal(env.PNPM_HOME, undefined, "PNPM_HOME must not leak to bun children");
    assert.equal(env.PNPM_STORE_PATH, undefined, "PNPM_* variables must not leak to bun children");
  }
});

test("dependency setup rejects tracked source mutation", () => {
  const cwd = gitPackageFixture({ check: "node check.js" });
  fs.writeFileSync(path.join(cwd, "source.txt"), "original\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  fs.writeFileSync(path.join(cwd, "source.txt"), "candidate\n");

  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-mutating-npm-"));
  const npmPath = path.join(binDir, "npm.js");
  fs.writeFileSync(
    npmPath,
    `const fs = require("node:fs");
fs.writeFileSync("source.txt", "mutated\\n");
`,
  );

  assert.throws(
    () =>
      withMockCommand("npm", npmPath, () =>
        prepareTargetToolchain(cwd, {
          ...validationOptions("steipete/example", {
            toolchain: {
              packageManager: "npm",
              baseValidationCommands: ["npm test"],
              changedGate: null,
            },
          }),
          installTargetDeps: true,
          installTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
          setupTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
        }),
      ),
    /target dependency setup mutated checkout identity/,
  );
});

test("validation rejects scripts that mutate the checkout", () => {
  const cwd = gitPackageFixture({ verify: "node mutate.js" });
  fs.writeFileSync(
    path.join(cwd, "mutate.js"),
    "require('node:fs').writeFileSync('generated.txt', 'mutated\\n');\n",
  );
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  attachOrigin(cwd);
  fs.writeFileSync(path.join(cwd, "generated.txt"), "candidate\n");

  assert.throws(
    () =>
      runAllowedValidationCommands(
        ["pnpm verify"],
        cwd,
        validationOptions("steipete/example", {
          toolchain: {
            packageManager: "pnpm",
            baseValidationCommands: [],
            changedGate: null,
          },
        }),
      ),
    /unsafe validation command mutated checkout identity/,
  );
});

test("validation rejects scripts that mutate Git administrative state", () => {
  const cwd = gitPackageFixture({ verify: "node mutate-git.js" });
  fs.writeFileSync(
    path.join(cwd, "mutate-git.js"),
    [
      'const fs = require("node:fs");',
      'fs.mkdirSync(".git/hooks", { recursive: true });',
      'fs.writeFileSync(".git/hooks/pre-push", "#!/bin/sh\\nexit 0\\n");',
      "",
    ].join("\n"),
  );
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  attachOrigin(cwd);

  assert.throws(
    () =>
      runAllowedValidationCommands(
        ["pnpm verify"],
        cwd,
        validationOptions("steipete/example", {
          toolchain: {
            packageManager: "pnpm",
            baseValidationCommands: [],
            changedGate: null,
          },
        }),
      ),
    /unsafe validation command mutated checkout identity/,
  );
});

test("publication checkout bindings reject later Git administrative mutation", () => {
  const cwd = gitPackageFixture({ check: 'node -e ""' });
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  const binding = captureTargetCheckoutBinding(cwd);

  fs.writeFileSync(path.join(cwd, ".git", "hooks", "pre-push"), "#!/bin/sh\nexit 0\n");

  assert.throws(
    () => assertTargetCheckoutBinding(cwd, binding),
    /target checkout changed after validation/,
  );
});

test("checkout bindings ignore replacement refs and detect later replacement-ref mutation", () => {
  const cwd = gitPackageFixture({ check: 'node -e ""' });
  fs.writeFileSync(path.join(cwd, "source.txt"), "original\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "original");
  const originalHead = git(cwd, "rev-parse", "HEAD");
  const originalTree = git(cwd, "rev-parse", "HEAD^{tree}");

  fs.writeFileSync(path.join(cwd, "source.txt"), "replacement\n");
  git(cwd, "add", "source.txt");
  const replacementTree = git(cwd, "write-tree");
  const replacementCommit = git(cwd, "commit-tree", replacementTree, "-m", "replacement");
  git(cwd, "reset", "--hard", originalHead);
  git(cwd, "replace", originalHead, replacementCommit);

  const binding = captureTargetCheckoutBinding(cwd);
  assert.equal(binding.headSha, originalHead);
  assert.equal(binding.treeSha, originalTree);
  assert.notEqual(git(cwd, "rev-parse", "HEAD^{tree}"), originalTree);

  git(cwd, "replace", "-d", originalHead);
  assert.throws(
    () => assertTargetCheckoutBinding(cwd, binding),
    /target checkout changed after validation/,
  );
});

test("checkout bindings ignore unrelated sibling worktree refs", () => {
  const cwd = gitPackageFixture({ check: 'node -e ""' });
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  const sibling = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-binding-sibling-"));
  fs.rmSync(sibling, { recursive: true, force: true });
  git(cwd, "branch", "sibling");
  git(cwd, "worktree", "add", sibling, "sibling");
  const binding = captureTargetCheckoutBinding(cwd);

  fs.writeFileSync(path.join(sibling, "sibling.txt"), "unrelated\n");
  git(sibling, "add", ".");
  git(sibling, "commit", "-m", "unrelated sibling");

  assert.doesNotThrow(() => assertTargetCheckoutBinding(cwd, binding));
});

test("checkout identity capture quarantines transient Git objects", () => {
  const cwd = gitPackageFixture({ check: 'node -e ""' });
  fs.writeFileSync(path.join(cwd, "tracked.txt"), "initial\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  fs.writeFileSync(path.join(cwd, "tracked.txt"), "validated\n");
  fs.writeFileSync(path.join(cwd, "untracked.txt"), "validated\n");
  const before = git(cwd, "count-objects", "-v");

  const binding = captureTargetCheckoutBinding(cwd);

  assert.match(binding.contentTreeSha, /^[0-9a-f]{40,64}$/);
  assert.equal(git(cwd, "count-objects", "-v"), before);
});

test("final checkout binding preserves validated content across host commit", () => {
  const cwd = gitPackageFixture({ check: 'node -e ""' });
  fs.writeFileSync(path.join(cwd, "source.txt"), "initial\n");
  fs.writeFileSync(path.join(cwd, "deleted.txt"), "initial\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  fs.writeFileSync(path.join(cwd, "source.txt"), "validated\n");
  fs.writeFileSync(path.join(cwd, "new.txt"), "validated\n");
  fs.rmSync(path.join(cwd, "deleted.txt"));
  const accepted = captureTargetCheckoutBinding(cwd);

  git(cwd, "add", "--all");
  git(cwd, "commit", "-m", "validated");
  const expectedHead = git(cwd, "rev-parse", "HEAD");
  assert.equal(accepted.contentTreeSha, git(cwd, "rev-parse", "HEAD^{tree}"));
  assert.doesNotThrow(() => captureFinalTargetCheckoutBinding(cwd, accepted, expectedHead));

  fs.writeFileSync(path.join(cwd, "source.txt"), "late mutation\n");
  assert.throws(
    () => captureFinalTargetCheckoutBinding(cwd, accepted, expectedHead),
    /target checkout content changed after validation/,
  );
});

test("validation rejects hidden assume-unchanged and skip-worktree index entries", () => {
  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    const cwd = gitPackageFixture({ check: 'node -e ""' });
    fs.writeFileSync(path.join(cwd, "source.txt"), "initial\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "initial");
    git(cwd, "update-index", flag, "source.txt");

    assert.throws(
      () => captureTargetCheckoutBinding(cwd),
      /unsafe hidden target index entry: source\.txt/,
    );
  }
});

test("validation rejects target-local publication helpers and redirects", () => {
  const cases = [
    ["credential.helper", "!node credential-helper.js"],
    ["core.alternateRefsCommand", "node alternate-refs.js"],
    ["url.https://example.invalid/.insteadOf", "https://github.com/"],
    ["remote.origin.pushurl", "https://example.invalid/redirect.git"],
    ["http.proxy", "http://127.0.0.1:9"],
    ["core.sshCommand", "node ssh-command.js"],
  ];
  for (const [key, value] of cases) {
    const cwd = gitPackageFixture({ check: 'node -e ""' });
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "initial");
    git(cwd, "config", key, value);

    assert.throws(
      () => captureTargetCheckoutBinding(cwd),
      new RegExp(`unsafe target Git callback configuration: ${escapeRegExpForTest(key)}`, "i"),
    );
  }
});

test("repair commit plumbing bypasses target hooks and signing callbacks", () => {
  const cwd = gitPackageFixture({ check: 'node -e ""' });
  fs.writeFileSync(path.join(cwd, "source.txt"), "initial\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");

  const gitDir = path.resolve(cwd, git(cwd, "rev-parse", "--git-dir"));
  const hooksDir = path.join(gitDir, "hooks");
  const prepareMarker = path.join(cwd, "prepare-commit-msg-ran");
  const postMarker = path.join(cwd, "post-commit-ran");
  const referenceMarker = path.join(cwd, "reference-transaction-ran");
  const signingMarker = path.join(cwd, "signing-ran");
  const writeCallback = (filePath: string, marker: string, exitCode = 0) => {
    fs.writeFileSync(
      filePath,
      `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\nprocess.exit(${exitCode});\n`,
    );
    fs.chmodSync(filePath, 0o755);
  };
  writeCallback(path.join(hooksDir, "prepare-commit-msg"), prepareMarker);
  writeCallback(path.join(hooksDir, "post-commit"), postMarker);
  writeCallback(path.join(hooksDir, "reference-transaction"), referenceMarker);
  const signingProgram = path.join(hooksDir, "signing-program");
  writeCallback(signingProgram, signingMarker, 1);

  fs.writeFileSync(path.join(cwd, "source.txt"), "ordinary commit\n");
  git(cwd, "add", "source.txt");
  git(cwd, "-c", "commit.gpgSign=false", "commit", "-m", "ordinary commit");
  for (const marker of [prepareMarker, postMarker, referenceMarker]) {
    assert.equal(fs.existsSync(marker), true);
    fs.rmSync(marker);
  }

  git(cwd, "config", "commit.gpgSign", "true");
  git(cwd, "config", "gpg.format", "openpgp");
  git(cwd, "config", "gpg.program", signingProgram);
  fs.writeFileSync(path.join(cwd, "source.txt"), "validated\n");
  git(cwd, "add", "source.txt");
  assert.throws(() =>
    execFileSync("git", ["commit", "-m", "unsafe signed commit"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  assert.equal(fs.existsSync(signingMarker), true);
  fs.rmSync(signingMarker);
  fs.rmSync(prepareMarker);

  const commit = commitTargetCheckoutWithPlumbing({
    cwd,
    messages: ["validated repair", "Co-authored-by: Example <example@example.invalid>"],
    identity: {
      name: "clawsweeper",
      email: "274271284+clawsweeper[bot]@users.noreply.github.com",
    },
  });

  assert.equal(git(cwd, "rev-parse", "HEAD"), commit);
  assert.equal(git(cwd, "status", "--porcelain"), "");
  for (const marker of [prepareMarker, postMarker, referenceMarker, signingMarker]) {
    assert.equal(fs.existsSync(marker), false);
  }
  assert.match(git(cwd, "log", "-1", "--format=%B"), /validated repair/);
});

test("replacement branch plumbing bypasses checkout and reference hooks", () => {
  const cwd = gitPackageFixture({ check: 'node -e ""' });
  fs.writeFileSync(path.join(cwd, "source.txt"), "validated\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "validated");
  const head = git(cwd, "rev-parse", "HEAD");
  const tree = git(cwd, "rev-parse", "HEAD^{tree}");
  const hooksDir = path.join(cwd, ".git", "hooks");
  const checkoutMarker = path.join(cwd, "post-checkout-ran");
  const referenceMarker = path.join(cwd, "reference-transaction-ran");
  for (const [hook, marker] of [
    ["post-checkout", checkoutMarker],
    ["reference-transaction", referenceMarker],
  ]) {
    fs.writeFileSync(
      path.join(hooksDir, hook),
      `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
    );
    fs.chmodSync(path.join(hooksDir, hook), 0o755);
  }

  assert.equal(
    switchTargetBranchWithPlumbing({
      cwd,
      branch: "clawsweeper/replacement",
      expectedHeadSha: head,
    }),
    head,
  );

  assert.equal(git(cwd, "symbolic-ref", "--short", "HEAD"), "clawsweeper/replacement");
  assert.equal(git(cwd, "rev-parse", "HEAD"), head);
  assert.equal(git(cwd, "rev-parse", "HEAD^{tree}"), tree);
  assert.equal(git(cwd, "status", "--porcelain"), "");
  assert.equal(fs.existsSync(checkoutMarker), false);
  assert.equal(fs.existsSync(referenceMarker), false);
});

test("replacement branch plumbing restores overwritten refs when HEAD cannot switch", () => {
  const cwd = gitPackageFixture({ check: 'node -e ""' });
  fs.writeFileSync(path.join(cwd, "source.txt"), "first\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "first");
  const previousReplacement = git(cwd, "rev-parse", "HEAD");
  git(cwd, "branch", "clawsweeper/replacement", previousReplacement);
  fs.writeFileSync(path.join(cwd, "source.txt"), "second\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "second");
  const head = git(cwd, "rev-parse", "HEAD");
  const previousHeadRef = git(cwd, "symbolic-ref", "HEAD");
  const headLock = path.join(cwd, ".git", "HEAD.lock");
  fs.writeFileSync(headLock, "locked\n");

  try {
    assert.throws(
      () =>
        switchTargetBranchWithPlumbing({
          cwd,
          branch: "clawsweeper/replacement",
          expectedHeadSha: head,
        }),
      /HEAD\.lock|cannot lock ref|Unable to create/,
    );
  } finally {
    fs.rmSync(headLock, { force: true });
  }

  assert.equal(git(cwd, "symbolic-ref", "HEAD"), previousHeadRef);
  assert.equal(git(cwd, "rev-parse", "clawsweeper/replacement"), previousReplacement);
  assert.equal(git(cwd, "rev-parse", "HEAD"), head);
  assert.equal(git(cwd, "status", "--porcelain"), "");
});

test("replacement branch plumbing rejects branches attached to another worktree", () => {
  const cwd = gitPackageFixture({ check: 'node -e ""' });
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  const head = git(cwd, "rev-parse", "HEAD");
  const branch = "clawsweeper/occupied";
  const linkedWorktree = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-linked-worktree-"));
  fs.rmSync(linkedWorktree, { recursive: true, force: true });
  git(cwd, "branch", branch, head);
  git(cwd, "worktree", "add", linkedWorktree, branch);

  assert.throws(
    () =>
      switchTargetBranchWithPlumbing({
        cwd,
        branch,
        expectedHeadSha: head,
      }),
    /target branch is attached to another worktree/,
  );
  assert.equal(git(cwd, "symbolic-ref", "--short", "HEAD"), "main");
  assert.equal(git(linkedWorktree, "symbolic-ref", "--short", "HEAD"), branch);
  assert.equal(git(linkedWorktree, "rev-parse", "HEAD"), head);
});

test("checkpoint plumbing commits raw modified, added, and deleted worktree content", () => {
  const cwd = gitPackageFixture({ check: 'node -e ""' });
  fs.writeFileSync(path.join(cwd, "modified.txt"), "initial\n");
  fs.writeFileSync(path.join(cwd, "deleted.txt"), "initial\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");

  fs.writeFileSync(path.join(cwd, "modified.txt"), "validated\n");
  fs.writeFileSync(path.join(cwd, "added.txt"), "validated\n");
  fs.rmSync(path.join(cwd, "deleted.txt"));
  const result = createTargetCheckpointWithPlumbing({
    cwd,
    messages: ["checkpoint"],
    identity: {
      name: "clawsweeper",
      email: "274271284+clawsweeper[bot]@users.noreply.github.com",
    },
  });

  assert.equal(result.status, "committed");
  assert.equal(git(cwd, "status", "--porcelain"), "");
  assert.equal(git(cwd, "show", "HEAD:modified.txt"), "validated");
  assert.equal(git(cwd, "show", "HEAD:added.txt"), "validated");
  assert.throws(() =>
    execFileSync("git", ["show", "HEAD:deleted.txt"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  assert.equal(result.tree, git(cwd, "rev-parse", "HEAD^{tree}"));
});

test("checkpoint plumbing supports replacing a tracked file with a directory", () => {
  const cwd = gitPackageFixture({ check: 'node -e ""' });
  fs.writeFileSync(path.join(cwd, "shape"), "file\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");

  fs.rmSync(path.join(cwd, "shape"));
  fs.mkdirSync(path.join(cwd, "shape"));
  fs.writeFileSync(path.join(cwd, "shape", "child.txt"), "directory\n");
  const result = createTargetCheckpointWithPlumbing({
    cwd,
    messages: ["file to directory"],
    identity: {
      name: "clawsweeper",
      email: "274271284+clawsweeper[bot]@users.noreply.github.com",
    },
  });

  assert.equal(result.status, "committed");
  assert.equal(git(cwd, "cat-file", "-t", "HEAD:shape"), "tree");
  assert.equal(git(cwd, "show", "HEAD:shape/child.txt"), "directory");
  assert.equal(git(cwd, "status", "--porcelain"), "");
});

test("checkpoint plumbing supports replacing tracked descendants with a file", () => {
  const cwd = gitPackageFixture({ check: 'node -e ""' });
  fs.mkdirSync(path.join(cwd, "shape"));
  fs.writeFileSync(path.join(cwd, "shape", "child.txt"), "directory\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");

  fs.rmSync(path.join(cwd, "shape"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "shape"), "file\n");
  const result = createTargetCheckpointWithPlumbing({
    cwd,
    messages: ["directory to file"],
    identity: {
      name: "clawsweeper",
      email: "274271284+clawsweeper[bot]@users.noreply.github.com",
    },
  });

  assert.equal(result.status, "committed");
  assert.equal(git(cwd, "cat-file", "-t", "HEAD:shape"), "blob");
  assert.equal(git(cwd, "show", "HEAD:shape"), "file");
  assert.equal(git(cwd, "ls-tree", "-r", "--name-only", "HEAD", "shape/child.txt"), "");
  assert.equal(git(cwd, "status", "--porcelain"), "");
});

test("checkpoint plumbing preserves HEAD and index across lock failures", () => {
  for (const failure of ["index", "ref"]) {
    const cwd = gitPackageFixture({ check: 'node -e ""' });
    fs.writeFileSync(path.join(cwd, "source.txt"), "initial\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "initial");
    fs.writeFileSync(path.join(cwd, "source.txt"), "validated\n");
    const previousHead = git(cwd, "rev-parse", "HEAD");
    const previousIndex = fs.readFileSync(path.join(cwd, ".git", "index"));
    const lockPath =
      failure === "index"
        ? path.join(cwd, ".git", "index.lock")
        : `${path.resolve(
            cwd,
            git(cwd, "rev-parse", "--git-path", git(cwd, "symbolic-ref", "HEAD")),
          )}.lock`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, "locked\n");

    try {
      assert.throws(
        () =>
          createTargetCheckpointWithPlumbing({
            cwd,
            messages: [`${failure} failure`],
            identity: {
              name: "clawsweeper",
              email: "274271284+clawsweeper[bot]@users.noreply.github.com",
            },
          }),
        /lock|Unable to create/,
      );
    } finally {
      fs.rmSync(lockPath, { force: true });
    }

    assert.equal(git(cwd, "rev-parse", "HEAD"), previousHead);
    assert.deepEqual(fs.readFileSync(path.join(cwd, ".git", "index")), previousIndex);
    assert.equal(git(cwd, "status", "--porcelain"), "M source.txt");
  }
});

test("checkpoint plumbing uses canonical Git EOL normalization", () => {
  const cwd = gitPackageFixture({ check: 'node -e ""' });
  fs.writeFileSync(path.join(cwd, ".gitattributes"), "*.txt text eol=lf\n");
  fs.writeFileSync(path.join(cwd, "source.txt"), "initial\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");

  fs.writeFileSync(path.join(cwd, "source.txt"), "validated\r\ncontent\r\n");
  const result = createTargetCheckpointWithPlumbing({
    cwd,
    messages: ["canonical eol"],
    identity: {
      name: "clawsweeper",
      email: "274271284+clawsweeper[bot]@users.noreply.github.com",
    },
  });

  assert.equal(result.status, "committed");
  assert.equal(
    execFileSync("git", ["show", "HEAD:source.txt"], { cwd, encoding: "utf8" }),
    "validated\ncontent\n",
  );
  assert.equal(captureTargetCheckoutBinding(cwd).status, "");
});

test("checkpoint plumbing supports tracked filenames containing newlines", () => {
  const cwd = gitPackageFixture({ check: 'node -e ""' });
  const newlinePath = "line\nbreak.txt";
  fs.writeFileSync(path.join(cwd, newlinePath), "initial\n");
  git(cwd, "add", "--", newlinePath);
  git(cwd, "commit", "-m", "initial");

  fs.writeFileSync(path.join(cwd, newlinePath), "validated\n");
  const result = createTargetCheckpointWithPlumbing({
    cwd,
    messages: ["newline path"],
    identity: {
      name: "clawsweeper",
      email: "274271284+clawsweeper[bot]@users.noreply.github.com",
    },
  });

  assert.equal(result.status, "committed");
  assert.equal(git(cwd, "show", `HEAD:${newlinePath}`), "validated");
  assert.equal(git(cwd, "status", "--porcelain"), "");
});

test(
  "checkpoint plumbing honors disabled file mode and symlink materialization",
  { skip: process.platform === "win32" },
  () => {
    const cwd = gitPackageFixture({ check: 'node -e ""' });
    const scriptPath = path.join(cwd, "script.sh");
    const linkPath = path.join(cwd, "source-link");
    fs.writeFileSync(scriptPath, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(scriptPath, 0o644);
    fs.writeFileSync(path.join(cwd, "source.txt"), "initial\n");
    fs.symlinkSync("source.txt", linkPath);
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "initial");

    git(cwd, "config", "core.fileMode", "false");
    git(cwd, "config", "core.symlinks", "false");
    fs.chmodSync(scriptPath, 0o755);
    fs.rmSync(linkPath);
    fs.writeFileSync(linkPath, "source.txt");
    fs.writeFileSync(path.join(cwd, "source.txt"), "validated\n");
    const result = createTargetCheckpointWithPlumbing({
      cwd,
      messages: ["preserve configured modes"],
      identity: {
        name: "clawsweeper",
        email: "274271284+clawsweeper[bot]@users.noreply.github.com",
      },
    });

    assert.equal(result.status, "committed");
    assert.match(git(cwd, "ls-tree", "HEAD", "script.sh"), /^100644 blob /);
    assert.match(git(cwd, "ls-tree", "HEAD", "source-link"), /^120000 blob /);
    assert.equal(git(cwd, "show", "HEAD:source-link"), "source.txt");
    assert.equal(captureTargetCheckoutBinding(cwd).status, "");
  },
);

test("checkpoint plumbing rejects mismatched and dirty submodules", () => {
  const submoduleRepo = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-submodule-source-"));
  git(submoduleRepo, "init", "-b", "main");
  git(submoduleRepo, "config", "user.email", "clawsweeper@example.invalid");
  git(submoduleRepo, "config", "user.name", "ClawSweeper Test");
  fs.writeFileSync(path.join(submoduleRepo, "source.txt"), "initial\n");
  git(submoduleRepo, "add", ".");
  git(submoduleRepo, "commit", "-m", "initial");
  const indexedCommit = git(submoduleRepo, "rev-parse", "HEAD");

  const cwd = gitPackageFixture({ check: 'node -e ""' });
  git(cwd, "-c", "protocol.file.allow=always", "submodule", "add", submoduleRepo, "vendor/lib");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  const submodulePath = path.join(cwd, "vendor/lib");

  fs.writeFileSync(path.join(submoduleRepo, "source.txt"), "second\n");
  git(submoduleRepo, "add", ".");
  git(submoduleRepo, "commit", "-m", "second");
  const secondCommit = git(submoduleRepo, "rev-parse", "HEAD");
  git(submodulePath, "fetch", "origin");
  git(submodulePath, "checkout", secondCommit);
  assert.throws(
    () =>
      createTargetCheckpointWithPlumbing({
        cwd,
        messages: ["mismatched submodule"],
        identity: {
          name: "clawsweeper",
          email: "274271284+clawsweeper[bot]@users.noreply.github.com",
        },
      }),
    /target submodule HEAD does not match indexed gitlink: vendor\/lib/,
  );

  git(submodulePath, "checkout", indexedCommit);
  fs.writeFileSync(path.join(submodulePath, "source.txt"), "dirty\n");
  assert.throws(
    () =>
      createTargetCheckpointWithPlumbing({
        cwd,
        messages: ["dirty submodule"],
        identity: {
          name: "clawsweeper",
          email: "274271284+clawsweeper[bot]@users.noreply.github.com",
        },
      }),
    /target submodule worktree is dirty: vendor\/lib/,
  );
});

test("checkpoint plumbing rejects residual repositories at removed gitlinks", () => {
  const submoduleRepo = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-residual-source-"));
  git(submoduleRepo, "init", "-b", "main");
  git(submoduleRepo, "config", "user.email", "clawsweeper@example.invalid");
  git(submoduleRepo, "config", "user.name", "ClawSweeper Test");
  fs.writeFileSync(path.join(submoduleRepo, "source.txt"), "initial\n");
  git(submoduleRepo, "add", ".");
  git(submoduleRepo, "commit", "-m", "initial");

  const cwd = gitPackageFixture({ check: 'node -e ""' });
  git(cwd, "-c", "protocol.file.allow=always", "submodule", "add", submoduleRepo, "vendor/lib");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  git(cwd, "rm", "--cached", "vendor/lib");

  assert.throws(
    () =>
      createTargetCheckpointWithPlumbing({
        cwd,
        messages: ["removed gitlink"],
        identity: {
          name: "clawsweeper",
          email: "274271284+clawsweeper[bot]@users.noreply.github.com",
        },
      }),
    /residual target repository at removed gitlink path: vendor\/lib/,
  );
});

test("checkpoint plumbing recursively rejects ignored nested submodule dirt", () => {
  const nestedRepo = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-nested-source-"));
  git(nestedRepo, "init", "-b", "main");
  git(nestedRepo, "config", "user.email", "clawsweeper@example.invalid");
  git(nestedRepo, "config", "user.name", "ClawSweeper Test");
  fs.writeFileSync(path.join(nestedRepo, "source.txt"), "nested\n");
  git(nestedRepo, "add", ".");
  git(nestedRepo, "commit", "-m", "nested");

  const middleRepo = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-middle-source-"));
  git(middleRepo, "init", "-b", "main");
  git(middleRepo, "config", "user.email", "clawsweeper@example.invalid");
  git(middleRepo, "config", "user.name", "ClawSweeper Test");
  git(
    middleRepo,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    nestedRepo,
    "vendor/nested",
  );
  git(middleRepo, "add", ".");
  git(middleRepo, "commit", "-m", "middle");

  const cwd = gitPackageFixture({ check: 'node -e ""' });
  git(cwd, "-c", "protocol.file.allow=always", "submodule", "add", middleRepo, "vendor/middle");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "root");
  git(cwd, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive");
  const middlePath = path.join(cwd, "vendor/middle");
  const nestedPath = path.join(middlePath, "vendor/nested");
  git(cwd, "config", "diff.ignoreSubmodules", "all");
  git(cwd, "config", "submodule.vendor/middle.ignore", "all");
  git(middlePath, "config", "diff.ignoreSubmodules", "all");
  git(middlePath, "config", "submodule.vendor/nested.ignore", "all");
  fs.writeFileSync(path.join(nestedPath, "source.txt"), "dirty nested worktree\n");

  assert.throws(
    () =>
      createTargetCheckpointWithPlumbing({
        cwd,
        messages: ["must reject hidden nested dirt"],
        identity: {
          name: "clawsweeper",
          email: "274271284+clawsweeper[bot]@users.noreply.github.com",
        },
      }),
    /target submodule worktree is dirty: vendor\/middle\/vendor\/nested/,
  );
});

test("checkpoint plumbing preserves clean uninitialized gitlinks", () => {
  const submoduleRepo = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-submodule-source-"));
  git(submoduleRepo, "init", "-b", "main");
  git(submoduleRepo, "config", "user.email", "clawsweeper@example.invalid");
  git(submoduleRepo, "config", "user.name", "ClawSweeper Test");
  fs.writeFileSync(path.join(submoduleRepo, "source.txt"), "initial\n");
  git(submoduleRepo, "add", ".");
  git(submoduleRepo, "commit", "-m", "initial");

  const cwd = gitPackageFixture({ check: 'node -e ""' });
  git(cwd, "-c", "protocol.file.allow=always", "submodule", "add", submoduleRepo, "vendor/lib");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  const gitlink = git(cwd, "ls-tree", "HEAD", "vendor/lib");
  const identity = {
    name: "clawsweeper",
    email: "274271284+clawsweeper[bot]@users.noreply.github.com",
  };

  fs.rmSync(path.join(cwd, "vendor/lib"), { recursive: true, force: true });
  fs.mkdirSync(path.join(cwd, "vendor/lib"), { recursive: true });
  const emptyResult = createTargetCheckpointWithPlumbing({
    cwd,
    messages: ["empty uninitialized submodule"],
    identity,
  });
  assert.equal(emptyResult.status, "unchanged");
  assert.equal(git(cwd, "ls-tree", "HEAD", "vendor/lib"), gitlink);
  assert.equal(git(cwd, "status", "--porcelain"), "");

  fs.rmSync(path.join(cwd, "vendor/lib"), { recursive: true, force: true });
  const absentResult = createTargetCheckpointWithPlumbing({
    cwd,
    messages: ["absent uninitialized submodule"],
    identity,
  });
  assert.equal(absentResult.status, "unchanged");
  assert.equal(git(cwd, "ls-tree", "HEAD", "vendor/lib"), gitlink);

  git(cwd, "rm", "--cached", "vendor/lib");
  const deletedResult = createTargetCheckpointWithPlumbing({
    cwd,
    messages: ["delete staged submodule"],
    identity,
  });
  assert.equal(deletedResult.status, "committed");
  assert.equal(git(cwd, "ls-tree", "HEAD", "vendor/lib"), "");
  assert.equal(git(cwd, "status", "--porcelain"), "");
});

test("checkpoint plumbing preserves unchanged filtered blob OIDs", () => {
  const cwd = gitPackageFixture({ check: 'node -e ""' });
  const filterRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-filter-"));
  const cleanFilter = path.join(filterRoot, "clean.js");
  const smudgeFilter = path.join(filterRoot, "smudge.js");
  fs.writeFileSync(
    cleanFilter,
    `process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("pointer\\n"));\n`,
  );
  fs.writeFileSync(
    smudgeFilter,
    `process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("expanded\\n"));\n`,
  );
  git(cwd, "config", "filter.fixture.clean", `${process.execPath} ${cleanFilter}`);
  git(cwd, "config", "filter.fixture.smudge", `${process.execPath} ${smudgeFilter}`);
  fs.writeFileSync(path.join(cwd, ".gitattributes"), "*.asset filter=fixture\n");
  fs.writeFileSync(path.join(cwd, "model.asset"), "source\n");
  fs.writeFileSync(path.join(cwd, "source.txt"), "initial\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  const filteredOid = git(cwd, "rev-parse", "HEAD:model.asset");
  fs.rmSync(path.join(cwd, "model.asset"));
  git(cwd, "checkout", "--", "model.asset");
  git(cwd, "config", "--unset-all", "filter.fixture.clean");
  git(cwd, "config", "--unset-all", "filter.fixture.smudge");

  fs.writeFileSync(path.join(cwd, "source.txt"), "validated\n");
  const result = createTargetCheckpointWithPlumbing({
    cwd,
    messages: ["preserve filtered blob"],
    identity: {
      name: "clawsweeper",
      email: "274271284+clawsweeper[bot]@users.noreply.github.com",
    },
  });

  assert.equal(result.status, "committed");
  assert.equal(git(cwd, "rev-parse", "HEAD:model.asset"), filteredOid);
  assert.equal(fs.readFileSync(path.join(cwd, "model.asset"), "utf8"), "expanded\n");
  assert.equal(captureTargetCheckoutBinding(cwd).status, "");
});

test("checkpoint plumbing rejects changed external filters and working-tree encodings", () => {
  for (const [attributes, expected] of [
    ["*.asset filter=fixture\n", /unsafe changed target Git filter attribute: model\.asset/],
    [
      "*.asset working-tree-encoding=UTF-16\n",
      /unsafe changed target Git working-tree-encoding attribute: model\.asset/,
    ],
  ]) {
    const cwd = gitPackageFixture({ check: 'node -e ""' });
    const encoded = attributes.includes("working-tree-encoding");
    const encodedText = (value: string) =>
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(value, "utf16le")]);
    fs.writeFileSync(path.join(cwd, ".gitattributes"), attributes);
    fs.writeFileSync(
      path.join(cwd, "model.asset"),
      encoded ? encodedText("initial\n") : "initial\n",
    );
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "initial");
    fs.writeFileSync(
      path.join(cwd, "model.asset"),
      encoded ? encodedText("changed\n") : "changed\n",
    );

    assert.throws(
      () =>
        createTargetCheckpointWithPlumbing({
          cwd,
          messages: ["unsafe filtered change"],
          identity: {
            name: "clawsweeper",
            email: "274271284+clawsweeper[bot]@users.noreply.github.com",
          },
        }),
      expected,
    );
  }
});

test("recovery materializes an exact fetched commit without running target hooks", () => {
  const cwd = gitPackageFixture({ check: 'node -e ""' });
  fs.writeFileSync(path.join(cwd, "source.txt"), "base\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "base");
  const previousHead = git(cwd, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(cwd, "source.txt"), "recovered\n");
  git(cwd, "commit", "-am", "recovered");
  const recoveredHead = git(cwd, "rev-parse", "HEAD");
  git(cwd, "reset", "--hard", previousHead);

  const marker = path.join(cwd, "post-checkout-ran");
  const hook = path.join(cwd, ".git", "hooks", "post-checkout");
  fs.writeFileSync(
    hook,
    `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
  );
  fs.chmodSync(hook, 0o755);

  const result = materializeTargetCommitWithIsolation({
    cwd,
    expectedHeadSha: recoveredHead,
  });

  assert.equal(result.previous_head, previousHead);
  assert.equal(result.current_head, recoveredHead);
  assert.equal(git(cwd, "rev-parse", "HEAD"), recoveredHead);
  assert.equal(fs.readFileSync(path.join(cwd, "source.txt"), "utf8"), "recovered\n");
  assert.equal(fs.existsSync(marker), false);
});

test("verified target rebase and continuation do not run target hooks", () => {
  const cwd = gitPackageFixture({ check: 'node -e ""' });
  fs.writeFileSync(path.join(cwd, "shared.txt"), "base\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "base");
  git(cwd, "checkout", "-b", "feature");
  fs.writeFileSync(path.join(cwd, "shared.txt"), "feature\n");
  git(cwd, "commit", "-am", "feature");
  git(cwd, "checkout", "main");
  fs.writeFileSync(path.join(cwd, "shared.txt"), "main\n");
  git(cwd, "commit", "-am", "main");
  const updatedBase = git(cwd, "rev-parse", "HEAD");
  git(cwd, "checkout", "feature");
  const previousHead = git(cwd, "rev-parse", "HEAD");

  const marker = path.join(cwd, "rebase-hook-ran");
  for (const hookName of ["pre-rebase", "post-rewrite"]) {
    const hook = path.join(cwd, ".git", "hooks", hookName);
    fs.writeFileSync(
      hook,
      `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(hookName)});\n`,
    );
    fs.chmodSync(hook, 0o755);
  }

  const result = rebaseTargetOntoVerifiedBase({ cwd, baseRef: updatedBase });
  assert.equal(result.status, "conflicts");
  assert.equal(result.base_sha, updatedBase);
  assert.equal(result.previous_head, previousHead);
  fs.writeFileSync(path.join(cwd, "shared.txt"), "main\nfeature\n");
  const completed = completeTargetRebaseWithIsolation({ cwd });

  assert.equal(completed.status, "continued");
  git(cwd, "merge-base", "--is-ancestor", updatedBase, "HEAD");
  assert.equal(fs.existsSync(marker), false);
});

test("isolated rebase continuation rejects an aborted reconciliation", () => {
  const cwd = gitPackageFixture({ check: 'node -e ""' });
  fs.writeFileSync(path.join(cwd, "shared.txt"), "base\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "base");
  git(cwd, "checkout", "-b", "feature");
  fs.writeFileSync(path.join(cwd, "shared.txt"), "feature\n");
  git(cwd, "commit", "-am", "feature");
  git(cwd, "checkout", "main");
  fs.writeFileSync(path.join(cwd, "shared.txt"), "main\n");
  git(cwd, "commit", "-am", "main");
  const updatedBase = git(cwd, "rev-parse", "HEAD");
  git(cwd, "checkout", "feature");
  assert.equal(rebaseTargetOntoVerifiedBase({ cwd, baseRef: updatedBase }).status, "conflicts");
  git(cwd, "rebase", "--abort");

  assert.throws(
    () =>
      completeTargetRebaseWithIsolation({
        cwd,
        expectedBaseRef: updatedBase,
        requireInProgress: true,
      }),
    /target rebase was aborted or completed outside the isolated continuation/,
  );
});

test("isolated rebase continuation skips a commit emptied by conflict resolution", () => {
  const cwd = gitPackageFixture({ check: 'node -e ""' });
  fs.writeFileSync(path.join(cwd, "shared.txt"), "base\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "base");
  git(cwd, "checkout", "-b", "feature");
  fs.writeFileSync(path.join(cwd, "shared.txt"), "feature\n");
  git(cwd, "commit", "-am", "feature");
  git(cwd, "checkout", "main");
  fs.writeFileSync(path.join(cwd, "shared.txt"), "main\n");
  git(cwd, "commit", "-am", "main");
  const updatedBase = git(cwd, "rev-parse", "HEAD");
  git(cwd, "checkout", "feature");
  assert.equal(rebaseTargetOntoVerifiedBase({ cwd, baseRef: updatedBase }).status, "conflicts");
  fs.writeFileSync(path.join(cwd, "shared.txt"), "main\n");

  const completed = completeTargetRebaseWithIsolation({
    cwd,
    expectedBaseRef: updatedBase,
    requireInProgress: true,
  });

  assert.equal(completed.status, "continued");
  assert.equal(git(cwd, "rev-parse", "HEAD"), updatedBase);
  assert.equal(git(cwd, "status", "--porcelain"), "");
});

test(
  "checkpoint plumbing preserves executable-bit-only worktree changes",
  { skip: process.platform === "win32" },
  () => {
    const cwd = gitPackageFixture({ check: 'node -e ""' });
    const executablePath = path.join(cwd, "script.sh");
    fs.writeFileSync(executablePath, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(executablePath, 0o644);
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "initial");
    const identity = {
      name: "clawsweeper",
      email: "274271284+clawsweeper[bot]@users.noreply.github.com",
    };

    fs.chmodSync(executablePath, 0o755);
    const added = createTargetCheckpointWithPlumbing({
      cwd,
      messages: ["make executable"],
      identity,
    });
    assert.equal(added.status, "committed");
    assert.match(git(cwd, "ls-tree", "HEAD", "script.sh"), /^100755 blob /);
    assert.equal(git(cwd, "status", "--porcelain"), "");

    fs.chmodSync(executablePath, 0o644);
    const removed = createTargetCheckpointWithPlumbing({
      cwd,
      messages: ["remove executable"],
      identity,
    });
    assert.equal(removed.status, "committed");
    assert.match(git(cwd, "ls-tree", "HEAD", "script.sh"), /^100644 blob /);
    assert.equal(git(cwd, "status", "--porcelain"), "");
  },
);

test("history compaction preserves the reviewed tree without target ref hooks", () => {
  const cwd = gitPackageFixture({ check: 'node -e ""' });
  fs.writeFileSync(path.join(cwd, "source.txt"), "initial\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  const baseSha = git(cwd, "rev-parse", "HEAD");
  const identity = {
    name: "clawsweeper",
    email: "274271284+clawsweeper[bot]@users.noreply.github.com",
  };

  fs.writeFileSync(path.join(cwd, "source.txt"), "first\n");
  createTargetCheckpointWithPlumbing({ cwd, messages: ["first"], identity });
  fs.writeFileSync(path.join(cwd, "source.txt"), "second\n");
  createTargetCheckpointWithPlumbing({ cwd, messages: ["second"], identity });
  const reviewedTree = git(cwd, "rev-parse", "HEAD^{tree}");

  const marker = path.join(cwd, "reference-transaction-ran");
  const hook = path.join(cwd, ".git", "hooks", "reference-transaction");
  fs.writeFileSync(
    hook,
    `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
  );
  fs.chmodSync(hook, 0o755);
  const result = compactTargetHistoryWithPlumbing({
    cwd,
    baseRef: baseSha,
    messages: ["compacted"],
    identity,
  });

  assert.equal(result.status, "compacted");
  assert.equal(result.previous_commit_count, 2);
  assert.equal(git(cwd, "rev-list", "--count", `${baseSha}..HEAD`), "1");
  assert.equal(git(cwd, "rev-parse", "HEAD^{tree}"), reviewedTree);
  assert.equal(git(cwd, "status", "--porcelain"), "");
  assert.equal(fs.existsSync(marker), false);
});

test(
  "history compaction leaves HEAD unchanged when result verification fails",
  { skip: process.platform === "win32" },
  () => {
    const cwd = gitPackageFixture({ check: 'node -e ""' });
    fs.writeFileSync(path.join(cwd, "source.txt"), "initial\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "initial");
    const baseSha = git(cwd, "rev-parse", "HEAD");
    const identity = {
      name: "clawsweeper",
      email: "274271284+clawsweeper[bot]@users.noreply.github.com",
    };
    fs.writeFileSync(path.join(cwd, "source.txt"), "first\n");
    createTargetCheckpointWithPlumbing({ cwd, messages: ["first"], identity });
    fs.writeFileSync(path.join(cwd, "source.txt"), "second\n");
    createTargetCheckpointWithPlumbing({ cwd, messages: ["second"], identity });
    const previousHead = git(cwd, "rev-parse", "HEAD");

    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-git-verify-failure-"));
    const marker = path.join(binDir, "commit-created");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeNodeCommandShim(
      binDir,
      "git",
      `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (fs.existsSync(${JSON.stringify(marker)}) && args.includes("rev-parse") && args.some((arg) => arg.endsWith("^{tree}"))) {
  process.exit(91);
}
const input = fs.readFileSync(0);
const result = spawnSync(${JSON.stringify(realGit)}, args, {
  cwd: process.cwd(),
  env: process.env,
  input,
  encoding: null
});
if (result.stdout) fs.writeSync(1, result.stdout);
if (result.stderr) fs.writeSync(2, result.stderr);
if (result.status === 0 && args.includes("commit-tree")) {
  fs.writeFileSync(${JSON.stringify(marker)}, "created");
}
process.exit(result.status ?? 1);
`,
    );

    assert.throws(
      () =>
        withPathOnlyPrefix(binDir, () =>
          compactTargetHistoryWithPlumbing({
            cwd,
            baseRef: baseSha,
            messages: ["compacted"],
            identity,
          }),
        ),
      /git exited 91/,
    );
    assert.equal(git(cwd, "rev-parse", "HEAD"), previousHead);
    assert.equal(git(cwd, "status", "--porcelain"), "");
  },
);

test("Git identity probes reject target fsmonitor callbacks without executing them", () => {
  const cwd = gitPackageFixture({ check: 'node -e ""' });
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  const marker = path.join(cwd, "fsmonitor-ran");
  const helper = path.join(cwd, "fsmonitor.js");
  fs.writeFileSync(
    helper,
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, process.env.OPENAI_API_KEY ?? "missing");\n`,
  );
  git(cwd, "config", "core.fsmonitor", `${process.execPath} ${helper}`);

  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "must-not-reach-fsmonitor";
  try {
    assert.throws(
      () => captureTargetCheckoutBinding(cwd),
      /unsafe target Git callback configuration: core\.fsmonitor/,
    );
    assert.equal(fs.existsSync(marker), false);
  } finally {
    restoreEnv("OPENAI_API_KEY", previous);
  }
});

test(
  "validation accepts tracked node_modules workspace links back to the checkout",
  { skip: process.platform === "win32" },
  () => {
    const cwd = gitPackageFixture({ check: 'node -e ""' });
    const packagePath = path.join(cwd, "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    packageJson.name = "openclaw";
    fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    fs.writeFileSync(path.join(cwd, "source.txt"), "initial\n");
    const workspaceModules = path.join(cwd, "packages", "speech-core", "node_modules");
    fs.mkdirSync(workspaceModules, { recursive: true });
    fs.symlinkSync("../../..", path.join(workspaceModules, "openclaw"));
    git(cwd, "add", "--force", ".");
    git(cwd, "commit", "-m", "initial");

    const first = captureTargetCheckoutBinding(cwd);
    const second = captureTargetCheckoutBinding(cwd);

    assert.deepEqual(second, first);
    fs.writeFileSync(path.join(cwd, "source.txt"), "changed\n");
    assert.throws(
      () => assertTargetCheckoutBinding(cwd, first),
      /target checkout changed after validation/,
    );
  },
);

test(
  "validation accepts tracked scoped node_modules workspace links back to the checkout",
  { skip: process.platform === "win32" },
  () => {
    const cwd = gitPackageFixture({ check: 'node -e ""' });
    const packagePath = path.join(cwd, "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    packageJson.name = "@openclaw/root";
    fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    const workspaceScope = path.join(cwd, "packages", "speech-core", "node_modules", "@openclaw");
    fs.mkdirSync(workspaceScope, { recursive: true });
    fs.symlinkSync("../../../..", path.join(workspaceScope, "root"));
    git(cwd, "add", "--force", ".");
    git(cwd, "commit", "-m", "initial");

    const first = captureTargetCheckoutBinding(cwd);

    assert.deepEqual(captureTargetCheckoutBinding(cwd), first);
  },
);

test(
  "validation rejects untracked node_modules workspace self-links",
  { skip: process.platform === "win32" },
  () => {
    const cwd = gitPackageFixture({ check: 'node -e ""' });
    fs.rmSync(path.join(cwd, ".gitignore"));
    const packagePath = path.join(cwd, "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    packageJson.name = "openclaw";
    fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "initial");
    const workspaceModules = path.join(cwd, "packages", "speech-core", "node_modules");
    fs.mkdirSync(workspaceModules, { recursive: true });
    fs.symlinkSync("../../..", path.join(workspaceModules, "openclaw"));

    assert.throws(() => captureTargetCheckoutBinding(cwd), /validation identity directory cycle/);
  },
);

test(
  "validation rejects workspace self-links with untracked target manifests",
  { skip: process.platform === "win32" },
  () => {
    const cwd = gitPackageFixture({ check: 'node -e ""' });
    const targetDir = path.join(cwd, "packages", "root-package");
    const targetModules = path.join(targetDir, "node_modules");
    fs.mkdirSync(targetModules, { recursive: true });
    fs.writeFileSync(
      path.join(targetDir, "package.json"),
      `${JSON.stringify({ name: "root-package" }, null, 2)}\n`,
    );
    const linkPath = path.join(targetModules, "root-package");
    fs.symlinkSync("..", linkPath);
    git(cwd, "add", ".gitignore", "package.json");
    git(cwd, "add", "--force", linkPath);
    git(cwd, "commit", "-m", "initial");

    assert.throws(() => captureTargetCheckoutBinding(cwd), /validation identity directory cycle/);
  },
);

test(
  "validation rejects node_modules self-links with mismatched package identities",
  { skip: process.platform === "win32" },
  () => {
    const cwd = gitPackageFixture({ check: 'node -e ""' });
    const packagePath = path.join(cwd, "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    packageJson.name = "openclaw";
    fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    const workspaceModules = path.join(cwd, "packages", "speech-core", "node_modules");
    fs.mkdirSync(workspaceModules, { recursive: true });
    fs.symlinkSync("../../..", path.join(workspaceModules, "not-openclaw"));
    git(cwd, "add", "--force", ".");
    git(cwd, "commit", "-m", "initial");

    assert.throws(() => captureTargetCheckoutBinding(cwd), /validation identity directory cycle/);
  },
);

test(
  "validation rejects scoped self-links outside node_modules",
  { skip: process.platform === "win32" },
  () => {
    const cwd = gitPackageFixture({ check: 'node -e ""' });
    const packagePath = path.join(cwd, "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    packageJson.name = "@openclaw/root";
    fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    const scopedPackage = path.join(cwd, "@openclaw");
    fs.mkdirSync(scopedPackage, { recursive: true });
    fs.symlinkSync("..", path.join(scopedPackage, "root"));
    git(cwd, "add", "--force", ".");
    git(cwd, "commit", "-m", "initial");

    assert.throws(() => captureTargetCheckoutBinding(cwd), /validation identity directory cycle/);
  },
);

test(
  "validation rejects tracked symlinks that escape the target checkout",
  { skip: process.platform === "win32" },
  () => {
    const cwd = gitPackageFixture({ check: 'node -e ""' });
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-external-target-"));
    const externalFile = path.join(externalDir, "outside.txt");
    fs.writeFileSync(externalFile, "outside\n");
    fs.symlinkSync(externalFile, path.join(cwd, "outside-link"));
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "initial");
    attachOrigin(cwd);

    assert.throws(
      () =>
        runAllowedValidationCommands(
          ["pnpm check"],
          cwd,
          validationOptions("steipete/example", {
            toolchain: {
              packageManager: "pnpm",
              baseValidationCommands: [],
              changedGate: null,
            },
          }),
        ),
      /validation symlink escapes target checkout/,
    );
  },
);

test("failing fallback validation still verifies checkout identity", () => {
  const cwd = gitPackageFixture({
    "check:changed": "node check.js",
    "test:serial": "node --test",
  });
  fs.mkdirSync(path.join(cwd, "test"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "test", "example.test.ts"), "export const value = 1;\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  attachOrigin(cwd);
  fs.writeFileSync(path.join(cwd, "test", "example.test.ts"), "export const value = 2;\n");

  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-fallback-mutation-"));
  const pnpmPath = path.join(binDir, "pnpm.js");
  fs.writeFileSync(
    pnpmPath,
    `const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("check:changed")) {
  console.error("terminating stalled Vitest process");
  process.exit(1);
}
fs.writeFileSync("test/example.test.ts", "export const value = 3;\\n");
console.error("fallback failed");
process.exit(1);
`,
  );

  assert.throws(
    () =>
      withMockCommand("pnpm", pnpmPath, () =>
        runAllowedValidationCommands(
          ["pnpm check:changed"],
          cwd,
          validationOptions("openclaw/openclaw", { pinnedBaseRef: "origin/main" }),
        ),
      ),
    /unsafe validation command mutated checkout identity/,
  );
});

test("pnpm lockfile fallback requires a final frozen reinstall", () => {
  const cwd = gitPackageFixture({ check: "node check.js" });
  fs.writeFileSync(path.join(cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");

  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-pnpm-reinstall-"));
  const corepackPath = path.join(binDir, "corepack.js");
  const pnpmPath = path.join(binDir, "pnpm.js");
  const logPath = path.join(binDir, "pnpm.log");
  fs.writeFileSync(corepackPath, "");
  fs.writeFileSync(
    pnpmPath,
    `const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, args.join(" ") + "\\n");
if (args.includes("--frozen-lockfile")) {
  console.error("ERR_PNPM_OUTDATED_LOCKFILE");
  process.exit(1);
}
`,
  );

  assert.throws(
    () =>
      withMockCommand("corepack", corepackPath, () =>
        withMockCommand("pnpm", pnpmPath, () =>
          prepareTargetToolchain(cwd, {
            ...validationOptions("steipete/example", {
              toolchain: {
                packageManager: "pnpm",
                baseValidationCommands: ["pnpm check"],
                changedGate: null,
              },
            }),
            installTargetDeps: true,
            installTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
            setupTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
          }),
        ),
      ),
    /ERR_PNPM_OUTDATED_LOCKFILE/,
  );

  assert.deepEqual(fs.readFileSync(logPath, "utf8").trim().split(/\r?\n/), [
    "install --frozen-lockfile --prefer-offline --ignore-scripts --ignore-pnpmfile --config.registry=https://registry.npmjs.org/ --config.engine-strict=false --config.enable-pre-post-scripts=false",
    "install --no-frozen-lockfile --prefer-offline --ignore-scripts --ignore-pnpmfile --config.registry=https://registry.npmjs.org/ --config.engine-strict=false --config.enable-pre-post-scripts=false",
    "install --frozen-lockfile --prefer-offline --ignore-scripts --ignore-pnpmfile --config.registry=https://registry.npmjs.org/ --config.engine-strict=false --config.enable-pre-post-scripts=false",
  ]);
});

test("pnpm lockfile fallback restores a pre-existing untracked lockfile exactly", () => {
  const cwd = gitPackageFixture({ check: "node check.js" });
  const lockfilePath = path.join(cwd, "pnpm-lock.yaml");
  const originalLockfile = "lockfileVersion: '9.0'\n# local candidate\n";
  fs.writeFileSync(lockfilePath, originalLockfile);
  git(cwd, "add", "package.json", ".gitignore");
  git(cwd, "commit", "-m", "initial");

  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-pnpm-restore-"));
  const corepackPath = path.join(binDir, "corepack.js");
  const pnpmPath = path.join(binDir, "pnpm.js");
  const countPath = path.join(binDir, "count");
  fs.writeFileSync(corepackPath, "");
  fs.writeFileSync(
    pnpmPath,
    `const fs = require("node:fs");
const count = fs.existsSync(${JSON.stringify(countPath)})
  ? Number(fs.readFileSync(${JSON.stringify(countPath)}, "utf8"))
  : 0;
fs.writeFileSync(${JSON.stringify(countPath)}, String(count + 1));
if (count === 0) {
  fs.writeFileSync("pnpm-lock.yaml", "generated\\n");
  console.error("ERR_PNPM_OUTDATED_LOCKFILE");
  process.exit(1);
}
if (count === 1) {
  fs.writeFileSync("pnpm-lock.yaml", "fallback\\n");
  process.exit(0);
}
if (fs.readFileSync("pnpm-lock.yaml", "utf8") !== ${JSON.stringify(originalLockfile)}) {
  process.exit(9);
}
`,
  );

  withMockCommand("corepack", corepackPath, () =>
    withMockCommand("pnpm", pnpmPath, () =>
      prepareTargetToolchain(cwd, {
        ...validationOptions("steipete/example", {
          toolchain: {
            packageManager: "pnpm",
            baseValidationCommands: ["pnpm check"],
            changedGate: null,
          },
        }),
        installTargetDeps: true,
        installTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
        setupTimeoutMs: FAKE_TOOLCHAIN_TIMEOUT_MS,
      }),
    ),
  );

  assert.equal(fs.readFileSync(lockfilePath, "utf8"), originalLockfile);
  assert.equal(fs.readFileSync(countPath, "utf8"), "3");
});

test("target setup shares one deadline across probes and installs", () => {
  const cwd = gitPackageFixture({ check: "node check.js" });
  fs.writeFileSync(path.join(cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");

  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-setup-deadline-"));
  const corepackPath = path.join(binDir, "corepack.js");
  const pnpmPath = path.join(binDir, "pnpm.js");
  const corepackCountPath = path.join(binDir, "corepack-count");
  const pnpmMarkerPath = path.join(binDir, "pnpm-ran");
  fs.writeFileSync(
    corepackPath,
    `const fs = require("node:fs");
const count = fs.existsSync(${JSON.stringify(corepackCountPath)})
  ? Number(fs.readFileSync(${JSON.stringify(corepackCountPath)}, "utf8"))
  : 0;
fs.writeFileSync(${JSON.stringify(corepackCountPath)}, String(count + 1));
const delay = process.argv[2] === "enable" ? 100 : 2000;
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
`,
  );
  fs.writeFileSync(
    pnpmPath,
    `require("node:fs").writeFileSync(${JSON.stringify(pnpmMarkerPath)}, "ran");\n`,
  );

  assert.throws(
    () =>
      withMockCommand("corepack", corepackPath, () =>
        withMockCommand("pnpm", pnpmPath, () =>
          prepareTargetToolchain(cwd, {
            ...validationOptions("steipete/example", {
              toolchain: {
                packageManager: "pnpm",
                baseValidationCommands: ["pnpm check"],
                changedGate: null,
              },
            }),
            installTargetDeps: true,
            installTimeoutMs: 1200,
            setupTimeoutMs: 1200,
          }),
        ),
      ),
    /command timed out after \d+ms: corepack prepare/,
  );
  assert.equal(fs.readFileSync(corepackCountPath, "utf8"), "2");
  assert.equal(fs.existsSync(pnpmMarkerPath), false);
});

test("bun-based target repos still report unrelated missing scripts as blocked", () => {
  // Sanitize is intentionally narrow: only the canonical `pnpm check:changed`
  // shape gets dropped. Any other genuinely missing script (e.g. a typo) must
  // continue to surface as `validation_script_missing` so callers see real
  // gaps instead of silent passes.
  const cwd = bunPackageFixture({ check: "bun x tsc --noEmit" });

  const result = preflightTargetValidationPlan(
    { fixArtifact: { validation_commands: ["bun run nonexistent-script"] }, targetDir: cwd },
    validationOptions("openclaw/clawhub", clawhubToolchain()),
  );

  assert.equal(result.status, "blocked");
  assert.equal(result.code, "validation_script_missing");
  assert.equal(result.missing_script, "nonexistent-script");
});

test("resolveTargetRepoToolchain reads openclaw/clawhub from the real config without overrides", () => {
  // Real-config integration test: prove that the compiled dist/ artifact still
  // resolves config/target-repositories.json relative to the project root, so
  // the worker actually picks up `bun` for ClawHub at runtime (not just under
  // an injected toolchain in unit tests).
  __resetTargetRepoToolchainCache();
  try {
    const toolchain = resolveTargetRepoToolchain("openclaw/clawhub");
    assert.equal(toolchain.packageManager, "bun");
    assert.deepEqual(toolchain.baseValidationCommands, ["bun run check"]);
    assert.equal(toolchain.changedGate, null);
  } finally {
    __resetTargetRepoToolchainCache();
  }
});

test("resolveTargetRepoToolchain keeps the OpenClaw changed gate even without core_target_overrides", () => {
  // Regression guard for the earlier ordering bug: if core_target_overrides is
  // ever removed but a generic openclaw fallback is kept (changed_gate: null),
  // openclaw/openclaw must still receive the pnpm check:changed gate.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-toolchain-config-"));
  const configPath = path.join(tmpDir, "target-repositories.json");
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        schema_version: 2,
        repositories: [],
        generic_fallbacks: [
          {
            owner: "openclaw",
            deny_repositories: [],
            allow_repo_name_pattern: "^[A-Za-z0-9_.-]+$",
            prompt_note: "generic",
            apply_close_rules: { issue: [], pull_request: [] },
            package_manager: "pnpm",
            validation_commands: [],
            changed_gate: null,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  __resetTargetRepoToolchainCache();
  try {
    const toolchain = resolveTargetRepoToolchain("openclaw/openclaw", configPath);
    assert.deepEqual(toolchain.changedGate, {
      command: "pnpm check:changed",
      requiredScript: "check:changed",
    });
    assert.equal(toolchain.packageManager, "pnpm");
  } finally {
    __resetTargetRepoToolchainCache();
  }
});

test("resolveTargetRepoToolchain stays total when the config file is missing", () => {
  // P1 invariant: a missing/unreadable config must NEVER throw out of the
  // resolver, otherwise requiredValidationCommands / prepareTargetToolchain
  // would propagate the error and block automerge across all target repos.
  // The expected fallback is: openclaw/openclaw still gets its hard safety
  // net, every other repo degrades to DEFAULT_TOOLCHAIN (pnpm, no gate) —
  // i.e. pre-PR behavior, never an exception.
  const missingPath = path.join(
    os.tmpdir(),
    `clawsweeper-missing-config-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  __resetTargetRepoToolchainCache();
  try {
    const openclaw = resolveTargetRepoToolchain("openclaw/openclaw", missingPath);
    assert.deepEqual(openclaw.changedGate, {
      command: "pnpm check:changed",
      requiredScript: "check:changed",
    });
    const clawhub = resolveTargetRepoToolchain("openclaw/clawhub", missingPath);
    assert.equal(clawhub.packageManager, "pnpm");
    assert.deepEqual(clawhub.baseValidationCommands, []);
    assert.equal(clawhub.changedGate, null);
    const vendor = resolveTargetRepoToolchain("vendor/anything", missingPath);
    assert.equal(vendor.packageManager, "pnpm");
    assert.equal(vendor.changedGate, null);
  } finally {
    __resetTargetRepoToolchainCache();
  }
});

test("resolveTargetRepoToolchain stays total when the config file is malformed JSON", () => {
  // P1 invariant: a corrupt config file must degrade to default behavior, not
  // throw. Same fallback shape as the missing-file case above.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-bad-config-"));
  const configPath = path.join(tmpDir, "target-repositories.json");
  fs.writeFileSync(configPath, "{not valid json,,,");
  __resetTargetRepoToolchainCache();
  try {
    const warnings = captureWarnings(() => {
      assert.doesNotThrow(() => resolveTargetRepoToolchain("openclaw/openclaw", configPath));
      const openclaw = resolveTargetRepoToolchain("openclaw/openclaw", configPath);
      assert.deepEqual(openclaw.changedGate, {
        command: "pnpm check:changed",
        requiredScript: "check:changed",
      });
      const vendor = resolveTargetRepoToolchain("vendor/anything", configPath);
      assert.equal(vendor.packageManager, "pnpm");
      assert.equal(vendor.changedGate, null);
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /target-toolchain-config: failed to load .*SyntaxError/);
  } finally {
    __resetTargetRepoToolchainCache();
  }
});

test("changed validation retries one transient check:changed failure", () => {
  const marker = path.join(
    os.tmpdir(),
    `clawsweeper-validation-attempt-${process.pid}-${Date.now()}.txt`,
  );
  const cwd = gitPackageFixture({
    "check:changed":
      "node -e \"const fs=require('fs'); const file=process.env.CLAWSWEEPER_TEST_ATTEMPT_FILE; const count=fs.existsSync(file)?Number(fs.readFileSync(file,'utf8')):0; fs.writeFileSync(file, String(count+1)); if (count===0) { console.error('transient changed gate failure'); process.exit(1); }\"",
  });
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  attachOrigin(cwd);

  const previous = process.env.CLAWSWEEPER_VALIDATION_RETRIES;
  const previousMarker = process.env.CLAWSWEEPER_TEST_ATTEMPT_FILE;
  process.env.CLAWSWEEPER_VALIDATION_RETRIES = "1";
  process.env.CLAWSWEEPER_TEST_ATTEMPT_FILE = marker;
  try {
    assert.deepEqual(
      runAllowedValidationCommands(
        ["pnpm check:changed"],
        cwd,
        validationOptions("openclaw/openclaw"),
      ),
      ["pnpm check:changed"],
    );
  } finally {
    restoreEnv("CLAWSWEEPER_VALIDATION_RETRIES", previous);
    restoreEnv("CLAWSWEEPER_TEST_ATTEMPT_FILE", previousMarker);
    fs.rmSync(marker, { force: true });
  }
});

test("changed validation shares one timeout with checkout identity proof", () => {
  const marker = path.join(
    os.tmpdir(),
    `clawsweeper-validation-budget-${process.pid}-${Date.now()}.txt`,
  );
  const cwd = gitPackageFixture({ "check:changed": "node check.js" });
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  attachOrigin(cwd);

  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-pnpm-budget-"));
  const pnpmPath = path.join(binDir, "pnpm.js");
  fs.writeFileSync(
    pnpmPath,
    `const fs = require("node:fs");
const count = fs.existsSync(${JSON.stringify(marker)})
  ? Number(fs.readFileSync(${JSON.stringify(marker)}, "utf8"))
  : 0;
fs.writeFileSync(${JSON.stringify(marker)}, String(count + 1));
setTimeout(() => {}, 5000);
`,
  );
  const previousRetries = process.env.CLAWSWEEPER_VALIDATION_RETRIES;
  process.env.CLAWSWEEPER_VALIDATION_RETRIES = "1";
  try {
    assert.throws(
      () =>
        withMockCommand("pnpm", pnpmPath, () =>
          runAllowedValidationCommands(
            ["pnpm check:changed"],
            cwd,
            validationOptions("openclaw/openclaw", { validationTimeoutMs: 250 }),
          ),
        ),
      /validation command runtime budget exhausted|unsafe validation command checkout identity could not be verified/,
    );
    assert.equal(fs.readFileSync(marker, "utf8"), "1");
  } finally {
    restoreEnv("CLAWSWEEPER_VALIDATION_RETRIES", previousRetries);
    fs.rmSync(marker, { force: true });
  }
});

test("validation reserves deadline to prove checkout mutation after command timeout", () => {
  const cwd = gitPackageFixture({ verify: "node verify.js" });
  fs.writeFileSync(path.join(cwd, "source.txt"), "original\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  attachOrigin(cwd);

  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-pnpm-timeout-mutation-"));
  const pnpmPath = path.join(binDir, "pnpm.js");
  fs.writeFileSync(
    pnpmPath,
    `const fs = require("node:fs");
fs.writeFileSync("source.txt", "mutated\\n");
setTimeout(() => {}, 5000);
`,
  );

  assert.throws(
    () =>
      withMockCommand("pnpm", pnpmPath, () =>
        runAllowedValidationCommands(
          ["pnpm verify"],
          cwd,
          validationOptions("steipete/example", {
            toolchain: {
              packageManager: "pnpm",
              baseValidationCommands: [],
              changedGate: null,
            },
            validationTimeoutMs: 800,
          }),
        ),
      ),
    /unsafe validation command mutated checkout identity/,
  );
});

test(
  "validation rejects and reaps an immediate detached double fork",
  { skip: process.platform !== "linux" },
  (context) => {
    if (!linuxValidationContainmentAvailable()) {
      context.skip("runner does not provide delegated user namespaces and Landlock ABI 3+");
      return;
    }
    const marker = path.join(
      os.tmpdir(),
      `clawsweeper-detached-validation-${process.pid}-${Date.now()}`,
    );
    const cwd = gitPackageFixture({ verify: "node verify.js" });
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "initial");
    attachOrigin(cwd);
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-detached-pnpm-"));
    const pnpmPath = path.join(binDir, "pnpm.js");
    const grandchild = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "escaped"), 800)`;
    const intermediate = `const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["-e", ${JSON.stringify(
      grandchild,
    )}], { detached: true, stdio: "ignore" }); child.unref();`;
    fs.writeFileSync(
      pnpmPath,
      `const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(intermediate)}], {
  detached: true,
  stdio: "ignore"
});
child.unref();
`,
    );

    const previousForceContainment = process.env.CLAWSWEEPER_TEST_FORCE_LINUX_CONTAINMENT;
    process.env.CLAWSWEEPER_TEST_FORCE_LINUX_CONTAINMENT = "1";
    try {
      assert.throws(
        () =>
          withMockCommand("pnpm", pnpmPath, () =>
            runAllowedValidationCommands(
              ["pnpm verify"],
              cwd,
              validationOptions("steipete/example", {
                toolchain: {
                  packageManager: "pnpm",
                  baseValidationCommands: [],
                  changedGate: null,
                },
              }),
            ),
          ),
        /background process/,
      );
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
      assert.equal(fs.existsSync(marker), false);
    } finally {
      restoreEnv("CLAWSWEEPER_TEST_FORCE_LINUX_CONTAINMENT", previousForceContainment);
      fs.rmSync(marker, { force: true });
    }
  },
);

test("target validation strips credentials and target-controlled environment injection", () => {
  const secretNames = [
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "CLAWSWEEPER_INTERNAL_MODEL",
    "CODEX_HOME",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GITHUB_ENV",
    "GITHUB_OUTPUT",
    "GITHUB_PATH",
    "GITHUB_STEP_SUMMARY",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "ACTIONS_RUNTIME_TOKEN",
    "RUNNER_TRACKING_ID",
    "CLAWSWEEPER_RULESET_GH_TOKEN",
    "REPAIR_ACTION_LEDGER_PATH",
    "AWS_SHARED_CREDENTIALS_FILE",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "HTTPS_PROXY",
    "SSH_AUTH_SOCK",
    "NODE_OPTIONS",
    "BASH_ENV",
    "PYTHONPATH",
    "NPM_CONFIG_USERCONFIG",
    "COREPACK_NPM_REGISTRY",
    "RUSTDOCFLAGS",
    "GIT_CONFIG_GLOBAL",
    "APPDATA",
    "HOME",
    "LOCALAPPDATA",
    "USERPROFILE",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
    "XDG_STATE_HOME",
  ];
  const secretValues = Object.fromEntries(
    secretNames.map((name) => [name, `secret-${name.toLowerCase()}`]),
  );
  const cwd = gitPackageFixture({
    "check:env": `node -e 'for (const [key, value] of Object.entries(${JSON.stringify(secretValues)})) if (process.env[key] === value) process.exit(9); if (process.env.GIT_OPTIONAL_LOCKS !== "0") process.exit(10)'`,
  });
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  attachOrigin(cwd);

  const previous = Object.fromEntries(secretNames.map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(secretValues)) process.env[key] = value;
  try {
    assert.deepEqual(
      runAllowedValidationCommands(
        ["pnpm check:env"],
        cwd,
        validationOptions("steipete/example", {
          toolchain: {
            packageManager: "pnpm",
            baseValidationCommands: [],
            changedGate: null,
          },
        }),
      ),
      ["pnpm check:env"],
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) restoreEnv(key, value);
  }
});

test("target validation exposes verified rustup tools without host Rust state", () => {
  const rustupHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-rustup-home-"));
  const toolchainBin = path.join(rustupHome, "toolchains", "stable", "bin");
  const observationPath = path.join(rustupHome, "observed.jsonl");
  fs.mkdirSync(toolchainBin, { recursive: true });
  for (const command of ["rustc", "cargo"]) {
    writeNodeCommandShim(
      toolchainBin,
      command,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(observationPath)}, JSON.stringify({
  command: ${JSON.stringify(command)},
  rustupHome: process.env.RUSTUP_HOME,
  cargoHome: process.env.CARGO_HOME,
  home: process.env.HOME
}) + "\\n");
`,
    );
  }
  const rustupBin = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-rustup-bin-"));
  writeNodeCommandShim(
    rustupBin,
    "rustup",
    `const args = process.argv.slice(2).join(" ");
if (args === "show home") console.log(${JSON.stringify(rustupHome)});
else if (args === "which rustc") console.log(${JSON.stringify(path.join(toolchainBin, "rustc"))});
else if (args === "which cargo") console.log(${JSON.stringify(path.join(toolchainBin, "cargo"))});
else process.exit(1);
`,
  );
  const pnpmPath = path.join(rustupBin, "pnpm.js");
  fs.writeFileSync(
    pnpmPath,
    `const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args.includes("cargo") || args.includes("check:rust")) {
  const result = spawnSync("cargo", ["--version"], { env: process.env, stdio: "inherit" });
  process.exit(result.status ?? 1);
}
`,
  );
  const cwd = gitPackageFixture({ "check:rust": "cargo --version" });
  fs.mkdirSync(path.join(cwd, "packages", "worker"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, "packages", "worker", "package.json"),
    `${JSON.stringify({ name: "worker", scripts: { "check:rust": "cargo --version" } }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(cwd, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  attachOrigin(cwd);
  const poisonedHome = path.join(rustupHome, "poisoned-home");
  const poisonedRustupHome = path.join(rustupHome, "poisoned-rustup");
  const previousHome = process.env.HOME;
  const previousRustupHome = process.env.RUSTUP_HOME;
  const previousCargoHome = process.env.CARGO_HOME;
  process.env.HOME = poisonedHome;
  process.env.RUSTUP_HOME = poisonedRustupHome;
  process.env.CARGO_HOME = path.join(rustupHome, "host-cargo");
  try {
    assert.deepEqual(
      withPathOnlyPrefix(rustupBin, () =>
        withMockCommand("pnpm", pnpmPath, () =>
          runAllowedValidationCommands(
            [
              "rustc --version",
              "cargo --version",
              "pnpm exec cargo --version",
              "pnpm check:rust",
              "pnpm --filter worker check:rust",
            ],
            cwd,
            validationOptions("steipete/example", {
              toolchain: {
                packageManager: "pnpm",
                baseValidationCommands: [],
                changedGate: null,
              },
            }),
          ),
        ),
      ),
      [
        "rustc --version",
        "cargo --version",
        "pnpm exec cargo --version",
        "pnpm check:rust",
        "pnpm --fail-if-no-match --filter worker check:rust",
      ],
    );
  } finally {
    restoreEnv("HOME", previousHome);
    restoreEnv("RUSTUP_HOME", previousRustupHome);
    restoreEnv("CARGO_HOME", previousCargoHome);
  }
  assert.equal(fs.existsSync(poisonedHome), false);
  assert.equal(fs.existsSync(poisonedRustupHome), false);

  const observations = fs
    .readFileSync(observationPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    observations.map((entry) => entry.command),
    ["rustc", "cargo", "cargo", "cargo", "cargo"],
  );
  for (const observation of observations) {
    assert.equal(observation.rustupHome, undefined);
    assert.notEqual(observation.cargoHome, path.join(rustupHome, "host-cargo"));
    assert.notEqual(observation.home, process.env.HOME);
    assert.equal(fs.existsSync(observation.cargoHome), false);
    assert.equal(fs.existsSync(observation.home), false);
  }
});

test(
  "target validation retries rustup after a transient probe failure",
  { skip: process.platform === "win32" },
  () => {
    const rustupHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-rustup-retry-home-"));
    const toolchainBin = path.join(rustupHome, "toolchains", "stable", "bin");
    const rustupBin = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-rustup-retry-bin-"));
    const countPath = path.join(rustupBin, "rustup-count");
    fs.mkdirSync(toolchainBin, { recursive: true });
    for (const directory of [rustupBin, toolchainBin]) {
      for (const command of ["rustc", "cargo"]) {
        writeNodeCommandShim(directory, command, "#!/usr/bin/env node\n");
      }
    }
    writeNodeCommandShim(
      rustupBin,
      "rustup",
      `#!/usr/bin/env node
const fs = require("node:fs");
const count = fs.existsSync(${JSON.stringify(countPath)})
  ? Number(fs.readFileSync(${JSON.stringify(countPath)}, "utf8"))
  : 0;
fs.writeFileSync(${JSON.stringify(countPath)}, String(count + 1));
if (count === 0) process.exit(1);
const args = process.argv.slice(2).join(" ");
if (args === "show home") console.log(${JSON.stringify(rustupHome)});
else if (args === "which rustc") console.log(${JSON.stringify(path.join(toolchainBin, "rustc"))});
else if (args === "which cargo") console.log(${JSON.stringify(path.join(toolchainBin, "cargo"))});
else process.exit(1);
`,
    );
    const cwd = gitPackageFixture({});
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "initial");
    attachOrigin(cwd);
    const options = validationOptions("steipete/example", {
      toolchain: {
        packageManager: "pnpm",
        baseValidationCommands: [],
        changedGate: null,
      },
    });

    withPathOnlyPrefix(rustupBin, () => {
      assert.deepEqual(runAllowedValidationCommands(["rustc --version"], cwd, options), [
        "rustc --version",
      ]);
      assert.deepEqual(runAllowedValidationCommands(["rustc --version"], cwd, options), [
        "rustc --version",
      ]);
    });
    assert.equal(fs.readFileSync(countPath, "utf8"), "4");
  },
);

test("target validation confines user-level configuration writes to a disposable profile", () => {
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-host-home-"));
  const hostConfig = path.join(hostHome, "xdg");
  const observationPath = path.join(hostHome, "observed.json");
  const cwd = gitPackageFixture({ "check:env": "node write-global.mjs" });
  fs.writeFileSync(
    path.join(cwd, "write-global.mjs"),
    `import { execFileSync } from "node:child_process";
import fs from "node:fs";
execFileSync("git", ["config", "--global", "credential.helper", "!node unsafe-helper.js"]);
fs.writeFileSync(${JSON.stringify(observationPath)}, JSON.stringify({
  home: process.env.HOME,
  userprofile: process.env.USERPROFILE,
  xdg: process.env.XDG_CONFIG_HOME,
  gitConfig: process.env.GIT_CONFIG_GLOBAL
}));
`,
  );
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  attachOrigin(cwd);

  const previous = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  process.env.HOME = hostHome;
  process.env.USERPROFILE = hostHome;
  process.env.XDG_CONFIG_HOME = hostConfig;
  try {
    assert.deepEqual(
      runAllowedValidationCommands(
        ["pnpm check:env"],
        cwd,
        validationOptions("steipete/example", {
          toolchain: {
            packageManager: "pnpm",
            baseValidationCommands: [],
            changedGate: null,
          },
        }),
      ),
      ["pnpm check:env"],
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) restoreEnv(key, value);
  }

  const observed = JSON.parse(fs.readFileSync(observationPath, "utf8"));
  for (const value of [observed.home, observed.userprofile, observed.xdg, observed.gitConfig]) {
    assert.notEqual(value, hostHome);
    assert.notEqual(value, hostConfig);
  }
  assert.equal(fs.existsSync(path.join(hostHome, ".gitconfig")), false);
  assert.equal(fs.existsSync(path.join(hostConfig, "git", "config")), false);
  assert.equal(
    fs.existsSync(observed.home),
    false,
    "disposable validation profile must be removed",
  );
  assert.equal(
    fs.existsSync(observed.gitConfig),
    false,
    "disposable validation Git config must be removed",
  );
});

test("compactText keeps both head and tail for long validation output", () => {
  assert.equal(
    compactText("head ".repeat(20) + "tail failure detail", 64).endsWith("failure detail"),
    true,
  );
});

function packageFixture(scripts) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-validation-"));
  fs.writeFileSync(
    path.join(cwd, "package.json"),
    `${JSON.stringify({ scripts, packageManager: "pnpm@10.33.0" }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(cwd, "pnpm-lock.yaml"),
    [
      "lockfileVersion: '9.0'",
      "",
      "settings:",
      "  autoInstallPeers: true",
      "  excludeLinksFromLockfile: false",
      "",
      "importers:",
      "",
      "  .: {}",
      "",
    ].join("\n"),
  );
  return cwd;
}

function bunPackageFixture(scripts) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-validation-bun-"));
  fs.writeFileSync(
    path.join(cwd, "package.json"),
    `${JSON.stringify({ scripts, packageManager: "bun@1.1.0" }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(cwd, "bun.lock"), "");
  return cwd;
}

function gitBunPackageFixture(scripts) {
  const cwd = bunPackageFixture(scripts);
  fs.writeFileSync(path.join(cwd, ".gitignore"), "node_modules/\n");
  git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.email", "clawsweeper@example.invalid");
  git(cwd, "config", "user.name", "ClawSweeper Test");
  return cwd;
}

function fakeBunFixture(cwd, { failRun = false } = {}) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-fake-bun-bin-"));
  const logPath = path.join(binDir, "fake-bun.log");
  writeNodeCommandShim(
    binDir,
    "bun",
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(logPath)}, process.argv.slice(2).join(" ") + "\\n");
if (process.argv[2] === "--version") console.log("1.3.10");
if (process.argv[2] === "install") fs.mkdirSync("node_modules", { recursive: true });
if (${JSON.stringify(failRun)} && process.argv[2] === "run") { console.error("src/base.ts:1: lint failed"); process.exit(1); }
`,
  );
  return { binDir, logPath };
}

function envLoggingBunFixture() {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-fake-bun-env-bin-"));
  const logPath = path.join(binDir, "fake-bun.log");
  const envLogPath = path.join(binDir, "fake-bun-env.log");
  writeNodeCommandShim(
    binDir,
    "bun",
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(logPath)}, process.argv.slice(2).join(" ") + "\\n");
fs.appendFileSync(${JSON.stringify(envLogPath)}, JSON.stringify(process.env) + "\\n");
if (process.argv[2] === "--version") console.log("1.3.10");
`,
  );
  return { binDir, logPath, envLogPath };
}

function restoreEnv(key, previous) {
  if (previous === undefined) delete process.env[key];
  else process.env[key] = previous;
}

function linuxValidationContainmentAvailable() {
  const probe = spawnSync(
    "/usr/bin/unshare",
    [
      "--user",
      "--map-root-user",
      "--mount",
      "--pid",
      "--fork",
      "--mount-proc",
      "--kill-child=SIGKILL",
      "/usr/bin/python3",
      "-c",
      [
        "import ctypes, os",
        "libc = ctypes.CDLL(None, use_errno=True)",
        "libc.syscall.restype = ctypes.c_long",
        "abi = libc.syscall(ctypes.c_long(444), ctypes.c_void_p(), ctypes.c_size_t(0), ctypes.c_uint32(1))",
        "assert os.getpid() == 1",
        "assert abi >= 3",
      ].join("; "),
    ],
    { stdio: "ignore" },
  );
  return probe.status === 0;
}

function withMockCommand(command, scriptPath, callback) {
  const overrides = mockCommandBinEnv(command, scriptPath);
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    return callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) restoreEnv(key, value);
  }
}

function withPathPrefix(binDir, callback) {
  const pathKey = envPathKey();
  const previousPath = process.env[pathKey];
  const previousUpperPath = pathKey === "PATH" ? undefined : process.env.PATH;
  const previousBunBin = process.env.BUN_BIN;
  const previousBunBinArgs = process.env.BUN_BIN_ARGS;
  if (pathKey !== "PATH") delete process.env.PATH;
  process.env[pathKey] = [binDir, previousPath].filter(Boolean).join(path.delimiter);
  Object.assign(process.env, mockCommandBinEnv("bun", path.join(binDir, "bun.js")));
  try {
    callback();
  } finally {
    if (previousPath === undefined) delete process.env[pathKey];
    else process.env[pathKey] = previousPath;
    restoreEnv("BUN_BIN", previousBunBin);
    restoreEnv("BUN_BIN_ARGS", previousBunBinArgs);
    if (pathKey !== "PATH") {
      if (previousUpperPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousUpperPath;
    }
  }
}

function withPathOnlyPrefix(binDir, callback) {
  const pathKey = envPathKey();
  const previousPath = process.env[pathKey];
  const previousUpperPath = pathKey === "PATH" ? undefined : process.env.PATH;
  if (pathKey !== "PATH") delete process.env.PATH;
  process.env[pathKey] = [binDir, previousPath].filter(Boolean).join(path.delimiter);
  try {
    return callback();
  } finally {
    if (previousPath === undefined) delete process.env[pathKey];
    else process.env[pathKey] = previousPath;
    if (pathKey !== "PATH") {
      if (previousUpperPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousUpperPath;
    }
  }
}

function withCommandOverridesUnset(commands, callback) {
  const keys = commands.flatMap((command) => Object.keys(mockCommandBinEnv(command, "")));
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  try {
    return callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) restoreEnv(key, value);
  }
}

function envPathKey() {
  return Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

function writeNodeCommandShim(binDir, commandName, script) {
  const scriptPath = path.join(binDir, `${commandName}.js`);
  fs.writeFileSync(scriptPath, script);
  fs.chmodSync(scriptPath, 0o755);
  if (process.platform !== "win32") {
    const shimPath = path.join(binDir, commandName);
    fs.writeFileSync(shimPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`);
    fs.chmodSync(shimPath, 0o755);
    return;
  }
  const cmdPath = path.join(binDir, `${commandName}.cmd`);
  fs.writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "%~dp0${commandName}.js" %*\r\n`);
}

function clawhubToolchain() {
  return {
    toolchain: {
      packageManager: "bun",
      baseValidationCommands: ["bun run check"],
      changedGate: null,
    },
  };
}

function gitPackageFixture(scripts) {
  const cwd = packageFixture(scripts);
  fs.writeFileSync(path.join(cwd, ".gitignore"), "node_modules/\n");
  git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.email", "clawsweeper@example.invalid");
  git(cwd, "config", "user.name", "ClawSweeper Test");
  return cwd;
}

function attachOrigin(cwd) {
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-validation-origin-"));
  git(origin, "init", "--bare");
  git(cwd, "remote", "add", "origin", origin);
  git(cwd, "push", "-u", "origin", "main:main");
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function captureWarnings(callback) {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => {
    warnings.push(String(message));
  };
  try {
    callback();
    return warnings;
  } finally {
    console.warn = originalWarn;
  }
}

function escapeRegExpForTest(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function validationOptions(targetRepo, extra = {}) {
  return {
    allowExpensiveValidation: false,
    installTargetDeps: false,
    strictTargetValidation: false,
    targetRepo,
    ...extra,
  };
}
