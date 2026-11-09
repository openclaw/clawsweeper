# Reservation retry fixture timing

Base: `eae7a713e211392f2a57ab91880a761efa1ae359`. The reservation e2e runs
the workflow's actual extracted Bash step against loopback fixtures. The focused
Node test now opts into simulated fixture sleeps, while the standalone e2e and
its documented `--quiet` mode retain real retry waits. The workflow and its
retry policy are unchanged. Fixture-only mode cannot be combined with `--quiet`.

The fixture-only Bash function is installed only in the reservation child. It
unsets its startup environment before nested commands, validates one numeric
sleep argument and records the actual attempt and requested delay. The e2e
checks the 13 scenario identities, exact per-scenario counts, attempt order,
and the workflow's `2 * attempt + 0..3` bounds. It also rejects watchdog expiry,
a signaled child or a missing exit code before interpreting an expected failure.

## Observed behavior

With Node 24.22.1, pnpm 12.15.0 and the lockfile-pinned dependencies, a fresh
`build:node` was used in a Linux arm64 user/PID/network namespace with loopback
only, read-only source and dependency inputs, and task-owned writable fixtures.
The selected Node test ran all 13 e2e cases through the real workflow shell,
CLI and loopback requests. A separate candidate run preserved all 13 ordered
case outcomes and the recorded method/path/status/comment-ID traces against the
base; existing assertions separately checked durable-comment content. Complete
HTTP payload-byte parity was not measured. No namespace processes remained.

The standalone default command passed all 13 cases with real waits, and the
standalone `--quiet` command passed its four cases with matching recorded
outcomes and traces. Both produced no simulated-timing marker. In the candidate
fixture run, the three one-retry cases recorded attempts/delays 1/2, 1/4 and
1/5 seconds; the five-request unavailable case recorded 1/4, 2/5, 3/8 and 4/9.
The fixture records requested delays; it does not wait for them.

Task-local negative overlays exercised the actual candidate assertions. Missing,
extra, malformed and out-of-range records failed; swapped attempt identities
failed the order check; a newline-bearing single sleep argument failed the Bash
validation. A deliberately signaled task-owned reservation child was rejected
as SIGKILL rather than accepted as the expected unavailable-service failure.
The incompatible option pair failed before creating output. All eight controls
exited normally as expected and left no namespace processes. A separate
instrumented proxy check passed all 13 cases and observed no nonempty injected
Bash startup or fixture log variable values, and no exported sleep function, in
the fixture GitHub and queue proxy processes. It does not cover every future child.

## Local matched timing

The same selected Node test command ran sequentially A/B/B/A, where A used the
base with real waits and B used the candidate's fixture-only mode. All four
selected the same one test, passed its 13-case assertion, had no skips and left
no namespace processes. The capture's RSS is a waited-child maximum, not a
process-tree peak.

| Order | Wall s | User s | System s | Max RSS KiB |
| --- | ---: | ---: | ---: | ---: |
| Base | 53.215661 | 15.661354 | 7.580140 | 114920 |
| Candidate | 16.605313 | 15.832958 | 7.850732 | 117392 |
| Candidate | 16.565688 | 15.940550 | 7.951355 | 117152 |
| Base | 54.490142 | 15.802439 | 7.803732 | 116200 |

The two-sample medians were 53.852901 s and 16.585500 s, a 37.267401 s (69.2%)
local difference. Retry jitter differs across runs. This is not an estimate of
hosted CI duration, tail latency, or billing.

The focused commands were:

```sh
corepack pnpm run build:node
node --test --test-concurrency=1 \
  '--test-name-pattern=^reservation workflow avoids comment churn for stale and retrying owners$' \
  test/review-lease-reservation.test.ts
node scripts/e2e/review-reservation.mjs /tmp/reservation-default
node scripts/e2e/review-reservation.mjs /tmp/reservation-quiet --quiet
```

The experiment used fresh temporary output paths; use fresh paths when repeating
it.

## Full local check

An isolated `pnpm run check` on the candidate source completed with exit 1 after
642.5 seconds: 7,133 tests passed, three failed and 22 were skipped. Static,
build, formatting and lint stages passed, as did the changed reservation test.
The isolated run had read-only source and dependencies, task-owned writable
outputs and loopback-only networking. No namespace processes remained.

Two tests failed when registry lookups returned `EAI_AGAIN` under this offline
isolation: the packed local reviewer installation and a Corepack fetch in the
compiled live-admission test. The signed-webhook loopback test expected 202 and
received 503; its cause is unknown. The full check did not pass. Hosted CI and
final committed-branch review have not been established by this proof.
