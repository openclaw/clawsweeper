# Engineering-review integration inventory

- Status: source ownership map, not execution evidence
- Owner: ClawSweeper review maintainers
- Selected main: fe750d1779208b067c1f694dba70f494cb29c401
- Update trigger: an opening, canonical policy owner, or schema-delivery boundary changes

## Retained unique work

- `prompts/review-pr.md` supplies only the engineering outcome and completion
  contract: coherent before/after behavior, relevant end-to-end paths, challenging
  findings against source, and model-chosen investigation.
- `review_procedure` remains the opening slot. The issue opening reconstructs
  selected main's core exactly; its kind-specific instructions remain upstream's.
- OpenClaw captures the schema through a bounded regular-file read, validates
  UTF-8 and a JSON object-or-boolean root, and scans the complete delivered
  message plus captured schema before diagnostics or invocation. This is not a
  full JSON Schema meta-validator. Quotas, deadline, and the CLI message limit
  cover the complete message. Native Codex prompt bytes and schema transport
  remain unchanged.

## Canonical responsibilities retained from main

| Responsibility | Canonical owner |
| --- | --- |
| Read-only review, scoped instructions, evidence, provenance, public reporting | `prompts/review-item.md` |
| PR introduction evidence, findings and continuity, proof, authority, compatibility, standing review rules | `prompts/review-item-pr.md` |
| Issue triage and issue-specific contracts | `prompts/review-item-issue.md` |
| Close guidance and reason selection | `prompts/review-close-reasons.md`, `src/repository-profiles.ts`, existing review/apply gates |
| Repository-specific instructions and release-note policy | `src/repository-profiles.ts` |
| Field descriptions, labels, typed readiness and judgment ownership | Current decision schema and existing parser/presentation code |
| Compact linked context and host-prefetched history | Existing context/hydration and history modules |
| Prompt assembly, profile rendering, hashing and telemetry | Existing template/profile APIs in the review runtime |

The branch-only readiness, close, and continuity files duplicated these owners
and are removed. No alternate protection-based policy router is introduced.
In particular, main's close-policy exceptions remain authoritative; a maintainer
or protected item does not cause its canonical policy to disappear from input.
The core is not a legacy issue monolith and remains part of PR composition.

Retired schema fields, an old fixed field count, and branch source-text policy
pins are not restored. Main's behavior tests remain intact. The branch composition
tests check real assembled templates, kind isolation, ordering, and telemetry;
schema-delivery tests exercise capture, admission, quotas, and consumer bytes.

## Evidence boundary

The original JSON receipts describe pre-rebase runs and retain their original
identities and metrics. They do not prove this integration. The separate
[October 9 proof](rebase.md) and rebase receipt record the executed current inputs. `run-proof.mjs`
builds selected main from its real source and builds the current candidate,
compares assembled issue instructions, and records new measurements when the
owner executes it. `schema-delivery.mjs` exercises the real delivery path through
a controlled consumer, not model quality. The dedicated resolver did not execute either harness; the owner subsequently
ran both and recorded the source-qualified results separately.

No schema/publication contract, model/provider configuration, permissions, queue,
apply behavior, or Bay surface is changed.
