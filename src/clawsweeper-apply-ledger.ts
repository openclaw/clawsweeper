import {
  ACTION_EVENT_REASON_CODES,
  ACTION_EVENT_STATUSES,
  ACTION_EVENT_TYPES,
  type ActionEventEvidence,
  type ActionEventReasonCode,
  type ActionEventStatus,
  type ActionEventSubject,
} from "./action-ledger.js";
import { recordWorkflowPhaseEvent } from "./action-ledger-runtime.js";
import type { createReviewActionLedger } from "./clawsweeper-review-ledger.js";
import type {
  ActionTaken,
  ApplyActionLedger,
  ApplyItemBusinessIdempotencyIdentity,
  ApplyKind,
  ApplyLedgerItem,
  ApplyMutationAttempt,
  ApplyMutationBusinessIdempotencyIdentity,
  ApplyPhaseCursor,
  ApplyResult,
  CloseReason,
  ItemKind,
  ReportEntry,
} from "./clawsweeper-types.js";

interface ApplyActionLedgerDependencies {
  root: string;
  targetRepo: () => string;
  repoRelativePath: (filePath: string) => string;
  sha256: (value: string) => string;
  frontMatterValue: (markdown: string, key: string) => string | undefined;
  reviewLeaseRevisionFromReport: (markdown: string) => string | null;
  reportItemKind: (markdown: string) => ItemKind | undefined;
  reviewLedger: ReturnType<typeof createReviewActionLedger>;
}

export function createApplyActionLedger({
  root,
  targetRepo,
  repoRelativePath,
  sha256,
  frontMatterValue,
  reviewLeaseRevisionFromReport,
  reportItemKind,
  reviewLedger,
}: ApplyActionLedgerDependencies) {
  const {
    actionLedgerFailureDisposition,
    actionLedgerFileDigestEvidence,
    actionLedgerFileEvidence,
    actionLedgerItemKey,
    actionLedgerPrivacy,
    workflowRunEvidence,
  } = reviewLedger;
  function nextApplyPhaseSeq(cursor: ApplyPhaseCursor): number {
    const phaseSeq = cursor.nextPhaseSeq;
    cursor.nextPhaseSeq += 1;
    return phaseSeq;
  }

  function applyPhaseSequenceForTest(count: number): number[] {
    const cursor: ApplyPhaseCursor = { nextPhaseSeq: 2 };
    return Array.from({ length: Math.max(0, count) }, () => nextApplyPhaseSeq(cursor));
  }

  function startApplyActionLedger(options: {
    applyKind: ApplyKind;
    closeReasons: ReadonlySet<CloseReason> | null;
    dryRun: boolean;
    syncCommentsOnly: boolean;
    requestedItemNumbers: readonly number[];
    reportPath: string;
    candidates: readonly ReportEntry[];
  }): ApplyActionLedger {
    const operationIdentity = {
      repository: targetRepo(),
      applyKind: options.applyKind,
      closeReasons: options.closeReasons ? [...options.closeReasons].sort() : ["all"],
      dryRun: options.dryRun,
      syncCommentsOnly: options.syncCommentsOnly,
      requestedItemNumbers: [...options.requestedItemNumbers],
      reportPath: repoRelativePath(options.reportPath),
      checkpoint: String(process.env.CLAWSWEEPER_APPLY_CHECKPOINT ?? "0"),
      candidateRevisions: options.candidates.map((entry) => ({
        repository: entry.repo,
        number: entry.number,
        sourceRevision: reviewLeaseRevisionFromReport(entry.markdown) ?? "unknown",
        reviewContentDigest: frontMatterValue(entry.markdown, "review_content_digest") ?? "unknown",
        decisionPacketSha256: frontMatterValue(entry.markdown, "decision_packet_sha256") ?? "none",
      })),
    };
    const batchStart = recordWorkflowPhaseEvent(root, {
      phase: ACTION_EVENT_TYPES.applyBatch,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      retryable: false,
      mutation: false,
      identity: { slot: "apply_batch_start" },
      operation: "apply",
      operationIdentity,
      phaseSeq: 1,
      idempotencyIdentity: { operationIdentity, slot: "apply_batch_start" },
      component: "apply_decisions",
      subject: {
        repository: targetRepo(),
        kind: "workflow",
      },
      evidence: workflowRunEvidence(),
      attributes: {
        candidate_count: options.candidates.length,
        review_mode: options.syncCommentsOnly ? "comment_sync" : "apply",
        work_kind: options.dryRun ? "proof" : "mutation",
      },
      privacy: actionLedgerPrivacy(),
    });
    const items = new Map<string, ApplyLedgerItem>();
    for (const [index, entry] of options.candidates.entries()) {
      const key = actionLedgerItemKey(entry);
      if (items.has(key)) continue;
      items.set(key, {
        entry,
        index,
        started: false,
        startEventId: null,
        lastEventId: null,
        mutationObserved: false,
        uncertainMutationObserved: false,
        mutationEventId: null,
        mutationAttemptCount: 0,
        terminal: false,
        businessIdentity: {
          operation: "apply",
          repository: entry.repo,
          number: entry.number,
          sourceRevision: reviewLeaseRevisionFromReport(entry.markdown) ?? "unknown",
          reviewContentDigest:
            frontMatterValue(entry.markdown, "review_content_digest") ?? "unknown",
          decisionPacketSha256:
            frontMatterValue(entry.markdown, "decision_packet_sha256") ?? "none",
        },
      });
    }
    return {
      operationIdentity,
      batchStartEventId: batchStart?.event_id ?? null,
      items,
      startedAtMs: Date.now(),
      nextPhaseSeq: 2,
      terminal: false,
    };
  }

  function applyItemBusinessIdempotencyIdentityForTest(options: {
    slot: "apply_item" | "apply_mutation" | "review_comment";
    repository: string;
    number: number;
    sourceRevision: string;
    reviewContentDigest: string;
    decisionPacketSha256: string;
  }): ApplyItemBusinessIdempotencyIdentity {
    return {
      operation: "apply",
      slot: options.slot,
      repository: options.repository,
      number: options.number,
      sourceRevision: options.sourceRevision,
      reviewContentDigest: options.reviewContentDigest,
      decisionPacketSha256: options.decisionPacketSha256,
    };
  }

  function applyItemIdempotencyIdentity(
    state: ApplyLedgerItem,
    slot: "apply_item" | "apply_mutation" | "review_comment",
  ): ApplyItemBusinessIdempotencyIdentity {
    return applyItemBusinessIdempotencyIdentityForTest({
      ...state.businessIdentity,
      slot,
    });
  }

  function applyMutationBusinessIdempotencyIdentityForTest(options: {
    repository: string;
    number: number;
    sourceRevision: string;
    reviewContentDigest: string;
    decisionPacketSha256: string;
    mutationIdentity: string;
  }): ApplyMutationBusinessIdempotencyIdentity {
    return {
      ...applyItemBusinessIdempotencyIdentityForTest({
        ...options,
        slot: "apply_mutation",
      }),
      slot: "apply_mutation",
      mutationIdentitySha256: sha256(options.mutationIdentity),
    };
  }

  function applyLedgerItemSubject(
    state: ApplyLedgerItem,
    entry: ReportEntry = state.entry,
  ): ActionEventSubject {
    const kind = reportItemKind(entry.markdown);
    if (!kind) {
      throw new Error(
        `apply ledger item ${state.businessIdentity.repository}#${state.businessIdentity.number} has no report item kind`,
      );
    }
    const recordPath = repoRelativePath(entry.path);
    return {
      repository: state.businessIdentity.repository,
      kind,
      number: state.businessIdentity.number,
      ...(state.businessIdentity.sourceRevision === "unknown"
        ? {}
        : { sourceRevision: state.businessIdentity.sourceRevision }),
      ...(recordPath.startsWith("../") ? {} : { recordPath }),
    };
  }

  function startApplyActionLedgerItem(
    ledger: ApplyActionLedger,
    entry: ReportEntry,
  ): ApplyLedgerItem | null {
    const state = ledger.items.get(actionLedgerItemKey(entry));
    if (!state) return null;
    if (state.started) return state;
    const phaseSeq = nextApplyPhaseSeq(ledger);
    const start = recordWorkflowPhaseEvent(root, {
      phase: ACTION_EVENT_TYPES.applyAction,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      retryable: false,
      mutation: false,
      identity: {
        slot: "apply_item_start",
        index: state.index,
        repository: entry.repo,
        number: entry.number,
      },
      operation: "apply",
      operationIdentity: ledger.operationIdentity,
      parentEventId: ledger.batchStartEventId,
      phaseSeq,
      idempotencyIdentity: applyItemIdempotencyIdentity(state, "apply_item"),
      component: "apply_decisions",
      subject: applyLedgerItemSubject(state),
      evidence: workflowRunEvidence(),
      attributes: {
        batch_index: state.index,
        item_count: 1,
        completion_reason: "started",
      },
      privacy: actionLedgerPrivacy(),
    });
    state.started = true;
    state.startEventId = start?.event_id ?? null;
    state.lastEventId = state.startEventId;
    return state;
  }

  function startApplyMutationAttempt(
    ledger: ApplyActionLedger,
    entry: ReportEntry,
    receiptIdentity: string,
    idempotencyIdentity: string,
  ): ApplyMutationAttempt | null {
    const state = startApplyActionLedgerItem(ledger, entry);
    if (!state) return null;
    const mutationIndex = state.mutationAttemptCount;
    state.mutationAttemptCount += 1;
    const businessIdempotencyIdentity = applyMutationBusinessIdempotencyIdentityForTest({
      ...state.businessIdentity,
      mutationIdentity: idempotencyIdentity,
    });
    const receiptIdentitySha256 = sha256(receiptIdentity);
    const phaseSeq = nextApplyPhaseSeq(ledger);
    const attempt = recordWorkflowPhaseEvent(root, {
      phase: ACTION_EVENT_TYPES.applyAction,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      retryable: true,
      mutation: false,
      identity: {
        slot: "apply_mutation_attempt",
        index: state.index,
        mutationIndex,
        receiptIdentitySha256,
        repository: entry.repo,
        number: entry.number,
      },
      operation: "apply",
      operationIdentity: ledger.operationIdentity,
      parentEventId: state.lastEventId ?? state.startEventId,
      phaseSeq,
      idempotencyIdentity: businessIdempotencyIdentity,
      component: "apply_decisions",
      subject: applyLedgerItemSubject(state),
      evidence: workflowRunEvidence(),
      attributes: {
        batch_index: state.index,
        attempt: mutationIndex + 1,
        action_count: 1,
        partial: true,
        completion_reason: "mutation_attempted",
      },
      privacy: actionLedgerPrivacy(),
    });
    state.lastEventId = attempt?.event_id ?? state.lastEventId;
    return {
      state,
      eventId: attempt?.event_id ?? null,
      idempotencyIdentity: businessIdempotencyIdentity,
      mutationIndex,
      receiptIdentitySha256,
    };
  }

  function finishApplyMutationAttempt(options: {
    ledger: ApplyActionLedger;
    entry: ReportEntry;
    attempt: ApplyMutationAttempt;
    outcome: "accepted" | "rejected" | "unknown";
  }): string | null {
    const mutation = options.outcome !== "rejected";
    const phaseSeq = nextApplyPhaseSeq(options.ledger);
    const event = recordWorkflowPhaseEvent(root, {
      phase: ACTION_EVENT_TYPES.applyAction,
      status:
        options.outcome === "accepted"
          ? ACTION_EVENT_STATUSES.executed
          : options.outcome === "rejected"
            ? ACTION_EVENT_STATUSES.skipped
            : ACTION_EVENT_STATUSES.failed,
      reasonCode:
        options.outcome === "accepted"
          ? ACTION_EVENT_REASON_CODES.completed
          : options.outcome === "rejected"
            ? ACTION_EVENT_REASON_CODES.notApplicable
            : ACTION_EVENT_REASON_CODES.unavailable,
      retryable: options.outcome === "unknown",
      mutation,
      identity: {
        slot: "apply_mutation_outcome",
        index: options.attempt.state.index,
        mutationIndex: options.attempt.mutationIndex,
        receiptIdentitySha256: options.attempt.receiptIdentitySha256,
        outcome: options.outcome,
        repository: options.entry.repo,
        number: options.entry.number,
      },
      operation: "apply",
      operationIdentity: options.ledger.operationIdentity,
      parentEventId: options.attempt.eventId,
      phaseSeq,
      idempotencyIdentity: options.attempt.idempotencyIdentity,
      component: "apply_decisions",
      subject: applyLedgerItemSubject(options.attempt.state),
      evidence: workflowRunEvidence(),
      attributes: {
        batch_index: options.attempt.state.index,
        attempt: options.attempt.mutationIndex + 1,
        action_count: mutation ? 1 : 0,
        partial: options.outcome === "unknown",
        completion_reason:
          options.outcome === "accepted"
            ? "mutation_accepted"
            : options.outcome === "rejected"
              ? "mutation_rejected"
              : "mutation_outcome_unknown",
      },
      privacy: actionLedgerPrivacy(),
    });
    options.attempt.state.lastEventId = event?.event_id ?? options.attempt.state.lastEventId;
    if (mutation) {
      options.attempt.state.mutationEventId = event?.event_id ?? options.attempt.eventId;
    }
    if (options.outcome === "unknown") {
      options.attempt.state.uncertainMutationObserved = true;
    }
    return event?.event_id ?? null;
  }

  function recordApplyMutationBoundary(
    ledger: ApplyActionLedger,
    entry: ReportEntry,
    parentEventId?: string | null,
  ): void {
    const state = startApplyActionLedgerItem(ledger, entry);
    if (!state || state.mutationObserved) return;
    const phaseSeq = nextApplyPhaseSeq(ledger);
    const mutation = recordWorkflowPhaseEvent(root, {
      phase: ACTION_EVENT_TYPES.applyAction,
      status: ACTION_EVENT_STATUSES.executed,
      reasonCode: ACTION_EVENT_REASON_CODES.completed,
      retryable: true,
      mutation: true,
      identity: {
        slot: "apply_mutation_observed",
        index: state.index,
        repository: entry.repo,
        number: entry.number,
      },
      operation: "apply",
      operationIdentity: ledger.operationIdentity,
      parentEventId: parentEventId ?? state.lastEventId ?? state.startEventId,
      phaseSeq,
      idempotencyIdentity: applyItemIdempotencyIdentity(state, "apply_item"),
      component: "apply_decisions",
      subject: applyLedgerItemSubject(state),
      evidence: workflowRunEvidence(),
      attributes: {
        batch_index: state.index,
        action_count: 1,
        partial: true,
        completion_reason: "mutation_observed",
      },
      privacy: actionLedgerPrivacy(),
    });
    state.mutationObserved = true;
    state.lastEventId = mutation?.event_id ?? state.lastEventId;
    state.mutationEventId = mutation?.event_id ?? state.mutationEventId;
  }

  function applyActionEventDisposition(
    action: ActionTaken,
    mutationOccurred: boolean,
    dryRun: boolean,
    commentMutationOccurred = mutationOccurred,
  ): {
    status: ActionEventStatus;
    reasonCode: ActionEventReasonCode;
    retryable: boolean;
    mutation: boolean;
    completionReason: string;
  } {
    if (action === "skipped_runtime_budget") {
      return {
        status: ACTION_EVENT_STATUSES.yielded,
        reasonCode: ACTION_EVENT_REASON_CODES.runtimeBudget,
        retryable: true,
        mutation: mutationOccurred,
        completionReason: "runtime_budget",
      };
    }
    if (dryRun && (action === "closed" || action === "review_comment_synced")) {
      return {
        status: ACTION_EVENT_STATUSES.planned,
        reasonCode: ACTION_EVENT_REASON_CODES.dryRun,
        retryable: false,
        mutation: false,
        completionReason: "dry_run",
      };
    }
    if (action === "closed") {
      return {
        status: ACTION_EVENT_STATUSES.completed,
        reasonCode: ACTION_EVENT_REASON_CODES.completed,
        retryable: false,
        mutation: mutationOccurred,
        completionReason: "closed",
      };
    }
    if (action === "review_comment_synced" || action === "corrected_stale_canonical_comment") {
      if (!commentMutationOccurred) {
        return {
          status: ACTION_EVENT_STATUSES.unchanged,
          reasonCode: ACTION_EVENT_REASON_CODES.contentUnchanged,
          retryable: false,
          mutation: mutationOccurred,
          completionReason: "comment_unchanged",
        };
      }
      return {
        status: ACTION_EVENT_STATUSES.completed,
        reasonCode: ACTION_EVENT_REASON_CODES.published,
        retryable: false,
        mutation: mutationOccurred,
        completionReason: "comment_published",
      };
    }
    if (action.startsWith("retry_")) {
      return {
        status: ACTION_EVENT_STATUSES.waiting,
        reasonCode: ACTION_EVENT_REASON_CODES.dependencyPending,
        retryable: true,
        mutation: mutationOccurred,
        completionReason: "retry_pending",
      };
    }
    if (action === "skipped_changed_since_review") {
      return {
        status: ACTION_EVENT_STATUSES.blocked,
        reasonCode: ACTION_EVENT_REASON_CODES.sourceChanged,
        retryable: true,
        mutation: mutationOccurred,
        completionReason: "source_changed",
      };
    }
    if (action === "skipped_comment_auth") {
      return {
        status: ACTION_EVENT_STATUSES.blocked,
        reasonCode: ACTION_EVENT_REASON_CODES.authorizationFailed,
        retryable: true,
        mutation: mutationOccurred,
        completionReason: "authorization_failed",
      };
    }
    if (action === "skipped_locked_conversation") {
      return {
        status: ACTION_EVENT_STATUSES.blocked,
        reasonCode: ACTION_EVENT_REASON_CODES.policyBlocked,
        retryable: false,
        mutation: mutationOccurred,
        completionReason: "locked_conversation",
      };
    }
    if (action === "kept_open" || action.startsWith("skipped_")) {
      return {
        status: ACTION_EVENT_STATUSES.skipped,
        reasonCode: ACTION_EVENT_REASON_CODES.notApplicable,
        retryable: false,
        mutation: mutationOccurred,
        completionReason: action,
      };
    }
    return {
      status: ACTION_EVENT_STATUSES.completed,
      reasonCode: ACTION_EVENT_REASON_CODES.completed,
      retryable: false,
      mutation: mutationOccurred,
      completionReason: "completed",
    };
  }

  function applyRuntimeBudgetYieldResults(number: number, reason: string): ApplyResult[] {
    return [
      {
        number,
        action: "skipped_runtime_budget",
        reason,
      },
      {
        number: 0,
        action: "skipped_runtime_budget",
        reason,
      },
    ];
  }

  function applyRuntimeBudgetYieldResultsForTest(number: number, reason: string): ApplyResult[] {
    return applyRuntimeBudgetYieldResults(number, reason);
  }

  function reviewCommentPublicationEventDisposition(
    action: ActionTaken,
    commentMutationOccurred: boolean,
    dryRun: boolean,
    guardedOpenStateVerified = false,
  ): {
    status: ActionEventStatus;
    reasonCode: ActionEventReasonCode;
    retryable: boolean;
    mutation: boolean;
    completionReason: string;
  } | null {
    if (action === "kept_open" && guardedOpenStateVerified && commentMutationOccurred && !dryRun) {
      return {
        status: ACTION_EVENT_STATUSES.blocked,
        reasonCode: ACTION_EVENT_REASON_CODES.policyBlocked,
        retryable: false,
        mutation: true,
        completionReason: "publication_size_limit",
      };
    }
    if (action === "review_comment_synced" || action === "corrected_stale_canonical_comment") {
      if (!dryRun && !commentMutationOccurred) {
        return {
          status: ACTION_EVENT_STATUSES.unchanged,
          reasonCode: ACTION_EVENT_REASON_CODES.contentUnchanged,
          retryable: false,
          mutation: false,
          completionReason: "comment_unchanged",
        };
      }
      return {
        status: dryRun ? ACTION_EVENT_STATUSES.planned : ACTION_EVENT_STATUSES.published,
        reasonCode: dryRun ? ACTION_EVENT_REASON_CODES.dryRun : ACTION_EVENT_REASON_CODES.published,
        retryable: false,
        mutation: !dryRun && commentMutationOccurred,
        completionReason: dryRun ? "dry_run" : "comment_published",
      };
    }
    if (action === "skipped_comment_auth") {
      return {
        status: ACTION_EVENT_STATUSES.blocked,
        reasonCode: ACTION_EVENT_REASON_CODES.authorizationFailed,
        retryable: true,
        mutation: false,
        completionReason: "authorization_failed",
      };
    }
    if (action === "skipped_locked_conversation") {
      return {
        status: ACTION_EVENT_STATUSES.blocked,
        reasonCode: ACTION_EVENT_REASON_CODES.policyBlocked,
        retryable: false,
        mutation: false,
        completionReason: "locked_conversation",
      };
    }
    if (action === "retry_stale_canonical_comment_sync") {
      return {
        status: ACTION_EVENT_STATUSES.waiting,
        reasonCode: ACTION_EVENT_REASON_CODES.dependencyPending,
        retryable: true,
        mutation: false,
        completionReason: "retry_pending",
      };
    }
    if (action === "skipped_stale_review_comment_sync") {
      return {
        status: ACTION_EVENT_STATUSES.skipped,
        reasonCode: ACTION_EVENT_REASON_CODES.sourceChanged,
        retryable: true,
        mutation: false,
        completionReason: "source_changed",
      };
    }
    return null;
  }

  function recordApplyActionLedgerItemResults(options: {
    ledger: ApplyActionLedger;
    state: ApplyLedgerItem;
    results: readonly ApplyResult[];
    entry: ReportEntry;
    mutationOccurred: boolean;
    dryRun: boolean;
  }): void {
    if (options.state.terminal) return;
    const results =
      options.results.length > 0
        ? options.results
        : [
            {
              repo: options.state.businessIdentity.repository,
              number: options.state.businessIdentity.number,
              action: "kept_open" as const,
              reason: options.mutationOccurred
                ? "apply item completed after a durable mutation"
                : "apply item required no action",
            },
          ];
    for (const [resultIndex, result] of results.entries()) {
      const commentMutationOccurred = result.commentMutationOccurred === true;
      const disposition = applyActionEventDisposition(
        result.action,
        options.mutationOccurred,
        options.dryRun,
        commentMutationOccurred,
      );
      const commentDisposition = reviewCommentPublicationEventDisposition(
        result.action,
        commentMutationOccurred,
        options.dryRun,
        result.guardedOpenStateVerified === true,
      );
      const actionPhaseSeq = nextApplyPhaseSeq(options.ledger);
      const actionEvent = recordWorkflowPhaseEvent(root, {
        phase: ACTION_EVENT_TYPES.applyAction,
        status: disposition.status,
        reasonCode: disposition.reasonCode,
        retryable: disposition.retryable,
        mutation: disposition.mutation,
        identity: {
          slot: "apply_result",
          index: options.state.index,
          resultIndex,
          repository: options.state.businessIdentity.repository,
          number: options.state.businessIdentity.number,
        },
        operation: "apply",
        operationIdentity: options.ledger.operationIdentity,
        parentEventId: options.state.lastEventId ?? options.state.startEventId,
        phaseSeq: actionPhaseSeq,
        idempotencyIdentity: applyItemIdempotencyIdentity(options.state, "apply_item"),
        component: "apply_decisions",
        subject: applyLedgerItemSubject(options.state, options.entry),
        evidence: [
          ...workflowRunEvidence(),
          ...[actionLedgerFileEvidence("review_record", options.entry.path)].filter(
            (entry): entry is ActionEventEvidence => entry !== null,
          ),
        ],
        attributes: {
          batch_index: options.state.index,
          item_count: 1,
          closed_count: result.action === "closed" ? 1 : 0,
          skipped_count:
            result.action === "kept_open" ||
            result.action.startsWith("skipped_") ||
            result.action.startsWith("retry_")
              ? 1
              : 0,
          completion_reason: disposition.completionReason,
          partial: disposition.status === ACTION_EVENT_STATUSES.yielded,
        },
        privacy: actionLedgerPrivacy(),
      });
      options.state.lastEventId = actionEvent?.event_id ?? options.state.lastEventId;
      if (commentDisposition) {
        const commentPhaseSeq = nextApplyPhaseSeq(options.ledger);
        const commentEvent = recordWorkflowPhaseEvent(root, {
          phase: ACTION_EVENT_TYPES.reviewCommentPublication,
          status: commentDisposition.status,
          reasonCode: commentDisposition.reasonCode,
          retryable: commentDisposition.retryable,
          mutation: commentDisposition.mutation,
          identity: {
            slot: "review_comment_publication",
            index: options.state.index,
            resultIndex,
            repository: options.state.businessIdentity.repository,
            number: options.state.businessIdentity.number,
          },
          operation: "apply",
          operationIdentity: options.ledger.operationIdentity,
          parentEventId: options.state.lastEventId ?? options.state.startEventId,
          phaseSeq: commentPhaseSeq,
          idempotencyIdentity: applyItemIdempotencyIdentity(options.state, "review_comment"),
          component: "apply_decisions",
          subject: applyLedgerItemSubject(options.state, options.entry),
          evidence: workflowRunEvidence(),
          attributes: {
            publication_kind: "review_comment",
            comment_count: commentDisposition.mutation ? 1 : 0,
            completion_reason: commentDisposition.completionReason,
          },
          privacy: actionLedgerPrivacy(),
        });
        options.state.lastEventId = commentEvent?.event_id ?? options.state.lastEventId;
      }
    }
    options.state.terminal = true;
  }

  function recordApplyActionLedgerItemFailure(options: {
    ledger: ApplyActionLedger;
    state: ApplyLedgerItem;
    entry: ReportEntry;
    failure: unknown;
    mutationOccurred: boolean;
  }): void {
    if (options.state.terminal) return;
    const disposition = actionLedgerFailureDisposition(options.failure);
    const phaseSeq = nextApplyPhaseSeq(options.ledger);
    const event = recordWorkflowPhaseEvent(root, {
      phase: ACTION_EVENT_TYPES.applyAction,
      status: disposition.status,
      reasonCode: disposition.reasonCode,
      retryable: true,
      mutation: options.mutationOccurred,
      identity: {
        slot: "apply_in_flight_failure",
        index: options.state.index,
        repository: options.state.businessIdentity.repository,
        number: options.state.businessIdentity.number,
      },
      operation: "apply",
      operationIdentity: options.ledger.operationIdentity,
      parentEventId: options.state.lastEventId ?? options.state.startEventId,
      phaseSeq,
      idempotencyIdentity: applyItemIdempotencyIdentity(options.state, "apply_item"),
      component: "apply_decisions",
      subject: applyLedgerItemSubject(options.state, options.entry),
      evidence: workflowRunEvidence(),
      attributes: {
        failed_count: 1,
        partial: options.mutationOccurred,
        completion_reason: disposition.completionReason,
      },
      privacy: actionLedgerPrivacy(),
    });
    options.state.lastEventId = event?.event_id ?? options.state.lastEventId;
    options.state.terminal = true;
  }

  function recordApplyActionEvents(options: {
    ledger: ApplyActionLedger;
    results: readonly ApplyResult[];
    entries: ReadonlyMap<number, ReportEntry>;
    mutationByItem: ReadonlyMap<string, boolean>;
    dryRun: boolean;
    reportPath: string;
    failed?: boolean;
    failure?: unknown;
    inFlightItem?: { repo: string; number: number; mutationOccurred: boolean };
  }): void {
    if (options.ledger.terminal) return;
    const inFlightKey = options.inFlightItem ? actionLedgerItemKey(options.inFlightItem) : null;
    if (options.failed && options.inFlightItem && inFlightKey) {
      const state = options.ledger.items.get(inFlightKey);
      if (state?.started && !state.terminal) {
        const entry = options.entries.get(options.inFlightItem.number) ?? state.entry;
        recordApplyActionLedgerItemFailure({
          ledger: options.ledger,
          state,
          entry,
          failure: options.failure,
          mutationOccurred:
            options.inFlightItem.mutationOccurred ||
            state.mutationObserved ||
            state.uncertainMutationObserved,
        });
      }
    }
    for (const state of options.ledger.items.values()) {
      if (!state.started || state.terminal) continue;
      const repository = state.businessIdentity.repository;
      const number = state.businessIdentity.number;
      const itemResults = options.results.filter(
        (result) => (result.repo ?? targetRepo()) === repository && result.number === number,
      );
      const entry = options.entries.get(number) ?? state.entry;
      recordApplyActionLedgerItemResults({
        ledger: options.ledger,
        state,
        results: itemResults,
        entry,
        mutationOccurred:
          state.mutationObserved ||
          state.uncertainMutationObserved ||
          options.mutationByItem.get(`${repository}#${number}`) === true,
        dryRun: options.dryRun,
      });
    }
    for (const [index, result] of options.results.entries()) {
      if (result.number > 0) continue;
      const disposition = applyActionEventDisposition(result.action, false, options.dryRun);
      const phaseSeq = nextApplyPhaseSeq(options.ledger);
      recordWorkflowPhaseEvent(root, {
        phase: ACTION_EVENT_TYPES.applyAction,
        status: disposition.status,
        reasonCode: disposition.reasonCode,
        retryable: disposition.retryable,
        mutation: false,
        identity: {
          slot: "apply_result",
          index,
          repository: result.repo ?? targetRepo(),
          number: result.number,
        },
        operation: "apply",
        operationIdentity: options.ledger.operationIdentity,
        parentEventId: options.ledger.batchStartEventId,
        phaseSeq,
        idempotencyIdentity: {
          operationIdentity: options.ledger.operationIdentity,
          slot: "apply_workflow_result",
          action: result.action,
        },
        component: "apply_decisions",
        subject: {
          repository: result.repo ?? targetRepo(),
          kind: "workflow",
        },
        evidence: workflowRunEvidence(),
        attributes: {
          item_count: 0,
          completion_reason: disposition.completionReason,
          partial: disposition.status === ACTION_EVENT_STATUSES.yielded,
        },
        privacy: actionLedgerPrivacy(),
      });
    }
    const mutationCount = [...options.mutationByItem.values()].filter(Boolean).length;
    const closedCount = options.results.filter((result) => result.action === "closed").length;
    const skippedCount = options.results.filter(
      (result) =>
        result.action === "kept_open" ||
        result.action.startsWith("skipped_") ||
        result.action.startsWith("retry_"),
    ).length;
    const yielded = options.results.some((result) => result.action === "skipped_runtime_budget");
    const failure = options.failed ? actionLedgerFailureDisposition(options.failure) : null;
    const partial =
      yielded ||
      (options.failed === true &&
        (options.results.length > 0 || options.inFlightItem?.mutationOccurred === true));
    const batchStatus = failure
      ? failure.status
      : yielded
        ? ACTION_EVENT_STATUSES.yielded
        : options.dryRun
          ? ACTION_EVENT_STATUSES.planned
          : options.results.length === 0
            ? ACTION_EVENT_STATUSES.skipped
            : ACTION_EVENT_STATUSES.completed;
    const batchReason = failure
      ? failure.reasonCode
      : yielded
        ? ACTION_EVENT_REASON_CODES.runtimeBudget
        : options.dryRun
          ? ACTION_EVENT_REASON_CODES.dryRun
          : options.results.length === 0
            ? ACTION_EVENT_REASON_CODES.noChanges
            : ACTION_EVENT_REASON_CODES.completed;
    const batchTerminalPhaseSeq = nextApplyPhaseSeq(options.ledger);
    const batchTerminal = recordWorkflowPhaseEvent(root, {
      phase: ACTION_EVENT_TYPES.applyBatch,
      status: batchStatus,
      reasonCode: batchReason,
      retryable: Boolean(failure) || yielded,
      mutation: !options.dryRun && mutationCount > 0,
      identity: { slot: "apply_batch_terminal" },
      operation: "apply",
      operationIdentity: options.ledger.operationIdentity,
      parentEventId: options.ledger.batchStartEventId,
      phaseSeq: batchTerminalPhaseSeq,
      idempotencyIdentity: {
        operationIdentity: options.ledger.operationIdentity,
        slot: "apply_batch_terminal",
      },
      component: "apply_decisions",
      subject: {
        repository: targetRepo(),
        kind: "workflow",
      },
      evidence: workflowRunEvidence(),
      attributes: {
        result_count: options.results.length,
        processed_count: options.results.filter((result) => result.number > 0).length,
        closed_count: closedCount,
        skipped_count: skippedCount,
        failed_count: failure ? 1 : 0,
        action_count: mutationCount,
        duration_ms: Math.max(0, Date.now() - options.ledger.startedAtMs),
        partial,
        completion_reason: failure
          ? failure.completionReason
          : yielded
            ? "partial"
            : options.dryRun
              ? "dry_run"
              : options.results.length === 0
                ? "no_changes"
                : "completed",
      },
      privacy: actionLedgerPrivacy(),
    });
    // The apply report is a local workflow projection, so bind its contents
    // without claiming that its root-level compatibility path is durable state.
    const reportEvidence = actionLedgerFileDigestEvidence("apply_report", options.reportPath);
    const reportPublicationPhaseSeq = nextApplyPhaseSeq(options.ledger);
    recordWorkflowPhaseEvent(root, {
      phase: ACTION_EVENT_TYPES.applyPublish,
      status: reportEvidence ? ACTION_EVENT_STATUSES.completed : ACTION_EVENT_STATUSES.skipped,
      reasonCode: reportEvidence
        ? ACTION_EVENT_REASON_CODES.completed
        : ACTION_EVENT_REASON_CODES.notFound,
      retryable: !reportEvidence,
      mutation: false,
      identity: { slot: "apply_report_publication" },
      operation: "apply",
      operationIdentity: options.ledger.operationIdentity,
      parentEventId: batchTerminal?.event_id ?? options.ledger.batchStartEventId,
      phaseSeq: reportPublicationPhaseSeq,
      idempotencyIdentity: {
        operationIdentity: options.ledger.operationIdentity,
        slot: "apply_report_publication",
      },
      component: "apply_decisions",
      subject: {
        repository: targetRepo(),
        kind: "publication",
      },
      evidence: [...workflowRunEvidence(), ...(reportEvidence ? [reportEvidence] : [])],
      attributes: {
        publication_kind: "local_report",
        result_count: options.results.length,
        partial,
      },
      privacy: actionLedgerPrivacy(),
    });
    options.ledger.terminal = true;
  }

  return {
    applyActionEventDisposition,
    applyItemBusinessIdempotencyIdentityForTest,
    applyMutationBusinessIdempotencyIdentityForTest,
    applyPhaseSequenceForTest,
    applyRuntimeBudgetYieldResults,
    applyRuntimeBudgetYieldResultsForTest,
    finishApplyMutationAttempt,
    recordApplyActionEvents,
    recordApplyActionLedgerItemResults,
    recordApplyMutationBoundary,
    reviewCommentPublicationEventDisposition,
    startApplyActionLedger,
    startApplyActionLedgerItem,
    startApplyMutationAttempt,
  };
}
