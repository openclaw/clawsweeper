type AttentionItem = {
  repo: string;
  number: number;
  kind: string;
  reviewedAt: string | null;
  triagePriority?: string | null;
};

export function reviewerPriority(value: unknown): string | null {
  return typeof value === "string" && /^P[0-3]$/.test(value) ? value : null;
}

export function compareAttention(a: AttentionItem, b: AttentionItem): number {
  const rank = (item: AttentionItem) => Number(reviewerPriority(item.triagePriority)?.slice(1) ?? 4);
  return (
    rank(a) - rank(b) ||
    Number(!a.reviewedAt) - Number(!b.reviewedAt) ||
    (a.reviewedAt ?? "").localeCompare(b.reviewedAt ?? "") ||
    a.repo.localeCompare(b.repo) ||
    a.kind.localeCompare(b.kind) ||
    a.number - b.number
  );
}
