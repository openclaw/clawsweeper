# Red/green record

The RED phase ran from fresh `origin/main` at `56cb78d60734ddc62b5f1e49981bbb4556dcb58d` after adding the contract fixtures and before changing production code.

The protocol-v2 command-shaped batch fixture first accepted canonical content, then retried the same target, fence, and revision with refreshed bytes. Main returned the observed production failure:

```text
direct publication plan rejected: conflicting direct publication retry
AssertionError: 400 !== 202
tests 1, pass 0, fail 1
```

The operator fixture then supplied a `tuple_protocol_invalid` row with a stale source head plus a digest-valid completed canonical record at the live head. Main left it unresolved because the reason was excluded:

```text
AssertionError: 0 !== 1
tests 2, pass 1, fail 1
```

The passing RED scenario was the required control: a `tuple_protocol_invalid` row whose source head still equaled the live head already used fresh recovery and was not superseded.

GREEN narrows terminal first-write-wins behavior to the actively owned batch route, retains the strict direct-producer conflict response, allows only evidence-proven tuple rows into supersession, and keeps current-head tuple rows on recovery. The complete focused command passes:

```text
node --test test/dashboard-worker-publication-lifecycle.test.ts test/exact-review-dead-letter-operator.test.ts test/exact-review-publication-batches.test.ts
tests 176
pass 176
fail 0
```

Docker-backed Crabbox `local-container` reproduced the same 176/176 GREEN result on committed source head `080904359d54c6e2cdf9b0e314bf44471c09d196`. The container's subsequent full docs gate stopped because bounded Crabbox sync omitted unrelated historical proof artifacts; the complete host checkout passed the authoritative full gate:

```text
pnpm run check
tests 3405
pass 3396
fail 0
skipped 9
```
