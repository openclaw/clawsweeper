export interface AuditTarget {
  targetRepo: string;
  defaultBranch: string;
  visibility: string;
}

export interface AuditWaveState {
  remainingTargets: AuditTarget[];
  outstandingRunIds: string[];
  // Written before dispatch so a lost receipt cannot silently free a slot.
  dispatchingTarget: string | null;
}

export function parseAuditWaveState(value: unknown): AuditWaveState | null {
  if (value === null) return null;
  if (typeof value !== "object" || !value) throw new Error("invalid audit wave state");
  const state = value as Record<string, unknown>;
  if (
    !Array.isArray(state.remainingTargets) ||
    !state.remainingTargets.every(
      (target) =>
        target &&
        typeof target === "object" &&
        typeof target.targetRepo === "string" &&
        /^[\w.-]+\/[\w.-]+$/.test(target.targetRepo) &&
        typeof target.defaultBranch === "string" &&
        target.visibility === "PUBLIC",
    ) ||
    !Array.isArray(state.outstandingRunIds) ||
    !state.outstandingRunIds.every((id) => typeof id === "string" && /^[1-9]\d*$/.test(id)) ||
    new Set(state.outstandingRunIds).size !== state.outstandingRunIds.length ||
    !(
      state.dispatchingTarget === null ||
      (typeof state.dispatchingTarget === "string" &&
        state.remainingTargets.some((target) => target.targetRepo === state.dispatchingTarget))
    )
  )
    throw new Error("invalid audit wave state");
  return {
    remainingTargets: state.remainingTargets.map((target) => ({
      targetRepo: target.targetRepo,
      defaultBranch: target.defaultBranch,
      visibility: target.visibility,
    })),
    outstandingRunIds: [...state.outstandingRunIds],
    dispatchingTarget: typeof state.dispatchingTarget === "string" ? state.dispatchingTarget : null,
  };
}
