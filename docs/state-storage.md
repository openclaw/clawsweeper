# State storage

ClawSweeper has three explicit state owners. The Cloudflare Worker is canonical
for review records, R2 is canonical for immutable action ledgers and published
assets, and the `state` branch of `openclaw/clawsweeper-state` retains only the
operational paths that have not migrated yet.

| Logical paths | Canonical owner | Git state status |
| --- | --- | --- |
| `records/**` | Durable Object record store with R2 snapshots | Never checked out or written |
| `ledger/v1/**` | R2 immutable blobs | Never checked out or written |
| `assets/**` | R2 mutable blobs | Never checked out or written |
| `jobs/**` | `clawsweeper-state` `state` branch | Retained until its own migration |
| `results/**` | `clawsweeper-state` `state` branch | Retained until its own migration |
| `notifications/**` | `clawsweeper-state` `state` branch | Retained until its own migration |
| `apply-report.json`, `repair-apply-report.json` | `clawsweeper-state` `state` branch | Retained until their own migration |

`setup-state` always hydrates records from the Worker and ledger/assets from R2.
Jobs that need operational Git state receive a sparse checkout containing only
the retained paths above. Canonical-only lanes set `hydrate-git-state: "false"`
and never mint or use a state-repository token.

Remaining Git writers use the Durable Object state-writer coordinator and one
ordinary fetch/commit/push. The former Git lease refs, atomic multi-ref pushes,
shallow-history deepening, remote-head rebuilds, record reconciliation, and
immutable-ledger scratch branches no longer exist.

The former state materializer is retained only as a bounded append-window
compactor. It drains and acknowledges legacy projection rows so the Durable
Object's receipt and capacity windows remain bounded; it does not check out,
read, write, commit, or push Git state. New canonical record and action-ledger
writes do not enqueue projection rows.

Cluster intake is the one ownership transfer required by that decision. Its
workflow directly publishes the still-git `jobs/` and `results/` paths under the
state-writer coordinator, persists the dispatch claim before the Actions side
effect, and runs the same pending-claim recovery before accepting new work.

The repository is intentionally not archived or frozen by this migration.
Archival is a separate operator action after the remaining Git-backed paths have
their own canonical owners and the cutover has remained stable.
