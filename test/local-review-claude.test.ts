import assert from "node:assert/strict";
import test from "node:test";

import {
  buildClaudeReviewArgs,
  claudeReviewEnv,
  extractJsonObject,
  parseClaudeResultRecord,
  CLAUDE_REVIEW_READONLY_TOOLS,
  SCRUBBED_CREDENTIAL_ENV_KEYS,
} from "../dist/claude-engine.js";

test("buildClaudeReviewArgs uses a read-only tool allow-list and no permission bypass", () => {
  const args = buildClaudeReviewArgs({ proofScratchDir: "/tmp/scratch" });
  // Headless JSON output.
  assert.deepEqual(args.slice(0, 3), ["-p", "--output-format", "json"]);
  // Explicit read-only allow-list, never a bypass.
  assert.ok(args.includes("--allowedTools"));
  for (const tool of CLAUDE_REVIEW_READONLY_TOOLS) assert.ok(args.includes(tool));
  assert.ok(!args.includes("bypassPermissions"));
  assert.ok(!args.includes("--permission-mode"));
  // No mutating tools are ever permitted.
  for (const tool of ["Edit", "Write", "NotebookEdit", "Bash"]) {
    assert.ok(!args.includes(tool), `must not allow ${tool}`);
  }
  assert.deepEqual(
    args.slice(args.indexOf("--add-dir")),
    ["--add-dir", "/tmp/scratch"],
    "scratch dir is the last arg group when no model is set",
  );
});

test("buildClaudeReviewArgs appends --model only when provided", () => {
  assert.ok(!buildClaudeReviewArgs({ proofScratchDir: "/s" }).includes("--model"));
  const withModel = buildClaudeReviewArgs({ proofScratchDir: "/s", model: "claude-x" });
  assert.deepEqual(withModel.slice(-2), ["--model", "claude-x"]);
});

test("claudeReviewEnv scrubs credentials the configurable binary must not receive", () => {
  const base: NodeJS.ProcessEnv = {
    GH_TOKEN: "gh",
    GITHUB_TOKEN: "ghub",
    COMMIT_SWEEPER_TARGET_GH_TOKEN: "t",
    CLAWSWEEPER_PROOF_INSPECTION_TOKEN: "pi",
    CLAWSWEEPER_APP_ID: "id",
    CLAWSWEEPER_APP_PRIVATE_KEY: "key",
    OPENAI_API_KEY: "oai",
    CODEX_API_KEY: "cdx",
    ANTHROPIC_API_KEY: "anthropic-kept",
    PATH: "/usr/bin",
  };
  const env = claudeReviewEnv(base);
  for (const key of SCRUBBED_CREDENTIAL_ENV_KEYS) {
    assert.equal(env[key], undefined, `${key} must be scrubbed`);
  }
  // Claude's own auth and benign vars are preserved; the source env is untouched.
  assert.equal(env.ANTHROPIC_API_KEY, "anthropic-kept");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.GIT_OPTIONAL_LOCKS, "0");
  assert.equal(base.GH_TOKEN, "gh", "input env must not be mutated");
});

test("parseClaudeResultRecord finds the result in the --output-format json array", () => {
  const raw = JSON.stringify([
    { type: "system", subtype: "init" },
    { type: "stream_event", event: {} },
    { type: "result", subtype: "success", is_error: false, result: "{\"ok\":true}", structured_output: { ok: true } },
  ]);
  const parsed = parseClaudeResultRecord(raw);
  assert.ok(parsed);
  assert.equal(parsed.isError, false);
  assert.equal(parsed.resultText, '{"ok":true}');
  assert.deepEqual(parsed.structuredOutput, { ok: true });
});

test("parseClaudeResultRecord finds the result in stream-json (NDJSON) lines", () => {
  const raw = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "result", is_error: false, result: "done" }),
  ].join("\n");
  const parsed = parseClaudeResultRecord(raw);
  assert.ok(parsed);
  assert.equal(parsed.resultText, "done");
});

test("parseClaudeResultRecord surfaces errors and returns null when no result record exists", () => {
  const err = parseClaudeResultRecord(
    JSON.stringify([{ type: "result", is_error: true, error: "boom", result: "" }]),
  );
  assert.ok(err);
  assert.equal(err.isError, true);
  assert.equal(err.errorText, "boom");
  assert.equal(parseClaudeResultRecord(JSON.stringify([{ type: "system" }])), null);
  assert.equal(parseClaudeResultRecord(""), null);
  assert.equal(parseClaudeResultRecord("not json at all"), null);
});

test("extractJsonObject handles bare objects, fenced blocks, and surrounding prose", () => {
  assert.equal(extractJsonObject('{"a":1}'), '{"a":1}');
  assert.equal(extractJsonObject('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(extractJsonObject('Here is the decision:\n{"a":1}\nThanks.'), '{"a":1}');
  assert.equal(extractJsonObject("no object here"), null);
  assert.equal(extractJsonObject(""), null);
});
