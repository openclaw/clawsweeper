import { isMaintainerAuthorAssociation } from "./clawsweeper-item-policy.js";

export interface CodexItemProfile {
  reasoningEffort: string;
  serviceTier: string;
}

export function codexItemProfile(
  authorAssociation: unknown,
  defaults: CodexItemProfile,
): CodexItemProfile {
  return isMaintainerAuthorAssociation(authorAssociation)
    ? { reasoningEffort: "high", serviceTier: "fast" }
    : defaults;
}

export function canonicalItemAuthorAssociation(
  frontmatter: unknown,
  clusterPlan: unknown,
): string | undefined {
  const job = asRecord(frontmatter);
  const plan = asRecord(clusterPlan);
  const items = Array.isArray(plan.items) ? plan.items.map(asRecord) : [];
  const canonicalRefs = Array.isArray(job.canonical) ? job.canonical : [];
  const refs = (
    canonicalRefs.length > 0 ? canonicalRefs : Array.isArray(job.candidates) ? job.candidates : []
  ).filter((ref): ref is string => typeof ref === "string");
  for (const ref of refs) {
    const item = items.find((candidate) => candidate.ref === ref);
    if (typeof item?.author_association === "string") return item.author_association;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
