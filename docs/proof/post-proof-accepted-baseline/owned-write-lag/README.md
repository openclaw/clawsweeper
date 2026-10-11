# Owned-write timestamp lag: apply-path proof

## Claim and surface

A delayed PR `updated_at` must not hide a durable review write from the final close gate.
The gate can use the timestamp in the comment write response, but the complete structural
receipt must still match. A human comment after proof must block close.

This proof runs the shipped `node dist/clawsweeper.js apply-decisions` CLI. It does not replace
product functions. It uses the parent directory's stateful `gh` harness and fixed allowed
coverage-proof response. GitHub requests and responses, apply output, and the review snapshot
are captured for each case.

## Production evidence

In [run 38180187166](https://github.com/openclaw/clawsweeper/actions/runs/38180187166), apply
synced the durable review on <https://github.com/openclaw/openclaw/pull/142693>. Its final gate
then logged:

```text
stored_updated_at: 2026-10-11T22:23:58Z
item_updated_at: 2026-10-11T22:29:54Z
self_mutation_receipt_updated_ats: [2026-10-11T22:28:58Z]
candidate_receipts: 0
accepted_baseline: false
```

The durable comment `5593623862` had `updated_at` `22:29:54Z`. The item read immediately after
that PATCH still returned `22:28:58Z`. The old receipt recorded only the lagging item timestamp.

## Scenario and command

The review snapshot is T0 (`2026-05-01T00:00:00Z`). A prior acknowledgement has moved the live PR
to T1 (`2026-05-01T01:00:00Z`). The durable review body needs synchronization. Its PATCH response
has T2 (`2026-05-01T02:00:00Z`). The first issue read after PATCH returns T1; later reads return T2.
The source, timeline, head, and review activity do not otherwise change.

The control adds a human comment after proof starts and after the durable PATCH. Both revisions
must leave the PR open. The control can have a durable review PATCH before the human comment;
it does not claim zero publication writes. Every case asserts the PATCH, the lagging first item
read, the later T2 read, and the expected close count.

From a disposable Crabbox `local-container` checkout, supply an archive of the base revision:

```sh
bash docs/proof/post-proof-accepted-baseline/run-proof.sh \
  /tmp/owned-write-lag-base.tar /tmp/owned-write-lag-results owned-write-lag
```

The runner builds each revision and runs identical fixtures. Managed labels are already in sync,
so an unrelated label write cannot create another receipt. The CLI uses temporary report and
closed directories, `--skip-dashboard`, and `--item-number 142693`.

## Observed result

Base: `c8ded58100cf2f13c7d24fd3b0db8629ae29054a`. Candidate code:
`9f5435626198b013a04c3259b796d7f7c464263b`.

| Scenario               | Revision  | `action_taken`                 | Drift log | Close writes | Durable writes |
| ---------------------- | --------- | ------------------------------ | --------- | ------------ | -------------- |
| Owned-write lag        | Base      | `skipped_changed_since_review` | Yes       | 0            | 1              |
| Owned-write lag        | Candidate | `closed`                       | No        | 1            | 2              |
| Lag plus human comment | Base      | `skipped_changed_since_review` | Yes       | 0            | 1              |
| Lag plus human comment | Candidate | `skipped_changed_since_review` | Yes       | 0            | 1              |

All four CLI processes and both builds exited 0. Every blocked case reports
`updated_at changed`. The candidate's second durable write is the close-applied evidence
comment, after the synchronized review PATCH.

The [receipt](artifacts/receipt.json) records hashes of the [base traces](artifacts/base/results.json)
and [candidate traces](artifacts/candidate/results.json). Each case includes requests, service
responses, stdout, stderr, the input review, and the apply report. The base lag trace records
T1 in `self_mutation_receipt_updated_ats`, T2 in `item_updated_at`, and no candidate receipt.

Crabbox 0.74.0 ran the proof with provider `local-container`, image `node:24-bookworm`,
Node v24.21.0, pnpm 12.4.1, lease `cbx_31b98c143123`, and run
`run_52067ad10f3e330c7db7ef0cea92b159`. The immutable image ID is in the receipt.
No home or credential directory is mounted. Network access is used for setup and package
installation; the apply process calls only local mocks.

## Limits

The GitHub service and coverage model are local processes. This proves the shipped apply path
for a controlled timestamp lag; it does not measure production lag duration or validate model
judgment. The synthetic dates make the PR old enough for normal apply policy. No production item
is changed. The human-comment control can fail during structural receipt collection rather than
at the later explicit non-automation-activity check. The empty PR activity cursor uses the shipped
v2-to-v1 fallback.

OpenClaw Bay is not affected. The fix does not change the queue, status, telemetry, or dashboard
data contract.
