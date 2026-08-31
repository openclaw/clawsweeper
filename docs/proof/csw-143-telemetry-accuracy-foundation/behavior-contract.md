# CSW-143 telemetry accuracy foundation behavior contract

## Claim

An authenticated, read-only reconciliation path can compare the public exact-review
telemetry aggregate with the canonical lifecycle projection without exposing lifecycle
rows. Public Bay and Overview responses describe snapshot freshness and history coverage
explicitly, use safe null states when observations are unavailable, and never render a
zero-denominator error rate as zero percent. Bay keeps durable lifecycle availability
separate from independent queue and live activity.

## Exercised surface

- The production dashboard Worker running locally through Wrangler in Docker-backed
  Crabbox `local-container`.
- The existing authenticated lifecycle audit boundary and canonical Durable Object
  projection store.
- Public `GET /api/status` and `GET /api/health-history` responses.
- The rendered Overview and Bay observer-only pages.

## Scenario and fixture

Use synthetic local credentials and deterministic synthetic lifecycle and health-history
records. Populate completed, incomplete, and empty observations through the same Worker
and Durable Object routes used by production. Request the protected reconciliation with a
valid operator signature and repeat it without valid authorization. Exercise a fresh
complete public snapshot, a stale or partial snapshot, usable and failed exact-review
history polls, an empty history, an Overview sample with zero attempts, and a lifecycle
projection whose Bay telemetry materialization is pending.

## Command and environment

Run focused Node tests first. Then run the production Worker through Crabbox provider
`local-container` with the repository's supported Node runtime and Wrangler, recording the
candidate commit, container image, Crabbox run or lease identifier, and exact proof script
and HTTP transcript. Use only loopback endpoints and synthetic secrets; do not deploy,
read production Durable Objects, or mutate GitHub.

## Observable result

- The protected reconciliation returns summary counts and aggregate comparison only,
  never repository names, item numbers, run identifiers, workflow details, or row payloads.
- Invalid or absent authentication cannot read reconciliation results.
- Public status includes a bounded freshness state and nullable age/source timestamps.
- Public health history includes an explicit complete, partial, or unavailable coverage
  state, denominator, observed/failed/missing counts, gap information, and nullable
  freshness fields.
- Empty or incomplete inputs remain `null`/unavailable rather than becoming a synthetic
  zero or a false complete state.
- Reconciliation remains unavailable while either durable lifecycle-to-telemetry recovery
  source is pending, matching the public Bay aggregate boundary.
- Overview renders an unavailable error rate for zero attempts.
- Bay labels the durable lifecycle projection separately from independent queue and live
  activity when lifecycle inventory is unavailable.

## Artifact or trace

Retain the focused test transcript and Crabbox timing JSON plus the sanitized HTTP/browser
proof transcript under `.artifacts/csw-143-telemetry-accuracy-foundation/`. The PR body
will identify exact files and reproduce the relevant observed values without publishing
credentials or lifecycle rows.

## Anti-cheat probes

- Change one synthetic canonical projection without updating the telemetry event and
  require the reconciliation result to report a mismatch.
- Request reconciliation with no signature and with an invalid signature.
- Supply zero history samples, one failed collection slot, and an overdue latest sample.
- Supply `failed = 0` and `attempts = 0` and require `n/a`, not `0%`.
- Make durable lifecycle inventory unavailable while retaining queue/live activity and
  require both states to remain independently visible.
- Leave a completed lifecycle projection pending telemetry materialization and require the
  protected reconciliation to return an unavailable collection with no comparison.

## Limits

The proof establishes contract calculation, authentication, privacy shape, and local
rendering against synthetic data. It does not deploy, validate every historical lifecycle
row in production, establish causal effects for pull request 1280, persist lane-transition
timestamps, publish per-lane timing, or redesign the dashboard hierarchy.
