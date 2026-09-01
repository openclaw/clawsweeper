import {
  AGENTS_POLICY_STATUSES,
  AGENTS_POLICY_STATUS_SCHEMA_KEYS,
  ALL_REASONS,
  AUTO_IMPLEMENTATION_CANDIDATES,
  CONFIDENCES,
  DECISIONS,
  DECISION_SCHEMA_KEYS,
  EVIDENCE_SCHEMA_KEYS,
  FEATURE_SHOWCASE_SCHEMA_KEYS,
  FEATURE_SHOWCASE_STATUSES,
  IMPACT_LABEL_VALUES,
  IMPLEMENTATION_COMPLEXITIES,
  ITEM_CATEGORIES,
  LABEL_JUSTIFICATION_SCHEMA_KEYS,
  LIKELY_OWNER_SCHEMA_KEYS,
  LIVE_PROOF_PLAN_SCHEMA_KEYS,
  LIVE_PROOF_PLAN_STATUSES,
  LIVE_PROOF_PAYOFF_KINDS,
  LIVE_PROOF_PAYOFF_SCHEMA_KEYS,
  LIVE_PROOF_STEP_SCHEMA_KEYS,
  LIVE_PROOF_SURFACES,
  LIVE_PROOF_TERMINAL_COMPLETIONS,
  MANTIS_RECOMMENDATION_SCENARIOS,
  MANTIS_RECOMMENDATION_SCHEMA_KEYS,
  MANTIS_RECOMMENDATION_STATUSES,
  MATURITY_LABEL_VALUES,
  MERGE_RISK_LABEL_VALUES,
  MERGE_RISK_OPTION_CATEGORIES,
  MERGE_RISK_OPTION_SCHEMA_KEYS,
  OVERALL_CORRECTNESS_VALUES,
  PR_RATING_SCHEMA_KEYS,
  PR_RATING_TIERS,
  REAL_BEHAVIOR_PROOF_EVIDENCE_KINDS,
  REAL_BEHAVIOR_PROOF_SCHEMA_KEYS,
  REAL_BEHAVIOR_PROOF_STATUSES,
  REGRESSION_ASSESSMENT_CONFIDENCES,
  REGRESSION_ASSESSMENT_SCHEMA_KEYS,
  REGRESSION_PROVENANCE_SCHEMA_KEYS,
  REGRESSION_SUPPORTING_EVIDENCE,
  REPRODUCTION_STATUSES,
  REVIEW_FINDING_SCHEMA_KEYS,
  REVIEW_LABEL_VALUES,
  REVIEW_METRIC_SCHEMA_KEYS,
  ROOT_CAUSE_CLUSTER_MEMBER_SCHEMA_KEYS,
  ROOT_CAUSE_CLUSTER_SCHEMA_KEYS,
  ROOT_CAUSE_RELATIONSHIPS,
  SECURITY_CONCERN_SCHEMA_KEYS,
  SECURITY_CONCERN_SEVERITIES,
  SECURITY_REVIEW_SCHEMA_KEYS,
  SECURITY_REVIEW_STATUSES,
  TELEGRAM_VISIBLE_PROOF_SCHEMA_KEYS,
  TELEGRAM_VISIBLE_PROOF_STATUSES,
  TRIAGE_PRIORITIES,
  VISION_FIT_STATUSES,
  WORK_CANDIDATES,
} from "./clawsweeper-policy.js";
import type {
  AgentsPolicyStatus,
  Decision,
  DecisionNormalizationItem,
  Evidence,
  FeatureShowcase,
  ImpactLabelName,
  LabelJustification,
  LiveProofPlan,
  LiveProofStep,
  LikelyOwner,
  MantisRecommendation,
  MaturityLabelName,
  MergeRiskLabelName,
  MergeRiskOption,
  ParsedGitHubItemRef,
  PrRating,
  RealBehaviorProof,
  ReviewFinding,
  ReviewLabelName,
  ReviewMetric,
  RegressionAssessment,
  RegressionProvenanceCandidate,
  RootCauseClusterAssessment,
  RootCauseClusterMember,
  RootCauseNormalizationItem,
  RootCauseRelationship,
  SecurityConcern,
  SecurityReview,
  TelegramVisibleProof,
} from "./clawsweeper-types.js";
import { derivedPrRating, normalizePrRating } from "./clawsweeper-rating.js";
import { parseMaintainerDecision } from "./decision-packets.js";
import { DEFAULT_TARGET_REPO, normalizeRepo } from "./repository-profiles.js";

export interface DecisionParserDependencies {
  isMaintainerAuthorAssociation: (value: unknown) => boolean;
  neutralizeOwnedSectionSpoofing: (value: string) => string;
  sanitizeArchitectureDiagram: (value: string) => string;
}

export function createDecisionParser({
  isMaintainerAuthorAssociation,
  neutralizeOwnedSectionSpoofing,
  sanitizeArchitectureDiagram,
}: DecisionParserDependencies) {
  function requireRecord(value: unknown, path: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`${path} must be an object`);
    return value as Record<string, unknown>;
  }

  function rejectUnexpectedKeys(
    record: Record<string, unknown>,
    allowedKeys: Set<string>,
    path: string,
  ): void {
    const unexpected = Object.keys(record).filter((key) => !allowedKeys.has(key));
    if (unexpected.length) throw new Error(`${path} has unexpected keys: ${unexpected.join(", ")}`);
  }

  function requireString(value: unknown, path: string): string {
    if (typeof value !== "string") throw new Error(`${path} must be a string`);
    return value;
  }

  function requireNullableString(value: unknown, path: string): string | null {
    if (value === null || typeof value === "string") return value;
    throw new Error(`${path} must be a string or null`);
  }

  function requireSingleLineString(value: unknown, path: string): string {
    const text = requireString(value, path);
    if (/[\r\n\u2028\u2029]/.test(text)) throw new Error(`${path} must be a single-line string`);
    return text;
  }

  function requireNullableSingleLineString(value: unknown, path: string): string | null {
    if (value === null) return null;
    return requireSingleLineString(value, path);
  }

  function requireNullableInteger(value: unknown, path: string): number | null {
    if (value === null) return value;
    if (typeof value === "number" && Number.isInteger(value)) return value;
    throw new Error(`${path} must be an integer or null`);
  }

  function requireInteger(value: unknown, path: string): number {
    if (typeof value === "number" && Number.isInteger(value)) return value;
    throw new Error(`${path} must be an integer`);
  }

  function requireNumber(value: unknown, path: string): number {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    throw new Error(`${path} must be a finite number`);
  }

  function requireBoolean(value: unknown, path: string): boolean {
    if (typeof value === "boolean") return value;
    throw new Error(`${path} must be a boolean`);
  }

  function requireConfidenceScore(value: unknown, path: string): number {
    const score = requireNumber(value, path);
    if (score < 0 || score > 1) throw new Error(`${path} must be between 0 and 1`);
    return score;
  }

  function requirePriority(value: unknown, path: string): ReviewFinding["priority"] {
    const priority = requireInteger(value, path);
    if (priority === 0 || priority === 1 || priority === 2 || priority === 3) return priority;
    throw new Error(`${path} must be 0, 1, 2, or 3`);
  }

  function requireStringArray(value: unknown, path: string): string[] {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
    return value.map((entry, index) => requireString(entry, `${path}[${index}]`));
  }

  function requireReportText(value: unknown, path: string): string {
    return neutralizeOwnedSectionSpoofing(requireString(value, path));
  }

  function requireReportTextArray(value: unknown, path: string): string[] {
    return requireStringArray(value, path).map(neutralizeOwnedSectionSpoofing);
  }

  function requireSingleLineStringArray(value: unknown, path: string): string[] {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
    return value.map((entry, index) => requireSingleLineString(entry, `${path}[${index}]`));
  }

  function requireEnumArray<T extends string>(value: unknown, allowed: Set<T>, path: string): T[] {
    return requireStringArray(value, path).map((entry, index) =>
      requireEnum(entry, allowed, `${path}[${index}]`),
    );
  }

  function requireImpactLabels(value: unknown): ImpactLabelName[] {
    const labels = requireEnumArray(value, IMPACT_LABEL_VALUES, "decision.impactLabels");
    if (labels.length > 3) throw new Error("decision.impactLabels must contain at most 3 labels");
    if (new Set(labels).size !== labels.length) {
      throw new Error("decision.impactLabels must not contain duplicates");
    }
    return labels;
  }

  function requireMergeRiskLabels(value: unknown): MergeRiskLabelName[] {
    const labels = requireEnumArray(value, MERGE_RISK_LABEL_VALUES, "decision.mergeRiskLabels");
    if (labels.length > 3)
      throw new Error("decision.mergeRiskLabels must contain at most 3 labels");
    if (new Set(labels).size !== labels.length) {
      throw new Error("decision.mergeRiskLabels must not contain duplicates");
    }
    return labels;
  }

  function requireMaturityLabels(value: unknown): MaturityLabelName[] {
    const labels = requireEnumArray(value, MATURITY_LABEL_VALUES, "decision.maturityLabels");
    if (labels.length > 1) throw new Error("decision.maturityLabels must contain at most 1 label");
    return labels;
  }

  function parseMergeRiskOption(value: unknown, path: string): MergeRiskOption {
    const record = requireRecord(value, path);
    rejectUnexpectedKeys(record, MERGE_RISK_OPTION_SCHEMA_KEYS, path);
    return {
      title: requireReportText(record.title, `${path}.title`).trim(),
      body: requireReportText(record.body, `${path}.body`).trim(),
      category: requireEnum(record.category, MERGE_RISK_OPTION_CATEGORIES, `${path}.category`),
      recommended: requireBoolean(record.recommended, `${path}.recommended`),
      automergeInstruction: requireReportText(
        record.automergeInstruction,
        `${path}.automergeInstruction`,
      ).trim(),
    };
  }

  function requireMergeRiskOptions(value: unknown): MergeRiskOption[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error("decision.mergeRiskOptions must be an array");
    const options = value.map((entry, index) =>
      parseMergeRiskOption(entry, `decision.mergeRiskOptions[${index}]`),
    );
    if (options.length > 3)
      throw new Error("decision.mergeRiskOptions must contain at most 3 options");
    const recommended = options.filter((option) => option.recommended);
    if (recommended.length > 1) {
      throw new Error(
        "decision.mergeRiskOptions must not contain more than one recommended option",
      );
    }
    for (const [index, option] of options.entries()) {
      if (!option.title)
        throw new Error(`decision.mergeRiskOptions[${index}].title must not be empty`);
      if (!option.body)
        throw new Error(`decision.mergeRiskOptions[${index}].body must not be empty`);
      if (option.automergeInstruction && option.category !== "fix_before_merge") {
        throw new Error(
          `decision.mergeRiskOptions[${index}].automergeInstruction requires fix_before_merge category`,
        );
      }
      if (option.automergeInstruction && !option.recommended) {
        throw new Error(
          `decision.mergeRiskOptions[${index}].automergeInstruction requires a recommended option`,
        );
      }
    }
    return options;
  }

  function parseReviewMetric(value: unknown, path: string): ReviewMetric {
    const record = requireRecord(value, path);
    rejectUnexpectedKeys(record, REVIEW_METRIC_SCHEMA_KEYS, path);
    const metric = {
      label: requireReportText(record.label, `${path}.label`).trim(),
      value: requireReportText(record.value, `${path}.value`).trim(),
      reason: requireReportText(record.reason, `${path}.reason`).trim(),
    };
    if (!metric.label) throw new Error(`${path}.label must not be empty`);
    if (!metric.value) throw new Error(`${path}.value must not be empty`);
    if (!metric.reason) throw new Error(`${path}.reason must not be empty`);
    return metric;
  }

  function requireReviewMetrics(value: unknown): ReviewMetric[] {
    if (!Array.isArray(value)) throw new Error("decision.reviewMetrics must be an array");
    return value.map((entry, index) =>
      parseReviewMetric(entry, `decision.reviewMetrics[${index}]`),
    );
  }

  function validateMergeRiskOptions(
    decision: Pick<Decision, "mergeRiskLabels" | "mergeRiskOptions">,
  ): void {
    if (decision.mergeRiskLabels.length === 0 && decision.mergeRiskOptions.length > 0) {
      throw new Error("decision.mergeRiskOptions must be empty when mergeRiskLabels is empty");
    }
    if (decision.mergeRiskLabels.length > 0 && decision.mergeRiskOptions.length === 0) {
      throw new Error(
        "decision.mergeRiskOptions must include 1-3 options when mergeRiskLabels is not empty",
      );
    }
  }

  function validateMaintainerDecisionOwner(
    decision: Pick<Decision, "maintainerDecision" | "likelyOwners">,
  ): void {
    if (!decision.maintainerDecision.required) return;
    const selected = decision.maintainerDecision.likelyOwner.person;
    if (!decision.likelyOwners.some((owner) => owner.person === selected)) {
      throw new Error(
        "decision.maintainerDecision.likelyOwner.person must match decision.likelyOwners",
      );
    }
  }

  function parseLabelJustification(value: unknown, path: string): LabelJustification {
    const record = requireRecord(value, path);
    rejectUnexpectedKeys(record, LABEL_JUSTIFICATION_SCHEMA_KEYS, path);
    const label = requireEnum(record.label, REVIEW_LABEL_VALUES, `${path}.label`);
    const reason = requireReportText(record.reason, `${path}.reason`).trim();
    if (!reason) throw new Error(`${path}.reason must not be empty`);
    return { label, reason };
  }

  function requireLabelJustifications(value: unknown): LabelJustification[] {
    if (!Array.isArray(value)) throw new Error("decision.labelJustifications must be an array");
    const justifications = value.map((entry, index) =>
      parseLabelJustification(entry, `decision.labelJustifications[${index}]`),
    );
    const labels = justifications.map((entry) => entry.label);
    if (new Set(labels).size !== labels.length) {
      throw new Error("decision.labelJustifications must not contain duplicate labels");
    }
    return justifications;
  }

  function selectedReviewLabels(
    decision: Pick<
      Decision,
      "triagePriority" | "impactLabels" | "mergeRiskLabels" | "maturityLabels"
    >,
  ): ReviewLabelName[] {
    return [
      ...(decision.triagePriority === "none" ? [] : [decision.triagePriority]),
      ...decision.impactLabels,
      ...decision.mergeRiskLabels,
      ...decision.maturityLabels,
    ];
  }

  function validateLabelJustifications(
    decision: Pick<
      Decision,
      | "triagePriority"
      | "impactLabels"
      | "mergeRiskLabels"
      | "maturityLabels"
      | "labelJustifications"
    >,
  ): void {
    const selected = new Set<string>(selectedReviewLabels(decision));
    const justified = new Set(decision.labelJustifications.map((entry) => entry.label));
    const missing = [...selected].filter((label) => !justified.has(label));
    if (missing.length) {
      throw new Error(
        `decision.labelJustifications missing selected labels: ${missing.join(", ")}`,
      );
    }
    const extra = [...justified].filter((label) => !selected.has(label));
    if (extra.length) {
      throw new Error(
        `decision.labelJustifications contains unselected labels: ${extra.join(", ")}`,
      );
    }
  }

  function isEnvironmentAccessCaveat(value: string): boolean {
    return /(?:GH_TOKEN|GITHUB_TOKEN|authenticated gh|gh (?:was |is )?unavailable|unauthenticated gh|shallow clone|GitHub auth(?:entication)? (?:was |is )?unavailable|could not use authenticated GitHub)/i.test(
      value,
    );
  }

  function parseEvidence(value: unknown, path: string): Evidence {
    const record = requireRecord(value, path);
    rejectUnexpectedKeys(record, EVIDENCE_SCHEMA_KEYS, path);
    const repo = requireNullableSingleLineString(record.repo, `${path}.repo`);
    if (repo !== null && !/^[a-z0-9][a-z0-9_.-]*\/(?!\.{1,2}$)[a-z0-9_.-]+$/i.test(repo)) {
      throw new Error(`${path}.repo must be owner/repo or null`);
    }
    return {
      repo: repo === null ? null : normalizeRepo(repo),
      label: requireReportText(record.label, `${path}.label`),
      detail: requireReportText(record.detail, `${path}.detail`),
      file: requireNullableSingleLineString(record.file, `${path}.file`),
      line: requireNullableInteger(record.line, `${path}.line`),
      command: requireNullableSingleLineString(record.command, `${path}.command`),
      sha: requireNullableSingleLineString(record.sha, `${path}.sha`),
    };
  }

  function parseLikelyOwner(value: unknown, path: string): LikelyOwner {
    const record = requireRecord(value, path);
    rejectUnexpectedKeys(record, LIKELY_OWNER_SCHEMA_KEYS, path);
    let history: LikelyOwner["history"];
    if (record.history !== undefined && record.history !== null) {
      const source = requireRecord(record.history, `${path}.history`);
      rejectUnexpectedKeys(
        source,
        new Set(["commitSha", "sourcePath", "sourceLine", "actor"]),
        `${path}.history`,
      );
      history = {
        commitSha: requireSingleLineString(source.commitSha, `${path}.history.commitSha`),
        sourcePath: requireSingleLineString(source.sourcePath, `${path}.history.sourcePath`),
        sourceLine: requireInteger(source.sourceLine, `${path}.history.sourceLine`),
        actor: requireEnum(
          source.actor,
          new Set(["author", "committer"] as const),
          `${path}.history.actor`,
        ),
      };
    }
    return {
      ...(record.history === undefined ? {} : { history: history ?? null }),
      person: requireReportText(record.person, `${path}.person`),
      role: requireReportText(record.role, `${path}.role`),
      reason: requireReportText(record.reason, `${path}.reason`),
      commits: requireSingleLineStringArray(record.commits, `${path}.commits`),
      files: requireSingleLineStringArray(record.files, `${path}.files`),
      confidence: requireEnum(record.confidence, CONFIDENCES, `${path}.confidence`),
    };
  }

  function parseReviewFinding(value: unknown, path: string): ReviewFinding {
    const record = requireRecord(value, path);
    rejectUnexpectedKeys(record, REVIEW_FINDING_SCHEMA_KEYS, path);
    const lineStart = requireInteger(record.lineStart, `${path}.lineStart`);
    const lineEnd = requireInteger(record.lineEnd, `${path}.lineEnd`);
    if (lineStart <= 0) throw new Error(`${path}.lineStart must be positive`);
    if (lineEnd < lineStart) throw new Error(`${path}.lineEnd must be >= lineStart`);
    const finding: ReviewFinding = {
      title: requireReportText(record.title, `${path}.title`),
      body: requireReportText(record.body, `${path}.body`),
      priority: requirePriority(record.priority, `${path}.priority`),
      confidenceScore: requireConfidenceScore(record.confidenceScore, `${path}.confidenceScore`),
      file: requireSingleLineString(record.file, `${path}.file`),
      lineStart,
      lineEnd,
    };
    if (record.lateFinding !== undefined) {
      finding.lateFinding = requireBoolean(record.lateFinding, `${path}.lateFinding`);
    }
    return finding;
  }

  function defaultRootCauseCluster(): RootCauseClusterAssessment {
    return {
      confidence: "low",
      canonicalRef: null,
      currentItemRelationship: "independent",
      summary: "No evidence-backed root-cause cluster was established.",
      members: [],
    };
  }

  const CHANGELOG_ENTRY_REVIEW_PATTERN =
    /\b(?:changelog\.md|changelog\s+entry|release[- ]?note)\b/i;
  const MISSING_CHANGELOG_ACTION_PATTERN =
    /\b(?:add|include|missing|no|lacks?|needs?|requires?|required|without)\b/i;
  const CHANGELOG_TOOLING_PATTERN =
    /\b(?:coverage|duplicate|generator|malformed|parser|validation|validator|wrong\s+section)\b/i;

  function isOpenClawContributorPullRequest(item: DecisionNormalizationItem | undefined): boolean {
    return (
      item !== undefined &&
      normalizeRepo(item.repo) === DEFAULT_TARGET_REPO &&
      item.kind === "pull_request" &&
      !isMaintainerAuthorAssociation(item.authorAssociation)
    );
  }

  function isContributorChangelogEntryFinding(
    item: DecisionNormalizationItem | undefined,
    finding: ReviewFinding,
  ): boolean {
    const text = `${finding.title}\n${finding.body}`;
    return (
      isOpenClawContributorPullRequest(item) &&
      CHANGELOG_ENTRY_REVIEW_PATTERN.test(text) &&
      MISSING_CHANGELOG_ACTION_PATTERN.test(text) &&
      !CHANGELOG_TOOLING_PATTERN.test(text)
    );
  }

  const CLEAN_OPENCLAW_PR_REVIEW_NEXT_STEP =
    "Continue normal maintainer review; ClawSweeper found no patch-correctness issue.";

  function normalizeDecisionForItem(
    decision: Decision,
    item: DecisionNormalizationItem | undefined,
  ): Decision {
    const reviewFindings = decision.reviewFindings.filter(
      (finding) => !isContributorChangelogEntryFinding(item, finding),
    );
    if (reviewFindings.length === decision.reviewFindings.length) return decision;
    if (reviewFindings.length > 0) return { ...decision, reviewFindings };
    const overallCorrectness =
      decision.overallCorrectness === "patch is incorrect"
        ? "patch is correct"
        : decision.overallCorrectness;

    return {
      ...decision,
      reviewFindings,
      bestSolution: CLEAN_OPENCLAW_PR_REVIEW_NEXT_STEP,
      triagePriority: decision.triagePriority,
      mergeRiskOptions: decision.mergeRiskOptions,
      labelJustifications: decision.labelJustifications,
      overallCorrectness,
      prRating: derivedPrRating({
        isPullRequest: item?.kind === "pull_request",
        proof: decision.realBehaviorProof,
        findings: reviewFindings,
        securityReview: decision.securityReview,
        overallCorrectness,
        overallConfidenceScore: decision.overallConfidenceScore,
      }),
      workCandidate: "none",
      workConfidence: "low",
      workPriority: "low",
      workReason: "",
      workPrompt: "",
      workClusterRefs: [],
      workValidation: [],
      workLikelyFiles: [],
    };
  }

  function parseSecurityConcern(value: unknown, path: string): SecurityConcern {
    const record = requireRecord(value, path);
    rejectUnexpectedKeys(record, SECURITY_CONCERN_SCHEMA_KEYS, path);
    const line = requireNullableInteger(record.line, `${path}.line`);
    if (line !== null && line <= 0) throw new Error(`${path}.line must be positive`);
    return {
      title: requireReportText(record.title, `${path}.title`),
      body: requireReportText(record.body, `${path}.body`),
      severity: requireEnum(record.severity, SECURITY_CONCERN_SEVERITIES, `${path}.severity`),
      confidenceScore: requireConfidenceScore(record.confidenceScore, `${path}.confidenceScore`),
      file: requireNullableSingleLineString(record.file, `${path}.file`),
      line,
    };
  }

  function parseSecurityReview(value: unknown, path: string): SecurityReview {
    const record = requireRecord(value, path);
    rejectUnexpectedKeys(record, SECURITY_REVIEW_SCHEMA_KEYS, path);
    const concerns = Array.isArray(record.concerns)
      ? record.concerns.map((entry, index) =>
          parseSecurityConcern(entry, `${path}.concerns[${index}]`),
        )
      : (() => {
          throw new Error(`${path}.concerns must be an array`);
        })();
    return {
      status: requireEnum(record.status, SECURITY_REVIEW_STATUSES, `${path}.status`),
      summary: requireReportText(record.summary, `${path}.summary`),
      concerns,
    };
  }

  function parseRealBehaviorProof(value: unknown, path: string): RealBehaviorProof {
    const record = requireRecord(value, path);
    rejectUnexpectedKeys(record, REAL_BEHAVIOR_PROOF_SCHEMA_KEYS, path);
    return {
      status: requireEnum(record.status, REAL_BEHAVIOR_PROOF_STATUSES, `${path}.status`),
      summary: requireReportText(record.summary, `${path}.summary`),
      evidenceKind: requireEnum(
        record.evidenceKind,
        REAL_BEHAVIOR_PROOF_EVIDENCE_KINDS,
        `${path}.evidenceKind`,
      ),
      needsContributorAction: requireBoolean(
        record.needsContributorAction,
        `${path}.needsContributorAction`,
      ),
    };
  }

  function parsePrRating(value: unknown, path: string): PrRating {
    const record = requireRecord(value, path);
    rejectUnexpectedKeys(record, PR_RATING_SCHEMA_KEYS, path);
    return normalizePrRating({
      proofTier: requireEnum(record.proofTier, PR_RATING_TIERS, `${path}.proofTier`),
      patchTier: requireEnum(record.patchTier, PR_RATING_TIERS, `${path}.patchTier`),
      overallTier: requireEnum(record.overallTier, PR_RATING_TIERS, `${path}.overallTier`),
      summary: requireReportText(record.summary, `${path}.summary`),
      nextSteps: requireReportTextArray(record.nextSteps, `${path}.nextSteps`).slice(0, 3),
    });
  }

  function parseTelegramVisibleProof(value: unknown, path: string): TelegramVisibleProof {
    const record = requireRecord(value, path);
    rejectUnexpectedKeys(record, TELEGRAM_VISIBLE_PROOF_SCHEMA_KEYS, path);
    return {
      status: requireEnum(record.status, TELEGRAM_VISIBLE_PROOF_STATUSES, `${path}.status`),
      summary: requireReportText(record.summary, `${path}.summary`),
    };
  }

  function parseLiveProofStep(value: unknown, path: string): LiveProofStep {
    const record = requireRecord(value, path);
    const action = requireSingleLineString(record.action, `${path}.action`);
    if (!Object.hasOwn(LIVE_PROOF_STEP_SCHEMA_KEYS, action)) {
      throw new Error(`${path}.action has invalid value`);
    }
    rejectUnexpectedKeys(
      record,
      LIVE_PROOF_STEP_SCHEMA_KEYS[action as keyof typeof LIVE_PROOF_STEP_SCHEMA_KEYS],
      path,
    );
    const nonEmptyString = (key: string): string => {
      const result = requireSingleLineString(record[key], `${path}.${key}`).trim();
      if (!result) throw new Error(`${path}.${key} must not be empty`);
      return result;
    };
    switch (action) {
      case "goto": {
        const step = { action, path: nonEmptyString("path") } as const;
        if (!step.path.startsWith("/")) throw new Error(`${path}.path must be a URL path`);
        return step;
      }
      case "click":
        return { action, target: nonEmptyString("target") };
      case "fill":
        return { action, target: nonEmptyString("target"), value: nonEmptyString("value") };
      case "press":
        return { action, key: nonEmptyString("key") };
      case "wait_for":
        return { action, target: nonEmptyString("target") };
      case "wait": {
        const seconds = requireNumber(record.seconds, `${path}.seconds`);
        if (seconds <= 0 || seconds > 90) {
          throw new Error(`${path}.seconds must be greater than 0 and at most 90`);
        }
        return { action, seconds };
      }
      case "expect_text":
        return { action, text: nonEmptyString("text") };
      case "run":
        return { action, command: nonEmptyString("command") };
      case "expect_output":
        return { action, text: nonEmptyString("text") };
      default:
        throw new Error(`${path}.action has invalid value`);
    }
  }

  function parseLiveProofPlan(value: unknown, path: string): LiveProofPlan {
    const record = requireRecord(value, path);
    rejectUnexpectedKeys(record, LIVE_PROOF_PLAN_SCHEMA_KEYS, path);
    const status = requireEnum(record.status, LIVE_PROOF_PLAN_STATUSES, `${path}.status`);
    const surface = requireEnum(record.surface, LIVE_PROOF_SURFACES, `${path}.surface`);
    const terminalCompletion = requireEnum(
      record.terminalCompletion,
      LIVE_PROOF_TERMINAL_COMPLETIONS,
      `${path}.terminalCompletion`,
    );
    const reason = neutralizeOwnedSectionSpoofing(
      requireSingleLineString(record.reason, `${path}.reason`),
    ).trim();
    const payoffRecord = requireRecord(record.payoff, `${path}.payoff`);
    rejectUnexpectedKeys(payoffRecord, LIVE_PROOF_PAYOFF_SCHEMA_KEYS, `${path}.payoff`);
    const payoff = {
      kind: requireEnum(payoffRecord.kind, LIVE_PROOF_PAYOFF_KINDS, `${path}.payoff.kind`),
      justification: neutralizeOwnedSectionSpoofing(
        requireSingleLineString(payoffRecord.justification, `${path}.payoff.justification`),
      ).trim(),
    };
    const entry = requireSingleLineString(record.entry, `${path}.entry`).trim();
    if (!reason) throw new Error(`${path}.reason must not be empty`);
    if (!payoff.justification) throw new Error(`${path}.payoff.justification must not be empty`);
    if (!Array.isArray(record.steps)) throw new Error(`${path}.steps must be an array`);
    if (record.steps.length > 10) throw new Error(`${path}.steps must contain at most 10 items`);
    const steps = record.steps.map((step, index) =>
      parseLiveProofStep(step, `${path}.steps[${index}]`),
    );
    if (status !== "recommended") {
      if (surface !== "none") throw new Error(`${path}.surface must be none unless recommended`);
      if (terminalCompletion !== "not_applicable") {
        throw new Error(`${path}.terminalCompletion must be not_applicable unless recommended`);
      }
      if (entry) throw new Error(`${path}.entry must be empty unless recommended`);
      if (steps.length) throw new Error(`${path}.steps must be empty unless recommended`);
      return { status, surface, terminalCompletion, reason, payoff, entry, steps };
    }
    if (surface === "none") throw new Error(`${path}.surface must identify a recommended surface`);
    if (surface === "terminal" && terminalCompletion === "not_applicable") {
      throw new Error(`${path}.terminalCompletion must identify terminal completion behavior`);
    }
    if (surface !== "terminal" && terminalCompletion !== "not_applicable") {
      throw new Error(`${path}.terminalCompletion is only allowed for terminal proof`);
    }
    if (!entry) throw new Error(`${path}.entry must not be empty when recommended`);
    if (!steps.length) throw new Error(`${path}.steps must not be empty when recommended`);
    if (surface === "browser" && !entry.startsWith("/")) {
      throw new Error(`${path}.entry must be a URL path for browser proof`);
    }
    const allowedActions =
      surface === "browser"
        ? new Set(["goto", "click", "fill", "press", "wait_for", "wait", "expect_text"])
        : new Set(["run", "wait", "expect_output"]);
    if (steps.some((step) => !allowedActions.has(step.action))) {
      throw new Error(`${path}.steps contain an action that does not match ${surface} proof`);
    }
    if (terminalCompletion === "ready_while_running") {
      const finalRunIndex = steps.reduce(
        (lastIndex, step, index) => (step.action === "run" ? index : lastIndex),
        -1,
      );
      if (!steps.slice(finalRunIndex + 1).some((step) => step.action === "expect_output")) {
        throw new Error(
          `${path}.steps must expect output after the final run for ready_while_running terminal proof`,
        );
      }
    }
    return { status, surface, terminalCompletion, reason, payoff, entry, steps };
  }

  function parseMantisRecommendation(value: unknown, path: string): MantisRecommendation {
    const record = requireRecord(value, path);
    rejectUnexpectedKeys(record, MANTIS_RECOMMENDATION_SCHEMA_KEYS, path);
    return {
      status: requireEnum(record.status, MANTIS_RECOMMENDATION_STATUSES, `${path}.status`),
      scenario: requireEnum(record.scenario, MANTIS_RECOMMENDATION_SCENARIOS, `${path}.scenario`),
      reason: requireReportText(record.reason, `${path}.reason`),
      maintainerComment: requireReportText(record.maintainerComment, `${path}.maintainerComment`),
    };
  }

  function parseFeatureShowcase(value: unknown, path: string): FeatureShowcase {
    const record = requireRecord(value, path);
    rejectUnexpectedKeys(record, FEATURE_SHOWCASE_SCHEMA_KEYS, path);
    return {
      status: requireEnum(record.status, FEATURE_SHOWCASE_STATUSES, `${path}.status`),
      reason: requireReportText(record.reason, `${path}.reason`),
    };
  }

  function parseGitHubItemRef(value: string, path: string): ParsedGitHubItemRef {
    const match = value.match(
      /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/(issues|pull)\/([1-9][0-9]*)$/,
    );
    if (!match) throw new Error(`${path} must be a full GitHub issue or pull request URL`);
    const repo = normalizeRepo(`${match[1]}/${match[2]}`);
    const kind = match[3] === "pull" ? "pull_request" : "issue";
    const number = Number(match[4]);
    return {
      repo,
      kind,
      number,
      url: `https://github.com/${repo}/${kind === "pull_request" ? "pull" : "issues"}/${number}`,
    };
  }

  function decisionItemUrl(item: RootCauseNormalizationItem): string {
    const segment = item.kind === "pull_request" ? "pull" : "issues";
    return `https://github.com/${normalizeRepo(item.repo)}/${segment}/${item.number}`;
  }

  function parseRootCauseClusterMember(value: unknown, path: string): RootCauseClusterMember {
    const record = requireRecord(value, path);
    rejectUnexpectedKeys(record, ROOT_CAUSE_CLUSTER_MEMBER_SCHEMA_KEYS, path);
    const reason = requireString(record.reason, `${path}.reason`).trim();
    if (!reason) throw new Error(`${path}.reason must not be empty`);
    if (reason.length > 300) throw new Error(`${path}.reason must be at most 300 characters`);
    const ref = parseGitHubItemRef(requireString(record.ref, `${path}.ref`), `${path}.ref`).url;
    return {
      ref,
      relationship: requireEnum(
        record.relationship,
        ROOT_CAUSE_RELATIONSHIPS,
        `${path}.relationship`,
      ),
      reason: neutralizeOwnedSectionSpoofing(reason),
    };
  }

  function parseRootCauseCluster(
    value: unknown,
    path: string,
    item?: RootCauseNormalizationItem,
  ): RootCauseClusterAssessment {
    const record = requireRecord(value, path);
    rejectUnexpectedKeys(record, ROOT_CAUSE_CLUSTER_SCHEMA_KEYS, path);
    const summary = requireString(record.summary, `${path}.summary`).trim();
    if (!summary) throw new Error(`${path}.summary must not be empty`);
    if (summary.length > 500) throw new Error(`${path}.summary must be at most 500 characters`);
    if (!Array.isArray(record.members)) throw new Error(`${path}.members must be an array`);
    if (record.members.length > 12)
      throw new Error(`${path}.members must contain at most 12 items`);

    const members = record.members.map((entry, index) =>
      parseRootCauseClusterMember(entry, `${path}.members[${index}]`),
    );
    const parsedMembers = members.map((member, index) => ({
      member,
      parsed: parseGitHubItemRef(member.ref, `${path}.members[${index}].ref`),
    }));
    const seenRefs = new Set<string>();
    for (const { member, parsed } of parsedMembers) {
      if (seenRefs.has(member.ref)) throw new Error(`${path}.members contains duplicate refs`);
      seenRefs.add(member.ref);
      if (item && normalizeRepo(parsed.repo) !== normalizeRepo(item.repo)) {
        throw new Error(`${path}.members must stay within ${item.repo}`);
      }
      if (item && member.ref === decisionItemUrl(item)) {
        throw new Error(`${path}.members must not repeat the current item`);
      }
    }

    const rawCanonicalRef = requireNullableString(record.canonicalRef, `${path}.canonicalRef`);
    const parsedCanonical = rawCanonicalRef
      ? parseGitHubItemRef(rawCanonicalRef, `${path}.canonicalRef`)
      : null;
    const canonicalRef = parsedCanonical?.url ?? null;
    if (
      item &&
      parsedCanonical &&
      normalizeRepo(parsedCanonical.repo) !== normalizeRepo(item.repo)
    ) {
      throw new Error(`${path}.canonicalRef must stay within ${item.repo}`);
    }
    const currentItemRelationship = requireEnum(
      record.currentItemRelationship,
      ROOT_CAUSE_RELATIONSHIPS,
      `${path}.currentItemRelationship`,
    );
    const canonicalMembers = members.filter((member) => member.relationship === "canonical");
    if (canonicalMembers.length > 1)
      throw new Error(`${path} must have at most one canonical member`);

    const currentUrl = item ? decisionItemUrl(item) : null;
    if (!canonicalRef) {
      if (currentItemRelationship === "canonical" || canonicalMembers.length > 0) {
        throw new Error(`${path}.canonicalRef is required for canonical relationships`);
      }
    } else if (currentItemRelationship === "canonical") {
      if (currentUrl && canonicalRef !== currentUrl) {
        throw new Error(`${path}.canonicalRef must identify the canonical current item`);
      }
      if (canonicalMembers.length > 0) {
        throw new Error(`${path} cannot mark both the current item and a member canonical`);
      }
    } else if (canonicalMembers.length !== 1 || canonicalMembers[0]?.ref !== canonicalRef) {
      throw new Error(`${path}.canonicalRef must identify exactly one canonical member`);
    }

    const requiresCanonical = new Set<RootCauseRelationship>([
      "duplicate",
      "same_root_cause",
      "superseded",
      "fixed_by_candidate",
    ]);
    if (requiresCanonical.has(currentItemRelationship) && !canonicalRef) {
      throw new Error(`${path}.currentItemRelationship requires a canonical ref`);
    }
    if (
      ["independent", "security_route", "needs_human"].includes(currentItemRelationship) &&
      canonicalRef
    ) {
      throw new Error(`${path}.currentItemRelationship cannot claim a canonical ref`);
    }
    for (const { member, parsed } of parsedMembers) {
      if (requiresCanonical.has(member.relationship) && !canonicalRef) {
        throw new Error(`${path} relationship ${member.relationship} requires a canonical ref`);
      }
      if (
        member.relationship === "fixed_by_candidate" &&
        parsed.kind !== "pull_request" &&
        parsedCanonical?.kind !== "pull_request"
      ) {
        throw new Error(
          `${path} fixed_by_candidate requires the member or canonical ref to be a PR`,
        );
      }
    }
    if (
      currentItemRelationship === "fixed_by_candidate" &&
      item?.kind !== "pull_request" &&
      parsedCanonical?.kind !== "pull_request"
    ) {
      throw new Error(
        `${path}.currentItemRelationship fixed_by_candidate requires the current item or canonical ref to be a PR`,
      );
    }

    return {
      confidence: requireEnum(record.confidence, CONFIDENCES, `${path}.confidence`),
      canonicalRef,
      currentItemRelationship,
      summary: neutralizeOwnedSectionSpoofing(summary),
      members,
    };
  }

  function parseRootCauseClusterOrDefault(
    value: unknown,
    path: string,
    item?: RootCauseNormalizationItem,
  ): RootCauseClusterAssessment {
    try {
      return parseRootCauseCluster(value, path, item);
    } catch {
      return defaultRootCauseCluster();
    }
  }

  function parseAgentsPolicyStatus(value: unknown, path: string): AgentsPolicyStatus {
    const record = requireRecord(value, path);
    rejectUnexpectedKeys(record, AGENTS_POLICY_STATUS_SCHEMA_KEYS, path);
    return {
      found: requireBoolean(record.found, `${path}.found`),
      readFully: requireBoolean(record.readFully, `${path}.readFully`),
      applied: requireBoolean(record.applied, `${path}.applied`),
      status: requireEnum(record.status, AGENTS_POLICY_STATUSES, `${path}.status`),
      summary: requireReportText(record.summary, `${path}.summary`),
    };
  }

  function parseRegressionProvenanceCandidate(
    value: unknown,
    path: string,
  ): RegressionProvenanceCandidate | null {
    if (value === null) return null;
    const record = requireRecord(value, path);
    rejectUnexpectedKeys(record, REGRESSION_PROVENANCE_SCHEMA_KEYS, path);
    return {
      repo: requireSingleLineString(record.repo, `${path}.repo`),
      pullRequestNumber: requireInteger(record.pullRequestNumber, `${path}.pullRequestNumber`),
      pullRequestUrl: requireSingleLineString(record.pullRequestUrl, `${path}.pullRequestUrl`),
      mergeCommitSha: requireSingleLineString(record.mergeCommitSha, `${path}.mergeCommitSha`),
      sourcePath: requireSingleLineString(record.sourcePath, `${path}.sourcePath`),
      sourceLine: requireInteger(record.sourceLine, `${path}.sourceLine`),
    };
  }

  function parseRegressionAssessment(value: unknown, path: string): RegressionAssessment | null {
    if (value === null) return null;
    const record = requireRecord(value, path);
    rejectUnexpectedKeys(record, REGRESSION_ASSESSMENT_SCHEMA_KEYS, path);
    const confidence = requireEnum(
      record.confidence,
      REGRESSION_ASSESSMENT_CONFIDENCES,
      `${path}.confidence`,
    ) as RegressionAssessment["confidence"];
    const supportingEvidence = requireEnumArray(
      record.supportingEvidence,
      REGRESSION_SUPPORTING_EVIDENCE,
      `${path}.supportingEvidence`,
    ) as RegressionAssessment["supportingEvidence"];
    if (
      supportingEvidence.length === 0 ||
      supportingEvidence.length > 3 ||
      new Set(supportingEvidence).size !== supportingEvidence.length ||
      (confidence === "probable" && supportingEvidence.length < 2)
    ) {
      throw new Error(`${path} has insufficient or duplicate supporting evidence`);
    }
    return { confidence, supportingEvidence };
  }

  function requireEnum<T extends string>(value: unknown, allowed: Set<T>, path: string): T {
    if (typeof value === "string" && allowed.has(value as T)) return value as T;
    throw new Error(`${path} has invalid value`);
  }

  function parseDecision(value: unknown, item?: DecisionNormalizationItem): Decision {
    const record = requireRecord(value, "decision");
    rejectUnexpectedKeys(record, DECISION_SCHEMA_KEYS, "decision");
    const evidence = Array.isArray(record.evidence)
      ? record.evidence.map((entry, index) => parseEvidence(entry, `decision.evidence[${index}]`))
      : (() => {
          throw new Error("decision.evidence must be an array");
        })();
    const likelyOwners = Array.isArray(record.likelyOwners)
      ? record.likelyOwners.map((entry, index) =>
          parseLikelyOwner(entry, `decision.likelyOwners[${index}]`),
        )
      : (() => {
          throw new Error("decision.likelyOwners must be an array");
        })();
    if (likelyOwners.length === 0) throw new Error("decision.likelyOwners must not be empty");
    const reviewFindings = Array.isArray(record.reviewFindings)
      ? record.reviewFindings.map((entry, index) =>
          parseReviewFinding(entry, `decision.reviewFindings[${index}]`),
        )
      : (() => {
          throw new Error("decision.reviewFindings must be an array");
        })();
    const maintainerDecision = parseMaintainerDecision(
      record.maintainerDecision,
      "decision.maintainerDecision",
    );
    const decision: Decision = {
      decision: requireEnum(record.decision, DECISIONS, "decision.decision"),
      closeReason: requireEnum(record.closeReason, ALL_REASONS, "decision.closeReason"),
      confidence: requireEnum(record.confidence, CONFIDENCES, "decision.confidence"),
      summary: requireReportText(record.summary, "decision.summary"),
      changeSummary: requireReportText(record.changeSummary, "decision.changeSummary"),
      systemContext: requireReportText(record.systemContext, "decision.systemContext"),
      architectureDiagram: sanitizeArchitectureDiagram(
        requireString(record.architectureDiagram, "decision.architectureDiagram"),
      ),
      evidence,
      likelyOwners,
      risks: requireReportTextArray(record.risks, "decision.risks").filter(
        (risk) => !isEnvironmentAccessCaveat(risk),
      ),
      bestSolution: requireReportText(record.bestSolution, "decision.bestSolution"),
      maintainerDecision: {
        ...maintainerDecision,
        question: neutralizeOwnedSectionSpoofing(maintainerDecision.question),
        rationale: neutralizeOwnedSectionSpoofing(maintainerDecision.rationale),
        options: maintainerDecision.options.map((option) => ({
          ...option,
          title: neutralizeOwnedSectionSpoofing(option.title),
          body: neutralizeOwnedSectionSpoofing(option.body),
        })),
        likelyOwner: {
          ...maintainerDecision.likelyOwner,
          person: neutralizeOwnedSectionSpoofing(maintainerDecision.likelyOwner.person),
          reason: neutralizeOwnedSectionSpoofing(maintainerDecision.likelyOwner.reason),
        },
      },
      triagePriority: requireEnum(
        record.triagePriority,
        TRIAGE_PRIORITIES,
        "decision.triagePriority",
      ),
      impactLabels: requireImpactLabels(record.impactLabels),
      mergeRiskLabels: requireMergeRiskLabels(record.mergeRiskLabels),
      maturityLabels: requireMaturityLabels(record.maturityLabels),
      mergeRiskOptions: requireMergeRiskOptions(record.mergeRiskOptions),
      reviewMetrics: requireReviewMetrics(record.reviewMetrics),
      labelJustifications: requireLabelJustifications(record.labelJustifications),
      itemCategory: requireEnum(record.itemCategory, ITEM_CATEGORIES, "decision.itemCategory"),
      reproductionStatus: requireEnum(
        record.reproductionStatus,
        REPRODUCTION_STATUSES,
        "decision.reproductionStatus",
      ),
      reproductionConfidence: requireEnum(
        record.reproductionConfidence,
        CONFIDENCES,
        "decision.reproductionConfidence",
      ),
      requiresNewFeature: requireBoolean(record.requiresNewFeature, "decision.requiresNewFeature"),
      requiresNewConfigOption: requireBoolean(
        record.requiresNewConfigOption,
        "decision.requiresNewConfigOption",
      ),
      requiresProductDecision: requireBoolean(
        record.requiresProductDecision,
        "decision.requiresProductDecision",
      ),
      reproductionAssessment: requireReportText(
        record.reproductionAssessment,
        "decision.reproductionAssessment",
      ),
      solutionAssessment: requireReportText(
        record.solutionAssessment,
        "decision.solutionAssessment",
      ),
      visionFit: requireEnum(record.visionFit, VISION_FIT_STATUSES, "decision.visionFit"),
      visionFitReason: requireReportText(record.visionFitReason, "decision.visionFitReason"),
      visionFitEvidence: requireReportTextArray(
        record.visionFitEvidence,
        "decision.visionFitEvidence",
      ),
      implementationComplexity: requireEnum(
        record.implementationComplexity,
        IMPLEMENTATION_COMPLEXITIES,
        "decision.implementationComplexity",
      ),
      autoImplementationCandidate: requireEnum(
        record.autoImplementationCandidate,
        AUTO_IMPLEMENTATION_CANDIDATES,
        "decision.autoImplementationCandidate",
      ),
      rootCauseCluster: parseRootCauseClusterOrDefault(
        record.rootCauseCluster,
        "decision.rootCauseCluster",
        item,
      ),
      agentsPolicyStatus: parseAgentsPolicyStatus(
        record.agentsPolicyStatus,
        "decision.agentsPolicyStatus",
      ),
      reviewFindings,
      securityReview: parseSecurityReview(record.securityReview, "decision.securityReview"),
      realBehaviorProof: parseRealBehaviorProof(
        record.realBehaviorProof,
        "decision.realBehaviorProof",
      ),
      prRating: parsePrRating(record.prRating, "decision.prRating"),
      telegramVisibleProof: parseTelegramVisibleProof(
        record.telegramVisibleProof,
        "decision.telegramVisibleProof",
      ),
      liveProofPlan: parseLiveProofPlan(record.liveProofPlan, "decision.liveProofPlan"),
      mantisRecommendation: parseMantisRecommendation(
        record.mantisRecommendation,
        "decision.mantisRecommendation",
      ),
      featureShowcase: parseFeatureShowcase(record.featureShowcase, "decision.featureShowcase"),
      overallCorrectness: requireEnum(
        record.overallCorrectness,
        OVERALL_CORRECTNESS_VALUES,
        "decision.overallCorrectness",
      ),
      overallConfidenceScore: requireConfidenceScore(
        record.overallConfidenceScore,
        "decision.overallConfidenceScore",
      ),
      fixedRelease: requireNullableSingleLineString(record.fixedRelease, "decision.fixedRelease"),
      fixedSha: requireNullableSingleLineString(record.fixedSha, "decision.fixedSha"),
      fixedAt: requireNullableSingleLineString(record.fixedAt, "decision.fixedAt"),
      regressionAssessment: parseRegressionAssessment(
        record.regressionAssessment,
        "decision.regressionAssessment",
      ),
      regressionProvenance: parseRegressionProvenanceCandidate(
        record.regressionProvenance,
        "decision.regressionProvenance",
      ),
      closeComment: requireReportText(record.closeComment, "decision.closeComment"),
      workCandidate: requireEnum(record.workCandidate, WORK_CANDIDATES, "decision.workCandidate"),
      workConfidence: requireEnum(record.workConfidence, CONFIDENCES, "decision.workConfidence"),
      workPriority: requireEnum(record.workPriority, CONFIDENCES, "decision.workPriority"),
      workReason: requireReportText(record.workReason, "decision.workReason"),
      workPrompt: requireReportText(record.workPrompt, "decision.workPrompt"),
      workClusterRefs: requireSingleLineStringArray(
        record.workClusterRefs,
        "decision.workClusterRefs",
      ),
      workValidation: requireSingleLineStringArray(
        record.workValidation,
        "decision.workValidation",
      ),
      workLikelyFiles: requireSingleLineStringArray(
        record.workLikelyFiles,
        "decision.workLikelyFiles",
      ),
    };
    validateMergeRiskOptions(decision);
    validateMaintainerDecisionOwner(decision);
    validateLabelJustifications(decision);
    return normalizeDecisionForItem(decision, item);
  }

  return {
    defaultRootCauseCluster,
    parseDecision,
    parseGitHubItemRef,
    parseLabelJustification,
    parseLiveProofPlan,
    parseMergeRiskOption,
    parseRootCauseCluster,
    selectedReviewLabels,
  };
}
