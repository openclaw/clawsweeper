// Selection coverage concerns the stored corpus only, never live GitHub or hydration coverage.
export const REPOSITORY_COLLECTION_LIMIT = 10;
export type CollectionName = "stale" | "maintainer" | "security" | "closes";
export type RepositoryCollection<T> = {
  items: T[];
  total: number | null;
  limit: number;
  selection: "repository-before-limit" | "legacy-unknown";
};
export type RepositoryCollections<T> = Record<CollectionName, RepositoryCollection<T>>;

export function boundedRepositoryCollection<T>(
  items: T[],
  total: number | null | undefined,
  selection: RepositoryCollection<T>["selection"],
): RepositoryCollection<T> {
  const knownTotal =
    typeof total === "number" && Number.isSafeInteger(total) && total >= items.length;
  return {
    items: items.slice(0, REPOSITORY_COLLECTION_LIMIT),
    total: knownTotal ? total : null,
    limit: REPOSITORY_COLLECTION_LIMIT,
    selection: knownTotal ? selection : "legacy-unknown",
  };
}

// Old site snapshots contain only globally capped lists. Keep any observed rows,
// but never turn their absence into a repository all-clear. Preserve row extensions.
export function repositoryCollection<T extends { repo: string }>(
  collection: RepositoryCollection<T> | undefined,
  repo: string,
  fallback: T[],
  expectedTotal?: number,
): RepositoryCollection<T> {
  if (!collection || !Array.isArray(collection.items))
    return boundedRepositoryCollection(
      fallback.filter((item) => item.repo === repo),
      expectedTotal,
      "legacy-unknown",
    );
  const mine = collection.items.filter((item) => item.repo === repo);
  if (expectedTotal !== undefined && collection.total !== expectedTotal)
    return boundedRepositoryCollection(mine, expectedTotal, "legacy-unknown");
  return boundedRepositoryCollection(
    mine,
    mine.length === collection.items.length ? collection.total : null,
    collection.selection === "repository-before-limit" ? collection.selection : "legacy-unknown",
  );
}

export function repositoryCollectionStatus<T>(collection: RepositoryCollection<T>) {
  const { items, total, selection } = collection;
  const empty = selection === "repository-before-limit" && total === 0 && items.length === 0;
  if (empty) return { empty, message: "No matches in the stored corpus snapshot." };
  const count = (value: number) => value.toLocaleString("en-US");
  const observed = items.length
    ? total === null
      ? `Showing ${count(items.length)} observed stored-corpus matches.`
      : `Showing ${count(items.length)} of ${count(total)} stored-corpus matches.`
    : total === null || total === 0
      ? "Repository-specific data is unavailable in this snapshot."
      : `${count(total)} stored-corpus matches recorded; rows are unavailable in this snapshot.`;
  return {
    empty: false,
    message:
      selection === "legacy-unknown"
        ? `${observed} Selection coverage is unknown until the corpus refreshes.`
        : observed,
  };
}
