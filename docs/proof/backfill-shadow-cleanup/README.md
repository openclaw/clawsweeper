# Canonical backfill shadow cleanup proof

- Status: historical proof fixture; never deploy
- Owner: ClawSweeper maintainers
- Source of truth: the actual queue and direct-publication store bundled here
- Baseline: `b4cc911db6ed4a995d99f4fc7cc1eeb5492a4051`
- Update when: the cleanup predicate, checkpoint, or alarm ownership changes

Run `node docs/proof/backfill-shadow-cleanup/run-proof.mjs` with Wrangler on PATH.
The runner archives the pinned baseline's build inputs, starts its actual queue,
and restarts the same local SQLite object under the candidate. All storage and
R2 objects are disposable, local, synthetic fixtures. The Worker rejects outbound
fetches and never contacts production Cloudflare.

The fixture checks canonical publication and tuple replay, retained queue and
lifecycle rows, full paginated export and delta equality, snapshot bytes,
SQL/KV rollback, persisted finite progress, automatic idle alarms, completion,
and preservation of a future queue wake. Missing or mismatched ownership,
numeric aliases, live imports, and both commit export sources are preserved.

The populated case measures a 64-row batch with 2 MiB logical bodies and four
512 KiB Base64 chunks per row. It seeds one record at a time, then reports native
SQLite row counts, elapsed alarm time, logical retired bytes, and physical
database bytes separately. External admission timestamps include a warm baseline,
the cleanup interval, and a separate control object. These are local synthetic measurements, not a
production capacity guarantee, eligible-byte census, or reclamation promise.
