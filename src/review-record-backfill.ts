import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { stringArg, type Args } from "./clawsweeper-args.js";
import { reviewMetricsFromReport } from "./clawsweeper-orchestration-foundation.js";
import { parseOversizedPrSourceSnapshot } from "./clawsweeper-oversized-pr-freshness.js";
import { parseOversizedPullRequestEvidence } from "./clawsweeper-oversized-pr-policy.js";
import { nextStepFromReport } from "./clawsweeper-next-step.js";
import { REVIEW_SECTIONS } from "./clawsweeper-policy.js";
import { ambiguityGuardedMaintainerDecision } from "./clawsweeper-promotion-facts.js";
import { reviewSectionValue } from "./clawsweeper-record-metadata.js";
import {
  impactLabelsFromReport,
  labelJustificationsFromReport,
  maturityLabelsFromReport,
  mergeRiskLabelsFromReport,
  mergeRiskOptionsFromReport,
  reportAgentsPolicyStatus,
  reportChangeExample,
  reportEvidence,
  reportFeatureShowcase,
  reportLikelyOwners,
  reportOverallConfidenceScore,
  reportOverallCorrectness,
  reportPrRating,
  reportProductReview,
  reportProvenance,
  reportRealBehaviorProof,
  reportReviewFindings,
  reportRootCauseCluster,
  reportSecurityReview,
  reportTelegramVisibleProof,
  reportTestingReview,
  reportVisionFit,
  triagePriorityFromReport,
} from "./clawsweeper-report-parser.js";
import {
  fixedPullRequestFromReport,
  regressionAssessmentFromReport,
  regressionProvenanceFromReport,
} from "./clawsweeper-status-context.js";
import type {
  Action,
  Decision,
  GitInfo,
  Item,
  ItemContext,
  ReviewRuntime,
} from "./clawsweeper-types.js";
import { UserFacingCommandError } from "./command.js";
import { frontMatterStringArray, frontMatterValue, sectionValue } from "./report-front-matter.js";
import {
  readReviewRecord,
  reviewRecordFrontMatterLine,
  reviewRecordProblem,
} from "./review-record.js";

// One-time migration of reports written before review_record existed. It makes the
// typed decision from the report, renders that decision again, and compares every
// decision field of the report. Delete this module with the report parsers when every
// stored report has a record.

type MarkdownFor = (options: {
  item: Item;
  context: ItemContext;
  decision: Decision;
  git: GitInfo;
  action: Action;
  reviewMode: "propose" | "apply";
  snapshotHash: string;
  contentDigest: string;
  reviewPolicy: string;
  runtime: ReviewRuntime;
}) => string;

interface DecisionDifference {
  field: string;
  stored: string;
  rendered: string;
}

// "filled": the report has no value for each differing field (it predates the field),
// and the record supplies the decision default. "lossy": at least one stored value
// differs from the value the record renders.
export type ReviewRecordBackfill =
  | { status: "typed" }
  | { status: "invalid_record" | "unparseable"; reason: string }
  | {
      status: "lossless" | "filled" | "lossy";
      differences: DecisionDifference[];
      markdown: string;
    };

// The front-matter fields that markdownFor writes from the decision.
const DECISION_FRONT_MATTER_KEYS = [
  "fixed_release",
  "fixed_sha",
  "fixed_at",
  "fixed_pr_url",
  "fixed_pr_number",
  "fixed_pr_title",
  "fixed_pr_merged_at",
  "fixed_pr_sha",
  "fixed_pr_confidence",
  "fixed_pr_source",
  "regression_assessment_confidence",
  "regression_assessment_evidence",
  "regression_provenance_repo",
  "regression_provenance_pr_url",
  "regression_provenance_pr_number",
  "regression_provenance_merge_sha",
  "regression_provenance_source_path",
  "regression_provenance_source_line",
  "regression_provenance_evidence_type",
  "regression_provenance_verification_source",
  "regression_provenance_merged_at",
  "regression_provenance_reviewed_sha",
  "regression_provenance_source_commit_sha",
  "regression_provenance_source_author",
  "regression_provenance_related_pr_url",
  "regression_provenance_related_pr_number",
  "regression_provenance_related_repo",
  "review_status",
  "review_terminal_failure",
  "review_checkout_inspection_failed",
  "local_checkout_access",
  "local_checkout_access_source",
  "decision",
  "close_reason",
  "oversized_pr_source",
  "oversized_pull_request",
  "confidence",
  "next_step",
  "work_candidate",
  "work_confidence",
  "work_priority",
  "work_status",
  "work_reason_sha256",
  "work_prompt_sha256",
  "work_cluster_refs",
  "root_cause_cluster",
  "work_validation",
  "work_likely_files",
  "maintainer_decision",
  "triage_priority",
  "impact_labels",
  "merge_risk_labels",
  "maturity_labels",
  "merge_risk_options",
  "review_metrics",
  "label_justifications",
  "item_category",
  "reproduction_status",
  "reproduction_confidence",
  "requires_new_feature",
  "requires_new_config_option",
  "requires_product_decision",
  "vision_fit",
  "vision_fit_evidence",
  "implementation_complexity",
  "auto_implementation_candidate",
  "real_behavior_proof_status",
  "real_behavior_proof_evidence_kind",
  "real_behavior_proof_needs_contributor_action",
  "real_behavior_proof_data_model_compatibility",
  "pr_rating_overall",
  "pr_rating_proof",
  "pr_rating_patch",
  "telegram_visible_proof_status",
  "feature_showcase_status",
  "agents_policy_status",
  "product_kind",
  "product_worth",
  "product_fix_scope",
  "testing_proof_path",
  "low_value_tests",
  "provenance_overrides_without_reason",
] as const;

// The body sections that markdownFor writes from the decision. "Close Comment" holds
// the comment that apply posts, so it is not compared.
const DECISION_SECTIONS = [
  "Decision",
  "Label Justifications",
  ...Object.entries(REVIEW_SECTIONS)
    .filter(([key]) => key !== "closeComment" && key !== "liveProof")
    .map(([, heading]) => heading),
];

const NOT_PROVIDED = "_Not provided._";

// markdownList renders an empty list as "- none"; some section readers return ["none"].
function withoutNoneEntry(values: string[]): string[] {
  return values.length === 1 && values[0] === "none" ? [] : values;
}

// The file link of an evidence entry has the commit in its URL: the entry sha or, for
// the reviewed repository, the reviewed main commit. The reader takes it from the URL,
// so keep it only where the report prints a "- sha:" line for that entry.
function evidenceFromReport(markdown: string) {
  const blocks = reviewSectionValue(markdown, "evidence").split(/\n(?=- \*\*)/);
  return reportEvidence(markdown).map((entry, index) =>
    entry.sha && !blocks[index]?.includes("\n  - sha: ") ? { ...entry, sha: null } : entry,
  );
}

function textSection(markdown: string, name: keyof typeof REVIEW_SECTIONS): string {
  const value = reviewSectionValue(markdown, name);
  return value === NOT_PROVIDED ? "" : value;
}

function listSection(markdown: string, name: keyof typeof REVIEW_SECTIONS): string[] {
  const value = reviewSectionValue(markdown, name);
  if (!value || value === "- none") return [];
  return value.split("\n").map((line) => line.replace(/^- /, ""));
}

// The Work Candidate section has "Reason: <text>" before the optional lists.
function workReasonFromReport(markdown: string): string {
  const section = reviewSectionValue(markdown, "workCandidate");
  return section.match(/(?:^|\n)Reason: ([\s\S]*?)(?:\n\nCluster refs:\n|$)/)?.[1]?.trim() ?? "";
}

/** Makes the typed decision of a report from its front matter and sections. */
export function legacyReviewDecision(markdown: string): Decision {
  const fm = (key: string) => frontMatterValue(markdown, key);
  const known = (key: string) => {
    const value = fm(key);
    return value && value !== "unknown" ? value : null;
  };
  const required = <T extends string>(key: string) => {
    const value = fm(key);
    if (!value) throw new Error(`front matter has no ${key}`);
    return value as T;
  };
  const decision = required<Decision["decision"]>("decision");
  const closeReason = required<Decision["closeReason"]>("close_reason");
  const confidence = required<Decision["confidence"]>("confidence");
  const labels = {
    triagePriority: triagePriorityFromReport(markdown),
    impactLabels: impactLabelsFromReport(markdown),
    mergeRiskLabels: mergeRiskLabelsFromReport(markdown),
    maturityLabels: maturityLabelsFromReport(markdown),
  };
  const agentsPolicyStatus = reportAgentsPolicyStatus(markdown);
  if (!agentsPolicyStatus) throw new Error("report has no AGENTS.md policy status");
  const oversizedPullRequest = fm("oversized_pull_request");
  const oversizedPullRequestSource = fm("oversized_pr_source");
  // The writer records "unknown" as the source when the runner did not set the field.
  const localCheckoutAccess =
    fm("local_checkout_access_source") === "unknown" ? undefined : fm("local_checkout_access");
  const nextStep = nextStepFromReport(markdown);
  const closeComment = reviewSectionValue(markdown, "closeComment");
  const checkoutInspectionFailed = fm("review_checkout_inspection_failed") === "true";
  const codexTerminalFailure = fm("review_terminal_failure") === "true";
  return {
    ...(oversizedPullRequestSource
      ? { oversizedPullRequestSource: parseOversizedPrSourceSnapshot(oversizedPullRequestSource)! }
      : {}),
    ...(oversizedPullRequest
      ? { oversizedPullRequest: parseOversizedPullRequestEvidence(oversizedPullRequest)! }
      : {}),
    decision,
    closeReason,
    confidence,
    summary: textSection(markdown, "summary"),
    changeSummary: textSection(markdown, "changeSummary"),
    changeExample: reportChangeExample(markdown),
    systemContext: textSection(markdown, "systemContext"),
    architectureDiagram: textSection(markdown, "architectureDiagram"),
    evidence: evidenceFromReport(markdown),
    likelyOwners: reportLikelyOwners(markdown),
    risks: listSection(markdown, "risks"),
    bestSolution: textSection(markdown, "bestSolution"),
    maintainerDecision: ambiguityGuardedMaintainerDecision(markdown),
    ...labels,
    mergeRiskOptions: mergeRiskOptionsFromReport(markdown),
    reviewMetrics: reviewMetricsFromReport(markdown),
    labelJustifications: labelJustificationsFromReport(markdown, labels),
    itemCategory: required("item_category"),
    reproductionStatus: required("reproduction_status"),
    reproductionConfidence: required("reproduction_confidence"),
    requiresNewFeature: fm("requires_new_feature") === "true",
    requiresNewConfigOption: fm("requires_new_config_option") === "true",
    requiresProductDecision: fm("requires_product_decision") === "true",
    reproductionAssessment: textSection(markdown, "reproductionAssessment"),
    solutionAssessment: textSection(markdown, "solutionAssessment"),
    ...reportVisionFit(markdown),
    visionFitEvidence: frontMatterStringArray(markdown, "vision_fit_evidence"),
    rootCauseCluster: reportRootCauseCluster(markdown),
    agentsPolicyStatus,
    productReview: reportProductReview(markdown),
    provenance: reportProvenance(markdown),
    testingReview: reportTestingReview(markdown),
    reviewFindings: reportReviewFindings(markdown),
    securityReview: reportSecurityReview(markdown),
    realBehaviorProof: reportRealBehaviorProof(markdown),
    prRating: (({ nextSteps, ...rating }) => ({
      ...rating,
      nextSteps: withoutNoneEntry(nextSteps),
    }))(reportPrRating(markdown)),
    telegramVisibleProof: reportTelegramVisibleProof(markdown),
    featureShowcase: reportFeatureShowcase(markdown),
    overallCorrectness: reportOverallCorrectness(markdown),
    overallConfidenceScore: reportOverallConfidenceScore(markdown),
    ...(localCheckoutAccess === "verified" || localCheckoutAccess === "unverified"
      ? { localCheckoutAccess }
      : {}),
    ...(checkoutInspectionFailed ? { checkoutInspectionFailed: true } : {}),
    ...(codexTerminalFailure ? { codexTerminalFailure: true } : {}),
    fixedRelease: known("fixed_release"),
    fixedSha: known("fixed_sha"),
    fixedAt: known("fixed_at"),
    fixedPullRequest: fixedPullRequestFromReport(markdown),
    regressionAssessment: regressionAssessmentFromReport(markdown),
    regressionProvenance: regressionProvenanceFromReport(markdown),
    closeComment: closeComment === "_No close comment posted._" ? "" : closeComment,
    workCandidate: required("work_candidate"),
    workConfidence: required("work_confidence"),
    workPriority: required("work_priority"),
    workReason: workReasonFromReport(markdown),
    ...(nextStep ? { nextStep } : {}),
    workPrompt: textSection(markdown, "repairWorkPrompt"),
    workClusterRefs: frontMatterStringArray(markdown, "work_cluster_refs"),
    workValidation: frontMatterStringArray(markdown, "work_validation"),
    workLikelyFiles: frontMatterStringArray(markdown, "work_likely_files"),
  };
}

// The item fields that the compared decision fields use. The rest is not compared.
function reportSubject(markdown: string): Item {
  const fm = (key: string) => frontMatterValue(markdown, key) ?? "";
  return {
    repo: fm("repository"),
    number: Number(fm("number")),
    kind: fm("type") === "pull_request" ? "pull_request" : "issue",
    title: "",
    url: fm("url"),
    createdAt: fm("item_created_at"),
    updatedAt: fm("item_updated_at"),
    author: fm("author"),
    authorAssociation: fm("author_association"),
    labels: [],
  };
}

function decisionSection(markdown: string, heading: string): string {
  const value = sectionValue(markdown, heading);
  // The action is host state, not a decision field.
  return heading === "Decision" ? value.replace(/\n\nAction taken: .*$/, "") : value;
}

/** Compares the decision fields of the stored report and the report that the record renders. */
function decisionDifferences(stored: string, rendered: string): DecisionDifference[] {
  const fields = [
    ...DECISION_FRONT_MATTER_KEYS.map((key) => ({
      field: key,
      stored: frontMatterValue(stored, key) ?? "",
      rendered: frontMatterValue(rendered, key) ?? "",
    })),
    ...DECISION_SECTIONS.map((heading) => ({
      field: `## ${heading}`,
      stored: decisionSection(stored, heading),
      rendered: decisionSection(rendered, heading),
    })),
  ];
  return fields.filter(
    (field) => field.stored !== field.rendered && !sameJson(field.stored, field.rendered),
  );
}

// A JSON front-matter value can list its keys in another order.
function sameJson(left: string, right: string): boolean {
  try {
    return isDeepStrictEqual(JSON.parse(left), JSON.parse(right));
  } catch {
    return false;
  }
}

export function createReviewRecordBackfill(dependencies: { markdownFor: MarkdownFor }) {
  function backfillReviewRecord(markdown: string): ReviewRecordBackfill {
    try {
      if (readReviewRecord(markdown)) return { status: "typed" };
    } catch (error) {
      return { status: "invalid_record", reason: String((error as Error).message) };
    }
    const item = reportSubject(markdown);
    let decision: Decision;
    try {
      decision = legacyReviewDecision(markdown);
    } catch (error) {
      return { status: "unparseable", reason: String((error as Error).message) };
    }
    const problem = reviewRecordProblem(decision, item);
    if (problem) return { status: "unparseable", reason: problem };
    const rendered = dependencies.markdownFor({
      item,
      decision,
      context: { issue: {}, comments: [], timeline: [] },
      git: {
        mainSha: frontMatterValue(markdown, "main_sha") ?? "",
        latestRelease: null,
        releaseStateComplete: true,
      },
      action: { actionTaken: frontMatterValue(markdown, "action_taken") ?? "" } as Action,
      reviewMode: "propose",
      snapshotHash: "",
      contentDigest: "",
      reviewPolicy: "",
      runtime: { model: "", reasoningEffort: "" },
    });
    const differences = decisionDifferences(markdown, rendered);
    const line = reviewRecordFrontMatterLine({ decision, origin: "backfill" }, item)!;
    const end = markdown.indexOf("\n---", 3);
    return {
      status: !differences.length
        ? "lossless"
        : differences.every((difference) => !difference.stored)
          ? "filled"
          : "lossy",
      differences,
      markdown: `${markdown.slice(0, end)}\n${line}${markdown.slice(end)}`,
    };
  }

  /**
   * `backfill-review-records --records-dir <records/<slug>> --output <json>`: reports
   * what the backfill would do for every items and closed report. It writes nothing.
   */
  function backfillReviewRecordsCommand(args: Args): void {
    const recordsDir = stringArg(args.records_dir, "");
    const output = stringArg(args.output, "");
    if (!recordsDir || !output) {
      throw new UserFacingCommandError("backfill-review-records needs --records-dir and --output");
    }
    const counts: Record<ReviewRecordBackfill["status"], number> = {
      typed: 0,
      invalid_record: 0,
      unparseable: 0,
      lossless: 0,
      filled: 0,
      lossy: 0,
    };
    const reasons: Record<string, number> = {};
    // Per field: how many reports lack a stored value, and how many store a value
    // that the record would change.
    const filledFields: Record<string, number> = {};
    const changedFields: Record<string, number> = {};
    const differenceSamples: Array<DecisionDifference & { path: string }> = [];
    const examples: Record<string, string[]> = {};
    let total = 0;
    for (const section of ["items", "closed"]) {
      let names: string[];
      try {
        names = readdirSync(join(recordsDir, section)).filter((name) => name.endsWith(".md"));
      } catch {
        continue;
      }
      for (const name of names.sort()) {
        const path = `${section}/${name}`;
        const result = backfillReviewRecord(readFileSync(join(recordsDir, path), "utf8"));
        total += 1;
        counts[result.status] += 1;
        const sample = (examples[result.status] ??= []);
        if (sample.length < 20) sample.push(path);
        if ("reason" in result) reasons[result.reason] = (reasons[result.reason] ?? 0) + 1;
        if ("differences" in result) {
          for (const difference of result.differences) {
            if (!difference.stored) {
              filledFields[difference.field] = (filledFields[difference.field] ?? 0) + 1;
              continue;
            }
            changedFields[difference.field] = (changedFields[difference.field] ?? 0) + 1;
            // Five short samples for each changed field show what the parsers lose.
            // Each sample starts a little before the first character that differs.
            if (
              differenceSamples.filter((sample) => sample.field === difference.field).length < 5
            ) {
              let first = 0;
              while (difference.stored[first] === difference.rendered[first]) first += 1;
              const start = Math.max(0, first - 80);
              differenceSamples.push({
                path,
                field: difference.field,
                stored: difference.stored.slice(start, start + 300),
                rendered: difference.rendered.slice(start, start + 300),
              });
            }
          }
        }
      }
    }
    const byCount = (record: Record<string, number>) =>
      Object.fromEntries(Object.entries(record).sort(([, left], [, right]) => right - left));
    const summary = {
      recordsDir,
      total,
      counts,
      changedFields: byCount(changedFields),
      filledFields: byCount(filledFields),
      reasons: byCount(reasons),
      examples,
      differenceSamples,
    };
    writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify({ recordsDir, total, counts }));
  }

  return { backfillReviewRecord, backfillReviewRecordsCommand };
}
