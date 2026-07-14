import type { JsonValue, LooseRecord } from "./json-types.js";
import {
  planClosureDependencies,
  type ClosureDependencyDiagnostic,
  type ClosureDependencyPlan,
} from "./closure-dependency-planner.js";

const PLANNED_CLOSE_ACTIONS = new Set([
  "close",
  "close_duplicate",
  "close_superseded",
  "close_fixed_by_candidate",
  "close_low_signal",
  "post_merge_close",
]);

export type RepairClosureResultPlan =
  | Readonly<{
      status: "not_applicable";
      independentClosures: readonly string[];
    }>
  | Readonly<{
      status: "safe";
      canonicalRoot: string;
      closureLayers: readonly (readonly string[])[];
      independentClosures: readonly string[];
      nodeCount: number;
      edgeCount: number;
    }>
  | Readonly<{
      status: "needs_human";
      diagnostics: ClosureDependencyPlan extends infer Plan
        ? Plan extends { status: "needs_human"; diagnostics: infer Diagnostics }
          ? Diagnostics
          : never
        : never;
      independentClosures: readonly string[];
    }>;

type PlannedCloseAction = Readonly<{
  action: LooseRecord;
  target: string;
  canonical: string;
  isClosureCandidate: boolean;
}>;

export function planRepairClosureResult(result: LooseRecord): RepairClosureResultPlan {
  const actions = Array.isArray(result.actions) ? result.actions : [];
  const plannedCloseActions: PlannedCloseAction[] = [];
  const graphActions: LooseRecord[] = [];
  const independentClosures: string[] = [];

  for (const action of actions) {
    if (action.status !== "planned" || !PLANNED_CLOSE_ACTIONS.has(String(action.action ?? ""))) {
      continue;
    }
    const target = normalizeRef(action.target);
    const canonical = closureCanonical(action);
    const isClosureCandidate = Boolean(target && canonical && target !== canonical);
    plannedCloseActions.push({ action, target, canonical, isClosureCandidate });
    if (!isClosureCandidate) {
      if (target) independentClosures.push(target);
      continue;
    }
    graphActions.push({ action, target, canonical });
  }

  const sortedIndependent = [...new Set(independentClosures)].sort(compareAscii);
  const dependencyDiagnostics = validateDependencyTargets(plannedCloseActions);
  if (dependencyDiagnostics.length > 0) {
    return {
      status: "needs_human",
      diagnostics: dependencyDiagnostics,
      independentClosures: sortedIndependent,
    };
  }
  if (graphActions.length === 0) {
    return {
      status: "not_applicable",
      independentClosures: sortedIndependent,
    };
  }

  const canonicalRoots = [...new Set(graphActions.map((entry) => String(entry.canonical)))].sort(
    compareAscii,
  );
  const nodes = [
    ...canonicalRoots.map((id) => ({
      id,
      kind: "canonical_root" as const,
      canonicalCandidates: [] as const,
    })),
    ...graphActions.map((entry) => ({
      id: String(entry.target),
      kind: "closure_candidate" as const,
      canonicalCandidates: [String(entry.canonical)],
    })),
  ];
  const edges = graphActions.flatMap((entry) =>
    dependencyRefs(entry.action.depends_on).map((prerequisite) => ({
      prerequisite,
      dependent: String(entry.target),
    })),
  );
  const plan = planClosureDependencies({ nodes, edges });
  if (plan.status === "needs_human") {
    return {
      ...plan,
      independentClosures: sortedIndependent,
    };
  }
  return {
    ...plan,
    independentClosures: sortedIndependent,
  };
}

function validateDependencyTargets(
  plannedCloseActions: readonly PlannedCloseAction[],
): ClosureDependencyDiagnostic[] {
  const candidateKeys = new Set(
    plannedCloseActions
      .filter((entry) => entry.isClosureCandidate)
      .map((entry) => `${entry.canonical}\0${entry.target}`),
  );

  const diagnostics: ClosureDependencyDiagnostic[] = [];
  for (const entry of plannedCloseActions) {
    if (entry.action.depends_on === undefined || entry.action.depends_on === null) continue;
    const dependencies = dependencyRefs(entry.action.depends_on);
    if (!entry.isClosureCandidate) {
      diagnostics.push({
        code: "missing_referenced_node",
        message: `${entry.target || "unknown closure"} declares depends_on but is not a planned closure candidate in a canonical group`,
        nodes: dependencyDiagnosticNodes(entry.target, dependencies),
      });
      continue;
    }
    if (dependencies.length === 0) {
      diagnostics.push({
        code: "missing_referenced_node",
        message: `${entry.target} has non-null depends_on but does not identify another planned closure candidate in canonical group ${entry.canonical}`,
        nodes: [entry.target],
      });
      continue;
    }
    for (const dependency of new Set(dependencies)) {
      if (candidateKeys.has(`${entry.canonical}\0${dependency}`)) continue;
      diagnostics.push({
        code: "missing_referenced_node",
        message: `${entry.target} depends_on ${dependency || "an invalid ref"}, which is not another planned closure candidate in canonical group ${entry.canonical}`,
        nodes: dependencyDiagnosticNodes(entry.target, [dependency]),
      });
    }
  }
  return diagnostics.sort((left, right) =>
    compareAscii(
      `${left.nodes.join("\0")}\0${left.message}`,
      `${right.nodes.join("\0")}\0${right.message}`,
    ),
  );
}

function closureCanonical(action: LooseRecord): string {
  return normalizeRef(
    action.canonical ??
      action.duplicate_of ??
      action.candidate_fix ??
      action.fixed_by ??
      action.fix_candidate,
  );
}

function dependencyRefs(value: JsonValue): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return [String(value)];
  return value.map((entry) => normalizeRef(entry) || String(entry));
}

function dependencyDiagnosticNodes(target: string, dependencies: readonly string[]): string[] {
  return [...new Set([target, ...dependencies].filter(Boolean))].sort(compareAscii);
}

function normalizeRef(value: JsonValue): string {
  const text = String(value ?? "").trim();
  const match = text.match(/(?:^#|\/(?:issues|pull)\/)(\d+)$/);
  if (!match) return "";
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? `#${number}` : "";
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
