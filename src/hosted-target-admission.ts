const GITHUB_RATE_LIMIT_FALLBACK_MS = 15 * 60 * 1000;
const GITHUB_RATE_LIMIT_MAX_RETRY_MS = 2 * 60 * 60 * 1000;
const HOSTED_TARGET_RETRY_MAX_MS = 2 * 60 * 60 * 1000;
const HOSTED_TARGET_REGISTRY_TIMEOUT_MS = 5_000;
const HOSTED_TARGET_FALLBACK_OWNERS = new Set(["openclaw", "steipete"]);
const DEFAULT_HOSTED_TARGET_REGISTRY_URL =
  "https://raw.githubusercontent.com/openclaw/clawsweeper/main/config/target-repositories.json";
export const HOSTED_TARGET_ELIGIBILITY_HEADER = "x-clawsweeper-hosted-target-eligible";

export type GitHubRateLimitHint = {
  observedAt: number;
  retryAt: number;
  provenance: "retry_after" | "rate_limit_reset" | "rate_limit_status" | "fallback";
  authoritative: boolean;
};

export type HostedPublicTargetProbe = "public" | "terminal" | "retryable";
export type HostedTargetAdmission = {
  outcome: HostedPublicTargetProbe;
  retryAt?: number;
};
export type HostedTargetEligibility = {
  outcome: "eligible" | "terminal" | "retryable";
  retryAt?: number;
};
export type HostedTargetPolicy = {
  configuredRepositories: readonly string[];
  genericFallbacks: readonly HostedTargetFallbackPolicy[];
};
type HostedTargetFallbackPolicy = {
  owner: string;
  denyRepositories: readonly string[];
  allowRepoNamePattern: RegExp;
};

export function isHostedTargetEligible(targetRepo: string, policy: HostedTargetPolicy): boolean {
  const normalized = normalizeTargetRepo(targetRepo);
  if (!normalized) return false;
  for (const configured of policy.configuredRepositories) {
    if (normalizeTargetRepo(configured) === normalized) return true;
  }
  const [owner, repoName] = normalized.split("/");
  if (!owner || !repoName || !HOSTED_TARGET_FALLBACK_OWNERS.has(owner)) return false;
  const fallback = policy.genericFallbacks.find((candidate) => candidate.owner === owner);
  return Boolean(
    fallback &&
    !fallback.denyRepositories.includes(normalized) &&
    fallback.allowRepoNamePattern.test(repoName),
  );
}

export async function resolveHostedTargetEligibility(
  targetRepo: string,
  reader: typeof fetch = fetch,
  options: {
    configuredRepositories?: Iterable<string>;
    predicate?: (targetRepo: string) => boolean | Promise<boolean>;
    registryUrl?: string;
  } = {},
): Promise<HostedTargetEligibility> {
  const normalized = normalizeTargetRepo(targetRepo);
  if (!normalized) return { outcome: "terminal" };
  if (options.predicate) {
    try {
      return (await options.predicate(normalized))
        ? { outcome: "eligible" }
        : { outcome: "terminal" };
    } catch (error) {
      return hostedTargetRetryableEligibility(error);
    }
  }
  if (options.configuredRepositories !== undefined) {
    return isHostedTargetEligible(normalized, {
      configuredRepositories: [...options.configuredRepositories],
      genericFallbacks: [],
    })
      ? { outcome: "eligible" }
      : { outcome: "terminal" };
  }
  try {
    const response = await reader(options.registryUrl ?? DEFAULT_HOSTED_TARGET_REGISTRY_URL, {
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-store",
        "User-Agent": "openclaw-clawsweeper-hosted-target-registry",
      },
      cache: "no-store",
      redirect: "manual",
      // The Worker and queue both defend their persistence boundaries. Keep a
      // direct queue lookup within upstream request deadlines when no prepared
      // Worker eligibility fact is available.
      signal: AbortSignal.timeout(HOSTED_TARGET_REGISTRY_TIMEOUT_MS),
    });
    if (response.status !== 200) return hostedTargetRetryableEligibility(response);
    const text = await response.text().catch(() => "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { outcome: "retryable" };
    }
    const policy = hostedTargetPolicyFromRegistry(parsed);
    if (!policy) return { outcome: "retryable" };
    return isHostedTargetEligible(normalized, policy)
      ? { outcome: "eligible" }
      : { outcome: "terminal" };
  } catch (error) {
    return hostedTargetRetryableEligibility(error);
  }
}

export function hostedTargetPolicyFromRegistry(value: unknown): HostedTargetPolicy | null {
  const config = objectValue(value);
  if (config.schema_version !== 1 && config.schema_version !== 2) return null;
  if (!Array.isArray(config.repositories)) return null;
  const repositories: string[] = [];
  for (const value of config.repositories) {
    const targetRepo = normalizeTargetRepo(stringValue(objectValue(value).target_repo));
    if (!targetRepo) return null;
    repositories.push(targetRepo);
  }
  const fallbackValues = Array.isArray(config.generic_fallbacks)
    ? config.generic_fallbacks
    : config.openclaw_fallback === undefined
      ? []
      : [config.openclaw_fallback];
  const genericFallbacks: HostedTargetFallbackPolicy[] = [];
  for (const value of fallbackValues) {
    const fallback = objectValue(value);
    const owner = stringValue(fallback.owner).trim().toLowerCase();
    const pattern = stringValue(fallback.allow_repo_name_pattern);
    if (!owner || !Array.isArray(fallback.deny_repositories) || !pattern) return null;
    const denyRepositories: string[] = [];
    for (const denied of fallback.deny_repositories) {
      const targetRepo = normalizeTargetRepo(stringValue(denied));
      if (!targetRepo) return null;
      denyRepositories.push(targetRepo);
    }
    let allowRepoNamePattern: RegExp;
    try {
      allowRepoNamePattern = new RegExp(pattern);
    } catch {
      return null;
    }
    genericFallbacks.push({
      owner,
      denyRepositories: [...new Set(denyRepositories)],
      allowRepoNamePattern,
    });
  }
  return {
    configuredRepositories: [...new Set(repositories)],
    genericFallbacks,
  };
}

export async function probeHostedPublicTarget(
  targetRepo: string,
  token: string,
  reader: typeof fetch = fetch,
  options: {
    apiUrl?: (path: string) => string;
  } = {},
): Promise<HostedTargetAdmission> {
  const normalized = targetRepo.trim().toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(normalized)) {
    return { outcome: "terminal" };
  }
  if (!token) return { outcome: "retryable" };
  try {
    const response = await reader((options.apiUrl ?? defaultGitHubApiUrl)(`/repos/${normalized}`), {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Cache-Control": "no-store",
        "User-Agent": "openclaw-clawsweeper-public-target-probe",
      },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 404) return { outcome: "terminal" };
    if (response.status !== 200) return hostedTargetRetryableAdmission(response);
    const text = await response.text().catch(() => "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return hostedTargetRetryableAdmission(response);
    }
    const repository = objectValue(parsed);
    const observedName = stringValue(repository.full_name).trim().toLowerCase();
    const visibility = stringValue(repository.visibility).trim().toLowerCase();
    if (
      !observedName ||
      typeof repository.private !== "boolean" ||
      !["public", "private", "internal"].includes(visibility)
    ) {
      return hostedTargetRetryableAdmission(response);
    }
    return observedName === normalized && !repository.private && visibility === "public"
      ? { outcome: "public" }
      : { outcome: "terminal" };
  } catch (error) {
    return hostedTargetRetryableAdmission(error);
  }
}

export function normalizeHostedTargetAdmission(value: unknown): HostedTargetAdmission {
  if (value === "public" || value === "terminal" || value === "retryable") {
    return { outcome: value };
  }
  const record = objectValue(value);
  const outcome = record.outcome;
  if (outcome !== "public" && outcome !== "terminal" && outcome !== "retryable") {
    return { outcome: "retryable" };
  }
  const retryAt = Number(record.retryAt);
  return outcome === "retryable" && Number.isFinite(retryAt) && retryAt > Date.now()
    ? {
        outcome,
        retryAt: Math.min(retryAt, Date.now() + HOSTED_TARGET_RETRY_MAX_MS),
      }
    : { outcome };
}

export function hostedTargetRetryableAdmission(source: unknown): HostedTargetAdmission {
  const observedAt = Date.now();
  const retryAt = sourceRateLimitRetryAt(source, observedAt);
  if (retryAt) return { outcome: "retryable", retryAt };
  if (source instanceof Response) {
    const hasRetryHint =
      source.status === 403 ||
      source.status === 429 ||
      source.headers.has("retry-after") ||
      source.headers.has("x-ratelimit-reset");
    if (hasRetryHint) {
      return {
        outcome: "retryable",
        retryAt: githubResponseRateLimitHint(source, observedAt).retryAt,
      };
    }
  }
  return { outcome: "retryable" };
}

export function hostedTargetRetryAfterSeconds(retryAt: number | undefined): number | null {
  if (!retryAt || !Number.isFinite(retryAt)) return null;
  return Math.max(1, Math.ceil((retryAt - Date.now()) / 1_000));
}

export function githubResponseRateLimited(response: Response, text: string) {
  return (
    response.status === 429 ||
    response.headers.has("retry-after") ||
    response.headers.get("x-ratelimit-remaining") === "0" ||
    /(?:secondary )?rate limit|api rate limit|abuse detection/i.test(text)
  );
}

export function githubResponseRateLimitHint(
  response: Response,
  observedAt: number,
): GitHubRateLimitHint {
  const maxRetryAt = observedAt + GITHUB_RATE_LIMIT_MAX_RETRY_MS;
  const retryAfter = String(response.headers.get("retry-after") || "").trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const parsed = Number.isFinite(seconds)
      ? observedAt + Math.max(0, seconds) * 1_000
      : Date.parse(retryAfter);
    if (Number.isFinite(parsed)) {
      return {
        observedAt,
        retryAt: Math.max(observedAt + 1_000, Math.min(maxRetryAt, parsed)),
        provenance: "retry_after",
        authoritative: true,
      };
    }
  }
  const resetSeconds = Number(response.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(resetSeconds) && resetSeconds > 0) {
    return {
      observedAt,
      retryAt: Math.max(observedAt + 1_000, Math.min(maxRetryAt, resetSeconds * 1_000)),
      provenance: "rate_limit_reset",
      authoritative: true,
    };
  }
  return {
    observedAt,
    retryAt: observedAt + GITHUB_RATE_LIMIT_FALLBACK_MS,
    provenance: "fallback",
    authoritative: false,
  };
}

function sourceRateLimitRetryAt(source: unknown, observedAt: number): number | null {
  const hint = objectValue(objectValue(source).rateLimitHint);
  const retryAt = Number(hint.retryAt);
  return Number.isFinite(retryAt) && retryAt > observedAt
    ? Math.min(retryAt, observedAt + HOSTED_TARGET_RETRY_MAX_MS)
    : null;
}

function defaultGitHubApiUrl(path: string) {
  return `https://api.github.com${path}`;
}

function hostedTargetRetryableEligibility(source: unknown): HostedTargetEligibility {
  const retryable = hostedTargetRetryableAdmission(source);
  return {
    outcome: "retryable",
    ...(retryable.retryAt ? { retryAt: retryable.retryAt } : {}),
  };
}

function normalizeTargetRepo(targetRepo: string): string | null {
  const normalized = targetRepo.trim().toLowerCase();
  return /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(normalized) ? normalized : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
