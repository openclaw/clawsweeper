#!/usr/bin/env node
import type { JsonValue, LooseRecord } from "./json-types.js";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  assertAllowedOwner,
  hasDeterministicSecuritySignal,
  parseArgs,
  parseJob,
  repoRoot,
  validateJob,
} from "./lib.js";
import { defaultCloseComment, externalMessageProvenance } from "./external-messages.js";
import {
  ghBestEffortWithRetry as ghBestEffort,
  ghErrorText,
  githubLimitedPagePath,
  ghJsonWithRetry as ghJson,
  ghPagedWithRetry as ghPaged,
  ghTextWithRetry as ghWithRetry,
} from "./github-cli.js";
import { issueNumberFromRef } from "./github-ref.js";
import { isLockedConversationCommentError } from "../github-retry.js";
import { lockedConversationSkip, lockedConversationSkipIfLocked } from "./apply-locks.js";
import {
  CLAWSWEEPER_LABEL,
  CLAWSWEEPER_LABEL_COLOR,
  CLAWSWEEPER_LABEL_DESCRIPTION,
} from "./constants.js";
import {
  buildRepairSquashMergeMessage,
  writeRepairSquashMergeBody,
} from "./repair-merge-message.js";
import {
  compactPrCloseCoverageProofComment,
  compactPrCloseCoverageProofText,
  prCloseCoverageProofCandidateCanClose,
  prCloseCoverageProofCloseDecision,
  runPrCloseCoverageProofModel,
  type PrCloseCoverageProofModelResult,
  type PrCloseCoverageProofPullRequestView,
} from "../pr-close-coverage-proof.js";
import {
  isFixFirstBlockedCloseAction,
  orderRepairClosureActions,
  planRepairClosureResult,
  repairClosureDependencyRefs,
  resolveRepairClosureRelationship,
} from "./closure-result-plan.js";

const MAINTAINER_AUTHOR_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const CLOSE_ACTIONS = new Set([
  "close",
  "close_duplicate",
  "close_superseded",
  "close_fixed_by_candidate",
  "close_low_signal",
  "post_merge_close",
]);
const MERGE_ACTIONS = new Set(["merge_candidate", "merge_canonical"]);
const CLOSE_CLASSIFICATIONS = new Set([
  "duplicate",
  "superseded",
  "fixed_by_candidate",
  "low_signal",
]);
const PASSING_CHECK_CONCLUSIONS = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
const CLEAN_MERGE_STATES = new Set(["CLEAN"]);
// A covering PR may need a base update, but actual merge actions remain CLEAN-only.
const VIABLE_COVERING_PR_MERGE_STATES = new Set(["CLEAN", "BEHIND"]);
const PR_CLOSE_COVERAGE_PROOF_COMMENT_LIMIT = 50;
const GITHUB_MAX_PAGE_SIZE = 100;
const CLAWSWEEPER_COMMAND_ONLY_PATTERN = /^@clawsweeper\s+(?:re-review|re-run|review)\s*$/i;
const CLAWSWEEPER_BOT_AUTHORS = new Set(
  [
    "clawsweeper",
    "clawsweeper[bot]",
    "openclaw-clawsweeper[bot]",
    process.env.CLAWSWEEPER_COMMENT_AUTHOR_LOGIN,
  ].filter((login): login is string => typeof login === "string" && login.length > 0),
);

type PrCloseCoverageProofValidation =
  | {
      status: "covered";
      coveringRef: JsonValue;
      coveringUpdatedAt: string | null;
      proof: PrCloseCoverageProofModelResult;
    }
  | {
      status: "blocked";
      reason: string;
      requeue_required?: true;
      pr_close_coverage_proof?: PrCloseCoverageProofModelResult;
    }
  | null;

type PrCloseCoverageProofBlock = {
  reason: string;
  requeue_required?: true;
};

const args = parseArgs(process.argv.slice(2));
const jobPath = args._[0];
const resultPathArg = args._[1];
const latest = Boolean(args.latest);
const dryRun = Boolean(args["dry-run"] || process.env.CLAWSWEEPER_APPLY_DRY_RUN === "1");
const allowMissingUpdatedAt = Boolean(args["allow-missing-updated-at"]);
const reportPathArg = args["report"];

if (!jobPath) {
  console.error(
    "usage: node scripts/apply-result.ts <job.md> [result.json] [--latest] [--dry-run]",
  );
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
  throw new Error("refusing apply: job frontmatter mode is not execute or autonomous");
}
if (process.env.CLAWSWEEPER_ALLOW_EXECUTE !== "1") {
  throw new Error("refusing apply: CLAWSWEEPER_ALLOW_EXECUTE must be 1");
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
  throw new Error(`refusing apply: result mode is ${result.mode}`);
}
if (result.mode !== job.frontmatter.mode) {
  throw new Error(
    `refusing apply: result mode ${result.mode} does not match job mode ${job.frontmatter.mode}`,
  );
}

const report: LooseRecord = {
  repo: result.repo,
  cluster_id: result.cluster_id,
  dry_run: dryRun,
  result_path: path.relative(repoRoot(), resultPath),
  applied_at: new Date().toISOString(),
  actions: [],
};

const allowedRefs = new Set(
  [
    ...(job.frontmatter.cluster_refs ?? []),
    ...(job.frontmatter.canonical ?? []),
    ...(job.frontmatter.candidates ?? []),
  ]
    .map((ref: JsonValue) => normalizeIssueRef(ref, result.repo))
    .filter(Boolean),
);
const maintainerCloseRefs = new Set(
  (job.frontmatter.maintainer_close_refs ?? [])
    .map((ref: JsonValue) => normalizeIssueRef(ref, result.repo))
    .filter(Boolean),
);

const { effectiveResult, promotions } = applyPostFlightClosurePromotions(result);
if (promotions.length > 0) report.closure_promotions = promotions;
const closurePlan = planRepairClosureResult(effectiveResult);
if (closurePlan.status === "needs_human") {
  throw new Error(
    `refusing apply: ${closurePlan.diagnostics
      .map((diagnostic) => `closure dependency plan ${diagnostic.code}: ${diagnostic.message}`)
      .join("; ")}`,
  );
}
report.closure_plan = closurePlan;
const closureOutcomes = new Map<string, LooseRecord>();
const applicatorActions = (effectiveResult.actions ?? []).filter(isApplicatorAction);
for (const action of orderRepairClosureActions(applicatorActions, closurePlan)) {
  if (!isApplicatorAction(action)) continue;
  const outcome =
    blockedClosureDependencyOutcome({
      result: effectiveResult,
      action,
      dryRun,
      closureOutcomes,
    }) ??
    applyAction({
      job,
      result: effectiveResult,
      action,
      dryRun,
      allowMissingUpdatedAt,
    });
  report.actions.push(outcome);
  if (action.status === "planned" && CLOSE_ACTIONS.has(String(action.action ?? ""))) {
    const target = normalizeRepairClosureRef(action.target);
    if (target) closureOutcomes.set(target, outcome);
  }
}

const reportPath =
  typeof reportPathArg === "string"
    ? path.resolve(reportPathArg)
    : path.join(path.dirname(resultPath), "apply-report.json");
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

function findLatestResultPath() {
  const runsRoot = path.join(repoRoot(), ".clawsweeper-repair", "runs");
  if (!fs.existsSync(runsRoot)) {
    throw new Error("no run directory exists");
  }
  const candidates: LooseRecord[] = [];
  for (const runName of fs.readdirSync(runsRoot)) {
    const candidate = path.join(runsRoot, runName, "result.json");
    if (!fs.existsSync(candidate)) continue;
    candidates.push({ path: candidate, mtimeMs: fs.statSync(candidate).mtimeMs });
  }
  candidates.sort((left: JsonValue, right: JsonValue) => right.mtimeMs - left.mtimeMs);
  if (!candidates[0]) throw new Error("no result.json files found");
  return candidates[0].path;
}

function readFixExecutionReport(_result?: JsonValue) {
  const reportPath = path.join(path.dirname(resultPath), "fix-execution-report.json");
  if (!fs.existsSync(reportPath)) return null;
  return JSON.parse(fs.readFileSync(reportPath, "utf8"));
}

function applyPostFlightClosurePromotions(sourceResult: LooseRecord): {
  effectiveResult: LooseRecord;
  promotions: LooseRecord[];
} {
  const postFlightReportPath = path.join(path.dirname(resultPath), "post-flight-report.json");
  if (!fs.existsSync(postFlightReportPath)) {
    return { effectiveResult: sourceResult, promotions: [] };
  }
  const postFlightReport = JSON.parse(fs.readFileSync(postFlightReportPath, "utf8"));
  if (
    postFlightReport.repo !== sourceResult.repo ||
    postFlightReport.cluster_id !== sourceResult.cluster_id ||
    postFlightReport.closure_authorization?.version !== 1 ||
    postFlightReport.closure_authorization?.status !== "authorized"
  ) {
    return { effectiveResult: sourceResult, promotions: [] };
  }

  const mergedFixRefs = new Set(
    (postFlightReport.closure_authorization.merged_fixes ?? [])
      .filter(
        (entry: JsonValue) =>
          typeof entry?.merge_commit_sha === "string" && entry.merge_commit_sha.trim(),
      )
      .map((entry: JsonValue) => normalizeRepairClosureRef(entry.fix_ref))
      .filter(Boolean),
  );
  if (mergedFixRefs.size === 0) return { effectiveResult: sourceResult, promotions: [] };

  const actions = Array.isArray(sourceResult.actions) ? sourceResult.actions : [];
  const hasFixPath = actions.some(
    (action: JsonValue) =>
      ["fix_needed", "build_fix_artifact", "open_fix_pr"].includes(String(action?.action ?? "")) &&
      ["planned", "blocked"].includes(String(action?.status ?? "")),
  );
  const promotions: LooseRecord[] = [];
  const effectiveActions = actions.map((action: LooseRecord) => {
    if (
      !CLOSE_ACTIONS.has(String(action.action ?? "")) ||
      !isFixFirstBlockedCloseAction(action, hasFixPath)
    ) {
      return action;
    }
    const candidateFix = normalizeRepairClosureRef(
      resolveRepairClosureRelationship(action).candidateFix,
    );
    if (!candidateFix || !mergedFixRefs.has(candidateFix)) return action;
    promotions.push({
      target: normalizeRepairClosureRef(action.target),
      action: action.action,
      source_status: action.status,
      effective_status: "planned",
      candidate_fix: candidateFix,
      reason: "authorized by merged ClawSweeper Repair fix",
    });
    return { ...action, status: "planned" };
  });
  if (promotions.length === 0) return { effectiveResult: sourceResult, promotions };
  return {
    effectiveResult: { ...sourceResult, actions: effectiveActions },
    promotions,
  };
}

function applyAction({ job, result, action, dryRun, allowMissingUpdatedAt }: LooseRecord) {
  const {
    target,
    actionName,
    classification,
    canonical,
    candidateFix,
    relationshipRoot,
    idempotencyKey,
    base,
  } = repairActionContext(result, action);

  if (!target) return { ...base, status: "failed", reason: "target must look like #123" };
  if (action.status !== "planned") {
    return {
      ...base,
      status: "skipped",
      source_status: action.status ?? null,
      reason: action.reason ?? `action status is ${action.status}`,
    };
  }
  if (MERGE_ACTIONS.has(actionName)) {
    return applyMergeAction({ job, result, action, dryRun, allowMissingUpdatedAt, target, base });
  }
  if (!CLOSE_ACTIONS.has(actionName)) {
    return { ...base, status: "skipped", reason: "action is not an applicator action" };
  }

  return applyCloseAction({
    job,
    result,
    action,
    dryRun,
    allowMissingUpdatedAt,
    target,
    base,
    actionName,
    classification,
    canonical,
    candidateFix,
    relationshipRoot,
    idempotencyKey,
  });
}

function applyCloseAction({
  job,
  result,
  action,
  dryRun,
  allowMissingUpdatedAt,
  target,
  base,
  actionName,
  classification,
  canonical,
  candidateFix,
  relationshipRoot,
  idempotencyKey,
}: LooseRecord) {
  const closePolicyBlock = validateClosePolicy({ job, actionName });
  if (closePolicyBlock) return { ...base, status: "blocked", reason: closePolicyBlock };
  const fixFirstBlock = validateFixFirstClose({
    job,
    result,
    actionName,
    classification,
    candidateFix,
  });
  if (fixFirstBlock) return { ...base, status: "blocked", reason: fixFirstBlock };
  if (!CLOSE_CLASSIFICATIONS.has(classification)) {
    return {
      ...base,
      status: "blocked",
      reason:
        "auto-closure requires duplicate, superseded, fixed_by_candidate, or low_signal classification",
    };
  }
  if (actionName === "post_merge_close" && job.frontmatter.allow_post_merge_close !== true) {
    return {
      ...base,
      status: "blocked",
      reason: "post-merge close requires allow_post_merge_close: true",
    };
  }
  if (!job.frontmatter.candidates.map(normalizeIssueRef).includes(target)) {
    return { ...base, status: "blocked", reason: "target is not listed in job candidates" };
  }
  if (classification === "low_signal" || actionName === "close_low_signal") {
    const lowSignalBlock = validateLowSignalIntent({ job, action, actionName, classification });
    if (lowSignalBlock) return { ...base, status: "blocked", reason: lowSignalBlock };
  }
  const explicitSupersededByCandidate =
    actionName === "close_superseded" &&
    classification === "superseded" &&
    !canonical &&
    candidateFix &&
    maintainerCloseRefs.has(target);
  if (
    (classification === "duplicate" || classification === "superseded") &&
    !canonical &&
    !explicitSupersededByCandidate
  ) {
    return { ...base, status: "blocked", reason: "closure requires canonical or duplicate_of" };
  }
  const isPostMergeFixedClose =
    actionName === "post_merge_close" && classification === "fixed_by_candidate";
  if (canonical && !allowedRefs.has(canonical) && !isPostMergeFixedClose) {
    return { ...base, status: "blocked", reason: "canonical is not listed in job refs" };
  }
  if (classification === "fixed_by_candidate" && !candidateFix) {
    return { ...base, status: "blocked", reason: "closure requires candidate_fix" };
  }
  if (candidateFix && !allowedRefs.has(candidateFix) && !isPostMergeFixedClose) {
    return { ...base, status: "blocked", reason: "candidate fix is not listed in job refs" };
  }
  if (actionName === "post_merge_close" || explicitSupersededByCandidate) {
    const candidateBlock = validateMergedCandidateFix(result.repo, candidateFix);
    if (candidateBlock) return { ...base, status: "blocked", reason: candidateBlock };
  }
  if (canonical === target || candidateFix === target) {
    return { ...base, status: "blocked", reason: "target cannot close against itself" };
  }
  const replacementCloseoutBlock = validateReplacementCloseout({ result, actionName, target });
  if (replacementCloseoutBlock)
    return { ...base, status: "blocked", reason: replacementCloseoutBlock };

  let live = fetchIssue(result.repo, target);
  const kind = live.pull_request ? "pull_request" : "issue";
  const authorAssociation = normalizeAuthorAssociation(live.author_association);
  if (hasSecuritySignal(live)) {
    return {
      ...base,
      status: "blocked",
      reason: "security-sensitive target requires central security triage",
      live_state: live.state,
    };
  }
  if (MAINTAINER_AUTHOR_ASSOCIATIONS.has(authorAssociation) && !maintainerCloseRefs.has(target)) {
    return {
      ...base,
      status: "blocked",
      reason: `target author association is ${authorAssociation}`,
      live_state: live.state,
    };
  }
  if (classification === "low_signal") {
    const lowSignalBlock = validateLowSignalLiveState(result.repo, target, live, kind);
    if (lowSignalBlock) {
      return {
        ...base,
        status: "blocked",
        reason: lowSignalBlock,
        live_state: live.state,
        live_updated_at: live.updated_at,
      };
    }
  }

  const comment = renderCloseComment({ action, classification, result, target, live });
  const marker = idempotencyMarker(result.cluster_id, target, idempotencyKey);
  const body = comment.includes(marker) ? comment : `${comment.trim()}\n\n${marker}`;
  const existingComment = findExistingComment(result.repo, target, marker, body);
  if (live.state !== "open") {
    return {
      ...base,
      status: existingComment ? "executed" : "skipped",
      reason: existingComment
        ? "already closed with matching clawsweeper-repair comment"
        : "already closed",
      live_state: live.state,
    };
  }

  const expectedUpdatedAt = action.target_updated_at ?? action.live_updated_at;
  if (!expectedUpdatedAt && !allowMissingUpdatedAt) {
    return {
      ...base,
      status: "blocked",
      reason: "missing target_updated_at; rerun the worker against live GitHub state",
      live_state: live.state,
      live_updated_at: live.updated_at,
    };
  }
  if (expectedUpdatedAt && expectedUpdatedAt !== live.updated_at) {
    return {
      ...base,
      status: "blocked",
      reason: "target changed since worker review",
      expected_updated_at: expectedUpdatedAt,
      live_updated_at: live.updated_at,
      live_state: live.state,
    };
  }

  const lockedSkip = lockedConversationSkipIfLocked(base, live);
  if (lockedSkip) return lockedSkip;

  const proofValidation = validatePrCloseCoverageProof({
    result,
    action,
    actionName,
    target,
    live,
    classification,
    coveringRef: relationshipRoot,
  });
  if (proofValidation?.status === "blocked") {
    return {
      ...base,
      ...proofValidation,
      live_state: live.state,
      live_updated_at: live.updated_at,
    };
  }
  live = fetchIssue(result.repo, target);
  if (live.state !== "open") {
    return {
      ...base,
      status: existingComment ? "executed" : "skipped",
      reason: existingComment
        ? "already closed with matching clawsweeper-repair comment"
        : "already closed",
      live_state: live.state,
    };
  }
  if (expectedUpdatedAt && expectedUpdatedAt !== live.updated_at) {
    return {
      ...base,
      status: "blocked",
      reason: "target changed since worker review",
      expected_updated_at: expectedUpdatedAt,
      live_updated_at: live.updated_at,
      live_state: live.state,
    };
  }
  if (proofValidation?.status === "covered") {
    const postProofCoveringFreshnessBlock = validatePrCloseCoverageCoveringFreshness({
      result,
      coveringRef: proofValidation.coveringRef,
      coveringUpdatedAt: proofValidation.coveringUpdatedAt,
    });
    if (postProofCoveringFreshnessBlock) {
      return {
        ...base,
        status: "blocked",
        reason: postProofCoveringFreshnessBlock,
        requeue_required: true,
        live_state: live.state,
        live_updated_at: live.updated_at,
      };
    }
  }
  const postProofCoveringSafetyBlock = validatePrCloseCoverageCoveringRefSafety({
    result,
    target,
    live,
    coveringRef: relationshipRoot,
  });
  if (postProofCoveringSafetyBlock) {
    return {
      ...base,
      status: "blocked",
      ...postProofCoveringSafetyBlock,
      live_state: live.state,
      live_updated_at: live.updated_at,
    };
  }

  if (dryRun) {
    return {
      ...base,
      status: "planned",
      reason: "dry run",
      live_state: live.state,
      live_updated_at: live.updated_at,
      ...prCloseCoverageProofActionReport(proofValidation),
      comment,
    };
  }

  try {
    if (!existingComment) {
      postIssueComment(result.repo, target, body);
    }
    closeIssueOrPullRequest(result.repo, target, kind, classification);
  } catch (error) {
    if (isLockedConversationCommentError(error)) {
      return lockedConversationSkip(base, live, { terminalWriteError: true });
    }
    throw error;
  }

  return {
    ...base,
    status: "executed",
    reason: closeReasonText(classification),
    live_state: "closed",
    live_updated_at: live.updated_at,
    ...prCloseCoverageProofActionReport(proofValidation),
  };
}

function prCloseCoverageProofActionReport(proofValidation: PrCloseCoverageProofValidation): {
  pr_close_coverage_proof?: PrCloseCoverageProofModelResult;
} {
  return proofValidation?.status === "covered" && proofValidation.proof
    ? { pr_close_coverage_proof: proofValidation.proof }
    : {};
}

function applyMergeAction({
  job,
  result,
  action,
  dryRun,
  allowMissingUpdatedAt,
  target,
  base,
}: LooseRecord) {
  const policyBlock = validateMergePolicy({ job, action });
  if (policyBlock) return { ...base, status: "blocked", reason: policyBlock };
  if (!allowedRefs.has(target)) {
    return { ...base, status: "blocked", reason: "merge target is not listed in job refs" };
  }

  if (action.target_kind !== "pull_request") {
    return { ...base, status: "blocked", reason: "merge action requires pull_request target_kind" };
  }

  const live = fetchIssue(result.repo, target);
  if (!live.pull_request) {
    return {
      ...base,
      status: "blocked",
      reason: "merge target is not a pull request",
      live_state: live.state,
    };
  }
  if (hasSecuritySignal(live)) {
    return {
      ...base,
      status: "blocked",
      reason: "security-sensitive target requires central security triage",
      live_state: live.state,
    };
  }

  const expectedUpdatedAt = action.target_updated_at ?? action.live_updated_at;
  if (!expectedUpdatedAt && !allowMissingUpdatedAt) {
    return {
      ...base,
      status: "blocked",
      reason: "missing target_updated_at; rerun the worker against live GitHub state",
      live_state: live.state,
      live_updated_at: live.updated_at,
    };
  }
  if (expectedUpdatedAt && expectedUpdatedAt !== live.updated_at) {
    return {
      ...base,
      status: "blocked",
      reason: "target changed since worker review",
      expected_updated_at: expectedUpdatedAt,
      live_updated_at: live.updated_at,
      live_state: live.state,
    };
  }

  const pullRequest = fetchPullRequest(result.repo, target);
  const view = fetchPullRequestView(result.repo, target);
  const mergedAt = pullRequest.merged_at ?? view.mergedAt ?? null;
  if (mergedAt) {
    return {
      ...base,
      status: "executed",
      reason: "already merged",
      live_state: "merged",
      live_updated_at: live.updated_at,
      merged_at: mergedAt,
      merge_commit_sha: pullRequest.merge_commit_sha ?? view.mergeCommit?.oid ?? null,
    };
  }
  const lockedSkip = lockedConversationSkipIfLocked(base, live);
  if (lockedSkip) return { ...lockedSkip, merge_method: "squash" };

  const mergeBlock = validateMergeablePullRequest({ pullRequest, view });
  if (mergeBlock) {
    return {
      ...base,
      status: "blocked",
      reason: mergeBlock,
      live_state: live.state,
      live_updated_at: live.updated_at,
    };
  }
  const mergePreflightBlock = validateMergePreflight({ result, target });
  if (mergePreflightBlock) {
    return {
      ...base,
      status: "blocked",
      reason: mergePreflightBlock,
      live_state: live.state,
      live_updated_at: live.updated_at,
    };
  }
  const mergePreflight = findMergePreflight(result, target);

  if (process.env.CLAWSWEEPER_ALLOW_MERGE !== "1") {
    if (!dryRun) labelForClawSweeperReview(result.repo, target);
    return {
      ...base,
      status: "blocked",
      reason: "merge requires CLAWSWEEPER_ALLOW_MERGE=1; labeled clawsweeper",
      live_state: live.state,
      live_updated_at: live.updated_at,
      merge_method: "squash",
    };
  }

  if (dryRun) {
    return {
      ...base,
      status: "planned",
      reason: "dry run",
      live_state: live.state,
      live_updated_at: live.updated_at,
      merge_method: "squash",
    };
  }

  const mergeMessage = buildRepairSquashMergeMessage({
    target,
    title: view.title ?? pullRequest.title,
    headSha: pullRequest.head?.sha,
    preflight: mergePreflight,
    reason: "merged by ClawSweeper Repair",
  });
  const bodyFile = writeRepairSquashMergeBody(target, pullRequest.head?.sha, mergeMessage.body);
  const mergeArgs = [
    "pr",
    "merge",
    String(target),
    "--repo",
    result.repo,
    "--squash",
    "--subject",
    String(mergeMessage.subject),
    "--body-file",
    bodyFile,
  ];
  if (pullRequest.head?.sha) mergeArgs.push("--match-head-commit", String(pullRequest.head.sha));
  try {
    ghWithRetry(mergeArgs);
  } catch (error) {
    if (isLockedConversationCommentError(error)) {
      return {
        ...lockedConversationSkip(base, live, { terminalWriteError: true }),
        merge_method: "squash",
      };
    }
    throw error;
  }
  const merged = fetchPullRequest(result.repo, target);
  return {
    ...base,
    status: "executed",
    reason: "merged by clawsweeper-repair",
    live_state: "merged",
    live_updated_at: live.updated_at,
    merged_at: merged.merged_at ?? null,
    merge_commit_sha: merged.merge_commit_sha ?? null,
    merge_method: "squash",
    commit_subject: mergeMessage.subject,
    summary_lines: mergeMessage.summaryLines,
    fixup_lines: mergeMessage.fixupLines,
  };
}

function validateClosePolicy({ job, actionName }: LooseRecord) {
  if (!job.frontmatter.allowed_actions.includes("close")) return "job does not allow close";
  if (!job.frontmatter.allowed_actions.includes("comment"))
    return "job does not allow close comments";
  if ((job.frontmatter.blocked_actions ?? []).includes("close"))
    return "close is blocked by job frontmatter";
  if ((job.frontmatter.blocked_actions ?? []).includes("comment"))
    return "comment is blocked by job frontmatter";

  if (
    !["close_low_signal", "post_merge_close"].includes(actionName) &&
    job.frontmatter.allow_instant_close !== true
  ) {
    return "instant close requires allow_instant_close: true";
  }
  return "";
}

function validateFixFirstClose({
  job,
  result,
  actionName,
  classification,
  candidateFix,
}: LooseRecord) {
  if (job.frontmatter.require_fix_before_close !== true) return "";
  if (["close_low_signal", "post_merge_close"].includes(actionName)) return "";
  if (classification === "duplicate") return "";

  const priorMerge = report.actions.some(
    (entry: JsonValue) => MERGE_ACTIONS.has(entry.action) && entry.status === "executed",
  );
  if (priorMerge) return "";

  if (candidateFix && isMergedCandidateFix(result.repo, candidateFix)) {
    return "";
  }

  if (
    classification === "fixed_by_candidate" &&
    job.frontmatter.allow_unmerged_fix_close !== true
  ) {
    return "fixed_by_candidate close requires a merged fix PR unless allow_unmerged_fix_close: true";
  }

  const fixReport = readFixExecutionReport(result);
  const fixLanded = (fixReport?.actions ?? []).some(
    (entry: JsonValue) =>
      ["open_fix_pr", "repair_contributor_branch"].includes(String(entry.action ?? "")) &&
      ["opened", "pushed"].includes(String(entry.status ?? "")),
  );
  if (fixLanded) return "";

  return "close requires ClawSweeper fix PR opened/pushed, merged candidate fix, or merge executed first";
}

function isMergedCandidateFix(repo: string, candidateFix: LooseRecord) {
  try {
    return validateMergedCandidateFix(repo, candidateFix) === "";
  } catch {
    return false;
  }
}

function validateMergePolicy({ job, action }: LooseRecord) {
  if (!job.frontmatter.allowed_actions.includes("merge")) return "job does not allow merge";
  if ((job.frontmatter.blocked_actions ?? []).includes("merge"))
    return "merge is blocked by job frontmatter";
  if (job.frontmatter.allow_merge !== true) return "merge requires allow_merge: true";
  if (!["merge_candidate", "merge_canonical"].includes(String(action.action ?? ""))) {
    return "unsupported merge action";
  }
  return "";
}

function labelForClawSweeperReview(repo: string, target: LooseRecord) {
  ensureLabel(repo, CLAWSWEEPER_LABEL, CLAWSWEEPER_LABEL_COLOR, CLAWSWEEPER_LABEL_DESCRIPTION);
  ghBestEffort(["issue", "edit", String(target), "--repo", repo, "--add-label", CLAWSWEEPER_LABEL]);
}

function ensureLabel(repo: string, name: string, color: JsonValue, description: JsonValue) {
  try {
    ghWithRetry(
      ["label", "create", name, "--repo", repo, "--color", color, "--description", description],
      2,
    );
  } catch (error) {
    const detail = ghErrorText(error);
    if (!/already exists/i.test(detail)) return;
  }
}

function validateMergePreflight({ result, target }: LooseRecord) {
  const preflight = findMergePreflight(result, target);
  if (!preflight) return "merge requires merge_preflight entry";
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
  const unresolvedThreadBlock = validateResolvedReviewThreads(result.repo, target);
  if (unresolvedThreadBlock) return unresolvedThreadBlock;
  return "";
}

function findMergePreflight(result: LooseRecord, target: LooseRecord) {
  const expected = `#${target}`;
  for (const item of result.merge_preflight ?? []) {
    if (
      normalizeIssueRef(item?.target, result.repo) === target ||
      String(item?.target ?? "") === expected
    ) {
      return item;
    }
  }
  return null;
}

function validateMergedCandidateFix(repo: string, candidateFix: LooseRecord) {
  if (!candidateFix) return "post-merge close requires candidate_fix";
  const candidate = fetchPullRequest(repo, candidateFix);
  if (!candidate.merged_at) return "candidate fix is not merged";
  return "";
}

function validateResolvedReviewThreads(repo: string, target: LooseRecord) {
  const [owner, name] = repo.split("/");
  const query = `
    query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviewThreads(first: 100) {
            pageInfo { hasNextPage }
            nodes {
              isResolved
              path
              line
              comments(first: 1) {
                nodes {
                  url
                  author { login }
                  body
                }
              }
            }
          }
        }
      }
    }
  `;
  const data = ghJson([
    "api",
    "graphql",
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-F",
    `number=${target}`,
    "-f",
    `query=${query}`,
  ]);
  const threads = data?.data?.repository?.pullRequest?.reviewThreads;
  if (threads?.pageInfo?.hasNextPage) return "too many review threads to prove resolved";
  const unresolved = (threads?.nodes ?? []).filter(
    (thread: JsonValue) => thread && !thread.isResolved,
  );
  if (unresolved.length === 0) return "";
  const examples = unresolved
    .slice(0, 3)
    .map(
      (thread: JsonValue) =>
        thread.comments?.nodes?.[0]?.url ?? `${thread.path}:${thread.line ?? "?"}`,
    );
  return `unresolved review threads remain: ${examples.join(", ")}`;
}

function validateReplacementCloseout({ result, actionName, target }: LooseRecord) {
  if (!["close_superseded", "close_fixed_by_candidate", "post_merge_close"].includes(actionName))
    return "";
  const fixArtifact = result.fix_artifact;
  if (fixArtifact?.repair_strategy !== "replace_uneditable_branch") return "";
  const sourceTargets = new Set(
    (fixArtifact.source_prs ?? []).map((ref: JsonValue) => normalizeIssueRef(ref, result.repo)),
  );
  if (!sourceTargets.has(target)) return "";
  return "replacement PR closeout is handled by execute-fix after the replacement branch is pushed";
}

function validatePrCloseCoverageProof({
  result,
  action,
  actionName,
  target,
  live,
  classification,
  coveringRef,
}: LooseRecord): PrCloseCoverageProofValidation {
  if (!coveringRef || coveringRef === target || !live.pull_request) return null;

  let source: PrCloseCoverageProofPullRequestView;
  let covering: PrCloseCoverageProofPullRequestView;
  try {
    const coveringIssue = fetchIssue(result.repo, coveringRef);
    if (!coveringIssue.pull_request) return null;

    source = hydratePrCloseCoveragePullRequest(result.repo, target, live);
    covering = hydratePrCloseCoveragePullRequest(result.repo, coveringRef, coveringIssue);
    if (!prCloseCoverageProofCandidateCanClose(covering)) {
      return {
        status: "blocked",
        reason: `PR close coverage proof requires an open or merged covering pull request; #${coveringRef} is ${covering.state}`,
      };
    }
    const coveringSafetyBlock = validatePrCloseCoverageCoveringSafety({
      result,
      coveringRef,
      coveringIssue,
      covering,
    });
    if (coveringSafetyBlock) {
      return { status: "blocked", reason: coveringSafetyBlock };
    }
  } catch (error) {
    return prCloseCoverageProofSetupFailureBlock(error);
  }

  try {
    const proof = runPrCloseCoverageProofModel({
      source,
      covering,
      markdown: prCloseCoverageProofRepairSourceReport({
        result,
        action,
        actionName,
        classification,
        target,
        live,
        coveringRef,
      }),
      relationshipSignalSnippets: prCloseCoverageProofRelationshipSignals({
        action,
        actionName,
        coveringRef,
      }),
      runtime: prCloseCoverageProofRuntime(),
    });
    const closeDecision = prCloseCoverageProofCloseDecision(proof);
    if (closeDecision.close) {
      return {
        status: "covered",
        coveringRef,
        coveringUpdatedAt: covering.updatedAt,
        proof: closeDecision.proof,
      };
    }
    return {
      status: "blocked",
      reason: `PR close coverage proof kept the source pull request open: ${closeDecision.reason}`,
      pr_close_coverage_proof: closeDecision.proof,
    };
  } catch (error) {
    return {
      status: "blocked",
      requeue_required: true,
      reason: prCloseCoverageProofFailureReason(error),
    };
  }
}

function prCloseCoverageProofSetupFailureBlock(
  error: unknown,
): Extract<PrCloseCoverageProofValidation, { status: "blocked" }> {
  return { status: "blocked", ...prCloseCoverageProofFailureBlock(error) };
}

function prCloseCoverageProofFailureBlock(error: unknown): PrCloseCoverageProofBlock {
  const block = { reason: prCloseCoverageProofFailureReason(error) };
  return prCloseCoverageProofFailureIsTerminal(error)
    ? block
    : { ...block, requeue_required: true };
}

function prCloseCoverageProofFailureIsTerminal(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /\b(?:issue|pull) not found: #\d+\b/i.test(text) || /\bHTTP 404\b/i.test(text);
}

function validatePrCloseCoverageCoveringFreshness({
  result,
  coveringRef,
  coveringUpdatedAt,
}: LooseRecord): string {
  const expectedUpdatedAt = stringOrNull(coveringUpdatedAt);
  if (!expectedUpdatedAt) return "";

  try {
    const liveUpdatedAt = prCloseCoverageCoveringUpdatedAt(result.repo, coveringRef);
    if (liveUpdatedAt === expectedUpdatedAt) return "";
    return `linked canonical PR #${coveringRef} changed after coverage proof`;
  } catch (error) {
    return prCloseCoverageProofFailureReason(error);
  }
}

function validatePrCloseCoverageCoveringRefSafety({
  result,
  target,
  live,
  coveringRef,
}: LooseRecord): PrCloseCoverageProofBlock | null {
  if (!coveringRef || coveringRef === target || !live.pull_request) return null;

  try {
    const coveringIssue = fetchIssue(result.repo, coveringRef);
    if (!coveringIssue.pull_request) return null;
    const coveringPull = fetchPullRequest(result.repo, coveringRef);
    const covering = {
      state:
        stringFromUnknown(coveringPull.state) ||
        stringFromUnknown(coveringIssue.state) ||
        "unknown",
      mergedAt: stringOrNull(coveringPull.merged_at ?? coveringPull.mergedAt),
    };
    if (!prCloseCoverageProofCandidateCanClose(covering)) {
      return {
        reason: `PR close coverage proof requires an open or merged covering pull request; #${coveringRef} is ${covering.state}`,
      };
    }
    const coveringSafetyBlock = validatePrCloseCoverageCoveringSafety({
      result,
      coveringRef,
      coveringIssue,
      covering,
    });
    return coveringSafetyBlock ? { reason: coveringSafetyBlock } : null;
  } catch (error) {
    return prCloseCoverageProofFailureBlock(error);
  }
}

function prCloseCoverageProofFailureReason(error: unknown): string {
  return `PR close coverage proof failed: ${error instanceof Error ? error.message : String(error)}`;
}

function prCloseCoverageCoveringUpdatedAt(repo: string, number: JsonValue): string | null {
  const pull = fetchPullRequest(repo, number);
  const pullUpdatedAt = stringOrNull(pull.updated_at ?? pull.updatedAt);
  if (pullUpdatedAt) return pullUpdatedAt;
  const issue = fetchIssue(repo, number);
  return stringOrNull(issue.updated_at ?? issue.updatedAt);
}

function validatePrCloseCoverageCoveringSafety({
  result,
  coveringRef,
  coveringIssue,
  covering,
}: LooseRecord): string {
  if (covering.mergedAt) return "";
  const pullRequest = fetchPullRequest(result.repo, coveringRef);
  const view = fetchPullRequestView(result.repo, coveringRef);
  const mergeBlock = validateMergeablePullRequest({
    pullRequest,
    view,
    allowedMergeStates: VIABLE_COVERING_PR_MERGE_STATES,
  });
  if (mergeBlock) return formatCoveringPullRequestBlock(coveringRef, mergeBlock);
  if (resultHasPlannedCloseForTarget(result, coveringRef)) {
    return `linked canonical PR #${coveringRef} is itself proposed for close`;
  }

  const labels = labelNames(coveringIssue.labels).map(normalizeLabelName);
  const proofPassed = labels.some((label) => /^proof:\s*(sufficient|override)\b/i.test(label));
  const needsProof = labels.some(
    (label) =>
      label === "triage: needs-real-behavior-proof" ||
      (label.startsWith("status:") && label.includes("needs proof")),
  );
  if (labels.some((label) => label.startsWith("rating:") && label.includes("unranked"))) {
    return `linked canonical PR #${coveringRef} is F-rated`;
  }
  if (needsProof && !proofPassed) {
    return `linked canonical PR #${coveringRef} is still waiting for real behavior proof`;
  }
  if (!proofPassed) {
    return `linked canonical PR #${coveringRef} has no positive real behavior proof`;
  }
  return "";
}

function formatCoveringPullRequestBlock(coveringRef: JsonValue, reason: string): string {
  if (reason === "pull request is draft") {
    return `linked canonical PR #${coveringRef} is still draft`;
  }
  if (reason === "mergeable state is CONFLICTING") {
    return `linked canonical PR #${coveringRef} has merge conflicts`;
  }
  return `linked canonical PR #${coveringRef} ${reason}`;
}

function resultHasPlannedCloseForTarget(result: LooseRecord, target: JsonValue): boolean {
  return (result.actions ?? []).some(
    (entry: JsonValue) =>
      CLOSE_ACTIONS.has(String(entry?.action ?? "")) &&
      normalizeIssueRef(entry?.target, result.repo) === target &&
      String(entry?.status ?? "") === "planned",
  );
}

function labelNames(value: JsonValue): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry: JsonValue) => {
      if (typeof entry === "string") return entry;
      return stringFromUnknown(entry?.name);
    })
    .filter((entry: string) => entry.trim());
}

function normalizeLabelName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function prCloseCoverageProofRepairSourceReport({
  result,
  action,
  actionName,
  classification,
  target,
  live,
  coveringRef,
}: LooseRecord) {
  const evidence = Array.isArray(action.evidence) ? action.evidence.map(compactSignalText) : [];
  const lines = [
    "# PR A repair close action report",
    "",
    `Repository: ${stringFromUnknown(result.repo) || "unknown"}`,
    `Source PR A: #${target} ${stringFromUnknown(live.title) || ""}`.trim(),
    `Covering PR B: #${coveringRef}`,
    `Action: ${actionName}`,
    `Classification: ${classification}`,
    `Reason: ${stringFromUnknown(action.reason) || "none"}`,
    `Close comment: ${stringFromUnknown(action.comment) || "none"}`,
    "",
    "Evidence:",
    ...(evidence.length ? evidence.map((entry: string) => `- ${entry}`) : ["- none"]),
  ];
  return lines.join("\n");
}

function hydratePrCloseCoveragePullRequest(
  repo: string,
  number: LooseRecord,
  issue: LooseRecord,
): PrCloseCoverageProofPullRequestView {
  const pull = fetchPullRequest(repo, number);
  const commentsWindow = fetchPrCloseCoverageProofCommentWindow(
    repo,
    number,
    issue.comments,
    PR_CLOSE_COVERAGE_PROOF_COMMENT_LIMIT,
  );
  const comments = commentsWindow.comments.filter(
    (comment: JsonValue) => !isClawSweeperNoiseComment(comment),
  );
  return {
    number: Number(number),
    title: stringFromUnknown(pull.title) || stringFromUnknown(issue.title) || `#${number}`,
    url:
      stringFromUnknown(pull.html_url) ||
      stringFromUnknown(pull.url) ||
      stringFromUnknown(issue.html_url) ||
      "",
    state: stringFromUnknown(pull.state) || stringFromUnknown(issue.state) || "unknown",
    mergedAt: stringOrNull(pull.merged_at ?? pull.mergedAt),
    body: compactPrCloseCoverageProofText(pull.body),
    updatedAt: stringOrNull(pull.updated_at ?? pull.updatedAt ?? issue.updated_at),
    comments: compactPrCloseCoverageProofCommentWindow(
      comments,
      comments.length,
      PR_CLOSE_COVERAGE_PROOF_COMMENT_LIMIT,
    ),
    commentsTruncated: commentsWindow.total > PR_CLOSE_COVERAGE_PROOF_COMMENT_LIMIT,
  };
}

function rawCommentBody(value: JsonValue): string {
  return stringFromUnknown(value?.body);
}

function isClawSweeperComment(value: JsonValue): boolean {
  const author = stringFromUnknown(value?.user?.login).toLowerCase();
  return CLAWSWEEPER_BOT_AUTHORS.has(author);
}

function isClawSweeperNoiseComment(value: JsonValue): boolean {
  const body = rawCommentBody(value);
  if (CLAWSWEEPER_COMMAND_ONLY_PATTERN.test(body.trim())) return true;
  if (!body.trim() || !isClawSweeperComment(value)) return false;
  if (/<!--\s*clawsweeper-review\s+item=/i.test(body)) return true;
  if (/clawsweeper-review-status:/i.test(body)) return true;
  if (/clawsweeper-command(?:-status|-ack)?:/i.test(body)) return true;
  if (/clawsweeper-close-applied\s+item=/i.test(body)) return true;
  if (/clawsweeper-repair:close:/i.test(body)) return true;
  if (/^ClawSweeper status: review started\./i.test(body)) return true;
  return false;
}

function fetchPrCloseCoverageProofCommentWindow(
  repo: string,
  number: LooseRecord,
  commentsCount: JsonValue,
  limit: number,
): { comments: JsonValue[]; total: number } {
  const apiPath = `repos/${repo}/issues/${number}/comments`;
  const total = nonNegativeIntegerFromUnknown(commentsCount);
  if (total === null) {
    return fetchPrCloseCoverageProofCommentWindowWithoutCount(apiPath, limit);
  }
  if (total === 0 || limit <= 0) {
    return { comments: [], total };
  }
  if (total <= limit) {
    return {
      comments: fetchPrCloseCoverageProofCommentPage(
        apiPath,
        Math.min(total, GITHUB_MAX_PAGE_SIZE),
        1,
      ),
      total,
    };
  }

  if (total <= GITHUB_MAX_PAGE_SIZE) {
    return {
      comments: fetchPrCloseCoverageProofCommentPage(apiPath, total, 1),
      total,
    };
  }

  const keepStart = Math.floor(limit / 2);
  const keepEnd = Math.max(0, limit - keepStart);
  const first = fetchPrCloseCoverageProofCommentPage(apiPath, keepStart, 1);
  const last = fetchLastPrCloseCoverageProofComments(apiPath, total, keepEnd);
  return { comments: [...first, ...last], total };
}

function fetchPrCloseCoverageProofCommentWindowWithoutCount(
  apiPath: string,
  limit: number,
): { comments: JsonValue[]; total: number } {
  const boundedLimit = Math.max(0, Math.floor(limit));
  if (boundedLimit <= 0) return { comments: [], total: 0 };
  const first = fetchPrCloseCoverageProofCommentPageWithHeaders(apiPath, GITHUB_MAX_PAGE_SIZE, 1);
  const lastPage =
    first.lastPageNumber ?? (first.comments.length < GITHUB_MAX_PAGE_SIZE ? 1 : null);
  if (lastPage === null) {
    const comments = ghPaged(apiPath);
    return { comments, total: comments.length };
  }
  if (lastPage <= 1) {
    return {
      comments: first.comments,
      total: first.comments.length,
    };
  }

  const last = fetchPrCloseCoverageProofCommentPageWithHeaders(
    apiPath,
    GITHUB_MAX_PAGE_SIZE,
    lastPage,
  ).comments;
  const total = Math.max(0, (lastPage - 1) * GITHUB_MAX_PAGE_SIZE + last.length);
  const keepStart = Math.floor(boundedLimit / 2);
  const keepEnd = Math.max(0, boundedLimit - keepStart);
  const head = first.comments.slice(0, keepStart);
  let tailSource = last;
  if (last.length < keepEnd && lastPage > 1) {
    const previous =
      lastPage - 1 === 1
        ? first.comments
        : fetchPrCloseCoverageProofCommentPage(apiPath, GITHUB_MAX_PAGE_SIZE, lastPage - 1);
    tailSource = [...previous, ...last];
  }
  return { comments: [...head, ...tailSource.slice(-keepEnd)], total };
}

function fetchLastPrCloseCoverageProofComments(
  apiPath: string,
  total: number,
  limit: number,
): JsonValue[] {
  if (limit <= 0) return [];
  const lastPage = Math.max(1, Math.ceil(total / GITHUB_MAX_PAGE_SIZE));
  const lastPageComments = fetchPrCloseCoverageProofCommentPage(
    apiPath,
    GITHUB_MAX_PAGE_SIZE,
    lastPage,
  );
  if (lastPageComments.length >= limit || lastPage <= 1) {
    return lastPageComments.slice(Math.max(0, lastPageComments.length - limit));
  }
  const previousPageComments = fetchPrCloseCoverageProofCommentPage(
    apiPath,
    GITHUB_MAX_PAGE_SIZE,
    lastPage - 1,
  );
  return [...previousPageComments, ...lastPageComments].slice(-limit);
}

function fetchPrCloseCoverageProofCommentPage(
  apiPath: string,
  perPage: number,
  page: number,
): JsonValue[] {
  const entries = ghJson<JsonValue[]>(["api", githubLimitedPagePath(apiPath, perPage, page)]);
  return Array.isArray(entries) ? entries : [];
}

function fetchPrCloseCoverageProofCommentPageWithHeaders(
  apiPath: string,
  perPage: number,
  page: number,
): { comments: JsonValue[]; lastPageNumber: number | null } {
  const limitedPath = githubLimitedPagePath(apiPath, perPage, page);
  const output = ghWithRetry(["api", "-i", limitedPath]);
  const { body, headers } = splitGithubResponse(output);
  const entries = JSON.parse(body || "[]") as JsonValue;
  return {
    comments: Array.isArray(entries) ? entries : [],
    lastPageNumber: githubLastPageNumber(headers),
  };
}

function splitGithubResponse(output: string): { headers: string; body: string } {
  const normalized = output.replace(/\r\n/g, "\n");
  const separator = normalized.lastIndexOf("\n\n");
  if (separator < 0) return { headers: "", body: normalized };
  return {
    headers: normalized.slice(0, separator),
    body: normalized.slice(separator + 2),
  };
}

function githubLastPageNumber(headers: string): number | null {
  for (const line of headers.split("\n")) {
    const delimiter = line.indexOf(":");
    if (delimiter <= 0) continue;
    if (line.slice(0, delimiter).trim().toLowerCase() !== "link") continue;
    for (const part of line.slice(delimiter + 1).split(",")) {
      if (!part.includes('rel="last"')) continue;
      const page = part.match(/[?&]page=(\d+)/)?.[1];
      if (!page) continue;
      const value = Number(page);
      if (Number.isSafeInteger(value) && value > 0) return value;
    }
  }
  return null;
}

function compactPrCloseCoverageProofCommentWindow(
  comments: JsonValue[],
  total: number,
  limit: number,
): unknown[] {
  const boundedLimit = Math.max(0, Math.floor(limit));
  const boundedTotal = Math.max(0, Math.floor(total));
  if (boundedTotal <= boundedLimit && comments.length <= boundedLimit) {
    return comments.map(compactPrCloseCoverageProofComment);
  }
  if (boundedLimit === 0) {
    return [{ omitted: boundedTotal, note: "comments omitted from proof context" }];
  }
  const keepStart = Math.floor(boundedLimit / 2);
  const keepEnd = Math.max(0, boundedLimit - keepStart);
  const omitted = Math.max(0, boundedTotal - keepStart - keepEnd);
  return [
    ...comments.slice(0, keepStart).map(compactPrCloseCoverageProofComment),
    ...(omitted > 0 ? [{ omitted, note: "middle comments omitted from proof context" }] : []),
    ...comments.slice(comments.length - keepEnd).map(compactPrCloseCoverageProofComment),
  ];
}

function prCloseCoverageProofRelationshipSignals({ action, actionName, coveringRef }: LooseRecord) {
  const signals = [
    `action: ${actionName}`,
    `covering_ref: #${coveringRef}`,
    stringFromUnknown(action.reason),
    stringFromUnknown(action.comment),
    ...(Array.isArray(action.evidence) ? action.evidence : []).map(compactSignalText),
  ];
  return signals.filter((signal: JsonValue) => typeof signal === "string" && signal.trim());
}

function prCloseCoverageProofRuntime() {
  const ghToken = stringSetting(process.env.CLAWSWEEPER_PROOF_INSPECTION_TOKEN, "");
  const runtime = {
    model: stringSetting(
      args["pr-close-coverage-proof-model"] ??
        process.env.CLAWSWEEPER_PR_CLOSE_COVERAGE_PROOF_MODEL ??
        process.env.CLAWSWEEPER_MODEL,
      "internal",
    ),
    reasoningEffort: stringSetting(
      args["pr-close-coverage-proof-reasoning-effort"] ??
        process.env.CLAWSWEEPER_PR_CLOSE_COVERAGE_PROOF_REASONING_EFFORT,
      "high",
    ),
    sandboxMode: stringSetting(
      args["pr-close-coverage-proof-sandbox"] ??
        process.env.CLAWSWEEPER_PR_CLOSE_COVERAGE_PROOF_SANDBOX,
      "read-only",
    ),
    serviceTier: stringSetting(
      args["pr-close-coverage-proof-service-tier"] ??
        process.env.CLAWSWEEPER_PR_CLOSE_COVERAGE_PROOF_SERVICE_TIER,
      "",
    ),
    timeoutMs: positiveIntegerSetting(
      args["pr-close-coverage-proof-timeout-ms"] ??
        process.env.CLAWSWEEPER_PR_CLOSE_COVERAGE_PROOF_TIMEOUT_MS,
      900_000,
    ),
    workDir: path.join(path.dirname(resultPath), "pr-close-coverage-proof"),
    rootDir: repoRoot(),
    schemaPath: path.join(repoRoot(), "schema/clawsweeper-pr-close-coverage-proof.schema.json"),
    promptTemplate: fs.readFileSync(
      path.join(repoRoot(), "prompts/pr-close-coverage-proof.md"),
      "utf8",
    ),
  };
  return ghToken ? { ...runtime, ghToken } : runtime;
}

function validateMergeablePullRequest({
  pullRequest,
  view,
  allowedMergeStates = CLEAN_MERGE_STATES,
}: LooseRecord) {
  if (pullRequest.state !== "open") return `pull request is ${pullRequest.state}`;
  if (pullRequest.draft || view.isDraft) return "pull request is draft";
  if (String(view.baseRefName ?? pullRequest.base?.ref ?? "") !== "main")
    return "pull request base is not main";
  if (view.mergeable !== "MERGEABLE") return `mergeable state is ${view.mergeable || "unknown"}`;
  if (!allowedMergeStates.has(String(view.mergeStateStatus ?? ""))) {
    return `merge state status is ${view.mergeStateStatus || "unknown"}`;
  }
  if (["CHANGES_REQUESTED", "REVIEW_REQUIRED"].includes(String(view.reviewDecision ?? ""))) {
    return `review decision is ${view.reviewDecision}`;
  }
  const checkBlock = validateStatusChecks(view.statusCheckRollup ?? []);
  if (checkBlock) return checkBlock;
  return "";
}

function validateStatusChecks(checks: LooseRecord[]) {
  if (!Array.isArray(checks) || checks.length === 0) return "no PR checks found";
  const blockers: LooseRecord[] = [];
  for (const check of checks) {
    const name = check.name ?? check.context ?? "unknown check";
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
  if (blockers.length > 0) return `checks are not clean: ${blockers.slice(0, 5).join(", ")}`;
  return "";
}

function isApplicatorAction(action: LooseRecord) {
  return (
    CLOSE_ACTIONS.has(String(action?.action ?? "")) ||
    MERGE_ACTIONS.has(String(action?.action ?? ""))
  );
}

function blockedClosureDependencyOutcome({
  result,
  action,
  dryRun,
  closureOutcomes,
}: Readonly<{
  result: LooseRecord;
  action: LooseRecord;
  dryRun: boolean;
  closureOutcomes: Map<string, LooseRecord>;
}>): LooseRecord | null {
  if (action.status !== "planned" || !CLOSE_ACTIONS.has(String(action.action ?? ""))) return null;
  const dependencies = repairClosureDependencyRefs(action);
  if (dependencies.length === 0) return null;

  const unsatisfied = dependencies
    .map((dependency) => ({ dependency, outcome: closureOutcomes.get(dependency) }))
    .filter(
      ({ outcome }) => outcome?.status !== "executed" && !(dryRun && outcome?.status === "planned"),
    );
  if (unsatisfied.length === 0) return null;

  const { base } = repairActionContext(result, action);
  return {
    ...base,
    status: "blocked",
    depends_on: dependencies,
    dependency_outcomes: unsatisfied.map(({ dependency, outcome }) => ({
      target: dependency,
      status: outcome?.status ?? "missing",
    })),
    reason: `closure prerequisites did not close successfully: ${unsatisfied
      .map(({ dependency, outcome }) => `${dependency} (${outcome?.status ?? "missing"})`)
      .join(", ")}`,
  };
}

function repairActionContext(result: LooseRecord, action: LooseRecord): LooseRecord {
  const relationship = resolveRepairClosureRelationship(action);
  const target = normalizeIssueRef(action.target, result.repo);
  const actionName = String(action.action ?? "");
  const classification = relationship.classification;
  const canonical = normalizeIssueRef(relationship.canonical, result.repo);
  const candidateFix = normalizeIssueRef(relationship.candidateFix, result.repo);
  const relationshipRoot = normalizeIssueRef(relationship.root, result.repo);
  const idempotencyKey =
    typeof action.idempotency_key === "string" && action.idempotency_key.trim()
      ? action.idempotency_key.trim()
      : defaultIdempotencyKey(result.cluster_id, target, actionName, classification);
  return {
    target,
    actionName,
    classification,
    canonical,
    candidateFix,
    relationshipRoot,
    idempotencyKey,
    base: {
      target: `#${target}`,
      action: actionName,
      classification,
      canonical: canonical ? `#${canonical}` : undefined,
      candidate_fix: candidateFix ? `#${candidateFix}` : undefined,
      idempotency_key: idempotencyKey,
    },
  };
}

function normalizeRepairClosureRef(value: JsonValue): string {
  const number = normalizeIssueRef(value);
  return number ? `#${number}` : "";
}

function normalizeIssueRef(value: JsonValue, expectedRepo: JsonValue = "") {
  return issueNumberFromRef(value, String(expectedRepo ?? ""));
}

function defaultIdempotencyKey(
  clusterId: string,
  target: LooseRecord,
  actionName: JsonValue,
  classification: JsonValue,
) {
  return sha256(`${clusterId}:${target}:${actionName}:${classification}`).slice(0, 24);
}

function idempotencyMarker(clusterId: string, target: LooseRecord, key: string) {
  return `<!-- clawsweeper-repair:close:${clusterId}:#${target}:${key} -->`;
}

function renderCloseComment({ action, classification, result, target, live }: LooseRecord) {
  if (typeof action.comment === "string" && action.comment.trim()) return action.comment;
  const canonical = normalizeIssueRef(action.canonical ?? action.duplicate_of);
  const candidateFix = normalizeIssueRef(
    action.candidate_fix ?? action.fixed_by ?? action.fix_candidate,
  );
  const title = typeof live.title === "string" ? live.title : `#${target}`;
  const reason = action.reason ? String(action.reason).trim() : closeReasonText(classification);
  return defaultCloseComment({
    action,
    classification,
    clusterId: result.cluster_id,
    target,
    title,
    canonical,
    candidateFix,
    reason,
    provenance: externalMessageProvenance({
      reviewedSha: action.reviewed_sha ?? action.head_sha ?? result.reviewed_sha ?? result.head_sha,
    }),
  });
}

function closeReasonText(classification: JsonValue) {
  switch (classification) {
    case "duplicate":
      return "duplicate of the canonical thread";
    case "superseded":
      return "superseded by the canonical candidate";
    case "fixed_by_candidate":
      return "covered by the candidate fix";
    case "low_signal":
      return "low-signal PR cleanup";
    default:
      return "closed by clawsweeper-repair";
  }
}

function validateLowSignalIntent({ job, action, actionName, classification }: LooseRecord) {
  if (job.frontmatter.triage_policy !== "low_signal_prs") {
    return "low-signal close requires triage_policy: low_signal_prs";
  }
  if (job.frontmatter.allow_low_signal_pr_close !== true) {
    return "low-signal close requires allow_low_signal_pr_close: true";
  }
  if (actionName !== "close_low_signal" || classification !== "low_signal") {
    return "low-signal close requires close_low_signal action and low_signal classification";
  }
  if (action.target_kind !== "pull_request") {
    return "low-signal close requires pull_request target_kind";
  }
  return "";
}

function validateLowSignalLiveState(
  repo: string,
  target: LooseRecord,
  live: LooseRecord,
  kind: string,
) {
  if (kind !== "pull_request") return "low-signal cleanup may only close pull requests";
  if (hasSecuritySignal(live)) return "security-sensitive target requires human triage";
  if (Array.isArray(live.assignees) && live.assignees.length > 0) {
    return "assigned PR has maintainer/human signal";
  }

  const pullRequest = fetchPullRequest(repo, target);
  if (
    (pullRequest.requested_reviewers ?? []).length > 0 ||
    (pullRequest.requested_teams ?? []).length > 0
  ) {
    return "requested reviewers or teams indicate active review signal";
  }

  const maintainerComments = ghPaged(`repos/${repo}/issues/${target}/comments`).filter(
    (comment: JsonValue) =>
      MAINTAINER_AUTHOR_ASSOCIATIONS.has(normalizeAuthorAssociation(comment.author_association)),
  );
  if (maintainerComments.length > 0) return "maintainer issue comment blocks low-signal auto-close";

  const maintainerReviews = ghPaged(`repos/${repo}/pulls/${target}/reviews`).filter(
    (review: JsonValue) =>
      MAINTAINER_AUTHOR_ASSOCIATIONS.has(normalizeAuthorAssociation(review.author_association)),
  );
  if (maintainerReviews.length > 0) return "maintainer PR review blocks low-signal auto-close";

  return "";
}

function hasSecuritySignal(issue: LooseRecord) {
  if (hasDeterministicSecuritySignal({ labels: issue.labels ?? [] })) return true;
  const comments = ghPaged(`repos/${result.repo}/issues/${issue.number}/comments?per_page=100`).map(
    (comment: JsonValue) => comment.body ?? "",
  );
  return hasDeterministicSecuritySignal({ comments });
}

function fetchIssue(repo: string, number: JsonValue) {
  return ghJson(["api", `repos/${repo}/issues/${number}`]);
}

function fetchPullRequest(repo: string, number: JsonValue) {
  return ghJson(["api", `repos/${repo}/pulls/${number}`]);
}

function fetchPullRequestView(repo: string, number: JsonValue) {
  return ghJson([
    "pr",
    "view",
    String(number),
    "--repo",
    repo,
    "--json",
    [
      "baseRefName",
      "isDraft",
      "mergeable",
      "mergeCommit",
      "mergeStateStatus",
      "mergedAt",
      "reviewDecision",
      "state",
      "statusCheckRollup",
      "title",
      "updatedAt",
      "url",
    ].join(","),
  ]);
}

function findExistingComment(repo: string, number: JsonValue, marker: LooseRecord, body: string) {
  const comments = ghPaged(`repos/${repo}/issues/${number}/comments`);
  return comments.find(
    (comment: JsonValue) =>
      isClawSweeperComment(comment) && (comment.body?.includes(marker) || comment.body === body),
  );
}

function postIssueComment(repo: string, number: JsonValue, body: string) {
  const payloadPath = writePayload(`comment-${number}`, { body });
  ghWithRetry([
    "api",
    `repos/${repo}/issues/${number}/comments`,
    "--method",
    "POST",
    "--input",
    payloadPath,
  ]);
}

function closeIssueOrPullRequest(
  repo: string,
  number: JsonValue,
  kind: string,
  classification: JsonValue,
) {
  if (kind === "pull_request") {
    ghWithRetry(["pr", "close", String(number), "--repo", repo]);
    return;
  }
  const stateReason = classification === "fixed_by_candidate" ? "completed" : "not_planned";
  const payloadPath = writePayload(`close-${number}`, {
    state: "closed",
    state_reason: stateReason,
  });
  ghWithRetry([
    "api",
    `repos/${repo}/issues/${number}`,
    "--method",
    "PATCH",
    "--input",
    payloadPath,
  ]);
}

function writePayload(name: string, value: JsonValue) {
  const dir = path.join(repoRoot(), ".clawsweeper-repair", "payloads");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
  return file;
}

function normalizeAuthorAssociation(value: JsonValue) {
  return typeof value === "string" && value.trim() ? value.trim().toUpperCase() : "NONE";
}

function stringFromUnknown(value: JsonValue) {
  return typeof value === "string" ? value : "";
}

function stringOrNull(value: JsonValue) {
  return typeof value === "string" && value.trim() ? value : null;
}

function nonNegativeIntegerFromUnknown(value: JsonValue): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

function compactSignalText(value: JsonValue) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

function stringSetting(value: JsonValue, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function positiveIntegerSetting(value: JsonValue, fallback: number) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

function sha256(text: string) {
  return createHash("sha256").update(text).digest("hex");
}
