import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { codexEnv } from "../dist/codex-env.js";

const builder = codexEnv;
test("local Codex auth retains a native profile when HOME is absent", () => {
  const original = process.env;
  try {
    process.env = {
      USERPROFILE: "C:\\synthetic-profile",
      GH_CONFIG_DIR: "C:\\synthetic-gh",
      GIT_CONFIG_GLOBAL: "C:\\synthetic-git",
    };
    const local = codexEnv({ preserveCodexAuth: true });
    assert.equal(local.HOME, process.env.USERPROFILE);
    assert.equal(local.USERPROFILE, process.env.USERPROFILE);
    assert.equal(local.GH_CONFIG_DIR, process.env.GH_CONFIG_DIR);
    assert.equal(local.GIT_CONFIG_GLOBAL, process.env.GIT_CONFIG_GLOBAL);
    assert.equal(codexEnv().HOME, undefined);
  } finally {
    process.env = original;
  }
});
test("hosted config pointers cannot expose parent credential files", async () => {
  const { isolatedReviewerHome } = await import("../dist/reviewer-home.js");
  const original = process.env;
  const root = mkdtempSync(join(tmpdir(), "config-pointers-"));
  const credentialFile = join(root, "parent-config");
  writeFileSync(credentialFile, "synthetic-parent-config-token-123456");
  const keys = [
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GH_CONFIG_DIR",
    "XDG_CONFIG_HOME",
    "NPM_CONFIG_USERCONFIG",
    "DOCKER_CONFIG",
  ];
  try {
    process.env = { ...original, ...Object.fromEntries(keys.map((key) => [key, credentialFile])) };
    for (const runner of ["codex", "openclaw"]) {
      process.env.CLAWSWEEPER_RUNNER = runner;
      const child = codexEnv({ preserveCodexAuth: runner === "openclaw" });
      for (const key of keys) assert.notEqual(child[key], credentialFile, `${runner}: ${key}`);
      const isolated = isolatedReviewerHome(child, join(root, runner));
      assert.equal(isolated.GIT_CONFIG_NOSYSTEM, "1");
      for (const key of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"]) {
        assert.ok(isolated[key]!.startsWith(isolated.HOME!));
        assert.equal(readFileSync(isolated[key]!, "utf8"), "");
      }
      assert.ok(isolated.GH_CONFIG_DIR!.startsWith(isolated.HOME!));
    }
    process.env.CLAWSWEEPER_RUNNER = "codex";
    const local = codexEnv({ preserveCodexAuth: true });
    for (const key of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GH_CONFIG_DIR"])
      assert.equal(local[key], credentialFile);
  } finally {
    process.env = original;
    rmSync(root, { recursive: true, force: true });
  }
});
test(
  `${builder.name} removes inherited Git configuration before native Git runs`,
  {
    skip: process.platform === "win32" ? "native Git proof uses the Linux review runtime" : false,
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
      assert.equal(env.GIT_CONFIG_GLOBAL, undefined);
      assert.equal(env.GIT_CONFIG_SYSTEM, undefined);
      assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
      for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "CLAWSWEEPER_TEST_GH_TOKEN"])
        assert.equal(env[key], undefined);
      assert.ok(
        !Object.keys(env).some((key) =>
          /^GIT_CONFIG_(COUNT|PARAMETERS|(KEY|VALUE)_\d+)$/i.test(key),
        ),
      );
      assert.equal(env.GIT_OPTIONAL_LOCKS, "0");
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

test("codexEnv admits only known runtime variables and an explicit read token", () => {
  const original = process.env;
  try {
    process.env = {
      PATH: "/bin",
      HOME: "/synthetic/home",
      CODEX_HOME: "/synthetic/codex",
      SOME_NEW_SECRET: "synthetic-secret",
      SOME_NEW_VARIABLE: "unknown",
      GH_TOKEN: "ambient",
      GITHUB_TOKEN: "ambient",
      CLAWSWEEPER_NEW_TOKEN: "unknown",
    };
    assert.deepEqual(codexEnv({ ghToken: "explicit-read" }), {
      PATH: "/bin",
      CODEX_HOME: "/synthetic/codex",
      GH_TOKEN: "explicit-read",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_CONFIG_NOSYSTEM: "1",
    });
  } finally {
    process.env = original;
  }
});

test("Codex auth is opt-in and OpenClaw receives only its supported provider credentials", () => {
  const original = process.env;
  try {
    process.env = {
      OPENAI_API_KEY: "fake-openai",
      CODEX_API_KEY: "fake-codex",
      CODEX_ACCESS_TOKEN: "fake-access",
      ANTHROPIC_API_KEY: "fake-anthropic",
      UNRELATED_API_KEY: "fake-unrelated",
      CLAWSWEEPER_OPENCLAW_MODEL: "anthropic/model",
      CLAWSWEEPER_OPENCLAW_OPENAI_KEY: "fake-fallback",
      CLAWSWEEPER_OPENCLAW_PROVIDERS_JSON: "{}",
      CLAWSWEEPER_OPENCLAW_BIN: "/fake/openclaw",
      CLAWSWEEPER_INTERNAL_MODEL: "private-model",
      CLAWSWEEPER_RUNNER: "codex",
    };
    const normal = codexEnv();
    assert.equal(normal.OPENAI_API_KEY, undefined);
    assert.equal(normal.ANTHROPIC_API_KEY, undefined);
    assert.equal(normal.CLAWSWEEPER_OPENCLAW_MODEL, undefined);
    const local = codexEnv({ preserveCodexAuth: true });
    assert.equal(local.OPENAI_API_KEY, "fake-openai");
    assert.equal(local.CODEX_API_KEY, "fake-codex");
    assert.equal(local.CODEX_ACCESS_TOKEN, "fake-access");
    process.env.CLAWSWEEPER_RUNNER = "openclaw";
    const openclaw = codexEnv();
    assert.equal(openclaw.ANTHROPIC_API_KEY, "fake-anthropic");
    assert.equal(openclaw.OPENAI_API_KEY, undefined);
    assert.equal(openclaw.CLAWSWEEPER_OPENCLAW_OPENAI_KEY, undefined);
    assert.equal(openclaw.CLAWSWEEPER_OPENCLAW_PROVIDERS_JSON, "{}");
    assert.equal(openclaw.CLAWSWEEPER_OPENCLAW_BIN, "/fake/openclaw");
    for (const env of [normal, local, openclaw]) {
      assert.equal(env.UNRELATED_API_KEY, undefined);
      assert.equal(env.CLAWSWEEPER_INTERNAL_MODEL, undefined);
    }
    assert.equal(openclaw.CODEX_API_KEY, undefined);
    assert.equal(openclaw.CODEX_ACCESS_TOKEN, undefined);
  } finally {
    process.env = original;
  }
});

test("OpenClaw forwards only selected builtin or custom provider credentials", () => {
  const original = process.env;
  try {
    process.env = {
      CLAWSWEEPER_RUNNER: "openclaw",
      CLAWSWEEPER_OPENCLAW_MODEL: "kimi/k3",
      KIMI_API_KEY: "fake-kimi",
      OPENAI_API_KEY: "fake-openai",
      ANTHROPIC_API_KEY: "fake-anthropic",
    };
    const kimi = codexEnv({ preserveCodexAuth: true });
    assert.equal(kimi.KIMI_API_KEY, "fake-kimi");
    assert.equal(kimi.OPENAI_API_KEY, undefined);
    assert.equal(kimi.ANTHROPIC_API_KEY, undefined);
    process.env.CLAWSWEEPER_OPENCLAW_MODEL = "custom/model";
    process.env.CUSTOM_PROVIDER_TOKEN = "fake-custom";
    process.env.CLAWSWEEPER_OPENCLAW_PROVIDERS_JSON = JSON.stringify({
      custom: { apiKey: "${CUSTOM_PROVIDER_TOKEN}" },
      other: { apiKey: "${ANTHROPIC_API_KEY}" },
    });
    const custom = codexEnv();
    assert.equal(custom.CUSTOM_PROVIDER_TOKEN, "fake-custom");
    assert.deepEqual(Object.keys(JSON.parse(custom.CLAWSWEEPER_OPENCLAW_PROVIDERS_JSON!)), [
      "custom",
    ]);
    assert.equal(custom.KIMI_API_KEY, undefined);
    assert.equal(custom.OPENAI_API_KEY, undefined);
    assert.equal(custom.ANTHROPIC_API_KEY, undefined);
  } finally {
    process.env = original;
  }
});

test("selected Kimi providers preserve either supported credential alias", () => {
  const original = process.env;
  try {
    for (const provider of ["kimi", "kimi-coding"]) {
      for (const key of ["KIMI_API_KEY", "KIMICODE_API_KEY"]) {
        process.env = {
          CLAWSWEEPER_RUNNER: "openclaw",
          CLAWSWEEPER_OPENCLAW_MODEL: `${provider}/k3`,
          [key]: "synthetic-kimi-provider-token",
          OPENAI_API_KEY: "unrelated-provider-token",
        };
        const selected = codexEnv();
        assert.equal(selected[key], process.env[key], `${provider}: ${key}`);
        assert.equal(selected.OPENAI_API_KEY, undefined);
      }
    }
  } finally {
    process.env = original;
  }
});

test("hosted and OpenClaw environments withhold credential home paths", () => {
  const original = process.env;
  try {
    process.env = {
      HOME: "/synthetic/real-home",
      USERPROFILE: "/synthetic/profile",
      APPDATA: "/synthetic/appdata",
      LOCALAPPDATA: "/synthetic/local",
      CODEX_HOME: "/synthetic/codex",
    };
    for (const runner of ["codex", "openclaw"]) {
      process.env.CLAWSWEEPER_RUNNER = runner;
      const env = codexEnv({ preserveCodexAuth: runner === "openclaw" });
      for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"])
        assert.equal(env[key], undefined, `${runner}: ${key}`);
      assert.equal(env.CODEX_HOME, "/synthetic/codex");
    }
    process.env.CLAWSWEEPER_RUNNER = "codex";
    assert.equal(codexEnv({ preserveCodexAuth: true }).HOME, process.env.HOME);
  } finally {
    process.env = original;
  }
});

test("Windows env names match the allowlist case-insensitively", () => {
  const original = process.env;
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    process.env = {
      Path: "C:\\Windows\\System32",
      CODEX_HOME: "C:\\synthetic-codex",
      Some_New_Secret: "synthetic-secret",
    };
    const env = codexEnv();
    assert.equal(env.PATH, "C:\\Windows\\System32");
    assert.equal(env.Path, undefined);
    assert.equal(env.Some_New_Secret, undefined);
    assert.equal(env.SOME_NEW_SECRET, undefined);
  } finally {
    Object.defineProperty(process, "platform", platform);
    process.env = original;
  }
});
