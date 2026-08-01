import type { ItemKind } from "./clawsweeper-types.js";
import type { RepositoryProfile } from "./repository-profiles.js";

interface RepositoryLinkDependencies {
  reportRepo: string;
  normalizeRepo: (repo: string) => string;
  targetProfile: () => RepositoryProfile;
  targetRepo: () => string;
}

export function createRepositoryLinks({
  reportRepo,
  normalizeRepo,
  targetProfile,
  targetRepo,
}: RepositoryLinkDependencies) {
  function repoUrlFor(repo: string, path = ""): string {
    return `https://github.com/${normalizeRepo(repo)}${path}`;
  }

  function repoUrl(path = ""): string {
    return repoUrlFor(targetRepo(), path);
  }

  function reportUrl(path = ""): string {
    return `https://github.com/${reportRepo}${path}`;
  }

  function commitUrl(sha: string): string {
    return repoUrl(`/commit/${sha}`);
  }

  function shortSha(sha: string): string {
    return sha.slice(0, 12);
  }

  function isCommitSha(value: string): boolean {
    return /^[0-9a-f]{7,40}$/i.test(value.trim());
  }

  function releaseUrl(tag: string): string {
    return repoUrl(`/releases/tag/${encodeURIComponent(tag)}`);
  }

  function itemUrlFor(repo: string, number: number, kind: ItemKind = "issue"): string {
    return repoUrlFor(repo, `/${kind === "pull_request" ? "pull" : "issues"}/${number}`);
  }

  function reportFileUrl(
    number: number,
    path = `records/${targetProfile().slug}/items/${number}.md`,
  ): string {
    return reportUrl(`/blob/main/${githubPath(path)}`);
  }

  function githubPath(path: string): string {
    return path
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
  }

  function splitFileAndLine(
    file: string,
    explicitLine?: number | null,
  ): { file: string; line?: number } {
    const match = file.match(/^(.*?):(\d+)$/);
    if (match?.[1] && match[2]) return { file: match[1], line: Number(match[2]) };
    if (explicitLine) return { file, line: explicitLine };
    return { file };
  }

  function fileUrl(file: string, sha: string, line?: number): string {
    return repoUrl(`/blob/${sha}/${githubPath(file)}${line ? `#L${line}` : ""}`);
  }

  function latestFileUrl(file: string): string {
    return repoUrl(`/blob/main/${githubPath(file)}`);
  }

  function docsPageUrl(file: string): string | null {
    const docsUrl = targetProfile().docsUrl;
    if (!docsUrl || !file.startsWith("docs/")) return null;
    const page = file
      .replace(/^docs\//, "")
      .replace(/\/index\.mdx?$/, "")
      .replace(/\.mdx?$/, "");
    return `${docsUrl}/${page}`;
  }

  function markdownLink(label: string, url: string): string {
    return `[${label.replaceAll("|", "\\|")}](${url})`;
  }

  function linkedSha(sha: string): string {
    return markdownLink(shortSha(sha), commitUrl(sha));
  }

  function linkedRelease(tag: string): string {
    return markdownLink(tag, releaseUrl(tag));
  }

  return {
    commitUrl,
    docsPageUrl,
    fileUrl,
    githubPath,
    isCommitSha,
    itemUrlFor,
    latestFileUrl,
    linkedRelease,
    linkedSha,
    markdownLink,
    releaseUrl,
    repoUrl,
    repoUrlFor,
    reportFileUrl,
    reportUrl,
    shortSha,
    splitFileAndLine,
  };
}
