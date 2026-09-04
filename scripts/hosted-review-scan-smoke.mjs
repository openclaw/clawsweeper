import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentProcess } from "../dist/agent-runner.js";
import { codexEnv } from "../dist/codex-env.js";
import { AgentInputScanError } from "../dist/agent-input-scan.js";

// Dispatch-only proof: no GitHub credentials, publications, or target repository.
assert.equal(process.platform, "linux");
const originalPath = process.env.PATH;
const originalScannerCache = process.env.CLAWSWEEPER_REVIEW_TOOLS_DIR;
const artifact = process.argv[2];
assert.ok(artifact, "pass a proof JSON destination");
const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const gitExecutable = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const codex = execFileSync("which", ["codex"], { encoding: "utf8" }).trim();
const versionProbe = spawnSync("trufflehog", ["--version"], { encoding: "utf8" });
assert.equal(versionProbe.status, 0, "scanner version probe failed");
const scannerVersion = `${versionProbe.stdout}${versionProbe.stderr}`.trim();
assert.equal(scannerVersion, "trufflehog 3.97.1");
const root = mkdtempSync(join(tmpdir(), "clawsweeper-hosted-scan-"));
try {
  const cwd = join(root, "target");
  const bin = join(root, "bin");
  mkdirSync(cwd);
  mkdirSync(bin);
  const git = (...args) => execFileSync(gitExecutable, args, { cwd, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "ClawSweeper smoke");
  git("config", "user.email", "smoke@example.invalid");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(cwd, "value.txt"), "one\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const baseSha = git("rev-parse", "HEAD");
  const marker = randomUUID();
  writeFileSync(join(cwd, "value.txt"), `two ${marker}\n`);
  git("add", ".");
  git("commit", "-qm", "change");
  const headSha = git("rev-parse", "HEAD");
  const calls = join(root, "provider-starts");
  const wrapper = join(bin, "codex");
  // Negative cases can only hit this no-inference executable, even if the
  // admission gate regresses. Real Codex is wired only after these assertions.
  const writeProvider = (live) =>
    writeFileSync(
      wrapper,
      `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(calls)}, '1');
${live ? `const child = require('node:child_process').spawnSync(${JSON.stringify(codex)}, process.argv.slice(2), {stdio:'inherit', env:process.env}); process.exit(child.status ?? 1);` : "process.exit(86);"}
`,
      { mode: 0o700 },
    );
  writeProvider(false);
  const schemaPath = join(root, "schema.json");
  writeFileSync(
    schemaPath,
    JSON.stringify({
      type: "object",
      additionalProperties: false,
      required: ["status", "marker"],
      properties: { status: { type: "string", enum: ["clean"] }, marker: { type: "string" } },
    }),
    { mode: 0o600 },
  );
  const output = join(root, "decision.json");
  const diagnosticPromptPath = join(root, "review.prompt.md");
  const prompt =
    "Review the synthetic change in value.txt. Read that file and return its UUID as marker with status clean in the required JSON object. Do not run nested reviewers or network tools.";
  const run = () =>
    runAgentProcess({
      label: "hosted-scan-smoke",
      cwd,
      model: "internal",
      reasoningEffort: "low",
      prompt,
      diagnosticPromptPath,
      scanSource: { kind: "committed", baseSha, headSha },
      timeoutMs: 180_000,
      env: { ...codexEnv(), CODEX_BIN: wrapper },
      codexExtraArgs: [
        "--sandbox",
        "read-only",
        "-c",
        'approval_policy="never"',
        "-c",
        'web_search="disabled"',
        "--output-schema",
        schemaPath,
        "--output-last-message",
        output,
        "--json",
        "-",
      ],
    });
  const scratch = () =>
    readdirSync(tmpdir())
      .filter((name) => name.startsWith("clawsweeper-input-scan-"))
      .sort();
  const initialScratch = scratch();
  const assertCheckout = () => {
    assert.equal(git("rev-parse", "HEAD"), headSha);
    assert.equal(git("status", "--porcelain"), "");
    assert.equal(readFileSync(join(cwd, "value.txt"), "utf8"), `two ${marker}\n`);
    assert.deepEqual(scratch(), initialScratch);
  };
  // A missing PATH scanner can now bootstrap automatically. Make that second
  // source unavailable only for the synthetic refusal cases, before any download.
  process.env.CLAWSWEEPER_REVIEW_TOOLS_DIR = "relative-unavailable-scanner-cache";
  for (const scenario of ["missing", "failure", "findings", "unexpected-output"]) {
    process.env.PATH = bin;
    if (scenario !== "missing")
      writeFileSync(
        join(bin, "trufflehog"),
        `#!${process.execPath}\n${scenario === "unexpected-output" ? "process.stdout.write('{}');" : `process.exit(${scenario === "findings" ? 183 : 1});`}`,
        { mode: 0o700 },
      );
    // Prompt-only negatives reach the executable boundary without requiring Git
    // on the deliberately scanner-free PATH. No negative ever has live inference.
    writeFileSync(output, '{"status":"clean"}');
    writeFileSync(diagnosticPromptPath, "Stale synthetic rejected input.", { mode: 0o644 });
    assert.throws(
      () =>
        runAgentProcess({
          label: "hosted-scan-refusal",
          cwd,
          model: "internal",
          prompt: "Harmless refusal fixture.",
          diagnosticPromptPath,
          scanSource: { kind: "prompt" },
          timeoutMs: 30_000,
          env: { ...codexEnv(), CODEX_BIN: wrapper },
          codexExtraArgs: ["--output-last-message", output, "-"],
        }),
      AgentInputScanError,
    );
    assert.equal(existsSync(calls), false);
    assert.equal(existsSync(output), false);
    assert.equal(existsSync(diagnosticPromptPath), false);
    assertCheckout();
  }
  process.env.PATH = originalPath;
  if (originalScannerCache === undefined) delete process.env.CLAWSWEEPER_REVIEW_TOOLS_DIR;
  else process.env.CLAWSWEEPER_REVIEW_TOOLS_DIR = originalScannerCache;
  writeProvider(true);
  const result = run();
  // Raw model output/diagnostics and configured model identity never enter proof artifacts.
  assert.ok(!result.error, "native runner failed");
  assert.equal(result.status, 0, "native runner exited unsuccessfully");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(output, "utf8"));
  } catch {
    throw new Error("Native review did not produce valid JSON; diagnostics withheld.");
  }
  assert.ok(
    parsed?.status === "clean" && parsed.marker === marker && Object.keys(parsed).length === 2,
    "Native structured response did not match the fixture; diagnostics withheld.",
  );
  const decision = { status: "clean", marker };
  assertCheckout();
  assert.equal(readFileSync(calls, "utf8"), "1");
  assert.ok(
    readFileSync(diagnosticPromptPath, "utf8") === prompt,
    "Admitted prompt diagnostic did not match; contents withheld.",
  );
  const diagnosticPromptMode = statSync(diagnosticPromptPath).mode & 0o777;
  assert.equal(diagnosticPromptMode, 0o600);
  writeFileSync(
    artifact,
    JSON.stringify(
      {
        sourceHead,
        provider: "github-hosted",
        imageOS: process.env.ImageOS,
        imageVersion: process.env.ImageVersion,
        runId: process.env.GITHUB_RUN_ID,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT,
        scannerVersion,
        codexVersion: execFileSync(codex, ["--version"], { encoding: "utf8" }).trim(),
        baseSha,
        headSha,
        refusalProviderStarts: 0,
        cleanProviderStarts: 1,
        refusalPromptArtifacts: 0,
        diagnosticPromptMode: `0${diagnosticPromptMode.toString(8)}`,
        decision,
        model: "configured model (redacted)",
        limits:
          "Explicit initial prompt, schema and introduced before/after bytes. No universal provider-egress, project-doc, resumed-history or later tool-result coverage.",
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
} finally {
  process.env.PATH = originalPath;
  if (originalScannerCache === undefined) delete process.env.CLAWSWEEPER_REVIEW_TOOLS_DIR;
  else process.env.CLAWSWEEPER_REVIEW_TOOLS_DIR = originalScannerCache;
  rmSync(root, { recursive: true, force: true });
}
