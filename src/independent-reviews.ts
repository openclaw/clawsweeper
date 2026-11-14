import type { Args } from "./clawsweeper-args.js";
import type { Decision } from "./clawsweeper-types.js";
import { UserFacingCommandError } from "./command.js";
import { stableJson, compareCodeUnits } from "./stable-json.js";

export interface IndependentReview {
  reviewer: 1 | 2;
  requestedModel: string;
  /** The transport does not attest the executed model. */
  executionModel: "unverified";
  snapshotHash: string;
  status: "complete" | "failed";
  decision: Decision;
}

export function independentReviewModels(args: Args): [string, string] | undefined {
  if (args.multi_review_config !== undefined || process.env.CLAWSWEEPER_MULTI_REVIEW_CONFIG) {
    throw new UserFacingCommandError(
      "Legacy multi-review/coordinator configuration is unsupported; use --review-models MODEL,MODEL.",
    );
  }
  if (args.review_models === undefined) return undefined;
  const models = typeof args.review_models === "string" ? args.review_models.split(",") : [];
  if (
    models.length !== 2 ||
    models.some((model) => !/^[A-Za-z0-9][A-Za-z0-9_./:-]*$/.test(model))
  ) {
    throw new UserFacingCommandError(
      "--review-models requires exactly two comma-separated model identifiers, not coordinator JSON.",
    );
  }
  return [models[0]!, models[1]!];
}

// Only these judgments have aggregation policies. Prose and all other assessments
// remain attributed to their authors; disagreement is not resolved by a model.
const JUDGMENT_PATHS = [
  "decision",
  "closeReason",
  "confidence",
  "triagePriority",
  "impactLabels",
  "mergeRiskLabels",
  "maturityLabels",
  "itemCategory",
  "reproductionStatus",
  "reproductionConfidence",
  "implementationComplexity",
  "requiresNewFeature",
  "requiresNewConfigOption",
  "requiresProductDecision",
  "autoImplementationCandidate",
  "workCandidate",
  "overallCorrectness",
  "agentsPolicyStatus.status",
  "productReview.kind",
  "productReview.worthIt",
  "productReview.fixScope",
  "securityReview.status",
  "realBehaviorProof.status",
  "realBehaviorProof.evidenceKind",
  "realBehaviorProof.dataModelCompatibility",
  "realBehaviorProof.needsContributorAction",
  "prRating.proofTier",
  "prRating.patchTier",
  "prRating.overallTier",
  "maintainerDecision.required",
  "maintainerDecision.kind",
  "nextStep.kind",
] as const;

export function independentReviewValue(decision: Decision, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (value, key) =>
        value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined,
      decision,
    );
}

export function independentReviewConflicts(reviews: readonly IndependentReview[]): string[] {
  return JUDGMENT_PATHS.filter(
    (path) =>
      new Set(
        reviews.map((review) => {
          const value = independentReviewValue(review.decision, path);
          return stableJson(Array.isArray(value) ? [...value].sort(compareCodeUnits) : value);
        }),
      ).size > 1,
  );
}

/** Pure operational projection. No votes, semantic deduplication or new close/work authority. */
export function reduceIndependentReviews(
  input: readonly IndependentReview[],
  snapshotHash: string,
  neutral: Decision,
): Decision {
  const reviews = [...input].sort((a, b) => a.reviewer - b.reviewer);
  const complete =
    reviews.length === 2 &&
    reviews[0]?.reviewer === 1 &&
    reviews[1]?.reviewer === 2 &&
    reviews.every(
      (r) =>
        r.status === "complete" &&
        r.snapshotHash === snapshotHash &&
        r.decision.localCheckoutAccess === "verified",
    );
  const decisions = reviews.map((r) => r.decision);
  const conflicts = independentReviewConflicts(reviews);
  const union = <T extends string>(values: T[][]): T[] => [...new Set(values.flat())].sort();
  const least = <T extends string>(order: readonly T[], values: T[]): T =>
    order.find((value) => values.includes(value)) ?? order[0]!;
  const summary = complete
    ? "Two independent reviews; see each attributed assessment."
    : "Codex review failed: required independent reviews are incomplete or stale.";
  const proofStatus = complete
    ? least(
        [
          "missing",
          "mock_only",
          "insufficient",
          "not_applicable",
          "sufficient",
          "override",
        ] as const,
        decisions.map((d) => d.realBehaviorProof.status),
      )
    : "insufficient";
  const rating = (key: "proofTier" | "patchTier" | "overallTier") =>
    complete
      ? least(
          ["NA", "F", "D", "C", "B", "A", "S"] as const,
          decisions.map((d) => d.prRating[key]),
        )
      : "NA";
  const impact = union(decisions.map((d) => d.impactLabels));
  const mergeRisk = union(decisions.map((d) => d.mergeRiskLabels));
  const labelOverflow = impact.length > 3 || mergeRisk.length > 3;
  const labels = {
    triagePriority: least(
      ["P0", "P1", "P2", "P3", "none"] as const,
      decisions.map((d) => d.triagePriority),
    ),
    impactLabels: impact.length <= 3 ? impact : [],
    mergeRiskLabels: mergeRisk.length <= 3 ? mergeRisk : [],
    maturityLabels: complete
      ? union(decisions.map((d) => d.maturityLabels)).filter((label) =>
          decisions.every((d) => d.maturityLabels.includes(label)),
        )
      : [],
  };
  return {
    ...neutral,
    ...labels,
    independentReviews: reviews,
    decision: "keep_open",
    closeReason: "none",
    closeComment: "",
    workCandidate: "none",
    workConfidence: "low",
    workPriority: "low",
    workPrompt: "",
    workClusterRefs: [],
    workValidation: [],
    workLikelyFiles: [],
    autoImplementationCandidate: "none",
    confidence: complete
      ? least(
          ["low", "medium", "high"] as const,
          decisions.map((d) => d.confidence),
        )
      : "low",
    summary,
    changeSummary: summary,
    bestSolution: "Read the independent reviewer sections; no synthesized recommendation.",
    evidence: [],
    likelyOwners: [],
    systemContext: "",
    architectureDiagram: "",
    reproductionAssessment: "See attributed independent reproduction assessments.",
    solutionAssessment: "See attributed independent solution assessments.",
    agentsPolicyStatus: {
      ...neutral.agentsPolicyStatus,
      summary: "See each independent policy assessment.",
    },
    productReview: { ...neutral.productReview, reason: "See each independent product assessment." },
    featureShowcase: { status: "none", reason: "No aggregate showcase recommendation." },
    workReason: "No aggregate work-lane recommendation.",
    risks: decisions.flatMap((d) => d.risks),
    reviewFindings: decisions.flatMap((d) => d.reviewFindings),
    mergeRiskOptions: [], // Original options remain attributed, not consolidated.
    labelJustifications: [
      labels.triagePriority,
      ...labels.impactLabels,
      ...labels.mergeRiskLabels,
      ...labels.maturityLabels,
    ]
      .filter((label) => label !== "none")
      .map((label) => ({
        label: label as Decision["labelJustifications"][number]["label"],
        reason:
          reviews
            .flatMap((r) =>
              r.decision.labelJustifications
                .filter((j) => j.label === label)
                .map((j) => `Reviewer ${r.reviewer}: ${j.reason}`),
            )
            .join("; ") || "Conservative union of independently selected typed labels.",
      })),
    requiresNewFeature: decisions.some((d) => d.requiresNewFeature),
    requiresNewConfigOption: decisions.some((d) => d.requiresNewConfigOption),
    requiresProductDecision: decisions.some((d) => d.requiresProductDecision),
    securityReview: {
      status: decisions.some(
        (d) => d.securityReview.status === "needs_attention" || d.securityReview.concerns.length,
      )
        ? "needs_attention"
        : "not_applicable",
      summary: "See attributed independent security assessments.",
      concerns: decisions.flatMap((d) => d.securityReview.concerns),
    },
    realBehaviorProof: {
      status: proofStatus,
      summary: "See attributed independent proof assessments.",
      evidenceKind:
        complete &&
        decisions.every(
          (d) => d.realBehaviorProof.evidenceKind === decisions[0]!.realBehaviorProof.evidenceKind,
        )
          ? decisions[0]!.realBehaviorProof.evidenceKind
          : "none",
      needsContributorAction:
        !complete || decisions.some((d) => d.realBehaviorProof.needsContributorAction),
      ...(decisions.some((d) => d.realBehaviorProof.dataModelCompatibility === "insufficient")
        ? { dataModelCompatibility: "insufficient" as const }
        : {}),
    },
    prRating: {
      proofTier: rating("proofTier"),
      patchTier: rating("patchTier"),
      overallTier: rating("overallTier"),
      summary: "Conservative independent-review rating projection.",
      nextSteps: [],
    },
    overallCorrectness: decisions.some((d) => d.overallCorrectness === "patch is incorrect")
      ? "patch is incorrect"
      : complete && decisions.every((d) => d.overallCorrectness === "patch is correct")
        ? "patch is correct"
        : "not a patch",
    nextStep:
      !complete || conflicts.length || labelOverflow
        ? {
            kind: "required",
            text: !complete
              ? "Complete both independent reviews of the current source."
              : `Resolve typed reviewer disagreements: ${[...conflicts, ...(labelOverflow ? ["label schema capacity exceeded"] : [])].join(", ")}. Read both assessments; no consensus was generated.`,
          }
        : { kind: "none", text: "" },
    localCheckoutAccess: complete ? "verified" : "unverified",
    checkoutInspectionFailed: decisions.some((d) => d.checkoutInspectionFailed),
    codexTerminalFailure: decisions.some((d) => d.codexTerminalFailure),
  };
}
