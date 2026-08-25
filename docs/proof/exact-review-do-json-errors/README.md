# Exact-review Worker sanitized JSON error proof

This proof starts the actual local Wrangler Worker and its ExactReviewQueue
Durable Object, then drives the signed internal
`/internal/exact-review/publications/list` route through the real Workers
Durable Object boundary. A proof-only entry module re-exports the production
`ExactReviewQueue` with its real SQLite `storage.sql.exec` wrapped so one
marked request fails the `SELECT item_key, item_json` state read with an
error message carrying a planted GitHub token. The production route code,
worker forwarding, HMAC verification, storage initialization, and every other
request run unmodified.

The scenario sends three identical-shape signed requests: a baseline list
(expect 200), the marked failing request, and a recovery list (expect 200).
The script detects whether the checked-out tree contains the fix and asserts
accordingly:

- before (base tree): the injected Durable Object failure escapes the Worker,
  and the client receives a non-JSON 500 with no sanitized error contract; in
  the local dev runtime the error page also exposes the planted token to the
  client.
- after (fixed tree): the Durable Object still rejects so its transaction
  remains fail closed, while the Worker converts that rejected stub call into
  HTTP 500 with
  `content-type: application/json` and body
  `{"error":"injected sqlite read failure exposing GH_TOKEN=[REDACTED]"}`;
  the planted token never reaches the client.

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

Limits: the before-mode HTML error page is the local dev runtime's rendering
of the escaped exception; deployed workerd returns its generic internal-error
response instead. The invariant proven is the Worker-facing failure contract:
an escaped Durable Object rejection becomes a sanitized JSON 500 without
changing the Durable Object transaction boundary.
