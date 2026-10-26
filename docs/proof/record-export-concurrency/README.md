# Bounded record export native proof

- Status: controlled proof; not production recovery or execution approval
- Owner: ClawSweeper storage and queue maintainers
- Sources: `dashboard/exact-review-direct-publication.ts`, `worker.ts` and `run-proof.mjs`
- Baseline: `118a07468663a22e9cc0e3fd76dfe2f17532eec0`
- Update when: export ordering, capture, bounds, body integrity or snapshot protocol changes

## Contract

Claim: bounded parallel external-body resolution removes the per-body serial wait
in bulk exports, without changing bytes, digests, revisions, cursors, coverage,
tombstones or metadata-only listing. This does not identify which change caused
the hosted hydration incident or prove deployed recovery.

The fixture reuses the canonical body-tiering native instrumentation, imports
the actual production Worker and ExactReviewQueue, and runs native Workerd
SQLite Durable Objects, StatusStore and R2. Signed requests travel over loopback
HTTP. External Worker fetches are refused. Both baseline and candidate use the
same corpus: 135 export entries across all five sections, 38 legacy rows
(including chunked and maximum-size bodies), 96 v2 rows, live bodies,
Unicode/NUL/escaping, commits and tombstones. The first 24 tuples are migrated
only inside this disposable fixture; no live migration is involved.

A labeled 20 ms delay on each actual R2 operation exposes overlap. The baseline
must exceed a controlled 1,000 ms completion budget; the candidate must complete
within it. This is a completion comparison, not an assertion of a production
Cloudflare CPU/memory budget or end-to-end planner deadline.

Both variants execute the real `worker-records.ts snapshot-upload` CLI, then
hydrate through `materializeWorkerRecords` after six journal changes, including
overwrite and deletion. Every resulting file is compared byte-for-byte and
all tombstone paths must be absent. Candidate failures exercise complete
in-flight drainage, no later window, missing bodies and same-size corruption.
Focused regression tests additionally cover reverse completion order, response
truncation and speculative errors, source/work caps, immutable captures across
overwrite/deletion, tuple CAS and coverage preservation.

## Reproduce

Run from the checkout with Node 24+ and pinned native tools available through a
directory containing `package.json`:

```sh
npm install --prefix .artifacts/record-hydration/runtime-tools --no-save --no-package-lock wrangler@4.131.1 esbuild@0.28.1
PROOF_TOOL_ROOT=.artifacts/record-hydration/runtime-tools node docs/proof/record-export-concurrency/run-proof.mjs
```

The runner creates the frozen source archive from Git, or accepts an existing
archive through `PROOF_BASELINE_ARCHIVE` when the remote checkout lacks history.
It records the archive hash, current head, actual production source hash,
fixture hash, runtime versions, provider/image/lease, ordered export digest,
coverage digest, timing, I/O concurrency and snapshot/delta results in
`.artifacts/record-hydration/native-results.json`. Set `PROOF_OUTPUT` to retain
it elsewhere inside the task workspace. Native scratch state is removed on exit.

The storage change has no Bay UI or action-control changes; Bay remains
observer-only. No production writes, deployment, live snapshots, workflow
dispatches, apply/close, merge or automerge are performed by this proof.

## Observed result

AWS Crabbox run `run_064a5fb71da792f37aae18c2f0769a98` used provider `aws`,
lease `cbx_b30b92aa985a` and image `ami-04beed173f1785931` on Node 24.19.0.
The [retained JSON](results.json) records the exact source and fixture hashes.
The source head is the pinned base plus the staged candidate; the production
source hash binds the tested change independently of the later commit identity.

With the labeled delay, the baseline completed in 1,754 ms at peak one R2 read;
the candidate completed in 775 ms at peak three reads (the four-entry windows
also contain tombstones). Both made 72 body reads, exported the same ordered
digest and preserved coverage. Both snapshot-upload/hydration paths restored
95 exact files at revision 141 from snapshot 135 plus six journal changes.
Injected failure drained all started reads; missing and same-size-corrupt bodies
were refused. The full `pnpm run check` command passed in the same AWS run.
