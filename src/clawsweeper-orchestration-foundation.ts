import type { ItemContext, ReviewMetric } from "./clawsweeper-types.js";
import {
  buildOpenClawPrSurfaceStats,
  countOpenClawAddedTestFiles,
  renderOpenClawPrSurfaceSummary,
  renderOpenClawPrSurfaceTable,
  type PrSurfaceFile,
} from "./pr-surface-stats.js";
import { normalizeRepo } from "./repository-profiles.js";
import { asRecord } from "./value-coerce.js";
import {
  frontMatterBoolean,
  frontMatterJsonArray,
  frontMatterValue,
} from "./report-front-matter.js";
import { markdownRepository } from "./clawsweeper-repository-paths.js";
import { collapsedDetailsBlock, publicTableCell } from "./clawsweeper-report-helpers.js";
import { reportRealBehaviorProofPolicy } from "./clawsweeper-proof-policy.js";
import { sentence } from "./clawsweeper-review-presentation.js";

export function prSurfaceFilesFromContext(context: ItemContext): PrSurfaceFile[] | null {
  const entries = context.pullFiles ?? [];
  if (
    context.counts?.pullFilesTruncated ||
    [context.counts?.pullFiles, context.counts?.pullFilesHydrated].some(
      (count) => count !== undefined && nonNegativeInteger(count) !== entries.length,
    )
  ) {
    return null;
  }
  return prSurfaceFilesFromEntries(entries, "filename");
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function prSurfaceFilesFromEntries(
  entries: unknown[],
  pathKey: "filename" | "path",
): PrSurfaceFile[] | null {
  const files: PrSurfaceFile[] = [];
  for (const entry of entries) {
    const file = asRecord(entry);
    const path = file[pathKey];
    if (typeof path !== "string" || !path || "omitted" in file) return null;
    files.push({
      path,
      additions: nonNegativeInteger(file.additions),
      deletions: nonNegativeInteger(file.deletions),
      ...(typeof file.status === "string" ? { status: file.status } : {}),
    });
  }
  return files;
}

export function prSurfaceFilesFromReport(markdown: string): PrSurfaceFile[] | null {
  if (frontMatterBoolean(markdown, "pr_surface_files_truncated")) return null;
  const raw = frontMatterValue(markdown, "pr_surface_files");
  if (!raw) return [];
  try {
    const entries: unknown = JSON.parse(raw);
    return Array.isArray(entries) ? prSurfaceFilesFromEntries(entries, "path") : null;
  } catch {
    return null;
  }
}

function shouldRenderOpenClawPrSurface(markdown: string): boolean {
  return (
    frontMatterValue(markdown, "type") === "pull_request" &&
    normalizeRepo(markdownRepository(markdown)) === "openclaw/openclaw"
  );
}

export function renderOpenClawPrSurfaceFromReport(markdown: string): string {
  if (!shouldRenderOpenClawPrSurface(markdown)) return "";
  const files = prSurfaceFilesFromReport(markdown);
  if (files === null) return "PR surface statistics unavailable: the file list is incomplete.";
  if (files.length === 0) return "";
  const stats = buildOpenClawPrSurfaceStats(files);
  if (stats === null) {
    return "PR surface statistics unavailable: complete line counts are not available for every file.";
  }
  const summary = renderOpenClawPrSurfaceSummary(stats);
  if (!summary) return "";
  const addedTestFiles = countOpenClawAddedTestFiles(files);
  const summaryLine =
    addedTestFiles === null ? summary : `${summary} Added test files: ${addedTestFiles}.`;
  const details = collapsedDetailsBlock("View PR surface stats", [
    renderOpenClawPrSurfaceTable(stats),
  ]);
  return details ? `${summaryLine}\n\n${details}` : summaryLine;
}

export function reviewMetricsFromReport(markdown: string): ReviewMetric[] {
  return frontMatterJsonArray(markdown, "review_metrics")
    .map((entry) => {
      const metric = asRecord(entry);
      const label = typeof metric.label === "string" ? metric.label.trim() : "";
      const value = typeof metric.value === "string" ? metric.value.trim() : "";
      const reason = typeof metric.reason === "string" ? metric.reason.trim() : "";
      if (!label || !value || !reason) return null;
      return { label, value, reason };
    })
    .filter((entry): entry is ReviewMetric => Boolean(entry));
}

export function renderReviewMetricsDigest(metrics: readonly ReviewMetric[]): string {
  if (metrics.length === 0) return "None.";
  return [
    "| Metric | Value | Why it matters |",
    "|---|---|---|",
    ...metrics.map(
      (metric) =>
        `| **${publicTableCell(metric.label)}** | ${publicTableCell(metric.value)} | ${publicTableCell(sentence(metric.reason))} |`,
    ),
  ].join("\n");
}

export function realBehaviorProofBlocksMerge(markdown: string): boolean {
  return reportRealBehaviorProofPolicy(markdown).blocksMerge;
}
