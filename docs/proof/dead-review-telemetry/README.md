# Dead per-item review telemetry proof

This proof exercises the built dashboard Worker and `ExactReviewQueue` Durable Object through real
HTTP using local Wrangler persistence.

The behavior contract is:

- a persisted queue database containing `exact_review_review_telemetry` and its three indexes
  upgrades without a schema error and drops the retired objects;
- after restart, a signed run-level telemetry write with a unique `run_id` forces the Durable
  Object to initialize, and that exact row exists in the same SQLite file inspected for the
  retired schema before the proof asserts that the retired objects are gone;
- `/api/status` omits `exact_review_queue.review_telemetry_health` while `/api/health` remains OK;
- a signed run-level telemetry write appears in the four-row `/api/review-observability` lane view;
- the removed internal per-item write route and public per-item read route return 404.

The proof first boots the Worker to create the real queue database, stops it, and seeds the retired
table plus its three indexes. After restart, its first upgrade request is the signed run-level
telemetry write. Once the remaining HTTP observations are complete, the proof stops the Worker and
uses `node:sqlite` to find that unique row in the queue database. A missing row fails explicitly
with `Durable Object did not initialize`; only a confirmed row allows the retired-schema assertion
to run. This prevents a cached or snapshot-served HTTP 200 from being mistaken for Durable Object
initialization.

Run `docs/proof/dead-review-telemetry/run-proof.sh`. Set
`DEAD_REVIEW_TELEMETRY_PROOF_OUTPUT` to keep artifacts outside the repository. The proof is local
Worker/Durable Object evidence; it does not deploy or mutate production and does not validate
production traffic volume.
