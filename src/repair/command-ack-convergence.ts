import type { JsonValue, LooseRecord } from "./json-types.js";
import {
  commandResponseMarkersInBody,
  commandStatusMarkerFromBody,
  commandStatusMarkersInBody,
  hasCommandAckMarker,
  hasCommandStatusMarker,
  parseCommandResponseMarker,
  parseCommandStatusMarker,
} from "./markers.ts";

export const COMMAND_PROGRESS_START = "<!-- clawsweeper-command-progress:start -->";

export function legacyCommandCommentId(body: JsonValue, statusMarker: string): number | null {
  // The legacy grammar matches markers case-insensitively.
  if (hasCommandAckMarker(body, { ignoreCase: true })) return null;
  const statusMarkers = commandStatusMarkersInBody(body, { ignoreCase: true });
  const commandMarkers = commandResponseMarkersInBody(body, { ignoreCase: true });
  if (
    statusMarkers.length !== 1 ||
    statusMarkers[0] !== statusMarker ||
    commandMarkers.length !== 1
  ) {
    return null;
  }
  const status = parseCommandStatusMarker(statusMarker, { ignoreCase: true });
  const command = parseCommandResponseMarker(commandMarkers[0]);
  if (!status || !command || command.intent !== status.intent) return null;
  const commandCommentId = Number(command.commentId);
  if (!Number.isSafeInteger(commandCommentId) || commandCommentId < 1) return null;

  const commandRevision = /^command-(\d+)-([0-9a-z]+)-[0-9a-f]{64}$/.exec(status.revision);
  if (!commandRevision) return command.revision === status.revision ? commandCommentId : null;

  // Current direct re-review status revisions encode the legacy command's
  // comment id and timestamp; its trailing digest intentionally differs.
  const commandTimestamp = Date.parse(command.createdAt ?? "");
  return commandRevision[1] === command.commentId &&
    Number.isSafeInteger(commandTimestamp) &&
    commandTimestamp.toString(36) === commandRevision[2]
    ? commandCommentId
    : null;
}

export function statusMarkerDiffersFromRequested(
  body: JsonValue,
  requestedStatusMarker: string,
): boolean {
  const statusMarker = commandStatusMarkerFromBody(body);
  return Boolean(requestedStatusMarker && statusMarker && statusMarker !== requestedStatusMarker);
}

export function isPrunableCommandAckDuplicate(
  comment: LooseRecord,
  requestedStatusMarker: string,
): boolean {
  const statusMarker = commandStatusMarkerFromBody(comment.body);
  return !statusMarker || statusMarker === requestedStatusMarker;
}

export function selectCommandAckKeeper(comments: LooseRecord[]): LooseRecord | null {
  return [...comments].sort(compareCommandAckKeepPriority)[0] ?? null;
}

export function planCommandAckConvergence(
  comments: LooseRecord[],
  requestedStatusMarker: string,
): { keep: LooseRecord | null; prunable: LooseRecord[] } {
  const scoped = comments.filter((comment) =>
    isPrunableCommandAckDuplicate(comment, requestedStatusMarker),
  );
  const keep = selectCommandAckKeeper(scoped);
  if (!keep) return { keep: null, prunable: [] };
  const keepId = Number(keep.id ?? 0) || 0;
  return {
    keep,
    prunable: scoped.filter((comment) => {
      const id = Number(comment.id ?? 0) || 0;
      return id > 0 && id !== keepId;
    }),
  };
}

export function compareCommentsByCreatedAt(left: LooseRecord, right: LooseRecord): number {
  const leftCreated = String(left.created_at ?? "");
  const rightCreated = String(right.created_at ?? "");
  return (
    leftCreated.localeCompare(rightCreated) || (Number(left.id) || 0) - (Number(right.id) || 0)
  );
}

export function compareCommandAckKeepPriority(left: LooseRecord, right: LooseRecord): number {
  const leftStatus = isCommandAckStatusComment(left) ? 1 : 0;
  const rightStatus = isCommandAckStatusComment(right) ? 1 : 0;
  if (leftStatus !== rightStatus) return rightStatus - leftStatus;
  if (leftStatus > 0) return compareCommentsByUpdatedAtDesc(left, right);
  return compareCommentsByCreatedAt(left, right);
}

export function isCommandAckStatusComment(comment: LooseRecord): boolean {
  const body = String(comment.body ?? "");
  return hasCommandStatusMarker(body) || body.includes(COMMAND_PROGRESS_START);
}

function compareCommentsByUpdatedAtDesc(left: LooseRecord, right: LooseRecord): number {
  const leftUpdated = String(left.updated_at ?? left.created_at ?? "");
  const rightUpdated = String(right.updated_at ?? right.created_at ?? "");
  return (
    rightUpdated.localeCompare(leftUpdated) || (Number(right.id) || 0) - (Number(left.id) || 0)
  );
}
