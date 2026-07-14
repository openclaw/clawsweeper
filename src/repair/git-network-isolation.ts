import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCommand as run, runCommandResult as runResult } from "./command-runner.js";

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
  const fetchDestination = args[0] === "fetch" ? isolatedFetchDestination(args) : null;
  const source = targetGitObjectStore(cwd, sourceEnv, timeoutMs, fetchDestination);
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
    const isolatedArgs = prepareIsolatedFetch({
      args,
      cwd,
      env,
      networkGitDir,
      source,
      timeoutMs,
    });
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
        ...isolatedArgs,
      ],
      { cwd: root, env, timeoutMs },
    );
    mirrorFetchedRef({ args, cwd, env, hooksDir, networkGitDir, source, timeoutMs });
    return output;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function targetGitObjectStore(
  cwd: string,
  sourceEnv: NodeJS.ProcessEnv,
  timeoutMs: number,
  fetchDestination: string | null,
) {
  const env = isolatedNetworkEnv(sourceEnv);
  Object.assign(env, {
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_NO_REPLACE_OBJECTS: "1",
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
  const validatedObjectFormat: "sha1" | "sha256" = objectFormat;
  return {
    commonDir,
    objectDirectory,
    objectFormat: validatedObjectFormat,
    partialCloneFilter: targetPartialCloneFilter(commonDir, fetchDestination, cwd, env, timeoutMs),
    shallowOids: targetShallowOids(commonDir, validatedObjectFormat),
  };
}

function prepareIsolatedFetch({
  args,
  cwd,
  env,
  networkGitDir,
  source,
  timeoutMs,
}: {
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  networkGitDir: string;
  source: ReturnType<typeof targetGitObjectStore>;
  timeoutMs: number;
}) {
  if (args[0] !== "fetch") return [...args];
  const destination = isolatedFetchDestination(args);
  const negotiationTip = sourceRefSha({
    cwd,
    destination,
    env,
    source,
    timeoutMs,
  });
  if (source.shallowOids.length > 0) {
    fs.writeFileSync(path.join(networkGitDir, "shallow"), `${source.shallowOids.join("\n")}\n`, {
      mode: 0o600,
    });
  }
  if (negotiationTip) {
    run("git", [`--git-dir=${networkGitDir}`, "update-ref", destination, negotiationTip], {
      cwd,
      env,
      timeoutMs,
    });
  }
  return [
    "fetch",
    ...(source.partialCloneFilter ? [`--filter=${source.partialCloneFilter}`] : []),
    ...(negotiationTip ? [`--negotiation-tip=${negotiationTip}`] : []),
    ...args.slice(1),
  ];
}

function sourceRefSha({
  cwd,
  destination,
  env,
  source,
  timeoutMs,
}: {
  cwd: string;
  destination: string;
  env: NodeJS.ProcessEnv;
  source: ReturnType<typeof targetGitObjectStore>;
  timeoutMs: number;
}) {
  const localEnv = isolatedNetworkEnv(env);
  delete localEnv.GIT_OBJECT_DIRECTORY;
  const result = runResult(
    "git",
    [`--git-dir=${source.commonDir}`, "rev-parse", "--verify", "--quiet", destination],
    { cwd, env: localEnv, timeoutMs },
  );
  if (result.error) throw result.error;
  if (result.status === 1) return null;
  if (result.status !== 0) {
    throw new Error(
      String(result.stderr || `could not inspect isolated Git fetch destination ${destination}`),
    );
  }
  const sha = String(result.stdout ?? "").trim();
  assertObjectId(sha, source.objectFormat, `source ref ${destination}`);
  return sha;
}

function targetPartialCloneFilter(
  commonDir: string,
  fetchDestination: string | null,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
) {
  if (fetchDestination === null) return null;
  const remote = fetchDestination.split("/")[2] ?? "";
  const promisor = readOptionalLocalGitConfig(
    commonDir,
    `remote.${remote}.promisor`,
    cwd,
    env,
    timeoutMs,
  );
  if (promisor === null || /^(?:0|false|no|off)$/i.test(promisor)) return null;
  const filter = readOptionalLocalGitConfig(
    commonDir,
    `remote.${remote}.partialCloneFilter`,
    cwd,
    env,
    timeoutMs,
  );
  if (!/^(?:1|on|true|yes)$/i.test(promisor) || filter === null) {
    throw new Error(`target partial-clone remote ${remote} is missing promisor filter metadata`);
  }
  if (filter.length > 1_024 || !/^[A-Za-z0-9][A-Za-z0-9%:+=._/@{}^~,-]*$/.test(filter)) {
    throw new Error(`unsupported target partial-clone filter: ${filter}`);
  }
  return filter;
}

function readOptionalLocalGitConfig(
  commonDir: string,
  key: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
) {
  const result = runResult(
    "git",
    [`--git-dir=${commonDir}`, "config", "--local", "--no-includes", "--get", key],
    { cwd, env, timeoutMs },
  );
  if (result.error) throw result.error;
  if (result.status === 1) return null;
  if (result.status !== 0) {
    throw new Error(String(result.stderr || `could not inspect target Git configuration: ${key}`));
  }
  return String(result.stdout ?? "").trim();
}

function targetShallowOids(commonDir: string, objectFormat: "sha1" | "sha256") {
  const shallowPath = path.join(commonDir, "shallow");
  if (!fs.existsSync(shallowPath)) return [];
  const stat = fs.lstatSync(shallowPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("unsupported target Git shallow boundary");
  }
  return fs
    .readFileSync(shallowPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((oid) => {
      assertObjectId(oid, objectFormat, "target shallow boundary");
      return oid;
    });
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
  const destination = isolatedFetchDestination(args);
  const fetchedSha = run(
    "git",
    [`--git-dir=${networkGitDir}`, "rev-parse", "--verify", destination],
    { cwd, env, timeoutMs },
  ).trim();
  assertObjectId(fetchedSha, source.objectFormat, `isolated Git fetch result ${destination}`);
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

function isolatedFetchDestination(args: readonly string[]) {
  const refspec = args.at(-1) ?? "";
  const separator = refspec.indexOf(":");
  const destination = separator >= 0 ? refspec.slice(separator + 1) : "";
  if (
    destination.includes("..") ||
    !/^refs\/remotes\/[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+$/.test(destination)
  ) {
    throw new Error(`unsupported isolated Git fetch destination: ${destination || "missing"}`);
  }
  return destination;
}

function assertObjectId(value: string, objectFormat: "sha1" | "sha256", label: string) {
  if (!new RegExp(`^[0-9a-f]{${objectFormat === "sha256" ? 64 : 40}}$`).test(value)) {
    throw new Error(`${label} has an invalid object id`);
  }
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
