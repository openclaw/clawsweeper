# Reconcile throttle-resilience behavior contract

## Claim

Exact-review dead-letter reconciliation in `github-app` target-token mode requires a complete App ID/private-key pair at process startup. Key-only, ID-only, and entirely absent App credentials fail before any queue or GitHub request and name the missing field; complete credentials proceed. The repository Actions token can never become an implicit fallback and remains available only through the explicit `actions` mode.

With complete App credentials, reconciliation mints target-read credentials from each target owner's GitHub App installation, caches both successful tokens and rejected setup promises per owner for the cycle, and uses successful tokens for public target REST and owner-homogeneous GraphQL reads. A missing or revoked installation becomes an `installation_missing` skip for that target while other owners continue. One isolated GitHub-confirmed rate-limit or abuse 403, or any 429, during installation lookup, token minting, or a target read skips only the affected target, owner, or GraphQL batch, so later owners and targets can still be inspected and recovered. A cached setup rejection contributes only one actual call to the shared three-consecutive-throttle fuse. Three distinct consecutive confirmed throttles stop further inspection in that phase, preserving a bounded per-cycle request budget. App-setup skips are structured as `github_throttled scope=app_setup`; genuine 401 and non-throttle 403 setup failures retain the conservative abort behavior.

## Exercised surface

- `scripts/exact-review-dead-letter-operator.mjs` through its real CLI process boundary.
- A real loopback HTTP server selected through `GITHUB_API_URL` for queue, REST, and GraphQL traffic.
- The scheduled and manual dead-letter workflow token bindings parsed from their checked-in YAML.

## Scenarios and observable results

1. An initial serial target check returns a GitHub rate-limit 403; the next two targets return valid identities and are recovered. The summary reports one `github_throttled`, one skipped target, and two recovered targets.
2. The first GraphQL identity batch returns a GitHub rate-limit 403; the later batch is inspected and ten targets are recovered. The summary reports 40 `github_throttled` skips and the request count remains two GraphQL calls plus ten bounded REST revalidations.
3. Three consecutive 403s during canonical discovery stop the phase after three REST calls. The remaining two targets report `not_inspected_abort`.
4. One recovery revalidation returns 403; later candidates are revalidated and recovered. Three consecutive revalidation 403s stop after three calls and account for untouched candidates honestly.
5. Ordinary authorization 403s in serial REST discovery, GraphQL discovery, and recovery revalidation abort the remaining phase and recover nothing.
6. Every target REST and GraphQL request carries the synthetic target-App token while the workflow YAML retains `${{ github.token }}` for repository Actions work.
7. Two targets under different owners exercise real App JWT signing and loopback installation/token endpoints. The installed owner recovers with its minted token; the absent owner reports one `installation_missing` skip and sample; the cycle completes.
8. Three targets under one valid installation mint one owner token. An ordinary authorization 403 on the first target remains fail-closed and aborts the untouched targets.
9. Token minting for owner A returns 429 or a confirmed rate-limit 403. Three owner-A targets report structured `github_throttled scope=app_setup stage=token_mint` skips, the rejected mint is requested once, owner B mints successfully, and the cycle recovers owner B.
10. Installation lookup for owner A returns a confirmed rate-limit 403. Owner A skips with `stage=installation_lookup`, owner B recovers, and the cycle completes.
11. One throttled owner spans three owner-homogeneous GraphQL batches. The cached rejection skips all 81 owner targets but counts once toward the fuse; the later healthy owner is inspected and recovered.
12. Three distinct owners return setup throttles. The shared fuse stops before a fourth owner's lookup or mint, bounding setup traffic to three calls.
13. Installation lookup and token minting each return genuine 401 and non-throttle 403 responses. Every variant keeps the fail-closed abort, while a 404 race between lookup and mint retains the prior bounded `installation_missing` behavior.
14. The real operator process runs the App-credential startup matrix: private-key only fails naming the App ID, App ID only fails naming the private key, neither fails naming both, and both proceed. The same credential-less fixture succeeds only after explicitly selecting `actions` mode. The scheduled and manual workflow YAML both select `github-app` and pass the private-key secret while retaining `${{ github.token }}` solely for repository-owned work.

## Command and environment

Run `run-proof.sh` inside Docker-backed Crabbox `provider=local-container` with image `node:24-bookworm`. The script installs Corepack into `$HOME/.local/bin`, activates the repository-pinned pnpm, installs the frozen lockfile, and runs the focused Node test scenarios.

## Limits

GitHub installation, token, throttling, and queue responses are deterministic loopback fixtures. The test signs a synthetic App JWT with an ephemeral RSA key, but no production credential is present, no live GitHub quota is consumed, and no production queue mutation is performed. This proves credential selection and bounded runtime behavior at the CLI/HTTP boundary, not live GitHub App issuance.

OpenClaw Bay is unaffected: this is an operator workflow and credential-routing change with no observer data contract or action surface.
