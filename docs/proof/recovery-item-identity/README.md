# Recovery item identity proof

Status: active validation recipe. Owner: review recovery.
Source: `src/review-recovery.ts` and `.github/workflows/sweep.yml`.
Baseline: `49446cd30622e642efceb80e1c0347b2602a0117`.
Update when ledger classification, recovery output, or enqueue payloads change.

## Contract

A mixed manifest-backed shard preserves issue versus PR identity through the
built recovery CLI and the actual workflow shell. Only retryable item terminals
produce signed enqueue requests. A terminal scanner refusal and held neighbors
remain excluded. An opaque discussion revision is never passed as a head SHA
or queue content hash.

With Node 24+, Bash 4+, jq and frozen dependencies installed, run:

```sh
pnpm run build:node
node docs/proof/aggregate-review-recovery/run-proof.mjs --identity-only --output .artifacts/recovery-identity.json
node --test test/repair/review-recovery.test.ts
```

The fixture drives the production review-ledger writer, importer, recovery CLI,
and workflow shell. A real loopback HTTP receiver verifies request signatures
and records the actual outgoing decisions: PR 3 and issue 4, once each. PR 7's
terminal refusal remains excluded. Completed reports 1 and 2 retain the existing
staging and publisher checks. The fixture has no production credentials.

Limits: the queue response and GitHub boundary are synthetic. This proves
producer routing and terminal selection, not queue availability or a complete
cross-lane refusal fence. Bay receives the existing correct item-kind contract;
no public fields, observer controls, or Bay rendering change is needed.
