/**
 * Linear → ClawSweeper record mapping (deterministic, offline, pure functions).
 *
 * Priority mapping:
 *   Linear 0 (none)   → "none"
 *   Linear 1 (urgent) → "P1"
 *   Linear 2 (high)   → "P2"
 *   Linear 3 (medium) → "P3"
 *   Linear 4 (low)    → "P3"
 *   Any other value   → "none"
 *
 *   P0 is intentionally never assigned here. ClawSweeper reserves P0 exclusively for
 *   emergencies (data loss, security bypass, crash loop, unusable core runtime) requiring
 *   concrete impact evidence that this deterministic mapping layer cannot establish from a
 *   priority integer alone. Linear's "urgent" (1) maps to P1 ("urgent regression affecting
 *   real users now"), which is the correct conservative match. Mapping urgent→P0 would
 *   over-escalate and break ClawSweeper's evidence-required doctrine. P0 is never assigned
 *   from the tracker priority field alone.
 *
 * State mapping:
 *   Linear stateType "completed" or "canceled" → "closed"
 *   Anything else (backlog, unstarted, started, null) → "open"
 *
 * Category inference: case-insensitive substring match on label names.
 *   Precedence (first match wins):
 *   security > regression > bug > docs > skill > cleanup > support > admin > feature
 *   No match → "unclear"
 *
 * Staleness: updatedAt is compared against a caller-supplied nowIso string.
 *   Default stale threshold is 60 days. No system clock reads (deterministic).
 */

import { createHash } from "node:crypto";

import type { LinearIssue, LinearLabel, LinearTeam, WorkspaceItem } from "./types.js";

export type TrackerItemState = "open" | "closed";

/** Provider tag for source identity. Linear records are always "linear". */
export const LINEAR_SOURCE_PROVIDER = "linear" as const;
export type LinearSourceProvider = typeof LINEAR_SOURCE_PROVIDER;

export type TriagePriority = "P0" | "P1" | "P2" | "P3" | "none";

export type ItemCategory =
  | "bug"
  | "regression"
  | "feature"
  | "skill"
  | "docs"
  | "cleanup"
  | "support"
  | "admin"
  | "security"
  | "unclear";

export interface LinearReviewRecord {
  id: string; // Linear issue id (UUID) — durable source identity, e.g. "a1b2…"
  key: string; // = issue.identifier, e.g. "PAR-123" (the human-facing identifier)
  identifier: string; // = issue.identifier; explicit per ClawSweeper taxonomy (mirrors `key`)
  title: string;
  url: string;
  sourceProvider: LinearSourceProvider; // "linear" — provider half of the source identity
  sourceId: string; // = id; provider-scoped durable id consumed by downstream records
  snapshotHash: string; // sha256 over canonical source/record fields (deterministic, clock-free)
  workspaceSlug: string; // "linear-" + team.key.toLowerCase()
  reviewMarker: string; // `<!-- clawsweeper-review:<sourceId> -->`
  state: TrackerItemState;
  linearStateId: string | null;
  linearStateName: string | null;
  linearStateType: string | null;
  triagePriority: TriagePriority;
  itemCategory: ItemCategory;
  teamKey: string;
  teamName: string;
  projectName: string | null;
  labels: string[]; // label NAMES, from issue.labels[].name
  createdAt: string;
  updatedAt: string;
}

/** A single field-level validation failure for a {@link LinearReviewRecord}. */
export interface LinearRecordValidationIssue {
  field: string;
  message: string;
}

/** Returns the workspace slug: "linear-" + team.key lowercased. */
export function linearWorkspaceSlug(team: LinearTeam): string {
  return `linear-${team.key.toLowerCase()}`;
}

/** Returns the durable review-comment marker for a given Linear issue UUID. */
export function linearReviewMarker(issueId: string): string {
  return `<!-- clawsweeper-review:${issueId} -->`;
}

/**
 * Maps a Linear priority integer to a TriagePriority.
 * 0 → none, 1 → P1, 2 → P2, 3 → P3, 4 → P3, else → none.
 * P0 is never assigned here — see module doc comment for rationale.
 */
export function mapLinearPriority(priority: number): TriagePriority {
  switch (priority) {
    case 1:
      return "P1";
    case 2:
      return "P2";
    case 3:
      return "P3";
    case 4:
      return "P3";
    default:
      return "none";
  }
}

// Linear exposes WorkflowState.type as a String rather than a GraphQL enum. Keep an explicit
// allowlist so a newly introduced category stops the lane instead of silently becoming open.
const OPEN_LINEAR_WORKFLOW_STATE_TYPES = new Set(["triage", "backlog", "unstarted", "started"]);
const CLOSED_LINEAR_WORKFLOW_STATE_TYPES = new Set(["completed", "canceled", "duplicate"]);

/** Rejects missing or unknown Linear workflow-state types at every record boundary. */
export function assertLinearWorkflowStateType(stateType: string | null): string {
  if (
    stateType === null ||
    (!OPEN_LINEAR_WORKFLOW_STATE_TYPES.has(stateType) &&
      !CLOSED_LINEAR_WORKFLOW_STATE_TYPES.has(stateType))
  ) {
    throw new Error(
      `unsupported Linear workflow state type${stateType === null ? "" : ` ${stateType}`}`,
    );
  }
  return stateType;
}

/** Maps a validated Linear workflow-state type to TrackerItemState. */
export function mapLinearState(stateType: string | null): TrackerItemState {
  const validated = assertLinearWorkflowStateType(stateType);
  return CLOSED_LINEAR_WORKFLOW_STATE_TYPES.has(validated) ? "closed" : "open";
}

// Category precedence order — first substring match wins.
const CATEGORY_RULES: Array<[ItemCategory, string]> = [
  ["security", "security"],
  ["regression", "regression"],
  ["bug", "bug"],
  ["docs", "doc"],
  ["skill", "skill"],
  ["cleanup", "cleanup"],
  ["support", "support"],
  ["admin", "admin"],
  ["feature", "feature"],
];

/**
 * Infers an ItemCategory from label names via case-insensitive substring match.
 * Precedence: security > regression > bug > docs > skill > cleanup > support > admin > feature.
 * Returns "unclear" when no label matches.
 */
export function inferItemCategory(labels: LinearLabel[]): ItemCategory {
  const names = labels.map((l) => l.name.toLowerCase());
  for (const [category, substr] of CATEGORY_RULES) {
    if (names.some((n) => n.includes(substr))) return category;
  }
  return "unclear";
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_STALE_DAYS = 60;

/**
 * Returns true if the issue's updatedAt is older than staleDays before nowIso.
 * nowIso must be provided by the caller — this function never reads the system clock.
 */
export function isStaleIssue(
  issue: LinearIssue,
  nowIso: string,
  staleDays = DEFAULT_STALE_DAYS,
): boolean {
  const now = new Date(nowIso).getTime();
  const updated = new Date(issue.updatedAt).getTime();
  return now - updated > staleDays * MS_PER_DAY;
}

/**
 * Builds the canonical snapshot object that the record's content hash is derived from.
 *
 * Fields are enumerated explicitly (never via object-key iteration) and labels are
 * sorted, so the snapshot is stable for equivalent input regardless of label order.
 * The purely-derived reviewMarker and the hash itself are excluded. No system clock is read.
 */
function linearReviewSnapshot(
  record: Omit<LinearReviewRecord, "snapshotHash">,
): Record<string, unknown> {
  return {
    sourceProvider: record.sourceProvider,
    sourceId: record.sourceId,
    identifier: record.identifier,
    url: record.url,
    title: record.title,
    state: record.state,
    linearStateId: record.linearStateId,
    linearStateName: record.linearStateName,
    linearStateType: record.linearStateType,
    triagePriority: record.triagePriority,
    itemCategory: record.itemCategory,
    teamKey: record.teamKey,
    teamName: record.teamName,
    projectName: record.projectName,
    workspaceSlug: record.workspaceSlug,
    labels: [...record.labels].sort(),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * Returns a deterministic sha256 snapshot hash for a record's canonical source fields.
 * Stable for equivalent input (order-independent labels) and changes when any material
 * source/classification field changes. Never reads the system clock or the network.
 */
export function linearReviewSnapshotHash(record: Omit<LinearReviewRecord, "snapshotHash">): string {
  return createHash("sha256")
    .update(JSON.stringify(linearReviewSnapshot(record)))
    .digest("hex");
}

// Required non-empty string fields a record must carry before downstream consumers use it.
const REQUIRED_STRING_FIELDS = [
  "id",
  "key",
  "identifier",
  "title",
  "url",
  "sourceProvider",
  "sourceId",
  "snapshotHash",
  "workspaceSlug",
  "reviewMarker",
  "teamKey",
  "teamName",
  "createdAt",
  "updatedAt",
] as const;

const VALID_STATES = new Set<TrackerItemState>(["open", "closed"]);
const VALID_PRIORITIES = new Set<TriagePriority>(["P0", "P1", "P2", "P3", "none"]);
const VALID_CATEGORIES = new Set<ItemCategory>([
  "bug",
  "regression",
  "feature",
  "skill",
  "docs",
  "cleanup",
  "support",
  "admin",
  "security",
  "unclear",
]);

/**
 * Validates the required decision fields of a LinearReviewRecord. Pure and offline.
 * Returns an empty array for a well-formed record, or one issue per failed field —
 * downstream classifier/report steps should reject any record with a non-empty result.
 */
export function validateLinearReviewRecord(
  record: LinearReviewRecord,
): LinearRecordValidationIssue[] {
  const issues: LinearRecordValidationIssue[] = [];
  const view = record as unknown as Record<string, unknown>;

  for (const field of REQUIRED_STRING_FIELDS) {
    const value = view[field];
    if (typeof value !== "string" || value.length === 0) {
      issues.push({ field, message: `${field} must be a non-empty string` });
    }
  }

  if (!VALID_STATES.has(record.state)) {
    issues.push({
      field: "state",
      message: `state must be one of: ${[...VALID_STATES].join(", ")}`,
    });
  }
  if (!VALID_PRIORITIES.has(record.triagePriority)) {
    issues.push({
      field: "triagePriority",
      message: `triagePriority must be one of: ${[...VALID_PRIORITIES].join(", ")}`,
    });
  }
  if (!VALID_CATEGORIES.has(record.itemCategory)) {
    issues.push({
      field: "itemCategory",
      message: `itemCategory must be one of: ${[...VALID_CATEGORIES].join(", ")}`,
    });
  }
  if (!Array.isArray(record.labels) || record.labels.some((l) => typeof l !== "string")) {
    issues.push({ field: "labels", message: "labels must be an array of strings" });
  }
  if (record.sourceProvider !== LINEAR_SOURCE_PROVIDER) {
    issues.push({ field: "sourceProvider", message: 'sourceProvider must be "linear"' });
  }
  if (record.identifier !== record.key) {
    issues.push({ field: "identifier", message: "identifier must equal key" });
  }
  if (record.sourceId !== record.id) {
    issues.push({ field: "sourceId", message: "sourceId must equal id" });
  }

  return issues;
}

/**
 * Asserts a LinearReviewRecord is well-formed, throwing a precise error listing every
 * failed field. Use this as the guard before a classifier or report consumes the record.
 */
export function assertLinearReviewRecord(record: LinearReviewRecord): void {
  const issues = validateLinearReviewRecord(record);
  if (issues.length > 0) {
    const detail = issues.map((i) => `${i.field}: ${i.message}`).join("; ");
    throw new Error(`Invalid LinearReviewRecord: ${detail}`);
  }
}

/**
 * Maps a WorkspaceItem (team + project + issue) into a LinearReviewRecord.
 * Aggregates all mapping helpers above and stamps a deterministic snapshot hash.
 */
export function mapWorkspaceItem(item: WorkspaceItem): LinearReviewRecord {
  const { team, project, issue } = item;
  const key = issue.identifier;
  const workspaceSlug = linearWorkspaceSlug(team);
  const base: Omit<LinearReviewRecord, "snapshotHash"> = {
    id: issue.id,
    key,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    sourceProvider: LINEAR_SOURCE_PROVIDER,
    sourceId: issue.id,
    workspaceSlug,
    reviewMarker: linearReviewMarker(issue.id),
    state: mapLinearState(issue.stateType),
    linearStateId: issue.stateId,
    linearStateName: issue.stateName,
    linearStateType: issue.stateType,
    triagePriority: mapLinearPriority(issue.priority),
    itemCategory: inferItemCategory(issue.labels),
    teamKey: team.key,
    teamName: team.name,
    projectName: project?.name ?? null,
    labels: issue.labels.map((l) => l.name),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
  return { ...base, snapshotHash: linearReviewSnapshotHash(base) };
}
