import { existsSync, readFileSync } from "node:fs";
import { CONFIDENCES } from "./clawsweeper-policy.js";
import { escapeRegExp } from "./clawsweeper-text.js";
import type {
  Confidence,
  Decision,
  FixedPullRequest,
  Item,
  ItemContext,
  WorkflowStatusSummary,
} from "./clawsweeper-types.js";
import { isGitHubNotFoundError } from "./github-retry.js";
import type { RepositoryProfile } from "./repository-profiles.js";

interface StatusContextDependencies {
  targetProfile: () => RepositoryProfile;
  targetRepo: () => string;
  markdownLink: (label: string, url: string) => string;
  repoUrlFor: (repo: string, relativePath?: string) => string;
  linkedRelease: (tag: string) => string;
  linkedSha: (sha: string) => string;
  profileStatusStart: (profile?: RepositoryProfile) => string;
  profileStatusEnd: (profile?: RepositoryProfile) => string;
  sweepStatusPath: (profile?: RepositoryProfile) => string;
  markdownRepository: (markdown: string, file?: string) => string;
  ghJson: <T>(args: string[]) => T;
  asRecord: (value: unknown) => Record<string, unknown>;
  frontMatterValue: (markdown: string, key: string) => string | undefined;
  stringOrUndefined: (value: unknown) => string | undefined;
  numberOrUndefined: (value: unknown) => number | undefined;
  recordOrUndefined: (value: unknown) => Record<string, unknown> | undefined;
}

export function createStatusContext({
  targetProfile,
  targetRepo,
  markdownLink,
  repoUrlFor,
  linkedRelease,
  linkedSha,
  profileStatusStart,
  profileStatusEnd,
  sweepStatusPath,
  markdownRepository,
  ghJson,
  asRecord,
  frontMatterValue,
  stringOrUndefined,
  numberOrUndefined,
  recordOrUndefined,
}: StatusContextDependencies) {
  function formatTimestamp(iso: string | undefined): string {
    if (!iso) return "unknown";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "UTC",
      timeZoneName: "short",
    }).format(date);
  }

  function formatReviewFreshnessTimestamp(iso: string | undefined): string {
    if (!iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    const utcTime = date.toISOString().slice(11, 16);
    const eastern = new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: "America/New_York",
    })
      .format(date)
      .replace(" at ", ", ");
    const easternDate = new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "America/New_York",
    }).format(date);
    const utcDate = new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    }).format(date);
    const utc = easternDate === utcDate ? utcTime : `${utcDate}, ${utcTime}`;
    return `${eastern} ET / ${utc} UTC`;
  }

  function workflowStatusBlock(options?: {
    state?: string | undefined;
    detail?: string | undefined;
    runUrl?: string | undefined;
    updatedAt?: string | undefined;
    profile?: RepositoryProfile | undefined;
    plannedCount?: number | undefined;
    plannedCapacity?: number | undefined;
    plannedShards?: number | undefined;
    activeCodex?: number | undefined;
    dueBacklog?: number | undefined;
    oldestUnreviewedAt?: string | undefined;
    capacityReason?: string | undefined;
    inheritedLabelCleanups?: number | undefined;
    selfHealConflictRepairs?: number | undefined;
    failedReviewRetries?: number | undefined;
    failedReviewRetryExhaustions?: number | undefined;
    botOwnedProofDecisionsRequested?: number | undefined;
    botOwnedProofDispatches?: number | undefined;
  }): string {
    const profile = options?.profile ?? targetProfile();
    const updatedAt = formatTimestamp(options?.updatedAt ?? new Date().toISOString());
    const state = options?.state ?? "Idle";
    const detail = options?.detail ?? "No workflow status has been published yet.";
    const metrics = workflowStatusMetricLines(options ?? {});
    const metricBlock = metrics.length > 0 ? `\n\n${metrics.join("\n")}` : "";
    const runLine = options?.runUrl ? `\nRun: ${markdownLink(options.runUrl, options.runUrl)}` : "";
    return `${profileStatusStart(profile)}
**Workflow status**

Repository: ${markdownLink(profile.targetRepo, repoUrlFor(profile.targetRepo))}

Updated: ${updatedAt}

State: ${state}

${detail}${metricBlock}${runLine}
${profileStatusEnd(profile)}`;
  }

  function workflowStatusMetricLines(options: {
    plannedCount?: number | undefined;
    plannedCapacity?: number | undefined;
    plannedShards?: number | undefined;
    activeCodex?: number | undefined;
    dueBacklog?: number | undefined;
    oldestUnreviewedAt?: string | undefined;
    capacityReason?: string | undefined;
    inheritedLabelCleanups?: number | undefined;
    selfHealConflictRepairs?: number | undefined;
    failedReviewRetries?: number | undefined;
    failedReviewRetryExhaustions?: number | undefined;
    botOwnedProofDecisionsRequested?: number | undefined;
    botOwnedProofDispatches?: number | undefined;
  }): string[] {
    const lines: string[] = [];
    if (
      options.plannedCount !== undefined ||
      options.plannedShards !== undefined ||
      options.plannedCapacity !== undefined
    ) {
      lines.push(
        `Plan: ${formatStatusNumber(options.plannedCount)} items across ${formatStatusNumber(
          options.plannedShards,
        )} shards (capacity ${formatStatusNumber(options.plannedCapacity)}).`,
      );
    }
    if (options.activeCodex !== undefined) {
      lines.push(`Active Codex target: ${formatStatusNumber(options.activeCodex)}.`);
    }
    if (options.dueBacklog !== undefined) {
      lines.push(`Due backlog scanned: ${formatStatusNumber(options.dueBacklog)}.`);
    }
    if (options.oldestUnreviewedAt) {
      lines.push(`Oldest unreviewed: ${formatTimestamp(options.oldestUnreviewedAt)}.`);
    }
    if (options.capacityReason) {
      lines.push(`Capacity reason: ${options.capacityReason}.`);
    }
    if (options.inheritedLabelCleanups !== undefined) {
      lines.push(
        `Inherited label cleanups: ${formatStatusNumber(options.inheritedLabelCleanups)}.`,
      );
    }
    if (options.selfHealConflictRepairs !== undefined) {
      lines.push(
        `Self-heal conflict repairs: ${formatStatusNumber(options.selfHealConflictRepairs)}.`,
      );
    }
    if (options.failedReviewRetries !== undefined) {
      lines.push(`Failed-review retries: ${formatStatusNumber(options.failedReviewRetries)}.`);
    }
    if (options.failedReviewRetryExhaustions !== undefined) {
      lines.push(
        `Failed-review retry exhaustions: ${formatStatusNumber(options.failedReviewRetryExhaustions)}.`,
      );
    }
    if (options.botOwnedProofDecisionsRequested !== undefined) {
      lines.push(
        `Bot-owned proof decisions requested: ${formatStatusNumber(options.botOwnedProofDecisionsRequested)}.`,
      );
    }
    if (options.botOwnedProofDispatches !== undefined) {
      lines.push(
        `Bot-owned proof dispatches: ${formatStatusNumber(options.botOwnedProofDispatches)}.`,
      );
    }
    return lines;
  }

  function formatStatusNumber(value: number | undefined): string {
    return value === undefined || !Number.isFinite(value) ? "unknown" : String(value);
  }

  function readSweepStatusSummary(profile = targetProfile()): WorkflowStatusSummary | null {
    const path = sweepStatusPath(profile);
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      return {
        updatedAt: stringOrUndefined(parsed.updated_at),
        state: stringOrUndefined(parsed.state) ?? "Idle",
        detail: stringOrUndefined(parsed.detail) ?? "No workflow status has been published yet.",
        runUrl: stringOrUndefined(parsed.run_url),
        applyHealth: recordOrUndefined(parsed.apply_health),
        lastCloseApplyHealth: recordOrUndefined(parsed.last_close_apply_health),
        plannedCount: numberOrUndefined(parsed.planned_count),
        plannedCapacity: numberOrUndefined(parsed.planned_capacity),
        plannedShards: numberOrUndefined(parsed.planned_shards),
        activeCodex: numberOrUndefined(parsed.active_codex),
        dueBacklog: numberOrUndefined(parsed.due_backlog),
        oldestUnreviewedAt: stringOrUndefined(parsed.oldest_unreviewed_at),
        capacityReason: stringOrUndefined(parsed.capacity_reason),
        inheritedLabelCleanups: numberOrUndefined(parsed.inherited_label_cleanups),
        selfHealConflictRepairs: numberOrUndefined(parsed.self_heal_conflict_repairs),
        failedReviewRetries: numberOrUndefined(parsed.failed_review_retries),
        failedReviewRetryExhaustions: numberOrUndefined(parsed.failed_review_retry_exhaustions),
        botOwnedProofDecisionsRequested: numberOrUndefined(
          parsed.bot_owned_proof_decisions_requested,
        ),
        botOwnedProofDispatches: numberOrUndefined(parsed.bot_owned_proof_dispatches),
      };
    } catch {
      return null;
    }
  }

  function currentWorkflowStatusBlock(readme: string, profile = targetProfile()): string {
    const statusSummary = readSweepStatusSummary(profile);
    if (statusSummary) return workflowStatusBlock({ ...statusSummary, profile });
    const profilePattern = new RegExp(
      `${escapeRegExp(profileStatusStart(profile))}[\\s\\S]*?${escapeRegExp(profileStatusEnd(profile))}`,
    );
    const profileMatch = readme.match(profilePattern)?.[0];
    if (profileMatch) {
      const summary = workflowStatusSummary(profileMatch);
      if (
        summary.state === "Idle" &&
        summary.detail === "No workflow status has been published yet." &&
        !summary.runUrl
      ) {
        return workflowStatusBlock({ profile, updatedAt: "unknown" });
      }
      return profileMatch;
    }
    return workflowStatusBlock({ profile, updatedAt: "unknown" });
  }

  function workflowStatusSummary(block: string): WorkflowStatusSummary {
    const updatedAt = block.match(/^Updated: (.+)$/m)?.[1];
    const state = block.match(/^State: (.+)$/m)?.[1] ?? "Idle";
    const runUrl = block.match(/^Run: \[([^\]]+)\]\([^)]+\)$/m)?.[1];
    const detailMatch = block.match(
      /^State: .+\n\n([\s\S]*?)(?:\n\nPlan: |\n\nActive Codex target: |\n\nDue backlog scanned: |\n\nOldest unreviewed: |\n\nCapacity reason: |\n\nInherited label cleanups: |\n\nSelf-heal conflict repairs: |\n\nFailed-review retries: |\n\nFailed-review retry exhaustions: |\n\nBot-owned proof decisions requested: |\n\nBot-owned proof dispatches: |\nRun: |\n<!-- clawsweeper-status)/m,
    );
    const detail = detailMatch?.[1]?.trim() || "No workflow status has been published yet.";
    const planMatch = block.match(/^Plan: (\d+) items across (\d+) shards \(capacity (\d+)\)\.$/m);
    const activeCodex = numberOrUndefined(block.match(/^Active Codex target: (\d+)\.$/m)?.[1]);
    const dueBacklog = numberOrUndefined(block.match(/^Due backlog scanned: (\d+)\.$/m)?.[1]);
    const oldestUnreviewedAt = block.match(/^Oldest unreviewed: (.+)\.$/m)?.[1];
    const capacityReason = block.match(/^Capacity reason: (.+)\.$/m)?.[1];
    const inheritedLabelCleanups = numberOrUndefined(
      block.match(/^Inherited label cleanups: (\d+)\.$/m)?.[1],
    );
    const selfHealConflictRepairs = numberOrUndefined(
      block.match(/^Self-heal conflict repairs: (\d+)\.$/m)?.[1],
    );
    const failedReviewRetries = numberOrUndefined(
      block.match(/^Failed-review retries: (\d+)\.$/m)?.[1],
    );
    const failedReviewRetryExhaustions = numberOrUndefined(
      block.match(/^Failed-review retry exhaustions: (\d+)\.$/m)?.[1],
    );
    const botOwnedProofDecisionsRequested = numberOrUndefined(
      block.match(/^Bot-owned proof decisions requested: (\d+)\.$/m)?.[1],
    );
    const botOwnedProofDispatches = numberOrUndefined(
      block.match(/^Bot-owned proof dispatches: (\d+)\.$/m)?.[1],
    );
    return {
      updatedAt,
      state,
      detail,
      runUrl,
      applyHealth: undefined,
      lastCloseApplyHealth: undefined,
      plannedCount: numberOrUndefined(planMatch?.[1]),
      plannedShards: numberOrUndefined(planMatch?.[2]),
      plannedCapacity: numberOrUndefined(planMatch?.[3]),
      activeCodex,
      dueBacklog,
      oldestUnreviewedAt,
      capacityReason,
      inheritedLabelCleanups,
      selfHealConflictRepairs,
      failedReviewRetries,
      failedReviewRetryExhaustions,
      botOwnedProofDecisionsRequested,
      botOwnedProofDispatches,
    };
  }

  function displayTitle(title: string): string {
    try {
      const parsed = JSON.parse(title) as unknown;
      if (typeof parsed === "string") return parsed;
    } catch {
      // Front matter from older files may be a plain string.
    }
    return title.replace(/^"|"$/g, "");
  }

  function fixedInText(decision: Decision): string {
    const parts: string[] = [];
    if (decision.fixedPullRequest?.confidence === "high")
      parts.push(`merged PR ${linkedPullRequest(decision.fixedPullRequest)}`);
    if (decision.fixedRelease) parts.push(`release ${linkedRelease(decision.fixedRelease)}`);
    if (decision.fixedSha) parts.push(`commit ${linkedSha(decision.fixedSha)}`);
    if (!decision.fixedRelease && decision.fixedAt)
      parts.push(`main fix timestamp ${decision.fixedAt}`);
    return parts.length ? parts.join(", ") : "not determined";
  }

  function fixedPullRequestFromUnknown(value: unknown, source: string): FixedPullRequest | null {
    const pull = asRecord(value);
    const number = pull.number;
    if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) return null;
    const url = typeof pull.url === "string" ? pull.url : pull.html_url;
    if (typeof url !== "string" || !url) return null;
    const title = typeof pull.title === "string" ? pull.title : `#${number}`;
    const mergedAt = typeof pull.mergedAt === "string" ? pull.mergedAt : pull.merged_at;
    const merged = pull.merged === true || typeof mergedAt === "string";
    if (!merged) return null;
    const head = asRecord(pull.head);
    const sha =
      typeof pull.mergeCommitSha === "string"
        ? pull.mergeCommitSha
        : typeof pull.merge_commit_sha === "string"
          ? pull.merge_commit_sha
          : typeof head.sha === "string"
            ? head.sha
            : null;
    return {
      repo: targetRepo(),
      number,
      url,
      title,
      mergedAt: typeof mergedAt === "string" ? mergedAt : null,
      sha,
      confidence: "high",
      source,
    };
  }

  function fixedPullRequestFromContext(
    item: Item,
    context: ItemContext,
    decision: Decision,
  ): FixedPullRequest | null {
    if (item.kind !== "issue") return null;
    if (decision.decision !== "close" || decision.confidence !== "high") return null;
    if (!Array.isArray(context.closingPullRequests)) return null;
    const candidates = context.closingPullRequests
      .map((pull) => fixedPullRequestFromUnknown(pull, "GitHub closing PR reference"))
      .filter((pull): pull is FixedPullRequest => pull !== null)
      .sort((left, right) => {
        const leftTime = left.mergedAt ? Date.parse(left.mergedAt) : 0;
        const rightTime = right.mergedAt ? Date.parse(right.mergedAt) : 0;
        return rightTime - leftTime;
      });
    return candidates[0] ?? null;
  }

  function fixedPullRequestFromCommitPulls(
    pulls: readonly unknown[],
    source: string,
    issueNumber: number,
    commitMessage = "",
    defaultBranch = "main",
  ): FixedPullRequest | null {
    const commitClosesIssue = textExplicitlyClosesIssue(commitMessage, issueNumber);
    const candidates = pulls
      .filter(
        (pull) =>
          pullTargetsBranch(pull, defaultBranch) &&
          (commitClosesIssue || pullExplicitlyClosesIssue(pull, issueNumber)),
      )
      .map((pull) => fixedPullRequestFromUnknown(pull, source))
      .filter((pull): pull is FixedPullRequest => pull !== null)
      .sort((left, right) => {
        const leftTime = left.mergedAt ? Date.parse(left.mergedAt) : 0;
        const rightTime = right.mergedAt ? Date.parse(right.mergedAt) : 0;
        return rightTime - leftTime;
      });
    return candidates[0] ?? null;
  }

  function fixedPullRequestFromCommitPullsForTest(
    pulls: readonly unknown[],
    issueNumber: number,
    commitMessage = "",
    defaultBranch = "main",
  ): FixedPullRequest | null {
    return fixedPullRequestFromCommitPulls(
      pulls,
      "GitHub commit PR lookup",
      issueNumber,
      commitMessage,
      defaultBranch,
    );
  }

  function pullTargetsBranch(value: unknown, branch: string): boolean {
    return asRecord(asRecord(value).base).ref === branch;
  }

  function pullExplicitlyClosesIssue(value: unknown, issueNumber: number): boolean {
    const body = asRecord(value).body;
    if (typeof body !== "string" || !body.trim()) return false;
    return textExplicitlyClosesIssue(body, issueNumber);
  }

  function textExplicitlyClosesIssue(text: string, issueNumber: number): boolean {
    const issue = escapeRegExp(String(issueNumber));
    const repo = escapeRegExp(targetRepo());
    const closingReference = new RegExp(
      `\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\b[\\t ]*(?::[\\t ]*)?` +
        `(?:#${issue}\\b|${repo}#${issue}\\b|https?:\\/\\/github\\.com\\/${repo}\\/issues\\/${issue}\\b)`,
      "i",
    );
    return text.split(/\r?\n/).some((line) => closingReference.test(line));
  }

  function fixedPullRequestFromCommitSha(
    decision: Decision,
    issueNumber: number,
  ): FixedPullRequest | null {
    if (decision.decision !== "close" || decision.confidence !== "high") return null;
    const fixedSha = decision.fixedSha?.trim();
    if (!fixedSha || fixedSha === "unknown") return null;
    try {
      const pulls = ghJson<unknown[]>([
        "api",
        `repos/${targetRepo()}/commits/${fixedSha}/pulls`,
        "-H",
        "Accept: application/vnd.github+json",
      ]);
      const repository = asRecord(ghJson<unknown>(["api", `repos/${targetRepo()}`]));
      const defaultBranch = repository.default_branch;
      if (typeof defaultBranch !== "string" || !defaultBranch.trim()) return null;
      const bodyMatch = fixedPullRequestFromCommitPulls(
        pulls,
        "GitHub commit PR lookup",
        issueNumber,
        "",
        defaultBranch,
      );
      if (bodyMatch) return bodyMatch;
      const commit = asRecord(
        ghJson<unknown>(["api", `repos/${targetRepo()}/commits/${fixedSha}`]),
      );
      const commitMessage = asRecord(commit.commit).message;
      return fixedPullRequestFromCommitPulls(
        pulls,
        "GitHub commit PR lookup",
        issueNumber,
        typeof commitMessage === "string" ? commitMessage : "",
        defaultBranch,
      );
    } catch (error) {
      if (isGitHubNotFoundError(error)) return null;
      throw error;
    }
  }

  function attachFixedPullRequest(decision: Decision, item: Item, context: ItemContext): Decision {
    if (decision.fixedPullRequest) return decision;
    const fixedPullRequest =
      fixedPullRequestFromContext(item, context, decision) ??
      (item.kind === "issue" ? fixedPullRequestFromCommitSha(decision, item.number) : null);
    return fixedPullRequest ? { ...decision, fixedPullRequest } : decision;
  }

  function linkedPullRequest(pull: FixedPullRequest): string {
    return markdownLink(`#${pull.number}`, pull.url);
  }

  function fixedInReportText(markdown: string): string {
    const parts: string[] = [];
    const fixedPullRequest = fixedPullRequestFromReport(markdown);
    const fixedRelease = frontMatterValue(markdown, "fixed_release");
    const fixedSha = frontMatterValue(markdown, "fixed_sha");
    const fixedAt = frontMatterValue(markdown, "fixed_at");
    if (fixedPullRequest?.confidence === "high")
      parts.push(`merged PR ${linkedPullRequest(fixedPullRequest)}`);
    if (fixedRelease && fixedRelease !== "unknown")
      parts.push(`release ${linkedRelease(fixedRelease)}`);
    if (fixedSha && fixedSha !== "unknown") parts.push(`commit ${linkedSha(fixedSha)}`);
    if ((!fixedRelease || fixedRelease === "unknown") && fixedAt && fixedAt !== "unknown")
      parts.push(`main fix timestamp ${fixedAt}`);
    return parts.length ? parts.join(", ") : "not determined";
  }

  function fixedPullRequestFromReport(markdown: string): FixedPullRequest | null {
    const url = frontMatterValue(markdown, "fixed_pr_url");
    const rawNumber = frontMatterValue(markdown, "fixed_pr_number");
    const number = rawNumber ? Number(rawNumber) : NaN;
    if (!url || url === "unknown" || !Number.isInteger(number) || number <= 0) return null;
    const confidence = frontMatterValue(markdown, "fixed_pr_confidence") as Confidence | undefined;
    return {
      repo: markdownRepository(markdown),
      number,
      url,
      title: displayTitle(frontMatterValue(markdown, "fixed_pr_title") ?? `#${number}`),
      mergedAt: nonUnknownFrontMatter(markdown, "fixed_pr_merged_at"),
      sha: nonUnknownFrontMatter(markdown, "fixed_pr_sha"),
      confidence: confidence && CONFIDENCES.has(confidence) ? confidence : "low",
      source: nonUnknownFrontMatter(markdown, "fixed_pr_source") ?? "report metadata",
    };
  }

  function nonUnknownFrontMatter(markdown: string, key: string): string | null {
    const value = frontMatterValue(markdown, key);
    return value && value !== "unknown" ? value : null;
  }

  return {
    fixedPullRequestFromCommitPullsForTest,
    attachFixedPullRequest,
    currentWorkflowStatusBlock,
    displayTitle,
    fixedInReportText,
    fixedInText,
    fixedPullRequestFromReport,
    formatReviewFreshnessTimestamp,
    formatStatusNumber,
    formatTimestamp,
    readSweepStatusSummary,
    workflowStatusSummary,
  };
}
