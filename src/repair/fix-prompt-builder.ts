import fs from "node:fs";
import path from "node:path";

import { runCommand as run } from "./command-runner.js";
import type { JsonValue, LooseRecord } from "./json-types.js";
import { compactText } from "./text-utils.js";

const FIX_ARTIFACT_PROMPT_LIMIT = 36_000;
const FIX_ARTIFACT_ARRAY_LIMIT = 16;
const FIX_ARTIFACT_OBJECT_KEY_LIMIT = 60;
const REPOSITORY_CANDIDATE_LIMIT = 40;
const REPOSITORY_SNIPPET_LIMIT = 12_000;

export function buildFixPrompt({
  fixArtifact,
  branch,
  mode,
  fallbackReason,
  attempt,
  previousNoDiff,
  previousSummary,
  repositoryContext,
  reconcileWithBase,
  sourceHead,
  rebaseResult,
  maxEditAttempts,
  validationCommands,
  isAutomergeRepair = false,
}: LooseRecord) {
  return [
    "You are editing the target repository for ClawSweeper Repair.",
    "",
    "Rules:",
    "- this is a writable checkout; make concrete file edits before returning;",
    "- make the narrowest code change that satisfies the fix artifact;",
    "- start by inspecting the repository paths below with rg/git ls-files/sed;",
    "- keep shell output bounded: prefer targeted rg/sed/git commands, add --max-count/head/tail where useful, and do not dump broad repo-wide matches or huge files into the transcript;",
    "- if likely_files are stale, missing, or glob-like, discover the real nearby files and edit those;",
    "- establish one base snapshot for this Codex edit pass: use the supplied deterministic pre-edit rebase when it already succeeded, otherwise fetch origin/main once and rebase or otherwise sync once;",
    "- pin that base SHA while editing and validating; do not refetch, rebase, or rerun validation solely because origin/main advances during this edit pass;",
    "- after validation passes against the pinned base, return the repair; ClawSweeper performs one deterministic final base sync, then exact-head review and GitHub checks provide the final proof;",
    "- run local git status/diff/log/rebase/merge commands needed to reconcile this branch with the pinned base;",
    "- when git conflicts exist, resolve every conflict marker and leave the checkout in a normal non-rebasing state;",
    "- use one repair loop against the pinned base: inspect review comments and failing checks, make the narrowest fix, run validation, and repeat only for actionable failures until the branch is merge-ready or a concrete external blocker is proven;",
    "- preserve contributor credit in the PR body or commit history; edit a changelog only when the artifact explicitly requires it and repository policy permits it;",
    "- address review-bot concerns named in the artifact;",
    "- resolve actionable human review comments, bot comments, and requested changes named in the artifact;",
    "- fix relevant failing CI/check output named in the artifact; do not leave known changed-surface CI failures for a later pass;",
    isAutomergeRepair ? renderAutomergeRepairGuidance() : "",
    renderChangelogRule(fixArtifact),
    "- prepare the PR so it can pass the ClawSweeper Repair merge_preflight gate;",
    renderGitHubToolRule(isAutomergeRepair),
    "- do not create a final commit unless git rebase/merge conflict resolution requires it; ClawSweeper Repair checkpoints ordinary edits after you return;",
    "- ClawSweeper Repair will checkpoint and push your edits to the recovery branch after you return;",
    "- do not inspect or print environment variables, credentials, tokens, or secrets;",
    "- do not change auth, approval, sandbox, or trust-boundary semantics unless the artifact explicitly asks for that boundary change;",
    "- exec-adjacent bugs are allowed when the fix is ordinary correctness or hardening and does not redefine the security boundary;",
    "- before returning, verify git status/diff/log show a merge-ready branch state.",
    "",
    renderValidationLoopGuidance({ fixArtifact, validationCommands, isAutomergeRepair }),
    "",
    `Mode: ${mode}`,
    `Branch: ${branch}`,
    `Edit attempt: ${attempt ?? 1} of ${maxEditAttempts}`,
    reconcileWithBase
      ? "Existing repair branch detected. Reconcile the existing branch diff with the deterministic pre-edit rebase result before touching new code."
      : "",
    sourceHead ? `Source head before edit: ${sourceHead}` : "",
    rebaseResult ? renderRebaseResult(rebaseResult) : "",
    previousNoDiff
      ? "Previous attempt produced no target repo diff. This time make the smallest concrete code/test change that satisfies the artifact; do not return analysis only."
      : "",
    previousSummary ? `Previous no-diff summary: ${compactText(previousSummary, 1200)}` : "",
    fallbackReason ? `Fallback reason: ${fallbackReason}` : "",
    "",
    "Repository discovery context:",
    "```text",
    repositoryContext,
    "```",
    "",
    "Fix artifact:",
    "```json",
    renderFixArtifactForPrompt(fixArtifact),
    "```",
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderFixArtifactForPrompt(fixArtifact: JsonValue) {
  const raw = JSON.stringify(fixArtifact, null, 2);
  if (raw.length <= FIX_ARTIFACT_PROMPT_LIMIT) return raw;

  const compacted = compactPromptValue(fixArtifact);
  const annotated =
    compacted && typeof compacted === "object" && !Array.isArray(compacted)
      ? {
          _prompt_compaction: `Original fix artifact was ${raw.length} characters; long strings, arrays, and nested objects were truncated for Codex context. Use local repository discovery and read-only GitHub inspection if more detail is needed.`,
          ...compacted,
        }
      : {
          _prompt_compaction: `Original fix artifact was ${raw.length} characters; value was truncated for Codex context.`,
          value: compacted,
        };
  const rendered = JSON.stringify(annotated, null, 2);
  if (rendered.length <= FIX_ARTIFACT_PROMPT_LIMIT) return rendered;
  return JSON.stringify(
    finalPromptArtifactFallback(fixArtifact, raw.length, rendered.length),
    null,
    2,
  );
}

function finalPromptArtifactFallback(
  fixArtifact: JsonValue,
  rawLength: number,
  compactedLength: number,
) {
  const record =
    fixArtifact && typeof fixArtifact === "object" && !Array.isArray(fixArtifact)
      ? (fixArtifact as LooseRecord)
      : {};
  return {
    _prompt_compaction: `Original fix artifact was ${rawLength} characters and compacted artifact was ${compactedLength} characters; using critical fields only for Codex context.`,
    _truncated: `prompt artifact hit ${FIX_ARTIFACT_PROMPT_LIMIT} character cap`,
    repo: record.repo ?? null,
    cluster_id: record.cluster_id ?? null,
    source_prs: compactPromptValue(record.source_prs ?? []),
    source_issues: compactPromptValue(record.source_issues ?? []),
    repair_strategy: record.repair_strategy ?? null,
    summary: compactPromptValue(record.summary ?? ""),
    pr_title: compactPromptValue(record.pr_title ?? ""),
    affected_surfaces: compactPromptValue(record.affected_surfaces ?? []),
    likely_files: compactPromptValue(record.likely_files ?? []),
    validation_commands: compactPromptValue(record.validation_commands ?? []),
    changelog_required: record.changelog_required ?? null,
  };
}

function compactPromptValue(value: JsonValue, key = "", depth = 0): JsonValue {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return compactPromptString(value, key, depth);
  if (Array.isArray(value)) {
    const limit = depth <= 1 ? FIX_ARTIFACT_ARRAY_LIMIT : Math.min(8, FIX_ARTIFACT_ARRAY_LIMIT);
    const kept = value.slice(0, limit).map((entry) => compactPromptValue(entry, key, depth + 1));
    if (value.length > limit) {
      kept.push(
        `[... ${value.length - limit} artifact entr${value.length - limit === 1 ? "y" : "ies"} omitted ...]`,
      );
    }
    return kept;
  }
  if (typeof value !== "object") return String(value);
  if (depth >= 5) return "[... nested artifact object omitted ...]";

  const entries = Object.entries(value as LooseRecord);
  const priority = new Set([
    "repo",
    "cluster_id",
    "source_prs",
    "source_issues",
    "repair_strategy",
    "summary",
    "pr_title",
    "affected_surfaces",
    "likely_files",
    "validation_commands",
    "changelog_required",
    "review_findings",
    "fix_plan",
    "actions",
  ]);
  const sorted = entries.sort(([left], [right]) => {
    const leftPriority = priority.has(left) ? 0 : 1;
    const rightPriority = priority.has(right) ? 0 : 1;
    return leftPriority - rightPriority;
  });
  const out: LooseRecord = {};
  for (const [entryKey, entryValue] of sorted.slice(0, FIX_ARTIFACT_OBJECT_KEY_LIMIT)) {
    out[entryKey] = compactPromptValue(entryValue, entryKey, depth + 1);
  }
  if (entries.length > FIX_ARTIFACT_OBJECT_KEY_LIMIT) {
    out._omitted_keys = `${entries.length - FIX_ARTIFACT_OBJECT_KEY_LIMIT} low-priority artifact keys omitted`;
  }
  return out;
}

function compactPromptString(value: string, key: string, depth: number) {
  const lowerKey = key.toLowerCase();
  const limit = /url|html_url|sha|oid|idempotency/.test(lowerKey)
    ? 4096
    : /body|comment|review|evidence|log|stdout|stderr|diff|patch|transcript|message/.test(lowerKey)
      ? 1200
      : depth <= 1
        ? 2400
        : 1600;
  if (value.length <= limit) return value;
  const marker = `\n...[truncated ${value.length - limit} chars]...\n`;
  const available = Math.max(0, limit - marker.length);
  const head = Math.ceil(available * 0.65);
  return `${value.slice(0, head)}${marker}${value.slice(value.length - (available - head))}`;
}

function renderGitHubToolRule(isAutomergeRepair: boolean) {
  if (!isAutomergeRepair) return "- do not push, open PRs, close PRs, or call gh;";
  return "- do not push, open PRs, close PRs, comment, label, or merge; read-only `gh` commands are allowed for PR comments, review threads, check status, and check logs when available;";
}

function renderAutomergeRepairGuidance() {
  return [
    "- automerge repair loop: treat this as direct PR repair work, not a planning exercise;",
    "- inspect the PR comments, review threads, ClawSweeper verdict, and failing check evidence already provided; if read-only `gh` is available, use it to inspect missing PR comments, reviews, checks, and logs;",
    "- if no successful deterministic pre-edit rebase was supplied, fetch origin/main and rebase this branch once, then resolve conflicts;",
    "- address actionable PR comments and review findings;",
    "- fix failing CI/checks for this PR;",
    "- failed exact-head checks are repair scope for automerge even when the failing file is outside likely_files; fix the narrow failure against the pinned base or prove it is an external blocker there, leaving later origin/main movement to ClawSweeper's deterministic final base sync;",
    "- run the tests/checks needed to prove the PR should go green, then keep iterating until the checkout is merge-ready or a concrete external blocker is proven;",
  ].join("\n");
}

function renderValidationLoopGuidance({
  fixArtifact,
  validationCommands = [],
  isAutomergeRepair = false,
}: LooseRecord) {
  const commands = [
    ...(Array.isArray(validationCommands) ? validationCommands : []),
    ...(Array.isArray(fixArtifact.validation_commands) ? fixArtifact.validation_commands : []),
  ]
    .map((command) => String(command).trim())
    .filter(Boolean)
    .filter((command, index, all) => all.indexOf(command) === index);
  if (isAutomergeRepair) {
    return [
      "Validation loop:",
      "- run the tests/checks needed to prove this automerge PR should go green before returning;",
      "- if `pnpm check:changed` is available or listed below, run it; it is the default OpenClaw changed-surface gate;",
      commands.length > 0
        ? `- validation command hints: ${commands.join(" ; ")}`
        : "- validation command hints: discover the narrow changed-surface command from package scripts, PR comments, check logs, and the artifact;",
      "- treat artifact validation commands as hints unless they reproduce or prove the failing PR checks;",
      "- if validation fails, fix the failure and rerun until it passes or an external blocker is proven;",
      "- do not report validation as passed unless it passed after your last edit in this checkout;",
      "- include the exact validation commands and final pass/fail result in your final message.",
    ].join("\n");
  }
  return [
    "Validation loop:",
    "- after editing, run the changed-surface validation in this checkout before returning;",
    "- if `pnpm check:changed` is available or listed below, run it; it is the default OpenClaw changed-surface gate;",
    commands.length > 0
      ? `- expected validation commands: ${commands.join(" ; ")}`
      : "- expected validation commands: discover the narrow changed-surface command from package scripts and the artifact;",
    "- if validation fails, fix the failure and rerun until it passes or an external blocker is proven;",
    "- do not report validation as passed unless it passed after your last edit in this checkout;",
    "- include the exact validation commands and final pass/fail result in your final message.",
  ].join("\n");
}

function renderChangelogRule(fixArtifact: LooseRecord) {
  const policyRule =
    "- target repository release-note policy wins over fix artifact credit notes: for openclaw/openclaw, do not edit CHANGELOG.md during normal repair work; preserve user-facing release-note context and contributor/source PR attribution in PR body/history/source links or commit messages instead; never add forbidden `Thanks @codex`, `Thanks @openclaw`, or `Thanks @steipete` changelog attribution;";
  if (fixArtifact.repair_strategy === "repair_contributor_branch") {
    return [
      "- repair_contributor_branch never edits CHANGELOG.md or other release-owned changelog files, even if changelog_required is true;",
      "- preserve release-note context and contributor credit in the existing PR body or commit history instead;",
      policyRule,
    ].join("\n");
  }
  if (fixArtifact.changelog_required !== true) {
    return [
      "- changelog_required is false: do not edit CHANGELOG.md or other release-owned changelog files;",
      "- if you discover the target repository requires release-note context for this user-facing repair, preserve it in the PR body or commit message before returning;",
      policyRule,
    ].join("\n");
  }
  return [
    "- changelog_required is true: preserve the user-facing change summary and contributor/source PR attribution in the PR body or commit message before returning;",
    policyRule,
    "- do not leave release-note context for a later repair pass.",
  ].join("\n");
}

function renderRebaseResult(rebaseResult: LooseRecord) {
  const status = String(rebaseResult.status ?? "unknown");
  const baseRef = String(rebaseResult.base_ref ?? "origin/main");
  const baseSha = String(rebaseResult.base_sha ?? "unknown");
  const detail = compactText(String(rebaseResult.detail ?? "").trim(), 800);
  const unmergedPaths = Array.isArray(rebaseResult.unmerged_paths)
    ? rebaseResult.unmerged_paths.map((entry: unknown) => String(entry)).filter(Boolean)
    : [];
  return [
    `Deterministic pre-edit rebase: ${status} onto ${baseRef} (${baseSha}).`,
    status === "conflicts"
      ? [
          "Conflict-first mode:",
          "- resolve only the active rebase conflicts before doing any feature repair;",
          "- inspect `git status --short` and the conflicted files listed below;",
          "- remove all conflict markers and stage the resolved files;",
          "- run `git rebase --continue` until the checkout is no longer rebasing;",
          "- do not broaden the patch while conflicts remain.",
        ].join("\n")
      : "",
    status === "conflicts" && unmergedPaths.length > 0
      ? `Unmerged conflict paths: ${unmergedPaths.join(", ")}`
      : "",
    detail ? `Rebase output: ${detail}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildRepositoryContext({ fixArtifact, targetDir }: LooseRecord) {
  const files = run("git", ["ls-files"], { cwd: targetDir })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const scoredCandidates = scoreRepositoryFiles({ files, fixArtifact }).slice(
    0,
    REPOSITORY_CANDIDATE_LIMIT,
  );
  const candidates = scoredCandidates.map((entry: JsonValue) => `${entry.file} (${entry.score})`);
  const snippets = buildRepositorySnippets({
    targetDir,
    candidates: scoredCandidates.slice(0, 12),
    fixArtifact,
  });
  const packageScripts = readPackageScripts(targetDir);
  return [
    `candidate_files (${candidates.length}):`,
    ...(candidates.length > 0
      ? candidates
      : ["none matched; use rg across the repo to find the real implementation files"]),
    "",
    "candidate_file_excerpts:",
    snippets || "none; inspect candidate files directly before editing",
    "",
    `validation_commands: ${(fixArtifact.validation_commands ?? []).join(" ; ")}`,
    `package_scripts: ${packageScripts.join(", ") || "none"}`,
  ].join("\n");
}

function buildRepositorySnippets({ targetDir, candidates, fixArtifact }: LooseRecord) {
  const tokens = discoveryTokens(fixArtifact).slice(0, 40);
  const out: JsonValue[] = [];
  let renderedLength = 0;
  for (const candidate of candidates) {
    const pathname = path.join(targetDir, candidate.file);
    if (!fs.existsSync(pathname)) continue;
    const stat = fs.statSync(pathname);
    if (!stat.isFile() || stat.size > 220_000) continue;
    const content = fs.readFileSync(pathname, "utf8");
    const excerpt = focusedFileExcerpt(content, tokens);
    if (!excerpt) continue;
    const rendered = `--- ${candidate.file} ---\n${excerpt}`;
    renderedLength += rendered.length + (out.length > 0 ? 2 : 0);
    out.push(rendered);
    if (renderedLength > REPOSITORY_SNIPPET_LIMIT) break;
  }
  return out.join("\n\n").slice(0, REPOSITORY_SNIPPET_LIMIT);
}

function focusedFileExcerpt(content: string, tokens: string[]) {
  const lines = content.split(/\r?\n/);
  const matched = new Set<number>();
  const lowerTokens = tokens
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 4);
  if (lowerTokens.length === 0)
    return renderSelectedExcerptLines(lines, firstLineIndexes(lines, 80));
  for (let index = 0; index < lines.length; index += 1) {
    const lower = lines[index]!.toLowerCase();
    if (lowerTokens.some((token) => lower.includes(token))) {
      for (
        let line = Math.max(0, index - 8);
        line <= Math.min(lines.length - 1, index + 18);
        line += 1
      ) {
        matched.add(line);
      }
    }
  }
  const selected =
    matched.size > 0
      ? [...matched].sort((left, right) => left - right)
      : firstLineIndexes(lines, 80);
  return renderSelectedExcerptLines(lines, selected);
}

function firstLineIndexes(lines: readonly string[], limit: number) {
  return Array.from({ length: Math.min(lines.length, limit) }, (_, index) => index);
}

function renderSelectedExcerptLines(lines: readonly string[], selected: readonly number[]) {
  const rendered: string[] = [];
  let previous = -2;
  let renderedLength = 0;
  for (const line of selected) {
    if (line !== previous + 1) rendered.push("...");
    const renderedLine = `${line + 1}: ${lines[line]}`;
    rendered.push(renderedLine);
    renderedLength += renderedLine.length + 1;
    previous = line;
    if (renderedLength > 3_200) break;
  }
  return rendered.join("\n");
}

function scoreRepositoryFiles({ files, fixArtifact }: LooseRecord) {
  const likelyFiles = (fixArtifact.likely_files ?? [])
    .map((entry: JsonValue) => String(entry).trim())
    .filter(Boolean);
  const exactLikely = new Set(likelyFiles.filter((entry: JsonValue) => !entry.includes("*")));
  const literalHints = likelyFiles
    .map(literalPathHint)
    .filter((entry: string) => entry.length >= 4);
  const tokens = discoveryTokens(fixArtifact);
  const out: JsonValue[] = [];
  for (const file of files) {
    const lower = file.toLowerCase();
    let score = 0;
    if (exactLikely.has(file)) score += 100;
    for (const hint of literalHints) {
      if (lower.includes(hint)) score += 15;
    }
    for (const token of tokens) {
      if (lower.includes(token)) score += 3;
    }
    if (/\.(test|spec)\.[cm]?[jt]sx?$/i.test(file)) score += 2;
    if (/\.(ts|tsx|js|jsx|mjs|cjs|md|mdx|json)$/i.test(file)) score += 1;
    if (score > 0) out.push({ file, score });
  }
  out.sort(
    (left: JsonValue, right: JsonValue) =>
      right.score - left.score || left.file.localeCompare(right.file),
  );
  return out;
}

function literalPathHint(value: JsonValue) {
  return String(value)
    .toLowerCase()
    .replace(/\*\*?.*$/, "")
    .replace(/\/+$/, "");
}

function discoveryTokens(fixArtifact: LooseRecord) {
  const common = new Set([
    "support",
    "supported",
    "current",
    "existing",
    "validation",
    "commands",
    "summary",
    "scope",
    "error",
    "errors",
  ]);
  const text = [
    fixArtifact.summary,
    fixArtifact.pr_title,
    fixArtifact.pr_body,
    ...(fixArtifact.affected_surfaces ?? []),
    ...(fixArtifact.likely_files ?? []),
  ].join("\n");
  const tokens = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/[a-z][a-z0-9_-]{3,}/g)) {
    const token = match[0].replace(/[-_]/g, "");
    if (token.length >= 4 && !common.has(token)) tokens.add(token);
  }
  return [...tokens].slice(0, 80);
}

function readPackageScripts(targetDir: string) {
  const packagePath = path.join(targetDir, "package.json");
  if (!fs.existsSync(packagePath)) return [];
  try {
    const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    return Object.keys(pkg.scripts ?? {})
      .sort()
      .slice(0, 80);
  } catch {
    return [];
  }
}
