import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = path.resolve(import.meta.dirname, "../../..");
const timeout = process.argv.includes("--timeout");
const baseline = process.argv.includes("--expect-missing-report");
const executor =
  process.env.PROOF_EXECUTOR ?? path.join(repo, "dist/repair/execute-fix-artifact.js");
const { writeFakeScanner } = await import(
  pathToFileURL(path.join(repo, "test/agent-input-scan-helpers.ts"))
);
fs.mkdirSync(path.join(repo, ".artifacts"), { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "full-executor-proof-"));
const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const gitConfig = path.join(scratch, "global.gitconfig");
fs.writeFileSync(gitConfig, "", { mode: 0o600 });
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd, ...args) =>
  execFileSync(realGit, args, {
    cwd,
    env: gitEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
try {
  const writer = path.join(scratch, "writer"),
    target = path.join(scratch, "target"),
    remote = path.join(scratch, "remote.git"),
    bin = path.join(scratch, "bin");
  fs.mkdirSync(writer);
  fs.mkdirSync(bin);
  writeFakeScanner(bin);
  git(writer, "init", "-b", "main");
  git(writer, "config", "user.name", "Synthetic fixture");
  git(writer, "config", "user.email", "fixture@example.invalid");
  fs.writeFileSync(path.join(writer, "README.md"), "base A\n");
  git(writer, "add", ".");
  git(writer, "-c", "commit.gpgsign=false", "commit", "-m", "fixture base A");
  git(scratch, "clone", "--bare", writer, remote);
  git(scratch, "--git-dir", remote, "config", "uploadpack.allowFilter", "true");
  git(scratch, "clone", "--filter=blob:none", pathToFileURL(remote).href, target);
  assert.equal(git(target, "config", "--get", "remote.origin.promisor"), "true");
  const oldHead = git(target, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(writer, "README.md"), "base B\n");
  git(writer, "add", ".");
  git(writer, "-c", "commit.gpgsign=false", "commit", "-m", "fixture base B");
  git(writer, "push", remote, "main");
  const fetchedHead = git(writer, "rev-parse", "HEAD");
  assert.notEqual(oldHead, fetchedHead);
  const capture = path.join(scratch, "capture.json");
  const missingCapture = path.join(scratch, "missing-blob.json");
  const newBlob = git(writer, "rev-parse", `${fetchedHead}:README.md`);
  fs.writeFileSync(
    path.join(bin, "git"),
    `#!/bin/sh\nexec '${process.execPath}' '${path.join(bin, "git.cjs")}' "$@"\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "git.cjs"),
    `const {spawnSync}=require('node:child_process'),fs=require('node:fs');const args=process.argv.slice(2).map(x=>x==='https://github.com/openclaw/fixture.git'?${JSON.stringify(pathToFileURL(remote).href)}:x);if(args.includes('push')||args.some(x=>/^https?:/.test(x)))throw Error('unexpected publication/network Git');const r=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit',env:process.env});if(r.status===0&&args.includes('fetch')&&args.includes('--filter=blob:none')&&!args.includes('--no-filter')){const probe=spawnSync(${JSON.stringify(realGit)},['--git-dir='+${JSON.stringify(path.join(target, ".git"))},'-c','protocol.allow=never','cat-file','-e',${JSON.stringify(newBlob)}],{stdio:'pipe',env:{...process.env,GIT_NO_LAZY_FETCH:'1'}});fs.writeFileSync(${JSON.stringify(missingCapture)},JSON.stringify({missing:probe.status!==0}));}process.exit(r.status??1);`,
  );
  const gh = path.join(bin, "gh.cjs");
  fs.writeFileSync(
    gh,
    `const a=process.argv.slice(2);if(a[0]==='api'&&a[1].includes('/git/ref/')){console.error('Not Found (HTTP 404)');process.exit(1)}if(a[0]==='pr'&&a[1]==='list'){console.log(a.includes('--jq')?'':'[]');process.exit(0)}console.error('unexpected gh '+JSON.stringify(a));process.exit(1);`,
  );
  const codex = path.join(bin, "codex");
  fs.writeFileSync(
    codex,
    `#!${process.execPath}\nconst fs=require('node:fs'),{execFileSync}=require('node:child_process');const a=process.argv.slice(2);if(a.includes('--version')){console.log('codex-cli 0.153.3');process.exit(0)}const prompt=fs.readFileSync(0,'utf8');if(prompt.startsWith('Fix the current repair patch so the changed-surface validation gate passes.')){if(${timeout}){setInterval(()=>{},1000);}else{process.exit(1);}return;}fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({head:execFileSync(${JSON.stringify(realGit)},['rev-parse','HEAD'],{encoding:'utf8'}).trim(),branch:execFileSync(${JSON.stringify(realGit)},['symbolic-ref','--short','HEAD'],{encoding:'utf8'}).trim(),source:fs.readFileSync('README.md','utf8')}));fs.writeFileSync('README.md','synthetic repair with trailing whitespace \\n');fs.writeFileSync(a[a.indexOf('--output-last-message')+1],'Synthetic repair ready for validation.');`,
    { mode: 0o755 },
  );
  const job = path.join(scratch, "job.md"),
    result = path.join(scratch, "result.json");
  fs.writeFileSync(
    job,
    '---\nrepo: openclaw/fixture\ncluster_id: fresh-base-fixture\nmode: autonomous\nsource: manual\nallowed_actions: [fix, raise_pr]\nallow_fix_pr: true\ncandidates: ["#1"]\ncanonical: ["#1"]\n---\nSynthetic local proof\n',
  );
  fs.writeFileSync(
    result,
    JSON.stringify({
      repo: "openclaw/fixture",
      cluster_id: "fresh-base-fixture",
      mode: "autonomous",
      actions: [{ action: "fix_needed", target: "#1", status: "planned" }],
      fix_artifact: {
        summary: "Synthetic proof",
        pr_title: "fix: synthetic proof",
        pr_body: "Synthetic local proof",
        affected_surfaces: ["docs"],
        likely_files: ["README.md"],
        linked_refs: ["https://github.com/openclaw/fixture/issues/1"],
        validation_commands: ["git diff --check"],
        credit_notes: ["Synthetic local fixture"],
        changelog_required: false,
        repair_strategy: "new_fix_pr",
        source_prs: [],
      },
    }),
  );
  const child = spawnSync(
    process.execPath,
    [executor, job, result, "--target-dir", target, "--defer-publication"],
    {
      encoding: "utf8",
      timeout: timeout ? 360000 : 120000,
      env: {
        PATH: bin + path.delimiter + process.env.PATH,
        HOME: scratch,
        TMPDIR: process.env.TMPDIR,
        GIT_CONFIG_GLOBAL: gitConfig,
        GIT_CONFIG_NOSYSTEM: "1",
        GH_BIN: process.execPath,
        GH_BIN_ARGS: JSON.stringify([gh]),
        CODEX_BIN: codex,
        GH_TOKEN: "synthetic-proof",
        GITHUB_TOKEN: "",
        CLAWSWEEPER_ALLOW_EXECUTE: "1",
        CLAWSWEEPER_ALLOW_FIX_PR: "1",
        CLAWSWEEPER_ALLOWED_OWNER: "openclaw",
        CLAWSWEEPER_MODEL: "codex",
        CLAWSWEEPER_INSTALL_TARGET_DEPS: "0",
        CLAWSWEEPER_BRANCH_PUSH_SETTLE_SECONDS: "0",
        CLAWSWEEPER_CLOSE_SUPERSEDED_SOURCE_PRS: "0",
        CLAWSWEEPER_FIX_EDIT_ATTEMPTS: "1",
        CLAWSWEEPER_FIX_CODEX_TIMEOUT_MS: "300000",
        CLAWSWEEPER_ACTION_LEDGER_DISABLED: "1",
      },
    },
  );
  fs.writeFileSync(
    path.join(
      repo,
      ".artifacts",
      `validation-fix-${baseline ? "baseline" : timeout ? "timeout" : "failed"}.log`,
    ),
    child.stdout + child.stderr,
  );
  assert.ok(fs.existsSync(capture), child.stdout + child.stderr);
  const seen = JSON.parse(fs.readFileSync(capture, "utf8"));
  assert.equal(seen.head, fetchedHead);
  assert.equal(seen.branch, "clawsweeper/fresh-base-fixture");
  assert.equal(seen.source, "base B\n");
  assert.equal(JSON.parse(fs.readFileSync(missingCapture, "utf8")).missing, true);
  const reportPath = path.join(scratch, "fix-execution-report.json");
  assert.equal(child.status, 1, child.stdout + child.stderr);
  if (baseline) {
    assert.equal(fs.existsSync(reportPath), false);
    assert.match(child.stderr, /Codex validation-fix worker failed/);
  } else {
    assert.equal(fs.existsSync(reportPath), true, child.stdout + child.stderr);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.status, "blocked");
    assert.match(
      report.reason,
      timeout
        ? /Codex validation-fix worker timed out after 300000ms/
        : /Codex validation-fix worker failed/,
    );
    assert.equal(report.actions.at(-1).requeue_required, true);
  }
  const receipt = {
    entrypoint: "dist/repair/execute-fix-artifact.js",
    result: "passed",
    scenario: timeout ? "real five-minute worker timeout" : "empty-output worker failure",
    baseline,
    terminal_report_written: fs.existsSync(reportPath),
    exit_code: child.status,
    production_mutations: 0,
    limits:
      "Full built executor and real Git/validation/process execution; local GitHub/scanner/model adapters. No live provider or production repair is claimed.",
  };
  receipt.head = git(repo, "rev-parse", "HEAD");
  receipt.runtime = process.version;
  receipt.executor_source_sha256 = createHash("sha256")
    .update(
      baseline
        ? git(
            repo,
            "show",
            "d47259a07a62294e032018259aaf117ef12ed4fe:src/repair/execute-fix-artifact.ts",
          ) + "\n"
        : fs.readFileSync(path.join(repo, "src/repair/execute-fix-artifact.ts")),
    )
    .digest("hex");
  receipt.executor_build_sha256 = createHash("sha256")
    .update(fs.readFileSync(executor))
    .digest("hex");
  fs.writeFileSync(
    path.join(
      repo,
      ".artifacts",
      `validation-fix-${baseline ? "baseline" : timeout ? "timeout" : "failed"}.json`,
    ),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
