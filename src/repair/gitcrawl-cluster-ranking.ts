import { hasSecuritySignalText } from "./lib.js";
import {
  CLOSE_PROTECTED_LABEL_NAMES,
  HUMAN_REVIEW_LABEL,
  MANUAL_ONLY_LABEL,
} from "./exact-review-guard-labels.js";

export type GitcrawlClusterMember = {
  number?: number;
  kind?: string;
  state?: string;
  title?: string;
  body?: string;
  labels_json?: string;
  updated_at?: string;
  representative_title?: string;
};

export type GitcrawlClusterRanking = {
  eligible: boolean;
  score: number;
  reasons: string[];
  signals: string[];
  openMembers: number;
  totalMembers: number;
  latestOpenUpdate: string | null;
};

const BUG_WORDS =
  /\b(?:bug|broken|crash(?:es|ed|ing)?|error|fail(?:s|ed|ing|ure)?|incorrect|regression|hang(?:s|ing)?|panic|leak|corrupt|missing|cannot|can't|doesn't|not working)\b/i;
const FEATURE_WORDS =
  /^\s*\[?\s*(?:feature|enhancement|proposal|rfc)\b|\b(?:feature request|would be nice|please add|support for)\b/i;
const DECISION_WORDS =
  /\b(?:design decision|maintainer decision|needs? (?:a )?decision|product decision|roadmap|policy question|architecture discussion|breaking change proposal)\b/i;
const SECURITY_WORDS =
  /\b(?:credential|secret|token leak|reusable (?:command )?tokens?|expos(?:e|es|ed|ing).{0,40}(?:tokens?|secrets?|credentials?)|forgeable|hardcoded hmac|security|vulnerabilit(?:y|ies)|auth(?:entication|orization)? bypass|remote code execution|arbitrary code execution|code injection|command injection|sql injection|server-side request forgery|ssrf|sandbox escape|rce|xss|csrf|path traversal|privilege escalation)\b/i;

export function hasClusterSecuritySignal(member: GitcrawlClusterMember): boolean {
  const securityLabel = labels(member).some((label) =>
    /(?:^|[^a-z0-9])(?:security|vulnerabilit(?:y|ies)|cve)(?:$|[^a-z0-9])/i.test(label),
  );
  return (
    securityLabel ||
    hasSecuritySignalText(member.title, member.body, labels(member)) ||
    SECURITY_WORDS.test(`${member.title || ""}\n${member.body || ""}`)
  );
}
const DECISION_LABELS = new Set([
  "discussion",
  "question",
  "needs-maintainer-input",
  "needs maintainer input",
  "product-decision",
  "product decision",
  "rfc",
  "clawsweeper:needs-maintainer-review",
  "clawsweeper:needs-product-decision",
  "clawsweeper:no-new-fix-pr",
  HUMAN_REVIEW_LABEL,
  MANUAL_ONLY_LABEL,
  ...CLOSE_PROTECTED_LABEL_NAMES,
]);
const FEATURE_LABELS = new Set(["enhancement", "feature", "feature request", "proposal"]);
const BUG_LABELS = new Set(["bug", "regression", "type: bug", "kind/bug"]);
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "be",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
  "fix",
  "bug",
  "issue",
  "error",
  "fails",
  "failure",
  "support",
]);

export function rankGitcrawlCluster(
  members: readonly GitcrawlClusterMember[],
  options: { asOf: Date; maxAgeDays?: number; maxMembers?: number; minOpenRatio?: number },
): GitcrawlClusterRanking {
  const reasons: string[] = [];
  const signals: string[] = [];
  const open = members.filter((member) => member.state === "open");
  const maxAgeDays = options.maxAgeDays ?? 45;
  const maxMembers = options.maxMembers ?? 8;
  const minOpenRatio = options.minOpenRatio ?? 0.6;
  const latestOpenMs = Math.max(
    ...open.map((member) => Date.parse(String(member.updated_at || ""))).filter(Number.isFinite),
    Number.NEGATIVE_INFINITY,
  );
  const latestOpenUpdate = Number.isFinite(latestOpenMs)
    ? new Date(latestOpenMs).toISOString()
    : null;
  const ageDays = Number.isFinite(latestOpenMs)
    ? Math.max(0, (options.asOf.getTime() - latestOpenMs) / 86_400_000)
    : Number.POSITIVE_INFINITY;

  if (members.length < 2) reasons.push("fewer than two related items");
  if (members.length > maxMembers)
    reasons.push(`broad cluster (${members.length} > ${maxMembers} items)`);
  if (open.length < 2) reasons.push(`insufficient live evidence (${open.length} open item)`);
  if (members.length > 0 && open.length / members.length < minOpenRatio) {
    reasons.push(`closed-dominated (${open.length}/${members.length} open)`);
  }
  if (ageDays > maxAgeDays)
    reasons.push(`stale (${Math.floor(ageDays)}d since latest open update)`);

  const securityMembers = members.filter(hasClusterSecuritySignal);
  if (securityMembers.length > 0) reasons.push("security-sensitive cluster member");

  const featureMembers = open.filter(hasClusterFeatureSignal);
  if (featureMembers.length > 0) reasons.push("feature/proposal live member");
  const decisionMembers = open.filter(hasClusterDecisionSignal);
  if (decisionMembers.length > 0) reasons.push("requires maintainer or product decision");

  const bugMembers = open.filter((member) => {
    const memberLabels = labels(member).map((label) => label.toLowerCase());
    return (
      BUG_WORDS.test(String(member.title || "")) ||
      memberLabels.some((label) => BUG_LABELS.has(label))
    );
  });
  if (bugMembers.length === 0) reasons.push("no high-confidence bug signal");
  else signals.push(`${bugMembers.length}/${open.length} open items carry bug signals`);
  const openIssueMembers = open.filter((member) => member.kind !== "pull_request");
  const issueMembersWithoutBugEvidence = openIssueMembers.filter(
    (member) => !bugMembers.includes(member),
  );
  if (issueMembersWithoutBugEvidence.length > 0) {
    reasons.push(
      `open issue candidates lack high-confidence bug evidence (${issueMembersWithoutBugEvidence.length}/${openIssueMembers.length})`,
    );
  }

  const cohesion = titleCohesion(open);
  if (open.length >= 2 && cohesion < 0.75)
    reasons.push(`low title cohesion (${cohesion.toFixed(2)})`);
  else signals.push(`title cohesion ${cohesion.toFixed(2)}`);

  const openPulls = open.filter((member) => member.kind === "pull_request").length;
  const openIssues = openIssueMembers.length;
  if (openPulls > 0)
    signals.push(`${openPulls} open implementation PR${openPulls === 1 ? "" : "s"}`);
  if (latestOpenUpdate) signals.push(`latest open update ${latestOpenUpdate.slice(0, 10)}`);

  let score = 100;
  score -= Math.max(0, members.length - 2) * 6;
  score -= Math.min(35, Math.floor(ageDays));
  score -= Math.round((1 - cohesion) * 20);
  score -= (open.length - bugMembers.length) * 5;
  score += Math.min(12, openPulls * 6);
  score += Math.min(6, openIssues * 2);
  if (reasons.length > 0) score -= 100 + reasons.length * 10;

  return {
    eligible: reasons.length === 0,
    score,
    reasons,
    signals,
    openMembers: open.length,
    totalMembers: members.length,
    latestOpenUpdate,
  };
}

export function hasClusterFeatureSignal(member: GitcrawlClusterMember): boolean {
  const memberLabels = labels(member).map((label) => label.toLowerCase());
  return (
    FEATURE_WORDS.test(`${member.title || ""}\n${member.body || ""}`) ||
    memberLabels.some((label) => FEATURE_LABELS.has(label))
  );
}

export function hasClusterDecisionSignal(member: GitcrawlClusterMember): boolean {
  const memberLabels = labels(member).map((label) => label.toLowerCase());
  return (
    DECISION_WORDS.test(`${member.title || ""}\n${member.body || ""}`) ||
    memberLabels.some((label) => DECISION_LABELS.has(label))
  );
}

function labels(member: GitcrawlClusterMember): string[] {
  try {
    const parsed = JSON.parse(String(member.labels_json || "[]"));
    return Array.isArray(parsed)
      ? parsed
          .map((label) => {
            if (typeof label === "string") return label;
            if (label && typeof label === "object" && "name" in label) {
              return String((label as { name?: unknown }).name || "");
            }
            return "";
          })
          .filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function titleCohesion(members: readonly GitcrawlClusterMember[]): number {
  if (members.length <= 1) return 1;
  const tokenSets = members.map((member) => titleTokens(String(member.title || "")));
  let relatedPairs = 0;
  let totalPairs = 0;
  for (let index = 0; index < tokenSets.length; index += 1) {
    for (let candidateIndex = index + 1; candidateIndex < tokenSets.length; candidateIndex += 1) {
      totalPairs += 1;
      const current = tokenSets[index]!;
      const candidate = tokenSets[candidateIndex]!;
      const shared = [...current].filter((token) => candidate.has(token));
      if (shared.length >= 2) relatedPairs += 1;
    }
  }
  return totalPairs > 0 ? relatedPairs / totalPairs : 1;
}

function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9_-]{2,}/g)
      ?.filter((token) => !STOP_WORDS.has(token)) ?? [],
  );
}
