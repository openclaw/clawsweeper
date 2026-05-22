import type { JsonValue, LooseRecord } from "./json-types.js";

// IMPORTANT: keep this character class identical to the one used by
// evidenceHasExternalUrl in review-results.ts. If the validator ever
// expands the terminator set, expand it here first so this sanitizer
// never produces output that the validator then rejects.
const URL_PATTERN = /https?:\/\/[^\s)\]"']+/g;
const ALLOWED_HOSTS = new Set(["github.com"]);
const PLACEHOLDER = "<external link>";

export function isGithubUrl(value: unknown): boolean {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return false;
  try {
    return ALLOWED_HOSTS.has(new URL(text).hostname);
  } catch {
    return false;
  }
}

// Used for single-URL fields such as a check `details_url`. Returns the URL
// when it points at github.com; otherwise returns "" so callers can decide to
// fall back to a hostname-free description.
export function sanitizeCheckLink(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  try {
    const url = new URL(text);
    return ALLOWED_HOSTS.has(url.hostname) ? text : "";
  } catch {
    return "";
  }
}

// Replaces every non-github http(s) URL inside a free-form string with the
// PLACEHOLDER token. The placeholder intentionally contains no `http(s)://`
// so it cannot trigger evidenceHasExternalUrl in review-results.ts.
export function sanitizeEvidenceText(value: unknown): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  if (!text) return "";
  return text.replace(URL_PATTERN, (match: string) => {
    try {
      return ALLOWED_HOSTS.has(new URL(match).hostname) ? match : PLACEHOLDER;
    } catch {
      return PLACEHOLDER;
    }
  });
}

export function sanitizeEvidenceList(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list.map((item: JsonValue) =>
    typeof item === "string"
      ? sanitizeEvidenceText(item)
      : sanitizeEvidenceText(JSON.stringify(item)),
  );
}

// Mutates the well-known evidence-bearing fields on a worker result.json.
// Covers actions[i].evidence, needs_human, and merge_preflight entries
// (security_evidence / comments_evidence / bot_comments_evidence /
// codex_review.evidence). Unknown fields are left untouched.
export function sanitizeResultEvidence<T extends LooseRecord | null | undefined>(result: T): T {
  if (!result || typeof result !== "object") return result;
  const target = result as LooseRecord;

  if (Array.isArray(target.actions)) {
    for (const action of target.actions) {
      if (action && typeof action === "object" && Array.isArray(action.evidence)) {
        action.evidence = sanitizeEvidenceList(action.evidence);
      }
    }
  }

  if (Array.isArray(target.needs_human)) {
    target.needs_human = sanitizeEvidenceList(target.needs_human);
  }

  if (Array.isArray(target.merge_preflight)) {
    for (const preflight of target.merge_preflight) {
      if (!preflight || typeof preflight !== "object") continue;
      for (const key of ["security_evidence", "comments_evidence", "bot_comments_evidence"]) {
        if (Array.isArray(preflight[key])) {
          preflight[key] = sanitizeEvidenceList(preflight[key]);
        }
      }
      const codexReview = preflight.codex_review;
      if (codexReview && typeof codexReview === "object" && Array.isArray(codexReview.evidence)) {
        codexReview.evidence = sanitizeEvidenceList(codexReview.evidence);
      }
    }
  }

  return result;
}

export const EVIDENCE_URL_PLACEHOLDER = PLACEHOLDER;
