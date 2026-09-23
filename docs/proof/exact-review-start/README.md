# Exact-review launch authority proof

- Status: historical proof for the synchronous launch check
- Owner: ClawSweeper review-workflow maintainers
- Source: `.github/workflows/sweep.yml`, `scripts/control-plane-curl.sh`
- Baseline: `6500b62dfd4c4efb0e2b821c1e9c427e128febef`
- Candidate: workflow SHA-256 in [after.json](after.json)
- Update when: the generation entry point, heartbeat tuple, rejection handling, or process cleanup changes

## Claim and scenario

An exact review whose queue lease was revoked during prior setup must not start
generation. The same full tuple is checked synchronously before both ordinary
and oversized generation. Known ownership rejection is a successful no-op;
transport/service uncertainty is a failed attempt, never a false supersession.
The positive current-owner path and existing post-start termination remain intact.

## Command and environment

```sh
pnpm run build:all
node scripts/e2e/exact-review-start-authority.mjs 6500b62dfd4c4efb0e2b821c1e9c427e128febef
node scripts/e2e/exact-review-start-authority.mjs
```

Provider: local native Linux shell and loopback HTTP; Node 26.8.2, Bash, curl,
jq, `setsid`, and GNU `timeout`. No infrastructure was provisioned. The script
executes the extracted generation step and the actual retry helper, passing a
synthetic full item/lease/revision/generation/run/attempt/head tuple. Harmless
shell processes replace the expensive review command, and a local JSON fixture
replaces the oversized GitHub read. No production credentials are inherited.
Raw per-scenario shell logs and results stay under `.artifacts/exact-review-start/`.

## Observed result

[Before](before.json): both already-stale paths started the process fixture
before discovering revocation. [After](after.json): neither starts. The remaining
controls establish inactive-owner rejection, unknown-conflict failure, exhausted
503 and broken-transport failure, recovery from 503 to current ownership, malformed
tuple refusal, current-owner progress on both generation paths, revocation during
the oversized GitHub refresh before launch, and revocation
after a real process tree starts. The running fixture and descendant are reaped.
Superseded output continues to exclude the existing artifact-publication gate.

## Limits and cost

This is a real workflow-shell, HTTP, and process-boundary proof with synthetic
coordinator responses and review work. It does not run a model, hosted Actions,
the production Worker, or GitHub publication. Queue event ordering and the
publication implementation are unchanged and are not reproved here.

The patch adds one full-tuple request per generation entry (at most four HTTP
attempts under the existing retry helper). A successful request causes one
additional queue heartbeat write; it does not multiply steady-state writes
by shortening the one-minute interval. Existing finalization checks, publication
authority, and process-group cleanup are retained.

Earlier checkout/setup can still continue after supersession. Ownership can also
change between the preflight and process creation. Ordinary generation keeps its
immediate background heartbeat and subsequent one-minute polls. Oversized
generation remains synchronous: revocation after launch is caught at finalization,
not by an active stop loop. This is not immediate cancellation or a hard
wall-clock stop guarantee.

OpenClaw Bay is unaffected: the existing superseded/failure outputs are reused;
there is no observer schema, field, route, or control change.
