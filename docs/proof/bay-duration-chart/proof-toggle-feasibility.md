# Proof toggle feasibility (no new telemetry dimension implemented)

The retained toggle continues to mean **include legacy batch publication / retired post-review proof journeys**, not **include reviews that used modern inline proof**. Its tooltip now makes that distinction explicit. Normal direct-review end-to-end timings still include inline proof work; no proof classifier, source query, aggregation or review producer was changed. The chart adds only `timings.window_ended_at`, the exact timing-query boundary; this is not a proof-usage dimension.

## What the current source can establish

- `dashboard/review-proof-requests.ts:23–46`: private, owner-bound `ReviewProofRecord` records a request ID, scenario, plan, creation/expiry, state and optional producer run/result. It has no dedicated verified execution-start or terminal-observed timestamp. Creation time and expiry are admission/budget bounds, not proof duration.
- `dashboard/exact-review-queue.ts:1169–1269`: requests deduplicate by ID under the exact lease owner; dispatch-claimed, pending, completed and inconclusive are distinct states. A selected/requested scenario does not establish execution. Inconclusive can describe a deadline or admission failure, not necessarily a run.
- `dashboard/exact-review-queue.ts:15023–15025`: clearing the review lease removes `reviewProofRequests`. Retained lifecycle records and Bay timing events do not preserve a modern proof-used dimension. A historical proof filter cannot be reconstructed truthfully from that transient field.
- `dashboard/exact-review-lifecycle-telemetry.ts:2244–2280`: the timing boundary remains verified request trigger to final review receipt, with legacy/direct classification based on publication evidence. It does not subtract inline proof time or infer proof usage.
- `dashboard/exact-review-decision.ts:959–968` and `dashboard/worker.ts:2901–2941`: `legacy_batch_path` is a publication/legacy job classifier, not modern inline-proof evidence.

## Minimal truthful semantics to consider separately

1. Keep the existing control as a legacy-path comparison, with the explicit tooltip. Do not relabel it as a modern proof filter.
2. If modern proof comparison is wanted, first add a privacy-safe, durable per-lifecycle-revision fact emitted from the trusted proof execution/verification path before lease clearing, with an explicit collection epoch and unknown state for historical/missing evidence. Bind it to target, fence, revision and owner generation; deduplicate requests and retries. Never expose plans, result blobs or private owner fields to Bay.
3. A first filter could mean **Reviews with verified inline proof results**, if that exact event is captured durably. It would exclude attempted-but-unverified execution and must say so. Broader **Proof attempted** requires a separately defined trustworthy execution-start/producer evidence event, not dispatch intent. Neither permits classifying old missing facts as “no proof.”
4. The compared metric should initially remain **end-to-end review duration**, including proof. A standalone **proof duration** needs validated timestamps and a chosen definition (producer runtime versus request-to-result wait); multi-plan overlap/retries must not be naively summed or subtracted from review latency.

No additional modern-proof toggle, dimension, mutation control or telemetry schema is implemented in this UI-only change. Parent scope decision remains separate.
