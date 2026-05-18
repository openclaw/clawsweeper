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
  await updateCommandStatus(options);
}

async function updateCommandStatus(options: Options) {
  if (!options.marker && !options.statusCommentId) return;
  validateRepo(options.repo);
  validateItemNumber(options.itemNumber);
  const comment = await findCommandStatusComment(options);
  if (!comment?.id || typeof comment.body !== "string") {
    console.warn(`No command status comment found for ${options.repo}#${options.itemNumber}.`);
    return;
  }
  const body = mergeCommandProgressSection(comment.body, options);
  if (body === comment.body) return;
  const payload = writePayload(repoRoot(), `command-status-progress-${comment.id}`, { body });
  ghText([
    "api",
    `repos/${options.repo}/issues/comments/${comment.id}`,
    "--method",
    "PATCH",
    "--input",
    payload,
  ]);
}

async function findCommandStatusComment(options: Options): Promise<LooseRecord | null> {
  const deadline = Date.now() + Math.max(0, options.waitMs);
  let shouldContinue = true;
  while (shouldContinue) {
    const exact = fetchExactStatusComment(options);
    if (exact) return exact;
    const comments = ghPagedWithRetry<LooseRecord>(
      `repos/${options.repo}/issues/${options.itemNumber}/comments?per_page=100`,
      { attempts: 3 },
    );
    const match = selectCommandStatusComment(comments, options);
    if (match) return match;
    shouldContinue = Date.now() < deadline;
    if (!shouldContinue) break;
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
    if (exact) return exact;
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
