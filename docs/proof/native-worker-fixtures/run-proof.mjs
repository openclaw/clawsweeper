import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { networkInterfaces } from "node:os";
assert.ok(
  Object.values(networkInterfaces())
    .flat()
    .every((address) => address?.internal),
  "Run inside a loopback-only network namespace",
);
assert.ok(
  Object.keys(process.env).every((name) => ["HOME", "PATH", "PWD"].includes(name)),
  "Run with a cleared environment",
);
const [target, baseSha, headSha, output] = process.argv.slice(2);
assert.ok(target && baseSha && headSha && output);
const hash = (x) => createHash("sha256").update(x).digest("hex");
const realSpawn = childProcess.spawnSync;
const scans = [];
childProcess.spawnSync = function (command, args, options) {
  if (!args?.includes("filesystem")) return realSpawn(command, args, options);
  const directory = args[args.indexOf("filesystem") + 1];
  const files = readdirSync(directory)
    .sort()
    .map((id) => ({ id, bytes: readFileSync(join(directory, id)) }));
  const result = realSpawn(command, args, options);
  const findings = result.stdout.toString().trim().split("\n").filter(Boolean).map(JSON.parse);
  scans.push({
    scannerVersion: "3.97.4",
    scannerSha256: hash(readFileSync(command)),
    arguments: args.map((v) => (v === directory ? "<staging>" : v)),
    exit: result.status,
    signal: result.signal,
    errorCode: result.error?.code,
    inputs: files.map(({ id, bytes }) => ({ id, bytes: bytes.length, sha256: hash(bytes) })),
    findings: findings.map((f) => {
      const meta = f.SourceMetadata?.Data?.Filesystem;
      const staged = files.find((x) => x.id === basename(meta.file));
      const line = staged?.bytes.toString().split("\n")[meta.line - 1];
      return {
        input: basename(meta.file),
        line: meta.line,
        lineSha256: line === undefined ? null : hash(line),
        unprefixedLineSha256: line === undefined ? null : hash(line.replace(/^[+-]/, "")),
        detector: f.DetectorType,
        detectorName: f.DetectorName,
        decoder: f.DecoderName,
        verified: f.Verified,
        rawSha256: hash(f.Raw),
        rawV2Sha256: hash(f.RawV2),
        verificationErrorPresent: !!f.VerificationError,
      };
    }),
    completion: result.stderr
      .toString()
      .split("\n")
      .filter(Boolean)
      .map((x) => {
        try {
          return JSON.parse(x);
        } catch {
          return null;
        }
      })
      .filter((x) => x?.msg === "finished scanning")
      .map((x) => ({
        version: x.trufflehog_version,
        chunks: x.chunks,
        bytes: x.bytes,
        verified: x.verified_secrets,
        unverified: x.unverified_secrets,
      })),
  });
  return result;
};
syncBuiltinESMExports();
const { scanAgentInput } = await import(pathToFileURL(resolve("dist/agent-input-scan.js")));
const prompt = "Read-only native worker transport source review.";
const report = {
  baseSha,
  headSha,
  promptSha256: hash(prompt),
  schema: null,
  environment: {
    platform: process.platform,
    node: process.version,
    network: "bubblewrap --unshare-net; no live credential verification possible",
    secrets: "cleared environment; production scanner private HOME",
  },
  scans,
  notices: [],
  result: "pending",
};
const originalError = console.error;
try {
  console.error = (value) => {
    const item = JSON.parse(String(value));
    assert.equal(item.event, "agent_input_scan_classified");
    report.notices.push(item);
  };
  scanAgentInput({
    cwd: resolve(target),
    source: { kind: "committed", baseSha, headSha },
    prompt,
    timeoutMs: 180000,
  });
  report.result = "admitted";
} catch (e) {
  report.result = "refused";
  report.failure = { reason: e.reason, diagnostic: e.scanDiagnostic };
} finally {
  console.error = originalError;
  childProcess.spawnSync = realSpawn;
  syncBuiltinESMExports();
}
writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(
  JSON.stringify(
    {
      result: report.result,
      failure: report.failure,
      scans: scans.map((s) => ({
        exit: s.exit,
        inputs: s.inputs.length,
        findings: s.findings,
        completion: s.completion,
      })),
      notices: report.notices.length,
    },
    null,
    2,
  ),
);
