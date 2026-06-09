import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = process.cwd();

test("run-worker starts Codex in the target checkout when one is available", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-run-worker-"));
  const fakeBin = path.join(tmp, "bin");
  const targetCheckout = path.join(tmp, "target-openclaw");
  const cwdFile = path.join(tmp, "codex-cwd.txt");
  const argsFile = path.join(tmp, "codex-args.json");
  const jobName = `run-worker-target-checkout-${path.basename(tmp)}`;
  const jobPath = path.join(tmp, `${jobName}.md`);

  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(targetCheckout, { recursive: true });
  fs.writeFileSync(path.join(targetCheckout, "target-marker.txt"), "target\n");
  fs.writeFileSync(
    path.join(fakeBin, "gh"),
    [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw') {",
      "  process.stdout.write(JSON.stringify({ default_branch: 'main' }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/branches/main') {",
      "  process.stdout.write(JSON.stringify({ commit: { sha: '1111111111111111111111111111111111111111' } }));",
      "  process.exit(0);",
      "}",
      "process.stderr.write(`unexpected gh args: ${args.join(' ')}\\n`);",
      "process.exit(1);",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(fakeBin, "codex"),
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "fs.writeFileSync(process.env.FAKE_CODEX_CWD_FILE, process.cwd());",
      "fs.writeFileSync(process.env.FAKE_CODEX_ARGS_FILE, JSON.stringify(process.argv.slice(2)));",
      "if (process.env.CLAWSWEEPER_INTERNAL_MODEL) process.exit(9);",
      "const outputIndex = process.argv.indexOf('--output-last-message');",
      "const outputPath = process.argv[outputIndex + 1];",
      "const result = {",
      "  status: 'planned',",
      "  repo: 'openclaw/openclaw',",
      "  cluster_id: 'clawsweeper-run-worker-target-checkout',",
      "  mode: 'plan',",
      "  summary: 'fake codex result',",
      "  actions: [],",
      "  needs_human: [],",
      "  canonical: null,",
      "  canonical_issue: null,",
      "  canonical_pr: null,",
      "  merge_preflight: [],",
      "  fix_artifact: null,",
      "};",
      "fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\\n`);",
      'process.stdout.write("s".repeat(2 * 1024 * 1024));',
      'process.stdout.write(\'{"type":"fake"}\\n\');',
      'process.stderr.write("e".repeat(2 * 1024 * 1024));',
    ].join("\n"),
    { mode: 0o755 },
  );

  fs.writeFileSync(
    jobPath,
    [
      "---",
      "repo: openclaw/openclaw",
      "cluster_id: clawsweeper-run-worker-target-checkout",
      "mode: plan",
      "allowed_actions:",
      "  - fix",
      "source: clawsweeper_commit",
      "commit_sha: 1111111111111111111111111111111111111111",
      "security_policy: central_security_only",
      "security_sensitive: false",
      "---",
      "Plan only.",
      "",
    ].join("\n"),
  );

  try {
    execFileSync(process.execPath, ["dist/repair/run-worker.js", jobPath, "--mode", "plan"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CLAWSWEEPER_TARGET_CHECKOUT: targetCheckout,
        FAKE_CODEX_CWD_FILE: cwdFile,
        FAKE_CODEX_ARGS_FILE: argsFile,
        CLAWSWEEPER_INTERNAL_MODEL: "secret-model-for-test",
        CLAWSWEEPER_CODEX_STDIO_MAX_BUFFER_MB: "1",
        CLAWSWEEPER_STEERABLE_CODEX: "0",
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      stdio: "pipe",
    });

    assert.equal(fs.readFileSync(cwdFile, "utf8"), fs.realpathSync(targetCheckout));
    const args = JSON.parse(fs.readFileSync(argsFile, "utf8"));
    assert.equal(args[args.indexOf("--cd") + 1], targetCheckout);
    assert.equal(args.includes("--model"), false);
    assert.equal(args.includes("secret-model-for-test"), false);
    const runDirs = fs.globSync(path.join(repoRoot, `.clawsweeper-repair/runs/${jobName}-plan-*`));
    assert.equal(runDirs.length, 1);
    const runDir = runDirs[0];
    assert.ok(runDir);
    assert.ok(fs.statSync(path.join(runDir, "codex.jsonl")).size > 2 * 1024 * 1024);
    assert.equal(fs.statSync(path.join(runDir, "codex.stderr.log")).size, 2 * 1024 * 1024);
  } finally {
    for (const runDir of fs.globSync(
      path.join(repoRoot, `.clawsweeper-repair/runs/${jobName}-plan-*`),
    )) {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
