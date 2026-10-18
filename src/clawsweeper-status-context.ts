import {
  displayTitle,
  formatStatusNumber,
  formatTimestamp,
} from "./clawsweeper-status-presentation.js";
export {
  formatReviewFreshnessTimestamp,
  displayTitle,
  fixedInText,
  fixedInReportText,
  formatTimestamp,
  formatStatusNumber,
} from "./clawsweeper-status-presentation.js";
import { createFixedPullRequestContext } from "./clawsweeper-fixed-pull-request.js";
export {
  MAX_IMPLEMENTATION_LINKED_ISSUE_REFERENCES,
  linkedIssueNumbersForPullRequestBody,
  linkedIssueNumbersForImplementationProvenance,
  currentClosingPullRequestReferenceFromIssueTimeline,
} from "./clawsweeper-fixed-pull-request.js";
import { existsSync, readFileSync } from "node:fs";
import { escapeRegExp } from "./clawsweeper-markdown.js";
import type { WorkflowStatusSummary } from "./clawsweeper-types.js";

import { targetProfile, type RepositoryProfile } from "./repository-profiles.js";
import { nonBlankStringOrUndefined, numberOrUndefined } from "./value-coerce.js";
import { markdownLink, repoUrlFor } from "./clawsweeper-links.js";

import {
  profileStatusStart,
  profileStatusEnd,
  sweepStatusPath,
} from "./clawsweeper-sweep-status.js";

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function createStatusContext() {
  const {
    fixedPullRequestFromCommitPulls,
    attachFixedPullRequest,
    implementedOnMainPullRequestProvenanceApplyBlock,
  } = createFixedPullRequestContext();

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

  function readSweepStatusSummary(profile = targetProfile()): WorkflowStatusSummary | null {
    const path = sweepStatusPath(profile);
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      return {
        updatedAt: nonBlankStringOrUndefined(parsed.updated_at),
        state: nonBlankStringOrUndefined(parsed.state) ?? "Idle",
        detail:
          nonBlankStringOrUndefined(parsed.detail) ?? "No workflow status has been published yet.",
        runUrl: nonBlankStringOrUndefined(parsed.run_url),
        applyHealth: recordOrUndefined(parsed.apply_health),
        lastCloseApplyHealth: recordOrUndefined(parsed.last_close_apply_health),
        plannedCount: numberOrUndefined(parsed.planned_count),
        plannedCapacity: numberOrUndefined(parsed.planned_capacity),
        plannedShards: numberOrUndefined(parsed.planned_shards),
        activeCodex: numberOrUndefined(parsed.active_codex),
        dueBacklog: numberOrUndefined(parsed.due_backlog),
        oldestUnreviewedAt: nonBlankStringOrUndefined(parsed.oldest_unreviewed_at),
        capacityReason: nonBlankStringOrUndefined(parsed.capacity_reason),
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

  return {
    fixedPullRequestFromCommitPulls,
    attachFixedPullRequest,
    implementedOnMainPullRequestProvenanceApplyBlock,
    currentWorkflowStatusBlock,
    displayTitle,
    formatStatusNumber,
    formatTimestamp,
    readSweepStatusSummary,
    workflowStatusSummary,
  };
}
