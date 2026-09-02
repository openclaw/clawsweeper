# Saved lease authority repro

- Status: proposed proof methodology; this folder contains no execution receipt
- Owner: ClawSweeper queue maintainers
- Source of truth: [queue](../../../dashboard/exact-review-queue.ts),
  [lifecycle tests](../../../test/dashboard-worker-publication-lifecycle.test.ts),
  and [workflow tests](../../../test/sweep-workflow.test.ts)
- Baseline: `659dee73d0706fee9776f7986d9861e82b897d24`
- Prepared candidate: `b0e75888d4341a98bc0db0b5f5cb9f3cd566eb0f`
- Update when: the compared source, lease authority, terminal lifecycle,
  forwarding protocol, Bay projection, or pinned toolchain changes

This is a focused follow-up to <https://github.com/openclaw/clawsweeper/pull/1251>.
The original lost-completion repair is already in the baseline. The claim here
is that direct requeue authority belongs to the saved lease's accepted or
deduplicated receipt: a mutable current decision cannot invent or remove that
authority, and a superseded receipt cannot authorize a requeue completion.

The public source makes the experiment inspectable without access to private
artifact portals. It does not establish that this integrated candidate has
passed runtime proof. Record fresh execution observations in the main PR body,
bound to its exact head and base; never present these expected results as an
executed receipt.

## Run

Use an already provisioned Linux environment with Bash, Node 24, pnpm 11.10.0,
Git, tar, curl, `setsid`, installed repository dependencies, and an installed
Wrangler **4.107.0** executable with its Miniflare/workerd dependencies. The
driver verifies versions and records the workerd binary version. It installs
nothing, fetches no source, and allocates no cloud resources. For maintained
proof, the operator supplies the configured AWS Crabbox environment and records
the actual provider, image, lease, and run separately.

From the candidate checkout, including this entire folder:

```bash
SAVED_LEASE_SOURCE_DIR="$PWD" \
SAVED_LEASE_OUTPUT=/tmp/saved-lease-proof-results \
SAVED_LEASE_WRANGLER=/absolute/path/to/installed/wrangler \
bash docs/proof/saved-lease-authority/run-proof.sh
```

The output must be a new absolute directory. `SAVED_LEASE_SOURCE_DIR` defaults
to the current directory; `SAVED_LEASE_PORT` defaults to 8795. A Git index and
HEAD are required to enumerate candidate source and record its identity. Run
against clean committed source for final proof; the manifest records any
tracked working-tree changes and hashes the actual copied source.

The baseline object must be available, or supply `SAVED_LEASE_BASELINE_ARCHIVE`
with an archive created by this exact command:

```bash
git archive --format=tar 659dee73d0706fee9776f7986d9861e82b897d24 \
  dashboard src config .github/workflows/sweep.yml package.json \
  > /tmp/saved-lease-baseline.tar
```

Its SHA-256 must be
`f1873d20690bbc76f53257949caf6f55301f47279a844c2e416a0ed637fafd07`.
The driver rejects a different digest, unsafe archive paths, and links. It
extracts into temporary directories, preserves all baseline dependencies, and
uses the candidate checkout's installed dependencies for both modes.

## Exercised surface and expected observations

[run-proof.sh](run-proof.sh) starts real workerd with isolated SQLite Durable
Objects for each mode. [worker.ts](worker.ts) supplies narrow fixture operations
through the real signed forwarding path. [drive-proof.mjs](drive-proof.mjs)
drives publication, terminal disposition, enqueue, completion, reconciliation,
and the public Bay projection over loopback HTTP. Modes are explicit; no source
symbol or grep-based detection selects expected behavior.

Each mode exercises 17 scenarios. Accepted/deduplicated receipts cover delivered
completion and a realistic lost callback: the finalizer's terminal `requeue`
is written before `/complete` is deliberately omitted. Both modes should recover
those cases. The four distinguishing authority controls are:

| Control | Baseline expectation | Candidate expectation |
| --- | --- | --- |
| Superseded receipt with requeue completion | Incorrectly accepts requeue | Rejects completion with HTTP 400 |
| Missing saved lease decision | Incorrectly borrows current authority | Does not requeue |
| Wrong saved source action | Incorrectly borrows current authority | Does not requeue |
| Current plan changed after lease | Drops saved requeue authority | Requeues from the saved lease |

Other controls cover superseded/no-lifecycle receipts, a real signed newer
command, wrong run attempt or claim generation, ambiguous ownership, unsigned
reconciliation, failed/cancelled publication retries, repeated reconciliation,
and late old completion. Assertions inspect pending revision and decision,
lease clearance, lifecycle identity, terminal outcome, counters, and public
Bay projection. They retain existing newer-command and retry behavior.

[annotation-proof.mjs](annotation-proof.mjs) compares the unchanged workflow
failure gate across 192 feasible Boolean contexts and executes its actual Bash
block for six synthetic cases in each mode. No workflow edit is claimed.

OpenClaw Bay needs no schema or UI change. The proof checks the existing
observer-only projection and SQLite Bay row counts, including preservation of
the old terminal fact without invented success/failure, router, or
acknowledgement receipts. It includes current-main telemetry dependencies.

## Artifacts and limits

Generated output includes source, lockfile, and driver hashes; HEAD/tree and
baseline identity; toolchain versions; exact runtime commands; request/response
traces; scenario assertions; workflow annotation observations; and Wrangler
logs. Keep raw output outside committed source. The main PR body must record
normalized observations, exact command, head/base, provider/image/lease, and
limits after execution. If later source changes, rerun affected proof or state
and verify exact source/hash equivalence before carrying observations forward.

Admission and malformed/ambiguous authority preconditions are seeded. Terminal
run observations use signed supplied `terminal_runs`, without a GitHub lookup.
The harness disables alarm dispatch only after asserting exactly one pending
item. Outbound Worker fetch throws and is counted; any unexpected alarm state
fails. Wrangler receives an allowlisted environment and an empty temporary home.
All identifiers and signing material are synthetic. No credentials, live queue
mutation, GitHub writes, deployed-edge behavior, Actions admission, complete
hosted workflow, or model inference are exercised.
