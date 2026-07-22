# VISION

## What ClawSweeper is

An autonomous maintainer for openclaw repositories. It reviews, closes, consolidates, and reports on issues and PRs so human maintainers spend attention only where judgment genuinely requires them.

## Who it serves

openclaw maintainers first, contributors second — every contributor gets a substantive, honest review faster than a human team could deliver one.

## Design stance: abundant intelligence, scarce trust

Model calls are cheap and getting cheaper; engineer time and trust are not. Whenever behavior can be a model judgment with a clear prompt and an auditable output, prefer that over deterministic machinery. Code exists for the trust boundary only: authentication, idempotency, the append-only action ledger, spend limits, and destructive-action gates. Everything else — candidate selection, failure recovery, retry strategy, triage policy, anomaly diagnosis — should trend toward Codex-driven with the reasoning recorded in the ledger.

## In scope

Review with proof-checking; policy-gated closing with revival paths; umbrella consolidation; state/report materialization; self-healing informed by model diagnosis.

## Out of scope

Merging without policy authorization; releases; touching repos outside the configured set; any spend without a ledger entry.

## Quality bar

Every action carries a reason a maintainer can read; wrong closes must be revivable in one comment; the system's own failures are triaged by the system before a human sees them.

## Non-goals

Perfect determinism (we buy correctness with verification, not rigidity); zero-cost operation; replacing maintainer taste on product direction.

## Autonomy guidance

Agents working on this repo should delete machinery when a model call plus ledger entry can replace it, keep workflows thin (logic in testable TS, not YAML bash), never add a pinned-text test where a review gate suffices, and coordinate cross-lane changes through the RFC issue rather than parallel pushes.
