import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  ACTION_EVENT_REASON_CODES,
  ACTION_EVENT_STATUSES,
  ACTION_EVENT_TYPES,
  type ActionEvent,
  type ActionEventEvidence,
  type ActionEventReasonCode,
  type ActionEventStatus,
  type ActionEventSubject,
} from "./action-ledger.js";
import { recordWorkflowPhaseEvent } from "./action-ledger-runtime.js";
import type {
  Item,
  MutationRunner,
  ReviewActionLedger,
  ReviewLedgerItem,
  ReviewMutationAttempt,
} from "./clawsweeper-types.js";

interface ReviewActionLedgerDependencies {
  root: string;
  targetRepo: () => string;
  repoRelativePath: (filePath: string) => string;
  sha256: (value: string) => string;
  isRuntimeBudgetError: (error: unknown) => boolean;
}

export function createReviewActionLedger({
  root,
  targetRepo,
  repoRelativePath,
  sha256,
  isRuntimeBudgetError,
}: ReviewActionLedgerDependencies) {
  const ACTION_LEDGER_DROPPED_FIELDS = [
    "body",
    "comments",
    "diff",
    "logs",
    "patch",
    "prompt",
  ] as const;

  function actionLedgerItemKey(item: Pick<Item, "repo" | "number">): string {
    return `${item.repo}#${item.number}`;
  }

  function actionLedgerPrivacy() {
    return {
      classification: "internal" as const,
      redactionVersion: "v1",
      fieldsDropped: ACTION_LEDGER_DROPPED_FIELDS,
    };
  }

  function workflowRunEvidence(): ActionEventEvidence[] {
    const repository = String(process.env.GITHUB_REPOSITORY ?? "").trim();
    const runId = String(process.env.GITHUB_RUN_ID ?? "").trim();
    if (
      !/^[a-z0-9_][a-z0-9_.-]*\/[a-z0-9_][a-z0-9_.-]*$/i.test(repository) ||
      !/^\d+$/.test(runId)
    ) {
      return [];
    }
    return [
      {
        kind: "workflow_run",
        runUrl: `https://github.com/${repository}/actions/runs/${runId}`,
      },
    ];
  }

  function actionLedgerFileEvidence(kind: string, filePath: string): ActionEventEvidence | null {
    if (!existsSync(filePath)) return null;
    const recordPath = repoRelativePath(filePath);
    return {
      kind,
      sha256: sha256(readFileSync(filePath, "utf8")),
      ...(recordPath.startsWith("../") ? {} : { reportPath: recordPath }),
    };
  }

  function actionLedgerFileDigestEvidence(
    kind: string,
    filePath: string,
  ): ActionEventEvidence | null {
    if (!existsSync(filePath)) return null;
    return {
      kind,
      sha256: sha256(readFileSync(filePath, "utf8")),
    };
  }

  function actionLedgerItemSubject(
    item: Item,
    options: { sourceRevision?: string; recordPath?: string } = {},
  ): ActionEventSubject {
    return {
      repository: item.repo,
      kind: item.kind,
      number: item.number,
      ...(options.sourceRevision ? { sourceRevision: options.sourceRevision } : {}),
      ...(options.recordPath && !options.recordPath.startsWith("../")
        ? { recordPath: options.recordPath }
        : {}),
    };
  }

  function startReviewActionLedger(options: {
    candidates: readonly Item[];
    reviewPolicy: string;
    shardIndex: number;
    shardCount: number;
    batchSize: number;
  }): ReviewActionLedger {
    const operationIdentity = {
      repository: targetRepo(),
      reviewPolicy: options.reviewPolicy,
      shardIndex: options.shardIndex,
      shardCount: options.shardCount,
      candidateSnapshots: options.candidates.map((item) => ({
        repository: item.repo,
        number: item.number,
        kind: item.kind,
        updatedAt: item.updatedAt,
      })),
    };
    const batchStart = recordWorkflowPhaseEvent(root, {
      phase: ACTION_EVENT_TYPES.reviewBatch,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      retryable: false,
      mutation: false,
      identity: { slot: "batch_start" },
      operation: "review",
      operationIdentity,
      phaseSeq: 1,
      idempotencyIdentity: { operationIdentity, slot: "batch_start" },
      component: "review",
      subject: {
        repository: targetRepo(),
        kind: "workflow",
      },
      evidence: workflowRunEvidence(),
      attributes: {
        candidate_count: options.candidates.length,
        batch_size: options.batchSize,
        shard_index: options.shardIndex,
        shard_count: options.shardCount,
        review_mode: "propose",
      },
      privacy: actionLedgerPrivacy(),
    });
    const items = new Map<string, ReviewLedgerItem>();
    for (const [index, item] of options.candidates.entries()) {
      if (!Number.isSafeInteger(item.number) || item.number <= 0) continue;
      items.set(actionLedgerItemKey(item), {
        item,
        index,
        started: false,
        startedAtMs: null,
        startEventId: null,
        lastEventId: null,
        logPublication: false,
        mutationAttemptCount: 0,
        mutationObserved: false,
        uncertainMutationObserved: false,
        terminal: false,
      });
    }
    return {
      operationIdentity,
      batchStartEventId: batchStart?.event_id ?? null,
      items,
      nextPhaseSeq: 2,
      mutationObserved: false,
      uncertainMutationObserved: false,
      startedAtMs: Date.now(),
      terminal: false,
    };
  }

  function nextReviewPhaseSeq(ledger: ReviewActionLedger): number {
    const phaseSeq = ledger.nextPhaseSeq;
    if (phaseSeq >= 1_000_000) {
      throw new Error("review action ledger exhausted per-item phase ordinals");
    }
    ledger.nextPhaseSeq += 1;
    return phaseSeq;
  }

  function startReviewActionLedgerItem(ledger: ReviewActionLedger, item: Item): ActionEvent | null {
    const state = ledger.items.get(actionLedgerItemKey(item));
    if (!state || state.started) return null;
    const phaseSeq = nextReviewPhaseSeq(ledger);
    const start = recordWorkflowPhaseEvent(root, {
      phase: ACTION_EVENT_TYPES.reviewItem,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      retryable: false,
      mutation: false,
      identity: {
        slot: "item_start",
        index: state.index,
        repository: item.repo,
        number: item.number,
      },
      operation: "review",
      operationIdentity: ledger.operationIdentity,
      parentEventId: ledger.batchStartEventId,
      phaseSeq,
      idempotencyIdentity: {
        operationIdentity: ledger.operationIdentity,
        slot: "item_start",
        index: state.index,
        repository: item.repo,
        number: item.number,
      },
      component: "review",
      subject: actionLedgerItemSubject(item),
      attributes: {
        batch_index: state.index,
        review_mode: "propose",
      },
      privacy: actionLedgerPrivacy(),
    });
    state.started = true;
    state.startedAtMs = Date.now();
    state.startEventId = start?.event_id ?? null;
    state.lastEventId = state.startEventId;
    return start;
  }

  function startReviewMutationAttempt(
    ledger: ReviewActionLedger,
    item: Item,
    receiptIdentity: string,
    idempotencyIdentity: string,
  ): ReviewMutationAttempt | null {
    let state = ledger.items.get(actionLedgerItemKey(item));
    if (!state) return null;
    if (!state.started) {
      startReviewActionLedgerItem(ledger, item);
      state = ledger.items.get(actionLedgerItemKey(item));
    }
    if (!state) return null;
    const mutationIndex = state.mutationAttemptCount;
    state.mutationAttemptCount += 1;
    const businessIdempotencyIdentity = {
      operation: "review" as const,
      slot: "coordination_mutation" as const,
      repository: item.repo,
      number: item.number,
      itemUpdatedAt: item.updatedAt,
      mutationIdentitySha256: sha256(idempotencyIdentity),
    };
    const receiptIdentitySha256 = sha256(receiptIdentity);
    const attempt = recordWorkflowPhaseEvent(root, {
      phase: ACTION_EVENT_TYPES.reviewItem,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      retryable: true,
      mutation: false,
      identity: {
        slot: "review_coordination_mutation_attempt",
        index: state.index,
        mutationIndex,
        receiptIdentitySha256,
        repository: item.repo,
        number: item.number,
      },
      operation: "review",
      operationIdentity: ledger.operationIdentity,
      parentEventId: state.lastEventId ?? state.startEventId,
      phaseSeq: nextReviewPhaseSeq(ledger),
      idempotencyIdentity: businessIdempotencyIdentity,
      component: "review",
      subject: actionLedgerItemSubject(item),
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

  function finishReviewMutationAttempt(options: {
    ledger: ReviewActionLedger;
    item: Item;
    attempt: ReviewMutationAttempt;
    outcome: "accepted" | "rejected" | "unknown";
  }): string | null {
    const mutation = options.outcome !== "rejected";
    const event = recordWorkflowPhaseEvent(root, {
      phase: ACTION_EVENT_TYPES.reviewItem,
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
        slot: "review_coordination_mutation_outcome",
        index: options.attempt.state.index,
        mutationIndex: options.attempt.mutationIndex,
        receiptIdentitySha256: options.attempt.receiptIdentitySha256,
        outcome: options.outcome,
        repository: options.item.repo,
        number: options.item.number,
      },
      operation: "review",
      operationIdentity: options.ledger.operationIdentity,
      parentEventId: options.attempt.eventId,
      phaseSeq: nextReviewPhaseSeq(options.ledger),
      idempotencyIdentity: options.attempt.idempotencyIdentity,
      component: "review",
      subject: actionLedgerItemSubject(options.item),
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
      options.attempt.state.mutationObserved = true;
      options.ledger.mutationObserved = true;
    }
    if (options.outcome === "unknown") {
      options.attempt.state.uncertainMutationObserved = true;
      options.ledger.uncertainMutationObserved = true;
    }
    return event?.event_id ?? null;
  }

  function reviewMutationRunner(ledger: ReviewActionLedger, item: Item): MutationRunner {
    return <T>(options: {
      identity: string;
      idempotencyIdentity: string;
      operation: () => T;
      didMutate?: ((result: T) => boolean) | undefined;
      knownNoMutation?: ((error: unknown) => boolean) | undefined;
    }): T => {
      const attempt = startReviewMutationAttempt(
        ledger,
        item,
        options.identity,
        options.idempotencyIdentity,
      );
      if (!attempt) return options.operation();
      try {
        const result = options.operation();
        finishReviewMutationAttempt({
          ledger,
          item,
          attempt,
          outcome: options.didMutate?.(result) === false ? "rejected" : "accepted",
        });
        return result;
      } catch (error) {
        finishReviewMutationAttempt({
          ledger,
          item,
          attempt,
          outcome: options.knownNoMutation?.(error) === true ? "rejected" : "unknown",
        });
        throw error;
      }
    };
  }

  function recordReviewLogPublication(options: {
    ledger: ReviewActionLedger;
    item: Item;
    codexWorkDir?: string;
    cached: boolean;
    missingStatus?: ActionEventStatus;
    missingReasonCode?: ActionEventReasonCode;
    retryable?: boolean;
  }): ActionEvent | null {
    const state = options.ledger.items.get(actionLedgerItemKey(options.item));
    if (!state || !state.started || state.logPublication) return null;
    const prefix = `${options.item.number}.`;
    const logs =
      options.codexWorkDir && existsSync(options.codexWorkDir)
        ? readdirSync(options.codexWorkDir)
            .filter(
              (name) =>
                name.startsWith(prefix) &&
                (name.endsWith(".codex.stdout.log") || name.endsWith(".codex.stderr.log")),
            )
            .sort()
            .slice(0, 64)
            .map((name) =>
              actionLedgerFileEvidence("review_log", join(options.codexWorkDir!, name)),
            )
            .filter((entry): entry is ActionEventEvidence => entry !== null)
        : [];
    const captured = logs.length > 0;
    const phaseSeq = nextReviewPhaseSeq(options.ledger);
    const event = recordWorkflowPhaseEvent(root, {
      phase: ACTION_EVENT_TYPES.reviewLogPublication,
      status: captured
        ? ACTION_EVENT_STATUSES.completed
        : (options.missingStatus ?? ACTION_EVENT_STATUSES.skipped),
      reasonCode: captured
        ? ACTION_EVENT_REASON_CODES.completed
        : (options.missingReasonCode ??
          (options.cached
            ? ACTION_EVENT_REASON_CODES.notApplicable
            : ACTION_EVENT_REASON_CODES.notFound)),
      retryable: captured ? false : (options.retryable ?? false),
      mutation: false,
      identity: {
        slot: "review_logs",
        index: state.index,
        repository: options.item.repo,
        number: options.item.number,
      },
      operation: "review",
      operationIdentity: options.ledger.operationIdentity,
      parentEventId: state.lastEventId ?? state.startEventId,
      phaseSeq,
      idempotencyIdentity: {
        operationIdentity: options.ledger.operationIdentity,
        slot: "review_logs",
        index: state.index,
        repository: options.item.repo,
        number: options.item.number,
      },
      component: "review",
      subject: actionLedgerItemSubject(options.item),
      evidence: [...workflowRunEvidence(), ...logs],
      attributes: {
        cached: options.cached,
        log_count: logs.length,
        log_kind: "codex",
        publication_kind: "local_artifact",
      },
      privacy: actionLedgerPrivacy(),
    });
    state.logPublication = true;
    state.lastEventId = event?.event_id ?? state.lastEventId;
    return event;
  }

  function finishReviewActionLedgerItem(options: {
    ledger: ReviewActionLedger;
    item: Item;
    status: ActionEventStatus;
    reasonCode: ActionEventReasonCode;
    retryable: boolean;
    cached: boolean;
    startedAtMs: number;
    sourceRevision?: string;
    reportPath?: string;
    findingCount?: number;
    completionReason?: string;
  }): ActionEvent | null {
    const state = options.ledger.items.get(actionLedgerItemKey(options.item));
    if (!state || !state.started || state.terminal) return null;
    if (!state.logPublication) {
      recordReviewLogPublication({
        ledger: options.ledger,
        item: options.item,
        cached: options.cached,
        missingStatus:
          options.status === ACTION_EVENT_STATUSES.completed ||
          options.status === ACTION_EVENT_STATUSES.cached
            ? ACTION_EVENT_STATUSES.skipped
            : options.status,
        missingReasonCode:
          options.status === ACTION_EVENT_STATUSES.completed ||
          options.status === ACTION_EVENT_STATUSES.cached
            ? options.cached
              ? ACTION_EVENT_REASON_CODES.notApplicable
              : ACTION_EVENT_REASON_CODES.notFound
            : options.reasonCode,
        retryable: options.retryable,
      });
    }
    const reportPath = options.reportPath ? repoRelativePath(options.reportPath) : undefined;
    const reportEvidence = options.reportPath
      ? actionLedgerFileEvidence("review_record", options.reportPath)
      : null;
    const phaseSeq = nextReviewPhaseSeq(options.ledger);
    const terminal = recordWorkflowPhaseEvent(root, {
      phase: ACTION_EVENT_TYPES.reviewItem,
      status: options.status,
      reasonCode: options.reasonCode,
      retryable: options.retryable && !state.uncertainMutationObserved,
      mutation: state.mutationObserved,
      identity: {
        slot: "item_terminal",
        index: state.index,
        repository: options.item.repo,
        number: options.item.number,
      },
      operation: "review",
      operationIdentity: options.ledger.operationIdentity,
      parentEventId: state.lastEventId ?? state.startEventId,
      phaseSeq,
      idempotencyIdentity: {
        operationIdentity: options.ledger.operationIdentity,
        slot: "item_terminal",
        index: state.index,
        repository: options.item.repo,
        number: options.item.number,
      },
      component: "review",
      subject: actionLedgerItemSubject(options.item, {
        ...(options.sourceRevision ? { sourceRevision: options.sourceRevision } : {}),
        ...(reportPath ? { recordPath: reportPath } : {}),
      }),
      evidence: [...workflowRunEvidence(), ...(reportEvidence ? [reportEvidence] : [])],
      attributes: {
        cached: options.cached,
        duration_ms: Math.max(0, Date.now() - options.startedAtMs),
        review_mode: "propose",
        ...(options.findingCount === undefined ? {} : { finding_count: options.findingCount }),
        ...(options.completionReason ? { completion_reason: options.completionReason } : {}),
      },
      privacy: actionLedgerPrivacy(),
    });
    state.terminal = true;
    state.lastEventId = terminal?.event_id ?? state.lastEventId;
    return terminal;
  }

  function actionLedgerFailureDisposition(error: unknown): {
    status: ActionEventStatus;
    reasonCode: ActionEventReasonCode;
    completionReason: string;
  } {
    const message = error instanceof Error ? error.message : String(error);
    if (isRuntimeBudgetError(error)) {
      return {
        status: ACTION_EVENT_STATUSES.yielded,
        reasonCode: ACTION_EVENT_REASON_CODES.runtimeBudget,
        completionReason: "runtime_budget",
      };
    }
    if (/timed?\s*out|timeout|etimedout|sigterm|signal 15/i.test(message)) {
      return {
        status: ACTION_EVENT_STATUSES.failed,
        reasonCode: ACTION_EVENT_REASON_CODES.timeout,
        completionReason: "timeout",
      };
    }
    if (/cancelled|canceled|interrupted|sigint|signal 2/i.test(message)) {
      return {
        status: ACTION_EVENT_STATUSES.cancelled,
        reasonCode: ACTION_EVENT_REASON_CODES.cancelled,
        completionReason: "interrupted",
      };
    }
    return {
      status: ACTION_EVENT_STATUSES.failed,
      reasonCode: ACTION_EVENT_REASON_CODES.exception,
      completionReason: "failed",
    };
  }

  function finishReviewActionLedger(options: {
    ledger: ReviewActionLedger;
    error?: unknown;
    activeItem?: Item | null;
    completedCount: number;
    cacheHits: number;
  }): void {
    if (options.ledger.terminal) return;
    const failure =
      options.error === undefined ? null : actionLedgerFailureDisposition(options.error);
    let pendingCount = 0;
    for (const state of options.ledger.items.values()) {
      if (state.terminal) continue;
      pendingCount += 1;
      if (!state.started) continue;
      const active = options.activeItem
        ? actionLedgerItemKey(options.activeItem) === actionLedgerItemKey(state.item)
        : false;
      finishReviewActionLedgerItem({
        ledger: options.ledger,
        item: state.item,
        status: failure
          ? active
            ? failure.status
            : ACTION_EVENT_STATUSES.cancelled
          : ACTION_EVENT_STATUSES.blocked,
        reasonCode: failure
          ? active
            ? failure.reasonCode
            : ACTION_EVENT_REASON_CODES.workerLost
          : ACTION_EVENT_REASON_CODES.leaseActive,
        retryable: true,
        cached: false,
        startedAtMs: options.ledger.startedAtMs,
        completionReason: failure
          ? active
            ? failure.completionReason
            : "interrupted"
          : "coordination_blocked",
      });
    }
    const itemCount = options.ledger.items.size;
    const partial = pendingCount > 0 || options.completedCount < itemCount;
    const status = failure
      ? failure.status
      : partial
        ? ACTION_EVENT_STATUSES.yielded
        : ACTION_EVENT_STATUSES.completed;
    const reasonCode = failure
      ? failure.reasonCode
      : partial
        ? ACTION_EVENT_REASON_CODES.leaseActive
        : ACTION_EVENT_REASON_CODES.completed;
    recordWorkflowPhaseEvent(root, {
      phase: ACTION_EVENT_TYPES.reviewBatch,
      status,
      reasonCode,
      retryable: (failure !== null || partial) && !options.ledger.uncertainMutationObserved,
      mutation: options.ledger.mutationObserved,
      identity: { slot: "batch_terminal" },
      operation: "review",
      operationIdentity: options.ledger.operationIdentity,
      parentEventId: options.ledger.batchStartEventId,
      phaseSeq: 1_000_000,
      idempotencyIdentity: {
        operationIdentity: options.ledger.operationIdentity,
        slot: "batch_terminal",
      },
      component: "review",
      subject: {
        repository: targetRepo(),
        kind: "workflow",
      },
      evidence: workflowRunEvidence(),
      attributes: {
        candidate_count: itemCount,
        processed_count: options.completedCount,
        skipped_count: pendingCount,
        failed_count: failure ? 1 : 0,
        duration_ms: Math.max(0, Date.now() - options.ledger.startedAtMs),
        cached: options.cacheHits > 0,
        partial,
        completion_reason: failure ? failure.completionReason : partial ? "partial" : "completed",
        review_mode: "propose",
      },
      privacy: actionLedgerPrivacy(),
    });
    options.ledger.terminal = true;
  }

  return {
    actionLedgerFailureDisposition,
    actionLedgerFileDigestEvidence,
    actionLedgerFileEvidence,
    actionLedgerItemKey,
    actionLedgerItemSubject,
    actionLedgerPrivacy,
    finishReviewActionLedger,
    finishReviewActionLedgerItem,
    recordReviewLogPublication,
    reviewMutationRunner,
    startReviewActionLedger,
    startReviewActionLedgerItem,
    workflowRunEvidence,
  };
}
