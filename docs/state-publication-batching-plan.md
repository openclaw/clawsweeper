# State publication batching plan

**Status:** PR 1 through PR 3 merged; PR 2 performance and PR 3 equivalent
synthetic end-to-end gates complete; PR 4 initial size-2 rollout implementation
complete and authorized
**Incident:** CSW-049
**Decision scope:** reduce the existing single-`state`-ref publication bottleneck
without migrating authoritative state to a new database or changing the generated
state layout.

## Delivery status

| Stage                                         | Status                                            | Evidence                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| State writer observability prerequisite       | Complete                                          | Merged before batching ownership as [`openclaw/clawsweeper#735`](https://github.com/openclaw/clawsweeper/pull/735).                                                                                                                                                                                                                                                                                              |
| PR 1: durable batch ownership protocol        | Complete                                          | Merged as [`openclaw/clawsweeper#734`](https://github.com/openclaw/clawsweeper/pull/734) at `c074a99c0b18848be7a7d8f80f0fa57b7875b129`; post-merge proof is recorded below.                                                                                                                                                                                                                                      |
| PR 2: bounded multi-item Git commit primitive | Complete                                          | Merged as [`openclaw/clawsweeper#740`](https://github.com/openclaw/clawsweeper/pull/740) at `a04c4c4cfbd29be9d6bf5036c824481b31d2233d`; stabilization followed in [`openclaw/clawsweeper#742`](https://github.com/openclaw/clawsweeper/pull/742). Local-container p95 proof against a 385,840-path structural fixture passed at 3,295.2 projected items/hour for size 2.                                                                 |
| PR 3: end-to-end batch publisher              | Complete; merged default off                      | Merged as [`openclaw/clawsweeper#746`](https://github.com/openclaw/clawsweeper/pull/746) at `8b5bbf8678b88f172340f1108d1bccdeed366618`. The equivalent synthetic maintainer proof verified one commit for two healthy items, isolated retryable and superseded items, per-item GitHub effects, and disabled fallback.                                                                                                       |
| PR 4: production rollout configuration        | Implementation complete; initial rollout authorized | Enables one event-driven serial publisher at size 2 and 60-second maximum wait, blocks new legacy admission while enabled, preserves in-flight legacy work, and exposes active configuration plus last dispatch outcome.                                                                                                                                                                                          |

PR 1 did not enable batching or add a batch publisher. The live legacy publisher
continues to consume the existing queue while the additive ownership protocol
remains inert behind `EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED`.

## Decision

Use the existing SQLite-backed `ExactReviewQueue` publication lane as the durable
buffer and replace one-workflow-per-item Git publication with one serial batch
publisher:

```text
existing SQLite publication items
               |
               v
      atomically lease one batch
               |
               v
   one batch publisher workflow
               |
               +-- validate each item independently
               +-- perform idempotent per-item GitHub effects
               +-- prepare bounded state path mutations
               |
               v
       one state lease acquisition
       one state commit and push
               |
               v
     complete each SQLite queue item
```

State writes remain serial. The unit of serialization changes from one item to
one batch. Git remains the final generated-state store in this plan; SQLite is
the durable publication buffer and broker, not a newly introduced second source
of truth.

This is the preferred narrow repair because:

- increasing admission to 50 did not create more real state writers;
- reducing admission to four did not provide enough observed useful throughput;
- increasing the ordinary lease wait from 180 to 480 seconds converted many
  three-minute failures into eight-minute failures without increasing service
  rate;
- fairer lock handoff could reduce starvation but would still publish only one
  item per expensive Git critical section;
- branch sharding or migration of operational state to a database would be a
  broader architecture and data-migration project;
- the existing SQLite queue already contains the active backlog, item identity,
  revision, artifact reference, lease, retry, and dead-letter state, so batching
  requires no backlog migration.

The most recent evidence reviewed for this plan continued to show a non-draining
lane: 586 pending, 635 total outstanding, 244 open dead letters, a 60-minute
arrival rate of 135/hour, useful published plus superseded throughput of 39/hour,
and a net drain rate of -77/hour. No open pull request was found implementing a
state commit broker or publication batching path.

## Scope and non-goals

This plan changes only how durable exact-result publication work is consumed and
committed to the generated `state` branch.

It does not:

- migrate historical state or ledgers into SQLite;
- make SQLite authoritative for review or apply records;
- shard the `state` branch or create per-item Git refs;
- change the flat `records/<repo-slug>/items/` and `closed/` layouts;
- weaken tuple, source-drift, protected-item, apply, or safe-close guards;
- automatically replay, resolve, or delete open dead letters;
- pause the live sweep workflow;
- cancel already-running publication workflows;
- batch unrelated ordinary state writers in the first rollout.

The exact-result lane is the initial scope because it is the incident-dominant
cohort and its durable queue already exists. Routing comment-router, status,
action-ledger, and other state writers through the broker is a later decision,
made only after exact-result batching proves its semantics and throughput.

## Why this work is split into separate pull requests

The split is primarily about independently reviewable correctness and operator
decision points, not about producing several small pull requests for their own
sake. The complete change crosses four failure domains:

1. SQLite ownership, leasing, and cleanup;
2. Git tree construction and atomic publication;
3. GitHub Actions dispatch and per-item completion semantics;
4. production admission and rollout configuration.

Combining those domains would make it difficult to tell whether a failure came
from storage, Git reconciliation, workflow wiring, or rollout configuration. It
would also make rollback unnecessarily broad.

Each proposed pull request therefore ends at a boundary that a maintainer can
verify manually before authorizing the next one. A merged pull request must not
silently enable the behavior introduced by a later pull request.

The split should not go below these boundaries. Dividing individual tables,
endpoints, or helper functions into additional pull requests would introduce
temporary interfaces and dead code without creating another meaningful human
decision point.

## Pull request sequence

### PR 1: durable batch ownership protocol

**Delivery status:** complete and verified on 2026-07-21 via
[`openclaw/clawsweeper#734`](https://github.com/openclaw/clawsweeper/pull/734).

**Purpose:** prove that existing SQLite publication items can be grouped,
leased, reclaimed, and completed without duplicate ownership or data migration.

**Estimated scope:** medium.

- One extracted batch-store/protocol module rather than more unrelated logic in
  `dashboard/exact-review-queue.ts`.
- Additive SQLite schema for batches and batch membership.
- Internal authenticated batch claim/fetch/complete operations.
- Queue stats and bounded cleanup metrics.
- Focused queue and migration tests.
- Feature flag defaulted off; no batch workflow dispatch.

Implemented additive records:

```text
exact_review_publication_batches
  batch_id
  state
  lease_owner
  lease_expires_at
  attempt
  created_at
  completed_at
  state_commit_sha
  failure_fingerprint

exact_review_publication_batch_items
  batch_id
  item_key
  revision
  claim_generation
  terminal_outcome
```

Batch membership references the existing queue item. It must not copy the full
item payload or create a second publication queue.

**Automated proof:**

- atomic selection of multiple ready items;
- the same item cannot belong to two active batches;
- lease expiry returns unfinished items to ready state;
- re-claim uses a new lease generation;
- stale item revisions can be terminalized as superseded before dispatch;
- cleanup cannot remove active membership or open dead letters;
- old code can ignore the additive schema.

**Maintainer manual verification:**

1. Inspect a test queue containing several ready items.
2. Claim a batch and verify the selected item keys and revisions.
3. Attempt a second claim and verify the first batch's items are absent.
4. Advance past lease expiry and verify those items become claimable again.
5. Inspect `/stats` and confirm batch counts and oldest age are visible.
6. Confirm no GitHub Actions workflow was dispatched and production behavior is
   unchanged while the feature flag is off.

**Stop/go decision:** merge only if the queue can recover every interrupted batch
without duplicate ownership or lost items. PR 2 does not begin production
integration; failure here leaves the existing publisher untouched.

**Post-merge verification:** passed.

- The deployed `main` tree at `c074a99c0b18848be7a7d8f80f0fa57b7875b129`
  matched the reviewed PR tree.
- The isolated test queue passed all 13 focused ownership-protocol tests,
  including atomic multi-item selection, competing-claim exclusion, lease
  expiry and reclaim with a new fencing generation, stale-revision
  terminalization, atomic completion, bounded cleanup, migration compatibility,
  pause-gate behavior, and internal-route authentication.
- The live dashboard Worker deployment and smoke test passed in
  [Actions run 29802010864](https://github.com/openclaw/clawsweeper/actions/runs/29802010864).
- The post-merge `main` CI passed, including the full `pnpm check`, in
  [Actions run 29802010889](https://github.com/openclaw/clawsweeper/actions/runs/29802010889).
- Both CodeQL analyses passed in
  [Actions run 29802010883](https://github.com/openclaw/clawsweeper/actions/runs/29802010883).
- The deployed `/api/exact-review-queue` response reported storage schema v1,
  exposed batch counts and oldest-age fields, and reported `enabled: false`,
  `leased: 0`, and `active_items: 0`.
- No batch workflow was dispatched and no production queue item was claimed for
  validation. The legacy publication lane remained active while the flag was
  off.

**Recorded decision:** go for PR 2. This authorizes development and proof of the
bounded multi-item Git primitive only; it does not authorize PR 3 integration or
PR 4 production rollout.

### PR 2: bounded multi-item Git commit primitive

**Delivery status:** complete and landed on 2026-07-21 via
[`openclaw/clawsweeper#740`](https://github.com/openclaw/clawsweeper/pull/740),
with the CI-fixture stabilization in
[`openclaw/clawsweeper#742`](https://github.com/openclaw/clawsweeper/pull/742).
Correctness and local-container realistic-tree performance proof passed.

**Purpose:** prove that several independently validated item mutations can be
applied to the latest remote state tree and published in one commit without
losing remote sibling paths.

**Estimated scope:** large and correctness-sensitive. This is expected to be the
largest implementation pull request.

- Introduce a per-item state-mutation plan that contains bounded path operations
  but does not push Git.
- Add a batch committer with one state lease acquisition, one commit, and one
  push.
- Prepare item mutations outside the state lease.
- Re-read the latest remote tree under the lease and apply the prepared bounded
  changes there.
- Renew and fence the existing lease as needed.
- Include a stable batch identifier in the commit metadata for ambiguous-result
  recovery.
- Add focused bare-Git and Crabbox proofs.
- Do not connect this primitive to the production dispatcher yet.

The primitive must preserve arbitrary remote siblings and reject overlapping
mutations whose tuple ordering cannot be proven. It must not restore generic
full-history hydration or full-worktree reset behavior on the exact hot path.

**Automated proof:**

- batch sizes 1, 2, 4, and 8 produce exactly one state commit each;
- every selected item tuple is present after the push;
- unrelated remote sibling updates survive;
- same-path incompatible mutations fail before push;
- an ordinary writer advancing the remote head during preparation is preserved;
- a process crash before push leaves no partial remote state;
- push success followed by local acknowledgement failure is detected from the
  remote batch identity rather than pushed again blindly;
- batch size 1 remains semantically compatible with the existing path;
- Git subprocess count and lease-hold time are measured.

**Maintainer manual verification:**

1. Inspect a real bare-Git proof containing, for example, eight different item
   paths plus a concurrently written sibling path.
2. Verify the remote history gains one commit rather than eight.
3. Inspect that commit and verify all eight expected paths and the unrelated
   sibling are present.
4. Compare batch sizes 1, 2, 4, and 8 in the proof report.
5. Confirm the projected p95 throughput meets the go/no-go threshold below.
6. Confirm this PR has no workflow or production configuration change.

**Stop/go decision:** proceed only if batching improves projected state
throughput materially. If batch duration grows approximately linearly with item
count, stop and reconsider the database or sharding architecture rather than
wiring an ineffective batch path into production.

**Post-merge verification:** correctness passed; performance gate pending.

- The reviewed PR 2 tree matched the landed `main` tree. The implementation
  prepares bounded per-item mutations outside the lease and performs one leased
  commit and atomic push for each batch without production dispatcher or
  workflow integration.
- The focused bare-Git suite passed all 19 tests. It covers batch sizes 1, 2, 4,
  and 8; tuple materialization; sibling preservation; pre-push overlap and
  compare-and-swap rejection; crash-before-push behavior; durable ambiguous-push
  recovery; literal paths and modes; SHA-1 and SHA-256 repositories; and
  batch-size-one idempotent binding.
- The final post-fix CI passed 1,436 of 1,437 tests with zero failures and one
  skip in the full `pnpm check` job. The PR 2 test initially exposed a Git 2.54
  object-maintenance race in its 300-worktree-commit fixture; PR 742 replaced
  that fixture with an equivalent 300-deep `git commit-tree` chain, after which
  the full job passed.
- Three CI proof samples used 24 Git subprocesses per batch. Across batch sizes
  1, 2, 4, and 8, measured lease hold was 80–92 ms. The slowest observed total
  durations were 1.093 s, 0.644 s, 0.977 s, and 0.725 s respectively.
- Those timings came from small synthetic bare repositories. They are useful
  regression evidence but are not the required realistic-state-repository p95
  benchmark and must not be used as the production go/no-go decision.
- The final proof used Crabbox provider `local-container`, lease
  `cbx_32488263d3cf`, Ubuntu 26.04, Node 24.15.0, and 20 samples for each batch
  size. No remote Crabbox, AWS, or Testbox provider was used.
- The structural fixture was derived from real state snapshot
  `34dabd7915c124c1b5852274a6a0b7e82225bb5e` and retained all 385,840 path
  names. To fit the isolated local-container transfer, file payloads shared one
  small blob; the derived fixture head was
  `15fb20fc3008c67e80ecd82d28fd4e72cab5adcd`. This preserves the tree/index
  shape that dominates this path while intentionally not claiming a large-blob
  transport benchmark.

| Batch size | Total p50 | Total p95 | Acquire p95 | Hold p95 | Tree p95 | Push p95 | Paths / bytes p95 | Git processes p95 | Projected items/hour |
| ---------- | --------- | --------- | ----------- | -------- | -------- | -------- | ----------------- | ----------------- | -------------------- |
| 1          | 2.102 s   | 2.214 s   | 56 ms       | 2.134 s  | 1.746 s  | 279 ms   | 1 / 1,280         | 24                | 1,626.0              |
| 2          | 2.111 s   | 2.185 s   | 63 ms       | 2.098 s  | 1.703 s  | 291 ms   | 2 / 2,560         | 24                | 3,295.2              |
| 4          | 2.146 s   | 2.200 s   | 69 ms       | 2.106 s  | 1.687 s  | 302 ms   | 4 / 5,120         | 24                | 6,545.5              |
| 8          | 2.166 s   | 2.248 s   | 73 ms       | 2.147 s  | 1.727 s  | 313 ms   | 8 / 10,240        | 24                | 12,811.4             |

The size-2 candidate exceeds the 203 items/hour gate by more than 16 times,
while p95 duration is effectively flat across sizes. The performance decision
is **go for the initial size-2 rollout**; larger sizes still require the live
observation gates below.

This local-container proof measures the state-tree/index/commit shape, not a
production GitHub upload. At size 2 the 203 items/hour threshold permits a
35.47-second p95 batch, leaving 33.28 seconds above the measured 2.185-second
p95 for transport and environment overhead. That margin authorizes only the
initial live size-2 measurement: the first two post-enable samples and the
immediate rollback rules below remain mandatory. It is not evidence for a
larger batch size or for ignoring slower live measurements.

The checked-in harness measures proof behavior; it does not issue a trusted
rollout authorization. Its default full-proof contract requires `--mode all`,
at least 20 samples per batch size, at least 300,000 source paths, and a threshold
of at least 203 items/hour. Partial modes and weaker parameters require
`--diagnostic`. Reports record the observed provider/id and whether the source
matches head `15fb20fc3008c67e80ecd82d28fd4e72cab5adcd` with exactly 385,840
paths, but those process inputs are evidence rather than security attestation.
The go/no-go decision above uses the Crabbox wrapper's actual provider/id output,
the recorded fixture construction, the measurement table, and maintainer review
together; a harness `passed` value alone cannot satisfy the rollout gate.

**Recorded decision (updated 2026-07-21):** the PR 2 performance gate is
complete. PR 3 remained default-off until its equivalent synthetic end-to-end
proof also completed on the PR 4 branch.

### PR 3: end-to-end batch publisher, default off

**Delivery status:** merged on 2026-07-21 as
[`openclaw/clawsweeper#746`](https://github.com/openclaw/clawsweeper/pull/746)
at `8b5bbf8678b88f172340f1108d1bccdeed366618`; default off and not authorized
for production rollout.

**Purpose:** connect the proven queue protocol and Git primitive through one
dedicated workflow while preserving per-item GitHub and queue outcomes.

**Estimated scope:** medium-to-large, with workflow and failure-classification
risk.

- A dedicated batch publication workflow or narrow reusable workflow instead of
  adding another large branch to the existing exact-review job.
- A batch publisher entry point with one responsibility: consume one leased
  batch and report its item outcomes.
- Artifact retrieval and per-item preflight.
- Existing idempotent GitHub comment, label, and safe-apply behavior retained per
  item.
- One invocation of the PR 2 committer for all eligible state mutations.
- Per-item completion back to SQLite only after the required GitHub effects and
  state materialization reach a terminal outcome.
- Feature flag still defaulted off.

One invalid item must not poison the batch:

- stale or remote-terminal items complete as superseded;
- an invalid or unavailable artifact is isolated to that item;
- a per-item GitHub failure retries only that item;
- a shared Git infrastructure failure may retry all otherwise eligible batch
  members using the same stable batch identity;
- an ambiguous shared push is reconciled before another push is attempted.

The workflow must expose GitHub-visible delivery separately from durable state
materialization. The CSW-049 handoff proved that a review comment can be visible
even though the workflow later fails durable state publication.

**Automated proof:**

- signed dispatch, claim, heartbeat, completion, lease expiry, and reclaim;
- missing artifact isolation;
- mixed published/superseded/retryable outcomes in one batch;
- GitHub side effect completed before a failed state push;
- state push completed before an acknowledgement timeout;
- no duplicate queue completion after workflow rerun;
- a poison item does not prevent healthy siblings from materializing;
- workflow source and action permissions remain narrowly scoped.

**Maintainer manual verification:**

1. Run the workflow against a non-production or synthetic target with batching
   explicitly enabled for that proof only.
2. Inspect one Actions run representing several queue items.
3. Verify one resulting state commit contains all successful item paths.
4. Verify each target has the expected comment/labels and each SQLite item has
   its own correct terminal outcome.
5. Inject or select one deliberately superseded/invalid fixture and confirm the
   other items still complete.
6. Disable the proof flag and verify items return to legacy consumption without
   data conversion.

**Stop/go decision:** do not enable production batching unless end-to-end proof
shows that GitHub-visible and durable outcomes remain independently observable
and recoverable.

**Local implementation proof:** passed.

- A dedicated serial workflow is gated by
  `EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED`; manual dispatch additionally
  requires an explicit `execute` input. No live flag was changed.
- Signed claim, fetch, heartbeat, and completion calls use the durable PR 1
  ownership protocol. Heartbeats extend only the active fenced owner lease.
- Per-item artifact validation and GitHub effects run sequentially and produce
  bounded PR 2 mutation plans without pushing. Missing, invalid, and failed
  items retain queue ownership for retry without blocking healthy sibling plans.
- Healthy plans enter one PR 2 committer invocation. Durable queue completion
  happens only after the shared state receipt and required deferred verdict
  handoff are available; an acknowledgement timeout reuses the same stable
  batch identity.
- Batch admission is target-owner homogeneous so the workflow can use one
  least-privilege GitHub App installation token without broadening repository
  access.
- Focused local tests cover mixed published/superseded/retryable outcomes,
  poison-item isolation, shared commit failure, heartbeat fencing, stable-id
  acknowledgement recovery, signed queue requests, owner-scoped admission, and
  workflow permission/default-off invariants.
- The full `pnpm run check` completed with exit code 0 on Node 24 and Git
  2.54.0, including both test suites, changed/full coverage gates, and the
  454-file formatting check. Git 2.43.7 had rejected the test-only global
  `--no-lazy-fetch` option; rerunning with an isolated Git 2.54.0 installation
  made both affected unavailable-object recovery tests pass without changing
  the system Git installation.
- After rebasing onto the latest `main`, the full check passed again with 1,438
  unit tests and 1,052 repair tests passing, zero failures, and the 466-file
  formatting check clean. All 11 PR checks passed, including CodeQL, containment
  smoke, sparse build, Windows launcher, automerge E2E, and `pnpm check`.

**Equivalent synthetic maintainer proof:** passed in Crabbox local-container
`cbx_32488263d3cf` without using the production queue.

1. An isolated in-process queue, GitHub-effect journal, and temporary bare Git
   remote supplied the non-production target.
2. One coordinator run represented four queue items.
3. The two healthy items produced one state commit and preserved an unrelated
   sibling path.
4. Both healthy items recorded their expected review comment and label effects
   and completed independently as published.
5. One invalid item remained retryable and one stale item completed as
   superseded without blocking the healthy items.
6. Disabling batching prevented another batch claim and returned the retryable
   item to legacy-ready consumption.

This satisfies the plan's explicitly allowed equivalent-synthetic path while
avoiding production data. The PR 3 decision is **go for PR 4 size 2**.

### PR 4: production rollout configuration

**Delivery status:** implementation and entry-gate proof complete on the PR 4
branch; initial size-2 production rollout authorized.

**Purpose:** make the production behavior change explicit, small, and easily
revertible after the implementation is already reviewed and deployed inertly.

**Estimated scope:** small code/configuration diff, high operational impact.

- Enable exactly one batch publisher.
- Start with a maximum batch size of 2.
- Use a 60-second maximum wait.
- Stop creating new legacy per-item publication workflows once batch claiming is
  enabled; already-running legacy workflows drain naturally and are not
  cancelled.
- Keep all existing tuple, lease, apply, and close guards.
- Expose the active batching configuration in queue status.

This pull request exists separately because an implementation rollback and a
production-behavior rollback are different decisions. A maintainer must be able
to inspect all inert implementation proof before approving the one configuration
change that affects live publication.

**Entry gates before PR 4 may merge or enable batching:**

1. Complete the missing PR 2 Crabbox and realistic-repository p95 proof.
2. Provide an isolated non-production queue or equivalent synthetic target.
3. Complete and record all six PR 3 maintainer verification steps before the PR
   4 configuration change lands.
4. Re-evaluate the throughput and safety evidence and record an explicit go/no-go
   decision.

All four entry gates passed on 2026-07-21. The proof used an isolated synthetic
queue and local temporary Git remotes; no production queue item was consumed.
The explicit decision is **go** for one publisher, batch size 2, and 60-second
maximum wait. This does not authorize size 4 or 8 before live observation.

**Maintainer manual verification:**

1. Record a pre-enable queue snapshot and deployed version.
2. Confirm exactly one batch workflow is active and no new legacy per-item
   publication workflows are being admitted.
3. Verify the first live batch at size 2 from queue claim through Git commit,
   per-item queue completion, and target GitHub state.
4. Observe two complete five-minute samples before increasing the batch size.
5. Increase only through explicit configuration changes: 2, then 4, then 8.
6. At every size, inspect at least one state commit and its target items.
7. Revert immediately on lost paths, duplicate GitHub mutations, ambiguous
   completion that cannot reconcile, growing post-batch state contention, or a
   new safety-guard regression.

**Stop/go decision:** batch-size increases are operational decisions, not
automatic adaptive behavior in the first version.

## Batch departure policy

Use a simple event-driven bus policy:

```text
initial maximum items: 2 (future explicit ceilings: 4, then 8)
maximum wait after the first eligible item: 60 seconds
successful dispatch cooldown: 30 seconds (240 items/hour size-2 ceiling)
failed dispatch retry: 60 seconds
accepted-dispatch reservation before claim: 10 minutes (cleared immediately on claim)
active batch writers: 1
```

- Dispatch immediately when the item cap is reached.
- Dispatch the partial batch when the oldest selected item reaches the maximum
  wait.
- When a writer completes and enough ready work already exists, dispatch the
  next full batch immediately without another wait.
- When the queue is sparse, dispatch even one item at the maximum wait so low
  traffic cannot starve.
- Do not use a wall-clock cron as the primary trigger; the timer begins when the
  first eligible item is waiting.
- Cap a batch by total changed paths and total payload bytes as well as item
  count. Those limits must be derived from proof measurements rather than chosen
  without evidence.
- Select oldest eligible work first. Backoff items become eligible only at
  `next_attempt_at`.

Keep the first version static. Do not add another adaptive controller until the
fixed policy has stable production measurements.

## Buffer lifecycle and cleanup

SQLite is a durable buffer, not permanent storage for completed publication
payloads.

| State                   | Retained data                                  | Cleanup rule                                               |
| ----------------------- | ---------------------------------------------- | ---------------------------------------------------------- |
| Pending or leased       | Full queue item and artifact reference         | Never prune while active                                   |
| Retryable/backoff       | Full queue item, attempts, next attempt        | Retain until terminal or DLQ                               |
| Published or superseded | Compact receipt, outcome, batch ID, commit SHA | Remove large payload and active membership transactionally |
| Active batch            | Batch membership and lease                     | Reclaim after lease expiry                                 |
| Completed batch         | Compact membership/outcome receipt             | Retain seven days, then bounded prune                      |
| Delivery receipt        | Existing compact idempotency receipt           | Keep the existing seven-day TTL                            |
| Metrics bucket          | Aggregated counters only                       | Keep the existing 48-hour TTL                              |
| Open dead letter        | Full recovery identity and error metadata      | Never delete automatically                                 |
| Resolved dead letter    | Audited resolution metadata                    | Keep the existing 30-day TTL                               |
| GitHub artifact         | Existing artifact bundle                       | Keep the current 90-day retention during initial rollout   |

Terminal completion and payload cleanup must be one SQLite transaction:

```text
verify remote state commit
  -> record per-item terminal outcome
  -> write compact receipt and commit SHA
  -> remove large terminal payload and active batch membership
```

Cleanup must run in bounded batches and expose row count, approximate retained
bytes, oldest cleanup age, and cleanup failures. Artifact retention should not
be shortened in the initial incident repair; it is the fallback evidence for
ambiguous or dead-lettered publication.

## Correctness invariants

The implementation is acceptable only if all of these remain true:

1. A queue item has at most one active owner.
2. A batch has a stable idempotency identity across workflow retries.
3. No queue item is marked published before its required remote state tuple is
   verified.
4. A newer remote tuple always wins over an older batch member.
5. Remote sibling files that are not part of the batch are preserved.
6. GitHub writes retain their existing per-item business idempotency identity.
7. Partial GitHub delivery is recorded separately from state materialization.
8. One deterministic poison item cannot repeatedly fail healthy batch siblings.
9. An unresolved or ambiguous push never causes a blind second push.
10. Open dead letters remain open until an authorized, evidence-backed recovery
    decision is made.

## Performance go/no-go gate

Measure batch sizes 1, 2, 4, and 8 against a realistic state repository in the
same proof environment. Record:

- total batch duration;
- state lease acquisition and hold duration;
- Git subprocess count by operation;
- fetch, tree construction, commit, push, and verification duration;
- paths and bytes changed;
- items materialized per commit;
- projected useful items per hour.

Use:

```text
projected throughput = 3600 * batch size / p95 batch seconds
```

The first production candidate must project at least 1.5 times the recent peak
arrival rate. With a reviewed arrival baseline of approximately 135 items/hour,
the minimum projected service rate is approximately 203 items/hour. This is a
go/no-go gate, not a promise that production will exactly match the proof.

If the proof cannot meet that threshold without excessive lease hold, memory,
paths, or payload size, stop the narrow batching plan and return to the broader
state-database or sharding design decision.

## Rollout and recovery gates

Deploy additive schema and implementation with batching disabled first. Do not
use a dead-letter replay as the first behavior proof.

For every enabled batch size, require two consecutive fully post-enable samples
showing:

- pending decreases;
- total outstanding (`pending + dispatching + leased`) decreases;
- useful `published + superseded` meets or exceeds arrivals;
- retry amplification declines materially;
- post-batch `state_contention` does not increase;
- oldest pending age begins falling;
- multiple target items are live-verified;
- one state commit contains multiple intended item mutations;
- no dead-letter disposal is being mistaken for successful delivery.

After the writer path is stable, dead-letter recovery is a separate authorized
operation. Start with one representative item, then batches of at most two when
GitHub pressure matters. Stop on the first repeated deterministic failure, new
rate-limit signal, or unexplained health regression.

## Rollback

The production switch must support both:

```text
batching enabled = false
```

and a compatibility mode:

```text
maximum batch items = 1
```

On rollback:

1. stop creating new batch claims;
2. allow an active batch to finish or its lease to expire;
3. return unfinished members to the existing ready state;
4. let the legacy per-item publisher consume those unchanged queue items;
5. retain additive batch tables and receipts for diagnosis;
6. do not reset the queue or rewrite state history.

Because existing queue items are not transformed into another storage model,
rollback requires no data migration.

## Completion criteria

This incident repair is complete when:

- exact-result publication uses one active batch writer rather than dozens of
  workflows waiting for the same state lease;
- sustained useful throughput remains above arrival rate with measured
  headroom;
- the backlog and oldest age decline to their normal operating ranges;
- state-contention retries and dead letters stop growing;
- batch cleanup keeps SQLite growth bounded;
- every live-enabled pull request has its manual verification evidence recorded;
- the temporary fixed-capacity-50 configuration is removed in a separately
  reviewed cleanup after the backlog is materially cleared;
- open dead letters have an explicit replay, fresh-review, or audited-resolution
  disposition after the writer path is proven stable.

Migration of authoritative operational state into a database remains a possible
long-term architecture. It is not required to validate or roll back this
batching repair.
