import { hasShinyProof, themedRatingName } from "./clawsweeper-rating.js";
import { publicLikelyOwner } from "./clawsweeper-regression-provenance.js";
import { MERGE_READY_LABEL, PR_STATUS_LABELS } from "./clawsweeper-policy.js";
import {
  AUTOMERGE_LABEL,
  HUMAN_REVIEW_LABEL,
  MANUAL_ONLY_LABEL,
} from "./repair/exact-review-guard-labels.js";
import type { RealBehaviorProofPolicy } from "./clawsweeper-proof-policy.js";
import type {
  Evidence,
  LikelyOwner,
  MantisRecommendation,
  MantisRecommendationScenario,
  PrRating,
  PrRatingTier,
  PrStatusLabelKind,
  PublicPriority,
  ReviewFinding,
  SecurityConcern,
  SecurityReview,
  TriagePriority,
} from "./clawsweeper-types.js";

interface ReviewPresentationDependencies {
  docsPageUrl: (file: string, repo?: string) => string | null;
  fileUrl: (file: string, sha: string, line?: number, repo?: string) => string;
  normalizeEvidence: (entry: Evidence) => Evidence;
  frontMatterStringArray: (markdown: string, key: string) => string[];
  frontMatterValue: (markdown: string, key: string) => string | undefined;
  hasDispatchableMantisScenario: (recommendation: MantisRecommendation) => boolean;
  hasRepairLoopPauseLabel: (labels: readonly string[]) => boolean;
  isCommitSha: (value: string) => boolean;
  latestFileUrl: (file: string, repo?: string) => string;
  linkedSha: (sha: string, repo?: string) => string;
  markdownLink: (label: string, url: string) => string;
  publicTableCell: (value: string) => string;
  reportEvidence: (markdown: string) => Evidence[];
  reportRealBehaviorProofPolicy: (markdown: string) => RealBehaviorProofPolicy;
  securityConcernLocation: (concern: SecurityConcern) => string;
  splitFileAndLine: (file: string) => { file: string; line?: number };
  targetRepo: () => string;
}

export function createReviewPresentation({
  docsPageUrl,
  fileUrl,
  normalizeEvidence,
  frontMatterStringArray,
  frontMatterValue,
  hasDispatchableMantisScenario,
  hasRepairLoopPauseLabel,
  isCommitSha,
  latestFileUrl,
  linkedSha,
  markdownLink,
  publicTableCell,
  reportEvidence,
  reportRealBehaviorProofPolicy,
  securityConcernLocation,
  splitFileAndLine,
  targetRepo,
}: ReviewPresentationDependencies) {
  function sentence(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return "";
    return /[.!?)]$/.test(trimmed) ? trimmed : `${trimmed}.`;
  }

  function normalizePublicReviewText(value: string): string {
    return value
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, "")
      .replace(/[`*_~#[\]()>.,:;!?'"-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function publicReviewTextDiffers(left: string, right: string): boolean {
    const normalizedLeft = normalizePublicReviewText(left);
    const normalizedRight = normalizePublicReviewText(right);
    if (!normalizedLeft || !normalizedRight) return normalizedLeft !== normalizedRight;
    return (
      normalizedLeft !== normalizedRight &&
      !normalizedLeft.includes(normalizedRight) &&
      !normalizedRight.includes(normalizedLeft)
    );
  }

  function publicReviewTextIsSame(left: string, right: string): boolean {
    const normalizedLeft = normalizePublicReviewText(left);
    const normalizedRight = normalizePublicReviewText(right);
    return Boolean(normalizedLeft) && normalizedLeft === normalizedRight;
  }

  function isReportNoneList(value: string): boolean {
    return !value.trim() || value.trim() === "- none";
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

  function publicLikelyOwnerRole(role: string): string {
    return role
      .trim()
      .replace(/\brecent workflow maintainers\b/gi, "recent workflow contributors")
      .replace(/\brecent workflow maintainer\b/gi, "recent workflow contributor")
      .replace(/\brecent adjacent maintainers\b/gi, "recent adjacent contributors")
      .replace(/\brecent adjacent maintainer\b/gi, "recent adjacent contributor")
      .replace(/\brecent maintainers\b/gi, "recent area contributors")
      .replace(/\brecent maintainer\b/gi, "recent area contributor");
  }

  function likelyOwnerLine(owner: LikelyOwner): string {
    owner = publicLikelyOwner(owner);
    const person = owner.person.trim() || "unknown";
    const role = publicLikelyOwnerRole(owner.role);
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
      commits ? `commits: ${commits}` : "",
      files ? `files: ${files}` : "",
    ].filter(Boolean);
    return `- **${person}:** ${reason}${suffix.length ? ` (${suffix.join("; ")})` : ""}`;
  }

  function priorityLabel(priority: ReviewFinding["priority"]): string {
    return `P${priority}`;
  }

  function publicPriorityFromText(text: string, fallback: PublicPriority): PublicPriority {
    if (/\b(?:outage|data loss|security exposure|release blocker|widespread)\b/i.test(text)) {
      return "P0";
    }
    if (
      /\b(?:major regression|blocked workflow|compatibility(?:\s+|-)?break|fail(?:\s+|-)?closed|lifecycle break)\b/i.test(
        text,
      )
    ) {
      return "P1";
    }
    if (/\b(?:localized|non-blocking|nonblocking|recoverable|fallback|timeout)\b/i.test(text)) {
      return "P2";
    }
    return fallback;
  }

  function stripPriorityPrefix(text: string): string {
    return text
      .trim()
      .replace(/^[-*]\s+/, "")
      .replace(/^(?:\*\*)?\[P[0-2]\](?:\*\*)?\s*/i, "")
      .trim();
  }

  function publicPriorityBullet(priority: PublicPriority, text: string): string {
    return `- [${priority}] ${stripPriorityPrefix(sentence(text))}`;
  }

  function publicPriorityBulletFromText(text: string, fallback: PublicPriority): string {
    return publicPriorityBullet(publicPriorityFromText(text, fallback), text);
  }

  function publicPlainBullet(text: string): string {
    return `- ${stripPriorityPrefix(sentence(text))}`;
  }

  function isActionablePriorityText(text: string): boolean {
    const body = stripPriorityPrefix(text);
    if (!body || isReportNoneList(body)) return false;
    if (isRoutineCiOrReviewText(body)) {
      return false;
    }
    return /\b(?:add|block|blocked|break|fail(?:\s+|-)?closed|fix|implement|missing|must|need(?:s|ed)?|prove|reject|repair|required|validate|before merge)\b/i.test(
      body,
    );
  }

  function isRoutineCiOrReviewText(text: string): boolean {
    const body = stripPriorityPrefix(text);
    const mentionsCheckState =
      /\b(?:ci|status|required(?: status)?)(?:\/status)? checks?(?:(?:\s+(?:are|were|is|was|remain|remains))?\s+(?:green|passing|pass(?:es|ed|ing)?)|\s+(?:have|has)\s+passed|\s+to\s+pass)\b/i.test(
        body,
      );
    const hasCheckStateContrast = /\b(?:although|but|despite|even though|even when|while)\b/i.test(
      body,
    );
    const checkContrastRemainder = body
      .replace(
        /\b(?:ci|status|required(?: status)?)(?:\/status)? checks?(?:(?:\s+(?:are|were|is|was|remain|remains))?\s+(?:green|passing|pass(?:es|ed|ing)?)|\s+(?:have|has)\s+passed|\s+to\s+pass)?\b/gi,
        "",
      )
      .replace(/\b(?:no|without) (?:any )?(?:test )?failures?\b/gi, "")
      .replace(
        /\b(?:maintainer review is still required|required approvals? (?:are )?complete)\b/gi,
        "",
      );
    const hasSeparateContrastBlocker =
      /\b(?:add|before merge|block(?:s|ed|ing)?|blocker|break(?:s|ing)?|broken|cover(?:s|ed|ing)?|coverage|crash(?:es|ed|ing)?|data loss|exposure|fail(?:s|ed|ing)?|fix|gap|implement|low|missing|must|need(?:s|ed)?|quality|required|risk|security|test-gap|unsafe|untested|validate|vulnerab(?:le|ility))\b/i.test(
        checkContrastRemainder,
      );
    const isRoutineReviewOrApprovalGate =
      !hasSeparateContrastBlocker &&
      /\b(?:maintainer review is still required|required approvals? (?:are )?complete)\b/i.test(
        body,
      );
    if (
      mentionsCheckState &&
      (/\b(?:break(?:s|ing)?|broken|bypass(?:es|ed|ing)?|incorrect(?:ly)?|unsafe)\b/i.test(body) ||
        /\b(?:disabled|did not run|do not run|not run(?:ning)?|skipp(?:ed|ing))\b/i.test(body) ||
        /\bno\b.*\b(?:test(?:s|ing)?|validat(?:e|ed|es|ing|ion))\b.*\bruns?\b/i.test(body) ||
        /\bwithout\b(?!\s+(?:any\s+)?(?:test\s+)?failures?\b)/i.test(body) ||
        /\bwith (?:only )?(?:insufficient|limited|mock(?:ed)?|stub(?:bed)?|weak)\b.*\b(?:coverage|test(?:s|ing)?|validat(?:e|ed|es|ing|ion))\b/i.test(
          body,
        ) ||
        /\bwith no\b.*\b(?:coverage|test(?:s|ing)?|validat(?:e|ed|es|ing|ion))\b/i.test(body) ||
        /\bbecause\b.*\b(?:mock(?:ed|-only)?|stub(?:bed)?|test(?:s|ing)?|validat(?:e|ed|es|ing|ion))\b/i.test(
          body,
        ) ||
        hasSeparateContrastBlocker ||
        (hasCheckStateContrast &&
          !isRoutineReviewOrApprovalGate &&
          (!/\b(?:no|without) (?:any )?(?:test )?failures?\b/i.test(body) ||
            hasSeparateContrastBlocker)))
    ) {
      return false;
    }
    if (mentionsCheckState && isRoutineReviewOrApprovalGate) {
      return true;
    }
    return /\b(?:no automated repair|no clawsweeper repair|normal maintainer review|maintainer review and ci|ready for maintainer review|flaky ci|red ci|unrelated (?:ci|status checks?)|(?:ci|status|required(?: status)?)(?:\/status)? checks?(?:(?=\s*(?:and (?:maintainer review|required approvals?)|[.!?;,)]|$))| (?:(?:are|were|is|was|remain|remains) (?:green|passing|pass|red|failing|pending|missing|flaky|unrelated)|pass(?:es|ed)?|(?:have|has) passed|to pass)))\b/i.test(
      body,
    );
  }

  function publicPriorityBulletIfActionable(text: string, fallback: PublicPriority): string {
    return isActionablePriorityText(text)
      ? publicPriorityBulletFromText(text, fallback)
      : publicPlainBullet(text);
  }

  function publicRiskBulletsFromText(text: string, fallback: PublicPriority): string {
    const lines = text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const bulletLines = lines.filter((line) => /^[-*]\s+/.test(line));
    if (!bulletLines.length) {
      return isRoutineCiOrReviewText(text)
        ? publicPlainBullet(text)
        : publicPriorityBulletFromText(text, fallback);
    }
    return bulletLines
      .map((line) =>
        isRoutineCiOrReviewText(line)
          ? publicPlainBullet(line)
          : publicPriorityBulletFromText(line, fallback),
      )
      .join("\n");
  }

  function confidenceText(score: number): string {
    return score.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  }

  function reviewFindingLocation(
    finding: Pick<ReviewFinding, "file" | "lineStart" | "lineEnd">,
  ): string {
    const line =
      finding.lineStart === finding.lineEnd
        ? `${finding.lineStart}`
        : `${finding.lineStart}-${finding.lineEnd}`;
    return `${finding.file}:${line}`;
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

  function publicHistoricalVerificationBlockerLine(): string {
    return "A historical verification receipt failed or is malformed. A maintainer must resolve that verification blocker before merge; independently assessed contributor proof remains valid.";
  }

  function publicRealBehaviorProofLine(policy: RealBehaviorProofPolicy): string {
    const proof = policy.assessment;
    const summary = sentence(proof.summary);
    if (policy.proofBlocksMerge && proof.status === "not_applicable") {
      return `Required by policy: the recorded not-applicable assessment does not satisfy the current PR proof policy. Put relevant after-change evidence in the main PR body, then request a fresh review with \`@clawsweeper re-review\`.${summary ? ` Recorded reviewer context: ${summary}` : ""}`;
    }
    switch (proof.status) {
      case "sufficient":
        return `Sufficient (${proof.evidenceKind}): ${summary}`;
      case "override":
        return `Override: ${summary || "A maintainer applied proof: override."}`;
      case "missing":
        return `Needs real behavior proof before merge: ${realBehaviorProofBlockerSummary(
          summary,
          "The PR must include after-fix evidence from a real setup. Screenshots or videos are preferred when they can show the behavior; terminal screenshots, console output, copied live output, linked artifacts, and redacted logs count. Redact private information like IP addresses, API keys, phone numbers, non-public endpoints, and other private details before posting evidence.",
        )}`;
      case "mock_only":
        return `Needs real behavior proof before merge: ${realBehaviorProofBlockerSummary(
          summary,
          "Tests, mocks, snapshots, lint, typechecks, and CI are supplemental only. Screenshots or videos are preferred when they can show the behavior; terminal screenshots, console output, copied live output, linked artifacts, and redacted logs count. Redact private information like IP addresses, API keys, phone numbers, non-public endpoints, and other private details before posting evidence.",
        )}`;
      case "insufficient":
        return `Needs stronger real behavior proof before merge: ${realBehaviorProofBlockerSummary(
          summary,
          "Include after-fix evidence from a real setup. Screenshots or videos are preferred when they can show the behavior; terminal screenshots, console output, copied live output, linked artifacts, and redacted logs count. Redact private information like IP addresses, API keys, phone numbers, non-public endpoints, and other private details before posting evidence.",
        )}`;
      case "not_applicable":
        return summary ? `Not applicable: ${summary}` : "";
    }
  }

  function publicRankDetailsBlock(): string {
    return [
      "| Score | Internal tier | Crab rank | Meaning |",
      "|---:|:---:|---|---|",
      "| **6/6** | S | 🦀 challenger crab | Exceptional readiness |",
      "| **5/6** | A | 🦞 diamond lobster | Very strong readiness |",
      "| **4/6** | B | 🐚 platinum hermit | Good normal PR; ordinary maintainer review |",
      "| **3/6** | C | 🦐 gold shrimp | Useful, but confidence is limited |",
      "| **2/6** | D | 🦪 silver shellfish | Proof or implementation needs work |",
      "| **1/6** | F | 🧂 unranked krab | Not merge-ready |",
      "| N/A | NA | 🌊 off-meta tidepool | Rating does not apply |",
      "",
      "Overall follows the weaker of proof and patch quality.",
      "Shiny media proof means a screenshot, video, or linked artifact directly shows the changed behavior. Runtime, network, CSP, and security claims still need visible diagnostics.",
    ].join("\n");
  }

  function publicMergeReadinessResult(rating: PrRating, policy: RealBehaviorProofPolicy): string {
    const proof = policy.assessment;
    if (policy.proofBlocksMerge) {
      if (proof.status === "mock_only")
        return "blocked until real behavior proof from a real setup is added.";
      if (proof.status === "insufficient")
        return "blocked until stronger real behavior proof is added.";
      return "blocked until real behavior proof is added.";
    }
    if (policy.verificationBlocksMerge)
      return "blocked until a maintainer resolves historical verification.";
    if (rating.overallTier === "NA") return "needs maintainer review before merge.";
    switch (proof.status) {
      case "missing":
      case "mock_only":
      case "insufficient":
      case "sufficient":
      case "override":
        if (rating.patchTier === "F" || rating.patchTier === "D") {
          return "blocked by patch quality or review findings.";
        }
        if (
          rating.overallTier === "S" ||
          rating.overallTier === "A" ||
          rating.overallTier === "B"
        ) {
          return "ready for maintainer review.";
        }
        return "needs maintainer review before merge.";
      case "not_applicable":
        return rating.patchTier === "F" || rating.patchTier === "D"
          ? "blocked by patch quality or review findings."
          : "ready for maintainer review.";
    }
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

  function publicStatusText(value: string): string {
    const text = sentence(value);
    return text ? `${text[0]?.toUpperCase()}${text.slice(1)}` : "";
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
    let proofMeaning =
      publicRealBehaviorProofLine(policy) || "Real behavior proof does not apply to this change.";
    if (policy.proofBlocksMerge && policy.assessment.status === "not_applicable") {
      overallMeaning = `Recorded reviewer rating: ${overallMeaning} Real behavior proof remains required by host policy.`;
      proofMeaning = `Recorded reviewer rating; ${proofMeaning}`;
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

  function publicVerificationBlock(
    policy: RealBehaviorProofPolicy,
    evidence: readonly Evidence[],
    findings: readonly ReviewFinding[],
    securityReview: SecurityReview,
  ): string {
    const proof = policy.assessment;
    const proofResult =
      policy.proofBlocksMerge && proof.status === "not_applicable"
        ? "Required by policy"
        : proof.status === "sufficient"
          ? "Verified"
          : proof.status === "override"
            ? "Overridden"
            : proof.status === "not_applicable"
              ? "Not applicable"
              : "Needs proof";
    const proofEvidence =
      publicRealBehaviorProofLine(policy) || "Real behavior proof does not apply to this change.";
    const evidenceResult =
      evidence.length === 0
        ? "None listed"
        : `${evidence.length} ${evidence.length === 1 ? "item" : "items"}`;
    const evidenceSummary =
      evidence.length === 0
        ? "None."
        : evidence
            .slice(0, 3)
            .map((entry) =>
              publicTableCell(
                `${entry.label.trim() ? `${entry.label.trim()}: ` : ""}${sentence(entry.detail)}`,
              ),
            )
            .join("<br>");
    const findingResult =
      findings.length === 0
        ? "None"
        : `${findings.length} actionable ${findings.length === 1 ? "finding" : "findings"}`;
    const findingEvidence =
      findings.length === 0
        ? "None."
        : findings
            .slice(0, 3)
            .map((finding) =>
              publicTableCell(`[${priorityLabel(finding.priority)}] ${finding.title.trim()}`),
            )
            .join("<br>");
    const securityNeedsAttention =
      securityReview.status === "needs_attention" || securityReview.concerns.length > 0;
    // Each report-provided entry is sanitized individually; the <br> separators are
    // renderer-owned and must stay unescaped.
    const securityEvidence = securityNeedsAttention
      ? securityReview.concerns.length > 0
        ? securityReview.concerns
            .slice(0, 3)
            .map((concern) => publicTableCell(`${concern.title.trim()}: ${sentence(concern.body)}`))
            .join("<br>")
        : publicTableCell(sentence(securityReview.summary))
      : "None.";
    return [
      "| Check | Result | Evidence |",
      "|---|---|---|",
      `| **Real behavior** | ${proofResult} | ${publicTableCell(proofEvidence)} |`,
      ...(policy.verificationBlocksMerge
        ? [
            `| **Historical verification** | Needs maintainer review | ${publicTableCell(publicHistoricalVerificationBlockerLine())} |`,
          ]
        : []),
      `| **Evidence reviewed** | ${evidenceResult} | ${evidenceSummary} |`,
      `| **Findings** | ${findingResult} | ${findingEvidence} |`,
      `| **Security** | ${securityNeedsAttention ? "Needs attention" : "None"} | ${securityEvidence} |`,
    ].join("\n");
  }

  function publicMergeReadinessBlock(
    rating: PrRating,
    policy: RealBehaviorProofPolicy,
    priority: TriagePriority,
    bottomLine: string,
    remainingItemCount: number,
    decisionNeeded: boolean,
    reviewedHeadSha: string,
  ): string {
    const result = publicStatusText(publicMergeReadinessResult(rating, policy)).replace(/\.$/, "");
    const icon = /^blocked\b/i.test(result)
      ? "⛔"
      : /^ready\b/i.test(result) && remainingItemCount === 0 && !decisionNeeded
        ? "✅"
        : "⚠️";
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

  function prStatusLabelKindFromLabels(labels: readonly string[]): PrStatusLabelKind | null {
    for (const label of PR_STATUS_LABELS) {
      if (labels.includes(label.name)) return label.kind;
    }
    return null;
  }

  function activeRepairStatusFromLabels(labels: readonly string[]): PrStatusLabelKind | null {
    for (const kind of ["re_review_loop", "actively_grinding"] as const) {
      const status = PR_STATUS_LABELS.find((candidate) => candidate.kind === kind);
      if (status && labels.includes(status.name)) return kind;
    }
    return null;
  }

  function isProofSpecificStatus(kind: PrStatusLabelKind): boolean {
    return kind === "needs_proof" || kind === "needs_maintainer_proof_decision";
  }

  function prStatusLabelKindFromReportLabels(markdown: string): PrStatusLabelKind | null {
    const parsedLabels = frontMatterStringArray(markdown, "labels");
    if (hasRepairLoopPauseLabel(parsedLabels)) return null;
    const activeRepairStatus = activeRepairStatusFromLabels(parsedLabels);
    if (activeRepairStatus) return activeRepairStatus;
    const policy = reportRealBehaviorProofPolicy(markdown);
    if (policy.needsContributorAction) return "needs_proof";
    if (policy.blocksMerge) return "needs_maintainer_proof_decision";
    if (frontMatterValue(markdown, "review_status") === "failed") return null;
    const fromParsedLabels = prStatusLabelKindFromLabels(
      parsedLabels.filter(
        (label) =>
          !PR_STATUS_LABELS.some(
            (status) => status.name === label && isProofSpecificStatus(status.kind),
          ),
      ),
    );
    if (fromParsedLabels) return fromParsedLabels;
    if (parsedLabels.includes(AUTOMERGE_LABEL)) return "automerge_armed";
    const rawLabels = frontMatterValue(markdown, "labels") ?? "";
    if (
      rawLabels.includes(HUMAN_REVIEW_LABEL) ||
      rawLabels.includes(MANUAL_ONLY_LABEL) ||
      rawLabels.includes(MERGE_READY_LABEL)
    )
      return null;
    if (rawLabels.includes(AUTOMERGE_LABEL)) return "automerge_armed";
    return (
      PR_STATUS_LABELS.find(
        (label) => rawLabels.includes(label.name) && !isProofSpecificStatus(label.kind),
      )?.kind ?? null
    );
  }

  function mantisMaintainerCommentRequestsMutation(comment: string): boolean {
    const commandBody = comment.replace(/^@openclaw-mantis\s+/i, "").trim();
    const mutationVerb = String.raw`(?:add|apply|approve|assign|cancel|change|close|comment|commit|create|delete|disable|edit|enable|file|fix|implement|label|land|lock|make|mark|merge|modify|open|post|publish|push|rebase|remove|reopen|repair|request|resolve|restart|resume|re-?run|retry|re-?trigger|review|rewrite|run|set|submit|triage|trigger|unlock|update|write)`;
    const mutationObject = String.raw`(?:automerge|branch(?:es)?|change(?:s)?|check(?:s)?|CI|code(?!\s+(?:block|snippet|sample|example)\b)|commit(?:s)?|GitHub(?:\s+state)?|issue(?:s)?|item(?:s)?|label(?:s)?|comment(?:s)?|patch(?:es)?|pull\s+request(?:s)?|PRs?|ready\s+for\s+review|repositor(?:y|ies)|repo(?:s)?|review(?:s|\s+request(?:s)?)?|workflow(?:s)?)`;
    const scopedMutation = new RegExp(
      `\\b${mutationVerb}\\b(?:\\s+\\S+){0,12}\\s+\\b${mutationObject}\\b`,
      "i",
    );
    const explicitToolMutation = new RegExp(
      `\\b(?:gh|git|GitHub)\\b(?:\\s+\\S+){0,12}\\s+\\b${mutationVerb}\\b`,
      "i",
    );
    const maintenanceVerb = String.raw`(?:apply|approve|assign|close|comment|commit|create|file|fix|implement|label|land|lock|make|merge|modify|publish|push|rebase|reopen|repair|resolve|review|rewrite|submit|triage|unlock)`;
    const bareMutationImperative = new RegExp(
      `(?:^|[,.!?:;]\\s*|\\b(?:and|then|also)\\s+)(?:(?:please|kindly)\\s+|(?:can|could|would|will)\\s+you\\s+)*${maintenanceVerb}\\b`,
      "i",
    );
    return (
      scopedMutation.test(commandBody) ||
      explicitToolMutation.test(commandBody) ||
      bareMutationImperative.test(commandBody) ||
      new RegExp(`\\b${mutationVerb}\\b\\s+(?:it|this|that|them|these|those)\\b`, "i").test(
        commandBody,
      ) ||
      /\b(?:gh\s+workflow|workflow_dispatch|dispatch|trigger\s+the\s+workflow)\b/i.test(commandBody)
    );
  }

  function mantisMaintainerCommentHasProofIntent(comment: string): boolean {
    const commandBody = comment.replace(/^@openclaw-mantis\s+/i, "").trim();
    return /\b(?:proof|verify|reproduce|capture|inspect|record|test|check|confirm|compare|exercise|demonstrate|show)\b/i.test(
      commandBody,
    );
  }

  function validMantisMaintainerComment(recommendation: MantisRecommendation): string {
    if (recommendation.status !== "recommended" || recommendation.scenario === "none") return "";
    const comment = recommendation.maintainerComment.trim();
    const accountMention = "@openclaw-mantis";
    const ambiguousMantisMention = new RegExp(`@${"mantis"}\\b`, "i");
    if (
      !comment.startsWith(`${accountMention} `) ||
      ambiguousMantisMention.test(comment) ||
      !mantisMaintainerCommentHasProofIntent(comment) ||
      mantisMaintainerCommentRequestsMutation(comment) ||
      comment.length > 500 ||
      comment.includes("\n")
    ) {
      return "";
    }
    const commandBody = comment.slice(accountMention.length).trim();
    if (!commandBody) return "";
    return `${accountMention} ${commandBody}`;
  }

  function isSupportedMantisScenario(scenario: MantisRecommendationScenario): boolean {
    return (
      scenario === "discord_status_reactions" ||
      scenario === "discord_thread_attachment" ||
      scenario === "web_ui_chat_proof"
    );
  }

  function publicMantisRecommendationBlock(recommendation: MantisRecommendation): string {
    if (!hasDispatchableMantisScenario(recommendation)) return "";
    const comment = validMantisMaintainerComment(recommendation);
    if (!comment) return "";
    const reason = sentence(recommendation.reason);
    const intro = reason
      ? `${reason} A maintainer can ask Mantis to capture proof by posting this exact PR comment:`
      : "A maintainer can ask Mantis to capture proof by posting this exact PR comment:";
    return [intro, "", "```text", comment, "```"].join("\n");
  }

  function publicNonDispatchableMantisRecommendationBlock(
    recommendation: MantisRecommendation,
  ): string {
    if (recommendation.status !== "recommended" || recommendation.scenario === "none") return "";
    const mutationRequest = mantisMaintainerCommentRequestsMutation(
      recommendation.maintainerComment.trim(),
    );
    const missingProofIntent = !mantisMaintainerCommentHasProofIntent(
      recommendation.maintainerComment.trim(),
    );
    if (
      isSupportedMantisScenario(recommendation.scenario) &&
      !mutationRequest &&
      !missingProofIntent
    ) {
      return "";
    }
    const reason = sentence(recommendation.reason);
    if (mutationRequest || missingProofIntent) {
      const intro = reason
        ? `${reason} Mantis is proof-only, so it must not be asked to change code or mutate GitHub state.`
        : "Mantis is proof-only, so it must not be asked to change code or mutate GitHub state.";
      return [
        intro,
        "Use ClawSweeper's repair, apply, or automerge lanes for code changes, branch updates, labels, comments, PR repair, closes, or merges.",
      ].join("\n");
    }
    const intro = reason
      ? `${reason} Mantis is currently scoped to Discord and web UI chat proof, so it is not the right proof path for this surface.`
      : "Mantis is currently scoped to Discord and web UI chat proof, so it is not the right proof path for this surface.";
    return [
      intro,
      "Use maintainer screenshot/manual proof, browser or Playwright proof, Crabbox where appropriate, or normal local artifact proof instead.",
    ].join("\n");
  }

  return {
    closeEvidenceLine,
    confidenceText,
    isActionablePriorityText,
    isReportNoneList,
    isRoutineCiOrReviewText,
    isSupportedMantisScenario,
    likelyOwnerLine,
    normalizePublicReviewText,
    prStatusLabelKindFromReportLabels,
    priorityLabel,
    publicFailedReviewReadinessBlock,
    publicHistoricalVerificationBlockerLine,
    publicLikelyOwnerRole,
    publicMantisRecommendationBlock,
    publicMergeReadinessBlock,
    publicNonDispatchableMantisRecommendationBlock,
    publicPriorityBulletFromText,
    publicPriorityBulletIfActionable,
    publicPriorityFromText,
    publicRankDetailsBlock,
    publicRealBehaviorProofLine,
    publicReviewScoresBlock,
    publicReviewTextDiffers,
    publicReviewTextIsSame,
    publicRiskBulletsFromText,
    publicSecurityReviewLine,
    publicVerificationBlock,
    reviewFindingDetailedLine,
    reviewFindingLocation,
    reviewFindingSummaryLine,
    securityConcernDetailedLine,
    securityConcernSummaryLine,
    securityReviewLine,
    sentence,
    stripPriorityPrefix,
    validMantisMaintainerComment,
  };
}
