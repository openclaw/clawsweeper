import type { JsonValue, LooseRecord } from "./json-types.js";

export function issueImplementationTerminalOutcome(report: LooseRecord) {
  const actionOutcome = [...(report.actions ?? [])].reverse().find((action: JsonValue) => {
    const status = String(action?.status ?? "").toLowerCase();
    if (!["blocked", "skipped", "failed"].includes(status)) return false;
    return ["execute_fix", "open_fix_pr", "repair_contributor_branch", "needs_human"].includes(
      String(action?.action ?? ""),
    );
  });
  if (actionOutcome) return actionOutcome;

  const status = String(report.status ?? "").toLowerCase();
  if (!["blocked", "skipped", "failed", "needs_human"].includes(status)) return null;
  return {
    action: "issue_implementation",
    status: status === "needs_human" ? "blocked" : status,
    reason: report.reason,
  };
}
