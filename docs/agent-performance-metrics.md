# Agent operational metrics

- Status: active dashboard reference
- Owner: ClawSweeper maintainers
- Owning sources: `dashboard-site/src/pages/agent.astro`,
  `dashboard-site/src/pages/operations.astro`, `dashboard-site/src/lib/data.ts`,
  `dashboard-site/scripts/actions.ts`, `dashboard-site/scripts/operations.ts`
- Verified source baseline: `b4cc911db6ed4a995d99f4fc7cc1eeb5492a4051`
- Update when: chart ownership, run sampling, failure windows, queue counters or batch timestamps change

The `/agent/` page answers three questions: how long execution takes, where
attempts fail, and which items repeat. Every detailed chart has one page owner;
related pages link to that owner. The dashboard is observer-only and never
changes queue admission, retries or publication behavior.

## Page ownership

| Page | Reader question | Detailed charts |
| --- | --- | --- |
| Agent performance | Where should execution be investigated? | Review-run p50/p90, failed attempts by stage, repeated-claim target sample |
| Operations | Is work moving through the system? | Review flow, handoff incidents, publication backlog/deliveries/batch handoff, close sweep |
| Throughput | How much work is recorded? | Latest-review dates, closes, workflow volume and failure rate |
| Queue | What is waiting or held now? | Current lanes, backoff/parked reasons, capacity and recoveries |
| Coverage | Which items need a fresh review? | Reviewable backlog, stale repositories and items |

Overview keeps compact summaries. It does not replace the detailed page owners.

## Metrics

| Metric | Definition |
| --- | --- |
| Model time | p50/p90 model execution duration in each item's latest stored review; excludes queue and publication wait |
| Review run time | Daily p50/p90 wall-clock duration of exact review runs; includes setup and finalization, excludes pre-run waiting |
| Failed attempts | Failure events in the source's rolling window, with terminal/retryable counts and stage breakdown |
| Repeated-claim alerts | Targets over the configured review-claim threshold; a claim may end before model execution |

The timing chart shows p50 and p90 together on one duration axis. A growing p90
with a stable p50 directs investigation to slower runs. These daily percentiles
are not pooled into a period percentile. Complete days only; missing days stay
gaps. Older Actions days can use sampled review runs. The model-only KPI uses a
separate latest-review corpus snapshot; subtracting it from a run percentile
would not measure overhead.

Failure stage counts help locate the failing boundary. They count attempts, not
distinct targets or a failure rate, because successful attempts are outside this
projection. Missing telemetry is distinct from a measured zero.

Repeated-claim links use the queue's bounded, verified-public target sample. It
is not a ranking. Compare revisions and triggers before calling repeated claims
wasted execution. The page does not turn claims or execution success into a
correctness score.

## History and missing data

Operations queue snapshots arrive every five minutes and are reduced to hourly values.
Counter growth is counted only across adjacent observations at most ten minutes
apart. Each counter is independent: a reset or missing value in one cannot erase
another counter's observations. An hour with some valid intervals can still be
partial; counts are observed totals, not extrapolated rates. The current hour is
still filling and is excluded from complete-hour summaries.

The Operations shed percentage uses only intervals where accepted and shed
offer deltas are both observed, excluding the current hour. Its paired sample
can differ from either independent count. Without paired observations, the
percentage is unavailable; a measured zero-offer sample is shown separately.

Missing observations remain gaps, never zeros. Source timestamps stay visible.
Operations publication delivery history begins when
`published_total` is first collected; older completion counters cannot backfill
it. The delivery chart appears once actual delivery observations exist.

## Publication handoff scope

The queue owner already records batch dispatch and claim timestamps. The public
projection exposes only aggregate delay buckets, sample bounds and current
dispatch state. It never exposes batch IDs, item identities, workflow IDs or raw
private observability data.

The sample includes active batches and up to 50 recent retained terminal
batches. Only batches with dispatch timestamps contribute timing samples; the
page shows the timed count, retained count and first/last claim timestamps.
This is a bounded retained sample, not a fixed calendar window or population
percentile.

Current wait begins at the owner's dispatch reservation and is shown only when
that dispatch succeeded and has not yet produced a claim. Failed, expired,
in-progress and already-claimed dispatches have distinct states. Direct
publication does not enter a batch and is excluded from this handoff measure.

This is not total queue wait. Exact eligibility-to-claim time remains unmeasured:
retry timers, batch cadence, capacity, source checks and credential gates can
change admission after enqueue. Do not derive an eligibility timestamp from
item creation or timer readiness.
