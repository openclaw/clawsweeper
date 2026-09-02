# OpenClaw Bay telemetry health behavior contract

## Claim

OpenClaw Bay keeps its crab-lane visualization while moving secondary queue and
transport charts behind a clearly labelled system-details disclosure. The public durable
lifecycle Kanban remains complete beyond 10,000 lifecycle records by streaming indexed
lifecycle history into aggregate lane counts and retaining only a bounded card
sample instead of loading every lifecycle JSON record into memory. Active public crustaceans
report an honest elapsed queue or live-run clock when its source timestamp is available.

## Exercised surface

- Exact-review lifecycle projection storage, schema migration, public aggregate counts,
  and bounded lifecycle samples.
- Public status projection for verified-public queue and live references.
- The production `/bay` page, including diagnostic disclosure, crab lanes, elapsed-time
  conversation bubbles, and unknown-time fallback.

## Scenario and fixture

Create more than 10,000 synthetic lifecycle projections across public and private
repositories, including every public lifecycle lane and multiple revisions of one target.
Read the public lifecycle projection through the Worker route and verify exact aggregate
counts plus a maximum 24-card allowlisted sample. Exercise a projection table containing
more than 10,000 rows and verify the public read completes without an `over_cap`
failure while retaining only the bounded sample. Render Bay with queue references, live actions,
terminal journeys, and missing timestamps, then open the system details disclosure and trigger
active-crustacean conversation bubbles.

## Command and environment

Run focused Node tests first. Then run the production Worker and Bay page through the
repository-resolved Crabbox provider using Node 24 or newer, recording the candidate
commit, provider, image, lease/run identifier, exact commands, and browser assertions.
Use synthetic local state and credentials only; do not deploy, mutate GitHub, or read
production Durable Objects.

## Observable result

- A public repository with more than 10,000 lifecycle rows returns a complete lifecycle
  snapshot, exact lane and inventory counts, and at most 24 cards.
- Private repositories, projection JSON, fences, deliveries, receipts, and workflow
  details remain absent from the public response.
- A malformed lifecycle row fails closed as `mixed` without partial counts.
- Historical lifecycle rows are validated and reduced without retaining a history-sized
  JavaScript array; only the final bounded sample survives the read.
- The crab lanes remain visible by default while queue/handoff/throttle charts are closed
  under `System details` by default and remain readable when expanded.
- Queue crustaceans say how long they have been queued; live crustaceans say how long the
  GitHub run has been active; missing timestamps remain explicitly unknown; completed
  crustaceans retain verified end-to-end journey duration.
- Retained cards from an incomplete current-activity census suppress queue/run ages and
  use neutral timing speech, even if the fallback records still contain previously
  verified timestamps.
- An incomplete census and the first complete census after recovery establish fresh
  animation baselines; neither produces inferred lane-transition movement.

## Artifact or trace

Retain the focused test transcript, browser assertions/screenshots, and Crabbox timing
JSON under `.artifacts/bay-telemetry-health/`. The PR body records the exact candidate,
provider, lease/run, observable values, and proof limits.

## Anti-cheat probes

- Insert 10,001 allowlisted lifecycle rows and require `collection.state=complete`.
- Include a newer revision and require only that revision to be marked current.
- Corrupt one indexed allowlisted row and require `collection.state=unknown` with no
  inventory, lanes, or sample.
- Include a private-repository row and require it not to affect counts or output.
- Supply queue, live, terminal, and missing timing sources and require distinct copy for
  each instead of reusing workflow age as lane age.
- Replace the current-activity census with an incomplete retained projection containing
  timestamps and require no active-age labels, overdue styling, timing attributes, or
  current-wait speech.
- Restore the complete census and require clocks to return without a delayed transition,
  backward tunnel, or master-sweeper movement inferred from the incomplete fallback.
- Verify the system-details disclosure is closed initially and that the crab Kanban is
  still present and populated.

## Limits

The proof validates local Durable Object-compatible SQLite behavior and the rendered Bay
contract with synthetic data. The lifecycle cold read is linear in selected history and is
shielded in production by the existing short-lived edge cache. The proof does not deploy the
Worker, mutate production state, prove historical lifecycle-row correctness, or claim that
queue/run age is time spent in the current visual lane.
