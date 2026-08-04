/**
 * Review policy — project-agnostic mapping from a classification to advisory labels and a
 * suggested next step (deterministic, offline, pure).
 *
 * Doctrine — one default policy for every project, propose-only:
 *   ClawSweeper classifies an issue; this layer turns that classification into (a) exactly
 *   ONE advisory routing label proposal and (b) a human-readable "suggested next step" for
 *   the review comment. It is the single place that encodes "what should happen next" so the
 *   same rules apply to EVERY Linear project with no per-project input. It proposes; a human
 *   or the next agent disposes. It never closes and never emits an action/control label.
 *
 * Keyed only on signals that already exist:
 *   Every rule reads only fields the classifier/record already produce — disposition,
 *   eligible, staleCandidate, closeCandidateReason, triagePriority, itemCategory, and the
 *   issue's existing label NAMES. No new fetch, no clock, no I/O. So the policy is a pure
 *   function and unit-testable with frozen fixtures, exactly like the classifier.
 *
 * Two invariants live OUTSIDE the rule table so no rule (or future per-project override)
 * can break them:
 *   1. PROTECTED_ACTION_LABELS — a denylist filter applied AFTER rule evaluation. The policy
 *      can never propose an action/control/proof/mantis label or a priority label; those are
 *      reported in the comment body, never written by this layer.
 *   2. REVIEW_ROUTING_LABELS — the owned set the reconciler (`nextReviewLabels`) may add or
 *      remove. Everything else on an issue (action labels, proof/mantis, the protected
 *      human-review / linked-pr-open echoes, and any project's own labels) is preserved.
 *
 * Future per-project override (designed, NOT wired): `evaluateReviewPolicy` takes an
 * optional `overrideRules` array consulted before the default table (first-match-wins).
 * Because rules are pure data, a per-project policy is just another array — no code fork.
 */

import type {
  CloseCandidateReason,
  LinearClassification,
  ReviewDisposition,
} from "./classifier.js";
import type { ItemCategory, LinearReviewRecord, TriagePriority } from "./record.js";
import { mergeLabels } from "./authority.js";

// --- Label vocabulary (documented ClawSweeper taxonomy; do not coin parallels) ----------

// Routing labels the engine OWNS — it assigns exactly one and the reconciler may swap it.
export const LABEL_NEEDS_MAINTAINER_REVIEW = "clawsweeper:needs-maintainer-review";
export const LABEL_NEEDS_INFO = "clawsweeper:needs-info";
export const LABEL_NEEDS_PRODUCT_DECISION = "clawsweeper:needs-product-decision";
export const LABEL_NOT_REPRO_ON_MAIN = "clawsweeper:not-repro-on-main";

// Protected / echo-only labels — preserved if present, NEVER minted (the signals that would
// justify minting them — issue author, live linked PRs — are not in the read query surface).
export const LABEL_HUMAN_REVIEW = "clawsweeper:human-review";
export const LABEL_LINKED_PR_OPEN = "clawsweeper:linked-pr-open";

/**
 * The routing labels the policy OWNS: exactly one is proposed per eligible item, and the
 * reconciler is allowed to remove a stale one. Protected/echo labels are deliberately NOT
 * here, so the reconciler never strips a human-review / linked-pr-open marker.
 */
export const REVIEW_ROUTING_LABELS: readonly string[] = [
  LABEL_NEEDS_MAINTAINER_REVIEW,
  LABEL_NEEDS_INFO,
  LABEL_NEEDS_PRODUCT_DECISION,
  LABEL_NOT_REPRO_ON_MAIN,
];

const ROUTING_LOWER = new Set(REVIEW_ROUTING_LABELS.map((l) => l.toLowerCase()));

/** True iff `name` is one of the routing labels this engine owns (case-insensitive). */
export function isReviewRoutingLabel(name: string): boolean {
  return ROUTING_LOWER.has(name.toLowerCase());
}

// Action/control labels and the priority label the policy must NEVER add. proof:* and
// mantis:* are namespaces, so they are matched by PREFIX, not exact name.
const PROTECTED_ACTION_EXACT = new Set(
  [
    "clawsweeper:autofix",
    "clawsweeper:automerge",
    "clawsweeper:manual-only",
    "clawsweeper:merge-ready",
    "p0",
  ].map((l) => l.toLowerCase()),
);
const PROTECTED_ACTION_PREFIXES = ["proof:", "mantis:"];

/** The denylist as documented, for tests/visibility. */
export const PROTECTED_ACTION_LABELS: readonly string[] = [
  "clawsweeper:autofix",
  "clawsweeper:automerge",
  "clawsweeper:manual-only",
  "clawsweeper:merge-ready",
  "P0",
  "proof:*",
  "mantis:*",
];

/**
 * True iff `name` is an action/control/priority label the policy must never propose. Exact
 * match for the fixed control labels and P0; prefix match for the proof:/mantis: namespaces.
 */
export function isProtectedActionLabel(name: string): boolean {
  const lower = name.toLowerCase();
  if (PROTECTED_ACTION_EXACT.has(lower)) return true;
  return PROTECTED_ACTION_PREFIXES.some((p) => lower.startsWith(p));
}

// --- Policy signals + rules -------------------------------------------------------------

/** A pure view of the signals a rule may read — assembled from EXISTING fields only. */
export interface PolicySignals {
  disposition: ReviewDisposition;
  eligible: boolean;
  staleCandidate: boolean;
  closeCandidateReason: CloseCandidateReason;
  triagePriority: TriagePriority;
  itemCategory: ItemCategory;
  hasLabel: (name: string) => boolean; // case-insensitive membership over the issue's labels
}

/** Assembles the pure signal view from a classification + record. No fetch, no clock. */
export function buildPolicySignals(
  classification: LinearClassification,
  record: LinearReviewRecord,
): PolicySignals {
  const lower = record.labels.map((l) => l.toLowerCase());
  return {
    disposition: classification.disposition,
    eligible: classification.eligible,
    staleCandidate: classification.staleCandidate,
    closeCandidateReason: classification.closeCandidateReason,
    triagePriority: record.triagePriority,
    itemCategory: record.itemCategory,
    hasLabel: (name: string) => lower.includes(name.toLowerCase()),
  };
}

/** One precedence-ordered policy rule. The first whose `appliesWhen` is true wins. */
export interface ReviewPolicyRule {
  id: string;
  appliesWhen: (signals: PolicySignals) => boolean;
  routingLabel?: string; // the ONE owned routing label to propose (omit for protected/skip)
  advisoryLabels?: string[]; // extra advisory labels (override seam; denylist-filtered)
  suggestedNextStep: string; // the comment's "Suggested next step" line
  kind: "advisory" | "protected" | "control";
}

/**
 * The single default policy applied to EVERY project. Precedence (first match wins):
 *   1. ineligible (closed/excluded/not-ready) → no comment, no label
 *   2. protected (human-review label, or operator --protected-label) → echo, no routing label
 *   3. linked-pr-open label present → keep open, no routing label
 *   4. eligible feature → needs-product-decision
 *   5. stale bug/regression → not-repro-on-main (close-LEANING; a human still confirms)
 *   6. any remaining stale → needs-info
 *   7. eligible fallthrough (e.g. plain "review") → needs-maintainer-review
 */
export const DEFAULT_REVIEW_POLICY: readonly ReviewPolicyRule[] = [
  {
    id: "ineligible",
    appliesWhen: (s) => !s.eligible,
    suggestedNextStep:
      "No review needed — this item is closed, excluded, or not-ready; ClawSweeper proposes nothing.",
    kind: "control",
  },
  {
    id: "protected-human-review",
    // disposition==='protected' requires operator --protected-label; the live default trigger
    // is the human-review label echo, which works with zero per-project config.
    appliesWhen: (s) => s.disposition === "protected" || s.hasLabel(LABEL_HUMAN_REVIEW),
    suggestedNextStep:
      "None — this item is maintainer-protected (clawsweeper:human-review); ClawSweeper will not auto-touch it.",
    kind: "protected",
  },
  {
    id: "linked-pr-open",
    appliesWhen: (s) => s.hasLabel(LABEL_LINKED_PR_OPEN),
    suggestedNextStep:
      "Keep open until the linked PR lands (clawsweeper:linked-pr-open); re-review after it merges or closes.",
    kind: "protected",
  },
  {
    id: "product-decision",
    appliesWhen: (s) => s.eligible && s.itemCategory === "feature",
    routingLabel: LABEL_NEEDS_PRODUCT_DECISION,
    suggestedNextStep:
      "A maintainer makes the scope/product call — accept, narrow, or decline. ClawSweeper never auto-closes a product-decision item.",
    kind: "advisory",
  },
  {
    id: "not-repro-on-main",
    // closeCandidateReason is always 'stale_insufficient_info' when staleCandidate, so
    // staleCandidate alone is the meaningful signal; category narrows it to defects.
    appliesWhen: (s) =>
      s.staleCandidate && (s.itemCategory === "bug" || s.itemCategory === "regression"),
    routingLabel: LABEL_NOT_REPRO_ON_MAIN,
    suggestedNextStep:
      "A maintainer confirms whether this still reproduces on main; if not, close it manually (cannot_reproduce / stale_insufficient_info). ClawSweeper proposes only and will not close.",
    kind: "advisory",
  },
  {
    id: "needs-info",
    appliesWhen: (s) => s.staleCandidate,
    routingLabel: LABEL_NEEDS_INFO,
    suggestedNextStep:
      "Ask the reporter for corroborating evidence (repro steps, logs, version). If none arrives a maintainer may close as stale — ClawSweeper will not.",
    kind: "advisory",
  },
  {
    id: "needs-maintainer-review",
    appliesWhen: (s) => s.eligible,
    routingLabel: LABEL_NEEDS_MAINTAINER_REVIEW,
    suggestedNextStep:
      "A maintainer triages and decides comment-or-close, or applies an action label (e.g. clawsweeper:autofix / clawsweeper:manual-only). ClawSweeper proposes; it never closes.",
    kind: "advisory",
  },
];

/** The result of evaluating the policy for one item. Secret-free, deterministic. */
export interface PolicyDecision {
  ruleId: string;
  routingLabel: string | null; // the single owned routing label, or null (protected/skip)
  proposedLabels: string[]; // routing + advisory, denylist-filtered, de-duped, sorted
  suggestedNextStep: string;
  kind: ReviewPolicyRule["kind"];
}

function dedupeSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * Evaluates the policy for one classified item. Walks `overrideRules` (if any) then the
 * default policy, first-match-wins, to choose exactly one routing label and a suggested next
 * step; unions any advisory labels; then strips every PROTECTED_ACTION_LABELS member so no
 * rule or override can ever leak an action/control/priority label. Pure and offline.
 */
export function evaluateReviewPolicy(
  classification: LinearClassification,
  record: LinearReviewRecord,
  overrideRules?: readonly ReviewPolicyRule[],
): PolicyDecision {
  const signals = buildPolicySignals(classification, record);
  const rules =
    overrideRules && overrideRules.length > 0
      ? [...overrideRules, ...DEFAULT_REVIEW_POLICY]
      : DEFAULT_REVIEW_POLICY;

  const matched = rules.find((r) => r.appliesWhen(signals));
  if (matched === undefined) {
    // Unreachable with the default table (ineligible + eligible cover all), but stay safe.
    return {
      ruleId: "unmatched",
      routingLabel: null,
      proposedLabels: [],
      suggestedNextStep: "No applicable policy rule — defer to a maintainer.",
      kind: "control",
    };
  }

  const wanted: string[] = [];
  if (matched.routingLabel !== undefined) wanted.push(matched.routingLabel);
  if (matched.advisoryLabels !== undefined) wanted.push(...matched.advisoryLabels);
  const proposedLabels = dedupeSorted(wanted.filter((l) => !isProtectedActionLabel(l)));

  // routingLabel only surfaces if it survived the denylist (an override can't smuggle an
  // action label through as the routing label either).
  const routingLabel =
    matched.routingLabel !== undefined && proposedLabels.includes(matched.routingLabel)
      ? matched.routingLabel
      : null;

  return {
    ruleId: matched.id,
    routingLabel,
    proposedLabels,
    suggestedNextStep: matched.suggestedNextStep,
    kind: matched.kind,
  };
}

/**
 * Computes the additive label set to WRITE for an issue. Every existing label is preserved
 * and the wanted routing labels are unioned via authority.mergeLabels. This intentionally
 * leaves older routing labels in place rather than letting a replace-all API call remove data.
 */
export function nextReviewLabels(existing: readonly string[], wanted: readonly string[]): string[] {
  return mergeLabels([...existing], [...wanted]);
}
