export const AUTOMERGE_LABEL = "clawsweeper:automerge";
export const AUTOFIX_LABEL = "clawsweeper:autofix";
export const HUMAN_REVIEW_LABEL = "clawsweeper:human-review";
export const MANUAL_ONLY_LABEL = "clawsweeper:manual-only";

export const CLOSE_PROTECTED_LABEL_NAMES = [
  "security",
  "beta-blocker",
  "release-blocker",
  "maintainer",
] as const;

export const PR_AUTO_CLOSE_EXEMPT_LABEL_NAMES = [
  HUMAN_REVIEW_LABEL,
  MANUAL_ONLY_LABEL,
  AUTOMERGE_LABEL,
  AUTOFIX_LABEL,
] as const;

export const EXACT_REVIEW_CLOSE_GUARD_LABELS = [
  ...CLOSE_PROTECTED_LABEL_NAMES,
  ...PR_AUTO_CLOSE_EXEMPT_LABEL_NAMES,
] as const;

const EXACT_REVIEW_CLOSE_GUARD_LABEL_SET = new Set<string>(EXACT_REVIEW_CLOSE_GUARD_LABELS);

export function isExactReviewCloseGuardLabel(value: unknown): boolean {
  return EXACT_REVIEW_CLOSE_GUARD_LABEL_SET.has(
    String(value ?? "")
      .trim()
      .toLowerCase(),
  );
}
