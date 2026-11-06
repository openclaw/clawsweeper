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
export const CENSUS_ACCEPT_OPERATIONS = [
  "validate",
  "digest",
  "retained_verify",
  "lease",
  "replay",
  "checkpoint",
  "cursor",
  "retained_usage",
  "items",
  "advance",
  "save",
  "receipt",
  "cleanup",
] as const;
export const CENSUS_ACCEPT_FAULTS = [
  "checkpoint",
  "observation_window",
  "cursor_cycle",
  "retained_verification",
  "repository_missing",
  "identity_bound",
  "type_error",
  "range_error",
  "syntax_error",
  "sqlite_toobig",
  "sqlite_full",
  "sqlite_constraint",
  "sqlite_busy",
  "sqlite_error",
  "unknown",
] as const;
export type CensusAcceptOperation = (typeof CENSUS_ACCEPT_OPERATIONS)[number];
type CensusAcceptFault = (typeof CENSUS_ACCEPT_FAULTS)[number];
const acceptOperations = new WeakMap<object, CensusAcceptOperation>();

// Associate metadata without wrapping or mutating the original thrown value.
export function observeCensusAcceptFailure(error: unknown, operation: CensusAcceptOperation): void {
  if (!CENSUS_ACCEPT_OPERATIONS.some((value) => value === operation)) return;
  if ((typeof error === "object" && error !== null) || typeof error === "function")
    acceptOperations.set(error, operation);
}
export function censusAcceptFailureDetail(error: unknown): {
  operation?: CensusAcceptOperation;
  fault?: CensusAcceptFault;
} {
  if (!((typeof error === "object" && error !== null) || typeof error === "function")) return {};
  const operation = acceptOperations.get(error);
  if (!operation) return {};
  let fault: CensusAcceptFault = "unknown";
  try {
    // Read only own data descriptors: never invoke error getters or stringify it.
    const message = Object.getOwnPropertyDescriptor(error, "message");
    switch (message && "value" in message ? message.value : undefined) {
      case "census checkpoint conflict":
        fault = "checkpoint";
        break;
      case "census observation window conflict":
        fault = "observation_window";
        break;
      case "census cursor cycle":
        fault = "cursor_cycle";
        break;
      case "census retained verification bound":
        fault = "retained_verification";
        break;
      case "census repository missing":
        fault = "repository_missing";
        break;
      case "census identity bound":
        fault = "identity_bound";
        break;
    }
    const code = Object.getOwnPropertyDescriptor(error, "code");
    const codes = {
      SQLITE_TOOBIG: "sqlite_toobig",
      SQLITE_FULL: "sqlite_full",
      SQLITE_CONSTRAINT: "sqlite_constraint",
      SQLITE_BUSY: "sqlite_busy",
      SQLITE_ERROR: "sqlite_error",
    } as const;
    if (
      fault === "unknown" &&
      code &&
      "value" in code &&
      typeof code.value === "string" &&
      Object.hasOwn(codes, code.value)
    )
      fault = codes[code.value as keyof typeof codes];
    if (fault === "unknown") {
      if (error instanceof TypeError) fault = "type_error";
      else if (error instanceof RangeError) fault = "range_error";
      else if (error instanceof SyntaxError) fault = "syntax_error";
    }
  } catch {
    /* Observability must not replace the original exception. */
  }
  return { operation, fault };
}
export interface CensusDiagnostic {
  phase: CensusPhase;
  category: CensusCategory;
  operation?: CensusAcceptOperation;
  fault?: CensusAcceptFault;
}

export function censusDiagnostic(value: unknown): CensusDiagnostic | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!CENSUS_PHASES.some((x) => x === v.phase) || !CENSUS_CATEGORIES.some((x) => x === v.category))
    return null;
  return {
    phase: v.phase as CensusPhase,
    category: v.category as CensusCategory,
    ...(v.phase === "accept" &&
    CENSUS_ACCEPT_OPERATIONS.some((x) => x === v.operation) &&
    CENSUS_ACCEPT_FAULTS.some((x) => x === v.fault)
      ? { operation: v.operation as CensusAcceptOperation, fault: v.fault as CensusAcceptFault }
      : {}),
  };
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
