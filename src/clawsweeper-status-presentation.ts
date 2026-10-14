import type { Decision, FixedPullRequest } from "./clawsweeper-types.js";
import type { RepositoryProfile } from "./repository-profiles.js";
import { linkedRelease, linkedSha, markdownLink } from "./clawsweeper-links.js";
import { reportReviewDecision, type ReportReviewDecision } from "./report-review-decision.js";
import { ReviewRecordFormatError } from "./review-record.js";

export function formatReviewFreshnessTimestamp(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const utcTime = date.toISOString().slice(11, 16);
  const eastern = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "America/New_York",
  })
    .format(date)
    .replace(" at ", ", ");
  const easternDate = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "America/New_York",
  }).format(date);
  const utcDate = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
  const utc = easternDate === utcDate ? utcTime : `${utcDate}, ${utcTime}`;
  return `${eastern} ET / ${utc} UTC`;
}

export function displayTitle(title: string): string {
  try {
    const parsed = JSON.parse(title) as unknown;
    if (typeof parsed === "string") return parsed;
  } catch {
    // Front matter from older files may be a plain string.
  }
  return title.replace(/^"|"$/g, "");
}

export function fixedInText(decision: Decision, profile: RepositoryProfile): string {
  const parts: string[] = [];
  if (decision.fixedPullRequest?.confidence === "high")
    parts.push(`merged PR ${linkedPullRequest(decision.fixedPullRequest)}`);
  if (decision.fixedRelease)
    parts.push(`release ${linkedRelease(decision.fixedRelease, profile.targetRepo)}`);
  if (decision.fixedSha) parts.push(`commit ${linkedSha(decision.fixedSha, profile.targetRepo)}`);
  if (!decision.fixedRelease && decision.fixedAt)
    parts.push(`main fix timestamp ${decision.fixedAt}`);
  return parts.length ? parts.join(", ") : "not determined";
}

function linkedPullRequest(pull: FixedPullRequest): string {
  return markdownLink(`#${pull.number}`, pull.url);
}

export function fixedInReportText(markdown: string, profile: RepositoryProfile): string {
  const parts: string[] = [];
  let review: ReportReviewDecision;
  try {
    review = reportReviewDecision(markdown);
  } catch (error) {
    if (!(error instanceof ReviewRecordFormatError)) throw error;
    return "not determined";
  }
  const { fixedPullRequest, fixedRelease, fixedSha, fixedAt } = review;
  if (fixedPullRequest?.confidence === "high")
    parts.push(`merged PR ${linkedPullRequest(fixedPullRequest)}`);
  if (fixedRelease && fixedRelease !== "unknown")
    parts.push(`release ${linkedRelease(fixedRelease, profile.targetRepo)}`);
  if (fixedSha && fixedSha !== "unknown")
    parts.push(`commit ${linkedSha(fixedSha, profile.targetRepo)}`);
  if ((!fixedRelease || fixedRelease === "unknown") && fixedAt && fixedAt !== "unknown")
    parts.push(`main fix timestamp ${fixedAt}`);
  return parts.length ? parts.join(", ") : "not determined";
}

export function formatTimestamp(iso: string | undefined): string {
  if (!iso) return "unknown";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(date);
}
export function formatStatusNumber(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? "unknown" : String(value);
}
