import { createHash } from "node:crypto";
import { stableJson } from "./stable-json.ts";
import { recordOrEmpty, stringOrEmpty } from "./value-coerce.ts";
const labelNames = (labels: unknown[]) =>
  labels
    .map((label) => (typeof label === "string" ? label : recordOrEmpty(label).name))
    .filter((name): name is string => typeof name === "string" && Boolean(name));

export interface OversizedPrSourceSnapshot {
  fingerprint: string;
  updatedAt: string;
  observedAt: string;
  comments: number;
  reviewComments: number;
}

const hash = (value: unknown) => createHash("sha256").update(stableJson(value)).digest("hex");
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const timestamp = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export function oversizedPrSourceSnapshot(
  pull: Record<string, unknown>,
  observedAt?: string,
): OversizedPrSourceSnapshot | null {
  if (
    !timestamp(pull.updated_at) ||
    !count(pull.comments) ||
    !count(pull.review_comments) ||
    typeof pull.title !== "string" ||
    !(typeof pull.body === "string" || pull.body === null) ||
    !Array.isArray(pull.labels)
  )
    return null;
  return {
    fingerprint: hash({
      head: recordOrEmpty(pull.head).sha,
      additions: pull.additions,
      deletions: pull.deletions,
      changedFiles: pull.changed_files,
      state: pull.state,
      locked: pull.locked === true,
      title: pull.title,
      body: pull.body ?? "",
      labels: labelNames(pull.labels).sort(),
      draft: pull.draft === true,
      baseRef: stringOrEmpty(recordOrEmpty(pull.base).ref),
      assignees: pull.assignees ?? [],
      milestone: pull.milestone ?? null,
      requestedReviewers: pull.requested_reviewers ?? [],
      requestedTeams: pull.requested_teams ?? [],
    }),
    updatedAt: pull.updated_at,
    observedAt: timestamp(observedAt) ? observedAt : pull.updated_at,
    comments: pull.comments,
    reviewComments: pull.review_comments,
  };
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return recordOrEmpty(value);
}

export function parseOversizedPrSourceSnapshot(value: unknown): OversizedPrSourceSnapshot | null {
  const source = jsonRecord(value);
  return digest(source.fingerprint) &&
    timestamp(source.updatedAt) &&
    timestamp(source.observedAt) &&
    count(source.comments) &&
    count(source.reviewComments)
    ? {
        fingerprint: source.fingerprint,
        updatedAt: source.updatedAt,
        observedAt: source.observedAt,
        comments: source.comments,
        reviewComments: source.reviewComments,
      }
    : null;
}
