import {
  COMMAND_PROOF_SCENARIO,
  COMMAND_PROOF_SOURCE_ACTION,
  parseCommandProofClaim,
  parseMantisProofReceipt,
  proofRecord,
  proofSha,
  type CommandProofClaim,
} from "../command-proof-contract.js";
import { parseCommand } from "./comment-router-core.js";
import { GitHubRateLimitError } from "../github-retry.js";
import { admitProofCommand } from "./proof-command.js";
import {
  commandProofTargetIsCurrent,
  proofDigest,
  proofReceiptArtifactName,
  trustedRun,
  verifyCommandProof,
  type ProofLiveTarget,
} from "./proof-receipt-verification.js";
import { readProofZip } from "./proof-zip.js";

export interface CommandProofTransport {
  github(path: string, body?: unknown): Promise<unknown>;
  artifact(id: string): Promise<Buffer>;
  queue(operation: "claim" | "pending" | "update", body: unknown): Promise<unknown>;
  enqueue(body: unknown): Promise<unknown>;
  status(claim: CommandProofClaim, state: string, detail: string): Promise<void>;
}
export type ProofProducer = {
  workflowPath: string;
  workflowRef: string;
  workflowSha: string;
  harnessSha: string;
};

export class CommandProofConsumer {
  constructor(
    private transport: CommandProofTransport,
    private producer: ProofProducer,
  ) {}
  async request(input: { repository: string; pullRequest: number; commentId: string }) {
    if (
      input.repository !== "openclaw/openclaw" ||
      !Number.isSafeInteger(input.pullRequest) ||
      input.pullRequest < 1 ||
      !/^[1-9][0-9]{0,19}$/.test(input.commentId)
    )
      throw new Error("invalid_proof_target");
    if (!proofSha(this.producer.workflowSha, 40) || !proofSha(this.producer.harnessSha, 40))
      throw new Error("proof_producer_not_pinned");
    const live = await this.live(input.repository, input.pullRequest, input.commentId);
    const repo = proofRecord(live.repository),
      pull = proofRecord(live.pull),
      comment = proofRecord(live.comment);
    const parsed = parseCommand(String(comment.body ?? ""));
    const admission = admitProofCommand({
      commandText: String(parsed?.proof_command_text ?? ""),
      repository: input.repository,
      pullRequest: input.pullRequest,
      isPullRequest: !!pull.head,
      isOpen: pull.state === "open",
      currentHeadSha: String(proofRecord(pull.head).sha || ""),
      maintainerAuthorized:
        proofRecord(comment.user).type === "User" &&
        ["write", "maintain", "admin"].includes(String(proofRecord(live.permission).permission)),
    });
    if (!admission.request || admission.request.scenarioId !== COMMAND_PROOF_SCENARIO)
      return { status: "inconclusive", reason: "unsupported_or_invalid_proof_command" };
    const identity = {
      repository: input.repository,
      repositoryId: String(repo.id),
      pullRequest: input.pullRequest,
      headSha: admission.request.headSha,
      baseSha: proofRecord(pull.base).sha,
      bodySha256: proofDigest(String(pull.body ?? "")),
      targetBranch: String(proofRecord(pull.base).ref || ""),
      scenario: COMMAND_PROOF_SCENARIO,
      ...this.producer,
      sourceCommentId: input.commentId,
      sourceCommentUpdatedAt: String(comment.updated_at),
      sourceCommentBodySha256: proofDigest(String(comment.body)),
    };
    const claim = parseCommandProofClaim({
      requestId: proofDigest(JSON.stringify(identity)),
      ...identity,
    });
    if (!claim || !commandProofTargetIsCurrent(claim, live))
      return { status: "inconclusive", reason: "unverified_target" };
    const claimed = proofRecord(await this.transport.queue("claim", { claim }));
    if (claimed.accepted !== true)
      return { status: "inconclusive", reason: String(claimed.reason || "claim_rejected") };
    const stored = proofRecord(claimed.record),
      storedClaim = parseCommandProofClaim(stored.claim);
    if (!storedClaim) throw new Error("invalid_durable_proof_claim");
    if (claimed.dispatch !== true)
      return {
        status: ["inconclusive", "completed"].includes(String(stored.state))
          ? "inconclusive"
          : "queued",
        requestId: storedClaim.requestId,
        reason: "existing_request_no_duplicate_dispatch",
      };
    let preDispatchFailure: string | null = null;
    try {
      if (
        !commandProofTargetIsCurrent(
          claim,
          await this.live(claim.repository, claim.pullRequest, claim.sourceCommentId),
        )
      ) {
        preDispatchFailure = "target_changed_before_dispatch";
      } else {
        const dispatchCommit = proofRecord(
          await this.transport.github(
            "repos/" + claim.repository + "/commits/" + encodeURIComponent(claim.workflowRef),
          ),
        );
        if (dispatchCommit.sha !== claim.workflowSha)
          preDispatchFailure = "producer_dispatch_ref_moved";
      }
    } catch {
      // No dispatch POST has been attempted; release the pilot slot rather than
      // reserving it for a producer run that cannot exist.
      preDispatchFailure = "pre_dispatch_validation_unavailable";
    }
    if (preDispatchFailure) return this.terminate(claim, preDispatchFailure);
    // At-most-once after durable claim. Unknown transport outcome is reconciled, never redispatched.
    try {
      const dispatched = proofRecord(
        await this.transport.github(
          "repos/" +
            claim.repository +
            "/actions/workflows/" +
            encodeURIComponent(claim.workflowPath.split("/").at(-1)!) +
            "/dispatches",
          {
            ref: claim.workflowRef,
            inputs: {
              request_id: claim.requestId,
              pr_number: String(claim.pullRequest),
              candidate_ref: claim.headSha,
            },
          },
        ),
      );
      const runId = String(dispatched.workflow_run_id ?? "");
      if (!/^[1-9][0-9]{0,19}$/.test(runId))
        throw new Error("missing_authoritative_dispatch_run_id");
      await this.transport.queue("update", {
        operation: "dispatched",
        requestId: claim.requestId,
        runId,
      });
      return { status: "queued", requestId: claim.requestId, reason: "explicit_proof_dispatched" };
    } catch (error) {
      if (error instanceof GitHubRateLimitError)
        await this.transport.queue("update", {
          operation: "defer",
          requestId: claim.requestId,
          retryAt: Date.parse(error.retryAt),
        });
      return {
        status: "queued",
        requestId: claim.requestId,
        reason: "dispatch_outcome_unknown_no_automatic_retry",
      };
    }
  }
  async reconcile() {
    const payload = proofRecord(await this.transport.queue("pending", {}));
    if (!Array.isArray(payload.records) || payload.records.length > 4)
      throw new Error("invalid_pending_proofs");
    const results: unknown[] = [];
    for (const item of payload.records) {
      const record = proofRecord(item),
        claim = parseCommandProofClaim(record.claim);
      if (!claim) throw new Error("invalid_pending_proof_claim");
      try {
        if (record.state === "completed" || record.state === "inconclusive") {
          const state = record.state === "completed" ? "independent_review_queued" : "inconclusive";
          const detail =
            record.state === "completed"
              ? "Scenario assertion outcome: " +
                String(proofRecord(record.result).outcome) +
                ". Independent proof-only review is queued; this is not sufficient proof or merge readiness."
              : String(record.reason || "proof_inconclusive") +
                ". No proof or other blocker was cleared.";
          // Once enqueued, the existing review-status owner owns this marker.
          // Never overwrite a faster reviewer completion with a late handoff notice.
          if (record.state !== "completed") await this.transport.status(claim, state, detail);
          await this.transport.queue("update", {
            operation: "notified",
            requestId: claim.requestId,
          });
          results.push({ requestId: claim.requestId, status: state });
        } else
          results.push(
            await this.reconcileOne(
              claim,
              typeof record.runId === "string" ? record.runId : undefined,
            ),
          );
      } catch (error) {
        if (error instanceof GitHubRateLimitError) {
          await this.transport.queue("update", {
            operation: "defer",
            requestId: claim.requestId,
            retryAt: Date.parse(error.retryAt),
          });
          results.push({
            requestId: claim.requestId,
            status: "pending",
            reason: "github_throttled",
          });
          break;
        }
        results.push({
          requestId: claim.requestId,
          status: "pending",
          reason: "infrastructure_unavailable",
        });
      }
    }
    return results;
  }
  private async reconcileOne(claim: CommandProofClaim, dispatchedRunId?: string) {
    if (
      !commandProofTargetIsCurrent(
        claim,
        await this.live(claim.repository, claim.pullRequest, claim.sourceCommentId),
      )
    )
      return this.terminate(claim, "stale_or_unauthorized_target");
    let id = dispatchedRunId;
    if (!id) {
      const pageSize = 100;
      const pageBudget = 5; // Stay below GitHub's 1,000-result filtered-search ceiling.
      // The versioned workflow-runs API supports created ranges. Freeze the range
      // for all pages; time only bounds inventory, never identifies the producer.
      const created =
        new Date(Date.parse(claim.sourceCommentUpdatedAt) - 60_000).toISOString() +
        ".." +
        new Date(Date.now() + 60_000).toISOString();
      const runs = new Map<string, string>();
      const matches = new Set<string>();
      let total: number | undefined;
      const pending = (reason: string) => ({
        requestId: claim.requestId,
        status: "pending",
        reason,
      });
      for (let page = 1; page <= pageBudget; page++) {
        const listing = proofRecord(
          await this.transport.github(
            "repos/" +
              claim.repository +
              "/actions/workflows/" +
              encodeURIComponent(claim.workflowPath.split("/").at(-1)!) +
              "/runs?event=workflow_dispatch&per_page=" +
              pageSize +
              "&page=" +
              page +
              "&created=" +
              encodeURIComponent(created),
          ),
        );
        if (
          !Array.isArray(listing.workflow_runs) ||
          typeof listing.total_count !== "number" ||
          !Number.isSafeInteger(listing.total_count) ||
          listing.total_count < 0 ||
          listing.workflow_runs.length > pageSize
        )
          return pending("partial_producer_run_inventory");
        if (total !== undefined && total !== listing.total_count)
          return pending("partial_producer_run_inventory");
        total = listing.total_count;
        if (total > pageSize * pageBudget) return pending("producer_run_inventory_budget_exceeded");
        if (listing.workflow_runs.length !== Math.min(pageSize, total - (page - 1) * pageSize))
          return pending("partial_producer_run_inventory");
        for (const value of listing.workflow_runs) {
          const run = proofRecord(value);
          const runId = String(run.id ?? "");
          if (
            !/^[1-9][0-9]{0,19}$/.test(runId) ||
            (typeof run.id === "number" && !Number.isSafeInteger(run.id)) ||
            typeof run.display_title !== "string"
          )
            return pending("partial_producer_run_inventory");
          if (runs.has(runId) && runs.get(runId) !== run.display_title)
            return pending("partial_producer_run_inventory");
          runs.set(runId, run.display_title);
          // Explicit request correlation only; duplicate pages cannot create a second match.
          if (run.display_title.includes("[" + claim.requestId + "]")) matches.add(runId);
        }
        if (matches.size > 1) return this.terminate(claim, "ambiguous_producer_run_inventory");
        if (page * pageSize >= total) {
          if (runs.size !== total) return pending("partial_producer_run_inventory");
          break;
        }
      }
      if (total === undefined || runs.size !== total)
        return pending("partial_producer_run_inventory");
      if (matches.size === 0) return pending("producer_run_not_observed");
      id = matches.values().next().value ?? "";
    }
    if (!/^[1-9][0-9]{0,19}$/.test(id)) return this.terminate(claim, "invalid_producer_run_id");
    const run = proofRecord(
      await this.transport.github("repos/" + claim.repository + "/actions/runs/" + id),
    );
    if (run.status !== "completed")
      return { requestId: claim.requestId, status: "pending", reason: "producer_running" };
    if (!trustedRun(claim, run)) return this.terminate(claim, "untrusted_or_failed_producer_run");
    const inventory = proofRecord(
      await this.transport.github(
        "repos/" + claim.repository + "/actions/runs/" + id + "/artifacts?per_page=100",
      ),
    );
    if (
      !Array.isArray(inventory.artifacts) ||
      inventory.total_count !== inventory.artifacts.length ||
      inventory.artifacts.length > 100
    )
      return this.terminate(claim, "partial_artifact_inventory");
    const artifacts = inventory.artifacts.map(proofRecord);
    const receipts = artifacts.filter(
      (a) => a.name === proofReceiptArtifactName(claim.requestId, id, Number(run.run_attempt)),
    );
    if (receipts.length !== 1) return this.terminate(claim, "missing_or_ambiguous_receipt");
    const receiptArtifact = receipts[0]!;
    const receiptId = String(receiptArtifact.id);
    if (!/^[1-9][0-9]{0,19}$/.test(receiptId)) return this.terminate(claim, "invalid_receipt_id");
    const receiptArchive = await this.transport.artifact(receiptId);
    let receipt;
    try {
      const files = readProofZip(receiptArchive),
        file = files.get("receipt.json");
      receipt =
        file && file.length <= 65536
          ? parseMantisProofReceipt(JSON.parse(file.toString("utf8")))
          : null;
    } catch {
      receipt = null;
    }
    if (!receipt) return this.terminate(claim, "malformed_receipt");
    const evidenceMatches = artifacts.filter((a) => String(a.id) === receipt.evidence?.artifact_id);
    const evidenceArtifact = evidenceMatches.length === 1 ? evidenceMatches[0] : null;
    const evidenceArchive =
      evidenceArtifact && receipt.evidence
        ? await this.transport.artifact(receipt.evidence.artifact_id)
        : null;
    const live = await this.live(claim.repository, claim.pullRequest, claim.sourceCommentId);
    const currentRun = await this.transport.github(
      "repos/" + claim.repository + "/actions/runs/" + id,
    );
    const jobs = await this.transport.github(
      "repos/" +
        claim.repository +
        "/actions/runs/" +
        id +
        "/attempts/" +
        receipt.run.attempt +
        "/jobs?per_page=100",
    );
    const verified = verifyCommandProof({
      claim,
      live,
      run: currentRun,
      jobs,
      receiptArtifact,
      receiptArchive,
      evidenceArtifact,
      evidenceArchive,
    });
    if (verified.outcome === "inconclusive") return this.terminate(claim, verified.reason);
    const result = {
      outcome: verified.outcome,
      digest: verified.evidenceDigest,
      reviewContext: verified.reviewContext,
      runId: id,
      runAttempt: receipt.run.attempt,
    };
    const saved = proofRecord(
      await this.transport.queue("update", {
        operation: "verified",
        requestId: claim.requestId,
        result,
      }),
    );
    if (proofRecord(saved.record).state !== "review_pending")
      return { requestId: claim.requestId, status: "deduped" };
    // Recheck authority immediately before requesting independent review. No labels/merge API exists here.
    if (
      !commandProofTargetIsCurrent(
        claim,
        await this.live(claim.repository, claim.pullRequest, claim.sourceCommentId),
      )
    )
      return this.terminate(claim, "target_changed_before_reassessment");
    const sourceCommentId = Number(claim.sourceCommentId);
    if (!Number.isSafeInteger(sourceCommentId) || sourceCommentId < 1)
      return this.terminate(claim, "invalid_review_source_comment_id");
    const deliveryId = "command-proof-" + claim.requestId + "-" + verified.evidenceDigest;
    const enqueued = proofRecord(
      await this.transport.enqueue({
        delivery_id: deliveryId,
        decision: {
          targetRepo: claim.repository,
          targetBranch: claim.targetBranch,
          itemNumber: claim.pullRequest,
          itemKind: "pull_request",
          sourceEvent: "pull_request",
          sourceAction: COMMAND_PROOF_SOURCE_ACTION,
          supersedesInProgress: false,
          sourceHeadSha: claim.headSha,
          // Keep full-review ordering and the head authority guard. If an existing
          // review owns this target, its queue owner releases this command's rejected
          // receipt so the same delivery can retry after that review finishes.
          sourceCommentId,
          sourceCommentUpdatedAt: claim.sourceCommentUpdatedAt,
          commandBodyDigest: claim.sourceCommentBodySha256,
          commandOrigin: "comment_router",
          sourceCommentVerified: true,
          sourceDeliveryId: deliveryId,
          additionalPrompt: verified.reviewContext,
          commandStatusMarker:
            "<!-- clawsweeper-command-status:" +
            claim.pullRequest +
            ":request_proof:" +
            claim.requestId +
            " -->",
        },
      }),
    );
    // Exact authenticated-delivery replays return the original queued:true response.
    // Generic, stale-source and rejected dedupes do not establish admission.
    if (
      enqueued.ok !== true ||
      enqueued.queued !== true ||
      enqueued.accepted === false ||
      enqueued.item_key !== claim.repository + "#" + claim.pullRequest ||
      ["shed", "rejected", "deduped", "stale_source", "stale_command", "superseded"].some(
        (key) => enqueued[key] === true,
      )
    ) {
      throw new Error("proof_reassessment_not_admitted");
    }
    await this.transport.queue("update", {
      operation: "enqueued",
      requestId: claim.requestId,
      digest: verified.evidenceDigest,
    });
    return {
      requestId: claim.requestId,
      status: "independent_review_queued",
      outcome: verified.outcome,
    };
  }
  private async live(
    repository: string,
    number: number,
    commentId: string,
  ): Promise<ProofLiveTarget> {
    const repo = "repos/" + repository;
    const [metadata, pull, comment] = await Promise.all([
      this.transport.github(repo),
      this.transport.github(repo + "/pulls/" + number),
      this.transport.github(repo + "/issues/comments/" + commentId),
    ]);
    const login = proofRecord(proofRecord(comment).user).login;
    if (typeof login !== "string" || !/^[A-Za-z0-9-]+$/.test(login))
      return { repository: metadata, pull, comment, permission: {} };
    const permission = await this.transport.github(
      repo + "/collaborators/" + login + "/permission",
    );
    return { repository: metadata, pull, comment, permission };
  }
  private async terminate(claim: CommandProofClaim, reason: string) {
    await this.transport.queue("update", {
      operation: "inconclusive",
      requestId: claim.requestId,
      reason,
    });
    return { requestId: claim.requestId, status: "inconclusive", reason };
  }
}
