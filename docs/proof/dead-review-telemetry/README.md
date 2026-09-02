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
- the removed internal per-item write route returns 404;
- the documented public per-item read route returns its stable HTTP 200 envelope with an empty
  `reviews` array.

The proof first boots the Worker to create the real queue database, stops it, and seeds the retired
table plus its three indexes. The stop terminates the full Wrangler process tree and confirms the
health endpoint is down, preventing a child process from surviving as a fake restart. After restart,
the first upgrade request is the signed run-level telemetry write. Once the remaining HTTP
observations are complete, the proof stops the Worker and uses `node:sqlite` to find that unique row
in the queue database. A missing row fails explicitly with `Durable Object did not initialize`;
only a confirmed row allows the retired-schema assertion to run. This prevents a cached or
snapshot-served HTTP 200 from being mistaken for Durable Object initialization.

Run `docs/proof/dead-review-telemetry/run-proof.sh`. Set
`DEAD_REVIEW_TELEMETRY_PROOF_OUTPUT` to keep artifacts outside the repository. The proof is local
Worker/Durable Object evidence; it does not deploy or mutate production and does not validate
production traffic volume.

## Earlier Crabbox provenance

The removal-only revision of this proof ran on reviewed head
`087100c3ab9343563c42ac57243cde03ad1733a5`
inside a Docker-backed Crabbox `local-container` using Crabbox CLI 0.39.0, image
`node:24-bookworm`, Docker 29.4.0 via OrbStack, lease `cbx_7e5d92b51d8b`, and a clean
`--fresh-pr` checkout. It completed with `PROOF_RC=0`. See the
[Crabbox provenance](artifacts/crabbox-local-container-provenance.json) and
[captured stdout](artifacts/crabbox-local-container-stdout.log). Corepack is enabled into the
container user's `~/.local/bin` because the lease user is unprivileged. Current fresh-PR container
provenance belongs in the pull request's `pr-behavior-proof` section.

Earlier revisions passed on macOS and failed in the container because `stop_worker` killed only the
Wrangler parent and left the child `workerd` alive, so the restart was a no-op and the Durable Object
was never re-initialized. The proof now kills the full process tree, waits for `/api/health` to stop
answering, and asserts that the posted `run_id` is present in the inspected queue database before
asserting the retired schema.
