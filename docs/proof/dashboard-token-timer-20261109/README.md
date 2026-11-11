# Dashboard token test timer

This historical proof covers base `eae7a713e211392f2a57ab91880a761efa1ae359`
and the test-only timer cleanup in `test/dashboard-app-token-scoping.test.ts`.
The base test races a real mocked GitHub read against a 10-second rejection;
when the read settles first, its timer continues to hold the test process open.
The change clears that timer after the race settles and keeps the same deadline,
error, request behavior and assertions.

## Local comparison

The entire test file ran with `node --test test/dashboard-app-token-scoping.test.ts`
on Linux arm64, Node 24.22.1 and lockfile-pinned dependencies. Runs used a
loopback-only network and PID namespace, read-only source and dependencies, and
task-owned writable output. A 40-second outer watchdog bounded each process; it
did not fire. A preliminary capture control verified failure status and stdout
and stderr separation.

A/B/B/A ran the unchanged base as A and the actual changed file as B. All four
runs passed the same seven named cases with no failures, skips or cancellations;
no namespace processes remained. Each run includes Node startup and test setup.

| Order | Version | File-process wall time | Affected case duration |
| --- | --- | ---: | ---: |
| 1 | Base | 10.483206 s | 13.332 ms |
| 2 | Candidate | 0.398018 s | 10.524 ms |
| 3 | Candidate | 0.391566 s | 14.102 ms |
| 4 | Base | 10.450083 s | 14.170 ms |

The two-sample medians were 10.466645 s and 0.394792 s: a local file-process
difference of 10.071853 s. The case duration is a separate measurement from
process exit. This small comparison does not establish hosted CI critical-path,
tail-latency or billing changes.

## Failure controls

Task-only variants of the changed file retained the first stranded mint and
asserted two mints before controlling the second read:

- An unanswered second read failed with the original `later read stalled` error;
  the affected case reported 10011.523 ms. The control exited 1 as expected,
  with six other cases passing and no skipped or cancelled cases.
- A synthetic HTTP 418 response caused the second read to reject with the
  existing `GitHub 418` error, rather than the timer error. It also exited 1
  as expected, with six other cases passing and no skipped or cancelled cases.
  The same HTTP control against the base produced the same read error.

No namespace processes remained after either control. A direct synthetic fetch
throw was also tried; the production transport converted it to its generic
transport error, so the HTTP response was used to distinguish the read-level
rejection without changing the dashboard.

## Full local check

An isolated `pnpm run check` completed with exit 1: 7,133 tests passed, three
failed, 22 were skipped and none were cancelled. Static, build, formatting and
lint stages passed, as did the changed timer test. The run used read-only source
and dependencies, task-owned writable outputs and loopback-only networking; no
namespace processes remained.

Two tests failed with registry DNS `EAI_AGAIN` under this offline isolation: the
packed local reviewer installation and a Corepack fetch in the compiled
live-admission test. The signed-webhook loopback test expected 202 and received
503; its cause is unknown. The full check did not pass. Hosted candidate CI and
final committed-branch review have not been established by this proof.
