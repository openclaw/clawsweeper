import type { Evidence, ItemKind } from "./clawsweeper-types.js";
import { normalizeRepo, type RepositoryProfile } from "./repository-profiles.js";
import { targetProfile, targetRepo } from "./repository-profiles.js";

export function isCommitSha(value: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(value.trim());
}

export function splitFileAndLine(
  file: string,
  explicitLine?: number | null,
): { file: string; line?: number } {
  const match = file.match(/^(.*?):(\d+)$/);
  if (match?.[1] && match[2]) return { file: match[1], line: Number(match[2]) };
  if (explicitLine) return { file, line: explicitLine };
  return { file };
}

export function normalizeEvidence(entry: Evidence, legacyReportRepo?: string): Evidence {
  let repo = entry.repo ? normalizeRepo(entry.repo) : null;
  let file: string | null = null;
  let sha: string | null = null;
  let line = entry.line;
  let conflict = false;
  let explicitDestination = false;
  const setRepo = (value: string) => {
    const normalized = normalizeRepo(value);
    if (repo && repo !== normalized) conflict = true;
    repo = normalized;
  };
  const setSha = (value: string) => {
    value = value.toLowerCase();
    if (!isCommitSha(value)) conflict = true;
    if (sha && !sha.startsWith(value) && !value.startsWith(sha)) conflict = true;
    if (!sha || value.length > sha.length) sha = value;
  };
  const setLine = (value: number | undefined) => {
    if (value === undefined) return;
    if (line !== null && line !== value) conflict = true;
    line = value;
  };
  for (const [kind, raw] of [
    ["blob", entry.file],
    ["commit", entry.sha],
  ] as const) {
    if (!raw) continue;
    const link = raw.match(/^\[([^\]]+)\]\(([^\s)]+)\)$/);
    const text = (link?.[1] ?? raw).replace(/^`(.*)`$/, "$1");
    const destination = link?.[2] ?? (text.startsWith("https://") ? text : null);
    const location = splitFileAndLine(text);
    if (kind === "blob") {
      file = location.file;
      setLine(location.line);
    } else if (!destination || link) setSha(text);
    if (!destination) continue;
    explicitDestination = true;
    const match = destination.match(
      /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(blob|commit)\/([0-9a-f]{7,40})(?:\/([^?#]+))?(?:#L([1-9][0-9]*))?$/i,
    );
    if (!match || match[2] !== kind || (kind === "blob" ? !match[4] : match[4] || match[5])) {
      if (kind === "commit" && !sha) sha = text;
      conflict = true;
      continue;
    }
    setRepo(match[1]!);
    setSha(match[3]!);
    if (kind === "blob") {
      try {
        const sourcePath = decodeURIComponent(match[4]!);
        if (link && location.file !== sourcePath) conflict = true;
        file = sourcePath;
      } catch {
        conflict = true;
      }
      setLine(match[5] ? Number(match[5]) : undefined);
    }
  }
  // Only pre-identity Markdown reports may imply the reviewed repository.
  if (!repo && !explicitDestination && legacyReportRepo) setRepo(legacyReportRepo);
  if (repo && !/^[a-z0-9][a-z0-9_.-]*\/(?!\.{1,2}$)[a-z0-9_.-]+$/.test(repo)) conflict = true;
  if (
    file &&
    (/[\\:\p{Cc}]/u.test(file) ||
      file.split("/").some((part) => !part || part === "." || part === ".."))
  )
    conflict = true;
  if (line !== null && (!Number.isSafeInteger(line) || line <= 0)) conflict = true;
  return { ...entry, repo: conflict ? null : repo, file, line, sha };
}

export function repoUrlFor(repo: string, path = ""): string {
  return `https://github.com/${normalizeRepo(repo)}${path}`;
}

export function commitUrl(sha: string, repo = targetRepo()): string {
  return repoUrlFor(repo, `/commit/${sha}`);
}

export function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

export function releaseUrl(tag: string, repo = targetRepo()): string {
  return repoUrlFor(repo, `/releases/tag/${encodeURIComponent(tag)}`);
}

export function itemUrlFor(repo: string, number: number, kind: ItemKind = "issue"): string {
  return repoUrlFor(repo, `/${kind === "pull_request" ? "pull" : "issues"}/${number}`);
}

export function githubPath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function fileUrl(file: string, sha: string, line?: number, repo = targetRepo()): string {
  return repoUrlFor(repo, `/blob/${sha}/${githubPath(file)}${line ? `#L${line}` : ""}`);
}

export function latestFileUrl(file: string, repo = targetRepo()): string {
  return fileUrl(file, "main", undefined, repo);
}

// Only files in the target repository have public docs pages.
export function docsPageUrl(
  file: string,
  repo = targetRepo(),
  profile: RepositoryProfile = targetProfile(),
): string | null {
  if (normalizeRepo(repo) !== normalizeRepo(profile.targetRepo)) return null;
  const docsUrl = profile.docsUrl;
  if (!docsUrl || !file.startsWith("docs/")) return null;
  const page = file
    .replace(/^docs\//, "")
    .replace(/\/index\.mdx?$/, "")
    .replace(/\.mdx?$/, "");
  return `${docsUrl}/${page}`;
}

export function markdownLink(label: string, url: string): string {
  return `[${label.replaceAll("|", "\\|")}](${url})`;
}

export function linkedSha(sha: string, repo = targetRepo()): string {
  return markdownLink(shortSha(sha), commitUrl(sha, repo));
}

export function linkedRelease(tag: string, repo = targetRepo()): string {
  return markdownLink(tag, releaseUrl(tag, repo));
}

export function repoUrl(path = ""): string {
  return repoUrlFor(targetRepo(), path);
}

export function reportUrl(path = ""): string {
  return `https://github.com/openclaw/clawsweeper${path}`;
}

export function reportFileUrl(
  number: number,
  path = `records/${targetProfile().slug}/items/${number}.md`,
): string {
  return reportUrl(`/blob/main/${githubPath(path)}`);
}
