import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canSkipInternalCodexReviewForRepairDelta,
  detectTargetPackageManager,
  preflightTargetValidationPlan,
  repairDeltaValidationPlan,
  requiredValidationCommands,
  runAllowedValidationCommands,
} from "../../dist/repair/target-validation.js";
import { compactText } from "../../dist/repair/text-utils.js";
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
  const cwd = packageFixture({ "check:changed": "node check.js" });

  assert.deepEqual(requiredValidationCommands([], cwd, validationOptions("openclaw/clawhub")), []);
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

test("validation parser accepts composer install", () => {
  assert.deepEqual(parseAllowedValidationCommand("composer install"), ["composer", "install"]);
  assert.deepEqual(
    parseAllowedValidationCommand("composer install --no-interaction --prefer-dist"),
    ["composer", "install", "--no-interaction", "--prefer-dist"],
  );
});

test("validation parser accepts composer test scripts", () => {
  assert.deepEqual(parseAllowedValidationCommand("composer test"), ["composer", "test"]);
  assert.deepEqual(parseAllowedValidationCommand("composer run test"), ["composer", "run", "test"]);
  assert.deepEqual(parseAllowedValidationCommand("composer run-script test"), [
    "composer",
    "run-script",
    "test",
  ]);
});

test("validation parser accepts php artisan test", () => {
  assert.deepEqual(parseAllowedValidationCommand("php artisan test"), ["php", "artisan", "test"]);
});

test("validation parser accepts vendor/bin test runners", () => {
  assert.deepEqual(parseAllowedValidationCommand("vendor/bin/phpunit"), ["vendor/bin/phpunit"]);
  assert.deepEqual(parseAllowedValidationCommand("./vendor/bin/pest"), ["./vendor/bin/pest"]);
  assert.deepEqual(parseAllowedValidationCommand("vendor/bin/pest --parallel"), [
    "vendor/bin/pest",
    "--parallel",
  ]);
});

test("validation parser still rejects unknown executables", () => {
  assert.throws(
    () => parseAllowedValidationCommand("cargo test"),
    /unsupported validation command/,
  );
  assert.throws(
    () => parseAllowedValidationCommand("vendor/lib/phpunit"),
    /unsupported validation command/,
  );
});

test("validation preflight accepts pnpm filter package scripts", () => {
  const cwd = packageFixture({ typecheck: "turbo typecheck" });

  assert.deepEqual(
    preflightTargetValidationPlan(
      {
        fixArtifact: {
          validation_commands: ["pnpm --filter @multica/docs typecheck"],
        },
        targetDir: cwd,
      },
      validationOptions("bermont-digital/multica"),
    ),
    {
      status: "passed",
      resolved_commands: ["pnpm --filter @multica/docs typecheck"],
      available_scripts: ["typecheck"],
    },
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

function pmFixture(pkg = {}, lockfiles = []) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-pm-"));
  fs.writeFileSync(path.join(cwd, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  for (const name of lockfiles) fs.writeFileSync(path.join(cwd, name), "");
  return cwd;
}

test("detectTargetPackageManager honors explicit packageManager pnpm declaration", () => {
  const cwd = pmFixture({ packageManager: "pnpm@9.12.0" });
  assert.deepEqual(detectTargetPackageManager(cwd), {
    kind: "pnpm",
    corepackSpec: "pnpm@9.12.0",
  });
});

test("detectTargetPackageManager honors explicit packageManager npm declaration", () => {
  const cwd = pmFixture({ packageManager: "npm@10.8.2" });
  assert.deepEqual(detectTargetPackageManager(cwd), {
    kind: "npm",
    corepackSpec: "npm@10.8.2",
  });
});

test("detectTargetPackageManager rejects yarn even when explicitly declared", () => {
  const cwd = pmFixture({ packageManager: "yarn@4.5.1" });
  assert.throws(() => detectTargetPackageManager(cwd), /unsupported target package manager: yarn/);
});

test("detectTargetPackageManager falls back to lockfile heuristic for pnpm", () => {
  const cwd = pmFixture({}, ["pnpm-lock.yaml"]);
  assert.deepEqual(detectTargetPackageManager(cwd), {
    kind: "pnpm",
    corepackSpec: "pnpm@10.33.0",
  });
});

test("detectTargetPackageManager detects npm from package-lock.json", () => {
  // valkyriweb/pi-mono shape: npm workspaces, no packageManager field, no
  // pnpm-lock.yaml. Without lockfile-driven detection the bootstrap would
  // default to pnpm and fail to install workspace-internal packages.
  const cwd = pmFixture(
    { workspaces: ["packages/*"], dependencies: { "@example/local": "^1.0.0" } },
    ["package-lock.json"],
  );
  assert.deepEqual(detectTargetPackageManager(cwd), { kind: "npm", corepackSpec: null });
});

test("detectTargetPackageManager rejects yarn lockfiles", () => {
  const cwd = pmFixture({}, ["yarn.lock"]);
  assert.throws(() => detectTargetPackageManager(cwd), /unsupported target package manager: yarn/);
});

test("detectTargetPackageManager defaults to pnpm when no signals are present", () => {
  // Preserves current OpenClaw/clawsweeper bootstrap behavior.
  const cwd = pmFixture({});
  assert.deepEqual(detectTargetPackageManager(cwd), {
    kind: "pnpm",
    corepackSpec: "pnpm@10.33.0",
  });
});

test("detectTargetPackageManager prefers packageManager field over lockfile heuristic", () => {
  // Mixed-signal target: package-lock.json present but packageManager pins pnpm.
  const cwd = pmFixture({ packageManager: "pnpm@10.0.0" }, ["package-lock.json"]);
  assert.deepEqual(detectTargetPackageManager(cwd), {
    kind: "pnpm",
    corepackSpec: "pnpm@10.0.0",
  });
});

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

function validationOptions(targetRepo) {
  return {
    allowExpensiveValidation: false,
    installTargetDeps: false,
    strictTargetValidation: false,
    targetRepo,
  };
}
