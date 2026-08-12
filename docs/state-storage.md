# State storage

ClawSweeper has three explicit state owners. The Cloudflare Worker is canonical
for review records, R2 is canonical for immutable action ledgers and published
assets, and the `state` branch of `openclaw/clawsweeper-state` retains only the
operational paths that have not migrated yet.

| Logical paths                                                                         | Canonical owner                               | Git state status                   |
| ------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------- |
| `records/**`                                                                          | Durable Object record store with R2 snapshots | Never checked out or written       |
| fanout and placeholder-recovery cursors per mode                                      | ExactReviewQueue Durable Object KV            | Never checked out or written       |
| exact re-review command intakes, version watermarks, receipts, and per-item revisions | ExactReviewQueue Durable Object SQLite        | Never checked out or written       |
| `ledger/v1/**`                                                                        | R2 immutable blobs                            | Never checked out or written       |
| `assets/**`                                                                           | R2 mutable blobs                              | Never checked out or written       |
| `jobs/**`                                                                             | `clawsweeper-state` `state` branch            | Retained until its own migration   |
| `results/**`                                                                          | `clawsweeper-state` `state` branch            | Retained until its own migration   |
| `notifications/**`                                                                    | `clawsweeper-state` `state` branch            | Retained until its own migration   |
| `apply-report.json`, `repair-apply-report.json`                                       | `clawsweeper-state` `state` branch            | Retained until their own migration |

`setup-state` always hydrates records from the Worker and ledger/assets from R2.
Jobs that need operational Git state receive a sparse checkout containing only
the retained paths above. Canonical-only lanes set `hydrate-git-state: "false"`
and never mint or use a state-repository token.

Remaining Git writers use the Durable Object state-writer coordinator and one
ordinary fetch/commit/push. The former Git lease refs, atomic multi-ref pushes,
shallow-history deepening, remote-head rebuilds, record reconciliation, and
immutable-ledger scratch branches no longer exist.

Target fanout and bounded placeholder recovery read and update
`/internal/state/cursors/<mode>` with the same HMAC authentication as canonical
record operations. Each record carries a monotonic revision so concurrent
writers cannot silently overwrite one another. Cursor reads and writes are
fail-open: an unavailable store emits a prominent warning, but productive work
continues and remains safe to retry.

Eligible `@clawsweeper re-review` comment versions cross the durable boundary
before acknowledgement or Actions dispatch. The queue keeps one immutable
identity per comment id, update timestamp, and body digest; a newer edit
supersedes older pending work, while retries reuse the same receipt. Detailed
terminal receipts use the same 30-day horizon as resolved dead letters, and the
per-comment watermark remains after receipt compaction.

Git-backed reports, dashboard status, and post-dispatch cursors are best-effort
after their productive side effect or canonical publication succeeds. Git
publication remains mandatory where it is still the durability fence before a
dispatch, notably `jobs/**` intake and comment-router claims, and in the
dedicated cluster-result publisher whose failure must stay visible for retry.

The state materializer and its append-window projection are fully retired. All
producers were removed in the canonical-record cutover, the drain workflow was
deleted after a week of zero-row runs, and the Durable Object drops the legacy
`state_append_*` tables on upgrade. Canonical record and action-ledger writes go
directly to the Worker and R2.

Cluster intake is the one ownership transfer required by that decision. Its
workflow directly publishes the still-git `jobs/` and `results/` paths under the
state-writer coordinator, persists the dispatch claim before the Actions side
effect, and runs the same pending-claim recovery before accepting new work.

The repository is intentionally not archived or frozen by this migration.
Archival is a separate operator action after the remaining Git-backed paths have
their own canonical owners and the cutover has remained stable.
