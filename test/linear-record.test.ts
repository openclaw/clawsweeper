import assert from "node:assert/strict";
import test from "node:test";

import {
  linearWorkspaceSlug,
  linearReviewMarker,
  mapLinearPriority,
  mapLinearState,
  inferItemCategory,
  isStaleIssue,
  mapWorkspaceItem,
  linearReviewSnapshotHash,
  validateLinearReviewRecord,
  assertLinearReviewRecord,
} from "../dist/linear/record.js";
import type { LinearReviewRecord } from "../dist/linear/record.js";
import type { LinearIssue, LinearLabel, LinearTeam, WorkspaceItem } from "../dist/linear/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTeam(overrides: Partial<LinearTeam> = {}): LinearTeam {
  return { id: "team-1", key: "ENG", name: "Engineering", ...overrides };
}

function makeLabels(...names: string[]): LinearLabel[] {
  return names.map((name, i) => ({ id: `lbl-${i}`, name }));
}

function makeIssue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: "issue-1",
    identifier: "ENG-42",
    title: "Example issue",
    url: "https://linear.app/eng/issue/ENG-42",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-06-01T00:00:00Z",
    teamId: "team-1",
    projectId: "proj-1",
    stateId: "state-started",
    stateName: "In Progress",
    stateType: "started",
    priority: 2,
    labels: [],
    ...overrides,
  };
}

function makeWorkspaceItem(overrides: Partial<WorkspaceItem> = {}): WorkspaceItem {
  return {
    team: makeTeam(),
    project: { id: "proj-1", name: "Platform", teamId: "team-1", state: "started" },
    issue: makeIssue(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// linearWorkspaceSlug
// ---------------------------------------------------------------------------

test("linearWorkspaceSlug: prepends 'linear-' and lowercases the team key", () => {
  const team = makeTeam({ key: "ENG" });
  assert.equal(linearWorkspaceSlug(team), "linear-eng");
});

test("linearWorkspaceSlug: already-lowercase key stays lowercase", () => {
  const team = makeTeam({ key: "par" });
  assert.equal(linearWorkspaceSlug(team), "linear-par");
});

test("linearWorkspaceSlug: mixed-case key is fully lowercased", () => {
  const team = makeTeam({ key: "MyTeam" });
  assert.equal(linearWorkspaceSlug(team), "linear-myteam");
});

// ---------------------------------------------------------------------------
// linearReviewMarker
// ---------------------------------------------------------------------------

test("linearReviewMarker: wraps durable Linear UUID in HTML comment marker", () => {
  assert.equal(
    linearReviewMarker("8f7c0a6a-8b76-44a5-9282-bb62c3d7c2a4"),
    "<!-- clawsweeper-review:8f7c0a6a-8b76-44a5-9282-bb62c3d7c2a4 -->",
  );
});

// ---------------------------------------------------------------------------
// mapLinearPriority
// ---------------------------------------------------------------------------

test("mapLinearPriority: 0 → 'none'", () => {
  assert.equal(mapLinearPriority(0), "none");
});

test("mapLinearPriority: 1 → 'P1' (urgent; NOT P0)", () => {
  assert.equal(mapLinearPriority(1), "P1");
});

test("mapLinearPriority: 2 → 'P2'", () => {
  assert.equal(mapLinearPriority(2), "P2");
});

test("mapLinearPriority: 3 → 'P3'", () => {
  assert.equal(mapLinearPriority(3), "P3");
});

test("mapLinearPriority: 4 → 'P3' (low maps to P3)", () => {
  assert.equal(mapLinearPriority(4), "P3");
});

test("mapLinearPriority: out-of-range value 9 → 'none'", () => {
  assert.equal(mapLinearPriority(9), "none");
});

// ---------------------------------------------------------------------------
// mapLinearState
// ---------------------------------------------------------------------------

test("mapLinearState: 'completed' → 'closed'", () => {
  assert.equal(mapLinearState("completed"), "closed");
});

test("mapLinearState: 'canceled' → 'closed'", () => {
  assert.equal(mapLinearState("canceled"), "closed");
});

test("mapLinearState: 'duplicate' → 'closed'", () => {
  assert.equal(mapLinearState("duplicate"), "closed");
});

test("mapLinearState: 'started' → 'open'", () => {
  assert.equal(mapLinearState("started"), "open");
});

test("mapLinearState: 'unstarted' → 'open'", () => {
  assert.equal(mapLinearState("unstarted"), "open");
});

test("mapLinearState: 'backlog' → 'open'", () => {
  assert.equal(mapLinearState("backlog"), "open");
});

test("mapLinearState: 'triage' → 'open'", () => {
  assert.equal(mapLinearState("triage"), "open");
});

test("mapLinearState rejects null or unknown workflow state types", () => {
  assert.throws(() => mapLinearState(null), /unsupported Linear workflow state type/);
  assert.throws(
    () => mapLinearState("archived"),
    /unsupported Linear workflow state type archived/,
  );
});

// ---------------------------------------------------------------------------
// inferItemCategory
// ---------------------------------------------------------------------------

test("inferItemCategory: empty labels → 'unclear'", () => {
  assert.equal(inferItemCategory([]), "unclear");
});

test("inferItemCategory: unknown label → 'unclear'", () => {
  assert.equal(inferItemCategory(makeLabels("performance", "ui")), "unclear");
});

test("inferItemCategory: label 'bug' → 'bug'", () => {
  assert.equal(inferItemCategory(makeLabels("bug")), "bug");
});

test("inferItemCategory: 'documentation' substring matches 'doc' → 'docs'", () => {
  assert.equal(inferItemCategory(makeLabels("documentation")), "docs");
});

test("inferItemCategory: 'security' label → 'security'", () => {
  assert.equal(inferItemCategory(makeLabels("security")), "security");
});

test("inferItemCategory: security beats bug when both present", () => {
  // security has higher precedence than bug in the rules
  assert.equal(inferItemCategory(makeLabels("bug", "security")), "security");
});

test("inferItemCategory: 'regression' → 'regression'", () => {
  assert.equal(inferItemCategory(makeLabels("regression")), "regression");
});

test("inferItemCategory: regression beats bug when both present", () => {
  assert.equal(inferItemCategory(makeLabels("bug", "regression")), "regression");
});

test("inferItemCategory: 'feature' label → 'feature'", () => {
  assert.equal(inferItemCategory(makeLabels("feature")), "feature");
});

test("inferItemCategory: case-insensitive match on 'Bug' → 'bug'", () => {
  assert.equal(inferItemCategory(makeLabels("Bug")), "bug");
});

test("inferItemCategory: case-insensitive match on 'SECURITY' → 'security'", () => {
  assert.equal(inferItemCategory(makeLabels("SECURITY")), "security");
});

// ---------------------------------------------------------------------------
// isStaleIssue
// ---------------------------------------------------------------------------

// Fixed reference date: 2024-09-01T00:00:00Z
const NOW_ISO = "2024-09-01T00:00:00Z";

test("isStaleIssue: updatedAt 90 days before now → stale (default 60d threshold)", () => {
  // 90 days before 2024-09-01 = 2024-06-03
  const issue = makeIssue({ updatedAt: "2024-06-03T00:00:00Z" });
  assert.equal(isStaleIssue(issue, NOW_ISO), true);
});

test("isStaleIssue: updatedAt 10 days before now → not stale (default 60d threshold)", () => {
  // 10 days before 2024-09-01 = 2024-08-22
  const issue = makeIssue({ updatedAt: "2024-08-22T00:00:00Z" });
  assert.equal(isStaleIssue(issue, NOW_ISO), false);
});

test("isStaleIssue: exactly 60 days before now → not stale (boundary: > not >=)", () => {
  // Exactly 60 days before 2024-09-01 = 2024-07-03
  const issue = makeIssue({ updatedAt: "2024-07-03T00:00:00Z" });
  assert.equal(isStaleIssue(issue, NOW_ISO), false);
});

test("isStaleIssue: custom staleDays=30; updatedAt 40 days before → stale", () => {
  // 40 days before 2024-09-01 = 2024-07-23
  const issue = makeIssue({ updatedAt: "2024-07-23T00:00:00Z" });
  assert.equal(isStaleIssue(issue, NOW_ISO, 30), true);
});

test("isStaleIssue: custom staleDays=30; updatedAt 10 days before → not stale", () => {
  // 10 days before 2024-09-01 = 2024-08-22
  const issue = makeIssue({ updatedAt: "2024-08-22T00:00:00Z" });
  assert.equal(isStaleIssue(issue, NOW_ISO, 30), false);
});

// ---------------------------------------------------------------------------
// mapWorkspaceItem (end-to-end)
// ---------------------------------------------------------------------------

test("mapWorkspaceItem: maps all fields correctly for a representative fixture", () => {
  const item = makeWorkspaceItem({
    team: makeTeam({ id: "team-1", key: "PAR", name: "Paragon" }),
    project: { id: "proj-1", name: "Platform", teamId: "team-1", state: "started" },
    issue: makeIssue({
      identifier: "PAR-123",
      title: "Fix memory leak",
      url: "https://linear.app/par/issue/PAR-123",
      priority: 1,
      stateId: "state-started",
      stateType: "started",
      createdAt: "2024-03-01T00:00:00Z",
      updatedAt: "2024-03-15T00:00:00Z",
      labels: makeLabels("bug", "regression"),
    }),
  });

  const record = mapWorkspaceItem(item);

  assert.equal(record.key, "PAR-123");
  assert.equal(record.title, "Fix memory leak");
  assert.equal(record.url, "https://linear.app/par/issue/PAR-123");
  assert.equal(record.workspaceSlug, "linear-par");
  assert.equal("recordPath" in record, false);
  assert.equal(record.reviewMarker, "<!-- clawsweeper-review:issue-1 -->");
  assert.equal(record.state, "open");
  assert.equal(record.linearStateId, "state-started");
  assert.equal(record.linearStateName, "In Progress");
  assert.equal(record.linearStateType, "started");
  assert.equal(record.triagePriority, "P1");
  assert.equal(record.itemCategory, "regression"); // regression > bug
  assert.equal(record.teamKey, "PAR");
  assert.equal(record.teamName, "Paragon");
  assert.equal(record.projectName, "Platform");
  assert.deepEqual(record.labels, ["bug", "regression"]);
  assert.equal(record.createdAt, "2024-03-01T00:00:00Z");
  assert.equal(record.updatedAt, "2024-03-15T00:00:00Z");
});

test("mapWorkspaceItem: project=null → projectName is null", () => {
  const item = makeWorkspaceItem({
    project: null,
    issue: makeIssue({
      identifier: "ENG-7",
      stateId: "state-completed",
      stateType: "completed",
      priority: 4,
      labels: makeLabels("cleanup"),
    }),
  });

  const record = mapWorkspaceItem(item);

  assert.equal(record.projectName, null);
  assert.equal(record.state, "closed");
  assert.equal(record.linearStateId, "state-completed");
  assert.equal(record.linearStateType, "completed");
  assert.equal(record.triagePriority, "P3");
  assert.equal(record.itemCategory, "cleanup");
});

// ---------------------------------------------------------------------------
// mapWorkspaceItem: Linear id + source identity (PAR-210 acceptance)
// ---------------------------------------------------------------------------

test("mapWorkspaceItem: preserves Linear id and derives source identity", () => {
  const item = makeWorkspaceItem({
    issue: makeIssue({ id: "issue-xyz", identifier: "ENG-99" }),
  });

  const record = mapWorkspaceItem(item);

  assert.equal(record.id, "issue-xyz");
  assert.equal(record.sourceId, "issue-xyz");
  assert.equal(record.sourceProvider, "linear");
  assert.equal(record.identifier, "ENG-99");
  assert.equal(record.key, "ENG-99");
  assert.equal(record.key, record.identifier);
});

test("mapWorkspaceItem: snapshotHash is a 64-char lowercase hex sha256", () => {
  const record = mapWorkspaceItem(makeWorkspaceItem());
  assert.match(record.snapshotHash, /^[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------------------
// snapshotHash determinism (no clock / no network)
// ---------------------------------------------------------------------------

test("snapshotHash: stable for equivalent input", () => {
  const a = mapWorkspaceItem(makeWorkspaceItem());
  const b = mapWorkspaceItem(makeWorkspaceItem());
  assert.equal(a.snapshotHash, b.snapshotHash);
});

test("snapshotHash: independent of label order (canonicalized)", () => {
  const a = mapWorkspaceItem(
    makeWorkspaceItem({ issue: makeIssue({ labels: makeLabels("bug", "security") }) }),
  );
  const b = mapWorkspaceItem(
    makeWorkspaceItem({ issue: makeIssue({ labels: makeLabels("security", "bug") }) }),
  );
  assert.equal(a.snapshotHash, b.snapshotHash);
});

test("snapshotHash: recomputing from the record is deterministic and matches the stamped hash", () => {
  const record = mapWorkspaceItem(makeWorkspaceItem());
  // Two recomputes are equal (no system clock / hidden state), and equal the stamped value.
  assert.equal(linearReviewSnapshotHash(record), linearReviewSnapshotHash(record));
  assert.equal(linearReviewSnapshotHash(record), record.snapshotHash);
});

test("snapshotHash: changes when the title changes", () => {
  const base = mapWorkspaceItem(makeWorkspaceItem());
  const changed = mapWorkspaceItem(
    makeWorkspaceItem({ issue: makeIssue({ title: "A materially different title" }) }),
  );
  assert.notEqual(base.snapshotHash, changed.snapshotHash);
});

test("snapshotHash: changes when priority changes (P2 → P1)", () => {
  const base = mapWorkspaceItem(makeWorkspaceItem()); // default priority 2 → P2
  const changed = mapWorkspaceItem(makeWorkspaceItem({ issue: makeIssue({ priority: 1 }) }));
  assert.notEqual(base.snapshotHash, changed.snapshotHash);
});

test("snapshotHash: changes when raw Linear workflow state changes", () => {
  const base = mapWorkspaceItem(makeWorkspaceItem());
  const changed = mapWorkspaceItem(
    makeWorkspaceItem({
      issue: makeIssue({
        stateId: "state-todo",
        stateName: "Todo",
        stateType: "unstarted",
      }),
    }),
  );
  assert.equal(base.state, changed.state);
  assert.notEqual(base.snapshotHash, changed.snapshotHash);
});

test("snapshotHash: changes when labels change", () => {
  const base = mapWorkspaceItem(makeWorkspaceItem()); // default: no labels
  const changed = mapWorkspaceItem(
    makeWorkspaceItem({ issue: makeIssue({ labels: makeLabels("docs") }) }),
  );
  assert.notEqual(base.snapshotHash, changed.snapshotHash);
});

// ---------------------------------------------------------------------------
// validateLinearReviewRecord / assertLinearReviewRecord
// ---------------------------------------------------------------------------

test("validateLinearReviewRecord: well-formed record yields no issues", () => {
  const record = mapWorkspaceItem(makeWorkspaceItem());
  assert.deepEqual(validateLinearReviewRecord(record), []);
  assert.doesNotThrow(() => assertLinearReviewRecord(record));
});

test("validateLinearReviewRecord: missing required field (empty url) fails", () => {
  const record = mapWorkspaceItem(makeWorkspaceItem());
  const broken = { ...record, url: "" };

  const issues = validateLinearReviewRecord(broken);
  assert.ok(issues.some((i) => i.field === "url"));
  assert.throws(() => assertLinearReviewRecord(broken), /url/);
});

test("validateLinearReviewRecord: missing required field (empty id) fails", () => {
  const record = mapWorkspaceItem(makeWorkspaceItem());
  const broken = { ...record, id: "" };

  const issues = validateLinearReviewRecord(broken);
  // Empty id is reported, and the sourceId === id consistency check also trips.
  assert.ok(issues.some((i) => i.field === "id"));
  assert.throws(() => assertLinearReviewRecord(broken), /id/);
});

test("validateLinearReviewRecord: invalid enum value fails", () => {
  const record = mapWorkspaceItem(makeWorkspaceItem());
  const broken = { ...record, triagePriority: "P9" } as unknown as LinearReviewRecord;

  const issues = validateLinearReviewRecord(broken);
  assert.ok(issues.some((i) => i.field === "triagePriority"));
});
