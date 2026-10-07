// Controlled real process/filesystem delivery proof; not a model-quality evaluation.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runAgentProcess } from "../../../dist/agent-runner.js";
import { AgentInputScanError } from "../../../dist/agent-input-scan.js";
import { reviewPromptForTest } from "../../../dist/clawsweeper.js";

const out = resolve(process.argv[2] ?? ".artifacts/astra-review/schema-delivery");
assert.ok(!existsSync(out), "Use a fresh output directory.");
mkdirSync(out, { recursive: true });
const target = join(out, "target");
mkdirSync(target);
const schemaPath = join(target, "decision.schema.json");
const schema = readFileSync("schema/clawsweeper-decision.schema.json");
writeFileSync(schemaPath, schema);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const item = {
  repo: "openclaw/review-fixture",
  number: 1,
  kind: "pull_request",
  title: "Review a local request service",
  url: "local:fixture",
  createdAt: "2026-10-07T20:00:00Z",
  updatedAt: "2026-10-07T20:00:00Z",
  author: "Review fixture",
  authorAssociation: "CONTRIBUTOR",
  labels: [],
};
const prompt = reviewPromptForTest(item, {}, { mainSha: "a".repeat(40), latestRelease: null }, "", {
  networkCapability: "unrestricted",
  hasGitHubToken: false,
});
const record = join(out, "delivered.txt");
const consumer = join(out, "delivery-consumer.cjs");
writeFileSync(
  consumer,
  [
    "#!" + process.execPath,
    "const fs=require('node:fs');",
    "const path=process.argv[process.argv.indexOf('--message-file')+1];",
    "fs.writeFileSync(" + JSON.stringify(record) + ",fs.readFileSync(path));",
    "process.stdout.write(JSON.stringify({payloads:[{text:JSON.stringify({received:true})}],meta:{stopReason:'stop'}}));",
  ].join("\n"),
  { mode: 0o755 },
);
const diagnostic = join(out, "diagnostic.md");
const options = {
  label: "schema-delivery-proof",
  prompt,
  scanSource: { kind: "prompt" },
  model: "not-used",
  cwd: target,
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CLAWSWEEPER_RUNNER: "openclaw",
    CLAWSWEEPER_OPENCLAW_MODEL: "openai/delivery-control",
    CLAWSWEEPER_OPENCLAW_BIN: consumer,
  },
  timeoutMs: 120000,
  diagnosticPromptPath: diagnostic,
  promptFileBytes: 4 * 1024 * 1024,
  codexExtraArgs: ["--output-schema", "decision.schema.json"],
};
const startedAt = new Date().toISOString();
const result = runAgentProcess(options);
assert.equal(result.status, 0, result.stderr);
assert.equal(result.error, undefined);
const delivered = readFileSync(record);
assert.equal(delivered.toString(), readFileSync(diagnostic, "utf8"));
assert.ok(delivered.toString().startsWith(prompt.trimEnd()));
const footer = Buffer.from("\n```\n");
assert.ok(delivered.subarray(-footer.length).equals(footer));
assert.ok(delivered.subarray(-schema.length - footer.length, -footer.length).equals(schema));
assert.ok(delivered.includes(Buffer.from('"changeSummary"')));
assert.ok(delivered.includes(Buffer.from('"architectureDiagram"')));
const receipt = {
  startedAt,
  finishedAt: new Date().toISOString(),
  head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  node: process.version,
  platform: process.platform,
  command: [process.execPath, ...process.argv.slice(1)],
  scanner:
    "Normal mandatory native TruffleHog admission; no scanner substitute or admission override",
  surface:
    "runAgentProcess -> runOpenclawProcess -> worker -> controlled CLI --message-file consumer",
  limits:
    "The controlled consumer is not the OpenClaw model. This proves delivery and filesystem/process integration only, not OpenClaw model quality or schema enforcement by a model.",
  auth: "No inference keys or workflow credentials supplied to the controlled consumer",
  input: {
    authoredPromptBytes: Buffer.byteLength(prompt.trimEnd()),
    schemaBytes: schema.length,
    deliveredMessageBytes: delivered.length,
    framingBytes: delivered.length - Buffer.byteLength(prompt.trimEnd()) - schema.length,
    deliveredSha256: sha256(delivered),
    schemaSha256: sha256(schema),
  },
  checks: [],
};
const absent = runAgentProcess({ ...options, codexExtraArgs: [] });
assert.equal(absent.status, 0);
assert.equal(readFileSync(record, "utf8"), prompt);
receipt.checks.push("schema absent: exact original message, no added header");
writeFileSync(record, "not-invoked");
assert.throws(
  () => runAgentProcess({ ...options, promptFileBytes: delivered.length - 1 }),
  /output budget/,
);
assert.equal(readFileSync(record, "utf8"), "not-invoked");
assert.equal(existsSync(diagnostic), false);
receipt.checks.push(
  "full delivered message counted against prompt-file quota before invocation/persistence",
);
writeFileSync(schemaPath, '{"broken":');
assert.throws(() => runAgentProcess(options), AgentInputScanError);
assert.equal(readFileSync(record, "utf8"), "not-invoked");
receipt.checks.push("malformed schema refused before consumer invocation");
receipt.sourceSha256 = Object.fromEntries(
  [
    "src/agent-runner.ts",
    "src/agent-input-scan.ts",
    "src/openclaw-process.ts",
    "src/clawsweeper-review-runtime.ts",
  ].map((path) => [path, sha256(readFileSync(path))]),
);
writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
console.log(
  JSON.stringify(
    {
      deliveredMessageBytes: delivered.length,
      authoredPromptBytes: Buffer.byteLength(prompt.trimEnd()),
      schemaBytes: schema.length,
      checks: receipt.checks,
    },
    null,
    2,
  ),
);
