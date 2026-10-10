import {
  applyBlockingProtectedLabels,
  isAutomationReportAuthor,
  isMaintainerAuthorAssociation,
  isProtectedItem,
} from "./clawsweeper-item-policy.js";
import {
  evaluateOversizedPullRequest,
  maxPrChangedLines,
} from "./clawsweeper-oversized-pr-policy.js";
import {
  ABANDONED_PR_MIN_AGE_DAYS,
  DAY_MS,
  OBSOLETE_FIX_PR_MIN_AGE_DAYS,
  STALE_INSUFFICIENT_INFO_MIN_AGE_DAYS,
  STALE_VERSION_BUG_MIN_AGE_DAYS,
  STALLED_UNPROVEN_PR_MIN_AGE_DAYS,
  UNCONFIRMED_PRODUCT_DIRECTION_MIN_AGE_DAYS,
  UNSPONSORED_FEATURE_MIN_AGE_DAYS,
} from "./clawsweeper-policy.js";
import type { Item, ItemContext, ReviewPromptRuntimeHints } from "./clawsweeper-types.js";
import type { RepositoryCloseReason } from "./repository-profiles.js";
import { asRecord } from "./value-coerce.js";

export type ReviewPromptSection =
  | "follow_up"
  | "media"
  | "maintainer_author"
  | "external_author"
  | "authority_chain";

/** Semantic authority changes stay model-assessed: even Markdown can be a runtime template. */
export function reviewPromptSections(
  item: Item,
  context: ItemContext,
  hints: ReviewPromptRuntimeHints = {},
): Record<ReviewPromptSection, boolean> {
  const maintainer = isMaintainerAuthorAssociation(item.authorAssociation);
  return {
    follow_up: item.kind === "pull_request" && context.previousClawSweeperReview != null,
    media: Boolean(hints.mediaProofSummary?.trim() && hints.mediaProofManifestPath?.trim()),
    maintainer_author: maintainer,
    external_author: !maintainer && !isAutomationReportAuthor(item.author),
    authority_chain: item.kind === "pull_request",
  };
}

/** Markers are template syntax, never a classifier for model output or GitHub prose. */
export function renderReviewSections(
  template: string,
  sections: Readonly<Record<ReviewPromptSection, boolean>>,
): string {
  const lines: string[] = [];
  let include = true;
  let active: ReviewPromptSection | undefined;
  for (const line of template.split(/\r?\n/)) {
    if (line.startsWith("<!-- review-section: ") && line.endsWith(" -->")) {
      if (active !== undefined) throw new Error("Nested review prompt section");
      const name = line.slice("<!-- review-section: ".length, -" -->".length);
      if (!Object.hasOwn(sections, name)) throw new Error(`Unknown review prompt section: ${name}`);
      active = name as ReviewPromptSection;
      include = sections[active];
    } else if (line === "<!-- /review-section -->") {
      if (active === undefined) throw new Error("Unopened review prompt section");
      active = undefined;
      include = true;
    } else if (include) {
      lines.push(line);
    }
  }
  if (active !== undefined) throw new Error(`Unclosed review prompt section: ${active}`);
  return lines.join("\n");
}

const minimumAgeDays: Partial<Record<RepositoryCloseReason, number>> = {
  mostly_implemented_on_main: STALE_INSUFFICIENT_INFO_MIN_AGE_DAYS,
  stalled_unproven_pr: STALLED_UNPROVEN_PR_MIN_AGE_DAYS,
  abandoned_pr: ABANDONED_PR_MIN_AGE_DAYS,
  unconfirmed_product_direction: UNCONFIRMED_PRODUCT_DIRECTION_MIN_AGE_DAYS,
  unsponsored_feature_request: UNSPONSORED_FEATURE_MIN_AGE_DAYS,
  stale_version_bug: STALE_VERSION_BUG_MIN_AGE_DAYS,
  obsolete_fix_pr: OBSOLETE_FIX_PR_MIN_AGE_DAYS,
  stale_insufficient_info: STALE_INSUFFICIENT_INFO_MIN_AGE_DAYS,
};
const issueReasons: Partial<Record<RepositoryCloseReason, true>> = {
  unsponsored_feature_request: true,
  stale_version_bug: true,
  stale_insufficient_info: true,
};
const pullRequestReasons: Partial<Record<RepositoryCloseReason, true>> = {
  mostly_implemented_on_main: true,
  low_signal_unmergeable_pr: true,
  oversized_pull_request: true,
  stalled_unproven_pr: true,
  abandoned_pr: true,
  unconfirmed_product_direction: true,
  author_pr_budget_exceeded: true,
  obsolete_fix_pr: true,
};

/** Filter only impossibilities established by host facts; the model still judges each live rule. */
export function applicableCloseReasons(
  item: Item,
  context: ItemContext,
  reasons: readonly RepositoryCloseReason[],
  now = Date.now(),
): RepositoryCloseReason[] {
  const guarded = isMaintainerAuthorAssociation(item.authorAssociation) || isProtectedItem(item);
  const pull = asRecord(context.pullRequest);
  const age = (now - Date.parse(item.createdAt)) / DAY_MS;
  return reasons.filter((reason) => {
    if (reason === "none" || reason === "author_pr_budget_exceeded") return false;
    if (item.kind === "issue" ? pullRequestReasons[reason] : issueReasons[reason]) return false;
    if (reason === "oversized_pull_request") {
      if (applyBlockingProtectedLabels(item.labels, reason).length > 0) return false;
      return !evaluateOversizedPullRequest({
        additions: pull.additions,
        deletions: pull.deletions,
        changedFiles: pull.changedFiles ?? pull.changed_files,
        head: asRecord(pull.head).sha,
        labels: item.labels,
        threshold: maxPrChangedLines(),
      }).admitted;
    }
    if (guarded) return false;
    const minimum = minimumAgeDays[reason];
    return minimum === undefined || !Number.isFinite(age) || age > minimum;
  });
}
