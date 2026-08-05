import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexLoginConfig, codexModelArgs, internalCodexModel } from "../codex-env.js";

export { codexLoginConfig, codexModelArgs, internalCodexModel };

const guardedBunDirectories = new Map<string, string>();

export function ghCliEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return withoutColor({ ...process.env, ...overrides });
}

export function repairGhEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return ghCliEnv(overrides);
}

export function codexSubprocessEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...clawsweeperGitIdentityEnv(),
    PNPM_CONFIG_IGNORE_SCRIPTS: "true",
    PNPM_CONFIG_IGNORE_PNPMFILE: "true",
    npm_config_ignore_scripts: "true",
  };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const searchPath = env[pathKey];
  const bunExecutable = findExecutable("bun", searchPath);
  if (bunExecutable) {
    if (process.platform === "win32") {
      throw new Error(
        "Bun repair execution requires a Linux runner; refusing unsafe lifecycle scripts",
      );
    }
    env[pathKey] = `${guardedBunDirectory(bunExecutable)}${path.delimiter}${searchPath ?? ""}`;
  }
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.REPO_TOKEN;
  delete env.CLAWSWEEPER_CRABFLEET_AGENT_TOKEN;
  delete env.CLAWSWEEPER_CRABFLEET_SERVICE_TOKEN;
  delete env.CLAWSWEEPER_CRABFLEET_RUNNER_PTY_URL;
  delete env.CLAWSWEEPER_CRABFLEET_WORK_STATE_URL;
  for (const key of Object.keys(env)) {
    if (/^CLAWSWEEPER_.*GH_TOKEN$/.test(key)) delete env[key];
  }
  if (process.env.GITHUB_ACTIONS === "true") {
    if (env.CLAWSWEEPER_RUNNER !== "openclaw") delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
  }
  delete env.CLAWSWEEPER_INTERNAL_MODEL;
  return withoutColor(env);
}

export function repairCodexReasoningEffort(
  value = process.env.CLAWSWEEPER_CODEX_REASONING_EFFORT,
  allowExtraHigh = false,
) {
  const effort = String(value ?? "high").trim() || "high";
  return effort.toLowerCase() === "xhigh" ? (allowExtraHigh ? "xhigh" : "high") : effort;
}

export function repairCodexServiceTier(value = process.env.CLAWSWEEPER_CODEX_SERVICE_TIER) {
  return String(value ?? "fast").trim() || "fast";
}

export function clawsweeperGitUserName(): string {
  const configured = String(process.env.CLAWSWEEPER_GIT_USER_NAME ?? "").trim();
  if (!configured || configured === "clawsweeper-repair" || configured === "clawsweeper[bot]") {
    return "clawsweeper";
  }
  return configured;
}

export function clawsweeperGitUserEmail(): string {
  return (
    String(process.env.CLAWSWEEPER_GIT_USER_EMAIL ?? "").trim() ||
    "274271284+clawsweeper[bot]@users.noreply.github.com"
  );
}

export function clawsweeperGitIdentityEnv(): NodeJS.ProcessEnv {
  const name = clawsweeperGitUserName();
  const email = clawsweeperGitUserEmail();
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}

function withoutColor(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  env.NO_COLOR = "1";
  env.CLICOLOR = "0";
  delete env.FORCE_COLOR;
  return env;
}

function findExecutable(name: string, searchPath: string | undefined): string | null {
  if (!searchPath) return null;
  const extensions =
    process.platform === "win32"
      ? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").toLowerCase().split(";")]
      : [""];
  for (const directory of searchPath.split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      try {
        fs.accessSync(
          candidate,
          process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK,
        );
        if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate);
      } catch {
        continue;
      }
    }
  }
  return null;
}

function guardedBunDirectory(executable: string): string {
  const cached = guardedBunDirectories.get(executable);
  if (cached) return cached;

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-safe-bun-"));
  fs.chmodSync(directory, 0o700);
  const shim = `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const optionsWithValues = new Set(["-C", "-c", "--cwd", "--config", "--filter", "-F"]);
const bunCommands = new Set(["run", "test", "x", "repl", "exec", "install", "i", "add", "a", "remove", "rm", "update", "audit", "outdated", "link", "unlink", "publish", "patch", "pm", "info", "why", "build", "init", "create", "c", "upgrade", "feedback"]);
let commandIndex = -1;
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === "--") break;
  if (/^(?:-[^-]*[rep].*|--(?:preload|require|import|loader|experimental-loader|eval|print)(?:=.*)?)$/.test(argument)) {
    console.error("ClawSweeper blocked a Bun preload or evaluation callback.");
    process.exit(2);
  }
  if (optionsWithValues.has(argument)) { index += 1; continue; }
  if (argument.startsWith("-")) continue;
  if (!bunCommands.has(argument)) continue;
  commandIndex = index;
  break;
}
const command = commandIndex < 0 ? "" : args[commandIndex];
if (["install", "i", "add", "a", "update", "upgrade", "remove", "rm", "link", "unlink"].includes(command)) {
  if (args.some((argument) => /^--(?:no-ignore-scripts|ignore-scripts=(?:false|0)|trust)$/.test(argument))) {
    console.error("ClawSweeper blocked a Bun lifecycle-script override.");
    process.exit(2);
  }
  args.splice(commandIndex + 1, 0, "--ignore-scripts");
} else if (command === "pm" && args[commandIndex + 1] === "trust") {
  console.error("ClawSweeper blocked Bun trusted lifecycle execution.");
  process.exit(2);
}
const result = spawnSync(${JSON.stringify(executable)}, args, { stdio: "inherit", env: process.env });
if (result.error) { console.error(result.error.message); process.exit(1); }
process.exit(result.status ?? 1);
`;
  fs.writeFileSync(path.join(directory, "bun"), shim, { mode: 0o700 });
  guardedBunDirectories.set(executable, directory);
  return directory;
}
