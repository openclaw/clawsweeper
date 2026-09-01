# Dashboard Worker test split proof

## Claim

The 29,073-line `test/dashboard-worker.test.ts` monolith is split into eight contiguous,
thematically named test files plus one non-test harness without changing any test registration
body, runtime test name, or test count.

## File map

| Test file | Runtime tests |
| --- | ---: |
| `dashboard-worker-queue-policy.test.ts` | 54 |
| `dashboard-worker-publication-lifecycle.test.ts` | 22 |
| `dashboard-worker-bay-records-routes.test.ts` | 41 |
| `dashboard-worker-observability.test.ts` | 16 |
| `dashboard-worker-queue-runtime.test.ts` | 137 |
| `dashboard-worker-dashboard-status.test.ts` | 36 |
| `dashboard-worker-webhook-ingress.test.ts` | 25 |
| `dashboard-worker-telemetry-contracts.test.ts` | 6 |
| **Total** | **337** |

Shared imports, fixtures, in-memory storage doubles, and request builders live in
`test/dashboard-worker-harness.ts`. Its name deliberately does not match `*.test.ts`, so the
repository test glob ignores it.

## Safety net

The untouched `origin/main` suite and the split suite each reported 3,333 tests: 3,324 passed,
9 skipped, and 0 failed. `before-test-names.txt` and `after-test-names.txt` are sorted copies of
the exact Node test-reporter names, including repeated names. Both files have SHA-256
`72ca5bf6f1beae8a2105f3006e8316e8c038dd15e2374e6b8c0debfadb259611`.

`name-set.diff` is the committed zero-byte diff between those lists. The 336 source registration
blocks—335 direct registrations plus one intact loop that registers two runtime tests—also compare
byte-identically with the original source. See `test-registration-identity.txt`.

## Standalone files

Each split file passed when invoked alone with `node --test <file>`. This proves the cleave did not
introduce execution-order coupling between files. The exact counts and durations are recorded in
`standalone-results.txt`.

## Local gates

The seven proof and repository gates are recorded in `local-gates.txt`. The repository-wide gate is
`pnpm run check`; the narrower entries make its build, test, lint, format, and static-check evidence
explicit.

## Container proof

`container-proof.sh` is the command run from a clean PR checkout. It enables the repository-pinned
Corepack/pnpm toolchain, downloads jq 1.8.2 for the container architecture, verifies that binary
against jq's official published SHA-256 manifest, installs dependencies from the frozen lockfile,
and runs the full suite.

The required clean `--fresh-pr openclaw/clawsweeper#1127 --no-hydrate` run passed at pushed head
`07d5ef9528ad69b7b4a2aaafa1050c199b2506c6`. Crabbox resolved `provider=aws` and executed the
proof inside `node:24-bookworm` on lease `cbx_a6899c138d00` (`jade-lobster-c3f0`), run
`run_8980401fcc5d`, machine type `c7a.8xlarge`. The full suite passed 3,333 tests with 3,325
passed, 8 Linux-inapplicable skips, and 0 failures. Crabbox reported exit 0 and
the lease was explicitly released with Crabbox 0.41.1 after the older run wrapper's release
acknowledgement timed out; a provider-specific lease listing was empty afterward.

The repository-pinned official jq checksum passed, Node was 24.18.1, pnpm was 11.10.0, jq was 1.8.2, and the
container installed Debian rsync 3.2.7. `container-provenance.json` is the committed receipt;
`container-stdout.log` retains the proof-bearing transcript. TruffleHog 3.96.0 found no verified
or unknown secrets in the exact 522,855-byte stdout capture.

Two earlier harness-only attempts are disclosed in the receipt. The first left verified jq outside
the test login-shell path; the second still lacked rsync and exposed jq only through a temporary
parent-shell path. Both failed unrelated workflow fixtures and both report automatic lease cleanup.
A third run passed before the review-required jq digest pin; it is retained as superseded provenance.

## Limits and OpenClaw Bay impact

This is a test-only ownership split. It changes no production source, runtime API, workflow,
dashboard data contract, lifecycle publication, queue behavior, or observer/action boundary.
OpenClaw Bay is unaffected.
