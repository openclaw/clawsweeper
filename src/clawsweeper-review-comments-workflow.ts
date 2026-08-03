import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  LEGACY_FIXED_CLOSE_SKIP_ACTIONS,
  LIVE_RECHECK_CLOSE_GUARD_ACTIONS,
} from "./apply-close-actions.js";
import type { createDecisionParser } from "./clawsweeper-decision-parser.js";
import type { createGitHubContext } from "./clawsweeper-github-context.js";
import type { createLabelSynchronization } from "./clawsweeper-label-sync.js";
import { closeReasonText } from "./clawsweeper-close-reasons.js";
import {
  DEFAULT_REVIEW_CODEX_TIMEOUT_MS,
  IMPACT_LABEL_NAMES,
  MATURITY_LABEL_NAMES,
  PAIR_BLOCKED_CLOSE_ACTIONS,
  PRIORITY_LABEL_NAMES,
  PR_CLOSE_COVERAGE_PROOF_SECTION,
  REVIEW_COMMENT_MARKER_PREFIX,
  REVIEW_START_STATUS_MARKER_PREFIX,
} from "./clawsweeper-policy.js";
import type { createReviewPresentation } from "./clawsweeper-review-presentation.js";
import type {
  AcquiredReviewStartLease,
  CloseReason,
  ExactReviewQueueAuthority,
  Item,
  ItemContext,
  OverallCorrectness,
  PullRequestRef,
  ReviewArtifactDestination,
  ReviewFinding,
  ReviewStartStatusCommentOptions,
  ReviewStartStatusCommentResult,
  SecurityReview,
  StalePullRequestReviewHead,
} from "./clawsweeper-types.js";
import { UserFacingCommandError } from "./command.js";
import { maintainerDecisionFromReport } from "./decision-packets.js";
import { parseGhJson } from "./github-json.js";
import {
  isGitHubRequiresAuthenticationError,
  isLockedConversationCommentError,
} from "./github-retry.js";
import { normalizeRepo } from "./repository-profiles.js";
import {
  expiredReviewStartStatusLeases,
  freshExactHeadReviewStartLease,
  supersededReviewStartStatusLeases,
} from "./repair/comment-router-core.js";
import { AUTOFIX_LABEL, AUTOMERGE_LABEL } from "./repair/exact-review-guard-labels.js";
import { trailingHtmlComments } from "./review-comment-markers.js";
import {
  neutralizeReviewControlMarkers,
  renderReviewHistorySection,
  type ReviewHistoryLedger,
} from "./review-history.js";
import type { ReviewStructuralPullState } from "./review-structural-cache.js";

interface ReviewCommentWorkflowDependencies {
  root: string;
  targetRepo: () => string;
  heldReviewStartStatusCommentResult: (
    retryAt: string,
    didMutate: boolean,
  ) => ReviewStartStatusCommentResult;
  gitHubRuntimeBudgetError: new (reason: string) => Error;
  ghObservedMutationCommand: (options: {
    identity: string;
    args: string[];
    attempts?: number | undefined;
    onMutation?: (() => void) | undefined;
    didMutate?: ((result: string) => boolean) | undefined;
    knownNoMutation?: ((error: unknown) => boolean) | undefined;
    request?: ((args: string[], attempt: number) => string) | undefined;
    prepareRequest?: ((args: string[], attempt: number) => () => string) | undefined;
    sleepBeforeRetry?: ((waitMs: number) => void) | undefined;
  }) => string;
  sha256: (value: string) => string;
  githubCount: ReturnType<typeof createGitHubContext>["githubCount"];
  ghPaged: ReturnType<typeof createGitHubContext>["ghPaged"];
  reviewCommentBodyDigest: (body: string) => string;
  asRecord: (value: unknown) => Record<string, unknown>;
  parseGitHubItemRef: ReturnType<typeof createDecisionParser>["parseGitHubItemRef"];
  reportSecurityReview: (markdown: string) => SecurityReview;
  reportReviewFindings: (markdown: string) => ReviewFinding[];
  reportOverallCorrectness: (markdown: string) => OverallCorrectness;
  ensureDir: (path: string) => void;
  frontMatterValue: (markdown: string, key: string) => string | undefined;
  replaceFrontMatterValue: (markdown: string, key: string, value: string) => string;
  sectionValue: (markdown: string, heading: string) => string;
  frontMatterStringArray: (markdown: string, key: string) => string[];
  timestampMs: (timestamp: string | undefined) => number | null;
  stringOrUndefined: (value: unknown) => string | undefined;
  sentence: ReturnType<typeof createReviewPresentation>["sentence"];
  configSurfaceReviewRequired: (markdown: string) => boolean;
  dataModelSurfaceReviewRequired: (markdown: string) => boolean;
  isIssueAdvisoryLabel: ReturnType<typeof createLabelSynchronization>["isIssueAdvisoryLabel"];
  removeIssueLabel: ReturnType<typeof createLabelSynchronization>["removeIssueLabel"];
  realBehaviorProofBlocksMerge: (markdown: string) => boolean;
  normalizedLabelSet: (labels: readonly string[]) => Set<string>;
  sectionLineValue: (section: string, label: string) => string | undefined;
  linkedPullRequestRefsFromText: (text: string, currentNumber: number) => PullRequestRef[];
  linkedPullRequestSignalContextsFromText: (
    text: string,
    currentNumber: number,
    linkedNumber: number,
  ) => string[];
  isClawSweeperOwnedLabel: (label: string) => boolean;
  reviewHistoryForStaleComment: (body: string | undefined) => ReviewHistoryLedger;
  currentReviewRevision: (item: Item) => string;
  pullRequestHeadSha: (number: number) => string;
  markdownLink: (label: string, url: string) => string;
}

export function createReviewCommentWorkflow({
  root: ROOT,
  targetRepo,
  heldReviewStartStatusCommentResult,
  gitHubRuntimeBudgetError: GitHubRuntimeBudgetError,
  ghObservedMutationCommand,
  sha256,
  githubCount,
  ghPaged,
  reviewCommentBodyDigest,
  asRecord,
  parseGitHubItemRef,
  reportSecurityReview,
  reportReviewFindings,
  reportOverallCorrectness,
  ensureDir,
  frontMatterValue,
  replaceFrontMatterValue,
  sectionValue,
  frontMatterStringArray,
  timestampMs,
  stringOrUndefined,
  sentence,
  configSurfaceReviewRequired,
  dataModelSurfaceReviewRequired,
  isIssueAdvisoryLabel,
  removeIssueLabel,
  realBehaviorProofBlocksMerge,
  normalizedLabelSet,
  sectionLineValue,
  linkedPullRequestRefsFromText,
  linkedPullRequestSignalContextsFromText,
  isClawSweeperOwnedLabel,
  reviewHistoryForStaleComment,
  currentReviewRevision,
  pullRequestHeadSha,
  markdownLink,
}: ReviewCommentWorkflowDependencies) {
  function reviewCommentMarker(number: number): string {
    return `${REVIEW_COMMENT_MARKER_PREFIX} item=${number} -->`;
  }

  function closeAppliedCommentMarker(number: number): string {
    return `<!-- clawsweeper-close-applied item=${number} -->`;
  }

  function pullHeadShaFromContext(context: ItemContext): string | null {
    const pull = asRecord(context.pullRequest);
    const head = asRecord(pull.head);
    const sha = head.sha;
    return typeof sha === "string" && sha.trim() ? sha.trim() : null;
  }

  function reviewStructuralPullStateFromContext(
    context: ItemContext,
  ): ReviewStructuralPullState | null {
    const pull = asRecord(context.pullRequest);
    const head = asRecord(pull.head);
    const base = asRecord(pull.base);
    const headSha = stringOrUndefined(head.sha);
    const baseSha = stringOrUndefined(base.sha);
    const mergeStateStatus = stringOrUndefined(pull.mergeableState);
    const additions = githubCount(pull.additions);
    const deletions = githubCount(pull.deletions);
    const changedFiles = githubCount(pull.changedFiles);
    const commitCount = context.counts?.pullCommits;
    if (
      !headSha ||
      !baseSha ||
      typeof pull.draft !== "boolean" ||
      (pull.mergeable !== null &&
        typeof pull.mergeable !== "boolean" &&
        typeof pull.mergeable !== "string") ||
      !mergeStateStatus ||
      additions === null ||
      deletions === null ||
      changedFiles === null ||
      typeof commitCount !== "number" ||
      !Number.isSafeInteger(commitCount) ||
      commitCount < 0
    ) {
      return null;
    }
    return {
      headSha,
      baseSha,
      draft: pull.draft,
      mergeable: pull.mergeable,
      mergeStateStatus,
      additions,
      deletions,
      changedFiles,
      commitCount,
    };
  }

  function pullHeadShaFromReport(markdown: string): string | null {
    const value = frontMatterValue(markdown, "pull_head_sha");
    return value && value !== "unknown" ? value : null;
  }

  function reviewLeaseRevisionFromReport(markdown: string): string | null {
    if (frontMatterValue(markdown, "type") === "pull_request") {
      return pullHeadShaFromReport(markdown);
    }
    const value = frontMatterValue(markdown, "item_source_revision");
    return value && value !== "unknown" ? value : null;
  }

  function stalePullRequestReviewHead(
    markdown: string,
    context: ItemContext,
  ): StalePullRequestReviewHead | null {
    if (frontMatterValue(markdown, "type") !== "pull_request") return null;
    const reportHeadSha = pullHeadShaFromReport(markdown);
    const liveHeadSha = pullHeadShaFromContext(context);
    if (!reportHeadSha || !liveHeadSha || reportHeadSha === liveHeadSha) return null;
    return {
      reportHeadSha,
      liveHeadSha,
      reason: `live PR head ${liveHeadSha} differs from reviewed head ${reportHeadSha}`,
    };
  }

  function freshPullRequestReviewHead(markdown: string, context: ItemContext): boolean {
    if (frontMatterValue(markdown, "type") !== "pull_request") return false;
    const reportHeadSha = pullHeadShaFromReport(markdown);
    const liveHeadSha = pullHeadShaFromContext(context);
    return Boolean(reportHeadSha && liveHeadSha && reportHeadSha === liveHeadSha);
  }

  function isStalePullRequestReviewLabel(label: string): boolean {
    return (
      isClawSweeperOwnedLabel(label) &&
      !PRIORITY_LABEL_NAMES.has(label) &&
      !IMPACT_LABEL_NAMES.has(label) &&
      !MATURITY_LABEL_NAMES.has(label) &&
      !isIssueAdvisoryLabel(label)
    );
  }

  function syncStalePullRequestReviewLabels(options: {
    number: number;
    labels: readonly string[];
    dryRun: boolean;
    onMutation?: () => void;
  }): { labels: string[]; changed: boolean } {
    const labelsToRemove = options.labels.filter(isStalePullRequestReviewLabel);
    if (labelsToRemove.length === 0) return { labels: [...options.labels], changed: false };
    const nextLabels = options.labels.filter((label) => !labelsToRemove.includes(label));
    if (!options.dryRun) {
      for (const label of labelsToRemove) {
        removeIssueLabel(options.number, label, options.onMutation);
      }
    }
    return { labels: nextLabels, changed: true };
  }

  function stalePullRequestReviewComment(options: {
    number: number;
    stale: StalePullRequestReviewHead;
    previousReviewCommentBody?: string;
  }): string {
    const attrs = [
      `item=${markerAttributeValue(String(options.number))}`,
      `reviewed_sha=${markerAttributeValue(options.stale.reportHeadSha)}`,
      `current_sha=${markerAttributeValue(options.stale.liveHeadSha)}`,
      "reason=stale_head",
    ].join(" ");
    const history = renderReviewHistorySection(
      reviewHistoryForStaleComment(options.previousReviewCommentBody),
    );
    return [
      "Codex review: stale review; fresh review needed.",
      "",
      "**Summary**",
      `The latest durable ClawSweeper review was for head \`${options.stale.reportHeadSha}\`, but the PR head is now \`${options.stale.liveHeadSha}\`. Its old verdict and PR readiness labels are no longer current.`,
      "",
      "**Next step**",
      "Run or wait for a fresh ClawSweeper review on the current PR head.",
      ...(history ? ["", history] : []),
      "",
      `<!-- clawsweeper-review-status:stale ${attrs} -->`,
    ].join("\n");
  }

  function markerAttributeValue(value: string): string {
    return value.trim().replace(/[^\w./:@-]/g, "_") || "unknown";
  }

  function reviewVersionMarkerFromReport(markdown: string): string {
    const number = frontMatterValue(markdown, "number") ?? "unknown";
    const reviewedAt = frontMatterValue(markdown, "reviewed_at") ?? "unknown";
    const headSha = pullHeadShaFromReport(markdown) ?? "na";
    const sourceRevision = frontMatterValue(markdown, "item_source_revision") ?? "unknown";
    const leaseOwner = frontMatterValue(markdown, "review_lease_owner") ?? "unknown";
    const leaseCommentId = frontMatterValue(markdown, "review_lease_comment_id") ?? "unknown";
    const attrs = [
      `item=${markerAttributeValue(number)}`,
      `reviewed_at=${markerAttributeValue(reviewedAt)}`,
      `sha=${markerAttributeValue(headSha)}`,
      `source_revision=${markerAttributeValue(sourceRevision)}`,
      `lease_owner=${markerAttributeValue(leaseOwner)}`,
      `lease_comment_id=${markerAttributeValue(leaseCommentId)}`,
      "v=1",
    ].join(" ");
    return `<!-- clawsweeper-review-version ${attrs} -->`;
  }

  function reviewAutomationMarkersFromReport(markdown: string): string {
    const itemKind = frontMatterValue(markdown, "type");
    if (itemKind === "issue") {
      const decision = frontMatterValue(markdown, "decision");
      const closeReason = frontMatterValue(markdown, "close_reason");
      if (decision !== "close" || closeReason !== "unsponsored_feature_request") return "";
      const attrs = [
        `item=${markerAttributeValue(frontMatterValue(markdown, "number") ?? "unknown")}`,
        `confidence=${markerAttributeValue(frontMatterValue(markdown, "confidence") ?? "unknown")}`,
        `updated_at=${markerAttributeValue(frontMatterValue(markdown, "item_updated_at") ?? "unknown")}`,
        `reviewed_at=${markerAttributeValue(frontMatterValue(markdown, "reviewed_at") ?? "unknown")}`,
        `source_revision=${markerAttributeValue(frontMatterValue(markdown, "item_source_revision") ?? "unknown")}`,
        `action_taken=${markerAttributeValue(frontMatterValue(markdown, "action_taken") ?? "unknown")}`,
        `reason=${markerAttributeValue(closeReason)}`,
      ].join(" ");
      return [
        `<!-- clawsweeper-verdict:close ${attrs} -->`,
        `<!-- clawsweeper-action:close-required ${attrs} -->`,
      ].join("\n");
    }
    if (itemKind !== "pull_request") return "";
    const number = frontMatterValue(markdown, "number") ?? "unknown";
    const decision = frontMatterValue(markdown, "decision");
    const confidence = frontMatterValue(markdown, "confidence") ?? "unknown";
    const headSha = pullHeadShaFromReport(markdown) ?? "unknown";
    const itemUpdatedAt = frontMatterValue(markdown, "item_updated_at") ?? "unknown";
    const reviewedAt = frontMatterValue(markdown, "reviewed_at") ?? "unknown";
    const reviewLeaseOwner = frontMatterValue(markdown, "review_lease_owner") ?? "unknown";
    const reviewLeaseCommentId = frontMatterValue(markdown, "review_lease_comment_id") ?? "unknown";
    const sourceRevision = frontMatterValue(markdown, "item_source_revision") ?? "unknown";
    const baseAttrs = [
      `item=${markerAttributeValue(number)}`,
      `sha=${markerAttributeValue(headSha)}`,
      `confidence=${markerAttributeValue(confidence)}`,
      `updated_at=${markerAttributeValue(itemUpdatedAt)}`,
      `reviewed_at=${markerAttributeValue(reviewedAt)}`,
      `lease_owner=${markerAttributeValue(reviewLeaseOwner)}`,
      `lease_comment_id=${markerAttributeValue(reviewLeaseCommentId)}`,
      `source_revision=${markerAttributeValue(sourceRevision)}`,
    ].join(" ");
    const securityNeedsAttention = reportSecurityReview(markdown).status === "needs_attention";
    const humanReviewMarkers = (): string => {
      const markers = [];
      if (securityNeedsAttention) {
        markers.push(`<!-- clawsweeper-security:security-sensitive ${baseAttrs} -->`);
      }
      markers.push(`<!-- clawsweeper-verdict:needs-human ${baseAttrs} -->`);
      return markers.join("\n");
    };

    if (maintainerDecisionFromReport(markdown)?.required) {
      return humanReviewMarkers();
    }
    if (frontMatterValue(markdown, "review_status") === "failed") {
      return humanReviewMarkers();
    }
    if (configSurfaceReviewRequired(markdown)) {
      return humanReviewMarkers();
    }
    if (dataModelSurfaceReviewRequired(markdown)) {
      return humanReviewMarkers();
    }
    if (frontMatterValue(markdown, "action_taken") === "skipped_pr_close_coverage_proof") {
      return humanReviewMarkers();
    }
    const hasRealBehaviorProofBlocker = realBehaviorProofBlocksMerge(markdown);
    if (securityNeedsAttention) {
      const markers = [`<!-- clawsweeper-security:security-sensitive ${baseAttrs} -->`];
      if (!hasRealBehaviorProofBlocker && securitySensitiveRepairAllowed(markdown)) {
        markers.push(
          `<!-- clawsweeper-verdict:needs-changes ${baseAttrs} -->`,
          `<!-- clawsweeper-action:fix-required ${baseAttrs} finding=security-review -->`,
        );
      } else {
        markers.push(`<!-- clawsweeper-verdict:needs-human ${baseAttrs} -->`);
      }
      return markers.join("\n");
    }
    if (hasRealBehaviorProofBlocker) {
      return `<!-- clawsweeper-verdict:needs-human ${baseAttrs} -->`;
    }
    if (decision === "keep_open") {
      if (repairLoopPassModeFromReport(markdown)) {
        return `<!-- clawsweeper-verdict:pass ${baseAttrs} -->`;
      }
      if (repairLoopFindingRepairAllowed(markdown)) {
        return [
          `<!-- clawsweeper-verdict:needs-changes ${baseAttrs} -->`,
          `<!-- clawsweeper-action:fix-required ${baseAttrs} finding=review-feedback -->`,
        ].join("\n");
      }
      if (frontMatterValue(markdown, "work_candidate") !== "queue_fix_pr") {
        return `<!-- clawsweeper-verdict:needs-human ${baseAttrs} -->`;
      }
      return [
        `<!-- clawsweeper-verdict:needs-changes ${baseAttrs} -->`,
        `<!-- clawsweeper-action:fix-required ${baseAttrs} finding=review-feedback -->`,
      ].join("\n");
    }
    if (decision === "close") {
      const closeReason = frontMatterValue(markdown, "close_reason") ?? "unknown";
      const actionTaken = frontMatterValue(markdown, "action_taken") ?? "unknown";
      const closeAttrs = `${baseAttrs} action_taken=${markerAttributeValue(actionTaken)} reason=${markerAttributeValue(closeReason)}`;
      return [
        `<!-- clawsweeper-verdict:close ${closeAttrs} -->`,
        `<!-- clawsweeper-action:close-required ${closeAttrs} -->`,
      ].join("\n");
    }
    return `<!-- clawsweeper-verdict:needs-human ${baseAttrs} -->`;
  }

  function repairLoopPassModeFromReport(markdown: string): "" | "autofix" | "automerge" {
    if (!isRepairLoopPassReport(markdown)) return "";
    return frontMatterStringArray(markdown, "labels").includes(AUTOFIX_LABEL)
      ? "autofix"
      : "automerge";
  }

  function securitySensitiveRepairAllowed(markdown: string): boolean {
    const labels = frontMatterStringArray(markdown, "labels");
    return (
      frontMatterValue(markdown, "decision") === "keep_open" &&
      (labels.includes(AUTOFIX_LABEL) || labels.includes(AUTOMERGE_LABEL))
    );
  }

  function repairLoopFindingRepairAllowed(markdown: string): boolean {
    const labels = frontMatterStringArray(markdown, "labels");
    return (
      (labels.includes(AUTOMERGE_LABEL) || labels.includes(AUTOFIX_LABEL)) &&
      !realBehaviorProofBlocksMerge(markdown) &&
      reportReviewFindings(markdown).length > 0
    );
  }

  function isRepairLoopPassReport(markdown: string): boolean {
    const labels = frontMatterStringArray(markdown, "labels");
    return (
      (labels.includes(AUTOMERGE_LABEL) || labels.includes(AUTOFIX_LABEL)) &&
      frontMatterValue(markdown, "review_status") === "complete" &&
      frontMatterValue(markdown, "confidence") === "high" &&
      frontMatterValue(markdown, "decision") === "keep_open" &&
      !configSurfaceReviewRequired(markdown) &&
      !dataModelSurfaceReviewRequired(markdown) &&
      !realBehaviorProofBlocksMerge(markdown) &&
      reportOverallCorrectness(markdown) === "patch is correct" &&
      reportReviewFindings(markdown).length === 0
    );
  }

  function markedReviewCommentBody(number: number, body: string): string {
    return body.includes(reviewCommentMarker(number))
      ? body
      : `${body.trimEnd()}\n\n${reviewCommentMarker(number)}`;
  }

  function reviewStartLeaseCommentMarker(number: number): string {
    return `<!-- clawsweeper-review-lease item=${number} -->`;
  }

  function markedReviewStartLeaseCommentBody(number: number, body: string): string {
    const marker = reviewStartLeaseCommentMarker(number);
    return body.includes(marker) ? body : `${body.trimEnd()}\n\n${marker}`;
  }

  function reviewStartStatusCommentMarker(options: ReviewStartStatusCommentOptions): string {
    const startedAt = options.startedAt ?? new Date().toISOString();
    const startedAtMs = Date.parse(startedAt);
    const leaseExpiresAt =
      options.leaseExpiresAt ??
      new Date(
        (Number.isFinite(startedAtMs) ? startedAtMs : Date.now()) +
          DEFAULT_REVIEW_CODEX_TIMEOUT_MS +
          10 * 60 * 1000,
      ).toISOString();
    const attrs = [
      `item=${markerAttributeValue(String(options.number))}`,
      `sha=${markerAttributeValue(options.headSha ?? "na")}`,
      `started_at=${markerAttributeValue(startedAt)}`,
      `lease_expires_at=${markerAttributeValue(leaseExpiresAt)}`,
      ...(options.leaseOwner ? [`owner=${markerAttributeValue(options.leaseOwner)}`] : []),
      "v=1",
    ].join(" ");
    return `${REVIEW_START_STATUS_MARKER_PREFIX}:started ${attrs} -->`;
  }

  function withReviewStartStatusLease(
    body: string,
    options: ReviewStartStatusCommentOptions,
  ): string {
    return withReviewStartStatusLeaseIdentity(body, options, reviewCommentMarker(options.number));
  }

  function withReviewStartStatusLeaseIdentity(
    body: string,
    options: ReviewStartStatusCommentOptions,
    reviewMarker: string,
  ): string {
    const reviewMarkerIndex = body.lastIndexOf(reviewMarker);
    const hasTrailingReviewMarker =
      reviewMarkerIndex >= 0 && !body.slice(reviewMarkerIndex + reviewMarker.length).trim();
    const prefix = (hasTrailingReviewMarker ? body.slice(0, reviewMarkerIndex) : body)
      .trimEnd()
      .replace(/\n*<!--\s*clawsweeper-review-status:started\b[^>]*-->\s*$/i, "")
      .trimEnd();
    return [prefix, reviewStartStatusCommentMarker(options), reviewMarker]
      .filter(Boolean)
      .join("\n\n");
  }

  function shouldPreserveReviewStartLease(options: {
    currentHeadSha: string;
    reportHeadSha: string | undefined;
    reportLeaseOwner: string | undefined;
    reportLeaseCommentId: string | undefined;
    leaseOwner: string | null;
    leaseCommentId: number | null;
  }): boolean {
    const currentHeadSha = options.currentHeadSha.trim().toLowerCase();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(currentHeadSha)) return true;
    const reportHeadSha = options.reportHeadSha?.trim().toLowerCase();
    if (reportHeadSha !== currentHeadSha) return true;
    const reportLeaseOwner = options.reportLeaseOwner?.trim();
    if (!options.leaseOwner || !reportLeaseOwner || reportLeaseOwner !== options.leaseOwner) {
      return true;
    }
    if (options.leaseCommentId === null) return true;
    const reportLeaseCommentId = Number(options.reportLeaseCommentId);
    return (
      !Number.isInteger(reportLeaseCommentId) || reportLeaseCommentId !== options.leaseCommentId
    );
  }

  function renderReviewStartStatusComment(options: ReviewStartStatusCommentOptions): string {
    const purpose = options.purpose ?? "review";
    const subject = options.kind === "pull_request" ? "pull request" : "issue";
    const progress =
      Number.isInteger(options.position) && Number.isInteger(options.total)
        ? ` This is item ${options.position}/${options.total} in the current shard.`
        : "";
    const shard =
      Number.isInteger(options.shardIndex) && Number.isInteger(options.shardCount)
        ? ` Shard ${options.shardIndex}/${options.shardCount}.`
        : "";
    const title = neutralizeReviewControlMarkers(options.title.trim());
    const heading =
      purpose === "apply"
        ? title
          ? `I am applying the reviewed decision for this ${subject}: ${title}`
          : `I am applying the reviewed decision for this ${subject}.`
        : title
          ? `I am starting a fresh review of this ${subject}: ${title}`
          : `I am starting a fresh review of this ${subject}.`;
    const body = [
      purpose === "apply"
        ? "ClawSweeper status: applying reviewed decision."
        : "ClawSweeper status: review started.",
      "",
      `${heading}${progress}${shard}`,
      "",
      purpose === "apply"
        ? "This transient lease prevents a newer review from overlapping label, comment, or close mutations."
        : "This placeholder means the worker is alive and reading the current context. I will edit this same comment with the actual review when the claws are done clicking.",
      "",
      "Crustacean status: shell secured, claws on keyboard, evidence pebbles being sorted.",
      "",
      reviewStartStatusCommentMarker(options),
    ].join("\n");
    return markedReviewStartLeaseCommentBody(options.number, body);
  }

  function isCodexReviewCommentBody(body: string): boolean {
    return (
      body.includes("Codex review:") ||
      body.includes("Codex review notes:") ||
      body.includes("Codex Review notes:") ||
      body.includes("Codex automated review:") ||
      body.includes("after Codex review.") ||
      body.includes("after Codex automated review.")
    );
  }

  function fetchIssueReviewComments(number: number): Record<string, unknown>[] {
    return ghPaged<unknown>(`repos/${targetRepo()}/issues/${number}/comments`).map(asRecord);
  }

  function selectIssueReviewComment(
    number: number,
    comments: Record<string, unknown>[],
    fallbackBodies: readonly string[] = [],
  ): Record<string, unknown> | undefined {
    const marker = reviewCommentMarker(number);
    const markedComments = comments.filter((candidate) => {
      const body = candidate.body;
      return typeof body === "string" && body.includes(marker);
    });
    const patchableMarked = markedComments.find(canPatchReviewComment);
    if (patchableMarked) return patchableMarked;
    const marked = markedComments[0];
    if (marked) return marked;
    const exactBodies = new Set(fallbackBodies.map((body) => body.trim()).filter(Boolean));
    const exactComments = comments.filter((candidate) => {
      const body = candidate.body;
      return typeof body === "string" && exactBodies.has(body.trim());
    });
    const patchableExact = exactComments.find(canPatchReviewComment);
    if (patchableExact) return patchableExact;
    const exact = exactComments[0];
    if (exact) return exact;
    const codexComments = comments.filter((candidate) => {
      const body = candidate.body;
      return typeof body === "string" && isCodexReviewCommentBody(body);
    });
    return codexComments.find(canPatchReviewComment) ?? codexComments[0];
  }

  function selectDedicatedReviewStartLeaseComment(
    number: number,
    comments: Record<string, unknown>[],
  ): Record<string, unknown> | undefined {
    return selectDedicatedReviewStartLeaseComments(number, comments)[0];
  }

  function selectDedicatedReviewStartLeaseComments(
    number: number,
    comments: Record<string, unknown>[],
  ): Record<string, unknown>[] {
    const marker = reviewStartLeaseCommentMarker(number);
    return comments.filter(
      (candidate) => canPatchReviewComment(candidate) && commentBody(candidate)?.includes(marker),
    );
  }

  function issueReviewCommentState(
    number: number,
    fallbackBodies: readonly string[] = [],
  ): {
    comments: Record<string, unknown>[];
    reviewComment: Record<string, unknown> | undefined;
    leaseComment: Record<string, unknown> | undefined;
    leaseComments: Record<string, unknown>[];
    dedicatedLeaseComment: Record<string, unknown> | undefined;
    dedicatedLeaseComments: Record<string, unknown>[];
  } {
    const comments = fetchIssueReviewComments(number);
    const reviewComment = selectIssueReviewComment(number, comments, fallbackBodies);
    const dedicatedLeaseComments = selectDedicatedReviewStartLeaseComments(number, comments);
    const dedicatedLeaseComment = selectDedicatedReviewStartLeaseComment(number, comments);
    const legacyLeaseComment = commentBody(reviewComment)?.includes(
      "clawsweeper-review-status:started",
    )
      ? reviewComment
      : undefined;
    const leaseComments = [
      ...dedicatedLeaseComments,
      ...(legacyLeaseComment && !dedicatedLeaseComments.includes(legacyLeaseComment)
        ? [legacyLeaseComment]
        : []),
    ];
    return {
      comments,
      reviewComment,
      leaseComment: leaseComments[0],
      leaseComments,
      dedicatedLeaseComment,
      dedicatedLeaseComments,
    };
  }

  function issueReviewComment(
    number: number,
    fallbackBodies: readonly string[] = [],
  ): Record<string, unknown> | undefined {
    return issueReviewCommentState(number, fallbackBodies).reviewComment;
  }

  function issueReviewCommentWithBody(
    number: number,
    body: string,
  ): Record<string, unknown> | undefined {
    const expected = body.trim();
    if (!expected) return undefined;
    const comments = ghPaged<unknown>(`repos/${targetRepo()}/issues/${number}/comments`).map(
      asRecord,
    );
    const exactComments = comments.filter(
      (candidate) => commentBody(candidate)?.trim() === expected,
    );
    return exactComments.find(canPatchReviewComment) ?? exactComments[0];
  }

  function commentUpdatedAt(comment: Record<string, unknown> | undefined): string | undefined {
    const updatedAt = comment?.updated_at;
    if (typeof updatedAt === "string") return updatedAt;
    const createdAt = comment?.created_at;
    return typeof createdAt === "string" ? createdAt : undefined;
  }

  function commentId(comment: Record<string, unknown> | undefined): number | null {
    const id = comment?.id;
    return typeof id === "number" && Number.isInteger(id) ? id : null;
  }

  function commentUrl(comment: Record<string, unknown> | undefined): string | null {
    const url = comment?.html_url;
    return typeof url === "string" ? url : null;
  }

  function commentBody(comment: Record<string, unknown> | undefined): string | undefined {
    const body = comment?.body;
    return typeof body === "string" ? body : undefined;
  }

  function newestReviewMarkerAttribute(
    comment: Record<string, unknown> | undefined,
    number: number,
    attribute: "reviewed_at" | "sha",
  ): string | undefined {
    if (!canPatchReviewComment(comment)) return undefined;
    const body = commentBody(comment);
    if (!body) return undefined;
    const reviewMarker = reviewCommentMarker(number);
    const reviewMarkerIndex = body.lastIndexOf(reviewMarker);
    if (reviewMarkerIndex < 0) return undefined;
    if (body.slice(reviewMarkerIndex + reviewMarker.length).trim() !== "") return undefined;
    const markerComments = trailingHtmlComments(body.slice(0, reviewMarkerIndex));
    const markerPattern = /^<!--\s+clawsweeper-verdict:[^\s>]+\b([^>]*)-->$/;
    let lastValue: string | undefined;
    for (const markerComment of markerComments) {
      const match = markerComment.match(markerPattern);
      if (!match) continue;
      const attributes = match[1] ?? "";
      if (!new RegExp(`\\bitem=${number}\\b`).test(attributes)) continue;
      const value = attributes.match(new RegExp(`\\b${attribute}=([^\\s>]+)`))?.[1];
      if (!value || value === "unknown") continue;
      lastValue = value;
    }
    return lastValue;
  }

  function durableReviewVersion(
    comment: Record<string, unknown> | undefined,
    number: number,
  ): {
    reviewedAt: string;
    headSha: string | null;
    sourceRevision: string | null;
    leaseOwner: string | null;
    leaseCommentId: string | null;
  } | null {
    if (!canPatchReviewComment(comment)) return null;
    const body = commentBody(comment);
    if (!body) return null;
    const identity = reviewCommentMarker(number);
    const identityIndex = body.lastIndexOf(identity);
    if (identityIndex < 0 || body.slice(identityIndex + identity.length).trim()) return null;
    for (const markerComment of trailingHtmlComments(body.slice(0, identityIndex)).reverse()) {
      const match = markerComment.match(/^<!--\s+clawsweeper-review-version\b([^>]*)-->$/);
      if (!match) continue;
      const attributes = match[1] ?? "";
      const attribute = (name: string) =>
        attributes.match(new RegExp(`\\b${name}=([^\\s>]+)`))?.[1] ?? null;
      if (Number(attribute("item")) !== number || attribute("v") !== "1") continue;
      const reviewedAt = attribute("reviewed_at");
      if (!reviewedAt || timestampMs(reviewedAt) === null) continue;
      const headSha = attribute("sha");
      const sourceRevision = attribute("source_revision");
      return {
        reviewedAt,
        headSha: headSha && headSha !== "na" && headSha !== "unknown" ? headSha : null,
        sourceRevision: sourceRevision && sourceRevision !== "unknown" ? sourceRevision : null,
        leaseOwner: attribute("lease_owner"),
        leaseCommentId: attribute("lease_comment_id"),
      };
    }
    return null;
  }

  function reviewCommentHasCloseVerdictForCanonical(
    comment: Record<string, unknown> | undefined,
    number: number,
    reason: CloseReason,
    canonicalNumber: number,
  ): boolean {
    if (!canPatchReviewComment(comment)) return false;
    const body = commentBody(comment);
    if (!body) return false;
    const reviewMarker = reviewCommentMarker(number);
    const reviewMarkerIndex = body.lastIndexOf(reviewMarker);
    if (reviewMarkerIndex < 0) return false;
    if (body.slice(reviewMarkerIndex + reviewMarker.length).trim() !== "") return false;
    const markerComments = trailingHtmlComments(body.slice(0, reviewMarkerIndex));
    const verdictPattern = /^<!--\s+clawsweeper-verdict:([^\s>]+)\b([^>]*)-->$/;
    let latestVerdict: { verdict: string; reason: string | undefined } | undefined;
    for (const markerComment of markerComments) {
      const match = markerComment.match(verdictPattern);
      if (!match) continue;
      const attributes = match[2] ?? "";
      if (!new RegExp(`\\bitem=${number}\\b`).test(attributes)) continue;
      latestVerdict = {
        verdict: match[1] ?? "",
        reason: attributes.match(/\breason=([^\s>]+)/)?.[1],
      };
    }
    const supersessionSignal =
      /\b(supersed(?:e|ed|es|ing)|replace(?:s|d|ment)?|duplicate|duplicated|canonical|covered by|landed in)\b/i;
    const signaledRefs = linkedPullRequestRefsFromText(body, number).filter((ref) =>
      linkedPullRequestSignalContextsFromText(body, number, ref.number).some((context) =>
        supersessionSignal.test(context),
      ),
    );
    const explicitCanonicalRefs = [...body.matchAll(/^Canonical:\s+(\S+)\s*$/gm)];
    let commentCanonicalNumber: number | undefined;
    if (explicitCanonicalRefs.length > 0) {
      const canonicalNumbers = new Set<number>();
      for (const match of explicitCanonicalRefs) {
        try {
          const parsed = parseGitHubItemRef(
            match[1] ?? "",
            "durable review comment root-cause canonical",
          );
          // The explicit public canonical is authoritative; never reinterpret a member PR as it.
          if (parsed.kind !== "pull_request") return false;
          if (normalizeRepo(parsed.repo) !== normalizeRepo(targetRepo())) return false;
          canonicalNumbers.add(parsed.number);
        } catch {
          return false;
        }
      }
      if (canonicalNumbers.size !== 1) return false;
      commentCanonicalNumber = [...canonicalNumbers][0];
    }
    if (explicitCanonicalRefs.length === 0) {
      const signaledCanonicalNumbers = new Set(signaledRefs.map((ref) => ref.number));
      if (signaledCanonicalNumbers.size !== 1) return false;
      commentCanonicalNumber = [...signaledCanonicalNumbers][0];
    }
    return (
      latestVerdict?.verdict === "close" &&
      latestVerdict.reason === reason &&
      commentCanonicalNumber === canonicalNumber
    );
  }

  function staleReviewCommentSyncReason(
    markdown: string,
    existingReviewComment: Record<string, unknown> | undefined,
    number: number,
    context?: ItemContext,
  ): string | null {
    // Comment updated_at can move for command/status edits; only review markers prove verdict freshness.
    const liveVersion = durableReviewVersion(existingReviewComment, number);
    const itemKind = frontMatterValue(markdown, "type");
    const liveReviewedAt =
      liveVersion?.reviewedAt ??
      (itemKind === "pull_request"
        ? newestReviewMarkerAttribute(existingReviewComment, number, "reviewed_at")
        : undefined);
    const liveReviewedSha =
      liveVersion?.headSha ??
      (itemKind === "pull_request"
        ? newestReviewMarkerAttribute(existingReviewComment, number, "sha")
        : undefined);
    const reportReviewedAt = frontMatterValue(markdown, "reviewed_at");
    const liveReviewedAtMs = timestampMs(liveReviewedAt);
    const reportReviewedAtMs = timestampMs(reportReviewedAt);
    if (liveReviewedAtMs === null) return null;
    const reportLeaseOwner = frontMatterValue(markdown, "review_lease_owner");
    const reportLeaseCommentId = frontMatterValue(markdown, "review_lease_comment_id");
    if (
      liveVersion?.leaseOwner &&
      liveVersion.leaseOwner !== "unknown" &&
      liveVersion.leaseOwner === reportLeaseOwner &&
      liveVersion.leaseCommentId === reportLeaseCommentId
    ) {
      return null;
    }
    const liveLeaseCommentId = Number(liveVersion?.leaseCommentId);
    const reportLeaseCommentIdNumber = Number(reportLeaseCommentId);
    const reportRevision = reviewLeaseRevisionFromReport(markdown);
    const liveRevision =
      itemKind === "pull_request" ? liveVersion?.headSha : liveVersion?.sourceRevision;
    if (
      liveRevision &&
      reportRevision &&
      liveRevision === reportRevision &&
      Number.isInteger(liveLeaseCommentId) &&
      liveLeaseCommentId > 0
    ) {
      if (!Number.isInteger(reportLeaseCommentIdNumber) || reportLeaseCommentIdNumber <= 0) {
        return `live durable review tuple has lease comment ${liveLeaseCommentId}, but the local report has no durable lease identity`;
      }
      if (liveLeaseCommentId >= reportLeaseCommentIdNumber) {
        return `live durable review tuple is newer than the local report: comment lease=${liveLeaseCommentId}, report lease=${reportLeaseCommentIdNumber}`;
      }
      // GitHub comment ids are monotonic. A report from a later lease may replace an older durable
      // marker even when worker clocks make reviewed_at ordering ambiguous.
      return null;
    }
    if (itemKind !== "pull_request") {
      if (reportReviewedAtMs !== null && liveReviewedAtMs > reportReviewedAtMs) {
        return `live durable review comment is newer than the local report: comment reviewed_at=${liveReviewedAt}, report reviewed_at=${reportReviewedAt}`;
      }
      const liveCommentUpdatedAtMs = timestampMs(commentUpdatedAt(existingReviewComment));
      if (
        reportReviewedAtMs !== null &&
        liveCommentUpdatedAtMs !== null &&
        liveCommentUpdatedAtMs > reportReviewedAtMs &&
        liveReviewedAt !== reportReviewedAt
      ) {
        return `live durable review comment was published after the local report: comment updated_at=${commentUpdatedAt(existingReviewComment)}, report reviewed_at=${reportReviewedAt}`;
      }
      return null;
    }
    const currentHeadSha = context ? pullHeadShaFromContext(context) : null;
    const reportHeadSha = pullHeadShaFromReport(markdown);
    if (!liveReviewedSha || !currentHeadSha) return null;
    // Trust a newer comment when it matches the live head, or when the live API still reports the
    // report's head and may be lagging the comment. Otherwise the newer comment is stale too.
    if (liveReviewedSha !== currentHeadSha && currentHeadSha !== reportHeadSha) return null;
    if (
      liveReviewedSha === currentHeadSha &&
      (!reportHeadSha || reportHeadSha !== liveReviewedSha || reportReviewedAtMs === null)
    ) {
      return `live durable review comment is newer than the local report: comment reviewed_at=${liveReviewedAt}, report reviewed_at=${reportReviewedAt ?? "missing"}; comment head=${liveReviewedSha}, report head=${reportHeadSha ?? "missing"}`;
    }
    if (reportReviewedAtMs === null) return null;
    if (liveReviewedAtMs <= reportReviewedAtMs) return null;
    return `live durable review comment is newer than the local report: comment reviewed_at=${liveReviewedAt}, report reviewed_at=${reportReviewedAt}`;
  }

  const APPLY_SYNC_EQUIVALENT_CLOSE_MARKER_ACTIONS = new Set([
    "proposed_close",
    "kept_open",
    "skipped_pr_close_coverage_proof",
    "retry_pr_close_coverage_proof",
    ...LEGACY_FIXED_CLOSE_SKIP_ACTIONS,
    ...LIVE_RECHECK_CLOSE_GUARD_ACTIONS,
    ...PAIR_BLOCKED_CLOSE_ACTIONS,
  ]);

  function normalizeApplySyncCloseMarkerAction(body: string): string {
    return body.replace(
      /(<!-- clawsweeper-(?:verdict:close|action:close-required)\b[^>]*\s)action_taken=([^\s>]+)(?=\s|-->)/g,
      (match, prefix: string, action: string) =>
        APPLY_SYNC_EQUIVALENT_CLOSE_MARKER_ACTIONS.has(action)
          ? `${prefix}action_taken=proposed_close`
          : match,
    );
  }

  function commentBodyMatches(
    comment: Record<string, unknown> | undefined,
    body: string,
    options: { allowApplyCloseActionUpgrade?: boolean } = {},
  ): boolean {
    const actual = commentBody(comment)?.trim();
    const expected = body.trim();
    if (actual === expected) return true;
    if (!actual || !options.allowApplyCloseActionUpgrade) return false;
    return (
      normalizeApplySyncCloseMarkerAction(actual) === normalizeApplySyncCloseMarkerAction(expected)
    );
  }

  function reviewCommentHashMatches(
    comment: Record<string, unknown> | undefined,
    body: string,
    storedHash: string | undefined,
    expectedHash: string,
    options: { allowApplyCloseActionUpgrade?: boolean } = {},
  ): boolean {
    if (storedHash === expectedHash) return true;
    if (!storedHash || !options.allowApplyCloseActionUpgrade) return false;
    const actual = commentBody(comment)?.trim();
    if (!actual) return false;
    if (
      normalizeApplySyncCloseMarkerAction(actual) !==
      normalizeApplySyncCloseMarkerAction(body.trim())
    ) {
      return false;
    }
    return storedHash === reviewCommentBodyDigest(actual);
  }

  const PATCHABLE_REVIEW_COMMENT_AUTHORS = new Set(
    [
      "clawsweeper",
      "clawsweeper[bot]",
      "openclaw-clawsweeper[bot]",
      process.env.CLAWSWEEPER_COMMENT_AUTHOR_LOGIN,
    ].filter((login): login is string => typeof login === "string" && login.length > 0),
  );

  function commentAuthorLogin(comment: Record<string, unknown> | undefined): string | undefined {
    const user = comment?.user;
    if (!user || typeof user !== "object" || Array.isArray(user)) return undefined;
    const login = (user as Record<string, unknown>).login;
    return typeof login === "string" ? login : undefined;
  }

  function canPatchReviewComment(comment: Record<string, unknown> | undefined): boolean {
    const login = commentAuthorLogin(comment);
    return Boolean(login && PATCHABLE_REVIEW_COMMENT_AUTHORS.has(login));
  }

  function lockedConversationApplyReason(
    item: Pick<Item, "activeLockReason" | "locked">,
  ): string | null {
    if (!item.locked) return null;
    return `conversation is locked${item.activeLockReason ? ` (${item.activeLockReason})` : ""}`;
  }

  function reviewArtifactDestination(
    action: string | undefined,
    itemIsOpen: boolean,
  ): ReviewArtifactDestination {
    if (!itemIsOpen) return "skip_closed";
    return action === "closed" || action === "skipped_already_closed" ? "closed" : "items";
  }

  function runtimeBudgetExceeded(
    startedAtMs: number,
    maxRuntimeMs: number,
    nowMs: number,
  ): boolean {
    return maxRuntimeMs > 0 && nowMs - startedAtMs >= maxRuntimeMs;
  }

  function removeCurrentCursorTraceItem(
    examinedItemNumbers: number[],
    currentNumber: number,
  ): void {
    if (examinedItemNumbers.at(-1) === currentNumber) examinedItemNumbers.pop();
  }

  function timeoutWithinRuntimeBudget(
    startedAtMs: number,
    maxRuntimeMs: number,
    requestedTimeoutMs: number,
    nowMs: number,
  ): number | null {
    if (maxRuntimeMs <= 0) return requestedTimeoutMs;
    const remainingMs = maxRuntimeMs - (nowMs - startedAtMs);
    return remainingMs > 0 ? Math.min(requestedTimeoutMs, remainingMs) : null;
  }

  function coverageProofRetryExhaustedRuntimeBudget(
    startedAtMs: number,
    maxRuntimeMs: number,
    actionTaken: string,
    nowMs: number,
  ): boolean {
    return (
      actionTaken === "retry_pr_close_coverage_proof" &&
      runtimeBudgetExceeded(startedAtMs, maxRuntimeMs, nowMs)
    );
  }

  function recordedLabelSyncCoversUpdate(options: {
    itemUpdatedAt: string;
    labelsSyncedAt: string | undefined;
    liveLabels: readonly string[];
    recordedLabels: readonly string[];
    hasNonAutomationActivity: boolean;
  }): boolean {
    const itemUpdatedAtMs = timestampMs(options.itemUpdatedAt);
    const labelsSyncedAtMs = timestampMs(options.labelsSyncedAt);
    if (
      itemUpdatedAtMs === null ||
      labelsSyncedAtMs === null ||
      itemUpdatedAtMs > labelsSyncedAtMs ||
      options.hasNonAutomationActivity
    ) {
      return false;
    }
    const liveLabelSet = normalizedLabelSet(options.liveLabels);
    const recordedLabelSet = normalizedLabelSet(options.recordedLabels);
    return (
      liveLabelSet.size === recordedLabelSet.size &&
      [...liveLabelSet].every((label) => recordedLabelSet.has(label))
    );
  }

  function updateReviewCommentMetadata(
    markdown: string,
    comment: Record<string, unknown> | undefined,
    body: string,
  ): string {
    let next = replaceFrontMatterValue(
      markdown,
      "review_comment_sha256",
      reviewCommentBodyDigest(body),
    );
    const id = commentId(comment);
    const url = commentUrl(comment);
    if (id !== null) next = replaceFrontMatterValue(next, "review_comment_id", String(id));
    if (url) next = replaceFrontMatterValue(next, "review_comment_url", url);
    const checkedAt = new Date().toISOString();
    next = replaceFrontMatterValue(
      next,
      "review_comment_synced_at",
      commentUpdatedAt(comment) ?? checkedAt,
    );
    next = replaceFrontMatterValue(next, "review_comment_checked_at", checkedAt);
    return next;
  }

  function writeCommentPayload(number: number, body: string): string {
    const commentFile = join(ROOT, ".artifacts", `comment-${number}.md`);
    ensureDir(dirname(commentFile));
    writeFileSync(commentFile, body, "utf8");
    const commentPayloadFile = join(ROOT, ".artifacts", `comment-${number}.json`);
    writeFileSync(commentPayloadFile, JSON.stringify({ body }), "utf8");
    return commentPayloadFile;
  }

  function upsertReviewComment(
    number: number,
    body: string,
    existing = issueReviewComment(number, [body]),
    mutationIdentity = `review_comment_upsert:${number}:${reviewCommentBodyDigest(body)}`,
  ): Record<string, unknown> | undefined {
    const markedBody = markedReviewCommentBody(number, body);
    const id = commentId(existing);
    const payload = writeCommentPayload(number, markedBody);
    let args: string[];
    if (id !== null && canPatchReviewComment(existing)) {
      args = [
        "api",
        `repos/${targetRepo()}/issues/comments/${id}`,
        "--method",
        "PATCH",
        "--input",
        payload,
      ];
    } else {
      args = [
        "api",
        `repos/${targetRepo()}/issues/${number}/comments`,
        "--method",
        "POST",
        "--input",
        payload,
      ];
    }
    const response = ghObservedMutationCommand({
      identity: mutationIdentity,
      args,
      knownNoMutation: (error) =>
        isGitHubRequiresAuthenticationError(error) || isLockedConversationCommentError(error),
    });
    const written = reviewCommentFromMutationResponse(response, args);
    if (written) return written;
    const fallback = issueReviewCommentWithBody(number, markedBody);
    if (fallback) return fallback;
    throw new Error(
      `GitHub comment mutation for #${number} did not return or expose the synced review comment`,
    );
  }

  function reviewCommentFromMutationResponse(
    response: string,
    args: readonly string[],
  ): Record<string, unknown> | undefined {
    if (!response.trim()) return undefined;
    try {
      const comment = asRecord(parseGhJson<unknown>(response, args));
      if (commentId(comment) !== null || commentUrl(comment)) {
        return comment;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  function issueCommentWithMarker(
    number: number,
    marker: string,
  ): Record<string, unknown> | undefined {
    const comments = ghPaged<unknown>(`repos/${targetRepo()}/issues/${number}/comments`).map(
      asRecord,
    );
    return comments.find((candidate) => {
      const body = candidate.body;
      return typeof body === "string" && body.includes(marker);
    });
  }

  function closeAppliedEvidenceLink(markdown: string, itemUrl: string): string {
    const reviewCommentUrl = frontMatterValue(markdown, "review_comment_url");
    if (reviewCommentUrl && reviewCommentUrl !== "unknown") {
      return markdownLink("durable ClawSweeper review", reviewCommentUrl);
    }
    const fixedPrUrl = frontMatterValue(markdown, "fixed_pr_url");
    const fixedPrNumber = frontMatterValue(markdown, "fixed_pr_number");
    if (fixedPrUrl && fixedPrUrl !== "unknown") {
      const label =
        fixedPrNumber && fixedPrNumber !== "unknown" ? `fix PR #${fixedPrNumber}` : "fix PR";
      return markdownLink(label, fixedPrUrl);
    }
    return markdownLink("closed PR", itemUrl);
  }

  function renderCloseAppliedComment(options: {
    number: number;
    closeReason: CloseReason;
    markdown: string;
    itemUrl: string;
  }): string {
    const coverageProofLine = closeAppliedCoverageProofLine(options.markdown);
    return [
      "ClawSweeper applied the proposed close for this PR.",
      "",
      "- Action: closed this PR.",
      `- Close reason: ${closeReasonText(options.closeReason)}.`,
      `- Evidence: ${closeAppliedEvidenceLink(options.markdown, options.itemUrl)}.`,
      coverageProofLine,
      "",
      closeAppliedCommentMarker(options.number),
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  }

  function closeAppliedCoverageProofLine(markdown: string): string | null {
    const proof = sectionValue(markdown, PR_CLOSE_COVERAGE_PROOF_SECTION);
    if (!proof) return null;
    const reason = sectionLineValue(proof, "Reason");
    if (!reason) return null;
    const covering = sectionLineValue(proof, "Covering PR");
    return [`- Coverage proof: ${sentence(reason)}`, covering ? ` Covering PR: ${covering}.` : ""]
      .join("")
      .trim();
  }

  function ensureCloseAppliedComment(options: {
    number: number;
    closeReason: CloseReason;
    markdown: string;
    itemUrl: string;
    dryRun: boolean;
  }): string {
    const marker = closeAppliedCommentMarker(options.number);
    if (issueCommentWithMarker(options.number, marker)) {
      return "matching ClawSweeper close-applied comment already exists";
    }
    const body = renderCloseAppliedComment(options);
    if (options.dryRun) return "dry-run: would post close-applied comment";
    const payload = writeCommentPayload(options.number, body);
    ghObservedMutationCommand({
      identity: `close_applied_comment:${options.number}:${sha256(body)}`,
      args: [
        "api",
        `repos/${targetRepo()}/issues/${options.number}/comments`,
        "--method",
        "POST",
        "--input",
        payload,
      ],
    });
    return "posted close-applied comment";
  }

  function reviewStartLeaseOwner(comment: Record<string, unknown> | undefined): string | null {
    const body = commentBody(comment) ?? "";
    const match = body.match(/<!--\s*clawsweeper-review-status:started\b([^>]*)-->/i);
    return match?.[1]?.match(/\bowner=([^\s>]+)/i)?.[1] ?? null;
  }

  function newReviewStartLeaseOwner(
    env: NodeJS.ProcessEnv = process.env,
    fallback: () => string = randomUUID,
  ): string {
    const runId = String(env.GITHUB_RUN_ID ?? "").trim();
    const runAttempt = String(env.GITHUB_RUN_ATTEMPT ?? "").trim();
    if (/^[1-9]\d*$/.test(runId) && /^[1-9]\d*$/.test(runAttempt)) {
      return `github-run-${runId}-${runAttempt}`;
    }
    return fallback();
  }

  function newReviewStartLeaseOwnerForTest(env: NodeJS.ProcessEnv, fallback: () => string): string {
    return newReviewStartLeaseOwner(env, fallback);
  }

  function exactReviewQueueAuthorityFromEnv(
    env: NodeJS.ProcessEnv = process.env,
  ): ExactReviewQueueAuthority | null {
    const raw = {
      queueUrl: String(env.EXACT_REVIEW_QUEUE_URL ?? "")
        .trim()
        .replace(/\/$/, ""),
      itemKey: String(env.EXACT_REVIEW_ITEM_KEY ?? "").trim(),
      leaseId: String(env.EXACT_REVIEW_LEASE_ID ?? "").trim(),
      leaseRevision: String(env.EXACT_REVIEW_LEASE_REVISION ?? "").trim(),
      claimGeneration: String(env.EXACT_REVIEW_CLAIM_GENERATION ?? "").trim(),
      runId: String(env.GITHUB_RUN_ID ?? "").trim(),
      runAttempt: String(env.GITHUB_RUN_ATTEMPT ?? "").trim(),
      sourceHeadSha: String(env.EXACT_REVIEW_SOURCE_HEAD_SHA ?? "")
        .trim()
        .toLowerCase(),
    };
    if (
      ![raw.queueUrl, raw.itemKey, raw.leaseId, raw.leaseRevision, raw.claimGeneration].some(
        Boolean,
      )
    ) {
      return null;
    }

    let queueUrl: URL;
    try {
      queueUrl = new URL(raw.queueUrl);
    } catch {
      throw new UserFacingCommandError("EXACT_REVIEW_QUEUE_URL must be an HTTP(S) URL.");
    }
    const leaseRevision = Number(raw.leaseRevision);
    const claimGeneration = Number(raw.claimGeneration);
    const runAttempt = Number(raw.runAttempt);
    if (
      !["http:", "https:"].includes(queueUrl.protocol) ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*$/.test(raw.itemKey) ||
      !/^[A-Za-z0-9._:-]{1,200}$/.test(raw.leaseId) ||
      !Number.isSafeInteger(leaseRevision) ||
      leaseRevision < 1 ||
      !Number.isSafeInteger(claimGeneration) ||
      claimGeneration < 1 ||
      !/^[1-9]\d{0,29}$/.test(raw.runId) ||
      !Number.isSafeInteger(runAttempt) ||
      runAttempt < 1 ||
      (raw.sourceHeadSha !== "" && !/^[0-9a-f]{40}$/.test(raw.sourceHeadSha))
    ) {
      throw new UserFacingCommandError("Exact-review queue authority context is incomplete.");
    }
    return {
      queueUrl: queueUrl.toString().replace(/\/$/, ""),
      itemKey: raw.itemKey,
      leaseId: raw.leaseId,
      leaseRevision,
      claimGeneration,
      runId: raw.runId,
      runAttempt,
      sourceHeadSha: raw.sourceHeadSha || null,
    };
  }

  function exactReviewQueueAuthorityIsLive(authority: ExactReviewQueueAuthority): boolean {
    const payload = JSON.stringify({
      item_key: authority.itemKey,
      lease_id: authority.leaseId,
      lease_revision: authority.leaseRevision,
      claim_generation: authority.claimGeneration,
      run_id: authority.runId,
      run_attempt: authority.runAttempt,
      ...(authority.sourceHeadSha ? { source_head_sha: authority.sourceHeadSha } : {}),
    });
    const result = spawnSync(
      "curl",
      [
        "--silent",
        "--show-error",
        "--connect-timeout",
        "5",
        "--max-time",
        "20",
        "--output",
        "/dev/null",
        "--write-out",
        "%{http_code}",
        "--request",
        "POST",
        "--header",
        "content-type: application/json",
        "--data-binary",
        payload,
        `${authority.queueUrl}/internal/exact-review/heartbeat`,
      ],
      { encoding: "utf8" },
    );
    return result.status === 0 && result.stdout.trim() === "200";
  }

  function freshDedicatedReviewStartLeases(options: {
    comments: Record<string, unknown>[];
    itemNumber: number;
    headSha: string;
    nowMs: number;
  }): Array<{
    comment: Record<string, unknown>;
    startedAt: string;
    expiresAt: string;
    owner: string | null;
    commentId: number | null;
  }> {
    const trustedAuthors = new Set(
      [...PATCHABLE_REVIEW_COMMENT_AUTHORS].map((author) => author.toLowerCase()),
    );
    return (
      options.comments
        .map((comment) => {
          const lease = freshExactHeadReviewStartLease({
            comments: [comment],
            itemNumber: options.itemNumber,
            headSha: options.headSha,
            trustedAuthors,
            nowMs: options.nowMs,
          });
          return lease ? { comment, ...lease } : null;
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        // GitHub comment ids are server-assigned and monotonic. A client timestamp cannot elect the
        // winner: a delayed worker could publish an earlier timestamp after another worker acquired
        // the lease, retroactively displacing it and allowing both reviews to run.
        .sort(
          (left, right) =>
            (commentId(left.comment) ?? Number.MAX_SAFE_INTEGER) -
            (commentId(right.comment) ?? Number.MAX_SAFE_INTEGER),
        )
    );
  }

  function reviewStartLeaseWinnerCommentIdForTest(options: {
    comments: Record<string, unknown>[];
    itemNumber: number;
    headSha: string;
    nowMs: number;
  }): number | null {
    return commentId(freshDedicatedReviewStartLeases(options)[0]?.comment);
  }

  function postReviewStartStatusComment(options: {
    item: Item;
    headSha?: string;
    reviewTimeoutMs: number;
    position: number;
    total: number;
    shardIndex: number;
    shardCount: number;
    purpose?: "review" | "apply";
    queueAuthority?: ExactReviewQueueAuthority | null;
    allowSupersededLeaseCleanup?: boolean;
  }): ReviewStartStatusCommentResult {
    const startedAtMs = Date.now();
    const leaseOwner = newReviewStartLeaseOwner();
    const leaseOptions: ReviewStartStatusCommentOptions = {
      number: options.item.number,
      kind: options.item.kind,
      title: options.item.title,
      ...(options.headSha ? { headSha: options.headSha } : {}),
      startedAt: new Date(startedAtMs).toISOString(),
      leaseExpiresAt: new Date(
        startedAtMs + options.reviewTimeoutMs + 10 * 60 * 1000,
      ).toISOString(),
      leaseOwner,
      position: options.position,
      total: options.total,
      shardIndex: options.shardIndex,
      shardCount: options.shardCount,
      purpose: options.purpose ?? "review",
    };
    const normalizedHead = String(options.headSha ?? "")
      .trim()
      .toLowerCase();
    const initialState = issueReviewCommentState(options.item.number);
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(normalizedHead)) {
      throw new Error(
        `cannot acquire a review lease without the current item revision for #${options.item.number}`,
      );
    }
    const initialLease = freshDedicatedReviewStartLeases({
      comments: initialState.leaseComments,
      itemNumber: options.item.number,
      headSha: normalizedHead,
      nowMs: startedAtMs,
    })[0];
    if (initialLease) {
      return heldReviewStartStatusCommentResult(initialLease.expiresAt, false);
    }
    reapExpiredDedicatedReviewStartLeases(
      options.item.number,
      initialState.dedicatedLeaseComments,
      startedAtMs,
    );
    const body = renderReviewStartStatusComment(leaseOptions);
    const payload = writeCommentPayload(options.item.number, body);
    // Every acquisition POSTs a fresh comment: the lowest-server-id election
    // needs distinct ids per contender, so refreshing a leftover placeholder in
    // place would let two racing workers both validate ownership of the same
    // comment. Superseded placeholders are swept when the durable review
    // comment is published instead.
    const createArgs = [
      "api",
      `repos/${targetRepo()}/issues/${options.item.number}/comments`,
      "--method",
      "POST",
      "--input",
      payload,
    ];
    const created = reviewCommentFromMutationResponse(
      ghObservedMutationCommand({
        identity: `review_lease_post:${options.item.number}:${leaseOwner}`,
        args: createArgs,
      }),
      createArgs,
    );
    const createdCommentId = commentId(created);
    if (createdCommentId === null) {
      throw new Error(
        `could not identify the created review lease comment for #${options.item.number}; retry required`,
      );
    }
    const acquired = { owner: leaseOwner, commentId: createdCommentId, headSha: normalizedHead };
    const confirmedState = issueReviewCommentState(options.item.number);
    const confirmed = freshDedicatedReviewStartLeases({
      comments: confirmedState.leaseComments,
      itemNumber: options.item.number,
      headSha: normalizedHead,
      nowMs: Date.now(),
    });
    if (confirmed.length === 0) {
      deleteOwnedDedicatedReviewStartLease(options.item.number, acquired);
      throw new Error(
        `could not confirm the review lease comment for #${options.item.number}; retry required`,
      );
    }
    const winner = confirmed[0];
    if (!winner) {
      deleteOwnedDedicatedReviewStartLease(options.item.number, acquired);
      throw new Error(
        `could not identify the winning review lease for #${options.item.number}; retry required`,
      );
    }
    if (
      commentId(winner.comment) !== createdCommentId ||
      reviewStartLeaseOwner(winner.comment) !== leaseOwner
    ) {
      deleteOwnedDedicatedReviewStartLease(options.item.number, acquired);
      return heldReviewStartStatusCommentResult(winner.expiresAt, true);
    }
    if (options.queueAuthority) {
      const authoritativeHead = currentReviewRevision(options.item);
      if (authoritativeHead !== normalizedHead) {
        deleteOwnedDedicatedReviewStartLease(options.item.number, acquired);
        throw new Error(
          `review revision changed while reserving #${options.item.number}; retry required`,
        );
      }
      if (!exactReviewQueueAuthorityIsLive(options.queueAuthority)) {
        deleteOwnedDedicatedReviewStartLease(options.item.number, acquired);
        throw new Error(
          `exact-review queue authority changed while reserving #${options.item.number}; retry required`,
        );
      }
      // The candidate snapshot predates both authority checks. A newer worker
      // cannot be selected by a stale caller: if its lease is already present,
      // the live revision/queue tuple has moved; if it starts later, it is absent
      // from this immutable snapshot.
      if (options.allowSupersededLeaseCleanup) {
        reapSupersededDedicatedReviewStartLeases(
          options.item.number,
          confirmedState.dedicatedLeaseComments,
          normalizedHead,
          authoritativeHead,
        );
      } else if (pullRequestHeadSha(options.item.number) !== normalizedHead) {
        deleteOwnedDedicatedReviewStartLease(options.item.number, acquired);
        throw new Error(
          `review revision changed while reserving #${options.item.number}; retry required`,
        );
      }
    }
    return {
      status: "posted",
      lease: { ...acquired, comment: winner.comment },
      didMutate: true,
    };
  }

  function deleteOwnedDedicatedReviewStartLease(
    itemNumber: number,
    lease: AcquiredReviewStartLease,
    options: { throwOnError?: boolean } = {},
  ): boolean {
    try {
      const matching = issueReviewCommentState(itemNumber).dedicatedLeaseComments.find(
        (comment) =>
          commentId(comment) === lease.commentId &&
          reviewStartLeaseOwner(comment) === lease.owner &&
          (commentBody(comment) ?? "").includes(`sha=${lease.headSha}`),
      );
      if (!matching) return false;
      ghObservedMutationCommand({
        identity: `review_lease_delete:${itemNumber}:${lease.commentId}`,
        args: [
          "api",
          `repos/${targetRepo()}/issues/comments/${lease.commentId}`,
          "--method",
          "DELETE",
        ],
      });
      return true;
    } catch (error) {
      if (options.throwOnError) throw error;
      console.error(
        `[review] could not delete owned review lease comment ${lease.commentId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  function reapExpiredDedicatedReviewStartLeases(
    itemNumber: number,
    dedicatedLeaseComments: Record<string, unknown>[],
    nowMs: number,
  ): void {
    const expired = expiredReviewStartStatusLeases({
      comments: dedicatedLeaseComments,
      itemNumber,
      trustedAuthors: new Set(
        [...PATCHABLE_REVIEW_COMMENT_AUTHORS].map((author) => author.toLowerCase()),
      ),
      nowMs,
    });
    for (const lease of expired) {
      try {
        ghObservedMutationCommand({
          identity: `review_lease_reap:${itemNumber}:${lease.commentId}`,
          args: [
            "api",
            `repos/${targetRepo()}/issues/comments/${lease.commentId}`,
            "--method",
            "DELETE",
          ],
        });
        console.error(
          `[review] reaped expired review lease comment ${lease.commentId} for #${itemNumber} (lease expired ${lease.expiresAt})`,
        );
      } catch (error) {
        // A failed reap must never block acquiring the new lease.
        console.error(
          `[review] could not reap expired review lease comment ${lease.commentId} for #${itemNumber}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  function reapSupersededDedicatedReviewStartLeases(
    itemNumber: number,
    dedicatedLeaseComments: Record<string, unknown>[],
    currentHeadSha: string,
    authoritativeHeadSha: string,
  ): void {
    const superseded = supersededReviewStartStatusLeases({
      comments: dedicatedLeaseComments,
      itemNumber,
      headSha: currentHeadSha,
      authoritativeHeadSha,
      trustedAuthors: new Set(
        [...PATCHABLE_REVIEW_COMMENT_AUTHORS].map((author) => author.toLowerCase()),
      ),
    });
    for (const lease of superseded) {
      try {
        ghObservedMutationCommand({
          identity: `review_lease_supersede:${itemNumber}:${lease.commentId}`,
          args: [
            "api",
            `repos/${targetRepo()}/issues/comments/${lease.commentId}`,
            "--method",
            "DELETE",
          ],
        });
        console.error(
          `[review] deleted superseded review lease comment ${lease.commentId} for #${itemNumber} (reviewed head ${lease.headSha}, current head ${currentHeadSha})`,
        );
      } catch (error) {
        // A failed cleanup must never block the current revision from acquiring its lease.
        console.error(
          `[review] could not delete superseded review lease comment ${lease.commentId} for #${itemNumber}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  const REVIEW_PLACEHOLDER_BODY_PATTERN = /^ClawSweeper status: review started\./i;

  function supersededReviewPlaceholderCommentIds(options: {
    number: number;
    comments: readonly Record<string, unknown>[];
    keepCommentIds: ReadonlySet<number>;
    nowMs?: number;
  }): number[] {
    const nowMs = options.nowMs ?? Date.now();
    const ids: number[] = [];
    for (const comment of options.comments) {
      const id = commentId(comment);
      if (id === null || options.keepCommentIds.has(id)) continue;
      if (!canPatchReviewComment(comment)) continue;
      const body = (commentBody(comment) ?? "").trimStart();
      // Placeholder bodies start with the status line; the durable review
      // comment never does, and its marker is an extra guard against deletion.
      if (!REVIEW_PLACEHOLDER_BODY_PATTERN.test(body)) continue;
      if (body.includes(reviewCommentMarker(options.number))) continue;
      // An unexpired lease may belong to a racing worker on a newer revision;
      // only provably superseded placeholders (expired lease or marker-less
      // legacy body) are swept after the durable review comment is published.
      const marker = body.match(/<!--\s*clawsweeper-review-status:started\b([^>]*)-->/i);
      if (marker) {
        const expiresAtMs = Date.parse(
          marker[1]?.match(/\blease_expires_at=([^\s>]+)/i)?.[1] ?? "",
        );
        if (Number.isFinite(expiresAtMs) && expiresAtMs >= nowMs) continue;
      }
      ids.push(id);
    }
    return ids;
  }

  function cleanupSupersededReviewPlaceholderComments(options: {
    number: number;
    // Pre-mutation snapshot from the apply flow; the sweep must not refetch the
    // comment list after the durable-comment mutation (API-budget invariant).
    comments: readonly Record<string, unknown>[];
    keepCommentIds: ReadonlySet<number>;
  }): void {
    const ids = supersededReviewPlaceholderCommentIds({
      number: options.number,
      comments: options.comments,
      keepCommentIds: options.keepCommentIds,
    });
    for (const id of ids) {
      try {
        ghObservedMutationCommand({
          identity: `review_placeholder_sweep:${options.number}:${id}`,
          args: ["api", `repos/${targetRepo()}/issues/comments/${id}`, "--method", "DELETE"],
        });
        console.error(
          `[apply] deleted superseded review placeholder comment ${id} for #${options.number}`,
        );
      } catch (error) {
        if (error instanceof GitHubRuntimeBudgetError) throw error;
        // A failed sweep must never fail the publish; the next apply retries it.
        console.error(
          `[apply] could not delete superseded review placeholder comment ${id} for #${options.number}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  return {
    canPatchReviewComment,
    coverageProofRetryExhaustedRuntimeBudget,
    isCodexReviewCommentBody,
    lockedConversationApplyReason,
    newReviewStartLeaseOwnerForTest,
    recordedLabelSyncCoversUpdate,
    removeCurrentCursorTraceItem,
    renderReviewStartStatusComment,
    reviewArtifactDestination,
    reviewAutomationMarkersFromReport,
    reviewStartLeaseWinnerCommentIdForTest,
    runtimeBudgetExceeded,
    shouldPreserveReviewStartLease,
    supersededReviewPlaceholderCommentIds,
    timeoutWithinRuntimeBudget,
    withReviewStartStatusLease,
    commentId,
    pullHeadShaFromContext,
    fetchIssueReviewComments,
    reviewLeaseRevisionFromReport,
    pullHeadShaFromReport,
    writeCommentPayload,
    repairLoopPassModeFromReport,
    reviewVersionMarkerFromReport,
    reviewStructuralPullStateFromContext,
    exactReviewQueueAuthorityFromEnv,
    postReviewStartStatusComment,
    deleteOwnedDedicatedReviewStartLease,
    freshDedicatedReviewStartLeases,
    issueReviewCommentState,
    PATCHABLE_REVIEW_COMMENT_AUTHORS,
    staleReviewCommentSyncReason,
    reviewCommentHasCloseVerdictForCanonical,
    issueReviewComment,
    markedReviewCommentBody,
    commentBodyMatches,
    reviewCommentHashMatches,
    commentUpdatedAt,
    cleanupSupersededReviewPlaceholderComments,
    reviewStartLeaseOwner,
    commentBody,
    freshPullRequestReviewHead,
    stalePullRequestReviewHead,
    syncStalePullRequestReviewLabels,
    stalePullRequestReviewComment,
    updateReviewCommentMetadata,
    upsertReviewComment,
    ensureCloseAppliedComment,
  };
}
