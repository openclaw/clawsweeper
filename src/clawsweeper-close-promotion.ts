import type {
  GitHubUser,
  Item,
  ItemContext,
  MergeRiskOption,
  PullRequestClosePromotion,
} from "./clawsweeper-types.js";
import type { CreateReportOrchestrationDependencies } from "./clawsweeper-report-orchestration-dependencies.js";
import type { createReportOrchestrationFoundation } from "./clawsweeper-orchestration-foundation.js";
import type { createPullRequestPromotionFacts } from "./clawsweeper-promotion-facts.js";
import type { createPullRequestCoverageProof } from "./clawsweeper-coverage-proof.js";

export function createPullRequestClosePromotion(
  dependencies: CreateReportOrchestrationDependencies &
    ReturnType<typeof createReportOrchestrationFoundation> &
    ReturnType<typeof createPullRequestPromotionFacts> &
    ReturnType<typeof createPullRequestCoverageProof>,
) {
  const {
    closePromotionHasNonAutomationActivityAfterReview,
    frontMatterValue,
    ghJson,
    ghPaged,
    isOlderThanDays,
    linkedPullRequestSupersession,
    lowSignalUnmergeablePrAuthorActivityBlockReason,
    lowSignalUnmergeablePrConflictBlockReason,
    mergeRiskOptionsFromReport,
    pullRequestHeadActivity,
    reportPrRating,
    reportRealBehaviorProof,
    reviewReportCanPromoteToClose,
    targetRepo,
  } = dependencies;

  function recommendedPauseOrCloseOption(markdown: string): MergeRiskOption | null {
    return (
      mergeRiskOptionsFromReport(markdown).find(
        (option) => option.category === "pause_or_close" && option.recommended,
      ) ?? null
    );
  }

  function staleFRatedPullRequestPromotion(
    markdown: string,
    item: Item,
    context: ItemContext,
    staleMinAgeDays: number,
  ): PullRequestClosePromotion | null {
    const proof = reportRealBehaviorProof(markdown);
    const rating = reportPrRating(markdown);
    if (rating.overallTier !== "F") return null;
    if (!isOlderThanDays(item.createdAt, staleMinAgeDays)) return null;
    if (
      proof.status !== "missing" &&
      proof.status !== "mock_only" &&
      proof.status !== "insufficient" &&
      rating.proofTier !== "F"
    ) {
      return null;
    }
    if (
      context.counts?.commentsTruncated ||
      context.counts?.timelineTruncated ||
      context.counts?.pullReviewCommentsTruncated
    ) {
      return null;
    }
    let livePull: {
      created_at?: string;
      mergeable?: boolean | null;
      mergeable_state?: string | null;
      user?: GitHubUser;
      head?: { ref?: string; repo?: { full_name?: string; id?: unknown }; sha?: string };
    };
    let reviews: unknown[];
    let headActivityAtMs: number | null;
    try {
      livePull = ghJson(["api", `repos/${targetRepo()}/pulls/${item.number}`]);
      if (lowSignalUnmergeablePrConflictBlockReason(livePull)) return null;
      reviews = ghPaged<unknown>(`repos/${targetRepo()}/pulls/${item.number}/reviews`);
      headActivityAtMs = pullRequestHeadActivity(
        item.number,
        livePull,
        context.timeline,
      ).headActivityAtMs;
    } catch {
      return null;
    }
    if (
      lowSignalUnmergeablePrAuthorActivityBlockReason({
        author: livePull.user?.login ?? item.author,
        createdAt: livePull.created_at ?? item.createdAt,
        comments: context.comments,
        reviews,
        inlineComments: context.pullReviewComments ?? [],
        timeline: context.timeline,
        headActivityAtMs,
        staleMinAgeDays,
        requireHeadActivityEvidence: true,
      })
    ) {
      return null;
    }
    return {
      closeReason: "low_signal_unmergeable_pr",
      summary:
        "Close this stale PR: the latest review rated it F, it still lacks merge-ready proof, and there has been no human follow-up after the durable review.",
      coverageProofFallbackRefs: false,
      bestSolution:
        "Close this stale PR. The latest review rated it F, the branch still lacks merge-ready proof, and there has been no human follow-up after the durable review.",
      evidence: [
        `- **stale F-rated PR:** PR was opened ${item.createdAt}, is older than ${staleMinAgeDays} days, and the latest review rated it \`F\`.`,
        `- **proof blocker:** real behavior proof is \`${proof.status}\` and proof tier is \`${rating.proofTier}\`, so this branch is not merge-ready without contributor follow-up.`,
        "- **no human follow-up:** live comments and timeline hydrated by apply contain no non-automation activity after the ClawSweeper review.",
      ].join("\n"),
      closeComment:
        "Thanks for the contribution. I’m closing this stale PR because the latest ClawSweeper review rated it F, it still lacks the proof or branch shape needed for merge, and there has been no human follow-up after the review. A fresh PR against current `main` with the requested proof is the right next step.",
    };
  }

  function pauseOrClosePromotion(
    markdown: string,
    item: Item,
    staleMinAgeDays: number,
  ): PullRequestClosePromotion | null {
    const option = recommendedPauseOrCloseOption(markdown);
    if (!option || !isOlderThanDays(item.createdAt, staleMinAgeDays)) return null;
    return {
      closeReason: "duplicate_or_superseded",
      summary: `Close this stale PR as superseded: ${option.title}.`,
      coverageProofFallbackRefs: false,
      bestSolution: `Close this stale PR as superseded: ${option.title}. ${option.body}`,
      evidence: [
        `- **recommended close path:** the latest review's recommended merge-risk option is \`${option.title}\`, categorized as \`pause_or_close\`.`,
        `- **stale PR:** PR was opened ${item.createdAt}, which is older than the ${staleMinAgeDays}-day stale promotion threshold.`,
        "- **no human follow-up:** live comments and timeline hydrated by apply contain no non-automation activity after the ClawSweeper review.",
      ].join("\n"),
      closeComment: `Thanks for the contribution. I’m closing this stale PR because the latest ClawSweeper review recommended the pause/close path: ${option.title}. ${option.body}`,
    };
  }

  function pullRequestClosePromotion(
    markdown: string,
    item: Item,
    context: ItemContext,
    staleMinAgeDays: number,
    options: { reportDirs?: readonly string[] } = {},
  ): PullRequestClosePromotion | null {
    if (item.kind !== "pull_request") return null;
    if (!reviewReportCanPromoteToClose(markdown)) return null;
    if (frontMatterValue(markdown, "decision") !== "keep_open") return null;
    if (frontMatterValue(markdown, "action_taken") !== "kept_open") return null;
    if (frontMatterValue(markdown, "review_status") !== "complete") return null;
    if (closePromotionHasNonAutomationActivityAfterReview(markdown, context)) return null;
    const linkedSupersession = linkedPullRequestSupersession(markdown, item, options);
    const pauseOrClose = pauseOrClosePromotion(markdown, item, staleMinAgeDays);
    if (pauseOrClose) return pauseOrClose;
    // Removing supersession promotion must not turn its candidates into generic
    // low-signal closures. Missing or non-covering references can still qualify.
    if (linkedSupersession.candidate || linkedSupersession.unsafeReason) return null;
    return staleFRatedPullRequestPromotion(markdown, item, context, staleMinAgeDays);
  }

  return {
    recommendedPauseOrCloseOption,
    staleFRatedPullRequestPromotion,
    pauseOrClosePromotion,
    pullRequestClosePromotion,
  };
}
