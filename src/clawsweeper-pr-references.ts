import type { PullRequestRef } from "./clawsweeper-types.js";
import { escapeRegExp } from "./clawsweeper-markdown.js";
import { repoUrlFor } from "./clawsweeper-links.js";

export function pullRequestUrlForNumber(targetRepo: string, number: number): string {
  return repoUrlFor(targetRepo, `/pull/${number}`);
}

function sameRepoPullRequestRefRegex(targetRepo: string): RegExp | null {
  const [owner, repo] = targetRepo.split("/");
  if (!owner || !repo) return null;
  const escapedRepo = `${escapeRegExp(owner)}\\/${escapeRegExp(repo)}`;
  return new RegExp(
    [
      `https:\\/\\/github\\.com\\/${escapedRepo}\\/pull\\/(\\d+)\\b`,
      `(?:^|[^\\w/.-])${escapedRepo}#(\\d+)\\b`,
      "(?:^|[^\\w/#-])#(\\d+)\\b",
    ].join("|"),
    "gi",
  );
}

function sameRepoPullRequestUrlRegex(targetRepo: string): RegExp | null {
  const [owner, repo] = targetRepo.split("/");
  if (!owner || !repo) return null;
  const escapedRepo = `${escapeRegExp(owner)}\\/${escapeRegExp(repo)}`;
  return new RegExp(`^https:\\/\\/github\\.com\\/${escapedRepo}\\/pull\\/\\d+\\b`, "i");
}

function markdownLinkRegex(): RegExp {
  return /\[([^\]\n]{1,200})\]\(([^\s)]{1,1000})\)/gi;
}

const PULL_REQUEST_LINK_LABEL_START = "__clawsweeper_pr_link_label_start__";
const PULL_REQUEST_LINK_LABEL_END = "__clawsweeper_pr_link_label_end__";

function pullRequestLinkLabel(targetRepo: string, label: string): string {
  const refRegex = sameRepoPullRequestRefRegex(targetRepo);
  const trimmed = (refRegex ? label.replace(refRegex, " ") : label).trim();
  return trimmed
    ? `${PULL_REQUEST_LINK_LABEL_START} ${trimmed} ${PULL_REQUEST_LINK_LABEL_END} `
    : "";
}

function stripLeadingPullRequestLinkLabels(value: string): string {
  const pattern = new RegExp(
    `^\\s*${escapeRegExp(PULL_REQUEST_LINK_LABEL_START)}[\\s\\S]*?${escapeRegExp(
      PULL_REQUEST_LINK_LABEL_END,
    )}\\s*`,
  );
  let remaining = value;
  while (pattern.test(remaining)) {
    remaining = remaining.replace(pattern, "");
  }
  return remaining;
}

function normalizePullRequestMarkdownLinks(targetRepo: string, value: string): string {
  const sameRepoPullRequestUrl = sameRepoPullRequestUrlRegex(targetRepo);
  if (!sameRepoPullRequestUrl) return value;
  return value.replace(markdownLinkRegex(), (_link: string, label: string, target: string) =>
    sameRepoPullRequestUrl.test(target)
      ? `${pullRequestLinkLabel(targetRepo, label)}${target}`
      : " ",
  );
}

function pullRequestRefFromMatch(match: RegExpMatchArray): PullRequestRef | null {
  const number = Number(match[1] ?? match[2] ?? match[3]);
  if (!Number.isInteger(number) || number <= 0) return null;
  if (match[1]) return { number, kind: "pull_url" };
  if (match[2]) return { number, kind: "same_repo_shorthand" };
  return { number, kind: "bare" };
}

function pullRequestRefMatchIndex(targetRepo: string, match: RegExpMatchArray): number {
  const matchStart = match.index ?? 0;
  const matchedText = match[0] ?? "";
  if (match[1]) return matchStart;
  if (match[2]) {
    const needle = `${targetRepo}#${match[2]}`;
    const offset = matchedText.toLowerCase().indexOf(needle.toLowerCase());
    return matchStart + (offset >= 0 ? offset : Math.max(0, matchedText.length - needle.length));
  }
  if (match[3]) {
    const needle = `#${match[3]}`;
    const offset = matchedText.indexOf(needle);
    return matchStart + (offset >= 0 ? offset : Math.max(0, matchedText.length - needle.length));
  }
  return matchStart;
}

function relationshipClauseContainingIndex(
  targetRepo: string,
  text: string,
  index: number,
): string {
  const lineStart = text.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  const lineEnd = text.indexOf("\n", index);
  const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
  const relativeIndex = Math.max(0, index - lineStart);
  let start = 0;
  let end = line.length;
  const boundary = /[;,|]|\.(?=\s|$)|\s+(?:and|but|while)\s+/gi;

  for (const match of line.matchAll(boundary)) {
    const boundaryStart = match.index ?? 0;
    const boundaryEnd = boundaryStart + match[0].length;
    if (
      relationshipBoundaryContinuesPullRequestRefList(targetRepo, line, boundaryStart, boundaryEnd)
    ) {
      continue;
    }
    if (boundaryEnd <= relativeIndex) {
      start = boundaryEnd;
      continue;
    }
    if (boundaryStart > relativeIndex) {
      end = boundaryStart;
      break;
    }
  }

  return line.slice(start, end).trim();
}

function relationshipBoundaryContinuesPullRequestRefList(
  targetRepo: string,
  line: string,
  boundaryStart: number,
  boundaryEnd: number,
): boolean {
  const boundaryText = line.slice(boundaryStart, boundaryEnd).trim().toLowerCase();
  if (!["and", ",", ";"].includes(boundaryText)) return false;
  if (!textEndsWithPullRequestRef(targetRepo, line.slice(0, boundaryStart))) return false;
  return textStartsWithStandalonePullRequestRef(targetRepo, line.slice(boundaryEnd));
}

function textEndsWithPullRequestRef(targetRepo: string, value: string): boolean {
  const regex = sameRepoPullRequestRefRegex(targetRepo);
  if (!regex) return false;
  const normalized = normalizePullRequestMarkdownLinks(targetRepo, value);
  let lastRefEnd = -1;
  for (const match of normalized.matchAll(regex)) {
    lastRefEnd = (match.index ?? 0) + (match[0]?.length ?? 0);
  }
  return lastRefEnd >= 0 && /^[\s,;]*$/.test(normalized.slice(lastRefEnd));
}

function textStartsWithStandalonePullRequestRef(targetRepo: string, value: string): boolean {
  const regex = sameRepoPullRequestRefRegex(targetRepo);
  if (!regex) return false;
  let remaining = stripLeadingPullRequestLinkLabels(
    normalizePullRequestMarkdownLinks(targetRepo, value)
      .trimStart()
      .replace(/^and\s+/i, ""),
  );
  let sawRef = false;
  while (remaining) {
    regex.lastIndex = 0;
    const match = regex.exec(remaining);
    if (!match || pullRequestRefMatchIndex(targetRepo, match) !== 0) return false;
    sawRef = true;
    remaining = stripLeadingPullRequestLinkLabels(
      remaining.slice((match.index ?? 0) + (match[0]?.length ?? 0)).trimStart(),
    );
    if (!remaining || /^[\s,;.)\]]+$/.test(remaining)) return true;
    const separator = remaining.match(/^(?:[,;]\s*(?:and\s+)?|and\s+)/i);
    if (!separator) return false;
    remaining = stripLeadingPullRequestLinkLabels(remaining.slice(separator[0].length).trimStart());
  }
  return sawRef;
}

export function linkedPullRequestSignalContextsFromText(
  targetRepo: string,
  text: string,
  currentNumber: number,
  linkedNumber: number,
): string[] {
  const regex = sameRepoPullRequestRefRegex(targetRepo);
  if (!regex) return [];
  const normalizedText = normalizePullRequestMarkdownLinks(targetRepo, text);
  const contexts: string[] = [];
  for (const match of normalizedText.matchAll(regex)) {
    const ref = pullRequestRefFromMatch(match);
    if (!ref || ref.number !== linkedNumber || ref.number === currentNumber) continue;
    contexts.push(
      relationshipClauseContainingIndex(
        targetRepo,
        normalizedText,
        pullRequestRefMatchIndex(targetRepo, match),
      ),
    );
  }
  return contexts;
}
