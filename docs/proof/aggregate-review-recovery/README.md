# Aggregate Review Recovery

Status: historical controlled proof. Owner: ClawSweeper maintainers.

## Claim

A failed aggregate shard must not turn its planned matrix into retry authority.
Only recognized native retryable item terminals from the complete exact
producer attempt may reach recovery admission. Completed and nonretryable
items stay excluded; uncertain, missing, ambiguous, and unstarted work stays
held. Verified completed reports survive for the existing guarded publisher.

## Reproduce

Use Node 24, Bash 4+, and the pinned frozen dependencies in a clean environment.

```sh
pnpm run build:all
node docs/proof/aggregate-review-recovery/run-proof.mjs --baseline --output .artifacts/recovery-baseline.json
node docs/proof/aggregate-review-recovery/run-proof.mjs --output .artifacts/recovery-candidate.json
node --test test/repair/review-recovery.test.ts test/sweep-workflow.test.ts
```

The baseline executes the workflow at
`7f29952363878ca3b5d1f25be8d40a9f6ced784c`. Its failed-shard recovery admits
every planned item, including a nonretryable refusal, completed items, an
uncertain late mutation, and an unstarted tail. The filtered fixture uses the
production selection owner: planned `[1,2,3]` becomes selected `[1,3]`, but
baseline recovery still admits all three. These are intended red outcomes.

## Executed Boundaries

The native review ledger owner emits starts, logs, item terminals, coordination
receipts, and the final batch terminal. Its native finalizer writes canonical
shards. A synthetic input-scan refusal exits the producer process with code 79;
recovery never changes that outcome. Negative fixtures use native canonical
writers, except the deliberate byte-corruption unit case.

The harness executes the actual workflow staging and enqueue shell blocks.
The built production workflow utility reads exact-attempt artifacts and stages
verified reports; production `apply-artifacts --skip-reconcile` and targeted
`reconcile` consume them through the existing publisher boundaries. The
retained-prefix success and late-uncertainty cases also run `publish-main`,
comment-only `apply-decisions`, and both required artifact/comment receipt
workflow blocks. Their signed record tuple, comment, and immutable receipt
writes must contain only the retained items.

The actual enqueue `curl` reaches only a local signed HTTP server, which checks the
signature, delivery identity, item membership, and non-superseding decision.
Queue, GitHub, and read-model responses and credentials are synthetic. The
existing ledger-isolation transport restricts Node sockets and fetches to that
server and adapts the production GitHub command boundary.

Scenarios cover accepted, deduplicated, shed, disabled, and failed ACKs;
completed/cached and nonretryable exclusion; filtered membership; late and
unmatched mutation; resolved accepted/rejected mutation; mutation-only and
unsupported/ambiguous terminals; missing/incomplete/foreign artifacts; and
report identity/digest mismatches. Failed ACKs retain the existing three tries
per eligible item and a failed recovery exit. Item dispositions, admission
results, and the original review failure remain visible in the actual summary.

Receipts record the checkout/base SHAs, workflow/fixture/harness/source digests,
actual queue requests, producer/recovery exits, and retained report names.
Focused CLI tests additionally reject every foreign producer identity field,
corrupted canonical bytes, and linked reports.

## Limits

This proves executable production command boundaries with synthetic data, not
hosted Actions scheduling/artifact availability, model execution, scanner
effectiveness, live queue admission, production record durability, or public
comments. The real record and receipt clients receive synthetic loopback
acknowledgements; this is not production publication. Existing publisher guard
and receipt paths are unchanged. No live
apply, queue, workflow dispatch, deployment, or credential change is used.

Bay's existing public projection is checked for every optional-ledger and
recovery job step. Workflow wording prevents recovery from being presented as
active model review or completed publication. No dashboard runtime or controls
change. The existing review-step failure and job-level continuation policy are
preserved; a green aggregate job is not evidence that every item recovered.

Automatic unstarted-tail recovery and independent locked-item classification
remain named follow-ups, not inferred behavior in this change.
