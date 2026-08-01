import type { CloseReason } from "./clawsweeper-types.js";

export function closeReasonText(reason: CloseReason): string {
  switch (reason) {
    case "implemented_on_main":
      return "already implemented on main";
    case "mostly_implemented_on_main":
      return "mostly implemented on main";
    case "cannot_reproduce":
      return "cannot reproduce on current main";
    case "clawhub":
      return "belongs on ClawHub";
    case "duplicate_or_superseded":
      return "duplicate or superseded";
    case "low_signal_unmergeable_pr":
      return "low-signal unmergeable PR";
    case "stalled_unproven_pr":
      return "stalled PR without requested real-behavior proof";
    case "abandoned_pr":
      return "abandoned inactive PR";
    case "unconfirmed_product_direction":
      return "feature-like PR without confirmed product direction";
    case "unsponsored_feature_request":
      return "feature request without maintainer sponsorship";
    case "author_pr_budget_exceeded":
      return "lowest-signal PR over the author's open-PR budget";
    case "stale_version_bug":
      return "bug report against a stale version";
    case "obsolete_fix_pr":
      return "fix made obsolete by later main-branch changes";
    case "not_actionable_in_repo":
      return "not actionable in this repository";
    case "incoherent":
      return "too unclear to act on";
    case "stale_insufficient_info":
      return "stale with insufficient information";
    case "none":
      return "kept open";
  }
}
