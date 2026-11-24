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
import { readAllSpooledActionEvents } from "../dist/action-ledger.js";
import { CLASSIFICATION_RUBRIC } from "../dist/clawsweeper-policy.js";

const root = realpathSync(process.cwd());
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "classification-proof-")));
const statePath = join(scratch, "state.json");
const ghPath = join(scratch, "gh.cjs");
const preloadPath = join(scratch, "preload.mjs");
const output = resolve(process.argv[2] || ".artifacts/pr-classification-proof.json");
let calls = 0;
let mode = "classified";
let largeDiff;
let scenarioStart = 0;
const traces = [];
const source = () => ({
  number: 42,
  title: "Fix startup crash",
  body: "Startup crashes for all users after update.",
  state: "open",
  locked: false,
  updated_at: "2026-11-23T00:00:00Z",
  labels: [{ name: "maintainer" }, { name: "human-label" }],
  head: { sha: "a".repeat(40), repo: { full_name: "openclaw/openclaw" } },
  base: { sha: "c".repeat(40), repo: { full_name: "openclaw/openclaw" } },
  changed_files: 1,
  writes: [],
});
const readState = () => JSON.parse(readFileSync(statePath, "utf8"));
const saveState = (state) => writeFileSync(statePath, JSON.stringify(state));
writeFileSync(
  ghPath,
  'const fs = require("node:fs"); const assert = require("node:assert/strict");\n' +
    "const path = " +
    JSON.stringify(statePath) +
    '; const state = JSON.parse(fs.readFileSync(path, "utf8")); const raw = process.argv.slice(2).filter((arg, index, args) => arg !== "--method" && args[index - 1] !== "--method"); const scope = raw.indexOf("--repo"); if (scope >= 0) assert.equal(raw[scope + 1], "openclaw/openclaw"); const args = raw.filter((_, i) => scope < 0 || (i !== scope && i !== scope + 1));\n' +
    'if (args[0] === "api" && args[1] === "repos/openclaw/openclaw/pulls/42") console.log(JSON.stringify(state));\n' +
    'else if (args[0] === "api" && args[1].startsWith("repos/openclaw/openclaw/pulls/42/files?")) { const page = Number(args[1].match(/page=(\\d+)$/)[1]); state.filePages = [...(state.filePages ?? []), page]; fs.writeFileSync(path, JSON.stringify(state)); const first = {filename:"src/start.ts",status:"modified",additions:1,deletions:1,patch:"@@ -1 +1 @@\\n-crash();\\n+start();"}; const all = [first, ...Array.from({ length: state.changed_files - 1 }, (_, i) => ({ filename: "src/generated/file" + i + ".ts", status: "modified", additions: 60, deletions: 0, patch: "@@ -0,0 +1,60 @@\\n" + "+export const value = \\"generated\\";\\n".repeat(60) }))]; console.log(JSON.stringify(all.slice((page - 1) * 100, page * 100))); }\n' +
    'else if (args[0] === "api" && args[1].includes("/git/trees/")) console.log(JSON.stringify({truncated:false,tree:[{path:"src",type:"tree",mode:"040000",sha:"d".repeat(40)},{path:"start.ts",type:"blob",mode:"100644",sha:"e".repeat(40)}]}));\n' +
    'else if (args[0] === "api" && args[1].startsWith("repos/openclaw/openclaw/contents/src/start.ts?")) console.log(JSON.stringify({type:"file",encoding:"base64",size:9,content:Buffer.from("start();\\n").toString("base64")}));\n' +
    'else if (args[0] === "api" && args[1].startsWith("repos/openclaw/openclaw/labels?")) console.log("[[]]");\n' +
    'else { assert.ok(scope >= 0); state.writes.push(args); if (state.failMutation) { fs.writeFileSync(path, JSON.stringify(state)); process.stderr.write("private-mutation-detail"); process.exit(1); } if (args[0] === "issue" && args[1] === "edit") { for (let i=0;i<args.length;i++) if (args[i] === "--add-label") for (const name of args[++i].split(",")) state.labels.push({ name }); state.updated_at = "2026-11-23T00:00:01Z"; } else assert.equal(args[0], "label"); fs.writeFileSync(path, JSON.stringify(state)); }\n',
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
      assert.ok(payload.instructions.includes(CLASSIFICATION_RUBRIC));
      assert.equal(payload.tools.length, 2);
      assert.equal(payload.max_output_tokens, 1536);
      const packet = JSON.parse(payload.input[0].content);
      assert.ok(packet.diff.includes("crash();"));
      assert.ok(Buffer.byteLength(payload.input[0].content) <= 180_000);
      if (mode === "large-diff") {
        const diff = JSON.parse(packet.diff);
        assert.equal(diff.truncated, true);
        assert.equal(diff.changed_files, 123);
        assert.ok(diff.included_files < 123 && diff.files.at(-1).patch_truncated);
        largeDiff = {
          changed: diff.changed_files,
          included: diff.included_files,
          packetBytes: Buffer.byteLength(payload.input[0].content),
        };
      }
      assert.equal(packet.headSha, readState().head.sha);
      if (payload.tool_choice === "required") {
        if (mode === "attempt-guard") {
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
                type: "function_call",
                call_id: "context_1",
                name: "read_file",
                arguments: JSON.stringify({
                  path: "src/start.ts",
                  revision: "head",
                  start_line: 1,
                }),
              },
            ],
            usage: { input_tokens: 250, output_tokens: 30 },
          }),
        );
        return;
      }
      if (mode === "provider-http" || (mode === "provider-once" && calls - scenarioStart === 2)) {
        response.writeHead(429);
        response.end();
        return;
      }
      assert.equal(payload.input.at(-1).type, "function_call_output");
      assert.ok(payload.input.at(-1).output.includes("start();"));
      if (
        mode === "drift" ||
        (["edit-once", "priority-before-retry"].includes(mode) &&
          !readState().body.endsWith(" edited"))
      ) {
        const state = readState();
        state.body += " edited";
        if (mode === "priority-before-retry") state.labels.push({ name: "P2" });
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
                        text: JSON.stringify({
                          priority: "P1",
                          impact: [
                            mode === "contradictory-labels"
                              ? "impact:ux-release-blocker"
                              : "impact:crash-loop",
                          ],
                        }),
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
    CLAWSWEEPER_CLASSIFICATION_MODEL: "gpt-6-luna",
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
  scenarioStart = calls;
  const previousEvents = new Set(
    readAllSpooledActionEvents(root).map((event) => JSON.stringify(event)),
  );
  const started = Date.now();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", pathToFileURL(preloadPath).href, "dist/pr-classification-workflow.js"],
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
  const receipts = readAllSpooledActionEvents(root).filter(
    (event) => !previousEvents.has(JSON.stringify(event)),
  );
  if (["provider-http", "attempt-guard"].includes(name)) {
    const paid = receipts.filter((event) => event.attributes?.input_tokens === 250);
    assert.equal(paid.length, name === "provider-http" ? 2 : 1);
    assert.ok(paid.every((event) => event.attributes.output_tokens === 30));
  }
  if (name === "large-diff") {
    assert.ok(calls - before >= 2);
    assert.ok(!receipts.some((e) => e.attributes.status_kind === "source-limit"));
    assert.deepEqual(readState().filePages, [1]);
  }
  traces.push({
    scenario: name,
    exit: result.code,
    modelCalls: calls - before,
    durationMs: Date.now() - started,
    result: result.stdout.trim(),
    attempts: [
      ...new Set(
        receipts
          .filter((e) => e.attributes.work_kind === "pr-classification")
          .map((e) => e.attributes.attempt),
      ),
    ].sort(),
    diagnostics: receipts.filter((e) => e.attributes.status_kind).map((e) => e.attributes),
    accounting: receipts
      .filter((event) => event.attributes?.input_tokens)
      .map((event) => event.attributes),
    writes: readState().writes,
    ...(name === "large-diff" ? { largeDiff, filePages: readState().filePages } : {}),
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
  for (const scenario of [
    "refusal",
    "contradictory-labels",
    "drift",
    "locked",
    "closed",
    "provider-http",
    "attempt-guard",
    "edit-once",
    "provider-once",
    "priority-before-retry",
    "large-diff",
    "uncertain-mutation",
  ]) {
    mode = scenario;
    const state = source();
    if (scenario === "locked") state.locked = true;
    if (scenario === "closed") state.state = "closed";
    if (scenario === "large-diff") state.changed_files = 123;
    if (scenario === "uncertain-mutation") state.failMutation = true;
    saveState(state);
    const result = await run(scenario);
    assert.equal(
      result.code,
      ["drift", "provider-http", "uncertain-mutation"].includes(scenario) ? 1 : 0,
      result.stderr,
    );
    if (["edit-once", "provider-once", "attempt-guard"].includes(scenario)) {
      assert.equal(readState().writes.filter((args) => args[0] === "issue").length, 1);
      assert.deepEqual(traces.at(-1).attempts, [1, 2]);
    } else if (scenario === "large-diff") {
      assert.equal(readState().writes.filter((args) => args[0] === "issue").length, 1);
      assert.ok(readState().labels.some((label) => label.name === "P1"));
      assert.deepEqual(traces.at(-1).attempts, [1]);
    } else if (scenario === "uncertain-mutation") {
      assert.equal(readState().writes.length, 1);
      assert.equal(traces.at(-1).modelCalls, 2);
      assert.deepEqual(traces.at(-1).attempts, [1]);
      assert.doesNotMatch(result.stderr, /private-mutation-detail/);
    } else assert.equal(readState().writes.length, 0);
    if (scenario === "drift") {
      assert.equal(traces.at(-1).modelCalls, 4);
      assert.deepEqual(traces.at(-1).attempts, [1, 2]);
    }
    if (scenario === "priority-before-retry") assert.equal(traces.at(-1).modelCalls, 2);
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
