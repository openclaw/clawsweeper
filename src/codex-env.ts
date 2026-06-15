import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type CodexEnvOptions = {
  ghToken?: string | undefined;
};

export type CodexLoginMethod = "api" | "chatgpt";

export const PUBLIC_CODEX_MODEL = "internal";

export function codexLoginMethod(
  value = process.env.CLAWSWEEPER_CODEX_LOGIN_METHOD,
): CodexLoginMethod {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "api";
  if (normalized === "api" || normalized === "chatgpt") return normalized;
  throw new Error(`Invalid CLAWSWEEPER_CODEX_LOGIN_METHOD: ${value}. Expected "api" or "chatgpt".`);
}

export function codexLoginConfig(value?: string): string {
  return `forced_login_method="${codexLoginMethod(value)}"`;
}

export function internalCodexModel(requestedModel: string): string {
  return process.env.CLAWSWEEPER_INTERNAL_MODEL?.trim() || requestedModel;
}

export function codexModelArgs(requestedModel: string): string[] {
  const model = String(requestedModel ?? "").trim();
  const internalModel = process.env.CLAWSWEEPER_INTERNAL_MODEL?.trim();
  if (!model || model === PUBLIC_CODEX_MODEL || (internalModel && model === internalModel))
    return [];
  return ["--model", model];
}

export function redactInternalCodexModel(
  value: string | null | undefined,
  codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"),
): string {
  let redacted = value ?? "";
  const configuredModels = [process.env.CLAWSWEEPER_INTERNAL_MODEL?.trim() ?? ""];
  const configPath = codexHome ? join(codexHome, "config.toml") : "";
  if (configPath && existsSync(configPath)) {
    const match = readFileSync(configPath, "utf8").match(
      /^\s*model\s*=\s*("(?:\\.|[^"\\])*")\s*$/m,
    );
    if (match?.[1]) {
      try {
        configuredModels.push(String(JSON.parse(match[1])).trim());
      } catch {
        // Malformed config is a Codex setup failure, not a reason to expose its contents.
      }
    }
  }
  for (const model of configuredModels.filter(Boolean)) {
    redacted = redacted.replaceAll(model, "[REDACTED_INTERNAL_MODEL]");
  }
  return redacted.replace(
    /(Rate limit reached for\s+)\S+(?=\s+(?:\(for limit\b|on (?:tokens|requests) per min\b))/gi,
    "$1[REDACTED_INTERNAL_MODEL]",
  );
}

export function codexEnv(options: CodexEnvOptions = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const ghToken = options.ghToken?.trim();
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.COMMIT_SWEEPER_TARGET_GH_TOKEN;
  delete env.CLAWSWEEPER_PROOF_INSPECTION_TOKEN;
  delete env.CLAWSWEEPER_APP_ID;
  delete env.CLAWSWEEPER_APP_PRIVATE_KEY;
  delete env.CLAWSWEEPER_CRABFLEET_AGENT_TOKEN;
  delete env.CLAWSWEEPER_CRABFLEET_SERVICE_TOKEN;
  delete env.CLAWSWEEPER_CRABFLEET_RUNNER_PTY_URL;
  delete env.CLAWSWEEPER_CRABFLEET_WORK_STATE_URL;
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.CLAWSWEEPER_INTERNAL_MODEL;
  if (ghToken) env.GH_TOKEN = ghToken;
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}
