import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const fixtureRoot = new URL("./fixtures/review-receipt/", import.meta.url);
const fixture = (name: string) => JSON.parse(readFileSync(new URL(name, fixtureRoot), "utf8"));

// JCS's safe-integer subset is sufficient for these cross-language manifest vectors.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(Reflect.get(value, key))}`)
      .join(",")}}`;
  }
  const text = JSON.stringify(value);
  if (text === undefined) throw new TypeError("fixture contains a non-JSON value");
  return text;
}

test("source manifest freezes canonical bytes and domain-separated digest", () => {
  const vector = fixture("source-manifest.json");
  const bytes = canonical(vector.manifest);
  assert.equal(bytes, vector.canonical_utf8);
  assert.equal(
    createHash("sha256").update(`openclaw-review-source-manifest-v1\n${bytes}`).digest("hex"),
    vector.sha256,
  );
  assert.notEqual(createHash("sha256").update(bytes).digest("hex"), vector.sha256);
});

test("Python and JavaScript independently reproduce the frozen manifest bytes", (t) => {
  const vector = fixture("source-manifest.json");
  const python = spawnSync(
    process.platform === "win32" ? "python" : "python3",
    [
      "-c",
      [
        "import json,sys,hashlib",
        "value=json.load(sys.stdin)",
        "def order(v):",
        " if isinstance(v,dict): return {k:order(v[k]) for k in sorted(v,key=lambda s:s.encode('utf-16-be'))}",
        " if isinstance(v,list): return [order(x) for x in v]",
        " return v",
        "text=json.dumps(order(value),ensure_ascii=False,separators=(',',':'))",
        "print(text)",
        "print(hashlib.sha256(('openclaw-review-source-manifest-v1\\n'+text).encode('utf-8')).hexdigest())",
      ].join("\n"),
    ],
    { input: JSON.stringify(vector.manifest), encoding: "utf8" },
  );
  if (python.error && "code" in python.error && python.error.code === "ENOENT") {
    t.skip("Python is not installed; JavaScript golden vector still runs");
    return;
  }
  assert.equal(python.status, 0, python.stderr);
  assert.deepEqual(python.stdout.trimEnd().split("\n"), [vector.canonical_utf8, vector.sha256]);
});

test("prospective receipts share selected source without claiming native outcome equivalence", () => {
  const autoreview = fixture("autoreview-filtered.json");
  const clawsweeper = fixture("clawsweeper-complete.json");
  assert.deepEqual(autoreview.receipt.input, clawsweeper.receipt.input);
  assert.equal(autoreview.native.status.exit_code, 0);
  assert.equal(autoreview.receipt.result.native_status, "filtered");
  assert.equal(autoreview.receipt.result.findings.filtered, null);
  assert.equal(clawsweeper.native.status, "completed");
  assert.equal(clawsweeper.receipt.result.native_status, "complete");
  assert.equal(clawsweeper.receipt.result.findings.accepted, null);
  assert.equal(autoreview.receipt.input.context_sha256, null);
  assert.notEqual(autoreview.receipt.input.repository, autoreview.receipt.input.target_repository);
  assert.equal(autoreview.receipt.execution.harness_version, null);
  assert.equal(clawsweeper.receipt.execution.harness_version, null);
  assert.equal(autoreview.receipt.execution.model, null);
});

test("usage preserves missing cache-write accounting and unknown attempt coverage", () => {
  const autoreview = fixture("autoreview-filtered.json");
  const clawsweeper = fixture("clawsweeper-complete.json");
  assert.equal(autoreview.native.status.usage.tokens.cache_write_input_tokens, undefined);
  assert.equal(autoreview.receipt.usage.tokens.cache_write_input_tokens, null);
  assert.equal(autoreview.receipt.usage.unknown_attempts, 1);
  assert.equal(autoreview.receipt.usage.complete, false);
  assert.equal(clawsweeper.receipt.usage.tokens.cache_write_input_tokens, 15);
  assert.equal(clawsweeper.receipt.usage.scope, "native-record");
  assert.equal(clawsweeper.receipt.usage.attempts, null);
  assert.equal(clawsweeper.receipt.usage.complete, null);
});
