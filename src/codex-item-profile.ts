import { isMaintainerAuthorAssociation } from "./clawsweeper-item-policy.js";

export interface CodexItemProfile {
  reasoningEffort: string;
  serviceTier: string;
}

export function codexItemProfile(authorAssociations: unknown): CodexItemProfile {
  const associations = Array.isArray(authorAssociations)
    ? authorAssociations
    : [authorAssociations];
  return associations.some(isMaintainerAuthorAssociation)
    ? { reasoningEffort: "high", serviceTier: "fast" }
    : { reasoningEffort: "medium", serviceTier: "" };
}

export function canonicalItemAuthorAssociations(
  frontmatter: unknown,
  clusterPlan: unknown,
): string[] {
  const job = asRecord(frontmatter);
  const plan = asRecord(clusterPlan);
  const items = Array.isArray(plan.items) ? plan.items.map(asRecord) : [];
  const canonicalRefs = Array.isArray(job.canonical) ? job.canonical : [];
  const refs = (
    canonicalRefs.length > 0 ? canonicalRefs : Array.isArray(job.candidates) ? job.candidates : []
  ).filter((ref): ref is string => typeof ref === "string");
  return refs.flatMap((ref) => {
    const association = items.find((candidate) => candidate.ref === ref)?.author_association;
    return typeof association === "string" ? [association] : [];
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
