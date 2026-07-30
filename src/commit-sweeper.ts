#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { argNumber, argString, parseArgs, type Args } from "./clawsweeper-args.js";
import { safeOutputTail } from "./clawsweeper-text.js";
import { runAgentProcess } from "./agent-runner.js";
import { codexEnv, codexLoginConfig, PUBLIC_CODEX_MODEL } from "./codex-env.js";
import { codexProcessErrorCode } from "./codex-process.js";
import { runText } from "./command.js";
import { configuredRepositoryProfileFor } from "./repository-profiles.js";

interface CommitMetadata {
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
  authoredAt: string;
  committedAt: string;
  subject: string;
  coAuthors: string[];
  githubAuthor: string;
  githubCommitter: string;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CODEX_MODEL = PUBLIC_CODEX_MODEL;
const DEFAULT_REASONING_EFFORT = "high";
const DEFAULT_SERVICE_TIER = "";

function run(command: string, commandArgs: string[], options: { cwd?: string } = {}): string {
  return runText(command, commandArgs, { cwd: options.cwd });
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function assertSha(value: string, label = "sha"): string {
  const sha = value.trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error(`Invalid ${label}: ${value}`);
  return sha.toLowerCase();
}

function stripEmailIdentity(value: string): string {
  return value
    .replace(/\s*<[^>\n]*@[^>\n]*>\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function personLabel(name: string, githubLogin: string): string {
  const login = githubLogin.trim();
  if (login && login !== "unknown") return `@${login}`;
  return stripEmailIdentity(name) || "unknown";
}

export function parseCoAuthors(body: string): string[] {
  const coAuthors: string[] = [];
  for (const match of body.matchAll(/^Co-authored-by:\s*(.+?)\s*$/gim)) {
    const value = stripEmailIdentity(match[1]?.trim() ?? "");
    if (value && !coAuthors.includes(value)) coAuthors.push(value);
  }
  return coAuthors;
}

function optionalGhJson(path: string, jq: string): string {
  try {
    return runText("gh", ["api", path, "--jq", jq], {
      maxBuffer: 1024 * 1024,
      trim: "both",
    });
  } catch {
    return "";
  }
}

export function commitMetadata(
  targetDir: string,
  targetRepo: string,
  sha: string,
  offline = false,
): CommitMetadata {
  const separator = "\x1f";
  const raw = run(
    "git",
    [
      "show",
      "-s",
      `--format=%H${separator}%P${separator}%an${separator}%ae${separator}%cn${separator}%ce${separator}%aI${separator}%cI${separator}%s${separator}%B`,
      sha,
    ],
    { cwd: targetDir },
  );
  const parts = raw.split(separator);
  const body = parts.slice(9).join(separator);
  // Offline mode (e.g. local-review) must not contact GitHub: skip the gh-api
  // author/committer hydration. `gh` uses its own configured auth, so removing
  // token env vars is not enough — the only way to honor the "no GitHub access"
  // contract is to not run `gh` at all.
  const githubAuthor = offline
    ? ""
    : optionalGhJson(`repos/${targetRepo}/commits/${sha}`, ".author.login // empty");
  const githubCommitter = offline
    ? ""
    : optionalGhJson(`repos/${targetRepo}/commits/${sha}`, ".committer.login // empty");
  return {
    sha: assertSha(parts[0] ?? sha),
    parents: (parts[1] ?? "")
      .split(/\s+/)
      .map((parent) => parent.trim())
      .filter(Boolean),
    authorName: parts[2] ?? "",
    authorEmail: parts[3] ?? "",
    committerName: parts[4] ?? "",
    committerEmail: parts[5] ?? "",
    authoredAt: parts[6] ?? "",
    committedAt: parts[7] ?? "",
    subject: parts[8] ?? "",
    coAuthors: parseCoAuthors(body),
    githubAuthor,
    githubCommitter,
  };
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function yamlArray(values: string[]): string {
  if (!values.length) return "[]";
  return values.map((value) => `\n  - ${yamlScalar(value)}`).join("");
}

function commitDiffSummary(targetDir: string, baseSha: string, sha: string): string {
  const stat = run("git", ["diff", "--stat", "--summary", `${baseSha}..${sha}`], {
    cwd: targetDir,
  });
  const names = run("git", ["diff", "--name-status", `${baseSha}..${sha}`], { cwd: targetDir });
  return `## Diff Summary

\`\`\`
${stat || "(no stat output)"}
\`\`\`

## Changed Files

\`\`\`
${names || "(no changed files)"}
\`\`\``;
}

function promptForCommit(options: {
  targetDir: string;
  targetRepo: string;
  sha: string;
  baseSha: string;
  metadata: CommitMetadata;
  additionalPrompt: string;
}): string {
  const prompt = readFileSync(join(ROOT, "prompts", "review-commit.md"), "utf8");
  const coAuthors = options.metadata.coAuthors.length
    ? options.metadata.coAuthors.map((value) => `- ${value}`).join("\n")
    : "- none";
  const additionalPrompt = options.additionalPrompt.trim()
    ? `\n## Additional Manual Prompt\n\n${options.additionalPrompt.trim()}\n`
    : "";
  return `${prompt}

## Commit Under Review

- Target repo: ${options.targetRepo}
- Commit SHA: ${options.sha}
- Base SHA: ${options.baseSha}
- Range: ${options.baseSha}..${options.sha}
- Subject: ${options.metadata.subject}
- Author: ${personLabel(options.metadata.authorName, options.metadata.githubAuthor)}
- Committer: ${personLabel(options.metadata.committerName, options.metadata.githubCommitter)}
- GitHub author: ${options.metadata.githubAuthor || "unknown"}
- GitHub committer: ${options.metadata.githubCommitter || "unknown"}
- Authored at: ${options.metadata.authoredAt}
- Committed at: ${options.metadata.committedAt}
- Co-authors:
${coAuthors}

${commitDiffSummary(options.targetDir, options.baseSha, options.sha)}
${additionalPrompt}`;
}

function stripMarkdownFence(markdown: string): string {
  const trimmed = markdown.trim();
  const match = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i);
  return match ? (match[1]?.trim() ?? trimmed) : trimmed;
}

function failureReport(options: {
  targetRepo: string;
  sha: string;
  baseSha: string;
  metadata: CommitMetadata;
  detail: string;
  timeout: boolean;
}): string {
  return `---
sha: ${options.sha}
parent: ${options.baseSha}
repository: ${options.targetRepo}
author: ${yamlScalar(personLabel(options.metadata.authorName, options.metadata.githubAuthor))}
committer: ${yamlScalar(personLabel(options.metadata.committerName, options.metadata.githubCommitter))}
github_author: ${yamlScalar(options.metadata.githubAuthor || "unknown")}
github_committer: ${yamlScalar(options.metadata.githubCommitter || "unknown")}
co_authors: ${options.metadata.coAuthors.length ? yamlArray(options.metadata.coAuthors) : "[]"}
commit_authored_at: ${yamlScalar(options.metadata.authoredAt)}
commit_committed_at: ${yamlScalar(options.metadata.committedAt)}
result: failed
confidence: low
highest_severity: none
check_conclusion: ${options.timeout ? "timed_out" : "neutral"}
reviewed_at: ${new Date().toISOString()}
---

# Commit ${options.sha.slice(0, 12)}

Commit review failed before a reliable report could be produced.

## Failure

\`\`\`
${options.detail}
\`\`\`
`;
}

function ensureCommitReportTimestamps(markdown: string, metadata: CommitMetadata): string {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return markdown;
  const fields = [
    ["commit_authored_at", yamlScalar(metadata.authoredAt)],
    ["commit_committed_at", yamlScalar(metadata.committedAt)],
  ] as const;
  let frontMatter = match[1] ?? "";
  for (const [key, value] of fields) {
    const line = `${key}: ${value}`;
    const pattern = new RegExp(`^${key}:.*$`, "m");
    frontMatter = pattern.test(frontMatter)
      ? frontMatter.replace(pattern, line)
      : frontMatter.replace(/^result:/m, `${line}\nresult:`);
  }
  return markdown.replace(/^---\n[\s\S]*?\n---/, `---\n${frontMatter}\n---`);
}

function runCodex(options: {
  targetDir: string;
  targetRepo: string;
  sha: string;
  baseSha: string;
  metadata: CommitMetadata;
  model: string;
  reasoningEffort: string;
  sandboxMode: string;
  serviceTier: string;
  timeoutMs: number;
  workDir: string;
  additionalPrompt: string;
  extraCodexConfig?: readonly string[];
}): string {
  ensureDir(options.workDir);
  const promptPath = join(options.workDir, `${options.sha}.prompt.md`);
  const outputPath = join(options.workDir, `${options.sha}.md`);
  writeFileSync(
    promptPath,
    promptForCommit({
      targetDir: options.targetDir,
      targetRepo: options.targetRepo,
      sha: options.sha,
      baseSha: options.baseSha,
      metadata: options.metadata,
      additionalPrompt: options.additionalPrompt,
    }),
    "utf8",
  );
  const codexConfig = [
    codexLoginConfig(),
    'approval_policy="never"',
    ...(options.extraCodexConfig ?? []),
  ];
  if (options.serviceTier) codexConfig.unshift(`service_tier="${options.serviceTier}"`);
  const result = runAgentProcess({
    label: `commit-review-${options.sha}`,
    prompt: readFileSync(promptPath, "utf8"),
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    codexExtraArgs: [
      ...codexConfig.flatMap((config) => ["-c", config]),
      "-C",
      options.targetDir,
      "--output-last-message",
      outputPath,
      "--sandbox",
      options.sandboxMode,
      "-",
    ],
    cwd: options.targetDir,
    env: codexEnv({ ghToken: process.env.COMMIT_SWEEPER_TARGET_GH_TOKEN }),
    timeoutMs: options.timeoutMs,
  });
  if (result.error || result.status !== 0 || !existsSync(outputPath)) {
    const timeout = codexProcessErrorCode(result.error) === "ETIMEDOUT";
    const detail =
      result.error instanceof Error
        ? `${result.error.message}\n${safeOutputTail(result.stderr) || safeOutputTail(result.stdout)}`
        : `exit ${result.status ?? "unknown"}\n${
            safeOutputTail(result.stderr) || safeOutputTail(result.stdout) || "No output."
          }`;
    return failureReport({
      targetRepo: options.targetRepo,
      sha: options.sha,
      baseSha: options.baseSha,
      metadata: options.metadata,
      detail: detail.trim(),
      timeout,
    });
  }
  return stripMarkdownFence(readFileSync(outputPath, "utf8"));
}

// GitHub credential env vars scrubbed before the offline local-review engine runs.
// Covers both gh enterprise aliases (GH_ENTERPRISE_TOKEN and GITHUB_ENTERPRISE_TOKEN),
// since gh honors either; this is belt-and-suspenders with the empty GH_CONFIG_DIR set
// per run.
export const LOCAL_REVIEW_SCRUBBED_TOKEN_ENV: readonly string[] = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "COMMIT_SWEEPER_TARGET_GH_TOKEN",
  "CLAWSWEEPER_PROOF_INSPECTION_TOKEN",
];
export const LOCAL_REVIEW_WEB_SEARCH_CONFIG = 'web_search="disabled"';

// `git status --porcelain` of a checkout (empty string = clean). Shared by the offline
// committed-range review paths (commit-sweeper `local-review` and clawsweeper `--local-range`)
// so both enforce the same "review COMMITTED work on a clean checkout" contract.
export function dirtyWorktree(targetDir: string): string {
  return run("git", ["status", "--porcelain"], { cwd: targetDir }).trim();
}

// Withhold every GitHub credential from an offline review engine. Shared by the offline
// committed-range review paths so neither can leak a token to the engine it spawns.
export function scrubGitHubCredentialEnv(): void {
  for (const tokenVar of LOCAL_REVIEW_SCRUBBED_TOKEN_ENV) {
    delete process.env[tokenVar];
  }
}

// Point `gh` at an empty config dir so an offline reviewer finds no cached credentials —
// token-env deletion alone can't stop gh's own configured auth. Shared by the offline
// review paths. `parentDir` keeps the empty dir inside a run dir (cleaned with the run);
// omit it for a throwaway temp dir. Returns the dir set on GH_CONFIG_DIR.
export function isolateGitHubConfigDir(parentDir?: string): string {
  let ghEmptyConfig: string;
  if (parentDir) {
    ghEmptyConfig = join(parentDir, ".gh-empty");
    mkdirSync(ghEmptyConfig, { recursive: true });
  } else {
    ghEmptyConfig = mkdtempSync(join(tmpdir(), "cs-gh-empty-"));
  }
  process.env.GH_CONFIG_DIR = ghEmptyConfig;
  return ghEmptyConfig;
}

export function localReviewAdditionalPrompt(
  baseSha: string,
  headSha: string,
  baseBranch: string,
): string {
  return `This is a LOCAL pre-PR review of the COMMITTED range ${baseSha.slice(0, 8)}..${headSha.slice(0, 8)} (your branch vs ${baseBranch}) on a clean checkout — no staged or untracked changes. Review code correctness, bugs, and security; ignore PR metadata. This review is offline: do not run gh, use web search, access URLs, or make any network request. Use only the local checkout and git history.`;
}

// Local, offline pre-PR review of a whole branch: reviews the committed range
// merge-base(base, HEAD)..HEAD as a single unit, reusing the Commit Sweeper engine.
// Conforms to the #253 replacement spec: clean checkout, unique run dir, no GitHub
// token, and reject unsupported repos (never fall back to a foreign profile).
function localReviewCommand(args: Args): void {
  const targetDir = resolve(argString(args, "target_dir", "."));
  const baseBranch = argString(args, "base", "main");
  const reportDir = resolve(
    argString(args, "report_dir", join(homedir(), ".clawsweeper-local-reviews")),
  );

  // Spec: genuinely offline — withhold every GitHub credential from the review engine.
  scrubGitHubCredentialEnv();

  // Spec: committed-range review requires a clean checkout (no hidden staged/untracked work).
  const dirtyTree = dirtyWorktree(targetDir);
  if (dirtyTree) {
    console.error(`[local-review] working tree not clean — commit or stash first:\n${dirtyTree}`);
    process.exit(1);
  }

  const targetRepo =
    argString(args, "target_repo", "") ||
    run("git", ["remote", "get-url", "origin"], { cwd: targetDir })
      .replace(/.*github\.com[:/]/, "")
      .replace(/\.git\s*$/, "")
      .trim();

  // Spec: reject unsupported repos — never silently fall back to a foreign profile.
  const profile = configuredRepositoryProfileFor(targetRepo);
  if (!profile) {
    console.error(
      `[local-review] no review profile for '${targetRepo}'. Add a repository profile, or pass --target-repo <known-repo>.`,
    );
    process.exit(1);
  }
  const profileSlug = profile.slug;

  // Range = merge-base(base, HEAD)..HEAD — the whole branch, reviewed as one unit.
  const headSha = run("git", ["rev-parse", "HEAD"], { cwd: targetDir }).trim();
  const baseSha = run("git", ["merge-base", baseBranch, "HEAD"], { cwd: targetDir }).trim();
  if (!baseSha || baseSha === headSha) {
    console.error(`[local-review] no commits on HEAD beyond ${baseBranch} — nothing to review.`);
    process.exit(1);
  }

  const metadata = commitMetadata(targetDir, targetRepo, headSha, true);

  // Spec: unique per-run dir so concurrent runs never collide on result paths.
  const runDir = join(reportDir, `run-${headSha.slice(0, 8)}-${Date.now()}-${process.pid}`);
  ensureDir(runDir);

  // Spec: hard-enforce no GitHub access. The review prompt suggests `gh` for issue
  // refs, and `gh` uses its own configured auth (token-env deletion can't stop it),
  // so point it at an empty config dir — any `gh` the spawned reviewer runs finds
  // no cached credentials. Belt-and-suspenders with Codex's read-only sandbox.
  isolateGitHubConfigDir(runDir);

  const additionalPrompt = localReviewAdditionalPrompt(baseSha, headSha, baseBranch);

  console.error(
    `[local-review] repo=${targetRepo} profile=${profileSlug} base=${baseBranch} range=${baseSha.slice(0, 8)}..${headSha.slice(0, 8)}`,
  );

  const markdown = ensureCommitReportTimestamps(
    runCodex({
      targetDir,
      targetRepo,
      sha: headSha,
      baseSha,
      metadata,
      model: argString(args, "codex_model", DEFAULT_CODEX_MODEL),
      reasoningEffort: argString(args, "codex_reasoning_effort", DEFAULT_REASONING_EFFORT),
      sandboxMode: argString(args, "codex_sandbox", "read-only"),
      serviceTier: argString(args, "codex_service_tier", DEFAULT_SERVICE_TIER),
      timeoutMs: argNumber(args, "codex_timeout_ms", 1_800_000),
      workDir: runDir,
      additionalPrompt,
      extraCodexConfig: [LOCAL_REVIEW_WEB_SEARCH_CONFIG],
    }),
    metadata,
  );

  const outputPath = join(runDir, "local-review.md");
  writeFileSync(outputPath, markdown.endsWith("\n") ? markdown : `${markdown}\n`, "utf8");
  console.error(`[local-review] report written to ${outputPath}`);
  console.log(outputPath);
}

export function main(argv = process.argv.slice(2)): void {
  const args = parseArgs(argv);
  const command = args._[0] ?? "local-review";
  if (command === "local-review") localReviewCommand(args);
  else {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
