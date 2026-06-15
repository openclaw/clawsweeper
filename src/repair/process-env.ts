import { codexLoginConfig, codexModelArgs, internalCodexModel } from "../codex-env.js";

export { codexLoginConfig, codexModelArgs, internalCodexModel };

export function ghCliEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return withoutColor({ ...process.env, ...overrides });
}

export function repairGhEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return ghCliEnv(overrides);
}

export function codexSubprocessEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env, ...clawsweeperGitIdentityEnv() };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.CLAWSWEEPER_CRABFLEET_AGENT_TOKEN;
  delete env.CLAWSWEEPER_CRABFLEET_SERVICE_TOKEN;
  delete env.CLAWSWEEPER_CRABFLEET_RUNNER_PTY_URL;
  delete env.CLAWSWEEPER_CRABFLEET_WORK_STATE_URL;
  for (const key of Object.keys(env)) {
    if (/^CLAWSWEEPER_.*GH_TOKEN$/.test(key)) delete env[key];
  }
  if (process.env.GITHUB_ACTIONS === "true") {
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
  }
  delete env.CLAWSWEEPER_INTERNAL_MODEL;
  return withoutColor(env);
}

export function repairCodexReasoningEffort(value = process.env.CLAWSWEEPER_CODEX_REASONING_EFFORT) {
  const effort = String(value ?? "high").trim() || "high";
  return effort.toLowerCase() === "xhigh" ? "high" : effort;
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
