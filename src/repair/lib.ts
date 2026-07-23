import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./paths.js";
import type { JsonValue, LooseRecord } from "./json-types.js";
import { isRepairMode, type RepairJobFrontmatter } from "./domain-types.js";
import { isRepairJobIntent } from "./job-intent.js";

export { repoRoot } from "./paths.js";
export type {
  JsonArray,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  LooseRecord,
  StrictJsonArray,
  StrictJsonObject,
  StrictJsonValue,
} from "./json-types.js";
export type CliArgs = LooseRecord & { _: string[] };
export type JobFrontmatter = RepairJobFrontmatter;
export type ParsedJob = {
  path: string;
  relativePath: string;
  frontmatter: JobFrontmatter;
  body: string;
  raw: string;
};
export { githubActionsRunUrl, currentProjectRepo } from "./project-repo.js";
export {
  assertLiveWorkerCapacity,
  activeRepairWorkflowRunForJob,
  activeRepairWorkflowRunForJobAfterDispatchRecheck,
  listActiveWorkflowRuns,
  liveWorkerCapacity,
  readMaxLiveWorkers,
  repairRunNameForJob,
  repairRunNamePrefixForJob,
  waitForLiveWorkerCapacity,
} from "./live-worker-capacity.js";
export { hasDeterministicSecuritySignal, hasSecuritySignalText } from "./security-signals.js";

const PROMPT_ARTIFACT_MAX_CHARS = Number(
  process.env.CLAWSWEEPER_PROMPT_ARTIFACT_MAX_CHARS ?? 320_000,
);
const PROMPT_STRING_MAX_CHARS = Number(process.env.CLAWSWEEPER_PROMPT_STRING_MAX_CHARS ?? 700);

export function readText(relativePath: string) {
  return fs.readFileSync(path.join(repoRoot(), relativePath), "utf8");
}

export function resolveJobPath(filePath: string) {
  return path.resolve(filePath);
}

export function parseJob(filePath: string): ParsedJob {
  const absolute = resolveJobPath(filePath);
  const raw = fs.readFileSync(absolute, "utf8");
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    throw new Error(`missing YAML frontmatter: ${filePath}`);
  }
  return {
    path: absolute,
    relativePath: path.relative(repoRoot(), absolute),
    frontmatter: parseSimpleYaml(match[1] ?? "") as JobFrontmatter,
    body: (match[2] ?? "").trim(),
    raw,
  };
}

export function parseSimpleYaml(text: string): LooseRecord {
  const out: LooseRecord = {};
  let currentKey: string | null = null;

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;

    const listMatch = line.match(/^\s+-\s+(.*)$/);
    if (listMatch && currentKey) {
      if (!Array.isArray(out[currentKey])) out[currentKey] = [];
      out[currentKey].push(parseScalar(listMatch[1] ?? ""));
      continue;
    }

    const kv = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!kv) {
      throw new Error(`unsupported YAML line: ${line}`);
    }

    currentKey = kv[1] ?? "";
    const value = kv[2] ?? "";
    out[currentKey] = value === "" ? [] : parseScalar(value);
  }

  return out;
}

function parseScalar(value: JsonValue): JsonValue {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((part: JsonValue) => parseScalar(part))
      .filter((part: JsonValue) => part !== "");
  }
  return trimmed;
}

export function validateJob(job: ParsedJob | LooseRecord) {
  const errors: string[] = [];
  const fm = job.frontmatter;
  const commitFindingJob = fm.source === "clawsweeper_commit";

  requireString(errors, fm, "repo");
  requireString(errors, fm, "cluster_id");
  requireString(errors, fm, "mode");
  requireArray(errors, fm, "allowed_actions");
  if (!commitFindingJob) requireArray(errors, fm, "candidates");

  if (typeof fm.repo === "string" && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fm.repo)) {
    errors.push("repo must be owner/repo");
  }
  if (fm.mode && !isRepairMode(fm.mode)) {
    errors.push("mode must be plan, execute, or autonomous");
  }
  for (const key of [
    "allowed_actions",
    "blocked_actions",
    "require_human_for",
    "canonical",
    "candidates",
    "cluster_refs",
    "maintainer_close_refs",
    "required_pr_labels",
  ]) {
    if (fm[key] !== undefined && !Array.isArray(fm[key])) {
      errors.push(`${key} must be a list`);
    }
  }
  for (const action of fm.allowed_actions ?? []) {
    if (!["comment", "label", "close", "merge", "fix", "raise_pr"].includes(action)) {
      errors.push(`unsupported allowed action: ${action}`);
    }
  }
  for (const ref of [...(fm.canonical ?? []), ...(fm.candidates ?? [])]) {
    if (!/^#?[0-9]+$/.test(String(ref))) {
      errors.push(`candidate refs must look like #123: ${ref}`);
    }
  }
  for (const ref of fm.cluster_refs ?? []) {
    if (!isGithubRef(ref)) {
      errors.push(`cluster_refs must look like #123 or a GitHub issue/PR URL: ${ref}`);
    }
  }
  for (const ref of fm.maintainer_close_refs ?? []) {
    if (!isGithubRef(ref)) {
      errors.push(`maintainer_close_refs must look like #123 or a GitHub issue/PR URL: ${ref}`);
    }
  }
  for (const key of [
    "allow_instant_close",
    "allow_low_signal_pr_close",
    "allow_fix_pr",
    "allow_merge",
    "allow_unmerged_fix_close",
    "allow_post_merge_close",
    "allow_broad_fix_artifacts",
    "require_fix_before_close",
    "security_sensitive",
  ]) {
    if (fm[key] !== undefined && typeof fm[key] !== "boolean") {
      errors.push(`${key} must be true or false`);
    }
  }
  for (const key of [
    "canonical_hint",
    "job_intent",
    "target_checkout",
    "triage_policy",
    "security_policy",
    "source",
    "trigger_source",
    "commit_sha",
    "clawsweeper_report_repo",
    "clawsweeper_report_path",
    "expected_head_sha",
    "self_heal_merge_state",
    "self_heal_run_url",
    "self_heal_target_pr",
  ]) {
    if (fm[key] !== undefined && typeof fm[key] !== "string") {
      errors.push(`${key} must be a string`);
    }
  }
  if (commitFindingJob && !/^[0-9a-f]{40}$/i.test(String(fm.commit_sha ?? ""))) {
    errors.push("commit finding jobs require commit_sha");
  }
  if (fm.job_intent !== undefined && !isRepairJobIntent(fm.job_intent)) {
    errors.push(`unsupported job_intent: ${fm.job_intent}`);
  }
  if (fm.security_sensitive === true) {
    errors.push(
      "security_sensitive jobs are out of scope for ClawSweeper Repair; route them to central security triage",
    );
  }

  return errors;
}

function requireString(errors: string[], object: LooseRecord, key: string) {
  if (typeof object[key] !== "string" || object[key].trim() === "") {
    errors.push(`${key} is required`);
  }
}

function requireArray(errors: string[], object: LooseRecord, key: string) {
  if (!Array.isArray(object[key]) || object[key].length === 0) {
    errors.push(`${key} must be a non-empty list`);
  }
}

export function renderPrompt(
  job: ParsedJob | LooseRecord,
  requestedMode?: JsonValue,
  context: LooseRecord = {},
) {
  const mode = requestedMode ?? job.frontmatter.mode;
  const modePrompt =
    mode === "autonomous"
      ? "prompts/repair/autonomous.md"
      : mode === "execute"
        ? "prompts/repair/execute.md"
        : "prompts/repair/plan-only.md";
  const parts = [
    readText("prompts/repair/worker-system.md"),
    readText(modePrompt),
    "## Security boundary",
    readText("instructions/security-boundary.md"),
    "## Dedupe policy",
    readText("instructions/dedupe.md"),
    "## Closure policy",
    readText("instructions/closure-policy.md"),
    "## Merge policy",
    readText("instructions/merge-policy.md"),
    ...(job.frontmatter.triage_policy === "low_signal_prs"
      ? ["## Low-signal PR policy", readText("instructions/low-signal-prs.md")]
      : []),
    "## Job file",
    "```md",
    job.raw.trim(),
    "```",
  ];

  for (const [title, filePath] of [
    ["Cluster preflight artifact", context.clusterPlanPath],
    ["Fix artifact", context.fixArtifactPath],
  ]) {
    if (!filePath) continue;
    const absolute = path.resolve(filePath);
    const artifact = promptArtifactText(title, absolute);
    parts.push(
      `## ${title}`,
      `Path: \`${path.relative(repoRoot(), absolute)}\``,
      artifact.compacted
        ? `Note: compacted for the Codex input budget; use counts, refs, timestamps, review-bot excerpts, and safety gates as authoritative.`
        : "",
      "```json",
      artifact.text,
      "```",
    );
  }

  if (context.targetCheckout) {
    parts.push(
      "## Target checkout",
      `The target repository checkout is \`${context.targetCheckout}\`. Run target-repo inspection commands from that checkout. The ClawSweeper repository is only the automation harness.`,
    );
  }

  parts.push(
    "## Required final output",
    "Return JSON matching `schema/repair/codex-result.schema.json` and nothing else.",
    "If the fix has explicit files that must differ from the latest base in the final repaired tree, set `fix_artifact.repair_contract` to an object with `must_touch` and `match` (`any` or `all`). The executor checks this once against the final branch delta after review fixes and base sync. Set `repair_contract` to null when the expected edit surface is uncertain, only represented by incomplete `likely_files`, or the work is a pure deterministic rebase.",
  );

  return parts.join("\n\n");
}

function promptArtifactText(title: string, absolutePath: string) {
  const raw = fs.readFileSync(absolutePath, "utf8").trim();
  if (raw.length <= PROMPT_ARTIFACT_MAX_CHARS) return { text: raw, compacted: false };
  try {
    const parsed = JSON.parse(raw);
    const compacted =
      title === "Cluster preflight artifact" ? compactClusterPlan(parsed) : compactDeep(parsed);
    const compactText = JSON.stringify(compacted, null, 2);
    if (compactText.length <= PROMPT_ARTIFACT_MAX_CHARS)
      return { text: compactText, compacted: true };
    return {
      text: JSON.stringify(
        {
          _prompt_compacted: true,
          _prompt_truncated: true,
          _prompt_reason: `artifact exceeded ${PROMPT_ARTIFACT_MAX_CHARS} characters after compaction`,
          summary: compactDeep(compacted, { arrayLimit: 20, stringLimit: 300 }),
        },
        null,
        2,
      ),
      compacted: true,
    };
  } catch {
    return {
      text: `${raw.slice(0, PROMPT_ARTIFACT_MAX_CHARS - 120)}\n... [artifact truncated for Codex input budget]`,
      compacted: true,
    };
  }
}

function compactClusterPlan(plan: LooseRecord) {
  return compactDeep({
    _prompt_compacted: true,
    repo: plan.repo,
    cluster_id: plan.cluster_id,
    mode: plan.mode,
    source_job: plan.source_job,
    target_checkout: plan.target_checkout,
    generated_at: plan.generated_at,
    offline: plan.offline,
    main: plan.main,
    security_boundary: plan.security_boundary,
    scope: plan.scope,
    canonical_candidates: plan.canonical_candidates,
    safety_gates: plan.safety_gates,
    items: (plan.items ?? []).map(compactPlanItem),
  });
}

function compactPlanItem(item: LooseRecord) {
  const pull = item.pull_request;
  return {
    repo: item.repo,
    ref: item.ref,
    number: item.number,
    kind: item.kind,
    state: item.state,
    title: item.title,
    url: item.url,
    author: item.author,
    author_association: item.author_association,
    labels: item.labels,
    updated_at: item.updated_at,
    closed_at: item.closed_at,
    body_excerpt: item.body_excerpt,
    security_sensitive: item.security_sensitive,
    comments_count: item.comments_count,
    comments_hydrated: item.comments_hydrated,
    comments_truncated: item.comments_truncated,
    maintainer_comments: (item.maintainer_comments ?? []).slice(0, 6),
    bot_comments: (item.bot_comments ?? []).slice(0, 8),
    comments: (item.comments ?? []).slice(0, 4),
    classification_hint: item.classification_hint,
    pull_request: pull
      ? {
          draft: pull.draft,
          merged: pull.merged,
          merged_at: pull.merged_at,
          merge_commit_sha: pull.merge_commit_sha,
          mergeable: pull.mergeable,
          mergeable_state: pull.mergeable_state,
          base_ref: pull.base_ref,
          head_ref: pull.head_ref,
          head_repo: pull.head_repo,
          head_sha: pull.head_sha,
          maintainer_can_modify: pull.maintainer_can_modify,
          same_repo_head: pull.same_repo_head,
          branch_writable: pull.branch_writable,
          branch_write_reason: pull.branch_write_reason,
          changed_files: pull.changed_files,
          files_hydrated: pull.files_hydrated,
          files_truncated: pull.files_truncated,
          additions: pull.additions,
          deletions: pull.deletions,
          files: (pull.files ?? []).slice(0, 40),
          commits_count: pull.commits_count,
          commits_hydrated: pull.commits_hydrated,
          commits_truncated: pull.commits_truncated,
          commits: (pull.commits ?? []).slice(0, 10),
          reviews: (pull.reviews ?? []).slice(0, 12),
          review_comments_count: pull.review_comments_count,
          review_comments_hydrated: pull.review_comments_hydrated,
          review_comments_truncated: pull.review_comments_truncated,
          review_comments: (pull.review_comments ?? []).slice(0, 8),
          review_bot_comments: (pull.review_bot_comments ?? []).slice(0, 16),
          checks: pull.checks,
        }
      : null,
  };
}

function compactDeep(value: JsonValue, options: LooseRecord = {}): JsonValue {
  const arrayLimit = options.arrayLimit ?? 80;
  const stringLimit = options.stringLimit ?? PROMPT_STRING_MAX_CHARS;
  if (typeof value === "string") {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length > stringLimit
      ? `${normalized.slice(0, stringLimit - 3)}...`
      : normalized;
  }
  if (Array.isArray(value)) {
    return value.slice(0, arrayLimit).map((item: JsonValue) => compactDeep(item, options));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]: JsonValue[]) => [key, compactDeep(item, options)]),
    );
  }
  return value;
}

function isGithubRef(value: JsonValue) {
  const text = String(value ?? "");
  return (
    /^#?[0-9]+$/.test(text) ||
    /^https:\/\/github\.com\/[^/]+\/[^/]+\/(?:issues|pull)\/[0-9]+/.test(text)
  );
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === "--") {
      continue;
    }
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

// CLAWSWEEPER_ALLOWED_OWNER is the one authoritative repair owner policy
// (issue #604): a comma- or whitespace-separated owner list shared by intake
// and every execution gate, so eligibility cannot diverge between them.
export function allowedRepairOwners(allowedOwner?: string): string[] {
  return String(allowedOwner ?? "")
    .split(/[\s,]+/)
    .map((owner) => owner.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowedRepairOwner(repo: string, allowedOwner?: string): boolean {
  const owners = allowedRepairOwners(allowedOwner);
  if (owners.length === 0) return true;
  return owners.includes(String(repo.split("/")[0] ?? "").toLowerCase());
}

export function assertAllowedOwner(repo: string, allowedOwner?: string) {
  if (!allowedOwner) return;
  if (!isAllowedRepairOwner(repo, allowedOwner)) {
    const owner = repo.split("/")[0];
    throw new Error(`repo owner ${owner} does not match CLAWSWEEPER_ALLOWED_OWNER=${allowedOwner}`);
  }
}

export function makeRunDir(job: ParsedJob | LooseRecord, mode: string) {
  const slug = `${path.basename(job.path, ".md")}-${mode}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const dir = path.join(repoRoot(), ".clawsweeper-repair", "runs", slug);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
