import { AUTOFIX_LABEL, AUTOMERGE_LABEL } from "./exact-review-guard-labels.js";

export const SECURITY_REPAIR_OPT_IN_LABELS = new Set([AUTOFIX_LABEL, AUTOMERGE_LABEL]);

export function hasSecurityRepairOptInLabel(labels: Iterable<unknown> | null | undefined) {
  for (const label of labels ?? []) {
    const name = String(label ?? "")
      .trim()
      .toLowerCase();
    if (SECURITY_REPAIR_OPT_IN_LABELS.has(name)) return true;
  }
  return false;
}
