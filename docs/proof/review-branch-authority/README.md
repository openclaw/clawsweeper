# Durable branch-authority proof

## Claim

A signed branchless legacy review reaches the real dashboard Worker and its
SQLite-backed `ExactReviewQueue` Durable Object. The first target-owner GitHub
quota response opens the existing reset-aware circuit. Later reservations for
that owner stay durable without another GitHub request, another owner continues,
and the deferred reservations recover after the reset, including across a local
Worker restart.

## Exercised surface

- Real `wrangler dev --local` Worker HTTP routing and webhook-signature check
- Real `ExactReviewQueue` Durable Object storage, alarms, and restart persistence
- The production GitHub App JWT, installation-token, and repository-read client
- The loopback-only `GITHUB_API_URL` seam and real HTTP request/response transport
- Public `/api/exact-review-queue` authority, circuit, request-metric, and Bay data

## Controlled scenario and required observations

The loopback GitHub endpoint accepts synthetic App JWTs and installation-token
requests. Its first `openclaw/openclaw` repository read returns a reset-aware 403. It returns authoritative branches after reset and remains healthy for
`other/repo`.

1. Send a signed branchless `openclaw/openclaw` event and observe exactly one
   token request and one throttled repository read.
2. Send another branchless event plus a source-head reservation for the same
   owner and a branchless `other/repo` event. Before reset, the two new
   `openclaw` reservations make no GitHub request or spend an attempt;
   `other/repo` is admitted as `stable`.
3. Verify three authority reservations and three affected pending records under
   `target_app:openclaw`, stop the Worker, and restart it with the same local
   persistence directory.
4. After reset, verify all `openclaw` reservations are admitted as `trunk`, the
   pull-request head is verified, the authority backlog reaches zero, and the
   circuit is recovered.

## Command and artifacts

Run from the repository root on Node 24 or newer:

```bash
docs/proof/review-branch-authority/run-proof.sh
```

The proof uses pinned Wrangler 4.107.0, a synthetic webhook secret and App key,
and loopback HTTP only. It writes redacted requests, before/after queue
snapshots, resolved durable queue records, Worker logs, and `proof-summary.json` under
`.artifacts/review-branch-authority/` by default. No token or private key is
written to an artifact.

## Limits

The Worker and Durable Object boundaries are real local runtime instances. The
GitHub endpoint is a controlled HTTP fault server, not GitHub production. The
proof performs no production GitHub write, workflow dispatch, queue mutation,
deployment, gate change, or other production action. It mutates only the
disposable local queue created for the proof.

## OpenClaw Bay impact

Bay remains observer-only. Its existing credential-circuit health card reads
the same `affected_pending` value proven here; no Bay controls, polling, lane,
or durable-lifecycle semantics change.
