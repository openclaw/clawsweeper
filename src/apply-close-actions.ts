const SELECTABLE_CLOSE_ACTIONS = new Set([
  "proposed_close",
  "retry_pr_close_coverage_proof",
  "kept_open",
  "skipped_low_signal_live_guard",
  "skipped_open_closing_pr",
  "skipped_same_author_pair",
]);

export const LIVE_RECHECK_CLOSE_GUARD_ACTIONS = [
  "skipped_protected_label",
  "skipped_close_exempt_label",
  "skipped_locked_conversation",
] as const;

export const LEGACY_FIXED_CLOSE_SKIP_ACTIONS = [
  "skipped_maintainer_authored",
  "skipped_invalid_decision",
] as const;

const LIVE_RECHECK_CLOSE_GUARDS = new Set<string>(LIVE_RECHECK_CLOSE_GUARD_ACTIONS);
const LEGACY_FIXED_CLOSE_SKIPS = new Set<string>(LEGACY_FIXED_CLOSE_SKIP_ACTIONS);

export function isLiveRecheckCloseGuardAction(action: string): boolean {
  return LIVE_RECHECK_CLOSE_GUARDS.has(action);
}

export function isLegacyFixedCloseSkipAction(action: string, reason: string): boolean {
  return LEGACY_FIXED_CLOSE_SKIPS.has(action) && reason === "implemented_on_main";
}

export function isSelectableApplyCloseAction(action: string, reason: string): boolean {
  return (
    SELECTABLE_CLOSE_ACTIONS.has(action) ||
    isLiveRecheckCloseGuardAction(action) ||
    isLegacyFixedCloseSkipAction(action, reason)
  );
}
