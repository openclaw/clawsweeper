export const DEFAULT_GITHUB_API_URL = "https://api.github.com";

type GithubApiEnv = Record<string, unknown>;

export function githubApiBaseUrl(env: GithubApiEnv = {}): string {
  const configured = env.GITHUB_API_URL;
  if (configured === undefined || configured === null || configured === "") {
    return DEFAULT_GITHUB_API_URL;
  }
  if (typeof configured !== "string") throw invalidGithubApiUrl();

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw invalidGithubApiUrl();
  }
  const isDefaultGithubOrigin = configured === DEFAULT_GITHUB_API_URL;
  const isLoopbackHttp =
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
    Boolean(url.port);
  if (
    (!isDefaultGithubOrigin && !isLoopbackHttp) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.origin !== configured
  ) {
    throw invalidGithubApiUrl();
  }
  return url.origin;
}

export function githubApiUrl(env: GithubApiEnv, path: string): string {
  const normalizedPath = String(path);
  if (!normalizedPath.startsWith("/")) throw new Error("GitHub API path must start with /");
  return `${githubApiBaseUrl(env)}${normalizedPath}`;
}

function invalidGithubApiUrl(): Error {
  return new Error(
    "invalid GITHUB_API_URL: expected https://api.github.com or an http://127.0.0.1:<port> / http://localhost:<port> origin",
  );
}
