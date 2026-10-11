import type { JsonValue, LooseRecord } from "./json-types.js";
import { markdownTopLevelSection } from "../clawsweeper-markdown.js";
import { HUMAN_REVIEW_LABEL } from "./exact-review-guard-labels.js";
import {
  commandResponseMarker,
  commandResponseMarkerPrefix,
  commandStatusMarker,
} from "./markers.js";

export function shouldClearMaintainerCommandReaction(command: LooseRecord) {
  return (
    !command?.trusted_bot &&
    Boolean(command?.comment_id) &&
    ["executed", "skipped"].includes(String(command?.status ?? ""))
  );
}

export function createCachedIssueCommentsLookup<T = JsonValue>(
  fetchComments: (number: number) => T[],
  cache = new Map<number, T[]>(),
) {
  return (number: JsonValue): T[] => {
    const key = Number(number);
    if (!Number.isInteger(key) || key <= 0) return [];
    const cached = cache.get(key);
    if (cached) return [...cached];
    const comments = fetchComments(key);
    cache.set(key, comments);
    return [...comments];
  };
}

export function createCachedIssueCommentsLookupAsync<T = JsonValue>(
  fetchComments: (number: number) => Promise<T[]>,
  cache = new Map<number, T[]>(),
) {
  const inFlight = new Map<number, Promise<T[]>>();
  return async (number: JsonValue): Promise<T[]> => {
    const key = Number(number);
    if (!Number.isInteger(key) || key <= 0) return [];
    const cached = cache.get(key);
    if (cached) return [...cached];
    const pending = inFlight.get(key);
    if (pending) return [...(await pending)];
    const next = fetchComments(key)
      .then((comments) => {
        cache.set(key, comments);
        return comments;
      })
      .finally(() => {
        inFlight.delete(key);
      });
    inFlight.set(key, next);
    return [...(await next)];
  };
}

export function commandHasAction(command: LooseRecord, actionName: string): boolean {
  return (command.actions ?? []).some((action: JsonValue) => action.action === actionName);
}

export function existingCommandStatusBlocksReplay({
  hasExistingResponse,
  forceReprocess,
  retryPending,
}: LooseRecord = {}) {
  return Boolean(hasExistingResponse) && !forceReprocess && !retryPending;
}

export function reviewSummaryFromCommentBody(body: JsonValue): string | null {
  const text = String(body ?? "");
  return (
    markdownTopLevelSection(text, "What this changes") ||
    markdownTopLevelSection(text, "Summary") ||
    null
  );
}

export function renderResponse(command: LooseRecord, dispatched: LooseRecord) {
  const marker = [
    commandStatusMarkerForCommand(command),
    commandResponseMarker(
      command.comment_version_key ?? command.comment_id,
      command.intent,
      command.target?.head_sha ?? "na",
    ),
  ].join("\n");
  if (command.retired || !["re_review", "stop", "explain", "help"].includes(command.intent)) {
    const name = String(command.command ?? command.intent)
      .replace(/`/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    return `${marker}\n\`@clawsweeper ${name}\` is retired; ClawSweeper now only reviews.`;
  }
  if (command.intent === "help") {
    return [
      marker,
      "ClawSweeper now only reviews.",
      "Supported commands: `@clawsweeper review`, `@clawsweeper re-review`, `@clawsweeper explain`, and `@clawsweeper stop`.",
    ].join("\n");
  }
  if (command.intent === "explain") {
    const target = command.target ?? {};
    const lines = [marker, "ClawSweeper status:"];
    if (target.kind === "pull_request") {
      lines.push(`- Current PR: \`${command.issue_number ?? "unknown"}\``);
      lines.push(`- Branch: \`${target.branch ?? "unknown"}\``);
      if (target.review_decision) lines.push(`- Review decision: \`${target.review_decision}\``);
      const counts = Object.entries(target.checks?.counts ?? {})
        .map(([key, value]) => `${key}:${value}`)
        .join(" ");
      lines.push(`- Checks: ${counts || "none"}`);
      if (target.checks?.blockers?.length) {
        lines.push(`- Check blockers: ${target.checks.blockers.slice(0, 5).join(", ")}`);
      }
    } else {
      lines.push(`- Current issue: \`${command.issue_number ?? "unknown"}\``);
      lines.push(`- State: \`${target.state ?? "unknown"}\``);
    }
    return lines.join("\n");
  }
  if (command.intent === "stop") {
    const removedLabels = (command.actions ?? [])
      .filter((action: JsonValue) => action.action === "remove_label")
      .map((action: JsonValue) => `\`${action.label}\``);
    return [
      marker,
      "Got it. ClawSweeper will leave this item for human review.",
      "",
      `I added \`${HUMAN_REVIEW_LABEL}\`${removedLabels.length ? `, removed ${removedLabels.join(", ")},` : ""} and paused the automation trail until a maintainer asks again.`,
    ].join("\n");
  }
  return [
    marker,
    dispatched?.clawsweeper
      ? "ClawSweeper re-review requested."
      : "ClawSweeper could not start a re-review for this item.",
    dispatched?.clawsweeper
      ? "When the review finishes, ClawSweeper will create the durable review comment if needed or update the existing comment in place."
      : `Reason: ${command.reason ?? "re-review requires an open issue or PR"}.`,
  ].join("\n");
}

export function commandStatusMarkerForCommand(command: LooseRecord) {
  return commandStatusMarker(
    command.issue_number ?? "unknown",
    command.intent,
    command.command_status_revision ?? command.target?.head_sha ?? "na",
  );
}

export function hasCommandResponseMarker(body: JsonValue, command: LooseRecord): boolean {
  const text = String(body ?? "");
  return command.matchAnyHead
    ? text.includes(commandResponseMarkerPrefix(command.commentId, command.intent))
    : text.includes(
        commandResponseMarker(command.commentId, command.intent, command.headSha ?? "na"),
      );
}

export function staleClosedItemCommandReason({
  command,
  issue,
  pull = null,
}: LooseRecord): string | null {
  const intent = String(command?.intent ?? "");
  if (intent !== "re_review") return null;
  const closedAt = pull?.mergedAt ?? pull?.merged_at ?? issue?.closed_at ?? issue?.closedAt;
  if (!closedAt) return null;
  const commandTime = Date.parse(
    String(command?.comment_created_at ?? command?.comment_updated_at ?? ""),
  );
  const closedTime = Date.parse(String(closedAt));
  if (!Number.isFinite(commandTime) || !Number.isFinite(closedTime) || commandTime >= closedTime)
    return null;
  return pull?.mergedAt || pull?.merged_at || String(pull?.state ?? "").toUpperCase() === "MERGED"
    ? `${intent} already completed after this command`
    : `PR closed after this ${intent} command`;
}
