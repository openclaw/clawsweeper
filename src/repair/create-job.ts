#!/usr/bin/env node
import type { JsonValue, LooseRecord } from "./json-types.js";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs, parseJob, repoRoot, validateJob } from "./lib.js";
import { ghJsonBestEffort } from "./github-cli.js";
import { escapeRegExp } from "./text-utils.js";
import { renderJobIntentFrontmatter } from "./job-intent.js";
import { readReportFrontMatterField } from "../report-front-matter.js";

const args = parseArgs(process.argv.slice(2));
const fromReport = args["from-report"] ?? args.from_report;
const report: LooseRecord = fromReport ? parseClawSweeperReport(String(fromReport)) : null;
const repo = String(args.repo ?? report?.repo ?? "openclaw/openclaw");
const refs = normalizeRefs([
  ...splitRefs(args.refs),
  ...splitRefs(args.issue),
  ...splitRefs(args.pr),
  ...args._,
]);
const finalRefs = refs.length ? refs : normalizeRefs(report?.refs ?? []);
const mode = String(args.mode ?? "autonomous");
const prompt = readPrompt(args, report);
const clusterId = sanitizeClusterId(
  String(
    args["cluster-id"] ??
      args.cluster_id ??
      `clawsweeper-${repo.replace("/", "-")}-${finalRefs.map((ref: JsonValue) => ref.replace(/^#/, "")).join("-")}`,
  ),
);
const owner = repo.split("/")[0];
const outDir = path.resolve(
  repoRoot(),
  String(args["out-dir"] ?? args.out_dir ?? `jobs/${owner}/inbox`),
);
const outPath = path.join(outDir, `${clusterId}.md`);
const relativeOutPath = path.relative(repoRoot(), outPath);
const branch = `${String(args["branch-prefix"] ?? args.branch_prefix ?? "clawsweeper").replace(/\/$/, "")}/${clusterId}`;
const dryRun = Boolean(args["dry-run"] ?? args.dry_run);
const force = Boolean(args.force);
const dispatch = Boolean(args.dispatch);
const checkExisting = !(args["no-check-existing"] ?? args.no_check_existing);

if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) die("--repo must be owner/repo");
if (!["plan", "execute", "autonomous"].includes(mode))
  die("--mode must be plan, execute, or autonomous");
if (finalRefs.length === 0)
  die("provide at least one issue/PR ref via args, --refs, or --from-report");
if (!prompt.trim())
  die("provide --prompt, --prompt-file, or --from-report with a ClawSweeper Work Prompt section");

if (checkExisting) {
  const existing = findExistingWork({ repo, branch, clusterId });
  if (existing.length > 0 && !force) {
    console.log(
      JSON.stringify(
        {
          status: "existing_work",
          repo,
          cluster_id: clusterId,
          branch,
          job: relativeOutPath,
          existing,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }
}

if (fs.existsSync(outPath) && !force) {
  die(`job already exists: ${relativeOutPath} (use --force to overwrite)`);
}

const body = renderJob({
  repo,
  refs: finalRefs,
  clusterId,
  mode,
  branch,
  prompt,
  validation: report?.validation ?? [],
  likelyFiles: report?.likelyFiles ?? [],
});

if (dryRun) {
  console.log(body);
  process.exit(0);
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outPath, body, "utf8");
const job = parseJob(outPath);
const errors = validateJob(job);
if (errors.length > 0) {
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      status: "written",
      repo,
      cluster_id: clusterId,
      branch,
      job: relativeOutPath,
      refs: finalRefs,
      dispatch_command: `pnpm run repair:dispatch -- ${shellQuote(relativeOutPath)} --mode ${shellQuote(mode)}`,
    },
    null,
    2,
  ),
);

if (dispatch) {
  assertDispatchable(relativeOutPath);
  const result = spawnSync("npm", ["run", "dispatch", "--", relativeOutPath, "--mode", mode], {
    cwd: repoRoot(),
    encoding: "utf8",
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

function renderJob({
  repo,
  refs,
  clusterId,
  mode,
  branch,
  prompt,
  validation,
  likelyFiles,
}: LooseRecord) {
  const firstRef = refs[0];
  return `---
repo: ${repo}
cluster_id: ${clusterId}
mode: ${mode}
${renderJobIntentFrontmatter("repair_cluster")}
allowed_actions:
  - comment
  - label
  - close
  - fix
  - raise_pr
blocked_actions:
  - merge
require_human_for:
  - merge
canonical:
  - ${firstRef}
candidates:
${refs.map((ref: JsonValue) => `  - ${ref}`).join("\n")}
cluster_refs:
${refs.map((ref: JsonValue) => `  - ${ref}`).join("\n")}
allow_instant_close: false
allow_fix_pr: true
allow_merge: false
allow_unmerged_fix_close: false
allow_post_merge_close: true
require_fix_before_close: true
security_policy: central_security_only
security_sensitive: false
target_branch: ${branch}
source: clawsweeper
---

# ClawSweeper-promoted fix PR candidate

ClawSweeper Repair should create or update one implementation PR from \`${branch}\`.

## Operator Prompt

${prompt.trim()}

## Related Refs

${refs.map((ref: JsonValue) => `- ${ref}`).join("\n")}

## Likely Files

${likelyFiles.length ? likelyFiles.map((file: JsonValue) => `- ${file}`).join("\n") : "- unknown"}

## Validation

${validation.length ? validation.map((step: JsonValue) => `- ${step}`).join("\n") : "- choose the narrowest repo-native validation for the touched surface"}

## Guardrails

- Do not merge.
- Do not close issues before a fix PR is opened, landed, or explicitly proven unnecessary.
- Keep one PR for this cluster; reuse \`${branch}\` if it already exists.
- Preserve contributor credit and release-note context when the target repo expects it.
`;
}

function readPrompt(parsedArgs: JsonValue, report: LooseRecord) {
  if (typeof parsedArgs.prompt === "string") return parsedArgs.prompt;
  const promptFile = parsedArgs["prompt-file"] ?? parsedArgs.prompt_file;
  if (typeof promptFile === "string") return fs.readFileSync(path.resolve(promptFile), "utf8");
  return report?.prompt ?? "";
}

function splitRefs(value: JsonValue): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(/[,\s]+/)
    .map((entry: JsonValue) => entry.trim())
    .filter(Boolean);
}

function normalizeRefs(values: LooseRecord[]): string[] {
  return [...new Set(values.map(normalizeRef).filter(Boolean))];
}

function normalizeRef(value: JsonValue): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const url = text.match(/github\.com\/[^/]+\/[^/]+\/(?:issues|pull)\/([0-9]+)/);
  if (url) return `#${url[1]}`;
  const number = text.match(/^#?([0-9]+)$/);
  if (number) return `#${number[1]}`;
  die(`invalid issue/PR ref: ${text}`);
  return "";
}

function sanitizeClusterId(value: JsonValue) {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!sanitized) die("cluster id became empty after sanitizing");
  return sanitized;
}

function parseClawSweeperReport(filePath: string) {
  const absolute = path.resolve(filePath);
  const markdown = fs.readFileSync(absolute, "utf8");
  return {
    repo: frontMatterValue(markdown, "repository") || undefined,
    refs: [
      `#${frontMatterValue(markdown, "number")}`,
      ...frontMatterArray(markdown, "work_cluster_refs"),
    ].filter((ref: JsonValue) => /^#?[0-9]+$/.test(ref)),
    prompt: sectionValue(markdown, "ClawSweeper Work Prompt"),
    validation: frontMatterArray(markdown, "work_validation"),
    likelyFiles: frontMatterArray(markdown, "work_likely_files"),
  };
}

function frontMatterValue(markdown: string, key: string) {
  const field = readReportFrontMatterField(markdown, key);
  return field.status === "value" ? field.value.trim().replace(/^"|"$/g, "") : "";
}

function frontMatterArray(markdown: string, key: string) {
  const value = frontMatterValue(markdown, key);
  if (!value || value === "none") return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed))
      return parsed.filter((entry: JsonValue) => typeof entry === "string");
  } catch {
    return value
      .split(",")
      .map((entry: JsonValue) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function sectionValue(markdown: string, heading: string) {
  const match = markdown.match(
    new RegExp(`(?:^|\\n)## ${escapeRegExp(heading)}\\n\\n([\\s\\S]*?)(?=\\n## |\\n?$)`),
  );
  const value = match?.[1]?.trim() ?? "";
  return value === "_No ClawSweeper prompt drafted._" ? "" : value;
}

function findExistingWork({ repo, branch, clusterId }: LooseRecord) {
  const existing: JsonValue[] = [];
  const branchPrs = ghJsonBestEffort<JsonValue[]>(
    [
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--head",
      branch,
      "--json",
      "number,title,url,headRefName",
    ],
    [],
  );
  for (const pr of branchPrs ?? []) existing.push({ type: "open_pr_branch", ...pr });

  const bodyPrs = ghJsonBestEffort<JsonValue[]>(
    [
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--search",
      `${clusterId} in:body`,
      "--json",
      "number,title,url,headRefName",
    ],
    [],
  );
  for (const pr of bodyPrs ?? []) existing.push({ type: "open_pr_body", ...pr });

  const remoteBranch = spawnSync(
    "git",
    ["ls-remote", `https://github.com/${repo}.git`, `refs/heads/${branch}`],
    {
      cwd: repoRoot(),
      encoding: "utf8",
      stdio: "pipe",
    },
  );
  if (remoteBranch.status === 0 && remoteBranch.stdout.trim()) {
    existing.push({ type: "remote_branch", branch });
  }

  return uniqueExisting(existing);
}

function uniqueExisting(existing: JsonValue) {
  const seen = new Set();
  return existing.filter((entry: JsonValue) => {
    const key = `${entry.type}:${entry.url ?? entry.branch ?? entry.number ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function assertDispatchable(relativePath: string) {
  const tracked = spawnSync("git", ["ls-files", "--error-unmatch", relativePath], {
    cwd: repoRoot(),
    encoding: "utf8",
    stdio: "pipe",
  });
  const clean = spawnSync("git", ["status", "--porcelain", "--", relativePath], {
    cwd: repoRoot(),
    encoding: "utf8",
    stdio: "pipe",
  });
  if (tracked.status !== 0 || clean.stdout.trim()) {
    die(`refusing --dispatch because ${relativePath} is not committed and pushed yet`);
  }
}

function shellQuote(value: JsonValue) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function die(message: string) {
  console.error(`create-job: ${message}`);
  process.exit(2);
}
