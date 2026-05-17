import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { enforceValidationFixScope } from "../../dist/repair/validation-fix-scope.js";

test("scope guard reverts files Codex modified outside the allowed set", () => {
  const cwd = repoFixture({
    "in-scope.ts": "// in scope\n",
    "out-of-scope.ts": "// pristine\n",
  });
  const baseSha = git(cwd, "rev-parse", "HEAD");

  // Simulate the repair pass: modify the in-scope file, commit it.
  fs.writeFileSync(path.join(cwd, "in-scope.ts"), "// repaired by initial pass\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial repair");

  // Simulate the validation-fix Codex pass: touches BOTH in-scope and
  // out-of-scope (the scope creep we want to guard against). Leave the
  // edits uncommitted, matching the real worker flow.
  fs.writeFileSync(path.join(cwd, "in-scope.ts"), "// further validation-fix tweak\n");
  fs.writeFileSync(
    path.join(cwd, "out-of-scope.ts"),
    "// drive-by edit Codex shouldn't have made\n",
  );

  const result = enforceValidationFixScope({
    targetDir: cwd,
    baseBranch: baseSha,
    allowedFiles: ["in-scope.ts"],
  });

  assert.deepEqual(result.reverted_files, ["out-of-scope.ts"]);
  assert.equal(fs.readFileSync(path.join(cwd, "out-of-scope.ts"), "utf8"), "// pristine\n");
  assert.equal(
    fs.readFileSync(path.join(cwd, "in-scope.ts"), "utf8"),
    "// further validation-fix tweak\n",
  );
});

test("scope guard removes files Codex newly created outside the allowed set", () => {
  const cwd = repoFixture({ "kept.ts": "// kept\n" });
  const baseSha = git(cwd, "rev-parse", "HEAD");

  // Codex hallucinates a new file the reviewer never asked for.
  fs.writeFileSync(path.join(cwd, "hallucinated.ts"), "// nope\n");

  const result = enforceValidationFixScope({
    targetDir: cwd,
    baseBranch: baseSha,
    allowedFiles: [],
  });

  assert.deepEqual(result.reverted_files, ["hallucinated.ts"]);
  assert.equal(fs.existsSync(path.join(cwd, "hallucinated.ts")), false);
});

test("scope guard allows likely_files globs to widen the in-scope set", () => {
  const cwd = repoFixture({
    "src/foo.ts": "// foo\n",
    "src/foo.test.ts": "// foo test pristine\n",
  });
  const baseSha = git(cwd, "rev-parse", "HEAD");

  // Codex edits a test file that wasn't in the pre-validation-fix snapshot
  // but is allowed by the reviewer's `likely_files` glob.
  fs.writeFileSync(path.join(cwd, "src/foo.test.ts"), "// foo test updated by codex\n");

  const result = enforceValidationFixScope({
    targetDir: cwd,
    baseBranch: baseSha,
    allowedFiles: [], // empty snapshot — only the glob saves it
    likelyFiles: ["src/**/*.test.ts"],
  });

  assert.deepEqual(result.reverted_files, []);
  assert.equal(
    fs.readFileSync(path.join(cwd, "src/foo.test.ts"), "utf8"),
    "// foo test updated by codex\n",
  );
});

test("scope guard reports no reverts when Codex stayed in scope", () => {
  const cwd = repoFixture({ "src/foo.ts": "// foo\n" });
  const baseSha = git(cwd, "rev-parse", "HEAD");

  fs.writeFileSync(path.join(cwd, "src/foo.ts"), "// foo edited\n");

  const result = enforceValidationFixScope({
    targetDir: cwd,
    baseBranch: baseSha,
    allowedFiles: ["src/foo.ts"],
  });

  assert.deepEqual(result.reverted_files, []);
  assert.match(result.reason, /no out-of-scope edits/);
  assert.equal(fs.readFileSync(path.join(cwd, "src/foo.ts"), "utf8"), "// foo edited\n");
});

test("scope guard restores files Codex deleted that should not have been touched", () => {
  const cwd = repoFixture({
    "keep.ts": "// keep\n",
    "load-bearing.ts": "// must survive\n",
  });
  const baseSha = git(cwd, "rev-parse", "HEAD");

  // Codex deletes a file outside its scope.
  fs.rmSync(path.join(cwd, "load-bearing.ts"));

  const result = enforceValidationFixScope({
    targetDir: cwd,
    baseBranch: baseSha,
    allowedFiles: ["keep.ts"],
  });

  assert.deepEqual(result.reverted_files, ["load-bearing.ts"]);
  assert.equal(fs.readFileSync(path.join(cwd, "load-bearing.ts"), "utf8"), "// must survive\n");
});

test("scope guard handles the demo regression (#25 scope-creep across 37 files)", () => {
  // Replays the shape of the CLIP-SA/core-ai#29 failure: Codex's intended
  // 2-file fix is preserved; the 3 drive-by FQCN refactors it sprayed during
  // its validation-fix loop get reverted.
  const cwd = repoFixture({
    "app/Mcp/Tools/ProductSearchMcpTool.php": "<?php\n// pristine\n",
    "app/Ai/Agents/CoreAgent.php": "<?php\n// pristine\n",
    "app/Concerns/PasswordValidationRules.php": "<?php\n// pristine\n",
    "bootstrap/app.php": "<?php\n// pristine\n",
    "config/auth.php": "<?php\n// pristine\n",
  });
  const baseSha = git(cwd, "rev-parse", "HEAD");

  // Initial repair pass (clean, scoped).
  fs.writeFileSync(
    path.join(cwd, "app/Mcp/Tools/ProductSearchMcpTool.php"),
    "<?php\n// glassware hardcode removed\n",
  );
  fs.writeFileSync(path.join(cwd, "app/Ai/Agents/CoreAgent.php"), "<?php\n// glassware removed\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "scoped fix");

  // Validation-fix pass goes off the rails.
  fs.writeFileSync(
    path.join(cwd, "app/Concerns/PasswordValidationRules.php"),
    "<?php\n// FQCN refactor drive-by\n",
  );
  fs.writeFileSync(path.join(cwd, "bootstrap/app.php"), "<?php\n// random refactor\n");
  fs.writeFileSync(path.join(cwd, "config/auth.php"), "<?php\n// random refactor\n");

  const result = enforceValidationFixScope({
    targetDir: cwd,
    baseBranch: baseSha,
    allowedFiles: ["app/Mcp/Tools/ProductSearchMcpTool.php", "app/Ai/Agents/CoreAgent.php"],
    likelyFiles: ["app/Mcp/Tools/ProductSearchMcpTool.php", "app/Ai/Agents/CoreAgent.php"],
  });

  assert.deepEqual(result.reverted_files.sort(), [
    "app/Concerns/PasswordValidationRules.php",
    "bootstrap/app.php",
    "config/auth.php",
  ]);
  // Scoped fix preserved.
  assert.match(
    fs.readFileSync(path.join(cwd, "app/Mcp/Tools/ProductSearchMcpTool.php"), "utf8"),
    /glassware hardcode removed/,
  );
  assert.match(
    fs.readFileSync(path.join(cwd, "app/Ai/Agents/CoreAgent.php"), "utf8"),
    /glassware removed/,
  );
  // Drive-by edits reverted.
  for (const file of result.reverted_files) {
    assert.equal(fs.readFileSync(path.join(cwd, file), "utf8"), "<?php\n// pristine\n");
  }
});

function repoFixture(files: Record<string, string>): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-scope-guard-"));
  git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.email", "clawsweeper@example.invalid");
  git(cwd, "config", "user.name", "ClawSweeper Test");
  for (const [relPath, contents] of Object.entries(files)) {
    const full = path.join(cwd, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  return cwd;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
