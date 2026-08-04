import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregate,
  assertCompatibleWriteModes,
  buildScopeSpec,
  fetchWorkspaceLabels,
  loadApprovals,
  parseArgs,
  readBackPlannedComment,
  reportExitCode,
  resolveReportMode,
  summarizeItem,
} from "../scripts/linear-review-apply.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

test("comment and label live modes require separate reviewed runs", () => {
  assert.throws(
    () => assertCompatibleWriteModes({ live: true }, { live: true }),
    /separate reviewed runs/,
  );
  assert.doesNotThrow(() => assertCompatibleWriteModes({ live: true }, { live: false }));
});

test("resolveReportMode reports a label-only mutation as live", () => {
  assert.deepEqual(
    resolveReportMode(
      { live: false, reason: "comment dry-run" },
      { live: true, reason: "label apply" },
    ),
    { live: true, reason: "label apply" },
  );
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test("parseArgs collects repeatable + comma identifiers and scope flags", () => {
  const opts = parseArgs([
    "--identifier",
    "PAR-1",
    "--identifier",
    "PAR-2",
    "--identifiers",
    "PAR-3, PAR-4",
    "--project",
    "Command Central",
  ]);
  assert.deepEqual(opts.identifiers, ["PAR-1", "PAR-2", "PAR-3", "PAR-4"]);
  assert.equal(opts.project, "Command Central");
  assert.equal(opts.apply, false); // dry-run default
});

test("parseArgs reads apply/limit/rate/concurrency and rejects unknown flags", () => {
  const opts = parseArgs(["--team", "PAR", "--apply", "--limit", "5", "--rate-ms", "400"]);
  assert.equal(opts.team, "PAR");
  assert.equal(opts.apply, true);
  assert.equal(opts.limit, 5);
  assert.equal(opts.rateMs, 400);
  assert.throws(() => parseArgs(["--nonsense"]), /unknown argument: --nonsense/);
  assert.throws(() => parseArgs(["--limit", "0"]), /--limit must be a positive integer/);
});

// ---------------------------------------------------------------------------
// buildScopeSpec (with injected readFileSync)
// ---------------------------------------------------------------------------

const LEDGER_JSON = JSON.stringify({
  project: "Command Central",
  order: [
    { identifier: "PAR-226", blocks_active: ["PAR-228", "PAR-227"] },
    { identifier: "PAR-100" },
  ],
  linear_done: ["PAR-154", "PAR-189"],
});

test("buildScopeSpec extracts a ledger's order list into an identifiers scope", () => {
  const opts = parseArgs(["--from-file", "ledger.json"]);
  const spec = buildScopeSpec(opts, { readFileSync: () => LEDGER_JSON });
  assert.deepEqual(spec, { kind: "identifiers", identifiers: ["PAR-226", "PAR-100"] });
});

test("buildScopeSpec honors --list-field", () => {
  const opts = parseArgs(["--from-file", "ledger.json", "--list-field", "linear_done"]);
  const spec = buildScopeSpec(opts, { readFileSync: () => LEDGER_JSON });
  assert.deepEqual(spec, { kind: "identifiers", identifiers: ["PAR-154", "PAR-189"] });
});

test("buildScopeSpec merges explicit --identifier with --from-file", () => {
  const opts = parseArgs(["--identifier", "PAR-9", "--from-file", "ledger.json"]);
  const spec = buildScopeSpec(opts, { readFileSync: () => LEDGER_JSON });
  assert.deepEqual(spec.identifiers, ["PAR-9", "PAR-226", "PAR-100"]);
});

test("buildScopeSpec throws when a ledger yields no identifiers", () => {
  const opts = parseArgs(["--from-file", "empty.json"]);
  assert.throws(
    () => buildScopeSpec(opts, { readFileSync: () => JSON.stringify({ order: [] }) }),
    /yielded no Linear identifiers/,
  );
});

test("buildScopeSpec surfaces a project/team scope unchanged", () => {
  assert.deepEqual(buildScopeSpec(parseArgs(["--project", "CC"])), {
    kind: "project",
    project: "CC",
  });
  assert.deepEqual(buildScopeSpec(parseArgs(["--team", "par"])), { kind: "team", teamKey: "PAR" });
});

// ---------------------------------------------------------------------------
// loadApprovals
// ---------------------------------------------------------------------------

test("loadApprovals builds a map from a reviewed dry-run report", () => {
  const report = {
    items: [
      {
        identifier: "PAR-1",
        planHash: HASH_A,
        snapshotHash: HASH_B,
        labelReceipt: { planHash: HASH_B, snapshotHash: HASH_A },
        nowIso: "2026-06-24T00:00:00Z",
      },
      { identifier: "par-2", planHash: HASH_B, snapshotHash: HASH_A },
    ],
  };
  const map = loadApprovals(report);
  assert.equal(map.size, 2);
  assert.deepEqual(map.get("PAR-1"), {
    approvedPlanHash: HASH_A,
    approvedSnapshotHash: HASH_B,
    approvedLabelPlanHash: HASH_B,
    approvedLabelSnapshotHash: HASH_A,
    nowIso: "2026-06-24T00:00:00Z",
    source: "approvals-file",
  });
  assert.equal(map.get("PAR-2")?.approvedSnapshotHash, HASH_A); // canonicalized key
});

test("loadApprovals reads hashes nested under receipt and skips incomplete entries", () => {
  const list = [
    { identifier: "PAR-1", receipt: { planHash: HASH_A, snapshotHash: HASH_B } },
    { identifier: "PAR-2", planHash: HASH_A }, // missing snapshotHash → skipped
    { nope: true }, // no identifier → skipped
  ];
  const map = loadApprovals(list);
  assert.deepEqual([...map.keys()], ["PAR-1"]);
});

test("loadApprovals keeps comment and label approvals independent", () => {
  const map = loadApprovals([
    {
      identifier: "PAR-1",
      receipt: { planHash: HASH_A, snapshotHash: HASH_B },
      labelReceipt: { planHash: HASH_B, snapshotHash: HASH_A },
    },
    {
      identifier: "PAR-2",
      planHash: HASH_A,
      snapshotHash: HASH_B,
      labelReceipt: { planHash: HASH_B },
    },
    {
      identifier: "PAR-3",
      labelReceipt: { planHash: HASH_A, snapshotHash: HASH_B },
    },
  ]);
  assert.equal(map.get("PAR-1")?.approvedLabelPlanHash, HASH_B);
  assert.equal(map.get("PAR-2")?.approvedLabelPlanHash, undefined);
  assert.equal(map.get("PAR-3")?.approvedPlanHash, undefined);
  assert.equal(map.get("PAR-3")?.approvedLabelSnapshotHash, HASH_B);
});

test("loadApprovals rejects a malformed hash", () => {
  assert.throws(
    () => loadApprovals([{ identifier: "PAR-1", planHash: "short", snapshotHash: HASH_B }]),
    /must be a 64-character sha256 hex hash/,
  );
});

// ---------------------------------------------------------------------------
// summarizeItem + aggregate
// ---------------------------------------------------------------------------

function fakeResult(overrides = {}) {
  return {
    record: {
      identifier: "PAR-1",
      snapshotHash: HASH_B,
      itemCategory: "bug",
      triagePriority: "P2",
      labels: [],
    },
    classification: { disposition: "review", eligible: true, staleCandidate: false },
    plan: { action: "create", planHash: HASH_A },
    expectedAuthorId: "actor-1",
    authorization: { allowed: true },
    receipt: { kind: "comment-upsert", key: "PAR-1", allowed: true },
    nowIso: "2026-06-24T00:00:00Z",
    ...overrides,
  };
}

test("summarizeItem carries re-feedable fingerprints and separates actionable/authorized", () => {
  const s = summarizeItem(fakeResult(), { reason: "live write authorized" });
  assert.equal(s.identifier, "PAR-1");
  assert.equal(s.actionable, true); // eligible + not noop (intrinsic)
  assert.equal(s.authorized, true); // approval gate passed
  assert.equal(s.wouldWrite, true); // actionable AND authorized
  assert.equal(s.planHash, HASH_A);
  assert.equal(s.snapshotHash, HASH_B);
  assert.equal(s.nowIso, "2026-06-24T00:00:00Z");
});

test("summarizeItem: actionable but not authorized (plain dry-run) → wouldWrite=false", () => {
  // The common dry-run case: a real comment to post, but no operator approval yet.
  const result = fakeResult({ authorization: { allowed: false } });
  const s = summarizeItem(result, { reason: "dry-run" });
  assert.equal(s.actionable, true);
  assert.equal(s.authorized, false);
  assert.equal(s.wouldWrite, false);
});

test("summarizeItem: missing app actor id cannot advertise a live write", () => {
  const s = summarizeItem(fakeResult({ expectedAuthorId: "" }), { reason: "dry-run" });
  assert.equal(s.actionable, true);
  assert.equal(s.authorized, true);
  assert.equal(s.wouldWrite, false);
});

test("summarizeItem: human-review protection is not actionable or writable", () => {
  const result = fakeResult({
    record: {
      ...fakeResult().record,
      labels: ["clawsweeper:human-review"],
    },
  });
  const summary = summarizeItem(result, { reason: "dry-run" });
  assert.equal(summary.actionable, false);
  assert.equal(summary.authorized, true);
  assert.equal(summary.wouldWrite, false);
});

test("readBackPlannedComment forwards the expected app actor id", async () => {
  const result = fakeResult({
    plan: {
      action: "create",
      planHash: HASH_A,
      marker: "<!-- m -->",
      body: "<!-- m -->\n\nreview",
      targetCommentId: null,
    },
  });
  const source = {
    fetchIssueByIdentifier: async () => ({
      comments: [{ id: "c1", body: result.plan.body, authorId: "actor-1" }],
    }),
  };
  const readback = await readBackPlannedComment(source, "PAR-1", result);
  assert.equal(readback.confirmed, true);
  assert.equal(readback.authorMatches, true);
});

test("summarizeItem reports actionable=false for an ineligible/noop item", () => {
  const result = fakeResult({
    classification: { disposition: "closed", eligible: false },
    plan: { action: "noop", planHash: HASH_A },
  });
  const s = summarizeItem(result, { reason: "skipped" });
  assert.equal(s.actionable, false);
  assert.equal(s.wouldWrite, false);
  assert.equal(s.eligible, false);
});

test("aggregate tallies dispositions, intent, outcomes, and errors", () => {
  const items = [
    // applied (authorized + actionable + written)
    {
      identifier: "PAR-1",
      disposition: "review",
      eligible: true,
      actionable: true,
      authorized: true,
      wouldWrite: true,
      applied: true,
    },
    // ineligible — skipped
    {
      identifier: "PAR-2",
      disposition: "closed",
      eligible: false,
      actionable: false,
      authorized: false,
      wouldWrite: false,
      applied: false,
    },
    // actionable but not yet authorized (plain dry-run item)
    {
      identifier: "PAR-3",
      disposition: "review",
      eligible: true,
      actionable: true,
      authorized: false,
      wouldWrite: false,
      applied: false,
    },
    { identifier: "PAR-4", error: "boom" },
  ];
  const resolution = {
    kind: "project",
    identifiers: ["PAR-1", "PAR-2", "PAR-3", "PAR-4"],
    matchedProjects: [],
  };
  const report = aggregate(items, resolution, { live: true, reason: "apply" });
  assert.equal(report.mode, "apply");
  assert.equal(report.counts.total, 4);
  assert.equal(report.counts.eligible, 2);
  assert.equal(report.counts.actionable, 2);
  assert.equal(report.counts.authorized, 1);
  assert.equal(report.counts.wouldWrite, 1);
  assert.equal(report.counts.applied, 1);
  assert.equal(report.counts.errors, 1);
  assert.deepEqual(report.counts.byDisposition, { review: 2, closed: 1 });
  assert.equal(reportExitCode(report), 1);
});

test("reportExitCode returns zero for an error-free report", () => {
  assert.equal(reportExitCode({ counts: { errors: 0 } }), 0);
});

test("fetchWorkspaceLabels fails closed when hasNextPage omits its cursor", async () => {
  const transport = async () => ({
    issueLabels: {
      nodes: [{ id: "label-1", name: "Label One" }],
      pageInfo: { hasNextPage: true, endCursor: null },
    },
  });
  await assert.rejects(
    () => fetchWorkspaceLabels(transport),
    /hasNextPage without a usable endCursor/,
  );
});

test("fetchWorkspaceLabels fails closed on a cursor cycle", async () => {
  const cursors = ["cursor-a", "cursor-b", "cursor-a"];
  let index = 0;
  const transport = async () => ({
    issueLabels: {
      nodes: [{ id: `label-${index}`, name: `Label ${index}` }],
      pageInfo: { hasNextPage: true, endCursor: cursors[index++] },
    },
  });
  await assert.rejects(() => fetchWorkspaceLabels(transport), /repeated endCursor "cursor-a"/);
});

test("fetchWorkspaceLabels rejects malformed pageInfo instead of accepting a partial list", async () => {
  const transport = async () => ({
    issueLabels: { nodes: [{ id: "label-1", name: "Label One" }], pageInfo: "bad" },
  });
  await assert.rejects(() => fetchWorkspaceLabels(transport), /malformed connection/);
});
