import { basename, dirname, join, resolve } from "node:path";
import { stringArg, type Args } from "./clawsweeper-args.js";
import {
  DEFAULT_TARGET_REPO,
  normalizeRepo,
  repositoryProfileFor,
  repositoryProfileForSlug,
  type RepositoryProfile,
} from "./repository-profiles.js";

interface CreateRepositoryPathsDependencies {
  frontMatterValue: (markdown: string, key: string) => string | undefined;
  RECORDS_ROOT: string;
  repoRelativePath: (path: string) => string;
  ROOT: string;
  targetProfile: () => RepositoryProfile;
  targetRepo: () => string;
}

export function createRepositoryPaths(dependencies: CreateRepositoryPathsDependencies) {
  const { frontMatterValue, RECORDS_ROOT, repoRelativePath, ROOT, targetProfile, targetRepo } =
    dependencies;

  function repoRecordsDir(profile = targetProfile()): string {
    return join(RECORDS_ROOT, profile.slug);
  }

  function defaultItemsDir(profile = targetProfile()): string {
    return join(repoRecordsDir(profile), "items");
  }

  function defaultClosedDir(profile = targetProfile()): string {
    return join(repoRecordsDir(profile), "closed");
  }

  function defaultPlansDir(profile = targetProfile()): string {
    return join(repoRecordsDir(profile), "plans");
  }

  function defaultFailedReviewRetryStateDir(profile = targetProfile()): string {
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

  function decisionPacketsDirFromArgs(args: Args, itemsDir: string, closedDir: string): string {
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

  function reportFileName(repo: string, number: number): string {
    repositoryProfileFor(repo);
    return `${number}.md`;
  }

  function parseReportFileName(file: string): { repo: string | undefined; number: number } | null {
    const numeric = file.match(/^(\d+)\.md$/);
    if (numeric?.[1]) return { repo: undefined, number: Number(numeric[1]) };
    const prefixed = file.match(/^([a-z0-9][a-z0-9-]*)-(\d+)\.md$/);
    if (!prefixed?.[1] || !prefixed[2]) return null;
    return { repo: repositoryProfileForSlug(prefixed[1])?.targetRepo, number: Number(prefixed[2]) };
  }

  function markdownRepository(markdown: string, file?: string): string {
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

  function isMarkdownForActiveRepo(markdown: string, file?: string): boolean {
    return markdownRepository(markdown, file) === targetRepo();
  }

  return {
    decisionPacketsDirFromArgs,
    defaultClosedDir,
    defaultFailedReviewRetryStateDir,
    defaultItemsDir,
    defaultPlansDir,
    isMarkdownForActiveRepo,
    markdownRepository,
    parseReportFileName,
    reportFileName,
  };
}
