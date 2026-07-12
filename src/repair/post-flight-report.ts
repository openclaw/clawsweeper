import type { JsonValue, LooseRecord } from "./json-types.js";

export type PostFlightReportOutcome = "success" | "blocked" | "requeue";

export interface PostFlightReportSummary {
  outcome: PostFlightReportOutcome;
  detail: string;
}

const SUCCESS_STATUSES = new Set(["executed", "published", "ready"]);

export function isPublicationOnlyPostFlightJob(frontmatter: LooseRecord): boolean {
  return (
    !Array.isArray(frontmatter.allowed_actions) ||
    !frontmatter.allowed_actions.includes("merge") ||
    (Array.isArray(frontmatter.blocked_actions) && frontmatter.blocked_actions.includes("merge")) ||
    frontmatter.allow_merge !== true
  );
}

export function shouldFinalizePublicationOnlyPostFlight({
  hasPublicationReceipt,
  frontmatter,
  automergeReplacement,
}: {
  hasPublicationReceipt: boolean;
  frontmatter: LooseRecord;
  automergeReplacement: boolean;
}): boolean {
  return (
    hasPublicationReceipt && !automergeReplacement && isPublicationOnlyPostFlightJob(frontmatter)
  );
}

export function publicationOnlyPostFlightAction({
  action,
  base,
  pull,
  view,
}: {
  action: LooseRecord;
  base: LooseRecord;
  pull: LooseRecord;
  view: LooseRecord;
}): LooseRecord {
  const liveHeadSha = String(pull.head?.sha ?? view.headRefOid ?? "");
  const liveState = String(pull.state ?? view.state ?? "").toLowerCase();
  const mergedAt = pull.merged_at ?? view.mergedAt ?? null;
  if (!action.commit || liveHeadSha !== action.commit) {
    return {
      ...base,
      status: "blocked",
      reason: "published pull request head does not match the authorized repair commit",
    };
  }
  if (liveState !== "open" && !mergedAt) {
    return {
      ...base,
      status: "blocked",
      reason: `published pull request is ${liveState || "unknown"}`,
    };
  }
  return {
    ...base,
    status: "published",
    reason: mergedAt
      ? "authorized repair commit was published and the pull request is already merged"
      : "authorized repair commit was published; merge is intentionally disabled for this lane",
    merged_at: mergedAt,
  };
}

export function issueImplementationPublishedHeadBlock({
  expectedPublishedHeadSha,
  pull,
  view,
}: {
  expectedPublishedHeadSha: unknown;
  pull: LooseRecord;
  view: LooseRecord;
}): string {
  const expected = String(expectedPublishedHeadSha ?? "");
  if (!expected) return "";
  const liveHeadSha = String(pull.head?.sha ?? view.headRefOid ?? "");
  return liveHeadSha === expected
    ? ""
    : "issue implementation pull request head does not match the published receipt";
}

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

export function postFlightOutcomeExitCode(outcome: PostFlightReportOutcome): number {
  return outcome === "success" ? 0 : 1;
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
