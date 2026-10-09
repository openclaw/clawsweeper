import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test, { type TestContext } from "node:test";
import { runAgentProcess, type RunAgentProcessOptions } from "../dist/agent-runner.js";
import { AgentInputScanError, MAX_SCAN_BYTES } from "../dist/agent-input-scan.js";
import { useFakeScanner } from "./agent-input-scan-helpers.ts";
import { TRUFFLEHOG_VERSION } from "../dist/review-tool-bootstrap.js";
import { OPENCLAW_MESSAGE_FILE_MAX_BYTES, runOpenclawProcess } from "../dist/openclaw-process.js";

const header =
  "\n\n## Output schema\n\nReturn one JSON object that matches this JSON Schema. The field descriptions are part of the review contract.\n\n```json\n";
const footer = "\n```\n";
const schema =
  '{"type":"object","properties":{"answer":{"type":"string","description":"Return the observed answer"}},"required":["answer"],"additionalProperties":false}\r\n';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-schema-delivery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const record = join(root, "delivered.txt");
  const diagnostic = join(root, "diagnostic.md");
  const output = join(root, "answer.json");
  const schemaPath = join(root, "schema.json");
  const binary = join(root, "consumer.cjs");
  writeFileSync(schemaPath, schema);
  writeFileSync(
    binary,
    [
      "#!" + process.execPath,
      "const fs = require('node:fs');",
      "const path = process.argv[process.argv.indexOf('--message-file')+1];",
      "fs.writeFileSync(" + JSON.stringify(record) + ",fs.readFileSync(path));",
      "process.stdout.write(JSON.stringify({payloads:[{text:JSON.stringify({answer:'observed'})}],meta:{stopReason:'stop'}}));",
    ].join("\n"),
    { mode: 0o755 },
  );
  const options: RunAgentProcessOptions = {
    label: "schema-delivery",
    prompt: "Review this source.\r\n🦞",
    scanSource: { kind: "prompt" },
    diagnosticPromptPath: diagnostic,
    model: "unused-on-this-runner",
    cwd: root,
    env: {
      ...process.env,
      CLAWSWEEPER_RUNNER: "openclaw",
      CLAWSWEEPER_OPENCLAW_MODEL: "openai/public-test-model",
      CLAWSWEEPER_OPENCLAW_BIN: binary,
    },
    timeoutMs: 10000,
    codexExtraArgs: ["--output-schema", schemaPath, "--output-last-message", output],
    outputLastMessageBytes: 4096,
  };
  return { root, record, diagnostic, output, schemaPath, options };
}

for (const pathMode of ["absolute", "relative", "absent"] as const) {
  test("OpenClaw message-file receives admitted " + pathMode + " schema input", (t) => {
    const f = fixture(t);
    const expected = f.options.prompt + (pathMode === "absent" ? "" : header + schema + footer);
    const schemaArgument = pathMode === "relative" ? relative(f.root, f.schemaPath) : f.schemaPath;
    f.options.codexExtraArgs = [
      ...(pathMode === "absent" ? [] : ["--output-schema", schemaArgument]),
      "--output-last-message",
      f.output,
    ];
    f.options.promptFileBytes = Buffer.byteLength(expected);
    useFakeScanner(
      t,
      [
        "assert.equal(fs.existsSync(" + JSON.stringify(f.record) + "),false);",
        "assert.equal(fs.existsSync(" + JSON.stringify(f.diagnostic) + "),false);",
        "assert.equal(inputs.find(x=>x.name==='prompt').bytes.toString()," +
          JSON.stringify(expected) +
          ");",
        pathMode === "absent"
          ? "assert.equal(inputs.some(x=>x.name==='schema'),false);"
          : "assert.equal(inputs.find(x=>x.name==='schema').bytes.toString()," +
            JSON.stringify(schema) +
            ");",
      ].join("\n"),
    );
    const result = runAgentProcess(f.options);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.error, undefined);
    assert.equal(readFileSync(f.record, "utf8"), expected);
    assert.equal(readFileSync(f.diagnostic, "utf8"), expected);
    assert.deepEqual(JSON.parse(readFileSync(f.output, "utf8")), { answer: "observed" });
  });
}

test("OpenClaw delivers the captured schema even if the original changes during scanning", (t) => {
  const f = fixture(t);
  useFakeScanner(
    t,
    "fs.writeFileSync(" + JSON.stringify(f.schemaPath) + ",'changed after capture');",
  );
  assert.equal(runAgentProcess(f.options).status, 0);
  assert.equal(readFileSync(f.record, "utf8"), f.options.prompt + header + schema + footer);
});

for (const where of ["prompt", "schema"] as const) {
  test("OpenClaw input finding in " + where + " refuses before invocation or diagnostics", (t) => {
    const f = fixture(t);
    writeFileSync(f.diagnostic, "stale");
    writeFileSync(f.output, "stale");
    useFakeScanner(
      t,
      "assert.ok(inputs.some(x=>x.name===" +
        JSON.stringify(where) +
        ")); console.log(JSON.stringify({Raw: 'synthetic-sensitive-value'})); process.stderr.write(JSON.stringify({level:'info-0',logger:'trufflehog',msg:'finished scanning',trufflehog_version:" +
        JSON.stringify(TRUFFLEHOG_VERSION) +
        ",chunks:1,bytes:1,verified_secrets:0,unverified_secrets:1})+String.fromCharCode(10)); process.exit(183);",
    );
    assert.throws(
      () => runAgentProcess(f.options),
      (error: unknown) => error instanceof AgentInputScanError && error.reason === "findings",
    );
    for (const path of [f.record, f.diagnostic, f.output]) assert.equal(existsSync(path), false);
  });
}

for (const kind of [
  "missing",
  "invalid-json",
  "invalid-root",
  "invalid-utf8",
  "oversized",
  "directory",
  "missing-argument",
] as const) {
  test("OpenClaw refuses " + kind + " schema without starting the consumer", (t) => {
    const f = fixture(t);
    useFakeScanner(t);
    if (kind === "missing") rmSync(f.schemaPath);
    if (kind === "invalid-json") writeFileSync(f.schemaPath, '{"private":"not complete');
    if (kind === "invalid-root") writeFileSync(f.schemaPath, "[]");
    if (kind === "invalid-utf8") writeFileSync(f.schemaPath, Buffer.from([0xff]));
    if (kind === "oversized") truncateSync(f.schemaPath, MAX_SCAN_BYTES);
    if (kind === "directory")
      f.options.codexExtraArgs = ["--output-last-message", f.output, "--output-schema", f.root];
    if (kind === "missing-argument")
      f.options.codexExtraArgs = ["--output-last-message", f.output, "--output-schema"];
    assert.throws(() => runAgentProcess(f.options), AgentInputScanError);
    assert.equal(existsSync(f.record), false);
    assert.equal(existsSync(f.diagnostic), false);
  });
}

test(
  "OpenClaw refuses a FIFO schema without blocking",
  { skip: process.platform === "win32" },
  (t) => {
    const f = fixture(t);
    rmSync(f.schemaPath);
    execFileSync("mkfifo", [f.schemaPath]);
    assert.throws(() => runAgentProcess(f.options), AgentInputScanError);
    assert.equal(existsSync(f.record), false);
  },
);

test("complete inline schema counts against the diagnostic prompt quota", (t) => {
  const f = fixture(t);
  useFakeScanner(t, "assert.fail('oversized message must fail before scanner invocation');");
  f.options.promptFileBytes = Buffer.byteLength(f.options.prompt + header + schema + footer) - 1;
  assert.throws(() => runAgentProcess(f.options), /prompt exceeded its .* output budget/);
  assert.equal(existsSync(f.record), false);
  assert.equal(existsSync(f.diagnostic), false);
});

test("admission deadline includes schema preparation and scanner time", (t) => {
  const f = fixture(t);
  useFakeScanner(t, "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000);");
  f.options.timeoutMs = 300;
  assert.throws(() => runAgentProcess(f.options), AgentInputScanError);
  assert.equal(existsSync(f.record), false);
  assert.equal(existsSync(f.diagnostic), false);
});

test("OpenClaw complete message respects the CLI input limit even without a schema flag", (t) => {
  const f = fixture(t);
  f.options.prompt = "x".repeat(OPENCLAW_MESSAGE_FILE_MAX_BYTES + 1);
  f.options.codexExtraArgs = [];
  delete f.options.outputLastMessageBytes;
  assert.throws(
    () => runAgentProcess(f.options),
    (error: unknown) => error instanceof AgentInputScanError && error.reason === "staging_limit",
  );
  const direct = runOpenclawProcess({
    label: "direct-limit",
    prompt: f.options.prompt,
    model: "openai/public-test-model",
    cwd: f.root,
    env: f.options.env,
    timeoutMs: 1000,
  });
  assert.match(direct.error?.message ?? "", /4 MiB input limit/);
  assert.equal(existsSync(f.record), false);
});
