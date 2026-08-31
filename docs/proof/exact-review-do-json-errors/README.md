# Exact-review Worker safe JSON error proof

This proof starts the actual local Wrangler Worker and its ExactReviewQueue
Durable Object, then drives the signed internal
`/internal/exact-review/publications/list` route through the real Workers
Durable Object boundary. A proof-only entry module re-exports the production
`ExactReviewQueue` with its real SQLite `storage.sql.exec` wrapped so one
marked request fails the `SELECT item_key, item_json` state read with an
stack-bearing rejection string carrying a planted GitHub token and a synthetic
internal file path. The production route code, worker forwarding, HMAC
verification, storage initialization, and every other request run unmodified.

The scenario sends three identical-shape signed requests: a baseline list
(expect 200), the marked failing request, and a recovery list (expect 200).
The script detects whether the checked-out tree contains the fix and asserts
accordingly:

- before (base tree): the Worker returns the stack-bearing rejection text in
  its JSON 500, including the synthetic internal file path.
- after (fixed tree): the Durable Object still rejects so its transaction
  remains fail closed, while the Worker returns HTTP 500 with
  `content-type: application/json` and body
  `{"error":"exact_review_queue_unavailable"}`. The planted token and internal
  path never reach the client, and the Worker records the bounded
  `exact_review_queue_request_failed` diagnostic event.

Run from the repository root of the tree under test:

```bash
crabbox run \
  --provider local-container \
  --local-container-image node:24-bookworm \
  --no-hydrate \
  --timing-json \
  --script docs/proof/exact-review-do-json-errors/run-proof.sh \
  --require-artifact '.artifacts/exact-review-do-json-errors/proof-summary.json' \
  --artifact-glob '.artifacts/exact-review-do-json-errors/**'
```

The invariant proven is the Worker-facing failure contract: a stack-bearing
Durable Object rejection becomes a fixed JSON 500 without changing the Durable
Object transaction boundary or losing the internal failure event.
