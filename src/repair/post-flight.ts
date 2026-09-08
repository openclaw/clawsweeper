#!/usr/bin/env node
import type { JsonValue, LooseRecord } from "./json-types.js";
import fs from "node:fs";
import path from "node:path";
import {
  assertAllowedOwner,
  hasDeterministicSecuritySignal,
  parseArgs,
  parseJob,
  repoRoot,
  validateJob,
} from "./lib.js";
import { stripAnsi } from "./comment-router-utils.js";
import {
  ghBestEffortWithRetry as ghBestEffort,
  ghErrorText,
  ghJsonWithRetry as ghJson,
  ghTextWithRetry as ghWithRetry,
} from "./github-cli.js";
import { parsePullRequestUrl, sameRepoSlug } from "./github-ref.js";
import { sleepMs } from "./timing.js";
import {
  CLAWSWEEPER_LABEL,
  CLAWSWEEPER_LABEL_COLOR,
  CLAWSWEEPER_LABEL_DESCRIPTION,
} from "./constants.js";
import { AUTOMERGE_LABEL, AUTOMERGE_BLOCKING_LABEL_NAMES } from "./exact-review-guard-labels.js";
import { numberEnv } from "./env-utils.js";
import {
  buildRepairSquashMergeMessage,
  writeRepairSquashMergeBody,
} from "./repair-merge-message.js";
import { fetchPullRequestView, validateResolvedReviewThreads } from "./merge-readiness-github.js";
import { compactText as compactPlainText } from "./text-utils.js";
import { rollUpStatusChecks } from "./status-check-rollup.js";

const PASSING_CHECK_CONCLUSIONS = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
const FIX_PR_MERGE_STATES = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);
const FIX_PR_ACTIONS = new Set(["open_fix_pr", "repair_contributor_branch"]);
const FIX_PR_READY_STATUSES = new Set(["opened", "pushed"]);
const DEFAULT_IGNORED_CHECKS = ["auto-response", "Labeler", "Stale"];
const POST_FLIGHT_WAIT_MS = numberEnv("CLAWSWEEPER_POST_FLIGHT_WAIT_MS", 10 * 60 * 1000);
const POST_FLIGHT_POLL_MS = numberEnv("CLAWSWEEPER_POST_FLIGHT_POLL_MS", 15 * 1000);

const args = parseArgs(process.argv.slice(2));
const jobPath = args._[0];
const resultPathArg = args._[1];
const latest = Boolean(args.latest);
const dryRun = Boolean(args["dry-run"] || process.env.CLAWSWEEPER_POST_FLIGHT_DRY_RUN === "1");

if (!jobPath) {
  console.error("usage: node scripts/post-flight.ts <job.md> [result.json] [--latest] [--dry-run]");
  process.exit(2);
}
if (!resultPathArg && !latest) {
  console.error("result path is required unless --latest is set");
  process.exit(2);
}

const job = parseJob(jobPath);
const errors = validateJob(job);
if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}

assertAllowedOwner(job.frontmatter.repo, process.env.CLAWSWEEPER_ALLOWED_OWNER);

if (!["execute", "autonomous"].includes(job.frontmatter.mode)) {
  throw new Error("refusing post-flight: job frontmatter mode is not execute or autonomous");
}
if (process.env.CLAWSWEEPER_ALLOW_EXECUTE !== "1") {
  throw new Error("refusing post-flight: CLAWSWEEPER_ALLOW_EXECUTE must be 1");
}

const resultPath = resultPathArg ? path.resolve(resultPathArg) : findLatestResultPath();
const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
if (result.repo !== job.frontmatter.repo) {
  throw new Error(`result repo ${result.repo} does not match job repo ${job.frontmatter.repo}`);
}
if (result.cluster_id !== job.frontmatter.cluster_id) {
  throw new Error(
    `result cluster ${result.cluster_id} does not match job cluster ${job.frontmatter.cluster_id}`,
  );
}
if (!["execute", "autonomous"].includes(result.mode)) {
  throw new Error(`refusing post-flight: result mode is ${result.mode}`);
}

const fixReport = readSiblingJson(resultPath, "fix-execution-report.json");
const report: LooseRecord = {
  repo: result.repo,
  cluster_id: result.cluster_id,
  dry_run: dryRun,
  result_path: path.relative(repoRoot(), resultPath),
  post_flight_at: new Date().toISOString(),
  actions: [],
};

if (!fixReport) {
  report.actions.push({
    action: "post_flight",
    status: "skipped",
    reason: "no fix-execution-report.json",
  });
  writeReport(report, resultPath);
  process.exit(0);
}

for (const action of fixReport.actions ?? []) {
  if (!FIX_PR_ACTIONS.has(String(action.action ?? ""))) continue;
  const finalized = finalizeFixPr(action);
  report.actions.push(finalized);
}

if (report.actions.length === 0) {
  report.actions.push({
    action: "post_flight",
    status: "skipped",
    reason: "no ClawSweeper Repair fix PR actions to finalize",
  });
}

report.closure_authorization = buildClosureAuthorization(report.actions);
writeReport(report, resultPath);

function buildClosureAuthorization(actions: LooseRecord[]) {
  const mergedFixes = actions
    .filter(
      (action) =>
        action.action === "finalize_fix_pr" &&
        action.status === "executed" &&
        typeof action.pr === "string" &&
        /^#\d+$/.test(action.pr) &&
        typeof action.merge_commit_sha === "string" &&
        action.merge_commit_sha.trim(),
    )
    .map((action) => ({
      fix_ref: action.pr,
      merge_commit_sha: action.merge_commit_sha,
    }));
  return {
    version: 1,
    status: mergedFixes.length > 0 ? "authorized" : "not_authorized",
    merged_fixes: mergedFixes,
  };
}

function finalizeFixPr(action: LooseRecord) {
  const base = {
    action: "finalize_fix_pr",
    source_action: action.action,
    source_status: action.status,
    target: action.pr_url ?? action.target ?? null,
  };

  if (!FIX_PR_READY_STATUSES.has(String(action.status ?? ""))) {
    return {
      ...base,
      status: "skipped",
      reason: `fix PR action status is ${action.status ?? "missing"}`,
    };
  }

  const parsed = parsePullRequestUrl(action.pr_url ?? action.target);
  if (!parsed || !sameRepoSlug(parsed.repo, result.repo)) {
    return { ...base, status: "blocked", reason: "fix PR URL is missing or outside target repo" };
  }

  if (isIssueImplementationJob()) {
    return finalizeIssueImplementationPr({ base, parsed });
  }

  const deadline = Date.now() + POST_FLIGHT_WAIT_MS;
  let pull;
  let view;
  let prBase;
  let mergeBlock = "";
  let waitedMs = 0;
  for (;;) {
    pull = fetchPullRequest(result.repo, parsed.number);
    view = fetchPullRequestView(result.repo, parsed.number);
    prBase = { ...base, pr: `#${parsed.number}`, title: view.title ?? pull.title ?? null };
    const policyBlock = validateMergePolicy(action, pull);
    if (policyBlock) return { ...prBase, status: "blocked", reason: policyBlock };

    const mergedAt = pull.merged_at ?? view.mergedAt ?? null;
    if (mergedAt) {
      return {
        ...prBase,
        status: "executed",
        reason: "already merged",
        merged_at: mergedAt,
        merge_commit_sha: pull.merge_commit_sha ?? view.mergeCommit?.oid ?? null,
        waited_ms: waitedMs,
      };
    }

    mergeBlock = validateMergeableFixPr({ pull, view, preflight: action.merge_preflight });
    if (!mergeBlock) break;
    if (dryRun || !shouldWaitForMergeReadiness({ mergeBlock, view }) || Date.now() >= deadline) {
      return {
        ...prBase,
        status: "blocked",
        reason: mergeBlock,
        mergeable: view.mergeable ?? null,
        merge_state_status: view.mergeStateStatus ?? null,
        review_decision: view.reviewDecision ?? null,
        waited_ms: waitedMs,
      };
    }
    const sleepFor = Math.min(POST_FLIGHT_POLL_MS, Math.max(0, deadline - Date.now()));
    sleepMs(sleepFor);
    waitedMs += sleepFor;
  }

  if (dryRun) {
    return {
      ...prBase,
      status: "planned",
      reason: "dry run",
      merge_method: "squash",
      waited_ms: waitedMs,
    };
  }

  if (process.env.CLAWSWEEPER_ALLOW_MERGE !== "1") {
    labelForClawSweeperReview(result.repo, parsed.number);
    return {
      ...prBase,
      status: "blocked",
      reason: "merge requires CLAWSWEEPER_ALLOW_MERGE=1; labeled clawsweeper",
      merge_method: "squash",
      waited_ms: waitedMs,
    };
  }

  const currentPull = fetchPullRequest(result.repo, parsed.number);
  const currentPolicyBlock = validateMergePolicy(action, currentPull);
  if (currentPolicyBlock) {
    return { ...prBase, status: "blocked", reason: currentPolicyBlock, waited_ms: waitedMs };
  }
  if (currentPull.head?.sha !== pull.head?.sha) {
    return {
      ...prBase,
      status: "blocked",
      reason: "pull request head changed during merge authorization",
      waited_ms: waitedMs,
    };
  }
  pull = currentPull;

  const mergeMessage = buildRepairSquashMergeMessage({
    target: parsed.number,
    title: view.title ?? pull.title,
    headSha: pull.head?.sha,
    preflight: action.merge_preflight,
    reason: "merged by ClawSweeper Repair post-flight",
  });
  const bodyFile = writeRepairSquashMergeBody(parsed.number, pull.head?.sha, mergeMessage.body);
  const mergeArgs = [
    "pr",
    "merge",
    String(parsed.number),
    "--repo",
    result.repo,
    "--squash",
    "--subject",
    String(mergeMessage.subject),
    "--body-file",
    bodyFile,
  ];
  if (pull.head?.sha) mergeArgs.push("--match-head-commit", String(pull.head.sha));
  try {
    ghWithRetry(mergeArgs);
  } catch (error) {
    const detail = ghErrorText(error);
    if (isRecoverableMergeRace(detail)) {
      const latestView = fetchPullRequestView(result.repo, parsed.number);
      return {
        ...prBase,
        status: "blocked",
        reason: `merge attempt needs branch refresh: ${compactText(detail, 500)}`,
        mergeable: latestView.mergeable ?? null,
        merge_state_status: latestView.mergeStateStatus ?? null,
        review_decision: latestView.reviewDecision ?? null,
        retry_recommended: true,
        waited_ms: waitedMs,
      };
    }
    throw error;
  }
  const merged = fetchPullRequest(result.repo, parsed.number);
  return {
    ...prBase,
    status: "executed",
    reason: "merged by ClawSweeper Repair post-flight",
    merged_at: merged.merged_at ?? null,
    merge_commit_sha: merged.merge_commit_sha ?? null,
    merge_method: "squash",
    commit_subject: mergeMessage.subject,
    summary_lines: mergeMessage.summaryLines,
    fixup_lines: mergeMessage.fixupLines,
    waited_ms: waitedMs,
  };
}

function finalizeIssueImplementationPr({ base, parsed }: LooseRecord) {
  const deadline = Date.now() + POST_FLIGHT_WAIT_MS;
  let waitedMs = 0;
  for (;;) {
    const pull = fetchPullRequest(result.repo, parsed.number);
    const view = fetchPullRequestView(result.repo, parsed.number);
    const prBase = { ...base, pr: `#${parsed.number}`, title: view.title ?? pull.title ?? null };

    if (pull.state !== "open") {
      return {
        ...prBase,
        status: "blocked",
        reason: `pull request is ${pull.state}`,
        waited_ms: waitedMs,
      };
    }

    const checkBlock = validateStatusChecks(view.statusCheckRollup ?? []);
    if (!checkBlock) {
      return {
        ...prBase,
        status: "ready",
        reason:
          "issue implementation PR checks are green; merge intentionally blocked for this lane",
        mergeable: view.mergeable ?? null,
        merge_state_status: view.mergeStateStatus ?? null,
        review_decision: view.reviewDecision ?? null,
        waited_ms: waitedMs,
      };
    }

    if (
      dryRun ||
      !shouldWaitForIssueImplementationChecks(checkBlock, view) ||
      Date.now() >= deadline
    ) {
      return {
        ...prBase,
        status: "blocked",
        reason: checkBlock,
        mergeable: view.mergeable ?? null,
        merge_state_status: view.mergeStateStatus ?? null,
        review_decision: view.reviewDecision ?? null,
        waited_ms: waitedMs,
      };
    }

    const sleepFor = Math.min(POST_FLIGHT_POLL_MS, Math.max(0, deadline - Date.now()));
    sleepMs(sleepFor);
    waitedMs += sleepFor;
  }
}

function validateMergePolicy(action: LooseRecord, pull: LooseRecord) {
  if (job.frontmatter.source === "pr_automerge") {
    if (job.frontmatter.repair_mode !== "automerge") {
      return "autofix-only job cannot merge";
    }
    const pullAuthorization = validateAutomergePullAuthorization(pull);
    if (pullAuthorization) return pullAuthorization;
    const replacementBlock = replacementPullRequestMergeBlock(action, pull);
    if (replacementBlock) return replacementBlock;
  }
  const blockedLabel = AUTOMERGE_BLOCKING_LABEL_NAMES.find((label) => hasLabel(pull.labels, label));
  if (blockedLabel) return `protected or paused repair label: ${blockedLabel}`;
  if (!job.frontmatter.allowed_actions.includes("merge")) return "job does not allow merge";
  if ((job.frontmatter.blocked_actions ?? []).includes("merge"))
    return "merge is blocked by job frontmatter";
  if (job.frontmatter.allow_merge !== true) return "merge requires allow_merge: true";
  return "";
}

function validateAutomergePullAuthorization(pull: LooseRecord): string {
  if (!hasLabel(pull.labels, AUTOMERGE_LABEL)) {
    return "merge requires an explicit clawsweeper:automerge label";
  }
  const blockedLabel = AUTOMERGE_BLOCKING_LABEL_NAMES.find((label) => hasLabel(pull.labels, label));
  return blockedLabel ? `protected or paused repair label: ${blockedLabel}` : "";
}

function replacementPullRequestMergeBlock(action: LooseRecord, pull: LooseRecord): string {
  if (action.action !== "open_fix_pr") {
    return "";
  }

  const canonical = job.frontmatter.canonical ?? [];
  if (canonical.length !== 1 || !/^#?[1-9]\d*$/.test(String(canonical[0] ?? ""))) {
    return "automerge job must identify one canonical source pull request";
  }
  const canonicalNumber = Number(String(canonical[0]).replace(/^#/, ""));
  if (!Number.isSafeInteger(canonicalNumber)) {
    return "automerge job canonical source pull request is invalid";
  }
  const adoptedNumber = Number(String(job.frontmatter.cluster_id).match(/-(\d+)$/)?.[1] ?? 0);
  if (adoptedNumber !== canonicalNumber) {
    return "automerge job canonical source does not match its adopted pull request";
  }
  const replacement =
    Number(pull.number) !== canonicalNumber ||
    action.repair_strategy === "replace_uneditable_branch" ||
    Boolean(action.fallback_source_pr) ||
    result.fix_artifact?.repair_strategy === "replace_uneditable_branch";
  if (!replacement) return "";

  return "replacement pull request requires a fresh current-head ClawSweeper review; automatic merge disabled";
}

function isIssueImplementationJob() {
  return job.frontmatter.source === "issue_implementation";
}

function hasLabel(labels: LooseRecord[], wanted: string) {
  return (labels ?? []).some(
    (label: JsonValue) => String(label?.name ?? label).toLowerCase() === wanted.toLowerCase(),
  );
}

function labelForClawSweeperReview(repo: string, number: JsonValue) {
  ensureLabel(repo, CLAWSWEEPER_LABEL, CLAWSWEEPER_LABEL_COLOR, CLAWSWEEPER_LABEL_DESCRIPTION);
  ghBestEffort(["issue", "edit", String(number), "--repo", repo, "--add-label", CLAWSWEEPER_LABEL]);
}

function ensureLabel(repo: string, name: string, color: JsonValue, description: JsonValue) {
  try {
    ghWithRetry(
      ["label", "create", name, "--repo", repo, "--color", color, "--description", description],
      2,
    );
  } catch (error) {
    if (!/already exists/i.test(ghErrorText(error))) return;
  }
}

function hasLiveSecuritySignal(number: JsonValue, labels: LooseRecord[]) {
  if (hasDeterministicSecuritySignal({ labels })) return true;
  const bodies = ghWithRetry([
    "api",
    `repos/${result.repo}/issues/${number}/comments?per_page=100`,
    "--paginate",
    "--jq",
    ".[].body",
  ]);
  return hasDeterministicSecuritySignal({ comments: [bodies] });
}

function validateMergeableFixPr({ pull, view, preflight }: LooseRecord) {
  if (pull.state !== "open") return `pull request is ${pull.state}`;
  if (pull.draft || view.isDraft) return "pull request is draft";
  if (String(view.baseRefName ?? pull.base?.ref ?? "") !== "main")
    return "pull request base is not main";
  if (hasLiveSecuritySignal(pull.number, pull.labels ?? [])) {
    return "security-sensitive PR requires central security triage";
  }
  if (view.mergeable !== "MERGEABLE") return `mergeable state is ${view.mergeable || "unknown"}`;
  if (!FIX_PR_MERGE_STATES.has(String(view.mergeStateStatus ?? ""))) {
    return `merge state status is ${view.mergeStateStatus || "unknown"}`;
  }
  if (["CHANGES_REQUESTED", "REVIEW_REQUIRED"].includes(String(view.reviewDecision ?? ""))) {
    return `review decision is ${view.reviewDecision}`;
  }

  const preflightBlock = validateMergePreflight(preflight);
  if (preflightBlock) return preflightBlock;

  const threadBlock = validateResolvedReviewThreads(result.repo, pull.number);
  if (threadBlock) return threadBlock;

  const checkBlock = shouldRequirePrChecks()
    ? validateStatusChecks(view.statusCheckRollup ?? [])
    : "";
  if (checkBlock) return checkBlock;

  return "";
}

function validateMergePreflight(preflight: LooseRecord) {
  if (!preflight || typeof preflight !== "object") return "merge_preflight is missing";
  if (preflight.security_status !== "cleared") return "security preflight is not cleared";
  if (!Array.isArray(preflight.security_evidence) || preflight.security_evidence.length === 0) {
    return "security preflight evidence is missing";
  }
  if (preflight.comments_status !== "resolved") return "review comments are not resolved";
  if (!Array.isArray(preflight.comments_evidence) || preflight.comments_evidence.length === 0) {
    return "review comments resolution evidence is missing";
  }
  if (preflight.bot_comments_status !== "resolved") return "review-bot comments are not resolved";
  if (
    !Array.isArray(preflight.bot_comments_evidence) ||
    preflight.bot_comments_evidence.length === 0
  ) {
    return "review-bot comment resolution evidence is missing";
  }
  if (!Array.isArray(preflight.validation_commands) || preflight.validation_commands.length === 0) {
    return "merge validation commands are missing";
  }
  const codexReview = preflight.codex_review;
  if (!codexReview || codexReview.command !== "/review")
    return "Codex /review preflight is missing";
  if (!["passed", "clean"].includes(codexReview.status))
    return `Codex /review status is ${codexReview.status || "missing"}`;
  if (codexReview.findings_addressed !== true) return "Codex /review findings are not addressed";
  if (!Array.isArray(codexReview.evidence) || codexReview.evidence.length === 0) {
    return "Codex /review evidence is missing";
  }
  return "";
}

function validateStatusChecks(checks: LooseRecord[]) {
  if (!Array.isArray(checks) || checks.length === 0) return "no PR checks found";
  const blockers: LooseRecord[] = [];
  let considered = 0;
  for (const { check, ignored } of postFlightStatusCheckRollup(checks)) {
    const name = String(check.name ?? check.context ?? "unknown check");
    if (ignored) continue;
    considered += 1;
    const status = String(check.status ?? check.state ?? "").toUpperCase();
    const conclusion = String(check.conclusion ?? "").toUpperCase();
    if (status && !["COMPLETED", "SUCCESS"].includes(status)) {
      blockers.push(`${name}: ${status}`);
      continue;
    }
    if (conclusion && !PASSING_CHECK_CONCLUSIONS.has(conclusion)) {
      blockers.push(`${name}: ${conclusion}`);
    }
  }
  if (considered === 0) return "no PR checks found";
  if (blockers.length > 0) return `checks are not clean: ${blockers.slice(0, 5).join(", ")}`;
  return "";
}

function shouldWaitForMergeReadiness({ mergeBlock, view }: LooseRecord) {
  const message = String(mergeBlock ?? "").toLowerCase();
  if (message.includes("mergeable state is unknown")) return true;
  if (message.includes("merge state status is unknown")) return true;
  if (message === "no pr checks found") return true;
  if (message.includes("merge state status is unstable"))
    return hasPendingChecks(view.statusCheckRollup ?? []);
  if (message.includes("checks are not clean"))
    return hasPendingChecks(view.statusCheckRollup ?? []);
  return false;
}

function shouldWaitForIssueImplementationChecks(checkBlock: string, view: LooseRecord) {
  if (/^no PR checks found$/i.test(checkBlock)) return true;
  return shouldWaitForMergeReadiness({ mergeBlock: checkBlock, view });
}

function hasPendingChecks(checks: LooseRecord[]) {
  return postFlightStatusCheckRollup(checks ?? []).some(({ check, ignored }) => {
    if (ignored) return false;
    return isPendingStatusCheck(check);
  });
}

function postFlightStatusCheckRollup(checks: LooseRecord[]) {
  return rollUpStatusChecks(
    checks,
    process.env.CLAWSWEEPER_POST_FLIGHT_IGNORE_CHECKS ?? DEFAULT_IGNORED_CHECKS.join(","),
  );
}

function isPendingStatusCheck(check: LooseRecord) {
  const status = String(check.status ?? check.state ?? "").toUpperCase();
  const conclusion = String(check.conclusion ?? "").toUpperCase();
  return !conclusion && Boolean(status) && !["COMPLETED", "SUCCESS"].includes(status);
}

function shouldRequirePrChecks() {
  return process.env.CLAWSWEEPER_POST_FLIGHT_REQUIRE_PR_CHECKS === "1";
}

function fetchPullRequest(repo: string, number: JsonValue) {
  return ghJson(["api", `repos/${repo}/pulls/${number}`]);
}

function findLatestResultPath() {
  const runsRoot = path.join(repoRoot(), ".clawsweeper-repair", "runs");
  if (!fs.existsSync(runsRoot)) throw new Error("no run directory exists");
  const candidates: LooseRecord[] = [];
  for (const runName of fs.readdirSync(runsRoot)) {
    const candidate = path.join(runsRoot, runName, "result.json");
    if (fs.existsSync(candidate))
      candidates.push({ path: candidate, mtimeMs: fs.statSync(candidate).mtimeMs });
  }
  candidates.sort((left: JsonValue, right: JsonValue) => right.mtimeMs - left.mtimeMs);
  if (!candidates[0]) throw new Error("no result.json files found");
  return candidates[0].path;
}

function readSiblingJson(resultPath: string, name: string) {
  const file = path.join(path.dirname(resultPath), name);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeReport(report: LooseRecord, resultPath: string) {
  const reportPath = path.join(path.dirname(resultPath), "post-flight-report.json");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

function compactText(text: string, maxLength: number) {
  return compactPlainText(stripAnsi(text), maxLength);
}

function isRecoverableMergeRace(message: string) {
  return /pull request has merge conflicts|merge conflict|base branch was modified|head branch was modified|not mergeable/i.test(
    String(message ?? ""),
  );
}
