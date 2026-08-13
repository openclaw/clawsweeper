# Dashboard strict slice 2 proof

## Claim

Enabling strict TypeScript checks for the remaining 13 non-giant dashboard
modules does not change the dashboard Worker's queue or status responses.

## Exercised surface

`run-proof.mjs` reuses the established real-Worker comparison in
`docs/proof/queue-policy-readmodel-extraction/run-proof.mjs`. It archives the
merge-base, starts merge-base and candidate Workers through local Wrangler,
seeds each independent SQLite-backed `ExactReviewQueue` through the signed
enqueue route, and compares normalized `/api/exact-review-queue` and
`/api/status` JSON bytes.

The harness starts Wrangler in its own process group, terminates that complete
process tree, and waits for exit before booting the next Worker. The wrapper
also asserts that six items came back from the durable queue, proving that the
Durable Object was instantiated rather than accepting a Worker-only response.

The wrapper requires a clean committed checkout and writes a slice-specific
summary under ignored `.artifacts/dashboard-strict-slice-2/`. Its receipt is
`COMMITTED` only when `HEAD` is a commit and tracked files are clean.
Crabbox raw sync intentionally omits Git metadata, so the container command
receives both revisions from programmatic host-side Git queries and hydrates a
temporary Git object store from an uncommitted `source.bundle`. The bundle is a
transport artifact only and is removed after the run.

## Run

From the repository root on Node 24 or newer:

```bash
docs/proof/dashboard-strict-slice-2/run-proof.sh \
  "$(git rev-parse HEAD)" \
  "$(git merge-base HEAD origin/main)"
```

## Expected observation

- `check:dashboard-strict`, the focused ratchet test, and the full `check` gate
  pass;
- the seeded merge-base and candidate queues both accept six items through the
  SQLite-backed Durable Object;
- Wrangler's complete process group exits between the two boots;
- normalized queue and status responses are byte-identical;
- the proof summary records the merge-base, candidate head, response hashes,
  and `COMMITTED` receipt;
- no production system is contacted or mutated.

## OpenClaw Bay and limits

OpenClaw Bay is unaffected. Its public projection is included in the normalized
status response and remains byte-identical and observer-only; this slice adds
no queue, workflow, GitHub, recovery, deploy, or rollback action.

The scenario uses synthetic pending reviews and a deterministic loopback
GitHub error stub. It does not contact GitHub, acquire review leases, publish
records, deploy a Worker, or mutate production.
