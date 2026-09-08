import type { LabelSynchronizationDependencies } from "./clawsweeper-label-dependencies.js";
import { createLabelSelectionPolicy } from "./clawsweeper-label-selection.js";
import { createLabelMutationOperations } from "./clawsweeper-label-mutations.js";
import { createLabelSyncOperations } from "./clawsweeper-label-operations.js";

export function createLabelSynchronization(dependencies: LabelSynchronizationDependencies) {
  const selection = createLabelSelectionPolicy({ ...dependencies });
  const mutations = createLabelMutationOperations({ ...dependencies, ...selection });
  const operations = createLabelSyncOperations({ ...dependencies, ...selection, ...mutations });
  const tools = { ...selection, ...mutations, ...operations };
  return {
    impactLabelSchemeForTest: tools.impactLabelSchemeForTest,
    impactLabelsForTest: tools.impactLabelsForTest,
    isGitHubLabelAlreadyExistsErrorForTest: tools.isGitHubLabelAlreadyExistsErrorForTest,
    isGitHubLabelCapacityErrorForTest: tools.isGitHubLabelCapacityErrorForTest,
    isMissingGitHubLabelErrorForTest: tools.isMissingGitHubLabelErrorForTest,
    issueAdvisoryLabelsForTest: tools.issueAdvisoryLabelsForTest,
    maturityLabelSchemeForTest: tools.maturityLabelSchemeForTest,
    maturityLabelsForTest: tools.maturityLabelsForTest,
    mergeRiskLabelSchemeForTest: tools.mergeRiskLabelSchemeForTest,
    mergeRiskLabelsForTest: tools.mergeRiskLabelsForTest,
    priorityLabelSchemeForTest: tools.priorityLabelSchemeForTest,
    priorityLabelsForTest: tools.priorityLabelsForTest,
    prRatingLabelSchemeForTest: tools.prRatingLabelSchemeForTest,
    prRatingLabelsForTest: tools.prRatingLabelsForTest,
    realBehaviorProofMediaLabelsForTest: tools.realBehaviorProofMediaLabelsForTest,
    realBehaviorProofSufficientLabelsForTest: tools.realBehaviorProofSufficientLabelsForTest,
    syncBulkFilerLabelForTest: tools.syncBulkFilerLabelForTest,
    telegramVisibleProofLabelsForTest: tools.telegramVisibleProofLabelsForTest,
    beginIssueLabelMutationBatch: tools.beginIssueLabelMutationBatch,
    discardIssueLabelMutationBatch: tools.discardIssueLabelMutationBatch,
    flushIssueLabelMutationBatch: tools.flushIssueLabelMutationBatch,
    addIssueLabel: tools.addIssueLabel,
    ensureIdeaArchiveLabel: tools.ensureIdeaArchiveLabel,
    isGoodFirstIssue: tools.isGoodFirstIssue,
    isIssueAdvisoryLabel: tools.isIssueAdvisoryLabel,
    issueAdvisoryLabelStateFromReport: tools.issueAdvisoryLabelStateFromReport,
    labelAlreadyExistsError: tools.labelAlreadyExistsError,
    nextImpactLabels: tools.nextImpactLabels,
    nextIssueAdvisoryLabels: tools.nextIssueAdvisoryLabels,
    nextMaturityLabels: tools.nextMaturityLabels,
    nextMergeRiskLabels: tools.nextMergeRiskLabels,
    nextPriorityLabels: tools.nextPriorityLabels,
    nextRealBehaviorProofMediaLabels: tools.nextRealBehaviorProofMediaLabels,
    nextRealBehaviorProofSufficientLabels: tools.nextRealBehaviorProofSufficientLabels,
    nextTelegramVisibleProofLabels: tools.nextTelegramVisibleProofLabels,
    removeIssueLabel: tools.removeIssueLabel,
    syncBulkFilerLabel: tools.syncBulkFilerLabel,
    syncFeatureShowcaseLabel: tools.syncFeatureShowcaseLabel,
    syncImpactLabels: tools.syncImpactLabels,
    syncIssueAdvisoryLabels: tools.syncIssueAdvisoryLabels,
    syncMaturityLabels: tools.syncMaturityLabels,
    syncMergeRiskLabels: tools.syncMergeRiskLabels,
    syncPriorityLabel: tools.syncPriorityLabel,
    syncPrRatingLabel: tools.syncPrRatingLabel,
    syncPrStatusLabel: tools.syncPrStatusLabel,
    syncRealBehaviorProofMediaLabels: tools.syncRealBehaviorProofMediaLabels,
    syncRealBehaviorProofSufficientLabel: tools.syncRealBehaviorProofSufficientLabel,
    syncTelegramVisibleProofLabel: tools.syncTelegramVisibleProofLabel,
  };
}
