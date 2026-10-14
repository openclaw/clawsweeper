# Agent performance measurement

- Status: proposed outcome-measurement contracts; current dashboard signals are active
- Owner: ClawSweeper maintainers
- Owning sources: `src/action-ledger.ts`, `src/clawsweeper-review-ledger.ts`,
  `dashboard/exact-review-queue.ts`, `dashboard-site/scripts/records.ts`
- Verified source baseline: `289b3367d9cc8c243b054c256ddc934677e58fb5`
- Update when: eligibility, review, publication, audit or cost accounting changes

The objective is correct, useful maintenance outcomes with less human effort,
delay and cost. Optimize the complete workflow. Review counts, closures,
confidence and PR grades alone cannot establish success.

The `/agent/` dashboard exposes available operational signals and labels missing
outcome evidence **Not collected**. It does not start an audit, collect personal
time records, change automation authority or rank individual maintainers.

## DORA boundary

[DORA's current five metrics](https://dora.dev/guides/dora-metrics/) measure
software delivery: change lead time, deployment frequency, failed deployment
recovery time, change fail rate and deployment rework rate. Keep these at the
application/service level with deployment and incident evidence. A review run is
not a deployment; a rereview is not necessarily deployment rework.

Use the related agent measures below alongside DORA. Do not label them DORA
metrics or substitute review completion for production delivery.

## Headline measures

| Measure                           | Proposed calculation and population                                                                                                      | Behavior to optimize                                    |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Verified useful outcomes          | Count accepted, independently correct outcomes with a linked downstream result; also report eligible episode count and unresolved count  | Finish useful work, not merely produce reports          |
| Time to useful outcome            | p50/p90 from first eligibility to accepted useful outcome; show completed sample size plus unresolved count and age                      | Reduce end-to-end delay without dropping difficult work |
| Material decision error rate      | Material errors / independently adjudicated episodes, with audit sample size, inconclusive count and sampling policy                     | Avoid harmful decisions and missed defects              |
| Human minutes per useful outcome  | All measured review, correction and escalation minutes in the cohort / verified useful outcomes                                          | Save effort without moving it to contributors           |
| Total cost per useful outcome     | All model, retry, tool and compute cost in the cohort / verified useful outcomes                                                         | Reduce total resource use while preserving quality      |
| Correct abstention and escalation | Report warranted escalations / adjudicated escalations and missed necessary escalations / adjudicated non-escalated decisions separately | Escalate when authority or evidence is insufficient     |

Zero verified outcomes makes a cost/effort ratio undefined, not zero. Partial cost
or effort coverage must be explicit; do not extrapolate it into a total. Human
time saved additionally needs a comparable baseline or controlled study.

Treat unfinished episodes as right-censored, not failed zero-duration samples.
Label completed-only percentiles as such; compare fixed-horizon cohorts or use a
survival estimate when unresolved work is material.

Separate verified useful output from mere acceptance: a merged PR or an approved
close can still be wrong. Retain later corrections against the original cohort
and show how the outcome changed. Do not erase the earlier result on rereview.

## Operational signals available now

- Repeated-claim alerts: targets above the queue's recorded review-claim
  threshold/window. A claim can end before model execution. The current history
  does not record source revisions or triggers, so repetition does not establish waste.
- Publication pending: work waiting for publication, split into ready and backoff.
  Show superseded revisions retained for command acknowledgements separately;
  these are excluded from pending demand and do not establish failed delivery.
  A review result is not delivered merely because its model execution completed.
- Oldest pending review: a live queue-age maximum, not eligibility-to-outcome p90.
- Recent-review coverage: reviewed-recent / source-defined reviewable items.
  This is freshness coverage, not on-time completion of due work.
- Model time: model execution duration in latest stored records. It excludes
  queue/publication waits and is subject to survivor and rereview selection.
- Workflow success: execution reliability, not decision correctness. Display
  counts, calendar window and recorded-day coverage beside rates.

Reviewer-reported confidence, security status, findings, proof and grades belong
under **Review assessments**. Calibrate confidence only once independent labels
exist; show empirical correctness by confidence bin with sample sizes.

## Identity and event ownership

Extend the existing action ledger rather than creating a second event store.

1. **Item**: repository, issue/PR kind and number.
2. **Episode**: explicit eligibility cause and exact source revision. A new
   revision or changed task can start a new episode; a retry cannot.
3. **Attempt**: operation ID, attempt ID and item identity. The existing operation
   ID can cover a batch, so it alone is not an item episode key.
4. **Decision**: exact reviewed revision, policy/harness revision, model identity,
   execution result and evidence references.
5. **Publication/outcome**: owner-recorded delivery, acceptance, verified result,
   correction or intentional non-outcome, each with its own timestamp.

Record facts at their owning boundary. Do not infer delivery from a finished
workflow, first response from latest-review time, or attribution from whichever
agent touched the item last. Preserve separate eligibility, queue, execution,
publication, human-wait and acceptance spans.

For ledger projections, distinguish native review terminals from mutation
coordination receipts; both can use `review.item`. Validate producer identity,
causal chains, multipart reservations and completion bindings. Deduplicate
replays by immutable event identity. A bounded R2 partition scan can establish
which published objects were read, not that every production attempt was logged.
State late-arrival, truncation and missing-publication limits explicitly.

## Independent audit contract

An audit is separate from the agent's `Decision`. Record the sampled episode,
exact decision/source revision, rubric version, auditor authority, sampling
probability, evidence, timestamp, and `correct`, `material_error` or `inconclusive`
disposition. The reviewer must not grade its own output as ground truth.

Sample keep-open, close, clean, findings, failures and escalations, including
unsuccessful episodes. Stratify by risk, task kind and repository. Independently
inspect random clean reviews to estimate missed defects. Distinguish genuine
agent-caused correction from new requirements, new source revisions and reviewer
preference. Use weighted estimates when sampling probabilities differ; publish
raw sample counts and uncertainty. Voluntary feedback alone is not a population
error rate.

## Fair comparisons and display requirements

Compare within repository, task/risk class, eligibility reason and source/policy
cohort. Keep model, harness and policy revisions separate. Display sample size,
time window, source freshness, missing-data coverage and unresolved age beside
each result. Withhold comparisons when populations or observation completeness
are incompatible. Do not invent universal target bands before establishing a
baseline.

Use independently assigned eligible work as the denominator. Counting only
completed reviews rewards abandoning difficult work. Counting only audited
successes rewards selecting easy audits. More tokens, tool calls, tests, lines of
code, rereviews or comments are diagnostic activity, not targets.

## Implementation sequence

1. Keep current metric labels and unavailable states truthful; prioritize
   operational friction and maintainer attention.
2. Add owner-recorded eligibility, episode identity and publication/outcome
   transitions to the existing ledger. Prove replay and terminal-state semantics.
3. Add independent sampled adjudication and privacy-preserving effort/cost
   accounting, with explicit coverage and retention.
4. Build bounded, replay-safe projections from validated published ledger sets.
   Reuse signed blob transport; publish aggregate public-repository data only.
5. Establish comparable baselines before using the metrics for optimization.

Steps 2–5 are follow-up implementation, not capabilities shipped by the current
scorecard. Public pages must not expose raw ledger identifiers, private source
revisions, personal time records or unverified repository identities.
