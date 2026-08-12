# Operator canonical-record read authentication contract

## Claim

The canonical-record GET route accepts an HMAC made with either the webhook secret or the exact-review operator secret. The secrets remain distinct, invalid signatures remain unauthorized, and absent configuration remains unavailable only when neither secret exists.

## Exercised surface

The proof starts the production dashboard Worker with `wrangler dev --local`, publishes a synthetic canonical record through the signed tuple route, and reads that record through `GET /internal/state/records/openclaw-openclaw/items/1148`. It boots the merge-base Worker and candidate Worker sequentially on the same loopback port with different webhook and operator secret values. Between boots it terminates the complete Wrangler process tree and requires `/api/health` to stop responding.

## Expected behavior

| Revision   | Webhook signature | Operator signature | Garbage signature |
| ---------- | ----------------: | -----------------: | ----------------: |
| Merge base |               200 |                401 |               401 |
| Candidate  |               200 |                200 |               401 |

The router-level unit fixture repeats the candidate matrix with two distinct configured values and also requires `503 webhook_not_configured` when neither value exists.

## Non-goals and limits

The proof uses synthetic local credentials and state. It exercises the real Worker router, HMAC verification, and Durable Object record store over HTTP, but does not deploy, read production records, or mutate GitHub. The operational-cursor route is unchanged because its current client signs with the webhook secret and no operator-secret cursor consumer exists.

OpenClaw Bay is unaffected. This is an internal authentication correction for an existing read-only queue route; it changes no observer data contract or action surface.
