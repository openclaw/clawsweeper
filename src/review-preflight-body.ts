import MarkdownIt from "markdown-it/browser";
import { assertNoDuplicateJsonObjectKeys } from "./unique-json-object-keys.ts";
import {
  PREFLIGHT_BLOCK_LIMIT,
  validReviewPreflight,
  type ReviewPreflightPayload,
} from "./review-preflight-contract.ts";

const markdown = new MarkdownIt("commonmark", { html: true });
markdown.core.ruler.disable(["inline", "strip_references"]);
const utf8 = new TextEncoder();

export type ReviewPreflightBody =
  | { status: "missing" | "invalid"; body: string }
  | { status: "valid"; body: string; payload: ReviewPreflightPayload; start: number; end: number };

/** Exclude only a standalone, unambiguous metadata comment; preserve every outer byte. */
export function parseReviewPreflightBody(body: string): ReviewPreflightBody {
  const markers = /<!--\s*openclaw-preflight\b/gi;
  const first = markers.exec(body);
  if (!first) return { status: "missing", body };
  const invalid = { status: "invalid" as const, body };
  // Larger local body overrides remain review material; never feed them into
  // Markdown tokenization just to remove optional metadata.
  if (body.length > 131_072 || markers.exec(body)) return invalid;
  const start = first.index;
  const close = body.indexOf("-->", start);
  if (close < 0) return invalid;
  const end = close + 3;
  const block = body.slice(start, end);
  if (utf8.encode(block).length > PREFLIGHT_BLOCK_LIMIT) return invalid;
  const match = /^<!-- openclaw-preflight:v1\r?\n([\s\S]+)\r?\n-->$/.exec(block);
  if (!match || /[<>&]/.test(match[1]!)) return invalid;
  let payload: unknown;
  try {
    assertNoDuplicateJsonObjectKeys(
      match[1]!,
      "preflight",
      { maxDepth: 2, maxNodes: 16 },
      "preflight",
    );
    payload = JSON.parse(match[1]!);
  } catch {
    return invalid;
  }
  if (!validReviewPreflight(payload)) return invalid;

  // Token maps use normalized line numbers, not byte offsets. Slice the original
  // body so CRLF, indentation and human whitespace never become invisible edits.
  const starts = [0];
  for (const line of body.matchAll(/\r\n?|\n/g)) starts.push(line.index + line[0].length);
  const tokens = markdown.parse(body, {});
  for (const token of tokens) {
    if (token.type !== "html_block") continue;
    const tokenStart = starts[token.map![0]]!;
    if (tokenStart > start) break;
    if (tokenStart !== start || token.level !== 0) continue;
    const tokenEnd = starts[token.map![1]] ?? body.length;
    if (body.slice(end, tokenEnd).trim()) return invalid;
    return { status: "valid", body: body.slice(0, start) + body.slice(end), payload, start, end };
  }
  return invalid;
}

export function reviewBodyWithoutPreflight(body: string): string {
  return parseReviewPreflightBody(body).body;
}
