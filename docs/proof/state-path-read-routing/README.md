# State-path classification proof

- Status: historical repair proof recipe, not an operational runbook or a live review attestation.
- Owner: ClawSweeper review and publication maintainers.
- Source of truth: the classifier, report writer, public renderer, and readiness owners exercised by the script.
- Baseline: `a3840356d894e66c507ec5e3beb55c65e5958338`.
- Update when: those owners, the captured fixture, or this recipe changes.

The [replay](../../../scripts/e2e/state-path-proof.mjs) exercises compiled production classification, report writing, saving and reopening the report, public comment rendering, and readiness/automation markers. Review metadata and surrounding formatting inputs are synthetic; the Reporting patch is the exact public fixture from [OpenClaw PR 156686](https://github.com/openclaw/openclaw/pull/156686). No model inference, GitHub publication, or database upgrade is performed.

Build the chosen runtime before replaying it:

```sh
pnpm run build
node scripts/e2e/state-path-proof.mjs . candidate .artifacts/state-path-proof/candidate
```

The first argument selects the compiled runtime checkout. To reproduce the original result, build the pinned baseline in another checkout, invoke this same replay script with that checkout as its first argument, and use `baseline` instead of `candidate`. The captured input fixture always comes from beside the replay script, so both runtimes receive identical input. The script does not modify source or compile either revision. It writes the actual reports, rendered comments, and a receipt under the supplied output directory.

The baseline requires migration proof for both the full and production-normalized Reporting patch. The candidate removes those false holds. Binary reads through bare, member, optional, awaited, parenthesized, bracket-member, and wrapped state paths remain blocked without compatibility proof, as do stream/open/descriptor and append/truncate operations, real JSON writes, browser storage, incomplete known persistence owners, and SQLite DDL. A state-path hint and file-read evidence cannot combine across separate hunks. Within one semantic hunk, the existing policy stays conservative: unrelated state-path and source-read signals can still require compatibility review. The recipe records that limitation; it does not treat patch evidence as JavaScript dataflow analysis.

The descriptor control with an unchanged state-path hint records a prior omission: the baseline is ready, while the candidate correctly retains the compatibility hold when only the I/O operation changes.

The checked-in compact receipts record the executed baseline and candidate cases, source/compiled/fixture hashes, runtime, and report/comment hashes. The synthetic ready/pass results establish only this reporting contract; they do not authorize a real PR merge or erase unrelated review findings.
