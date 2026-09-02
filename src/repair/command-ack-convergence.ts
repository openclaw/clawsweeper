import type { JsonValue, LooseRecord } from "./json-types.js";

export const COMMAND_PROGRESS_START = "<!-- clawsweeper-command-progress:start -->";

export function commandAckMarkerFromBody(body: JsonValue): string | null {
  return String(body ?? "").match(/<!--\s*clawsweeper-command-ack:\d+\s*-->/)?.[0] ?? null;
}

export function commandStatusMarkerFromBody(body: JsonValue): string | null {
  return (
    String(body ?? "").match(new RegExp("<!--\\s*clawsweeper-command-status:[^>]+-->"))?.[0] ?? null
  );
}

export function legacyCommandCommentId(body: JsonValue, statusMarker: string): number | null {
  const text = String(body ?? "");
  if (/<!--\s*clawsweeper-command-ack:[^>]*-->/i.test(text)) return null;
  const statusMarkers = Array.from(
    text.matchAll(/<!--\s*clawsweeper-command-status:[^>]+-->/gi),
    (match) => match[0],
  );
  const commandMarkers = Array.from(
    text.matchAll(/<!--\s*clawsweeper-command:[^>]+-->/gi),
    (match) => match[0],
  );
  if (
    statusMarkers.length !== 1 ||
    statusMarkers[0] !== statusMarker ||
    commandMarkers.length !== 1
  ) {
    return null;
  }
  const status = /^<!--\s*clawsweeper-command-status:(\d+):([^:\s>]+):([^:\s>]+)\s*-->$/i.exec(
    statusMarker,
  );
  const command = /^<!--\s*clawsweeper-command:(\d+):(?:(.+):)?([^:\s>]+):([^:\s>]+)\s*-->$/i.exec(
    commandMarkers[0]!,
  );
  if (!status || !command || command[3] !== status[2]) return null;
  const commandCommentId = Number(command[1]);
  if (!Number.isSafeInteger(commandCommentId) || commandCommentId < 1) return null;

  const commandRevision = /^command-(\d+)-([0-9a-z]+)-[0-9a-f]{64}$/.exec(status[3]!);
  if (!commandRevision) return command[4] === status[3] ? commandCommentId : null;

  // Current direct re-review status revisions encode the legacy command's
  // comment id and timestamp; its trailing digest intentionally differs.
  const commandTimestamp = Date.parse(command[2] ?? "");
  return commandRevision[1] === command[1] &&
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

function compareCommandAckKeepPriority(left: LooseRecord, right: LooseRecord): number {
  const leftStatus = commandAckStatusScore(left);
  const rightStatus = commandAckStatusScore(right);
  if (leftStatus !== rightStatus) return rightStatus - leftStatus;
  if (leftStatus > 0) return compareCommentsByUpdatedAtDesc(left, right);
  return compareCommentsByCreatedAt(left, right);
}

function commandAckStatusScore(comment: LooseRecord): number {
  const body = String(comment.body ?? "");
  return body.includes("clawsweeper-command-status:") || body.includes(COMMAND_PROGRESS_START)
    ? 1
    : 0;
}

function compareCommentsByUpdatedAtDesc(left: LooseRecord, right: LooseRecord): number {
  const leftUpdated = String(left.updated_at ?? left.created_at ?? "");
  const rightUpdated = String(right.updated_at ?? right.created_at ?? "");
  return (
    rightUpdated.localeCompare(leftUpdated) || (Number(right.id) || 0) - (Number(left.id) || 0)
  );
}
