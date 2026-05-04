import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type RepositoryItemKind = "issue" | "pull_request";
export type RepositoryCloseReason =
  | "implemented_on_main"
  | "cannot_reproduce"
  | "clawhub"
  | "duplicate_or_superseded"
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

const REPO_NAME_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CHECKOUT_DIR_PATTERN = /^[A-Za-z0-9_.-]+$/;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const OPENCLAW_CLOSE_REASONS: readonly RepositoryCloseReason[] = [
  "implemented_on_main",
  "cannot_reproduce",
  "clawhub",
  "duplicate_or_superseded",
  "not_actionable_in_repo",
  "incoherent",
  "stale_insufficient_info",
];
const EXTERNAL_PROFILE_PULL_REQUEST_REASONS = new Set<RepositoryCloseReason>([
  "implemented_on_main",
]);
const EXTERNAL_PROFILE_GUARDRAIL =
  "Use the configured source tree and current main branch. This is an external ClawSweeper target, so review conservatively with source-backed evidence. Do not propose issue closes; pull request close proposals are limited to rules explicitly configured for this profile.";

export const DEFAULT_TARGET_REPO = "openclaw/openclaw";

export const BUILT_IN_REPOSITORY_PROFILES: readonly RepositoryProfile[] = [
  {
    targetRepo: DEFAULT_TARGET_REPO,
    slug: "openclaw-openclaw",
    displayName: "OpenClaw",
    checkoutDir: "openclaw",
    docsUrl: "https://docs.openclaw.ai",
    communityUrl: "https://clawhub.ai/",
    promptNote:
      "Use the OpenClaw source tree, docs, changelog, and current main branch. Close proposals may use the normal OpenClaw stale/duplicate/not-in-repo/implemented-on-main policy when evidence is strong.",
    applyCloseRules: {
      issue: OPENCLAW_CLOSE_REASONS,
      pull_request: OPENCLAW_CLOSE_REASONS.filter((reason) => reason !== "stale_insufficient_info"),
    },
  },
  {
    targetRepo: "openclaw/clawhub",
    slug: "openclaw-clawhub",
    displayName: "ClawHub",
    checkoutDir: "clawhub",
    communityUrl: "https://clawhub.ai/",
    promptNote:
      "Use the ClawHub source tree and current main branch. Review every issue and PR with the same evidence standard, but only propose auto-close for pull requests that are certainly implemented on main. Keep everything else open.",
    applyCloseRules: {
      issue: [],
      pull_request: ["implemented_on_main"],
    },
  },
  {
    targetRepo: "openclaw/clawsweeper",
    slug: "openclaw-clawsweeper",
    displayName: "ClawSweeper",
    checkoutDir: "clawsweeper",
    promptNote:
      "Use the ClawSweeper source tree and current main branch. Review bot automation, workflow, and documentation changes conservatively. Only propose auto-close for pull requests that are certainly implemented on main; keep issues open for maintainer triage.",
    applyCloseRules: {
      issue: [],
      pull_request: ["implemented_on_main"],
    },
  },
];

export const REPOSITORY_PROFILES: RepositoryProfile[] = mergeRepositoryProfiles(
  BUILT_IN_REPOSITORY_PROFILES,
  loadExtraRepositoryProfilesFromEnv(),
);

export function repositoryProfileFor(targetRepo: string): RepositoryProfile {
  const normalized = normalizeRepo(targetRepo);
  const profile = REPOSITORY_PROFILES.find(
    (candidate) => normalizeRepo(candidate.targetRepo) === normalized,
  );
  if (!profile) {
    throw new Error(
      `Unsupported target repo: ${targetRepo}. Known repos: ${REPOSITORY_PROFILES.map((candidate) => candidate.targetRepo).join(", ")}`,
    );
  }
  return profile;
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

export function loadExtraRepositoryProfilesFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RepositoryProfile[] {
  const profiles: RepositoryProfile[] = [];
  const json = env.CLAWSWEEPER_EXTRA_PROFILES_JSON?.trim();
  if (json) {
    profiles.push(...parseExtraRepositoryProfilesJson(json, "CLAWSWEEPER_EXTRA_PROFILES_JSON"));
  }

  const path = env.CLAWSWEEPER_EXTRA_PROFILES_PATH?.trim();
  if (path) {
    const resolvedPath = resolve(path);
    profiles.push(
      ...parseExtraRepositoryProfilesJson(
        readFileSync(resolvedPath, "utf8"),
        `CLAWSWEEPER_EXTRA_PROFILES_PATH:${resolvedPath}`,
      ),
    );
  }

  return mergeRepositoryProfiles(profiles);
}

export function parseExtraRepositoryProfilesJson(
  json: string,
  source = "extra repository profiles",
): RepositoryProfile[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (error) {
    throw new Error(`Invalid ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`Invalid ${source}: expected a JSON array`);
  return mergeRepositoryProfiles(
    parsed.map((value, index) =>
      externalRepositoryProfileFromRecord(asRecord(value, `${source}[${index}]`), source, index),
    ),
  );
}

export function mergeRepositoryProfiles(
  ...profileSets: readonly (readonly RepositoryProfile[])[]
): RepositoryProfile[] {
  const profiles: RepositoryProfile[] = [];
  const targets = new Map<string, string>();
  const slugs = new Map<string, string>();
  for (const set of profileSets) {
    for (const profile of set) {
      const targetKey = normalizeRepo(profile.targetRepo);
      const duplicateTarget = targets.get(targetKey);
      if (duplicateTarget) {
        throw new Error(
          `Duplicate repository profile for ${profile.targetRepo}; already defined by ${duplicateTarget}`,
        );
      }
      const duplicateSlug = slugs.get(profile.slug);
      if (duplicateSlug) {
        throw new Error(
          `Duplicate repository profile slug ${profile.slug}; already used by ${duplicateSlug}`,
        );
      }
      targets.set(targetKey, profile.targetRepo);
      slugs.set(profile.slug, profile.targetRepo);
      profiles.push(profile);
    }
  }
  return profiles;
}

function externalRepositoryProfileFromRecord(
  record: Record<string, unknown>,
  source: string,
  index: number,
): RepositoryProfile {
  const context = `${source}[${index}]`;
  rejectUnknownKeys(record, context, [
    "targetRepo",
    "slug",
    "displayName",
    "checkoutDir",
    "docsUrl",
    "communityUrl",
    "promptNote",
    "applyCloseRules",
  ]);
  const targetRepo = requiredString(record, "targetRepo", context);
  if (!REPO_NAME_PATTERN.test(targetRepo)) {
    throw new Error(`Invalid ${context}.targetRepo: expected owner/repo`);
  }

  const slug = optionalString(record, "slug", context) ?? repoSlug(targetRepo);
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(`Invalid ${context}.slug: expected lowercase letters, numbers, and hyphens`);
  }

  const repoName = targetRepo.split("/")[1] ?? targetRepo;
  const checkoutDir = optionalString(record, "checkoutDir", context) ?? repoName;
  if (!CHECKOUT_DIR_PATTERN.test(checkoutDir)) {
    throw new Error(`Invalid ${context}.checkoutDir: expected a single repository directory name`);
  }

  const displayName = optionalString(record, "displayName", context) ?? repoName;
  const profile: RepositoryProfile = {
    targetRepo,
    slug,
    displayName,
    checkoutDir,
    promptNote: externalPromptNote(optionalString(record, "promptNote", context)),
    applyCloseRules: externalApplyCloseRules(record.applyCloseRules, context),
  };

  const docsUrl = optionalHttpUrl(record, "docsUrl", context);
  if (docsUrl) profile.docsUrl = docsUrl;
  const communityUrl = optionalHttpUrl(record, "communityUrl", context);
  if (communityUrl) profile.communityUrl = communityUrl;
  return profile;
}

function externalPromptNote(promptNote: string | undefined): string {
  if (!promptNote) return EXTERNAL_PROFILE_GUARDRAIL;
  if (promptNote.length > 2000) {
    throw new Error("Invalid external repository profile promptNote: maximum length is 2000");
  }
  return `${EXTERNAL_PROFILE_GUARDRAIL} Additional repository context: ${promptNote}`;
}

function externalApplyCloseRules(
  value: unknown,
  context: string,
): Partial<Record<RepositoryItemKind, readonly RepositoryCloseReason[]>> {
  if (value === undefined) return { issue: [], pull_request: [] };
  const record = asRecord(value, `${context}.applyCloseRules`);
  rejectUnknownKeys(record, `${context}.applyCloseRules`, ["issue", "pull_request"]);
  const issue = closeReasons(record.issue, `${context}.applyCloseRules.issue`);
  if (issue.length > 0) {
    throw new Error(
      `Invalid ${context}.applyCloseRules.issue: external profiles cannot enable issue auto-close`,
    );
  }
  const pullRequest = closeReasons(record.pull_request, `${context}.applyCloseRules.pull_request`);
  const unsupported = pullRequest.filter(
    (reason) => !EXTERNAL_PROFILE_PULL_REQUEST_REASONS.has(reason),
  );
  if (unsupported.length > 0) {
    throw new Error(
      `Invalid ${context}.applyCloseRules.pull_request: external profiles may only enable implemented_on_main`,
    );
  }
  return { issue, pull_request: pullRequest };
}

function closeReasons(value: unknown, context: string): RepositoryCloseReason[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Invalid ${context}: expected an array`);
  const reasons: RepositoryCloseReason[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") throw new Error(`Invalid ${context}: expected string reasons`);
    if (!isRepositoryCloseReason(raw)) {
      throw new Error(`Invalid ${context}: unsupported close reason ${raw}`);
    }
    if (!reasons.includes(raw)) reasons.push(raw);
  }
  return reasons;
}

function isRepositoryCloseReason(value: string): value is RepositoryCloseReason {
  return (
    value === "implemented_on_main" ||
    value === "cannot_reproduce" ||
    value === "clawhub" ||
    value === "duplicate_or_superseded" ||
    value === "not_actionable_in_repo" ||
    value === "incoherent" ||
    value === "stale_insufficient_info" ||
    value === "none"
  );
}

function requiredString(record: Record<string, unknown>, key: string, context: string): string {
  const value = optionalString(record, key, context);
  if (!value) throw new Error(`Invalid ${context}.${key}: expected a non-empty string`);
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  context: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Invalid ${context}.${key}: expected a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`Invalid ${context}.${key}: expected a non-empty string`);
  return trimmed;
}

function optionalHttpUrl(
  record: Record<string, unknown>,
  key: string,
  context: string,
): string | undefined {
  const value = optionalString(record, key, context);
  if (!value) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid ${context}.${key}: expected an HTTP URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid ${context}.${key}: expected an HTTP URL`);
  }
  return value;
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  context: string,
  allowedKeys: readonly string[],
): void {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`Invalid ${context}: unknown keys ${unknown.join(", ")}`);
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${context}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function repoSlug(targetRepo: string): string {
  return normalizeRepo(targetRepo)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
