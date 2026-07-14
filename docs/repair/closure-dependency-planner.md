# Closure dependency planner

`planClosureDependencies` is a pure, fail-closed planning primitive for a future
root-cause closeout lane. It does not read or mutate GitHub and is not wired
into review or apply.

## Contract

The input contains bounded node declarations and dependency edges:

```ts
{
  nodes: [
    { id: "#100", kind: "canonical_root", canonicalCandidates: [] },
    { id: "#101", kind: "closure_candidate", canonicalCandidates: ["#100"] },
    { id: "#102", kind: "closure_candidate", canonicalCandidates: ["#100"] },
  ],
  edges: [
    { prerequisite: "#101", dependent: "#102" },
  ],
}
```

Exactly one `canonical_root` must remain open. Every `closure_candidate` must
select that root and only that root. An edge means its `prerequisite` must close
successfully before its `dependent` is attempted. The canonical root is treated
as already satisfied and never appears in a closure layer.

A safe result names the canonical root and returns deterministic Kahn layers.
Members of one layer have no dependency ordering between them and are sorted by
binary ASCII order. Exact duplicate edges are collapsed.

## Failure behavior

Tarjan strongly connected components detect multi-node cycles and self-cycles
before layering. The planner returns sorted `needs_human` diagnostics, never a
partial plan, for:

- cycles or self-cycles;
- missing referenced nodes;
- absent or multiple canonical roots;
- ambiguous or non-root canonical selections;
- duplicate or conflicting node declarations;
- dependencies pointing into the canonical root;
- non-printable or non-ASCII identifiers; or
- inputs above the exported node, edge, candidate, or identifier bounds.

Input arrays and declarations are copied before sorting. Caller-owned data is
not mutated, and input permutation does not change plans or diagnostics.
