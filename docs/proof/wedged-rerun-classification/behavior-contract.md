# Wedged rerun classification behavior contract

## User-visible goal

Unremediable GitHub Actions reruns stuck before queue admission must remain visible as aggregate diagnostics without degrading live execution health. The stuck-run remediation command must report GitHub's exact pre-queue cancellation conflict as a structured, successful skip.

## Target

- Type: public status API, dashboard rendering, and operator CLI artifact.
- Access: the dashboard Worker's `/api/status` response and `scripts/stuck-queued-run-remediation.mjs --execute` against loopback GitHub API fixtures.
- Allowed fixtures: synthetic workflow runs and loopback HTTP responses; no credentials or production mutation.

## User tasks and expected observable behavior

1. Read status with one 90-minute `pending` attempt-2 run. Status is `healthy`, `queued_over_threshold` is zero, `wedged_rerun_runs` is one, and `oldest_wedged_rerun_minutes` is 90.
2. Read status with a two-minute `pending` attempt-2 run. It remains ordinary live queue telemetry and is not wedged.
3. Read status with a genuinely queued over-threshold run. Status remains `degraded`.
4. Run remediation with an aged pending attempt-2 rerun. Discovery includes the pending inventory, the fresh pending read produces `skip_reasons.wedged_rerun: 1` plus a run-ID sample, no cancellation POST is sent, and the command exits zero.
5. Run remediation when a queued-looking run's cancellation returns HTTP 409 with `Cannot cancel a workflow re-run that has not yet queued`. The command also exits zero with the same structured skip taxonomy.
6. Project public status. Aggregate wedged count and age remain, while synthetic run IDs and diagnostic URLs are absent.

## Anti-cheat probes

- Exactly 60 minutes is not wedged because the threshold is strictly exceeded.
- Attempt 1 and non-`pending` statuses are never classified as wedged.
- Exactly 90 minutes is not selected by the remediation CLI because its existing stuck-run threshold is also strict.
- The force-cancel path recognizes the same exact 409 signature after an initial HTTP 500 and does not record a permanent zombie.
- A non-signature cancellation failure remains a normal remediation failure.

## Evidence required

- Red/green TAP excerpts for the focused scenarios.
- Docker-backed Crabbox provider, lease, image, tested source head, merge base, full-gate result, and transcript digest.
- Static JSON assertions and `git cat-file` checks for the recorded commits.

## Out of scope

- Live cancellation of production run 31910632853.
- Changes to OpenClaw Bay, which does not consume `operational_health`.
- Altering the existing 24-hour queued-zombie policy.
