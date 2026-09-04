# State storage

ClawSweeper has three explicit state owners. The Cloudflare Worker is canonical
for review records, R2 is canonical for immutable action ledgers and published
assets, and the `state` branch of `openclaw/clawsweeper-state` retains only the
operational paths that have not migrated yet.

Record paths use the repository profile's lowercase slug: the owner/repository
separator becomes a hyphen, while dots, underscores, and existing hyphens remain
literal. For example, `OpenClaw/Some.Repo_Debug` uses
`records/openclaw-some.repo_debug/`. Apply selection and cursor reads use the same
slug as record publication and hydration; existing records need no migration.

Report readers share one anchored leading-front-matter parser. A unique header
value remains authoritative when report prose or a valid fenced example quotes
the same key. Duplicate header keys and competing unfenced metadata blocks
(including fragments left by an injected terminator) make the affected fields
ambiguous. A missing header field with a body lookalike stays ambiguous rather
than enabling legacy close-promotion fallback. Indented nested data cannot
override top-level fields. Decision packets reject document-wide structural
ambiguity, including duplicate header keys, and remove stale packets using the
real report path. Unrelated body-only keys do not create packet ambiguity.
The advisory metadata-spoofing inventory remains deliberately
broader than runtime authorization. No Bay schema or UI change is needed: the
record shape and observer-only projection are unchanged.

| Logical paths                                                                         | Canonical owner                               | Git state status                   |
| ------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------- |
| `records/**`                                                                          | Durable Object record store with R2 snapshots | Never checked out or written       |
| fanout and placeholder-recovery cursors per mode                                      | ExactReviewQueue Durable Object KV            | Never checked out or written       |
| exact re-review command intakes, version watermarks, receipts, and per-item revisions | ExactReviewQueue Durable Object SQLite        | Never checked out or written       |
| bounded GitHub ETag, JSON body, digest, and validation timestamp entries              | ExactReviewQueue Durable Object SQLite        | Never checked out or written       |
| `ledger/v1/**`                                                                        | R2 immutable blobs                            | Never checked out or written       |
| `assets/**`                                                                           | R2 mutable blobs                              | Never checked out or written       |
| `artifacts/exact-review/v1/<sha256>`                                                  | R2 immutable cache blobs                      | Never checked out or written       |
| `jobs/**`                                                                             | `clawsweeper-state` `state` branch            | Retained until its own migration   |
| `results/**`                                                                          | `clawsweeper-state` `state` branch            | Retained until its own migration   |
| `notifications/**`                                                                    | `clawsweeper-state` `state` branch            | Retained until its own migration   |
| `apply-report.json`, `repair-apply-report.json`                                       | `clawsweeper-state` `state` branch            | Retained until their own migration |

`setup-state` hydrates records from the Worker and, when requested, ledger/assets
from R2. Exact and batch review publishers pass the reviewed item numbers to
read only their open/closed reports, plans, and decision packets. Those focused
reads do not depend on repository-wide snapshots or journal exports.
Jobs that need operational Git state receive a sparse checkout containing only
the retained paths above. Canonical-only lanes set `hydrate-git-state: "false"`
and never mint or use a state-repository token.

State-blob publication gives each signed Worker request, including multipart
operations, a 15-second deadline. Requests retain their existing retry policy
of at most four attempts, so a stalled upload eventually fails and releases the
review worker.

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

Direct publication saves its lifecycle plan and receipt outcome on the claimed
lease decision. Completion and terminal-run reconciliation use that saved
authority for source-drift requeues, even if ingress has replaced the current
decision. Recovery preserves the old target, fence, and revision's terminal
fact; it does not manufacture router, acknowledgement, or review-result receipts.
OpenClaw Bay needs no schema or UI change: its existing observer-only projection
shows the requeue disposition without inventing review success or failure.

Exact-review publication retries use R2 only as a cache in front of GitHub
Artifacts. After a GitHub download passes the normal bundle validator, the
publisher stores a deterministic byte-preserving archive at
`artifacts/exact-review/v1/<sha256>` and records a queue receipt binding that
digest to producer run id/attempt, artifact name, canonical item key, lease
revision, and protocol version. Reuse requires an exact tuple match and a
verified object digest; every miss or mismatch falls back to GitHub. Receipts
expire after 30 days, and cache traffic incrementally prunes expired receipts
plus old unreferenced R2 objects (including upload orphans) in bounded batches.

GitHub conditional-read entries stay in queue SQLite rather than runner-local
files because publication runners are ephemeral. They share the 30-day receipt
retention convention, cap the store at 2,048 entries and each JSON body at 512
KiB, and evict least-recently validated entries when full. The durable body is
returned only by the post-304 confirmation operation; a lookup alone returns
only its ETag and digest.

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
