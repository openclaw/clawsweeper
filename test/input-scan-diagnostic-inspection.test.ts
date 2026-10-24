import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentInputScanError } from "../dist/agent-input-scan.js";
import { writeExactReviewFailureDiagnostics } from "../dist/clawsweeper-review-failure-diagnostics.js";
import { inspectInputScanDiagnostic } from "../scripts/inspect-input-scan-diagnostic.mjs";

const identity = {
  repository: "openclaw/clawsweeper",
  itemKind: "pull_request",
  itemNumber: 2057,
  sourceSha: "a".repeat(40),
  runRepository: "openclaw/clawsweeper",
  runId: "123",
  runAttempt: "2",
};
function manifest() {
  return {
    version: 1,
    classification: "agent_input_scan",
    retryable: false,
    source: {
      repository: identity.repository,
      item_kind: identity.itemKind,
      item_number: identity.itemNumber,
      sha: identity.sourceSha,
    },
    run: { repository: identity.runRepository, id: identity.runId, attempt: identity.runAttempt },
    failure: {
      stage: "agent_input_scan",
      reason_code: "findings",
      scan: {
        kind: "unclassified_finding",
        reason: "literal_not_reviewed",
        findingCount: 2,
        findingIndex: 0,
        detectorType: 3,
        decoder: "HTML",
        verified: false,
        scannerLine: 7,
        material: {
          kind: "blob",
          id: "b".repeat(40),
          referenceCount: 1,
          references: [
            { revision: "a".repeat(40), pathSha256: "c".repeat(64), mode: "100644", role: "head" },
          ],
        },
      },
    },
    process: { workflow_exit: 79 },
  };
}
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "safe-inspection-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "manifest.json");
  const read = (value: unknown = manifest(), overrides = {}) => {
    writeFileSync(path, JSON.stringify(value));
    return inspectInputScanDiagnostic({ manifestPath: path, ...identity, ...overrides });
  };
  return { root, path, read };
}
test("inspector projects bounded safe metadata and pointer without promoting scanner coordinates", (t) => {
  const { read } = fixture(t);
  const input: any = manifest();
  input.failure.scan.Raw = "CANARY_RAW_VALUE";
  input.failure.scan.material.path = "/private/CANARY_PATH";
  input.stderr = "CANARY_SCANNER_OUTPUT";
  const output = read(input);
  assert.equal(output.diagnostic.failure.scan.scannerLine, 7);
  assert.equal(output.diagnostic.failure.scan.sourceLine, undefined);
  assert.match(output.summary, /actions\/runs\/123\/attempts\/2/);
  assert.match(output.summary, /exact-review-failure-diagnostics-123-2/);
  assert.doesNotMatch(output.summary, /literal_not_reviewed|detector|scannerLine|cccc/);
  assert.doesNotMatch(JSON.stringify(output), /CANARY/);
});
test("inspector refuses missing, oversized, malformed and symlink manifests", (t) => {
  const { root, path } = fixture(t);
  const inspect = (manifestPath = path) =>
    inspectInputScanDiagnostic({ manifestPath, ...identity });
  assert.throws(() => inspect(), /unavailable/);
  writeFileSync(path, "{");
  assert.throws(() => inspect(), /malformed/);
  writeFileSync(path, " ".repeat(24 * 1024 + 1));
  assert.throws(() => inspect(), /size/);
  writeFileSync(path, JSON.stringify(manifest()));
  if (process.platform !== "win32") {
    const link = join(root, "link.json");
    symlinkSync(path, link);
    assert.throws(() => inspect(link), /regular file/);
  }
});
test("inspector fails closed on stale or wrong source and run identity", (t) => {
  const { read } = fixture(t);
  for (const overrides of [
    { repository: "another/repo" },
    { itemKind: "issue" },
    { itemNumber: 2 },
    { sourceSha: "b".repeat(40) },
    { runRepository: "another/repo" },
    { runId: "124" },
    { runAttempt: "1" },
  ])
    assert.throws(() => read(manifest(), overrides), /identity/);
  const noRun: any = manifest();
  delete noRun.run;
  assert.throws(() => read(noRun), /identity/);
});
test("inspector rejects unsafe selectors, URLs, malformed metadata and nonterminal states", (t) => {
  const { read } = fixture(t);
  for (const overrides of [
    { repository: "../repo" },
    { repository: "owner/repo\n" },
    { runId: "123\n" },
    { sourceSha: "a".repeat(41) },
    { itemNumber: 0 },
    { artifactUrl: "https://evil.invalid/openclaw/clawsweeper/actions/runs/123/artifacts/1" },
    { artifactUrl: "https://github.com/openclaw/clawsweeper/actions/runs/124/artifacts/1" },
    { artifactUrl: "https://github.com/openclaw/clawsweeper/actions/runs/123/artifacts/1?token=x" },
  ])
    assert.throws(() => read(manifest(), overrides));
  for (const mutate of [
    (m: any) => {
      m.version = 2;
    },
    (m: any) => {
      m.retryable = true;
    },
    (m: any) => {
      m.failure.reason_code = "untrusted\n";
    },
    (m: any) => {
      m.failure.scan.findingCount = Infinity;
    },
    (m: any) => {
      m.failure.scan.findingIndex = 2;
    },
    (m: any) => {
      m.failure.scan.decoder = "<script>";
    },
    (m: any) => {
      m.failure.scan.material.id = "/tmp/raw";
    },
    (m: any) => {
      m.failure.scan.material.references[0].pathSha256 = "../raw";
    },
    (m: any) => {
      m.failure.scan.material.references[0].role = "head\u001b";
    },
    (m: any) => {
      m.failure.scan.material.references = Array(5).fill(m.failure.scan.material.references[0]);
    },
  ]) {
    const m = manifest();
    mutate(m);
    assert.throws(() => read(m));
  }
});
test("missing attribution is explicit and artifact URL is scoped to the exact run", (t) => {
  const { read } = fixture(t);
  const m: any = manifest();
  delete m.failure.scan;
  const result = read(m, {
    artifactUrl: "https://github.com/openclaw/clawsweeper/actions/runs/123/artifacts/456",
  });
  assert.equal(result.diagnostic.failure.scan, null);
  assert.match(result.summary, /artifacts\/456/);
  assert.match(result.summary, /not authorize a retry/);
});

test("issue inspection requires the exact hydrated issue revision, not a null or PR identity", (t) => {
  const { read } = fixture(t);
  const input = manifest();
  input.source.item_kind = "issue";
  input.source.sha = "d".repeat(64);
  const expected = { itemKind: "issue", sourceSha: "d".repeat(64) };
  assert.equal(read(input, expected).diagnostic.source.sourceSha, "d".repeat(64));
  assert.throws(() => read(input, { ...expected, sourceSha: "e".repeat(64) }), /identity/);
  assert.throws(() => read(input, { ...expected, sourceSha: "none" }), /identity/);
  assert.throws(() => read(input, { ...expected, sourceSha: "a".repeat(40) }), /identity/);
  const absent = manifest();
  absent.source.item_kind = "issue";
  absent.source.sha = null;
  assert.throws(() => read(absent, expected), /identity/);
});

test("production writer and inspector agree on an issue revision", (t) => {
  const { root } = fixture(t);
  const revision = "d".repeat(64);
  const directory = writeExactReviewFailureDiagnostics({
    artifactDir: root,
    error: new AgentInputScanError("findings"),
    prompt: "synthetic",
    model: "unused",
    classification: "agent_input_scan",
    repo: identity.repository,
    itemKind: "issue",
    itemNumber: 2057,
    sourceSha: revision,
    retryable: false,
    workflowExit: 79,
    env: {
      GITHUB_REPOSITORY: identity.runRepository,
      GITHUB_RUN_ID: identity.runId,
      GITHUB_RUN_ATTEMPT: identity.runAttempt,
    },
  });
  const result = inspectInputScanDiagnostic({
    ...identity,
    itemKind: "issue",
    sourceSha: revision,
    manifestPath: join(directory, "manifest.json"),
  });
  assert.equal(result.diagnostic.source.sourceSha, revision);
});
