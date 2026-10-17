# Canonical body tiering native proof

- Status: controlled native proof passed; no production execution authority
- Owner: ClawSweeper storage and queue maintainers
- Source: `worker.ts`, `run-proof.mjs`, and the canonical queue/store owners
- Frozen persisted baseline: `291ab8a0090a8f76c08e4d0e39ea4cf1fdcbe0c0`
- Update when: representation, publication fences, export/snapshot protocol, or runtime changes

Run from the repository root with pinned Miniflare, Workerd and esbuild available
through a directory containing `package.json`:

```sh
PROOF_TOOL_ROOT=/path/to/runtime-tools node docs/proof/canonical-body-tiering/run-proof.mjs
```

When the remote checkout has no Git metadata, set `PROOF_BASELINE_ARCHIVE` to a tar
created by `git archive 291ab8a0090a8f76c08e4d0e39ea4cf1fdcbe0c0 dashboard src config package.json`.
The runner reports that archive’s SHA-256. It never substitutes a synthetic old schema.

The fixture imports the actual frozen queue and canonical owner, seeds schema 1,
then restarts the candidate against the same named SQLite Durable Objects and
native R2 bucket. Outbound fetches are rejected. The runner uses temporary source,
bundles and persisted databases, removed on exit. Nothing is deployed to Cloudflare.

Assertions cover exact exports across restart and detachment, empty/Unicode/NUL,
inline/chunked/maximum bodies, all sections and tombstones, unchanged receipt and
export identities, per-pass caps, native conditional object reuse, missing-body
errors, abandoned upload preparation, final queue ownership fences, direct versus
batch receipt retries, and snapshot restoration through the actual runner client.
Query plans and native rows-read counts compare baseline, dormant candidate, and
migrated pages, and instrument every actual migration pass. Timings include fixture IPC and R2; host RSS and CPU are not isolate
memory or CPU measurements and do not qualify production capacity.

Focused tests add SQL-commit rollback, concurrent overwrite and deletion capture,
complete tuple conflict hydration, stale-source answers, coverage parity including
astral Unicode and SQLite NUL termination, warm format fencing, retention-boundary retries, bounded stream
cancellation, lifecycle policy comparison using controlled responses, and mixed
canonical/backfill preservation with concurrent export changes and invalid owner pointers.

The real bucket lifecycle, deployed identity, approved rollback floor, production
headroom, and the human production execution confirmations remain separate gates.

Observed on 2026-10-16 with Workerd `1.20260911.1`, Wrangler `4.131.1`,
Node `24.19.0`, and the frozen baseline archive SHA-256
`3cf5aca6439184c2c1c3a846f7ac293a4ee3c58aad1edd74dfe2b3e39bed5c6a`:

| Check                           | Observed result                                                                                                                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lossless physical move          | 3,028 rows; exact before/after export digest, revisions, timestamps, receipts and sequence equal                                                                                             |
| Resumable migration             | 253 passes; at most 13 scanned identities and 6,291,878 source bytes in this fixture; configured caps remain 64 identities, 4 tuples and 8 MiB                                               |
| Migration SQL reads | Maximum native rows read per query: records 64, tuple metadata 19, schema catalog 160; at most eight tuple queries per pass; both physical stores seek all three composite-key columns |
| Mixed canonical/backfill tuple | Separate frozen-baseline fixture: one backfill-only plan among 17 export entries; body, pointer and full export roundtrip equal after migration and restart |
| SQL allocation                  | 18,489,344 bytes before; 18,505,728 peak; 2,260,992 after                                                                                                                                    |
| New maximum-size writes         | 6 MiB of native R2 bodies; 12 KiB SQL growth; unchanged v1 row count                                                                                                                         |
| Snapshot and runner             | 1,011 live files restored byte-for-byte; watermark 3,028                                                                                                                                     |
| Indexed coverage/listing/export | Native maximum rows read per query: baseline 206/200/103; dormant 408/402/103; migrated 402/402/103; no body-view materialization                                                            |
| Queue authority                 | Expiry, cancellation, generation change, batch expiry and replacement all refused after the final R2 await                                                                                   |
| Retry and recovery              | Accepted direct response replay, strict changed direct rejection, changed batch replay during R2 outage, upload-before-commit restart, and missing/corrupt body infrastructure errors passed |

The observed migration pass wall time was about five seconds total, including
native R2 and fixture IPC. This small fixture does not establish production
throughput, an isolate CPU budget, or an isolate memory bound. A single explicit
CLI invocation can run up to 100,000 passes or 50 minutes and resume the same
approved plan later. Actual bucket lifecycle inspection, production headroom,
qualified deployment identity and the three human confirmations remain required.
