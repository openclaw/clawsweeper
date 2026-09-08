import { recordOrEmpty, requireRecord as record } from "./value-coerce.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type RepositoryItemKind = "issue" | "pull_request";
export type RepositoryLiveTestSurface = "browser" | "terminal";
export type RepositoryPackageManager = "bun" | "pnpm" | "npm";

export interface RepositoryLiveTestConfig {
  enabled: boolean;
  surfaceDefault: RepositoryLiveTestSurface;
  setup: readonly string[];
  allowInstallScripts: boolean;
  start?: string;
  url?: string;
  readyTimeoutSeconds: number;
  maxRecordingSeconds: number;
}

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
  packageManager: RepositoryPackageManager;
  docsUrl?: string;
  communityUrl?: string;
  promptNote: string;
  applyCloseRules: Partial<Record<RepositoryItemKind, readonly RepositoryCloseReason[]>>;
  liveTest?: RepositoryLiveTestConfig;
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
  packageManager: RepositoryPackageManager;
  docsUrl?: string;
  communityUrl?: string;
  promptNote: string;
  applyCloseRules: Partial<Record<RepositoryItemKind, readonly RepositoryCloseReason[]>>;
  liveTest?: RepositoryLiveTestConfig;
}

interface GenericFallbackConfig {
  owner: string;
  denyRepositories: readonly string[];
  allowRepoNamePattern: RegExp;
  packageManager: RepositoryPackageManager;
  promptNote: string;
  applyCloseRules: Partial<Record<RepositoryItemKind, readonly RepositoryCloseReason[]>>;
  liveTest?: RepositoryLiveTestConfig;
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
  packageManager: "pnpm",
  docsUrl: "https://docs.openclaw.ai",
  communityUrl: "https://clawhub.ai/",
  promptNote:
    "Use the OpenClaw source tree, docs, changelog, and current main branch. Close proposals may use the normal OpenClaw stale/duplicate/not-in-repo/implemented-on-main policy when evidence is strong. For OpenClaw PR reviews, ClawSweeper renders deterministic PR surface stats separately; do not repeat changed-file counts, additions/deletions, or area totals in Review metrics unless adding a new interpretation not present in the deterministic surface block. Use Review metrics for new review-relevant facts, especially user-facing configuration additions, new flags/options/env vars, new protocol/API params, default changes, migrations, persisted settings, or compatibility paths.\n\n" +
    "Keep repository-managed locale PRs open: the canonical same-repository `automation/native-app-locale-refresh` and `automation/control-ui-locale-refresh` branches targeting main, authored by `openclaw-mantis[bot]` (`app/openclaw-mantis` in GraphQL), belong to their generated-PR publisher. That publisher owns freshness and auto-merge; continue normal review and CI requirements.\n\n" +
    "For `openclaw/openclaw` PR release-note review, `CHANGELOG.md` is release-owned. Normal PRs, repair workers, and automerge/autofix lanes should not edit it. Do not make missing `CHANGELOG.md` a review finding, merge blocker, work item, or next-step blocker. If release-note context is needed, ask for PR-body or commit message context: user-visible behavior, affected surface, issue/PR refs, and credited human author/reporter when known. Never request `Thanks @steipete`, `Thanks @openclaw`, `Thanks @clawsweeper`, or other forbidden bot/maintainer changelog attributions.",
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
  // Browser live proofs run against the repository's self-contained mock
  // control-UI dev server, which needs no gateway, accounts, or credentials.
  liveTest: {
    enabled: true,
    surfaceDefault: "browser",
    setup: ["pnpm install --frozen-lockfile", "pnpm ui:install"],
    allowInstallScripts: false,
    start: "pnpm dev:ui:mock",
    url: "http://127.0.0.1:5187",
    readyTimeoutSeconds: 300,
    maxRecordingSeconds: 90,
  },
};

const TARGET_REPOSITORY_CONFIG = readTargetRepositoryConfig();

export const REPOSITORY_PROFILES: RepositoryProfile[] = [
  repositoryProfileWithFallbackLiveTest(CORE_OPENCLAW_PROFILE),
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

export function repositoryManagedPullRequestCloseReason(
  item: { repo: string; kind: RepositoryItemKind; author: string },
  readPullRequest: () => unknown,
): string | null {
  if (
    normalizeRepo(item.repo) !== DEFAULT_TARGET_REPO ||
    item.kind !== "pull_request" ||
    !["openclaw-mantis[bot]", "app/openclaw-mantis"].includes(item.author.toLowerCase())
  )
    return null;
  const pull = recordOrEmpty(readPullRequest());
  const head = recordOrEmpty(pull.head);
  const base = recordOrEmpty(pull.base);
  if (
    recordOrEmpty(pull.user).login !== "openclaw-mantis[bot]" ||
    recordOrEmpty(head.repo).full_name !== DEFAULT_TARGET_REPO ||
    recordOrEmpty(base.repo).full_name !== DEFAULT_TARGET_REPO ||
    base.ref !== "main" ||
    typeof head.ref !== "string" ||
    !["automation/native-app-locale-refresh", "automation/control-ui-locale-refresh"].includes(
      head.ref,
    )
  )
    return null;
  // This withholds close authority only; the publisher owns freshness and auto-merge.
  return "repository-managed locale PR: leave reconciliation and auto-merge to its publisher";
}

function configuredRepositoryProfile(profile: ConfiguredRepositoryProfile): RepositoryProfile {
  const targetRepo = normalizeRepo(profile.targetRepo);
  const result: RepositoryProfile = {
    targetRepo,
    slug: slugForRepo(targetRepo),
    displayName: profile.displayName,
    checkoutDir: profile.checkoutDir,
    packageManager: profile.packageManager,
    promptNote: profile.promptNote,
    applyCloseRules: profile.applyCloseRules,
  };
  if (profile.docsUrl) result.docsUrl = profile.docsUrl;
  if (profile.communityUrl) result.communityUrl = profile.communityUrl;
  const liveTest = profile.liveTest ?? genericFallbackConfigFor(targetRepo)?.liveTest;
  if (liveTest) result.liveTest = liveTest;
  return result;
}

function repositoryProfileWithFallbackLiveTest(profile: RepositoryProfile): RepositoryProfile {
  if (profile.liveTest) return profile;
  const liveTest = genericFallbackConfigFor(profile.targetRepo)?.liveTest;
  return liveTest ? { ...profile, liveTest } : profile;
}

function fallbackRepositoryProfile(normalizedTargetRepo: string): RepositoryProfile | undefined {
  const [owner, repoName] = normalizedTargetRepo.split("/");
  if (!owner || !repoName) return undefined;

  const fallback = genericFallbackConfigFor(normalizedTargetRepo);
  if (!fallback) return undefined;

  const result: RepositoryProfile = {
    targetRepo: normalizedTargetRepo,
    slug: slugForRepo(normalizedTargetRepo),
    displayName: repoName,
    checkoutDir: repoName,
    packageManager: fallback.packageManager,
    promptNote: fallback.promptNote
      .replaceAll("{target_repo}", normalizedTargetRepo)
      .replaceAll("{repo_name}", repoName),
    applyCloseRules: fallback.applyCloseRules,
  };
  if (fallback.liveTest) result.liveTest = fallback.liveTest;
  return result;
}

function genericFallbackConfigFor(normalizedTargetRepo: string): GenericFallbackConfig | undefined {
  const [owner, repoName] = normalizedTargetRepo.split("/");
  if (!owner || !repoName) return undefined;
  const fallback = TARGET_REPOSITORY_CONFIG.genericFallbacks.find(
    (candidate) => candidate.owner === owner,
  );
  if (!fallback) return undefined;
  if (fallback.denyRepositories.includes(normalizedTargetRepo)) return undefined;
  if (!fallback.allowRepoNamePattern.test(repoName)) return undefined;
  return fallback;
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
    validateConfiguredRepositoryProfile(entry, `repositories[${index}]`, schemaVersion as 1 | 2),
  );
  const genericFallbacks =
    config.generic_fallbacks !== undefined
      ? arrayValue(config.generic_fallbacks, "generic_fallbacks").map((entry, index) =>
          validateGenericFallbackConfig(
            entry,
            `generic_fallbacks[${index}]`,
            schemaVersion as 1 | 2,
          ),
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
      validateGenericFallbackConfig(
        config.openclaw_fallback,
        "openclaw_fallback",
        schemaVersion as 1 | 2,
      ),
    ];
  }
  return result;
}

function validateConfiguredRepositoryProfile(
  value: unknown,
  label: string,
  schemaVersion: 1 | 2,
): ConfiguredRepositoryProfile {
  const profile = record(value, label);
  const result: ConfiguredRepositoryProfile = {
    targetRepo: repoValue(profile.target_repo, `${label}.target_repo`),
    displayName: stringValue(profile.display_name, `${label}.display_name`),
    checkoutDir: pathSegmentValue(profile.checkout_dir, `${label}.checkout_dir`),
    packageManager: packageManagerValue(profile.package_manager, `${label}.package_manager`),
    promptNote: stringValue(profile.prompt_note, `${label}.prompt_note`),
    applyCloseRules: closeRulesValue(profile.apply_close_rules, `${label}.apply_close_rules`),
  };
  if (profile.docs_url !== undefined) {
    result.docsUrl = stringValue(profile.docs_url, `${label}.docs_url`);
  }
  if (profile.community_url !== undefined) {
    result.communityUrl = stringValue(profile.community_url, `${label}.community_url`);
  }
  if (profile.live_test !== undefined) {
    if (schemaVersion !== 2) throw new Error(`${label}.live_test requires schema_version 2`);
    result.liveTest = liveTestValue(profile.live_test, `${label}.live_test`);
  }
  return result;
}

function liveTestValue(value: unknown, label: string): RepositoryLiveTestConfig {
  // Local so the eager module-init config read cannot hit a temporal dead zone
  // when a checked-in profile carries a live_test block.
  const liveTestKeys = new Set([
    "enabled",
    "surface_default",
    "setup",
    "allow_install_scripts",
    "start",
    "url",
    "ready_timeout_seconds",
    "max_recording_seconds",
  ]);
  const config = record(value, label);
  const unexpected = Object.keys(config).filter((key) => !liveTestKeys.has(key));
  if (unexpected.length) throw new Error(`${label} has unexpected keys: ${unexpected.join(", ")}`);
  const surfaceDefault = stringValue(
    config.surface_default,
    `${label}.surface_default`,
  ) as RepositoryLiveTestSurface;
  if (surfaceDefault !== "browser" && surfaceDefault !== "terminal") {
    throw new Error(`${label}.surface_default must be browser or terminal`);
  }
  const setup = arrayValue(config.setup, `${label}.setup`).map((entry, index) =>
    commandValue(entry, `${label}.setup[${index}]`),
  );
  const result: RepositoryLiveTestConfig = {
    enabled: booleanValue(config.enabled, `${label}.enabled`),
    surfaceDefault,
    setup,
    allowInstallScripts:
      config.allow_install_scripts === undefined
        ? false
        : booleanValue(config.allow_install_scripts, `${label}.allow_install_scripts`),
    readyTimeoutSeconds: positiveIntegerValue(
      config.ready_timeout_seconds,
      `${label}.ready_timeout_seconds`,
    ),
    maxRecordingSeconds: positiveIntegerValue(
      config.max_recording_seconds,
      `${label}.max_recording_seconds`,
    ),
  };
  if (result.maxRecordingSeconds > 90) {
    throw new Error(`${label}.max_recording_seconds must be at most 90`);
  }
  if (config.start !== undefined) result.start = commandValue(config.start, `${label}.start`);
  if (config.url !== undefined) result.url = urlOriginValue(config.url, `${label}.url`);
  if (surfaceDefault === "browser") {
    if (!result.start) throw new Error(`${label}.start is required for browser live tests`);
    if (!result.url) throw new Error(`${label}.url is required for browser live tests`);
  }
  return result;
}

export function validateTargetRepositoryConfigForTest(value: unknown): TargetRepositoryConfig {
  return validateTargetRepositoryConfig(value);
}

function validateGenericFallbackConfig(
  value: unknown,
  label: string,
  schemaVersion: 1 | 2,
): GenericFallbackConfig {
  const fallback = record(value, label);
  const pattern = stringValue(fallback.allow_repo_name_pattern, `${label}.allow_repo_name_pattern`);
  const result: GenericFallbackConfig = {
    owner: stringValue(fallback.owner, `${label}.owner`).toLowerCase(),
    denyRepositories: arrayValue(fallback.deny_repositories, `${label}.deny_repositories`).map(
      (entry, index) => normalizeRepo(repoValue(entry, `${label}.deny_repositories[${index}]`)),
    ),
    allowRepoNamePattern: new RegExp(pattern),
    packageManager: packageManagerValue(fallback.package_manager, `${label}.package_manager`),
    promptNote: stringValue(fallback.prompt_note, `${label}.prompt_note`),
    applyCloseRules: closeRulesValue(fallback.apply_close_rules, `${label}.apply_close_rules`),
  };
  if (fallback.live_test !== undefined) {
    if (schemaVersion !== 2) throw new Error(`${label}.live_test requires schema_version 2`);
    result.liveTest = liveTestValue(fallback.live_test, `${label}.live_test`);
  }
  return result;
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

function packageManagerValue(value: unknown, label: string): RepositoryPackageManager {
  const packageManager = value === undefined ? "pnpm" : stringValue(value, label).toLowerCase();
  if (packageManager !== "bun" && packageManager !== "pnpm" && packageManager !== "npm") {
    throw new Error(`${label} must be bun, pnpm, or npm`);
  }
  return packageManager;
}

// Profile strings reject whitespace-only text without trimming accepted values.
function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${label} must be a string`);
  return value;
}

function commandValue(value: unknown, label: string): string {
  const command = stringValue(value, label);
  if (/[\r\n\u2028\u2029]/.test(command)) throw new Error(`${label} must be a single line`);
  return command;
}

function urlOriginValue(value: unknown, label: string): string {
  const text = stringValue(value, label);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${label} must be an HTTP URL origin`);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${label} must be an HTTP URL origin`);
  }
  return url.origin;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function positiveIntegerValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
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

function repoRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}
