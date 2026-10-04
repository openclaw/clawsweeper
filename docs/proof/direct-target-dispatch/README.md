# Direct target-dispatch intake proof

- Status: historical proof for the change that added `/github/target-dispatch`
- Owner: ClawSweeper queue maintainers
- Source of truth: [target dispatch ingress](../../../dashboard/target-dispatch-ingress.ts),
  [OIDC verifier](../../../dashboard/github-actions-oidc.ts),
  [dispatcher workflow](../../../.github/workflows/clawsweeper-dispatch.yml), and
  [target dispatcher](../../target-dispatcher.md#direct-queue-intake)
- Baseline: `cac974b3e1da900cac3e7480b91d02a36ca60163` (`origin/main`)
- Candidate (clean, committed, with that main merged):
  `8451be295b` (rerun after the proof's recording proxy was limited to the four
  allowlisted dispatcher and relay routes; an intermediate rerun was
  `6b887421a45700da207b5a1a74786ce0635bdeb9`, and the first candidate run was
  `8c66d243208da8e99946e09535af8b9bbd4061ec`, receipt SHA-256
  `a9c7225a2b7802937e7576eea780a5b2692948ff646040dc8c752c230ce0e83d`)
- Update when: the dispatcher step, the relay job, the OIDC claim binding, or
  the queue's ingress dedupe changes

## Claim

A target dispatcher issue or PR event reaches the real exact-review queue
without any `repository_dispatch`, so no `Review event item` relay run is
created. A replay of the same dispatcher run dedupes. Any direct failure falls
back to the unchanged `repository_dispatch`, and the relay that dispatch starts
still enqueues the event.

## What runs

For each variant (baseline, then the committed candidate) the harness extracts
the source with `git archive` and runs, unmodified:

- the `Dispatch exact ClawSweeper review` step script from that variant's
  `.github/workflows/clawsweeper-dispatch.yml`, under bash with native `curl`,
  `jq`, and `gh`; the OIDC request variables are present only when the
  variant's dispatch job grants `id-token: write`, as on Actions;
- that variant's `dashboard/worker.ts` and `ExactReviewQueue` in workerd with
  SQLite (Miniflare), reached under the production hostname through
  `~/.curlrc` `connect-to` and a proof-only certificate;
- for every `repository_dispatch` the step sends, the variant's sweep.yml
  `Enqueue legacy event through the durable control plane` script, which is
  exactly what that relay run executes.

GitHub (for `gh`, over `http_unix_socket`), the GitHub App, the Worker's
GitHub egress, the hosted-target registry, and the Actions OIDC issuer with its
JWKS are local synthetic fixtures.

## Command

```bash
node docs/proof/direct-target-dispatch/run-proof.mjs origin/main <tools-dir> <fresh-output-dir>
```

`<tools-dir>` must resolve `miniflare` and `esbuild`. Optional overrides:
`PROOF_GH` (native gh, default `/opt/homebrew/bin/gh`), `PROOF_BASH` (bash 4.4
or newer for the relay's `mapfile -d`), and `PROOF_OPENSSL`.

Recorded run: macOS arm64, Node v24.21.0, Miniflare 4.20260701.0,
workerd 1.20260701.1, gh 2.101.0, curl 8.7.1, GNU bash 5.3.

## Result

| Scenario | Baseline dispatches / relay runs | Candidate direct answer | Candidate dispatches / relay runs |
| --- | --- | --- | --- |
| PR opened | 1 / 1 | 202 `queued` | 0 / 0 |
| Same dispatcher run replayed | 1 / 1 | 202 `deduped` | 0 / 0 |
| Issue opened | 1 / 1 | 202 `queued` | 0 / 0 |
| App webhook first, then dispatcher | 1 / 1 (relay: `cross_route` dedupe) | 202 `deduped`, `cross_route` | 0 / 0 |
| Forced enqueue failure (visibility probe 500) | 1 / 1 | 503 `target_visibility_unverified` | 1 / 1, relay `queued` |
| Worker unreachable | 1 / 1 | connection refused | 1 / 1, relay `queued` |
| PR to non-default base branch | 1 / 1 | 403 `target_dispatch_identity_mismatch` | 1 / 1, relay `queued` |
| Total | 7 / 7 | | 3 / 3 |

Both variants end with the same six queue items. The baseline's relay after the
App webhook only produced a `cross_route` dedupe, which is the redundancy the
direct route removes.

- Receipt: [`result.json`](result.json), SHA-256
  `2a05fe0f15cc98a6672784629457335b549e4aec59fc833b8b73c8146eff62b3`
- Harness at the candidate head: SHA-256
  `c61abb95c5ed1379fc9bc65f049f0e5828274f7ce69b1ca5b62db9a7c2bf0cf3`
- Per-file source SHA-256s for both variants are inside the receipt;
  `sweep.yml` and `exact-review-queue.ts` are identical in both.
- The same harness passed with identical outcomes at two earlier
  base/candidate pairs as main advanced:
  `65f9c3a3057621385b6c4f52640a2ce190c18c57` /
  `393e5cad76ecd743baffccd09d0c8bc77b05e2bd` (receipt SHA-256
  `cd832763f558fad3bf2b51f5515b07d84644c43d8b5cfa4b87cffac20b9be79a`) and
  `1c3eea1da162cf6cc9d2b607ac2ca3212755fa66` /
  `c4ed347928f43bd1d93f9173829f41903548edbd` (receipt SHA-256
  `990c063e9c659238c62c76f9cd4673ca8abfef59d749e5b9a2a830f2c1825d8d`).

An earlier run against the intermediate commit
`2ce92f7ad80244cd80e34d8e99c41235fa353c96` answered every direct request with
401 and fetched JWKS zero times: workerd rejects `fetch(..., { redirect: "error" })`
with a TypeError, and the verifier failed closed. That run is why the shared
verifier now uses `redirect: "manual"`.

## Limits

The GitHub API, App credential, and Actions OIDC issuer are synthetic, so real
GitHub OIDC signing and claim shapes are not exercised. The step scripts run
under local bash, not a GitHub Actions runner. Queue alarms (executor
dispatch) are disabled, and the PR acknowledgement step is not exercised.
Production relay volume drops only after each target repository adopts the
updated dispatcher; `openclaw/openclaw`'s own dispatcher is outside this
repository.
