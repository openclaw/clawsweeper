import type { CreateApplyDecisionWorkflowDependencies } from "./clawsweeper-apply-dependencies.js";
import { STALE_INSUFFICIENT_INFO_MIN_INACTIVE_DAYS } from "./clawsweeper-policy.js";
import type { ApplyKind, AuthorPrBudgetApplyGate, CloseReason, Item } from "./clawsweeper-types.js";

type ApplyClosePolicyDependencies = Pick<
  CreateApplyDecisionWorkflowDependencies,
  | "abandonedPrApplyBlockReasonSafe"
  | "applyAuthorPrBudgetStateToReport"
  | "closeReasonEnabled"
  | "frontMatterValue"
  | "issueRecentHumanCommentBlockReasonFromComments"
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
  comments?: readonly unknown[];
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

type ApplyCloseReasonPolicyOptions = Omit<
  ApplyClosePolicyOptions,
  "applyCloseReasons" | "applyKind" | "isCloseProposal" | "state" | "syncCommentsOnly"
> & { closeReason: CloseReason };
export function evaluateApplyCloseReasonPolicy(
  dependencies: ApplyClosePolicyDependencies,
  options: ApplyCloseReasonPolicyOptions,
) {
  const blocked = (reason: string, preserveOriginalAction = false) => ({
    authorPrBudgetGate: undefined,
    block: { reason, preserveOriginalAction },
  });
  const allowed = (authorPrBudgetGate?: AuthorPrBudgetApplyGate) => ({
    authorPrBudgetGate,
    block: null,
  });
  const { closeReason, phase } = options;

  if (phase === "before-canonical") {
    switch (closeReason) {
      case "author_pr_budget_exceeded": {
        const gate = options.currentAuthorPrBudgetApplyGate();
        return gate.allowed ? allowed(gate) : blocked(gate.reason);
      }
      case "unsponsored_feature_request": {
        if (!dependencies.unsponsoredFeatureCloseEnabled()) {
          return blocked("unsponsored feature-request apply policy is disabled", true);
        }
        const reason = dependencies.unsponsoredFeatureApplyBlockReasonSafe(
          options.number,
          options.item,
        );
        return reason ? blocked(reason) : allowed();
      }
      case "stale_version_bug": {
        const reason = options.currentStaleVersionBugBlockReason();
        return reason ? blocked(reason) : allowed();
      }
      case "obsolete_fix_pr": {
        const reason = options.currentObsoleteFixPrBlockReason();
        return reason ? blocked(reason) : allowed();
      }
      case "stale_insufficient_info": {
        const reason =
          options.comments === undefined
            ? dependencies.issueRecentHumanCommentBlockReasonSafe(
                options.number,
                STALE_INSUFFICIENT_INFO_MIN_INACTIVE_DAYS,
              )
            : dependencies.issueRecentHumanCommentBlockReasonFromComments(
                options.comments,
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
      if (!dependencies.unconfirmedProductDirectionCloseEnabled()) {
        return blocked("unconfirmed product-direction apply policy is disabled", true);
      }
      const reason = dependencies.unconfirmedProductDirectionApplyBlockReasonSafe(
        options.number,
        options.item,
        options.storedUpdatedAt,
        dependencies.frontMatterValue(options.markdown, "reviewed_at"),
      );
      return reason ? blocked(reason) : allowed();
    }
    case "stalled_unproven_pr": {
      const reason = dependencies.stalledUnprovenPrApplyBlockReasonSafe(
        options.number,
        options.item,
      );
      return reason ? blocked(reason) : allowed();
    }
    case "abandoned_pr": {
      const reason = dependencies.abandonedPrApplyBlockReasonSafe(options.number, options.item);
      return reason ? blocked(reason) : allowed();
    }
    default:
      return allowed();
  }
}

export function evaluateApplyClosePolicy(
  dependencies: ApplyClosePolicyDependencies,
  options: ApplyClosePolicyOptions,
): {
  block: { reason: string; preserveOriginalAction: boolean } | null;
  markdown: string;
} {
  const {
    applyCloseReasons,
    applyKind,
    closeReason,
    isCloseProposal,
    item,
    state,
    syncCommentsOnly,
  } = options;
  let { markdown } = options;
  const allowed = () => ({ block: null, markdown });

  if (
    state !== "open" ||
    !isCloseProposal ||
    !closeReason ||
    syncCommentsOnly ||
    (applyKind !== "all" && item.kind !== applyKind) ||
    !dependencies.closeReasonEnabled(closeReason, applyCloseReasons)
  ) {
    return allowed();
  }

  const policy = evaluateApplyCloseReasonPolicy(dependencies, { ...options, closeReason });
  if (policy.block) return { block: policy.block, markdown };
  if (policy.authorPrBudgetGate?.allowed) {
    markdown = dependencies.applyAuthorPrBudgetStateToReport(
      markdown,
      policy.authorPrBudgetGate.state,
    );
  }
  return allowed();
}
