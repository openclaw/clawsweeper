export type ClawSweeperCommandTrigger = "slash" | "mention";

export type ClawSweeperCommandLine = {
  trigger: ClawSweeperCommandTrigger;
  commandText: string;
  rest: string;
  supportsContinuation: boolean;
};

const MENTION_COMMAND_PATTERN =
  /^\s*@(?:clawsweeper|openclaw-clawsweeper)(?:\[bot\])?(?:(?:\s*[:,]\s*|\s+)(.+))?\s*$/i;
const RE_REVIEW_COMMAND_PATTERN =
  /^(?:review(?:\s+again)?|re-?review|rereview|re-?run(?:\s+review)?|rerun(?:\s+review)?|run\s+(?:review|again))\b[:\s-]+\S/i;
const RE_REVIEW_PROMPT_PREFIX_PATTERN =
  /^(?:review(?:\s+again)?|re-?review|rereview|re-?run(?:\s+review)?|rerun(?:\s+review)?|run\s+(?:review|again))\b[:\s-]*/i;

export function extractClawSweeperCommandLine(body: unknown): ClawSweeperCommandLine | null {
  const lines = String(body ?? "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^\s*\/auto(?:-|\s+)?merge\s*$/i.test(line)) {
      return commandLine("slash", "automerge", "", false);
    }
    const autoclose = line.match(/^\s*\/autoclose(?:\s+(.+))?\s*$/i);
    if (autoclose) return commandLine("slash", `autoclose ${autoclose[1] ?? ""}`.trim(), "", false);
    const review = line.match(/^\s*\/review(?:\s+(.+))?\s*$/i);
    if (review)
      return commandLine("slash", review[1] ? `review ${review[1]}` : "review", "", false);
    const slash = line.match(/^\s*\/clawsweeper(?:\s+(.+))?\s*$/i);
    if (slash) {
      return commandLine("slash", slash[1] ?? "status", followingLines(lines, index), true);
    }
    const mention = line.match(MENTION_COMMAND_PATTERN);
    if (mention) {
      return commandLine("mention", mention[1] ?? "status", followingLines(lines, index), true);
    }
  }
  return null;
}

export function normalizeClawSweeperCommandLine(body: unknown): ClawSweeperCommandLine | null {
  const command = extractClawSweeperCommandLine(body);
  if (command?.trigger === "mention" && command.commandText === "status" && command.rest) {
    return commandLine("mention", command.rest, "", false);
  }
  return command;
}

export function commandTextForClawSweeperFastAck(body: unknown) {
  return normalizeClawSweeperCommandLine(body)?.commandText ?? "";
}

export function isClawSweeperReReviewCommandText(commandText: unknown) {
  const command = String(commandText ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/[.!]+$/g, "");
  return (
    command === "review" ||
    command === "re-review" ||
    command === "rereview" ||
    command === "review again" ||
    command === "rerun" ||
    command === "re-run" ||
    command === "rerun review" ||
    command === "re-run review" ||
    command === "run review" ||
    command === "run again" ||
    RE_REVIEW_COMMAND_PATTERN.test(command)
  );
}

export function reviewPromptFromClawSweeperCommandText(commandText: unknown) {
  return String(commandText ?? "")
    .trim()
    .replace(RE_REVIEW_PROMPT_PREFIX_PATTERN, "")
    .trim();
}

export function reReviewContextFromClawSweeperComment(body: unknown) {
  const command = normalizeClawSweeperCommandLine(body);
  if (!command || !isClawSweeperReReviewCommandText(command.commandText)) return null;
  return [
    reviewPromptFromClawSweeperCommandText(command.commandText),
    command.supportsContinuation ? command.rest : "",
  ]
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function directReReviewAdditionalPrompt(options: {
  body: unknown;
  maintainerAuthorized: boolean;
  author: unknown;
  commentUrl: unknown;
}) {
  if (!options.maintainerAuthorized) return "";
  const context = reReviewContextFromClawSweeperComment(options.body);
  if (!context) return "";
  return [
    "Maintainer context from an @clawsweeper re-review command.",
    "",
    `Author: ${String(options.author || "unknown")}`,
    `Comment: ${String(options.commentUrl || "unknown")}`,
    "",
    "Requested focus:",
    context.slice(0, 3000),
    "",
    "Use this only as read-only review context. Do not merge, close, label, or push code from the model.",
  ].join("\n");
}

export const clawSweeperCommandAckMarker = (sourceCommentId: number) =>
  `<!-- clawsweeper-command-ack:${sourceCommentId} -->`;

export function renderClawSweeperQueuedAcknowledgement(
  sourceCommentId: number,
  statusMarker?: string,
) {
  const detail = statusMarker
    ? [statusMarker, "🦞👀", "Exact review queued."]
    : [
        "🦞👀",
        "ClawSweeper picked this up.",
        "",
        "Command router queued. I will update this comment with the next step.",
      ];
  return [clawSweeperCommandAckMarker(sourceCommentId), ...detail].join("\n");
}

function commandLine(
  trigger: ClawSweeperCommandTrigger,
  commandText: string,
  rest: string,
  supportsContinuation: boolean,
): ClawSweeperCommandLine {
  return { trigger, commandText, rest, supportsContinuation };
}

function followingLines(lines: string[], index: number) {
  return lines
    .slice(index + 1)
    .join("\n")
    .trim();
}
