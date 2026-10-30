# Canonical body tiering native proof

- Status: controlled native proof passed; no production execution authority
- Owner: ClawSweeper storage and queue maintainers
- Source: `worker.ts`, `run-proof.mjs`, and the canonical queue/store owners
- Frozen persisted baseline: `291ab8a0090a8f76c08e4d0e39ea4cf1fdcbe0c0`
- Frozen throughput baseline: `ea6d72efc0a2e2c0683ad984b060b5c22008ce57`
- Update when: representation, publication fences, export/snapshot protocol, or runtime changes

Run from the repository root with pinned Miniflare, Workerd and esbuild available
through a directory containing `package.json`:

```sh
PROOF_TOOL_ROOT=/path/to/runtime-tools node docs/proof/canonical-body-tiering/run-proof.mjs
```

When the remote checkout has no Git metadata, set `PROOF_BASELINE_ARCHIVE` to a tar
created by `git archive 291ab8a0090a8f76c08e4d0e39ea4cf1fdcbe0c0 dashboard src config package.json`.
The runner reports that archive’s SHA-256. It never substitutes a synthetic old schema.
The serial-throughput comparison also needs an archive of the same paths at
`ea6d72efc0a2e2c0683ad984b060b5c22008ce57`, supplied as
`PROOF_THROUGHPUT_BASELINE_ARCHIVE` when Git history is unavailable.

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

The throughput comparison uses the actual frozen serial owner and the candidate
on identical synthetic records, native SQLite and native R2. Both timed legs use
prewarmed immutable objects and exercise conditional reuse under equal bucket
preconditions. A controlled 20 ms delay per operation exposes overlap; full GET streams still
pass through the production integrity reader. It records wall time, operation
count and peak concurrency, requiring four concurrent candidate operations and
identical exported bytes, revisions and tombstones. Failure proof requires all
started I/O to drain with SQL and checkpoint unchanged and no new PUT pipeline
after failure. Foreground publication must interleave and win its tuple CAS.
These timings are a synthetic comparison, not a production throughput estimate.

Requalification proof restarts a partially migrated serial checkpoint under a
new deployment identity, rejects ordinary preview and the wrong approval hash,
applies the reviewed envelope, rejects old prepared passes and replays, then
restarts again and resumes with every progress field preserved.

Focused tests add SQL-commit rollback, concurrent overwrite and deletion capture,
complete tuple conflict hydration, stale-source answers, coverage parity including
astral Unicode and SQLite NUL termination, warm format fencing, retention-boundary retries, bounded stream
cancellation, lifecycle policy comparison using controlled responses, and mixed
canonical/backfill preservation with concurrent export changes and invalid owner pointers.

The real bucket lifecycle, deployed identity, approved rollback floor, production
headroom, and the human production execution confirmations remain separate gates.

Throughput and requalification proof passed on 2026-10-19 through AWS Crabbox
(`run_ffe608e45de9`), Node `24.19.0`, Workerd `1.20260911.1`, Miniflare
`5.20260911.0-alpha`, and esbuild `0.28.1`. The frozen serial source archive hash
was `1a7756c6b4f2ae90da5835fe8f3b0ece2d515c7b842b808b15163b9ab7323dd3`.
Both timed legs migrated the same 96 records in six passes with prewarmed bodies
and 20 ms added per R2 operation: serial 2,077 ms / 96 calls / peak 1; candidate
564 ms / 60 calls / peak 4. The export digest was identical before and after.
The injected failure drained all eight started operations with no new PUT after
failure. Foreground publication won its tuple CAS. Requalification retained the
96-row frontier, cursor 16 and migrated count 16 across restart, rejected the
wrong approval hash, old prepared pass and replay, then completed all 96 rows.
The full format-upgrade fixture also passed 253 bounded passes; its maximum
observed source bytes per pass remained 6,291,878, below the fixed 8 MiB cap.

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
qualified deployment identity and explicit operator approval remain required.
