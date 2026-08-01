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
      GH_TOKEN: "secret",
      GITHUB_TOKEN: "secret",
      GITHUB_ACTIONS: "true",
      OPENAI_API_KEY: "secret",
      CODEX_API_KEY: "secret",
      CLAWSWEEPER_INTERNAL_MODEL: "secret-model",
      CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "agent-secret",
      CLAWSWEEPER_CRABFLEET_SERVICE_TOKEN: "service-secret",
      CLAWSWEEPER_CRABFLEET_RUNNER_PTY_URL: "wss://example.invalid/secret",
      CLAWSWEEPER_CRABFLEET_WORK_STATE_URL: "https://example.invalid/secret",
      PNPM_CONFIG_IGNORE_SCRIPTS: "false",
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
      assert.equal(env.CLAWSWEEPER_TARGET_GH_TOKEN, undefined);
      assert.equal(env.OPENAI_API_KEY, undefined);
      assert.equal(env.CODEX_API_KEY, undefined);
      assert.equal(env.CLAWSWEEPER_INTERNAL_MODEL, undefined);
      assert.equal(env.CLAWSWEEPER_CRABFLEET_AGENT_TOKEN, undefined);
      assert.equal(env.CLAWSWEEPER_CRABFLEET_SERVICE_TOKEN, undefined);
      assert.equal(env.CLAWSWEEPER_CRABFLEET_RUNNER_PTY_URL, undefined);
      assert.equal(env.CLAWSWEEPER_CRABFLEET_WORK_STATE_URL, undefined);
      assert.equal(env.PNPM_CONFIG_IGNORE_SCRIPTS, "true");
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
  } finally {
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
