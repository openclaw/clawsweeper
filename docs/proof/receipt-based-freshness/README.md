# Receipt-based apply freshness proof

- Status: historical proof artifact
- Owner: ClawSweeper publication maintainers
- Baseline: `openclaw/clawsweeper@cac974b3e1da900cac3e7480b91d02a36ca60163` (origin/main)
- Candidate: `openclaw/clawsweeper@349741921fb9c0002a45d5a1fea53bebfc32db85` (clean committed head)
- Update when: apply source freshness, durable review-version markers, review lease
  release, or the deferred batch re-apply path changes

## Claim

An exact-review producer that keeps a close proposal open syncs the durable review
comment, runs the close gates (`kept_open`), and releases its review lease by deleting the
lease comment, which moves the PR `updated_at`. When its direct publication is deferred,
the batch publisher re-applies the same review. Before this change that re-apply recorded
`skipped_changed_since_review` (`updated_at changed`) and requeued a full
`source_drift_requeue` review (openclaw/openclaw#143911, runs 36671559049 ->
36672608523 -> 36673368897, roughly every 23 minutes). After it, the re-apply accepts the
producer's receipt-backed writes and keeps the proposal open without a requeue or a
duplicate GitHub effect. A human comment, a new head, or a title edit after the producer
still blocks and requeues on both builds with zero close writes. The #1715 scenarios
(openclaw/openclaw#126549 and #158447) keep their recorded outcomes.

## Exercised surface and scenario

`scripts/e2e/apply-source-drift-final-effect.mjs` drives the compiled non-dry-run
`apply-decisions` CLI with the exact-event publication arguments of
`src/repair/publish-event-result.ts`, and ClawSweeper's own `update-review-status`
acknowledgement edits, through native `gh` (`http_unix_socket`) against a stateful
synthetic GitHub API. The API is seeded from read-only captures of each PR (PR, comments,
timeline, files, commits, checks, review-activity GraphQL, related items) and rewound to
the looping run's review snapshot. Capture restores the durable review comment's body at
that snapshot from its read-only GraphQL edit history (`userContentEdits`), so later
generations do not leak into the replay. The seeded review lease carries a live marker
window, so the apply adopts and releases it as production does.

For #143911 (revision-46 snapshot, review lease 5904434723 owned by
`github-run-36671559049-1`) each `batch-*` scenario runs, per build:

1. acknowledgement `reviewing`, review snapshot, report, acknowledgement `complete`;
2. the producer apply (phase `apply`);
3. an optional external change (`batch-human-comment`, `batch-new-head`,
   `batch-title-edit`);
4. the batch publisher re-apply of the same pre-apply review artifact (phase `batch`).

#126549 (`recorded` and `close-capable` records) and #158447 run the #1715 scenarios
`ack-only`, `human-comment`, `new-head`, and `title-edit` (steps 1-2 only).

## Command and environment

```bash
node scripts/e2e/apply-source-drift-final-effect.mjs capture --item <n> --out <seed-dir> --gh "$(command -v gh)"
node scripts/e2e/apply-source-drift-final-effect.mjs run --item <n> \
  --seed-dir <seed-dir> --baseline <origin/main checkout> --candidate <branch checkout> \
  --out <evidence-dir>
```

Node v24.21.0, gh 2.101.0 against the synthetic API, macOS, both checkouts built with
`pnpm run build:all`. Seeds were captured 2026-10-01 and are not committed (full public
PR captures):

| Seed | SHA-256 |
| --- | --- |
| `seed-143911.json` | `7287e4930f862d054930538fe74946a505db0c97da4b38d6208255bd08897efa` |
| `seed-126549.json` | `63342b6cd2a04d6d0e297908712f4964d2c48defc53af4c9a1ac695fc7f2582d` |
| `seed-158447.json` | `8bc5eb51659f9866a928c4038a2b4ce1251902748bdc16af461536fec420445d` |

## Observable result: #143911 deferred batch re-apply

| Scenario | Build | Producer apply | Batch re-apply | Requeue | Close writes |
| --- | --- | --- | --- | --- | --- |
| `batch-after-producer` | baseline | synced + `kept_open` | `skipped_changed_since_review: updated_at changed` | yes | 0 |
| `batch-after-producer` | candidate | synced + `kept_open` | `review_comment_synced` (metadata only, no PATCH) + `kept_open` | no | 0 |
| `batch-human-comment` | both | synced + `kept_open` | `skipped_changed_since_review: updated_at changed` | yes | 0 |
| `batch-new-head` | both | synced + `kept_open` | `skipped_changed_since_review: live PR head ... differs` | yes | 0 |
| `batch-title-edit` | both | synced + `kept_open` | `skipped_changed_since_review: updated_at changed` | yes | 0 |

The producer reproduces production's apply exactly: `review_comment_synced` plus
`kept_open: implemented-on-main close no longer has current GitHub
issue-to-fixing-pull-request provenance`, with GitHub effects `PATCH` durable comment
5616705068 and `DELETE` review lease 5904434723. Its event-apply disposition is `applied`
with no requeue, so the direct-publication planner accepts that shape.

The candidate batch re-apply's only GitHub effects are its own apply-lease create and
release, identical to the baseline batch; it makes no durable-comment PATCH, label edit,
or close request.

## Observable result: #1715 regression rerun

Baseline and candidate are identical in every scenario and match the outcomes #1715
recorded for its branch:

| Record | Scenario | Apply | Requeue | GitHub effects | Close writes |
| --- | --- | --- | --- | --- | --- |
| #126549 recorded | ack-only | synced + `kept_open` (paired closeout) | no | durable `PATCH`, lease `DELETE` | 0 |
| #126549 close-capable | ack-only | synced + `closed` (stalled unproven PR) | no | durable `PATCH`, closeout note `POST`, close, lease `DELETE` | 1 |
| #158447 recorded | ack-only | synced + `kept_open` (paired closeout) | no | `removeLabelsFromLabelable`, durable `PATCH`, lease `DELETE` | 0 |
| all three | human-comment | `skipped_changed_since_review: updated_at changed` | yes | lease `DELETE` only | 0 |
| all three | new-head | `skipped_changed_since_review: live PR head ... differs` | yes | none | 0 |
| all three | title-edit | `skipped_changed_since_review: updated_at changed` | yes | lease `DELETE` only | 0 |

One expected difference from #1715's recording: #1715 seeded a lease marker the apply
could not adopt, so each apply posted and deleted its own lease. This harness keeps the
seeded review lease live, so the apply adopts it and only deletes it, as the production
exact-review publisher does.

## Artifacts

- `receipt.json`: the three run summaries with seed SHA-256s and the local command path
  replaced by placeholders (SHA-256
  `e3c18c8d45dd9fef2321db8fd4bc38ff76c41493c22115f68dce6ae4ebc05f53`; raw summaries
  143911 `6e9ac39a7aff481238bb7b43c928130d0333df0c62e171991bfbdadc802ea15d`, 126549
  `c8fbeb91ee3c1ed7d5d5381255cdb289c8c4ea80038a8e346802d82511270350`, 158447
  `a1428aee6559420aeda658faa78e1e33dfa3827d4a6b2848b7a44b4ce743be02`).
- `traces/batch-after-producer-{baseline,candidate}.http-trace.jsonl`: every request of
  the headline #143911 scenario (SHA-256 `e9ff466d2db609c70fef2f5e5e80f108467ef2a8bd5b6fd3b7b4b828dce5d6ef`
  and `77602a8625c406493f763705e2c28fe81883f26859d502b0a2a8a83342bf0376`).
- #143911 control traces (not committed): human comment
  `26c8ae027b15fe1d7758342ec1bdd58de11df0d70920ccc30045fdb31ec943d3`, new head
  `28a0ea724f18058eff24a9a45dad3368d5ddd9f56c42b6df47d72fb7c2e6c405`, title edit
  `495219ad3543de519e4fa80aa0e103c31d234b020b3d9f00d228d4e06467ede3`, each identical on
  both builds.

## Limits

- The GitHub API is synthetic. It models `updated_at` and timeline effects of comment,
  label, title, push, and close writes; it does not model GitHub mention/subscription
  events, reactions, or the hosted rate limiter.
- The producer's direct publication POST and the batch publisher's queue claim and commit
  are not exercised here; the batch phase replays the batch publisher's apply step only.
- The released-lease receipt cannot see a comment deletion's time. It bounds the deletion
  to five minutes after the review generation's last recorded ClawSweeper write and
  relies on the complete activity receipt plus the no-non-automation-activity check for
  everything else.
- Review records are reconstructed from durable markers and run logs, as in #1715; the
  close-capable #126549 close reason is synthetic.

OpenClaw Bay is unaffected: no queue, status, telemetry, or dashboard data contract
changes.
