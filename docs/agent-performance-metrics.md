# Agent operational metrics

- Status: active dashboard reference
- Owner: ClawSweeper maintainers
- Owning sources: `dashboard/operational-health.ts`, `dashboard/exact-review-queue.ts`,
  `dashboard-site/scripts/operations.ts`, `dashboard-site/src/pages/agent.astro`
- Verified source baseline: `1734607164b608ff1bb2508c7cda58ef6cda2ce0`
- Update when: queue counters, publication paths, batch timestamps or history sampling change

The `/agent/` page shows recorded operational metrics and charts. It is
observer-only and never changes queue admission, retries or publication behavior.
It reuses the dashboard's SVG charts and bounded seven-day hourly history.

## Metrics

| Metric | Definition |
| --- | --- |
| Review completions | Observed growth in the review lane's completed counter, including terminal non-review dispositions |
| Model time | p50/p90 model execution duration in each item's latest stored review; excludes queue and publication wait |
| Publication pending | Work waiting for publication, including retry backoff; timer-ready does not mean all admission gates passed |
| Repeated-claim alerts | Targets over the configured review-claim threshold; a claim may end before model execution |
| Waiting work | Highest pending count observed in each hour, separately for review and publication |
| Recent-review coverage | Items reviewed within the source window divided by source-defined reviewable items |
| Publication deliveries | Observed growth in `published_total`, excluding superseded and deduplicated completions |
| Publication handoff | Workflow dispatch to durable batch claim, grouped by delay |

Review completions and claims are activity counts, not correctness scores.
Superseded publications retained for command acknowledgements are excluded from
pending demand. No outcome placeholders or personal-effort measures appear on
the page.

## History and missing data

Queue snapshots arrive every five minutes and are reduced to hourly values.
Counter growth is counted only across adjacent observations at most ten minutes
apart. Each counter is independent: a reset or missing value in one cannot erase
another counter's observations. An hour with some valid intervals can still be
partial; counts are observed totals, not extrapolated rates. The current hour is
still filling and is excluded from the 24-hour headline.

The Operations shed percentage uses only intervals where accepted and shed
offer deltas are both observed, excluding the current hour. Its paired sample
can differ from either independent count. Without paired observations, the
percentage is unavailable; a measured zero-offer sample is shown separately.

Missing observations remain gaps, never zeros. Collection coverage and source
timestamps stay visible. Publication delivery history begins when
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
