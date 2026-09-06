#!/usr/bin/env node
import { setTimeout as sleep } from "node:timers/promises";
import { appendFileSync } from "node:fs";
import { ghJsonWithRetry, ghPagedWithRetry, ghText } from "./github-cli.js";
import { isLockedConversationCommentError } from "../github-retry.js";
import type { JsonValue, LooseRecord } from "./json-types.js";
import { repoRoot } from "./paths.js";
import { DEFAULT_TRUSTED_BOTS } from "./config.js";
import {
  commaSet,
  commentBodySha256,
  isAllowedMutationActor,
  issueNumberFromUrl,
  writePayload,
} from "./comment-router-utils.js";
import {
  flushCommandActionEvents,
  recordCommandLifecycleFailure,
  recordCommandProgress,
  runCommandLifecycleMutation,
  type CommandLifecycleInput,
} from "./command-action-ledger.js";
import {
  COMMAND_PROGRESS_START as PROGRESS_START,
  commandAckMarkerFromBody,
  commandStatusMarkerFromBody,
  compareCommentsByCreatedAt,
  isPrunableCommandAckDuplicate,
  legacyCommandCommentId,
  selectCommandAckKeeper,
  statusMarkerDiffersFromRequested,
} from "./command-ack-convergence.js";

const PROGRESS_END = "<!-- clawsweeper-command-progress:end -->";

type Options = {
  repo: string;
  itemNumber: string;
  marker: string;
  statusCommentId: number | null;
  trustedBots: Set<string>;
  state: string;
  detail: string;
  runUrl: string;
  waitMs: number;
  requireMutation: boolean;
  lockedConversationTerminalSkip: boolean;
  verifyTerminalStatusReceipt: boolean;
};

type CommandStatusUpdateOutcome =
  | "completed"
  | "unchanged"
  | "skipped"
  | "locked_conversation"
  | "missing_status_comment";

type TerminalStatusReceipt = {
  commandCommentId: number;
  completionCommentId: number;
};

type CommandStatusUpdateResult = {
  outcome: CommandStatusUpdateOutcome;
  terminalStatusReceipt?: TerminalStatusReceipt;
  terminalStatusCompletedAt?: string;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseOptions(process.argv.slice(2));
  await runCommandStatusUpdate(options);
}

async function updateCommandStatus(options: Options): Promise<CommandStatusUpdateResult> {
  const lifecycle = commandStatusLifecycle(options);
  if (!options.marker && !options.statusCommentId) {
    recordCommandProgress(lifecycle, {
      state: options.state,
      status: "skipped",
      mutation: false,
    });
    if (options.requireMutation)
      throw new Error("command status mutation required but no address was provided");
    return { outcome: "skipped" };
  }
  validateRepo(options.repo);
  validateItemNumber(options.itemNumber);
  let comment: LooseRecord | null;
  try {
    comment = await findCommandStatusComment(options, lifecycle);
  } catch (error) {
    if (!recordTerminalLockedConversationSkip(options, lifecycle, error)) throw error;
    return { outcome: "locked_conversation" };
  }
  if (!comment?.id || typeof comment.body !== "string") {
    console.warn(`No command status comment found for ${options.repo}#${options.itemNumber}.`);
    if (options.requireMutation && options.verifyTerminalStatusReceipt) {
      // Terminal-acknowledgement finalization: the status comment was deleted
      // (or never existed), so there is nothing left to acknowledge. Surface a
      // dedicated outcome so the workflow can complete a durable skip instead
      // of requeueing the driver forever.
      console.warn("Command status update skipped because the command status comment is missing.");
      recordCommandProgress(lifecycle, {
        state: "missing_status_comment",
        status: "skipped",
        mutation: false,
      });
      return { outcome: "missing_status_comment" };
    }
    recordCommandProgress(lifecycle, {
      state: options.state,
      status: "skipped",
      mutation: false,
    });
    if (options.requireMutation)
      throw new Error("command status mutation required but no comment was found");
    return { outcome: "skipped" };
  }
  const terminalStatusReceipt = verifiedTerminalStatusReceipt(comment, options);
  if (terminalStatusReceipt) {
    recordCommandProgress(lifecycle, {
      state: options.state,
      status: "unchanged",
      mutation: false,
    });
    return {
      outcome: "unchanged",
      terminalStatusReceipt,
      terminalStatusCompletedAt: verifiedTerminalStatusCompletedAt(comment),
    };
  }
  const body = mergeCommandProgressSection(comment.body, options);
  if (body === comment.body) {
    recordCommandProgress(lifecycle, {
      state: options.state,
      status: "unchanged",
      mutation: false,
    });
    return { outcome: "unchanged" };
  }
  const payload = writePayload(repoRoot(), `command-status-progress-${comment.id}`, { body });
  let mutationResponse: string;
  try {
    mutationResponse = runCommandLifecycleMutation(lifecycle, {
      kind: "status_comment_update",
      identity: {
        repository: options.repo,
        commentId: comment.id,
        bodySha256: commentBodySha256(body),
      },
      component: "command_status",
      operation: () =>
        ghText([
          "api",
          `repos/${options.repo}/issues/comments/${comment.id}`,
          "--method",
          "PATCH",
          "--input",
          payload,
        ]),
    });
  } catch (error) {
    if (!recordTerminalLockedConversationSkip(options, lifecycle, error)) throw error;
    return { outcome: "locked_conversation" };
  }
  recordCommandProgress(lifecycle, {
    state: options.state,
    status: "completed",
    mutation: true,
  });
  const verifiedReceipt = verifiedTerminalStatusReceipt({ ...comment, body }, options);
  return {
    outcome: "completed",
    ...(verifiedReceipt
      ? {
          terminalStatusReceipt: verifiedReceipt,
          terminalStatusCompletedAt: verifiedTerminalStatusCompletedAt(
            JSON.parse(mutationResponse),
          ),
        }
      : {}),
  };
}

export async function runCommandStatusUpdate(options: Options) {
  let commandError: unknown = null;
  let outcome: CommandStatusUpdateOutcome | null = null;
  let terminalStatusReceipt: TerminalStatusReceipt | undefined;
  let terminalStatusCompletedAt: string | undefined;
  try {
    const result = await updateCommandStatus(options);
    outcome = result.outcome;
    terminalStatusReceipt = result.terminalStatusReceipt;
    terminalStatusCompletedAt = result.terminalStatusCompletedAt;
  } catch (error) {
    commandError = error;
    recordCommandLifecycleFailure(commandStatusLifecycle(options), {
      component: "command_status",
      error,
    });
  }
  try {
    await flushCommandActionEvents();
  } catch (error) {
    if (commandError) {
      console.error(
        `[action-ledger] failed to finalize command status receipts: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } else {
      commandError = error;
    }
  }
  if (!commandError && outcome === "locked_conversation" && process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, "locked_conversation=true\n");
  }
  if (!commandError && outcome === "missing_status_comment" && process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, "missing_status_comment=true\n");
  }
  if (!commandError && terminalStatusReceipt && process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        "terminal_status_verified=true",
        `command_comment_id=${terminalStatusReceipt.commandCommentId}`,
        `completion_comment_id=${terminalStatusReceipt.completionCommentId}`,
        `completion_completed_at=${terminalStatusCompletedAt}`,
        "",
      ].join("\n"),
    );
  }
  if (commandError) throw commandError;
}

function verifiedTerminalStatusCompletedAt(comment: LooseRecord): string {
  const completedAt = String(comment.updated_at ?? "").trim();
  if (!completedAt || !Number.isFinite(Date.parse(completedAt))) {
    throw new Error("verified terminal status comment has no valid update timestamp");
  }
  return completedAt;
}

export function terminalLockedConversationSkip(
  options: Pick<Options, "lockedConversationTerminalSkip">,
  error: unknown,
) {
  return options.lockedConversationTerminalSkip && isLockedConversationCommentError(error);
}

function recordTerminalLockedConversationSkip(
  options: Options,
  lifecycle: CommandLifecycleInput,
  error: unknown,
) {
  if (!terminalLockedConversationSkip(options, error)) return false;
  console.warn("Command status update skipped because the conversation is locked.");
  recordCommandProgress(lifecycle, {
    state: "locked_conversation",
    status: "skipped",
    mutation: false,
  });
  return true;
}

function commandStatusLifecycle(options: Options): CommandLifecycleInput {
  return {
    repository: options.repo,
    number: Number(options.itemNumber),
    operationKey: `command-status:${
      options.marker || options.statusCommentId || `${options.repo}#${options.itemNumber}`
    }`,
  };
}

async function findCommandStatusComment(
  options: Options,
  lifecycle: CommandLifecycleInput,
): Promise<LooseRecord | null> {
  const deadline = Date.now() + Math.max(0, options.waitMs);
  while (true) {
    const exact = fetchExactStatusComment(options);
    if (
      exact &&
      !commandAckMarkerFromBody(exact.body) &&
      !statusMarkerDiffersFromRequested(exact.body, options.marker)
    ) {
      return exact;
    }
    let comments: LooseRecord[];
    try {
      comments = ghPagedWithRetry<LooseRecord>(
        `repos/${options.repo}/issues/${options.itemNumber}/comments?per_page=100`,
        { attempts: 3 },
      );
    } catch (error) {
      if (exact && !statusMarkerDiffersFromRequested(exact.body, options.marker)) return exact;
      throw error;
    }
    const match = selectCommandStatusComment(comments, options);
    if (match) {
      if (
        options.statusCommentId &&
        Number(match.id) !== options.statusCommentId &&
        (!exact || statusMarkerDiffersFromRequested(exact.body, options.marker))
      ) {
        options.statusCommentId = Number(match.id);
      }
      pruneDuplicateCommandAckComments({ comments, keep: match, options, lifecycle });
      return match;
    }
    if (exact && !statusMarkerDiffersFromRequested(exact.body, options.marker)) return exact;
    if (Date.now() >= deadline) break;
    await sleep(5000);
  }
  return null;
}

function fetchExactStatusComment(
  options: Pick<Options, "repo" | "itemNumber" | "statusCommentId" | "trustedBots">,
) {
  if (!options.statusCommentId) return null;
  try {
    const comment = ghJsonWithRetry<LooseRecord>(
      ["api", `repos/${options.repo}/issues/comments/${options.statusCommentId}`],
      { attempts: 3 },
    );
    if (!isTrustedStatusComment(comment, options.trustedBots)) return null;
    if (issueNumberFromUrl(comment.issue_url) !== Number(options.itemNumber)) return null;
    return comment;
  } catch {
    return null;
  }
}

export function selectCommandStatusComment(
  comments: LooseRecord[],
  options: Pick<Options, "marker" | "statusCommentId" | "trustedBots">,
) {
  if (options.statusCommentId) {
    const exact = comments.find(
      (comment) =>
        Number(comment.id ?? 0) === options.statusCommentId &&
        isTrustedStatusComment(comment, options.trustedBots),
    );
    if (exact) {
      const match = matchingAckCommentForStatus(comments, exact, options);
      if (match) return match;
      if (!statusMarkerDiffersFromRequested(exact.body, options.marker)) return exact;
    }
  }
  if (!options.marker) return null;
  return (
    comments
      .filter(
        (comment) =>
          isTrustedStatusComment(comment, options.trustedBots) &&
          typeof comment.body === "string" &&
          comment.body.includes(options.marker),
      )
      .at(-1) ?? null
  );
}

function matchingAckCommentForStatus(
  comments: LooseRecord[],
  exact: LooseRecord,
  options: Pick<Options, "marker" | "trustedBots">,
) {
  const ackMarker = commandAckMarkerFromBody(exact.body);
  if (!ackMarker) return null;
  const matching = commandAckComments(comments, ackMarker, options.trustedBots);
  const sameStatus = options.marker
    ? matching.filter((comment) => String(comment.body ?? "").includes(options.marker))
    : [];
  if (sameStatus.length > 0) return selectCommandAckKeeper(sameStatus);
  if (matching.some((comment) => commandStatusMarkerFromBody(comment.body))) return null;
  return selectCommandAckKeeper(matching);
}

function pruneDuplicateCommandAckComments({
  comments,
  keep,
  options,
  lifecycle,
}: {
  comments: LooseRecord[];
  keep: LooseRecord;
  options: Pick<Options, "marker" | "repo" | "trustedBots">;
  lifecycle: CommandLifecycleInput;
}) {
  const marker = commandAckMarkerFromBody(keep.body);
  if (!marker) return;
  const matching = commandAckComments(comments, marker, options.trustedBots);
  const keepId = Number(keep.id ?? 0) || 0;
  for (const comment of matching) {
    const id = Number(comment.id ?? 0) || 0;
    if (id <= 0 || id === keepId) continue;
    if (!isPrunableCommandAckDuplicate(comment, options.marker)) continue;
    try {
      runCommandLifecycleMutation(lifecycle, {
        kind: "ack_comment_delete",
        identity: { repository: options.repo, commentId: id },
        component: "command_status",
        operation: () =>
          ghText(["api", `repos/${options.repo}/issues/comments/${id}`, "--method", "DELETE"]),
        knownNoMutation: (error) => /\b404\b|Not Found/i.test(String(error)),
      });
    } catch (error) {
      if (!/\b404\b|Not Found/i.test(String(error))) throw error;
    }
  }
}

function commandAckComments(comments: LooseRecord[], marker: string, trustedBots: Set<string>) {
  return comments
    .filter(
      (comment) =>
        isTrustedStatusComment(comment, trustedBots) &&
        typeof comment.body === "string" &&
        commandAckMarkerFromBody(comment.body) === marker,
    )
    .sort(compareCommentsByCreatedAt);
}

export function mergeCommandProgressSection(
  body: string,
  options: Pick<Options, "state" | "detail" | "runUrl">,
) {
  const section = renderCommandProgressSection(options);
  const start = body.indexOf(PROGRESS_START);
  const end = body.indexOf(PROGRESS_END);
  if (start >= 0 && end > start) {
    return `${body.slice(0, start).trimEnd()}\n\n${section}\n${body.slice(end + PROGRESS_END.length).trimStart()}`;
  }
  return `${body.trimEnd()}\n\n${section}`;
}

export function verifiedTerminalStatusReceipt(
  comment: Pick<LooseRecord, "id" | "body">,
  options: Pick<
    Options,
    "verifyTerminalStatusReceipt" | "marker" | "statusCommentId" | "state" | "detail"
  >,
): TerminalStatusReceipt | null {
  if (!options.verifyTerminalStatusReceipt || (!options.marker && !options.statusCommentId))
    return null;
  const completionCommentId = Number(comment.id);
  const commandCommentIds = commandAckCommentIdsFromBody(comment.body);
  const statusMarkers = commandStatusMarkersFromBody(comment.body);
  if (
    !Number.isSafeInteger(completionCommentId) ||
    !terminalProgressMatches(comment.body, options)
  ) {
    return null;
  }
  if (options.marker) {
    if (statusMarkers.length !== 1 || statusMarkers[0] !== options.marker) {
      return null;
    }
    const commandCommentId =
      commandCommentIds.length === 1
        ? commandCommentIds[0]!
        : commandCommentIds.length === 0 &&
            !hasCommandAckMarker(comment.body) &&
            (options.statusCommentId === null || completionCommentId === options.statusCommentId)
          ? (legacyCommandCommentId(comment.body, options.marker) ??
            syntheticLegacyCommandCommentId(comment.body, options.marker, completionCommentId))
          : null;
    return commandCommentId === null ? null : { commandCommentId, completionCommentId };
  }
  const statusCommentId = options.statusCommentId;
  if (
    statusCommentId === null ||
    !Number.isSafeInteger(statusCommentId) ||
    statusCommentId < 1 ||
    completionCommentId !== statusCommentId ||
    commandCommentIds.length !== 1 ||
    statusMarkers.length !== 0
  ) {
    return null;
  }
  return { commandCommentId: commandCommentIds[0]!, completionCommentId };
}

function terminalProgressMatches(body: JsonValue, options: Pick<Options, "state" | "detail">) {
  const progressBlocks = Array.from(
    String(body ?? "").matchAll(
      /<!--\s*clawsweeper-command-progress:start\s*-->([\s\S]*?)<!--\s*clawsweeper-command-progress:end\s*-->/gi,
    ),
  );
  if (progressBlocks.length !== 1) return false;
  const lines = progressBlocks[0]![1]!.split(/\r?\n/).map((line) => line.trimEnd());
  const stateLines = lines.filter((line) => line.startsWith("- State: "));
  const detailLines = lines.filter((line) => line.startsWith("- Detail: "));
  return (
    stateLines.length === 1 &&
    detailLines.length === 1 &&
    stateLines[0] === `- State: ${options.state}` &&
    detailLines[0] === `- Detail: ${options.detail}`
  );
}

function commandAckCommentIdsFromBody(body: JsonValue) {
  return Array.from(
    String(body ?? "").matchAll(/<!--\s*clawsweeper-command-ack:(\d+)\s*-->/g),
    (match) => Number(match[1]),
  ).filter((id) => Number.isSafeInteger(id) && id > 0);
}

function hasCommandAckMarker(body: JsonValue) {
  return /<!--\s*clawsweeper-command-ack:[^>]*-->/.test(String(body ?? ""));
}

function syntheticLegacyCommandCommentId(
  body: JsonValue,
  statusMarker: string,
  completionCommentId: number,
) {
  const status = /^<!--\s*clawsweeper-command-status:(\d+):([^:\s>]+):([^:\s>]+)\s*-->$/.exec(
    statusMarker,
  );
  if (!status) return null;
  const commandMarkers = Array.from(
    String(body ?? "").matchAll(/<!--\s*clawsweeper-command:[^>]+-->/g),
  );
  if (commandMarkers.length !== 1) return null;
  const syntheticCommands = Array.from(
    String(body ?? "").matchAll(
      /<!--\s*clawsweeper-command:repair-loop-label-sweep:(autofix|automerge):(\d+):(autofix|automerge):([^:\s>]+)\s*-->/g,
    ),
  );
  if (
    syntheticCommands.length !== 1 ||
    syntheticCommands[0]![1] !== status[2] ||
    syntheticCommands[0]![2] !== status[1] ||
    syntheticCommands[0]![3] !== status[2] ||
    syntheticCommands[0]![4] !== status[3]
  ) {
    return null;
  }
  return completionCommentId;
}

function commandStatusMarkersFromBody(body: JsonValue) {
  return Array.from(
    String(body ?? "").matchAll(/<!--\s*clawsweeper-command-status:[^>]+-->/g),
    (match) => match[0],
  );
}

function renderCommandProgressSection(options: Pick<Options, "state" | "detail" | "runUrl">) {
  const lines = [
    PROGRESS_START,
    "Re-review progress:",
    `- State: ${options.state}`,
    `- Detail: ${options.detail}`,
  ];
  if (options.runUrl) lines.push(`- Run: ${options.runUrl}`);
  lines.push(`- Updated: ${new Date().toISOString()}`, PROGRESS_END);
  return lines.join("\n");
}

export function parseOptions(argv: string[]): Options {
  const args: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = "true";
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return {
    repo: args.repo ?? process.env.TARGET_REPO ?? "",
    itemNumber: args["item-number"] ?? process.env.ITEM_NUMBER ?? "",
    marker: args.marker ?? process.env.COMMAND_STATUS_MARKER ?? "",
    statusCommentId: optionalNumber(args["status-comment-id"] ?? process.env.STATUS_COMMENT_ID),
    trustedBots: commaSet(
      args["trusted-bots"] ??
        process.env.CLAWSWEEPER_TRUSTED_BOTS ??
        DEFAULT_TRUSTED_BOTS.join(","),
    ),
    state: args.state ?? process.env.COMMAND_STATUS_STATE ?? "",
    detail: args.detail ?? process.env.COMMAND_STATUS_DETAIL ?? "",
    runUrl: args["run-url"] ?? process.env.RUN_URL ?? "",
    waitMs: Number.parseInt(args["wait-ms"] ?? process.env.COMMAND_STATUS_WAIT_MS ?? "0", 10) || 0,
    requireMutation:
      (args["require-mutation"] ?? process.env.COMMAND_STATUS_REQUIRE_MUTATION ?? "") === "true",
    lockedConversationTerminalSkip:
      (args["locked-conversation-terminal-skip"] ??
        process.env.COMMAND_STATUS_LOCKED_CONVERSATION_TERMINAL_SKIP ??
        "") === "true",
    verifyTerminalStatusReceipt:
      (args["verify-terminal-status-receipt"] ??
        process.env.COMMAND_STATUS_VERIFY_TERMINAL_RECEIPT ??
        "") === "true",
  };
}

function validateRepo(repo: string) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`invalid repo: ${repo}`);
  }
}

function validateItemNumber(itemNumber: JsonValue) {
  if (!/^[0-9]+$/.test(String(itemNumber ?? ""))) {
    throw new Error(`invalid item number: ${itemNumber}`);
  }
}

function optionalNumber(value: JsonValue) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`invalid status comment id: ${value}`);
  }
  return number;
}

function isTrustedStatusComment(comment: LooseRecord, trustedBots: Set<string>) {
  return (
    isAllowedMutationActor(comment.user?.login, trustedBots) &&
    typeof comment.body === "string" &&
    !comment.body.includes("<!-- mantis-")
  );
}
