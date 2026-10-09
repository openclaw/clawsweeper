#!/usr/bin/env node
// Builds exact-review queue request bodies for workflow steps.
// Workflow steps send the body with control_plane_curl.
// Steps that run before checkout run this source file directly, so it imports
// only Node built-ins.
import { parseArgs } from "node:util";

type ExactReviewLease = {
  itemKey: string;
  leaseId: string;
  leaseRevision: number;
  claimGeneration: number;
  runId: string;
  runAttempt: number;
  sourceHeadSha: string | null;
};

// The queue accepts a review acknowledgement only on a status heartbeat,
// and generation_start only on a review heartbeat.
type ExactReviewHeartbeat =
  | { phase: "review"; generationStart?: boolean }
  | { phase: "status"; reviewAcknowledgementCommentId?: number }
  | { phase: "finalizing" };

// One review revision in the publication lifecycle of one target item.
type ExactReviewLifecycleTarget = {
  canonical_target_key: string;
  fence_key: string;
  revision: number;
};

type JsonObject = Record<string, unknown>;

// A legacy repository_dispatch event, read from the client payload that the
// legacy intake step receives in CLIENT_PAYLOAD.
type LegacyEvent = {
  payload: JsonObject;
  queueClaim: JsonObject;
  reviewOptions: JsonObject;
  targetRepo: string;
  // Empty when the event does not name a branch. The queue then resolves it.
  targetBranch: string;
  itemKind: "issue" | "pull_request";
  sourceEvent: "issues" | "pull_request";
  ingress: { route: "target_dispatcher"; fingerprint: string } | undefined;
  sourceHeadSha: string;
  sourceBaseSha: string;
  sourceIsDraft: unknown;
  sourceContentRevision: string;
  installationId: number;
};

// The values that the queue accepts for each lifecycle record.
const ROUTER_OUTCOMES = ["durable", "not_required"] as const;
const CANONICAL_OUTCOMES = ["accepted", "deduped", "superseded"] as const;
// The terminal dispositions that workflow steps record.
const TERMINAL_DISPOSITIONS = [
  "requeue",
  "target_missing",
  "target_closed",
  "guarded_open",
  "policy_noop",
] as const;
// The reasons for which a terminal acknowledgement completes without a status write.
const SKIP_REASONS = ["locked_conversation", "missing_status_comment"] as const;
const COMPLETION_OUTCOMES = ["success", "failure"] as const;
// A command status comment is found by its marker, its comment id, or both.
const STATUS_ADDRESS_OPTIONS = {
  "status-marker": { type: "string" },
  "status-comment-id": { type: "string" },
} as const;
// The 409 errors after which a lease step stops without an error, because
// another run or a newer revision owns the lease. Every other 409 fails the step.
const SAFE_CONFLICTS = {
  claim: [
    "lease_not_active",
    "lease_already_claimed",
    "lease_decision_unavailable",
    "stale_run_attempt",
  ],
  complete: ["lease_superseded"],
} as const;
const PRIMARY_OUTCOMES = ["success", "cancelled", "failure"] as const;
const RETRY_KINDS = ["coordination", "throttle"] as const;

try {
  const result = exactReviewQueueRequest(process.argv.slice(2), process.env);
  // A route is plain text. A body is JSON.
  process.stdout.write(typeof result === "string" ? result : JSON.stringify(result));
} catch (error) {
  process.stderr.write(`exact-review-queue-request: ${(error as Error).message}\n`);
  process.exitCode = 1;
}

function exactReviewQueueRequest(argv: string[], env: NodeJS.ProcessEnv) {
  const [command, ...args] = argv;
  switch (command) {
    case "heartbeat":
      return exactReviewHeartbeatBody(exactReviewLeaseFromEnv(env), heartbeatFromArgs(args));
    case "lifecycle":
      return exactReviewLifecycleBody(args, env);
    case "terminal-finalization":
      return exactReviewTerminalFinalizationBody(args, env);
    case "enqueue":
      return legacyEventEnqueue(args, env);
    case "claim":
    case "complete":
      return exactReviewLeaseStep(command, args, env);
    default:
      throw new Error(
        "usage: heartbeat --phase <review|status|finalizing> | lifecycle <router-receipt|canonical-receipt|terminal-disposition|command-ack-failed|command-ack-observed> | terminal-finalization <attempt|skip> | enqueue <route|body> | claim <body|conflict> | complete <body|conflict>",
      );
  }
}

// `body` prints the claim or completion body. `conflict` reads the 409 response
// in RESPONSE and prints its error when the step can stop without an error.
function exactReviewLeaseStep(
  command: "claim" | "complete",
  args: string[],
  env: NodeJS.ProcessEnv,
) {
  const [record, ...options] = args;
  if (options.length > 0) throw new Error(`${command} takes no options`);
  switch (record) {
    case "body":
      return command === "claim" ? exactReviewClaimBody(env) : exactReviewCompletionBody(env);
    case "conflict": {
      const response: unknown = JSON.parse(env.RESPONSE || "{}");
      const error = (response as JsonObject | null)?.error;
      const safe = SAFE_CONFLICTS[command].find((reason) => reason === error);
      if (safe === undefined) throw new Error(`unexpected ${command} conflict`);
      return safe;
    }
    default:
      throw new Error(`${command} record must be body or conflict`);
  }
}

// A dispatch names its lease tuple. An older dispatch names only the lease id.
function exactReviewClaimBody(env: NodeJS.ProcessEnv) {
  const leaseId = requiredText(env.QUEUE_LEASE_ID, "QUEUE_LEASE_ID");
  const itemKey = (env.ITEM_KEY ?? "").trim();
  const leaseRevision = (env.QUEUE_LEASE_REVISION ?? "").trim();
  const { runId, runAttempt } = githubRun(env);
  return {
    lease_id: leaseId,
    ...(itemKey || leaseRevision
      ? {
          item_key: requiredText(itemKey, "ITEM_KEY"),
          lease_revision: positiveInteger(leaseRevision, "QUEUE_LEASE_REVISION"),
        }
      : {}),
    run_id: runId,
    run_attempt: runAttempt,
  };
}

// Reads the claim outputs and the results of the review steps. A protocol 1
// claim completes by lease id only.
function exactReviewCompletionBody(env: NodeJS.ProcessEnv) {
  const leaseId = requiredText(env.QUEUE_LEASE_ID, "QUEUE_LEASE_ID");
  const protocolVersion = Number(env.PROTOCOL_VERSION);
  if (protocolVersion !== 1 && protocolVersion !== 2) throw new Error("invalid PROTOCOL_VERSION");
  const tuple =
    protocolVersion === 2
      ? {
          item_key: requiredText(env.ITEM_KEY, "ITEM_KEY"),
          lease_revision: positiveInteger(env.QUEUE_LEASE_REVISION, "QUEUE_LEASE_REVISION"),
          claim_generation: positiveInteger(env.CLAIM_GENERATION, "CLAIM_GENERATION"),
        }
      : {};
  const { runId, runAttempt } = githubRun(env);
  // A skipped or failed result step reports failure.
  const outcome = PRIMARY_OUTCOMES.find((value) => value === env.PRIMARY_OUTCOME) ?? "failure";
  const requeueLatest = env.REQUEUE_LATEST === "true";
  const retryKindText = (env.RETRY_KIND ?? "").trim();
  const retryKind = retryKindText ? oneOf(retryKindText, RETRY_KINDS, "RETRY_KIND") : undefined;
  const retryAt = (env.RETRY_AT ?? "").trim();
  if (retryKind && !retryAt) throw new Error("RETRY_KIND requires RETRY_AT");
  const directPublicationCompleted =
    env.DIRECT_PUBLICATION_ACCEPTED === "true" && env.DIRECT_LIFECYCLE_OUTCOME === "success";
  const directLifecycleRequeue =
    directPublicationCompleted && env.DIRECT_LIFECYCLE_REQUEUE === "true";
  if (requeueLatest && directLifecycleRequeue) {
    throw new Error("REQUEUE_LATEST and DIRECT_LIFECYCLE_REQUEUE exclude each other");
  }
  const failureStage = (env.REVIEW_FAILURE_STAGE ?? "").trim();
  const failureReasonCode = (env.REVIEW_FAILURE_REASON_CODE ?? "").trim();
  const failureRetryable = (env.REVIEW_FAILURE_RETRYABLE ?? "").trim();
  const hasReviewFailure = Boolean(failureStage || failureReasonCode || failureRetryable);
  if (
    hasReviewFailure &&
    (!failureStage || !failureReasonCode || !["true", "false"].includes(failureRetryable))
  ) {
    throw new Error("incomplete review failure");
  }
  const hasCommandContext = env.HAS_COMMAND_CONTEXT === "true";
  // The queue holds a deterministic no-op until the target changes.
  const reviewHold =
    outcome === "success" &&
    !requeueLatest &&
    !retryKind &&
    !directPublicationCompleted &&
    !hasCommandContext
      ? (env.REVIEW_HOLD ?? "").trim()
      : "";
  return {
    lease_id: leaseId,
    ...tuple,
    run_id: runId,
    run_attempt: runAttempt,
    outcome,
    ...(requeueLatest ? { requeue_latest: true } : {}),
    ...(env.SCHEDULED_SEMANTIC_NOOP === "true" &&
    outcome === "success" &&
    !requeueLatest &&
    !retryKind
      ? { lifecycle_terminal_disposition: "policy_noop" }
      : {}),
    ...(retryKind ? { retry_kind: retryKind } : {}),
    ...(directPublicationCompleted
      ? env.DIRECT_PUBLICATION_SUPERSEDED === "true"
        ? { completion_kind: "superseded", reason_code: "remote_newer_tuple" }
        : { completion_kind: "published", reason_code: "publication_applied" }
      : {}),
    ...(directLifecycleRequeue ? { direct_lifecycle_requeue: true } : {}),
    ...(retryAt ? { retry_at: retryAt } : {}),
    ...(reviewHold ? { review_hold: reviewHold } : {}),
    ...(env.REVIEW_FAILURE_REASON
      ? {
          review_failure_reason: env.REVIEW_FAILURE_REASON,
          // Only an automatic pull request review has a review status comment.
          ...(hasCommandContext || env.REVIEW_ITEM_KIND !== "pull_request"
            ? {}
            : { review_failure_status: reviewFailureStatus(env) }),
        }
      : {}),
    ...(hasReviewFailure
      ? {
          review_failure: {
            stage: failureStage,
            reason_code: failureReasonCode,
            retryable: failureRetryable === "true",
          },
        }
      : {}),
  };
}

// The terminal review status write was seen, failed after the acknowledgement
// comment, or had no comment to write.
function reviewFailureStatus(env: NodeJS.ProcessEnv) {
  if (env.REVIEW_STATUS_VERIFIED === "true") {
    return {
      outcome: "observed",
      comment_id: Number(env.REVIEW_STATUS_COMMENT_ID),
      completed_at: (env.REVIEW_STATUS_COMPLETED_AT ?? "").trim(),
    };
  }
  const acknowledgementCommentId = Number(env.REVIEW_ACKNOWLEDGEMENT_COMMENT_ID);
  return Number.isSafeInteger(acknowledgementCommentId) && acknowledgementCommentId > 0
    ? { outcome: "failed", comment_id: acknowledgementCommentId }
    : { outcome: "unavailable" };
}

// `enqueue route` prints the queue path for a legacy event, and `enqueue body`
// prints its request body. Both fail on an invalid target before any request.
function legacyEventEnqueue(args: string[], env: NodeJS.ProcessEnv) {
  const [record, ...options] = args;
  if (options.length > 0) throw new Error("enqueue takes no options");
  const event = legacyEventFromEnv(env);
  switch (record) {
    case "route":
      if (!event.targetBranch) return "/internal/exact-review/branch-authority";
      return legacyEventNeedsSourceAuthority(event)
        ? "/internal/exact-review/source-authority"
        : "/internal/exact-review/enqueue";
    case "body":
      return legacyEventBody(event, env);
    default:
      throw new Error("enqueue record must be route or body");
  }
}

function legacyEventFromEnv(env: NodeJS.ProcessEnv): LegacyEvent {
  const payload: unknown = JSON.parse(env.CLIENT_PAYLOAD || "{}");
  if (!payload || typeof payload !== "object") throw new Error("invalid CLIENT_PAYLOAD");
  const fields = payload as JsonObject;
  const queueClaim = (
    fields.queue_claim && typeof fields.queue_claim === "object" ? fields.queue_claim : {}
  ) as JsonObject;
  const targetRepo = String(fields.target_repo || "openclaw/openclaw").trim();
  const targetBranch = String(fields.target_branch || "").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(targetRepo)) {
    throw new Error(`invalid legacy target repository: ${targetRepo}`);
  }
  if (targetBranch && !/^[A-Za-z0-9_./-]+$/.test(targetBranch)) {
    throw new Error(`invalid legacy target branch for ${targetRepo}: ${targetBranch}`);
  }
  const itemKind = fields.item_kind === "pull_request" ? "pull_request" : "issue";
  const sourceEvent =
    fields.source_event === "pull_request" || fields.source_event === "pull_request_target"
      ? "pull_request"
      : "issues";
  const fingerprint = String(fields.ingress_fingerprint || "")
    .trim()
    .toLowerCase();
  // The target dispatcher sends pull request events with a payload fingerprint.
  const ingress =
    fields.ingress_route === "target_dispatcher" &&
    itemKind === "pull_request" &&
    sourceEvent === "pull_request" &&
    /^[0-9a-f]{64}$/.test(fingerprint)
      ? { route: "target_dispatcher" as const, fingerprint }
      : undefined;
  // The queue claim fields come first. The flat payload fields are the older form.
  const claimText = (name: string) =>
    String(queueClaim[name] ?? fields[name] ?? "")
      .trim()
      .toLowerCase();
  return {
    payload: fields,
    queueClaim,
    reviewOptions: (fields.review_options && typeof fields.review_options === "object"
      ? fields.review_options
      : {}) as JsonObject,
    targetRepo,
    targetBranch,
    itemKind,
    sourceEvent,
    ingress,
    sourceHeadSha: claimText("source_head_sha"),
    sourceBaseSha: claimText("source_base_sha"),
    sourceIsDraft: queueClaim.source_is_draft ?? fields.source_is_draft,
    sourceContentRevision: claimText("source_content_revision"),
    installationId: Number(queueClaim.installation_id ?? fields.installation_id),
  };
}

// An edited pull request with its complete source tuple goes through source
// authority. A target dispatcher event does not.
function legacyEventNeedsSourceAuthority(event: LegacyEvent) {
  return (
    event.itemKind === "pull_request" &&
    event.payload.source_event === "pull_request" &&
    event.payload.source_action === "edited" &&
    Number.isInteger(event.installationId) &&
    event.installationId > 0 &&
    /^[0-9a-f]{40}$/.test(event.sourceHeadSha) &&
    /^[0-9a-f]{40}$/.test(event.sourceBaseSha) &&
    typeof event.sourceIsDraft === "boolean" &&
    /^[0-9a-f]{64}$/.test(event.sourceContentRevision) &&
    !event.ingress
  );
}

function legacyEventBody(event: LegacyEvent, env: NodeJS.ProcessEnv) {
  const { payload, queueClaim, reviewOptions, targetBranch } = event;
  const dispatchKey = String(payload.dispatch_key || "").trim();
  const legacyRun = dispatchKey ? undefined : githubRun(env);
  const sourceUpdatedAt = String(
    queueClaim.source_updated_at ?? payload.source_updated_at ?? "",
  ).trim();
  // A review option can come from the queue claim, the review options, or the flat payload.
  const reviewOption = (name: string) =>
    Number(queueClaim[name] ?? reviewOptions[name] ?? payload[name]);
  const codexTimeoutMs = reviewOption("codex_timeout_ms");
  const mediaProofTimeoutMs = reviewOption("media_proof_timeout_ms");
  const reviewAcknowledgementCommentId = reviewOption("review_acknowledgement_comment_id");
  return {
    delivery_id: legacyRun
      ? `legacy:${legacyRun.runId}:${legacyRun.runAttempt}`
      : `router:${dispatchKey}`,
    ...(Number.isInteger(event.installationId) && event.installationId > 0
      ? { installation_id: event.installationId }
      : {}),
    ...(!targetBranch && legacyEventNeedsSourceAuthority(event)
      ? { source_authority_required: true }
      : {}),
    decision: {
      targetRepo: event.targetRepo,
      ...(targetBranch ? { targetBranch } : {}),
      itemNumber: Number(payload.item_number),
      itemKind: event.itemKind,
      sourceEvent: event.sourceEvent,
      sourceAction: payload.source_action || "legacy_dispatch",
      ...(Object.hasOwn(payload, "expected_source_revision")
        ? { expectedSourceRevision: payload.expected_source_revision }
        : {}),
      supersedesInProgress: payload.supersedes_in_progress === true,
      ...(typeof payload.source_delivery_id === "string" && payload.source_delivery_id
        ? { sourceDeliveryId: payload.source_delivery_id }
        : {}),
      ...(/^[0-9a-f]{40}$/.test(event.sourceHeadSha) ? { sourceHeadSha: event.sourceHeadSha } : {}),
      ...(/^[0-9a-f]{40}$/.test(event.sourceBaseSha) ? { sourceBaseSha: event.sourceBaseSha } : {}),
      ...(typeof event.sourceIsDraft === "boolean" ? { sourceIsDraft: event.sourceIsDraft } : {}),
      ...(/^[0-9a-f]{64}$/.test(event.sourceContentRevision)
        ? { sourceContentRevision: event.sourceContentRevision }
        : {}),
      ...(sourceUpdatedAt && Number.isFinite(Date.parse(sourceUpdatedAt))
        ? { sourceUpdatedAt }
        : {}),
      ...(Number.isFinite(codexTimeoutMs) ? { codexTimeoutMs } : {}),
      ...(Number.isFinite(mediaProofTimeoutMs) ? { mediaProofTimeoutMs } : {}),
      ...(Object.hasOwn(payload, "command_status_marker")
        ? { commandStatusMarker: payload.command_status_marker }
        : {}),
      ...(Object.hasOwn(payload, "status_comment_id")
        ? { statusCommentId: payload.status_comment_id }
        : {}),
      ...(Number.isSafeInteger(reviewAcknowledgementCommentId) && reviewAcknowledgementCommentId > 0
        ? { reviewAcknowledgementCommentId }
        : {}),
      ...(Object.hasOwn(payload, "additional_prompt")
        ? { additionalPrompt: payload.additional_prompt }
        : {}),
    },
    ...(event.ingress ? { ingress: event.ingress } : {}),
  };
}

// Reads the lease tuple that the claim step exports to each lease-holding step.
function exactReviewLeaseFromEnv(env: NodeJS.ProcessEnv): ExactReviewLease {
  const itemKey = env.EXACT_REVIEW_ITEM_KEY ?? "";
  const leaseId = env.EXACT_REVIEW_LEASE_ID ?? "";
  const sourceHeadSha = (env.EXACT_REVIEW_SOURCE_HEAD_SHA ?? "").trim().toLowerCase();
  if (!itemKey || !leaseId) throw new Error("missing exact-review lease tuple");
  const { runId, runAttempt } = githubRun(env);
  if (sourceHeadSha && !/^[0-9a-f]{40}$/.test(sourceHeadSha)) {
    throw new Error("invalid EXACT_REVIEW_SOURCE_HEAD_SHA");
  }
  return {
    itemKey,
    leaseId,
    leaseRevision: positiveInteger(env.EXACT_REVIEW_LEASE_REVISION, "EXACT_REVIEW_LEASE_REVISION"),
    claimGeneration: positiveInteger(
      env.EXACT_REVIEW_CLAIM_GENERATION,
      "EXACT_REVIEW_CLAIM_GENERATION",
    ),
    runId,
    runAttempt,
    sourceHeadSha: sourceHeadSha || null,
  };
}

function exactReviewHeartbeatBody(lease: ExactReviewLease, heartbeat: ExactReviewHeartbeat) {
  return {
    item_key: lease.itemKey,
    lease_id: lease.leaseId,
    lease_revision: lease.leaseRevision,
    claim_generation: lease.claimGeneration,
    run_id: lease.runId,
    run_attempt: lease.runAttempt,
    ...(lease.sourceHeadSha ? { source_head_sha: lease.sourceHeadSha } : {}),
    ...(heartbeat.phase === "status" && heartbeat.reviewAcknowledgementCommentId !== undefined
      ? { review_acknowledgement_comment_id: heartbeat.reviewAcknowledgementCommentId }
      : {}),
    phase: heartbeat.phase,
    ...(heartbeat.phase === "review" && heartbeat.generationStart
      ? { generation_start: true }
      : {}),
  };
}

function heartbeatFromArgs(args: string[]): ExactReviewHeartbeat {
  const { values } = parseArgs({
    args,
    options: {
      phase: { type: "string" },
      "review-acknowledgement-comment-id": { type: "string" },
      "generation-start": { type: "boolean", default: false },
    },
  });
  const acknowledgement = values["review-acknowledgement-comment-id"];
  if (acknowledgement !== undefined && values.phase !== "status") {
    throw new Error("--review-acknowledgement-comment-id requires --phase status");
  }
  if (values["generation-start"] && values.phase !== "review") {
    throw new Error("--generation-start requires --phase review");
  }
  switch (values.phase) {
    case "review":
      return { phase: "review", generationStart: values["generation-start"] };
    case "status":
      return acknowledgement === undefined
        ? { phase: "status" }
        : {
            phase: "status",
            reviewAcknowledgementCommentId: positiveInteger(
              acknowledgement,
              "--review-acknowledgement-comment-id",
            ),
          };
    case "finalizing":
      return { phase: "finalizing" };
    default:
      throw new Error("--phase must be review, status or finalizing");
  }
}

function exactReviewLifecycleBody(args: string[], env: NodeJS.ProcessEnv) {
  const [record, ...options] = args;
  switch (record) {
    case "router-receipt": {
      const { values } = parseArgs({
        args: options,
        options: { outcome: { type: "string" }, "receipt-id-prefix": { type: "string" } },
      });
      // The queue reads a missing outcome as "durable".
      const outcome =
        values.outcome === undefined
          ? undefined
          : oneOf(values.outcome, ROUTER_OUTCOMES, "--outcome");
      return {
        ...exactReviewLifecycleTarget(env),
        ...(outcome === undefined ? {} : { outcome }),
        receipt_id: receiptId(values["receipt-id-prefix"], env),
      };
    }
    case "canonical-receipt": {
      const { values } = parseArgs({
        args: options,
        options: { outcome: { type: "string" }, "receipt-id-prefix": { type: "string" } },
      });
      return {
        ...exactReviewLifecycleTarget(env),
        outcome: oneOf(values.outcome, CANONICAL_OUTCOMES, "--outcome"),
        receipt_id: receiptId(values["receipt-id-prefix"], env),
      };
    }
    case "terminal-disposition": {
      const { values } = parseArgs({ args: options, options: { kind: { type: "string" } } });
      return {
        ...exactReviewLifecycleTarget(env),
        kind: oneOf(values.kind, TERMINAL_DISPOSITIONS, "--kind"),
      };
    }
    case "command-ack-failed": {
      const { values } = parseArgs({
        args: options,
        options: { ...STATUS_ADDRESS_OPTIONS, "attempt-id": { type: "string" } },
      });
      return {
        ...exactReviewLifecycleTarget(env),
        attempt_id: requiredText(values["attempt-id"], "--attempt-id"),
        ...statusAddress(values, false),
      };
    }
    case "command-ack-observed": {
      const { values } = parseArgs({
        args: options,
        options: {
          ...STATUS_ADDRESS_OPTIONS,
          "command-comment-id": { type: "string" },
          "completion-comment-id": { type: "string" },
          "completed-at": { type: "string" },
          "completion-outcome": { type: "string" },
        },
      });
      const target = exactReviewLifecycleTarget(env);
      const address = statusAddress(values, true);
      const completedAt = values["completed-at"] ?? "";
      if (!Number.isFinite(Date.parse(completedAt))) throw new Error("invalid --completed-at");
      return {
        ...target,
        ...address,
        command_comment_id: positiveInteger(values["command-comment-id"], "--command-comment-id"),
        completion_comment_id: positiveInteger(
          values["completion-comment-id"],
          "--completion-comment-id",
        ),
        completed_at: completedAt,
        completion_outcome: oneOf(
          values["completion-outcome"],
          COMPLETION_OUTCOMES,
          "--completion-outcome",
        ),
        observed_at: Date.now(),
      };
    }
    default:
      throw new Error(
        "lifecycle record must be router-receipt, canonical-receipt, terminal-disposition, command-ack-failed or command-ack-observed",
      );
  }
}

// Bodies for the claimed terminal-finalization lease. The lease fences the one
// final command status write.
function exactReviewTerminalFinalizationBody(args: string[], env: NodeJS.ProcessEnv) {
  const [record, ...options] = args;
  if (record !== "attempt" && record !== "skip") {
    throw new Error("terminal-finalization record must be attempt or skip");
  }
  const { values } = parseArgs({
    args: options,
    options: {
      ...STATUS_ADDRESS_OPTIONS,
      "attempt-id": { type: "string" },
      reason: { type: "string" },
    },
  });
  const lease = exactReviewLeaseFromEnv(env);
  const tuple = {
    lease_id: lease.leaseId,
    item_key: lease.itemKey,
    lease_revision: lease.leaseRevision,
    claim_generation: lease.claimGeneration,
    run_id: lease.runId,
    run_attempt: lease.runAttempt,
  };
  if (record === "attempt") {
    if (values["attempt-id"] !== undefined || values.reason !== undefined) {
      throw new Error("--attempt-id and --reason apply only to skip");
    }
    return { ...tuple, ...statusAddress(values, true) };
  }
  return {
    ...tuple,
    attempt_id: requiredText(values["attempt-id"], "--attempt-id"),
    reason: oneOf(values.reason, SKIP_REASONS, "--reason"),
    ...statusAddress(values, true),
  };
}

// An empty value means the step has no such address.
function statusAddress(
  values: { "status-marker"?: string | undefined; "status-comment-id"?: string | undefined },
  required: boolean,
) {
  const marker = values["status-marker"] ?? "";
  const commentId = values["status-comment-id"] ?? "";
  if (required && !marker && !commentId) {
    throw new Error("--status-marker or --status-comment-id is required");
  }
  return {
    ...(marker ? { status_marker: marker } : {}),
    ...(commentId ? { status_comment_id: positiveInteger(commentId, "--status-comment-id") } : {}),
  };
}

function requiredText(value: string | undefined, name: string) {
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

// Reads the target item and the publisher fence that each lifecycle step receives.
function exactReviewLifecycleTarget(env: NodeJS.ProcessEnv): ExactReviewLifecycleTarget {
  const targetRepo = env.TARGET_REPO ?? "";
  const fenceKey = env.FENCE_KEY ?? "";
  if (!/^[^/\s]+\/[^/\s]+$/.test(targetRepo)) throw new Error("invalid TARGET_REPO");
  if (!fenceKey) throw new Error("missing FENCE_KEY");
  return {
    canonical_target_key: `${targetRepo}#${positiveInteger(env.ITEM_NUMBER, "ITEM_NUMBER")}`,
    fence_key: fenceKey,
    revision: positiveInteger(env.REVISION, "REVISION"),
  };
}

// A receipt id names the step and the workflow run attempt that sent it.
function receiptId(prefix: string | undefined, env: NodeJS.ProcessEnv) {
  if (!prefix || !/^[a-z]+(?:-[a-z]+)*$/.test(prefix)) {
    throw new Error("invalid --receipt-id-prefix");
  }
  const { runId, runAttempt } = githubRun(env);
  return `${prefix}:${runId}:${runAttempt}`;
}

function githubRun(env: NodeJS.ProcessEnv) {
  const runId = env.GITHUB_RUN_ID ?? "";
  if (!/^\d+$/.test(runId)) throw new Error("invalid GITHUB_RUN_ID");
  return { runId, runAttempt: positiveInteger(env.GITHUB_RUN_ATTEMPT, "GITHUB_RUN_ATTEMPT") };
}

function oneOf<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  name: string,
): T {
  const match = allowed.find((entry) => entry === value);
  if (match === undefined) throw new Error(`${name} must be ${allowed.join(", ")}`);
  return match;
}

function positiveInteger(value: string | undefined, name: string) {
  const number = Number(value);
  if (!value || !Number.isSafeInteger(number) || number < 1) throw new Error(`invalid ${name}`);
  return number;
}
