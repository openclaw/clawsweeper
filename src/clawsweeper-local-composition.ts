import { createReviewCoreRuntime } from "./clawsweeper-review-core.js";
import { createLocalRangeReviewer } from "./clawsweeper-local-review.js";
import { runLocalRangeReview } from "./clawsweeper-local-command.js";
import { reviewDecisionParser } from "./clawsweeper-decision-parser.js";
import { run, ensureDir } from "./clawsweeper-review-io.js";
import {
  REVIEW_ITEM_PROMPT_PATHS,
  CLAWSWEEPER_DECISION_SCHEMA_PATH,
  PR_CLOSE_COVERAGE_PROOF_PROMPT_PATH,
  defaultItemsDir,
  reportFileName,
} from "./clawsweeper-repository-paths.js";
import { repoFromArgs, targetRepo } from "./repository-profiles.js";
import { untrustedCodexEnv, withGitHubRun } from "./clawsweeper-github-runtime.js";
import { ghJson } from "./clawsweeper-github-execution.js";
import { createCommitPullResolver } from "./pr-review-provenance.js";
import { reviewPolicyHash } from "./clawsweeper-review-policy-hash.js";
import { suppliedReviewStartLeaseFromArgs } from "./clawsweeper-review-lease.js";
import {
  pullCommitContentRevision,
  reviewCommentContentRevision,
  itemContentDigest,
  itemSnapshotHash,
} from "./clawsweeper-source-revision.js";
import {
  extractClawSweeperReviewCommentBody,
  updateBulkFilerDetectedFrontMatter,
} from "./clawsweeper-context-hydration.js";
import { createFixedPullRequestContext } from "./clawsweeper-fixed-pull-request.js";
import { createRegressionProvenanceVerifier } from "./clawsweeper-regression-provenance.js";
import { pullHeadShaFromContext } from "./clawsweeper-review-comment-identity.js";
import { reviewActionForDecision } from "./clawsweeper-review-action.js";
import { markdownFor } from "./clawsweeper-report-document.js";
import { renderReviewCommentFromReport } from "./clawsweeper-report-comment-presentation.js";
import type { Args } from "./clawsweeper-args.js";

export function localReviewCommand(args: Args): void {
  // Read-only provenance lookups still need the native command scope. This
  // does not enroll local review in hosted admission or action publication.
  withGitHubRun(() => {
    const core = createReviewCoreRuntime({
      reviewItemPromptPaths: REVIEW_ITEM_PROMPT_PATHS,
      decisionSchemaPath: CLAWSWEEPER_DECISION_SCHEMA_PATH,
      prCloseCoverageProofPromptPath: PR_CLOSE_COVERAGE_PROOF_PROMPT_PATH,
      run,
      untrustedCodexEnv,
      ensureDir,
      defaultRootCauseCluster: reviewDecisionParser.defaultRootCauseCluster,
      parseDecision: reviewDecisionParser.parseDecision,
    });
    const buildLocalRangeReview = createLocalRangeReviewer({
      run,
      pullCommitContentRevision,
      reviewCommentContentRevision,
    });
    const { attachFixedPullRequest } = createFixedPullRequestContext();
    const verifier = createRegressionProvenanceVerifier({
      fetchPull: (repo, number) =>
        ghJson<unknown>([
          "api",
          `repos/${repo}/pulls/${number}`,
          "-H",
          "Accept: application/vnd.github+json",
        ]),
      fetchPullDiff: (repo, number) =>
        run("gh", [
          "api",
          `repos/${repo}/pulls/${number}`,
          "-H",
          "Accept: application/vnd.github.v3.diff",
        ]),
    });
    const resolveProvenancePull = createCommitPullResolver((repo, sha, deadlineAt) =>
      ghJson(
        ["api", `repos/${repo}/commits/${sha}/pulls`, "-H", "Accept: application/vnd.github+json"],
        { deadlineAt },
      ),
    );
    runLocalRangeReview(args, {
      ...core,
      buildLocalRangeReview,
      DEFAULT_PLAN_BATCH_SIZE: 3,
      defaultItemsDir,
      ensureDir,
      repoFromArgs,
      suppliedReviewStartLeaseFromArgs,
      targetRepo,
      reviewPolicyHash: (options) => reviewPolicyHash(options, core),
      itemContentDigest,
      itemSnapshotHash,
      extractClawSweeperReviewCommentBody,
      updateBulkFilerDetectedFrontMatter,
      attachFixedPullRequest,
      resolveProvenancePull,
      reviewActionForDecision,
      reportFileName,
      markdownFor,
      renderReviewCommentFromReport,
      verifyRegressionProvenance: (decision, item, context, checkoutDir, git) => ({
        ...decision,
        regressionProvenance: verifier.verify({
          candidate: decision.regressionProvenance,
          item,
          checkoutDir,
          targetBranch: git.targetBranch,
          reviewedCommitShas:
            item.kind === "pull_request"
              ? [git.mainSha, pullHeadShaFromContext(context) ?? undefined]
              : [git.mainSha],
        }),
      }),
    });
  });
}
