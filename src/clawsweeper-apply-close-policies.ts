import type { CreateApplyDecisionWorkflowDependencies } from "./clawsweeper-apply-dependencies.js";
import { STALE_INSUFFICIENT_INFO_MIN_INACTIVE_DAYS } from "./clawsweeper-policy.js";
import type { ApplyKind, AuthorPrBudgetApplyGate, CloseReason, Item } from "./clawsweeper-types.js";
import { repositoryManagedPullRequestCloseReason } from "./repository-profiles.js";

type ApplyClosePolicyDependencies = Pick<
  CreateApplyDecisionWorkflowDependencies,
  | "abandonedPrApplyBlockReasonSafe"
  | "applyAuthorPrBudgetStateToReport"
  | "closeReasonEnabled"
  | "frontMatterValue"
  | "ghJson"
  | "issueRecentHumanCommentBlockReasonSafe"
  | "stalledUnprovenPrApplyBlockReasonSafe"
  | "unconfirmedProductDirectionApplyBlockReasonSafe"
  | "unconfirmedProductDirectionCloseEnabled"
  | "unsponsoredFeatureApplyBlockReasonSafe"
  | "unsponsoredFeatureCloseEnabled"
>;

interface ApplyClosePolicyOptions {
  applyCloseReasons: ReadonlySet<CloseReason> | null;
  applyKind: ApplyKind;
  closeReason: CloseReason | undefined;
  currentAuthorPrBudgetApplyGate: () => AuthorPrBudgetApplyGate;
  currentObsoleteFixPrBlockReason: () => string | null;
  currentStaleVersionBugBlockReason: () => string | null;
  isCloseProposal: boolean;
  item: Item;
  markdown: string;
  number: number;
  phase: "before-canonical" | "after-canonical";
  state: string;
  storedUpdatedAt: string | undefined;
  syncCommentsOnly: boolean;
}

export function evaluateApplyClosePolicy(
  dependencies: ApplyClosePolicyDependencies,
  options: ApplyClosePolicyOptions,
): {
  block: { reason: string; preserveOriginalAction: boolean } | null;
  markdown: string;
} {
  const {
    abandonedPrApplyBlockReasonSafe,
    applyAuthorPrBudgetStateToReport,
    closeReasonEnabled,
    frontMatterValue,
    issueRecentHumanCommentBlockReasonSafe,
    stalledUnprovenPrApplyBlockReasonSafe,
    unconfirmedProductDirectionApplyBlockReasonSafe,
    unconfirmedProductDirectionCloseEnabled,
    unsponsoredFeatureApplyBlockReasonSafe,
    unsponsoredFeatureCloseEnabled,
  } = dependencies;
  const {
    applyCloseReasons,
    applyKind,
    closeReason,
    currentAuthorPrBudgetApplyGate,
    currentObsoleteFixPrBlockReason,
    currentStaleVersionBugBlockReason,
    isCloseProposal,
    item,
    number,
    phase,
    state,
    storedUpdatedAt,
    syncCommentsOnly,
  } = options;
  let { markdown } = options;
  const blocked = (reason: string, preserveOriginalAction = false) => ({
    block: { reason, preserveOriginalAction },
    markdown,
  });
  const allowed = () => ({ block: null, markdown });

  if (
    state !== "open" ||
    !isCloseProposal ||
    !closeReason ||
    syncCommentsOnly ||
    (applyKind !== "all" && item.kind !== applyKind) ||
    !closeReasonEnabled(closeReason, applyCloseReasons)
  ) {
    return allowed();
  }

  const managedPullRequestReason = repositoryManagedPullRequestCloseReason(item, () =>
    dependencies.ghJson(["api", `repos/${item.repo}/pulls/${item.number}`]),
  );
  if (managedPullRequestReason) return blocked(managedPullRequestReason);

  if (phase === "before-canonical") {
    switch (closeReason) {
      case "author_pr_budget_exceeded": {
        const gate = currentAuthorPrBudgetApplyGate();
        if (!gate.allowed) return blocked(gate.reason);
        markdown = applyAuthorPrBudgetStateToReport(markdown, gate.state);
        return allowed();
      }
      case "unsponsored_feature_request": {
        if (!unsponsoredFeatureCloseEnabled()) {
          return blocked("unsponsored feature-request apply policy is disabled", true);
        }
        const reason = unsponsoredFeatureApplyBlockReasonSafe(number, item);
        return reason ? blocked(reason) : allowed();
      }
      case "stale_version_bug": {
        const reason = currentStaleVersionBugBlockReason();
        return reason ? blocked(reason) : allowed();
      }
      case "obsolete_fix_pr": {
        const reason = currentObsoleteFixPrBlockReason();
        return reason ? blocked(reason) : allowed();
      }
      case "stale_insufficient_info": {
        const reason = issueRecentHumanCommentBlockReasonSafe(
          number,
          STALE_INSUFFICIENT_INFO_MIN_INACTIVE_DAYS,
        );
        return reason ? blocked(reason) : allowed();
      }
      default:
        return allowed();
    }
  }

  switch (closeReason) {
    case "unconfirmed_product_direction": {
      if (!unconfirmedProductDirectionCloseEnabled()) {
        return blocked("unconfirmed product-direction apply policy is disabled", true);
      }
      const reason = unconfirmedProductDirectionApplyBlockReasonSafe(
        number,
        item,
        storedUpdatedAt,
        frontMatterValue(markdown, "reviewed_at"),
      );
      return reason ? blocked(reason) : allowed();
    }
    case "stalled_unproven_pr": {
      const reason = stalledUnprovenPrApplyBlockReasonSafe(number, item);
      return reason ? blocked(reason) : allowed();
    }
    case "abandoned_pr": {
      const reason = abandonedPrApplyBlockReasonSafe(number, item);
      return reason ? blocked(reason) : allowed();
    }
    default:
      return allowed();
  }
}
