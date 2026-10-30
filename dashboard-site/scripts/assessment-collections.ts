import {
  attentionGroup,
  compareAttention,
  type Assessment,
  type AttentionGroup,
} from "./attention.ts";

export const ASSESSMENT_LIMIT = 100;
export const ASSESSMENT_GROUPS: AttentionGroup[] = ["open", "changed", "unknown", "historical"];
export const ASSESSMENT_CONCERNS = ["security", "maintainer"] as const;
export type AssessmentConcern = (typeof ASSESSMENT_CONCERNS)[number];
export type AssessmentRow = {
  repo: string;
  number: number;
  kind: string;
  reviewedAt: string | null;
  triagePriority?: string | null;
  assessment?: Assessment | null;
};
export type AssessmentCollection<T> = { items: T[]; total: number; limit: number };
export type AssessmentCollections<T> = {
  version: 1;
  groups: Record<AttentionGroup, Record<AssessmentConcern, AssessmentCollection<T>>>;
};

export function createAssessmentCollections<T>(): AssessmentCollections<T> {
  return {
    version: 1,
    groups: Object.fromEntries(
      ASSESSMENT_GROUPS.map((group) => [
        group,
        Object.fromEntries(
          ASSESSMENT_CONCERNS.map((concern) => [
            concern,
            { items: [], total: 0, limit: ASSESSMENT_LIMIT },
          ]),
        ),
      ]),
    ) as AssessmentCollections<T>["groups"],
  };
}

// Called for each flag while walking all records, before any legacy/global cap.
export function addAssessmentFlag<T extends AssessmentRow>(
  target: AssessmentCollections<T>,
  row: T,
  concern: AssessmentConcern,
) {
  const collection = target.groups[attentionGroup(row.assessment)][concern];
  collection.total++;
  collection.items.push(row);
  if (collection.items.length > ASSESSMENT_LIMIT * 2) {
    collection.items.sort(compareAttention);
    collection.items.length = ASSESSMENT_LIMIT;
  }
}

export function boundAssessmentCollections<T extends AssessmentRow>(
  source: AssessmentCollections<T>,
  limit = ASSESSMENT_LIMIT,
): AssessmentCollections<T> {
  const result = createAssessmentCollections<T>();
  for (const group of ASSESSMENT_GROUPS)
    for (const concern of ASSESSMENT_CONCERNS) {
      const collection = source.groups[group][concern];
      result.groups[group][concern] = {
        total: collection.total,
        limit,
        items: [...collection.items].sort(compareAttention).slice(0, limit),
      };
    }
  return result;
}

// One missing producer generation makes global completeness unknown. Never
// reconstruct semantic counts by filtering a previously capped legacy list.
export function combineAssessmentCollections<T extends AssessmentRow>(
  sources: (AssessmentCollections<T> | undefined)[],
): AssessmentCollections<T> | null {
  if (sources.some((source) => source?.version !== 1)) return null;
  const result = createAssessmentCollections<T>();
  for (const source of sources) {
    if (!source) continue;
    for (const group of ASSESSMENT_GROUPS)
      for (const concern of ASSESSMENT_CONCERNS) {
        const collection = source.groups[group][concern];
        const target = result.groups[group][concern];
        target.total += collection.total;
        target.items.push(...collection.items);
        if (target.items.length > ASSESSMENT_LIMIT * 2) {
          target.items.sort(compareAttention);
          target.items.length = ASSESSMENT_LIMIT;
        }
      }
  }
  return boundAssessmentCollections(result);
}
