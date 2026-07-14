import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { mockGhBinEnv } from "../helpers.ts";
import { assertCodexActionMatchesSchema } from "./codex-result-schema.ts";

test("commit finding intake emits a schema-valid build_fix_artifact action", () => {
  const root = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-commit-finding-"));
  const reportPath = path.join(tmp, "report.md");
  const ghPath = path.join(tmp, "gh.mjs");
  const sha = randomBytes(20).toString("hex");
  fs.writeFileSync(
    reportPath,
    [
      "---",
      "result: findings",
      "author: contributor",
      "---",
      "",
      "## Summary",
      "",
      "Repair the verified commit-level correctness regression.",
      "",
      "## Findings",
      "",
      "### High: preserve required repair action fields",
      "- Kind: correctness",
      "- File: `src/repair/example.ts`",
      "- Evidence: the deterministic result omitted a required action field",
      "- Impact: the generated action does not satisfy the worker result schema",
      "- Suggested fix: emit the required nullable field",
      "- Confidence: high",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    ghPath,
    [
      "const args = process.argv.slice(2);",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/commits/main') {",
      `  process.stdout.write('${"a".repeat(40)}\\n');`,
      "  process.exit(0);",
      "}",
      "process.stderr.write(`unexpected gh args: ${args.join(' ')}\\n`);",
      "process.exit(1);",
      "",
    ].join("\n"),
  );

  let output: Record<string, string> | undefined;
  try {
    output = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "dist/repair/commit-finding-intake.js",
          "prepare",
          "--target-repo",
          "openclaw/openclaw",
          "--commit-sha",
          sha,
          "--report-file",
          reportPath,
        ],
        {
          cwd: root,
          env: { ...process.env, ...mockGhBinEnv(ghPath, tmp) },
          encoding: "utf8",
        },
      ),
    );
    const result = JSON.parse(
      fs.readFileSync(path.join(root, output.result_path), "utf8"),
    ) as Record<string, unknown>;
    const actions = result.actions as Array<Record<string, unknown>>;

    assert.equal(actions[0]?.action, "build_fix_artifact");
    assert.equal(actions[0]?.depends_on, null);
    assertCodexActionMatchesSchema(actions[0]);
  } finally {
    for (const key of ["job_path", "audit_path", "run_dir"] as const) {
      const relativePath = output?.[key];
      if (relativePath) fs.rmSync(path.join(root, relativePath), { recursive: true, force: true });
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
