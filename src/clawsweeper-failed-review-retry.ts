import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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
import { boolArg, itemNumbersArg, numberArg, stringArg, type Args } from "./clawsweeper-args.js";
import { DEFAULT_REVIEW_CODEX_TIMEOUT_MS } from "./clawsweeper-policy.js";
import type { createReviewActionLedger } from "./clawsweeper-review-ledger.js";
import type {
  FailedReviewRetryAction,
  FailedReviewRetryResult,
  FailedReviewRetryRevision,
  FailedReviewRetryRevisionKind,
  FailedReviewRetryState,
  FailedReviewRetryStatus,
  GitHubDispatchOutcome,
  GitHubRuntimeBudget,
  Item,
  ItemKind,
  ReviewRetryActionLedger,
} from "./clawsweeper-types.js";
import { UserFacingCommandError } from "./command.js";
import type { RepositoryProfile } from "./repository-profiles.js";

type RetryRuntimeBudgetError = Error & { reason: string };
type RetryDispatchError = Error & {
  outcome: Exclude<GitHubDispatchOutcome, "accepted">;
  cause: unknown;
};

interface FailedReviewRetryDependencies {
  root: string;
  appendSectionValue: (markdown: string, heading: string, value: string) => string;
  codexFailureReason: (detail: string) => string;
  defaultItemsDir: () => string;
  effectiveReviewStatus: (markdown: string) => string;
  ensureDir: (directory: string) => void;
  ensureGitHubRuntimeAvailable: (phase: string) => void;
  failedReviewFailureDetail: (markdown: string) => string;
  failedReviewRetryEligibility: (options: {
    markdown: string;
    liveState: string;
    liveLocked?: boolean;
    liveActiveLockReason?: string | null;
    liveHeadSha?: string | null;
    liveSourceRevision?: string | null;
    now: number;
    maxAttempts: number;
    cooldownMs: number;
  }) => FailedReviewRetryResult;
  failedReviewRetryResultRevision: (revision: FailedReviewRetryRevision) => {
    headSha?: string;
    revisionKind: FailedReviewRetryRevisionKind;
    revision: string;
  };
  failedReviewRetryRevisionForReport: (markdown: string) => FailedReviewRetryRevision | null;
  fetchItem: (number: number) => { item: Item; state: string };
  frontMatterValue: (markdown: string, key: string) => string | undefined;
  ghRawOnceWithCheckpoint: (
    args: string[],
    onBeforeRun: () => void,
  ) => { outcome: "accepted"; output: string };
  ghWithRetry: (args: string[]) => string;
  isDispatchError: (error: unknown) => error is RetryDispatchError;
  isFailedReviewRetryAlreadyExhausted: (
    markdown: string,
    revision: FailedReviewRetryRevision,
  ) => boolean;
  isMarkdownForActiveRepo: (markdown: string, file?: string) => boolean;
  isRuntimeBudgetError: (error: unknown) => error is RetryRuntimeBudgetError;
  liveIssueSourceRevision: (number: number) => string;
  livePullHeadSha: (number: number) => string | null;
  lockedConversationApplyReason: (item: Pick<Item, "activeLockReason" | "locked">) => string | null;
  markdownFiles: (directory: string) => string[];
  numberForMarkdownFile: (file: string) => number;
  replaceFrontMatterValue: (markdown: string, key: string, value: string) => string;
  replaceSectionValue: (markdown: string, heading: string, value: string) => string;
  repoFromArgs: (args: Args) => RepositoryProfile;
  repoRelativePath: (filePath: string) => string;
  reportItemKind: (markdown: string) => ItemKind | undefined;
  reviewLeaseRevisionFromReport: (markdown: string) => string | null;
  reviewLedger: ReturnType<typeof createReviewActionLedger>;
  sameFailedReviewRetryRevision: (
    left: FailedReviewRetryRevision,
    right: FailedReviewRetryRevision,
  ) => boolean;
  sectionValue: (markdown: string, heading: string) => string;
  storedFailedReviewRetryRevision: (markdown: string) => FailedReviewRetryRevision | null;
  targetRepo: () => string;
  withGitHubRuntimeBudget: <T>(budget: GitHubRuntimeBudget, operation: () => T) => T;
}

export function createFailedReviewRetryWorkflow({
  root,
  appendSectionValue,
  codexFailureReason,
  defaultItemsDir,
  effectiveReviewStatus,
  ensureDir,
  ensureGitHubRuntimeAvailable,
  failedReviewFailureDetail,
  failedReviewRetryEligibility,
  failedReviewRetryResultRevision,
  failedReviewRetryRevisionForReport,
  fetchItem,
  frontMatterValue,
  ghRawOnceWithCheckpoint,
  ghWithRetry,
  isDispatchError,
  isFailedReviewRetryAlreadyExhausted,
  isMarkdownForActiveRepo,
  isRuntimeBudgetError,
  liveIssueSourceRevision,
  livePullHeadSha,
  lockedConversationApplyReason,
  markdownFiles,
  numberForMarkdownFile,
  replaceFrontMatterValue,
  replaceSectionValue,
  repoFromArgs,
  repoRelativePath,
  reportItemKind,
  reviewLeaseRevisionFromReport,
  reviewLedger,
  sameFailedReviewRetryRevision,
  sectionValue,
  storedFailedReviewRetryRevision,
  targetRepo,
  withGitHubRuntimeBudget,
}: FailedReviewRetryDependencies) {
  const {
    actionLedgerFailureDisposition,
    actionLedgerFileEvidence,
    actionLedgerPrivacy,
    workflowRunEvidence,
  } = reviewLedger;
  function failedReviewRetryRevisionLabel(revision: FailedReviewRetryRevision): string {
    return revision.kind === "pull_head_sha" ? "head SHA" : "issue source revision";
  }

  function failedReviewRetryPrompt(options: {
    number: number;
    revision: FailedReviewRetryRevision;
    reason: string;
    attempts: number;
    maxAttempts: number;
  }): string {
    return [
      "[clawsweeper-failed-review-retry=1]",
      "",
      "This is a bounded exact-item retry for a prior Codex timeout or infrastructure failure.",
      `Retry item: #${options.number}`,
      `Failed report ${failedReviewRetryRevisionLabel(options.revision)}: ${options.revision.value}`,
      `Prior failure: ${options.reason}`,
      `Retry attempt: ${options.attempts + 1}/${options.maxAttempts}`,
      "",
      "Produce a normal fresh review from the live item and checkout context.",
      "Do not infer any verdict from the failed review artifact; use it only as retry context.",
    ].join("\n");
  }

  function failedReviewRetrySection(options: {
    status: FailedReviewRetryStatus;
    at: string;
    revision: FailedReviewRetryRevision;
    attempts: number;
    maxAttempts: number;
    reason: string;
    dispatchUrl?: string;
  }): string {
    const lines = [
      `- status: ${options.status}`,
      `- recorded at: ${options.at}`,
      `- ${failedReviewRetryRevisionLabel(options.revision)}: ${options.revision.value}`,
      `- attempts: ${options.attempts}/${options.maxAttempts}`,
      `- reason: ${options.reason}`,
    ];
    if (options.dispatchUrl) lines.push(`- retry run: ${options.dispatchUrl}`);
    if (options.status === "exhausted") {
      lines.push(
        "- next step: needs human review; retry attempts for this exact revision are exhausted.",
      );
    } else if (options.status === "dispatching") {
      lines.push(
        "- next step: dispatch outcome is uncertain; reconcile the workflow run before another retry.",
      );
    } else if (options.status === "dispatch_failed") {
      lines.push(
        "- next step: dispatch command failed; retry after the cooldown if still eligible.",
      );
    }
    return lines.join("\n");
  }

  function checkpointFailedReviewRetry(options: {
    markdown: string;
    status: FailedReviewRetryStatus;
    at: string;
    revision: FailedReviewRetryRevision;
    attempts: number;
    maxAttempts: number;
    reason: string;
    dispatchUrl?: string;
  }): string {
    let next = options.markdown;
    next = replaceFrontMatterValue(next, "failed_review_retry_status", options.status);
    next = replaceFrontMatterValue(next, "failed_review_retry_count", String(options.attempts));
    next = replaceFrontMatterValue(next, "failed_review_retry_last_at", options.at);
    next = replaceFrontMatterValue(
      next,
      "failed_review_retry_revision_kind",
      options.revision.kind,
    );
    next = replaceFrontMatterValue(next, "failed_review_retry_revision", options.revision.value);
    if (options.revision.kind === "pull_head_sha") {
      next = replaceFrontMatterValue(next, "failed_review_retry_head_sha", options.revision.value);
    }
    next = replaceFrontMatterValue(
      next,
      "failed_review_retry_reason",
      JSON.stringify(options.reason),
    );
    if (options.dispatchUrl) {
      next = replaceFrontMatterValue(next, "failed_review_retry_dispatch_url", options.dispatchUrl);
    }
    return next;
  }

  function markFailedReviewRetry(options: {
    markdown: string;
    status: FailedReviewRetryStatus;
    at: string;
    revision: FailedReviewRetryRevision;
    attempts: number;
    maxAttempts: number;
    reason: string;
    dispatchUrl?: string;
  }): string {
    const next = checkpointFailedReviewRetry(options);
    return appendSectionValue(next, "Failed Review Retry", failedReviewRetrySection(options));
  }

  function failedReviewRetryStatePath(stateDir: string, number: number): string {
    return join(stateDir, `${number}.json`);
  }

  function readFailedReviewRetryState(path: string): FailedReviewRetryState | null {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<FailedReviewRetryState>;
    const validStatus =
      parsed.status === "dispatching" ||
      parsed.status === "dispatched" ||
      parsed.status === "dispatch_failed" ||
      parsed.status === "exhausted";
    if (
      parsed.schema_version !== 1 ||
      typeof parsed.repo !== "string" ||
      !Number.isInteger(parsed.number) ||
      !validStatus ||
      (parsed.revision_kind !== "pull_head_sha" &&
        parsed.revision_kind !== "item_source_revision") ||
      typeof parsed.revision !== "string" ||
      !Number.isInteger(parsed.attempts) ||
      !Number.isInteger(parsed.max_attempts) ||
      typeof parsed.last_at !== "string" ||
      typeof parsed.reason !== "string"
    ) {
      throw new Error(`Invalid failed-review retry state: ${path}`);
    }
    return parsed as FailedReviewRetryState;
  }

  function failedReviewRetryMarkdownWithState(
    markdown: string,
    state: FailedReviewRetryState | null,
  ): string {
    const reportNumber = Number(frontMatterValue(markdown, "number") ?? 0);
    if (!state || state.repo !== targetRepo() || state.number !== reportNumber) return markdown;
    const reportRevision = failedReviewRetryRevisionForReport(markdown);
    const stateRevision: FailedReviewRetryRevision = {
      kind: state.revision_kind,
      value: state.revision,
    };
    if (!reportRevision || !sameFailedReviewRetryRevision(reportRevision, stateRevision)) {
      return markdown;
    }
    return checkpointFailedReviewRetry({
      markdown,
      status: state.status,
      at: state.last_at,
      revision: stateRevision,
      attempts: state.attempts,
      maxAttempts: state.max_attempts,
      reason: state.reason,
      ...(state.dispatch_url ? { dispatchUrl: state.dispatch_url } : {}),
    });
  }

  function writeFailedReviewRetryState(
    path: string,
    options: {
      number: number;
      status: FailedReviewRetryStatus;
      at: string;
      revision: FailedReviewRetryRevision;
      attempts: number;
      maxAttempts: number;
      reason: string;
      dispatchUrl?: string;
    },
  ): void {
    const state: FailedReviewRetryState = {
      schema_version: 1,
      repo: targetRepo(),
      number: options.number,
      status: options.status,
      revision_kind: options.revision.kind,
      revision: options.revision.value,
      attempts: options.attempts,
      max_attempts: options.maxAttempts,
      last_at: options.at,
      reason: options.reason,
      ...(options.dispatchUrl ? { dispatch_url: options.dispatchUrl } : {}),
    };
    ensureDir(dirname(path));
    const temporaryPath = join(
      dirname(path),
      `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      renameSync(temporaryPath, path);
    } finally {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    }
  }

  const FAILED_REVIEW_RETRY_METADATA_KEYS = [
    "failed_review_retry_status",
    "failed_review_retry_count",
    "failed_review_retry_last_at",
    "failed_review_retry_revision_kind",
    "failed_review_retry_revision",
    "failed_review_retry_head_sha",
    "failed_review_retry_reason",
    "failed_review_retry_dispatch_url",
  ] as const;

  function preserveFailedReviewRetryMetadataForTest(
    previousMarkdown: string,
    incomingMarkdown: string,
  ): string {
    return preserveFailedReviewRetryMetadata(previousMarkdown, incomingMarkdown);
  }

  function preserveFailedReviewRetryMetadata(
    previousMarkdown: string,
    incomingMarkdown: string,
  ): string {
    if (effectiveReviewStatus(incomingMarkdown) !== "failed") return incomingMarkdown;
    const previousRevision = storedFailedReviewRetryRevision(previousMarkdown);
    const incomingRevision = failedReviewRetryRevisionForReport(incomingMarkdown);
    if (
      !previousRevision ||
      !incomingRevision ||
      !sameFailedReviewRetryRevision(previousRevision, incomingRevision)
    ) {
      return incomingMarkdown;
    }

    let next = incomingMarkdown;
    for (const key of FAILED_REVIEW_RETRY_METADATA_KEYS) {
      const value = frontMatterValue(previousMarkdown, key);
      if (value) next = replaceFrontMatterValue(next, key, value);
    }
    const retrySection = sectionValue(previousMarkdown, "Failed Review Retry");
    if (retrySection) next = replaceSectionValue(next, "Failed Review Retry", retrySection);
    return next;
  }

  function dispatchFailedReviewRetry(options: {
    workflowRepo: string;
    workflowRef: string;
    targetRepo: string;
    number: number;
    revision: FailedReviewRetryRevision;
    reason: string;
    attempts: number;
    maxAttempts: number;
    codexTimeoutMs: number;
    onBeforeDispatch?: (dispatchUrl: string) => void;
  }): string {
    const prompt = failedReviewRetryPrompt({
      number: options.number,
      revision: options.revision,
      reason: options.reason,
      attempts: options.attempts,
      maxAttempts: options.maxAttempts,
    });
    if (options.revision.kind === "item_source_revision") {
      const workflowDefaultBranch = ghWithRetry([
        "api",
        `repos/${options.workflowRepo}`,
        "--jq",
        ".default_branch // empty",
      ]).trim();
      if (!workflowDefaultBranch) {
        throw new UserFacingCommandError(
          `Could not resolve the default branch for ${options.workflowRepo}.`,
        );
      }
      if (options.workflowRef !== workflowDefaultBranch) {
        throw new UserFacingCommandError(
          `Issue retry repository dispatch requires the workflow repository default branch (${workflowDefaultBranch}); got --workflow-ref ${options.workflowRef}.`,
        );
      }
      const dispatchUrl = `https://github.com/${options.workflowRepo}/actions/workflows/sweep.yml`;
      const dispatch = ghRawOnceWithCheckpoint(
        [
          "api",
          "--method",
          "POST",
          `repos/${options.workflowRepo}/dispatches`,
          "-f",
          "event_type=clawsweeper_target_sweep",
          "-f",
          `client_payload[target_repo]=${options.targetRepo}`,
          "-f",
          "client_payload[target_branch]=main",
          "-f",
          "client_payload[batch_size]=1",
          "-f",
          "client_payload[shard_count]=1",
          "-f",
          "client_payload[hot_intake]=false",
          "-f",
          `client_payload[codex_timeout_ms]=${options.codexTimeoutMs}`,
          "-f",
          `client_payload[item_number]=${options.number}`,
          "-f",
          `client_payload[additional_prompt]=${prompt}`,
          "-f",
          `client_payload[expected_source_revision]=${options.revision.value}`,
          "-f",
          "client_payload[source_revision_requeue_count]=0",
        ],
        () => options.onBeforeDispatch?.(dispatchUrl),
      );
      if (dispatch.outcome !== "accepted") throw new Error("GitHub dispatch was not accepted");
      return dispatchUrl;
    }
    const dispatchUrl = `https://github.com/${options.workflowRepo}/actions/workflows/sweep.yml`;
    const dispatch = ghRawOnceWithCheckpoint(
      [
        "workflow",
        "run",
        "sweep.yml",
        "--repo",
        options.workflowRepo,
        "--ref",
        options.workflowRef,
        "-f",
        "apply_existing=false",
        "-f",
        "hot_intake=false",
        "-f",
        `target_repo=${options.targetRepo}`,
        "-f",
        "batch_size=1",
        "-f",
        "shard_count=1",
        "-f",
        `codex_timeout_ms=${options.codexTimeoutMs}`,
        "-f",
        `item_number=${options.number}`,
        "-f",
        `additional_prompt=${prompt}`,
      ],
      () => options.onBeforeDispatch?.(dispatchUrl),
    );
    if (dispatch.outcome !== "accepted") throw new Error("GitHub dispatch was not accepted");
    return dispatchUrl;
  }

  function startFailedReviewRetryLedger(options: {
    requestedItemNumbers: readonly number[];
    reportPath: string;
  }): ReviewRetryActionLedger {
    const operationIdentity = {
      repository: targetRepo(),
      requestedItemNumbers: [...options.requestedItemNumbers],
      reportPath: repoRelativePath(options.reportPath),
    };
    const batchStart = recordWorkflowPhaseEvent(root, {
      phase: ACTION_EVENT_TYPES.reviewRetry,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      retryable: false,
      mutation: false,
      identity: { slot: "retry_batch_start" },
      operation: "review_retry",
      operationIdentity,
      phaseSeq: 1,
      idempotencyIdentity: { operationIdentity, slot: "retry_batch_start" },
      component: "retry_failed_reviews",
      subject: {
        repository: targetRepo(),
        kind: "workflow",
      },
      evidence: workflowRunEvidence(),
      attributes: {
        candidate_count: options.requestedItemNumbers.length,
      },
      privacy: actionLedgerPrivacy(),
    });
    return {
      operationIdentity,
      batchStartEventId: batchStart?.event_id ?? null,
      dispatchAttempts: new Map(),
      nextDispatchPhaseSeq: 100_000,
      startedAtMs: Date.now(),
      terminal: false,
    };
  }

  function reviewRetryDispatchAttemptKey(options: {
    repository: string;
    number: number;
    revision: FailedReviewRetryRevision;
  }): string {
    return `${options.repository}#${options.number}:${options.revision.kind}:${options.revision.value}`;
  }

  function startFailedReviewRetryDispatchAttempt(options: {
    ledger: ReviewRetryActionLedger;
    number: number;
    revision: FailedReviewRetryRevision;
    reportPath: string;
    attempts: number;
  }): void {
    const repository = targetRepo();
    const key = reviewRetryDispatchAttemptKey({
      repository,
      number: options.number,
      revision: options.revision,
    });
    if (options.ledger.dispatchAttempts.has(key)) return;
    const phaseSeq = options.ledger.nextDispatchPhaseSeq;
    options.ledger.nextDispatchPhaseSeq += 10;
    const reportMarkdown = readFileSync(options.reportPath, "utf8");
    const kind = reportItemKind(reportMarkdown);
    if (!kind) {
      throw new Error(
        `retry dispatch receipt for ${repository}#${options.number} is missing its item kind`,
      );
    }
    const recordPath = repoRelativePath(options.reportPath);
    const event = recordWorkflowPhaseEvent(root, {
      phase: ACTION_EVENT_TYPES.reviewRetry,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      retryable: false,
      mutation: false,
      identity: {
        slot: "retry_dispatch_attempt",
        repository,
        number: options.number,
      },
      operation: "review_retry",
      operationIdentity: options.ledger.operationIdentity,
      parentEventId: options.ledger.batchStartEventId,
      phaseSeq,
      idempotencyIdentity: reviewRetryBusinessIdempotencyIdentityForTest({
        repository,
        number: options.number,
        revisionKind: options.revision.kind,
        sourceRevision: options.revision.value,
        reviewContentDigest: frontMatterValue(reportMarkdown, "review_content_digest") ?? "unknown",
        decisionPacketSha256: frontMatterValue(reportMarkdown, "decision_packet_sha256") ?? "none",
        slot: "retry_dispatch",
      }),
      component: "retry_failed_reviews",
      subject: {
        repository,
        kind,
        number: options.number,
        sourceRevision: options.revision.value,
        ...(recordPath.startsWith("../") ? {} : { recordPath }),
      },
      evidence: workflowRunEvidence(),
      attributes: {
        attempt: options.attempts + 1,
        retry_count: options.attempts,
        completion_reason: "dispatch_attempted",
      },
      privacy: actionLedgerPrivacy(),
    });
    options.ledger.dispatchAttempts.set(key, {
      eventId: event?.event_id ?? null,
      phaseSeq,
    });
  }

  function retryFailedReviewsCommand(args: Args): void {
    const runtimeBudget: GitHubRuntimeBudget = {
      startedAtMs: Date.now(),
      maxRuntimeMs: numberArg(args.max_runtime_ms, 0),
    };
    withGitHubRuntimeBudget(runtimeBudget, () => retryFailedReviewsCommandInner(args));
  }

  function retryFailedReviewsCommandInner(args: Args): void {
    repoFromArgs(args);
    const itemsDir = resolve(stringArg(args.items_dir, defaultItemsDir()));
    const reportPath = resolve(
      stringArg(args.report_path, join(root, "artifacts", "failed-review-retry-report.json")),
    );
    const stateDir = resolve(
      stringArg(args.state_dir, join(dirname(reportPath), "failed-review-retry-state")),
    );
    const limit = numberArg(args.limit, 5);
    const maxAttempts = Math.max(1, numberArg(args.max_attempts, 2));
    const cooldownMs = Math.max(0, numberArg(args.cooldown_minutes, 45) * 60 * 1000);
    const dryRun = boolArg(args.dry_run);
    const workflowRepo = stringArg(
      args.workflow_repo,
      process.env.GITHUB_REPOSITORY ?? "openclaw/clawsweeper",
    );
    const workflowRef = stringArg(args.workflow_ref, "main");
    const codexTimeoutMs = numberArg(args.codex_timeout_ms, DEFAULT_REVIEW_CODEX_TIMEOUT_MS);
    const requestedItemNumbers = itemNumbersArg(args.item_numbers, args.item_number);
    const requested = new Set(requestedItemNumbers);
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const results: FailedReviewRetryResult[] = [];
    const retryLedger = startFailedReviewRetryLedger({
      requestedItemNumbers,
      reportPath,
    });
    let attempted = 0;
    let dispatched = 0;
    let commandError: unknown = null;
    try {
      ensureDir(dirname(reportPath));
      for (const file of markdownFiles(itemsDir)) {
        ensureGitHubRuntimeAvailable("before failed-review retry item");
        const path = join(itemsDir, file);
        let markdown = readFileSync(path, "utf8");
        if (!isMarkdownForActiveRepo(markdown, path)) continue;
        const number = numberForMarkdownFile(file);
        const statePath = failedReviewRetryStatePath(stateDir, number);
        markdown = failedReviewRetryMarkdownWithState(
          markdown,
          readFailedReviewRetryState(statePath),
        );
        if (requested.size > 0 && !requested.has(number)) continue;
        if (results.some((result) => result.number === number)) continue;
        if (effectiveReviewStatus(markdown) !== "failed") {
          results.push({
            repo: targetRepo(),
            number,
            action: "skipped_not_failed_review",
            reason: "review is not failed",
            reportPath: path,
          });
          continue;
        }
        let item: Item;
        let state: string;
        let liveHeadSha: string | null = null;
        let liveSourceRevision: string | null = null;
        try {
          ({ item, state } = fetchItem(number));
          if (state === "open" && !lockedConversationApplyReason(item)) {
            if (item.kind === "pull_request") liveHeadSha = livePullHeadSha(number);
            else liveSourceRevision = liveIssueSourceRevision(number);
          }
        } catch (error) {
          if (isRuntimeBudgetError(error)) throw error;
          results.push({
            repo: targetRepo(),
            number,
            action: "skipped_live_fetch_failed",
            reason: error instanceof Error ? error.message : String(error),
            reportPath: path,
          });
          continue;
        }
        const eligibility = failedReviewRetryEligibility({
          markdown,
          liveState: state,
          liveLocked: item.locked === true,
          liveActiveLockReason: item.activeLockReason ?? null,
          liveHeadSha,
          liveSourceRevision,
          now,
          maxAttempts,
          cooldownMs,
        });
        const retryRevision =
          eligibility.revisionKind && eligibility.revision
            ? { kind: eligibility.revisionKind, value: eligibility.revision }
            : null;
        if (eligibility.action === "skipped_retry_exhausted" && retryRevision) {
          if (isFailedReviewRetryAlreadyExhausted(markdown, retryRevision)) {
            results.push({
              ...eligibility,
              action: "skipped_retry_already_exhausted",
              reportPath: path,
            });
            continue;
          }
          const attempts = eligibility.attempts ?? maxAttempts;
          markdown = markFailedReviewRetry({
            markdown,
            status: "exhausted",
            at: nowIso,
            revision: retryRevision,
            attempts,
            maxAttempts,
            reason: eligibility.reason,
          });
          if (!dryRun) {
            writeFileSync(path, markdown, "utf8");
            writeFailedReviewRetryState(statePath, {
              number,
              status: "exhausted",
              at: nowIso,
              revision: retryRevision,
              attempts,
              maxAttempts,
              reason: eligibility.reason,
            });
          }
          results.push({
            ...eligibility,
            action: "marked_failed_review_retry_exhausted",
            reportPath: path,
          });
          continue;
        }
        if (eligibility.action !== "planned_failed_review_retry" || !retryRevision) {
          results.push({ ...eligibility, reportPath: path });
          continue;
        }
        if (attempted >= limit) break;
        const retryReason = codexFailureReason(failedReviewFailureDetail(markdown));
        if (dryRun) {
          results.push({ ...eligibility, reason: retryReason, reportPath: path });
          attempted += 1;
          dispatched += 1;
          continue;
        }
        const attemptsBeforeDispatch = eligibility.attempts ?? 0;
        const attempts = attemptsBeforeDispatch + 1;
        let dispatchCheckpointed = false;
        let checkpointDispatchUrl: string | undefined;
        try {
          const dispatchUrl = dispatchFailedReviewRetry({
            workflowRepo,
            workflowRef,
            targetRepo: targetRepo(),
            number,
            revision: retryRevision,
            reason: retryReason,
            attempts: eligibility.attempts ?? 0,
            maxAttempts,
            codexTimeoutMs,
            onBeforeDispatch: (nextDispatchUrl) => {
              checkpointDispatchUrl = nextDispatchUrl;
              startFailedReviewRetryDispatchAttempt({
                ledger: retryLedger,
                number,
                revision: retryRevision,
                reportPath: path,
                attempts: attemptsBeforeDispatch,
              });
              markdown = checkpointFailedReviewRetry({
                markdown,
                status: "dispatching",
                at: nowIso,
                revision: retryRevision,
                attempts: attemptsBeforeDispatch,
                maxAttempts,
                reason: retryReason,
                dispatchUrl: nextDispatchUrl,
              });
              writeFileSync(path, markdown, "utf8");
              writeFailedReviewRetryState(statePath, {
                number,
                status: "dispatching",
                at: nowIso,
                revision: retryRevision,
                attempts: attemptsBeforeDispatch,
                maxAttempts,
                reason: retryReason,
                dispatchUrl: nextDispatchUrl,
              });
              dispatchCheckpointed = true;
              attempted += 1;
            },
          });
          markdown = markFailedReviewRetry({
            markdown,
            status: "dispatched",
            at: nowIso,
            revision: retryRevision,
            attempts,
            maxAttempts,
            reason: retryReason,
            dispatchUrl,
          });
          writeFileSync(path, markdown, "utf8");
          writeFailedReviewRetryState(statePath, {
            number,
            status: "dispatched",
            at: nowIso,
            revision: retryRevision,
            attempts,
            maxAttempts,
            reason: retryReason,
            dispatchUrl,
          });
          results.push({
            repo: targetRepo(),
            number,
            action: "dispatched_failed_review_retry",
            reason: retryReason,
            ...failedReviewRetryResultRevision(retryRevision),
            attempts,
            reportPath: path,
            dispatchUrl,
          });
          dispatched += 1;
        } catch (error) {
          const dispatchOutcome = isDispatchError(error)
            ? error.outcome
            : dispatchCheckpointed
              ? "ambiguous_transport"
              : "definitely_not_dispatched";
          if (dispatchCheckpointed && dispatchOutcome === "ambiguous_transport") {
            results.push({
              repo: targetRepo(),
              number,
              action: "skipped_retry_dispatch_uncertain",
              reason: error instanceof Error ? error.message : String(error),
              ...failedReviewRetryResultRevision(retryRevision),
              attempts: attemptsBeforeDispatch,
              reportPath: path,
              ...(checkpointDispatchUrl ? { dispatchUrl: checkpointDispatchUrl } : {}),
            });
            if (isDispatchError(error) && isRuntimeBudgetError(error.cause)) {
              throw error.cause;
            }
            continue;
          }
          if (isRuntimeBudgetError(error)) throw error;
          const reason = error instanceof Error ? error.message : String(error);
          if (checkpointDispatchUrl) {
            markdown = markFailedReviewRetry({
              markdown,
              status: "dispatch_failed",
              at: nowIso,
              revision: retryRevision,
              attempts: attemptsBeforeDispatch,
              maxAttempts,
              reason,
              ...(checkpointDispatchUrl ? { dispatchUrl: checkpointDispatchUrl } : {}),
            });
            writeFileSync(path, markdown, "utf8");
            writeFailedReviewRetryState(statePath, {
              number,
              status: "dispatch_failed",
              at: nowIso,
              revision: retryRevision,
              attempts: attemptsBeforeDispatch,
              maxAttempts,
              reason,
              ...(checkpointDispatchUrl ? { dispatchUrl: checkpointDispatchUrl } : {}),
            });
          }
          results.push({
            repo: targetRepo(),
            number,
            action: "skipped_dispatch_failed",
            reason,
            ...failedReviewRetryResultRevision(retryRevision),
            attempts: eligibility.attempts,
            reportPath: path,
            ...(checkpointDispatchUrl ? { dispatchUrl: checkpointDispatchUrl } : {}),
          });
        }
      }
    } catch (error) {
      if (isRuntimeBudgetError(error)) {
        results.push({
          number: 0,
          action: "skipped_runtime_budget",
          reason: error.reason,
        });
      } else {
        commandError = error;
      }
    }
    try {
      writeFileSync(reportPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
    } catch (error) {
      commandError ??= error;
    }
    recordFailedReviewRetryEvents({
      ledger: retryLedger,
      results,
      reportPath,
      dryRun,
      failure: commandError,
    });
    if (commandError) throw commandError;
    console.log(JSON.stringify({ results, dryRun, attempted, dispatched }, null, 2));
  }

  function reviewRetryActionDisposition(action: FailedReviewRetryAction): {
    status: ActionEventStatus;
    reasonCode: ActionEventReasonCode;
    retryable: boolean;
    mutation: boolean;
  } {
    if (action === "dispatched_failed_review_retry") {
      return {
        status: ACTION_EVENT_STATUSES.dispatched,
        reasonCode: ACTION_EVENT_REASON_CODES.retryScheduled,
        retryable: true,
        mutation: true,
      };
    }
    if (action === "planned_failed_review_retry") {
      return {
        status: ACTION_EVENT_STATUSES.planned,
        reasonCode: ACTION_EVENT_REASON_CODES.dryRun,
        retryable: true,
        mutation: false,
      };
    }
    if (action === "marked_failed_review_retry_exhausted") {
      return {
        status: ACTION_EVENT_STATUSES.blocked,
        reasonCode: ACTION_EVENT_REASON_CODES.retryExhausted,
        retryable: false,
        mutation: true,
      };
    }
    if (action === "skipped_runtime_budget") {
      return {
        status: ACTION_EVENT_STATUSES.yielded,
        reasonCode: ACTION_EVENT_REASON_CODES.runtimeBudget,
        retryable: true,
        mutation: false,
      };
    }
    if (action === "skipped_dispatch_failed" || action === "skipped_live_fetch_failed") {
      return {
        status: ACTION_EVENT_STATUSES.failed,
        reasonCode: ACTION_EVENT_REASON_CODES.unavailable,
        retryable: true,
        mutation: false,
      };
    }
    if (action === "skipped_retry_dispatch_uncertain") {
      return {
        status: ACTION_EVENT_STATUSES.failed,
        reasonCode: ACTION_EVENT_REASON_CODES.unavailable,
        retryable: false,
        mutation: true,
      };
    }
    if (action === "skipped_retry_cooldown") {
      return {
        status: ACTION_EVENT_STATUSES.waiting,
        reasonCode: ACTION_EVENT_REASON_CODES.leaseActive,
        retryable: true,
        mutation: false,
      };
    }
    if (action === "skipped_stale_head" || action === "skipped_stale_revision") {
      return {
        status: ACTION_EVENT_STATUSES.blocked,
        reasonCode: ACTION_EVENT_REASON_CODES.sourceChanged,
        retryable: false,
        mutation: false,
      };
    }
    return {
      status: ACTION_EVENT_STATUSES.skipped,
      reasonCode: ACTION_EVENT_REASON_CODES.notApplicable,
      retryable: action !== "skipped_retry_already_exhausted",
      mutation: false,
    };
  }

  function reviewRetryBusinessIdempotencyIdentityForTest(options: {
    repository: string;
    number: number;
    revisionKind: FailedReviewRetryRevisionKind;
    sourceRevision: string;
    reviewContentDigest: string;
    decisionPacketSha256: string;
    slot: "retry_dispatch" | "retry_exhaustion" | "retry_observation";
  }) {
    return {
      operation: "review_retry",
      slot: options.slot,
      repository: options.repository,
      number: options.number,
      revisionKind: options.revisionKind,
      sourceRevision: options.sourceRevision,
      reviewContentDigest: options.reviewContentDigest,
      decisionPacketSha256: options.decisionPacketSha256,
    };
  }

  function reviewRetryIdempotencySlot(
    action: FailedReviewRetryAction,
  ): "retry_dispatch" | "retry_exhaustion" | "retry_observation" {
    if (
      action === "dispatched_failed_review_retry" ||
      action === "planned_failed_review_retry" ||
      action === "skipped_dispatch_failed" ||
      action === "skipped_retry_dispatch_uncertain"
    ) {
      return "retry_dispatch";
    }
    return action === "marked_failed_review_retry_exhausted"
      ? "retry_exhaustion"
      : "retry_observation";
  }

  function reviewRetryActionNeedsItemEventForTest(action: FailedReviewRetryAction): boolean {
    return action !== "skipped_not_failed_review";
  }

  function reviewRetryBatchEventDisposition(
    actions: readonly FailedReviewRetryAction[],
    failure: ReturnType<typeof actionLedgerFailureDisposition> | null = null,
  ): {
    status: ActionEventStatus;
    reasonCode: ActionEventReasonCode;
    retryable: boolean;
    completionReason: string;
    failedCount: number;
    partial: boolean;
  } {
    const dispatchOutcomeUnknown = actions.includes("skipped_retry_dispatch_uncertain");
    const yielded = actions.includes("skipped_runtime_budget");
    const failed =
      dispatchOutcomeUnknown ||
      actions.some(
        (action) => action === "skipped_dispatch_failed" || action === "skipped_live_fetch_failed",
      );
    if (dispatchOutcomeUnknown) {
      return {
        status: ACTION_EVENT_STATUSES.failed,
        reasonCode: ACTION_EVENT_REASON_CODES.unavailable,
        retryable: false,
        completionReason: "dispatch_outcome_unknown",
        failedCount: 1 + (failure ? 1 : 0),
        partial: true,
      };
    }
    if (failure) {
      return {
        status: failure.status,
        reasonCode: failure.reasonCode,
        retryable: true,
        completionReason: failure.completionReason,
        failedCount: 1 + (failed ? 1 : 0),
        partial: actions.length > 0,
      };
    }
    if (failed) {
      return {
        status: ACTION_EVENT_STATUSES.failed,
        reasonCode: ACTION_EVENT_REASON_CODES.unavailable,
        retryable: true,
        completionReason: "failed",
        failedCount: 1,
        partial: false,
      };
    }
    if (yielded) {
      return {
        status: ACTION_EVENT_STATUSES.yielded,
        reasonCode: ACTION_EVENT_REASON_CODES.runtimeBudget,
        retryable: true,
        completionReason: "partial",
        failedCount: 0,
        partial: true,
      };
    }
    return {
      status: ACTION_EVENT_STATUSES.completed,
      reasonCode: ACTION_EVENT_REASON_CODES.completed,
      retryable: false,
      completionReason: "completed",
      failedCount: 0,
      partial: false,
    };
  }

  function recordFailedReviewRetryEvents(options: {
    ledger: ReviewRetryActionLedger;
    results: readonly FailedReviewRetryResult[];
    reportPath: string;
    dryRun: boolean;
    failure?: unknown;
  }): void {
    if (options.ledger.terminal) return;
    const operationIdentity = options.ledger.operationIdentity;
    let dispatchOutcomeUnknownEventId: string | null = null;
    for (const [index, result] of options.results.entries()) {
      // Healthy records dominate the hourly scan. Keep their count in the batch
      // terminal event instead of creating thousands of immutable no-op receipts.
      if (!reviewRetryActionNeedsItemEventForTest(result.action)) continue;
      const disposition = reviewRetryActionDisposition(result.action);
      const reportMarkdown =
        result.reportPath && existsSync(result.reportPath)
          ? readFileSync(result.reportPath, "utf8")
          : null;
      const kind = reportMarkdown ? reportItemKind(reportMarkdown) : undefined;
      const sourceRevision =
        result.revision ??
        (reportMarkdown ? reviewLeaseRevisionFromReport(reportMarkdown) : null) ??
        undefined;
      const revisionKind =
        result.revisionKind ??
        (kind === "pull_request"
          ? "pull_head_sha"
          : kind === "issue"
            ? "item_source_revision"
            : undefined);
      const recordPath = result.reportPath ? repoRelativePath(result.reportPath) : undefined;
      const subject: ActionEventSubject =
        result.number > 0 && kind
          ? {
              repository: result.repo ?? targetRepo(),
              kind,
              number: result.number,
              ...(sourceRevision ? { sourceRevision } : {}),
              ...(recordPath && !recordPath.startsWith("../") ? { recordPath } : {}),
            }
          : {
              repository: result.repo ?? targetRepo(),
              kind: "workflow",
            };
      const evidence = [
        ...workflowRunEvidence(),
        ...(result.reportPath
          ? [actionLedgerFileEvidence("review_record", result.reportPath)].filter(
              (entry): entry is ActionEventEvidence => entry !== null,
            )
          : []),
      ];
      const retrySlot = reviewRetryIdempotencySlot(result.action);
      const idempotencyIdentity =
        result.number > 0 && revisionKind && sourceRevision
          ? reviewRetryBusinessIdempotencyIdentityForTest({
              repository: subject.repository,
              number: result.number,
              revisionKind,
              sourceRevision,
              reviewContentDigest:
                (reportMarkdown
                  ? frontMatterValue(reportMarkdown, "review_content_digest")
                  : undefined) ?? "unknown",
              decisionPacketSha256:
                (reportMarkdown
                  ? frontMatterValue(reportMarkdown, "decision_packet_sha256")
                  : undefined) ?? "none",
              slot: retrySlot,
            })
          : {
              operation: "review_retry",
              slot: retrySlot,
              repository: subject.repository,
              number: result.number,
              action: result.action,
            };
      if (!options.dryRun && disposition.mutation && (!revisionKind || !sourceRevision)) {
        throw new Error(
          `retry mutation receipt for ${subject.repository}#${result.number} is missing its source revision`,
        );
      }
      const dispatchAttempt =
        result.number > 0 && revisionKind && sourceRevision
          ? options.ledger.dispatchAttempts.get(
              reviewRetryDispatchAttemptKey({
                repository: subject.repository,
                number: result.number,
                revision: { kind: revisionKind, value: sourceRevision },
              }),
            )
          : undefined;
      const event = recordWorkflowPhaseEvent(root, {
        phase: ACTION_EVENT_TYPES.reviewRetry,
        status: disposition.status,
        reasonCode: disposition.reasonCode,
        retryable: disposition.retryable,
        mutation: !options.dryRun && disposition.mutation,
        identity: {
          slot: "retry_result",
          index,
          repository: subject.repository,
          number: result.number,
        },
        operation: "review_retry",
        operationIdentity,
        parentEventId: dispatchAttempt?.eventId ?? options.ledger.batchStartEventId,
        phaseSeq: dispatchAttempt ? dispatchAttempt.phaseSeq + 1 : 10 + index,
        idempotencyIdentity,
        component: "retry_failed_reviews",
        subject,
        evidence,
        attributes: {
          batch_index: index,
          attempt: Math.max(1, result.attempts ?? 1),
          retry_count: result.attempts ?? 0,
          final_attempt:
            result.action === "marked_failed_review_retry_exhausted" ||
            result.action === "skipped_retry_already_exhausted",
          completion_reason:
            result.action === "skipped_retry_dispatch_uncertain"
              ? "dispatch_outcome_unknown"
              : result.action,
        },
        privacy: actionLedgerPrivacy(),
      });
      if (result.action === "skipped_retry_dispatch_uncertain") {
        dispatchOutcomeUnknownEventId = event?.event_id ?? dispatchAttempt?.eventId ?? null;
      }
    }
    const failure =
      options.failure === undefined || options.failure === null
        ? null
        : actionLedgerFailureDisposition(options.failure);
    const batchDisposition = reviewRetryBatchEventDisposition(
      options.results.map((result) => result.action),
      failure,
    );
    recordWorkflowPhaseEvent(root, {
      phase: ACTION_EVENT_TYPES.reviewRetry,
      status: batchDisposition.status,
      reasonCode: batchDisposition.reasonCode,
      retryable: batchDisposition.retryable,
      mutation:
        !options.dryRun &&
        options.results.some((result) => reviewRetryActionDisposition(result.action).mutation),
      identity: { slot: "retry_batch_terminal" },
      operation: "review_retry",
      operationIdentity,
      parentEventId: dispatchOutcomeUnknownEventId ?? options.ledger.batchStartEventId,
      phaseSeq: 1_000_000,
      idempotencyIdentity: { operationIdentity, slot: "retry_batch_terminal" },
      component: "retry_failed_reviews",
      subject: {
        repository: targetRepo(),
        kind: "workflow",
      },
      evidence: [
        ...workflowRunEvidence(),
        ...[actionLedgerFileEvidence("review_retry_report", options.reportPath)].filter(
          (entry): entry is ActionEventEvidence => entry !== null,
        ),
      ],
      attributes: {
        result_count: options.results.length,
        retry_count: options.results.filter(
          (result) =>
            result.action === "dispatched_failed_review_retry" ||
            result.action === "planned_failed_review_retry",
        ).length,
        failed_count: batchDisposition.failedCount,
        skipped_count: options.results.filter((result) => result.action.startsWith("skipped_"))
          .length,
        partial: batchDisposition.partial,
        duration_ms: Math.max(0, Date.now() - options.ledger.startedAtMs),
        completion_reason: batchDisposition.completionReason,
      },
      privacy: actionLedgerPrivacy(),
    });
    options.ledger.terminal = true;
  }

  return {
    preserveFailedReviewRetryMetadataForTest,
    reviewRetryActionDisposition,
    reviewRetryActionNeedsItemEventForTest,
    reviewRetryBatchEventDisposition,
    reviewRetryBusinessIdempotencyIdentityForTest,
    failedReviewRetryMarkdownWithState,
    failedReviewRetryStatePath,
    preserveFailedReviewRetryMetadata,
    readFailedReviewRetryState,
    retryFailedReviewsCommand,
  };
}
