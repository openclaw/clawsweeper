import type { JsonValue, LooseRecord } from "./json-types.js";
export const REPAIR_INTENTS = new Set([
  "fix_ci",
  "address_review",
  "rebase",
  "clawsweeper_auto_repair",
]);
export const MERGE_INTENTS = new Set(["clawsweeper_auto_merge", "maintainer_approve_automerge"]);
export const AUTOCLOSE_INTENTS = new Set(["autoclose"]);
export const AUTOMERGE_JOB_SOURCE = "pr_automerge";
export const AUTOMERGE_LABEL = "clawsweeper:automerge";
export const AUTOFIX_LABEL = "clawsweeper:autofix";
export const HUMAN_REVIEW_LABEL = "clawsweeper:human-review";
export const MERGE_READY_LABEL = "clawsweeper:merge-ready";
export const DEFAULT_ALLOWED_REPOSITORY_PERMISSIONS = ["admin", "maintain", "write"];
const CLAWSWEEPER_REPLY_BADGE = "🦞🦞";
const REPAIRABLE_CHECK_BLOCKER_CONCLUSIONS = new Set([
  "ACTION_REQUIRED",
  "ERROR",
  "FAILURE",
  "TIMED_OUT",
]);

export function repoSlug(repo: string) {
  return String(repo ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function automergeClusterId(repo: string, issueNumber: JsonValue) {
  return `automerge-${repoSlug(repo)}-${Number(issueNumber)}`;
}

export function automergeJobBranch(repo: string, issueNumber: JsonValue) {
  return `clawsweeper/${automergeClusterId(repo, issueNumber)}`;
}

export function automergeJobPath(repo: string, issueNumber: JsonValue) {
  const owner = String(repo ?? "").split("/")[0] || "openclaw";
  return `jobs/${owner}/inbox/${automergeClusterId(repo, issueNumber)}.md`;
}

export function renderAutomergeJob({
  repo,
  issueNumber,
  title = null,
  repairMode: rawRepairMode = "automerge",
}: LooseRecord) {
  const clusterId = automergeClusterId(repo, issueNumber);
  const branch = automergeJobBranch(repo, issueNumber);
  const ref = `#${Number(issueNumber)}`;
  const prUrl = `https://github.com/${repo}/pull/${Number(issueNumber)}`;
  const safeTitle = String(title ?? `PR ${ref}`).trim() || `PR ${ref}`;
  const repairMode = String(rawRepairMode) === "autofix" ? "autofix" : "automerge";
  const finalMergeLine =
    repairMode === "autofix"
      ? "Final merge is disabled for autofix. Keep the PR open after a passing ClawSweeper verdict unless a maintainer explicitly changes mode."
      : "Do not merge, close, or bypass review gates from the worker. The comment router owns final merge only after a passing ClawSweeper verdict for the exact current head.";
  return `---
repo: ${repo}
cluster_id: ${clusterId}
mode: autonomous
allowed_actions:
  - comment
  - label
  - fix
  - raise_pr
blocked_actions:
  - close
  - merge
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
source: ${AUTOMERGE_JOB_SOURCE}
---

# ClawSweeper adopted PR repair candidate

Maintainer opted ${ref} into ClawSweeper ${repairMode}.

Source PR: ${prUrl}
Title: ${safeTitle}

ClawSweeper should use this job only for the bounded ClawSweeper review/fix loop:

- If ClawSweeper emits an explicit repair marker, requests changes, or finds failing checks/rebase work, and the PR branch is safe to update, emit a fix artifact with \`repair_strategy: "repair_contributor_branch"\` and \`source_prs: ["${prUrl}"]\`.
- If the PR branch cannot be safely updated, emit a narrow credited replacement only when the artifact can preserve the original contributor credit; otherwise return \`needs_human\`.
- For user-facing OpenClaw \`fix\`, \`feat\`, or \`perf\` changes, inspect the changelog policy. If a changelog is required, emit \`changelog_required: true\`, include \`CHANGELOG.md\` in \`likely_files\`, and tell the Codex edit pass to add or repair the \`CHANGELOG.md\` entry with allowed contributor attribution before declaring the branch merge-ready. Never add forbidden \`Thanks @codex\`, \`Thanks @openclaw\`, or \`Thanks @steipete\`; if only those authors are known, keep the required changelog entry without a \`Thanks @...\` line and preserve credit in PR history/source links.
- ${finalMergeLine}
- Keep repair scope limited to actionable ClawSweeper findings, failing relevant checks, and required review feedback on this PR.
`;
}

export function automergeChangelogBlockReason({ repo, title, files }: LooseRecord): string | null {
  if (String(repo ?? "").toLowerCase() !== "openclaw/openclaw") return null;

  const paths = normalizeChangedPaths(files);
  if (paths.some(isChangelogPath)) return null;
  if (!automergeTitleUsuallyNeedsChangelog(title)) return null;
  if (!paths.some(isPotentiallyUserFacingPath)) return null;

  return "CHANGELOG.md entry is required for user-facing ClawSweeper automerge changes";
}

function normalizeChangedPaths(files: JsonValue): string[] {
  if (!Array.isArray(files)) return [];
  return files
    .map((file) => (typeof file === "string" ? file : file?.path))
    .map((file) => String(file ?? "").trim())
    .filter(Boolean);
}

function isChangelogPath(file: string): boolean {
  return /(^|\/)CHANGELOG\.md$/i.test(file);
}

function automergeTitleUsuallyNeedsChangelog(title: JsonValue): boolean {
  return /^(?:feat|fix|perf)(?:\([^)]+\))?:/i.test(String(title ?? "").trim());
}

function isPotentiallyUserFacingPath(file: string): boolean {
  if (/^(?:docs|test|tests|\.github)\//.test(file)) return false;
  if (/(?:^|\/)__tests__\//.test(file)) return false;
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) return false;
  if (/(?:^|\/)(?:README|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY|SUPPORT|LICENSE)\.md$/i.test(file))
    return false;
  if (file.startsWith("docs/.generated/")) return false;
  return true;
}

export function automergeGateBlockReason(env: LooseRecord = process.env) {
  if (env.CLAWSWEEPER_ALLOW_MERGE !== "1") return "merge requires CLAWSWEEPER_ALLOW_MERGE=1";
  if (env.CLAWSWEEPER_ALLOW_AUTOMERGE !== "1")
    return "automerge requires CLAWSWEEPER_ALLOW_AUTOMERGE=1";
  return "";
}

export function repairableCheckBlockers(checks: LooseRecord = {}) {
  return (checks.blockers ?? []).filter((blocker: JsonValue) => {
    const conclusion = String(blocker ?? "")
      .split(":")
      .pop()
      ?.trim()
      .toUpperCase();
    return conclusion ? REPAIRABLE_CHECK_BLOCKER_CONCLUSIONS.has(conclusion) : false;
  });
}

export function automergeRebaseRepairReason(target: LooseRecord = {}): string | null {
  const mergeStateStatus = String(target.merge_state_status ?? target.mergeStateStatus ?? "")
    .trim()
    .toUpperCase();
  if (mergeStateStatus === "DIRTY")
    return "PR is behind or has merge conflicts and needs a cloud rebase repair before automerge";
  if (mergeStateStatus === "BEHIND")
    return "PR is behind the base branch and needs a cloud rebase repair before automerge";

  const mergeable = String(target.mergeable ?? "")
    .trim()
    .toUpperCase();
  if (mergeable === "CONFLICTING")
    return "PR has merge conflicts and needs a cloud rebase repair before automerge";
  return null;
}

export function commandHasAction(command: LooseRecord, actionName: string): boolean {
  return (command.actions ?? []).some((action: JsonValue) => action.action === actionName);
}

export function isMaintainerCommandAllowed({
  authorAssociation,
  repositoryPermission = null,
  allowedAssociations,
  allowedRepositoryPermissions = DEFAULT_ALLOWED_REPOSITORY_PERMISSIONS,
}: LooseRecord) {
  const permission = String(repositoryPermission ?? "")
    .trim()
    .toLowerCase();
  const permissionSet = new Set(
    [...allowedRepositoryPermissions]
      .map((value: string) => String(value).trim().toLowerCase())
      .filter(Boolean),
  );
  if (permission) return permissionSet.has(permission);

  const association = String(authorAssociation ?? "")
    .trim()
    .toUpperCase();
  const associationSet = new Set(
    [...allowedAssociations]
      .map((value: string) => String(value).trim().toUpperCase())
      .filter(Boolean),
  );
  return association === "OWNER" && associationSet.has(association);
}

export function buildAutomergeMergeArgs({ issueNumber, repo, expectedHeadSha }: LooseRecord) {
  const args = ["pr", "merge", String(issueNumber), "--repo", repo, "--squash"];
  if (expectedHeadSha && expectedHeadSha !== "unknown") {
    args.push("--match-head-commit", expectedHeadSha);
  }
  return args;
}

export function reviewedHeadShaBlockReason({
  expectedHeadSha,
  currentHeadSha,
  markerName,
}: LooseRecord) {
  const marker = String(markerName ?? "review");
  if (!expectedHeadSha || expectedHeadSha === "unknown") {
    return `ClawSweeper ${marker} marker must include the reviewed PR head SHA`;
  }
  if (currentHeadSha && expectedHeadSha !== currentHeadSha) {
    return `ClawSweeper ${marker} marker targets a stale PR head SHA`;
  }
  return null;
}

type AutoRepairDispatchEntry = {
  repo?: unknown;
  issue_number?: unknown;
  intent?: unknown;
  status?: unknown;
  target?: { head_sha?: unknown } | null;
  comment_updated_at?: unknown;
};

export function autoRepairHeadKey({
  repo,
  issueNumber,
  headSha,
}: {
  repo: unknown;
  issueNumber: unknown;
  headSha: unknown;
}) {
  const sha = String(headSha ?? "").trim();
  if (!sha) return null;
  return `${String(repo ?? "")}#${String(issueNumber ?? "")}:${sha}`;
}

export function autoRepairBlockReason({
  entries = [],
  plannedHeads = new Set<string>(),
  repo,
  issueNumber,
  headSha,
  maxRepairsPerPr,
  maxRepairsPerHead,
  resumeBoundary = 0,
}: {
  entries?: readonly AutoRepairDispatchEntry[];
  plannedHeads?: ReadonlySet<string>;
  repo: unknown;
  issueNumber: unknown;
  headSha: unknown;
  maxRepairsPerPr: number;
  maxRepairsPerHead: number;
  resumeBoundary?: unknown;
}) {
  const headKey = autoRepairHeadKey({ repo, issueNumber, headSha });
  if (!headKey) return null;

  const priorPrDispatches = entries.filter(
    (entry) =>
      isAutoRepairDispatchForPr(entry, repo, issueNumber) &&
      isAfterAutoRepairResumeBoundary(entry, resumeBoundary),
  );
  if (priorPrDispatches.length >= maxRepairsPerPr) {
    return `ClawSweeper auto repair already dispatched ${priorPrDispatches.length} total time(s) for this PR`;
  }

  if (plannedHeads.has(headKey)) {
    return "ClawSweeper auto repair already planned for this PR head in this scan";
  }

  const priorHeadDispatches = entries.filter(
    (entry) =>
      isAutoRepairDispatchForPr(entry, repo, issueNumber) &&
      String(entry.target?.head_sha ?? "") === String(headSha ?? "") &&
      isAfterAutoRepairResumeBoundary(entry, resumeBoundary),
  );
  if (priorHeadDispatches.length >= maxRepairsPerHead) {
    return `ClawSweeper auto repair already dispatched ${priorHeadDispatches.length} time(s) for this PR head`;
  }

  return null;
}

function isAutoRepairDispatchForPr(
  entry: AutoRepairDispatchEntry,
  repo: unknown,
  issueNumber: unknown,
) {
  const hasRepairDispatchAction = (entry as LooseRecord).actions?.some(
    (action: JsonValue) => action?.action === "dispatch_repair" && action?.status === "executed",
  );
  return (
    entry.repo === repo &&
    Number(entry.issue_number) === Number(issueNumber) &&
    entry.status === "executed" &&
    (entry.intent === "clawsweeper_auto_repair" || hasRepairDispatchAction)
  );
}

function isAfterAutoRepairResumeBoundary(entry: AutoRepairDispatchEntry, resumeBoundary: unknown) {
  const boundary = Number(resumeBoundary) || 0;
  if (!boundary) return true;
  const updatedAt = Date.parse(String(entry.comment_updated_at ?? "")) || 0;
  return updatedAt > boundary;
}

export function parseCommand(body: string) {
  const lines = String(body ?? "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const automerge = line.match(/^\s*\/automerge\s*$/i);
    if (automerge) return commandFromText("slash", "automerge");
    const autoclose = line.match(/^\s*\/autoclose(?:\s+(.+))?\s*$/i);
    if (autoclose) return commandFromText("slash", `autoclose ${autoclose[1] ?? ""}`.trim());
    const review = line.match(/^\s*\/review(?:\s+(.+))?\s*$/i);
    if (review) return commandFromText("slash", review[1] ? `review ${review[1]}` : "review");
    const slash = line.match(/^\s*\/clawsweeper(?:\s+(.+))?\s*$/i);
    if (slash) return commandFromText("slash", slash[1] ?? "status");
    const mention = line.match(
      /^\s*@(?:clawsweeper|openclaw-clawsweeper)(?:\[bot\])?(?:(?:\s*[:,]\s*|\s+)(.+))?\s*$/i,
    );
    if (mention) {
      const command = commandFromText("mention", mention[1] ?? "status");
      if (command.intent !== "freeform_assist") {
        const rest = lines
          .slice(index + 1)
          .join("\n")
          .trim();
        if (command.command === "status" && rest) return commandFromText("mention", rest);
        return command;
      }
      const rest = lines
        .slice(index + 1)
        .join("\n")
        .trim();
      return rest ? commandFromText("mention", `${mention[1]}\n${rest}`) : command;
    }
  }
  return null;
}

export function parseTrustedAutomation(
  comment: LooseRecord,
  { trustedAuthors = new Set() }: LooseRecord = {},
) {
  const author = String(comment?.user?.login ?? "").toLowerCase();
  if (!trustedAuthors.has(author)) return null;

  const body = String(comment?.body ?? "");
  const verdict = clawsweeperMarker(body, "verdict");
  const actionMarker = clawsweeperMarker(body, "action");
  if (verdict && ["pass", "approved", "no-changes"].includes(verdict.action)) {
    return trustedMerge({
      author,
      reason: `structured ClawSweeper verdict: ${verdict.action}${markerReasonSuffix(verdict.attrs)}`,
      marker: verdict,
    });
  }
  if (verdict && ["needs-human", "human-review"].includes(verdict.action)) {
    return trustedHumanReview({
      author,
      reason: `structured ClawSweeper verdict: ${verdict.action}${markerReasonSuffix(verdict.attrs)}`,
      marker: verdict,
    });
  }
  if (
    actionMarker &&
    ["fix-required", "repair-required", "address-review", "fix-ci"].includes(actionMarker.action)
  ) {
    return trustedRepair({
      author,
      reason: `structured ClawSweeper marker: ${actionMarker.action}${markerReasonSuffix(actionMarker.attrs)}`,
      marker: actionMarker,
    });
  }
  if (
    verdict &&
    [
      "needs-changes",
      "changes-requested",
      "needs-repair",
      "fix-required",
      "repair-required",
    ].includes(verdict.action)
  ) {
    return trustedRepair({
      author,
      reason: `structured ClawSweeper verdict: ${verdict.action}${markerReasonSuffix(verdict.attrs)}`,
      marker: verdict,
    });
  }
  return null;
}

export function renderResponse(command: LooseRecord, dispatched: LooseRecord) {
  const markerId = command.comment_version_key ?? command.comment_id;
  const marker = [
    commandStatusMarker(command),
    `<!-- clawsweeper-command:${markerId}:${command.intent}:${command.target?.head_sha ?? "na"} -->`,
    CLAWSWEEPER_REPLY_BADGE,
  ].join("\n");
  if (command.intent === "help") {
    return [
      marker,
      "ClawSweeper is here and listening for maintainer commands.",
      "",
      "Supported commands: `/review`, `/clawsweeper status`, `/clawsweeper re-review`, `/clawsweeper fix ci`, `/clawsweeper address review`, `/clawsweeper rebase`, `/clawsweeper autofix`, `/clawsweeper automerge`, `/clawsweeper approve`, `/autoclose <reason>`, `/clawsweeper explain`, `/clawsweeper stop`.",
      "",
      "I only act for maintainers, or for trusted ClawSweeper feedback on a ClawSweeper PR or PR opted into `clawsweeper:autofix` or `clawsweeper:automerge`.",
    ].join("\n");
  }
  if (["status", "explain"].includes(command.intent)) {
    return [marker, renderStatusBody(command)].join("\n");
  }
  if (command.intent === "freeform_assist") {
    return [
      marker,
      dispatched?.clawsweeper
        ? "ClawSweeper is taking a look at your question."
        : "ClawSweeper could not start a freeform assist pass for this item.",
      "",
      dispatched?.clawsweeper
        ? "I asked ClawSweeper to answer this maintainer mention in the next review comment. Tiny claws, bounded scope: this is a read-only assist pass unless it produces one of the existing structured safe-action markers."
        : `Reason: ${command.reason ?? "freeform assist requires an open issue or PR"}.`,
      "",
      `Request: ${inlineQuote(command.freeform_prompt ?? command.command ?? "No request text provided.")}`,
    ].join("\n");
  }
  if (command.intent === "stop") {
    return [
      marker,
      "Got it. ClawSweeper will leave this item for human review.",
      "",
      `I added \`${HUMAN_REVIEW_LABEL}\` and paused the automation trail until a maintainer asks again.`,
    ].join("\n");
  }
  if (["autofix", "automerge"].includes(command.intent)) {
    const repairOnly = command.intent === "autofix";
    const mode = repairOnly ? "autofix" : "automerge";
    const label = repairOnly ? AUTOFIX_LABEL : AUTOMERGE_LABEL;
    const clearedHumanReview = (command.actions ?? []).some(
      (action: JsonValue) => action.action === "remove_label",
    );
    return [
      marker,
      dispatched?.clawsweeper
        ? `ClawSweeper ${mode} is enabled for this PR.`
        : `ClawSweeper could not enable ${mode} for this PR.`,
      "",
      dispatched?.clawsweeper
        ? `I ${clearedHumanReview ? "cleared pause labels, " : ""}added \`${label}\` and asked ClawSweeper to review this head. If ClawSweeper emits a repair marker or requests changes, I will repair/rebase the branch and ask for another review, up to the configured round limit.`
        : `Reason: ${command.reason ?? `${mode} requires a pull request`}.`,
      "",
      repairOnly
        ? "This is fix-only: I will not merge this PR. Tiny claw oath."
        : "Draft PRs stay fix-only until GitHub marks them ready for review. A maintainer can pause this with `/clawsweeper stop`.",
    ].join("\n");
  }
  if (command.intent === "re_review") {
    return [
      marker,
      dispatched?.clawsweeper
        ? "ClawSweeper re-review requested."
        : "ClawSweeper could not start a re-review for this item.",
      "",
      dispatched?.clawsweeper
        ? "I asked ClawSweeper to review this item again."
        : `Reason: ${command.reason ?? "re-review requires an open issue or PR"}.`,
    ].join("\n");
  }
  if (command.intent === "autoclose") {
    const result = dispatched?.autoclose;
    const closed = (result?.targets ?? []).filter(
      (target: JsonValue) => target.status === "closed",
    );
    const skipped = (result?.targets ?? []).filter(
      (target: JsonValue) => target.status !== "closed",
    );
    const closedLines = closed.map(
      (target: JsonValue) => `- Closed ${target.ref}: ${target.title ?? "untitled"}`,
    );
    const skippedLines = skipped.map(
      (target: JsonValue) => `- Skipped ${target.ref}: ${target.reason ?? target.status}`,
    );
    return [
      marker,
      result?.status === "executed"
        ? "ClawSweeper autoclose is complete."
        : "ClawSweeper could not autoclose this item.",
      "",
      `Reason: ${command.autoclose_reason ?? command.autoclose_message ?? command.reason ?? "autoclose requires a maintainer close reason"}`,
      ...(closedLines.length > 0 ? ["", "Closed:", ...closedLines] : []),
      ...(skippedLines.length > 0 ? ["", "Skipped:", ...skippedLines] : []),
      ...(result
        ? []
        : [
            "",
            "Usage: `/autoclose <maintainer close reason>`. I will close this item and bounded linked open same-repo items.",
          ]),
    ].join("\n");
  }
  if (command.intent === "clawsweeper_auto_repair") {
    const workflow = dispatchedWorkflowLink(dispatched);
    return [
      marker,
      "Thanks, ClawSweeper. ClawSweeper picked up the repair feedback.",
      "",
      `Source: \`${command.trusted_bot_author ?? command.author ?? "trusted automation"}\``,
      `Feedback: ${command.repair_reason ?? "ClawSweeper requested another repair pass."}`,
      `Action: dispatched ${workflow} for \`${dispatched.job_path}\` in \`${dispatched.mode}\` mode.`,
      `Model: \`${dispatched.model}\``,
      "",
      "I will update this PR branch, or open a safe credited replacement, if the repair worker finds a narrow fix.",
    ].join("\n");
  }
  if (command.intent === "clawsweeper_auto_merge") {
    if (dispatched?.repair) {
      const workflow = dispatchedWorkflowLink(dispatched.repair);
      return [
        marker,
        "Thanks, ClawSweeper. ClawSweeper saw the passing review, but current checks are failing.",
        "",
        `Source: \`${command.trusted_bot_author ?? command.author ?? "trusted automation"}\``,
        `Feedback: ${command.repair_reason ?? "ClawSweeper reported a passing review."}`,
        `Action: dispatched ${workflow} for \`${dispatched.repair.job_path}\` in \`${dispatched.repair.mode}\` mode.`,
        `Model: \`${dispatched.repair.model}\``,
        "",
        "I will update this PR branch, or open a safe credited replacement, if the repair worker finds a narrow CI fix.",
      ].join("\n");
    }
    return [
      marker,
      dispatched?.merge?.status === "executed"
        ? "Thanks, ClawSweeper. ClawSweeper merged this PR after the passing review."
        : "Thanks, ClawSweeper. ClawSweeper saw the passing review, but did not merge yet.",
      "",
      `Source: \`${command.trusted_bot_author ?? command.author ?? "trusted automation"}\``,
      `Feedback: ${command.repair_reason ?? "ClawSweeper reported a passing review."}`,
      ...(dispatched?.merge?.reason ? [`Merge status: ${dispatched.merge.reason}`] : []),
      ...(dispatched?.merge?.merged_at ? [`Merged at: ${dispatched.merge.merged_at}`] : []),
      "",
      dispatched?.merge?.status === "executed"
        ? "The automerge loop is complete."
        : "I left the PR open for the remaining gate instead of bypassing it.",
    ].join("\n");
  }
  if (command.intent === "maintainer_approve_automerge") {
    return [
      marker,
      dispatched?.merge?.status === "executed"
        ? "Maintainer-approved ClawSweeper automerge is complete."
        : "Maintainer-approved ClawSweeper automerge is not merged yet.",
      "",
      `Approver: \`${command.author ?? "maintainer"}\``,
      `Head: \`${command.expected_head_sha ?? command.target?.head_sha ?? "unknown"}\``,
      ...(dispatched?.merge?.reason ? [`Merge status: ${dispatched.merge.reason}`] : []),
      ...(dispatched?.merge?.merged_at ? [`Merged at: ${dispatched.merge.merged_at}`] : []),
      "",
      dispatched?.merge?.status === "executed"
        ? "The automerge loop is complete."
        : "I left the PR open for the remaining gate instead of bypassing it.",
    ].join("\n");
  }
  if (command.intent === "clawsweeper_needs_human") {
    return [
      marker,
      "ClawSweeper is pausing this repair loop for human review.",
      "",
      `Source: \`${command.trusted_bot_author ?? command.author ?? "trusted automation"}\``,
      `Reason: ${command.repair_reason ?? "ClawSweeper requested human review."}`,
      "",
      `I added \`${HUMAN_REVIEW_LABEL}\` and left the final call with a maintainer.`,
    ].join("\n");
  }
  if (!dispatched) {
    return [
      marker,
      "ClawSweeper did not dispatch a repair worker for this one.",
      "",
      `Reason: ${command.reason ?? "unsupported command or target"}.`,
      "",
      "Supported re-review commands work on open issues and PRs: `/review`, `/clawsweeper re-review`, or `@clawsweeper re-review`.",
      "Supported repair commands work on existing ClawSweeper PRs and PRs opted into `clawsweeper:autofix` or `clawsweeper:automerge`: `/clawsweeper fix ci`, `/clawsweeper address review`, `/clawsweeper rebase`.",
      "A maintainer can opt a PR in with `/clawsweeper autofix` or `/clawsweeper automerge` and I can take another pass.",
      "A maintainer can close unsupported or declined work with `/autoclose <reason>`.",
    ].join("\n");
  }
  return [
    marker,
    "ClawSweeper picked this up.",
    "",
    `Command: \`${command.command}\``,
    `Action: dispatched ${dispatchedWorkflowLink(dispatched)} for \`${dispatched.job_path}\` in \`${dispatched.mode}\` mode.`,
    `Model: \`${dispatched.model}\``,
    "",
    "I will keep the change narrow and update the PR branch if the repair worker finds a safe fix.",
  ].join("\n");
}

function dispatchedWorkflowLink(dispatched: LooseRecord): string {
  const workflow = String(dispatched.workflow ?? "workflow");
  const runUrl = typeof dispatched.run_url === "string" ? dispatched.run_url : "";
  return runUrl ? `[${workflow}](${runUrl})` : `\`${workflow}\``;
}

function commandFromText(trigger: JsonValue, value: JsonValue) {
  const rawCommand = String(value ?? "status")
    .trim()
    .replace(/\s+/g, " ");
  const command = rawCommand.toLowerCase();
  let intent = normalizeIntent(command);
  if (trigger === "mention" && intent === "help" && !["", "help", "?"].includes(command)) {
    intent = "freeform_assist";
  }
  const parsed: LooseRecord = { trigger, command, intent };
  if (intent === "autoclose") parsed.autoclose_message = autocloseReasonFromCommand(rawCommand);
  if (intent === "freeform_assist") parsed.freeform_prompt = rawCommand;
  return parsed;
}

export function autocloseReasonFromCommand(command: LooseRecord) {
  const match = String(command ?? "")
    .trim()
    .match(/^autoclose(?:\s+([\s\S]+))?$/i);
  return String(match?.[1] ?? "").trim();
}

function normalizeIntent(command: LooseRecord) {
  if (!command || command === "status") return "status";
  if (["help", "?"].includes(command)) return "help";
  if (["explain", "why"].includes(command)) return "explain";
  if (["fix ci", "fix-ci", "ci", "repair ci", "repair checks", "fix checks"].includes(command))
    return "fix_ci";
  if (["address review", "address-review", "fix review"].includes(command)) return "address_review";
  if (
    ["review", "re-review", "rereview", "review again", "rerun review", "run review"].includes(
      command,
    )
  )
    return "re_review";
  if (["rebase", "update branch", "sync"].includes(command)) return "rebase";
  if (["autofix", "auto fix", "fix when needed", "repair only", "autofix on"].includes(command)) {
    return "autofix";
  }
  if (
    ["automerge", "auto merge", "merge when clean", "merge when ready", "automerge on"].includes(
      command,
    )
  ) {
    return "automerge";
  }
  if (["approve", "approve automerge", "approve merge"].includes(command)) {
    return "maintainer_approve_automerge";
  }
  if (command === "autoclose" || command.startsWith("autoclose ")) return "autoclose";
  if (["stop", "pause", "human review", "handoff"].includes(command)) return "stop";
  return "help";
}

export function commandStatusMarker(command: LooseRecord) {
  return `<!-- clawsweeper-command-status:${command.issue_number ?? "unknown"}:${command.intent}:${command.target?.head_sha ?? "na"} -->`;
}

function inlineQuote(value: JsonValue): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text
    ? `_${text.slice(0, 500)}${text.length > 500 ? "..." : ""}_`
    : "_No request text provided._";
}

function trustedRepair({ author, reason, marker = null }: LooseRecord) {
  return {
    trigger: "trusted_bot",
    command: "clawsweeper auto repair",
    intent: "clawsweeper_auto_repair",
    trusted_bot: true,
    trusted_bot_author: author,
    automation_source: "clawsweeper",
    repair_reason: reason,
    expected_head_sha: marker?.attrs?.sha ?? null,
    finding_id: marker?.attrs?.finding ?? null,
  };
}

function trustedMerge({ author, reason, marker = null }: LooseRecord) {
  return {
    trigger: "trusted_bot",
    command: "clawsweeper auto merge",
    intent: "clawsweeper_auto_merge",
    trusted_bot: true,
    trusted_bot_author: author,
    automation_source: "clawsweeper",
    repair_reason: reason,
    expected_head_sha: marker?.attrs?.sha ?? null,
    finding_id: marker?.attrs?.finding ?? null,
  };
}

function trustedHumanReview({ author, reason, marker = null }: LooseRecord) {
  return {
    trigger: "trusted_bot",
    command: "clawsweeper needs human",
    intent: "clawsweeper_needs_human",
    trusted_bot: true,
    trusted_bot_author: author,
    automation_source: "clawsweeper",
    repair_reason: reason,
    expected_head_sha: marker?.attrs?.sha ?? null,
    finding_id: marker?.attrs?.finding ?? null,
  };
}

function clawsweeperMarker(body: string, kind: string) {
  const marker = String(body ?? "").match(
    new RegExp(`<!--\\s*clawsweeper-${kind}:\\s*([a-z0-9_-]+)([^>]*)-->`, "i"),
  );
  if (!marker) return null;
  return {
    action: (marker[1] ?? "").toLowerCase(),
    attrs: markerAttributes(marker[2] ?? ""),
  };
}

function markerAttributes(input: JsonValue) {
  const attrs: Record<string, string> = {};
  for (const match of String(input ?? "").matchAll(/([a-z0-9_-]+)=("[^"]*"|'[^']*'|[^\s>]+)/gi)) {
    const raw = match[2] ?? "";
    attrs[(match[1] ?? "").toLowerCase()] = raw.replace(/^["']|["']$/g, "");
  }
  return attrs;
}

function markerReasonSuffix(attrs: LooseRecord) {
  const parts: JsonValue[] = [];
  if (attrs?.finding) parts.push(`finding=${attrs.finding}`);
  if (attrs?.sha) parts.push(`sha=${attrs.sha}`);
  return parts.length ? ` (${parts.join(" ")})` : "";
}

function renderStatusBody(command: LooseRecord) {
  const target = command.target ?? {};
  const lines = ["ClawSweeper status:"];
  if (target.kind === "pull_request") {
    const labelState = automergeLabelState(target.labels ?? []);
    lines.push(`- Current PR: \`${command.issue_number ?? "unknown"}\``);
    lines.push(`- Branch: \`${target.branch ?? "unknown"}\``);
    lines.push(`- ClawSweeper PR: ${target.is_clawsweeper_pr ? "yes" : "no"}`);
    lines.push(`- Automerge: \`${labelState}\``);
    if (target.automerge_job_path) lines.push(`- Automerge job: \`${target.automerge_job_path}\``);
    if (target.job_path) lines.push(`- Job: \`${target.job_path}\``);
    if (target.merge_state_status) lines.push(`- Merge state: \`${target.merge_state_status}\``);
    if (target.review_decision) lines.push(`- Review decision: \`${target.review_decision}\``);
    lines.push(`- Checks: ${formatCounts(target.checks?.counts) || "none"}`);
    if (target.checks?.blockers?.length)
      lines.push(`- Check blockers: ${target.checks.blockers.slice(0, 5).join(", ")}`);
  } else {
    lines.push(`- Current issue: \`${command.issue_number ?? "unknown"}\``);
    lines.push(`- State: \`${target.state ?? "unknown"}\``);
    lines.push("- Existing PR repair: not applicable until a ClawSweeper PR exists.");
  }
  return lines.join("\n");
}

function automergeLabelState(labels: JsonValue[]) {
  const normalized = new Set(labels.map((value: JsonValue) => String(value).toLowerCase()));
  if (normalized.has(HUMAN_REVIEW_LABEL)) return "paused-human-review";
  if (normalized.has(MERGE_READY_LABEL)) return "merge-ready-human-gate";
  if (normalized.has(AUTOMERGE_LABEL)) return "enabled";
  if (normalized.has(AUTOFIX_LABEL)) return "autofix-only";
  return "not-enabled";
}

function formatCounts(counts: LooseRecord) {
  return Object.entries(counts ?? {})
    .map(([key, value]: JsonValue[]) => `${key}:${value}`)
    .join(" ");
}
