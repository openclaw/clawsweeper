import type { OversizedPrSourceSnapshot } from "./clawsweeper-oversized-pr-freshness.js";
import { applyBlockingProtectedLabels, labelNames } from "./clawsweeper-item-policy.js";
import { emptyMaintainerDecision } from "./decision-packets.js";
import {
  ACCEPTED_LARGE_LABEL,
  PR_AUTO_CLOSE_EXEMPT_LABEL_NAMES,
} from "./repair/exact-review-guard-labels.js";
import type { Decision, ItemContext } from "./clawsweeper-types.js";

export const DEFAULT_MAX_PR_CHANGED_LINES = 30_000;
export { ACCEPTED_LARGE_LABEL };

export interface OversizedPullRequestEvidence {
  additions: number;
  deletions: number;
  changedFiles: number;
  threshold: number;
  head: string;
}

export function maxPrChangedLines(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CLAWSWEEPER_MAX_PR_CHANGED_LINES?.trim() ?? "";
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_MAX_PR_CHANGED_LINES;
}

export function oversizedPrCloseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.CLAWSWEEPER_OVERSIZED_PR_CLOSE_ENABLED?.trim() ?? "");
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function evaluateOversizedPullRequest(options: {
  additions?: unknown;
  deletions?: unknown;
  changedFiles?: unknown;
  labels?: unknown;
  head?: unknown;
  threshold?: number;
}): { admitted: true } | { admitted: false; decision: OversizedPullRequestEvidence } {
  const { additions, deletions, changedFiles, head } = options;
  const threshold = options.threshold ?? DEFAULT_MAX_PR_CHANGED_LINES;
  const labels = Array.isArray(options.labels) ? options.labels : [];
  const exempt = new Set<string>([...PR_AUTO_CLOSE_EXEMPT_LABEL_NAMES, ACCEPTED_LARGE_LABEL]);
  if (
    labels.some((label) =>
      exempt.has(
        String(typeof label === "object" && label !== null ? label.name : label)
          .trim()
          .toLowerCase(),
      ),
    )
  ) {
    return { admitted: true };
  }
  // Incomplete metadata is not evidence for a destructive policy decision.
  if (
    !count(additions) ||
    !count(deletions) ||
    !count(changedFiles) ||
    !Number.isSafeInteger(additions + deletions) ||
    !Number.isSafeInteger(threshold) ||
    threshold <= 0 ||
    typeof head !== "string" ||
    !/^[0-9a-f]{40}$/i.test(head) ||
    additions + deletions <= threshold
  ) {
    return { admitted: true };
  }
  return {
    admitted: false,
    decision: { additions, deletions, changedFiles, threshold, head: head.toLowerCase() },
  };
}

export function oversizedPullRequestAdmission(
  pull: Record<string, unknown>,
  threshold = maxPrChangedLines(),
) {
  return pull.state !== "open" || pull.locked === true
    ? ({ admitted: true } as const)
    : evaluateOversizedPullRequest({
        ...pull,
        changedFiles: pull.changed_files,
        head: (pull.head as { sha?: unknown } | undefined)?.sha,
        threshold,
      });
}

export function parseOversizedPullRequestEvidence(
  value: unknown,
): OversizedPullRequestEvidence | null {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const threshold = (value as Record<string, unknown>).threshold;
  if (typeof threshold !== "number" || !Number.isSafeInteger(threshold) || threshold <= 0)
    return null;
  const result = evaluateOversizedPullRequest(value);
  return result.admitted ? null : result.decision;
}

export function oversizedPullRequestComment(
  size: OversizedPullRequestEvidence,
  closed = true,
): string {
  const n = (value: number) => value.toLocaleString("en-US");
  return `ClawSweeper ${closed ? "closed" : "proposes closing"} this pull request because it changes ${n(size.additions + size.deletions)} lines (${n(size.additions)} added, ${n(size.deletions)} removed) across ${n(size.changedFiles)} files, above this repository's ${n(size.threshold)}-line limit for review. Changes this large cannot be reviewed safely or scanned within limits and usually indicate a stale branch merged against an old base. Please open a fresh pull request from current \`main\` containing only the intended change, or split it into focused pull requests. A maintainer can apply \`${ACCEPTED_LARGE_LABEL}\` to exempt a deliberately large change.`;
}

export function oversizedPullRequestContext(pull: Record<string, unknown>): ItemContext {
  return {
    issue: pull,
    comments: [],
    timeline: [],
    pullRequest: { ...pull, changedFiles: pull.changed_files },
  };
}

export function oversizedPullRequestDecision(
  size: OversizedPullRequestEvidence,
  source?: OversizedPrSourceSnapshot | null,
): Decision {
  const unassessed =
    "Not assessed: deterministic metadata-only size admission; no hydration, scanner, or model run.";
  return {
    decision: "close",
    closeReason: "oversized_pull_request",
    confidence: "high",
    oversizedPullRequest: size,
    ...(source ? { oversizedPullRequestSource: source } : {}),
    summary: `Pull request changes ${size.additions + size.deletions} lines, exceeding the ${size.threshold}-line review limit.`,
    changeSummary: unassessed,
    systemContext: "",
    architectureDiagram: "",
    evidence: [
      {
        repo: null,
        label: "GitHub PR size metadata",
        detail: JSON.stringify(size),
        file: null,
        line: null,
        command: null,
        sha: size.head,
      },
    ],
    likelyOwners: [],
    risks: [],
    bestSolution:
      "Open a focused pull request from current main, split the change, or obtain the maintainer size exemption.",
    maintainerDecision: emptyMaintainerDecision(),
    triagePriority: "none",
    impactLabels: [],
    mergeRiskLabels: [],
    maturityLabels: [],
    mergeRiskOptions: [],
    reviewMetrics: [],
    labelJustifications: [],
    itemCategory: "unclear",
    reproductionStatus: "unclear",
    reproductionConfidence: "low",
    requiresNewFeature: false,
    requiresNewConfigOption: false,
    requiresProductDecision: false,
    reproductionAssessment: unassessed,
    solutionAssessment: unassessed,
    visionFit: "not_applicable",
    visionFitReason: unassessed,
    visionFitEvidence: [],
    implementationComplexity: "not_applicable",
    autoImplementationCandidate: "none",
    rootCauseCluster: {
      confidence: "low",
      canonicalRef: null,
      currentItemRelationship: "independent",
      summary: unassessed,
      members: [],
    },
    agentsPolicyStatus: {
      found: false,
      readFully: false,
      applied: false,
      status: "unreadable_or_unclear",
      summary: unassessed,
    },
    reviewFindings: [],
    securityReview: { status: "not_applicable", summary: unassessed, concerns: [] },
    realBehaviorProof: {
      status: "not_applicable",
      summary: unassessed,
      evidenceKind: "not_applicable",
      needsContributorAction: false,
    },
    prRating: {
      proofTier: "NA",
      patchTier: "NA",
      overallTier: "NA",
      summary: unassessed,
      nextSteps: [],
    },
    telegramVisibleProof: { status: "not_needed", summary: unassessed },
    liveProofPlan: {
      status: "not_applicable",
      surface: "none",
      terminalCompletion: "not_applicable",
      reason: unassessed,
      payoff: { kind: "static_text", justification: unassessed },
      entry: "",
      steps: [],
    },
    mantisRecommendation: {
      status: "not_recommended",
      scenario: "none",
      reason: unassessed,
      maintainerComment: "",
    },
    featureShowcase: { status: "none", reason: unassessed },
    overallCorrectness: "not a patch",
    overallConfidenceScore: 0,
    closeComment: oversizedPullRequestComment(size),
    workCandidate: "none",
    workConfidence: "low",
    workPriority: "low",
    workReason: unassessed,
    workPrompt: "",
    workClusterRefs: [],
    workValidation: [],
    workLikelyFiles: [],
  };
}

export function oversizedPullRequestLiveBlockReason(
  size: OversizedPullRequestEvidence | null,
  pull: Record<string, unknown>,
): string | null {
  if (!size) return "oversized PR decision lacks complete size and head evidence";
  if (!oversizedPrCloseEnabled()) return "oversized PR close policy is disabled";
  if (
    !Array.isArray(pull.labels) ||
    applyBlockingProtectedLabels(labelNames(pull.labels), "oversized_pull_request").length > 0
  )
    return "live PR labels are unavailable or protected";
  const live = oversizedPullRequestAdmission(pull);
  if (live.admitted)
    return "live PR is closed, locked, exempt, under the size limit, or lacks size metadata";
  if (
    live.decision.head !== size.head ||
    live.decision.threshold !== size.threshold ||
    live.decision.additions !== size.additions ||
    live.decision.deletions !== size.deletions ||
    live.decision.changedFiles !== size.changedFiles
  )
    return "PR size, threshold, or head changed since admission";
  return null;
}
