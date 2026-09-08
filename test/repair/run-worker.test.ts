import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeFakeScanner } from "../agent-input-scan-helpers.ts";

const repoRoot = process.cwd();

test("repair output schema keeps every strict object property required", () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "schema/repair/codex-result.schema.json"), "utf8"),
  );

  const visit = (value: unknown, location: string): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const node = value as Record<string, unknown>;
    if (node.type === "object" && node.additionalProperties === false) {
      const properties = Object.keys((node.properties ?? {}) as Record<string, unknown>).sort();
      const required = Array.isArray(node.required) ? node.required.map(String).sort() : [];
      assert.deepEqual(required, properties, `${location} must require every declared property`);
    }
    for (const [key, child] of Object.entries(node)) {
      if (Array.isArray(child)) {
        child.forEach((entry, index) => visit(entry, `${location}.${key}[${index}]`));
      } else {
        visit(child, `${location}.${key}`);
      }
    }
  };

  visit(schema, "schema");
});

for (const admission of ["clean", "invalid-output", "dry-run"])
  test(`run-worker ${admission} preserves the target and prompt artifact contract`, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-run-worker-"));
    const fakeBin = path.join(tmp, "bin");
    const targetCheckout = path.join(tmp, "target-openclaw");
    const cwdFile = path.join(tmp, "codex-cwd.txt");
    const argsFile = path.join(tmp, "codex-args.json");
    const inputFile = path.join(tmp, "codex-input.txt");
    const jobName = `run-worker-target-checkout-${path.basename(tmp)}`;
    const jobPath = path.join(tmp, `${jobName}.md`);

    fs.mkdirSync(fakeBin, { recursive: true });
    writeFakeScanner(
      fakeBin,
      `
const runs = fs.readdirSync(${JSON.stringify(path.join(repoRoot, ".clawsweeper-repair/runs"))});
for (const run of runs.filter(name => name.startsWith(${JSON.stringify(`${jobName}-plan-`)}))) {
  assert.equal(fs.existsSync(path.join(${JSON.stringify(path.join(repoRoot, ".clawsweeper-repair/runs"))}, run, 'prompt.md')), false);
}
${admission === "invalid-output" ? "process.exit(183);" : admission === "dry-run" ? "throw new Error('dry run must not invoke scanner');" : ""}
`,
    );
    fs.mkdirSync(targetCheckout, { recursive: true });
    fs.writeFileSync(path.join(targetCheckout, "target-marker.txt"), "target\n");
    const ghPath = path.join(fakeBin, "gh.mjs");
    fs.writeFileSync(
      ghPath,
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
        `fs.writeFileSync(${JSON.stringify(inputFile)}, fs.readFileSync(0));`,
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
      const originalJob = fs.readFileSync(jobPath, "utf8");
      const run = () =>
        execFileSync(
          process.execPath,
          [
            "dist/repair/run-worker.js",
            jobPath,
            "--mode",
            "plan",
            ...(admission === "dry-run" ? ["--dry-run"] : []),
          ],
          {
            cwd: repoRoot,
            env: {
              ...process.env,
              PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
              CLAWSWEEPER_TARGET_CHECKOUT: targetCheckout,
              FAKE_CODEX_CWD_FILE: cwdFile,
              FAKE_CODEX_ARGS_FILE: argsFile,
              CLAWSWEEPER_INTERNAL_MODEL: "secret-model-for-test",
              CLAWSWEEPER_CODEX_STDIO_MAX_BUFFER_MB: "1",
              CLAWSWEEPER_CODEX_PLANNER_SANDBOX: "danger-full-access",
              CLAWSWEEPER_STEERABLE_CODEX: "0",
              CODEX_BIN: path.join(fakeBin, "codex"),
              GH_BIN: process.execPath,
              GH_BIN_ARGS: JSON.stringify([ghPath]),
            },
            stdio: "pipe",
          },
        );
      if (admission === "invalid-output")
        assert.throws(run, /Agent input scan refused: scanner_failed/);
      else run();
      assert.equal(fs.readFileSync(jobPath, "utf8"), originalJob);
      const runDirs = fs.globSync(
        path.join(repoRoot, `.clawsweeper-repair/runs/${jobName}-plan-*`),
      );
      assert.equal(runDirs.length, 1);
      const runDir = runDirs[0];
      assert.ok(runDir);
      const diagnosticPromptPath = path.join(runDir, "prompt.md");
      if (admission === "invalid-output") {
        assert.equal(fs.existsSync(cwdFile), false);
        assert.equal(fs.existsSync(diagnosticPromptPath), false);
        return;
      }
      const diagnosticPrompt = fs.readFileSync(diagnosticPromptPath, "utf8");
      assert.match(diagnosticPrompt, /Plan only\./);
      assert.equal(fs.statSync(diagnosticPromptPath).mode & 0o777, 0o600);
      if (admission === "dry-run") {
        assert.equal(fs.existsSync(cwdFile), false);
        const dryResult = JSON.parse(fs.readFileSync(path.join(runDir, "result.json"), "utf8"));
        assert.equal(path.resolve(repoRoot, dryResult.prompt_path), diagnosticPromptPath);
        return;
      }
      assert.equal(diagnosticPrompt, fs.readFileSync(inputFile, "utf8"));
      assert.equal(fs.readFileSync(cwdFile, "utf8"), fs.realpathSync(targetCheckout));
      const args = JSON.parse(fs.readFileSync(argsFile, "utf8"));
      assert.deepEqual(args, [
        "exec",
        "--cd",
        targetCheckout,
        "--sandbox",
        "danger-full-access",
        "-c",
        'approval_policy="never"',
        "-c",
        'forced_login_method="api"',
        "-c",
        'model_reasoning_effort="high"',
        "-c",
        'service_tier="fast"',
        "--output-schema",
        path.join(repoRoot, "schema/repair/codex-result.schema.json"),
        "--output-last-message",
        path.join(runDir, "result.json"),
        "--json",
        "-",
      ]);
      assert.equal(args.includes("secret-model-for-test"), false);
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
