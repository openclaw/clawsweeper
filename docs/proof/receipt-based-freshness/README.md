# Receipt-based apply freshness proof

- Status: historical proof artifact
- Owner: ClawSweeper publication maintainers
- Baseline: `openclaw/clawsweeper@cac974b3e1da900cac3e7480b91d02a36ca60163` (origin/main)
- Candidate: `openclaw/clawsweeper@606ffe5e656af256f7bcd1367599571521c6da79` (clean committed head)
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
still blocks and requeues on both builds with zero close writes.

## Exercised surface and scenario

`scripts/e2e/apply-source-drift-final-effect.mjs` drives the compiled non-dry-run
`apply-decisions` CLI with the exact-event publication arguments of
`src/repair/publish-event-result.ts`, and ClawSweeper's own `update-review-status`
acknowledgement edits, through native `gh` (`http_unix_socket`) against a stateful
synthetic GitHub API. The API is seeded from read-only captures of openclaw/openclaw#143911
(PR, comments, timeline, files, commits, checks, review-activity GraphQL, fixing PR
#143903 and issue #143821) and rewound to the revision-46 review snapshot: review lease
5904434723 owned by `github-run-36671559049-1`, the acknowledgement and durable comments
at their pre-review state, and the durable comment's markers rewound to revision 45.

Each `batch-*` scenario runs, per build:

1. acknowledgement `reviewing`, review snapshot, report, acknowledgement `complete`;
2. the producer apply (phase `apply`);
3. an optional external change (`batch-human-comment`, `batch-new-head`,
   `batch-title-edit`);
4. the batch publisher re-apply of the same pre-apply review artifact (phase `batch`).

## Command and environment

```bash
node scripts/e2e/apply-source-drift-final-effect.mjs capture --item 143911 --out <seed-dir> --gh "$(command -v gh)"
node scripts/e2e/apply-source-drift-final-effect.mjs run --item 143911 \
  --seed-dir <seed-dir> --baseline <origin/main checkout> --candidate <branch checkout> \
  --out <evidence-dir>
```

Node v24.21.0, gh 2.101.0 against the synthetic API, macOS, both checkouts built with
`pnpm run build:all`. Seed `seed-143911.json` SHA-256
`e168af53e2c1d2646b6e2d497dca43e88c9e3fedcd4f95d4f022e4c66fcf3438` (captured
2026-10-01, not committed: it is a full public PR capture).

## Observable result

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

## Artifacts

- `receipt.json`: the run summary with the local command path replaced by placeholders
  (SHA-256 `862bace415d55b58b61d14249c4d2beafe952f4a261d1e66e0b1b02e2ef9e62d`; the raw
  summary was `7b56e2ebe9483dbae3c89ad33783c38ee78a9c16a6210b9cef5defcfd10189f7`).
- `traces/batch-after-producer-{baseline,candidate}.http-trace.jsonl`: every request of
  the headline scenario (SHA-256 `e9ff466d2db609c70fef2f5e5e80f108467ef2a8bd5b6fd3b7b4b828dce5d6ef`
  and `77602a8625c406493f763705e2c28fe81883f26859d502b0a2a8a83342bf0376`).
- Control traces (not committed): human comment
  `26c8ae027b15fe1d7758342ec1bdd58de11df0d70920ccc30045fdb31ec943d3` (identical on both
  builds), new head `28a0ea724f18058eff24a9a45dad3368d5ddd9f56c42b6df47d72fb7c2e6c405`
  (identical on both builds), title edit baseline
  `222b63e67fac6cdcca9d7194a96497ac6215c4e975f9da89f424aa6884dd5ec0` and candidate
  `495219ad3543de519e4fa80aa0e103c31d234b020b3d9f00d228d4e06467ede3` (they differ only
  by a trailing harness phase-control entry).

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
- The harness change that keeps the seeded review lease's marker window live also applies
  to the #1715 items (126549, 158447); their scenarios were not re-run here.
- The trace file can miss the last harness phase-control entry because the server appends
  it after responding.

OpenClaw Bay is unaffected: no queue, status, telemetry, or dashboard data contract
changes.
