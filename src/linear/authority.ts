/**
 * Linear mutation authority, receipts, and safety gates (deterministic, offline, pure).
 *
 * Doctrine — read, write, propose; never the other way round:
 *   This module is the authorization layer between a review-only triage plan and any
 *   real Linear mutation. It decides nothing about *what* to change; it decides
 *   *whether* a proposed change is permitted. Every decision is a pure function of the
 *   request, the explicitly-resolved safety gates, and a drift-fingerprint receipt.
 *   No network, no clock, no I/O. It pairs with the review-only classifier: the
 *   classifier proposes, this layer authorizes, and a downstream deterministic script
 *   (never Codex, never a review run) holds the short-lived token that applies.
 *
 * Safety gates default closed:
 *   Every write capability — comment post, label write, state change, priority change,
 *   close — is independently gated and defaults to false. `resolveGates` always starts
 *   from REVIEW_ONLY_GATES (all closed) and opens only the gates explicitly set to
 *   `true`, so disabling one gate can never open another, and an empty or omitted
 *   config is review-only. A mutation whose gate is closed is denied.
 *
 * Drift-fingerprint receipts:
 *   Apply is gated behind the existing snapshotHash / planHash contract. A mutation is
 *   authorized only when the plan's snapshotHash still equals the live snapshot hash
 *   recomputed at apply time (no drift since the snapshot) and the plan's planHash
 *   equals the operator-approved plan hash. `MutationReceipt` is the audit trail; it
 *   carries hashes, keys, and reasons — never secrets or tokens.
 *
 * Never close without concrete evidence:
 *   Closing a Linear issue requires a `decision: "close"` evidence record whose
 *   closeReason is one of ClawSweeper's decision-taxonomy reasons (never "none").
 *   Maintainer-authored issues are never closeable. A close must be requested as kind
 *   "close" (not as a generic "state-change" into a terminal state) so the evidence
 *   gate applies.
 *
 * Label writes merge, never replace:
 *   Linear's issueUpdate replaces the full labelIds array. A "label-add" request must
 *   carry the existing labels, the additions, and the full proposed set; authorization
 *   rejects any write whose proposed set drops an existing label or differs from the
 *   union of existing ∪ additions. Use `mergeLabels` to compute that union.
 */

import type { RepositoryCloseReason } from "../repository-profiles.js";

export type MutationKind =
  | "comment-upsert" // post/edit the durable marker-keyed review comment
  | "label-add" // additive label write (read-merge-write the union)
  | "state-change" // non-close workflow state transition
  | "priority-change" // triage priority write
  | "close"; // close the issue (requires concrete decision-taxonomy evidence)

/** Independent, default-closed write gates. One boolean per write capability. */
export interface MutationGates {
  comment: boolean; // marker-keyed review-comment capability
  labelWrite: boolean; // additive label writes
  stateChange: boolean; // non-close state transitions
  priorityChange: boolean; // priority writes
  close: boolean; // close-with-evidence
}

/** The review-only baseline: every gate closed. `resolveGates` starts from this. */
export const REVIEW_ONLY_GATES: MutationGates = {
  comment: false,
  labelWrite: false,
  stateChange: false,
  priorityChange: false,
  close: false,
};

// Each mutation kind is governed by exactly one gate.
const GATE_FOR_KIND: Record<MutationKind, keyof MutationGates> = {
  "comment-upsert": "comment",
  "label-add": "labelWrite",
  "state-change": "stateChange",
  "priority-change": "priorityChange",
  close: "close",
};

/** Returns the gate key that governs a mutation kind. */
export function gateForKind(kind: MutationKind): keyof MutationGates {
  return GATE_FOR_KIND[kind];
}

/**
 * Resolves a partial gate config against the review-only baseline.
 * Only an explicit `true` opens a gate; `false`, `undefined`, or a missing key stays
 * closed. This guarantees disabling one gate never opens another and that an omitted
 * config is review-only.
 */
export function resolveGates(overrides?: Partial<MutationGates>): MutationGates {
  const o = overrides ?? {};
  return {
    comment: o.comment === true,
    labelWrite: o.labelWrite === true,
    stateChange: o.stateChange === true,
    priorityChange: o.priorityChange === true,
    close: o.close === true,
  };
}

// Keep Linear authorization on the same close taxonomy as repository profiles.
export type CloseReason = RepositoryCloseReason;

export type CloseDecision = "close" | "keep_open";
export type CloseConfidence = "high" | "medium" | "low";

/**
 * Concrete evidence-bearing close reasons — the full taxonomy minus "none".
 * Closing with any reason outside this set (or with "none") is prohibited.
 */
export const EVIDENCE_CLOSE_REASONS: ReadonlySet<CloseReason> = new Set<CloseReason>([
  "implemented_on_main",
  "mostly_implemented_on_main",
  "cannot_reproduce",
  "clawhub",
  "duplicate_or_superseded",
  "low_signal_unmergeable_pr",
  "stalled_unproven_pr",
  "abandoned_pr",
  "unconfirmed_product_direction",
  "unsponsored_feature_request",
  "author_pr_budget_exceeded",
  "stale_version_bug",
  "obsolete_fix_pr",
  "not_actionable_in_repo",
  "incoherent",
  "stale_insufficient_info",
]);

/** Evidence required to authorize a close, matching the decision taxonomy. */
export interface CloseEvidence {
  decision: CloseDecision; // must be "close"
  closeReason: CloseReason; // must be evidence-bearing (in EVIDENCE_CLOSE_REASONS)
  confidence: CloseConfidence; // recorded on the receipt for audit
  summary: string; // human-readable rationale; must be non-empty
}

/** Label write: the existing set, safe removals, additions, and the full proposed set. */
export interface LabelChange {
  existing: string[]; // label names currently on the issue
  removals?: string[]; // label names intentionally removed by a governed reconciler
  additions: string[]; // label names to add
  proposed: string[]; // the full set that would be written (existing - removals + additions)
}

/** A single proposed mutation, carrying its own plan-time fingerprints. */
export interface MutationRequest {
  kind: MutationKind;
  key: string; // issue identifier (e.g. "PAR-215") — for receipts and reasons
  snapshotHash: string; // record snapshotHash the plan was computed against
  planHash: string; // deterministic hash of the proposed plan
  maintainerAuthored?: boolean; // issue authored by a maintainer (blocks close)
  labelChange?: LabelChange; // required for kind "label-add"
  close?: CloseEvidence; // required for kind "close"
}

/** Apply-time receipt inputs: the live fingerprint and the operator-approved plan. */
export interface DriftFingerprint {
  liveSnapshotHash: string; // snapshot hash recomputed from the live issue at apply time
  approvedPlanHash: string; // the plan hash an operator explicitly approved
}

/** The authorization verdict for a single mutation request. */
export interface MutationAuthorization {
  allowed: boolean;
  kind: MutationKind;
  key: string;
  gate: keyof MutationGates;
  reasons: string[]; // ordered, non-empty: blocking reasons when denied, else one allow line
}

/** A secret-free audit record for one authorization decision. */
export interface MutationReceipt {
  kind: MutationKind;
  key: string;
  gate: keyof MutationGates;
  allowed: boolean;
  reasons: string[];
  snapshotHash: string; // plan-time snapshot
  liveSnapshotHash: string; // apply-time snapshot
  planHash: string; // proposed plan hash
  approvedPlanHash: string; // operator-approved plan hash
  driftDetected: boolean; // snapshotHash !== liveSnapshotHash
  closeReason: CloseReason | null; // present only for close requests
}

/**
 * Merges existing labels with additions into a stable, de-duplicated union.
 * Existing labels keep their order and come first, then new additions in order. This is
 * the value a label write must produce — Linear's labelIds is replace-all, so the caller
 * must read-merge-write this union rather than sending only the additions.
 */
export function mergeLabels(existing: string[], additions: string[]): string[] {
  const seen = new Set<string>();
  const union: string[] = [];
  for (const label of [...existing, ...additions]) {
    if (!seen.has(label)) {
      seen.add(label);
      union.push(label);
    }
  }
  return union;
}

// Order-independent set equality for label-name arrays.
function sameSet(a: string[], b: string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) {
    if (!sb.has(x)) return false;
  }
  return true;
}

// Stable, sorted rendering of a label list for deterministic reason messages.
function stableList(items: string[]): string {
  return `[${[...items].sort().join(", ")}]`;
}

// Returns blocking reasons for a label-add request; empty when the merge is valid.
function checkLabelChange(change: LabelChange | undefined): string[] {
  if (change === undefined) {
    return ["label-add requires a labelChange { existing, additions, proposed }"];
  }
  const blocks: string[] = [];
  const removals = change.removals ?? [];
  if (change.additions.length === 0 && removals.length === 0) {
    blocks.push("label write has no additions or removals — nothing to write");
  }
  const proposed = new Set(change.proposed);
  const removalSet = new Set(removals);
  const dropped = change.existing.filter((l) => !proposed.has(l));
  const undeclaredDropped = dropped.filter((l) => !removalSet.has(l));
  if (undeclaredDropped.length > 0) {
    blocks.push(
      `label write would remove existing labels ${stableList(undeclaredDropped)} without declaring safe removals`,
    );
  }
  const notDropped = removals.filter((l) => proposed.has(l));
  if (notDropped.length > 0) {
    blocks.push(`label removals ${stableList(notDropped)} are still present in the proposed set`);
  }
  const missingRemovals = removals.filter((l) => !change.existing.includes(l));
  if (missingRemovals.length > 0) {
    blocks.push(`label removals ${stableList(missingRemovals)} were not present on the issue`);
  }
  const expected = mergeLabels(
    change.existing.filter((l) => !removalSet.has(l)),
    change.additions,
  );
  if (!sameSet(change.proposed, expected)) {
    blocks.push(
      `proposed labels ${stableList(change.proposed)} != existing minus removals plus additions ${stableList(expected)}`,
    );
  }
  return blocks;
}

// Returns blocking reasons for a close request; empty when the evidence is sufficient.
function checkCloseEvidence(
  evidence: CloseEvidence | undefined,
  maintainerAuthored: boolean,
): string[] {
  if (evidence === undefined) {
    return ["close requires CloseEvidence with a concrete decision-taxonomy reason"];
  }
  const blocks: string[] = [];
  if (maintainerAuthored) {
    blocks.push("issue is maintainer-authored — never eligible for auto-close");
  }
  if (evidence.decision !== "close") {
    blocks.push(`close evidence decision is "${evidence.decision}" — must be "close"`);
  }
  if (!EVIDENCE_CLOSE_REASONS.has(evidence.closeReason)) {
    blocks.push(
      `closeReason "${evidence.closeReason}" is not a concrete evidence-bearing reason — closing without evidence is prohibited`,
    );
  }
  if (evidence.summary.trim().length === 0) {
    blocks.push("close evidence summary must be non-empty");
  }
  return blocks;
}

/**
 * Authorizes a single mutation request against the resolved gates and the apply-time
 * drift fingerprint. Pure and offline. Collects every blocking reason so the receipt is
 * fully informative; `allowed` is true only when no reason blocks.
 *
 * Checks, in order:
 *   1. Safety gate — the governing gate must be open (default closed → denied).
 *   2. Snapshot drift — the plan's snapshotHash must equal the live snapshot hash.
 *   3. Plan hash — the request's planHash must equal the operator-approved plan hash.
 *   4. Kind invariants — label-add must be a valid additive union; close must carry
 *      concrete decision-taxonomy evidence and the issue must not be maintainer-authored.
 */
export function authorizeMutation(
  request: MutationRequest,
  gates: MutationGates,
  drift: DriftFingerprint,
): MutationAuthorization {
  const gate = gateForKind(request.kind);
  const blocks: string[] = [];

  if (!gates[gate]) {
    blocks.push(
      `gate "${gate}" is closed — review-only default; mutation requires an explicitly opened gate`,
    );
  }

  if (request.snapshotHash !== drift.liveSnapshotHash) {
    blocks.push(
      `snapshot drift: plan snapshotHash ${request.snapshotHash} != live ${drift.liveSnapshotHash} — issue changed since the snapshot`,
    );
  }

  if (request.planHash !== drift.approvedPlanHash) {
    blocks.push(
      `plan hash mismatch: request ${request.planHash} != approved ${drift.approvedPlanHash}`,
    );
  }

  if (request.kind === "label-add") {
    blocks.push(...checkLabelChange(request.labelChange));
  } else if (request.kind === "close") {
    blocks.push(...checkCloseEvidence(request.close, request.maintainerAuthored === true));
  }

  const allowed = blocks.length === 0;
  const reasons = allowed
    ? [`authorized: ${request.kind} on ${request.key} via gate "${gate}"`]
    : blocks;

  return { allowed, kind: request.kind, key: request.key, gate, reasons };
}

/**
 * Authorizes a batch of mutation requests. `driftFor` supplies the apply-time
 * fingerprint per request (each issue has its own live snapshot). Returns one
 * authorization per request, in input order.
 */
export function authorizeMutations(
  requests: MutationRequest[],
  gates: MutationGates,
  driftFor: (request: MutationRequest) => DriftFingerprint,
): MutationAuthorization[] {
  return requests.map((r) => authorizeMutation(r, gates, driftFor(r)));
}

/**
 * Builds a secret-free audit receipt for one authorization decision. Carries the
 * authorization verdict plus both snapshot fingerprints and both plan hashes so the
 * apply trail can be reconstructed. Never includes tokens, credentials, or issue body
 * text — only hashes, the issue key, and reasons.
 */
export function buildMutationReceipt(
  request: MutationRequest,
  gates: MutationGates,
  drift: DriftFingerprint,
): MutationReceipt {
  const auth = authorizeMutation(request, gates, drift);
  return {
    kind: request.kind,
    key: request.key,
    gate: auth.gate,
    allowed: auth.allowed,
    reasons: auth.reasons,
    snapshotHash: request.snapshotHash,
    liveSnapshotHash: drift.liveSnapshotHash,
    planHash: request.planHash,
    approvedPlanHash: drift.approvedPlanHash,
    driftDetected: request.snapshotHash !== drift.liveSnapshotHash,
    closeReason: request.close ? request.close.closeReason : null,
  };
}
