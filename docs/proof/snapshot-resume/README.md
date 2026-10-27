# Resumable snapshot proof

- Status: active controlled proof fixture
- Owner: ClawSweeper maintainers
- Source of truth: `scripts/worker-records.ts` and `test/record-snapshot-resume.test.ts`
- Last verified: `scripts/worker-records.ts` SHA-256
  `265fef77331ba4f4fca13c3ff6659d548768a6345a57565828ed5ecf9313f0eb`, Node 24.22.1,
  Wrangler 4.131.1 local workerd
- Update when: snapshot producer replay, watermark choice, export paging, upload
  registration, or reader hydration changes

Run `node docs/proof/snapshot-resume/run-proof.mjs` with Node 24+ and Corepack.
It starts pinned Wrangler 4.131.1 locally against the production Worker, queue
export, signed upload route and snapshot registration over real workerd SQLite
and R2. The fixture route writes records the way canonical publication does:
each write takes the next revision from the single monotonic counter.

The proof stores 2,000 records and snapshots them, then queues a 6,000-change
backlog (every stored record rewritten plus 4,000 new ones). It runs the actual
`snapshot-upload` CLI with `--replay-budget-seconds 2` repeatedly. During every
run it writes 50 more rewrites, deletions and creations. After every run it
hydrates a fresh reader from the latest registered snapshot plus the journal and
requires the exact live record set and bytes. It stops when a run reports
`replay.complete`.

Export pages carry a labeled 300 ms synthetic delay. Local pages otherwise take
milliseconds, so no wall-clock budget would bind; production pages take seconds
because of R2 body reads.

Observed: 9 runs. Each budgeted run stopped at about 2 seconds and registered
a snapshot at its last applied cursor. The watermark rose every run (3,009 →
8,450). Every reader matched exactly. The reader delta shrank from 5,003 to 0,
and the final snapshot held all 5,934 live records.

Limits: a controlled loopback fixture with one items section. It proves resume
correctness and convergence under concurrent writes, not production throughput
or Cloudflare capacity. The focused tests separately cover the exact cut point,
mid-replay rewrites and deletions, one-page-per-run convergence, the unbudgeted
watermark, CLI validation, and registration refusing a wrong cut.
