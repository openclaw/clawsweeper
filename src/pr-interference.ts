import { createHash } from "node:crypto";

import { stableJson } from "./stable-json.js";

export type InterferenceSeverity = "lines" | "file";
export type InterferenceContainment = "a_within_b" | "b_within_a" | "equal" | "none";

export interface PrRadarFile {
  base_path: string;
  status: string;
  line_ranges: number[][] | null;
}

export interface PrRadarPr {
  number: number;
  title: string;
  url: string;
  author: string;
  draft: boolean;
  base_ref: string;
  head_sha: string;
  files: PrRadarFile[];
  files_truncated: boolean;
}

export interface InterferencePairSide {
  number: number;
  title: string;
  url: string;
  author: string;
  draft: boolean;
  head_sha: string;
}

export interface InterferenceFileOverlap {
  base_path: string;
  severity: InterferenceSeverity;
  overlapping_lines: number[][];
}

export interface InterferencePair {
  pr_a: InterferencePairSide;
  pr_b: InterferencePairSide;
  severity: InterferenceSeverity;
  containment: InterferenceContainment;
  overlapping_line_total: number;
  files: InterferenceFileOverlap[];
}

export interface PrInterferenceLimits {
  max_prs: number;
  max_file_pages_per_pr: number;
  max_pairs: number;
}

export interface PrInterferenceReport {
  schema_version: 1;
  target_repo: string;
  prs_scanned: number;
  limits: PrInterferenceLimits;
  truncated: { prs: boolean; pairs: boolean };
  pairs: InterferencePair[];
  digest: string;
  updated_at: string;
}

const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm;

export function parseBaseIntervals(patch: string): number[][] {
  const intervals: number[][] = [];
  for (const match of patch.matchAll(HUNK_HEADER_PATTERN)) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (count > 0) intervals.push([start, start + count - 1]);
    else intervals.push([Math.max(1, start), start + 1]);
  }
  return mergeIntervals(intervals);
}

export function mergeIntervals(intervals: readonly (readonly number[])[]): number[][] {
  const sorted = intervals
    .map((interval): [number, number] => [interval[0] ?? 0, interval[1] ?? 0])
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged: [number, number][] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval[0] <= last[1] + 1) last[1] = Math.max(last[1], interval[1]);
    else merged.push([interval[0], interval[1]]);
  }
  return merged;
}

export function prRadarFileFromApi(file: {
  filename: string;
  status: string;
  previous_filename?: string | undefined;
  patch?: string | undefined;
}): PrRadarFile {
  const basePath = file.previous_filename ?? file.filename;
  const lineRanges =
    file.status === "added" || typeof file.patch !== "string"
      ? null
      : parseBaseIntervals(file.patch);
  return { base_path: basePath, status: file.status, line_ranges: lineRanges };
}

export function detectInterference(
  prs: readonly PrRadarPr[],
  maxPairs: number,
): { pairs: InterferencePair[]; pairs_truncated: boolean } {
  const byPath = new Map<string, { pr: PrRadarPr; file: PrRadarFile }[]>();
  for (const pr of prs) {
    for (const file of pr.files) {
      const key = `${pr.base_ref}\u0000${file.base_path}`;
      const entries = byPath.get(key) ?? [];
      entries.push({ pr, file });
      byPath.set(key, entries);
    }
  }

  const overlapsByPair = new Map<
    string,
    { a: PrRadarPr; b: PrRadarPr; files: InterferenceFileOverlap[] }
  >();
  for (const entries of byPath.values()) {
    for (let left = 0; left < entries.length; left += 1) {
      for (let right = left + 1; right < entries.length; right += 1) {
        const first = entries[left]!;
        const second = entries[right]!;
        if (first.pr.number === second.pr.number) continue;
        const [a, b] = first.pr.number < second.pr.number ? [first, second] : [second, first];
        const overlapping =
          a.file.line_ranges && b.file.line_ranges
            ? intersectIntervals(a.file.line_ranges, b.file.line_ranges)
            : [];
        const key = `${a.pr.number}\u0000${b.pr.number}`;
        const pair = overlapsByPair.get(key) ?? { a: a.pr, b: b.pr, files: [] };
        pair.files.push({
          base_path: a.file.base_path,
          severity: overlapping.length ? "lines" : "file",
          overlapping_lines: overlapping,
        });
        overlapsByPair.set(key, pair);
      }
    }
  }

  const pairs = [...overlapsByPair.values()].map(({ a, b, files }) => {
    files.sort(
      (left, right) =>
        intervalTotal(right.overlapping_lines) - intervalTotal(left.overlapping_lines) ||
        left.base_path.localeCompare(right.base_path),
    );
    return {
      pr_a: pairSide(a),
      pr_b: pairSide(b),
      severity: files.some((file) => file.severity === "lines")
        ? ("lines" as const)
        : ("file" as const),
      containment: containmentRelation(a, b),
      overlapping_line_total: files.reduce(
        (total, file) => total + intervalTotal(file.overlapping_lines),
        0,
      ),
      files,
    };
  });
  pairs.sort(
    (left, right) =>
      Number(right.severity === "lines") - Number(left.severity === "lines") ||
      right.overlapping_line_total - left.overlapping_line_total ||
      left.pr_a.number - right.pr_a.number ||
      left.pr_b.number - right.pr_b.number,
  );
  return { pairs: pairs.slice(0, maxPairs), pairs_truncated: pairs.length > maxPairs };
}

export function buildPrInterferenceReport(options: {
  targetRepo: string;
  prs: readonly PrRadarPr[];
  limits: PrInterferenceLimits;
  prsTruncated: boolean;
  updatedAt: string;
}): PrInterferenceReport {
  const { pairs, pairs_truncated } = detectInterference(options.prs, options.limits.max_pairs);
  const core = {
    schema_version: 1 as const,
    target_repo: options.targetRepo,
    prs_scanned: options.prs.length,
    limits: options.limits,
    truncated: { prs: options.prsTruncated, pairs: pairs_truncated },
    pairs,
  };
  return {
    ...core,
    digest: `sha256:${createHash("sha256").update(stableJson(core)).digest("hex")}`,
    updated_at: options.updatedAt,
  };
}

export function renderPrInterferenceMarkdown(report: PrInterferenceReport): string {
  const lines = [
    `# PR interference radar - ${report.target_repo}`,
    "",
    `${report.prs_scanned} open pull requests scanned, ${report.pairs.length} interfering ${pluralize("pair", report.pairs.length)}.`,
    "",
  ];
  if (report.pairs.length === 0) {
    lines.push("No interfering open pull request pairs found.", "");
  } else {
    lines.push(
      "| Pair | Severity | Containment | Files | Overlapping base lines |",
      "|---|---|---|---|---|",
      ...report.pairs.map(
        (pair) =>
          `| ${pairSideMarkdown(pair.pr_a)} and ${pairSideMarkdown(pair.pr_b)} | ${pair.severity} | ${containmentText(pair)} | ${pairFilesMarkdown(pair)} | ${pairLinesMarkdown(pair)} |`,
      ),
      "",
    );
  }
  lines.push(
    "Line numbers are base-branch coordinates as of each pull request's merge base. Pairs are pinned to the head SHAs recorded in report.json and go stale once either head moves.",
    "",
    `Scan limits: ${report.limits.max_prs} pull requests, ${report.limits.max_file_pages_per_pr} file pages per pull request, ${report.limits.max_pairs} pairs. ${truncationText(report)}`,
  );
  return lines.join("\n");
}

function pairSide(pr: PrRadarPr): InterferencePairSide {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author,
    draft: pr.draft,
    head_sha: pr.head_sha,
  };
}

function intersectIntervals(
  left: readonly (readonly number[])[],
  right: readonly (readonly number[])[],
): number[][] {
  const overlaps: number[][] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const [leftStart = 0, leftEnd = 0] = left[leftIndex]!;
    const [rightStart = 0, rightEnd = 0] = right[rightIndex]!;
    const start = Math.max(leftStart, rightStart);
    const end = Math.min(leftEnd, rightEnd);
    if (start <= end) overlaps.push([start, end]);
    if (leftEnd < rightEnd) leftIndex += 1;
    else rightIndex += 1;
  }
  return overlaps;
}

function intervalTotal(intervals: readonly (readonly number[])[]): number {
  return intervals.reduce((total, [start = 0, end = 0]) => total + (end - start + 1), 0);
}

function containmentRelation(a: PrRadarPr, b: PrRadarPr): InterferenceContainment {
  const aWithinB = prWithin(a, b);
  const bWithinA = prWithin(b, a);
  if (aWithinB && bWithinA) return "equal";
  if (aWithinB) return "a_within_b";
  if (bWithinA) return "b_within_a";
  return "none";
}

function prWithin(inner: PrRadarPr, outer: PrRadarPr): boolean {
  if (inner.files.length === 0 || inner.files_truncated || outer.files_truncated) return false;
  const outerByPath = new Map(outer.files.map((file) => [file.base_path, file]));
  return inner.files.every((file) => {
    const outerFile = outerByPath.get(file.base_path);
    if (!outerFile) return false;
    const innerRanges = file.line_ranges;
    const outerRanges = outerFile.line_ranges;
    if (!innerRanges?.length || !outerRanges?.length) return false;
    return innerRanges.every((range) =>
      outerRanges.some((outerRange) => outerRange[0]! <= range[0]! && range[1]! <= outerRange[1]!),
    );
  });
}

function pairSideMarkdown(side: InterferencePairSide): string {
  return `[#${side.number}](${side.url})${side.draft ? " (draft)" : ""}`;
}

function containmentText(pair: InterferencePair): string {
  if (pair.containment === "a_within_b") return `#${pair.pr_a.number} within #${pair.pr_b.number}`;
  if (pair.containment === "b_within_a") return `#${pair.pr_b.number} within #${pair.pr_a.number}`;
  if (pair.containment === "equal") return "equal surface";
  return "none";
}

function pairFilesMarkdown(pair: InterferencePair): string {
  const names = pair.files.slice(0, 3).map((file) => `\`${file.base_path}\``);
  const extra = pair.files.length - names.length;
  return extra > 0 ? `${names.join(", ")} and ${extra} more` : names.join(", ");
}

function pairLinesMarkdown(pair: InterferencePair): string {
  const ranges = pair.files
    .filter((file) => file.overlapping_lines.length)
    .slice(0, 3)
    .flatMap((file) => file.overlapping_lines.slice(0, 3))
    .map(([start, end]) => (start === end ? String(start) : `${start}-${end}`));
  return ranges.length ? ranges.join(", ") : "shared files only";
}

function truncationText(report: PrInterferenceReport): string {
  const truncated = [
    report.truncated.prs ? "the open pull request list" : "",
    report.truncated.pairs ? "the pair list" : "",
  ].filter(Boolean);
  if (truncated.length === 0) return "No truncation occurred.";
  return `Truncated: ${truncated.join(" and ")}; the scan is not complete.`;
}

function pluralize(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}
