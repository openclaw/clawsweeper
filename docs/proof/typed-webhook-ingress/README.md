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

A successful run writes `behavior-report.json` with the merge-base/head comparison. The final
evidence commit also records the required Docker-backed Crabbox `local-container` run against the
committed implementation head in `container-receipt.json`.

## OpenClaw Bay impact

None. The classifier's runtime objects, lifecycle calls, Bay journey inputs, queue decisions, and
observer contracts are unchanged. The patch adds TypeScript annotations and narrowing only; it
does not add a Bay action or alter its observer-only boundary.

## Limits

The fixtures and webhook secret are synthetic. The proof exercises real local Worker routing,
signature verification, payload parsing, classification, and local Durable Objects, but it does
not call the live GitHub API, deploy a Worker, or mutate production state.
