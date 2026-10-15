# Live-open coverage identity proof

- Status: active controlled proof fixture
- Owner: ClawSweeper maintainers
- Source of truth: `dashboard/worker.ts`, `dashboard/exact-review-queue.ts`,
  `dashboard/exact-review-direct-publication.ts`, and `src/review-coverage.ts`
- Last verified base: `75c614ee432a8c6e9ef7dec0b98ba0a6a15fc32b`; each execution
  prints the exact exercised source hashes, including uncommitted changes
- Observed on 2026-10-15 with Node 26.7.0: all seven scenarios passed, with zero
  outbound requests
- Update when: signed inventory intake, canonical tuple writes, bounded record
  scans, inventory validity, or public coverage projection changes

From the repository root, with Node 24 or newer, run:

```bash
node docs/proof/coverage-identity/run-proof.mjs
```

No build, install, credentials, or external services are required. The runner
imports the production Worker and queue handlers directly. It sends signed
inventory and canonical record requests through the Worker, persists them in
the existing `test/exact-review-test-storage.ts` adapter backed by real
in-memory SQLite, then reads the public `/api/review-coverage` route. The only
binding adapter routes Durable Object requests to the production queue.

The principal scenario has three live identities and three fresh canonical
records, but only one identity matches. The result must be 33.3% coverage,
two untracked open items, and two drifted records. Aggregate count clipping
would falsely report 100%. The matching record has a header longer than
4 KiB, exercising the bounded prefix scan. Other scenarios verify unsigned
intake rejection, PR head mismatch, exclusion from live labels, and UNKNOWN
coverage with missing, count-only, incomplete, stale, or future inventory.

Successful execution prints `ok: true`, source hashes, request-path receipts,
and each public result to stdout. Failure exits nonzero. Nothing is written
to disk; all fixture state is process-local. Outbound fetches are forbidden,
and stored alarms are never dispatched.

This demonstrates production handler behavior with Web Request/Response and
real SQLite. It does not demonstrate Cloudflare scheduling, workerd storage
limits, deployed bindings, GitHub census pagination, or production capacity.
The long header here is synthetic; the runtime regression separately exercises
the real report writer. Issue content freshness remains unproven by identity
matching; generic GitHub `updated_at` is not a semantic source revision.
