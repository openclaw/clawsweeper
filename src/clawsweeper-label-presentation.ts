import { basename, join } from "node:path";
import {
  FEATURE_SHOWCASE_LABEL,
  FEATURE_SHOWCASE_LABEL_DESCRIPTION,
  IMPACT_LABEL_NAMES,
  MATURITY_LABEL_NAMES,
  MERGE_RISK_LABEL_NAMES,
  PR_RATING_LABEL_NAMES,
  PR_STATUS_LABEL_NAMES,
  PRIORITY_LABEL_NAMES,
  PROOF_MEDIA_LABEL_NAMES,
  PROOF_MEDIA_LABELS,
  PROOF_SUFFICIENT_LABEL,
  PROOF_SUFFICIENT_LABEL_DESCRIPTION,
  TELEGRAM_VISIBLE_PROOF_LABEL,
  TELEGRAM_VISIBLE_PROOF_LABEL_DESCRIPTION,
} from "./clawsweeper-policy.js";
import { nextPrRatingLabels, ratingLabelForTier, themedRatingName } from "./clawsweeper-rating.js";
import type {
  LabelJustification,
  LabelTransitionJustification,
  ReviewCommentRenderOptions,
} from "./clawsweeper-types.js";
import type { CreateReportOrchestrationDependencies } from "./clawsweeper-report-orchestration-dependencies.js";
import type { createReportOrchestrationFoundation } from "./clawsweeper-orchestration-foundation.js";

export function createReportLabelPresentation(
  dependencies: CreateReportOrchestrationDependencies &
    ReturnType<typeof createReportOrchestrationFoundation>,
) {
  const {
    defaultPlansDir,
    effectiveReviewStatus,
    frontMatterStringArray,
    frontMatterValue,
    impactLabelsFromReport,
    isFresh,
    isIssueAdvisoryLabel,
    issueAdvisoryLabelStateFromReport,
    labelJustificationsFromReport,
    maturityLabelsFromReport,
    mergeRiskLabelsFromReport,
    nextFeatureShowcaseLabels,
    nextImpactLabels,
    nextIssueAdvisoryLabels,
    nextMaturityLabels,
    nextMergeRiskLabels,
    nextPrStatusLabels,
    nextPriorityLabels,
    nextRealBehaviorProofMediaLabels,
    nextRealBehaviorProofSufficientLabels,
    nextTelegramVisibleProofLabels,
    prStatusLabelForKind,
    prStatusLabelKindFromReportLabels,
    publicRealBehaviorProofLine,
    reportFeatureShowcase,
    reportOverallCorrectness,
    reportPrRating,
    reportRealBehaviorProof,
    reportSecurityReview,
    reportTelegramVisibleProof,
    sentence,
    shouldApplyFeatureShowcaseLabel,
    triagePriorityFromReport,
  } = dependencies;

  function workPlanPathForReport(file: string, plansDir = defaultPlansDir()): string {
    return join(plansDir, basename(file));
  }

  function shouldRenderWorkPlanFromReport(markdown: string): boolean {
    return (
      frontMatterValue(markdown, "decision") === "keep_open" &&
      frontMatterValue(markdown, "action_taken") === "kept_open" &&
      frontMatterValue(markdown, "work_candidate") === "queue_fix_pr" &&
      frontMatterValue(markdown, "work_status") === "candidate" &&
      isFresh({
        reviewedAt: frontMatterValue(markdown, "reviewed_at"),
        reviewStatus: effectiveReviewStatus(markdown),
      })
    );
  }

  function formattedMarkdownList(
    values: readonly string[],
    formatter: (value: string) => string,
  ): string {
    return values.length ? values.map((value) => `- ${formatter(value)}`).join("\n") : "- none";
  }

  function labelJustificationsMarkdown(justifications: readonly LabelJustification[]): string {
    if (!justifications.length) return "- none";
    return justifications
      .map((entry) => `- ${inlineCode(entry.label)}: ${entry.reason}`)
      .join("\n");
  }

  function labelTransitionJustificationsMarkdown(
    justifications: readonly LabelTransitionJustification[],
  ): string {
    if (!justifications.length) return "- none";
    return justifications
      .map((entry) => `- ${entry.action} ${inlineCode(entry.label)}: ${entry.reason}`)
      .join("\n");
  }

  function labelJustificationsMarkdownForTest(
    justifications: readonly LabelJustification[],
  ): string {
    return labelJustificationsMarkdown(justifications);
  }

  function isClawSweeperOwnedLabel(label: string): boolean {
    return (
      PRIORITY_LABEL_NAMES.has(label) ||
      IMPACT_LABEL_NAMES.has(label) ||
      MERGE_RISK_LABEL_NAMES.has(label) ||
      MATURITY_LABEL_NAMES.has(label) ||
      PR_RATING_LABEL_NAMES.has(label) ||
      PR_STATUS_LABEL_NAMES.has(label) ||
      label === FEATURE_SHOWCASE_LABEL ||
      label === PROOF_SUFFICIENT_LABEL ||
      PROOF_MEDIA_LABEL_NAMES.has(label) ||
      label === TELEGRAM_VISIBLE_PROOF_LABEL ||
      isIssueAdvisoryLabel(label)
    );
  }

  function desiredClawSweeperLabelsFromPublicReport(
    markdown: string,
    currentLabels: readonly string[],
    options: ReviewCommentRenderOptions = {},
  ): string[] {
    const isPullRequest = frontMatterValue(markdown, "type") === "pull_request";
    const reviewFailed = frontMatterValue(markdown, "review_status") === "failed";
    let labels = nextPriorityLabels(currentLabels, triagePriorityFromReport(markdown));
    labels = nextImpactLabels(labels, isPullRequest ? [] : impactLabelsFromReport(markdown));
    labels = nextMaturityLabels(labels, isPullRequest ? [] : maturityLabelsFromReport(markdown));
    if (isPullRequest) {
      const realBehaviorProof = reportRealBehaviorProof(markdown);
      labels = nextMergeRiskLabels(labels, mergeRiskLabelsFromReport(markdown));
      labels = nextRealBehaviorProofSufficientLabels(labels, realBehaviorProof);
      labels = nextRealBehaviorProofMediaLabels(labels, realBehaviorProof);
      labels = nextPrRatingLabels(labels, reportPrRating(markdown), reviewFailed);
      labels = nextFeatureShowcaseLabels(labels, {
        isPullRequest,
        itemCategory: frontMatterValue(markdown, "item_category"),
        requiresNewFeature: frontMatterValue(markdown, "requires_new_feature") === "true",
        showcase: reportFeatureShowcase(markdown),
        securityReview: reportSecurityReview(markdown),
        overallCorrectness: reportOverallCorrectness(markdown),
      });
      labels = nextPrStatusLabels(
        labels,
        options.prStatusKind ?? prStatusLabelKindFromReportLabels(markdown),
      );
      labels = nextTelegramVisibleProofLabels(labels, reportTelegramVisibleProof(markdown));
    } else {
      const issueOptions: { hasOpenLinkedPullRequest?: boolean } = {};
      if (options.hasOpenLinkedPullRequest !== undefined) {
        issueOptions.hasOpenLinkedPullRequest = options.hasOpenLinkedPullRequest;
      }
      labels = nextIssueAdvisoryLabels(
        labels,
        issueAdvisoryLabelStateFromReport(markdown, issueOptions),
      );
    }
    return labels;
  }

  function labelTransitionReason(
    markdown: string,
    label: string,
    action: LabelTransitionJustification["action"],
    finalJustifications: ReadonlyMap<string, string>,
    options: ReviewCommentRenderOptions = {},
  ): string {
    const isPullRequest = frontMatterValue(markdown, "type") === "pull_request";
    const realBehaviorProof = reportRealBehaviorProof(markdown);
    if (action === "add") {
      const finalReason = finalJustifications.get(label);
      if (finalReason) return finalReason;
    }
    if (PRIORITY_LABEL_NAMES.has(label)) {
      const priority = triagePriorityFromReport(markdown);
      return action === "add"
        ? `Current review triage priority is ${priority}.`
        : priority === "none"
          ? "Current review triage priority is none."
          : `Current review triage priority is ${priority}, so this older priority label is no longer current.`;
    }
    if (IMPACT_LABEL_NAMES.has(label)) {
      const labels = impactLabelsFromReport(markdown);
      return action === "add"
        ? "Current review selected this impact label."
        : labels.length
          ? `Current review impact labels are ${labels.map(inlineCode).join(", ")}.`
          : "Current review selected no impact labels.";
    }
    if (MERGE_RISK_LABEL_NAMES.has(label)) {
      const labels = mergeRiskLabelsFromReport(markdown);
      return action === "add"
        ? "Current PR review selected this merge-risk label."
        : labels.length
          ? `Current PR review merge-risk labels are ${labels.map(inlineCode).join(", ")}.`
          : "Current PR review selected no merge-risk labels.";
    }
    if (MATURITY_LABEL_NAMES.has(label)) {
      const labels = maturityLabelsFromReport(markdown);
      return action === "add"
        ? "Current issue review matched this item to a stable maturity scorecard feature."
        : labels.length
          ? `Current issue maturity labels are ${labels.map(inlineCode).join(", ")}.`
          : "Current issue review selected no maturity labels.";
    }
    if (PR_RATING_LABEL_NAMES.has(label)) {
      if (frontMatterValue(markdown, "review_status") === "failed") {
        return action === "add"
          ? "Failed reviews do not select PR readiness rating labels."
          : "Current review failed before PR readiness was assessed, so no rating label should remain.";
      }
      const rating = reportPrRating(markdown);
      const current = ratingLabelForTier(rating.overallTier).name;
      return action === "add"
        ? `Overall readiness is ${themedRatingName(rating.overallTier)}.`
        : `Current PR rating is ${inlineCode(current)}, so this older rating label is no longer current.`;
    }
    if (PR_STATUS_LABEL_NAMES.has(label)) {
      const statusKind = options.prStatusKind ?? prStatusLabelKindFromReportLabels(markdown);
      return action === "add" && statusKind
        ? prStatusLabelForKind(statusKind).description
        : statusKind
          ? `Current PR status label is ${inlineCode(prStatusLabelForKind(statusKind).name)}.`
          : "Current PR status no longer selects a status label.";
    }
    if (label === FEATURE_SHOWCASE_LABEL) {
      const showcase = reportFeatureShowcase(markdown);
      return action === "add"
        ? `${FEATURE_SHOWCASE_LABEL_DESCRIPTION} ${sentence(showcase.reason)}`
        : "Feature showcase labels are add-only; this label is no longer selected by the current review.";
    }
    if (label === PROOF_SUFFICIENT_LABEL) {
      return action === "add"
        ? `${PROOF_SUFFICIENT_LABEL_DESCRIPTION} ${sentence(realBehaviorProof.summary)}`
        : `Current real behavior proof status is ${realBehaviorProof.status}, not sufficient.`;
    }
    if (PROOF_MEDIA_LABEL_NAMES.has(label)) {
      const mediaLabel = PROOF_MEDIA_LABELS.find(
        (candidate) => candidate.evidenceKind === realBehaviorProof.evidenceKind,
      );
      return action === "add" && mediaLabel
        ? `${mediaLabel.description} ${sentence(realBehaviorProof.summary)}`
        : `Current real behavior proof evidence kind is ${realBehaviorProof.evidenceKind}.`;
    }
    if (label === TELEGRAM_VISIBLE_PROOF_LABEL) {
      const proof = reportTelegramVisibleProof(markdown);
      return action === "add"
        ? `${TELEGRAM_VISIBLE_PROOF_LABEL_DESCRIPTION} ${sentence(proof.summary)}`
        : `Current Telegram visible-proof status is ${proof.status}.`;
    }
    if (isIssueAdvisoryLabel(label)) {
      return isPullRequest
        ? "This advisory label applies only to issues, not pull requests."
        : action === "add"
          ? "Current issue advisory state selects this label."
          : "Current issue advisory state no longer selects this label.";
    }
    return action === "add"
      ? "Current ClawSweeper review state selects this label."
      : "Current ClawSweeper review state no longer selects this label.";
  }

  function labelTransitionJustificationsFromPublicReport(
    markdown: string,
    finalJustifications: readonly LabelJustification[],
    options: ReviewCommentRenderOptions = {},
  ): LabelTransitionJustification[] {
    const currentLabels = options.previousLabels ?? frontMatterStringArray(markdown, "labels");
    const desiredLabels =
      options.publishedLabels ??
      desiredClawSweeperLabelsFromPublicReport(markdown, currentLabels, options);
    const currentKeys = new Set(currentLabels.map((label) => label.toLowerCase()));
    const desiredKeys = new Set(desiredLabels.map((label) => label.toLowerCase()));
    const finalByLabel = new Map(finalJustifications.map((entry) => [entry.label, entry.reason]));
    const transitions: LabelTransitionJustification[] = [];
    for (const label of desiredLabels) {
      if (!isClawSweeperOwnedLabel(label) || currentKeys.has(label.toLowerCase())) continue;
      transitions.push({
        action: "add",
        label,
        reason: labelTransitionReason(markdown, label, "add", finalByLabel, options),
      });
    }
    for (const label of currentLabels) {
      if (!isClawSweeperOwnedLabel(label) || desiredKeys.has(label.toLowerCase())) continue;
      transitions.push({
        action: "remove",
        label,
        reason: labelTransitionReason(markdown, label, "remove", finalByLabel, options),
      });
    }
    return transitions;
  }

  function labelJustificationsFromPublicReport(
    markdown: string,
    options: ReviewCommentRenderOptions = {},
  ): LabelJustification[] {
    const justifications = labelJustificationsFromReport(markdown, {
      triagePriority: triagePriorityFromReport(markdown),
      impactLabels: impactLabelsFromReport(markdown),
      mergeRiskLabels: mergeRiskLabelsFromReport(markdown),
      maturityLabels: maturityLabelsFromReport(markdown),
    });
    const byLabel = new Map(justifications.map((entry) => [entry.label, entry]));
    const add = (label: string | null | undefined, reason: string): void => {
      if (!label || byLabel.has(label)) return;
      byLabel.set(label, { label, reason });
    };
    const isPullRequest = frontMatterValue(markdown, "type") === "pull_request";
    const realBehaviorProof = reportRealBehaviorProof(markdown);
    if (isPullRequest && frontMatterValue(markdown, "review_status") !== "failed") {
      const rating = reportPrRating(markdown);
      const ratingLabel = ratingLabelForTier(rating.overallTier).name;
      const previousRatingLabel = frontMatterStringArray(markdown, "labels").find(
        (label) => PR_RATING_LABEL_NAMES.has(label) && label !== ratingLabel,
      );
      const changed = previousRatingLabel
        ? ` Replaced prior ${inlineCode(previousRatingLabel)}.`
        : "";
      add(
        ratingLabel,
        `Overall readiness is ${themedRatingName(rating.overallTier)}; proof is ${themedRatingName(
          rating.proofTier,
        )} and patch quality is ${themedRatingName(rating.patchTier)}.${changed}`,
      );
      const featureShowcase = reportFeatureShowcase(markdown);
      if (
        shouldApplyFeatureShowcaseLabel({
          isPullRequest,
          itemCategory: frontMatterValue(markdown, "item_category"),
          requiresNewFeature: frontMatterValue(markdown, "requires_new_feature") === "true",
          showcase: featureShowcase,
          securityReview: reportSecurityReview(markdown),
          overallCorrectness: reportOverallCorrectness(markdown),
        })
      ) {
        add(
          FEATURE_SHOWCASE_LABEL,
          `${FEATURE_SHOWCASE_LABEL_DESCRIPTION} ${sentence(featureShowcase.reason)}`,
        );
      }
      const statusKind = options.prStatusKind ?? prStatusLabelKindFromReportLabels(markdown);
      if (statusKind) {
        add(
          prStatusLabelForKind(statusKind).name,
          `${prStatusLabelForKind(statusKind).description} ${publicRealBehaviorProofLine(
            realBehaviorProof,
          )}`,
        );
      }
      if (realBehaviorProof.status === "sufficient") {
        add(
          PROOF_SUFFICIENT_LABEL,
          `${PROOF_SUFFICIENT_LABEL_DESCRIPTION} ${sentence(realBehaviorProof.summary)}`,
        );
      }
      const proofMediaLabel = PROOF_MEDIA_LABELS.find(
        (label) => label.evidenceKind === realBehaviorProof.evidenceKind,
      );
      if (proofMediaLabel) {
        add(
          proofMediaLabel.name,
          `${proofMediaLabel.description} ${sentence(realBehaviorProof.summary)}`,
        );
      }
      const telegramProof = reportTelegramVisibleProof(markdown);
      if (telegramProof.status === "needed") {
        add(
          TELEGRAM_VISIBLE_PROOF_LABEL,
          `${TELEGRAM_VISIBLE_PROOF_LABEL_DESCRIPTION} ${sentence(telegramProof.summary)}`,
        );
      }
    }
    return [...byLabel.values()];
  }

  function inlineCode(value: string): string {
    return `\`${value.replaceAll("`", "\\`")}\``;
  }

  return {
    workPlanPathForReport,
    shouldRenderWorkPlanFromReport,
    formattedMarkdownList,
    labelJustificationsMarkdown,
    labelTransitionJustificationsMarkdown,
    labelJustificationsMarkdownForTest,
    isClawSweeperOwnedLabel,
    desiredClawSweeperLabelsFromPublicReport,
    labelTransitionReason,
    labelTransitionJustificationsFromPublicReport,
    labelJustificationsFromPublicReport,
    inlineCode,
  };
}
