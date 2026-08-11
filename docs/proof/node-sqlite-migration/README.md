# Node SQLite migration proof

## Claim

The five gitcrawl SQLite query subprocesses now use Node 24's synchronous
`node:sqlite` API in read-only mode without changing their parsed row, scalar,
empty-result, or caller-level error contracts. The cluster-intake workflow no
longer installs the obsolete `sqlite3` executable.

## Host equivalence

`run-proof.mjs` creates a real portable gitcrawl database with committed rows
still resident in its WAL sidecar. It extracts the three old source files from
`origin/main`, verifies their five old `sqlite3` invocations, and executes the
same scalar and JSON queries through the host `sqlite3` CLI and the new
`node:sqlite` helper. Their parsed JSON bytes and scalar text must be identical.

Run after `pnpm run build:all`:

```sh
node docs/proof/node-sqlite-migration/run-proof.mjs
```

The machine-readable result is `equivalence.json`.

## Contract decisions

JSON query rows intentionally remain ordinary JavaScript objects containing
numbers. Statements read SQLite integers as BigInts and explicitly normalize
them with `Number()`, matching the old `sqlite3 -json` plus `JSON.parse` path,
including its precision loss above `Number.MAX_SAFE_INTEGER`. Scalar queries
retain exact decimal text; their existing callers continue to apply `Number()`.

Every query opens `DatabaseSync(dbPath, { readOnly: true })`, so committed WAL
rows remain visible while a missing database is no longer created as a side
effect. Related-context still catches query failures: a missing configured path
returns `[]`/`false` before a query, and a corrupt store returns `[]`/`null`.
Both importer entry points still fail nonzero for missing or corrupt stores.

## Container and gates

The seven local gates passed on Node 24.19.0 and pnpm 11.10.0:

1. Host old/new equivalence proof: three scalar and three JSON query cases,
   including missing/corrupt error evidence.
2. Focused real-database fixtures: 6 passed, 0 failed.
3. `pnpm run build:all`: all three TypeScript projects passed.
4. `pnpm run test:no-build`: 3,333 tests; 3,324 passed, 9 skipped, 0 failed.
5. `pnpm run lint`: all four lint lanes passed.
6. `pnpm run format:check`: 663 files passed.
7. `pnpm run check:static`: active-surface, dashboard boundary, docs, limits,
   and format checks passed.

The committed `container-proof.sh` requires a fresh PR checkout whose image has
no `sqlite3` binary. It installs the repository's pinned pnpm through Corepack,
downloads jq 1.8.1, verifies the selected jq binary against the official
published checksum, runs the focused real-database fixtures through only the
new path, and then runs the full `pnpm check` gate.

Container provenance and secret-scanned stdout are committed alongside this
proof after the required `--fresh-pr` run.

## Limits and Bay impact

Fixtures are disposable local files; no proof command contacts Gitcrawl,
GitHub APIs, Worker storage, or another production service. The host needs
`sqlite3` only for old-path equivalence. The container intentionally cannot run
the old path because the binary is absent.

OpenClaw Bay is unaffected. This changes local read-only store access and one
workflow bootstrap step, not lifecycle publication, queue control, status
telemetry, dashboard data, or Bay's observer-only boundary.
