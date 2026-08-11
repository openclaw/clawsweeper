# Dashboard page renderer extraction proof

## Claim

Extracting the server-side dashboard page renderers from `dashboard/worker.ts` into
`dashboard/dashboard-pages.ts` does not change the rendered bytes for `/`, `/triage`, or
`/pr-proof-triage`.

## Exercised surface

[`run-proof.sh`](run-proof.sh) starts the real local Wrangler Worker twice: once from the exact
`origin/main` merge base in a detached temporary worktree and once from the current committed head.
It fetches all three moved page surfaces, normalizes ISO timestamps and generated 40-character
hexadecimal SHAs, and requires the normalized diff to be empty. The source-blind validator executes
the separate [`behavior contract`](behavior-contract.md) through HTTP only.

## Artifacts

- `artifacts/page-comparison.json`: base/head byte counts, raw hashes, normalized hashes, and equality
- `artifacts/normalized.diff`: the normalized page diff; this file is empty on success
- `artifacts/behavior-validation.json`: source-blind HTTP behavior report
- `artifacts/provenance.json`: local runtime and exact base/head commits
- `artifacts/base-worker.log` and `artifacts/head-worker.log`: real Wrangler startup/request traces

## Run

From the repository root on Node 24 or newer:

```bash
docs/proof/extract-dashboard-pages/run-proof.sh
```

The script prints `PROOF_RC=0` on success.

## Local observation

The committed local run compared merge base `5a964dadc8131e6e6dc33e9be3536b8141d1d107` with head
`22d7808c136a10503fc9929fd9ba5904e005542f` on macOS arm64, Node 24.19.0, pnpm 11.10.0,
and Wrangler 4.107.0. All three raw response hashes and byte counts matched before normalization;
the normalized diff was empty, the source-blind behavior contract passed, and the harness completed
with `PROOF_RC=0`.

## Limits

This proves page-shell rendering and route-level HTTP behavior. It does not exercise JSON API data,
browser interaction, GitHub writes, queue or state mutation, production deployment, or `/bay-demo`.
The `/bay-demo` renderer already lives in `dashboard/bay-page.ts` and is not part of the moved
surface.

## OpenClaw Bay impact

None. The rendered output is byte-identical, and this ownership-only move changes no Bay data
contract, lifecycle projection, observer-only boundary, or controls.
