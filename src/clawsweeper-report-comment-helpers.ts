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
  PublicPriority,
  RegressionAssessment,
  ReviewFinding,
  ReviewRuntime,
  RootCauseClusterAssessment,
  PublicRegressionProvenance,
  SecurityReview,
} from "./clawsweeper-types.js";
import type { RealBehaviorProofPolicy } from "./clawsweeper-proof-policy.js";
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
import type { CreateReportRenderingDependencies } from "./clawsweeper-report-rendering-dependencies.js";
import type { createReportContextRendering } from "./clawsweeper-report-context.js";

export function createReportCommentHelpers(
  dependencies: CreateReportRenderingDependencies & ReturnType<typeof createReportContextRendering>,
) {
  const {
    agentsPolicyStatusLine,
    closeClawHubHandoffBlock,
    closeEvidenceLine,
    closeIntro,
    closeOutro,
    closeReviewLineFromDecision,
    closeReviewLineFromReport,
    duplicateCanonicalLinks,
    duplicateCanonicalPathLine,
    fixedPullRequestFromReport,
    formatReviewFreshnessTimestamp,
    frontMatterValue,
    isActionablePriorityText,
    isReportNoneList,
    isRoutineCiOrReviewText,
    likelyOwnerLine,
    markdownLink,
    markdownRepository,
    normalizePublicReviewText,
    priorityLabel,
    publicHistoricalVerificationBlockerLine,
    publicPriorityFromText,
    publicRealBehaviorProofLine,
    publicReviewTextDiffers,
    publicReviewTextIsSame,
    publicRiskBulletsFromText,
    reportAgentsPolicyStatus,
    reportEvidence,
    reportLikelyOwners,
    reportRootCauseCluster,
    reportSecurityReview,
    reviewFindingLocation,
    reviewSectionValue,
    securityConcernDetailedLine,
    securityReviewLine,
    sentence,
    stripPriorityPrefix,
    workCandidateReasonText,
  } = dependencies;

  function renderCloseComment(options: {
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
  }): string {
    const evidence = options.evidence.slice(0, 6).map(closeEvidenceLine);
    const likelyOwners = (options.likelyOwners ?? []).slice(0, 5).map(likelyOwnerLine);
    const summaryLine = sentence(options.summary);
    const lines = [closeIntro(options.reason), "", summaryLine];
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
    const canonicalLinks = duplicateCanonicalLinks({
      reason: options.reason,
      bestSolutionLine,
      evidence: options.evidence,
      currentItem: options.currentItem,
    });
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
    appendReviewQuestionDetails(
      details,
      options.reproductionAssessment,
      options.solutionAssessment,
    );
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
    const outro = closeOutro(options.reason, canonicalLinks);
    if (outro) lines.push("", outro);
    if (options.reviewLine) details.push("", options.reviewLine);
    const detailsBlock = collapsedDetailsBlock("Review details", details);
    if (detailsBlock) lines.push("", detailsBlock);

    return lines.join("\n");
  }

  function renderCloseCommentFromReport(markdown: string, reason: CloseReason): string {
    return neutralizeReviewControlMarkers(
      sanitizePublicSelfReferences(
        renderCloseComment({
          reason,
          summary: reviewSectionValue(markdown, "summary"),
          bestSolution: reviewSectionValue(markdown, "bestSolution"),
          reproductionAssessment: reviewSectionValue(markdown, "reproductionAssessment"),
          solutionAssessment: reviewSectionValue(markdown, "solutionAssessment"),
          agentsPolicyStatus: reportAgentsPolicyStatus(markdown),
          evidence: reportEvidence(markdown),
          likelyOwners: reportLikelyOwners(markdown),
          fixedPullRequest: fixedPullRequestFromReport(markdown),
          regressionAssessment: dependencies.regressionAssessmentFromReport(markdown),
          regressionProvenance: dependencies.regressionProvenanceFromReport(markdown),
          securityReview: reportSecurityReview(markdown),
          rootCauseCluster: reportRootCauseCluster(markdown),
          reviewLine: closeReviewLineFromReport(markdown),
          currentItem: {
            repo: markdownRepository(markdown),
            number: Number(frontMatterValue(markdown, "number")),
            kind: (frontMatterValue(markdown, "type") as ItemKind | undefined) ?? "issue",
          },
        }),
        Number(frontMatterValue(markdown, "number")),
        (frontMatterValue(markdown, "type") as ItemKind | undefined) ?? "issue",
      ),
    );
  }

  function sanitizePublicSelfReferences(text: string, number: number, kind: ItemKind): string {
    if (!Number.isInteger(number) || number <= 0) return text;
    const noun = kind === "pull_request" ? "this PR" : "this issue";
    const escapedNumber = String(number).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const selfRefSource = `#${escapedNumber}\\b`;
    const typedSelfRef = new RegExp(
      `\\b(?:Issue|issue|PR|pr|Pull request|pull request)\\s+${selfRefSource}`,
      "g",
    );
    const closingVerbSelfRef = new RegExp(
      `\\b(Fixes|fixes|Fix|fix|Closes|closes|Resolves|resolves)\\s+${selfRefSource}`,
      "g",
    );
    const selfRef = new RegExp(selfRefSource, "g");
    return text
      .replace(closingVerbSelfRef, (_match, verb: string) => `${verb} ${noun}`)
      .replace(typedSelfRef, noun)
      .replace(selfRef, noun)
      .replace(
        /(^|[.!?]\s+)(this issue|this PR)/g,
        (_match, prefix: string, value: string) =>
          `${prefix}${value[0]?.toUpperCase()}${value.slice(1)}`,
      );
  }

  function normalizeComment(
    decision: Decision,
    git: GitInfo,
    runtime?: Pick<ReviewRuntime, "model" | "reasoningEffort">,
    item?: { repo?: string; kind?: ItemKind; number?: number },
  ): string {
    return renderCloseComment({
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
      reviewLine: closeReviewLineFromDecision(decision, git, runtime),
      currentItem: item,
    });
  }

  function reportWorkCandidateReason(markdown: string): string {
    const workCandidate = reviewSectionValue(markdown, "workCandidate");
    const reason = workCandidateReasonText(workCandidate);
    if (!reason || reason.startsWith("_No work-lane recommendation")) return "";
    return reason;
  }

  function collapsedDetailsBlock(summary: string, lines: readonly string[]): string {
    const body = lines.join("\n").trim();
    if (!body) return "";
    return ["<details>", `<summary>${summary}</summary>`, "", body, "", "</details>"].join("\n");
  }

  function appendPublicSection(lines: string[], heading: string, body: string): void {
    lines.push(`**${heading}**`, body, "");
  }

  function appendHeadingSection(lines: string[], heading: string, body: string): void {
    lines.push(`## ${heading}`, "", body, "");
  }

  function isRoutineBeforeMergeStep(value: string): boolean {
    const text = value.trim();
    if (!text) return false;
    if (
      !/\b(?:merge after (?:required )?checks are green|merge after maintainer review|normal (?:ci|maintainer review)|routine (?:ci|maintainer review)|ordinary (?:ci|maintainer review)|wait for (?:required |status )?(?:ci|checks|status checks)|no further action)\b/i.test(
        text,
      ) &&
      !/^(?:land|merge|ship|proceed|continue|wait)\b[^\n]{0,120}\bafter (?:normal |ordinary |routine )?maintainer review\b/i.test(
        text,
      )
    ) {
      return false;
    }
    if (/\b(?:do not|don['’]t|must not|never|not merge|except|unless|until)\b/i.test(text)) {
      return false;
    }
    return !isActionablePriorityText(text);
  }

  function publicBeforeMergeItems(options: {
    reviewFailed: boolean;
    proofPolicy: RealBehaviorProofPolicy;
    findings: readonly ReviewFinding[];
    securityReview: SecurityReview;
    risks: string;
    nextStep: string;
    nextStepAssessment: NextStepAssessment | undefined;
    decisionPending: boolean;
    patchQualityBlocked: boolean;
    requiredRatingSteps: readonly string[];
  }): PublicBeforeMergeItem[] {
    const items: PublicBeforeMergeItem[] = [];
    const seen = new Set<string>();
    const add = (label: string, detail: string, identity?: { distinctKey: string }) => {
      const rawDetail = stripPriorityPrefix(detail);
      const cleanDetail = sentence(stripPriorityPrefix(detail));
      // Typed findings pass a distinct key (title and location) so independent
      // findings that share remediation wording are all kept; free-form guidance
      // still de-duplicates on the detail text across sections.
      const key = normalizePublicReviewText(
        identity ? `${identity.distinctKey} ${cleanDetail}` : cleanDetail,
      );
      if (
        !cleanDetail ||
        /^none[.!]?$/i.test(rawDetail) ||
        isReportNoneList(cleanDetail) ||
        seen.has(key) ||
        (!identity && items.some((item) => !publicReviewTextDiffers(item.detail, cleanDetail)))
      ) {
        return;
      }
      seen.add(key);
      items.push({ label, detail: cleanDetail });
    };
    const addPrioritized = (text: string, fallback: PublicPriority, label: string) => {
      for (const line of publicRiskBulletsFromText(text, fallback).split("\n")) {
        const match = line.match(/^-[ \t]+\[(P[0-2])\][ \t]+(\S.*)$/);
        // Unprioritized bullets are the ones classified as routine CI or ordinary
        // maintainer review; they are not remaining merge work.
        if (match?.[1] && match[2]) {
          add(`${label} (${match[1]})`, match[2]);
        }
      }
    };

    if (options.reviewFailed) {
      add(
        "Retry ClawSweeper review",
        "ClawSweeper must complete a fresh review before readiness is known.",
      );
    }
    if (!options.reviewFailed && options.proofPolicy.proofBlocksMerge) {
      add(
        options.proofPolicy.needsContributorAction
          ? "Add real behavior proof"
          : "Resolve real behavior proof assessment",
        publicRealBehaviorProofLine(options.proofPolicy),
      );
    }
    if (!options.reviewFailed && options.proofPolicy.verificationBlocksMerge) {
      add("Resolve historical verification", publicHistoricalVerificationBlockerLine());
    }
    for (const finding of options.findings) {
      add(`${finding.title.trim()} (${priorityLabel(finding.priority)})`, finding.body, {
        distinctKey: `${finding.title} ${reviewFindingLocation(finding)}`,
      });
    }
    for (const concern of options.securityReview.concerns) {
      add(`Resolve security concern: ${concern.title.trim()}`, concern.body, {
        distinctKey: `security ${concern.title}`,
      });
    }
    if (
      options.securityReview.status === "needs_attention" &&
      options.securityReview.concerns.length === 0
    ) {
      add("Resolve security review attention item", options.securityReview.summary);
    }
    if (!isReportNoneList(options.risks)) addPrioritized(options.risks, "P1", "Resolve merge risk");
    // Producer intent controls only this item; older reports retain prose inference.
    if (options.nextStepAssessment?.kind === "required") {
      add(
        `Complete next step (${publicPriorityFromText(options.nextStepAssessment.text, "P2")})`,
        options.nextStepAssessment.text,
      );
    } else if (
      options.nextStepAssessment === undefined &&
      !isRoutineBeforeMergeStep(options.nextStep) &&
      !isRoutineCiOrReviewText(options.nextStep) &&
      isActionablePriorityText(options.nextStep) &&
      !(options.decisionPending && /\bdecision\b/i.test(options.nextStep))
    ) {
      add(
        `Complete next step (${publicPriorityFromText(options.nextStep, "P2")})`,
        options.nextStep,
      );
    }
    // Routine advice never becomes a merge blocker; a step that deduplicates against
    // an existing item still counts as represented remediation.
    let ratingRemediationRepresented = false;
    for (const step of options.requiredRatingSteps) {
      if (isRoutineBeforeMergeStep(step) || isRoutineCiOrReviewText(step)) continue;
      const cleanStep = sentence(stripPriorityPrefix(step));
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

  function publicChecklistText(value: string): string {
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

  function publicBeforeMergeBlock(items: readonly PublicBeforeMergeItem[]): string {
    if (items.length === 0) return "None.";
    return items
      .map(
        (item) =>
          `- [ ] **${publicChecklistLabel(item.label)}** - ${publicChecklistText(item.detail)}`,
      )
      .join("\n");
  }

  function publicRootCauseClusterBlock(cluster: RootCauseClusterAssessment | undefined): string {
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

  function publicSummaryBody(summaryLine: string, reproductionAssessment: string): string {
    return [summaryLine, publicReproducibilityLine(reproductionAssessment)]
      .filter(Boolean)
      .join("\n\n");
  }

  function publicMergeRiskLine(
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
    const instruction =
      recommended || "Decide whether the merge risk is acceptable before merging.";
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

  function issueReproductionHelpSuggestions(markdown: string): string[] {
    if (frontMatterValue(markdown, "type") !== "issue") return [];
    const reproductionStatus = frontMatterValue(markdown, "reproduction_status");
    const reproductionConfidence = frontMatterValue(markdown, "reproduction_confidence");
    if (reproductionStatus === "reproduced" && reproductionConfidence === "high") return [];
    const reproductionAssessment = sentence(reviewSectionValue(markdown, "reproductionAssessment"));
    if (/^yes\b/i.test(reproductionAssessment)) return [];
    const sections = [
      reviewSectionValue(markdown, "summary"),
      reproductionAssessment,
      reviewSectionValue(markdown, "solutionAssessment"),
      reviewSectionValue(markdown, "evidence"),
      reviewSectionValue(markdown, "risks"),
    ];
    const text = sections.join("\n").toLowerCase();
    const suggestions: string[] = [];
    const hasMedia = /\b(?:screenshot|screen shot|video|recording|gif|image)\b/i.test(text);
    const hasSteps = /\b(?:step|steps|command|run|click|launch|workflow)\b/i.test(text);
    const hasExpectedActual = /\bexpected\b/i.test(text) && /\bactual\b/i.test(text);
    const hasLogs = /\b(?:log|logs|terminal|console|stack trace|traceback|output|error)\b/i.test(
      text,
    );
    const hasVersionContext =
      /\b(?:version|platform|os|macos|windows|linux|browser|provider|channel|config|settings)\b/i.test(
        text,
      );
    if (!hasMedia) {
      suggestions.push("Add a screenshot or short recording showing the behavior.");
    }
    if (!hasSteps) {
      suggestions.push("Include the exact command, prompt, or workflow that triggered it.");
    }
    if (!hasExpectedActual) {
      suggestions.push("Add expected vs actual behavior.");
    }
    if (!hasLogs) {
      suggestions.push("Include redacted logs or terminal output.");
    }
    if (!hasVersionContext) {
      suggestions.push("Share version, platform, channel/provider, and relevant config details.");
    }
    return suggestions.slice(0, 3);
  }

  function appendReviewQuestionDetails(
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

  function reviewWorkflowCallout(): string[] {
    return [collapsedDetailsBlock("How this review workflow works", reviewWorkflowLines()), ""];
  }

  function reviewFreshnessText(markdown: string): string {
    const timestamp = formatReviewFreshnessTimestamp(frontMatterValue(markdown, "reviewed_at"));
    return timestamp ? ` _Reviewed ${timestamp}._` : "";
  }

  const REVIEW_HISTORY_RENDER_SLOT = "CLAWSWEEPER_REVIEW_HISTORY_RENDER_SLOT";

  const OWNED_REVIEW_SECTION_HEADINGS = new Set([
    "summary",
    "what this changes",
    "merge readiness",
    "review scores",
    "verification",
    "live proof",
    "how this fits together",
    "decision needed",
    "before merge",
    "next step",
    "next step before merge",
    "automerge follow-up",
    "autofix follow-up",
    "findings",
    "review findings",
    "security",
    "label changes",
  ]);

  function reviewHistoryForRender(
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
    if (reviewedAt && previousCycle.reviewedAt === reviewedAt) return history;
    return appendReviewHistoryCycle(history, previousCycle);
  }

  function reviewHistoryForStaleComment(
    previousReviewCommentBody: string | undefined,
  ): ReviewHistoryLedger {
    const body = previousReviewCommentBody ?? "";
    const history = parseReviewHistory(body);
    return appendReviewHistoryCycle(history, reviewHistoryCycleFromCommentBody(body));
  }

  return {
    renderCloseComment,
    renderCloseCommentFromReport,
    sanitizePublicSelfReferences,
    normalizeComment,
    reportWorkCandidateReason,
    collapsedDetailsBlock,
    appendPublicSection,
    appendHeadingSection,
    isRoutineBeforeMergeStep,
    publicBeforeMergeItems,
    publicChecklistText,
    publicChecklistLabel,
    publicBeforeMergeBlock,
    publicRootCauseClusterBlock,
    publicReproducibilityLine,
    publicSummaryBody,
    publicMergeRiskLine,
    mergeRiskFallbackOptionsLines,
    mergeRiskOptionsLines,
    mergeRiskAutomergeInstructionBlock,
    normalizeMergeRiskAutomergeInstruction,
    issueReproductionHelpSuggestions,
    appendReviewQuestionDetails,
    reviewWorkflowLines,
    reviewWorkflowCallout,
    reviewFreshnessText,
    REVIEW_HISTORY_RENDER_SLOT,
    OWNED_REVIEW_SECTION_HEADINGS,
    reviewHistoryForRender,
    reviewHistoryForStaleComment,
  };
}
