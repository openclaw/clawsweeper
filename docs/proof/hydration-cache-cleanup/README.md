# Persistent hydration cache retirement

Run `node docs/proof/hydration-cache-cleanup/run-proof.mjs` in the prepared
Linux Crabbox workspace with `wrangler` available. This local-only fixture
starts the actual `ExactReviewQueue` from baseline
`8cf2991cefeee11414e011cdb5aa51f70c151f14`, then the candidate, then the baseline
again against the same named Durable Object and persisted Workerd SQLite.
The baseline Git object must be present; the runner never fabricates Git HEAD.

The proof seeds ordinary and chunked cached reports, durable publication and
tuple receipts, a queue item, and lifecycle state. It checks a failed atomic
checkpoint, restart and automatic alarm completion, exact removed UTF-8 bytes,
independently normalized exports, fresh delta and snapshot revisions, immutable
old snapshot bytes, original receipt replay, stale expected-digest rejection,
and rollback readability. It reports native SQLite rows read and written per
large-record alarm. Outbound requests fail locally. The fixture deletes its
own temporary state and stops only its recorded child process group.

This proves local Workerd behavior. It does not mutate Cloudflare, measure the
production cache fraction, or promise immediate physical database shrinkage.
