import {
  CLAWSWEEPER_APP_LOGIN,
  CLAWSWEEPER_APP_NOREPLY_EMAIL,
  CLAWSWEEPER_APP_SLUG,
} from "../clawsweeper-bot-identity.js";

export function ghCliEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return withoutColor({ ...process.env, ...overrides });
}

// Commits authored as the App slug show the App avatar, so the App login and
// the legacy repair name map to it.
export function clawsweeperGitUserName(): string {
  const configured = String(process.env.CLAWSWEEPER_GIT_USER_NAME ?? "").trim();
  if (!configured || configured === "clawsweeper-repair" || configured === CLAWSWEEPER_APP_LOGIN) {
    return CLAWSWEEPER_APP_SLUG;
  }
  return configured;
}

export function clawsweeperGitUserEmail(): string {
  return (
    String(process.env.CLAWSWEEPER_GIT_USER_EMAIL ?? "").trim() || CLAWSWEEPER_APP_NOREPLY_EMAIL
  );
}

function withoutColor(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  env.NO_COLOR = "1";
  env.CLICOLOR = "0";
  delete env.FORCE_COLOR;
  return env;
}
