import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canSkipInternalCodexReviewForRepairDelta,
  preflightTargetValidationPlan,
  prepareTargetToolchain,
  repairDeltaValidationPlan,
  requiredValidationCommands,
  runAllowedValidationCommands,
} from "../../dist/repair/target-validation.js";
import { compactText } from "../../dist/repair/text-utils.js";
import {
  __resetTargetRepoToolchainCache,
  resolveTargetRepoToolchain,
} from "../../dist/repair/target-toolchain-config.js";
import { parseAllowedValidationCommand } from "../../dist/repair/validation-command-utils.js";

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

test("OpenClaw automerge repairs can require CI-parity validation commands", () => {
  const cwd = packageFixture({
    "check:changed": "node check.js",
    "check:test-types": "node types.js",
    lint: "node lint.js",
  });
  const options = {
    ...validationOptions("openclaw/openclaw"),
    additionalValidationCommands: ["pnpm lint", "pnpm check:test-types"],
    strictTargetValidation: true,
  };

  assert.deepEqual(requiredValidationCommands(["pnpm check:changed"], cwd, options), [
    "pnpm check:changed",
    "pnpm lint",
    "pnpm check:test-types",
  ]);
  assert.deepEqual(
    preflightTargetValidationPlan(
      { fixArtifact: { validation_commands: ["pnpm check:changed"] }, targetDir: cwd },
      options,
    ),
    {
      status: "passed",
      resolved_commands: ["pnpm check:changed", "pnpm lint", "pnpm check:test-types"],
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
            "env QA_PARITY_CONCURRENCY=1 OPENCLAW_BUILD_PRIVATE_QA=1 OPENCLAW_ENABLE_PRIVATE_QA_CLI=1 OPENAI_API_KEY= ANTHROPIC_API_KEY= OPENCLAW_LIVE_OPENAI_KEY= OPENCLAW_LIVE_ANTHROPIC_KEY= OPENCLAW_LIVE_GEMINI_KEY= OPENCLAW_LIVE_SETUP_TOKEN_VALUE= pnpm openclaw qa suite --provider-mode mock-openai --parity-pack agentic --concurrency 1 --model ${OPENCLAW_CI_OPENAI_MODEL:-openai/gpt-5.5} --alt-model openai/gpt-5.4-alt --output-dir .artifacts/qa-e2e/gpt54",
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

test("non-gated target repos preserve fallback validation when no replacement exists", () => {
  // A deterministic fallback `pnpm check:changed` is stale only when the active
  // toolchain has a replacement command. For generic pnpm/no-base toolchains,
  // preserving it makes preflight block on a missing script instead of silently
  // passing with zero validation commands.
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

  assert.equal(result.status, "blocked");
  assert.equal(result.code, "validation_script_missing");
  assert.equal(result.missing_script, "check:changed");
  assert.deepEqual(result.resolved_commands, ["pnpm check:changed"]);
});

test("repair execution provisions pinned Bun before target validation can invoke it", () => {
  const workflow = fs.readFileSync(".github/workflows/repair-cluster-worker.yml", "utf8");
  const setupBunIndex = workflow.indexOf("- name: Setup pinned Bun for target validation");
  const executeFixIndex = workflow.indexOf("- name: Execute credited fix artifact");

  assert.ok(setupBunIndex >= 0, "expected repair execution workflow to set up Bun");
  assert.ok(executeFixIndex >= 0, "expected repair execution workflow to execute fix artifacts");
  assert.ok(setupBunIndex < executeFixIndex, "expected Bun setup before repair:execute-fix");

  const setupBunStep = workflow.slice(setupBunIndex, executeFixIndex);
  assert.match(setupBunStep, /uses: oven-sh\/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6/);
  assert.match(setupBunStep, /bun-version: 1\.3\.10/);
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
      installTimeoutMs: 5000,
      setupTimeoutMs: 5000,
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
    "install --frozen-lockfile",
    "run check",
  ]);
});

test("bun-based target toolchain hides pnpm-injected npm_config_user_agent from preinstall hooks", () => {
  // Regression guard for the `bunx only-allow bun` preinstall failure on
  // openclaw/clawhub: ClawSweeper itself runs under pnpm so `process.env`
  // carries `npm_config_user_agent=pnpm/...`. If that value leaked into the
  // `bun install` child we'd shell out to, target preinstalls that gate on
  // `only-allow bun` would refuse to run. prepareBunToolchain must scrub
  // caller identity/lifecycle env and assert a bun user-agent instead, while
  // preserving npm-compatible install configuration for private registries.
  const cwd = gitBunPackageFixture({ check: "bun x tsc --noEmit" });
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  attachOrigin(cwd);

  const { binDir, envLogPath } = envLoggingBunFixture(cwd);
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
        installTimeoutMs: 5000,
        setupTimeoutMs: 5000,
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
    assert.equal(
      env.npm_config_cache,
      "/tmp/npm-cache",
      "npm-compatible cache config must pass through to bun children",
    );
    assert.equal(
      env.npm_config_userconfig,
      "/tmp/npmrc",
      "npm-compatible userconfig must pass through to bun children",
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
  const cwd = gitPackageFixture({
    "check:changed":
      "node -e \"const fs=require('fs'); const file='.attempt'; const count=fs.existsSync(file)?Number(fs.readFileSync(file,'utf8')):0; fs.writeFileSync(file, String(count+1)); if (count===0) { console.error('transient changed gate failure'); process.exit(1); }\"",
  });
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  attachOrigin(cwd);

  const previous = process.env.CLAWSWEEPER_VALIDATION_RETRIES;
  process.env.CLAWSWEEPER_VALIDATION_RETRIES = "1";
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
    if (previous === undefined) delete process.env.CLAWSWEEPER_VALIDATION_RETRIES;
    else process.env.CLAWSWEEPER_VALIDATION_RETRIES = previous;
  }
});

test("compactText keeps both head and tail for long validation output", () => {
  assert.equal(
    compactText("head ".repeat(20) + "tail failure detail", 64).endsWith("failure detail"),
    true,
  );
});

function packageFixture(scripts) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-validation-"));
  fs.writeFileSync(path.join(cwd, "package.json"), `${JSON.stringify({ scripts }, null, 2)}\n`);
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
  git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.email", "clawsweeper@example.invalid");
  git(cwd, "config", "user.name", "ClawSweeper Test");
  return cwd;
}

function fakeBunFixture(cwd) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-fake-bun-bin-"));
  const logPath = path.join(cwd, "fake-bun.log");
  const bunPath = path.join(binDir, "bun");
  fs.writeFileSync(
    bunPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(logPath)}, process.argv.slice(2).join(" ") + "\\n");
if (process.argv[2] === "--version") console.log("1.3.10");
`,
  );
  fs.chmodSync(bunPath, 0o755);
  return { binDir, logPath };
}

function envLoggingBunFixture(cwd) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-fake-bun-env-bin-"));
  const logPath = path.join(cwd, "fake-bun.log");
  const envLogPath = path.join(cwd, "fake-bun-env.log");
  const bunPath = path.join(binDir, "bun");
  fs.writeFileSync(
    bunPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(logPath)}, process.argv.slice(2).join(" ") + "\\n");
fs.appendFileSync(${JSON.stringify(envLogPath)}, JSON.stringify(process.env) + "\\n");
if (process.argv[2] === "--version") console.log("1.3.10");
`,
  );
  fs.chmodSync(bunPath, 0o755);
  return { binDir, logPath, envLogPath };
}

function restoreEnv(key, previous) {
  if (previous === undefined) delete process.env[key];
  else process.env[key] = previous;
}

function withPathPrefix(binDir, callback) {
  const previousPath = process.env.PATH;
  process.env.PATH = [binDir, previousPath].filter(Boolean).join(path.delimiter);
  try {
    callback();
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
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

function validationOptions(targetRepo, extra = {}) {
  return {
    allowExpensiveValidation: false,
    installTargetDeps: false,
    strictTargetValidation: false,
    targetRepo,
    ...extra,
  };
}
