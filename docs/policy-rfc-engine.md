# Policy RFC Engine

The Policy RFC Engine turns repeated ClawSweeper review and repair patterns into structured, reviewable policy proposals. It is an additive, manual tool: it reads durable local records and writes generated documentation/state under `results/policy-rfc/`. It does not mutate GitHub, dispatch repairs, close issues, change labels, or alter scheduler behavior.

## Usage

Build the project, then run:

```sh
pnpm run policy-rfc -- --target-repo openclaw/openclaw --min-occurrences 5
```

Useful options:

- `--target-repo`: repository profile to scan, such as `openclaw/openclaw`.
- `--records-root`: local durable record root. Defaults to `records`.
- `--output-root`: generated proposal root. Defaults to `results/policy-rfc`.
- `--min-occurrences`: minimum repeated observations before an RFC is emitted. Defaults to `5`.

## What It Reads

The collector scans existing markdown and JSON records below `records/<repo-slug>/`. It tolerates missing directories, unreadable files, older markdown shapes, and malformed partial records by skipping what it cannot safely parse.

The first version extracts repeated examples of:

- file conflict types
- labels
- repair markers
- review verdict markers
- safe-close reasons
- automerge repair causes

## What It Writes

For each eligible pattern, the engine writes:

- `results/policy-rfc/<repo-slug>/<proposal-id>.md`
- `results/policy-rfc/<repo-slug>/<proposal-id>.json`

Markdown RFCs contain:

- Title
- Status: Draft
- Summary
- Observed Pattern
- Evidence
- Proposed Policy
- Safety Constraints
- Non-Goals
- Rollout Plan
- Metrics
- Reversion Plan

JSON proposals include the stable machine-readable fields needed for review automation or later dashboards: `id`, `title`, `status`, `pattern_type`, `evidence_items`, `confidence_score`, `proposed_conditions`, `proposed_action`, `safety_constraints`, `created_at`, and `source_records`.

## Proposal-Only Boundary

The engine intentionally stops at documentation/state. A generated RFC is evidence that a pattern may deserve a formal policy; it is not an executable rule. Any accepted proposal must be implemented separately, reviewed as normal code, and routed through ClawSweeper's existing conservative apply paths.

This keeps the feature out of hot scheduler paths:

- no GitHub mutation
- no automatic policy execution
- no changes to close/apply/automerge logic
- no extra review shard work
- no live GitHub scans in the scheduler critical path

