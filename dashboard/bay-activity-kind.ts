/** A closed work identity, independent of the current visual stage. */
export type PublicBayActivityKind = "review" | "repair";

export function publicBayActivityKind(value: unknown): PublicBayActivityKind | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const worker = value as Record<string, unknown>;
  // Use producer classifications, never titles, step prose, or the repairing
  // stage: an ordinary review can enter that stage while running checks.
  if (
    worker.work_kind === "pr_repair" ||
    worker.work_kind === "repair_cluster" ||
    worker.mode === "repair"
  ) {
    return "repair";
  }
  if (
    typeof worker.mode === "string" &&
    ["exact-review", "background-review", "hot-review", "commit-review"].includes(worker.mode)
  ) {
    return "review";
  }
  return undefined;
}

export function normalizePublicBayActivityKind(value: unknown): PublicBayActivityKind | undefined {
  return value === "review" || value === "repair" ? value : undefined;
}
