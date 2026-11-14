#!/usr/bin/env node
// Native admission proof. Run after building with pinned TruffleHog on PATH:
// node docs/proof/push-relay-fixture/run-proof.mjs --out <receipt.json>
// Optional --module-root points at a different built revision for comparison.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, platform, arch } from "node:os";
import { resolve, join, delimiter } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const out = args[args.indexOf("--out") + 1];
if (!args.includes("--out") || !out) throw new Error("--out <receipt.json> is required");
const moduleRoot = args.includes("--module-root")
  ? resolve(args[args.indexOf("--module-root") + 1])
  : process.cwd();
const { scanAgentInput } = await import(
  pathToFileURL(join(moduleRoot, "dist/agent-input-scan.js")).href
);
const { TRUFFLEHOG_VERSION } = await import(
  pathToFileURL(join(moduleRoot, "dist/review-tool-bootstrap.js")).href
);
const root = realpathSync(mkdtempSync(join(tmpdir(), "approved-values-proof-")));
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "proof",
  GIT_AUTHOR_EMAIL: "proof@example.invalid",
  GIT_COMMITTER_NAME: "proof",
  GIT_COMMITTER_EMAIL: "proof@example.invalid",
};
const git = (cwd, ...options) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...options], {
    cwd,
    env: gitEnv,
    encoding: "utf8",
  }).trim();
const raw = ["https", "://", "user", ":", "pass", "@", "relay.example.com"].join("");
const approved = raw + "/path";
const cases = [
  ["relay-reviewed", approved, true],
  ["relay-surrounding-edit", "// unrelated edit\n" + approved, true],
  ["relay-password-changed", approved.replace(":pass@", ":different-pass@"), false],
  ["relay-path-changed", approved + "x", false],
];
const results = [];
try {
  const scanner = execFileSync("trufflehog", ["--version"], { encoding: "utf8" }).trim();
  assert.equal(scanner, `trufflehog ${TRUFFLEHOG_VERSION}`);
  for (const [name, value, expected] of cases) {
    const cwd = join(root, name);
    mkdirSync(cwd);
    git(cwd, "init", "-q");
    writeFileSync(join(cwd, "fixture.txt"), "// before\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "base");
    const baseSha = git(cwd, "rev-parse", "HEAD");
    writeFileSync(join(cwd, "fixture.txt"), value + "\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "fixture");
    const headSha = git(cwd, "rev-parse", "HEAD");
    for (const surface of ["prompt", "committed"]) {
      let admitted = true,
        reason;
      try {
        scanAgentInput({
          cwd,
          prompt: surface === "prompt" ? value : "Review the fixture change.",
          source:
            surface === "prompt" ? { kind: "prompt" } : { kind: "committed", baseSha, headSha },
          timeoutMs: 60_000,
        });
      } catch (error) {
        admitted = false;
        reason = error.reason;
        // Infrastructure failures do not establish that the credential was detected.
        if (reason !== "findings") throw error;
      }
      results.push({ name, surface, expected, admitted, ...(reason ? { reason } : {}) });
    }
  }
  const scannerFile = process.env.PATH.split(delimiter)
    .map((dir) => join(dir, "trufflehog"))
    .find((file) => {
      try {
        return readFileSync(file).length > 0;
      } catch {
        return false;
      }
    });
  const receipt = {
    head: git(moduleRoot, "rev-parse", "HEAD"),
    platform: `${platform()}-${arch()}`,
    node: process.version,
    scanner,
    scannerSha256: createHash("sha256").update(readFileSync(scannerFile)).digest("hex"),
    sourceDirty: git(moduleRoot, "status", "--porcelain").length > 0,
    results,
    passed: results.every((r) => r.expected === r.admitted),
    limits:
      "Synthetic inputs and native admission only; no model call or live database authentication. Verification/error contracts additionally covered by focused tests.",
  };
  writeFileSync(resolve(out), JSON.stringify(receipt, null, 2) + "\n");
  console.log(
    JSON.stringify({ passed: receipt.passed, scenarios: results.length, head: receipt.head }),
  );
  assert.equal(receipt.passed, true, "admission differs from expected; inspect receipt");
} finally {
  rmSync(root, { recursive: true, force: true });
}
