import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { repositoryProfileFor, repositoryProfileForSlug } from "../repository-profiles.js";
import type {
  PatternCollectorOptions,
  PolicyPatternObservation,
  PolicyPatternType,
} from "./types.js";

interface RecordCandidate {
  absolutePath: string;
  relativePath: string;
  repoSlug: string;
}

export function collectPolicyPatterns(
  options: PatternCollectorOptions,
): PolicyPatternObservation[] {
  const repoSlugs = targetRepoSlugs(options.targetRepo);
  const candidates = recordCandidates(options.recordsRoot, repoSlugs);
  const observations: PolicyPatternObservation[] = [];

  for (const candidate of candidates) {
    const text = safeRead(candidate.absolutePath);
    if (!text) continue;
    observations.push(...observationsFromRecord(candidate, text));
  }

  return observations.sort(compareObservation);
}

function targetRepoSlugs(targetRepo: string | undefined): Set<string> | undefined {
  if (!targetRepo) return undefined;
  return new Set([repositoryProfileFor(targetRepo).slug]);
}

function recordCandidates(
  recordsRoot: string,
  repoSlugs: Set<string> | undefined,
): RecordCandidate[] {
  if (!existsSync(recordsRoot)) return [];
  const candidates: RecordCandidate[] = [];
  for (const repoSlug of safeReadDir(recordsRoot).sort()) {
    if (repoSlugs && !repoSlugs.has(repoSlug)) continue;
    const repoRoot = join(recordsRoot, repoSlug);
    if (!safeIsDirectory(repoRoot)) continue;
    for (const absolutePath of walkFiles(repoRoot)) {
      if (!absolutePath.endsWith(".md") && !absolutePath.endsWith(".json")) continue;
      candidates.push({
        absolutePath,
        relativePath: normalizePath(relative(recordsRoot, absolutePath)),
        repoSlug,
      });
    }
  }
  return candidates.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  for (const name of safeReadDir(root).sort()) {
    const fullPath = join(root, name);
    if (safeIsDirectory(fullPath)) files.push(...walkFiles(fullPath));
    else files.push(fullPath);
  }
  return files;
}

function observationsFromRecord(
  candidate: RecordCandidate,
  text: string,
): PolicyPatternObservation[] {
  const repo = repoForSlug(candidate.repoSlug);
  const item = itemFromPath(candidate.relativePath);
  const observedAt = firstDate([
    frontMatterValue(text, "reviewed_at"),
    frontMatterValue(text, "updated_at"),
    frontMatterValue(text, "created_at"),
    jsonStringValue(text, "reviewedAt"),
    jsonStringValue(text, "updatedAt"),
    jsonStringValue(text, "createdAt"),
  ]);
  const successfulOutcome = hasSuccessfulOutcome(text);
  const observations: PolicyPatternObservation[] = [];

  for (const label of frontMatterStringArray(text, "labels")) {
    observations.push(
      observation(candidate, repo, item, observedAt, successfulOutcome, "label", label),
    );
  }
  for (const verdict of uniqueMatches(text, /clawsweeper-verdict:([a-z0-9_-]+)/gi)) {
    observations.push(
      observation(candidate, repo, item, observedAt, successfulOutcome, "review_verdict", verdict),
    );
  }
  for (const reason of [
    frontMatterValue(text, "close_reason"),
    frontMatterValue(text, "closeReason"),
    labeledLineValue(text, "close reason"),
    labeledLineValue(text, "safe close reason"),
  ]) {
    if (reason) {
      observations.push(
        observation(
          candidate,
          repo,
          item,
          observedAt,
          successfulOutcome,
          "safe_close_reason",
          reason,
        ),
      );
    }
  }
  for (const marker of [
    ...uniqueMatches(text, /clawsweeper-repair:([a-z0-9_-]+)/gi),
    ...jsonStringValues(text, "repair_marker"),
    ...jsonStringValues(text, "repairMarker"),
  ]) {
    observations.push(
      observation(candidate, repo, item, observedAt, successfulOutcome, "repair_marker", marker),
    );
  }
  for (const cause of [
    ...jsonStringValues(text, "automerge_repair_cause"),
    ...jsonStringValues(text, "automergeRepairCause"),
    labeledLineValue(text, "automerge repair cause"),
  ]) {
    if (cause) {
      observations.push(
        observation(
          candidate,
          repo,
          item,
          observedAt,
          successfulOutcome,
          "automerge_repair_cause",
          cause,
        ),
      );
    }
  }
  for (const conflictType of [
    ...jsonStringValues(text, "conflict_type"),
    ...jsonStringValues(text, "conflictType"),
    labeledLineValue(text, "conflict type"),
    labeledLineValue(text, "file conflict type"),
  ]) {
    if (conflictType) {
      observations.push(
        observation(
          candidate,
          repo,
          item,
          observedAt,
          successfulOutcome,
          "file_conflict_type",
          conflictType,
        ),
      );
    }
  }

  return dedupeObservations(observations);
}

function observation(
  candidate: RecordCandidate,
  repo: string,
  item: string,
  observedAt: string | undefined,
  successfulOutcome: boolean,
  patternType: PolicyPatternType,
  rawValue: string,
): PolicyPatternObservation {
  const value = normalizeValue(rawValue);
  return {
    patternType,
    value,
    repo,
    item,
    sourceRecord: `records/${candidate.relativePath}`,
    observedAt,
    successfulOutcome,
  };
}

function dedupeObservations(observations: PolicyPatternObservation[]): PolicyPatternObservation[] {
  const seen = new Set<string>();
  return observations.filter((candidate) => {
    if (!candidate.value) return false;
    const key = `${candidate.patternType}\0${candidate.value}\0${candidate.sourceRecord}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function repoForSlug(slug: string): string {
  return repositoryProfileForSlug(slug)?.targetRepo ?? slug.replace("-", "/");
}

function itemFromPath(relativePath: string): string {
  const match = relativePath.match(/\/items\/([^/.]+)\./);
  return match?.[1] ? `#${match[1]}` : relativePath;
}

function safeRead(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function safeReadDir(dirPath: string): string[] {
  try {
    return readdirSync(dirPath);
  } catch {
    return [];
  }
}

function safeIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function normalizePath(path: string): string {
  return path.split(sep).join("/");
}

function frontMatterStringArray(markdown: string, key: string): string[] {
  const raw = frontMatterValue(markdown, key);
  if (!raw) return [];
  if (raw.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed))
        return parsed.filter((value): value is string => typeof value === "string");
    } catch {
      return [];
    }
  }
  return raw
    .split(",")
    .map((value) => normalizeValue(value))
    .filter(Boolean);
}

function frontMatterValue(markdown: string, key: string): string | undefined {
  const frontMatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontMatter?.[1]) return undefined;
  const lines = frontMatter[1].split(/\r?\n/);
  const direct = lines.find((line) => line.toLowerCase().startsWith(`${key.toLowerCase()}:`));
  if (!direct) return undefined;
  return stripQuotes(direct.slice(direct.indexOf(":") + 1).trim());
}

function labeledLineValue(text: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(
    new RegExp(`(?:^|\\n)\\s*(?:[-*]\\s*)?(?:\\*\\*)?${escaped}(?:\\*\\*)?\\s*:\\s*([^\\n]+)`, "i"),
  );
  return match?.[1] ? normalizeValue(match[1]) : undefined;
}

function jsonStringValue(text: string, key: string): string | undefined {
  return jsonStringValues(text, key)[0];
}

function jsonStringValues(text: string, key: string): string[] {
  const values: string[] = [];
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`"${escaped}"\\s*:\\s*"([^"]+)"`, "gi");
  for (const match of text.matchAll(pattern)) {
    if (match[1]) values.push(normalizeValue(match[1]));
  }
  return values;
}

function uniqueMatches(text: string, pattern: RegExp): string[] {
  return [
    ...new Set([...text.matchAll(pattern)].map((match) => normalizeValue(match[1] ?? ""))),
  ].filter(Boolean);
}

function firstDate(values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (!value) continue;
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString();
  }
  return undefined;
}

function hasSuccessfulOutcome(text: string): boolean {
  return /\b(applied|merged|closed|success|succeeded|pass)\b/i.test(text);
}

function normalizeValue(value: string): string {
  return stripQuotes(value)
    .replace(/<!--.*?-->/g, "")
    .replaceAll("`", "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .slice(0, 120);
}

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

function compareObservation(
  left: PolicyPatternObservation,
  right: PolicyPatternObservation,
): number {
  return (
    left.patternType.localeCompare(right.patternType) ||
    left.value.localeCompare(right.value) ||
    left.sourceRecord.localeCompare(right.sourceRecord)
  );
}
