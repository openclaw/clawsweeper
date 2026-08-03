import type { ApplyGuardDependencies } from "./clawsweeper-apply-guard-dependencies.js";
import { createApplyGuardActivity } from "./clawsweeper-apply-guard-activity.js";
import { createApplyGuardPolicy } from "./clawsweeper-apply-guard-policy.js";
import { createApplyGuardProof } from "./clawsweeper-apply-guard-proof.js";
import { createApplyGuardCapacity } from "./clawsweeper-apply-guard-capacity.js";
export { STALLED_UNPROVEN_PROOF_STATUSES } from "./clawsweeper-apply-guard-dependencies.js";

export function createApplyGuards(dependencies: ApplyGuardDependencies) {
  const activity = createApplyGuardActivity({ ...dependencies });
  const policy = createApplyGuardPolicy({ ...dependencies, ...activity });
  const proof = createApplyGuardProof({ ...dependencies, ...activity, ...policy });
  const capacity = createApplyGuardCapacity({ ...dependencies, ...activity, ...policy, ...proof });
  const {
    abandonedPrAgeSkipReason,
    abandonedPrApplyBlockReasonSafe,
    authorPrBudgetApplyGateSafe,
    authorPrBudgetSignalBlockReason,
    issueRecentHumanCommentBlockReasonFromComments,
    issueRecentHumanCommentBlockReasonSafe,
    lowSignalUnmergeablePrApplyBlockReasonSafe,
    lowSignalUnmergeablePrAuthorActivityBlockReason,
    lowSignalUnmergeablePrConflictBlockReason,
    obsoleteFixPrApplyBlockReasonSafe,
    prAutoCloseExemptDecisionReason,
    prAutoCloseExemptLabel,
    pullRequestHeadActivity,
    staleVersionBugApplyBlockReasonSafe,
    stalledUnprovenPrAgeSkipReason,
    stalledUnprovenPrApplyBlockReasonSafe,
    stalledUnprovenProofRequestBlockReason,
    unconfirmedProductDirectionApplyBlockReasonSafe,
    unsponsoredFeatureApplyBlockReasonSafe,
  } = { ...activity, ...policy, ...proof, ...capacity };
  return {
    abandonedPrAgeSkipReason,
    abandonedPrApplyBlockReasonSafe,
    authorPrBudgetApplyGateSafe,
    authorPrBudgetSignalBlockReason,
    issueRecentHumanCommentBlockReasonFromComments,
    issueRecentHumanCommentBlockReasonSafe,
    lowSignalUnmergeablePrApplyBlockReasonSafe,
    lowSignalUnmergeablePrAuthorActivityBlockReason,
    lowSignalUnmergeablePrConflictBlockReason,
    obsoleteFixPrApplyBlockReasonSafe,
    prAutoCloseExemptDecisionReason,
    prAutoCloseExemptLabel,
    pullRequestHeadActivity,
    staleVersionBugApplyBlockReasonSafe,
    stalledUnprovenPrAgeSkipReason,
    stalledUnprovenPrApplyBlockReasonSafe,
    stalledUnprovenProofRequestBlockReason,
    unconfirmedProductDirectionApplyBlockReasonSafe,
    unsponsoredFeatureApplyBlockReasonSafe,
  };
}
