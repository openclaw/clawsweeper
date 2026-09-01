import {
  configSurfaceChangeFromContext,
  dataModelChangeFromContext,
  sqliteSchemaChangeFromContext,
} from "./clawsweeper-change-detection.js";
import { closeReasonText } from "./clawsweeper-close-reasons.js";
import { REVIEW_SECTIONS } from "./clawsweeper-policy.js";
import { hasShinyProof, themedRatingName } from "./clawsweeper-rating.js";
import {
  isRegressionAssessment,
  isPublicRegressionProvenance,
  isSuspectedRegressionProvenance,
  isVerifiedRegressionProvenance,
  regressionAssessmentPublicLine,
  regressionProvenancePublicLine,
  publicLikelyOwner,
} from "./clawsweeper-regression-provenance.js";
import type {
  Action,
  Decision,
  GitInfo,
  Item,
  ItemContext,
  PrRating,
  RealBehaviorProof,
  ReviewRuntime,
  RootCauseClusterAssessment,
} from "./clawsweeper-types.js";
import {
  reviewStructuralPullStateDigest,
  type ReviewStructuralRecord,
} from "./review-structural-cache.js";
import type { CreateReportRenderingDependencies } from "./clawsweeper-report-rendering-dependencies.js";
import type { createReportContextRendering } from "./clawsweeper-report-context.js";
import type { createReportCommentHelpers } from "./clawsweeper-report-comment-helpers.js";
import {
  fitPrHydrationSnapshotToPublicationLimit,
  serializePrHydrationSnapshot,
} from "./pr-hydration-snapshot.js";

export function localCheckoutAccessForDecision(
  decision: Pick<Decision, "localCheckoutAccess">,
): "verified" | "unverified" {
  return decision.localCheckoutAccess === "verified" ? "verified" : "unverified";
}

export function localCheckoutAccessSourceForDecision(
  decision: Pick<Decision, "localCheckoutAccess">,
): "runner_preflight_v1" | "unknown" {
  return decision.localCheckoutAccess === undefined ? "unknown" : "runner_preflight_v1";
}

export function reviewStatusForDecision(
  decision: Pick<Decision, "localCheckoutAccess" | "summary">,
): "complete" | "failed" {
  return localCheckoutAccessForDecision(decision) === "verified" &&
    !decision.summary.startsWith("Codex review failed")
    ? "complete"
    : "failed";
}

export function createReportDocumentRendering(
  dependencies: CreateReportRenderingDependencies &
    ReturnType<typeof createReportContextRendering> &
    ReturnType<typeof createReportCommentHelpers>,
) {
  const {
    compactPullFilePaths,
    confidenceText,
    contextCountText,
    fileUrl,
    fixedInText,
    formatTimestamp,
    jsonFrontMatterValue,
    labelJustificationsMarkdown,
    linkedRelease,
    linkedSha,
    markdownLink,
    prSurfaceFilesFromContext,
    priorityLabel,
    publicLikelyOwnerRole,
    pullHeadShaFromContext,
    renderReviewContextBudget,
    replaceFrontMatterValue,
    reviewFindingLocation,
    reviewStructuralPullStateFromContext,
    reviewTelemetryNumber,
    runtimeReviewText,
    securityConcernLocation,
    sentence,
    sha256,
    splitFileAndLine,
    workStatusForDecision,
  } = dependencies;

  function markdownList(values: string[]): string {
    return values.length ? values.map((value) => `- ${value}`).join("\n") : "- none";
  }

  function renderWorkCandidateReportSection(decision: Decision): string {
    const lines = [
      `Candidate: ${decision.workCandidate}`,
      "",
      `Confidence: ${decision.workConfidence}`,
      "",
      `Priority: ${decision.workPriority}`,
      "",
      `Status: ${workStatusForDecision(decision)}`,
    ];
    const workReason = decision.workReason.trim();
    if (workReason) lines.push("", `Reason: ${workReason}`);

    const includeDetails =
      decision.workCandidate !== "none" ||
      decision.workClusterRefs.length > 0 ||
      decision.workLikelyFiles.length > 0 ||
      decision.workValidation.length > 0;
    if (includeDetails) {
      lines.push("", "Cluster refs:", "", markdownList(decision.workClusterRefs));
      lines.push("", "Likely files:", "", markdownList(decision.workLikelyFiles));
      lines.push("", "Validation:", "", markdownList(decision.workValidation));
    }
    return lines.join("\n");
  }

  function renderRepairWorkPromptReportSection(decision: Decision): string {
    const workPrompt = decision.workPrompt.trim();
    return workPrompt ? `\n\n## ${REVIEW_SECTIONS.repairWorkPrompt}\n\n${workPrompt}` : "";
  }

  function renderMaintainerDecisionReportSection(decision: Decision): string {
    const maintainerDecision = decision.maintainerDecision;
    if (!maintainerDecision.required) return "Required: false";
    const options = maintainerDecision.options
      .map(
        (option) =>
          `- **${option.title}${option.recommended ? " (recommended)" : ""}:** ${option.body}`,
      )
      .join("\n");
    return [
      "Required: true",
      "",
      `Kind: ${maintainerDecision.kind}`,
      "",
      `Question: ${maintainerDecision.question}`,
      "",
      `Rationale: ${maintainerDecision.rationale}`,
      "",
      `Likely owner: ${maintainerDecision.likelyOwner.person}`,
      "",
      `Owner reason: ${maintainerDecision.likelyOwner.reason}`,
      "",
      `Owner confidence: ${maintainerDecision.likelyOwner.confidence}`,
      "",
      "Options:",
      "",
      options,
    ].join("\n");
  }

  function renderVisionFitReportSection(decision: Decision): string {
    return [
      `Status: ${decision.visionFit}`,
      "",
      `Implementation complexity: ${decision.implementationComplexity}`,
      "",
      `Auto implementation candidate: ${decision.autoImplementationCandidate}`,
      "",
      `Reason: ${sentence(decision.visionFitReason)}`,
      "",
      "Vision evidence:",
      "",
      markdownList(decision.visionFitEvidence),
    ].join("\n");
  }

  function renderReviewFindingsReportSection(decision: Decision): string {
    const lines = [
      `Overall correctness: ${decision.overallCorrectness}`,
      "",
      `Overall confidence: ${confidenceText(decision.overallConfidenceScore)}`,
      "",
      "Full review comments:",
      "",
    ];
    if (!decision.reviewFindings.length) {
      lines.push("- none");
      return lines.join("\n");
    }
    lines.push(
      decision.reviewFindings
        .map((finding) =>
          [
            `- **[${priorityLabel(finding.priority)}] ${finding.title}:** \`${reviewFindingLocation(
              finding,
            )}\``,
            `  - body: ${sentence(finding.body)}`,
            ...(finding.lateFinding ? ["  - late: true"] : []),
            `  - confidence: ${confidenceText(finding.confidenceScore)}`,
          ].join("\n"),
        )
        .join("\n"),
    );
    return lines.join("\n");
  }

  function renderSecurityReviewReportSection(decision: Decision): string {
    const lines = [
      `Status: ${decision.securityReview.status}`,
      "",
      `Summary: ${sentence(decision.securityReview.summary)}`,
      "",
      "Concerns:",
      "",
    ];
    if (!decision.securityReview.concerns.length) {
      lines.push("- none");
      return lines.join("\n");
    }
    lines.push(
      decision.securityReview.concerns
        .map((concern) => {
          const location = securityConcernLocation(concern);
          const heading =
            location === "not tied to a single file"
              ? `- **[${concern.severity}] ${concern.title}:**`
              : `- **[${concern.severity}] ${concern.title}:** \`${location}\``;
          return [
            heading,
            `  - body: ${sentence(concern.body)}`,
            `  - confidence: ${confidenceText(concern.confidenceScore)}`,
          ].join("\n");
        })
        .join("\n"),
    );
    return lines.join("\n");
  }

  function renderRealBehaviorProofReportSection(decision: Decision): string {
    return [
      `Status: ${decision.realBehaviorProof.status}`,
      "",
      `Evidence kind: ${decision.realBehaviorProof.evidenceKind}`,
      "",
      `Needs contributor action: ${decision.realBehaviorProof.needsContributorAction}`,
      "",
      `Summary: ${sentence(decision.realBehaviorProof.summary)}`,
    ].join("\n");
  }

  function renderPrRatingAssessmentReportSection(
    rating: PrRating,
    realBehaviorProof: RealBehaviorProof,
  ): string {
    const nextSteps = rating.nextSteps.length
      ? rating.nextSteps.map((step) => `- ${step}`).join("\n")
      : "- none";
    const shiny = hasShinyProof(realBehaviorProof) ? " ✨" : "";
    return [
      `Overall tier: ${rating.overallTier}`,
      "",
      `Proof tier: ${rating.proofTier}`,
      "",
      `Patch tier: ${rating.patchTier}`,
      "",
      `Overall label: ${themedRatingName(rating.overallTier)}`,
      "",
      `Proof label: ${themedRatingName(rating.proofTier)}${shiny}`,
      "",
      `Patch label: ${themedRatingName(rating.patchTier)}`,
      "",
      `Summary: ${sentence(rating.summary)}`,
      "",
      "Next rank-up steps:",
      "",
      nextSteps,
    ].join("\n");
  }

  function renderPrRatingReportSection(decision: Decision): string {
    return renderPrRatingAssessmentReportSection(decision.prRating, decision.realBehaviorProof);
  }

  function renderTelegramVisibleProofReportSection(decision: Decision): string {
    return [
      `Status: ${decision.telegramVisibleProof.status}`,
      "",
      `Summary: ${sentence(decision.telegramVisibleProof.summary)}`,
    ].join("\n");
  }

  function renderLiveProofReportSection(decision: Decision): string {
    return [
      `Status: ${decision.liveProofPlan.status}`,
      "",
      `Surface: ${decision.liveProofPlan.surface}`,
      "",
      `Terminal completion: ${decision.liveProofPlan.terminalCompletion}`,
      "",
      `Reason: ${sentence(decision.liveProofPlan.reason)}`,
      "",
      `Payoff: ${decision.liveProofPlan.payoff.kind}`,
      "",
      `Payoff justification: ${sentence(decision.liveProofPlan.payoff.justification)}`,
      "",
      `Entry: ${decision.liveProofPlan.entry.trim()}`,
      "",
      "Steps:",
      "",
      decision.liveProofPlan.steps.length
        ? markdownList(decision.liveProofPlan.steps.map((step) => JSON.stringify(step)))
        : "[]",
    ].join("\n");
  }

  function renderMantisRecommendationReportSection(decision: Decision): string {
    return [
      `Status: ${decision.mantisRecommendation.status}`,
      "",
      `Scenario: ${decision.mantisRecommendation.scenario}`,
      "",
      `Reason: ${sentence(decision.mantisRecommendation.reason)}`,
      "",
      `Maintainer comment: ${decision.mantisRecommendation.maintainerComment.trim()}`,
    ].join("\n");
  }

  function renderFeatureShowcaseReportSection(decision: Decision): string {
    return [
      `Status: ${decision.featureShowcase.status}`,
      "",
      `Reason: ${sentence(decision.featureShowcase.reason)}`,
    ].join("\n");
  }

  function renderRootCauseClusterAssessmentReportSection(
    rootCauseCluster: RootCauseClusterAssessment,
  ): string {
    const members = rootCauseCluster.members.length
      ? rootCauseCluster.members
          .map(
            (member) => `- **${member.relationship}:** ${member.ref}\n  - reason: ${member.reason}`,
          )
          .join("\n")
      : "- none";
    return [
      `Current item relationship: ${rootCauseCluster.currentItemRelationship}`,
      "",
      `Confidence: ${rootCauseCluster.confidence}`,
      "",
      `Canonical ref: ${rootCauseCluster.canonicalRef ?? "none"}`,
      "",
      `Summary: ${sentence(rootCauseCluster.summary)}`,
      "",
      "Members:",
      members,
    ].join("\n");
  }

  function renderRootCauseClusterReportSection(decision: Decision): string {
    return renderRootCauseClusterAssessmentReportSection(decision.rootCauseCluster);
  }

  function renderAgentsPolicyStatusReportSection(decision: Decision): string {
    return [
      `Status: ${decision.agentsPolicyStatus.status}`,
      "",
      `Found: ${decision.agentsPolicyStatus.found}`,
      "",
      `Read fully: ${decision.agentsPolicyStatus.readFully}`,
      "",
      `Applied: ${decision.agentsPolicyStatus.applied}`,
      "",
      `Summary: ${sentence(decision.agentsPolicyStatus.summary)}`,
    ].join("\n");
  }

  function pullRequestFilePathsFromContextForTest(context: { pullFiles?: unknown[] }): string[] {
    return (context.pullFiles ?? []).flatMap(compactPullFilePaths);
  }

  function pullRequestFilePathsFromContext(context: ItemContext): string[] {
    return pullRequestFilePathsFromContextForTest(context);
  }

  function updateReviewStructuralFrontMatter(
    markdown: string,
    record: ReviewStructuralRecord | null,
    cacheHit: boolean,
  ): string {
    let next = replaceFrontMatterValue(
      markdown,
      "review_structural_cache_version",
      record ? String(record.version) : "unknown",
    );
    next = replaceFrontMatterValue(
      next,
      "review_structural_fingerprint",
      record?.fingerprint ?? "unknown",
    );
    next = replaceFrontMatterValue(
      next,
      "review_structural_source_revision",
      record?.sourceRevision ?? "unknown",
    );
    next = replaceFrontMatterValue(
      next,
      "review_structural_item_state_digest",
      record?.itemStateDigest ?? "unknown",
    );
    next = replaceFrontMatterValue(
      next,
      "review_structural_context_revision",
      record?.contextRevision ?? "unknown",
    );
    next = replaceFrontMatterValue(
      next,
      "review_structural_activity_updated_at",
      record?.activityUpdatedAt ?? "unknown",
    );
    next = replaceFrontMatterValue(
      next,
      "review_structural_relation_sensitive",
      record ? String(record.relationSensitive) : "unknown",
    );
    next = replaceFrontMatterValue(
      next,
      "review_structural_target_head_sha",
      record?.targetHeadSha ?? "unknown",
    );
    next = replaceFrontMatterValue(
      next,
      "review_structural_pull_head_sha",
      record ? (record.pullHeadSha ?? "none") : "unknown",
    );
    next = replaceFrontMatterValue(
      next,
      "review_structural_pull_state_digest",
      record ? (record.pullStateDigest ?? "none") : "unknown",
    );
    return replaceFrontMatterValue(
      next,
      "review_structural_cache_hit",
      cacheHit ? "true" : "false",
    );
  }

  function markdownFor(options: {
    item: Item;
    context: ItemContext;
    decision: Decision;
    git: GitInfo;
    action: Action;
    reviewMode: "propose" | "apply";
    snapshotHash: string;
    contentDigest: string;
    reviewPolicy: string;
    runtime: ReviewRuntime;
    structuralRecord?: ReviewStructuralRecord | null;
    reviewLeaseOwner?: string;
    reviewLeaseCommentId?: number;
  }): string {
    const labels = options.item.labels.length ? options.item.labels.join(", ") : "none";
    const reviewedAt = new Date().toISOString();
    const fixedPullRequest = options.decision.fixedPullRequest;
    const regressionProvenance = isPublicRegressionProvenance(options.decision.regressionProvenance)
      ? options.decision.regressionProvenance
      : null;
    const regressionAssessment = isRegressionAssessment(options.decision.regressionAssessment)
      ? options.decision.regressionAssessment
      : null;
    const regressionProvenanceLine = regressionProvenancePublicLine(
      regressionProvenance,
      regressionAssessment,
    );
    const regressionAssessmentLine = regressionAssessmentPublicLine(regressionAssessment, {
      predecessorAttributed: regressionProvenance?.evidenceType === "rewrite_equivalent",
    });
    const verifiedRegressionProvenance = isVerifiedRegressionProvenance(regressionProvenance)
      ? regressionProvenance
      : null;
    const suspectedRegressionProvenance = isSuspectedRegressionProvenance(regressionProvenance)
      ? regressionProvenance
      : null;
    const regressionPublicLines = [
      regressionProvenanceLine,
      !verifiedRegressionProvenance ? regressionAssessmentLine : null,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n\n");
    const evidence = options.decision.evidence.length
      ? options.decision.evidence
          .map((entry) => {
            const bits = [`- **${entry.label}:** ${entry.detail}`];
            if (entry.file) {
              const parsed = splitFileAndLine(entry.file, entry.line);
              const label = `${parsed.file}${parsed.line ? `:${parsed.line}` : ""}`;
              bits.push(
                `  - file: ${markdownLink(label, fileUrl(parsed.file, entry.sha ?? options.git.mainSha, parsed.line))}`,
              );
            }
            if (entry.command) bits.push(`  - command: \`${entry.command}\``);
            if (entry.sha) bits.push(`  - sha: ${linkedSha(entry.sha)}`);
            return bits.join("\n");
          })
          .join("\n")
      : "- none";
    const risks = options.decision.risks.length
      ? options.decision.risks.map((risk) => `- ${risk}`).join("\n")
      : "- none";
    const likelyOwners = options.decision.likelyOwners.length
      ? options.decision.likelyOwners
          .map(publicLikelyOwner)
          .map((owner) => {
            const bits = [`- **${owner.person}:** ${publicLikelyOwnerRole(owner.role)}`];
            if (owner.attributionSource)
              bits.push(`  - attribution source: ${owner.attributionSource}`);
            bits.push(`  - reason: ${owner.reason}`);
            bits.push(`  - confidence: ${owner.confidence}`);
            if (owner.commits.length) bits.push(`  - commits: ${owner.commits.join(", ")}`);
            if (owner.files.length) bits.push(`  - files: ${owner.files.join(", ")}`);
            return bits.join("\n");
          })
          .join("\n")
      : "- none";
    const bestSolution = options.decision.bestSolution.trim() || "_Not provided._";
    const maintainerDecision = renderMaintainerDecisionReportSection(options.decision);
    const reproductionAssessment =
      options.decision.reproductionAssessment.trim() || "_Not provided._";
    const solutionAssessment = options.decision.solutionAssessment.trim() || "_Not provided._";
    const visionFit = renderVisionFitReportSection(options.decision);
    const rootCauseCluster = renderRootCauseClusterReportSection(options.decision);
    const reviewFindings = renderReviewFindingsReportSection(options.decision);
    const securityReview = renderSecurityReviewReportSection(options.decision);
    const realBehaviorProof = renderRealBehaviorProofReportSection(options.decision);
    const prRating = renderPrRatingReportSection(options.decision);
    const telegramVisibleProof = renderTelegramVisibleProofReportSection(options.decision);
    const liveProof = renderLiveProofReportSection(options.decision);
    const mantisRecommendation = renderMantisRecommendationReportSection(options.decision);
    const featureShowcase = renderFeatureShowcaseReportSection(options.decision);
    const agentsPolicyStatus = renderAgentsPolicyStatusReportSection(options.decision);
    const workCandidateSection = renderWorkCandidateReportSection(options.decision);
    const repairWorkPromptSection = renderRepairWorkPromptReportSection(options.decision);
    const pullFiles = pullRequestFilePathsFromContext(options.context);
    const pullFilesTruncated = Boolean(options.context.counts?.pullFilesTruncated);
    const configSurfaceChange = configSurfaceChangeFromContext(options.item.repo, options.context);
    const dataModelChange = dataModelChangeFromContext(options.item.repo, options.context);
    const sqliteSchemaChange = sqliteSchemaChangeFromContext(options.item.repo, options.context);
    const prSurfaceFiles = prSurfaceFilesFromContext(options.context);
    const reviewedPullStateDigest = reviewStructuralPullStateFromContext(options.context);
    const markdown = `---
number: ${options.item.number}
repository: ${options.item.repo}
type: ${options.item.kind}
title: ${JSON.stringify(options.item.title)}
url: ${options.item.url}
state_at_review: open
item_created_at: ${options.item.createdAt}
item_updated_at: ${options.item.updatedAt}
author: ${options.item.author}
author_association: ${options.item.authorAssociation}
labels: ${JSON.stringify(options.item.labels)}
bulk_filer_detected: ${options.context.bulkFiler?.detected === true}
reviewed_at: ${reviewedAt}
review_lease_owner: ${options.reviewLeaseOwner ?? "unknown"}
review_lease_comment_id: ${options.reviewLeaseCommentId ?? "unknown"}
main_sha: ${options.git.mainSha}
pull_head_sha: ${pullHeadShaFromContext(options.context) ?? "unknown"}
pr_hydration_snapshot: ${serializePrHydrationSnapshot(options.context.prHydrationSnapshot)}
reviewed_pull_state_digest: ${
      reviewedPullStateDigest
        ? (reviewStructuralPullStateDigest(reviewedPullStateDigest) ?? "unknown")
        : "unknown"
    }
latest_release: ${options.git.latestRelease?.tagName ?? "unknown"}
latest_release_sha: ${options.git.latestRelease?.sha ?? "unknown"}
fixed_release: ${options.decision.fixedRelease ?? "unknown"}
fixed_sha: ${options.decision.fixedSha ?? "unknown"}
fixed_at: ${options.decision.fixedAt ?? "unknown"}
fixed_pr_url: ${fixedPullRequest?.url ?? "unknown"}
fixed_pr_number: ${fixedPullRequest?.number ?? "unknown"}
fixed_pr_title: ${fixedPullRequest ? JSON.stringify(fixedPullRequest.title) : "unknown"}
fixed_pr_merged_at: ${fixedPullRequest?.mergedAt ?? "unknown"}
fixed_pr_sha: ${fixedPullRequest?.sha ?? "unknown"}
fixed_pr_confidence: ${fixedPullRequest?.confidence ?? "unknown"}
fixed_pr_source: ${fixedPullRequest ? JSON.stringify(fixedPullRequest.source) : "unknown"}
regression_assessment_confidence: ${regressionAssessment?.confidence ?? "unknown"}
regression_assessment_evidence: ${regressionAssessment?.supportingEvidence.join(",") ?? "unknown"}
regression_provenance_repo: ${verifiedRegressionProvenance?.repo ?? "unknown"}
regression_provenance_pr_url: ${verifiedRegressionProvenance?.pullRequestUrl ?? "unknown"}
regression_provenance_pr_number: ${verifiedRegressionProvenance?.pullRequestNumber ?? "unknown"}
regression_provenance_merge_sha: ${verifiedRegressionProvenance?.mergeCommitSha ?? "unknown"}
regression_provenance_source_path: ${regressionProvenance?.sourcePath ?? "unknown"}
regression_provenance_source_line: ${regressionProvenance?.sourceLine ?? "unknown"}
regression_provenance_evidence_type: ${regressionProvenance?.evidenceType ?? "unknown"}
regression_provenance_verification_source: ${regressionProvenance?.verificationSource ?? "unknown"}
regression_provenance_merged_at: ${verifiedRegressionProvenance?.mergedAt ?? "unknown"}
regression_provenance_reviewed_sha: ${regressionProvenance && "reviewedCommitSha" in regressionProvenance ? regressionProvenance.reviewedCommitSha : "unknown"}
regression_provenance_source_commit_sha: ${regressionProvenance?.sourceCommitSha ?? "unknown"}
regression_provenance_source_author: ${regressionProvenance?.sourceAuthor ?? "unknown"}
regression_provenance_related_pr_url: ${suspectedRegressionProvenance?.relatedPullRequestUrl ?? "unknown"}
regression_provenance_related_pr_number: ${suspectedRegressionProvenance?.relatedPullRequestNumber ?? "unknown"}
regression_provenance_related_repo: ${suspectedRegressionProvenance?.relatedRepo ?? "unknown"}
review_policy: ${options.reviewPolicy}
review_model: ${options.runtime.model}
review_reasoning_effort: ${options.runtime.reasoningEffort}
review_sandbox: ${options.runtime.sandboxMode ?? "unknown"}
review_service_tier: ${options.runtime.serviceTier || "default"}
review_prompt_chars: ${reviewTelemetryNumber(options.runtime.promptChars)}
review_static_prompt_chars: ${reviewTelemetryNumber(options.runtime.staticPromptChars)}
review_context_chars: ${reviewTelemetryNumber(options.runtime.contextChars)}
review_schema_chars: ${reviewTelemetryNumber(options.runtime.schemaChars)}
review_additional_prompt_chars: ${reviewTelemetryNumber(options.runtime.additionalPromptChars)}
review_context_elapsed_ms: ${reviewTelemetryNumber(options.runtime.contextElapsedMs)}
review_codex_elapsed_ms: ${reviewTelemetryNumber(options.runtime.codexElapsedMs)}
review_mode: ${options.reviewMode}
review_status: ${reviewStatusForDecision(options.decision)}
review_terminal_failure: ${options.decision.codexTerminalFailure === true}
review_checkout_inspection_failed: ${options.decision.checkoutInspectionFailed === true}
local_checkout_access: ${localCheckoutAccessForDecision(options.decision)}
local_checkout_access_source: ${localCheckoutAccessSourceForDecision(options.decision)}
item_snapshot_hash: ${options.snapshotHash}
review_content_digest: ${options.contentDigest}
last_full_review_at: ${reviewedAt}
last_full_review_decision: ${options.decision.decision}
last_full_review_bulk_filer_detected: ${options.context.bulkFiler?.detected === true}
review_cache_hit: false
review_structural_cache_version: ${options.structuralRecord?.version ?? "unknown"}
review_structural_fingerprint: ${options.structuralRecord?.fingerprint ?? "unknown"}
review_structural_source_revision: ${options.structuralRecord?.sourceRevision ?? "unknown"}
review_structural_item_state_digest: ${options.structuralRecord?.itemStateDigest ?? "unknown"}
review_structural_context_revision: ${options.structuralRecord?.contextRevision ?? "unknown"}
review_structural_activity_updated_at: ${options.structuralRecord?.activityUpdatedAt ?? "unknown"}
review_structural_relation_sensitive: ${
      options.structuralRecord ? options.structuralRecord.relationSensitive : "unknown"
    }
review_structural_target_head_sha: ${options.structuralRecord?.targetHeadSha ?? "unknown"}
review_structural_pull_head_sha: ${
      options.structuralRecord ? (options.structuralRecord.pullHeadSha ?? "none") : "unknown"
    }
review_structural_pull_state_digest: ${
      options.structuralRecord ? (options.structuralRecord.pullStateDigest ?? "none") : "unknown"
    }
review_structural_cache_hit: false
item_source_revision: ${options.context.sourceRevision ?? "unknown"}
review_timeline_revision: ${options.context.timelineRevision ?? "unknown"}
review_activity_cursor: ${options.context.pullReviewActivityCursor ?? "unknown"}
close_comment_sha256: ${options.action.closeComment ? sha256(options.action.closeComment) : "none"}
review_comment_sha256: none
review_comment_id: unknown
review_comment_url: unknown
decision: ${options.decision.decision}
close_reason: ${options.decision.closeReason}
confidence: ${options.decision.confidence}
action_taken: ${options.action.actionTaken}
work_candidate: ${options.decision.workCandidate}
work_confidence: ${options.decision.workConfidence}
work_priority: ${options.decision.workPriority}
work_status: ${workStatusForDecision(options.decision)}
work_reason_sha256: ${options.decision.workReason ? sha256(options.decision.workReason) : "none"}
work_prompt_sha256: ${options.decision.workPrompt ? sha256(options.decision.workPrompt) : "none"}
work_cluster_refs: ${jsonFrontMatterValue(options.decision.workClusterRefs)}
root_cause_cluster: ${JSON.stringify(options.decision.rootCauseCluster)}
work_validation: ${jsonFrontMatterValue(options.decision.workValidation)}
work_likely_files: ${jsonFrontMatterValue(options.decision.workLikelyFiles)}
maintainer_decision: ${JSON.stringify(options.decision.maintainerDecision)}
triage_priority: ${options.decision.triagePriority}
impact_labels: ${jsonFrontMatterValue(options.decision.impactLabels)}
merge_risk_labels: ${jsonFrontMatterValue(options.decision.mergeRiskLabels)}
maturity_labels: ${jsonFrontMatterValue(options.decision.maturityLabels)}
merge_risk_options: ${JSON.stringify(options.decision.mergeRiskOptions)}
review_metrics: ${JSON.stringify(options.decision.reviewMetrics)}
label_justifications: ${JSON.stringify(options.decision.labelJustifications)}
pull_files: ${jsonFrontMatterValue(pullFiles)}
pull_files_truncated: ${pullFilesTruncated}
config_surface_change: ${configSurfaceChange.change}
config_surface_keys: ${jsonFrontMatterValue(configSurfaceChange.keys)}
data_model_change: ${dataModelChange.change}
data_model_surfaces: ${jsonFrontMatterValue(dataModelChange.surfaces)}
sqlite_schema_change: ${sqliteSchemaChange.change}
sqlite_schema_files: ${jsonFrontMatterValue(sqliteSchemaChange.files)}
pr_surface_files: ${jsonFrontMatterValue(prSurfaceFiles ?? [])}
pr_surface_files_truncated: ${prSurfaceFiles === null}
item_category: ${options.decision.itemCategory}
reproduction_status: ${options.decision.reproductionStatus}
reproduction_confidence: ${options.decision.reproductionConfidence}
requires_new_feature: ${options.decision.requiresNewFeature}
requires_new_config_option: ${options.decision.requiresNewConfigOption}
requires_product_decision: ${options.decision.requiresProductDecision}
vision_fit: ${options.decision.visionFit}
vision_fit_evidence: ${jsonFrontMatterValue(options.decision.visionFitEvidence)}
implementation_complexity: ${options.decision.implementationComplexity}
auto_implementation_candidate: ${options.decision.autoImplementationCandidate}
real_behavior_proof_status: ${options.decision.realBehaviorProof.status}
real_behavior_proof_evidence_kind: ${options.decision.realBehaviorProof.evidenceKind}
real_behavior_proof_needs_contributor_action: ${options.decision.realBehaviorProof.needsContributorAction}
pr_rating_overall: ${options.decision.prRating.overallTier}
pr_rating_proof: ${options.decision.prRating.proofTier}
pr_rating_patch: ${options.decision.prRating.patchTier}
telegram_visible_proof_status: ${options.decision.telegramVisibleProof.status}
live_proof_status: ${options.decision.liveProofPlan.status}
live_proof_surface: ${options.decision.liveProofPlan.surface}
mantis_recommendation_status: ${options.decision.mantisRecommendation.status}
mantis_recommendation_scenario: ${options.decision.mantisRecommendation.scenario}
feature_showcase_status: ${options.decision.featureShowcase.status}
agents_policy_status: ${options.decision.agentsPolicyStatus.status}
---

# ${markdownLink(`#${options.item.number}: ${options.item.title}`, options.item.url)}

Type: ${options.item.kind}

URL: ${markdownLink(options.item.url, options.item.url)}

Author: ${options.item.author}

Author association: ${options.item.authorAssociation}

Labels: ${labels}

Created at: ${formatTimestamp(options.item.createdAt)}

Updated at: ${formatTimestamp(options.item.updatedAt)}

Reviewed against: ${linkedSha(options.git.mainSha)}

Codex review: ${runtimeReviewText(options.runtime)}

Latest release at review time: ${
      options.git.latestRelease?.tagName
        ? linkedRelease(options.git.latestRelease.tagName)
        : "unknown"
    }${options.git.latestRelease?.sha ? ` (${linkedSha(options.git.latestRelease.sha)})` : ""}

Fixed in: ${fixedInText(options.decision)}

${regressionPublicLines || "Regression provenance: not assessed."}

## Decision

${options.decision.decision === "close" ? "Close" : "Keep open"}: ${closeReasonText(options.decision.closeReason)}

Confidence: ${options.decision.confidence}

Action taken: ${options.action.actionTaken}

## Label Justifications

${labelJustificationsMarkdown(options.decision.labelJustifications)}

## ${REVIEW_SECTIONS.summary}

${options.decision.summary}

## ${REVIEW_SECTIONS.changeSummary}

${options.decision.changeSummary}

## ${REVIEW_SECTIONS.systemContext}

${options.decision.systemContext}

## ${REVIEW_SECTIONS.architectureDiagram}

${options.decision.architectureDiagram}

## ${REVIEW_SECTIONS.bestSolution}

${bestSolution}

## ${REVIEW_SECTIONS.maintainerDecision}

${maintainerDecision}

## ${REVIEW_SECTIONS.reproductionAssessment}

${reproductionAssessment}

## ${REVIEW_SECTIONS.solutionAssessment}

${solutionAssessment}

## ${REVIEW_SECTIONS.visionFit}

${visionFit}

## ${REVIEW_SECTIONS.rootCauseCluster}

${rootCauseCluster}

## ${REVIEW_SECTIONS.reviewFindings}

${reviewFindings}

## ${REVIEW_SECTIONS.securityReview}

${securityReview}

## ${REVIEW_SECTIONS.realBehaviorProof}

${realBehaviorProof}

## ${REVIEW_SECTIONS.prRating}

${prRating}

## ${REVIEW_SECTIONS.telegramVisibleProof}

${telegramVisibleProof}

## ${REVIEW_SECTIONS.liveProof}

${liveProof}

## ${REVIEW_SECTIONS.mantisRecommendation}

${mantisRecommendation}

## ${REVIEW_SECTIONS.featureShowcase}

${featureShowcase}

## ${REVIEW_SECTIONS.agentsPolicyStatus}

${agentsPolicyStatus}

## ${REVIEW_SECTIONS.workCandidate}

${workCandidateSection}${repairWorkPromptSection}

## ${REVIEW_SECTIONS.evidence}

${evidence}

## ${REVIEW_SECTIONS.likelyOwners}

${likelyOwners}

## ${REVIEW_SECTIONS.risks}

${risks}

## ${REVIEW_SECTIONS.closeComment}

${options.action.closeComment ? options.action.closeComment : "_No close comment posted._"}

## GitHub Snapshot

- comments: ${contextCountText(
      options.context.counts?.comments,
      options.context.comments.length,
      options.context.counts?.commentsHydrated,
      options.context.counts?.commentsTruncated,
    )}
- timeline events: ${contextCountText(
      options.context.counts?.timeline,
      options.context.timeline.length,
      options.context.counts?.timelineHydrated,
      options.context.counts?.timelineTruncated,
    )}
- related items: ${options.context.counts?.relatedItems ?? options.context.relatedItems?.length ?? 0}
- PR files: ${contextCountText(
      options.context.counts?.pullFiles,
      options.context.pullFiles?.length ?? 0,
      options.context.counts?.pullFilesHydrated,
      options.context.counts?.pullFilesTruncated,
    )}
- PR commits: ${contextCountText(
      options.context.counts?.pullCommits,
      options.context.pullCommits?.length ?? 0,
      options.context.counts?.pullCommitsHydrated,
      options.context.counts?.pullCommitsTruncated,
    )}
- PR review comments: ${contextCountText(
      options.context.counts?.pullReviewComments,
      options.context.pullReviewComments?.length ?? 0,
      options.context.counts?.pullReviewCommentsHydrated,
      options.context.counts?.pullReviewCommentsTruncated,
    )}

## Review Context Budget

${renderReviewContextBudget(options.context)}

## Review Telemetry

- prompt chars: ${reviewTelemetryNumber(options.runtime.promptChars)}
- static prompt chars: ${reviewTelemetryNumber(options.runtime.staticPromptChars)}
- context chars: ${reviewTelemetryNumber(options.runtime.contextChars)}
- schema chars: ${reviewTelemetryNumber(options.runtime.schemaChars)}
- additional prompt chars: ${reviewTelemetryNumber(options.runtime.additionalPromptChars)}
- context collection ms: ${reviewTelemetryNumber(options.runtime.contextElapsedMs)}
- Codex review ms: ${reviewTelemetryNumber(options.runtime.codexElapsedMs)}
  `;
    return fitPrHydrationSnapshotToPublicationLimit(markdown);
  }

  return {
    markdownList,
    renderWorkCandidateReportSection,
    renderRepairWorkPromptReportSection,
    renderMaintainerDecisionReportSection,
    renderVisionFitReportSection,
    renderReviewFindingsReportSection,
    renderSecurityReviewReportSection,
    renderRealBehaviorProofReportSection,
    renderPrRatingAssessmentReportSection,
    renderPrRatingReportSection,
    renderTelegramVisibleProofReportSection,
    renderLiveProofReportSection,
    renderMantisRecommendationReportSection,
    renderFeatureShowcaseReportSection,
    renderRootCauseClusterAssessmentReportSection,
    renderRootCauseClusterReportSection,
    renderAgentsPolicyStatusReportSection,
    pullRequestFilePathsFromContextForTest,
    pullRequestFilePathsFromContext,
    updateReviewStructuralFrontMatter,
    markdownFor,
  };
}
