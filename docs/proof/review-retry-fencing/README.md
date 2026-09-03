# Exact-review retry fencing proof

This proof places a review at its exhausted parked budget and drives recovery
through the production `ExactReviewQueue` Request/Response boundary. It requires
an unchanged source identity to remain parked without a new queue revision,
then proves that a changed pull-request head and an explicit retry-policy epoch
each receive a fresh bounded budget.

Run it on Node 24 or newer:

```bash
docs/proof/review-retry-fencing/run-proof.sh "$(git rev-parse HEAD)"
```

The generated result defaults to
`.artifacts/review-retry-fencing/result.json`. Set
`REVIEW_RETRY_FENCING_PROOF_OUTPUT` to use another artifact destination.

For PR proof, execute the same script in Docker-backed Crabbox
`local-container` with `node:24-bookworm`. The production queue code runs with
the repository's SQLite-backed local Durable Storage harness. This is not
deployed `workerd`, uses only synthetic identities, and makes no GitHub or live
queue request.
