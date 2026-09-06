export type DirectReReviewOrigin = "hosted_webhook" | "comment_router";
export type InlineProofScenario = "web-ui-chat-proof" | "telegram-bot-e2e-proof";

export function validProofAllowedScenarios(value: unknown): value is InlineProofScenario[] {
  return (
    Array.isArray(value) &&
    value.length <= 2 &&
    new Set(value).size === value.length &&
    value.every(
      (scenario) => scenario === "web-ui-chat-proof" || scenario === "telegram-bot-e2e-proof",
    )
  );
}

export type DirectReReviewDecision = {
  targetRepo: string;
  targetBranch: string;
  itemNumber: number;
  itemKind: "issue" | "pull_request";
  sourceEvent: "issues" | "pull_request";
  sourceAction: "re_review";
  supersedesInProgress: false;
  sourceDeliveryId: string;
  bayJourneyDeliveryId?: string;
  sourceCommentId: number;
  sourceCommentUpdatedAt: string;
  commandBodyDigest: string;
  commandOrigin: DirectReReviewOrigin;
  commandStatusMarker: string;
  additionalPrompt: string;
  proofAllowedScenarios?: InlineProofScenario[];
  statusCommentId?: number;
  sourceHeadSha?: string;
  sourceUpdatedAt?: string;
  sourceHeadVerified?: boolean;
  sourceCommentVerified?: boolean;
  sourceAuthoritySeq?: number;
};

export type DirectReReviewIntake = {
  protocolVersion: 1;
  commandVersionId: string;
  installationId: number;
  sourceCommentId: number;
  sourceCommentUpdatedAt: string;
  commandBodyDigest: string;
  commandOrigin: DirectReReviewOrigin;
  decision: Omit<
    DirectReReviewDecision,
    "sourceAuthoritySeq" | "sourceCommentVerified" | "sourceHeadVerified" | "sourceUpdatedAt"
  >;
};

export function reReviewCommandVersionIdentity(options: {
  commentId: number;
  updatedAt: string;
  bodySha256: string;
}) {
  const timestamp = Date.parse(options.updatedAt);
  const digest = options.bodySha256.trim().toLowerCase();
  if (
    !Number.isSafeInteger(options.commentId) ||
    options.commentId < 1 ||
    !Number.isFinite(timestamp) ||
    !/^[0-9a-f]{64}$/.test(digest)
  ) {
    throw new Error("exact re-review command version is invalid");
  }
  return `command-${options.commentId}-${timestamp.toString(36)}-${digest}`;
}

export function directReReviewIntake(options: {
  targetRepo: string;
  targetBranch: string;
  itemNumber: number;
  itemKind: "issue" | "pull_request";
  installationId: number;
  sourceCommentId: number;
  sourceCommentUpdatedAt: string;
  commandBodyDigest: string;
  commandOrigin: DirectReReviewOrigin;
  additionalPrompt: string;
  proofAllowedScenarios?: InlineProofScenario[];
  statusCommentId?: number;
  candidateHeadSha?: string;
  bayJourneyDeliveryId?: string;
}): DirectReReviewIntake {
  const commandVersionId = reReviewCommandVersionIdentity({
    commentId: options.sourceCommentId,
    updatedAt: options.sourceCommentUpdatedAt,
    bodySha256: options.commandBodyDigest,
  });
  if (!Number.isSafeInteger(options.installationId) || options.installationId < 1) {
    throw new Error("exact re-review installation is invalid");
  }
  if (
    Object.hasOwn(options, "proofAllowedScenarios") &&
    !validProofAllowedScenarios(options.proofAllowedScenarios)
  ) {
    throw new Error("exact re-review proof selection is invalid");
  }
  const decision: DirectReReviewIntake["decision"] = {
    targetRepo: options.targetRepo,
    targetBranch: options.targetBranch,
    itemNumber: options.itemNumber,
    itemKind: options.itemKind,
    sourceEvent: options.itemKind === "pull_request" ? "pull_request" : "issues",
    sourceAction: "re_review",
    supersedesInProgress: false,
    sourceDeliveryId: commandVersionId,
    ...(options.bayJourneyDeliveryId ? { bayJourneyDeliveryId: options.bayJourneyDeliveryId } : {}),
    sourceCommentId: options.sourceCommentId,
    sourceCommentUpdatedAt: options.sourceCommentUpdatedAt,
    commandBodyDigest: options.commandBodyDigest,
    commandOrigin: options.commandOrigin,
    commandStatusMarker: directReReviewStatusMarker(options.itemNumber, commandVersionId),
    additionalPrompt: options.additionalPrompt.slice(0, 5_000),
    // An explicit empty selection denies every proof tool; never omit it.
    ...(options.proofAllowedScenarios !== undefined
      ? { proofAllowedScenarios: [...options.proofAllowedScenarios] }
      : {}),
    ...(options.statusCommentId ? { statusCommentId: options.statusCommentId } : {}),
    ...(options.candidateHeadSha ? { sourceHeadSha: options.candidateHeadSha } : {}),
  };
  return {
    protocolVersion: 1,
    commandVersionId,
    installationId: options.installationId,
    sourceCommentId: options.sourceCommentId,
    sourceCommentUpdatedAt: options.sourceCommentUpdatedAt,
    commandBodyDigest: options.commandBodyDigest,
    commandOrigin: options.commandOrigin,
    decision,
  };
}

export function validateDirectReReviewIntake(value: unknown): DirectReReviewIntake | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const intake = value as Partial<DirectReReviewIntake>;
  const decision = intake.decision as Partial<DirectReReviewDecision> | undefined;
  if (
    intake.protocolVersion !== 1 ||
    !decision ||
    !Number.isSafeInteger(intake.installationId) ||
    Number(intake.installationId) < 1 ||
    !Number.isSafeInteger(intake.sourceCommentId) ||
    Number(intake.sourceCommentId) < 1 ||
    !Number.isFinite(Date.parse(String(intake.sourceCommentUpdatedAt || ""))) ||
    !/^[0-9a-f]{64}$/.test(String(intake.commandBodyDigest || "")) ||
    (intake.commandOrigin !== "hosted_webhook" && intake.commandOrigin !== "comment_router") ||
    typeof intake.commandVersionId !== "string" ||
    intake.commandVersionId !==
      reReviewCommandVersionIdentity({
        commentId: Number(intake.sourceCommentId),
        updatedAt: String(intake.sourceCommentUpdatedAt),
        bodySha256: String(intake.commandBodyDigest),
      }) ||
    decision.sourceDeliveryId !== intake.commandVersionId ||
    (decision.bayJourneyDeliveryId !== undefined &&
      (typeof decision.bayJourneyDeliveryId !== "string" ||
        !/^[A-Za-z0-9_.:-]{1,200}$/.test(decision.bayJourneyDeliveryId))) ||
    decision.sourceCommentId !== intake.sourceCommentId ||
    decision.sourceCommentUpdatedAt !== intake.sourceCommentUpdatedAt ||
    decision.commandBodyDigest !== intake.commandBodyDigest ||
    decision.commandOrigin !== intake.commandOrigin ||
    typeof decision.targetRepo !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(decision.targetRepo) ||
    typeof decision.targetBranch !== "string" ||
    !/^[A-Za-z0-9_./-]+$/.test(decision.targetBranch) ||
    !Number.isSafeInteger(decision.itemNumber) ||
    Number(decision.itemNumber) < 1 ||
    (decision.itemKind !== "issue" && decision.itemKind !== "pull_request") ||
    decision.sourceEvent !== (decision.itemKind === "pull_request" ? "pull_request" : "issues") ||
    decision.sourceAction !== "re_review" ||
    decision.supersedesInProgress !== false ||
    decision.commandStatusMarker !==
      directReReviewStatusMarker(Number(decision.itemNumber), intake.commandVersionId) ||
    typeof decision.additionalPrompt !== "string" ||
    decision.additionalPrompt.length > 5_000 ||
    (Object.hasOwn(decision, "proofAllowedScenarios") &&
      !validProofAllowedScenarios(decision.proofAllowedScenarios)) ||
    Object.hasOwn(decision, "sourceHeadVerified") ||
    Object.hasOwn(decision, "sourceCommentVerified") ||
    Object.hasOwn(decision, "sourceAuthoritySeq") ||
    Object.hasOwn(decision, "sourceUpdatedAt")
  ) {
    return null;
  }
  if (
    decision.statusCommentId !== undefined &&
    (!Number.isSafeInteger(decision.statusCommentId) || Number(decision.statusCommentId) < 1)
  ) {
    return null;
  }
  if (
    decision.sourceHeadSha !== undefined &&
    !/^[0-9a-f]{40}$/.test(String(decision.sourceHeadSha).toLowerCase())
  ) {
    return null;
  }
  return intake as DirectReReviewIntake;
}

function directReReviewStatusMarker(itemNumber: number, commandVersionId: string) {
  if (
    !Number.isSafeInteger(itemNumber) ||
    itemNumber < 1 ||
    !/^command-[a-z0-9-]{1,120}$/.test(commandVersionId)
  ) {
    throw new Error("exact re-review command status marker is invalid");
  }
  return `<!-- clawsweeper-command-status:${itemNumber}:re_review:${commandVersionId} -->`;
}
