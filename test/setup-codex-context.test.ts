import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";

const actionPath = resolve(".github/actions/setup-codex");
const action = parse(readFileSync(join(actionPath, "action.yml"), "utf8"));
const step = action.runs.steps.find((entry) => entry.name === "Configure direct API context");
const version = action.inputs["codex-version"].default;
const modelInfo = {
  slug: "gpt-6-astra",
  display_name: "Synthetic native model",
  model_messages: { instructions_template: "SYNTHETIC_NATIVE_INSTRUCTIONS" },
  supported_reasoning_levels: [{ effort: "high", description: "High" }],
  shell_type: "unified_exec",
  supported_in_api: true,
  context_window: 272000,
  max_context_window: 872000,
  minimal_client_version: "0.153.0",
  node_repl_auto_review_required: true,
  node_repl_disabled: false,
  tool_mode: "code_mode_only",
  use_responses_lite: true,
  auto_review_model_override: null,
  future_native_requirement: { preserve: true },
};
const originalConfig = `model = "gpt-6-astra"
model_provider = "clawsweeper-responses-proxy"

[model_providers.clawsweeper-responses-proxy]
name = "ClawSweeper Responses Proxy"
base_url = "http://127.0.0.1:12345/v1"
wire_api = "responses"
`;

function fixture(document: unknown, model = modelInfo.slug) {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-api-context-"));
  const config = join(root, "config.toml");
  const preload = join(root, "fetch.mjs");
  const request = join(root, "request.json");
  writeFileSync(config, originalConfig.replaceAll(modelInfo.slug, model));
  writeFileSync(
    preload,
    `
import { writeFileSync } from "node:fs";
globalThis.fetch = async (url) => {
  writeFileSync(${JSON.stringify(request)}, JSON.stringify({ url }));
  return new Response(${JSON.stringify(JSON.stringify(document))});
};
`,
  );
  const run = () =>
    spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(preload).href,
        join(actionPath, "configure-api-context.mjs"),
        version,
      ],
      {
        encoding: "utf8",
        env: { CODEX_HOME: root, CLAWSWEEPER_INTERNAL_MODEL: model },
      },
    );
  return { root, config, request, run, original: readFileSync(config, "utf8") };
}

test("direct API setup preserves the complete native catalogue and existing proxy authentication", () => {
  const supportedModels = [
    modelInfo,
    ...["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"].map((slug) => ({
      ...modelInfo,
      slug,
      node_repl_auto_review_required: false,
    })),
  ];
  const reviewer = {
    ...modelInfo,
    slug: "synthetic-native-reviewer",
    max_context_window: 272000,
    model_messages: { instructions_template: "SYNTHETIC_NATIVE_REVIEW_POLICY" },
  };
  const document = { models: [...supportedModels, reviewer], future_catalog_field: "preserve" };
  const f = fixture(document);
  try {
    assert.equal(
      step.if,
      "${{ inputs['auth-mode'] == 'proxy' || inputs['auth-mode'] == 'login' }}",
    );
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(f.request, "utf8")), {
      url: `https://raw.githubusercontent.com/openai/codex/rust-v${version}/codex-rs/models-manager/models.json`,
    });
    const catalogPath = join(f.root, "api-models.json");
    assert.deepEqual(JSON.parse(readFileSync(catalogPath, "utf8")), {
      ...document,
      models: [
        ...supportedModels.map((entry) => ({
          ...entry,
          context_window: 922000,
          max_context_window: 922000,
          auto_compact_token_limit: 700000,
          effective_context_window_percent: 95,
        })),
        reviewer,
      ],
    });
    const config = readFileSync(f.config, "utf8");
    assert.ok(config.endsWith(f.original));
    assert.ok(
      config.startsWith(
        'model_context_window = 922000\nmodel_auto_compact_token_limit = 700000\nmodel_auto_compact_token_limit_scope = "total"\n',
      ),
    );
    assert.ok(config.includes(`model_catalog_json = ${JSON.stringify(catalogPath)}`));
    if (process.platform !== "win32") {
      assert.equal(statSync(catalogPath).mode & 0o777, 0o600);
      assert.equal(statSync(f.config).mode & 0o777, 0o600);
    }
    assert.doesNotMatch(result.stdout + result.stderr, /gpt-6-astra|SYNTHETIC_NATIVE/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("other model selections keep native context without fetching or changing setup", () => {
  const f = fixture(null, "synthetic-private-selection");
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /override not applied; retaining native model limits/);
    assert.equal(readFileSync(f.config, "utf8"), f.original);
    assert.equal(existsSync(f.request), false);
    assert.equal(existsSync(join(f.root, "api-models.json")), false);
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-private-selection/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("recognized API models fail before changing config when native metadata is unavailable", () => {
  for (const document of [
    { models: [] },
    { models: [{ slug: modelInfo.slug }] },
    { models: [{ ...modelInfo, node_repl_auto_review_required: undefined }] },
    { models: [{ ...modelInfo, minimal_client_version: "99.0.0" }] },
    { models: [modelInfo, { slug: "gpt-5.6-sol" }] },
  ]) {
    const f = fixture(document);
    try {
      const result = f.run();
      assert.equal(result.status, 1);
      assert.equal(readFileSync(f.config, "utf8"), f.original);
      assert.equal(existsSync(join(f.root, "api-models.json")), false);
      assert.match(result.stderr, /Direct API context setup failed/);
      assert.doesNotMatch(result.stdout + result.stderr, /gpt-6-astra|SYNTHETIC_NATIVE/);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});
