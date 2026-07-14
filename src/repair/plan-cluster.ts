#!/usr/bin/env node
import type { JsonValue, LooseRecord } from "./json-types.js";
import fs from "node:fs";
import path from "node:path";
import {
  assertAllowedOwner,
  hasDeterministicSecuritySignal,
  makeRunDir,
  parseArgs,
  parseJob,
  repoRoot,
  validateJob,
} from "./lib.js";
import { ghJson, ghPaged, ghPagedLimit, ghText } from "./github-cli.js";
import { hasSecurityRepairOptInLabel } from "./security-boundary.js";

function readNonNegativeIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    console.warn(`${name} must be a non-negative integer; using default ${fallback}`);
    return fallback;
  }
  return Math.floor(value);
}

const MAX_LINKED_REFS = readNonNegativeIntegerEnv("CLAWSWEEPER_MAX_LINKED_REFS", 0);
const HYDRATE_COMMENTS = process.env.CLAWSWEEPER_HYDRATE_COMMENTS === "1";
const MAX_COMMENTS_PER_ITEM = readNonNegativeIntegerEnv("CLAWSWEEPER_MAX_COMMENTS_PER_ITEM", 30);
const MAX_REVIEW_COMMENTS_PER_PR = readNonNegativeIntegerEnv(
  "CLAWSWEEPER_MAX_REVIEW_COMMENTS_PER_PR",
  50,
);
const MAX_FILES_PER_PR = readNonNegativeIntegerEnv("CLAWSWEEPER_MAX_FILES_PER_PR", 80);
const MAX_COMMITS_PER_PR = readNonNegativeIntegerEnv("CLAWSWEEPER_MAX_COMMITS_PER_PR", 80);
const MAINTAINER_AUTHOR_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const REVIEW_BOT_PATTERN =
  /\b(greptile|codex|asile|coderabbit|code rabbit|copilot|reviewdog|sonar|deepsource|codecov|github-actions)\b/i;

const args = parseArgs(process.argv.slice(2));
const jobPath = args._[0];
const offline = Boolean(args.offline);
const hydrateClusterRefs =
  Boolean(args["hydrate-cluster-refs"]) || process.env.CLAWSWEEPER_HYDRATE_CLUSTER_REFS === "1";

if (!jobPath) {
  console.error("usage: node scripts/plan-cluster.ts <job.md> [--run-dir dir] [--offline]");
  process.exit(2);
}

const job = parseJob(jobPath);
const errors = validateJob(job);
if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}

assertAllowedOwner(job.frontmatter.repo, process.env.CLAWSWEEPER_ALLOWED_OWNER);

const runDir = args["run-dir"]
  ? path.resolve(String(args["run-dir"]))
  : makeRunDir(job, `${job.frontmatter.mode}-cluster-plan`);
fs.mkdirSync(runDir, { recursive: true });

const primaryRefs = [
  ...(job.frontmatter.canonical ?? []),
  ...(job.frontmatter.candidates ?? []),
].map((ref: JsonValue) => normalizeRef(job.frontmatter.repo, ref));
const contextRefs = (job.frontmatter.cluster_refs ?? []).map((ref: JsonValue) =>
  normalizeRef(job.frontmatter.repo, ref),
);
const seedRefs = uniqueRefs(hydrateClusterRefs ? [...primaryRefs, ...contextRefs] : primaryRefs);

const externalRefs = seedRefs.filter((ref: JsonValue) => ref.repo !== job.frontmatter.repo);
const seedNumbers = seedRefs
  .filter((ref: JsonValue) => ref.repo === job.frontmatter.repo)
  .map((ref: JsonValue) => ref.number);

const items = new Map();
const linkedRefs = new Map();
const pending = [...new Set(seedNumbers)].map((number: string) => ({ number, depth: 0 }));
let linkedHydrateCount = 0;
const branch = offline
  ? offlineMainBranch(job.frontmatter.repo)
  : fetchMainBranch(job.frontmatter.repo);

while (pending.length > 0) {
  const next = pending.shift();
  const number = next?.number;
  if (!number || items.has(number)) continue;

  const item = offline
    ? offlineItem(job.frontmatter.repo, number, job)
    : hydrateItem(job.frontmatter.repo, number);
  items.set(number, item);

  if (offline || next.depth > 0) continue;
  for (const linked of extractLinkedRefs(job.frontmatter.repo, item)) {
    const key = `${linked.repo}#${linked.number}`;
    linkedRefs.set(key, linked);
    const alreadyPending = pending.some((entry: JsonValue) => entry.number === linked.number);
    if (
      linked.repo === job.frontmatter.repo &&
      !items.has(linked.number) &&
      !alreadyPending &&
      linkedHydrateCount < MAX_LINKED_REFS
    ) {
      pending.push({ number: linked.number, depth: next.depth + 1 });
      linkedHydrateCount += 1;
    }
  }
}

const itemList = [...items.values()].sort(
  (left: JsonValue, right: JsonValue) => left.number - right.number,
);
const securitySensitiveItems = itemList.filter((item: JsonValue) =>
  itemSecuritySensitive(item, job),
);
const securityRepairAllowedItems = itemList.filter((item: JsonValue) =>
  itemSecurityRepairAllowed(item, job),
);
const targetCheckout = resolveTargetCheckout(job);
const plan = {
  repo: job.frontmatter.repo,
  cluster_id: job.frontmatter.cluster_id,
  mode: job.frontmatter.mode,
  triage_policy: job.frontmatter.triage_policy ?? null,
  source_job: job.relativePath,
  target_checkout: targetCheckout,
  generated_at: new Date().toISOString(),
  offline,
  main: branch,
  security_boundary: {
    policy: job.frontmatter.security_policy ?? "central_security_only",
    security_sensitive_items: securitySensitiveItems.map((item: JsonValue) => item.ref),
    security_repair_allowed_items: securityRepairAllowedItems.map((item: JsonValue) => item.ref),
    action:
      securityRepairAllowedItems.length > 0
        ? "Explicit adopted PR repair opt-in allows bounded fix actions for listed security-sensitive refs; merge remains blocked until a clean later review."
        : securitySensitiveItems.length > 0
          ? "Quarantine only listed security-sensitive refs with route_security; continue non-security classification and narrow bug/fix work."
          : "No security-sensitive signal detected in hydrated job refs.",
  },
  scope: {
    seed_refs: seedRefs.map(formatNormalizedRef),
    linked_refs: [...linkedRefs.values()].map(formatNormalizedRef).sort(),
    context_refs: uniqueRefs(contextRefs).map(formatNormalizedRef).sort(),
    external_refs: externalRefs.map(formatNormalizedRef).sort(),
    expansion_policy:
      MAX_LINKED_REFS > 0
        ? "Hydrates job-provided refs and a bounded number of first-hop refs linked from those items."
        : "Hydrates job-provided refs only; first-hop linked refs are recorded but not expanded by default.",
    hydrate_cluster_refs: hydrateClusterRefs,
    max_linked_refs: MAX_LINKED_REFS,
    hydrate_comments: HYDRATE_COMMENTS,
    max_comments_per_item: MAX_COMMENTS_PER_ITEM,
    max_review_comments_per_pr: MAX_REVIEW_COMMENTS_PER_PR,
    max_files_per_pr: MAX_FILES_PER_PR,
    max_commits_per_pr: MAX_COMMITS_PER_PR,
  },
  items: itemList.map((item: JsonValue) => summarizeItem(item, job)),
  canonical_candidates: canonicalCandidates(itemList, job),
  safety_gates: [
    "re-fetch live state before every close/comment/label/merge/fix action",
    securityRepairAllowedItems.length > 0
      ? "only refs listed in security_repair_allowed_items may receive bounded security-sensitive repair; never merge or close them from this job"
      : "security-sensitive refs are out of scope and must route to central OpenClaw security handling without poisoning unrelated items",
    "closed context refs are evidence only; do not emit closure actions for already-closed refs",
    "use needs_human only for the specific unresolved maintainer or product decision",
    "checks, conflicts, or changed state block only the affected merge/fixed-by-candidate mutation",
    "preserve contributor credit in every closeout comment",
  ],
};

const fixArtifact = buildFixArtifact(plan, job);
const clusterPlanPath = path.join(runDir, "cluster-plan.json");
const fixArtifactPath = path.join(runDir, "fix-artifact.json");
fs.writeFileSync(clusterPlanPath, `${JSON.stringify(plan, null, 2)}\n`);
fs.writeFileSync(fixArtifactPath, `${JSON.stringify(fixArtifact, null, 2)}\n`);

console.log(
  JSON.stringify(
    {
      cluster_plan: path.relative(repoRoot(), clusterPlanPath),
      fix_artifact: path.relative(repoRoot(), fixArtifactPath),
      items: itemList.length,
      offline,
    },
    null,
    2,
  ),
);

function hydrateItem(repo: string, number: JsonValue) {
  let issue;
  try {
    issue = ghJson(["api", `repos/${repo}/issues/${number}`]);
  } catch (error) {
    return unavailableItem(repo, number, error);
  }
  const comments = HYDRATE_COMMENTS ? ghPaged(`repos/${repo}/issues/${number}/comments`) : [];
  const pullRequest = issue.pull_request ? ghJson(["api", `repos/${repo}/pulls/${number}`]) : null;
  const files = pullRequest
    ? ghPagedLimit(`repos/${repo}/pulls/${number}/files`, MAX_FILES_PER_PR)
    : [];
  const commits = pullRequest
    ? ghPagedLimit(`repos/${repo}/pulls/${number}/commits`, MAX_COMMITS_PER_PR)
    : [];
  const reviews = pullRequest ? ghPaged(`repos/${repo}/pulls/${number}/reviews`) : [];
  const reviewComments = pullRequest ? ghPaged(`repos/${repo}/pulls/${number}/comments`) : [];
  const changedFilesCount = countValue(pullRequest?.changed_files, files.length);
  const commitsCount = countValue(pullRequest?.commits, commits.length);
  const checks = pullRequest ? ghPrChecks(repo, number) : [];

  return {
    repo,
    number,
    ref: `#${number}`,
    kind: pullRequest ? "pull_request" : "issue",
    state: issue.state,
    title: issue.title,
    html_url: issue.html_url,
    author: issue.user?.login,
    author_association: issue.author_association,
    labels: (issue.labels ?? []).map((label: JsonValue) => label.name ?? label).filter(Boolean),
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    body: issue.body ?? "",
    body_excerpt: excerpt(issue.body),
    comments_count: issue.comments ?? comments.length,
    comments: comments.map((comment: JsonValue) => ({
      author: comment.user?.login,
      author_association: comment.author_association,
      created_at: comment.created_at,
      updated_at: comment.updated_at,
      body: comment.body ?? "",
      body_excerpt: excerpt(comment.body),
    })),
    pull_request: pullRequest
      ? {
          draft: pullRequest.draft,
          merged: pullRequest.merged,
          merged_at: pullRequest.merged_at,
          merge_commit_sha: pullRequest.merge_commit_sha,
          mergeable: pullRequest.mergeable,
          mergeable_state: pullRequest.mergeable_state,
          base_ref: pullRequest.base?.ref,
          head_ref: pullRequest.head?.ref,
          head_repo: pullRequest.head?.repo?.full_name,
          head_repo_owner: pullRequest.head?.repo?.owner?.login,
          head_sha: pullRequest.head?.sha,
          maintainer_can_modify: pullRequest.maintainer_can_modify,
          same_repo_head: pullRequest.head?.repo?.full_name === repo,
          branch_writable: branchWritableByAutomation(repo, pullRequest),
          branch_write_reason: branchWriteReason(repo, pullRequest),
          requested_reviewers: (pullRequest.requested_reviewers ?? [])
            .map((reviewer: JsonValue) => reviewer.login)
            .filter(Boolean),
          requested_teams: (pullRequest.requested_teams ?? [])
            .map((team: JsonValue) => team.slug ?? team.name)
            .filter(Boolean),
          additions: pullRequest.additions,
          deletions: pullRequest.deletions,
          changed_files: changedFilesCount,
          files_hydrated: files.length,
          files_truncated: Math.max(0, changedFilesCount - files.length),
          files: files.map((file: JsonValue) => ({
            filename: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
          })),
          commits_count: commitsCount,
          commits_hydrated: commits.length,
          commits_truncated: Math.max(0, commitsCount - commits.length),
          commits: commits.map((commit: JsonValue) => ({
            sha: commit.sha,
            message: firstLine(commit.commit?.message),
            author: commit.author?.login ?? commit.commit?.author?.name,
          })),
          reviews: reviews.map((review: JsonValue) => ({
            author: review.user?.login,
            author_association: review.author_association,
            state: review.state,
            submitted_at: review.submitted_at,
            body_excerpt: excerpt(review.body),
          })),
          review_comments: reviewComments.map((comment: JsonValue) => ({
            author: comment.user?.login,
            author_association: comment.author_association,
            path: comment.path,
            line: comment.line ?? comment.original_line,
            side: comment.side,
            created_at: comment.created_at,
            updated_at: comment.updated_at,
            body: comment.body ?? "",
            body_excerpt: excerpt(comment.body),
            diff_hunk_excerpt: excerpt(comment.diff_hunk, 500),
          })),
          checks,
        }
      : null,
  };
}

function unavailableItem(repo: string, number: JsonValue, error: JsonValue) {
  const reason = firstLine(error?.stderr || error?.message || String(error));
  return {
    repo,
    number,
    ref: `#${number}`,
    kind: "unknown",
    state: "unavailable",
    title: `unavailable ref #${number}`,
    html_url: `https://github.com/${repo}/issues/${number}`,
    author: null,
    author_association: null,
    labels: [],
    created_at: null,
    updated_at: null,
    closed_at: null,
    body: "",
    body_excerpt: reason || "GitHub ref could not be hydrated.",
    comments_count: 0,
    comments: [],
    pull_request: null,
    hydration_error: reason || "GitHub ref could not be hydrated.",
  };
}

function countValue(value: JsonValue, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function summarizeItem(item: LooseRecord, job: LooseRecord) {
  return {
    repo: item.repo,
    ref: item.ref,
    number: item.number,
    kind: item.kind,
    state: item.state,
    title: item.title,
    url: item.html_url,
    author: item.author,
    author_association: item.author_association,
    labels: item.labels,
    created_at: item.created_at,
    updated_at: item.updated_at,
    closed_at: item.closed_at,
    hydration_error: item.hydration_error ?? null,
    body_excerpt: item.body_excerpt,
    security_sensitive: itemSecuritySensitive(item, job),
    security_repair_allowed: itemSecurityRepairAllowed(item, job),
    comments_count: item.comments_count ?? item.comments.length,
    comments_hydrated: item.comments.length,
    comments_truncated: Math.max(0, item.comments.length - MAX_COMMENTS_PER_ITEM),
    comments: item.comments.slice(0, MAX_COMMENTS_PER_ITEM).map(summarizeComment),
    maintainer_comments: item.comments
      .filter((comment: JsonValue) =>
        MAINTAINER_AUTHOR_ASSOCIATIONS.has(normalizeAuthorAssociation(comment.author_association)),
      )
      .slice(0, MAX_COMMENTS_PER_ITEM)
      .map(summarizeComment),
    bot_comments: item.comments
      .filter((comment: JsonValue) => isReviewBotComment(comment))
      .slice(0, MAX_COMMENTS_PER_ITEM)
      .map(summarizeComment),
    classification_hint: classificationHint(item, job),
    pull_request: item.pull_request
      ? {
          draft: item.pull_request.draft,
          merged: item.pull_request.merged,
          merged_at: item.pull_request.merged_at,
          merge_commit_sha: item.pull_request.merge_commit_sha,
          mergeable: item.pull_request.mergeable,
          mergeable_state: item.pull_request.mergeable_state,
          base_ref: item.pull_request.base_ref,
          head_ref: item.pull_request.head_ref,
          head_repo: item.pull_request.head_repo,
          head_repo_owner: item.pull_request.head_repo_owner,
          head_sha: item.pull_request.head_sha,
          maintainer_can_modify: item.pull_request.maintainer_can_modify,
          same_repo_head: item.pull_request.same_repo_head,
          branch_writable: item.pull_request.branch_writable,
          branch_write_reason: item.pull_request.branch_write_reason,
          requested_reviewers: item.pull_request.requested_reviewers,
          requested_teams: item.pull_request.requested_teams,
          changed_files: item.pull_request.changed_files,
          files_hydrated: item.pull_request.files_hydrated,
          files_truncated: item.pull_request.files_truncated,
          additions: item.pull_request.additions,
          deletions: item.pull_request.deletions,
          files: item.pull_request.files,
          commits_count: item.pull_request.commits_count,
          commits_hydrated: item.pull_request.commits_hydrated,
          commits_truncated: item.pull_request.commits_truncated,
          commits: item.pull_request.commits,
          reviews: item.pull_request.reviews,
          review_comments_count: item.pull_request.review_comments.length,
          review_comments_hydrated: item.pull_request.review_comments.length,
          review_comments_truncated: Math.max(
            0,
            item.pull_request.review_comments.length - MAX_REVIEW_COMMENTS_PER_PR,
          ),
          review_comments: item.pull_request.review_comments
            .slice(0, MAX_REVIEW_COMMENTS_PER_PR)
            .map(summarizeReviewComment),
          review_bot_comments: [
            ...item.pull_request.reviews
              .filter((review: JsonValue) => isReviewBotComment(review))
              .map(summarizeReview),
            ...item.pull_request.review_comments
              .filter((comment: JsonValue) => isReviewBotComment(comment))
              .slice(0, MAX_REVIEW_COMMENTS_PER_PR)
              .map(summarizeReviewComment),
          ],
          checks: item.pull_request.checks,
        }
      : null,
  };
}

function buildFixArtifact(plan: LooseRecord, job: LooseRecord) {
  return {
    repo: plan.repo,
    cluster_id: plan.cluster_id,
    mode: plan.mode,
    generated_at: plan.generated_at,
    source_job: plan.source_job,
    target_checkout: plan.target_checkout ?? null,
    permissions: {
      allow_instant_close: job.frontmatter.allow_instant_close === true,
      allow_low_signal_pr_close: job.frontmatter.allow_low_signal_pr_close === true,
      allow_fix_pr: job.frontmatter.allow_fix_pr === true,
      allow_merge: job.frontmatter.allow_merge === true,
      allow_post_merge_close: job.frontmatter.allow_post_merge_close === true,
      require_fix_before_close: job.frontmatter.require_fix_before_close === true,
    },
    canonical_candidates: plan.canonical_candidates,
    item_matrix: plan.items.map((item: JsonValue) => ({
      ref: item.ref,
      kind: item.kind,
      state: item.state,
      updated_at: item.updated_at,
      security_sensitive: item.security_sensitive,
      security_repair_allowed: item.security_repair_allowed,
      hint: item.classification_hint,
    })),
    drive_plan: {
      low_signal_pr_close:
        job.frontmatter.allow_low_signal_pr_close === true
          ? "Worker may emit close_low_signal only for open pull requests that satisfy instructions/low-signal-prs.md, have no maintainer signal, and include live target_updated_at."
          : "Low-signal PR closeout disabled by job frontmatter.",
      instant_close:
        job.frontmatter.allow_instant_close === true
          ? "Worker may emit close_duplicate, close_superseded, or close_fixed_by_candidate actions only with live target_updated_at and canonical/candidate evidence."
          : "Disabled by job frontmatter.",
      canonical_fix:
        job.frontmatter.allow_fix_pr === true
          ? "If no viable canonical PR exists, first repair a useful contributor PR when branch_writable is true. A same-repo head branch is writable even when GitHub reports maintainer_can_modify=false, so do not replace same-repo PRs for that raw flag alone. If branch_writable is false, draft/unmergeable, stale, unsafe, or too broad, replace it with fix_needed plus build_fix_artifact/open_fix_pr using repair_strategy=replace_uneditable_branch, narrow files, tests, release-note context, branch_update_blockers, and source PR credit. Do not ask whether to wait when fix PRs are allowed."
          : "Worker may identify canonical fixes but must not plan a fix PR.",
      merge:
        job.frontmatter.allow_merge === true
          ? "Worker may recommend merge_canonical only after security is cleared, comments/review-bot findings are resolved, Codex /review has passed and findings are addressed, checks/review state/conflicts/release-note context are clean, and merge_preflight is populated."
          : "Merge recommendations must stay non-mutating.",
      post_merge_close:
        job.frontmatter.allow_post_merge_close === true
          ? "After canonical fix confirmation, worker may emit post_merge_close closeout actions for covered refs."
          : "Post-merge closure disabled by job frontmatter.",
      fix_first_close:
        job.frontmatter.require_fix_before_close === true
          ? 'Do not emit planned close actions until ClawSweeper has opened/pushed a fix PR or merged a canonical PR in this run. A blocked close must set blocked_by="fix_first"; prose alone is not a blocker authorization.'
          : "Close actions may run independently when their own safety gates pass.",
    },
    required_validation: [
      plan.security_boundary.security_repair_allowed_items.length > 0
        ? "security-sensitive refs listed in security_repair_allowed_items may receive bounded fix actions, but merge and close remain blocked until later human/router gates clear"
        : "route security-sensitive refs with route_security and keep processing unrelated non-security items",
      "use OpenClaw SECURITY.md posture: trusted-operator exec behavior, provider gaps, feature gaps, and hardening-only parity drift are not vulnerabilities without a boundary bypass",
      "prove current main behavior before fix, merge, fixed-by-candidate, or post-merge closeout actions",
      "for pure issue-dedupe closeout, prove the canonical issue and duplicate targets are live and current",
      "hydrate every provided and linked item before classification",
      "emit one action per GitHub issue/PR ref; never use comma-separated targets",
      "if an item is not a true duplicate, run a single-item review/check/decide path before needs_human",
      "fetch Greptile, Codex, Asile, CodeRabbit, Copilot, and similar review-bot comments for every canonical or candidate PR",
      "address each actionable review-bot finding or mark the item needs_human with the unresolved blocker",
      "before unknown merge recommendation, include merge_preflight proving security clearance, resolved comments, resolved bot comments, passed Codex /review, addressed review findings, and validation commands",
      "show canonical URL or explain needs_human",
      "use canonical/duplicate_of/candidate_fix refs only when those refs are hydrated preflight items; unhydrated PR refs found in comments belong in evidence or fix_artifact until hydrated",
      "include targeted tests and release-note context for fix artifacts",
      "set fix_artifact.deterministic_rebase_only=true only for a pure base-sync repair with no review finding, failing validation, or code/content change to address; omit it for any substantive fix",
      "do not plan executable fix PRs for broad feature/config/docs rewrites; split them into narrower follow-up jobs or mark implementation blocked with exact sub-scopes",
      "if replacing a contributor PR, include source PR credit and the exact close comment that says ClawSweeper will preserve attribution",
      "include full GitHub URLs in closure rationale",
    ],
  };
}

function resolveTargetCheckout(job: LooseRecord): string | null {
  const explicit = stringValue(job.frontmatter.target_checkout);
  if (explicit) return explicit;
  const fromEnv = stringValue(process.env.CLAWSWEEPER_TARGET_CHECKOUT);
  return fromEnv || null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function canonicalCandidates(items: LooseRecord[], job: LooseRecord) {
  const canonicalNumbers = new Set(
    (job.frontmatter.canonical ?? []).map(
      (ref: JsonValue) => normalizeRef(job.frontmatter.repo, ref).number,
    ),
  );
  return items
    .filter((item: JsonValue) => canonicalNumbers.has(item.number) || item.kind === "pull_request")
    .map((item: JsonValue) => ({
      ref: item.ref,
      kind: item.kind,
      state: item.state,
      title: item.title,
      url: item.html_url,
      hint: classificationHint(item, job),
      checks: item.pull_request?.checks ?? [],
    }));
}

function classificationHint(item: LooseRecord, job: LooseRecord) {
  if (itemSecurityRepairAllowed(item, job)) return "security_sensitive_fix_allowed_by_opt_in";
  if (itemSecuritySensitive(item, job)) return "security_sensitive_route_only";
  const canonicalNumbers = new Set(
    (job.frontmatter.canonical ?? []).map(
      (ref: JsonValue) => normalizeRef(job.frontmatter.repo, ref).number,
    ),
  );
  if (canonicalNumbers.has(item.number)) return "canonical_hint";
  if (item.state !== "open") return "already_closed";
  if (job.frontmatter.triage_policy === "low_signal_prs" && item.kind === "pull_request") {
    return "low_signal_pr_candidate";
  }
  if (item.kind === "pull_request" && item.pull_request?.draft === false)
    return "open_pr_candidate";
  if (item.kind === "pull_request") return "draft_pr_candidate";
  return "open_issue_candidate";
}

function itemSecuritySensitive(item: LooseRecord, job: LooseRecord) {
  if (securityOverrideRefs(job).has(`#${item.number}`)) return false;
  if (itemSecurityRepairAllowed(item, job)) return false;
  return itemSecuritySignal(item);
}

function itemSecurityRepairAllowed(item: LooseRecord, job: LooseRecord) {
  return (
    itemSecuritySignal(item) &&
    jobAllowsSecurityRepair(job) &&
    (jobTargetRefs(job).has(`#${item.number}`) || hasSecurityRepairOptInLabel(item.labels))
  );
}

function itemSecuritySignal(item: LooseRecord) {
  return hasDeterministicSecuritySignal({
    labels: item.labels,
    comments: [
      item.body,
      item.comments.map((comment: JsonValue) => comment.body),
      item.pull_request?.reviews?.map((review: JsonValue) => review.body ?? review.body_excerpt),
      item.pull_request?.review_comments?.map((comment: JsonValue) => comment.body),
    ],
  });
}

function jobAllowsSecurityRepair(job: LooseRecord) {
  const allowedActions = new Set(job.frontmatter.allowed_actions ?? []);
  const blockedActions = new Set(job.frontmatter.blocked_actions ?? []);
  return (
    job.frontmatter.source === "pr_automerge" &&
    job.frontmatter.allow_fix_pr === true &&
    allowedActions.has("fix") &&
    blockedActions.has("merge")
  );
}

function jobTargetRefs(job: LooseRecord) {
  return new Set(
    [...(job.frontmatter.canonical ?? []), ...(job.frontmatter.candidates ?? [])].map(
      (ref: JsonValue) => `#${normalizeRef(job.frontmatter.repo, ref).number}`,
    ),
  );
}

function securityOverrideRefs(job: LooseRecord) {
  return new Set(
    (job.frontmatter.security_override_refs ?? []).map(
      (ref: JsonValue) => `#${String(ref).replace(/^#/, "")}`,
    ),
  );
}

function extractLinkedRefs(defaultRepo: string, item: LooseRecord) {
  const texts = [
    item.title,
    item.body,
    ...item.comments.map((comment: JsonValue) => comment.body),
    item.pull_request?.commits?.map((commit: JsonValue) => commit.message).join("\n"),
  ];
  return uniqueRefs(texts.flatMap((text: string) => refsFromText(defaultRepo, text)));
}

function summarizeComment(comment: LooseRecord) {
  return {
    author: comment.author,
    author_association: comment.author_association,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    body_excerpt: comment.body_excerpt ?? excerpt(comment.body),
  };
}

function summarizeReview(review: LooseRecord) {
  return {
    author: review.author,
    author_association: review.author_association,
    state: review.state,
    submitted_at: review.submitted_at,
    body_excerpt: review.body_excerpt ?? excerpt(review.body),
  };
}

function summarizeReviewComment(comment: LooseRecord) {
  return {
    author: comment.author,
    author_association: comment.author_association,
    path: comment.path,
    line: comment.line,
    side: comment.side,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    body_excerpt: comment.body_excerpt ?? excerpt(comment.body),
    diff_hunk_excerpt: comment.diff_hunk_excerpt,
  };
}

function isReviewBotComment(comment: LooseRecord) {
  const author = String(comment.author ?? "");
  const body = String(comment.body ?? comment.body_excerpt ?? "");
  return REVIEW_BOT_PATTERN.test(author) || REVIEW_BOT_PATTERN.test(body);
}

function normalizeAuthorAssociation(value: JsonValue) {
  return typeof value === "string" && value.trim() ? value.trim().toUpperCase() : "NONE";
}

function refsFromText(defaultRepo: string, text: string) {
  const refs: LooseRecord[] = [];
  const ownerRepo = defaultRepo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const urlPattern = new RegExp(
    `https://github\\.com/(${ownerRepo}|[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/(?:issues|pull)/(\\d+)`,
    "g",
  );
  for (const match of String(text ?? "").matchAll(urlPattern)) {
    refs.push(normalizeRef(defaultRepo, `https://github.com/${match[1]}/issues/${match[2]}`));
  }
  for (const match of String(text ?? "").matchAll(/(^|[^A-Za-z0-9_])#(\d+)\b/g)) {
    refs.push({ repo: defaultRepo, number: Number(match[2]) });
  }
  return refs;
}

function normalizeRef(defaultRepo: string, value: JsonValue) {
  const text = String(value ?? "").trim();
  const shorthand = text.match(/^#?(\d+)$/);
  if (shorthand) return { repo: defaultRepo, number: Number(shorthand[1]) };
  const url = text.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\/(\d+)/);
  if (url) return { repo: url[1], number: Number(url[2]) };
  return { repo: defaultRepo, number: 0 };
}

function uniqueRefs(refs: LooseRecord[]) {
  const seen = new Set();
  const out: JsonValue[] = [];
  for (const ref of refs) {
    if (!ref?.repo || !ref.number) continue;
    const key = `${ref.repo}#${ref.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

function formatNormalizedRef(ref: JsonValue) {
  return ref.repo === job.frontmatter.repo
    ? `#${ref.number}`
    : `https://github.com/${ref.repo}/issues/${ref.number}`;
}

function branchWritableByAutomation(repo: string, pullRequest: LooseRecord) {
  return pullRequest.head?.repo?.full_name === repo || pullRequest.maintainer_can_modify === true;
}

function branchWriteReason(repo: string, pullRequest: LooseRecord) {
  if (pullRequest.head?.repo?.full_name === repo) {
    return "same-repo head branch is writable by the GitHub App contents permission";
  }
  if (pullRequest.maintainer_can_modify === true) {
    return "fork branch allows maintainer edits";
  }
  return "fork branch does not allow maintainer edits";
}

function fetchMainBranch(repo: string) {
  const name = fetchDefaultBranchName(repo);
  const branch = ghJson(["api", `repos/${repo}/branches/${encodeURIComponent(name)}`]);
  return {
    name,
    sha: branch.commit?.sha,
    url: branch._links?.html,
  };
}

function fetchDefaultBranchName(repo: string) {
  const repository = ghJson(["api", `repos/${repo}`]);
  const branch = String(repository.default_branch ?? "").trim();
  return branch || "main";
}

function offlineMainBranch(repo: string) {
  return {
    name: "unknown",
    sha: null,
    url: `https://github.com/${repo}`,
    note: "offline mode did not fetch current default branch",
  };
}

function offlineItem(repo: string, number: JsonValue, job: LooseRecord) {
  return {
    repo,
    number,
    ref: `#${number}`,
    kind: "unknown",
    state: "unknown",
    title: `offline seed #${number}`,
    html_url: `https://github.com/${repo}/issues/${number}`,
    author: null,
    author_association: null,
    labels: [],
    created_at: null,
    updated_at: null,
    closed_at: null,
    body: job.body,
    body_excerpt: excerpt(job.body),
    comments: [],
    pull_request: null,
  };
}

function ghPrChecks(repo: string, number: JsonValue) {
  try {
    const text = ghText([
      "pr",
      "checks",
      String(number),
      "--repo",
      repo,
      "--json",
      "name,state,bucket,link",
    ]).trim();
    return JSON.parse(text || "[]");
  } catch (error) {
    return [{ error: firstLine(error?.stderr || error?.message || String(error)) }];
  }
}

function excerpt(text: string, limit: JsonValue = 1200) {
  const value = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 3)}...`;
}

function firstLine(text: string) {
  return String(text ?? "").split(/\r?\n/)[0] ?? "";
}
