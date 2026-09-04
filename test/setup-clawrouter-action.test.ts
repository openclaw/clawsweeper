import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

const script = resolve(".github/actions/setup-codex/configure-clawrouter.mjs");
const token = "private-workload-SYNTHETIC_PRIVATE_CREDENTIAL_123456789";
const modelInfo = {
  slug: "internal",
  display_name: "Codex",
  supported_reasoning_levels: [{ effort: "high", description: "High" }],
  shell_type: "shell_command",
  supported_in_api: true,
  use_responses_lite: true,
  auto_review_model_override: null,
};

function publicOutput(result: { stdout: string; stderr: string }) {
  return result.stdout.replace(/^::add-mask::[^\r\n]*\n/gm, "") + result.stderr;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-private-setup-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "codex"),
    `#!${process.execPath}\n
const fs = require('node:fs');
const input = fs.readFileSync(0, 'utf8');
fs.writeFileSync(process.env.CODEX_TEST_RECEIPT, JSON.stringify({ args: process.argv.slice(2), input, env: process.env }));
process.stderr.write('SYNTHETIC_PRIVATE_UPSTREAM_NAME ' + input);
process.exit(Number(process.env.CODEX_TEST_EXIT || 0));
`,
    { mode: 0o755 },
  );
  const receipt = join(root, "receipt.json");
  const run = (settings: unknown, extra: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        CODEX_HOME: home,
        CODEX_TEST_RECEIPT: receipt,
        GITHUB_ACTIONS: "true",
        OPENAI_API_KEY: "SYNTHETIC_UNRELATED_API_KEY",
        CLAWSWEEPER_INTERNAL_MODEL: "SYNTHETIC_PRIVATE_UPSTREAM_NAME",
        CLAWSWEEPER_CLAWROUTER_CONFIG:
          typeof settings === "string" ? settings : JSON.stringify(settings),
        ...extra,
      },
    });
  const settings = { baseUrl: "https://private.example.invalid/private/v1", token, modelInfo };
  return { root, home, receipt, settings, run };
}

test(
  "private setup preserves native metadata and authenticates only the isolated workload",
  { skip: process.platform === "win32" },
  () => {
    const f = fixture();
    try {
      const result = f.run(f.settings);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.startsWith(`::add-mask::${token}\n`));
      const receipt = JSON.parse(readFileSync(f.receipt, "utf8"));
      assert.deepEqual(receipt.args, ["login", "--with-api-key"]);
      assert.equal(receipt.input, token);
      for (const key of [
        "OPENAI_API_KEY",
        "CLAWSWEEPER_INTERNAL_MODEL",
        "CLAWSWEEPER_CLAWROUTER_CONFIG",
      ])
        assert.equal(receipt.env[key], undefined);
      const config = readFileSync(join(f.home, "config.toml"), "utf8");
      assert.match(config, /model = "internal"/);
      assert.match(config, /model_provider = "openai"/);
      assert.match(config, /openai_base_url = "https:\/\/private.example.invalid\/private\/v1"/);
      assert.deepEqual(JSON.parse(readFileSync(join(f.home, "clawrouter-models.json"), "utf8")), {
        models: [modelInfo],
      });
      assert.equal(statSync(join(f.home, "config.toml")).mode & 0o777, 0o600);
      assert.doesNotMatch(publicOutput(result) + config, /SYNTHETIC_PRIVATE|SYNTHETIC_UNRELATED/);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);

test("private setup rejects malformed config, non-private endpoints, and non-alias metadata before login", () => {
  const f = fixture();
  const userInfoUrl = new URL(f.settings.baseUrl);
  userInfoUrl.username = "synthetic-user";
  userInfoUrl.password = "synthetic-password";
  try {
    for (const settings of [
      "",
      "invalid",
      "gzip:invalid-base64",
      `gzip:${Buffer.from("invalid compressed data").toString("base64")}`,
      `gzip:${gzipSync(Buffer.alloc(256 * 1024 + 1)).toString("base64")}`,
      { ...f.settings, token: "SYNTHETIC_API_CREDENTIAL" },
      ...[
        "http://127.0.0.1/private/v1",
        "https://private.example.invalid/v1",
        userInfoUrl.href,
        "https://private.example.invalid/private/v1?model=SYNTHETIC_PRIVATE_UPSTREAM_NAME",
      ].map((baseUrl) => ({ ...f.settings, baseUrl })),
      { ...f.settings, modelInfo: { ...modelInfo, slug: "SYNTHETIC_PRIVATE_UPSTREAM_NAME" } },
      {
        ...f.settings,
        modelInfo: { ...modelInfo, auto_review_model_override: "SYNTHETIC_PRIVATE_REVIEW_NAME" },
      },
      { ...f.settings, modelInfo: { slug: "internal", display_name: "Codex" } },
    ]) {
      const result = f.run(settings);
      assert.equal(result.status, 1);
      assert.equal(existsSync(f.receipt), false);
      assert.equal(existsSync(join(f.home, "config.toml")), false);
      assert.doesNotMatch(result.stdout + result.stderr, /SYNTHETIC|private.example|user:pass/);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test(
  "native login failures fail closed without echoing private subprocess output",
  { skip: process.platform === "win32" },
  () => {
    const f = fixture();
    try {
      const result = f.run(f.settings, { CODEX_TEST_EXIT: "23" });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Private ClawRouter setup failed/);
      assert.doesNotMatch(publicOutput(result), /SYNTHETIC/);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);

test(
  "packed private configuration preserves a full catalog larger than an Actions secret",
  { skip: process.platform === "win32" },
  () => {
    const f = fixture();
    try {
      const largeModel = {
        ...modelInfo,
        model_messages: { base_instructions: "Synthetic native instruction.\n".repeat(3000) },
      };
      const raw = JSON.stringify({ ...f.settings, modelInfo: largeModel });
      const packed = `gzip:${gzipSync(raw).toString("base64")}`;
      assert.ok(Buffer.byteLength(raw) > 48 * 1024);
      assert.ok(Buffer.byteLength(packed) < 48 * 1024);
      const result = f.run(packed);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(readFileSync(join(f.home, "clawrouter-models.json"), "utf8")), {
        models: [largeModel],
      });
      assert.ok(result.stdout.startsWith(`::add-mask::${token}\n`));
      assert.doesNotMatch(publicOutput(result), /SYNTHETIC/);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);
