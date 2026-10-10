# Active-item debounce proof

An item that already completed two exact reviews in the last hour must not
start a full review for every organic push. Its next organic revision waits ten
minutes from the latest push (capped at fifteen minutes from the first pending
enqueue) and dispatches once with the latest head. Explicit commands, first-time
items and a queue store written before the change keep their existing timing.

[`proof-active-item-debounce.mjs`](../../../scripts/proof-active-item-debounce.mjs)
bundles the baseline and candidate queue into real workerd SQLite Durable
Objects and follows each object's own alarm schedule on a controlled clock. A
dispatched review claims its lease at once and completes seven minutes later
unless a newer push revoked it. Scenarios:

- `churn`: pull request pushes at 0 and 10 minutes (two completed reviews),
  then three pushes at 20, 24 and 28 minutes.
- `command`: two completed issue reviews, then an explicit command at 20 minutes.
- `fresh`: a first-time pull request push at 20 minutes.
- `upgrade`: the baseline writes a completed review and a pending revision to a
  persisted store; the candidate opens that store and receives the next edit.

```sh
npm install --prefix /tmp/clawsweeper-active-item-proof-tools --no-save --no-audit --no-fund --ignore-scripts wrangler@4.107.0
node scripts/proof-active-item-debounce.mjs c46e375c825223a7b3fbcf592794dc949065f0f8 /tmp/clawsweeper-active-item-proof-tools .artifacts/active-item-debounce
```

Observed with workerd 1.20260701.1, Miniflare 4.20260701.0 and Node 24.21.0. The baseline is `c46e375c82` (main with the generation-start budget charging from https://github.com/openclaw/clawsweeper/pull/1738), and the candidate is the integrated head `e78f8bf0ec`. The earlier run against `8d659e7cb9` produced the same table:

| Measure                               | Baseline           | Candidate             |
| ------------------------------------- | ------------------ | --------------------- |
| Churn dispatches after 20 minutes     | 3 (21.5/25.5/29.5) | 1 (35.0, latest head) |
| Reviews revoked by a newer push       | 2                  | 0                     |
| Queue wakes between 20 and 35 minutes | 3                  | 2                     |
| Explicit command dispatch delay       | 1 s                | 1 s                   |
| First-time item dispatch delay        | 90 s               | 90 s                  |
| Upgraded store: next edit wait        | n/a                | 90 s (no history)     |

The receipt (`result.json`) records Git revisions, source hashes, runtime
versions, every enqueue, wake, dispatch and completion. GitHub is a loopback
HTTP fixture with a synthetic RSA credential; workerd egress is restricted to
it. This exercises the real queue admission, alarm, dispatch, claim, completion
and SQLite storage, but not the review workflow, inference, production state or
GitHub mutations. Unit tests cover the recovery bypass, window expiry and the
in-flight revocation heartbeat.

OpenClaw Bay is not affected: no public field, backoff reason or control is
added; held items keep the existing `dispatch_debounce` reason.
