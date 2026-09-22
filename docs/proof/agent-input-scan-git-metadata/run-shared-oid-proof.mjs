import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { managedScannerCacheRoot, scanAgentInput } from "../../../dist/agent-input-scan.js";
import { ensureManagedTruffleHog, TRUFFLEHOG_VERSION } from "../../../dist/review-tool-bootstrap.js";

const [output, baselineRoot, scanner] = process.argv.slice(2);
if (!output || !baselineRoot || !scanner)
  throw new Error("Pass output JSON, baseline runtime directory, and pinned scanner path.");
const baseline = await import(pathToFileURL(join(resolve(baselineRoot), "dist/agent-input-scan.js")));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const scannerSha256 = digest(readFileSync(scanner));
const trustedScanner = await ensureManagedTruffleHog({
  timeoutMs: 120_000,
  env: { ...process.env, CLAWSWEEPER_REVIEW_TOOLS_DIR: managedScannerCacheRoot(process.env, realpathSync(process.cwd()), process.cwd()) },
});
assert.equal(realpathSync(scanner), realpathSync(trustedScanner));
assert.equal(realpathSync(execFileSync("which", ["trufflehog"], { encoding: "utf8" }).trim()), realpathSync(scanner));
const report = {
  claim: "A shared old Git blob can require metadata replay in an approved URI patch section.",
  scannerVersion: TRUFFLEHOG_VERSION,
  scannerSha256,
  limits: "Controlled committed source and prompt, unchanged canonical owners, no model or hosted admission.",
  cases: [],
};
const root = mkdtempSync(join(tmpdir(), "clawsweeper-shared-oid-proof-"));
const target = join(root, "target");
const input = join(root, "input");
const scanEnv = { HOME: root, TMPDIR: root, TMP: root, TEMP: root };
const originalEnv = { ...process.env };
const gitEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  ...scanEnv, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull,
  GIT_TEMPLATE_DIR: join(root, "empty-template"),
};
// Canonical owner Git reads and fixture writes share one bounded Git environment.
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, gitEnv);
try {
  mkdirSync(gitEnv.GIT_TEMPLATE_DIR);
  mkdirSync(target);
  mkdirSync(input, { mode: 0o700 });
  const git = (...args) => execFileSync("git", args, {
    cwd: target, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: gitEnv,
  }).trim();
  git("init", "-q");
  git("config", "user.name", "Scanner fixture");
  git("config", "user.email", "scanner@example.invalid");
  git("config", "commit.gpgsign", "false");
  const uriSource = "ui/src/pages/custodian/custodian-session-store.test.ts";
  mkdirSync(join(target, "cloudflare"), { recursive: true });
  mkdirSync(join(target, "ui/src/pages/custodian"), { recursive: true });
  for (const file of ["cloudflare/x", uriSource])
    writeFileSync(join(target, file), "<p>one</p>\n");
  git("add", ".");
  git("commit", "-qm", "fixture base");
  const baseSha = git("rev-parse", "HEAD");
  const oid = git("hash-object", uriSource);
  assert.equal(git("hash-object", "cloudflare/x"), oid);
  const uri = "https://fixture-user:fixture-password@example.invalid";
  const lines = [`      "${uri}/",`, `      { "${uri}/": "route" },`];
  assert.deepEqual(lines.map(digest), [
    "3835950cbb9c584ba2c052e76ba31ac1c83cf48ec422c588fd00605dfec4b082",
    "0452c2176a2ce671ae67942c523f65774d9fbaa672ac973968844d00fcf44852",
  ]);
  writeFileSync(join(target, "cloudflare/x"), "<p>two scanner@1.2.3</p>\n");
  writeFileSync(join(target, uriSource), `${lines.join("\n")}\n`);
  git("add", ".");
  git("commit", "-qm", "fixture head");
  const headSha = git("rev-parse", "HEAD");
  assert.notEqual(git("hash-object", uriSource), git("hash-object", "cloudflare/x"));
  assert.equal(git("status", "--porcelain=v1"), "");
  const patch = execFileSync("git", [
    "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--patch", "--binary",
    "--full-index", baseSha, headSha, "--",
  ], { cwd: target, env: gitEnv });
  assert.equal(patch.toString().split(`index ${oid}..`).length - 1, 2);
  const patchFile = join(input, "patch");
  writeFileSync(patchFile, patch, { mode: 0o600 });
  const version = spawnSync(scanner, ["--version"], { env: scanEnv, encoding: "utf8" });
  assert.equal(version.status, 0);
  assert.equal((version.stdout + version.stderr).trim(), `trufflehog ${TRUFFLEHOG_VERSION}`);
  const native = spawnSync(scanner, [
    "filesystem", input, "--results=verified,unknown", "--fail", "--fail-on-scan-errors",
    "--no-update", "--json", "--no-color",
  ], { cwd: root, env: scanEnv, timeout: 180_000, maxBuffer: 1024 * 1024 });
  assert.equal(native.error, undefined);
  assert.equal(native.signal, null);
  assert.equal(native.status, 183);
  const records = (bytes) => bytes.toString().trim().split("\n").map((line) => JSON.parse(line));
  const findings = records(native.stdout);
  const logs = records(native.stderr);
  const completion = logs.at(-1);
  assert.ok(logs.every((row) => row.level === "info-0" && typeof row.logger === "string" &&
    typeof row.msg === "string" && row.error === undefined && row.errors === undefined));
  assert.equal(logs.filter((row) => row.msg === "finished scanning").length, 1);
  assert.equal(completion?.logger, "trufflehog");
  assert.equal(completion?.msg, "finished scanning");
  assert.equal(completion?.trufflehog_version, TRUFFLEHOG_VERSION);
  assert.ok(Number.isSafeInteger(completion.chunks) && completion.chunks > 0);
  assert.ok(Number.isSafeInteger(completion.bytes) && completion.bytes > 0);
  assert.equal(completion.verified_secrets, 0);
  assert.equal(completion.unverified_secrets, findings.length);
  const metadata = findings.filter((row) => row.DetectorType === 58 && row.Raw === oid);
  const uris = findings.filter((row) => row.DetectorType === 17 && row.RawV2 === uri);
  assert.ok(metadata.length > 0 && uris.length > 0, "Both native detector classes must occur.");
  assert.equal(metadata.length + uris.length, findings.length);
  assert.ok(findings.every((row) => row.Verified === false &&
    row.SourceMetadata?.Data?.Filesystem?.file === patchFile));
  // This patch-only precondition establishes composition, not source admission.
  // The unchanged canonical owners below still scan their own complete inputs.
  const inputs = new Map([[patchFile, { kind: "patch", id: "patch", bytes: patch, from: baseSha, to: headSha }]]);
  inputs.set(join(input, "raw"), { kind: "raw_diff", id: "raw", from: baseSha, to: headSha,
    bytes: execFileSync("git", ["diff", "--raw", "-z", "--no-abbrev", baseSha, headSha, "--"], { cwd: target, env: gitEnv }) });
  for (const [revision, role] of [[baseSha, "base"], [headSha, "head"]]) {
    for (const source of ["cloudflare/x", uriSource]) {
      const id = git("rev-parse", `${revision}:${source}`);
      const file = join(input, id);
      const staged = inputs.get(file) ?? { kind: "blob", id,
        bytes: execFileSync("git", ["cat-file", "blob", id], { cwd: target, env: gitEnv }), references: [] };
      staged.references.push({ source, mode: "100644", revision, role });
      inputs.set(file, staged);
    }
  }
  const classifier = await import(pathToFileURL(join(resolve(baselineRoot), "dist/agent-input-scan-fixtures.js")));
  const primary = classifier.classifyReviewedFixtureScan(native.status, native.stdout, native.stderr, inputs);
  assert.equal(primary.kind, "git_metadata_proof_required");
  const masked = primary.proofPatches.get(patchFile);
  assert.ok(masked);
  assert.equal(masked.includes(Buffer.from(oid)), false);
  assert.equal(masked.toString().split(`index ${"_".repeat(oid.length)}..`).length - 1, 2);
  report.precondition = {
    complete: true, primaryClassification: primary.kind, maskedSections: 2, metadataFindings: metadata.length, uriFindings: uris.length, verified: 0,
    patchSha256: digest(patch), oldBlobIdSha256: digest(oid), baseSha, headSha,
  };
  for (const [name, run] of [["baseline", baseline.scanAgentInput], ["candidate", scanAgentInput]]) {
    const entry = { name, notices: [], result: "pending" };
    const previous = console.error;
    try {
      console.error = (value) => {
        const notice = JSON.parse(String(value));
        assert.equal(notice.event, "agent_input_scan_classified");
        entry.notices.push(notice);
      };
      run({ cwd: target, prompt: "Read-only dependency source review.",
        source: { kind: "committed", baseSha, headSha }, timeoutMs: 180_000 });
      entry.result = "admitted";
    } catch (error) {
      entry.result = "refused";
      entry.reason = error.reason;
      entry.diagnostic = error.scanDiagnostic;
    } finally {
      console.error = previous;
      report.cases.push(entry);
    }
    assert.equal(git("status", "--porcelain=v1"), "");
    assert.equal(git("rev-parse", "HEAD"), headSha);
  }
  assert.equal(report.cases[0].result, "refused");
  assert.equal(report.cases[0].reason, "findings");
  assert.equal(report.cases[0].diagnostic?.reason, "material_not_reviewed");
  assert.equal(report.cases[0].diagnostic?.detectorType, 17);
  assert.equal(report.cases[1].result, "admitted");
  assert.ok(report.cases[1].notices.some((notice) => notice.detector === "CloudflareGlobalApiKey"));
  assert.ok(report.cases[1].notices.some((notice) => notice.detector === "URI"));
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = { name: error.name, code: error.code ?? null };
  process.exitCode = 1;
} finally {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  rmSync(root, { recursive: true, force: true });
  writeFileSync(resolve(output), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
}
console.log(JSON.stringify({ passed: report.passed, precondition: report.precondition,
  cases: report.cases.map(({ name, result, reason }) => ({ name, result, reason })) }));
