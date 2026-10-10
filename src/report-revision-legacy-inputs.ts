import {
  AUTO_IMPLEMENTATION_CANDIDATES,
  IMPLEMENTATION_COMPLEXITIES,
  SECURITY_REVIEW_STATUSES,
  VISION_FIT_STATUSES,
} from "./clawsweeper-policy.js";
import { reviewSectionValue } from "./clawsweeper-record-metadata.js";
import { sectionLineValue } from "./clawsweeper-report-helpers.js";
import type { Decision } from "./clawsweeper-types.js";
import { frontMatterStringArray, frontMatterValue } from "./report-front-matter.js";

type RevisionFields =
  | "decision"
  | "closeReason"
  | "confidence"
  | "requiresProductDecision"
  | "requiresNewFeature"
  | "requiresNewConfigOption"
  | "workCandidate"
  | "workConfidence"
  | "autoImplementationCandidate"
  | "workPrompt"
  | "workReason"
  | "workValidation"
  | "workLikelyFiles"
  | "workClusterRefs"
  | "itemCategory"
  | "reproductionStatus"
  | "reproductionConfidence"
  | "visionFit"
  | "implementationComplexity"
  | "visionFitEvidence";
export type ReportRevisionInputs = Pick<Decision, RevisionFields> & {
  securityReview: Pick<Decision["securityReview"], "status">;
};

// Only reportRevisionSha256 may use this historical projection. It preserves
// persisted intake/job identity; it must never authorize a review decision.
export function legacyInputsForReportRevision(markdown: string): ReportRevisionInputs {
  const fm = (key: string) => frontMatterValue(markdown, key);
  const required = <T extends string>(key: string): T => {
    const value = fm(key);
    if (!value) throw new Error(`front matter has no ${key}`);
    return value as T;
  };
  // The original converter required work_priority even though it was not hashed.
  required("work_priority");
  const vision = reviewSectionValue(markdown, "visionFit");
  const visionValue = sectionLineValue(vision, "Status") ?? fm("vision_fit");
  const complexity =
    sectionLineValue(vision, "Implementation complexity") ?? fm("implementation_complexity");
  const candidate =
    sectionLineValue(vision, "Auto implementation candidate") ??
    fm("auto_implementation_candidate");
  const security = reviewSectionValue(markdown, "securityReview");
  const status = sectionLineValue(security, "Status") as Decision["securityReview"]["status"];
  const summary = sectionLineValue(security, "Summary")?.trim();
  const usableSummary = summary && !/^(?:-\s*)?(?:none|n\/a|not applicable)[.!]?$/i.test(summary);
  const workPrompt = reviewSectionValue(markdown, "repairWorkPrompt");
  return {
    decision: required("decision"),
    closeReason: required("close_reason"),
    confidence: required("confidence"),
    requiresProductDecision: fm("requires_product_decision") === "true",
    requiresNewFeature: fm("requires_new_feature") === "true",
    requiresNewConfigOption: fm("requires_new_config_option") === "true",
    workCandidate: required("work_candidate"),
    workConfidence: required("work_confidence"),
    autoImplementationCandidate: AUTO_IMPLEMENTATION_CANDIDATES.has(
      candidate as Decision["autoImplementationCandidate"],
    )
      ? (candidate as Decision["autoImplementationCandidate"])
      : "none",
    securityReview: {
      status:
        SECURITY_REVIEW_STATUSES.has(status) && (usableSummary || status === "needs_attention")
          ? status
          : "not_applicable",
    },
    workPrompt: workPrompt === "_Not provided._" ? "" : workPrompt,
    workReason:
      reviewSectionValue(markdown, "workCandidate")
        .match(/(?:^|\n)Reason: ([\s\S]*?)(?:\n\nCluster refs:\n|$)/)?.[1]
        ?.trim() ?? "",
    workValidation: frontMatterStringArray(markdown, "work_validation"),
    workLikelyFiles: frontMatterStringArray(markdown, "work_likely_files"),
    workClusterRefs: frontMatterStringArray(markdown, "work_cluster_refs"),
    itemCategory: required("item_category"),
    reproductionStatus: required("reproduction_status"),
    reproductionConfidence: required("reproduction_confidence"),
    visionFit: VISION_FIT_STATUSES.has(visionValue as Decision["visionFit"])
      ? (visionValue as Decision["visionFit"])
      : "not_applicable",
    implementationComplexity: IMPLEMENTATION_COMPLEXITIES.has(
      complexity as Decision["implementationComplexity"],
    )
      ? (complexity as Decision["implementationComplexity"])
      : "not_applicable",
    visionFitEvidence: frontMatterStringArray(markdown, "vision_fit_evidence"),
  };
}
