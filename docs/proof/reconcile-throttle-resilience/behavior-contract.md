# Reconcile throttle-resilience behavior contract

## Claim

Exact-review dead-letter reconciliation mints target-read credentials from each target owner's GitHub App installation, caches them per owner for the cycle, and uses them for public target REST and owner-homogeneous GraphQL reads. A missing or revoked installation becomes an `installation_missing` skip for that target while other owners continue. One isolated GitHub-confirmed rate-limit or abuse 403, or any 429, skips only the affected target or GraphQL batch, so later targets can still be inspected and recovered. Three consecutive confirmed throttles stop further inspection in that phase, preserving a bounded per-cycle request budget. Authorization and policy 403s after a valid installation token is minted retain the conservative abort behavior.

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

## Command and environment

Run `run-proof.sh` inside Docker-backed Crabbox `provider=local-container` with image `node:24-bookworm`. The script installs Corepack into `$HOME/.local/bin`, activates the repository-pinned pnpm, installs the frozen lockfile, and runs the focused Node test scenarios.

## Limits

GitHub installation, token, throttling, and queue responses are deterministic loopback fixtures. The test signs a synthetic App JWT with an ephemeral RSA key, but no production credential is present, no live GitHub quota is consumed, and no production queue mutation is performed. This proves credential selection and bounded runtime behavior at the CLI/HTTP boundary, not live GitHub App issuance.

OpenClaw Bay is unaffected: this is an operator workflow and credential-routing change with no observer data contract or action surface.
