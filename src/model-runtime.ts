import { readFileSync } from "node:fs";

export type ModelRuntime = "codex" | "claude";

export function modelRuntime(env: NodeJS.ProcessEnv = process.env): ModelRuntime {
  const value = env.CLAWSWEEPER_MODEL_RUNTIME?.trim().toLowerCase();
  if (!value || value === "codex") return "codex";
  if (value === "claude") return "claude";
  throw new Error(
    `Invalid CLAWSWEEPER_MODEL_RUNTIME: ${env.CLAWSWEEPER_MODEL_RUNTIME}. Expected "codex" or "claude".`,
  );
}

export function modelRuntimeName(env: NodeJS.ProcessEnv = process.env): string {
  return modelRuntime(env) === "claude" ? "Claude CLI" : "Codex";
}

export function modelRuntimeCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const path = env.CLAWSWEEPER_CLAUDE_CREDENTIALS_FILE?.trim();
  if (!path) return {};
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("CLAWSWEEPER_CLAUDE_CREDENTIALS_FILE must contain a JSON object.");
  }
  const credentials: NodeJS.ProcessEnv = {};
  const allowedKeys = new Set([
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "ANTHROPIC_FOUNDRY_API_KEY",
    "ANTHROPIC_FOUNDRY_BASE_URL",
    "ANTHROPIC_FOUNDRY_RESOURCE",
    "AWS_ACCESS_KEY_ID",
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_DEFAULT_REGION",
    "AWS_PROFILE",
    "AWS_REGION",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_VERTEX",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_REGION",
  ]);
  for (const [key, entry] of Object.entries(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unsupported Claude credential environment variable: ${key}.`);
    }
    if (typeof entry !== "string") {
      throw new Error(`Claude credential ${key} must be a string.`);
    }
    if (entry) credentials[key] = entry;
  }
  return credentials;
}
