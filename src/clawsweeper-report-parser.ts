import {
  derivedPrRating,
  normalizePrRating,
  normalizeRealBehaviorProof,
} from "./clawsweeper-rating.js";
import { createDecisionParser } from "./clawsweeper-decision-parser.js";
import { publicLikelyOwner } from "./clawsweeper-regression-provenance.js";
import {
  AGENTS_POLICY_STATUSES,
  AUTHORITY_CHAIN_PROOF_MARKER,
  AUTO_IMPLEMENTATION_CANDIDATES,
  FEATURE_SHOWCASE_STATUSES,
  IMPLEMENTATION_COMPLEXITIES,
  IMPACT_LABEL_NAMES,
  LIVE_PROOF_RECORDING_MARKER,
  LIVE_VERIFICATION_MARKER,
  MANTIS_RECOMMENDATION_SCENARIOS,
  MANTIS_RECOMMENDATION_STATUSES,
  MATURITY_LABEL_NAMES,
  MERGE_RISK_LABEL_NAMES,
  OVERALL_CORRECTNESS_VALUES,
  PR_RATING_TIERS,
  PROOF_OVERRIDE_LABEL,
  REAL_BEHAVIOR_PROOF_EVIDENCE_KINDS,
  REAL_BEHAVIOR_PROOF_STATUSES,
  REVIEW_SECTIONS,
  SECURITY_REVIEW_STATUSES,
  TELEGRAM_VISIBLE_PROOF_STATUSES,
  TRIAGE_PRIORITIES,
  VISION_FIT_STATUSES,
} from "./clawsweeper-policy.js";
import {
  parseAttachedLiveVerification,
  renderLiveVerificationCommentBlock,
  type AttachedLiveVerification,
} from "./live-proof/verification.js";
import type {
  AgentsPolicyStatus,
  AgentsPolicyStatusKind,
  AutoImplementationCandidate,
  Confidence,
  Decision,
  Evidence,
  FeatureShowcase,
  FeatureShowcaseStatus,
  ImpactLabelName,
  ImplementationComplexity,
  ItemKind,
  LabelJustification,
  LikelyOwner,
  MantisRecommendation,
  MantisRecommendationScenario,
  MantisRecommendationStatus,
  MaturityLabelName,
  MergeRiskLabelName,
  MergeRiskOption,
  OverallCorrectness,
  PrRating,
  PrRatingTier,
  RealBehaviorProof,
  RealBehaviorProofEvidenceKind,
  RealBehaviorProofStatus,
  ReviewFinding,
  RootCauseClusterAssessment,
  RootCauseNormalizationItem,
  SecurityConcern,
  SecurityConcernSeverity,
  SecurityReview,
  SecurityReviewStatus,
  TelegramVisibleProof,
  TelegramVisibleProofStatus,
  LiveProofPlan,
  TriagePriority,
  VisionFitStatus,
} from "./clawsweeper-types.js";
import type { FrontMatterField } from "./report-front-matter.js";

interface ReportParsingDependencies {
  agentsPolicyStatusLine: (status: AgentsPolicyStatus | undefined) => string;
  defaultRootCauseCluster: () => RootCauseClusterAssessment;
  evidenceEntry: (options: Partial<Evidence> & Pick<Evidence, "label" | "detail">) => Evidence;
  frontMatterJsonArray: (markdown: string, key: string) => unknown[];
  frontMatterField: (markdown: string, key: string) => FrontMatterField;
  frontMatterStringArray: (markdown: string, key: string) => string[];
  frontMatterValue: (markdown: string, key: string) => string | undefined;
  isDocsOnlyPullRequestReport: (markdown: string) => boolean;
  isExternalPullRequestReport: (markdown: string) => boolean;
  markdownRepository: (markdown: string, file?: string) => string;
  parseBoldListHeading: (line: string) => { label: string; detail: string } | null;
  parseLabelJustification: (value: unknown, path: string) => LabelJustification;
  parseMergeRiskOption: (value: unknown, path: string) => MergeRiskOption;
  parseReviewFindingHeading: (line: string) => {
    priority: ReviewFinding["priority"];
    title: string;
    file: string;
    lineStart: number;
    lineEnd: number;
  } | null;
  parseRootCauseCluster: (
    value: unknown,
    path: string,
    item?: RootCauseNormalizationItem,
  ) => RootCauseClusterAssessment;
  parseSecurityConcernHeading: (line: string) => {
    severity: SecurityConcernSeverity;
    title: string;
    file: string | null;
    line: number | null;
  } | null;
  reviewSectionValue: (markdown: string, section: keyof typeof REVIEW_SECTIONS) => string;
  sectionLineValue: (section: string, label: string) => string | undefined;
  sectionList: (section: string, label: string) => string[];
  selectedReviewLabels: (
    labels: Pick<
      Decision,
      "triagePriority" | "impactLabels" | "mergeRiskLabels" | "maturityLabels"
    >,
  ) => string[];
  normalizeEvidence: (entry: Evidence, legacyReportRepo?: string) => Evidence;
}

const LIVE_PROOF_SECTION_HEADING = REVIEW_SECTIONS.liveProof;
const LIVE_PROOF_OWNED_HEADINGS = new Set(
  Object.values(REVIEW_SECTIONS).map((heading) => heading.toLowerCase()),
);
const parseRecordedLiveProofPlan = createDecisionParser({
  isMaintainerAuthorAssociation: () => false,
  neutralizeOwnedSectionSpoofing: neutralizeLiveProofText,
  sanitizeArchitectureDiagram: (value) => value,
}).parseLiveProofPlan;

export function reportLiveProofPlan(markdown: string): LiveProofPlan {
  const section = reportSectionValue(markdown, LIVE_PROOF_SECTION_HEADING);
  const status = reportSectionLineValue(section, "Status");
  const surface = reportSectionLineValue(section, "Surface");
  const terminalCompletion =
    reportSectionLineValue(section, "Terminal completion") ??
    (status !== "recommended" || surface !== "terminal" ? "not_applicable" : undefined);
  try {
    return parseRecordedLiveProofPlan(
      {
        status,
        surface,
        terminalCompletion,
        reason: reportSectionLineValue(section, "Reason"),
        payoff: {
          kind: reportSectionLineValue(section, "Payoff"),
          justification: reportSectionLineValue(section, "Payoff justification"),
        },
        entry: reportSectionLineValue(section, "Entry") ?? "",
        steps: reportLiveProofSteps(section),
      },
      "report.liveProofPlan",
    );
  } catch {
    return {
      status: "not_applicable",
      surface: "none",
      terminalCompletion: "not_applicable",
      invalid: true,
      reason:
        "The live-proof plan is missing or invalid; regenerate the review report before execution.",
      payoff: {
        kind: "static_text",
        justification: "Invalid report plans are non-runnable and fail closed.",
      },
      entry: "",
      steps: [],
    };
  }
}

function reportSectionValue(markdown: string, heading: string): string {
  // Preserve marker whitespace and never separate a final CRLF pair.
  const match = markdown.match(
    new RegExp(`(?:^|\\n)## ${heading}\\n\\n([\\s\\S]*?)(?=\\r?\\n## |$)`),
  );
  return match?.[1] ?? "";
}

function reportSectionLineValue(section: string, label: string): string | undefined {
  const prefix = `${label}:`;
  for (const line of section.trim().split("\n")) {
    if (!line.startsWith(prefix)) continue;
    const value = line.slice(prefix.length).trim();
    return value || undefined;
  }
  return undefined;
}

function reportLiveProofSteps(section: string): unknown[] {
  const lines = section.split(/\r?\n/);
  // Match raw attachment lines exactly, as the verification parser does.
  const attachmentStart = lines.findIndex(
    (line) => line === LIVE_VERIFICATION_MARKER || line === LIVE_PROOF_RECORDING_MARKER,
  );
  const planLines = (attachmentStart < 0 ? lines : lines.slice(0, attachmentStart)).map((line) =>
    line.trim(),
  );
  const start = planLines.indexOf("Steps:");
  if (start < 0 || planLines.lastIndexOf("Steps:") !== start) {
    throw new Error("live-proof report requires exactly one Steps payload");
  }
  const payload = planLines.slice(start + 1).filter(Boolean);
  // legacy-empty-list-v1: already-produced reports used a solitary "- none".
  if (payload.length === 1 && (payload[0] === "[]" || payload[0] === "- none")) return [];
  if (!payload.length) throw new Error("live-proof report is missing its Steps payload");
  return payload.map((line) => {
    if (!line.startsWith("- ")) throw new Error("live-proof report step must be a JSON list item");
    return JSON.parse(line.slice(2)) as unknown;
  });
}

function neutralizeLiveProofText(value: string): string {
  return value
    .replace(/\r\n?|[\u2028\u2029]/g, "\n")
    .split("\n")
    .map((line) => {
      const containerPrefix =
        line.match(/^[ \t]*(?:(?:>|(?:[-*+]|\d+[.)])[ \t])[ \t]*)*/)?.[0] ?? "";
      const content = line.slice(containerPrefix.length).replace(/<(?!br\s*\/?>)/gi, "&lt;");
      const trimmed = content.trim();
      if (/^#{1,6}\s+\S/.test(trimmed)) {
        return `${containerPrefix}${content.replace("#", "\\#")}`;
      }
      if (/^\*\*[^*\n]+\*\*:?\s*$/.test(trimmed)) {
        return `${containerPrefix}${content.replace("**", "\\*\\*")}`;
      }
      if (/^(?:```|~~~)/.test(trimmed)) {
        return `${containerPrefix}${content.replace(/[`~]/, "\\$&")}`;
      }
      if (/^(?:=+|-+)[ \t]*$/.test(trimmed)) {
        return `${containerPrefix}${content.replace(/[=-]/, "\\$&")}`;
      }
      if (
        trimmed.endsWith(":") &&
        LIVE_PROOF_OWNED_HEADINGS.has(trimmed.slice(0, -1).trim().toLowerCase())
      ) {
        return `${containerPrefix}${content.trimEnd().slice(0, -1)}&#58;`;
      }
      return `${containerPrefix}${content}`;
    })
    .join("\n");
}

export function createReportParser({
  agentsPolicyStatusLine,
  defaultRootCauseCluster,
  evidenceEntry,
  frontMatterJsonArray,
  frontMatterField,
  frontMatterStringArray,
  frontMatterValue,
  isDocsOnlyPullRequestReport,
  isExternalPullRequestReport,
  markdownRepository,
  parseBoldListHeading,
  parseLabelJustification,
  parseMergeRiskOption,
  parseReviewFindingHeading,
  parseRootCauseCluster,
  parseSecurityConcernHeading,
  reviewSectionValue,
  sectionLineValue,
  sectionList,
  selectedReviewLabels,
  normalizeEvidence,
}: ReportParsingDependencies) {
  function reportEvidence(markdown: string): Evidence[] {
    const evidence = reviewSectionValue(markdown, "evidence");
    const entries: Evidence[] = [];
    let current: Evidence | null = null;
    let legacy = true;
    const finish = () => {
      if (current)
        entries.push(normalizeEvidence(current, legacy ? markdownRepository(markdown) : undefined));
    };
    for (const line of evidence.split("\n")) {
      const heading = parseBoldListHeading(line);
      if (heading) {
        finish();
        legacy = true;
        current = evidenceEntry({
          repo: null,
          label: heading.label,
          detail: heading.detail,
        });
        continue;
      }
      if (!current) continue;
      const repo = line.match(/^\s+- repo: (.*)$/);
      if (repo) {
        legacy = false;
        current.repo = repo[1] === "null" ? null : repo[1]!;
        continue;
      }
      const file = line.match(/^\s+- file: (.+)$/);
      if (file?.[1]) {
        current.file = file[1];
        continue;
      }
      const sha = line.match(/^\s+- sha: (.+)$/);
      if (sha?.[1]) current.sha = sha[1];
      const command = line.match(/^\s+- command: `([\s\S]+)`$/);
      if (command?.[1]) current.command = command[1];
    }
    finish();
    return entries;
  }

  function reportLikelyOwners(markdown: string): LikelyOwner[] {
    const section = reviewSectionValue(markdown, "likelyOwners");
    const owners: LikelyOwner[] = [];
    let current: LikelyOwner | null = null;
    for (const line of section.split("\n")) {
      const heading = parseBoldListHeading(line);
      if (heading) {
        if (current) owners.push(current);
        current = {
          person: heading.label,
          role: heading.detail,
          reason: "",
          commits: [],
          files: [],
          confidence: "low",
        };
        continue;
      }
      if (!current) continue;
      if (line === "  - attribution source: raw_parent_line_v1") {
        current.attributionSource = "raw_parent_line_v1";
        continue;
      }
      const reason = line.match(/^\s+- reason: (.*)$/);
      if (reason?.[1]) {
        current.reason = reason[1];
        continue;
      }
      const commits = line.match(/^\s+- commits: (.*)$/);
      if (commits?.[1]) {
        current.commits = commits[1]
          .split(",")
          .map((commit) => commit.trim())
          .filter(Boolean);
        continue;
      }
      const files = line.match(/^\s+- files: (.*)$/);
      if (files?.[1]) {
        current.files = files[1]
          .split(",")
          .map((file) => file.trim())
          .filter(Boolean);
        continue;
      }
      const confidence = line.match(/^\s+- confidence: (high|medium|low)$/);
      if (confidence?.[1]) current.confidence = confidence[1] as Confidence;
    }
    if (current) owners.push(current);
    return owners.map(publicLikelyOwner);
  }

  function reportOverallCorrectness(markdown: string): OverallCorrectness {
    const section = reviewSectionValue(markdown, "reviewFindings");
    const value = sectionLineValue(section, "Overall correctness");
    return value && OVERALL_CORRECTNESS_VALUES.has(value as OverallCorrectness)
      ? (value as OverallCorrectness)
      : "not a patch";
  }

  function reportOverallConfidenceScore(markdown: string): number {
    const section = reviewSectionValue(markdown, "reviewFindings");
    const raw = sectionLineValue(section, "Overall confidence");
    const score = raw ? Number(raw) : 0;
    return Number.isFinite(score) && score >= 0 && score <= 1 ? score : 0;
  }

  function triagePriorityFromReport(markdown: string): TriagePriority {
    const value = frontMatterValue(markdown, "triage_priority");
    return TRIAGE_PRIORITIES.has(value as TriagePriority) ? (value as TriagePriority) : "none";
  }

  function impactLabelsFromReport(markdown: string): ImpactLabelName[] {
    return frontMatterStringArray(markdown, "impact_labels").filter(
      (label): label is ImpactLabelName => IMPACT_LABEL_NAMES.has(label),
    );
  }

  function mergeRiskLabelsFromReport(markdown: string): MergeRiskLabelName[] {
    return frontMatterStringArray(markdown, "merge_risk_labels").filter(
      (label): label is MergeRiskLabelName => MERGE_RISK_LABEL_NAMES.has(label),
    );
  }

  function maturityLabelsFromReport(markdown: string): MaturityLabelName[] {
    return frontMatterStringArray(markdown, "maturity_labels").filter(
      (label): label is MaturityLabelName => MATURITY_LABEL_NAMES.has(label),
    );
  }

  function mergeRiskOptionsFromReport(markdown: string): MergeRiskOption[] {
    return frontMatterJsonArray(markdown, "merge_risk_options")
      .map((entry, index) => {
        try {
          return parseMergeRiskOption(entry, `merge_risk_options[${index}]`);
        } catch {
          return null;
        }
      })
      .filter((entry): entry is MergeRiskOption => Boolean(entry));
  }

  function labelJustificationsFromReport(
    markdown: string,
    labels: Pick<
      Decision,
      "triagePriority" | "impactLabels" | "mergeRiskLabels" | "maturityLabels"
    >,
  ): LabelJustification[] {
    const selected = new Set<string>(selectedReviewLabels(labels));
    const fromFrontMatter = frontMatterJsonArray(markdown, "label_justifications")
      .map((entry, index) => {
        try {
          return parseLabelJustification(entry, `label_justifications[${index}]`);
        } catch {
          return null;
        }
      })
      .filter((entry): entry is LabelJustification => Boolean(entry))
      .filter((entry) => selected.has(entry.label));
    const byLabel = new Map(fromFrontMatter.map((entry) => [entry.label, entry]));
    return selectedReviewLabels(labels).map((label) => ({
      label,
      reason:
        byLabel.get(label)?.reason ??
        "Older review report did not store a label-specific justification.",
    }));
  }

  function reportReviewFindings(markdown: string): ReviewFinding[] {
    const section = reviewSectionValue(markdown, "reviewFindings");
    const findings: ReviewFinding[] = [];
    let current: ReviewFinding | null = null;
    for (const line of section.split("\n")) {
      const heading = parseReviewFindingHeading(line);
      if (heading) {
        if (current) findings.push(current);
        current = {
          title: heading.title,
          body: "",
          priority: heading.priority,
          confidenceScore: 0,
          file: heading.file,
          lineStart: heading.lineStart,
          lineEnd: heading.lineEnd,
        };
        continue;
      }
      if (!current) continue;
      const body = line.match(/^\s+- body: (.*)$/);
      if (body?.[1]) {
        current.body = body[1];
        continue;
      }
      const late = line.match(/^\s+- late: (true|false)$/);
      if (late?.[1]) {
        current.lateFinding = late[1] === "true";
        continue;
      }
      const confidence = line.match(/^\s+- confidence: ([0-9.]+)$/);
      if (confidence?.[1]) {
        const score = Number(confidence[1]);
        current.confidenceScore = Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0;
      }
    }
    if (current) findings.push(current);
    return findings;
  }

  function defaultSecurityReview(markdown: string): SecurityReview {
    const type = frontMatterValue(markdown, "type");
    return {
      status: type === "pull_request" ? "not_applicable" : "not_applicable",
      summary:
        type === "pull_request"
          ? "No dedicated security review was recorded in this older report."
          : "No patch security review is needed for this non-PR item.",
      concerns: [],
    };
  }

  function securityReviewSummary(
    status: SecurityReviewStatus,
    summary: string | undefined,
  ): string | undefined {
    const normalized = summary?.trim();
    if (normalized && !/^(?:-\s*)?(?:none|n\/a|not applicable)[.!]?$/i.test(normalized)) {
      return normalized;
    }
    // Explicit attention must survive malformed summary text; otherwise the
    // parser downgrades a merge blocker to the not-applicable default.
    return status === "needs_attention"
      ? "Resolve the security review before merge; the needs-attention result did not include a usable summary."
      : undefined;
  }

  function reportSecurityReview(markdown: string): SecurityReview {
    const section = reviewSectionValue(markdown, "securityReview");
    if (!section.trim()) return defaultSecurityReview(markdown);
    const statusValue = sectionLineValue(section, "Status");
    const status = SECURITY_REVIEW_STATUSES.has(statusValue as SecurityReviewStatus)
      ? (statusValue as SecurityReviewStatus)
      : undefined;
    if (!status) return defaultSecurityReview(markdown);
    const summary = securityReviewSummary(status, sectionLineValue(section, "Summary"));
    if (!summary) return defaultSecurityReview(markdown);
    const concerns: SecurityConcern[] = [];
    let current: SecurityConcern | null = null;
    for (const line of section.split("\n")) {
      const heading = parseSecurityConcernHeading(line);
      if (heading) {
        if (current) concerns.push(current);
        current = {
          title: heading.title,
          body: "",
          severity: heading.severity,
          confidenceScore: 0,
          file: heading.file,
          line: heading.line,
        };
        continue;
      }
      if (!current) continue;
      const body = line.match(/^\s+- body: (.*)$/);
      if (body?.[1]) {
        current.body = body[1];
        continue;
      }
      const confidence = line.match(/^\s+- confidence: ([0-9.]+)$/);
      if (confidence?.[1]) {
        const score = Number(confidence[1]);
        current.confidenceScore = Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0;
      }
    }
    if (current) concerns.push(current);
    return { status, summary, concerns };
  }

  function defaultRealBehaviorProof(markdown: string): RealBehaviorProof {
    const type = frontMatterValue(markdown, "type");
    if (frontMatterStringArray(markdown, "labels").includes(PROOF_OVERRIDE_LABEL)) {
      return {
        status: "override",
        summary: "A maintainer applied proof: override for this PR.",
        evidenceKind: "not_applicable",
        needsContributorAction: false,
      };
    }
    if (isDocsOnlyPullRequestReport(markdown)) {
      return {
        status: "not_applicable",
        summary:
          "Real behavior proof is not required because this PR only changes files under docs/.",
        evidenceKind: "not_applicable",
        needsContributorAction: false,
      };
    }
    return {
      status: "not_applicable",
      summary:
        type === "pull_request"
          ? "No real behavior proof assessment was recorded in this older report."
          : "Real behavior proof is not required for non-PR issue triage.",
      evidenceKind: "not_applicable",
      needsContributorAction: false,
    };
  }

  function reportRealBehaviorProof(markdown: string): RealBehaviorProof {
    // Historical execution receipts do not assess relevance to the changed behavior.
    const defaultProof = defaultRealBehaviorProof(markdown);
    if (defaultProof.status === "override" || isDocsOnlyPullRequestReport(markdown)) {
      return defaultProof;
    }
    const statusField = frontMatterField(markdown, "real_behavior_proof_status");
    const evidenceKindField = frontMatterField(markdown, "real_behavior_proof_evidence_kind");
    const needsContributorActionField = frontMatterField(
      markdown,
      "real_behavior_proof_needs_contributor_action",
    );
    const ratingFields = [
      frontMatterField(markdown, "pr_rating_overall"),
      frontMatterField(markdown, "pr_rating_proof"),
      frontMatterField(markdown, "pr_rating_patch"),
    ];
    const malformedMetadata =
      [statusField, evidenceKindField, needsContributorActionField, ...ratingFields].some(
        (field) => field.status === "ambiguous",
      ) ||
      (statusField.status === "value" &&
        !REAL_BEHAVIOR_PROOF_STATUSES.has(statusField.value as RealBehaviorProofStatus)) ||
      (evidenceKindField.status === "value" &&
        !REAL_BEHAVIOR_PROOF_EVIDENCE_KINDS.has(
          evidenceKindField.value as RealBehaviorProofEvidenceKind,
        )) ||
      (needsContributorActionField.status === "value" &&
        !/^(?:true|false)$/i.test(needsContributorActionField.value)) ||
      ratingFields.some(
        (field) => field.status === "value" && !PR_RATING_TIERS.has(field.value as PrRatingTier),
      );
    if (malformedMetadata) {
      return {
        status: "missing",
        summary: "The report has ambiguous or malformed proof metadata and requires human review.",
        evidenceKind: "none",
        needsContributorAction: true,
      };
    }
    const section = reviewSectionValue(markdown, "realBehaviorProof");
    if (!section.trim()) {
      if (isExternalPullRequestReport(markdown)) {
        return {
          status: "missing",
          summary:
            "No after-fix real behavior proof was recorded for this external PR; screenshots or videos are preferred when they can show the behavior, and terminal screenshots, console output, copied live output, linked artifacts, recordings, and redacted logs count. Redact private information like IP addresses, API keys, phone numbers, non-public endpoints, and other private details before posting evidence.",
          evidenceKind: "none",
          needsContributorAction: true,
        };
      }
      return defaultProof;
    }
    const statusValue =
      statusField.status === "value" ? statusField.value : sectionLineValue(section, "Status");
    const evidenceKindValue =
      evidenceKindField.status === "value"
        ? evidenceKindField.value
        : sectionLineValue(section, "Evidence kind");
    const summary = sectionLineValue(section, "Summary");
    const needsContributorActionValue =
      needsContributorActionField.status === "value"
        ? needsContributorActionField.value
        : sectionLineValue(section, "Needs contributor action");
    const status = REAL_BEHAVIOR_PROOF_STATUSES.has(statusValue as RealBehaviorProofStatus)
      ? (statusValue as RealBehaviorProofStatus)
      : undefined;
    const evidenceKind = REAL_BEHAVIOR_PROOF_EVIDENCE_KINDS.has(
      evidenceKindValue as RealBehaviorProofEvidenceKind,
    )
      ? (evidenceKindValue as RealBehaviorProofEvidenceKind)
      : undefined;
    if (!status || !evidenceKind || !summary) return defaultRealBehaviorProof(markdown);
    const proof = normalizeRealBehaviorProof({
      status,
      summary,
      evidenceKind,
      needsContributorAction: /^true$/i.test(needsContributorActionValue ?? ""),
    });
    const authorityChainProofRequired = summary.startsWith(AUTHORITY_CHAIN_PROOF_MARKER);
    if (
      frontMatterValue(markdown, "type") !== "pull_request" ||
      isExternalPullRequestReport(markdown) ||
      authorityChainProofRequired ||
      (!proof.needsContributorAction &&
        proof.status !== "missing" &&
        proof.status !== "mock_only" &&
        proof.status !== "insufficient")
    ) {
      return proof;
    }
    if (proof.status === "sufficient") {
      return { ...proof, needsContributorAction: false };
    }
    return {
      status: "not_applicable",
      summary: "Real behavior proof is not required for maintainer- or bot-authored pull requests.",
      evidenceKind: "not_applicable",
      needsContributorAction: false,
    };
  }

  function reportTelegramVisibleProof(markdown: string): TelegramVisibleProof {
    const section = reviewSectionValue(markdown, "telegramVisibleProof");
    const statusValue = sectionLineValue(section, "Status");
    const status = TELEGRAM_VISIBLE_PROOF_STATUSES.has(statusValue as TelegramVisibleProofStatus)
      ? (statusValue as TelegramVisibleProofStatus)
      : "not_needed";
    return {
      status,
      summary:
        sectionLineValue(section, "Summary") ??
        "No Telegram visible-proof assessment was recorded in this report.",
    };
  }

  function reportLiveProofRecordingBlock(markdown: string): string {
    const section = reviewSectionValue(markdown, "liveProof");
    const verificationBlock = reportLiveVerificationBlock(markdown);
    const markerIndex = section.lastIndexOf(LIVE_PROOF_RECORDING_MARKER);
    if (markerIndex < 0) return verificationBlock;
    const lines = section
      .slice(markerIndex + LIVE_PROOF_RECORDING_MARKER.length)
      .trim()
      .split("\n")
      .map((line) => line.trimEnd());
    if (lines.length !== 3 || lines[1] !== "") return verificationBlock;
    if (
      !/^\[!\[Live proof recording\]\(https:\/\/[^)\s]+\)\]\(https:\/\/[^)\s]+\)$/.test(
        lines[0] ?? "",
      )
    ) {
      return verificationBlock;
    }
    if (
      !/^\*Recorded live on the PR head \(`(?:[0-9a-f]{7,40})`\), (?:0|[1-9][0-9]*)(?:\.[0-9]+)?s, (?:browser|terminal) surface\.\*$/.test(
        lines[2] ?? "",
      )
    ) {
      return verificationBlock;
    }
    return [verificationBlock, lines.join("\n")].filter(Boolean).join("\n\n");
  }

  function reportAttachedLiveVerification(markdown: string): AttachedLiveVerification {
    return parseAttachedLiveVerification(
      reviewSectionValue(markdown, "liveProof"),
      {
        repository: frontMatterValue(markdown, "repository"),
        number: frontMatterValue(markdown, "number"),
        type: frontMatterValue(markdown, "type"),
        pullHeadSha: frontMatterValue(markdown, "pull_head_sha"),
      },
      reportLiveProofPlan(markdown),
    );
  }

  function reportLiveVerificationBlock(markdown: string): string {
    const attached = reportAttachedLiveVerification(markdown);
    return attached.status === "passed" || attached.status === "failed"
      ? renderLiveVerificationCommentBlock(attached.result)
      : "";
  }

  function reportPrRating(markdown: string): PrRating {
    const section = reviewSectionValue(markdown, "prRating");
    const proof = reportRealBehaviorProof(markdown);
    const attached = reportAttachedLiveVerification(markdown);
    const proofTierField = frontMatterField(markdown, "pr_rating_proof");
    const patchTierField = frontMatterField(markdown, "pr_rating_patch");
    const overallTierField = frontMatterField(markdown, "pr_rating_overall");
    if (
      [proofTierField, patchTierField, overallTierField].some(
        (field) =>
          field.status === "ambiguous" ||
          (field.status === "value" && !PR_RATING_TIERS.has(field.value as PrRatingTier)),
      )
    ) {
      return derivedPrRating({
        isPullRequest: frontMatterValue(markdown, "type") === "pull_request",
        proof,
        findings: reportReviewFindings(markdown),
        securityReview: reportSecurityReview(markdown),
        overallCorrectness: reportOverallCorrectness(markdown),
        overallConfidenceScore: reportOverallConfidenceScore(markdown),
      });
    }
    const proofTierValue =
      proofTierField.status === "value"
        ? proofTierField.value
        : sectionLineValue(section, "Proof tier");
    const patchTierValue =
      patchTierField.status === "value"
        ? patchTierField.value
        : sectionLineValue(section, "Patch tier");
    const overallTierValue =
      overallTierField.status === "value"
        ? overallTierField.value
        : sectionLineValue(section, "Overall tier");
    const summary = sectionLineValue(section, "Summary");
    const nextSteps = sectionList(section, "Next rank-up steps").slice(0, 3);
    if (
      PR_RATING_TIERS.has(proofTierValue as PrRatingTier) &&
      PR_RATING_TIERS.has(patchTierValue as PrRatingTier) &&
      PR_RATING_TIERS.has(overallTierValue as PrRatingTier) &&
      summary &&
      !(
        frontMatterValue(markdown, "type") === "pull_request" &&
        !isExternalPullRequestReport(markdown) &&
        proof.status === "not_applicable" &&
        (proofTierValue === "D" || proofTierValue === "F")
      )
    ) {
      return normalizePrRating(
        {
          proofTier: proofTierValue as PrRatingTier,
          patchTier: patchTierValue as PrRatingTier,
          overallTier: overallTierValue as PrRatingTier,
          summary,
          nextSteps,
        },
        attached.status === "absent" ? undefined : proof,
      );
    }
    return derivedPrRating({
      isPullRequest: frontMatterValue(markdown, "type") === "pull_request",
      proof,
      findings: reportReviewFindings(markdown),
      securityReview: reportSecurityReview(markdown),
      overallCorrectness: reportOverallCorrectness(markdown),
      overallConfidenceScore: reportOverallConfidenceScore(markdown),
    });
  }

  function reportMantisRecommendation(markdown: string): MantisRecommendation {
    const section = reviewSectionValue(markdown, "mantisRecommendation");
    const statusValue = sectionLineValue(section, "Status");
    const scenarioValue = sectionLineValue(section, "Scenario");
    const status = MANTIS_RECOMMENDATION_STATUSES.has(statusValue as MantisRecommendationStatus)
      ? (statusValue as MantisRecommendationStatus)
      : "not_recommended";
    const scenario = MANTIS_RECOMMENDATION_SCENARIOS.has(
      scenarioValue as MantisRecommendationScenario,
    )
      ? (scenarioValue as MantisRecommendationScenario)
      : "none";
    return {
      status,
      scenario,
      reason:
        sectionLineValue(section, "Reason") ??
        "No Mantis recommendation was recorded in this report.",
      maintainerComment: sectionLineValue(section, "Maintainer comment") ?? "",
    };
  }

  function reportFeatureShowcase(markdown: string): FeatureShowcase {
    const section = reviewSectionValue(markdown, "featureShowcase");
    const statusValue =
      sectionLineValue(section, "Status") ?? frontMatterValue(markdown, "feature_showcase_status");
    const status = FEATURE_SHOWCASE_STATUSES.has(statusValue as FeatureShowcaseStatus)
      ? (statusValue as FeatureShowcaseStatus)
      : "none";
    return {
      status,
      reason:
        sectionLineValue(section, "Reason") ??
        (status === "showcase"
          ? "This report predates the structured feature showcase reason."
          : "No feature showcase assessment was recorded in this report."),
    };
  }

  function reportRootCauseCluster(markdown: string): RootCauseClusterAssessment {
    const raw = frontMatterValue(markdown, "root_cause_cluster");
    if (!raw) return defaultRootCauseCluster();
    try {
      return parseRootCauseCluster(JSON.parse(raw), "root_cause_cluster", {
        repo: markdownRepository(markdown),
        number: Number(frontMatterValue(markdown, "number")),
        kind: (frontMatterValue(markdown, "type") as ItemKind | undefined) ?? "issue",
      });
    } catch {
      return defaultRootCauseCluster();
    }
  }

  function rootCauseClusterFromReportForTest(markdown: string): RootCauseClusterAssessment {
    return reportRootCauseCluster(markdown);
  }

  function reportAgentsPolicyStatus(markdown: string): AgentsPolicyStatus | undefined {
    const section = reviewSectionValue(markdown, "agentsPolicyStatus");
    const statusValue =
      sectionLineValue(section, "Status") ?? frontMatterValue(markdown, "agents_policy_status");
    if (!AGENTS_POLICY_STATUSES.has(statusValue as AgentsPolicyStatusKind)) return undefined;
    const status = statusValue as AgentsPolicyStatusKind;
    return {
      found: /^true$/i.test(sectionLineValue(section, "Found") ?? ""),
      readFully: /^true$/i.test(sectionLineValue(section, "Read fully") ?? ""),
      applied: /^true$/i.test(sectionLineValue(section, "Applied") ?? ""),
      status,
      summary:
        sectionLineValue(section, "Summary") ??
        agentsPolicyStatusLine({
          found: false,
          readFully: false,
          applied: false,
          status,
          summary: "",
        }),
    };
  }

  function defaultAgentsPolicyStatus(): AgentsPolicyStatus {
    return {
      found: false,
      readFully: false,
      applied: false,
      status: "unreadable_or_unclear",
      summary: "AGENTS.md policy status was not recorded in this report.",
    };
  }

  function reportVisionFit(markdown: string): {
    visionFit: VisionFitStatus;
    visionFitReason: string;
    visionFitEvidence: string[];
    implementationComplexity: ImplementationComplexity;
    autoImplementationCandidate: AutoImplementationCandidate;
  } {
    const section = reviewSectionValue(markdown, "visionFit");
    const visionValue =
      sectionLineValue(section, "Status") ?? frontMatterValue(markdown, "vision_fit");
    const complexityValue =
      sectionLineValue(section, "Implementation complexity") ??
      frontMatterValue(markdown, "implementation_complexity");
    const candidateValue =
      sectionLineValue(section, "Auto implementation candidate") ??
      frontMatterValue(markdown, "auto_implementation_candidate");
    const visionFit = VISION_FIT_STATUSES.has(visionValue as VisionFitStatus)
      ? (visionValue as VisionFitStatus)
      : "not_applicable";
    const implementationComplexity = IMPLEMENTATION_COMPLEXITIES.has(
      complexityValue as ImplementationComplexity,
    )
      ? (complexityValue as ImplementationComplexity)
      : "not_applicable";
    const autoImplementationCandidate = AUTO_IMPLEMENTATION_CANDIDATES.has(
      candidateValue as AutoImplementationCandidate,
    )
      ? (candidateValue as AutoImplementationCandidate)
      : "none";
    return {
      visionFit,
      visionFitReason:
        sectionLineValue(section, "Reason") ??
        (visionFit === "not_applicable"
          ? "Vision-fit assessment is not applicable to this older report."
          : "No vision-fit reason was recorded in this report."),
      visionFitEvidence:
        sectionList(section, "Vision evidence").length > 0
          ? sectionList(section, "Vision evidence")
          : frontMatterStringArray(markdown, "vision_fit_evidence"),
      implementationComplexity,
      autoImplementationCandidate,
    };
  }

  return {
    reportEvidence,
    reportLikelyOwners,
    reportOverallCorrectness,
    reportOverallConfidenceScore,
    triagePriorityFromReport,
    impactLabelsFromReport,
    mergeRiskLabelsFromReport,
    maturityLabelsFromReport,
    mergeRiskOptionsFromReport,
    labelJustificationsFromReport,
    reportReviewFindings,
    reportSecurityReview,
    reportAttachedLiveVerification,
    reportRealBehaviorProof,
    reportTelegramVisibleProof,
    reportLiveProofPlan,
    reportLiveProofRecordingBlock,
    reportPrRating,
    reportMantisRecommendation,
    reportFeatureShowcase,
    reportRootCauseCluster,
    rootCauseClusterFromReportForTest,
    reportAgentsPolicyStatus,
    defaultAgentsPolicyStatus,
    reportVisionFit,
  };
}
