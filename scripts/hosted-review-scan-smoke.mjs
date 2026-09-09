import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
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
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runAgentProcess } from "../dist/agent-runner.js";
import { codexEnv } from "../dist/codex-env.js";
import { AgentInputScanError } from "../dist/agent-input-scan.js";
import { runCodexForTest } from "../dist/clawsweeper.js";
import { sanitizedLiveProofEnvironment } from "../dist/live-proof/environment.js";
import { parseLiveVerificationResult } from "../dist/live-proof/verification.js";
import { TRANSIENT_REVIEW_RESULT_MAX_BYTES } from "../dist/review-output-policy.js";
import {
  assertBooleanCountArtifact,
  assertHostedBlobStarts,
  assertHostedMultilineRequest,
  assertHostedNativeQuiescent,
  assertHostedProcessGroupGone,
  assertHostedTerminalQuiescent,
  assertMatchesJsonSchema,
  HOSTED_MULTILINE_PROVIDER_ERROR,
  hostedBlobPreloadSource,
  hostedProcessIdentity,
  hostedTerminalObserverSource,
  readHostedLifecycle,
  readHostedReviewRollout,
  runWithWithheldDiagnostics,
  snapshotHostedReviewRollouts,
  stopHostedNativeGroup,
  stopHostedTerminal,
  summarizeHostedReviewTrace,
  withHostedFixtureSignals,
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
let fixtureQuiescent = true;
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
  const multilineProof = await proveNativeMultilineFailure({ root, cwd, headSha, codex });
  assertCheckout();
  let blobProof;
  try {
    blobProof = await proveMissingBlobChild({ root, cwd, baseSha, headSha, itemNumber, marker });
  } catch {
    throw new Error("Hosted missing-blob proof failed; diagnostics withheld.");
  }
  assertCheckout();
  writeProvider(true);
  process.env.CODEX_BIN = wrapper;
  const initialRollouts = runWithWithheldDiagnostics(
    "Hosted review rollout inventory failed; diagnostics withheld.",
    () => snapshotHostedReviewRollouts(process.env.CODEX_HOME),
  );
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
        resultFileBytes: TRANSIENT_REVIEW_RESULT_MAX_BYTES,
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
        rollout: readHostedReviewRollout(process.env.CODEX_HOME, initialRollouts),
        cwd,
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
    ...multilineProof,
    ...blobProof,
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
  if (fixtureQuiescent) rmSync(root, { recursive: true, force: true });
  else process.stderr.write("Hosted fixture retained: descendant cleanup was not proven.\n");
}

async function proveNativeMultilineFailure({ root, cwd, headSha, codex }) {
  const home = join(root, "multiline-home");
  const workDir = join(root, "multiline-work");
  mkdirSync(home, { mode: 0o700 });
  const maxCaptureBytes = 256 * 1024;
  let requests = 0;
  let failed = false;
  let child;
  let childClosed;
  let timer;
  let closed = false;
  let resolveAbort;
  const aborted = new Promise((resolve) => {
    resolveAbort = resolve;
  });
  const nonce = randomUUID();
  const launches = join(root, "multiline-starts.jsonl");
  const launcher = join(root, "multiline-codex");
  const helperUrl = new URL("./hosted-review-canary-proof.mjs", import.meta.url).href;
  const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'";
  const receipt = `
import { hostedProcessIdentity, recordHostedLifecycle } from ${JSON.stringify(helperUrl)};
const identity = hostedProcessIdentity(process.ppid);
if (!identity || identity.pid !== identity.pgid) process.exit(125);
recordHostedLifecycle(${JSON.stringify(launches)}, {
  kind: "native", fixtureNonce: ${JSON.stringify(nonce)}, identity,
});
`;
  writeFileSync(
    launcher,
    `#!/bin/bash\n${quote(process.execPath)} --input-type=module --eval ${quote(receipt)} || exit 125\nexec ${quote(codex)} "$@"\n`,
    { mode: 0o700 },
  );
  const refuse = () => {
    failed = true;
    resolveAbort();
  };
  return withHostedFixtureSignals(refuse, async () => {
    const server = createServer(async (request, response) => {
      try {
        await assertHostedMultilineRequest(request, ++requests);
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `event: response.failed\ndata: ${JSON.stringify({
            type: "response.failed",
            response: {
              id: "hosted_multiline_failure",
              error: { code: "rate_limit_exceeded", message: HOSTED_MULTILINE_PROVIDER_ERROR },
            },
          })}\n\n`,
        );
      } catch {
        refuse();
        response.destroy();
      }
    });
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      assert.equal(failed, false, "Hosted fixture cancelled before native launch.");
      writeFileSync(
        join(home, "config.toml"),
        `model_provider = "fixture"
[model_providers.fixture]
name = "Controlled loopback fixture"
base_url = "http://127.0.0.1:${server.address().port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
stream_idle_timeout_ms = 10000
`,
        { mode: 0o600 },
      );
      // Inspection reads process.env, so isolate the process itself, not only reviewEnv.
      const env = {
        PATH: originalPath,
        CODEX_BIN: launcher,
        HOME: home,
        CODEX_HOME: home,
        SHELL: "/bin/bash",
        LANG: "C",
        LC_ALL: "C",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      };
      const options = {
        item: {
          repo: "fixture/review",
          number: 990_002,
          kind: "issue",
          title: "Synthetic provider failure",
          url: "https://github.com/openclaw/clawsweeper",
          createdAt: "2026-09-04T00:00:00Z",
          updatedAt: "2026-09-04T00:00:00Z",
          author: "clawsweeper-canary",
          authorAssociation: "NONE",
          labels: [],
        },
        context: { issue: {}, comments: [], timeline: [] },
        git: { mainSha: headSha, latestRelease: null },
        model: "gpt-5.4",
        openclawDir: cwd,
        reasoningEffort: "medium",
        sandboxMode: "read-only",
        serviceTier: "",
        preserveCodexAuth: true,
        timeoutMs: 60_000,
        workDir,
        prompt: "Return a review decision for this controlled provider failure.",
        promptFileBytes: 0,
        resultFileBytes: TRANSIENT_REVIEW_RESULT_MAX_BYTES,
        streamFileBytes: 0,
        quietLogs: true,
      };
      // Keep the loopback server responsive while the production synchronous runner executes.
      const source = `
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runCodexForTest, codexFailureDecisionForTest } from ${JSON.stringify(new URL("../dist/clawsweeper.js", import.meta.url).href)};
import { summarizeHostedMultilineFailure } from ${JSON.stringify(new URL("./hosted-review-canary-proof.mjs", import.meta.url).href)};
const options = JSON.parse(process.argv[1]);
try {
  let failure;
  try { runCodexForTest(options); } catch (error) { failure = error; }
  assert.ok(failure instanceof Error);
  const decision = codexFailureDecisionForTest(failure.status, failure.message, failure.stdout, failure.stderr, failure);
  const git = (...args) => execFileSync(${JSON.stringify(gitExecutable)}, args, { cwd: options.openclawDir, encoding: "utf8", timeout: 15000 }).trim();
  const proof = summarizeHostedMultilineFailure(failure, decision, {
    resultExists: existsSync(join(options.workDir, options.item.number + ".json")),
    checkoutUnchanged: git("rev-parse", "HEAD") === options.git.mainSha && git("status", "--porcelain") === "",
  });
  process.stdout.write(JSON.stringify(proof));
} catch {
  process.stderr.write("Hosted native multiline assertions failed; diagnostics withheld.\\n");
  process.exitCode = 1;
}
`;
      child = spawn(
        process.execPath,
        ["--input-type=module", "--eval", source, JSON.stringify(options)],
        { cwd: process.cwd(), env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      fixtureQuiescent = false;
      const outerIdentity = hostedProcessIdentity(child.pid);
      assert.ok(outerIdentity);
      child.once("error", refuse);
      childClosed = new Promise((resolve) =>
        child.once("close", (code, signal) => {
          closed = true;
          resolve({ code, signal });
        }),
      );
      let capturedBytes = 0;
      const stdout = [];
      for (const stream of [child.stdout, child.stderr]) {
        stream.on("data", (chunk) => {
          capturedBytes += chunk.length;
          if (capturedBytes > maxCaptureBytes) refuse();
          else if (stream === child.stdout) stdout.push(chunk);
        });
      }
      timer = setTimeout(refuse, 75_000);
      await Promise.race([childClosed, aborted]);
      const records = readHostedLifecycle(launches, nonce);
      assert.equal(records.length, 2, "both inspection and review launch identities are required");
      if (failed) {
        for (const record of records) {
          assert.equal(record.kind, "native");
          await stopHostedNativeGroup(record.identity);
        }
        if (!closed) await stopHostedNativeGroup(outerIdentity);
      }
      const result = await childClosed;
      assertHostedNativeQuiescent(records);
      assertHostedProcessGroupGone(outerIdentity);
      fixtureQuiescent = true;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      assert.equal(failed, false);
      assert.deepEqual(result, { code: 0, signal: null });
      assert.equal(requests, 1);
      const proof = JSON.parse(Buffer.concat(stdout).toString("utf8"));
      assertBooleanCountArtifact(proof);
      return { ...proof, nativeMultilineProviderRequestCount: requests };
    } catch {
      throw new Error("Hosted native multiline proof failed; diagnostics withheld.");
    } finally {
      clearTimeout(timer);
      if (!closed && child) {
        // Unknown ownership is not clearance to signal or erase a live fixture.
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      }
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
}

async function proveMissingBlobChild({ root, cwd, baseSha, headSha, itemNumber, marker }) {
  const origin = join(root, "blob-origin.git");
  const target = join(root, "blob-target");
  const records = join(root, "blob-records");
  const output = join(root, "blob-output");
  const home = join(root, "blob-home");
  const temporaryRoot = join(root, "blob-tmp");
  const startsPath = join(root, "blob-starts.jsonl");
  const metadataCallsPath = join(root, "blob-metadata-calls");
  const preload = join(root, "blob-starts.mjs");
  const terminalReceipts = join(root, "blob-terminal.jsonl");
  const terminalObserver = join(root, "blob-observer.sh");
  const nonce = randomUUID();
  const tmux = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
  const entrypoint = fileURLToPath(new URL("../dist/clawsweeper.js", import.meta.url));
  const repo = "steipete/camsnap";
  const git = (directory, ...args) =>
    execFileSync(gitExecutable, args, {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    }).trim();
  mkdirSync(records);
  mkdirSync(home);
  mkdirSync(temporaryRoot, { mode: 0o700 });
  git(root, "init", "--bare", "-q", origin);
  git(origin, "config", "uploadpack.allowFilter", "true");
  git(
    cwd,
    "push",
    "-q",
    origin,
    `${baseSha}:refs/heads/main`,
    `${headSha}:refs/pull/${itemNumber}/head`,
  );
  // Only initial local setup may hydrate the base checkout; head probes stay offline.
  execFileSync(
    gitExecutable,
    [
      "clone",
      "-q",
      "--filter=blob:none",
      "--branch",
      "main",
      "--single-branch",
      pathToFileURL(origin).href,
      target,
    ],
    {
      cwd: root,
      env: { ...process.env, GIT_NO_LAZY_FETCH: "0" },
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    },
  );
  git(
    target,
    "fetch",
    "-q",
    "--filter=blob:none",
    "--depth=1",
    "origin",
    `refs/pull/${itemNumber}/head:refs/clawsweeper/review-cache/head-${itemNumber}`,
  );
  git(target, "cat-file", "-e", `${headSha}^{commit}`);
  const blob = git(cwd, "rev-parse", `${headSha}:review-fixture.js`);
  const missing = () =>
    git(target, "rev-list", "--objects", "--missing=print", `${headSha}^{tree}`)
      .split("\n")
      .includes(`?${blob}`);
  assert.equal(missing(), true);
  const beforeHead = git(target, "rev-parse", "HEAD");
  const beforeStatus = git(target, "status", "--porcelain");
  const beforeWorktrees = git(target, "worktree", "list", "--porcelain");
  const beforeBytes = readFileSync(join(target, "review-fixture.js"));
  const sourceWorktrees = git(cwd, "worktree", "list", "--porcelain");
  // Metadata is synthetic, but every object ID and byte count comes from the full Git fixture.
  const tree = git(
    cwd,
    "ls-tree",
    "-r",
    "--format=%(objecttype) %(objectname) %(objectsize)",
    headSha,
  )
    .split("\n")
    .map((line) => {
      const [type, sha, size] = line.split(" ");
      return { type, sha, size: Number(size) };
    });
  const entry = `node -e ${JSON.stringify(
    `const assert = require("node:assert/strict"); const fs = require("node:fs"); for (const key of ["OPENAI_API_KEY", "GH_TOKEN", "AWS_SECRET_ACCESS_KEY", "DATABASE_PASSWORD"]) assert.equal(process.env[key], undefined); const text = fs.readFileSync("review-fixture.js", "utf8"); const match = /canaryMarker = "([^"]+)"/.exec(text); assert.ok(match); console.log("canary-marker:" + match[1]);`,
  )}`;
  writeFileSync(
    join(records, `${itemNumber}.md`),
    `---\nnumber: ${itemNumber}\nrepository: ${repo}\ntype: pull_request\npull_head_sha: ${headSha}\n---\n\n## Live Proof\n\nStatus: recommended\n\nSurface: terminal\n\nTerminal completion: exit_zero\n\nReason: Read the admitted committed fixture.\n\nPayoff: static_text\n\nPayoff justification: Text is sufficient.\n\nEntry: ${entry}\n\nSteps:\n\n- {"action":"expect_output","text":"canary-marker:"}\n\n## Work Candidate\n\nCandidate: none\n`,
    { mode: 0o600 },
  );
  // The preload passes reads through unchanged and observes the real child before cleanup.
  writeFileSync(
    preload,
    hostedBlobPreloadSource({ entrypoint, startsPath, terminalReceipts, nonce }),
    { mode: 0o600 },
  );
  // Observe only the unchanged watchdog's successful atomic publications.
  // The real mv status is preserved; absent observation makes cleanup unknown.
  writeFileSync(terminalObserver, hostedTerminalObserverSource(terminalReceipts, nonce), {
    mode: 0o600,
  });
  const env = {
    PATH: originalPath,
    HOME: home,
    TMPDIR: temporaryRoot,
    SHELL: "/bin/bash",
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    CLAWSWEEPER_TARGET_REPO: "openclaw/clawsweeper",
    // Replace inherited options; the sanitized child currently preserves NODE_OPTIONS.
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    BASH_ENV: terminalObserver,
    OPENAI_API_KEY: "fixture-must-not-cross",
    GH_TOKEN: "fixture-must-not-cross",
    AWS_SECRET_ACCESS_KEY: "fixture-must-not-cross",
    DATABASE_PASSWORD: "fixture-must-not-cross",
  };
  for (const [command, args] of [
    ["npm", ["--version"]],
    ["tmux", ["-V"]],
  ]) {
    const probe = spawnSync(command, args, {
      env: sanitizedLiveProofEnvironment(env),
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(probe.error, undefined, "hosted live-proof prerequisite unavailable");
    assert.equal(probe.status, 0, "hosted live-proof prerequisite failed");
  }
  const readStarts = () => {
    if (!existsSync(startsPath)) return [];
    assert.ok(statSync(startsPath).size <= 16 * 1024);
    return readFileSync(startsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  };
  for (const truncated of [true, false]) {
    const startsBefore = readStarts().length;
    const callsBefore = existsSync(metadataCallsPath)
      ? readFileSync(metadataCallsPath, "utf8").length
      : 0;
    const metadataSource = `
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
try {
  assert.deepEqual(process.argv.slice(1), ["api", ${JSON.stringify(`repos/${repo}/git/trees/${headSha}?recursive=1`)}]);
  appendFileSync(${JSON.stringify(metadataCallsPath)}, "1", { mode: 0o600 });
  process.stdout.write(${JSON.stringify(JSON.stringify({ truncated, tree }))});
} catch {
  process.stderr.write("Unexpected synthetic metadata request.\\n");
  process.exitCode = 1;
}
`;
    const args = [
      entrypoint,
      "live-proof-review",
      "--repo",
      repo,
      "--records-dir",
      records,
      "--checkout",
      target,
      "--output",
      output,
      "--item",
      String(itemNumber),
    ];
    let failed = false;
    let resolveAbort;
    const aborted = new Promise((resolve) => {
      resolveAbort = resolve;
    });
    const refuse = () => {
      failed = true;
      resolveAbort();
    };
    await withHostedFixtureSignals(refuse, async () => {
      const child = spawn(process.execPath, args, {
        cwd,
        env: {
          ...env,
          GH_BIN: process.execPath,
          GH_BIN_ARGS: JSON.stringify(["--input-type=module", "--eval", metadataSource]),
        },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      fixtureQuiescent = false;
      const outerIdentity = hostedProcessIdentity(child.pid);
      assert.ok(outerIdentity);
      let closed = false;
      child.once("error", refuse);
      const completion = new Promise((resolve) =>
        child.once("close", (status, signal) => {
          closed = true;
          resolve({ status, signal });
        }),
      );
      const stdout = [];
      let captured = 0;
      for (const stream of [child.stdout, child.stderr]) {
        stream.on("data", (chunk) => {
          captured += chunk.length;
          if (captured > 1024 * 1024) refuse();
          else if (stream === child.stdout) stdout.push(chunk);
        });
      }
      const timer = setTimeout(refuse, 120_000);
      let result;
      try {
        await Promise.race([completion, aborted]);
        if (failed) {
          await stopHostedTerminal({ path: terminalReceipts, nonce, tmux });
          if (!closed) await stopHostedNativeGroup(outerIdentity);
        }
        result = { ...(await completion), stdout: Buffer.concat(stdout).toString("utf8") };
        assertHostedProcessGroupGone(outerIdentity);
        if (!truncated) {
          await assertHostedTerminalQuiescent(readHostedLifecycle(terminalReceipts, nonce));
        } else assert.equal(existsSync(terminalReceipts), false);
        fixtureQuiescent = true;
        assert.equal(failed, false, "hosted live-proof CLI failed to complete");
      } finally {
        clearTimeout(timer);
        if (!closed) {
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
        }
      }
      assert.equal(result.signal, null);
      const starts = readStarts().slice(startsBefore);
      assertHostedBlobStarts(starts, repo, itemNumber, truncated ? 0 : 1, temporaryRoot);
      assert.deepEqual(starts[0].args, args.slice(2));
      assert.equal(readFileSync(metadataCallsPath, "utf8").length - callsBefore, 1);
      if (truncated) {
        assert.notEqual(result.status, 0);
        assert.equal(missing(), true);
        assert.equal(existsSync(output), false);
      } else {
        assert.equal(result.status, 0);
        assert.equal(missing(), false);
        assert.ok(result.stdout.includes("sanitized environment assertion passed: credentials=0"));
        const verification = parseLiveVerificationResult(
          JSON.parse(
            readFileSync(join(output, String(itemNumber), "live-verification.json"), "utf8"),
          ),
        );
        assert.equal(verification.repo, repo);
        assert.equal(verification.head_sha, headSha);
        assert.equal(verification.overall_pass, true);
        assert.ok(verification.output.includes(marker));
        assert.ok(!verification.output.includes("fixture-must-not-cross"));
        assert.ok(
          readdirSync(join(output, String(itemNumber))).every((name) =>
            ["live-verification.json", "live-proof-manifest.json"].includes(name),
          ),
        );
      }
      assert.equal(git(target, "rev-parse", "HEAD"), beforeHead);
      assert.equal(git(target, "status", "--porcelain"), beforeStatus);
      assert.equal(git(target, "worktree", "list", "--porcelain"), beforeWorktrees);
      assert.deepEqual(readFileSync(join(target, "review-fixture.js")), beforeBytes);
      assert.equal(git(cwd, "worktree", "list", "--porcelain"), sourceWorktrees);
    });
  }
  return {
    missingBlobRefusalCount: 1,
    missingBlobRefusalChildCount: 0,
    missingBlobAdmittedChildCount: 1,
    missingBlobMetadataRequestCount: 2,
    missingBlobSyntheticMetadata: true,
    missingBlobActualSanitizedChild: true,
    missingBlobCredentialsAbsent: true,
    missingBlobExactHeadVerified: true,
    missingBlobCheckoutUnchanged: true,
    missingBlobMediaRetained: false,
  };
}
