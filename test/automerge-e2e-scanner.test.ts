import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCommandBin } from "./e2e/automerge/run.mjs";

test("automerge tool fixtures require a fresh scan of each fake model prompt", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-e2e-scanner-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = createCommandBin(root);
  const target = path.join(root, "target");
  fs.mkdirSync(target);
  const schema = path.join(root, "codex-review.schema.json");
  fs.writeFileSync(schema, "{}");
  const output = path.join(root, "review.json");
  const env = {
    PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}`,
    HOME: root,
    TMPDIR: root,
    CLAWSWEEPER_E2E_GITHUB_STATE: path.join(root, "github-state.json"),
  };
  const prompt = "Review the synthetic automerge fixture.\n";
  const model = (input = prompt) =>
    spawnSync(
      process.execPath,
      [path.join(bin, "codex"), "--output-schema", schema, "--output-last-message", output],
      { cwd: target, env, input, encoding: "utf8" },
    );
  const unscanned = model();
  assert.notEqual(unscanned.status, 0);
  assert.match(unscanned.stderr, /requires an input scan before execution/);
  assert.equal(fs.existsSync(output), false);

  const scannerModule = new URL("../dist/agent-input-scan.js", import.meta.url).href;
  const scanned = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { scanAgentInput } from ${JSON.stringify(scannerModule)};
scanAgentInput({ cwd: process.cwd(), prompt: ${JSON.stringify(prompt)}, source: { kind: 'prompt' }, timeoutMs: 10000 });`,
    ],
    { cwd: target, env, encoding: "utf8" },
  );
  assert.equal(scanned.status, 0, scanned.stderr);
  const differentPrompt = model("A different prompt.");
  assert.notEqual(differentPrompt.status, 0);
  assert.match(differentPrompt.stderr, /requires a scan of the current prompt/);
  assert.equal(fs.existsSync(output), false);
  const reviewed = model();
  assert.equal(reviewed.status, 0, reviewed.stderr);
  assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).status, "clean");
  const reused = model();
  assert.notEqual(reused.status, 0);
  assert.match(reused.stderr, /requires an input scan before execution/);
});
