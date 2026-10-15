import {
  normalizeAuthorAssociation,
  predatesMaintainerAutomaticFirstReview,
  requiresMaintainerReviewRequest,
  verifiedMaintainerAuthorAssociation,
} from "../src/maintainer-review-policy.ts";

// Repository permission by `owner/repo|login`. One hour per isolate, so repeat
// events from one author cost one GitHub read.
const PERMISSION_CACHE_TTL_MS = 60 * 60 * 1000;
const PERMISSION_CACHE_MAX = 2_000;
const permissionCache = new Map<string, { permission: string; expiresAtMs: number }>();

// GitHub shows a private org member to the App as CONTRIBUTOR. The runner
// admission check (src/repair/exact-review-admission.ts) reads repository
// permission and then skips the review, so intake and dispatch read it too and
// stop the run before a runner starts. A failed read keeps the item's own
// association; the runner check still applies.
export async function requiresVerifiedMaintainerReviewRequest(
  targetRepo: string,
  item: Record<string, unknown>,
  readPermission: (author: string) => Promise<unknown>,
): Promise<boolean> {
  if (requiresMaintainerReviewRequest(item)) return true;
  if (
    normalizeAuthorAssociation(item.author_association) !== "CONTRIBUTOR" ||
    !predatesMaintainerAutomaticFirstReview(item)
  ) {
    return false;
  }
  const user = item.user;
  const author =
    user && typeof user === "object" && "login" in user && typeof user.login === "string"
      ? user.login
      : "";
  if (!/^[A-Za-z0-9-]+$/.test(author)) return false;
  const key = `${targetRepo}|${author.toLowerCase()}`;
  const now = Date.now();
  let cached = permissionCache.get(key);
  if (!cached || cached.expiresAtMs <= now) {
    let response: unknown;
    try {
      response = await readPermission(author);
    } catch {
      console.warn("ClawSweeper author repository permission unavailable");
      return false;
    }
    const permission =
      response && typeof response === "object" && "permission" in response
        ? String(response.permission || "")
        : "";
    cached = { permission, expiresAtMs: now + PERMISSION_CACHE_TTL_MS };
    if (permissionCache.size >= PERMISSION_CACHE_MAX) permissionCache.clear();
    permissionCache.set(key, cached);
  }
  return requiresMaintainerReviewRequest({
    ...item,
    author_association: verifiedMaintainerAuthorAssociation({
      authorAssociation: item.author_association,
      repositoryPermission: cached.permission,
    }),
  });
}
