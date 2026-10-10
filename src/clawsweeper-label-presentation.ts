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
import { defaultPlansDir } from "./clawsweeper-repository-paths.js";
import { isFresh } from "./clawsweeper-review-planning-inventory.js";
import { frontMatterStringArray, frontMatterValue } from "./report-front-matter.js";
import { effectiveReviewStatus } from "./clawsweeper-record-metadata.js";
import { reportRealBehaviorProofPolicy } from "./clawsweeper-proof-policy.js";
import { reportReviewDecision, type ReportReviewDecision } from "./report-review-decision.js";
import {
  nextFeatureShowcaseLabels,
  nextPrStatusLabels,
  prStatusLabelForKind,
  shouldApplyFeatureShowcaseLabel,
} from "./clawsweeper-label-policy.js";
import {
  isIssueAdvisoryLabel,
  issueAdvisoryLabelState,
  nextImpactLabels,
  nextIssueAdvisoryLabels,
  nextMaturityLabels,
  nextMergeRiskLabels,
  nextPriorityLabels,
  nextRealBehaviorProofMediaLabels,
  nextRealBehaviorProofSufficientLabels,
  nextTelegramVisibleProofLabels,
} from "./clawsweeper-label-selection.js";
import { prStatusLabelKindFromReportLabels, sentence } from "./clawsweeper-review-presentation.js";

export function isClawSweeperOwnedLabel(label: string): boolean {
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
export function workPlanPathForReport(file: string, plansDir = defaultPlansDir()): string {
  return join(plansDir, basename(file));
}

export function shouldRenderWorkPlanFromReport(markdown: string): boolean {
  const decision = reportReviewDecision(markdown);
  return (
    decision.decision === "keep_open" &&
    frontMatterValue(markdown, "action_taken") === "kept_open" &&
    decision.workCandidate === "queue_fix_pr" &&
    frontMatterValue(markdown, "work_status") === "candidate" &&
    isFresh({
      reviewedAt: frontMatterValue(markdown, "reviewed_at"),
      reviewStatus: effectiveReviewStatus(markdown),
    })
  );
}

export function formattedMarkdownList(
  values: readonly string[],
  formatter: (value: string) => string,
): string {
  return values.length ? values.map((value) => `- ${formatter(value)}`).join("\n") : "- none";
}

export function labelJustificationsMarkdown(justifications: readonly LabelJustification[]): string {
  if (!justifications.length) return "- none";
  return justifications.map((entry) => `- ${inlineCode(entry.label)}: ${entry.reason}`).join("\n");
}

export function labelTransitionJustificationsMarkdown(
  justifications: readonly LabelTransitionJustification[],
): string {
  if (!justifications.length) return "- none";
  return justifications
    .map((entry) => `- ${entry.action} ${inlineCode(entry.label)}: ${entry.reason}`)
    .join("\n");
}

function desiredClawSweeperLabelsFromPublicReport(
  markdown: string,
  decision: ReportReviewDecision,
  currentLabels: readonly string[],
  options: ReviewCommentRenderOptions = {},
): string[] {
  const isPullRequest = frontMatterValue(markdown, "type") === "pull_request";
  const reviewFailed = frontMatterValue(markdown, "review_status") === "failed";
  let labels = nextPriorityLabels(currentLabels, decision.triagePriority);
  labels = nextImpactLabels(labels, isPullRequest ? [] : decision.impactLabels);
  labels = nextMaturityLabels(labels, isPullRequest ? [] : decision.maturityLabels);
  if (isPullRequest) {
    const realBehaviorProof = decision.realBehaviorProof;
    labels = nextMergeRiskLabels(labels, decision.mergeRiskLabels);
    labels = nextRealBehaviorProofSufficientLabels(labels, realBehaviorProof);
    labels = nextRealBehaviorProofMediaLabels(labels, realBehaviorProof);
    labels = nextPrRatingLabels(labels, decision.prRating, reviewFailed);
    labels = nextFeatureShowcaseLabels(labels, {
      isPullRequest,
      itemCategory: decision.itemCategory,
      requiresNewFeature: decision.requiresNewFeature,
      showcase: decision.featureShowcase,
      securityReview: decision.securityReview,
      overallCorrectness: decision.overallCorrectness,
    });
    labels = nextPrStatusLabels(
      labels,
      options.prStatusKind ?? prStatusLabelKindFromReportLabels(markdown),
    );
    labels = nextTelegramVisibleProofLabels(labels, decision.telegramVisibleProof);
  } else {
    const issueOptions: { hasOpenLinkedPullRequest?: boolean } = {};
    if (options.hasOpenLinkedPullRequest !== undefined) {
      issueOptions.hasOpenLinkedPullRequest = options.hasOpenLinkedPullRequest;
    }
    labels = nextIssueAdvisoryLabels(
      labels,
      issueAdvisoryLabelState(markdown, decision, issueOptions),
    );
  }
  return labels;
}

function labelTransitionReason(
  markdown: string,
  decision: ReportReviewDecision,
  label: string,
  action: LabelTransitionJustification["action"],
  finalJustifications: ReadonlyMap<string, string>,
  options: ReviewCommentRenderOptions = {},
): string {
  const isPullRequest = frontMatterValue(markdown, "type") === "pull_request";
  const realBehaviorProof = decision.realBehaviorProof;
  if (action === "add") {
    const finalReason = finalJustifications.get(label);
    if (finalReason) return finalReason;
  }
  if (PRIORITY_LABEL_NAMES.has(label)) {
    const priority = decision.triagePriority;
    return action === "add"
      ? `Current review triage priority is ${priority}.`
      : priority === "none"
        ? "Current review triage priority is none."
        : `Current review triage priority is ${priority}, so this older priority label is no longer current.`;
  }
  if (IMPACT_LABEL_NAMES.has(label)) {
    const labels = decision.impactLabels;
    return action === "add"
      ? "Current review selected this impact label."
      : labels.length
        ? `Current review impact labels are ${labels.map(inlineCode).join(", ")}.`
        : "Current review selected no impact labels.";
  }
  if (MERGE_RISK_LABEL_NAMES.has(label)) {
    const labels = decision.mergeRiskLabels;
    return action === "add"
      ? "Current PR review selected this merge-risk label."
      : labels.length
        ? `Current PR review merge-risk labels are ${labels.map(inlineCode).join(", ")}.`
        : "Current PR review selected no merge-risk labels.";
  }
  if (MATURITY_LABEL_NAMES.has(label)) {
    const labels = decision.maturityLabels;
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
    const rating = decision.prRating;
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
    const showcase = decision.featureShowcase;
    return action === "add"
      ? `${FEATURE_SHOWCASE_LABEL_DESCRIPTION} ${sentence(showcase.reason)}`
      : "Feature showcase labels are add-only; this label is no longer selected by the current review.";
  }
  if (label === PROOF_SUFFICIENT_LABEL) {
    return action === "add"
      ? PROOF_SUFFICIENT_LABEL_DESCRIPTION
      : `Current real behavior proof status is ${realBehaviorProof.status}, not sufficient.`;
  }
  if (PROOF_MEDIA_LABEL_NAMES.has(label)) {
    const mediaLabel = PROOF_MEDIA_LABELS.find(
      (candidate) => candidate.evidenceKind === realBehaviorProof.evidenceKind,
    );
    return action === "add" && mediaLabel
      ? mediaLabel.description
      : `Current real behavior proof evidence kind is ${realBehaviorProof.evidenceKind}.`;
  }
  if (label === TELEGRAM_VISIBLE_PROOF_LABEL) {
    const proof = decision.telegramVisibleProof;
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

export function labelTransitionJustificationsFromPublicReport(
  markdown: string,
  decision: ReportReviewDecision,
  finalJustifications: readonly LabelJustification[],
  options: ReviewCommentRenderOptions = {},
): LabelTransitionJustification[] {
  const currentLabels = options.previousLabels ?? frontMatterStringArray(markdown, "labels");
  const desiredLabels =
    options.publishedLabels ??
    desiredClawSweeperLabelsFromPublicReport(markdown, decision, currentLabels, options);
  const currentKeys = new Set(currentLabels.map((label) => label.toLowerCase()));
  const desiredKeys = new Set(desiredLabels.map((label) => label.toLowerCase()));
  const finalByLabel = new Map(finalJustifications.map((entry) => [entry.label, entry.reason]));
  const transitions: LabelTransitionJustification[] = [];
  for (const label of desiredLabels) {
    if (!isClawSweeperOwnedLabel(label) || currentKeys.has(label.toLowerCase())) continue;
    transitions.push({
      action: "add",
      label,
      reason: labelTransitionReason(markdown, decision, label, "add", finalByLabel, options),
    });
  }
  for (const label of currentLabels) {
    if (!isClawSweeperOwnedLabel(label) || desiredKeys.has(label.toLowerCase())) continue;
    transitions.push({
      action: "remove",
      label,
      reason: labelTransitionReason(markdown, decision, label, "remove", finalByLabel, options),
    });
  }
  return transitions;
}

export function labelJustificationsFromPublicReport(
  markdown: string,
  decision: ReportReviewDecision,
  options: ReviewCommentRenderOptions = {},
): LabelJustification[] {
  const byLabel = new Map(decision.labelJustifications.map((entry) => [entry.label, entry]));
  const add = (label: string | null | undefined, reason: string): void => {
    if (!label || byLabel.has(label)) return;
    byLabel.set(label, { label, reason });
  };
  const isPullRequest = frontMatterValue(markdown, "type") === "pull_request";
  const realBehaviorProof = decision.realBehaviorProof;
  if (isPullRequest && frontMatterValue(markdown, "review_status") !== "failed") {
    const proofPolicy = reportRealBehaviorProofPolicy(markdown);
    const rating = decision.prRating;
    const ratingLabel = ratingLabelForTier(rating.overallTier).name;
    const previousRatingLabel = frontMatterStringArray(markdown, "labels").find(
      (label) => PR_RATING_LABEL_NAMES.has(label) && label !== ratingLabel,
    );
    const changed = previousRatingLabel
      ? ` Replaced prior ${inlineCode(previousRatingLabel)}.`
      : "";
    const requiredProofContext =
      proofPolicy.proofBlocksMerge && proofPolicy.assessment.status === "not_applicable"
        ? " This is the recorded reviewer rating; real behavior proof remains required by host policy."
        : "";
    add(
      ratingLabel,
      `Overall readiness is ${themedRatingName(rating.overallTier)}; proof is ${themedRatingName(
        rating.proofTier,
      )} and patch quality is ${themedRatingName(rating.patchTier)}.${changed}${requiredProofContext}`,
    );
    const featureShowcase = decision.featureShowcase;
    if (
      shouldApplyFeatureShowcaseLabel({
        isPullRequest,
        itemCategory: decision.itemCategory,
        requiresNewFeature: decision.requiresNewFeature,
        showcase: featureShowcase,
        securityReview: decision.securityReview,
        overallCorrectness: decision.overallCorrectness,
      })
    ) {
      add(
        FEATURE_SHOWCASE_LABEL,
        `${FEATURE_SHOWCASE_LABEL_DESCRIPTION} ${sentence(featureShowcase.reason)}`,
      );
    }
    const statusKind = options.prStatusKind ?? prStatusLabelKindFromReportLabels(markdown);
    if (statusKind) {
      // A label justification states the label meaning. The proof ask renders once, in Before merge.
      add(prStatusLabelForKind(statusKind).name, prStatusLabelForKind(statusKind).description);
    }
    if (realBehaviorProof.status === "sufficient") {
      add(PROOF_SUFFICIENT_LABEL, PROOF_SUFFICIENT_LABEL_DESCRIPTION);
    }
    const proofMediaLabel = PROOF_MEDIA_LABELS.find(
      (label) => label.evidenceKind === realBehaviorProof.evidenceKind,
    );
    if (proofMediaLabel) add(proofMediaLabel.name, proofMediaLabel.description);
    const telegramProof = decision.telegramVisibleProof;
    if (telegramProof.status === "needed") {
      add(
        TELEGRAM_VISIBLE_PROOF_LABEL,
        `${TELEGRAM_VISIBLE_PROOF_LABEL_DESCRIPTION} ${sentence(telegramProof.summary)}`,
      );
    }
  }
  return [...byLabel.values()];
}

export function inlineCode(value: string): string {
  return `\`${value.replaceAll("`", "\\`")}\``;
}
