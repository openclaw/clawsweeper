// This module owns the grammar of the ClawSweeper command markers: the
// command-ack, command-status, command response and automerge-requested-by
// markers. It builds them and parses them. The dashboard Worker imports it,
// and the Worker has no Node APIs. Keep this module free of imports.

// Command statuses for these intents share one status comment per item.
export const AUTOMERGE_STATUS_INTENTS: ReadonlySet<string> = new Set([
  "automerge",
  "clawsweeper_auto_repair",
  "clawsweeper_auto_merge",
  "maintainer_approve_automerge",
]);

export type CommandStatusMarker = {
  issueNumber: string;
  intent: string;
  revision: string;
};

export type CommandResponseMarker = {
  commentId: string;
  createdAt: string | null;
  intent: string;
  revision: string;
};

// Callers match markers case-sensitively unless they set ignoreCase.
export type MarkerMatchOptions = { ignoreCase?: boolean };

function markerFlags(options: MarkerMatchOptions, flags = ""): string {
  return options.ignoreCase ? `${flags}i` : flags;
}

export function commandAckMarker(commentId: unknown): string {
  return `<!-- clawsweeper-command-ack:${commentId} -->`;
}

export function commandAckMarkerFromBody(body: unknown): string | null {
  return String(body ?? "").match(/<!--\s*clawsweeper-command-ack:\d+\s*-->/)?.[0] ?? null;
}

export function commandAckCommentIds(body: unknown): number[] {
  return Array.from(
    String(body ?? "").matchAll(/<!--\s*clawsweeper-command-ack:(\d+)\s*-->/g),
    (match) => Number(match[1]),
  ).filter((id) => Number.isSafeInteger(id) && id > 0);
}

export function hasCommandAckMarker(body: unknown, options: MarkerMatchOptions = {}): boolean {
  return new RegExp("<!--\\s*clawsweeper-command-ack:[^>]*-->", markerFlags(options)).test(
    String(body ?? ""),
  );
}

export function commandStatusMarker(
  issueNumber: unknown,
  intent: unknown,
  revision: unknown,
): string {
  return `${commandStatusMarkerPrefix(issueNumber, intent)}${revision} -->`;
}

export function commandStatusMarkerPrefix(issueNumber: unknown, intent: unknown): string {
  return `${itemCommandStatusMarkerPrefix(issueNumber)}${intent}:`;
}

// This prefix matches every command status marker of the item.
export function itemCommandStatusMarkerPrefix(issueNumber: unknown): string {
  return `<!-- clawsweeper-command-status:${issueNumber}:`;
}

export function hasCommandStatusMarker(body: unknown): boolean {
  return String(body ?? "").includes("clawsweeper-command-status:");
}

export function commandStatusMarkerFromBody(body: unknown): string | null {
  return commandStatusMarkersInBody(body)[0] ?? null;
}

export function commandStatusMarkersInBody(
  body: unknown,
  options: MarkerMatchOptions = {},
): string[] {
  return Array.from(
    String(body ?? "").matchAll(
      new RegExp("<!--\\s*clawsweeper-command-status:[^>]+-->", markerFlags(options, "g")),
    ),
    (match) => match[0],
  );
}

export function parseCommandStatusMarker(
  marker: unknown,
  options: MarkerMatchOptions = {},
): CommandStatusMarker | null {
  const match = new RegExp(
    "^<!--\\s*clawsweeper-command-status:(\\d+):([^:\\s>]+):([^:\\s>]+)\\s*-->$",
    markerFlags(options),
  ).exec(String(marker ?? ""));
  if (!match) return null;
  return { issueNumber: match[1]!, intent: match[2]!, revision: match[3]! };
}

// True when the body has a shared automerge status marker of any item.
export function hasAutomergeCommandStatusMarker(body: unknown): boolean {
  return new RegExp(
    `clawsweeper-command-status:\\d+:(?:${[...AUTOMERGE_STATUS_INTENTS].join("|")}):`,
    "i",
  ).test(String(body ?? ""));
}

// Finds the shared automerge status marker of one item. The caller can add
// intents that reuse that status comment.
export function automergeStatusMarkerFromBody(
  body: unknown,
  issueNumber: unknown,
  intents: Iterable<string> = AUTOMERGE_STATUS_INTENTS,
): string | null {
  const number = Number(issueNumber);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  const alternation = [...intents]
    .map((intent) => intent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return (
    String(body ?? "").match(
      new RegExp(
        `<!-- clawsweeper-command-status:${number}:(?:${alternation}):[^<>\\r\\n]{1,120} -->`,
        "i",
      ),
    )?.[0] ?? null
  );
}

export function commandResponseMarker(
  commentId: unknown,
  intent: unknown,
  revision: unknown,
): string {
  return `${commandResponseMarkerPrefix(commentId, intent)}${revision} -->`;
}

export function commandResponseMarkerPrefix(commentId: unknown, intent: unknown): string {
  return `<!-- clawsweeper-command:${commentId}:${intent}:`;
}

export function commandResponseMarkersInBody(
  body: unknown,
  options: MarkerMatchOptions = {},
): string[] {
  return Array.from(
    String(body ?? "").matchAll(
      new RegExp("<!--\\s*clawsweeper-command:[^>]+-->", markerFlags(options, "g")),
    ),
    (match) => match[0],
  );
}

export function parseCommandResponseMarker(marker: unknown): CommandResponseMarker | null {
  const match = /^<!--\s*clawsweeper-command:(\d+):(?:(.+):)?([^:\s>]+):([^:\s>]+)\s*-->$/i.exec(
    String(marker ?? ""),
  );
  if (!match) return null;
  return {
    commentId: match[1]!,
    createdAt: match[2] ?? null,
    intent: match[3]!,
    revision: match[4]!,
  };
}

export function automergeRequestedByMarker(login: unknown, id: unknown): string {
  return `<!-- clawsweeper-automerge-requested-by login="${escapeHtmlAttribute(login)}" id="${escapeHtmlAttribute(id)}" -->`;
}

export function automergeRequestedByAttributes(body: unknown): Record<string, string> | null {
  const marker = String(body ?? "").match(
    /<!--\s*clawsweeper-automerge-requested-by\s+([^>]*)-->/i,
  );
  return marker ? markerAttributes(marker[1] ?? "") : null;
}

export function markerAttributes(input: unknown): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of String(input ?? "").matchAll(/([a-z0-9_-]+)=("[^"]*"|'[^']*'|[^\s>]+)/gi)) {
    const raw = match[2] ?? "";
    attrs[(match[1] ?? "").toLowerCase()] = raw.replace(/^["']|["']$/g, "");
  }
  return attrs;
}

function escapeHtmlAttribute(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
