# Canonical record bodies in R2

- Status: implemented architecture; production execution requires separate approval
- Owner: ClawSweeper storage and queue maintainers
- Source of truth: [canonical record owner](../dashboard/exact-review-direct-publication.ts),
  [queue owner](../dashboard/exact-review-queue.ts), and
  [snapshot owner](../dashboard/record-snapshots.ts)
- Original inspected baseline: `291ab8a0090a8f76c08e4d0e39ea4cf1fdcbe0c0`
- Current implementation: the canonical record and queue owners linked above
- Update when: maintainers accept the representation, implementation changes,
  proof completes, or the deployment and rollback floor change

Keep canonical identity and ordering in SQLite. Store exact canonical bodies in
an immutable namespace within the existing R2 bucket. Preserve every logical
record, tombstone, digest, tuple revision, export revision, and publication receipt.

The representation and schema transition were accepted on 2026-10-16 and are
implemented. This document grants no production deployment, activation, migration,
deletion, or R2 expiration authority. Each candidate must pass native proof and
independent review before its separate production execution packet is approved.

## Evidence and scope

The completed census observed 3,400,515,871 bytes in canonical `content`.
The table contained 419,448 rows, including tombstones.
The separate storage report observed 8,130,392,064 occupied database bytes at
2026-10-15T15:47:52.196Z. These are historical observations, not current usage.
See the [completed storage report](https://github.com/openclaw/clawsweeper/actions/runs/38763467677).

Column bytes exclude indexes, numeric values, and page overhead.
They do not predict the occupied-byte reduction after migration.
The existing census also does not measure canonical chunks separately.
Refresh decision-relevant counts and capacity before approving production execution.

Canonical records hold each item's current tuple, not every review generation.
Reports contain decisions, evidence, and provenance that GitHub cannot reconstruct.
Plans and referenced decision packets also have supported readers and integrity contracts.
Age does not establish disposal authority for these records.
The [existing storage contract](state-storage.md) retains them after receipt expiry.

This implementation covers the four canonical sections: `items`, `closed`, `plans`,
and `decision-packets`. It preserves all deletion tombstones.
Commit reports and live imported records remain with the backfill owner.
Webhook snapshots, lifecycle projections, ledgers, and artifact retention remain
outside this migration. Their measured size does not authorize their deletion.
Completed hydration and backfill cleanup must not restart.

## Representation decision

The existing live-row CHECK requires inline content or real SQLite chunks.
An external body cannot satisfy it honestly.
Empty content, fabricated chunk counts, and locator text disguised as content
would let older readers silently return invalid records.

Use one metadata-only canonical table in the same Durable Object database.
The proposed name is `exact_review_canonical_records_v2`.
Keep these authoritative facts there:

| Fact                                  | Purpose                                                      |
| ------------------------------------- | ------------------------------------------------------------ |
| Repository, section, item ID          | Canonical identity                                           |
| Digest and byte length                | Exact body identity and read budgets                         |
| Deleted flag                          | Durable tombstone, distinct from unavailable storage         |
| Tuple revision and updated time       | Existing logical version                                     |
| Canonical target and claim generation | Producer provenance                                          |
| Typed coverage fields                 | Repository, review status, reviewed time, and exclusion fact |

A live row requires a verified body descriptor. A tombstone has no body descriptor,
no digest, and zero bytes. Keep the export index and both publication receipt
families with their existing owners.

Keep coverage facts bounded. Do not copy the entire report header or embedded
review JSON. Derive coverage through the existing bounded parser before detachment.
Seed the existing durable answered fact while the original body and provenance
remain available. Preserve false outcomes for stale-source requeues.
Missing provenance must not manufacture a completed review.

The proposed queue storage schema transition is version 1 to version 2.
Version 2 records that canonical bodies can live outside the old SQL tables.
The supported build must understand both versions before activation.
The frozen baseline rejects a different queue schema version. The candidate
supports versions 1 and 2 while initialization still persists version 1. Deployment
and startup never activate tiering; the native maintenance owner does that explicitly.

## Body ownership and writes

Reuse `STATE_SNAPSHOTS`, already bound in
[the Worker configuration](../dashboard/wrangler.toml).
Use `records/bodies/v1/sha256/<digest>` for immutable exact UTF-8 bytes.
Derive the key from the digest rather than storing a duplicate locator.
Keep this namespace separate from snapshots, ledgers, assets, and artifact caches.
Verify the actual bucket lifecycle rules cannot expire this namespace before activation.
Do not expose it through the generic state-blob mutation API.

1. Validate authenticated operations and normalize stored report bytes through the existing owner.
2. Compute the stored body's SHA-256 digest and byte length.
3. Upload with create-only semantics and the SHA-256 integrity option.
4. Read the resulting object and verify its exact bytes, length, and digest.
5. Recheck all publication authority after the final R2 await.
6. Commit metadata, tuple changes, export changes, and receipts synchronously.

A pre-existing object needs the same verification before reuse.
An R2 key alone, object size, ETag, or snapshot identity list is insufficient proof.
Receipt fingerprints retain the original authenticated bytes.
The external descriptor identifies normalized stored bytes, which can differ.
Preserve the direct-retry and deferred-batch receipt rules separately.

Recheck lease expiry, batch membership, generation, fence, source admission,
superseding publications, and existing receipts immediately before commit.
An upload grants no publication authority.
Failed authority checks or failed SQL commits can leave an unreferenced object.
They must never leave a committed descriptor pointing at an incomplete upload.

Do not add a second durable body cache, new database, runtime configuration switch,
or general storage framework. R2 failures prevent body-dependent success.
There is no fallback to stale Git records or expired artifact archives.

## Readers and transaction boundaries

Keep existing HTTP envelopes and runner contracts unchanged.
Separate synchronous metadata selection from asynchronous body resolution.
Capture each immutable descriptor with its digest and logical version before
awaiting R2. Never attach a newer body to older export metadata.

| Surface                 | Required behavior                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| Point reads             | Preserve exact content and metadata. Absent identities and real tombstones retain record-not-found behavior. |
| Tuple compare-and-swap  | Compare authoritative digests through metadata inside the synchronous transaction.                           |
| Tuple conflict response | Capture a coherent four-section tuple, then hydrate its exact bodies outside the transaction.                |
| Export                  | Preserve source-byte, record-count, response-size, cursor, and first-record progress limits.                 |
| Snapshots               | Resolve bodies asynchronously through the same owner. Preserve existing watermark semantics.                 |
| Admission               | Read the durable answered fact synchronously without R2.                                                     |
| Coverage                | Read typed SQLite facts without one R2 request per record.                                                   |
| Cleanup planning        | Use the same body reader. Preserve completed checkpoints.                                                    |

Missing or corrupt external bodies return a visible infrastructure failure.
They must not become a tombstone, an incomplete conflict response, or an invalid-input 400.
The client must retain its previous materialized records when hydration fails.

Snapshots remain derived consumers. Their two-snapshot retention and identity
checks cannot authorize removal of canonical bodies.
A snapshot scan is not a frozen archive of every body version.

## Migration with bounded temporary storage

Do not rebuild a second table containing all inline bodies.
The observed body total plus occupied database bytes exceeds the published
10 GB limit. A full copy could exhaust capacity before deleting the original.
See [Cloudflare's storage limits](https://developers.cloudflare.com/durable-objects/platform/limits/).

Prepare a build that supports both schema versions and both record representations.
While persisted schema remains version 1, keep normal publication behavior.
Production deployment requires its own explicit approval.
No startup path may activate historical detachment.
Verify every live writer uses the capable build before activation.
The current version 1 build does not recheck schema at every write boundary.

After the reviewed migration receives production approval, activate version 2
through the existing authenticated maintenance owner.
Atomically capture the old table's upper row identity and switch future writes
to the version 2 owner. Recheck the persisted version at every commit boundary.
A cached initialization check alone cannot fence a request already in progress.
Keep one durable migration checkpoint in the existing SQLite-backed storage.
Do not create filesystem sidecars.

Each pass inspects at most 64 raw identities and prepares at most four tuples,
with at most 8 MiB of source bodies. Native Workerd proof checks these fixed caps.
The existing per-file maximum still applies.
Capture the entire selected pass before the first asynchronous operation.
Deduplicate bodies by digest only when content and byte length also agree.
Prepare at most four unique bodies concurrently; each pipeline completes its
immutable PUT and full verified GET before taking another body. On failure,
stop launching pipelines and drain all started work before returning the error.
The source-byte cap and synchronous complete-tuple commit stay unchanged.
Four pipelines stay below Cloudflare's six simultaneous connections awaiting
response headers, including R2 calls; full body consumption remains part of each
pipeline's integrity check. See the official
[Worker connection limit](https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections).

For each selected tuple:

1. Capture every section's authoritative metadata and export pointer.
2. Reconstruct and verify each live source body.
3. Prepare verified immutable objects and typed SQLite facts outside the transaction.
4. Reread every captured section and export pointer inside one synchronous transaction.
5. Require exact agreement on revision, digest, deletion state, producer, and export sequence.
6. Insert version 2 metadata and delete only the matching old rows and chunks atomically.
7. Commit checkpoint progress with the row changes.

Physical relocation must not change tuple revision, export revision, updated time,
producer identity, or any accepted receipt. Retry unchanged uploads safely.
A changed tuple loses the comparison and keeps its current authoritative state.
Persist unresolved progress rather than reporting completion.
Stop detachment on integrity failures or an unavailable bucket.
The queue continues using supported readers for records already migrated.

During migration, one explicit owner resolves version 2 rows first and unmigrated
version 1 rows second. This is a temporary migration boundary, not permanent compatibility.
New writers must never recreate version 1 bodies after activation.
Complete only after all old identities resolve and both old canonical tables are empty.
Then remove the old tables and migration reader through the reviewed closeout.

R2 bodies remain durable after replacement or tombstoning in this initial scope.
No R2 deletion, expiration, orphan sweep, or bucket lifecycle change is included.
Unreferenced objects and version accumulation require a named reference-owned
reclamation follow-up before declaring the storage lifecycle complete.
This trades SQL capacity pressure for R2 storage and request usage.
Measure that usage and present its budget before production approval.

## Rollback and approvals

The rollback floor is a verified build that supports version 2 reads and writes.
After activation, redeploying the current version 1 build is not a safe rollback.
Returning to that build requires verified rehydration and enough database capacity.
It needs a separate approved plan. A code rollback cannot restore removed SQL bodies.

There are two different decisions:

1. Accept this representation and the version 1 to version 2 schema transition before implementation.
2. Approve the proved, exact production plan before any deployment or destructive activation.

Destructive production work requires explicit operator approval of the exact
execution plan. Source approval alone does not authorize production execution.
The production packet must identify exact deployment and rollback SHAs, resource
identity, current capacity, row predicates, batch limits, and stop conditions.
It must also include reconstruction proof, protected-data checks, and expected usage.

## Required proof before a code PR

Use a real Workerd Durable Object and controlled R2 binding with synthetic data.
Extend the existing [native workflow-storage fixture](proof/workflow-storage/README.md)
or another qualified fixture. Unit mocks alone cannot establish the storage contract.

| Scenario                                                       | Observable result                                                                                     |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Inline, chunked, empty, Unicode, and maximum-size bodies       | Identical bytes and digests through point reads and export                                            |
| Snapshot plus delta hydration                                  | Identical materialized records and original cursor semantics                                          |
| Overwrite or deletion during a pending R2 read                 | Each response binds one captured body's bytes to its own metadata                                     |
| Lease expiry, cancellation, or batch replacement during upload | No unauthorized tuple, receipt, export, or lifecycle success                                          |
| Successful commit with lost response                           | Existing direct and batch retry behavior remains correct                                              |
| Tuple conflict with external bodies                            | Four complete sections, coherent revision, valid packet references, and verified digests              |
| Completed, failed, requeue, and reconciliation reports         | Existing answered facts and first-review admission remain correct                                     |
| Coverage before and after detachment                           | Equal fresh, stale, failed, expired, excluded, and pending counts                                     |
| Upload failure, corrupt object, and failed comparison          | Original rows remain authoritative with visible failure                                               |
| Restart before and after SQL commit                            | Idempotent progress without duplicate logical revisions                                               |
| Migration at representative volume                             | Measured CPU, memory, IO, temporary SQL growth, and bounded passes                                    |
| Version 2 rollback floor and old build                         | Supported build reads all records. Cold and warm unsupported writers cannot commit across activation. |
| Unrelated stores and protected metadata                        | Queue, leases, imports, commits, receipts, and tombstones retain their contracts                      |

Publish commands, exact head, runtime identity, observations, and limits in the
code PR's real-behavior proof. Run repository checks and required reviews.
No proof listed here has been executed for this proposed representation.

## Dependency contracts checked

The official R2 Workers API supports conditional writes and a SHA-256 integrity option.
A failed write precondition returns null. Verify a reused object rather than treating
that result as successful publication.
R2 reads after a successful write are strongly consistent through the binding.
This design does not use a public CDN cache as its authoritative body reader.

- [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)
- [Durable Object SQLite API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

These contracts were fetched from official documentation on 2026-10-16.
They establish feasibility, not executed migration or deployment proof.

## Candidate maintenance owner

The signed native exact-review maintenance route owns preview, activation, and
migration. The maintenance workflow adds an explicit `canonical-bodies` mode;
its default reconciliation mode and preview/execute gate remain unchanged.
The public dashboard has no action control.

The stable preview packet binds the executing deployment SHA, the same qualified
build as rollback floor, its format 1+2 proof reference, operator identity, the
actual named bucket policy, namespace, scope, and fixed pass caps. The lifecycle
policy is canonicalized and hashed. The CLI reads the named bucket’s current
lifecycle rules and refuses a mismatch or any enabled deletion rule overlapping
the body prefix. No lifecycle rule is changed. Native R2 bindings cannot inspect
bucket policy, so the signed packet also records the reviewed operator attestation.

Live counts, export revisions, activation’s captured upper row identity, and
progress are observations outside that stable approval identity. SQLite persists
the approved packet and hash. Every later pass must name the same packet and
compare its separate captured checkpoint before commit. Ordinary publication and
migration progress do not require replacement approval packets.

A deployment change requires explicit checkpoint requalification before migration
can resume. `canonical_action=requalify-preview` (CLI `--action requalify-preview`)
takes `previous_plan_sha256` (`--previous-plan-sha256`), the new deployment SHA,
and its qualified attestation. The old stored plan must still be canonical and
hash to both the stored and supplied previous hash. Only deployment SHA, rollback
floor SHA/proof, and lifecycle observation time may change. Operator identity,
formats, lifecycle rules/hash, scope, namespace and limits must stay identical.

The response includes the full checkpoint and an envelope containing
`previousPlanSha256`, `checkpointSha256`, `nextPlan`, and `nextPlanSha256`.
Review the envelope and supply its `sha256` as `reviewed_plan_sha256` with
`canonical_action=requalify` and `execute=true`. The next normal plan hash is
not the requalification approval hash. Application requires format 2 and an
incomplete, exactly unchanged checkpoint; it updates only the deployment SHA,
plan hash and plan JSON. It preserves the frontier, cursor, deferred row,
counters and timestamps. Stale previews, old prepared passes and replays fail.
Resume migration with the returned `nextPlanSha256` and the same new attestation.
No checkpoint reset or implicit deployment adoption is supported.

An explicit migrate invocation runs at most 100,000 bounded passes or 50 minutes,
whichever comes first, stopping on completion or a full sweep with unresolved
sources. The workflow allows 60 minutes for that operation. A later invocation
resumes the persisted cursor using the same approved plan; startup and alarms
never schedule it. This makes large stores operable without one workflow dispatch
per four tuples. Throughput from the synthetic fixture is not a production estimate.

If maintenance fails, its final `canonical_tiering_failed` JSON reports the local
stage, transport reason, HTTP status, known endpoint code, platform failure
category, `completed_passes`, and `last_observed_checkpoint` (numeric fields only).
The last observed checkpoint is a lower bound: a lost response can follow a committed pass.
If a failure reaches the Durable Object request catch, use the returned trace ID
to correlate its `canonical_tiering_failed` log entry and failing phase.
Initialization failures that reset the object through `blockConcurrencyWhile`
instead emit `exact_review_queue_handler_failed` with `phase: initialize` and
no request trace ID. A client timeout or network error does not guarantee a
Durable Object log entry or a returned trace ID.
Unknown exceptions still propagate. Diagnostics never include exception text,
stacks, request URLs, record identities, plan JSON, or arbitrary server codes.
These observations do not authorize an automatic retry or a new migration run.
The [platform error contract](https://developers.cloudflare.com/durable-objects/best-practices/error-handling/)
defines the reported flags. `remote_exception` does not distinguish application
exceptions from infrastructure CPU or memory limits.

The same manual maintenance workflow offers `canonical-records-verify` for a
bounded before/after read check. It requires `execute=true`, the reviewed plan
hash, expected Worker deployment SHA, repository slug, and a `baseline` or
`recheck` phase. Recheck takes the baseline JSON emitted by the first run and
`canonical_verification_baseline_sha256`, the independently reviewed checksum
from that run. The CLI reads this pin from `EXPECTED_BASELINE_SHA256`.
Baseline creation rejects a recheck-only checksum. Recheck validates the saved
producer SHA and hashes the original normalized metadata against both its
envelope checksum and the independently supplied pin before any request.

The workflow source SHA is separate from the Worker SHA and may differ from the
saved baseline's producer. Each result reports `executionOperatorSha`,
`comparedBaselineSha256`, and `comparedBaselineOperatorSha` (the latter two are
null for baseline creation). Its `baseline` and `sha256` describe the new observed
snapshot produced by the current operator; they do not replace the saved input
baseline. Keep the approved input and checksum unchanged for later rechecks.
Updating the verifier does not require redeploying the Worker.

Each phase verifies the Worker and signed Durable Object identity before and
after reading one export page per canonical section, at most 32 records each,
and at most 128 exact point reads. Limits are 136 logical requests, 408 transport
attempts, 30 seconds per attempt, 10 minutes per phase, and 16 MiB per response.
Only record identities, revisions, hashes, byte lengths, and coverage counts
leave the process. The existing signing secret stays in the dedicated workflow
step; no Cloudflare API token is needed.

Failures emit a fixed diagnostic category and recovery action, never raw error
text or response bodies. Correct invalid inputs using the saved baseline;
repository, deployment or plan mismatch requires a newly reviewed execution plan.
An updated verifier runs as its actual workflow SHA; it does not impersonate the
baseline producer or rewrite the baseline to satisfy provenance checks.
Record mismatches stop migration for investigation. Request or read-limit
failures preserve the baseline and checkpoint for reviewed recovery.

Exports can include backfill rows outside the canonical point reader. A baseline
bare 404 is recorded as `export-only` coverage, not proof of a canonical record.
A later bare 404 for a previously verified canonical record fails the check.
An explicit newer canonical tombstone is valid even when its updated export
entry has moved beyond the sampled first page. Concurrent revision changes are
reported separately. This sample does not prove full-corpus equality.

These body-read routes run existing Worker initialization and legacy cleanup.
They do not activate tiering, but they are not globally write-free diagnostics
and belong inside the separately approved production procedure.

Cloudflare restarts Durable Objects on deployment. Requests from the old deployment
may finish only while avoiding storage; an old-instance storage access is stopped
to preserve global uniqueness. Matching the executing DO deployment to the reviewed
SHA excludes unsupported old writers under that platform contract. Capable requests
already awaiting work in the current instance still recheck the durable format at
every canonical write boundary. See the official
[Durable Object lifecycle contract](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/).

The controlled [native proof fixture](proof/canonical-body-tiering/README.md) pins
its persisted baseline to the inspected revision above. Related work remains outside
this frozen candidate: [coverage identity matching](https://github.com/openclaw/clawsweeper/pull/2018)
and [snapshot download isolation](https://github.com/openclaw/clawsweeper/pull/2017).
Before landing on a newer base, reconcile those owner changes and repeat affected
proof. In particular, new coverage facts must be projected before body detachment.
