export const CLOSURE_DEPENDENCY_PLANNER_LIMITS = {
  maxNodes: 256,
  maxEdges: 2_048,
  maxCanonicalCandidatesPerNode: 8,
  maxNodeIdBytes: 200,
} as const;

export type ClosureDependencyNode = Readonly<{
  id: string;
  kind: "canonical_root" | "closure_candidate";
  canonicalCandidates: readonly string[];
}>;

export type ClosureDependencyEdge = Readonly<{
  prerequisite: string;
  dependent: string;
}>;

export type ClosureDependencyPlannerInput = Readonly<{
  nodes: readonly ClosureDependencyNode[];
  edges: readonly ClosureDependencyEdge[];
}>;

export type ClosureDependencyDiagnosticCode =
  | "unsafe_bounds"
  | "invalid_node_id"
  | "duplicate_node_declaration"
  | "conflicting_node_declaration"
  | "missing_referenced_node"
  | "multiple_canonical_roots"
  | "ambiguous_canonical_selection"
  | "canonical_root_has_dependency"
  | "self_cycle"
  | "dependency_cycle";

export type ClosureDependencyDiagnostic = Readonly<{
  code: ClosureDependencyDiagnosticCode;
  message: string;
  nodes: readonly string[];
}>;

export type ClosureDependencyPlan =
  | Readonly<{
      status: "safe";
      canonicalRoot: string;
      closureLayers: readonly (readonly string[])[];
      nodeCount: number;
      edgeCount: number;
    }>
  | Readonly<{
      status: "needs_human";
      diagnostics: readonly ClosureDependencyDiagnostic[];
    }>;

const DIAGNOSTIC_ORDER: readonly ClosureDependencyDiagnosticCode[] = [
  "unsafe_bounds",
  "invalid_node_id",
  "duplicate_node_declaration",
  "conflicting_node_declaration",
  "missing_referenced_node",
  "multiple_canonical_roots",
  "ambiguous_canonical_selection",
  "canonical_root_has_dependency",
  "self_cycle",
  "dependency_cycle",
];

const DIAGNOSTIC_RANK = new Map(DIAGNOSTIC_ORDER.map((code, index) => [code, index] as const));
const PRINTABLE_ASCII_ID = /^[\x21-\x7e]+$/;

export function planClosureDependencies(
  input: ClosureDependencyPlannerInput,
): ClosureDependencyPlan {
  if (
    input.nodes.length > CLOSURE_DEPENDENCY_PLANNER_LIMITS.maxNodes ||
    input.edges.length > CLOSURE_DEPENDENCY_PLANNER_LIMITS.maxEdges
  ) {
    return needsHuman([
      diagnostic(
        "unsafe_bounds",
        `input exceeds planner bounds: nodes=${input.nodes.length}/${CLOSURE_DEPENDENCY_PLANNER_LIMITS.maxNodes}, edges=${input.edges.length}/${CLOSURE_DEPENDENCY_PLANNER_LIMITS.maxEdges}`,
      ),
    ]);
  }

  const diagnostics: ClosureDependencyDiagnostic[] = [];
  const nodesById = new Map<string, ClosureDependencyNode>();
  const declarationSignatures = new Map<string, string>();

  for (const node of input.nodes) {
    if (!isSafeId(node.id)) {
      diagnostics.push(
        diagnostic(
          "invalid_node_id",
          `node id ${JSON.stringify(node.id)} must be printable ASCII and at most ${CLOSURE_DEPENDENCY_PLANNER_LIMITS.maxNodeIdBytes} bytes`,
          [node.id],
        ),
      );
      continue;
    }
    if (
      node.canonicalCandidates.length >
      CLOSURE_DEPENDENCY_PLANNER_LIMITS.maxCanonicalCandidatesPerNode
    ) {
      diagnostics.push(
        diagnostic(
          "unsafe_bounds",
          `${node.id} declares ${node.canonicalCandidates.length} canonical candidates; maximum is ${CLOSURE_DEPENDENCY_PLANNER_LIMITS.maxCanonicalCandidatesPerNode}`,
          [node.id],
        ),
      );
      continue;
    }

    const signature = nodeDeclarationSignature(node);
    const previousSignature = declarationSignatures.get(node.id);
    if (previousSignature !== undefined) {
      diagnostics.push(
        previousSignature === signature
          ? diagnostic("duplicate_node_declaration", `${node.id} is declared more than once`, [
              node.id,
            ])
          : diagnostic("conflicting_node_declaration", `${node.id} has conflicting declarations`, [
              node.id,
            ]),
      );
      continue;
    }

    declarationSignatures.set(node.id, signature);
    nodesById.set(node.id, {
      ...node,
      canonicalCandidates: [...node.canonicalCandidates].sort(compareAscii),
    });
  }

  if (diagnostics.length > 0) return needsHuman(diagnostics);

  const canonicalRoots = [...nodesById.values()]
    .filter((node) => node.kind === "canonical_root")
    .map((node) => node.id)
    .sort(compareAscii);
  if (canonicalRoots.length > 1) {
    diagnostics.push(
      diagnostic(
        "multiple_canonical_roots",
        `expected one canonical root, found ${canonicalRoots.length}`,
        canonicalRoots,
      ),
    );
  }

  const canonicalRoot = canonicalRoots.length === 1 ? canonicalRoots[0] : undefined;
  for (const node of [...nodesById.values()].sort((left, right) =>
    compareAscii(left.id, right.id),
  )) {
    for (const candidate of node.canonicalCandidates) {
      if (!isSafeId(candidate)) {
        diagnostics.push(
          diagnostic(
            "invalid_node_id",
            `canonical reference ${JSON.stringify(candidate)} must be printable ASCII and at most ${CLOSURE_DEPENDENCY_PLANNER_LIMITS.maxNodeIdBytes} bytes`,
            [node.id, candidate],
          ),
        );
      } else if (!nodesById.has(candidate)) {
        diagnostics.push(
          diagnostic(
            "missing_referenced_node",
            `${node.id} references missing canonical candidate ${candidate}`,
            [node.id, candidate],
          ),
        );
      }
    }

    if (node.kind === "canonical_root") {
      if (node.canonicalCandidates.length > 0) {
        diagnostics.push(
          diagnostic(
            "ambiguous_canonical_selection",
            `${node.id} is a canonical root and must not select another canonical`,
            [node.id, ...node.canonicalCandidates],
          ),
        );
      }
      continue;
    }

    if (
      node.canonicalCandidates.length !== 1 ||
      canonicalRoot === undefined ||
      node.canonicalCandidates[0] !== canonicalRoot
    ) {
      diagnostics.push(
        diagnostic(
          "ambiguous_canonical_selection",
          canonicalRoot === undefined
            ? `${node.id} cannot select a canonical root because the root declaration is not unique`
            : `${node.id} must select only canonical root ${canonicalRoot}`,
          [node.id, ...node.canonicalCandidates],
        ),
      );
    }
  }

  if (nodesById.size === 0 || canonicalRoot === undefined) {
    diagnostics.push(
      diagnostic(
        "ambiguous_canonical_selection",
        "expected exactly one declared canonical root",
        canonicalRoots,
      ),
    );
  }

  const adjacency = new Map<string, Set<string>>();
  for (const id of nodesById.keys()) adjacency.set(id, new Set());

  for (const edge of input.edges) {
    const edgeNodes = [edge.prerequisite, edge.dependent].sort(compareAscii);
    let edgeIsValid = true;
    for (const reference of edgeNodes) {
      if (!isSafeId(reference)) {
        diagnostics.push(
          diagnostic(
            "invalid_node_id",
            `edge reference ${JSON.stringify(reference)} must be printable ASCII and at most ${CLOSURE_DEPENDENCY_PLANNER_LIMITS.maxNodeIdBytes} bytes`,
            edgeNodes,
          ),
        );
        edgeIsValid = false;
      } else if (!nodesById.has(reference)) {
        diagnostics.push(
          diagnostic(
            "missing_referenced_node",
            `dependency edge references missing node ${reference}`,
            edgeNodes,
          ),
        );
        edgeIsValid = false;
      }
    }
    if (!edgeIsValid) continue;

    adjacency.get(edge.prerequisite)?.add(edge.dependent);
    if (edge.dependent === canonicalRoot) {
      diagnostics.push(
        diagnostic(
          "canonical_root_has_dependency",
          `canonical root ${canonicalRoot} cannot depend on ${edge.prerequisite}`,
          edgeNodes,
        ),
      );
    }
  }

  for (const component of tarjanStronglyConnectedComponents(adjacency)) {
    if (component.length > 1) {
      diagnostics.push(
        diagnostic(
          "dependency_cycle",
          `dependency cycle contains ${component.join(", ")}`,
          component,
        ),
      );
      continue;
    }

    const id = component[0];
    if (id !== undefined && adjacency.get(id)?.has(id)) {
      diagnostics.push(diagnostic("self_cycle", `${id} depends on itself`, [id]));
    }
  }

  if (diagnostics.length > 0 || canonicalRoot === undefined) {
    return needsHuman(diagnostics);
  }

  const closureLayers = kahnClosureLayers(adjacency, canonicalRoot);
  if (closureLayers === null) {
    return needsHuman([
      diagnostic(
        "dependency_cycle",
        "dependency graph could not be fully ordered",
        [...nodesById.keys()].sort(compareAscii),
      ),
    ]);
  }

  return {
    status: "safe",
    canonicalRoot,
    closureLayers,
    nodeCount: nodesById.size,
    edgeCount: [...adjacency.values()].reduce((total, dependents) => total + dependents.size, 0),
  };
}

function tarjanStronglyConnectedComponents(
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
): string[][] {
  const components: string[][] = [];
  const indexes = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  let nextIndex = 0;

  function visit(id: string) {
    indexes.set(id, nextIndex);
    lowLinks.set(id, nextIndex);
    nextIndex += 1;
    stack.push(id);
    onStack.add(id);

    const dependents = [...(adjacency.get(id) ?? [])].sort(compareAscii);
    for (const dependent of dependents) {
      if (!indexes.has(dependent)) {
        visit(dependent);
        lowLinks.set(id, Math.min(lowLinks.get(id) ?? 0, lowLinks.get(dependent) ?? 0));
      } else if (onStack.has(dependent)) {
        lowLinks.set(id, Math.min(lowLinks.get(id) ?? 0, indexes.get(dependent) ?? 0));
      }
    }

    if (lowLinks.get(id) !== indexes.get(id)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop();
      if (member === undefined) break;
      onStack.delete(member);
      component.push(member);
      if (member === id) break;
    }
    component.sort(compareAscii);
    components.push(component);
  }

  for (const id of [...adjacency.keys()].sort(compareAscii)) {
    if (!indexes.has(id)) visit(id);
  }
  return components.sort(compareStringArrays);
}

function kahnClosureLayers(
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
  canonicalRoot: string,
): string[][] | null {
  const indegree = new Map<string, number>();
  for (const id of adjacency.keys()) {
    if (id !== canonicalRoot) indegree.set(id, 0);
  }
  for (const [prerequisite, dependents] of adjacency) {
    if (prerequisite === canonicalRoot) continue;
    for (const dependent of dependents) {
      indegree.set(dependent, (indegree.get(dependent) ?? 0) + 1);
    }
  }

  const layers: string[][] = [];
  let remaining = indegree.size;
  let ready = [...indegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id)
    .sort(compareAscii);

  while (ready.length > 0) {
    const currentLayer = ready;
    ready = [];
    const nextReady = new Set<string>();
    layers.push(currentLayer);

    for (const id of currentLayer) {
      remaining -= 1;
      for (const dependent of [...(adjacency.get(id) ?? [])].sort(compareAscii)) {
        const nextDegree = (indegree.get(dependent) ?? 0) - 1;
        indegree.set(dependent, nextDegree);
        if (nextDegree === 0) nextReady.add(dependent);
      }
    }
    ready = [...nextReady].sort(compareAscii);
  }

  return remaining === 0 ? layers : null;
}

function nodeDeclarationSignature(node: ClosureDependencyNode): string {
  return JSON.stringify([node.kind, [...node.canonicalCandidates].sort(compareAscii)]);
}

function isSafeId(id: string): boolean {
  return (
    id.length > 0 &&
    id.length <= CLOSURE_DEPENDENCY_PLANNER_LIMITS.maxNodeIdBytes &&
    PRINTABLE_ASCII_ID.test(id)
  );
}

function diagnostic(
  code: ClosureDependencyDiagnosticCode,
  message: string,
  nodes: readonly string[] = [],
): ClosureDependencyDiagnostic {
  return {
    code,
    message,
    nodes: [...nodes].sort(compareAscii),
  };
}

function needsHuman(diagnostics: readonly ClosureDependencyDiagnostic[]): ClosureDependencyPlan {
  const unique = new Map<string, ClosureDependencyDiagnostic>();
  for (const entry of diagnostics) {
    const key = JSON.stringify([entry.code, entry.nodes, entry.message]);
    unique.set(key, entry);
  }
  return {
    status: "needs_human",
    diagnostics: [...unique.values()].sort(compareDiagnostics),
  };
}

function compareDiagnostics(
  left: ClosureDependencyDiagnostic,
  right: ClosureDependencyDiagnostic,
): number {
  const rankDifference =
    (DIAGNOSTIC_RANK.get(left.code) ?? Number.MAX_SAFE_INTEGER) -
    (DIAGNOSTIC_RANK.get(right.code) ?? Number.MAX_SAFE_INTEGER);
  if (rankDifference !== 0) return rankDifference;
  const nodeDifference = compareStringArrays(left.nodes, right.nodes);
  return nodeDifference !== 0 ? nodeDifference : compareAscii(left.message, right.message);
}

function compareStringArrays(left: readonly string[], right: readonly string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = compareAscii(left[index] ?? "", right[index] ?? "");
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
