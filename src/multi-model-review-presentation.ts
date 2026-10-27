import type { MultiModelAssessment, MultiModelReviewRecord } from "./review-record.js";
import { reviewDecisionParser } from "./clawsweeper-decision-parser.js";
import { neutralizeOwnedSectionSpoofing } from "./clawsweeper-report-helpers.js";

const escaped = (value: string) =>
  neutralizeOwnedSectionSpoofing(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
const bounded = (value: string, bytes: number) => {
  if (Buffer.byteLength(value) <= bytes) return value;
  return (
    Buffer.from(value)
      .subarray(0, Math.max(0, bytes - 80))
      .toString("utf8")
      .replace(/\ufffd$/, "") +
    "\n[Display abbreviated; full assessment remains in the durable review record.]"
  );
};
function assessmentBody(member: MultiModelAssessment): string {
  const execution = member.execution;
  const lines = [
    "Status: " + member.status,
    ...(member.failure
      ? [
          "Failure class: " +
            member.failure.logKind +
            "; retryable: " +
            member.failure.retryable +
            "; terminal: " +
            member.failure.terminal,
        ]
      : []),
    "Requested: " +
      member.selection.runner +
      "/" +
      member.selection.model +
      "; effort: " +
      (member.selection.reasoningEffort ?? "host default") +
      "; context: " +
      (member.selection.contextTier ?? "default"),
    "Runtime selection: " +
      (execution?.runtimeModelSelection
        ? execution.runtimeModelSelection.provider + "/" + execution.runtimeModelSelection.model
        : "unreported"),
    "Runtime model: " +
      (execution?.provider && execution.model
        ? execution.provider + "/" + execution.model
        : "unreported"),
    "Terminal model: " +
      (execution?.terminalReceipt
        ? execution.terminalReceipt.effective.provider +
          "/" +
          execution.terminalReceipt.effective.model
        : "unreported"),
    "Runtime thinking: " +
      (execution?.requestShaping?.thinking ?? "unreported") +
      "; clamped: " +
      (execution?.requestShaping?.thinkingClamped ?? "unreported") +
      " (not provider-observed effort)",
  ];
  const d = member.decision;
  if (!d) return lines.join("\n") + "\nNo complete assessment; this is not a consensus.";
  const section = (title: string, values: string[]) =>
    lines.push("", title, bounded(escaped(values.join("\n") || "None."), 500));
  section("Verdict", [
    d.decision +
      "; " +
      d.closeReason +
      "; confidence: " +
      d.confidence +
      "; " +
      d.overallCorrectness,
    d.summary,
  ]);
  section("Change and relevance", [
    d.changeSummary,
    d.productReview.kind + "; worth: " + d.productReview.worthIt + "; " + d.productReview.reason,
    d.solutionAssessment,
  ]);
  section(
    "Findings",
    d.reviewFindings.length
      ? d.reviewFindings.map(
          (f) =>
            "P" + f.priority + " " + f.file + ":" + f.lineStart + " " + f.title + " — " + f.body,
        )
      : ["None."],
  );
  section(
    "Evidence",
    d.evidence.map((e) => e.label + ": " + e.detail),
  );
  section("Proof and compatibility", [
    d.realBehaviorProof.status +
      "; contributor action: " +
      d.realBehaviorProof.needsContributorAction +
      "; data compatibility: " +
      (d.realBehaviorProof.dataModelCompatibility ?? "unreported"),
    d.realBehaviorProof.summary,
    d.testingReview.proofPath + "; " + d.testingReview.missingE2e,
  ]);
  section("Owner and product decisions", [
    "Required: " + d.maintainerDecision.required + "; " + d.maintainerDecision.question,
    ...d.likelyOwners.map((owner) => owner.person + " — " + owner.reason),
  ]);
  section("Security", [
    d.securityReview.status + "; " + d.securityReview.summary,
    ...d.securityReview.concerns.map((concern) => concern.title + " — " + concern.body),
  ]);
  section("Risks and follow-up", [...d.risks, d.nextStep?.text ?? "", d.workReason]);
  section(
    "Proposed labels (advisory, not independently applied)",
    reviewDecisionParser.selectedReviewLabels(d),
  );
  return lines.join("\n");
}
export function renderMultiModelAssessments(record: MultiModelReviewRecord): string {
  const intro =
    "## Independent model assessments\n\n" +
    (record.status === "complete"
      ? "The summary above is the reconciled assessment. Only its canonical label plan is applied."
      : "**Incomplete multi-model review.** Individual results below are advisory; no consensus or readiness is claimed.") +
    "\n\nCompletion describes assessment content only. Exact actual-model/high-effort pair qualification remains unverified; requested settings and native runtime facts below are separate.\n\nConfiguration: ";
  // All model text is escaped inside a host-owned preformatted block: no owned headings or markers.
  return (
    intro +
    record.source.configRevision +
    " · " +
    record.source.configDigest +
    "\n\n" +
    record.members
      .map(
        (member) =>
          "<details>\n<summary>" +
          escaped(member.id + " · " + member.selection.runner + " · " + member.selection.model) +
          "</summary>\n\n<pre>" +
          bounded(assessmentBody(member), 6400) +
          "</pre>\n</details>",
      )
      .join("\n\n") +
    "\n\nCoordinator: " +
    escaped(record.coordinator.selection.runner + "/" + record.coordinator.selection.model) +
    " · " +
    record.coordinator.status +
    (record.vetoes.length ? "\nHost vetoes: " + record.vetoes.map(escaped).join(", ") : "")
  );
}
