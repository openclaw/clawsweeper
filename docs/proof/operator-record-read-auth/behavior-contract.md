# Operator canonical-record read authentication contract

## Claim

The canonical-record GET route accepts the exact-review operator secret only for `items`, the sole collection read by reconciliation. The webhook secret retains access to `items`, `closed`, `plans`, and `decision-packets`; invalid signatures remain unauthorized; and missing required configuration remains unavailable.

## Exercised surface

The proof starts the production dashboard Worker with `wrangler dev --local`, publishes synthetic canonical records through the signed tuple route, and reads all four collections through `GET /internal/state/records/openclaw-openclaw/<collection>/1148`. It boots the merge-base Worker and candidate Worker sequentially on the same loopback port with different webhook and operator secret values. Between boots it terminates the complete Wrangler process tree and requires `/api/health` to stop responding.

## Expected behavior

| Revision  | Signature | Items | Closed | Plans | Decision packets |
| --------- | --------- | ----: | -----: | ----: | ---------------: |
| Candidate | Operator  |   200 |    401 |   401 |              401 |
| Candidate | Webhook   |   200 |    200 |   200 |              200 |
| Candidate | Garbage   |   401 |    401 |   401 |              401 |

The merge base remains webhook-only for all four collections. The router-level unit fixture repeats the candidate matrix with two distinct configured values. It also requires `503 webhook_not_configured` when neither value exists and for an operator-only request to a webhook-only collection.

## Non-goals and limits

The proof uses synthetic local credentials and state. It exercises the real Worker router, HMAC verification, and Durable Object record store over HTTP, but does not deploy, read production records, or mutate GitHub. The operational-cursor route is unchanged because its current client signs with the webhook secret and no operator-secret cursor consumer exists.

OpenClaw Bay is unaffected. This is an internal authentication correction for an existing read-only queue route; it changes no observer data contract or action surface.
