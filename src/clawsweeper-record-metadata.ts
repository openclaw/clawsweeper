import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isLegacyFixedCloseSkipAction,
  isLiveRecheckCloseGuardAction,
} from "./apply-close-actions.js";
import {
  ALLOWED_REASONS,
  CLOSED_STATE_PROBE_ACTIONS,
  PAIR_BLOCKED_CLOSE_ACTIONS,
  REVIEW_SECTIONS,
} from "./clawsweeper-policy.js";
import { escapeRegExp } from "./clawsweeper-text.js";
import { readReportFrontMatterField, type FrontMatterField } from "./report-front-matter.js";
import type {
  ApplyKind,
  CloseReason,
  ExactEventReviewLeaseDisposition,
  ExistingReview,
  ExistingReviewIndex,
  FailedReviewRetryResult,
  FailedReviewRetryRevision,
  FailedReviewRetryRevisionKind,
  Item,
  ItemKind,
} from "./clawsweeper-types.js";
import { isRetryableCodexTransportError } from "./codex-transient.js";
import { isAutoCloseAllowed, repositoryProfileFor } from "./repository-profiles.js";
import {
  REVIEW_SEMANTIC_CACHE_VERSION,
  validReviewSemanticRecord,
  type ReviewSemanticRecord,
} from "./review-semantic-cache.js";
import {
  REVIEW_STRUCTURAL_CACHE_VERSION,
  validReviewStructuralRecord,
  type ReviewStructuralRecord,
} from "./review-structural-cache.js";

type ReviewSection = keyof typeof REVIEW_SECTIONS;

interface RecordMetadataDependencies {
  reportFileName: (repo: string, number: number) => string;
  markdownRepository: (markdown: string, file?: string) => string;
  isVerifiedFixedCloseReason: (reason: unknown) => boolean;
  isOlderThanDays: (timestamp: string, days: number, now?: number) => boolean;
  timestampMs: (timestamp: string | undefined) => number | null;
  pullHeadShaFromReport: (markdown: string) => string | null;
  reviewLeaseRevisionFromReport: (markdown: string) => string | null;
  lockedConversationApplyReason: (item: Pick<Item, "activeLockReason" | "locked">) => string | null;
  markdownFiles: (dir: string) => string[];
  numberForMarkdownFile: (file: string) => number;
}

export function createRecordMetadata({
  reportFileName,
  markdownRepository,
  isVerifiedFixedCloseReason,
  isOlderThanDays,
  timestampMs,
  pullHeadShaFromReport,
  reviewLeaseRevisionFromReport,
  lockedConversationApplyReason,
  markdownFiles,
  numberForMarkdownFile,
}: RecordMetadataDependencies) {
  function frontMatterField(markdown: string, key: string): FrontMatterField {
    const field = readReportFrontMatterField(markdown, key);
    if (field.status !== "value") return field;
    const value = field.value.trim();
    if (!value) return { status: "ambiguous" };
    return {
      status: "value",
      value: value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value,
    };
  }

  function frontMatterValue(markdown: string, key: string): string | undefined {
    const field = frontMatterField(markdown, key);
    return field.status === "value" ? field.value : undefined;
  }

  function reportCloseReason(markdown: string): CloseReason | undefined {
    const closeReason = frontMatterValue(markdown, "close_reason");
    return closeReason && ALLOWED_REASONS.has(closeReason as CloseReason)
      ? (closeReason as CloseReason)
      : undefined;
  }

  function reportItemKind(markdown: string): ItemKind | undefined {
    const itemKind = frontMatterValue(markdown, "type");
    return itemKind === "issue" || itemKind === "pull_request" ? itemKind : undefined;
  }

  function hasHighConfidenceAllowedCloseMetadata(markdown: string): boolean {
    const closeReason = reportCloseReason(markdown);
    const itemKind = reportItemKind(markdown);
    return !(
      frontMatterValue(markdown, "decision") !== "close" ||
      frontMatterValue(markdown, "confidence") !== "high" ||
      !closeReason ||
      !itemKind
    );
  }

  function hasAutoCloseAllowedMetadata(markdown: string): boolean {
    const closeReason = reportCloseReason(markdown);
    const itemKind = reportItemKind(markdown);
    if (!closeReason || !itemKind || !hasHighConfidenceAllowedCloseMetadata(markdown)) return false;
    const profile = repositoryProfileFor(markdownRepository(markdown));
    return isAutoCloseAllowed(profile, itemKind, closeReason);
  }

  function isRetryableCloseSkipReport(markdown: string): boolean {
    const action = frontMatterValue(markdown, "action_taken");
    const closeReason = reportCloseReason(markdown);
    return (
      Boolean(action && closeReason && isLegacyFixedCloseSkipAction(action, closeReason)) &&
      isVerifiedFixedCloseReason(closeReason) &&
      hasHighConfidenceAllowedCloseMetadata(markdown)
    );
  }

  function isLiveRecheckCloseGuardReport(markdown: string): boolean {
    const action = frontMatterValue(markdown, "action_taken");
    return Boolean(
      action &&
      isLiveRecheckCloseGuardAction(action) &&
      hasHighConfidenceAllowedCloseMetadata(markdown),
    );
  }

  function isRetryableKeptOpenCloseReport(markdown: string): boolean {
    const action = frontMatterValue(markdown, "action_taken");
    return (
      (action === "kept_open" || action === "skipped_low_signal_live_guard") &&
      hasHighConfidenceAllowedCloseMetadata(markdown)
    );
  }

  function isRetryablePrCloseCoverageProofReport(markdown: string): boolean {
    return (
      frontMatterValue(markdown, "action_taken") === "retry_pr_close_coverage_proof" &&
      hasHighConfidenceAllowedCloseMetadata(markdown)
    );
  }

  function isPairBlockedCloseReport(markdown: string): boolean {
    const action = frontMatterValue(markdown, "action_taken");
    return (
      Boolean(action && PAIR_BLOCKED_CLOSE_ACTIONS.has(action)) &&
      hasHighConfidenceAllowedCloseMetadata(markdown)
    );
  }

  function isApplyCloseCandidateReport(markdown: string): boolean {
    const action = frontMatterValue(markdown, "action_taken");
    return (
      hasHighConfidenceAllowedCloseMetadata(markdown) &&
      (action === "proposed_close" ||
        isRetryableCloseSkipReport(markdown) ||
        isRetryablePrCloseCoverageProofReport(markdown) ||
        isRetryableKeptOpenCloseReport(markdown) ||
        isPairBlockedCloseReport(markdown))
    );
  }

  function shouldProbeClosedStateReport(markdown: string): boolean {
    const action = frontMatterValue(markdown, "action_taken");
    return action === "proposed_close" || Boolean(action && CLOSED_STATE_PROBE_ACTIONS.has(action));
  }

  function applyDecisionPriority(markdown: string, applyKind: ApplyKind): number {
    const itemKind = reportItemKind(markdown);
    const isCloseProposal =
      isApplyCloseCandidateReport(markdown) && hasAutoCloseAllowedMetadata(markdown);
    if (!isCloseProposal) return 2;
    if (
      frontMatterValue(markdown, "action_taken") === "skipped_same_author_pair" &&
      itemKind === "pull_request" &&
      (applyKind === "all" || applyKind === "pull_request")
    ) {
      return 0;
    }
    if (isPairBlockedCloseReport(markdown)) return 1;
    if (applyKind === "all" || itemKind === applyKind || !itemKind) return 0;
    return 1;
  }

  function applyQueueSortFields(markdown: string, syncCommentsOnly: boolean, applyKind: ApplyKind) {
    const checkedAt = Date.parse(frontMatterValue(markdown, "apply_checked_at") ?? "");
    return {
      priority: syncCommentsOnly ? 0 : applyDecisionPriority(markdown, applyKind),
      applyCheckedAt: Number.isFinite(checkedAt) ? checkedAt : 0,
    };
  }

  function shouldSyncReviewComment(options: {
    syncCommentsOnly: boolean;
    isCloseProposal: boolean;
    commentSyncMinAgeDays: number;
    reviewCommentSyncedAt: string | undefined;
    reviewCommentVerifiedAt?: string | undefined;
    reviewedAt?: string | undefined;
    lastFullReviewAt?: string | undefined;
    guardedReviewedAt?: string | undefined;
    hasExistingReviewComment: boolean;
    needsReviewCommentBodySync: boolean;
    needsReviewCommentHashSync: boolean;
    needsReviewCommentReferenceSync: boolean;
    forceReviewCommentBodySync?: boolean;
    now?: number;
  }): boolean {
    const syncedAt = Date.parse(options.reviewCommentSyncedAt ?? "");
    const verifiedAt = Date.parse(options.reviewCommentVerifiedAt ?? "");
    const confirmedAt = Math.max(
      Number.isFinite(syncedAt) ? syncedAt : 0,
      Number.isFinite(verifiedAt) ? verifiedAt : 0,
    );
    const reviewedAt = Math.max(
      Date.parse(options.reviewedAt ?? "") || 0,
      Date.parse(options.lastFullReviewAt ?? "") || 0,
      Date.parse(options.guardedReviewedAt ?? "") || 0,
    );
    const needsReviewCommentTimestampSync =
      options.syncCommentsOnly &&
      options.hasExistingReviewComment &&
      (!Number.isFinite(syncedAt) ||
        reviewedAt > confirmedAt ||
        (options.now ?? Date.now()) - confirmedAt >= 7 * 24 * 60 * 60 * 1_000);
    if (
      !options.needsReviewCommentBodySync &&
      !options.needsReviewCommentHashSync &&
      !options.needsReviewCommentReferenceSync
    ) {
      return needsReviewCommentTimestampSync;
    }
    if (!options.syncCommentsOnly || options.isCloseProposal) return true;
    if (options.forceReviewCommentBodySync && options.needsReviewCommentBodySync) return true;
    if (!options.hasExistingReviewComment || options.needsReviewCommentReferenceSync) return true;
    if (options.commentSyncMinAgeDays <= 0) return true;
    if (!options.reviewCommentSyncedAt) return true;
    return isOlderThanDays(
      options.reviewCommentSyncedAt,
      options.commentSyncMinAgeDays,
      options.now,
    );
  }

  // `value` is record data — most often `JSON.stringify(item.labels)`, whose contents
  // are GitHub label names. Passing it as a replacement *string* would let `$&`, `` $` ``
  // and `$'` expand against the match, so a label containing them rewrites the field to
  // something other than what was stored. A replacement function inserts the text
  // literally, which is the only behavior this writer ever intended.
  function replaceFrontMatterValue(markdown: string, key: string, value: string): string {
    const line = `${key}: ${value}`;
    const pattern = new RegExp(`^${escapeRegExp(key)}:\\s*.*$`, "m");
    if (pattern.test(markdown)) return markdown.replace(pattern, () => line);
    return markdown.replace(/^---\n/, () => `---\n${line}\n`);
  }

  function exactEventReviewLeaseDisposition(
    markdown: string,
    liveRevision: string,
  ): ExactEventReviewLeaseDisposition {
    const reportRevision = reviewLeaseRevisionFromReport(markdown);
    if (!reportRevision) {
      return {
        status: "invalid",
        reason: "exact event review artifact lacks a durable reviewed revision",
      };
    }
    if (!liveRevision || reportRevision !== liveRevision) {
      return { status: "source_drift", reportRevision, liveRevision };
    }
    const leaseOwner = frontMatterValue(markdown, "review_lease_owner");
    const leaseCommentId = Number(frontMatterValue(markdown, "review_lease_comment_id"));
    const missingOwner = !leaseOwner || leaseOwner === "unknown";
    const missingCommentId = !Number.isInteger(leaseCommentId) || leaseCommentId <= 0;
    if (missingOwner && missingCommentId) {
      return {
        status: "legacy_tupleless",
        reason: "local report has no durable lease identity",
      };
    }
    if (missingOwner || missingCommentId) {
      return {
        status: "invalid",
        reason: "exact event review artifact has an incomplete durable review lease tuple",
      };
    }
    return { status: "current" };
  }

  function exactEventReviewLeaseDispositionForTest(
    markdown: string,
    liveRevision: string,
  ): ExactEventReviewLeaseDisposition {
    return exactEventReviewLeaseDisposition(markdown, liveRevision);
  }

  function sectionValue(markdown: string, heading: string): string {
    const match = markdown.match(
      new RegExp(`(?:^|\\n)## ${heading}\\n\\n([\\s\\S]*?)(?=\\n## |\\n?$)`),
    );
    return match?.[1]?.trim() ?? "";
  }

  function reviewSectionValue(markdown: string, section: ReviewSection): string {
    return sectionValue(markdown, REVIEW_SECTIONS[section]);
  }

  function replaceSectionValue(markdown: string, heading: string, value: string): string {
    const pattern = new RegExp(`((?:^|\\n)## ${heading}\\n\\n)([\\s\\S]*?)(?=\\n## |\\n?$)`);
    if (pattern.test(markdown)) return markdown.replace(pattern, `$1${value.trim()}\n`);
    return `${markdown.trimEnd()}\n\n## ${heading}\n\n${value.trim()}\n`;
  }

  function appendSectionValue(markdown: string, heading: string, value: string): string {
    const existing = sectionValue(markdown, heading);
    const nextValue = existing ? `${existing.trimEnd()}\n\n${value.trim()}` : value.trim();
    return replaceSectionValue(markdown, heading, nextValue);
  }

  function frontMatterStringArray(markdown: string, key: string): string[] {
    const value = frontMatterValue(markdown, key);
    if (!value || value === "none") return [];
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((entry): entry is string => typeof entry === "string");
      }
    } catch {
      // Older reports used plain comma-separated labels.
    }
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  function frontMatterJsonArray(markdown: string, key: string): unknown[] {
    const value = frontMatterValue(markdown, key);
    if (!value || value === "none") return [];
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function frontMatterBoolean(markdown: string, key: string): boolean {
    return /^true$/i.test(frontMatterValue(markdown, key) ?? "");
  }

  function reviewReportCanPromoteToClose(markdown: string): boolean {
    const cacheHit = frontMatterField(markdown, "review_cache_hit");
    if (cacheHit.status === "absent") return true;
    return cacheHit.status === "value" && /^false$/i.test(cacheHit.value);
  }

  function reviewReportCanPromoteToCloseForTest(markdown: string): boolean {
    return reviewReportCanPromoteToClose(markdown);
  }

  function reviewStructuralRecordFromMarkdown(markdown: string): ReviewStructuralRecord | null {
    const version = Number(frontMatterValue(markdown, "review_structural_cache_version"));
    const kind = reportItemKind(markdown);
    const pullHeadSha = frontMatterValue(markdown, "review_structural_pull_head_sha");
    const pullStateDigest = frontMatterValue(markdown, "review_structural_pull_state_digest");
    if (version !== REVIEW_STRUCTURAL_CACHE_VERSION || !kind) return null;
    const record: ReviewStructuralRecord = {
      version: REVIEW_STRUCTURAL_CACHE_VERSION,
      fingerprint: frontMatterValue(markdown, "review_structural_fingerprint") ?? "",
      kind,
      sourceRevision: frontMatterValue(markdown, "review_structural_source_revision") ?? "",
      itemStateDigest: frontMatterValue(markdown, "review_structural_item_state_digest") ?? "",
      contextRevision: frontMatterValue(markdown, "review_structural_context_revision") ?? "",
      activityUpdatedAt: frontMatterValue(markdown, "review_structural_activity_updated_at") ?? "",
      relationSensitive: frontMatterBoolean(markdown, "review_structural_relation_sensitive"),
      targetHeadSha: frontMatterValue(markdown, "review_structural_target_head_sha") ?? "",
      pullHeadSha: pullHeadSha && pullHeadSha !== "none" ? pullHeadSha : null,
      pullStateDigest: pullStateDigest && pullStateDigest !== "none" ? pullStateDigest : null,
      reviewPolicy: frontMatterValue(markdown, "review_policy") ?? "",
      reviewModel: frontMatterValue(markdown, "review_model") ?? "",
    };
    return validReviewStructuralRecord(record) ? record : null;
  }

  function reviewSemanticRecordFromMarkdown(markdown: string): ReviewSemanticRecord | null {
    const version = Number(frontMatterValue(markdown, "review_semantic_cache_version"));
    if (version !== REVIEW_SEMANTIC_CACHE_VERSION) return null;
    const eligibilityReason = frontMatterValue(markdown, "review_semantic_eligibility_reason");
    const record: ReviewSemanticRecord = {
      version: REVIEW_SEMANTIC_CACHE_VERSION,
      fingerprint: frontMatterValue(markdown, "review_semantic_fingerprint") ?? "",
      codeDigest: frontMatterValue(markdown, "review_semantic_code_digest") ?? "",
      exactDigest: frontMatterValue(markdown, "review_semantic_exact_digest") ?? "",
      contextDigest: frontMatterValue(markdown, "review_semantic_context_digest") ?? "",
      eligible: frontMatterBoolean(markdown, "review_semantic_eligible"),
      eligibilityReason:
        (eligibilityReason as ReviewSemanticRecord["eligibilityReason"] | undefined) ??
        "missing_structural_context",
      reviewPolicy: frontMatterValue(markdown, "review_policy") ?? "",
      reviewModel: frontMatterValue(markdown, "review_model") ?? "",
    };
    return validReviewSemanticRecord(record) ? record : null;
  }

  function existingReview(
    item: Pick<Item, "number" | "repo">,
    itemsDir: string,
  ): ExistingReview | null {
    const candidates = [join(itemsDir, reportFileName(item.repo, item.number))];
    const path = candidates.find((candidate) => {
      if (!existsSync(candidate)) return false;
      const markdown = readFileSync(candidate, "utf8");
      return markdownRepository(markdown, candidate) === item.repo;
    });
    if (!path) return null;
    const markdown = readFileSync(path, "utf8");
    return {
      path,
      markdown,
      reviewedAt: frontMatterValue(markdown, "reviewed_at"),
      itemUpdatedAt: frontMatterValue(markdown, "item_updated_at"),
      automationItemUpdatedAt: frontMatterValue(markdown, "automation_item_updated_at"),
      reviewCommentSyncedAt: frontMatterValue(markdown, "review_comment_synced_at"),
      labelsSyncedAt: frontMatterValue(markdown, "labels_synced_at"),
      decision: frontMatterValue(markdown, "decision"),
      reviewStatus: effectiveReviewStatus(markdown),
      reviewPolicy: frontMatterValue(markdown, "review_policy"),
      reviewModel: frontMatterValue(markdown, "review_model"),
      itemSourceRevision: frontMatterValue(markdown, "item_source_revision"),
      contentDigest: frontMatterValue(markdown, "review_content_digest"),
      lastFullReviewAt: frontMatterValue(markdown, "last_full_review_at"),
      lastFullReviewDecision: frontMatterValue(markdown, "last_full_review_decision"),
      structuralRecord: reviewStructuralRecordFromMarkdown(markdown),
      semanticRecord: reviewSemanticRecordFromMarkdown(markdown),
    };
  }

  function existingReviewKey(repo: string, number: number): string {
    return `${repo}#${number}`;
  }

  function buildExistingReviewIndex(itemsDir: string): ExistingReviewIndex {
    const byKey = new Map<string, ExistingReview>();
    for (const file of markdownFiles(itemsDir)) {
      const path = join(itemsDir, file);
      const markdown = readFileSync(path, "utf8");
      const repo = markdownRepository(markdown, path);
      const number = numberForMarkdownFile(file);
      byKey.set(existingReviewKey(repo, number), {
        path,
        markdown,
        reviewedAt: frontMatterValue(markdown, "reviewed_at"),
        itemUpdatedAt: frontMatterValue(markdown, "item_updated_at"),
        automationItemUpdatedAt: frontMatterValue(markdown, "automation_item_updated_at"),
        reviewCommentSyncedAt: frontMatterValue(markdown, "review_comment_synced_at"),
        labelsSyncedAt: frontMatterValue(markdown, "labels_synced_at"),
        decision: frontMatterValue(markdown, "decision"),
        reviewStatus: effectiveReviewStatus(markdown),
        reviewPolicy: frontMatterValue(markdown, "review_policy"),
        reviewModel: frontMatterValue(markdown, "review_model"),
        itemSourceRevision: frontMatterValue(markdown, "item_source_revision"),
        contentDigest: frontMatterValue(markdown, "review_content_digest"),
        lastFullReviewAt: frontMatterValue(markdown, "last_full_review_at"),
        lastFullReviewDecision: frontMatterValue(markdown, "last_full_review_decision"),
        structuralRecord: reviewStructuralRecordFromMarkdown(markdown),
        semanticRecord: reviewSemanticRecordFromMarkdown(markdown),
      });
    }
    return { byKey };
  }

  function indexedExistingReview(
    item: Pick<Item, "number" | "repo">,
    itemsDir: string,
    reviewIndex?: ExistingReviewIndex,
  ): ExistingReview | null {
    return (
      reviewIndex?.byKey.get(existingReviewKey(item.repo, item.number)) ??
      existingReview(item, itemsDir)
    );
  }

  function inferReviewStatus(markdown: string): string {
    return markdown.includes("Codex review failed") ? "failed" : "complete";
  }

  function hasVerifiedLocalCheckoutAccess(markdown: string): boolean {
    return (
      frontMatterValue(markdown, "local_checkout_access") === "verified" &&
      frontMatterValue(markdown, "local_checkout_access_source") === "runner_preflight_v1"
    );
  }

  function effectiveReviewStatus(markdown: string): string {
    const status = frontMatterValue(markdown, "review_status") ?? inferReviewStatus(markdown);
    if (status === "complete") {
      if (!hasVerifiedLocalCheckoutAccess(markdown)) return "stale_local_checkout_unverified";
    }
    return status;
  }

  function failedReviewRetryRevisionForReport(markdown: string): FailedReviewRetryRevision | null {
    const kind = frontMatterValue(markdown, "type");
    if (kind === "pull_request") {
      const value = pullHeadShaFromReport(markdown);
      return value ? { kind: "pull_head_sha", value } : null;
    }
    if (kind === "issue") {
      const value = frontMatterValue(markdown, "item_source_revision");
      return value && value !== "unknown" ? { kind: "item_source_revision", value } : null;
    }
    return null;
  }

  function storedFailedReviewRetryRevision(markdown: string): FailedReviewRetryRevision | null {
    const kind = frontMatterValue(markdown, "failed_review_retry_revision_kind");
    const value = frontMatterValue(markdown, "failed_review_retry_revision");
    if ((kind === "pull_head_sha" || kind === "item_source_revision") && value) {
      return { kind, value };
    }
    const legacyHead = frontMatterValue(markdown, "failed_review_retry_head_sha");
    return legacyHead ? { kind: "pull_head_sha", value: legacyHead } : null;
  }

  function sameFailedReviewRetryRevision(
    left: FailedReviewRetryRevision,
    right: FailedReviewRetryRevision,
  ): boolean {
    return left.kind === right.kind && left.value === right.value;
  }

  function failedReviewRetryResultRevision(revision: FailedReviewRetryRevision): {
    headSha?: string;
    revisionKind: FailedReviewRetryRevisionKind;
    revision: string;
  } {
    return {
      ...(revision.kind === "pull_head_sha" ? { headSha: revision.value } : {}),
      revisionKind: revision.kind,
      revision: revision.value,
    };
  }

  function failedReviewRetryCount(markdown: string, revision: FailedReviewRetryRevision): number {
    const storedRevision = storedFailedReviewRetryRevision(markdown);
    if (storedRevision && !sameFailedReviewRetryRevision(storedRevision, revision)) return 0;
    const value = frontMatterValue(markdown, "failed_review_retry_count");
    if (!value) return 0;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  }

  function failedReviewRetryLastAtMs(
    markdown: string,
    revision: FailedReviewRetryRevision,
  ): number | null {
    const storedRevision = storedFailedReviewRetryRevision(markdown);
    if (storedRevision && !sameFailedReviewRetryRevision(storedRevision, revision)) return null;
    return timestampMs(frontMatterValue(markdown, "failed_review_retry_last_at"));
  }

  function isFailedReviewRetryAlreadyExhausted(
    markdown: string,
    revision: FailedReviewRetryRevision,
  ): boolean {
    const storedRevision = storedFailedReviewRetryRevision(markdown);
    return (
      frontMatterValue(markdown, "failed_review_retry_status") === "exhausted" &&
      storedRevision !== null &&
      sameFailedReviewRetryRevision(storedRevision, revision)
    );
  }

  function failedReviewFailureDetail(markdown: string): string {
    return [
      frontMatterValue(markdown, "review_status") ?? "",
      frontMatterValue(markdown, "decision") ?? "",
      reviewSectionValue(markdown, "summary"),
      reviewSectionValue(markdown, "evidence"),
      sectionValue(markdown, "Summary"),
      sectionValue(markdown, "Evidence"),
      markdown.slice(0, 8000),
    ].join("\n");
  }

  function isInfrastructureFailedReviewForTest(markdown: string): boolean {
    return isInfrastructureFailedReview(markdown);
  }

  function isInfrastructureFailedReview(markdown: string): boolean {
    const detail = failedReviewFailureDetail(markdown);
    const terminalFailure = frontMatterField(markdown, "review_terminal_failure");
    const checkoutInspectionFailure = frontMatterField(
      markdown,
      "review_checkout_inspection_failed",
    );
    if (terminalFailure.status === "ambiguous") return false;
    if (
      terminalFailure.status === "value" &&
      (!/^(?:true|false)$/i.test(terminalFailure.value) || /^true$/i.test(terminalFailure.value))
    ) {
      return false;
    }
    if (checkoutInspectionFailure.status === "ambiguous") return false;
    if (
      checkoutInspectionFailure.status === "value" &&
      !/^(?:true|false)$/i.test(checkoutInspectionFailure.value)
    ) {
      return false;
    }
    if (
      checkoutInspectionFailure.status === "value" &&
      /^true$/i.test(checkoutInspectionFailure.value)
    ) {
      return true;
    }
    return (
      isRetryableCodexTransportError(detail) ||
      /\b(?:ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|transport failure|codex transport|Codex worker timed out|Codex review failed: timeout|timed out after|shard timeout|workflow timeout|cancelledByParent)\b/i.test(
        detail,
      )
    );
  }

  function failedReviewRetryEligibilityForTest(options: {
    markdown: string;
    liveState: string;
    liveLocked?: boolean;
    liveActiveLockReason?: string | null;
    liveHeadSha?: string | null;
    liveSourceRevision?: string | null;
    now: number;
    maxAttempts: number;
    cooldownMs: number;
  }): FailedReviewRetryResult {
    return failedReviewRetryEligibility(options);
  }

  function failedReviewRetryEligibility(options: {
    markdown: string;
    liveState: string;
    liveLocked?: boolean;
    liveActiveLockReason?: string | null;
    liveHeadSha?: string | null;
    liveSourceRevision?: string | null;
    now: number;
    maxAttempts: number;
    cooldownMs: number;
  }): FailedReviewRetryResult {
    const number = Number(frontMatterValue(options.markdown, "number") ?? 0);
    const repo = markdownRepository(options.markdown);
    if (effectiveReviewStatus(options.markdown) !== "failed") {
      return { repo, number, action: "skipped_not_failed_review", reason: "review is not failed" };
    }
    if (options.liveState !== "open") {
      return { repo, number, action: "skipped_not_open", reason: `state is ${options.liveState}` };
    }
    const lockedReason = lockedConversationApplyReason({
      locked: options.liveLocked === true,
      activeLockReason: options.liveActiveLockReason ?? null,
    });
    if (lockedReason) {
      return { repo, number, action: "skipped_locked_conversation", reason: lockedReason };
    }
    const itemKind = frontMatterValue(options.markdown, "type");
    if (itemKind !== "pull_request" && itemKind !== "issue") {
      return {
        repo,
        number,
        action: "skipped_not_pull_request",
        reason: "failed-review retry requires an issue or pull request report",
      };
    }
    const reportRevision = failedReviewRetryRevisionForReport(options.markdown);
    if (!reportRevision) {
      return {
        repo,
        number,
        action:
          itemKind === "pull_request"
            ? "skipped_missing_report_head"
            : "skipped_missing_report_revision",
        reason:
          itemKind === "pull_request"
            ? "report does not record a pull_head_sha"
            : "report does not record an item_source_revision",
      };
    }
    const liveRevisionValue =
      (reportRevision.kind === "pull_head_sha"
        ? options.liveHeadSha
        : options.liveSourceRevision
      )?.trim() || null;
    if (!liveRevisionValue) {
      return {
        repo,
        number,
        action:
          reportRevision.kind === "pull_head_sha"
            ? "skipped_missing_live_head"
            : "skipped_missing_live_revision",
        reason:
          reportRevision.kind === "pull_head_sha"
            ? "live pull request head SHA is unavailable"
            : "live issue source revision is unavailable",
        ...failedReviewRetryResultRevision(reportRevision),
      };
    }
    if (liveRevisionValue !== reportRevision.value) {
      return {
        repo,
        number,
        action:
          reportRevision.kind === "pull_head_sha" ? "skipped_stale_head" : "skipped_stale_revision",
        reason:
          reportRevision.kind === "pull_head_sha"
            ? `live head ${liveRevisionValue} does not match failed report head ${reportRevision.value}`
            : `live source revision ${liveRevisionValue} does not match failed report source revision ${reportRevision.value}`,
        ...failedReviewRetryResultRevision(reportRevision),
      };
    }
    if (!isInfrastructureFailedReview(options.markdown)) {
      return {
        repo,
        number,
        action: "skipped_non_infrastructure_failure",
        reason: "failed review does not look like a Codex timeout or infrastructure failure",
        ...failedReviewRetryResultRevision(reportRevision),
      };
    }
    const attempts = failedReviewRetryCount(options.markdown, reportRevision);
    const revisionDescription =
      reportRevision.kind === "pull_head_sha"
        ? `head ${reportRevision.value}`
        : `source revision ${reportRevision.value}`;
    const storedRevision = storedFailedReviewRetryRevision(options.markdown);
    if (
      frontMatterValue(options.markdown, "failed_review_retry_status") === "dispatching" &&
      storedRevision &&
      sameFailedReviewRetryRevision(storedRevision, reportRevision)
    ) {
      return {
        repo,
        number,
        action: "skipped_retry_dispatch_uncertain",
        reason: `dispatch outcome is uncertain for ${revisionDescription}; refusing a duplicate launch`,
        ...failedReviewRetryResultRevision(reportRevision),
        attempts,
      };
    }
    if (attempts >= options.maxAttempts) {
      return {
        repo,
        number,
        action: "skipped_retry_exhausted",
        reason: `retry attempts exhausted for ${revisionDescription}: ${attempts}/${options.maxAttempts}`,
        ...failedReviewRetryResultRevision(reportRevision),
        attempts,
      };
    }
    const lastAtMs = failedReviewRetryLastAtMs(options.markdown, reportRevision);
    if (lastAtMs !== null && options.now - lastAtMs < options.cooldownMs) {
      const remainingMs = Math.max(0, options.cooldownMs - (options.now - lastAtMs));
      return {
        repo,
        number,
        action: "skipped_retry_cooldown",
        reason: `retry cooldown has ${Math.ceil(remainingMs / 60000)} minute(s) remaining`,
        ...failedReviewRetryResultRevision(reportRevision),
        attempts,
      };
    }
    return {
      repo,
      number,
      action: "planned_failed_review_retry",
      reason: `eligible infrastructure failed review at ${revisionDescription}`,
      ...failedReviewRetryResultRevision(reportRevision),
      attempts,
    };
  }

  return {
    applyDecisionPriority,
    exactEventReviewLeaseDispositionForTest,
    failedReviewRetryEligibilityForTest,
    isInfrastructureFailedReviewForTest,
    reviewReportCanPromoteToCloseForTest,
    shouldSyncReviewComment,
    appendSectionValue,
    applyQueueSortFields,
    buildExistingReviewIndex,
    effectiveReviewStatus,
    exactEventReviewLeaseDisposition,
    existingReview,
    failedReviewFailureDetail,
    failedReviewRetryEligibility,
    failedReviewRetryResultRevision,
    failedReviewRetryRevisionForReport,
    frontMatterBoolean,
    frontMatterField,
    frontMatterJsonArray,
    frontMatterStringArray,
    frontMatterValue,
    hasAutoCloseAllowedMetadata,
    hasVerifiedLocalCheckoutAccess,
    indexedExistingReview,
    isApplyCloseCandidateReport,
    isFailedReviewRetryAlreadyExhausted,
    isLiveRecheckCloseGuardReport,
    isPairBlockedCloseReport,
    isRetryableCloseSkipReport,
    isRetryableKeptOpenCloseReport,
    isRetryablePrCloseCoverageProofReport,
    replaceFrontMatterValue,
    replaceSectionValue,
    reportCloseReason,
    reportItemKind,
    reviewReportCanPromoteToClose,
    reviewSectionValue,
    sameFailedReviewRetryRevision,
    sectionValue,
    shouldProbeClosedStateReport,
    storedFailedReviewRetryRevision,
  };
}
