export function githubItemIdentity(value: { number?: unknown; html_url?: unknown }) {
  if (!Number.isSafeInteger(value.number) || Number(value.number) < 1) return null;
  if (typeof value.html_url !== "string") return null;
  let url: URL;
  try {
    url = new URL(value.html_url);
  } catch {
    return null;
  }
  const match = /^\/([^/]+)\/([^/]+)\/(?:issues|pull)\/([1-9]\d*)$/.exec(url.pathname);
  if (!match || Number(match[3]) !== value.number) return null;
  return { repository: `${match[1]}/${match[2]}`.toLowerCase(), number: Number(value.number) };
}

export class GitHubItemMovedError extends Error {
  constructor(repository: string, number: number, actual: { repository: string; number: number }) {
    super(`GitHub moved ${repository}#${number} to ${actual.repository}#${actual.number}.`);
    this.name = "GitHubItemMovedError";
  }
}

export function assertGitHubItemIdentity(
  value: { number?: unknown; html_url?: unknown },
  repository: string,
  number: number,
): void {
  const actual = githubItemIdentity(value);
  if (!actual)
    throw new Error(`GitHub returned an invalid item identity for ${repository}#${number}.`);
  // GitHub follows transferred-issue redirects. Never combine its new number
  // with the requested repository for context reads, cache writes, or mutations.
  if (actual.repository !== repository.toLowerCase() || actual.number !== number) {
    throw new GitHubItemMovedError(repository, number, actual);
  }
}
