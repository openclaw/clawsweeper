import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";

// Before publication, pass a published commit with byte-identical helper content.
// After pushing, omit the argument to prove the current committed head's raw URL.
const root = resolve(".");
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const helperRef = process.argv[2] ?? head;
const scratch = mkdtempSync(join(tmpdir(), "control-plane-checkout-"));
const output = resolve(".artifacts/control-plane-checkout-proof.txt");
const transcript = [];
const record = (line) => {
  console.log(line);
  transcript.push(line);
};
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const source = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
const action = ".github/actions/setup-pnpm/action.yml";
try {
  record(
    `provider=local-git-shell; head=${head}; helper_ref=${helperRef}; Node=${process.version}`,
  );
  const old = join(scratch, "old");
  git(root, "clone", "--shared", "--no-checkout", "--quiet", source, old);
  git(old, "sparse-checkout", "set", "--no-cone", "scripts/control-plane-curl.sh");
  git(old, "checkout", "--force", "--detach", head);
  // actions/checkout's subsequent clean/reset/fetch/checkout does not disable sparse mode.
  git(old, "clean", "-ffdx");
  git(old, "reset", "--hard", "HEAD");
  git(old, "fetch", "--quiet", "origin", head);
  git(old, "checkout", "--force", "--detach", head);
  assert.equal(git(old, "config", "--bool", "core.sparseCheckout"), "true");
  assert.equal(existsSync(join(old, action)), false);
  record(
    `OLD: sparse-checkout set --no-cone scripts/control-plane-curl.sh; checkout; clean/reset/fetch/checkout => core.sparseCheckout=true; ${action}=MISSING`,
  );

  for (const file of ["sweep.yml", "exact-review-reconcile-run.yml"]) {
    const workflow = parse(readFileSync(join(root, ".github/workflows", file), "utf8"));
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      const bootstrap = job.steps?.find((step) => step.name === "Fetch control-plane retry helper");
      if (!bootstrap) continue;
      const workspace = join(scratch, jobName);
      const runnerTemp = join(scratch, `${jobName}-temp`);
      mkdirSync(runnerTemp);
      git(root, "clone", "--shared", "--no-checkout", "--quiet", source, workspace);
      const configBefore = git(workspace, "config", "--local", "--list");
      execFileSync("bash", ["-c", bootstrap.run], {
        cwd: workspace,
        env: {
          ...process.env,
          RUNNER_TEMP: runnerTemp,
          GITHUB_REPOSITORY: "openclaw/clawsweeper",
          GITHUB_SHA: helperRef,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      assert.equal(git(workspace, "config", "--local", "--list"), configBefore);
      const downloaded = readFileSync(join(runnerTemp, "control-plane-curl.sh"));
      assert.deepEqual(downloaded, readFileSync(join(root, "scripts/control-plane-curl.sh")));
      git(workspace, "checkout", "--force", "--detach", head);
      assert.ok(existsSync(join(workspace, action)));
      assert.equal(git(workspace, "ls-files", "-t", action), `H ${action}`);
      record(
        `NEW ${file}:${jobName}: actual bootstrap curl --retry 3 + source succeeded; Git config unchanged; full checkout => ${action}=PRESENT; helper_sha256=${createHash("sha256").update(downloaded).digest("hex")}`,
      );
    }
  }
  record(
    "PASS; limits=Git checkout shell simulation, not act or hosted Actions; raw helper downloads only; no live control-plane calls.",
  );
} finally {
  mkdirSync(resolve(".artifacts"), { recursive: true });
  writeFileSync(output, `${transcript.join("\n")}\n`);
  rmSync(scratch, { recursive: true, force: true });
}
