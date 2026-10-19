import { openclawProviderEnv } from "./openclaw-process.js";
import {
  registerOpenclawProviderCapabilities,
  registerPublicationCapability,
  registerCodexAuthCapabilities,
} from "./publication-dlp.js";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type CodexEnvOptions = {
  ghToken?: string | undefined;
  preserveCodexAuth?: boolean | undefined;
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
  additionalModels: readonly string[] = [],
): string {
  let redacted = value ?? "";
  const configuredModels = [
    process.env.CLAWSWEEPER_INTERNAL_MODEL?.trim() ?? "",
    process.env.CLAWSWEEPER_OPENCLAW_MODEL?.trim() ?? "",
    ...additionalModels,
  ];
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
  // Replacing a prefix first would expose the remainder of a longer private ID.
  for (const model of configuredModels.filter(Boolean).sort((a, b) => b.length - a.length)) {
    redacted = redacted.replaceAll(model, "[REDACTED_INTERNAL_MODEL]");
  }
  return redacted.replace(
    /(Rate limit reached for\s+)\S+(?=\s+(?:\(for limit\b|on (?:tokens|requests) per min\b))/gi,
    "$1[REDACTED_INTERNAL_MODEL]",
  );
}

// Only runtime/tool controls cross the model boundary. Job-level additions stay private.
const CODEX_ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "CODEX_HOME",
  "CODEX_BIN",
  "CODEX_BIN_ARGS",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "TZ",
  "TERM",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "CI",
  "GITHUB_ACTIONS",
  "GITHUB_WORKSPACE",
  "RUNNER_TEMP",
  "RUNNER_OS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  // Windows command resolution and the local Codex Desktop fallback.
  "SystemRoot",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  // Read-only Git discovery and isolation; never numbered/config-parameter overrides.
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_NO_LAZY_FETCH",
  "GIT_TERMINAL_PROMPT",
  "GH_CONFIG_DIR",
  "CLAWSWEEPER_RUNNER",
  "CLAWSWEEPER_REVIEW_TOOLS_DIR",
  "CLAWSWEEPER_PROOF_SCRATCH_DIR",
]);

const OPENCLAW_ENV_ALLOWLIST = new Set([
  "CLAWSWEEPER_OPENCLAW_MODEL",
  "CLAWSWEEPER_OPENCLAW_BIN",
  "CLAWSWEEPER_OPENCLAW_PROVIDERS_JSON",
]);

export function codexEnv(options: CodexEnvOptions = {}): NodeJS.ProcessEnv {
  registerCodexAuthCapabilities();
  const env: NodeJS.ProcessEnv = {};
  const openclaw = process.env.CLAWSWEEPER_RUNNER?.trim() === "openclaw";
  if (openclaw)
    registerOpenclawProviderCapabilities(process.env.CLAWSWEEPER_OPENCLAW_PROVIDERS_JSON);
  for (const [key, value] of Object.entries(process.env)) {
    if (
      CODEX_ENV_ALLOWLIST.has(key) ||
      /^LC_[A-Z_]+$/.test(key) ||
      (openclaw && OPENCLAW_ENV_ALLOWLIST.has(key)) ||
      (!openclaw &&
        options.preserveCodexAuth &&
        ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"].includes(key))
    ) {
      env[key] = value;
    }
  }
  if (openclaw) Object.assign(env, openclawProviderEnv(process.env));
  if (openclaw || !options.preserveCodexAuth) {
    // Keep Codex configuration/auth at its existing explicit location, not under the new HOME.
    env.CODEX_HOME ||= join(process.env.HOME || homedir(), ".codex");
    for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) delete env[key];
  }
  const ghToken = options.ghToken?.trim();
  if (ghToken) {
    env.GH_TOKEN = ghToken;
    registerPublicationCapability(ghToken);
  }
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}
