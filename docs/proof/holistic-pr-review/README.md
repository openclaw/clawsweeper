# Engineering-review integration proof

- Status: current opt-in harness; checked-in receipts are historical
- Owner: ClawSweeper review maintainers
- Selected main: fe750d1779208b067c1f694dba70f494cb29c401
- Current execution: not performed by this conflict-resolution pass

## Current source contract

The engineering opening asks for coherent before/after system behavior, relevant
end-to-end paths, source-challenged findings, and a grounded completion decision.
It leaves the investigation to the reviewer. The existing core, PR/issue templates,
close-reason guidance, repository profiles, standing rules, and current schema
remain authoritative. The branch's duplicate policy files are removed; policy
is not conditionally hidden by a new protection or continuity router.

The issue opening uses the `review_procedure` slot to reproduce selected main's
core. Both complete issue prompts and the slot reconstruction are compared by
the harness. The schema is read from each built variant; its field count is
measured, not pinned to an earlier branch value. The
[ownership inventory](policy-map.md) records what is unique and what main already
owns. No model default, permission, queue, apply, publication, or Bay contract
changes are part of this integration.

OpenClaw already appends the output schema on main. The retained transport change
makes that a bounded, validated capture before admission: one complete message
is scanned and then delivered, with no post-scan schema reread. The message's
schema and framing count toward quotas, deadline, and CLI size limits. Native
Codex retains its original prompt bytes and output-schema transport.

## Proof contract

- Claim: current production prompt composition retains canonical policy and
  unchanged issue instructions while adding the engineering opening; schema
  delivery admits the same complete bytes the OpenClaw consumer receives.
- Surfaces: production prompt assembly, native local-range review, and
  `runAgentProcess` through the OpenClaw worker's message-file boundary.
- Scenarios: a queued cancellation defect, a clean signal-forwarding control,
  and an apparent signal-loss path disproved by the queue's captured callback;
  separate delivery checks cover schema passthrough and refusals.
- Environment: Node 24 or newer and existing installed dependencies. The model
  harness retains its explicit native model selection, read-only sandbox,
  normal admission, and fixed per-review timeout. It is opt-in and paid, not CI.
- Observable results: completed decisions, source-backed findings or refutations,
  unchanged target checkouts, exact issue-prompt equality, captured prompt/schema
  sizes, and byte-identical admitted/delivered schema messages.
- Artifacts: new output-directory receipts, source and prompt hashes, complete
  prompts/results, process logs, and actual environment identifiers. Do not
  overwrite the historical receipts to imply they describe the rebased source.
- Limits: three self-authored fixtures are not a review-quality benchmark.
  Delivery to a controlled consumer proves transport, not model compliance or
  semantic review quality. A successful source trace is not execution of the
  candidate behavior. Current runtime proof and native review remain owner work.

## Running current proof

With dependencies already installed, use fresh output directories:

```bash
node docs/proof/holistic-pr-review/run-proof.mjs .artifacts/astra-review/controlled
node docs/proof/holistic-pr-review/schema-delivery.mjs .artifacts/astra-review/schema-delivery
```

`run-proof.mjs` archives selected main's real source, configuration, schema, and
four canonical templates into a separate runner directory and compiles it with
the existing dependencies. It also builds the current candidate. It does not
swap old monolithic assets into the new compositor. Before invoking a model,
it checks slot reconstruction and compares complete issue prompts for OpenClaw,
ClawSweeper, and ClawHub using both production runtimes.

Both variants use the same three request-service fixtures and fresh clones,
excluding prior local review history. The synthetic `openclaw/review-fixture`
identity names no live GitHub repository. The harness records actual static
instructions, schema size and field count, and runtime/context bytes separately.
There is no assumed reduction relative to a superseded baseline. The optional
`--candidate-only` argument retains the baseline build and equivalence checks;
an optional case number 1–3 selects one candidate case.

The schema-delivery harness uses the freshly built candidate, normal mandatory
admission, and a controlled message-file consumer without inference credentials.
It records message/schema hashes and checks no-schema passthrough, a complete
message quota refusal, and malformed-schema refusal. The consumer is not an
OpenClaw model. Standalone use requires a fresh `pnpm run build` first.

Neither harness is executed automatically. The owner records the actual host
or validation provider, image/lease when applicable, current head, artifacts,
and limits for a new run; an earlier native-host environment is not evidence of
the environment used now.

## Historical receipts

[receipt.json](receipt.json) preserves the pre-rebase native model experiment
against the additive branch baseline
`cdb49e07f72207aec7a198eb86b5479b29a9edb5`, including its original prompts, schema
count, source identities, outcomes, and development attempts.
[schema-delivery-receipt.json](schema-delivery-receipt.json) preserves the earlier
controlled delivery experiment. Neither receipt is relabeled or used as proof
of current main's templates, schema, instruction sizes, or this resolution.

Historical test totals, native reviews, and instruction-size reductions do not
establish current results. Run focused prompt/context/policy/provenance and
agent/schema-delivery coverage, then `pnpm run check`, current controlled proof,
and the required fresh native review before publication or landing.
