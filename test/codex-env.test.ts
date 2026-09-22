import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { codexEnv } from "../dist/codex-env.js";
import { codexSubprocessEnv } from "../dist/repair/process-env.js";

for (const builder of [codexEnv, codexSubprocessEnv]) {
  test(
    `${builder.name} removes inherited Git configuration before native Git runs`,
    {
      skip: process.platform === "win32" ? "native Git proof uses the Linux repair runtime" : false,
    },
    () => {
      const original = process.env;
      const root = mkdtempSync(join(tmpdir(), "codex-git-env-"));
      const emptyConfig = join(root, "empty-config");
      writeFileSync(emptyConfig, "");
      try {
        process.env = {
          ...original,
          GIT_CONFIG_GLOBAL: emptyConfig,
          GIT_CONFIG_SYSTEM: emptyConfig,
          GIT_CONFIG_NOSYSTEM: "1",
          GH_TOKEN: "synthetic-token",
          GITHUB_TOKEN: "synthetic-token",
          CLAWSWEEPER_TEST_GH_TOKEN: "synthetic-token",
          CLAWSWEEPER_GIT_USER_NAME: "clawsweeper-repair",
          CLAWSWEEPER_GIT_USER_EMAIL: "fixture@example.invalid",
        };
        for (const key of Object.keys(process.env)) {
          if (/^GIT_CONFIG_(COUNT|PARAMETERS|(KEY|VALUE)_\d+)$/i.test(key)) delete process.env[key];
        }
        const git = (env: NodeJS.ProcessEnv, ...args: string[]) =>
          execFileSync("git", args, {
            cwd: root,
            env,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          }).trim();
        git(process.env, "init");
        git(process.env, "config", "proof.indexed", "repository");
        git(process.env, "config", "proof.parameter", "repository");
        Object.assign(process.env, {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "proof.indexed",
          GIT_CONFIG_VALUE_0: "inherited-indexed",
          GIT_CONFIG_KEY_10: "proof.unused",
          GIT_CONFIG_VALUE_10: "unused",
          GIT_CONFIG_PARAMETERS: "'proof.parameter=inherited-parameter'",
        });
        assert.equal(git(process.env, "config", "--get", "proof.indexed"), "inherited-indexed");
        assert.equal(git(process.env, "config", "--get", "proof.parameter"), "inherited-parameter");
        const env = builder();
        assert.equal(git(env, "config", "--get", "proof.indexed"), "repository");
        assert.equal(git(env, "config", "--get", "proof.parameter"), "repository");
        assert.equal(
          git(env, "-c", "proof.indexed=explicit", "config", "--get", "proof.indexed"),
          "explicit",
        );
        git(env, "status", "--porcelain");
        for (const key of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"]) {
          assert.equal(env[key], process.env[key]);
        }
        for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "CLAWSWEEPER_TEST_GH_TOKEN"])
          assert.equal(env[key], undefined);
        assert.ok(
          !Object.keys(env).some((key) =>
            /^GIT_CONFIG_(COUNT|PARAMETERS|(KEY|VALUE)_\d+)$/i.test(key),
          ),
        );
        if (builder === codexSubprocessEnv) {
          for (const role of ["AUTHOR", "COMMITTER"]) {
            assert.equal(
              git(env, "var", `GIT_${role}_IDENT`).startsWith(
                "clawsweeper <fixture@example.invalid>",
              ),
              true,
            );
          }
        } else assert.equal(env.GIT_OPTIONAL_LOCKS, "0");
        console.log(
          JSON.stringify({
            builder: builder.name,
            git: git(env, "--version"),
            node: process.version,
            inheritedOverridesObserved: true,
            overridesRemoved: true,
            explicitConfigPreserved: true,
            isolationPreserved: true,
            tokensRemoved: true,
            repairIdentityPreserved: builder === codexSubprocessEnv,
          }),
        );
      } finally {
        process.env = original;
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test(`${builder.name} strips case variants and unused numbered override keys`, () => {
    const original = process.env;
    const keys = [
      "git_config_count",
      "Git_Config_Parameters",
      "git_config_key_0",
      "git_config_value_0",
      "GIT_CONFIG_KEY_42",
      "GIT_CONFIG_VALUE_42",
    ];
    try {
      process.env = {
        ...original,
        PATH: "",
        ...Object.fromEntries(keys.map((key) => [key, "synthetic"])),
      };
      const env = builder();
      for (const key of keys) assert.equal(env[key], undefined, key);
    } finally {
      process.env = original;
    }
  });
}
