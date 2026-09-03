import {
  LEGACY_FIXED_CLOSE_SKIP_ACTIONS,
  LIVE_RECHECK_CLOSE_GUARD_ACTIONS,
} from "./apply-close-actions.js";
import {
  DEFAULT_REVIEW_CODEX_TIMEOUT_MS,
  PAIR_BLOCKED_CLOSE_ACTIONS,
  REVIEW_START_STATUS_MARKER_PREFIX,
} from "./clawsweeper-policy.js";
import type {
  CloseReason,
  Item,
  ItemContext,
  ReviewStartStatusCommentOptions,
} from "./clawsweeper-types.js";
import {
  generationReadKey,
  type LiveReadGeneration,
  type LiveReadOptions,
} from "./live-read-generation.js";
import { normalizeRepo } from "./repository-profiles.js";
import { trailingHtmlComments, validReviewLeaseIdentity } from "./review-comment-markers.js";
import { neutralizeReviewControlMarkers } from "./review-history.js";
import type { ReviewCommentWorkflowDependencies } from "./clawsweeper-review-comment-dependencies.js";

export function normalizeNoopReviewMarkerMetadata(body: string): string {
  return body.replace(
    /<!--\s+clawsweeper-(?:review-version|verdict:[^\s>]+|action:[^\s>]+|security:[^\s>]+)\b[^>]*-->/g,
    (marker) =>
      marker.replace(/\s(?:reviewed_at|updated_at|lease_owner|lease_comment_id)=[^\s>]+/g, ""),
  );
}
import type { createReviewCommentIdentity } from "./clawsweeper-review-comment-identity.js";

export function expireReviewStartStatusLease(
  body: string,
  expiresAt: string,
  itemNumber?: number,
): string {
  const trailing = trailingHtmlComments(body);
  const identity = /^<!--\s*clawsweeper-review(?:-lease)?\s+item=([1-9]\d*)\s*-->$/i.exec(
    trailing.at(-1) ?? "",
  );
  const marker = trailing.at(-2) ?? "";
  if (
    !identity ||
    (itemNumber !== undefined && Number(identity[1]) !== itemNumber) ||
    !/^<!--\s*clawsweeper-review-status:started\b[^>]*-->$/i.test(marker) ||
    /\sitem=(\d+)(?=\s|-->)/.exec(marker)?.[1] !== identity[1]
  )
    return body;
  const rewritten = marker.replace(
    /(\slease_expires_at=)[^\s>]+/,
    (_match, prefix: string) => `${prefix}${expiresAt}`,
  );
  const offset = body.lastIndexOf(marker);
  return body.slice(0, offset) + rewritten + body.slice(offset + marker.length);
}

export function createReviewCommentState(
  dependencies: ReviewCommentWorkflowDependencies & ReturnType<typeof createReviewCommentIdentity>,
) {
  const {
    targetRepo,
    ghPaged,
    reviewCommentBodyDigest,
    asRecord,
    parseGitHubItemRef,
    frontMatterValue,
    timestampMs,
    linkedPullRequestRefsFromText,
    linkedPullRequestSignalContextsFromText,
    reviewCommentMarker,
    pullHeadShaFromContext,
    pullHeadShaFromReport,
    reviewLeaseRevisionFromReport,
    markerAttributeValue,
  } = dependencies;

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

  function hasExactDurableReviewMarker(number: number, comment: Record<string, unknown>): boolean {
    const body = commentBody(comment);
    return Boolean(body && body.trimEnd().endsWith(reviewCommentMarker(number)));
  }

  function newestReviewComment(
    number: number,
    comments: readonly Record<string, unknown>[],
  ): Record<string, unknown> | undefined {
    return [...comments].sort((left, right) => {
      const leftReviewedAt = timestampMs(durableReviewVersion(left, number)?.reviewedAt) ?? -1;
      const rightReviewedAt = timestampMs(durableReviewVersion(right, number)?.reviewedAt) ?? -1;
      if (leftReviewedAt !== rightReviewedAt) return rightReviewedAt - leftReviewedAt;
      const leftUpdatedAt = timestampMs(commentUpdatedAt(left)) ?? -1;
      const rightUpdatedAt = timestampMs(commentUpdatedAt(right)) ?? -1;
      if (leftUpdatedAt !== rightUpdatedAt) return rightUpdatedAt - leftUpdatedAt;
      const leftId = commentId(left) ?? -1;
      const rightId = commentId(right) ?? -1;
      if (leftId !== rightId) return rightId - leftId;
      return reviewCommentBodyDigest(commentBody(right) ?? "").localeCompare(
        reviewCommentBodyDigest(commentBody(left) ?? ""),
      );
    })[0];
  }

  function newestCausalReviewComment(
    number: number,
    comments: readonly Record<string, unknown>[],
  ): Record<string, unknown> | undefined {
    const causalReviews = comments
      .map((comment) => ({
        comment,
        identity: durableReviewCausalIdentity(comment, number),
      }))
      .filter(
        (
          candidate,
        ): candidate is {
          comment: Record<string, unknown>;
          identity: NonNullable<ReturnType<typeof durableReviewCausalIdentity>>;
        } => candidate.identity !== null,
      );
    const latestLeaseCommentId = causalReviews.reduce(
      (latest, candidate) => Math.max(latest, candidate.identity.leaseCommentId),
      -1,
    );
    return newestReviewComment(
      number,
      causalReviews
        .filter((candidate) => candidate.identity.leaseCommentId === latestLeaseCommentId)
        .map((candidate) => candidate.comment),
    );
  }

  function canonicalMarkedReviewComment(
    number: number,
    comments: readonly Record<string, unknown>[],
  ): Record<string, unknown> | undefined {
    const fallback = comments
      .filter((comment) => identitylessPublicationFallback(number, comment))
      .sort((left, right) => (commentId(right) ?? -1) - (commentId(left) ?? -1))[0];
    if (!fallback) {
      return newestCausalReviewComment(number, comments) ?? newestReviewComment(number, comments);
    }
    const fallbackCommentId = commentId(fallback);
    if (fallbackCommentId === null) return fallback;
    const supersedingReviews = comments.filter((comment) => {
      const identity = durableReviewCausalIdentity(comment, number);
      return identity !== null && identity.leaseCommentId > fallbackCommentId;
    });
    // Every review lease POST gets a fresh monotonic GitHub comment id. Only
    // a complete review causally started after this POST may clear the veto.
    return newestCausalReviewComment(number, supersedingReviews) ?? fallback;
  }

  function selectIssueReviewComment(
    number: number,
    comments: Record<string, unknown>[],
    fallbackBodies: readonly string[] = [],
  ): Record<string, unknown> | undefined {
    const markedComments = comments.filter((candidate) =>
      hasExactDurableReviewMarker(number, candidate),
    );
    const patchableMarked = canonicalMarkedReviewComment(
      number,
      markedComments.filter(canPatchReviewComment),
    );
    if (patchableMarked) return patchableMarked;
    const marked = newestReviewComment(number, markedComments);
    if (marked) return marked;
    const exactBodies = new Set(fallbackBodies.map((body) => body.trim()).filter(Boolean));
    const exactComments = comments.filter((candidate) => {
      const body = candidate.body;
      return typeof body === "string" && exactBodies.has(body.trim());
    });
    const patchableExact = newestReviewComment(number, exactComments.filter(canPatchReviewComment));
    if (patchableExact) return patchableExact;
    const exact = newestReviewComment(number, exactComments);
    if (exact) return exact;
    const codexComments = comments.filter((candidate) => {
      const body = candidate.body;
      return typeof body === "string" && isCodexReviewCommentBody(body);
    });
    return (
      newestReviewComment(number, codexComments.filter(canPatchReviewComment)) ??
      newestReviewComment(number, codexComments)
    );
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

  function selectLegacyReviewStartLeaseComments(
    number: number,
    comments: Record<string, unknown>[],
  ): Record<string, unknown>[] {
    return comments.filter((candidate) => {
      const body = commentBody(candidate);
      return Boolean(
        canPatchReviewComment(candidate) &&
        hasExactDurableReviewMarker(number, candidate) &&
        body &&
        /<!--\s*clawsweeper-review-status:started\b/i.test(body),
      );
    });
  }

  function issueReviewCommentState(
    number: number,
    fallbackBodies: readonly string[] = [],
    options: LiveReadOptions & { liveReadGeneration?: LiveReadGeneration } = {},
  ): {
    comments: Record<string, unknown>[];
    reviewComment: Record<string, unknown> | undefined;
    leaseComment: Record<string, unknown> | undefined;
    leaseComments: Record<string, unknown>[];
    dedicatedLeaseComment: Record<string, unknown> | undefined;
    dedicatedLeaseComments: Record<string, unknown>[];
  } {
    const commentsPath = `repos/${targetRepo()}/issues/${number}/comments`;
    const comments = options.liveReadGeneration
      ? options.liveReadGeneration
          .read(
            generationReadKey("paged", [commentsPath]),
            () => ghPaged<unknown>(commentsPath),
            options,
          )
          .map(asRecord)
      : fetchIssueReviewComments(number);
    const reviewComment = selectIssueReviewComment(number, comments, fallbackBodies);
    const dedicatedLeaseComments = selectDedicatedReviewStartLeaseComments(number, comments);
    const dedicatedLeaseComment = selectDedicatedReviewStartLeaseComment(number, comments);
    const legacyLeaseComments = selectLegacyReviewStartLeaseComments(number, comments);
    const leaseComments = [
      ...dedicatedLeaseComments,
      ...legacyLeaseComments.filter((comment) => !dedicatedLeaseComments.includes(comment)),
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
    expectedId?: number,
  ): Record<string, unknown> | undefined {
    if (!body.trim()) return undefined;
    const comments = ghPaged<unknown>(`repos/${targetRepo()}/issues/${number}/comments`).map(
      asRecord,
    );
    const trustedExactComments = comments.filter((candidate) =>
      isReviewPublicationReceipt(candidate, body, expectedId),
    );
    // PATCH recovery is identity-bound; POST recovery elects the newest trusted exact comment.
    return expectedId === undefined
      ? newestReviewComment(number, trustedExactComments)
      : trustedExactComments.find((candidate) => commentId(candidate) === expectedId);
  }

  function isReviewPublicationReceipt(
    comment: Record<string, unknown> | undefined,
    body: string,
    expectedId?: number,
  ): comment is Record<string, unknown> {
    const id = commentId(comment);
    return (
      id !== null &&
      Number.isSafeInteger(id) &&
      id > 0 &&
      (expectedId === undefined || id === expectedId) &&
      canPatchReviewComment(comment) &&
      comment?.body === body
    );
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

  function durableReviewVersionFromBody(
    body: string,
    number: number,
  ): {
    reviewedAt: string;
    headSha: string | null;
    sourceRevision: string | null;
    leaseOwner: string | null;
    leaseCommentId: string | null;
  } | null {
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

  function durableReviewVersion(
    comment: Record<string, unknown> | undefined,
    number: number,
  ): ReturnType<typeof durableReviewVersionFromBody> {
    if (!canPatchReviewComment(comment)) return null;
    const body = commentBody(comment);
    return body ? durableReviewVersionFromBody(body, number) : null;
  }

  function durableReviewCausalIdentityFromBody(
    body: string,
    number: number,
  ): {
    reviewedAt: string;
    headSha: string | null;
    sourceRevision: string | null;
    leaseOwner: string;
    leaseCommentId: number;
    state: "ready" | "blocked" | "needs-changes" | null;
  } | null {
    const identity = reviewCommentMarker(number);
    const identityIndex = body.lastIndexOf(identity);
    if (identityIndex < 0 || body.slice(identityIndex + identity.length).trim()) return null;
    const markers = trailingHtmlComments(body.slice(0, identityIndex));
    const versionMarkers = markers.filter((marker) =>
      /^<!--\s+clawsweeper-review-version\b/.test(marker),
    );
    const stateMarkers = markers.filter((marker) =>
      /^<!--\s+clawsweeper-review-state:/.test(marker),
    );
    if (versionMarkers.length !== 1 || stateMarkers.length > 1) return null;

    const version = durableReviewVersionFromBody(body, number);
    const leaseOwner = version?.leaseOwner?.trim() ?? "";
    const leaseCommentId = version?.leaseCommentId ?? "";
    if (!version || !validReviewLeaseIdentity(leaseOwner, leaseCommentId)) return null;
    const versionHead = versionMarkers[0]?.match(/\bsha=([^\s>]+)/)?.[1];
    // Issue reviews already use a source revision and sha=na, without a PR state marker.
    if (
      versionHead === "na" &&
      stateMarkers.length === 0 &&
      /^[0-9a-f]{64}$/i.test(version.sourceRevision ?? "")
    ) {
      return {
        ...version,
        headSha: null,
        leaseOwner,
        leaseCommentId: Number(leaseCommentId),
        state: null,
      };
    }
    const stateMatch = stateMarkers[0]?.match(
      /^<!--\s+clawsweeper-review-state:([^\s>]+)\b([^>]*)-->$/,
    );
    if (!stateMatch) return null;
    const state = stateMatch[1];
    if (state !== "ready" && state !== "blocked" && state !== "needs-changes") return null;
    const stateAttributes = stateMatch[2] ?? "";
    const stateAttribute = (name: string) =>
      stateAttributes.match(new RegExp(`\\b${name}=([^\\s>]+)`))?.[1] ?? null;
    const stateHeadSha = stateAttribute("sha")?.toLowerCase() ?? "";
    const versionHeadSha = version.headSha?.toLowerCase() ?? "";
    if (
      Number(stateAttribute("item")) !== number ||
      stateAttribute("v") !== "1" ||
      !/^[0-9a-f]{40}$/.test(stateHeadSha) ||
      !/^[0-9a-f]{40}$/.test(versionHeadSha) ||
      stateHeadSha !== versionHeadSha
    ) {
      return null;
    }
    return {
      reviewedAt: version.reviewedAt,
      headSha: versionHeadSha,
      sourceRevision: version.sourceRevision,
      leaseOwner,
      leaseCommentId: Number(leaseCommentId),
      state,
    };
  }

  function durableReviewCausalIdentity(
    comment: Record<string, unknown> | undefined,
    number: number,
  ): ReturnType<typeof durableReviewCausalIdentityFromBody> {
    if (!canPatchReviewComment(comment)) return null;
    const body = commentBody(comment);
    return body ? durableReviewCausalIdentityFromBody(body, number) : null;
  }

  function identitylessPublicationFallback(
    number: number,
    comment: Record<string, unknown> | undefined,
  ): boolean {
    const body = commentBody(comment);
    if (!comment || !canPatchReviewComment(comment) || !body) return false;
    return (
      body.trimStart().startsWith("Codex review: publication failed closed.") &&
      hasExactDurableReviewMarker(number, comment) &&
      !durableReviewCausalIdentityFromBody(body, number)
    );
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
        liveReviewedAtMs !== reportReviewedAtMs
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

  function newerDurableReviewTupleVerified(
    markdown: string,
    existingReviewComment: Record<string, unknown> | undefined,
    number: number,
  ): boolean {
    // Superseding is terminal, so require the complete durable tuple rather
    // than a newer timestamp or comment body that could describe another review.
    const liveVersion = durableReviewVersion(existingReviewComment, number);
    const reportLeaseOwner = frontMatterValue(markdown, "review_lease_owner");
    const liveLeaseCommentId = Number(liveVersion?.leaseCommentId);
    const reportLeaseCommentId = Number(frontMatterValue(markdown, "review_lease_comment_id"));
    const reportRevision = reviewLeaseRevisionFromReport(markdown);
    const itemKind = frontMatterValue(markdown, "type");
    const liveRevision =
      itemKind === "pull_request" ? liveVersion?.headSha : liveVersion?.sourceRevision;
    return Boolean(
      liveVersion?.leaseOwner &&
      liveVersion.leaseOwner !== "unknown" &&
      reportLeaseOwner &&
      reportLeaseOwner !== "unknown" &&
      liveRevision &&
      reportRevision &&
      liveRevision === reportRevision &&
      Number.isSafeInteger(liveLeaseCommentId) &&
      liveLeaseCommentId > 0 &&
      Number.isSafeInteger(reportLeaseCommentId) &&
      reportLeaseCommentId > 0 &&
      liveLeaseCommentId > reportLeaseCommentId,
    );
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
    if (!actual) return false;
    const normalizedActual = normalizeNoopReviewMarkerMetadata(actual);
    const normalizedExpected = normalizeNoopReviewMarkerMetadata(expected);
    if (normalizedActual === normalizedExpected) return true;
    if (!options.allowApplyCloseActionUpgrade) return false;
    return (
      normalizeApplySyncCloseMarkerAction(normalizedActual) ===
      normalizeApplySyncCloseMarkerAction(normalizedExpected)
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
    if (!storedHash) return false;
    const actual = commentBody(comment)?.trim();
    if (!actual) return false;
    const normalizedActual = normalizeNoopReviewMarkerMetadata(actual);
    const normalizedExpected = normalizeNoopReviewMarkerMetadata(body.trim());
    const equivalent = options.allowApplyCloseActionUpgrade
      ? normalizeApplySyncCloseMarkerAction(normalizedActual) ===
        normalizeApplySyncCloseMarkerAction(normalizedExpected)
      : normalizedActual === normalizedExpected;
    if (!equivalent) return false;
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

  return {
    markedReviewCommentBody,
    reviewStartLeaseCommentMarker,
    markedReviewStartLeaseCommentBody,
    reviewStartStatusCommentMarker,
    withReviewStartStatusLease,
    withReviewStartStatusLeaseIdentity,
    shouldPreserveReviewStartLease,
    renderReviewStartStatusComment,
    isCodexReviewCommentBody,
    fetchIssueReviewComments,
    hasExactDurableReviewMarker,
    newestReviewComment,
    selectIssueReviewComment,
    selectDedicatedReviewStartLeaseComment,
    selectDedicatedReviewStartLeaseComments,
    issueReviewCommentState,
    issueReviewComment,
    issueReviewCommentWithBody,
    isReviewPublicationReceipt,
    commentUpdatedAt,
    commentId,
    commentUrl,
    commentBody,
    newestReviewMarkerAttribute,
    durableReviewVersionFromBody,
    durableReviewVersion,
    durableReviewCausalIdentityFromBody,
    identitylessPublicationFallback,
    reviewCommentHasCloseVerdictForCanonical,
    staleReviewCommentSyncReason,
    newerDurableReviewTupleVerified,
    APPLY_SYNC_EQUIVALENT_CLOSE_MARKER_ACTIONS,
    normalizeApplySyncCloseMarkerAction,
    commentBodyMatches,
    reviewCommentHashMatches,
    PATCHABLE_REVIEW_COMMENT_AUTHORS,
    commentAuthorLogin,
    canPatchReviewComment,
    lockedConversationApplyReason,
  };
}
