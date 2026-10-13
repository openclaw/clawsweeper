import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/check-local-codex.mjs", import.meta.url));

function fixture(t: TestContext, status = 0) {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-local-codex-check-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = join(root, "codex.mjs");
  const calls = join(root, "calls.jsonl");
  writeFileSync(
    binary,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
process.exit(args[0] === "login" ? ${status} : 0);
`,
  );
  chmodSync(binary, 0o755);
  return {
    run(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
      return spawnSync(process.execPath, [script, ...args], {
        encoding: "utf8",
        env: { ...process.env, CODEX_BIN: binary, ...extraEnv },
        timeout: 10_000,
      });
    },
    calls(): string[][] {
      return existsSync(calls)
        ? readFileSync(calls, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [];
    },
  };
}

test("diagnostics accepts the package runner separator without inference", (t) => {
  const check = fixture(t);
  const result = check.run(["--", "--diagnostics", "--model", "flag-model"], {
    CLAWSWEEPER_LOCAL_CODEX_MODEL: "environment-model",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(check.calls(), [["login", "status", "-c", 'service_tier="fast"']]);
  assert.match(result.stdout, /Model access not tested\./);
  assert.doesNotMatch(result.stdout, /smoke|preflight passed/);
});

test("default check still runs the model smoke after login", (t) => {
  const check = fixture(t);
  const result = check.run([], { CLAWSWEEPER_LOCAL_CODEX_MODEL: "environment-model" });
  assert.equal(result.status, 0, result.stderr);
  const calls = check.calls();
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.[0], "login");
  assert.deepEqual(calls[1]?.slice(0, 3), ["exec", "-m", "environment-model"]);
  assert.match(result.stdout, /Codex local preflight passed\./);
});

test("explicit smoke model takes precedence over the environment", (t) => {
  const check = fixture(t);
  const result = check.run(["--model", "flag-model"], {
    CLAWSWEEPER_LOCAL_CODEX_MODEL: "environment-model",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(check.calls()[1]?.slice(0, 3), ["exec", "-m", "flag-model"]);
});

test("failed login preserves the failure exit and never runs inference", (t) => {
  const check = fixture(t, 3);
  const result = check.run(["--diagnostics"]);
  assert.equal(result.status, 1);
  assert.equal(check.calls().length, 1);
  assert.match(result.stderr, /Codex login status failed\./);
  assert.doesNotMatch(result.stdout, /passed/);
});

test("help does not invoke Codex", (t) => {
  const check = fixture(t);
  const result = check.run(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(check.calls(), []);
  assert.match(result.stdout, /--diagnostics/);
});

for (const args of [["--diagnostic"], ["--diagnostics", "--model"]]) {
  test(`invalid options do not invoke Codex: ${args.join(" ")}`, (t) => {
    const check = fixture(t);
    const result = check.run(args);
    assert.equal(result.status, 1);
    assert.deepEqual(check.calls(), []);
    assert.match(result.stderr, /Usage:/);
  });
}
