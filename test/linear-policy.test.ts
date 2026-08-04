import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_REVIEW_POLICY,
  evaluateReviewPolicy,
  isProtectedActionLabel,
  isReviewRoutingLabel,
  LABEL_HUMAN_REVIEW,
  LABEL_LINKED_PR_OPEN,
  LABEL_NEEDS_INFO,
  LABEL_NEEDS_MAINTAINER_REVIEW,
  LABEL_NEEDS_PRODUCT_DECISION,
  LABEL_NOT_REPRO_ON_MAIN,
  nextReviewLabels,
} from "../dist/linear/index.js";
import type { LinearClassification } from "../dist/linear/classifier.js";
import type { LinearReviewRecord } from "../dist/linear/record.js";
import type { ReviewPolicyRule } from "../dist/linear/policy.js";

// ---------------------------------------------------------------------------
// Fixtures — only the fields the policy reads matter; the rest are valid defaults.
// ---------------------------------------------------------------------------

function classification(overrides: Partial<LinearClassification> = {}): LinearClassification {
  return {
    key: "PAR-1",
    identifier: "PAR-1",
    disposition: "review",
    reviewOnly: true,
    eligible: true,
    closeable: true,
    staleCandidate: false,
    closeCandidateReason: "none",
    reasons: ["eligible for review"],
    ...overrides,
  } as LinearClassification;
}

function record(overrides: Partial<LinearReviewRecord> = {}): LinearReviewRecord {
  return {
    id: "uuid-1",
    key: "PAR-1",
    identifier: "PAR-1",
    title: "t",
    url: "u",
    sourceProvider: "linear",
    sourceId: "uuid-1",
    snapshotHash: "h",
    workspaceSlug: "linear-par",
    recordPath: "records/linear-par/items/PAR-1.md",
    reviewMarker: "<!-- m -->",
    state: "open",
    linearStateId: null,
    linearStateName: null,
    linearStateType: null,
    triagePriority: "P2",
    itemCategory: "unclear",
    teamKey: "PAR",
    teamName: "PartnerAI",
    projectName: null,
    labels: [],
    ...overrides,
  } as LinearReviewRecord;
}

const reviewItem = (cat: string) =>
  evaluateReviewPolicy(
    classification({ disposition: "review", eligible: true }),
    record({ itemCategory: cat as never }),
  );
const staleItem = (cat: string) =>
  evaluateReviewPolicy(
    classification({
      disposition: "stale-candidate",
      eligible: true,
      staleCandidate: true,
      closeCandidateReason: "stale_insufficient_info",
    }),
    record({ itemCategory: cat as never }),
  );

// ---------------------------------------------------------------------------
// Routing rules (project-agnostic, signal-driven)
// ---------------------------------------------------------------------------

test("default eligible review item → needs-maintainer-review", () => {
  const d = reviewItem("unclear");
  assert.equal(d.routingLabel, LABEL_NEEDS_MAINTAINER_REVIEW);
  assert.equal(d.ruleId, "needs-maintainer-review");
});

test("eligible feature → needs-product-decision", () => {
  assert.equal(reviewItem("feature").routingLabel, LABEL_NEEDS_PRODUCT_DECISION);
});

test("stale bug / regression → not-repro-on-main", () => {
  assert.equal(staleItem("bug").routingLabel, LABEL_NOT_REPRO_ON_MAIN);
  assert.equal(staleItem("regression").routingLabel, LABEL_NOT_REPRO_ON_MAIN);
});

test("stale unclear / docs → needs-info (remaining-stale fallthrough)", () => {
  assert.equal(staleItem("unclear").routingLabel, LABEL_NEEDS_INFO);
  assert.equal(staleItem("docs").routingLabel, LABEL_NEEDS_INFO);
});

test("security-categorized stale routes to needs-info, NOT not-repro (conservative, documented)", () => {
  // record.ts category precedence makes a security bug itemCategory='security', so it does
  // NOT match the bug/regression not-repro rule — it falls to the remaining-stale needs-info.
  assert.equal(staleItem("security").routingLabel, LABEL_NEEDS_INFO);
  // and a non-stale security item gets the default human-decides routing.
  assert.equal(reviewItem("security").routingLabel, LABEL_NEEDS_MAINTAINER_REVIEW);
});

test("ineligible (closed/excluded/not-ready) → no label, control rule", () => {
  const d = evaluateReviewPolicy(
    classification({ disposition: "closed", eligible: false }),
    record({ state: "closed" }),
  );
  assert.equal(d.routingLabel, null);
  assert.deepEqual(d.proposedLabels, []);
  assert.equal(d.ruleId, "ineligible");
});

test("protected via human-review label echo → no routing label (preserve, never touch)", () => {
  const d = evaluateReviewPolicy(classification(), record({ labels: [LABEL_HUMAN_REVIEW] }));
  assert.equal(d.ruleId, "protected-human-review");
  assert.equal(d.routingLabel, null);
  assert.deepEqual(d.proposedLabels, []);
});

test("linked-pr-open echo → no routing label (keep open)", () => {
  const d = evaluateReviewPolicy(classification(), record({ labels: [LABEL_LINKED_PR_OPEN] }));
  assert.equal(d.ruleId, "linked-pr-open");
  assert.equal(d.routingLabel, null);
});

test("exactly one routing label per eligible item (or null)", () => {
  for (const cat of [
    "bug",
    "regression",
    "feature",
    "docs",
    "security",
    "unclear",
    "skill",
    "cleanup",
  ]) {
    const d = reviewItem(cat);
    assert.ok(d.proposedLabels.length <= 1, `${cat} proposed >1 label`);
    if (d.routingLabel !== null) assert.ok(isReviewRoutingLabel(d.routingLabel));
  }
});

// ---------------------------------------------------------------------------
// Safety invariants (outside the rule table)
// ---------------------------------------------------------------------------

test("denylist: an override can NEVER leak an action/proof/mantis/P0 label", () => {
  const evil: ReviewPolicyRule = {
    id: "evil-override",
    appliesWhen: () => true,
    routingLabel: "clawsweeper:autofix",
    advisoryLabels: ["proof:reproduced", "mantis:x", "P0", LABEL_NEEDS_INFO],
    suggestedNextStep: "x",
    kind: "advisory",
  };
  const d = evaluateReviewPolicy(classification(), record(), [evil]);
  assert.deepEqual(d.proposedLabels, [LABEL_NEEDS_INFO]); // only the legitimate advisory survives
  assert.equal(d.routingLabel, null); // the autofix routing label was stripped, not surfaced
});

test("isProtectedActionLabel: exact control labels + P0 + proof:/mantis: prefixes", () => {
  for (const l of [
    "clawsweeper:autofix",
    "clawsweeper:automerge",
    "clawsweeper:manual-only",
    "clawsweeper:merge-ready",
    "P0",
    "p0",
    "proof:reproduced",
    "mantis:anything",
  ]) {
    assert.ok(isProtectedActionLabel(l), `${l} should be protected`);
  }
  for (const l of [LABEL_NEEDS_INFO, LABEL_NEEDS_MAINTAINER_REVIEW, "P1", "some-project-label"]) {
    assert.ok(!isProtectedActionLabel(l), `${l} should NOT be protected`);
  }
});

test("isReviewRoutingLabel: only the four owned routing labels (case-insensitive)", () => {
  assert.ok(isReviewRoutingLabel(LABEL_NEEDS_MAINTAINER_REVIEW.toUpperCase()));
  assert.ok(isReviewRoutingLabel(LABEL_NOT_REPRO_ON_MAIN));
  assert.ok(!isReviewRoutingLabel(LABEL_HUMAN_REVIEW)); // protected, not owned
  assert.ok(!isReviewRoutingLabel(LABEL_LINKED_PR_OPEN));
  assert.ok(!isReviewRoutingLabel("clawsweeper:autofix"));
});

test("every DEFAULT_REVIEW_POLICY routingLabel is an owned routing label (never action/close)", () => {
  for (const rule of DEFAULT_REVIEW_POLICY) {
    if (rule.routingLabel !== undefined) {
      assert.ok(isReviewRoutingLabel(rule.routingLabel), `${rule.id} routes a non-owned label`);
      assert.ok(!isProtectedActionLabel(rule.routingLabel), `${rule.id} routes an action label`);
    }
  }
});

// ---------------------------------------------------------------------------
// Reconciler: additive-only; preserve every existing label; idempotent
// ---------------------------------------------------------------------------

test("nextReviewLabels adds routing without removing any existing label", () => {
  const existing = [
    "clawsweeper:autofix",
    "proof:reproduced",
    "mantis:x",
    LABEL_NEEDS_INFO, // stale owned routing label to be replaced
    "team:backend",
    LABEL_HUMAN_REVIEW, // protected — must be preserved
  ];
  const next = nextReviewLabels(existing, [LABEL_NEEDS_MAINTAINER_REVIEW]);
  for (const keep of [
    "clawsweeper:autofix",
    "proof:reproduced",
    "mantis:x",
    "team:backend",
    LABEL_HUMAN_REVIEW,
  ]) {
    assert.ok(next.includes(keep), `dropped ${keep}`);
  }
  assert.ok(next.includes(LABEL_NEEDS_MAINTAINER_REVIEW));
  assert.ok(next.includes(LABEL_NEEDS_INFO), "existing routing label was removed");
});

test("nextReviewLabels is idempotent on re-sync (no label thrash across weekly runs)", () => {
  const existing = ["clawsweeper:autofix", LABEL_NEEDS_MAINTAINER_REVIEW, "team:x"];
  const once = nextReviewLabels(existing, [LABEL_NEEDS_MAINTAINER_REVIEW]);
  const twice = nextReviewLabels(once, [LABEL_NEEDS_MAINTAINER_REVIEW]);
  assert.deepEqual([...once].sort(), [...twice].sort());
});

test("nextReviewLabels with empty wanted preserves every label", () => {
  const next = nextReviewLabels([LABEL_NEEDS_INFO, LABEL_HUMAN_REVIEW, "team:x"], []);
  assert.ok(next.includes(LABEL_NEEDS_INFO));
  assert.ok(next.includes(LABEL_HUMAN_REVIEW));
  assert.ok(next.includes("team:x"));
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test("evaluateReviewPolicy is deterministic for fixed input", () => {
  assert.deepEqual(reviewItem("bug"), reviewItem("bug"));
  assert.deepEqual(staleItem("feature"), staleItem("feature"));
});
