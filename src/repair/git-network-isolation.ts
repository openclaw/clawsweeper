import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCommand as run } from "./command-runner.js";

export type IsolatedGitNetworkOptions = {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  token: string;
};

export function runIsolatedGitNetwork({
  args,
  cwd,
  env: sourceEnv,
  timeoutMs,
  token,
}: IsolatedGitNetworkOptions): string {
  if (args.length === 0) throw new Error("isolated Git network command is missing");
  const source = targetGitObjectStore(cwd, timeoutMs);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-git-network-"));
  const networkGitDir = path.join(root, "network.git");
  const hooksDir = path.join(root, "hooks");
  const globalConfig = path.join(root, "gitconfig");
  const askpassPath = path.join(root, "askpass.sh");
  fs.mkdirSync(hooksDir, { mode: 0o700 });
  fs.writeFileSync(globalConfig, "", { mode: 0o600 });
  fs.writeFileSync(
    askpassPath,
    [
      "#!/bin/sh",
      'case "$1" in',
      '  *Username*) printf "%s\\n" "x-access-token" ;;',
      '  *) printf "%s\\n" "$CLAWSWEEPER_GIT_TOKEN" ;;',
      "esac",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  const env = isolatedNetworkEnv(sourceEnv);
  Object.assign(env, {
    CLAWSWEEPER_GIT_TOKEN: token,
    GIT_ASKPASS: askpassPath,
    GIT_ASKPASS_REQUIRE: "force",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: globalConfig,
    GIT_OBJECT_DIRECTORY: source.objectDirectory,
    GIT_TERMINAL_PROMPT: "0",
    HOME: root,
    XDG_CONFIG_HOME: root,
  });
  try {
    run(
      "git",
      [
        "init",
        "--bare",
        "--quiet",
        ...(source.objectFormat === "sha256" ? ["--object-format=sha256"] : []),
        networkGitDir,
      ],
      { cwd: root, env, timeoutMs },
    );
    const output = run(
      "git",
      [
        `--git-dir=${networkGitDir}`,
        "-c",
        `core.hooksPath=${hooksDir}`,
        "-c",
        "commit.gpgSign=false",
        "-c",
        "tag.gpgSign=false",
        "-c",
        "push.gpgSign=false",
        "-c",
        "push.recurseSubmodules=no",
        "-c",
        "submodule.recurse=false",
        "-c",
        "credential.helper=",
        "-c",
        "protocol.ext.allow=never",
        ...args,
      ],
      { cwd: root, env, timeoutMs },
    );
    mirrorFetchedRef({ args, cwd, env, hooksDir, networkGitDir, source, timeoutMs });
    return output;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function targetGitObjectStore(cwd: string, timeoutMs: number) {
  const env = isolatedNetworkEnv(process.env);
  Object.assign(env, {
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_OPTIONAL_LOCKS: "0",
  });
  const commonDir = fs.realpathSync(
    path.resolve(
      cwd,
      run("git", ["-c", "core.fsmonitor=false", "rev-parse", "--git-common-dir"], {
        cwd,
        env,
        timeoutMs,
      }).trim(),
    ),
  );
  const objectDirectory = fs.realpathSync(path.join(commonDir, "objects"));
  const objectFormat = run("git", ["rev-parse", "--show-object-format"], {
    cwd,
    env,
    timeoutMs,
  }).trim();
  if (objectFormat !== "sha1" && objectFormat !== "sha256") {
    throw new Error(`unsupported target Git object format: ${objectFormat}`);
  }
  return { commonDir, objectDirectory, objectFormat };
}

function mirrorFetchedRef({
  args,
  cwd,
  env,
  hooksDir,
  networkGitDir,
  source,
  timeoutMs,
}: {
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  hooksDir: string;
  networkGitDir: string;
  source: ReturnType<typeof targetGitObjectStore>;
  timeoutMs: number;
}) {
  if (args[0] !== "fetch") return;
  const refspec = args.at(-1) ?? "";
  const separator = refspec.indexOf(":");
  const destination = separator >= 0 ? refspec.slice(separator + 1) : "";
  if (
    !destination.startsWith("refs/remotes/") ||
    destination.includes("..") ||
    !/^refs\/remotes\/[A-Za-z0-9._/-]+$/.test(destination)
  ) {
    throw new Error(`unsupported isolated Git fetch destination: ${destination || "missing"}`);
  }
  const fetchedSha = run(
    "git",
    [`--git-dir=${networkGitDir}`, "rev-parse", "--verify", destination],
    { cwd, env, timeoutMs },
  ).trim();
  if (!new RegExp(`^[0-9a-f]{${source.objectFormat === "sha256" ? 64 : 40}}$`).test(fetchedSha)) {
    throw new Error(`isolated Git fetch returned an invalid object id for ${destination}`);
  }
  const localEnv = isolatedNetworkEnv(env);
  delete localEnv.CLAWSWEEPER_GIT_TOKEN;
  delete localEnv.GIT_ASKPASS;
  delete localEnv.GIT_ASKPASS_REQUIRE;
  delete localEnv.GIT_OBJECT_DIRECTORY;
  run(
    "git",
    [
      `--git-dir=${source.commonDir}`,
      "-c",
      `core.hooksPath=${hooksDir}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "commit.gpgSign=false",
      "update-ref",
      destination,
      fetchedSha,
    ],
    { cwd, env: localEnv, timeoutMs },
  );
}

function isolatedNetworkEnv(source: NodeJS.ProcessEnv) {
  const env = { ...source };
  for (const name of Object.keys(env)) {
    if (
      /^GIT_/i.test(name) ||
      /^(?:GH|GITHUB)_/i.test(name) ||
      /^(?:SSH_ASKPASS|SSH_ASKPASS_REQUIRE)$/i.test(name)
    ) {
      delete env[name];
    }
  }
  return env;
}
