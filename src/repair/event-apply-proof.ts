import type { LooseRecord } from "./json-types.js";

export type EventApplyAction = {
  number: number | null;
  action: string;
  durableReviewSynced: boolean;
  terminalStateVerified: boolean;
};

export function exactEventApplyProof(
  actions: readonly EventApplyAction[],
  itemNumber: number,
): {
  exactActions: EventApplyAction[];
  syncedCount: number;
  terminalCount: number;
} {
  const exactActions = actions.filter((entry) => entry.number === itemNumber);
  return {
    exactActions,
    syncedCount: exactActions.filter((entry) => entry.durableReviewSynced).length,
    terminalCount: exactActions.filter((entry) => entry.terminalStateVerified).length,
  };
}

export function eventApplyAction(value: LooseRecord): EventApplyAction {
  return {
    number: typeof value.number === "number" ? value.number : null,
    action: typeof value.action === "string" ? value.action : "",
    durableReviewSynced: value.durableReviewSynced === true,
    terminalStateVerified: value.terminalStateVerified === true,
  };
}
