import { isRecord } from "../src/value-coerce.ts";
import { publicTimestamp } from "./public-timestamp.ts";

export const MAX_TRIAGE_ITEMS_PER_VIEW = 1000;
const PUBLIC_TRIAGE_ERROR_LIMIT = 20;
const PUBLIC_TRIAGE_COUNT_LIMIT = 1_000_000;
const PUBLIC_TRIAGE_SCHEMA_VERSION = 2;
type TriageDefinition = { id: string; title: string; description: string };
type TriageView = TriageDefinition & { total_count: number; item_limit: number; items: never[] };

export function publicTriageProjection(value: unknown, definitions: readonly TriageDefinition[]) {
  const unavailable = unavailablePublicTriageProjection(definitions);
  if (!isRecord(value)) return unavailable;
  if (value.schema_version === PUBLIC_TRIAGE_SCHEMA_VERSION) {
    return publicProjectedTriageProjection(value, definitions, unavailable);
  }
  if (value.schema_version !== 1) return unavailable;

  const generatedAt = publicTimestamp(value.generated_at);
  const diagnostics = value.diagnostics;
  if (!isRecord(diagnostics)) return unavailable;
  const errors = diagnostics.errors;
  const views = value.views;
  const counts = value.counts;
  if (
    !generatedAt ||
    !Array.isArray(errors) ||
    errors.length > PUBLIC_TRIAGE_ERROR_LIMIT ||
    !errors.every((error) => typeof error === "string") ||
    !Array.isArray(views) ||
    views.length !== definitions.length ||
    !isRecord(counts)
  ) {
    return unavailable;
  }

  const projectedViews = publicTriageViews(views, counts, definitions, false);
  if (!projectedViews) return unavailable;
  return {
    valid: true,
    value: publicTriageProjectionValue(generatedAt, errors.length, projectedViews),
  };
}

function publicProjectedTriageProjection(
  value: Record<string, unknown>,
  definitions: readonly TriageDefinition[],
  unavailable: ReturnType<typeof unavailablePublicTriageProjection>,
) {
  const generatedAt = publicTimestamp(value.generated_at);
  const errorCount = publicTriageCount(value.error_count, PUBLIC_TRIAGE_ERROR_LIMIT);
  if (
    !generatedAt ||
    typeof value.complete !== "boolean" ||
    errorCount === null ||
    value.complete !== (errorCount === 0) ||
    !Array.isArray(value.views) ||
    value.views.length !== definitions.length ||
    !isRecord(value.counts)
  ) {
    return unavailable;
  }
  const projectedViews = publicTriageViews(value.views, value.counts, definitions, true);
  if (!projectedViews) return unavailable;
  return {
    valid: true,
    value: publicTriageProjectionValue(generatedAt, errorCount, projectedViews),
  };
}

function publicTriageViews(
  views: unknown[],
  counts: Record<string, unknown>,
  definitions: readonly TriageDefinition[],
  projected: boolean,
) {
  const byId = new Map<string, Record<string, unknown>>();
  for (const view of views) {
    if (!isRecord(view) || typeof view.id !== "string") {
      return null;
    }
    if (byId.has(view.id)) return null;
    byId.set(view.id, view);
  }
  const result: TriageView[] = [];
  for (const definition of definitions) {
    const view = byId.get(definition.id);
    const totalCount = publicTriageCount(view?.total_count, PUBLIC_TRIAGE_COUNT_LIMIT);
    const itemLimit = publicTriageCount(view?.item_limit, MAX_TRIAGE_ITEMS_PER_VIEW);
    const countValue = publicTriageCount(counts[definition.id], PUBLIC_TRIAGE_COUNT_LIMIT);
    if (
      !view ||
      totalCount === null ||
      itemLimit === null ||
      itemLimit < 1 ||
      countValue !== totalCount ||
      !Array.isArray(view.items) ||
      view.items.length > itemLimit ||
      totalCount < view.items.length ||
      (projected && view.items.length !== 0)
    ) {
      return null;
    }
    result.push({
      id: definition.id,
      title: definition.title,
      description: definition.description,
      total_count: totalCount,
      item_limit: itemLimit,
      items: [],
    });
  }
  return byId.size === definitions.length ? result : null;
}

function publicTriageProjectionValue(generatedAt: string, errorCount: number, views: TriageView[]) {
  return {
    schema_version: PUBLIC_TRIAGE_SCHEMA_VERSION,
    generated_at: generatedAt,
    complete: errorCount === 0,
    error_count: errorCount,
    counts: Object.fromEntries(views.map((view) => [view.id, view.total_count])),
    views,
  };
}

function unavailablePublicTriageProjection(definitions: readonly TriageDefinition[]) {
  const views = definitions.map((definition) => ({
    id: definition.id,
    title: definition.title,
    description: definition.description,
    total_count: null,
    item_limit: null,
    items: [],
  }));
  return {
    valid: false,
    value: {
      schema_version: PUBLIC_TRIAGE_SCHEMA_VERSION,
      generated_at: null,
      complete: false,
      error_count: 1,
      counts: Object.fromEntries(views.map((view) => [view.id, null])),
      views,
    },
  };
}

function publicTriageCount(value: unknown, maximum: number) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum
    ? value
    : null;
}
