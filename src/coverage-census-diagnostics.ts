// Closed operational vocabulary only. Never serialize an exception or request body.
export const CENSUS_PHASES = ["start", "next", "query", "accept", "fail"] as const;
export const CENSUS_CATEGORIES = [
  "lease",
  "integrity",
  "capacity",
  "invalid_checkpoint",
  "read_failed",
  "json",
  "graphql",
  "schema",
  "unclassified",
] as const;
export type CensusPhase = (typeof CENSUS_PHASES)[number];
export type CensusCategory = (typeof CENSUS_CATEGORIES)[number];
export interface CensusDiagnostic {
  phase: CensusPhase;
  category: CensusCategory;
}

export function censusDiagnostic(value: unknown): CensusDiagnostic | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!CENSUS_PHASES.some((x) => x === v.phase) || !CENSUS_CATEGORIES.some((x) => x === v.category))
    return null;
  return { phase: v.phase as CensusPhase, category: v.category as CensusCategory };
}

export function censusFailureCategory(error: unknown): CensusCategory {
  let message: unknown;
  try {
    if (!(error instanceof Error)) return "unclassified";
    // Never invoke a caller-owned message getter while observing a failure.
    const descriptor = Object.getOwnPropertyDescriptor(error, "message");
    message = descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return "unclassified";
  }
  // Exact owning-code constants, not substring matches on GitHub/SQL messages.
  switch (message) {
    case "census lease conflict":
      return "lease";
    case "census replay conflict":
    case "census stored integrity failed":
    case "census retained accounting":
    case "census complete chunk missing":
      return "integrity";
    case "census capacity blocked":
    case "census metadata byte bound":
    case "census retained capacity bound":
    case "census partition bound":
    case "census projection capacity bound":
    case "census projection identity bound":
      return "capacity";
    case "invalid census token":
    case "census identifier bound":
    case "invalid census acceptance":
    case "invalid census object":
    case "invalid census population":
    case "duplicate census repository":
    case "invalid census failure":
    case "invalid census observation time":
      return "invalid_checkpoint";
    default:
      return "unclassified";
  }
}
