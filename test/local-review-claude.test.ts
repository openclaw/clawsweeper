import assert from "node:assert/strict";
import test from "node:test";

import {
  buildClaudeReviewArgs,
  claudeReviewEnv,
  extractJsonObject,
  parseClaudeResultRecord,
  pruneToSchema,
  CLAUDE_REVIEW_READONLY_TOOLS,
  SCRUBBED_CREDENTIAL_ENV_KEYS,
} from "../dist/claude-engine.js";

const REVIEW_FINDING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    decision: { type: "string" },
    reviewFindings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          file: { type: "string" },
          lineStart: { type: "number" },
        },
      },
    },
    reviewMetrics: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { label: { type: "string" }, value: { type: "string" } },
      },
    },
  },
};

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

test("pruneToSchema drops the stray keys Claude improvises and keeps real data", () => {
  // The exact shapes the Claude review engine emitted in live runs: an extra
  // `kind` on a review finding and a `label_note` on a review metric.
  const { value, droppedPaths } = pruneToSchema(
    {
      decision: "keep_open",
      reviewFindings: [{ title: "t", file: "a.ts", lineStart: 1, kind: "bug" }],
      reviewMetrics: [{ label: "scope", value: "small", label_note: "extra" }],
      bogusTopLevelKey: 123,
    },
    REVIEW_FINDING_SCHEMA,
  );
  assert.deepEqual(droppedPaths.sort(), [
    "bogusTopLevelKey",
    "reviewFindings[0].kind",
    "reviewMetrics[0].label_note",
  ]);
  const pruned = value as Record<string, any>;
  assert.equal(pruned.decision, "keep_open");
  assert.equal(pruned.reviewFindings[0].title, "t");
  assert.equal(pruned.reviewFindings[0].lineStart, 1);
  assert.equal(pruned.reviewMetrics[0].label, "scope");
  assert.ok(!("kind" in pruned.reviewFindings[0]));
  assert.ok(!("label_note" in pruned.reviewMetrics[0]));
  assert.ok(!("bogusTopLevelKey" in pruned));
});

test("pruneToSchema prunes nodes typed as a union (e.g. [\"object\",\"null\"]) or with type omitted", () => {
  const schema = {
    type: "object",
    properties: {
      // nullable object (union type) — must still be pruned
      nested: {
        type: ["object", "null"],
        properties: { keep: { type: "string" } },
      },
      // object node with no explicit `type`, only `properties`
      bag: { properties: { keep: { type: "string" } } },
    },
  };
  const { value, droppedPaths } = pruneToSchema(
    { nested: { keep: "a", stray: 1 }, bag: { keep: "b", stray2: 2 } },
    schema,
  );
  assert.deepEqual(droppedPaths.sort(), ["bag.stray2", "nested.stray"]);
  const pruned = value as Record<string, any>;
  assert.equal(pruned.nested.keep, "a");
  assert.ok(!("stray" in pruned.nested));
  assert.equal(pruned.bag.keep, "b");
  assert.ok(!("stray2" in pruned.bag));
});

test("pruneToSchema reports nothing to drop for a clean object and ignores unschema'd nodes", () => {
  assert.deepEqual(
    pruneToSchema({ decision: "close", reviewFindings: [] }, REVIEW_FINDING_SCHEMA).droppedPaths,
    [],
  );
  // A node the schema does not describe as object/array passes through untouched.
  assert.equal(pruneToSchema("scalar", REVIEW_FINDING_SCHEMA).value, "scalar");
  assert.deepEqual(pruneToSchema({ any: 1 }, undefined).value, { any: 1 });
});

test("pruneToSchema passes values through untouched when the schema node is malformed or mismatched", () => {
  // null / non-object schema node → value returned as-is (top-of-walk guard).
  assert.deepEqual(pruneToSchema({ a: 1 }, null).value, { a: 1 });
  // `properties` present but not an object → not treated as an object node.
  const notObj = pruneToSchema({ a: 1, b: 2 }, { properties: "nope" });
  assert.deepEqual(notObj.value, { a: 1, b: 2 });
  assert.deepEqual(notObj.droppedPaths, []);
  // Array schema but the value is not an array → returned unchanged, never mapped.
  assert.deepEqual(
    pruneToSchema({ a: 1 }, { type: "array", items: { type: "object", properties: {} } }).value,
    { a: 1 },
  );
});
