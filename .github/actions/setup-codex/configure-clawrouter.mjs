import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const alias = "internal";

try {
  const home = process.env.CODEX_HOME;
  const raw = process.env.CLAWSWEEPER_CLAWROUTER_CONFIG ?? "";
  if (Buffer.byteLength(raw) > 256 * 1024) throw new Error("Private configuration is too large.");
  const settings = JSON.parse(raw);
  if (
    !settings ||
    typeof settings !== "object" ||
    Array.isArray(settings) ||
    Object.keys(settings).sort().join(",") !== "baseUrl,modelInfo,token"
  )
    throw new Error("Invalid private configuration.");
  const base = new URL(settings.baseUrl);
  const local = ["127.0.0.1", "[::1]"].includes(base.hostname);
  if (
    !home ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname.replace(/\/$/, "") !== "/private/v1" ||
    (base.protocol !== "https:" &&
      !(local && base.protocol === "http:" && process.env.GITHUB_ACTIONS !== "true"))
  ) {
    throw new Error("Invalid private endpoint configuration.");
  }
  const credential = settings.token;
  if (
    typeof credential !== "string" ||
    !/^private-workload-[A-Za-z0-9_-]{32,128}$/.test(credential)
  ) {
    throw new Error("Invalid private workload credential.");
  }
  const model = settings.modelInfo;
  if (
    !model ||
    typeof model !== "object" ||
    Array.isArray(model) ||
    model.slug !== alias ||
    model.display_name !== "Codex" ||
    !Array.isArray(model.supported_reasoning_levels) ||
    typeof model.shell_type !== "string" ||
    typeof model.supported_in_api !== "boolean" ||
    (model.upgrade != null && model.upgrade.model !== alias) ||
    (model.auto_review_model_override != null && model.auto_review_model_override !== alias)
  ) {
    throw new Error("Full alias-only native model metadata is required.");
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const catalog = join(home, "clawrouter-models.json");
  writeFileSync(catalog, JSON.stringify({ models: [model] }), { mode: 0o600 });
  chmodSync(catalog, 0o600);
  const config = [
    `model = ${JSON.stringify(alias)}`,
    'model_provider = "openai"',
    `openai_base_url = ${JSON.stringify(base.href.replace(/\/$/, ""))}`,
    `model_catalog_json = ${JSON.stringify(catalog)}`,
    'forced_login_method = "api"',
    'cli_auth_credentials_store = "file"',
    "",
  ].join("\n");
  writeFileSync(join(home, "config.toml"), config, { mode: 0o600 });
  chmodSync(join(home, "config.toml"), 0o600);
  const env = { ...process.env };
  for (const key of [
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "CODEX_ACCESS_TOKEN",
    "PROXY_API_KEY",
    "CLAWSWEEPER_INTERNAL_MODEL",
    "CLAWSWEEPER_CLAWROUTER_CONFIG",
  ])
    delete env[key];
  const login = spawnSync("codex", ["login", "--with-api-key"], {
    env,
    input: credential,
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (login.error || login.status !== 0) throw new Error("Private workload authentication failed.");
  console.log("Configured private ClawRouter inference with alias-only metadata.");
} catch {
  // Configuration and native errors may contain credentials, URLs, or model metadata.
  console.error(
    "Private ClawRouter setup failed; check its endpoint, workload credential, and native model metadata.",
  );
  process.exitCode = 1;
}
