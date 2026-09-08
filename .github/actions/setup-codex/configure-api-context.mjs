import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// These API models expose 1,050,000 total tokens and reserve 128,000 for output.
// Other model selections retain their native limits and existing setup behavior.
const longContextModels = new Set(["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);

function withApiContext(model, version) {
  if (!longContextModels.has(model?.slug)) return model;
  if (
    typeof model.model_messages !== "object" ||
    model.model_messages === null ||
    Array.isArray(model.model_messages) ||
    !Array.isArray(model.supported_reasoning_levels) ||
    typeof model.shell_type !== "string" ||
    model.supported_in_api !== true ||
    !Number.isInteger(model.context_window) ||
    model.context_window <= 0 ||
    !Number.isInteger(model.max_context_window) ||
    model.max_context_window <= 0 ||
    !/^\d+\.\d+\.\d+$/.test(model.minimal_client_version ?? "") ||
    version.localeCompare(model.minimal_client_version, undefined, { numeric: true }) < 0 ||
    typeof model.node_repl_auto_review_required !== "boolean" ||
    typeof model.node_repl_disabled !== "boolean"
  ) {
    throw new Error("Complete native model metadata is required.");
  }
  return {
    ...model,
    context_window: 922_000,
    max_context_window: 922_000,
    auto_compact_token_limit: 700_000,
    effective_context_window_percent: 95,
  };
}

async function configure() {
  const modelId = process.env.CLAWSWEEPER_INTERNAL_MODEL;
  if (!longContextModels.has(modelId)) {
    console.log("Direct API context override not applied; retaining native model limits.");
    return;
  }
  const home = process.env.CODEX_HOME;
  const version = process.argv[2];
  if (!home || !/^\d+\.\d+\.\d+$/.test(version ?? "")) {
    throw new Error("Missing setup inputs.");
  }
  const response = await fetch(
    `https://raw.githubusercontent.com/openai/codex/rust-v${version}/codex-rs/models-manager/models.json`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!response.ok) throw new Error("Native model catalogue unavailable.");
  const document = await response.json();
  if (
    !Array.isArray(document.models) ||
    !document.models.some((model) => model?.slug === modelId)
  ) {
    throw new Error("Selected native model metadata is required.");
  }
  // The catalogue is authoritative, not an overlay: retain native reviewer and
  // sibling metadata, changing only the documented API models' context allowance.
  const catalog = {
    ...document,
    models: document.models.map((model) => withApiContext(model, version)),
  };
  const catalogPath = join(home, "api-models.json");
  const configPath = join(home, "config.toml");
  const config = readFileSync(configPath, "utf8");
  writeFileSync(catalogPath, JSON.stringify(catalog), { mode: 0o600 });
  chmodSync(catalogPath, 0o600);
  writeFileSync(
    configPath,
    [
      "model_context_window = 922000",
      "model_auto_compact_token_limit = 700000",
      'model_auto_compact_token_limit_scope = "total"',
      `model_catalog_json = ${JSON.stringify(catalogPath)}`,
      "",
      config,
    ].join("\n"),
    { mode: 0o600 },
  );
  chmodSync(configPath, 0o600);
  console.log(
    "Configured direct API context with native model metadata and total-token compaction.",
  );
}

configure().catch(() => {
  // Native metadata and errors can contain private model routing identifiers.
  console.error(
    "Direct API context setup failed; check the pinned client and native model catalogue.",
  );
  process.exitCode = 1;
});
