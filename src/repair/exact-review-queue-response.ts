#!/usr/bin/env node
// Parses queue responses and writes the existing GitHub step output protocol.
import * as fs from "node:fs";

type ReviewOptions = {
  codex_timeout_ms: number;
  media_proof_timeout_ms: number;
  command_status_marker: string;
  status_comment_id: number;
  review_acknowledgement_comment_id: number;
  additional_prompt: string;
};
type LifecyclePlan = { kind: string };
type Decision = {
  targetRepo: string;
  targetBranch: string;
  itemNumber: number;
  itemKind: string;
  sourceEvent: string;
  sourceAction: string;
  commandStatusMarker: string;
  statusCommentId: number;
  publication: {
    producerDecision: Decision;
    producerRunId: string;
    producerRunAttempt: number;
    leaseRevision: number;
    itemKey: string;
    directLifecycle: { plan: LifecyclePlan; receiptOutcome: string };
    artifactName: string;
    sourceSha: string;
    protocolVersion: number;
    claimGeneration: number;
    liveProceeded: boolean;
    liveTerminalNoop: boolean;
    liveTerminalMissing: boolean;
    liveGuardedOpen: boolean;
  };
};
type ClaimResponse = {
  claimed: boolean;
  protocol_version: number;
  decision: Decision;
  item_key: string;
  lease_revision: number;
  revision: number;
  claim_generation: number;
  repeat_revision: boolean;
  terminal_finalization: { statusState: string; statusDetail: string; parkedCommand: boolean };
  lifecycle_projection: { canonicalTargetKey: string; fenceKey: string; revision: number };
};
type Dispatch = {
  target_repo: string;
  target_branch: string;
  item_number: number;
  item_kind: string;
  source_event: string;
  source_action: string;
  supersedes_in_progress: boolean;
  source_head_sha: string;
  queue_claim: { source_head_sha: string };
  review_options: ReviewOptions;
};

// Preserve the workflow wire checks, including legacy coercions. These types
// describe the fields each parser reads; validation remains at the same boundary.
const outputPath = process.env.GITHUB_OUTPUT!;
const commands: Record<string, () => void> = {
  review: () => {
    const response = JSON.parse(process.env.RESPONSE || "{}") as ClaimResponse;
    const dispatch = JSON.parse(process.env.DISPATCH_PAYLOAD || "{}") as Dispatch;
    const requestedItemKey = String(process.env.ITEM_KEY || "").trim();
    const requestedLeaseRevision = Number(process.env.QUEUE_LEASE_REVISION);
    const responseProtocol = Number(response.protocol_version || 1);
    if (responseProtocol !== 1 && responseProtocol !== 2) process.exit(1);
    if (response.claimed !== true) process.exit(1);

    const reviewOptions: Partial<ReviewOptions> =
      dispatch.review_options && typeof dispatch.review_options === "object"
        ? dispatch.review_options
        : {};
    const legacyDecision = {
      targetRepo: String(dispatch.target_repo || ""),
      targetBranch: String(dispatch.target_branch || "main"),
      itemNumber: Number(dispatch.item_number),
      itemKind: String(dispatch.item_kind || ""),
      sourceEvent: String(dispatch.source_event || ""),
      sourceAction: String(dispatch.source_action || "legacy_dispatch"),
      supersedesInProgress: dispatch.supersedes_in_progress === true,
      ...(/^[0-9a-f]{40}$/.test(
        String(dispatch.queue_claim?.source_head_sha || dispatch.source_head_sha || "")
          .trim()
          .toLowerCase(),
      )
        ? {
            sourceHeadSha: String(dispatch.queue_claim?.source_head_sha || dispatch.source_head_sha)
              .trim()
              .toLowerCase(),
          }
        : {}),
      ...(Number.isFinite(Number(reviewOptions.codex_timeout_ms))
        ? { codexTimeoutMs: Number(reviewOptions.codex_timeout_ms) }
        : {}),
      ...(Number.isFinite(Number(reviewOptions.media_proof_timeout_ms))
        ? { mediaProofTimeoutMs: Number(reviewOptions.media_proof_timeout_ms) }
        : {}),
      ...(Object.hasOwn(reviewOptions, "command_status_marker")
        ? { commandStatusMarker: reviewOptions.command_status_marker }
        : {}),
      ...(Object.hasOwn(reviewOptions, "status_comment_id")
        ? { statusCommentId: reviewOptions.status_comment_id }
        : {}),
      ...(Number.isSafeInteger(Number(reviewOptions.review_acknowledgement_comment_id)) &&
      Number(reviewOptions.review_acknowledgement_comment_id) > 0
        ? {
            reviewAcknowledgementCommentId: Number(reviewOptions.review_acknowledgement_comment_id),
          }
        : {}),
      ...(Object.hasOwn(reviewOptions, "additional_prompt")
        ? { additionalPrompt: reviewOptions.additional_prompt }
        : {}),
    };
    const decision =
      response.decision && typeof response.decision === "object"
        ? response.decision
        : (legacyDecision as unknown as Decision);
    const targetRepo = String(decision?.targetRepo || "");
    const itemNumber = Number(decision?.itemNumber);
    const itemKey = `${targetRepo}#${itemNumber}`;
    const leaseRevision =
      responseProtocol === 2
        ? Number(response.lease_revision)
        : Number(response.revision || response.lease_revision || process.env.QUEUE_LEASE_REVISION);
    const claimGeneration = Number(response.claim_generation);
    const repeatRevision = response.repeat_revision;
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(targetRepo) ||
      !Number.isInteger(itemNumber) ||
      itemNumber < 1 ||
      (decision.itemKind !== "issue" && decision.itemKind !== "pull_request") ||
      (decision.sourceEvent !== "issues" && decision.sourceEvent !== "pull_request") ||
      typeof decision.sourceAction !== "string" ||
      !decision.sourceAction
    ) {
      process.exit(1);
    }
    if (response.item_key && response.item_key !== itemKey) process.exit(1);
    if (requestedItemKey && requestedItemKey !== itemKey) process.exit(1);
    if (
      responseProtocol === 2 &&
      (!response.decision ||
        typeof response.decision !== "object" ||
        response.item_key !== requestedItemKey ||
        response.lease_revision !== requestedLeaseRevision ||
        !Number.isInteger(claimGeneration) ||
        claimGeneration < 1 ||
        typeof repeatRevision !== "boolean")
    ) {
      process.exit(1);
    }
    const output = [
      "claimed=true",
      `lease_id=${process.env.QUEUE_LEASE_ID}`,
      `item_key=${itemKey}`,
      `lease_revision=${Number.isInteger(leaseRevision) ? leaseRevision : ""}`,
      `claim_generation=${responseProtocol === 2 ? claimGeneration : ""}`,
      `repeat_revision=${responseProtocol === 2 ? repeatRevision : false}`,
      `protocol_version=${responseProtocol}`,
      `decision=${JSON.stringify(decision)}`,
    ];
    fs.appendFileSync(outputPath, `${output.join("\n")}\n`);
  },
  publication: () => {
    const response = JSON.parse(process.env.RESPONSE || "{}") as ClaimResponse;
    const decision = response.decision;
    const publication = decision?.publication;
    const producerDecision = publication?.producerDecision;
    const leaseRevision = Number(response.lease_revision);
    const claimGeneration = Number(response.claim_generation);
    const repeatRevision = response.repeat_revision;
    const publicationLeaseRevision = Number(publication?.leaseRevision);
    const directItemKey = `${decision?.targetRepo}#${decision?.itemNumber}`;
    const expectedDeferredItemKey = `${directItemKey}@publish:${publication?.producerRunId}:${publication?.producerRunAttempt}`;
    // Direct publication converts its already-leased base item into a
    // recoverable publication. Its saved revision must still match
    // this publisher lease before any external router handoff;
    // deferred publication has its own key.
    const directLifecycleRecovery =
      response.item_key === directItemKey &&
      publication?.itemKey === directItemKey &&
      Number.isInteger(publicationLeaseRevision) &&
      publicationLeaseRevision === leaseRevision;
    const directLifecycle = directLifecycleRecovery ? publication?.directLifecycle : null;
    const directLifecyclePlan = directLifecycle?.plan;
    const directLifecycleReceiptOutcome = directLifecycle?.receiptOutcome;
    const directLifecycleKinds = new Set([
      "router",
      "router_deferred_coverage",
      "router_not_required",
      "requeue",
      "target_missing",
      "target_closed",
      "guarded_open",
      "policy_noop",
    ]);
    // Pre-projection rows have no saved post-effect intent. They
    // deliberately retain artifact recovery rather than inferring a
    // router or terminal result from a newer publisher run.
    const directLifecycleRecoveryReady =
      directLifecycleRecovery &&
      directLifecyclePlan &&
      typeof directLifecyclePlan === "object" &&
      !Array.isArray(directLifecyclePlan) &&
      Object.keys(directLifecyclePlan).length === 1 &&
      directLifecycleKinds.has(directLifecyclePlan.kind) &&
      ["accepted", "deduped", "superseded"].includes(directLifecycleReceiptOutcome!);
    const deferredPublication = response.item_key === expectedDeferredItemKey;
    if (
      response.claimed !== true ||
      response.protocol_version !== 2 ||
      typeof repeatRevision !== "boolean" ||
      response.item_key !== process.env.ITEM_KEY ||
      (!deferredPublication && !directLifecycleRecovery) ||
      decision?.sourceAction !== "exact_review_artifact_publish" ||
      !publication ||
      !producerDecision ||
      producerDecision.targetRepo !== decision.targetRepo ||
      producerDecision.targetBranch !== decision.targetBranch ||
      producerDecision.itemNumber !== decision.itemNumber ||
      producerDecision.itemKind !== decision.itemKind
    )
      process.exit(1);
    if (!Number.isInteger(leaseRevision) || leaseRevision < 1) process.exit(1);
    if (!Number.isInteger(claimGeneration) || claimGeneration < 1) process.exit(1);
    const targetRepo = String(decision.targetRepo);
    const [targetRepoOwner, targetRepoName] = targetRepo.split("/");
    const targetSlug = targetRepo
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "-");
    const values = {
      artifact_name: publication.artifactName,
      generation_attempt: publication.producerRunAttempt,
      producer_run_id: publication.producerRunId,
      source_sha: publication.sourceSha,
      decision: JSON.stringify(producerDecision),
      item_key: publication.itemKey,
      protocol_version: publication.protocolVersion,
      lease_revision: publication.leaseRevision ?? "",
      claim_generation: publication.claimGeneration ?? "",
      target_repo: targetRepo,
      target_repo_owner: targetRepoOwner,
      target_repo_name: targetRepoName,
      target_slug: targetSlug,
      target_branch: decision.targetBranch,
      item_number: decision.itemNumber,
      item_kind: decision.itemKind,
      has_command_context: Boolean(
        producerDecision.commandStatusMarker || producerDecision.statusCommentId,
      ),
      live_proceeded: publication.liveProceeded,
      live_terminal_noop: publication.liveTerminalNoop,
      live_terminal_missing: publication.liveTerminalMissing,
      live_guarded_open: publication.liveGuardedOpen,
      publisher_lease_id: process.env.QUEUE_LEASE_ID,
      publisher_item_key: response.item_key,
      publisher_lease_revision: leaseRevision,
      publisher_claim_generation: claimGeneration,
      repeat_revision: repeatRevision,
      direct_lifecycle_recovery: directLifecycleRecoveryReady,
      direct_lifecycle_plan: directLifecycleRecoveryReady
        ? JSON.stringify(directLifecyclePlan)
        : "",
      direct_lifecycle_receipt_outcome: directLifecycleRecoveryReady
        ? directLifecycleReceiptOutcome
        : "",
    };
    fs.appendFileSync(outputPath, "claimed=true\n");
    for (const [key, value] of Object.entries(values)) {
      fs.appendFileSync(outputPath, `${key}=${value}\n`);
    }
  },
  finalization: () => {
    const response = JSON.parse(process.env.RESPONSE || "{}") as ClaimResponse;
    const decision = response.decision;
    const finalization = response.terminal_finalization;
    const lifecycleProjection = response.lifecycle_projection;
    const leaseRevision = Number(response.lease_revision);
    const claimGeneration = Number(response.claim_generation);
    if (
      response.claimed !== true ||
      response.protocol_version !== 2 ||
      response.item_key !== process.env.ITEM_KEY ||
      decision?.sourceAction !== "exact_review_artifact_publish" ||
      !finalization ||
      !["Complete", "Failed"].includes(finalization.statusState) ||
      typeof finalization.statusDetail !== "string" ||
      !lifecycleProjection ||
      lifecycleProjection.canonicalTargetKey !== `${decision.targetRepo}#${decision.itemNumber}` ||
      typeof lifecycleProjection.fenceKey !== "string" ||
      !lifecycleProjection.fenceKey ||
      !Number.isInteger(lifecycleProjection.revision) ||
      lifecycleProjection.revision < 1 ||
      !Number.isInteger(leaseRevision) ||
      leaseRevision < 1 ||
      !Number.isInteger(claimGeneration) ||
      claimGeneration < 1
    )
      process.exit(1);
    const [targetRepoOwner, targetRepoName] = String(decision.targetRepo).split("/");
    const values = {
      target_repo: decision.targetRepo,
      target_repo_owner: targetRepoOwner,
      target_repo_name: targetRepoName,
      item_number: decision.itemNumber,
      status_marker: decision.commandStatusMarker || "",
      status_comment_id: decision.statusCommentId || "",
      item_key: response.item_key,
      lease_revision: leaseRevision,
      lifecycle_fence_key: lifecycleProjection.fenceKey,
      lifecycle_revision: lifecycleProjection.revision,
      claim_generation: claimGeneration,
      status_state: finalization.statusState,
      status_detail: finalization.statusDetail,
      parked_command_finalization: Boolean(finalization.parkedCommand),
    };
    fs.appendFileSync(outputPath, "claimed=true\n");
    for (const [key, value] of Object.entries(values)) {
      fs.appendFileSync(outputPath, `${key}=${value}\n`);
    }
  },
  reservation: () => {
    const reservation = JSON.parse(process.env.RESERVATION || "{}") as {
      status: string;
      owner: string;
      commentId: number;
      retryAt: string;
      retryKind: string;
    };
    const append = (key: string, value: string) =>
      fs.appendFileSync(outputPath, `${key}=${value}\n`);
    if (reservation.status === "posted") {
      const owner = String(reservation.owner || "");
      const commentId = Number(reservation.commentId);
      if (
        !/^[a-zA-Z0-9._-]{1,200}$/.test(owner) ||
        !Number.isInteger(commentId) ||
        commentId <= 0
      ) {
        process.exit(1);
      }
      append("status", "posted");
      append("owner", owner);
      append("comment_id", String(commentId));
      append("queue_only", "false");
      process.exit(0);
    }
    if (reservation.status === "held") {
      const retryAt = String(reservation.retryAt || "");
      if (!Number.isFinite(Date.parse(retryAt))) process.exit(1);
      const retryKind = reservation.retryKind === "throttle" ? "throttle" : "coordination";
      append("status", "held");
      append("retry_kind", retryKind);
      append("retry_at", new Date(retryAt).toISOString());
      process.exit(0);
    }
    if (reservation.status === "superseded") {
      append("status", "superseded");
      process.exit(0);
    }
    process.exit(1);
  },
  retryAt: () => {
    const data = JSON.parse(fs.readFileSync(process.argv[3]!, "utf8")) as { retry_at: string };
    const value = String(data.retry_at || "").trim();
    const timestamp = Date.parse(value);
    if (!value || !Number.isFinite(timestamp)) process.exit(1);
    process.stdout.write(new Date(timestamp).toISOString());
  },
  sourceAction: () => {
    const decision = JSON.parse(process.env.CLAIM_DECISION || "{}") as Decision;
    process.stdout.write(decision.sourceAction || "");
  },
  lifecycleKind: () => {
    const plan = JSON.parse(process.env.DIRECT_LIFECYCLE_PLAN || "") as LifecyclePlan;
    const kinds = new Set([
      "router",
      "router_deferred_coverage",
      "router_not_required",
      "requeue",
      "target_missing",
      "target_closed",
      "guarded_open",
      "policy_noop",
    ]);
    if (
      !plan ||
      typeof plan !== "object" ||
      Array.isArray(plan) ||
      Object.keys(plan).length !== 1 ||
      !kinds.has(plan.kind)
    )
      process.exit(1);
    process.stdout.write(plan.kind);
  },
  legacyArtifact: () => {
    const reportPath = process.env.REPORT_PATH!;
    let legacyTupleless = false;
    if (fs.existsSync(reportPath)) {
      const markdown = fs.readFileSync(reportPath, "utf8");
      const owner = /^review_lease_owner:\s*(.+)\s*$/m.exec(markdown)?.[1]?.trim() || "";
      const commentId = Number(/^review_lease_comment_id:\s*(\d+)\s*$/m.exec(markdown)?.[1] || "0");
      legacyTupleless =
        (!owner || owner === "unknown") && (!Number.isInteger(commentId) || commentId <= 0);
    }
    fs.appendFileSync(outputPath, `legacy_tupleless=${legacyTupleless ? "true" : "false"}\n`);
  },
};

const command = commands[process.argv[2] ?? ""];
if (!command) throw new Error("unknown exact-review queue response command");
command();
