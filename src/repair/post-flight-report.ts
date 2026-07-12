import type { JsonValue, LooseRecord } from "./json-types.js";

export type PostFlightReportOutcome = "success" | "blocked" | "requeue";

export interface PostFlightReportSummary {
  outcome: PostFlightReportOutcome;
  detail: string;
}

const SUCCESS_STATUSES = new Set(["executed", "ready"]);

export function summarizePostFlightReport(report: LooseRecord): PostFlightReportSummary {
  const actions = Array.isArray(report.actions) ? report.actions : [];
  const incomplete = actions.filter(
    (action: JsonValue) => !SUCCESS_STATUSES.has(String(action?.status ?? "")),
  );
  if (actions.length > 0 && incomplete.length === 0) {
    return {
      outcome: "success",
      detail: "all generated post-flight actions completed",
    };
  }

  const terminal = incomplete.find((action: JsonValue) => action?.retry_recommended !== true);
  if (terminal) {
    return {
      outcome: "blocked",
      detail: actionDetail(terminal, "post-flight generated a terminal blocked action"),
    };
  }

  if (incomplete.length > 0) {
    return {
      outcome: "requeue",
      detail: actionDetail(incomplete[0], "post-flight requested a retry"),
    };
  }

  return {
    outcome: "blocked",
    detail: "post-flight generated no actions",
  };
}

function actionDetail(action: JsonValue, fallback: string): string {
  const reason = compactOutput(String(action?.reason ?? ""));
  const name = compactOutput(String(action?.action ?? ""));
  if (reason && name) return `${name}: ${reason}`;
  return reason || name || fallback;
}

function compactOutput(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 1000);
}
