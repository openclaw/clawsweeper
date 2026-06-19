import type { JsonValue } from "./json-types.js";

export type RebaseConflictEditDecision =
  | { action: "proceed" }
  | { action: "retry"; reason: string }
  | { action: "needs_human"; reason: string };

export function rebaseConflictEditDecision({
  rebaseStatus,
  unmergedPaths,
  attempt,
  maxEditAttempts,
}: {
  rebaseStatus: JsonValue;
  unmergedPaths: string[];
  attempt: number;
  maxEditAttempts: number;
}): RebaseConflictEditDecision {
  if (rebaseStatus !== "conflicts" || unmergedPaths.length === 0) {
    return { action: "proceed" };
  }

  const reason = `rebase conflicts remain unresolved: ${unmergedPaths.join(", ")}`;
  if (attempt >= maxEditAttempts) return { action: "needs_human", reason };
  return { action: "retry", reason };
}

export function unresolvedRebaseConflictReason(error: JsonValue): string | null {
  const message = String(error?.message ?? error ?? "");
  return /rebase (?:conflicts remain unresolved|produced additional conflicts):/i.test(message)
    ? message
    : null;
}
