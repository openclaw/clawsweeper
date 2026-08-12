# Behavior Contract

## User-Visible Goal

Opportunistic stuck-run remediation must yield to GitHub throttling without preventing the scheduled dead-letter reconcile cycle, while authentication failures, persistent server failures, and malformed responses remain hard failures.

## Target

- Type: operator CLI and GitHub Actions workflow artifact
- Launch or access: `node scripts/stuck-queued-run-remediation.mjs` through the focused loopback test and parsed `.github/workflows/exact-review-dead-letter-reconcile.yml`
- Allowed fixtures and credential source: loopback HTTP listeners through `GITHUB_API_URL`; synthetic placeholder token only

## User Tasks

1. Run discovery when GitHub returns a rate-limit 403.
2. Run discovery when GitHub returns a persistent 503 or a non-throttle 403.
3. Run execute mode when one cancellation succeeds and the next request is throttled.
4. Inspect the workflow ordering and artifact-upload policy.

## Expected Observable Behavior

- A discovery throttle exits 0 and emits one JSON line with `skip_reasons.github_throttled`, phase, and request path.
- Persistent 5xx retries three times and exits 1; a non-throttle 403 exits 1 without retry.
- A throttle after a successful cancellation retains that action, stops further remediation, emits the skip reason, and exits 0.
- The workflow lets both dead-letter reconcile stages run after a remediation failure, then fails honestly; absent inventory files do not create a second upload failure.

## Anti-Cheat Probes

- Vary the throttle signal between a 403 rate-limit body and HTTP 429 secondary-rate-limit response.
- Replace the throttle body with an authorization error and verify it does not skip.
- Replace the throttle response with persistent 503 and verify the bounded retry plus hard failure.
- Exercise throttling after a prior mutation rather than only on the first request.

## Evidence Required

- Red/green Node test transcript showing exit status and named scenarios.
- Focused workflow-shape assertion in the green run.
- Docker-backed Crabbox `local-container` provenance for the reviewed source head.
- Secret scan of the committed transcript.

## Out Of Scope

- Live GitHub cancellation mutations.
- Cloudflare Worker, dashboard, or OpenClaw Bay behavior.
