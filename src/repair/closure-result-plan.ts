import type { JsonValue, LooseRecord } from "./json-types.js";
import {
  planClosureDependencies,
  type ClosureDependencyDiagnostic,
} from "./closure-dependency-planner.js";
import { issueNumberFromRef } from "./github-ref.js";

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
      diagnostics: readonly RepairClosureResultDiagnostic[];
      independentClosures: readonly string[];
    }>;

export type RepairClosureResultDiagnostic =
  | ClosureDependencyDiagnostic
  | Readonly<{
      code: "conflicting_relationship_roots";
      message: string;
      nodes: readonly string[];
    }>;

export type RepairClosureRelationship = Readonly<{
  classification: string;
  canonical: string;
  candidateFix: string;
  root: string;
  declarations: readonly Readonly<{ field: string; ref: string }>[];
  conflictingRoots: readonly string[];
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
    const relationship = resolveRepairClosureRelationship(action);
    const canonical = relationship.root;
    const isClosureCandidate = Boolean(target && canonical && target !== canonical);
    plannedCloseActions.push({ action, target, canonical, isClosureCandidate });
    if (!isClosureCandidate) {
      if (target) independentClosures.push(target);
      continue;
    }
    graphActions.push({ action, target, canonical });
  }

  const sortedIndependent = [...new Set(independentClosures)].sort(compareAscii);
  const resultDiagnostics = [
    ...validateDuplicateClosureTargets(plannedCloseActions),
    ...validateRelationshipRoots(plannedCloseActions),
    ...validateIndependentClosureCollisions(plannedCloseActions),
    ...validateDependencyTargets(plannedCloseActions),
  ];
  if (resultDiagnostics.length > 0) {
    return {
      status: "needs_human",
      diagnostics: resultDiagnostics,
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

export function resolveRepairClosureRelationship(action: LooseRecord): RepairClosureRelationship {
  const classification = repairClosureClassification(action);
  const declarations = [
    ["canonical", action.canonical],
    ["duplicate_of", action.duplicate_of],
    ["candidate_fix", action.candidate_fix],
    ["fixed_by", action.fixed_by],
    ["fix_candidate", action.fix_candidate],
  ]
    .map(([field, value]) => ({ field: String(field), ref: normalizeRef(value) }))
    .filter((entry) => entry.ref);
  const canonical =
    declarations.find((entry) => entry.field === "canonical")?.ref ??
    declarations.find((entry) => entry.field === "duplicate_of")?.ref ??
    "";
  const candidateFix =
    declarations.find((entry) =>
      ["candidate_fix", "fixed_by", "fix_candidate"].includes(entry.field),
    )?.ref ?? "";
  const conflictingRoots = [...new Set(declarations.map((entry) => entry.ref))].sort(compareAscii);

  return {
    classification,
    canonical,
    candidateFix,
    root: repairClosureRelationshipRoot({
      actionName: String(action.action ?? ""),
      classification,
      canonical,
      candidateFix,
    }),
    declarations,
    conflictingRoots: conflictingRoots.length > 1 ? conflictingRoots : [],
  };
}

export function repairClosureClassification(action: LooseRecord): string {
  const raw = String(
    action.classification ?? action.close_reason ?? action.reason ?? "",
  ).toLowerCase();
  if (raw.includes("low_signal") || raw.includes("low-signal") || raw.includes("low signal"))
    return "low_signal";
  if (raw.includes("fixed") || raw.includes("candidate")) return "fixed_by_candidate";
  if (raw.includes("superseded") || raw.includes("supersede")) return "superseded";
  if (raw.includes("duplicate") || raw.includes("dupe")) return "duplicate";
  if (action.action === "close_fixed_by_candidate") return "fixed_by_candidate";
  if (action.action === "close_low_signal") return "low_signal";
  if (action.action === "close_superseded") return "superseded";
  if (action.action === "close_duplicate") return "duplicate";
  if (action.action === "post_merge_close") return "fixed_by_candidate";
  return raw;
}

export function repairClosureDependencyRefs(action: LooseRecord): readonly string[] {
  return dependencyRefs(action.depends_on);
}

export function isFixFirstBlockedCloseAction(
  action: LooseRecord,
  hasClusterFixPath: JsonValue,
): boolean {
  if (action.status !== "blocked") return false;
  const text = [
    action.reason,
    action.comment,
    action.idempotency_key,
    ...(action.evidence ?? []),
  ].join("\n");
  const hasFixFirstText =
    /fix[- ]first|blocked-by-fix-first|requires? a fix|requires? ClawSweeper Repair fix|fix PR|fix path|canonical fix (?:path|landing|lands?)|canonical repair (?:path|landing|lands?)|merged canonical fix|hydrated merged fix PR|replacement PR|replacement fix|pending .*fix|after .*fix .*lands?|open_fix_pr|build_fix_artifact/i.test(
      text,
    );
  return hasFixFirstText || (Boolean(hasClusterFixPath) && /blocked|wait|pending/i.test(text));
}

export function orderRepairClosureActions(
  actions: readonly LooseRecord[],
  plan: RepairClosureResultPlan,
): readonly LooseRecord[] {
  if (plan.status !== "safe") return [...actions];

  const plannedTargets = new Map<string, LooseRecord>();
  for (const action of actions) {
    if (action.status !== "planned" || !PLANNED_CLOSE_ACTIONS.has(String(action.action ?? ""))) {
      continue;
    }
    const target = normalizeRef(action.target);
    if (target && plan.closureLayers.some((layer) => layer.includes(target))) {
      plannedTargets.set(target, action);
    }
  }

  const orderedTargets = plan.closureLayers.flat();
  const orderedTargetSet = new Set(orderedTargets);
  return [
    ...actions.filter(
      (action) =>
        action.status !== "planned" ||
        !PLANNED_CLOSE_ACTIONS.has(String(action.action ?? "")) ||
        !orderedTargetSet.has(normalizeRef(action.target)),
    ),
    ...orderedTargets.map((target) => plannedTargets.get(target)).filter(Boolean),
  ] as LooseRecord[];
}

function validateRelationshipRoots(
  plannedCloseActions: readonly PlannedCloseAction[],
): RepairClosureResultDiagnostic[] {
  const diagnostics: RepairClosureResultDiagnostic[] = [];
  for (const entry of plannedCloseActions) {
    const relationship = resolveRepairClosureRelationship(entry.action);
    if (relationship.conflictingRoots.length === 0) continue;
    const declarations = relationship.declarations
      .map(({ field, ref }) => `${field}=${ref}`)
      .join(", ");
    diagnostics.push({
      code: "conflicting_relationship_roots",
      message: `${entry.target || "unknown closure"} declares conflicting relationship roots: ${declarations}`,
      nodes: dependencyDiagnosticNodes(entry.target, relationship.conflictingRoots),
    });
  }
  return diagnostics.sort((left, right) =>
    compareAscii(
      `${left.nodes.join("\0")}\0${left.message}`,
      `${right.nodes.join("\0")}\0${right.message}`,
    ),
  );
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

function validateDuplicateClosureTargets(
  plannedCloseActions: readonly PlannedCloseAction[],
): ClosureDependencyDiagnostic[] {
  const targetCounts = new Map<string, number>();
  for (const entry of plannedCloseActions) {
    if (!entry.target) continue;
    targetCounts.set(entry.target, (targetCounts.get(entry.target) ?? 0) + 1);
  }
  return [...targetCounts]
    .filter(([, count]) => count > 1)
    .map(([target]) => ({
      code: "duplicate_node_declaration" as const,
      message: `${target} is declared by multiple planned close actions`,
      nodes: [target],
    }))
    .sort((left, right) => compareAscii(left.nodes[0] ?? "", right.nodes[0] ?? ""));
}

function validateIndependentClosureCollisions(
  plannedCloseActions: readonly PlannedCloseAction[],
): ClosureDependencyDiagnostic[] {
  const independentTargets = new Set(
    plannedCloseActions
      .filter((entry) => !entry.isClosureCandidate && entry.target)
      .map((entry) => entry.target),
  );
  const canonicalRoots = new Set(
    plannedCloseActions.filter((entry) => entry.isClosureCandidate).map((entry) => entry.canonical),
  );
  const diagnostics: ClosureDependencyDiagnostic[] = [];

  for (const target of [...independentTargets].sort(compareAscii)) {
    if (canonicalRoots.has(target)) {
      diagnostics.push({
        code: "duplicate_node_declaration",
        message: `${target} is declared as both an independent closure and canonical root`,
        nodes: [target],
      });
    }
  }

  return diagnostics;
}

function repairClosureRelationshipRoot({
  actionName,
  classification,
  canonical,
  candidateFix,
}: Readonly<{
  actionName: string;
  classification: string;
  canonical: string;
  candidateFix: string;
}>): string {
  if (actionName === "close_duplicate") return canonical;
  if (actionName === "close_superseded") return candidateFix || canonical;
  if (["close_fixed_by_candidate", "post_merge_close"].includes(actionName)) return candidateFix;
  if (actionName === "close") {
    if (classification === "duplicate") return canonical;
    if (classification === "superseded") return candidateFix || canonical;
    if (classification === "fixed_by_candidate") return candidateFix;
  }
  return "";
}

function dependencyRefs(value: JsonValue): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return [normalizeRef(value) || String(value)];
  return value.map((entry) => normalizeRef(entry) || String(entry));
}

function dependencyDiagnosticNodes(target: string, dependencies: readonly string[]): string[] {
  return [...new Set([target, ...dependencies].filter(Boolean))].sort(compareAscii);
}

function normalizeRef(value: JsonValue): string {
  const number = issueNumberFromRef(value);
  return Number.isSafeInteger(number) && number > 0 ? `#${number}` : "";
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
