# Closure dependency planner

`planClosureDependencies` is a pure, fail-closed planning primitive used by
repair result review. It does not read or mutate GitHub.

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

## Repair result review

`review-results` derives a graph from planned closure actions:

- one shared action-specific resolver selects the surviving `canonical`,
  `duplicate_of`, or `candidate_fix` root for both review and apply;
- conflicting non-null relationship roots fail review instead of letting
  planning and apply interpret the same action differently;
- required nullable `depends_on` refs add prerequisite edges between closure
  targets; every listed ref must have its own planned closure action in the
  same canonical group;
- actions without a distinct root remain independent and are reported
  separately; and
- deterministic `closureLayers` expose closure batches that can run together.

Mixed canonical roots, conflicting relationship fields, missing dependency
targets, duplicate declarations, and cycles fail result review before the
applicator can consume the proposal.

Apply reproduces the reviewed plan before any mutation, executes planned
closure candidates in dependency-first layer order, and blocks a dependent
unless every declared prerequisite was successfully closed. Dry-run planning
treats a successfully planned prerequisite as the simulated close outcome.

Fix-first closeouts use a separate typed fence. A blocked close is eligible for
post-flight promotion only when its source action sets
`blocked_by: "fix_first"` and its `candidate_fix` exactly matches a merged fix
in the post-flight authorization. Free-form reason, comment, and evidence text
cannot authorize promotion.
