import { PR_CLOSE_COVERAGE_PROOF_SECTION, REVIEW_SECTIONS } from "./clawsweeper-policy.js";
import type {
  CanonicalPullRequestCommentSyncBlock,
  Item,
  ItemContext,
  LinkedPullRequestSupersession,
  PrCloseCoverageProofCoveringWitness,
  PrCloseCoverageProofGateBlock,
  PrCloseCoverageProofGateResult,
  PrCloseCoverageRuntimeBudget,
  PrRating,
  PullRequestRef,
} from "./clawsweeper-types.js";
import {
  compactPrCloseCoverageProofComment,
  compactPrCloseCoverageProofText,
  formatPrCloseCoverageProofDetailList,
  prCloseCoverageProofCandidateCanClose,
  prCloseCoverageProofCloseDecision,
  prCloseCoverageProofEnvelopePath,
  prCloseCoverageProofPromptSha256,
  prCloseCoverageProofSnapshotSha256,
  readPrCloseCoverageProofEnvelope,
  runPrCloseCoverageProofModel,
  validatePrCloseCoverageProofEnvelopeBinding,
  writePrCloseCoverageProofEnvelope,
  type PrCloseCoverageProofPullRequestView,
  type PrCloseCoverageProofRuntime,
} from "./pr-close-coverage-proof.js";
import type { CreateReportOrchestrationDependencies } from "./clawsweeper-report-orchestration-dependencies.js";
import type { createReportOrchestrationFoundation } from "./clawsweeper-orchestration-foundation.js";
import type { createPullRequestPromotionFacts } from "./clawsweeper-promotion-facts.js";
import type { createReportRendering } from "./clawsweeper-report-rendering.js";

export function createPullRequestCoverageProof(
  dependencies: CreateReportOrchestrationDependencies &
    ReturnType<typeof createReportOrchestrationFoundation> &
    ReturnType<typeof createPullRequestPromotionFacts> &
    Pick<
      ReturnType<typeof createReportRendering>,
      "renderPrRatingAssessmentReportSection" | "renderRootCauseClusterAssessmentReportSection"
    >,
) {
  const {
    GitHubRuntimeBudgetError,
    asRecord,
    defaultRootCauseCluster,
    filterReviewContextComments,
    frontMatterStringArray,
    frontMatterValue,
    ghJson,
    ghPagedContextWindow,
    ghPagedLinkHeaderContextWindow,
    linkedPullCannotSupersedeDocsOnlySource,
    linkedPullRequestFiles,
    linkedPullRequestHasSupersessionSignal,
    linkedPullRequestLabels,
    linkedPullRequestRefsFromReport,
    linkedPullRequestSignalContextsFromText,
    mergeRiskOptionsFromReport,
    numberOrUndefined,
    parseGitHubItemRef,
    pullHeadShaFromContext,
    pullRequestUrlForNumber,
    renderPrRatingAssessmentReportSection,
    renderRootCauseClusterAssessmentReportSection,
    replaceFrontMatterValue,
    replaceSectionValue,
    reportPrRating,
    reportRealBehaviorProof,
    reportRootCauseCluster,
    reviewSectionValue,
    runtimeBudgetExceeded,
    sectionLineValue,
    sectionValue,
    sentence,
    sha256,
    stringOrUndefined,
    targetRepo,
    timeoutWithinRuntimeBudget,
    unsafeCanonicalPullRequestReason,
  } = dependencies;

  function duplicateCanonicalPullRequestBlockReason(
    markdown: string,
    item: Item,
    options: { reportDirs?: readonly string[] } = {},
  ): string | null {
    if (item.kind !== "pull_request") return null;
    for (const ref of prCloseCoverageProofCandidateRefs(markdown, item)) {
      const { number } = ref;
      try {
        const pull = asRecord(ghJson<unknown>(["api", `repos/${targetRepo()}/pulls/${number}`]));
        const linkedFiles = linkedPullRequestFiles(number);
        const linkedPull: LinkedPullRequestSupersession = {
          number,
          title: stringOrUndefined(pull.title) ?? `PR #${number}`,
          url: stringOrUndefined(pull.html_url) ?? pullRequestUrlForNumber(number),
          state: stringOrUndefined(pull.state)?.toLowerCase() ?? "",
          mergedAt: stringOrUndefined(pull.merged_at) ?? null,
          mergeableState: stringOrUndefined(pull.mergeable_state)?.toLowerCase() ?? null,
          draft: pull.draft === true,
          labels: linkedPullRequestLabels(number, pull),
          files: linkedFiles.files,
          filesKnown: linkedFiles.known,
        };
        if (linkedPullCannotSupersedeDocsOnlySource(markdown, linkedPull)) {
          return `linked canonical PR #${number} does not cover the docs-only source diff; refusing duplicate/superseded auto-close`;
        }
        const reason = unsafeCanonicalPullRequestReason(linkedPull, options);
        if (reason) return `${reason}; refusing duplicate/superseded auto-close`;
      } catch (error) {
        if (error instanceof GitHubRuntimeBudgetError) throw error;
        if (ref.kind !== "pull_url" && shorthandRefIsIssue(number)) continue;
        return `linked canonical PR #${number} could not be read; refusing duplicate/superseded auto-close`;
      }
    }
    return null;
  }

  function shorthandRefIsIssue(number: number): boolean {
    try {
      const issue = asRecord(ghJson<unknown>(["api", `repos/${targetRepo()}/issues/${number}`]));
      return !issue.pull_request;
    } catch {
      return false;
    }
  }

  function linkedRefCanBePullRequest(ref: PullRequestRef): boolean {
    if (ref.kind === "pull_url") return true;
    try {
      ghJson<unknown>(["api", `repos/${targetRepo()}/pulls/${ref.number}`]);
      return true;
    } catch {
      return !shorthandRefIsIssue(ref.number);
    }
  }

  const PR_CLOSE_COVERAGE_PROOF_MAX_CANDIDATES_PER_ITEM = 4;

  function prCloseCoverageProofCandidateRefs(markdown: string, item: Item): PullRequestRef[] {
    if (item.kind !== "pull_request") return [];
    const linkedRefs = linkedPullRequestRefsFromReport(markdown, item.number);
    const canonicalRefs = linkedRefs
      .filter((ref) => linkedPullRequestHasSupersessionSignal(markdown, item.number, ref.number))
      .filter(linkedRefCanBePullRequest);
    if (canonicalRefs.length > 0) {
      return canonicalRefs.slice(0, PR_CLOSE_COVERAGE_PROOF_MAX_CANDIDATES_PER_ITEM);
    }
    if (frontMatterValue(markdown, "pr_close_coverage_proof_fallback_refs") === "false") return [];
    const possiblePullRequestRefs = linkedRefs.filter(linkedRefCanBePullRequest);
    return possiblePullRequestRefs.length === 1 ? possiblePullRequestRefs : [];
  }

  function possibleCanonicalPullRequestRefsFromReport(
    markdown: string,
    item: Item,
  ): PullRequestRef[] {
    if (item.kind !== "pull_request") return [];
    const pendingCanonicalNumber = staleCanonicalPullRequestNumber(markdown);
    if (pendingCanonicalNumber) {
      return [{ number: pendingCanonicalNumber, kind: "pull_url" }];
    }
    const structuredCanonicalRef = reportRootCauseCluster(markdown).canonicalRef;
    if (structuredCanonicalRef) {
      const parsed = parseGitHubItemRef(structuredCanonicalRef, "root_cause_cluster.canonicalRef");
      if (parsed.kind === "pull_request" && parsed.number !== item.number) {
        return [{ number: parsed.number, kind: "pull_url" }];
      }
    }
    const linkedRefs = linkedPullRequestRefsFromReport(markdown, item.number);
    const canonicalRefs = linkedRefs
      .filter((ref) => linkedPullRequestHasSupersessionSignal(markdown, item.number, ref.number))
      .filter(linkedRefCanBePullRequest);
    if (canonicalRefs.length > 0) return canonicalRefs;
    if (frontMatterValue(markdown, "pr_close_coverage_proof_fallback_refs") === "false") return [];
    const possiblePullRequestRefs = linkedRefs.filter(linkedRefCanBePullRequest);
    return possiblePullRequestRefs.length === 1 ? possiblePullRequestRefs : [];
  }

  function canonicalPullRequestCommentSyncBlock(
    markdown: string,
    item: Item,
  ): CanonicalPullRequestCommentSyncBlock | null {
    for (const ref of possibleCanonicalPullRequestRefsFromReport(markdown, item)) {
      const { number } = ref;
      try {
        const pull = asRecord(ghJson<unknown>(["api", `repos/${targetRepo()}/pulls/${number}`]));
        const state = stringOrUndefined(pull.state)?.toLowerCase() ?? "";
        const mergedAt = stringOrUndefined(pull.merged_at) ?? null;
        if (state === "closed" && !mergedAt) {
          return {
            kind: "closed_unmerged",
            number,
            reason: `linked canonical PR #${number} is closed and unmerged; refusing duplicate/superseded auto-close`,
          };
        }
      } catch (error) {
        if (error instanceof GitHubRuntimeBudgetError) throw error;
        if (ref.kind !== "pull_url" && shorthandRefIsIssue(number)) continue;
        return {
          kind: "unreadable",
          number,
          reason: `linked canonical PR #${number} could not be read; refusing duplicate/superseded comment sync`,
        };
      }
    }
    return null;
  }

  function prCloseCoverageRuntimeBudgetBlock(
    runtimeBudget: PrCloseCoverageRuntimeBudget | undefined,
    phase: string,
  ): PrCloseCoverageProofGateResult {
    if (
      !runtimeBudget ||
      !runtimeBudgetExceeded(runtimeBudget.startedAtMs, runtimeBudget.maxRuntimeMs, Date.now())
    ) {
      return null;
    }
    return {
      status: "blocked",
      block: {
        actionTaken: "skipped_runtime_budget",
        reason: `max runtime ${runtimeBudget.maxRuntimeMs}ms reached ${phase} PR close coverage proof`,
      },
    };
  }

  function prCloseCoverageRuntime(
    runtime: PrCloseCoverageProofRuntime,
    runtimeBudget: PrCloseCoverageRuntimeBudget | undefined,
  ): PrCloseCoverageProofRuntime | null {
    if (!runtimeBudget) return runtime;
    const timeoutMs = timeoutWithinRuntimeBudget(
      runtimeBudget.startedAtMs,
      runtimeBudget.maxRuntimeMs,
      runtime.timeoutMs,
      Date.now(),
    );
    return timeoutMs === null ? null : { ...runtime, timeoutMs };
  }

  function sourcePrCloseCoveragePullRequestView(
    item: Item,
    context: ItemContext,
  ): PrCloseCoverageProofPullRequestView {
    const issue = asRecord(context.issue);
    const pull = asRecord(context.pullRequest);
    return {
      number: item.number,
      title: stringOrUndefined(pull.title) ?? stringOrUndefined(issue.title) ?? item.title,
      url: item.url,
      state: "open",
      mergedAt: null,
      body: compactPrCloseCoverageProofText(
        stringOrUndefined(pull.body) ?? stringOrUndefined(issue.body) ?? "",
      ),
      updatedAt: item.updatedAt,
      headSha: pullHeadShaFromContext(context) ?? null,
      comments: (context.comments ?? []).map(compactPrCloseCoverageProofComment),
      commentsTruncated: Boolean(context.counts?.commentsTruncated),
    };
  }

  function coveringPrCloseCoveragePullRequestView(
    number: number,
  ): PrCloseCoverageProofPullRequestView {
    const pull = asRecord(ghJson<unknown>(["api", `repos/${targetRepo()}/pulls/${number}`]));
    const issue = asRecord(ghJson<unknown>(["api", `repos/${targetRepo()}/issues/${number}`]));
    const commentsPath = `repos/${targetRepo()}/issues/${number}/comments`;
    const commentsCount = numberOrUndefined(issue.comments);
    const commentsWindow =
      commentsCount === undefined
        ? ghPagedLinkHeaderContextWindow<unknown>(commentsPath, 40)
        : ghPagedContextWindow<unknown>(commentsPath, commentsCount, 40);
    const filteredComments = filterReviewContextComments(commentsWindow.items, number);
    return {
      number,
      title: stringOrUndefined(pull.title) ?? stringOrUndefined(issue.title) ?? `PR #${number}`,
      url:
        stringOrUndefined(pull.html_url) ??
        stringOrUndefined(issue.html_url) ??
        pullRequestUrlForNumber(number),
      state: stringOrUndefined(pull.state)?.toLowerCase() ?? "",
      mergedAt: stringOrUndefined(pull.merged_at) ?? null,
      body: compactPrCloseCoverageProofText(
        stringOrUndefined(pull.body) ?? stringOrUndefined(issue.body) ?? "",
      ),
      updatedAt: stringOrUndefined(pull.updated_at) ?? stringOrUndefined(issue.updated_at) ?? null,
      headSha: stringOrUndefined(asRecord(pull.head).sha) ?? null,
      comments: filteredComments.included.map(compactPrCloseCoverageProofComment),
      commentsTruncated: commentsWindow.truncated,
    };
  }

  function coveringPrCloseCoveragePullRequestSnapshotSha256(number: number): string {
    return prCloseCoverageProofSnapshotSha256(coveringPrCloseCoveragePullRequestView(number));
  }

  function prCloseCoverageProofSignalSnippets(
    markdown: string,
    currentNumber: number,
    linkedNumber: number,
  ): string[] {
    const texts = [
      ...frontMatterStringArray(markdown, "work_cluster_refs"),
      ...mergeRiskOptionsFromReport(markdown).flatMap((option) => [option.title, option.body]),
      reviewSectionValue(markdown, "bestSolution"),
      reviewSectionValue(markdown, "evidence"),
      reviewSectionValue(markdown, "closeComment"),
    ];
    return texts
      .flatMap((text) => linkedPullRequestSignalContextsFromText(text, currentNumber, linkedNumber))
      .map((text) => compactPrCloseCoverageProofText(text, 500))
      .filter(Boolean)
      .slice(0, 4);
  }

  function prCloseCoverageProofGateResult(options: {
    markdown: string;
    item: Item;
    context: ItemContext;
    runtime: PrCloseCoverageProofRuntime;
    requirePrecomputedProof?: boolean;
    runtimeBudget?: PrCloseCoverageRuntimeBudget;
  }): PrCloseCoverageProofGateResult {
    // This trusted timestamp precedes mutation-side hydration and validation. The
    // proof artifact's own timestamp is audit metadata, not a freshness authority.
    const proofBindingStartedAtMs = Date.now();
    const beforeCandidateResolution = prCloseCoverageRuntimeBudgetBlock(
      options.runtimeBudget,
      "before resolving",
    );
    if (beforeCandidateResolution) return beforeCandidateResolution;
    const candidateRefs = prCloseCoverageProofCandidateRefs(options.markdown, options.item);
    const afterCandidateResolution = prCloseCoverageRuntimeBudgetBlock(
      options.runtimeBudget,
      "while resolving",
    );
    if (afterCandidateResolution) return afterCandidateResolution;
    if (candidateRefs.length === 0) return null;

    const source = sourcePrCloseCoveragePullRequestView(options.item, options.context);
    const coveringViews = new Map<number, PrCloseCoverageProofPullRequestView>();
    const coveringView = (number: number): PrCloseCoverageProofPullRequestView => {
      const cached = coveringViews.get(number);
      if (cached) return cached;
      const view = coveringPrCloseCoveragePullRequestView(number);
      coveringViews.set(number, view);
      return view;
    };
    let firstKeepOpenBlock: PrCloseCoverageProofGateBlock | null = null;
    let checkedPullRequestCandidate = false;
    for (const candidateRef of candidateRefs) {
      const linkedNumber = candidateRef.number;
      const beforeHydration = prCloseCoverageRuntimeBudgetBlock(
        options.runtimeBudget,
        "before hydrating",
      );
      if (beforeHydration) return beforeHydration;
      let covering: PrCloseCoverageProofPullRequestView;
      try {
        covering = coveringView(linkedNumber);
      } catch (error) {
        if (error instanceof GitHubRuntimeBudgetError) throw error;
        const hydrationBudgetBlock = prCloseCoverageRuntimeBudgetBlock(
          options.runtimeBudget,
          "while hydrating",
        );
        if (hydrationBudgetBlock) return hydrationBudgetBlock;
        if (candidateRef.kind !== "pull_url" && shorthandRefIsIssue(linkedNumber)) continue;
        return {
          status: "blocked",
          block: {
            actionTaken: "retry_pr_close_coverage_proof",
            reason: `PR close coverage proof could not hydrate linked canonical PR #${linkedNumber}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        };
      }
      const afterHydration = prCloseCoverageRuntimeBudgetBlock(
        options.runtimeBudget,
        "while hydrating",
      );
      if (afterHydration) return afterHydration;
      checkedPullRequestCandidate = true;
      if (!prCloseCoverageProofCandidateCanClose(covering)) {
        return {
          status: "blocked",
          block: {
            actionTaken: "kept_open",
            reason: `linked canonical PR #${linkedNumber} is ${covering.state || "not open"} and unmerged; refusing duplicate/superseded auto-close`,
          },
        };
      }
      try {
        const relationshipSignalSnippets = prCloseCoverageProofSignalSnippets(
          options.markdown,
          options.item.number,
          linkedNumber,
        );
        const promptSha256 = prCloseCoverageProofPromptSha256({
          source,
          covering,
          reportMarkdown: options.markdown,
          relationshipSignalSnippets,
          promptTemplate: options.runtime.promptTemplate,
        });
        let proofStartedAtMs = proofBindingStartedAtMs;
        const envelope = options.requirePrecomputedProof
          ? readPrCloseCoverageProofEnvelope(
              prCloseCoverageProofEnvelopePath(
                options.runtime.workDir,
                source.number,
                covering.number,
              ),
            )
          : (() => {
              const proofRuntime = prCloseCoverageRuntime(options.runtime, options.runtimeBudget);
              if (!proofRuntime) {
                throw new Error("runtime budget reached before running PR close coverage proof");
              }
              proofStartedAtMs = Date.now();
              const proof = runPrCloseCoverageProofModel({
                source,
                covering,
                markdown: options.markdown,
                relationshipSignalSnippets,
                runtime: proofRuntime,
              });
              return writePrCloseCoverageProofEnvelope({
                workDir: options.runtime.workDir,
                targetRepo: targetRepo(),
                promptSha256,
                source,
                covering,
                proof,
              });
            })();
        validatePrCloseCoverageProofEnvelopeBinding(envelope, {
          targetRepo: targetRepo(),
          promptSha256,
          source,
          covering,
        });
        const proof = envelope.proof;
        const closeDecision = prCloseCoverageProofCloseDecision(proof);
        if (closeDecision.close) {
          return {
            status: "allowed",
            covering: {
              number: covering.number,
              provedAtMs: proofStartedAtMs,
              snapshotSha256: prCloseCoverageProofSnapshotSha256(covering),
              updatedAt: covering.updatedAt,
              url: covering.url,
              proof: closeDecision.proof,
            },
          };
        }
        firstKeepOpenBlock ??= {
          actionTaken: "skipped_pr_close_coverage_proof",
          reason: `PR close coverage proof kept this PR open against ${covering.url}: ${closeDecision.reason}`,
        };
      } catch (error) {
        if (error instanceof GitHubRuntimeBudgetError) throw error;
        const proofBudgetBlock = prCloseCoverageRuntimeBudgetBlock(
          options.runtimeBudget,
          "while running",
        );
        if (proofBudgetBlock) return proofBudgetBlock;
        return {
          status: "blocked",
          block: {
            actionTaken: "retry_pr_close_coverage_proof",
            reason: `PR close coverage proof ${
              options.requirePrecomputedProof ? "artifact validation" : "generation"
            } failed for linked canonical PR #${linkedNumber}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        };
      }
    }
    if (!checkedPullRequestCandidate) return null;
    return {
      status: "blocked",
      block: firstKeepOpenBlock ?? {
        actionTaken: "skipped_pr_close_coverage_proof",
        reason: "PR close coverage proof did not allow close",
      },
    };
  }

  function renderPrCloseCoverageProofReportSection(
    covering: PrCloseCoverageProofCoveringWitness,
  ): string {
    return [
      "Decision: covered",
      `Covering PR: ${covering.url}`,
      `Reason: ${covering.proof.reason}`,
      "",
      "Covered work:",
      formatPrCloseCoverageProofDetailList(covering.proof.coveredWork),
      "",
      "Unique source work:",
      formatPrCloseCoverageProofDetailList(covering.proof.uniqueSourceWork),
    ].join("\n");
  }

  function applyPrCloseCoverageProofReportSection(
    markdown: string,
    gateResult: PrCloseCoverageProofGateResult | undefined,
  ): string {
    if (gateResult?.status !== "allowed") return markdown;
    return replaceSectionValue(
      markdown,
      PR_CLOSE_COVERAGE_PROOF_SECTION,
      renderPrCloseCoverageProofReportSection(gateResult.covering),
    );
  }

  function applyPrCloseCoverageProofBlockedReport(
    markdown: string,
    block: PrCloseCoverageProofGateBlock,
  ): string {
    const previousEvidence = reviewSectionValue(markdown, "evidence");
    let next = replaceFrontMatterValue(markdown, "decision", "keep_open");
    next = replaceFrontMatterValue(next, "close_reason", "none");
    next = replaceSectionValue(
      next,
      REVIEW_SECTIONS.summary,
      `Keep this PR open. ${sentence(block.reason)}`,
    );
    next = replaceSectionValue(
      next,
      REVIEW_SECTIONS.bestSolution,
      "Keep this PR open until a linked canonical PR proves it covers this PR's unique work, or a maintainer confirms closure.",
    );
    next = replaceSectionValue(
      next,
      REVIEW_SECTIONS.evidence,
      [`- **PR close coverage proof:** ${block.reason}`, previousEvidence.trim()]
        .filter(Boolean)
        .join("\n"),
    );
    next = replaceSectionValue(next, REVIEW_SECTIONS.closeComment, "_No close comment posted._");
    return replaceSectionValue(
      next,
      PR_CLOSE_COVERAGE_PROOF_SECTION,
      ["Decision: keep_open", `Reason: ${block.reason}`].join("\n"),
    );
  }

  function applyClosedUnmergedCanonicalBlockedReport(
    markdown: string,
    block: PrCloseCoverageProofGateBlock,
    canonicalNumber: number,
  ): string {
    const rootCauseCluster = defaultRootCauseCluster();
    const nextStep =
      "Run a fresh review against current main and the current related PR state before choosing a landing or close path.";
    const rating: PrRating = {
      ...reportPrRating(markdown),
      summary:
        "The prior duplicate or superseded close path is no longer valid; retain the existing readiness tiers until a fresh review.",
      nextSteps: [nextStep],
    };
    let next = replaceFrontMatterValue(markdown, "decision", "keep_open");
    next = replaceFrontMatterValue(next, "close_reason", "none");
    next = replaceFrontMatterValue(next, "confidence", "low");
    next = replaceFrontMatterValue(next, "action_taken", "retry_stale_canonical_comment_sync");
    next = replaceFrontMatterValue(
      next,
      "stale_canonical_pull_request_number",
      String(canonicalNumber),
    );
    next = replaceFrontMatterValue(next, "close_comment_sha256", "none");
    next = replaceFrontMatterValue(next, "work_candidate", "none");
    next = replaceFrontMatterValue(next, "work_confidence", "low");
    next = replaceFrontMatterValue(next, "work_priority", "low");
    next = replaceFrontMatterValue(next, "work_status", "none");
    next = replaceFrontMatterValue(next, "work_reason_sha256", sha256(nextStep));
    next = replaceFrontMatterValue(next, "work_cluster_refs", "[]");
    next = replaceFrontMatterValue(next, "work_validation", "[]");
    next = replaceFrontMatterValue(next, "work_likely_files", "[]");
    next = replaceFrontMatterValue(next, "merge_risk_options", "[]");
    next = replaceFrontMatterValue(next, "label_justifications", "[]");
    next = replaceFrontMatterValue(next, "review_metrics", "[]");
    next = replaceFrontMatterValue(next, "root_cause_cluster", JSON.stringify(rootCauseCluster));
    next = replaceSectionValue(
      next,
      "Decision",
      [
        "Keep open: none",
        "",
        "Confidence: low",
        "",
        "Action taken: retry_stale_canonical_comment_sync",
      ].join("\n"),
    );
    next = replaceSectionValue(
      next,
      REVIEW_SECTIONS.summary,
      `Keep this PR open. ${sentence(block.reason)}`,
    );
    next = replaceSectionValue(next, REVIEW_SECTIONS.bestSolution, nextStep);
    next = replaceSectionValue(
      next,
      REVIEW_SECTIONS.solutionAssessment,
      "Needs a fresh assessment because the prior canonical PR is closed without merge.",
    );
    next = replaceSectionValue(
      next,
      REVIEW_SECTIONS.rootCauseCluster,
      renderRootCauseClusterAssessmentReportSection(rootCauseCluster),
    );
    next = replaceSectionValue(
      next,
      REVIEW_SECTIONS.prRating,
      renderPrRatingAssessmentReportSection(rating, reportRealBehaviorProof(markdown)),
    );
    next = replaceSectionValue(
      next,
      REVIEW_SECTIONS.workCandidate,
      [
        "Candidate: none",
        "",
        "Confidence: low",
        "",
        "Priority: low",
        "",
        "Status: none",
        "",
        `Reason: ${nextStep}`,
      ].join("\n"),
    );
    next = replaceSectionValue(
      next,
      REVIEW_SECTIONS.evidence,
      `- **live canonical state:** ${block.reason}`,
    );
    next = replaceSectionValue(next, REVIEW_SECTIONS.likelyOwners, "- none");
    next = replaceSectionValue(
      next,
      REVIEW_SECTIONS.risks,
      "- The current branch and related work need a fresh review before merge or closure.",
    );
    next = replaceSectionValue(next, REVIEW_SECTIONS.closeComment, "_No close comment posted._");
    return replaceSectionValue(
      next,
      PR_CLOSE_COVERAGE_PROOF_SECTION,
      ["Decision: keep_open", `Reason: ${block.reason}`].join("\n"),
    );
  }

  function staleCanonicalCommentSyncPendingReason(markdown: string): string | null {
    if (frontMatterValue(markdown, "action_taken") !== "retry_stale_canonical_comment_sync") {
      return null;
    }
    return (
      sectionLineValue(sectionValue(markdown, PR_CLOSE_COVERAGE_PROOF_SECTION), "Reason") ??
      "stale canonical close comment correction remains pending"
    );
  }

  function staleCanonicalPullRequestNumber(markdown: string): number | null {
    const number = Number(frontMatterValue(markdown, "stale_canonical_pull_request_number"));
    return Number.isInteger(number) && number > 0 ? number : null;
  }

  function completeStaleCanonicalCommentSyncReport(markdown: string): string {
    let next = replaceFrontMatterValue(
      markdown,
      "action_taken",
      "corrected_stale_canonical_comment",
    );
    next = replaceFrontMatterValue(next, "stale_canonical_pull_request_number", "none");
    const decision = sectionValue(next, "Decision");
    if (!decision) return next;
    return replaceSectionValue(
      next,
      "Decision",
      decision.replace(/^Action taken: .*$/m, "Action taken: corrected_stale_canonical_comment"),
    );
  }

  return {
    duplicateCanonicalPullRequestBlockReason,
    shorthandRefIsIssue,
    linkedRefCanBePullRequest,
    PR_CLOSE_COVERAGE_PROOF_MAX_CANDIDATES_PER_ITEM,
    prCloseCoverageProofCandidateRefs,
    possibleCanonicalPullRequestRefsFromReport,
    canonicalPullRequestCommentSyncBlock,
    prCloseCoverageRuntimeBudgetBlock,
    prCloseCoverageRuntime,
    sourcePrCloseCoveragePullRequestView,
    coveringPrCloseCoveragePullRequestView,
    coveringPrCloseCoveragePullRequestSnapshotSha256,
    prCloseCoverageProofSignalSnippets,
    prCloseCoverageProofGateResult,
    renderPrCloseCoverageProofReportSection,
    applyPrCloseCoverageProofReportSection,
    applyPrCloseCoverageProofBlockedReport,
    applyClosedUnmergedCanonicalBlockedReport,
    staleCanonicalCommentSyncPendingReason,
    staleCanonicalPullRequestNumber,
    completeStaleCanonicalCommentSyncReport,
  };
}
