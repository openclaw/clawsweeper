import type { JsonValue, LooseRecord } from "./json-types.js";
import { renderJobIntentFrontmatter } from "./job-intent.js";
import { repoSlug } from "./comment-router-core.js";
import { HUMAN_REVIEW_LABEL, MERGE_READY_LABEL } from "./exact-review-guard-labels.js";

export const CLAWSWEEPER_SELF_REBASE_SOURCE = "clawsweeper_self_rebase";
export const CLAWSWEEPER_SELF_REBASE_INTENT = "clawsweeper_self_rebase";
export const DEFAULT_SELF_HEAL_HEAD_PREFIX = "clawsweeper/";
export const SELF_HEAL_STATUS_MARKER_INTENT = "clawsweeper_self_rebase";
export const SELF_HEAL_PAUSE_LABELS = new Set<string>([HUMAN_REVIEW_LABEL, MERGE_READY_LABEL]);

export function selfHealClusterId(repo: string, issueNumber: JsonValue) {
  return `self-heal-${repoSlug(repo)}-${Number(issueNumber)}`;
}

export function selfHealJobPath(repo: string, issueNumber: JsonValue) {
  const owner = String(repo ?? "").split("/")[0] || "openclaw";
  return `jobs/${owner}/inbox/${selfHealClusterId(repo, issueNumber)}.md`;
}

export function selfHealStatusMarker(issueNumber: JsonValue, headSha: JsonValue) {
  return `<!-- clawsweeper-command-status:${Number(issueNumber) || "unknown"}:${SELF_HEAL_STATUS_MARKER_INTENT}:${String(headSha ?? "na") || "na"} -->`;
}

export function selfHealMergeStateReason(target: LooseRecord = {}): string | null {
  const mergeStateStatus = String(target.merge_state_status ?? target.mergeStateStatus ?? "")
    .trim()
    .toUpperCase();
  if (mergeStateStatus === "DIRTY") return "mergeStateStatus is DIRTY";
  if (mergeStateStatus === "BEHIND") return "mergeStateStatus is BEHIND";

  const mergeable = String(target.mergeable ?? "")
    .trim()
    .toUpperCase();
  if (mergeable === "CONFLICTING") return "mergeable is CONFLICTING";
  return null;
}

export function selfHealEligibility({
  pull,
  repo,
  headPrefix = DEFAULT_SELF_HEAL_HEAD_PREFIX,
}: {
  pull: LooseRecord;
  repo: string;
  headPrefix?: string;
}) {
  const labels = normalizedLabelSet(pull.labels ?? []);
  const author = normalizedAuthor(pull.author);
  const branch = String(pull.headRefName ?? pull.branch ?? "");
  const headRepo = String(
    pull.headRepository?.nameWithOwner ??
      pull.headRepositoryNameWithOwner ??
      pull.head_repo ??
      pull.headRepo ??
      "",
  );
  const headSha = String(pull.headRefOid ?? pull.head_sha ?? pull.headSha ?? "").trim();
  const state = String(pull.state ?? "OPEN").toUpperCase();
  const mergeState = selfHealMergeStateReason(pull);

  if (state !== "OPEN") return { eligible: false, reason: "PR is not open" };
  if (!isClawSweeperAppAuthor(author)) {
    return { eligible: false, reason: `author is ${author || "unknown"}` };
  }
  if (!branch.startsWith(headPrefix)) {
    return { eligible: false, reason: `head branch does not start with ${headPrefix}` };
  }
  if (headRepo && headRepo.toLowerCase() !== repo.toLowerCase()) {
    return { eligible: false, reason: `head repo is ${headRepo}` };
  }
  if (!headRepo) return { eligible: false, reason: "head repository is unknown" };
  if (!headSha) return { eligible: false, reason: "head SHA is unknown" };
  if (!mergeState) return { eligible: false, reason: "merge state is clean or unknown" };
  for (const label of SELF_HEAL_PAUSE_LABELS) {
    if (labels.has(label)) return { eligible: false, reason: `paused by ${label}` };
  }
  return { eligible: true, reason: mergeState };
}

export function renderSelfHealJob({
  repo,
  issueNumber,
  title = null,
  branch,
  headSha,
  mergeState,
  runUrl = null,
}: LooseRecord) {
  const ref = `#${Number(issueNumber)}`;
  const prUrl = `https://github.com/${repo}/pull/${Number(issueNumber)}`;
  const safeTitle = String(title ?? `PR ${ref}`).trim() || `PR ${ref}`;
  const clusterId = selfHealClusterId(String(repo), issueNumber);
  return `---
repo: ${repo}
cluster_id: ${clusterId}
mode: autonomous
${renderJobIntentFrontmatter(CLAWSWEEPER_SELF_REBASE_INTENT)}
allowed_actions:
  - comment
  - fix
blocked_actions:
  - close
  - merge
  - label
require_human_for:
  - close
  - merge
canonical:
  - ${ref}
candidates:
  - ${ref}
cluster_refs:
  - ${ref}
allow_instant_close: false
allow_fix_pr: true
allow_merge: false
allow_unmerged_fix_close: false
allow_post_merge_close: false
require_fix_before_close: true
security_policy: central_security_only
security_sensitive: false
target_branch: ${branch}
source: ${CLAWSWEEPER_SELF_REBASE_SOURCE}
self_heal_target_pr: "${String(issueNumber)}"
expected_head_sha: "${String(headSha)}"
self_heal_merge_state: ${JSON.stringify(String(mergeState ?? ""))}
${runUrl ? `self_heal_run_url: ${JSON.stringify(String(runUrl))}\n` : ""}---

# ClawSweeper self-heal PR rebase

ClawSweeper detected that ${ref} is a ClawSweeper-owned PR whose same-repo branch needs a rebase or conflict repair.

Source PR: ${prUrl}
Title: ${safeTitle}
Target branch: \`${branch}\`
Target head SHA: \`${headSha}\`
Detected state: ${mergeState}
${runUrl ? `Repair run: ${runUrl}\n` : ""}
Use this job only for bounded conflict/behind self-heal:

- Before changing anything, verify that ${prUrl} is still open and its head SHA is exactly \`${headSha}\`; if it changed, stop without editing or pushing.
- Emit a fix artifact with \`repair_strategy: "repair_contributor_branch"\`, \`deterministic_rebase_only: true\`, and \`source_prs: ["${prUrl}"]\` for a pure rebase/base-sync repair.
- Rebase the existing same-repo branch onto latest \`main\`, resolve conflicts only when the resolution is directly required by the rebase, and run the narrow validation available for the touched surface.
- Do not add \`clawsweeper:automerge\`, \`clawsweeper:merge-ready\`, or any merge-ready labels.
- Do not merge or close this PR. A fresh exact-head ClawSweeper review is required after any successful push.
`;
}

export function renderSelfHealStatusComment({
  repo,
  issueNumber,
  headSha,
  mergeState,
  jobPath,
  runUrl = null,
  status = "planned",
}: LooseRecord) {
  const prUrl = `https://github.com/${repo}/pull/${Number(issueNumber)}`;
  return [
    selfHealStatusMarker(issueNumber, headSha),
    "ClawSweeper conflict self-heal is queued.",
    "",
    `Detected state: ${mergeState || "unknown"}.`,
    `Target head: ${markdownCommitLink(repo, headSha)}.`,
    runUrl ? `Repair run: ${runUrl}.` : `Repair job: \`${jobPath ?? "pending"}\`.`,
    `Status: ${status}.`,
    "",
    `This lane will only try to rebase or repair the ClawSweeper-owned branch for ${prUrl}. It will not merge the PR or add automerge/merge-ready labels.`,
  ].join("\n");
}

export function selfHealStatusMarkerPrefix(issueNumber: JsonValue) {
  return `<!-- clawsweeper-command-status:${Number(issueNumber) || "unknown"}:${SELF_HEAL_STATUS_MARKER_INTENT}:`;
}

function normalizedAuthor(author: JsonValue) {
  if (typeof author === "string") return author.toLowerCase();
  if (!author || typeof author !== "object") return "";
  const record = author as LooseRecord;
  const type = String(record.__typename ?? record.type ?? "").toLowerCase();
  const login = String(record.login ?? record.name ?? "").toLowerCase();
  return type && login ? `${type}/${login}` : login;
}

function isClawSweeperAppAuthor(author: string) {
  return (
    author === "app/clawsweeper" ||
    author === "bot/clawsweeper" ||
    author === "clawsweeper" ||
    author === "clawsweeper[bot]" ||
    author === "bot/clawsweeper[bot]"
  );
}

function normalizedLabelSet(labels: JsonValue) {
  const names = Array.isArray(labels) ? labels : [];
  return new Set(
    names
      .map((label: JsonValue) =>
        typeof label === "string" ? label : String((label as LooseRecord)?.name ?? ""),
      )
      .map((label: string) => label.trim().toLowerCase())
      .filter(Boolean),
  );
}

function markdownCommitLink(repo: JsonValue, sha: JsonValue): string {
  const full = String(sha ?? "").trim();
  if (!/^[0-9a-f]{7,40}$/i.test(full)) return full ? `\`${full}\`` : "`unknown`";
  const short = full.slice(0, 12);
  return `[\`${short}\`](https://github.com/${repo}/commit/${full})`;
}
