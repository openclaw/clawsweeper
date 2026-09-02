import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ReviewGitError } from "../dist/clawsweeper-review-blobs.js";
import { writeExactReviewFailureDiagnostics } from "../dist/clawsweeper-review-failure-diagnostics.js";
import { AgentInputScanError, agentInputScanFailureExitCode } from "../dist/agent-input-scan.js";

const expectedFiles = ["error.txt", "manifest.json", "stderr.tail.txt", "stdout.error.txt"];

function failure(message: string, stderr: string, stdout = ""): Error {
  return Object.assign(new Error(message), {
    status: 1,
    signal: "SIGTERM",
    errorCode: "ECONNRESET",
    retryable: true,
    stderr,
    stdout,
  });
}

function write(root: string, error: Error, env: NodeJS.ProcessEnv = {}) {
  return writeExactReviewFailureDiagnostics({
    artifactDir: root,
    error,
    prompt: "private prompt text\n  qz  \nmultiline prompt-only directive",
    model: "private-model",
    classification: "codex_execution",
    repo: "openclaw/openclaw",
    itemKind: "pull_request",
    itemNumber: 1318,
    sourceSha: "a".repeat(40),
    retryable: true,
    workflowExit: 1,
    env,
  });
}

test("exact-review diagnostics retain distinct safe causes within the aggregate bound", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-diagnostics-"));
  const secret = "fixture-secret-value";
  try {
    const stdout = [
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "private prompt text" },
      }),
      "private prompt text",
      JSON.stringify({
        type: "turn.failed",
        error: { message: `proxy negotiation failed after CONNECT; token=${secret}` },
      }),
    ].join("\n");
    const first = write(
      join(root, "first"),
      failure(
        `Codex exited for private-model at /Users/example/work`,
        [
          "x".repeat(20_000),
          "TLS certificate negotiation failed before transport startup",
          `AUTH_TOKEN=${secret}`,
          "AWS_ACCOUNT_ID=123456789012",
          "endpoint=https://proxy.internal.example/v1",
          "fallback [::1]:8080",
          "multiline prompt-only directive",
          "prompt raw:   qz  ",
          "prompt trimmed: qz",
        ].join("\n"),
        stdout,
      ),
      { CODEX_TOKEN: secret },
    );
    const second = write(
      join(root, "second"),
      failure("Codex process failed", "child process could not load its dynamic library"),
    );

    const firstText = expectedFiles
      .map((name) => readFileSync(join(first, name), "utf8"))
      .join("\n");
    const secondText = expectedFiles
      .map((name) => readFileSync(join(second, name), "utf8"))
      .join("\n");
    const manifest = JSON.parse(readFileSync(join(first, "manifest.json"), "utf8"));
    assert.deepEqual(readdirSync(first).sort(), expectedFiles);
    assert.equal(manifest.classification, "codex_execution");
    assert.equal(manifest.retryable, true);
    assert.deepEqual(manifest.failure, { stage: "unknown", reason_code: "unknown" });
    assert.deepEqual(manifest.process, {
      status: 1,
      signal: "SIGTERM",
      error_code: "ECONNRESET",
      workflow_exit: 1,
    });
    assert.deepEqual(manifest.source, {
      repository: "openclaw/openclaw",
      item_kind: "pull_request",
      item_number: 1318,
      sha: "a".repeat(40),
    });
    assert.match(firstText, /TLS certificate negotiation failed/);
    assert.match(secondText, /could not load its dynamic library/);
    assert.notEqual(firstText, secondText);
    for (const forbidden of [
      secret,
      "private prompt text",
      "multiline prompt-only directive",
      "qz",
      "123456789012",
      "private-model",
      "/Users/example",
      "proxy.internal.example",
      "::1",
      "agent_message",
    ]) {
      assert.doesNotMatch(firstText, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.match(readFileSync(join(first, "stdout.error.txt"), "utf8"), /proxy negotiation failed/);
    for (const [name, limit] of [
      ["error.txt", 4096],
      ["stdout.error.txt", 4096],
      ["stderr.tail.txt", 12288],
    ] as const) {
      assert.ok(statSync(join(first, name)).size <= limit, name);
    }
    assert.ok(
      expectedFiles.reduce((size, name) => size + statSync(join(first, name)).size, 0) <= 24 * 1024,
    );
    assert.throws(() => write(join(root, "first"), failure("later", "later")), /already exist/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source-preparation diagnostics survive unsafe raw detail", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-diagnostics-"));
  try {
    const error = Object.assign(new Error(`fetch failed for ${"a1".repeat(20)}`), {
      diagnosticStage: "source_preparation",
      diagnosticReason: "review_blobs_unavailable",
    });
    const output = writeExactReviewFailureDiagnostics({
      artifactDir: root,
      error,
      prompt: "private prompt",
      model: "private-model",
      classification: "codex_execution",
      repo: "openclaw/openclaw",
      itemKind: "pull_request",
      itemNumber: 1338,
      sourceSha: "a".repeat(40),
      retryable: true,
      workflowExit: 1,
      env: {},
    });
    const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
    assert.equal(manifest.classification, "source_preparation");
    assert.equal(manifest.retryable, true);
    assert.deepEqual(manifest.failure, {
      stage: "source_preparation",
      reason_code: "review_blobs_unavailable",
    });
    assert.equal(
      readFileSync(join(output, "error.txt"), "utf8"),
      "[omitted: unsafe diagnostic content]\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scan diagnostics retain refusal identity without scanner output", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-diagnostics-"));
  try {
    for (const reason of ["findings", "incomplete_source"] as const) {
      const error = Object.assign(new AgentInputScanError(reason), {
        stdout: '{"type":"turn.failed","error":{"message":"raw scanner finding"}}',
        stderr: "raw scanner verification detail",
      });
      const output = writeExactReviewFailureDiagnostics({
        artifactDir: join(root, reason),
        error,
        prompt: "private prompt",
        model: "private-model",
        classification: "codex_execution",
        repo: "openclaw/openclaw",
        itemKind: "pull_request",
        itemNumber: 1338,
        sourceSha: "a".repeat(40),
        retryable: false,
        workflowExit: agentInputScanFailureExitCode(error) ?? 1,
        env: {},
      });
      const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
      assert.equal(manifest.classification, "agent_input_scan");
      assert.deepEqual(manifest.failure, { stage: "agent_input_scan", reason_code: reason });
      assert.equal(manifest.retryable, false);
      assert.equal(manifest.process.workflow_exit, reason === "incomplete_source" ? 78 : 79);
      const text = expectedFiles.map((name) => readFileSync(join(output, name), "utf8")).join("\n");
      assert.doesNotMatch(text, /raw scanner/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("incompatible source diagnostics retain their structured terminal identity", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-diagnostics-"));
  try {
    const output = writeExactReviewFailureDiagnostics({
      artifactDir: root,
      error: Object.assign(new Error("invalid immutable source"), {
        diagnosticStage: "source_preparation",
        diagnosticReason: "source_incompatible",
      }),
      prompt: "private prompt",
      model: "private-model",
      classification: "codex_execution",
      repo: "openclaw/openclaw",
      itemKind: "pull_request",
      itemNumber: 70002,
      sourceSha: "0".repeat(40),
      retryable: false,
      workflowExit: 1,
      env: {},
    });
    const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
    assert.equal(manifest.classification, "source_preparation");
    assert.equal(manifest.retryable, false);
    assert.deepEqual(manifest.failure, {
      stage: "source_preparation",
      reason_code: "source_incompatible",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unsafe files are omitted whole and recorded in the readiness manifest", () => {
  const cases = [
    ["control byte", "startup failed\u0000after fork"],
    ["yaml secret", "TOKEN: |\n  first\n  second"],
    ["private key", "-----BEGIN PRIVATE KEY-----\nmaterial\n-----END PRIVATE KEY-----"],
    ["opaque residual", "startup failed Abcd1234Efgh5678Ijkl9012Mnop+/=="],
  ] as const;
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-diagnostics-"));
  try {
    for (const [name, stderr] of cases) {
      const output = write(join(root, name.replace(" ", "-")), failure("Codex failed", stderr));
      assert.equal(
        readFileSync(join(output, "stderr.tail.txt"), "utf8"),
        "[omitted: unsafe diagnostic content]\n",
      );
      assert.deepEqual(
        JSON.parse(readFileSync(join(output, "manifest.json"), "utf8")).omitted_files,
        ["stderr.tail.txt"],
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native review fetch timeouts retain structured process diagnostics", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-diagnostics-"));
  try {
    const result = spawnSync(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      encoding: "utf8",
      timeout: 25,
    });
    assert.equal((result.error as NodeJS.ErrnoException | undefined)?.code, "ETIMEDOUT");
    assert.equal(result.status, null);
    assert.match(result.signal ?? "", /^SIG[A-Z0-9]+$/);
    const error = new ReviewGitError("review_commit_fetch_failed", result);
    assert.equal(error.message, "Review source preparation failed.");
    const output = write(root, error);
    const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
    assert.equal(manifest.classification, "source_preparation");
    assert.deepEqual(manifest.failure, {
      stage: "source_preparation",
      reason_code: "review_commit_fetch_failed",
    });
    assert.deepEqual(manifest.process, {
      status: null,
      signal: result.signal,
      error_code: "ETIMEDOUT",
      workflow_exit: 1,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
