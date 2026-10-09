import { hasShinyProof, themedRatingName } from "./clawsweeper-rating.js";
import { publicLikelyOwner } from "./clawsweeper-regression-provenance.js";
import { PR_STATUS_LABELS } from "./clawsweeper-policy.js";
import type { RealBehaviorProofPolicy } from "./clawsweeper-proof-policy.js";
import type {
  Evidence,
  ItemContext,
  LikelyOwner,
  PrRating,
  PrRatingTier,
  PrStatusLabelKind,
  PullRequestReviewState,
  ReviewFinding,
  SecurityConcern,
  SecurityReview,
  TriagePriority,
} from "./clawsweeper-types.js";
import { frontMatterStringArray } from "./report-front-matter.js";
import { isCommitSha, normalizeEvidence, splitFileAndLine } from "./clawsweeper-links.js";
import { publicTableCell } from "./clawsweeper-report-helpers.js";
import { reportEvidence } from "./clawsweeper-report-parser.js";

export function sentence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /[.!?)]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export function normalizePublicReviewText(value: string): string {
  return value
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[`*_~#[\]()>.,:;!?'"-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function publicReviewTextDiffers(left: string, right: string): boolean {
  const normalizedLeft = normalizePublicReviewText(left);
  const normalizedRight = normalizePublicReviewText(right);
  if (!normalizedLeft || !normalizedRight) return normalizedLeft !== normalizedRight;
  return (
    normalizedLeft !== normalizedRight &&
    !normalizedLeft.includes(normalizedRight) &&
    !normalizedRight.includes(normalizedLeft)
  );
}

export function isReportNoneList(value: string): boolean {
  return !value.trim() || value.trim() === "- none";
}

export function priorityLabel(priority: ReviewFinding["priority"]): string {
  return `P${priority}`;
}

export function stripListMarker(text: string): string {
  return text
    .trim()
    .replace(/^[-*]\s+/, "")
    .trim();
}

// The report stores each `risks` entry as one list item; a long entry can wrap
// onto more lines. This returns one string for each entry.
export function reportRiskEntries(text: string): string[] {
  const entries: string[] = [];
  let current: string[] = [];
  const flush = () => {
    const entry = current.join(" ").trim();
    if (entry) entries.push(entry);
    current = [];
  };
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      flush();
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      flush();
      current.push(stripListMarker(line));
      continue;
    }
    current.push(line);
  }
  flush();
  return entries.filter((entry) => !isReportNoneList(entry) && !/^none[.!]?$/i.test(entry));
}

export function reviewFindingLocation(
  finding: Pick<ReviewFinding, "file" | "lineStart" | "lineEnd">,
): string {
  const line =
    finding.lineStart === finding.lineEnd
      ? `${finding.lineStart}`
      : `${finding.lineStart}-${finding.lineEnd}`;
  return `${finding.file}:${line}`;
}

function realBehaviorProofReReviewGuidance(): string {
  return "After adding proof, update the PR body; ClawSweeper should re-review automatically. If it does not, the PR author or someone with repository write access can comment `@clawsweeper re-review`.";
}

function realBehaviorProofBlockerSummary(summary: string, fallback: string): string {
  const body = sentence(summary) || fallback;
  if (/\b(?:@clawsweeper re-review|re-review automatically|update the PR body)\b/i.test(body)) {
    return body;
  }
  return `${body} ${realBehaviorProofReReviewGuidance()}`;
}

export function publicHistoricalVerificationBlockerLine(): string {
  return "A historical verification receipt failed or is malformed. A maintainer must resolve that verification blocker before merge; independently assessed contributor proof remains valid.";
}

// The Before merge item owns the proof ask. Other sections point to it.
export function publicRealBehaviorProofLine(policy: RealBehaviorProofPolicy): string {
  const proof = policy.assessment;
  const summary = sentence(proof.summary);
  if (proof.status === "not_applicable") {
    return `Required by policy: the recorded not-applicable assessment does not satisfy the current PR proof policy. Put relevant after-change evidence in the main PR body, then request a fresh review with \`@clawsweeper re-review\`.${summary ? ` Recorded reviewer context: ${summary}` : ""}`;
  }
  return realBehaviorProofBlockerSummary(
    summary,
    proof.status === "mock_only"
      ? "Tests, mocks, snapshots, lint, typechecks, and CI are supplemental only. Screenshots or videos are preferred when they can show the behavior; terminal screenshots, console output, copied live output, linked artifacts, and redacted logs count. Redact private information like IP addresses, API keys, phone numbers, non-public endpoints, and other private details before posting evidence."
      : "The PR must include after-fix evidence from a real setup. Screenshots or videos are preferred when they can show the behavior; terminal screenshots, console output, copied live output, linked artifacts, and redacted logs count. Redact private information like IP addresses, API keys, phone numbers, non-public endpoints, and other private details before posting evidence.",
  );
}

interface ReviewPresentationDependencies {
  docsPageUrl: (file: string, repo?: string) => string | null;
  fileUrl: (file: string, sha: string, line?: number, repo?: string) => string;
  hasRepairLoopPauseLabel: (labels: readonly string[]) => boolean;
  latestFileUrl: (file: string, repo?: string) => string;
  linkedSha: (sha: string, repo?: string) => string;
  markdownLink: (label: string, url: string) => string;
  prStatusLabelKindFromReport: (
    markdown: string,
    context: Pick<ItemContext, "comments" | "timeline">,
    currentLabels: readonly string[],
  ) => PrStatusLabelKind | null;
  securityConcernLocation: (concern: SecurityConcern) => string;
  targetRepo: () => string;
}

export function createReviewPresentation({
  docsPageUrl,
  fileUrl,
  hasRepairLoopPauseLabel,
  latestFileUrl,
  linkedSha,
  markdownLink,
  prStatusLabelKindFromReport,
  securityConcernLocation,
  targetRepo,
}: ReviewPresentationDependencies) {
  function publicReviewTextIsSame(left: string, right: string): boolean {
    const normalizedLeft = normalizePublicReviewText(left);
    const normalizedRight = normalizePublicReviewText(right);
    return Boolean(normalizedLeft) && normalizedLeft === normalizedRight;
  }

  function isLinkableSourceRef(file: string): boolean {
    if (file.includes("/")) return true;
    return ["AGENTS.md", "CHANGELOG.md", "README.md", "VISION.md"].includes(file);
  }

  function linkInlineSourceRefs(value: string, evidence: Evidence): string {
    if (!evidence.sha || !evidence.repo) return value;
    return value.replace(
      /\[[^\]\n]*\]\([^\s)]+\)|`([^`]+\.(?:css|js|json|jsx|md|mdx|mjs|sh|ts|tsx|yaml|yml)(?::\d+)?)`/g,
      (match, ref: string | undefined) => {
        if (!ref) return match;
        const { file, line } = splitFileAndLine(ref);
        const source = normalizeEvidence({ ...evidence, file, line: line ?? null });
        if (!isLinkableSourceRef(file) || !source.repo || !source.sha) return match;
        const docsUrl = docsPageUrl(file, source.repo);
        const url =
          docsUrl ??
          (file === "VISION.md" && !line && source.repo === targetRepo()
            ? latestFileUrl(file, source.repo)
            : fileUrl(file, source.sha, line, source.repo));
        return markdownLink(`\`${ref}\``, url);
      },
    );
  }

  function linkPrimaryEvidenceFile(value: string, evidence: Evidence): string {
    if (!evidence.file || !evidence.sha || !evidence.repo) return value;
    const docsUrl = docsPageUrl(evidence.file, evidence.repo);
    if (docsUrl && !value.includes(docsUrl)) {
      return `${value} Public docs: ${markdownLink(`\`${evidence.file}\``, docsUrl)}.`;
    }
    if (evidence.file !== "VISION.md" || value.includes("VISION.md")) return value;
    const link = markdownLink(
      "`VISION.md`",
      evidence.repo === targetRepo()
        ? latestFileUrl(evidence.file, evidence.repo)
        : fileUrl(evidence.file, evidence.sha, evidence.line ?? undefined, evidence.repo),
    );
    const linked = value
      .replace(/\b(?:the project vision|project vision|the vision|VISION)\b/i, link)
      .replace(/^Current main says\b/, `${link} says`)
      .replace(/^The roadmap guardrails explicitly list\b/, `${link} guardrails explicitly list`);
    return linked === value ? `${link}: ${value}` : linked;
  }

  function evidenceLocation(evidence: Evidence): string {
    const parts: string[] = [];
    if (evidence.file) {
      const location = evidence.line ? `${evidence.file}:${evidence.line}` : evidence.file;
      const docsUrl = evidence.repo ? docsPageUrl(evidence.file, evidence.repo) : null;
      const sourceUrl =
        evidence.sha && evidence.repo
          ? fileUrl(evidence.file, evidence.sha, evidence.line ?? undefined, evidence.repo)
          : null;
      const url = docsUrl ?? sourceUrl;
      parts.push(url ? markdownLink(`\`${location}\``, url) : `\`${location}\``);
    }
    if (evidence.sha)
      parts.push(evidence.repo ? linkedSha(evidence.sha, evidence.repo) : `\`${evidence.sha}\``);
    return parts.length ? ` (${parts.join(", ")})` : "";
  }

  function closeEvidenceLine(evidence: Evidence): string {
    evidence = normalizeEvidence(evidence);
    const label = evidence.label.trim();
    const detail = linkPrimaryEvidenceFile(
      linkInlineSourceRefs(sentence(evidence.detail), evidence),
      evidence,
    );
    const prefix = label ? `**${label}:** ` : "";
    return `- ${prefix}${detail}${evidenceLocation(evidence)}`;
  }

  // Publish only people tied to a verified commit. An unverified routing candidate is not a fact.
  function likelyOwnerLines(owners: readonly LikelyOwner[]): string[] {
    return owners
      .map(publicLikelyOwner)
      .filter(
        (owner) =>
          owner.person.trim() && owner.commits.some((commit) => isCommitSha(commit.trim())),
      )
      .slice(0, 5)
      .map((owner) => {
        const role = owner.role.trim();
        const reason = sentence(owner.reason.trim() || "Related by repository history.");
        const commits = owner.commits
          .map((commit) => commit.trim())
          .filter(isCommitSha)
          .slice(0, 3)
          .map((commit) => linkedSha(commit))
          .join(", ");
        const files = owner.files
          .filter(Boolean)
          .slice(0, 3)
          .map((file) => `\`${file}\``)
          .join(", ");
        const suffix = [
          role ? `role: ${role}` : "",
          `confidence: ${owner.confidence}`,
          `commits: ${commits}`,
          files ? `files: ${files}` : "",
        ].filter(Boolean);
        return `- **${owner.person.trim()}:** ${reason} (${suffix.join("; ")})`;
      });
  }

  function publicRiskBullets(text: string): string {
    return reportRiskEntries(text)
      .map((entry) => `- ${sentence(entry)}`)
      .join("\n");
  }

  function confidenceText(score: number): string {
    return score.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  }

  function reviewFindingSummaryLine(finding: ReviewFinding): string {
    return `- [${priorityLabel(finding.priority)}] ${finding.title.trim()} — \`${reviewFindingLocation(
      finding,
    )}\``;
  }

  function reviewFindingDetailedLine(finding: ReviewFinding): string {
    return [
      reviewFindingSummaryLine(finding),
      `  ${sentence(finding.body)}`,
      `  Confidence: ${confidenceText(finding.confidenceScore)}`,
      ...(finding.lateFinding
        ? ["  Late finding: first raised on code an earlier review cycle already covered."]
        : []),
    ].join("\n");
  }

  function securityConcernSummaryLine(concern: SecurityConcern): string {
    const location = securityConcernLocation(concern);
    const suffix = location === "not tied to a single file" ? "" : ` — \`${location}\``;
    return `- [${concern.severity}] ${concern.title.trim()}${suffix}`;
  }

  function securityConcernDetailedLine(concern: SecurityConcern): string {
    return [
      securityConcernSummaryLine(concern),
      `  ${sentence(concern.body)}`,
      `  Confidence: ${confidenceText(concern.confidenceScore)}`,
    ].join("\n");
  }

  function securityReviewLine(review: SecurityReview): string {
    const prefix =
      review.status === "needs_attention"
        ? "Security review needs attention"
        : review.status === "cleared"
          ? "Security review cleared"
          : "Security review";
    return `${prefix}: ${sentence(review.summary)}`;
  }

  function publicSecurityReviewLine(review: SecurityReview): string {
    if (review.status !== "needs_attention" && review.concerns.length === 0) return "None.";
    const prefix =
      review.status === "needs_attention"
        ? "Needs attention"
        : review.status === "cleared"
          ? "Cleared"
          : "Not applicable";
    return `${prefix}: ${sentence(review.summary)}`;
  }

  // The proof tier stays rated when the contributor proof gate does not apply,
  // so the row shows what proof exists, not the gate status.
  function publicProofMeaning(rating: PrRating, policy: RealBehaviorProofPolicy): string {
    if (policy.proofBlocksMerge) {
      return "Real behavior proof is necessary before merge. See [Before merge](#before-merge).";
    }
    const proof = policy.assessment;
    const summary = sentence(proof.summary);
    if (rating.proofTier === "NA") {
      return summary
        ? `Not applicable: ${summary}`
        : "Real behavior proof does not apply to this change.";
    }
    switch (proof.status) {
      case "sufficient":
        return `Sufficient (${proof.evidenceKind}): ${summary}`;
      case "override":
        return `Override: ${summary || "A maintainer applied proof: override."}`;
      default:
        return summary || "No real behavior proof was supplied.";
    }
  }

  function publicRankScaleLine(): string {
    const tiers: readonly PrRatingTier[] = ["S", "A", "B", "C", "D", "F"];
    const scale = tiers
      .map((tier) => `${publicRatingScore(tier)}/6 ${themedRatingName(tier)}`)
      .join(" · ");
    return `${scale}. Overall follows the weaker of proof and patch quality; ✨ marks media proof (a screenshot, video, or linked artifact) that directly shows the changed behavior.`;
  }

  function publicRatingScore(tier: PrRatingTier): number | null {
    switch (tier) {
      case "S":
        return 6;
      case "A":
        return 5;
      case "B":
        return 4;
      case "C":
        return 3;
      case "D":
        return 2;
      case "F":
        return 1;
      case "NA":
        return null;
    }
  }

  function publicRatedName(tier: PrRatingTier): string {
    const score = publicRatingScore(tier);
    return `${themedRatingName(tier)}${score === null ? "" : ` **(${score}/6)**`}`;
  }

  function publicReviewScoresBlock(
    rating: PrRating,
    policy: RealBehaviorProofPolicy,
    findings: readonly ReviewFinding[],
    securityReview: SecurityReview,
  ): string {
    const shiny = hasShinyProof(policy.assessment) ? " ✨ media proof bonus" : "";
    let overallMeaning =
      sentence(rating.summary) ||
      "Overall readiness follows the weaker of proof and patch quality.";
    const proofMeaning = publicProofMeaning(rating, policy);
    if (policy.proofBlocksMerge && policy.assessment.status === "not_applicable") {
      overallMeaning = `Recorded reviewer rating: ${overallMeaning} Real behavior proof remains required by host policy.`;
    }
    const patchMeaning =
      securityReview.status === "needs_attention" || securityReview.concerns.length > 0
        ? "Security review found an item that needs attention."
        : findings.length > 0
          ? `${findings.length} actionable review ${findings.length === 1 ? "finding" : "findings"} remain.`
          : rating.patchTier === "F" || rating.patchTier === "D"
            ? sentence(rating.summary) ||
              "Patch quality blocks readiness; see the Before merge checklist."
            : "No actionable review findings were identified.";
    return [
      "| Measure | Result | What it means |",
      "|---|---|---|",
      `| **Overall readiness** | ${publicRatedName(rating.overallTier)} | ${publicTableCell(overallMeaning)} |`,
      `| **Proof confidence** | ${publicRatedName(rating.proofTier)}${shiny} | ${publicTableCell(proofMeaning)} |`,
      `| **Patch quality** | ${publicRatedName(rating.patchTier)} | ${publicTableCell(patchMeaning)} |`,
    ].join("\n");
  }

  function publicMergeReadinessBlock(
    reviewState: PullRequestReviewState,
    priority: TriagePriority,
    bottomLine: string,
    remainingItemCount: number,
    decisionNeeded: boolean,
    reviewedHeadSha: string,
  ): string {
    const result =
      reviewState === "ready"
        ? "Ready for maintainer review"
        : reviewState === "needs-changes"
          ? "Needs changes before merge"
          : "Blocked before merge";
    const icon =
      reviewState === "ready" && remainingItemCount === 0 && !decisionNeeded ? "✅" : "⛔";
    const remaining =
      remainingItemCount > 0
        ? ` - ${remainingItemCount} ${remainingItemCount === 1 ? "item remains" : "items remain"}`
        : "";
    const lines = [
      `${icon} **${result}${remaining}**`,
      "",
      sentence(bottomLine),
      "",
      `**Priority:** ${priority === "none" ? "None" : priority}`,
    ];
    if (reviewedHeadSha) lines.push(`**Reviewed head:** \`${reviewedHeadSha}\``);
    if (decisionNeeded) {
      lines.push("**Owner decision:** Required. See [Decision needed](#decision-needed).");
    }
    return lines.join("\n");
  }

  function publicFailedReviewReadinessBlock(markdown: string): string {
    const reason =
      reportEvidence(markdown)
        .find((entry) => entry.label === "failure reason")
        ?.detail.trim() || "Codex review failed before completion.";
    return [
      "Not assessed.",
      `Failure reason: ${sentence(reason)}`,
      "",
      "This is a ClawSweeper/Codex infrastructure failure, not a PR readiness or patch-quality verdict.",
      "Keep any merge decision on the normal maintainer review path until ClawSweeper can complete a fresh review.",
    ].join("\n");
  }

  function activeRepairStatusFromLabels(labels: readonly string[]): PrStatusLabelKind | null {
    for (const kind of ["re_review_loop", "actively_grinding"] as const) {
      const status = PR_STATUS_LABELS.find((candidate) => candidate.kind === kind);
      if (status && labels.includes(status.name)) return kind;
    }
    return null;
  }

  // Without live context, keep the repair-loop status from the current labels.
  // The label policy owns every other status, so it agrees with Before merge.
  function prStatusLabelKindFromReportLabels(markdown: string): PrStatusLabelKind | null {
    const parsedLabels = frontMatterStringArray(markdown, "labels");
    if (hasRepairLoopPauseLabel(parsedLabels)) return null;
    return (
      activeRepairStatusFromLabels(parsedLabels) ??
      prStatusLabelKindFromReport(markdown, { comments: [], timeline: [] }, parsedLabels)
    );
  }

  return {
    closeEvidenceLine,
    confidenceText,
    isReportNoneList,
    likelyOwnerLines,
    normalizePublicReviewText,
    prStatusLabelKindFromReportLabels,
    priorityLabel,
    publicFailedReviewReadinessBlock,
    publicHistoricalVerificationBlockerLine,
    publicMergeReadinessBlock,
    publicRankScaleLine,
    publicRealBehaviorProofLine,
    publicReviewScoresBlock,
    publicReviewTextDiffers,
    publicReviewTextIsSame,
    publicRiskBullets,
    publicSecurityReviewLine,
    reportRiskEntries,
    reviewFindingDetailedLine,
    reviewFindingLocation,
    reviewFindingSummaryLine,
    securityConcernDetailedLine,
    securityConcernSummaryLine,
    securityReviewLine,
    sentence,
    stripListMarker,
  };
}
