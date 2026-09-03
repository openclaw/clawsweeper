import { stableJson } from "../src/stable-json.ts";
import {
  DIRECT_PUBLICATION_LIFECYCLE_KINDS,
  type DirectPublicationLifecyclePlan,
} from "./exact-review-direct-publication.ts";
import { exactReviewScheduledLane, objectValue } from "./exact-review-queue-shared.ts";
import type { ExactReviewQueueItem } from "./exact-review-queue.ts";

export const FAILED_REVIEW_SHARD_RECOVERY_SOURCE_ACTION = "failed_review_shard_recovery";
export const EXACT_REVIEW_ARTIFACT_PUBLISH_SOURCE_ACTION = "exact_review_artifact_publish";
export const EXACT_REVIEW_ARTIFACT_RETENTION_RECOVERY_SOURCE_ACTION = "artifact_retention_recovery";
export const EXACT_REVIEW_SOURCE_DRIFT_REQUEUE_SOURCE_ACTION = "source_drift_requeue";
const EXACT_REVIEW_LOW_PRIORITY_SOURCE_ACTIONS = new Set([
  FAILED_REVIEW_SHARD_RECOVERY_SOURCE_ACTION,
  EXACT_REVIEW_ARTIFACT_RETENTION_RECOVERY_SOURCE_ACTION,
  EXACT_REVIEW_SOURCE_DRIFT_REQUEUE_SOURCE_ACTION,
]);
export const EXACT_REVIEW_SOURCE_AUTHORITY_RESERVATION_PREFIX =
  "exact-review-source-authority-reservation:v1:";
export const EXACT_REVIEW_BRANCH_AUTHORITY_RESERVATION_PREFIX =
  "exact-review-branch-authority-reservation:v1:";
export const EXACT_REVIEW_SOURCE_AUTHORITY_RETRY_LIMIT = 16;
const EXACT_REVIEW_COMMAND_STATUS_MARKER_PATTERN =
  /^<!-- clawsweeper-command-status:[^<>\r\n]{1,200} -->$/;
const EXACT_REVIEW_ADDITIONAL_PROMPT_MAX_CHARS = 5000;
const EXACT_REVIEW_INGRESS_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

export type ExactReviewBaseDecision = {
  targetRepo: string;
  targetBranch: string;
  itemNumber: number;
  itemKind: "issue" | "pull_request";
  sourceEvent: "issues" | "pull_request";
  sourceAction: string;
  supersedesInProgress: boolean;
  sourceHeadSha?: string;
  sourceBaseSha?: string;
  sourceIsDraft?: boolean;
  sourceContentRevision?: string;
  sourceHeadVerified?: boolean;
  sourceAuthoritySeq?: number;
  sourceUpdatedAt?: string;
  sourceDeliveryId?: string;
  bayJourneyDeliveryId?: string;
  codexTimeoutMs?: number;
  mediaProofTimeoutMs?: number;
  commandStatusMarker?: string;
  statusCommentId?: number;
  reviewAcknowledgementCommentId?: number;
  additionalPrompt?: string;
  sourceCommentId?: number;
  sourceCommentUpdatedAt?: string;
  commandBodyDigest?: string;
  commandOrigin?: "hosted_webhook" | "comment_router";
  sourceCommentVerified?: boolean;
};
export type ExactReviewPublication = {
  artifactName: string;
  producerRunId: string;
  producerRunAttempt: number;
  sourceSha: string;
  itemKey: string;
  protocolVersion: 1 | 2;
  leaseRevision: number | null;
  claimGeneration: number | null;
  liveProceeded: boolean;
  liveTerminalNoop: boolean;
  liveTerminalMissing: boolean;
  liveGuardedOpen: boolean;
  producerDecision: ExactReviewBaseDecision;
  directLifecycle?: {
    plan: DirectPublicationLifecyclePlan;
    receiptOutcome: "accepted" | "deduped" | "superseded";
  };
};
export type ExactReviewDecision = ExactReviewBaseDecision & {
  publication?: ExactReviewPublication;
};
export type ExactReviewIngress = {
  route: "direct_webhook" | "target_dispatcher";
  fingerprint: string;
};
export type ExactReviewSourceAuthorityReservation = {
  deliveryId: string;
  decision: ExactReviewDecision;
  ingress?: ExactReviewIngress;
  installationId: number;
  sourceAuthoritySeq: number;
  reviewAcknowledgementPending?: boolean;
  attempts: number;
  nextAttemptAt: number;
};
export type ExactReviewBranchAuthorityDecision = Omit<
  ExactReviewDecision,
  "targetBranch" | "publication"
>;
export type ExactReviewBranchAuthorityReservation = {
  deliveryId: string;
  decision: ExactReviewBranchAuthorityDecision;
  ingress?: ExactReviewIngress;
  installationId?: number;
  sourceAuthorityRequired: boolean;
  attempts: number;
  nextAttemptAt: number;
};
export type ExactReviewEditedSemanticInput = {
  // Queue state preserves the repository's display casing, while this durable
  // semantic cursor canonicalizes it so equivalent GitHub repository spellings
  // share one fingerprint.
  queueKey: string;
  storageKey: string;
  fingerprint: string;
};
export type ExactReviewTargetItemState =
  | { state: "open"; headSha?: string }
  | { state: "terminal" }
  | { state: "unavailable" };

export function exactReviewDecisionFrom(value: unknown): ExactReviewDecision | null {
  const base = exactReviewBaseDecisionFrom(value);
  if (!base) return null;
  const decision = objectValue(value);
  const hasPublication = Object.hasOwn(decision, "publication");
  const publication = hasPublication ? exactReviewPublicationFrom(decision.publication) : undefined;
  if (hasPublication && !publication) return null;
  if (publication) {
    if (base.sourceAction !== EXACT_REVIEW_ARTIFACT_PUBLISH_SOURCE_ACTION) return null;
    if (
      publication.producerDecision.sourceAction === EXACT_REVIEW_ARTIFACT_PUBLISH_SOURCE_ACTION ||
      publication.producerDecision.targetRepo !== base.targetRepo ||
      publication.producerDecision.targetBranch !== base.targetBranch ||
      publication.producerDecision.itemNumber !== base.itemNumber ||
      publication.producerDecision.itemKind !== base.itemKind ||
      publication.producerDecision.sourceEvent !== base.sourceEvent ||
      publication.itemKey !== `${base.targetRepo}#${base.itemNumber}`
    ) {
      return null;
    }
  } else if (base.sourceAction === EXACT_REVIEW_ARTIFACT_PUBLISH_SOURCE_ACTION) {
    return null;
  }
  return { ...base, ...(publication ? { publication } : {}) };
}

export function exactReviewDecisionWithoutSourceAuthority(decision: ExactReviewDecision) {
  const {
    sourceAuthoritySeq: _sourceAuthoritySeq,
    sourceHeadVerified: _sourceHeadVerified,
    // These semantic edit fields were added after source-authority reservations
    // already existed. They affect queue admission, not the identity of an
    // already-reserved delivery, so omit them while matching a redelivery.
    sourceBaseSha: _sourceBaseSha,
    sourceIsDraft: _sourceIsDraft,
    sourceContentRevision: _sourceContentRevision,
    reviewAcknowledgementCommentId: _reviewAcknowledgementCommentId,
    ...rest
  } = decision;
  return rest;
}

export function exactReviewBranchAuthorityDecisionFrom(
  value: unknown,
): ExactReviewBranchAuthorityDecision | null {
  const raw = objectValue(value);
  if (String(raw.targetBranch || "").trim() || Object.hasOwn(raw, "publication")) return null;
  const parsed = exactReviewDecisionFrom({
    ...raw,
    targetBranch: "branch-authority-pending",
  });
  if (!parsed || parsed.publication) return null;
  const { targetBranch: _targetBranch, ...decision } = parsed;
  return decision;
}

export function exactReviewBranchAuthorityReservationKey(deliveryId: string) {
  return `${EXACT_REVIEW_BRANCH_AUTHORITY_RESERVATION_PREFIX}${encodeURIComponent(deliveryId)}`;
}

export function exactReviewBranchAuthorityReservationFrom(
  value: unknown,
): ExactReviewBranchAuthorityReservation | null {
  const reservation = objectValue(value);
  const deliveryId = String(reservation.deliveryId || "").trim();
  const decision = exactReviewBranchAuthorityDecisionFrom(reservation.decision);
  const ingress =
    reservation.ingress === undefined ? undefined : exactReviewIngressFrom(reservation.ingress);
  const installationId =
    reservation.installationId === undefined ? undefined : Number(reservation.installationId);
  const sourceAuthorityRequired = reservation.sourceAuthorityRequired === true;
  const attempts = Number(reservation.attempts);
  const nextAttemptAt = Number(reservation.nextAttemptAt);
  if (
    !deliveryId ||
    deliveryId.length > 200 ||
    !decision ||
    (reservation.ingress !== undefined && !ingress) ||
    (installationId !== undefined && (!Number.isInteger(installationId) || installationId <= 0)) ||
    (sourceAuthorityRequired &&
      (decision.itemKind !== "pull_request" ||
        installationId === undefined ||
        ingress?.route === "target_dispatcher")) ||
    typeof reservation.sourceAuthorityRequired !== "boolean" ||
    !Number.isInteger(attempts) ||
    attempts < 0 ||
    attempts > EXACT_REVIEW_SOURCE_AUTHORITY_RETRY_LIMIT ||
    !Number.isSafeInteger(nextAttemptAt) ||
    nextAttemptAt < 0
  ) {
    return null;
  }
  return {
    deliveryId,
    decision,
    ...(ingress ? { ingress } : {}),
    ...(installationId === undefined ? {} : { installationId }),
    sourceAuthorityRequired,
    attempts,
    nextAttemptAt,
  };
}

export function exactReviewSourceAuthorityReservationKey(deliveryId: string) {
  return `${EXACT_REVIEW_SOURCE_AUTHORITY_RESERVATION_PREFIX}${encodeURIComponent(deliveryId)}`;
}

export function exactReviewSourceAuthorityReservationFrom(
  value: unknown,
): ExactReviewSourceAuthorityReservation | null {
  const reservation = objectValue(value);
  const deliveryId = String(reservation.deliveryId || "").trim();
  const decision = exactReviewDecisionFrom(reservation.decision);
  const ingress =
    reservation.ingress === undefined ? undefined : exactReviewIngressFrom(reservation.ingress);
  const installationId = Number(reservation.installationId);
  const sourceAuthoritySeq = Number(reservation.sourceAuthoritySeq);
  const reviewAcknowledgementPending = reservation.reviewAcknowledgementPending === true;
  const attempts = Number(reservation.attempts);
  const nextAttemptAt = Number(reservation.nextAttemptAt);
  if (
    !deliveryId ||
    deliveryId.length > 200 ||
    !decision ||
    decision.itemKind !== "pull_request" ||
    decision.publication ||
    (reservation.ingress !== undefined && (!ingress || ingress.route !== "direct_webhook")) ||
    !Number.isInteger(installationId) ||
    installationId <= 0 ||
    !Number.isSafeInteger(sourceAuthoritySeq) ||
    sourceAuthoritySeq <= 0 ||
    decision.sourceAuthoritySeq !== sourceAuthoritySeq ||
    (reservation.reviewAcknowledgementPending !== undefined &&
      typeof reservation.reviewAcknowledgementPending !== "boolean") ||
    !Number.isInteger(attempts) ||
    attempts < 0 ||
    attempts > EXACT_REVIEW_SOURCE_AUTHORITY_RETRY_LIMIT ||
    !Number.isSafeInteger(nextAttemptAt) ||
    nextAttemptAt < 0
  ) {
    return null;
  }
  return {
    deliveryId,
    decision,
    ...(ingress ? { ingress } : {}),
    installationId,
    sourceAuthoritySeq,
    ...(reviewAcknowledgementPending ? { reviewAcknowledgementPending: true } : {}),
    attempts,
    nextAttemptAt,
  };
}

export function exactReviewIngressFrom(value: unknown): ExactReviewIngress | null {
  const ingress = objectValue(value);
  const route = String(ingress.route || "");
  const fingerprint = String(ingress.fingerprint || "")
    .trim()
    .toLowerCase();
  if (route !== "direct_webhook" && route !== "target_dispatcher") return null;
  if (!EXACT_REVIEW_INGRESS_FINGERPRINT_PATTERN.test(fingerprint)) return null;
  return { route, fingerprint };
}

export function exactReviewIngressCanPromoteFallback(
  ingress: ExactReviewIngress | undefined,
  decision: ExactReviewDecision,
) {
  const sourceAuthoritySeq = Number(decision.sourceAuthoritySeq || 0);
  return (
    ingress?.route === "direct_webhook" &&
    decision.sourceHeadVerified === true &&
    /^[0-9a-f]{40}$/.test(String(decision.sourceHeadSha || "").toLowerCase()) &&
    Number.isSafeInteger(sourceAuthoritySeq) &&
    sourceAuthoritySeq > 0
  );
}

export function exactReviewBaseDecisionFrom(value: unknown): ExactReviewBaseDecision | null {
  const decision = objectValue(value);
  const targetRepo = String(decision.targetRepo || "").trim();
  const targetBranch = String(decision.targetBranch || "").trim();
  const itemNumber = Number(decision.itemNumber);
  const itemKind = String(decision.itemKind || "");
  const sourceEvent = String(decision.sourceEvent || "");
  const sourceAction = String(decision.sourceAction || "");
  const hasSourceHeadSha = Object.hasOwn(decision, "sourceHeadSha");
  const sourceHeadSha = hasSourceHeadSha
    ? String(decision.sourceHeadSha || "")
        .trim()
        .toLowerCase()
    : undefined;
  const hasSourceBaseSha = Object.hasOwn(decision, "sourceBaseSha");
  const sourceBaseSha = hasSourceBaseSha
    ? String(decision.sourceBaseSha || "")
        .trim()
        .toLowerCase()
    : undefined;
  const hasSourceIsDraft = Object.hasOwn(decision, "sourceIsDraft");
  const hasSourceContentRevision = Object.hasOwn(decision, "sourceContentRevision");
  const sourceContentRevision = hasSourceContentRevision
    ? String(decision.sourceContentRevision || "")
        .trim()
        .toLowerCase()
    : undefined;
  const hasSourceHeadVerified = Object.hasOwn(decision, "sourceHeadVerified");
  const hasSourceAuthoritySeq = Object.hasOwn(decision, "sourceAuthoritySeq");
  const sourceAuthoritySeq = hasSourceAuthoritySeq
    ? Number(decision.sourceAuthoritySeq)
    : undefined;
  const hasSourceUpdatedAt = Object.hasOwn(decision, "sourceUpdatedAt");
  const sourceUpdatedAt = hasSourceUpdatedAt
    ? String(decision.sourceUpdatedAt || "").trim()
    : undefined;
  const hasSourceDeliveryId = Object.hasOwn(decision, "sourceDeliveryId");
  const sourceDeliveryId = hasSourceDeliveryId ? decision.sourceDeliveryId : undefined;
  const hasBayJourneyDeliveryId = Object.hasOwn(decision, "bayJourneyDeliveryId");
  const bayJourneyDeliveryId = hasBayJourneyDeliveryId ? decision.bayJourneyDeliveryId : undefined;
  const hasCommandStatusMarker = Object.hasOwn(decision, "commandStatusMarker");
  const commandStatusMarker = hasCommandStatusMarker ? decision.commandStatusMarker : undefined;
  const hasStatusCommentId = Object.hasOwn(decision, "statusCommentId");
  const statusCommentId = hasStatusCommentId ? Number(decision.statusCommentId) : undefined;
  const hasReviewAcknowledgementCommentId = Object.hasOwn(
    decision,
    "reviewAcknowledgementCommentId",
  );
  const reviewAcknowledgementCommentId = hasReviewAcknowledgementCommentId
    ? Number(decision.reviewAcknowledgementCommentId)
    : undefined;
  const hasAdditionalPrompt = Object.hasOwn(decision, "additionalPrompt");
  const additionalPrompt = hasAdditionalPrompt ? decision.additionalPrompt : undefined;
  const hasSourceCommentId = Object.hasOwn(decision, "sourceCommentId");
  const sourceCommentId = hasSourceCommentId ? Number(decision.sourceCommentId) : undefined;
  const hasSourceCommentUpdatedAt = Object.hasOwn(decision, "sourceCommentUpdatedAt");
  const sourceCommentUpdatedAt = hasSourceCommentUpdatedAt
    ? String(decision.sourceCommentUpdatedAt || "").trim()
    : undefined;
  const hasCommandBodyDigest = Object.hasOwn(decision, "commandBodyDigest");
  const commandBodyDigest = hasCommandBodyDigest
    ? String(decision.commandBodyDigest || "")
        .trim()
        .toLowerCase()
    : undefined;
  const hasCommandOrigin = Object.hasOwn(decision, "commandOrigin");
  const commandOrigin = hasCommandOrigin ? String(decision.commandOrigin || "") : undefined;
  const hasSourceCommentVerified = Object.hasOwn(decision, "sourceCommentVerified");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(targetRepo)) return null;
  if (!/^[A-Za-z0-9_./-]+$/.test(targetBranch)) return null;
  if (!Number.isInteger(itemNumber) || itemNumber <= 0) return null;
  if (itemKind !== "issue" && itemKind !== "pull_request") return null;
  if (sourceEvent !== "issues" && sourceEvent !== "pull_request") return null;
  if (!sourceAction) return null;
  if (hasSourceHeadSha && !/^[0-9a-f]{40}$/.test(sourceHeadSha || "")) return null;
  if (hasSourceBaseSha && !/^[0-9a-f]{40}$/.test(sourceBaseSha || "")) return null;
  if (hasSourceIsDraft && typeof decision.sourceIsDraft !== "boolean") return null;
  if (hasSourceContentRevision && !/^[0-9a-f]{64}$/.test(sourceContentRevision || "")) {
    return null;
  }
  if (hasSourceHeadVerified && typeof decision.sourceHeadVerified !== "boolean") return null;
  if (
    hasSourceAuthoritySeq &&
    (!Number.isSafeInteger(sourceAuthoritySeq) || Number(sourceAuthoritySeq) <= 0)
  ) {
    return null;
  }
  if (hasSourceUpdatedAt && !Number.isFinite(Date.parse(sourceUpdatedAt || ""))) return null;
  if (
    hasSourceDeliveryId &&
    (typeof sourceDeliveryId !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(sourceDeliveryId))
  ) {
    return null;
  }
  if (
    hasBayJourneyDeliveryId &&
    (typeof bayJourneyDeliveryId !== "string" ||
      !/^[A-Za-z0-9_.:-]{1,200}$/.test(bayJourneyDeliveryId))
  ) {
    return null;
  }
  if (
    hasCommandStatusMarker &&
    (typeof commandStatusMarker !== "string" ||
      !EXACT_REVIEW_COMMAND_STATUS_MARKER_PATTERN.test(commandStatusMarker))
  ) {
    return null;
  }
  if (
    hasStatusCommentId &&
    (!Number.isSafeInteger(statusCommentId) || Number(statusCommentId) <= 0)
  ) {
    return null;
  }
  if (
    hasReviewAcknowledgementCommentId &&
    (itemKind !== "pull_request" ||
      !Number.isSafeInteger(reviewAcknowledgementCommentId) ||
      Number(reviewAcknowledgementCommentId) <= 0)
  ) {
    return null;
  }
  if (
    hasAdditionalPrompt &&
    (typeof additionalPrompt !== "string" ||
      additionalPrompt.length > EXACT_REVIEW_ADDITIONAL_PROMPT_MAX_CHARS ||
      additionalPrompt.includes("\0"))
  ) {
    return null;
  }
  if (
    hasSourceCommentId &&
    (!Number.isSafeInteger(sourceCommentId) || Number(sourceCommentId) <= 0)
  ) {
    return null;
  }
  if (hasSourceCommentUpdatedAt && !Number.isFinite(Date.parse(sourceCommentUpdatedAt || ""))) {
    return null;
  }
  if (hasCommandBodyDigest && !/^[0-9a-f]{64}$/.test(commandBodyDigest || "")) return null;
  if (
    hasCommandOrigin &&
    commandOrigin !== "hosted_webhook" &&
    commandOrigin !== "comment_router"
  ) {
    return null;
  }
  if (hasSourceCommentVerified && typeof decision.sourceCommentVerified !== "boolean") return null;
  const commandMetadataCount = [
    hasSourceCommentId,
    hasSourceCommentUpdatedAt,
    hasCommandBodyDigest,
    hasCommandOrigin,
  ].filter(Boolean).length;
  if (commandMetadataCount !== 0 && commandMetadataCount !== 4) return null;
  return {
    targetRepo,
    targetBranch,
    itemNumber,
    itemKind,
    sourceEvent,
    sourceAction,
    supersedesInProgress: Boolean(decision.supersedesInProgress),
    ...(sourceHeadSha === undefined ? {} : { sourceHeadSha }),
    ...(sourceBaseSha === undefined ? {} : { sourceBaseSha }),
    ...(typeof decision.sourceIsDraft === "boolean"
      ? { sourceIsDraft: decision.sourceIsDraft }
      : {}),
    ...(sourceContentRevision === undefined ? {} : { sourceContentRevision }),
    ...(typeof decision.sourceHeadVerified === "boolean"
      ? { sourceHeadVerified: decision.sourceHeadVerified }
      : {}),
    ...(sourceAuthoritySeq === undefined ? {} : { sourceAuthoritySeq }),
    ...(sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt }),
    ...(typeof sourceDeliveryId === "string" ? { sourceDeliveryId } : {}),
    ...(typeof bayJourneyDeliveryId === "string" ? { bayJourneyDeliveryId } : {}),
    ...(Number.isFinite(Number(decision.codexTimeoutMs))
      ? { codexTimeoutMs: Number(decision.codexTimeoutMs) }
      : {}),
    ...(Number.isFinite(Number(decision.mediaProofTimeoutMs))
      ? { mediaProofTimeoutMs: Number(decision.mediaProofTimeoutMs) }
      : {}),
    ...(typeof commandStatusMarker === "string" ? { commandStatusMarker } : {}),
    ...(statusCommentId === undefined ? {} : { statusCommentId }),
    ...(reviewAcknowledgementCommentId === undefined ? {} : { reviewAcknowledgementCommentId }),
    ...(typeof additionalPrompt === "string" ? { additionalPrompt } : {}),
    ...(sourceCommentId === undefined ? {} : { sourceCommentId }),
    ...(sourceCommentUpdatedAt === undefined ? {} : { sourceCommentUpdatedAt }),
    ...(commandBodyDigest === undefined ? {} : { commandBodyDigest }),
    ...(commandOrigin === "hosted_webhook" || commandOrigin === "comment_router"
      ? { commandOrigin }
      : {}),
    ...(typeof decision.sourceCommentVerified === "boolean"
      ? { sourceCommentVerified: decision.sourceCommentVerified }
      : {}),
  };
}

export async function exactReviewEditedSemanticInput(
  decision: ExactReviewDecision,
): Promise<ExactReviewEditedSemanticInput | null> {
  if (
    decision.itemKind !== "pull_request" ||
    decision.sourceEvent !== "pull_request" ||
    decision.sourceAction !== "edited" ||
    decision.publication
  ) {
    return null;
  }
  const headSha = String(decision.sourceHeadSha || "").toLowerCase();
  const baseSha = String(decision.sourceBaseSha || "").toLowerCase();
  const contentRevision = String(decision.sourceContentRevision || "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(headSha) || !/^[0-9a-f]{40}$/.test(baseSha)) return null;
  if (typeof decision.sourceIsDraft !== "boolean") return null;
  if (!/^[0-9a-f]{64}$/.test(contentRevision)) return null;

  const tuple = stableJson({
    version: 1,
    target_repo: decision.targetRepo.toLowerCase(),
    target_branch: decision.targetBranch,
    item_number: decision.itemNumber,
    head_sha: headSha,
    base_sha: baseSha,
    is_draft: decision.sourceIsDraft,
    content_revision: contentRevision,
    request: {
      codex_timeout_ms: Number.isFinite(decision.codexTimeoutMs) ? decision.codexTimeoutMs : null,
      media_proof_timeout_ms: Number.isFinite(decision.mediaProofTimeoutMs)
        ? decision.mediaProofTimeoutMs
        : null,
      command_status_marker: decision.commandStatusMarker || null,
      status_comment_id: Number.isSafeInteger(decision.statusCommentId)
        ? decision.statusCommentId
        : null,
      additional_prompt: decision.additionalPrompt || null,
    },
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tuple));
  const queueKey = exactReviewItemKey(decision);
  return {
    queueKey,
    storageKey: queueKey.toLowerCase(),
    fingerprint: Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
  };
}

export function exactReviewPublicationRevision(decision: ExactReviewDecision): {
  targetKey: string;
  sourceRevision: number;
} | null {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) return null;
  const publication = decision.publication;
  if (
    !publication ||
    typeof publication !== "object" ||
    Array.isArray(publication) ||
    publication.protocolVersion !== 2 ||
    publication.leaseRevision === null ||
    typeof publication.itemKey !== "string"
  ) {
    return null;
  }
  return {
    targetKey: publication.itemKey.toLowerCase(),
    sourceRevision: publication.leaseRevision,
  };
}

export type ExactReviewPublicationLineage = {
  targetKey: string;
  sourceRevision: number;
  claimGeneration: number;
};

export function exactReviewPublicationLineage(
  decision: ExactReviewDecision,
): ExactReviewPublicationLineage | null {
  const publication = decision.publication;
  if (!publication || publication.protocolVersion !== 2 || publication.leaseRevision === null) {
    return null;
  }
  if (publication.claimGeneration === null) return null;
  return {
    targetKey: publication.itemKey.toLowerCase(),
    sourceRevision: publication.leaseRevision,
    claimGeneration: publication.claimGeneration,
  };
}

export function exactReviewPublicationLineageKey(lineage: ExactReviewPublicationLineage) {
  return `${lineage.targetKey}\u0000${lineage.sourceRevision}\u0000${lineage.claimGeneration}`;
}

export function exactReviewPublicationProducerIsNewer(
  incoming: ExactReviewPublication,
  retained: ExactReviewPublication,
) {
  const runComparison = compareDecimalIdentifiers(incoming.producerRunId, retained.producerRunId);
  return (
    runComparison > 0 ||
    (runComparison === 0 && incoming.producerRunAttempt > retained.producerRunAttempt)
  );
}

export function compareDecimalIdentifiers(left: string, right: string) {
  const normalizedLeft = left.replace(/^0+/, "") || "0";
  const normalizedRight = right.replace(/^0+/, "") || "0";
  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedLeft.length - normalizedRight.length;
  }
  return normalizedLeft.localeCompare(normalizedRight);
}

export function exactReviewPublicationFrom(value: unknown): ExactReviewPublication | null {
  const publication = objectValue(value);
  const artifactName = String(publication.artifactName || "").trim();
  const producerRunId = String(publication.producerRunId || "").trim();
  const producerRunAttempt = Number(publication.producerRunAttempt);
  const sourceSha = String(publication.sourceSha || "").trim();
  const itemKey = String(publication.itemKey || "").trim();
  const protocolVersion = Number(publication.protocolVersion);
  const leaseRevision =
    publication.leaseRevision === null ? null : Number(publication.leaseRevision);
  const claimGeneration =
    publication.claimGeneration === null ? null : Number(publication.claimGeneration);
  const producerDecision = exactReviewBaseDecisionFrom(publication.producerDecision);
  const liveProceeded = publication.liveProceeded;
  const liveTerminalNoop = publication.liveTerminalNoop;
  const liveTerminalMissing = publication.liveTerminalMissing;
  const liveGuardedOpen = publication.liveGuardedOpen;
  const hasDirectLifecycle = Object.hasOwn(publication, "directLifecycle");
  const directLifecycle = hasDirectLifecycle
    ? exactReviewDirectLifecycleReceiptFrom(publication.directLifecycle)
    : undefined;
  if (!/^exact-review-\d{1,30}-[1-9]\d*$/.test(artifactName)) return null;
  if (!/^\d{1,30}$/.test(producerRunId)) return null;
  if (!Number.isSafeInteger(producerRunAttempt) || producerRunAttempt < 1) return null;
  if (artifactName !== `exact-review-${producerRunId}-${producerRunAttempt}`) return null;
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) return null;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*$/.test(itemKey)) return null;
  if (protocolVersion !== 1 && protocolVersion !== 2) return null;
  if (
    (leaseRevision !== null && (!Number.isSafeInteger(leaseRevision) || leaseRevision < 1)) ||
    (claimGeneration !== null && (!Number.isSafeInteger(claimGeneration) || claimGeneration < 1))
  ) {
    return null;
  }
  if (protocolVersion === 2 && (leaseRevision === null || claimGeneration === null)) return null;
  if (!producerDecision) return null;
  if (hasDirectLifecycle && !directLifecycle) return null;
  if (
    typeof liveProceeded !== "boolean" ||
    typeof liveTerminalNoop !== "boolean" ||
    typeof liveTerminalMissing !== "boolean" ||
    typeof liveGuardedOpen !== "boolean"
  ) {
    return null;
  }
  const liveOutcomes = [liveProceeded, liveTerminalNoop, liveTerminalMissing, liveGuardedOpen];
  if (liveOutcomes.filter(Boolean).length !== 1) return null;
  return {
    artifactName,
    producerRunId,
    producerRunAttempt,
    sourceSha,
    itemKey,
    protocolVersion,
    leaseRevision,
    claimGeneration,
    liveProceeded,
    liveTerminalNoop,
    liveTerminalMissing,
    liveGuardedOpen,
    producerDecision,
    ...(directLifecycle ? { directLifecycle } : {}),
  };
}

export function exactReviewDirectLifecycleReceiptFrom(
  value: unknown,
): ExactReviewPublication["directLifecycle"] {
  const receipt = objectValue(value);
  const plan = objectValue(receipt.plan);
  if (Object.keys(plan).length !== 1 || typeof plan.kind !== "string") return undefined;
  if (!(DIRECT_PUBLICATION_LIFECYCLE_KINDS as readonly string[]).includes(plan.kind)) {
    return undefined;
  }
  const receiptOutcome = receipt.receiptOutcome;
  if (
    receiptOutcome !== "accepted" &&
    receiptOutcome !== "deduped" &&
    receiptOutcome !== "superseded"
  ) {
    return undefined;
  }
  return {
    plan: { kind: plan.kind as DirectPublicationLifecyclePlan["kind"] },
    receiptOutcome,
  };
}

export function mergePendingExactReviewDecision(
  current: ExactReviewDecision,
  next: ExactReviewDecision,
): ExactReviewDecision {
  const merged = { ...current, ...next };
  const commandMarkerChanged =
    Object.hasOwn(next, "commandStatusMarker") &&
    next.commandStatusMarker !== current.commandStatusMarker;
  if (commandMarkerChanged && !Object.hasOwn(next, "statusCommentId")) {
    delete merged.statusCommentId;
  }
  if (
    (Object.hasOwn(next, "commandStatusMarker") || Object.hasOwn(next, "statusCommentId")) &&
    !Object.hasOwn(next, "sourceDeliveryId")
  ) {
    delete merged.sourceDeliveryId;
  }
  if (Object.hasOwn(next, "sourceUpdatedAt") && !Object.hasOwn(next, "sourceContentRevision")) {
    delete merged.sourceContentRevision;
  }
  return merged;
}

export function exactReviewDecisionHasCommandContext(decision: ExactReviewDecision) {
  return Boolean(decision.commandStatusMarker || decision.statusCommentId);
}

export function exactReviewCommandObligationSurvives(
  current: ExactReviewDecision,
  incoming: ExactReviewDecision,
) {
  if (!exactReviewDecisionHasCommandContext(current)) return true;
  if (!exactReviewDecisionHasCommandContext(incoming)) return false;
  return (
    (current.commandStatusMarker ?? null) === (incoming.commandStatusMarker ?? null) &&
    (current.statusCommentId ?? null) === (incoming.statusCommentId ?? null)
  );
}

export function exactReviewDecisionAtLiveHead(decision: ExactReviewDecision, headSha: string) {
  const refreshed = {
    ...decision,
    sourceHeadSha: headSha,
    sourceHeadVerified: true,
  };
  // The live read is authoritative for the head, but it has no webhook
  // sequence or event timestamp to truthfully carry forward.
  delete refreshed.sourceAuthoritySeq;
  delete refreshed.sourceUpdatedAt;
  return refreshed;
}

export function exactReviewQueueHasStaleLiveHead(
  item: Pick<ExactReviewQueueItem, "decision">,
  live: ExactReviewTargetItemState,
): live is { state: "open"; headSha: string } {
  if (item.decision.itemKind !== "pull_request" || live.state !== "open") return false;
  const queuedHead = String(item.decision.sourceHeadSha || "").toLowerCase();
  return /^[0-9a-f]{40}$/.test(queuedHead) && queuedHead !== live.headSha;
}

export function exactReviewDecisionCanSupersedeReview(
  current: ExactReviewQueueItem,
  incoming: ExactReviewDecision,
): boolean {
  const active = current.leaseDecision || current.decision;
  if (
    active.sourceCommentId &&
    incoming.sourceCommentId &&
    active.sourceCommentId === incoming.sourceCommentId
  ) {
    const activeCommentAt = Date.parse(String(active.sourceCommentUpdatedAt || ""));
    const incomingCommentAt = Date.parse(String(incoming.sourceCommentUpdatedAt || ""));
    if (Number.isFinite(activeCommentAt) && Number.isFinite(incomingCommentAt)) {
      if (incomingCommentAt < activeCommentAt) return false;
      if (
        incomingCommentAt === activeCommentAt &&
        active.commandBodyDigest &&
        incoming.commandBodyDigest &&
        active.commandBodyDigest !== incoming.commandBodyDigest
      ) {
        return incoming.sourceCommentVerified === true;
      }
    }
  }
  if (active.itemKind !== "pull_request" || incoming.itemKind !== "pull_request") return true;

  const activeHead = String(active.sourceHeadSha || "").toLowerCase();
  const incomingHead = String(incoming.sourceHeadSha || "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(incomingHead)) return false;
  const incomingAuthoritySeq = Number(incoming.sourceAuthoritySeq || 0);
  const watermark = current.sourceAuthorityWatermark;
  const activeSourceAuthoritySeq = Number(watermark?.sequence || active.sourceAuthoritySeq || 0);
  const activeHasAuthority =
    Number.isSafeInteger(activeSourceAuthoritySeq) && activeSourceAuthoritySeq > 0;
  if (!/^[0-9a-f]{40}$/.test(activeHead)) {
    return (
      incoming.sourceHeadVerified === true &&
      Number.isSafeInteger(incomingAuthoritySeq) &&
      incomingAuthoritySeq > 0
    );
  }
  if (incomingHead !== activeHead && incoming.sourceHeadVerified !== true) {
    return false;
  }
  if (!activeHasAuthority) {
    if (incomingHead !== activeHead) {
      return incoming.sourceHeadVerified === true;
    }
    return Number.isSafeInteger(incomingAuthoritySeq) && incomingAuthoritySeq > 0;
  }
  if (!Number.isSafeInteger(incomingAuthoritySeq) || incomingAuthoritySeq <= 0) return false;

  const activeUpdatedAt = Date.parse(String(watermark?.updatedAt || active.sourceUpdatedAt || ""));
  const incomingUpdatedAt = Date.parse(String(incoming.sourceUpdatedAt || ""));
  if (
    Number.isFinite(activeUpdatedAt) &&
    Number.isFinite(incomingUpdatedAt) &&
    incomingUpdatedAt !== activeUpdatedAt
  ) {
    return incomingUpdatedAt > activeUpdatedAt;
  }

  return incomingAuthoritySeq > activeSourceAuthoritySeq;
}

export function exactReviewCommandVersionIsOlder(
  active: ExactReviewDecision,
  incoming: ExactReviewDecision,
) {
  if (
    !active.sourceCommentId ||
    !incoming.sourceCommentId ||
    active.sourceCommentId !== incoming.sourceCommentId
  ) {
    return false;
  }
  const activeAt = Date.parse(String(active.sourceCommentUpdatedAt || ""));
  const incomingAt = Date.parse(String(incoming.sourceCommentUpdatedAt || ""));
  if (!Number.isFinite(activeAt) || !Number.isFinite(incomingAt)) return false;
  if (incomingAt !== activeAt) return incomingAt < activeAt;
  return Boolean(
    active.commandBodyDigest &&
    incoming.commandBodyDigest &&
    incoming.commandBodyDigest !== active.commandBodyDigest &&
    incoming.sourceCommentVerified !== true,
  );
}

export function exactReviewSourceAuthorityWatermark(
  decision: ExactReviewDecision,
): ExactReviewQueueItem["sourceAuthorityWatermark"] | null {
  if (decision.itemKind !== "pull_request") return null;
  const sequence = Number(decision.sourceAuthoritySeq || 0);
  if (!Number.isSafeInteger(sequence) || sequence <= 0) return null;
  const updatedAt = String(decision.sourceUpdatedAt || "");
  return {
    sequence,
    ...(Number.isFinite(Date.parse(updatedAt)) ? { updatedAt } : {}),
  };
}

export function advanceExactReviewSourceAuthorityWatermark(
  item: ExactReviewQueueItem,
  decision: ExactReviewDecision,
) {
  const watermark = exactReviewSourceAuthorityWatermark(decision);
  if (watermark) item.sourceAuthorityWatermark = watermark;
}

export function exactReviewItemKey(decision: ExactReviewDecision) {
  const base = `${decision.targetRepo}#${decision.itemNumber}`;
  return decision.publication
    ? `${base}@publish:${decision.publication.producerRunId}:${decision.publication.producerRunAttempt}`
    : base;
}

export function isExactReviewQueueTargetEnabled(
  decision: ExactReviewDecision,
  env: Record<string, unknown>,
) {
  return (
    decision.targetRepo !== "openclaw/clawhub" ||
    String(env.CLAWSWEEPER_ENABLE_CLAWHUB || "") === "1"
  );
}

export function isImmediateExactReviewDecision(
  decision: ExactReviewDecision,
  isFirstEvent = false,
) {
  return Boolean(
    decision.commandStatusMarker ||
    decision.publication ||
    exactReviewScheduledLane(decision) ||
    (isFirstEvent &&
      decision.itemKind === "pull_request" &&
      ["opened", "ready_for_review"].includes(decision.sourceAction)),
  );
}

export function isLowPriorityExactReviewDecision(decision: ExactReviewDecision) {
  return EXACT_REVIEW_LOW_PRIORITY_SOURCE_ACTIONS.has(decision.sourceAction);
}

export function exactReviewQueueIsPublication(item: Pick<ExactReviewQueueItem, "decision">) {
  const decision = item?.decision;
  return (
    Boolean(decision) &&
    typeof decision === "object" &&
    !Array.isArray(decision) &&
    decision.sourceAction === EXACT_REVIEW_ARTIFACT_PUBLISH_SOURCE_ACTION
  );
}

export function exactReviewQueueIsBatchablePublication(
  item: Pick<ExactReviewQueueItem, "decision" | "terminalFinalization">,
) {
  // A direct receipt's router/terminal plan is immutable per fenced revision.
  // Batch publication has no lifecycle-plan replay step, so only the normal
  // publisher may recover a pending direct receipt.
  return (
    exactReviewQueueIsPublication(item) &&
    !item.terminalFinalization &&
    !item.decision.publication?.directLifecycle
  );
}

export function exactReviewQueueUsesLegacyBatchPath(item: Pick<ExactReviewQueueItem, "decision">) {
  // Terminal-finalization items are no longer batchable, but their original
  // publication path remains visible until command acknowledgement completes.
  // A projection-backed direct finalizer intentionally has no publication
  // payload, while both active and retained batch items keep theirs.
  return (
    exactReviewQueueIsPublication(item) &&
    Boolean(item.decision.publication) &&
    !item.decision.publication?.directLifecycle
  );
}

export function exactReviewQueueHasCommandContext(item: Pick<ExactReviewQueueItem, "decision">) {
  const command = exactReviewQueueCommandStatusAddress(item.decision);
  return Boolean(command.statusMarker || command.statusCommentId);
}

export function exactReviewQueueCommandStatusAddress(decision: ExactReviewDecision) {
  return {
    statusMarker:
      decision.publication?.producerDecision.commandStatusMarker ??
      decision.commandStatusMarker ??
      null,
    statusCommentId:
      decision.publication?.producerDecision.statusCommentId ?? decision.statusCommentId ?? null,
  };
}

export function exactReviewTerminalFinalizationSharesCommandStatus(
  item: Pick<ExactReviewQueueItem, "decision">,
  successor: ExactReviewDecision,
) {
  const current = exactReviewQueueCommandStatusAddress(item.decision);
  const next = exactReviewQueueCommandStatusAddress(successor);
  return (
    (current.statusCommentId !== null &&
      next.statusCommentId !== null &&
      current.statusCommentId === next.statusCommentId) ||
    (current.statusMarker !== null &&
      next.statusMarker !== null &&
      current.statusMarker === next.statusMarker)
  );
}
