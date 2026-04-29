export const GITHUB_PR_TITLE_MAX_LENGTH = 256;
export const CLAWSWEEPER_GENERATED_PR_TITLE_MAX_LENGTH = 96;

const FALLBACK_REPAIR_PR_TITLE = "fix: address ClawSweeper finding";

export function normalizeGithubPrTitle(
  value: unknown,
  fallback = FALLBACK_REPAIR_PR_TITLE,
  maxLength = GITHUB_PR_TITLE_MAX_LENGTH,
) {
  const title = compactTitle(value, maxLength) || compactTitle(fallback, maxLength);
  return title || "fix";
}

export function commitFindingPrTitle(summary: unknown, markdown: unknown = "") {
  const text = [summary, markdown].join("\n");
  if (
    /extension[- ]shard matrix|extension shard|run_checks_node_extensions|checks-node-extensions/i.test(
      text,
    )
  ) {
    return normalizeGithubPrTitle(
      "fix(ci): gate extension aggregate on shard matrix",
      FALLBACK_REPAIR_PR_TITLE,
      CLAWSWEEPER_GENERATED_PR_TITLE_MAX_LENGTH,
    );
  }

  const rawSummary = normalizeTitleText(summary).replace(/^[-*]\s+/, "");
  const stem = findingTitleStem(rawSummary);
  const prefix = /\b(?:CI|workflow|check|job|matrix|GitHub Actions)\b/i.test(rawSummary)
    ? "fix(ci):"
    : "fix:";
  const prefixed = /^fix(?:\(|:)/i.test(stem)
    ? stem
    : `${prefix} ${stem || "address ClawSweeper finding"}`;
  return normalizeGithubPrTitle(
    prefixed,
    FALLBACK_REPAIR_PR_TITLE,
    CLAWSWEEPER_GENERATED_PR_TITLE_MAX_LENGTH,
  );
}

function findingTitleStem(value: string) {
  const withoutFindingPrefix = value
    .replace(/^Found\s+(?:one|two|three|four|five|\d+|an?|the)?\s*/i, "")
    .replace(
      /^(?:(?:concrete|low-severity|medium-severity|high-severity|low-confidence|medium-confidence|high-confidence|critical|high|medium|low)\s+)*/i,
      "",
    )
    .trim();
  const colonIssue = withoutFindingPrefix.match(
    /^((?:[A-Za-z0-9_-]+\s+){0,4}?)(regressions?|bugs?|issues?|findings?|risks?)\s*:\s*(?:the\s+)?(.+?)(?:[.!?]\s|$)/i,
  );
  if (colonIssue) {
    return repairStem(colonIssue[3], `${colonIssue[1] ?? ""}${colonIssue[2] ?? ""}`);
  }

  const scopedIssue = withoutFindingPrefix.match(
    /^((?:[A-Za-z0-9_-]+\s+){0,4}?)(regressions?|bugs?|issues?|findings?|risks?)\s+(?:in|with|around|for|from)\s+(?:the\s+)?(.+?)(?:[.!?:;]\s|$)/i,
  );
  if (scopedIssue) {
    return repairStem(scopedIssue[3], `${scopedIssue[1] ?? ""}${scopedIssue[2] ?? ""}`);
  }

  const beforeColon = withoutFindingPrefix.match(/^([^:]{8,80}?)\s*:/)?.[1];
  return firstSentence(beforeColon || withoutFindingPrefix);
}

function repairStem(surface: unknown, issue: unknown) {
  const subject = firstSentence(surface)
    .replace(/^(?:the\s+)?new\s+/i, "")
    .replace(/^(?:the|a|an)\s+/i, "")
    .trim();
  const suffix = normalizeTitleText(issue).toLowerCase();
  return [subject, suffix].filter(Boolean).join(" ");
}

function firstSentence(value: unknown) {
  return normalizeTitleText(value)
    .split(/(?<=[.!?])\s+/)[0]
    .replace(/[.!?]+$/, "")
    .trim();
}

function compactTitle(value: unknown, maxLength: number) {
  const text = normalizeTitleText(value).replace(/[.!?]+$/, "");
  if (text.length <= maxLength) return text;
  const suffix = "...";
  return `${text
    .slice(0, Math.max(0, maxLength - suffix.length))
    .replace(/[\s,;:./-]+$/, "")}${suffix}`;
}

function normalizeTitleText(value: unknown) {
  return String(value ?? "")
    .replace(/[`*_]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
