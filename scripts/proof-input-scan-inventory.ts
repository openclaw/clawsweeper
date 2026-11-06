// Controlled runtime proof: synthetic scanner protocol, not a TruffleHog reproduction.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { runAgentProcess } from "../dist/agent-runner.js";
import { AgentInputScanError } from "../dist/agent-input-scan.js";
import { writeExactReviewFailureDiagnostics } from "../dist/clawsweeper-review-failure-diagnostics.js";
import { writeFakeScanner } from "../test/agent-input-scan-helpers.ts";
import { inspectInputScanDiagnostic } from "./inspect-input-scan-diagnostic.mjs";

if (process.platform === "win32") throw new Error("Controlled scanner protocol requires POSIX.");
const root = mkdtempSync(join(tmpdir(), "scan-inventory-proof-"));
const previousPath = process.env.PATH;
try {
  const cwd = join(root, "target");
  const bin = join(root, "bin");
  mkdirSync(cwd);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Diagnostic proof");
  git("config", "user.email", "proof@example.invalid");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(cwd, "a.txt"), "DIAGNOSTIC_CANARY_A\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const baseSha = git("rev-parse", "HEAD");
  writeFileSync(join(cwd, "a.txt"), "DIAGNOSTIC_CANARY_B\n");
  git("add", ".");
  git("commit", "-qm", "head");
  const headSha = git("rev-parse", "HEAD");
  const providerCalls = join(root, "provider-calls");
  const provider = join(root, "codex");
  writeFileSync(
    provider,
    `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(providerCalls)}, 'called');`,
    { mode: 0o755 },
  );
  writeFakeScanner(
    bin,
    String.raw`
for (const marker of ['DIAGNOSTIC_CANARY_A', 'DIAGNOSTIC_CANARY_B']) {
  const input = inputs.find(({ name, bytes }) => /^[a-f0-9]{40}$/.test(name) && bytes.toString() === marker + '\n');
  assert.ok(input);
  process.stdout.write(JSON.stringify({
    DetectorType: 0, DecoderName: 'PLAIN', Verified: false, Raw: marker, RawV2: marker,
    SourceMetadata: { Data: { Filesystem: { file: path.join(inputDir, input.name), line: 1 } } },
  }) + '\n');
}
process.stderr.write(JSON.stringify({ level: 'info-0', logger: 'trufflehog', msg: 'finished scanning', trufflehog_version: '3.99.4', chunks: 1, bytes: 1, verified_secrets: 0, unverified_secrets: 2 }) + '\n');
process.exit(183);
`,
  );
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
  let refusal: AgentInputScanError | undefined;
  try {
    runAgentProcess({
      label: "diagnostic-inventory-proof",
      prompt: "Review the change.",
      diagnosticPromptPath: join(root, "prompt.md"),
      scanSource: { kind: "committed", baseSha, headSha },
      model: "internal",
      cwd,
      env: { ...process.env, CODEX_BIN: provider },
      timeoutMs: 30_000,
    });
  } catch (error) {
    assert.ok(error instanceof AgentInputScanError);
    refusal = error;
  }
  assert.ok(refusal);
  assert.equal(refusal.reason, "findings");
  const output = writeExactReviewFailureDiagnostics({
    artifactDir: join(root, "artifacts"),
    error: refusal,
    prompt: "Review the change.",
    model: "internal",
    classification: "codex_execution",
    repo: "openclaw/clawsweeper",
    itemKind: "pull_request",
    itemNumber: 1,
    sourceSha: headSha,
    retryable: false,
    workflowExit: 79,
    // Synthetic provenance for the inspector protocol, not an actual Actions run.
    env: {
      GITHUB_REPOSITORY: "example/diagnostic-proof",
      GITHUB_RUN_ID: "1",
      GITHUB_RUN_ATTEMPT: "1",
    },
  });
  const manifestBytes = readFileSync(join(output, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestBytes);
  const scan = manifest.failure.scan;
  assert.equal(scan.findingIndex, 0);
  assert.equal(scan.findingCount, 2);
  assert.equal(existsSync(providerCalls), false);
  assert.equal(manifestBytes.includes("DIAGNOSTIC_CANARY"), false);
  assert.equal(manifestBytes.includes(root), false);
  // Reading the diagnostic twice is inert: it does not retry or start a provider.
  assert.equal(readFileSync(join(output, "manifest.json"), "utf8"), manifestBytes);
  assert.equal(existsSync(providerCalls), false);
  const inspect = () =>
    inspectInputScanDiagnostic({
      manifestPath: join(output, "manifest.json"),
      repository: "openclaw/clawsweeper",
      itemKind: "pull_request",
      itemNumber: 1,
      sourceSha: headSha,
      runRepository: "example/diagnostic-proof",
      runId: "1",
      runAttempt: "1",
    });
  assert.deepEqual(inspect(), inspect());
  assert.equal(
    inspect().diagnostic.failure.scan.inventory?.retainedCount,
    scan.inventory?.retainedCount,
  );
  assert.equal(existsSync(providerCalls), false);
  console.log(
    JSON.stringify(
      {
        proof: "synthetic-scanner-runtime-manifest",
        refusal: refusal.reason,
        firstFindingIndex: scan.findingIndex,
        findingCount: scan.findingCount,
        inventory: scan.inventory ?? null,
        providerCalls: 0,
        canaryOrPrivatePathInManifest: false,
        limitation:
          "Synthetic scanner protocol; no real detector, trust qualification, publication or deployment exercised.",
      },
      null,
      2,
    ),
  );
} finally {
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  rmSync(root, { recursive: true, force: true });
}
