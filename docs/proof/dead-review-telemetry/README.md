# Dead per-item review telemetry proof

This proof exercises the built dashboard Worker and `ExactReviewQueue` Durable Object through real
HTTP using local Wrangler persistence.

The behavior contract is:

- a persisted queue database containing `exact_review_review_telemetry` and its three indexes
  upgrades without a schema error and drops the retired objects;
- `/api/status` omits `exact_review_queue.review_telemetry_health` while `/api/health` remains OK;
- a signed run-level telemetry write appears in the four-row `/api/review-observability` lane view;
- the removed internal per-item write route and public per-item read route return 404.

Run `docs/proof/dead-review-telemetry/run-proof.sh`. Set
`DEAD_REVIEW_TELEMETRY_PROOF_OUTPUT` to keep artifacts outside the repository. The proof is local
Worker/Durable Object evidence; it does not deploy or mutate production and does not validate
production traffic volume.
