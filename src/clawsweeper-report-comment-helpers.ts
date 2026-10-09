import {
  oversizedPullRequestComment,
  parseOversizedPullRequestEvidence,
} from "./clawsweeper-oversized-pr-policy.js";
import type {
  AgentsPolicyStatus,
  CloseReason,
  Decision,
  Evidence,
  FixedPullRequest,
  GitInfo,
  ItemKind,
  LikelyOwner,
  MergeRiskOption,
  NextStepAssessment,
  PublicBeforeMergeItem,
  PullRequestReviewReadiness,
  RegressionAssessment,
  ReviewFinding,
  ReviewRuntime,
  RootCauseClusterAssessment,
  PublicRegressionProvenance,
  SecurityReview,
} from "./clawsweeper-types.js";
import type { RealBehaviorProofPolicy } from "./clawsweeper-proof-policy.js";
import { nextStepFromReport } from "./clawsweeper-next-step.js";
import { reportRealBehaviorProofPolicy } from "./clawsweeper-proof-policy.js";
import {
  closeEvidenceLine,
  isReportNoneList,
  likelyOwnerLines,
  normalizePublicReviewText,
  priorityLabel,
  publicHistoricalVerificationBlockerLine,
  publicRealBehaviorProofLine,
  publicReviewTextDiffers,
  publicReviewTextIsSame,
  reportRiskEntries,
  reviewFindingLocation,
  securityConcernDetailedLine,
  securityReviewLine,
  sentence,
  stripListMarker,
} from "./clawsweeper-review-presentation.js";
import { validReviewLeaseIdentity } from "./review-comment-markers.js";
import { maintainerDecisionFromReport } from "./decision-packets.js";
import {
  reportAgentsPolicyStatus,
  reportEvidence,
  reportLikelyOwners,
  reportOverallCorrectness,
  reportProductReview,
  reportProvenance,
  reportPrRating,
  reportReviewFindings,
  reportRootCauseCluster,
  reportSecurityReview,
} from "./clawsweeper-report-parser.js";
import { AUTOFIX_LABEL, AUTOMERGE_LABEL } from "./repair/exact-review-guard-labels.js";
import {
  isRegressionAssessment,
  isPublicRegressionProvenance,
  isVerifiedRegressionProvenance,
  regressionAssessmentPublicLine,
  regressionProvenancePublicLine,
} from "./clawsweeper-regression-provenance.js";
import {
  appendReviewHistoryCycle,
  neutralizeReviewControlMarkers,
  parseReviewHistory,
  reviewHistoryCycleFromCommentBody,
  type ReviewHistoryLedger,
} from "./review-history.js";
import {
  closeReviewLineFromDecision,
  closeReviewLineFromReport,
} from "./clawsweeper-report-context.js";
import { parseIsoMs } from "./iso-time.js";
import { frontMatterStringArray, frontMatterValue } from "./report-front-matter.js";
import { agentsPolicyStatusLine, collapsedDetailsBlock } from "./clawsweeper-report-helpers.js";
import { markdownLink, repoUrlFor } from "./clawsweeper-links.js";
import { ideaRevivalReactionThreshold } from "./idea-archive-revival.js";
import type { RepositoryProfile } from "./repository-profiles.js";
import {
  fixedPullRequestFromReport,
  formatReviewFreshnessTimestamp,
  regressionAssessmentFromReport,
  regressionProvenanceFromReport,
} from "./clawsweeper-status-context.js";
import { markdownRepository } from "./clawsweeper-repository-paths.js";
import { pullHeadShaFromReport, reviewSectionValue } from "./clawsweeper-record-metadata.js";

function publicBeforeMergeItems(options: {
  reviewFailed: boolean;
  proofPolicy: RealBehaviorProofPolicy;
  findings: readonly ReviewFinding[];
  securityReview: SecurityReview;
  securityRepairAllowed: boolean;
  risks: string;
  nextStepAssessment: NextStepAssessment | undefined;
  patchQualityBlocked: boolean;
  requiredRatingSteps: readonly string[];
}): PublicBeforeMergeItem[] {
  const items: PublicBeforeMergeItem[] = [];
  const seen = new Map<string, PublicBeforeMergeItem>();
  const add = (
    label: string,
    detail: string,
    identity?: { distinctKey: string },
    state: PublicBeforeMergeItem["state"] = "needs-changes",
  ) => {
    const rawDetail = stripListMarker(detail);
    const cleanDetail = sentence(rawDetail);
    // Typed findings pass a distinct key (title and location) so independent
    // findings that share remediation wording are all kept; free-form guidance
    // still de-duplicates on the detail text across sections.
    const key = normalizePublicReviewText(
      identity ? `${identity.distinctKey} ${cleanDetail}` : cleanDetail,
    );
    if (!cleanDetail || /^none[.!]?$/i.test(rawDetail) || isReportNoneList(cleanDetail)) return;
    const duplicate =
      seen.get(key) ??
      (!identity
        ? items.find((item) => !publicReviewTextDiffers(item.detail, cleanDetail))
        : undefined);
    if (duplicate) {
      if (state === "blocked") duplicate.state = "blocked";
      return;
    }
    const item = { label, detail: cleanDetail, state };
    seen.set(key, item);
    items.push(item);
  };

  if (options.reviewFailed) {
    add(
      "Retry ClawSweeper review",
      "ClawSweeper must complete a fresh review before readiness is known.",
      undefined,
      "blocked",
    );
  }
  if (!options.reviewFailed && options.proofPolicy.proofBlocksMerge) {
    add(
      options.proofPolicy.needsContributorAction
        ? "Add real behavior proof"
        : "Resolve real behavior proof assessment",
      publicRealBehaviorProofLine(options.proofPolicy),
      undefined,
      "blocked",
    );
  }
  if (!options.reviewFailed && options.proofPolicy.verificationBlocksMerge) {
    add(
      "Resolve historical verification",
      publicHistoricalVerificationBlockerLine(),
      undefined,
      "blocked",
    );
  }
  for (const finding of options.findings) {
    add(
      `${finding.title.trim()} (${priorityLabel(finding.priority)})`,
      typedBlockerDetail(finding.body, `Resolve ${finding.title.trim()} before merge.`),
      {
        distinctKey: `${finding.title} ${reviewFindingLocation(finding)}`,
      },
    );
  }
  for (const concern of options.securityReview.concerns) {
    add(
      `Resolve security concern: ${concern.title.trim()}`,
      typedBlockerDetail(concern.body, `Resolve ${concern.title.trim()} before merge.`),
      {
        distinctKey: `security ${concern.title}`,
      },
      options.securityRepairAllowed ? "needs-changes" : "blocked",
    );
  }
  if (
    options.securityReview.status === "needs_attention" &&
    options.securityReview.concerns.length === 0
  ) {
    add(
      "Resolve security review attention item",
      typedBlockerDetail(
        options.securityReview.summary,
        "Resolve the security review before merge.",
      ),
      undefined,
      options.securityRepairAllowed ? "needs-changes" : "blocked",
    );
  }
  // Each `risks` entry is unresolved merge work; the prompt keeps settled points out.
  for (const risk of reportRiskEntries(options.risks)) {
    add("Resolve merge risk", risk, undefined, "blocked");
  }
  // The model owns next-step intent. A report without a typed next step fails closed.
  if (options.nextStepAssessment?.kind === "required") {
    add(
      "Complete next step",
      typedBlockerDetail(
        options.nextStepAssessment.text,
        "Complete the required follow-up from this review before merge.",
      ),
    );
  } else if (!options.reviewFailed && options.nextStepAssessment === undefined) {
    add(
      "Run a fresh ClawSweeper review",
      "This review report has no valid next-step record. Run a fresh exact-head review before merge.",
      undefined,
      "blocked",
    );
  }
  // A step that deduplicates against an existing item still counts as represented remediation.
  let ratingRemediationRepresented = false;
  for (const step of options.requiredRatingSteps) {
    const cleanStep = sentence(stripListMarker(step));
    if (!cleanStep || /^none[.!]?$/i.test(cleanStep) || isReportNoneList(cleanStep)) continue;
    ratingRemediationRepresented = true;
    add("Improve patch quality", step);
  }
  // A blocked patch rating must always leave a concrete follow-up, even when the
  // rating supplied no usable next steps and no typed findings explain the block.
  if (
    options.patchQualityBlocked &&
    !ratingRemediationRepresented &&
    options.findings.length === 0 &&
    options.securityReview.concerns.length === 0
  ) {
    add(
      "Improve patch quality",
      "Address the low patch-quality rating before merge; see the review scores for what is holding it back.",
    );
  }

  return items;
}

function typedBlockerDetail(detail: string, fallback: string): string {
  return detail.trim() &&
    !isReportNoneList(detail) &&
    !/^(?:none|n\/a|not applicable)[.!]?$/i.test(detail.trim())
    ? detail
    : fallback;
}

export function securitySensitiveRepairAllowed(markdown: string): boolean {
  const labels = frontMatterStringArray(markdown, "labels");
  return (
    frontMatterValue(markdown, "decision") === "keep_open" &&
    (labels.includes(AUTOFIX_LABEL) || labels.includes(AUTOMERGE_LABEL))
  );
}

export function pullRequestReviewReadinessFromReport(markdown: string): PullRequestReviewReadiness {
  let headSha: string | null = null;
  try {
    const candidate = pullHeadShaFromReport(markdown);
    headSha = candidate && /^[0-9a-f]{40}$/i.test(candidate) ? candidate.toLowerCase() : null;
    const reviewStatus = frontMatterValue(markdown, "review_status");
    const decisionPending = Boolean(maintainerDecisionFromReport(markdown)?.required);
    const rating = reportPrRating(markdown);
    const patchQualityBlocked = rating.patchTier === "F" || rating.patchTier === "D";
    const items = publicBeforeMergeItems({
      reviewFailed: reviewStatus !== "complete",
      proofPolicy: reportRealBehaviorProofPolicy(markdown),
      findings: reportReviewFindings(markdown),
      securityReview: reportSecurityReview(markdown),
      securityRepairAllowed: securitySensitiveRepairAllowed(markdown),
      risks: reviewSectionValue(markdown, "risks"),
      nextStepAssessment: nextStepFromReport(markdown),
      patchQualityBlocked,
      requiredRatingSteps: patchQualityBlocked ? rating.nextSteps : [],
    });
    const block = (condition: boolean, label: string, detail: string) => {
      if (condition) items.push({ state: "blocked", label, detail });
    };
    const number = frontMatterValue(markdown, "number") ?? "";
    block(
      !/^[1-9]\d*$/.test(number) ||
        !Number.isSafeInteger(Number(number)) ||
        !headSha ||
        parseIsoMs(frontMatterValue(markdown, "reviewed_at")) === null ||
        !validReviewLeaseIdentity(
          frontMatterValue(markdown, "review_lease_owner"),
          frontMatterValue(markdown, "review_lease_comment_id"),
        ),
      "Bind the durable review identity",
      "Record the exact pull request, head, review time, and owned lease before publishing readiness.",
    );
    block(
      frontMatterValue(markdown, "confidence") !== "high",
      "Resolve review confidence",
      "ClawSweeper must reach high confidence before merge readiness is known.",
    );
    block(
      frontMatterValue(markdown, "decision") !== "keep_open",
      "Resolve review disposition",
      "Only a keep-open review can publish merge readiness.",
    );
    block(
      decisionPending,
      "Resolve maintainer decision",
      "Resolve the maintainer decision shown above before merge.",
    );
    const product = reportProductReview(markdown);
    block(
      product.worthIt === "no",
      "Product: not worth merging",
      product.reason || "The review found no user problem that justifies this change.",
    );
    // A maintainer decision packet already asks the owner; one blocker is enough.
    block(
      product.worthIt === "needs_maintainer" && !decisionPending,
      "Product call needed",
      product.reason || "An owner must decide whether this change belongs in the product.",
    );
    // The model owns the stored-data judgement; the host only shows its verdict.
    block(
      reportRealBehaviorProofPolicy(markdown).assessment.dataModelCompatibility === "insufficient",
      "Add data-model compatibility proof",
      "The review found that existing stored data may not work after upgrade. Show that existing data still loads and works with this change.",
    );
    // The close path failed, not the patch. A maintainer decides between close and land.
    block(
      frontMatterValue(markdown, "action_taken") === "skipped_pr_close_coverage_proof",
      "Maintainer: close or keep this PR",
      "The review found that this PR may be superseded, but the close check did not confirm that the other PR covers all of its work. A maintainer must close this PR or confirm that it still has work to land.",
    );
    const correctness = reportOverallCorrectness(markdown);
    if (
      correctness === "patch is incorrect" &&
      !items.some((item) => item.state === "needs-changes")
    ) {
      items.push({
        state: "needs-changes",
        label: "Correct the reviewed patch",
        detail: typedBlockerDetail(
          rating.summary,
          "The review found the patch incorrect. See the merge readiness summary above for the reason.",
        ),
      });
    } else {
      block(
        reviewStatus === "complete" &&
          correctness !== "patch is correct" &&
          correctness !== "patch is incorrect",
        "Complete the correctness assessment",
        "Record a definitive patch correctness assessment before merge.",
      );
    }
    if (
      frontMatterValue(markdown, "work_candidate") === "queue_fix_pr" &&
      !items.some((item) => item.state === "needs-changes")
    ) {
      items.push({
        state: "needs-changes",
        label: "Complete the queued repair",
        detail: "Apply the queued review repair and run a fresh exact-head review before merge.",
      });
    }
    for (const entry of reportProvenance(markdown)) {
      if (entry.verdict !== "overrides_without_reason") continue;
      items.push({
        state: "needs-changes",
        label: `Explain or restore the original intent of ${entry.area}`,
        detail: `${entry.introducedBy}: ${entry.originalReason || "reason not recorded"}`,
      });
    }
    return {
      headSha,
      state: items.some((item) => item.state === "blocked")
        ? "blocked"
        : items.length
          ? "needs-changes"
          : "ready",
      items,
      normalizationFailed: false,
    };
  } catch {
    return {
      headSha,
      state: "blocked",
      normalizationFailed: true,
      items: [
        {
          state: "blocked",
          label: "Regenerate malformed review report",
          detail:
            "Regenerate the ClawSweeper report and run a fresh exact-head review before merge.",
        },
      ],
    };
  }
}

function closeIntro(reason: CloseReason, profile: RepositoryProfile): string {
  switch (reason) {
    case "oversized_pull_request":
      return "Pull request exceeds the review size limit.";
    case "implemented_on_main":
      return "Thanks for the context here. I did a careful shell check against current `main`, and this is already implemented.";
    case "mostly_implemented_on_main":
      return "Thanks for the context here. I did a careful shell check against current `main`, and the useful part of this older PR is already implemented there.";
    case "cannot_reproduce":
      return "Thanks for the report. I gave this a fresh shell check against current `main`, and I could not reproduce it anymore.";
    case "clawhub":
      return `Thanks for the idea. I checked the current extension path, and this is a better fit for ${markdownLink("ClawHub.com", profile.communityUrl ?? "https://clawhub.ai/")} than OpenClaw core.`;
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

function closeOutro(
  reason: CloseReason,
  canonicalLinks: readonly string[],
  profile: RepositoryProfile,
): string {
  switch (reason) {
    case "implemented_on_main":
      return "So I’m closing this as already implemented rather than keeping a duplicate issue open.";
    case "mostly_implemented_on_main":
      return "So I’m closing this older PR as already covered on `main` rather than keeping a mostly-duplicated branch open.";
    case "clawhub":
      return `So I’m closing this as a scope-fit item for the plugin/community path. Please upload or publish it through ${markdownLink("ClawHub.com", profile.communityUrl ?? "https://clawhub.ai/")} so it can live as an installable ClawHub package instead of a bundled OpenClaw core change.`;
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
      return `This idea is parked, not rejected. A maintainer can comment \`@clawsweeper revive\` on this closed issue to bring it back automatically. It will also reopen when it reaches at least ${ideaRevivalReactionThreshold()} positive reactions (thumbs-up, heart, or hooray). When the idea fits an extension, ${markdownLink("ClawHub.com", profile.communityUrl ?? "https://clawhub.ai/")} remains the self-serve path.`;
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

function itemPublicUrl(
  item: { repo?: string; kind?: ItemKind; number?: number } | undefined,
  profile: RepositoryProfile,
): string {
  if (!item?.number || !Number.isInteger(item.number) || item.number <= 0) return "";
  return repoUrlFor(
    item.repo ?? profile.targetRepo,
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
      .filter((entry) => /\b(?:canonical|duplicate|superseded|implementation)\b/i.test(entry.label))
      .map((entry) => sentence(entry.detail)),
  ];
}

function duplicateCanonicalLinks(
  options: {
    reason: CloseReason;
    bestSolutionLine: string;
    evidence: Evidence[];
    currentItem?: { repo?: string; kind?: ItemKind; number?: number } | undefined;
  },
  profile: RepositoryProfile,
): string[] {
  const seen = new Set<string>();
  const links: string[] = [];
  const currentItemUrl = itemPublicUrl(options.currentItem, profile);
  for (const text of duplicateCanonicalTexts(options)) {
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

function formatCanonicalLinks(links: readonly string[]): string {
  if (links.length <= 1) return links[0] ?? "the canonical issue";
  if (links.length === 2) return `${links[0]} and ${links[1]}`;
  return `${links.slice(0, -1).join(", ")}, and ${links[links.length - 1]}`;
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

function renderCloseComment(
  options: {
    reason: CloseReason;
    summary: string;
    bestSolution?: string;
    reproductionAssessment?: string;
    solutionAssessment?: string;
    agentsPolicyStatus?: AgentsPolicyStatus | undefined;
    evidence: Evidence[];
    likelyOwners?: LikelyOwner[];
    fixedPullRequest?: FixedPullRequest | null;
    regressionAssessment?: RegressionAssessment | null;
    regressionProvenance?: PublicRegressionProvenance | null;
    securityReview?: SecurityReview;
    rootCauseCluster?: RootCauseClusterAssessment;
    reviewLine: string;
    currentItem?: { repo?: string; kind?: ItemKind; number?: number } | undefined;
  },
  profile: RepositoryProfile,
): string {
  const evidence = options.evidence.slice(0, 6).map((entry) => closeEvidenceLine(entry, profile));
  const likelyOwners = likelyOwnerLines(options.likelyOwners ?? [], profile);
  const summaryLine = sentence(options.summary);
  const lines = [closeIntro(options.reason, profile), "", summaryLine];
  if (options.fixedPullRequest?.confidence === "high") {
    lines.push(
      "",
      `I found the merged PR that appears to have closed this: ${markdownLink(
        `#${options.fixedPullRequest.number}: ${options.fixedPullRequest.title}`,
        options.fixedPullRequest.url,
      )}.`,
    );
  }
  const regressionProvenanceLine = regressionProvenancePublicLine(
    options.regressionProvenance,
    options.regressionAssessment,
  );
  const regressionAssessmentLine = regressionAssessmentPublicLine(options.regressionAssessment, {
    predecessorAttributed: options.regressionProvenance?.evidenceType === "rewrite_equivalent",
  });
  if (regressionProvenanceLine) lines.push("", regressionProvenanceLine);
  if (regressionAssessmentLine && !isVerifiedRegressionProvenance(options.regressionProvenance)) {
    lines.push("", regressionAssessmentLine);
  }
  const rootCauseCluster = publicRootCauseClusterBlock(options.rootCauseCluster);
  if (rootCauseCluster) lines.push("", "**Root-cause cluster**", rootCauseCluster);
  const bestSolutionLine = sentence(options.bestSolution ?? "");
  const canonicalLinks = duplicateCanonicalLinks(
    {
      reason: options.reason,
      bestSolutionLine,
      evidence: options.evidence,
      currentItem: options.currentItem,
    },
    profile,
  );
  const canonicalPathLine = duplicateCanonicalPathLine({
    reason: options.reason,
    summaryLine,
    bestSolutionLine,
    evidence: options.evidence,
  });
  if (canonicalPathLine) lines.push("", canonicalPathLine);
  const details: string[] = [];
  if (bestSolutionLine && publicReviewTextDiffers(bestSolutionLine, summaryLine)) {
    details.push("Best possible solution:", "", bestSolutionLine);
  }
  appendReviewQuestionDetails(details, options.reproductionAssessment, options.solutionAssessment);
  if (options.securityReview) {
    details.push("", "Security review:", "", securityReviewLine(options.securityReview));
    if (options.securityReview.concerns.length) {
      details.push("", ...options.securityReview.concerns.map(securityConcernDetailedLine));
    }
  }
  const agentsPolicyLine = agentsPolicyStatusLine(options.agentsPolicyStatus);
  if (agentsPolicyLine) details.push("", agentsPolicyLine);
  if (evidence.length) details.push("", "What I checked:", "", ...evidence);
  if (likelyOwners.length) details.push("", "Likely related people:", "", ...likelyOwners);

  const clawhubHandoff = closeClawHubHandoffBlock(options.reason);
  if (clawhubHandoff) lines.push("", "**ClawHub handoff**", clawhubHandoff);
  const outro = closeOutro(options.reason, canonicalLinks, profile);
  if (outro) lines.push("", outro);
  if (options.reviewLine) details.push("", options.reviewLine);
  const detailsBlock = collapsedDetailsBlock("Review details", details);
  if (detailsBlock) lines.push("", detailsBlock);

  return lines.join("\n");
}

export function renderCloseCommentFromReport(
  markdown: string,
  reason: CloseReason,
  profile: RepositoryProfile,
): string {
  if (reason === "oversized_pull_request") {
    const size = parseOversizedPullRequestEvidence(
      frontMatterValue(markdown, "oversized_pull_request"),
    );
    return size
      ? oversizedPullRequestComment(size, frontMatterValue(markdown, "action_taken") === "closed")
      : "";
  }
  return neutralizeReviewControlMarkers(
    renderCloseComment(
      {
        reason,
        summary: reviewSectionValue(markdown, "summary"),
        bestSolution: reviewSectionValue(markdown, "bestSolution"),
        reproductionAssessment: reviewSectionValue(markdown, "reproductionAssessment"),
        solutionAssessment: reviewSectionValue(markdown, "solutionAssessment"),
        agentsPolicyStatus: reportAgentsPolicyStatus(markdown),
        evidence: reportEvidence(markdown),
        likelyOwners: reportLikelyOwners(markdown),
        fixedPullRequest: fixedPullRequestFromReport(markdown),
        regressionAssessment: regressionAssessmentFromReport(markdown),
        regressionProvenance: regressionProvenanceFromReport(markdown),
        securityReview: reportSecurityReview(markdown),
        rootCauseCluster: reportRootCauseCluster(markdown),
        reviewLine: closeReviewLineFromReport(markdown, profile),
        currentItem: {
          repo: markdownRepository(markdown),
          number: Number(frontMatterValue(markdown, "number")),
          kind: (frontMatterValue(markdown, "type") as ItemKind | undefined) ?? "issue",
        },
      },
      profile,
    ),
  );
}

export function normalizeComment(
  decision: Decision,
  git: GitInfo,
  runtime: Pick<ReviewRuntime, "model" | "reasoningEffort"> | undefined,
  item: { repo?: string; kind?: ItemKind; number?: number } | undefined,
  profile: RepositoryProfile,
): string {
  if (decision.closeReason === "oversized_pull_request") {
    const size = parseOversizedPullRequestEvidence(decision.oversizedPullRequest);
    return size ? oversizedPullRequestComment(size) : "";
  }
  return renderCloseComment(
    {
      reason: decision.closeReason,
      summary: decision.summary,
      bestSolution: decision.bestSolution,
      reproductionAssessment: decision.reproductionAssessment,
      solutionAssessment: decision.solutionAssessment,
      agentsPolicyStatus: decision.agentsPolicyStatus,
      evidence: decision.evidence,
      likelyOwners: decision.likelyOwners,
      fixedPullRequest: decision.fixedPullRequest ?? null,
      regressionAssessment: isRegressionAssessment(decision.regressionAssessment)
        ? decision.regressionAssessment
        : null,
      regressionProvenance: isPublicRegressionProvenance(decision.regressionProvenance)
        ? decision.regressionProvenance
        : null,
      securityReview: decision.securityReview,
      rootCauseCluster: decision.rootCauseCluster,
      reviewLine: closeReviewLineFromDecision(decision, git, runtime, profile),
      currentItem: item,
    },
    profile,
  );
}

export function reportWorkCandidateReason(markdown: string): string {
  const workCandidate = reviewSectionValue(markdown, "workCandidate");
  const reason = workCandidateReasonText(workCandidate);
  if (!reason || reason.startsWith("_No work-lane recommendation")) return "";
  return reason;
}

export function appendPublicSection(lines: string[], heading: string, body: string): void {
  lines.push(`**${heading}**`, body, "");
}

export function appendHeadingSection(lines: string[], heading: string, body: string): void {
  lines.push(`## ${heading}`, "", body, "");
}

export function publicChecklistText(value: string): string {
  // Flatten line breaks (with their surrounding layout indentation) only; interior
  // runs of spaces inside commands, quoted arguments, and paths stay exact.
  return value
    .replace(/<(?=[a-z/!?])/gi, "&lt;")
    .replace(/[ \t]*(?:\r?\n|\r)+[ \t]*/g, " ")
    .trim();
}

function publicChecklistLabel(value: string): string {
  return publicChecklistText(value)
    .replace(/\\/g, "\\\\")
    .replace(/([*_`[\]])/g, "\\$1");
}

export function publicBeforeMergeBlock(items: readonly PublicBeforeMergeItem[]): string {
  if (items.length === 0) return "None.";
  return items
    .map(
      (item) =>
        `- [ ] **${publicChecklistLabel(item.label)}** - ${publicChecklistText(item.detail)}`,
    )
    .join("\n");
}

export function publicRootCauseClusterBlock(
  cluster: RootCauseClusterAssessment | undefined,
): string {
  if (
    !cluster ||
    cluster.confidence !== "high" ||
    !cluster.canonicalRef ||
    cluster.members.length === 0 ||
    ["independent", "security_route", "needs_human"].includes(cluster.currentItemRelationship)
  ) {
    return "";
  }
  const visibleMembers = cluster.members.slice(0, 5);
  const memberLines = visibleMembers.map(
    (member) => `- \`${member.relationship}\`: ${member.ref} - ${sentence(member.reason)}`,
  );
  if (cluster.members.length > visibleMembers.length) {
    memberLines.push(`- ${cluster.members.length - visibleMembers.length} more in the report.`);
  }
  return [
    `Relationship: \`${cluster.currentItemRelationship}\``,
    `Canonical: ${cluster.canonicalRef}`,
    `Summary: ${sentence(cluster.summary)}`,
    "",
    "Members:",
    ...memberLines,
    "",
    "Proposal only: this assessment does not dispatch repair, suppress jobs, mutate sibling items, close, or merge anything.",
  ].join("\n");
}

function publicReproducibilityLine(reproductionAssessment: string): string {
  const assessmentLine = sentence(reproductionAssessment);
  if (!assessmentLine) return "";
  const match = assessmentLine.match(/^(yes|no|unclear|not applicable)\b/i);
  if (!match) return `Reproducibility: ${assessmentLine}`;
  const status = match[1]?.toLowerCase() ?? "";
  const detail = sentence(assessmentLine.slice(match[0].length).replace(/^[\s,.:;-]+/, ""));
  return `Reproducibility: ${status}.${detail ? ` ${detail}` : ""}`;
}

export function publicSummaryBody(summaryLine: string, reproductionAssessment: string): string {
  return [summaryLine, publicReproducibilityLine(reproductionAssessment)]
    .filter(Boolean)
    .join("\n\n");
}

export function publicMergeRiskLine(
  risks: string,
  nextStepLine: string,
  bestSolutionLine: string,
  options: readonly MergeRiskOption[],
): string {
  if (isReportNoneList(risks)) return "";
  if (publicReviewTextIsSame(risks, nextStepLine)) return "";
  if (bestSolutionLine && publicReviewTextIsSame(risks, bestSolutionLine)) return "";
  const choices = options.length
    ? mergeRiskOptionsLines(options)
    : mergeRiskFallbackOptionsLines(bestSolutionLine, nextStepLine);
  return choices.length ? ["**Maintainer options:**", ...choices].join("\n") : "";
}

function mergeRiskFallbackOptionsLines(bestSolutionLine: string, nextStepLine: string): string[] {
  const recommended = sentence(bestSolutionLine) || sentence(nextStepLine);
  const instruction = recommended || "Decide whether the merge risk is acceptable before merging.";
  return mergeRiskOptionsLines([
    {
      title: "Decide the mitigation before merge",
      body: instruction,
      category: "fix_before_merge",
      recommended: false,
      automergeInstruction: "",
    },
    {
      title: "Pause or close",
      body: "Do not merge this PR until maintainers decide whether the risk is worth taking.",
      category: "pause_or_close",
      recommended: false,
      automergeInstruction: "",
    },
  ]);
}

function mergeRiskOptionsLines(options: readonly MergeRiskOption[]): string[] {
  const lines = options.flatMap((option, index) => [
    `${index + 1}. **${option.title}${option.recommended ? " (recommended)" : ""}**  `,
    `   ${option.body}`,
  ]);
  const recommendedRepair = options.find(
    (option) =>
      option.recommended &&
      option.category === "fix_before_merge" &&
      option.automergeInstruction.trim(),
  );
  if (recommendedRepair) {
    lines.push("", mergeRiskAutomergeInstructionBlock(recommendedRepair.automergeInstruction));
  }
  return lines;
}

function mergeRiskAutomergeInstructionBlock(instruction: string): string {
  const specialInstructions = normalizeMergeRiskAutomergeInstruction(instruction);
  if (!specialInstructions) return "";
  return [
    "<details>",
    "<summary>Copy recommended automerge instruction</summary>",
    "",
    "```text",
    "@clawsweeper automerge",
    "",
    "Special instructions:",
    specialInstructions,
    "```",
    "",
    "</details>",
  ].join("\n");
}

function normalizeMergeRiskAutomergeInstruction(instruction: string): string {
  return instruction
    .trim()
    .replace(/^@clawsweeper\s+(?:automerge|autofix)\b[:\s-]*/i, "")
    .replace(/^special instructions:\s*/i, "")
    .replace(/^this PR:\s*/i, "")
    .trim();
}

export function appendReviewQuestionDetails(
  details: string[],
  reproductionAssessment: string | undefined,
  solutionAssessment: string | undefined,
): void {
  const append = (heading: string, body: string) => {
    if (details.length) details.push("");
    details.push(heading, "", body);
  };
  const reproductionLine = sentence(reproductionAssessment ?? "");
  if (reproductionLine) {
    append("Do we have a high-confidence way to reproduce the issue?", reproductionLine);
  }
  const solutionLine = sentence(solutionAssessment ?? "");
  if (solutionLine) {
    append("Is this the best way to solve the issue?", solutionLine);
  }
}

function reviewWorkflowLines(): string[] {
  return [
    "- ClawSweeper keeps one durable marker-backed review comment per issue or PR.",
    "- Re-runs edit this comment so the latest verdict, findings, and automation markers stay together instead of adding duplicate bot comments.",
    "- A fresh review can be triggered by eligible `@clawsweeper re-review` comments, exact-item GitHub events, scheduled/background review runs, or manual workflow dispatch.",
    "- PR/issue authors and users with repository write access can comment `@clawsweeper re-review` or `@clawsweeper re-run` on an open PR or issue to request a fresh review only.",
    "- Maintainers can also comment `@clawsweeper review` to request a fresh review only.",
    "- Fresh-review commands do not start repair, autofix, rebase, CI repair, or automerge.",
    "- Maintainer-only repair and merge flows require explicit commands such as `@clawsweeper autofix`, `@clawsweeper automerge`, `@clawsweeper fix ci`, or `@clawsweeper address review`.",
    "- Maintainers can comment `@clawsweeper explain` to ask for more context, or `@clawsweeper stop` to stop active automation.",
  ];
}

export function reviewWorkflowCallout(): string[] {
  return [collapsedDetailsBlock("How this review workflow works", reviewWorkflowLines()), ""];
}

// PR comments keep the workflow to one line inside the collapsed details; issue
// comments keep the full callout.
export function reviewWorkflowSummaryLine(): string {
  return "ClawSweeper edits this one comment on every review. Comment `@clawsweeper re-review` for a fresh review only; repair and merge need explicit maintainer commands such as `@clawsweeper autofix` or `@clawsweeper automerge`.";
}

export function reviewFreshnessText(markdown: string, revision?: number): string {
  const timestamp = formatReviewFreshnessTimestamp(frontMatterValue(markdown, "reviewed_at"));
  if (!timestamp) return "";
  const revisionSuffix = revision !== undefined && revision >= 2 ? ` (Revision ${revision})` : "";
  return `_Reviewed ${timestamp}${revisionSuffix}._`;
}

export const REVIEW_HISTORY_RENDER_SLOT = "CLAWSWEEPER_REVIEW_HISTORY_RENDER_SLOT";

export function reviewHistoryForRender(
  markdown: string,
  previousReviewCommentBody: string | undefined,
): ReviewHistoryLedger {
  if (frontMatterValue(markdown, "type") !== "pull_request") {
    return { cycles: [], totalCompletedCycles: 0 };
  }
  const body = previousReviewCommentBody ?? "";
  if (!body.trim()) return { cycles: [], totalCompletedCycles: 0 };
  const history = parseReviewHistory(body);
  const previousCycle = reviewHistoryCycleFromCommentBody(body);
  if (!previousCycle) return history;
  const reviewedAt = frontMatterValue(markdown, "reviewed_at");
  if (
    reviewedAt &&
    (previousCycle.reviewedAt === reviewedAt ||
      Date.parse(previousCycle.reviewedAt) === Date.parse(reviewedAt))
  ) {
    return history;
  }
  return appendReviewHistoryCycle(history, previousCycle);
}

export function reviewHistoryForStaleComment(
  previousReviewCommentBody: string | undefined,
): ReviewHistoryLedger {
  const body = previousReviewCommentBody ?? "";
  const history = parseReviewHistory(body);
  return appendReviewHistoryCycle(history, reviewHistoryCycleFromCommentBody(body));
}
