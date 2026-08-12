# Reconcile throttle-resilience behavior contract

## Claim

Exact-review dead-letter reconciliation uses the target GitHub App pool for public target REST and GraphQL reads. One isolated GitHub-confirmed rate-limit or abuse 403, or any 429, skips only the affected target or GraphQL batch, so later targets can still be inspected and recovered. Three consecutive confirmed throttles stop further inspection in that phase, preserving a bounded per-cycle request budget. Authorization and policy 403s retain the conservative abort behavior.

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

## Command and environment

Run `run-proof.sh` inside Docker-backed Crabbox `provider=local-container` with image `node:24-bookworm`. The script installs Corepack into `$HOME/.local/bin`, activates the repository-pinned pnpm, installs the frozen lockfile, and runs the focused Node test scenarios.

## Limits

GitHub throttling and queue responses are deterministic loopback fixtures. No production credential is present, no live GitHub quota is consumed, and no production queue mutation is performed. This proves credential selection and bounded runtime behavior at the CLI/HTTP boundary, not live GitHub App issuance.

OpenClaw Bay is unaffected: this is an operator workflow and credential-routing change with no observer data contract or action surface.
