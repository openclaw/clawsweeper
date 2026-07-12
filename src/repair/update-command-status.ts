#!/usr/bin/env node
import { setTimeout as sleep } from "node:timers/promises";
import { ghJsonWithRetry, ghPagedWithRetry, ghText } from "./github-cli.js";
import type { JsonValue, LooseRecord } from "./json-types.js";
import { repoRoot } from "./paths.js";
import { DEFAULT_TRUSTED_BOTS } from "./config.js";
import {
  commaSet,
  isAllowedMutationActor,
  issueNumberFromUrl,
  writePayload,
} from "./comment-router-utils.js";
import {
  flushCommandActionEvents,
  recordCommandLifecycleFailure,
  recordCommandProgress,
  type CommandLifecycleInput,
} from "./command-action-ledger.js";

const PROGRESS_START = "<!-- clawsweeper-command-progress:start -->";
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
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseOptions(process.argv.slice(2));
  await runCommandStatusUpdate(options);
}

async function updateCommandStatus(options: Options) {
  const lifecycle = commandStatusLifecycle(options);
  if (!options.marker && !options.statusCommentId) {
    recordCommandProgress(lifecycle, {
      state: options.state,
      status: "skipped",
      mutation: false,
    });
    return;
  }
  validateRepo(options.repo);
  validateItemNumber(options.itemNumber);
  const comment = await findCommandStatusComment(options);
  if (!comment?.id || typeof comment.body !== "string") {
    console.warn(`No command status comment found for ${options.repo}#${options.itemNumber}.`);
    recordCommandProgress(lifecycle, {
      state: options.state,
      status: "skipped",
      mutation: false,
    });
    return;
  }
  const body = mergeCommandProgressSection(comment.body, options);
  if (body === comment.body) {
    recordCommandProgress(lifecycle, {
      state: options.state,
      status: "unchanged",
      mutation: false,
    });
    return;
  }
  const payload = writePayload(repoRoot(), `command-status-progress-${comment.id}`, { body });
  ghText([
    "api",
    `repos/${options.repo}/issues/comments/${comment.id}`,
    "--method",
    "PATCH",
    "--input",
    payload,
  ]);
  recordCommandProgress(lifecycle, {
    state: options.state,
    status: "completed",
    mutation: true,
  });
}

async function runCommandStatusUpdate(options: Options) {
  let commandError: unknown = null;
  try {
    await updateCommandStatus(options);
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
  if (commandError) throw commandError;
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

async function findCommandStatusComment(options: Options): Promise<LooseRecord | null> {
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
      pruneDuplicateCommandAckComments({ comments, keep: match, options });
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
}: {
  comments: LooseRecord[];
  keep: LooseRecord;
  options: Pick<Options, "marker" | "repo" | "trustedBots">;
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
      ghText(["api", `repos/${options.repo}/issues/comments/${id}`, "--method", "DELETE"]);
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

function commandAckMarkerFromBody(body: JsonValue) {
  return String(body ?? "").match(/<!--\s*clawsweeper-command-ack:\d+\s*-->/)?.[0] ?? null;
}

function commandStatusMarkerFromBody(body: JsonValue) {
  return (
    String(body ?? "").match(new RegExp("<!--\\s*clawsweeper-command-status:[^>]+-->"))?.[0] ?? null
  );
}

function statusMarkerDiffersFromRequested(body: JsonValue, requestedStatusMarker: string) {
  const statusMarker = commandStatusMarkerFromBody(body);
  return Boolean(requestedStatusMarker && statusMarker && statusMarker !== requestedStatusMarker);
}

function isPrunableCommandAckDuplicate(comment: LooseRecord, requestedStatusMarker: string) {
  const statusMarker = commandStatusMarkerFromBody(comment.body);
  return !statusMarker || statusMarker === requestedStatusMarker;
}

function selectCommandAckKeeper(comments: LooseRecord[]) {
  return [...comments].sort(compareCommandAckKeepPriority)[0] ?? null;
}

function compareCommandAckKeepPriority(left: LooseRecord, right: LooseRecord) {
  const leftStatus = commandAckStatusScore(left);
  const rightStatus = commandAckStatusScore(right);
  if (leftStatus !== rightStatus) return rightStatus - leftStatus;
  if (leftStatus > 0) return compareCommentsByUpdatedAtDesc(left, right);
  return compareCommentsByCreatedAt(left, right);
}

function commandAckStatusScore(comment: LooseRecord) {
  const body = String(comment.body ?? "");
  return body.includes("clawsweeper-command-status:") || body.includes(PROGRESS_START) ? 1 : 0;
}

function compareCommentsByUpdatedAtDesc(left: LooseRecord, right: LooseRecord) {
  const leftUpdated = String(left.updated_at ?? left.created_at ?? "");
  const rightUpdated = String(right.updated_at ?? right.created_at ?? "");
  return (
    rightUpdated.localeCompare(leftUpdated) || (Number(right.id) || 0) - (Number(left.id) || 0)
  );
}

function compareCommentsByCreatedAt(left: LooseRecord, right: LooseRecord) {
  const leftCreated = String(left.created_at ?? "");
  const rightCreated = String(right.created_at ?? "");
  return (
    leftCreated.localeCompare(rightCreated) || (Number(left.id) || 0) - (Number(right.id) || 0)
  );
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
