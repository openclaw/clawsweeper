# Scheduler duplicate-candidate stranding proof contract

## Claim

`selectDueCandidates` fills the review batch up to capacity from the candidates
it is given, even when the same item appears more than once in the due list.
Before this change, a run of duplicates could end selection early and strand
every remaining candidate while capacity was still free.

## Exercised surface

`run-proof.sh` drives the real `plan` CLI end to end — **no application function
is substituted**:

```
node dist/clawsweeper.js plan
  -> createReviewPlanningSelection().selectCandidates()
  -> fetchOpenItemPage()  -> ghJsonLines() -> spawnSync -> `gh` subprocess
                          -> JSON-lines parse -> item mapping
  -> dueCandidate()       -> bucket / priority / due derivation
  -> selectDueCandidates()
```

Only the `gh` **binary** is replaced, standing in for GitHub's server.
ClawSweeper's own transport — subprocess spawn, argument construction,
JSON-lines parsing, pagination loop — runs unchanged. The `selectedKeys` dedup
set inside `selectDueCandidates` exists precisely because duplicate page entries
are expected.

## Controlled scenario and fixture

Three distinct open PRs, `--batch_size 10` (far above the due count, so capacity
is never the limiting factor), `--max_pages 5`. The stub `gh` returns `#1` on four
consecutive pages, reproducing the `updated`-sorted pagination race in which an
item touched mid-scan is listed again on later pages:

```
page 1: [#1, #2]   page 2: [#1, #3]   page 3: [#1]   page 4: [#1]   page 5+: []
```

Four entries are needed because these land in `hot_pull_request`, whose weight is
2 — a stall requires one whole weighted pass to consume nothing but duplicates.
See **Reachability** below for the per-bucket thresholds.

### Two details that are load bearing

Both of these silently turn the proof vacuous — it passes on a pre-fix build and
demonstrates nothing. Do not "simplify" either one away.

1. **Clock.** `selectCandidates()` calls `selectDueCandidates()` **without** a `now`
   argument, so the scheduler uses the real `Date.now()`. Candidates must be recent
   enough to stay *out* of the weekly-coverage preselect lane (which needs 6 days).
   An earlier version used a fixed past timestamp; every candidate then qualified as
   weekly-coverage-due and was taken by the plain
   `for (const candidate of weeklyCoverageDue) take(candidate)` loop, which never
   reaches the weighted drain.

2. **Prior reports.** Items with no existing report are *coverage-untracked* and go
   through `takeWeighted`, whose cohort is a separate copy of the bucket lists — the
   final loop then recovers the survivors and nothing is stranded. The fixture
   therefore writes a prior report per item so the candidates are coverage-tracked
   and the final weighted drain owns selection.

## Expected observation

`shards[0].itemNumbers` from the real `plan` CLI, same fixture and invocation:

| build | selected | dueBacklog |
|---|---|---|
| pre-fix | `[1]` — `#2` and `#3` stranded | 6 |
| post-fix | `[1, 2, 3]` | 6 |

The proof also asserts the selection stays deduplicated, so the fix cannot be
satisfied by simply letting the duplicate through.

## Artifact and command

Supported-environment run (Node 24, Crabbox `local-container`). `run-proof.sh`
drives the **real `plan` CLI** with only the `gh` binary stubbed:

```bash
crabbox run \
  --provider local-container \
  --local-container-image node:24 \
  --no-hydrate \
  --timing-json \
  --artifact-glob '.artifacts/scheduler-duplicate-proof/**' \
  --script docs/proof/scheduler-duplicate-candidate-stranding/run-proof.sh
```

It installs the pinned pnpm into a user-writable prefix (the lease runs as the
unprivileged `crabbox` user, so `corepack enable` cannot symlink into
`/usr/local/bin`), builds, runs the planner fixture, and runs the focused suite.

Host-only quick check of the selection logic (injects `fetchOpenItemPage` rather
than the `gh` binary, so it does **not** exercise the transport):

```bash
pnpm run build
node docs/proof/scheduler-duplicate-candidate-stranding/run-proof.mjs   # exit 0 = PASS
```

## Provenance

- provider: Crabbox `local-container` (Docker/OrbStack)
- crabbox: `0.15.0`
- image: `node:24` @ `sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584`
- container node: `v24.19.0` (satisfies `engines.node >= 24`)
- lease: `cbx_7c89c5c91f66` (`brave-lobster`)
- run: `run_71734de37d18`
- artifact: `.crabbox/runs/run_71734de37d18/run_71734de37d18-artifacts.tgz`
  (`plan.json`, `summary.json`, `focused-tests.txt`, `install.log`, `build.log`)
- result: exit `0`; selected `[1,2,3]`, `dueBacklog` 6, deduped; focused suite `24/24`
- privacy: synthetic `contributor` login and public-shaped item numbers only. The
  stub `gh` makes no network call; the proof performs no queue, GitHub, or
  production mutation, and no credential is present in the lease.

## Reachability

A stall needs a whole weighted pass to consume nothing but duplicates, so the
threshold is per bucket. Derived by driving the real `dueCandidate()` logic
against a pre-fix build:

| bucket | weight | page entries for one item needed to strand |
|---|---:|---:|
| `hot_pull_request`, `activity`, `recent_issue` | 2 | 4 |
| `daily_pull_request` | 3 | 6 |
| `hot_issue` | 4 | 8 |
| `weekly_issue` | 1 | unreachable |

`weekly_issue` is unreachable because "due" and "weekly-coverage-due" share the
same 6-day threshold there, so the coverage preselect lane always claims it.

Focused tests:

```bash
node --test test/scheduler-policy.test.ts
```

Red/green was verified by swapping only the compiled `dist/scheduler-policy.js`
for a pre-fix build of the same file and re-running the focused suite with the new
tests present: 4 fail pre-fix, 24/24 pass post-fix, with all 20 pre-existing
assertions unchanged in both directions.

## Limits

Covers the batch-selection path only. The duplicate is injected at the `gh`
**binary** boundary rather than produced by a real pagination race, since that race
is timing dependent and not reproducible on demand — so GitHub's own server
behavior is modeled, not exercised. No live GitHub, Worker, or queue is contacted,
and the proof performs no mutation. The lease is a local Docker container, not a
cloud host, so it proves the Linux/Node 24 runtime but not cross-host isolation.

The fix changes only the loop's termination signal (candidates drained instead of
candidates selected). It does not deduplicate the `due` list up front, does not
change bucket weights, ordering, or the dedup key, and does not change behavior at
all for a due list with no duplicates. A duplicate still consumes one weighted
slot in its pass; only the premature `break` is removed.
