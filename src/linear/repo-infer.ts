/**
 * Linear → target_repo inference (pure, offline, conservative).
 *
 * Doctrine — infer ONLY the target_repo STRING; never guess, never default:
 *   The analysis runner must map a Linear issue to a known target repository before it can
 *   point the read-only Codex sandbox at the right local checkout. This helper infers ONLY the
 *   `owner/repo` string from the issue's labels, title, and attachment/body URLs. It NEVER
 *   resolves a checkout dir (that is repositoryProfileFor().checkoutDir, called downstream),
 *   NEVER falls back to DEFAULT_TARGET_REPO, and returns AMBIGUOUS (no repo) whenever it
 *   cannot pick exactly one — the runner then SKIPS analysis rather than analyzing the wrong
 *   tree. Pure: no network, no clock, no filesystem.
 *
 * URL and configured-label signals must agree. Fallback-owner matching is consulted only when
 * neither strong signal exists, because ordinary routing labels are not repository evidence.
 */

import { normalizeRepo, REPOSITORY_PROFILES } from "../repository-profiles.js";

/** The known-repo facts this helper matches against (extracted from the profiles + config). */
export interface RepoCatalogEntry {
  targetRepo: string; // normalized "owner/repo"
  checkoutDir: string;
  displayName: string;
}

/** Generic-fallback owner rule (owner token + repo-name allow pattern). */
export interface FallbackOwnerRule {
  owner: string; // lowercased
  allowRepoNamePattern: RegExp;
  denyRepositories: readonly string[];
}

/** The catalog the inference reads — built from the static profiles + config fallbacks. */
export interface RepoCatalog {
  entries: RepoCatalogEntry[];
  fallbackOwners: FallbackOwnerRule[];
}

/** A Linear item's repo-bearing surfaces (plain data; no fetch). */
export interface RepoInferenceItem {
  labels: string[];
  title: string;
  /** Attachment/body URLs (e.g. attachment.url values + URLs scraped from the description). */
  urls: string[];
}

export type RepoInference =
  | { repo: string; via: "url" | "label" | "fallback-owner"; reasons: string[] }
  | { repo: null; ambiguous: true; reasons: string[] };

// Mirror schema/clawsweeper-decision.schema.json canonicalRef (line 389), relaxed to also
// accept a bare owner/repo path and repository sub-routes. Capture the whole path and validate
// it segment-by-segment below: a regex with a permissive trailing `.*` silently accepts
// marketing routes like /solutions/industry/healthcare as the repository "solutions/industry".
const GITHUB_URL_RE = /^https?:\/\/(?:www\.)?github\.com\/([^\s#?]+)(?:[#?]\S*)?$/i;

const GITHUB_PATH_SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;

// Everything after owner/repo is deliberately IGNORED rather than validated against a list of
// known sub-routes. A sub-route allow-list fails OPEN: an unlisted-but-valid route such as
// /owner/repo/forks or /stargazers would drop the URL as evidence entirely, removing it from
// the URL/label agreement check and letting a conflicting label select the wrong checkout.
// Excluding reserved top-level routes and keeping the first two segments fails CLOSED instead:
// a genuine repository URL always stays evidence, and a missed reserved route degrades to an
// unsupported-repository skip.

// GitHub's reserved top-level namespace: product, marketing, and account routes that can never
// be an owner. For a TWO-segment path there is no structural way to tell /solutions/industry
// from a real but unsupported /owner/repo — both are just two segments — so this list is the
// only available discriminator and must be extended when GitHub adds routes. The failure mode
// of a missing entry is conservative: the route is read as an unsupported repository, which
// makes inference SKIP the item. A stale list therefore costs coverage, never a wrong analysis.
const GITHUB_RESERVED_FIRST_SEGMENTS = new Set([
  "about",
  "account",
  "apps",
  "careers",
  "changelog",
  "codespaces",
  "collections",
  "advisories",
  "codeload",
  "community",
  "contact",
  "copilot",
  "customer-stories",
  "customer-terms",
  "dashboard",
  "discussions",
  "education",
  "enterprise",
  "enterprises",
  "events",
  "explore",
  "features",
  "gist",
  "git-guides",
  "home",
  "industries",
  "issues",
  "join",
  "login",
  "logout",
  "marketplace",
  "mobile",
  "models",
  "new",
  "nonprofits",
  "notifications",
  "open-source",
  "organizations",
  "orgs",
  "partners",
  "premium-support",
  "pricing",
  "privacy",
  "pulls",
  "readme",
  "resources",
  "search",
  "security",
  "sessions",
  "settings",
  "shop",
  "signup",
  "site",
  "site-policy",
  "sitemap",
  "solutions",
  "sponsors",
  "stars",
  "status",
  "support",
  "team",
  "terms",
  "topics",
  "trending",
  "trust-center",
  "users",
  "watching",
  "why-github",
  "wiki",
]);

/** Extracts distinct normalized owner/repo strings from a list of URLs. */
export function ownerRepoFromUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    const url = (raw ?? "").trim();
    if (url === "") continue;
    const match = GITHUB_URL_RE.exec(url);
    if (match === null || match[1] === undefined) continue;
    const segments = match[1].split("/").filter((segment) => segment !== "");
    if (segments.length < 2) continue;
    const owner = segments[0] as string;
    const name = (segments[1] as string).replace(/\.git$/i, "");
    if (!GITHUB_PATH_SEGMENT_RE.test(owner) || !GITHUB_PATH_SEGMENT_RE.test(name)) continue;
    if (GITHUB_RESERVED_FIRST_SEGMENTS.has(owner.toLowerCase())) continue;
    const repo = normalizeRepo(`${owner}/${name}`);
    if (!seen.has(repo)) {
      seen.add(repo);
      out.push(repo);
    }
  }
  return out;
}

/**
 * Builds the inference catalog from the static REPOSITORY_PROFILES plus generic-fallback owner
 * rules. Callers normally pass `fallbackOwners` read from config/target-repositories.json's
 * generic_fallbacks; tests pass fakes. Pure.
 */
export function buildRepoCatalog(fallbackOwners: FallbackOwnerRule[] = []): RepoCatalog {
  const entries: RepoCatalogEntry[] = REPOSITORY_PROFILES.map((p) => ({
    targetRepo: normalizeRepo(p.targetRepo),
    checkoutDir: p.checkoutDir.toLowerCase(),
    displayName: p.displayName.toLowerCase(),
  }));
  return {
    entries,
    fallbackOwners: fallbackOwners.map((f) => ({
      ...f,
      owner: f.owner.toLowerCase(),
      denyRepositories: f.denyRepositories.map((repo) => normalizeRepo(repo)),
    })),
  };
}

function distinctSurvivors(repos: string[]): string[] {
  return [...new Set(repos.map((repo) => normalizeRepo(repo)))];
}

function isDeniedRepo(repo: string, catalog: RepoCatalog): boolean {
  const normalized = normalizeRepo(repo);
  return catalog.fallbackOwners.some((rule) => rule.denyRepositories.includes(normalized));
}

function isSupportedRepo(repo: string, catalog: RepoCatalog): boolean {
  const normalized = normalizeRepo(repo);
  // Precedence is deliberate and MUST mirror repositoryProfileFor: an explicitly configured
  // target wins outright, and deny_repositories filters only the generic-fallback path (it is
  // nested under generic_fallbacks in config/target-repositories.json, so it cannot express a
  // global deny of a configured entry). Checking denial first would make inference skip an item
  // that repositoryProfileFor resolves happily — the same infer/profile divergence this deny
  // propagation was added to close, only inverted. To retire a configured target, remove its
  // repositories[] entry rather than deny-listing it.
  if (catalog.entries.some((entry) => entry.targetRepo === normalized)) return true;
  if (isDeniedRepo(normalized, catalog)) return false;
  const slash = normalized.indexOf("/");
  if (slash <= 0) return false;
  const owner = normalized.slice(0, slash);
  const name = normalized.slice(slash + 1);
  const ownerRules = catalog.fallbackOwners.filter((rule) => rule.owner === owner);
  return ownerRules.some((rule) => {
    rule.allowRepoNamePattern.lastIndex = 0;
    return rule.allowRepoNamePattern.test(name);
  });
}

// Step 2 — labels naming a known target_repo / checkout_dir / display_name.
function matchKnownByLabel(item: RepoInferenceItem, catalog: RepoCatalog): string[] {
  const tokens = item.labels.map((l) => l.trim().toLowerCase()).filter((l) => l !== "");
  const hits: string[] = [];
  for (const entry of catalog.entries) {
    if (
      tokens.includes(entry.targetRepo) ||
      tokens.includes(entry.checkoutDir) ||
      tokens.includes(entry.displayName)
    ) {
      hits.push(entry.targetRepo);
    }
  }
  return hits;
}

// Step 3 — a fallback-owner token (label or title word) + a repo-name candidate that passes
// the owner's allow pattern. The repo-name candidate is taken from labels of the form
// "owner/name" or a label that is a plain safe name paired with a present owner token.
function matchByFallbackOwner(item: RepoInferenceItem, catalog: RepoCatalog): string[] {
  if (catalog.fallbackOwners.length === 0) return [];
  const titleTokens = item.title
    .toLowerCase()
    .split(/[^A-Za-z0-9_.-]+/)
    .filter((t) => t !== "");
  const labelTokens = item.labels.map((l) => l.trim().toLowerCase()).filter((l) => l !== "");
  const tokens = new Set([...titleTokens, ...labelTokens]);
  const hits: string[] = [];

  for (const rule of catalog.fallbackOwners) {
    if (!tokens.has(rule.owner)) continue;
    for (const label of labelTokens) {
      const slash = label.indexOf("/");
      if (slash > 0) {
        const owner = label.slice(0, slash);
        const name = label.slice(slash + 1);
        const candidate = normalizeRepo(`${rule.owner}/${name}`);
        if (
          owner === rule.owner &&
          rule.allowRepoNamePattern.test(name) &&
          !isDeniedRepo(candidate, catalog)
        ) {
          hits.push(candidate);
        }
        continue;
      }
      const candidate = normalizeRepo(`${rule.owner}/${label}`);
      if (
        label !== rule.owner &&
        rule.allowRepoNamePattern.test(label) &&
        !isDeniedRepo(candidate, catalog)
      ) {
        hits.push(candidate);
      }
    }
  }
  return hits;
}

/**
 * Infers the target_repo string. URL and configured-label signals must agree; fallback-owner is
 * last-resort only. Returns a single repo or AMBIGUOUS (repo:null). Never guesses or defaults.
 */
export function inferTargetRepo(item: RepoInferenceItem, catalog: RepoCatalog): RepoInference {
  const urlRepos = ownerRepoFromUrls(item.urls);
  for (const repo of urlRepos) {
    if (!isSupportedRepo(repo, catalog)) {
      return {
        repo: null,
        ambiguous: true,
        reasons: [`unsupported GitHub URL repository ${repo} — skip`],
      };
    }
  }

  const labelHits = distinctSurvivors(matchKnownByLabel(item, catalog));
  if (urlRepos.length >= 2) {
    return {
      repo: null,
      ambiguous: true,
      reasons: [`>=2 distinct GitHub URLs [${urlRepos.join(", ")}] — ambiguous, skip`],
    };
  }
  if (labelHits.length >= 2) {
    return {
      repo: null,
      ambiguous: true,
      reasons: [`>=2 known-repo labels [${labelHits.join(", ")}] — ambiguous, skip`],
    };
  }
  if (urlRepos.length === 1 && labelHits.length === 1 && urlRepos[0] !== labelHits[0]) {
    return {
      repo: null,
      ambiguous: true,
      reasons: [
        `conflicting repository signals [${urlRepos[0]}, ${labelHits[0]}] — ambiguous, skip`,
      ],
    };
  }
  if (urlRepos.length === 1) {
    const repo = urlRepos[0] as string;
    return { repo, via: "url", reasons: [`unique GitHub URL → ${repo}`] };
  }
  if (labelHits.length === 1) {
    const repo = labelHits[0] as string;
    return { repo, via: "label", reasons: [`known-repo label → ${repo}`] };
  }

  const fallbackHits = distinctSurvivors(matchByFallbackOwner(item, catalog));
  if (fallbackHits.length >= 2) {
    return {
      repo: null,
      ambiguous: true,
      reasons: [`>=2 fallback-owner candidates [${fallbackHits.join(", ")}] — ambiguous, skip`],
    };
  }
  if (fallbackHits.length === 0) {
    return {
      repo: null,
      ambiguous: true,
      reasons: ["no GitHub URL in attachments/body", "0 candidates — ambiguous, skip"],
    };
  }
  const repo = fallbackHits[0] as string;
  return {
    repo,
    via: "fallback-owner",
    reasons: [`fallback-owner candidate → ${repo}`],
  };
}
