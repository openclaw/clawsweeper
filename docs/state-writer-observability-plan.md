# State writer observability plan

**Status:** proposed, observability only  
**Incident:** CSW-049  
**Related implementation plan:**
[`docs/state-publication-batching-plan.md`](./state-publication-batching-plan.md)

## Decision

Add a separate **State writer** panel to the live dashboard. Do not rename or
reinterpret the existing **Result publication** panel.

The two panels answer different questions:

| Panel              | Question answered                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Result publication | How many publication queue items and workflows are pending, active, retrying, superseded, or dead-lettered?                          |
| State writer       | How many real state-ref writers exist, how long they wait and hold the state lease, and how many items each Git commit materializes? |

The panel and telemetry contract must support both publication modes from the
first release:

| Stage            | Writer mode   | Expected interpretation                                                                                                    |
| ---------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Before batching  | `single_item` | One successful writer operation normally materializes at most one item in one state commit.                                |
| Batching rollout | `mixed`       | Already-running single-item workflows drain while the batch writer begins operating. Keep the modes separate in telemetry. |
| After batching   | `batch`       | State writes remain serial, but one writer operation may materialize several items in one state commit.                    |

This is one observability design, not a dashboard that must be redesigned after
batching. The batch publisher must populate the same versioned contract with a
larger `actual_batch_size` and `materialized_items` value.

## Delivery coordination

Treat this as an independent task and development branch. It can be developed
in parallel with publication batching because it changes observation, not queue
or writer behavior.

Parallel development still needs one explicit integration rule:

1. Freeze the telemetry v1 field meanings in this document before either task
   changes them.
2. Keep the observability implementation additive and batching disabled.
3. Prefer merging the observability pull request first.
4. Rebase the batching branch once onto that merge and make the batch committer
   populate the established recorder instead of replacing its hooks.
5. Do not develop a second batch-only dashboard schema.

The tasks may be coded concurrently; only their final integration is ordered.
The batch ownership and Git primitive proofs can proceed without waiting for UI
work, while production batch enablement must wait until the writer telemetry is
available.

If parallel development is impractical because the same implementer cannot
safely manage conflicts in `git-publish.ts`, `sweep.yml`, and the queue Durable
Object, use this serial fallback:

```text
state-writer observability
  -> batching PR 1: durable batch ownership
  -> batching PR 2: multi-item Git primitive
  -> batching PR 3: end-to-end batch publisher
  -> batching PR 4: production enablement
```

Observability goes first in the serial fallback. That produces a measured
single-item baseline and lets every later batch pull request use one stable
contract. Do not postpone observability until after production batching, because
that would remove the before/after evidence needed for the rollout decision.

## Why this panel is needed

The current dashboard can show, for example, `50 of 50 active` under **Result
publication**. That number is publication workflow admission. It is not Git
write concurrency.

On current production `main`, ordinary state-branch mutations coordinate on one
state publish lease. CSW-049 observed successful holders keeping that lease for
roughly 49–71 seconds while dozens of publication workflows waited. Increasing
the publication lane to 50 therefore increased waiting and retries without
creating 50 state writers.

The existing dashboard exposes queue pressure well, but it cannot directly
answer these incident questions:

- Is the global state lease free or held?
- How many exact-result publishers are currently waiting for it?
- What are lease wait and hold p50/p95?
- How many state commits are produced per hour?
- How many items are materialized per commit?
- After batching, is useful item throughput increasing even if commits/hour
  decreases?

The incident handoff also showed that a GitHub review comment may become visible
before durable state publication finishes. Therefore this panel must measure
state materialization, not infer it from GitHub-visible comments or whole
workflow conclusions.

## Scope

This task includes:

- a small, versioned state-writer telemetry contract;
- structured lease and Git publication measurement on the exact-result path;
- best-effort live writer progress reporting;
- durable, bounded telemetry storage in the existing exact-review SQLite
  Durable Object;
- current and historical state-writer summaries in dashboard APIs;
- a standalone dashboard panel with single-item, mixed, batch, stale, and
  unavailable states;
- tests for validation, deduplication, history compatibility, rendering, and
  the batch transition.

## Non-goals

This task must not:

- enable publication batching;
- change publication capacity, dispatch, retry, timeout, lease, cooldown, or
  dead-letter behavior;
- change the state tree, record tuple, flat `items/` or `closed/` layouts;
- move authoritative state into SQLite;
- replay, resolve, delete, or reclassify dead letters;
- make telemetry delivery a prerequisite for publication completion;
- parse GitHub Actions log text to derive metrics;
- expose the raw state-lease owner UUID, tokens, error messages, or queue lease
  capabilities on a public API;
- claim that exact-result progress covers every ordinary state-branch writer.

The first version tracks exact-result publishers in detail because that is the
incident-dominant queue and already has a durable identity and completion
endpoint. Global lease occupancy is observed separately from the state repo, so
the UI can still show that another ordinary writer is holding the one shared
lease.

## Current implementation entry points

Implement against the latest `origin/main`, not only the current working-tree
version. The state publish lease used in production is present on `origin/main`
in `src/repair/git-publish.ts`.

| Responsibility                            | Current entry point                                                                                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| State lease acquire, renew, and release   | `src/repair/git-publish.ts`: `withStatePublishLease`, `acquireStatePublishLease`, renewal and release helpers                                                                              |
| Existing Git process/duration log metrics | `src/repair/git-publish.ts`: `GitPublishMetrics`, `recordGitProcess`, `publishMainCommit`                                                                                                  |
| Exact-result state mutation               | `src/repair/publish-event-result.ts`: the `withStatePublishLease` block around bounded record-tuple publication                                                                            |
| Workflow result export                    | `.github/workflows/sweep.yml`: `publish-event-result` and `exact-review-publication-result` steps                                                                                          |
| Durable completion request                | `.github/workflows/sweep.yml`: `Complete durable exact review publication` posting to `/internal/exact-review/complete`                                                                    |
| Queue completion and SQLite metrics       | `dashboard/exact-review-queue.ts`: `/complete`, `/stats`, metric tables and bounded pruning                                                                                                |
| Public status composition                 | `dashboard/worker.ts`: `exactReviewQueueStatusSnapshot`, `attachExactReviewQueueStatus`                                                                                                    |
| Five-minute history                       | `dashboard/worker.ts`: `recordScheduledHealthSample`, `appendHealthHistorySample`                                                                                                          |
| History normalization                     | `dashboard/operational-health.ts`: `HealthHistorySample`, `exactReviewHistorySample`, `normalizeHealthHistorySample`                                                                       |
| Existing lane UI                          | `dashboard/worker.ts`: `id="exact-review-lanes"`, `loadHealthHistory`, `renderExactReviewLanes`                                                                                            |
| Primary tests                             | `test/repair/git-publish.test.ts`, `test/repair/publish-event-result.test.ts`, `test/sweep-workflow.test.ts`, `test/dashboard-worker.test.ts`, `test/dashboard-operational-health.test.ts` |

Do not duplicate the lease algorithm in dashboard code. Instrument the existing
lease implementation and keep its behavior unchanged.

## Data flow

```text
exact-result publisher
  -> state lease recorder in git-publish.ts
  -> optional best-effort live progress event
  -> compact terminal state_writer object in queue completion payload
  -> exact-review SQLite telemetry tables
  -> /stats current and rolling summaries
  -> five-minute health-history sample
  -> standalone State writer dashboard panel

global lease ref in clawsweeper-state
  -> safe GitHub ref/commit metadata probe
  -> held/free/unknown in the same panel
```

Neither progress reporting nor terminal telemetry may alter the publication
result. If telemetry is unavailable or malformed, publication completion keeps
its current semantics and the panel reports partial or unavailable collection.

## Stable telemetry contract

### Pure contract module

Create a pure module such as `src/state-writer-telemetry.ts`. It must have no
Node-only, Cloudflare-only, Git, filesystem, or network dependency. It owns:

- schema version and string unions;
- TypeScript types;
- strict normalization of untrusted JSON;
- cross-field invariants;
- helpers shared by the publisher and queue receiver.

Keep recording and transport in separate files. Suggested responsibilities:

- `src/state-writer-telemetry.ts`: pure contract and validation;
- `src/repair/state-writer-telemetry-recorder.ts`: Node-side timing and progress
  recorder;
- optional `src/repair/state-writer-progress-reporter.ts`: one-shot,
  best-effort progress delivery if a detached reporter is used.

This extraction limits merge conflicts with the batch Git primitive, which is
expected to modify `src/repair/git-publish.ts` heavily.

### Terminal operation schema

Add one optional `state_writer` object to the exact-review publication
completion payload:

```json
{
  "state_writer": {
    "schema_version": 1,
    "operation_id": "single:29792754219:1",
    "mode": "single_item",
    "started_at": "2026-07-21T01:18:21.000Z",
    "finished_at": "2026-07-21T01:20:09.000Z",
    "wait_ms": 43210,
    "acquire_attempts": 9,
    "acquired": true,
    "hold_ms": 50120,
    "renewals": 0,
    "released": true,
    "git_duration_ms": 93330,
    "git_processes": 18,
    "commit_count": 1,
    "materialized_items": 1,
    "configured_batch_size": 1,
    "actual_batch_size": 1,
    "batch_wait_ms": null,
    "outcome": "materialized"
  }
}
```

An acquisition timeout is represented without inventing a hold duration:

```json
{
  "schema_version": 1,
  "operation_id": "single:29792754482:1",
  "mode": "single_item",
  "started_at": "2026-07-21T01:18:24.000Z",
  "finished_at": "2026-07-21T01:26:24.000Z",
  "wait_ms": 480000,
  "acquire_attempts": 97,
  "acquired": false,
  "hold_ms": null,
  "renewals": 0,
  "released": null,
  "git_duration_ms": 480000,
  "git_processes": 195,
  "commit_count": 0,
  "materialized_items": 0,
  "configured_batch_size": 1,
  "actual_batch_size": 1,
  "batch_wait_ms": null,
  "outcome": "contention_timeout"
}
```

The batch publisher later emits the same schema once per batch operation:

```json
{
  "schema_version": 1,
  "operation_id": "batch:01J3BATCHIDENTITY",
  "mode": "batch",
  "started_at": "2026-07-21T03:00:00.000Z",
  "finished_at": "2026-07-21T03:01:18.000Z",
  "wait_ms": 1800,
  "acquire_attempts": 2,
  "acquired": true,
  "hold_ms": 74200,
  "renewals": 0,
  "released": true,
  "git_duration_ms": 76000,
  "git_processes": 22,
  "commit_count": 1,
  "materialized_items": 6,
  "configured_batch_size": 8,
  "actual_batch_size": 6,
  "batch_wait_ms": 60000,
  "outcome": "materialized"
}
```

### Field semantics

| Field                        | Required meaning                                                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operation_id`               | Stable idempotency key for one writer operation. A workflow retry keeps the same batch identity where the batch protocol requires it. Never use the raw lease-owner UUID. |
| `mode`                       | `single_item` or `batch`. API summaries may derive `mixed`, but producers never emit `mixed`.                                                                             |
| `started_at` / `finished_at` | Bounds of this state-writer operation, excluding earlier review generation and unrelated GitHub side effects.                                                             |
| `wait_ms`                    | Time from entering state-lease acquisition until acquisition succeeds or the acquisition attempt terminates.                                                              |
| `acquire_attempts`           | Number of compare-and-swap acquisition attempts made by this operation.                                                                                                   |
| `acquired`                   | Whether this operation acquired the shared state lease.                                                                                                                   |
| `hold_ms`                    | Local time from successful acquisition until release handling finishes. It is `null` if never acquired.                                                                   |
| `renewals`                   | Successful lease renewals by this operation.                                                                                                                              |
| `released`                   | `true` for confirmed release, `false` for a failed release attempt, `null` when no lease was acquired.                                                                    |
| `git_duration_ms`            | Total time inside the measured state materialization path, including acquisition and release, but excluding queue/batch waiting.                                          |
| `git_processes`              | Git subprocesses executed in the measured operation. Do not count unrelated setup or GitHub API commands.                                                                 |
| `commit_count`               | Number of state commits actually published by this operation. The initial invariant is `0` or `1`. Lease metadata commits are not state commits.                          |
| `materialized_items`         | Items newly materialized by this operation. Do not count an item merely because a newer tuple already existed remotely.                                                   |
| `configured_batch_size`      | Configured item cap. It is `1` in legacy mode.                                                                                                                            |
| `actual_batch_size`          | Eligible items selected into this writer operation after preflight. It is `1` in legacy mode.                                                                             |
| `batch_wait_ms`              | Time from first eligible buffered item until batch departure. It is `null` in single-item mode.                                                                           |
| `outcome`                    | One of `materialized`, `unchanged`, `superseded`, `contention_timeout`, or `failed`. This describes state writing only and does not replace queue `completion_kind`.      |

Required invariants include:

- all counts and durations are finite, non-negative integers within a documented
  upper bound;
- `finished_at >= started_at`;
- `actual_batch_size <= configured_batch_size`;
- `materialized_items <= actual_batch_size`;
- `acquired=false` requires `hold_ms=null`, `released=null`, `renewals=0`,
  `commit_count=0`, and `materialized_items=0`;
- `commit_count=1` requires `acquired=true` and
  `materialized_items >= 1`;
- `mode=single_item` requires configured and actual batch sizes of one and
  `batch_wait_ms=null`;
- `mode=batch` requires non-null `batch_wait_ms`;
- `outcome=contention_timeout` requires `acquired=false`;
- unknown schema versions are ignored as unavailable telemetry, not partially
  interpreted.

Choose defensive upper bounds large enough for a 60-minute workflow but small
enough to reject nonsensical payloads. Keep those bounds in the pure contract
module and cover them with tests.

### Operation-level deduplication is mandatory

Telemetry is about a Git writer operation, not a queue-item completion.

In legacy mode there is normally one operation and one item completion. In batch
mode, one operation may lead to six separate item completions. If the same
`state_writer` object accompanies all six completion calls, SQLite must insert
the operation only once by `operation_id`.

Never increment commits, materialized items, or duration six times. A batch of
six with one commit must appear as:

```text
writer operations = 1
state commits = 1
materialized items = 6
items / commit = 6.00
```

If an existing `operation_id` arrives with the same normalized payload, treat it
as an idempotent duplicate. If it arrives with different data, preserve the
first accepted row, increment a telemetry-conflict diagnostic, and still allow
the queue item to complete.

## Live progress contract

Terminal completion metrics are sufficient for rates and percentiles but not
for a truthful current `waiting` count. Do not estimate waiting by subtracting
one from `50 active`; publication workflows can be in setup, GitHub mutation,
post-processing, or terminal cleanup.

Use a separate best-effort progress payload:

```json
{
  "schema_version": 1,
  "operation_id": "single:29792754219:1",
  "mode": "single_item",
  "phase": "waiting",
  "sequence": 1,
  "observed_at": "2026-07-21T01:18:21.000Z",
  "configured_batch_size": 1,
  "actual_batch_size": 1
}
```

Allowed phases are:

- `waiting`: entered lease acquisition but has not acquired;
- `holding`: acquired the state lease and is inside the critical section;
- `releasing`: state work finished and lease release is in progress;
- `finished`: operation ended; the terminal completion payload remains the
  durable source for metrics.

Add an internal route such as
`POST /internal/exact-review/state-writer-progress`. Forward it to a dedicated
Durable Object handler. Authenticate it using the full existing publication
claim tuple:

- queue lease id;
- item key and lease revision;
- claim generation;
- GitHub run id and run attempt.

The endpoint must verify that the item is a currently claimed publication item.
It must not renew, complete, retry, or otherwise mutate queue ownership.

For batch mode, extend the endpoint to accept the batch claim identity created
by the batching protocol. Do not pretend one arbitrary member item owns the
batch writer.

Progress transport is deliberately best effort:

- recorder callbacks must never throw into the lease path;
- network requests must not block while the state lease is held;
- a small detached one-shot reporter or equivalent non-blocking transport may
  deliver each phase;
- include a monotonic `sequence`, and ignore older or equal sequences;
- reject a delayed report after its queue or batch claim is no longer active;
- expire live rows after 90 seconds without a fresh observation;
- while a phase remains unchanged, refresh it at most every 30 seconds;
- any reporter exit, timeout, or 4xx/5xx must leave the publication outcome
  unchanged.

If reliable non-blocking progress cannot be implemented narrowly, ship terminal
telemetry first and render live waiting as `unknown`. Do not ship a guessed
number.

## Global lease occupancy

Detailed progress covers exact-result publishers. Other ordinary state writers
can still hold the global state lease.

Add a safe, cached GitHub metadata probe in `dashboard/worker.ts` for the lease
ref in the configured state repository and state branch. Use only:

- whether the lease ref exists;
- lease commit timestamp;
- advertised TTL, clamped to the same maximum as the lease implementation;
- dashboard observation timestamp.

Return only `held`, `free`, or `unknown`, expiry, and collection freshness. Do
not expose the lease owner or raw commit message. A missing ref means free. A
ref whose bounded expiry is past means stale/free. An authentication, rate-limit,
or parsing failure means unknown, not free.

Cache the result with the normal dashboard snapshot; do not poll GitHub from
browser JavaScript.

This allows the panel to distinguish:

```text
Global state lease: held (1 writer maximum)
Tracked exact-result writers: 1 holding, 37 waiting
```

from:

```text
Global state lease: held (1 writer maximum)
Tracked exact-result writers: 0 holding, 37 waiting
```

The latter can occur when an ordinary non-exact writer owns the global lease.

## Recorder integration

Instrument the existing state lease instead of parsing its console messages.

The recorder must observe these decisions without changing them:

1. Record `started_at`, emit `waiting`, and start the wait timer before initial
   jitter.
2. Increment `acquire_attempts` for each actual acquire attempt.
3. On successful compare-and-swap, set `acquired`, close `wait_ms`, start the
   hold timer, and emit `holding`.
4. Increment `renewals` only after a renewal succeeds.
5. Count Git subprocesses through the existing central `recordGitProcess`
   hook while the recorder is active.
6. Record a state commit only after the remote result is verified. Do not infer
   it from running `git commit`, because lease metadata also uses Git commits.
7. Emit `releasing` immediately before release handling.
8. Close `hold_ms`, record `released`, and emit `finished` in `finally`.
9. Finalize a compact terminal object on success or exception and export it as
   one-line JSON.

Keep `withStatePublishLease`'s return type and caller behavior unchanged. Pass an
optional recorder/observer through options or a narrowly scoped wrapper. Avoid
a new process-global telemetry singleton unless it is protected against nested
or concurrent use in the same Node process.

For the exact-result path:

- `configured_batch_size=1`;
- `actual_batch_size=1` only when the operation reaches state materialization;
- omit `state_writer` entirely for a workflow that terminalizes before entering
  the state writer path;
- call the explicit `recordMaterializedCommit(1)`-style hook only after the
  remote tuple is verified;
- emit `unchanged` or `superseded` with zero new materialized items when the
  remote already contains the winning tuple.

The batch committer later creates one recorder per batch, supplies the actual
batch size and batch wait, and records one verified commit with the number of
items it newly materialized.

## Workflow plumbing

In `.github/workflows/sweep.yml`:

1. Give the exact-result publish step the existing publication claim tuple and
   queue URL needed by the best-effort reporter. Do not add a shared webhook
   secret.
2. Export compact terminal telemetry from `publish-event-result` as a step
   output such as `state_writer_json`.
3. Pass it through `exact-review-publication-result` without shell evaluation.
4. Parse and validate it in the existing Node payload builder for
   `Complete durable exact review publication`.
5. Include the parsed object as optional `state_writer` in the JSON request.
6. If the output is absent or invalid, omit it and continue sending the existing
   completion fields.

Do not interpolate JSON into a shell command. Pass it through an environment
variable and use `JSON.parse` inside the existing Node payload builder. The pure
contract is authoritative again at the server boundary.

Older in-flight workflows will send no field. The receiver and dashboard must
remain compatible with them.

## SQLite storage and cleanup

Use compact additive tables rather than adding telemetry to the queue item JSON
or copying full completion payloads.

Suggested terminal table:

```text
exact_review_state_writer_operations
  operation_id                 primary key
  observed_at                  server receipt time
  mode                         single_item | batch
  started_at
  finished_at
  wait_ms
  acquire_attempts
  acquired
  hold_ms                      nullable
  renewals
  released                     nullable
  git_duration_ms
  git_processes
  commit_count
  materialized_items
  configured_batch_size
  actual_batch_size
  batch_wait_ms                nullable
  outcome
  payload_hash                 detects conflicting duplicates
```

Suggested live table:

```text
exact_review_state_writer_live
  operation_id                 primary key
  mode
  phase
  sequence
  observed_at                  server receipt time
  configured_batch_size
  actual_batch_size
  run identity or batch claim identity needed for validation
```

Add cumulative diagnostics to the existing metrics singleton or a dedicated
small singleton:

- accepted terminal operations;
- idempotent duplicate terminal operations;
- rejected terminal telemetry;
- conflicting operation payloads;
- accepted and rejected progress events.

Retention:

- keep compact terminal operation rows for seven days so 6h, 24h, and 7d
  percentile views are exact and bounded;
- remove stale live rows after 90 seconds;
- prune terminal rows in a bounded batch during existing queue telemetry
  cleanup;
- never couple telemetry cleanup to queue item deletion or DLQ cleanup;
- expose oldest retained row, last accepted observation, and rejected/conflict
  counters so collection quality is visible.

At the expected pre-batch rate, seven days of compact operation rows is small
enough for exact percentile queries and is simpler than maintaining a custom
histogram schema. If measured SQLite growth disproves that assumption, add
aggregated histograms in a later evidence-backed change.

Malformed optional telemetry must not reject `/complete`. Normalize it, count a
rejection diagnostic, omit the telemetry row, and continue the existing queue
completion transaction. Observability cannot strand publication work.

## Queue status API

Add an optional `state_writer` object to the exact-review `/stats` response:

```json
{
  "state_writer": {
    "schema_version": 1,
    "collection": {
      "status": "fresh",
      "last_observed_at": "2026-07-21T03:01:18.000Z",
      "rejected_total": 0,
      "conflicted_total": 0
    },
    "mode": "batch",
    "live": {
      "tracked_holding": 1,
      "tracked_waiting": 0,
      "tracked_releasing": 0,
      "freshness_seconds": 12
    },
    "last_15_minutes": {
      "operations": 8,
      "acquired": 8,
      "contention_timeouts": 0,
      "state_commits": 8,
      "materialized_items": 48,
      "items_per_commit": 6,
      "wait_ms": { "p50": 1100, "p95": 2400 },
      "hold_ms": { "p50": 68000, "p95": 78000 },
      "git_duration_ms": { "p50": 70000, "p95": 81000 },
      "actual_batch_size": { "average": 6, "p50": 6, "p95": 8 },
      "batch_wait_ms": { "p50": 32000, "p95": 60000 },
      "batch_fullness": 0.75
    },
    "last_60_minutes": {},
    "last_successful_materialization_at": "2026-07-21T03:01:18.000Z"
  }
}
```

Calculation rules:

- derive `mode=single_item` or `batch` when all fresh operations use that mode;
- derive `mode=mixed` when both modes occur in the current 15-minute window or
  live set;
- use `unknown` when there are no usable samples;
- calculate `items_per_commit` as
  `sum(materialized_items) / sum(commit_count)`, never as an average of
  per-operation ratios;
- calculate batch fullness as
  `sum(actual_batch_size) / sum(configured_batch_size)` for batch operations;
- do not include operations that never entered the state writer path;
- exclude `null` hold and batch-wait values from their percentile populations;
- include acquisition timeouts in wait percentiles and contention counts;
- return `null`, not zero, when a metric is unknown;
- report sample counts beside percentiles so a p95 from one sample is not
  presented as strong evidence.

Keep current queue API fields unchanged. The new object is additive and
optional during rolling deployment.

## History compatibility

Extend `HealthHistorySample` with an optional `state_writer` sample. Do not make
it a required child of `exact_review`; old seven-day history already lacks it.

Persist at each existing five-minute sample:

- collection status and sample time;
- mode;
- tracked holding/waiting/releasing counts;
- cumulative accepted operation, state commit, materialized item, and
  contention-timeout totals;
- current 15-minute wait and hold p50/p95 with sample counts;
- configured batch size and average actual batch size when batch mode exists;
- last successful materialization time.

Normalization requirements:

- a valid legacy sample without `state_writer` remains valid;
- an invalid optional `state_writer` child is dropped without discarding the
  valid exact-review history in the same sample;
- unknown future nested schema versions are ignored;
- counter resets create a new rate segment instead of a negative spike;
- 6h, 24h, and 7d switches continue to discard stale asynchronous responses,
  matching `loadHealthHistory` today.

Do not backfill invented pre-deployment values. The panel should say when
history starts.

## Dashboard UI

Add a standalone mount such as `id="state-writer-health"` immediately after the
existing exact-review lane cards and before handoff/apply health. Keep
`renderExactReviewLanes` responsible only for admission/publication lanes; add a
separate `renderStateWriter` function.

### Single-item example

```text
State writer                         Single-item · fresh 18s ago
Global state lease                  Held · 1 writer maximum
Tracked exact publishers            1 holding · 37 waiting

Materialized                        24 items/hour
State commits                       24/hour
Items / commit                      1.00

Lease wait                          p50 3m 12s · p95 8m 00s · n=41
Lease hold                          p50 58s · p95 71s · n=24
Contention timeouts                 17 in the last hour
Last materialization                2m ago
```

### Batch example

```text
State writer                         Batch · configured 8 · fresh 12s ago
Global state lease                  Held · 1 writer maximum
Tracked batch publishers            1 holding · 0 waiting

Materialized                        192 items/hour
State commits                       32/hour
Items / commit                      6.00

Actual batch                        avg 6.0 · fullness 75%
Batch wait                          p50 32s · p95 60s · n=8
Lease wait                          p50 1.1s · p95 2.4s · n=8
Lease hold                          p50 68s · p95 78s · n=8
Last materialization                20s ago
```

### Rendering rules

- Label the existing `50 active` value as publication workflows; do not move it
  into this panel.
- State explicitly that writer maximum is one for the current shared ref.
- Use `unknown` when global lease collection or progress collection failed. Do
  not render unknown as zero/free.
- Mark progress stale after 90 seconds and show the last observation age.
- During rolling rollout, show `Mixed · legacy draining + batch active`.
- In batch mode, make **materialized items/hour** and **items/commit** the primary
  throughput values.
- Do not mark lower commits/hour as a regression after batching. Fewer commits
  with more items per commit is the desired result.
- Keep queue `Published` and `Superseded` rates separate. Superseded queue work
  can be useful without creating a new state commit.
- Do not show raw operation ids, run ids, lease ids, owner UUIDs, or failure text
  in the public panel.
- Add concise help text explaining that `50 active` workflows still feed one
  serialized state-ref writer.

Use one compact trend for materialized items/hour. A second small trend for
tracked waiting is acceptable if it remains legible. Avoid adding charts for
every percentile.

## Behavior after batching is enabled

The panel must change automatically from producer data; no dashboard feature
flag or second schema migration is required.

The batch implementation must do all of the following before its production
flag is enabled:

1. Create one stable `operation_id` per batch.
2. Emit `mode=batch`.
3. Populate configured and actual batch sizes.
4. Measure time from the first eligible buffered item to batch departure.
5. Record one state commit after remote verification.
6. Record the number of items newly materialized by that commit.
7. Reuse that operation telemetry on per-item completions, relying on
   operation-level deduplication.
8. Emit live progress using the batch claim identity.

Expected metric movement:

| Metric                                  | Before batching                          | After healthy batching                                |
| --------------------------------------- | ---------------------------------------- | ----------------------------------------------------- |
| Writer maximum                          | 1                                        | 1                                                     |
| Publication workflows waiting for lease | Many                                     | Near zero                                             |
| State commits/hour                      | Similar to item throughput               | Lower than item throughput                            |
| Materialized items/hour                 | Limited by one item per critical section | Higher by average batch size                          |
| Items/commit                            | About 1                                  | Greater than 1                                        |
| Lease wait                              | High and bursty                          | Low with one batch writer                             |
| Batch wait                              | Not applicable                           | Bounded by the departure policy, initially 60 seconds |

During the cutover, already-running legacy workflows are not cancelled. The
panel may show `mixed` until they drain. The batch rollout is not considered
observable or ready if it still emits only single-item defaults.

## Implementation sequence

### Step 1: contract and recorder

- Add the pure schema/normalizer.
- Add a recorder that measures wait, hold, renewal, release, Git process count,
  and terminal outcome.
- Add minimal hooks to the existing state lease.
- Instrument exact-result publication with single-item defaults.
- Unit-test success, unchanged, superseded, contention timeout, renewal, failed
  release, and recorder failure isolation.

**Manual checkpoint:** run a local fake-remote publication and inspect one
normalized terminal object. Verify no lease timing, retry, or Git result changes
when recording is disabled or its sink throws.

### Step 2: receiver and durable summaries

- Deploy additive SQLite tables and bounded pruning.
- Accept optional terminal telemetry on `/complete`.
- Add idempotent operation insertion and conflict diagnostics.
- Add the progress endpoint and live expiry.
- Expose 15-minute and 60-minute summaries from `/stats`.
- Keep malformed telemetry non-blocking for queue completion.

**Manual checkpoint:** submit synthetic telemetry to a test Durable Object,
repeat the same operation, then submit a conflicting duplicate. Verify one
operation/commit is counted, diagnostics change correctly, and the publication
item still completes.

### Step 3: workflow producer

- Plumb claim identity to the recorder/reporter.
- Export compact JSON from the exact publish step.
- Safely add it to the existing completion payload.
- Confirm older payloads without the field still complete.

**Manual checkpoint:** inspect a workflow fixture payload. It must contain no
secret or owner UUID and must omit telemetry cleanly for preflight terminal
no-ops.

### Step 4: history and panel

- Add optional history types and normalization.
- Persist five-minute samples.
- Add the cached global lease probe.
- Add the standalone panel and its loading/stale/unavailable states.
- Add single-item, mixed, and batch rendering fixtures.

**Manual checkpoint:** render all modes locally from fixtures and verify that
`50 active` remains under Result publication while State writer shows one
maximum writer and independent wait/hold/materialization data.

### Step 5: batch handoff gate

- Give the batching implementer the final contract and recorder API.
- Add a batch fixture with one operation, one commit, and multiple item
  completions.
- Make batch telemetry population a rollout prerequisite in
  `docs/state-publication-batching-plan.md` implementation evidence.

**Manual checkpoint:** six item completions for one batch must produce exactly
one writer operation, one state commit, and six materialized items.

## Pull request strategy and task size

This is a medium-to-large observability task because it crosses the Node
publisher, workflow payload, SQLite receiver, history API, and dashboard. The
change is nevertheless one responsibility: making the serialized writer
visible.

Preferred delivery is **one observability pull request with reviewable commits**
because every added behavior is optional and inert with respect to publication.
Suggested commit boundaries are:

1. contract, recorder, and receiver;
2. workflow producer;
3. history, global lease probe, and UI.

If repository review limits require two pull requests, split only here:

1. **Telemetry substrate:** contract, recorder, workflow field, receiver,
   storage, and `/stats`. Manual verification is the API and deduplication gate.
2. **Dashboard presentation:** history normalization, global lease probe, panel,
   and UI tests. Manual verification is the visual single/mixed/batch gate.

Do not split individual SQLite tables, type files, or CSS into standalone pull
requests. Those pieces have no independent operator decision.

The telemetry PR should merge before the batching Git primitive if possible. If
batching work lands first, rebase this work and reapply only the narrow recorder
hooks. Never resolve a conflict by replacing the new batch committer or by
restoring the old single-item implementation wholesale.

Expected conflict areas are:

- `src/repair/git-publish.ts` in the batch Git primitive;
- `src/repair/publish-event-result.ts` in the publisher integration;
- `.github/workflows/sweep.yml` in the batch workflow;
- `dashboard/exact-review-queue.ts` in the batch ownership protocol.

The extracted pure contract, dedicated telemetry tables, and standalone render
function are intentional conflict boundaries.

## Automated test matrix

### Contract tests

- valid single-item success;
- valid single-item contention timeout;
- valid partial batch;
- every cross-field invariant rejection;
- excessive duration/count rejection;
- unknown schema version;
- normalization produces stable canonical data/hash.

### Git/recorder tests

- acquisition attempt count includes failed compare-and-swap attempts;
- wait duration closes on success and timeout;
- hold duration starts only after acquisition;
- renewal increments only on success;
- confirmed and failed release are distinct;
- lease metadata commits do not increment `commit_count`;
- verified state commit increments once;
- Git subprocesses are scoped to the operation;
- a throwing progress sink cannot fail or delay publication;
- existing lease and publisher tests remain byte-for-byte behavior compatible.

### Workflow tests

- claim tuple reaches only the internal reporter/payload builder;
- compact JSON is parsed rather than shell-evaluated;
- valid telemetry appears in `/complete`;
- missing or invalid telemetry is omitted;
- existing outcome, completion kind, reason, retry, and fingerprint fields are
  unchanged;
- no secret or raw lease owner enters the payload.

### Queue and SQLite tests

- additive schema initializes on an existing queue database;
- legacy completion without telemetry succeeds;
- malformed telemetry is counted and completion still succeeds;
- identical operation replay is idempotent;
- conflicting replay preserves first data and does not block item completion;
- six batch member completions count one operation/commit;
- percentile and ratio calculations use correct populations;
- `items_per_commit` uses sums;
- progress sequence ordering and stale expiry;
- expired live rows disappear from holding/waiting counts;
- seven-day pruning is bounded and cannot touch queue/DLQ rows.

### History tests

- legacy samples without `state_writer` survive unchanged;
- invalid optional state-writer data does not invalidate exact-review data;
- single, mixed, and batch mode samples normalize;
- counter reset starts a new segment;
- 6h, 24h, and 7d range selection remains race-safe.

### Dashboard tests

- standalone mount exists and ordering is stable;
- Result publication still renders workflow active/capacity;
- single-item panel labels one-item semantics;
- mixed panel explains legacy drain;
- batch panel renders configured/actual size and batch wait;
- unknown and stale states never render as zero/free;
- lower batch commits/hour is not given an error style when item throughput is
  healthy;
- no identifier or secret is rendered;
- global lease held by an untracked ordinary writer is distinguishable from a
  tracked exact writer.

## Manual verification checklist

No live workflow dispatch, DLQ replay, or state mutation is required for the
observability pull request proof.

1. Run unit tests with Node 24 or newer.
2. Use a local bare remote to produce one successful single-item operation and
   one acquisition timeout.
3. Inspect normalized telemetry and verify timings against the test clock/log.
4. Exercise a test queue completion without telemetry and confirm its outcome.
5. Exercise one with telemetry and confirm one terminal row.
6. Repeat the same operation and confirm totals do not change.
7. Complete multiple synthetic batch members using one operation id and confirm
   one commit and multiple materialized items.
8. Advance time past live expiry and confirm waiting/holding becomes stale or
   zero only with a fresh successful collection.
9. Render dashboard fixtures for single-item, mixed, batch, stale, and
   unavailable modes.
10. Confirm the public JSON/HTML contains no queue lease id, owner UUID, token,
    or raw error text.
11. Run `pnpm run check` before handoff because this task changes code, tests,
    workflow, and dashboard.

## Rollout order

Use receiver-before-producer order:

1. deploy additive SQLite schema, receiver, API, and UI capable of showing
   unavailable telemetry;
2. confirm old completion payloads still work;
3. enable terminal telemetry from single-item publishers;
4. enable best-effort progress reporting;
5. wait for two complete five-minute samples;
6. verify API totals against a small set of completed workflow runs;
7. only then use the panel as evidence for batching rollout.

The first samples may be `unknown` or `mixed` during a rolling deployment. That
is expected. Do not backfill or coerce them to zero.

When batching is deployed later:

1. deploy the batch producer with telemetry while batching remains disabled;
2. prove the one-operation/many-item fixture;
3. enable batch size 2 according to the batching plan;
4. expect `mixed` while legacy workflows drain;
5. verify items/commit rises above one and materialized items/hour improves;
6. do not judge the rollout by commits/hour alone.

## Rollback

Telemetry is additive and optional.

- Disable progress reporting first if it creates unexpected load.
- Stop attaching `state_writer` to completion payloads if producer data is
  suspect.
- The receiver continues accepting legacy payloads.
- The panel changes to partial/unavailable instead of affecting publication.
- Leave additive telemetry tables in place for diagnosis; bounded pruning will
  remove old samples.
- Do not roll back queue items, state commits, or publication outcomes because
  of an observability fault.

After batch rollout, disabling batching returns new operations to
`single_item`; the panel follows producer mode automatically and retains prior
batch history for the selected time range.

## Acceptance criteria

The task is complete when:

- the dashboard no longer invites readers to interpret `50 active` as 50 Git
  writers;
- one shared state writer is shown separately from publication workflows;
- current exact-result waiting/holding is measured or explicitly unknown, never
  guessed;
- lease wait/hold, contention, state commits, materialized items, and
  items/commit are available with sample counts and freshness;
- legacy history and completion payloads remain compatible;
- telemetry loss cannot fail or strand publication;
- one batch operation is deduplicated across all member completions;
- the same panel renders single-item, mixed, and batch modes;
- healthy batching is evaluated primarily by materialized items/hour and
  items/commit, not by commits/hour;
- the observability PR contains no batching enablement or production-control
  change.
