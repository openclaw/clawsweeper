#!/usr/bin/env node
import type { JsonValue, LooseRecord } from "./json-types.js";
import fs from "node:fs";
import path from "node:path";
import {
  AUTOFIX_LABEL,
  AUTOMERGE_LABEL,
  HUMAN_REVIEW_LABEL,
  MERGE_READY_LABEL,
} from "./exact-review-guard-labels.js";
import { parseArgs } from "./lib.js";
import { repoRoot } from "./paths.js";
import {
  commandHasAction,
  createCachedIssueCommentsLookup,
  createCachedIssueCommentsLookupAsync,
  hasCommandResponseMarker,
  commandStatusMarkerForCommand,
  existingCommandStatusBlocksReplay,
  renderResponse,
  staleClosedItemCommandReason,
  shouldClearMaintainerCommandReaction,
} from "./comment-router-core.js";
import {
  isAllowedMutationActor,
  isAuthorReadOnlyCommandAllowed,
  isGitHubAppIntegrationAuthError,
  isMaintainerCommandAllowed,
  isTrustedStatusCommentAuthor,
  parseRoutedCommentCommand,
} from "./comment-router/admission.js";
import { dispatchClaimLookupKeys, routerDispatchReceiptKey } from "./comment-router/dispatch.js";
import { planCommandAckConvergence } from "./command-ack-convergence.js";
import {
  commandAckMarker,
  commandAckMarkerFromBody,
  commandResponseMarker,
  commandStatusMarkerFromBody,
} from "./markers.js";

import {
  SUPERSEDED_RE_REVIEW_REASON,
  commentBodySha256,
  exactCommentVersionFastPathDecision,
  exactCommentVersionMatchesLive,
  issueNumberFromUrl,
  routedCommentSourceDeliveryId,
  selectCommentsForRouting,
  shouldSuppressProcessedCommentVersion,
  supersededReReviewCommentVersions,
  summarizeChecks,
  writePayload,
  writeReportFile,
} from "./comment-router-utils.js";
import { appendLedger, readLedger, writeLedger } from "./comment-router/ledger.js";
import {
  DEFAULT_TRUSTED_BOTS,
  forcedReplayCommandFields,
  readCommentRouterConfig,
} from "./config.js";
import {
  ghErrorText,
  ghJsonWithRetry as ghJson,
  ghJsonWithRetryAsync as ghJsonAsync,
  ghPagedLimitWithRetry as ghPagedLimit,
  ghPagedWithRetry as ghPaged,
  ghPagedWithRetryAsync as ghPagedAsync,
  ghTextWithRetry,
  type GhRetryOptions,
} from "./github-cli.js";
import { GitHubRateLimitError, ghRetryKind, ghRetryWaitMs } from "../github-retry.js";
import { compactText, stripAnsi } from "./text-utils.js";
import {
  flushCommandActionEvents,
  recordCommandClaimed,
  recordCommandClassified,
  recordCommandFailure,
  recordCommandOutcome,
  recordCommandReceived,
  runCommandMutation,
  runCommandMutationWithRetry,
} from "./command-action-ledger.js";
import { directReReviewIntake } from "./direct-re-review-admission.js";
import { postExactReviewCommandIntakeSync } from "./exact-review-command-queue.js";

const args = parseArgs(process.argv.slice(2));
const config = readCommentRouterConfig(args);
const {
  targetRepo,
  targetBranch,
  reviewRepo,
  reviewWorkflow,
  execute,
  forceReprocess,
  attemptId,
  writeReport,
  maxComments,
  lookupConcurrency,
  since,
  sinceCommentIds,
  itemNumbers,
  commentIds,
  statusCommentId,
  allowedAssociations,
  allowedRepositoryPermissions,
  trustedBots,
} = config;

const startedAtMs = Date.now();
const timings: LooseRecord[] = [];
const ledger = readLedger(ledgerPath());
const TARGET_LOOKUP_RETRY_ATTEMPTS = 3;
let exactCommentVersionFastPath = exactCommentVersionFastPathDecision({
  authenticated:
    args["comment-event-auth"] === "github_webhook_v1" &&
    args["source-event"] === "issue_comment" &&
    isAllowedMutationActor(args["dispatch-actor"], trustedBots),
  sourceAction: args["source-action"],
  targetRepo,
  commentId: commentIds.size === 1 ? [...commentIds][0] : null,
  commentUpdatedAt: args["comment-updated-at"],
  commentBodyDigest: args["comment-body-sha256"],
  forceReprocess,
  ledger,
  verificationLedgers: exactCommentVersionVerificationLedgers(),
});
const exactCommentVersionFastPathCommand = exactCommentVersionFastPath.suppress
  ? exactCommentVersionLedgerCommand(exactCommentVersionFastPath.commentVersionKey)
  : null;
if (exactCommentVersionFastPath.suppress && !exactCommentVersionFastPathCommand) {
  exactCommentVersionFastPath = { suppress: false, reason: "state_drift" };
} else if (
  exactCommentVersionFastPath.suppress &&
  exactCommentVersionFastPathCommand &&
  !exactCommentVersionStillCurrent(exactCommentVersionFastPathCommand)
) {
  exactCommentVersionFastPath = { suppress: false, reason: "source_drift" };
}
const priorDispatchClaims = new Map<string, LooseRecord>();
const priorCommandDeliveryClaims = new Map<string, LooseRecord>();
for (const entry of ledger.commands ?? []) {
  if (entry.status === "claimed") {
    for (const key of dispatchClaimLookupKeys(entry)) priorDispatchClaims.set(key, entry);
  }
  if (!["claimed", "waiting"].includes(String(entry.status ?? ""))) continue;
  if (!entry.source_delivery_id && entry.source_delivery_conflict !== true) continue;
  for (const key of dispatchClaimLookupKeys(entry)) priorCommandDeliveryClaims.set(key, entry);
}
const processedCommentVersions = forceReprocess
  ? new Set()
  : new Set(
      (ledger.commands ?? [])
        .filter((entry: JsonValue) => shouldSuppressProcessedCommentVersion(entry))
        .map(commentVersionKey)
        .filter(Boolean),
    );
const retryPendingCommentVersions = new Set(
  (ledger.commands ?? [])
    .filter((entry: JsonValue) => entry.status === "waiting" || entry.status === "claimed")
    .map(commentVersionKey)
    .filter(Boolean),
);
// Pending replay is intentional: active-run checks prevent duplicate workers, and
// marker-backed status replies are updated in place until dispatch can continue.
const collaboratorPermissionCache = new Map();
const liveTargetCache = new Map<number, LooseRecord>();
const issueCommentsCache = new Map<number, JsonValue[]>();
const throttledIssueCommentLookups = new Set<number>();
const throttledCollaboratorLookups = new Set<string>();
let deferredGitHubThrottle: GitHubRateLimitError | null = null;
const cachedIssueComments = createCachedIssueCommentsLookup(
  (number) => ghPaged<JsonValue>(`repos/${targetRepo}/issues/${number}/comments?per_page=100`),
  issueCommentsCache,
);
const cachedIssueCommentsAsync = createCachedIssueCommentsLookupAsync(
  (number) => ghPagedAsync<JsonValue>(`repos/${targetRepo}/issues/${number}/comments?per_page=100`),
  issueCommentsCache,
);
let recentCommentCursorCandidate: LooseRecord | null = null;
const comments = measure("list_candidate_comments", () =>
  exactCommentVersionFastPath.suppress ? [] : listCandidateComments(),
);
const rawCommands: LooseRecord[] = [];

for (const comment of comments) {
  const command = routedCommandForComment(comment);
  if (command) {
    rawCommands.push(command);
    recordCommandReceived(command);
  }
}
let supersededReReviewVersions = supersededReReviewCommentVersions(rawCommands);

await measureAsync("prehydrate_comment_commands", () =>
  prehydrateCommandLookups(rawCommands, { refreshIssueComments: true }),
);
const classifiedCommentCommands = measure("classify_comment_commands", () =>
  rawCommands.map((command) => classifyAndRecordCommand(command)),
);
const commands = classifiedCommentCommands;

let actionable = commands.filter((command: JsonValue) => command.status === "ready");
const report: LooseRecord = {
  status: execute ? "executed" : "dry_run",
  generated_at: new Date().toISOString(),
  repo: targetRepo,
  review_repo: reviewRepo,
  since,
  execute,
  force_reprocess: forceReprocess,
  forced_replay_attempt_id: attemptId,
  max_comments: maxComments,
  item_numbers: [...itemNumbers],
  comment_ids: [...commentIds],
  status_comment_id: statusCommentId,
  scanned_comments: comments.length,
  commands_seen: commands.length,
  actionable: actionable.length,
  trusted_bots: [...trustedBots],
  allowed_repository_permissions: [...allowedRepositoryPermissions],
  lookup_concurrency: lookupConcurrency,
  commands,
  exact_comment_version_fast_path: exactCommentVersionFastPath,
  routing_cursor_candidate: recentCommentCursorCandidate,
  short_circuited: exactCommentVersionFastPath.suppress,
};

if (execute && exactCommentVersionFastPath.suppress && exactCommentVersionFastPathCommand) {
  const versionStillCurrent = measure("verify_exact_comment_version_cleanup", () =>
    exactCommentVersionStillCurrent(exactCommentVersionFastPathCommand),
  );
  if (versionStillCurrent) assertMutationActorIsClawsweeperBot();
  const ackConvergence = versionStillCurrent
    ? measure("converge_exact_comment_version_ack", () =>
        convergeExactCommentVersionFastPathAck(exactCommentVersionFastPathCommand, statusCommentId),
      )
    : "skipped_source_drift";
  report.exact_comment_version_ack = ackConvergence;
  if (versionStillCurrent && exactCommentVersionAckFailed(ackConvergence)) {
    throw new Error(`exact comment acknowledgement convergence failed: ${ackConvergence}`);
  }
  report.exact_comment_version_cleanup = versionStillCurrent
    ? measure("clear_exact_comment_version_reaction", () =>
        removeOwnCommentReaction(exactCommentVersionFastPathCommand, "eyes"),
      )
    : "skipped_source_drift";
  if (!versionStillCurrent) {
    exactCommentVersionFastPath = { suppress: false, reason: "cleanup_source_drift" };
    const resumedComments = measure("list_candidate_comments_after_cleanup_drift", () =>
      listCandidateComments(),
    );
    const resumedRawCommands = resumedComments
      .map((comment) => routedCommandForComment(comment))
      .filter((command): command is LooseRecord => Boolean(command));
    rawCommands.push(...resumedRawCommands);
    for (const command of resumedRawCommands) recordCommandReceived(command);
    supersededReReviewVersions = supersededReReviewCommentVersions(rawCommands);
    await measureAsync("prehydrate_cleanup_drift_commands", () =>
      prehydrateCommandLookups(resumedRawCommands, { refreshIssueComments: true }),
    );
    const resumedClassified = measure("classify_cleanup_drift_commands", () =>
      resumedRawCommands.map((command) => classifyAndRecordCommand(command)),
    );
    commands.push(...resumedClassified);
    actionable = commands.filter((command: JsonValue) => command.status === "ready");
    report.scanned_comments = Number(report.scanned_comments ?? 0) + resumedComments.length;
    report.commands_seen = commands.length;
    report.actionable = actionable.length;
    report.exact_comment_version_fast_path = exactCommentVersionFastPath;
    report.short_circuited = false;
  }
}

if (execute && !exactCommentVersionFastPath.suppress) {
  await measureAsync("execute_commands", async () => {
    assertMutationActorIsClawsweeperBot();
    const claimedCommands = measure("claim_dispatch_commands", () =>
      claimDispatchCommands(actionable),
    );
    report.ledger_claimed = appendLedger(ledger, claimedCommands);
    if (report.ledger_claimed) {
      writeLedger(ledgerPath(), ledger);
      for (const command of claimedCommands) recordCommandClaimed(command);
    }
    for (const command of commands) convergePrecreatedCommandAckComments(command);
    for (const command of commands) acknowledgeTerminalNoopMaintainerCommand(command);
    for (const command of commands) {
      if (command.status !== "ready") {
        recordCommandOutcome(command);
      }
    }
    for (const command of actionable) executeCommandWithReceipt(command);
  });
  report.ledger_changed = measure("append_ledger", () => appendLedger(ledger, commands));
  if (report.ledger_changed) writeLedger(ledgerPath(), ledger);
}

report.timings = {
  total_ms: Date.now() - startedAtMs,
  phases: timings,
};
if (writeReport) writeReportFile(repoRoot(), report);
await flushCommandActionEvents();
console.log(JSON.stringify(report, null, 2));
if (deferredGitHubThrottle) throw deferredGitHubThrottle;

function measure<T>(name: string, fn: () => T): T {
  const start = Date.now();
  try {
    return fn();
  } finally {
    timings.push({ name, ms: Date.now() - start });
  }
}

async function measureAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    timings.push({ name, ms: Date.now() - start });
  }
}

function routedCommandForComment(comment: JsonValue): LooseRecord | null {
  const parsed: LooseRecord = parseRoutedCommentCommand(comment, { trustedAuthors: trustedBots });
  if (!parsed || parsed.trusted_bot) return null;
  const issueNumber = issueNumberFromUrl(comment.issue_url);
  const commandIdentity = {
    idempotency_key: idempotencyKey(parsed, issueNumber, comment.id, comment.updated_at),
    comment_id: String(comment.id),
    comment_updated_at: comment.updated_at,
    ...forcedReplayCommandFields({ forceReprocess, attemptId }),
  };
  const sourceDeliveryId = routedCommentSourceDeliveryId({
    comment,
    event: {
      authenticated:
        args["comment-event-auth"] === "github_webhook_v1" &&
        args["source-event"] === "issue_comment" &&
        isAllowedMutationActor(args["dispatch-actor"], trustedBots),
      commentId: commentIds.size === 1 ? [...commentIds][0] : null,
      commentUpdatedAt: args["comment-updated-at"],
      commentBodySha256: args["comment-body-sha256"],
      sourceDeliveryId: args["source-delivery-id"],
    },
    priorClaim: priorCommandDeliveryClaim(commandIdentity),
    targetRepo,
  });
  return {
    ...commandIdentity,
    comment_version_key: commentVersionKey({
      comment_id: comment.id,
      comment_updated_at: comment.updated_at,
    }),
    comment_url: comment.html_url,
    repo: targetRepo,
    target_branch: targetBranch || null,
    issue_number: issueNumber,
    author: comment.user?.login ?? null,
    author_id: comment.user?.id ?? null,
    author_type: comment.user?.type ?? null,
    author_association: String(comment.author_association ?? "").toUpperCase(),
    comment_created_at: comment.created_at,
    comment_updated_at: comment.updated_at,
    comment_body_sha256: commentBodySha256(comment.body),
    ...(sourceDeliveryId ? { source_delivery_id: sourceDeliveryId } : {}),
    status_comment_id:
      statusCommentId &&
      commentIds.size <= 1 &&
      String(comment.id) === String([...commentIds][0] ?? "")
        ? statusCommentId
        : null,
    trigger: parsed.trigger,
    command: parsed.command,
    intent: parsed.intent,
    trusted_bot: false,
    freeform_prompt: parsed.freeform_prompt ?? null,
    ...forcedReplayCommandFields({ forceReprocess, attemptId }),
    status: "pending",
    actions: [],
  };
}

function claimDispatchCommands(commands: LooseRecord[]) {
  const processedAt = new Date().toISOString();
  return commands
    .filter(commandNeedsDurableDispatchClaim)
    .filter((command) => !priorDispatchClaim(command))
    .map((command) => dispatchClaimEntry(command, processedAt));
}

function dispatchClaimEntry(command: LooseRecord, processedAt: string) {
  command.processed_at = processedAt;
  return {
    ...command,
    processed_at: processedAt,
    status: "claimed",
    actions: Array.isArray(command.actions)
      ? command.actions.map((action: JsonValue) =>
          actionNeedsDurableDispatchClaim(action) ? { ...action, status: "claimed" } : action,
        )
      : command.actions,
  };
}

function commandNeedsDurableDispatchClaim(command: LooseRecord) {
  return command.status === "ready" && commandHasAction(command, "dispatch_clawsweeper");
}

function actionNeedsDurableDispatchClaim(action: JsonValue) {
  return action?.action === "dispatch_clawsweeper";
}

function priorDispatchClaim(command: LooseRecord) {
  for (const key of dispatchClaimLookupKeys(command)) {
    const claim = priorDispatchClaims.get(key);
    if (claim) return claim;
  }
  return null;
}

function priorCommandDeliveryClaim(command: LooseRecord) {
  for (const key of dispatchClaimLookupKeys(command)) {
    const claim = priorCommandDeliveryClaims.get(key);
    if (claim) return claim;
  }
  return null;
}

function dispatchReceiptKey(command: LooseRecord) {
  return routerDispatchReceiptKey(command, priorDispatchClaim(command));
}

function dispatchedActionStatus(dispatch: LooseRecord) {
  const { status: dispatchStatus, ...receipt } = dispatch;
  if (dispatchStatus === "claimed") return { ...receipt, status: "claimed" };
  return {
    ...receipt,
    status: "executed",
    ...(dispatchStatus === "recovered"
      ? { recovered: true, receipt_verified_at: new Date().toISOString() }
      : { dispatched_at: new Date().toISOString() }),
  };
}

function assertMutationActorIsClawsweeperBot() {
  try {
    const viewer = ghJson<LooseRecord>(["api", "user"]);
    const login = String(viewer.login ?? "");
    if (isAllowedMutationActor(login, trustedBots)) return;
    throw new Error(
      `refusing to execute ClawSweeper comment-router mutations as ${login || "unknown actor"}; set GH_TOKEN to the Clawsweeper GitHub App installation token`,
    );
  } catch (error) {
    if (isExpectedGitHubAppIntegrationToken(error)) return;
    throw error;
  }
}

function isExpectedGitHubAppIntegrationToken(error: unknown) {
  return (
    process.env.CLAWSWEEPER_MUTATION_TOKEN_SOURCE === "clawsweeper-app" &&
    isGitHubAppIntegrationAuthError(ghErrorText(error))
  );
}

async function prehydrateCommandLookups(
  commands: LooseRecord[],
  options: { refreshIssueComments?: boolean } = {},
) {
  const pending = commands.filter(
    (command) =>
      command.issue_number &&
      !(
        command.comment_version_key &&
        (processedCommentVersions.has(command.comment_version_key) ||
          supersededReReviewVersions.has(command.comment_version_key))
      ),
  );
  const logins = unique(
    pending
      .filter((command) => !command.trusted_bot)
      .map((command) => String(command.author ?? "").trim())
      .filter(Boolean),
  );
  const issueNumbers = unique(
    pending
      .map((command) => Number(command.issue_number))
      .filter((number) => Number.isInteger(number) && number > 0),
  );

  await Promise.all([
    mapLimit(logins, lookupConcurrency, async (login) => {
      try {
        await fetchCollaboratorPermissionAsync(login);
      } catch (error) {
        if (!(error instanceof GitHubRateLimitError)) throw error;
        deferGitHubThrottle(error);
        throttledCollaboratorLookups.add(login.toLowerCase());
      }
    }),
    mapLimit(issueNumbers, lookupConcurrency, async (number) => {
      liveTargetCache.set(number, await fetchLiveTargetAsync(number));
    }),
    mapLimit(issueNumbers, lookupConcurrency, async (number) => {
      if (options.refreshIssueComments) issueCommentsCache.delete(number);
      try {
        await cachedIssueCommentsAsync(number);
      } catch (error) {
        if (!(error instanceof GitHubRateLimitError)) throw error;
        deferGitHubThrottle(error);
        throttledIssueCommentLookups.add(number);
      }
    }),
  ]);
}

function classifyCommand(command: LooseRecord): JsonValue {
  if (command.comment_version_key && processedCommentVersions.has(command.comment_version_key)) {
    return { ...command, status: "skipped", reason: "comment version already processed in ledger" };
  }
  if (command.comment_version_key && supersededReReviewVersions.has(command.comment_version_key)) {
    return { ...command, status: "skipped", reason: SUPERSEDED_RE_REVIEW_REASON };
  }
  if (
    throttledIssueCommentLookups.has(Number(command.issue_number)) ||
    throttledCollaboratorLookups.has(String(command.author ?? "").toLowerCase())
  ) {
    return {
      ...command,
      status: "waiting",
      reason: "GitHub throttled required routing context; the next cycle will retry",
    };
  }
  let authorization: LooseRecord | null = null;
  if (command.trusted_bot) {
    if (!trustedBots.has(String(command.author ?? "").toLowerCase())) {
      return { ...command, status: "ignored", reason: "trusted automation author is not allowed" };
    }
  } else {
    authorization = resolveMaintainerCommandAuthorization(command);
    command.author_repository_permission = authorization.repositoryPermission;
  }
  if (!command.issue_number) {
    return { ...command, status: "ignored", reason: "could not resolve issue or PR number" };
  }

  const liveTarget = fetchLiveTarget(command);
  if (liveTarget.status === "waiting") return liveTarget;
  const { issue, pull } = liveTarget;
  const target = pull ? classifyPullTarget(pull) : classifyIssueTarget(issue);
  const authorReadOnlyAllowed =
    !command.trusted_bot &&
    authorization &&
    !authorization.allowed &&
    isAuthorReadOnlyCommandAllowed({ command, target });
  const next = {
    ...command,
    target,
    maintainer_authorized: Boolean(authorization?.allowed),
    author_readonly_authorized: Boolean(authorReadOnlyAllowed),
    retired: !["re_review", "stop", "explain", "help"].includes(command.intent),
  };
  if (!command.trusted_bot && authorization && !authorization.allowed && !authorReadOnlyAllowed) {
    return {
      ...next,
      status: "ignored",
      reason: authorization.reason,
    };
  }
  if (
    existingCommandStatusBlocksReplay({
      hasExistingResponse: hasExistingResponse(
        command.issue_number,
        command.comment_version_key ?? command.comment_id,
        command.intent,
        target.head_sha,
      ),
      forceReprocess,
      retryPending:
        Boolean(command.comment_version_key) &&
        retryPendingCommentVersions.has(command.comment_version_key),
    })
  ) {
    return {
      ...next,
      status: "skipped",
      reason: "matching ClawSweeper response comment already exists",
    };
  }
  if (!["re_review", "explain", "stop", "help"].includes(String(command.intent))) {
    return {
      ...next,
      status: "ready",
      retired: true,
      actions: [{ action: "comment", status: execute ? "pending" : "planned" }],
    };
  }

  if (next.retired) {
    return {
      ...next,
      status: "ready",
      actions: [{ action: "comment", status: execute ? "pending" : "planned" }],
    };
  }
  if (["explain", "help"].includes(command.intent)) {
    return {
      ...next,
      status: "ready",
      actions: [{ action: "comment", status: execute ? "pending" : "planned" }],
    };
  }
  if (command.intent === "re_review") {
    if (String(issue.state ?? "").toLowerCase() !== "open") {
      const staleReason = staleClosedItemCommandReason({ command: next, issue, pull });
      if (staleReason) return { ...next, status: "skipped", reason: staleReason };
      return {
        ...next,
        status: "ready",
        reason: "re-review requires an open issue or PR",
        actions: [{ action: "comment", status: execute ? "pending" : "planned" }],
      };
    }
    return {
      ...next,
      status: "ready",
      actions: [
        {
          action: "dispatch_clawsweeper",
          workflow: reviewWorkflow,
          status: execute ? "pending" : "planned",
        },
        { action: "comment", status: execute ? "pending" : "planned" },
      ],
    };
  }
  if (command.intent === "stop") {
    const removeRepairLoopLabelActions = [AUTOMERGE_LABEL, AUTOFIX_LABEL, MERGE_READY_LABEL]
      .filter((label) => hasLabel(target, label))
      .map((label) => ({
        action: "remove_label",
        label,
        status: execute ? "pending" : "planned",
      }));
    return {
      ...next,
      status: "ready",
      actions: [
        ...removeRepairLoopLabelActions,
        { action: "label", label: HUMAN_REVIEW_LABEL, status: execute ? "pending" : "planned" },
        { action: "comment", status: execute ? "pending" : "planned" },
      ],
    };
  }
  return {
    ...next,
    status: "ready",
    actions: [{ action: "comment", status: execute ? "pending" : "planned" }],
  };
}

function classifyAndRecordCommand(command: LooseRecord): LooseRecord {
  const classified = classifyCommand(command) as LooseRecord;
  recordCommandClassified(classified);
  return classified;
}

function executeCommand(command: LooseRecord) {
  try {
    let dispatched = null;
    const shouldDispatchClawSweeper = commandHasAction(command, "dispatch_clawsweeper");
    const shouldApplyHumanReviewLabel = commandHasAction(command, "label");
    if (!command.trusted_bot) reactToComment(command, "eyes");
    if (command.intent === "re_review" && command.issue_number && shouldDispatchClawSweeper) {
      const clawsweeper = enqueueClawSweeperReReview(command);
      const stale = clawsweeper.admission === "stale";
      if (stale) command.reason = clawsweeper.reason;
      dispatched = { clawsweeper };
      command.actions = command.actions.map((action: JsonValue) => {
        if (action.action === "dispatch_clawsweeper") {
          return {
            ...action,
            ...(stale
              ? { ...clawsweeper, status: "skipped" }
              : dispatchedActionStatus(clawsweeper)),
          };
        }
        if (action.action === "comment") {
          return {
            ...action,
            status: "skipped",
            reason: stale
              ? clawsweeper.reason
              : "The durable review queue owns this command acknowledgement.",
          };
        }
        return action;
      });
      // A recovery producer must not overwrite a queue-owned terminal reply.
      command.status = stale ? "skipped" : "executed";
      return;
    }
    if (command.intent === "stop" && command.issue_number && shouldApplyHumanReviewLabel) {
      if (command.intent === "stop") applyRemoveLabelActions(command);
      ensureHumanReviewLabel(command);
      editIssueLabel(command, HUMAN_REVIEW_LABEL, "add");
      command.actions = command.actions.map((action: JsonValue) =>
        action.action === "label"
          ? { ...action, status: "executed", label: HUMAN_REVIEW_LABEL }
          : action,
      );
    }

    const commentResult = postComment(command, renderResponse(command, dispatched));
    command.actions = command.actions.map((action: JsonValue) =>
      action.action === "comment"
        ? {
            ...action,
            status: "executed",
            commented_at: new Date().toISOString(),
            response_comment_id: commentResult.comment_id,
            response_comment_mode: commentResult.mode,
          }
        : action,
    );
    command.status = "executed";
  } finally {
    clearTerminalMaintainerCommandReaction(command);
  }
}

function executeCommandWithReceipt(command: LooseRecord) {
  try {
    executeCommand(command);
    recordCommandOutcome(command);
  } catch (error) {
    recordCommandFailure(command, error);
    if (error instanceof GitHubRateLimitError) {
      deferGitHubThrottle(error);
      command.status = "waiting";
      command.reason = "GitHub throttled command execution; the next cycle will retry";
      return;
    }
    throw error;
  }
}

function runGitHubTextMutation(
  command: LooseRecord,
  kind: string,
  identity: unknown,
  ghArgs: string[],
  options: GhRetryOptions = {},
  knownNoMutation?: (error: unknown) => boolean,
) {
  const attempts = githubMutationRetryAttempts(options);
  const { attempts: _attempts, ...runOptions } = options;
  return runCommandMutationWithRetry(command, {
    kind,
    identity,
    operation: () => ghTextWithRetry(ghArgs, { ...runOptions, attempts: 1 }),
    attempts,
    shouldRetry: (error) => {
      try {
        if (knownNoMutation?.(error)) return false;
      } catch {
        // The receipt already conservatively classified a failing predicate as unknown.
      }
      return ghRetryKind(error) === "transient";
    },
    beforeRetry: (_error, attempt) =>
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        ghRetryWaitMs("transient", attempt - 1),
      ),
    ...(knownNoMutation ? { knownNoMutation } : {}),
  });
}

function runGitHubTextMutationOnce(
  command: LooseRecord,
  kind: string,
  identity: unknown,
  ghArgs: string[],
  options: GhRetryOptions = {},
  knownNoMutation?: (error: unknown) => boolean,
) {
  return runCommandMutation(command, {
    kind,
    identity,
    operation: () => ghTextWithRetry(ghArgs, { ...options, attempts: 1 }),
    ...(knownNoMutation ? { knownNoMutation } : {}),
  });
}

function runGitHubBestEffortMutation(
  command: LooseRecord,
  kind: string,
  identity: unknown,
  ghArgs: string[],
  knownNoMutation?: (error: unknown) => boolean,
) {
  try {
    runGitHubTextMutationOnce(command, kind, identity, ghArgs, {}, knownNoMutation);
    return true;
  } catch (error) {
    if (error instanceof GitHubRateLimitError) throw error;
    return false;
  }
}

function githubMutationRetryAttempts(options: GhRetryOptions): number {
  if (options.attempts !== undefined) {
    return Number.isFinite(options.attempts) ? Math.max(1, Math.floor(options.attempts)) : 6;
  }
  const configured =
    options.env?.CLAWSWEEPER_GH_RETRY_ATTEMPTS ?? process.env.CLAWSWEEPER_GH_RETRY_ATTEMPTS;
  if (configured == null || configured.trim() === "") return 6;
  const attempts = Number(configured);
  return Number.isFinite(attempts) ? Math.max(1, Math.floor(attempts)) : 6;
}

function githubAlreadyExistsNoMutation(error: unknown) {
  return /\balready exists\b|\b422\b/i.test(ghErrorText(error));
}

function githubNotFoundNoMutation(error: unknown) {
  return isGitHubNotFoundError(error);
}

function editIssueLabel(command: LooseRecord, label: string, operation: "add" | "remove") {
  runGitHubBestEffortMutation(
    command,
    operation === "add" ? "label_add" : "label_remove",
    { repository: command.repo, number: command.issue_number, label },
    [
      "issue",
      "edit",
      String(command.issue_number),
      "--repo",
      command.repo,
      `--${operation}-label`,
      label,
    ],
    operation === "add" ? githubAlreadyExistsNoMutation : githubNotFoundNoMutation,
  );
}

function applyRemoveLabelActions(command: LooseRecord) {
  const labelsToRemove = (command.actions ?? [])
    .filter((action: JsonValue) => action.action === "remove_label")
    .map((action: JsonValue) => String(action.label ?? ""))
    .filter(Boolean);
  if (labelsToRemove.length === 0) return;
  for (const label of labelsToRemove) {
    editIssueLabel(command, label, "remove");
  }
  command.target = {
    ...command.target,
    labels: (command.target?.labels ?? []).filter(
      (label: JsonValue) => !labelsToRemove.includes(String(label)),
    ),
  };
  command.actions = command.actions.map((action: JsonValue) =>
    action.action === "remove_label"
      ? { ...action, status: "executed", label: action.label }
      : action,
  );
}

function acknowledgeTerminalNoopMaintainerCommand(command: LooseRecord) {
  if (command.trusted_bot || !["executed", "skipped"].includes(String(command.status ?? ""))) {
    return;
  }
  const reason = String(command.reason ?? "");
  if (reason === SUPERSEDED_RE_REVIEW_REASON) {
    clearTerminalMaintainerCommandReaction(command);
    return;
  }
  const targetedProcessedComment =
    itemNumbers.size > 0 && reason === "comment version already processed in ledger";
  if (!targetedProcessedComment) return;
  let quotaExhausted = false;
  try {
    reactToComment(command, "eyes");
  } catch (error) {
    quotaExhausted = error instanceof GitHubRateLimitError;
    throw error;
  } finally {
    // A throttled reaction must not spend another privileged request on cleanup.
    if (!quotaExhausted) clearTerminalMaintainerCommandReaction(command);
  }
}

function enqueueClawSweeperReReview(command: LooseRecord): LooseRecord {
  const dispatchKey = dispatchReceiptKey(command);
  const itemKind = command.target?.kind === "pull_request" ? "pull_request" : "issue";
  const intake = directReReviewIntake({
    targetRepo: command.repo,
    targetBranch: command.target_branch || "main",
    itemNumber: Number(command.issue_number),
    itemKind,
    installationId: Number(process.env.CLAWSWEEPER_TARGET_INSTALLATION_ID),
    sourceCommentId: Number(command.comment_id),
    sourceCommentUpdatedAt: String(command.comment_updated_at || ""),
    commandBodyDigest: String(command.comment_body_sha256 || ""),
    commandOrigin: "comment_router",
    ...(command.status_comment_id ? { statusCommentId: Number(command.status_comment_id) } : {}),
    additionalPrompt: freeformReviewPrompt(command),
  });
  command.command_status_revision = intake.commandVersionId;
  const secret = process.env.CLAWSWEEPER_WEBHOOK_SECRET || "";
  if (!secret) throw new Error("internal exact-review queue secret is required");
  const result = runCommandMutation(command, {
    kind: "review_queue_admission",
    identity: intake,
    operation: () =>
      postExactReviewCommandIntakeSync({
        queueUrl: process.env.QUEUE_URL || "https://clawsweeper.openclaw.ai",
        secret,
        intake,
      }),
  });
  return {
    workflow: reviewWorkflow,
    event: "exact_review_queue",
    repo: reviewRepo,
    item_number: command.issue_number,
    dispatch_key: dispatchKey,
    command_version_id: intake.commandVersionId,
    admission: result.kind,
    ...(result.kind === "stale" ? { reason: result.reason } : {}),
    deduped: result.kind === "accepted" && result.deduped,
  };
}

function freeformReviewPrompt(command: LooseRecord): string {
  const prompt = String(command.freeform_prompt ?? "").trim();
  if (!prompt) return "";
  if (command.intent === "re_review") {
    if (command.maintainer_authorized !== true) return "";
    return [
      "Maintainer context from an @clawsweeper re-review command.",
      "",
      `Author: ${command.author ?? "unknown"}`,
      `Comment: ${command.comment_url ?? "unknown"}`,
      "",
      "Requested focus:",
      prompt.slice(0, 3000),
      "",
      "Use this only as read-only review context. Do not merge, close, label, or push code from the model.",
    ].join("\n");
  }
  return "";
}

function classifyIssueTarget(issue: LooseRecord): JsonValue {
  return {
    kind: "issue",
    state: issue.state ?? null,
    locked: issue.locked ?? null,
    title: issue.title ?? null,
    body: issue.body ?? null,
    author: issue.user?.login ?? null,
    labels: (issue.labels ?? []).map((item: JsonValue) => item.name ?? item),
  };
}

function classifyPullTarget(pull: LooseRecord): JsonValue {
  const branch = String(pull.headRefName ?? "");
  const labels = (pull.labels ?? []).map((item: JsonValue) => item.name ?? item);
  const author = String(pull.author?.login ?? pull.author?.name ?? "").toLowerCase();
  return {
    kind: "pull_request",
    title: pull.title ?? null,
    body: pull.body ?? null,
    branch,
    head_sha: pull.headRefOid ?? null,
    author,
    labels,
    files: pull.files ?? [],
    changedFiles: pull.changedFiles ?? null,
    additions: pull.additions ?? null,
    deletions: pull.deletions ?? null,
    mergeable: pull.mergeable ?? null,
    merge_state_status: pull.mergeStateStatus ?? null,
    review_decision: pull.reviewDecision ?? null,
    checks: summarizeChecks(pull.statusCheckRollup ?? []),
  };
}

function listRecentComments() {
  const readLimit = maxComments + sinceCommentIds.size;
  const list = ghPagedLimit<LooseRecord>(
    `repos/${targetRepo}/issues/comments?since=${encodeURIComponent(since)}&sort=updated&direction=asc`,
    readLimit,
  )
    .filter(
      (comment) =>
        Date.parse(String(comment.updated_at ?? "")) !== Date.parse(since) ||
        !sinceCommentIds.has(Number(comment.id)),
    )
    .slice(0, maxComments);
  const latestUpdatedAt = list.reduce(
    (latest, comment) =>
      Date.parse(String(comment.updated_at ?? "")) > Date.parse(latest)
        ? String(comment.updated_at)
        : latest,
    "1970-01-01T00:00:00.000Z",
  );
  if (list.length > 0) {
    recentCommentCursorCandidate = {
      repo: targetRepo,
      updated_at: new Date(latestUpdatedAt).toISOString(),
      comment_ids: list
        .filter(
          (comment) =>
            new Date(String(comment.updated_at ?? "")).toISOString() ===
            new Date(latestUpdatedAt).toISOString(),
        )
        .map((comment) => Number(comment.id))
        .filter((id) => Number.isSafeInteger(id) && id > 0),
    };
  } else if (sinceCommentIds.size === 0) {
    recentCommentCursorCandidate = {
      repo: targetRepo,
      updated_at: new Date(since).toISOString(),
      comment_ids: [],
    };
  }
  return list;
}

function listCandidateComments() {
  if (commentIds.size > 0) {
    return selectCommentsForRouting({
      recentComments: [...commentIds]
        .map((commentId) => fetchIssueComment(commentId))
        .filter((comment) => comment !== null),
      durableComments: [],
      maxComments,
    });
  }
  if (itemNumbers.size > 0) {
    return selectCommentsForRouting({
      recentComments: [...itemNumbers].flatMap((number) => issueCommentsFor(number)),
      durableComments: [],
      maxComments,
    });
  }
  return selectCommentsForRouting({
    recentComments: listRecentComments(),
    durableComments: [],
    maxComments,
  });
}

function issueCommentsFor(number: JsonValue): JsonValue[] {
  return cachedIssueComments(number);
}

function fetchIssueComment(commentId: JsonValue): LooseRecord | null {
  try {
    return ghJson<LooseRecord>(["api", `repos/${targetRepo}/issues/comments/${commentId}`], {
      attempts: TARGET_LOOKUP_RETRY_ATTEMPTS,
    });
  } catch (error) {
    if (isGitHubNotFoundError(error)) {
      console.warn(
        `[comment-router] skipping missing issue comment ${commentId}: ${compactText(ghErrorText(error), 160)}`,
      );
      return null;
    }
    throw error;
  }
}

function isGitHubNotFoundError(error: unknown) {
  return /\bHTTP 404\b|gh:\s*Not Found/i.test(ghErrorText(error));
}

function fetchLiveTarget(command: LooseRecord): LooseRecord {
  const cached = liveTargetCache.get(Number(command.issue_number));
  if (cached) return cached.status === "waiting" ? { ...command, ...cached } : cached;
  try {
    const issue = fetchIssue(command.issue_number);
    const pull = issue.pull_request ? fetchPullRequestView(command.issue_number) : null;
    return { issue, pull };
  } catch (error) {
    if (error instanceof GitHubRateLimitError) deferGitHubThrottle(error);
    return {
      ...command,
      status: "waiting",
      reason: `GitHub lookup failed; will retry later: ${compactGhError(error)}`,
    };
  }
}

async function fetchLiveTargetAsync(number: number): Promise<LooseRecord> {
  try {
    const issue = await fetchIssueAsync(number);
    const pull = issue.pull_request ? await fetchPullRequestViewAsync(number) : null;
    return { issue, pull };
  } catch (error) {
    if (error instanceof GitHubRateLimitError) deferGitHubThrottle(error);
    return {
      issue_number: number,
      status: "waiting",
      reason: `GitHub lookup failed; will retry later: ${compactGhError(error)}`,
    };
  }
}

function fetchIssue(number: JsonValue) {
  return ghJson(["api", `repos/${targetRepo}/issues/${number}`], {
    attempts: TARGET_LOOKUP_RETRY_ATTEMPTS,
  });
}

function fetchIssueAsync(number: JsonValue) {
  return ghJsonAsync<LooseRecord>(["api", `repos/${targetRepo}/issues/${number}`], {
    attempts: TARGET_LOOKUP_RETRY_ATTEMPTS,
  });
}

function fetchPullRequestView(number: JsonValue) {
  return ghJson(pullRequestViewArgs(number), { attempts: TARGET_LOOKUP_RETRY_ATTEMPTS });
}

function pullRequestViewArgs(number: JsonValue) {
  return [
    "pr",
    "view",
    String(number),
    "--repo",
    targetRepo,
    "--json",
    [
      "additions",
      "headRefName",
      "headRefOid",
      "author",
      "baseRefName",
      "body",
      "changedFiles",
      "closingIssuesReferences",
      "commits",
      "deletions",
      "files",
      "isDraft",
      "labels",
      "mergeable",
      "mergeCommit",
      "mergeStateStatus",
      "mergedAt",
      "reviewDecision",
      "state",
      "statusCheckRollup",
      "title",
      "url",
    ].join(","),
  ];
}

function fetchPullRequestViewAsync(number: JsonValue) {
  return ghJsonAsync<LooseRecord>(pullRequestViewArgs(number), {
    attempts: TARGET_LOOKUP_RETRY_ATTEMPTS,
  });
}

function compactGhError(error: unknown): string {
  const text = ghErrorText(error).replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 240) : "unknown GitHub CLI error";
}

function resolveMaintainerCommandAuthorization(command: LooseRecord) {
  const login = String(command.author ?? "").trim();
  const repositoryPermission = login ? fetchCollaboratorPermission(login) : null;
  const authorizationInput = {
    authorAssociation: command.author_association,
    repositoryPermission,
    allowedAssociations,
    allowedRepositoryPermissions: [...allowedRepositoryPermissions],
  };
  const allowed = isMaintainerCommandAllowed(authorizationInput);
  if (allowed) return { allowed: true, repositoryPermission };
  const association = command.author_association || "unknown";
  const permission = repositoryPermission || "unknown";
  return {
    allowed: false,
    repositoryPermission,
    reason: `author association ${association} and repository permission ${permission} are not allowed`,
  };
}

function fetchCollaboratorPermission(login: JsonValue) {
  const key = login.toLowerCase();
  if (collaboratorPermissionCache.has(key)) return collaboratorPermissionCache.get(key);
  let permission = null;
  try {
    const result = ghJson([
      "api",
      `repos/${targetRepo}/collaborators/${encodeURIComponent(login)}/permission`,
    ]);
    permission = result?.permission ? String(result.permission).toLowerCase() : null;
  } catch (error) {
    if (error instanceof GitHubRateLimitError) throw error;
    permission = null;
  }
  collaboratorPermissionCache.set(key, permission);
  return permission;
}

async function fetchCollaboratorPermissionAsync(login: JsonValue) {
  const key = login.toLowerCase();
  if (collaboratorPermissionCache.has(key)) return collaboratorPermissionCache.get(key);
  let permission = null;
  try {
    const result = await ghJsonAsync<LooseRecord>([
      "api",
      `repos/${targetRepo}/collaborators/${encodeURIComponent(login)}/permission`,
    ]);
    permission = result?.permission ? String(result.permission).toLowerCase() : null;
  } catch (error) {
    if (error instanceof GitHubRateLimitError) throw error;
    permission = null;
  }
  collaboratorPermissionCache.set(key, permission);
  return permission;
}

function hasExistingResponse(
  number: JsonValue,
  commentId: JsonValue,
  intent: JsonValue,
  headSha: JsonValue,
) {
  const comments = cachedIssueComments(number);
  return comments.some(
    (comment: JsonValue) =>
      isTrustedStatusComment(comment) &&
      hasCommandResponseMarker(comment.body, { commentId, intent, headSha, matchAnyHead: true }),
  );
}

function postComment(command: LooseRecord, body: string) {
  const existingStatus = findExistingCommandStatusComment(command);
  const precreated = findPrecreatedCommandStatusComment(command);
  const existing = existingStatus ?? precreated;
  const ackMarker = existing ? commandAckMarkerFromBody(existing.body) : null;
  const nextBody = ackMarker && !body.includes(ackMarker) ? `${ackMarker}\n${body}` : body;
  const payloadPath = writePayload(repoRoot(), `comment-router-${command.comment_id}`, {
    body: nextBody,
  });
  if (existing?.id) {
    runGitHubTextMutation(
      command,
      "comment_update",
      {
        repository: command.repo,
        commentId: existing.id,
        bodySha256: commentBodySha256(nextBody),
      },
      [
        "api",
        `repos/${command.repo}/issues/comments/${existing.id}`,
        "--method",
        "PATCH",
        "--input",
        payloadPath,
      ],
    );
    issueCommentsCache.delete(Number(command.issue_number));
    const precreatedId = Number(precreated?.id ?? 0) || 0;
    const existingId = Number(existing.id ?? 0) || 0;
    if (existingStatus && precreatedId > 0 && precreatedId !== existingId) {
      runGitHubBestEffortMutation(
        command,
        "ack_comment_delete",
        { repository: command.repo, commentId: precreatedId },
        ["api", `repos/${command.repo}/issues/comments/${precreatedId}`, "--method", "DELETE"],
        githubNotFoundNoMutation,
      );
      issueCommentsCache.delete(Number(command.issue_number));
    }
    return {
      mode: "updated",
      comment_id: String(existing.id),
      ...(precreatedId > 0 && precreatedId !== existingId
        ? { pruned_ack_comment_id: String(precreatedId) }
        : {}),
    };
  }
  runGitHubTextMutation(
    command,
    "comment_create",
    {
      repository: command.repo,
      number: command.issue_number,
      bodySha256: commentBodySha256(nextBody),
    },
    [
      "api",
      `repos/${command.repo}/issues/${command.issue_number}/comments`,
      "--method",
      "POST",
      "--input",
      payloadPath,
    ],
  );
  issueCommentsCache.delete(Number(command.issue_number));
  return { mode: "created", comment_id: null };
}

function findPrecreatedCommandStatusComment(command: LooseRecord) {
  const converged = convergePrecreatedCommandAckComments(command);
  if (converged) return converged;
  const statusCommentId = Number(command.status_comment_id ?? 0);
  if (!Number.isInteger(statusCommentId) || statusCommentId <= 0) return null;
  const comment = fetchIssueComment(statusCommentId);
  if (!comment || !isTrustedStatusComment(comment)) return null;
  if (issueNumberFromUrl(comment.issue_url) !== Number(command.issue_number)) return null;
  if (commandAckMarkerFromBody(comment.body) !== commandAckMarker(command.comment_id)) return null;
  const statusMarker = commandStatusMarkerFromBody(comment.body);
  if (statusMarker && statusMarker !== commandStatusMarkerForCommand(command)) return null;
  return comment;
}

function convergePrecreatedCommandAckComments(command: LooseRecord) {
  if (!command.issue_number || !command.comment_id) return null;
  try {
    return convergePrecreatedCommandAckCommentsInner(command);
  } catch (error) {
    if (error instanceof GitHubRateLimitError) throw error;
    console.warn(
      `[comment-router] warning: fast ack convergence failed for ${command.repo}#${command.issue_number}: ${compactText(ghErrorText(error), 160)}`,
    );
    return null;
  }
}

function exactCommentVersionStillCurrent(command: LooseRecord) {
  try {
    return exactCommentVersionMatchesLive(command, fetchIssueComment(command.comment_id));
  } catch (error) {
    if (error instanceof GitHubRateLimitError) throw error;
    console.warn(
      `[comment-router] warning: exact comment cleanup verification failed for ${command.repo}#${command.issue_number}: ${compactText(ghErrorText(error), 160)}`,
    );
    return false;
  }
}

function convergeExactCommentVersionFastPathAck(command: LooseRecord, commentId: JsonValue) {
  const id = Number(commentId ?? 0);
  if (!Number.isInteger(id) || id <= 0) return "not_requested";
  try {
    const comment = fetchIssueComment(id);
    if (!comment) return "already_converged";
    if (!isTrustedStatusComment(comment)) return "skipped_untrusted";
    if (issueNumberFromUrl(comment.issue_url) !== Number(command.issue_number))
      return "skipped_item_mismatch";
    const ackMarker = commandAckMarker(command.comment_id);
    if (commandAckMarkerFromBody(comment.body) !== ackMarker) return "skipped_marker_mismatch";
    if (commandStatusMarkerFromBody(comment.body)) return "already_terminal";
    const terminal = exactCommentVersionTerminalResponse(command, id);
    const terminalBody =
      String(terminal?.body ?? "").trim() || exactCommentVersionMissingTerminalBody(command);
    const body = terminalBody.includes(ackMarker) ? terminalBody : `${ackMarker}\n${terminalBody}`;
    const payloadPath = writePayload(repoRoot(), `comment-router-fast-path-${id}`, { body });
    runGitHubTextMutation(
      command,
      "ack_comment_update",
      { repository: command.repo, commentId: id, bodySha256: commentBodySha256(body) },
      [
        "api",
        `repos/${command.repo}/issues/comments/${id}`,
        "--method",
        "PATCH",
        "--input",
        payloadPath,
      ],
      {},
      githubNotFoundNoMutation,
    );
    issueCommentsCache.delete(Number(command.issue_number));
    return "updated";
  } catch (error) {
    if (error instanceof GitHubRateLimitError) throw error;
    if (githubNotFoundNoMutation(error)) return "already_converged";
    console.warn(
      `[comment-router] warning: exact comment acknowledgement convergence failed for ${command.repo}#${command.issue_number}: ${compactText(ghErrorText(error), 160)}`,
    );
    return "failed";
  }
}

function exactCommentVersionTerminalResponse(command: LooseRecord, excludeId: number) {
  const markerId = command.comment_version_key ?? command.comment_id;
  return cachedIssueComments(command.issue_number)
    .slice()
    .reverse()
    .find((comment: JsonValue) => {
      if (Number(comment.id ?? 0) === excludeId || !isTrustedStatusComment(comment)) return false;
      return hasCommandResponseMarker(comment.body, {
        commentId: markerId,
        intent: command.intent,
        matchAnyHead: true,
      });
    });
}

function exactCommentVersionMissingTerminalBody(command: LooseRecord) {
  return [
    commandStatusMarkerForCommand(command),
    commandResponseMarker(
      command.comment_version_key ?? command.comment_id,
      command.intent,
      command.target?.head_sha ?? "na",
    ),
    "ClawSweeper already handled this exact command version.",
    "",
    "The original detailed response is no longer available. Run the command again for a fresh result.",
  ].join("\n");
}

function exactCommentVersionAckFailed(result: string) {
  return !["not_requested", "updated", "already_terminal", "already_converged"].includes(result);
}

function convergePrecreatedCommandAckCommentsInner(command: LooseRecord) {
  const marker = commandAckMarker(command.comment_id);
  const comments = cachedIssueComments(command.issue_number).filter(
    (comment: JsonValue) =>
      isTrustedStatusComment(comment) && commandAckMarkerFromBody(comment.body) === marker,
  );
  if (comments.length === 0) return null;
  const { keep, prunable } = planCommandAckConvergence(
    comments as LooseRecord[],
    commandStatusMarkerForCommand(command),
  );
  if (!keep) return null;
  let deleted = false;
  for (const comment of prunable) {
    const id = Number(comment.id ?? 0) || 0;
    if (id <= 0) continue;
    runGitHubBestEffortMutation(
      command,
      "ack_comment_delete",
      { repository: command.repo, commentId: id },
      ["api", `repos/${command.repo}/issues/comments/${id}`, "--method", "DELETE"],
      githubNotFoundNoMutation,
    );
    deleted = true;
  }
  if (deleted) issueCommentsCache.delete(Number(command.issue_number));
  return keep;
}

function findExistingCommandStatusComment(command: LooseRecord) {
  const marker = commandStatusMarkerForCommand(command);
  const responseId = command.comment_version_key ?? command.comment_id;
  return cachedIssueComments(command.issue_number)
    .slice()
    .reverse()
    .find((comment: JsonValue) => {
      if (!isTrustedStatusComment(comment)) return false;
      const body = String(comment.body ?? "");
      return (
        hasCommandResponseMarker(body, {
          commentId: responseId,
          intent: command.intent,
          matchAnyHead: true,
        }) ||
        (!command.retired && body.includes(marker))
      );
    });
}

function isTrustedStatusComment(comment: LooseRecord) {
  return isTrustedStatusCommentAuthor(comment, trustedBots);
}

function reactToComment(command: LooseRecord, content: string) {
  if (!command.comment_id) return;
  const payloadPath = writePayload(
    repoRoot(),
    `comment-router-reaction-${command.comment_id}-${content}`,
    { content },
  );
  try {
    runGitHubTextMutation(
      command,
      "reaction_add",
      {
        repository: command.repo,
        commentId: command.comment_id,
        content,
      },
      [
        "api",
        `repos/${command.repo}/issues/comments/${command.comment_id}/reactions`,
        "--method",
        "POST",
        "--input",
        payloadPath,
      ],
      {},
      githubAlreadyExistsNoMutation,
    );
  } catch (error) {
    if (error instanceof GitHubRateLimitError) throw error;
    const message = stripAnsi(error?.message ?? error);
    if (/already exists/i.test(message) || /\b422\b/.test(message)) return;
    console.warn(
      `warning: failed to add ${content} reaction to comment ${command.comment_id}: ${message}`,
    );
  }
}

function clearTerminalMaintainerCommandReaction(command: LooseRecord) {
  if (!shouldClearMaintainerCommandReaction(command)) return;
  removeOwnCommentReaction(command, "eyes");
}

function removeOwnCommentReaction(command: LooseRecord, content: string) {
  if (!command.comment_id) return "not_applicable";
  let reactions: LooseRecord[] = [];
  try {
    const fetched = ghJson<LooseRecord[]>(
      [
        "api",
        `repos/${command.repo}/issues/comments/${command.comment_id}/reactions?content=${encodeURIComponent(content)}`,
      ],
      { attempts: 1 },
    );
    if (Array.isArray(fetched)) reactions = fetched;
  } catch (error) {
    if (error instanceof GitHubRateLimitError) throw error;
    const message = compactText(ghErrorText(error), 220);
    console.warn(
      `warning: failed to list ${content} reactions for comment ${command.comment_id}: ${message}`,
    );
    return "list_failed";
  }

  let matched = false;
  let removed = false;
  let deleteFailed = false;
  for (const reaction of reactions) {
    if (!isOwnCommentReaction(reaction, content)) continue;
    matched = true;
    try {
      runGitHubTextMutation(
        command,
        "reaction_delete",
        {
          repository: command.repo,
          commentId: command.comment_id,
          reactionId: reaction.id,
          content,
        },
        [
          "api",
          `repos/${command.repo}/issues/comments/${command.comment_id}/reactions/${reaction.id}`,
          "--method",
          "DELETE",
        ],
        { attempts: 1 },
        githubNotFoundNoMutation,
      );
      removed = true;
    } catch (error) {
      if (error instanceof GitHubRateLimitError) throw error;
      const message = compactText(ghErrorText(error), 220);
      if (/\b404\b|not found/i.test(message)) continue;
      deleteFailed = true;
      console.warn(
        `warning: failed to delete ${content} reaction ${reaction.id} from comment ${command.comment_id}: ${message}`,
      );
    }
  }
  if (deleteFailed) return "delete_failed";
  if (removed) return "removed";
  return matched ? "already_absent" : "not_found";
}

function isOwnCommentReaction(reaction: LooseRecord, content: string) {
  if (String(reaction?.content ?? "").toLowerCase() !== content.toLowerCase()) return false;
  const login = String(reaction?.user?.login ?? "").toLowerCase();
  return isAllowedMutationActor(login, DEFAULT_TRUSTED_BOTS);
}

function ensureHumanReviewLabel(command: LooseRecord) {
  ensureLabel(command, HUMAN_REVIEW_LABEL, "B60205", "ClawSweeper is paused for maintainer review");
}

function ensureLabel(command: LooseRecord, label: string, color: string, description: string) {
  runGitHubBestEffortMutation(
    command,
    "label_create",
    { repository: command.repo, label },
    [
      "label",
      "create",
      label,
      "--repo",
      command.repo,
      "--color",
      color,
      "--description",
      description,
    ],
    githubAlreadyExistsNoMutation,
  );
}

function hasLabel(target: LooseRecord, name: string) {
  return (target?.labels ?? []).some(
    (labelName: JsonValue) => String(labelName).toLowerCase() === String(name).toLowerCase(),
  );
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = Array.from<R>({ length: items.length });
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

function deferGitHubThrottle(error: GitHubRateLimitError) {
  deferredGitHubThrottle ??= error;
}

function ledgerPath() {
  return path.join(repoRoot(), "results", "comment-router.json");
}

function exactCommentVersionVerificationLedgers() {
  const stateDir = String(process.env.CLAWSWEEPER_STATE_DIR ?? "").trim();
  if (!stateDir) return [];
  const stateLedgerPath = path.join(path.resolve(stateDir), "results", "comment-router.json");
  if (!fs.existsSync(stateLedgerPath)) return [];
  return [readLedger(stateLedgerPath), readLedger(ledgerPath())];
}

function exactCommentVersionLedgerCommand(commentVersionKey: JsonValue) {
  const matches = (Array.isArray(ledger.commands) ? ledger.commands : []).filter(
    (entry: JsonValue) => entry?.comment_version_key === commentVersionKey,
  );
  return matches.length === 1 ? matches[0] : null;
}

function idempotencyKey(
  parsed: LooseRecord,
  issueNumber: JsonValue,
  commentId: JsonValue,
  commentUpdatedAt: JsonValue,
) {
  return `comment-router:${targetRepo}:${issueNumber}:${commentId}:${commentUpdatedAt ?? "unknown"}:${parsed.intent}`;
}

function commentVersionKey(entry: LooseRecord) {
  const id = entry?.comment_id;
  const updatedAt = entry?.comment_updated_at;
  if (!id || !updatedAt) return null;
  return `${id}:${updatedAt}`;
}
