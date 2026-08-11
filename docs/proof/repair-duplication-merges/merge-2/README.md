# Gitcrawl store resolver equivalence proof

This proof creates isolated repository/home layouts containing actual SQLite
databases. It covers a sibling portable store, portable-store absence with a
legacy fallback, and an environment override that wins over both competing
files. Both resolver copies extracted from `origin/main` and the shared current
resolver inspect those same files through real `fs.existsSync` calls and must
return identical paths.

For every layout, the proof also runs both built production entry points:
`dist/repair/import-gitcrawl-clusters.js` and
`dist/repair/import-gitcrawl-low-signal-prs.js`. They query the selected file
through a proof-local `sqlite3`-compatible CLI backed by Node's real
`node:sqlite` engine. Its trace captures the database path each importer opened,
and marker rows in each database prove that competing files were not read.

Run after `pnpm run build:repair`:

```sh
node docs/proof/repair-duplication-merges/merge-2/run-proof.mjs
```

The checked-in result is in `artifacts/equivalence.json`. The harness also
records that the callers retain their intentionally different `sqliteJson`
buffer limits. All fixtures are disposable local files; the proof performs no
network, GitHub, or production mutation.
