# PR 1089 real-boundary publication retry proof

## Claim

A batch publication that reaches a real transport failure with no HTTP status,
HTTP 429, or HTTP 5xx is completed by the built `exact-review-batch-cli` as
`retryable_failure` / `state_contention`. The real `ExactReviewQueue` Durable
Object accepts that tuple, returns the publication item to `pending`, increments
its attempt count, schedules `next_attempt_at`, and does not create an open dead
letter.

The production policy contrast is 48 attempts / 24 hours for
`state_contention` versus 14 attempts / one hour for `unknown_failure`. This
bounded proof exercises the first real retry for both classifications. It does
not claim to have waited through the full old retry budget; see Limits.

## Exercised surface

- Built `dist/repair/exact-review-batch-cli.js` `commit` and `complete` commands
- Real localhost TLS sockets returning a connection reset, HTTP 429, and HTTP 503
- Signed Worker routes for enqueue, batch claim, and batch completion
- Real local Wrangler Worker and `ExactReviewQueue` Durable Object
- Public queue item-status and aggregate status routes

## Controlled scenario

The script builds the repair CLI and dashboard, generates a disposable
self-signed localhost certificate, and starts a bounded HTTPS listener on
`127.0.0.1`. For each transport case the actual CLI fetches a batch, posts the
canonical publication payload over a real socket, retries the reset/429/503,
and posts its completion envelope back over the socket. The listener verifies
the HMAC and captures the raw tuple; it does not replace or monkeypatch `fetch`,
timers, or CLI modules.

Separately, the script starts the real Worker and Durable Object with pinned
Wrangler 4.107.0 and disposable local persistence. It uses a synthetic local
HMAC secret to enqueue and claim a publication item, posts the CLI-captured 429
completion tuple, and reads queue status before and after. A second fresh item
repeats the same Worker/DO sequence with only the reason changed to
`unknown_failure` for an attempt-one control.

## Required observations

- Reset, 429, and 503 each produce a raw CLI completion with
  `terminal_outcome: "retryable_failure"` and
  `reason_code: "state_contention"`.
- Every CLI request crosses a real loopback socket and carries a valid HMAC.
- After the real Worker/DO accepts the `state_contention` completion, item
  status reports `state: "pending"`, `attempts: 1`, a future
  `next_attempt_at`, and no open dead letter.
- The attempt-one `unknown_failure` control is also retained for retry, as the
  old policy requires before its 14-attempt / one-hour limit.
- No request points at production, GitHub, or any non-loopback application
  endpoint. No real secret is used or retained.

## Command and environment

Run from the repository root on Node 24 or newer:

```bash
docs/proof/csw-1089/run-proof.sh
```

The script uses `npx --yes wrangler@4.107.0 dev --local --persist-to ...` on
`127.0.0.1` with the repository's normal local queue configuration. No
publication retry limit, age, delay, or clock is changed.

## Artifacts

Generated artifacts live in `docs/proof/csw-1089/artifacts/`. They include the
runtime transcript, three raw CLI completion envelopes and receipts, signed
transport request trace, Worker enqueue/claim/complete responses, queue item
status before and after both completions, final aggregate queue status, proof
summary, build logs, and a bounded redacted Wrangler log.

## Limits

Driving one item through 14 authentic claims is intentionally not automated:
the real retry delays are 1, 2, 4, then capped 5+ minute backoffs, requiring
roughly 51 minutes before attempt 14. There is no supported endpoint for
advancing the Durable Object clock or `next_attempt_at`. This proof therefore
does not show the `unknown_failure` item entering the dead-letter store at
attempt 14, nor the `state_contention` item remaining pending at that same
attempt count. It records the real attempt-one classification and queue result
for both and leaves the terminal contrast to the unchanged retry-policy code
and existing focused tests. It does not fake time, edit Durable Object storage,
stub the Worker/DO, or change a retry constant.

## Crabbox provenance

The proof in this directory was re-run unchanged against the reviewed head inside a
Docker-backed Crabbox `local-container` lease, from a clean remote checkout of the PR
(`--fresh-pr openclaw/clawsweeper#1089 --no-hydrate`) rather than from a local working tree.

| Field | Value |
| --- | --- |
| Provider | `local-container` (Crabbox CLI 0.39.0) |
| Container engine | Docker 29.4.0 (OrbStack) |
| Image | `node:24-bookworm` |
| Lease | `cbx_9797931e8d4d` (`coral-prawn`), stopped after the run |
| Reviewed head | `d54d60abf5de708713e0fbedce496cd5a21dd251` |
| Runtime | Node v24.19.0, pnpm 11.10.0 |
| Result | `exit 0`, 21 assertions, `run_status: succeeded` |
| Timings | sync 10.2 s, command 55.6 s, total 65.8 s |

Machine-readable provenance, including the captured queue observations, is in
[`artifacts/crabbox-local-container-provenance.json`](artifacts/crabbox-local-container-provenance.json).
The raw container transcript is in
[`artifacts/crabbox-local-container-stdout.log`](artifacts/crabbox-local-container-stdout.log).

The run needs no elevated privileges. Corepack is enabled into the container user's own
`~/.local/bin`, because the lease user is unprivileged and cannot write to `/usr/local/bin`.

### What this provenance does and does not add

It establishes that the proof reproduces on the exact reviewed head, in a clean containerized
environment, with no dependency on this workstation's state. It does not change what the proof
itself demonstrates; the limits recorded above and in the provenance JSON still apply, in
particular that both queue observations are at attempt 1 and the retry-budget divergence itself is
covered by unit tests and by the production dead-letter statistics quoted in the PR body rather
than by this run.
