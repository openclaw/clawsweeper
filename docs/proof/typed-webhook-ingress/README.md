# Typed webhook ingress proof

## Claim

Phase 1 types the GitHub webhook classifier as an event-to-payload discriminated input and a
rejected/comment/issue/pull-request result union without changing hosted webhook behavior.

## Exercised surface

`run-proof.mjs` extracts the merge-base into a disposable directory and starts two real
`wrangler dev --local` Workers over loopback HTTP: one from merge-base and one from the current
head. It sends the same HMAC-signed `issue_comment`, `issues`, `pull_request`, and unsupported-event
deliveries to both production `/github/webhook` routes and requires every HTTP status and JSON body
to compare deeply equal.

The `issue_comment` fixture reaches the accepted comment path and stops at absent synthetic GitHub
App configuration. The issue fixture exercises local queue admission. The pull-request fixture
exercises local receipt/source-authority handling and the deferred live-head path. The unsupported
fixture exercises the terminal rejected result.

## Run

From the repository root on Node 24 or newer:

```bash
docs/proof/typed-webhook-ingress/run-proof.sh
```

A successful re-run writes the merge-base/head comparison to
`.artifacts/typed-webhook-ingress/behavior-report.json`. The committed `behavior-report.json`
remains the frozen review-time copy. The final evidence commit also records the required
Docker-backed Crabbox `local-container` run against the committed implementation head in
`container-receipt.json`.

## Result

The frozen committed comparison covers merge-base `408c28329c188c15e2d3dbefe98a2393cbca4989`
and implementation head `896513f31ce3279a69f34dff9425809d55f9d782`; all four status/body
pairs are identical. The current-head container receipt separately covers source and launcher head
`a7e4e37adb18c939bd3b57e9d9f6ffc4610a9bd6` without replacing that review-time report.

Docker-backed Crabbox `provider=local-container` used `--fresh-pr openclaw/clawsweeper#1132` in
`node:24-bookworm` on lease `cbx_dda9e37f1731` (`crimson-hermit-cceb`), run
`run_686d05277f14`. Two consecutive dashboard builds and Worker comparisons passed with all four
outcomes identical in each run. The generated report stayed under `.artifacts/`, and
`git status --porcelain` was empty before, between, and after the runs. Crabbox exited 0 and stopped
the lease automatically; full provenance is in `container-receipt.json`.

## OpenClaw Bay impact

None. The classifier's runtime objects, lifecycle calls, Bay journey inputs, queue decisions, and
observer contracts are unchanged. The patch adds TypeScript annotations and narrowing only; it
does not add a Bay action or alter its observer-only boundary.

## Limits

The fixtures and webhook secret are synthetic. The proof exercises real local Worker routing,
signature verification, payload parsing, classification, and local Durable Objects, but it does
not call the live GitHub API, deploy a Worker, or mutate production state.
