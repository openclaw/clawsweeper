import assert from "node:assert/strict";
import test from "node:test";

import { classifyRecord, classifyRecords, proposesClose } from "../dist/linear/classifier.js";
import type {
  ClassifierOptions,
  LinearClassification,
  ReviewDisposition,
} from "../dist/linear/classifier.js";
import { mapWorkspaceItem } from "../dist/linear/record.js";
import type { LinearIssue, LinearLabel, LinearTeam, WorkspaceItem } from "../dist/linear/types.js";

// Re-export barrel wiring check
import { classifyRecord as classifyRecordFromIndex } from "../dist/linear/index.js";

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
    updatedAt: "2024-08-20T00:00:00Z", // ~12 days before NOW_ISO: recent, not stale
    teamId: "team-1",
    projectId: "proj-1",
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

// Fixed reference clock (mirrors linear-record.test.ts convention)
const NOW_ISO = "2024-09-01T00:00:00Z";

// Default options — recent record, no label filters
const BASE_OPTS: ClassifierOptions = { nowIso: NOW_ISO };

// ---------------------------------------------------------------------------
// Disposition: closed
// ---------------------------------------------------------------------------

test('classifyRecord: stateType "completed" → disposition "closed", eligible=false, closeable=false', () => {
  const record = mapWorkspaceItem(
    makeWorkspaceItem({ issue: makeIssue({ stateType: "completed" }) }),
  );
  const c = classifyRecord(record, BASE_OPTS);
  assert.equal(c.disposition, "closed");
  assert.equal(c.eligible, false);
  assert.equal(c.closeable, false);
  assert.equal(c.reviewOnly, true);
});

test('classifyRecord: stateType "canceled" → disposition "closed", eligible=false, closeable=false', () => {
  const record = mapWorkspaceItem(
    makeWorkspaceItem({ issue: makeIssue({ stateType: "canceled" }) }),
  );
  const c = classifyRecord(record, BASE_OPTS);
  assert.equal(c.disposition, "closed");
  assert.equal(c.eligible, false);
  assert.equal(c.closeable, false);
});

// ---------------------------------------------------------------------------
// Disposition: protected
// ---------------------------------------------------------------------------

test('classifyRecord: protectedLabel match → disposition "protected", eligible=false, closeable=false', () => {
  const record = mapWorkspaceItem(
    makeWorkspaceItem({ issue: makeIssue({ labels: makeLabels("Pinned") }) }),
  );
  const c = classifyRecord(record, { ...BASE_OPTS, protectedLabels: ["Pinned"] });
  assert.equal(c.disposition, "protected");
  assert.equal(c.eligible, false);
  assert.equal(c.closeable, false);
});

// ---------------------------------------------------------------------------
// Disposition: excluded
// ---------------------------------------------------------------------------

test('classifyRecord: exclusionLabel match → disposition "excluded", eligible=false, closeable=true', () => {
  const record = mapWorkspaceItem(
    makeWorkspaceItem({ issue: makeIssue({ labels: makeLabels("wont-fix") }) }),
  );
  const c = classifyRecord(record, { ...BASE_OPTS, exclusionLabels: ["wont-fix"] });
  assert.equal(c.disposition, "excluded");
  assert.equal(c.eligible, false);
  assert.equal(c.closeable, true);
});

// ---------------------------------------------------------------------------
// Disposition: not-ready
// ---------------------------------------------------------------------------

test('classifyRecord: requiredLabels set, none present → disposition "not-ready", eligible=false', () => {
  const record = mapWorkspaceItem(makeWorkspaceItem({ issue: makeIssue({ labels: [] }) }));
  const c = classifyRecord(record, { ...BASE_OPTS, requiredLabels: ["triaged"] });
  assert.equal(c.disposition, "not-ready");
  assert.equal(c.eligible, false);
});

test("classifyRecord: requiredLabels set, one present → NOT not-ready (disposition is review or stale-candidate)", () => {
  const record = mapWorkspaceItem(
    makeWorkspaceItem({ issue: makeIssue({ labels: makeLabels("triaged") }) }),
  );
  const c = classifyRecord(record, { ...BASE_OPTS, requiredLabels: ["triaged"] });
  assert.ok(c.disposition === "review" || c.disposition === "stale-candidate");
});

// ---------------------------------------------------------------------------
// Disposition: stale-candidate
// ---------------------------------------------------------------------------

test('classifyRecord: updatedAt 90d before NOW_ISO → disposition "stale-candidate", eligible=true, staleCandidate=true, closeCandidateReason="stale_insufficient_info"', () => {
  // 90 days before 2024-09-01 = 2024-06-03
  const record = mapWorkspaceItem(
    makeWorkspaceItem({ issue: makeIssue({ updatedAt: "2024-06-03T00:00:00Z" }) }),
  );
  const c = classifyRecord(record, BASE_OPTS);
  assert.equal(c.disposition, "stale-candidate");
  assert.equal(c.eligible, true);
  assert.equal(c.closeable, true);
  assert.equal(c.staleCandidate, true);
  assert.equal(c.closeCandidateReason, "stale_insufficient_info");
});

// ---------------------------------------------------------------------------
// Disposition: review
// ---------------------------------------------------------------------------

test('classifyRecord: recent open issue, no label filters → disposition "review", eligible=true, closeable=true, staleCandidate=false, closeCandidateReason="none"', () => {
  const record = mapWorkspaceItem(makeWorkspaceItem());
  const c = classifyRecord(record, BASE_OPTS);
  assert.equal(c.disposition, "review");
  assert.equal(c.eligible, true);
  assert.equal(c.closeable, true);
  assert.equal(c.staleCandidate, false);
  assert.equal(c.closeCandidateReason, "none");
});

// ---------------------------------------------------------------------------
// Precedence ordering
// ---------------------------------------------------------------------------

test('precedence: closed beats protected (closed state + protected label → "closed")', () => {
  const record = mapWorkspaceItem(
    makeWorkspaceItem({
      issue: makeIssue({ stateType: "completed", labels: makeLabels("Pinned") }),
    }),
  );
  const c = classifyRecord(record, { ...BASE_OPTS, protectedLabels: ["Pinned"] });
  assert.equal(c.disposition, "closed");
});

test('precedence: protected beats excluded (both labels present → "protected")', () => {
  const record = mapWorkspaceItem(
    makeWorkspaceItem({ issue: makeIssue({ labels: makeLabels("Pinned", "wont-fix") }) }),
  );
  const c = classifyRecord(record, {
    ...BASE_OPTS,
    protectedLabels: ["Pinned"],
    exclusionLabels: ["wont-fix"],
  });
  assert.equal(c.disposition, "protected");
});

test('precedence: protected beats stale (protected label + very old updatedAt → "protected", closeable=false)', () => {
  const record = mapWorkspaceItem(
    makeWorkspaceItem({
      issue: makeIssue({ updatedAt: "2023-01-01T00:00:00Z", labels: makeLabels("Pinned") }),
    }),
  );
  const c = classifyRecord(record, { ...BASE_OPTS, protectedLabels: ["Pinned"] });
  assert.equal(c.disposition, "protected");
  assert.equal(c.closeable, false);
});

test('precedence: excluded beats not-ready (exclusion label present but no required label → "excluded")', () => {
  const record = mapWorkspaceItem(
    makeWorkspaceItem({ issue: makeIssue({ labels: makeLabels("wont-fix") }) }),
  );
  const c = classifyRecord(record, {
    ...BASE_OPTS,
    exclusionLabels: ["wont-fix"],
    requiredLabels: ["triaged"],
  });
  assert.equal(c.disposition, "excluded");
});

test('precedence: excluded beats stale (exclusion label + old updatedAt → "excluded")', () => {
  const record = mapWorkspaceItem(
    makeWorkspaceItem({
      issue: makeIssue({ updatedAt: "2023-01-01T00:00:00Z", labels: makeLabels("wont-fix") }),
    }),
  );
  const c = classifyRecord(record, { ...BASE_OPTS, exclusionLabels: ["wont-fix"] });
  assert.equal(c.disposition, "excluded");
});

test('precedence: not-ready beats stale (no required label + old updatedAt → "not-ready")', () => {
  const record = mapWorkspaceItem(
    makeWorkspaceItem({
      issue: makeIssue({ updatedAt: "2023-01-01T00:00:00Z", labels: [] }),
    }),
  );
  const c = classifyRecord(record, { ...BASE_OPTS, requiredLabels: ["triaged"] });
  assert.equal(c.disposition, "not-ready");
});

// ---------------------------------------------------------------------------
// Options behavior
// ---------------------------------------------------------------------------

test("options: default staleDays=60; item ~90d old → stale-candidate", () => {
  // 90 days before 2024-09-01 = 2024-06-03
  const record = mapWorkspaceItem(
    makeWorkspaceItem({ issue: makeIssue({ updatedAt: "2024-06-03T00:00:00Z" }) }),
  );
  const c = classifyRecord(record, { nowIso: NOW_ISO });
  assert.equal(c.disposition, "stale-candidate");
});

test("options: default staleDays=60; item ~10d old → review", () => {
  // 10 days before 2024-09-01 = 2024-08-22
  const record = mapWorkspaceItem(
    makeWorkspaceItem({ issue: makeIssue({ updatedAt: "2024-08-22T00:00:00Z" }) }),
  );
  const c = classifyRecord(record, { nowIso: NOW_ISO });
  assert.equal(c.disposition, "review");
});

test("options: custom staleDays=30; item ~40d old → stale-candidate", () => {
  // 40 days before 2024-09-01 = 2024-07-23
  const record = mapWorkspaceItem(
    makeWorkspaceItem({ issue: makeIssue({ updatedAt: "2024-07-23T00:00:00Z" }) }),
  );
  const c = classifyRecord(record, { nowIso: NOW_ISO, staleDays: 30 });
  assert.equal(c.disposition, "stale-candidate");
});

test("options: custom staleDays=30; same item ~40d old with default 60d staleDays → review", () => {
  // 40 days before 2024-09-01 = 2024-07-23 — stale at 30d but NOT at 60d
  const record = mapWorkspaceItem(
    makeWorkspaceItem({ issue: makeIssue({ updatedAt: "2024-07-23T00:00:00Z" }) }),
  );
  const c = classifyRecord(record, { nowIso: NOW_ISO });
  assert.equal(c.disposition, "review");
});

test("options: boundary — exactly 60 days before NOW_ISO is NOT stale (strictly-greater-than semantics)", () => {
  // Exactly 60 days before 2024-09-01 = 2024-07-03
  const record = mapWorkspaceItem(
    makeWorkspaceItem({ issue: makeIssue({ updatedAt: "2024-07-03T00:00:00Z" }) }),
  );
  const c = classifyRecord(record, { nowIso: NOW_ISO });
  assert.equal(c.disposition, "review");
});

test("options: undefined/empty protectedLabels don't trigger protected branch", () => {
  const record = mapWorkspaceItem(
    makeWorkspaceItem({ issue: makeIssue({ labels: makeLabels("Pinned") }) }),
  );
  // No protectedLabels option → should not be protected
  const c = classifyRecord(record, BASE_OPTS);
  assert.notEqual(c.disposition, "protected");
});

test("options: undefined/empty exclusionLabels don't trigger excluded branch", () => {
  const record = mapWorkspaceItem(
    makeWorkspaceItem({ issue: makeIssue({ labels: makeLabels("wont-fix") }) }),
  );
  // No exclusionLabels option → should not be excluded
  const c = classifyRecord(record, BASE_OPTS);
  assert.notEqual(c.disposition, "excluded");
});

test("options: undefined/empty requiredLabels don't trigger not-ready branch", () => {
  const record = mapWorkspaceItem(makeWorkspaceItem({ issue: makeIssue({ labels: [] }) }));
  // No requiredLabels option → should not be not-ready
  const c = classifyRecord(record, BASE_OPTS);
  assert.notEqual(c.disposition, "not-ready");
});

test("options: label matching is case-insensitive (protectedLabels 'Pinned' matches record label 'pinned')", () => {
  const record = mapWorkspaceItem(
    makeWorkspaceItem({ issue: makeIssue({ labels: makeLabels("pinned") }) }),
  );
  const c = classifyRecord(record, { ...BASE_OPTS, protectedLabels: ["Pinned"] });
  assert.equal(c.disposition, "protected");
});

test("options: label matching is case-insensitive (protectedLabels 'pinned' matches record label 'Pinned')", () => {
  const record = mapWorkspaceItem(
    makeWorkspaceItem({ issue: makeIssue({ labels: makeLabels("Pinned") }) }),
  );
  const c = classifyRecord(record, { ...BASE_OPTS, protectedLabels: ["pinned"] });
  assert.equal(c.disposition, "protected");
});

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

const ALL_DISPOSITION_RECORDS: Array<[ReviewDisposition, () => LinearClassification]> = [
  [
    "closed",
    () =>
      classifyRecord(
        mapWorkspaceItem(makeWorkspaceItem({ issue: makeIssue({ stateType: "completed" }) })),
        BASE_OPTS,
      ),
  ],
  [
    "protected",
    () =>
      classifyRecord(
        mapWorkspaceItem(makeWorkspaceItem({ issue: makeIssue({ labels: makeLabels("Pinned") }) })),
        { ...BASE_OPTS, protectedLabels: ["Pinned"] },
      ),
  ],
  [
    "excluded",
    () =>
      classifyRecord(
        mapWorkspaceItem(
          makeWorkspaceItem({ issue: makeIssue({ labels: makeLabels("wont-fix") }) }),
        ),
        { ...BASE_OPTS, exclusionLabels: ["wont-fix"] },
      ),
  ],
  [
    "not-ready",
    () =>
      classifyRecord(mapWorkspaceItem(makeWorkspaceItem({ issue: makeIssue({ labels: [] }) })), {
        ...BASE_OPTS,
        requiredLabels: ["triaged"],
      }),
  ],
  [
    "stale-candidate",
    () =>
      classifyRecord(
        mapWorkspaceItem(
          makeWorkspaceItem({ issue: makeIssue({ updatedAt: "2024-06-03T00:00:00Z" }) }),
        ),
        BASE_OPTS,
      ),
  ],
  ["review", () => classifyRecord(mapWorkspaceItem(makeWorkspaceItem()), BASE_OPTS)],
];

test("invariant: reviewOnly === true for every disposition", () => {
  for (const [, make] of ALL_DISPOSITION_RECORDS) {
    const c = make();
    assert.equal(c.reviewOnly, true, `Expected reviewOnly=true for disposition ${c.disposition}`);
  }
});

test("invariant: reasons is a non-empty string array for every disposition", () => {
  for (const [, make] of ALL_DISPOSITION_RECORDS) {
    const c = make();
    assert.ok(
      Array.isArray(c.reasons),
      `reasons must be an array for disposition ${c.disposition}`,
    );
    assert.ok(c.reasons.length > 0, `reasons must be non-empty for disposition ${c.disposition}`);
    for (const r of c.reasons) {
      assert.equal(
        typeof r,
        "string",
        `each reason must be a string for disposition ${c.disposition}`,
      );
    }
  }
});

test("invariant: proposesClose returns false for a stale-candidate classification", () => {
  const record = mapWorkspaceItem(
    makeWorkspaceItem({ issue: makeIssue({ updatedAt: "2024-06-03T00:00:00Z" }) }),
  );
  const c = classifyRecord(record, BASE_OPTS);
  assert.equal(c.disposition, "stale-candidate");
  assert.equal(proposesClose(c), false);
});

test("invariant: proposesClose returns false for a review classification", () => {
  const record = mapWorkspaceItem(makeWorkspaceItem());
  const c = classifyRecord(record, BASE_OPTS);
  assert.equal(c.disposition, "review");
  assert.equal(proposesClose(c), false);
});

test("invariant: protected reason string includes the matched label name (original casing from record)", () => {
  // Record has "Pinned" (capital P); protectedLabels has lowercase "pinned"
  const record = mapWorkspaceItem(
    makeWorkspaceItem({ issue: makeIssue({ labels: makeLabels("Pinned") }) }),
  );
  const c = classifyRecord(record, { ...BASE_OPTS, protectedLabels: ["pinned"] });
  assert.equal(c.disposition, "protected");
  const hasLabel = c.reasons.some((r) => r.includes("Pinned"));
  assert.ok(
    hasLabel,
    `Expected reasons to include the label name "Pinned"; got: ${JSON.stringify(c.reasons)}`,
  );
});

// ---------------------------------------------------------------------------
// classifyRecords (batch)
// ---------------------------------------------------------------------------

test("classifyRecords: maps over an array, returns one classification per input in order", () => {
  const r1 = mapWorkspaceItem(
    makeWorkspaceItem({
      issue: makeIssue({ id: "a", identifier: "ENG-1", stateType: "completed" }),
    }),
  );
  const r2 = mapWorkspaceItem(
    makeWorkspaceItem({ issue: makeIssue({ id: "b", identifier: "ENG-2" }) }),
  );
  const results = classifyRecords([r1, r2], BASE_OPTS);
  assert.equal(results.length, 2);
  assert.equal(results[0].disposition, "closed");
  assert.equal(results[0].key, "ENG-1");
  assert.equal(results[1].disposition, "review");
  assert.equal(results[1].key, "ENG-2");
});

test("classifyRecords: empty array → empty array", () => {
  const results = classifyRecords([], BASE_OPTS);
  assert.deepEqual(results, []);
});

// ---------------------------------------------------------------------------
// Re-exports (barrel wiring)
// ---------------------------------------------------------------------------

test("re-export: classifyRecord from dist/linear/index.js is callable and behaves identically", () => {
  const record = mapWorkspaceItem(makeWorkspaceItem());
  const fromClassifier = classifyRecord(record, BASE_OPTS);
  const fromIndex = classifyRecordFromIndex(record, BASE_OPTS);
  assert.equal(fromIndex.disposition, fromClassifier.disposition);
  assert.equal(fromIndex.key, fromClassifier.key);
  assert.equal(fromIndex.reviewOnly, true);
});

// ---------------------------------------------------------------------------
// Validation guard
// ---------------------------------------------------------------------------

test("classifyRecord: malformed record (empty key) throws via assertLinearReviewRecord", () => {
  const valid = mapWorkspaceItem(makeWorkspaceItem());
  const broken = { ...valid, key: "" };
  assert.throws(() => classifyRecord(broken as typeof valid, BASE_OPTS), /key/);
});

test("classifyRecord rejects invalid staleness timestamps", () => {
  const record = mapWorkspaceItem(makeWorkspaceItem());
  assert.throws(
    () => classifyRecord(record, { ...BASE_OPTS, nowIso: "not-a-date" }),
    /invalid nowIso timestamp/,
  );
  assert.throws(
    () => classifyRecord({ ...record, updatedAt: "not-a-date" }, BASE_OPTS),
    /invalid updatedAt timestamp/,
  );
});
