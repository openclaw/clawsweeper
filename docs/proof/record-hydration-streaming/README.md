# Record hydration streaming proof

- Status: proof for streaming canonical record hydration
- Owner: ClawSweeper record-state maintainers
- Source: `scripts/worker-records.ts` (`streamWorkerRecordExport`, `materializeRecords`)
- Update when: journal export pagination, record staging, or the snapshot producer changes

## Problem

`materializeRecords` serves both `setup-state` hydration and the scheduled snapshot producer. Before writing anything, it collected the whole journal delta since the last stored snapshot into an in-memory Map.

The review-record backfill then rewrote nearly every `openclaw-openclaw` record, and the delta came to hold most of the repository's record content at once. Two failures followed from that:

- The scheduled snapshot job ran out of memory. For example, `node scripts/worker-records.ts snapshot-upload` died at about 3.7 GB after 23 minutes on 2026-10-10. Without new snapshots, the delta kept growing.
- Every apply run died in `setup-state` at about 3.7 GB. As a result, no automatic closures landed for openclaw/openclaw. See https://github.com/openclaw/clawsweeper/issues/1874.

## Change

`streamWorkerRecordExport` now owns pagination, validation, the per-identity newest-revision choice, and the cold-repository bound. It hands each page's winning records to a callback. `materializeRecords` writes them into the staged tree as each page arrives, and keeps only an identity-to-`storeRevision` map in memory.

Staging, watermarks, and replace-on-success are unchanged. `exportWorkerRecords` remains as a collector over the same core.

## Command

```sh
node docs/proof/record-hydration-streaming/run-proof.mjs <base-checkout> <candidate-checkout> receipt.json
```

Each run executes `docs/proof/record-hydration-streaming/hydrate-child.mjs` in a child process with `--max-old-space-size=384`. The child calls the checkout's real `materializeWorkerRecords` against a fixture Worker:

- a one-record stored snapshot, downloaded through the chunk route;
- a journal delta of 2,400 records of 512 KiB each, about 1.2 GB in total;
- export pages of four records, about 2 MiB each, like the byte-bounded production export route;
- a canonical item list.

## Observed

| Run | Commit | Result |
| --- | --- | --- |
| Base (main) | `acf20cfb61` | `FATAL ERROR: Reached heap limit` (SIGABRT) |
| Candidate | `ba584b66c0` | All 2,401 files materialized; `deltaRecords` 2400; 3 of 3 sampled contents exact; 600 export requests; peak heap 53 MiB; 8.4 s |

Environment: macOS arm64, Node 24.21.0. The receipt is [`receipt.json`](receipt.json), with SHA-256 `49501273208d0f4e3fae4dd32345d1b8e3df89016a2021d3fe2c0f5f2e1a6e66`.

Regression tests in `test/record-snapshot-runner.test.ts` cover the following:

- The newest revision wins when an older one arrives on a later page.
- A later page's delete removes a file that an earlier page wrote.
- The streamed export still aborts mid-pagination at the cold bound.

## Limits

The records and the Worker responses are synthetic. No production records, secrets, or GitHub writes are used. The production export route bounds each page by source bytes; that is approximated here with fixed-size records.

OpenClaw Bay is not affected: no public status, lifecycle, or projection field changes.
