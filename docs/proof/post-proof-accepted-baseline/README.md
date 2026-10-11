# Accepted post-proof baseline: apply-path proof

## Claim and surface

A ClawSweeper acknowledgement update must not cause a repeated review of an unchanged PR.
The accepted timestamp is not sufficient by itself. A later contributor edit must still block
publication and close.

The proof runs `node dist/clawsweeper.js apply-decisions`, not the freshness function alone.
It uses the shipped CLI, report parser, source gate, coverage-proof runner, post-proof gate,
review-comment publisher, and PR close path. It uses the existing test helpers to supply a
stateful `gh` process and a controlled coverage-proof response. No product function is replaced.

## Fixture and scenario

The fixture is an old PR close proposal for `duplicate_or_superseded`. Its canonical PR is merged.
The review has a complete source revision, timeline revision, head SHA, and PR activity cursor.
The stored `updated_at` is `2026-05-01T00:00:00Z` (T0). The live PR and the acknowledgement
comment both have `updated_at` `2026-05-01T01:00:00Z` (T1). The acknowledgement has the exact
`clawsweeper-pr-ack:opened item=158915` marker and review-progress markers. These synthetic times
make the fixture old enough for the normal apply gates. The marker shape follows the incident at
<https://github.com/openclaw/openclaw/pull/158915>.

The fixture pre-seeds the managed rating label. Thus, a label-sync write cannot create an
additional apply-owned receipt and hide the regression. The driver asserts this condition.

Each revision runs three isolated cases:

1. **Acknowledgement only:** the live source and activity receipt match the stored review.
2. **Same-second title edit:** after coverage proof starts, the mock changes the title but keeps
   T1. The pre-apply gate has already accepted T1. The fresh structural receipt must reject the edit.
3. **Human comment after proof:** after coverage proof starts, the mock adds a contributor comment.
   Its timestamp is after the proof start. The PR still reports T1. Apply must reject the activity.

The mock records every `gh` request, including method, path, and sanitized arguments. It also
records all close and durable comment writes. Each run retains stdout, stderr, the stored review,
and the apply report. The driver asserts that rejected cases have no close or durable writes.

## Observed result

The base is `f3be2fcbbdad33596d1d3874d42340486cb339f2`. The candidate code is
`3d7cd274b6935ffa73e45ba57226ef8e20632ab9`. The proof-only commit does not change product code.

| Scenario                  | Revision  | `action_taken`                 | Drift log | Close writes | Durable writes |
| ------------------------- | --------- | ------------------------------ | --------- | ------------ | -------------- |
| Acknowledgement only      | Base      | `skipped_changed_since_review` | Yes       | 0            | 0              |
| Acknowledgement only      | Candidate | `closed`                       | No        | 1            | 1              |
| Same-second title edit    | Base      | `skipped_changed_since_review` | Yes       | 0            | 0              |
| Same-second title edit    | Candidate | `skipped_changed_since_review` | Yes       | 0            | 0              |
| Human comment after proof | Base      | `skipped_changed_since_review` | Yes       | 0            | 0              |
| Human comment after proof | Candidate | `skipped_changed_since_review` | Yes       | 0            | 0              |

Every blocked case reports `updated_at changed`. The human comment changes the structural
receipt, so it is rejected before the later non-automation-activity check. Every CLI process
exits 0: a conservative skip is a valid apply result.

See the [receipt](artifacts/receipt.json), [base results](artifacts/base/results.json),
and [candidate results](artifacts/candidate/results.json). Each result links its request trace.
The adjacent `service-responses.jsonl` records the PR and comment responses before and after
coverage proof starts. In the candidate title-edit case, the drift diagnostic has
`accepted_baseline: true` and `accepted_baseline_receipt_matches: false`. This shows that
the accepted timestamp alone did not authorize a durable publication or close.

The proof ran with Crabbox 0.74.0, provider `local-container`, image `node:24-bookworm`,
Node v24.21.0, pnpm 12.4.1, and lease `cbx_123bf98cfac9`. The receipt records the immutable
image ID, run ID, artifact hashes, and limits. The container has no home or credential mount.
Its only host mount is Crabbox's read-only bootstrap directory. Network access is used for
container setup and dependency installation; the apply process uses only local mock services.

## Command and environment

From the candidate checkout, create an archive of the base revision and transfer it to the
container. Then run:

```sh
crabbox run --provider local-container --id post-proof-1934 --no-hydrate --timing-json -- \
  bash docs/proof/post-proof-accepted-baseline/run-proof.sh \
  /tmp/post-proof-base.tar /tmp/post-proof-results
```

`run-proof.sh` builds both revisions and runs the same driver in each checkout. The base archive
must contain the complete source tree from `origin/main`. The driver uses temporary report and
closed directories, `--skip-dashboard`, and `--item-number 158915`. It does not use a GitHub token.

## Limits

This is controlled runtime evidence, not a live GitHub or model-quality test. GitHub reads and
writes terminate in a local mock process. The coverage-proof process returns a fixed allowed
result. The proof does not test GitHub timestamp precision, network failures, the hosted workflow,
or the semantic quality of a model decision. It proves the shipped apply path under the stated
source and activity transitions. No production item is changed.

OpenClaw Bay is not affected. This change does not change the queue, status, telemetry, or
dashboard data contract.

## Related timestamp-lag proof

The [owned-write timestamp-lag proof](owned-write-lag/README.md) extends this harness to cover
a durable review PATCH whose timestamp reaches the PR only after the first post-write item read.
Pass `owned-write-lag` as the third argument to `run-proof.sh` to run those cases.
