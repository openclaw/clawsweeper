# Reservation retry fixture timing

Historical proof for the `--fixture-no-wait` option of
`scripts/e2e/review-reservation.mjs`, used by
`test/review-lease-reservation.test.ts`.

## Change

The e2e runs the real "Reserve exact review lease" step from
`.github/workflows/sweep.yml` against loopback fixtures. Its retry loop sleeps
`2 * attempt + 0..3` seconds between attempts, so the focused test spent most
of its time waiting. With `--fixture-no-wait`, a `sleep` shim placed first on
the step's `PATH` records each requested delay instead of waiting. The e2e then
checks every recorded delay against the workflow's bounds, and that the
`service-unavailable` scenario recorded all four of its retry waits. The
standalone e2e and `--quiet` keep real waits. The workflow is unchanged.

## Results

Node 24.22.1, macOS arm64:

| Command | Base | This change |
| --- | ---: | ---: |
| `node --test test/review-lease-reservation.test.ts` | 59.4 s | 29.5 s |

All 13 reservation scenarios pass with the shim. Recorded delays:
`service-unavailable` 4 waits, `preflight-service-recovery`,
`post-service-recovery` and `post-throttle-recovery` 1 wait each, all others
none. The remaining time is mostly the second test in the file, the lease
lifecycle e2e, which this change does not touch.
