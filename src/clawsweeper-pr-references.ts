import type { PullRequestRef, PullRequestRefKind } from "./clawsweeper-types.js";
import { escapeRegExp } from "./clawsweeper-text.js";

export interface PullRequestReferenceParserDependencies {
  targetRepo: () => string;
  repoUrlFor: (repo: string, path: string) => string;
  reportReferenceTexts: (markdown: string) => readonly string[];
}

/** Resolve same-repository PR references without trusting Markdown link labels. */
export function createPullRequestReferenceParser({
  targetRepo,
  repoUrlFor,
  reportReferenceTexts,
}: PullRequestReferenceParserDependencies) {
  function pullRequestUrlForNumber(number: number): string {
    return repoUrlFor(targetRepo(), `/pull/${number}`);
  }

  function sameRepoPullRequestRefRegex(): RegExp | null {
    const [owner, repo] = targetRepo().split("/");
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

  function sameRepoPullRequestUrlRegex(): RegExp | null {
    const [owner, repo] = targetRepo().split("/");
    if (!owner || !repo) return null;
    const escapedRepo = `${escapeRegExp(owner)}\\/${escapeRegExp(repo)}`;
    return new RegExp(`^https:\\/\\/github\\.com\\/${escapedRepo}\\/pull\\/\\d+\\b`, "i");
  }

  function markdownLinkRegex(): RegExp {
    return /\[([^\]\n]{1,200})\]\(([^\s)]{1,1000})\)/gi;
  }

  const PULL_REQUEST_LINK_LABEL_START = "__clawsweeper_pr_link_label_start__";
  const PULL_REQUEST_LINK_LABEL_END = "__clawsweeper_pr_link_label_end__";

  function pullRequestLinkLabel(label: string): string {
    const refRegex = sameRepoPullRequestRefRegex();
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

  function normalizePullRequestMarkdownLinks(value: string): string {
    const sameRepoPullRequestUrl = sameRepoPullRequestUrlRegex();
    if (!sameRepoPullRequestUrl) return value;
    return value.replace(markdownLinkRegex(), (_link: string, label: string, target: string) =>
      sameRepoPullRequestUrl.test(target) ? `${pullRequestLinkLabel(label)}${target}` : " ",
    );
  }

  function pullRequestRefFromMatch(match: RegExpMatchArray): PullRequestRef | null {
    const number = Number(match[1] ?? match[2] ?? match[3]);
    if (!Number.isInteger(number) || number <= 0) return null;
    if (match[1]) return { number, kind: "pull_url" };
    if (match[2]) return { number, kind: "same_repo_shorthand" };
    return { number, kind: "bare" };
  }

  function pullRequestRefKindRank(kind: PullRequestRefKind): number {
    if (kind === "pull_url") return 3;
    if (kind === "same_repo_shorthand") return 2;
    return 1;
  }

  function setStrongestPullRequestRef(
    refs: Map<number, PullRequestRef>,
    ref: PullRequestRef,
  ): void {
    const existing = refs.get(ref.number);
    if (!existing || pullRequestRefKindRank(ref.kind) > pullRequestRefKindRank(existing.kind)) {
      refs.set(ref.number, ref);
    }
  }

  function pullRequestRefMatchIndex(match: RegExpMatchArray): number {
    const matchStart = match.index ?? 0;
    const matchedText = match[0] ?? "";
    if (match[1]) return matchStart;
    if (match[2]) {
      const needle = `${targetRepo()}#${match[2]}`;
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

  function linkedPullRequestRefsFromText(text: string, currentNumber: number): PullRequestRef[] {
    const regex = sameRepoPullRequestRefRegex();
    if (!regex) return [];
    const normalizedText = normalizePullRequestMarkdownLinks(text);
    const refs = new Map<number, PullRequestRef>();
    for (const match of normalizedText.matchAll(regex)) {
      const ref = pullRequestRefFromMatch(match);
      if (ref && ref.number !== currentNumber) setStrongestPullRequestRef(refs, ref);
    }
    return [...refs.values()];
  }

  function relationshipClauseContainingIndex(text: string, index: number): string {
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
      if (relationshipBoundaryContinuesPullRequestRefList(line, boundaryStart, boundaryEnd)) {
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
    line: string,
    boundaryStart: number,
    boundaryEnd: number,
  ): boolean {
    const boundaryText = line.slice(boundaryStart, boundaryEnd).trim().toLowerCase();
    if (!["and", ",", ";"].includes(boundaryText)) return false;
    if (!textEndsWithPullRequestRef(line.slice(0, boundaryStart))) return false;
    return textStartsWithStandalonePullRequestRef(line.slice(boundaryEnd));
  }

  function textEndsWithPullRequestRef(value: string): boolean {
    const regex = sameRepoPullRequestRefRegex();
    if (!regex) return false;
    const normalized = normalizePullRequestMarkdownLinks(value);
    let lastRefEnd = -1;
    for (const match of normalized.matchAll(regex)) {
      lastRefEnd = (match.index ?? 0) + (match[0]?.length ?? 0);
    }
    return lastRefEnd >= 0 && /^[\s,;]*$/.test(normalized.slice(lastRefEnd));
  }

  function textStartsWithStandalonePullRequestRef(value: string): boolean {
    const regex = sameRepoPullRequestRefRegex();
    if (!regex) return false;
    let remaining = stripLeadingPullRequestLinkLabels(
      normalizePullRequestMarkdownLinks(value)
        .trimStart()
        .replace(/^and\s+/i, ""),
    );
    let sawRef = false;
    while (remaining) {
      regex.lastIndex = 0;
      const match = regex.exec(remaining);
      if (!match || pullRequestRefMatchIndex(match) !== 0) return false;
      sawRef = true;
      remaining = stripLeadingPullRequestLinkLabels(
        remaining.slice((match.index ?? 0) + (match[0]?.length ?? 0)).trimStart(),
      );
      if (!remaining || /^[\s,;.)\]]+$/.test(remaining)) return true;
      const separator = remaining.match(/^(?:[,;]\s*(?:and\s+)?|and\s+)/i);
      if (!separator) return false;
      remaining = stripLeadingPullRequestLinkLabels(
        remaining.slice(separator[0].length).trimStart(),
      );
    }
    return sawRef;
  }

  function linkedPullRequestSignalContextsFromText(
    text: string,
    currentNumber: number,
    linkedNumber: number,
  ): string[] {
    const regex = sameRepoPullRequestRefRegex();
    if (!regex) return [];
    const normalizedText = normalizePullRequestMarkdownLinks(text);
    const contexts: string[] = [];
    for (const match of normalizedText.matchAll(regex)) {
      const ref = pullRequestRefFromMatch(match);
      if (!ref || ref.number !== linkedNumber || ref.number === currentNumber) continue;
      contexts.push(
        relationshipClauseContainingIndex(normalizedText, pullRequestRefMatchIndex(match)),
      );
    }
    return contexts;
  }

  function linkedPullRequestRefsFromReport(
    markdown: string,
    currentNumber: number,
  ): PullRequestRef[] {
    const texts = reportReferenceTexts(markdown);
    const refs = new Map<number, PullRequestRef>();
    for (const text of texts) {
      for (const ref of linkedPullRequestRefsFromText(text, currentNumber)) {
        setStrongestPullRequestRef(refs, ref);
      }
    }
    return [...refs.values()];
  }

  function linkedPullRequestNumbersFromReport(markdown: string, currentNumber: number): number[] {
    return linkedPullRequestRefsFromReport(markdown, currentNumber).map((ref) => ref.number);
  }

  return {
    linkedPullRequestNumbersFromReport,
    linkedPullRequestRefsFromReport,
    linkedPullRequestRefsFromText,
    linkedPullRequestSignalContextsFromText,
    pullRequestUrlForNumber,
  };
}
