import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type RepositoryItemKind = "issue" | "pull_request";
export type RepositoryCloseReason =
  | "implemented_on_main"
  | "mostly_implemented_on_main"
  | "cannot_reproduce"
  | "clawhub"
  | "duplicate_or_superseded"
  | "low_signal_unmergeable_pr"
  | "stalled_unproven_pr"
  | "abandoned_pr"
  | "unconfirmed_product_direction"
  | "unsponsored_feature_request"
  | "author_pr_budget_exceeded"
  | "stale_version_bug"
  | "obsolete_fix_pr"
  | "not_actionable_in_repo"
  | "incoherent"
  | "stale_insufficient_info"
  | "none";

export interface RepositoryProfile {
  targetRepo: string;
  slug: string;
  displayName: string;
  checkoutDir: string;
  docsUrl?: string;
  communityUrl?: string;
  promptNote: string;
  applyCloseRules: Partial<Record<RepositoryItemKind, readonly RepositoryCloseReason[]>>;
}

interface TargetRepositoryConfig {
  schemaVersion: 1 | 2;
  repositories: readonly ConfiguredRepositoryProfile[];
  genericFallbacks: readonly GenericFallbackConfig[];
}

interface ConfiguredRepositoryProfile {
  targetRepo: string;
  displayName: string;
  checkoutDir: string;
  docsUrl?: string;
  communityUrl?: string;
  promptNote: string;
  applyCloseRules: Partial<Record<RepositoryItemKind, readonly RepositoryCloseReason[]>>;
}

interface GenericFallbackConfig {
  owner: string;
  denyRepositories: readonly string[];
  allowRepoNamePattern: RegExp;
  promptNote: string;
  applyCloseRules: Partial<Record<RepositoryItemKind, readonly RepositoryCloseReason[]>>;
}

const OPENCLAW_CLOSE_REASONS: readonly RepositoryCloseReason[] = [
  "implemented_on_main",
  "mostly_implemented_on_main",
  "cannot_reproduce",
  "clawhub",
  "duplicate_or_superseded",
  "low_signal_unmergeable_pr",
  "stalled_unproven_pr",
  "abandoned_pr",
  "unconfirmed_product_direction",
  "unsponsored_feature_request",
  "author_pr_budget_exceeded",
  "stale_version_bug",
  "obsolete_fix_pr",
  "not_actionable_in_repo",
  "incoherent",
  "stale_insufficient_info",
];

const ALL_CLOSE_REASONS: readonly RepositoryCloseReason[] = [...OPENCLAW_CLOSE_REASONS, "none"];
const CLOSE_REASON_SET = new Set<RepositoryCloseReason>(ALL_CLOSE_REASONS);
const ITEM_KIND_SET = new Set<RepositoryItemKind>(["issue", "pull_request"]);

export const DEFAULT_TARGET_REPO = "openclaw/openclaw";

const CORE_OPENCLAW_PROFILE: RepositoryProfile = {
  targetRepo: DEFAULT_TARGET_REPO,
  slug: "openclaw-openclaw",
  displayName: "OpenClaw",
  checkoutDir: "openclaw",
  docsUrl: "https://docs.openclaw.ai",
  communityUrl: "https://clawhub.ai/",
  promptNote:
    "Use the OpenClaw source tree, docs, changelog, and current main branch. Close proposals may use the normal OpenClaw stale/duplicate/not-in-repo/implemented-on-main policy when evidence is strong. For OpenClaw PR reviews, ClawSweeper renders deterministic PR surface stats separately; do not repeat changed-file counts, additions/deletions, or area totals in Review metrics unless adding a new interpretation not present in the deterministic surface block. Use Review metrics for new review-relevant facts, especially user-facing configuration additions, new flags/options/env vars, new protocol/API params, default changes, migrations, persisted settings, or compatibility paths.",
  applyCloseRules: {
    issue: OPENCLAW_CLOSE_REASONS.filter(
      (reason) => reason !== "author_pr_budget_exceeded" && reason !== "obsolete_fix_pr",
    ),
    pull_request: OPENCLAW_CLOSE_REASONS.filter(
      (reason) =>
        reason !== "stale_insufficient_info" &&
        reason !== "unsponsored_feature_request" &&
        reason !== "stale_version_bug",
    ),
  },
};

const TARGET_REPOSITORY_CONFIG = readTargetRepositoryConfig();

export const REPOSITORY_PROFILES: RepositoryProfile[] = [
  CORE_OPENCLAW_PROFILE,
  ...TARGET_REPOSITORY_CONFIG.repositories.map(configuredRepositoryProfile),
];

export function repositoryProfileFor(targetRepo: string): RepositoryProfile {
  const normalized = normalizeRepo(targetRepo);
  const profile = configuredRepositoryProfileFor(normalized);
  if (profile) return profile;

  const fallback = fallbackRepositoryProfile(normalized);
  if (fallback) return fallback;

  throw new Error(
    `Unsupported target repo: ${targetRepo}. Known repos: ${REPOSITORY_PROFILES.map((candidate) => candidate.targetRepo).join(", ")}. Generic fallbacks: ${fallbackDescription()}`,
  );
}

export function configuredRepositoryProfileFor(targetRepo: string): RepositoryProfile | undefined {
  const normalized = normalizeRepo(targetRepo);
  return REPOSITORY_PROFILES.find(
    (candidate) => normalizeRepo(candidate.targetRepo) === normalized,
  );
}

export function repositoryProfileForSlug(slug: string): RepositoryProfile | undefined {
  return REPOSITORY_PROFILES.find((candidate) => candidate.slug === slug);
}

export function normalizeRepo(targetRepo: string): string {
  return targetRepo.trim().toLowerCase();
}

export function isAutoCloseAllowed(
  profile: RepositoryProfile,
  kind: RepositoryItemKind,
  reason: RepositoryCloseReason,
): boolean {
  return Boolean(profile.applyCloseRules[kind]?.includes(reason));
}

function configuredRepositoryProfile(profile: ConfiguredRepositoryProfile): RepositoryProfile {
  const targetRepo = normalizeRepo(profile.targetRepo);
  const result: RepositoryProfile = {
    targetRepo,
    slug: slugForRepo(targetRepo),
    displayName: profile.displayName,
    checkoutDir: profile.checkoutDir,
    promptNote: profile.promptNote,
    applyCloseRules: profile.applyCloseRules,
  };
  if (profile.docsUrl) result.docsUrl = profile.docsUrl;
  if (profile.communityUrl) result.communityUrl = profile.communityUrl;
  return result;
}

function fallbackRepositoryProfile(normalizedTargetRepo: string): RepositoryProfile | undefined {
  const [owner, repoName] = normalizedTargetRepo.split("/");
  if (!owner || !repoName) return undefined;

  const fallback = TARGET_REPOSITORY_CONFIG.genericFallbacks.find(
    (candidate) => candidate.owner === owner,
  );
  if (!fallback) return undefined;
  if (fallback.denyRepositories.includes(normalizedTargetRepo)) return undefined;
  if (!fallback.allowRepoNamePattern.test(repoName)) return undefined;

  return {
    targetRepo: normalizedTargetRepo,
    slug: slugForRepo(normalizedTargetRepo),
    displayName: repoName,
    checkoutDir: repoName,
    promptNote: fallback.promptNote
      .replaceAll("{target_repo}", normalizedTargetRepo)
      .replaceAll("{repo_name}", repoName),
    applyCloseRules: fallback.applyCloseRules,
  };
}

function fallbackDescription(): string {
  if (TARGET_REPOSITORY_CONFIG.genericFallbacks.length === 0) return "disabled";
  return TARGET_REPOSITORY_CONFIG.genericFallbacks
    .map((fallback) => {
      const denied =
        fallback.denyRepositories.length === 0
          ? ""
          : ` except ${fallback.denyRepositories.join(", ")}`;
      return `${fallback.owner}/*${denied}`;
    })
    .join(", ");
}

export function slugForRepo(targetRepo: string): string {
  return targetRepo.replace(/[^A-Za-z0-9_.-]+/g, "-");
}

function readTargetRepositoryConfig(
  filePath = join(repoRoot(), "config", "target-repositories.json"),
): TargetRepositoryConfig {
  if (!existsSync(filePath)) return { schemaVersion: 1, repositories: [], genericFallbacks: [] };
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  return validateTargetRepositoryConfig(parsed);
}

function validateTargetRepositoryConfig(value: unknown): TargetRepositoryConfig {
  const config = record(value, "target repository config");
  const schemaVersion = numberValue(config.schema_version, "schema_version");
  if (schemaVersion !== 1 && schemaVersion !== 2)
    throw new Error(`Unsupported target repository config schema: ${schemaVersion}`);
  const repositories = arrayValue(config.repositories, "repositories").map((entry, index) =>
    validateConfiguredRepositoryProfile(entry, `repositories[${index}]`),
  );
  const genericFallbacks =
    config.generic_fallbacks !== undefined
      ? arrayValue(config.generic_fallbacks, "generic_fallbacks").map((entry, index) =>
          validateGenericFallbackConfig(entry, `generic_fallbacks[${index}]`),
        )
      : [];
  const result: TargetRepositoryConfig = {
    schemaVersion: schemaVersion as 1 | 2,
    repositories,
    genericFallbacks,
  };
  if (config.openclaw_fallback !== undefined) {
    result.genericFallbacks = [
      ...result.genericFallbacks,
      validateGenericFallbackConfig(config.openclaw_fallback, "openclaw_fallback"),
    ];
  }
  return result;
}

function validateConfiguredRepositoryProfile(
  value: unknown,
  label: string,
): ConfiguredRepositoryProfile {
  const profile = record(value, label);
  const result: ConfiguredRepositoryProfile = {
    targetRepo: repoValue(profile.target_repo, `${label}.target_repo`),
    displayName: stringValue(profile.display_name, `${label}.display_name`),
    checkoutDir: pathSegmentValue(profile.checkout_dir, `${label}.checkout_dir`),
    promptNote: stringValue(profile.prompt_note, `${label}.prompt_note`),
    applyCloseRules: closeRulesValue(profile.apply_close_rules, `${label}.apply_close_rules`),
  };
  if (profile.docs_url !== undefined) {
    result.docsUrl = stringValue(profile.docs_url, `${label}.docs_url`);
  }
  if (profile.community_url !== undefined) {
    result.communityUrl = stringValue(profile.community_url, `${label}.community_url`);
  }
  return result;
}

function validateGenericFallbackConfig(value: unknown, label: string): GenericFallbackConfig {
  const fallback = record(value, label);
  const pattern = stringValue(fallback.allow_repo_name_pattern, `${label}.allow_repo_name_pattern`);
  return {
    owner: stringValue(fallback.owner, `${label}.owner`).toLowerCase(),
    denyRepositories: arrayValue(fallback.deny_repositories, `${label}.deny_repositories`).map(
      (entry, index) => normalizeRepo(repoValue(entry, `${label}.deny_repositories[${index}]`)),
    ),
    allowRepoNamePattern: new RegExp(pattern),
    promptNote: stringValue(fallback.prompt_note, `${label}.prompt_note`),
    applyCloseRules: closeRulesValue(fallback.apply_close_rules, `${label}.apply_close_rules`),
  };
}

function closeRulesValue(
  value: unknown,
  label: string,
): Partial<Record<RepositoryItemKind, readonly RepositoryCloseReason[]>> {
  const rules = record(value, label);
  const result: Partial<Record<RepositoryItemKind, RepositoryCloseReason[]>> = {};
  for (const [kind, reasons] of Object.entries(rules)) {
    if (!ITEM_KIND_SET.has(kind as RepositoryItemKind)) {
      throw new Error(`${label}.${kind} has unsupported item kind`);
    }
    result[kind as RepositoryItemKind] = arrayValue(reasons, `${label}.${kind}`).map(
      (reason, index) => closeReasonValue(reason, `${label}.${kind}[${index}]`),
    );
  }
  return result;
}

function closeReasonValue(value: unknown, label: string): RepositoryCloseReason {
  const reason = stringValue(value, label) as RepositoryCloseReason;
  if (!CLOSE_REASON_SET.has(reason))
    throw new Error(`${label} has unsupported close reason: ${reason}`);
  return reason;
}

function repoValue(value: unknown, label: string): string {
  const repo = normalizeRepo(stringValue(value, label));
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repo)) throw new Error(`${label} must be owner/repo`);
  return repo;
}

function pathSegmentValue(value: unknown, label: string): string {
  const segment = stringValue(value, label);
  if (!/^[A-Za-z0-9_.-]+$/.test(segment)) throw new Error(`${label} must be a safe path segment`);
  return segment;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${label} must be a string`);
  return value;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== "number") throw new Error(`${label} must be a number`);
  return value;
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function repoRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}
