export function replacementLabelsToCopy(
  sourceLabelSets: Iterable<Iterable<string>>,
  requiredLabels: Iterable<string> = [],
): string[] {
  const labels = new Map<string, string>();
  for (const sourceLabels of sourceLabelSets) {
    for (const label of sourceLabels) {
      addSourceLabel(labels, label);
    }
  }
  for (const label of requiredLabels) {
    addLabel(labels, label);
  }
  return [...labels.values()];
}

export function replacementSourceLabelCopyable(value: string): boolean {
  const label = String(value ?? "").trim();
  if (!label) return false;
  const key = label.toLowerCase();
  if (key === "stale") return false;
  if (
    key.startsWith("close:") ||
    key.startsWith("merge-risk:") ||
    key.startsWith("proof:") ||
    key.startsWith("rating:") ||
    key.startsWith("size:") ||
    key.startsWith("status:")
  ) {
    return false;
  }
  if (key === "triage: needs-real-behavior-proof" || key === "triage: needs-pr-context") {
    return false;
  }
  if (/^p[0-3]$/.test(key)) return false;
  return true;
}

function addSourceLabel(labels: Map<string, string>, value: string) {
  if (!replacementSourceLabelCopyable(value)) return;
  addLabel(labels, value);
}

function addLabel(labels: Map<string, string>, value: string) {
  const label = String(value ?? "").trim();
  if (!label) return;
  const key = label.toLowerCase();
  if (!labels.has(key)) labels.set(key, label);
}
