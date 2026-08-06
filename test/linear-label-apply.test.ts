import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeMutation,
  classifyRecord,
  evaluateReviewPolicy,
  LABEL_NEEDS_INFO,
  LABEL_NEEDS_MAINTAINER_REVIEW,
  resolveGates,
  mapWorkspaceItem,
} from "../dist/linear/index.js";
import {
  applyLabelChange,
  applyLabelStep,
  authorizeLabelChange,
  parseArgs,
  planLabelChange,
  resolveLabelIds,
  resolveLabelWriteMode,
} from "../scripts/linear-review-apply.mjs";

const HASH = "c".repeat(64);

function fakeRecord(overrides = {}) {
  return {
    id: "issue-uuid-1",
    key: "PAR-1",
    identifier: "PAR-1",
    snapshotHash: HASH,
    labels: [],
    ...overrides,
  };
}

// A decision is { proposedLabels } — the only field planLabelChange reads.
function decision(proposedLabels) {
  return { proposedLabels };
}

// ---------------------------------------------------------------------------
// parseArgs --apply-labels
// ---------------------------------------------------------------------------

test("parseArgs collects --apply-labels (default false) and --dry-run clears it", () => {
  assert.equal(parseArgs(["--team", "PAR"]).applyLabels, false);
  assert.equal(parseArgs(["--team", "PAR", "--apply-labels"]).applyLabels, true);
  // --dry-run is the kill switch for both write opt-ins.
  const opts = parseArgs(["--team", "PAR", "--apply", "--apply-labels", "--dry-run"]);
  assert.equal(opts.apply, false);
  assert.equal(opts.applyLabels, false);
});

// ---------------------------------------------------------------------------
// resolveLabelWriteMode — the gate stays closed without BOTH signals
// ---------------------------------------------------------------------------

test("resolveLabelWriteMode keeps live replace-all label mutation disabled", () => {
  assert.equal(resolveLabelWriteMode({ applyLabels: false }, {}).live, false);
  // flag without env → dry
  assert.equal(resolveLabelWriteMode({ applyLabels: true }, {}).live, false);
  assert.equal(
    resolveLabelWriteMode({ applyLabels: true }, { OPENCLAW_NOTIFY_LINEAR: "0" }).live,
    false,
  );
  // env without flag → dry
  assert.equal(
    resolveLabelWriteMode({ applyLabels: false }, { OPENCLAW_NOTIFY_LINEAR: "1" }).live,
    false,
  );
  // Both opt-ins still cannot make a replace-all API atomic with concurrent label additions.
  const enabled = resolveLabelWriteMode({ applyLabels: true }, { OPENCLAW_NOTIFY_LINEAR: "1" });
  assert.equal(enabled.live, false);
  assert.match(enabled.reason, /disabled.*replace-all.*concurrent/i);
});

// ---------------------------------------------------------------------------
// planLabelChange — reconciles owned routing labels, preserves everything else
// ---------------------------------------------------------------------------

test("planLabelChange adds a routing label on an empty issue", () => {
  const change = planLabelChange(fakeRecord({ labels: [] }), decision([LABEL_NEEDS_INFO]));
  assert.deepEqual(change.existing, []);
  assert.deepEqual(change.removals, []);
  assert.deepEqual(change.additions, [LABEL_NEEDS_INFO]);
  assert.deepEqual(change.proposed, [LABEL_NEEDS_INFO]);
  assert.equal(change.noop, false);
});

test("planLabelChange is a noop when the proposed label is already present (case-insensitive, idempotent re-run)", () => {
  const change = planLabelChange(
    fakeRecord({ labels: ["ClawSweeper:Needs-Info"] }),
    decision([LABEL_NEEDS_INFO]),
  );
  assert.deepEqual(change.additions, []);
  assert.deepEqual(change.removals, []);
  assert.equal(change.noop, true);
  // proposed preserves the existing casing — no label churn.
  assert.deepEqual(change.proposed, ["ClawSweeper:Needs-Info"]);
});

test("planLabelChange additively preserves old routing, protected, and project labels", () => {
  const existing = ["area/core", LABEL_NEEDS_INFO, "clawsweeper:human-review"];
  const change = planLabelChange(
    fakeRecord({ labels: existing }),
    decision([LABEL_NEEDS_MAINTAINER_REVIEW]),
  );
  assert.deepEqual(change.removals, []);
  assert.deepEqual(change.additions, [LABEL_NEEDS_MAINTAINER_REVIEW]);
  for (const l of [
    "area/core",
    LABEL_NEEDS_INFO,
    "clawsweeper:human-review",
    LABEL_NEEDS_MAINTAINER_REVIEW,
  ]) {
    assert.ok(change.proposed.includes(l));
  }
});

test("planLabelChange asserts the protected-action denylist (defense in depth)", () => {
  assert.throws(
    () => planLabelChange(fakeRecord(), decision(["clawsweeper:autofix"])),
    /protected action label/,
  );
  assert.throws(
    () => planLabelChange(fakeRecord(), decision(["proof:done"])),
    /protected action label/,
  );
});

// ---------------------------------------------------------------------------
// resolveLabelIds — finds-on-issue / finds-in-workspace / creates-missing
// ---------------------------------------------------------------------------

test("resolveLabelIds finds an id already on the issue without creating", async () => {
  let created = 0;
  const out = await resolveLabelIds(["clawsweeper:needs-info"], {
    issueLabelsOnIssue: [{ id: "L-onissue", name: "clawsweeper:needs-info" }],
    workspaceLabels: [{ id: "L-ws", name: "clawsweeper:needs-info" }],
    createLabel: async () => {
      created += 1;
      return { id: "nope", name: "nope" };
    },
  });
  assert.deepEqual(out.ids, ["L-onissue"]); // on-issue wins over workspace
  assert.deepEqual(out.createdNames, []);
  assert.equal(created, 0);
});

test("resolveLabelIds finds an id in the workspace (case-insensitive) without creating", async () => {
  const out = await resolveLabelIds(["clawsweeper:needs-info"], {
    issueLabelsOnIssue: [],
    workspaceLabels: [{ id: "L-ws", name: "ClawSweeper:Needs-Info" }],
    createLabel: async () => {
      throw new Error("should not create");
    },
  });
  assert.deepEqual(out.ids, ["L-ws"]);
  assert.deepEqual(out.createdNames, []);
});

test("resolveLabelIds CREATES a missing label via the stub and records it", async () => {
  const out = await resolveLabelIds(["existing", "clawsweeper:not-repro-on-main"], {
    issueLabelsOnIssue: [],
    workspaceLabels: [{ id: "L-existing", name: "existing" }],
    createLabel: async (name) => ({ id: `L-new-${name}`, name }),
  });
  assert.deepEqual(out.ids, ["L-existing", "L-new-clawsweeper:not-repro-on-main"]);
  assert.deepEqual(out.createdNames, ["clawsweeper:not-repro-on-main"]);
});

test("resolveLabelIds is deterministic: same inputs + stub yield the same ids", async () => {
  const opts = {
    issueLabelsOnIssue: [],
    workspaceLabels: [{ id: "L-a", name: "a" }],
    createLabel: async (name) => ({ id: `L-${name}`, name }),
  };
  const a = await resolveLabelIds(["a", "b"], opts);
  const b = await resolveLabelIds(["a", "b"], opts);
  assert.deepEqual(a.ids, b.ids);
});

// ---------------------------------------------------------------------------
// authorizeLabelChange — additive union allowed; a drop is denied
// ---------------------------------------------------------------------------

test("authorizeLabelChange requires an independently reviewed label approval", () => {
  const record = fakeRecord({ labels: ["keep"] });
  const change = planLabelChange(record, decision(["clawsweeper:needs-info"]));
  const dry = authorizeLabelChange(record, change);
  assert.equal(dry.authorization.allowed, false);
  assert.ok(dry.authorization.reasons.some((reason) => /plan hash mismatch/.test(reason)));

  const { authorization, receipt } = authorizeLabelChange(record, change, {
    approvedLabelPlanHash: dry.receipt.planHash,
    approvedLabelSnapshotHash: dry.receipt.snapshotHash,
  });
  assert.equal(authorization.allowed, true);
  assert.equal(authorization.kind, "label-add");
  assert.equal(receipt.gate, "labelWrite");
  assert.equal(receipt.driftDetected, false);
});

test("authorizeLabelChange rejects stale snapshots and changed label plans", () => {
  const record = fakeRecord({ labels: ["keep"] });
  const original = planLabelChange(record, decision([LABEL_NEEDS_INFO]));
  const dry = authorizeLabelChange(record, original);

  const stale = authorizeLabelChange(record, original, {
    approvedLabelPlanHash: dry.receipt.planHash,
    approvedLabelSnapshotHash: "d".repeat(64),
  });
  assert.equal(stale.authorization.allowed, false);
  assert.equal(stale.receipt.driftDetected, true);

  const changed = planLabelChange(record, decision([LABEL_NEEDS_MAINTAINER_REVIEW]));
  const changedAuth = authorizeLabelChange(record, changed, {
    approvedLabelPlanHash: dry.receipt.planHash,
    approvedLabelSnapshotHash: dry.receipt.snapshotHash,
  });
  assert.equal(changedAuth.authorization.allowed, false);
  assert.ok(changedAuth.authorization.reasons.some((reason) => /plan hash mismatch/.test(reason)));
});

test("authority DENIES a label-add that would DROP an existing label without declaring a removal", () => {
  // Hand-craft a request whose proposed set drops "keep" — authority must reject it.
  const request = {
    kind: "label-add",
    key: "PAR-1",
    snapshotHash: HASH,
    planHash: HASH,
    labelChange: {
      existing: ["keep", "also-keep"],
      additions: ["clawsweeper:needs-info"],
      proposed: ["clawsweeper:needs-info"], // dropped both existing labels
    },
  };
  const auth = authorizeMutation(request, resolveGates({ labelWrite: true }), {
    liveSnapshotHash: HASH,
    approvedPlanHash: HASH,
  });
  assert.equal(auth.allowed, false);
  assert.ok(auth.reasons.some((r) => /would remove existing labels/.test(r)));
});

test("authority allows declared safe label removals when proposed equals existing minus removals plus additions", () => {
  const request = {
    kind: "label-add",
    key: "PAR-1",
    snapshotHash: HASH,
    planHash: HASH,
    labelChange: {
      existing: [LABEL_NEEDS_INFO, "team:x"],
      removals: [LABEL_NEEDS_INFO],
      additions: [LABEL_NEEDS_MAINTAINER_REVIEW],
      proposed: ["team:x", LABEL_NEEDS_MAINTAINER_REVIEW],
    },
  };
  const auth = authorizeMutation(request, resolveGates({ labelWrite: true }), {
    liveSnapshotHash: HASH,
    approvedPlanHash: HASH,
  });
  assert.equal(auth.allowed, true);
});

test("authority DENIES a label-add when the labelWrite gate is closed (review-only default)", () => {
  const record = fakeRecord({ labels: ["keep"] });
  const change = planLabelChange(record, decision(["clawsweeper:needs-info"]));
  const planHash = authorizeLabelChange(record, change).receipt.planHash;
  const auth = authorizeMutation(
    {
      kind: "label-add",
      key: "PAR-1",
      snapshotHash: HASH,
      planHash,
      labelChange: change,
    },
    resolveGates({}), // gate closed
    { liveSnapshotHash: HASH, approvedPlanHash: planHash },
  );
  assert.equal(auth.allowed, false);
  assert.ok(auth.reasons.some((r) => /gate "labelWrite" is closed/.test(r)));
});

// ---------------------------------------------------------------------------
// Idempotent re-run — a noop change yields no additions and authority rejects it
// ---------------------------------------------------------------------------

test("idempotent re-run: a noop change has no additions (and authority would reject a no-op write)", () => {
  const record = fakeRecord({ labels: ["clawsweeper:needs-info"] });
  const change = planLabelChange(record, decision(["clawsweeper:needs-info"]));
  assert.equal(change.noop, true);
  assert.deepEqual(change.additions, []);
  // authority itself rejects a write with zero additions — belt and suspenders.
  const dry = authorizeLabelChange(record, change);
  const { authorization } = authorizeLabelChange(record, change, {
    approvedLabelPlanHash: dry.receipt.planHash,
    approvedLabelSnapshotHash: dry.receipt.snapshotHash,
  });
  assert.equal(authorization.allowed, false);
  assert.ok(authorization.reasons.some((r) => /no additions/.test(r)));
});

// ---------------------------------------------------------------------------
// applyLabelChange — end-to-end orchestration over a RECORDING fake transport.
// Exercises the REAL fetchWorkspaceLabels (NOT stubbed) so a missing import /
// wrong mutation shape is caught here, not in a live POC.
// ---------------------------------------------------------------------------

function recordingTransport(workspaceNodes = []) {
  const calls = [];
  let seq = 0;
  const transport = async (query, vars) => {
    calls.push({ query, vars });
    if (query.includes("issueLabels(")) {
      return {
        issueLabels: { nodes: workspaceNodes, pageInfo: { hasNextPage: false, endCursor: null } },
      };
    }
    if (query.includes("issueLabelCreate")) {
      seq += 1;
      return {
        issueLabelCreate: { success: true, issueLabel: { id: `new-${seq}`, name: vars.name } },
      };
    }
    if (query.includes("issueUpdate")) {
      return { issueUpdate: { success: true, issue: { id: vars.id, labels: { nodes: [] } } } };
    }
    throw new Error(`unexpected query: ${query.slice(0, 40)}`);
  };
  return { transport, calls };
}

test("applyLabelChange CREATES a missing label then writes the union (real fetch path)", async () => {
  const record = fakeRecord({ labels: [] });
  const change = planLabelChange(record, decision(["clawsweeper:needs-maintainer-review"]));
  const { transport, calls } = recordingTransport([]); // empty workspace → must create
  const result = await applyLabelChange(record, change, transport);

  assert.equal(result.labelAction, "create");
  assert.deepEqual(result.labelsCreated, ["clawsweeper:needs-maintainer-review"]);
  // the real ISSUE_LABELS_QUERY fetch ran (this is what the missing-import regression hit)
  assert.ok(
    calls.some((c) => c.query.includes("issueLabels(")),
    "did not fetch workspace labels",
  );
  assert.ok(
    calls.some((c) => c.query.includes("issueLabelCreate")),
    "did not create the label",
  );
  const setCall = calls.find((c) => c.query.includes("issueUpdate"));
  assert.ok(setCall, "did not write labels");
  assert.deepEqual(setCall.vars, { id: "issue-uuid-1", labelIds: ["new-1"] });
});

test("applyLabelChange reuses an EXISTING workspace label (no create)", async () => {
  const record = fakeRecord({ labels: [] });
  const change = planLabelChange(record, decision(["clawsweeper:needs-maintainer-review"]));
  const { transport, calls } = recordingTransport([
    { id: "ws-1", name: "clawsweeper:needs-maintainer-review" },
  ]);
  const result = await applyLabelChange(record, change, transport);

  assert.equal(result.labelAction, "add");
  assert.deepEqual(result.labelsCreated, []);
  assert.ok(!calls.some((c) => c.query.includes("issueLabelCreate")), "should not create");
  const setCall = calls.find((c) => c.query.includes("issueUpdate"));
  assert.deepEqual(setCall.vars, { id: "issue-uuid-1", labelIds: ["ws-1"] });
});

test("applyLabelChange rejects an issueUpdate payload that reports failure", async () => {
  const record = fakeRecord({ labels: [] });
  const change = planLabelChange(record, decision(["clawsweeper:needs-maintainer-review"]));
  const { transport: baseTransport } = recordingTransport([
    { id: "ws-1", name: "clawsweeper:needs-maintainer-review" },
  ]);
  const transport = async (query, vars) => {
    if (query.includes("issueUpdate")) return { issueUpdate: { success: false } };
    return baseTransport(query, vars);
  };

  await assert.rejects(applyLabelChange(record, change, transport), /label update failed/);
});

test("applyLabelChange rejects a read-back that does not contain the proposed labels", async () => {
  const record = fakeRecord({ labels: [] });
  const change = planLabelChange(record, decision(["clawsweeper:needs-maintainer-review"]));
  const { transport } = recordingTransport([
    { id: "ws-1", name: "clawsweeper:needs-maintainer-review" },
  ]);

  await assert.rejects(
    applyLabelChange(record, change, transport, {
      readBackIssue: async () => hydratedItem([]),
    }),
    /label update read-back failed/,
  );
});

test("applyLabelChange blocks a concurrent label addition before replace-all update", async () => {
  const record = fakeRecord({ labels: ["team:backend"] });
  const change = planLabelChange(record, decision(["clawsweeper:needs-maintainer-review"]));
  const { transport, calls } = recordingTransport([]);

  await assert.rejects(
    applyLabelChange(record, change, transport, {
      issueLabelsOnIssue: [{ id: "team-id", name: "team:backend" }],
      readBackIssue: async () =>
        hydratedItem([
          { id: "team-id", name: "team:backend" },
          { id: "late-id", name: "team:late" },
        ]),
    }),
    /label drift before update/,
  );
  assert.equal(
    calls.some((call) => call.query.includes("issueUpdate")),
    false,
  );
  assert.equal(
    calls.some((call) => call.query.includes("issueLabelCreate")),
    false,
  );
});

test("applyLabelChange writes the UNION — preserves existing issue label ids, never drops", async () => {
  const record = fakeRecord({ labels: ["team:backend"] });
  const change = planLabelChange(record, decision(["clawsweeper:needs-maintainer-review"]));
  // existing label already on the issue (with its id); routing label is new → created
  const { transport, calls } = recordingTransport([]);
  const result = await applyLabelChange(record, change, transport, {
    issueLabelsOnIssue: [{ id: "il-9", name: "team:backend" }],
  });

  const setCall = calls.find((c) => c.query.includes("issueUpdate"));
  // union: existing id kept + newly created id; existing label never dropped
  assert.deepEqual(setCall.vars.labelIds, ["il-9", "new-1"]);
  assert.deepEqual(result.labelsApplied, ["clawsweeper:needs-maintainer-review"]);
});

function hydratedItem(labels = [], updatedAt = "2026-06-24T00:00:00Z") {
  return {
    team: { id: "team-1", key: "PAR", name: "Partner" },
    project: null,
    issue: {
      id: "issue-uuid-1",
      identifier: "PAR-1",
      title: "Bug report",
      url: "https://linear.app/issue/PAR-1",
      createdAt: "2026-06-23T00:00:00Z",
      updatedAt,
      teamId: "team-1",
      projectId: null,
      stateId: "todo",
      stateName: "Todo",
      stateType: "unstarted",
      priority: 2,
      labels,
    },
    comments: [],
    description: "",
    attachments: [],
    creator: null,
  };
}

test("applyLabelStep never requests a transport or refetches for an apply-intent label plan", async () => {
  const initial = hydratedItem([]);
  const refreshed = hydratedItem([{ id: "late-id", name: "team:late" }]);
  const liveRecord = mapWorkspaceItem(refreshed);
  const liveClassification = classifyRecord(liveRecord, {
    nowIso: "2026-06-25T00:00:00Z",
  });
  const liveChange = planLabelChange(
    liveRecord,
    evaluateReviewPolicy(liveClassification, liveRecord),
  );
  const dry = authorizeLabelChange(liveRecord, liveChange);
  const approval = {
    approvedLabelPlanHash: dry.receipt.planHash,
    approvedLabelSnapshotHash: dry.receipt.snapshotHash,
  };
  const initialRecord = mapWorkspaceItem(initial);
  const entry = {
    identifier: "PAR-1",
    result: {
      hydrated: initial,
      record: initialRecord,
      classification: classifyRecord(initialRecord, { nowIso: "2026-06-25T00:00:00Z" }),
      nowIso: "2026-06-25T00:00:00Z",
    },
  };
  const { transport, calls } = recordingTransport([
    { id: "routing-id", name: liveChange.additions[0] },
  ]);
  const applied = hydratedItem([
    { id: "late-id", name: "team:late" },
    { id: "routing-id", name: liveChange.additions[0] },
  ]);
  let fetches = 0;
  const summary = {};

  await applyLabelStep(entry, summary, { live: true, reason: "live" }, async () => transport, {
    source: {
      fetchIssueByIdentifier: async () => {
        fetches += 1;
        return fetches <= 3 ? refreshed : applied;
      },
    },
    options: {
      staleDays: 60,
      requiredLabels: [],
      exclusionLabels: [],
      protectedLabels: [],
    },
    approval,
  });

  assert.equal(fetches, 0);
  assert.equal(summary.labelApplyError, undefined);
  const setCall = calls.find((call) => call.query.includes("issueUpdate"));
  assert.equal(setCall, undefined);
  assert.equal(summary.labelWouldWrite, false);
});

test("applyLabelStep keeps an authorized label proposal planning-only", async () => {
  const initial = hydratedItem([]);
  const initialRecord = mapWorkspaceItem(initial);
  const initialClassification = classifyRecord(initialRecord, {
    nowIso: "2026-06-25T00:00:00Z",
  });
  const originalChange = planLabelChange(
    initialRecord,
    evaluateReviewPolicy(initialClassification, initialRecord),
  );
  const dry = authorizeLabelChange(initialRecord, originalChange);
  const refreshed = hydratedItem([{ id: "late-id", name: "team:late" }]);
  let transportRequested = false;
  const summary = {};

  await applyLabelStep(
    {
      identifier: "PAR-1",
      result: {
        hydrated: initial,
        record: initialRecord,
        classification: initialClassification,
        nowIso: "2026-06-25T00:00:00Z",
      },
    },
    summary,
    { live: true, reason: "live" },
    async () => {
      transportRequested = true;
      throw new Error("must not request write transport");
    },
    {
      source: { fetchIssueByIdentifier: async () => refreshed },
      options: {
        staleDays: 60,
        requiredLabels: [],
        exclusionLabels: [],
        protectedLabels: [],
      },
      approval: {
        approvedLabelPlanHash: dry.receipt.planHash,
        approvedLabelSnapshotHash: dry.receipt.snapshotHash,
      },
    },
  );

  assert.equal(transportRequested, false);
  assert.equal(summary.labelAuthorized, true);
  assert.equal(summary.labelWouldWrite, false);
  assert.match(summary.labelWriteSkipped, /live/);
});
