# Operational-health zombie workflow-run proof

## Claim

The real dashboard Worker excludes queued workflow runs older than 24 hours from queue-pressure health while retaining them in `queued_runs` and surfacing them through `zombie_queued_runs` and `oldest_zombie_queued_minutes`. A non-zombie run queued for 31 minutes still degrades operational health exactly as before.

The GitHub base-URL binding is dependency injection for testability. Production behavior is unchanged by default: when `GITHUB_API_URL` is unset, every dashboard GitHub REST and GraphQL request still uses `https://api.github.com`.

## Exercised surface

- Real `wrangler dev --local` dashboard Worker and `/api/status` route
- Real HTTP requests from the Worker to a loopback GitHub REST stub
- The production operational-health and dashboard-health summaries
- The default-origin path with `GITHUB_API_URL` unset and no GitHub credentials

## Controlled scenarios and required observations

The proof boots three fresh Workers. Each boot gets a disposable Wrangler persistence directory, and the entire Worker process group is stopped before the next boot.

1. The GitHub stub returns one queued run aged 25 hours. `/api/status` must report `queued_runs: 1`, `zombie_queued_runs: 1`, `queued_over_threshold: 0`, operational status `healthy`, and no `workflow_execution_degraded` dashboard reason.
2. The stub adds a second run aged 31 minutes. `/api/status` must report one zombie plus one over-threshold live queued run, operational status `degraded`, and the `workflow_execution_degraded` dashboard reason.
3. `GITHUB_API_URL` is unset and no GitHub credential is provided. The resulting status payload and its public GitHub response or local-sandbox error shape are retained to demonstrate that the default-origin path remains active without sending credentials.

## Command and environment

Run from the repository root on Node 24 or newer:

```bash
docs/proof/operational-health-zombie-runs/run-proof.sh
```

The proof uses pinned Wrangler 4.107.0, loopback HTTP only for the injected stub, and a synthetic webhook secret. Generated payloads, request traces, logs, and `proof-summary.json` are written to `.artifacts/operational-health-zombie-runs/` by default.

## Limits

The stub implements the GitHub REST response shapes consumed by `/api/status`; it does not emulate GitHub authentication, GraphQL, rate limiting, cancellation, or the production scheduler. Unit tests cover the strict 24-hour boundary and URL validation. The live production population and the failed cancel/force-cancel attempts are prior coordinator measurements, not repeated by this proof.

## OpenClaw Bay impact

No Bay contract or implementation changes. Bay remains an observer-only projection of workflow and review journeys. This change affects only the dashboard status payload and its derived health reason; it adds no queue, workflow, GitHub, recovery, deploy, or rollback action.
