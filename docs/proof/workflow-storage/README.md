# Workflow coverage and content census proof

Run from the repository root with installed `miniflare`, `esbuild` and `workerd`
available through `PROOF_TOOL_ROOT` (a directory containing `package.json`):

```sh
PROOF_TOOL_ROOT=/path/to/runtime-tools node docs/proof/workflow-storage/run-proof.mjs
```

This local-only fixture rejects outbound fetches. It archives the pinned baseline
`69d79662aa5d54f8a4771a1b5cd017925c31f57c`, loads the actual queue class, seeds
SQLite, then restarts the candidate against the same named Durable Objects and
persisted SQLite files. Temporary source, bundles and databases are removed on
exit. It does not access Cloudflare or deploy the fixture.

The proof measures initial index creation separately on 227,965 coverage rows.
It verifies bounded alarm deletion, a 513-row idle drain across restart,
preservation of census/unknown kinds, refresh before expiry, an earlier queue
wake and future expiry without new ingress. The census calls the actual
storage-stats handler and SQL helper with 130 sparse row identities, skewed
UTF-8 text, NUL, BLOB and numeric values. It verifies exact content totals,
the 128-row query plan, read-only execution, restart and exclusion of inserts
above the captured upper identity.

Timing is one local runtime observation, not a production latency guarantee.
Content totals exclude numeric storage, indexes and SQLite allocation overhead;
concurrent pages are not one atomic snapshot.
