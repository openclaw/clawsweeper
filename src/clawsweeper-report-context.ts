import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  Decision,
  GitInfo,
  ItemContext,
  ReviewContextLedgerEntry,
  ReviewRuntime,
} from "./clawsweeper-types.js";
import type { CreateReportRenderingDependencies } from "./clawsweeper-report-rendering-dependencies.js";
import { frontMatterValue } from "./report-front-matter.js";
import { markdownRepository, repoRelativePath } from "./clawsweeper-repository-paths.js";
import { linkedSha, markdownLink } from "./clawsweeper-links.js";
import { fixedInReportText, fixedInText } from "./clawsweeper-status-context.js";
import type { RepositoryProfile } from "./repository-profiles.js";
import { reportReviewDecision } from "./report-review-decision.js";
import { ReviewRecordFormatError } from "./review-record.js";

export function runtimeReviewText(runtime?: {
  model?: string | undefined;
  reasoningEffort?: string | undefined;
}): string {
  const model = runtime?.model?.trim();
  const reasoningEffort = runtime?.reasoningEffort?.trim();
  if (model && reasoningEffort) return `model ${model}, reasoning ${reasoningEffort}`;
  if (model) return `model ${model}`;
  if (reasoningEffort) return `reasoning ${reasoningEffort}`;
  return "";
}

function runtimeReviewTextFromReport(markdown: string): string {
  return runtimeReviewText({
    model: frontMatterValue(markdown, "review_model") ?? "",
    reasoningEffort: frontMatterValue(markdown, "review_reasoning_effort") ?? "",
  });
}

export function closeReviewLineFromDecision(
  decision: Decision,
  git: GitInfo,
  runtime: Pick<ReviewRuntime, "model" | "reasoningEffort"> | undefined,
  profile: RepositoryProfile,
): string {
  const fixed = fixedInText(decision, profile);
  const parts = [
    runtimeReviewText(runtime),
    `reviewed against ${linkedSha(git.mainSha, profile.targetRepo)}`,
  ].filter(Boolean);
  if (fixed !== "not determined") parts.push(`fix evidence: ${fixed}`);
  return `Codex review notes: ${parts.join("; ")}.`;
}

export function closeReviewLineFromReport(markdown: string, profile: RepositoryProfile): string {
  const mainSha = frontMatterValue(markdown, "main_sha");
  const fixed = fixedInReportText(markdown, profile);
  const parts: string[] = [runtimeReviewTextFromReport(markdown)].filter(Boolean);
  if (mainSha && mainSha !== "unknown")
    parts.push(`reviewed against ${linkedSha(mainSha, profile.targetRepo)}`);
  if (fixed !== "not determined") parts.push(`fix evidence: ${fixed}`);
  return parts.length ? `Codex review notes: ${parts.join("; ")}.` : "";
}

export function createReportContextRendering(dependencies: CreateReportRenderingDependencies) {
  const {
    ensureDir,
    formattedMarkdownList,
    inlineCode,
    shouldRenderWorkPlanFromReport,
    workPlanPathForReport,
  } = dependencies;

  function renderWorkPlanFromReport(
    markdown: string,
    options: { reportPath?: string } = {},
  ): string | null {
    if (!shouldRenderWorkPlanFromReport(markdown)) return null;
    const decision = reportReviewDecision(markdown);
    const repo = markdownRepository(markdown);
    const number = frontMatterValue(markdown, "number") ?? "unknown";
    const title = frontMatterValue(markdown, "title") ?? "Untitled";
    const reviewedAt = frontMatterValue(markdown, "reviewed_at") ?? "unknown";
    const workPrompt = decision.workPrompt.trim();
    const likelyFiles = decision.workLikelyFiles;
    const validation = decision.workValidation;
    const clusterRefs = decision.workClusterRefs;
    const reportPath = options.reportPath ?? "unknown";
    return `---
number: ${number}
repository: ${repo}
title: ${JSON.stringify(title)}
source_report: ${reportPath}
reviewed_at: ${reviewedAt}
work_candidate: ${decision.workCandidate ?? "none"}
work_priority: ${decision.workPriority ?? "low"}
work_confidence: ${decision.workConfidence ?? "low"}
---

# Coding Plan for ${repo}#${number}: ${title}

Source report: ${reportPath === "unknown" ? "unknown" : markdownLink(reportPath, reportPath)}

## Summary

${decision.summary || "No summary provided."}

## Plan

${workPrompt || "No repair work prompt provided."}

## Likely Files

${formattedMarkdownList(likelyFiles, inlineCode)}

## Validation

${formattedMarkdownList(validation, inlineCode)}

## Cluster References

${formattedMarkdownList(clusterRefs, (value) => value)}

## Notes

- This file is generated dashboard state from the durable review report.
- Regenerate it from the source report instead of editing it by hand.
`;
  }

  function syncWorkPlanFromReport(options: {
    markdown: string;
    reportPath: string;
    plansDir: string;
    dryRun?: boolean;
  }): boolean {
    const planPath = workPlanPathForReport(options.reportPath, options.plansDir);
    let plan: string | null;
    try {
      plan = renderWorkPlanFromReport(options.markdown, {
        reportPath: repoRelativePath(options.reportPath),
      });
    } catch (error) {
      if (!(error instanceof ReviewRecordFormatError)) throw error;
      // Preserve the report for fresh review, but never leave its old plan runnable.
      plan = null;
    }
    if (!plan) {
      if (!options.dryRun && existsSync(planPath)) unlinkSync(planPath);
      return false;
    }
    if (!options.dryRun) {
      ensureDir(dirname(planPath));
      writeFileSync(planPath, plan, "utf8");
    }
    return true;
  }

  function reviewTelemetryNumber(value: number | undefined): string {
    if (value === undefined || !Number.isFinite(value)) return "unknown";
    return String(Math.max(0, Math.round(value)));
  }

  function contextCountText(
    total: number | undefined,
    fallback: number,
    hydrated?: number,
    truncated?: boolean,
  ): string {
    const displayTotal =
      total === undefined || !Number.isFinite(total) ? Math.max(0, fallback) : Math.max(0, total);
    if (hydrated === undefined || !Number.isFinite(hydrated)) return String(displayTotal);
    const displayHydrated = Math.max(0, Math.round(hydrated));
    if (!truncated && displayHydrated >= displayTotal) return String(displayTotal);
    return `${displayTotal} (hydrated ${displayHydrated}${truncated ? ", truncated" : ""})`;
  }

  function promptJsonChars(value: unknown): number {
    return JSON.stringify(value, null, 2).length;
  }

  function reviewContextLedgerEntry(options: {
    section: string;
    label: string;
    value: unknown;
    entries: number;
    total?: number | undefined;
    hydrated?: number | undefined;
    truncated?: boolean | undefined;
  }): ReviewContextLedgerEntry {
    const entry: ReviewContextLedgerEntry = {
      section: options.section,
      label: options.label,
      entries: Math.max(0, Math.round(options.entries)),
      chars: promptJsonChars(options.value),
    };
    if (options.total !== undefined && Number.isFinite(options.total)) {
      entry.total = Math.max(0, Math.round(options.total));
    }
    if (options.hydrated !== undefined && Number.isFinite(options.hydrated)) {
      entry.hydrated = Math.max(0, Math.round(options.hydrated));
    }
    if (options.truncated !== undefined) entry.truncated = options.truncated;
    return entry;
  }

  function arrayEntries(value: unknown[] | undefined): number {
    return value?.length ?? 0;
  }

  function reviewContextLedger(context: ItemContext): ReviewContextLedgerEntry[] {
    const counts = context.counts;
    const entries = [
      reviewContextLedgerEntry({
        section: "issue",
        label: "issue",
        value: context.issue,
        entries: 1,
      }),
      reviewContextLedgerEntry({
        section: "comments",
        label: "comments",
        value: context.comments,
        entries: context.comments.length,
        total: counts?.comments,
        hydrated: counts?.commentsHydrated,
        truncated: counts?.commentsTruncated,
      }),
      reviewContextLedgerEntry({
        section: "timeline",
        label: "timeline events",
        value: context.timeline,
        entries: context.timeline.length,
        total: counts?.timeline,
        hydrated: counts?.timelineHydrated,
        truncated: counts?.timelineTruncated,
      }),
      reviewContextLedgerEntry({
        section: "previousClawSweeperReview",
        label: "previous ClawSweeper review",
        value: context.previousClawSweeperReview ?? null,
        entries: context.previousClawSweeperReview === undefined ? 0 : 1,
      }),
      reviewContextLedgerEntry({
        section: "closingPullRequests",
        label: "closing PRs",
        value: context.closingPullRequests ?? [],
        entries: arrayEntries(context.closingPullRequests),
        total: counts?.closingPullRequests,
      }),
      reviewContextLedgerEntry({
        section: "relatedItems",
        label: "related items",
        value: context.relatedItems ?? [],
        entries: arrayEntries(context.relatedItems),
        total: counts?.relatedItems,
      }),
      reviewContextLedgerEntry({
        section: "pullRequest",
        label: "pull request",
        value: context.pullRequest ?? null,
        entries: context.pullRequest === undefined ? 0 : 1,
      }),
      reviewContextLedgerEntry({
        section: "pullFiles",
        label: "PR files",
        value: context.pullFiles ?? [],
        entries: arrayEntries(context.pullFiles),
        total: counts?.pullFiles,
        hydrated: counts?.pullFilesHydrated,
        truncated: counts?.pullFilesTruncated,
      }),
      reviewContextLedgerEntry({
        section: "pullCommits",
        label: "PR commits",
        value: context.pullCommits ?? [],
        entries: arrayEntries(context.pullCommits),
        total: counts?.pullCommits,
        hydrated: counts?.pullCommitsHydrated,
        truncated: counts?.pullCommitsTruncated,
      }),
      reviewContextLedgerEntry({
        section: "pullReviewComments",
        label: "PR review comments",
        value: context.pullReviewComments ?? [],
        entries: arrayEntries(context.pullReviewComments),
        total: counts?.pullReviewComments,
        hydrated: counts?.pullReviewCommentsHydrated,
        truncated: counts?.pullReviewCommentsTruncated,
      }),
      reviewContextLedgerEntry({
        section: "pullChecks",
        label: "PR checks",
        value: context.pullChecks ?? null,
        entries: context.pullChecks === undefined ? 0 : 1,
      }),
      reviewContextLedgerEntry({
        section: "counts",
        label: "context counts",
        value: counts ?? {},
        entries: Object.keys(counts ?? {}).length,
      }),
    ];
    return entries.filter((entry) => entry.entries > 0 || (entry.total ?? 0) > 0);
  }

  function reviewContextLedgerForTest(context: ItemContext): ReviewContextLedgerEntry[] {
    return reviewContextLedger(context);
  }

  function reviewContextLedgerCountText(entry: ReviewContextLedgerEntry): string {
    if (entry.total !== undefined || entry.hydrated !== undefined) {
      const total = entry.total ?? entry.entries;
      const hydrated = entry.hydrated ?? entry.entries;
      const suffix = entry.truncated ? ", truncated" : "";
      return `${hydrated}/${total} hydrated${suffix}`;
    }
    return `${entry.entries} ${entry.entries === 1 ? "entry" : "entries"}`;
  }

  function renderReviewContextBudget(context: ItemContext): string {
    return reviewContextLedger(context)
      .map(
        (entry) => `- ${entry.label}: ${reviewContextLedgerCountText(entry)}, ${entry.chars} chars`,
      )
      .join("\n");
  }

  function renderReviewContextBudgetForTest(context: ItemContext): string {
    return renderReviewContextBudget(context);
  }

  return {
    renderWorkPlanFromReport,
    syncWorkPlanFromReport,
    reviewTelemetryNumber,
    contextCountText,
    promptJsonChars,
    reviewContextLedgerEntry,
    arrayEntries,
    reviewContextLedger,
    reviewContextLedgerForTest,
    reviewContextLedgerCountText,
    renderReviewContextBudget,
    renderReviewContextBudgetForTest,
  };
}
