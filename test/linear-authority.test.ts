import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  authorizeMutation,
  authorizeMutations,
  buildMutationReceipt,
  EVIDENCE_CLOSE_REASONS,
  gateForKind,
  mergeLabels,
  resolveGates,
  REVIEW_ONLY_GATES,
} from "../dist/linear/authority.js";
import type {
  CloseEvidence,
  DriftFingerprint,
  MutationGates,
  MutationKind,
  MutationRequest,
} from "../dist/linear/authority.js";

// Re-export barrel wiring check
import { authorizeMutation as authorizeMutationFromIndex } from "../dist/linear/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SNAP = "snap-abc";
const PLAN = "plan-xyz";

// A drift fingerprint that matches the request below (no drift, approved plan).
const CLEAN_DRIFT: DriftFingerprint = { liveSnapshotHash: SNAP, approvedPlanHash: PLAN };

function allOpen(): MutationGates {
  return resolveGates({
    comment: true,
    labelWrite: true,
    stateChange: true,
    priorityChange: true,
    close: true,
  });
}

function makeRequest(overrides: Partial<MutationRequest> = {}): MutationRequest {
  return {
    kind: "comment-upsert",
    key: "ENG-1",
    snapshotHash: SNAP,
    planHash: PLAN,
    ...overrides,
  };
}

function makeCloseEvidence(overrides: Partial<CloseEvidence> = {}): CloseEvidence {
  return {
    decision: "close",
    closeReason: "implemented_on_main",
    confidence: "high",
    summary: "Shipped in main at abc123; behavior verified.",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveGates / REVIEW_ONLY_GATES — safety gates default closed
// ---------------------------------------------------------------------------

test("REVIEW_ONLY_GATES has every gate closed", () => {
  assert.deepEqual(REVIEW_ONLY_GATES, {
    comment: false,
    labelWrite: false,
    stateChange: false,
    priorityChange: false,
    close: false,
  });
});

test("resolveGates with no argument is review-only (all closed)", () => {
  assert.deepEqual(resolveGates(), REVIEW_ONLY_GATES);
});

test("resolveGates opens only the gates explicitly set to true", () => {
  const gates = resolveGates({ comment: true });
  assert.equal(gates.comment, true);
  assert.equal(gates.labelWrite, false);
  assert.equal(gates.stateChange, false);
  assert.equal(gates.priorityChange, false);
  assert.equal(gates.close, false);
});

test("resolveGates treats false / undefined as closed (disabling one never opens another)", () => {
  const gates = resolveGates({ comment: false, labelWrite: undefined, close: true });
  assert.equal(gates.comment, false);
  assert.equal(gates.labelWrite, false);
  assert.equal(gates.close, true);
});

test("resolveGates does not mutate REVIEW_ONLY_GATES", () => {
  resolveGates({ close: true });
  assert.equal(REVIEW_ONLY_GATES.close, false);
});

// ---------------------------------------------------------------------------
// gateForKind — each kind maps to exactly one gate
// ---------------------------------------------------------------------------

test("gateForKind maps each mutation kind to its governing gate", () => {
  const expected: Record<MutationKind, keyof MutationGates> = {
    "comment-upsert": "comment",
    "label-add": "labelWrite",
    "state-change": "stateChange",
    "priority-change": "priorityChange",
    close: "close",
  };
  for (const [kind, gate] of Object.entries(expected)) {
    assert.equal(gateForKind(kind as MutationKind), gate);
  }
});

// ---------------------------------------------------------------------------
// mergeLabels — union, dedup, stable order
// ---------------------------------------------------------------------------

test("mergeLabels returns the de-duplicated union, existing first then additions", () => {
  assert.deepEqual(mergeLabels(["a", "b"], ["c"]), ["a", "b", "c"]);
});

test("mergeLabels drops duplicates and preserves first-seen order", () => {
  assert.deepEqual(mergeLabels(["a", "b"], ["b", "a", "d"]), ["a", "b", "d"]);
});

test("mergeLabels with empty additions returns existing unchanged", () => {
  assert.deepEqual(mergeLabels(["x", "y"], []), ["x", "y"]);
});

// ---------------------------------------------------------------------------
// authorizeMutation — gate enforcement (default closed)
// ---------------------------------------------------------------------------

test("closed gate denies the mutation with a review-only reason", () => {
  const auth = authorizeMutation(makeRequest(), REVIEW_ONLY_GATES, CLEAN_DRIFT);
  assert.equal(auth.allowed, false);
  assert.equal(auth.gate, "comment");
  assert.ok(auth.reasons.some((r) => r.includes("review-only default")));
});

test("open gate with matching fingerprints authorizes a comment upsert", () => {
  const auth = authorizeMutation(makeRequest(), allOpen(), CLEAN_DRIFT);
  assert.equal(auth.allowed, true);
  assert.equal(auth.kind, "comment-upsert");
  assert.equal(auth.gate, "comment");
  assert.equal(auth.reasons.length, 1);
  assert.ok(auth.reasons[0]?.startsWith("authorized:"));
});

test("each gate independently governs its kind: opening comment does not authorize a state-change", () => {
  const gates = resolveGates({ comment: true });
  const auth = authorizeMutation(makeRequest({ kind: "state-change" }), gates, CLEAN_DRIFT);
  assert.equal(auth.allowed, false);
  assert.equal(auth.gate, "stateChange");
});

test("priority-change is authorized through the priorityChange gate", () => {
  const gates = resolveGates({ priorityChange: true });
  const auth = authorizeMutation(makeRequest({ kind: "priority-change" }), gates, CLEAN_DRIFT);
  assert.equal(auth.allowed, true);
  assert.equal(auth.gate, "priorityChange");
});

// ---------------------------------------------------------------------------
// authorizeMutation — drift-fingerprint receipt contract
// ---------------------------------------------------------------------------

test("snapshot drift denies the mutation even with the gate open", () => {
  const drift: DriftFingerprint = { liveSnapshotHash: "snap-changed", approvedPlanHash: PLAN };
  const auth = authorizeMutation(makeRequest(), allOpen(), drift);
  assert.equal(auth.allowed, false);
  assert.ok(auth.reasons.some((r) => r.includes("snapshot drift")));
});

test("plan hash mismatch denies the mutation even with the gate open", () => {
  const drift: DriftFingerprint = { liveSnapshotHash: SNAP, approvedPlanHash: "plan-other" };
  const auth = authorizeMutation(makeRequest(), allOpen(), drift);
  assert.equal(auth.allowed, false);
  assert.ok(auth.reasons.some((r) => r.includes("plan hash mismatch")));
});

test("a closed gate AND drift accumulate as multiple blocking reasons", () => {
  const drift: DriftFingerprint = {
    liveSnapshotHash: "snap-changed",
    approvedPlanHash: "plan-other",
  };
  const auth = authorizeMutation(makeRequest(), REVIEW_ONLY_GATES, drift);
  assert.equal(auth.allowed, false);
  assert.equal(auth.reasons.length, 3); // gate + snapshot drift + plan mismatch
});

// ---------------------------------------------------------------------------
// authorizeMutation — label writes merge, never replace
// ---------------------------------------------------------------------------

test("label-add with a valid additive union is authorized", () => {
  const req = makeRequest({
    kind: "label-add",
    labelChange: {
      existing: ["bug"],
      additions: ["needs-triage"],
      proposed: ["bug", "needs-triage"],
    },
  });
  const auth = authorizeMutation(req, allOpen(), CLEAN_DRIFT);
  assert.equal(auth.allowed, true);
  assert.equal(auth.gate, "labelWrite");
});

test("label-add without a labelChange payload is denied", () => {
  const auth = authorizeMutation(makeRequest({ kind: "label-add" }), allOpen(), CLEAN_DRIFT);
  assert.equal(auth.allowed, false);
  assert.ok(auth.reasons.some((r) => r.includes("requires a labelChange")));
});

test("label-add with no additions or removals is denied", () => {
  const req = makeRequest({
    kind: "label-add",
    labelChange: { existing: ["bug"], additions: [], proposed: ["bug"] },
  });
  const auth = authorizeMutation(req, allOpen(), CLEAN_DRIFT);
  assert.equal(auth.allowed, false);
  assert.ok(auth.reasons.some((r) => r.includes("no additions or removals")));
});

test("label-add that would drop an existing label is denied (no silent removal)", () => {
  const req = makeRequest({
    kind: "label-add",
    labelChange: { existing: ["bug", "keep"], additions: ["new"], proposed: ["bug", "new"] },
  });
  const auth = authorizeMutation(req, allOpen(), CLEAN_DRIFT);
  assert.equal(auth.allowed, false);
  assert.ok(auth.reasons.some((r) => r.includes("would remove existing labels")));
  assert.ok(auth.reasons.some((r) => r.includes("keep")));
});

test("label-add whose proposed set differs from the union is denied", () => {
  const req = makeRequest({
    kind: "label-add",
    labelChange: {
      existing: ["bug"],
      additions: ["new"],
      proposed: ["bug", "new", "surprise"],
    },
  });
  const auth = authorizeMutation(req, allOpen(), CLEAN_DRIFT);
  assert.equal(auth.allowed, false);
  assert.ok(auth.reasons.some((r) => r.includes("!= existing minus removals plus additions")));
});

test("label-add union check is order-independent", () => {
  const req = makeRequest({
    kind: "label-add",
    labelChange: { existing: ["a", "b"], additions: ["c"], proposed: ["c", "a", "b"] },
  });
  const auth = authorizeMutation(req, allOpen(), CLEAN_DRIFT);
  assert.equal(auth.allowed, true);
});

// ---------------------------------------------------------------------------
// authorizeMutation — close requires concrete evidence
// ---------------------------------------------------------------------------

test("close with concrete evidence and an open gate is authorized", () => {
  const req = makeRequest({ kind: "close", close: makeCloseEvidence() });
  const auth = authorizeMutation(req, allOpen(), CLEAN_DRIFT);
  assert.equal(auth.allowed, true);
  assert.equal(auth.gate, "close");
});

test("close without evidence is denied", () => {
  const auth = authorizeMutation(makeRequest({ kind: "close" }), allOpen(), CLEAN_DRIFT);
  assert.equal(auth.allowed, false);
  assert.ok(auth.reasons.some((r) => r.includes("close requires CloseEvidence")));
});

test("close of a maintainer-authored issue is denied", () => {
  const req = makeRequest({
    kind: "close",
    maintainerAuthored: true,
    close: makeCloseEvidence(),
  });
  const auth = authorizeMutation(req, allOpen(), CLEAN_DRIFT);
  assert.equal(auth.allowed, false);
  assert.ok(auth.reasons.some((r) => r.includes("maintainer-authored")));
});

test('close with decision "keep_open" is denied', () => {
  const req = makeRequest({
    kind: "close",
    close: makeCloseEvidence({ decision: "keep_open" }),
  });
  const auth = authorizeMutation(req, allOpen(), CLEAN_DRIFT);
  assert.equal(auth.allowed, false);
  assert.ok(auth.reasons.some((r) => r.includes('must be "close"')));
});

test('close with closeReason "none" is denied (no evidence)', () => {
  const req = makeRequest({
    kind: "close",
    close: makeCloseEvidence({ closeReason: "none" }),
  });
  const auth = authorizeMutation(req, allOpen(), CLEAN_DRIFT);
  assert.equal(auth.allowed, false);
  assert.ok(auth.reasons.some((r) => r.includes("not a concrete evidence-bearing reason")));
});

test("close with an empty summary is denied", () => {
  const req = makeRequest({
    kind: "close",
    close: makeCloseEvidence({ summary: "   " }),
  });
  const auth = authorizeMutation(req, allOpen(), CLEAN_DRIFT);
  assert.equal(auth.allowed, false);
  assert.ok(auth.reasons.some((r) => r.includes("summary must be non-empty")));
});

test("stale_insufficient_info is an evidence-bearing close reason", () => {
  const req = makeRequest({
    kind: "close",
    close: makeCloseEvidence({ closeReason: "stale_insufficient_info", confidence: "low" }),
  });
  const auth = authorizeMutation(req, allOpen(), CLEAN_DRIFT);
  assert.equal(auth.allowed, true);
});

test('EVIDENCE_CLOSE_REASONS contains the taxonomy reasons but excludes "none"', () => {
  const schema = JSON.parse(
    readFileSync(new URL("../schema/clawsweeper-decision.schema.json", import.meta.url), "utf8"),
  );
  const schemaReasons = schema.properties.closeReason.enum as string[];
  assert.deepEqual(
    [...EVIDENCE_CLOSE_REASONS].sort(),
    schemaReasons.filter((reason) => reason !== "none").sort(),
  );
  assert.equal(EVIDENCE_CLOSE_REASONS.has("none"), false);
});

// ---------------------------------------------------------------------------
// buildMutationReceipt — secret-free audit trail
// ---------------------------------------------------------------------------

test("buildMutationReceipt records the verdict, both fingerprints, and no drift on a clean apply", () => {
  const receipt = buildMutationReceipt(makeRequest(), allOpen(), CLEAN_DRIFT);
  assert.equal(receipt.allowed, true);
  assert.equal(receipt.kind, "comment-upsert");
  assert.equal(receipt.gate, "comment");
  assert.equal(receipt.snapshotHash, SNAP);
  assert.equal(receipt.liveSnapshotHash, SNAP);
  assert.equal(receipt.planHash, PLAN);
  assert.equal(receipt.approvedPlanHash, PLAN);
  assert.equal(receipt.driftDetected, false);
  assert.equal(receipt.closeReason, null);
});

test("buildMutationReceipt flags drift and carries the denial reasons", () => {
  const drift: DriftFingerprint = { liveSnapshotHash: "snap-changed", approvedPlanHash: PLAN };
  const receipt = buildMutationReceipt(makeRequest(), allOpen(), drift);
  assert.equal(receipt.allowed, false);
  assert.equal(receipt.driftDetected, true);
  assert.ok(receipt.reasons.some((r) => r.includes("snapshot drift")));
});

test("buildMutationReceipt records the closeReason for a close request", () => {
  const req = makeRequest({
    kind: "close",
    close: makeCloseEvidence({ closeReason: "duplicate_or_superseded" }),
  });
  const receipt = buildMutationReceipt(req, allOpen(), CLEAN_DRIFT);
  assert.equal(receipt.closeReason, "duplicate_or_superseded");
});

test("buildMutationReceipt carries only hashes, keys, and reasons (no secret-shaped fields)", () => {
  const receipt = buildMutationReceipt(makeRequest(), allOpen(), CLEAN_DRIFT);
  const keys = Object.keys(receipt).join(",").toLowerCase();
  assert.equal(/token|secret|credential|apikey|password/.test(keys), false);
});

// ---------------------------------------------------------------------------
// authorizeMutations — batch
// ---------------------------------------------------------------------------

test("authorizeMutations authorizes each request with its own drift fingerprint", () => {
  const requests: MutationRequest[] = [
    makeRequest({ key: "ENG-1", kind: "comment-upsert" }),
    makeRequest({ key: "ENG-2", kind: "state-change", snapshotHash: "snap-2" }),
  ];
  const driftFor = (r: MutationRequest): DriftFingerprint => ({
    liveSnapshotHash: r.snapshotHash,
    approvedPlanHash: r.planHash,
  });
  const results = authorizeMutations(requests, allOpen(), driftFor);
  assert.equal(results.length, 2);
  assert.equal(results[0]?.allowed, true);
  assert.equal(results[1]?.allowed, true);
  assert.equal(results[1]?.gate, "stateChange");
});

// ---------------------------------------------------------------------------
// Barrel wiring
// ---------------------------------------------------------------------------

test("authority functions are re-exported from the linear index barrel", () => {
  assert.equal(typeof authorizeMutationFromIndex, "function");
  const auth = authorizeMutationFromIndex(makeRequest(), allOpen(), CLEAN_DRIFT);
  assert.equal(auth.allowed, true);
});
