import { hasDataModelUpgradeProof } from "./clawsweeper-change-detection.js";
import { createLabelSynchronization } from "./clawsweeper-label-sync.js";
import { PROOF_OVERRIDE_LABEL } from "./clawsweeper-policy.js";
import type {
  CloseReason,
  Evidence,
  ItemContext,
  ItemKind,
  ReviewMetric,
} from "./clawsweeper-types.js";
import { ideaRevivalReactionThreshold } from "./idea-archive-revival.js";
import {
  buildOpenClawPrSurfaceStats,
  renderOpenClawPrSurfaceSummary,
  renderOpenClawPrSurfaceTable,
  type PrSurfaceFile,
} from "./pr-surface-stats.js";
import { normalizeRepo } from "./repository-profiles.js";
import type { CreateReportOrchestrationDependencies } from "./clawsweeper-report-orchestration-dependencies.js";
import type { createReportRendering } from "./clawsweeper-report-rendering.js";

export function createReportOrchestrationFoundation(
  dependencies: CreateReportOrchestrationDependencies &
    Pick<ReturnType<typeof createReportRendering>, "collapsedDetailsBlock">,
) {
  const {
    asRecord,
    collapsedDetailsBlock,
    frontMatterBoolean,
    frontMatterJsonArray,
    frontMatterStringArray,
    frontMatterValue,
    ghObservedMutationCommand,
    isBulkFilerExemptAuthorAssociation,
    isBulkFilerExemptRepositoryPermission,
    isDigitsOnly,
    isDocsOnlyPullRequestReport,
    isExternalPullRequestReport,
    labelPolicy,
    markdownLink,
    markdownRepository,
    normalizeLabelName,
    protectedLabels,
    publicReviewTextDiffers,
    publicTableCell,
    repoUrlFor,
    reportRealBehaviorProof,
    reportSecurityReview,
    reviewSectionValue,
    sentence,
    targetProfile,
    targetRepo,
  } = dependencies;

  function closeIntro(reason: CloseReason): string {
    switch (reason) {
      case "implemented_on_main":
        return "Thanks for the context here. I did a careful shell check against current `main`, and this is already implemented.";
      case "mostly_implemented_on_main":
        return "Thanks for the context here. I did a careful shell check against current `main`, and the useful part of this older PR is already implemented there.";
      case "cannot_reproduce":
        return "Thanks for the report. I gave this a fresh shell check against current `main`, and I could not reproduce it anymore.";
      case "clawhub":
        return `Thanks for the idea. I checked the current extension path, and this is a better fit for ${markdownLink("ClawHub.com", targetProfile().communityUrl ?? "https://clawhub.ai/")} than OpenClaw core.`;
      case "duplicate_or_superseded":
        return "Thanks for the context here. I swept through the related work, and this is now duplicate or superseded.";
      case "low_signal_unmergeable_pr":
        return "Thanks for the contribution. I reviewed the branch, and this PR is not a good landing base for OpenClaw.";
      case "stalled_unproven_pr":
        return "Thanks for the contribution. This PR still needs the requested real-behavior proof, and the branch has been idle since that ask.";
      case "abandoned_pr":
        return "Thanks for the contribution. This PR has been inactive for a while and still is not in a landable state.";
      case "unconfirmed_product_direction":
        return "Thanks for the contribution. ClawSweeper proposes closing this for now: the implementation may be reasonable, but passing review and proof does not establish that OpenClaw should add this product surface.";
      case "unsponsored_feature_request":
        return "Thanks for sharing this idea. ClawSweeper is parking it in the idea archive because no maintainer has confirmed this product direction yet.";
      case "author_pr_budget_exceeded":
        return "Thanks for the contribution. ClawSweeper is trimming this lowest-signal PR because the author is over the repository's open-PR budget.";
      case "stale_version_bug":
        return "Thanks for the report. This was filed against an older version, and the relevant code has changed substantially since then.";
      case "obsolete_fix_pr":
        return "Thanks for the contribution. The target code has since been rewritten or removed on `main`, so this fix no longer applies in its original form.";
      case "not_actionable_in_repo":
        return "Thanks for writing this up. I checked the repo boundary, and this lives outside the OpenClaw source shell.";
      case "incoherent":
        return "Thanks for the note. I could not crack enough detail here to turn it into a concrete OpenClaw code or docs action.";
      case "stale_insufficient_info":
        return "Thanks for the report. I checked current `main`, but this shell is missing enough reproduction detail to verify a current bug.";
      case "none":
        return "Thanks for the context here. I checked this with Codex and am closing it based on the evidence below.";
    }
  }

  function closeOutro(reason: CloseReason, canonicalLinks: string[] = []): string {
    switch (reason) {
      case "implemented_on_main":
        return "So I’m closing this as already implemented rather than keeping a duplicate issue open.";
      case "mostly_implemented_on_main":
        return "So I’m closing this older PR as already covered on `main` rather than keeping a mostly-duplicated branch open.";
      case "clawhub":
        return `So I’m closing this as a scope-fit item for the plugin/community path. Please upload or publish it through ${markdownLink("ClawHub.com", targetProfile().communityUrl ?? "https://clawhub.ai/")} so it can live as an installable ClawHub package instead of a bundled OpenClaw core change.`;
      case "duplicate_or_superseded":
        return canonicalLinks.length
          ? `So I’m closing this here and keeping the remaining discussion on ${formatCanonicalLinks(canonicalLinks)}.`
          : "So I’m closing this here because the remaining work is already tracked in the canonical issue.";
      case "low_signal_unmergeable_pr":
        return "So I’m closing this PR rather than keeping an unmergeable branch open. A new narrow PR that carries only the useful part is welcome.";
      case "stalled_unproven_pr":
        return "So I’m closing this for now to keep the review queue honest. Please reopen or open a fresh PR with real-behavior proof (a live run, logs, or a reproducible validation transcript) and it will be reviewed again.";
      case "abandoned_pr":
        return "So I’m closing this as inactive for now. If you pick the work back up, push a rebased branch with green checks and reopen (or open a fresh PR) and it will be reviewed again.";
      case "unconfirmed_product_direction":
        return "This is a proposal only until the separate default-off apply policy is enabled and all live maintainer-signal checks pass. A maintainer can sponsor the direction, request a narrower version, or apply `clawsweeper:human-review` to keep it open.";
      case "unsponsored_feature_request":
        return `This idea is parked, not rejected. A maintainer can comment \`@clawsweeper revive\` on this closed issue to bring it back automatically. It will also reopen when it reaches at least ${ideaRevivalReactionThreshold()} positive reactions (thumbs-up, heart, or hooray). When the idea fits an extension, ${markdownLink("ClawHub.com", targetProfile().communityUrl ?? "https://clawhub.ai/")} remains the self-serve path.`;
      case "author_pr_budget_exceeded":
        return "Closing or finishing other open PRs frees review budget. This PR can be reopened once the author is under budget, or sooner when real behavior proof is added.";
      case "stale_version_bug":
        return "Please retest on the current release. If the problem still reproduces, add a fresh reproduction with the current version and this issue will be reopened.";
      case "obsolete_fix_pr":
        return "If the original problem still reproduces on current `main`, a fresh PR against the current code is very welcome.";
      case "not_actionable_in_repo":
        return "So I’m closing this as outside the OpenClaw source repository rather than keeping it open as core work.";
      default:
        return "";
    }
  }

  function closeClawHubHandoffBlock(reason: CloseReason): string {
    if (reason !== "clawhub") return "";
    return [
      "If you want to carry this forward, package it as a self-serve ClawHub item rather than a core patch:",
      "",
      "- Scope: choose the smallest skill, plugin, provider, channel, bundle, or MCP integration that matches the requested capability.",
      "- Checklist: include package metadata/manifest, entrypoint, required permissions, secrets/config notes, install/update docs, example usage, and a smoke test or proof command.",
      "- Boundary: ClawSweeper will not open a ClawHub issue or PR, create a tracking issue, or publish the package automatically; the contributor should create that ClawHub work separately.",
    ].join("\n");
  }

  function issueOrPullReferenceNumbers(value: string): string[] {
    return [
      ...value.matchAll(
        /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/(\d+)|#(\d+)\b/g,
      ),
    ].map((match) => match[1] ?? match[2] ?? "");
  }

  function issueOrPullReferenceUrls(value: string): string[] {
    return [
      ...value.matchAll(
        /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/\d+/g,
      ),
    ].map((match) => match[0]);
  }

  function itemPublicUrl(item?: { repo?: string; kind?: ItemKind; number?: number }): string {
    if (!item?.number || !Number.isInteger(item.number) || item.number <= 0) return "";
    return repoUrlFor(
      item.repo ?? targetRepo(),
      `/${item.kind === "pull_request" ? "pull" : "issues"}/${item.number}`,
    );
  }

  function addsIssueOrPullReference(candidate: string, summaryLine: string): boolean {
    const summaryRefs = new Set(issueOrPullReferenceNumbers(summaryLine));
    return issueOrPullReferenceNumbers(candidate).some((ref) => ref && !summaryRefs.has(ref));
  }

  function duplicateCanonicalTexts(options: {
    reason: CloseReason;
    bestSolutionLine: string;
    evidence: Evidence[];
  }): string[] {
    if (options.reason !== "duplicate_or_superseded") return [];
    return [
      options.bestSolutionLine,
      ...options.evidence
        .filter((entry) =>
          /\b(?:canonical|duplicate|superseded|implementation)\b/i.test(entry.label),
        )
        .map((entry) => sentence(entry.detail)),
    ];
  }

  function duplicateCanonicalLinkTexts(options: {
    reason: CloseReason;
    bestSolutionLine: string;
    evidence: Evidence[];
  }): string[] {
    if (options.reason !== "duplicate_or_superseded") return [];
    return [
      options.bestSolutionLine,
      ...options.evidence
        .filter((entry) =>
          /\b(?:canonical|duplicate|superseded|implementation)\b/i.test(entry.label),
        )
        .map((entry) => sentence(entry.detail)),
    ];
  }

  function duplicateCanonicalLinks(options: {
    reason: CloseReason;
    bestSolutionLine: string;
    evidence: Evidence[];
    currentItem?: { repo?: string; kind?: ItemKind; number?: number } | undefined;
  }): string[] {
    const seen = new Set<string>();
    const links: string[] = [];
    const currentItemUrl = itemPublicUrl(options.currentItem);
    for (const text of duplicateCanonicalLinkTexts(options)) {
      for (const link of issueOrPullReferenceUrls(text)) {
        if (link === currentItemUrl) continue;
        if (seen.has(link)) continue;
        seen.add(link);
        links.push(link);
      }
    }
    return links;
  }

  function duplicateCanonicalPathLine(options: {
    reason: CloseReason;
    summaryLine: string;
    bestSolutionLine: string;
    evidence: Evidence[];
  }): string {
    const candidates = duplicateCanonicalTexts(options);
    const canonical =
      candidates.find(
        (candidate) => candidate && addsIssueOrPullReference(candidate, options.summaryLine),
      ) ??
      candidates.find(
        (candidate) => candidate && publicReviewTextDiffers(candidate, options.summaryLine),
      );
    return canonical ? `Canonical path: ${canonical}` : "";
  }

  function formatCanonicalLinks(links: string[]): string {
    if (links.length <= 1) return links[0] ?? "the canonical issue";
    if (links.length === 2) return `${links[0]} and ${links[1]}`;
    return `${links.slice(0, -1).join(", ")}, and ${links[links.length - 1]}`;
  }

  function pullRequestFilePathsFromReport(markdown: string): string[] {
    return frontMatterStringArray(markdown, "pull_files");
  }

  function configSurfaceReviewRequired(markdown: string): boolean {
    return (
      frontMatterBoolean(markdown, "config_surface_change") ||
      frontMatterStringArray(markdown, "config_surface_keys").length > 0
    );
  }

  function dataModelSurfaceReviewRequired(markdown: string): boolean {
    return dataModelSurfaceChangeFromReport(markdown) && !dataModelUpgradeProofFromReport(markdown);
  }

  function dataModelSurfaceChangeFromReport(markdown: string): boolean {
    return (
      frontMatterBoolean(markdown, "data_model_change") ||
      frontMatterStringArray(markdown, "data_model_surfaces").length > 0
    );
  }

  function dataModelUpgradeProofFromReport(markdown: string): boolean {
    if (!dataModelSurfaceChangeFromReport(markdown)) return false;
    return hasDataModelUpgradeProof(
      [
        reviewSectionValue(markdown, "realBehaviorProof"),
        reviewSectionValue(markdown, "solutionAssessment"),
        reviewSectionValue(markdown, "evidence"),
      ].join("\n"),
    );
  }

  function prSurfaceFilesFromContext(context: ItemContext): PrSurfaceFile[] {
    if (context.counts?.pullFilesTruncated) return [];
    return (context.pullFiles ?? [])
      .map((entry) => {
        const file = asRecord(entry);
        const path = typeof file.filename === "string" ? file.filename.trim() : "";
        if (!path) return null;
        return {
          path,
          additions: nonNegativeInteger(file.additions),
          deletions: nonNegativeInteger(file.deletions),
        };
      })
      .filter((entry): entry is PrSurfaceFile => Boolean(entry));
  }

  function nonNegativeInteger(value: unknown): number {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : 0;
  }

  function prSurfaceFilesFromReport(markdown: string): PrSurfaceFile[] {
    if (frontMatterBoolean(markdown, "pr_surface_files_truncated")) return [];
    return frontMatterJsonArray(markdown, "pr_surface_files")
      .map((entry) => {
        const file = asRecord(entry);
        const path = typeof file.path === "string" ? file.path.trim() : "";
        if (!path) return null;
        return {
          path,
          additions: nonNegativeInteger(file.additions),
          deletions: nonNegativeInteger(file.deletions),
        };
      })
      .filter((entry): entry is PrSurfaceFile => Boolean(entry));
  }

  function shouldRenderOpenClawPrSurface(markdown: string): boolean {
    return (
      frontMatterValue(markdown, "type") === "pull_request" &&
      normalizeRepo(markdownRepository(markdown)) === "openclaw/openclaw"
    );
  }

  function renderOpenClawPrSurfaceFromReport(markdown: string): string {
    if (!shouldRenderOpenClawPrSurface(markdown)) return "";
    const files = prSurfaceFilesFromReport(markdown);
    if (files.length === 0) return "";
    const stats = buildOpenClawPrSurfaceStats(files);
    const summary = renderOpenClawPrSurfaceSummary(stats);
    if (!summary) return "";
    const details = collapsedDetailsBlock("View PR surface stats", [
      renderOpenClawPrSurfaceTable(stats),
    ]);
    return details ? `${summary}\n\n${details}` : summary;
  }

  function renderDataModelWarningFromReport(markdown: string): string {
    if (
      frontMatterValue(markdown, "type") !== "pull_request" ||
      normalizeRepo(markdownRepository(markdown)) !== "openclaw/openclaw" ||
      !dataModelSurfaceChangeFromReport(markdown)
    ) {
      return "";
    }
    const surfaces = frontMatterStringArray(markdown, "data_model_surfaces");
    const surfaceText = surfaces.length
      ? surfaces
          .slice(0, 6)
          .map((surface) => trustedCommentCodeSpan(surface))
          .join(", ")
      : "an unknown persistent surface";
    const overflow = surfaces.length > 6 ? `, and ${surfaces.length - 6} more` : "";
    const proofLine = dataModelUpgradeProofFromReport(markdown)
      ? "Migration or upgrade compatibility proof is recorded; maintainers should verify it before merge."
      : "Confirm migration or upgrade compatibility proof before merge.";
    return `Persistent data-model change detected: ${surfaceText}${overflow}. ${proofLine}`;
  }

  function trustedCommentCodeSpan(value: string): string {
    const escaped = value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\r?\n|\r/g, " ");
    const longestBacktickRun = Math.max(
      0,
      ...(escaped.match(/`+/g) ?? []).map((run) => run.length),
    );
    const fence = "`".repeat(longestBacktickRun + 1);
    const padding = escaped.startsWith("`") || escaped.endsWith("`") ? " " : "";
    return `${fence}${padding}${escaped}${padding}${fence}`;
  }

  function reviewMetricsFromReport(markdown: string): ReviewMetric[] {
    return frontMatterJsonArray(markdown, "review_metrics")
      .map((entry) => {
        const metric = asRecord(entry);
        const label = typeof metric.label === "string" ? metric.label.trim() : "";
        const value = typeof metric.value === "string" ? metric.value.trim() : "";
        const reason = typeof metric.reason === "string" ? metric.reason.trim() : "";
        if (!label || !value || !reason) return null;
        return { label, value, reason };
      })
      .filter((entry): entry is ReviewMetric => Boolean(entry));
  }

  function renderReviewMetricsDigest(metrics: readonly ReviewMetric[]): string {
    if (metrics.length === 0) return "None.";
    return [
      "| Metric | Value | Why it matters |",
      "|---|---|---|",
      ...metrics.map(
        (metric) =>
          `| **${publicTableCell(metric.label)}** | ${publicTableCell(metric.value)} | ${publicTableCell(sentence(metric.reason))} |`,
      ),
    ].join("\n");
  }

  const labelSynchronization = createLabelSynchronization({
    ghObservedMutationCommand,
    hasNormalizedLabel,
    normalizeLabelName,
    protectedLabels,
    isBulkFilerExemptAuthorAssociation,
    isBulkFilerExemptRepositoryPermission,
    frontMatterValue,
    frontMatterStringArray,
    reportSecurityReview,
    reviewSectionValue,
    labelPolicy,
  });

  const {
    impactLabelSchemeForTest,
    impactLabelsForTest,
    isGitHubLabelAlreadyExistsErrorForTest,
    isGitHubLabelCapacityErrorForTest,
    isMissingGitHubLabelErrorForTest,
    issueAdvisoryLabelsForTest,
    maturityLabelSchemeForTest,
    maturityLabelsForTest,
    mergeRiskLabelSchemeForTest,
    mergeRiskLabelsForTest,
    priorityLabelSchemeForTest,
    priorityLabelsForTest,
    prRatingLabelSchemeForTest,
    prRatingLabelsForTest,
    realBehaviorProofMediaLabelsForTest,
    realBehaviorProofSufficientLabelsForTest,
    syncBulkFilerLabelForTest,
    telegramVisibleProofLabelsForTest,
  } = labelSynchronization;

  function realBehaviorProofBlocksMerge(markdown: string): boolean {
    if (frontMatterValue(markdown, "review_status") === "failed") return false;
    if (!isExternalPullRequestReport(markdown)) return false;
    if (frontMatterStringArray(markdown, "labels").includes(PROOF_OVERRIDE_LABEL)) return false;
    if (isDocsOnlyPullRequestReport(markdown)) return false;
    const proof = reportRealBehaviorProof(markdown);
    return (
      proof.needsContributorAction ||
      proof.status === "missing" ||
      proof.status === "mock_only" ||
      proof.status === "insufficient" ||
      (proof.status !== "sufficient" && proof.status !== "override")
    );
  }

  function normalizedLabelSet(labels: readonly string[]): Set<string> {
    return new Set(labels.map(normalizeLabelName));
  }

  function hasNormalizedLabel(labels: readonly string[], label: string): boolean {
    return normalizedLabelSet(labels).has(normalizeLabelName(label));
  }

  function parseBacktickLocation(value: string): {
    file: string;
    lineStart: number;
    lineEnd: number;
  } | null {
    if (!value.startsWith("`") || !value.endsWith("`")) return null;
    const location = value.slice(1, -1);
    const separator = location.lastIndexOf(":");
    if (separator <= 0) return null;
    const file = location.slice(0, separator);
    const range = parseLineRange(location.slice(separator + 1));
    return range ? { file, ...range } : null;
  }

  function parseLineRange(value: string): { lineStart: number; lineEnd: number } | null {
    const separator = value.indexOf("-");
    const lineStartText = separator === -1 ? value : value.slice(0, separator);
    const lineEndText = separator === -1 ? value : value.slice(separator + 1);
    if (!isDigitsOnly(lineStartText) || !isDigitsOnly(lineEndText)) return null;
    const lineStart = Number(lineStartText);
    const lineEnd = Number(lineEndText);
    return lineStart > 0 && lineEnd >= lineStart ? { lineStart, lineEnd } : null;
  }

  function workCandidateReasonText(section: string): string {
    const lines = section.split("\n");
    const reasonStart = lines.findIndex((line) => line.startsWith("Reason:"));
    if (reasonStart === -1) return "";

    const reasonLines = [lines[reasonStart]!.slice("Reason:".length).trimStart()];
    for (let index = reasonStart + 1; index < lines.length; index += 1) {
      const line = lines[index]!;
      const nextLine = lines[index + 1] ?? "";
      if (
        line.trim() === "" &&
        (nextLine.startsWith("Cluster refs:") ||
          nextLine.startsWith("Likely files:") ||
          nextLine.startsWith("Validation:"))
      ) {
        break;
      }
      reasonLines.push(line);
    }

    return reasonLines.join("\n").trim();
  }

  return {
    closeIntro,
    closeOutro,
    closeClawHubHandoffBlock,
    issueOrPullReferenceNumbers,
    issueOrPullReferenceUrls,
    itemPublicUrl,
    addsIssueOrPullReference,
    duplicateCanonicalTexts,
    duplicateCanonicalLinkTexts,
    duplicateCanonicalLinks,
    duplicateCanonicalPathLine,
    formatCanonicalLinks,
    pullRequestFilePathsFromReport,
    configSurfaceReviewRequired,
    dataModelSurfaceReviewRequired,
    dataModelSurfaceChangeFromReport,
    dataModelUpgradeProofFromReport,
    prSurfaceFilesFromContext,
    nonNegativeInteger,
    prSurfaceFilesFromReport,
    shouldRenderOpenClawPrSurface,
    renderOpenClawPrSurfaceFromReport,
    renderDataModelWarningFromReport,
    trustedCommentCodeSpan,
    reviewMetricsFromReport,
    renderReviewMetricsDigest,
    labelSynchronization,
    impactLabelSchemeForTest,
    impactLabelsForTest,
    isGitHubLabelAlreadyExistsErrorForTest,
    isGitHubLabelCapacityErrorForTest,
    isMissingGitHubLabelErrorForTest,
    issueAdvisoryLabelsForTest,
    maturityLabelSchemeForTest,
    maturityLabelsForTest,
    mergeRiskLabelSchemeForTest,
    mergeRiskLabelsForTest,
    priorityLabelSchemeForTest,
    priorityLabelsForTest,
    prRatingLabelSchemeForTest,
    prRatingLabelsForTest,
    realBehaviorProofMediaLabelsForTest,
    realBehaviorProofSufficientLabelsForTest,
    syncBulkFilerLabelForTest,
    telegramVisibleProofLabelsForTest,
    realBehaviorProofBlocksMerge,
    normalizedLabelSet,
    hasNormalizedLabel,
    parseBacktickLocation,
    parseLineRange,
    workCandidateReasonText,
  };
}
