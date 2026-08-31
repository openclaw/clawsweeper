import { STALLED_UNPROVEN_PROOF_STATUSES } from "./clawsweeper-apply-guards.js";
import { ALLOWED_REASONS, PR_AUTO_CLOSE_EXEMPT_LABELS } from "./clawsweeper-policy.js";
import { isAutoCloseAllowed, repositoryProfileFor } from "./repository-profiles.js";
import type { ActionTaken, CloseReason, Decision, Evidence, Item } from "./clawsweeper-types.js";

interface CloseDecisionWorkflowDependencies {
  targetRepo: () => string;
  isMaintainerAuthorAssociation: (value: unknown) => boolean;
  normalizeLabelName: (label: string) => string;
  applyBlockingProtectedLabels: (labels: readonly string[], closeReason: unknown) => string[];
  applyProtectedLabelReason: (labels: readonly string[], closeReason: unknown) => string;
  prAutoCloseExemptLabel: (labels: readonly string[]) => string | undefined;
  prAutoCloseExemptDecisionReason: (
    item: Pick<Item, "kind" | "labels">,
    closeReason: CloseReason | undefined,
  ) => string | null;
}

export function createCloseDecisionWorkflow({
  targetRepo,
  isMaintainerAuthorAssociation,
  normalizeLabelName,
  applyBlockingProtectedLabels,
  applyProtectedLabelReason,
  prAutoCloseExemptLabel,
  prAutoCloseExemptDecisionReason,
}: CloseDecisionWorkflowDependencies) {
  function hasUsableCloseComment(closeComment: string): boolean {
    const trimmed = closeComment.trim();
    return Boolean(trimmed) && trimmed !== "_No close comment posted._";
  }

  function hasImplementationSourceEvidence(decision: Decision): boolean {
    return decision.evidence.some(
      (entry) => Boolean(entry.file?.trim()) && Boolean(entry.sha?.trim()),
    );
  }

  function evidenceText(entry: Evidence): string {
    return [entry.label, entry.detail, entry.command ?? ""].join("\n");
  }

  function hasImplementationHistoryEvidence(decision: Decision): boolean {
    return decision.evidence.some((entry) =>
      evidenceText(entry).match(/\b(?:git (?:blame|show|log)|blame)\b/i),
    );
  }

  function hasImplementationReleaseStateEvidence(decision: Decision): boolean {
    return decision.evidence.some((entry) =>
      evidenceText(entry).match(
        /\b(?:release|tag|changelog|CHANGELOG|git (?:tag|describe|branch)|gh release|main-only|unreleased|published)\b/i,
      ),
    );
  }

  function hasValidFixedAt(decision: Decision): boolean {
    const value = decision.fixedAt?.trim();
    return Boolean(
      value &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
      Number.isFinite(Date.parse(value)),
    );
  }

  function verifiedImplementationPullRequestBlockReason(
    item: Partial<Pick<Item, "repo" | "number">>,
    decision: Decision,
  ): string | null {
    const pull = decision.fixedPullRequest;
    const repo = item.repo ?? targetRepo();
    if (!pull || pull.confidence !== "high") {
      return "implemented-on-main close requires a GitHub-verified fixing pull request";
    }
    if (pull.repo !== repo) {
      return "implemented-on-main fixing pull request must be in the reviewed repository";
    }
    if (item.number === pull.number) {
      return "implemented-on-main fixing pull request cannot be the pull request being closed";
    }
    if (!pull.mergedAt || !pull.source.startsWith("GitHub ")) {
      return "implemented-on-main fixing pull request must be GitHub-verified and merged";
    }
    if (pull.url !== `https://github.com/${repo}/pull/${pull.number}`) {
      return "implemented-on-main fixing pull request URL does not match its GitHub identity";
    }
    return null;
  }

  function canClose(decision: Decision): boolean {
    return (
      decision.decision === "close" &&
      decision.confidence === "high" &&
      ALLOWED_REASONS.has(decision.closeReason)
    );
  }

  function closeDecisionHasKeepOpenContradiction(decision: Decision): boolean {
    return [decision.summary, decision.bestSolution, decision.closeComment].some((text) =>
      /^\s*Keep open\s*:/im.test(text),
    );
  }

  function unconfirmedProductDirectionDecisionBlockReason(
    item: Pick<Item, "kind" | "labels"> & Partial<Pick<Item, "authorAssociation">>,
    decision: Decision,
  ): string | null {
    if (item.kind !== "pull_request") {
      return "unconfirmed_product_direction is allowed only for pull requests";
    }
    if (!item.authorAssociation) return "unconfirmed_product_direction requires author association";
    if (isMaintainerAuthorAssociation(item.authorAssociation)) {
      return "unconfirmed_product_direction cannot close maintainer-authored pull requests";
    }
    const exemptLabel = item.labels
      .map(normalizeLabelName)
      .find((label) => PR_AUTO_CLOSE_EXEMPT_LABELS.has(label));
    if (exemptLabel) return `${exemptLabel} exempts this PR from product-direction auto-close`;
    if (decision.itemCategory !== "feature") {
      return "unconfirmed_product_direction requires feature item category";
    }
    if (!decision.requiresProductDecision) {
      return "unconfirmed_product_direction requires a product decision";
    }
    if (!decision.requiresNewFeature && !decision.requiresNewConfigOption) {
      return "unconfirmed_product_direction requires new feature or config surface";
    }
    if (
      decision.securityReview.status !== "cleared" ||
      decision.securityReview.concerns.length > 0
    ) {
      return "unconfirmed_product_direction requires a cleared security review";
    }
    if (decision.overallCorrectness !== "patch is correct" || decision.reviewFindings.length > 0) {
      return "unconfirmed_product_direction requires a correct patch with no review findings";
    }
    if (!["sufficient", "override"].includes(decision.realBehaviorProof.status)) {
      return "unconfirmed_product_direction requires sufficient real behavior proof";
    }
    if (!["S", "A", "B", "C"].includes(decision.prRating.overallTier)) {
      return "unconfirmed_product_direction requires a quality-ready PR rating";
    }
    return null;
  }

  function unsponsoredFeatureDecisionBlockReason(
    item: Pick<Item, "kind" | "labels">,
    decision: Pick<Decision, "itemCategory" | "maintainerDecision" | "requiresProductDecision">,
  ): string | null {
    if (item.kind !== "issue") {
      return "unsponsored_feature_request is allowed only for issues";
    }
    if (decision.itemCategory !== "feature") {
      return "unsponsored_feature_request requires feature item category";
    }
    if (!decision.requiresProductDecision) {
      return "unsponsored_feature_request requires a product decision";
    }
    if (
      decision.maintainerDecision.required !== true ||
      decision.maintainerDecision.kind !== "product_direction"
    ) {
      return "unsponsored_feature_request requires a product-direction maintainer decision";
    }
    const securityLabel = item.labels
      .map(normalizeLabelName)
      .find(
        (label) => label === "impact:security" || label === "clawsweeper:needs-security-review",
      );
    if (securityLabel) {
      return `${securityLabel} blocks unsponsored feature auto-close`;
    }
    return null;
  }

  const STALLED_UNPROVEN_RATING_TIERS = new Set(["D", "F"]);

  function externalPrCloseDecisionBlockReason(
    item: Pick<Item, "kind" | "labels"> & Partial<Pick<Item, "authorAssociation">>,
    closeReason: CloseReason,
    exemptText: string,
  ): string | null {
    if (item.kind !== "pull_request") {
      return `${closeReason} is allowed only for pull requests`;
    }
    if (!item.authorAssociation) return `${closeReason} requires author association`;
    if (isMaintainerAuthorAssociation(item.authorAssociation)) {
      return `${closeReason} cannot close maintainer-authored pull requests`;
    }
    const exemptLabel = prAutoCloseExemptLabel(item.labels);
    if (exemptLabel) return `${exemptLabel} exempts this PR from ${exemptText}`;
    return null;
  }

  function stalledUnprovenPrDecisionBlockReason(
    item: Pick<Item, "kind" | "labels"> & Partial<Pick<Item, "authorAssociation">>,
    decision: Decision,
  ): string | null {
    const externalBlock = externalPrCloseDecisionBlockReason(
      item,
      "stalled_unproven_pr",
      "stalled-unproven auto-close",
    );
    if (externalBlock) return externalBlock;
    if (!STALLED_UNPROVEN_PROOF_STATUSES.has(decision.realBehaviorProof.status)) {
      return "stalled_unproven_pr requires missing, mock-only, or insufficient real behavior proof";
    }
    if (!STALLED_UNPROVEN_RATING_TIERS.has(decision.prRating.overallTier)) {
      return "stalled_unproven_pr requires a D or F overall PR rating";
    }
    return null;
  }

  function abandonedPrDecisionBlockReason(
    item: Pick<Item, "kind" | "labels"> & Partial<Pick<Item, "authorAssociation">>,
    decision: Decision,
  ): string | null {
    const externalBlock = externalPrCloseDecisionBlockReason(
      item,
      "abandoned_pr",
      "abandoned-PR auto-close",
    );
    if (externalBlock) return externalBlock;
    if (
      ["S", "A", "B"].includes(decision.prRating.overallTier) &&
      ["sufficient", "override"].includes(decision.realBehaviorProof.status)
    ) {
      return "abandoned_pr cannot close a high-quality proven pull request";
    }
    return null;
  }

  function authorPrBudgetDecisionBlockReason(
    item: Pick<Item, "kind" | "labels"> & Partial<Pick<Item, "authorAssociation">>,
    decision: Decision,
  ): string | null {
    const externalBlock = externalPrCloseDecisionBlockReason(
      item,
      "author_pr_budget_exceeded",
      "author-budget auto-close",
    );
    if (externalBlock) return externalBlock;
    if (
      ["S", "A", "B"].includes(decision.prRating.overallTier) &&
      ["sufficient", "override"].includes(decision.realBehaviorProof.status)
    ) {
      return "author_pr_budget_exceeded cannot close a high-quality proven pull request";
    }
    if (
      !["D", "F"].includes(decision.prRating.overallTier) &&
      !STALLED_UNPROVEN_PROOF_STATUSES.has(decision.realBehaviorProof.status)
    ) {
      return "author_pr_budget_exceeded requires a D/F rating or missing, mock-only, or insufficient real behavior proof";
    }
    return null;
  }

  function staleVersionBugDecisionBlockReason(
    item: Pick<Item, "kind" | "labels">,
    decision: Pick<Decision, "itemCategory">,
  ): string | null {
    if (item.kind !== "issue") return "stale_version_bug is allowed only for issues";
    if (decision.itemCategory !== "bug") return "stale_version_bug requires bug item category";
    const securityLabel = item.labels
      .map(normalizeLabelName)
      .find((label) => label.includes("security"));
    if (securityLabel) return `${securityLabel} blocks stale-version bug auto-close`;
    return null;
  }

  function obsoleteFixPrDecisionBlockReason(
    item: Pick<Item, "kind" | "labels"> & Partial<Pick<Item, "authorAssociation">>,
  ): string | null {
    return externalPrCloseDecisionBlockReason(item, "obsolete_fix_pr", "obsolete-fix auto-close");
  }

  function validateCloseDecision(
    item: Pick<Item, "kind" | "labels"> & Partial<Pick<Item, "repo" | "authorAssociation">>,
    decision: Decision,
    options: { requireCloseComment?: boolean } = {},
  ): { ok: true } | { ok: false; actionTaken: ActionTaken; reason: string } {
    const requireCloseComment = options.requireCloseComment !== false;
    const profile = repositoryProfileFor(item.repo ?? targetRepo());
    if (decision.decision !== "close") {
      return {
        ok: false,
        actionTaken: "kept_open",
        reason: "not a close decision",
      };
    }
    if (applyBlockingProtectedLabels(item.labels, decision.closeReason).length > 0) {
      return {
        ok: false,
        actionTaken: "skipped_protected_label",
        reason: applyProtectedLabelReason(item.labels, decision.closeReason),
      };
    }
    if (!canClose(decision)) {
      return {
        ok: false,
        actionTaken: "skipped_invalid_decision",
        reason: "close decision is not high-confidence with an allowed close reason",
      };
    }
    if (!isAutoCloseAllowed(profile, item.kind, decision.closeReason)) {
      return {
        ok: false,
        actionTaken: "skipped_invalid_decision",
        reason: `${decision.closeReason} is not allowed for ${profile.targetRepo} ${item.kind} apply policy`,
      };
    }
    if (item.kind !== "pull_request" && decision.closeReason === "mostly_implemented_on_main") {
      return {
        ok: false,
        actionTaken: "skipped_invalid_decision",
        reason: "mostly_implemented_on_main is allowed only for pull requests",
      };
    }
    if (item.kind !== "pull_request" && decision.closeReason === "low_signal_unmergeable_pr") {
      return {
        ok: false,
        actionTaken: "skipped_invalid_decision",
        reason: "low_signal_unmergeable_pr is allowed only for pull requests",
      };
    }
    const closeExemptReason = prAutoCloseExemptDecisionReason(item, decision.closeReason);
    if (closeExemptReason) {
      return {
        ok: false,
        actionTaken: "skipped_close_exempt_label",
        reason: closeExemptReason,
      };
    }
    if (decision.closeReason === "unconfirmed_product_direction") {
      const productDirectionBlock = unconfirmedProductDirectionDecisionBlockReason(item, decision);
      if (productDirectionBlock) {
        return {
          ok: false,
          actionTaken: "skipped_invalid_decision",
          reason: productDirectionBlock,
        };
      }
    }
    if (decision.closeReason === "unsponsored_feature_request") {
      const unsponsoredFeatureBlock = unsponsoredFeatureDecisionBlockReason(item, decision);
      if (unsponsoredFeatureBlock) {
        return {
          ok: false,
          actionTaken: "skipped_invalid_decision",
          reason: unsponsoredFeatureBlock,
        };
      }
    }
    if (decision.closeReason === "stalled_unproven_pr") {
      const stalledUnprovenBlock = stalledUnprovenPrDecisionBlockReason(item, decision);
      if (stalledUnprovenBlock) {
        return {
          ok: false,
          actionTaken: "skipped_invalid_decision",
          reason: stalledUnprovenBlock,
        };
      }
    }
    if (decision.closeReason === "abandoned_pr") {
      const abandonedBlock = abandonedPrDecisionBlockReason(item, decision);
      if (abandonedBlock) {
        return {
          ok: false,
          actionTaken: "skipped_invalid_decision",
          reason: abandonedBlock,
        };
      }
    }
    if (decision.closeReason === "author_pr_budget_exceeded") {
      const authorBudgetBlock = authorPrBudgetDecisionBlockReason(item, decision);
      if (authorBudgetBlock) {
        return {
          ok: false,
          actionTaken: "skipped_invalid_decision",
          reason: authorBudgetBlock,
        };
      }
    }
    if (decision.closeReason === "stale_version_bug") {
      const staleVersionBlock = staleVersionBugDecisionBlockReason(item, decision);
      if (staleVersionBlock) {
        return {
          ok: false,
          actionTaken: "skipped_invalid_decision",
          reason: staleVersionBlock,
        };
      }
    }
    if (decision.closeReason === "obsolete_fix_pr") {
      const obsoleteFixBlock = obsoleteFixPrDecisionBlockReason(item);
      if (obsoleteFixBlock) {
        return {
          ok: false,
          actionTaken: "skipped_invalid_decision",
          reason: obsoleteFixBlock,
        };
      }
    }
    if (item.kind === "pull_request" && decision.closeReason === "stale_insufficient_info") {
      return {
        ok: false,
        actionTaken: "skipped_invalid_decision",
        reason: "stale_insufficient_info is not allowed for pull requests",
      };
    }
    if (!decision.summary.trim()) {
      return { ok: false, actionTaken: "skipped_invalid_decision", reason: "missing summary" };
    }
    if (closeDecisionHasKeepOpenContradiction(decision)) {
      return {
        ok: false,
        actionTaken: "skipped_invalid_decision",
        reason: "close decision contains Keep open guidance",
      };
    }
    if (requireCloseComment && !hasUsableCloseComment(decision.closeComment)) {
      return {
        ok: false,
        actionTaken: "skipped_invalid_decision",
        reason: "missing close comment",
      };
    }
    if (decision.evidence.length === 0) {
      return { ok: false, actionTaken: "skipped_invalid_decision", reason: "missing evidence" };
    }
    if (
      isImplementationCloseReason(decision.closeReason) &&
      !hasImplementationSourceEvidence(decision)
    ) {
      return {
        ok: false,
        actionTaken: "skipped_invalid_decision",
        reason: `${decision.closeReason} requires evidence with file and sha`,
      };
    }
    if (item.kind === "pull_request" && isImplementationCloseReason(decision.closeReason)) {
      const implementationPullRequestBlock = verifiedImplementationPullRequestBlockReason(
        item,
        decision,
      );
      if (implementationPullRequestBlock) {
        return {
          ok: false,
          actionTaken: "skipped_invalid_decision",
          reason: implementationPullRequestBlock,
        };
      }
    }
    if (isImplementationCloseReason(decision.closeReason) && !decision.fixedSha?.trim()) {
      return {
        ok: false,
        actionTaken: "skipped_invalid_decision",
        reason: `${decision.closeReason} requires fixedSha`,
      };
    }
    if (
      isImplementationCloseReason(decision.closeReason) &&
      decision.fixedAt &&
      !hasValidFixedAt(decision)
    ) {
      return {
        ok: false,
        actionTaken: "skipped_invalid_decision",
        reason: `${decision.closeReason} fixedAt must be an ISO timestamp`,
      };
    }
    if (
      isImplementationCloseReason(decision.closeReason) &&
      !decision.fixedRelease?.trim() &&
      !hasValidFixedAt(decision)
    ) {
      return {
        ok: false,
        actionTaken: "skipped_invalid_decision",
        reason: `${decision.closeReason} requires fixedRelease or fixedAt`,
      };
    }
    if (
      isImplementationCloseReason(decision.closeReason) &&
      !hasImplementationHistoryEvidence(decision)
    ) {
      return {
        ok: false,
        actionTaken: "skipped_invalid_decision",
        reason: `${decision.closeReason} requires git history provenance evidence`,
      };
    }
    if (
      isImplementationCloseReason(decision.closeReason) &&
      !hasImplementationReleaseStateEvidence(decision)
    ) {
      return {
        ok: false,
        actionTaken: "skipped_invalid_decision",
        reason: `${decision.closeReason} requires release or main-only provenance evidence`,
      };
    }
    return { ok: true };
  }

  function isImplementationCloseReason(reason: CloseReason): boolean {
    return reason === "implemented_on_main" || reason === "mostly_implemented_on_main";
  }

  return {
    hasUsableCloseComment,
    isImplementationCloseReason,
    staleVersionBugDecisionBlockReason,
    unsponsoredFeatureDecisionBlockReason,
    validateCloseDecision,
  };
}
