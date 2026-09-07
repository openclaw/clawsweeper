import type { CreateApplyDecisionWorkflowDependencies } from "./clawsweeper-apply-dependencies.js";
import { reportAllowsAutomation } from "./manual-publication-policy.js";
import type {
  AuthorPrBudgetApplyGate,
  CloseReason,
  Item,
  ItemContext,
  PullRequestClosePromotion,
} from "./clawsweeper-types.js";

type ApplyPullRequestPromotionDependencies = Pick<
  CreateApplyDecisionWorkflowDependencies,
  | "authorPrBudgetAgeSkipReason"
  | "authorPrBudgetCloseEnabled"
  | "authorPrBudgetPromotion"
  | "authorPrBudgetSignalBlockReason"
  | "closeReasonEnabled"
  | "itemSnapshotHash"
  | "livePullRequestHasNoDiff"
  | "pullRequestClosePromotion"
  | "reviewReportCanPromoteToClose"
  | "upgradeNoDiffPullRequestReport"
  | "upgradePullRequestClosePromotionReport"
>;

interface ApplyPullRequestPromotionOptions {
  action: string | undefined;
  applyCloseReasons: ReadonlySet<CloseReason> | null;
  closedDir: string;
  closeReason: CloseReason | undefined;
  currentAuthorPrBudgetApplyGate: () => AuthorPrBudgetApplyGate;
  currentItemContext: () => ItemContext;
  decision: string | undefined;
  isCloseProposal: boolean;
  item: Item;
  itemsDir: string;
  markdown: string;
  resetCoverageProof: () => void;
  staleMinAgeDays: number;
  state: string;
  storedHash: string | undefined;
  storedUpdatedAt: string | undefined;
}

export function promoteApplyPullRequest(
  dependencies: ApplyPullRequestPromotionDependencies,
  options: ApplyPullRequestPromotionOptions,
) {
  const {
    authorPrBudgetAgeSkipReason,
    authorPrBudgetCloseEnabled,
    authorPrBudgetPromotion,
    authorPrBudgetSignalBlockReason,
    closeReasonEnabled,
    itemSnapshotHash,
    livePullRequestHasNoDiff,
    pullRequestClosePromotion,
    reviewReportCanPromoteToClose,
    upgradeNoDiffPullRequestReport,
    upgradePullRequestClosePromotionReport,
  } = dependencies;
  const {
    action,
    applyCloseReasons,
    closedDir,
    currentAuthorPrBudgetApplyGate,
    currentItemContext,
    decision,
    item,
    itemsDir,
    resetCoverageProof,
    staleMinAgeDays,
    state,
  } = options;
  let { closeReason, isCloseProposal, markdown, storedHash, storedUpdatedAt } = options;
  const eligible =
    reportAllowsAutomation(markdown) &&
    state === "open" &&
    !isCloseProposal &&
    item.kind === "pull_request" &&
    decision === "keep_open" &&
    action === "kept_open";
  if (!eligible) {
    return {
      attempted: false,
      closeReason,
      isCloseProposal,
      markdown,
      storedHash,
      storedUpdatedAt,
    };
  }

  const noDiff = Boolean(
    storedUpdatedAt &&
    item.updatedAt === storedUpdatedAt &&
    livePullRequestHasNoDiff(currentItemContext()) &&
    reviewReportCanPromoteToClose(markdown),
  );
  if (noDiff) {
    if (closeReasonEnabled("duplicate_or_superseded", applyCloseReasons)) {
      markdown = upgradeNoDiffPullRequestReport(markdown, item);
      closeReason = "duplicate_or_superseded";
      isCloseProposal = true;
      resetCoverageProof();
    }
    return { attempted: true, closeReason, isCloseProposal, markdown, storedHash, storedUpdatedAt };
  }

  const context = currentItemContext();
  let promotion: PullRequestClosePromotion | null = null;
  if (
    authorPrBudgetCloseEnabled() &&
    closeReasonEnabled("author_pr_budget_exceeded", applyCloseReasons) &&
    !authorPrBudgetAgeSkipReason(item) &&
    !authorPrBudgetSignalBlockReason(markdown)
  ) {
    const gate = currentAuthorPrBudgetApplyGate();
    if (gate.allowed) promotion = authorPrBudgetPromotion(markdown, gate.state);
  }
  promotion ??= pullRequestClosePromotion(markdown, item, context, staleMinAgeDays, {
    reportDirs: [itemsDir, closedDir],
  });
  if (promotion && closeReasonEnabled(promotion.closeReason, applyCloseReasons)) {
    markdown = upgradePullRequestClosePromotionReport(markdown, item, context, promotion);
    storedUpdatedAt = item.updatedAt;
    storedHash = itemSnapshotHash(item, context);
    closeReason = promotion.closeReason;
    isCloseProposal = true;
    resetCoverageProof();
  }
  return { attempted: true, closeReason, isCloseProposal, markdown, storedHash, storedUpdatedAt };
}
