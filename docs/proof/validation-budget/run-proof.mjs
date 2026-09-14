import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareTargetToolchain, runAllowedValidationCommands } from "../../../dist/repair/target-validation.js";
import { validationRecoveryRequired } from "../../../dist/repair/validation-recovery.js";
import { repairTargetValidationTimeoutMs } from "../../../dist/repair/execute-fix-timeout-budget.js";
import { resolveTargetRepoToolchain } from "../../../dist/repair/target-toolchain-config.js";

assert.equal(process.platform, "linux", "proof requires the production Linux containment path");
assert.equal(process.env.NODE_TEST_CONTEXT, undefined, "proof must use real containment");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "validation-budget-proof-"));
const inconclusiveIdentity = process.argv.includes("--inconclusive-identity");
const timingSummary = process.argv.includes("--timing-summary");
const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const trace = { head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), platform: process.platform, node: process.version, scenarios: [] };
let retainCheckout = false;
let recovery;
try {
  for (const [repo, expected] of [["openclaw/openclaw", 1_500_000], ["openclaw/clawsweeper", 480_000], ["openclaw/clawhub", 480_000]]) {
    const actual = repairTargetValidationTimeoutMs({}, resolveTargetRepoToolchain(repo).validationTimeoutMs);
    assert.equal(actual, expected);
    trace.scenarios.push({ repo, budgetMs: actual });
  }
  git("init", "-b", "main");
  git("config", "user.name", "Validation fixture");
  git("config", "user.email", "fixture@example.invalid");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".artifacts/\nnode_modules/\n");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ private: true, packageManager: "pnpm@12.4.1", scripts: { "check:changed": "node check.cjs" } }));
  execFileSync("pnpm", ["install", "--lockfile-only"], { cwd: dir, stdio: "pipe" });
  fs.writeFileSync(path.join(dir, "check.cjs"), `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
if (${timingSummary}) {
  if (!process.argv.includes("--timed")) process.exit(2);
  console.log("  99s ok typecheck core");
  console.error("[check:changed] summary\\n  1.25s ok typecheck core\\n  40ms ok typecheck core tests\\n  2.50s ok lint core changed files\\n  3ms ok lint core changed file\\n  99s ok unrelated output");
  process.exit(0);
}
fs.mkdirSync(".artifacts/dist-artifacts.lock", { recursive: true });
fs.writeFileSync(".artifacts/dist-artifacts.lock/owner.json", JSON.stringify({ pid: process.pid }));
if (${inconclusiveIdentity}) fs.unlinkSync(".git/HEAD");
process.on("SIGTERM", () => {});
const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); console.log("detached child ready"); setTimeout(() => require("node:fs").writeFileSync(".artifacts/escaped", "escaped"), 6000); setInterval(() => {}, 1000);'], { detached: true, stdio: "inherit" });
console.log("changed gate ready");
setInterval(() => {}, 1000);
`);
  git("add", ".");
  git("commit", "-m", "fixture");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  const savedHead = fs.readFileSync(path.join(dir, ".git/HEAD"));
  prepareTargetToolchain(dir, {
    targetRepo: "openclaw/openclaw", allowExpensiveValidation: false,
    installTargetDeps: true, strictTargetValidation: false,
    pinnedBaseRef: "origin/main",
  });
  const before = git("status", "--porcelain");
  const start = performance.now();
  if (timingSummary) {
    const messages = [];
    const originalLog = console.log;
    console.log = (message) => messages.push(message);
    try {
      assert.deepEqual(runAllowedValidationCommands(["pnpm check:changed"], dir, {
        targetRepo: "openclaw/openclaw", allowExpensiveValidation: false,
        installTargetDeps: false, strictTargetValidation: false,
        pinnedBaseRef: "origin/main", logOpenClawTimingSummary: true,
      }), ["pnpm check:changed"]);
    } finally {
      console.log = originalLog;
    }
    assert.deepEqual(messages, [
      "[target-validation] 1.25s ok typecheck core",
      "[target-validation] 40ms ok typecheck core tests",
      "[target-validation] 2.50s ok lint core changed files",
      "[target-validation] 3ms ok lint core changed file",
    ]);
    assert.equal(git("status", "--porcelain"), before);
    trace.scenarios.push({ command: "pnpm check:changed --timed", result: "passed", timingRows: messages, identityUnchanged: true });
  } else {
  let observed;
  try {
    runAllowedValidationCommands(["pnpm check:changed"], dir, {
      targetRepo: "openclaw/openclaw", allowExpensiveValidation: false,
      installTargetDeps: false, strictTargetValidation: false,
      pinnedBaseRef: "origin/main", validationTimeoutMs: 4_000,
    });
    assert.fail("expected a timeout");
  } catch (error) {
    recovery = validationRecoveryRequired(error);
    retainCheckout = Boolean(recovery);
    observed = error.message;
    assert.match(observed, /command timed out after/);
    assert.match(observed, /detached child ready/);
    if (inconclusiveIdentity) {
      assert.match(observed, /^command timed out after/);
      assert.match(observed, /Post-timeout checkout identity verification failed/);
      assert.ok(recovery?.cause instanceof AggregateError);
      assert.equal(recovery.cause.errors.length, 2);
      assert.ok(recovery.recoveryPaths.has(dir));
      assert.throws(() => runAllowedValidationCommands(["pnpm check:changed"], dir, {
        targetRepo: "openclaw/openclaw", allowExpensiveValidation: false,
        installTargetDeps: false, strictTargetValidation: false,
      }), /do not retry this checkout/);
    } else {
      assert.doesNotMatch(observed, /unsafe validation command|recovery required/i);
    }
  }
  const elapsedMs = Math.round(performance.now() - start);
  assert.equal(fs.existsSync(path.join(dir, ".artifacts/dist-artifacts.lock")), false);
  await new Promise((resolve) => setTimeout(resolve, 6_500));
  assert.equal(fs.existsSync(path.join(dir, ".artifacts/escaped")), false);
  if (inconclusiveIdentity) fs.writeFileSync(path.join(dir, ".git/HEAD"), savedHead);
  assert.equal(git("status", "--porcelain"), before);
  trace.scenarios.push({ command: "pnpm check:changed", elapsedMs, result: "timeout", lockRemoved: true, detachedChildReaped: true, identityUnchanged: !inconclusiveIdentity, recoveryRequired: Boolean(recovery), diagnostic: observed });
  }
  process.stdout.write(`${JSON.stringify(trace, null, 2)}\n`);
  if (process.argv[2]) fs.writeFileSync(process.argv[2], `${JSON.stringify(trace, null, 2)}\n`);
  // The fixture has verified process termination and restored its deliberate
  // HEAD damage. Dispose only this proof's retained recovery state.
  for (const root of recovery?.recoveryPaths ?? []) {
    if (root !== dir) fs.rmSync(root, { recursive: true, force: true });
  }
  retainCheckout = false;
} finally {
  if (!retainCheckout) fs.rmSync(dir, { recursive: true, force: true });
}
