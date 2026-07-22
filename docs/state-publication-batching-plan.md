# State publication batching plan

**Status (verified 2026-07-22 at 01:13 UTC):** PR 1 through PR 4, the rollout
hotfix, the repository-wide FIFO state-writer coordinator, the fence identity
hotfix, and the shared `publishMainCommit` identity follow-up are merged.
Production remains fixed at batch size 2 and a 60-second maximum wait. Three
live size-2 publishers have each produced one
two-member generated-state commit and accepted both acknowledgements, beginning
with [run 29865701885](https://github.com/openclaw/clawsweeper/actions/runs/29865701885)
and state commit
[`49777f30`](https://github.com/openclaw/clawsweeper-state/commit/49777f30284d01fb2255c763cc3b8e5668b9709a).
The formal size-2 gate is still incomplete: dashboard state-writer telemetry is
stale and reports `mode=unknown`, the required two five-minute samples have not
passed, and current publication throughput is below arrivals. Batch failure
terminalization landed in maintainer-owned
[`openclaw/clawsweeper#764`](https://github.com/openclaw/clawsweeper/pull/764),
and fresh batch writer telemetry is proposed in PR 766.
The final rollout target is batch size 8, reached only by explicit reviewed
`2 -> 4 -> 8` changes with a fresh live proof and two passing samples at each
size.
**Incident:** CSW-049
**Decision scope:** replace normal contention on the single generated-`state`
publication lease with one recoverable, repository-wide serialization boundary,
without migrating authoritative state to a new database or changing the
generated state layout.

## Delivery status

| Stage                                         | Status                                         | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| State writer observability prerequisite       | Complete                                       | Merged before batching ownership as [`openclaw/clawsweeper#735`](https://github.com/openclaw/clawsweeper/pull/735).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| PR 1: durable batch ownership protocol        | Complete                                       | Merged as [`openclaw/clawsweeper#734`](https://github.com/openclaw/clawsweeper/pull/734) at `c074a99c0b18848be7a7d8f80f0fa57b7875b129`; post-merge proof is recorded below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| PR 2: bounded multi-item Git commit primitive | Complete                                       | Merged as [`openclaw/clawsweeper#740`](https://github.com/openclaw/clawsweeper/pull/740) at `a04c4c4cfbd29be9d6bf5036c824481b31d2233d`; stabilization followed in [`openclaw/clawsweeper#742`](https://github.com/openclaw/clawsweeper/pull/742). Local-container p95 proof against a 385,840-path structural fixture passed at 3,295.2 projected items/hour for size 2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| PR 3: end-to-end batch publisher              | Complete; merged default off                   | Merged as [`openclaw/clawsweeper#746`](https://github.com/openclaw/clawsweeper/pull/746) at `8b5bbf8678b88f172340f1108d1bccdeed366618`. The equivalent synthetic maintainer proof verified one commit for two healthy items, isolated retryable and superseded items, per-item GitHub effects, and disabled fallback.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| PR 4: production rollout configuration        | Complete; landed                               | Landed as [`openclaw/clawsweeper#752`](https://github.com/openclaw/clawsweeper/pull/752). It enabled one event-driven batch publisher at size 2 and a 60-second maximum wait, blocked new legacy admission while enabled, preserved in-flight legacy work, and exposed active configuration plus last dispatch outcome.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Rollout hotfix                                | Complete; landed                               | Landed as [`openclaw/clawsweeper#753`](https://github.com/openclaw/clawsweeper/pull/753). The deployed dashboard config remains `EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED=1`, `EXACT_REVIEW_PUBLICATION_BATCH_SIZE=2`, and `EXACT_REVIEW_PUBLICATION_BATCH_WAIT_MS=60000`; the workflow independently caps `EXACT_REVIEW_BATCH_MAX_ITEMS=2`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Repository-wide state-writer serialization    | Landed; behavior proven, capacity gate blocked | Landed as [`openclaw/clawsweeper#756`](https://github.com/openclaw/clawsweeper/pull/756) at `f422cbdd10b1ea42c9bd79d25c229e4d9fb07d79`; the dashboard deployment and smoke passed, coordinator admission is effective, and pre-cutover publishers drained. After the fence identity hotfix, [run 29865701885](https://github.com/openclaw/clawsweeper/actions/runs/29865701885) acquired FIFO ticket 183, published two materialized members in state commit [`49777f30`](https://github.com/openclaw/clawsweeper-state/commit/49777f30284d01fb2255c763cc3b8e5668b9709a), and accepted both acknowledgements. Runs [29873949047](https://github.com/openclaw/clawsweeper/actions/runs/29873949047) and [29876112204](https://github.com/openclaw/clawsweeper/actions/runs/29876112204) repeated that result in commits [`f5ca2429`](https://github.com/openclaw/clawsweeper-state/commit/f5ca24292ba365f5270cfd39030759d5309911e8) and [`089c5c5b`](https://github.com/openclaw/clawsweeper-state/commit/089c5c5b59a1c329e0d1f6a9dea090210caab6be). The formal gate remains blocked by stale `state_writer` telemetry and failed throughput/backlog sample criteria. |
| Fence identity hotfix                         | Complete; landed                               | Landed as [`openclaw/clawsweeper#759`](https://github.com/openclaw/clawsweeper/pull/759) at `09b3c2ba2959146e4a3960439c9450d10f122d67`. `createStatePublishLeaseCommit` now passes `clawsweeperGitIdentityEnv()` inline to `git commit-tree`, so fence acquire, renewal, stale-owner recovery, and cleanup do not depend on preconfigured repo/global `user.identity`. Data commits retain their existing authorship via `configureGitUser`. The regression test `fence commits do not require a preconfigured Git identity` proves both an ordinary coordinator writer and a batch coordinator writer create and renew their fence from a checkout with no preconfigured Git identity. Full `pnpm run check` passed in local Docker container `docker.io/masonxhuang/codex-node24-ci:20260721` (Node v24.18.0, Git 2.47.3, pnpm 11.10.0) with 8 GiB memory/swap, 1024 PIDs, 4 CPUs, and init.                                                                                                                                                                                                                                                                       |
| Shared `publishMainCommit` identity follow-up | Complete; landed after PR 761                  | Landed as [`openclaw/clawsweeper#758`](https://github.com/openclaw/clawsweeper/pull/758) at `fef846a851e2a5fbcfe114721b5c779b0ded53a2`, after the evidence-only documentation PR 761. It calls `configureGitUser()` at the shared commit-producing `publishMainCommit` entry so ordinary repair/apply publication paths do not depend on caller identity setup. The upstream `pnpm check` passed in [run 29858459637](https://github.com/openclaw/clawsweeper/actions/runs/29858459637). This complements, rather than replaces, PR 759's inline identity at the lower-level fence `commit-tree` boundary.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Fence hotfix evidence documentation           | Complete; landed                               | Landed as [`openclaw/clawsweeper#761`](https://github.com/openclaw/clawsweeper/pull/761) at `ac16e73dc3b18893e9c0edee38a054cb7b78ba6c`, recording PR 759, its regression proof, and CI evidence. This plan update incorporates the subsequently merged PR 758 and later live rollout evidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Batch failure terminalization                 | Complete; landed                               | Landed as [`openclaw/clawsweeper#764`](https://github.com/openclaw/clawsweeper/pull/764) at `b657a55bb6e4499825a9adffecb44e32cd0e9ed5`, superseding the narrower external [`openclaw/clawsweeper#760`](https://github.com/openclaw/clawsweeper/pull/760). It adds fenced retryable/refresh/permanent outcomes, receipt-aware cancellation recovery, newer-revision preservation, and manifest-based cleanup so a failed or cancelled publisher does not retain both members until lease expiry. Upstream `pnpm check` passed in [run 29881719295](https://github.com/openclaw/clawsweeper/actions/runs/29881719295); CodeQL, Windows, sparse build, and automerge E2E also passed. Live controlled failure-path verification remains required before size 4.                                                                                                                                                                                                                                                                                                                                                                                                         |
| Batch writer telemetry restoration            | Draft PR 766                                   | Proposed in [`openclaw/clawsweeper#766`](https://github.com/openclaw/clawsweeper/pull/766). The batch committer owns one `mode=batch` telemetry recorder for the shared coordinator/Git operation. Authenticated batch heartbeats carry fresh waiting/holding/releasing progress, and the durable batch receipt carries the idempotent terminal operation into completion or cancellation cleanup. The terminal payload records configured and actual size, oldest selected-item wait, coordinator/Git wait and hold, process count, commit count, and materialized members. Queue-side batch fences validate progress identity before accepting it. Thirty-five focused queue, workflow, batch-client, and telemetry tests and the full Node 24 / Git 2.47.3 `pnpm run check` pass.                                                                                                                                                                                                                                                                                                                                                                                 |

## Production incident and root cause

The first real size-2 batch was
[Actions run 29832766649](https://github.com/openclaw/clawsweeper/actions/runs/29832766649).
It claimed `openclaw/openclaw#111587` and `openclaw/openclaw#89526`, created both
required GitHub App tokens, checked out the state repository, and prepared both
members independently. Finalization began at `2026-07-21T13:08:30Z`. At
`13:15:16Z` it observed lease owner
`4b08fdfb-9115-4a73-88bb-84cfb187df9c` with 58,711 ms remaining, then failed at
`13:16:52Z` with:

```text
StatePublishContentionError:
Failed to acquire the state state publish lease within 480000ms
```

No batch commit or per-item acknowledgement occurred. The generated `state`
branch did not advance while that owner blocked the batch: the adjacent commits
were [`f1c223bf`](https://github.com/openclaw/clawsweeper-state/commit/f1c223bf144612879390f9fe5461f8726a046134)
at `12:58:03Z` and
[`7cdaa155`](https://github.com/openclaw/clawsweeper-state/commit/7cdaa155eed65e0578a2d9ce92297e6a7929ff75)
at `13:19:45Z`, both comment-router commits. Observations at `13:14:57.995Z`
with 77,005 ms remaining and `13:15:26.150Z` with 48,850 ms remaining place the
owner's last creation or renewal at approximately `13:14:15Z`; it was not
renewed again. The ref was absent in a later probe, but the retained evidence
cannot distinguish expiry cleanup from a late clean release.

That first owner cannot be attributed to one workflow with the evidence the old
lease preserved. Its commit payload recorded only `owner`, `branch`, `ttl_ms`,
and `generation`, not repository, workflow, job, run ID, or run attempt. The
state-writer telemetry had been stale since `12:12:42Z` and reported
`mode=unknown`; organization audit-log access required `admin:org` and returned
403; and the related workflow logs contain observations of the owner but no
matching acquire, renew, or release line. The evidence is consistent with an
orphaned or stalled owner, but it proves neither which writer created it nor
whether expiry or a late release removed it.

The failure is nevertheless not explained by one stale owner. A subsequent
size-2 attempt,
[Actions run 29835994320](https://github.com/openclaw/clawsweeper/actions/runs/29835994320),
entered finalization at `13:50:44Z` and again waited the full 480 seconds before
failing at `13:58:59Z`. During that one wait it observed at least five successive
lease owners: `c0fd3605...` at `13:51:21Z`, `f7bad6fe...` at
`13:54:21Z`, `6a6a7cce...` at `13:55:11Z` and `13:55:19Z`, `59219ce5...` at
`13:57:09Z`, and `e19492ac...` at `13:58:36Z`. The only generated-state commit
in the same late interval was the materializer commit
[`b1a37bb1`](https://github.com/openclaw/clawsweeper-state/commit/b1a37bb1b92a0d188cd891f56bbffb6bb3a33a81)
at `13:58:53Z`; its
[materializer run 29836735366](https://github.com/openclaw/clawsweeper/actions/runs/29836735366)
entered mutation at `13:58:24Z`. Old lease metadata still prevents mapping the
other owner IDs to runs, but multiple owner generations in one timeout directly
demonstrate repeated handoffs without fair batch progress rather than one stale
lease explaining the full incident.

The interrupted rollout did not later complete implicitly. Although
[run 29833894391](https://github.com/openclaw/clawsweeper/actions/runs/29833894391)
is marked successful, only its claim step ran; token creation, state setup,
prepare, finalize, and completion were all skipped, so it was a no-op rather
than a successful batch. At `13:43:13Z` production still reported
`max_items=2`, `completed=0`, `leased=1`, `active_items=2`, `expired=2`,
`reclaimed_items_retained=4`, `pending=1339`, no resolved items in the prior 15
minutes, and `state_writer.mode=unknown`. A matching-ref query at `13:43:23Z`
returned no lease refs, and the lease ref is also empty after the later failure;
absence of a stale ref does not repair unfair handoff among live writers.

### Batch failure terminalization

Repository-wide writer serialization addresses fair access to the generated
state branch, but a batch must also relinquish its own queue ownership whenever
publication cannot finish. A failed or partially successful workflow must not
leave unfinished members behind until the 30-minute lease expiry, because one
active batch blocks every later batch departure.

Every claimed member therefore reaches one fenced acknowledgement before the
workflow exits:

- `published` or `superseded` removes the matching queue revision; or
- `retryable_failure`, `refresh_required`, or `permanent_failure` terminalizes
  only the matching batch membership and routes the underlying publication item
  through the existing backoff, refresh, and dead-letter policy.

Explicit failure release uses the existing `lease_expired` membership value so
the additive SQLite schema remains migration-free. Revision and
claim-generation fencing still prevent an old worker from releasing newer
ownership. An `always()` workflow cleanup acknowledges any member left
unfinished by cancellation or an unexpected step failure, while lease expiry
remains the final crash fallback rather than the normal recovery path.

The first post-coordinator production batch exposed a second availability
dependency. [Run 29854892938](https://github.com/openclaw/clawsweeper/actions/runs/29854892938)
claimed and prepared two members, then failed almost immediately when the batch
commit command's queue `fetch` returned invalid JSON with HTTP 500. At
`2026-07-21T18:11:00Z`, publication still had 1,729 pending and ready items,
zero resolutions in the prior 60 minutes, one leased batch with two active
members, and 8,020 pending state-append rows. The prior cleanup repeated the
same `fetch`, so it could not release the members during that queue read
failure.

Failure cleanup now sends the revision and claim-generation fences persisted in
the claimed manifest directly to the batch `complete` route. It does not depend
on a fresh queue read. The route applies accepted retryable outcomes through
`finishExactReviewPublicationQueueItem`, while a delayed cleanup that races an
already completed or expired same-fence batch is an idempotent no-op. Wrong
owners and stale generations remain rejected. The `always()` cleanup is also
non-fatal after a successful primary publication, so a transient cleanup
transport error cannot convert a completed publisher into a failed workflow;
an earlier publication failure remains visible as the job's primary failure.

This contract is independent of the coordinator rollout: the coordinator from
#738/#756 makes state-writer admission durable and fair, while batch failure
terminalization keeps the exact-review publication queue live when the admitted
writer, artifact processing, or GitHub effects fail.

### Writer audit

The production evidence and call-site/workflow audit identify these generated
`state` writers:

| Writer class                                                  | Evidence and disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact-review batch publisher                                  | Runs [29832766649](https://github.com/openclaw/clawsweeper/actions/runs/29832766649) and [29835994320](https://github.com/openclaw/clawsweeper/actions/runs/29835994320) each held one active batch but starved as lease waiters. The first prepared two members but committed and acknowledged neither.                                                                                                                                                                                                                                      |
| In-flight legacy exact-review and review-artifact publication | Pre-enable runs [29832129028](https://github.com/openclaw/clawsweeper/actions/runs/29832129028) and [29832129559](https://github.com/openclaw/clawsweeper/actions/runs/29832129559) observed `4b08fdfb...` as busy and also timed out. They were waiters, not that owner, but show that disabling new legacy admission does not remove already-running writers.                                                                                                                                                                               |
| Comment router                                                | [Run 29833036994](https://github.com/openclaw/clawsweeper/actions/runs/29833036994) observed `4b08fdfb...` as busy and timed out. [Run 29833499545](https://github.com/openclaw/clawsweeper/actions/runs/29833499545) did not enter its commit step until `13:16:15Z`, after the first owner's inferred creation, so it cannot be that owner. The adjacent state commits prove this class is a live branch writer.                                                                                                                            |
| Audit, status, and dashboard inputs                           | Audit runs [29833028285](https://github.com/openclaw/clawsweeper/actions/runs/29833028285) and [29833030127](https://github.com/openclaw/clawsweeper/actions/runs/29833030127) were ordinary lease waiters. Their `repair:publish-main` calls publish records, `README.md`, audit JSON, and sweep status; dashboard refresh itself is a downstream dispatch, not the owner of the generated-state push.                                                                                                                                       |
| Action ledger and state materializer                          | Ordinary action-event publishers can append durable rows through the existing queue; `state-materializer.yml` drains them and calls the same Git publication primitive for one state commit. In [run 29833364262](https://github.com/openclaw/clawsweeper/actions/runs/29833364262), materialization began at `13:13:06Z`, made a local commit at `13:13:26Z`, and did not make its first remote atomic branch push until `13:26:00Z`, so it was not the first incident's `13:14:15Z` owner. It remains a member of the normal writer cohort. |
| Repair, fanout, proof, scanner, and apply/status writers      | Generated result files are ultimately committed by `repair:publish-main`; exact event publication uses `repair:publish-event-result`, and both reach `src/repair/git-publish.ts`. Fanout runs [29832830989](https://github.com/openclaw/clawsweeper/actions/runs/29832830989) and [29832953331](https://github.com/openclaw/clawsweeper/actions/runs/29832953331) were waiters. Apply/close guards remain business-level preconditions and are not changed by serialization.                                                                  |
| Other direct state-repository mutation                        | Monthly `state-compaction.yml` directly replaces the separate `main` branch with an atomic remote-HEAD CAS and backup ref. Publication uses the generated `state` branch, so compaction neither uses nor contends for `refs/heads/clawsweeper-publish-lease/state`; it stays outside this branch-specific coordinator boundary. Scratch-ref janitorial deletion is likewise not a generated-`state` publication.                                                                                                                              |

The current Git ref remains necessary for crash fencing, ownership checks, and
atomic branch-plus-fence publication. It is not a fair queue: a waiter has no
durable position, every release starts another random CAS race, priority and
random backoff can reorder writers indefinitely, and a process that misses the
release repeatedly can wait 480 seconds despite multiple successful handoffs.
Longer timeouts, more retries, sleeps, or more aggressive backoff do not increase
the single branch's service rate and cannot provide fairness or attribution.

The ref protocol was introduced by
[`openclaw/clawsweeper#722`](https://github.com/openclaw/clawsweeper/pull/722)
at `4fc1e3c1be` and its default acquisition budget was raised from three to eight
minutes by
[`openclaw/clawsweeper#731`](https://github.com/openclaw/clawsweeper/pull/731)
at `b06b856d4d`. Those changes supplied necessary cross-run exclusion before all
writers shared one admission boundary. They did not, and could not, turn a
last-writer-wins ref CAS race into fair scheduling.

## Decision

Place every normal generated-`state` read-modify-write operation behind one
durable FIFO coordinator. Exact-review batching remains the durable per-item
buffer; the coordinator is a separate admission boundary shared with ordinary
writers:

```text
exact batch / router / audit / status / ledger materializer / repair / apply
                                  |
                                  v
                  create or recover durable FIFO ticket
                                  |
                                  v
                     wait for the single active turn
                                  |
                                  v
             fetch latest remote HEAD and reconcile bounded paths
                                  |
                                  v
            acquire Git ref as crash fence, not normal admission
                                  |
                                  v
          remote-HEAD CAS + atomic branch/fence push + verification
                                  |
                                  v
        release turn; preserve each producer's independent outcome/ack
```

The coordinator's SQLite ticket sequence supplies strict FIFO order, and a
unique partial index permits at most one leased turn. A stable ticket identity
recovers an acquire whose response was lost. The implementation uses a
30-second watchdog heartbeat, a renewable two-minute ownership lease, and a
30-minute absolute deadline so a hung runner cannot own the queue forever.
Expired or crashed owners are reclaimed, terminal receipts are retained for
bounded diagnosis, and status exposes queue depth, active workflow/job/run,
wait time, completions, expirations, and recoveries.

The admitted turn covers the complete read-modify-write operation, not only the
final push. Within that turn the existing Git code still fetches the latest
remote head, preserves unrelated siblings, rejects incompatible same-path
mutations, and uses remote-head CAS. The Git lease ref remains an ownership
fence against a stale in-flight process or an accidental bypass. Coordinator
identity and run metadata are added to future fence commits, and ambiguous fence
or state pushes are recovered by reading the remote ref/commit identity instead
of pushing blindly. Random admission delay and priority-intent competition are
disabled only in coordinator mode.

Git remains the authoritative generated-state store. The existing exact-review
queue remains the durable item/batch buffer, and the coordinator stores only
admission tickets and receipts; neither becomes a second source of truth for
review, apply, or close state.

This is the preferred narrow repair because:

- increasing admission to 50 did not create more real state writers;
- reducing admission to four did not provide enough observed useful throughput;
- increasing the ordinary lease wait from 180 to 480 seconds converted many
  three-minute failures into eight-minute failures without increasing service
  rate;
- fairer lock handoff inside the Git-ref protocol would still provide no durable
  queue position, attribution, or crash-reclaim receipt;
- branch sharding or migration of operational state to a database would be a
  broader architecture and data-migration project;
- the existing SQLite queue already contains the active backlog, item identity,
  revision, artifact reference, lease, retry, and dead-letter state, so batching
  requires no backlog migration.

The pre-implementation baseline reviewed for this plan showed a non-draining
lane: 586 pending, 635 total outstanding, 244 open dead letters, a 60-minute
arrival rate of 135/hour, useful published plus superseded throughput of 39/hour,
and a net drain rate of -77/hour. The two production failures supersede the
earlier size-2 capacity authorization: batching can reduce commits per item, but
it cannot deliver that capacity while the one batch writer has no fair turn
among the other generated-state writers.

## Scope and non-goals

This follow-up changes how every normal mutation is admitted to the generated
`state` branch. It does not merge their business logic: exact-review batching,
comment routing, audit/status, action-ledger materialization, repair, and apply
retain their own inputs, validation, commit content, outcomes, and
acknowledgements.

It does not:

- migrate historical state or ledgers into SQLite;
- make SQLite authoritative for review or apply records;
- shard the `state` branch or create per-item Git refs;
- change the flat `records/<repo-slug>/items/` and `closed/` layouts;
- weaken tuple, source-drift, protected-item, apply, or safe-close guards;
- automatically replay, resolve, or delete open dead letters;
- pause the live sweep workflow;
- cancel already-running publication workflows;
- route the separate `main` history-compaction branch or scratch-ref janitor
  through the generated-`state` coordinator;
- partially enable coordinator admission while a normal generated-`state`
  writer is known to bypass it.

Read-only checkout, hydration, queue preparation, and target-GitHub work stay
outside the turn. Every actual generated-`state` mutation must enter the same
boundary before coordinator mode is considered enabled.

### Coordinator configuration and credential scope

The migration/rollback variable is
`CLAWSWEEPER_STATE_COORDINATOR_ENABLED`; production currently sets it to `1`.
The endpoint comes from `CLAWSWEEPER_EXACT_REVIEW_QUEUE_URL`, with the current
production URL as its default. Enabling coordinator mode without a valid URL or
credential fails closed before Git mutation.

Coordinator requests use the existing HMAC-authenticated internal endpoint. The
client accepts `CLAWSWEEPER_STATE_COORDINATOR_SECRET` or the existing
`CLAWSWEEPER_WEBHOOK_SECRET`. The setup action exports only the gate and URL to
`GITHUB_ENV`; it never receives or exports the credential. Ordinary workflows
inject the existing secret only into trusted mutation steps, so Codex and
foreign-branch validation steps do not inherit it. The exact batch job likewise
injects the webhook secret only into its claim, prepare, and finalize steps; it
is no longer job-scoped. No credential is stored in a ticket, fence commit,
state commit, or log; tickets and future fence metadata contain only bounded
identity and workflow/run attribution.

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

**Post-merge verification:** correctness and performance gates passed.

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

**Delivery status:** landed on 2026-07-21 as
[`openclaw/clawsweeper#752`](https://github.com/openclaw/clawsweeper/pull/752),
followed by rollout hotfix
[`openclaw/clawsweeper#753`](https://github.com/openclaw/clawsweeper/pull/753).
The initial size-2 configuration is live, but its end-to-end production gate is
blocked on repository-wide state-writer serialization.

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
automatic adaptive behavior in the first version. The current decision is
**stop at size 2**: neither failed run counts as the required first successful
live batch, and no change to 4 or 8 is authorized.

## Batch departure policy

Use a simple event-driven bus policy:

```text
current maximum items: 2 (frozen; future explicit gates may consider 4, then 8)
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
fixed policy has stable production measurements. Keep `max_items=2` throughout
the coordinator implementation, pull request, landing, and initial production
verification.

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
11. FIFO sequence, not random CAS timing or priority, selects the next normal
    generated-state writer.
12. At most one coordinator turn is leased; heartbeat expiry or the absolute
    deadline makes work reclaimable after a crash.
13. A stale coordinator generation fails its ownership assertion before lease
    renewal or branch push.
14. Ordinary and batch writers cross the same admission boundary, so a
    successful coordinator rollout has no normal 480-second Git-lease waiters.

## Performance go/no-go gate

Measure batch sizes 1, 2, 4, and 8 against a realistic state repository in the
same local Node 24 container proof environment. Remote Crabbox, Testbox, and
other remote validation providers are prohibited for this follow-up. Record:

- total batch duration;
- durable coordinator queue wait and active-turn duration;
- Git fence acquisition and hold duration inside the admitted turn;
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

The proof must report the actual local container provider/id plus Node and Git
versions. If it cannot meet that threshold without excessive turn/fence hold,
memory, paths, or payload size, stop the narrow batching plan and return to the
broader state-database or sharding design decision.

### Direct local-container proof and OOM guard

The interrupted validation exposed a separate local-container failure before
the final proof could be trusted. Container
`53df12b365b1fcc2646b1f1ba28f5dcbe0246a5782b548fe88209e3f71be2ab4`
had `Memory=0`, `MemorySwap=0`, `PidsLimit=null`, `NanoCpus=0`, no init reaper,
and no restart policy. It reached 53.2 GiB, approximately 22,900 processes and
626 OOM kills before being stopped. The intended environment limits had never
been translated into Docker `HostConfig` cgroup values, so they provided no
enforcement.

The workload trigger was also identified. The proof first created a blobless
bare clone from the 385,840-path, 3.6 GiB state object store and then made an
unfiltered local work clone from that partial origin. Git lazy-fetch/hydration
fanned out across the live object store. An earlier interrupted unfiltered
mirror clone had stopped its parent without reliably terminating the complete
upload-pack/index-pack tree, and the `sleep infinity` PID 1 could not reap
defunct descendants. This was a validation-harness failure, not evidence about
coordinator capacity.

The proof harness now refuses to create the work clone when a tree has at least
300,000 paths but does not match the reviewed structural fixture head. Local
Docker validation also runs with explicit `memory=8g`, `memory-swap=8g`,
`pids-limit=1024`, `cpus=4`, and `--init`; the operator environment applies the
same defaults to direct `docker run/create` calls. Compose or an explicit system
Docker path remains outside that wrapper and must declare equivalent limits.

The successful proof used direct local Docker Engine 27.3.1, not Crabbox or
Testbox. The disposable proof container was
`00a5b4814a2f40c7089e9c9cc4b498ffd12aee331cc3d90390945f4e65851ab8`
(`node:24-trixie`, Node v24.18.0, Git 2.47.3). The source was the 13 MiB
shared-small-blob structural fixture at
`15fb20fc3008c67e80ecd82d28fd4e72cab5adcd`, retaining all 385,840 path names
from real snapshot `34dabd7915c124c1b5852274a6a0b7e82225bb5e` without hydrating its blobs.
One diagnostic sample per size passed before the full 20-sample run.

| Batch size | Total p50 | Total p95 | Coordinator/fence acquire p95 | Fence hold p95 | Tree p95 | Push p95 | Git processes p95 | Projected items/hour |
| ---------- | --------- | --------- | ----------------------------- | -------------- | -------- | -------- | ----------------- | -------------------- |
| 1          | 2.568 s   | 2.652 s   | 353 ms                        | 2.190 s        | 1.769 s  | 223 ms   | 23                | 1,357.5              |
| 2          | 2.577 s   | 2.676 s   | 364 ms                        | 2.217 s        | 1.777 s  | 234 ms   | 23                | 2,690.6              |
| 4          | 2.594 s   | 2.677 s   | 371 ms                        | 2.194 s        | 1.750 s  | 243 ms   | 23                | 5,379.2              |
| 8          | 2.617 s   | 2.693 s   | 376 ms                        | 2.213 s        | 1.757 s  | 256 ms   | 23                | 10,694.4             |

All 85 durable tickets across the diagnostic, synthetic end-to-end, and full
performance runs acquired and released in order without a queued contention
wait. The synthetic proof retained its unrelated sibling and committed the two
publishable members once, with independent `published`, `published`, and
`superseded` acknowledgements.

The bounded run also found and fixed a detached-helper lifecycle defect before
delivery: successful coordinator and Git-fence release closed stdin but could
leave the crash-recovery process alive for the rest of a long runner. The first
bounded attempt reached 482 cgroup PIDs and retained many historical helpers,
so it was stopped and not counted as proof. Successful release now terminates
the helper immediately; failed or ambiguous release still sends EOF so the
helper gets its final recovery attempt. In the repeated full proof, only the two
helpers for the current turn were present and completed helpers did not
accumulate. The cgroup limits prevented this newly discovered defect from
becoming another host OOM during diagnosis.

These measurements authorize code delivery and a new size-2 live proof only.
They do not authorize size 4 or size 8.

## Coordinator migration

Migration is additive and fail-closed:

1. Land the coordinator tables, internal HMAC routes, telemetry, Git-fence
   attribution, and workflow wiring with
   `CLAWSWEEPER_STATE_COORDINATOR_ENABLED` absent or false.
2. Audit every `withStatePublishLease`, `acquireStatePublishLease`,
   `publishMainCommit`, `publish-event-result`, materializer, and workflow call
   site again against the merged tree. A generated-`state` mutation without the
   shared boundary blocks enablement.
3. Run focused coordinator/Git/batch tests, the complete `pnpm run check`, and a
   realistic local state-repository performance proof in a Node 24 container.
4. Run autoreview and require a clean result before opening the pull request;
   then require all pull-request checks to pass before landing.
5. Verify the merged `main` tree and dashboard deployment before creating the
   repository variable. Keep batching enabled at size 2 throughout.
6. Enable the coordinator once for all newly started publisher jobs. Do not
   cancel live workflows. Wait for every pre-cutover, publish-capable run that
   lacks coordinator wiring to finish naturally or expire before declaring the
   system coordinator-only. During this overlap, the Git ref remains the safety
   fence against a bypass.
7. Verify coordinator status shows one active turn at most, FIFO progress,
   attributable workflow/job/run metadata, bounded wait, and no growing normal
   Git-lease contention.

The enablement is not a partial per-workflow rollout. Schema and routes may be
deployed inertly, but once the gate is true every new normal generated-`state`
writer must fail closed if it cannot acquire a ticket. Durable tickets, terminal
receipts, existing exact-review batch ownership, and state history require no
data transformation.

## Rollout and recovery gates

Batch size remains 2. Do not use a dead-letter replay as the first behavior
proof, and do not process or clean the existing DLQ as part of this rollout.

The completed local implementation gates are:

- focused proof for concurrent writer classes, strict FIFO/fairness, crash and
  stale-owner recovery, and stale-generation fencing;
- batch sizes 1, 2, 4, and 8 each producing one commit in the local proof, while
  size 2 remains the only production setting;
- remote sibling preservation and same-path conflict failure before push;
- ordinary writer versus batch writer concurrency;
- ambiguous push and acknowledgement-failure idempotent recovery;
- a direct local Docker performance proof in which all 85 turns acquired their
  durable ticket without a normal 480-second Git-ref competition wait.
- clean local autoreview with zero findings (`patch is correct`, confidence
  0.78).
- the final `pnpm run check` in direct local Docker container
  `e391c253320c958ab768408d77473120a8259b7caa80f00544c42690b4d8cc05`
  with Node v24.18.0, Git 2.47.3, pnpm 11.10.0, 8 GiB memory and memory-swap
  ceilings, 1,024 PIDs, four CPUs, and an init reaper. Build, lint, unit,
  repair, changed/full coverage, and formatting gates exited successfully;
  the container reported no OOM and was removed after completion.
- the reusable local CI image was published as
  `docker.io/masonxhuang/codex-node24-ci:20260721` and `:latest`; both remote
  tags resolve to
  `sha256:3255da7a04566b58ed091478a0a7df003477a60058bc3bdc79c314614ed0787d`
  from local image
  `sha256:50e3cb887b2111488dcd22673b424a9b121ee2fdbc8596e44c69386cdcdede04`.

The merged delivery, cutover, and first live behavior gates are complete. The
remaining live and capacity gates are:

- land, deploy, and verify batch failure terminalization from
  [`openclaw/clawsweeper#764`](https://github.com/openclaw/clawsweeper/pull/764);
- restore fresh state-writer telemetry so it reports coordinator mode and
  attributable commit, wait, and contention metrics through
  [`openclaw/clawsweeper#766`](https://github.com/openclaw/clawsweeper/pull/766);
- record a formal size-2 proof containing the already observed
  single-commit/two-ack behavior together with the missing telemetry and safety
  evidence;
- make writer service rate sufficient for two complete, consecutive five-minute
  samples to pass every gate below;
- promote through separately reviewed size-4 and size-8 configuration changes,
  repeating the live proof and two-sample gate at each size.

After landing and coordinator enablement, the first valid live size-2 proof must
show all of the following in one batch:

- one generated-state commit contains both intended items;
- both queue members reach their correct independent terminal outcome and ack;
- an unrelated sibling present at the fetched remote head is preserved;
- `state_writer` reports coordinator mode and attributable, internally
  consistent metrics;
- remote-head CAS/fence verification succeeds without an ambiguous result;
- Git-lease contention does not grow and no normal writer waits 480 seconds;
- protected-item, apply, and close guards are unchanged.

Then observe two complete, consecutive five-minute samples, both entirely after
coordinator-only cutover, showing:

- pending decreases;
- total outstanding (`pending + dispatching + leased`) decreases;
- useful `published + superseded` meets or exceeds arrivals;
- retry amplification declines materially;
- post-batch `state_contention` does not increase;
- oldest pending age begins falling;
- multiple target items are live-verified;
- one state commit contains multiple intended item mutations;
- no dead-letter disposal is being mistaken for successful delivery.

Only after the live size-2 proof and both samples pass may maintainers discuss a
separate explicit change to size 4. Size 8 remains blocked until size 4 passes
the same end-to-end and two-sample gate. No automatic `2 -> 4 -> 8` progression
is permitted.

### Follow-up task: fence identity hotfix and controlled 2 -> 4 -> 8 rollout

Treat this as one ordered rollout task. A later phase must not begin merely
because the earlier configuration has been deployed; it begins only after the
earlier behavior and observation gates are recorded as passing.

- [x] Fix Git fence identity at the fence-commit boundary. Lease acquire,
      renewal, stale-owner recovery, and cleanup must not depend on a caller
      having configured repository or global `user.name` and `user.email`.
      Landed as [`openclaw/clawsweeper#759`](https://github.com/openclaw/clawsweeper/pull/759)
      at `09b3c2ba2959146e4a3960439c9450d10f122d67`; `createStatePublishLeaseCommit`
      passes `clawsweeperGitIdentityEnv()` inline to `git commit-tree`.
- [x] Add the narrow regression proof: an ordinary coordinator writer and a
      batch coordinator writer must create and renew their fence from a checkout
      with no preconfigured Git identity. Preserve existing commit authorship
      for generated-state data commits. Test `fence commits do not require a
preconfigured Git identity` in `test/repair/state-writer-coordinator-git.test.ts`.
- [x] Run focused tests and `pnpm run check` on local Node 24, run autoreview to
      a clean result, land the hotfix through a green pull request, and verify
      the merged `main` workflow. Do not use remote Crabbox or Testbox. Full
      `pnpm run check` passed in local Docker container
      `docker.io/masonxhuang/codex-node24-ci:20260721` (Node v24.18.0, Git
      2.47.3, pnpm 11.10.0, 8 GiB memory/swap, 1024 PIDs, 4 CPUs, init);
      [PR 759](https://github.com/openclaw/clawsweeper/pull/759) `pnpm check`
      passed in [run 29858569422](https://github.com/openclaw/clawsweeper/actions/runs/29858569422).
- [x] Verify production remains at `max_items=2` and `max_wait_seconds=60`.
      The 2026-07-22 00:11 UTC snapshot reported batching enabled with size 2,
      a 60-second wait, three completed batches, one leased batch, and 14
      expired batches. No live workflow cancellation, DLQ replay/cleanup, or
      apply/close shortcut was used.
- [x] Complete the live size-2 Git and queue behavior proof: one generated-state
      commit for two claimed members, successful remote-HEAD CAS and fence
      verification, and two accepted acknowledgements with no new normal
      480-second Git-lease wait. This is proven by
      [run 29865701885](https://github.com/openclaw/clawsweeper/actions/runs/29865701885):
      FIFO ticket 183 acquired, state lease acquired on its first attempt,
      commit [`49777f30`](https://github.com/openclaw/clawsweeper-state/commit/49777f30284d01fb2255c763cc3b8e5668b9709a)
      materialized two members, and completion accepted two acknowledgements
      with zero retryable outcomes. Runs
      [29873949047](https://github.com/openclaw/clawsweeper/actions/runs/29873949047)
      and [29876112204](https://github.com/openclaw/clawsweeper/actions/runs/29876112204)
      repeated the same two-member commit and two-ack result.
- [ ] Complete the remaining formal size-2 proof evidence: live-verify multiple
      intended target items and unrelated-sibling preservation, restore fresh
      attributable coordinator metrics, and show protected-item, apply, and
      close guards remain unchanged. Dashboard telemetry is currently stale and
      reports `state_writer.mode=unknown`, so this gate is not yet met.
- [x] Land batch failure terminalization from
      [`openclaw/clawsweeper#764`](https://github.com/openclaw/clawsweeper/pull/764),
      merged at `b657a55bb6e4499825a9adffecb44e32cd0e9ed5` after all required
      checks passed.
- [ ] Verify one controlled failure releases only its own fenced members
      promptly and does not wait for the 30-minute batch lease expiry.
- [ ] Record two complete, consecutive five-minute size-2 samples satisfying
      every gate above. Any contention increase, lost sibling, same-path safety
      regression, ambiguous completion, or guard regression stops rollout and
      returns configuration to the last proven size. The 2026-07-22 00:11 UTC
      snapshot is a recorded no-go baseline, not a passing sample: publication
      pending was 2,077; the oldest pending age was 89,146 seconds; arrivals
      versus resolutions were 8 versus 2 in 15 minutes and 43 versus 2 in 60
      minutes; net drain was `-24/hour` and `-41/hour`; the coordinator had 25
      queued writers and one leased writer; and its latest/max waits were
      2,903,656/3,048,142 ms. Fix observability and writer service rate before
      requesting size 4.
- [ ] Increase to size 4 only through an explicit reviewed configuration change.
      Inspect at least one four-member single commit and all four independent
      outcomes, then record two new complete, consecutive five-minute samples.
      Roll back to size 2 on any failed gate.
- [ ] Increase to size 8 only through a second explicit reviewed configuration
      change after size 4 passes. Inspect at least one eight-member single commit
      and all eight independent outcomes, then record two new complete,
      consecutive five-minute samples. Roll back to size 4 on any failed gate.
      Size 8 is the final rollout target, not an optional later discussion.
- [ ] Update this document with pull requests, merged commits, production run
      URLs, state commit identities, queue outcomes, coordinator/lease metrics,
      sample windows, and the final keep-or-rollback decision at each size.

After the writer path is stable, dead-letter recovery is a separate authorized
operation. Start with one representative item, then batches of at most two when
GitHub pressure matters. Stop on the first repeated deterministic failure, new
rate-limit signal, or unexplained health regression.

## Rollback

The narrow coordinator rollback is:

```text
CLAWSWEEPER_STATE_COORDINATOR_ENABLED = false
```

On rollback:

1. keep exact-review batching and `max_items=2` unchanged unless a separate,
   explicitly authorized batching rollback is required;
2. let an active coordinator owner finish or lose its renewable lease/absolute
   deadline; do not cancel the workflow;
3. return newly started publishers to the legacy Git-fence path, preserving
   remote-head CAS and atomic branch-plus-fence safety;
4. retain coordinator tickets, generations, terminal receipts, batch rows, and
   state commit identities for recovery and diagnosis;
5. do not reset either queue, delete receipts, rewrite generated-state history,
   replay DLQ items, or change apply/close guards.

Rollback can temporarily restore the old contention failure mode, so it is a
safety fallback rather than a throughput fix. It requires no data migration. If
the batching protocol itself later needs rollback, its existing disabled flag
can stop new batch claims and allow active ownership to expire, but that is a
separate decision and is not part of the current coordinator rollout.

## Completion criteria

This incident repair is complete when:

- all normal generated-`state` writers use one durable FIFO admission boundary,
  while the Git ref serves only crash recovery, ownership fencing, stale-owner
  recovery, and atomic publication;
- exact-result publication uses one active size-2 batch writer and completes one
  real two-item commit with two correct independent acknowledgements;
- ordinary writers and the batch writer make FIFO progress without normal
  480-second Git-lease competition;
- sustained useful throughput remains above arrival rate with measured
  headroom;
- the backlog and oldest age decline to their normal operating ranges;
- state-contention retries and dead letters stop growing;
- batch cleanup keeps SQLite growth bounded;
- every live-enabled pull request has its manual verification evidence recorded;
- two complete, consecutive five-minute size-2 samples pass every rollout gate;
- the temporary fixed-capacity-50 configuration is removed in a separately
  reviewed cleanup after the backlog is materially cleared;
- open dead letters have an explicit replay, fresh-review, or audited-resolution
  disposition after the writer path is proven stable.

The controlled batching rollout is complete only after size 4 and then size 8
each land through an explicit reviewed configuration pull request, produce a
live single commit with the configured number of independently acknowledged
members, and pass two complete consecutive five-minute samples. The final keep
decision is production batch size 8; any failed size-8 gate rolls back to the
last proven size 4 configuration.

Migration of authoritative operational state into a database remains a possible
long-term architecture. It is not required to validate or roll back this
batching repair.
