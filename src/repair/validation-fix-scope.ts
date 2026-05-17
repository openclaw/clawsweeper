// Scope guard for the validation-fix Codex pass.
//
// When `runAllowedValidationCommands` fails inside `validateAndReviewLoop`,
// the worker re-prompts Codex to fix the patch so validation passes. Codex
// has free-write access to the target checkout, so when validation is
// failing for environment reasons (no DB, missing service, baseline-broken
// tests) it tends to thrash across unrelated files trying to clear failures
// it didn't cause. Those drive-by edits end up on the fix branch and would
// be in the PR.
//
// This guard runs immediately after the validation-fix Codex pass and
// before the worker commits its edits. It reverts any file Codex touched
// that wasn't already in scope before the pass started.
//
// "In scope" = (files already changed vs base before the validation-fix
// pass) ∪ (fix-artifact `likely_files`, glob-expanded). Anything else gets
// restored from `baseBranch` (or removed if it didn't exist there). The
// outer attempt-budget then decides whether to retry or bail.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type ValidationFixScopeOptions = {
  targetDir: string;
  baseBranch: string;
  /**
   * Files changed (vs `baseBranch`) immediately before the validation-fix
   * Codex pass started, plus any untracked files present at that moment.
   * Anything Codex touches that's already in this set is allowed.
   */
  allowedFiles: readonly string[];
  /**
   * Optional widening from the reviewer's `work_likely_files`. Supports
   * `*`, `?`, and `**` glob patterns. Files matching any pattern here are
   * also allowed even if they weren't already changed.
   */
  likelyFiles?: readonly string[];
};

export type ValidationFixScopeResult = {
  reverted_files: string[];
  allowed_files: string[];
  reason: string;
};

export function enforceValidationFixScope({
  targetDir,
  baseBranch,
  allowedFiles,
  likelyFiles = [],
}: ValidationFixScopeOptions): ValidationFixScopeResult {
  const allowed = normalize([...allowedFiles, ...likelyFiles]);
  const candidates = currentChangedSet({ targetDir, baseBranch });
  const outOfScope = candidates.filter((file) => !isAllowed(file, allowed));

  for (const file of outOfScope) revertFile({ targetDir, baseBranch, file });

  return {
    reverted_files: outOfScope,
    allowed_files: allowed,
    reason: outOfScope.length
      ? `validation-fix scope guard reverted ${outOfScope.length} out-of-scope file(s)`
      : "no out-of-scope edits",
  };
}

function currentChangedSet({
  targetDir,
  baseBranch,
}: {
  targetDir: string;
  baseBranch: string;
}): string[] {
  const tracked = gitLines(targetDir, ["diff", "--name-only", baseBranch, "--"]);
  const untracked = gitLines(targetDir, ["ls-files", "--others", "--exclude-standard"]);
  return [...new Set([...tracked, ...untracked])];
}

function revertFile({
  targetDir,
  baseBranch,
  file,
}: {
  targetDir: string;
  baseBranch: string;
  file: string;
}) {
  // Did the file exist at base? `git cat-file -e <ref>:<path>` returns 0 if so.
  const existsAtBase =
    spawnSync("git", ["cat-file", "-e", `${baseBranch}:${file}`], { cwd: targetDir }).status === 0;

  if (existsAtBase) {
    // Restore the base contents. Works for modified and deleted files alike.
    runGit(targetDir, ["checkout", baseBranch, "--", file]);
    return;
  }

  // File didn't exist at base — Codex created it. Drop it from the index and
  // from the worktree. Don't shell out to `rm` for portability.
  spawnSync("git", ["restore", "--staged", "--", file], { cwd: targetDir });
  spawnSync("git", ["rm", "-f", "--", file], { cwd: targetDir });
  try {
    fs.rmSync(path.join(targetDir, file), { force: true });
  } catch {
    // best-effort; the file may already be gone if `git rm` succeeded
  }
}

function isAllowed(file: string, allowed: readonly string[]): boolean {
  for (const pattern of allowed) {
    if (matchesPattern(file, pattern)) return true;
  }
  return false;
}

function matchesPattern(file: string, pattern: string): boolean {
  if (!pattern.includes("*") && !pattern.includes("?")) return file === pattern;
  return patternToRegex(pattern).test(file);
}

function patternToRegex(pattern: string): RegExp {
  // Single-pass tokenized rewrite. Chained `replace`s break here because
  // the `*` and `?` substitutions match their own replacement output (e.g.
  // the `*` inside `(?:.*/)?` for `**/`) and corrupt the regex.
  const regexStr = pattern.replace(/\*\*\/|\*\*|\*|\?|[.+^${}()|[\]\\]/g, (match) => {
    if (match === "**/") return "(?:.*/)?";
    if (match === "**") return ".*";
    if (match === "*") return "[^/]*";
    if (match === "?") return "[^/]";
    return `\\${match}`;
  });
  return new RegExp(`^${regexStr}$`);
}

function normalize(patterns: readonly string[]): string[] {
  return [...new Set(patterns.map((p) => String(p ?? "").trim()).filter(Boolean))];
}

function gitLines(cwd: string, args: readonly string[]): string[] {
  return runGit(cwd, args)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function runGit(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
  return result.stdout ?? "";
}
