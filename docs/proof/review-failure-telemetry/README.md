# Exact-review failure telemetry proof

This proof drives two failed completions for one unchanged source identity
through the production `ExactReviewQueue` and dashboard Worker Request/Response
boundaries. It requires the durable ledger to retain two distinct claim
attempts, reject completion replay, classify the repeated identity as critical,
publish only closed aggregate counts, expose the bounded signed operator
inventory, and raise dashboard health to red.

Run it on Node 24 or newer:

```bash
REVIEW_FAILURE_TELEMETRY_PROOF_OUTPUT=/tmp/review-failure-telemetry-result.json \
  docs/proof/review-failure-telemetry/run-proof.sh "$(git rev-parse HEAD)"
```

For PR proof, execute the same script in Docker-backed Crabbox
`local-container` with `node:24-bookworm`. The production queue and Worker code
run with the repository's SQLite-backed local Durable Storage harness. This is
not deployed `workerd`, it uses only synthetic source identities, and it makes
no GitHub or production queue request.
