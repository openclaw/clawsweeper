import { PUBLIC_CODEX_MODEL } from "./codex-env.js";
import {
  CLOSE_PROTECTED_LABEL_NAMES,
  PR_AUTO_CLOSE_EXEMPT_LABEL_NAMES,
} from "./repair/exact-review-guard-labels.js";
import type {
  AgentsPolicyStatusKind,
  AutoImplementationCandidate,
  CloseReason,
  Confidence,
  DecisionKind,
  FeatureShowcaseStatus,
  ImpactLabelName,
  ImplementationComplexity,
  ItemCategory,
  LiveProofPlanStatus,
  LiveProofPayoffKind,
  LiveProofSurface,
  LiveProofTerminalCompletion,
  MantisRecommendationScenario,
  MantisRecommendationStatus,
  MaturityLabelName,
  MergeRiskLabelName,
  MergeRiskOptionCategory,
  OverallCorrectness,
  PrRatingTier,
  PrStatusLabelKind,
  RealBehaviorProofEvidenceKind,
  RealBehaviorProofStatus,
  ReproductionStatus,
  ReviewLabelName,
  RootCauseRelationship,
  SecurityConcernSeverity,
  SecurityReviewStatus,
  TelegramVisibleProofStatus,
  TriagePriority,
  VisionFitStatus,
  WorkCandidateKind,
} from "./clawsweeper-types.js";

/** Central review labels, thresholds, schema allow-lists, and automation policy. */

export const FRESH_DAYS = 7;
export const HOT_REVIEW_DAYS = 7;
export const RECENT_ISSUE_DAYS = 30;
export const DEFAULT_BACKFILL_REVIEW_AGE_MINUTES = 360;
export const DAILY_REVIEW_DAYS = 1;
export const STALE_INSUFFICIENT_INFO_MIN_AGE_DAYS = 60;
export const STALE_INSUFFICIENT_INFO_MIN_INACTIVE_DAYS = 60;
export const UNCONFIRMED_PRODUCT_DIRECTION_MIN_AGE_DAYS = 14;
export const UNCONFIRMED_PRODUCT_DIRECTION_MIN_INACTIVE_DAYS = 7;
export const UNSPONSORED_FEATURE_MIN_AGE_DAYS = 90;
export const UNSPONSORED_FEATURE_MIN_INACTIVE_DAYS = 60;
export const AUTHOR_PR_BUDGET_MIN_AGE_DAYS = 7;
export const AUTHOR_PR_BUDGET_MIN_INACTIVE_DAYS = 7;
export const STALE_VERSION_BUG_MIN_AGE_DAYS = 120;
export const STALE_VERSION_BUG_MIN_INACTIVE_DAYS = 90;
export const OBSOLETE_FIX_PR_MIN_AGE_DAYS = 90;
export const OBSOLETE_FIX_PR_MIN_INACTIVE_DAYS = 30;
export const OBSOLETE_FIX_PR_MAX_CHANGED_FILES = 5;
export const DEFAULT_AUTHOR_PR_BUDGET = 15;
export const DEFAULT_AUTHOR_PR_BUDGET_MAX_CLOSES_PER_RUN = 5;
export const DEFAULT_BULK_FILER_THRESHOLD = 10;
export const DEFAULT_BULK_FILER_WINDOW_DAYS = 7;
export const BULK_FILER_SEARCH_TIMEOUT_MS = 15_000;
export const BULK_FILED_LABEL = "clawsweeper:bulk-filed";
export const BULK_FILED_LABEL_DEFINITION = {
  name: BULK_FILED_LABEL,
  color: "6E7781",
  description: "ClawSweeper detected a high recent issue-filing volume from this author.",
} as const;
export const STALLED_UNPROVEN_PR_MIN_AGE_DAYS = 14;
export const STALLED_UNPROVEN_PR_MIN_INACTIVE_DAYS = 14;
export const ABANDONED_PR_MIN_AGE_DAYS = 30;
export const ABANDONED_PR_MIN_INACTIVE_DAYS = 30;
export const LOW_SIGNAL_UNMERGEABLE_PR_MIN_INACTIVE_DAYS = 30;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const RECENT_MISSING_OPEN_MS = DAY_MS;
export const DEFAULT_CODEX_MODEL = PUBLIC_CODEX_MODEL;
export const DEFAULT_REASONING_EFFORT = "high";
// Priority service tier for Codex calls (maintainer decision 2026-07-17:
// "gpt 5.6 sol high fast"). Latency-only; excluded from review-policy hashing.
export const DEFAULT_SERVICE_TIER = "fast";
export const DEFAULT_REVIEW_CODEX_TIMEOUT_MS = 1_200_000;
export const REVIEW_POLICY_VERSION = "2026-08-28-policy-v25";
export const REVIEW_COMMENT_MARKER_PREFIX = "<!-- clawsweeper-review";
export const REVIEW_START_STATUS_MARKER_PREFIX = "<!-- clawsweeper-review-status";
export const MERGE_READY_LABEL = "clawsweeper:merge-ready";
export const PR_AUTO_CLOSE_EXEMPT_LABELS = new Set<string>(PR_AUTO_CLOSE_EXEMPT_LABEL_NAMES);
export const WAITING_ON_AUTHOR_LABEL = "status: ⏳ waiting on author";
export const PROOF_OVERRIDE_LABEL = "proof: override";
export const AUTHORITY_CHAIN_PROOF_MARKER = "Authority-chain proof required:";
export const PROOF_SUFFICIENT_LABEL = "proof: sufficient";
export const PROOF_NUDGE_MARKER_PREFIX = "<!-- clawsweeper-proof-nudge";
export const LIVE_VERIFICATION_MARKER = "<!-- clawsweeper-live-verification -->";
export const LIVE_PROOF_RECORDING_MARKER = "<!-- clawsweeper-live-proof-recording -->";
export const PROOF_SUFFICIENT_LABEL_COLOR = "1A7F37";
export const PROOF_SUFFICIENT_LABEL_DESCRIPTION = "Contributor real behavior proof is sufficient.";
export const FEATURE_SHOWCASE_LABEL = "feature: ✨ showcase";
export const FEATURE_SHOWCASE_LABEL_COLOR = "A371F7";
export const FEATURE_SHOWCASE_LABEL_DESCRIPTION =
  "ClawSweeper spotlight: unusually compelling feature idea for maintainer attention.";
export const IDEA_ARCHIVE_LABEL_COLOR = "8250DF";
export const IDEA_ARCHIVE_LABEL_DESCRIPTION =
  "Parked feature idea eligible for automatic community or maintainer revival.";
export const PROOF_MEDIA_LABELS = [
  {
    evidenceKind: "screenshot",
    name: "proof: 📸 screenshot",
    color: "0969DA",
    description: "Contributor real behavior proof includes screenshot evidence.",
  },
  {
    evidenceKind: "recording",
    name: "proof: 🎥 video",
    color: "8250DF",
    description: "Contributor real behavior proof includes video or recording evidence.",
  },
] as const satisfies readonly {
  evidenceKind: RealBehaviorProofEvidenceKind;
  name: string;
  color: string;
  description: string;
}[];
export const PROOF_MEDIA_LABEL_NAMES = new Set<string>(
  PROOF_MEDIA_LABELS.map((label) => label.name),
);
export const PR_RATING_LABELS = [
  {
    tier: "S",
    name: "rating: 🦀 challenger crab",
    color: "1F883D",
    description: "Exceptional PR readiness: strong proof, clean patch, and convincing validation.",
  },
  {
    tier: "A",
    name: "rating: 🦞 diamond lobster",
    color: "0969DA",
    description: "Very strong PR readiness with only minor maintainer review expected.",
  },
  {
    tier: "B",
    name: "rating: 🐚 platinum hermit",
    color: "0F766E",
    description: "Good normal PR readiness with ordinary maintainer review expected.",
  },
  {
    tier: "C",
    name: "rating: 🦐 gold shrimp",
    color: "B7791F",
    description: "Decent PR readiness signal, but merge confidence is limited.",
  },
  {
    tier: "D",
    name: "rating: 🦪 silver shellfish",
    color: "7A828E",
    description: "Thin PR readiness signal; proof, validation, or implementation needs work.",
  },
  {
    tier: "F",
    name: "rating: 🧂 unranked krab",
    color: "8C2F39",
    description: "Not merge-ready due to missing proof or serious correctness/safety concerns.",
  },
  {
    tier: "NA",
    name: "rating: 🌊 off-meta tidepool",
    color: "6E7781",
    description: "PR readiness rating does not apply to this item.",
  },
] as const satisfies readonly {
  tier: PrRatingTier;
  name: string;
  color: string;
  description: string;
}[];
export const PR_RATING_LABEL_NAMES = new Set<string>(PR_RATING_LABELS.map((label) => label.name));
export const PR_STATUS_LABELS = [
  {
    kind: "automerge_armed",
    name: "status: 🚀 automerge armed",
    color: "0E8A16",
    description: "This PR is in ClawSweeper's automerge lane.",
  },
  {
    kind: "re_review_loop",
    name: "status: 🔁 re-review loop",
    color: "8250DF",
    description: "A fresh ClawSweeper review was explicitly requested after the latest review.",
  },
  {
    kind: "actively_grinding",
    name: "status: 🛠️ actively grinding",
    color: "0969DA",
    description: "The PR author has acted after the latest ClawSweeper review and work remains.",
  },
  {
    kind: "needs_proof",
    name: "status: 📣 needs proof",
    color: "D93F0B",
    description:
      "The PR needs real behavior proof before ClawSweeper can clear the contributor ask.",
  },
  {
    kind: "needs_maintainer_proof_decision",
    name: "status: needs maintainer proof decision",
    color: "D93F0B",
    description: "A ClawSweeper-authored PR needs a maintainer proof capture or override decision.",
  },
  {
    kind: "waiting_on_author",
    name: "status: ⏳ waiting on author",
    color: "FBCA04",
    description: "ClawSweeper has contributor-facing work open and is waiting for author action.",
  },
  {
    kind: "ready_for_maintainer_look",
    name: "status: 👀 ready for maintainer look",
    color: "2DA44E",
    description: "ClawSweeper has no concrete contributor-facing blocker left for this PR.",
  },
] as const satisfies readonly {
  kind: PrStatusLabelKind;
  name: string;
  color: string;
  description: string;
}[];
export const PR_STATUS_LABEL_NAMES = new Set<string>(PR_STATUS_LABELS.map((label) => label.name));
export const LEGACY_TELEGRAM_VISIBLE_PROOF_LABEL = "mantis: telegram-visible-proof";
export const TELEGRAM_VISIBLE_PROOF_LABEL = "proof: telegram-e2e";
export const TELEGRAM_VISIBLE_PROOF_LABEL_COLOR = "57606A";
export const TELEGRAM_VISIBLE_PROOF_LABEL_DESCRIPTION =
  "This PR needs Telegram Test Server proof with the repository E2E skill.";
export const PRIORITY_LABELS = [
  {
    priority: 0,
    triagePriority: "P0",
    name: "P0",
    color: "B60205",
    description: "Emergency: data loss, security bypass, crash loop, or unusable core runtime.",
  },
  {
    priority: 1,
    triagePriority: "P1",
    name: "P1",
    color: "D93F0B",
    description: "Urgent regression or broken agent/channel workflow affecting real users now.",
  },
  {
    priority: 2,
    triagePriority: "P2",
    name: "P2",
    color: "FBCA04",
    description: "Normal priority bug or improvement with limited blast radius.",
  },
  {
    priority: 3,
    triagePriority: "P3",
    name: "P3",
    color: "8C959F",
    description: "Low-risk cleanup, docs, polish, ergonomics, or speculative feature.",
  },
] as const;
export const PRIORITY_LABEL_NAMES: ReadonlySet<string> = new Set(
  PRIORITY_LABELS.map((label) => label.name),
);
export const IMPACT_LABELS = [
  {
    name: "impact:data-loss",
    color: "B60205",
    description:
      "This issue is about lost, corrupted, or silently dropped user/session/config data.",
  },
  {
    name: "impact:security",
    color: "B60205",
    description:
      "This issue is about security boundaries, credentials, authz, sandboxing, or sensitive data.",
  },
  {
    name: "impact:crash-loop",
    color: "D93F0B",
    description:
      "This issue is about crashes, hangs, restart loops, or process-level availability.",
  },
  {
    name: "impact:message-loss",
    color: "D93F0B",
    description: "This issue is about lost, duplicated, misrouted, or suppressed channel messages.",
  },
  {
    name: "impact:session-state",
    color: "F9D65C",
    description: "This issue is about session, memory, transcript, context, or agent state drift.",
  },
  {
    name: "impact:auth-provider",
    color: "F9D65C",
    description:
      "This issue is about auth, provider routing, model choice, or SecretRef resolution.",
  },
  {
    name: "impact:ux-release-blocker",
    color: "B60205",
    description: "A non-technical user is blocked without terminal, logs, config, or support.",
  },
  {
    name: "impact:ux-friction",
    color: "FBCA04",
    description:
      "User-facing flow adds avoidable confusion or support burden without fully blocking progress.",
  },
  {
    name: "impact:other",
    color: "C5DEF5",
    description: "This issue has meaningful maintainer-visible impact outside the owned taxonomy.",
  },
] as const satisfies readonly {
  name: ImpactLabelName;
  color: string;
  description: string;
}[];
export const IMPACT_LABEL_NAMES: ReadonlySet<string> = new Set(
  IMPACT_LABELS.map((label) => label.name),
);
export const MERGE_RISK_LABELS = [
  {
    name: "merge-risk: 🚨 compatibility",
    color: "D1242F",
    description:
      "🚨 Merging this PR could break existing users, config, migrations, defaults, or upgrades.",
  },
  {
    name: "merge-risk: 🚨 message-delivery",
    color: "D1242F",
    description:
      "🚨 Merging this PR could drop, duplicate, misroute, suppress, or wrongly target messages.",
  },
  {
    name: "merge-risk: 🚨 session-state",
    color: "F97316",
    description:
      "🚨 Merging this PR could lose, corrupt, stale, or mis-associate session or agent state.",
  },
  {
    name: "merge-risk: 🚨 auth-provider",
    color: "F97316",
    description:
      "🚨 Merging this PR could break OAuth, tokens, provider routing, model choice, or credentials.",
  },
  {
    name: "merge-risk: 🚨 security-boundary",
    color: "B60205",
    description:
      "🚨 Merging this PR could weaken sandboxing, authorization, credentials, or sensitive data.",
  },
  {
    name: "merge-risk: 🚨 availability",
    color: "D93F0B",
    description:
      "🚨 Merging this PR could cause crashes, hangs, restart loops, stalls, or process outages.",
  },
  {
    name: "merge-risk: 🚨 automation",
    color: "FBCA04",
    description:
      "🚨 Merging this PR could break CI, automerge, proof capture, label sync, or automation.",
  },
  {
    name: "merge-risk: 🚨 other",
    color: "C5DEF5",
    description: "🚨 Merging this PR has meaningful risk outside the owned taxonomy.",
  },
] as const satisfies readonly {
  name: MergeRiskLabelName;
  color: string;
  description: string;
}[];
export const MERGE_RISK_LABEL_NAMES: ReadonlySet<string> = new Set(
  MERGE_RISK_LABELS.map((label) => label.name),
);
export const MATURITY_LABELS = [
  {
    name: "maturity:stable",
    color: "1F883D",
    description: "Broken existing behavior primarily owned by an M4/M5 scorecard surface.",
  },
] as const satisfies readonly {
  name: MaturityLabelName;
  color: string;
  description: string;
}[];
export const MATURITY_LABEL_NAMES: ReadonlySet<string> = new Set(
  MATURITY_LABELS.map((label) => label.name),
);
export const GOOD_FIRST_ISSUE_LABEL = "good first issue";
export const GOOD_FIRST_ISSUE_LABEL_DEFINITION = {
  name: GOOD_FIRST_ISSUE_LABEL,
  color: "7057FF",
  description: "Good for newcomers",
} as const;
export const ISSUE_ADVISORY_LABELS = [
  {
    name: "issue-rating: 🦀 challenger crab",
    color: "1F883D",
    description:
      "Exceptional issue quality: high-confidence current-main reproduction and actionable evidence.",
  },
  {
    name: "issue-rating: 🦞 diamond lobster",
    color: "0969DA",
    description:
      "Very strong issue quality with high-confidence source-level or clear reproduction.",
  },
  {
    name: "issue-rating: 🐚 platinum hermit",
    color: "0F766E",
    description: "Good issue quality with a plausible reproduction path needing some confirmation.",
  },
  {
    name: "issue-rating: 🦐 gold shrimp",
    color: "B7791F",
    description: "Decent issue quality, but reproduction details are still incomplete.",
  },
  {
    name: "issue-rating: 🦪 silver shellfish",
    color: "7A828E",
    description: "Thin issue quality; more reproduction proof or environment detail is needed.",
  },
  {
    name: "issue-rating: 🧂 unranked krab",
    color: "8C2F39",
    description: "Issue quality is currently too unclear to act on safely.",
  },
  {
    name: "issue-rating: 🌊 off-meta tidepool",
    color: "6E7781",
    description: "Issue quality rating does not apply to this item.",
  },
  {
    name: "clawsweeper:current-main-repro",
    color: "0A3069",
    description: "ClawSweeper found a high-confidence current-main issue reproduction.",
  },
  {
    name: "clawsweeper:source-repro",
    color: "0A3069",
    description: "ClawSweeper found a high-confidence source-level issue reproduction.",
  },
  {
    name: "clawsweeper:not-repro-on-main",
    color: "2DA44E",
    description:
      "ClawSweeper found high-confidence evidence that this issue no longer reproduces on main.",
  },
  {
    name: "clawsweeper:needs-live-repro",
    color: "FBCA04",
    description:
      "ClawSweeper needs live local, crabbox, or manual validation to confirm this issue.",
  },
  {
    name: "clawsweeper:needs-info",
    color: "6E7781",
    description: "ClawSweeper needs more reporter information before it can verify this issue.",
  },
  {
    name: "clawsweeper:linked-pr-open",
    color: "57606A",
    description: "ClawSweeper found an open linked pull request for this issue.",
  },
  {
    name: "clawsweeper:no-new-fix-pr",
    color: "8C959F",
    description: "ClawSweeper does not recommend queueing a new automated fix PR for this issue.",
  },
  {
    name: "clawsweeper:queueable-fix",
    color: "0E8A16",
    description: "ClawSweeper marked this issue as an existing queue_fix_pr work candidate.",
  },
  {
    name: "clawsweeper:fix-shape-clear",
    color: "1A7F37",
    description: "ClawSweeper found a clear likely implementation shape for this issue.",
  },
  {
    name: "clawsweeper:needs-maintainer-review",
    color: "FBCA04",
    description: "ClawSweeper marked this issue as needing maintainer review before automation.",
  },
  {
    name: "clawsweeper:needs-product-decision",
    color: "FBCA04",
    description: "ClawSweeper marked this issue as needing a product or behavior decision.",
  },
  {
    name: "clawsweeper:needs-security-review",
    color: "B60205",
    description: "ClawSweeper marked this issue as needing security-sensitive review.",
  },
] as const;
export const ISSUE_ADVISORY_LABEL_NAMES = new Set(
  ISSUE_ADVISORY_LABELS.map((label) => label.name.toLowerCase()),
);
export const STALE_LABEL = "stale";
export const NO_STALE_LABEL = "no-stale";
export const QUEUEABLE_FIX_LABEL = "clawsweeper:queueable-fix";
export const ISSUE_STALE_PROTECTION_LABEL = {
  name: NO_STALE_LABEL,
  color: "6E7781",
  description: "Exempts this issue from stale automation.",
} as const;
export const PROTECTED_LABELS = new Set<string>(CLOSE_PROTECTED_LABEL_NAMES);
export const APPLY_PROTECTED_LABELS = new Set<string>([
  ...CLOSE_PROTECTED_LABEL_NAMES,
  "clawsweeper:needs-security-review",
  "clawsweeper:needs-maintainer-review",
  "clawsweeper:needs-product-decision",
]);
export const ALLOWED_REASONS = new Set<CloseReason>([
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
export const ALL_REASONS = new Set<CloseReason>([...ALLOWED_REASONS, "none"]);
export const DECISIONS = new Set<DecisionKind>(["close", "keep_open"]);
export const WORK_CANDIDATES = new Set<WorkCandidateKind>([
  "none",
  "manual_review",
  "queue_fix_pr",
]);
export const VISION_FIT_STATUSES = new Set<VisionFitStatus>([
  "aligned",
  "rejected",
  "unclear",
  "not_applicable",
]);
export const IMPLEMENTATION_COMPLEXITIES = new Set<ImplementationComplexity>([
  "small",
  "medium",
  "large",
  "unclear",
  "not_applicable",
]);
export const AUTO_IMPLEMENTATION_CANDIDATES = new Set<AutoImplementationCandidate>([
  "none",
  "strict_bug",
  "vision_fit",
]);
export const TRIAGE_PRIORITIES = new Set<TriagePriority>(["P0", "P1", "P2", "P3", "none"]);
export const ITEM_CATEGORIES = new Set<ItemCategory>([
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
export const PAIR_BLOCKED_CLOSE_ACTIONS = new Set<string>([
  "skipped_open_closing_pr",
  "skipped_same_author_pair",
]);
export const CLOSED_STATE_PROBE_ACTIONS = new Set<string>([
  "skipped_already_closed",
  "skipped_changed_since_review",
  "skipped_maintainer_authored",
  "skipped_protected_label",
  "skipped_close_exempt_label",
  "skipped_pr_close_coverage_proof",
  "skipped_invalid_decision",
  "skipped_open_closing_pr",
  "skipped_same_author_pair",
  "skipped_locked_conversation",
  "retry_stale_canonical_comment_sync",
]);
export const EVENT_GUARDED_OPEN_ACTIONS = new Set<string>([
  "skipped_locked_conversation",
  "skipped_maintainer_authored",
  "skipped_open_closing_pr",
  "skipped_protected_label",
  "skipped_close_exempt_label",
  "skipped_low_signal_live_guard",
  "skipped_same_author_pair",
]);
export const REPRODUCTION_STATUSES = new Set<ReproductionStatus>([
  "reproduced",
  "source_reproducible",
  "not_reproduced",
  "unclear",
  "not_applicable",
]);
export const SECURITY_REVIEW_STATUSES = new Set<SecurityReviewStatus>([
  "cleared",
  "needs_attention",
  "not_applicable",
]);
export const SECURITY_CONCERN_SEVERITIES = new Set<SecurityConcernSeverity>([
  "high",
  "medium",
  "low",
]);
export const IMPACT_LABEL_VALUES = new Set<ImpactLabelName>(
  IMPACT_LABELS.map((label) => label.name),
);
export const MERGE_RISK_LABEL_VALUES = new Set<MergeRiskLabelName>(
  MERGE_RISK_LABELS.map((label) => label.name),
);
export const MATURITY_LABEL_VALUES = new Set<MaturityLabelName>(
  MATURITY_LABELS.map((label) => label.name),
);
export const REVIEW_LABEL_VALUES = new Set<ReviewLabelName>([
  "P0",
  "P1",
  "P2",
  "P3",
  ...IMPACT_LABELS.map((label) => label.name),
  ...MERGE_RISK_LABELS.map((label) => label.name),
  ...MATURITY_LABELS.map((label) => label.name),
]);
export const REAL_BEHAVIOR_PROOF_STATUSES = new Set<RealBehaviorProofStatus>([
  "sufficient",
  "missing",
  "mock_only",
  "insufficient",
  "not_applicable",
  "override",
]);
export const PR_RATING_TIERS = new Set<PrRatingTier>(["S", "A", "B", "C", "D", "F", "NA"]);
export const REAL_BEHAVIOR_PROOF_EVIDENCE_KINDS = new Set<RealBehaviorProofEvidenceKind>([
  "screenshot",
  "recording",
  "terminal",
  "logs",
  "live_output",
  "linked_artifact",
  "none",
  "not_applicable",
]);
export const TELEGRAM_VISIBLE_PROOF_STATUSES = new Set<TelegramVisibleProofStatus>([
  "needed",
  "not_needed",
]);
export const LIVE_PROOF_PLAN_STATUSES = new Set<LiveProofPlanStatus>([
  "recommended",
  "not_applicable",
  "declined_suspicious",
]);
export const LIVE_PROOF_SURFACES = new Set<LiveProofSurface>(["browser", "terminal", "none"]);
export const LIVE_PROOF_TERMINAL_COMPLETIONS = new Set<LiveProofTerminalCompletion>([
  "exit_zero",
  "ready_while_running",
  "not_applicable",
]);
export const LIVE_PROOF_PAYOFF_KINDS = new Set<LiveProofPayoffKind>([
  "progressive_output",
  "ui_interaction",
  "tui_or_color",
  "animation",
  "static_text",
]);
export const MANTIS_RECOMMENDATION_STATUSES = new Set<MantisRecommendationStatus>([
  "recommended",
  "not_recommended",
]);
export const MANTIS_RECOMMENDATION_SCENARIOS = new Set<MantisRecommendationScenario>([
  "none",
  "discord_status_reactions",
  "discord_thread_attachment",
  "web_ui_chat_proof",
  "slack_desktop_smoke",
  "visual_task",
]);
export const FEATURE_SHOWCASE_STATUSES = new Set<FeatureShowcaseStatus>(["showcase", "none"]);
export const OVERALL_CORRECTNESS_VALUES = new Set<OverallCorrectness>([
  "patch is correct",
  "patch is incorrect",
  "not a patch",
]);
export const CONFIDENCES = new Set<Confidence>(["high", "medium", "low"]);
export const AGENTS_POLICY_STATUSES = new Set<AgentsPolicyStatusKind>([
  "found_applied",
  "found_not_applicable",
  "not_found",
  "conflict_not_applied",
  "unreadable_or_unclear",
]);
export const MERGE_RISK_OPTION_CATEGORIES = new Set<MergeRiskOptionCategory>([
  "fix_before_merge",
  "accept_risk",
  "pause_or_close",
]);
export const ROOT_CAUSE_RELATIONSHIPS = new Set<RootCauseRelationship>([
  "canonical",
  "duplicate",
  "same_root_cause",
  "partial_overlap",
  "adjacent_distinct",
  "superseded",
  "fixed_by_candidate",
  "independent",
  "security_route",
  "needs_human",
]);
export const DECISION_SCHEMA_KEYS = new Set([
  "decision",
  "closeReason",
  "confidence",
  "summary",
  "changeSummary",
  "systemContext",
  "architectureDiagram",
  "evidence",
  "likelyOwners",
  "risks",
  "bestSolution",
  "maintainerDecision",
  "triagePriority",
  "impactLabels",
  "mergeRiskLabels",
  "maturityLabels",
  "mergeRiskOptions",
  "reviewMetrics",
  "labelJustifications",
  "itemCategory",
  "reproductionStatus",
  "reproductionConfidence",
  "requiresNewFeature",
  "requiresNewConfigOption",
  "requiresProductDecision",
  "reproductionAssessment",
  "solutionAssessment",
  "visionFit",
  "visionFitReason",
  "visionFitEvidence",
  "implementationComplexity",
  "autoImplementationCandidate",
  "rootCauseCluster",
  "agentsPolicyStatus",
  "reviewFindings",
  "securityReview",
  "realBehaviorProof",
  "prRating",
  "telegramVisibleProof",
  "liveProofPlan",
  "mantisRecommendation",
  "featureShowcase",
  "overallCorrectness",
  "overallConfidenceScore",
  "fixedRelease",
  "fixedSha",
  "fixedAt",
  "regressionAssessment",
  "regressionProvenance",
  "closeComment",
  "workCandidate",
  "workConfidence",
  "workPriority",
  "workReason",
  "workPrompt",
  "workClusterRefs",
  "workValidation",
  "workLikelyFiles",
]);
export const REGRESSION_PROVENANCE_SCHEMA_KEYS = new Set([
  "repo",
  "pullRequestNumber",
  "pullRequestUrl",
  "mergeCommitSha",
  "sourcePath",
  "sourceLine",
]);
export const REGRESSION_ASSESSMENT_SCHEMA_KEYS = new Set(["confidence", "supportingEvidence"]);
export const REGRESSION_ASSESSMENT_CONFIDENCES = new Set(["suspected", "probable"]);
export const REGRESSION_SUPPORTING_EVIDENCE = new Set([
  "reproduction",
  "reviewed_change",
  "failure_trace",
  "known_regression_link",
]);
export const EVIDENCE_SCHEMA_KEYS = new Set([
  "repo",
  "label",
  "detail",
  "file",
  "line",
  "command",
  "sha",
]);
export const SECURITY_REVIEW_SCHEMA_KEYS = new Set(["status", "summary", "concerns"]);
export const REAL_BEHAVIOR_PROOF_SCHEMA_KEYS = new Set([
  "status",
  "summary",
  "evidenceKind",
  "needsContributorAction",
]);
export const PR_RATING_SCHEMA_KEYS = new Set([
  "proofTier",
  "patchTier",
  "overallTier",
  "summary",
  "nextSteps",
]);
export const TELEGRAM_VISIBLE_PROOF_SCHEMA_KEYS = new Set(["status", "summary"]);
export const LIVE_PROOF_PLAN_SCHEMA_KEYS = new Set([
  "status",
  "surface",
  "terminalCompletion",
  "reason",
  "payoff",
  "entry",
  "steps",
]);
export const LIVE_PROOF_PAYOFF_SCHEMA_KEYS = new Set(["kind", "justification"]);
export const LIVE_PROOF_STEP_SCHEMA_KEYS = {
  goto: new Set(["action", "path"]),
  click: new Set(["action", "target"]),
  fill: new Set(["action", "target", "value"]),
  press: new Set(["action", "key"]),
  wait_for: new Set(["action", "target"]),
  wait: new Set(["action", "seconds"]),
  expect_text: new Set(["action", "text"]),
  run: new Set(["action", "command"]),
  expect_output: new Set(["action", "text"]),
} as const;
export const MANTIS_RECOMMENDATION_SCHEMA_KEYS = new Set([
  "status",
  "scenario",
  "reason",
  "maintainerComment",
]);
export const FEATURE_SHOWCASE_SCHEMA_KEYS = new Set(["status", "reason"]);
export const ROOT_CAUSE_CLUSTER_SCHEMA_KEYS = new Set([
  "confidence",
  "canonicalRef",
  "currentItemRelationship",
  "summary",
  "members",
]);
export const ROOT_CAUSE_CLUSTER_MEMBER_SCHEMA_KEYS = new Set(["ref", "relationship", "reason"]);
export const AGENTS_POLICY_STATUS_SCHEMA_KEYS = new Set([
  "found",
  "readFully",
  "applied",
  "status",
  "summary",
]);
export const MERGE_RISK_OPTION_SCHEMA_KEYS = new Set([
  "title",
  "body",
  "category",
  "recommended",
  "automergeInstruction",
]);
export const REVIEW_METRIC_SCHEMA_KEYS = new Set(["label", "value", "reason"]);
export const LABEL_JUSTIFICATION_SCHEMA_KEYS = new Set(["label", "reason"]);
export const SECURITY_CONCERN_SCHEMA_KEYS = new Set([
  "title",
  "body",
  "severity",
  "confidenceScore",
  "file",
  "line",
]);
export const REVIEW_FINDING_SCHEMA_KEYS = new Set([
  "title",
  "body",
  "priority",
  "confidenceScore",
  "file",
  "lineStart",
  "lineEnd",
  "lateFinding",
]);
export const LIKELY_OWNER_SCHEMA_KEYS = new Set([
  "person",
  "role",
  "reason",
  "commits",
  "files",
  "confidence",
  "history",
]);
export const REVIEW_SECTIONS = {
  summary: "Summary",
  changeSummary: "What This Changes",
  systemContext: "System Context",
  architectureDiagram: "Architecture Diagram",
  bestSolution: "Best Possible Solution",
  maintainerDecision: "Maintainer Decision",
  reproductionAssessment: "Reproduction Assessment",
  solutionAssessment: "Solution Assessment",
  visionFit: "Vision Fit",
  rootCauseCluster: "Root-Cause Cluster",
  reviewFindings: "Review Findings",
  securityReview: "Security Review",
  realBehaviorProof: "Real Behavior Proof",
  prRating: "PR Rating",
  telegramVisibleProof: "Telegram Visible Proof",
  liveProof: "Live Proof",
  mantisRecommendation: "Mantis Recommendation",
  featureShowcase: "Feature Showcase",
  agentsPolicyStatus: "AGENTS.md Policy Status",
  workCandidate: "Work Candidate",
  repairWorkPrompt: "Repair Work Prompt",
  evidence: "Evidence",
  likelyOwners: "Likely Related People",
  risks: "Risks / Open Questions",
  closeComment: "Close Comment",
} as const;
export const PR_CLOSE_COVERAGE_PROOF_SECTION = "PR Close Coverage Proof";
