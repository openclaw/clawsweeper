// Hydration inputs are a run-local cache, not review evidence. Limit removal to
// the leading header so quoted examples and the review itself stay byte-identical.
export function reportWithoutHydrationCache(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, (header) =>
    header
      .split("\n")
      .filter((line) => !line.startsWith("pr_hydration_snapshot:"))
      .join("\n"),
  );
}
