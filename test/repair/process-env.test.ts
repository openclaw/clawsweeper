import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  clawsweeperGitIdentityEnv,
  clawsweeperGitUserName,
  codexModelArgs,
  codexSubprocessEnv,
  internalCodexModel,
  repairCodexReasoningEffort,
  repairCodexServiceTier,
} from "../../dist/repair/process-env.js";

test("codexSubprocessEnv forces ClawSweeper git identity and strips tokens", () => {
  withEnv(
    {
      CLAWSWEEPER_GIT_USER_NAME: "clawsweeper-repair",
      CLAWSWEEPER_GIT_USER_EMAIL: "bot@example.invalid",
      CLAWSWEEPER_TARGET_GH_TOKEN: "secret",
      CLAWSWEEPER_PUBLIC_GH_TOKEN: "public-read-secret",
      GH_TOKEN: "secret",
      GITHUB_TOKEN: "secret",
      REPO_TOKEN: "workflow-repository-secret",
      GITHUB_ACTIONS: "true",
      OPENAI_API_KEY: "secret",
      CODEX_API_KEY: "secret",
      CLAWSWEEPER_INTERNAL_MODEL: "secret-model",
      CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "agent-secret",
      CLAWSWEEPER_CRABFLEET_SERVICE_TOKEN: "service-secret",
      CLAWSWEEPER_CRABFLEET_RUNNER_PTY_URL: "wss://example.invalid/secret",
      CLAWSWEEPER_CRABFLEET_WORK_STATE_URL: "https://example.invalid/secret",
      PNPM_CONFIG_IGNORE_SCRIPTS: "false",
      PNPM_CONFIG_IGNORE_PNPMFILE: "false",
      npm_config_ignore_scripts: "false",
    },
    () => {
      const env = codexSubprocessEnv();

      assert.equal(env.GIT_AUTHOR_NAME, "clawsweeper");
      assert.equal(env.GIT_AUTHOR_EMAIL, "bot@example.invalid");
      assert.equal(env.GIT_COMMITTER_NAME, "clawsweeper");
      assert.equal(env.GIT_COMMITTER_EMAIL, "bot@example.invalid");
      assert.equal(env.GH_TOKEN, undefined);
      assert.equal(env.GITHUB_TOKEN, undefined);
      assert.equal(env.REPO_TOKEN, undefined);
      assert.equal(env.CLAWSWEEPER_TARGET_GH_TOKEN, undefined);
      assert.equal(env.CLAWSWEEPER_PUBLIC_GH_TOKEN, undefined);
      assert.equal(env.OPENAI_API_KEY, undefined);
      assert.equal(env.CODEX_API_KEY, undefined);
      assert.equal(env.CLAWSWEEPER_INTERNAL_MODEL, undefined);
      assert.equal(env.CLAWSWEEPER_CRABFLEET_AGENT_TOKEN, undefined);
      assert.equal(env.CLAWSWEEPER_CRABFLEET_SERVICE_TOKEN, undefined);
      assert.equal(env.CLAWSWEEPER_CRABFLEET_RUNNER_PTY_URL, undefined);
      assert.equal(env.CLAWSWEEPER_CRABFLEET_WORK_STATE_URL, undefined);
      assert.equal(env.PNPM_CONFIG_IGNORE_SCRIPTS, "true");
      assert.equal(env.PNPM_CONFIG_IGNORE_PNPMFILE, "true");
      assert.equal(env.npm_config_ignore_scripts, "true");
      assert.equal(internalCodexModel("internal"), "secret-model");
      assert.deepEqual(codexModelArgs("internal"), []);
      assert.deepEqual(codexModelArgs("secret-model"), []);
      assert.deepEqual(codexModelArgs("explicit-public-model"), [
        "--model",
        "explicit-public-model",
      ]);
    },
  );
});

test("clawsweeper git identity defaults to avatar-friendly bot name", () => {
  withEnv({ CLAWSWEEPER_GIT_USER_NAME: "", CLAWSWEEPER_GIT_USER_EMAIL: "" }, () => {
    assert.equal(clawsweeperGitUserName(), "clawsweeper");
    assert.deepEqual(clawsweeperGitIdentityEnv(), {
      GIT_AUTHOR_NAME: "clawsweeper",
      GIT_AUTHOR_EMAIL: "274271284+clawsweeper[bot]@users.noreply.github.com",
      GIT_COMMITTER_NAME: "clawsweeper",
      GIT_COMMITTER_EMAIL: "274271284+clawsweeper[bot]@users.noreply.github.com",
    });
  });
});

test("repair OpenClaw env preserves provider auth without exposing Codex auth", () => {
  withEnv(
    {
      GITHUB_ACTIONS: "true",
      CLAWSWEEPER_RUNNER: "openclaw",
      OPENAI_API_KEY: "openai",
      CODEX_API_KEY: "codex",
    },
    () => {
      const env = codexSubprocessEnv();
      assert.equal(env.OPENAI_API_KEY, "openai");
      assert.equal(env.CODEX_API_KEY, undefined);
    },
  );
});

test("Codex subprocess prevents pnpm deploy from installing target Git hooks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-pnpm-hooks-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

  try {
    fs.mkdirSync(path.join(root, "scripts"));
    fs.mkdirSync(path.join(root, "git-hooks"));
    fs.writeFileSync(
      path.join(root, "scripts", "prepare.mjs"),
      'import { execFileSync } from "node:child_process"; execFileSync("git", ["config", "core.hooksPath", "git-hooks"], { cwd: process.cwd() });\n',
    );
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "clawsweeper-hook-fixture",
        version: "1.0.0",
        scripts: { prepare: "node scripts/prepare.mjs" },
      }),
    );
    fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), 'packages:\n  - "."\n');
    git("init", "-q");

    const deploy = (name: string, env: NodeJS.ProcessEnv) =>
      spawnSync(
        "pnpm",
        [
          "--filter",
          "clawsweeper-hook-fixture",
          "deploy",
          "--prod",
          "--legacy",
          path.join(root, name),
        ],
        { cwd: root, encoding: "utf8", env },
      );

    const unsafe = deploy("unsafe", {
      ...process.env,
      PNPM_CONFIG_IGNORE_SCRIPTS: "false",
      npm_config_ignore_scripts: "false",
    });
    assert.equal(unsafe.status, 0, unsafe.stderr || unsafe.stdout);
    assert.equal(git("config", "--local", "--get", "core.hooksPath"), "git-hooks");
    git("config", "--local", "--unset-all", "core.hooksPath");

    const safe = deploy("safe", codexSubprocessEnv());
    assert.equal(safe.status, 0, safe.stderr || safe.stdout);
    assert.doesNotMatch(safe.stdout, /prepare\$/);
    const hooks = spawnSync("git", ["config", "--local", "--get", "core.hooksPath"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(hooks.status, 1);

    fs.writeFileSync(
      path.join(root, ".pnpmfile.cjs"),
      'require("node:child_process").execFileSync("git", ["config", "core.hooksPath", "git-hooks"], { cwd: process.cwd() }); module.exports = { hooks: {} };\n',
    );
    const unsafePnpmfile = deploy("unsafe-pnpmfile", {
      ...codexSubprocessEnv(),
      PNPM_CONFIG_IGNORE_PNPMFILE: "false",
    });
    assert.equal(unsafePnpmfile.status, 0, unsafePnpmfile.stderr || unsafePnpmfile.stdout);
    assert.equal(git("config", "--local", "--get", "core.hooksPath"), "git-hooks");
    git("config", "--local", "--unset-all", "core.hooksPath");

    const safePnpmfile = deploy("safe-pnpmfile", codexSubprocessEnv());
    assert.equal(safePnpmfile.status, 0, safePnpmfile.stderr || safePnpmfile.stdout);
    const pnpmfileHooks = spawnSync("git", ["config", "--local", "--get", "core.hooksPath"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(pnpmfileHooks.status, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Codex subprocess forces Bun installs to ignore lifecycle scripts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-bun-hooks-"));
  const bin = path.join(root, "bin");
  const argsPath = path.join(root, "bun-args.json");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

  try {
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(root, "git-hooks"));
    fs.writeFileSync(path.join(root, ".env"), "");
    fs.writeFileSync(
      path.join(bin, "bun"),
      `#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args));
if (args.includes("--version")) { console.log("fake-bun"); process.exit(0); }
if (!args.includes("--ignore-scripts")) {
  execFileSync("git", ["config", "core.hooksPath", "git-hooks"], { cwd: process.cwd() });
}
`,
      { mode: 0o755 },
    );
    git("init", "-q");
    const originalPath = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;

    const unsafe = spawnSync("bun", ["install"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: originalPath },
    });
    assert.equal(unsafe.status, 0, unsafe.stderr);
    assert.equal(git("config", "--local", "--get", "core.hooksPath"), "git-hooks");
    git("config", "--local", "--unset-all", "core.hooksPath");

    withEnv({ PATH: originalPath }, () => {
      const env = codexSubprocessEnv();
      const safe = spawnSync("bun", ["--cwd", root, "install"], {
        cwd: root,
        encoding: "utf8",
        env,
      });
      assert.equal(safe.status, 0, safe.stderr);
      assert.deepEqual(JSON.parse(fs.readFileSync(argsPath, "utf8")), [
        "--cwd",
        root,
        "install",
        "--ignore-scripts",
      ]);
      const shortCwd = spawnSync("bun", ["-C", root, "install"], {
        cwd: root,
        encoding: "utf8",
        env,
      });
      assert.equal(shortCwd.status, 0, shortCwd.stderr);
      assert.deepEqual(JSON.parse(fs.readFileSync(argsPath, "utf8")), [
        "-C",
        root,
        "install",
        "--ignore-scripts",
      ]);
      const envFile = spawnSync("bun", ["--env-file", ".env", "install"], {
        cwd: root,
        encoding: "utf8",
        env,
      });
      assert.equal(envFile.status, 0, envFile.stderr);
      assert.deepEqual(JSON.parse(fs.readFileSync(argsPath, "utf8")), [
        "--env-file",
        ".env",
        "install",
        "--ignore-scripts",
      ]);
      const hooks = spawnSync("git", ["config", "--local", "--get", "core.hooksPath"], {
        cwd: root,
        encoding: "utf8",
      });
      assert.equal(hooks.status, 1);

      const passthrough = spawnSync("bun", ["--version"], { cwd: root, encoding: "utf8", env });
      assert.equal(passthrough.status, 0, passthrough.stderr);
      assert.equal(passthrough.stdout.trim(), "fake-bun");

      const override = spawnSync("bun", ["install", "--no-ignore-scripts"], {
        cwd: root,
        encoding: "utf8",
        env,
      });
      assert.equal(override.status, 2);
      assert.match(override.stderr, /blocked a Bun lifecycle-script override/);

      const installTrusted = spawnSync("bun", ["add", "--trust", "fixture"], {
        cwd: root,
        encoding: "utf8",
        env,
      });
      assert.equal(installTrusted.status, 2);
      assert.match(installTrusted.stderr, /blocked a Bun lifecycle-script override/);

      for (const preloadArgs of [
        ["--preload", "./hook.ts", "install"],
        ["--preload=./hook.ts", "install"],
        ["-r./hook.ts", "install"],
        ["--require", "./hook.ts", "install"],
        ["--import=./hook.ts", "install"],
        ["--eval", "callback()", "install"],
        ["--eval=callback()", "install"],
        ["-e", "callback()", "install"],
        ["-ecallback()", "install"],
        ["--print", "callback()", "install"],
        ["--print=callback()", "install"],
        ["-p", "callback()", "install"],
        ["-be", "callback()", "install"],
        ["-bp", "callback()", "install"],
        ["-br", "./hook.ts", "install"],
      ]) {
        const preload = spawnSync("bun", preloadArgs, { cwd: root, encoding: "utf8", env });
        assert.equal(preload.status, 2, preloadArgs.join(" "));
        assert.match(preload.stderr, /blocked a Bun preload or evaluation callback/);
      }

      const productionInstall = spawnSync("bun", ["install", "-p"], {
        cwd: root,
        encoding: "utf8",
        env,
      });
      assert.equal(productionInstall.status, 0, productionInstall.stderr);
      assert.deepEqual(JSON.parse(fs.readFileSync(argsPath, "utf8")), [
        "install",
        "--ignore-scripts",
        "-p",
      ]);

      const trusted = spawnSync("bun", ["pm", "trust"], { cwd: root, encoding: "utf8", env });
      assert.equal(trusted.status, 2);
      assert.match(trusted.stderr, /blocked Bun trusted lifecycle execution/);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Codex subprocess fails closed when Bun repair would run on Windows", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-windows-bun-"));
  const platform = Object.getOwnPropertyDescriptor(process, "platform");

  try {
    fs.writeFileSync(path.join(root, "bun.exe"), "fixture");
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    withEnv({ PATH: root, PATHEXT: ".EXE;.CMD" }, () => {
      assert.throws(codexSubprocessEnv, /Bun repair execution requires a Linux runner/);
    });
    withEnv({ PATH: "", Path: root, PATHEXT: ".EXE;.CMD" }, () => {
      assert.throws(codexSubprocessEnv, /Bun repair execution requires a Linux runner/);
    });
  } finally {
    if (platform) Object.defineProperty(process, "platform", platform);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("repair Codex config reserves xhigh for explicit issue-fix execution", () => {
  assert.equal(repairCodexReasoningEffort(undefined), "high");
  assert.equal(repairCodexReasoningEffort(""), "high");
  assert.equal(repairCodexReasoningEffort("xhigh"), "high");
  assert.equal(repairCodexReasoningEffort("XHIGH"), "high");
  assert.equal(repairCodexReasoningEffort("xhigh", true), "xhigh");
  assert.equal(repairCodexReasoningEffort("XHIGH", true), "xhigh");
  assert.equal(repairCodexReasoningEffort("medium"), "medium");

  assert.equal(repairCodexServiceTier(undefined), "fast");
  assert.equal(repairCodexServiceTier(""), "fast");
  assert.equal(repairCodexServiceTier("fast"), "fast");
});

function withEnv(values: Record<string, string>, callback: () => void) {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value) process.env[key] = value;
    else delete process.env[key];
  }
  try {
    callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
