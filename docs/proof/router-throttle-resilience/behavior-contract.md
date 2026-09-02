# Router throttle resilience behavior contract

## User-visible goal

The repair comment router must defer GitHub installation or abuse throttles
without losing its scheduled scan position, while still surfacing unrelated
errors as failures.

## Target

- Type: operator CLI and scheduled-workflow state artifact.
- Launch or access: `node scripts/e2e/comment-router-throttle-loopback.mjs`.
- Allowed fixtures and credential source: deterministic loopback HTTP selected
  through `GITHUB_API_URL` and a synthetic placeholder token; no live secret.

## User tasks

1. Route an exact comment while its issue-comment history returns GitHub's real
   installation-rate-limit 403 body.
2. Route a bounded broad batch containing one throttled issue and one issue
   whose context is already available.
3. Retry the broad scan after GitHub recovers.
4. Route the same exact comment when GitHub returns a non-throttle client error.

## Expected observable behavior

- Installation 403, abuse 403, and 429 responses produce a structured
  `github_throttled` skip and exit 0.
- The throttled command is retained as waiting, already-routable work completes,
  and the cursor remains byte-for-byte unchanged.
- The recovered broad scan requests comments oldest-first with
  `since=<cursor watermark>`, skips ids already handled at that timestamp, and
  advances only after success.
- The non-throttle error exits nonzero.

## Anti-cheat probes

- Vary the throttle response between installation 403, abuse 403, and 429.
- Include two comments with the same cursor timestamp and prove the saved id is
  not reprocessed.
- Replace the throttle with a 422 response and require a failing exit.
- Inspect the persisted cursor before defer and after successful retry.

## Evidence required

- Parsed CLI exit statuses and structured skip output.
- Loopback request paths showing the incremental query.
- Before/defer/retry cursor JSON summaries.
- Git commit and tree ids resolved by Git in the validation container and
  checked with `git cat-file`.

## Out of scope

Live GitHub quota consumption, production workflow dispatch, GitHub mutation,
and changes to the historical-comment semantics used by source-revision and
status-comment guards.
