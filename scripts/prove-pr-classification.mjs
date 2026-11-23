#!/usr/bin/env node
// Controlled runtime proof: real CLI, scanner, ledger and label publisher;
// loopback Responses transport and executable GitHub fixture, never live writes.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = realpathSync(process.cwd());
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "classification-proof-")));
const statePath = join(scratch, "state.json");
const ghPath = join(scratch, "gh.cjs");
const preloadPath = join(scratch, "preload.mjs");
const output = resolve(process.argv[2] || ".artifacts/pr-classification-proof.json");
let calls = 0;
let mode = "classified";
const traces = [];
const source = () => ({
  number: 42,
  title: "Fix startup crash",
  body: "Startup crashes for all users after update.",
  state: "open",
  locked: false,
  updated_at: "2026-11-23T00:00:00Z",
  labels: [{ name: "maintainer" }, { name: "human-label" }],
  head: { sha: "a".repeat(40) },
  writes: [],
});
const readState = () => JSON.parse(readFileSync(statePath, "utf8"));
const saveState = (state) => writeFileSync(statePath, JSON.stringify(state));
writeFileSync(
  ghPath,
  'const fs = require("node:fs"); const assert = require("node:assert/strict");\n' +
    "const path = " +
    JSON.stringify(statePath) +
    '; const state = JSON.parse(fs.readFileSync(path, "utf8")); const raw = process.argv.slice(2); const scope = raw.indexOf("--repo"); if (scope >= 0) assert.equal(raw[scope + 1], "openclaw/openclaw"); const args = raw.filter((_, i) => scope < 0 || (i !== scope && i !== scope + 1));\n' +
    'if (args[0] === "api" && args[1] === "repos/openclaw/openclaw/pulls/42") console.log(JSON.stringify(state));\n' +
    'else if (args[0] === "api" && args[1].startsWith("repos/openclaw/openclaw/labels?")) console.log("[[]]");\n' +
    'else { assert.ok(scope >= 0); state.writes.push(args); if (args[0] === "issue" && args[1] === "edit") { for (let i=0;i<args.length;i++) if (args[i] === "--add-label") for (const name of args[++i].split(",")) state.labels.push({ name }); state.updated_at = "2026-11-23T00:00:01Z"; } else assert.equal(args[0], "label"); fs.writeFileSync(path, JSON.stringify(state)); }\n',
);
const server = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    try {
      calls++;
      assert.equal(request.url, "/v1/responses");
      const payload = JSON.parse(body);
      assert.equal(payload.store, false);
      assert.equal(payload.tools, undefined);
      assert.equal(payload.max_output_tokens, 256);
      assert.deepEqual(Object.keys(JSON.parse(payload.input)).sort(), [
        "body",
        "number",
        "repository",
        "title",
      ]);
      if (mode === "drift") {
        const state = readState();
        state.head.sha = "b".repeat(40);
        saveState(state);
      }
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          status: "completed",
          output: [
            {
              content:
                mode === "refusal"
                  ? [{ type: "refusal" }]
                  : [
                      {
                        type: "output_text",
                        text: JSON.stringify({ priority: "P1", impact: ["impact:crash-loop"] }),
                      },
                    ],
            },
          ],
          usage: { input_tokens: 200, output_tokens: 12 },
        }),
      );
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = "http://127.0.0.1:" + server.address().port;
writeFileSync(
  preloadPath,
  'const native = globalThis.fetch; globalThis.fetch = (url, init) => { if (String(url) !== "https://api.openai.com/v1/responses") throw Error("Unexpected outbound request"); return native(' +
    JSON.stringify(address + "/v1/responses") +
    ", init); };\n",
);
let invocation = 0;
async function run(name) {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/TOKEN|SECRET|API_KEY|EXACT_REVIEW|NODE_OPTIONS|NODE_V8_COVERAGE/.test(key))
      delete env[key];
  Object.assign(env, {
    GH_BIN: "/usr/bin/env",
    GH_BIN_ARGS: JSON.stringify([process.execPath, ghPath]),
    GH_TOKEN: "synthetic-proof-token",
    OPENAI_API_KEY: "synthetic-proof-key",
    TARGET_REPO: "openclaw/openclaw",
    ITEM_NUMBER: "42",
    CLAWSWEEPER_CLASSIFICATION_MODEL: "gpt-5.4-nano",
    CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
    CLAWSWEEPER_ACTION_LEDGER_DISABLED: "0",
    CLAWSWEEPER_ACTION_LEDGER_INVOCATION:
      "classification-proof-" + process.pid + "-" + ++invocation,
    CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-11-23",
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
    GITHUB_WORKFLOW_REF:
      "openclaw/clawsweeper/.github/workflows/pr-classification.yml@refs/heads/main",
    GITHUB_JOB: "classify",
    GITHUB_RUN_ID: String(process.pid),
    GITHUB_RUN_ATTEMPT: String(invocation),
    GITHUB_SHA: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  });
  const before = calls;
  const started = Date.now();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        pathToFileURL(preloadPath).href,
        "--input-type=module",
        "--eval",
        'import { prClassificationWorkflowMain } from "./dist/pr-classification-workflow.js"; await prClassificationWorkflowMain();',
      ],
      { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  traces.push({
    scenario: name,
    exit: result.code,
    modelCalls: calls - before,
    durationMs: Date.now() - started,
    result: result.stdout.trim(),
    writes: readState().writes,
  });
  return result;
}
try {
  saveState(source());
  const first = await run("maintainer-missing-priority");
  assert.equal(first.code, 0, first.stderr);
  assert.ok(readState().labels.some((label) => label.name === "P1"));
  assert.ok(readState().labels.some((label) => label.name === "impact:crash-loop"));
  assert.equal(readState().writes.filter((args) => args[0] === "issue").length, 1);
  assert.equal((await run("repeat-no-spend")).code, 0);
  assert.equal(traces.at(-1).modelCalls, 0);
  for (const scenario of ["refusal", "drift", "locked", "closed"]) {
    mode = scenario;
    const state = source();
    if (scenario === "locked") state.locked = true;
    if (scenario === "closed") state.state = "closed";
    saveState(state);
    const result = await run(scenario);
    assert.equal(result.code, scenario === "drift" ? 1 : 0, result.stderr);
    assert.equal(readState().writes.length, 0);
    if (["closed", "locked"].includes(scenario)) assert.equal(traces.at(-1).modelCalls, 0);
  }
  mkdirSync(resolve(output, ".."), { recursive: true });
  writeFileSync(
    output,
    JSON.stringify(
      {
        status: "passed",
        head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        platform: process.platform,
        architecture: process.arch,
        node: process.version,
        traces,
        limits: [
          "Controlled external Responses and executable gh fixture; no production GitHub mutation, model quality, cost or Actions deployment claim.",
          "Uses the real installed trusted scanner; full webhook ingress is exercised separately by focused integration tests.",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  console.log("Classification runtime proof passed: " + output);
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(scratch, { recursive: true, force: true });
}
