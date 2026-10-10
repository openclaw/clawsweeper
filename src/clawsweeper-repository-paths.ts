import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringArg, type Args } from "./clawsweeper-args.js";
import {
  DEFAULT_TARGET_REPO,
  normalizeRepo,
  repositoryProfileFor,
  repositoryProfileForSlug,
} from "./repository-profiles.js";
import { frontMatterValue } from "./report-front-matter.js";
import { targetProfile, targetRepo } from "./repository-profiles.js";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RECORDS_ROOT = join(ROOT, "records");

export function repoRelativePath(path: string): string {
  return relative(ROOT, path).replaceAll("\\", "/");
}

export function reportFileName(repo: string, number: number): string {
  repositoryProfileFor(repo);
  return `${number}.md`;
}

export function parseReportFileName(
  file: string,
): { repo: string | undefined; number: number } | null {
  const numeric = file.match(/^(\d+)\.md$/);
  if (numeric?.[1]) return { repo: undefined, number: Number(numeric[1]) };
  const prefixed = file.match(/^([a-z0-9][a-z0-9-]*)-(\d+)\.md$/);
  if (!prefixed?.[1] || !prefixed[2]) return null;
  return { repo: repositoryProfileForSlug(prefixed[1])?.targetRepo, number: Number(prefixed[2]) };
}

export function markdownRepository(markdown: string, file?: string): string {
  const fromMarkdown = frontMatterValue(markdown, "repository");
  if (fromMarkdown) return normalizeRepo(fromMarkdown);
  if (file) {
    const normalizedPath = repoRelativePath(file);
    const recordsMatch = normalizedPath.match(/^records\/([^/]+)\//);
    if (recordsMatch?.[1]) {
      const profile = repositoryProfileForSlug(recordsMatch[1]);
      if (profile) return profile.targetRepo;
    }
    const parsed = parseReportFileName(basename(file));
    if (parsed?.repo) return parsed.repo;
  }
  return DEFAULT_TARGET_REPO;
}

export function markdownFiles(dir: string): string[] {
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => parseReportFileName(name) !== null)
        .sort((left, right) => {
          const leftParsed = parseReportFileName(left);
          const rightParsed = parseReportFileName(right);
          return (
            (leftParsed?.repo ?? DEFAULT_TARGET_REPO).localeCompare(
              rightParsed?.repo ?? DEFAULT_TARGET_REPO,
            ) || (leftParsed?.number ?? 0) - (rightParsed?.number ?? 0)
          );
        })
    : [];
}

export function numberForMarkdownFile(file: string): number {
  const parsed = parseReportFileName(file);
  if (!parsed) throw new Error(`Invalid report filename: ${file}`);
  return parsed.number;
}

function repoRecordsDir(profile = targetProfile()): string {
  return join(RECORDS_ROOT, profile.slug);
}

export function defaultItemsDir(profile = targetProfile()): string {
  return join(repoRecordsDir(profile), "items");
}

export function defaultClosedDir(profile = targetProfile()): string {
  return join(repoRecordsDir(profile), "closed");
}

export function defaultPlansDir(profile = targetProfile()): string {
  return join(repoRecordsDir(profile), "plans");
}

export function defaultFailedReviewRetryStateDir(profile = targetProfile()): string {
  return join(ROOT, "results", "failed-review-retries", profile.slug);
}

function defaultDecisionPacketsDir(profile = targetProfile()): string {
  return join(repoRecordsDir(profile), "decision-packets");
}

function siblingDecisionPacketsDir(
  recordDir: string,
  recordDirName: "items" | "closed",
): string | undefined {
  return basename(recordDir) === recordDirName
    ? join(dirname(recordDir), "decision-packets")
    : undefined;
}

function defaultDecisionPacketsDirForRecordDirs(
  itemsDir: string,
  closedDir: string,
  profile = targetProfile(),
): string {
  const itemsPacketsDir = siblingDecisionPacketsDir(itemsDir, "items");
  const closedPacketsDir = siblingDecisionPacketsDir(closedDir, "closed");
  if (itemsPacketsDir && (!closedPacketsDir || itemsPacketsDir === closedPacketsDir)) {
    return itemsPacketsDir;
  }
  if (closedPacketsDir && !itemsPacketsDir) return closedPacketsDir;
  return defaultDecisionPacketsDir(profile);
}

export function decisionPacketsDirFromArgs(
  args: Args,
  itemsDir: string,
  closedDir: string,
): string {
  const explicitDecisionPacketsDir = stringArg(args.decision_packets_dir, "");
  if (explicitDecisionPacketsDir) return resolve(explicitDecisionPacketsDir);
  if (typeof args.items_dir === "string") {
    const itemsPacketsDir = siblingDecisionPacketsDir(itemsDir, "items");
    if (itemsPacketsDir) return resolve(itemsPacketsDir);
  }
  if (typeof args.closed_dir === "string") {
    const closedPacketsDir = siblingDecisionPacketsDir(closedDir, "closed");
    if (closedPacketsDir) return resolve(closedPacketsDir);
  }
  return resolve(defaultDecisionPacketsDirForRecordDirs(itemsDir, closedDir));
}

export function isMarkdownForActiveRepo(markdown: string, file?: string): boolean {
  return markdownRepository(markdown, file) === targetRepo();
}
