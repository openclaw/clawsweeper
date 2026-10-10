# Publish-main record diff proof

- Status: proof for streaming the canonical tuple diff in publish-main
- Owner: ClawSweeper record-state maintainers
- Source: `src/repair/publish-main.ts` (`planCanonicalRecordTuples`)
- Update when: canonical tuple planning or record publication paths change

## Problem

Apply checkpoints publish `--path records/openclaw-openclaw`. To find the changed tuples, `planCanonicalRecordTuples` read every record file of the working tree and of the hydrated state tree into two Maps.

The review-record backfill made those trees large, and the result was two full copies of the repository's records in memory at once. Run https://github.com/openclaw/clawsweeper/actions/runs/38034255814 shows the failure. `apply-decisions` finished normally, then `node dist/repair/publish-main.js --path records/openclaw-openclaw` hit `Reached heap limit` within ten seconds. The apply lane therefore still failed after https://github.com/openclaw/clawsweeper/pull/1877 and https://github.com/openclaw/clawsweeper/pull/1880 (https://github.com/openclaw/clawsweeper/issues/1874).

## Change

Planning now collects paths only, with the same symlink and regular-file checks. It compares each file pair as it goes and keeps only the changed paths.

Changed tuples read their contents on demand through the existing containment-checked reader. Published tuples and their operations are unchanged.

## Command

```sh
pnpm run build:repair   # in both checkouts
node docs/proof/publish-main-record-diff/run-proof.mjs <base-checkout> <candidate-checkout> receipt.json
```

Each run executes `publish-child.mjs` with `--max-old-space-size=384`. The child calls the checkout's real `publishMainWithStateAppend` for `records/openclaw-openclaw`. The scenario has a source tree and a hydrated state tree of 1,600 items × 512 KiB each, about 800 MB per tree. Items 1 and 2 are updated and item 3 moves to `closed/`. A fixture queue accepts the posted tuples, and git fallback is forbidden.

## Observed

| Run | Commit | Result |
| --- | --- | --- |
| Base (main) | `a6d9984991` | `FATAL ERROR: Reached heap limit` (SIGABRT) |
| Candidate | `0cb88366bb` | `appended`; posted exactly `openclaw-openclaw/1`, `/2`, `/3`; peak heap 29 MiB; 0.7 s |

Environment: macOS arm64, Node 24.21.0. The full record is in [`receipt.json`](receipt.json).

`test/repair/publish-main.test.ts` adds a whole-repository case: 30 unchanged items, one modified, one moved to `closed/`, and one new. It expects exactly the three changed tuples, and it passes on both base and candidate, confirming identical publication behavior.

## Limits

Records and queue responses are synthetic. No production records, secrets, or GitHub writes are involved.

OpenClaw Bay is not affected: no public status, lifecycle, or projection field changes.
