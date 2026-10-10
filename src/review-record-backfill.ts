import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { argNumber, boolArg, stringArg, type Args } from "./clawsweeper-args.js";
import { reviewMetricsFromReport } from "./clawsweeper-orchestration-foundation.js";
import { parseOversizedPrSourceSnapshot } from "./clawsweeper-oversized-pr-freshness.js";
import { parseOversizedPullRequestEvidence } from "./clawsweeper-oversized-pr-policy.js";
import { nextStepFromReport } from "./clawsweeper-next-step.js";
import { REVIEW_SECTIONS } from "./clawsweeper-policy.js";
import { ambiguityGuardedMaintainerDecision } from "./clawsweeper-promotion-facts.js";
import { reviewSectionValue } from "./clawsweeper-record-metadata.js";
import { neutralizeOwnedSectionSpoofing } from "./clawsweeper-report-helpers.js";
import { likelyOwnersMarkdown } from "./clawsweeper-report-document.js";
import {
  defaultAgentsPolicyStatus,
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
  reportRecordedLikelyOwners,
  reportRecordedRealBehaviorProof,
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
import { numberForMarkdownFile } from "./clawsweeper-repository-paths.js";
import { UserFacingCommandError } from "./command.js";
import { sha256 } from "./content-hash.js";
import { captureCanonicalRecordBaseline } from "./repair/canonical-record-baseline.js";
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

// "filled": the report has no value for the field (it predates the field), and the
// record supplies the decision default. "rendered": the current renderer prints the
// stored value differently, and the record keeps it. "changed": the record changes a
// stored value.
interface DecisionDifference {
  field: string;
  stored: string;
  rendered: string;
  kind: "filled" | "rendered" | "changed";
}

// "lossless": every difference is rendered. "filled": no stored value changes, and
// the record fills at least one field. "lossy": at least one stored value changes.
export type ReviewRecordBackfill =
  | { status: "typed" }
  | { status: "invalid_record" | "unparseable"; reason: string }
  | {
      status: "lossless" | "filled" | "lossy";
      differences: DecisionDifference[];
      markdown: string;
    };

// The front-matter fields that markdownFor writes from the decision. review_status is
// host lifecycle state (stale_reopened, for example), not a decision field.
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
  // A list item can be empty: the section then ends with a bare "-".
  return value.split("\n").map((line) => line.replace(/^-(?: |$)/, ""));
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
  // Older reports predate the AGENTS.md policy status; the record fills the default.
  const agentsPolicyStatus = reportAgentsPolicyStatus(markdown) ?? defaultAgentsPolicyStatus();
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
    realBehaviorProof: reportRecordedRealBehaviorProof(markdown),
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

// Sections that print only front-matter fields, which are compared on their own. A
// section that differs while the report stores those fields is older text: a host
// promotion, for example, rewrites decision and work_candidate but not the sections.
const RESTATED_SECTIONS: Record<string, readonly string[]> = {
  "## Decision": ["decision", "close_reason", "confidence"],
  "## Work Candidate": [
    "work_candidate",
    "work_confidence",
    "work_priority",
    "work_status",
    "work_reason_sha256",
    "work_cluster_refs",
    "work_likely_files",
    "work_validation",
  ],
  "## Root-Cause Cluster": ["root_cause_cluster"],
  "## Maintainer Decision": ["maintainer_decision"],
  "## Label Justifications": ["label_justifications"],
};

const ENTRY_START = /\n(?=- \*\*)/;

// Sections that the current renderer prints in another form. Each check is true only
// when the stored section holds no data that the record lacks.
const RENDERED_SECTIONS: Record<
  string,
  (stored: string, rendered: string, report: string) => boolean
> = {
  // Older evidence entries have no repo line. The reader takes the report repository,
  // and the renderer prints it.
  "## Evidence": (stored, rendered) => {
    const storedEntries = stored.split(ENTRY_START);
    const renderedEntries = rendered.split(ENTRY_START);
    return (
      storedEntries.length === renderedEntries.length &&
      renderedEntries.every(
        (entry, index) =>
          (storedEntries[index]!.includes("\n  - repo: ")
            ? entry
            : entry.replace(/\n {2}- repo: [^\n]*/, "")) === storedEntries[index],
      )
    );
  },
  // The report shows each owner through publicLikelyOwner, as a fresh review stores
  // them. The stored owners must read back whole before that policy.
  "## Likely Related People": (stored, _rendered, report) =>
    likelyOwnersMarkdown(reportRecordedLikelyOwners(report)) === stored,
  // The testing review no longer has the added-test-files count of older reports.
  "## Testing Review": (stored, rendered) =>
    stored.replace(/\n\nAdded test files: \d+(?=\n\n)/, "") === rendered,
};

// A stored "Label:" line with no value, which the record fills with the default text.
function filledLines(stored: string, rendered: string): boolean {
  const storedLines = stored.split("\n");
  const renderedLines = rendered.split("\n");
  return (
    storedLines.length === renderedLines.length &&
    storedLines.every((line, index) => {
      const label = line.trimEnd();
      return (
        line === renderedLines[index] ||
        (/^[A-Z][A-Za-z -]*:$/.test(label) && renderedLines[index]!.startsWith(`${label} `))
      );
    })
  );
}

// The review parser makes model text safe for the report, and a fresh review stores
// that text. Older reports stored JSON text from before the parser did.
function safeJsonText(value: unknown): unknown {
  if (typeof value === "string") return neutralizeOwnedSectionSpoofing(value);
  if (Array.isArray(value)) return value.map(safeJsonText);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, safeJsonText(entry)]),
    );
  }
  return value;
}

// A JSON front-matter value can list its keys or entries in another order, and the
// record can add entries, such as the default justification of a selected label.
function jsonDifferenceKind(stored: string, rendered: string): DecisionDifference["kind"] {
  let storedValue: unknown;
  let renderedValue: unknown;
  try {
    storedValue = safeJsonText(JSON.parse(stored));
    renderedValue = JSON.parse(rendered);
  } catch {
    return "changed";
  }
  if (isDeepStrictEqual(storedValue, renderedValue)) return "rendered";
  if (!Array.isArray(storedValue) || !Array.isArray(renderedValue)) return "changed";
  const unmatched = [...renderedValue];
  for (const entry of storedValue) {
    const index = unmatched.findIndex((candidate) => isDeepStrictEqual(candidate, entry));
    if (index === -1) return "changed";
    unmatched.splice(index, 1);
  }
  return unmatched.length ? "filled" : "rendered";
}

function differenceKind(
  report: string,
  field: string,
  stored: string,
  rendered: string,
): DecisionDifference["kind"] {
  if (!stored) return "filled";
  const restated = RESTATED_SECTIONS[field];
  if (restated?.every((key) => frontMatterValue(report, key))) return "rendered";
  if (RENDERED_SECTIONS[field]?.(stored, rendered, report)) return "rendered";
  if (filledLines(stored, rendered)) return "filled";
  return field.startsWith("## ") ? "changed" : jsonDifferenceKind(stored, rendered);
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
  return fields
    .filter((field) => field.stored !== field.rendered && !sameJson(field.stored, field.rendered))
    .map((field) => ({
      ...field,
      kind: differenceKind(stored, field.field, field.stored, field.rendered),
    }));
}

// A JSON front-matter value can list its keys in another order.
function sameJson(left: string, right: string): boolean {
  try {
    return isDeepStrictEqual(JSON.parse(left), JSON.parse(right));
  } catch {
    return false;
  }
}

// A report that the backfill writes: its path under the records directory, the sha256
// of the content that was classified, and that content with the record line.
export interface ReviewRecordBackfillWrite {
  path: string;
  classifiedSha256: string;
  markdown: string;
}

/**
 * Writes each report whose content is still the classified content (compare-and-swap),
 * after it captures the canonical tuple baseline that the reconcile publication checks
 * against the Worker. A report that changed since classification is not written.
 */
export function writeReviewRecordBackfills(options: {
  recordsDir: string;
  baselineDir: string;
  writes: readonly ReviewRecordBackfillWrite[];
}): { changedRecordFiles: string[]; changedSinceClassification: string[] } {
  const repositorySlug = basename(resolve(options.recordsDir));
  const changedRecordFiles: string[] = [];
  const changedSinceClassification: string[] = [];
  for (const write of options.writes) {
    const reportPath = join(options.recordsDir, write.path);
    let current: string | null;
    try {
      current = readFileSync(reportPath, "utf8");
    } catch {
      current = null;
    }
    if (current === null || sha256(current) !== write.classifiedSha256) {
      changedSinceClassification.push(write.path);
      continue;
    }
    const name = basename(write.path);
    const number = numberForMarkdownFile(name);
    const packetName = `${number}.json`;
    captureCanonicalRecordBaseline({
      baselineRoot: options.baselineDir,
      repositorySlug,
      itemNumber: number,
      sources: [
        { section: "items", name, path: join(options.recordsDir, "items", name) },
        { section: "closed", name, path: join(options.recordsDir, "closed", name) },
        { section: "plans", name, path: join(options.recordsDir, "plans", name) },
        {
          section: "decision-packets",
          name: packetName,
          path: join(options.recordsDir, "decision-packets", packetName),
        },
      ],
    });
    writeFileSync(reportPath, write.markdown, "utf8");
    changedRecordFiles.push(name);
  }
  return { changedRecordFiles, changedSinceClassification };
}

// The command classifies this many reports to write, then writes them, so a stop part
// way leaves whole batches written. Publication batches tuples on its own.
const WRITE_BATCH_SIZE = 50;

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
    const kinds = new Set(differences.map((difference) => difference.kind));
    return {
      status: kinds.has("changed") ? "lossy" : kinds.has("filled") ? "filled" : "lossless",
      differences,
      markdown: `${markdown.slice(0, end)}\n${line}${markdown.slice(end)}`,
    };
  }

  /**
   * `backfill-review-records --records-dir <records/<slug>> --output <json>`: reports
   * what the backfill would do for every items and closed report. It writes nothing.
   *
   * With `--write [--limit <n>]` it also adds the record line to lossless and filled
   * reports (at most n), captures each tuple in the canonical baseline directory
   * (`--canonical-record-baseline-dir` or CLAWSWEEPER_CANONICAL_RECORD_BASELINE_DIR),
   * and lists the written reports in `changedRecordFiles` for the reconcile
   * publication. Lossy, unparseable, invalid_record and typed reports stay as they
   * are. A written report is typed, so a second run writes nothing more.
   */
  function backfillReviewRecordsCommand(args: Args): void {
    const recordsDir = stringArg(args.records_dir, "");
    const output = stringArg(args.output, "");
    if (!recordsDir || !output) {
      throw new UserFacingCommandError("backfill-review-records needs --records-dir and --output");
    }
    const write = boolArg(args.write);
    const limit = argNumber(args, "limit", 0);
    const baselineDir = stringArg(
      args.canonical_record_baseline_dir,
      process.env.CLAWSWEEPER_CANONICAL_RECORD_BASELINE_DIR ?? "",
    ).trim();
    if (write && !baselineDir) {
      throw new UserFacingCommandError(
        "backfill-review-records --write needs a canonical record baseline directory",
      );
    }
    const changedRecordFiles: string[] = [];
    const changedSinceClassification: string[] = [];
    let pending: ReviewRecordBackfillWrite[] = [];
    const flush = () => {
      const written = writeReviewRecordBackfills({ recordsDir, baselineDir, writes: pending });
      changedRecordFiles.push(...written.changedRecordFiles);
      changedSinceClassification.push(...written.changedSinceClassification);
      pending = [];
    };
    const counts: Record<ReviewRecordBackfill["status"], number> = {
      typed: 0,
      invalid_record: 0,
      unparseable: 0,
      lossless: 0,
      filled: 0,
      lossy: 0,
    };
    const reasons: Record<string, number> = {};
    // Per field: how many reports lack a stored value, how many store a value that the
    // current renderer prints in another form, and how many store a value that the
    // record would change.
    const fieldCounts: Record<DecisionDifference["kind"], Record<string, number>> = {
      filled: {},
      rendered: {},
      changed: {},
    };
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
        const markdown = readFileSync(join(recordsDir, path), "utf8");
        const result = backfillReviewRecord(markdown);
        total += 1;
        counts[result.status] += 1;
        const sample = (examples[result.status] ??= []);
        if (sample.length < 20) sample.push(path);
        if ("reason" in result) reasons[result.reason] = (reasons[result.reason] ?? 0) + 1;
        if (
          write &&
          (result.status === "lossless" || result.status === "filled") &&
          (!limit || changedRecordFiles.length + pending.length < limit)
        ) {
          pending.push({ path, classifiedSha256: sha256(markdown), markdown: result.markdown });
          if (pending.length >= WRITE_BATCH_SIZE) flush();
        }
        if ("differences" in result) {
          for (const difference of result.differences) {
            const fields = fieldCounts[difference.kind];
            fields[difference.field] = (fields[difference.field] ?? 0) + 1;
            if (difference.kind !== "changed") continue;
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
                kind: difference.kind,
              });
            }
          }
        }
      }
    }
    if (pending.length > 0) flush();
    const byCount = (record: Record<string, number>) =>
      Object.fromEntries(Object.entries(record).sort(([, left], [, right]) => right - left));
    const writeSummary = write
      ? {
          written: changedRecordFiles.length,
          changedSinceClassification: changedSinceClassification.length,
        }
      : {};
    const summary = {
      recordsDir,
      total,
      counts,
      ...writeSummary,
      changedFields: byCount(fieldCounts.changed),
      renderedFields: byCount(fieldCounts.rendered),
      filledFields: byCount(fieldCounts.filled),
      reasons: byCount(reasons),
      examples,
      differenceSamples,
      ...(write
        ? {
            changedSinceClassificationExamples: changedSinceClassification.slice(0, 20),
            changedRecordFiles,
          }
        : {}),
    };
    writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify({ recordsDir, total, counts, ...writeSummary }));
  }

  return { backfillReviewRecord, backfillReviewRecordsCommand };
}
