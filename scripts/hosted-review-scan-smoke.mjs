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
import { runCodexForTest } from "../dist/clawsweeper.js";
import {
  assertBooleanCountArtifact,
  assertMatchesJsonSchema,
  runWithWithheldDiagnostics,
  summarizeHostedReviewTrace,
} from "./hosted-review-canary-proof.mjs";

// Dispatch-only proof: no GitHub credentials, publications, or external target repository.
assert.equal(process.platform, "linux");
assert.equal(process.env.CLAWSWEEPER_RUNNER?.trim() || "codex", "codex");
const originalPath = process.env.PATH;
const originalScannerCache = process.env.CLAWSWEEPER_REVIEW_TOOLS_DIR;
const originalCodexBin = process.env.CODEX_BIN;
const artifact = process.argv[2];
assert.ok(artifact, "pass a proof JSON destination");
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
  writeFileSync(join(cwd, "review-fixture.js"), 'export const canaryValue = "before";\n');
  git("add", ".");
  git("commit", "-qm", "base");
  const baseSha = git("rev-parse", "HEAD");
  const marker = randomUUID();
  const changedFixture = [
    'export const canaryValue = "after";',
    `export const canaryMarker = "${marker}";`,
    "",
  ].join("\n");
  writeFileSync(join(cwd, "review-fixture.js"), changedFixture);
  git("add", ".");
  git("commit", "-qm", "change");
  const headSha = git("rev-parse", "HEAD");
  const calls = join(root, "codex-launches");
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
  const itemNumber = 990_001;
  const workDir = join(root, "review-work");
  mkdirSync(workDir);
  const output = join(workDir, `${itemNumber}.json`);
  const diagnosticPromptPath = join(root, "review.prompt.md");
  const reviewCommand = `git diff --no-ext-diff --unified=0 ${baseSha} ${headSha} -- review-fixture.js`;
  const prompt = [
    "This is a hosted ClawSweeper transport canary over a synthetic pull request.",
    "First use the shell tool to inspect review-fixture.js in the committed diff.",
    `Run: ${reviewCommand}`,
    "Do not use any other tool or network access.",
    "Read the UUID from that command output, then return one valid ClawSweeper decision using the required schema.",
    'Use decision "keep_open", closeReason "none", no findings, no risks, no required next step, and overallCorrectness "patch is correct".',
    'Set summary exactly to "Hosted review canary observed marker <UUID>.", replacing <UUID> with the command result.',
    "Use one low-confidence synthetic owner with history null. This fixture is not real maintainer work.",
  ].join("\n");
  const scratch = () =>
    readdirSync(tmpdir())
      .filter((name) => name.startsWith("clawsweeper-input-scan-"))
      .sort();
  const initialScratch = scratch();
  const assertCheckout = () => {
    assert.ok(git("rev-parse", "HEAD") === headSha, "synthetic checkout head changed");
    assert.ok(git("status", "--porcelain") === "", "synthetic checkout became dirty");
    assert.ok(
      readFileSync(join(cwd, "review-fixture.js"), "utf8") === changedFixture,
      "synthetic checkout bytes changed",
    );
    assert.ok(
      JSON.stringify(scratch()) === JSON.stringify(initialScratch),
      "scanner scratch files were retained",
    );
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
  process.env.CODEX_BIN = wrapper;
  const decision = runWithWithheldDiagnostics(
    "Hosted production review failed; diagnostics withheld.",
    () =>
      runCodexForTest({
        item: {
          repo: "openclaw/clawsweeper",
          number: itemNumber,
          kind: "pull_request",
          title: "Synthetic hosted review canary",
          url: "https://github.com/openclaw/clawsweeper",
          createdAt: "2026-09-04T00:00:00Z",
          updatedAt: "2026-09-04T00:00:00Z",
          author: "clawsweeper-canary",
          authorAssociation: "NONE",
          labels: [],
        },
        context: {
          issue: {},
          comments: [],
          timeline: [],
          pullRequest: { base: { sha: baseSha }, head: { sha: headSha } },
        },
        git: { mainSha: baseSha, latestRelease: null },
        model: "internal",
        openclawDir: cwd,
        reasoningEffort: "medium",
        sandboxMode: "read-only",
        serviceTier: "",
        preserveCodexAuth: true,
        timeoutMs: 300_000,
        workDir,
        prompt,
        quietLogs: true,
        extraCodexConfig: ['web_search="disabled"'],
      }),
  );
  assert.ok(decision.localCheckoutAccess === "verified", "checkout verification failed");
  assert.ok(
    decision.summary === `Hosted review canary observed marker ${marker}.`,
    "Hosted review decision did not match the fixture; diagnostics withheld.",
  );
  runWithWithheldDiagnostics(
    "Hosted review output did not match the decision schema; diagnostics withheld.",
    () =>
      assertMatchesJsonSchema(
        JSON.parse(readFileSync(output, "utf8")),
        JSON.parse(
          readFileSync(join(process.cwd(), "schema", "clawsweeper-decision.schema.json"), "utf8"),
        ),
      ),
  );
  assertCheckout();
  assert.equal(readFileSync(calls, "utf8").length, 2);
  const productionPromptPath = join(workDir, `${itemNumber}.prompt.md`);
  assert.ok(
    readFileSync(productionPromptPath, "utf8") === prompt,
    "Admitted prompt diagnostic did not match; contents withheld.",
  );
  const diagnosticPromptMode = statSync(productionPromptPath).mode & 0o777;
  assert.equal(diagnosticPromptMode, 0o600);
  const trace = runWithWithheldDiagnostics(
    "Hosted review trace did not prove the tool round; diagnostics withheld.",
    () =>
      summarizeHostedReviewTrace({
        jsonl: readFileSync(join(workDir, `${itemNumber}.1.codex.stdout.log`), "utf8"),
        marker,
        expectedCommand: reviewCommand,
        finalDecisionText: readFileSync(output, "utf8"),
        checkoutUnchanged: true,
      }),
  );
  const proof = {
    refusalScenarioCount: 4,
    refusalCodexLaunchCount: 0,
    reviewCodexLaunchCount: 2,
    productionReviewPath: true,
    syntheticCommittedDiffScenarioCount: 1,
    externalRepositoryCovered: false,
    reviewPublicationCovered: false,
    queueLifecycleCovered: false,
    decisionSchemaValid: true,
    admissionArtifactOwnerOnly: diagnosticPromptMode === 0o600,
    ...trace,
  };
  assertBooleanCountArtifact(proof);
  writeFileSync(artifact, JSON.stringify(proof, null, 2) + "\n", { mode: 0o600 });
} finally {
  process.env.PATH = originalPath;
  if (originalCodexBin === undefined) delete process.env.CODEX_BIN;
  else process.env.CODEX_BIN = originalCodexBin;
  if (originalScannerCache === undefined) delete process.env.CLAWSWEEPER_REVIEW_TOOLS_DIR;
  else process.env.CLAWSWEEPER_REVIEW_TOOLS_DIR = originalScannerCache;
  rmSync(root, { recursive: true, force: true });
}
