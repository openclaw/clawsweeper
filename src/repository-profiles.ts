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

const OPENCLAW_CLOSE_REASONS: readonly RepositoryCloseReason[] = [
  "implemented_on_main",
  "cannot_reproduce",
  "clawhub",
  "duplicate_or_superseded",
  "not_actionable_in_repo",
  "incoherent",
  "stale_insufficient_info",
];

export const DEFAULT_TARGET_REPO = "openclaw/openclaw";

export const REPOSITORY_PROFILES: readonly RepositoryProfile[] = [
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
