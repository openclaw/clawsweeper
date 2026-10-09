import {
  isMaintainerAuthorAssociation,
  isWriteAccessRepositoryPermission,
} from "./clawsweeper-item-policy.js";
import { asRecord } from "./value-coerce.js";

export interface CodexItemProfile {
  reasoningEffort: string;
  serviceTier: string;
}

// Maintainers and anyone with write access get priority ("fast") service. The
// permission check also covers authors whose association a token redacts.
export function codexItemProfile(
  authorAssociations: unknown,
  repositoryPermissions: unknown = [],
): CodexItemProfile {
  return asList(authorAssociations).some(isMaintainerAuthorAssociation) ||
    asList(repositoryPermissions).some(isWriteAccessRepositoryPermission)
    ? { reasoningEffort: "medium", serviceTier: "fast" }
    : { reasoningEffort: "medium", serviceTier: "" };
}

export function canonicalItemCodexProfile(
  frontmatter: unknown,
  clusterPlan: unknown,
): CodexItemProfile {
  const items = canonicalPlanItems(frontmatter, clusterPlan);
  return codexItemProfile(
    items.map((item) => item.author_association),
    items.map((item) => item.author_repository_permission),
  );
}

function canonicalPlanItems(frontmatter: unknown, clusterPlan: unknown): Record<string, unknown>[] {
  const job = asRecord(frontmatter);
  const plan = asRecord(clusterPlan);
  const items = Array.isArray(plan.items) ? plan.items.map(asRecord) : [];
  const canonicalRefs = Array.isArray(job.canonical) ? job.canonical : [];
  const refs = (
    canonicalRefs.length > 0 ? canonicalRefs : Array.isArray(job.candidates) ? job.candidates : []
  ).filter((ref): ref is string => typeof ref === "string");
  return refs.flatMap((ref) => {
    const normalizedRef = normalizeItemRef(ref);
    const item = items.find(
      (candidate) =>
        typeof candidate.ref === "string" && normalizeItemRef(candidate.ref) === normalizedRef,
    );
    return item ? [item] : [];
  });
}

function normalizeItemRef(value: string): string {
  const match = value.trim().match(/^#?(\d+)$/);
  if (!match) return value;
  const digits = (match[1] ?? "").replace(/^0+(?=\d)/, "");
  return `#${digits}`;
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}
