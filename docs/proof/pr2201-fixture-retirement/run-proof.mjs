import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { scanAgentInput } from "../../../dist/agent-input-scan.js";
import { TRUFFLEHOG_VERSION } from "../../../dist/review-tool-bootstrap.js";

const [target, base, head, output] = process.argv.slice(2);
if (!target || !base || !head || !output) throw new Error("checkout base head receipt required");
const owner = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const root = mkdtempSync(join(tmpdir(), "fixture-retirement-proof-"));
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "proof",
  GIT_AUTHOR_EMAIL: "proof@example.invalid",
  GIT_COMMITTER_NAME: "proof",
  GIT_COMMITTER_EMAIL: "proof@example.invalid",
};
const git = (cwd, ...args) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env });
const results = [];
const run = (name, cwd, from, to, expected) => {
  let admitted = true;
  let reason;
  try {
    scanAgentInput({
      cwd,
      prompt: "Controlled fixture retirement proof. No model call.",
      source: { kind: "committed", baseSha: from, headSha: to },
      timeoutMs: 120_000,
    });
  } catch (error) {
    if (error.reason !== "findings") throw error;
    admitted = false;
    reason = error.reason;
  }
  results.push({ name, admitted, expected, ...(reason ? { reason } : {}) });
};
try {
  const scanner = execFileSync("trufflehog", ["--version"], { encoding: "utf8" }).trim();
  assert.equal(scanner, `trufflehog ${TRUFFLEHOG_VERSION}`);
  assert.equal(git(target, "rev-parse", "HEAD").toString().trim(), head);
  assert.equal(git(target, "status", "--porcelain").length, 0);
  run("complete-pr-range", target, base, head, true);
  const path = "test/agent-input-scan-mcp-apps.test.ts";
  const original = git(target, "show", `${base}:${path}`);
  for (const [name, source, bytes, expected] of [
    ["exact-fixture", path, original, true],
    ["changed-source", path, Buffer.concat([original, Buffer.from("\n// changed\n")]), false],
    ["changed-value", path, Buffer.from(original.toString().replaceAll("user:pass@", "user:unreviewed-password@")), false],
    ["different-path", "test/unreviewed.test.ts", original, false],
  ]) {
    const cwd = join(root, name);
    mkdirSync(cwd);
    git(cwd, "init", "-q");
    writeFileSync(join(cwd, "before"), "before\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "before");
    const from = git(cwd, "rev-parse", "HEAD").toString().trim();
    mkdirSync(dirname(join(cwd, source)), { recursive: true });
    writeFileSync(join(cwd, source), bytes);
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "fixture");
    const to = git(cwd, "rev-parse", "HEAD").toString().trim();
    run(name, cwd, from, to, expected);
  }
  const binary = process.env.PATH.split(delimiter).map((dir) => join(dir, "trufflehog")).find((file) => {
    try { return readFileSync(file).length > 0; } catch { return false; }
  });
  const receipt = {
    head: git(owner, "rev-parse", "HEAD").toString().trim(),
    sourceDirty: git(owner, "status", "--porcelain").length > 0,
    targetHead: head,
    targetBase: base,
    node: process.version,
    platform: process.platform + "-" + process.arch,
    scanner,
    scannerSha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
    results,
    passed: results.every((result) => result.admitted === result.expected),
    limits: "Synthetic fixture admission and refusal only; controlled prompt; no hosted hydrated context or model execution.",
  };
  writeFileSync(resolve(output), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt));
  assert.equal(receipt.passed, true);
} finally {
  rmSync(root, { recursive: true, force: true });
}
