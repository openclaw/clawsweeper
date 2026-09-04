export const GITHUB_ETAG_CACHE_KEY_VERSION = 1 as const;
export const GITHUB_ETAG_CACHE_MAX_BODY_BYTES = 128 * 1_024;
export const GITHUB_ETAG_DEFAULT_MEDIA_TYPE = "application/vnd.github+json";

export const GITHUB_ETAG_CREDENTIAL_POOLS = [
  "repository_actions",
  "target_app",
  "public_read_fallback",
] as const;

export type GithubEtagCredentialPool = (typeof GITHUB_ETAG_CREDENTIAL_POOLS)[number];

export type GithubEtagCacheKey = {
  version: typeof GITHUB_ETAG_CACHE_KEY_VERSION;
  credentialPool: GithubEtagCredentialPool;
  route: string;
  mediaType: string;
  page: number;
  cacheKey: string;
};

const APPLY_ROUTE_TEMPLATES = new Set([
  "issue_metadata",
  "pull_metadata",
  "issue_comments",
  "pull_comments",
  "pull_reviews",
]);
const DASHBOARD_ROUTE_TEMPLATES = new Set(["actions_runs", "actions_run_jobs"]);
const COLLECTION_ROUTE_TEMPLATES = new Set([
  "issue_comments",
  "pull_comments",
  "pull_reviews",
  "actions_runs",
  "actions_run_jobs",
]);

export function githubEtagCacheKey(options: {
  credentialPool: GithubEtagCredentialPool;
  route: string;
  mediaType?: string | undefined;
  surface: "apply" | "dashboard";
}): GithubEtagCacheKey | null {
  if (!GITHUB_ETAG_CREDENTIAL_POOLS.includes(options.credentialPool)) return null;
  const mediaType = normalizeMediaType(options.mediaType);
  if (!mediaType) return null;
  let url: URL;
  try {
    url = new URL(options.route, "https://api.github.invalid");
  } catch {
    return null;
  }
  if (url.origin !== "https://api.github.invalid") return null;
  const pathname = url.pathname.replace(/^\/api\/v3/i, "");
  const routeTemplate = etagRouteTemplate(pathname);
  const allowed = options.surface === "apply" ? APPLY_ROUTE_TEMPLATES : DASHBOARD_ROUTE_TEMPLATES;
  if (!allowed.has(routeTemplate)) return null;
  if (COLLECTION_ROUTE_TEMPLATES.has(routeTemplate)) {
    if (!url.searchParams.has("per_page")) url.searchParams.set("per_page", "30");
    if (!url.searchParams.has("page")) url.searchParams.set("page", "1");
  }
  const pageText = url.searchParams.get("page") ?? "1";
  if (!/^\d+$/.test(pageText)) return null;
  const page = Number(pageText);
  if (!Number.isSafeInteger(page) || page < 1) return null;
  url.searchParams.sort();
  const query = url.searchParams.toString();
  const route = `${pathname.startsWith("/") ? pathname : `/${pathname}`}${query ? `?${query}` : ""}`;
  if (route.length > 2_048) return null;
  const cacheKey = JSON.stringify([
    GITHUB_ETAG_CACHE_KEY_VERSION,
    options.credentialPool,
    route,
    mediaType,
  ]);
  return {
    version: GITHUB_ETAG_CACHE_KEY_VERSION,
    credentialPool: options.credentialPool,
    route,
    mediaType,
    page,
    cacheKey,
  };
}

function etagRouteTemplate(path: string): string {
  if (/^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/?$/.test(path)) return "issue_metadata";
  if (/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/?$/.test(path)) return "pull_metadata";
  if (/^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments\/?$/.test(path)) {
    return "issue_comments";
  }
  if (/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/comments\/?$/.test(path)) {
    return "pull_comments";
  }
  if (/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/reviews\/?$/.test(path)) {
    return "pull_reviews";
  }
  if (/^\/repos\/[^/]+\/[^/]+\/actions\/runs\/?$/.test(path)) return "actions_runs";
  if (/^\/repos\/[^/]+\/[^/]+\/actions\/runs\/\d+\/jobs\/?$/.test(path)) {
    return "actions_run_jobs";
  }
  return "unknown";
}

export function githubEtagCacheKeyFromValue(value: unknown): GithubEtagCacheKey | null {
  const body = objectValue(value);
  const credentialPool = stringValue(body.credential_pool) as GithubEtagCredentialPool;
  const surface = body.surface === "dashboard" ? "dashboard" : "apply";
  const key = githubEtagCacheKey({
    credentialPool,
    route: stringValue(body.route),
    mediaType: stringValue(body.media_type),
    surface,
  });
  if (!key || (body.cache_key !== undefined && body.cache_key !== key.cacheKey)) return null;
  return key;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function githubEtagCacheRequestBody(
  key: GithubEtagCacheKey,
  surface: "apply" | "dashboard",
): Record<string, unknown> {
  return {
    version: key.version,
    credential_pool: key.credentialPool,
    route: key.route,
    media_type: key.mediaType,
    page: key.page,
    cache_key: key.cacheKey,
    surface,
  };
}

function normalizeMediaType(value: string | undefined): string | null {
  const mediaType = String(value || GITHUB_ETAG_DEFAULT_MEDIA_TYPE)
    .trim()
    .toLowerCase();
  if (!mediaType || mediaType.length > 200 || /[\r\n]/.test(mediaType)) return null;
  return mediaType;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
