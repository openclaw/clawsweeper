import type { JsonValue, LooseRecord } from "./json-types.js";
import {
  planClosureDependencies,
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

export function planRepairClosureResult(result: LooseRecord): RepairClosureResultPlan {
  const actions = Array.isArray(result.actions) ? result.actions : [];
  const graphActions: LooseRecord[] = [];
  const independentClosures: string[] = [];

  for (const action of actions) {
    if (action.status !== "planned" || !PLANNED_CLOSE_ACTIONS.has(String(action.action ?? ""))) {
      continue;
    }
    const target = normalizeRef(action.target);
    const canonical = closureCanonical(action);
    if (!target || !canonical || target === canonical) {
      if (target) independentClosures.push(target);
      continue;
    }
    graphActions.push({ action, target, canonical });
  }

  const sortedIndependent = [...new Set(independentClosures)].sort(compareAscii);
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
