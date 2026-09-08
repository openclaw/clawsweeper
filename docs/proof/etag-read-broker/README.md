# Durable ETag read broker proof

This receipt proves the rank-4 quota-savings contract over loopback HTTP with
the production broker algorithm, Worker HMAC routes, and queue Durable Object
store. The GitHub fixture implements normal ETag semantics: matching
`If-None-Match` returns 304 with no body, while a changed representation returns
200 and a replacement ETag/body.

The assertions cover first-read population, byte-identical 304 replay with a
digest check, changed-resource replacement, independent page keys, unchanged
wire-call count, and a final-guard-style read that always revalidates. The
operator secret is rejected from the publisher-scoped data plane.

The current runner also exercises the 128 KiB store limit: a 100 KiB response
is stored over loopback HTTP, a 200 KiB response is returned intact without
transmitting the response body (one size-only store request records the skip),
and a direct 200 KiB store request returns `body_size_bound`. Historical receipts below describe their recorded revision;
new runs report the current body limit from the shared contract.

Run locally after `pnpm run build:all`:

```bash
node docs/proof/etag-read-broker/run-proof.mjs \
  --output docs/proof/etag-read-broker/behavior-report.json
```

The Docker-backed Crabbox command is recorded in `receipt.json`; its script
runs the focused behavior tests, the loopback proof, dashboard strict, and the
full repository gate on Node 24, then validates the report with static `jq`.
`container-transcript-summary.txt` retains the exact phase and result markers;
the oversized raw coverage transcript is intentionally excluded from Git.

OpenClaw Bay is unaffected. This changes internal GitHub read transport and
telemetry dimensions only; the public observer payload and its read-only/no-
action boundary do not change.

Limits: GitHub and credentials are local deterministic fixtures; the proof does
not contact production GitHub or mutate production Worker state. A 304's
zero-point accounting is GitHub's documented REST behavior and is represented
by the fixture's separate `quota_charges` count.
