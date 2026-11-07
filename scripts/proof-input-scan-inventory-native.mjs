// macOS-only controlled shipped-entry proof; no provider or live GitHub transport.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const [sourceArg, scannerArg, outputArg, countArg = "2", expected = "inventory"] =
  process.argv.slice(2);
assert.ok(
  ["inventory", "legacy"].includes(expected),
  "Expected inventory or explicit legacy baseline.",
);
assert.ok(
  sourceArg && scannerArg && outputArg,
  "Pass built source, verified scanner, fresh private output directory, and optional canary count.",
);
assert.equal(process.platform, "darwin");
assert.equal(process.arch, "arm64");
const source = resolve(sourceArg);
const scanner = realpathSync(scannerArg);
const root = resolve(outputArg);
const count = Number(countArg);
assert.ok(Number.isInteger(count) && count >= 2 && count <= 12);
assert.equal(existsSync(root), false, "Do not reuse evidence directories.");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Executable digest extracted from the official 3.99.4 darwin_arm64 release archive.
// Independently verify the archive against the release checksum and repository pin first.
const scannerSha256 = sha256(readFileSync(scanner));
assert.equal(scannerSha256, "e05963636bce6c5a48e0c780b26c98eb851ec8f87ab6efce8167753a9141b893");
mkdirSync(root, { mode: 0o700 });
const target = join(root, "target");
const bin = join(root, "bin");
const home = join(root, "home");
const tmp = join(root, "tmp");
for (const directory of [target, bin, home, tmp]) mkdirSync(directory, { mode: 0o700 });
const env = {
  PATH: `${bin}:/usr/bin:/bin`,
  HOME: home,
  TMPDIR: tmp,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_DATE: "2026-11-07T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-11-07T00:00:00Z",
  LANG: "en_US.UTF-8",
};
symlinkSync(scanner, join(bin, "trufflehog")); // Real binary, not a scanner wrapper.
const version = spawnSync(scanner, ["--version"], { env, encoding: "utf8" });
assert.equal(version.status, 0);
assert.equal(`${version.stdout}${version.stderr}`.trim(), "trufflehog 3.99.4");
const git = (...args) =>
  execFileSync("/usr/bin/git", args, {
    cwd: target,
    env,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
git("init", "-qb", "main");
git("config", "user.name", "Diagnostic proof");
git("config", "user.email", "proof@example.invalid");
git("config", "commit.gpgsign", "false");
writeFileSync(join(target, "README.md"), "Controlled invalid diagnostic canaries.\n");
git("add", ".");
git("commit", "-qm", "base");
const base = git("rev-parse", "HEAD");
for (let index = 0; index < count; index++) {
  // Construct disposable invalid URI-detector inputs only in this private fixture.
  // No raw input or scanner match is printed or retained in public evidence.
  const url = new URL(`https://diagnostic-${index}.invalid`);
  const canary = `DIAGNOSTIC_CANARY_${index}`;
  url.username = canary;
  // Reuse the explicit public canary marker; never embed a password literal.
  url.password = canary;
  writeFileSync(join(target, `canary-${index}.txt`), `${url}\n`, { mode: 0o600 });
}
git("add", ".");
git("commit", "-qm", "disposable invalid canaries");
const head = git("rev-parse", "HEAD");
git("branch", "candidate");
git("update-ref", "refs/pull/1/head", head);
git("update-ref", "refs/heads/main", base);
git("checkout", "-q", "candidate");
git("remote", "add", "origin", target); // All fetches stay local.

// These configured-repository/item selectors are entirely synthetic. Nothing is
// fetched from or published to that GitHub item. Unknown reads and all writes fail.
const issue = {
  number: 1,
  title: "Controlled diagnostic inventory proof",
  body: "Invalid disposable canaries; no real credentials.",
  html_url: "https://github.com/openclaw/clawsweeper/pull/1",
  created_at: "2026-11-07T00:00:00Z",
  updated_at: "2026-11-07T00:00:00Z",
  state: "open",
  locked: false,
  author_association: "CONTRIBUTOR",
  user: { login: "proof-author" },
  labels: [],
  pull_request: {},
};
const pull = {
  ...issue,
  draft: false,
  merged: false,
  head: { sha: head, ref: "candidate", repo: { full_name: "openclaw/clawsweeper" } },
  base: { sha: base, ref: "main", repo: { full_name: "openclaw/clawsweeper" } },
  commits: 1,
  changed_files: count,
  additions: count,
  deletions: 0,
  mergeable: true,
};
writeFileSync(
  join(bin, "gh"),
  `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--repo') args.splice(0, 2);
fs.appendFileSync(${JSON.stringify(join(root, "gh-calls.jsonl"))}, JSON.stringify(args) + '\\n');
if (args.includes('--method') || args.includes('-X')) process.exit(92);
const path = args.find(value => value.startsWith('repos/')) || args[1] || '';
let value;
if (args[0] === 'release') value = [];
else if (path === 'graphql') value = {data:{repository:{pr_1:{
  reviews:{totalCount:0,pageInfo:{hasNextPage:false},nodes:[]},
  reviewThreads:{totalCount:0,pageInfo:{hasNextPage:false},nodes:[]}
}}}};
else if (path === 'repos/openclaw/clawsweeper/pulls/1') value = ${JSON.stringify(pull)};
else if (path === 'repos/openclaw/clawsweeper/issues/1') value = ${JSON.stringify(issue)};
else if (['/comments','/timeline','/reviews','/commits','/files'].some(part => path.includes(part))) value = [];
else if (path === 'user') value = {login:'proof-author'};
else {fs.writeFileSync(${JSON.stringify(join(root, "unexpected-gh"))}, 'unexpected read'); process.exit(93);}
if (args.includes('-i')) process.stdout.write('HTTP/2.0 200 OK\\r\\ncontent-type: application/json\\r\\n\\r\\n');
console.log(JSON.stringify(args.includes('--slurp') ? [value] : value));
`,
  { mode: 0o700 },
);
const providerCalls = join(root, "provider-calls");
writeFileSync(
  join(bin, "codex"),
  `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(providerCalls)}, 'called\\n');
process.exit(86);
`,
  { mode: 0o700 },
);
const profile = join(root, "network-deny.sb");
writeFileSync(profile, "(version 1) (allow default) (deny network*)\n");
const sandbox = (args, extraEnv = {}, timeout = 120_000) =>
  spawnSync("/usr/bin/sandbox-exec", ["-f", profile, process.execPath, ...args], {
    cwd: target,
    env: { ...env, ...extraEnv },
    encoding: "utf8",
    timeout,
    maxBuffer: 2 ** 20,
  });
const probe = sandbox(
  [
    "-e",
    "require('node:net').createServer().on('error',e=>{console.log(e.code);process.exit(e.code==='EPERM'?0:1)}).listen(0,()=>process.exit(2))",
  ],
  {},
  5000,
);
assert.equal(probe.status, 0);
assert.equal(probe.stdout.trim(), "EPERM");
const artifacts = join(root, "artifacts");
const args = [
  join(source, "dist/clawsweeper.js"),
  "review",
  "--local-only",
  "--verbose",
  "--target-repo",
  "openclaw/clawsweeper",
  "--target-dir",
  target,
  "--item-number",
  "1",
  "--artifact-dir",
  artifacts,
  "--output-retention",
  "debug",
  "--codex-timeout-ms",
  "60000",
];
const execution = sandbox(args, {
  CODEX_BIN: join(bin, "codex"),
  CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS: "1",
  EXACT_REVIEW_ITEM_KEY: "openclaw/clawsweeper#1",
  // Synthetic provenance exercises the hosted inspector protocol, not Actions.
  GITHUB_REPOSITORY: "example/diagnostic-proof",
  GITHUB_RUN_ID: "1",
  GITHUB_RUN_ATTEMPT: "1",
});
// Private output is never echoed, including on assertion failure.
writeFileSync(join(root, "stdout.private.txt"), execution.stdout || "", { mode: 0o600 });
writeFileSync(join(root, "stderr.private.txt"), execution.stderr || "", { mode: 0o600 });
assert.equal(
  execution.status,
  79,
  "Expected terminal input-scan refusal; inspect only safe private metadata on failure.",
);
assert.equal(existsSync(providerCalls), false);
assert.equal(existsSync(join(root, "unexpected-gh")), false);
assert.equal(git("rev-parse", "HEAD"), head);
assert.equal(git("status", "--porcelain"), "");
const manifestPath = join(artifacts, "failure-diagnostics", "manifest.json");
const manifest = readFileSync(manifestPath);
const scan = JSON.parse(manifest).failure.scan;
assert.equal(scan.kind, "unclassified_finding");
assert.ok(["literal_not_reviewed", "material_not_reviewed"].includes(scan.reason));
assert.equal(scan.findingCount, count * 2);
assert.equal(scan.findingIndex, 0);
assert.equal(scan.detectorType, 17);
assert.equal(scan.decoder, "PLAIN");
assert.equal(scan.verified, false);
assert.equal(manifest.includes(Buffer.from("DIAGNOSTIC_CANARY")), false);
assert.equal(manifest.includes(Buffer.from(root)), false);
const inventory = scan.inventory;
assert.equal(
  Boolean(inventory),
  expected === "inventory",
  "Inventory presence must match the selected source contract.",
);
let inventorySummary = null;
if (inventory) {
  assert.equal(inventory.totalCount, scan.findingCount);
  assert.equal(inventory.retainedCount + inventory.omittedCount, inventory.totalCount);
  assert.equal(inventory.entries.length, inventory.retainedCount);
  assert.ok(inventory.retainedCount <= 16);
  assert.ok(inventory.entries.some((entry) => entry.findingIndex === scan.findingIndex));
  const formattedBytes = Buffer.byteLength(
    JSON.stringify({ failure: { scan: { inventory } } }, null, 2),
  );
  assert.ok(formattedBytes <= 6144);
  assert.equal(inventory.unattributedCount, 0);
  for (const entry of inventory.entries) assert.equal(entry.sourceAttribution, "unavailable");
  if (count === 2) assert.equal(inventory.retainedCount, 4);
  if (count === 12) assert.ok(inventory.omittedCount > 0);
  inventorySummary = {
    totalCount: inventory.totalCount,
    retainedCount: inventory.retainedCount,
    omittedCount: inventory.omittedCount,
    unattributedCount: inventory.unattributedCount,
    indices: inventory.entries.map((entry) => entry.findingIndex),
    formattedBytes,
    sourceAttribution: "unavailable",
  };
}
const inspections = [];
for (let index = 0; index < 2; index++) {
  const result = sandbox(
    [
      join(source, "scripts/inspect-input-scan-diagnostic.mjs"),
      "--inspect",
      manifestPath,
      "openclaw/clawsweeper",
      "pull_request",
      "1",
      head,
      "example/diagnostic-proof",
      "1",
      "1",
    ],
    {},
    10_000,
  );
  assert.equal(result.status, 0);
  writeFileSync(join(root, `inspection-${index}.json`), result.stdout, { mode: 0o600 });
  inspections.push(result.stdout);
}
assert.equal(inspections[0], inspections[1]);
assert.equal(readFileSync(manifestPath, "utf8"), manifest.toString());
assert.equal(existsSync(providerCalls), false);
const summary = {
  proof: "real-native-shipped-entry-manifest-inspector",
  node: process.version,
  scanner: { version: "3.99.4", binarySha256: scannerSha256 },
  fixture: { base, head, canaryFiles: count },
  exit: execution.status,
  scan: {
    kind: scan.kind,
    reason: scan.reason,
    findingCount: scan.findingCount,
    firstFindingIndex: scan.findingIndex,
    detectorType: scan.detectorType,
    decoder: scan.decoder,
    verified: scan.verified,
    inventory: inventorySummary,
  },
  providerCalls: 0,
  manifestSha256: sha256(manifest),
  inspectionSha256: sha256(inspections[0]),
  inspectionReplays: 2,
  identicalInspection: true,
  manifestUnchanged: true,
  networkDenied: {
    mechanism: "sandbox-exec deny network*",
    activeProbe: "EPERM",
    scannerArgumentsUnmodified: true,
  },
  limitations:
    "Local macOS controlled fixture; synthetic read-only GitHub transport and run identity, real unmodified native scanner. No provider, hosted queue, publication, fixture qualification, source-coordinate proof, deployment or maintainer approval.",
};
writeFileSync(join(root, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(summary, null, 2));
